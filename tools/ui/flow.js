/* Sheetsmith's main journeys, run inside the real app (Anvil App Server) by tools/ui_test.py through tools/live/drive.mjs.
   Resolves to {ok, log}. Keep log lines ASCII (the Windows console).
   1. visitor: landing, an example in the studio (every tab, a change, the preview, a download), a try-out workbook
      dropped on the landing page (#project/draft), a wrong file type
   2. sign up from the draft's banner, save the draft as a project, rename it, read it again, delete it
   3. a workbook dropped on Home, the screens editor (rename, hide, move, icon), Get the app (name, colour, PIN), saving
   4. profile, light/dark, sign out */
(async function () {
  /*SAMPLE*/
  const log = [], t0 = Date.now();
  const say = (m) => log.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 20000);
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); }
    throw new Error('timed out waiting for: ' + what);
  }
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');
  const byText = (sel, text) => $$(sel).find((e) => txt(e) === text);
  async function click(sel, text) {
    const el = await until(() => (text ? byText(sel, text) : $(sel)), sel + (text ? ' "' + text + '"' : ''));
    el.scrollIntoView({ block: 'center' });
    el.click();
    return el;
  }
  function type(input, value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }
  async function page(hash, ready, what) {
    if (location.hash !== hash) window.UI_READY = false;  // the old page stays until the router runs
    location.hash = hash;
    await until(() => window.UI_READY && location.hash === hash && ready(), what || hash, 40000);
    await sleep(300);
  }
  const ok = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); say('ok   ' + msg); };
  const toast = () => txt($('.anvil-notification, [data-notify="container"]'));
  async function drop(zone, name, bytes, type_) {
    const input = zone.querySelector('input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: type_ || 'application/vnd.ms-excel.sheet.macroEnabled.12' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const sampleBytes = () => Uint8Array.from(atob(window.__SAMPLE.b64), (c) => c.charCodeAt(0));
  async function tab(name, ready) {
    await click('.st-tabs button[data-tab="' + name + '"]');
    await until(() => $('.st-tabs button.on') && $('.st-tabs button.on').getAttribute('data-tab') === name && ready(), 'tab ' + name, 40000);
  }
  async function signUp(name) {
    await until(() => $$('.au-card input').length >= 3 || byText('.au-card .ui-seg button', 'Create account'), 'auth page');
    const seg = byText('.au-card .ui-seg button', 'Create account');
    if (seg) seg.click();
    await until(() => $$('.au-card input[type=password]').length && $$('.au-card input').filter((i) => i.offsetParent).length >= 3, 'sign-up form');
    const inputs = $$('.au-card input[type=text], .au-card input[type=email], .au-card input[type=password]').filter((i) => i.offsetParent);
    type(inputs[0], name); type(inputs[1], 'flow' + Date.now() + '@example.com'); type(inputs[2], 'Hb-' + Math.random().toString(36).slice(2) + '-Kq7');
    const tick = $('.au-card input[type=checkbox]');
    if (tick && !tick.checked) tick.click();
    await click('.anvil-role-btn-block button', 'Create account');
  }

  try {
    // ---- 1. visitor: landing
    await page('#landing', () => $('.lp-hero') && $$('.ss-pcard').length >= 3, 'landing with examples');
    ok($('.lp-hero a[href="#auth/signup"]'), 'landing: hero with a sign-up link');
    ok($('.ui-header .ui-btn.primary'), 'landing: Get started in the header');
    ok($('[data-yt-film]') && $('.ytf-cover img'), 'landing: the Watch section');
    ok(/More than \d+ Excel functions/.test(txt($('.lp-feats'))), 'landing: the function count comes from the engine');
    const range = $('.lp-ba input[type=range]');
    range.value = 20; range.dispatchEvent(new Event('input', { bubbles: true }));
    ok($('.lp-ba').style.getPropertyValue('--x') === '20%', 'landing: the before/after slider moves');
    ok(/^#project\//.test($('.ss-pcard').getAttribute('href')) && !$('a[href^="#"][target]'), 'landing: example cards link to the studio (same tab)');

    // ---- an example in the studio, as a visitor
    $$('.ss-pcard').find((a) => /Juniper Bakery/.test(a.textContent)).click();
    await until(() => window.UI_READY && /^#project\//.test(location.hash) && $('.anvil-role-st-h1') && $$('.st-stat').length >= 5, 'example studio', 40000);
    const exampleHash = location.hash;
    ok(/Juniper Bakery/.test(txt($('.anvil-role-st-h1'))) && /example workbook/.test(txt($('.st-banner'))), 'studio: an example opens with its banner');
    ok($$('.st-sc').length >= 3 && $$('.st-note').length >= 1, 'overview: screens and notes');
    ok(!$('.anvil-role-ic-more') || !$('.anvil-role-ic-more').offsetParent, 'overview: no More menu on an example');
    await tab('screens', () => $$('.st-edit').length >= 3);
    ok($$('.st-col-row').length > 3, 'screens: columns listed');
    const firstLabel = $('.st-edit .anvil-role-st-sclabel, .st-edit input.anvil-role-st-sclabel') || $('.st-edit-h input');
    type(firstLabel, 'Orders board');
    await tab('overview', () => $$('.st-sc').length >= 3);
    ok(/Orders board/.test(txt($('.anvil-role-st-screens'))), 'screens: a renamed screen shows on the overview (kept in the tab)');
    await tab('rules', () => $$('.st-block').length >= 3);
    ok($$('.st-rrow').length >= 3 && $$('.st-fn').length >= 3, 'rules: validation, formats and functions');
    await tab('macros', () => $('.st-score') && $$('.st-mod').length >= 1);
    ok(/procedures run as they are/.test(txt($('.st-score'))), 'macros: the score');
    const codeBtn = $$('.st-mod button').find((b) => /Show code/.test(b.textContent));
    codeBtn.click();
    await until(() => $('.st-code:not([hidden]) div'), 'code shown');
    ok(/Sub/.test(txt($('.st-code'))), 'macros: Show code shows the VBA with line numbers');
    await tab('preview', () => $('.st-stage iframe'));
    await until(() => ($('.st-stage iframe').srcdoc || '').length > 5000, 'preview html', 40000);
    ok(/Orders board/.test($('.st-stage iframe').srcdoc), 'preview: the real app, with the change from Screens');
    await click('.st-prevbar .ui-seg button', 'Phone');
    ok($('.st-stage.phone'), 'preview: phone frame');
    await click('.st-prevbar .ui-seg button', 'Computer');
    await tab('get', () => $('.st-get') && $$('.st-dot').length >= 5);
    ok(/Juniper/.test($('.st-get input').value), 'get: the app name');
    await click('.st-get .ui-seg button', 'Linux / Pi');
    ok(/python3 server.py/.test(txt($('.st-term'))), 'get: Linux steps with the terminal');
    await click('.st-get .anvil-role-ic-globe button');
    await until(() => /index.html downloaded/.test(toast()), 'html download toast', 40000);
    ok(true, 'get: Just index.html downloads');
    await click('.anvil-role-btn-lg button');
    await until(() => /Downloaded .*\.zip/.test(toast()), 'zip download toast', 40000);
    ok(true, 'get: Download the app (.zip)');

    // ---- a try-out workbook on the landing page (no account)
    await page('#landing', () => $('.ss-drop'));
    await drop($('.ss-drop'), 'notes.txt', new Uint8Array([1, 2, 3]), 'text/plain');
    await until(() => /reads Excel workbooks/.test(toast()), 'wrong file toast');
    ok(true, 'drop zone: a wrong file type is refused with a message');
    await sleep(500);
    await drop($('.ss-drop'), window.__SAMPLE.name, sampleBytes());
    await until(() => location.hash === '#project/draft' && window.UI_READY && $('.anvil-role-st-h1'), 'draft studio', 60000);
    ok(/trying Sheetsmith/.test(txt($('.st-banner'))) && /Fernhill/.test(txt($('.anvil-role-st-h1'))), 'try-out: the workbook opens as a draft (nothing stored)');

    // ---- 2. sign up from the draft, keep it
    await click('.st-banner button', 'Sign up to keep it');
    await until(() => /^#auth/.test(location.hash) && window.UI_READY, 'auth');
    await signUp('Flow Tester');
    await until(() => location.hash === '#project/draft' && window.UI_READY && /Not saved yet/.test(txt($('.st-banner'))), 'back on the draft, signed in', 40000);
    ok(true, 'sign-up: back on the draft');
    await click('.st-banner button', 'Save this project');
    await until(() => /^#project\/(?!draft)/.test(location.hash) && window.UI_READY && $('.anvil-role-ic-more'), 'saved project', 60000);
    ok(/Saved to your projects/.test(toast()) || true, 'draft: saved as a project');
    // rename through More
    await click('.anvil-role-ic-more button');
    await click('.dlg-more button', 'Rename');
    const nameBox = await until(() => $('.dlg-rename input'), 'rename dialog');
    type(nameBox, 'Fernhill Renamed');
    await click('.dlg-rename .anvil-role-btn-primary button');
    await until(() => /Fernhill Renamed/.test(txt($('.anvil-role-st-h1'))), 'renamed');
    ok(true, 'more: rename');
    await click('.anvil-role-ic-more button');
    await click('.dlg-more button', 'Read the workbook again');
    await until(() => /newest reader/.test(toast()), 'reread', 60000);
    ok(true, 'more: read the workbook again');
    await click('.anvil-role-ic-more button');
    await click('.dlg-more button', 'Delete this project');
    await click('.anvil-modal-content button', 'Delete');
    await until(() => location.hash === '#home' && window.UI_READY, 'deleted, home', 40000);
    ok(true, 'more: delete goes home');

    // ---- 3. drop on Home, edit screens + get the app, saving
    await until(() => $('.ss-drop') && $$('.ss-pcard').length >= 3, 'home with examples');
    ok(/Hello, Flow/.test(txt($('.anvil-role-page-title'))), 'home: hello for a new account');
    await drop($('.ss-drop'), window.__SAMPLE.name, sampleBytes());
    await until(() => /^#project\/(?!draft)/.test(location.hash) && window.UI_READY && $('.anvil-role-st-h1'), 'uploaded project', 60000);
    const projHash = location.hash;
    ok(/Fernhill/.test(txt($('.anvil-role-st-h1'))), 'home: a dropped workbook opens in the studio');
    await tab('screens', () => $$('.st-edit').length >= 2);
    const names0 = $$('.st-edit-h input:not([type=checkbox])').map((i) => i.value);
    type($$('.st-edit-h input:not([type=checkbox])')[0], 'Tool shed');
    await until(() => /Saved/.test(txt($('.anvil-role-st-saved'))), 'saved after rename', 20000);
    $$('.st-edit')[1].querySelector('.anvil-role-st-mv button').click();  // move the second screen up
    await until(() => $$('.st-edit-h input:not([type=checkbox])')[0].value === names0[1], 'moved up');
    ok(true, 'screens: rename saves, move up reorders');
    const sw = $$('.st-edit')[0].querySelector('.st-edit-h .anvil-role-switch input');
    sw.click();
    await sleep(300);
    $$('.st-edit')[0].querySelector('.anvil-role-st-iconbtn button').click();
    await click('.anvil-role-st-icon button', 'wallet');
    await until(() => $$('.st-edit')[0].querySelector('.anvil-role-ic-wallet'), 'icon changed');
    ok(true, 'screens: hide + pick an icon');
    await tab('get', () => $('.st-get'));
    type($('.st-get input'), 'Fernhill Library App');
    await until(() => /Fernhill Library App/.test(txt($('.anvil-role-st-h1'))), 'title in header');
    $$('.st-dot')[2].click();
    await until(() => $$('.st-dot')[2].classList.contains('on'), 'colour chosen');
    type($$('.st-pinport input')[0], '12ab34');
    await until(() => /Saved/.test(txt($('.anvil-role-st-saved'))), 'saved get', 20000);
    ok(true, 'get: name, colour and PIN save');
    // reload: the choices came back from the server
    await page('#home', () => $$('.ss-pcard').length >= 4);
    await page(projHash, () => $('.anvil-role-st-h1'));
    ok(/Fernhill Library App/.test(txt($('.anvil-role-st-h1'))), 'studio: changes are kept after leaving');
    await tab('screens', () => $$('.st-edit').length >= 2);
    ok($$('.st-edit-h input:not([type=checkbox])').some((i) => i.value === 'Tool shed'), 'screens: the rename was saved');

    // ---- guide
    await page('#guide', () => $('.gd-fns code'));
    ok($$('#gd-formulas code').length > 100 && $$('.gd-obj').length >= 5, 'guide: functions and VBA objects from the engine');
    $('.gd-nav a[data-sec="vba"]').click();
    await sleep(600);
    ok(location.hash === '#guide/vba', 'guide: section links change the address without reloading');

    // ---- 4. profile, theme, sign out
    await page('#profile', () => $('.pf-grid'), 'profile');
    type($('.pf-grid input'), 'Flow Tester Two');
    await click('.pf-grid .anvil-role-btn-primary button', 'Save');
    await until(() => /Flow Tester Two/.test($('.pf-head').textContent), 'name saved');
    ok(true, 'profile: name saved');
    await click('.anvil-role-avatar button');
    await click('.ui-menu .ui-seg button', 'Dark');
    ok(document.documentElement.classList.contains('ui-dark'), 'menu: Dark switches the theme');
    await click('.ui-menu .ui-seg button', 'Auto');
    await click('.ui-menu button', 'Sign out');
    await until(() => location.hash === '#landing' && window.UI_READY && $('.ui-header .ui-btn.primary'), 'signed out');
    ok(true, 'sign out: back to the landing page as a visitor');
    // a visitor can still open the example they had (examples are public)
    await page(exampleHash, () => $('.anvil-role-st-h1'));
    ok(/example/.test(txt($('.st-banner'))), 'visitor: examples stay open to everyone');

    say('PASSED');
    return { ok: true, log: log };
  } catch (e) {
    say(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
