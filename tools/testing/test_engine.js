/* Engine tests (theme/assets/rt-formula.js + rt-vba.js) in Node:  node tools/testing/test_engine.js  -> ALL OK
   tools/check.py runs this. Add a check with eq(actual, expected, 'what'). */
'use strict';
var path = require('path');
var SE = require(path.join(__dirname, '..', '..', 'theme', 'assets', 'rt-formula.js'));
try { require(path.join(__dirname, '..', '..', 'theme', 'assets', 'rt-vba.js')); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
var fails = 0, count = 0;
function eq(a, b, msg) {
  count++;
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-9 : sa !== sb) { fails++; console.log('FAIL ' + msg + ': got ' + sa + ', expected ' + sb); }
}

// ------------------------------------------------------------------ a small workbook
var bp = {
  styles: [{ z: 'yyyy-mm-dd' }, { z: '$#,##0.00' }, { b: 1 }],
  sheets: [
    { name: 'Orders', cells: {
      A1: { v: 'Item', s: 2 }, B1: { v: 'Qty' }, C1: { v: 'Price' }, D1: { v: 'Total' }, E1: { v: 'Status' },
      A2: { v: 'Bread' }, B2: { v: 2 }, C2: { v: 4.5 }, D2: { f: '[@Qty]*[@Price]' }, E2: { v: 'Open' },
      A3: { v: 'Cake' }, B3: { v: 1 }, C3: { v: 20 }, D3: { f: '[@Qty]*[@Price]' }, E3: { v: 'Done' },
      A4: { v: 'Bun' }, B4: { v: 6 }, C4: { v: 1.25 }, D4: { f: '[@Qty]*[@Price]' }, E4: { v: 'Open' },
      G1: { v: 'Sum' }, H1: { f: 'SUM(Orders[Total])' },
      G2: { v: 'Open' }, H2: { f: 'COUNTIF(Orders[Status],"Open")' },
      G3: { v: 'Cake price' }, H3: { f: 'VLOOKUP("cake",A2:C4,3,FALSE)' },
      G4: { f: 'XLOOKUP("Bun",Orders[Item],Orders[Qty],"none")' },
      G5: { f: 'SUMIFS(Orders[Total],Orders[Status],"Open",Orders[Qty],">1")' },
      G6: { f: 'IFERROR(1/0,"oops")' }, G7: { f: 'TEXT(DATE(2024,3,9),"dddd d mmm yyyy")' },
      G8: { f: 'Lists!A2&" & "&Lists!A3' }, G9: { f: 'ROUND(2.345,2)+ROUNDUP(1.21,1)' }, G10: { f: 'INDEX(Orders[Item],MATCH(20,Orders[Price],0))' },
      G11: { f: '"a"&1&TRUE' }, G12: { f: '-2^2' }, G13: { f: 'AVERAGE(B2:B4)' }, G14: { f: 'IF(H1>20,"big","small")' },
      G15: { f: 'Orders[[#Totals],[Qty]]' }, G16: { f: 'EOMONTH(DATE(2024,1,15),1)', s: 0 }, G17: { f: 'DATEDIF(DATE(2020,5,1),DATE(2024,3,9),"y")' },
      G18: { f: 'SUMPRODUCT(Orders[Qty],Orders[Price])' }, G19: { f: 'TaxRate*100' }, G20: { f: 'LEN(PROPER("hello wORLD"))&PROPER("hello wORLD")' }
    }, validations: [
      { sqref: ['E2:E4'], type: 'list', f1: 'Lists!$A$2:$A$4', allowBlank: true, op: 'between' },
      { sqref: ['B2:B4'], type: 'whole', op: 'between', f1: '1', f2: '200', allowBlank: false },
      { sqref: ['K2'], type: 'custom', f1: 'ISNUMBER(SEARCH("@",K2))', allowBlank: true }
    ], condFormats: [{ sqref: ['A2:E4'], rules: [{ type: 'expression', formulas: ['$E2="Done"'], style: { fill: '#C6EFCE' }, priority: 1 }] }] },
    { name: 'Lists', cells: { A1: { v: 'Status' }, A2: { v: 'Open' }, A3: { v: 'Done' }, A4: { v: 'Cancelled' } } }
  ],
  tables: [{ id: 't1', name: 'Orders', sheet: 'Orders', ref: 'A1:E5', header: true, totals: true,
    columns: [{ name: 'Item', totalsLabel: 'Total' }, { name: 'Qty', totalsFn: 'sum' }, { name: 'Price' }, { name: 'Total', calc: '[@Qty]*[@Price]', totalsFn: 'sum' }, { name: 'Status', totalsFn: 'count' }] }],
  names: [{ name: 'TaxRate', ref: '0.15', scope: null }]
};
// the totals row as Excel writes it
bp.sheets[0].cells.A5 = { v: 'Total' }; bp.sheets[0].cells.B5 = { f: 'SUBTOTAL(109,[Qty])' };
var wb = new SE.WB(bp);
var V = function (a, s) { var p = SE.parseA1(a); return wb.value(s || 'Orders', p.r, p.c); };
eq(wb.rows(wb.tableByName('orders')).length, 3, 'table rows read from the region');
eq(V('D3'), 20, 'calculated column [@Qty]*[@Price]');
eq(V('H1'), 9 + 20 + 7.5, 'SUM over a table column');
eq(V('H2'), 2, 'COUNTIF on a table column');
eq(V('H3'), 20, 'VLOOKUP exact, any case');
eq(V('G4'), 6, 'XLOOKUP');
eq(V('G5'), 16.5, 'SUMIFS with two criteria');
eq(V('G6'), 'oops', 'IFERROR');
eq(V('G7'), 'Saturday 9 Mar 2024', 'TEXT with a date format');
eq(V('G8'), 'Open & Done', 'cross-sheet refs and &');
eq(V('G9'), 2.35 + 1.3, 'ROUND / ROUNDUP');
eq(V('G10'), 'Cake', 'INDEX/MATCH');
eq(V('G11'), 'a1TRUE', 'concatenation coerces');
eq(V('G12'), 4, 'negation binds tighter than ^ (like Excel)');
eq(V('G13'), 3, 'AVERAGE of a range');
eq(V('G14'), 'big', 'IF');
eq(V('G15'), 9, 'totals row value via [#Totals]');
eq(SE.formatValue(V('G16'), 'yyyy-mm-dd'), '2024-02-29', 'EOMONTH in a leap year');
eq(V('G17'), 3, 'DATEDIF years');
eq(V('G18'), 36.5, 'SUMPRODUCT');
eq(V('G19'), 15, 'defined names');
eq(V('G20'), '11Hello World', 'PROPER/LEN');
eq(V('A5'), 'Total', 'totals label is virtual');
eq(V('D5'), 36.5, 'totals SUM of a calculated column');
eq(V('E5'), 3, 'totals count');

