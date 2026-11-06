from anvil import *

from ._anvil_designer import ScreenCardTemplate


class ScreenCard(ScreenCardTemplate):
    """Overview: one screen of the app (shown or hidden)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        hidden = bool(self.item.get("hidden"))
        self.icon.classes.add("ic-" + (self.item.get("icon") or "table"))
        self.box.classes["off"] = hidden
        self.badge.text = "Hidden" if hidden else "Shown"
        self.badge.role = ["badge"] if hidden else ["badge", "badge-good"]
