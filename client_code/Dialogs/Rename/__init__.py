from anvil import *

from ._anvil_designer import RenameTemplate
from ... import state


class Rename(RenameTemplate):
    """Ask for a project's new name. Closes with the name, or None."""

    def __init__(self, value="", **properties):
        super().__init__(**properties)
        self.name_box.text = value
        state.set_control_attr(self.name_box, "maxlength", 80)

    @handle("", "show")
    def form_show(self, **event_args):
        self.name_box.focus()

    @handle("name_box", "pressed_enter")
    def name_box_pressed_enter(self, **event_args):
        self.save_button_click()

    @handle("save_button", "click")
    def save_button_click(self, **event_args):
        name = (self.name_box.text or "").strip()
        if len(name) < 2:
            self.problem.text, self.problem.visible = "Give it a name (at least 2 characters).", True
            return
        self.raise_event("x-close-alert", value=name)

    @handle("cancel_button", "click")
    def cancel_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=None)
