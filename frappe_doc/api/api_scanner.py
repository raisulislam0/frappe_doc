"""Whitelisted endpoints that discover @frappe.whitelist() functions.

Discovery is done purely with the ``ast`` module: scanned files are never
imported or executed.
"""

import ast
import json
import os
import re
import textwrap

import frappe

from . import cache_delete, cache_get, cache_set

CACHE_KEY = "frappe_doc:whitelisted_apis:v3"
CACHE_TTL = 3600
_SKIP_DIRS = {"__pycache__", "node_modules", "dist"}

# Function-name based HTTP method inference. Order matters: first match wins.
_METHOD_RULES = [
	(
		re.compile(
			r"^(get|fetch|find|search|list|read|retrieve|load|lookup|check|exists|"
			r"count|filter|query|show|view)(_|\b)",
			re.IGNORECASE,
		),
		["GET"],
		"inferred",
	),
	(
		re.compile(
			r"^(create|make|add|insert|new|post|submit|save|set|put|send|generate|"
			r"build|initiate|trigger|start|run|execute|process|sync|attach|upload|"
			r"assign|link|apply|enable|activate)(_|\b)",
			re.IGNORECASE,
		),
		["POST"],
		"inferred",
	),
	(
		re.compile(
			r"^(delete|remove|cancel|reject|discard|deactivate|disable|purge|clear|"
			r"reset|revert|undo|revoke)(_|\b)",
			re.IGNORECASE,
		),
		["POST"],
		"inferred-delete",
	),
	(
		re.compile(
			r"^(update|edit|modify|change|patch|correct|fix|adjust|amend|revise|"
			r"rename|move|merge|replace)(_|\b)",
			re.IGNORECASE,
		),
		["POST"],
		"inferred-update",
	),
]

# ---------------------------------------------------------------------------
# Docstring section header detection
# Matches Google-style ("Args:", "Returns:") and informal variants.
# ---------------------------------------------------------------------------
_SECTION_RE = re.compile(
	r"^(?P<name>Args|Arguments|Parameters|Params|Returns|Return|Raises|"
	r"Example Request|Example Response|Example|Examples|Notes?|See Also)\s*:\s*$",
	re.IGNORECASE,
)

# Recognises a JSON-fenced block inside a docstring section body.
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)


def check_permission():
	if not frappe.conf.developer_mode and "System Manager" not in frappe.get_roles():
		frappe.throw(frappe._("Only System Managers can access this API."), frappe.PermissionError)


@frappe.whitelist()
def get_whitelisted_apis():
	"""Return the scan result, using the cached copy when available."""
	check_permission()
	cached = cache_get(CACHE_KEY)
	if cached is not None:
		return cached

	result = _scan_all_apps()
	cache_set(CACHE_KEY, result, CACHE_TTL)
	return result


@frappe.whitelist()
def clear_api_cache():
	"""Invalidate the cached scan result."""
	check_permission()
	cache_delete(CACHE_KEY)
	return {"cleared": True}


@frappe.whitelist()
def force_rescan():
	"""Clear the cache, rescan immediately and return fresh results."""
	check_permission()
	cache_delete(CACHE_KEY)
	result = _scan_all_apps()
	cache_set(CACHE_KEY, result, CACHE_TTL)
	return result


def _scan_all_apps():
	doctypes = frappe.get_all("DocType", pluck="name")
	known_doctypes = set(doctypes)
	doctype_by_scrub = {frappe.scrub(name): name for name in doctypes}

	apis = []
	for app in frappe.get_installed_apps():
		try:
			app_path = frappe.get_app_path(app)
		except Exception:
			continue

		for root, dirs, files in os.walk(app_path):
			dirs[:] = [d for d in dirs if not d.startswith(".") and d not in _SKIP_DIRS]
			for fname in files:
				if fname.endswith(".py"):
					apis.extend(
						_scan_file(
							app,
							app_path,
							os.path.join(root, fname),
							known_doctypes,
							doctype_by_scrub,
						)
					)

	apis.sort(key=lambda a: a["route"])
	return {"apis": apis, "count": len(apis), "generated_at": frappe.utils.now()}


