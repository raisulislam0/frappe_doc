# 📚 frappe_doc — The Developer Portal for Frappe & ERPNext

> Stop digging through source code. Stop guessing parameter names. Stop opening five browser tabs to understand one API call.  
> **frappe_doc** gives you a live, searchable, interactive documentation portal — auto-generated from your actual codebase.

---

## Table of Contents

- [What is frappe\_doc?](#what-is-frappe_doc)
- [Features at a Glance](#features-at-a-glance)
- [Installation](#installation)
- [Accessing the Portal](#accessing-the-portal)
- [API Explorer](#api-explorer)
  - [How APIs Are Discovered](#how-apis-are-discovered)
  - [HTTP Method Inference](#http-method-inference)
  - [Searching & Filtering](#searching--filtering)
  - [Code Snippets (Frappe JS & cURL)](#code-snippets-frappe-js--curl)
  - [Try It Out](#try-it-out)
  - [Refresh Cache](#refresh-cache)
- [Writing Great API Documentation](#writing-great-api-documentation)
  - [Python Type Hints (Automatic)](#python-type-hints-automatic)
  - [Google-Style Docstrings](#google-style-docstrings)
  - [Full Example — Best Practice API](#full-example--best-practice-api)
  - [Docstring Section Reference](#docstring-section-reference)
- [DocType Field Explorer](#doctype-field-explorer)
  - [Hierarchical Child Tables](#hierarchical-child-tables)
  - [Field Search](#field-search)
- [Access Control](#access-control)
- [FAQ](#faq)

---

## What is frappe\_doc?

**frappe_doc** is a zero-configuration developer portal that installs as a standard Frappe app.

The moment you install it, it:
- **Scans every installed app** for all `@frappe.whitelist()` functions using Python's `ast` module — no code is imported or executed, so it's completely safe.
- **Parses docstrings** to extract parameter descriptions, return types, and usage examples.
- **Extracts Python type annotations** from your function signatures directly.
- **Renders an interactive UI** in your Frappe desk at `/app/developer_portal` (or the shortcut `/doc`).

You get **Swagger-like documentation** — but built for the Frappe ecosystem, requiring zero extra configuration files, zero decorators beyond what you already use, and zero maintenance overhead.

---

## Features at a Glance

| Feature | Description |
|---|---|
| 🔍 **API Explorer** | Browse, search, and filter all whitelisted endpoints across all installed apps |
| 📝 **Auto-parsed Docs** | Docstrings, type hints, args, returns, and examples — rendered automatically |
| 🧪 **Try It Out** | Send live API requests directly from the portal, see real responses |
| 📋 **Code Snippets** | One-click `frappe.call()` and `curl` snippets ready to copy |
| 🏗️ **DocType Explorer** | Browse all DocType fields with child table trees expanded hierarchically |
| ⚡ **Smart Caching** | Results are cached for 1 hour; one click to refresh on demand |
| 🔒 **Safe & Secure** | AST-only scanning (no execution), with role-based access control |

---

## Installation

```bash
# From your bench directory
cd /path/to/frappe-bench

# Get the app
bench get-app https://github.com/raisulislam0/frappe_doc.git

# Install on your site
bench --site yoursite.com install-app frappe_doc
bench --site yoursite.com migrate

# Clear cache to register the new page
bench --site yoursite.com clear-cache
```

---

## Accessing the Portal

Once installed, any **System Manager** (or any logged-in user when `developer_mode` is enabled) can access the portal:

- **Direct desk link:** `/app/developer_portal`
- **Short URL:** `/doc` (redirects automatically)

The portal is divided into two main tabs:

1. **API Explorer** — Browse all `@frappe.whitelist()` endpoints
2. **DocType Fields** — Explore all DocType schemas with child-table trees

---

## API Explorer

### How APIs Are Discovered

frappe_doc **automatically scans all installed apps** using Python's `ast` module. It walks every `.py` file in every installed app and detects all functions decorated with:

```python
@frappe.whitelist()
@frappe.whitelist(allow_guest=True)
@frappe.whitelist(methods=["GET"])
@whitelist()  # bare form also detected
```

No configuration needed. No registration required. If it's whitelisted, it's documented.

---

### HTTP Method Inference

frappe_doc intelligently infers the expected HTTP method from your function name, even when you don't explicitly declare one:

| Function Name Prefix | Inferred Method |
|---|---|
| `get_`, `fetch_`, `find_`, `search_`, `list_`, `check_` | `GET` |
| `create_`, `save_`, `submit_`, `add_`, `insert_`, `post_` | `POST` |
| `update_`, `edit_`, `modify_`, `patch_` | `PUT (via POST)` |
| `delete_`, `remove_`, `cancel_`, `disable_` | `DELETE (via POST)` |

> **Tip:** Use **explicit method declarations** to override inference and get the most accurate documentation:
> ```python
> @frappe.whitelist(methods=["GET"])
> def get_employee_profile(employee_id: str) -> dict:
>     ...
> ```

Inferred methods are shown with a `~` prefix (e.g., `~GET`) and a dashed border to indicate they are guesses. Explicitly declared methods appear with solid badges.

---

### Searching & Filtering

The search bar supports multiple scopes via a dropdown:

| Scope | Searches In |
|---|---|
| `All` | Everything — route, args, docstring, file, app |
| `App` | The app name (e.g., `erpnext`, `hrms`) |
| `Module` | Full Python module path |
| `Filename` | Source file path |
| `DocType` | Detected associated DocType |
| `Function` | The function name only |
| `Route` | The full `/api/method/...` route |
| `Args` | Parameter names |
| `Docstring` | Content of the docstring |

---

### Code Snippets (Frappe JS & cURL)

Every API card has a **Usage** section (collapsed by default) that generates ready-to-use code snippets.

**Frappe JS tab:**
```javascript
frappe.call({
    method: "hrms.api.leave.apply_for_leave",
    args: {
        employee: "",
        leave_type: "",
        from_date: "",
        to_date: "",
    },
    callback: function(r) {
        console.log(r.message);
    }
});
```

**curl tab:**
```bash
curl -X POST \
  "https://yoursite.com/api/method/hrms.api.leave.apply_for_leave" \
  -H "Authorization: token <api_key>:<api_secret>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "employee=EMP-001&leave_type=Casual+Leave&from_date=2024-01-01&to_date=2024-01-03"
```

**Examples tab** (shown if you document `Example Request` / `Example Response` in your docstring):
Side-by-side JSON blocks showing request and response payloads.

---

### Try It Out

Click the **TRY IT OUT** section on any API card to:

1. Fill in parameter values in an interactive form
2. Click **▶ Send Request** to fire the real API call against your running site
3. Instantly see the JSON response with syntax highlighting
4. See the response time in milliseconds

If your docstring includes an `Example Request` section, the form fields are **pre-filled** with the example values automatically.

---

### Refresh Cache

Scan results are cached for **1 hour**. If you write a new API and want to see it immediately, click the **Refresh Cache** button in the API Explorer toolbar. It re-scans all apps and updates the cache.

---

## Writing Great API Documentation

This is where the real magic happens. By following these conventions in your Python code, frappe_doc renders rich, professional documentation **automatically** — with no extra work.

---

### Python Type Hints (Automatic)

frappe_doc reads Python 3 type annotations directly from your function signature. **You do not need to repeat types in the docstring** — they are detected automatically.

```python
@frappe.whitelist()
def toggle_item(name: str, is_active: bool) -> dict:
    """Toggle the active state of an item."""
    ...
```

**What frappe_doc renders:**

- Parameter badges: `name: str` · `is_active: bool`
- Parameter table with **Type** column pre-filled: `str`, `bool`
- Returns section shows: `dict`

Supported types include all Python built-ins and complex annotations:

```python
def get_items(
    filters: dict,
    limit: int = 20,
    fields: list | None = None,
) -> list[dict]:
    ...
```

These will render as `dict`, `int`, `list | None`, `list[dict]` in the portal.

---

### Google-Style Docstrings

frappe_doc parses **Google-style docstrings** — the most readable and widely adopted Python docstring format.

#### Section Headers (Recognized)

| Section Header | Alias(es) | Purpose |
|---|---|---|
| `Args:` | `Arguments:`, `Parameters:`, `Params:` | Document parameters |
| `Returns:` | `Return:` | Describe the return value |
| `Raises:` | — | Document exceptions |
| `Example Request:` | — | Sample request JSON |
| `Example Response:` | — | Sample response JSON |
| `Example:` | `Examples:` | Generic example (used as request) |
| `Notes:` | `Note:` | Additional context |

#### `Args:` Format

Each argument follows this pattern (indent with 2–4 spaces):

```
    arg_name (type): Description of the argument.
        Continuation lines are joined automatically.
    another_arg (str, optional): This one is optional.
```

> **Note:** If you use Python type hints in the signature, you can skip the `(type)` part in the docstring — frappe_doc will automatically read them from the signature. Only add the type in the docstring when you need to be more descriptive (e.g., `(str, optional)`, `(list of dict)`).

#### `Example Request:` and `Example Response:`

Use fenced JSON code blocks for the best rendering:

```
    Example Request:
        {
            "employee": "EMP-001",
            "leave_type": "Casual Leave"
        }

    Example Response:
        {
            "status": "success",
            "application": "HR-LAP-2024-00001"
        }
```

Or inline JSON (frappe_doc will auto-detect and pretty-print it):

```
    Example Request:
        {"employee": "EMP-001", "leave_type": "Casual Leave"}
```

---

### Full Example — Best Practice API

Here is the **ideal** frappe_doc-optimized API function:

```python
@frappe.whitelist(methods=["POST"])
def apply_for_leave(
    employee: str,
    leave_type: str,
    from_date: str,
    to_date: str,
    reason: str = "",
    half_day: bool = False,
    half_day_date: str | None = None,
) -> dict:
    """Submit a new Leave Application for an employee.

    Creates a Leave Application document, validates leave balance,
    and notifies the employee's leave approver via email.

    Args:
        employee (str): The Employee ID (e.g., "EMP-0001").
        leave_type (str): Name of the Leave Type (e.g., "Casual Leave").
        from_date (str): Leave start date in YYYY-MM-DD format.
        to_date (str): Leave end date in YYYY-MM-DD format.
        reason (str, optional): Reason for the leave. Defaults to empty string.
        half_day (bool, optional): Whether to apply for a half day. Defaults to False.
        half_day_date (str, optional): Date of the half day, required when half_day is True.

    Returns:
        dict: A result object with ``status`` ("success" or "error"),
              ``name`` (the created document name), and ``message``.

    Raises:
        frappe.ValidationError: If leave balance is insufficient or dates are invalid.
        frappe.PermissionError: If the user is not authorized to apply leave for this employee.

    Example Request:
        {
            "employee": "EMP-0001",
            "leave_type": "Casual Leave",
            "from_date": "2024-08-01",
            "to_date": "2024-08-03",
            "reason": "Family function"
        }

    Example Response:
        {
            "status": "success",
            "name": "HR-LAP-2024-00042",
            "message": "Leave Application submitted successfully."
        }
    """
    # ... implementation ...
```

**What frappe_doc renders for this function:**

- ✅ Method badge: `POST` (explicit, solid badge)
- ✅ Parameter pills: `employee: str` · `leave_type: str` · `from_date: str` · `to_date: str` · `reason: str` · `half_day: bool` · `half_day_date: str | None`
- ✅ Summary: "Submit a new Leave Application for an employee."
- ✅ Description paragraph about what the function does
- ✅ Full parameter table with types and descriptions
- ✅ Returns documentation
- ✅ Side-by-side JSON example panels
- ✅ Try It Out form pre-filled with example values

---

### Docstring Section Reference

| What You Want | How To Write It |
|---|---|
| One-line summary | First line of the docstring |
| Multi-paragraph description | Paragraphs after summary, before first section header |
| Parameter with type from signature | Just write `arg_name: Description` (type auto-detected) |
| Parameter with explicit type | `arg_name (type): Description` |
| Optional parameter | `arg_name (type, optional): Description. Defaults to X.` |
| Return value | `Returns:` section with text description |
| JSON request example | `Example Request:` + fenced ```json block |
| JSON response example | `Example Response:` + fenced ```json block |
| Generic example | `Example:` or `Examples:` + fenced ```json block |

---

## DocType Field Explorer

Switch to the **DocType Fields** tab to browse the schema of any DocType installed on your site.

### Hierarchical Child Tables

This is the feature that will **change how you develop on Frappe** forever.

In standard Frappe development, if a DocType has a child table field (e.g., `Sales Order → Items`), you have to:
1. Open the DocType list
2. Search for "Sales Order"
3. Find the `items` field
4. Note that it links to `Sales Order Item`
5. Open a **new browser tab** for the DocType list
6. Search for "Sales Order Item"
7. Browse its fields

**With frappe_doc, this is one click.**

The DocType Field Explorer renders child table fields as **collapsible, indented trees**. Click the arrow next to any `Table` or `Table MultiSelect` field to expand it and see **all child table fields inline** — no navigation required.

```
▾ Sales Order
  ├── customer           Link → Customer
  ├── delivery_date      Date
  ├── po_no              Data
  ▾ items                Table → Sales Order Item      [EXPAND]
    │  ├── item_code      Link → Item                  required
    │  ├── item_name      Data
    │  ├── qty            Float                        required
    │  ├── rate           Currency
    │  ├── amount         Currency                     in_list_view
    │  └── warehouse      Link → Warehouse
  ▾ taxes                Table → Sales Taxes and Charges
    │  ├── charge_type    Select
    │  └── tax_amount     Currency
```

This gives you the **complete picture** of a document's data structure in one place.

---

### Field Search

Use the search bar in the DocType Fields tab to filter fields by:

| Scope | Description |
|---|---|
| `All` | Searches fieldname and label together |
| `Fieldname` | Exact fieldname match (great for API queries) |
| `Label` | Human-readable label search |
| `Fieldtype` | Filter by type (e.g., search for all `Link` fields) |

Each field row shows:
- **Fieldname** (monospaced, bold for top-level fields)
- **Label** (greyed out, human-readable)
- **Type badge** (with the linked DocType for `Link` / `Table` fields)
- **`reqd`** badge for required fields
- **`in_list_view`** badge for fields visible in list view

---


## FAQ

**Q: Does frappe_doc import or execute any of my app's code during scanning?**  
A: No. frappe_doc uses Python's `ast` module to parse source files as text. Your code is never imported or executed during the scan. This makes it completely safe to use even on production servers.

**Q: How often does it re-scan?**  
A: Scan results are cached in Redis for **1 hour**. Click the **Refresh Cache** button at any time to force an immediate re-scan.

**Q: Does it work with `async` functions?**  
A: Yes. Both `def` and `async def` functions decorated with `@frappe.whitelist()` are discovered and documented.

**Q: Do I need to restart the server after installing?**  
A: No. Just run `bench --site mysite clear-cache` and navigate to `/app/developer_portal`.

**Q: My new API isn't showing up. What do I do?**  
A: Click the **Refresh Cache** button in the API Explorer. The 1-hour cache is serving the old scan result.

**Q: Does it work with custom apps?**  
A: Yes. frappe_doc scans **every installed app** on your site — including all your custom apps. There is nothing to configure.

**Q: What if I don't write any docstrings?**  
A: frappe_doc still documents your API. It shows the route, parameter names (from the function signature), type hints (if you use them), and inferred HTTP method. But you'll get much richer documentation if you add docstrings.

**Q: Can I document APIs that already use Google-style docstrings from another style guide?**  
A: Yes. frappe_doc recognizes all the standard Google-style section headers (`Args:`, `Returns:`, `Example:`, etc.) and is designed to work with existing codebases without any changes.

---

## Summary

Stop treating your Frappe backend like a black box.

**frappe_doc** gives every developer on your team — whether they're building JavaScript frontends, writing Python integrations, or onboarding as a new hire — a single, searchable, interactive portal to understand and test every API in your entire Frappe ecosystem.

All it takes is writing clean Python code the way you already should be. Add type hints. Add a docstring. frappe_doc does the rest.

Then open `/doc` in your browser. That's it. 🚀

---

*frappe_doc is open source and built with ❤️ for the Frappe community.*
