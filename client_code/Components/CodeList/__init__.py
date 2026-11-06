from anvil import *
from anvil.js import window

from ._anvil_designer import CodeListTemplate


class CodeList(CodeListTemplate):
    """A row of <code> chips from a list of names (display only)."""

    def __init__(self, **properties):
        self._names = []
        super().__init__(**properties)
        self._draw()

    def _draw(self):
        nodes = getattr(self, "dom_nodes", None)
        if not nodes:
            return
        box = nodes["box"]
        box.textContent = ""
        doc = window.document
        for n in self._names or []:
            c = doc.createElement("code")
            c.textContent = str(n)
            box.appendChild(c)

    @property
    def names(self):
        return self._names

    @names.setter
    def names(self, value):
        self._names = list(value or [])
        self._draw()
