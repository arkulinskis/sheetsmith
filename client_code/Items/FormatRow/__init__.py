from anvil import *
import anvil.js

from ._anvil_designer import FormatRowTemplate


class FormatRow(FormatRowTemplate):
    """Studio -> Rules: one conditional format rule, with a swatch of its look (the workbook's own colours)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        sw = self.item["swatch"]
        node = anvil.js.get_dom_node(self.swatch)
        node.style.background = sw.get("background") or "transparent"
        if sw.get("color"):
            node.style.color = sw["color"]
        if sw.get("bold"):
            node.style.fontWeight = "800"
        if sw.get("strike"):
            node.style.textDecoration = "line-through"
        node.setAttribute("data-text", sw.get("text") or "")  # drawn by CSS (::after): the workbook's own colours, not text to read
        node.setAttribute("role", "img")
        node.setAttribute("aria-label", "How it looks")
