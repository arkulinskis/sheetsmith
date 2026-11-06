from anvil import *

from ._anvil_designer import ModuleCardTemplate
from ... import ss, state, studio


class ModuleCard(ModuleCardTemplate):
    """Studio -> Macros: one VBA module, its procedures (Items/ProcRow) and, on demand, its code with the lines that
    won't run marked (SS.codeHtml: escaped, coloured by the engine)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        state.heading(self.name, 3)
        self.procs_panel.items = self.item["procs"]
        self._open = False
        code = self.dom_nodes["code"]
        code.setAttribute("aria-label", "Code of %s" % self.item["name"])

    @handle("code_button", "click")
    def code_button_click(self, **event_args):
        self._open = not self._open
        code = self.dom_nodes["code"]
        if self._open and not code.innerHTML:
            code.innerHTML = ss.SS.codeHtml(studio.cur().bp, self.item["name"])
        code.hidden = not self._open
        self.code_button.text = "Hide code" if self._open else "Show code"
