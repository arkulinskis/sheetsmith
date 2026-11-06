"""Server tests against the strict mock of Anvil (tools/testing/mock).

    python tools/testing/test_server.py          -> prints ALL OK, or the first failure

call(name, ...) runs a server function the way the browser does: by name, with require_user enforced,
and the reply must be JSON (a datetime or a row in a reply fails here, like it would break the page).
Add tests for every new server function: the happy path, bad input, and someone who isn't allowed.
"""
import datetime as dt
import importlib
import json
import os
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
_tmp = pathlib.Path(tempfile.mkdtemp())
shutil.copytree(PROJECT / "server_code", _tmp / "app")
(_tmp / "app" / "__init__.py").write_text("")
os.environ["ANVIL_APP_YAML"] = str(PROJECT / "anvil.yaml")  # the mock's tables follow the app's own schema
sys.path[:0] = [str(HERE / "mock"), str(_tmp)]
import anvil.server  # noqa: E402
import anvil.users  # noqa: E402
from anvil.tables import app_tables as T  # noqa: E402

M = {p.stem: importlib.import_module("app." + p.stem) for p in sorted((PROJECT / "server_code").glob("*.py"))}
now = dt.datetime.now(dt.timezone.utc)


def call(name, *args):
    r = anvil.server.call(name, *args)
    json.dumps(r)  # strict: must be JSON-able
    return r


def as_user(row):
    anvil.users.CURRENT[0] = row
    anvil.server.session.use(row.get_id() if row is not None else None)


def denied(name, *args):
    try:
        call(name, *args)
    except anvil.server.PermissionDenied:
        return True
    return False


def ok(r, msg=""):
    assert isinstance(r, dict) and r.get("ok"), (msg, r)
    return r


def bad(r, msg=""):
    assert isinstance(r, dict) and r.get("ok") is False and r.get("error"), (msg, r)
    return r


def person(email, name=None, **kw):
    return T.users.add_row(email=email, enabled=True, signed_up=now, display_name=name, **kw)


# ---------------------------------------------------------------------------------- accounts
admin = person("arkulinskis@gmail.com", "The Admin")
ana = person("ana@example.com", "Ana")
bob = person("bob@example.com")

as_user(None)
assert call("get_me") is None
assert denied("update_profile", "X")
as_user(admin)
assert call("get_me")["is_admin"] is True, "ADMIN_EMAILS become admins on first sign-in"
as_user(ana)
me = call("get_me")
assert me["name"] == "Ana" and me["is_admin"] is False
assert ana["last_seen"] is not None
as_user(bob)
assert call("get_me")["name"] == "Bob", "a name comes from the email when none is set"
bad(call("update_profile", " x "))
assert ok(call("update_profile", "  Bob   Stone "))["me"]["name"] == "Bob Stone"

# ---------------------------------------------------------------------------------- feedback
as_user(None)
bad(call("submit_feedback", "bug", "hi"))
ok(call("submit_feedback", "bug", "The button is broken", "guest@example.com", {"page": "#home", "evil": "x" * 9999}))
fb = T.feedback.search()[0]
assert fb["name"] == "Guest" and fb["email"] == "guest@example.com" and "evil" not in fb["context"] and fb["status"] == "new"
for i in range(4):
    ok(call("submit_feedback", "idea", "Idea number %d" % i))
bad(call("submit_feedback", "idea", "One too many this hour"), "rate limit")
as_user(ana)
ok(call("submit_feedback", "nonsense-kind", "Signed-in feedback"))
assert T.feedback.get(message="Signed-in feedback")["kind"] == "other"
assert denied("list_feedback")
as_user(admin)
lst = call("list_feedback")
assert lst["counts"]["new"] == 6 and len(lst["items"]) == 6
fid = lst["items"][0]["id"]
ok(call("set_feedback_status", fid, "done", "Fixed it"))
assert call("list_feedback", "done")["items"][0]["note"] == "Fixed it"
bad(call("set_feedback_status", fid, "weird"))
bad(call("set_feedback_status", "nope", "done"))
ok(call("delete_feedback", fid))
assert len(call("list_feedback")["items"]) == 5

# ---------------------------------------------------------------------------------- admin
as_user(ana)
for fn, args in [("admin_overview", ()), ("list_users", ()), ("set_admin", (bob.get_id(), True)), ("demo_load", ()), ("demo_remove", ())]:
    assert denied(fn, *args), fn
as_user(admin)
ov = call("admin_overview")
assert ov["users"] == 3 and ov["admins"] == 1 and ov["feedback_new"] == 5
assert len(call("list_users")["users"]) == 3 and len(call("list_users", "bob")["users"]) == 1
ok(call("set_admin", bob.get_id(), True))
assert bob["is_admin"] is True
bad(call("set_admin", admin.get_id(), False), "can't remove your own admin")
ok(call("set_enabled", bob.get_id(), False))
assert bob["enabled"] is False
bad(call("set_enabled", admin.get_id(), False))
ok(call("set_enabled", bob.get_id(), True))
ok(call("set_admin", bob.get_id(), False))
assert bob["is_admin"] is False

