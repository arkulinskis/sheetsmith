"""Read an Excel workbook (.xlsx / .xlsm) into a plain "blueprint" dict, with the standard library only.

    read_workbook(data: bytes, filename) -> blueprint (JSON-friendly)

What it keeps: every sheet's cells (value, formula, number format, a little styling), merged cells, column widths,
tables (ListObjects, with calculated columns and totals), data validation rules (both the classic and the
Excel 2010 "x14" kind), conditional formats with their colours, defined names, buttons and shapes that run a
macro, the theme's accent colour, and the VBA modules (VbaReader). Formulas are stored without the leading "=".
Big workbooks are cut down to the limits below, with a warning.
"""
import colorsys
import posixpath
import re
import zipfile
import io
import xml.etree.ElementTree as ET

from . import VbaReader

MAX_FILE = 12 * 1024 * 1024
MAX_ROWS, MAX_COLS, MAX_CELLS = 3000, 100, 40000
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main",
    "xm": "http://schemas.microsoft.com/office/excel/2006/main",
    "dc": "http://purl.org/dc/elements/1.1/",
}
M = "{%s}" % NS["m"]
R_ID = "{%s}id" % NS["r"]
BUILTIN_FMT = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?",
    13: "# ??/??", 14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
    20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
    39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 44: '_("$"* #,##0.00_)', 45: "mm:ss", 46: "[h]:mm:ss",
    47: "mmss.0", 48: "##0.0E+0", 49: "@",
}
OFFICE_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"]
INDEXED = {8: "000000", 9: "FFFFFF", 10: "FF0000", 11: "00FF00", 12: "0000FF", 13: "FFFF00", 14: "FF00FF", 15: "00FFFF",
           16: "800000", 17: "008000", 18: "000080", 19: "808000", 20: "800080", 21: "008080", 22: "C0C0C0", 23: "808080"}


class WorkbookError(Exception):
    pass


# --------------------------------------------------------------------------------------------- references
def col_index(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def col_letters(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


REF_RE = re.compile(r"^\$?([A-Za-z]{1,3})\$?(\d+)$")


def parse_ref(ref):
    m = REF_RE.match(ref.strip())
    if not m:
        return None
    return int(m.group(2)), col_index(m.group(1))


def parse_range(ref):
    """'A1:C5' -> (r1, c1, r2, c2); 'A1' -> (r, c, r, c); None if not a plain range."""
    parts = ref.replace("$", "").split(":")
    a = parse_ref(parts[0])
    b = parse_ref(parts[-1])
    if not a or not b:
        return None
    return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])


_TOKEN = re.compile(r'"(?:[^"]|"")*"|\'(?:[^\']|\'\')*\'!|\[[^\]]*\]|(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(.!\[])|[A-Za-z_][A-Za-z0-9_.]*', re.I)


def shift_formula(f, dr, dc):
    """Move the relative cell references in formula text by dr rows / dc columns (for shared formulas)."""
    if not dr and not dc:
        return f

    def rep(m):
        if m.group(4) is None:
            return m.group(0)
        start = m.start()
        if start > 0 and (f[start - 1].isalnum() or f[start - 1] in "_."):
            return m.group(0)
        c, r = col_index(m.group(2)), int(m.group(4))
        if not m.group(1):
            c += dc
        if not m.group(3):
            r += dr
        if c < 1 or r < 1:
            return "#REF!"
        return "%s%s%s%s" % (m.group(1), col_letters(c), m.group(3), r)
    return _TOKEN.sub(rep, f)


def clean_formula(f):
    f = (f or "").strip()
    if f.startswith("="):
        f = f[1:]
    return f.replace("_xlfn._xlws.", "").replace("_xlfn.", "").replace("_xlws.", "")


