from anvil import *

from ._anvil_designer import VbaObjectTemplate


class VbaObject(VbaObjectTemplate):
    """Guide -> VBA macros -> Objects: one object (Range, Worksheet ...) and the members that run."""

    def __init__(self, **properties):
        super().__init__(**properties)
