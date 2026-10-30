/* Sheetsmith engine, part 2: a VBA interpreter for the parts of Excel VBA that workbook "apps" use.

   SE.vba.parse(code, moduleName)        -> module AST (+ problems)
   new SE.vba.Machine(modules, wb, host) -> runs macros against an SE.WB workbook
       modules: [{name, kind: standard|document|class|form, sheet, workbook, code}]
       host:    {msgbox(prompt, buttons, title) -> Promise<number>, inputbox(prompt, title, dflt) -> Promise<string|null>,
                 log(text), toast(text), user, activeSheet() -> name, selection() -> {sheet, r1, c1, r2, c2} | null}
       m.run(name, {sheet, args}) -> Promise<{ok, error, ops, activate, logs}>
       m.fire(event, sheet, range) -> the Worksheet_Change / Workbook_Open / Worksheet_Activate handlers
       m.udf: lets cell formulas call Public Functions (wb.udf)
   SE.vba.analyze(modules) -> per procedure: kind, event, status ok | partial | no, issues [{line, text}]

   The interpreter is written with generators so MsgBox / InputBox can wait for a click (the driver awaits the
   Promise a host call returns); formulas run the same code synchronously. Not supported (reported by analyze):
   UserForms, class modules, file I/O, Declare / Windows API, other Office apps, events other than the ones above. */