# --------------------------------------------------------------------------------------------- colours
def _tint(hexrgb, tint):
    if not tint:
        return hexrgb
    r, g, b = (int(hexrgb[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l * (1 + tint) if tint < 0 else l * (1 - tint) + tint
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), s)
    return "%02X%02X%02X" % (round(r * 255), round(g * 255), round(b * 255))


def color_of(el, theme):
    if el is None:
        return None
    rgb = el.get("rgb")
    if rgb:
        rgb = rgb[-6:].upper()
    elif el.get("theme") is not None:
        try:
            rgb = theme[int(el.get("theme"))]
        except (ValueError, IndexError):
            return None
    elif el.get("indexed") is not None:
        rgb = INDEXED.get(int(el.get("indexed")))
        if rgb is None:
            return None
    else:
        return None
    try:
        rgb = _tint(rgb, float(el.get("tint") or 0))
    except ValueError:
        pass
    return "#" + rgb


# --------------------------------------------------------------------------------------------- package helpers
class Package(object):
    def __init__(self, data):
        try:
            self.z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise WorkbookError("This isn't an .xlsx or .xlsm file. Old .xls files: open them in Excel and Save As .xlsm first.")
        self.names = set(self.z.namelist())

    def has(self, path):
        return path in self.names

    def read(self, path):
        info = self.z.getinfo(path)
        if info.file_size > 64 * 1024 * 1024:
            raise WorkbookError("A part of this workbook is too big to read.")
        return self.z.read(path)

    def xml(self, path):
        if not self.has(path):
            return None
        try:
            return ET.fromstring(self.read(path))
        except ET.ParseError:
            return None

    def rels(self, part):
        """{rId: (type, absolute target)} for a part."""
        d, base = posixpath.split(part)
        root = self.xml(posixpath.join(d, "_rels", base + ".rels"))
        out = {}
        if root is None:
            return out
        for rel in root.findall("{%s}Relationship" % NS["rel"]):
            target = rel.get("Target") or ""
            if rel.get("TargetMode") == "External":
                continue
            path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(d, target))
            out[rel.get("Id")] = ((rel.get("Type") or "").rsplit("/", 1)[-1], path)
        return out


def _text(el):
    """All text inside a shared-string / inline-string item (plain or rich runs, no phonetic runs)."""
    if el is None:
        return ""
    out = []
    for node in el.iter():
        tag = node.tag.split("}")[-1]
        if tag == "rPh":
            continue
        if tag == "t" and node.text:
            out.append(node.text)
    return "".join(out)


# --------------------------------------------------------------------------------------------- styles
def read_styles(pkg, theme):
    root = pkg.xml("xl/styles.xml")
    fmts = dict(BUILTIN_FMT)
    xfs, dxfs = [], []
    if root is None:
        return xfs, dxfs
    for nf in root.findall("m:numFmts/m:numFmt", NS):
        try:
            fmts[int(nf.get("numFmtId"))] = nf.get("formatCode") or "General"
        except (TypeError, ValueError):
            pass
    fonts = []
    for f in root.findall("m:fonts/m:font", NS):
        sz = f.find("m:sz", NS)
        fonts.append({"b": f.find("m:b", NS) is not None and f.find("m:b", NS).get("val") not in ("0", "false"),
                      "i": f.find("m:i", NS) is not None and f.find("m:i", NS).get("val") not in ("0", "false"),
                      "sz": float(sz.get("val")) if sz is not None and sz.get("val") else 11,
                      "color": color_of(f.find("m:color", NS), theme)})
    fills = []
    for fl in root.findall("m:fills/m:fill", NS):
        pf = fl.find("m:patternFill", NS)
        c = None
        if pf is not None and pf.get("patternType") not in (None, "none", "gray125"):
            c = color_of(pf.find("m:fgColor", NS), theme)
        fills.append(c)
    for xf in root.findall("m:cellXfs/m:xf", NS):
        st = {}
        try:
            fid = int(xf.get("numFmtId") or 0)
        except ValueError:
            fid = 0
        code = fmts.get(fid, "General")
        if code != "General":
            st["z"] = code
        try:
            font = fonts[int(xf.get("fontId") or 0)]
        except (ValueError, IndexError):
            font = None
        if font:
            if font["b"]:
                st["b"] = 1
            if font["i"]:
                st["i"] = 1
            if font["sz"] >= 13:
                st["sz"] = font["sz"]
            if font["color"] and font["color"] not in ("#000000",):
                st["color"] = font["color"]
        try:
            fill = fills[int(xf.get("fillId") or 0)]
        except (ValueError, IndexError):
            fill = None
        if fill and fill.upper() != "#FFFFFF":
            st["fill"] = fill
        al = xf.find("m:alignment", NS)
        if al is not None:
            if al.get("horizontal") in ("center", "right", "left"):
                st["al"] = al.get("horizontal")
            if al.get("wrapText") in ("1", "true"):
                st["wrap"] = 1
        prot = xf.find("m:protection", NS)
        if prot is not None and prot.get("locked") in ("0", "false"):
            st["unlocked"] = 1
        xfs.append(st)
    for d in root.findall("m:dxfs/m:dxf", NS):
        st = {}
        f = d.find("m:font", NS)
        if f is not None:
            if f.find("m:b", NS) is not None:
                st["bold"] = True
            if f.find("m:strike", NS) is not None:
                st["strike"] = True
            c = color_of(f.find("m:color", NS), theme)
            if c:
                st["color"] = c
        pf = d.find("m:fill/m:patternFill", NS)
        if pf is not None:
            c = color_of(pf.find("m:bgColor", NS), theme) or color_of(pf.find("m:fgColor", NS), theme)
            if c:
                st["fill"] = c
        dxfs.append(st)
    return xfs, dxfs


