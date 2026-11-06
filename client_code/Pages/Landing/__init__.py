from anvil import *
import anvil.js

from ._anvil_designer import LandingTemplate
from ... import router, ss, state

# The app's video on the Addanapp YouTube channel (APP_MAKER/youtube/manifest.json), shown in the Watch section.
YT_VIDEO = "KvFAg0fOglU"


class Landing(LandingTemplate):
    """#landing (Persuade): the promise with a drop zone (visitors try a workbook without an account: inspect_workbook
    reads it without saving and the studio opens on #project/draft), the before/after slider, the Watch section, the
    examples, how it works, what converts, the server, questions. Static copy lives in the template."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
        me = state.me()
        self.signup_link.visible = not me
        self.projects_link.visible = bool(me)
        if me:
            self.drop.title, self.drop.sub = "Drop a workbook to start", ".xlsx or .xlsm, up to 12 MB."
            state.set_attr(self.band_link, "href", "#home")
            anvil.js.get_dom_node(self.band_link).textContent = "Open your projects"
        n = int(ss.SE.FUNCTIONS.length) // 10 * 10
        self.fn_count.text = "More than %d Excel functions" % n
        self.drop.add_event_handler("file_chosen", self._file)
        self.dom_nodes["ba_range"].addEventListener("input", self._slide)
        self.dom_nodes["yt_cover"].addEventListener("click", self._play)
        d = state.call_quiet("get_projects") or {"examples": []}
        self.examples_panel.items = d["examples"]
        self.no_examples.visible = not d["examples"]

    def _slide(self, event):
        self.dom_nodes["ba"].style.setProperty("--x", str(event.target.value) + "%")

    def _play(self, event):
        """Swap the video's cover for YouTube's player (privacy-enhanced); nothing loads from YouTube before this click."""
        self.dom_nodes["yt_frame"].innerHTML = (
            '<iframe src="https://www.youtube-nocookie.com/embed/' + YT_VIDEO + '?autoplay=1&rel=0&playsinline=1" '
            'title="Sheetsmith video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen '
            'referrerpolicy="strict-origin-when-cross-origin"></iframe>')

    def _file(self, file, **event_args):
        if state.me():
            r = ss.read_workbook(file, keep=True)
            if r:
                router.go("project", r["id"])
            return
        r = ss.read_workbook(file, keep=False)
        if r:
            ss.set_draft({"bp": ss.blueprint(r["blueprint"]), "file": file, "settings": {}})
            router.go("project", "draft")
