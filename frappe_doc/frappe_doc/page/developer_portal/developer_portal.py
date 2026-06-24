import frappe
from frappe import _


def get_context(context):
	if not frappe.conf.developer_mode and "System Manager" not in frappe.get_roles():
		raise frappe.PermissionError(_("Only System Managers can access the Developer Portal."))
	return context
