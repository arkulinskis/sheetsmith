from anvil import *

from ._anvil_designer import OverviewTemplate
from ... import studio


class Overview(OverviewTemplate):
    """Studio -> Overview: the counts, the screens the app will have, and notes on what won't come across."""

    def __init__(self, **properties):
        super().__init__(**properties)
        st = studio.cur()
        v = st.view("overview")
        self.stats_panel.items = v["stats"]
        self.screens_panel.items = v["screens"]
        self.notes_panel.items = v["notes"]
        self.dom_nodes["screens_link"].addEventListener("click", self._screens)

    def _screens(self, event):
        event.preventDefault()
        studio.cur().goto("screens")

    @handle("preview_button", "click")
    def preview_button_click(self, **event_args):
        studio.cur().goto("preview")

    @handle("get_button", "click")
    def get_button_click(self, **event_args):
        studio.cur().goto("get")
