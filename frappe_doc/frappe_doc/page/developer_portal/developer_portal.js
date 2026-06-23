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

	const API_SCOPES = [
		"All",
		"App",
		"Module",
		"Filename",
		"DocType",
		"Function",
		"Route",
		"Args",
		"Docstring",
	];
	const DT_SCOPES = ["All", "DocType", "Module"];
	const FIELD_SCOPES = ["All", "Fieldname", "Label", "Fieldtype"];

	const state = {
		activeTab: "api",
		apis: null,
		doctypes: null,
		selectedDoctype: null,
		schemaCache: {},
		apiScope: "All",
		apiSearch: "",
		doctypeScope: "All",
		doctypeSearch: "",
		fieldScope: "All",
		fieldSearch: "",
		collapsedGroups: {},
		inflight: {},
		_loadingEl: null,
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
	function emptyState(term, scope, onClear) {
		const w = el("div", "fd-empty");
		w.appendChild(document.createTextNode("No results for '" + (term || "") + "' in " + scope + ". "));
		const link = el("a", "fd-clear-link", "Clear search");
		link.href = "#";
		link.onclick = function (e) {
			e.preventDefault();
			onClear();
		};
		w.appendChild(link);
		return w;
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

	// ---- compound scope + search control ----
	function makeSearch(cfg) {
		const wrap = el("div", "fd-search-wrap");
		const select = el("select", "fd-scope");
		cfg.scopes.forEach(function (s) {
			const o = document.createElement("option");
			o.value = s;
			o.textContent = s;
			if (s === cfg.scope) o.selected = true;
			select.appendChild(o);
		});
		const input = el("input", "fd-search-input");
		input.type = "text";
		input.placeholder = cfg.placeholder || "Search...";
		input.value = cfg.term || "";

		let timer = null;
		select.onchange = function () {
			cfg.onChange(select.value, input.value.trim());
		};
		input.oninput = function () {
			clearTimeout(timer);
			timer = setTimeout(function () {
				cfg.onChange(select.value, input.value.trim());
			}, 300);
		};
		input.onkeydown = function (e) {
			if (e.key === "Tab" && !e.shiftKey) {
				e.preventDefault();
				select.focus();
			} else if (e.key === "Escape") {
				e.preventDefault();
				input.value = "";
				cfg.onChange(select.value, "");
				input.focus();
			}
		};

		wrap.appendChild(select);
		wrap.appendChild(input);
		return {
			wrap: wrap,
			select: select,
			input: input,
			clear: function () {
				input.value = "";
				select.value = cfg.scopes[0];
				cfg.onChange(cfg.scopes[0], "");
				input.focus();
			},
		};
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
	ui.sideTools = el("div", "fd-side-tools");
	ui.sideCount = el("div", "fd-count fd-side-count");
	ui.mobileSelect = el("select", "fd-mobile-select");
	ui.sideList = el("div", "fd-sidebar-list");
	sidebar.appendChild(ui.sideTools);
	sidebar.appendChild(ui.sideCount);
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
		// Remove search resetting to cache the navigation state
		updateHash();
		renderTab();
	}
	function renderTab() {
		buildSidebarTools();
		if (state.activeTab === "api") renderApiTab();
		else renderDoctypeTab();
	}

	function buildSidebarTools() {
		ui.sideTools.innerHTML = "";
		ui.sideCount.textContent = "";
		if (state.activeTab === "doctype") {
			state.sideSearchCtl = makeSearch({
				scopes: DT_SCOPES,
				scope: state.doctypeScope,
				term: state.doctypeSearch,
				placeholder: "Search doctypes...",
				onChange: function (s, t) {
					state.doctypeScope = s;
					state.doctypeSearch = t;
					renderDoctypeSidebar();
				},
			});
			ui.sideTools.appendChild(state.sideSearchCtl.wrap);
			ui.sideCount.style.display = "";
		} else {
			state.sideSearchCtl = null;
			ui.sideCount.style.display = "none";
		}
	}

	ui.tabApi.onclick = function () {
		switchTab("api");
	};
	ui.tabDt.onclick = function () {
		switchTab("doctype");
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
		const head = el("div", "fd-content-head");
		const toolbar = el("div", "fd-toolbar");
		state.apiSearchCtl = makeSearch({
			scopes: API_SCOPES,
			scope: state.apiScope,
			term: state.apiSearch,
			placeholder: "Search endpoints...",
			onChange: function (s, t) {
				state.apiScope = s;
				state.apiSearch = t;
				renderApiSidebar();
				renderApiResults();
			},
		});
		toolbar.appendChild(state.apiSearchCtl.wrap);
		const refresh = el("button", "fd-btn", "Refresh Cache");
		refresh.onclick = forceRescan;
		toolbar.appendChild(refresh);
		state.apiCountEl = el("div", "fd-count");
		head.appendChild(toolbar);
		head.appendChild(state.apiCountEl);
		ui.content.appendChild(head);

		const bodyEl = el("div", "fd-content-body");
		state.apiResultsEl = el("div", "fd-results");
		bodyEl.appendChild(state.apiResultsEl);
		ui.content.appendChild(bodyEl);
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

	function apiHaystacks(a) {
		return {
			App: a.app || "",
			Module: a.module_path || "",
			Filename: a.file || "",
			DocType: a.doctype || "",
			Function: a.function || "",
			Route: a.route || "",
			Args: (a.args || []).join(" "),
			Docstring: a.docstring || "",
		};
	}
	function matchApiScoped(a, scope, term) {
		if (!term) return true;
		const h = apiHaystacks(a);
		let hay;
		if (scope === "All") {
			hay = Object.keys(h)
				.map(function (k) {
					return h[k];
				})
				.join(" ");
		} else {
			hay = h[scope] || "";
		}
		return hay.toLowerCase().indexOf(term) !== -1;
	}
	function filteredApis() {
		const term = state.apiSearch.trim().toLowerCase();
		return (state.apis || []).filter(function (a) {
			return matchApiScoped(a, state.apiScope, term);
		});
	}

	function renderApiSidebar() {
		ui.sideList.innerHTML = "";
		ui.mobileSelect.innerHTML = "";
		if (state.apis === null) return;
		const term = state.apiSearch.trim();
		const apis = filteredApis();
		if (!apis.length) {
			ui.sideList.appendChild(emptyMsg("No matching endpoints."));
			return;
		}
		const groups = {};
		apis.forEach(function (a) {
			const key = a.app || "Uncategorized";
			(groups[key] = groups[key] || []).push(a);
		});
		const keys = Object.keys(groups).sort(function (x, y) {
			if (x === "Uncategorized") return 1;
			if (y === "Uncategorized") return -1;
			return x.localeCompare(y);
		});
		keys.forEach(function (key) {
			const g = el("div", "fd-group");
			if (state.collapsedGroups[key] !== false) g.classList.add("collapsed");
			const head = el("div", "fd-group-header");
			const arrow = el("span", "fd-group-arrow", "\u25BE");
			const label = el("span");
			label.style.flex = "1 1 auto";
			label.innerHTML = hl(key, term) + " (" + groups[key].length + ")";
			head.appendChild(arrow);
			head.appendChild(label);
			head.onclick = function () {
				state.collapsedGroups[key] = state.collapsedGroups[key] === false ? true : false;
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
			const route = this.value;
			const a = (state.apis || []).filter(function (x) {
				return x.route === route;
			})[0];
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
		const all = state.apis || [];
		const apis = filteredApis();
		if (state.apiCountEl) {
			state.apiCountEl.textContent =
				"Showing " + apis.length + " of " + all.length + " endpoints";
		}
		if (!apis.length) {
			if (all.length) {
				c.appendChild(
					emptyState(state.apiSearch, state.apiScope, function () {
						state.apiSearchCtl.clear();
					})
				);
			} else {
				c.appendChild(emptyMsg("No whitelisted APIs found."));
			}
			return;
		}
		apis.forEach(function (a) {
			c.appendChild(buildApiCard(a, state.apiSearch));
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

	function primaryHttpMethod(a) {
		const methods = a.methods && a.methods.length ? a.methods : ["POST"];
		return methods[0];
	}

	function buildFrappeJsSnippet(a) {
		const lines = [];
		if (a.allow_guest) {
			lines.push("// No authentication required for this endpoint");
		}
		lines.push("frappe.call({");
		lines.push('    method: "' + a.module_path + '",');
		if (a.args && a.args.length) {
			lines.push("    args: {");
			a.args.forEach(function (arg, i) {
				const comma = i < a.args.length - 1 ? "," : "";
				lines.push('        ' + arg + ': ""' + comma);
			});
			lines.push("    },");
		} else {
			lines.push("    args: {},");
		}
		lines.push("    callback: function(r) {");
		lines.push("        console.log(r.message);");
		lines.push("    }");
		lines.push("});");
		return lines.join("\n");
	}

	function buildCurlSnippet(a) {
		const lines = [];
		if (a.allow_guest) {
			lines.push("# No authentication required");
		}
		const method = primaryHttpMethod(a);
		const baseUrl = "https://yoursite.com" + a.route;
		const args = a.args || [];

		if (method === "GET") {
			let url = baseUrl;
			if (args.length) {
				url +=
					"?" +
					args
						.map(function (arg) {
							return encodeURIComponent(arg) + "=<value>";
						})
						.join("&");
			}
			lines.push("curl -X GET \\");
			lines.push('  "' + url + '"');
			if (!a.allow_guest) {
				lines.push('  -H "Authorization: token <api_key>:<api_secret>"');
			}
		} else {
			lines.push("curl -X " + method + " \\");
			lines.push('  "' + baseUrl + '"');
			if (!a.allow_guest) {
				lines.push('  -H "Authorization: token <api_key>:<api_secret>"');
			}
			lines.push('  -H "Content-Type: application/x-www-form-urlencoded"');
			if (args.length) {
				lines.push(
					'  -d "' +
						args
							.map(function (arg) {
								return encodeURIComponent(arg) + "=<value>";
							})
							.join("&") +
						'"'
				);
			}
		}
		return lines.join("\n");
	}

	function buildCodeBlock(snippetText) {
		const block = el("div", "fd-code-block");
		const copyBtn = el("button", "fd-code-copy", "Copy");
		copyBtn.onclick = function (e) {
			e.stopPropagation();
			copyText(snippetText);
		};
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		code.textContent = snippetText;
		pre.appendChild(code);
		block.appendChild(copyBtn);
		block.appendChild(pre);
		return block;
	}

	function buildUsageSection(a) {
		const frappeSnippet = buildFrappeJsSnippet(a);
		const curlSnippet = buildCurlSnippet(a);

		const pd = a.parsed_doc || {};
		const hasExamples = pd.example_request || pd.example_response;

		const usage = el("div", "fd-usage collapsed");
		const header = el("div", "fd-usage-header");
		const arrow = el("span", "fd-usage-arrow", "\u25B6");
		header.appendChild(arrow);
		header.appendChild(document.createTextNode("Usage"));
		header.onclick = function () {
			usage.classList.toggle("collapsed");
		};
		usage.appendChild(header);

		const body = el("div", "fd-usage-body");
		const tabs = el("div", "fd-snippet-tabs");
		const tabFrappe = el("button", "fd-snippet-tab active", "Frappe JS");
		tabFrappe.type = "button";
		const tabCurl = el("button", "fd-snippet-tab", "curl");
		tabCurl.type = "button";
		tabs.appendChild(tabFrappe);
		tabs.appendChild(tabCurl);

		let tabExamples = null;
		if (hasExamples) {
			tabExamples = el("button", "fd-snippet-tab", "Examples");
			tabExamples.type = "button";
			tabs.appendChild(tabExamples);
		}
		body.appendChild(tabs);

		const panelFrappe = el("div", "fd-snippet-panel active");
		panelFrappe.appendChild(buildCodeBlock(frappeSnippet));
		const note = el(
			"p",
			"fd-snippet-note",
			"frappe.call() always uses POST under the hood regardless of the logical method type."
		);
		panelFrappe.appendChild(note);

		const panelCurl = el("div", "fd-snippet-panel");
		panelCurl.appendChild(buildCodeBlock(curlSnippet));

		let panelExamples = null;
		if (hasExamples) {
			panelExamples = el("div", "fd-snippet-panel");
			panelExamples.appendChild(buildExamplesPanel(pd));
		}

		function switchSnippetTab(active) {
			tabFrappe.classList.toggle("active", active === "frappe");
			tabCurl.classList.toggle("active", active === "curl");
			panelFrappe.classList.toggle("active", active === "frappe");
			panelCurl.classList.toggle("active", active === "curl");
			if (tabExamples) tabExamples.classList.toggle("active", active === "examples");
			if (panelExamples) panelExamples.classList.toggle("active", active === "examples");
		}
		tabFrappe.onclick = function (e) {
			e.stopPropagation();
			switchSnippetTab("frappe");
		};
		tabCurl.onclick = function (e) {
			e.stopPropagation();
			switchSnippetTab("curl");
		};
		if (tabExamples) {
			tabExamples.onclick = function (e) {
				e.stopPropagation();
				switchSnippetTab("examples");
			};
		}

		body.appendChild(panelFrappe);
		body.appendChild(panelCurl);
		if (panelExamples) body.appendChild(panelExamples);
		usage.appendChild(body);
		return usage;
	}

	// ---- Examples side-by-side panel ----
	function buildExamplesPanel(pd) {
		const hasBoth = pd.example_request && pd.example_response;
		const layout = el("div", "fd-examples-layout" + (hasBoth ? "" : " single"));
		if (pd.example_request) {
			const col = el("div");
			if (hasBoth) {
				const lbl = el("div", "fd-examples-col-label", "Request");
				col.appendChild(lbl);
			}
			col.appendChild(buildCodeBlock(pd.example_request));
			layout.appendChild(col);
		}
		if (pd.example_response) {
			const col = el("div");
			if (hasBoth) {
				const lbl = el("div", "fd-examples-col-label", "Response");
				col.appendChild(lbl);
			}
			col.appendChild(buildCodeBlock(pd.example_response));
			layout.appendChild(col);
		}
		return layout;
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

	// ---- JSON syntax highlighter ----
	function highlightJson(json) {
		return json
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(
				/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
				function (match) {
					if (/^"/.test(match)) {
						return /:$/.test(match)
							? '<span class="fd-json-key">' + match + "</span>"
							: '<span class="fd-json-str">' + match + "</span>";
					}
					if (/true|false/.test(match)) return '<span class="fd-json-bool">' + match + "</span>";
					if (/null/.test(match)) return '<span class="fd-json-null">' + match + "</span>";
					return '<span class="fd-json-num">' + match + "</span>";
				}
			);
	}

	// ---- Try it out section ----
	function buildTryItSection(a) {
		const pd = a.parsed_doc || {};
		// Build a map of arg name -> example value from parsed doc args
		const argExamples = {};
		(pd.args || []).forEach(function (argInfo) {
			argExamples[argInfo.name] = "";
		});
		// Pre-fill from example_request if it parses as JSON object
		if (pd.example_request) {
			try {
				const ex = JSON.parse(pd.example_request);
				if (ex && typeof ex === "object" && !Array.isArray(ex)) {
					Object.keys(ex).forEach(function (k) {
						argExamples[k] = typeof ex[k] === "string" ? ex[k] : JSON.stringify(ex[k]);
					});
				}
			} catch (e) {}
		}

		const tryIt = el("div", "fd-try-it collapsed");
		const header = el("div", "fd-try-it-header");
		const arrow = el("span", "fd-try-it-arrow", "\u25B6");
		const badge = el("span", "fd-try-it-badge", "TRY IT OUT");
		header.appendChild(arrow);
		header.appendChild(document.createTextNode(" "));
		header.appendChild(badge);
		header.onclick = function () {
			tryIt.classList.toggle("collapsed");
		};
		tryIt.appendChild(header);

		const body = el("div", "fd-try-it-body");
		const inputs = {};

		// Combine explicit python args and docstring args
		let allArgs = [].concat(a.args || []);
		if (pd.args) {
			pd.args.forEach(function (argMeta) {
				if (allArgs.indexOf(argMeta.name) === -1) {
					allArgs.push(argMeta.name);
				}
			});
		}

		if (allArgs.length) {
			const form = el("div", "fd-try-it-form");
			allArgs.forEach(function (argName) {
				const row = el("div", "fd-arg-input-row");
				const labelEl = el("label", "fd-arg-input-label");
				labelEl.textContent = argName;
				// Attach type hint if available
				const argMeta = (pd.args || []).find(function (x) { return x.name === argName; });
				if (argMeta && argMeta.type) {
					const small = document.createElement("small");
					small.textContent = argMeta.type;
					labelEl.appendChild(small);
				}
				const input = el("input", "fd-arg-input");
				input.type = "text";
				input.placeholder = argExamples[argName] ? argExamples[argName] : "value";
				if (argExamples[argName]) input.value = argExamples[argName];
				input.setAttribute("data-arg", argName);
				row.appendChild(labelEl);
				row.appendChild(input);
				form.appendChild(row);
				inputs[argName] = input;
			});
			body.appendChild(form);
		} else {
			const note = el("p", "fd-snippet-note", "This endpoint takes no arguments.");
			body.appendChild(note);
		}

		const actions = el("div", "fd-try-actions");
		const sendBtn = el("button", "fd-send-btn", "\u25B6\u2009Send Request");
		const clearBtn = el("button", "fd-clear-btn", "Clear");
		actions.appendChild(sendBtn);
		actions.appendChild(clearBtn);
		body.appendChild(actions);

		let responseEl = null;

		clearBtn.onclick = function () {
			Object.values(inputs).forEach(function (inp) { inp.value = ""; });
			if (responseEl && responseEl.parentNode) {
				responseEl.parentNode.removeChild(responseEl);
				responseEl = null;
			}
		};

		sendBtn.onclick = function () {
			sendBtn.disabled = true;
			sendBtn.textContent = "\u23F3 Sending…";

			// Collect args
			const args = {};
			Object.keys(inputs).forEach(function (k) {
				const v = inputs[k].value;
				if (v !== "") args[k] = v;
			});

			const t0 = Date.now();
			frappe.call({
				method: a.module_path,
				args: args,
				callback: function (r) {
					const elapsed = Date.now() - t0;
					sendBtn.disabled = false;
					sendBtn.innerHTML = "\u25B6\u2009Send Request";
					renderResponse(true, r.message, elapsed);
				},
				error: function (r) {
					const elapsed = Date.now() - t0;
					sendBtn.disabled = false;
					sendBtn.innerHTML = "\u25B6\u2009Send Request";
					const errMsg = (r && r.responseJSON && r.responseJSON.exc_type)
						? r.responseJSON.exc_type + ": " + (r.responseJSON.exception || "")
						: (r && r.statusText ? r.statusText : "Request failed");
					renderResponse(false, errMsg, elapsed);
				},
			});
		};

		function renderResponse(ok, data, elapsed) {
			if (responseEl && responseEl.parentNode) {
				responseEl.parentNode.removeChild(responseEl);
			}
			responseEl = el("div", "fd-response-panel");

			const rHeader = el("div", "fd-response-header");
			const statusBadge = el(
				"span",
				"fd-response-status " + (ok ? "fd-status-ok" : "fd-status-err"),
				ok ? "\u2705 200 OK" : "\u274C Error"
			);
			const timeEl = el("span", "fd-response-time", elapsed + " ms");
			const copyBtn = el("button", "fd-response-copy", "Copy");

			let prettyText;
			try {
				prettyText = JSON.stringify(typeof data === "string" ? JSON.parse(data) : data, null, 2);
			} catch (e) {
				prettyText = String(data);
			}

			copyBtn.onclick = function () { copyText(prettyText); };
			rHeader.appendChild(statusBadge);
			rHeader.appendChild(timeEl);
			rHeader.appendChild(copyBtn);
			responseEl.appendChild(rHeader);

			const rBody = el("div", "fd-response-body");
			const pre = document.createElement("pre");
			try {
				pre.innerHTML = highlightJson(prettyText);
			} catch (e) {
				pre.textContent = prettyText;
			}
			rBody.appendChild(pre);
			responseEl.appendChild(rBody);
			body.appendChild(responseEl);
		}

		tryIt.appendChild(body);
		return tryIt;
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
		meta.innerHTML =
			hl(a.app, term) +
			" &middot; " +
			hl(a.module_path, term) +
			" &middot; " +
			hl(a.file, term) +
			":" +
			esc(a.line);
		card.appendChild(meta);

		if (a.args && a.args.length) {
			const args = el("div", "fd-args");
			a.args.forEach(function (arg) {
				const s = el("span", "fd-arg");
				let label = arg;
				const pd = a.parsed_doc || {};
				const argMeta = (pd.args || []).find(function (x) { return x.name === arg; });
				if (argMeta && argMeta.type) {
					label += ": " + argMeta.type;
				}
				s.innerHTML = hl(label, term);
				args.appendChild(s);
			});
			card.appendChild(args);
		}

		// Docstring: prefer parsed summary+description; fall back to raw docstring
		const pd = a.parsed_doc || {};
		const displayDoc = (pd.summary || pd.description)
			? [pd.summary, pd.description].filter(Boolean).join("\n\n")
			: (a.docstring || "");
		if (displayDoc) {
			const d = el("p", "fd-doc");
			d.innerHTML = hl(displayDoc, term);
			card.appendChild(d);
		}

		// Arg description table (only if parsed_doc has arg descriptions)
		const parsedArgs = (pd.args || []).filter(function (x) { return x.description || x.type; });
		if (parsedArgs.length) {
			const tbl = document.createElement("table");
			tbl.className = "fd-arg-table";
			const thead = document.createElement("thead");
			const hrow = document.createElement("tr");
			["Parameter", "Type", "Description"].forEach(function (h) {
				const th = document.createElement("th");
				th.textContent = h;
				hrow.appendChild(th);
			});
			thead.appendChild(hrow);
			tbl.appendChild(thead);
			const tbody = document.createElement("tbody");
			parsedArgs.forEach(function (arg) {
				const tr = document.createElement("tr");
				const tdName = document.createElement("td");
				tdName.className = "fd-arg-name-cell";
				tdName.textContent = arg.name;
				const tdType = document.createElement("td");
				tdType.className = "fd-arg-type";
				tdType.textContent = arg.type || "";
				const tdDesc = document.createElement("td");
				tdDesc.textContent = arg.description || "";
				tr.appendChild(tdName);
				tr.appendChild(tdType);
				tr.appendChild(tdDesc);
				tbody.appendChild(tr);
			});
			tbl.appendChild(tbody);
			card.appendChild(tbl);
		}

		// Returns note
		if (pd.returns) {
			const ret = el("div", "fd-meta");
			ret.innerHTML = "<strong>Returns:</strong> " + esc(pd.returns);
			card.appendChild(ret);
		}

		card.appendChild(buildUsageSection(a));
		card.appendChild(buildTryItSection(a));

		return card;
	}

	function openDoctype(name) {
		switchTab("doctype");
		selectDoctype(name);
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
		const head = el("div", "fd-content-head");
		const toolbar = el("div", "fd-toolbar");
		state.fieldSearchCtl = makeSearch({
			scopes: FIELD_SCOPES,
			scope: state.fieldScope,
			term: state.fieldSearch,
			placeholder: "Search fields in this DocType...",
			onChange: function (s, t) {
				state.fieldScope = s;
				state.fieldSearch = t;
				renderFieldArea();
			},
		});
		toolbar.appendChild(state.fieldSearchCtl.wrap);
		state.fieldCountEl = el("div", "fd-count");
		head.appendChild(toolbar);
		head.appendChild(state.fieldCountEl);
		ui.content.appendChild(head);

		const bodyEl = el("div", "fd-content-body");
		state.dtTitleEl = el("h4");
		state.dtTitleEl.style.margin = "0 0 12px 0";
		state.dtTitleEl.style.color = "var(--fd-text)";
		state.statsEl = el("div");
		state.treeEl = el("div");
		bodyEl.appendChild(state.dtTitleEl);
		bodyEl.appendChild(state.statsEl);
		bodyEl.appendChild(state.treeEl);
		ui.content.appendChild(bodyEl);
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

	function matchDtScoped(d, scope, term) {
		if (!term) return true;
		let hay;
		if (scope === "DocType") hay = d.name || "";
		else if (scope === "Module") hay = d.module || "";
		else hay = (d.name || "") + " " + (d.module || "");
		return hay.toLowerCase().indexOf(term) !== -1;
	}

	function renderDoctypeSidebar() {
		ui.sideList.innerHTML = "";
		ui.mobileSelect.innerHTML = "";
		if (state.doctypes === null) return;
		const term = state.doctypeSearch.trim();
		const low = term.toLowerCase();
		const all = state.doctypes || [];
		const list = all.filter(function (d) {
			return matchDtScoped(d, state.doctypeScope, low);
		});
		ui.sideCount.textContent = "Showing " + list.length + " of " + all.length + " doctypes";
		if (!list.length) {
			ui.sideList.appendChild(
				emptyState(state.doctypeSearch, state.doctypeScope, function () {
					if (state.sideSearchCtl) state.sideSearchCtl.clear();
				})
			);
			return;
		}
		list.forEach(function (d) {
			const it = el("div", "fd-side-item");
			if (d.name === state.selectedDoctype) it.classList.add("active");
			const nm = el("span");
			nm.innerHTML = hl(d.name, term);
			const sub = el("span", "fd-side-sub");
			sub.innerHTML = hl(d.module || "", term);
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
			if (state.dtTitleEl) state.dtTitleEl.textContent = "";
			state.fieldCountEl.textContent = "";
			state.statsEl.innerHTML = "";
			state.treeEl.innerHTML = "";
			state.treeEl.appendChild(
				emptyMsg("Select a DocType from the sidebar to view its fields.")
			);
			if (state.fieldSearchCtl) {
				state.fieldSearchCtl.input.disabled = true;
				state.fieldSearchCtl.select.disabled = true;
			}
			return;
		}
		if (state.dtTitleEl) state.dtTitleEl.textContent = state.selectedDoctype;
		if (state.fieldSearchCtl) {
			state.fieldSearchCtl.input.disabled = false;
			state.fieldSearchCtl.select.disabled = false;
		}

		if (state.schemaCache[state.selectedDoctype]) {
			renderFieldArea();
			return;
		}

		showLoading();
		call(
			DT_SCHEMA,
			{ doctype: state.selectedDoctype },
			function (msg) {
				hideLoading();
				if (msg && msg.error) {
					state.fieldCountEl.textContent = "";
					state.statsEl.innerHTML = "";
					showError(state.treeEl, msg.error);
					return;
				}
				state.schemaCache[state.selectedDoctype] = msg || { fields: [] };
				renderFieldArea();
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

	function matchFieldScoped(f, scope, term) {
		if (!term) return true;
		let hay;
		if (scope === "Fieldname") hay = f.fieldname || "";
		else if (scope === "Label") hay = f.label || "";
		else if (scope === "Fieldtype") hay = f.fieldtype || "";
		else hay = (f.fieldname || "") + " " + (f.label || "");
		return hay.toLowerCase().indexOf(term) !== -1;
	}

	function flatten(fields, path, term, scope, out) {
		fields.forEach(function (f) {
			if (matchFieldScoped(f, scope, term)) {
				out.push({ field: f, path: path.concat([f.fieldname]) });
			}
			if (f.children) flatten(f.children, path.concat([f.fieldname]), term, scope, out);
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
		const tb = el("span", "fd-badge fd-badge-type");
		tb.innerHTML = hl(typeText, term);
		row.appendChild(tb);
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
		const rawTerm = state.fieldSearch.trim();
		const term = rawTerm.toLowerCase();
		if (term) {
			const flat = [];
			flatten(fields, [], term, state.fieldScope, flat);
			state.fieldCountEl.textContent =
				"Showing " + flat.length + " of " + st.total + " fields";
			if (!flat.length) {
				state.treeEl.appendChild(
					emptyState(state.fieldSearch, state.fieldScope, function () {
						state.fieldSearchCtl.clear();
					})
				);
				return;
			}
			flat.forEach(function (item) {
				const w = el("div");
				const bc = el("div", "fd-breadcrumb");
				bc.textContent = [state.selectedDoctype].concat(item.path).join(" \u203A ");
				w.appendChild(bc);
				w.appendChild(buildFieldRow(item.field, 0, rawTerm, false));
				state.treeEl.appendChild(w);
			});
		} else {
			state.fieldCountEl.textContent =
				"Showing " + st.total + " of " + st.total + " fields";
			renderNodes(fields, 0, state.treeEl, "");
		}
	}

	// ---- boot ----
	const init = readHash();
	state.activeTab = init.tab === "doctype" ? "doctype" : "api";
	state.selectedDoctype = init.doctype;
	ui.tabApi.classList.toggle("active", state.activeTab === "api");
	ui.tabDt.classList.toggle("active", state.activeTab === "doctype");
	renderTab();
};