def read_theme(pkg):
    root = pkg.xml("xl/theme/theme1.xml")
    colors = list(OFFICE_THEME)
    if root is None:
        return colors
    scheme = root.find(".//a:clrScheme", NS)
    if scheme is None:
        return colors
    order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"]
    for i, name in enumerate(order):
        el = scheme.find("a:" + name, NS)
        if el is None:
            continue
        srgb, sys_ = el.find("a:srgbClr", NS), el.find("a:sysClr", NS)
        if srgb is not None and srgb.get("val"):
            colors[i] = srgb.get("val").upper()
        elif sys_ is not None and sys_.get("lastClr"):
            colors[i] = sys_.get("lastClr").upper()
    # Excel's theme index order swaps the first pairs: 0 lt1, 1 dk1, 2 lt2, 3 dk2
    return colors


# --------------------------------------------------------------------------------------------- sheets
def _num(s):
    try:
        f = float(s)
    except (TypeError, ValueError):
        return s
    if f.is_integer() and abs(f) < 1e15:
        return int(f)
    return f


def _split_sheet(raw):
    """(the sheet without its cell data, the <sheetData> part): the cells are streamed so huge sheets stop early."""
    a = raw.find(b"<sheetData")
    if a < 0:
        return raw, None
    if raw[a:a + 40].find(b"/>") >= 0 and raw.find(b"</sheetData>", a) < 0:
        return raw, None
    b = raw.find(b"</sheetData>", a)
    if b < 0:
        return raw, None
    b += len(b"</sheetData>")
    return raw[:a] + raw[b:], raw[a:b]


def _iter_cells(part, ns_decl):
    """(row element events) from the <sheetData> bytes, as complete <row> elements."""
    doc = b"<sheetData " + ns_decl + part[len(b"<sheetData"):]
    for event, el in ET.iterparse(io.BytesIO(doc), events=("end",)):
        if el.tag == M + "row":
            yield el
            el.clear()


