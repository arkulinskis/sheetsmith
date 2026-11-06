from anvil import *

from ._anvil_designer import ChipTemplate


class Chip(ChipTemplate):
    """A small grey pill (project cards: "3 tables", "50 formulas" ...). item = {text}."""

    def __init__(self, **properties):
        super().__init__(**properties)
