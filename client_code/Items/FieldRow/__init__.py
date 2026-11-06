from anvil import *

from ._anvil_designer import FieldRowTemplate


class FieldRow(FieldRowTemplate):
    """Studio -> Screens -> a form screen: one field (people fill it in, or it's calculated)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        if self.item.get("input"):
            self.kind.text, self.kind.role = "People fill it in", ["badge", "badge-brand", "ic-edit"]
        else:
            self.kind.text, self.kind.role = "Calculated", ["badge", "ic-sparkle"]
