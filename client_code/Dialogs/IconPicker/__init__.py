from anvil import *

from ._anvil_designer import IconPickerTemplate
from ... import ss


class IconPicker(IconPickerTemplate):
    """A screen's icon (Screens tab). Closes with the icon name, or None."""

    def __init__(self, current="", **properties):
        super().__init__(**properties)
        self.icons_panel.items = [{"name": n, "on": n == current} for n in ss.ICONS]
        self.icons_panel.add_event_handler("x-pick", self._pick)

    def _pick(self, name, **event_args):
        self.raise_event("x-close-alert", value=name)
