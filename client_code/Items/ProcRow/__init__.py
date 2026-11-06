from anvil import *

from ._anvil_designer import ProcRowTemplate
from ... import state, studio


class ProcRow(ProcRowTemplate):
    """Studio -> Macros: one procedure: runs / partly / won't run, what it is (button, event, function), the problems,
    and for buttons the label and whether the app shows it (studio.cur().act_set)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        it = self.item
        s = it["status"]
        self.chip.text = {"ok": "Runs", "partial": "Partly"}.get(s, "Won't run")
        self.chip.role = ["badge", {"ok": "badge-good", "partial": "badge-warn"}.get(s, "badge-bad")] + (["ic-check"] if s == "ok" else [])
        self.issues.text = "\n".join(it["issues"])
        self.issues.visible = bool(it["issues"])
        a = it.get("action")
        self.act_part.visible = bool(a)
        if a:
            self.label_box.text = a["label"]
            self.act_box.checked = not a.get("hidden")
            state.set_control_attr(self.label_box, "aria-label", "Button label for %s" % it["name"])
            state.set_control_attr(self.label_box, "maxlength", 40)
            if studio.cur().read_only:
                self.label_box.enabled = self.act_box.enabled = False

    @handle("label_box", "change")
    def label_box_change(self, **event_args):
        studio.cur().act_set(self.item["action"]["macro"], "label", (self.label_box.text or "").strip())

    @handle("act_box", "change")
    def act_box_change(self, **event_args):
        studio.cur().act_set(self.item["action"]["macro"], "hidden", not self.act_box.checked)
