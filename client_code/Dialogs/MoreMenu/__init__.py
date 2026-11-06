from anvil import *

from ._anvil_designer import MoreMenuTemplate
from ... import state


class MoreMenu(MoreMenuTemplate):
    """The studio's More menu (own projects). Closes with "rename", "reread", "reset" or "delete"; the page does it."""

    def __init__(self, title="", **properties):
        super().__init__(**properties)
        self.heading.text = title
        state.heading(self.heading, 2)

    def _pick(self, what):
        self.raise_event("x-close-alert", value=what)

    @handle("rename_button", "click")
    def rename_button_click(self, **event_args):
        self._pick("rename")

    @handle("reread_button", "click")
    def reread_button_click(self, **event_args):
        self._pick("reread")

    @handle("reset_button", "click")
    def reset_button_click(self, **event_args):
        self._pick("reset")

    @handle("delete_button", "click")
    def delete_button_click(self, **event_args):
        self._pick("delete")
