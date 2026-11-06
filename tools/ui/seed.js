/* For screenshots of member pages: sign up a fresh account and make their own copy of the bakery example (so the
   studio shows an own project: More menu, "Saved"). Resolves to window.SEED = {home, project}. */
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 30000);
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); }
    throw new Error('timed out waiting for: ' + what);
  }
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  function type(input, value) {
    input.focus(); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  try {
    if (location.hash !== '#auth/signup') window.UI_READY = false;
    location.hash = '#auth/signup';
    await until(() => window.UI_READY && $$('.au-card input').length >= 3, 'sign-up');
    const inputs = $$('.au-card input[type=text], .au-card input[type=email], .au-card input[type=password]');
    type(inputs[0], 'Sam Rivera'); type(inputs[1], 'shots' + Date.now() + '@example.com'); type(inputs[2], 'Hb-' + Math.random().toString(36).slice(2) + '-Kq7');
    const tick = $('.au-card input[type=checkbox]'); if (tick && !tick.checked) tick.click();
    $$('.anvil-role-btn-block button').find((b) => /Create account/.test(b.textContent)).click();
    await until(() => location.hash === '#home' && window.UI_READY && $$('.ss-pcard').length >= 3, 'home', 60000);
    $$('.ss-pcard').find((a) => /Juniper/.test(a.textContent)).click();
    await until(() => window.UI_READY && $('.st-banner') && /example/.test($('.st-banner').textContent), 'example', 40000);
    $$('.st-banner button').find((b) => /Make my copy/.test(b.textContent)).click();
    await until(() => window.UI_READY && $('.anvil-role-ic-more') && $('.anvil-role-ic-more').offsetParent, 'own copy', 40000);
    window.SEED = { home: '#home', project: location.hash };
    return window.SEED;
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
})();
