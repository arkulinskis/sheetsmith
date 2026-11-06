from anvil import *

from ._anvil_designer import ScreensTemplate
from ... import state, studio


class Screens(ScreensTemplate):
    """Studio -> Screens: one card per screen (Items/ScreenEdit) with its name, icon, order, columns and types."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.screens_panel.add_event_handler("x-redraw", self._draw)
        self._draw()

    def _draw(self, focus=None, **event_args):
        st = studio.cur()
        screens = st.view("screens")
        for i, s in enumerate(screens):
            s["first"], s["last"] = i == 0, i == len(screens) - 1
        self.screens_panel.items = screens
        if focus:
            state.refocus(self.screens_panel, focus)