// ------------------------------------------------------------------ changes
var t = wb.tableByName('Orders');
wb.addRow(t, ['Pie', 2, 8, null, 'Open']);
eq(V('H1'), 52.5, 'a new row joins the SUM');
eq(V('D5'), 16, 'calculated column on the new row');
eq(V('D6'), 52.5, 'totals row moved down');
wb.setCell('Orders', 2, 2, 3);
eq(V('D2'), 13.5, 'editing a table cell recalculates its row');
var before = wb.rows(t).length;
wb.setCell('Orders', 7, 1, 'Below');  // right under the totals row: not part of the table
eq(wb.rows(t).length, before, 'no auto-extend under a totals row');
eq(V('A7'), 'Below', 'plain cell under the table');
wb.deleteRow(t, wb.rows(t)[0].id);
eq(V('H2'), 2, 'deleting a row');
eq(V('A2'), 'Cake', 'rows move up after a delete');

// ------------------------------------------------------------------ validation, conditional formats
eq(wb.listOptions(wb.validationAt('Orders', 2, 5), 'Orders', 2, 5), ['Open', 'Done', 'Cancelled'], 'list options from a range');
eq(wb.check('Orders', 2, 5, 'done').ok, true, 'list check ignores case');
eq(wb.check('Orders', 2, 5, 'Lost').ok, false, 'list check rejects others');
eq(wb.check('Orders', 3, 2, 500).ok, false, 'whole number range');
eq(wb.check('Orders', 3, 2, 2.5).ok, false, 'whole number only');
eq(wb.check('Orders', 3, 2, 12).ok, true, 'whole number in range');
eq(wb.check('Orders', 3, 2, '').ok, false, 'not blank when allowBlank is off');
eq(wb.check('Orders', 4, 5, 'Open').ok, true, 'validation follows rows added later');
eq(wb.check('Orders', 2, 11, 'ana@example.com').ok, true, 'custom formula with the new value');
eq(wb.check('Orders', 2, 11, 'nope').ok, false, 'custom formula fails');
eq((wb.cfAt('Orders', 2, 1) || {}).fill, '#C6EFCE', 'conditional format on a Done row');
eq(wb.cfAt('Orders', 3, 1), null, 'no format on an Open row');
eq(SE.describeRule(bp.sheets[0].validations[1]), 'Must be a whole number between 1 and 200', 'rule in plain words');

