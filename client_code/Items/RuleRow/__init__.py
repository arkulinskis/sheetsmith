from anvil import *

from ._anvil_designer import RuleRowTemplate


class RuleRow(RuleRowTemplate):
    """Studio -> Rules: one data validation rule."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.hint.text = ("Hint: " + self.item["hint"]) if self.item.get("hint") else ""
        self.hint.visible = bool(self.item.get("hint"))
