from anvil import *

from ._anvil_designer import StatTileTemplate


class StatTile(StatTileTemplate):
    """Overview: one count (sheets, tables, formulas, rules, macros) with a note; kind good/warn colours the note."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.n.text = str(self.item["n"])
        kind = self.item.get("kind") or ""
        self.box.classes.update({"good": kind == "good", "warn": kind == "warn"})
