from anvil import *

from ._anvil_designer import IconChoiceTemplate
from ... import state


class IconChoice(IconChoiceTemplate):
    """One icon in the icon picker."""

    def __init__(self, **properties):
        super().__init__(**properties)
        name = self.item["name"]
        self.pick_button.text = name
        self.pick_button.role = ["st-icon", "btn-icon", "ic-" + name] + (["on"] if self.item.get("on") else [])
        state.set_control_attr(self.pick_button, "aria-label", name)
        state.set_control_attr(self.pick_button, "aria-pressed", "true" if self.item.get("on") else "false")

    @handle("pick_button", "click")
    def pick_button_click(self, **event_args):
        self.parent.raise_event("x-pick", name=self.item["name"])
