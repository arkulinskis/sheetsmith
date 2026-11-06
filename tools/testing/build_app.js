/* Build a downloadable app in Node with the studio's own builder (theme/assets/ss-builder.js), for the end-to-end test.
   node tools/testing/build_app.js <blueprint.json> <outdir> [settings.json]   -> writes the app's files + app.zip
   It also runs the studio's data views (SS.overviewView, screensView, rulesView, macrosView, getView, codeHtml) on the
   blueprint, so a broken view fails here before the browser sees it. */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..', '..');
var A = path.join(ROOT, 'theme', 'assets');
global.window = global;
global.document = { querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
require(path.join(A, 'rt-formula.js'));
require(path.join(A, 'rt-vba.js'));
global.fetch = function (url) {
  var name = url.replace(/^.*\//, '').replace(/\?.*$/, '');
  var text = fs.readFileSync(path.join(A, name), 'utf8');
  return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(text); } });
};
(0, eval)(fs.readFileSync(path.join(A, 'ss-builder.js'), 'utf8'));
var bp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
var outdir = process.argv[3];
var settings = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) : {};
var views = {
  overview: SS.overviewView(bp, settings), screens: SS.screensView(bp, settings), rules: SS.rulesView(bp),
  macros: SS.macrosView(bp, settings), get: SS.getView(bp, settings)
};
var code = (bp.vba || []).length ? SS.codeHtml(bp, bp.vba[0].name) : '';
SS.files(bp, settings).then(function (files) {
  files.forEach(function (f) {
    var p = path.join(outdir, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text, 'utf8');
  });
  return SS.zip(files).then(function (blob) { return blob.arrayBuffer(); }).then(function (buf) {
    fs.writeFileSync(path.join(outdir, 'app.zip'), Buffer.from(buf));
    console.log(JSON.stringify({ ok: true, files: files.map(function (f) { return f.name; }), report: SS.report(bp, settings),
      views: { stats: views.overview.stats.length, screens: views.screens.length, rules: views.rules.rules.length, formats: views.rules.formats.length,
        modules: views.macros.modules.length, tables: views.get.tables.length, codeLines: code.split('</div>').length - 1 } }));
  });
}).catch(function (e) { console.log(JSON.stringify({ ok: false, error: String(e && e.stack || e) })); process.exit(1); });
