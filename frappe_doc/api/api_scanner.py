"""Whitelisted endpoints that discover @frappe.whitelist() functions.

Discovery is done purely with the ``ast`` module: scanned files are never
imported or executed.
"""

import ast
import os
import re

import frappe

from . import cache_delete, cache_get, cache_set

CACHE_KEY = "frappe_doc:whitelisted_apis:v2"
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


@frappe.whitelist()
def get_whitelisted_apis():
	"""Return the scan result, using the cached copy when available."""
	cached = cache_get(CACHE_KEY)
	if cached is not None:
		return cached

	result = _scan_all_apps()
	cache_set(CACHE_KEY, result, CACHE_TTL)
	return result


@frappe.whitelist()
def clear_api_cache():
	"""Invalidate the cached scan result."""
	cache_delete(CACHE_KEY)
	return {"cleared": True}


@frappe.whitelist()
def force_rescan():
	"""Clear the cache, rescan immediately and return fresh results."""
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
		results.append(
			{
				"function": node.name,
				"module_path": dotted,
				"route": "/api/method/" + dotted,
				"args": _arg_names(node),
				"docstring": ast.get_docstring(node),
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
