"""End to end: build a real app from an example workbook, run its server.py, use it like a browser would.

    python -I tools/testing/test_app_e2e.py [--no-browser]   -> ALL OK

1. the studio's builder (run in Node: build_app.js) makes the download from the Juniper Bakery example
2. the zip is checked (files, executable start scripts)
3. server.py is started; its API takes changes, keeps them, logs who made them, exports .xlsx (read back here)
4. PIN and --reset behave
5. headless Chrome opens the served app, clicks a macro button, answers its MsgBox, and the server has the result
"""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
tmp = pathlib.Path(tempfile.mkdtemp(prefix="ss-e2e-"))
shutil.copytree(PROJECT / "server_code", tmp / "app")
(tmp / "app" / "__init__.py").write_text("")
os.environ["ANVIL_APP_YAML"] = str(PROJECT / "anvil.yaml")
sys.path[:0] = [str(HERE / "mock"), str(tmp)]
from app import Blueprint, SampleBooks, WorkbookReader  # noqa: E402


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(url, data=None, headers=None, raw=False):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read()
            return r.status, (body if raw else json.loads(body or b"{}")), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


def start(folder, *args):
    port = free_port()
    p = subprocess.Popen([sys.executable, "server.py", "--port", str(port), "--no-browser", "--host", "127.0.0.1"] + list(args),
                         cwd=str(folder), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(80):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=1)
            return p, port
        except Exception:
            if p.poll() is not None:
                sys.exit("server.py stopped: " + p.stdout.read())
            time.sleep(0.15)
    p.kill()
    sys.exit("server.py didn't start")


# 1. build
fname, data = SampleBooks.build("bakery")
bp = Blueprint.analyze(WorkbookReader.read_workbook(data, fname))
(tmp / "bp.json").write_text(json.dumps(bp), encoding="utf-8")
(tmp / "settings.json").write_text(json.dumps({"title": "Juniper Test", "port": 8090, "screens": {"tb:Menu": {"label": "Our menu"}}}), encoding="utf-8")
out = tmp / "out"
r = subprocess.run(["node", str(HERE / "build_app.js"), str(tmp / "bp.json"), str(out), str(tmp / "settings.json")], capture_output=True, text=True, encoding="utf-8")
res = json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
assert res.get("ok"), r.stdout + r.stderr
folder = out / "juniper-test"
assert (folder / "index.html").exists() and (folder / "server.py").exists()
assert "Our menu" in (folder / "index.html").read_text(encoding="utf-8"), "studio settings reach the app"
assert '"port":8090' in (folder / "server.py").read_text(encoding="utf-8"), "server.py gets its settings"
assert "Macros: 6 of 6 run" in (folder / "README.txt").read_text(encoding="utf-8"), "the README reports what came across"
assert b"\r\n" in (folder / "Start (Windows).bat").read_bytes(), ".bat has Windows line endings"

# 2. the zip
z = zipfile.ZipFile(out / "app.zip")
assert z.testzip() is None
names = z.namelist()
assert "juniper-test/index.html" in names and "juniper-test/start.command" in names, names
assert (z.getinfo("juniper-test/start.command").external_attr >> 16) & 0o111, "start.command is executable"
assert z.read("juniper-test/server.py") == (folder / "server.py").read_bytes()

