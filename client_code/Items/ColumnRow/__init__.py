from anvil import *

from ._anvil_designer import ColumnRowTemplate
from ... import ss, state, studio


class ColumnRow(ColumnRowTemplate):
    """Studio -> Screens -> a table screen: one column (label, type, shown). item = {sc, name, label, type, hidden}."""

    def __init__(self, **properties):
        super().__init__(**properties)
        it = self.item
        formula = it["type"] == "formula"
        self.label_box.text = it["label"]
        self.type_dd.items = [("Calculated", "formula")] if formula else ss.TYPES
        self.type_dd.selected_value = it["type"] if formula or it["type"] in [v for _, v in ss.TYPES] else "text"
        self.type_dd.enabled = not formula
        self.show_box.checked = not it.get("hidden")
        state.set_control_attr(self.label_box, "aria-label", "Label for %s" % it["name"])
        state.set_control_attr(self.label_box, "maxlength", 40)
        state.set_control_attr(self.type_dd, "aria-label", "Type of %s" % it["name"])
        state.set_control_attr(self.show_box, "aria-label", "Show %s" % it["name"])
        if studio.cur().read_only:
            self.label_box.enabled = self.type_dd.enabled = self.show_box.enabled = False

    @handle("label_box", "change")
    def label_box_change(self, **event_args):
        studio.cur().col_set(self.item["sc"], self.item["name"], "label", (self.label_box.text or "").strip())

    @handle("type_dd", "change")
    def type_dd_change(self, **event_args):
        studio.cur().col_set(self.item["sc"], self.item["name"], "type", self.type_dd.selected_value)

    @handle("show_box", "change")
    def show_box_change(self, **event_args):
        studio.cur().col_set(self.item["sc"], self.item["name"], "hidden", not self.show_box.checked)
