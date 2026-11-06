from anvil import *

from ... import state
from ._anvil_designer import FnChipTemplate


class FnChip(FnChipTemplate):
    """Studio -> Rules -> Formulas: one function the workbook uses, how often, and whether it's supported."""

    def __init__(self, **properties):
        super().__init__(**properties)
        kind = self.item["kind"]
        self.n.text = str(self.item["n"])
        self.chip.classes.update({"no": kind == "no", "udf": kind == "udf"})
        self.icon.classes.add("ic-x" if kind == "no" else "ic-check")
        state.set_attr(self.chip, "title", self.item.get("title"))
