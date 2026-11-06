"""The studio's state while #project/<id> is open: the blueprint (a JS object), the person's choices (settings, a
Python dict saved with save_settings), and who may change what. Pages/Project makes one; its tab Forms and their
items reach it with studio.cur().

    mode   "own"     the person's project: changes save themselves (700 ms after the last one)
           "example" an example: changes stay in this tab until they make their own copy
           "draft"   a workbook tried without saving: changes live with the draft (ss.draft())
           "view"    someone else's project (admins): read-only
"""
import anvil.js
from anvil.js import window

from . import ss, state

_cur: dict = {"s": None}


def cur():
    return _cur["s"]


class Studio:
    def __init__(self, project, bp, settings, mode):
        self.project = project
        self.bp = bp  # JS object (ss.blueprint)
        self.settings: dict = settings or {}
        self.mode = mode
        self.on_status = None  # page: show "Saving..." / "Saved 14:02"
        self.on_title = None  # page: redraw the header (name, colour)
        self.on_tab = None  # page: switch tab
        self.on_redraw = None  # page: draw the current tab again
        self._timer = None
        _cur["s"] = self

    # ---- reading
    @property
    def read_only(self):
        return self.mode == "view"

    def bp_app(self, key):
        return self.bp.app[key]

    def title(self):
        return self.settings.get("title") or str(self.bp.app.title)

    def color(self):
        return self.settings.get("color") or str(self.bp.app.color)

    def js_settings(self):
        return ss.js(self.settings)

    def view(self, name):
        """SS.<name>View(bp, settings) as plain Python."""
        return ss.py(getattr(ss.SS, name + "View")(self.bp, self.js_settings()))

    # ---- changing
    def changed(self, immediate=False):
        if self.mode == "draft":
            d = ss.draft()
            if d:
                d["settings"] = self.settings
            return
        if self.mode != "own":
            return
        if self._timer is not None:
            window.clearTimeout(self._timer)
        self._status("Saving…")
        self._timer = window.setTimeout(self._save, 0 if immediate else 700)

    def _save(self):
        self._timer = None
        r = state.call_quiet("save_settings", self.project["id"], self.settings)
        if isinstance(r, dict) and r.get("ok"):
            now = anvil.js.new(window.Date)
            self._status("Saved " + str(now.toLocaleTimeString([], {"hour": "2-digit", "minute": "2-digit"})))
        else:
            self._status("Not saved")
            state.toast((r or {}).get("error") or "Your changes couldn't be saved. Check your connection.", "error")

    def flush(self):
        """Save now if a save is waiting (leaving the page)."""
        if self._timer is not None:
            window.clearTimeout(self._timer)
            self._save()

    def _status(self, text):
        if self.on_status:
            self.on_status(text)

    def sc_set(self, sc_id, key, value):
        screens = self.settings.setdefault("screens", {})
        screens.setdefault(sc_id, {})[key] = value
        self.changed()

    def col_set(self, sc_id, col, key, value):
        screens = self.settings.setdefault("screens", {})
        cols = screens.setdefault(sc_id, {}).setdefault("columns", {})
        cols.setdefault(col, {})[key] = value
        self.changed()

    def act_set(self, macro, key, value):
        acts = self.settings.setdefault("actions", {})
        acts.setdefault(macro, {})[key] = value
        self.changed()

    def move_screen(self, sc_id, step):
        ids = [s["id"] for s in self.view("screens")]
        if sc_id not in ids:
            return
        i = ids.index(sc_id)
        j = i + step
        if j < 0 or j >= len(ids):
            return
        ids[i], ids[j] = ids[j], ids[i]
        screens = self.settings.setdefault("screens", {})
        for k, s in enumerate(ids):
            screens.setdefault(s, {})["order"] = k
        self.changed()

    def set_title_or_color(self):
        self.changed()
        if self.on_title:
            self.on_title()

    def goto(self, tab):
        if self.on_tab:
            self.on_tab(tab)

    def redraw(self):
        if self.on_redraw:
            self.on_redraw()
