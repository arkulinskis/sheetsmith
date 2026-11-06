from anvil import *

from ._anvil_designer import MacrosTemplate
from ... import state, studio


class Macros(MacrosTemplate):
    """Studio -> Macros: how much of the VBA runs, then every module with its procedures (Items/ModuleCard)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        v = studio.cur().view("macros")
        self.empty.visible = not v["hasVba"]
        self.has_part.visible = v["hasVba"]
        if not v["hasVba"]:
            return
        p_ok, p_part = v["pOk"], v["pPart"]
        self.ring.style["background"] = ("conic-gradient(var(--c-good) 0 %s%%, var(--c-accent) %s%% %s%%, var(--c-bad) %s%% 100%%)"
                                         % (p_ok, p_ok, p_ok + p_part, p_ok + p_part))
        self.score.text = "%d%%" % v["score"]
        self.headline.text = "%d of %d procedures run as they are" % (v["ok"], v["total"])
        state.heading(self.headline, 2)
        self.l_ok.text = "Runs (%d)" % v["ok"]
        self.l_part.text = "Partly (%d)" % v["partial"]
        self.l_no.text = "Won't run (%d)" % v["no"]
        self.modules_panel.items = v["modules"]
