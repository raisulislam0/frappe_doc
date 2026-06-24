"""Whitelisted endpoints that expose DocType metadata to the portal.

Everything is read through ``frappe.get_meta`` so Custom Fields and Property
Setters are reflected automatically.
"""

import frappe
from frappe import _

from .api_scanner import check_permission

_CHILD_TABLE_TYPES = ("Table", "Table MultiSelect")


@frappe.whitelist()
def get_all_doctypes():
	"""Return every DocType name with its module, sorted by name."""
	check_permission()
	return frappe.get_all(
		"DocType",
		fields=["name", "module"],
		order_by="name asc",
	)


@frappe.whitelist()
def get_doctype_schema(doctype):
	"""Return a recursive field tree for ``doctype``.

	Returns a clean ``{"error": ...}`` dict when the DocType does not exist
	instead of raising.
	"""
	check_permission()
	try:
		meta = frappe.get_meta(doctype)
	except Exception:
		return {"error": _("DocType {0} was not found.").format(doctype)}

	if not meta:
		return {"error": _("DocType {0} was not found.").format(doctype)}

	return {"doctype": doctype, "fields": _build_field_tree(doctype, set())}


def _build_field_tree(doctype, visited):
	"""Build the field list for ``doctype``.

	``visited`` holds the doctypes already expanded along the current branch so
	circular child-table references cannot trigger infinite recursion.
	"""
	try:
		meta = frappe.get_meta(doctype)
	except Exception:
		return []

	child_visited = visited | {doctype}
	fields = []
	for df in meta.fields:
		node = {
			"fieldname": df.fieldname,
			"label": df.label,
			"fieldtype": df.fieldtype,
			"options": df.options,
			"reqd": int(df.reqd or 0),
			"in_list_view": int(df.in_list_view or 0),
		}
		if df.fieldtype in _CHILD_TABLE_TYPES and df.options:
			if df.options in child_visited:
				node["children"] = []
			else:
				node["children"] = _build_field_tree(df.options, child_visited)
		fields.append(node)

	return fields