def _scan_file(app, app_path, fpath, known_doctypes, doctype_by_scrub):
	try:
		with open(fpath, encoding="utf-8") as f:
			tree = ast.parse(f.read())
	except (SyntaxError, ValueError, UnicodeDecodeError, OSError):
		return []

	rel = os.path.relpath(fpath, app_path)
	module_path = app + "." + rel[:-3].replace(os.sep, ".")
	path_doctype = _doctype_from_path(rel, doctype_by_scrub)

	results = []
	for node in ast.walk(tree):
		if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
			continue

		info = _whitelist_info(node)
		if info is None:
			continue

		dotted = f"{module_path}.{node.name}"
		methods, confidence = _resolve_methods(node.name, info.get("methods"))
		raw_docstring = ast.get_docstring(node)
		parsed_doc = _parse_docstring(raw_docstring) if raw_docstring else {}

		if "args" not in parsed_doc:
			parsed_doc["args"] = []
		if "returns" not in parsed_doc:
			parsed_doc["returns"] = ""

		parsed_args_by_name = {arg["name"]: arg for arg in parsed_doc["args"]}

		# Merge Python signature type hints
		sig_args = []
		if hasattr(node.args, "posonlyargs"):
			sig_args.extend(node.args.posonlyargs)
		sig_args.extend(node.args.args)
		if hasattr(node.args, "kwonlyargs"):
			sig_args.extend(node.args.kwonlyargs)

		for arg in sig_args:
			if arg.arg == "self":
				continue
			type_hint = ""
			if arg.annotation:
				try:
					type_hint = ast.unparse(arg.annotation).strip()
				except Exception:
					pass
			if type_hint:
				if arg.arg in parsed_args_by_name:
					if not parsed_args_by_name[arg.arg].get("type"):
						parsed_args_by_name[arg.arg]["type"] = type_hint
				else:
					new_arg = {
						"name": arg.arg,
						"type": type_hint,
						"description": ""
					}
					parsed_doc["args"].append(new_arg)
					parsed_args_by_name[arg.arg] = new_arg

		# Merge return type hint
		if getattr(node, "returns", None):
			try:
				ret_type = ast.unparse(node.returns).strip()
				if ret_type:
					if not parsed_doc["returns"]:
						parsed_doc["returns"] = ret_type
					else:
						existing_ret = parsed_doc["returns"]
						if not existing_ret.strip().startswith(ret_type):
							parsed_doc["returns"] = f"{ret_type}: {existing_ret}"
			except Exception:
				pass

		results.append(
			{
				"function": node.name,
				"module_path": dotted,
				"route": "/api/method/" + dotted,
				"args": _arg_names(node),
				"docstring": raw_docstring,
				"parsed_doc": parsed_doc,
				"allow_guest": info.get("allow_guest", False),
				"methods": methods,
				"method_confidence": confidence,
				"app": app,
				"file": rel,
				"line": node.lineno,
				"doctype": path_doctype or _doctype_from_body(node, known_doctypes),
			}
		)

	return results


# ---------------------------------------------------------------------------
# Docstring parser
# ---------------------------------------------------------------------------

def _parse_docstring(raw):
	"""Parse a Google-style docstring into structured sections.

	Returns a dict with keys:
	  summary          -- str: first non-empty line(s) of the docstring
	  description      -- str: prose paragraphs between summary and first section
	  args             -- list of {name, type, description} dicts
	  returns          -- str: text of the Returns section
	  example_request  -- str|None: JSON text found in Example Request section
	  example_response -- str|None: JSON text found in Example Response section
	"""
	if not raw:
		return {}

	# Normalise: dedent and split into lines
	lines = textwrap.dedent(raw).splitlines()

	# ------------------------------------------------------------------
	# 1. Collect sections as {name: [body_lines]}
	# ------------------------------------------------------------------
	sections = {}
	current_section = None
	preamble_lines = []

	for line in lines:
		m = _SECTION_RE.match(line.rstrip())
		if m:
			current_section = m.group("name").lower().replace(" ", "_")
			sections.setdefault(current_section, [])
		elif current_section is not None:
			sections[current_section].append(line)
		else:
			preamble_lines.append(line)

	# ------------------------------------------------------------------
	# 2. Split preamble into summary + description
	# ------------------------------------------------------------------
	summary_lines = []
	desc_lines = []
	in_summary = False
	past_summary = False
	for ln in preamble_lines:
		stripped = ln.strip()
		if not past_summary:
			if stripped:
				in_summary = True
				summary_lines.append(stripped)
			elif in_summary:
				past_summary = True
		else:
			desc_lines.append(ln)

	summary = " ".join(summary_lines).strip()
	description = "\n".join(desc_lines).strip()

	# ------------------------------------------------------------------
	# 3. Parse Args section  (Google style: "    name (type): description")
	# ------------------------------------------------------------------
	args_parsed = []
	args_lines = (
		sections.get("args")
		or sections.get("arguments")
		or sections.get("parameters")
		or sections.get("params")
		or []
	)
	arg_re = re.compile(r"^\s+(\w+)\s*(?:\(([^)]+)\))?\s*:\s*(.*)")
	current_arg = None
	for ln in args_lines:
		m = arg_re.match(ln)
		if m:
			current_arg = {
				"name": m.group(1),
				"type": (m.group(2) or "").strip(),
				"description": m.group(3).strip(),
			}
			args_parsed.append(current_arg)
		elif current_arg and ln.strip():
			current_arg["description"] += " " + ln.strip()

	# ------------------------------------------------------------------
	# 4. Returns
	# ------------------------------------------------------------------
	returns_lines = sections.get("returns") or sections.get("return") or []
	returns = "\n".join(returns_lines).strip()

	# ------------------------------------------------------------------
	# 5. Example Request / Response
	# ------------------------------------------------------------------
	def _extract_json_from_lines(body_lines):
		"""Extract JSON (or plain text) from a section's body lines."""
		body = "\n".join(body_lines)
		fence = _JSON_BLOCK_RE.search(body)
		if fence:
			text = fence.group(1).strip()
			try:
				json.loads(text)
				return text
			except Exception:
				return text

		body_stripped = body.strip()
		if body_stripped and body_stripped[0] in "{[":
			try:
				parsed = json.loads(body_stripped)
				return json.dumps(parsed, indent=2)
			except Exception:
				pass
		return body_stripped or None

	example_request = None
	example_response = None

	if "example_request" in sections:
		example_request = _extract_json_from_lines(sections["example_request"])
	if "example_response" in sections:
		example_response = _extract_json_from_lines(sections["example_response"])

	if not example_request and not example_response:
		example_lines = sections.get("example") or sections.get("examples") or []
		if example_lines:
			example_request = _extract_json_from_lines(example_lines)

	return {
		"summary": summary,
		"description": description,
		"args": args_parsed,
		"returns": returns,
		"example_request": example_request,
		"example_response": example_response,
	}


