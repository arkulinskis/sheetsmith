"""Demo content: the example projects everyone can open and copy (all fictional), so the app never looks empty.
Loaded the first time anyone opens the app (ensure_loaded), removed or reloaded from Admin -> Demo data.
Removing it is remembered: it doesn't come back by itself.

The examples are real .xlsm files written by SampleBooks and read by the same reader as uploads, with dates
relative to the day they're loaded. Every demo row has is_demo=True, so remove() deletes exactly what load() added.
"""
import datetime as dt

import anvil
from anvil.tables import app_tables

from . import common as C

DEMO_USERS = [("Sheetsmith examples", "examples.demo@example.com")]
EXAMPLE_ORDER = ["bakery", "tools", "quote"]
# Tables that hold demo rows (each has an is_demo column). Children before parents.
DEMO_TABLES = ["projects"]


def state():
    return C.get_setting("demo", "never")  # "never" | "loaded" | "removed"


def ensure_loaded():
    """Call from the app's main data callables: loads the demo once, unless an admin removed it."""
    if state() == "never":
        load()


def load():
    from . import SampleBooks, Projects, Blueprint  # here: they import this module too
    remove(remember=False)
    users = []
    for name, email in DEMO_USERS:
        u = app_tables.users.get(email=email) or app_tables.users.add_row(email=email, enabled=False)
        u.update(display_name=name, is_demo=True, signed_up=C.now() - dt.timedelta(days=30))
        users.append(u)
    today = dt.date.today()
    for i, key in enumerate(EXAMPLE_ORDER):
        fname, data = SampleBooks.build(key, today)
        bp, problem = Projects.read_file(data, fname)
        if problem:
            print("demo %s: %s" % (key, problem))
            continue
        when = C.now() - dt.timedelta(days=3 * (len(EXAMPLE_ORDER) - i))
        app_tables.projects.add_row(owner=users[0], name=bp["app"]["title"], file_name=fname,
                                    file=anvil.BlobMedia("application/vnd.ms-excel.sheet.macroEnabled.12", data, name=fname),
                                    blueprint=Projects.pack(bp), summary=Blueprint.summary(bp), settings={},
                                    created=when, updated=when, downloads=[42, 27, 15][i], is_demo=True, example=key)
    C.set_setting("demo", "loaded")
    return counts()


def remove(remember=True):
    for name in DEMO_TABLES:
        for r in getattr(app_tables, name).search(is_demo=True):
            r.delete()
    for u in app_tables.users.search(is_demo=True):
        u.delete()
    if remember:
        C.set_setting("demo", "removed")
    return counts()


def counts():
    out = {"users": len(app_tables.users.search(is_demo=True))}
    for name in DEMO_TABLES:
        out[name] = len(getattr(app_tables, name).search(is_demo=True))
    return out