# 3. the server
proc, port = start(folder)
base = "http://127.0.0.1:%d" % port
try:
    st, page, _ = http(base + "/", raw=True)
    assert st == 200 and b'id="ss-data"' in page
    st, man, _ = http(base + "/manifest.json")
    assert man["name"] == "Juniper Test"
    st, s, _ = http(base + "/api/state")
    assert st == 200 and s["rev"] == 1 and len(s["state"]["tables"]["Orders"]["rows"]) == 13
    rev = s["rev"]
    ops = [{"t": "radd", "tb": "Orders", "id": "e2e1", "c": [{"v": 2001}, {"v": 46300}, {"v": "Test Customer"}, None, {"v": "Lemon tart"}, {"v": 3}, None, None, None, {"v": "New"}, None]},
           {"t": "rset", "tb": "Orders", "id": "e2e1", "ci": 9, "v": "Baking"},
           {"t": "cell", "s": "Summary", "a": "D1", "v": "note"},
           {"t": "bogus"}]
    st, r2, _ = http(base + "/api/ops", {"base": rev, "ops": ops}, {"X-Who": "Tess%20Tester"})
    assert st == 200 and r2["rev"] == rev + 1 and "state" not in r2, r2
    st, r3, _ = http(base + "/api/state?since=%d" % r2["rev"])
    assert "state" not in r3, "no state when nothing changed"
    st, r4, _ = http(base + "/api/ops", {"base": rev, "ops": [{"t": "rset", "tb": "Orders", "id": "e2e1", "ci": 5, "v": 4}]})
    assert "state" in r4, "a device that was behind gets the whole state back"
    row = [x for x in r4["state"]["tables"]["Orders"]["rows"] if x["id"] == "e2e1"][0]
    assert row["c"][9]["v"] == "Baking" and row["c"][5]["v"] == 4
    st, lg, _ = http(base + "/api/log")
    texts = [i["text"] for i in lg["items"]]
    assert any("added a row to Orders" in t for t in texts) and lg["items"][-1]["who"] == "Tess Tester", lg
    assert any("Orders › Status to Baking" in t for t in texts)
    st, xl, hd = http(base + "/api/export.xlsx", raw=True)
    assert st == 200 and xl[:2] == b"PK" and "attachment" in hd.get("Content-Disposition", "")
    back = WorkbookReader.read_workbook(xl, "export.xlsx")
    orders = [t for t in back["tables"] if t["name"] == "Orders"][0]
    assert orders["totals"] and any(c["calc"] for c in orders["columns"]), "the export keeps tables, totals and calculated columns"
    rng = WorkbookReader.parse_range(orders["ref"])
    assert rng[2] - rng[0] + 1 == 1 + 14 + 1, "header + 14 rows + totals"
    st, info, _ = http(base + "/api/info")
    assert info["title"] == "Juniper Test"
    if "--no-browser" not in sys.argv:
        # 5. a browser: open the app, press "Mark baking ready", answer the MsgBox
        steps = [{"waitFor": "window.SS_APP && SS_APP.wb && document.querySelector('[data-macro]')", "timeout": 15000},
                 {"eval": "document.querySelectorAll('table.data tbody tr').length"},
                 {"eval": "document.querySelector('.modal-wrap [data-close]') && document.querySelector('.modal-wrap [data-close]').click(); 'name prompt closed'"},
                 {"eval": "[...document.querySelectorAll('[data-macro]')].find(b => /baking ready/i.test(b.textContent)).click(); 'clicked'"},
                 {"waitFor": "document.querySelector('.modal-wrap [data-v]')", "timeout": 8000},
                 {"eval": "document.querySelector('.modal-wrap .msg').textContent"},
                 {"eval": "document.querySelector('.modal-wrap [data-v]').click(); 'ok'"},
                 {"wait": 1500},
                 {"eval": "document.querySelector('.pill').textContent"},
                 {"shot": "served"}]
        (tmp / "steps.json").write_text(json.dumps(steps), encoding="utf-8")
        d = subprocess.run(["node", str(PROJECT / "tools" / "live" / "drive.mjs"), base + "/", str(tmp / "steps.json"), str(tmp / "drive")],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        log = d.stdout
        assert "4 order(s) marked Ready" in log, log[-2500:]
        assert "Live" in log, log[-2500:]
        st, s2, _ = http(base + "/api/state")
        statuses = [x["c"][9]["v"] for x in s2["state"]["tables"]["Orders"]["rows"] if x["c"][9]]
        assert "Baking" not in statuses and statuses.count("Ready") == 6, statuses
        assert "Uncaught" not in log and "EVAL ERROR" not in log, log[-2500:]
finally:
    proc.terminate()
    proc.wait(timeout=10)

# 4. PIN, then --reset
proc, port = start(folder, "--pin", "4321")
base = "http://127.0.0.1:%d" % port
try:
    assert http(base + "/api/state")[0] == 401, "a PIN keeps the data closed"
    assert http(base + "/", raw=True)[0] == 200, "the page itself opens (it asks for the PIN)"
    assert http(base + "/api/login", {"pin": "1111"})[0] == 403
    st, _, hd = http(base + "/api/login", {"pin": "4321"})
    cookie = hd.get("Set-Cookie", "").split(";")[0]
    assert st == 200 and cookie.startswith("ss_auth=")
    st, s, _ = http(base + "/api/state", headers={"Cookie": cookie})
    assert st == 200 and any(x["id"] == "e2e1" for x in s["state"]["tables"]["Orders"]["rows"]), "data survives a restart"
finally:
    proc.terminate()
    proc.wait(timeout=10)
proc, port = start(folder, "--reset")
try:
    st, s, _ = http("http://127.0.0.1:%d/api/state" % port)
    assert len(s["state"]["tables"]["Orders"]["rows"]) == 13, "--reset goes back to the workbook's data"
    assert any("before-reset" in n for n in os.listdir(folder / "data" / "backups")), "and keeps a backup"
finally:
    proc.terminate()
    proc.wait(timeout=10)
print("ALL OK (app built, zip, server API, export round trip, PIN, reset%s)" % ("" if "--no-browser" in sys.argv else ", browser + macro"))