# ---------------------------------------------------------------------------------- the readers (real files written by SampleBooks)
import anvil  # noqa: E402
SB, WR, VR, BPM = M["SampleBooks"], M["WorkbookReader"], M["VbaReader"], M["Blueprint"]
for key in SB.BOOKS:
    fname, data = SB.build(key)
    bp = BPM.analyze(WR.read_workbook(data, fname))
    json.dumps(bp)
    assert bp["sheets"] and bp["app"]["screens"], key
    assert bp["vba"] and all(m["code"] is not None for m in bp["vba"]), "VBA modules come back out of vbaProject.bin: " + key
bakery = BPM.analyze(WR.read_workbook(SB.build("bakery")[1], "Juniper.xlsm"))
orders = [t for t in bakery["tables"] if t["name"] == "Orders"][0]
assert orders["totals"] and [c["name"] for c in orders["columns"]][:3] == ["Order #", "Date", "Customer"]
assert [c for c in orders["columns"] if c["name"] == "Total"][0]["calc"] == "[@Qty]*[@[Unit price]]", "calculated columns"
scr = {s["id"]: s for s in bakery["app"]["screens"]}
assert scr["tb:Orders"]["statusCol"] == "Status" and scr["fm:Summary"]["kind"] == "form"
types = {c["name"]: c["type"] for c in scr["tb:Orders"]["columns"]}
assert types["Item"] == "choice" and types["Qty"] == "integer" and types["Date"] == "date" and types["Total"] == "formula" and types["Phone"] == "phone", types
assert [a["macro"] for a in bakery["app"]["actions"]] == ["NewOrder", "MarkBakingReady", "ArchiveDelivered"], "buttons with their macros"
assert any(v["type"] == "list" and v["f1"] == "MenuItems" for v in bakery["sheets"][0]["validations"])
assert any(cf["rules"][0]["style"].get("fill") for cf in bakery["sheets"][0]["condFormats"]), "conditional format colours"
assert {m["name"]: m.get("sheet") for m in bakery["vba"]}["Sheet1"] == "Orders", "sheet modules know their sheet"
tools_bp = BPM.analyze(WR.read_workbook(SB.build("tools")[1], "Tools.xlsm"))
assert any(t["pseudo"] and t["sheet"] == "Members" for t in tools_bp["tables"]), "a plain list becomes a table"
quote_bp = BPM.analyze(WR.read_workbook(SB.build("quote")[1], "Quote.xlsm"))
qf = [s for s in quote_bp["app"]["screens"] if s["kind"] == "form"][0]["form"]
assert qf["inputs"] == 6 and qf["outputs"] == 7, "the quote sheet is one form: 6 inputs, 7 results"
assert WR.shift_formula("A1+$B$2+B$3+Sheet1!C4+SUM(D1:D2)", 2, 1) == "B3+$B$2+C$3+Sheet1!D6+SUM(E3:E4)"
assert VR.decompress(VR.compress(b"abcabcabcabc" * 500)) == b"abcabcabcabc" * 500
for junk, msg in [(b"not a zip", "isn't an .xlsx"), (b"", "")]:
    try:
        WR.read_workbook(junk, "x.xlsx")
        assert False, "junk is refused"
    except WR.WorkbookError as e:
        assert msg in str(e)


# ---------------------------------------------------------------------------------- projects
def media(key="bakery", name=None):
    fname, data = SB.build(key)
    return anvil.BlobMedia("application/vnd.ms-excel.sheet.macroEnabled.12", data, name=name or fname)


