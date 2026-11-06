/* ss-builder.js: Sheetsmith's studio engine (window.SS), unchanged from the JavaScript version except where noted.
     SS.analysis(bp)          what will work: macros (SE.vba.analyze), formulas (SE.checkFormula)
     SS.merge(bp, settings)   the app definition the runtime reads (screens, columns, buttons, colour...)
     SS.files(bp, settings)   Promise of [{name, text}] for the download (index.html, server.py, README, start scripts)
     SS.previewHtml(bp, settings, theme)   Promise of the app's HTML running in memory (the Preview tab)
     SS.zip(files)            Promise of a Blob (.zip)
     SS.*View(bp, settings)   plain data for the studio's Python tabs (overview, rules, macros, get the app)
     SS.dropzone(el, onFile)  drag-and-drop / click-to-choose for workbooks (Components/DropZone)
   The runtime files come from _/theme/rt-*.js (their ?v= hashes are in head_html, kept current by tools/assets.py).
   Needs rt-formula.js + rt-vba.js (window.SE) loaded first. Python reaches it through client_code/ss.py. */
(function () {
  'use strict';
  var SS = window.SS = {};
  var RT_NAMES = ['rt-formula.js', 'rt-vba.js', 'rt-app.js', 'rt-app.css', 'rt-server.py.txt', 'rt-readme.txt', 'rt-start.bat.txt', 'rt-start.sh.txt'];
  var rt = null;
  /* Forms version: each runtime file's URL (with its ?v= hash) comes from head_html: the <script> tags of
     rt-formula.js / rt-vba.js and <meta name="ss-asset"> for the others (tools/assets.py keeps the hashes current). */
  function assetUrl(n) {
    var el = document.querySelector('script[src*="/' + n + '"], meta[name="ss-asset"][content*="/' + n + '"]');
    return el ? (el.getAttribute('src') || el.getAttribute('content')) : '_/theme/' + n;
  }
  SS.runtime = function () {
    if (rt) return rt;
    rt = Promise.all(RT_NAMES.map(function (n) {
      return fetch(assetUrl(n)).then(function (r) { if (!r.ok) throw new Error('Couldn\'t load ' + n + ' (' + r.status + ')'); return r.text(); });
    })).then(function (texts) { var o = {}; RT_NAMES.forEach(function (n, i) { o[n] = texts[i]; }); return o; });
    rt.catch(function () { rt = null; });
    return rt;
  };
  /* Forms version: messages go to Python (client_code/ss.py sets SS.host = {toast}). */
  SS.host = null;
  function toast(msg, kind) { if (SS.host && SS.host.toast) SS.host.toast(String(msg), kind || ''); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  SS.clone = clone;
  SS.slug = function (s) { return String(s || 'app').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app'; };

  /* ------------------------------------------------------------------ analysis (cached per blueprint) */
  var cache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  SS.analysis = function (bp) {
    if (cache && cache.has(bp)) return cache.get(bp);
    var wb = new SE.WB(bp), out = { formulas: { total: 0, unknown: {}, broken: [], functions: {} } };
    out.vba = SE.vba.analyze(bp.vba || [], wb);
    var udfs = {};
    out.vba.procs.forEach(function (p) { if (p.udf) udfs[p.name.toUpperCase()] = 1; });
    var check = function (f, where) {
      out.formulas.total++;
      var c = SE.checkFormula(f);
      c.functions.forEach(function (fn) { out.formulas.functions[fn] = (out.formulas.functions[fn] || 0) + 1; });
      if (c.error) { if (out.formulas.broken.length < 30) out.formulas.broken.push({ where: where, f: f, error: c.error }); return; }
      c.unknown.forEach(function (fn) { if (!udfs[fn]) { var u = out.formulas.unknown[fn] = out.formulas.unknown[fn] || { n: 0, where: where }; u.n++; } });
    };
    bp.sheets.forEach(function (s) { Object.keys(s.cells || {}).forEach(function (a) { if (s.cells[a].f) check(s.cells[a].f, s.name + '!' + a); }); });
    (bp.tables || []).forEach(function (t) { t.columns.forEach(function (c) { if (c.calc) check(c.calc, t.name + '[' + c.name + ']'); }); });
    out.formulas.unknownCount = Object.keys(out.formulas.unknown).reduce(function (n, k) { return n + out.formulas.unknown[k].n; }, 0);
    out.formulas.okPct = out.formulas.total ? Math.round(100 * (out.formulas.total - out.formulas.unknownCount - out.formulas.broken.length) / out.formulas.total) : 100;
    out.buttons = out.vba.procs.filter(function (p) { return p.button && p.status !== 'no'; });
    if (cache) cache.set(bp, out);
    return out;
  };

  /* ------------------------------------------------------------------ the app definition */
  SS.screens = function (bp, st) {
    st = st || {};
    var over = st.screens || {};
    var list = bp.app.screens.map(function (sc, i) {
      var o = over[sc.id] || {}, c = clone(sc);
      if (o.label) c.label = o.label;
      if (o.icon) c.icon = o.icon;
      if ('hidden' in o) c.hidden = !!o.hidden;
      c.order = o.order != null ? o.order : i;
      if (c.columns) c.columns = c.columns.map(function (col) {
        var oc = (o.columns || {})[col.name] || {};
        var n = Object.assign({}, col);
        ['label', 'type', 'hidden'].forEach(function (k) { if (k in oc) n[k] = oc[k]; });
        return n;
      });
      if (o.titleCol) c.titleCol = o.titleCol;
      if ('statusCol' in o) c.statusCol = o.statusCol || null;
      return c;
    });
    list.sort(function (a, b) { return a.order - b.order; });
    return list;
  };
  SS.macroName = function (p) { return p.moduleKind === 'document' ? p.module + '.' + p.name : p.name; };
  SS.actions = function (bp, st) {
    st = st || {};
    var over = st.actions || {}, an = SS.analysis(bp), seen = {};
    var acts = (bp.app.actions || []).map(function (a) {
      var o = over[a.macro] || {};
      seen[a.macro.toLowerCase()] = 1;
      return { macro: a.macro, label: o.label || a.label, sheet: a.sheet, hidden: !!o.hidden, fromButton: true };
    });
    an.buttons.forEach(function (p) {
      var name = SS.macroName(p);
      if (seen[name.toLowerCase()] || seen[p.name.toLowerCase()]) return;
      var o = over[name] || {};
      acts.push({ macro: name, label: o.label || p.name.replace(/_click$/i, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), sheet: p.sheet || o.sheet || null, hidden: 'hidden' in o ? !!o.hidden : false });
    });
    return acts;
  };
  SS.merge = function (bp, st) {
    st = st || {};
    var title = st.title || bp.app.title;
    return {
      title: title, subtitle: st.subtitle || '', color: st.color || bp.app.color, appId: SS.slug(title) + '-' + Math.abs(hashStr(JSON.stringify(bp.file || {}) + title)).toString(36),
      screens: SS.screens(bp, st), actions: SS.actions(bp, st).filter(function (a) { return !a.hidden; }),
      events: st.events !== false, macros: st.macros !== false, readOnly: !!st.readOnly
    };
  };
  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  SS.seed = function (bp, st) {
    var state = SE.initialState(bp), keep = (st && st.keep) || {};
    Object.keys(state.tables).forEach(function (name) { if (keep[name] === false) state.tables[name].rows = []; });
    return state;
  };
  function slimBlueprint(bp) {
    var b = {};
    ['version', 'file', 'title', 'themeColor', 'workbookCode', 'styles', 'tables', 'names', 'vba'].forEach(function (k) { if (k in bp) b[k] = bp[k]; });
    b.sheets = bp.sheets.map(function (s) {
      var o = {};
      for (var k in s) if (k !== 'cells') o[k] = s[k];
      o.cells = {};
      return o;
    });
    return b;
  }
  function jsonForScript(x) { var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029); return JSON.stringify(x).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029'); }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // Script tags are built from parts: the page loader cuts this file at its first literal closing script tag.
  var END = '</scr' + 'ipt>', SCRIPT = '<scr' + 'ipt>';
  function safeScript(js) { return js.replace(new RegExp('</scr' + 'ipt', 'gi'), '<\\/scr' + 'ipt'); }

  SS.html = function (bp, st, mode, theme) {
    return SS.runtime().then(function (R) {
      var app = SS.merge(bp, st), seed = SS.seed(bp, st);
      var data = { bp: slimBlueprint(bp), app: app, seed: seed, meta: { built: new Date().toISOString(), version: 1, generator: 'Sheetsmith' } };
      var head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
        '<meta name="theme-color" content="' + escHtml(app.color) + '">\n<meta name="generator" content="Sheetsmith">\n<title>' + escHtml(app.title) + '</title>\n' +
        (mode ? '' : '<link rel="manifest" href="manifest.json">\n<link rel="icon" href="icon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="icon.svg">\n') +
        '<style>\n' + R['rt-app.css'] + '\n</style>\n</head>\n<body>\n<div id="app"></div>\n';
      return head + '<scr' + 'ipt id="ss-data" type="application/json">' + jsonForScript(data) + END + '\n' +
        (mode ? SCRIPT + 'window.SS_MODE = ' + JSON.stringify(mode) + ';' + (theme ? 'window.SS_THEME = ' + JSON.stringify(theme) + ';' : '') + END + '\n' : '') +
        SCRIPT + '\n' + safeScript(R['rt-formula.js']) + '\n' + END + '\n' + SCRIPT + '\n' + safeScript(R['rt-vba.js']) + '\n' + END + '\n' + SCRIPT + '\n' + safeScript(R['rt-app.js']) + '\n' + END + '\n</body>\n</html>\n';
    });
  };
  SS.previewHtml = function (bp, st, theme) { return SS.html(bp, st, 'preview', theme); };

  SS.report = function (bp, st) {
    var an = SS.analysis(bp), app = SS.merge(bp, st), lines = [];
    var kinds = { table: 'list + form', form: 'form', grid: 'sheet view' };
    lines.push('  Screens: ' + app.screens.filter(function (s) { return !s.hidden; }).map(function (s) { return s.label + ' (' + (s.kind === 'form' && !(s.form && s.form.inputs) ? 'results' : kinds[s.kind]) + ')'; }).join(', '));
    var hidden = app.screens.filter(function (s) { return s.hidden; });
    if (hidden.length) lines.push('  Hidden (still used by formulas and dropdowns): ' + hidden.map(function (s) { return s.label; }).join(', '));
    var rules = bp.sheets.reduce(function (n, s) { return n + (s.validations || []).length; }, 0), cfs = bp.sheets.reduce(function (n, s) { return n + (s.condFormats || []).length; }, 0);
    lines.push('  Rules: ' + rules + ' data validation rule' + (rules === 1 ? '' : 's') + ', ' + cfs + ' conditional format' + (cfs === 1 ? '' : 's'));
    var unknown = Object.keys(an.formulas.unknown);
    lines.push('  Formulas: ' + an.formulas.total + (unknown.length ? ' (not supported yet: ' + unknown.join(', ') + ')' : an.formulas.total ? ', all supported' : ''));
    if (an.vba.procs.length) lines.push('  Macros: ' + an.vba.ok + ' of ' + an.vba.procs.length + ' run as they are' + (an.vba.partial ? ', ' + an.vba.partial + ' partly' : '') + (an.vba.no ? ', ' + an.vba.no + ' can\'t run in a browser' : '') +
      (app.actions.length ? '. Buttons: ' + app.actions.map(function (a) { return a.label; }).join(', ') : ''));
    (bp.warnings || []).forEach(function (w) { lines.push('  Note: ' + w); });
    return lines.join('\n');
  };

  /* ------------------------------------------------------------------ the download */
  SS.files = function (bp, st) {
    st = st || {};
    return Promise.all([SS.runtime(), SS.html(bp, st, null)]).then(function (x) {
      var R = x[0], html = x[1], app = SS.merge(bp, st), port = st.port || 8080, pin = st.pin || '';
      var cfg = { title: app.title, port: port, pin: pin, built: new Date().toISOString() };
      var server = R['rt-server.py.txt'].replace('CONFIG = {}  # filled in by Sheetsmith: title, port, pin, built', 'CONFIG = ' + JSON.stringify(cfg) + '  # made by Sheetsmith; --port / --pin override these');
      var fill = function (t) {
        return t.split('{{TITLE}}').join(app.title).split('{{FILE}}').join((bp.file && bp.file.name) || 'a workbook').split('{{DATE}}').join(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))
          .split('{{PORT}}').join(String(port)).split('{{PIN_NOTE}}').join(pin ? '\n                                    (this app already asks for the PIN ' + pin + ')' : '').split('{{REPORT}}').join(SS.report(bp, st));
      };
      var dir = SS.slug(app.title) + '/';
      return [
        { name: dir + 'index.html', text: html },
        { name: dir + 'server.py', text: server },
        { name: dir + 'README.txt', text: fill(R['rt-readme.txt']).replace(/\r?\n/g, '\r\n') },
        { name: dir + 'Start (Windows).bat', text: fill(R['rt-start.bat.txt']).replace(/\r?\n/g, '\r\n') },
        { name: dir + 'start.command', text: fill(R['rt-start.sh.txt']), exec: true },
        { name: dir + 'start.sh', text: fill(R['rt-start.sh.txt']), exec: true }
      ];
    });
  };

  /* ------------------------------------------------------------------ a small ZIP writer (deflate when the browser can) */
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate-raw');
      var out = new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
      return out.then(function (b) { return new Uint8Array(b); }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  SS.zip = function (files) {
    var enc = new TextEncoder(), now = new Date();
    var dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    return Promise.all(files.map(function (f) {
      var data = f.bytes || enc.encode(f.text);
      return deflate(data).then(function (z) {
        var useZ = z && z.length < data.length;
        return { name: enc.encode(f.name), data: data, comp: useZ ? z : data, method: useZ ? 8 : 0, crc: crc32(data), exec: f.exec };
      });
    })).then(function (items) {
      var parts = [], central = [], offset = 0;
      items.forEach(function (it) {
        var h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, it.method, true);
        h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, it.crc, true); h.setUint32(18, it.comp.length, true);
        h.setUint32(22, it.data.length, true); h.setUint16(26, it.name.length, true); h.setUint16(28, 0, true);
        parts.push(new Uint8Array(h.buffer), it.name, it.comp);
        var c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x031E, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, it.method, true);
        c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, it.crc, true); c.setUint32(20, it.comp.length, true); c.setUint32(24, it.data.length, true);
        c.setUint16(28, it.name.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true);
        c.setUint32(38, ((it.exec ? 0o100755 : 0o100644) << 16) >>> 0, true); c.setUint32(42, offset, true);
        central.push(new Uint8Array(c.buffer), it.name);
        offset += 30 + it.name.length + it.comp.length;
      });
      var size = central.reduce(function (n, p) { return n + p.length; }, 0);
      var e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, items.length, true); e.setUint16(10, items.length, true);
      e.setUint32(12, size, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
      return new Blob(parts.concat(central, [new Uint8Array(e.buffer)]), { type: 'application/zip' });
    });
  };
  SS.save = function (name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  /* ------------------------------------------------------------------ bits the pages share */
  SS.ICONS = ['table', 'receipt', 'users', 'box', 'check', 'swap', 'chart', 'calc', 'calendar', 'wallet', 'clock', 'sliders', 'folder', 'pin', 'edit', 'grid'];
  SS.TYPES = [['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['integer', 'Whole number'], ['money', 'Money'], ['percent', 'Percent'], ['date', 'Date'],
    ['datetime', 'Date + time'], ['time', 'Time'], ['bool', 'Yes / no'], ['choice', 'Choice (dropdown)'], ['email', 'Email'], ['phone', 'Phone'], ['url', 'Web link'], ['formula', 'Calculated']];
  SS.COLORS = ['#1D7A4F', '#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#CA8A04', '#0F766E', '#334155'];
  SS.kindLabel = function (sc) { return sc.kind === 'table' ? 'List + form' : sc.kind === 'form' ? (sc.form && sc.form.inputs ? 'Form' : 'Results') : 'Sheet'; };
  /* the drafts: a workbook tried without an account, kept in this tab */
  SS.draft = null;

  /* A drop zone for workbooks: el gets [data-drop] behaviour; onFile(File) is called with a checked file. */
  SS.checkFile = function (f) {
    if (!f) return 'Choose a file first.';
    if (!/\.(xlsx|xlsm|xltx|xltm)$/i.test(f.name)) return /\.xls$/i.test(f.name) ? 'Old .xls files can\'t be read. Open it in Excel and use Save As > Excel Macro-Enabled Workbook (.xlsm).' : 'Sheetsmith reads Excel workbooks: .xlsx or .xlsm files.';
    if (f.size > 12 * 1024 * 1024) return 'That file is bigger than 12 MB. Try a copy with less data in it.';
    return null;
  };
  SS.dropzone = function (el, onFile) {
    var input = el.querySelector('input[type=file]');
    var take = function (f) { var problem = SS.checkFile(f); if (problem) { toast(problem, 'error'); return; } onFile(f); };
    el.addEventListener('click', function (e) { if (!e.target.closest('input,a,button[data-noclick]')) input.click(); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { if (input.files[0]) take(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (n) { el.addEventListener(n, function (e) { e.preventDefault(); el.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { el.addEventListener(n, function (e) { e.preventDefault(); el.classList.remove('over'); }); });
    el.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) take(f); });
  };
  /* Example colours + blurbs (Items/ProjectCard asks for them). */
  SS.EXAMPLE_COLORS = { bakery: '#B45309', tools: '#0F766E', quote: '#334155' };
  SS.EXAMPLE_BLURB = { bakery: 'Orders, a menu with prices, a live summary, an archive and three macros.', tools: 'Tools, loans with late fees, members, an overdue check.', quote: 'A quote calculator with live totals, tax and a Save macro.' };

  /* Busy overlay while a workbook is read (it can take a few seconds for big ones). Forms version: its own overlay
     (the old one used UI.modal). Returns {close}. */
  SS.reading = function (name) {
    var steps = ['Opening the file', 'Reading sheets and cells', 'Finding tables and rules', 'Unpacking the VBA macros', 'Sketching the screens'];
    var wrap = document.createElement('div');
    wrap.className = 'ui ss-reading-wrap';
    wrap.innerHTML = '<div class="ss-reading" role="status" aria-live="polite"><div class="ss-drop-art big" aria-hidden="true"><span></span><span></span><span></span><span class="on"></span></div><h2></h2><p class="muted" data-step></p></div>';
    wrap.querySelector('h2').textContent = 'Reading ' + name;
    var step = wrap.querySelector('[data-step]');
    step.textContent = steps[0] + '…';
    document.body.appendChild(wrap);
    var i = 0, t = setInterval(function () { i = Math.min(i + 1, steps.length - 1); step.textContent = steps[i] + '…'; }, 700);
    return { close: function () { clearInterval(t); wrap.remove(); } };
  };

  /* ------------------------------------------------------------------ data for the studio's Python tabs */
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  SS.kindLabel = SS.kindLabel || function () { return ''; };

  SS.overviewView = function (bp, st) {
    var s = bp.stats || {}, an = SS.analysis(bp), scs = SS.screens(bp, st);
    var vis = scs.filter(function (x) { return !x.hidden; });
    var notes = [];
    Object.keys(an.formulas.unknown).forEach(function (fn) { var u = an.formulas.unknown[fn]; notes.push({ kind: 'warn', lead: fn, text: ' isn\'t supported yet (' + plural(u.n, 'formula') + ', e.g. ' + u.where + '). Those cells show #NAME? in the app.' }); });
    an.formulas.broken.slice(0, 3).forEach(function (x) { notes.push({ kind: 'warn', lead: '', text: 'A formula in ' + x.where + ' couldn\'t be read: ' + x.error }); });
    an.vba.procs.filter(function (p) { return p.status === 'no'; }).slice(0, 6).forEach(function (p) { notes.push({ kind: 'warn', lead: p.name, text: ' can\'t run in the app: ' + ((p.issues[0] || {}).text || '') }); });
    (bp.warnings || []).forEach(function (w) { notes.push({ kind: 'info', lead: '', text: w }); });
    if (!notes.length) notes.push({ kind: 'good', lead: '', text: 'Everything Sheetsmith found can come across. Have a look in Preview.' });
    var macroNote = an.vba.procs.length ? an.vba.ok + ' of ' + an.vba.procs.length + ' run as they are' : 'no macros';
    var stats = [
      { n: s.sheets || bp.sheets.length, label: 'sheets', note: plural(vis.length, 'screen') + ' in the app', kind: '' },
      { n: (s.tables || 0) + (s.lists || 0), label: 'tables & lists', note: plural(s.rows || 0, 'row') + ' of data', kind: '' },
      { n: an.formulas.total, label: 'formulas', note: an.formulas.total ? an.formulas.okPct + '% supported' : 'none', kind: an.formulas.okPct === 100 ? 'good' : 'warn' },
      { n: (s.rules || 0) + (s.formats || 0), label: 'rules & colours', note: (s.rules || 0) + ' checks, ' + (s.formats || 0) + ' colour rules', kind: '' },
      { n: an.vba.procs.length, label: 'macros', note: macroNote, kind: an.vba.procs.length && an.vba.score === 100 ? 'good' : an.vba.procs.length ? 'warn' : '' }
    ];
    var screens = scs.map(function (sc) {
      var extra = sc.kind === 'table' ? plural((sc.columns || []).length, 'column') + ' · ' + plural(sc.rows || 0, 'row') : sc.kind === 'form' ? plural(((sc.form || {}).items || []).filter(function (i) { return i.t === 'field'; }).length, 'field') : 'the sheet as cells';
      return { id: sc.id, label: sc.label, icon: sc.icon, hidden: !!sc.hidden, line: SS.kindLabel(sc) + ' · ' + extra };
    });
    return { stats: stats, screens: screens, notes: notes.slice(0, 12) };
  };

  SS.screensView = function (bp, st) {
    return SS.screens(bp, st).map(function (sc) {
      var o = { id: sc.id, label: sc.label, icon: sc.icon, hidden: !!sc.hidden, kind: sc.kind, kindLabel: SS.kindLabel(sc),
        where: sc.sheet + (sc.table ? ' › ' + sc.table : ''), sheet: sc.sheet, titleCol: sc.titleCol || '', statusCol: sc.statusCol || '', columns: [], fields: [] };
      if (sc.kind === 'table') o.columns = sc.columns.map(function (c) { return { name: c.name, label: c.label || c.name, type: c.type, hidden: !!c.hidden }; });
      else if (sc.kind === 'form') o.fields = ((sc.form && sc.form.items) || []).filter(function (it) { return it.t === 'field'; }).map(function (it) { return { label: it.label, ref: it.ref, input: it.kind === 'input' }; });
      return o;
    });
  };

  var OPS = { equal: '=', notEqual: '≠', greaterThan: '>', lessThan: '<', greaterThanOrEqual: '≥', lessThanOrEqual: '≤', between: 'between', notBetween: 'not between' };
  SS.rulesView = function (bp) {
    var an = SS.analysis(bp), rules = [], formats = [];
    bp.sheets.forEach(function (s) {
      (s.validations || []).forEach(function (v) {
        rules.push({ sheet: s.name, cells: v.sqref.join(' '), rule: SE.describeRule(v), hint: v.prompt || '',
          message: v.error || (v.errorStyle === 'stop' ? 'Excel\'s standard message' : ''),
          badge: v.errorStyle && v.errorStyle !== 'stop' ? (v.errorStyle === 'warning' ? 'Warning only' : 'Information') : '' });
      });
      (s.condFormats || []).forEach(function (cf) {
        cf.rules.forEach(function (r) {
          var sty = r.style || {}, when = r.type === 'expression' ? 'when =' + r.formulas[0] : r.type === 'cellIs' ? 'when the value is ' + (OPS[r.op] || r.op) + ' ' + r.formulas.join(' and ') : r.type === 'colorScale' ? 'colour scale' : r.type === 'dataBar' ? 'data bars' : r.type.replace(/([A-Z])/g, ' $1').toLowerCase() + (r.text ? ' "' + r.text + '"' : '');
          var sw = r.type === 'colorScale' ? { background: 'linear-gradient(90deg,' + (r.colors || []).join(',') + ')', text: '' }
            : r.type === 'dataBar' ? { background: 'linear-gradient(90deg,' + ((r.colors || [])[0] || '#638EC6') + ' 60%,transparent 60%)', text: '' }
            : { background: sty.fill || 'transparent', color: sty.color || '', bold: !!sty.bold, strike: !!sty.strike, text: 'Aa' };
          formats.push({ sheet: s.name, cells: cf.sqref.join(' '), when: when, swatch: sw });
        });
      });
    });
    var udfs = {}; an.vba.procs.forEach(function (p) { if (p.udf) udfs[p.name.toUpperCase()] = 1; });
    var fns = Object.keys(an.formulas.functions).sort(function (a, b) { return an.formulas.functions[b] - an.formulas.functions[a]; }).map(function (fn) {
      var k = SE.FN[fn] ? 'ok' : udfs[fn] ? 'udf' : 'no';
      return { name: fn, n: an.formulas.functions[fn], kind: k, title: k === 'udf' ? 'A VBA Function from the workbook' : k === 'no' ? 'Not supported yet' : 'Supported' };
    });
    return { rules: rules, formats: formats, functions: fns, total: an.formulas.total, engineCount: SE.FUNCTIONS.length,
      broken: an.formulas.broken.map(function (x) { return x.where + ': ' + x.error; }), names: (bp.names || []).map(function (n) { return { name: n.name, ref: n.ref }; }) };
  };

  SS.macrosView = function (bp, st) {
    var an = SS.analysis(bp), acts = SS.actions(bp, st), byMod = {}, actBy = {};
    an.vba.procs.forEach(function (p) { (byMod[p.module] = byMod[p.module] || []).push(p); });
    acts.forEach(function (a) { actBy[a.macro.toLowerCase()] = a; });
    var total = an.vba.procs.length, mods = [];
    (bp.vba || []).forEach(function (m) {
      var procs = byMod[m.name] || [];
      if (!procs.length && !(m.code || '').trim()) return;
      var kind = m.kind === 'standard' ? 'Module' : m.kind === 'document' ? (m.sheet ? 'Sheet: ' + m.sheet : 'Workbook') : m.kind === 'form' ? 'UserForm' : 'Class module';
      mods.push({ name: m.name, kind: kind, lines: plural((m.code || '').split('\n').length, 'line'), procs: procs.map(function (p) {
        var a = actBy[SS.macroName(p).toLowerCase()] || actBy[p.name.toLowerCase()];
        var role = p.event ? 'Event: ' + (p.eventNote || p.event) : a && a.sheet ? 'Button on ' + a.sheet : p.button ? 'Macro anyone can run' : p.udf ? 'Function: works inside cell formulas' : p.kind === 'function' ? 'Function' : 'Helper (called by other code)';
        return { name: p.name, status: p.status, role: role, issues: p.issues.map(function (i) { return 'Line ' + i.line + ': ' + i.text; }),
          action: a && p.status !== 'no' ? { macro: a.macro, label: a.label, hidden: !!a.hidden } : null };
      }) });
    });
    return { total: total, ok: an.vba.ok, partial: an.vba.partial, no: an.vba.no, score: an.vba.score,
      pOk: total ? an.vba.ok / total * 100 : 0, pPart: total ? an.vba.partial / total * 100 : 0, modules: mods, hasVba: !!(bp.vba || []).length };
  };

  /* A module's code with line numbers, VBA colours and the lines that won't run marked (Macros tab, Show code). */
  var KEYWORDS = /\b(Sub|Function|End|If|Then|Else|ElseIf|For|Each|Next|To|Step|Do|Loop|While|Wend|Until|Dim|As|Set|Let|Call|With|Select|Case|Is|Not|And|Or|Xor|Mod|New|Nothing|True|False|Exit|On|Error|Resume|GoTo|Private|Public|Const|Option|Explicit|ByVal|ByRef|Optional|ReDim|Preserve|Long|Integer|String|Double|Boolean|Date|Variant|Object|Range|Worksheet|Workbook|ListObject|ListRow|Me|In|Like|Property|Get|Static|Enum|Type)\b/g;
  function hiLine(line) {
    var code = line, comment = '', inStr = false;
    for (var i = 0; i < line.length; i++) { if (line[i] === '"') inStr = !inStr; if (line[i] === "'" && !inStr) { code = line.slice(0, i); comment = line.slice(i); break; } }
    var out = '', parts = code.split(/("(?:[^"]|"")*")/);
    parts.forEach(function (p, k) {
      if (k % 2) { out += '<span class="s">' + escHtml(p) + '</span>'; return; }
      out += escHtml(p).replace(KEYWORDS, '<span class="k">$1</span>').replace(/\b(\d+(\.\d+)?)\b/g, '<span class="n">$1</span>');
    });
    return out + (comment ? '<span class="c">' + escHtml(comment) + '</span>' : '');
  }
  SS.codeHtml = function (bp, moduleName) {
    var an = SS.analysis(bp), m = (bp.vba || []).filter(function (x) { return x.name === moduleName; })[0];
    if (!m) return '';
    var hl = {}, inProc = {};
    an.vba.procs.filter(function (p) { return p.module === moduleName; }).forEach(function (p) {
      p.issues.forEach(function (i) { hl[i.line] = 1; });
      for (var l = p.line; l <= p.endLine; l++) if (p.status !== 'ok') inProc[l] = 1;
    });
    return (m.code || '').split('\n').map(function (l, k) { return '<div class="' + (hl[k + 1] ? 'hl' : inProc[k + 1] ? 'proc' : '') + '">' + (hiLine(l) || ' ') + '</div>'; }).join('');
  };

  SS.getView = function (bp, st) {
    st = st || {};
    var keep = st.keep || {}, title = st.title || bp.app.title, cur = (st.color || bp.app.color).toUpperCase();
    var tables = (bp.tables || []).map(function (t) {
      var n = SE.initialState({ sheets: bp.sheets.filter(function (s) { return s.name === t.sheet; }), tables: [t] }).tables[t.name];
      return { name: t.name, rows: n ? n.rows.length : 0, keep: keep[t.name] !== false };
    });
    var colors = [bp.app.color.toUpperCase()].concat(SS.COLORS.filter(function (c) { return c !== bp.app.color.toUpperCase(); })).slice(0, 9);
    return { title: title, subtitle: st.subtitle || '', fileName: (bp.file && bp.file.name) || 'your workbook', color: cur,
      colors: colors.map(function (c, i) { return { color: c, on: c === cur, label: i === 0 ? 'The workbook\'s colour' : c }; }),
      tables: tables, macros: st.macros !== false, events: st.events !== false, readOnly: !!st.readOnly, pin: st.pin || '', port: st.port || 8080, slug: SS.slug(title) };
  };

  /* The download: the zip (or just index.html). Resolves to the file name; Python shows the toast. */
  SS.download = function (bp, st, htmlOnly) {
    var name = SS.slug(st.title || bp.app.title);
    if (htmlOnly) return SS.html(bp, st, null).then(function (h) { SS.save(name + '.html', new Blob([h], { type: 'text/html' })); return name + '.html'; });
    return SS.files(bp, st).then(SS.zip).then(function (blob) { SS.save(name + '.zip', blob); return name + '.zip'; });
  };
  /* Preview in a new window. Resolves true, or false when the browser blocked it. */
  SS.openPreview = function (bp, st) {
    return SS.previewHtml(bp, st, null).then(function (h) { return !!window.open(URL.createObjectURL(new Blob([h], { type: 'text/html' })), '_blank'); });
  };
  /* Load the preview into an iframe. Resolves '' or the error message. */
  SS.loadPreview = function (frame, bp, st, theme) {
    return SS.previewHtml(bp, st, theme).then(function (html) { frame.srcdoc = html; return ''; }, function (e) { return String(e && e.message || e); });
  };
  /* Keep a value as a real JS object (Python gets a proxy back, so the blueprint isn't copied on every call). */
  SS.keep = function (x) { return x; };
})();