def read_sheet(pkg, path, strings, xfs, dxfs, theme, warnings, budget):
    raw = pkg.read(path) if pkg.has(path) else b""
    outer, data_part = _split_sheet(raw)
    try:
        root = ET.fromstring(outer) if outer else None
    except ET.ParseError:
        root = None
    sheet = {"cells": {}, "merges": [], "colWidths": {}, "validations": [], "condFormats": [], "buttons": [],
             "rows": 0, "cols": 0, "code": None, "tabColor": None}
    if root is None:
        warnings.append("A sheet (%s) couldn't be read." % path)
        return sheet
    root_tag = re.search(rb"<(?:\w+:)?worksheet\b[^>]*>", raw[:4000])
    decls = b" ".join(re.findall(rb'xmlns(?::\w+)?="[^"]*"', root_tag.group(0))) if root_tag else b'xmlns="%s"' % NS["m"].encode()
    if b'xmlns="' not in decls:
        decls += b' xmlns="' + NS["m"].encode() + b'"'
    rows_iter = root.iter(M + "row")
    if data_part:
        try:  # check the namespace declarations work before streaming; else parse the whole sheet
            ET.fromstring(b"<sheetData " + decls + b"/>")
            rows_iter = _iter_cells(data_part, decls)
        except ET.ParseError:
            rows_iter = ET.fromstring(raw).iter(M + "row")
    pr = root.find("m:sheetPr", NS)
    if pr is not None:
        sheet["code"] = pr.get("codeName")
        tc = pr.find("m:tabColor", NS)
        sheet["tabColor"] = color_of(tc, theme)
    for col in root.findall("m:cols/m:col", NS):
        try:
            lo, hi, w = int(col.get("min")), int(col.get("max")), float(col.get("width") or 0)
        except (TypeError, ValueError):
            continue
        hidden = col.get("hidden") in ("1", "true")
        for c in range(lo, min(hi, MAX_COLS) + 1):
            sheet["colWidths"][col_letters(c)] = 0 if hidden else round(w, 1)
    shared = {}
    cut_rows = cut_cols = False
    cells = sheet["cells"]
    stop = False
    for row in rows_iter:
        try:
            if int(row.get("r") or 0) > MAX_ROWS:
                cut_rows = True
                break
        except ValueError:
            pass
        for c in row.findall(M + "c"):
            ref = c.get("r")
            pos = parse_ref(ref) if ref else None
            if not pos:
                continue
            r, ci = pos
            if r > MAX_ROWS:
                cut_rows = True
                continue
            if ci > MAX_COLS:
                cut_cols = True
                continue
            t = c.get("t") or "n"
            v_el, f_el = c.find(M + "v"), c.find(M + "f")
            cell = {}
            if f_el is not None:
                ftext = f_el.text or ""
                if f_el.get("t") == "shared" and f_el.get("si") is not None:
                    si = f_el.get("si")
                    if ftext.strip():
                        shared[si] = (r, ci, ftext)
                    elif si in shared:
                        r0, c0, base = shared[si]
                        ftext = shift_formula(base, r - r0, ci - c0)
                if ftext.strip():
                    cell["f"] = clean_formula(ftext)
            val = None
            if t == "s" and v_el is not None:
                try:
                    val = strings[int(v_el.text)]
                except (TypeError, ValueError, IndexError):
                    val = ""
            elif t == "inlineStr":
                val = _text(c.find(M + "is"))
            elif t == "b" and v_el is not None:
                val = v_el.text in ("1", "true")
            elif t == "e" and v_el is not None:
                val = v_el.text
                cell["t"] = "e"
            elif t == "str" and v_el is not None:
                val = v_el.text or ""
            elif v_el is not None and v_el.text is not None:
                val = _num(v_el.text)
            if val is not None and val != "":
                cell["v"] = val
            try:
                sid, st = xfs[int(c.get("s") or 0)]
            except (ValueError, IndexError):
                sid, st = None, {}
            if sid is not None:
                cell["s"] = sid
            if "v" not in cell and "f" not in cell and not ("unlocked" in st and r <= 300 and ci <= 30):
                continue
            if budget[0] <= 0:
                cut_rows = stop = True
                break
            budget[0] -= 1
            cells[ref.upper().replace("$", "")] = cell
            sheet["rows"] = max(sheet["rows"], r)
            sheet["cols"] = max(sheet["cols"], ci)
        if stop:
            break
    if cut_rows:
        warnings.append("Only the first %d rows of each sheet were read (and %d cells in all)." % (MAX_ROWS, MAX_CELLS))
    if cut_cols:
        warnings.append("Only the first %d columns of each sheet were read." % MAX_COLS)
    for mc in root.findall("m:mergeCells/m:mergeCell", NS):
        if mc.get("ref"):
            sheet["merges"].append(mc.get("ref"))

    def validation(dv, f1, f2, sqref):
        return {"sqref": sqref.split(), "type": dv.get("type") or "any", "op": dv.get("operator") or "between",
                "f1": clean_formula(f1), "f2": clean_formula(f2), "allowBlank": dv.get("allowBlank") in ("1", "true"),
                "prompt": dv.get("prompt") or "", "promptTitle": dv.get("promptTitle") or "",
                "error": dv.get("error") or "", "errorTitle": dv.get("errorTitle") or "",
                "errorStyle": dv.get("errorStyle") or "stop", "dropdown": dv.get("showDropDown") not in ("1", "true")}
    for dv in root.findall("m:dataValidations/m:dataValidation", NS):
        f1, f2 = dv.find("m:formula1", NS), dv.find("m:formula2", NS)
        if dv.get("sqref"):
            sheet["validations"].append(validation(dv, f1.text if f1 is not None else "", f2.text if f2 is not None else "", dv.get("sqref")))
    for dv in root.iter("{%s}dataValidation" % NS["x14"]):
        f1 = dv.find("x14:formula1/xm:f", NS)
        f2 = dv.find("x14:formula2/xm:f", NS)
        sq = dv.find("xm:sqref", NS)
        if sq is not None and sq.text:
            sheet["validations"].append(validation(dv, f1.text if f1 is not None else "", f2.text if f2 is not None else "", sq.text))
    for cf in root.findall("m:conditionalFormatting", NS):
        rules = []
        for rule in cf.findall("m:cfRule", NS):
            try:
                style = dxfs[int(rule.get("dxfId"))] if rule.get("dxfId") is not None else {}
            except (ValueError, IndexError):
                style = {}
            item = {"type": rule.get("type") or "", "op": rule.get("operator") or "", "style": style,
                    "formulas": [clean_formula(x.text or "") for x in rule.findall("m:formula", NS)],
                    "priority": int(rule.get("priority") or 99), "stop": rule.get("stopIfTrue") in ("1", "true"),
                    "text": rule.get("text") or ""}
            if item["type"] == "colorScale":
                item["colors"] = [color_of(x, theme) for x in rule.findall("m:colorScale/m:color", NS)]
            if item["type"] == "dataBar":
                item["colors"] = [color_of(rule.find("m:dataBar/m:color", NS), theme)]
            rules.append(item)
        if cf.get("sqref") and rules:
            sheet["condFormats"].append({"sqref": cf.get("sqref").split(), "rules": rules})
    sheet["_root"] = root
    return sheet


