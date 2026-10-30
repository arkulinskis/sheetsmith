"""From a raw workbook (WorkbookReader) to a first guess at the app: which sheets become which screens.

    analyze(bp) -> the same blueprint plus:
        bp["app"]   = {title, color, screens: [...], actions: [...]}   (the studio lets people change all of it)
        bp["stats"] = counts for the overview
    and these changes to the workbook part:
        plain data ranges (a header row with rows below) become "pseudo" tables, so they work like Excel tables;
        a table column whose every row has the same formula becomes a calculated column (new rows get it too);
        each table column gets its usual number format ("fmt").

Screens:  table (a list + a form for each row), form (labels next to input cells and results), grid (the sheet as
cells), and any of them can be hidden. Column types: text longtext number integer money percent date datetime time
bool choice email phone url formula.
"""
import re
from collections import Counter

from . import WorkbookReader as W

ICONS = [
    (r"order|sale|invoice|receipt|purchase|cart", "receipt"),
    (r"customer|client|contact|people|person|member|staff|employee|team|student|guest|patient|user|volunteer", "users"),
    (r"product|item|stock|inventor|menu|catalog|part|asset|equipment|tool|supply|supplies", "box"),
    (r"task|todo|to-do|job|ticket|issue|request|work", "check"),
    (r"loan|borrow|lend|checkout|rental|return", "swap"),
    (r"summary|dashboard|report|overview|kpi|stat|total|result", "chart"),
    (r"quote|estimate|calc|pricing|price|tarif", "calc"),
    (r"schedule|calendar|booking|shift|rota|appointment|event|plan|week|month", "calendar"),
    (r"expense|budget|finance|payment|cost|bill|money|account|pay|salary|cash", "wallet"),
    (r"log|history|archive|journal|record|activity", "clock"),
    (r"setting|config|option|list|lookup|reference|ref|admin|param", "sliders"),
    (r"project|case|file|document", "folder"),
    (r"map|location|site|store|route|address|place|room", "pin"),
    (r"form|entry|input|new", "edit"),
]
DEFAULT_OFFICE = {"#4472C4", "#156082", "#4F81BD", "#5B9BD5", "#0F9ED5", "#000000", "#FFFFFF"}
DEFAULT_COLOR = "#1D7A4F"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE = re.compile(r"^\+?[\d\s().-]{7,20}$")
URL = re.compile(r"^(https?://|www\.)\S+$", re.I)


def icon_for(name, kind):
    low = (name or "").lower()
    for pat, icon in ICONS:
        if re.search(pat, low):
            return icon
    return {"table": "table", "form": "edit", "grid": "grid"}.get(kind, "table")


def pretty(name):
    s = re.sub(r"[_]+", " ", name or "").strip()
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s) if " " not in s and len(s) > 3 else s
    return s[:1].upper() + s[1:] if s else "Screen"


def is_date_fmt(code):
    if not code or code == "General":
        return False
    s = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.|_.|\*.', "", code.split(";")[0])
    if re.search(r"[#0?]", s) and not re.search(r"[dy]", s, re.I):
        return False
    return bool(re.search(r"[dy]|h|s", s, re.I) or re.fullmatch(r"m+", re.sub(r"[^a-zA-Z]", "", s) or "x"))


def is_money_fmt(code):
    return bool(code) and bool(re.search(r"[$€£¥]|\[\$|Currency|CHF", code))


def is_pct_fmt(code):
    return bool(code) and "%" in re.sub(r'"[^"]*"', "", code)


