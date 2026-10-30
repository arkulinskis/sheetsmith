/* Sheetsmith engine, part 1: the workbook model, Excel formulas, number formats, validation and conditional formats.
   Runs in the Sheetsmith studio (analysis + preview) and inside every generated app. Plain ES5 + generators, no
   libraries. window.SE (or module.exports in Node for the tests).

   Model:  WB(blueprint, state)
     blueprint: what server_code/WorkbookReader.py read (sheets, styles, tables, names, vba ...)
     state:     the data that changes: {rev, sheets: {name: {cells: {A1: {v, f, s}}}}, tables: {name: {rows: [{id, c: [cell]}]}}}
     Tables are kept as rows (so people can add and delete rows safely from several devices); their header,
     calculated columns and totals row are "virtual" cells drawn from the table's definition.
   Changes go through wb.setCell / addRow / setRowCell / deleteRow / deleteRows / insertRows, which update the state and
   return ops ({t: 'cell'|'radd'|'rset'|'rdel'|'rowsdel'|'rowsins', ...}); runtime/server.py applies the same ops. */
(function (root) {
  'use strict';
  var SE = root.SE = root.SE || {};

  /* ------------------------------------------------------------------------------------------ references */
  function colIndex(s) { var n = 0; s = String(s).toUpperCase(); for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
  function colLetters(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
  function addr(r, c) { return colLetters(c) + r; }
  function parseA1(a) { var m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a).trim()); return m ? { r: +m[2], c: colIndex(m[1]) } : null; }
  function parseArea(t) {
    t = String(t).replace(/\$/g, '').trim();
    var p = t.split(':'), a, b;
    if (p.length === 1) { a = parseA1(p[0]); return a ? { r1: a.r, c1: a.c, r2: a.r, c2: a.c } : null; }
    if (/^[A-Za-z]{1,3}$/.test(p[0]) && /^[A-Za-z]{1,3}$/.test(p[1])) return { r1: 1, c1: colIndex(p[0]), r2: 1048576, c2: colIndex(p[1]) };
    if (/^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) return { r1: +p[0], c1: 1, r2: +p[1], c2: 16384 };
    a = parseA1(p[0]); b = parseA1(p[1]);
    if (!a || !b) return null;
    return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
  }
  SE.colIndex = colIndex; SE.colLetters = colLetters; SE.addr = addr; SE.parseA1 = parseA1; SE.parseArea = parseArea;

  /* ------------------------------------------------------------------------------------------ values */
  function XErr(code) { this.code = code; }
  XErr.prototype.toString = function () { return this.code; };
  var ERR = { div0: new XErr('#DIV/0!'), na: new XErr('#N/A'), value: new XErr('#VALUE!'), ref: new XErr('#REF!'),
    name: new XErr('#NAME?'), num: new XErr('#NUM!'), nul: new XErr('#NULL!'), calc: new XErr('#CALC!') };
  function isErr(v) { return v instanceof XErr; }
  function errOf(code) { for (var k in ERR) if (ERR[k].code === code) return ERR[k]; return new XErr(code); }
  SE.XErr = XErr; SE.ERR = ERR; SE.isErr = isErr; SE.errOf = errOf;

  /* Dates are Excel serial numbers (1900 system, with Excel's 29 Feb 1900). */
  var EPOCH = Date.UTC(1899, 11, 30);
  function serialToParts(serial) {
    var days = Math.floor(serial), frac = serial - days;
    var secs = Math.round(frac * 86400);
    if (secs >= 86400) { days += 1; secs -= 86400; }
    if (days === 60) return { y: 1900, m: 2, d: 29, dow: 4, H: Math.floor(secs / 3600), M: Math.floor(secs / 60) % 60, S: secs % 60 };
    var dd = days < 60 ? days + 1 : days;
    var dt = new Date(EPOCH + dd * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay(), H: Math.floor(secs / 3600), M: Math.floor(secs / 60) % 60, S: secs % 60 };
  }
  function dateToSerial(y, m, d) {
    var days = Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000);
    return days < 61 ? days - 1 : days;
  }
  function todaySerial() { var n = new Date(); return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate()); }
  function nowSerial() { var n = new Date(); return todaySerial() + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86400; }
  function isoToSerial(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || '').trim());
    if (!m) return null;
    var v = dateToSerial(+m[1], +m[2], +m[3]);
    if (m[4] != null) v += ((+m[4]) * 3600 + (+m[5]) * 60 + (+(m[6] || 0))) / 86400;
    return v;
  }
  function serialToIso(v, withTime) {
    var p = serialToParts(v), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var s = p.y + '-' + pad(p.m) + '-' + pad(p.d);
    if (withTime) s += 'T' + pad(p.H) + ':' + pad(p.M);
    return s;
  }
  SE.serialToParts = serialToParts; SE.dateToSerial = dateToSerial; SE.todaySerial = todaySerial; SE.nowSerial = nowSerial;
  SE.isoToSerial = isoToSerial; SE.serialToIso = serialToIso;

  function generalNum(n) {
    if (!isFinite(n)) return '#NUM!';
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    var a = Math.abs(n);
    if (a !== 0 && (a < 1e-9 || a >= 1e15)) return n.toExponential(5).replace(/\.?0+e/, 'E').replace('E+', 'E+');
    var s = n.toPrecision(15);
    if (s.indexOf('e') >= 0) s = String(n);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isErr(v)) return v;
    if (v && v.__date != null) return v.__date;
    var s = String(v).trim(), pct = false;
    if (/%$/.test(s)) { pct = true; s = s.slice(0, -1); }
    s = s.replace(/^[$€£¥]\s?/, '').replace(/,(?=\d{3}(\D|$))/g, '');
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return pct ? parseFloat(s) / 100 : parseFloat(s);
    var d = isoToSerial(s);
    if (d != null) return d;
    return ERR.value;
  }
  function toStr(v) {
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return generalNum(v);
    if (isErr(v)) return v.code;
    if (v && v.__date != null) return generalNum(v.__date);
    return String(v);
  }
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v == null || v === '') return false;
    if (isErr(v)) return v;
    var s = String(v).toUpperCase();
    if (s === 'TRUE') return true;
    if (s === 'FALSE') return false;
    return ERR.value;
  }
  SE.toNum = toNum; SE.toStr = toStr; SE.toBool = toBool; SE.generalNum = generalNum;

  /* ------------------------------------------------------------------------------------------ number formats */
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  SE.MONTHS = MONTHS; SE.DAYS = DAYS;
  function splitSections(fmt) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < fmt.length; i++) {
      var ch = fmt[i];
      if (ch === '"') q = !q;
      if (ch === '\\' && !q) { cur += ch + (fmt[i + 1] || ''); i++; continue; }
      if (ch === ';' && !q) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function stripCodes(sec) {
    var cur = null;
    sec = sec.replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, function (m, sym) { cur = sym; return sym ? '"' + sym + '"' : ''; });
    sec = sec.replace(/\[(Red|Black|Blue|Green|White|Yellow|Magenta|Cyan|Color\s*\d+)\]/gi, '').replace(/\[[<>=][^\]]*\]/g, '');
    return sec;
  }
  function isDateFmt(fmt) {
    if (!fmt || fmt === 'General') return false;
    var s = stripCodes(splitSections(fmt)[0]).replace(/"[^"]*"|\\.|_.|\*./g, '');
    if (/\[(h+|m+|s+)\]/i.test(s)) return true;
    return /[dy]/i.test(s) || /h/i.test(s) || (/s/i.test(s) && /m/i.test(s)) || /^m+$/i.test(s.replace(/[^a-z]/gi, ''));
  }
  function isTimeOnlyFmt(fmt) { var s = (fmt || '').replace(/"[^"]*"/g, ''); return isDateFmt(fmt) && !/[dy]/i.test(s) && /h/i.test(s); }
  SE.isDateFmt = isDateFmt; SE.isTimeOnlyFmt = isTimeOnlyFmt;
  function isPercentFmt(fmt) { return !!fmt && /%/.test(fmt.replace(/"[^"]*"/g, '')); }
  function currencyOf(fmt) {
    if (!fmt) return null;
    var m = /\[\$([^\]-]+)/.exec(fmt) || /"([$€£¥]|CHF|CAD|USD|EUR)"/.exec(fmt) || /([$€£¥])/.exec(fmt.replace(/"[^"]*"/g, function (q) { return /[$€£¥]/.test(q) ? q.replace(/"/g, '') : ''; }));
    return m ? m[1] : null;
  }
  SE.isPercentFmt = isPercentFmt; SE.currencyOf = currencyOf;

  function fmtDate(v, sec) {
    var p = serialToParts(v), out = '', i = 0, ampm = /AM\/PM|A\/P/i.test(sec), lastWasH = false;
    var pad = function (n, k) { n = String(n); while (n.length < k) n = '0' + n; return n; };
    var toks = [];
    while (i < sec.length) {
      var rest = sec.slice(i), m;
      if (rest[0] === '"') { var j = sec.indexOf('"', i + 1); if (j < 0) j = sec.length; toks.push(['lit', sec.slice(i + 1, j)]); i = j + 1; continue; }
      if (rest[0] === '\\') { toks.push(['lit', rest[1] || '']); i += 2; continue; }
      if (rest[0] === '_' || rest[0] === '*') { toks.push(['lit', rest[0] === '_' ? ' ' : '']); i += 2; continue; }
      if ((m = /^(AM\/PM|am\/pm|A\/P|a\/p)/.exec(rest))) { toks.push(['ampm', m[1]]); i += m[1].length; continue; }
      if ((m = /^\[(h+|m+|s+)\]/i.exec(rest))) { toks.push(['el', m[1].toLowerCase()]); i += m[0].length; continue; }
      if ((m = /^(y+|m+|d+|h+|s+)/i.exec(rest))) { toks.push(['t', m[1].toLowerCase()]); i += m[1].length; continue; }
      if ((m = /^\.0+/.exec(rest))) { toks.push(['frac', m[0].length - 1]); i += m[0].length; continue; }
      toks.push(['lit', rest[0]]); i++;
    }
    // m after h, or before s, means minutes
    for (var k = 0; k < toks.length; k++) {
      if (toks[k][0] !== 't' || toks[k][1][0] !== 'm') continue;
      var prev = null, next = null;
      for (var a = k - 1; a >= 0; a--) if (toks[a][0] === 't' || toks[a][0] === 'el') { prev = toks[a][1]; break; }
      for (var b = k + 1; b < toks.length; b++) if (toks[b][0] === 't' || toks[b][0] === 'el') { next = toks[b][1]; break; }
      if ((prev && prev[0] === 'h') || (next && next[0] === 's')) toks[k][0] = 'min';
    }
    toks.forEach(function (t) {
      var k = t[0], f = t[1];
      if (k === 'lit') out += f;
      else if (k === 'ampm') out += (p.H < 12 ? (f.length > 3 ? 'AM' : 'A') : (f.length > 3 ? 'PM' : 'P'));
      else if (k === 'el') { var tot = v * 24; out += f[0] === 'h' ? Math.floor(tot) : f[0] === 'm' ? Math.floor(tot * 60) : Math.floor(tot * 3600); }
      else if (k === 'min') out += f.length > 1 ? pad(p.M, 2) : p.M;
      else if (k === 'frac') out += '';
      else if (f[0] === 'y') out += f.length <= 2 ? pad(p.y % 100, 2) : p.y;
      else if (f[0] === 'm') out += f.length === 1 ? p.m : f.length === 2 ? pad(p.m, 2) : f.length === 3 ? MONTHS[p.m - 1].slice(0, 3) : f.length === 5 ? MONTHS[p.m - 1][0] : MONTHS[p.m - 1];
      else if (f[0] === 'd') out += f.length === 1 ? p.d : f.length === 2 ? pad(p.d, 2) : f.length === 3 ? DAYS[p.dow].slice(0, 3) : DAYS[p.dow];
      else if (f[0] === 'h') { var h = ampm ? ((p.H + 11) % 12) + 1 : p.H; out += f.length > 1 ? pad(h, 2) : h; }
      else if (f[0] === 's') out += f.length > 1 ? pad(p.S, 2) : p.S;
    });
    return out;
  }

  function fmtNumber(v, sec) {
    // literals and placeholders
    var pre = '', post = '', num = '', state = 0, i = 0, pctCount = 0, txt = '';
    while (i < sec.length) {
      var ch = sec[i];
      if (ch === '"') { var j = sec.indexOf('"', i + 1); if (j < 0) j = sec.length; txt = sec.slice(i + 1, j); i = j + 1; if (state === 0) pre += txt; else { post += txt; state = 2; } continue; }
      if (ch === '\\') { txt = sec[i + 1] || ''; i += 2; if (state === 0) pre += txt; else { post += txt; state = 2; } continue; }
      if (ch === '_') { i += 2; if (state === 0) pre += ' '; else { post += ' '; state = 2; } continue; }
      if (ch === '*') { i += 2; continue; }
      if (ch === '%') { pctCount++; if (state === 0) pre += '%'; else { post += '%'; state = 2; } i++; continue; }
      if (/[0#?.,]/.test(ch) && state !== 2) { num += ch; state = 1; i++; continue; }
      if ((ch === 'E' || ch === 'e') && state === 1 && /[+-]/.test(sec[i + 1] || '')) { num += sec.slice(i, i + 2); i += 2; while (/[0#]/.test(sec[i] || '')) num += sec[i++]; continue; }
      if (ch === '@') { i++; continue; }
      if (state === 0) pre += ch; else { post += ch; state = 2; }
      i++;
    }
    for (var k = 0; k < pctCount; k++) v *= 100;
    if (!num) return (pre + post).trim() || generalNum(v);
    if (/[eE][+-]/.test(num)) {
      var dec = (num.split('.')[1] || '').replace(/[eE].*/, '').length;
      return (pre + v.toExponential(dec).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2') + post).trim();
    }
    var m = /(,+)$/.exec(num);
    if (m && num.indexOf('.') < 0) { v = v / Math.pow(1000, m[1].length); num = num.slice(0, -m[1].length); }
    var parts = num.split('.'), intPat = parts[0], decPat = parts[1] || '';
    var decimals = decPat.replace(/[^0#?]/g, '').length, minDec = decPat.replace(/[^0]/g, '').length;
    var group = intPat.indexOf(',') >= 0, minInt = intPat.replace(/[^0]/g, '').length;
    var s = Math.abs(v).toFixed(decimals);
    var ip = s.split('.')[0], dp = s.split('.')[1] || '';
    while (dp.length > minDec && dp[dp.length - 1] === '0') dp = dp.slice(0, -1);
    if (ip === '0' && minInt === 0) ip = '';
    while (ip.length < minInt) ip = '0' + ip;
    if (group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var body = ip + (dp ? '.' + dp : (decPat && minDec ? '.' : ''));
    if (!body) body = '0';
    return ((v < 0 ? '-' : '') + pre + body + post).replace(/^-\s+/, '-').trim();
  }

  function formatValue(v, fmt) {
    if (v == null || v === '') return '';
    if (isErr(v)) return v.code;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v && v.__date != null) v = v.__date;
    if (typeof v === 'string') {
      if (fmt && fmt.indexOf('@') >= 0) { var ts = splitSections(fmt); var t = ts.length >= 4 ? ts[3] : (ts.length === 1 ? ts[0] : null); if (t) return t.replace(/"([^"]*)"/g, '$1').replace('@', v).replace(/_./g, ' ').trim(); }
      return v;
    }
    if (typeof v !== 'number') return String(v);
    if (!fmt || fmt === 'General' || fmt === '@') return generalNum(v);
    var secs = splitSections(fmt), sec = secs[0], neg = false;
    if (v < 0 && secs.length >= 2 && secs[1] !== '') { sec = secs[1]; neg = true; }
    else if (v === 0 && secs.length >= 3 && secs[2] !== '') sec = secs[2];
    sec = stripCodes(sec);
    if (sec === 'General') return generalNum(v);
    try {
      if (isDateFmt(sec)) return v < 0 ? '#####' : fmtDate(v, sec);
      var out = fmtNumber(neg ? -v : v, sec);
      return out;
    } catch (e) { return generalNum(v); }
  }
  SE.formatValue = formatValue;

  /* ------------------------------------------------------------------------------------------ formula tokenizer + parser */
  function FormulaError(msg) { this.message = msg; }
  FormulaError.prototype = Object.create(Error.prototype);

  function matchBracket(src, i) {
    var depth = 0;
    for (var j = i; j < src.length; j++) {
      var ch = src[j];
      if (ch === "'") { j++; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return j; }
    }
    throw new FormulaError('Unclosed [');
  }

  function tokenize(src) {
    var toks = [], i = 0, n = src.length, m;
    function prevOperand() { var p = toks[toks.length - 1]; return p && (/^(num|str|bool|err|ref|col|row|name|sref|array)$/.test(p.t) || p.v === ')'); }
    while (i < n) {
      var ch = src[i], rest = src.slice(i);
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        var j = i + 1, s = '';
        while (j < n) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; }
        if (j >= n) throw new FormulaError('Unclosed "');
        toks.push({ t: 'str', v: s }); i = j + 1; continue;
      }
      if (ch === '#') {
        m = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!)/i.exec(rest);
        if (m) { toks.push({ t: 'err', v: m[0].toUpperCase() }); i += m[0].length; continue; }
        throw new FormulaError('Unexpected #');
      }
      if (ch === "'") {
        var k = i + 1, nm = '';
        while (k < n) { if (src[k] === "'") { if (src[k + 1] === "'") { nm += "'"; k += 2; continue; } break; } nm += src[k++]; }
        if (src[k + 1] !== '!') throw new FormulaError('Bad sheet name');
        toks.push({ t: 'sheet', v: nm }); i = k + 2; continue;
      }
      if (ch === '{') {
        var e = src.indexOf('}', i);
        if (e < 0) throw new FormulaError('Unclosed {');
        var body = src.slice(i + 1, e);
        var rows = body.split(';').map(function (r) {
          return r.split(',').map(function (x) {
            x = x.trim();
            if (/^".*"$/.test(x)) return x.slice(1, -1).replace(/""/g, '"');
            if (/^(TRUE|FALSE)$/i.test(x)) return /^TRUE$/i.test(x);
            if (/^#/.test(x)) return errOf(x.toUpperCase());
            var f = parseFloat(x); return isNaN(f) ? x : f;
          });
        });
        toks.push({ t: 'array', v: rows }); i = e + 1; continue;
      }
      if (ch === '[') { var be = matchBracket(src, i); toks.push({ t: 'sref', table: null, spec: src.slice(i + 1, be) }); i = be + 1; continue; }
      if (!prevOperand() && (m = /^\$?\d+:\$?\d+(?![\d.])/.exec(rest))) { toks.push({ t: 'row', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if ((m = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![A-Za-z0-9_(\[.!])/.exec(rest))) { toks.push({ t: 'col', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(\[.!])/.exec(rest))) {
        toks.push({ t: 'ref', ac: !!m[1], c: colIndex(m[2]), ar: !!m[3], r: +m[4] }); i += m[0].length; continue;
      }
      if ((m = /^[A-Za-z_\\À-￿][A-Za-z0-9_.\\À-￿]*/.exec(rest))) {
        var id = m[0], after = src[i + id.length];
        i += id.length;
        if (after === '!') { toks.push({ t: 'sheet', v: id }); i++; continue; }
        if (after === '(') { toks.push({ t: 'func', v: id.toUpperCase().replace(/^_XLFN\./, '').replace(/^_XLWS\./, '') }); continue; }
        if (after === '[') { var be2 = matchBracket(src, i); toks.push({ t: 'sref', table: id, spec: src.slice(i + 1, be2) }); i = be2 + 1; continue; }
        if (/^(TRUE|FALSE)$/i.test(id)) { toks.push({ t: 'bool', v: /^TRUE$/i.test(id) }); continue; }
        toks.push({ t: 'name', v: id }); continue;
      }
      if ((m = /^(<=|>=|<>)/.exec(rest))) { toks.push({ t: 'op', v: m[1] }); i += 2; continue; }
      if ('+-*/^&=<>%,():;'.indexOf(ch) >= 0) { toks.push({ t: 'op', v: ch }); i++; continue; }
      throw new FormulaError('Unexpected "' + ch + '"');
    }
    return toks;
  }

  function parseFormula(src) {
    var toks = tokenize(String(src).replace(/^=/, '')), pos = 0;
    function peek() { return toks[pos]; }
    function isOp(v) { var t = toks[pos]; return t && t.t === 'op' && t.v === v; }
    function next() { return toks[pos++]; }
    function expect(v) { if (!isOp(v)) throw new FormulaError('Expected ' + v); pos++; }
    function cmp() {
      var a = concat();
      while (peek() && peek().t === 'op' && /^(=|<>|<|>|<=|>=)$/.test(peek().v)) { var op = next().v; a = { t: 'bin', op: op, a: a, b: concat() }; }
      return a;
    }
    function concat() { var a = add(); while (isOp('&')) { next(); a = { t: 'bin', op: '&', a: a, b: add() }; } return a; }
    function add() { var a = mul(); while (isOp('+') || isOp('-')) { var op = next().v; a = { t: 'bin', op: op, a: a, b: mul() }; } return a; }
    function mul() { var a = pow(); while (isOp('*') || isOp('/')) { var op = next().v; a = { t: 'bin', op: op, a: a, b: pow() }; } return a; }
    function pow() { var a = pct(); while (isOp('^')) { next(); a = { t: 'bin', op: '^', a: a, b: pct() }; } return a; }
    function pct() { var a = unary(); while (isOp('%')) { next(); a = { t: 'pct', a: a }; } return a; }
    function unary() {
      if (isOp('-')) { next(); return { t: 'neg', a: unary() }; }
      if (isOp('+')) { next(); return unary(); }
      return range();
    }
    function range() {
      var a = primary();
      while (isOp(':')) { next(); var b = primary(); a = { t: 'area', a: a, b: b }; }
      return a;
    }
    function primary() {
      var t = next();
      if (!t) throw new FormulaError('Unexpected end of formula');
      if (t.t === 'num') return { t: 'num', v: t.v };
      if (t.t === 'str') return { t: 'str', v: t.v };
      if (t.t === 'bool') return { t: 'bool', v: t.v };
      if (t.t === 'err') return { t: 'err', v: t.v };
      if (t.t === 'array') return { t: 'array', v: t.v };
      if (t.t === 'ref') return { t: 'ref', r: t.r, c: t.c, ar: t.ar, ac: t.ac, sheet: null };
      if (t.t === 'col') { var cp = t.v.split(':'); return { t: 'cols', c1: colIndex(cp[0].replace('$', '')), c2: colIndex(cp[1].replace('$', '')), sheet: null }; }
      if (t.t === 'row') { var rp = t.v.replace(/\$/g, '').split(':'); return { t: 'rows', r1: +rp[0], r2: +rp[1], sheet: null }; }
      if (t.t === 'sref') return { t: 'sref', table: t.table, spec: parseSpec(t.spec) };
      if (t.t === 'name') return { t: 'name', v: t.v };
      if (t.t === 'sheet') {
        var inner = primary();
        if (inner.t === 'ref' || inner.t === 'cols' || inner.t === 'rows' || inner.t === 'name') { inner.sheet = t.v; return inner; }
        throw new FormulaError('Bad reference after sheet name');
      }
      if (t.t === 'func') {
        expect('(');
        var args = [];
        if (!isOp(')')) {
          for (;;) {
            if (isOp(',')) { args.push({ t: 'missing' }); next(); continue; }
            if (isOp(')')) { args.push({ t: 'missing' }); break; }
            args.push(cmp());
            if (isOp(',')) { next(); if (isOp(')')) { args.push({ t: 'missing' }); break; } continue; }
            break;
          }
        }
        expect(')');
        return { t: 'call', name: t.v, args: args };
      }
      if (t.t === 'op' && t.v === '(') { var e = cmp(); expect(')'); return { t: 'paren', a: e }; }
      throw new FormulaError('Unexpected "' + (t.v != null ? t.v : t.t) + '"');
    }
    var ast = cmp();
    if (pos < toks.length) throw new FormulaError('Unexpected "' + (toks[pos].v != null ? toks[pos].v : toks[pos].t) + '"');
    return ast;
  }

  /* Structured reference spec, e.g. "@Qty", "@[Unit price]", "[#This Row],[Qty]", "#All", "[Col1]:[Col2]", "" */
  function unq(s) { return s.replace(/'(.)/g, '$1').trim(); }
  function parseSpec(spec) {
    spec = spec.trim();
    var out = { area: 'data', c1: null, c2: null };
    if (spec === '') return out;
    if (spec[0] === '@') {
      out.area = 'row';
      var rest = spec.slice(1).trim();
      if (rest[0] === '[') rest = rest.slice(1, -1);
      if (rest) out.c1 = out.c2 = unq(rest);
      return out;
    }
    if (spec[0] !== '[') {
      if (spec[0] === '#') out.area = spec.slice(1).toLowerCase().replace(/\s+/g, '');
      else out.c1 = out.c2 = unq(spec);
      if (out.area === 'thisrow') out.area = 'row';
      return out;
    }
    // [..],[..] or [..]:[..]
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < spec.length; i++) {
      var ch = spec[i];
      if (ch === "'") { cur += ch + (spec[i + 1] || ''); i++; continue; }
      if (ch === '[') { depth++; if (depth === 1) { cur = ''; continue; } }
      if (ch === ']') { depth--; if (depth === 0) { parts.push(cur); continue; } }
      if (depth === 0) { if (ch === ':') parts.push(':'); continue; }
      cur += ch;
    }
    var cols = [];
    for (var p = 0; p < parts.length; p++) {
      var x = parts[p];
      if (x === ':') continue;
      if (x[0] === '#') {
        var a = x.slice(1).toLowerCase().replace(/\s+/g, '');
        out.area = a === 'thisrow' ? 'row' : a;
      } else cols.push(unq(x));
    }
    if (cols.length) { out.c1 = cols[0]; out.c2 = cols[cols.length - 1]; }
    return out;
  }
  SE.parseFormula = parseFormula; SE.tokenize = tokenize; SE.FormulaError = FormulaError;

  /* ------------------------------------------------------------------------------------------ ranges */
  function Rng(wb, sheet, r1, c1, r2, c2) { this.wb = wb; this.sheet = sheet; this.r1 = r1; this.c1 = c1; this.r2 = r2; this.c2 = c2; }
  Rng.prototype.rows = function () { return this.r2 - this.r1 + 1; };
  Rng.prototype.cols = function () { return this.c2 - this.c1 + 1; };
  Rng.prototype.get = function (i, j) { return this.wb.value(this.sheet, this.r1 + i, this.c1 + j); };
  /* Whole-column ranges are clipped to the rows that have data. */
  Rng.prototype.clip = function () {
    var maxR = this.wb.maxRow(this.sheet), maxC = this.wb.maxCol(this.sheet);
    return new Rng(this.wb, this.sheet, this.r1, this.c1, Math.min(this.r2, Math.max(maxR, this.r1)), Math.min(this.c2, Math.max(maxC, this.c1)));
  };
  Rng.prototype.each = function (fn) {
    var c = this.clip();
    for (var r = c.r1; r <= c.r2; r++) for (var k = c.c1; k <= c.c2; k++) fn(this.wb.value(this.sheet, r, k), r, k);
  };
  Rng.prototype.matrix = function () {
    var c = this.clip(), out = [];
    for (var r = c.r1; r <= c.r2; r++) { var row = []; for (var k = c.c1; k <= c.c2; k++) row.push(this.wb.value(this.sheet, r, k)); out.push(row); }
    return out;
  };
  Rng.prototype.address = function () { return addr(this.r1, this.c1) + (this.r1 === this.r2 && this.c1 === this.c2 ? '' : ':' + addr(this.r2, this.c2)); };
  SE.Rng = Rng;

  function isRng(v) { return v instanceof Rng; }
  function matrixOf(v) {
    if (isRng(v)) return v.matrix();
    if (Array.isArray(v)) return Array.isArray(v[0]) ? v : [v];
    return [[v]];
  }
  function flat(args, opts) {
    var out = [];
    args.forEach(function (a) {
      if (isRng(a)) a.each(function (v) { out.push(v); });
      else if (Array.isArray(a)) matrixOf(a).forEach(function (r) { r.forEach(function (v) { out.push(v); }); });
      else out.push(opts && opts.direct ? { direct: a } : a);
    });
    return out;
  }
  /* Numbers in ranges count; text and blanks in ranges are skipped. Direct arguments are converted. */
  function nums(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (isRng(a) || Array.isArray(a)) {
        var vals = flat([a]);
        for (var j = 0; j < vals.length; j++) { var v = vals[j]; if (isErr(v)) throw v; if (typeof v === 'number') out.push(v); }
      } else {
        if (a == null) continue;
        var n = toNum(a); if (isErr(n)) throw n; out.push(n);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------------------------------ criteria (COUNTIF etc.) */
  function wildRe(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '~' && i + 1 < s.length) { out += s[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      out += ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + out + '$', 'i');
  }
  function criteria(c) {
    if (isRng(c)) c = c.get(0, 0);
    if (typeof c === 'number' || typeof c === 'boolean') return function (v) { return v === c || (typeof c === 'number' && typeof v === 'string' && toNum(v) === c); };
    var s = toStr(c), m = /^(<=|>=|<>|=|<|>)?(.*)$/.exec(s), op = m[1] || '=', rhs = m[2];
    var n = rhs === '' ? null : toNum(rhs), isN = typeof n === 'number';
    var re = /[*?]/.test(rhs) ? wildRe(rhs) : null;
    return function (v) {
      if (isErr(v)) return false;
      if (op === '=' || op === '<>') {
        var eq;
        if (rhs === '') eq = v == null || v === '';
        else if (isN && typeof v === 'number') eq = v === n;
        else if (re) eq = typeof v === 'string' && re.test(v);
        else eq = v != null && toStr(v).toLowerCase() === rhs.toLowerCase();
        return op === '=' ? eq : !eq;
      }
      if (isN) { if (typeof v !== 'number') return false; return op === '<' ? v < n : op === '>' ? v > n : op === '<=' ? v <= n : v >= n; }
      if (typeof v !== 'string') return false;
      var a = v.toLowerCase(), b = rhs.toLowerCase();
      return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
    };
  }
  SE.criteria = criteria;

  /* Excel comparison: numbers < text < booleans; text ignores case; blank is 0 or "" */
  function compare(a, b) {
    if (a == null || a === '') a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b == null || b === '') b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    var rank = function (v) { return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2; };
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === 1) { a = a.toLowerCase(); b = b.toLowerCase(); }
    if (ra === 2) { a = a ? 1 : 0; b = b ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  SE.compare = compare;

  /* ------------------------------------------------------------------------------------------ functions */
  var FN = {};
  SE.FN = FN;
  function def(names, f, lazy) { names.split(' ').forEach(function (n) { FN[n] = f; if (lazy) f.lazy = true; }); }
  function argN(a, i, d) { return a.length > i && a[i] !== undefined && a[i] !== MISSING ? a[i] : d; }
  var MISSING = { missing: true };
  function num1(v) { if (isRng(v)) v = scalarOf(v); var n = toNum(v); if (isErr(n)) throw n; return n; }
  function str1(v) { if (isRng(v)) v = scalarOf(v); if (isErr(v)) throw v; return toStr(v); }
  function bool1(v) { if (isRng(v)) v = scalarOf(v); var b = toBool(v); if (isErr(b)) throw b; return b; }
  var CTX = null;  // the cell being calculated (for implicit intersection, ROW(), [@Col])
  function scalarOf(v) {
    if (!isRng(v)) { if (Array.isArray(v)) return matrixOf(v)[0][0]; return v; }
    if (v.r1 === v.r2 && v.c1 === v.c2) return v.get(0, 0);
    if (CTX && v.sheet === CTX.sheet) {
      if (v.c1 === v.c2 && CTX.row >= v.r1 && CTX.row <= v.r2) return v.wb.value(v.sheet, CTX.row, v.c1);
      if (v.r1 === v.r2 && CTX.col >= v.c1 && CTX.col <= v.c2) return v.wb.value(v.sheet, v.r1, CTX.col);
    }
    return ERR.value;
  }
  SE.scalarOf = scalarOf;
  function roundTo(n, d) { var f = Math.pow(10, d); var x = Math.abs(n) * f; x = Math.round(+(x.toFixed(9))); return (n < 0 ? -x : x) / f; }

  def('SUM', function (a) { return nums(a).reduce(function (s, x) { return s + x; }, 0); });
  def('PRODUCT', function (a) { return nums(a).reduce(function (s, x) { return s * x; }, 1); });
  def('AVERAGE', function (a) { var n = nums(a); if (!n.length) return ERR.div0; return n.reduce(function (s, x) { return s + x; }, 0) / n.length; });
  def('MIN', function (a) { var n = nums(a); return n.length ? Math.min.apply(null, n) : 0; });
  def('MAX', function (a) { var n = nums(a); return n.length ? Math.max.apply(null, n) : 0; });
  def('MEDIAN', function (a) { var n = nums(a).sort(function (x, y) { return x - y; }); if (!n.length) return ERR.num; var h = Math.floor(n.length / 2); return n.length % 2 ? n[h] : (n[h - 1] + n[h]) / 2; });
  def('COUNT', function (a) { return flat(a).filter(function (v) { return typeof v === 'number'; }).length; });
  def('COUNTA', function (a) { return flat(a).filter(function (v) { return v != null && v !== ''; }).length; });
  def('COUNTBLANK', function (a) { return flat(a).filter(function (v) { return v == null || v === ''; }).length; });
  def('STDEV STDEV.S', function (a) { var n = nums(a); if (n.length < 2) return ERR.div0; var m = n.reduce(function (s, x) { return s + x; }, 0) / n.length; return Math.sqrt(n.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (n.length - 1)); });
  def('STDEVP STDEV.P', function (a) { var n = nums(a); if (!n.length) return ERR.div0; var m = n.reduce(function (s, x) { return s + x; }, 0) / n.length; return Math.sqrt(n.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / n.length); });
  def('LARGE', function (a) { var n = nums([a[0]]).sort(function (x, y) { return y - x; }), k = num1(a[1]); return k >= 1 && k <= n.length ? n[Math.ceil(k) - 1] : ERR.num; });
  def('SMALL', function (a) { var n = nums([a[0]]).sort(function (x, y) { return x - y; }), k = num1(a[1]); return k >= 1 && k <= n.length ? n[Math.ceil(k) - 1] : ERR.num; });
  def('RANK RANK.EQ', function (a) { var v = num1(a[0]), n = nums([a[1]]), asc = argN(a, 2, 0) && num1(a[2]); var r = 1; n.forEach(function (x) { if (asc ? x < v : x > v) r++; }); return n.indexOf(v) < 0 ? ERR.na : r; });
  def('ROUND', function (a) { return roundTo(num1(a[0]), num1(argN(a, 1, 0))); });
  def('ROUNDUP', function (a) { var n = num1(a[0]), f = Math.pow(10, num1(argN(a, 1, 0))); return (n < 0 ? -1 : 1) * Math.ceil(+(Math.abs(n) * f).toFixed(9)) / f; });
  def('ROUNDDOWN TRUNC', function (a) { var n = num1(a[0]), f = Math.pow(10, num1(argN(a, 1, 0))); return (n < 0 ? -1 : 1) * Math.floor(+(Math.abs(n) * f).toFixed(9)) / f; });
  def('MROUND', function (a) { var n = num1(a[0]), m = num1(a[1]); return m === 0 ? 0 : roundTo(n / m, 0) * m; });
  def('CEILING CEILING.MATH', function (a) { var n = num1(a[0]), s = num1(argN(a, 1, 1)); return s === 0 ? 0 : Math.ceil(n / s) * s; });
  def('FLOOR FLOOR.MATH', function (a) { var n = num1(a[0]), s = num1(argN(a, 1, 1)); return s === 0 ? 0 : Math.floor(n / s) * s; });
  def('INT', function (a) { return Math.floor(num1(a[0])); });
  def('ABS', function (a) { return Math.abs(num1(a[0])); });
  def('SIGN', function (a) { return Math.sign(num1(a[0])); });
  def('MOD', function (a) { var n = num1(a[0]), d = num1(a[1]); if (d === 0) return ERR.div0; return n - d * Math.floor(n / d); });
  def('POWER', function (a) { return Math.pow(num1(a[0]), num1(a[1])); });
  def('SQRT', function (a) { var n = num1(a[0]); return n < 0 ? ERR.num : Math.sqrt(n); });
  def('EXP', function (a) { return Math.exp(num1(a[0])); });
  def('LN', function (a) { var n = num1(a[0]); return n <= 0 ? ERR.num : Math.log(n); });
  def('LOG', function (a) { var n = num1(a[0]), b = num1(argN(a, 1, 10)); return n <= 0 ? ERR.num : Math.log(n) / Math.log(b); });
  def('LOG10', function (a) { var n = num1(a[0]); return n <= 0 ? ERR.num : Math.log(n) / Math.LN10; });
  def('PI', function () { return Math.PI; });
  def('RAND', function () { return Math.random(); });
  def('RANDBETWEEN', function (a) { var lo = Math.ceil(num1(a[0])), hi = Math.floor(num1(a[1])); return lo + Math.floor(Math.random() * (hi - lo + 1)); });
  def('SUMPRODUCT', function (a) {
    var ms = a.map(matrixOf), rows = ms[0].length, cols = ms[0][0].length, s = 0;
    for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) {
      var p = 1;
      for (var k = 0; k < ms.length; k++) { var v = (ms[k][i] || [])[j]; if (isErr(v)) return v; p *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0; }
      s += p;
    }
    return s;
  });
  function ifsCore(a, start, rangeArg) {
    // pairs (range, criterion) from `start`; returns list of [i, j] positions that match all
    var pairs = [];
    for (var i = start; i + 1 < a.length; i += 2) pairs.push([matrixOf(a[i]), criteria(a[i + 1])]);
    var base = rangeArg != null ? matrixOf(rangeArg) : pairs[0][0], out = [];
    for (var r = 0; r < base.length; r++) for (var c = 0; c < base[r].length; c++) {
      if (pairs.every(function (p) { return p[0][r] && p[1](p[0][r][c]); })) out.push([r, c]);
    }
    return { base: base, hits: out };
  }
  def('COUNTIF', function (a) { var f = criteria(a[1]); return flat([a[0]]).filter(f).length; });
  def('COUNTIFS', function (a) { return ifsCore(a, 0).hits.length; });
  def('SUMIF', function (a) {
    var f = criteria(a[1]), test = matrixOf(a[0]), sum = matrixOf(argN(a, 2, a[0])), s = 0;
    for (var r = 0; r < test.length; r++) for (var c = 0; c < test[r].length; c++) if (f(test[r][c])) { var v = (sum[r] || [])[c]; if (typeof v === 'number') s += v; }
    return s;
  });
  def('SUMIFS', function (a) { var x = ifsCore(a, 1, a[0]); return x.hits.reduce(function (s, p) { var v = x.base[p[0]][p[1]]; return s + (typeof v === 'number' ? v : 0); }, 0); });
  def('AVERAGEIF', function (a) {
    var f = criteria(a[1]), test = matrixOf(a[0]), sum = matrixOf(argN(a, 2, a[0])), s = 0, n = 0;
    for (var r = 0; r < test.length; r++) for (var c = 0; c < test[r].length; c++) if (f(test[r][c])) { var v = (sum[r] || [])[c]; if (typeof v === 'number') { s += v; n++; } }
    return n ? s / n : ERR.div0;
  });
  def('AVERAGEIFS', function (a) { var x = ifsCore(a, 1, a[0]); var v = x.hits.map(function (p) { return x.base[p[0]][p[1]]; }).filter(function (q) { return typeof q === 'number'; }); return v.length ? v.reduce(function (s, q) { return s + q; }, 0) / v.length : ERR.div0; });
  def('MAXIFS', function (a) { var x = ifsCore(a, 1, a[0]); var v = x.hits.map(function (p) { return x.base[p[0]][p[1]]; }).filter(function (q) { return typeof q === 'number'; }); return v.length ? Math.max.apply(null, v) : 0; });
  def('MINIFS', function (a) { var x = ifsCore(a, 1, a[0]); var v = x.hits.map(function (p) { return x.base[p[0]][p[1]]; }).filter(function (q) { return typeof q === 'number'; }); return v.length ? Math.min.apply(null, v) : 0; });

  // logic (lazy: they get [node, ...] and evaluate what they need)
  def('IF', function (a, ev) {
    var c = scalarOf(ev(a[0])); if (isErr(c)) return c;
    var b = toBool(c); if (isErr(b)) return b;
    if (b) return a.length > 1 && a[1].t !== 'missing' ? ev(a[1]) : (a.length > 1 ? 0 : true);
    return a.length > 2 ? (a[2].t === 'missing' ? 0 : ev(a[2])) : false;
  }, true);
  def('IFERROR', function (a, ev) { var v; try { v = ev(a[0]); if (isRng(v)) v = scalarOf(v); } catch (e) { v = ERR.value; } return isErr(v) ? ev(a[1]) : v; }, true);
  def('IFNA', function (a, ev) { var v = ev(a[0]); if (isRng(v)) v = scalarOf(v); return isErr(v) && v.code === '#N/A' ? ev(a[1]) : v; }, true);
  def('IFS', function (a, ev) { for (var i = 0; i + 1 < a.length; i += 2) { var c = scalarOf(ev(a[i])); if (isErr(c)) return c; if (toBool(c) === true) return ev(a[i + 1]); } return ERR.na; }, true);
  def('SWITCH', function (a, ev) {
    var v = scalarOf(ev(a[0])), i = 1;
    for (; i + 1 < a.length; i += 2) { if (compare(v, scalarOf(ev(a[i]))) === 0) return ev(a[i + 1]); }
    return i < a.length ? ev(a[i]) : ERR.na;
  }, true);
  def('CHOOSE', function (a, ev) { var i = Math.floor(num1(ev(a[0]))); return i >= 1 && i < a.length ? ev(a[i]) : ERR.value; }, true);
  def('AND', function (a) { var vals = flat(a).filter(function (v) { return v != null && v !== ''; }); for (var i = 0; i < vals.length; i++) { var b = toBool(vals[i]); if (isErr(b)) { if (typeof vals[i] === 'string') continue; return b; } if (!b) return false; } return true; });
  def('OR', function (a) { var vals = flat(a); for (var i = 0; i < vals.length; i++) { if (vals[i] == null || vals[i] === '' ) continue; var b = toBool(vals[i]); if (isErr(b)) { if (typeof vals[i] === 'string') continue; return b; } if (b) return true; } return false; });
  def('XOR', function (a) { return flat(a).filter(function (v) { return toBool(v) === true; }).length % 2 === 1; });
  def('NOT', function (a) { return !bool1(a[0]); });
  def('TRUE', function () { return true; });
  def('FALSE', function () { return false; });
  def('NA', function () { return ERR.na; });
  def('ISBLANK', function (a) { var v = isRng(a[0]) ? a[0].get(0, 0) : a[0]; return v == null || v === ''; });
  def('ISNUMBER', function (a) { return typeof scalarOf(a[0]) === 'number'; });
  def('ISTEXT', function (a) { return typeof scalarOf(a[0]) === 'string' && scalarOf(a[0]) !== ''; });
  def('ISNONTEXT', function (a) { return typeof scalarOf(a[0]) !== 'string'; });
  def('ISLOGICAL', function (a) { return typeof scalarOf(a[0]) === 'boolean'; });
  def('ISERROR ISERR', function (a) { return isErr(scalarOf(a[0])); });
  def('ISNA', function (a) { var v = scalarOf(a[0]); return isErr(v) && v.code === '#N/A'; });
  def('ISEVEN', function (a) { return Math.floor(num1(a[0])) % 2 === 0; });
  def('ISODD', function (a) { return Math.abs(Math.floor(num1(a[0])) % 2) === 1; });
  def('N', function (a) { var v = scalarOf(a[0]); return typeof v === 'number' ? v : v === true ? 1 : 0; });

  // text
  def('LEN', function (a) { return str1(a[0]).length; });
  def('LEFT', function (a) { return str1(a[0]).slice(0, num1(argN(a, 1, 1))); });
  def('RIGHT', function (a) { var s = str1(a[0]), n = num1(argN(a, 1, 1)); return n <= 0 ? '' : s.slice(-n); });
  def('MID', function (a) { var s = str1(a[0]), st = num1(a[1]), n = num1(a[2]); if (st < 1) return ERR.value; return s.substr(st - 1, n); });
  def('UPPER', function (a) { return str1(a[0]).toUpperCase(); });
  def('LOWER', function (a) { return str1(a[0]).toLowerCase(); });
  def('PROPER', function (a) { return str1(a[0]).toLowerCase().replace(/(^|[^a-zÀ-￿])([a-zÀ-￿])/g, function (m, p, c) { return p + c.toUpperCase(); }); });
  def('TRIM', function (a) { return str1(a[0]).replace(/ +/g, ' ').trim(); });
  def('CLEAN', function (a) { return str1(a[0]).replace(/[\x00-\x1f]/g, ''); });
  def('CONCAT CONCATENATE', function (a) { return flat(a).map(function (v) { if (isErr(v)) throw v; return toStr(v); }).join(''); });
  def('TEXTJOIN', function (a) {
    var sep = str1(a[0]), skip = bool1(a[1]);
    var vals = flat(a.slice(2)).filter(function (v) { return !(skip && (v == null || v === '')); });
    return vals.map(function (v) { if (isErr(v)) throw v; return toStr(v); }).join(sep);
  });
  def('REPT', function (a) { var n = Math.floor(num1(a[1])); return n < 0 ? ERR.value : new Array(n + 1).join(str1(a[0])); });
  def('SUBSTITUTE', function (a) {
    var s = str1(a[0]), o = str1(a[1]), nw = str1(a[2]), inst = argN(a, 3, null);
    if (!o) return s;
    if (inst == null) return s.split(o).join(nw);
    var k = num1(inst), idx = -1;
    for (var i = 0; i < k; i++) { idx = s.indexOf(o, idx + 1); if (idx < 0) return s; }
    return s.slice(0, idx) + nw + s.slice(idx + o.length);
  });
  def('REPLACE', function (a) { var s = str1(a[0]), st = num1(a[1]), n = num1(a[2]); return s.slice(0, st - 1) + str1(a[3]) + s.slice(st - 1 + n); });
  def('FIND', function (a) { var f = str1(a[0]), s = str1(a[1]), st = num1(argN(a, 2, 1)); var i = s.indexOf(f, st - 1); return i < 0 ? ERR.value : i + 1; });
  def('SEARCH', function (a) {
    var f = str1(a[0]), s = str1(a[1]), st = num1(argN(a, 2, 1));
    var re = /[*?]/.test(f) ? new RegExp(wildRe(f).source.slice(1, -1), 'i') : null;
    if (re) { var m = re.exec(s.slice(st - 1)); return m ? m.index + st : ERR.value; }
    var i = s.toLowerCase().indexOf(f.toLowerCase(), st - 1); return i < 0 ? ERR.value : i + 1;
  });
  def('EXACT', function (a) { return str1(a[0]) === str1(a[1]); });
  def('VALUE NUMBERVALUE', function (a) { var v = scalarOf(a[0]); if (typeof v === 'number') return v; var n = toNum(v); return n; });
  def('TEXT', function (a) { var v = scalarOf(a[0]); if (isErr(v)) return v; var f = str1(a[1]); if (typeof v === 'string') { var n = toNum(v); if (typeof n === 'number') v = n; } return formatValue(v, f); });
  def('FIXED', function (a) { var d = num1(argN(a, 1, 2)); return formatValue(num1(a[0]), d > 0 ? '#,##0.' + new Array(d + 1).join('0') : '#,##0'); });
  def('DOLLAR', function (a) { var d = num1(argN(a, 1, 2)); return formatValue(num1(a[0]), '$#,##0' + (d > 0 ? '.' + new Array(d + 1).join('0') : '')); });
  def('CHAR', function (a) { return String.fromCharCode(num1(a[0])); });
  def('CODE', function (a) { var s = str1(a[0]); return s ? s.charCodeAt(0) : ERR.value; });
  def('T', function (a) { var v = scalarOf(a[0]); return typeof v === 'string' ? v : ''; });
  def('TEXTBEFORE', function (a) { var s = str1(a[0]), d = str1(a[1]), i = s.indexOf(d); return i < 0 ? ERR.na : s.slice(0, i); });
  def('TEXTAFTER', function (a) { var s = str1(a[0]), d = str1(a[1]), i = s.indexOf(d); return i < 0 ? ERR.na : s.slice(i + d.length); });

  // dates
  def('TODAY', function () { return todaySerial(); });
  def('NOW', function () { return nowSerial(); });
  def('DATE', function (a) {
    var y = Math.floor(num1(a[0])), m = Math.floor(num1(a[1])), d = Math.floor(num1(a[2]));
    if (y < 1900) y += 1900;
    var dt = new Date(Date.UTC(y, m - 1, 1));
    return dateToSerial(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) + d - 1;
  });
  def('TIME', function (a) { return ((num1(a[0]) * 3600 + num1(a[1]) * 60 + num1(a[2])) / 86400) % 1; });
  def('YEAR', function (a) { return serialToParts(num1(a[0])).y; });
  def('MONTH', function (a) { return serialToParts(num1(a[0])).m; });
  def('DAY', function (a) { return serialToParts(num1(a[0])).d; });
  def('HOUR', function (a) { return serialToParts(num1(a[0])).H; });
  def('MINUTE', function (a) { return serialToParts(num1(a[0])).M; });
  def('SECOND', function (a) { return serialToParts(num1(a[0])).S; });
  def('WEEKDAY', function (a) {
    var dow = serialToParts(num1(a[0])).dow, t = num1(argN(a, 1, 1));
    if (t === 2) return dow === 0 ? 7 : dow; if (t === 3) return dow === 0 ? 6 : dow - 1; return dow + 1;
  });
  def('WEEKNUM', function (a) { var p = serialToParts(num1(a[0])); var jan1 = dateToSerial(p.y, 1, 1); var d1 = serialToParts(jan1).dow; return Math.floor((num1(a[0]) - jan1 + d1) / 7) + 1; });
  def('EDATE', function (a) { var p = serialToParts(num1(a[0])), m = p.m - 1 + Math.floor(num1(a[1])); var y = p.y + Math.floor(m / 12); m = ((m % 12) + 12) % 12; var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return dateToSerial(y, m + 1, Math.min(p.d, last)); });
  def('EOMONTH', function (a) { var p = serialToParts(num1(a[0])), m = p.m - 1 + Math.floor(num1(a[1])); var y = p.y + Math.floor(m / 12); m = ((m % 12) + 12) % 12; return dateToSerial(y, m + 2, 1) - 1; });
  def('DATEDIF', function (a) {
    var s = num1(a[0]), e = num1(a[1]), u = str1(a[2]).toUpperCase();
    if (s > e) return ERR.num;
    var ps = serialToParts(s), pe = serialToParts(e);
    var months = (pe.y - ps.y) * 12 + (pe.m - ps.m) - (pe.d < ps.d ? 1 : 0);
    if (u === 'D') return Math.floor(e) - Math.floor(s);
    if (u === 'M') return months;
    if (u === 'Y') return Math.floor(months / 12);
    if (u === 'YM') return months % 12;
    if (u === 'MD') return pe.d >= ps.d ? pe.d - ps.d : pe.d + new Date(Date.UTC(pe.y, pe.m - 1, 0)).getUTCDate() - ps.d;
    if (u === 'YD') { var t = dateToSerial(pe.y, ps.m, ps.d); if (t > e) t = dateToSerial(pe.y - 1, ps.m, ps.d); return Math.floor(e - t); }
    return ERR.num;
  });
  def('DAYS', function (a) { return Math.floor(num1(a[0])) - Math.floor(num1(a[1])); });
  def('NETWORKDAYS', function (a) {
    var s = Math.floor(num1(a[0])), e = Math.floor(num1(a[1])), sign = 1;
    if (s > e) { var t = s; s = e; e = t; sign = -1; }
    var hol = a.length > 2 ? nums([a[2]]).map(Math.floor) : [], n = 0;
    for (var d = s; d <= e; d++) { var w = serialToParts(d).dow; if (w !== 0 && w !== 6 && hol.indexOf(d) < 0) n++; }
    return n * sign;
  });
  def('WORKDAY', function (a) {
    var d = Math.floor(num1(a[0])), n = Math.floor(num1(a[1])), step = n < 0 ? -1 : 1, hol = a.length > 2 ? nums([a[2]]).map(Math.floor) : [];
    while (n !== 0) { d += step; var w = serialToParts(d).dow; if (w !== 0 && w !== 6 && hol.indexOf(d) < 0) n -= step; }
    return d;
  });
  def('DATEVALUE', function (a) { var v = toNum(str1(a[0])); return typeof v === 'number' ? Math.floor(v) : ERR.value; });
  def('YEARFRAC', function (a) { return Math.abs(num1(a[1]) - num1(a[0])) / 365.25; });

  // lookup
  function lookupIndex(v, list, mode) {
    // mode 0: exact (wildcards for text), 1: largest <= v (sorted asc), -1: smallest >= v (sorted desc)
    if (mode === 0) {
      var re = typeof v === 'string' && /[*?~]/.test(v) ? wildRe(v) : null;
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        if (re ? typeof x === 'string' && re.test(x) : (x != null && x !== '' && compare(x, v) === 0 && typeof x === typeof v) || (typeof x === 'string' && typeof v === 'string' && x.toLowerCase() === v.toLowerCase())) return i;
      }
      return -1;
    }
    var best = -1;
    for (var j = 0; j < list.length; j++) {
      var y = list[j];
      if (y == null || y === '' || typeof y !== typeof v) continue;
      var c = compare(y, v);
      if (mode === 1) { if (c <= 0) best = j; else break; } else { if (c >= 0) best = j; else break; }
    }
    return best;
  }
  def('VLOOKUP', function (a) {
    var v = scalarOf(a[0]); if (isErr(v)) return v;
    var m = matrixOf(a[1]), col = Math.floor(num1(a[2])), approx = a.length > 3 ? bool1(a[3]) : true;
    if (col < 1 || (m[0] && col > m[0].length)) return ERR.ref;
    var i = lookupIndex(v, m.map(function (r) { return r[0]; }), approx ? 1 : 0);
    return i < 0 ? ERR.na : m[i][col - 1];
  });
  def('HLOOKUP', function (a) {
    var v = scalarOf(a[0]); if (isErr(v)) return v;
    var m = matrixOf(a[1]), row = Math.floor(num1(a[2])), approx = a.length > 3 ? bool1(a[3]) : true;
    if (row < 1 || row > m.length) return ERR.ref;
    var i = lookupIndex(v, m[0], approx ? 1 : 0);
    return i < 0 ? ERR.na : m[row - 1][i];
  });
  def('MATCH', function (a) {
    var v = scalarOf(a[0]); if (isErr(v)) return v;
    var m = matrixOf(a[1]), list = m.length === 1 ? m[0] : m.map(function (r) { return r[0]; });
    var t = a.length > 2 ? num1(a[2]) : 1;
    var i = lookupIndex(v, list, t === 0 ? 0 : t > 0 ? 1 : -1);
    return i < 0 ? ERR.na : i + 1;
  });
  def('XMATCH', function (a) {
    var v = scalarOf(a[0]); var m = matrixOf(a[1]), list = m.length === 1 ? m[0] : m.map(function (r) { return r[0]; });
    var i = lookupIndex(v, list, 0); return i < 0 ? ERR.na : i + 1;
  });
  def('INDEX', function (a) {
    var src = a[0], r = Math.floor(num1(argN(a, 1, 0))), c = Math.floor(num1(argN(a, 2, 0)));
    if (isRng(src)) {
      var cl = src;
      if (cl.rows() === 1 && a.length === 2) { c = r; r = 1; }
      if (r === 0 && c === 0) return src;
      if (r === 0) return new Rng(src.wb, src.sheet, src.r1, src.c1 + c - 1, src.r2, src.c1 + c - 1);
      if (c === 0) { if (src.cols() === 1) return src.wb.value(src.sheet, src.r1 + r - 1, src.c1); return new Rng(src.wb, src.sheet, src.r1 + r - 1, src.c1, src.r1 + r - 1, src.c2); }
      if (r > src.rows() || c > src.cols()) return ERR.ref;
      return new Rng(src.wb, src.sheet, src.r1 + r - 1, src.c1 + c - 1, src.r1 + r - 1, src.c1 + c - 1);
    }
    var m = matrixOf(src);
    if (m.length === 1 && a.length === 2) return m[0][r - 1] !== undefined ? m[0][r - 1] : ERR.ref;
    var row = m[(r || 1) - 1]; if (!row) return ERR.ref;
    var x = row[(c || 1) - 1]; return x === undefined ? ERR.ref : x;
  });
  def('XLOOKUP', function (a) {
    var v = scalarOf(a[0]); if (isErr(v)) return v;
    var lm = matrixOf(a[1]), vertical = lm.length > 1 || (lm[0] && lm[0].length === 1);
    var list = vertical ? lm.map(function (r) { return r[0]; }) : lm[0];
    var mode = a.length > 4 && a[4] !== MISSING ? num1(a[4]) : 0, i = -1;
    if (mode === 0 || mode === 2) i = lookupIndex(v, list, 0);
    else {
      var best = -1;
      for (var k = 0; k < list.length; k++) {
        var c = compare(list[k], v);
        if (c === 0) { best = k; break; }
        if (mode === -1 && c < 0 && (best < 0 || compare(list[k], list[best]) > 0)) best = k;
        if (mode === 1 && c > 0 && (best < 0 || compare(list[k], list[best]) < 0)) best = k;
      }
      i = best;
    }
    if (a.length > 5 && a[5] !== MISSING && num1(a[5]) === -1) {
      for (var q = list.length - 1; q >= 0; q--) if (compare(list[q], v) === 0) { i = q; break; }
    }
    if (i < 0) return a.length > 3 && a[3] !== MISSING ? scalarOf(a[3]) : ERR.na;
    var rm = matrixOf(a[2]);
    if (isRng(a[2])) {
      var R = a[2];
      if (vertical) return R.cols() === 1 ? R.wb.value(R.sheet, R.r1 + i, R.c1) : new Rng(R.wb, R.sheet, R.r1 + i, R.c1, R.r1 + i, R.c2);
      return R.rows() === 1 ? R.wb.value(R.sheet, R.r1, R.c1 + i) : new Rng(R.wb, R.sheet, R.r1, R.c1 + i, R.r2, R.c1 + i);
    }
    return vertical ? (rm[i] || [])[0] : rm[0][i];
  });
  def('LOOKUP', function (a) {
    var v = scalarOf(a[0]), lm = matrixOf(a[1]);
    var vertical = lm.length >= (lm[0] || []).length, list = vertical ? lm.map(function (r) { return r[0]; }) : lm[0];
    var i = lookupIndex(v, list, 1); if (i < 0) return ERR.na;
    if (a.length > 2) { var rm = matrixOf(a[2]); return rm.length > 1 ? rm[i][0] : rm[0][i]; }
    return vertical ? lm[i][lm[i].length - 1] : lm[lm.length - 1][i];
  });
  def('ROW', function (a) { if (a.length && isRng(a[0])) return a[0].r1; return CTX ? CTX.row : 1; });
  def('COLUMN', function (a) { if (a.length && isRng(a[0])) return a[0].c1; return CTX ? CTX.col : 1; });
  def('ROWS', function (a) { return isRng(a[0]) ? a[0].clip().rows() : matrixOf(a[0]).length; });
  def('COLUMNS', function (a) { return isRng(a[0]) ? a[0].cols() : matrixOf(a[0])[0].length; });
  def('OFFSET', function (a) {
    var b = a[0]; if (!isRng(b)) return ERR.value;
    var r = num1(a[1]), c = num1(a[2]), h = a.length > 3 && a[3] !== MISSING ? num1(a[3]) : b.rows(), w = a.length > 4 && a[4] !== MISSING ? num1(a[4]) : b.cols();
    if (b.r1 + r < 1 || b.c1 + c < 1) return ERR.ref;
    return new Rng(b.wb, b.sheet, b.r1 + r, b.c1 + c, b.r1 + r + h - 1, b.c1 + c + w - 1);
  });
  def('INDIRECT', function (a) { var s = str1(a[0]); var r = CTX && CTX.wb ? CTX.wb.refFromText(s, CTX.sheet) : null; return r || ERR.ref; });
  def('ADDRESS', function (a) { var r = num1(a[0]), c = num1(a[1]), t = num1(argN(a, 2, 1)); var ac = t === 1 || t === 3 ? '$' : '', ar = t === 1 || t === 2 ? '$' : ''; return ac + colLetters(c) + ar + r; });
  def('UNIQUE', function (a) { var seen = {}, out = []; flat([a[0]]).forEach(function (v) { var k = typeof v + ':' + toStr(v).toLowerCase(); if (v != null && v !== '' && !seen[k]) { seen[k] = 1; out.push([v]); } }); return out.length ? out : ERR.calc; });
  def('FILTER', function (a) {
    var m = matrixOf(a[0]), inc = matrixOf(a[1]), out = [];
    for (var i = 0; i < m.length; i++) if (toBool((inc[i] || [])[0]) === true) out.push(m[i]);
    return out.length ? out : (a.length > 2 ? scalarOf(a[2]) : ERR.calc);
  });
  def('SORT', function (a) { var m = matrixOf(a[0]).slice(), ci = Math.floor(num1(argN(a, 1, 1))) - 1, ord = num1(argN(a, 2, 1)); m.sort(function (x, y) { return compare(x[ci], y[ci]) * ord; }); return m; });

  // finance
  def('PMT', function (a) {
    var r = num1(a[0]), n = num1(a[1]), pv = num1(a[2]), fv = num1(argN(a, 3, 0)), t = num1(argN(a, 4, 0));
    if (r === 0) return -(pv + fv) / n;
    var p = Math.pow(1 + r, n);
    return -(r * (pv * p + fv)) / ((1 + r * t) * (p - 1));
  });
  def('FV', function (a) { var r = num1(a[0]), n = num1(a[1]), pmt = num1(a[2]), pv = num1(argN(a, 3, 0)), t = num1(argN(a, 4, 0)); if (r === 0) return -(pv + pmt * n); var p = Math.pow(1 + r, n); return -(pv * p + pmt * (1 + r * t) * (p - 1) / r); });
  def('PV', function (a) { var r = num1(a[0]), n = num1(a[1]), pmt = num1(a[2]), fv = num1(argN(a, 3, 0)), t = num1(argN(a, 4, 0)); if (r === 0) return -(fv + pmt * n); var p = Math.pow(1 + r, n); return -(fv + pmt * (1 + r * t) * (p - 1) / r) / p; });
  def('NPV', function (a) { var r = num1(a[0]), vals = nums(a.slice(1)), s = 0; vals.forEach(function (v, i) { s += v / Math.pow(1 + r, i + 1); }); return s; });
  def('IPMT', function (a) { var r = num1(a[0]), per = num1(a[1]), n = num1(a[2]), pv = num1(a[3]); var pmt = FN.PMT([r, n, pv]); var bal = pv * Math.pow(1 + r, per - 1) + pmt * (Math.pow(1 + r, per - 1) - 1) / r; return -bal * r; });
  def('PPMT', function (a) { return FN.PMT([a[0], a[2], a[3]]) - FN.IPMT(a); });

  SE.FUNCTIONS = Object.keys(FN).sort();

  /* ------------------------------------------------------------------------------------------ evaluation */
  function evaluate(ast, ctx) {
    var wb = ctx.wb;
    function rngOf(node) {
      var sheet = node.sheet ? wb.sheetName(node.sheet) : ctx.sheet;
      if (sheet == null) throw ERR.ref;
      if (node.t === 'ref') {
        var r = node.ar ? node.r : node.r + (ctx.dr || 0), c = node.ac ? node.c : node.c + (ctx.dc || 0);
        if (r < 1 || c < 1) throw ERR.ref;
        return new Rng(wb, sheet, r, c, r, c);
      }
      if (node.t === 'cols') return new Rng(wb, sheet, 1, node.c1, 1048576, node.c2);
      if (node.t === 'rows') return new Rng(wb, sheet, node.r1, 1, node.r2, 16384);
      return null;
    }
    function ev(node) {
      switch (node.t) {
        case 'num': case 'str': case 'bool': return node.v;
        case 'err': return errOf(node.v);
        case 'missing': return MISSING;
        case 'array': return node.v;
        case 'paren': return ev(node.a);
        case 'ref': case 'cols': case 'rows': return rngOf(node);
        case 'name': {
          var nm = wb.nameRef(node.v, node.sheet || ctx.sheet);
          if (nm) return nm;
          var tb = wb.tableByName(node.v);
          if (tb) return wb.tableRange(tb, { area: 'data' }, ctx);
          throw ERR.name;
        }
        case 'sref': {
          var t = node.table ? wb.tableByName(node.table) : wb.tableAt(ctx.sheet, ctx.row, ctx.col);
          if (!t) throw ERR.ref;
          return wb.tableRange(t, node.spec, ctx);
        }
        case 'area': {
          var a = ev(node.a), b = ev(node.b);
          if (!isRng(a) || !isRng(b)) throw ERR.value;
          return new Rng(wb, a.sheet, Math.min(a.r1, b.r1), Math.min(a.c1, b.c1), Math.max(a.r2, b.r2), Math.max(a.c2, b.c2));
        }
        case 'neg': { var n = toNum(scalarOf(ev(node.a))); if (isErr(n)) return n; return -n; }
        case 'pct': { var p = toNum(scalarOf(ev(node.a))); if (isErr(p)) return p; return p / 100; }
        case 'bin': return binop(node.op, ev(node.a), ev(node.b));
        case 'call': {
          var f = FN[node.name];
          if (!f) {
            if (wb.udf && wb.udf.has(node.name)) {
              var vals = node.args.map(function (x) { return ev(x); });
              return wb.udf.call(node.name, vals, ctx);
            }
            return ERR.name;
          }
          try {
            if (f.lazy) return f(node.args, ev, ctx);
            var args = node.args.map(function (x) { var v = ev(x); return v; });
            var out = f(args, ctx);
            return out === undefined ? 0 : out;
          } catch (e) { if (isErr(e)) return e; throw e; }
        }
      }
      throw new FormulaError('Unknown node ' + node.t);
    }
    try { return ev(ast); } catch (e) { if (isErr(e)) return e; throw e; }
  }

  function arrMap(a, b, fn) {
    if (!Array.isArray(a) && !Array.isArray(b)) return fn(a, b);
    var ma = Array.isArray(a) ? a : null, mb = Array.isArray(b) ? b : null;
    var rows = Math.max(ma ? ma.length : 1, mb ? mb.length : 1), cols = Math.max(ma ? ma[0].length : 1, mb ? mb[0].length : 1), out = [];
    for (var i = 0; i < rows; i++) { var row = []; for (var j = 0; j < cols; j++) row.push(fn(ma ? (ma[i] || ma[0])[j] : a, mb ? (mb[i] || mb[0])[j] : b)); out.push(row); }
    return out;
  }
  function binop(op, a, b) {
    var arrA = isRng(a) && CTX && CTX.array ? a.matrix() : null, arrB = isRng(b) && CTX && CTX.array ? b.matrix() : null;
    if (Array.isArray(a) || Array.isArray(b) || arrA || arrB) return arrMap(arrA || (Array.isArray(a) ? a : scalarOf(a)), arrB || (Array.isArray(b) ? b : scalarOf(b)), function (x, y) { return binop1(op, x, y); });
    return binop1(op, scalarOf(a), scalarOf(b));
  }
  function binop1(op, a, b) {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (op === '&') return toStr(a) + toStr(b);
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      var c = compare(a, b);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    var x = toNum(a), y = toNum(b);
    if (isErr(x)) return x;
    if (isErr(y)) return y;
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': return y === 0 ? ERR.div0 : x / y;
      case '^': { var r = Math.pow(x, y); return isFinite(r) ? r : ERR.num; }
    }
    return ERR.value;
  }
  SE.evaluate = evaluate;

  /* Which functions and names a formula uses (the studio's "will this work?" check). */
  SE.checkFormula = function (text) {
    var out = { ok: true, functions: [], unknown: [], error: null };
    try {
      var ast = parseFormula(text);
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.t === 'call') { if (out.functions.indexOf(n.name) < 0) out.functions.push(n.name); if (!FN[n.name] && out.unknown.indexOf(n.name) < 0) out.unknown.push(n.name); }
        ['a', 'b'].forEach(function (k) { if (n[k]) walk(n[k]); });
        (n.args || []).forEach(walk);
      })(ast);
    } catch (e) { out.ok = false; out.error = e.message || String(e); }
    if (out.unknown.length) out.ok = false;
    return out;
  };

  /* ------------------------------------------------------------------------------------------ the workbook */
  var uid = (function () { var n = 0; return function () { n++; return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6) + n.toString(36); }; })();
  SE.uid = uid;

  function WB(bp, state) {
    this.bp = bp;
    this.state = state || SE.initialState(bp);
    this.udf = null;
    this._ast = {};
    this.listeners = [];
    this.index();
  }
  SE.WB = WB;

  /* The first state from the blueprint: table regions become rows; their header/calc/totals cells become virtual. */
  SE.initialState = function (bp) {
    var st = { rev: 0, sheets: {}, tables: {} };
    bp.sheets.forEach(function (s) {
      var cells = {};
      Object.keys(s.cells || {}).forEach(function (a) { cells[a] = s.cells[a]; });
      st.sheets[s.name] = { cells: cells };
    });
    (bp.tables || []).forEach(function (t) {
      var ar = parseArea(t.ref), sc = st.sheets[t.sheet] && st.sheets[t.sheet].cells;
      if (!ar || !sc) return;
      var first = ar.r1 + (t.header ? 1 : 0), last = ar.r2 - (t.totals ? 1 : 0), rows = [];
      for (var r = first; r <= last; r++) {
        var row = { id: uid(), c: [] }, any = false;
        t.columns.forEach(function (col, j) {
          var a = addr(r, ar.c1 + j), cell = sc[a];
          delete sc[a];
          if (col.calc) { row.c.push(cell && cell.s != null ? { s: cell.s } : null); return; }
          if (cell && (cell.v != null || cell.f)) any = true;
          row.c.push(cell ? copyCell(cell) : null);
        });
        if (any || t.columns.some(function (c) { return c.calc; })) rows.push(row);
      }
      // drop trailing empty rows (Excel keeps an empty row in new tables)
      while (rows.length && rows[rows.length - 1].c.every(function (c, j) { return !c || (c.v == null && !c.f) || t.columns[j].calc; })) rows.pop();
      for (var c = ar.c1; c <= ar.c2; c++) { if (t.header) delete sc[addr(ar.r1, c)]; if (t.totals) delete sc[addr(ar.r2, c)]; }
      st.tables[t.name] = { rows: rows };
    });
    return st;
  };
  function copyCell(c) { var o = {}; for (var k in c) o[k] = c[k]; return o; }

  WB.prototype.index = function () {
    var self = this;
    this.sheetsByName = {}; this.sheetsLower = {};
    this.bp.sheets.forEach(function (s) { self.sheetsByName[s.name] = s; self.sheetsLower[s.name.toLowerCase()] = s.name; });
    this.tables = {}; this.tablesLower = {};
    (this.bp.tables || []).forEach(function (t) {
      var ar = parseArea(t.ref);
      if (!ar || !self.sheetsByName[t.sheet]) return;
      t._r1 = ar.r1; t._c1 = ar.c1; t._c2 = ar.c1 + t.columns.length - 1;
      t._cols = {};
      t.columns.forEach(function (c, j) { t._cols[c.name.toLowerCase()] = j; });
      self.tables[t.name] = t; self.tablesLower[t.name.toLowerCase()] = t;
      if (!self.state.tables[t.name]) self.state.tables[t.name] = { rows: [] };
    });
    this.names = {};
    (this.bp.names || []).forEach(function (n) { self.names[(n.scope ? n.scope + '!' : '') + n.name.toLowerCase()] = n; });
    this.styles = this.bp.styles || [];
    this.invalidate();
  };
  WB.prototype.invalidate = function () {
    this.cache = {}; this.busy = {}; this._max = {};
    var self = this;
    this.byRowsSheet = {};
    Object.keys(this.tables).forEach(function (k) {
      var t = self.tables[k];
      var n = self.state.tables[t.name].rows.length;
      t._hdr = t.header ? t._r1 : t._r1 - 1;
      t._d1 = t._hdr + 1;
      t._d2 = t._hdr + n;
      t._tot = t.totals ? t._d2 + 1 : null;
      t._r2 = t.totals ? t._tot : Math.max(t._d2, t._hdr);
      (self.byRowsSheet[t.sheet] = self.byRowsSheet[t.sheet] || []).push(t);
    });
  };
  WB.prototype.onChange = function (fn) { this.listeners.push(fn); };
  WB.prototype.changed = function (ops) { this.invalidate(); this.listeners.forEach(function (f) { try { f(ops); } catch (e) { console.error(e); } }); };

  WB.prototype.sheetName = function (name) { return this.sheetsByName[name] ? name : this.sheetsLower[String(name).toLowerCase()] || null; };
  WB.prototype.sheet = function (name) { var n = this.sheetName(name); return n ? this.sheetsByName[n] : null; };
  WB.prototype.tableByName = function (name) { return this.tables[name] || this.tablesLower[String(name).toLowerCase()] || null; };
  WB.prototype.tableAt = function (sheet, r, c) {
    var list = this.byRowsSheet[sheet] || [];
    for (var i = 0; i < list.length; i++) { var t = list[i]; if (r >= t._r1 && r <= t._r2 && c >= t._c1 && c <= t._c2) return t; }
    return null;
  };
  WB.prototype.tablesOn = function (sheet) { return this.byRowsSheet[sheet] || []; };
  WB.prototype.rows = function (t) { return this.state.tables[t.name].rows; };
  WB.prototype.colIndex = function (t, name) { var j = t._cols[String(name).toLowerCase()]; return j == null ? -1 : j; };

  WB.prototype.nameRef = function (name, sheet) {
    var n = this.names[(sheet ? sheet + '!' : '') + String(name).toLowerCase()] || this.names[String(name).toLowerCase()];
    if (!n) return null;
    var key = 'name:' + n.name + ':' + (n.scope || '');
    if (!this._ast[key]) { try { this._ast[key] = parseFormula(n.ref); } catch (e) { return ERR.name; } }
    return evaluate(this._ast[key], { wb: this, sheet: n.scope || sheet, row: 1, col: 1 });
  };

  WB.prototype.tableRange = function (t, spec, ctx) {
    var c1 = t._c1, c2 = t._c2;
    if (spec.c1) { var j1 = this.colIndex(t, spec.c1), j2 = this.colIndex(t, spec.c2 || spec.c1); if (j1 < 0 || j2 < 0) throw ERR.ref; c1 = t._c1 + Math.min(j1, j2); c2 = t._c1 + Math.max(j1, j2); }
    var r1 = t._d1, r2 = Math.max(t._d2, t._d1 - 1);
    switch (spec.area) {
      case 'all': r1 = t._r1; r2 = t._r2; break;
      case 'headers': r1 = r2 = t._hdr; break;
      case 'totals': if (!t.totals) throw ERR.ref; r1 = r2 = t._tot; break;
      case 'row': {
        var row = ctx && ctx.sheet === t.sheet ? ctx.row : null;
        if (row == null || row < t._d1 || row > t._d2) throw ERR.value;
        r1 = r2 = row;
        if (c1 === c2) return this.value(t.sheet, row, c1);
        break;
      }
    }
    if (r2 < r1) return new EmptyRng(this, t.sheet, r1, c1, c2);
    return new Rng(this, t.sheet, r1, c1, r2, c2);
  };
  /* A table with no data rows: an empty range (SUM gives 0, COUNTA gives 0). */
  function EmptyRng(wb, sheet, r1, c1, c2) { Rng.call(this, wb, sheet, r1, c1, r1 - 1, c2); }
  EmptyRng.prototype = Object.create(Rng.prototype);
  EmptyRng.prototype.each = function () {};
  EmptyRng.prototype.matrix = function () { return []; };
  EmptyRng.prototype.clip = function () { return this; };
  EmptyRng.prototype.rows = function () { return 0; };

  /* The raw cell at (r, c): a real cell, a table cell, or a virtual one (table header, calculated column, totals). */
  WB.prototype.cellAt = function (sheet, r, c) {
    var t = this.tableAt(sheet, r, c);
    if (t) {
      var j = c - t._c1, col = t.columns[j];
      if (t.header && r === t._hdr) return { v: col.name, virtual: 'header', table: t, col: j };
      if (t.totals && r === t._tot) {
        if (col.totalsLabel) return { v: col.totalsLabel, virtual: 'totals', table: t, col: j };
        if (col.totalsFormula) return { f: col.totalsFormula, virtual: 'totals', table: t, col: j };
        if (col.totalsFn) return { f: totalsFormula(t, col), virtual: 'totals', table: t, col: j };
        return { virtual: 'totals', table: t, col: j };
      }
      var i = r - t._d1, row = this.state.tables[t.name].rows[i];
      if (!row) return null;
      var cell = row.c[j];
      if (col.calc && !(cell && (cell.v != null || cell.f))) return { f: col.calc, s: cell && cell.s, calc: true, dr: i, table: t, col: j, row: row };
      return cell ? { v: cell.v, f: cell.f, s: cell.s, t: cell.t, table: t, col: j, row: row } : { table: t, col: j, row: row };
    }
    var sc = this.state.sheets[sheet];
    return sc ? sc.cells[addr(r, c)] || null : null;
  };
  var TOTALS = { sum: 'SUM', average: 'AVERAGE', count: 'COUNTA', countNums: 'COUNT', max: 'MAX', min: 'MIN', stdDev: 'STDEV', var: 'STDEV' };
  function totalsFormula(t, col) {
    return (TOTALS[col.totalsFn] || 'SUM') + '(' + t.name + '[' + col.name.replace(/([\[\]#'])/g, "'$1") + '])';
  }
  SE.TOTALS = TOTALS;
  def('SUBTOTAL AGGREGATE', function (a) {
    var code = num1(a[0]) % 100, rest = a.slice(1);
    var map = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV', 9: 'SUM' };
    return FN[map[code] || 'SUM'](rest);
  });

  WB.prototype.styleOf = function (cell) { return cell && cell.s != null ? this.styles[cell.s] || {} : {}; };
  WB.prototype.fmtAt = function (sheet, r, c) {
    var cell = this.cellAt(sheet, r, c), st = this.styleOf(cell);
    if (st.z) return st.z;
    if (cell && cell.table) { var col = cell.table.columns[cell.col]; if (col.fmt) return col.fmt; }
    return cell && cell.z || null;
  };

  WB.prototype.ast = function (f) {
    var a = this._ast[f];
    if (a === undefined) { try { a = parseFormula(f); } catch (e) { a = null; } this._ast[f] = a; }
    return a;
  };
  /* The value at (r, c), calculating formulas as needed (cached until the next change). */
  WB.prototype.value = function (sheet, r, c) {
    var key = sheet + '!' + r + ',' + c;
    if (key in this.cache) return this.cache[key];
    var cell = this.cellAt(sheet, r, c);
    if (!cell) return null;
    if (!cell.f) return cell.t === 'e' && typeof cell.v === 'string' ? errOf(cell.v) : (cell.v === undefined ? null : cell.v);
    if (this.busy[key]) return 0;  // circular reference: Excel shows 0 too
    this.busy[key] = true;
    var ast = this.ast(cell.f), v;
    if (!ast) v = ERR.name;
    else {
      var prev = CTX;
      CTX = { wb: this, sheet: sheet, row: r, col: c, dr: cell.calc ? cell.dr : 0, dc: 0 };
      try { v = evaluate(ast, CTX); } catch (e) { v = ERR.value; console.warn && console.warn('formula', sheet, addr(r, c), cell.f, e); }
      CTX = prev;
      if (isRng(v)) v = v.r1 === v.r2 && v.c1 === v.c2 ? v.get(0, 0) : scalarOfAt(v, r, c);
      if (Array.isArray(v)) v = matrixOf(v)[0][0];
      if (v === MISSING || v === undefined) v = 0;
      if (v == null && cell.f) v = 0;
    }
    delete this.busy[key];
    this.cache[key] = v;
    return v;
  };
  function scalarOfAt(v, r, c) { var prev = CTX; CTX = { sheet: v.sheet, row: r, col: c }; var x = scalarOf(v); CTX = prev; return x; }

  /* Evaluate a formula as if it were in (sheet, r, c), relative refs moved by (dr, dc): validation, conditional formats. */
  WB.prototype.evalAt = function (f, sheet, r, c, dr, dc) {
    var ast = this.ast(f);
    if (!ast) return ERR.name;
    var prev = CTX;
    CTX = { wb: this, sheet: sheet, row: r, col: c, dr: dr || 0, dc: dc || 0 };
    var v;
    try { v = evaluate(ast, CTX); } catch (e) { v = ERR.value; }
    CTX = prev;
    return v;
  };
  WB.prototype.refFromText = function (text, sheet) {
    try {
      var ast = parseFormula(text);
      var v = evaluate(ast, { wb: this, sheet: sheet, row: 1, col: 1 });
      return isRng(v) ? v : null;
    } catch (e) { return null; }
  };

  WB.prototype.maxRow = function (sheet) {
    if (this._max[sheet]) return this._max[sheet][0];
    var mr = 0, mc = 0, cells = (this.state.sheets[sheet] || { cells: {} }).cells;
    for (var a in cells) { var p = parseA1(a); if (p) { if (p.r > mr) mr = p.r; if (p.c > mc) mc = p.c; } }
    (this.byRowsSheet[sheet] || []).forEach(function (t) { if (t._r2 > mr) mr = t._r2; if (t._c2 > mc) mc = t._c2; });
    this._max[sheet] = [mr, mc];
    return mr;
  };
  WB.prototype.maxCol = function (sheet) { this.maxRow(sheet); return this._max[sheet][1]; };
  /* Last non-empty row in column c at or above `from` (for End(xlUp)). */
  WB.prototype.lastRowIn = function (sheet, c, from) {
    for (var r = Math.min(from, this.maxRow(sheet)); r >= 1; r--) { var v = this.value(sheet, r, c); if (v != null && v !== '') return r; }
    return 0;
  };

  /* Recalculate everything once, top to bottom (keeps long running-total chains off the call stack). */
  WB.prototype.recalc = function () {
    this.invalidate();
    var self = this;
    this.bp.sheets.forEach(function (s) {
      var cells = self.state.sheets[s.name].cells, keys = Object.keys(cells).filter(function (a) { return cells[a].f; });
      keys.map(parseA1).sort(function (a, b) { return a.r - b.r || a.c - b.c; }).forEach(function (p) { self.value(s.name, p.r, p.c); });
      self.tablesOn(s.name).forEach(function (t) {
        for (var r = t._d1; r <= t._d2; r++) for (var c = t._c1; c <= t._c2; c++) self.value(s.name, r, c);
      });
    });
  };

  /* ------------------------------------------------------------------------------------------ changing the workbook */
  function cellFromInput(v) {
    if (v && typeof v === 'object' && ('f' in v || 'v' in v)) return v;
    if (typeof v === 'string' && v[0] === '=' && v.length > 1) return { f: v.slice(1) };
    return { v: v === '' ? null : v };
  }
  SE.cellFromInput = cellFromInput;

  /* Apply one op to a state (same rules as runtime/server.py). Returns true if something changed. */
  SE.applyOp = function (state, op, bp) {
    var tables = state.tables;
    switch (op.t) {
      case 'cell': {
        var sc = state.sheets[op.s]; if (!sc) return false;
        var cur = sc.cells[op.a] || {}, nc = {};
        if (cur.s != null) nc.s = cur.s;
        if (op.f) nc.f = op.f; else if (op.v != null && op.v !== '') nc.v = op.v;
        if (op.z) nc.z = op.z; else if (cur.z) nc.z = cur.z;
        if (nc.v == null && !nc.f && nc.s == null && !nc.z) delete sc.cells[op.a]; else sc.cells[op.a] = nc;
        return true;
      }
      case 'radd': {
        var tb = tables[op.tb]; if (!tb) return false;
        if (tb.rows.some(function (r) { return r.id === op.id; })) return false;
        var row = { id: op.id, c: (op.c || []).map(function (x) { return x ? copyCell(x) : null; }) };
        var at = op.after ? tb.rows.findIndex(function (r) { return r.id === op.after; }) : -1;
        if (op.at === 0) tb.rows.unshift(row); else if (at >= 0) tb.rows.splice(at + 1, 0, row); else tb.rows.push(row);
        return true;
      }
      case 'rset': {
        var t2 = tables[op.tb]; if (!t2) return false;
        var rw = t2.rows.find(function (r) { return r.id === op.id; }); if (!rw) return false;
        while (rw.c.length <= op.ci) rw.c.push(null);
        var old = rw.c[op.ci] || {}, cell = {};
        if (old.s != null) cell.s = old.s;
        if (op.f) cell.f = op.f; else if (op.v != null && op.v !== '') cell.v = op.v;
        if (op.z) cell.z = op.z; else if (old.z) cell.z = old.z;
        rw.c[op.ci] = cell.v == null && !cell.f && cell.s == null && !cell.z ? null : cell;
        return true;
      }
      case 'rdel': {
        var t3 = tables[op.tb]; if (!t3) return false;
        var n0 = t3.rows.length;
        t3.rows = t3.rows.filter(function (r) { return r.id !== op.id; });
        return t3.rows.length !== n0;
      }
      case 'rorder': {
        var t4 = tables[op.tb]; if (!t4) return false;
        var pos = {}; op.ids.forEach(function (id, i) { pos[id] = i; });
        t4.rows.sort(function (a, b) { return (pos[a.id] != null ? pos[a.id] : 1e9) - (pos[b.id] != null ? pos[b.id] : 1e9); });
        return true;
      }
      case 'rowsdel': case 'rowsins': {
        var s5 = state.sheets[op.s]; if (!s5) return false;
        var moved = {}, n = op.n || 1;
        Object.keys(s5.cells).forEach(function (a) {
          var p = parseA1(a); if (!p) return;
          if (op.t === 'rowsdel') {
            if (p.r >= op.r && p.r < op.r + n) return;
            moved[p.r >= op.r + n ? addr(p.r - n, p.c) : a] = s5.cells[a];
          } else moved[p.r >= op.r ? addr(p.r + n, p.c) : a] = s5.cells[a];
        });
        s5.cells = moved;
        return true;
      }
    }
    return false;
  };

  WB.prototype.apply = function (ops) {
    var self = this, changed = [];
    ops.forEach(function (op) { if (SE.applyOp(self.state, op, self.bp)) changed.push(op); });
    if (changed.length) this.changed(changed);
    return changed;
  };

  /* Set a cell the way typing into Excel does: inside a table it changes that row, right under a table it adds a row. */
  WB.prototype.setCell = function (sheet, r, c, input, fmt) {
    var cell = cellFromInput(input), t = this.tableAt(sheet, r, c), ops = [];
    if (t) {
      if (r === t._hdr || r === t._tot) return [];  // headers and totals come from the table definition
      var row = this.state.tables[t.name].rows[r - t._d1];
      if (!row) return [];
      ops.push({ t: 'rset', tb: t.name, id: row.id, ci: c - t._c1, v: cell.v, f: cell.f || null, z: fmt || undefined });
      return this.apply(ops);
    }
    var below = (this.byRowsSheet[sheet] || []).filter(function (x) { return !x.totals && r === x._d2 + 1 && c >= x._c1 && c <= x._c2; })[0];
    if (below && cell.v != null) {
      var cs = below.columns.map(function () { return null; });
      cs[c - below._c1] = cell;
      return this.apply([{ t: 'radd', tb: below.name, id: uid(), c: cs }]);
    }
    return this.apply([{ t: 'cell', s: sheet, a: addr(r, c), v: cell.v, f: cell.f || null, z: fmt || undefined }]);
  };
  WB.prototype.addRow = function (t, values, after) {
    var cs = t.columns.map(function (col, j) { var v = values ? values[j] : null; return v == null || v === '' ? null : cellFromInput(v); });
    var op = { t: 'radd', tb: t.name, id: uid(), c: cs };
    if (after) op.after = after;
    this.apply([op]);
    return op;
  };
  WB.prototype.setRowCell = function (t, id, j, input) { var cell = cellFromInput(input); return this.apply([{ t: 'rset', tb: t.name, id: id, ci: j, v: cell.v, f: cell.f || null }]); };
  WB.prototype.deleteRow = function (t, id) { return this.apply([{ t: 'rdel', tb: t.name, id: id }]); };
  WB.prototype.deleteRows = function (sheet, r, n) {
    var ops = [], self = this;
    var inTable = (this.byRowsSheet[sheet] || []).filter(function (x) { return r >= x._d1 && r <= x._d2; });
    if (inTable.length) {
      inTable.forEach(function (x) {
        var rows = self.state.tables[x.name].rows;
        for (var k = 0; k < (n || 1); k++) { var row = rows[r - x._d1 + k]; if (row) ops.push({ t: 'rdel', tb: x.name, id: row.id }); }
      });
      return this.apply(ops);
    }
    return this.apply([{ t: 'rowsdel', s: sheet, r: r, n: n || 1 }]);
  };
  WB.prototype.insertRows = function (sheet, r, n) {
    var inTable = (this.byRowsSheet[sheet] || []).filter(function (x) { return r >= x._d1 && r <= x._d2 + 1; });
    if (inTable.length) {
      var ops = [], self = this;
      inTable.forEach(function (x) {
        var rows = self.state.tables[x.name].rows, idx = r - x._d1;
        for (var k = 0; k < (n || 1); k++) {
          var op = { t: 'radd', tb: x.name, id: uid(), c: x.columns.map(function () { return null; }) };
          if (idx <= 0) op.at = 0; else op.after = rows[idx - 1].id;
          ops.push(op);
        }
      });
      return this.apply(ops);
    }
    return this.apply([{ t: 'rowsins', s: sheet, r: r, n: n || 1 }]);
  };

  /* ------------------------------------------------------------------------------------------ validation */
  function inSqref(sqref, r, c) {
    for (var i = 0; i < sqref.length; i++) {
      var a = parseArea(sqref[i]);
      if (a && r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2) return a;
    }
    return null;
  }
  SE.inSqref = inSqref;
  WB.prototype.validationAt = function (sheet, r, c) {
    var s = this.sheet(sheet); if (!s) return null;
    var list = s.validations || [];
    for (var i = 0; i < list.length; i++) {
      var hit = inSqref(list[i].sqref, r, c);
      if (hit) return { rule: list[i], origin: hit };
      // validation drawn for a table column applies to rows added later too
      var t = this.tableAt(sheet, r, c);
      if (t) {
        for (var q = 0; q < list[i].sqref.length; q++) {
          var a = parseArea(list[i].sqref[q]);
          if (a && c >= a.c1 && c <= a.c2 && a.r1 <= t._d1 && a.r1 >= t._r1 && r >= t._d1 && r <= t._d2) return { rule: list[i], origin: a };
        }
      }
    }
    return null;
  };
  /* Dropdown choices for a list rule ("a,b,c", a range, a name, a table column). */
  WB.prototype.listOptions = function (v, sheet, r, c) {
    var rule = v.rule, f = rule.f1 || '';
    if (/^".*"$/.test(f)) return f.slice(1, -1).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var val = this.evalAt(f, sheet, r, c, r - v.origin.r1, c - v.origin.c1), out = [], seen = {};
    var push = function (x) { if (x == null || x === '' || isErr(x)) return; var k = toStr(x); if (!seen[k]) { seen[k] = 1; out.push(x); } };
    if (isRng(val)) val.each(push);
    else if (Array.isArray(val)) matrixOf(val).forEach(function (row) { row.forEach(push); });
    else if (typeof val === 'string') val.split(',').forEach(function (x) { push(x.trim()); });
    return out;
  };
  /* Check a value against the rule for that cell: {ok, message, warn}. */
  WB.prototype.check = function (sheet, r, c, value) {
    var v = this.validationAt(sheet, r, c);
    if (!v) return { ok: true };
    var rule = v.rule, blank = value == null || value === '';
    var fail = function (msg) { return { ok: false, message: rule.error || msg, title: rule.errorTitle || 'Not allowed', warn: rule.errorStyle !== 'stop' }; };
    if (blank) return rule.allowBlank || rule.type === 'any' ? { ok: true } : fail('This field can\'t be left empty.');
    var self = this, dr = r - v.origin.r1, dc = c - v.origin.c1;
    var bound = function (f) { var x = self.evalAt(f, sheet, r, c, dr, dc); return toNum(scalarOf(x)); };
    switch (rule.type) {
      case 'list': {
        var opts = this.listOptions(v, sheet, r, c);
        var ok = opts.some(function (o) { return toStr(o).toLowerCase() === toStr(value).toLowerCase(); });
        return ok ? { ok: true } : fail('Pick one of: ' + opts.slice(0, 12).map(toStr).join(', ') + (opts.length > 12 ? '…' : ''));
      }
      case 'whole': case 'decimal': case 'date': case 'time': case 'textLength': {
        var x = rule.type === 'textLength' ? toStr(value).length : toNum(value);
        if (isErr(x)) return fail(rule.type === 'date' ? 'Enter a date.' : 'Enter a number.');
        if (rule.type === 'whole' && Math.floor(x) !== x) return fail('Enter a whole number.');
        var a = bound(rule.f1), b = rule.f2 ? bound(rule.f2) : null, op = rule.op || 'between';
        if (isErr(a)) return { ok: true };
        var res = op === 'between' ? x >= a && x <= b : op === 'notBetween' ? x < a || x > b : op === 'equal' ? x === a : op === 'notEqual' ? x !== a :
          op === 'greaterThan' ? x > a : op === 'lessThan' ? x < a : op === 'greaterThanOrEqual' ? x >= a : op === 'lessThanOrEqual' ? x <= a : true;
        return res ? { ok: true } : fail(SE.describeRule(rule, this, sheet).replace(/^Must be/, 'It must be') + '.');
      }
      case 'custom': {
        // evaluate with the new value in place
        var res2 = this.withValue(sheet, r, c, value, function () { return self.evalAt(rule.f1, sheet, r, c, dr, dc); });
        return toBool(scalarOf(res2)) === true ? { ok: true } : fail('That value isn\'t allowed here.');
      }
    }
    return { ok: true };
  };
  WB.prototype.withValue = function (sheet, r, c, value, fn) {
    var key = sheet + '!' + r + ',' + c, saved = this.cache;
    this.cache = {}; this.cache[key] = value;
    try { return fn(); } finally { this.cache = saved; }
  };
  var OPS = { between: 'between', notBetween: 'not between', equal: 'equal to', notEqual: 'not equal to', greaterThan: 'more than', lessThan: 'less than',
    greaterThanOrEqual: 'at least', lessThanOrEqual: 'at most' };
  /* A rule in plain words, for the studio and for hints in the app. */
  SE.describeRule = function (rule, wb, sheet) {
    var show = function (f) {
      if (f == null || f === '') return '';
      if (/^-?\d+(\.\d+)?$/.test(f)) { var n = +f; return rule.type === 'date' ? formatValue(n, 'd mmm yyyy') : rule.type === 'time' ? formatValue(n, 'h:mm') : String(n); }
      return f.replace(/^"(.*)"$/, '$1');
    };
    var what = { whole: 'a whole number', decimal: 'a number', date: 'a date', time: 'a time', textLength: 'text with a length' }[rule.type];
    switch (rule.type) {
      case 'list': {
        var f = rule.f1 || '';
        if (/^".*"$/.test(f)) return 'Must be one of: ' + f.slice(1, -1).split(',').map(function (x) { return x.trim(); }).join(', ');
        return 'Must be one of the values in ' + f;
      }
      case 'whole': case 'decimal': case 'date': case 'time': case 'textLength': {
        var op = rule.op || 'between';
        if (op === 'between' || op === 'notBetween') return 'Must be ' + what + ' ' + OPS[op] + ' ' + show(rule.f1) + ' and ' + show(rule.f2);
        return 'Must be ' + what + ' ' + OPS[op] + ' ' + show(rule.f1);
      }
      case 'custom': return 'Must make this formula TRUE: =' + rule.f1;
    }
    return 'Any value';
  };

  /* ------------------------------------------------------------------------------------------ conditional formats */
  WB.prototype.cfAt = function (sheet, r, c) {
    var s = this.sheet(sheet); if (!s || !s.condFormats || !s.condFormats.length) return null;
    var hits = [], self = this, t = this.tableAt(sheet, r, c);
    s.condFormats.forEach(function (cf) {
      var origin = inSqref(cf.sqref, r, c);
      if (!origin && t) {  // formats drawn over a table's first rows follow the table as it grows
        cf.sqref.forEach(function (q) { var a = parseArea(q); if (!origin && a && c >= a.c1 && c <= a.c2 && a.r1 >= t._r1 && a.r1 <= t._d1 + 1 && r >= t._d1 && r <= t._d2) origin = a; });
      }
      if (!origin) return;
      cf.rules.forEach(function (rule) { hits.push({ rule: rule, origin: origin, cf: cf }); });
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a.rule.priority - b.rule.priority; });
    var style = {};
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i], rule = h.rule, dr = r - h.origin.r1, dc = c - h.origin.c1, match = false;
      var v = self.value(sheet, r, c);
      try {
        if (rule.type === 'expression') match = toBool(scalarOf(self.evalAt(rule.formulas[0], sheet, r, c, dr, dc))) === true;
        else if (rule.type === 'cellIs') {
          var a = scalarOf(self.evalAt(rule.formulas[0], sheet, r, c, dr, dc)), b = rule.formulas[1] != null ? scalarOf(self.evalAt(rule.formulas[1], sheet, r, c, dr, dc)) : null;
          var cmp = compare(v, a), op = rule.op;
          match = v != null && v !== '' && (op === 'between' ? cmp >= 0 && compare(v, b) <= 0 : op === 'notBetween' ? cmp < 0 || compare(v, b) > 0 : op === 'equal' ? cmp === 0 :
            op === 'notEqual' ? cmp !== 0 : op === 'greaterThan' ? cmp > 0 : op === 'lessThan' ? cmp < 0 : op === 'greaterThanOrEqual' ? cmp >= 0 : op === 'lessThanOrEqual' ? cmp <= 0 : false);
        } else if (rule.type === 'containsText') match = typeof v === 'string' && v.toLowerCase().indexOf((rule.text || '').toLowerCase()) >= 0;
        else if (rule.type === 'notContainsText') match = typeof v !== 'string' || v.toLowerCase().indexOf((rule.text || '').toLowerCase()) < 0;
        else if (rule.type === 'beginsWith') match = typeof v === 'string' && v.toLowerCase().indexOf((rule.text || '').toLowerCase()) === 0;
        else if (rule.type === 'endsWith') match = typeof v === 'string' && v.toLowerCase().slice(-(rule.text || '').length) === (rule.text || '').toLowerCase();
        else if (rule.type === 'containsBlanks') match = v == null || v === '';
        else if (rule.type === 'notContainsBlanks') match = !(v == null || v === '');
        else if (rule.type === 'containsErrors') match = isErr(v);
        else if (rule.type === 'duplicateValues' || rule.type === 'uniqueValues') {
          var count = 0;
          h.cf.sqref.forEach(function (q) { var ar = parseArea(q); if (!ar) return; new Rng(self, sheet, ar.r1, ar.c1, ar.r2, ar.c2).each(function (x) { if (x != null && x !== '' && compare(x, v) === 0) count++; }); });
          match = v != null && v !== '' && (rule.type === 'duplicateValues' ? count > 1 : count === 1);
        } else if (rule.type === 'colorScale' || rule.type === 'dataBar') {
          if (typeof v !== 'number') continue;
          var lo = Infinity, hi = -Infinity;
          var ar0 = t && h.origin.r2 < t._d2 ? { r1: t._d1, r2: t._d2, c1: h.origin.c1, c2: h.origin.c2 } : h.origin;
          new Rng(self, sheet, ar0.r1, ar0.c1, ar0.r2, ar0.c2).each(function (x) { if (typeof x === 'number') { lo = Math.min(lo, x); hi = Math.max(hi, x); } });
          var pos = hi > lo ? (v - lo) / (hi - lo) : 1;
          if (rule.type === 'dataBar') { style.bar = { pos: pos, color: (rule.colors || [])[0] || '#638EC6' }; }
          else if (!style.fill) style.fill = mix((rule.colors || [])[0] || '#F8696B', (rule.colors || [])[rule.colors && rule.colors.length > 2 ? 2 : 1] || '#63BE7B', pos, rule.colors && rule.colors.length > 2 ? rule.colors[1] : null);
          continue;
        }
      } catch (e) { match = false; }
      if (match) {
        for (var k in rule.style) if (style[k] == null) style[k] = rule.style[k];
        if (rule.stop) break;
      }
    }
    return Object.keys(style).length ? style : null;
  };
  function hexRgb(h) { h = (h || '#000000').replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function mix(a, b, t, mid) {
    if (mid) { if (t < 0.5) { b = mid; t = t * 2; } else { a = mid; t = (t - 0.5) * 2; } }
    var x = hexRgb(a), y = hexRgb(b);
    return '#' + x.map(function (v, i) { var c = Math.round(v + (y[i] - v) * t); return (c < 16 ? '0' : '') + c.toString(16); }).join('');
  }

  /* ------------------------------------------------------------------------------------------ typing values in */
  /* Text someone typed -> a cell value, using the column's format (dates, percents, money). */
  SE.parseInput = function (text, fmt) {
    if (text == null) return null;
    if (typeof text !== 'string') return text;
    var s = text.trim();
    if (s === '') return null;
    if (s[0] === '=' && s.length > 1) return s;
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
    if (fmt && isDateFmt(fmt)) {
      var iso = isoToSerial(s); if (iso != null) return iso;
      var m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
      if (m) { var y = +m[3]; if (y < 100) y += 2000; return dateToSerial(y, +m[2], +m[1]); }
      var t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
      if (t) { var h = +t[1] % (t[4] ? 12 : 24) + (t[4] && /pm/i.test(t[4]) ? 12 : 0); return (h * 3600 + (+t[2]) * 60 + (+(t[3] || 0))) / 86400; }
    }
    var n = toNum(s);
    if (typeof n === 'number' && /^[-+$€£¥\d.,%\s]+(e[-+]?\d+)?$/i.test(s)) {
      if (fmt && isPercentFmt(fmt) && !/%$/.test(s) && Math.abs(n) > 1) return n / 100;
      return n;
    }
    return s;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SE;
})(typeof window !== 'undefined' ? window : globalThis);
