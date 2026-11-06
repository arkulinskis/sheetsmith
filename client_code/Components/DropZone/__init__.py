from anvil import *
import anvil.js

from ._anvil_designer import DropZoneTemplate
from ... import ss


class DropZone(DropZoneTemplate):
    """Drop or choose a workbook. SS.dropzone (ss-builder.js) does the dragging and checks the file; this raises
    file_chosen with the browser File for the page to read (ss.read_workbook)."""

    def __init__(self, **properties):
        self._title, self._sub = "Drop a workbook here", ".xlsx or .xlsm, up to 12 MB."
        super().__init__(**properties)
        ss.SS.dropzone(self.dom_nodes["zone"], anvil.js.report_exceptions(self._take))
        self._draw()

    def _take(self, file):
        self.raise_event("file_chosen", file=file)

    def _draw(self):
        nodes = getattr(self, "dom_nodes", None)
        if nodes:
            nodes["title_el"].textContent = self._title
            nodes["sub_el"].textContent = self._sub

    @property
    def title(self):
        return self._title

    @title.setter
    def title(self, value):
        self._title = value or ""
        self._draw()

    @property
    def sub(self):
        return self._sub

    @sub.setter
    def sub(self, value):
        self._sub = value or ""
        self._draw()
