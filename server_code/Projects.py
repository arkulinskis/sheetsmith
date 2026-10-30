"""Projects: a workbook someone uploaded, what Sheetsmith read from it (the blueprint) and their choices (settings).

The original file and the blueprint are stored as Media (the blueprint as zlib-compressed JSON); settings are a small
dict the studio saves as people change things. Examples (DemoData) are projects anyone can open and copy.
inspect_workbook reads a file without saving anything (trying Sheetsmith before signing up).
"""
import json
import re
import zlib

import anvil
import anvil.server
from anvil.tables import app_tables
import anvil.tables as tables

from . import common as C
from . import Blueprint, DemoData, WorkbookReader

MAX_FILE = WorkbookReader.MAX_FILE
MAX_PROJECTS = 60
MAX_SETTINGS = 300000
OK_TYPES = (".xlsx", ".xlsm", ".xltx", ".xltm")


def pack(bp):
    return anvil.BlobMedia("application/octet-stream", zlib.compress(json.dumps(bp, separators=(",", ":")).encode("utf-8"), 6), name="blueprint.json.z")


def unpack(media):
    return json.loads(zlib.decompress(media.get_bytes()).decode("utf-8"))


def read_file(data, name):
    """bytes -> (blueprint, None) or (None, message for people)."""
    if not data:
        return None, "That file is empty."
    if len(data) > MAX_FILE:
        return None, "That file is bigger than %d MB. Try a copy with less data in it." % (MAX_FILE // (1024 * 1024))
    try:
        return Blueprint.analyze(WorkbookReader.read_workbook(data, name)), None
    except WorkbookReader.WorkbookError as e:
        return None, str(e)
    except Exception as e:
        print("read_file failed for %r: %r" % (name, e))
        return None, "Sheetsmith couldn't read this workbook. If it opens in Excel, please send it through Feedback so we can fix the reader."


def _file_of(media):
    name = C.text(getattr(media, "name", None) or "Workbook.xlsx", 160)
    if not name.lower().endswith(OK_TYPES):
        if name.lower().endswith(".xls"):
            return None, None, "Old .xls files can't be read. Open it in Excel and use File > Save As > Excel Macro-Enabled Workbook (.xlsm)."
        if name.lower().endswith((".ods", ".numbers", ".csv")):
            return None, None, "Sheetsmith reads Excel workbooks (.xlsx or .xlsm). Save the file in that format first."
        return None, None, "Sheetsmith reads Excel workbooks: .xlsx or .xlsm files."
    return name, media.get_bytes(), None


def _meta(r, me):
    mine = me is not None and r["owner"] == me
    return {"id": r.get_id(), "name": r["name"], "file_name": r["file_name"], "summary": r["summary"] or {},
            "created": C.iso(r["created"]), "updated": C.iso(r["updated"]), "downloads": r["downloads"] or 0,
            "example": r["example"], "demo": bool(r["is_demo"]), "mine": mine,
            "can_edit": mine or (C.is_admin(me) and not r["is_demo"])}


def _get(project_id, me, need_edit=False):
    r = C.row_by_id(app_tables.projects, project_id)
    if r is None:
        return None, "That project doesn't exist any more."
    if r["is_demo"] or r["example"]:
        if need_edit and not C.is_admin(me):
            return None, "Examples can't be changed. Make a copy to change it."
        return r, None
    if me is None:
        return None, "Please sign in to open this project."
    if r["owner"] != me and not C.is_admin(me):
        return None, "That project belongs to someone else."
    if need_edit and r["owner"] != me:
        return None, "Only the owner can change this project."
    return r, None


# --------------------------------------------------------------------------------------------- lists
@anvil.server.callable
def get_projects():
    """Home page: the signed-in person's projects and the examples."""
    DemoData.ensure_loaded()
    me = C.me()
    mine = []
    if me is not None:
        mine = [_meta(r, me) for r in app_tables.projects.search(tables.order_by("updated", ascending=False), owner=me)]
    examples = [_meta(r, me) for r in app_tables.projects.search(is_demo=True) if r["example"]]
    order = list(DemoData.EXAMPLE_ORDER)
    examples.sort(key=lambda m: order.index(m["example"]) if m["example"] in order else 99)
    return {"mine": mine, "examples": examples, "limit": MAX_PROJECTS}


# --------------------------------------------------------------------------------------------- reading files
@anvil.server.callable
def inspect_workbook(media):
    """Read a workbook without saving it (so anyone can try). The studio keeps the result in the browser."""
    if C.rate_limited("inspect", 15, 3600):
        return C.fail("That's a lot of workbooks in one hour. Please wait a little, or sign up to keep your projects.")
    name, data, problem = _file_of(media)
    if problem:
        return C.fail(problem)
    bp, problem = read_file(data, name)
    if problem:
        return C.fail(problem)
    return C.ok(blueprint=bp, file={"name": name, "size": len(data)})


@anvil.server.callable(require_user=True)
def upload_workbook(media, name=None):
    me = C.require_user()
    if C.rate_limited("upload", 30, 3600):
        return C.fail("That's a lot of uploads in one hour. Please try again a bit later.")
    if len(app_tables.projects.search(owner=me)) >= MAX_PROJECTS:
        return C.fail("You have %d projects, the most there can be. Delete an old one first." % MAX_PROJECTS)
    fname, data, problem = _file_of(media)
    if problem:
        return C.fail(problem)
    bp, problem = read_file(data, fname)
    if problem:
        return C.fail(problem)
    now = C.now()
    title = C.text(name, 80) or bp["app"]["title"]
    r = app_tables.projects.add_row(owner=me, name=title, file_name=fname, file=anvil.BlobMedia(media.content_type or "application/octet-stream", data, name=fname),
                                    blueprint=pack(bp), summary=Blueprint.summary(bp), settings={"title": title} if name else {},
                                    created=now, updated=now, downloads=0, is_demo=False, example=None)
    return C.ok(id=r.get_id(), project=_meta(r, me))


@anvil.server.callable
def get_project(project_id):
    me = C.me()
    r, problem = _get(project_id, me)
    if problem:
        return C.fail(problem)
    try:
        bp = unpack(r["blueprint"])
    except Exception:
        return C.fail("This project's data couldn't be opened. Try Re-read workbook, or upload the file again.")
    return C.ok(project=_meta(r, me), settings=r["settings"] or {}, blueprint=bp)


# --------------------------------------------------------------------------------------------- changing projects
def _clean_settings(settings):
    if not isinstance(settings, dict):
        return None, "Settings must be a dict."
    try:
        text = json.dumps(settings)
    except (TypeError, ValueError):
        return None, "Those settings couldn't be saved."
    if len(text) > MAX_SETTINGS:
        return None, "Those settings are too big to save."
    clean = json.loads(text)
    if "pin" in clean:
        clean["pin"] = re.sub(r"\D", "", str(clean["pin"] or ""))[:12]
    if "port" in clean:
        try:
            p = int(clean["port"])
        except (TypeError, ValueError):
            p = 8080
        clean["port"] = p if 1024 <= p <= 65535 else 8080
    if "title" in clean:
        clean["title"] = C.text(clean["title"], 80)
    if "color" in clean and not re.match(r"^#[0-9A-Fa-f]{6}$", str(clean["color"] or "")):
        clean.pop("color")
    return clean, None


@anvil.server.callable(require_user=True)
def save_settings(project_id, settings):
    me = C.require_user()
    r, problem = _get(project_id, me, need_edit=True)
    if problem:
        return C.fail(problem)
    clean, problem = _clean_settings(settings)
    if problem:
        return C.fail(problem)
    r.update(settings=clean, updated=C.now())
    if clean.get("title"):
        r["name"] = clean["title"]
    return C.ok(saved=C.iso(r["updated"]))


@anvil.server.callable(require_user=True)
def rename_project(project_id, name):
    me = C.require_user()
    r, problem = _get(project_id, me, need_edit=True)
    if problem:
        return C.fail(problem)
    name = C.text(name, 80)
    if len(name) < 2:
        return C.fail("Give it a name (at least 2 characters).")
    s = dict(r["settings"] or {})
    s["title"] = name
    r.update(name=name, settings=s, updated=C.now())
    return C.ok(project=_meta(r, me))


@anvil.server.callable(require_user=True)
def delete_project(project_id):
    me = C.require_user()
    r = C.row_by_id(app_tables.projects, project_id)
    if r is None:
        return C.ok()
    if r["is_demo"] and not C.is_admin(me):
        return C.fail("Examples can't be deleted.")
    if r["owner"] != me and not C.is_admin(me):
        return C.fail("You can only delete your own projects.")
    r.delete()
    return C.ok()


@anvil.server.callable(require_user=True)
def copy_project(project_id):
    """Make my own copy of an example (or of one of my projects)."""
    me = C.require_user()
    r, problem = _get(project_id, me)
    if problem:
        return C.fail(problem)
    if len(app_tables.projects.search(owner=me)) >= MAX_PROJECTS:
        return C.fail("You have %d projects, the most there can be. Delete an old one first." % MAX_PROJECTS)
    if C.rate_limited("copy", 30, 3600):
        return C.fail("That's a lot of copies in one hour. Please try again later.")
    now = C.now()
    name = r["name"] if r["is_demo"] else (r["name"] + " (copy)")[:80]
    settings = dict(r["settings"] or {})
    if settings.get("title"):
        settings["title"] = name
    c = app_tables.projects.add_row(owner=me, name=name, file_name=r["file_name"], file=r["file"], blueprint=r["blueprint"], summary=r["summary"],
                                    settings=settings, created=now, updated=now, downloads=0, is_demo=False, example=None)
    return C.ok(id=c.get_id(), project=_meta(c, me))


@anvil.server.callable(require_user=True)
def save_draft(media, settings=None):
    """A workbook someone tried before signing in, now kept as a project (with what they already changed)."""
    out = upload_workbook(media)
    if not out.get("ok"):
        return out
    if settings:
        clean, problem = _clean_settings(settings)
        if not problem:
            r = app_tables.projects.get_by_id(out["id"])
            r["settings"] = clean
            if clean.get("title"):
                r["name"] = clean["title"]
    return out


@anvil.server.callable(require_user=True)
def reread_project(project_id):
    """Read the stored file again with the newest reader (after Sheetsmith improves). Keeps the settings."""
    me = C.require_user()
    r, problem = _get(project_id, me, need_edit=True)
    if problem:
        return C.fail(problem)
    if r["file"] is None:
        return C.fail("The original file isn't stored for this project.")
    bp, problem = read_file(r["file"].get_bytes(), r["file_name"])
    if problem:
        return C.fail(problem)
    r.update(blueprint=pack(bp), summary=Blueprint.summary(bp), updated=C.now())
    return C.ok(blueprint=bp, project=_meta(r, me))


@anvil.server.callable
def note_download(project_id):
    """Count downloads (shown in lists and in Admin)."""
    me = C.me()
    r, problem = _get(project_id, me)
    if problem or C.rate_limited("download", 60, 3600):
        return C.ok()
    r.update(downloads=(r["downloads"] or 0) + 1, last_download=C.now())
    return C.ok()


# --------------------------------------------------------------------------------------------- admin
@anvil.server.callable(require_user=True)
def admin_projects(query=None):
    C.require_admin()
    q = C.text(query, 80).lower()
    rows = list(app_tables.projects.search(tables.order_by("updated", ascending=False)))
    out = []
    for r in rows:
        owner = r["owner"]
        item = _meta(r, None)
        item.update(owner=C.name_of(owner), owner_email=owner["email"] if owner is not None else None,
                    size=r["file"].length if r["file"] is not None else 0)
        if q and q not in (item["name"] or "").lower() and q not in (item["owner_email"] or "").lower() and q not in (item["file_name"] or "").lower():
            continue
        out.append(item)
    return {"projects": out[:300], "total": len(out)}


@anvil.server.callable(require_user=True)
def admin_delete_project(project_id):
    C.require_admin()
    r = C.row_by_id(app_tables.projects, project_id)
    if r is not None:
        r.delete()
    return C.ok()