// ------------------------------------------------------------------ formats + input
eq(SE.formatValue(1234.5, '$#,##0.00'), '$1,234.50', 'currency');
eq(SE.formatValue(-1234.5, '#,##0.00;[Red](#,##0.00)'), '(1,234.50)', 'negative section');
eq(SE.formatValue(0.256, '0.0%'), '25.6%', 'percent');
eq(SE.formatValue(45360, 'd-mmm-yy'), '9-Mar-24', 'date');
eq(SE.formatValue(45360.75, 'yyyy-mm-dd h:mm AM/PM'), '2024-03-09 6:00 PM', 'date + time');
eq(SE.formatValue(1234567, '#,##0,"K"'), '1,235K', 'thousands scaling');
eq(SE.formatValue(1234.5, '_("$"* #,##0.00_)'), '$1,234.50', 'accounting');
eq(SE.formatValue(0.5, 'h:mm'), '12:00', 'time');
eq(SE.formatValue(3, '000'), '003', 'leading zeros');
eq(SE.formatValue(1 / 3), '0.333333333333333', 'general');
eq(SE.parseInput('2024-03-09', 'yyyy-mm-dd'), 45360, 'ISO date input');
eq(SE.parseInput('9/3/2024', 'dd/mm/yyyy'), 45360, 'd/m/y input');
eq(SE.parseInput('$1,200.50'), 1200.5, 'money input');
eq(SE.parseInput('15%'), 0.15, 'percent input');
eq(SE.parseInput('12', '0%'), 0.12, 'percent column takes 12 as 12%');
eq(SE.parseInput('hello'), 'hello', 'text input');
eq(SE.checkFormula('SUM(A1:A3)+FOO(1)').unknown, ['FOO'], 'checkFormula finds unknown functions');
eq(SE.checkFormula('SUM(').ok, false, 'checkFormula finds syntax errors');

// ------------------------------------------------------------------ ops apply the same on a copy of the state (what the server does)
var copy = JSON.parse(JSON.stringify(SE.initialState(bp)));
var w2 = new SE.WB(bp, copy);
var op = w2.addRow(w2.tableByName('Orders'), ['X', 1, 1]);
var copy2 = JSON.parse(JSON.stringify(SE.initialState(bp)));
SE.applyOp(copy2, JSON.parse(JSON.stringify(op)));
eq(copy2.tables.Orders.rows.length, copy.tables.Orders.rows.length, 'applyOp on another state gives the same rows');

