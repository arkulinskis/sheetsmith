"""The example workbooks (all fictional), written as real .xlsm files so they go through the same reader as uploads.

    BOOKS: key -> (file name, builder);  build(key) -> bytes;  build_xlsx(spec) -> bytes (a small .xlsx/.xlsm writer)

Dates are made relative to today, so the examples always look current (orders due tomorrow, a loan overdue...).
The VBA part is written by VbaReader.write_project: our reader understands it, Excel itself would not (no p-code).
"""
import datetime as dt
import io
import re
import zipfile
from xml.sax.saxutils import escape

from . import VbaReader
from . import WorkbookReader as W

# cell styles (index into cellXfs below)
ST = {"": 0, "bold": 1, "date": 2, "money": 3, "pct": 4, "title": 5, "input": 6, "datetime": 7, "head": 8, "int": 9, "note": 10, "big": 11, "moneybig": 12, "inputpct": 13, "inputmoney": 14}
STYLES_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="d mmm yyyy"/><numFmt numFmtId="166" formatCode="d mmm yyyy h:mm"/></numFmts>
<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF14211B"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF5F6B64"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF6D8"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3EFE7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="15">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyProtection="1"><protection locked="0"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1" applyProtection="1"><protection locked="0"/></xf>
<xf numFmtId="164" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1" applyProtection="1"><protection locked="0"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="4">
<dxf><font><color rgb="FF006100"/></font><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf>
<dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF9C5700"/></font><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf>
<dxf><font><strike/><color rgb="FF808080"/></font></dxf>
</dxfs>
</styleSheet>"""
DXF = {"good": 0, "bad": 1, "warn": 2, "muted": 3}


def serial(d):
    if isinstance(d, dt.datetime):
        return (d - dt.datetime(1899, 12, 30)).total_seconds() / 86400.0
    return (d - dt.date(1899, 12, 30)).days


def _x(s):
    return escape(str(s), {'"': "&quot;"})


def build_xlsx(spec):
    """spec: {title, sheets: [{name, code, cells: {A1: value | "=formula"}, styles: {A1: style}, widths, validations,
    cf, tables: [{name, ref, columns, calc: {col: formula}, totals: {col: fn | "label:Text"}}], buttons}], names, vba}"""
    out = io.BytesIO()
    z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    macro = bool(spec.get("vba"))
    strings, sidx = [], {}

    def sst(s):
        if s not in sidx:
            sidx[s] = len(strings)
            strings.append(s)
        return sidx[s]

    ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
          '<Default Extension="xml" ContentType="application/xml"/>',
          '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>',
          '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' if macro else "",
          '<Override PartName="/xl/workbook.xml" ContentType="%s"/>' % (
              "application/vnd.ms-excel.sheet.macroEnabled.main+xml" if macro else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>']
    wb_rels = []
    sheets_xml = []
    table_no = 0
    vml_no = 0
    for i, sh in enumerate(spec["sheets"]):
        n = i + 1
        rels = []
        cells = sh.get("cells", {})
        styles = sh.get("styles", {})
        rows = {}
        for ref in set(cells) | set(styles):
            p = W.parse_ref(ref)
            rows.setdefault(p[0], []).append((p[1], ref))
        body = []
        for r in sorted(rows):
            cs = []
            for c, ref in sorted(rows[r]):
                v = cells.get(ref)
                s = ST[styles.get(ref, "")]
                sa = ' s="%d"' % s if s else ""
                if v is None:
                    cs.append('<c r="%s"%s/>' % (ref, sa))
                elif isinstance(v, str) and v.startswith("="):
                    cs.append('<c r="%s"%s><f>%s</f></c>' % (ref, sa, _x(v[1:])))
                elif isinstance(v, bool):
                    cs.append('<c r="%s"%s t="b"><v>%d</v></c>' % (ref, sa, 1 if v else 0))
                elif isinstance(v, (int, float)):
                    cs.append('<c r="%s"%s><v>%s</v></c>' % (ref, sa, repr(v) if isinstance(v, float) else v))
                elif isinstance(v, (dt.date, dt.datetime)):
                    cs.append('<c r="%s"%s><v>%s</v></c>' % (ref, sa, serial(v)))
                else:
                    cs.append('<c r="%s"%s t="s"><v>%d</v></c>' % (ref, sa, sst(str(v))))
            body.append('<row r="%d">%s</row>' % (r, "".join(cs)))
        cols = ""
        if sh.get("widths"):
            cols = "<cols>" + "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (W.col_index(k), W.col_index(k), w) for k, w in sorted(sh["widths"].items(), key=lambda x: W.col_index(x[0]))) + "</cols>"
        dv = ""
        if sh.get("validations"):
            items = []
            for v in sh["validations"]:
                attrs = 'type="%s" allowBlank="%d" showInputMessage="1" showErrorMessage="1" sqref="%s"' % (v["type"], 1 if v.get("blank", True) else 0, v["sqref"])
                if v.get("op"):
                    attrs += ' operator="%s"' % v["op"]
                for k in ("prompt", "promptTitle", "error", "errorTitle"):
                    if v.get(k):
                        attrs += ' %s="%s"' % (k, _x(v[k]))
                if v.get("style"):
                    attrs += ' errorStyle="%s"' % v["style"]
                f = "<formula1>%s</formula1>" % _x(v["f1"])
                if v.get("f2") is not None:
                    f += "<formula2>%s</formula2>" % _x(v["f2"])
                items.append("<dataValidation %s>%s</dataValidation>" % (attrs, f))
            dv = '<dataValidations count="%d">%s</dataValidations>' % (len(items), "".join(items))
        cf = ""
        prio = 1
        for rule in sh.get("cf", []):
            if rule["type"] == "expression":
                inner = '<cfRule type="expression" dxfId="%d" priority="%d"><formula>%s</formula></cfRule>' % (DXF[rule["style"]], prio, _x(rule["f"]))
            else:
                inner = '<cfRule type="cellIs" dxfId="%d" priority="%d" operator="%s"><formula>%s</formula></cfRule>' % (DXF[rule["style"]], prio, rule["op"], _x(rule["f"]))
            prio += 1
            cf += '<conditionalFormatting sqref="%s">%s</conditionalFormatting>' % (rule["sqref"], inner)
        tparts = ""
        if sh.get("tables"):
            tps = []
            for t in sh["tables"]:
                table_no += 1
                rid = "rIdT%d" % table_no
                rels.append('<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table%d.xml"/>' % (rid, table_no))
                tps.append('<tablePart r:id="%s"/>' % rid)
                totals = t.get("totals") or {}
                tcols = []
                for j, cname in enumerate(t["columns"]):
                    a = ""
                    tot = totals.get(cname)
                    if tot and tot.startswith("label:"):
                        a += ' totalsRowLabel="%s"' % _x(tot[6:])
                    elif tot:
                        a += ' totalsRowFunction="%s"' % tot
                    calc = (t.get("calc") or {}).get(cname)
                    inner = "<calculatedColumnFormula>%s</calculatedColumnFormula>" % _x(calc) if calc else ""
                    tcols.append('<tableColumn id="%d" name="%s"%s>%s</tableColumn>' % (j + 1, _x(cname), a, inner))
                z.writestr("xl/tables/table%d.xml" % table_no,
                           '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                           '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="%d" name="%s" displayName="%s" ref="%s"%s>'
                           '<autoFilter ref="%s"/><tableColumns count="%d">%s</tableColumns>'
                           '<tableStyleInfo name="TableStyleMedium7" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>'
                           % (table_no, t["name"], t["name"], t["ref"], ' totalsRowCount="1"' if totals else "",
                              re.sub(r"\d+$", lambda m: str(int(m.group(0)) - (1 if totals else 0)), t["ref"]), len(tcols), "".join(tcols)))
                ct.append('<Override PartName="/xl/tables/table%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' % table_no)
            tparts = '<tableParts count="%d">%s</tableParts>' % (len(tps), "".join(tps))
        legacy = ""
        if sh.get("buttons"):
            vml_no += 1
            rels.append('<Relationship Id="rIdV" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing%d.vml"/>' % vml_no)
            legacy = '<legacyDrawing r:id="rIdV"/>'
            shapes = []
            for k, b in enumerate(sh["buttons"]):
                col, row = b["col"] - 1, b["row"] - 1
                shapes.append(
                    '<v:shape id="_x0000_s%d" type="#_x0000_t201" style="position:absolute;width:110pt;height:24pt">'
                    '<v:textbox><div style="text-align:center"><font face="Calibri" size="220" color="#000000">%s</font></div></v:textbox>'
                    '<x:ClientData ObjectType="Button"><x:Anchor>%d, 4, %d, 2, %d, 60, %d, 18</x:Anchor><x:PrintObject>False</x:PrintObject>'
                    '<x:AutoFill>False</x:AutoFill><x:FmlaMacro>[0]!%s</x:FmlaMacro><x:TextHAlign>Center</x:TextHAlign><x:TextVAlign>Center</x:TextVAlign></x:ClientData></v:shape>'
                    % (1025 + k, _x(b["caption"]), col, row, col + 2, row + 1, b["macro"]))
            z.writestr("xl/drawings/vmlDrawing%d.vml" % vml_no,
                       '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">'
                       + "".join(shapes) + "</xml>")
        code = ' codeName="%s"' % sh["code"] if sh.get("code") else ""
        xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
               '<sheetPr%s/>%s<sheetData>%s</sheetData>%s%s%s%s</worksheet>' % (code, cols, "".join(body), cf, dv, legacy, tparts))
        # Excel wants this order: sheetData, conditionalFormatting, dataValidations, legacyDrawing, tableParts (close enough for our reader)
        z.writestr("xl/worksheets/sheet%d.xml" % n, xml)
        ct.append('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % n)
        if rels:
            z.writestr("xl/worksheets/_rels/sheet%d.xml.rels" % n,
                       '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                       + "".join(rels) + "</Relationships>")
        wb_rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (n, n))
        sheets_xml.append('<sheet name="%s" sheetId="%d"%s r:id="rId%d"/>' % (_x(sh["name"]), n, ' state="hidden"' if sh.get("hidden") else "", n))
    k = len(spec["sheets"])
    wb_rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' % (k + 1))
    wb_rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' % (k + 2))
    if macro:
        wb_rels.append('<Relationship Id="rId%d" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>' % (k + 3))
        mods = [dict(m) for m in spec["vba"]]
        z.writestr("xl/vbaProject.bin", VbaReader.write_project(mods))
    names = "".join('<definedName name="%s">%s</definedName>' % (_x(nm), _x(ref)) for nm, ref in spec.get("names", []))
    z.writestr("xl/workbook.xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
               '<workbookPr codeName="ThisWorkbook"/><sheets>%s</sheets>%s</workbook>' % ("".join(sheets_xml), "<definedNames>%s</definedNames>" % names if names else ""))
    z.writestr("xl/_rels/workbook.xml.rels",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + "".join(wb_rels) + "</Relationships>")
    z.writestr("xl/styles.xml", STYLES_XML)
    z.writestr("xl/sharedStrings.xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">%s</sst>'
               % (len(strings), len(strings), "".join('<si><t xml:space="preserve">%s</t></si>' % _x(s) for s in strings)))
    z.writestr("_rels/.rels",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
               '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
    z.writestr("docProps/core.xml",
               '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
               'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>%s</dc:title><dc:creator>Sheetsmith examples</dc:creator></cp:coreProperties>' % _x(spec.get("title", "")))
    ct.append("</Types>")
    z.writestr("[Content_Types].xml", "".join(ct))
    z.close()
    return out.getvalue()


def _rows(sheet, top, columns, data, styles):
    """Write a header row at `top` and data rows below; styles: per column name."""
    cells, st = sheet.setdefault("cells", {}), sheet.setdefault("styles", {})
    for j, name in enumerate(columns):
        cells["%s%d" % (W.col_letters(j + 1), top)] = name
        st["%s%d" % (W.col_letters(j + 1), top)] = "head"
    for i, row in enumerate(data):
        for j, v in enumerate(row):
            ref = "%s%d" % (W.col_letters(j + 1), top + 1 + i)
            if v is not None:
                cells[ref] = v
            if styles.get(columns[j]):
                st[ref] = styles[columns[j]]


# --------------------------------------------------------------------------------------------- Juniper Bakery
BAKERY_VBA = '''Option Explicit
' Juniper Bakery order book (a fictional example for Sheetsmith)

Sub NewOrder()
    Dim who As String, tbl As ListObject, r As ListRow, nextNo As Long
    who = InputBox("Who is the order for?", "New order")
    If Trim(who) = "" Then Exit Sub
    Set tbl = Sheets("Orders").ListObjects("Orders")
    nextNo = Application.WorksheetFunction.Max(tbl.ListColumns("Order #").DataBodyRange) + 1
    Set r = tbl.ListRows.Add
    With r.Range
        .Cells(1, 1).Value = nextNo
        .Cells(1, 2).Value = Date
        .Cells(1, 3).Value = Trim(who)
        .Cells(1, 6).Value = 1
        .Cells(1, 9).Value = Date + 1
        .Cells(1, 10).Value = "New"
    End With
    MsgBox "Order #" & nextNo & " for " & Trim(who) & " was added." & vbCrLf & "Pick the item and the quantity in the list.", vbInformation, "Juniper Bakery"
End Sub

Sub MarkBakingReady()
    Dim tbl As ListObject, i As Long, n As Long
    Set tbl = Sheets("Orders").ListObjects("Orders")
    For i = 1 To tbl.ListRows.Count
        If tbl.ListRows(i).Range.Cells(1, 10).Value = "Baking" Then
            tbl.ListRows(i).Range.Cells(1, 10).Value = "Ready"
            n = n + 1
        End If
    Next i
    If n = 0 Then
        MsgBox "Nothing is in the oven right now.", vbInformation, "Juniper Bakery"
    Else
        MsgBox n & " order(s) marked Ready. Time to call the customers!", vbInformation, "Juniper Bakery"
    End If
End Sub

Sub ArchiveDelivered()
    Dim src As ListObject, dst As ListObject, i As Long, moved As Long, row As ListRow
    Set src = Sheets("Orders").ListObjects("Orders")
    Set dst = Sheets("Archive").ListObjects("Archive")
    If MsgBox("Move every delivered order to the Archive sheet?", vbYesNo + vbQuestion, "Archive") <> vbYes Then Exit Sub
    For i = src.ListRows.Count To 1 Step -1
        If src.ListRows(i).Range.Cells(1, 10).Value = "Delivered" Then
            Set row = dst.ListRows.Add
            row.Range.Cells(1, 1).Value = src.ListRows(i).Range.Cells(1, 1).Value
            row.Range.Cells(1, 2).Value = src.ListRows(i).Range.Cells(1, 2).Value
            row.Range.Cells(1, 3).Value = src.ListRows(i).Range.Cells(1, 3).Value
            row.Range.Cells(1, 4).Value = src.ListRows(i).Range.Cells(1, 5).Value
            row.Range.Cells(1, 5).Value = src.ListRows(i).Range.Cells(1, 6).Value
            row.Range.Cells(1, 6).Value = src.ListRows(i).Range.Cells(1, 8).Value
            row.Range.Cells(1, 7).Value = Date
            src.ListRows(i).Delete
            moved = moved + 1
        End If
    Next i
    MsgBox moved & " order(s) moved to the Archive.", vbInformation, "Juniper Bakery"
End Sub

Function WeekdayOf(d As Date) As String
    WeekdayOf = Format(d, "dddd")
End Function
'''
BAKERY_SHEET_VBA = '''Private Sub Worksheet_Change(ByVal Target As Range)
    ' When an order is marked Delivered, write down when in the Notes column
    If Intersect(Target, Me.ListObjects("Orders").ListColumns("Status").DataBodyRange) Is Nothing Then Exit Sub
    If Target.Value = "Delivered" Then
        If Target.Offset(0, 1).Value = "" Then Target.Offset(0, 1).Value = "Delivered " & Format(Now, "d mmm, h:mm")
    End If
End Sub
'''
BAKERY_WB_VBA = '''Private Sub Workbook_Open()
    Application.StatusBar = "Good morning, Juniper Bakery!"
End Sub
'''


def bakery(today):
    d = lambda n: today + dt.timedelta(days=n)
    menu = [("Sourdough loaf", "Bread", 9.5, "Yes", "Gluten"), ("Seeded rye", "Bread", 8.75, "Yes", "Gluten, sesame"),
            ("Butter croissant", "Pastry", 3.95, "Yes", "Gluten, dairy, egg"), ("Almond croissant", "Pastry", 4.75, "Yes", "Gluten, dairy, nuts"),
            ("Cinnamon bun", "Pastry", 4.25, "Yes", "Gluten, dairy"), ("Lemon tart", "Cake", 6.5, "Yes", "Gluten, dairy, egg"),
            ("Carrot cake (whole)", "Cake", 38.0, "Yes", "Gluten, nuts, egg"), ("Birthday cake (8 in)", "Cake", 52.0, "No", "Gluten, dairy, egg"),
            ("Oat cookie box", "Pastry", 12.0, "Yes", "Gluten"), ("Cold brew (1 L)", "Drinks", 11.0, "Yes", "")]
    orders = [
        (1041, d(-6), "Marta Kowal", "514-555-0141", "Carrot cake (whole)", 1, d(-4), "Delivered", "Pick-up, paid"),
        (1042, d(-5), "Hôtel du Parc (Léa)", "514-555-0177", "Butter croissant", 60, d(-4), "Delivered", "Every Tuesday"),
        (1043, d(-3), "Sam Okafor", "438-555-0102", "Sourdough loaf", 3, d(-2), "Delivered", ""),
        (1044, d(-2), "Studio Nine (Ivy)", "514-555-0190", "Oat cookie box", 4, d(-1), "Ready", "Ivy picks up after 4"),
        (1045, d(-2), "Daniel Roy", "438-555-0164", "Birthday cake (8 in)", 1, d(-1), "Baking", "Write: Happy 7th, Noé!"),
        (1046, d(-1), "Café Lumen", "514-555-0123", "Almond croissant", 24, d(0), "Baking", "Deliver before 8 am"),
        (1047, d(-1), "Priya Natarajan", "438-555-0188", "Lemon tart", 6, d(0), "Ready", ""),
        (1048, d(-1), "Café Lumen", "514-555-0123", "Cinnamon bun", 18, d(0), "Baking", ""),
        (1049, d(0), "Olivier Gagnon", "514-555-0119", "Seeded rye", 2, d(1), "New", ""),
        (1050, d(0), "Ana Lima", "438-555-0105", "Cold brew (1 L)", 3, d(1), "New", "Oat milk on the side"),
        (1051, d(0), "Hôtel du Parc (Léa)", "514-555-0177", "Butter croissant", 60, d(3), "New", "Every Tuesday"),
        (1052, d(0), "Tom Becker", "438-555-0131", "Carrot cake (whole)", 1, d(2), "Cancelled", "Called to cancel"),
        (1053, d(0), "Mei Chen", "514-555-0152", "Sourdough loaf", 1, d(1), "New", ""),
    ]
    order_cols = ["Order #", "Date", "Customer", "Phone", "Item", "Qty", "Unit price", "Total", "Ready by", "Status", "Notes"]
    n = len(orders)
    top = 4
    last = top + n
    ws_orders = {"name": "Orders", "code": "Sheet1", "cells": {"A1": "Juniper Bakery: order book", "A2": "Every order in one place. Ready orders turn green, late ones turn red."},
                 "styles": {"A1": "title", "A2": "note"},
                 "widths": {"A": 10, "B": 13, "C": 22, "D": 14, "E": 22, "F": 7, "G": 11, "H": 11, "I": 13, "J": 12, "K": 28}}
    _rows(ws_orders, top, order_cols, [list(o[:6]) + [None, None] + list(o[6:]) for o in orders],
          {"Date": "date", "Ready by": "date", "Unit price": "money", "Total": "money", "Order #": "int"})
    for i in range(n):
        r = top + 1 + i
        ws_orders["cells"]["G%d" % r] = "=IFERROR(XLOOKUP([@Item],Menu[Item],Menu[Price]),0)"
        ws_orders["cells"]["H%d" % r] = "=[@Qty]*[@[Unit price]]"
    tot = last + 1
    ws_orders["cells"].update({"A%d" % tot: "Total", "F%d" % tot: "=SUBTOTAL(109,Orders[Qty])", "H%d" % tot: "=SUBTOTAL(109,Orders[Total])"})
    ws_orders["styles"].update({"H%d" % tot: "money"})
    ws_orders["tables"] = [{"name": "Orders", "ref": "A%d:K%d" % (top, tot), "columns": order_cols,
                            "calc": {"Unit price": "IFERROR(XLOOKUP([@Item],Menu[Item],Menu[Price]),0)", "Total": "[@Qty]*[@[Unit price]]"},
                            "totals": {"Order #": "label:Total", "Qty": "sum", "Total": "sum"}}]
    rng = lambda col: "%s%d:%s%d" % (col, top + 1, col, last + 40)
    ws_orders["validations"] = [
        {"type": "list", "sqref": rng("E"), "f1": "MenuItems", "blank": False, "prompt": "Pick something from the menu", "error": "That isn't on the menu. Add it to the Menu sheet first.", "errorTitle": "Not on the menu"},
        {"type": "whole", "op": "between", "sqref": rng("F"), "f1": "1", "f2": "200", "blank": False, "error": "Quantity is 1 to 200. Bigger orders: call the bakery.", "errorTitle": "Quantity"},
        {"type": "list", "sqref": rng("J"), "f1": '"New,Baking,Ready,Delivered,Cancelled"', "blank": False},
        {"type": "date", "op": "greaterThanOrEqual", "sqref": rng("I"), "f1": "B%d" % (top + 1), "blank": True, "error": "An order can't be ready before it was placed.", "errorTitle": "Ready by"},
        {"type": "custom", "sqref": rng("D"), "f1": 'OR(D%d="",LEN(D%d)>=7)' % (top + 1, top + 1), "blank": True, "error": "That phone number looks too short.", "style": "warning"},
    ]
    ws_orders["cf"] = [
        {"type": "expression", "sqref": "A%d:K%d" % (top + 1, last), "f": '$J%d="Cancelled"' % (top + 1), "style": "muted"},
        {"type": "expression", "sqref": "A%d:K%d" % (top + 1, last), "f": 'AND($I%d<TODAY(),$J%d<>"Delivered",$J%d<>"Cancelled")' % (top + 1, top + 1, top + 1), "style": "bad"},
        {"type": "expression", "sqref": "J%d:J%d" % (top + 1, last), "f": '$J%d="Ready"' % (top + 1), "style": "good"},
        {"type": "expression", "sqref": "J%d:J%d" % (top + 1, last), "f": '$J%d="Baking"' % (top + 1), "style": "warn"},
    ]
    ws_orders["buttons"] = [{"caption": "New order", "macro": "NewOrder", "col": 13, "row": 4},
                            {"caption": "Mark baking ready", "macro": "MarkBakingReady", "col": 13, "row": 6},
                            {"caption": "Archive delivered", "macro": "ArchiveDelivered", "col": 13, "row": 8}]
    menu_cols = ["Item", "Category", "Price", "In stock", "Allergens", "Sold"]
    ws_menu = {"name": "Menu", "code": "Sheet2", "cells": {"A1": "Menu and prices"}, "styles": {"A1": "title"}, "widths": {"A": 22, "B": 12, "C": 10, "D": 10, "E": 24, "F": 8}}
    _rows(ws_menu, 3, menu_cols, [list(m) + [None] for m in menu], {"Price": "money"})
    for i in range(len(menu)):
        ws_menu["cells"]["F%d" % (4 + i)] = "=SUMIFS(Orders[Qty],Orders[Item],[@Item],Orders[Status],\"<>Cancelled\")"
    ws_menu["tables"] = [{"name": "Menu", "ref": "A3:F%d" % (3 + len(menu)), "columns": menu_cols,
                          "calc": {"Sold": "SUMIFS(Orders[Qty],Orders[Item],[@Item],Orders[Status],\"<>Cancelled\")"}}]
    ws_menu["validations"] = [{"type": "list", "sqref": "B4:B60", "f1": '"Bread,Pastry,Cake,Drinks"', "blank": False},
                              {"type": "list", "sqref": "D4:D60", "f1": '"Yes,No"', "blank": False},
                              {"type": "decimal", "op": "between", "sqref": "C4:C60", "f1": "0", "f2": "500", "blank": False, "error": "Prices are between $0 and $500."}]
    ws_menu["cf"] = [{"type": "cellIs", "op": "equal", "sqref": "D4:D60", "f": '"No"', "style": "bad"}]
    ws_sum = {"name": "Summary", "code": "Sheet3", "widths": {"A": 26, "B": 18},
              "cells": {"A1": "Today at Juniper", "A3": "Orders taken today", "B3": "=COUNTIFS(Orders[Date],TODAY())",
                        "A4": "Due today", "B4": "=COUNTIFS(Orders[Ready by],TODAY(),Orders[Status],\"<>Delivered\",Orders[Status],\"<>Cancelled\")",
                        "A5": "Open orders", "B5": "=COUNTIFS(Orders[Status],\"<>Delivered\",Orders[Status],\"<>Cancelled\")",
                        "A6": "Late orders", "B6": "=COUNTIFS(Orders[Ready by],\"<\"&TODAY(),Orders[Status],\"<>Delivered\",Orders[Status],\"<>Cancelled\")",
                        "A8": "Money", "A9": "Sales this month", "B9": "=SUMIFS(Orders[Total],Orders[Date],\">=\"&(EOMONTH(TODAY(),-1)+1),Orders[Status],\"<>Cancelled\")",
                        "A10": "Average order", "B10": "=IFERROR(AVERAGEIFS(Orders[Total],Orders[Status],\"<>Cancelled\"),0)",
                        "A11": "Archived sales", "B11": "=SUM(Archive[Total])",
                        "A13": "Best seller", "B13": "=INDEX(Menu[Item],MATCH(MAX(Menu[Sold]),Menu[Sold],0))",
                        "A14": "Out of stock", "B14": "=COUNTIF(Menu[In stock],\"No\")&\" item(s)\""},
              "styles": {"A1": "title", "A8": "big", "B9": "money", "B10": "money", "B11": "money"}}
    arch_cols = ["Order #", "Date", "Customer", "Item", "Qty", "Total", "Archived on"]
    ws_arch = {"name": "Archive", "code": "Sheet4", "cells": {"A1": "Archive"}, "styles": {"A1": "title"}, "widths": {"A": 10, "B": 13, "C": 22, "D": 22, "E": 7, "F": 11, "G": 13}}
    arch = [(1031, d(-20), "Café Lumen", "Almond croissant", 24, 114.0, d(-18)), (1034, d(-16), "Marta Kowal", "Lemon tart", 4, 26.0, d(-14)),
            (1038, d(-10), "Hôtel du Parc (Léa)", "Butter croissant", 60, 237.0, d(-8))]
    _rows(ws_arch, 3, arch_cols, arch, {"Date": "date", "Archived on": "date", "Total": "money"})
    ws_arch["tables"] = [{"name": "Archive", "ref": "A3:G%d" % (3 + len(arch)), "columns": arch_cols}]
    return {"title": "Juniper Bakery order book", "sheets": [ws_orders, ws_menu, ws_sum, ws_arch],
            "names": [("MenuItems", "Menu!$A$4:$A$%d" % (3 + len(menu)))],
            "vba": [{"name": "Module1", "kind": "standard", "code": BAKERY_VBA}, {"name": "Sheet1", "kind": "document", "code": BAKERY_SHEET_VBA},
                    {"name": "Sheet2", "kind": "document", "code": ""}, {"name": "Sheet3", "kind": "document", "code": ""},
                    {"name": "Sheet4", "kind": "document", "code": ""}, {"name": "ThisWorkbook", "kind": "document", "code": BAKERY_WB_VBA}]}


# --------------------------------------------------------------------------------------------- Fernhill Tool Library
TOOLS_VBA = '''Option Explicit
' Fernhill Tool Library (a fictional example for Sheetsmith)
Const FEE_PER_DAY As Double = 0.5

Sub CheckOverdue()
    Dim ws As Worksheet, lastRow As Long, r As Long, names As String, n As Long
    Set ws = Sheets("Loans")
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 4 To lastRow
        If ws.Cells(r, 6).Value = "" And ws.Cells(r, 5).Value < Date Then
            n = n + 1
            names = names & vbCrLf & "- " & ws.Cells(r, 1).Value & " (" & ws.Cells(r, 2).Value & ", " & DateDiff("d", ws.Cells(r, 5).Value, Date) & " days late)"
        End If
    Next r
    If n = 0 Then
        MsgBox "Everything is back on time. Nice!", vbInformation, "Overdue tools"
    Else
        MsgBox n & " tool(s) are overdue:" & names, vbExclamation, "Overdue tools"
    End If
End Sub

Sub ReturnTool()
    Dim tool As String, ws As Worksheet, r As Long, lastRow As Long, found As Boolean, fee As Double
    tool = InputBox("Which tool came back? (its name, as in the list)", "Return a tool")
    If tool = "" Then Exit Sub
    Set ws = Sheets("Loans")
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = lastRow To 4 Step -1
        If LCase(ws.Cells(r, 1).Value) = LCase(tool) And ws.Cells(r, 6).Value = "" Then
            ws.Cells(r, 6).Value = Date
            fee = ws.Cells(r, 8).Value
            found = True
            Exit For
        End If
    Next r
    If Not found Then
        MsgBox "No open loan for """ & tool & """.", vbExclamation, "Return a tool"
    ElseIf fee > 0 Then
        MsgBox "Thanks! " & tool & " is back. Late fee: " & Format(fee, "$0.00"), vbInformation, "Return a tool"
    Else
        MsgBox "Thanks! " & tool & " is back on the shelf.", vbInformation, "Return a tool"
    End If
End Sub

Function LateFee(daysLate As Long) As Double
    If daysLate <= 0 Then LateFee = 0 Else LateFee = daysLate * FEE_PER_DAY
End Function
'''
TOOLS_LOANS_VBA = '''Private Sub Worksheet_Change(ByVal Target As Range)
    ' Typing a tool name starts the loan today, if no date is there yet
    If Target.Column <> 1 Or Target.Row < 4 Then Exit Sub
    If Target.Value <> "" And Target.Offset(0, 3).Value = "" Then Target.Offset(0, 3).Value = Date
End Sub
'''


def tools(today):
    d = lambda n: today + dt.timedelta(days=n)
    tl = [("T-01", "Cordless drill", "Power tools", "Good"), ("T-02", "Circular saw", "Power tools", "Worn"), ("T-03", "Ladder (3 m)", "Access", "Good"),
          ("T-04", "Pressure washer", "Garden", "Like new"), ("T-05", "Tile cutter", "Hand tools", "Good"), ("T-06", "Hedge trimmer", "Garden", "Needs repair"),
          ("T-07", "Stud finder", "Hand tools", "Like new"), ("T-08", "Sander", "Power tools", "Good"), ("T-09", "Wheelbarrow", "Garden", "Worn"),
          ("T-10", "Socket set", "Hand tools", "Good")]
    loans = [("Cordless drill", "Nadia Haddad", "nadia.h@example.org", d(-20), d(-12)), ("Ladder (3 m)", "Jonas Berg", "jonas.b@example.org", d(-18), None),
             ("Pressure washer", "Chloé Martin", "chloe.m@example.org", d(-9), d(-3)), ("Tile cutter", "Ravi Shah", "ravi.s@example.org", d(-6), None),
             ("Sander", "Emma Wilson", "emma.w@example.org", d(-3), None), ("Cordless drill", "Luis Ortega", "luis.o@example.org", d(-2), None),
             ("Socket set", "Hana Sato", "hana.s@example.org", d(-30), d(-10))]
    tool_cols = ["Tool ID", "Tool", "Category", "Condition", "Out now", "Times lent"]
    ws_tools = {"name": "Tools", "code": "Sheet1", "cells": {"A1": "Fernhill Tool Library: tools"}, "styles": {"A1": "title"},
                "widths": {"A": 8, "B": 20, "C": 14, "D": 14, "E": 9, "F": 10}}
    _rows(ws_tools, 3, tool_cols, [list(t) + [None, None] for t in tl], {})
    for i in range(len(tl)):
        ws_tools["cells"]["E%d" % (4 + i)] = '=COUNTIFS(Loans[Tool],[@Tool],Loans[Returned],"")>0'
        ws_tools["cells"]["F%d" % (4 + i)] = "=COUNTIFS(Loans[Tool],[@Tool])"
    ws_tools["tables"] = [{"name": "Tools", "ref": "A3:F%d" % (3 + len(tl)), "columns": tool_cols,
                           "calc": {"Out now": 'COUNTIFS(Loans[Tool],[@Tool],Loans[Returned],"")>0', "Times lent": "COUNTIFS(Loans[Tool],[@Tool])"}}]
    ws_tools["validations"] = [{"type": "list", "sqref": "C4:C80", "f1": '"Power tools,Hand tools,Garden,Access"', "blank": False},
                               {"type": "list", "sqref": "D4:D80", "f1": '"Like new,Good,Worn,Needs repair"', "blank": False}]
    ws_tools["cf"] = [{"type": "cellIs", "op": "equal", "sqref": "D4:D80", "f": '"Needs repair"', "style": "bad"},
                      {"type": "cellIs", "op": "equal", "sqref": "E4:E80", "f": "TRUE", "style": "warn"}]
    loan_cols = ["Tool", "Borrower", "Email", "Out", "Due", "Returned", "Days late", "Fee"]
    ws_loans = {"name": "Loans", "code": "Sheet2", "cells": {"A1": "Loans", "A2": "Loans are two weeks. Late fee: 50 cents a day."},
                "styles": {"A1": "title", "A2": "note"}, "widths": {"A": 18, "B": 18, "C": 24, "D": 12, "E": 12, "F": 12, "G": 10, "H": 9}}
    _rows(ws_loans, 3, loan_cols, [[l[0], l[1], l[2], l[3], None, l[4], None, None] for l in loans], {"Out": "date", "Due": "date", "Returned": "date", "Fee": "money"})
    calc = {"Due": "[@Out]+14", "Days late": 'IF([@Out]="","",MAX(0,IF([@Returned]="",TODAY(),[@Returned])-[@Due]))', "Fee": 'IF([@[Days late]]="",0,LateFee([@[Days late]]))'}
    for i in range(len(loans)):
        r = 4 + i
        ws_loans["cells"]["E%d" % r] = "=" + calc["Due"]
        ws_loans["cells"]["G%d" % r] = "=" + calc["Days late"]
        ws_loans["cells"]["H%d" % r] = "=" + calc["Fee"]
    ws_loans["tables"] = [{"name": "Loans", "ref": "A3:H%d" % (3 + len(loans)), "columns": loan_cols, "calc": calc}]
    ws_loans["validations"] = [
        {"type": "list", "sqref": "A4:A300", "f1": "Tools[Tool]", "blank": False, "prompt": "Which tool is going out?"},
        {"type": "custom", "sqref": "C4:C300", "f1": 'ISNUMBER(SEARCH("@",C4))', "blank": True, "error": "That doesn't look like an email address.", "errorTitle": "Email"},
        {"type": "date", "op": "between", "sqref": "D4:D300", "f1": "DATE(2020,1,1)", "f2": "TODAY()+1", "blank": False, "error": "The loan date can't be in the future."},
    ]
    ws_loans["cf"] = [{"type": "expression", "sqref": "A4:H40", "f": 'AND($F4="",$G4>0)', "style": "bad"},
                      {"type": "expression", "sqref": "A4:H40", "f": '$F4<>""', "style": "muted"}]
    ws_loans["buttons"] = [{"caption": "Check overdue", "macro": "CheckOverdue", "col": 10, "row": 3}, {"caption": "Return a tool", "macro": "ReturnTool", "col": 10, "row": 5}]
    members = [("Nadia Haddad", "nadia.h@example.org", "514-555-0110", d(-400), "Volunteer on Saturdays"), ("Jonas Berg", "jonas.b@example.org", "514-555-0122", d(-220), ""),
               ("Chloé Martin", "chloe.m@example.org", "438-555-0145", d(-180), ""), ("Ravi Shah", "ravi.s@example.org", "514-555-0136", d(-95), "Fixes small engines"),
               ("Emma Wilson", "emma.w@example.org", "438-555-0157", d(-60), ""), ("Luis Ortega", "luis.o@example.org", "514-555-0168", d(-30), ""),
               ("Hana Sato", "hana.s@example.org", "438-555-0179", d(-12), "New member")]
    ws_members = {"name": "Members", "code": "Sheet3", "widths": {"A": 18, "B": 24, "C": 14, "D": 12, "E": 26}}
    _rows(ws_members, 1, ["Name", "Email", "Phone", "Joined", "Notes"], members, {"Joined": "date"})
    return {"title": "Fernhill Tool Library", "sheets": [ws_loans, ws_tools, ws_members],
            "vba": [{"name": "Module1", "kind": "standard", "code": TOOLS_VBA}, {"name": "Sheet2", "kind": "document", "code": TOOLS_LOANS_VBA},
                    {"name": "Sheet1", "kind": "document", "code": ""}, {"name": "Sheet3", "kind": "document", "code": ""},
                    {"name": "ThisWorkbook", "kind": "document", "code": ""}]}


# --------------------------------------------------------------------------------------------- Floor quote
QUOTE_VBA = '''Option Explicit
' Northgate Floors quote calculator (a fictional example for Sheetsmith)

Sub SaveQuote()
    Dim q As Worksheet, t As ListObject, r As ListRow
    Set q = Sheets("Quote")
    If Trim(q.Range("B3").Value) = "" Then
        MsgBox "Type the client's name first.", vbExclamation, "Save quote"
        Exit Sub
    End If
    Set t = Sheets("Quotes").ListObjects("Quotes")
    Set r = t.ListRows.Add
    r.Range.Cells(1, 1).Value = Date
    r.Range.Cells(1, 2).Value = q.Range("B3").Value
    r.Range.Cells(1, 3).Value = q.Range("B6").Value
    r.Range.Cells(1, 4).Value = q.Range("B11").Value
    r.Range.Cells(1, 5).Value = q.Range("B18").Value
    MsgBox "Quote for " & q.Range("B3").Value & " saved: " & Format(q.Range("B18").Value, "$#,##0.00"), vbInformation, "Save quote"
    q.Range("B3").Value = ""
End Sub

Sub ClearQuote()
    Dim q As Worksheet
    Set q = Sheets("Quote")
    q.Range("B3").ClearContents
    q.Range("B4").Value = 4
    q.Range("B5").Value = 3
    q.Range("B7").Value = 6
    q.Range("B8").Value = 0
End Sub
'''


def quote(today):
    d = lambda n: today + dt.timedelta(days=n)
    ws_q = {"name": "Quote", "code": "Sheet1", "widths": {"A": 24, "B": 20, "C": 30},
            "cells": {"A1": "Floor quote", "A3": "Client", "B3": "Hughes family", "A4": "Room width (m)", "B4": 4.2, "A5": "Room length (m)", "B5": 3.6,
                      "A6": "Flooring", "B6": "Oak plank", "A7": "Labour hours", "B7": 9, "A8": "Discount", "B8": 0.05,
                      "A10": "The quote", "A11": "Area (m²)", "B11": "=ROUND(B4*B5,2)", "A12": "Material", "B12": "=B11*XLOOKUP(B6,Prices[Flooring],Prices[Price per m²],0)*1.1",
                      "C12": "includes 10% extra for cuts", "A13": "Labour", "B13": "=B7*LabourRate", "A14": "Subtotal", "B14": "=B12+B13",
                      "A15": "Discount amount", "B15": "=-ROUND(B14*B8,2)", "A16": "Tax (GST + QST)", "B16": "=ROUND((B14+B15)*0.14975,2)",
                      "A18": "Total", "B18": "=B14+B15+B16"},
            "styles": {"A1": "title", "B3": "input", "B4": "input", "B5": "input", "B6": "input", "B7": "input", "B8": "inputpct", "A10": "big",
                       "B12": "money", "B13": "money", "B14": "money", "B15": "money", "B16": "money", "A18": "big", "B18": "moneybig", "C12": "note"}}
    ws_q["validations"] = [{"type": "decimal", "op": "between", "sqref": "B4:B5", "f1": "0.5", "f2": "40", "blank": False, "error": "Rooms are 0.5 m to 40 m on a side.", "prompt": "In metres, e.g. 3.5"},
                           {"type": "list", "sqref": "B6", "f1": "=Prices!$A$4:$A$9", "blank": False},
                           {"type": "whole", "op": "between", "sqref": "B7", "f1": "0", "f2": "120", "blank": False},
                           {"type": "decimal", "op": "between", "sqref": "B8", "f1": "0", "f2": "0.3", "blank": True, "error": "Discounts go up to 30%.", "errorTitle": "Discount"}]
    ws_q["buttons"] = [{"caption": "Save quote", "macro": "SaveQuote", "col": 4, "row": 3}, {"caption": "Start over", "macro": "ClearQuote", "col": 4, "row": 5}]
    prices = [("Oak plank", 64.0, "Bois Laurentides"), ("Maple strip", 58.5, "Bois Laurentides"), ("Vinyl plank", 31.0, "FloorCo"),
              ("Porcelain tile", 47.0, "Carrelage Nord"), ("Cork", 42.0, "EcoFloors"), ("Laminate", 24.5, "FloorCo")]
    ws_p = {"name": "Prices", "code": "Sheet2", "widths": {"A": 18, "B": 14, "C": 20, "E": 18, "F": 10},
            "cells": {"A1": "Prices", "E3": "Labour rate (per hour)", "F3": 65}, "styles": {"A1": "title", "F3": "money", "E3": "bold"}}
    _rows(ws_p, 3, ["Flooring", "Price per m²", "Supplier"], prices, {"Price per m²": "money"})
    ws_p["tables"] = [{"name": "Prices", "ref": "A3:C%d" % (3 + len(prices)), "columns": ["Flooring", "Price per m²", "Supplier"]}]
    qs = [(d(-14), "Bouchard condo", "Vinyl plank", 38.4, 2412.31), (d(-6), "Café Lumen", "Porcelain tile", 22.0, 2968.77), (d(-2), "Nguyen kitchen", "Cork", 11.5, 1336.12)]
    ws_s = {"name": "Quotes", "code": "Sheet3", "cells": {"A1": "Saved quotes"}, "styles": {"A1": "title"}, "widths": {"A": 12, "B": 20, "C": 16, "D": 10, "E": 12}}
    _rows(ws_s, 3, ["Date", "Client", "Flooring", "Area", "Total"], qs, {"Date": "date", "Total": "money"})
    ws_s["tables"] = [{"name": "Quotes", "ref": "A3:E%d" % (3 + len(qs)), "columns": ["Date", "Client", "Flooring", "Area", "Total"]}]
    return {"title": "Northgate Floors quote", "sheets": [ws_q, ws_s, ws_p], "names": [("LabourRate", "Prices!$F$3")],
            "vba": [{"name": "Module1", "kind": "standard", "code": QUOTE_VBA}, {"name": "Sheet1", "kind": "document", "code": ""},
                    {"name": "Sheet2", "kind": "document", "code": ""}, {"name": "Sheet3", "kind": "document", "code": ""}, {"name": "ThisWorkbook", "kind": "document", "code": ""}]}


BOOKS = {
    "bakery": ("Juniper Bakery orders.xlsm", bakery, "A bakery's order book: orders, a menu with prices, a summary, an archive and three macros."),
    "tools": ("Fernhill Tool Library.xlsm", tools, "A neighbourhood tool library: tools, loans with late fees, members, an overdue check."),
    "quote": ("Northgate Floors quote.xlsm", quote, "A quote calculator: inputs, live totals with tax, saved quotes and a Save macro."),
}


def build(key, today=None):
    name, fn, _ = BOOKS[key]
    return name, build_xlsx(fn(today or dt.date.today()))