(function (root) {
  'use strict';
  var SE = root.SE;
  if (!SE && typeof require !== 'undefined') SE = require('./formula.js');
  var V = SE.vba = {};

  /* ------------------------------------------------------------------------------------------ errors + values */
  function VbaError(number, description) { this.number = number; this.description = description; this.message = description; }
  VbaError.prototype = Object.create(Error.prototype);
  VbaError.prototype.name = 'VbaError';
  function err(n, d) { return new VbaError(n, d); }
  function Stop(kind) { this.kind = kind; }  // End statement / step limit: never caught by On Error
  V.VbaError = VbaError;

  var NOTHING = { __nothing: true, toString: function () { return 'Nothing'; } };
  function VDate(serial) { this.__date = serial; }
  VDate.prototype.valueOf = function () { return this.__date; };
  function VArr(dims, data) { this.dims = dims; this.data = data || new Array(dims.reduce(function (n, d) { return n * Math.max(0, d[1] - d[0] + 1); }, 1)); }
  VArr.prototype.offset = function (idx) {
    if (idx.length !== this.dims.length) throw err(9, 'Subscript out of range');
    var off = 0, mul = 1;
    for (var i = 0; i < idx.length; i++) {
      var d = this.dims[i], k = Math.round(num(idx[i]));
      if (k < d[0] || k > d[1]) throw err(9, 'Subscript out of range');
      off += (k - d[0]) * mul; mul *= d[1] - d[0] + 1;
    }
    return off;
  };
  VArr.prototype.get = function (idx) { return this.data[this.offset(idx)]; };
  VArr.prototype.set = function (idx, v) { this.data[this.offset(idx)] = v; };
  function arr1(list, lb) { lb = lb == null ? 0 : lb; return new VArr([[lb, lb + list.length - 1]], list.slice()); }
  V.NOTHING = NOTHING; V.VDate = VDate; V.VArr = VArr;

  function isHost(v) { return v != null && typeof v === 'object' && typeof v.$get === 'function'; }
  function isObj(v) { return v === NOTHING || isHost(v); }
  /* An object used where a value is needed gives its default property (Range -> .Value). */
  function dflt(v) {
    if (isHost(v)) { if (v.$dflt) return v.$dflt(); throw err(438, 'This object has no value'); }
    if (v === NOTHING) throw err(91, 'Object variable not set');
    return v;
  }
  function num(v) {
    v = dflt(v);
    if (typeof v === 'number') return v;
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'boolean') return v ? -1 : 0;
    if (v instanceof VDate) return v.__date;
    if (SE.isErr(v)) throw err(13, 'Type mismatch (' + v.code + ')');
    var s = String(v).trim().replace(/,(?=\d{3}(\D|$))/g, '');
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
    if (/^&H[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
    var d = parseDate(s);
    if (d != null) return d;
    throw err(13, 'Type mismatch: "' + String(v).slice(0, 40) + '" is not a number');
  }
  function isNumeric(v) { try { v = dflt(v); } catch (e) { return false; } if (typeof v === 'number' || typeof v === 'boolean' || v === undefined) return true; if (typeof v !== 'string') return false; return /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v.replace(/,(?=\d{3})/g, '')) || /^\s*\$\s?\d/.test(v); }
  function fmtDateVal(serial) {
    var hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9, hasDate = Math.floor(serial) !== 0;
    return SE.formatValue(serial, hasDate && hasTime ? 'yyyy-mm-dd h:mm:ss' : hasDate ? 'yyyy-mm-dd' : 'h:mm:ss AM/PM');
  }
  function str(v) {
    v = dflt(v);
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (typeof v === 'number') return SE.generalNum(v);
    if (v instanceof VDate) return fmtDateVal(v.__date);
    if (SE.isErr(v)) return 'Error ' + ({ '#N/A': 2042, '#DIV/0!': 2007, '#VALUE!': 2015, '#REF!': 2023, '#NAME?': 2029, '#NUM!': 2036 }[v.code] || 2015);
    if (v instanceof VArr) throw err(13, 'Type mismatch (an array is not text)');
    return String(v);
  }
  function bool(v) {
    v = dflt(v);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v === undefined || v === null || v === '') return false;
    if (v instanceof VDate) return v.__date !== 0;
    var s = String(v).trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (isNumeric(s)) return num(s) !== 0;
    throw err(13, 'Type mismatch: "' + v + '" is not True or False');
  }
  function parseDate(s) {
    s = String(s).trim();
    var iso = SE.isoToSerial(s);
    if (iso != null) return iso;
    var m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
    if (m) {
      var a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
      var mo = a, d = b;  // month first (VBA's US default), unless that can't be a month
      if (a > 12) { mo = b; d = a; }
      var v = SE.dateToSerial(y, mo, d);
      if (m[4]) v += ((+m[4] % 12 + (m[7] && /pm/i.test(m[7]) ? 12 : 0) + (m[7] ? 0 : (+m[4] >= 12 ? 12 : 0))) * 3600 + (+m[5]) * 60 + (+(m[6] || 0))) / 86400;
      return v;
    }
    var t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
    if (t) { var h = +t[1] % (t[4] ? 12 : 24) + (t[4] && /pm/i.test(t[4]) ? 12 : 0); return (h * 3600 + (+t[2]) * 60 + (+(t[3] || 0))) / 86400; }
    var mn = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s) || /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (mn) {
      var name = isNaN(+mn[1]) ? mn[1] : mn[2], day = isNaN(+mn[1]) ? +mn[2] : +mn[1];
      var mi = SE.MONTHS.findIndex(function (x) { return x.slice(0, 3).toLowerCase() === name.slice(0, 3).toLowerCase(); });
      if (mi >= 0) return SE.dateToSerial(+mn[3], mi + 1, day);
    }
    return null;
  }
  function dateOf(v) {
    v = dflt(v);
    if (v instanceof VDate) return v.__date;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { var d = parseDate(v); if (d != null) return d; }
    if (v === undefined || v === null) return 0;
    throw err(13, 'Type mismatch: "' + v + '" is not a date');
  }
  function bankers(n, d) {
    var f = Math.pow(10, d || 0), x = n * f, r = Math.round(x);
    if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);
    return r / f;
  }
  /* VBA's comparison: numbers with numbers, text with text (binary or text compare), Empty as 0 or "". */
  function cmp(a, b, textMode) {
    a = dflt(a); b = dflt(b);
    if (a instanceof VDate) a = a.__date;
    if (b instanceof VDate) b = b.__date;
    if (a === undefined || a === null) a = typeof b === 'string' ? '' : 0;
    if (b === undefined || b === null) b = typeof a === 'string' ? '' : 0;
    if (typeof a === 'boolean') a = a ? -1 : 0;
    if (typeof b === 'boolean') b = b ? -1 : 0;
    if (typeof a === 'string' && typeof b === 'string') {
      if (textMode) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a < b ? -1 : a > b ? 1 : 0;
    }
    // Variants (cell values): a number against text compares as numbers when the text is a number, else the number is smaller
    if (typeof a === 'string') { if (!isNumeric(a)) return 1; a = num(a); }
    if (typeof b === 'string') { if (!isNumeric(b)) return -1; b = num(b); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function likeRe(p) {
    var out = '', i = 0;
    while (i < p.length) {
      var ch = p[i];
      if (ch === '*') out += '[\\s\\S]*';
      else if (ch === '?') out += '[\\s\\S]';
      else if (ch === '#') out += '\\d';
      else if (ch === '[') { var j = p.indexOf(']', i); var cls = p.slice(i + 1, j); out += '[' + (cls[0] === '!' ? '^' + cls.slice(1) : cls).replace(/\\/g, '\\\\') + ']'; i = j; }
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
    return new RegExp('^' + out + '$');
  }

  /* cell value <-> VBA value */
  function fromCell(v, fmt) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'number' && fmt && SE.isDateFmt(fmt)) return new VDate(v);
    return v;
  }
  function toCell(v) {
    v = dflt(v);
    if (v === undefined || v === null) return null;
    if (v instanceof VDate) return v.__date;
    if (v instanceof VArr) throw err(13, 'Type mismatch (an array in one cell)');
    return v;
  }

  /* ------------------------------------------------------------------------------------------ lexer */
  var KW = {};
  ('and as byref byval call case const dim do each else elseif end eqv exit false for function get goto if imp in is let like loop me mod new next not nothing null empty ' +
   'on optional or preserve private property public redim resume select set static step sub then to true until wend while with xor error option paramarray friend ' +
   'type enum declare global withevents erase typeof gosub').split(' ').forEach(function (k) { KW[k] = true; });

  function lex(text) {
    var toks = [], i = 0, n = text.length, line = 1, atStart = true;
    function push(t, v, extra) { var tok = { t: t, v: v, line: line }; if (extra) for (var k in extra) tok[k] = extra[k]; toks.push(tok); atStart = t === 'nl'; }
    while (i < n) {
      var ch = text[i];
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { push('nl'); line++; i++; continue; }
      if (ch === ' ' || ch === '\t' || ch === ' ') { i++; continue; }
      if (ch === '_' && (i === 0 || /[ \t]/.test(text[i - 1])) && /^_[ \t]*(\r?\n|$)/.test(text.slice(i, i + 6))) {
        var nl = text.indexOf('\n', i); if (nl < 0) break; i = nl + 1; line++; continue;
      }
      if (ch === "'") { while (i < n && text[i] !== '\n') i++; continue; }
      if (atStart && /^rem(\s|$)/i.test(text.slice(i, i + 4))) { while (i < n && text[i] !== '\n') i++; continue; }
      if (atStart && ch === '#') { while (i < n && text[i] !== '\n') i++; continue; }  // #If / #Const lines
      if (ch === '"') {
        var j = i + 1, s = '';
        while (j < n && text[j] !== '\n') { if (text[j] === '"') { if (text[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += text[j++]; }
        push('str', s); i = j + 1; continue;
      }
      if (ch === '#') {
        var dm = /^#([^#\n]{1,30})#/.exec(text.slice(i, i + 34));
        if (dm) { var dv = parseDate(dm[1]); if (dv != null) { push('date', dv); i += dm[0].length; continue; } }
        push('op', '#'); i++; continue;
      }
      if (ch === '&') {
        var hm = /^&([hH])([0-9a-fA-F]+)&?|^&([oO])([0-7]+)&?/.exec(text.slice(i, i + 20));
        if (hm) { push('num', hm[1] ? parseInt(hm[2], 16) : parseInt(hm[4], 8)); i += hm[0].length; continue; }
      }
      var nm = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[#!@%&^]?/.exec(text.slice(i, i + 40));
      var last = toks[toks.length - 1];
      if (nm && !(ch === '.' && last && (last.t === 'id' || (last.t === 'op' && last.v === ')')))) {
        push('num', parseFloat(nm[1] + (nm[2] || ''))); i += nm[0].length; continue;
      }
      var im = /^[A-Za-zÀ-￿][A-Za-z0-9_À-￿]*/.exec(text.slice(i, i + 120));
      if (im) {
        var id = im[0]; i += id.length;
        if (/[$%@]/.test(text[i] || '')) i++;  // type suffix: Left$, i%
        var low = id.toLowerCase(), prev = toks[toks.length - 1];
        var afterDot = prev && prev.t === 'op' && prev.v === '.';
        if (atStart && text[i] === ':' && text[i + 1] !== '=' && !KW[low]) { push('label', id); i++; atStart = true; continue; }
        if (KW[low] && !afterDot) push('kw', low, { raw: id }); else push('id', id);
        continue;
      }
      if (ch === '[') { var e = text.indexOf(']', i); if (e > 0 && text.slice(i, e).indexOf('\n') < 0) { push('bracket', text.slice(i + 1, e)); i = e + 1; continue; } }
      var two = text.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === ':=' || two === '=<' || two === '=>') { push('op', two === '=<' ? '<=' : two === '=>' ? '>=' : two); i += 2; continue; }
      if (ch === ':') { push('nl', null, { colon: true }); i++; continue; }
      push('op', ch); i++;
    }
    push('nl');
    return toks;
  }

  /* ------------------------------------------------------------------------------------------ parser */
  function ParseError(msg, line) { this.message = msg; this.line = line; }
  ParseError.prototype = Object.create(Error.prototype);

  var UNSUPPORTED_STMT = { open: 'Reading and writing files', close: 'Reading and writing files', print: 'Writing to files', write: 'Writing to files',
    input: 'Reading files', line: 'Reading files', get: 'Reading files', put: 'Writing files', kill: 'Deleting files', mkdir: 'Making folders', rmdir: 'Removing folders',
    chdir: 'Changing folders', chdrive: 'Changing drives', filecopy: 'Copying files', name: 'Renaming files', sendkeys: 'SendKeys', appactivate: 'Switching programs',
    load: 'UserForms', unload: 'UserForms', lset: 'LSet', rset: 'RSet', seek: 'Files', lock: 'Files', unlock: 'Files', reset: 'Files', beep: null, randomize: null, doevents: null };

  function Parser(text, modName) {
    this.toks = lex(text); this.p = 0; this.modName = modName; this.problems = [];
  }
  var P = Parser.prototype;
  P.peek = function (k) { return this.toks[this.p + (k || 0)]; };
  P.next = function () { return this.toks[this.p++]; };
  P.isKw = function (v, k) { var t = this.peek(k); return t && t.t === 'kw' && t.v === v; };
  P.isOp = function (v, k) { var t = this.peek(k); return t && t.t === 'op' && t.v === v; };
  P.eatKw = function (v) { if (this.isKw(v)) { this.p++; return true; } return false; };
  P.eatOp = function (v) { if (this.isOp(v)) { this.p++; return true; } return false; };
  P.line = function () { var t = this.peek(); return t ? t.line : 0; };
  P.fail = function (msg) { throw new ParseError(msg, this.line()); };
  P.expectKw = function (v) { if (!this.eatKw(v)) this.fail('Expected ' + v); };
  P.expectOp = function (v) { if (!this.eatOp(v)) this.fail('Expected "' + v + '"'); };
  P.atEnd = function () { var t = this.peek(); return !t || t.t === 'nl'; };
  P.skipNl = function () { while (this.peek() && this.peek().t === 'nl') this.p++; };
  P.skipLine = function () { while (this.peek() && this.peek().t !== 'nl') this.p++; };
  P.endStmt = function () { if (!this.atEnd()) this.fail('Unexpected "' + (this.peek().raw || this.peek().v) + '"'); };
  P.name = function () {
    var t = this.next();
    if (!t || (t.t !== 'id' && t.t !== 'kw')) this.fail('Expected a name');
    return t.t === 'kw' ? t.raw || t.v : t.v;
  };

  P.module = function () {
    var mod = { name: this.modName, procs: [], vars: [], consts: [], explicit: false, textCompare: false, base: 0, problems: this.problems };
    for (;;) {
      this.skipNl();
      if (!this.peek()) break;
      var line = this.line(), start = this.p;
      try {
        var priv = false, isStatic = false;
        while (this.peek() && this.peek().t === 'kw' && /^(public|private|global|friend|static)$/.test(this.peek().v)) {
          var w = this.next().v; if (w === 'private') priv = true; if (w === 'static') isStatic = true;
        }
        void isStatic;
        var t = this.peek();
        if (!t || t.t === 'nl') continue;
        if (t.t === 'kw' && t.v === 'option') {
          this.next();
          var what = this.name().toLowerCase();
          if (what === 'explicit') mod.explicit = true;
          else if (what === 'compare') { mod.textCompare = this.name().toLowerCase() === 'text'; }
          else if (what === 'base') { mod.base = this.next().v | 0; }
          this.skipLine();
        } else if (t.t === 'kw' && (t.v === 'sub' || t.v === 'function' || t.v === 'property')) {
          var proc = this.proc(priv);
          mod.procs.push(proc);
        } else if (t.t === 'kw' && t.v === 'const') {
          this.next(); mod.consts = mod.consts.concat(this.constList(priv));
        } else if (t.t === 'kw' && (t.v === 'dim' || t.v === 'withevents') || (start !== this.p && (t.t === 'id' || (t.t === 'kw' && t.v === 'withevents')))) {
          if (t.t === 'kw') this.next();
          if (this.isKw('withevents')) this.next();
          this.dimList().forEach(function (v) { v.private = priv; mod.vars.push(v); });
          this.endStmt();
        } else if (t.t === 'kw' && t.v === 'declare') {
          this.problems.push({ line: line, text: 'Calls into Windows (Declare) can\'t run in a browser.', unsupported: true });
          this.skipLine();
        } else if (t.t === 'kw' && (t.v === 'type' || t.v === 'enum')) {
          var isEnum = t.v === 'enum'; this.next();
          var ename = this.name(), val = 0;
          this.skipLine();
          for (;;) {
            this.skipNl();
            if (!this.peek()) this.fail('Missing End ' + (isEnum ? 'Enum' : 'Type'));
            if (this.isKw('end')) { this.next(); this.next(); this.skipLine(); break; }
            if (isEnum) {
              var cn = this.name();
              if (this.eatOp('=')) { var ex = this.expr(); mod.consts.push({ name: cn, expr: ex, private: priv }); val = null; }
              else { mod.consts.push({ name: cn, expr: { t: 'lit', v: val === null ? 0 : val }, private: priv, enumNext: true }); }
              if (val !== null) val++;
            }
            this.skipLine();
          }
          if (!isEnum) this.problems.push({ line: line, text: 'User-defined types (Type ' + ename + ') aren\'t supported yet.', unsupported: true });
        } else if (t.t === 'id' && /^(implements|event)$/i.test(t.v)) {
          this.skipLine();
        } else {
          this.fail('Unexpected "' + (t.raw || t.v) + '" outside a Sub or Function');
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.problems.push({ line: e.line || line, text: e.message });
        this.skipLine();
      }
    }
    return mod;
  };

  P.params = function () {
    var out = [];
    if (!this.eatOp('(')) return out;
    if (this.eatOp(')')) return out;
    for (;;) {
      var prm = { optional: false, byval: false, paramArray: false };
      for (;;) {
        if (this.eatKw('optional')) prm.optional = true;
        else if (this.eatKw('byval')) prm.byval = true;
        else if (this.eatKw('byref')) prm.byval = false;
        else if (this.eatKw('paramarray')) prm.paramArray = true;
        else break;
      }
      prm.name = this.name();
      if (this.eatOp('(')) this.expectOp(')');
      if (this.eatKw('as')) prm.type = this.typeName();
      if (this.eatOp('=')) prm.dflt = this.expr();
      out.push(prm);
      if (this.eatOp(',')) continue;
      this.expectOp(')');
      return out;
    }
  };
  P.typeName = function () { var n = this.name(); while (this.eatOp('.')) n += '.' + this.name(); if (this.eatOp('*')) this.next(); return n; };

  P.proc = function (priv) {
    var kindTok = this.next().v, line = this.line(), prop = null;
    if (kindTok === 'property') { prop = this.next().v; }
    var name = this.name();
    var params = this.params();
    var type = null;
    if (this.eatKw('as')) type = this.typeName();
    this.skipLine();
    var self = this;
    var body = this.block(function () { return self.isKw('end') && self.isKw(kindTok, 1); });
    var endLine = this.line();
    this.next(); this.next(); this.skipLine();
    return { name: name, lname: name.toLowerCase(), kind: kindTok === 'property' ? 'property' : kindTok, prop: prop, params: params, type: type,
      body: body, line: line, endLine: endLine, private: !!priv, module: this.modName };
  };

  P.block = function (stop) {
    var out = [];
    for (;;) {
      this.skipNl();
      if (!this.peek()) this.fail('Missing an End statement');
      if (stop()) return out;
      if (this.isKw('end') && this.peek(1) && this.peek(1).t === 'kw' && /^(sub|function|property)$/.test(this.peek(1).v)) this.fail('Missing an End statement before End ' + this.peek(1).v);
      var line = this.line();
      try { out.push(this.stmt()); }
      catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.problems.push({ line: e.line || line, text: e.message });
        out.push({ t: 'unsupported', line: e.line || line, text: e.message, parse: true });
        this.skipLine();
      }
    }
  };

  P.dimList = function () {
    var out = [];
    do {
      var v = { name: this.name(), dims: null, type: null, isNew: false, line: this.line() };
      if (this.eatOp('(')) {
        v.dims = [];
        if (!this.eatOp(')')) {
          do {
            var a = this.expr(), b = null;
            if (this.eatKw('to')) b = this.expr();
            v.dims.push(b ? [a, b] : [null, a]);
          } while (this.eatOp(','));
          this.expectOp(')');
        }
      }
      if (this.eatKw('as')) { if (this.eatKw('new')) v.isNew = true; v.type = this.typeName(); }
      out.push(v);
    } while (this.eatOp(','));
    return out;
  };
  P.constList = function (priv) {
    var out = [];
    do {
      var n = this.name();
      if (this.eatKw('as')) this.typeName();
      this.expectOp('=');
      out.push({ name: n, expr: this.expr(), private: !!priv });
    } while (this.eatOp(','));
    return out;
  };

  /* One statement (until the end of the line or a ':'). */
  P.stmt = function () {
    var t = this.peek(), line = t.line, self = this, node;
    if (t.t === 'label') { this.next(); return { t: 'label', name: t.v.toLowerCase(), line: line }; }
    if (t.t === 'num' && this.peek(1) && this.peek(1).t !== 'nl') { this.next(); return { t: 'label', name: String(t.v), line: line }; }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'dim': case 'static': case 'private': case 'public': this.next(); node = { t: 'dim', vars: this.dimList(), line: line }; this.endStmt(); return node;
        case 'const': this.next(); node = { t: 'const', items: this.constList(), line: line }; this.endStmt(); return node;
        case 'redim': {
          this.next();
          var preserve = this.eatKw('preserve'), items = [];
          do {
            var target = this.name(), dims = [];
            this.expectOp('(');
            do { var a = this.expr(), b = null; if (this.eatKw('to')) b = this.expr(); dims.push(b ? [a, b] : [null, a]); } while (this.eatOp(','));
            this.expectOp(')');
            if (this.eatKw('as')) this.typeName();
            items.push({ name: target, dims: dims });
          } while (this.eatOp(','));
          this.endStmt();
          return { t: 'redim', preserve: preserve, items: items, line: line };
        }
        case 'erase': this.next(); node = { t: 'erase', names: [] }; do { node.names.push(this.name()); } while (this.eatOp(',')); node.line = line; this.endStmt(); return node;
        case 'set': case 'let': {
          var isSet = this.next().v === 'set';
          var tg = this.postfix();
          this.expectOp('=');
          node = { t: 'assign', target: tg, expr: this.expr(), set: isSet, line: line };
          this.endStmt(); return node;
        }
        case 'if': return this.ifStmt();
        case 'select': {
          this.next(); this.expectKw('case');
          var subject = this.expr(); this.skipLine();
          var cases = [], elseBody = null;
          for (;;) {
            this.skipNl();
            if (this.isKw('end') && this.isKw('select', 1)) { this.next(); this.next(); break; }
            this.expectKw('case');
            if (this.eatKw('else')) { elseBody = this.block(function () { return self.isKw('case') || (self.isKw('end') && self.isKw('select', 1)); }); continue; }
            var tests = [];
            do {
              if (this.eatKw('is')) { var opt = this.next(); tests.push({ k: 'is', op: opt.v, e: this.expr() }); }
              else { var e1 = this.expr(); if (this.eatKw('to')) tests.push({ k: 'range', a: e1, b: this.expr() }); else tests.push({ k: 'eq', e: e1 }); }
            } while (this.eatOp(','));
            var body = this.block(function () { return self.isKw('case') || (self.isKw('end') && self.isKw('select', 1)); });
            cases.push({ tests: tests, body: body });
          }
          this.endStmt();
          return { t: 'select', subject: subject, cases: cases, elseBody: elseBody, line: line };
        }
        case 'for': {
          this.next();
          if (this.eatKw('each')) {
            var v = this.name(); this.expectKw('in');
            var coll = this.expr(); this.skipLine();
            var fbody = this.block(function () { return self.isKw('next'); });
            this.next(); this.skipLine();
            return { t: 'foreach', v: v.toLowerCase(), vname: v, coll: coll, body: fbody, line: line };
          }
          var fv = this.name(); this.expectOp('=');
          var from = this.expr(); this.expectKw('to');
          var to = this.expr(), step = null;
          if (this.eatKw('step')) step = this.expr();
          this.skipLine();
          var b2 = this.block(function () { return self.isKw('next'); });
          this.next(); this.skipLine();
          return { t: 'for', v: fv.toLowerCase(), vname: fv, from: from, to: to, step: step, body: b2, line: line };
        }
        case 'do': {
          this.next();
          var pre = null;
          if (this.isKw('while') || this.isKw('until')) { pre = { until: this.next().v === 'until', e: this.expr() }; }
          this.skipLine();
          var db = this.block(function () { return self.isKw('loop'); });
          this.next();
          var post = null;
          if (this.isKw('while') || this.isKw('until')) { post = { until: this.next().v === 'until', e: this.expr() }; }
          this.endStmt();
          return { t: 'do', pre: pre, post: post, body: db, line: line };
        }
        case 'while': {
          this.next();
          var wc = this.expr(); this.skipLine();
          var wb = this.block(function () { return self.isKw('wend'); });
          this.next(); this.endStmt();
          return { t: 'do', pre: { until: false, e: wc }, post: null, body: wb, line: line };
        }
        case 'with': {
          this.next();
          var we = this.expr(); this.skipLine();
          var wbody = this.block(function () { return self.isKw('end') && self.isKw('with', 1); });
          this.next(); this.next(); this.endStmt();
          return { t: 'with', e: we, body: wbody, line: line };
        }
        case 'exit': { this.next(); var what = this.next(); node = { t: 'exit', what: what.v === 'property' ? 'property' : what.v, line: line }; this.endStmt(); return node; }
        case 'end': this.next(); if (!this.atEnd()) this.fail('Unexpected End ' + (this.peek().v || '')); return { t: 'end', line: line };
        case 'on': {
          this.next();
          if (this.eatKw('error')) {
            if (this.eatKw('resume')) { this.next(); this.endStmt(); return { t: 'onerror', mode: 'next', line: line }; }
            this.expectKw('goto');
            var lt = this.next();
            this.endStmt();
            if (lt.t === 'num' || (lt.t === 'op' && lt.v === '-')) { if (lt.t === 'op') this.next(); return { t: 'onerror', mode: 'zero', line: line }; }
            return { t: 'onerror', mode: 'goto', label: String(lt.v).toLowerCase(), line: line };
          }
          this.skipLine();
          return { t: 'unsupported', text: 'On ... GoTo jumps aren\'t supported.', line: line };
        }
        case 'resume': {
          this.next();
          if (this.atEnd()) return { t: 'resume', mode: 'same', line: line };
          if (this.eatKw('next')) { this.endStmt(); return { t: 'resume', mode: 'next', line: line }; }
          var rl = this.next(); this.endStmt();
          return { t: 'resume', mode: 'label', label: String(rl.v).toLowerCase(), line: line };
        }
        case 'goto': { this.next(); var gl = this.next(); this.endStmt(); return { t: 'goto', label: String(gl.v).toLowerCase(), line: line }; }
        case 'gosub': this.skipLine(); return { t: 'unsupported', text: 'GoSub isn\'t supported.', line: line };
        case 'call': {
          this.next();
          var ct = this.postfix();
          this.endStmt();
          return { t: 'callstmt', target: ct.t === 'call' ? ct.target : ct, args: ct.t === 'call' ? ct.args : [], line: line };
        }
        case 'error': { this.next(); var en = this.expr(); this.endStmt(); return { t: 'raise', e: en, line: line }; }
      }
    }
    if (t.t === 'id') {
      var low = t.v.toLowerCase(), nx = this.peek(1);
      var stmtLike = !(nx && nx.t === 'op' && (nx.v === '=' || nx.v === '.' || nx.v === '('));
      if (UNSUPPORTED_STMT.hasOwnProperty(low) && stmtLike) {
        if (UNSUPPORTED_STMT[low] === null) { this.next(); this.skipLine(); return { t: 'noop', line: line, what: low }; }
        var real = !(low === 'line' && !(nx && nx.t === 'id' && /^input$/i.test(nx.v))) && !(low === 'name' && !this.lineHas('as'));
        if (real) { this.skipLine(); return { t: 'unsupported', text: UNSUPPORTED_STMT[low] + ' can\'t be done from a web page.', line: line }; }
      }
    }
    // assignment or call
    var target = this.postfix();
    if (this.eatOp('=')) { node = { t: 'assign', target: target, expr: this.expr(), set: false, line: line }; this.endStmt(); return node; }
    var args = [];
    if (!this.atEnd()) {
      args = this.args(true);
      if (target.t === 'call' && target.args.length === 1 && !target.args[0].name) { args = [{ e: { t: 'paren', a: target.args[0].e } }].concat(args); target = target.target; }
    } else if (target.t === 'call') { args = target.args; target = target.target; }
    this.endStmt();
    return { t: 'callstmt', target: target, args: args, line: line };
  };
  P.lineHas = function (kw) { for (var k = this.p; this.toks[k] && this.toks[k].t !== 'nl'; k++) if (this.toks[k].t === 'kw' && this.toks[k].v === kw) return true; return false; };

  P.ifStmt = function () {
    var line = this.line(), self = this;
    this.next();
    var cond = this.expr();
    this.expectKw('then');
    if (!this.atEnd() || (this.peek() && this.peek().colon)) {
      // single-line If: statements separated by ':' until the end of the line
      var colonRun = function (stopElse) {
        var out = [];
        for (;;) {
          if (self.peek() && self.peek().t === 'nl' && self.peek().colon) { self.next(); continue; }
          if (self.atEnd() || (stopElse && self.isKw('else'))) return out;
          var st;
          if (self.isKw('if')) st = self.ifStmt(); else st = self.stmtInline();
          out.push(st);
        }
      };
      var thenBody = colonRun(true), elseBody = null;
      if (this.eatKw('else')) elseBody = colonRun(false);
      return { t: 'if', branches: [{ cond: cond, body: thenBody }], elseBody: elseBody, line: line };
    }
    this.skipLine();
    var branches = [], elseB = null;
    var stop = function () { return self.isKw('elseif') || self.isKw('else') || (self.isKw('end') && self.isKw('if', 1)); };
    branches.push({ cond: cond, body: this.block(stop) });
    for (;;) {
      if (this.eatKw('elseif')) { var c2 = this.expr(); this.expectKw('then'); this.skipLine(); branches.push({ cond: c2, body: this.block(stop) }); continue; }
      if (this.eatKw('else')) { elseB = this.block(stop); continue; }
      if (this.isKw('end')) { this.next(); this.next(); break; }
      this.fail('Missing End If');
    }
    this.endStmt();
    return { t: 'if', branches: branches, elseBody: elseB, line: line };
  };
  /* A statement inside a single-line If (it ends at ':' or Else). */
  P.stmtInline = function () {
    var save = this.endStmt;
    var self = this;
    this.endStmt = function () { if (!(self.atEnd() || self.isKw('else'))) self.fail('Unexpected "' + (self.peek().raw || self.peek().v) + '"'); };
    var atEnd = this.atEnd;
    this.atEnd = function () { return atEnd.call(self) || self.isKw('else'); };
    try { return this.stmt(); } finally { this.endStmt = save; this.atEnd = atEnd; }
  };

  P.args = function (stmtLevel) {
    var out = [], self = this;
    var sep = function () { return self.isOp(',') || (stmtLevel && self.isOp(';')); };
    if (this.atEnd() || this.isOp(')')) return out;
    for (;;) {
      if (sep()) { out.push({ e: { t: 'missing' } }); this.next(); if (this.atEnd() || this.isOp(')')) { out.push({ e: { t: 'missing' } }); return out; } continue; }
      var named = null;
      if ((this.peek().t === 'id' || this.peek().t === 'kw') && this.isOp(':=', 1)) { named = this.name().toLowerCase(); this.next(); }
      out.push({ e: this.expr(), name: named });
      if (sep()) { this.next(); if (this.atEnd() || this.isOp(')')) { if (!stmtLevel) out.push({ e: { t: 'missing' } }); return out; } continue; }
      return out;
    }
  };

  P.expr = function () { return this.imp(); };
  function binLevel(name, ops, nextName, kw) {
    P[name] = function () {
      var a = this[nextName]();
      for (;;) {
        var t = this.peek();
        if (!t) return a;
        var hit = kw ? t.t === 'kw' && ops.indexOf(t.v) >= 0 : t.t === 'op' && ops.indexOf(t.v) >= 0;
        if (!hit) return a;
        this.next();
        a = { t: 'bin', op: t.v, a: a, b: this[nextName]() };
      }
    };
  }
  binLevel('imp', ['imp'], 'eqv', true);
  binLevel('eqv', ['eqv'], 'xor', true);
  binLevel('xor', ['xor'], 'or', true);
  binLevel('or', ['or'], 'and', true);
  binLevel('and', ['and'], 'not', true);
  P.not = function () { if (this.eatKw('not')) return { t: 'un', op: 'not', a: this.not() }; return this.cmp(); };
  P.cmp = function () {
    var a = this.concat();
    for (;;) {
      var t = this.peek();
      if (t && t.t === 'op' && /^(=|<>|<|>|<=|>=)$/.test(t.v)) { this.next(); a = { t: 'bin', op: t.v, a: a, b: this.concat() }; continue; }
      if (t && t.t === 'kw' && (t.v === 'like' || t.v === 'is')) { this.next(); a = { t: 'bin', op: t.v, a: a, b: this.concat() }; continue; }
      return a;
    }
  };
  binLevel('concat', ['&'], 'add');
  binLevel('add', ['+', '-'], 'mod');
  binLevel('mod', ['mod'], 'idiv', true);
  binLevel('idiv', ['\\'], 'mul');
  binLevel('mul', ['*', '/'], 'neg');
  P.neg = function () {
    if (this.eatOp('-')) return { t: 'un', op: '-', a: this.neg() };
    if (this.eatOp('+')) return this.neg();
    return this.pow();
  };
  P.pow = function () {
    var a = this.postfix();
    while (this.eatOp('^')) {
      var b = this.isOp('-') ? (this.next(), { t: 'un', op: '-', a: this.postfix() }) : this.postfix();
      a = { t: 'bin', op: '^', a: a, b: b };
    }
    return a;
  };
  P.postfix = function () {
    var a = this.primary();
    for (;;) {
      if (this.isOp('.')) { this.next(); a = { t: 'member', obj: a, name: this.name(), line: this.line() }; continue; }
      if (this.isOp('!')) { this.next(); a = { t: 'call', target: { t: 'member', obj: a, name: 'Item' }, args: [{ e: { t: 'lit', v: this.name() } }] }; continue; }
      if (this.isOp('(')) { this.next(); var args = this.args(false); this.expectOp(')'); a = { t: 'call', target: a, args: args, line: this.line() }; continue; }
      return a;
    }
  };
  P.primary = function () {
    var t = this.next();
    if (!t || t.t === 'nl') { this.p--; this.fail('Expected a value'); }
    switch (t.t) {
      case 'num': return { t: 'lit', v: t.v };
      case 'str': return { t: 'lit', v: t.v };
      case 'date': return { t: 'date', v: t.v };
      case 'id': return { t: 'id', name: t.v, lname: t.v.toLowerCase(), line: t.line };
      case 'bracket': return { t: 'bracket', text: t.v };
      case 'kw':
        switch (t.v) {
          case 'true': return { t: 'lit', v: true };
          case 'false': return { t: 'lit', v: false };
          case 'nothing': return { t: 'nothing' };
          case 'empty': return { t: 'lit', v: undefined };
          case 'null': return { t: 'lit', v: null };
          case 'me': return { t: 'me' };
          case 'new': return { t: 'new', cls: this.typeName() };
          case 'typeof': { var e = this.postfix(); this.expectKw('is'); return { t: 'typeof', e: e, type: this.typeName() }; }
          case 'error': return { t: 'id', name: 'Error', lname: 'error' };
        }
        break;
      case 'op':
        if (t.v === '(') { var inner = this.expr(); this.expectOp(')'); return { t: 'paren', a: inner }; }
        if (t.v === '.') return { t: 'member', obj: null, name: this.name(), line: t.line };
        if (t.v === '!') return { t: 'call', target: { t: 'member', obj: null, name: 'Item' }, args: [{ e: { t: 'lit', v: this.name() } }] };
        break;
    }
    this.p--;
    this.fail('Unexpected "' + (t.raw || t.v) + '"');
  };

  V.parse = function (code, name) { var p = new Parser(code || '', name || 'Module'); return p.module(); };
  V.lex = lex;

  /* ------------------------------------------------------------------------------------------ the object model */
  /* Each host type lists its members: lowercase name -> [return type, get(args), set(args, v)].
     Return types feed the static checker: a type name, 'value', 'void' or 'stub' (accepts anything). */
  function arg(args, i, name, d) {
    if (name && args.named && name in args.named) return args.named[name];
    var v = args[i];
    return v === undefined || v === MISSING ? d : v;
  }
  var MISSING = { __missing: true };
  V.MISSING = MISSING;

  var TYPES = {};
  function hostType(name, members, proto) {
    function H() {}
    H.prototype = proto || {};
    H.prototype.$type = name;
    H.prototype.$get = function (n, args) {
      var m = members[n];
      if (!m) { if (STUBBABLE[n] && this.$stub !== false) return STUB; throw err(438, name + ' has no "' + n + '" here (Sheetsmith doesn\'t support it yet)'); }
      if (!m[1]) throw err(438, name + '.' + n + ' can only be set');
      return m[1].call(this, args || []);
    };
    H.prototype.$set = function (n, args, v) {
      var m = members[n];
      if (!m) { if (STUBBABLE[n] || IGNORE_SET[n]) return; throw err(438, name + '.' + n + ' can\'t be set in Sheetsmith'); }
      if (!m[2]) { if (IGNORE_SET[n]) return; throw err(438, name + '.' + n + ' is read-only'); }
      m[2].call(this, args || [], v);
    };
    TYPES[name] = { members: members, ctor: H };
    return H;
  }
  /* Formatting and window details: accepted and ignored (the app keeps its own look). */
  var STUBBABLE = {}; 'interior font borders horizontalalignment verticalalignment wraptext columnwidth rowheight autofit merge unmerge locked formulahidden indentlevel orientation shrinktofit style borderaround characters displaygridlines zoom freezepanes scrollrow scrollcolumn splitrow splitcolumn windowstate'.split(' ').forEach(function (k) { STUBBABLE[k] = 1; });
  var IGNORE_SET = {}; 'screenupdating displayalerts enableevents calculation statusbar cursor displaystatusbar cutcopymode visible askToUpdateLinks enablecancelkey displayfullscreen displayformulabar interactive printcommunication caption'.toLowerCase().split(' ').forEach(function (k) { IGNORE_SET[k] = 1; });
  var STUB = { $type: 'Stub', $get: function () { return STUB; }, $set: function () {}, $dflt: function () { return 0; }, $let: function () {}, $item: function () { return STUB; }, $iter: function () { return []; } };
  V.TYPES = TYPES;

  /* --- Range ------------------------------------------------------------------------------------------------- */
  var MAXR = 1048576, MAXC = 16384;
  var RangeH = hostType('Range', {
    value: ['value', function (a) { return this.getValue(); }, function (a, v) { this.setValue(v); }],
    value2: ['value', function () { var v = this.getValue(); return v instanceof VDate ? v.__date : v; }, function (a, v) { this.setValue(v); }],
    formula: ['value', function () { return this.getFormula(); }, function (a, v) { this.setValue(v, true); }],
    formula2: ['value', function () { return this.getFormula(); }, function (a, v) { this.setValue(v, true); }],
    formulalocal: ['value', function () { return this.getFormula(); }, function (a, v) { this.setValue(v, true); }],
    text: ['value', function () { var c = this.first(); return SE.formatValue(this.m.wb.value(c.sheet, c.r1, c.c1), this.m.wb.fmtAt(c.sheet, c.r1, c.c1)); }],
    numberformat: ['value', function () { return this.m.wb.fmtAt(this.sheet, this.r1, this.c1) || 'General'; }, function (a, v) { this.setFormat(str(v)); }],
    numberformatlocal: ['value', function () { return this.m.wb.fmtAt(this.sheet, this.r1, this.c1) || 'General'; }, function (a, v) { this.setFormat(str(v)); }],
    row: ['value', function () { return this.r1; }],
    column: ['value', function () { return this.c1; }],
    count: ['value', function () { return this.mode === 'rows' ? this.r2 - this.r1 + 1 : this.mode === 'cols' ? this.c2 - this.c1 + 1 : (this.r2 - this.r1 + 1) * (this.c2 - this.c1 + 1); }],
    countlarge: ['value', function () { return (this.r2 - this.r1 + 1) * (this.c2 - this.c1 + 1); }],
    rows: ['Range', function (a) { var r = this.withMode('rows'); return a.length ? r.$item(a) : r; }],
    columns: ['Range', function (a) { var r = this.withMode('cols'); return a.length ? r.$item(a) : r; }],
    cells: ['Range', function (a) { var r = this.withMode('cells'); return a.length ? r.$item(a) : r; }],
    item: ['Range', function (a) { return this.$item(a); }],
    offset: ['Range', function (a) { var dr = num(arg(a, 0, 'rowoffset', 0)), dc = num(arg(a, 1, 'columnoffset', 0)); return this.mk(this.r1 + dr, this.c1 + dc, this.r2 + dr, this.c2 + dc); }],
    resize: ['Range', function (a) { var h = arg(a, 0, 'rowsize', null), w = arg(a, 1, 'columnsize', null); return this.mk(this.r1, this.c1, this.r1 + (h == null ? this.r2 - this.r1 + 1 : num(h)) - 1, this.c1 + (w == null ? this.c2 - this.c1 + 1 : num(w)) - 1); }],
    end: ['Range', function (a) { return this.end(num(arg(a, 0, 'direction', -4162))); }],
    address: ['value', function (a) {
      var ra = arg(a, 0, 'rowabsolute', true), ca = arg(a, 1, 'columnabsolute', true);
      var one = function (r, c) { return (bool(ca) ? '$' : '') + SE.colLetters(c) + (bool(ra) ? '$' : '') + r; };
      if (this.c1 === 1 && this.c2 === MAXC) return (bool(ra) ? '$' : '') + this.r1 + ':' + (bool(ra) ? '$' : '') + this.r2;
      return one(this.r1, this.c1) + (this.r1 === this.r2 && this.c1 === this.c2 ? '' : ':' + one(this.r2, this.c2));
    }],
    entirerow: ['Range', function () { return new RangeH0(this.m, this.sheet, this.r1, 1, this.r2, MAXC, 'rows'); }],
    entirecolumn: ['Range', function () { return new RangeH0(this.m, this.sheet, 1, this.c1, MAXR, this.c2, 'cols'); }],
    clearcontents: ['void', function () { this.clear(); }],
    clear: ['void', function () { this.clear(); }],
    clearformats: ['void', function () {}],
    delete: ['void', function (a) { this.del(arg(a, 0, 'shift', null)); }],
    insert: ['void', function () { this.ins(); }],
    copy: ['void', function (a) { var d = arg(a, 0, 'destination', null); if (d && isHost(d)) this.copyTo(d, false); else this.m.clipboard = this; }],
    cut: ['void', function (a) { var d = arg(a, 0, 'destination', null); if (d && isHost(d)) { this.copyTo(d, false); this.clear(); } else { this.m.clipboard = this; this.m.cutting = true; } }],
    pastespecial: ['void', function (a) { if (!this.m.clipboard) throw err(1004, 'Nothing was copied'); var p = num(arg(a, 0, 'paste', -4104)); this.m.clipboard.copyTo(this, p === -4163); }],
    select: ['void', function () { this.m.select(this); }],
    activate: ['void', function () { this.m.select(this); }],
    worksheet: ['Worksheet', function () { return this.m.sheetObj(this.sheet); }],
    parent: ['Worksheet', function () { return this.m.sheetObj(this.sheet); }],
    hasformula: ['value', function () { var c = this.m.wb.cellAt(this.sheet, this.r1, this.c1); return !!(c && c.f); }],
    listobject: ['ListObject', function () { var t = this.m.wb.tableAt(this.sheet, this.r1, this.c1); return t ? this.m.tableObj(t) : NOTHING; }],
    currentregion: ['Range', function () { return this.region(); }],
    find: ['Range', function (a) { return this.find(arg(a, 0, 'what', ''), num(arg(a, 4, 'lookat', 2)), arg(a, 1, 'after', null)); }],
    findnext: ['Range', function (a) { var af = arg(a, 0, 'after', null); if (!this.m.lastFind) return NOTHING; return this.find(this.m.lastFind.what, this.m.lastFind.lookAt, af || this.m.lastFind.at, true); }],
    sort: ['void', function (a) { this.sort(a); }],
    autofilter: ['void', function () {}],
    calculate: ['void', function () {}],
    mergecells: ['value', function () { return false; }],
    hidden: ['value', function () { return false; }, function () {}],
    name: ['value', function () { return ''; }],
    comment: ['value', function () { return NOTHING; }],
    addcomment: ['void', function () {}],
    specialcells: ['Range', function (a) {
      var kind = num(arg(a, 0, 'type', 11));
      if (kind === 11) { var mr = this.m.wb.maxRow(this.sheet), mc = this.m.wb.maxCol(this.sheet); return this.mk(Math.max(mr, 1), Math.max(mc, 1), Math.max(mr, 1), Math.max(mc, 1)); }
      throw err(1004, 'SpecialCells(' + kind + ') isn\'t supported');
    }]
  }, {});
  function RangeH0(m, sheet, r1, c1, r2, c2, mode) {
    this.m = m; this.sheet = sheet; this.r1 = Math.max(1, r1); this.c1 = Math.max(1, c1); this.r2 = Math.min(MAXR, r2); this.c2 = Math.min(MAXC, c2); this.mode = mode || 'cells';
    if (r1 < 1 || c1 < 1) throw err(1004, 'That cell is off the sheet (row or column below 1)');
  }
  RangeH0.prototype = RangeH.prototype;
  var R = RangeH.prototype;
  R.mk = function (r1, c1, r2, c2, mode) { return new RangeH0(this.m, this.sheet, r1, c1, r2, c2, mode); };
  R.withMode = function (mode) { return this.mk(this.r1, this.c1, this.r2, this.c2, mode); };
  R.first = function () { return this; };
  R.single = function () { return this.r1 === this.r2 && this.c1 === this.c2; };
  R.$item = function (a) {
    if (this.mode === 'rows') { var i = num(a[0]); return this.mk(this.r1 + i - 1, this.c1, this.r1 + i - 1, this.c2, 'cells'); }
    if (this.mode === 'cols') { var cs = a[0], ci = typeof cs === 'string' ? SE.colIndex(cs.replace(/:.*/, '')) - this.c1 + 1 : num(cs); return this.mk(this.r1, this.c1 + ci - 1, this.r2, this.c1 + ci - 1, 'cells'); }
    var r = num(a[0]), c = a.length > 1 && a[1] !== MISSING ? a[1] : null;
    if (c == null) { var w = this.c2 - this.c1 + 1; var k = r - 1; return this.mk(this.r1 + Math.floor(k / w), this.c1 + (k % w), this.r1 + Math.floor(k / w), this.c1 + (k % w)); }
    var cc = typeof dflt(c) === 'string' && !isNumeric(dflt(c)) ? SE.colIndex(dflt(c)) : num(c);
    return this.mk(this.r1 + r - 1, this.c1 + cc - 1, this.r1 + r - 1, this.c1 + cc - 1);
  };
  R.$dflt = function () { return this.getValue(); };
  R.$let = function (v) { this.setValue(v); };
  R.$iter = function () {
    var out = [], self = this, wb = this.m.wb;
    var r2 = Math.min(this.r2, Math.max(wb.maxRow(this.sheet), this.r1)), c2 = Math.min(this.c2, Math.max(wb.maxCol(this.sheet), this.c1));
    if (this.mode === 'rows') { for (var r = this.r1; r <= r2; r++) out.push(this.mk(r, this.c1, r, this.c2)); return out; }
    if (this.mode === 'cols') { for (var c = this.c1; c <= c2; c++) out.push(this.mk(this.r1, c, this.r2, c)); return out; }
    for (var rr = this.r1; rr <= r2; rr++) for (var cc = this.c1; cc <= c2; cc++) out.push(self.mk(rr, cc, rr, cc));
    return out;
  };
  R.read = function (r, c) { return fromCell(this.m.wb.value(this.sheet, r, c), this.m.wb.fmtAt(this.sheet, r, c)); };
  R.getValue = function () {
    if (this.single()) return this.read(this.r1, this.c1);
    // whole columns / rows are cut to the cells in use; an explicit range keeps its size (UBound matches Excel)
    var wb = this.m.wb, r2 = this.r2 > 50000 ? Math.max(wb.maxRow(this.sheet), this.r1) : this.r2, c2 = this.c2 > 1000 ? Math.max(wb.maxCol(this.sheet), this.c1) : this.c2;
    if ((r2 - this.r1 + 1) * (c2 - this.c1 + 1) > 200000) throw err(7, 'That range is too big to read at once');
    var a = new VArr([[1, r2 - this.r1 + 1], [1, c2 - this.c1 + 1]]);
    for (var r = this.r1; r <= r2; r++) for (var c = this.c1; c <= c2; c++) a.set([r - this.r1 + 1, c - this.c1 + 1], this.read(r, c));
    return a;
  };
  R.getFormula = function () {
    var c = this.m.wb.cellAt(this.sheet, this.r1, this.c1);
    if (c && c.f) return '=' + c.f;
    var v = this.read(this.r1, this.c1);
    return v === undefined ? '' : str(v);
  };
  R.cellCount = function () { return (this.r2 - this.r1 + 1) * (this.c2 - this.c1 + 1); };
  R.setValue = function (v, asFormula) {
    v = isHost(v) ? v.$dflt() : v;
    if (v instanceof VArr) {  // a 2-D array fills a block; a 1-D array fills across, like Excel
      var two = v.dims.length > 1, rows = two ? v.dims[0][1] - v.dims[0][0] + 1 : 1;
      var cols = two ? v.dims[1][1] - v.dims[1][0] + 1 : v.dims[0][1] - v.dims[0][0] + 1;
      for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) {
        if (this.r1 + i > this.r2 || this.c1 + j > this.c2) continue;
        this.m.write(this.sheet, this.r1 + i, this.c1 + j, two ? v.get([v.dims[0][0] + i, v.dims[1][0] + j]) : v.get([v.dims[0][0] + j]));
      }
      return;
    }
    if (this.cellCount() > 100000) throw err(7, 'That range is too big to fill at once');
    var wb = this.m.wb, r2 = this.r2, c2 = this.c2;
    if (this.r2 === MAXR || this.c2 === MAXC) { r2 = Math.min(this.r2, wb.maxRow(this.sheet)); c2 = Math.min(this.c2, wb.maxCol(this.sheet)); }
    for (var r = this.r1; r <= r2; r++) for (var c = this.c1; c <= c2; c++) {
      if (asFormula && typeof v === 'string' && v[0] === '=' && (r !== this.r1 || c !== this.c1)) this.m.write(this.sheet, r, c, '=' + V.shiftFormula(v.slice(1), r - this.r1, c - this.c1));
      else this.m.write(this.sheet, r, c, v);
    }
  };
  R.setFormat = function (fmt) {
    for (var r = this.r1; r <= Math.min(this.r2, this.r1 + 5000); r++) for (var c = this.c1; c <= Math.min(this.c2, this.c1 + 200); c++) {
      var cell = this.m.wb.cellAt(this.sheet, r, c);
      this.m.writeRaw(this.sheet, r, c, cell && cell.f ? '=' + cell.f : cell ? cell.v : null, fmt);
    }
  };
  R.clear = function () {
    var wb = this.m.wb, r2 = Math.min(this.r2, wb.maxRow(this.sheet)), c2 = Math.min(this.c2, wb.maxCol(this.sheet));
    for (var r = this.r1; r <= r2; r++) for (var c = this.c1; c <= c2; c++) { var cell = wb.cellAt(this.sheet, r, c); if (cell && (cell.v != null || cell.f) && !cell.virtual && !cell.calc) this.m.write(this.sheet, r, c, null); }
  };
  R.del = function (shift) {
    var wb = this.m.wb;
    if (this.mode === 'rows' || (this.c1 === 1 && this.c2 === MAXC)) { this.m.push(wb.deleteRows(this.sheet, this.r1, this.r2 - this.r1 + 1)); return; }
    var t = wb.tableAt(this.sheet, this.r1, this.c1);
    if (t && this.r1 >= t._d1 && this.r2 <= t._d2 && this.c1 <= t._c1 && this.c2 >= t._c2) { this.m.push(wb.deleteRows(this.sheet, this.r1, this.r2 - this.r1 + 1)); return; }
    if (this.mode === 'cols' || (this.r1 === 1 && this.r2 === MAXR)) throw err(1004, 'Deleting whole columns isn\'t supported');
    // shift the cells below up, in these columns only
    var n = this.r2 - this.r1 + 1, mr = wb.maxRow(this.sheet);
    for (var c = this.c1; c <= this.c2; c++) {
      for (var r = this.r1; r <= mr; r++) {
        var src = wb.cellAt(this.sheet, r + n, c);
        this.m.write(this.sheet, r, c, src && src.f ? '=' + V.shiftFormula(src.f, -n, 0) : src ? src.v : null);
      }
    }
    void shift;
  };
  R.ins = function () {
    if (this.mode === 'rows' || (this.c1 === 1 && this.c2 === MAXC)) { this.m.push(this.m.wb.insertRows(this.sheet, this.r1, this.r2 - this.r1 + 1)); return; }
    throw err(1004, 'Only whole rows can be inserted (use .EntireRow.Insert)');
  };
  R.copyTo = function (dest, valuesOnly) {
    var wb = this.m.wb, rows = Math.min(this.r2, wb.maxRow(this.sheet)) - this.r1 + 1, cols = Math.min(this.c2, wb.maxCol(this.sheet)) - this.c1 + 1;
    var dr = dest.r1 - this.r1, dc = dest.c1 - this.c1, buf = [];
    for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) {
      var cell = wb.cellAt(this.sheet, this.r1 + i, this.c1 + j);
      var v = !cell ? null : (cell.f && !valuesOnly) ? '=' + V.shiftFormula(cell.f, dr, dc) : wb.value(this.sheet, this.r1 + i, this.c1 + j);
      if (SE.isErr(v)) v = v.code;
      buf.push([i, j, v, wb.fmtAt(this.sheet, this.r1 + i, this.c1 + j)]);
    }
    var self = this;
    buf.forEach(function (b) { self.m.writeRaw(dest.sheet, dest.r1 + b[0], dest.c1 + b[1], b[2], b[3] && SE.isDateFmt(b[3]) ? b[3] : undefined); });
  };
  R.end = function (dir) {
    var wb = this.m.wb, sheet = this.sheet, r = this.r1, c = this.c1;
    var dr = dir === -4162 ? -1 : dir === -4121 ? 1 : 0, dc = dir === -4159 ? -1 : dir === -4161 ? 1 : 0;
    if (!dr && !dc) throw err(1004, 'Unknown direction for End');
    var maxR = wb.maxRow(sheet), maxC = wb.maxCol(sheet);
    var empty = function (rr, cc) { var v = wb.value(sheet, rr, cc); return v == null || v === ''; };
    var inb = function (rr, cc) { return rr >= 1 && cc >= 1 && rr <= MAXR && cc <= MAXC; };
    if (dr < 0 && r > maxR + 1) r = maxR + 1;
    if (dc < 0 && c > maxC + 1) c = maxC + 1;
    var nr = r + dr, nc = c + dc;
    if (!inb(nr, nc)) return this.mk(r, c, r, c);
    if (!empty(r, c) && !empty(nr, nc)) {
      while (inb(nr + dr, nc + dc) && !empty(nr + dr, nc + dc)) { nr += dr; nc += dc; }
      return this.mk(nr, nc, nr, nc);
    }
    while (inb(nr, nc) && empty(nr, nc)) {
      if ((dr > 0 && nr > maxR) || (dc > 0 && nc > maxC)) { nr = dr > 0 ? MAXR : nr; nc = dc > 0 ? MAXC : nc; return this.mk(nr, nc, nr, nc); }
      nr += dr; nc += dc;
    }
    if (!inb(nr, nc)) { nr -= dr; nc -= dc; }
    return this.mk(nr, nc, nr, nc);
  };
  R.region = function () {
    var wb = this.m.wb, s = this.sheet, r1 = this.r1, r2 = this.r2, c1 = this.c1, c2 = this.c2, grew = true;
    var filled = function (r, c) { if (r < 1 || c < 1) return false; var v = wb.value(s, r, c); return v != null && v !== ''; };
    var rowHas = function (r) { for (var c = c1 - 1; c <= c2 + 1; c++) if (filled(r, c)) return true; return false; };
    var colHas = function (c) { for (var r = r1 - 1; r <= r2 + 1; r++) if (filled(r, c)) return true; return false; };
    for (var guard = 0; grew && guard < 10000; guard++) {
      grew = false;
      if (r1 > 1 && rowHas(r1 - 1)) { r1--; grew = true; }
      if (rowHas(r2 + 1)) { r2++; grew = true; }
      if (c1 > 1 && colHas(c1 - 1)) { c1--; grew = true; }
      if (colHas(c2 + 1)) { c2++; grew = true; }
    }
    return this.mk(r1, c1, r2, c2);
  };
  R.find = function (what, lookAt, after, isNext) {
    what = dflt(what);
    var wb = this.m.wb, r2 = Math.min(this.r2, wb.maxRow(this.sheet)), c2 = Math.min(this.c2, wb.maxCol(this.sheet));
    var target = str(what).toLowerCase(), cells = [];
    for (var r = this.r1; r <= r2; r++) for (var c = this.c1; c <= c2; c++) cells.push([r, c]);
    var start = 0;
    if (after && isHost(after)) { var idx = cells.findIndex(function (p) { return p[0] === after.r1 && p[1] === after.c1; }); if (idx >= 0) start = idx + 1; }
    for (var k = 0; k < cells.length; k++) {
      var p = cells[(start + k) % cells.length], v = wb.value(this.sheet, p[0], p[1]);
      if (v == null || v === '') continue;
      var s = SE.formatValue(v, wb.fmtAt(this.sheet, p[0], p[1])).toLowerCase(), raw = SE.toStr(v).toLowerCase();
      if (lookAt === 1 ? (s === target || raw === target) : (s.indexOf(target) >= 0 || raw.indexOf(target) >= 0)) {
        var hit = this.mk(p[0], p[1], p[0], p[1]);
        this.m.lastFind = { what: what, lookAt: lookAt, at: hit, first: isNext ? (this.m.lastFind && this.m.lastFind.first) : hit };
        return hit;
      }
    }
    return NOTHING;
  };
  R.sort = function (a) {
    var key = arg(a, 0, 'key1', null), order = num(arg(a, 1, 'order1', 1)), header = num(arg(a, 9, 'header', 2));
    var wb = this.m.wb, t = wb.tableAt(this.sheet, this.r1, this.c1);
    var kc = key && isHost(key) ? key.c1 : this.c1;
    if (t && this.c1 <= t._c1 + 0 && this.r2 >= t._d1) {
      var rows = wb.rows(t).slice(), self = this;
      var vals = {}; rows.forEach(function (row, i) { vals[row.id] = wb.value(self.sheet, t._d1 + i, kc); });
      rows.sort(function (x, y) { return SE.compare(vals[x.id], vals[y.id]) * (order === 2 ? -1 : 1); });
      this.m.push(wb.apply([{ t: 'rorder', tb: t.name, ids: rows.map(function (r) { return r.id; }) }]));
      return;
    }
    var r1 = this.r1 + (header === 1 ? 1 : 0), r2 = Math.min(this.r2, wb.maxRow(this.sheet)), data = [];
    for (var r = r1; r <= r2; r++) {
      var row = [];
      for (var c = this.c1; c <= this.c2 && c <= wb.maxCol(this.sheet); c++) { var cell = wb.cellAt(this.sheet, r, c); row.push(cell && cell.f ? '=' + cell.f : cell ? cell.v : null); }
      data.push({ key: wb.value(this.sheet, r, kc), row: row });
    }
    data.sort(function (x, y) { return SE.compare(x.key, y.key) * (order === 2 ? -1 : 1); });
    var me = this;
    data.forEach(function (d, i) { d.row.forEach(function (v, j) { me.m.writeRaw(me.sheet, r1 + i, me.c1 + j, v); }); });
  };

  /* --- Worksheet, Workbook, collections ----------------------------------------------------------------------- */
  var SheetH = hostType('Worksheet', {
    name: ['value', function () { return this.sheet; }, function () { throw err(1004, 'Renaming sheets isn\'t supported'); }],
    codename: ['value', function () { var s = this.m.wb.sheet(this.sheet); return (s && s.code) || this.sheet; }],
    range: ['Range', function (a) { return this.m.range(this.sheet, a); }],
    cells: ['Range', function (a) { var r = new RangeH0(this.m, this.sheet, 1, 1, MAXR, MAXC, 'cells'); return a.length ? r.$item(a) : r; }],
    rows: ['Range', function (a) { var r = new RangeH0(this.m, this.sheet, 1, 1, MAXR, MAXC, 'rows'); if (!a.length) return r; if (typeof dflt(a[0]) === 'string') { var p = String(dflt(a[0])).split(':'); return new RangeH0(this.m, this.sheet, +p[0], 1, +(p[1] || p[0]), MAXC, 'rows'); } return new RangeH0(this.m, this.sheet, num(a[0]), 1, num(a[0]), MAXC, 'rows'); }],
    columns: ['Range', function (a) { var r = new RangeH0(this.m, this.sheet, 1, 1, MAXR, MAXC, 'cols'); if (!a.length) return r; var x = dflt(a[0]); if (typeof x === 'string') { var p = x.split(':'); return new RangeH0(this.m, this.sheet, 1, SE.colIndex(p[0]), MAXR, SE.colIndex(p[1] || p[0]), 'cols'); } return new RangeH0(this.m, this.sheet, 1, num(x), MAXR, num(x), 'cols'); }],
    usedrange: ['Range', function () { var wb = this.m.wb; return new RangeH0(this.m, this.sheet, 1, 1, Math.max(1, wb.maxRow(this.sheet)), Math.max(1, wb.maxCol(this.sheet))); }],
    listobjects: ['ListObjects', function (a) { var c = new ListObjectsH0(this.m, this.sheet); return a.length ? c.$item(a) : c; }],
    activate: ['void', function () { this.m.activate(this.sheet); }],
    select: ['void', function () { this.m.activate(this.sheet); }],
    index: ['value', function () { var self = this; return this.m.wb.bp.sheets.findIndex(function (s) { return s.name === self.sheet; }) + 1; }],
    visible: ['value', function () { var s = this.m.wb.sheet(this.sheet); return s && s.state !== 'visible' ? 0 : -1; }, function () {}],
    protect: ['void', function () {}], unprotect: ['void', function () {}],
    calculate: ['void', function () {}],
    parent: ['Workbook', function () { return this.m.workbookObj(); }],
    evaluate: ['value', function (a) { return this.m.evaluate(str(a[0]), this.sheet); }],
    next: ['Worksheet', function () { var i = this.$get('index', []); var s = this.m.wb.bp.sheets[i]; return s ? this.m.sheetObj(s.name) : NOTHING; }],
    previous: ['Worksheet', function () { var i = this.$get('index', []); var s = this.m.wb.bp.sheets[i - 2]; return s ? this.m.sheetObj(s.name) : NOTHING; }],
    printout: ['void', function () { this.m.host.toast && this.m.host.toast('Printing isn\'t available here: use your browser\'s Print instead.'); }],
    autofiltermode: ['value', function () { return false; }, function () {}],
    showalldata: ['void', function () {}],
    paste: ['void', function (a) { var d = arg(a, 0, 'destination', null) || this.m.selectionRange(); if (this.m.clipboard && d) this.m.clipboard.copyTo(d, false); }]
  });
  function SheetH0(m, sheet) { this.m = m; this.sheet = sheet; }
  SheetH0.prototype = SheetH.prototype;

  var SheetsH = hostType('Sheets', {
    count: ['value', function () { return this.m.wb.bp.sheets.length; }],
    item: ['Worksheet', function (a) { return this.$item(a); }],
    add: ['Worksheet', function () { throw err(1004, 'Adding sheets isn\'t supported (the app\'s screens are fixed)'); }]
  });
  function SheetsH0(m) { this.m = m; }
  SheetsH0.prototype = SheetsH.prototype;
  SheetsH.prototype.$item = function (a) {
    var k = dflt(a[0]), s;
    if (typeof k === 'number') s = this.m.wb.bp.sheets[k - 1];
    else s = this.m.wb.sheet(str(k));
    if (!s) throw err(9, 'There is no sheet called "' + str(k) + '"');
    return this.m.sheetObj(s.name);
  };
  SheetsH.prototype.$iter = function () { var m = this.m; return m.wb.bp.sheets.map(function (s) { return m.sheetObj(s.name); }); };

  var WorkbookH = hostType('Workbook', {
    sheets: ['Sheets', function (a) { var s = new SheetsH0(this.m); return a.length ? s.$item(a) : s; }],
    worksheets: ['Sheets', function (a) { var s = new SheetsH0(this.m); return a.length ? s.$item(a) : s; }],
    name: ['value', function () { return (this.m.wb.bp.file && this.m.wb.bp.file.name) || 'Workbook.xlsm'; }],
    fullname: ['value', function () { return (this.m.wb.bp.file && this.m.wb.bp.file.name) || 'Workbook.xlsm'; }],
    path: ['value', function () { return ''; }],
    save: ['void', function () { this.m.host.toast && this.m.host.toast('Saved (the app saves every change by itself).'); }],
    saveas: ['void', function () { throw err(1004, 'SaveAs isn\'t available: use Export to Excel in the app menu'); }],
    close: ['void', function () {}],
    activesheet: ['Worksheet', function () { return this.m.sheetObj(this.m.active()); }],
    names: ['Names', function (a) { var n = new NamesH0(this.m); return a.length ? n.$item(a) : n; }],
    codename: ['value', function () { return this.m.wb.bp.workbookCode || 'ThisWorkbook'; }],
    activate: ['void', function () {}],
    refreshall: ['void', function () {}]
  });
  function WorkbookH0(m) { this.m = m; }
  WorkbookH0.prototype = WorkbookH.prototype;

  var NamesH = hostType('Names', { count: ['value', function () { return (this.m.wb.bp.names || []).length; }] });
  function NamesH0(m) { this.m = m; }
  NamesH0.prototype = NamesH.prototype;
  NamesH.prototype.$item = function (a) {
    var k = str(a[0]), n = (this.m.wb.bp.names || []).filter(function (x) { return x.name.toLowerCase() === k.toLowerCase(); })[0];
    if (!n) throw err(1004, 'There is no name "' + k + '"');
    return new NameH0(this.m, n);
  };
  var NameH = hostType('Name', {
    name: ['value', function () { return this.n.name; }],
    refersto: ['value', function () { return '=' + this.n.ref; }],
    referstorange: ['Range', function () { var r = this.m.wb.refFromText(this.n.ref, this.m.active()); if (!r) throw err(1004, 'That name is not a range'); return new RangeH0(this.m, r.sheet, r.r1, r.c1, r.r2, r.c2); }],
    value: ['value', function () { return '=' + this.n.ref; }]
  });
  function NameH0(m, n) { this.m = m; this.n = n; }
  NameH0.prototype = NameH.prototype;

  /* --- ListObject (tables) ------------------------------------------------------------------------------------ */
  var ListObjectsH = hostType('ListObjects', {
    count: ['value', function () { return this.m.wb.tablesOn(this.sheet).length; }],
    item: ['ListObject', function (a) { return this.$item(a); }],
    add: ['ListObject', function () { throw err(1004, 'Creating tables from a macro isn\'t supported'); }]
  });
  function ListObjectsH0(m, sheet) { this.m = m; this.sheet = sheet; }
  ListObjectsH0.prototype = ListObjectsH.prototype;
  ListObjectsH.prototype.$item = function (a) {
    var k = dflt(a[0]), list = this.m.wb.tablesOn(this.sheet), t;
    t = typeof k === 'number' ? list[k - 1] : list.filter(function (x) { return x.name.toLowerCase() === str(k).toLowerCase(); })[0] || this.m.wb.tableByName(str(k));
    if (!t) throw err(9, 'There is no table called "' + str(k) + '"');
    return this.m.tableObj(t);
  };
  ListObjectsH.prototype.$iter = function () { var m = this.m; return m.wb.tablesOn(this.sheet).map(function (t) { return m.tableObj(t); }); };

  var TableH = hostType('ListObject', {
    name: ['value', function () { return this.t.name; }],
    displayname: ['value', function () { return this.t.name; }],
    listrows: ['ListRows', function (a) { var c = new ListRowsH0(this.m, this.t); return a.length ? c.$item(a) : c; }],
    listcolumns: ['ListColumns', function (a) { var c = new ListColsH0(this.m, this.t); return a.length ? c.$item(a) : c; }],
    databodyrange: ['Range', function () { var t = this.m.wb.tableByName(this.t.name); return t._d2 < t._d1 ? NOTHING : new RangeH0(this.m, t.sheet, t._d1, t._c1, t._d2, t._c2); }],
    headerrowrange: ['Range', function () { var t = this.t; return new RangeH0(this.m, t.sheet, t._hdr, t._c1, t._hdr, t._c2); }],
    totalsrowrange: ['Range', function () { var t = this.m.wb.tableByName(this.t.name); return t.totals ? new RangeH0(this.m, t.sheet, t._tot, t._c1, t._tot, t._c2) : NOTHING; }],
    range: ['Range', function () { var t = this.m.wb.tableByName(this.t.name); return new RangeH0(this.m, t.sheet, t._r1, t._c1, t._r2, t._c2); }],
    showtotals: ['value', function () { return !!this.t.totals; }, function () {}],
    parent: ['Worksheet', function () { return this.m.sheetObj(this.t.sheet); }],
    autofilter: ['stub', function () { return STUB; }],
    sort: ['stub', function () { return STUB; }],
    showautofilter: ['value', function () { return true; }, function () {}],
    tablestyle: ['value', function () { return this.t.style || ''; }, function () {}]
  });
  function TableH0(m, t) { this.m = m; this.t = t; }
  TableH0.prototype = TableH.prototype;

  var ListRowsH = hostType('ListRows', {
    count: ['value', function () { return this.m.wb.rows(this.t).length; }],
    add: ['ListRow', function (a) {
      var pos = arg(a, 0, 'position', null), rows = this.m.wb.rows(this.t), op = { t: 'radd', tb: this.t.name, id: SE.uid(), c: this.t.columns.map(function () { return null; }) };
      if (pos != null) { var p = num(pos); if (p <= 1) op.at = 0; else if (rows[p - 2]) op.after = rows[p - 2].id; }
      this.m.push(this.m.wb.apply([op]));
      return new ListRowH0(this.m, this.t, op.id);
    }],
    item: ['ListRow', function (a) { return this.$item(a); }]
  });
  function ListRowsH0(m, t) { this.m = m; this.t = t; }
  ListRowsH0.prototype = ListRowsH.prototype;
  ListRowsH.prototype.$item = function (a) { var i = num(a[0]), row = this.m.wb.rows(this.t)[i - 1]; if (!row) throw err(9, 'There is no row ' + i + ' in ' + this.t.name); return new ListRowH0(this.m, this.t, row.id); };
  ListRowsH.prototype.$iter = function () { var self = this; return this.m.wb.rows(this.t).map(function (r) { return new ListRowH0(self.m, self.t, r.id); }); };

  var ListRowH = hostType('ListRow', {
    range: ['Range', function (a) { var r = this.rowRange(); return a.length ? r.$item(a) : r; }],
    index: ['value', function () { return this.idx() + 1; }],
    delete: ['void', function () { this.m.push(this.m.wb.deleteRow(this.t, this.id)); }]
  });
  function ListRowH0(m, t, id) { this.m = m; this.t = t; this.id = id; }
  ListRowH0.prototype = ListRowH.prototype;
  ListRowH.prototype.idx = function () { var id = this.id, i = this.m.wb.rows(this.t).findIndex(function (r) { return r.id === id; }); if (i < 0) throw err(1004, 'That table row was deleted'); return i; };
  ListRowH.prototype.rowRange = function () { var t = this.m.wb.tableByName(this.t.name), r = t._d1 + this.idx(); return new RangeH0(this.m, t.sheet, r, t._c1, r, t._c2); };

  var ListColsH = hostType('ListColumns', {
    count: ['value', function () { return this.t.columns.length; }],
    item: ['ListColumn', function (a) { return this.$item(a); }],
    add: ['ListColumn', function () { throw err(1004, 'Adding table columns from a macro isn\'t supported'); }]
  });
  function ListColsH0(m, t) { this.m = m; this.t = t; }
  ListColsH0.prototype = ListColsH.prototype;
  ListColsH.prototype.$item = function (a) {
    var k = dflt(a[0]), j = typeof k === 'number' ? k - 1 : this.m.wb.colIndex(this.t, str(k));
    if (j < 0 || j >= this.t.columns.length) throw err(9, 'There is no column "' + str(k) + '" in ' + this.t.name);
    return new ListColH0(this.m, this.t, j);
  };
  ListColsH.prototype.$iter = function () { var self = this; return this.t.columns.map(function (c, j) { return new ListColH0(self.m, self.t, j); }); };
  var ListColH = hostType('ListColumn', {
    name: ['value', function () { return this.t.columns[this.j].name; }],
    index: ['value', function () { return this.j + 1; }],
    databodyrange: ['Range', function () { var t = this.m.wb.tableByName(this.t.name); return t._d2 < t._d1 ? NOTHING : new RangeH0(this.m, t.sheet, t._d1, t._c1 + this.j, t._d2, t._c1 + this.j); }],
    range: ['Range', function () { var t = this.m.wb.tableByName(this.t.name); return new RangeH0(this.m, t.sheet, t._r1, t._c1 + this.j, t._r2, t._c1 + this.j); }],
    totalscalculation: ['value', function () { return 0; }, function () {}]
  });
  function ListColH0(m, t, j) { this.m = m; this.t = t; this.j = j; }
  ListColH0.prototype = ListColH.prototype;

  /* --- Dictionary, Collection, Err, Debug, WorksheetFunction, Application ------------------------------------- */
  function dkey(k, textMode) { k = dflt(k); var s = (typeof k) + ':' + (k instanceof VDate ? k.__date : String(k)); return textMode ? s.toLowerCase() : s; }
  var DictH = hostType('Dictionary', {
    add: ['void', function (a) { var k = dkey(a[0], this.text); if (k in this.map) throw err(457, 'This key is already in the Dictionary: ' + str(a[0])); this.map[k] = [dflt(a[0]), a[1]]; this.order.push(k); }],
    exists: ['value', function (a) { return dkey(a[0], this.text) in this.map; }],
    item: ['value', function (a) { return this.$item(a); }, function (a, v) { this.$setItem(a, v); }],
    keys: ['value', function () { var self = this; return arr1(this.order.map(function (k) { return self.map[k][0]; })); }],
    items: ['value', function () { var self = this; return arr1(this.order.map(function (k) { return self.map[k][1]; })); }],
    count: ['value', function () { return this.order.length; }],
    remove: ['void', function (a) { var k = dkey(a[0], this.text); if (!(k in this.map)) throw err(32811, 'That key isn\'t in the Dictionary'); delete this.map[k]; this.order.splice(this.order.indexOf(k), 1); }],
    removeall: ['void', function () { this.map = {}; this.order = []; }],
    comparemode: ['value', function () { return this.text ? 1 : 0; }, function (a, v) { this.text = num(v) === 1; }],
    key: ['value', null, function (a, v) { var k = dkey(a[0], this.text); if (!(k in this.map)) return; var nk = dkey(v, this.text); this.map[nk] = [dflt(v), this.map[k][1]]; delete this.map[k]; this.order[this.order.indexOf(k)] = nk; }]
  });
  function DictH0() { this.map = {}; this.order = []; this.text = false; }
  DictH0.prototype = DictH.prototype;
  DictH.prototype.$item = function (a) { var k = dkey(a[0], this.text); if (!(k in this.map)) { this.map[k] = [dflt(a[0]), undefined]; this.order.push(k); } return this.map[k][1]; };
  DictH.prototype.$setItem = function (a, v) { var k = dkey(a[0], this.text); if (!(k in this.map)) this.order.push(k); this.map[k] = [dflt(a[0]), v]; };
  DictH.prototype.$iter = function () { var self = this; return this.order.map(function (k) { return self.map[k][0]; }); };

  var CollH = hostType('Collection', {
    add: ['void', function (a) {
      var item = a[0], key = arg(a, 1, 'key', null), before = arg(a, 2, 'before', null), after = arg(a, 3, 'after', null);
      var entry = { v: item, k: key == null ? null : str(key).toLowerCase() };
      if (entry.k != null && this.items.some(function (e) { return e.k === entry.k; })) throw err(457, 'This key is already in the Collection');
      if (before != null) this.items.splice(num(before) - 1, 0, entry); else if (after != null) this.items.splice(num(after), 0, entry); else this.items.push(entry);
    }],
    item: ['value', function (a) { return this.$item(a); }],
    count: ['value', function () { return this.items.length; }],
    remove: ['void', function (a) { var i = this.find(a[0]); this.items.splice(i, 1); }]
  });
  function CollH0() { this.items = []; }
  CollH0.prototype = CollH.prototype;
  CollH.prototype.find = function (k) { k = dflt(k); var i = typeof k === 'number' ? k - 1 : this.items.findIndex(function (e) { return e.k === str(k).toLowerCase(); }); if (i < 0 || i >= this.items.length) throw err(5, 'That item isn\'t in the Collection'); return i; };
  CollH.prototype.$item = function (a) { return this.items[this.find(a[0])].v; };
  CollH.prototype.$iter = function () { return this.items.map(function (e) { return e.v; }); };

  var ErrH = hostType('ErrObject', {
    number: ['value', function () { return this.number; }, function (a, v) { this.number = num(v); }],
    description: ['value', function () { return this.description; }, function (a, v) { this.description = str(v); }],
    source: ['value', function () { return this.source || 'VBAProject'; }, function (a, v) { this.source = str(v); }],
    raise: ['void', function (a) { var n = num(arg(a, 0, 'number', 0)); throw err(n, str(arg(a, 2, 'description', 'Application-defined or object-defined error'))); }],
    clear: ['void', function () { this.number = 0; this.description = ''; }]
  });
  function ErrH0() { this.number = 0; this.description = ''; }
  ErrH0.prototype = ErrH.prototype;
  ErrH.prototype.$dflt = function () { return this.number; };

  var DebugH = hostType('Debug', {
    print: ['void', function (a) { this.m.log(a.map(function (x) { return x === MISSING ? '' : str(x); }).join(' ')); }],
    assert: ['void', function () {}]
  });
  function DebugH0(m) { this.m = m; }
  DebugH0.prototype = DebugH.prototype;

  /* WorksheetFunction.X(...) runs the engine's Excel function X; an Excel error becomes a VBA error (like Excel). */
  function toEngine(m, v) {
    if (v === MISSING) return undefined;
    if (isHost(v) && v.$type === 'Range') return new SE.Rng(m.wb, v.sheet, v.r1, v.c1, Math.min(v.r2, MAXR), Math.min(v.c2, MAXC));
    if (v instanceof VArr) {
      if (v.dims.length === 1) return [v.data.map(function (x) { return toCell(x); })];
      var rows = [], h = v.dims[0][1] - v.dims[0][0] + 1, w = v.dims[1][1] - v.dims[1][0] + 1;
      for (var i = 0; i < h; i++) { var row = []; for (var j = 0; j < w; j++) row.push(toCell(v.get([v.dims[0][0] + i, v.dims[1][0] + j]))); rows.push(row); }
      return rows;
    }
    if (v instanceof VDate) return v.__date;
    if (v === undefined) return null;
    return v;
  }
  function fromEngine(m, v) {
    if (v instanceof SE.Rng) { if (v.r1 === v.r2 && v.c1 === v.c2) return fromCell(v.get(0, 0), m.wb.fmtAt(v.sheet, v.r1, v.c1)); return new RangeH0(m, v.sheet, v.r1, v.c1, v.r2, v.c2); }
    if (Array.isArray(v)) { var rows = v.length, cols = (v[0] || []).length, a = new VArr([[1, rows], [1, cols]]); for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) a.set([i + 1, j + 1], v[i][j]); return a; }
    return v === null ? undefined : v;
  }
  function callFn(m, name, args, raise) {
    var f = SE.FN[name.toUpperCase()];
    if (!f) throw err(438, 'WorksheetFunction.' + name + ' isn\'t available');
    var ea = args.map(function (x) { return toEngine(m, x); });
    var out;
    if (f.lazy) out = f(ea.map(function (x) { return { t: 'val', v: x }; }), function (n) { return n.v; });
    else out = f(ea, null);
    if (SE.isErr(out)) { if (raise) throw err(1004, 'Unable to get the ' + name + ' property of the WorksheetFunction class (' + out.code + ')'); return out; }
    return fromEngine(m, out);
  }
  var WsfH = hostType('WorksheetFunction', {});
  function WsfH0(m) { this.m = m; }
  WsfH0.prototype = WsfH.prototype;
  WsfH.prototype.$get = function (n, args) { return callFn(this.m, n, args || [], true); };

  var AppH = hostType('Application', {
    screenupdating: ['value', function () { return true; }, function () {}],
    displayalerts: ['value', function () { return true; }, function () {}],
    enableevents: ['value', function () { return this.m.events; }, function (a, v) { this.m.events = bool(v); }],
    calculation: ['value', function () { return -4105; }, function () {}],
    statusbar: ['value', function () { return false; }, function (a, v) { v = dflt(v); if (v !== false && v !== '') this.m.host.toast && this.m.host.toast(str(v)); }],
    cutcopymode: ['value', function () { return false; }, function () { this.m.clipboard = null; }],
    worksheetfunction: ['WorksheetFunction', function () { return new WsfH0(this.m); }],
    inputbox: ['value', function (a) {
      var m = this.m, type = num(arg(a, 7, 'type', 2));
      return m.ask(str(arg(a, 0, 'prompt', '')), str(arg(a, 1, 'title', 'Input')), str(arg(a, 2, 'default', ''))).then(function (v) {
        if (v == null) return false;
        if (type === 1) { if (!isNumeric(v)) throw err(13, 'Please enter a number'); return num(v); }
        if (type === 8) { var r = m.range(m.active(), [v]); return r; }
        return v;
      });
    }],
    run: ['value', function (a) { var name = str(a[0]).replace(/^.*!/, ''); return { __run: name, args: a.slice(1) }; }],
    intersect: ['Range', function (a) { return this.m.intersect(a.filter(function (x) { return x !== MISSING; })); }],
    union: ['Range', function (a) {
      var rs = a.filter(function (x) { return isHost(x); }), f = rs[0];
      if (rs.length === 1) return f;
      var r1 = Math.min.apply(null, rs.map(function (r) { return r.r1; })), r2 = Math.max.apply(null, rs.map(function (r) { return r.r2; }));
      var c1 = Math.min.apply(null, rs.map(function (r) { return r.c1; })), c2 = Math.max.apply(null, rs.map(function (r) { return r.c2; }));
      var cells = rs.reduce(function (n, r) { return n + r.cellCount(); }, 0);
      if (cells !== (r2 - r1 + 1) * (c2 - c1 + 1)) throw err(1004, 'Union of separate ranges isn\'t supported');
      return new RangeH0(this.m, f.sheet, r1, c1, r2, c2, f.mode);
    }],
    wait: ['void', function () {}],
    ontime: ['void', function () { throw err(1004, 'Application.OnTime (timers) isn\'t supported'); }],
    username: ['value', function () { return this.m.host.user || 'User'; }, function () {}],
    activesheet: ['Worksheet', function () { return this.m.sheetObj(this.m.active()); }],
    activeworkbook: ['Workbook', function () { return this.m.workbookObj(); }],
    thisworkbook: ['Workbook', function () { return this.m.workbookObj(); }],
    activecell: ['Range', function () { return this.m.selectionRange(true); }],
    selection: ['Range', function () { return this.m.selectionRange(false); }],
    sheets: ['Sheets', function (a) { var s = new SheetsH0(this.m); return a.length ? s.$item(a) : s; }],
    worksheets: ['Sheets', function (a) { var s = new SheetsH0(this.m); return a.length ? s.$item(a) : s; }],
    range: ['Range', function (a) { return this.m.range(this.m.active(), a); }],
    cells: ['Range', function (a) { return new SheetH0(this.m, this.m.active()).$get('cells', a); }],
    rows: ['Range', function (a) { return new SheetH0(this.m, this.m.active()).$get('rows', a); }],
    columns: ['Range', function (a) { return new SheetH0(this.m, this.m.active()).$get('columns', a); }],
    version: ['value', function () { return '16.0'; }],
    volatile: ['void', function () {}],
    calculate: ['void', function () {}],
    caller: ['value', function () { return this.m.caller || ''; }],
    evaluate: ['value', function (a) { return this.m.evaluate(str(a[0]), this.m.active()); }],
    goto: ['void', function (a) { var r = arg(a, 0, 'reference', null); if (r && isHost(r)) this.m.select(r); }],
    quit: ['void', function () { throw new Stop('end'); }],
    getopenfilename: ['value', function () { throw err(1004, 'Opening files from a macro isn\'t possible in the app'); }],
    getsaveasfilename: ['value', function () { throw err(1004, 'Saving files from a macro isn\'t possible in the app'); }],
    international: ['value', function () { return 0; }],
    decimalseparator: ['value', function () { return '.'; }, function () {}],
    thousandsseparator: ['value', function () { return ','; }, function () {}],
    usesystemseparators: ['value', function () { return true; }, function () {}],
    displayfullscreen: ['value', function () { return false; }, function () {}],
    windowstate: ['value', function () { return -4143; }, function () {}]
  });
  function AppH0(m) { this.m = m; }
  AppH0.prototype = AppH.prototype;
  var appGet = AppH.prototype.$get;
  /* Application.VLookup & co return an error value instead of raising (Excel's quirk). */
  AppH.prototype.$get = function (n, args) {
    if (!TYPES.Application.members[n] && SE.FN[n.toUpperCase()]) return callFn(this.m, n, args || [], false);
    return appGet.call(this, n, args);
  };

  /* ------------------------------------------------------------------------------------------ built-in functions */
  var FMT = { 'general number': 'General', currency: '$#,##0.00;($#,##0.00)', fixed: '0.00', standard: '#,##0.00', percent: '0.00%', scientific: '0.00E+00',
    'general date': null, 'long date': 'dddd, mmmm d, yyyy', 'medium date': 'dd-mmm-yy', 'short date': 'yyyy-mm-dd', 'long time': 'h:mm:ss AM/PM', 'medium time': 'h:mm AM/PM', 'short time': 'hh:mm' };
  function vbaFormat(v, f) {
    v = dflt(v);
    if (f == null || f === '' || f === MISSING) return str(v);
    f = str(f);
    var low = f.toLowerCase();
    if (low === 'yes/no') return bool(v) ? 'Yes' : 'No';
    if (low === 'true/false') return bool(v) ? 'True' : 'False';
    if (low === 'on/off') return bool(v) ? 'On' : 'Off';
    if (low in FMT) { if (FMT[low] === null) return str(v instanceof VDate ? v : new VDate(dateOf(v))); f = FMT[low]; }
    var isD = v instanceof VDate || (typeof v === 'string' && parseDate(v) != null && !isNumeric(v));
    var x = v instanceof VDate ? v.__date : (typeof v === 'string' && isD) ? parseDate(v) : v;
    if (/[ynhsdqw]/i.test(f.replace(/"[^"]*"/g, '')) && (isD || typeof x === 'number')) f = f.replace(/n/gi, 'm').replace(/\bq\b/g, '').replace(/AMPM/i, 'AM/PM');
    if (typeof x === 'string') { if (isNumeric(x)) x = num(x); else return f.indexOf('@') >= 0 ? f.replace(/@/g, x) : x; }
    if (x === undefined || x === null) x = 0;
    if (typeof x === 'boolean') x = x ? -1 : 0;
    return SE.formatValue(x, f);
  }
  function dateAdd(unit, n, d) {
    var s = dateOf(d), p = SE.serialToParts(s), frac = s - Math.floor(s);
    n = Math.trunc(num(n));
    switch (str(unit).toLowerCase()) {
      case 'd': case 'y': case 'w': return new VDate(s + n);
      case 'ww': return new VDate(s + 7 * n);
      case 'h': return new VDate(s + n / 24);
      case 'n': return new VDate(s + n / 1440);
      case 's': return new VDate(s + n / 86400);
      case 'm': case 'q': case 'yyyy': {
        var months = unit === 'yyyy' ? 12 * n : unit === 'q' ? 3 * n : n;
        var m0 = p.m - 1 + months, y = p.y + Math.floor(m0 / 12); m0 = ((m0 % 12) + 12) % 12;
        var last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
        return new VDate(SE.dateToSerial(y, m0 + 1, Math.min(p.d, last)) + frac);
      }
    }
    throw err(5, 'Unknown DateAdd interval "' + unit + '"');
  }
  function dateDiff(unit, a, b) {
    var x = dateOf(a), y = dateOf(b), px = SE.serialToParts(x), py = SE.serialToParts(y);
    switch (str(unit).toLowerCase()) {
      case 'd': case 'y': return Math.floor(y) - Math.floor(x);
      case 'w': return Math.trunc((Math.floor(y) - Math.floor(x)) / 7);
      case 'ww': return Math.floor((Math.floor(y) - px.dow - Math.floor(x) + px.dow) / 7);
      case 'h': return Math.floor(y * 24) - Math.floor(x * 24);
      case 'n': return Math.floor(y * 1440) - Math.floor(x * 1440);
      case 's': return Math.round((y - x) * 86400);
      case 'm': return (py.y - px.y) * 12 + py.m - px.m;
      case 'q': return (py.y - px.y) * 4 + Math.floor((py.m - 1) / 3) - Math.floor((px.m - 1) / 3);
      case 'yyyy': return py.y - px.y;
    }
    throw err(5, 'Unknown DateDiff interval "' + unit + '"');
  }
  function a0(a, i, d) { var v = a[i]; return v === undefined || v === MISSING ? d : v; }
  function typeName(v) {
    if (v === undefined) return 'Empty';
    if (v === null) return 'Null';
    if (v === NOTHING) return 'Nothing';
    if (isHost(v)) return v.$type;
    if (v instanceof VArr) return 'Variant()';
    if (v instanceof VDate) return 'Date';
    if (SE.isErr(v)) return 'Error';
    if (typeof v === 'boolean') return 'Boolean';
    if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2147483648 ? (Math.abs(v) < 32768 ? 'Integer' : 'Long') : 'Double';
    return 'String';
  }
  var VB = {
    len: function (a) { var v = dflt(a[0]); return v === null ? null : str(v).length; },
    left: function (a) { return str(a[0]).slice(0, Math.max(0, num(a[1]))); },
    right: function (a) { var s = str(a[0]), n = num(a[1]); return n <= 0 ? '' : s.slice(-n); },
    mid: function (a) { var s = str(a[0]), st = num(a[1]); if (st < 1) throw err(5, 'Mid start must be 1 or more'); return a.length > 2 && a[2] !== MISSING ? s.substr(st - 1, num(a[2])) : s.slice(st - 1); },
    ucase: function (a) { return str(a[0]).toUpperCase(); },
    lcase: function (a) { return str(a[0]).toLowerCase(); },
    trim: function (a) { return str(a[0]).replace(/^ +| +$/g, ''); },
    ltrim: function (a) { return str(a[0]).replace(/^ +/, ''); },
    rtrim: function (a) { return str(a[0]).replace(/ +$/, ''); },
    instr: function (a, m, f) {
      var start = 1, s, find, mode = f.module.textCompare ? 1 : 0;
      if (a.length >= 3 && typeof dflt(a[0]) === 'number' && a[2] !== MISSING) { start = num(a[0]); s = str(a[1]); find = str(a[2]); if (a.length > 3 && a[3] !== MISSING) mode = num(a[3]); }
      else { s = str(a[0]); find = str(a[1]); if (a.length > 2 && a[2] !== MISSING) mode = num(a[2]); }
      if (mode === 1) { s = s.toLowerCase(); find = find.toLowerCase(); }
      if (find === '') return start;
      return s.indexOf(find, start - 1) + 1;
    },
    instrrev: function (a) { var s = str(a[0]), f = str(a[1]), st = a.length > 2 && a[2] !== MISSING ? num(a[2]) : -1; var i = st < 0 ? s.lastIndexOf(f) : s.lastIndexOf(f, st - 1); return i + 1; },
    replace: function (a) {
      var s = str(a[0]), f = str(a[1]), r = str(a[2]), start = num(a0(a, 3, 1)), count = num(a0(a, 4, -1)), mode = num(a0(a, 5, 0));
      if (f === '') return s;
      var src = s.slice(start - 1), out = '', i = 0, n = 0, hay = mode === 1 ? src.toLowerCase() : src, needle = mode === 1 ? f.toLowerCase() : f;
      for (;;) { var k = hay.indexOf(needle, i); if (k < 0 || (count >= 0 && n >= count)) break; out += src.slice(i, k) + r; i = k + f.length; n++; }
      return out + src.slice(i);
    },
    split: function (a) { var s = str(a[0]), d = a.length > 1 && a[1] !== MISSING ? str(a[1]) : ' ', lim = num(a0(a, 2, -1)); if (s === '') return new VArr([[0, -1]], []); var parts = d === '' ? [s] : s.split(d); if (lim > 0 && parts.length > lim) parts = parts.slice(0, lim - 1).concat([parts.slice(lim - 1).join(d)]); return arr1(parts); },
    join: function (a) { var v = dflt(a[0]); if (!(v instanceof VArr)) throw err(13, 'Join needs an array'); return v.data.map(function (x) { return str(x); }).join(a.length > 1 && a[1] !== MISSING ? str(a[1]) : ' '); },
    space: function (a) { return new Array(Math.max(0, num(a[0])) + 1).join(' '); },
    string: function (a) { var c = dflt(a[1]); c = typeof c === 'number' ? String.fromCharCode(c) : str(c)[0] || ''; return new Array(Math.max(0, num(a[0])) + 1).join(c); },
    strcomp: function (a) { var x = str(a[0]), y = str(a[1]); if (num(a0(a, 2, 0)) === 1) { x = x.toLowerCase(); y = y.toLowerCase(); } return x < y ? -1 : x > y ? 1 : 0; },
    strreverse: function (a) { return str(a[0]).split('').reverse().join(''); },
    strconv: function (a) { var s = str(a[0]), k = num(a[1]); return k === 1 ? s.toUpperCase() : k === 2 ? s.toLowerCase() : k === 3 ? s.toLowerCase().replace(/(^|\s)(\S)/g, function (m, p, c) { return p + c.toUpperCase(); }) : s; },
    chr: function (a) { return String.fromCharCode(num(a[0])); }, chrw: function (a) { return String.fromCharCode(num(a[0])); },
    asc: function (a) { var s = str(a[0]); if (!s) throw err(5, 'Asc of an empty string'); return s.charCodeAt(0); }, ascw: function (a) { return str(a[0]).charCodeAt(0); },
    cstr: function (a) { return str(a[0]); },
    cint: function (a) { var n = bankers(num(a[0]), 0); if (n < -32768 || n > 32767) throw err(6, 'Overflow'); return n; },
    clng: function (a) { return bankers(num(a[0]), 0); }, clnglng: function (a) { return bankers(num(a[0]), 0); }, cbyte: function (a) { return bankers(num(a[0]), 0); },
    cdbl: function (a) { return num(a[0]); }, csng: function (a) { return num(a[0]); }, cdec: function (a) { return num(a[0]); },
    ccur: function (a) { return Math.round(num(a[0]) * 10000) / 10000; },
    cdate: function (a) { return new VDate(dateOf(a[0])); }, cvdate: function (a) { return new VDate(dateOf(a[0])); },
    cbool: function (a) { return bool(a[0]); },
    cvar: function (a) { return dflt(a[0]); },
    cverr: function (a) { var n = num(a[0]); return SE.errOf({ 2042: '#N/A', 2007: '#DIV/0!', 2015: '#VALUE!', 2023: '#REF!', 2029: '#NAME?', 2036: '#NUM!' }[n] || '#VALUE!'); },
    val: function (a) { var m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(str(a[0]).replace(/\s+/g, '')); return m ? parseFloat(m[0]) : 0; },
    str: function (a) { var n = num(a[0]); return (n >= 0 ? ' ' : '') + SE.generalNum(n); },
    format: function (a) { return vbaFormat(a[0], a0(a, 1, null)); },
    formatnumber: function (a) { var d = num(a0(a, 1, 2)); return SE.formatValue(num(a[0]), '#,##0' + (d > 0 ? '.' + new Array(d + 1).join('0') : '')); },
    formatcurrency: function (a) { var d = num(a0(a, 1, 2)); return SE.formatValue(num(a[0]), '$#,##0' + (d > 0 ? '.' + new Array(d + 1).join('0') : '')); },
    formatpercent: function (a) { var d = num(a0(a, 1, 2)); return SE.formatValue(num(a[0]), '0' + (d > 0 ? '.' + new Array(d + 1).join('0') : '') + '%'); },
    formatdatetime: function (a) { var k = num(a0(a, 1, 0)); return vbaFormat(new VDate(dateOf(a[0])), ['General Date', 'Long Date', 'Short Date', 'Long Time', 'Short Time'][k] || 'General Date'); },
    isempty: function (a) { var v = dflt(a[0]); return v === undefined || (isHost(a[0]) && (v === undefined || v === null)); },
    isnumeric: function (a) { var v = dflt(a[0]); return v !== undefined && isNumeric(v); },
    isdate: function (a) { var v = dflt(a[0]); return v instanceof VDate || (typeof v === 'string' && parseDate(v) != null); },
    isnull: function (a) { return dflt(a[0]) === null; },
    isarray: function (a) { return a[0] instanceof VArr; },
    isobject: function (a) { return isObj(a[0]); },
    iserror: function (a) { var v = a[0]; try { v = dflt(v); } catch (e) { return false; } return SE.isErr(v); },
    ismissing: function (a) { return a[0] === MISSING; },
    ubound: function (a) { var v = dflt(a[0]); if (!(v instanceof VArr)) throw err(13, 'UBound needs an array'); var d = num(a0(a, 1, 1)); if (!v.dims[d - 1]) throw err(9, 'Subscript out of range'); return v.dims[d - 1][1]; },
    lbound: function (a) { var v = dflt(a[0]); if (!(v instanceof VArr)) throw err(13, 'LBound needs an array'); var d = num(a0(a, 1, 1)); if (!v.dims[d - 1]) throw err(9, 'Subscript out of range'); return v.dims[d - 1][0]; },
    array: function (a) { return arr1(a.map(function (x) { return x === MISSING ? undefined : x; })); },
    now: function () { return new VDate(SE.nowSerial()); },
    date: function () { return new VDate(SE.todaySerial()); },
    time: function () { var s = SE.nowSerial(); return new VDate(s - Math.floor(s)); },
    timer: function () { var d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000; },
    year: function (a) { return SE.serialToParts(dateOf(a[0])).y; },
    month: function (a) { return SE.serialToParts(dateOf(a[0])).m; },
    day: function (a) { return SE.serialToParts(dateOf(a[0])).d; },
    hour: function (a) { return SE.serialToParts(dateOf(a[0])).H; },
    minute: function (a) { return SE.serialToParts(dateOf(a[0])).M; },
    second: function (a) { return SE.serialToParts(dateOf(a[0])).S; },
    weekday: function (a) { var dow = SE.serialToParts(dateOf(a[0])).dow, first = num(a0(a, 1, 1)) || 1; return ((dow - (first - 1) + 7) % 7) + 1; },
    weekdayname: function (a) { var n = num(a[0]), ab = a.length > 1 && a[1] !== MISSING && bool(a[1]); var d = SE.DAYS[(n - 1 + (num(a0(a, 2, 1)) - 1)) % 7]; return ab ? d.slice(0, 3) : d; },
    monthname: function (a) { var mm = SE.MONTHS[num(a[0]) - 1]; if (!mm) throw err(5, 'Month must be 1 to 12'); return a.length > 1 && a[1] !== MISSING && bool(a[1]) ? mm.slice(0, 3) : mm; },
    dateadd: function (a) { return dateAdd(str(a[0]).toLowerCase(), a[1], a[2]); },
    datediff: function (a) { return dateDiff(str(a[0]).toLowerCase(), a[1], a[2]); },
    datepart: function (a) { var u = str(a[0]).toLowerCase(), p = SE.serialToParts(dateOf(a[1])); return { yyyy: p.y, m: p.m, d: p.d, h: p.H, n: p.M, s: p.S, w: p.dow + 1, q: Math.floor((p.m - 1) / 3) + 1, y: dateOf(a[1]) - SE.dateToSerial(p.y, 1, 1) + 1 }[u]; },
    dateserial: function (a) { var y = num(a[0]), mo = num(a[1]), d = num(a[2]); if (y < 100) y += y < 30 ? 2000 : 1900; var dt = new Date(Date.UTC(y, mo - 1, 1)); return new VDate(SE.dateToSerial(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) + d - 1); },
    datevalue: function (a) { return new VDate(Math.floor(dateOf(a[0]))); },
    timeserial: function (a) { return new VDate(((num(a[0]) * 3600 + num(a[1]) * 60 + num(a[2])) / 86400)); },
    timevalue: function (a) { var d = dateOf(a[0]); return new VDate(d - Math.floor(d)); },
    abs: function (a) { return Math.abs(num(a[0])); }, int: function (a) { return Math.floor(num(a[0])); }, fix: function (a) { return Math.trunc(num(a[0])); },
    round: function (a) { return bankers(num(a[0]), num(a0(a, 1, 0))); },
    sqr: function (a) { var n = num(a[0]); if (n < 0) throw err(5, 'Square root of a negative number'); return Math.sqrt(n); },
    rnd: function () { return Math.random(); }, sgn: function (a) { return Math.sign(num(a[0])); }, exp: function (a) { return Math.exp(num(a[0])); },
    log: function (a) { var n = num(a[0]); if (n <= 0) throw err(5, 'Log of zero or less'); return Math.log(n); },
    sin: function (a) { return Math.sin(num(a[0])); }, cos: function (a) { return Math.cos(num(a[0])); }, tan: function (a) { return Math.tan(num(a[0])); }, atn: function (a) { return Math.atan(num(a[0])); },
    hex: function (a) { return Math.round(num(a[0])).toString(16).toUpperCase(); }, oct: function (a) { return Math.round(num(a[0])).toString(8); },
    typename: function (a) { return typeName(a[0]); },
    vartype: function (a) { var t = typeName(a[0]); return { Empty: 0, Null: 1, Integer: 2, Long: 3, Double: 5, Date: 7, String: 8, Boolean: 11, 'Variant()': 8204, Error: 10 }[t] || 9; },
    iif: function (a) { return bool(a[0]) ? a[1] : a[2]; },
    choose: function (a) { var i = num(a[0]); return i >= 1 && i < a.length ? a[i] : null; },
    switch: function (a) { for (var i = 0; i + 1 < a.length; i += 2) if (bool(a[i])) return a[i + 1]; return null; },
    nz: function (a) { var v = dflt(a[0]); return v == null || v === '' ? a0(a, 1, '') : v; },
    rgb: function (a) { return num(a[0]) + 256 * num(a[1]) + 65536 * num(a[2]); },
    qbcolor: function () { return 0; },
    environ: function (a, m) { var k = str(a[0]).toLowerCase(); if (k === 'username' || k === 'user') return m.host.user || 'User'; if (k === 'computername') return 'Sheetsmith'; return ''; },
    doevents: function () { return 0; },
    randomize: function () {},
    beep: function () {},
    filter: function (a) { var v = dflt(a[0]), s = str(a[1]), inc = a.length > 2 && a[2] !== MISSING ? bool(a[2]) : true; if (!(v instanceof VArr)) throw err(13, 'Filter needs an array'); return arr1(v.data.filter(function (x) { return (str(x).indexOf(s) >= 0) === inc; })); },
    createobject: function (a) {
      var cls = str(a[0]).toLowerCase();
      if (cls === 'scripting.dictionary') return new DictH0();
      if (cls === 'system.collections.arraylist') throw err(429, 'ArrayList isn\'t available; use a Collection');
      throw err(429, 'CreateObject("' + str(a[0]) + '") can\'t run in a web app (' + (/outlook/i.test(cls) ? 'Outlook email' : /word/i.test(cls) ? 'Word' : /filesystem|scripting\.file/i.test(cls) ? 'files on this computer' : /xmlhttp|winhttp/i.test(cls) ? 'web requests' : 'other programs') + ')');
    },
    getobject: function () { throw err(429, 'GetObject can\'t run in a web app'); },
    shell: function () { throw err(5, 'Shell (running programs) can\'t run in a web app'); },
    dir: function () { throw err(5, 'Dir (files on this computer) can\'t run in a web app'); },
    freefile: function () { throw err(5, 'Files on this computer can\'t be used in a web app'); },
    curdir: function () { return ''; },
    msgbox: function (a, m) { return m.msgbox(a[0] === undefined ? '' : str(a[0]), num(a0(a, 1, 0)), a0(a, 2, null) == null ? '' : str(a[2])); },
    inputbox: function (a, m) { return m.ask(str(a0(a, 0, '')), a0(a, 1, null) == null ? '' : str(a[1]), a0(a, 2, null) == null ? '' : str(a[2])).then(function (v) { return v == null ? '' : v; }); },
    error: function (a) { return 'Error ' + num(a0(a, 0, 0)); },
    evaluate: function (a, m) { return m.evaluate(str(a[0]), m.active()); }
  };
  /* functions that keep objects as they are (no default-value conversion) */
  var KEEP_OBJ = { isobject: 1, typename: 1, vartype: 1, isempty: 1, ismissing: 1, iserror: 1, iif: 1, choose: 1, switch: 1, isarray: 1, array: 1 };
  V.BUILTINS = VB;

  var CONST = {
    xlup: -4162, xldown: -4121, xltoleft: -4159, xltoright: -4161, xlvalues: -4163, xlformulas: -4123, xlwhole: 1, xlpart: 2, xlascending: 1, xldescending: 2,
    xlyes: 1, xlno: 2, xlguess: 0, xlpastevalues: -4163, xlpasteall: -4104, xlpasteformats: -4122, xlpastevaluesandnumberformats: 12, xlcelltypelastcell: 11,
    xlcelltypeblanks: 4, xlcelltypeconstants: 2, xlcelltypeformulas: -4123, xlcelltypevisible: 12, xlshiftup: -4162, xlshiftdown: -4121, xlshifttoleft: -4159,
    xlnone: -4142, xlcalculationmanual: -4135, xlcalculationautomatic: -4105, xlsheetvisible: -1, xlsheethidden: 0, xlsheetveryhidden: 2, xlbyrows: 1, xlbycolumns: 2,
    xlnext: 1, xlprevious: 2, xlfiltervalues: 7, xland: 1, xlor: 2, xlcenter: -4108, xlleft: -4131, xlright: -4152, xlcontinuous: 1, xlthin: 2, xlmedium: -4138,
    xlthick: 4, xledgebottom: 9, xledgetop: 8, xledgeleft: 7, xledgeright: 10, xlsolid: 1, xlautomatic: -4105, xla1: 1, xlr1c1: -4150, xlworkbookdefault: 51,
    xlopenxmlworkbookmacroenabled: 52, xllastcell: 11, xlerrna: 2042, xlerrdiv0: 2007, xlerrvalue: 2015, xlerrref: 2023, xlerrname: 2029, xlerrnum: 2036,
    xlsortonvalues: 0, xlsortnormal: 0, xltopbottom: 1, xlpincomplete: 0, xlwait: 2, xldefault: -4143, xlnormal: -4143, xlmaximized: -4137, xlminimized: -4140,
    vbokonly: 0, vbokcancel: 1, vbabortretryignore: 2, vbyesnocancel: 3, vbyesno: 4, vbretrycancel: 5, vbcritical: 16, vbquestion: 32, vbexclamation: 48,
    vbinformation: 64, vbdefaultbutton1: 0, vbdefaultbutton2: 256, vbdefaultbutton3: 512, vbapplicationmodal: 0, vbsystemmodal: 4096, vbmsgboxsetforeground: 65536,
    vbok: 1, vbcancel: 2, vbabort: 3, vbretry: 4, vbignore: 5, vbyes: 6, vbno: 7,
    vbcrlf: '\n', vbnewline: '\n', vbcr: '\n', vblf: '\n', vbtab: '\t', vbnullstring: '', vbnullchar: '\u0000', vbback: '\b', vbformfeed: '\f', vbverticaltab: '\v',
    vbbinarycompare: 0, vbtextcompare: 1, vbsunday: 1, vbmonday: 2, vbtuesday: 3, vbwednesday: 4, vbthursday: 5, vbfriday: 6, vbsaturday: 7, vbusesystemdayofweek: 0,
    vbfirstjan1: 1, vbempty: 0, vbnull: 1, vbinteger: 2, vblong: 3, vbsingle: 4, vbdouble: 5, vbcurrency: 6, vbdate: 7, vbstring: 8, vbobject: 9, vberror: 10,
    vbboolean: 11, vbvariant: 12, vbarray: 8192, vbred: 255, vbgreen: 65280, vbblue: 16711680, vbyellow: 65535, vbwhite: 16777215, vbblack: 0, vbmagenta: 16711935, vbcyan: 16776960,
    vbgeneraldate: 0, vblongdate: 1, vbshortdate: 2, vblongtime: 3, vbshorttime: 4, vbobjecterror: -2147221504, vbuppercase: 1, vblowercase: 2, vbpropercase: 3,
    msotrue: -1, msofalse: 0, true: true, false: false
  };
  V.CONST = CONST;
  /* Global objects and their types (also used by the checker). */
  var GLOBAL_TYPES = { application: 'Application', activesheet: 'Worksheet', activeworkbook: 'Workbook', thisworkbook: 'Workbook', activecell: 'Range', selection: 'Range',
    sheets: 'Sheets', worksheets: 'Sheets', range: 'Range', cells: 'Range', rows: 'Range', columns: 'Range', worksheetfunction: 'WorksheetFunction', err: 'ErrObject',
    debug: 'Debug', intersect: 'Range', union: 'Range', names: 'Names' };

  /* ------------------------------------------------------------------------------------------ the machine */
  var LIMIT = 2000000;
  function Machine(modules, wb, host) {
    var self = this;
    this.wb = wb; this.host = host || {}; this.events = true; this.errObj = new ErrH0(); this.logs = [];
    this.mods = {}; this.procs = {}; this.globals = {}; this.globalConsts = {}; this.problems = [];
    (modules || []).forEach(function (src) {
      var ast = V.parse(src.code || '', src.name);
      var mod = { name: src.name, lname: src.name.toLowerCase(), kind: src.kind || 'standard', sheet: src.sheet || null, workbook: !!src.workbook,
        ast: ast, vars: {}, consts: {}, procs: {}, textCompare: ast.textCompare, explicit: ast.explicit, base: ast.base };
      ast.problems.forEach(function (p) { self.problems.push({ module: src.name, line: p.line, text: p.text }); });
      ast.procs.forEach(function (p) { mod.procs[p.lname] = p; p.mod = mod; });
      self.mods[mod.lname] = mod;
      if (mod.kind === 'standard') ast.procs.forEach(function (p) { if (!p.private && !self.procs[p.lname]) self.procs[p.lname] = p; });
    });
    // module variables and constants (constants may refer to earlier constants)
    Object.keys(this.mods).forEach(function (k) {
      var mod = self.mods[k];
      mod.ast.vars.forEach(function (v) {
        var box = { v: self.initialValue(v, mod) };
        mod.vars[v.name.toLowerCase()] = box;
        if (!v.private && mod.kind === 'standard') self.globals[v.name.toLowerCase()] = box;
      });
    });
    Object.keys(this.mods).forEach(function (k) {
      var mod = self.mods[k], f = { module: mod, locals: {}, withs: [], proc: null };
      mod.ast.consts.forEach(function (c) {
        var v;
        try { v = self.sync(self.evalNode(f, c.expr)); } catch (e) { v = undefined; }
        mod.consts[c.name.toLowerCase()] = v;
        if (!c.private && mod.kind === 'standard') self.globalConsts[c.name.toLowerCase()] = v;
      });
    });
    this.udf = {
      has: function (name) { var p = self.procs[name.toLowerCase()]; return !!(p && p.kind === 'function'); },
      call: function (name, vals) {
        var p = self.procs[name.toLowerCase()];
        var args = vals.map(function (v) { return { value: fromEngine(self, v) }; });
        try {
          self.steps = 0; self.stepLimit = 200000;
          var out = self.sync(self.callProc(p, args, null, true));
          out = dflt(out);
          if (out instanceof VDate) return out.__date;
          if (out instanceof VArr) return out.data[0] == null ? 0 : toCell(out.data[0]);
          return out === undefined ? 0 : out;
        } catch (e) { return SE.ERR.value; }
      }
    };
  }
  V.Machine = Machine;
  var M = Machine.prototype;

  M.initialValue = function (v, mod) {
    var self = this;
    if (v.dims) {
      if (!v.dims.length) return new VArr([[0, -1]], []);
      var dims = v.dims.map(function (d) { var f = { module: mod, locals: {}, withs: [] }; return [d[0] ? num(self.sync(self.evalNode(f, d[0]))) : mod.base || 0, num(self.sync(self.evalNode(f, d[1])))]; });
      return new VArr(dims);
    }
    if (v.isNew) return this.newObject(v.type);
    var t = (v.type || '').toLowerCase();
    if (/^(long|integer|double|single|currency|byte|longlong|decimal|longptr)$/.test(t)) return 0;
    if (t === 'string') return '';
    if (t === 'boolean') return false;
    if (t === 'date') return new VDate(0);
    if (t && t !== 'variant') return NOTHING;
    return undefined;
  };
  M.newObject = function (cls) {
    var c = String(cls).toLowerCase().replace(/^vba\./, '');
    if (c === 'collection') return new CollH0();
    if (c === 'dictionary' || c === 'scripting.dictionary') return new DictH0();
    throw err(429, 'New ' + cls + ' isn\'t supported (class modules and other libraries don\'t run in the app)');
  };

  /* Drive a generator: waits for the Promises that host calls (MsgBox, InputBox) yield. */
  M.drive = function (gen) {
    return new Promise(function (resolve, reject) {
      function step(input, isErr) {
        var r;
        try { r = isErr ? gen.throw(input) : gen.next(input); } catch (e) { reject(e); return; }
        if (r.done) { resolve(r.value); return; }
        Promise.resolve(r.value).then(function (v) { step(v, false); }, function (e) { step(e, true); });
      }
      step(undefined, false);
    });
  };
  M.sync = function (gen) {
    var r = gen.next();
    if (!r.done) throw err(5, 'A formula can\'t show a message or ask a question');
    return r.value;
  };

  M.log = function (t) { this.logs.push(t); if (this.host.log) this.host.log(t); };
  M.push = function (ops) { if (ops && ops.length) this.ops.push.apply(this.ops, ops); };
  M.write = function (sheet, r, c, v) { this.writeRaw(sheet, r, c, v === undefined ? null : v instanceof VDate ? v : toCell(v)); };
  M.writeRaw = function (sheet, r, c, v, fmt) {
    if (v instanceof VDate) {
      var cur = this.wb.fmtAt(sheet, r, c);
      if (!cur || !SE.isDateFmt(cur)) fmt = Math.abs(v.__date % 1) > 1e-9 ? (Math.floor(v.__date) ? 'yyyy-mm-dd h:mm' : 'h:mm AM/PM') : 'yyyy-mm-dd';
      v = v.__date;
    }
    if (SE.isErr(v)) v = v.code;
    var ops = this.wb.setCell(sheet, r, c, v, fmt);
    this.push(ops);
    if (this.changed) this.changed.push({ sheet: sheet, r: r, c: c });
  };
  M.active = function () { return this.activeSheet || (this.host.activeSheet && this.host.activeSheet()) || this.wb.bp.sheets[0].name; };
  M.activate = function (name) { this.activeSheet = name; this.activated = name; };
  M.select = function (rng) { this.activate(rng.sheet); this.sel = { sheet: rng.sheet, r1: rng.r1, c1: rng.c1, r2: rng.r2, c2: rng.c2 }; };
  M.selectionRange = function (single) {
    var s = this.sel || (this.host.selection && this.host.selection()) || { sheet: this.active(), r1: 1, c1: 1, r2: 1, c2: 1 };
    return new RangeH0(this, s.sheet, s.r1, s.c1, single ? s.r1 : s.r2, single ? s.c1 : s.c2);
  };
  M.sheetObj = function (name) { return new SheetH0(this, name); };
  M.workbookObj = function () { return new WorkbookH0(this); };
  M.tableObj = function (t) { return new TableH0(this, t); };
  M.msgbox = function (prompt, buttons, title) {
    if (!this.host.msgbox) { this.log('MsgBox: ' + prompt); return Promise.resolve(buttons % 8 === 4 || buttons % 8 === 3 ? 6 : 1); }
    return Promise.resolve(this.host.msgbox(prompt, buttons, title));
  };
  M.ask = function (prompt, title, d) { if (!this.host.inputbox) return Promise.resolve(d || ''); return Promise.resolve(this.host.inputbox(prompt, title, d)); };
  M.evaluate = function (text, sheet) {
    var r = this.wb.refFromText(text, sheet);
    if (r) return new RangeH0(this, r.sheet, r.r1, r.c1, r.r2, r.c2);
    var v = this.wb.evalAt(text, sheet, 1, 1, 0, 0);
    return fromEngine(this, v);
  };
  /* Range("A1"), Range("A1:B5"), Range("Orders[Qty]"), Range("MyName"), Range(cell1, cell2) */
  M.range = function (sheet, a) {
    var x = a[0], y = a.length > 1 && a[1] !== MISSING ? a[1] : null;
    if (isHost(x) && x.$type === 'Range') {
      if (!y) return x;
      var b = isHost(y) ? y : this.range(x.sheet, [y]);
      return new RangeH0(this, x.sheet, Math.min(x.r1, b.r1), Math.min(x.c1, b.c1), Math.max(x.r2, b.r2), Math.max(x.c2, b.c2));
    }
    var text = str(x).trim();
    if (y) { var p = this.range(sheet, [text]), q = isHost(y) ? y : this.range(sheet, [y]); return new RangeH0(this, p.sheet, Math.min(p.r1, q.r1), Math.min(p.c1, q.c1), Math.max(p.r2, q.r2), Math.max(p.c2, q.c2)); }
    if (text.indexOf(',') >= 0 && !/[\[(]/.test(text)) throw err(1004, 'Ranges with several areas ("' + text + '") aren\'t supported');
    var ar = SE.parseArea(text);
    if (ar) return new RangeH0(this, sheet, ar.r1, ar.c1, ar.r2, ar.c2, /^\$?[A-Za-z]+:\$?[A-Za-z]+$/.test(text) ? 'cols' : /^\$?\d+:\$?\d+$/.test(text) ? 'rows' : 'cells');
    var r = this.wb.refFromText(text, sheet);
    if (!r) throw err(1004, 'Range("' + text + '") doesn\'t point at any cells');
    return new RangeH0(this, r.sheet, r.r1, r.c1, Math.max(r.r2, r.r1), r.c2);
  };
  M.intersect = function (list) {
    if (!list.length) return NOTHING;
    var r = list[0];
    for (var i = 1; i < list.length; i++) {
      var b = list[i];
      if (!isHost(r) || !isHost(b) || r.sheet !== b.sheet) return NOTHING;
      var r1 = Math.max(r.r1, b.r1), c1 = Math.max(r.c1, b.c1), r2 = Math.min(r.r2, b.r2), c2 = Math.min(r.c2, b.c2);
      if (r1 > r2 || c1 > c2) return NOTHING;
      r = new RangeH0(this, r.sheet, r1, c1, r2, c2);
    }
    return r;
  };

  /* Find a procedure by name: in the current module first, then public ones; "Module1.Macro" works too. */
  M.findProc = function (name, mod) {
    var n = String(name).toLowerCase().replace(/^.*!/, '').replace(/['"]/g, '');
    if (n.indexOf('.') >= 0) { var p = n.split('.'); var mm = this.mods[p[0]]; return mm ? mm.procs[p[1]] || null : null; }
    if (mod && mod.procs[n]) return mod.procs[n];
    return this.procs[n] || null;
  };
  /* Public subs anyone can run (no arguments): what becomes buttons in the app. */
  M.macros = function () {
    var out = [], self = this;
    Object.keys(this.mods).forEach(function (k) {
      var mod = self.mods[k];
      mod.ast.procs.forEach(function (p) {
        if (p.kind !== 'sub' || p.params.some(function (x) { return !x.optional; })) return;
        if ((mod.kind === 'standard' && !p.private) || (mod.kind === 'document' && /_click$/i.test(p.name))) out.push(p);
      });
    });
    return out;
  };

  M.lookup = function (f, name, create) {
    if (f.locals[name]) return f.locals[name];
    if (f.module.vars[name]) return f.module.vars[name];
    if (this.globals[name]) return this.globals[name];
    if (create) { var box = { v: undefined }; f.locals[name] = box; return box; }
    return null;
  };
  M.constOf = function (f, name) {
    if (name in f.module.consts) return { v: f.module.consts[name] };
    if (name in this.globalConsts) return { v: this.globalConsts[name] };
    if (name in CONST) return { v: CONST[name] };
    return null;
  };
  M.globalObj = function (f, name, args) {
    var app = new AppH0(this);
    switch (name) {
      case 'application': return app;
      case 'err': return this.errObj;
      case 'debug': return new DebugH0(this);
      case 'me': return f.module.sheet ? this.sheetObj(f.module.sheet) : this.workbookObj();
      case 'range': return this.range(f.module.sheet || this.active(), args || []);
      case 'cells': case 'rows': case 'columns': return new SheetH0(this, f.module.sheet || this.active()).$get(name, args || []);
      case 'activesheet': case 'activeworkbook': case 'thisworkbook': case 'activecell': case 'selection': case 'sheets': case 'worksheets': case 'worksheetfunction': case 'intersect': case 'union':
        return app.$get(name, args || []);
      case 'names': return this.workbookObj().$get('names', args || []);
    }
    // sheet code names (Sheet1.Range...) and the workbook's
    for (var k in this.mods) {
      var mod = this.mods[k];
      if (k === name && mod.kind === 'document') return mod.sheet ? this.sheetObj(mod.sheet) : this.workbookObj();
    }
    var bySheet = this.wb.bp.sheets.filter(function (s) { return s.code && s.code.toLowerCase() === name; })[0];
    if (bySheet) return this.sheetObj(bySheet.name);
    return undefined;
  };

  function* evalArgs(m, f, args, keepObjects) {
    var out = [];
    out.named = null;
    for (var i = 0; i < (args || []).length; i++) {
      var a = args[i];
      var v = a.e.t === 'missing' ? MISSING : yield* m.evalNode(f, a.e);
      if (!keepObjects && v !== MISSING) v = dflt(v);
      if (a.name) { out.named = out.named || {}; out.named[a.name] = v; } else out.push(v);
    }
    return out;
  }
  function* hostResult(m, f, v) {
    if (v && typeof v.then === 'function') v = yield v;
    if (v && v.__run) { var p = m.findProc(v.__run, f.module); if (!p) throw err(1004, 'There is no macro called "' + v.__run + '"'); return yield* m.callProc(p, v.args.map(function (x) { return { value: x }; }), f); }
    return v;
  }

  M.evalNode = function* (f, node) {
    switch (node.t) {
      case 'lit': return node.v;
      case 'date': return new VDate(node.v);
      case 'nothing': return NOTHING;
      case 'missing': return MISSING;
      case 'me': return this.globalObj(f, 'me');
      case 'paren': { var pv = yield* this.evalNode(f, node.a); return pv; }
      case 'bracket': return this.evaluate(node.text, f.module.sheet || this.active());
      case 'new': return this.newObject(node.cls);
      case 'typeof': { var o = yield* this.evalNode(f, node.e); return typeName(o).toLowerCase() === node.type.toLowerCase().replace(/^excel\./, ''); }
      case 'id': return yield* this.evalId(f, node.lname, node);
      case 'member': {
        var obj = node.obj ? yield* this.evalNode(f, node.obj) : f.withs[f.withs.length - 1];
        if (node.obj == null && !f.withs.length) throw err(91, '.' + node.name + ' is used outside a With block');
        return yield* this.member(f, obj, node.name, []);
      }
      case 'call': return yield* this.evalCall(f, node);
      case 'un': {
        var u = yield* this.evalNode(f, node.a);
        u = dflt(u);
        if (node.op === '-') { if (u instanceof VDate) return new VDate(-u.__date); return -num(u); }
        if (typeof u === 'boolean') return !u;
        if (u === null) return null;
        return ~num(u);
      }
      case 'bin': {
        var a = yield* this.evalNode(f, node.a);
        var b = yield* this.evalNode(f, node.b);  // VBA always evaluates both sides of And / Or
        return binop(node.op, a, b, f.module.textCompare);
      }
    }
    throw err(5, 'Can\'t run this expression (' + node.t + ')');
  };
  function binop(op, a, b, textMode) {
    if (op === 'is') { if (a === b) return true; if (isHost(a) && isHost(b) && a.$type === 'Range' && b.$type === 'Range') return a.sheet === b.sheet && a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2; if (isHost(a) && isHost(b) && a.t && b.t) return a.t === b.t; return false; }
    a = dflt(a); b = dflt(b);
    switch (op) {
      case '&': return str(a === null ? '' : a) + str(b === null ? '' : b);
      case '=': return cmp(a, b, textMode) === 0;
      case '<>': return cmp(a, b, textMode) !== 0;
      case '<': return cmp(a, b, textMode) < 0;
      case '>': return cmp(a, b, textMode) > 0;
      case '<=': return cmp(a, b, textMode) <= 0;
      case '>=': return cmp(a, b, textMode) >= 0;
      case 'like': return likeRe(textMode ? str(b).toLowerCase() : str(b)).test(textMode ? str(a).toLowerCase() : str(a));
      case '+':
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        if (a instanceof VDate || b instanceof VDate) return new VDate(num(a) + num(b));
        if (typeof a === 'string' && !isNumeric(a)) throw err(13, 'Type mismatch: "' + a + '" + a number (use & to join text)');
        if (typeof b === 'string' && !isNumeric(b)) throw err(13, 'Type mismatch: a number + "' + b + '" (use & to join text)');
        return num(a) + num(b);
      case '-': if (a instanceof VDate && b instanceof VDate) return a.__date - b.__date; if (a instanceof VDate) return new VDate(a.__date - num(b)); return num(a) - num(b);
      case '*': return num(a) * num(b);
      case '/': { var d = num(b); if (d === 0) throw err(11, 'Division by zero'); return num(a) / d; }
      case '\\': { var d2 = bankers(num(b), 0); if (d2 === 0) throw err(11, 'Division by zero'); return Math.trunc(bankers(num(a), 0) / d2); }
      case 'mod': { var d3 = bankers(num(b), 0); if (d3 === 0) throw err(11, 'Division by zero'); return bankers(num(a), 0) % d3; }
      case '^': return Math.pow(num(a), num(b));
      case 'and': if (typeof a === 'boolean' && typeof b === 'boolean') return a && b; return num(a) & num(b);
      case 'or': if (typeof a === 'boolean' && typeof b === 'boolean') return a || b; return num(a) | num(b);
      case 'xor': if (typeof a === 'boolean' && typeof b === 'boolean') return a !== b; return num(a) ^ num(b);
      case 'eqv': return bool(a) === bool(b);
      case 'imp': return !bool(a) || bool(b);
    }
    throw err(5, 'Unknown operator ' + op);
  }
  V.binop = binop;

  M.evalId = function* (f, name, node) {
    if (f.proc && f.proc.kind === 'function' && name === f.proc.lname && f.locals[name]) return f.locals[name].v;
    var box = this.lookup(f, name, false);
    if (box) { if (box.missing) return MISSING; return box.v; }
    var c = this.constOf(f, name);
    if (c) return c.v;
    if (VB[name]) { var r = VB[name]([], this, f); return yield* hostResult(this, f, r); }
    var g = this.globalObj(f, name, null);
    if (g !== undefined) return g;
    var p = this.findProc(name, f.module);
    if (p) return yield* this.callProc(p, [], f);
    if (f.module.explicit) throw err(0, 'Variable not defined: ' + (node && node.name || name));
    return this.lookup(f, name, true).v;
  };

  M.evalCall = function* (f, node) {
    var tg = node.target;
    if (tg.t === 'id') {
      var name = tg.lname, box = this.lookup(f, name, false);
      if (box && !(f.proc && f.proc.lname === name && f.proc.kind === 'function' && !(box.v instanceof VArr))) {
        var v = box.v;
        var idx = yield* evalArgs(this, f, node.args, false);
        if (v instanceof VArr) return v.get(idx);
        if (isHost(v)) return yield* hostResult(this, f, v.$item ? v.$item(idx) : v.$get('item', idx));
        if (typeof v === 'string' && idx.length === 1) throw err(13, name + ' is text, not an array');
        throw err(13, name + ' is not an array');
      }
      var p = this.findProc(name, f.module);
      if (p) return yield* this.callProc(p, node.args, f);
      if (VB[name]) {
        var args = yield* evalArgs(this, f, node.args, !!KEEP_OBJ[name]);
        return yield* hostResult(this, f, VB[name](args, this, f));
      }
      if (GLOBAL_TYPES[name] || name === 'me') {
        var ga = yield* evalArgs(this, f, node.args, true);
        return yield* hostResult(this, f, this.globalObj(f, name, ga));
      }
      var gobj = this.globalObj(f, name, null);
      if (gobj !== undefined) { var ia = yield* evalArgs(this, f, node.args, true); return yield* hostResult(this, f, gobj.$item ? gobj.$item(ia) : gobj.$get('item', ia)); }
      throw err(35, 'Sub or Function not defined: ' + tg.name);
    }
    if (tg.t === 'member') {
      var obj = tg.obj ? yield* this.evalNode(f, tg.obj) : f.withs[f.withs.length - 1];
      if (!tg.obj && !f.withs.length) throw err(91, '.' + tg.name + ' is used outside a With block');
      var margs = yield* evalArgs(this, f, node.args, true);
      return yield* this.member(f, obj, tg.name, margs);
    }
    var o = yield* this.evalNode(f, tg);
    var oa = yield* evalArgs(this, f, node.args, true);
    if (o instanceof VArr) return o.get(oa.map(dflt));
    if (isHost(o)) return yield* hostResult(this, f, o.$item ? o.$item(oa) : o.$get('item', oa));
    throw err(424, 'Object required');
  };

  M.member = function* (f, obj, name, args) {
    if (obj === NOTHING || obj === undefined) throw err(91, 'Object variable not set (".' + name + '" on Nothing)');
    if (!isHost(obj)) {
      if (obj instanceof VArr) throw err(424, 'Object required (an array has no .' + name + ')');
      throw err(424, 'Object required (".' + name + '" on a value: ' + str(obj).slice(0, 30) + ')');
    }
    return yield* hostResult(this, f, obj.$get(name.toLowerCase(), args));
  };

  /* Assign: x = v, Set x = obj, arr(i) = v, Range("A1") = v, obj.Prop = v, dict("k") = v */
  M.assign = function* (f, target, valueNode, isSet) {
    var v = yield* this.evalNode(f, valueNode);
    if (!isSet) v = dflt(v);
    else if (!isObj(v) && v !== undefined) throw err(424, 'Set needs an object (got ' + typeName(v) + ')');
    if (v === MISSING) v = undefined;
    switch (target.t) {
      case 'id': {
        var name = target.lname;
        if (f.proc && (f.proc.kind === 'function' || f.proc.kind === 'property') && name === f.proc.lname) { f.locals[name].v = v; return; }
        var box = this.lookup(f, name, false);
        if (!box) {
          if (this.constOf(f, name)) throw err(0, 'Can\'t assign to the constant ' + target.name);
          var g = this.globalObj(f, name, null);
          if (g && !isSet && g.$let) { g.$let(v); return; }
          if (f.module.explicit) throw err(0, 'Variable not defined: ' + target.name);
          box = this.lookup(f, name, true);
        }
        if (!isSet && isHost(box.v) && box.v.$let && box.v.$type === 'Range') { box.v.$let(v); return; }
        box.v = v;
        return;
      }
      case 'call': {
        var tg = target.target;
        if (tg.t === 'id') {
          var b2 = this.lookup(f, tg.lname, false);
          if (b2 && b2.v instanceof VArr) { var idx = yield* evalArgs(this, f, target.args, false); b2.v.set(idx, v); return; }
          if (b2 && isHost(b2.v)) { var ka = yield* evalArgs(this, f, target.args, true); if (b2.v.$setItem) b2.v.$setItem(ka, v); else b2.v.$set('item', ka, v); return; }
        }
        if (tg.t === 'member') {
          var o = tg.obj ? yield* this.evalNode(f, tg.obj) : f.withs[f.withs.length - 1];
          var ma = yield* evalArgs(this, f, target.args, true);
          var mname = tg.name.toLowerCase(), type = isHost(o) && TYPES[o.$type];
          if (type && type.members[mname] && type.members[mname][2]) { o.$set(mname, ma, v); return; }
          var got = yield* this.member(f, o, tg.name, ma);
          if (isHost(got) && got.$let) { got.$let(v); return; }
          throw err(424, 'Can\'t assign to ' + tg.name + '(...)');
        }
        var ref = yield* this.evalCall(f, target);
        if (isHost(ref) && ref.$let) { ref.$let(v); return; }
        throw err(424, 'Can\'t assign to that');
      }
      case 'member': {
        var obj = target.obj ? yield* this.evalNode(f, target.obj) : f.withs[f.withs.length - 1];
        if (obj === NOTHING || obj === undefined) throw err(91, 'Object variable not set (".' + target.name + '" on Nothing)');
        if (!isHost(obj)) throw err(424, 'Object required (setting .' + target.name + ')');
        var mt = TYPES[obj.$type], mn = target.name.toLowerCase();
        if (mt && mt.members[mn] && !mt.members[mn][2] && mt.members[mn][0] !== 'value') {
          var sub = obj.$get(mn, []);
          if (isHost(sub) && sub.$let) { sub.$let(v); return; }
        }
        obj.$set(mn, [], v);
        return;
      }
      case 'bracket': { var rg = this.evaluate(target.text, f.module.sheet || this.active()); if (isHost(rg)) rg.$let(v); return; }
    }
    throw err(5, 'Can\'t assign to that');
  };

  M.step = function () {
    if (++this.steps > this.stepLimit) throw new Stop('limit');
  };

  /* Run a block. Returns a signal ({exit: 'for'}, {goto: label}...) or undefined. */
  M.block = function* (f, stmts) {
    for (var i = 0; i < stmts.length; i++) {
      var s = stmts[i], sig;
      f.line = s.line;
      try { sig = yield* this.exec(f, s); }
      catch (e) {
        if (e instanceof Stop) throw e;
        var ve = toVbaError(e, f, s);
        if (f.onError === 'next') { this.errObj.number = ve.number || 1004; this.errObj.description = ve.description; continue; }
        throw ve;
      }
      if (sig) return sig;
    }
  };
  function toVbaError(e, f, s) {
    if (e instanceof VbaError) { if (e.line == null) { e.line = s && s.line; e.proc = f.proc && f.proc.name; e.module = f.module && f.module.name; } return e; }
    var ve = err(1004, (e && e.message) || String(e));
    ve.line = s && s.line; ve.proc = f.proc && f.proc.name; ve.module = f.module && f.module.name; ve.jsError = e;
    return ve;
  }

  M.exec = function* (f, s) {
    this.step();
    switch (s.t) {
      case 'noop': case 'label': return;
      case 'unsupported': throw err(5, s.parse ? 'This line couldn\'t be read: ' + s.text : s.text);
      case 'dim': {
        var self = this;
        s.vars.forEach(function (v) { f.locals[v.name.toLowerCase()] = { v: self.initialValue(v, f.module) }; });
        return;
      }
      case 'const': { for (var ci = 0; ci < s.items.length; ci++) f.module.consts[s.items[ci].name.toLowerCase()] = yield* this.evalNode(f, s.items[ci].expr); return; }
      case 'redim': {
        for (var k = 0; k < s.items.length; k++) {
          var it = s.items[k], dims = [];
          for (var d = 0; d < it.dims.length; d++) {
            var lo = it.dims[d][0] ? num(yield* this.evalNode(f, it.dims[d][0])) : f.module.base || 0;
            dims.push([lo, num(yield* this.evalNode(f, it.dims[d][1]))]);
          }
          var box = this.lookup(f, it.name.toLowerCase(), true), na = new VArr(dims);
          if (s.preserve && box.v instanceof VArr) {
            var old = box.v;
            if (old.dims.length === 1) { for (var q = old.dims[0][0]; q <= Math.min(old.dims[0][1], dims[0][1]); q++) na.set([q], old.get([q])); }
            else if (old.dims.length === 2) { for (var r = old.dims[0][0]; r <= Math.min(old.dims[0][1], dims[0][1]); r++) for (var c = old.dims[1][0]; c <= Math.min(old.dims[1][1], dims[1][1]); c++) na.set([r, c], old.get([r, c])); }
          }
          box.v = na;
        }
        return;
      }
      case 'erase': { var me = this; s.names.forEach(function (n) { var b = me.lookup(f, n.toLowerCase(), false); if (b && b.v instanceof VArr) b.v = new VArr(b.v.dims); }); return; }
      case 'assign': yield* this.assign(f, s.target, s.expr, s.set); return;
      case 'callstmt': {
        var tg = s.target;
        if (tg.t === 'id') {
          var p = this.findProc(tg.lname, f.module);
          if (p && !this.lookup(f, tg.lname, false)) { yield* this.callProc(p, s.args, f); return; }
        }
        yield* this.evalCall(f, { t: 'call', target: tg, args: s.args });
        return;
      }
      case 'if': {
        for (var bi = 0; bi < s.branches.length; bi++) {
          var cv = yield* this.evalNode(f, s.branches[bi].cond);
          if (bool(cv)) return yield* this.block(f, s.branches[bi].body);
        }
        if (s.elseBody) return yield* this.block(f, s.elseBody);
        return;
      }
      case 'select': {
        var subj = dflt(yield* this.evalNode(f, s.subject));
        for (var ki = 0; ki < s.cases.length; ki++) {
          var cs = s.cases[ki], hit = false;
          for (var ti = 0; ti < cs.tests.length && !hit; ti++) {
            var t = cs.tests[ti];
            if (t.k === 'eq') hit = cmp(subj, yield* this.evalNode(f, t.e), f.module.textCompare) === 0;
            else if (t.k === 'range') hit = cmp(subj, yield* this.evalNode(f, t.a), f.module.textCompare) >= 0 && cmp(subj, yield* this.evalNode(f, t.b), f.module.textCompare) <= 0;
            else hit = binop(t.op, subj, yield* this.evalNode(f, t.e), f.module.textCompare);
          }
          if (hit) return yield* this.block(f, cs.body);
        }
        if (s.elseBody) return yield* this.block(f, s.elseBody);
        return;
      }
      case 'for': {
        var vbox = this.lookup(f, s.v, true);
        var from = num(yield* this.evalNode(f, s.from)), to = num(yield* this.evalNode(f, s.to)), step = s.step ? num(yield* this.evalNode(f, s.step)) : 1;
        if (step === 0) throw err(5, 'For ... Step 0 never ends');
        vbox.v = from;
        while (step > 0 ? num(vbox.v) <= to : num(vbox.v) >= to) {
          var sig = yield* this.block(f, s.body);
          if (sig) { if (sig.exit === 'for') return; return sig; }
          vbox.v = num(vbox.v) + step;
          this.step();
        }
        return;
      }
      case 'foreach': {
        var coll = yield* this.evalNode(f, s.coll), items;
        if (coll instanceof VArr) items = coll.data.slice();
        else if (isHost(coll) && coll.$iter) items = coll.$iter();
        else if (coll === NOTHING || coll === undefined) throw err(91, 'For Each over Nothing');
        else throw err(451, 'For Each needs a collection, an array or a range');
        var eb = this.lookup(f, s.v, true);
        for (var ii = 0; ii < items.length; ii++) {
          eb.v = items[ii];
          var sg = yield* this.block(f, s.body);
          if (sg) { if (sg.exit === 'for') return; return sg; }
          this.step();
        }
        return;
      }
      case 'do': {
        for (;;) {
          if (s.pre) { var pc = bool(yield* this.evalNode(f, s.pre.e)); if (s.pre.until ? pc : !pc) return; }
          var sd = yield* this.block(f, s.body);
          if (sd) { if (sd.exit === 'do') return; return sd; }
          if (s.post) { var qc = bool(yield* this.evalNode(f, s.post.e)); if (s.post.until ? qc : !qc) return; }
          this.step();
        }
      }
      case 'with': {
        var wo = yield* this.evalNode(f, s.e);
        f.withs.push(wo);
        try { return yield* this.block(f, s.body); } finally { f.withs.pop(); }
      }
      case 'exit': return { exit: s.what };
      case 'end': throw new Stop('end');
      case 'onerror':
        f.onError = s.mode === 'next' ? 'next' : s.mode === 'goto' ? s.label : null;
        if (s.mode !== 'zero') { this.errObj.number = 0; this.errObj.description = ''; }
        return;
      case 'resume': return { resume: s.mode, label: s.label };
      case 'goto': return { goto: s.label };
      case 'raise': { var n = num(yield* this.evalNode(f, s.e)); throw err(n, 'Error ' + n); }
    }
    throw err(5, 'Can\'t run this statement (' + s.t + ')');
  };

  /* Call a procedure. args: parse nodes ({e, name}) from the caller, or ready values ({value}). */
  M.callProc = function* (proc, args, caller, fromFormula) {
    var f = { proc: proc, module: proc.mod, locals: {}, withs: [], onError: null };
    var named = {}, pos = [];
    for (var i = 0; i < (args || []).length; i++) { if (args[i].name) named[args[i].name] = args[i]; else pos.push(args[i]); }
    for (var k = 0; k < proc.params.length; k++) {
      var prm = proc.params[k], a = named[prm.name.toLowerCase()] || pos[k], box;
      if (prm.paramArray) {
        var rest = [];
        for (var j = k; j < pos.length; j++) rest.push(pos[j].value !== undefined || !pos[j].e ? pos[j].value : dflt(yield* this.evalNode(caller, pos[j].e)));
        f.locals[prm.name.toLowerCase()] = { v: arr1(rest) };
        break;
      }
      if (!a || (a.e && a.e.t === 'missing')) {
        if (!prm.optional) throw err(449, proc.name + ' needs a value for ' + prm.name);
        box = prm.dflt ? { v: yield* this.evalNode(f, prm.dflt) } : { v: this.initialValue({ type: prm.type }, f.module), missing: !prm.type || /variant/i.test(prm.type) };
        if (box.missing) box.v = undefined;
      } else if (!a.e) box = { v: a.value };
      else if (!prm.byval && a.e.t === 'id' && caller && (caller.locals[a.e.lname] || caller.module.vars[a.e.lname] || this.globals[a.e.lname])) box = this.lookup(caller, a.e.lname, false);
      else {
        var v = yield* this.evalNode(caller, a.e);
        if (prm.type && !/^(variant|object|range|worksheet|listobject|workbook|collection|dictionary|scripting\.dictionary|listrow|excel\.range)$/i.test(prm.type)) v = coerce(dflt(v), prm.type);
        box = { v: v };
      }
      f.locals[prm.name.toLowerCase()] = box;
    }
    if (proc.kind === 'function' || proc.kind === 'property') f.locals[proc.lname] = { v: this.initialValue({ type: proc.type }, f.module) };
    // run the body with labels (GoTo) and On Error GoTo handlers
    var body = proc.body, labels = {};
    body.forEach(function (s, idx) { if (s.t === 'label') labels[s.name] = idx; });
    var at = 0, failedAt = -1;
    while (at < body.length) {
      var sig;
      try {
        sig = yield* this.block(f, body.slice(at));
        if (!sig) break;
      } catch (e) {
        if (e instanceof Stop) throw e;
        var ve = toVbaError(e, f, body[at]);
        if (f.onError && f.onError !== 'next' && labels[f.onError] != null) {
          this.errObj.number = ve.number || 1004; this.errObj.description = ve.description;
          failedAt = findTop(body, ve.line, at); at = labels[f.onError] + 1; f.onError = null;
          continue;
        }
        throw ve;
      }
      if (sig.exit) break;
      if (sig.goto) { if (labels[sig.goto] == null) throw err(5, 'There is no label "' + sig.goto + '"'); at = labels[sig.goto] + 1; continue; }
      if (sig.resume) {
        this.errObj.number = 0; this.errObj.description = '';
        if (sig.resume === 'label') { at = labels[sig.label] + 1; continue; }
        if (failedAt < 0) break;
        at = sig.resume === 'next' ? failedAt + 1 : failedAt; failedAt = -1;
        continue;
      }
      break;
    }
    void fromFormula;
    return proc.kind === 'sub' ? undefined : f.locals[proc.lname].v;
  };
  function findTop(body, line, from) {
    for (var i = body.length - 1; i >= from; i--) if (body[i].line != null && body[i].line <= line) return i;
    return from;
  }
  function coerce(v, type) {
    switch (String(type).toLowerCase()) {
      case 'long': case 'integer': case 'byte': case 'longlong': case 'longptr': return bankers(num(v), 0);
      case 'double': case 'single': case 'currency': case 'decimal': return num(v);
      case 'string': return str(v);
      case 'boolean': return bool(v);
      case 'date': return new VDate(dateOf(v));
    }
    return v;
  }

  /* Run a macro. Resolves to {ok, error, ops, activate, logs} and never rejects. */
  M.run = function (name, opts) {
    opts = opts || {};
    var self = this, proc = typeof name === 'string' ? this.findProc(name) : name;
    this.ops = []; this.steps = 0; this.stepLimit = opts.limit || LIMIT; this.activeSheet = opts.sheet || null; this.activated = null; this.sel = null;
    this.logs = []; this.caller = opts.caller || ''; this.errObj.number = 0; this.errObj.description = '';
    if (!proc) return Promise.resolve({ ok: false, error: 'There is no macro called "' + name + '".', ops: [], logs: [] });
    var args = (opts.args || []).map(function (v) { return { value: v }; });
    return this.drive(this.callProc(proc, args, null)).then(function (v) {
      return { ok: true, value: v, ops: self.ops, activate: self.activated, logs: self.logs };
    }, function (e) {
      if (e instanceof Stop) return { ok: e.kind === 'end', error: e.kind === 'limit' ? 'The macro ran for too long (over ' + self.stepLimit.toLocaleString() + ' steps), so it was stopped. Is there a loop that never ends?' : null, ops: self.ops, activate: self.activated, logs: self.logs };
      var ve = e instanceof VbaError ? e : toVbaError(e, { proc: proc, module: proc.mod }, null);
      if (ve.jsError) console.error(ve.jsError);
      return { ok: false, error: ve.description, number: ve.number, line: ve.line, proc: ve.proc || proc.name, module: ve.module || proc.mod.name, ops: self.ops, activate: self.activated, logs: self.logs };
    });
  };

  /* Events: Worksheet_Change(Target) after someone edits a sheet, Worksheet_Activate, Workbook_Open, Workbook_SheetChange. */
  M.handler = function (event, sheet) {
    var wanted = event.toLowerCase();
    for (var k in this.mods) {
      var mod = this.mods[k];
      if (mod.kind !== 'document') continue;
      if (wanted.indexOf('workbook_') === 0 ? mod.workbook || mod.lname === (this.wb.bp.workbookCode || 'thisworkbook').toLowerCase() : mod.sheet === sheet) {
        if (mod.procs[wanted]) return mod.procs[wanted];
      }
    }
    return null;
  };
  M.fire = function (event, sheet, area) {
    if (!this.events) return Promise.resolve(null);
    var p = this.handler(event, sheet);
    if (!p) return Promise.resolve(null);
    var args = [];
    if (/change$/i.test(event) && area) {
      var rng = new RangeH0(this, area.sheet || sheet, area.r1, area.c1, area.r2, area.c2);
      args = event.toLowerCase() === 'workbook_sheetchange' ? [this.sheetObj(sheet), rng] : [rng];
    }
    return this.run(p, { sheet: sheet, args: args }).then(function (r) { r.event = event; r.handler = p.name; return r; });
  };

  /* ------------------------------------------------------------------------------------------ formula shifting */
  V.shiftFormula = function (f, dr, dc) {
    if (!dr && !dc) return f;
    var out = '', i = 0, n = f.length;
    while (i < n) {
      var ch = f[i];
      if (ch === '"') { var j = i + 1; while (j < n && !(f[j] === '"' && f[j + 1] !== '"')) j += f[j] === '"' ? 2 : 1; out += f.slice(i, j + 1); i = j + 1; continue; }
      if (ch === "'") { var k = f.indexOf("'!", i + 1); if (k < 0) k = n - 2; out += f.slice(i, k + 2); i = k + 2; continue; }
      if (ch === '[') { var depth = 0, e = i; for (; e < n; e++) { if (f[e] === '[') depth++; else if (f[e] === ']') { depth--; if (!depth) break; } } out += f.slice(i, e + 1); i = e + 1; continue; }
      var m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(\[.!])/.exec(f.slice(i, i + 16));
      var prev = i > 0 ? f[i - 1] : '';
      if (m && !/[A-Za-z0-9_.]/.test(prev)) {
        var c = SE.colIndex(m[2]), r = +m[4];
        if (!m[1]) c += dc;
        if (!m[3]) r += dr;
        out += c < 1 || r < 1 ? '#REF!' : m[1] + SE.colLetters(c) + m[3] + r;
        i += m[0].length; continue;
      }
      var w = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(f.slice(i, i + 80));
      if (w) { out += w[0]; i += w[0].length; continue; }
      out += ch; i++;
    }
    return out;
  };

  /* ------------------------------------------------------------------------------------------ the checker */
  var EVENTS = { worksheet_change: 'runs after someone changes a cell on this sheet', worksheet_activate: 'runs when this screen is opened',
    workbook_open: 'runs when the app opens', workbook_sheetchange: 'runs after any cell changes' };
  var DEAD_EVENTS = { worksheet_selectionchange: 'Selecting cells', worksheet_beforedoubleclick: 'Double-clicking cells', worksheet_beforerightclick: 'Right-clicking',
    worksheet_calculate: 'Recalculation', workbook_beforeclose: 'Closing the workbook', workbook_beforesave: 'Saving', workbook_aftersave: 'Saving', workbook_sheetactivate: 'Switching sheets',
    workbook_beforeprint: 'Printing', worksheet_deactivate: 'Leaving a sheet', workbook_newsheet: 'Adding sheets', worksheet_followhyperlink: 'Hyperlinks', worksheet_pivottableupdate: 'Pivot tables' };

  var ITEM_TYPE = { Sheets: 'Worksheet', ListObjects: 'ListObject', ListRows: 'ListRow', ListColumns: 'ListColumn', Names: 'Name' };
  V.analyze = function (modules, wb) {
    var procs = [], problems = [], known = {};
    var parsed = (modules || []).map(function (src) {
      var ast = V.parse(src.code || '', src.name);
      ast.procs.forEach(function (p) { if (!p.private && (src.kind || 'standard') === 'standard') known[p.lname] = p; });
      return { src: src, ast: ast };
    });
    var globalsVars = {};
    parsed.forEach(function (x) { if ((x.src.kind || 'standard') === 'standard') x.ast.vars.forEach(function (v) { if (!v.private) globalsVars[v.name.toLowerCase()] = v.type || 'Variant'; }); x.ast.consts.forEach(function (c) { if (!c.private) globalsVars[c.name.toLowerCase()] = 'value'; }); });
    var codenames = {};
    (wb && wb.bp ? wb.bp.sheets : []).forEach(function (s) { if (s.code) codenames[s.code.toLowerCase()] = 'Worksheet'; });
    parsed.forEach(function (x) { if (x.src.kind === 'document') codenames[x.src.name.toLowerCase()] = x.src.sheet ? 'Worksheet' : 'Workbook'; });

    parsed.forEach(function (x) {
      var src = x.src, ast = x.ast, kind = src.kind || 'standard';
      ast.problems.forEach(function (p) { problems.push({ module: src.name, line: p.line, text: p.text }); });
      var modScope = {};
      ast.vars.forEach(function (v) { modScope[v.name.toLowerCase()] = v.dims ? 'Array' : (v.type || 'Variant'); });
      ast.consts.forEach(function (c) { modScope[c.name.toLowerCase()] = 'value'; });
      var modProcs = {};
      ast.procs.forEach(function (p) { modProcs[p.lname] = p; });
      ast.procs.forEach(function (p) {
        var issues = [], scope = {}, hard = false;
        p.params.forEach(function (q) { scope[q.name.toLowerCase()] = q.type || 'Variant'; });
        if (p.kind === 'function') scope[p.lname] = p.type || 'Variant';
        var add = function (line, text, isHard) { if (!issues.some(function (i) { return i.text === text; })) issues.push({ line: line, text: text }); if (isHard) hard = true; };
        var typeOfId = function (name) {
          if (scope[name]) return scope[name];
          if (modScope[name]) return modScope[name];
          if (globalsVars[name]) return globalsVars[name];
          if (name in CONST) return 'value';
          if (GLOBAL_TYPES[name]) return GLOBAL_TYPES[name];
          if (name === 'me') return src.sheet ? 'Worksheet' : 'Workbook';
          if (codenames[name]) return codenames[name];
          if (VB[name]) return 'value';
          if (modProcs[name] || known[name]) return 'value';
          return null;
        };
        var norm = function (t) { if (!t) return null; t = String(t).replace(/^excel\./i, ''); var key = Object.keys(TYPES).filter(function (k) { return k.toLowerCase() === t.toLowerCase(); })[0]; return key || (/^(scripting\.)?dictionary$/i.test(t) ? 'Dictionary' : null); };
        var expr = function (n, line) {
          if (!n || typeof n !== 'object') return null;
          switch (n.t) {
            case 'id': {
              var t = typeOfId(n.lname);
              if (t === null && ast.explicit) add(line, 'Not declared: ' + n.name);
              return norm(t);
            }
            case 'member': {
              var ot = n.obj ? expr(n.obj, line) : null;
              return memberType(ot, n.name, line);
            }
            case 'call': {
              (n.args || []).forEach(function (a) { expr(a.e, line); });
              var tg = n.target;
              if (tg.t === 'id') {
                var nm = tg.lname;
                if (scope[nm] || modScope[nm] || globalsVars[nm]) return null;
                if (modProcs[nm] || known[nm]) return null;
                if (nm === 'createobject') {
                  var a0n = n.args[0] && n.args[0].e;
                  if (a0n && a0n.t === 'lit' && !/^scripting\.dictionary$/i.test(String(a0n.v))) add(line, 'CreateObject("' + a0n.v + '") (another program) can\'t run in a web app', true);
                  return a0n && a0n.t === 'lit' && /dictionary/i.test(String(a0n.v)) ? 'Dictionary' : null;
                }
                if (/^(shell|dir|freefile|getobject)$/.test(nm)) { add(line, tg.name + ' works with this computer\'s files or programs, which a web app can\'t do', true); return null; }
                if (VB[nm]) return null;
                if (GLOBAL_TYPES[nm]) return n.args.length && ITEM_TYPE[GLOBAL_TYPES[nm]] ? ITEM_TYPE[GLOBAL_TYPES[nm]] : GLOBAL_TYPES[nm];
                if (codenames[nm]) return null;
                add(line, 'Unknown Sub or Function: ' + tg.name + ' (from an add-in or another workbook?)', true);
                return null;
              }
              if (tg.t === 'member') { var ot2 = tg.obj ? expr(tg.obj, line) : null; var mt2 = memberType(ot2, tg.name, line); return n.args.length && ITEM_TYPE[mt2] ? ITEM_TYPE[mt2] : mt2; }
              expr(tg, line);
              return null;
            }
            case 'bin': expr(n.a, line); expr(n.b, line); return null;
            case 'un': case 'paren': expr(n.a, line); return null;
            case 'typeof': expr(n.e, line); return null;
            case 'new': if (!/^(vba\.)?collection$|^(scripting\.)?dictionary$/i.test(n.cls)) add(line, 'New ' + n.cls + ': class modules and other libraries don\'t run in the app', true); return norm(n.cls);
          }
          return null;
        };
        var memberType = function (ot, name, line) {
          if (!ot || ot === 'Stub') return ot === 'Stub' ? 'Stub' : null;
          var T = TYPES[ot];
          if (!T) return null;
          var ln = name.toLowerCase();
          if (ot === 'WorksheetFunction') { if (!SE.FN[name.toUpperCase()]) add(line, 'WorksheetFunction.' + name + ' isn\'t available yet'); return null; }
          if (ot === 'Application' && !T.members[ln] && SE.FN[name.toUpperCase()]) return null;
          var mm = T.members[ln];
          if (!mm) {
            if (STUBBABLE[ln]) return 'Stub';
            if (IGNORE_SET[ln]) return null;
            add(line, ot + '.' + name + ' isn\'t supported yet', false);
            return null;
          }
          return mm[0] === 'value' || mm[0] === 'void' ? null : mm[0] === 'stub' ? 'Stub' : mm[0];
        };
        var walk = function (list) {
          (list || []).forEach(function (s) {
            var line = s.line;
            switch (s.t) {
              case 'unsupported': add(line, s.text, !s.parse); if (s.parse) hard = true; break;
              case 'dim': s.vars.forEach(function (v) { scope[v.name.toLowerCase()] = v.dims ? 'Array' : (v.isNew ? v.type : v.type || 'Variant'); if (v.isNew && !/^(vba\.)?collection$|^(scripting\.)?dictionary$/i.test(v.type)) add(line, 'New ' + v.type + ' isn\'t supported', true); }); break;
              case 'const': s.items.forEach(function (c) { scope[c.name.toLowerCase()] = 'value'; expr(c.expr, line); }); break;
              case 'redim': s.items.forEach(function (it) { scope[it.name.toLowerCase()] = 'Array'; }); break;
              case 'assign': {
                if (s.set && s.target.t === 'id') { var vt = expr(s.expr, line); if (vt && !scope[s.target.lname]) scope[s.target.lname] = vt; else if (vt && /^variant|object$/i.test(scope[s.target.lname] || '')) scope[s.target.lname] = vt; }
                else expr(s.expr, line);
                if (s.target.t !== 'id') expr(s.target, line); else if (!typeOfId(s.target.lname)) scope[s.target.lname] = 'Variant';
                break;
              }
              case 'callstmt': expr({ t: 'call', target: s.target, args: s.args }, line); break;
              case 'if': s.branches.forEach(function (b) { expr(b.cond, line); walk(b.body); }); walk(s.elseBody); break;
              case 'select': expr(s.subject, line); s.cases.forEach(function (c) { walk(c.body); }); walk(s.elseBody); break;
              case 'for': if (!typeOfId(s.v)) scope[s.v] = 'value'; expr(s.from, line); expr(s.to, line); walk(s.body); break;
              case 'foreach': {
                var ct = expr(s.coll, line);
                if (!scope[s.v] || /^variant|object$/i.test(scope[s.v])) scope[s.v] = ct === 'Range' ? 'Range' : ct === 'Sheets' ? 'Worksheet' : ct === 'ListObjects' ? 'ListObject' : ct === 'ListRows' ? 'ListRow' : (scope[s.v] || 'Variant');
                walk(s.body); break;
              }
              case 'do': if (s.pre) expr(s.pre.e, line); if (s.post) expr(s.post.e, line); walk(s.body); break;
              case 'with': expr(s.e, line); walk(s.body); break;
            }
          });
        };
        walk(p.body);
        var lname = p.lname, event = null, eventNote = null;
        if (kind === 'document') {
          if (EVENTS[lname]) { event = p.name; eventNote = EVENTS[lname]; }
          else if (DEAD_EVENTS[lname]) { event = p.name; add(p.line, DEAD_EVENTS[lname] + ' doesn\'t happen in the app, so ' + p.name + ' never runs', true); }
        }
        if (kind === 'form') add(p.line, 'UserForm code doesn\'t run yet (forms aren\'t converted)', true);
        if (kind === 'class') add(p.line, 'Class module code doesn\'t run yet', true);
        var clickHandler = kind === 'document' && p.kind === 'sub' && /_click$/i.test(p.name) && !p.params.length;
        if (clickHandler) { event = null; eventNote = 'the click handler of the ' + p.name.replace(/_click$/i, '') + ' button on the sheet'; }
        var button = clickHandler || (kind === 'standard' && p.kind === 'sub' && !p.private && !p.params.some(function (q) { return !q.optional; }));
        procs.push({ module: src.name, moduleKind: kind, sheet: src.sheet || null, name: p.name, kind: p.kind, params: p.params.map(function (q) { return q.name; }),
          line: p.line, endLine: p.endLine, lines: Math.max(1, p.endLine - p.line + 1), event: event, eventNote: eventNote, button: button,
          udf: kind === 'standard' && p.kind === 'function' && !p.private,
          status: hard ? 'no' : issues.length ? 'partial' : 'ok', issues: issues.sort(function (a, b) { return a.line - b.line; }) });
      });
    });
    var ok = procs.filter(function (p) { return p.status === 'ok'; }).length;
    return { procs: procs, problems: problems, score: procs.length ? Math.round(100 * ok / procs.length) : 100, ok: ok, partial: procs.filter(function (p) { return p.status === 'partial'; }).length, no: procs.filter(function (p) { return p.status === 'no'; }).length };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = V;
})(typeof window !== 'undefined' ? window : globalThis);