as_user(None)
home = call("get_projects")
assert M["DemoData"].state() == "loaded" and [e["example"] for e in home["examples"]] == ["bakery", "tools", "quote"], "examples load on first visit"
assert home["mine"] == [] and all(not e["can_edit"] for e in home["examples"])
ex = home["examples"][0]
got = ok(call("get_project", ex["id"]))
assert got["blueprint"]["app"]["screens"] and not got["project"]["can_edit"], "anyone can open an example"
r = ok(call("inspect_workbook", media("tools")))
assert r["blueprint"]["title"] and r["file"]["size"] > 1000 and len(T.projects.search(is_demo=False)) == 0, "trying a file saves nothing"
bad(call("inspect_workbook", anvil.BlobMedia("application/octet-stream", b"old", name="old.xls")))
bad(call("inspect_workbook", anvil.BlobMedia("application/octet-stream", b"not a zip at all", name="fake.xlsx")))
bad(call("inspect_workbook", anvil.BlobMedia("text/csv", b"a,b", name="data.csv")))
assert denied("upload_workbook", media())
assert denied("save_settings", ex["id"], {})
as_user(ana)
up = ok(call("upload_workbook", media("bakery")))
pid = up["id"]
assert up["project"]["mine"] and up["project"]["can_edit"] and up["project"]["summary"]["tables"] == 3
assert call("get_projects")["mine"][0]["id"] == pid
p = ok(call("get_project", pid))
assert p["project"]["file_name"] == "Juniper Bakery orders.xlsm" and p["settings"] == {}
ok(call("save_settings", pid, {"title": "  Juniper  orders ", "pin": "12-34ab", "port": 99, "color": "red", "screens": {"tb:Orders": {"label": "Orders"}}}))
row = T.projects.get_by_id(pid)
assert row["settings"]["pin"] == "1234" and row["settings"]["port"] == 8080 and "color" not in row["settings"] and row["name"] == "Juniper orders", "settings are cleaned"
bad(call("save_settings", pid, {"x": "y" * 400000}), "too big")
bad(call("save_settings", pid, "nope"))
bad(call("rename_project", pid, " "))
assert ok(call("rename_project", pid, "Bakery app"))["project"]["name"] == "Bakery app"
bad(call("save_settings", ex["id"], {"title": "mine now"}), "examples are read-only")
bad(call("delete_project", ex["id"]), "examples can't be deleted")
ok(call("note_download", pid))
assert T.projects.get_by_id(pid)["downloads"] == 1
rr = ok(call("reread_project", pid))
assert rr["blueprint"]["sheets"] and T.projects.get_by_id(pid)["settings"]["title"] == "Bakery app", "re-reading keeps the settings"
d = ok(call("save_draft", media("quote"), {"title": "My quote app", "color": "#225588"}))
assert T.projects.get_by_id(d["id"])["name"] == "My quote app" and T.projects.get_by_id(d["id"])["settings"]["color"] == "#225588"
as_user(bob)
bad(call("get_project", pid), "other people's projects stay private")
bad(call("save_settings", pid, {}))
bad(call("delete_project", pid))
bad(call("reread_project", pid))
cp = ok(call("copy_project", ex["id"]))
assert T.projects.get_by_id(cp["id"])["owner"] == bob and not T.projects.get_by_id(cp["id"])["is_demo"], "copying an example"
bad(call("copy_project", pid), "can't copy someone else's project")
ok(call("delete_project", cp["id"]))
assert T.projects.get_by_id(cp["id"]) is None
as_user(None)
bad(call("get_project", pid), "guests can't open private projects")
bad(call("get_project", "nonsense"))
as_user(admin)
assert ok(call("get_project", pid))["project"]["can_edit"], "admins can open any project"
lst = call("admin_projects")
assert lst["total"] == 5 and any(x["owner_email"] == "ana@example.com" for x in lst["projects"]), lst["total"]
assert call("admin_projects", "quote")["total"] == 2
ov = call("admin_overview")
assert ov["projects"] == 2 and ov["downloads"] == 1, ov
as_user(ana)
assert denied("admin_projects") and denied("admin_delete_project", pid)
as_user(admin)
ok(call("admin_delete_project", d["id"]))
assert T.projects.get_by_id(d["id"]) is None

# ---------------------------------------------------------------------------------- demo data
ok(call("demo_remove"))
assert M["DemoData"].state() == "removed" and len(T.projects.search()) == 1, "removing demo data keeps real projects"
assert not T.users.search(is_demo=True)
as_user(None)
assert call("get_projects")["examples"] == [] and M["DemoData"].state() == "removed", "removed demo data doesn't come back by itself"
as_user(admin)
ok(call("demo_load"))
ok(call("demo_load"))
assert len(call("get_projects")["examples"]) == 3, "reloading replaces the demo instead of doubling it"

# ---------------------------------------------------------------------------------- Privacy & Terms
if "legal_server" in M:
    as_user(ana)
    st = call("legal_state")
    assert st["signedIn"] and st["accepted_version"] is None
    ok(call("legal_accept", st["version"], "signup"))
    assert ana["legal_source"] == "signup" and call("legal_state")["accepted_version"] == st["version"]

# ---------------------------------------------------------------------------------- every callable is covered by a permission check
# A callable that changes data without require_user / a C.require_* check is a security hole. List the public ones here.
PUBLIC = {"get_me", "submit_feedback", "get_projects", "inspect_workbook", "get_project", "note_download", "legal_state", "legal_accept"}
for name, (f, need) in sorted(anvil.server.CALLABLES.items()):
    if name in PUBLIC:
        continue
    assert need, "%s is callable by anyone: add require_user=True (or list it in PUBLIC in test_server.py)" % name

print("ALL OK (%d server functions)" % len(anvil.server.CALLABLES))
