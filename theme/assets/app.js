/* core.js: the shared front-end engine (window.UI). Same in every app made from APP_MAKER/template;
   app-specific things live in web/app.js (brand, nav, footer) and web/pages/*.html (the pages).

   Pages:   UI.page(name, {title, nav, icon, auth, order, chrome}, mount)
              auth: null (anyone) | 'guest' (signed-out only) | 'user' | 'admin'
              nav: label for the header / phone tab bar (omit to keep it out of the menus)
              mount(view, ctx) draws into `view`; ctx = {args, me, go, api}. Return a Promise (the page
              is "ready" when it resolves) or {ready, destroy}. URLs are #name/arg1/arg2.
   Server:  UI.api(fn, ...args) -> Promise of the server function's return value. A reply of
              {ok: false, error} rejects with that message (shown as a toast unless you .catch it).
            UI.apiQuiet(fn, ...args) is the same without Anvil's loading spinner.
   Auth:    UI.auth('login'|'signup'|'reset'|'logout', {...}) -> Promise of {ok, me, message}
   Helpers: UI.esc, UI.icon, UI.toast, UI.modal, UI.confirm, UI.busy, UI.formData, UI.fmtDate, UI.ago,
            UI.store, UI.setTheme, UI.feedback, UI.go, UI.refresh
   Tests:   window.UI_READY is true when the current page has finished loading. */
(function () {
  'use strict';
  if (window.UI && window.UI.__v) return;
  var UI = window.UI = { __v: 1, pages: {}, me: null, config: { name: 'App', key: 'app', home: 'home', landing: 'landing' } };
  window.UI_READY = false;

  UI.configure = function (cfg) { Object.keys(cfg).forEach(function (k) { UI.config[k] = cfg[k]; }); };

  /* ------------------------------------------------------------------ small helpers */
  UI.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  UI.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  UI.initials = function (name) {
    var p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  };
  UI.fmtDate = function (iso, opts) {
    if (!iso) return '';
    var d = iso.length <= 10 ? new Date(iso + 'T12:00:00') : new Date(iso);
    return d.toLocaleDateString(undefined, opts || { day: 'numeric', month: 'short', year: 'numeric' });
  };
  UI.fmtDateTime = function (iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  };
  UI.ago = function (iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    var steps = [[60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']], n = s / 60;
    for (var i = 0; i < steps.length; i++) {
      if (n < steps[i][0]) { n = Math.floor(n); return UI.plural(n, steps[i][1]) + ' ago'; }
      n = n / steps[i][0];
    }
    return '';
  };
  UI.store = {
    get: function (k, dflt) { try { var v = localStorage.getItem(UI.config.key + '.' + k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    set: function (k, v) { try { localStorage.setItem(UI.config.key + '.' + k, JSON.stringify(v)); } catch (e) {} }
  };
  UI.formData = function (form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    });
    return out;
  };
  /* Disable a button while a Promise runs; returns the Promise. */
  UI.busy = function (btn, promise) {
    if (!btn) return promise;
    btn.disabled = true; btn.classList.add('is-busy');
    var done = function () { btn.disabled = false; btn.classList.remove('is-busy'); };
    promise.then(done, done);
    return promise;
  };

  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.7c2.2.6 3.5 2.4 3.5 5.3"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8V5M9 5.5 7.5 4M15 5.5 16.5 4M7 13H3M21 13h-4M7.5 18l-3 2M16.5 18l3 2M7.5 9.5l-3-2M16.5 9.5l3-2"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    pin: '<path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'
  };
  UI.ICONS = ICONS;
  UI.icon = function (name, cls) {
    return '<svg class="ui-ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.sparkle) + '</svg>';
  };

  /* ------------------------------------------------------------------ toasts, modals */
  UI.toast = function (msg, kind) {
    var box = document.querySelector('.ui-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'ui ui-toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var t = document.createElement('div');
    t.className = 'ui-toast' + (kind ? ' ' + kind : '');
    t.innerHTML = (kind === 'error' ? UI.icon('info') : kind === 'ok' ? UI.icon('check') : '') + '<span>' + UI.esc(msg) + '</span>';
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 300); }, kind === 'error' ? 6500 : 3200);
  };
  UI.modal = function (html, opts) {
    opts = opts || {};
    var prev = document.activeElement;
    var wrap = document.createElement('div');
    wrap.className = 'ui ui-modal-wrap';
    wrap.innerHTML = '<div class="ui-modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' +
      '<button class="ui-btn ghost icon ui-modal-x" data-close aria-label="Close">' + UI.icon('x') + '</button>' + html + '</div>';
    document.body.appendChild(wrap);
    document.documentElement.classList.add('ui-modal-open');
    function key(e) { if (e.key === 'Escape') close(); }
    function close() {
      if (!wrap.parentNode) return;
      wrap.remove(); document.removeEventListener('keydown', key);
      if (!document.querySelector('.ui-modal-wrap')) document.documentElement.classList.remove('ui-modal-open');
      if (opts.onclose) opts.onclose();
      if (prev && prev.focus) prev.focus();
    }
    document.addEventListener('keydown', key);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
    wrap.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) close(); });
    var first = wrap.querySelector('input, textarea, select');
    setTimeout(function () { (first || wrap.querySelector('.ui-modal')).focus && (first || wrap.querySelector('.ui-modal')).focus(); }, 30);
    return { el: wrap.querySelector('.ui-modal'), close: close };
  };
  UI.confirm = function (o) {
    o = typeof o === 'string' ? { title: o } : (o || {});
    return new Promise(function (resolve) {
      var answered = false;
      var m = UI.modal('<h2>' + UI.esc(o.title || 'Are you sure?') + '</h2>' + (o.text ? '<p class="muted">' + UI.esc(o.text) + '</p>' : '') +
        '<div class="ui-row end" style="margin-top:20px"><button class="ui-btn ghost" data-close>' + UI.esc(o.cancel || 'Cancel') + '</button>' +
        '<button class="ui-btn ' + (o.danger ? 'danger solid' : 'primary') + '" data-ok>' + UI.esc(o.ok || 'OK') + '</button></div>',
      { onclose: function () { if (!answered) resolve(false); } });
      m.el.querySelector('[data-ok]').onclick = function () { answered = true; m.close(); resolve(true); };
    });
  };

  /* ------------------------------------------------------------------ theme */
  UI.theme = function () { return UI.store.get('theme', 'auto'); };
  UI.applyTheme = function (t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var dark = t === 'dark' || (t !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('ui-dark', !!dark);
  };
  UI.setTheme = function (t) { UI.store.set('theme', t); UI.applyTheme(t); };
  UI.applyTheme(UI.theme());
  if (window.matchMedia) {
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { UI.applyTheme(UI.theme()); }); } catch (e) {}
  }

  /* ------------------------------------------------------------------ server bridge */
  var bridge = null;
  function send(kind, payload) {
    if (!bridge) return Promise.reject(new Error('The app is still starting.'));
    var out;
    try { out = bridge(kind, JSON.stringify(payload || {})); } catch (e) { return Promise.reject(e); }
    return Promise.resolve(out).then(function (r) {
      r = typeof r === 'string' ? JSON.parse(r) : (r || {});
      if (r.error) {
        var err = new Error(r.error); err.uiApi = true; err.denied = !!r.denied;
        if (r.detail) console.error(kind, payload && payload.fn, r.detail);
        if (r.reload) setTimeout(function () { location.reload(); }, 2500);
        throw err;
      }
      return r.result;
    });
  }
  function apiCall(quiet, fn, args) {
    return send('call', { fn: fn, args: args, quiet: quiet }).then(function (res) {
      if (res && typeof res === 'object' && res.ok === false) {
        var err = new Error(res.error || 'That didn\'t work.'); err.uiApi = true; err.expected = true; err.result = res;
        throw err;
      }
      return res;
    });
  }
  UI.api = function (fn) { return apiCall(false, fn, Array.prototype.slice.call(arguments, 1)); };
  /* UI.upload(fn, file, ...args): the server function gets the File as Anvil Media first, then args.
     (Main.py turns the browser File into Media with anvil.js.to_media; locally the harness posts it.) */
  UI.upload = function (fn, file) {
    UI._file = file;
    return send('upload', { fn: fn, args: Array.prototype.slice.call(arguments, 2) }).then(function (res) {
      UI._file = null;
      if (res && typeof res === 'object' && res.ok === false) { var err = new Error(res.error || 'That didn\'t work.'); err.uiApi = true; err.expected = true; err.result = res; throw err; }
      return res;
    }, function (e) { UI._file = null; throw e; });
  };
  UI.apiQuiet = function (fn) { return apiCall(true, fn, Array.prototype.slice.call(arguments, 1)); };
  /* Errors nobody caught become a toast, so a failed action is never silent. */
  window.addEventListener('unhandledrejection', function (e) {
    if (e.reason && e.reason.uiApi) { e.preventDefault(); UI.toast(e.reason.message, 'error'); }
  });

  /* Sign in / up / out. On success it navigates: to where the visitor was heading (UI.after) or home
     after signing in, to the landing page after signing out. */
  UI.auth = function (kind, payload) {
    return send(kind, payload || {}).then(function (r) {
      if (r && r.ok === false) { var err = new Error(r.error); err.uiApi = true; err.expected = true; throw err; }
      if (r && 'me' in r && (r.me || kind === 'logout')) {
        UI.me = r.me || null;
        var target = r.me ? (UI.after || '#' + UI.config.home) : '#' + UI.config.landing;
        UI.after = null;
        if (location.hash === target) route(); else location.hash = target;
      }
      return r;
    });
  };
  /* Update the signed-in user's details (e.g. a new name) and redraw the header, without reloading the page. */
  UI.setMe = function (me) {
    UI.me = me || null;
    if (shellRoot) renderChrome(current.name);
  };

  /* ------------------------------------------------------------------ pages and routing */
  UI.page = function (name, opts, mount) {
    if (typeof opts === 'function') { mount = opts; opts = {}; }
    opts.name = name; opts.mount = mount;
    UI.pages[name] = opts;
  };
  UI.allowed = function (p) {
    if (!p) return false;
    if (p.auth === 'user') return !!UI.me;
    if (p.auth === 'admin') return !!(UI.me && UI.me.is_admin);
    if (p.auth === 'guest') return !UI.me;
    return true;
  };
  UI.navPages = function () {
    return Object.keys(UI.pages).map(function (k) { return UI.pages[k]; })
      .filter(function (p) { return p.nav && UI.allowed(p) && (!p.when || p.when()); })
      .sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
  };
  UI.parseHash = function () {
    var h = (location.hash || '').replace(/^#!?\/?/, '');
    var parts = h.split('?')[0].split('/').filter(function (x) { return x !== ''; }).map(decodeURIComponent);
    return { name: parts[0] || '', args: parts.slice(1) };
  };
  UI.hashFor = function (name) {
    var args = Array.prototype.slice.call(arguments, 1).filter(function (a) { return a != null && a !== ''; });
    return '#' + [name].concat(args.map(encodeURIComponent)).join('/');
  };
  UI.go = function (name) {
    var h = UI.hashFor.apply(null, arguments);
    if (location.hash === h) route(); else location.hash = h;
  };
  UI.refresh = function () { route(); };
  UI.after = null;  // where to go after signing in

  var shellRoot = null, view = null, current = { name: null, destroy: null }, routeSeq = 0;

  function defaultPage() { return UI.me ? UI.config.home : UI.config.landing; }

  function route() {
    var r = UI.parseHash(), name = r.name || defaultPage(), p = UI.pages[name];
    if (!p) { name = defaultPage(); p = UI.pages[name]; r.args = []; }
    if (p.auth === 'guest' && UI.me) { p = UI.pages[UI.config.home]; name = UI.config.home; r.args = []; }
    if ((p.auth === 'user' || p.auth === 'admin') && !UI.me) {
      UI.after = location.hash && location.hash !== '#' ? location.hash : null;
      p = UI.pages.auth; name = 'auth'; r.args = [];
    }
    if (p.auth === 'admin' && !(UI.me && UI.me.is_admin)) {
      UI.toast('That page is for admins only.', 'error');
      p = UI.pages[UI.config.home]; name = UI.config.home; r.args = [];
    }
    var seq = ++routeSeq;
    window.UI_READY = false;
    if (current.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
    current = { name: name, args: r.args, destroy: null };
    if (shellRoot) {
      shellRoot.className = 'ui ui-shell page-' + name + (UI.me ? ' signed-in' : ' signed-out') + (p.chrome === false ? ' no-chrome' : '');
      renderChrome(name);
    }
    // A fresh element for every page, so listeners a page adds to `view` never pile up.
    var fresh = view.cloneNode(false);
    view.parentNode.replaceChild(fresh, view);
    view = fresh;
    window.scrollTo(0, 0);
    document.title = (p.title ? (typeof p.title === 'function' ? p.title(r.args) : p.title) + ' · ' : '') + UI.config.name;
    var ctx = { name: name, args: r.args, me: UI.me, go: UI.go, api: UI.api, page: p };
    var out;
    try { out = p.mount(view, ctx); } catch (e) { console.error(e); out = Promise.reject(e); }
    var ready = out && typeof out.then === 'function' ? out : (out && out.ready) || Promise.resolve();
    if (out && out.destroy) current.destroy = out.destroy;
    Promise.resolve(ready).then(function () { if (seq === routeSeq) window.UI_READY = true; },
      function (e) {
        if (seq !== routeSeq) return;
        console.error(e);
        if (!view.innerHTML) view.innerHTML = '<div class="ui-wrap"><div class="ui-empty">' + UI.icon('info') +
          '<h3>This page didn\'t load</h3><p class="muted">' + UI.esc(e && e.message || 'Something went wrong.') + '</p>' +
          '<button class="ui-btn" onclick="UI.refresh()">Try again</button></div></div>';
        window.UI_READY = true;
      });
  }
  UI.current = function () { return current; };

  /* The shell's parts come from web/app.js: UI.shell = {header(me, active), footer(me), tabbar(me, active)} */
  function renderChrome(active) {
    var S = UI.shell || {};
    var hd = shellRoot.querySelector('[data-ui-header]'), ft = shellRoot.querySelector('[data-ui-footer]'), tb = shellRoot.querySelector('[data-ui-tabbar]');
    if (hd) hd.innerHTML = S.header ? S.header(UI.me, active) : '';
    if (ft) ft.innerHTML = S.footer ? S.footer(UI.me, active) : '';
    if (tb) tb.innerHTML = S.tabbar ? S.tabbar(UI.me, active) : '';
  }
  UI.renderChrome = function () { if (shellRoot) renderChrome(current.name); };

  /* Called by client_code/Main.py (and by the local harness) once the page is up. */
  UI.start = function (node, bridgeFn, bootJson) {
    bridge = bridgeFn;
    var boot = typeof bootJson === 'string' ? JSON.parse(bootJson || '{}') : (bootJson || {});
    UI.me = boot.me || null;
    var host = node && node.matches && node.matches('[data-ui-app]') ? node : (node && node.querySelector('[data-ui-app]')) || node || document.body;
    host.innerHTML = '<div class="ui ui-shell">' +
      '<header class="ui-header" data-ui-header></header>' +
      '<main class="ui-main" data-ui-view></main>' +
      '<footer class="ui-footer" data-ui-footer></footer>' +
      '<nav class="ui-tabbar" data-ui-tabbar aria-label="Main"></nav></div>';
    shellRoot = host.firstChild;
    view = host.querySelector('[data-ui-view]');
    if (UI.shell && UI.shell.wire) UI.shell.wire(shellRoot);
    window.addEventListener('hashchange', route);
    route();
  };

  /* ------------------------------------------------------------------ feedback form (footer + menu) */
  UI.feedback = function (kind) {
    var kinds = [['bug', 'Something\'s broken', 'bug'], ['idea', 'An idea', 'bulb'], ['question', 'A question', 'info'], ['other', 'Something else', 'chat']];
    var m = UI.modal('<h2>Send feedback</h2><p class="muted">Found a bug or have an idea? It goes straight to the people who make ' + UI.esc(UI.config.name) + '.</p>' +
      '<form class="ui-stack" data-fb>' +
      '<div class="ui-choices">' + kinds.map(function (k) {
        return '<label class="ui-choice"><input type="radio" name="kind" value="' + k[0] + '"' + ((kind || 'bug') === k[0] ? ' checked' : '') + '>' +
          '<span>' + UI.icon(k[2]) + UI.esc(k[1]) + '</span></label>';
      }).join('') + '</div>' +
      '<label class="ui-field"><span>What happened, or what would you like?</span><textarea name="message" rows="5" required minlength="5" placeholder="The more detail, the better."></textarea></label>' +
      (UI.me ? '' : '<label class="ui-field"><span>Your email <em>(optional, if you\'d like a reply)</em></span><input type="email" name="email" autocomplete="email"></label>') +
      '<p class="ui-hint">We also send the page you were on, your screen size and browser, to help us fix bugs.</p>' +
      '<div class="ui-row end"><button type="button" class="ui-btn ghost" data-close>Cancel</button><button class="ui-btn primary" type="submit">' + UI.icon('arrow') + 'Send</button></div></form>');
    var form = m.el.querySelector('[data-fb]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = UI.formData(form);
      var ctx = { page: location.hash || '#', screen: innerWidth + 'x' + innerHeight, browser: navigator.userAgent.slice(0, 280), theme: UI.theme() };
      UI.busy(form.querySelector('[type=submit]'), UI.api('submit_feedback', v.kind, v.message, v.email || null, ctx)).then(function () {
        m.close(); UI.toast('Thank you! Your message was sent.', 'ok');
      });
    });
    return m;
  };

  /* Shared clicks: [data-go="page/arg"], [data-feedback], [data-theme-set] anywhere in the app. */
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-go],[data-feedback],[data-theme-set]');
    if (!el) return;
    if (el.hasAttribute('data-go')) { e.preventDefault(); UI.go.apply(null, el.getAttribute('data-go').split('/')); }
    else if (el.hasAttribute('data-feedback')) { e.preventDefault(); UI.feedback(el.getAttribute('data-feedback') || null); }
    else if (el.hasAttribute('data-theme-set')) { e.preventDefault(); UI.setTheme(el.getAttribute('data-theme-set')); if (UI.shell && UI.shell.onTheme) UI.shell.onTheme(); }
  });
})();


