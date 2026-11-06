from anvil import *

from ._anvil_designer import ColorDotTemplate
from ... import state, studio


class ColorDot(ColorDotTemplate):
    """Get the app -> Colour: one ready-made colour (the first is the workbook's own)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        it = self.item
        self.dot.style["background"] = it["color"]
        self.dot.classes["on"] = bool(it.get("on"))
        state.set_attr(self.dot, "aria-label", it["label"])
        state.set_attr(self.dot, "title", it["label"])
        state.set_attr(self.dot, "aria-pressed", "true" if it.get("on") else "false")
        if studio.cur().read_only:
            state.set_attr(self.dot, "disabled", "")

    def dot_click(self, event):
        self.parent.raise_event("x-color", color=self.item["color"])
