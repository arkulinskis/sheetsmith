from anvil import *

from ._anvil_designer import HomeTemplate
from ... import router, ss, state


class Home(HomeTemplate):
    """#home: the signed-in person's projects, a drop zone to add one, and the examples."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
        state.heading(self.hello, 1)
        d = state.call("get_projects") or {"mine": [], "examples": []}
        me = state.me() or {}
        first = (me.get("name") or "there").split(" ")[0]
        self.hello.text = "Your projects" if d["mine"] else "Hello, %s" % first
        self.count.text = (state.plural(len(d["mine"]), "workbook") + " turned into apps." if d["mine"]
                           else "Drop in a workbook to start your first app.")
        self.mine_panel.items = d["mine"]
        self.mine_part.visible = bool(d["mine"])
        self.examples_panel.items = d["examples"]
        self.examples_part.visible = bool(d["examples"])
        self.drop.add_event_handler("file_chosen", self._file)

    def _file(self, file, **event_args):
        r = ss.read_workbook(file, keep=True)
        if r:
            state.toast("Read " + str(file.name), "ok")
            router.go("project", r["id"])