# --------------------------------------------------------------------------------------------- helpers
class Sheet(object):
    def __init__(self, s, styles):
        self.s = s
        self.styles = styles
        self.cells = {}
        for a, c in s["cells"].items():
            p = W.parse_ref(a)
            if p:
                self.cells[p] = c
        self.dv = s.get("validations") or []
        self._dv_ranges = []
        for i, v in enumerate(self.dv):
            for q in v["sqref"]:
                r = W.parse_range(q)
                if r:
                    self._dv_ranges.append((r, v))

    def cell(self, r, c):
        return self.cells.get((r, c))

    def style(self, cell):
        if not cell or cell.get("s") is None:
            return {}
        try:
            return self.styles[cell["s"]] or {}
        except (IndexError, TypeError):
            return {}

    def fmt(self, cell):
        return self.style(cell).get("z")

    def has(self, r, c):
        cell = self.cells.get((r, c))
        return bool(cell) and ("f" in cell or ("v" in cell and cell["v"] != ""))

    def text(self, r, c):
        cell = self.cells.get((r, c))
        if cell and "f" not in cell and isinstance(cell.get("v"), str) and cell["v"].strip():
            return cell["v"].strip()
        return None

    def validation(self, r, c):
        for (r1, c1, r2, c2), v in self._dv_ranges:
            if r1 <= r <= r2 and c1 <= c <= c2:
                return v
        return None

    def max_row(self):
        return max([p[0] for p in self.cells] or [0])


def r1c1(formula, row, col):
    """The formula with relative references written relative to (row, col), to compare formulas down a column."""
    def rep(m):
        if m.group(4) is None:
            return m.group(0)
        start = m.start()
        if start > 0 and (formula[start - 1].isalnum() or formula[start - 1] in "_."):
            return m.group(0)
        c, r = W.col_index(m.group(2)), int(m.group(4))
        rs = "R%d" % r if m.group(3) else "R[%d]" % (r - row)
        cs = "C%d" % c if m.group(1) else "C[%d]" % (c - col)
        return rs + cs
    return W._TOKEN.sub(rep, formula)


# --------------------------------------------------------------------------------------------- tables
def table_region(t):
    r1, c1, r2, c2 = W.parse_range(t["ref"])
    first = r1 + (1 if t["header"] else 0)
    last = r2 - (1 if t["totals"] else 0)
    return r1, c1, r2, c2, first, last


