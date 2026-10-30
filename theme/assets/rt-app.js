/* The app Sheetsmith builds from a workbook: screens for its tables, forms and sheets, its rules and macros.
   Needs window.SE (runtime/formula.js + runtime/vba.js) and <script id="ss-data"> {bp, app, seed, meta}.
   Modes: 'server' (runtime/server.py: shared by everyone on the network), 'local' (opened as a file: this browser
   only), 'preview' (inside the Sheetsmith studio: in memory). window.SS_MODE forces one. */
(function () {
  'use strict';
  var SE = window.SE;
  var DATA = JSON.parse(document.getElementById('ss-data').textContent);
  var BP = DATA.bp, APP = DATA.app || {}, META = DATA.meta || {};
  var MODE = window.SS_MODE || (location.protocol === 'file:' ? 'local' : 'server');
  var KEY = 'ss.' + (APP.appId || 'app');
  var SCREENS = (APP.screens || []).filter(function (s) { return !s.hidden; });
  var wb, machine, store, current = null, ui = {}, selection = null, people = 0, status = MODE, queueSize = 0;

  /* ------------------------------------------------------------------------------------ helpers */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function store_get(k, d) { try { var v = localStorage.getItem(KEY + '.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function store_set(k, v) { try { localStorage.setItem(KEY + '.' + k, JSON.stringify(v)); } catch (e) {} }
  var ICONS = {
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.7c2.2.6 3.5 2.4 3.5 5.3"/>',
    box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    check: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
    swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
    calc: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 11h2M14 11h2M8 15h2M14 15h2M8 19h2M14 19h2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    pin: '<path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
    down: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>', up: '<path d="m6 15 6-6 6 6"/>', dn: '<path d="m6 9 6 6 6-6"/>', more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>', stop: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>'
  };
  function icon(n, cls) { return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || ICONS.table) + '</svg>'; }
  function toast(msg, kind) {
    var box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg; box.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 7000 : 3200);
  }
  function modal(html, opts) {
    opts = opts || {};
    var w = document.createElement('div');
    w.className = 'modal-wrap';
    w.innerHTML = '<div class="modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + (opts.noClose ? '' : '<button class="btn ghost icon x" data-close aria-label="Close">' + icon('x') + '</button>') + html + '</div>';
    document.body.appendChild(w);
    var done = false;
    function close(v) { if (done) return; done = true; w.remove(); document.removeEventListener('keydown', key); if (opts.onclose) opts.onclose(v); }
    function key(e) { if (e.key === 'Escape' && !opts.noClose) close(); }
    document.addEventListener('keydown', key);
    w.addEventListener('mousedown', function (e) { if (e.target === w && !opts.noClose) close(); });
    w.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) close(); });
    setTimeout(function () { var f = w.querySelector('[autofocus], input:not([type=hidden]):not([readonly]), select, textarea, .btn.primary'); if (f) f.focus(); }, 30);
    return { el: w.querySelector('.modal'), close: close };
  }
  function busy(btn, p) { if (!btn) return p; btn.disabled = true; btn.classList.add('busy'); var d = function () { btn.disabled = false; btn.classList.remove('busy'); }; p.then(d, d); return p; }
  function singular(s) { s = String(s || ''); return /ies$/i.test(s) ? s.slice(0, -3) + 'y' : /sses$/i.test(s) ? s.slice(0, -2) : /s$/i.test(s) && !/ss$/i.test(s) ? s.slice(0, -1) : s; }
  function initials(s) { var p = String(s || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  var TAGS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c'];
  function tagStyle(text, cf) {
    if (cf && (cf.fill || cf.color)) return 'background:' + (cf.fill || 'var(--surface-2)') + ';color:' + (cf.color || 'inherit');
    var c = TAGS[hash(text) % TAGS.length];
    return 'background:color-mix(in srgb,' + c + ' 14%,transparent);color:color-mix(in srgb,' + c + ' 80%,var(--ink))';
  }
  function cfStyle(cf) {
    if (!cf) return '';
    var s = '';
    if (cf.fill) s += 'background:' + cf.fill + ';';
    if (cf.color) s += 'color:' + cf.color + ';';
    if (cf.bold) s += 'font-weight:700;';
    if (cf.strike) s += 'text-decoration:line-through;';
    return s;
  }
  function luminance(hex) { var h = hex.replace('#', ''); var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

  /* ------------------------------------------------------------------------------------ values */
  var DEFAULT_FMT = { date: 'd mmm yyyy', datetime: 'd mmm yyyy h:mm', time: 'h:mm AM/PM', percent: '0%', money: '#,##0.00', number: 'General', integer: '0' };
  function fmtFor(col, cellFmt) { return cellFmt || (col && col.fmt) || (col && DEFAULT_FMT[col.type]) || null; }
  function show(v, fmt, type) {
    if (v == null || v === '') return '';
    if (SE.isErr(v)) return v.code;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (type === 'bool' && typeof v === 'number') return v ? 'Yes' : 'No';
    return SE.formatValue(v, fmt);
  }
  function isNumType(t) { return /^(number|integer|money|percent)$/.test(t); }
  function colSpecs(sc, t) {
    var by = {};
    (sc.columns || []).forEach(function (c) { by[c.name] = c; });
    return t.columns.map(function (c, j) { var s = by[c.name] || { name: c.name, label: c.name, type: c.calc ? 'formula' : 'text' }; return Object.assign({ j: j }, s, { fmt: s.fmt || c.fmt }); });
  }
  function colValidation(t, j) {
    var c = t._c1 + j, sheet = t.sheet;
    if (t._d2 >= t._d1) { var v = wb.validationAt(sheet, t._d1, c); if (v) return v; }
    var s = wb.sheet(sheet);
    for (var i = 0; i < (s.validations || []).length; i++) {
      var rule = s.validations[i];
      for (var q = 0; q < rule.sqref.length; q++) { var a = SE.parseArea(rule.sqref[q]); if (a && c >= a.c1 && c <= a.c2 && a.r1 >= t._r1 && a.r1 <= t._d1 + 1) return { rule: rule, origin: a }; }
    }
    return null;
  }
  function optionsFor(t, j, col, r) {
    var v = colValidation(t, j), c = t._c1 + j;
    if (v && v.rule.type === 'list') return wb.listOptions(v, t.sheet, r || Math.max(t._d1, v.origin.r1), c).map(SE.toStr);
    if (col.type === 'choice') {
      var seen = {}, out = [];
      wb.rows(t).forEach(function (row, i) { var x = wb.value(t.sheet, t._d1 + i, c); if (x != null && x !== '') { var k = SE.toStr(x); if (!seen[k.toLowerCase()]) { seen[k.toLowerCase()] = 1; out.push(k); } } });
      return out.sort();
    }
    return null;
  }

  /* ------------------------------------------------------------------------------------ stores */
  function MemoryStore() {}
  MemoryStore.prototype.load = function () { return Promise.resolve({ state: clone(DATA.seed) }); };
  MemoryStore.prototype.send = function () { return Promise.resolve(); };
  MemoryStore.prototype.reset = function () { return Promise.resolve(clone(DATA.seed)); };

  function LocalStore() { this.timer = null; }
  LocalStore.prototype.load = function () {
    var saved = store_get('state', null);
    if (saved && saved.built === META.built) return Promise.resolve({ state: saved.state });
    return Promise.resolve({ state: clone(DATA.seed) });
  };
  LocalStore.prototype.send = function () {
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { store_set('state', { built: META.built, state: wb.state }); }, 250);
    return Promise.resolve();
  };
  LocalStore.prototype.reset = function () { store_set('state', null); return Promise.resolve(clone(DATA.seed)); };

  function ServerStore() { this.rev = 0; this.queue = []; this.sending = false; this.onRemote = null; }
  ServerStore.prototype.api = function (path, body) {
    var opts = { headers: { 'Content-Type': 'application/json', 'X-Who': encodeURIComponent(store_get('who', '') || '') }, credentials: 'same-origin' };
    if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { var e = new Error('pin'); e.pin = true; throw e; }
      if (!r.ok) throw new Error('Server said ' + r.status);
      return r.json();
    });
  };
  ServerStore.prototype.load = function () {
    var self = this;
    return this.api('api/state').then(function (r) { self.rev = r.rev; people = r.clients || 1; return r; });
  };
  ServerStore.prototype.start = function () {
    var self = this;
    var tick = function () {
      var wait = document.hidden ? 12000 : 2500;
      self.timer = setTimeout(function () { self.poll().then(tick, tick); }, wait);
    };
    tick();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { clearTimeout(self.timer); self.poll().then(tick, tick); } });
  };
  ServerStore.prototype.poll = function () {
    var self = this;
    if (this.queue.length && !this.sending) return this.flush();
    return this.api('api/state?since=' + this.rev).then(function (r) {
      setStatus('server');
      people = r.clients || people;
      if (r.state && r.rev !== self.rev) { self.rev = r.rev; if (self.onRemote) self.onRemote(r.state); }
      updateFoot();
    }, function (e) { if (e.pin) location.reload(); setStatus('off'); });
  };
  ServerStore.prototype.send = function (ops) {
    if (!ops || !ops.length) return Promise.resolve();
    this.queue.push.apply(this.queue, clone(ops));
    queueSize = this.queue.length;
    return this.flush();
  };
  ServerStore.prototype.flush = function () {
    var self = this;
    if (this.sending || !this.queue.length) return Promise.resolve();
    this.sending = true;
    var batch = this.queue.slice();
    return this.api('api/ops', { base: this.rev, ops: batch }).then(function (r) {
      self.queue.splice(0, batch.length); queueSize = self.queue.length;
      self.sending = false;
      setStatus('server');
      var prev = self.rev;
      self.rev = r.rev;
      if (r.state && r.rev !== prev + 1 && self.onRemote) self.onRemote(r.state);
      if (self.queue.length) return self.flush();
    }, function (e) {
      self.sending = false;
      setStatus('off');
      if (e.pin) location.reload();
    });
  };
  ServerStore.prototype.reset = function () { return Promise.reject(new Error('Reset the data on the server computer: python server.py --reset')); };

  function setStatus(s) { if (status !== s) { status = s; updateFoot(); } }

  /* ------------------------------------------------------------------------------------ macros host */
  var host = {
    user: '',
    msgbox: function (prompt, buttons, title) {
      renderScreen();
      return new Promise(function (resolve) {
        var kind = buttons % 8, iconBits = buttons & 0x70;
        var sets = { 0: [['OK', 1]], 1: [['Cancel', 2], ['OK', 1]], 2: [['Abort', 3], ['Retry', 4], ['Ignore', 5]], 3: [['Cancel', 2], ['No', 7], ['Yes', 6]], 4: [['No', 7], ['Yes', 6]], 5: [['Cancel', 2], ['Retry', 4]] }[kind] || [['OK', 1]];
        var ic = iconBits === 16 ? ['stop', 'bad'] : iconBits === 48 ? ['warn', 'warn'] : iconBits === 32 ? ['help', ''] : ['info', ''];
        var answered = false;
        var m = modal('<h2>' + esc(title || APP.title) + '</h2><div class="msg ' + ic[1] + '">' + icon(ic[0]) + '<div>' + esc(prompt) + '</div></div>' +
          '<div class="foot">' + sets.map(function (b, i) { return '<button class="btn' + (i === sets.length - 1 ? ' primary' : '') + '" data-v="' + b[1] + '">' + b[0] + '</button>'; }).join('') + '</div>',
          { noClose: kind !== 1 && kind !== 3 && kind !== 5 && kind !== 0, onclose: function () { if (!answered) resolve(kind === 4 ? 7 : kind === 0 ? 1 : 2); } });
        m.el.addEventListener('click', function (e) { var b = e.target.closest('[data-v]'); if (b) { answered = true; m.close(); resolve(+b.getAttribute('data-v')); } });
      });
    },
    inputbox: function (prompt, title, dflt) {
      renderScreen();
      return new Promise(function (resolve) {
        var answered = false;
        var m = modal('<h2>' + esc(title || APP.title) + '</h2><form data-ib><label class="field"><span>' + esc(prompt) + '</span><input type="text" name="v" value="' + esc(dflt || '') + '" autofocus></label>' +
          '<div class="foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">OK</button></div></form>',
          { onclose: function () { if (!answered) resolve(null); } });
        m.el.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); answered = true; var v = m.el.querySelector('[name=v]').value; m.close(); resolve(v); });
      });
    },
    toast: function (t) { toast(t); },
    log: function (t) { if (window.console) console.log('[macro] ' + t); },
    activeSheet: function () { return current && current.sheet; },
    selection: function () { return selection; }
  };

  function applyResult(res, quiet) {
    if (!res) return Promise.resolve();
    var p = res.ops && res.ops.length ? store.send(res.ops) : Promise.resolve();
    if (res.activate) { var sc = SCREENS.filter(function (s) { return s.sheet === res.activate; })[0]; if (sc && sc !== current) go(sc.id); }
    if (!res.ok && res.error) {
      modal('<h2>The macro stopped</h2><div class="msg bad">' + icon('stop') + '<div><b>' + esc(res.error) + '</b>' +
        (res.proc ? '<p class="muted small">In ' + esc(res.module + '.' + res.proc) + (res.line ? ', line ' + res.line : '') + '. Changes it made before stopping are kept.</p>' : '') + '</div></div>' +
        '<div class="foot"><button class="btn primary" data-close>OK</button></div>');
    } else if (!quiet && res.ok && (!res.ops || !res.ops.length) && !res.shownSomething) { /* nothing to say */ }
    renderScreen();
    return p;
  }
  function runMacro(name, label, btn) {
    var p = machine.run(name, { sheet: current && current.sheet, caller: label || name }).then(function (res) { return applyResult(res); });
    return busy(btn, p);
  }
  /* After someone edits cells: the sheet's Worksheet_Change (once per cell), then Workbook_SheetChange. */
  function fireChange(sheet, cells) {
    if (APP.events === false || !machine) return Promise.resolve();
    var chain = Promise.resolve();
    cells.forEach(function (c) {
      chain = chain.then(function () { return machine.fire('Worksheet_Change', sheet, { sheet: sheet, r1: c.r, c1: c.c, r2: c.r, c2: c.c }); }).then(function (r) { return applyResult(r, true); })
        .then(function () { return machine.fire('Workbook_SheetChange', sheet, { sheet: sheet, r1: c.r, c1: c.c, r2: c.r, c2: c.c }); }).then(function (r) { return applyResult(r, true); });
    });
    return chain;
  }

  /* ------------------------------------------------------------------------------------ frame */
  var root;
  function mark() { return '<span class="mark">' + esc(initials(APP.title)) + '</span>'; }
  function navItems(active) {
    return SCREENS.map(function (s) {
      var n = s.kind === 'table' && wb.tableByName(s.table) ? wb.rows(wb.tableByName(s.table)).length : '';
      return '<a href="#' + encodeURIComponent(s.id) + '" class="' + (s === active ? 'on' : '') + '">' + icon(s.icon) + '<span>' + esc(s.label) + '</span>' + (n !== '' ? '<span class="count">' + n + '</span>' : '') + '</a>';
    }).join('') + (MODE === 'server' ? '<a href="#activity" class="' + (active === 'activity' ? 'on' : '') + '">' + icon('clock') + '<span>Activity</span></a>' : '');
  }
  function statusPill() {
    if (status === 'preview') return '<span class="pill preview"><span class="dot"></span>Preview</span>';
    if (status === 'local') return '<span class="pill"><span class="dot"></span>Saved in this browser</span>';
    if (status === 'off') return '<span class="pill off"><span class="dot"></span>Offline' + (queueSize ? ': ' + queueSize + ' change' + (queueSize > 1 ? 's' : '') + ' waiting' : '') + '</span>';
    return '<span class="pill live" title="Changes show up for everyone on the network"><span class="dot"></span>Live' + (people > 1 ? ' · ' + people + ' here' : '') + '</span>';
  }
  function foot() {
    return statusPill() +
      (allActions().length ? '<button class="linkbtn" data-macros>' + icon('bolt') + 'Macros</button>' : '') +
      '<button class="linkbtn" data-export>' + icon('down') + 'Export</button>' +
      '<button class="linkbtn" data-theme>' + icon('moon') + 'Light / dark</button>' +
      (MODE === 'server' ? '<button class="linkbtn" data-who>' + icon('user') + esc(store_get('who', '') || 'Set your name') + '</button>' : '') +
      '<button class="linkbtn" data-about>' + icon('info') + 'About this app</button>';
  }
  function updateFoot() { var f = root && root.querySelector('.side-foot'); if (f) f.innerHTML = foot(); var p = root && root.querySelector('[data-toppill]'); if (p) p.innerHTML = statusPill(); }
  function frame() {
    var banner = MODE === 'local' ? '<div class="banner">' + icon('info') + '<span>Opened as a file, so changes are saved in this browser only. To share it on your network, run <b>server.py</b> (see README.txt).</span></div>' : '';
    root.innerHTML = banner + '<div class="app"><aside class="side"><div class="brand">' + mark() + '<div><b>' + esc(APP.title) + '</b><span>' + esc(APP.subtitle || 'Made from ' + ((BP.file && BP.file.name) || 'a workbook')) + '</span></div></div>' +
      '<nav class="nav"></nav><div class="side-foot"></div></aside>' +
      '<div class="main"><header class="top"><div class="brand">' + mark() + '<div><b>' + esc(APP.title) + '</b></div></div><span data-toppill></span></header>' +
      '<main class="wrap" data-view></main></div></div><nav class="tabs"></nav>';
    updateFoot();
  }
  function renderNav() {
    root.querySelector('.nav').innerHTML = navItems(current === 'activity' ? 'activity' : current);
    var tabs = SCREENS.slice(0, SCREENS.length > 4 ? 3 : 4);
    root.querySelector('.tabs').innerHTML = tabs.map(function (s) { return '<a href="#' + encodeURIComponent(s.id) + '" class="' + (s === current ? 'on' : '') + '">' + icon(s.icon) + '<span>' + esc(s.label) + '</span></a>'; }).join('') +
      (SCREENS.length > 4 || allActions().length || MODE === 'server' ? '<button data-moremenu>' + icon('more') + '<span>More</span></button>' : '');
  }
  function allActions() {
    var acts = (APP.actions || []).slice(), seen = {};
    acts.forEach(function (a) { seen[a.macro.toLowerCase()] = 1; });
    (APP.extraMacros || []).forEach(function (n) { if (!seen[n.toLowerCase()]) acts.push({ macro: n, label: n.replace(/_/g, ' '), sheet: null }); });
    return acts.filter(function (a) { return !a.hidden; });
  }

  /* ------------------------------------------------------------------------------------ routing */
  function go(id) { location.hash = '#' + encodeURIComponent(id); }
  function route() {
    var h = decodeURIComponent((location.hash || '').slice(1));
    var prev = current;
    if (h === 'activity' && MODE === 'server') current = 'activity';
    else current = SCREENS.filter(function (s) { return s.id === h; })[0] || SCREENS[0] || null;
    if (prev !== current) { selection = null; window.scrollTo(0, 0); }
    renderNav();
    renderScreen();
    if (prev !== current && current && current.sheet && machine) machine.fire('Worksheet_Activate', current.sheet).then(function (r) { if (r) applyResult(r, true); });
  }
  function renderScreen() {
    var view = root.querySelector('[data-view]');
    if (!view) return;
    var keep = view.querySelector('.tablewrap'), sx = keep ? keep.scrollLeft : 0, sy = keep ? keep.scrollTop : 0;
    if (!current) { view.innerHTML = '<div class="empty">' + icon('table') + '<h3>No screens</h3><p>This workbook has nothing to show yet.</p></div>'; return; }
    if (current === 'activity') { activity(view); return; }
    document.title = current.label + ' · ' + APP.title;
    try {
      if (current.kind === 'table') tableScreen(view, current);
      else if (current.kind === 'form') formScreen(view, current);
      else gridScreen(view, current);
    } catch (e) {
      console.error(e);
      view.innerHTML = '<div class="empty">' + icon('warn') + '<h3>This screen couldn\'t be drawn</h3><p>' + esc(e.message) + '</p></div>';
    }
    var tw = view.querySelector('.tablewrap'); if (tw && keep) { tw.scrollLeft = sx; tw.scrollTop = sy; }
    var nav = root.querySelector('.nav'); if (nav && current !== 'activity') nav.innerHTML = navItems(current);
  }
  function macroButtons(sheet) {
    return allActions().filter(function (a) { return a.sheet === sheet; }).map(function (a) {
      return '<button class="btn macro" data-macro="' + esc(a.macro) + '" data-label="' + esc(a.label) + '">' + icon('bolt') + esc(a.label) + '</button>';
    }).join('');
  }
  function head(sc, sub, extra) {
    return '<div class="head"><div class="grow"><h1>' + icon(sc.icon) + esc(sc.label) + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div><div class="actions">' + macroButtons(sc.sheet) + (extra || '') + '</div></div>';
  }

  /* ------------------------------------------------------------------------------------ table screens */
  function tableScreen(view, sc) {
    var t = wb.tableByName(sc.table);
    if (!t) { view.innerHTML = head(sc) + '<div class="empty">' + icon('warn') + '<h3>Table not found</h3></div>'; return; }
    var st = ui[sc.id] = ui[sc.id] || { q: '', status: '', sort: null };
    var cols = colSpecs(sc, t), shown = cols.filter(function (c) { return !c.hidden; });
    var statusCol = cols.filter(function (c) { return c.name === sc.statusCol; })[0];
    var titleCol = cols.filter(function (c) { return c.name === sc.titleCol; })[0] || shown[0];
    var subCol = cols.filter(function (c) { return c.name === sc.subtitleCol; })[0];
    var rows = wb.rows(t).map(function (row, i) {
      var r = t._d1 + i;
      var vals = cols.map(function (c) { var v = wb.value(t.sheet, r, t._c1 + c.j); return { v: v, s: show(v, fmtFor(c, wb.fmtAt(t.sheet, r, t._c1 + c.j)), c.type) }; });
      return { id: row.id, r: r, vals: vals };
    });
    var counts = {};
    if (statusCol) rows.forEach(function (x) { var k = x.vals[statusCol.j].s || '(empty)'; counts[k] = (counts[k] || 0) + 1; });
    var q = st.q.trim().toLowerCase();
    var list = rows.filter(function (x) {
      if (st.status && statusCol && (x.vals[statusCol.j].s || '(empty)') !== st.status) return false;
      if (!q) return true;
      return x.vals.some(function (v) { return v.s.toLowerCase().indexOf(q) >= 0; });
    });
    if (st.sort) {
      var j = st.sort.j, dir = st.sort.dir;
      list.sort(function (a, b) { return SE.compare(a.vals[j].v, b.vals[j].v) * dir; });
    }
    var total = rows.length;
    var addLabel = 'Add ' + singular(sc.label).toLowerCase();
    var html = head(sc, total + ' ' + (total === 1 ? 'row' : 'rows') + (list.length !== total ? ' · showing ' + list.length : ''), (APP.readOnly ? '' : '<button class="btn primary" data-new>' + icon('plus') + esc(addLabel) + '</button>'));
    html += '<div class="toolbar"><label class="search">' + icon('search') + '<input type="search" data-q placeholder="Search ' + esc(sc.label.toLowerCase()) + '" value="' + esc(st.q) + '" aria-label="Search"></label>';
    if (statusCol && Object.keys(counts).length > 1 && Object.keys(counts).length <= 12) {
      html += '<div class="chips"><button class="chip ' + (!st.status ? 'on' : '') + '" data-status="">All<b>' + total + '</b></button>' + Object.keys(counts).map(function (k) {
        return '<button class="chip ' + (st.status === k ? 'on' : '') + '" data-status="' + esc(k) + '">' + esc(k) + '<b>' + counts[k] + '</b></button>';
      }).join('') + '</div>';
    }
    html += '</div>';
    if (!total) {
      html += '<div class="card empty">' + icon(sc.icon) + '<h3>Nothing here yet</h3><p>Add the first ' + esc(singular(sc.label).toLowerCase()) + ' with the button above.</p></div>';
      view.innerHTML = html;
      return;
    }
    // desktop table
    html += '<div class="card tablewrap has-cards"><table class="data"><thead><tr>' + shown.map(function (c) {
      var on = st.sort && st.sort.j === c.j;
      return '<th data-sort="' + c.j + '" class="' + (isNumType(c.type) || (c.type === 'formula' && c.show === 'money') ? 'num' : '') + '">' + esc(c.label || c.name) + (on ? icon(st.sort.dir > 0 ? 'up' : 'dn') : '') + '</th>';
    }).join('') + '</tr></thead><tbody>';
    html += list.map(function (x) {
      return '<tr data-row="' + esc(x.id) + '" class="' + (selection && selection.id === x.id ? 'sel' : '') + '">' + shown.map(function (c) {
        var cell = x.vals[c.j], cf = wb.cfAt(t.sheet, x.r, t._c1 + c.j), num = typeof cell.v === 'number' && c.type !== 'bool';
        var content = esc(cell.s);
        if (c.name === sc.statusCol && cell.s) content = '<span class="tag" style="' + tagStyle(cell.s, cf) + '">' + esc(cell.s) + '</span>';
        else if (cf && cf.bar) content = '<span class="bar"><i style="width:' + Math.round(cf.bar.pos * 100) + '%;background:' + cf.bar.color + '"></i>' + content + '</span>';
        var style = c.name === sc.statusCol ? '' : cfStyle(cf);
        return '<td class="' + (num ? 'num' : '') + (c.type === 'formula' ? ' calc' : '') + '" style="' + style + '" title="' + esc(cell.s) + '">' + content + '</td>';
      }).join('') + '</tr>';
    }).join('');
    html += '</tbody>';
    if (t.totals) {
      html += '<tfoot><tr>' + shown.map(function (c) { var v = wb.value(t.sheet, t._tot, t._c1 + c.j); return '<td class="' + (typeof v === 'number' ? 'num' : '') + '">' + esc(show(v, fmtFor(c, wb.fmtAt(t.sheet, t._tot, t._c1 + c.j)), c.type === 'bool' ? 'number' : c.type)) + '</td>'; }).join('') + '</tr></tfoot>';
    }
    html += '</table></div>';
    // phone cards
    var keyCols = shown.filter(function (c) { return c !== titleCol && c !== subCol && c !== statusCol; }).slice(0, 3);
    html += '<div class="cards">' + list.map(function (x) {
      var cf = wb.cfAt(t.sheet, x.r, t._c1 + (statusCol || titleCol).j), stv = statusCol ? x.vals[statusCol.j].s : '';
      var rowcf = wb.cfAt(t.sheet, x.r, t._c1 + titleCol.j);
      return '<div class="rcard" data-row="' + esc(x.id) + '" style="border-left-color:' + ((rowcf && rowcf.fill) || (cf && cf.fill) || 'var(--line)') + '">' +
        '<h3><span>' + esc(x.vals[titleCol.j].s || '(no ' + (titleCol.label || titleCol.name).toLowerCase() + ')') + '</span>' + (stv ? '<span class="tag" style="' + tagStyle(stv, cf) + '">' + esc(stv) + '</span>' : '') + '</h3>' +
        (subCol && x.vals[subCol.j].s ? '<p>' + esc(x.vals[subCol.j].s) + '</p>' : '') +
        (keyCols.length ? '<dl>' + keyCols.map(function (c) { return '<div><dt>' + esc(c.label || c.name) + '</dt><dd>' + esc(x.vals[c.j].s || '–') + '</dd></div>'; }).join('') + '</dl>' : '') + '</div>';
    }).join('') + '</div>';
    view.innerHTML = html;
  }

  function editorFor(c, value, opts, fmt) {
    var name = 'c' + c.j, req = c.required ? ' required' : '';
    var v = value;
    if (c.type === 'formula') return '<div class="calcval" data-calc="' + c.j + '">' + esc(show(v, fmt, c.show)) + '&nbsp;</div>';
    if (opts) {
      var cur = v == null ? '' : SE.toStr(v), has = opts.some(function (o) { return o === cur; });
      return '<select name="' + name + '"' + req + '><option value="">' + (c.required ? 'Choose…' : '(none)') + '</option>' + (cur && !has ? '<option selected>' + esc(cur) + '</option>' : '') +
        opts.map(function (o) { return '<option' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
    }
    switch (c.type) {
      case 'longtext': return '<textarea name="' + name + '"' + req + '>' + esc(v == null ? '' : SE.toStr(v)) + '</textarea>';
      case 'bool': return '<label class="toggle"><input type="checkbox" name="' + name + '"' + (v === true || v === 1 ? ' checked' : '') + '> Yes</label>';
      case 'date': return '<input type="date" name="' + name + '"' + req + ' value="' + (typeof v === 'number' ? SE.serialToIso(v) : '') + '">';
      case 'datetime': return '<input type="datetime-local" name="' + name + '"' + req + ' value="' + (typeof v === 'number' ? SE.serialToIso(v, true) : '') + '">';
      case 'time': { var tt = typeof v === 'number' ? SE.formatValue(v % 1, 'hh:mm') : ''; return '<input type="time" name="' + name + '"' + req + ' value="' + tt + '">'; }
      case 'money': { var cur2 = SE.currencyOf(fmt || ''); return '<div class="affix">' + (cur2 ? '<b>' + esc(cur2) + '</b>' : '') + '<input type="number" step="any" inputmode="decimal" name="' + name + '"' + req + ' value="' + (typeof v === 'number' ? +v.toFixed(6) : esc(v == null ? '' : v)) + '"' + (cur2 ? '' : ' style="padding-left:11px"') + '></div>'; }
      case 'percent': return '<div class="affix pct"><b>%</b><input type="number" step="any" inputmode="decimal" name="' + name + '"' + req + ' value="' + (typeof v === 'number' ? +(v * 100).toFixed(6) : '') + '"></div>';
      case 'integer': return '<input type="number" step="1" inputmode="numeric" name="' + name + '"' + req + ' value="' + (typeof v === 'number' ? v : esc(v == null ? '' : v)) + '">';
      case 'number': return '<input type="number" step="any" inputmode="decimal" name="' + name + '"' + req + ' value="' + (typeof v === 'number' ? +v.toFixed(9) : esc(v == null ? '' : v)) + '">';
      case 'email': return '<input type="email" name="' + name + '"' + req + ' value="' + esc(v == null ? '' : v) + '">';
      case 'phone': return '<input type="tel" name="' + name + '"' + req + ' value="' + esc(v == null ? '' : v) + '">';
      case 'url': return '<input type="url" name="' + name + '"' + req + ' value="' + esc(v == null ? '' : v) + '">';
    }
    return '<input type="text" name="' + name + '"' + req + ' value="' + esc(v == null ? '' : SE.toStr(v)) + '">';
  }
  function readEditor(form, c) {
    var el = form.querySelector('[name="c' + c.j + '"]');
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    var s = el.value;
    if (s === '') return null;
    switch (c.type) {
      case 'date': return SE.isoToSerial(s);
      case 'datetime': return SE.isoToSerial(s.replace('T', ' '));
      case 'time': { var p = s.split(':'); return ((+p[0]) * 3600 + (+p[1]) * 60) / 86400; }
      case 'percent': return parseFloat(s) / 100;
      case 'money': case 'number': case 'integer': { var n = parseFloat(s); return isNaN(n) ? s : n; }
    }
    if (el.tagName === 'SELECT') { var num = SE.toNum(s); return typeof num === 'number' && /^-?\d+(\.\d+)?$/.test(s) ? num : s; }
    return SE.parseInput(s, c.fmt);
  }
  function nextId(t, c) {
    if (c.type !== 'integer' || !/(#|\bno\.?|number|\bid|code)$/i.test(c.name)) return null;
    var vals = wb.rows(t).map(function (r, i) { return wb.value(t.sheet, t._d1 + i, t._c1 + c.j); }).filter(function (v) { return typeof v === 'number'; });
    if (!vals.length) return 1;
    return Math.max.apply(null, vals) + 1;
  }

  function openRecord(sc, rowId) {
    var t = wb.tableByName(sc.table), cols = colSpecs(sc, t).filter(function (c) { return !c.hidden || c.type === 'formula'; });
    var rows = wb.rows(t), idx = rowId ? rows.findIndex(function (r) { return r.id === rowId; }) : -1;
    if (rowId && idx < 0) { toast('That row was just deleted by someone else.', 'bad'); return; }
    var r = idx >= 0 ? t._d1 + idx : null, isNew = idx < 0;
    var titleCol = cols.filter(function (c) { return c.name === sc.titleCol; })[0] || cols[0];
    if (!isNew) selection = { sheet: t.sheet, r1: r, c1: t._c1, r2: r, c2: t._c2, id: rowId };
    var titleVal = isNew ? '' : show(wb.value(t.sheet, r, t._c1 + titleCol.j), null, titleCol.type);
    var fields = cols.map(function (c) {
      var v = isNew ? nextId(t, c) : wb.value(t.sheet, r, t._c1 + c.j);
      var dv = colValidation(t, c.j);
      var fmt = fmtFor(c, isNew ? null : wb.fmtAt(t.sheet, r, t._c1 + c.j));
      var opts = c.type !== 'formula' ? optionsFor(t, c.j, c, r) : null;
      var req = c.required || (dv && !dv.rule.allowBlank && dv.rule.type !== 'any');
      c.required = !!req;
      var hint = c.hint || (dv && dv.rule.prompt) || (dv && dv.rule.type !== 'list' && dv.rule.type !== 'custom' ? SE.describeRule(dv.rule) : '');
      var wide = c.type === 'longtext' || (c.type === 'text' && c === titleCol);
      return '<label class="field' + (wide ? ' wide' : '') + '" data-f="' + c.j + '"><span>' + esc(c.label || c.name) + (req ? '<em>*</em>' : '') + (c.type === 'formula' ? ' <span class="faint small">calculated</span>' : '') + '</span>' +
        editorFor(c, v, opts, fmt) + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '<div class="err" hidden></div></label>';
    }).join('');
    var m = modal('<h2>' + esc(isNew ? 'New ' + singular(sc.label).toLowerCase() : titleVal || singular(sc.label)) + '</h2><form data-rec novalidate><div class="fields2">' + fields + '</div>' +
      '<div class="foot">' + (!isNew && !APP.readOnly ? '<button type="button" class="btn danger left" data-del>' + icon('trash') + 'Delete</button>' : '') +
      '<button type="button" class="btn" data-close>Cancel</button>' + (APP.readOnly ? '' : '<button class="btn primary">' + (isNew ? 'Add' : 'Save') + '</button>') + '</div></form>', { wide: true, onclose: function () { renderScreen(); } });
    var form = m.el.querySelector('form');
    // live calculated fields
    var calcCols = cols.filter(function (c) { return c.type === 'formula'; });
    var preview = function () {
      if (!calcCols.length) return;
      var snap = clone(wb.state), rr = r;
      try {
        if (isNew) { wb.addRow(t, cols.map(function () { return null; })); rr = t._d1 + wb.rows(t).length - 1; }
        cols.forEach(function (c) { if (c.type === 'formula') return; var v = readEditor(form, c); if (v !== undefined) wb.setCell(t.sheet, rr, t._c1 + c.j, v); });
        calcCols.forEach(function (c) { var el = form.querySelector('[data-calc="' + c.j + '"]'); if (el) el.innerHTML = esc(show(wb.value(t.sheet, rr, t._c1 + c.j), fmtFor(c, wb.fmtAt(t.sheet, rr, t._c1 + c.j)), c.show)) + '&nbsp;'; });
      } catch (e) { console.warn(e); }
      wb.state = snap; wb.index();
    };
    var timer;
    form.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(preview, 120); });
    form.addEventListener('change', function () { clearTimeout(timer); preview(); });
    preview();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      form.querySelectorAll('.err').forEach(function (x) { x.hidden = true; }); form.querySelectorAll('.field.bad').forEach(function (x) { x.classList.remove('bad'); });
      var snap = clone(wb.state), ops = [], rr = r, changed = [];
      if (isNew) { ops.push(wb.addRow(t, cols.map(function () { return null; }))); rr = t._d1 + wb.rows(t).length - 1; }
      cols.forEach(function (c) {
        if (c.type === 'formula') return;
        var v = readEditor(form, c);
        if (v === undefined) return;
        var old = isNew ? null : wb.value(t.sheet, rr, t._c1 + c.j);
        if (!isNew && (old === v || (old == null && v == null))) return;
        if (isNew && v == null) return;
        ops = ops.concat(wb.setCell(t.sheet, rr, t._c1 + c.j, v));
        changed.push({ r: rr, c: t._c1 + c.j });
      });
      // check every field against the workbook's rules, now that the row has its new values
      var problems = [], warnings = [];
      cols.forEach(function (c) {
        if (c.type === 'formula') return;
        var v = wb.value(t.sheet, rr, t._c1 + c.j);
        var res = wb.check(t.sheet, rr, t._c1 + c.j, v);
        if (!res.ok) (res.warn ? warnings : problems).push([c, res]);
        else if (c.required && (v == null || v === '')) problems.push([c, { message: 'Please fill this in.' }]);
      });
      var finish = function () {
        var rowNow = wb.rows(t)[rr - t._d1];
        store.send(ops).then(function () { return fireChange(t.sheet, changed); }).then(function () { renderScreen(); });
        m.close();
        if (rowNow) selection = { sheet: t.sheet, r1: rr, c1: t._c1, r2: rr, c2: t._c2, id: rowNow.id };
        toast(isNew ? 'Added' : 'Saved', 'good');
      };
      if (problems.length) {
        wb.state = snap; wb.index();
        problems.forEach(function (p) {
          var f = form.querySelector('[data-f="' + p[0].j + '"]');
          if (f) { f.classList.add('bad'); var er = f.querySelector('.err'); er.textContent = p[1].message; er.hidden = false; }
        });
        var first = form.querySelector('.field.bad input, .field.bad select, .field.bad textarea'); if (first) first.focus();
        return;
      }
      if (warnings.length) {
        var keepSnap = clone(wb.state);
        wb.state = snap; wb.index();
        confirmBox(warnings.map(function (w) { return (w[0].label || w[0].name) + ': ' + w[1].message; }).join('\n'), 'Save anyway?').then(function (yes) {
          if (!yes) return;
          wb.state = keepSnap; wb.index(); finish();
        });
        return;
      }
      finish();
    });
    var del = m.el.querySelector('[data-del]');
    if (del) del.addEventListener('click', function () {
      confirmBox('Delete this ' + singular(sc.label).toLowerCase() + '? This can\'t be undone.', 'Delete', true).then(function (yes) {
        if (!yes) return;
        var ops = wb.deleteRow(t, rowId);
        store.send(ops);
        selection = null;
        m.close();
        toast('Deleted');
      });
    });
  }
  function confirmBox(text, ok, danger) {
    return new Promise(function (resolve) {
      var answered = false;
      var m = modal('<h2>' + esc(ok === 'Delete' ? 'Delete?' : 'Are you sure?') + '</h2><div class="msg warn">' + icon('warn') + '<div>' + esc(text) + '</div></div><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-ok>' + esc(ok || 'OK') + '</button></div>',
        { onclose: function () { if (!answered) resolve(false); } });
      m.el.querySelector('[data-ok]').addEventListener('click', function () { answered = true; m.close(); resolve(true); });
    });
  }

  /* ------------------------------------------------------------------------------------ form screens */
  function fieldType(sheet, r, c) {
    var v = wb.validationAt(sheet, r, c), val = wb.value(sheet, r, c), fmt = wb.fmtAt(sheet, r, c);
    if (v) {
      var t = v.rule.type;
      if (t === 'list') return { type: 'text', opts: wb.listOptions(v, sheet, r, c).map(SE.toStr), v: v };
      if (t === 'whole') return { type: 'integer', v: v };
      if (t === 'decimal') return { type: fmt && SE.isPercentFmt(fmt) ? 'percent' : fmt && SE.currencyOf(fmt) ? 'money' : 'number', v: v };
      if (t === 'date') return { type: 'date', v: v };
      if (t === 'time') return { type: 'time', v: v };
    }
    if (typeof val === 'boolean') return { type: 'bool' };
    if (fmt && SE.isDateFmt(fmt)) return { type: SE.isTimeOnlyFmt(fmt) ? 'time' : 'date' };
    if (fmt && SE.isPercentFmt(fmt)) return { type: 'percent' };
    if (fmt && SE.currencyOf(fmt)) return { type: 'money' };
    if (typeof val === 'number') return { type: 'number' };
    return { type: typeof val === 'string' && val.length > 60 ? 'longtext' : 'text', v: v };
  }
  function formScreen(view, sc) {
    var s = sc.sheet, items = (sc.form && sc.form.items) || [];
    var inputs = items.filter(function (i) { return i.t === 'field' && i.kind === 'input'; }), outputs = items.filter(function (i) { return i.t === 'field' && i.kind === 'output'; });
    var firstOut = items.findIndex(function (i) { return i.kind === 'output'; });
    var lastOut = outputs[outputs.length - 1];
    var render = function (it, k) {
      if (it.t === 'heading') return '<h3>' + esc(it.text) + '</h3>';
      var p = SE.parseA1(it.ref), val = wb.value(s, p.r, p.c), fmt = wb.fmtAt(s, p.r, p.c);
      if (it.kind === 'output') return null;
      var ft = fieldType(s, p.r, p.c), c = { j: k, type: ft.type, name: it.label, fmt: fmt, required: ft.v && !ft.v.rule.allowBlank };
      var hint = ft.v ? (ft.v.rule.prompt || (ft.v.rule.type !== 'list' && ft.v.rule.type !== 'custom' ? SE.describeRule(ft.v.rule) : '')) : '';
      return '<label class="field" data-ref="' + it.ref + '" data-k="' + k + '" data-type="' + ft.type + '"><span>' + esc(it.label) + '</span>' + editorFor(c, val, ft.opts, fmt) +
        (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '<div class="err" hidden></div></label>';
    };
    var outHtml = function (it) {
      var p = SE.parseA1(it.ref), val = wb.value(s, p.r, p.c), fmt = wb.fmtAt(s, p.r, p.c), cf = wb.cfAt(s, p.r, p.c);
      return '<div class="result' + (it === lastOut && /total|net|grand|balance|result|amount due|price/i.test(it.label) ? ' big' : '') + '" style="' + cfStyle(cf) + '"><span>' + esc(it.label) + '</span><b data-out="' + it.ref + '">' + esc(show(val, fmt)) + '</b></div>';
    };
    var html = head(sc, sc.form && sc.form.title && sc.form.title !== sc.label ? esc(sc.form.title) : '');
    if (!inputs.length) {
      html += '<div class="kpis">' + items.map(function (it) {
        if (it.t === 'heading') return '<div class="kpi-h">' + esc(it.text) + '</div>';
        var p = SE.parseA1(it.ref), val = wb.value(s, p.r, p.c), fmt = wb.fmtAt(s, p.r, p.c), cf = wb.cfAt(s, p.r, p.c);
        return '<div class="card kpi" style="' + cfStyle(cf) + '"><span>' + esc(it.label) + '</span><b data-out="' + it.ref + '">' + esc(show(val, fmt)) + '</b></div>';
      }).join('') + '</div>';
      view.innerHTML = html;
      return;
    }
    var left = items.filter(function (it, k) { return it.kind === 'input' || (it.t === 'heading' && (firstOut < 0 || k < firstOut)); });
    var right = items.filter(function (it, k) { return it.kind === 'output' || (it.t === 'heading' && firstOut >= 0 && k > firstOut); });
    html += '<div class="form-grid' + (outputs.length ? '' : ' one') + '"><div class="card fcard"><form data-sheetform novalidate>' + left.map(function (it) { return render(it, items.indexOf(it)); }).join('') + '</form></div>';
    if (outputs.length) {
      var resHtml = '';
      items.forEach(function (it, k) {
        if (it.kind === 'output') resHtml += outHtml(it);
        else if (it.t === 'heading' && firstOut >= 0 && k > firstOut) resHtml += '<div class="result-h">' + esc(it.text) + '</div>';
      });
      var firstHead = items.filter(function (it, k) { return it.t === 'heading' && k > firstOut; })[0];
      html += '<div class="card results">' + (firstHead ? '' : '<div class="result-h">Results</div>') + resHtml + '</div>';
    }
    html += '</div>';
    view.innerHTML = html;
    var form = view.querySelector('[data-sheetform]');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('change', function (e) {
      var f = e.target.closest('[data-ref]'); if (!f) return;
      var p = SE.parseA1(f.getAttribute('data-ref')), type = f.getAttribute('data-type');
      var v = readEditor(f, { j: +f.getAttribute('data-k'), type: type, fmt: wb.fmtAt(s, p.r, p.c) });
      var res = wb.check(s, p.r, p.c, v), er = f.querySelector('.err');
      f.classList.remove('bad'); er.hidden = true;
      var commit = function () {
        var ops = wb.setCell(s, p.r, p.c, v);
        store.send(ops).then(function () { return fireChange(s, [{ r: p.r, c: p.c }]); }).then(function () { refreshForm(view, sc); });
        refreshForm(view, sc);
      };
      if (!res.ok && !res.warn) { f.classList.add('bad'); er.textContent = res.message; er.hidden = false; return; }
      if (!res.ok) { confirmBox(res.message, 'Use it anyway').then(function (y) { if (y) commit(); }); return; }
      commit();
    });
  }
  function refreshForm(view, sc) {
    if (current !== sc) return;
    view.querySelectorAll('[data-out]').forEach(function (el) { var p = SE.parseA1(el.getAttribute('data-out')); el.textContent = show(wb.value(sc.sheet, p.r, p.c), wb.fmtAt(sc.sheet, p.r, p.c)); });
    view.querySelectorAll('[data-ref]').forEach(function (f) {
      if (f.contains(document.activeElement)) return;
      var p = SE.parseA1(f.getAttribute('data-ref')), v = wb.value(sc.sheet, p.r, p.c), el = f.querySelector('input, select, textarea'), type = f.getAttribute('data-type');
      if (!el) return;
      if (el.type === 'checkbox') el.checked = v === true;
      else if (type === 'date') el.value = typeof v === 'number' ? SE.serialToIso(v) : '';
      else if (type === 'percent') el.value = typeof v === 'number' ? +(v * 100).toFixed(6) : '';
      else el.value = v == null ? '' : SE.toStr(v);
    });
  }

  /* ------------------------------------------------------------------------------------ grid screens */
  function gridScreen(view, sc) {
    var s = wb.sheet(sc.sheet), name = sc.sheet;
    var st = ui[sc.id] = ui[sc.id] || { rows: 150, sel: null };
    var maxR = Math.max(1, Math.min(wb.maxRow(name), st.rows)), maxC = Math.max(1, Math.min(wb.maxCol(name), 40));
    var covered = {}, spans = {};
    (s.merges || []).forEach(function (m) { var a = SE.parseArea(m); if (!a) return; spans[a.r1 + ',' + a.c1] = [a.r2 - a.r1 + 1, a.c2 - a.c1 + 1]; for (var r = a.r1; r <= a.r2; r++) for (var c = a.c1; c <= a.c2; c++) if (r !== a.r1 || c !== a.c1) covered[r + ',' + c] = 1; });
    var widths = s.colWidths || {};
    var html = head(sc, wb.maxRow(name) > maxR ? 'Showing the first ' + maxR + ' rows' : '');
    var sel = st.sel || { r: 1, c: 1 };
    html += '<div class="gridbar"><span class="addr" data-addr>' + SE.addr(sel.r, sel.c) + '</span><span class="fx" data-fx></span></div>';
    html += '<div class="card sheetwrap"><table class="sheet"><thead><tr><th class="rh"></th>';
    for (var c = 1; c <= maxC; c++) { var w = widths[SE.colLetters(c)]; html += '<th style="' + (w === 0 ? 'display:none' : 'min-width:' + Math.round((w || 8.43) * 7 + 5) + 'px') + '">' + SE.colLetters(c) + '</th>'; }
    html += '</tr></thead><tbody>';
    for (var r = 1; r <= maxR; r++) {
      html += '<tr><th class="rh">' + r + '</th>';
      for (var k = 1; k <= maxC; k++) {
        if (covered[r + ',' + k]) continue;
        var cell = wb.cellAt(name, r, k), v = wb.value(name, r, k), fmt = wb.fmtAt(name, r, k), stl = wb.styleOf(cell), cf = wb.cfAt(name, r, k);
        var span = spans[r + ',' + k], css = '';
        if (stl.b) css += 'font-weight:700;'; if (stl.i) css += 'font-style:italic;'; if (stl.color) css += 'color:' + stl.color + ';'; if (stl.fill) css += 'background:' + stl.fill + ';';
        if (stl.al) css += 'text-align:' + stl.al + ';'; if (stl.sz) css += 'font-size:' + Math.min(22, stl.sz * 1.2) + 'px;';
        if (widths[SE.colLetters(k)] === 0) css += 'display:none;';
        css += cfStyle(cf);
        html += '<td data-r="' + r + '" data-c="' + k + '" class="' + (typeof v === 'number' ? 'num' : '') + (cell && cell.f ? ' f' : '') + (stl.wrap ? ' wrap' : '') + (sel.r === r && sel.c === k ? ' sel' : '') + '"' +
          (span ? ' rowspan="' + span[0] + '" colspan="' + span[1] + '"' : '') + ' style="' + css + '">' + esc(show(v, fmt)) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    if (wb.maxRow(name) > maxR) html += '<p><button class="btn sm" data-morerows>Show more rows</button></p>';
    view.innerHTML = html;
    showFx(view, sc);
  }
  function showFx(view, sc) {
    var st = ui[sc.id], sel = st.sel || { r: 1, c: 1 }, cell = wb.cellAt(sc.sheet, sel.r, sel.c);
    view.querySelector('[data-addr]').textContent = SE.addr(sel.r, sel.c);
    view.querySelector('[data-fx]').textContent = cell && cell.f ? '=' + cell.f : show(wb.value(sc.sheet, sel.r, sel.c), wb.fmtAt(sc.sheet, sel.r, sel.c));
  }
  function gridSelect(view, sc, r, c) {
    var st = ui[sc.id];
    st.sel = { r: Math.max(1, r), c: Math.max(1, c) };
    view.querySelectorAll('td.sel').forEach(function (x) { x.classList.remove('sel'); });
    var td = view.querySelector('td[data-r="' + st.sel.r + '"][data-c="' + st.sel.c + '"]');
    if (td) { td.classList.add('sel'); td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    selection = { sheet: sc.sheet, r1: st.sel.r, c1: st.sel.c, r2: st.sel.r, c2: st.sel.c };
    showFx(view, sc);
  }
  function gridEdit(view, sc, start) {
    if (APP.readOnly) return;
    var st = ui[sc.id], sel = st.sel; if (!sel) return;
    var td = view.querySelector('td[data-r="' + sel.r + '"][data-c="' + sel.c + '"]'); if (!td) return;
    var cell = wb.cellAt(sc.sheet, sel.r, sel.c);
    if (cell && cell.virtual) { toast('Table headers and totals come from the table itself.'); return; }
    var cur = cell && cell.f ? '=' + cell.f : (function () { var v = wb.value(sc.sheet, sel.r, sel.c), f = wb.fmtAt(sc.sheet, sel.r, sel.c); return v == null ? '' : typeof v === 'number' && f && SE.isDateFmt(f) ? SE.serialToIso(v) : SE.toStr(v); })();
    td.innerHTML = '<input type="text" value="' + esc(start != null ? start : cur) + '">';
    var inp = td.querySelector('input'); inp.focus(); if (start == null) inp.select();
    var done = false;
    var commit = function (save, move) {
      if (done) return; done = true;
      if (save && inp.value !== cur) {
        var f = wb.fmtAt(sc.sheet, sel.r, sel.c), v = SE.parseInput(inp.value, f);
        var res = wb.check(sc.sheet, sel.r, sel.c, v);
        if (!res.ok && !res.warn) { toast(res.message, 'bad'); renderScreen(); return; }
        var ops = wb.setCell(sc.sheet, sel.r, sel.c, v);
        store.send(ops).then(function () { return fireChange(sc.sheet, [{ r: sel.r, c: sel.c }]); }).then(function () { renderScreen(); });
      }
      renderScreen();
      if (move) gridSelect(root.querySelector('[data-view]'), sc, sel.r + move[0], sel.c + move[1]);
    };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true, [1, 0]); }
      else if (e.key === 'Tab') { e.preventDefault(); commit(true, [0, e.shiftKey ? -1 : 1]); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', function () { commit(true); });
  }

  /* ------------------------------------------------------------------------------------ activity */
  function activity(view) {
    document.title = 'Activity · ' + APP.title;
    view.innerHTML = '<div class="head"><div class="grow"><h1>' + icon('clock') + 'Activity</h1><p>The latest changes, by everyone using this app.</p></div></div><div class="card log"><div class="empty">Loading…</div></div>';
    store.api('api/log?limit=150').then(function (d) {
      var box = view.querySelector('.log');
      if (!d.items.length) { box.innerHTML = '<div class="empty">' + icon('clock') + '<h3>No changes yet</h3></div>'; return; }
      box.innerHTML = d.items.map(function (it) {
        return '<div class="row"><span class="who">' + esc(it.who || 'Someone') + '</span><span>' + esc(it.text) + '</span><span class="when">' + esc(new Date(it.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</span></div>';
      }).join('');
    }, function () { view.querySelector('.log').innerHTML = '<div class="empty">The activity log isn\'t available right now.</div>'; });
  }

  /* ------------------------------------------------------------------------------------ menus */
  function exportMenu() {
    var tables = SCREENS.filter(function (s) { return s.kind === 'table'; });
    var m = modal('<h2>Export</h2><p class="muted">Download the data as it is right now.</p><div class="kpis" style="grid-template-columns:1fr">' +
      (MODE === 'server' ? '<a class="btn primary" href="api/export.xlsx" download>' + icon('down') + 'Excel workbook (.xlsx)</a>' : '') +
      tables.map(function (s) { return '<button class="btn" data-csv="' + esc(s.id) + '">' + icon('table') + esc(s.label) + ' (.csv)</button>'; }).join('') +
      (MODE !== 'server' ? '<button class="btn" data-json>' + icon('copy') + 'Everything (.json backup)</button>' : '') +
      (MODE !== 'server' ? '<button class="btn danger" data-reset>' + icon('trash') + 'Start over with the original data</button>' : '') + '</div>');
    m.el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-csv]');
      if (b) { var sc = SCREENS.filter(function (s) { return s.id === b.getAttribute('data-csv'); })[0]; download(sc.label + '.csv', csvOf(sc), 'text/csv'); }
      if (e.target.closest('[data-json]')) download(APP.title + ' backup.json', JSON.stringify(wb.state), 'application/json');
      if (e.target.closest('[data-reset]')) confirmBox('Throw away every change and go back to the data from the workbook?', 'Start over', true).then(function (y) {
        if (!y) return;
        store.reset().then(function (st) { wb.state = st; wb.index(); m.close(); route(); toast('Back to the original data'); });
      });
    });
  }
  function csvOf(sc) {
    var t = wb.tableByName(sc.table), cols = colSpecs(sc, t);
    var q = function (s) { s = String(s == null ? '' : s); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [cols.map(function (c) { return q(c.label || c.name); }).join(',')];
    wb.rows(t).forEach(function (row, i) {
      lines.push(cols.map(function (c) {
        var v = wb.value(t.sheet, t._d1 + i, t._c1 + c.j);
        if (typeof v === 'number' && /date|time/.test(c.type)) return q(SE.serialToIso(v, c.type !== 'date'));
        return q(SE.isErr(v) ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v);
      }).join(','));
    });
    return '﻿' + lines.join('\r\n');
  }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name.replace(/[\\/:*?"<>|]/g, '-');
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function macrosMenu() {
    var acts = allActions();
    var m = modal('<h2>Macros</h2><p class="muted">The workbook\'s macros, running right here.</p><div class="kpis" style="grid-template-columns:1fr">' + acts.map(function (a) {
      return '<button class="btn macro" data-macro="' + esc(a.macro) + '" data-label="' + esc(a.label) + '">' + icon('bolt') + esc(a.label) + '</button>';
    }).join('') + '</div>');
    m.el.addEventListener('click', function (e) { if (e.target.closest('[data-macro]')) m.close(); });
  }
  function moreMenu() {
    var m = modal('<h2>' + esc(APP.title) + '</h2><nav class="nav">' + navItems(current) + '</nav><div class="side-foot" style="border:0;margin-top:14px">' + foot() + '</div>');
    m.el.addEventListener('click', function (e) { if (e.target.closest('a,button.linkbtn,[data-macro]')) setTimeout(m.close, 0); });
  }
  function askName(force) {
    if (MODE !== 'server') return Promise.resolve();
    if (store_get('who', '') && !force) return Promise.resolve();
    return new Promise(function (resolve) {
      var m = modal('<h2>What\'s your name?</h2><p class="muted">It shows next to your changes in the Activity list, so others know who did what.</p><form><label class="field"><input type="text" name="n" maxlength="40" value="' + esc(store_get('who', '')) + '" autofocus placeholder="e.g. Sam"></label>' +
        '<div class="foot"><button type="button" class="btn ghost" data-close>Skip</button><button class="btn primary">Save</button></div></form>', { onclose: function () { resolve(); } });
      m.el.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); store_set('who', m.el.querySelector('[name=n]').value.trim()); host.user = store_get('who', ''); m.close(); updateFoot(); });
    });
  }
  function about() {
    var info = MODE === 'server' ? store.api('api/info') : Promise.resolve(null);
    info.then(function (d) {
      modal('<h2>' + esc(APP.title) + '</h2><p>Made with Sheetsmith from <b>' + esc((BP.file && BP.file.name) || 'a workbook') + '</b>' + (META.built ? ' on ' + esc(new Date(META.built).toLocaleDateString()) : '') + '.</p>' +
        (d && d.urls && d.urls.length ? '<p class="muted">Open it on any phone or computer on the same network:</p>' + d.urls.map(function (u) { return '<p><a class="btn" href="' + esc(u) + '">' + icon('wifi') + esc(u) + '</a></p>'; }).join('') : '') +
        '<p class="muted small">Data: ' + (MODE === 'server' ? 'kept on the computer running server.py (data/app.db), with daily backups.' : MODE === 'local' ? 'saved in this browser only.' : 'this is a preview: nothing is saved.') + '</p>' +
        '<div class="foot"><button class="btn primary" data-close>Close</button></div>');
    });
  }

  /* ------------------------------------------------------------------------------------ events */
  function wire() {
    document.addEventListener('click', function (e) {
      var el = e.target;
      var mac = el.closest('[data-macro]');
      if (mac) { e.preventDefault(); runMacro(mac.getAttribute('data-macro'), mac.getAttribute('data-label'), mac); return; }
      if (el.closest('[data-new]') && current && current.kind === 'table') { openRecord(current, null); return; }
      var row = el.closest('[data-row]');
      if (row && current && current.kind === 'table' && !el.closest('.modal')) { openRecord(current, row.getAttribute('data-row')); return; }
      var srt = el.closest('[data-sort]');
      if (srt && current) { var st = ui[current.id], j = +srt.getAttribute('data-sort'); st.sort = st.sort && st.sort.j === j ? (st.sort.dir > 0 ? { j: j, dir: -1 } : null) : { j: j, dir: 1 }; renderScreen(); return; }
      var chip = el.closest('[data-status]');
      if (chip && current) { ui[current.id].status = chip.getAttribute('data-status'); renderScreen(); return; }
      if (el.closest('[data-export]')) { exportMenu(); return; }
      if (el.closest('[data-macros]')) { macrosMenu(); return; }
      if (el.closest('[data-moremenu]')) { moreMenu(); return; }
      if (el.closest('[data-who]')) { askName(true); return; }
      if (el.closest('[data-about]')) { about(); return; }
      if (el.closest('[data-theme]')) {
        var t = document.documentElement.getAttribute('data-theme'), dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark'); store_set('theme', dark ? 'light' : 'dark'); return;
      }
      if (el.closest('[data-morerows]') && current) { ui[current.id].rows += 300; renderScreen(); return; }
      var td = el.closest('table.sheet td[data-r]');
      if (td && current && current.kind === 'grid' && !td.querySelector('input')) gridSelect(root.querySelector('[data-view]'), current, +td.getAttribute('data-r'), +td.getAttribute('data-c'));
    });
    document.addEventListener('dblclick', function (e) { var td = e.target.closest('table.sheet td[data-r]'); if (td && current && current.kind === 'grid') gridEdit(root.querySelector('[data-view]'), current); });
    document.addEventListener('input', function (e) {
      if (e.target.matches('[data-q]') && current) {
        ui[current.id].q = e.target.value;
        var pos = e.target.selectionStart;
        renderScreen();
        var q = root.querySelector('[data-q]'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) {} }
      }
    });
    document.addEventListener('keydown', function (e) {
      if (document.querySelector('.modal-wrap')) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === '/' && root.querySelector('[data-q]')) { e.preventDefault(); root.querySelector('[data-q]').focus(); return; }
      if (current && current.kind === 'table' && e.key === 'n' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openRecord(current, null); return; }
      if (current && current.kind === 'grid') {
        var st = ui[current.id], sel = st.sel || { r: 1, c: 1 }, view = root.querySelector('[data-view]');
        var mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] }[e.key];
        if (mv) { e.preventDefault(); gridSelect(view, current, sel.r + mv[0], sel.c + mv[1]); return; }
        if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); gridEdit(view, current); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); var c0 = wb.cellAt(current.sheet, sel.r, sel.c); if (c0 && !c0.virtual && !APP.readOnly) { store.send(wb.setCell(current.sheet, sel.r, sel.c, null)); renderScreen(); } return; }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); gridEdit(view, current, e.key); }
      }
    });
    window.addEventListener('hashchange', route);
  }

  /* ------------------------------------------------------------------------------------ start */
  function pinScreen(err) {
    root.innerHTML = '<div class="card pinbox"><div class="brand" style="justify-content:center">' + mark() + '</div><h2>' + esc(APP.title) + '</h2><p class="muted">This app is protected with a PIN.</p>' +
      '<form data-pin><input type="password" inputmode="numeric" name="pin" autofocus autocomplete="current-password" aria-label="PIN">' + (err ? '<p class="small" style="color:var(--bad)">' + esc(err) + '</p>' : '') +
      '<button class="btn primary" style="width:100%">Open</button></form></div>';
    root.querySelector('[data-pin]').addEventListener('submit', function (e) {
      e.preventDefault();
      fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: root.querySelector('[name=pin]').value }), credentials: 'same-origin' })
        .then(function (r) { if (r.ok) start(); else pinScreen('That PIN isn\'t right.'); }, function () { pinScreen('Can\'t reach the server.'); });
    });
  }
  function boot(state) {
    wb = new SE.WB(BP, state);
    machine = SE.vba && BP.vba && BP.vba.length && APP.macros !== false ? new SE.vba.Machine(BP.vba, wb, host) : null;
    if (machine) wb.udf = machine.udf;
    host.user = store_get('who', '') || (MODE === 'server' ? '' : 'Me');
    frame();
    wire();
    route();
    if (store.start) store.start();
    if (store instanceof ServerStore) store.onRemote = function (st) {
      wb.state = st; wb.index();
      if (store.queue.length) wb.apply(clone(store.queue));
      if (!document.querySelector('.modal-wrap')) renderScreen(); else renderNav();
    };
    if (machine) machine.fire('Workbook_Open', null).then(function (r) { if (r) applyResult(r, true); });
    askName(false);
    if (window.parent !== window) window.parent.postMessage({ ss: 'ready' }, '*');
  }
  function start() {
    store.load().then(function (r) { if (r.needPin) pinScreen(); else boot(r.state); }, function (e) {
      if (e.pin) { pinScreen(); return; }
      root.innerHTML = '<div class="card pinbox"><h2>Can\'t reach the app\'s server</h2><p class="muted">Is <b>server.py</b> still running on the computer that shares this app? Then reload this page.</p><button class="btn primary" onclick="location.reload()">Reload</button></div>';
    });
  }
  function init() {
    var color = /^#[0-9a-f]{6}$/i.test(APP.color || '') ? APP.color : '#1d7a4f';
    document.documentElement.style.setProperty('--brand', color);
    document.documentElement.style.setProperty('--brand-ink', luminance(color) > 0.62 ? '#14211b' : '#ffffff');
    var th = store_get('theme', null); if (th) document.documentElement.setAttribute('data-theme', th);
    if (window.SS_THEME) document.documentElement.setAttribute('data-theme', window.SS_THEME);
    var meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.setAttribute('content', color);
    root = document.getElementById('app');
    store = MODE === 'server' ? new ServerStore() : MODE === 'local' ? new LocalStore() : new MemoryStore();
    status = MODE === 'preview' ? 'preview' : MODE === 'local' ? 'local' : 'server';
    start();
  }
  window.SS_APP = { get wb() { return wb; }, get machine() { return machine; }, go: go, run: function (n) { return runMacro(n); }, mode: MODE, openRecord: function (id, rowId) { openRecord(SCREENS.filter(function (s) { return s.id === id; })[0], rowId); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
