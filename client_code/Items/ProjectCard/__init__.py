from anvil import *

from ._anvil_designer import ProjectCardTemplate
from ... import router, ss, state


class ProjectCard(ProjectCardTemplate):
    """A project or an example (Home, Landing). item = a project dict from get_projects. The whole card links to
    #project/<id>."""

    def __init__(self, **properties):
        super().__init__(**properties)
        p = self.item
        s = p.get("summary") or {}
        state.set_attr(self.card, "href", router.href("project", p["id"]))
        state.set_attr(self.card, "aria-label", "Open %s" % p["name"])
        self.mark.text = ss.initials(p["name"])
        self.mark.background = ss.example_color(p.get("example"))
        blurb = ss.example_blurb(p.get("example")) if p.get("example") else ""
        self.blurb.text = blurb
        self.blurb.visible = bool(blurb)
        tables = (s.get("tables") or 0) + (s.get("lists") or 0)
        chips = [state.plural(tables, "table") if tables else "", state.plural(s["formulas"], "formula") if s.get("formulas") else "",
                 state.plural(s["procedures"], "macro") if s.get("procedures") else "", state.plural(s["rules"], "rule") if s.get("rules") else ""]
        self.chips.text = " · ".join(c for c in chips if c)
        self.chips.visible = bool(self.chips.text)
        self.when.text = "Example" if p.get("example") else "Changed " + state.ago(p.get("updated"))
        self.downloads.text = str(p.get("downloads") or 0)
        state.set_attr(self.downloads, "aria-label", state.plural(p.get("downloads") or 0, "download"))