def find_pseudo_table(sh, taken):
    """The biggest block that looks like a list: a row of headings with rows of data under it."""
    best = None
    max_r = sh.max_row()
    for r in range(1, min(max_r, 25) + 1):
        c = 1
        while c <= 60:
            if (r, c) in taken or not sh.text(r, c):
                c += 1
                continue
            c1 = c
            while sh.text(r, c) and (r, c) not in taken:
                c += 1
            c2 = c - 1
            if c2 - c1 + 1 < 2:
                continue
            rr = r + 1
            while rr <= max_r and any(sh.has(rr, k) and (rr, k) not in taken for k in range(c1, c2 + 1)):
                rr += 1
            n = rr - r - 1
            if n < 2 and not (n >= 1 and c2 - c1 + 1 >= 3):
                continue
            # a "label: value" form looks like this too; a list has many filled rows in several columns
            filled_cols = sum(1 for k in range(c1, c2 + 1) if sum(1 for q in range(r + 1, rr) if sh.has(q, k)) >= max(1, n // 2))
            if filled_cols < 2:
                continue
            # a list keeps one kind of value per column; "label: value" forms mix numbers and text down a column
            mixed = 0
            for k in range(c1, c2 + 1):
                kinds = Counter()
                for q in range(r + 1, rr):
                    cell = sh.cell(q, k)
                    if not cell or (cell.get("v") in (None, "") and "f" not in cell):
                        continue
                    v = cell.get("v")
                    kinds["f" if "f" in cell else "n" if isinstance(v, (int, float)) and not isinstance(v, bool) else "s"] += 1
                total = sum(kinds.values())
                if total >= 2 and kinds.most_common(1)[0][1] < total * 0.7:
                    mixed += 1
            if mixed:
                continue
            # input cells (unlocked) in the "header" or down a column: that's a form someone fills in
            if any(sh.style(sh.cell(r, k)).get("unlocked") for k in range(c1, c2 + 1)):
                continue
            if any(sum(1 for q in range(r + 1, rr) if sh.style(sh.cell(q, k)).get("unlocked")) > n / 2 for k in range(c1, c2 + 1)):
                continue
            score = n * (c2 - c1 + 1)
            if not best or score > best[0]:
                best = (score, r, c1, rr - 1, c2)
    return best


def safe_table_name(name, used):
    base = re.sub(r"[^A-Za-z0-9_]", "", name.replace(" ", "_")) or "Table"
    if base[0].isdigit():
        base = "T_" + base
    n, out = 1, base
    while out.lower() in used:
        n += 1
        out = "%s%d" % (base, n)
    used.add(out.lower())
    return out


def infer_calc(sh, t):
    """Calculated columns: every data row has a formula, and they are all the same one."""
    r1, c1, r2, c2, first, last = table_region(t)
    if last < first:
        return
    for j, col in enumerate(t["columns"]):
        if col.get("calc"):
            continue
        c = c1 + j
        shapes, any_value = set(), False
        for r in range(first, last + 1):
            cell = sh.cell(r, c)
            if not cell or "f" not in cell:
                any_value = any_value or bool(cell and cell.get("v") not in (None, ""))
                shapes.add(None)
                continue
            shapes.add(r1c1(cell["f"], r, c))
        if len(shapes) == 1 and None not in shapes and not any_value and last - first + 1 >= 1:
            col["calc"] = sh.cell(first, c)["f"]


def column_fmt(sh, t, j):
    r1, c1, r2, c2, first, last = table_region(t)
    fmts = Counter()
    for r in range(first, min(last, first + 200) + 1):
        cell = sh.cell(r, c1 + j)
        if cell:
            f = sh.fmt(cell)
            if f:
                fmts[f] += 1
    return fmts.most_common(1)[0][0] if fmts else None


def column_type(sh, t, j, bp_sheets_by_name):
    r1, c1, r2, c2, first, last = table_region(t)
    col = t["columns"][j]
    name = (col["name"] or "").lower()
    out = {"name": col["name"], "label": col["name"], "type": "text"}
    if col.get("calc"):
        out["type"] = "formula"
        fmt = col.get("fmt")
        if fmt and is_money_fmt(fmt):
            out["show"] = "money"
        return out
    dv = sh.validation(first, c1 + j) if last >= first else sh.validation(r1 + 1, c1 + j)
    fmt = col.get("fmt")
    vals = []
    for r in range(first, min(last, first + 300) + 1):
        cell = sh.cell(r, c1 + j)
        if cell and cell.get("v") not in (None, ""):
            vals.append(cell["v"])
    if dv:
        out["required"] = not dv.get("allowBlank")
        if dv.get("prompt"):
            out["hint"] = dv["prompt"]
        typ = dv.get("type")
        if typ == "list":
            out["type"] = "choice"
            return out
        if typ == "whole":
            out["type"] = "integer"
        elif typ == "decimal":
            out["type"] = "money" if is_money_fmt(fmt) else "percent" if is_pct_fmt(fmt) else "number"
        elif typ == "date":
            out["type"] = "date"
        elif typ == "time":
            out["type"] = "time"
        if out["type"] != "text":
            return out
    nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
    texts = [v for v in vals if isinstance(v, str)]
    bools = [v for v in vals if isinstance(v, bool)]
    if vals and len(bools) == len(vals):
        out["type"] = "bool"
    elif nums and len(nums) >= len(vals) * 0.8:
        if fmt and is_date_fmt(fmt):
            has_time = any(abs(v - int(v)) > 1e-9 for v in nums)
            has_date = any(int(v) != 0 for v in nums)
            out["type"] = "datetime" if has_time and has_date else "time" if has_time else "date"
        elif is_pct_fmt(fmt):
            out["type"] = "percent"
        elif is_money_fmt(fmt) or re.search(r"price|cost|amount|total|fee|revenue|salary|budget|paid|balance|value", name):
            out["type"] = "money"
        elif all(float(v).is_integer() for v in nums) and re.search(r"qty|quantity|count|number|no\b|#|age|year|units|pcs|people|guests|seats", name):
            out["type"] = "integer"
        else:
            out["type"] = "number"
    elif texts:
        if all(EMAIL.match(v.strip()) for v in texts):
            out["type"] = "email"
        elif all(PHONE.match(v.strip()) for v in texts) and re.search(r"phone|tel|mobile|cell|fax", name):
            out["type"] = "phone"
        elif all(URL.match(v.strip()) for v in texts):
            out["type"] = "url"
        elif sum(len(v) for v in texts) / len(texts) > 50 or re.search(r"note|comment|description|details|remarks|feedback", name):
            out["type"] = "longtext"
        else:
            distinct = set(v.strip().lower() for v in texts)
            if len(texts) >= 5 and len(distinct) <= 8 and len(distinct) <= len(texts) * 0.6 and not re.search(r"name|title|id\b|code|ref", name):
                out["type"] = "choice"
                out["fromData"] = True
    else:
        if re.search(r"e-?mail", name):
            out["type"] = "email"
        elif re.search(r"phone|tel\b|mobile", name):
            out["type"] = "phone"
        elif re.search(r"\bdate\b|due|when|deadline|day\b|start|end\b|returned|since", name):
            out["type"] = "date"
        elif re.search(r"note|comment|description|details|remarks", name):
            out["type"] = "longtext"
        elif re.search(r"price|cost|amount|total|fee", name):
            out["type"] = "money"
        elif re.search(r"qty|quantity|count|number", name):
            out["type"] = "integer"
        elif re.search(r"done|paid|active|yes|ok\b|\?$", name):
            out["type"] = "bool"
    return out


# --------------------------------------------------------------------------------------------- forms
def detect_form(sh, taken):
    """Label cells with an input or a result next to them: a form or a little report."""
    fields, headings, used = [], [], set()
    rows = sorted(set(p[0] for p in sh.cells if p not in taken))
    if not rows or rows[-1] > 150:
        rows = [r for r in rows if r <= 150]
    title = None
    for r in rows:
        cols = sorted(c for (rr, c) in sh.cells if rr == r and (rr, c) not in taken)
        row_pairs = 0
        for c in cols:
            if (r, c) in used:
                continue
            label = sh.text(r, c)
            if not label:
                continue
            for k in range(c + 1, c + 4):
                if (r, k) in taken:
                    break
                cell = sh.cell(r, k)
                dv = sh.validation(r, k)
                st = sh.style(cell)
                candidate = False
                if cell and "f" in cell:
                    candidate = True
                elif cell and isinstance(cell.get("v"), (int, float)):
                    candidate = True
                elif dv or st.get("unlocked"):
                    candidate = True
                elif cell and isinstance(cell.get("v"), str) and (label.endswith(":") or label.endswith("?")):
                    candidate = True
                if candidate:
                    kind = "output" if cell and "f" in cell else "input"
                    fields.append({"label": label.rstrip(":").strip(), "ref": W.col_letters(k) + str(r), "kind": kind, "row": r})
                    used.update([(r, c), (r, k)])
                    row_pairs += 1
                    break
                if cell and cell.get("v") not in (None, ""):
                    break
        if not row_pairs:
            texts = [sh.text(r, c) for c in cols if sh.text(r, c) and (r, c) not in used]
            if len(texts) == 1 and len(cols) <= 2:
                st = sh.style(sh.cell(r, cols[0]))
                if title is None and r <= 3 and (st.get("sz", 11) >= 13 or st.get("b")) and not fields:
                    title = texts[0]
                else:
                    headings.append({"text": texts[0], "row": r})
    if len(fields) < 2 or len(fields) > 60:  # more than that reads better as the sheet itself
        return None
    items = sorted([dict(f, t="field") for f in fields] + [dict(h, t="heading") for h in headings], key=lambda x: x["row"])
    # drop headings that are just notes between fields? keep them: they read as section titles
    return {"title": title, "items": [{k: v for k, v in it.items() if k != "row"} for it in items],
            "inputs": sum(1 for f in fields if f["kind"] == "input"), "outputs": sum(1 for f in fields if f["kind"] == "output")}


# --------------------------------------------------------------------------------------------- the app
def analyze(bp):
    styles = bp.get("styles") or []
    by_name = {s["name"]: s for s in bp["sheets"]}
    used_names = set(t["name"].lower() for t in bp["tables"]) | set(n["name"].lower() for n in bp.get("names", []))
    sheets = {s["name"]: Sheet(s, styles) for s in bp["sheets"]}

    # list-validation sources: sheets that only feed dropdowns are "Lists" (hidden by default)
    list_sources = Counter()
    for s in bp["sheets"]:
        for v in s.get("validations") or []:
            if v.get("type") == "list":
                m = re.match(r"^'?([^'!]+)'?!", v.get("f1") or "")
                if m and m.group(1) != s["name"]:
                    list_sources[m.group(1)] += 1
                nm = next((n for n in bp.get("names", []) if n["name"].lower() == (v.get("f1") or "").strip().lower()), None)
                if nm:
                    m2 = re.match(r"^'?([^'!]+)'?!", nm["ref"])
                    if m2 and m2.group(1) != s["name"]:
                        list_sources[m2.group(1)] += 1

    for t in bp["tables"]:
        sh = sheets.get(t["sheet"])
        if sh:
            infer_calc(sh, t)
    # pseudo tables on sheets without real ones
    for s in bp["sheets"]:
        if s["tables"]:
            continue
        sh = sheets[s["name"]]
        found = find_pseudo_table(sh, set())
        if not found:
            continue
        _, r, c1, r_last, c2 = found
        names, seen = [], Counter()
        for c in range(c1, c2 + 1):
            n = sh.text(r, c) or "Column %s" % W.col_letters(c)
            seen[n.lower()] += 1
            names.append(n if seen[n.lower()] == 1 else "%s %d" % (n, seen[n.lower()]))
        t = {"id": "t%d" % (len(bp["tables"]) + 1), "name": safe_table_name(s["name"], used_names), "sheet": s["name"],
             "ref": "%s%d:%s%d" % (W.col_letters(c1), r, W.col_letters(c2), r_last), "header": True, "totals": False,
             "columns": [{"name": n, "calc": None, "totalsFn": None, "totalsLabel": None, "totalsFormula": None} for n in names],
             "style": None, "pseudo": True}
        infer_calc(sh, t)
        bp["tables"].append(t)
        s["tables"].append(t["id"])
    for t in bp["tables"]:
        sh = sheets.get(t["sheet"])
        if not sh:
            continue
        for j, col in enumerate(t["columns"]):
            col["fmt"] = column_fmt(sh, t, j)

    screens, actions = [], []
    tables_by_id = {t["id"]: t for t in bp["tables"]}
    for s in bp["sheets"]:
        sh = sheets[s["name"]]
        hidden = s.get("state", "visible") != "visible"
        lookup_like = bool(re.search(r"^(lists?|lookups?|data ?validation|dropdowns?|settings|config|admin|ref(erence)?s?|params?)$", s["name"].strip(), re.I)) \
            or (list_sources[s["name"]] > 0 and not s["tables"] and not any(c.get("f") for c in s["cells"].values()))
        taken = set()
        sheet_tables = [tables_by_id[i] for i in s["tables"] if i in tables_by_id]
        for t in sheet_tables:
            r1, c1, r2, c2, first, last = table_region(t)
            for r in range(r1, r2 + 1):
                for c in range(c1, c2 + 1):
                    taken.add((r, c))
            cols = [column_type(sh, t, j, by_name) for j in range(len(t["columns"]))]
            for k, col in enumerate(cols):
                col["fmt"] = t["columns"][k].get("fmt")
            textish = [c["name"] for c in cols if c["type"] in ("text", "email", "longtext")]
            status = next((c["name"] for c in cols if c["type"] == "choice" and re.search(r"status|state|stage|progress|step", c["name"], re.I)), None)
            if not status:
                status = next((c["name"] for c in cols if c["type"] == "choice"), None)
            label = s["name"] if len(sheet_tables) == 1 else pretty(t["name"])
            screens.append({"id": "tb:" + t["name"], "kind": "table", "sheet": s["name"], "table": t["name"], "label": pretty(label),
                            "icon": icon_for(label + " " + t["name"], "table"), "hidden": hidden or lookup_like,
                            "columns": cols, "titleCol": textish[0] if textish else cols[0]["name"],
                            "subtitleCol": textish[1] if len(textish) > 1 else None, "statusCol": status, "rows": max(0, last - first + 1)})
        form = detect_form(sh, taken)
        if form:
            label = s["name"]
            screens.append({"id": "fm:" + s["name"], "kind": "form", "sheet": s["name"], "label": pretty(label),
                            "icon": icon_for(label, "form") if form["inputs"] else "chart",
                            "hidden": hidden, "form": form})
        elif not sheet_tables and s["cells"]:
            screens.append({"id": "gr:" + s["name"], "kind": "grid", "sheet": s["name"], "label": pretty(s["name"]),
                            "icon": icon_for(s["name"], "grid"), "hidden": hidden or lookup_like})
        for b in s.get("buttons") or []:
            actions.append({"macro": b["macro"], "label": b["caption"] or pretty(b["macro"]), "sheet": s["name"]})
    order = {"table": 0, "form": 1, "grid": 2}
    keep = []
    seen_ids = set()
    for sc in screens:
        if sc["id"] in seen_ids:
            continue
        seen_ids.add(sc["id"])
        keep.append(sc)
    # sheet order is what workbook authors chose: keep it among visible screens, apart from data entry first
    sheet_pos = {s["name"]: i for i, s in enumerate(bp["sheets"])}
    keep.sort(key=lambda x: (x["hidden"], sheet_pos.get(x["sheet"], 99), order[x["kind"]]))

    color = (bp.get("themeColor") or "").upper()
    if not re.match(r"^#[0-9A-F]{6}$", color) or color in DEFAULT_OFFICE:
        color = DEFAULT_COLOR
    else:
        r_, g_, b_ = (int(color[i:i + 2], 16) for i in (1, 3, 5))
        if 0.2126 * r_ + 0.7152 * g_ + 0.0722 * b_ > 200:  # too pale for buttons
            color = DEFAULT_COLOR
    bp["app"] = {"title": bp.get("title") or "My app", "color": color, "screens": keep, "actions": actions}

    formulas = funcs = 0
    fn_counts = Counter()
    for s in bp["sheets"]:
        for c in s["cells"].values():
            if "f" in c:
                formulas += 1
                for fn in re.findall(r"([A-Z][A-Z0-9.]*)\(", re.sub(r'"[^"]*"', "", c["f"].upper())):
                    fn_counts[fn] += 1
    for t in bp["tables"]:
        for col in t["columns"]:
            if col.get("calc"):
                formulas += 1
                for fn in re.findall(r"([A-Z][A-Z0-9.]*)\(", re.sub(r'"[^"]*"', "", col["calc"].upper())):
                    fn_counts[fn] += 1
    funcs = len(fn_counts)
    bp["stats"] = {
        "sheets": len(bp["sheets"]), "tables": sum(1 for t in bp["tables"] if not t.get("pseudo")),
        "lists": sum(1 for t in bp["tables"] if t.get("pseudo")), "rows": sum(sc.get("rows", 0) for sc in keep if sc["kind"] == "table"),
        "columns": sum(len(t["columns"]) for t in bp["tables"]), "formulas": formulas, "functions": dict(fn_counts.most_common(80)),
        "function_count": funcs, "rules": sum(len(s.get("validations") or []) for s in bp["sheets"]),
        "formats": sum(len(s.get("condFormats") or []) for s in bp["sheets"]), "modules": len(bp.get("vba") or []),
        "procedures": sum(len(re.findall(r"(?im)^\s*(?:public\s+|private\s+|friend\s+)?(?:static\s+)?(?:sub|function)\s+\w+", m["code"])) for m in bp.get("vba") or []),
        "buttons": len(actions), "screens": len(keep), "visible_screens": sum(1 for s in keep if not s["hidden"]),
    }
    return bp


def summary(bp):
    """The few numbers kept with each project (lists and admin)."""
    st = bp.get("stats") or {}
    return {k: st.get(k, 0) for k in ("sheets", "tables", "lists", "rows", "formulas", "rules", "formats", "procedures", "buttons", "screens")}
