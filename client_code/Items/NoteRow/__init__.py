from anvil import *

from ._anvil_designer import NoteRowTemplate


class NoteRow(NoteRowTemplate):
    """Overview -> Good to know: one note (warn: something won't come across, info, good)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        kind = self.item.get("kind")
        self.icon.classes.add({"good": "ic-check", "info": "ic-info"}.get(kind, "ic-bug"))
        self.box.classes["good"] = kind == "good"