def _macro_name(ref):
    ref = (ref or "").strip().strip("'")
    if "!" in ref:
        ref = ref.rsplit("!", 1)[1]
    if "." in ref:
        ref = ref.rsplit(".", 1)[1]
    return ref.strip("'\" ")


def read_buttons(pkg, sheet_path, root):
    """Form-control buttons (VML) and shapes (DrawingML) that have a macro assigned."""
    out = []
    rels = pkg.rels(sheet_path)
    targets = []
    for tag in ("legacyDrawing", "drawing"):
        for el in root.findall("m:" + tag, NS):
            rid = el.get(R_ID)
            if rid in rels:
                targets.append(rels[rid][1])
    for target in targets:
        if not pkg.has(target):
            continue
        raw = pkg.read(target).decode("utf-8", "replace")
        if target.endswith(".vml"):
            for shape in re.findall(r"<v:shape\b.*?</v:shape>", raw, re.S | re.I):
                macro = re.search(r"<x:FmlaMacro>(.*?)</x:FmlaMacro>", shape, re.S | re.I)
                if not macro:
                    continue
                box = re.search(r"<v:textbox\b.*?>(.*?)</v:textbox>", shape, re.S | re.I)
                caption = re.sub(r"<[^>]+>", " ", box.group(1)) if box else ""
                caption = re.sub(r"\s+", " ", caption.replace("&amp;", "&").replace("&nbsp;", " ")).strip()
                anchor = re.search(r"<x:Anchor>(.*?)</x:Anchor>", shape, re.S | re.I)
                col = row = 0
                if anchor:
                    nums = [int(x) for x in re.findall(r"\d+", anchor.group(1))]
                    if len(nums) >= 4:
                        col, row = nums[0] + 1, nums[2] + 1
                out.append({"caption": caption, "macro": _macro_name(macro.group(1)), "row": row, "col": col})
        else:
            for anchor in re.findall(r"<xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b.*?</xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)>", raw, re.S):
                macro = re.search(r'\smacro="([^"]+)"', anchor)
                if not macro:
                    continue
                texts = re.findall(r"<a:t>(.*?)</a:t>", anchor, re.S)
                frm = re.search(r"<xdr:from>\s*<xdr:col>(\d+)</xdr:col>.*?<xdr:row>(\d+)</xdr:row>", anchor, re.S)
                out.append({"caption": " ".join(t.strip() for t in texts).replace("&amp;", "&").strip(),
                            "macro": _macro_name(macro.group(1)),
                            "row": int(frm.group(2)) + 1 if frm else 0, "col": int(frm.group(1)) + 1 if frm else 0})
    return [b for b in out if b["macro"]]