def _arg_names(node):
	args = node.args
	names = [a.arg for a in getattr(args, "posonlyargs", [])]
	names += [a.arg for a in args.args]
	names += [a.arg for a in args.kwonlyargs]
	return [n for n in names if n != "self"]


def _whitelist_info(node):
	"""Return decorator metadata if the function is whitelisted, else None.

	Handles ``@whitelist``, ``@frappe.whitelist``, ``@frappe.whitelist()`` and
	``@frappe.whitelist(allow_guest=True)`` (and bare-name equivalents).
	"""
	for dec in node.decorator_list:
		call = None
		target = dec
		if isinstance(dec, ast.Call):
			call = dec
			target = dec.func

		name = None
		if isinstance(target, ast.Attribute):
			name = target.attr
		elif isinstance(target, ast.Name):
			name = target.id

		if name != "whitelist":
			continue

		info = {}
		if call is not None:
			for kw in call.keywords:
				if kw.arg == "allow_guest":
					info["allow_guest"] = _literal_truth(kw.value)
				elif kw.arg == "methods":
					info["methods"] = _literal_list(kw.value)
		return info

	return None


def _resolve_methods(func_name, explicit):
	"""Return (methods, confidence) for an endpoint.

	``explicit`` is the list parsed from a ``methods=[...]`` decorator keyword
	(or ``None``). When absent, the HTTP method is inferred from the function
	name.
	"""
	if explicit:
		return explicit, "explicit"

	for pattern, methods, confidence in _METHOD_RULES:
		if pattern.match(func_name):
			return list(methods), confidence

	return ["POST"], "unknown"


def _literal_truth(value):
	try:
		return bool(ast.literal_eval(value))
	except Exception:
		return False


def _literal_list(value):
	"""Return an uppercased list of string method names, or None."""
	try:
		parsed = ast.literal_eval(value)
	except Exception:
		return None
	if isinstance(parsed, (list, tuple)):
		methods = [str(m).upper() for m in parsed if isinstance(m, str)]
		return methods or None
	return None


def _doctype_from_path(rel, doctype_by_scrub):
	"""PRIMARY detection: a ``/doctype/<name>/`` folder in the file path."""
	parts = rel.replace(os.sep, "/").split("/")
	if "doctype" in parts:
		idx = parts.index("doctype")
		if idx + 1 < len(parts):
			folder = parts[idx + 1]
			return doctype_by_scrub.get(folder) or folder.replace("_", " ").title()
	return None


def _doctype_from_body(node, known_doctypes):
	"""SECONDARY detection: a string literal matching a known DocType name."""
	for child in ast.walk(node):
		if isinstance(child, ast.Constant) and isinstance(child.value, str):
			if child.value in known_doctypes:
				return child.value
	return None
