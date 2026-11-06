from anvil import *

from ._anvil_designer import PreviewTemplate
from ... import ss, state, studio

_view: dict = {"device": "desktop", "theme": "light"}  # kept while the studio is open (like the old page)


class Preview(PreviewTemplate):
    """Studio -> Preview: the real generated app (SS.previewHtml) running in an iframe, as a computer or a phone, light
    or dark. Nothing here is saved."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.failed.visible = False
        self._marks()

    def _marks(self):
        self.d_desktop.classes["on"] = _view["device"] == "desktop"
        self.d_phone.classes["on"] = _view["device"] == "phone"
        self.p_light.classes["on"] = _view["theme"] == "light"
        self.p_dark.classes["on"] = _view["theme"] == "dark"
        self.stage.classes.update({"desktop": _view["device"] == "desktop", "phone": _view["device"] == "phone"})

    def _load(self):
        st = studio.cur()
        problem = ss.SS.loadPreview(self.dom_nodes["frame"], st.bp, st.js_settings(), _view["theme"])
        self.failed.visible = bool(problem)
        self.stage.visible = not problem
        self.fail_text.text = str(problem or "")

    @handle("", "show")
    def form_show(self, **event_args):
        self._load()

    def device_click(self, event):
        _view["device"] = str(event.currentTarget.getAttribute("data-v"))
        self._marks()

    def theme_click(self, event):
        _view["theme"] = str(event.currentTarget.getAttribute("data-v"))
        self._marks()
        self._load()

    @handle("reload_button", "click")
    def reload_button_click(self, **event_args):
        self._load()

    @handle("newtab_button", "click")
    def newtab_button_click(self, **event_args):
        st = studio.cur()
        if not ss.SS.openPreview(st.bp, st.js_settings()):
            state.toast("Your browser blocked the new window.", "error")