/* app.js: this app's identity and frame: name, header, footer, phone tab bar.
   Pages live in web/pages/*.html. The engine (window.UI) is web/core.js. */
(function () {
  'use strict';
  UI.configure({
    name: 'Sheetsmith',
    key: 'sheetsmith',          // prefix for this app's browser storage
    tagline: 'Your workbook, forged into an app for your network.',   // footer line
    home: 'home',                // first page after signing in
    landing: 'landing'           // first page for visitors who aren't signed in
  });

  // icons the pages use, on top of core.js's set
  var more = {
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    upload: '<path d="M12 16V5M7 10l5-5 5 5"/><path d="M4 19h16"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
    receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
    calc: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 11h2M14 11h2M8 15h2M14 15h2M8 19h2M14 19h2"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
    monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'
  };
  Object.keys(more).forEach(function (k) { UI.ICONS[k] = more[k]; });

  var esc = UI.esc;

  function brand() {
    return '<a class="ui-brand" href="#" data-go="' + (UI.me ? UI.config.home : UI.config.landing) + '" aria-label="' + esc(UI.config.name) + ' home">' +
      '<img src="_/theme/icon.svg" alt="" width="32" height="32"><span>' + esc(UI.config.name) + '</span></a>';
  }

  function themeSwitch() {
    var t = UI.theme();
    return '<div class="ui-seg" role="group" aria-label="Appearance">' + [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(function (o) {
      return '<button type="button" data-theme-set="' + o[0] + '" class="' + (t === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  function userMenu(me) {
    return '<div class="ui-menu" data-menu hidden>' +
      '<div class="ui-menu-head"><strong>' + esc(me.name) + '</strong><span class="muted small">' + esc(me.email) + '</span></div>' +
      '<a href="#profile" data-go="profile">' + UI.icon('user') + 'Your profile</a>' +
      (me.is_admin ? '<a href="#admin" data-go="admin">' + UI.icon('shield') + 'Admin</a>' : '') +
      '<div class="ui-menu-block"><span class="small muted">Appearance</span>' + themeSwitch() + '</div>' +
      '<button type="button" data-feedback>' + UI.icon('chat') + 'Send feedback</button>' +
      '<button type="button" data-lk-open="overview">' + UI.icon('lock') + 'Privacy &amp; Terms</button>' +
      '<button type="button" data-signout>' + UI.icon('logout') + 'Sign out</button></div>';
  }

  UI.shell = {
    header: function (me, active) {
      var nav = UI.navPages();
      return '<div class="ui-header-in">' + brand() +
        (me ? '<nav class="ui-nav" aria-label="Main">' + nav.map(function (p) {
          return '<a href="#' + p.name + '" class="' + (p.name === active ? 'on' : '') + '">' + UI.icon(p.icon) + '<span>' + esc(p.nav) + '</span></a>';
        }).join('') + '</nav>' : '') +
        '<div class="ui-header-right">' +
        (me ? '<button type="button" class="ui-avatar-btn" data-menu-toggle aria-label="Your account" aria-haspopup="true">' + esc(UI.initials(me.name)) + '</button>' + userMenu(me)
          : (active === 'auth' ? '' : '<a class="ui-btn ghost" href="#auth" data-go="auth">Sign in</a><a class="ui-btn primary" href="#auth/signup" data-go="auth/signup">Get started</a>')) +
        '</div></div>';
    },
    footer: function (me) {
      return '<div class="ui-footer-in"><div class="ui-footer-brand">' + brand() + '<p class="muted small">' + esc(UI.config.tagline) + '</p></div>' +
        '<div class="ui-footer-links">' +
        '<a href="#landing" data-go="landing">About</a>' +
        '<button type="button" data-feedback>Send feedback</button>' +
        '<button type="button" data-lk-open="overview">Privacy &amp; Terms</button>' +
        '</div><p class="ui-footer-legal small muted">© ' + new Date().getFullYear() + ' ' + esc(UI.config.name) + '</p></div>';
    },
    tabbar: function (me, active) {
      var nav = UI.navPages();
      if (!me || nav.length < 2) return '';
      return nav.slice(0, 4).map(function (p) {
        return '<a href="#' + p.name + '" class="' + (p.name === active ? 'on' : '') + '">' + UI.icon(p.icon) + '<span>' + esc(p.nav) + '</span></a>';
      }).join('') + '<a href="#profile" class="' + (active === 'profile' ? 'on' : '') + '">' + UI.icon('user') + '<span>You</span></a>';
    },
    wire: function (root) {
      root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-menu-toggle]');
        var menu = root.querySelector('[data-menu]');
        if (t && menu) { menu.hidden = !menu.hidden; t.setAttribute('aria-expanded', String(!menu.hidden)); return; }
        if (e.target.closest('[data-signout]')) { UI.auth('logout').then(function () { UI.toast('Signed out. See you soon!'); }); }
        if (menu && !menu.hidden && !e.target.closest('[data-menu] .ui-seg')) menu.hidden = true;
      });
      document.addEventListener('keydown', function (e) {
        var menu = root.querySelector('[data-menu]');
        if (e.key === 'Escape' && menu) menu.hidden = true;
      });
    },
    onTheme: function () {  // redraw the menu's Auto/Light/Dark buttons and keep the menu open
      var menu = document.querySelector('[data-menu]'), open = menu && !menu.hidden;
      UI.renderChrome();
      if (open) document.querySelector('[data-menu]').hidden = false;
    }
  };
})();


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


/* ===== _builder.html ===== */
(function () {
  'use strict';
  var SS = window.SS = {};
  var RT_NAMES = ['rt-formula.js', 'rt-vba.js', 'rt-app.js', 'rt-app.css', 'rt-server.py.txt', 'rt-readme.txt', 'rt-start.bat.txt', 'rt-start.sh.txt'];
  var rt = null;
  function version() {
    var s = Array.prototype.slice.call(document.querySelectorAll('script[src*="app.js"]')).map(function (x) { return x.src; })[0] || '';
    var m = /[?&]v=([^&]+)/.exec(s);
    return m ? m[1] : String(Date.now());
  }
  SS.runtime = function () {
    if (rt) return rt;
    var v = version();
    rt = Promise.all(RT_NAMES.map(function (n) {
      return fetch('_/theme/' + n + '?v=' + v).then(function (r) { if (!r.ok) throw new Error('Couldn\'t load ' + n + ' (' + r.status + ')'); return r.text(); });
    })).then(function (texts) { var o = {}; RT_NAMES.forEach(function (n, i) { o[n] = texts[i]; }); return o; });
    rt.catch(function () { rt = null; });
    return rt;
  };
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
    var take = function (f) { var problem = SS.checkFile(f); if (problem) { UI.toast(problem, 'error'); return; } onFile(f); };
    el.addEventListener('click', function (e) { if (!e.target.closest('input,a,button[data-noclick]')) input.click(); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { if (input.files[0]) take(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (n) { el.addEventListener(n, function (e) { e.preventDefault(); el.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { el.addEventListener(n, function (e) { e.preventDefault(); el.classList.remove('over'); }); });
    el.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) take(f); });
  };
  SS.dropHtml = function (title, sub) {
    return '<div class="ss-drop" data-drop tabindex="0" role="button" aria-label="Choose a workbook"><input type="file" accept=".xlsx,.xlsm,.xltx,.xltm" hidden>' +
      '<div class="ss-drop-art" aria-hidden="true"><span></span><span></span><span></span><span class="on"></span></div>' +
      '<div><b>' + UI.esc(title) + '</b><span>' + UI.esc(sub) + '</span></div><span class="ui-btn primary">' + UI.icon('upload') + 'Choose a file</span></div>';
  };
  /* A project card (home + landing). */
  var EXAMPLE_COLORS = { bakery: '#B45309', tools: '#0F766E', quote: '#334155' };
  var EXAMPLE_BLURB = { bakery: 'Orders, a menu with prices, a live summary, an archive and three macros.', tools: 'Tools, loans with late fees, members, an overdue check.', quote: 'A quote calculator with live totals, tax and a Save macro.' };
  SS.card = function (p) {
    var s = p.summary || {}, color = p.example ? EXAMPLE_COLORS[p.example] || '#1D7A4F' : '#1D7A4F';
    var chips = [s.tables + (s.lists || 0) ? UI.plural(s.tables + (s.lists || 0), 'table') : null, s.formulas ? UI.plural(s.formulas, 'formula') : null, s.procedures ? UI.plural(s.procedures, 'macro') : null, s.rules ? UI.plural(s.rules, 'rule') : null].filter(Boolean);
    return '<a class="ui-card ss-pcard" href="#project/' + UI.esc(p.id) + '" data-go="project/' + UI.esc(p.id) + '"><div class="top"><span class="mk" style="background:' + color + '">' + UI.esc(UI.initials(p.name)) + '</span>' +
      '<div><h3>' + UI.esc(p.name) + '</h3><div class="file">' + UI.esc(p.file_name || '') + '</div></div></div>' +
      (p.example ? '<p>' + UI.esc(EXAMPLE_BLURB[p.example] || '') + '</p>' : '') +
      '<div class="chips">' + chips.map(function (c) { return '<span class="ui-badge">' + UI.esc(c) + '</span>'; }).join('') + '</div>' +
      '<div class="foot"><span>' + (p.example ? 'Example' : 'Changed ' + UI.ago(p.updated)) + '</span><span>' + UI.icon('download') + ' ' + (p.downloads || 0) + '</span></div></a>';
  };

  /* Busy overlay while a workbook is read (it can take a few seconds for big ones). */
  SS.reading = function (name) {
    var steps = ['Opening the file', 'Reading sheets and cells', 'Finding tables and rules', 'Unpacking the VBA macros', 'Sketching the screens'];
    var m = UI.modal('<div class="ss-reading"><div class="ss-drop-art big" aria-hidden="true"><span></span><span></span><span></span><span class="on"></span></div><h2>Reading ' + UI.esc(name) + '</h2><p class="muted" data-step>' + steps[0] + '…</p></div>');
    var i = 0, t = setInterval(function () { i = Math.min(i + 1, steps.length - 1); var el = m.el.querySelector('[data-step]'); if (el) el.textContent = steps[i] + '…'; }, 700);
    return { close: function () { clearInterval(t); m.close(); } };
  };
})();

/* ===== admin.html ===== */
(function () {
  var esc = UI.esc;
  var TABS = [['overview', 'Overview', 'grid'], ['projects', 'Projects', 'layers'], ['feedback', 'Feedback', 'inbox'], ['users', 'Users', 'users'], ['demo', 'Demo data', 'database']];

  UI.page('admin', { title: 'Admin', auth: 'admin' }, function (view, ctx) {
    var tab = TABS.some(function (t) { return t[0] === ctx.args[0]; }) ? ctx.args[0] : 'overview';
    var fbFilter = 'new';
    view.innerHTML = '<div class="ui-wrap"><div class="ui-page-head"><div><h1>Admin</h1><p class="muted">Only admins see this page.</p></div></div>' +
      '<nav class="ui-tabs">' + TABS.map(function (t) {
        return '<a href="#admin/' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' + UI.icon(t[2]) + t[1] + '</a>';
      }).join('') + '</nav><div data-body><div class="ui-skel"></div></div></div>';
    var body = view.querySelector('[data-body]');

    function overview() {
      return UI.api('admin_overview').then(function (d) {
        var stat = function (n, label, go) { return '<a class="ui-card ui-stat" href="#admin/' + go + '" style="text-decoration:none;color:inherit"><b>' + n + '</b><span>' + label + '</span></a>'; };
        body.innerHTML = '<div class="ad-stats">' + stat(d.users, 'people signed up', 'users') + stat(d.admins, UI.plural(d.admins, 'admin').replace(/^\d+ /, ''), 'users') +
          stat(d.feedback_new, 'new feedback', 'feedback') + stat(d.projects, 'projects', 'projects') + stat(d.downloads, 'apps downloaded', 'projects') + '</div>' +
          '<p class="muted small" style="margin-top:18px">Demo data is <b>' + esc(d.demo.state) + '</b> (' + d.demo.counts.users + ' demo people). Manage it in the Demo data tab.</p>';
      });
    }

    function feedback() {
      return UI.api('list_feedback', null).then(function (d) {
        var items = d.items.filter(function (i) { return fbFilter === 'all' || i.status === fbFilter; });
        body.innerHTML = '<div class="ui-row" style="margin-bottom:16px"><div class="ui-seg">' + [['new', 'New'], ['read', 'Read'], ['done', 'Done'], ['all', 'All']].map(function (f) {
          var n = f[0] === 'all' ? d.items.length : d.counts[f[0]];
          return '<button data-filter="' + f[0] + '" class="' + (fbFilter === f[0] ? 'on' : '') + '">' + f[1] + ' (' + n + ')</button>';
        }).join('') + '</div></div>' +
          (items.length ? '<div class="ad-fb">' + items.map(function (i) {
            var c = i.context || {};
            return '<div class="ui-item" data-id="' + esc(i.id) + '"><div class="meta"><span class="ui-badge ' + (i.kind === 'bug' ? 'bad' : i.kind === 'idea' ? 'brand' : '') + '">' + esc(i.kind_label) + '</span>' +
              '<b>' + esc(i.name) + '</b>' + (i.email ? '<a href="mailto:' + esc(i.email) + '">' + esc(i.email) + '</a>' : '') + '<span>' + esc(UI.fmtDateTime(i.created)) + '</span></div>' +
              '<p class="msg">' + esc(i.message) + '</p>' +
              '<div class="ctx">' + esc([c.page, c.screen, c.theme, c.browser].filter(Boolean).join(' · ')) + '</div>' +
              '<textarea data-note placeholder="Private note (only admins see it)">' + esc(i.note) + '</textarea>' +
              '<div class="ui-row" style="margin-top:10px">' + ['new', 'read', 'done'].map(function (s) {
                return '<button class="ui-btn sm' + (i.status === s ? ' primary' : '') + '" data-status="' + s + '">' + s[0].toUpperCase() + s.slice(1) + '</button>';
              }).join('') + '<span class="ui-spacer"></span><button class="ui-btn sm danger" data-del-fb>' + UI.icon('trash') + 'Delete</button></div></div>';
          }).join('') + '</div>'
            : '<div class="ui-empty">' + UI.icon('inbox') + '<h3>No ' + (fbFilter === 'all' ? '' : fbFilter + ' ') + 'messages</h3><p>Messages from the "Send feedback" form show up here.</p></div>');
      });
    }

    function users(query) {
      return UI.api('list_users', query || null).then(function (d) {
        body.innerHTML = '<form class="ui-row" data-search style="margin-bottom:14px"><input type="search" name="q" placeholder="Search by name or email" value="' + esc(query || '') + '" style="max-width:360px">' +
          '<button class="ui-btn" type="submit">' + UI.icon('search') + 'Search</button><span class="muted small">' + UI.plural(d.total, 'person', 'people') + '</span></form>' +
          '<table class="ad-users"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Admin</th><th>Active</th></tr></thead><tbody>' +
          d.users.map(function (u) {
            return '<tr data-id="' + esc(u.id) + '"><td><b>' + esc(u.name) + '</b></td><td class="email">' + esc(u.email) + '</td><td class="joined muted">' + esc(UI.fmtDate(u.joined)) + '</td>' +
              '<td><label class="ui-check"><input type="checkbox" data-admin' + (u.is_admin ? ' checked' : '') + '> Admin</label></td>' +
              '<td><label class="ui-check"><input type="checkbox" data-enabled' + (u.enabled ? ' checked' : '') + '> Active</label></td></tr>';
          }).join('') + '</tbody></table>';
      });
    }

    function demo() {
      return UI.api('admin_overview').then(function (d) {
        var c = d.demo.counts;
        body.innerHTML = '<div class="ui-card ui-narrow" style="margin:0"><h3>Demo data</h3>' +
          '<p class="muted">Example people and content, so the app never looks empty for the first visitors. Demo rows are flagged, so removing them never touches real data. Once removed, it stays removed until you load it again.</p>' +
          '<p>Status: <b>' + esc(d.demo.state) + '</b> · ' + Object.keys(c).map(function (k) { return c[k] + ' ' + esc(k); }).join(', ') + '</p>' +
          '<div class="ui-row"><button class="ui-btn primary" data-demo="load">' + UI.icon('refresh') + (d.demo.state === 'loaded' ? 'Reload demo data' : 'Load demo data') + '</button>' +
          '<button class="ui-btn danger" data-demo="remove">' + UI.icon('trash') + 'Remove demo data</button></div></div>';
      });
    }

    function projects(query) {
      return UI.api('admin_projects', query || null).then(function (d) {
        body.innerHTML = '<form class="ui-row" data-psearch style="margin-bottom:14px"><input type="search" name="q" placeholder="Search by name, file or owner" value="' + esc(query || '') + '" style="max-width:360px">' +
          '<button class="ui-btn" type="submit">' + UI.icon('search') + 'Search</button><span class="muted small">' + UI.plural(d.total, 'project') + '</span></form>' +
          (d.projects.length ? '<table class="ad-users"><thead><tr><th>Project</th><th>Owner</th><th>File</th><th>Changed</th><th>Downloads</th><th></th></tr></thead><tbody>' + d.projects.map(function (p) {
            var s = p.summary || {};
            return '<tr data-pid="' + esc(p.id) + '"><td><a href="#project/' + esc(p.id) + '" data-go="project/' + esc(p.id) + '"><b>' + esc(p.name) + '</b></a>' + (p.demo ? ' <span class="ui-badge">Example</span>' : '') +
              '<div class="muted small">' + [s.tables ? UI.plural(s.tables + (s.lists || 0), 'table') : '', s.formulas ? UI.plural(s.formulas, 'formula') : '', s.procedures ? UI.plural(s.procedures, 'macro') : ''].filter(Boolean).join(' · ') + '</div></td>' +
              '<td class="email">' + esc(p.owner) + '<div class="muted small">' + esc(p.owner_email || '') + '</div></td><td class="email small">' + esc(p.file_name || '') + '<div class="muted">' + Math.max(1, Math.round((p.size || 0) / 1024)) + ' KB</div></td>' +
              '<td class="joined muted">' + esc(UI.ago(p.updated)) + '</td><td>' + (p.downloads || 0) + '</td><td><button class="ui-btn sm danger" data-pdel>' + UI.icon('trash') + '</button></td></tr>';
          }).join('') + '</tbody></table>' : '<div class="ui-empty">' + UI.icon('layers') + '<h3>No projects yet</h3><p>Projects people save show up here.</p></div>');
      });
    }

    var DRAW = { overview: overview, projects: projects, feedback: feedback, users: users, demo: demo };

    view.addEventListener('click', function (e) {
      var f = e.target.closest('[data-filter]');
      if (f) { fbFilter = f.getAttribute('data-filter'); feedback(); return; }
      var st = e.target.closest('[data-status]');
      if (st) {
        var card = st.closest('[data-id]');
        UI.api('set_feedback_status', card.getAttribute('data-id'), st.getAttribute('data-status'), card.querySelector('[data-note]').value).then(function () { UI.toast('Saved', 'ok'); feedback(); });
        return;
      }
      var del = e.target.closest('[data-del-fb]');
      if (del) {
        UI.confirm({ title: 'Delete this message?', ok: 'Delete', danger: true }).then(function (yes) {
          if (yes) UI.api('delete_feedback', del.closest('[data-id]').getAttribute('data-id')).then(feedback);
        });
        return;
      }
      var pd = e.target.closest('[data-pdel]');
      if (pd) {
        UI.confirm({ title: 'Delete this project?', text: 'The workbook and its settings are deleted for its owner too.', ok: 'Delete', danger: true }).then(function (yes) {
          if (yes) UI.api('admin_delete_project', pd.closest('[data-pid]').getAttribute('data-pid')).then(function () { UI.toast('Deleted', 'ok'); projects(); });
        });
        return;
      }
      var dm = e.target.closest('[data-demo]');
      if (dm) {
        var load = dm.getAttribute('data-demo') === 'load';
        UI.confirm({ title: load ? 'Load the demo data?' : 'Remove the demo data?', text: load ? 'Demo people and content are added (any old demo rows are replaced).' : 'Every demo row is deleted. Real data stays.', ok: load ? 'Load' : 'Remove', danger: !load })
          .then(function (yes) { if (yes) UI.busy(dm, UI.api(load ? 'demo_load' : 'demo_remove')).then(function () { UI.toast('Done', 'ok'); demo(); }); });
      }
    });
    view.addEventListener('change', function (e) {
      var row = e.target.closest('tr[data-id]');
      if (!row) return;
      var id = row.getAttribute('data-id'), box = e.target;
      var fn = box.hasAttribute('data-admin') ? 'set_admin' : box.hasAttribute('data-enabled') ? 'set_enabled' : null;
      if (fn) UI.api(fn, id, box.checked).then(function () { UI.toast('Saved', 'ok'); }, function (err) { box.checked = !box.checked; UI.toast(err.message, 'error'); });
    });
    view.addEventListener('submit', function (e) {
      if (e.target.matches('[data-search]')) { e.preventDefault(); users(UI.formData(e.target).q); }
      if (e.target.matches('[data-psearch]')) { e.preventDefault(); projects(UI.formData(e.target).q); }
    });
    return DRAW[tab]();
  });
})();

/* ===== auth.html ===== */
(function () {
  var esc = UI.esc;
  function pw(name, auto) {
    return '<div class="au-pw"><input type="password" name="' + name + '" autocomplete="' + auto + '" required minlength="8">' +
      '<button type="button" data-show>Show</button></div>';
  }
  UI.page('auth', { title: 'Sign in', auth: 'guest' }, function (view, ctx) {
    var mode = ['signup', 'reset'].indexOf(ctx.args[0]) >= 0 ? ctx.args[0] : 'login';
    function draw(msg, isErr) {
      var heading = { login: 'Welcome back', signup: 'Create your account', reset: 'Reset your password' }[mode];
      var sub = { login: 'Sign in to continue to ' + esc(UI.config.name) + '.', signup: 'It\'s free and takes a few seconds.',
        reset: 'We\'ll email you a link to choose a new password.' }[mode];
      view.innerHTML = '<div class="au-wrap"><div class="ui-card au-card">' +
        '<h1>' + heading + '</h1><p class="muted">' + sub + '</p>' +
        (mode !== 'reset' ? '<div class="ui-seg" role="tablist"><button type="button" data-mode="login" class="' + (mode === 'login' ? 'on' : '') + '">Sign in</button>' +
          '<button type="button" data-mode="signup" class="' + (mode === 'signup' ? 'on' : '') + '">Create account</button></div>' : '<div style="height:14px"></div>') +
        '<form class="ui-stack" data-form="' + mode + '" novalidate>' +
        (mode === 'signup' ? '<label class="ui-field"><span>Your name</span><input type="text" name="name" autocomplete="name" required maxlength="60"></label>' : '') +
        '<label class="ui-field"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>' +
        (mode === 'login' ? '<label class="ui-field"><span>Password</span>' + pw('password', 'current-password') + '</label>' : '') +
        (mode === 'signup' ? '<label class="ui-field"><span>Password <em>(at least 8 characters)</em></span>' + pw('password', 'new-password') + '</label>' +
          (window.LegalKit ? '<div>' + LegalKit.consentField() + '</div>' : '') : '') +
        '<div data-msg role="alert"' + (msg ? ' class="' + (isErr ? 'ui-error' : 'ui-note') + '">' + esc(msg) : ' hidden>') + '</div>' +
        '<button class="ui-btn primary block" type="submit">' + { login: 'Sign in', signup: 'Create account', reset: 'Send the link' }[mode] + '</button></form>' +
        '<div class="au-links">' + (mode === 'login' ? '<a data-mode="reset">Forgot your password?</a>' : '<a data-mode="login">' + UI.icon('back') + ' Back to sign in</a>') +
        '<a href="#landing" data-go="landing">About ' + esc(UI.config.name) + '</a></div></div></div>';
      var first = view.querySelector('input');
      if (first && !msg) first.focus();
    }
    view.addEventListener('click', function (e) {
      var m = e.target.closest('[data-mode]');
      if (m) { e.preventDefault(); mode = m.getAttribute('data-mode'); history.replaceState(null, '', '#auth' + (mode === 'login' ? '' : '/' + mode)); draw(); return; }
      var s = e.target.closest('[data-show]');
      if (s) { var i = s.parentNode.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; s.textContent = i.type === 'password' ? 'Show' : 'Hide'; }
    });
    view.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target, v = UI.formData(form);
      var problem = !/^\S+@\S+\.\S+$/.test(v.email || '') ? 'Please enter a valid email address.'
        : mode !== 'reset' && (v.password || '').length < (mode === 'signup' ? 8 : 1) ? (mode === 'signup' ? 'Please choose a password of at least 8 characters.' : 'Please enter your password.')
        : mode === 'signup' && (v.name || '').trim().length < 2 ? 'Please tell us your name.' : null;
      if (problem) { say(problem, true); return; }
      if (mode === 'signup' && window.LegalKit && !LegalKit.consentChecked(form)) return;  // the kit shows its own message
      UI.busy(form.querySelector('[type=submit]'), UI.auth(mode, v)).then(function (r) {
        if (mode === 'reset' || (r && !r.me)) { mode = 'login'; draw(r && r.message, false); restore({ email: v.email }); }
        else UI.toast(mode === 'signup' ? 'Welcome to ' + UI.config.name + '!' : 'Welcome back!', 'ok');
      }, function (err) { say(err.message, true); });
    });
    function say(msg, isErr) {
      var box = view.querySelector('[data-msg]');
      box.className = isErr ? 'ui-error' : 'ui-note'; box.textContent = msg; box.hidden = false;
    }
    function restore(v) {
      ['name', 'email'].forEach(function (k) { var i = view.querySelector('[name=' + k + ']'); if (i && v[k]) i.value = v[k]; });
    }
    draw();
  });
})();

/* ===== guide.html ===== */
(function () {
  var esc = UI.esc;
  var SECTIONS = [['what', 'What converts', 'layers'], ['screens', 'Sheets → screens', 'table'], ['formulas', 'Formulas', 'calc'], ['vba', 'VBA macros', 'bolt'], ['network', 'Run it on a network', 'wifi'], ['limits', 'Limits & privacy', 'shield']];
  UI.page('guide', { title: 'Guide', nav: 'Guide', icon: 'info', order: 30 }, function (view, ctx) {
    var map = [
      ['Tables (ListObjects)', 'yes', 'A list screen with search, filters, sorting and a form per row. Calculated columns, totals rows and new rows work like Excel.'],
      ['Plain lists (a header row with data under it)', 'yes', 'Treated as tables, so they get the same list and form screens.'],
      ['Sheets with labels and input cells', 'yes', 'A form: inputs on one side, the calculated results on the other, updating as people type.'],
      ['Other sheets', 'yes', 'Shown as cells (a grid like Excel), with the formulas, formats and merged cells.'],
      ['Formulas', 'yes', 'Calculated live in the browser. Table references ([@Qty], Orders[Total]), names and cross-sheet references work.'],
      ['Data validation', 'yes', 'Dropdown lists, whole/decimal/date/time/length limits and custom formulas, with your input hints and error messages (stop, warning or information).'],
      ['Conditional formatting', 'yes', 'Formulas, value rules, text rules, duplicates, colour scales and data bars, with the workbook\'s colours.'],
      ['Number formats', 'yes', 'Money, percent, dates, times, thousands separators, custom formats with text.'],
      ['Buttons with macros', 'yes', 'Form buttons and shapes that run a macro become buttons on that screen, with the same label.'],
      ['VBA macros', 'part', 'The everyday kind runs in the browser (see below). The studio checks each procedure and tells you what wouldn\'t.'],
      ['Events', 'part', 'Worksheet_Change, Worksheet_Activate, Workbook_Open and Workbook_SheetChange run. Selection and save events don\'t happen in a web app.'],
      ['UDFs (VBA functions used in cells)', 'yes', 'Public Functions in modules work inside cell formulas.'],
      ['Charts', 'no', 'Not yet. The data behind them comes across.'],
      ['Pivot tables', 'no', 'Kept as plain values: they won\'t refresh.'],
      ['UserForms, ActiveX controls', 'no', 'Not yet. Their code is listed with the macros.'],
      ['Links to other workbooks, Power Query, data connections', 'no', 'Can\'t be followed from the app.']
    ];
    var types = SE.vba.TYPES, objNames = ['Application', 'Workbook', 'Sheets', 'Worksheet', 'Range', 'ListObject', 'ListRows', 'ListRow', 'ListColumns', 'ListColumn', 'Dictionary', 'Collection', 'ErrObject'];
    var vbaFns = Object.keys(SE.vba.BUILTINS).filter(function (k) { return !/^(shell|dir|freefile|getobject|curdir)$/.test(k); }).sort();
    var nice = function (k) { return k.replace(/^./, function (c) { return c.toUpperCase(); }); };
    view.innerHTML = '<div class="ui-wrap"><div class="ui-page-head"><div><div class="eyebrow">Guide</div><h1>How Sheetsmith reads a workbook</h1><p class="muted">What comes across, what runs, and how to run your app on a network.</p></div></div>' +
      '<div class="gd"><nav class="gd-nav">' + SECTIONS.map(function (s) { return '<a href="#guide/' + s[0] + '" data-sec="' + s[0] + '">' + s[1] + '</a>'; }).join('') + '</nav><div>' +
      '<section id="gd-what"><h2>' + UI.icon('layers') + 'What converts</h2><div class="ui-card" style="padding:4px 6px;overflow-x:auto"><table class="gd-map"><thead><tr><th>In the workbook</th><th></th><th>In the app</th></tr></thead><tbody>' +
        map.map(function (m) { return '<tr><td>' + esc(m[0]) + '</td><td class="gd-' + m[1] + '">' + (m[1] === 'yes' ? 'Yes' : m[1] === 'part' ? 'Mostly' : 'Not yet') + '</td><td>' + esc(m[2]) + '</td></tr>'; }).join('') + '</tbody></table></div></section>' +
      '<section id="gd-screens"><h2>' + UI.icon('table') + 'Sheets become screens</h2><p>Sheetsmith looks at each sheet and picks a screen for it:</p><ul>' +
        '<li><b>List + form</b> for each table. The first text column is the card title on phones; a dropdown column called Status, Stage or State becomes the filter chips.</li>' +
        '<li><b>Form</b> when a sheet has labels next to input cells (unlocked cells, cells with validation, or values next to "Label:"). Formula cells next to labels become the results.</li>' +
        '<li><b>Results</b> when a sheet only has labels next to formulas: a summary with big numbers.</li>' +
        '<li><b>Sheet</b> for everything else: the cells as they are.</li></ul>' +
        '<p>Hidden sheets and sheets that only feed dropdowns (often called Lists or Lookups) start hidden: they still work behind the scenes. In the studio\'s <b>Screens</b> tab you can rename, reorder and hide screens, pick icons, and change how each column shows (text, money, date, yes/no, choice…).</p></section>' +
      '<section id="gd-formulas"><h2>' + UI.icon('calc') + 'Formulas</h2><p>The app calculates formulas itself, in the browser, so they work offline. These ' + SE.FUNCTIONS.length + ' functions are supported:</p>' +
        '<div class="ui-card"><div class="gd-fns">' + SE.FUNCTIONS.map(function (f) { return '<code>' + esc(f) + '</code>'; }).join('') + '</div></div>' +
        '<p class="muted" style="margin-top:12px">Also: A1 and table references (<code>[@Qty]</code>, <code>Orders[Total]</code>, <code>Orders[[#Totals],[Qty]]</code>), named ranges, cross-sheet references, whole columns (<code>A:A</code>), array constants, and VBA Functions from the workbook. FILTER, SORT and UNIQUE give their first value (no spilling yet). A function that isn\'t on the list shows <code>#NAME?</code>; the studio lists any your workbook uses.</p></section>' +
      '<section id="gd-vba"><h2>' + UI.icon('bolt') + 'VBA macros</h2><p>Sheetsmith reads the VBA project out of .xlsm files and runs it in the app with its own VBA interpreter. Buttons run their macros; MsgBox and InputBox show as dialogs.</p>' +
        '<h3>Statements</h3><p><code>Sub</code> / <code>Function</code> with ByVal, ByRef, Optional and ParamArray · <code>Dim</code> / <code>Const</code> / <code>ReDim Preserve</code> · <code>If</code> (block and single-line) · <code>Select Case</code> with Is and To · <code>For</code> / <code>For Each</code> / <code>Do</code> / <code>While</code> · <code>With</code> · <code>Exit</code> · <code>On Error Resume Next</code> and <code>On Error GoTo</code> with <code>Resume</code> · <code>GoTo</code> · <code>Call</code> · <code>Option Explicit</code> / <code>Compare Text</code> · Enums and module constants.</p>' +
        '<h3>Objects</h3>' + objNames.filter(function (n) { return types[n]; }).map(function (n) {
          return '<div class="gd-obj"><h4>' + esc(n) + '</h4><div class="gd-fns">' + Object.keys(types[n].members).sort().map(function (k) { return '<code>' + esc(nice(k)) + '</code>'; }).join('') + '</div></div>';
        }).join('') +
        '<p class="muted">Plus <code>WorksheetFunction.*</code> (every formula function above), <code>Application.VLookup</code> and friends, the <code>xl…</code> and <code>vb…</code> constants, sheet code names (<code>Sheet1.Range…</code>), <code>[A1]</code> shortcuts, <code>Debug.Print</code>. Formatting (Interior, Font, Borders, column widths) is accepted and ignored: the app keeps its own look.</p>' +
        '<h3>Functions</h3><div class="ui-card"><div class="gd-fns">' + vbaFns.map(function (f) { return '<code>' + esc(nice(f)) + '</code>'; }).join('') + '</div></div>' +
        '<h3>What doesn\'t run</h3><ul><li>Files and folders (Open, Print #, Kill, Dir), and other programs (Shell, Outlook, Word, CreateObject other than Scripting.Dictionary). A web page can\'t reach them.</li><li>Windows API calls (Declare), class modules and UserForms.</li><li>Charts, shapes, pivot tables and printing from code.</li><li>Events about selecting, double-clicking, saving and closing.</li></ul>' +
        '<p class="muted">A macro that runs too long (an endless loop) is stopped, with a message. Changes a macro made before an error are kept, like in Excel.</p></section>' +
      '<section id="gd-network"><h2>' + UI.icon('wifi') + 'Run it on a network</h2><ol>' +
        '<li><b>Pick the computer that shares the app.</b> Any Windows PC, Mac, Linux box or Raspberry Pi that stays on while people work. It needs Python 3.8 or newer: free from <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">python.org</a> (tick "Add python.exe to PATH" on Windows). Macs and Linux usually have it.</li>' +
        '<li><b>Unzip the download</b> there and double-click <code>Start (Windows).bat</code> or <code>start.command</code> (Mac), or run <code>python3 server.py</code>.</li>' +
        '<li><b>Open the address</b> it prints, like <code>http://192.168.1.20:8080</code>, on every phone, tablet and computer on the same Wi-Fi. On phones, "Add to Home Screen" makes it open like an app.</li></ol>' +
        '<div class="gd-term">python3 server.py --port 9000     another port\npython3 server.py --pin 4821     ask for a PIN first\npython3 server.py --reset        start over with the workbook\'s data (keeps a backup)</div>' +
        '<p><b>It doesn\'t open on my phone.</b> Check the phone is on the same Wi-Fi (not mobile data or a guest network), and that the computer\'s firewall lets Python accept connections on private networks (Windows asks the first time). Office networks sometimes block devices from talking to each other; ask whoever runs the network.</p>' +
        '<p><b>Updating the app.</b> Change it in Sheetsmith, download again, and replace <code>index.html</code> and <code>server.py</code>. Keep the <code>data</code> folder: your data stays. New tables are added; existing rows are kept.</p>' +
        '<p><b>Keeping it running.</b> Leave the window open, or start it when the computer starts (Task Scheduler on Windows, a login item on Mac, a systemd service or cron <code>@reboot</code> on Linux).</p></section>' +
      '<section id="gd-limits"><h2>' + UI.icon('shield') + 'Limits &amp; privacy</h2><ul>' +
        '<li>Workbooks up to 12 MB; up to 3,000 rows and 100 columns per sheet, and 40,000 cells in all, are read.</li>' +
        '<li>Old .xls files: open them in Excel and save as .xlsm first.</li>' +
        '<li>Trying Sheetsmith without an account: the workbook is read and set aside, nothing is kept. Saved projects keep the workbook in your account until you delete them.</li>' +
        '<li>The app you download is yours: it runs on your computers, its data stays there, and it never calls Sheetsmith or anyone else.</li></ul>' +
        '<p class="muted">Found a workbook Sheetsmith reads wrongly? <a href="#" data-feedback="bug">Tell us</a>, ideally with a copy that has no private data in it.</p></section>' +
      '</div></div></div>';
    var sec = ctx.args[0];
    view.addEventListener('click', function (e) {
      var a = e.target.closest('[data-sec]');
      if (!a) return;
      e.preventDefault();
      var el = view.querySelector('#gd-' + a.getAttribute('data-sec'));
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      history.replaceState(null, '', '#guide/' + a.getAttribute('data-sec'));
    });
    if (sec) setTimeout(function () { var el = view.querySelector('#gd-' + sec); if (el) el.scrollIntoView(); }, 50);
  });
})();

/* ===== home.html ===== */
(function () {
  var esc = UI.esc;
  UI.page('home', { title: 'Your projects', nav: 'Projects', icon: 'grid', auth: 'user', order: 10 }, function (view, ctx) {
    view.innerHTML = '<div class="ui-wrap"><div class="ui-skel" style="height:110px"></div><div class="ui-skel" style="height:220px;margin-top:20px"></div></div>';
    function draw(d) {
      var first = ctx.me.name.split(' ')[0];
      view.innerHTML = '<div class="ui-wrap"><div class="hm-head"><div><div class="eyebrow">Sheetsmith</div><h1>' + (d.mine.length ? 'Your projects' : 'Hello, ' + esc(first)) + '</h1>' +
        '<p class="muted" style="margin:6px 0 0">' + (d.mine.length ? UI.plural(d.mine.length, 'workbook') + ' turned into apps.' : 'Drop in a workbook to start your first app.') + '</p></div>' +
        '<a class="ui-btn ghost" href="#guide" data-go="guide">' + UI.icon('info') + 'What converts?</a></div>' +
        SS.dropHtml('Drop a workbook here', '.xlsx or .xlsm, with its tables, rules and VBA macros. Up to 12 MB.') +
        (d.mine.length ? '<div class="hm-section"><div class="ss-pcards">' + d.mine.map(SS.card).join('') + '</div></div>' : '') +
        (d.examples.length ? '<div class="hm-section"><h2>' + UI.icon('sparkle') + 'Examples to explore</h2><p class="muted">Made-up workbooks with tables, rules and macros. Open one to see what Sheetsmith does, or copy it to play with.</p>' +
          '<div class="ss-pcards">' + d.examples.map(SS.card).join('') + '</div></div>' : '') + '</div>';
      SS.dropzone(view.querySelector('[data-drop]'), function (file) {
        var busy = SS.reading(file.name);
        UI.upload('upload_workbook', file).then(function (r) { busy.close(); UI.toast('Read ' + file.name, 'ok'); UI.go('project', r.id); },
          function (e) { busy.close(); UI.toast(e.message, 'error'); });
      });
    }
    return UI.api('get_projects').then(draw);
  });
})();

/* ===== landing.html ===== */
(function () {
  var COPY = {
    eyebrow: 'Excel workbook → web app',
    title: 'Your workbook, <em>forged into an app</em> your whole team can use',
    lead: 'Drop in an Excel file with its tables, rules and VBA macros. Sheetsmith turns it into a web app and a tiny Python server that runs on any computer on your network, so phones, tablets and laptops all share the same live data.',
    proof: ['Nothing to install for your team', 'Runs on your own network', 'Your data stays with you'],
    steps: [['Drop in your workbook', 'Sheetsmith reads every sheet: tables, formulas, dropdowns and checks, conditional colours, buttons and the VBA behind them.'],
            ['Shape the app', 'Rename screens, pick columns and types, choose which macros become buttons. Preview the real app as a phone or a laptop.'],
            ['Run it on your network', 'Download a zip, double-click the start file, and open the address it shows on every device on your Wi-Fi.']],
    features: [['table', 'Tables become apps', 'Search, filter chips, sorting, cards on phones and a form for every row, with totals rows and calculated columns.'],
               ['calc', 'Formulas keep working', 'More than ' + (window.SE ? Math.floor(SE.FUNCTIONS.length / 10) * 10 : 160) + ' Excel functions calculate live: XLOOKUP, SUMIFS, INDEX/MATCH, dates, text and table references.'],
               ['shield', 'Rules stay rules', 'Dropdown lists, number and date limits and custom checks, with the error messages you wrote in Excel.'],
               ['sparkle', 'Same colours', 'Conditional formats colour rows, cards and chips just like the sheet: late orders red, ready ones green.'],
               ['bolt', 'Macros that really run', 'Buttons run your VBA in the browser: Range, Cells, ListObjects, loops, MsgBox, InputBox, Dictionary, events.'],
               ['edit', 'Forms and calculators', 'Sheets with labels and input cells become forms, with the results updating as people type.'],
               ['users', 'Shared and live', 'Everyone on the network sees changes within seconds. The activity list shows who changed what.'],
               ['download', 'Back to Excel any time', 'One click exports the current data as an .xlsx with its tables and formulas.']],
    notYet: ['Charts', 'Pivot tables', 'UserForms', 'Macros that use files, Outlook or Windows'],
    faq: [['Does my team need to install anything?', 'No. Only the computer that shares the app needs Python (free, and already on Macs and Linux). Everyone else just opens an address in their browser.'],
          ['Is my workbook stored?', 'When you try Sheetsmith without an account, the file is read and set aside: nothing is kept. When you save a project, the workbook is stored in your account so you can change the app later. You can delete it any time.'],
          ['Does the app need the internet?', 'No. Once downloaded it runs entirely on your network: the server, the formulas and the macros all run on your own computers.'],
          ['Which VBA works?', 'The everyday kind: subs and functions, If/Select/For/Do, Range, Cells, worksheets, tables (ListObjects), MsgBox and InputBox, Dictionary, string and date functions, WorksheetFunction, and the Worksheet_Change event. The Macros tab checks every procedure and tells you exactly what would not run.'],
          ['Can several people change things at once?', 'Yes. Each change is sent to the server and everyone else sees it within a few seconds. Rows are kept separately, so two people adding orders at the same time don\'t overwrite each other.'],
          ['How big can the workbook be?', 'Up to 12 MB, with up to 3,000 rows per sheet. That covers most workbooks people use as apps; bigger data is better off in a real database.'],
          ['Is it secure?', 'The app is meant for networks you trust (home, office, shop). Anyone on the network can open it unless you set a PIN. It never sends your data anywhere.']]
  };

  function heroArt() {
    return '<div class="lp-art" aria-hidden="true">' +
      '<div class="lp-sheet"><div class="bar"><i></i><i></i><i></i><span class="fx">=[@Qty]*[@[Unit price]]</span></div><div class="lp-grid">' +
        '<span class="h"></span><span class="h">A</span><span class="h">B</span><span class="h">C</span><span class="h x">D</span>' +
        '<span class="h">1</span><span class="th">Customer</span><span class="th">Qty</span><span class="th">Total</span><span class="th x">Status</span>' +
        '<span class="h">2</span><span>Café Lumen</span><span class="num">24</span><span class="num sel">$114.00</span><span class="x late">Baking</span>' +
        '<span class="h">3</span><span>Priya N.</span><span class="num">6</span><span class="num">$39.00</span><span class="x ok">Ready</span>' +
        '<span class="h">4</span><span>Studio Nine</span><span class="num">4</span><span class="num">$48.00</span><span class="x ok">Ready</span>' +
        '<span class="h">5</span><span>Olivier G.</span><span class="num">2</span><span class="num">$17.50</span><span class="x">New</span>' +
        '<span class="h">6</span><span></span><span></span><span></span><span class="x"></span></div></div>' +
      '<div class="lp-vba"><span class="k">Sub</span> MarkBakingReady()<br>&nbsp; <span class="k">For</span> i = 1 <span class="k">To</span> tbl.ListRows.Count<br>&nbsp;&nbsp;&nbsp; ...<br>&nbsp; MsgBox n &amp; <span class="s">" ready!"</span><br><span class="k">End Sub</span></div>' +
      '<div class="lp-arrow">' + UI.icon('arrow') + '</div>' +
      '<div class="lp-phone"><div class="lp-screen"><div class="appbar"><b>JB</b>Orders</div><div class="chips"><span>All 13</span><span>Ready 2</span><span>Baking 3</span></div>' +
        '<div class="lp-row r1"><b>Priya Natarajan <i>Ready</i></b><small>Lemon tart · 6 · $39.00</small></div>' +
        '<div class="lp-row r2"><b>Café Lumen <i>Late</i></b><small>Almond croissant · 24</small></div>' +
        '<div class="lp-row r3"><b>Daniel Roy <i>Baking</i></b><small>Birthday cake · 1</small></div>' +
        '<div class="btn">⚡ Mark baking ready</div><div class="tabs"><span>Orders</span><span>Menu</span><span>Summary</span><span>More</span></div></div></div>' +
      '<div class="lp-wifi">' + UI.icon('wifi') + 'http://192.168.1.20:8080</div></div>';
  }

  UI.page('landing', { title: 'Turn a workbook into an app' }, function (view, ctx) {
    var me = ctx.me, C = COPY, esc = UI.esc;
    view.innerHTML =
      '<section class="lp-hero"><div class="ui-wrap"><div>' +
        '<div class="eyebrow">' + esc(C.eyebrow) + '</div><h1>' + C.title + '</h1><p class="lp-lead">' + esc(C.lead) + '</p>' +
        '<div class="lp-cta">' + SS.dropHtml(me ? 'Drop a workbook to start' : 'Try it now: drop a workbook', me ? '.xlsx or .xlsm, up to 12 MB.' : 'No account needed. The file is read, not kept.') +
        '<div class="alt">' + (me ? '<a class="ui-btn" href="#home" data-go="home">' + UI.icon('grid') + 'Your projects</a>' : '<a class="ui-btn" href="#auth/signup" data-go="auth/signup">Create a free account</a>') +
        '<span>or open an example below</span></div></div>' +
        '<div class="lp-proof">' + C.proof.map(function (p) { return '<span>' + UI.icon('check') + esc(p) + '</span>'; }).join('') + '</div>' +
      '</div>' + heroArt() + '</div></section>' +
      '<section class="lp-section" id="examples"><div class="ui-wrap"><div class="lp-head"><h2>Open an example</h2><p>Three made-up workbooks, each with tables, rules and macros. See what they become.</p></div><div class="ss-pcards" data-examples><div class="ui-skel"></div><div class="ui-skel"></div><div class="ui-skel"></div></div></div></section>' +
      '<section class="lp-section" id="how"><div class="ui-wrap"><div class="lp-head"><h2>How it works</h2><p>From a workbook on your desktop to an app on every phone in the building, in a few minutes.</p></div>' +
        '<div class="lp-steps">' + C.steps.map(function (s) { return '<div class="ui-card lp-step"><h3>' + esc(s[0]) + '</h3><p class="muted">' + esc(s[1]) + '</p></div>'; }).join('') + '</div></div></section>' +
      '<section class="lp-section"><div class="ui-wrap"><div class="lp-head"><h2>What comes across</h2><p>The parts of a workbook that make it an app, not just a table.</p></div>' +
        '<div class="lp-feats">' + C.features.map(function (f) { return '<div class="ui-card lp-feat">' + UI.icon(f[0]) + '<h3>' + esc(f[1]) + '</h3><p>' + esc(f[2]) + '</p></div>'; }).join('') + '</div>' +
        '<div class="lp-not"><b>Not yet:</b>' + C.notYet.map(function (n) { return '<span class="ui-badge">' + esc(n) + '</span>'; }).join('') + '<a href="#guide" data-go="guide">The full list</a></div></div></section>' +
      '<section class="lp-section"><div class="ui-wrap lp-server"><div><div class="eyebrow">server.py</div><h2>A server the size of a file</h2><p class="muted" style="font-size:1.06rem">The download is a folder with your app and one Python file. No database to set up, no cloud account, no monthly bill. Leave it running on an office PC, a Mac mini or a Raspberry Pi.</p>' +
        '<div class="lp-list">' + [['database', 'Saves everything in SQLite', 'One file, with a backup every day. Copy the folder to move it.'], ['clock', 'Knows who changed what', 'An activity list for the whole team, with names.'], ['lock', 'Optional PIN', 'Keep the app to the people who know the code.'], ['phone', 'Add to home screen', 'On phones it opens full screen, like an app.']]
          .map(function (x) { return '<div>' + UI.icon(x[0]) + '<div><b>' + esc(x[1]) + '</b><span>' + esc(x[2]) + '</span></div></div>'; }).join('') + '</div></div>' +
        '<div class="lp-term"><span class="g">C:\\Apps\\juniper-bakery&gt;</span> python server.py\n\n  Juniper Bakery order book is running.\n    On this computer:   http://localhost:8080/\n    On your network:    <span class="a">http://192.168.1.20:8080/</span>\n                        &lt;- open this on phones\n  Data is saved in data/app.db.\n  Press Ctrl+C to stop.</div></div></section>' +
      '<section class="lp-section"><div class="ui-wrap"><div class="lp-head"><h2>Questions</h2></div><div class="lp-faq">' +
        C.faq.map(function (q) { return '<details><summary>' + esc(q[0]) + '</summary><p>' + esc(q[1]) + '</p></details>'; }).join('') + '</div></div></section>' +
      '<section class="lp-section"><div class="ui-wrap"><div class="lp-band"><div><h2>Got a workbook that runs your day?</h2><p>Give it a proper home on every screen.</p></div>' +
        (me ? '<a class="ui-btn lg accent" href="#home" data-go="home">Open your projects</a>' : '<a class="ui-btn lg accent" href="#auth/signup" data-go="auth/signup">Start free</a>') +
      '</div></div></section>';
    SS.dropzone(view.querySelector('[data-drop]'), function (file) {
      var busy = SS.reading(file.name);
      var p = me ? UI.upload('upload_workbook', file).then(function (r) { busy.close(); UI.go('project', r.id); })
        : UI.upload('inspect_workbook', file).then(function (r) { busy.close(); SS.draft = { blueprint: r.blueprint, file: file, settings: {} }; UI.go('project', 'draft'); });
      p.catch(function (e) { busy.close(); UI.toast(e.message, 'error'); });
    });
    return UI.apiQuiet('get_projects').then(function (d) {
      var box = view.querySelector('[data-examples]');
      box.innerHTML = d.examples.length ? d.examples.map(SS.card).join('') : '<p class="muted">No examples right now.</p>';
    });
  });
})();

/* ===== profile.html ===== */
(function () {
  var esc = UI.esc;
  UI.page('profile', { title: 'Your profile', auth: 'user' }, function (view, ctx) {
    var me = ctx.me;
    view.innerHTML = '<div class="ui-wrap ui-narrow"><div class="pf-head"><span class="ui-avatar">' + esc(UI.initials(me.name)) + '</span>' +
      '<div><h1>' + esc(me.name) + '</h1><div class="muted">' + esc(me.email) + (me.joined ? ' · member since ' + esc(UI.fmtDate(me.joined, { month: 'long', year: 'numeric' })) : '') + '</div></div></div>' +
      '<div class="pf-grid"><form class="ui-card ui-stack" data-name><h3>Your name</h3><label class="ui-field"><span>Shown to other people</span>' +
      '<input type="text" name="name" value="' + esc(me.name) + '" maxlength="60" required></label><button class="ui-btn primary" type="submit">Save</button></form>' +
      '<div class="ui-card ui-stack"><h3>Appearance</h3><p class="muted small">Follow your device, or pick one.</p><div data-theme-box></div>' +
      '<h3 style="margin-top:22px">Password</h3><p class="muted small">We\'ll email you a link to choose a new one.</p>' +
      '<button class="ui-btn" data-reset>' + UI.icon('mail') + 'Email me a reset link</button></div></div>' +
      '<div class="ui-card" style="margin-top:16px"><div class="pf-links">' +
      (me.is_admin ? '<a href="#admin" data-go="admin">' + UI.icon('shield') + 'Admin</a>' : '') +
      '<button data-feedback>' + UI.icon('chat') + 'Send feedback</button>' +
      '<button data-lk-open="overview">' + UI.icon('lock') + 'Privacy &amp; Terms, and your data</button>' +
      '<button data-signout-here>' + UI.icon('logout') + 'Sign out</button></div></div></div>';
    function themeBox() {
      var t = UI.theme();
      view.querySelector('[data-theme-box]').innerHTML = '<div class="ui-seg">' + [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(function (o) {
        return '<button type="button" data-theme-pick="' + o[0] + '" class="' + (t === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>';
    }
    themeBox();
    view.addEventListener('click', function (e) {
      var t = e.target.closest('[data-theme-pick]');
      if (t) { UI.setTheme(t.getAttribute('data-theme-pick')); themeBox(); UI.renderChrome(); return; }
      if (e.target.closest('[data-reset]')) {
        UI.busy(e.target.closest('[data-reset]'), UI.auth('reset', { email: me.email })).then(function (r) { UI.toast(r.message, 'ok'); });
      }
      if (e.target.closest('[data-signout-here]')) UI.auth('logout');
    });
    view.querySelector('[data-name]').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = UI.formData(e.target);
      UI.busy(e.target.querySelector('[type=submit]'), UI.api('update_profile', v.name)).then(function (r) {
        UI.setMe(r.me); ctx.me = r.me; UI.toast('Saved', 'ok');
        view.querySelector('.pf-head h1').textContent = r.me.name;
      });
    });
  });
})();

/* ===== project.html ===== */
(function () {
  var esc = UI.esc;
  var TABS = [['overview', 'Overview', 'grid'], ['screens', 'Screens', 'table'], ['rules', 'Rules', 'shield'], ['macros', 'Macros', 'bolt'], ['preview', 'Preview', 'play'], ['get', 'Get the app', 'download']];
  var KEYWORDS = /\b(Sub|Function|End|If|Then|Else|ElseIf|For|Each|Next|To|Step|Do|Loop|While|Wend|Until|Dim|As|Set|Let|Call|With|Select|Case|Is|Not|And|Or|Xor|Mod|New|Nothing|True|False|Exit|On|Error|Resume|GoTo|Private|Public|Const|Option|Explicit|ByVal|ByRef|Optional|ReDim|Preserve|Long|Integer|String|Double|Boolean|Date|Variant|Object|Range|Worksheet|Workbook|ListObject|ListRow|Me|In|Like|Property|Get|Static|Enum|Type)\b/g;

  function hiLine(line) {
    var code = line, comment = '';
    var inStr = false;
    for (var i = 0; i < line.length; i++) { if (line[i] === '"') inStr = !inStr; if (line[i] === "'" && !inStr) { code = line.slice(0, i); comment = line.slice(i); break; } }
    var out = '', parts = code.split(/("(?:[^"]|"")*")/);
    parts.forEach(function (p, k) {
      if (k % 2) { out += '<span class="s">' + esc(p) + '</span>'; return; }
      out += esc(p).replace(KEYWORDS, '<span class="k">$1</span>').replace(/\b(\d+(\.\d+)?)\b/g, '<span class="n">$1</span>');
    });
    return out + (comment ? '<span class="c">' + esc(comment) + '</span>' : '');
  }
  function sw(name, on, label, attrs) {
    return '<label class="st-switch"><input type="checkbox" ' + (attrs || '') + (on ? ' checked' : '') + ' data-sw="' + esc(name) + '"><i></i>' + (label ? esc(label) : '') + '</label>';
  }
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function initials(s) { return UI.initials(s || '?'); }

  UI.page('project', { title: function () { return 'Studio'; }, auth: null }, function (view, ctx) {
    var id = ctx.args[0], tab = TABS.some(function (t) { return t[0] === ctx.args[1]; }) ? ctx.args[1] : 'overview';
    var S = { bp: null, settings: {}, project: null, mode: 'own' };
    var saveTimer = null, savedAt = null, previewTheme = 'light', previewDevice = 'desktop', openCode = {};
    view.innerHTML = '<div class="ui-wrap"><div class="ui-skel" style="height:120px"></div><div class="ui-skel" style="height:320px;margin-top:18px"></div></div>';

    function load() {
      if (id === 'draft') {
        if (!SS.draft) return Promise.reject(new Error('That try-out has ended (it lived in the browser tab). Drop the workbook again to start over.'));
        S.bp = SS.draft.blueprint; S.settings = SS.draft.settings; S.mode = 'draft';
        S.project = { name: S.bp.app.title, file_name: SS.draft.file ? SS.draft.file.name : 'workbook', can_edit: true, demo: false };
        return Promise.resolve();
      }
      return UI.api('get_project', id).then(function (d) {
        S.bp = d.blueprint; S.settings = d.settings || {}; S.project = d.project;
        S.mode = d.project.can_edit ? 'own' : (d.project.demo || d.project.example) ? 'example' : 'view';
      });
    }
    function title() { return S.settings.title || S.bp.app.title; }
    function color() { return S.settings.color || S.bp.app.color; }
    function changed(immediate) {
      if (S.mode === 'draft') { SS.draft.settings = S.settings; return; }
      if (S.mode !== 'own') return;
      clearTimeout(saveTimer);
      var el = view.querySelector('[data-saved]'); if (el) el.textContent = 'Saving…';
      saveTimer = setTimeout(function () {
        UI.apiQuiet('save_settings', S.project.id, S.settings).then(function () {
          savedAt = new Date(); var e2 = view.querySelector('[data-saved]'); if (e2) e2.textContent = 'Saved ' + savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        });
      }, immediate ? 0 : 700);
    }
    function scSet(scId, key, val) { S.settings.screens = S.settings.screens || {}; var o = S.settings.screens[scId] = S.settings.screens[scId] || {}; o[key] = val; changed(); }
    function colSet(scId, col, key, val) { S.settings.screens = S.settings.screens || {}; var o = S.settings.screens[scId] = S.settings.screens[scId] || {}; o.columns = o.columns || {}; var c = o.columns[col] = o.columns[col] || {}; c[key] = val; changed(); }
    function actSet(macro, key, val) { S.settings.actions = S.settings.actions || {}; var o = S.settings.actions[macro] = S.settings.actions[macro] || {}; o[key] = val; changed(); }

    function draw() {
      document.title = title() + ' · Studio · Sheetsmith';
      var p = S.project, bp = S.bp;
      var banner = '';
      if (S.mode === 'draft') banner = UI.me
        ? '<div class="st-banner">' + UI.icon('info') + '<p><b>Not saved yet.</b> Keep this project to come back to it, change it later and download new versions.</p><button class="ui-btn primary" data-savedraft>' + UI.icon('check') + 'Save this project</button></div>'
        : '<div class="st-banner">' + UI.icon('info') + '<p><b>You\'re trying Sheetsmith.</b> Nothing is stored: the workbook was read and set aside. Change anything, preview it and download it; sign up to keep the project.</p><button class="ui-btn primary" data-signup>Sign up to keep it</button></div>';
      else if (S.mode === 'example') banner = '<div class="st-banner">' + UI.icon('sparkle') + '<p><b>This is an example workbook</b> (made up). Try anything: your changes stay in this tab. Make your own copy to keep them.</p><button class="ui-btn primary" data-copy>' + UI.icon('copy') + 'Make my copy</button></div>';
      view.innerHTML = '<div class="ui-wrap">' +
        '<a class="st-back" href="#' + (UI.me ? 'home' : 'landing') + '" data-go="' + (UI.me ? 'home' : 'landing') + '">' + UI.icon('back') + (UI.me ? 'Your projects' : 'Sheetsmith') + '</a>' +
        '<div class="st-top"><div class="grow st-title"><span class="st-mark" style="background:' + esc(color()) + '">' + esc(initials(title())) + '</span><div><h1>' + esc(title()) + '</h1>' +
        '<p>' + UI.icon('grid') + ' ' + esc(p.file_name || (bp.file && bp.file.name) || '') + (bp.file && bp.file.size ? ' · ' + fmtSize(bp.file.size) : '') + (S.mode === 'own' ? ' · <span class="st-saved" data-saved>' + (S.project.updated ? 'Saved' : '') + '</span>' : '') + '</p></div></div>' +
        '<div class="ui-row">' + (S.mode === 'own' ? '<button class="ui-btn ghost" data-more aria-label="More">' + UI.icon('more') + '</button>' : '') +
        '<button class="ui-btn" data-tab="preview">' + UI.icon('play') + 'Preview</button><button class="ui-btn primary" data-tab="get">' + UI.icon('download') + 'Get the app</button></div></div>' +
        banner + '<nav class="ui-tabs st-tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' + UI.icon(t[2]) + t[1] + '</button>'; }).join('') + '</nav>' +
        '<div data-body></div></div>';
      body();
    }
    function body() {
      var b = view.querySelector('[data-body]');
      view.querySelectorAll('.st-tabs [data-tab]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tab') === tab); });
      ({ overview: overview, screens: screens, rules: rules, macros: macros, preview: preview, get: getApp })[tab](b);
    }

    /* ---------------------------------------------------------------- overview */
    function overview(b) {
      var bp = S.bp, st = bp.stats || {}, an = SS.analysis(bp), scs = SS.screens(bp, S.settings);
      var vis = scs.filter(function (s) { return !s.hidden; });
      var stat = function (n, label, note, kind) { return '<div class="ui-card st-stat ' + (kind || '') + '"><b>' + n + '</b><span>' + label + '</span>' + (note ? '<small>' + note + '</small>' : '') + '</div>'; };
      var notes = [];
      Object.keys(an.formulas.unknown).forEach(function (fn) { var u = an.formulas.unknown[fn]; notes.push(['warn', '<b>' + esc(fn) + '</b> isn\'t supported yet (' + UI.plural(u.n, 'formula') + ', e.g. ' + esc(u.where) + '). Those cells show #NAME? in the app.']); });
      an.formulas.broken.slice(0, 3).forEach(function (x) { notes.push(['warn', 'A formula in ' + esc(x.where) + ' couldn\'t be read: ' + esc(x.error)]); });
      an.vba.procs.filter(function (p) { return p.status === 'no'; }).slice(0, 6).forEach(function (p) { notes.push(['warn', '<code>' + esc(p.name) + '</code> can\'t run in the app: ' + esc((p.issues[0] || {}).text || '')]); });
      (bp.warnings || []).forEach(function (w) { notes.push(['info', esc(w)]); });
      if (!notes.length) notes.push(['good', 'Everything Sheetsmith found can come across. Have a look in Preview.']);
      var macroNote = an.vba.procs.length ? an.vba.ok + ' of ' + an.vba.procs.length + ' run as they are' : 'no macros';
      b.innerHTML = '<div class="st-stats">' +
        stat(st.sheets || bp.sheets.length, 'sheets', vis.length + ' screens in the app') +
        stat((st.tables || 0) + (st.lists || 0), 'tables & lists', UI.plural(st.rows || 0, 'row') + ' of data') +
        stat(an.formulas.total, 'formulas', an.formulas.total ? an.formulas.okPct + '% supported' : 'none', an.formulas.okPct === 100 ? 'good' : 'warn') +
        stat((st.rules || 0) + (st.formats || 0), 'rules & colours', (st.rules || 0) + ' checks, ' + (st.formats || 0) + ' colour rules') +
        stat(an.vba.procs.length, 'macros', macroNote, an.vba.procs.length && an.vba.score === 100 ? 'good' : an.vba.procs.length ? 'warn' : '') +
        '</div><div class="st-two"><div><h3>Screens in your app</h3><div class="st-screens">' + scs.map(function (sc) {
          var extra = sc.kind === 'table' ? UI.plural((sc.columns || []).length, 'column') + ' · ' + UI.plural(sc.rows || 0, 'row') : sc.kind === 'form' ? UI.plural(((sc.form || {}).items || []).filter(function (i) { return i.t === 'field'; }).length, 'field') : 'the sheet as cells';
          return '<div class="ui-card st-sc' + (sc.hidden ? ' off' : '') + '"><span class="ic-box">' + UI.icon(sc.icon) + '</span><div class="grow"><b>' + esc(sc.label) + '</b><span>' + SS.kindLabel(sc) + ' · ' + extra + '</span></div>' +
            (sc.hidden ? '<span class="ui-badge">Hidden</span>' : '<span class="ui-badge good">' + UI.icon('check') + 'Shown</span>') + '</div>';
        }).join('') + '</div><p class="muted small" style="margin-top:12px">Rename, reorder, hide or adjust columns in <a href="#" data-tab="screens">Screens</a>.</p></div>' +
        '<div><h3>Good to know</h3><div class="st-notes">' + notes.slice(0, 12).map(function (n) {
          return '<div class="st-note ' + (n[0] === 'good' ? 'good' : '') + '">' + UI.icon(n[0] === 'good' ? 'check' : n[0] === 'info' ? 'info' : 'bug') + '<div>' + n[1] + '</div></div>';
        }).join('') + '</div>' +
        '<div class="ui-card" style="margin-top:16px"><h3 style="margin-top:0">What happens next</h3><p class="muted">Preview the app here, then download a zip with <code>index.html</code> and <code>server.py</code>. Run it on any computer with Python and open it from every phone and laptop on the same network.</p>' +
        '<div class="ui-row"><button class="ui-btn" data-tab="preview">' + UI.icon('play') + 'Preview</button><button class="ui-btn primary" data-tab="get">' + UI.icon('download') + 'Get the app</button></div></div></div></div>';
    }

    /* ---------------------------------------------------------------- screens */
    function screens(b) {
      var scs = SS.screens(S.bp, S.settings), ro = S.mode === 'view';
      b.innerHTML = '<p class="muted" style="margin-top:0">Each sheet became one or more screens. Rename them, change their order and icons, hide the ones people don\'t need, and choose how each column shows. Hidden screens still feed formulas and dropdowns.</p>' +
        scs.map(function (sc, i) {
          var head = '<div class="st-edit-h"><div class="st-move"><button data-move="-1" data-sc="' + esc(sc.id) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">' + UI.icon('up') + '</button>' +
            '<button data-move="1" data-sc="' + esc(sc.id) + '"' + (i === scs.length - 1 ? ' disabled' : '') + ' aria-label="Move down">' + UI.icon('chevron') + '</button></div>' +
            '<button class="st-iconbtn" data-pickicon="' + esc(sc.id) + '" aria-label="Icon">' + UI.icon(sc.icon) + '</button>' +
            '<input type="text" value="' + esc(sc.label) + '" data-sclabel="' + esc(sc.id) + '" maxlength="40" aria-label="Screen name"' + (ro ? ' disabled' : '') + '>' +
            '<span class="ui-badge brand">' + SS.kindLabel(sc) + '</span><span class="muted small mono">' + esc(sc.sheet) + (sc.table ? ' › ' + esc(sc.table) : '') + '</span><span class="grow"></span>' +
            sw('show:' + sc.id, !sc.hidden, 'Show in the app') + '</div>';
          var inner = '';
          if (sc.kind === 'table') {
            var colNames = sc.columns.map(function (c) { return c.name; });
            inner = '<div class="ui-row" style="margin-bottom:10px"><label class="small muted">Card title <select data-titlecol="' + esc(sc.id) + '" style="width:auto;min-height:36px;padding:5px 9px">' + colNames.map(function (n) { return '<option' + (n === sc.titleCol ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></label>' +
              '<label class="small muted">Status chips <select data-statuscol="' + esc(sc.id) + '" style="width:auto;min-height:36px;padding:5px 9px"><option value="">(none)</option>' + colNames.map(function (n) { return '<option' + (n === sc.statusCol ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></label></div>' +
              '<table class="st-cols"><thead><tr><th>Column</th><th>Shown as</th><th>Type</th><th>Show</th></tr></thead><tbody>' + sc.columns.map(function (c) {
                return '<tr><td class="src">' + esc(c.name) + '</td><td><input type="text" value="' + esc(c.label || c.name) + '" data-collabel="' + esc(sc.id) + '|' + esc(c.name) + '" maxlength="40"></td>' +
                  '<td><select data-coltype="' + esc(sc.id) + '|' + esc(c.name) + '"' + (c.type === 'formula' ? ' disabled' : '') + '>' + SS.TYPES.filter(function (t) { return c.type === 'formula' ? t[0] === 'formula' : t[0] !== 'formula'; }).map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === c.type ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></td>' +
                  '<td>' + sw('col:' + sc.id + '|' + c.name, !c.hidden, '') + '</td></tr>';
              }).join('') + '</tbody></table>';
          } else if (sc.kind === 'form') {
            var items = (sc.form && sc.form.items) || [];
            inner = '<table class="st-table"><thead><tr><th>Field</th><th>Cell</th><th>Kind</th></tr></thead><tbody>' + items.filter(function (it) { return it.t === 'field'; }).map(function (it) {
              return '<tr><td>' + esc(it.label) + '</td><td class="mono">' + esc(it.ref) + '</td><td>' + (it.kind === 'input' ? '<span class="ui-badge brand">' + UI.icon('edit') + 'People fill it in</span>' : '<span class="ui-badge">' + UI.icon('sparkle') + 'Calculated</span>') + '</td></tr>';
            }).join('') + '</tbody></table>';
          } else inner = '<p class="muted" style="margin:0">Shows <b>' + esc(sc.sheet) + '</b> as cells, like the sheet itself. People can type into cells that aren\'t formulas; the workbook\'s rules still apply.</p>';
          return '<div class="ui-card st-edit" data-scard="' + esc(sc.id) + '">' + head + '<div class="st-edit-b">' + inner + '</div></div>';
        }).join('');
      if (ro) b.querySelectorAll('input,select,button').forEach(function (x) { x.disabled = true; });
    }

    /* ---------------------------------------------------------------- rules */
    function rules(b) {
      var bp = S.bp, an = SS.analysis(bp), rows = [], cfRows = [];
      bp.sheets.forEach(function (s) {
        (s.validations || []).forEach(function (v) {
          rows.push('<tr><td>' + esc(s.name) + '</td><td class="mono">' + esc(v.sqref.join(' ')) + '</td><td>' + esc(SE.describeRule(v)) + (v.prompt ? '<div class="muted small">Hint: ' + esc(v.prompt) + '</div>' : '') + '</td><td>' + esc(v.error || (v.errorStyle === 'stop' ? 'Excel\'s standard message' : '')) + (v.errorStyle && v.errorStyle !== 'stop' ? ' <span class="ui-badge accent">' + (v.errorStyle === 'warning' ? 'Warning only' : 'Information') + '</span>' : '') + '</td></tr>');
        });
        (s.condFormats || []).forEach(function (cf) {
          cf.rules.forEach(function (r) {
            var st = r.style || {}, when = r.type === 'expression' ? 'when =' + r.formulas[0] : r.type === 'cellIs' ? 'when the value is ' + ({ equal: '=', notEqual: '≠', greaterThan: '>', lessThan: '<', greaterThanOrEqual: '≥', lessThanOrEqual: '≤', between: 'between', notBetween: 'not between' }[r.op] || r.op) + ' ' + r.formulas.join(' and ') : r.type === 'colorScale' ? 'colour scale' : r.type === 'dataBar' ? 'data bars' : r.type.replace(/([A-Z])/g, ' $1').toLowerCase() + (r.text ? ' "' + r.text + '"' : '');
            var swatch = r.type === 'colorScale' ? '<span class="st-swatch" style="background:linear-gradient(90deg,' + (r.colors || []).join(',') + ')"></span>' : r.type === 'dataBar' ? '<span class="st-swatch" style="background:linear-gradient(90deg,' + ((r.colors || [])[0] || '#638EC6') + ' 60%,transparent 60%)"></span>' :
              '<span class="st-swatch" style="background:' + (st.fill || 'transparent') + ';color:' + (st.color || 'inherit') + ';' + (st.bold ? 'font-weight:800;' : '') + (st.strike ? 'text-decoration:line-through;' : '') + '">Aa</span>';
            cfRows.push('<tr><td>' + esc(s.name) + '</td><td class="mono">' + esc(cf.sqref.join(' ')) + '</td><td>' + esc(when) + '</td><td>' + swatch + '</td></tr>');
          });
        });
      });
      var fns = Object.keys(an.formulas.functions).sort(function (a, b) { return an.formulas.functions[b] - an.formulas.functions[a]; });
      var udfs = {}; an.vba.procs.forEach(function (p) { if (p.udf) udfs[p.name.toUpperCase()] = 1; });
      b.innerHTML = '<div class="ui-card" style="margin-bottom:18px"><h3 style="margin-top:0">Data validation <span class="ui-badge">' + rows.length + '</span></h3>' +
        (rows.length ? '<p class="muted">The app checks these when people type, with the workbook\'s own messages. Dropdown lists become choice fields.</p><div style="overflow-x:auto"><table class="st-table"><thead><tr><th>Sheet</th><th>Cells</th><th>Rule</th><th>Message</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' : '<p class="muted">No data validation rules in this workbook.</p>') + '</div>' +
        '<div class="ui-card" style="margin-bottom:18px"><h3 style="margin-top:0">Conditional formats <span class="ui-badge">' + cfRows.length + '</span></h3>' +
        (cfRows.length ? '<p class="muted">The same colours show up on rows, cards and cells in the app, and they follow tables as they grow.</p><div style="overflow-x:auto"><table class="st-table"><thead><tr><th>Sheet</th><th>Cells</th><th>When</th><th>Look</th></tr></thead><tbody>' + cfRows.join('') + '</tbody></table></div>' : '<p class="muted">No conditional formats in this workbook.</p>') + '</div>' +
        '<div class="ui-card" style="margin-bottom:18px"><h3 style="margin-top:0">Formulas <span class="ui-badge">' + an.formulas.total + '</span></h3><p class="muted">They calculate live in the app, in the browser, with Sheetsmith\'s formula engine (' + SE.FUNCTIONS.length + ' Excel functions).</p>' +
        (fns.length ? fns.map(function (fn) { var k = SE.FN[fn] ? '' : udfs[fn] ? 'udf' : 'no'; return '<span class="st-fn ' + k + '" title="' + (k === 'udf' ? 'A VBA Function from the workbook' : k === 'no' ? 'Not supported yet' : 'Supported') + '">' + UI.icon(k === 'no' ? 'x' : 'check') + esc(fn) + ' <span style="opacity:.6">' + an.formulas.functions[fn] + '</span></span>'; }).join('') : '<p class="muted">No functions used.</p>') +
        (an.formulas.broken.length ? '<p class="small" style="color:var(--c-bad)">' + an.formulas.broken.map(function (x) { return esc(x.where) + ': ' + esc(x.error); }).join('<br>') + '</p>' : '') + '</div>' +
        ((bp.names || []).length ? '<div class="ui-card"><h3 style="margin-top:0">Named ranges <span class="ui-badge">' + bp.names.length + '</span></h3><table class="st-table"><tbody>' + bp.names.map(function (n) { return '<tr><td class="mono">' + esc(n.name) + '</td><td class="mono">' + esc(n.ref) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '');
    }

    /* ---------------------------------------------------------------- macros */
    function macros(b) {
      var bp = S.bp, an = SS.analysis(bp), acts = SS.actions(bp, S.settings), ro = S.mode === 'view';
      if (!(bp.vba || []).length) { b.innerHTML = '<div class="ui-empty">' + UI.icon('bolt') + '<h3>No macros</h3><p>This workbook has no VBA code. Save it as .xlsm with its macros to bring them along.</p></div>'; return; }
      var total = an.vba.procs.length, pOk = total ? an.vba.ok / total * 100 : 0, pPart = total ? an.vba.partial / total * 100 : 0;
      var ring = 'background:conic-gradient(var(--c-good) 0 ' + pOk + '%, var(--c-accent) ' + pOk + '% ' + (pOk + pPart) + '%, var(--c-bad) ' + (pOk + pPart) + '% 100%)';
      var byMod = {};
      an.vba.procs.forEach(function (p) { (byMod[p.module] = byMod[p.module] || []).push(p); });
      var actBy = {}; acts.forEach(function (a) { actBy[a.macro.toLowerCase()] = a; });
      var html = '<div class="ui-card st-score"><div class="st-ring" style="' + ring + '"><b>' + an.vba.score + '%</b></div><div><h3 style="margin:0 0 4px">' + an.vba.ok + ' of ' + total + ' procedures run as they are</h3>' +
        '<p class="muted" style="margin:0 0 10px">Sheetsmith runs VBA in the browser: Range, Cells, tables (ListObjects), loops, MsgBox, InputBox, Dictionary and more. What can\'t work in a web page (files, Outlook, Windows calls) is listed below.</p>' +
        '<div class="st-legend"><span><i style="background:var(--c-good)"></i>Runs (' + an.vba.ok + ')</span><span><i style="background:var(--c-accent)"></i>Partly (' + an.vba.partial + ')</span><span><i style="background:var(--c-bad)"></i>Won\'t run (' + an.vba.no + ')</span></div></div></div>';
      (bp.vba || []).forEach(function (m) {
        var procs = byMod[m.name] || [];
        if (!procs.length && !(m.code || '').trim()) return;
        var kind = m.kind === 'standard' ? 'Module' : m.kind === 'document' ? (m.sheet ? 'Sheet: ' + m.sheet : 'Workbook') : m.kind === 'form' ? 'UserForm' : 'Class module';
        html += '<div class="ui-card st-mod"><div class="st-mod-h"><h3>' + esc(m.name) + '</h3><span class="ui-badge">' + esc(kind) + '</span><span class="muted small">' + UI.plural((m.code || '').split('\n').length, 'line') + '</span><span class="ui-spacer"></span>' +
          '<button class="ui-btn sm ghost" data-code="' + esc(m.name) + '">' + UI.icon('code') + (openCode[m.name] ? 'Hide code' : 'Show code') + '</button></div>';
        procs.forEach(function (p) {
          var chip = p.status === 'ok' ? '<span class="ui-badge good">' + UI.icon('check') + 'Runs</span>' : p.status === 'partial' ? '<span class="ui-badge accent">Partly</span>' : '<span class="ui-badge bad">Won\'t run</span>';
          var macro = SS.macroName(p), a = actBy[macro.toLowerCase()] || actBy[p.name.toLowerCase()];
          var role = p.event ? 'Event: ' + (p.eventNote || p.event) : a && a.sheet ? 'Button on ' + esc(a.sheet) : p.button ? 'Macro anyone can run' : p.udf ? 'Function: works inside cell formulas' : p.kind === 'function' ? 'Function' : 'Helper (called by other code)';
          html += '<div class="st-proc"><div class="st-proc-h">' + chip + '<code>' + esc(p.name) + '</code><span class="grow">' + role + '</span>' +
            (a && p.status !== 'no' ? '<input type="text" class="lbl" value="' + esc(a.label) + '" data-actlabel="' + esc(a.macro) + '" maxlength="40" aria-label="Button label"' + (ro ? ' disabled' : '') + '>' + sw('act:' + a.macro, !a.hidden, 'Button') : '') + '</div>' +
            (p.issues.length ? '<ul>' + p.issues.map(function (i) { return '<li>Line ' + (i.line - (p.line - 1) > 0 ? i.line : i.line) + ': ' + esc(i.text) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
        });
        if (openCode[m.name]) {
          var lines = (m.code || '').split('\n'), hl = {}, inProc = {};
          procs.forEach(function (p) { p.issues.forEach(function (i) { hl[i.line] = 1; }); for (var l = p.line; l <= p.endLine; l++) if (p.status !== 'ok') inProc[l] = 1; });
          html += '<pre class="st-code">' + lines.map(function (l, k) { return '<div class="' + (hl[k + 1] ? 'hl' : inProc[k + 1] ? 'proc' : '') + '">' + (hiLine(l) || ' ') + '</div>'; }).join('') + '</pre>';
        }
        html += '</div>';
      });
      b.innerHTML = html;
    }

    /* ---------------------------------------------------------------- preview */
    function preview(b) {
      b.innerHTML = '<div class="st-prevbar"><div class="ui-seg" role="group" aria-label="Device">' + [['desktop', 'Computer'], ['phone', 'Phone']].map(function (d) { return '<button data-device="' + d[0] + '" class="' + (previewDevice === d[0] ? 'on' : '') + '">' + d[1] + '</button>'; }).join('') + '</div>' +
        '<div class="ui-seg" role="group" aria-label="Theme">' + [['light', 'Light'], ['dark', 'Dark']].map(function (d) { return '<button data-ptheme="' + d[0] + '" class="' + (previewTheme === d[0] ? 'on' : '') + '">' + d[1] + '</button>'; }).join('') + '</div>' +
        '<span class="ui-spacer"></span><span class="muted small">The real app, running in your browser. Changes here aren\'t saved.</span>' +
        '<button class="ui-btn sm" data-reload>' + UI.icon('refresh') + 'Start over</button><button class="ui-btn sm" data-newtab>' + UI.icon('external') + 'Full window</button></div>' +
        '<div class="st-stage ' + previewDevice + '">' + (previewDevice === 'phone' ? '<div class="phone"><iframe title="App preview" data-frame></iframe></div>' : '<iframe title="App preview" data-frame></iframe>') + '</div>';
      var frame = b.querySelector('[data-frame]');
      SS.previewHtml(S.bp, S.settings, previewTheme).then(function (html) { frame.srcdoc = html; }, function (e) { b.querySelector('.st-stage').innerHTML = '<div class="ui-empty">' + UI.icon('info') + '<h3>The preview didn\'t start</h3><p>' + esc(e.message) + '</p></div>'; });
    }

    /* ---------------------------------------------------------------- get the app */
    function getApp(b) {
      var bp = S.bp, st = S.settings, ro = S.mode === 'view', keep = st.keep || {};
      var tables = (bp.tables || []).map(function (t) { var n = SE.initialState({ sheets: bp.sheets.filter(function (s) { return s.name === t.sheet; }), tables: [t] }).tables[t.name]; return { name: t.name, rows: n ? n.rows.length : 0 }; });
      var cur = color().toUpperCase(), colors = [bp.app.color.toUpperCase()].concat(SS.COLORS.filter(function (c) { return c !== bp.app.color.toUpperCase(); })).slice(0, 9);
      var os = UI.store.get('os', /Mac/.test(navigator.platform) ? 'mac' : /Linux/.test(navigator.platform) ? 'linux' : 'win');
      var steps = {
        win: ['Unzip it', 'Right-click the zip > Extract All. Put the folder on the computer that will share the app.', 'Double-click "Start (Windows).bat"', 'If Windows asks whether Python may use the network, tick Private networks and click Allow. No Python yet? It opens the download page.'],
        mac: ['Unzip it', 'Double-click the zip. Keep the folder on the Mac that will share the app.', 'Double-click start.command', 'The first time, right-click it and choose Open (macOS asks before running files from the internet).'],
        linux: ['Unzip it', 'unzip the file on the computer or Raspberry Pi that will share the app.', 'Start the server', 'In a terminal, in the folder:']
      }[os];
      var prompt = os === 'win' ? '<span class="g">C:\\Apps\\' + esc(SS.slug(title())) + '&gt;</span> python server.py' : '<span class="g">$</span> python3 server.py';
      var term = '<div class="st-term">' + prompt + '\n\n  ' + esc(title()) + ' is running.\n    On this computer:   http://localhost:' + (st.port || 8080) + '/\n    On your network:    http://192.168.1.20:' + (st.port || 8080) + '/   &lt;- open this on phones\n</div>';
      b.innerHTML = '<div class="st-get"><div class="ui-card"><h3 style="margin-top:0">Your app</h3><form data-getform class="ui-stack">' +
        '<label class="ui-field"><span>Name</span><input type="text" name="title" maxlength="80" value="' + esc(title()) + '"></label>' +
        '<label class="ui-field"><span>Line under the name <em>(optional)</em></span><input type="text" name="subtitle" maxlength="80" value="' + esc(st.subtitle || '') + '" placeholder="Made from ' + esc((bp.file && bp.file.name) || 'your workbook') + '"></label>' +
        '<div class="ui-field"><span>Colour</span><div class="st-colors">' + colors.map(function (c, i) { return '<button type="button" data-color="' + c + '" class="' + (c === cur ? 'on' : '') + '" style="background:' + c + '" aria-label="' + (i === 0 ? 'The workbook\'s colour' : c) + '" title="' + (i === 0 ? 'The workbook\'s colour' : c) + '"></button>'; }).join('') +
        '<input type="color" value="' + esc(cur.toLowerCase()) + '" data-colorpick aria-label="Another colour"></div></div>' +
        '<div class="ui-field"><span>Start with</span><div class="st-keep">' + tables.map(function (t) { return sw('keep:' + t.name, keep[t.name] !== false, t.name + ': keep its ' + UI.plural(t.rows, 'row')); }).join('') + (tables.length ? '' : '<span class="muted small">No tables.</span>') + '</div></div>' +
        '<div class="ui-field"><span>Macros and events</span><div class="st-keep">' + sw('macros', st.macros !== false, 'Run the workbook\'s macros (buttons)') + sw('events', st.events !== false, 'Run Worksheet_Change and other events') + sw('readOnly', !!st.readOnly, 'View only: people can look but not change') + '</div></div>' +
        '<div class="ui-grid two" style="gap:12px"><label class="ui-field"><span>PIN <em>(optional)</em></span><input type="text" name="pin" inputmode="numeric" maxlength="12" value="' + esc(st.pin || '') + '" placeholder="No PIN"></label>' +
        '<label class="ui-field"><span>Port</span><input type="number" name="port" min="1024" max="65535" value="' + esc(st.port || 8080) + '"></label></div>' +
        '<div class="ui-row" style="margin-top:6px"><button type="button" class="ui-btn primary lg" data-download>' + UI.icon('download') + 'Download the app (.zip)</button><button type="button" class="ui-btn" data-htmlonly>' + UI.icon('globe') + 'Just index.html</button></div>' +
        '<p class="ui-hint">Free, no account needed for the app itself. It runs offline on your network: nothing calls home.</p></form></div>' +
        '<div class="ui-card"><h3 style="margin-top:0">Run it on your network</h3><div class="ui-seg" role="group" aria-label="Computer">' + [['win', 'Windows'], ['mac', 'Mac'], ['linux', 'Linux / Pi']].map(function (o) { return '<button data-os="' + o[0] + '" class="' + (os === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>' +
        '<div class="st-steps"><div><h4>' + steps[0] + '</h4><p>' + steps[1] + '</p></div><div><h4>' + steps[2] + '</h4><p>' + steps[3] + '</p>' + (os === 'linux' ? term : '') + '</div>' +
        '<div><h4>Open it everywhere</h4><p>The window shows an address like <code>http://192.168.1.20:' + esc(st.port || 8080) + '</code>. Open it on any phone, tablet or computer on the same Wi-Fi. Everyone sees the same data, live.</p></div></div>' +
        (os !== 'linux' ? term : '') + '<h4 style="margin:18px 0 6px">In the zip</h4><ul class="st-files"><li>index.html<span>the app</span></li><li>server.py<span>Python, no installs</span></li><li>Start (Windows).bat · start.command · start.sh<span>double-click</span></li><li>README.txt<span>the details</span></li></ul>' +
        '<p class="muted small" style="margin-top:12px">Data lives in <code>data/app.db</code> on that computer, with a backup every day. Export to Excel from the app any time.</p></div></div>';
      if (ro) b.querySelectorAll('[data-getform] input, [data-getform] [data-sw]').forEach(function (x) { x.disabled = true; });
    }

    function download(htmlOnly, btn) {
      var name = SS.slug(title());
      var p = (htmlOnly ? SS.html(S.bp, S.settings, null).then(function (h) { SS.save(name + '.html', new Blob([h], { type: 'text/html' })); })
        : SS.files(S.bp, S.settings).then(SS.zip).then(function (blob) { SS.save(name + '.zip', blob); }));
      UI.busy(btn, p).then(function () {
        UI.toast(htmlOnly ? 'index.html downloaded' : 'Downloaded ' + name + '.zip. Unzip it and double-click the start file.', 'ok');
        if (S.project && S.project.id) UI.apiQuiet('note_download', S.project.id);
      }, function (e) { UI.toast('The download didn\'t work: ' + e.message, 'error'); });
    }

    /* ---------------------------------------------------------------- events */
    view.addEventListener('click', function (e) {
      var t = e.target.closest('[data-tab]');
      if (t) { e.preventDefault(); tab = t.getAttribute('data-tab'); history.replaceState(null, '', '#project/' + encodeURIComponent(id) + (tab === 'overview' ? '' : '/' + tab)); body(); window.scrollTo({ top: 0 }); return; }
      if (e.target.closest('[data-signup]')) { UI.after = '#project/draft'; UI.go('auth', 'signup'); return; }
      var sd = e.target.closest('[data-savedraft]');
      if (sd) { UI.busy(sd, UI.upload('save_draft', SS.draft.file, S.settings)).then(function (r) { SS.draft = null; UI.toast('Saved to your projects', 'ok'); UI.go('project', r.id); }); return; }
      var cp = e.target.closest('[data-copy]');
      if (cp) {
        if (!UI.me) { UI.after = location.hash; UI.toast('Sign up (free) to keep your own copy.'); UI.go('auth', 'signup'); return; }
        UI.busy(cp, UI.api('copy_project', S.project.id)).then(function (r) {
          if (Object.keys(S.settings).length) UI.apiQuiet('save_settings', r.id, S.settings);
          UI.toast('Your copy is ready', 'ok'); UI.go('project', r.id);
        });
        return;
      }
      if (e.target.closest('[data-more]')) { moreMenu(); return; }
      var mv = e.target.closest('[data-move]');
      if (mv) {
        var scs = SS.screens(S.bp, S.settings), i = scs.findIndex(function (s) { return s.id === mv.getAttribute('data-sc'); }), j = i + (+mv.getAttribute('data-move'));
        if (j < 0 || j >= scs.length) return;
        var tmp = scs[i]; scs[i] = scs[j]; scs[j] = tmp;
        scs.forEach(function (s, k) { S.settings.screens = S.settings.screens || {}; (S.settings.screens[s.id] = S.settings.screens[s.id] || {}).order = k; });
        changed(); body(); return;
      }
      var pk = e.target.closest('[data-pickicon]');
      if (pk && S.mode !== 'view') {
        var scId = pk.getAttribute('data-pickicon');
        var m = UI.modal('<h2>Pick an icon</h2><div class="st-iconpick">' + SS.ICONS.map(function (n) { return '<button data-icon="' + n + '" aria-label="' + n + '">' + UI.icon(n) + '</button>'; }).join('') + '</div>');
        m.el.addEventListener('click', function (ev) { var ib = ev.target.closest('[data-icon]'); if (ib) { scSet(scId, 'icon', ib.getAttribute('data-icon')); m.close(); body(); } });
        return;
      }
      var cb = e.target.closest('[data-code]');
      if (cb) { var nm = cb.getAttribute('data-code'); openCode[nm] = !openCode[nm]; body(); return; }
      var dv = e.target.closest('[data-device]'); if (dv) { previewDevice = dv.getAttribute('data-device'); body(); return; }
      var pt = e.target.closest('[data-ptheme]'); if (pt) { previewTheme = pt.getAttribute('data-ptheme'); body(); return; }
      if (e.target.closest('[data-reload]')) { body(); return; }
      if (e.target.closest('[data-newtab]')) { SS.previewHtml(S.bp, S.settings, null).then(function (h) { var w = window.open(URL.createObjectURL(new Blob([h], { type: 'text/html' })), '_blank'); if (!w) UI.toast('Your browser blocked the new window.', 'error'); }); return; }
      var col = e.target.closest('[data-color]'); if (col && S.mode !== 'view') { S.settings.color = col.getAttribute('data-color'); changed(); draw(); return; }
      var osb = e.target.closest('[data-os]'); if (osb) { UI.store.set('os', osb.getAttribute('data-os')); body(); return; }
      var dl = e.target.closest('[data-download]'); if (dl) { download(false, dl); return; }
      var ho = e.target.closest('[data-htmlonly]'); if (ho) { download(true, ho); return; }
    });
    view.addEventListener('change', function (e) {
      var el = e.target;
      if (el.matches('[data-sw]')) {
        var k = el.getAttribute('data-sw'), on = el.checked;
        if (k.indexOf('show:') === 0) { scSet(k.slice(5), 'hidden', !on); if (tab === 'screens') { var card = el.closest('[data-scard]'); } return; }
        if (k.indexOf('col:') === 0) { var p = k.slice(4).split('|'); colSet(p[0], p.slice(1).join('|'), 'hidden', !on); return; }
        if (k.indexOf('act:') === 0) { actSet(k.slice(4), 'hidden', !on); return; }
        if (k.indexOf('keep:') === 0) { S.settings.keep = S.settings.keep || {}; S.settings.keep[k.slice(5)] = on; changed(); return; }
        if (k === 'macros' || k === 'events') { S.settings[k] = on; changed(); return; }
        if (k === 'readOnly') { S.settings.readOnly = on; changed(); return; }
      }
      if (el.matches('[data-coltype]')) { var q = el.getAttribute('data-coltype').split('|'); colSet(q[0], q.slice(1).join('|'), 'type', el.value); return; }
      if (el.matches('[data-titlecol]')) { scSet(el.getAttribute('data-titlecol'), 'titleCol', el.value); return; }
      if (el.matches('[data-statuscol]')) { scSet(el.getAttribute('data-statuscol'), 'statusCol', el.value || ''); return; }
      if (el.matches('[data-colorpick]')) { S.settings.color = el.value.toUpperCase(); changed(); draw(); return; }
      if (el.closest('[data-getform]') && el.name) {
        if (el.name === 'title') { S.settings.title = el.value.trim() || undefined; if (!S.settings.title) delete S.settings.title; changed(); draw(); return; }
        if (el.name === 'subtitle') S.settings.subtitle = el.value.trim();
        if (el.name === 'pin') S.settings.pin = el.value.replace(/\D/g, '').slice(0, 12);
        if (el.name === 'port') S.settings.port = Math.max(1024, Math.min(65535, parseInt(el.value, 10) || 8080));
        changed();
      }
    });
    view.addEventListener('input', function (e) {
      var el = e.target;
      if (el.matches('[data-sclabel]')) { scSet(el.getAttribute('data-sclabel'), 'label', el.value.trim()); return; }
      if (el.matches('[data-collabel]')) { var q = el.getAttribute('data-collabel').split('|'); colSet(q[0], q.slice(1).join('|'), 'label', el.value.trim()); return; }
      if (el.matches('[data-actlabel]')) { actSet(el.getAttribute('data-actlabel'), 'label', el.value.trim()); return; }
    });
    function moreMenu() {
      var m = UI.modal('<h2>' + esc(title()) + '</h2><div class="ui-stack">' +
        '<button class="ui-btn block" data-act="rename">' + UI.icon('edit') + 'Rename</button>' +
        '<button class="ui-btn block" data-act="reread">' + UI.icon('refresh') + 'Read the workbook again</button>' +
        '<button class="ui-btn block" data-act="reset">' + UI.icon('sliders') + 'Undo all my changes</button>' +
        '<button class="ui-btn block danger" data-act="delete">' + UI.icon('trash') + 'Delete this project</button></div>' +
        '<p class="ui-hint">"Read again" uses Sheetsmith\'s newest reader on the file you uploaded, and keeps your changes.</p>');
      m.el.addEventListener('click', function (ev) {
        var a = ev.target.closest('[data-act]'); if (!a) return;
        var what = a.getAttribute('data-act');
        if (what === 'rename') {
          m.close();
          var r = UI.modal('<h2>Rename</h2><form class="ui-stack" data-rn><label class="ui-field"><span>Name</span><input type="text" name="n" maxlength="80" value="' + esc(title()) + '" required></label><div class="ui-row end"><button type="button" class="ui-btn ghost" data-close>Cancel</button><button class="ui-btn primary">Save</button></div></form>');
          r.el.querySelector('form').addEventListener('submit', function (ev2) { ev2.preventDefault(); var n = r.el.querySelector('[name=n]').value; UI.api('rename_project', S.project.id, n).then(function (d) { S.settings.title = d.project.name; r.close(); draw(); UI.toast('Renamed', 'ok'); }); });
        }
        if (what === 'reread') UI.busy(a, UI.api('reread_project', S.project.id)).then(function (d) { S.bp = d.blueprint; m.close(); draw(); UI.toast('Read again with the newest reader', 'ok'); });
        if (what === 'reset') UI.confirm({ title: 'Undo all your changes?', text: 'Names, order, columns, buttons, colour and download options go back to what Sheetsmith found.', ok: 'Undo them', danger: true }).then(function (y) { if (y) { S.settings = {}; changed(true); m.close(); draw(); } });
        if (what === 'delete') UI.confirm({ title: 'Delete this project?', text: 'The workbook and your changes are deleted from Sheetsmith. Apps you already downloaded keep working.', ok: 'Delete', danger: true }).then(function (y) {
          if (y) UI.api('delete_project', S.project.id).then(function () { m.close(); UI.toast('Deleted'); UI.go('home'); });
        });
      });
    }
    return load().then(draw, function (e) {
      view.innerHTML = '<div class="ui-wrap"><div class="ui-empty">' + UI.icon('info') + '<h3>This project didn\'t open</h3><p>' + esc(e.message) + '</p><a class="ui-btn primary" href="#" data-go="' + (UI.me ? 'home' : 'landing') + '">Back</a></div></div>';
    });
  });
})();
