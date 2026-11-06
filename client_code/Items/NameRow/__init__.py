from anvil import *

from ._anvil_designer import NameRowTemplate


class NameRow(NameRowTemplate):
    """Studio -> Rules: one named range."""

    def __init__(self, **properties):
        super().__init__(**properties)
