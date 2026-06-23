frappe.pages["developer_portal"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Developer Portal",
		single_column: true,
	});

	const API_GET = "frappe_doc.api.api_scanner.get_whitelisted_apis";
	const API_RESCAN = "frappe_doc.api.api_scanner.force_rescan";
	const DT_LIST = "frappe_doc.api.doctype_schema.get_all_doctypes";
	const DT_SCHEMA = "frappe_doc.api.doctype_schema.get_doctype_schema";

	const state = {
		activeTab: "api",
		apis: null,
		doctypes: null,
		selectedDoctype: null,
		schemaCache: {},
		apiSearch: "",
		doctypeSearch: "",
		fieldSearch: "",
		collapsedGroups: {},
		inflight: {},
		_loadingEl: null,
		_apiTimer: null,
	};

	// ---- shell injection (template provides <style> + #dev-portal-root) ----
	const $container = page.main && page.main.length ? page.main : page.body;
	const tmpl =
		(frappe.templates && frappe.templates["developer_portal"]) ||
		'<div id="dev-portal-root"></div>';
	$container.html(tmpl);
	const root = $container.find("#dev-portal-root").get(0);
	root.innerHTML = "";

	// ---- small DOM helpers ----
	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}
	function esc(s) {
		s = s == null ? "" : String(s);
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}
	function hl(text, term) {
		const safe = esc(text);
		const t = (term || "").trim();
		if (!t) return safe;
		const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
		return safe.replace(re, "<mark>$1</mark>");
	}
	function badge(cls, text) {
		return el("span", cls, text);
	}
	function emptyMsg(t) {
		return el("div", "fd-empty", t);
	}
	function showError(container, msg) {
		container = container || ui.content;
		container.innerHTML = "";
		container.appendChild(el("div", "fd-error", msg));
	}
	function slug(s) {
		return String(s).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	}
	function cardId(api) {
		return "fd-api-" + slug(api.route);
	}

	// ---- skeleton ----
	const ui = {};
	const tabs = el("div", "fd-tabs");
	ui.tabApi = el("button", "fd-tab active", "API Explorer");
	ui.tabDt = el("button", "fd-tab", "DocType Fields");
	tabs.appendChild(ui.tabApi);
	tabs.appendChild(ui.tabDt);

	const body = el("div", "fd-body");
	const sidebar = el("aside", "fd-sidebar");
	ui.sideSearch = el("input", "fd-sidebar-search");
	ui.sideSearch.type = "text";
	ui.mobileSelect = el("select", "fd-mobile-select");
	ui.sideList = el("div", "fd-sidebar-list");
	sidebar.appendChild(ui.sideSearch);
	sidebar.appendChild(ui.mobileSelect);
	sidebar.appendChild(ui.sideList);

	ui.content = el("div", "fd-content");
	body.appendChild(sidebar);
	body.appendChild(ui.content);
	root.appendChild(tabs);
	root.appendChild(body);

	// ---- loading + de-duplicated calls ----
	function showLoading() {
		hideLoading();
		const ov = el("div", "fd-loading");
		ov.appendChild(el("div", "fd-spinner"));
		state._loadingEl = ov;
		ui.content.appendChild(ov);
	}
	function hideLoading() {
		if (state._loadingEl && state._loadingEl.parentNode) {
			state._loadingEl.parentNode.removeChild(state._loadingEl);
		}
		state._loadingEl = null;
	}
	function call(method, args, onOk, onErr) {
		const key = method + ":" + JSON.stringify(args || {});
		if (state.inflight[key]) return;
		state.inflight[key] = true;
		frappe.call({
			method: method,
			args: args || {},
			callback: function (r) {
				delete state.inflight[key];
				onOk(r.message);
			},
			error: function (r) {
				delete state.inflight[key];
				if (onErr) onErr(r);
			},
		});
	}

	// ---- hash state ----
	function updateHash() {
		let h = "tab=" + state.activeTab;
		if (state.activeTab === "doctype" && state.selectedDoctype) {
			h += "&doctype=" + encodeURIComponent(state.selectedDoctype);
		}
		if ("#" + h !== window.location.hash) {
			if (history.replaceState) history.replaceState(null, "", "#" + h);
			else window.location.hash = h;
		}
	}
	function readHash() {
		const out = { tab: "api", doctype: null };
		(window.location.hash || "").replace(/^#/, "").split("&").forEach(function (p) {
			const kv = p.split("=");
			if (kv[0] === "tab" && kv[1]) out.tab = kv[1];
			if (kv[0] === "doctype" && kv[1]) {
				out.doctype = decodeURIComponent(kv[1].replace(/\+/g, "%20"));
			}
		});
		return out;
	}

	// ---- tab switching ----
	function switchTab(tab) {
		state.activeTab = tab;
		ui.tabApi.classList.toggle("active", tab === "api");
		ui.tabDt.classList.toggle("active", tab === "doctype");
		ui.sideSearch.value = tab === "api" ? state.apiSearch : state.doctypeSearch;
		ui.sideSearch.placeholder = tab === "api" ? "Search APIs..." : "Search DocTypes...";
		updateHash();
		renderTab();
	}
	function renderTab() {
		if (state.activeTab === "api") renderApiTab();
		else renderDoctypeTab();
	}

	ui.tabApi.onclick = function () {
		switchTab("api");
	};
	ui.tabDt.onclick = function () {
		switchTab("doctype");
	};
	ui.sideSearch.oninput = function () {
		const v = this.value;
		if (state.activeTab === "api") {
			clearTimeout(state._apiTimer);
			state._apiTimer = setTimeout(function () {
				state.apiSearch = v;
				renderApiSidebar();
				renderApiResults();
			}, 300);
		} else {
			state.doctypeSearch = v;
			renderDoctypeSidebar();
		}
	};

	function copyText(t) {
		if (frappe.utils && frappe.utils.copy_to_clipboard) {
			frappe.utils.copy_to_clipboard(t);
		} else if (navigator.clipboard) {
			navigator.clipboard.writeText(t);
			frappe.show_alert({ message: __("Copied"), indicator: "green" });
		}
	}

	// ================= API EXPLORER =================
	function renderApiTab() {
		buildApiContent();
		if (state.apis === null) {
			fetchApis(function () {
				renderApiSidebar();
				renderApiResults();
			});
		} else {
			renderApiSidebar();
			renderApiResults();
		}
	}

	function buildApiContent() {
		ui.content.innerHTML = "";
		const toolbar = el("div", "fd-toolbar");
		const spacer = el("div");
		spacer.style.flex = "1 1 auto";
		const refresh = el("button", "fd-btn", "Refresh Cache");
		refresh.onclick = forceRescan;
		toolbar.appendChild(spacer);
		toolbar.appendChild(refresh);
		ui.content.appendChild(toolbar);
		state.apiResultsEl = el("div", "fd-results");
		ui.content.appendChild(state.apiResultsEl);
	}

	function fetchApis(cb) {
		showLoading();
		call(
			API_GET,
			{},
			function (msg) {
				hideLoading();
				state.apis = msg && msg.apis ? msg.apis : [];
				if (cb) cb();
			},
			function () {
				hideLoading();
				state.apis = [];
				ui.sideList.innerHTML = "";
				showError(state.apiResultsEl, "Failed to load whitelisted APIs.");
			}
		);
	}

	function forceRescan() {
		showLoading();
		call(
			API_RESCAN,
			{},
			function (msg) {
				hideLoading();
				state.apis = msg && msg.apis ? msg.apis : [];
				renderApiSidebar();
				renderApiResults();
			},
			function () {
				hideLoading();
				showError(state.apiResultsEl, "Cache refresh failed.");
			}
		);
	}

	function matchApi(api, t) {
		if (!t) return true;
		const hay = [
			api.route,
			api.function,
			(api.args || []).join(" "),
			api.docstring || "",
			api.doctype || "",
		]
			.join(" ")
			.toLowerCase();
		return hay.indexOf(t) !== -1;
	}
	function filteredApis() {
		const t = state.apiSearch.trim().toLowerCase();
		return (state.apis || []).filter(function (a) {
			return matchApi(a, t);
		});
	}

	function renderApiSidebar() {
		ui.sideList.innerHTML = "";
		ui.mobileSelect.innerHTML = "";
		if (state.apis === null) return;
		const term = state.apiSearch.trim();
		const apis = filteredApis();
		const groups = {};
		apis.forEach(function (a) {
			const key = a.doctype || "Uncategorized";
			(groups[key] = groups[key] || []).push(a);
		});
		const keys = Object.keys(groups).sort(function (x, y) {
			if (x === "Uncategorized") return 1;
			if (y === "Uncategorized") return -1;
			return x.localeCompare(y);
		});
		keys.forEach(function (key) {
			const g = el("div", "fd-group");
			if (state.collapsedGroups[key]) g.classList.add("collapsed");
			const head = el("div", "fd-group-header");
			const arrow = el("span", "fd-group-arrow", "\u25BE");
			const label = el("span");
			label.style.flex = "1 1 auto";
			label.innerHTML = hl(key, term) + " (" + groups[key].length + ")";
			head.appendChild(arrow);
			head.appendChild(label);
			head.onclick = function () {
				state.collapsedGroups[key] = !state.collapsedGroups[key];
				g.classList.toggle("collapsed");
			};
			const items = el("div", "fd-group-items");
			groups[key].forEach(function (a) {
				const it = el("div", "fd-side-item");
				it.innerHTML = hl(a.function, term);
				it.title = a.route;
				it.onclick = function () {
					scrollToCard(a);
				};
				items.appendChild(it);
			});
			g.appendChild(head);
			g.appendChild(items);
			ui.sideList.appendChild(g);

			const og = document.createElement("optgroup");
			og.label = key;
			groups[key].forEach(function (a) {
				const o = document.createElement("option");
				o.value = a.route;
				o.textContent = a.function;
				og.appendChild(o);
			});
			ui.mobileSelect.appendChild(og);
		});
		ui.mobileSelect.onchange = function () {
			const a = (state.apis || []).filter(
				(function (route) {
					return function (x) {
						return x.route === route;
					};
				})(this.value)
			)[0];
			if (a) scrollToCard(a);
		};
	}

	function scrollToCard(api) {
		const c = document.getElementById(cardId(api));
		if (c) c.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	function renderApiResults() {
		const c = state.apiResultsEl;
		c.innerHTML = "";
		const term = state.apiSearch.trim();
		const apis = filteredApis();
		if (!apis.length) {
			c.appendChild(
				emptyMsg(
					(state.apis || []).length
						? "No APIs match your search."
						: "No whitelisted APIs found."
				)
			);
			return;
		}
		apis.forEach(function (a) {
			c.appendChild(buildApiCard(a, term));
		});
	}

	const INFERRED_TIP =
		"Inferred from function name. Not explicitly declared on the decorator.";

	function methodColor(m) {
		if (m === "GET") return "fd-m-get";
		if (m === "POST") return "fd-m-post";
		if (m === "DELETE") return "fd-m-delete";
		if (m === "PUT") return "fd-m-put";
		return "fd-m-unknown";
	}

	function methodBadges(a) {
		const conf = a.method_confidence || "unknown";
		const methods = a.methods && a.methods.length ? a.methods : ["POST"];
		if (conf === "explicit") {
			return methods.map(function (m) {
				return { label: m, color: methodColor(m), dashed: false, tip: "" };
			});
		}
		if (conf === "inferred") {
			return methods.map(function (m) {
				return { label: "~" + m, color: methodColor(m), dashed: true, tip: INFERRED_TIP };
			});
		}
		if (conf === "inferred-delete") {
			return [
				{
					label: "~DELETE",
					color: methodColor("DELETE"),
					dashed: true,
					tip:
						"Inferred from function name. Frappe sends deletes as a POST body. Not explicitly declared on the decorator.",
				},
			];
		}
		if (conf === "inferred-update") {
			return [
				{
					label: "~PUT",
					color: methodColor("PUT"),
					dashed: true,
					tip:
						"Inferred from function name. Sent as a POST body. Not explicitly declared on the decorator.",
				},
			];
		}
		return [
			{
				label: "POST",
				color: "fd-m-unknown",
				dashed: true,
				tip:
					"No method declared. Defaulting to POST which works for all Frappe whitelisted endpoints.",
			},
		];
	}

	function buildApiCard(a, term) {
		const card = el("div", "fd-card");
		card.id = cardId(a);
		const head = el("div", "fd-card-head");
		const route = el("span", "fd-route");
		route.innerHTML = hl(a.route, term);
		const copy = el("button", "fd-copy", "Copy");
		copy.onclick = function () {
			copyText(a.route);
		};
		head.appendChild(route);
		head.appendChild(copy);
		methodBadges(a).forEach(function (m) {
			const b = el("span", "fd-badge fd-method " + m.color + (m.dashed ? " fd-dashed" : ""), m.label);
			if (m.tip) b.title = m.tip;
			head.appendChild(b);
		});
		if (a.allow_guest) head.appendChild(badge("fd-badge fd-badge-guest", "allow_guest"));
		if (a.doctype) {
			const db = el("span", "fd-badge fd-badge-doctype");
			db.innerHTML = hl(a.doctype, term);
			db.title = "Open in DocType Fields";
			db.onclick = function () {
				openDoctype(a.doctype);
			};
			head.appendChild(db);
		}
		card.appendChild(head);

		const meta = el("div", "fd-meta");
		meta.innerHTML = esc(a.app) + " &middot; " + esc(a.file) + ":" + esc(a.line);
		card.appendChild(meta);

		if (a.args && a.args.length) {
			const args = el("div", "fd-args");
			a.args.forEach(function (arg) {
				const s = el("span", "fd-arg");
				s.innerHTML = hl(arg, term);
				args.appendChild(s);
			});
			card.appendChild(args);
		}
		if (a.docstring) {
			const d = el("p", "fd-doc");
			d.innerHTML = hl(a.docstring, term);
			card.appendChild(d);
		}
		return card;
	}

	function openDoctype(name) {
		switchTab("doctype");
		selectDoctype(name);
	}
	function openApi(a) {
		switchTab("api");
		setTimeout(function () {
			scrollToCard(a);
		}, 60);
	}

	// ================= DOCTYPE FIELD EXPLORER =================
	function renderDoctypeTab() {
		buildDoctypeContent();
		if (state.doctypes === null) {
			fetchDoctypes(function () {
				renderDoctypeSidebar();
				renderDoctypeContent();
			});
		} else {
			renderDoctypeSidebar();
			renderDoctypeContent();
		}
	}

	function buildDoctypeContent() {
		ui.content.innerHTML = "";
		const toolbar = el("div", "fd-toolbar");
		const fs = el("input", "fd-content-search");
		fs.type = "text";
		fs.placeholder = "Search fields in this DocType...";
		fs.value = state.fieldSearch;
		fs.oninput = function () {
			state.fieldSearch = this.value;
			renderFieldArea();
		};
		state.fieldSearchInput = fs;
		toolbar.appendChild(fs);
		ui.content.appendChild(toolbar);
		state.statsEl = el("div");
		state.treeEl = el("div");
		state.relatedEl = el("div");
		ui.content.appendChild(state.statsEl);
		ui.content.appendChild(state.treeEl);
		ui.content.appendChild(state.relatedEl);
	}

	function fetchDoctypes(cb) {
		showLoading();
		call(
			DT_LIST,
			{},
			function (msg) {
				hideLoading();
				state.doctypes = msg || [];
				if (cb) cb();
			},
			function () {
				hideLoading();
				state.doctypes = [];
				showError(state.treeEl, "Failed to load the DocType list.");
			}
		);
	}

	function renderDoctypeSidebar() {
		ui.sideList.innerHTML = "";
		ui.mobileSelect.innerHTML = "";
		if (state.doctypes === null) return;
		const term = state.doctypeSearch.trim();
		const low = term.toLowerCase();
		const list = state.doctypes.filter(function (d) {
			return !low || d.name.toLowerCase().indexOf(low) !== -1;
		});
		list.forEach(function (d) {
			const it = el("div", "fd-side-item");
			if (d.name === state.selectedDoctype) it.classList.add("active");
			const nm = el("span");
			nm.innerHTML = hl(d.name, term);
			const sub = el("span", "fd-side-sub", d.module || "");
			it.appendChild(nm);
			it.appendChild(sub);
			it.onclick = function () {
				selectDoctype(d.name);
			};
			ui.sideList.appendChild(it);

			const o = document.createElement("option");
			o.value = d.name;
			o.textContent = d.name;
			if (d.name === state.selectedDoctype) o.selected = true;
			ui.mobileSelect.appendChild(o);
		});
		ui.mobileSelect.onchange = function () {
			selectDoctype(this.value);
		};
	}

	function selectDoctype(name) {
		state.selectedDoctype = name;
		updateHash();
		renderDoctypeSidebar();
		renderDoctypeContent();
	}

	function renderDoctypeContent() {
		if (!state.selectedDoctype) {
			state.statsEl.innerHTML = "";
			state.relatedEl.innerHTML = "";
			state.treeEl.innerHTML = "";
			state.treeEl.appendChild(
				emptyMsg("Select a DocType from the sidebar to view its fields.")
			);
			if (state.fieldSearchInput) state.fieldSearchInput.disabled = true;
			return;
		}
		if (state.fieldSearchInput) state.fieldSearchInput.disabled = false;

		if (state.schemaCache[state.selectedDoctype]) {
			renderFieldArea();
			renderRelated();
			return;
		}

		showLoading();
		call(
			DT_SCHEMA,
			{ doctype: state.selectedDoctype },
			function (msg) {
				hideLoading();
				if (msg && msg.error) {
					state.statsEl.innerHTML = "";
					state.relatedEl.innerHTML = "";
					showError(state.treeEl, msg.error);
					return;
				}
				state.schemaCache[state.selectedDoctype] = msg || { fields: [] };
				renderFieldArea();
				renderRelated();
			},
			function () {
				hideLoading();
				showError(
					state.treeEl,
					"Failed to load schema for " + state.selectedDoctype + "."
				);
			}
		);
	}

	function countStats(fields) {
		const s = { total: 0, tables: 0, reqd: 0 };
		(function walk(arr) {
			arr.forEach(function (f) {
				s.total++;
				if (f.reqd) s.reqd++;
				if (f.children !== undefined) {
					s.tables++;
					walk(f.children);
				}
			});
		})(fields);
		return s;
	}

	function flatten(fields, path, t, out) {
		fields.forEach(function (f) {
			const name = (f.fieldname || "").toLowerCase();
			const label = (f.label || "").toLowerCase();
			if (name.indexOf(t) !== -1 || label.indexOf(t) !== -1) {
				out.push({ field: f, path: path.concat([f.fieldname]) });
			}
			if (f.children) flatten(f.children, path.concat([f.fieldname]), t, out);
		});
	}

	function buildFieldRow(f, depth, term, hasToggle) {
		const row = el("div", "fd-field-row");
		row.style.paddingLeft = depth * 20 + "px";
		if (hasToggle) row.appendChild(el("button", "fd-toggle", "\u25BE"));
		const name = el("span", "fd-field-name");
		name.innerHTML = hl(f.fieldname, term);
		row.appendChild(name);
		if (f.label) {
			const lab = el("span", "fd-field-label");
			lab.innerHTML = "(" + hl(f.label, term) + ")";
			row.appendChild(lab);
		}
		let typeText = f.fieldtype || "";
		if (f.options && (f.fieldtype === "Link" || f.fieldtype.indexOf("Table") === 0)) {
			typeText += " \u2192 " + f.options;
		}
		row.appendChild(badge("fd-badge fd-badge-type", typeText));
		if (f.reqd) row.appendChild(badge("fd-badge fd-badge-reqd", "reqd"));
		if (f.in_list_view) row.appendChild(badge("fd-badge fd-badge-list", "in_list_view"));
		return row;
	}

	function renderNodes(fields, depth, container, term) {
		fields.forEach(function (f) {
			const hasChildren = f.children !== undefined;
			const node = el("div", "fd-node fd-depth-" + depth);
			const collapsed = hasChildren && depth + 1 >= 2;
			if (collapsed) node.classList.add("fd-collapsed");
			const row = buildFieldRow(f, depth, term, hasChildren);
			node.appendChild(row);
			if (hasChildren) {
				const group = el("div", "fd-child-group fd-children");
				if (f.children.length) renderNodes(f.children, depth + 1, group, term);
				else group.appendChild(emptyMsg("(no fields / circular reference)"));
				node.appendChild(group);
				const arrow = row.querySelector(".fd-toggle");
				if (arrow) {
					arrow.textContent = collapsed ? "\u25B8" : "\u25BE";
					arrow.onclick = function (e) {
						e.stopPropagation();
						node.classList.toggle("fd-collapsed");
						arrow.textContent = node.classList.contains("fd-collapsed")
							? "\u25B8"
							: "\u25BE";
					};
				}
			}
			container.appendChild(node);
		});
	}

	function renderFieldArea() {
		const schema = state.schemaCache[state.selectedDoctype];
		if (!schema) return;
		const fields = schema.fields || [];

		const st = countStats(fields);
		state.statsEl.className = "fd-stats";
		state.statsEl.innerHTML =
			"<span>Total fields: <b>" +
			st.total +
			"</b></span><span>Child tables: <b>" +
			st.tables +
			"</b></span><span>Required: <b>" +
			st.reqd +
			"</b></span>";

		state.treeEl.innerHTML = "";
		const term = state.fieldSearch.trim();
		if (term) {
			const flat = [];
			flatten(fields, [], term.toLowerCase(), flat);
			if (!flat.length) {
				state.treeEl.appendChild(emptyMsg("No fields match."));
				return;
			}
			flat.forEach(function (item) {
				const w = el("div");
				const bc = el("div", "fd-breadcrumb");
				bc.textContent = [state.selectedDoctype].concat(item.path).join(" \u203A ");
				w.appendChild(bc);
				w.appendChild(buildFieldRow(item.field, 0, term, false));
				state.treeEl.appendChild(w);
			});
		} else {
			renderNodes(fields, 0, state.treeEl, "");
		}
	}

	function renderRelated() {
		state.relatedEl.innerHTML = "";
		if (state.apis === null) {
			call(
				API_GET,
				{},
				function (msg) {
					state.apis = msg && msg.apis ? msg.apis : [];
					renderRelated();
				},
				function () {
					state.apis = [];
					renderRelated();
				}
			);
			return;
		}
		const related = state.apis.filter(function (a) {
			return a.doctype === state.selectedDoctype;
		});
		const wrap = el("div", "fd-related");
		wrap.appendChild(el("h3", null, "Related APIs (" + related.length + ")"));
		if (!related.length) {
			wrap.appendChild(emptyMsg("No APIs reference this DocType."));
		}
		related.forEach(function (a) {
			const link = el("div", "fd-related-link", a.route);
			link.onclick = function () {
				openApi(a);
			};
			wrap.appendChild(link);
		});
		state.relatedEl.appendChild(wrap);
	}

	// ---- boot ----
	const init = readHash();
	state.activeTab = init.tab === "doctype" ? "doctype" : "api";
	state.selectedDoctype = init.doctype;
	ui.tabApi.classList.toggle("active", state.activeTab === "api");
	ui.tabDt.classList.toggle("active", state.activeTab === "doctype");
	ui.sideSearch.placeholder =
		state.activeTab === "api" ? "Search APIs..." : "Search DocTypes...";
	renderTab();
};
