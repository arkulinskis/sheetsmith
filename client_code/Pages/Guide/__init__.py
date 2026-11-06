from anvil import *
import anvil.js
from anvil.js import window

from ._anvil_designer import GuideTemplate
from ... import router, ss

SECTIONS = ["what", "screens", "formulas", "vba", "network", "limits"]
OBJECTS = ["Application", "Workbook", "Sheets", "Worksheet", "Range", "ListObject", "ListRows", "ListRow", "ListColumns",
           "ListColumn", "Dictionary", "Collection", "ErrObject"]
HIDDEN_VBA = {"shell", "dir", "freefile", "getobject", "curdir"}


def nice(k):
    return k[:1].upper() + k[1:]


class Guide(GuideTemplate):
    """#guide[/section]: what converts, the formula functions and the VBA that runs (both listed live from the engine,
    SE.FUNCTIONS and SE.vba.TYPES / BUILTINS, so this page never goes out of date), running on a network, limits."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
        fns = [str(f) for f in ss.SE.FUNCTIONS]
        self.fn_line.text = ("The app calculates formulas itself, in the browser, so they work offline. These %d "
                             "functions are supported:" % len(fns))
        self.functions_list.names = fns
        types = ss.SE.vba.TYPES
        objs = []
        for n in OBJECTS:
            t = types[n] if window.Object.prototype.hasOwnProperty.call(types, n) else None
            if t:
                objs.append({"name": n, "members": sorted(nice(str(k)) for k in window.Object.keys(t.members))})
        self.objects_panel.items = objs
        self.vba_list.names = [nice(str(k)) for k in sorted(window.Object.keys(ss.SE.vba.BUILTINS)) if str(k) not in HIDDEN_VBA]
        self._sec = args[0] if args and args[0] in SECTIONS else None
        self.dom_nodes["nav"].addEventListener("click", self._nav)

    def _nav(self, event):
        a = event.target.closest("[data-sec]")
        if not a:
            return
        event.preventDefault()
        sec = a.getAttribute("data-sec")
        self._scroll(sec, True)
        router.replace("guide", sec)

    def _scroll(self, sec, smooth=False):
        el = anvil.js.get_dom_node(self).querySelector("#gd-" + sec)
        if el:
            el.scrollIntoView({"behavior": "smooth"} if smooth else {})

    @handle("", "show")
    def form_show(self, **event_args):
        if self._sec:
            window.setTimeout(lambda: self._scroll(self._sec), 50)
