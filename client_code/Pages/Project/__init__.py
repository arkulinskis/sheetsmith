from anvil import *
import anvil.server
from anvil.js import window

from ._anvil_designer import ProjectTemplate
from ... import router, ss, state, studio

TABS = ["overview", "screens", "rules", "macros", "preview", "get"]


def _fmt_size(n):
    return "%.1f MB" % (n / 1048576) if n > 1048576 else "%d KB" % max(1, round(n / 1024))


class Project(ProjectTemplate):
    """#project/<id>[/<tab>] and #project/draft: the studio. Shows what Sheetsmith found in the workbook, lets people
    adjust it (screens, columns, buttons, look, data, PIN), previews the real app and downloads the zip.
    Own projects save their settings as they change (studio.Studio); examples and drafts keep changes in this tab.
    Each tab is a Form in client_code/Studio, made fresh when the tab opens (like the old page redrew its body)."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
        self.pid = args[0] if args else ""
        self.tab = args[1] if len(args) > 1 and args[1] in TABS else "overview"
        self.tabs = {"overview": self.t_overview, "screens": self.t_screens, "rules": self.t_rules,
                     "macros": self.t_macros, "preview": self.t_preview, "get": self.t_get}
        state.heading(self.title, 1)
        state.live(self.saved)
        me = state.me()
        home = "#home" if me else "#landing"
        state.set_attr(self.back_link, "href", home)
        state.set_attr(self.error_back, "href", home)
        self.back_text.text = "Your projects" if me else "Sheetsmith"
        problem = self._load()
        self.error_part.visible = bool(problem)
        self.studio_part.visible = not problem
        if problem:
            self.error_text.text = problem
            return
        self.st.on_status = self._status
        self.st.on_title = self._header
        self.st.on_tab = self.set_tab
        self.st.on_redraw = self._body
        self._draw()

    def _load(self):
        """Fill self.st (studio.Studio). Returns a message when the project can't be opened."""
        if self.pid == "draft":
            d = ss.draft()
            if not d:
                return "That try-out has ended (it lived in the browser tab). Drop the workbook again to start over."
            bp = d["bp"]
            project = {"name": str(bp.app.title), "file_name": d["file"].name if d.get("file") else "workbook",
                       "can_edit": True, "demo": False}
            self.st = studio.Studio(project, bp, d["settings"], "draft")
            return None
        r = anvil.server.call("get_project", self.pid)
        if not r.get("ok"):
            return r.get("error") or "This project couldn't be opened."
        p = r["project"]
        mode = "own" if p.get("can_edit") else "example" if (p.get("demo") or p.get("example")) else "view"
        self.st = studio.Studio(p, ss.blueprint(r["blueprint"]), r.get("settings") or {}, mode)
        return None

    # ---------------------------------------------------------------- drawing
    def _draw(self):
        self._header()
        st, me = self.st, state.me()
        mode = st.mode
        self.more_button.visible = mode == "own"
        state.set_control_attr(self.more_button, "aria-label", "More")
        self.banner.visible = mode in ("draft", "example")
        if mode == "draft" and me:
            self.banner_lead.text, self.banner_text.text = "Not saved yet.", "Keep this project to come back to it, change it later and download new versions."
            self.banner_button.text, self.banner_button.role = "Save this project", ["btn", "btn-primary", "ic-check"]
        elif mode == "draft":
            self.banner_lead.text = "You're trying Sheetsmith."
            self.banner_text.text = "Nothing is stored: the workbook was read and set aside. Change anything, preview it and download it; sign up to keep the project."
            self.banner_button.text, self.banner_button.role = "Sign up to keep it", ["btn", "btn-primary"]
        elif mode == "example":
            self.banner_lead.text = "This is an example workbook"
            self.banner_text.text = "(made up). Try anything: your changes stay in this tab. Make your own copy to keep them."
            self.banner_button.text, self.banner_button.role = "Make my copy", ["btn", "btn-primary", "ic-copy"]
            self.banner_icon.classes.update({"ic-info": False, "ic-sparkle": True})
        self._body()

    def _header(self):
        st = self.st
        title = st.title()
        window.document.title = title + " · Studio · Sheetsmith"
        self.title.text = title
        self.mark.text = ss.initials(title)
        self.mark.background = st.color()
        f = st.bp.file if st.bp.file else None
        name = st.project.get("file_name") or (str(f.name) if f else "")
        size = int(f.size) if f and f.size else 0
        self.file_line.text = name + (" · " + _fmt_size(size) if size else "")
        self.saved.visible = st.mode == "own"
        if st.mode == "own" and not self.saved.text:
            self.saved.text = "Saved" if st.project.get("updated") else ""

    def _status(self, text):
        self.saved.text = text

    def _body(self):
        for name, el in self.tabs.items():
            el.classes["on"] = name == self.tab
            state.set_attr(el, "aria-current", "true" if name == self.tab else None)
        self.body.clear()
        if self.tab == "overview":
            from ...Studio.Overview import Overview
            self.body.add_component(Overview())
        elif self.tab == "screens":
            from ...Studio.Screens import Screens
            self.body.add_component(Screens())
        elif self.tab == "rules":
            from ...Studio.Rules import Rules
            self.body.add_component(Rules())
        elif self.tab == "macros":
            from ...Studio.Macros import Macros
            self.body.add_component(Macros())
        elif self.tab == "preview":
            from ...Studio.Preview import Preview
            self.body.add_component(Preview())
        else:
            from ...Studio.GetApp import GetApp
            self.body.add_component(GetApp())

    def set_tab(self, tab):
        self.tab = tab if tab in TABS else "overview"
        router.replace("project", self.pid, "" if self.tab == "overview" else self.tab)
        self._body()
        window.scrollTo(0, 0)

    def tab_click(self, event):
        self.set_tab(str(event.currentTarget.getAttribute("data-tab")))

    @handle("preview_button", "click")
    def preview_button_click(self, **event_args):
        self.set_tab("preview")

    @handle("get_button", "click")
    def get_button_click(self, **event_args):
        self.set_tab("get")

    @handle("", "hide")
    def form_hide(self, **event_args):
        st = getattr(self, "st", None)
        if st is not None:
            st.flush()

    # ---------------------------------------------------------------- banner: save the draft, sign up, copy an example
    @handle("banner_button", "click")
    def banner_button_click(self, **event_args):
        st = self.st
        if st.mode == "draft" and state.me():
            r = ss.save_draft(st.settings)
            if r:
                ss.set_draft(None)
                state.toast("Saved to your projects", "ok")
                router.go("project", r["id"])
        elif st.mode == "draft":
            router.remember_after("#project/draft")
            router.go("auth", "signup")
        elif st.mode == "example":
            if not state.me():
                router.remember_after(window.location.hash)
                state.toast("Sign up (free) to keep your own copy.")
                router.go("auth", "signup")
                return
            r = state.call("copy_project", st.project["id"])
            if r:
                if st.settings:
                    state.call_quiet("save_settings", r["id"], st.settings)
                state.toast("Your copy is ready", "ok")
                router.go("project", r["id"])

    # ---------------------------------------------------------------- more: rename, read again, undo changes, delete
    @handle("more_button", "click")
    def more_button_click(self, **event_args):
        from ...Dialogs.MoreMenu import MoreMenu
        st = self.st
        what = alert(MoreMenu(title=st.title()), buttons=[], role="app-dialog", dismissible=True)
        if what == "rename":
            from ...Dialogs.Rename import Rename
            name = alert(Rename(value=st.title()), buttons=[], role="app-dialog", dismissible=True)
            if name:
                r = state.call("rename_project", st.project["id"], name)
                if r:
                    st.settings["title"] = r["project"]["name"]
                    st.project = r["project"]
                    self._draw()
                    state.toast("Renamed", "ok")
        elif what == "reread":
            r = state.call("reread_project", st.project["id"])
            if r:
                st.bp = ss.blueprint(r["blueprint"])
                self._draw()
                state.toast("Read again with the newest reader", "ok")
        elif what == "reset":
            if confirm("Names, order, columns, buttons, colour and download options go back to what Sheetsmith found.",
                       title="Undo all your changes?", buttons=[("Cancel", False), ("Undo them", True)], role="app-dialog"):
                st.settings = {}
                st.changed(True)
                self._draw()
        elif what == "delete":
            if confirm("The workbook and your changes are deleted from Sheetsmith. Apps you already downloaded keep working.",
                       title="Delete this project?", buttons=[("Cancel", False), ("Delete", True)], role="app-dialog"):
                if state.call("delete_project", st.project["id"]) is not None:
                    state.toast("Deleted")
                    router.go("home")
