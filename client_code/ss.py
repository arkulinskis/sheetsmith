"""Sheetsmith's JavaScript engine (theme/assets/ss-builder.js, window.SS; the formula + VBA engine window.SE) seen
from Python. Pages and items reach the engine only through this module.

    ss.SS / ss.SE            the engines themselves (a JS promise returned to Python is already awaited)
    ss.js(x) / ss.py(x)      Python <-> real JS objects (JSON copies; use for small things like settings)
    ss.blueprint(bp)         a server blueprint (a big dict) as ONE JS object, kept for the whole studio visit
    ss.read_workbook(file, keep)   the "Reading ..." overlay + inspect_workbook (try) or upload_workbook (keep)
    ss.draft()/set_draft()   a workbook tried without an account: lives in this browser tab only (#project/draft)
"""
import json

import anvil.js
import anvil.server
from anvil.js import window

from . import state

SS = window.SS
SE = window.SE
_draft: dict = {"d": None}


def setup():
    """Once at start-up: the engine's messages (a wrong file type in the drop zone) become toasts."""
    host = window.Object()
    host.toast = _toast
    SS.host = host


def _toast(message, kind=""):
    state.toast(message, kind or "error")


def js(x):
    """Python -> a real JS object (not a proxy of a Python dict)."""
    return window.JSON.parse(json.dumps(x))


def py(x):
    """JS -> plain Python (dicts, lists, str, numbers)."""
    if x is None:
        return None
    return json.loads(window.JSON.stringify(x))


def blueprint(bp):
    """The blueprint as a JS object. SS.analysis caches per object, so keep and reuse the one this returns."""
    return SS.keep(js(bp))


def read_workbook(file, keep):
    """Read a dropped workbook. keep=True saves it as a project (upload_workbook -> {id}); keep=False only reads it
    (inspect_workbook -> {blueprint, file}). Returns the server's reply, or None (the problem was shown)."""
    busy = SS.reading(file.name)
    try:
        media = anvil.js.to_media(file)
        return state.call("upload_workbook" if keep else "inspect_workbook", media)
    finally:
        busy.close()


def save_draft(settings):
    d = _draft["d"]
    if not d:
        return None
    return state.call("save_draft", anvil.js.to_media(d["file"]), settings)


def draft():
    return _draft["d"]


def set_draft(value):
    _draft["d"] = value


def initials(name):
    return state.initials(name or "?")


EXAMPLE_COLORS = {"bakery": "#B45309", "tools": "#0F766E", "quote": "#334155"}
EXAMPLE_BLURB = {"bakery": "Orders, a menu with prices, a live summary, an archive and three macros.",
                 "tools": "Tools, loans with late fees, members, an overdue check.",
                 "quote": "A quote calculator with live totals, tax and a Save macro."}
ICONS = ["table", "receipt", "users", "box", "check", "swap", "chart", "calc", "calendar", "wallet", "clock", "sliders",
         "folder", "pin", "edit", "grid"]
TYPES = [("Text", "text"), ("Long text", "longtext"), ("Number", "number"), ("Whole number", "integer"),
         ("Money", "money"), ("Percent", "percent"), ("Date", "date"), ("Date + time", "datetime"), ("Time", "time"),
         ("Yes / no", "bool"), ("Choice (dropdown)", "choice"), ("Email", "email"), ("Phone", "phone"),
         ("Web link", "url")]


def example_color(example):
    return EXAMPLE_COLORS.get(example or "", "#1D7A4F")


def example_blurb(example):
    return EXAMPLE_BLURB.get(example or "", "")