def read_table(pkg, path, sheet_name, tid):
    root = pkg.xml(path)
    if root is None:
        return None
    cols = []
    for tc in root.findall("m:tableColumns/m:tableColumn", NS):
        calc = tc.find("m:calculatedColumnFormula", NS)
        tot = tc.find("m:totalsRowFormula", NS)
        cols.append({"name": tc.get("name") or "Column", "calc": clean_formula(calc.text) if calc is not None and calc.text else None,
                     "totalsFn": tc.get("totalsRowFunction") or None, "totalsLabel": tc.get("totalsRowLabel") or None,
                     "totalsFormula": clean_formula(tot.text) if tot is not None and tot.text else None})
    style = root.find("m:tableStyleInfo", NS)
    return {"id": tid, "name": root.get("displayName") or root.get("name") or tid, "sheet": sheet_name, "ref": root.get("ref") or "A1",
            "header": root.get("headerRowCount") != "0", "totals": int(root.get("totalsRowCount") or 0) > 0,
            "columns": cols, "style": style.get("name") if style is not None else None, "pseudo": False}


# --------------------------------------------------------------------------------------------- the workbook
def read_workbook(data, filename="Workbook.xlsx"):
    if len(data) > MAX_FILE:
        raise WorkbookError("That file is bigger than %d MB. Try a copy with less data in it." % (MAX_FILE // (1024 * 1024)))
    pkg = Package(data)
    wb_path = "xl/workbook.xml"
    root_rels = pkg.rels("")
    for typ, target in root_rels.values():
        if typ == "officeDocument":
            wb_path = target
    wb = pkg.xml(wb_path)
    if wb is None:
        raise WorkbookError("This file doesn't look like an Excel workbook (no workbook part inside).")
    warnings = []
    theme = read_theme(pkg)
    raw_xfs, dxfs = read_styles(pkg, theme)
    styles, seen, xfs = [], {}, []  # each distinct cell style once; cells point at it with "s"
    for st in raw_xfs:
        if not st:
            xfs.append((None, st))
            continue
        key = tuple(sorted(st.items()))
        if key not in seen:
            seen[key] = len(styles)
            styles.append(st)
        xfs.append((seen[key], st))
    strings = []
    wb_rels = pkg.rels(wb_path)
    ss_path = next((t for typ, t in wb_rels.values() if typ == "sharedStrings"), "xl/sharedStrings.xml")
    ss = pkg.xml(ss_path)
    if ss is not None:
        strings = [_text(si) for si in ss.findall("m:si", NS)]
    wbpr = wb.find("m:workbookPr", NS)
    wb_code = (wbpr.get("codeName") if wbpr is not None else None) or "ThisWorkbook"
    sheets, tables, budget = [], [], [MAX_CELLS]
    for i, sh in enumerate(wb.findall("m:sheets/m:sheet", NS)):
        rid = sh.get(R_ID)
        typ, path = wb_rels.get(rid, ("", ""))
        name = sh.get("name") or "Sheet%d" % (i + 1)
        if typ != "worksheet":
            if typ:
                warnings.append("'%s' is a %s, not a worksheet, so it was left out." % (name, typ.replace("sheet", " sheet")))
            continue
        s = read_sheet(pkg, path, strings, xfs, dxfs, theme, warnings, budget)
        s.update({"id": "s%d" % (len(sheets) + 1), "name": name, "state": sh.get("state") or "visible", "tables": []})
        root = s.pop("_root", None)
        if root is not None:
            srels = pkg.rels(path)
            for tp in root.findall("m:tableParts/m:tablePart", NS):
                rel = srels.get(tp.get(R_ID))
                if rel and rel[0] == "table":
                    t = read_table(pkg, rel[1], name, "t%d" % (len(tables) + 1))
                    if t:
                        tables.append(t)
                        s["tables"].append(t["id"])
            try:
                s["buttons"] = read_buttons(pkg, path, root)
            except Exception:
                warnings.append("The buttons on '%s' couldn't be read." % name)
        sheets.append(s)
    if not sheets:
        raise WorkbookError("This workbook has no worksheets.")
    names = []
    for dn in wb.findall("m:definedNames/m:definedName", NS):
        nm = dn.get("name") or ""
        if not nm or nm.startswith("_xlnm.") or dn.get("hidden") in ("1", "true"):
            continue
        scope = None
        if dn.get("localSheetId") is not None:
            try:
                scope = sheets[int(dn.get("localSheetId"))]["name"]
            except (ValueError, IndexError):
                scope = None
        names.append({"name": nm, "ref": clean_formula(dn.text or ""), "scope": scope})
    title = None
    core = pkg.xml("docProps/core.xml")
    if core is not None:
        t = core.find("dc:title", NS)
        title = t.text.strip() if t is not None and t.text and t.text.strip() else None
    base = re.sub(r"\.(xlsx|xlsm|xltx|xltm)$", "", filename or "Workbook", flags=re.I)
    vba = []
    vba_path = next((t for typ, t in wb_rels.values() if typ == "vbaProject"), "xl/vbaProject.bin")
    if pkg.has(vba_path):
        try:
            vba = VbaReader.read_modules(pkg.read(vba_path))
        except VbaReader.VbaError as e:
            warnings.append("The macros couldn't be read (%s)." % e)
        except Exception:
            warnings.append("The macros couldn't be read.")
    by_code = {s["code"]: s["name"] for s in sheets if s.get("code")}
    for m in vba:
        if m["kind"] == "document":
            if m["name"] == wb_code:
                m["sheet"] = None
                m["workbook"] = True
            else:
                m["sheet"] = by_code.get(m["name"])
    if any(f.endswith(".bin") and "activeX" in f for f in pkg.names):
        warnings.append("ActiveX controls on the sheets aren't converted (their code is shown with the macros).")
    if any(m["kind"] == "form" for m in vba):
        warnings.append("UserForms aren't converted into screens yet; their code is listed with the macros.")
    if pkg.has("xl/externalLinks/externalLink1.xml") or any(n.startswith("xl/externalLinks/") for n in pkg.names):
        warnings.append("This workbook links to other workbooks. Those links can't be followed in the app.")
    if any(n.startswith("xl/pivotTables/") for n in pkg.names):
        warnings.append("Pivot tables are kept as plain values (they won't refresh in the app).")
    if any(n.startswith("xl/charts/") for n in pkg.names):
        warnings.append("Charts aren't converted yet.")
    return {
        "version": 1,
        "file": {"name": filename, "size": len(data), "macros": bool(vba)},
        "title": title or prettify(base),
        "themeColor": "#" + theme[4],
        "workbookCode": wb_code,
        "styles": styles,
        "sheets": sheets,
        "tables": tables,
        "names": names,
        "vba": vba,
        "warnings": sorted(set(warnings), key=warnings.index),
    }


def prettify(base):
    s = re.sub(r"[_]+", " ", base).strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\b(v|ver|version)\s?\d+(\.\d+)*$", "", s, flags=re.I).strip(" -")
    return s[:80] or "My app"