// ------------------------------------------------------------------ VBA
var VB = SE.vba;
var code1 = [
  'Option Explicit',
  'Public Const RATE As Double = 0.15',
  'Dim counter As Long',
  '',
  'Sub NewOrder()',
  '    Dim tbl As ListObject, newRow As ListRow, who As String',
  '    who = InputBox("Customer name?", "New order")',
  '    If who = "" Then Exit Sub',
  '    Set tbl = Sheets("Orders").ListObjects("Orders")',
  '    Set newRow = tbl.ListRows.Add',
  '    With newRow.Range',
  '        .Cells(1, 1).Value = who',
  '        .Cells(1, 2).Value = 3',
  '        .Cells(1, 3) = 2.5',
  '        .Cells(1, 5).Value = "Open"',
  '    End With',
  '    MsgBox "Added order for " & who & " (" & tbl.ListRows.Count & " orders)", vbInformation',
  'End Sub',
  '',
  'Sub FillLog()',
  '    Dim ws As Worksheet, i As Long, last As Long',
  '    Set ws = Worksheets("Log")',
  '    For i = 1 To 5',
  '        last = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row',
  '        ws.Cells(last + 1, 1).Value = "Line " & i',
  '        ws.Cells(last + 1, 2).Value = i * i',
  '    Next i',
  '    ws.Range("D1").Formula = "=SUM(B:B)"',
  '    ws.Range("E1").Value = Application.WorksheetFunction.Max(ws.Range("B2:B6"))',
  'End Sub',
  '',
  'Function Grade(score)',
  '    Select Case score',
  '        Case Is >= 90: Grade = "A"',
  '        Case 75 To 89: Grade = "B"',
  '        Case Else: Grade = "C"',
  '    End Select',
  'End Function',
  '',
  'Function Taxed(amount As Double) As Double',
  '    Taxed = Round(amount * (1 + RATE), 2)',
  'End Function',
  '',
  'Sub Counting()',
  '    Dim d As Object, c As Range, k As Variant, out As String',
  '    Set d = CreateObject("Scripting.Dictionary")',
  '    For Each c In Range("E2:E4")',
  '        If d.Exists(c.Value) Then d(c.Value) = d(c.Value) + 1 Else d.Add c.Value, 1',
  '    Next c',
  '    For Each k In d.Keys',
  '        out = out & k & "=" & d(k) & ";"',
  '    Next',
  '    Range("K1").Value = out',
  '    Range("K2").Value = UCase(Left("hello", 2)) & Mid("abcdef", 3, 2) & Len(Trim("  x  ")) & InStr("banana", "n")',
  '    Range("K3").Value = Format(1234.5, "#,##0.00") & "|" & Format(DateSerial(2024, 3, 9), "dd mmm yyyy") & "|" & DateAdd("m", 1, DateSerial(2024, 1, 31))',
  '    Range("K4").Value = Join(Split("a,b,c", ","), "-") & UBound(Split("a,b,c", ",")) & IIf(5 > 3, "y", "n")',
  'End Sub',
  '',
  'Sub Errors()',
  '    Dim x As Long',
  '    On Error Resume Next',
  '    x = 1 / 0',
  '    Range("L1").Value = Err.Number',
  '    On Error GoTo Handler',
  '    x = 1 / 0',
  '    Range("L2").Value = "not here"',
  '    Exit Sub',
  'Handler:',
  '    Range("L2").Value = "handled " & Err.Description',
  'End Sub',
  '',
  'Sub Forever()',
  '    Dim i As Long',
  '    Do While True',
  '        i = i + 1',
  '    Loop',
  'End Sub',
  '',
  'Sub AskFirst()',
  '    If MsgBox("Delete the last order?", vbYesNo + vbQuestion) = vbYes Then',
  '        Sheets("Orders").ListObjects(1).ListRows(Sheets("Orders").ListObjects(1).ListRows.Count).Delete',
  '    End If',
  'End Sub'
].join('\n');
var sheetCode = [
  'Private Sub Worksheet_Change(ByVal Target As Range)',
  '    If Not Intersect(Target, Me.Range("E:E")) Is Nothing Then',
  '        If Target.Value = "Done" Then Target.Offset(0, 1).Value = "stamped"',
  '    End If',
  'End Sub'
].join('\n');
var bp2 = JSON.parse(JSON.stringify(bp));
bp2.sheets.push({ name: 'Log', cells: { A1: { v: 'Entry' }, B1: { v: 'Value' } } });
bp2.sheets[0].code = 'Sheet1';
var answers = [];
var host = { msgbox: function (p) { answers.push(['msg', p]); return Promise.resolve(6); }, inputbox: function () { return Promise.resolve('Ana'); }, user: 'Tester' };
var wbv = new SE.WB(bp2);
var mach = new VB.Machine([{ name: 'Module1', kind: 'standard', code: code1 }, { name: 'Sheet1', kind: 'document', sheet: 'Orders', code: sheetCode }], wbv, host);
wbv.udf = mach.udf;
eq(mach.problems, [], 'the sample code parses');
eq(mach.macros().map(function (p) { return p.name; }), ['NewOrder', 'FillLog', 'Counting', 'Errors', 'Forever', 'AskFirst'], 'macros = public subs without arguments');
var VV = function (a, s) { var p = SE.parseA1(a); return wbv.value(s || 'Orders', p.r, p.c); };
(async function () {
  var r = await mach.run('NewOrder', { sheet: 'Orders' });
  eq(r.ok, true, 'NewOrder runs: ' + (r.error || ''));
  var t2 = wbv.tableByName('Orders'), rows = wbv.rows(t2);
  eq(rows.length, 4, 'ListRows.Add adds a table row');
  eq(VV('A5'), 'Ana', 'InputBox answer written into the new row');
  eq(VV('D5'), 7.5, 'the calculated column works on the new row');
  eq(answers[0] && answers[0][1], 'Added order for Ana (4 orders)', 'MsgBox text');
  eq(r.ops.length > 0, true, 'the run returns ops for the server');

  r = await mach.run('FillLog');
  eq(r.ok, true, 'FillLog runs: ' + (r.error || ''));
  eq(VV('A6', 'Log'), 'Line 5', 'End(xlUp) finds the next empty row each time');
  eq(VV('D1', 'Log'), 55, 'a formula written by a macro calculates');
  eq(VV('E1', 'Log'), 25, 'WorksheetFunction.Max');

  wbv.setCell('Orders', 2, 7, '=Grade(95)&Grade(80)&Grade(10)');
  eq(VV('G2'), 'ABC', 'a cell formula calls a VBA Function (Select Case with Is / To / Else)');
  wbv.setCell('Orders', 3, 7, '=Taxed(100)');
  eq(VV('G3'), 115, 'UDF with a typed argument and a module constant');

  r = await mach.run('Counting');
  eq(r.ok, true, 'Counting runs: ' + (r.error || ''));
  eq(VV('K1'), 'Open=2;Done=1;', 'Dictionary + For Each over a range');
  eq(VV('K2'), 'HEcd13', 'string functions');
  eq(VV('K3'), '1,234.50|09 Mar 2024|2024-02-29', 'Format and DateAdd');
  eq(VV('K4'), 'a-b-c2y', 'Split / Join / UBound / IIf');

  r = await mach.run('Errors');
  eq(r.ok, true, 'Errors runs: ' + (r.error || ''));
  eq(VV('L1'), 11, 'On Error Resume Next keeps Err.Number');
  eq(VV('L2'), 'handled Division by zero', 'On Error GoTo jumps to the handler');

  r = await mach.run('Forever', { limit: 20000 });
  eq(r.ok, false, 'an endless loop is stopped');
  eq(/too long/.test(r.error || ''), true, 'with a clear message');

  var n0 = wbv.rows(t2).length;
  r = await mach.run('AskFirst');
  eq(r.ok && wbv.rows(t2).length === n0 - 1, true, 'MsgBox vbYesNo answered Yes deletes a row: ' + (r.error || ''));

  wbv.setCell('Orders', 2, 5, 'Done');
  r = await mach.fire('Worksheet_Change', 'Orders', { sheet: 'Orders', r1: 2, c1: 5, r2: 2, c2: 5 });
  eq(r && r.ok, true, 'Worksheet_Change runs: ' + (r && r.error || ''));
  eq(VV('F2'), 'stamped', 'Worksheet_Change with Intersect + Me + Offset');

  var bad = await mach.run('NoSuchMacro');
  eq(bad.ok, false, 'unknown macro');

  // the checker
  var an = VB.analyze([{ name: 'Module1', kind: 'standard', code: code1 }, { name: 'Sheet1', kind: 'document', sheet: 'Orders', code: sheetCode },
    { name: 'Mail', kind: 'standard', code: 'Sub SendIt()\n  Dim o As Object\n  Set o = CreateObject("Outlook.Application")\n  Open "C:\\x.txt" For Output As #1\n  Print #1, "x"\n  Close #1\n  Call NotThere(1)\n  Range("A1").Interior.Color = vbYellow\nEnd Sub\nSub Partly()\n  ActiveSheet.Shapes("Logo").Visible = False\nEnd Sub\nPrivate Sub Worksheet_SelectionChange(ByVal t As Range)\nEnd Sub' }], wbv);
  var by = {}; an.procs.forEach(function (p) { by[p.name] = p; });
  eq(by.NewOrder.status, 'ok', 'checker: NewOrder is fine ' + JSON.stringify(by.NewOrder.issues));
  eq(by.FillLog.status, 'ok', 'checker: FillLog is fine ' + JSON.stringify(by.FillLog.issues));
  eq(by.Counting.status, 'ok', 'checker: Counting is fine ' + JSON.stringify(by.Counting.issues));
  eq(by.Worksheet_Change.event, 'Worksheet_Change', 'checker: events are recognised');
  eq(by.SendIt.status, 'no', 'checker: Outlook + files can\'t run');
  eq(by.SendIt.issues.length >= 3, true, 'checker: lists each problem ' + JSON.stringify(by.SendIt.issues));
  eq(by.Partly.status, 'partial', 'checker: unsupported members are "partial" ' + JSON.stringify(by.Partly.issues));
  eq(by.Grade.udf, true, 'checker: public functions can be used in formulas');

  // parsing odds and ends
  var tricky = VB.parse('Sub T()\n  If a Then b = 1 Else b = 2\n  If x > 1 Then\n    y = 1\n  ElseIf x = 0 Then\n    y = 2\n  Else\n    y = 3\n  End If\n  s = "He said ""hi"""\n  t = Cells(1, _\n     2).Value\n  Debug.Print "a"; "b"\n  arr = Array(1, 2, 3): n = arr(0)\nEnd Sub');
  eq(tricky.problems, [], 'single-line If/Else, ElseIf, quotes, line continuations, ":" and ";"');
  var run2 = new VB.Machine([{ name: 'M', code: 'Function F(x)\n  Dim i, s\n  For i = 10 To 1 Step -3\n    s = s & i & ","\n  Next\n  Do\n    x = x * 2\n  Loop Until x > 100\n  F = s & x & "|" & (7 \\ 2) & (7 Mod 3) & (2 ^ 3) & (Not True) & ("abc" Like "a*")\nEnd Function' }], wbv, {});
  wbv.udf = run2.udf;
  wbv.setCell('Orders', 4, 7, '=F(3)');
  eq(VV('G4'), '10,7,4,1,192|318FalseTrue', 'loops with Step, Do...Loop Until, operators');

  console.log(fails ? fails + ' FAILED of ' + count : 'ALL OK (' + count + ' engine checks)');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
