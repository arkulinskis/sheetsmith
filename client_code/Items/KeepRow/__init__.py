from anvil import *

from ._anvil_designer import KeepRowTemplate
from ... import state, studio


class KeepRow(KeepRowTemplate):
    """Get the app -> Start with: keep a table's rows in the downloaded app (or start it empty)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        it = self.item
        self.keep_box.text = "%s: keep its %s" % (it["name"], state.plural(it["rows"], "row"))
        self.keep_box.checked = bool(it.get("keep"))
        self.keep_box.enabled = not studio.cur().read_only

    @handle("keep_box", "change")
    def keep_box_change(self, **event_args):
        self.parent.raise_event("x-keep", name=self.item["name"], on=self.keep_box.checked)
