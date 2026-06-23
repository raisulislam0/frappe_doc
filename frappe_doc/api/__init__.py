"""Shared helpers for the Frappe Doc developer portal API.

All Frappe v15/v16 differences are isolated here so the rest of the
codebase (and the frontend) can stay version agnostic.
"""

import os

import frappe


def get_frappe_version():
	"""Return the installed Frappe major version as an int (defaults to 15)."""
	try:
		return int(frappe.__version__.split(".")[0])
	except Exception:
		return 15


def get_bench_path():
	"""Return the bench root path.

	``frappe.utils.get_bench_path`` exists in v15 but moved in v16, so try the
	v15 import first and otherwise resolve relative to the frappe package dir
	(``.../apps/frappe/frappe`` -> bench root is two directories up from there).
	"""
	try:
		from frappe.utils import get_bench_path as _v15_get_bench_path

		return _v15_get_bench_path()
	except Exception:
		return os.path.abspath(os.path.join(os.path.dirname(frappe.__file__), "..", ".."))


def _cache():
	"""Return the cache object on both v15 (callable) and v16 (attribute)."""
	c = frappe.cache
	return c() if callable(c) else c


def cache_get(key):
	try:
		return _cache().get_value(key)
	except Exception:
		return None


def cache_set(key, value, ttl=3600):
	try:
		_cache().set_value(key, value, expires_in_sec=ttl)
	except TypeError:
		try:
			_cache().set_value(key, value)
		except Exception:
			pass
	except Exception:
		pass


def cache_delete(key):
	try:
		_cache().delete_value(key)
	except Exception:
		pass
