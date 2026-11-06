from anvil import *

from ._anvil_designer import ProjectRowTemplate
from ... import router, state


class ProjectRow(ProjectRowTemplate):
    """Admin -> Projects: one saved project. Delete asks, then raises x-changed so the page reloads the list."""

    def __init__(self, **properties):
        super().__init__(**properties)
        p = self.item
        s = p.get("summary") or {}
        state.set_attr(self.link, "href", router.href("project", p["id"]))
        tables = (s.get("tables") or 0) + (s.get("lists") or 0)
        bits = [state.plural(tables, "table") if s.get("tables") else "", state.plural(s["formulas"], "formula") if s.get("formulas") else "",
                state.plural(s["procedures"], "macro") if s.get("procedures") else ""]
        self.summary.text = " · ".join(b for b in bits if b)
        self.size.text = "%d KB" % max(1, round((p.get("size") or 0) / 1024))
        self.changed.text = state.ago(p.get("updated"))
        self.downloads.text = str(p.get("downloads") or 0)
        state.set_control_attr(self.delete_button, "aria-label", "Delete %s" % p["name"])

    @handle("delete_button", "click")
    def delete_button_click(self, **event_args):
        if confirm("The workbook and its settings are deleted for its owner too.", title="Delete this project?",
                   buttons=[("Cancel", False), ("Delete", True)], role="app-dialog"):
            if state.call("admin_delete_project", self.item["id"]) is not None:
                state.toast("Deleted", "ok")
                self.parent.raise_event("x-changed")
