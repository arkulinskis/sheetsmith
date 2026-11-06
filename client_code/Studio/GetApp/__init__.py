import re

from anvil import *
from anvil.js import window

from ._anvil_designer import GetAppTemplate
from ... import ss, state, studio

STEPS = {
    "win": ["Unzip it", "Right-click the zip > Extract All. Put the folder on the computer that will share the app.",
            "Double-click \"Start (Windows).bat\"",
            "If Windows asks whether Python may use the network, tick Private networks and click Allow. No Python yet? It opens the download page."],
    "mac": ["Unzip it", "Double-click the zip. Keep the folder on the Mac that will share the app.", "Double-click start.command",
            "The first time, right-click it and choose Open (macOS asks before running files from the internet)."],
    "linux": ["Unzip it", "unzip the file on the computer or Raspberry Pi that will share the app.", "Start the server",
              "In a terminal, in the folder:"],
}


def _default_os():
    p = str(window.navigator.platform or "")
    return "mac" if "Mac" in p else "linux" if "Linux" in p else "win"


class GetApp(GetAppTemplate):
    """Studio -> Get the app: name, line under it, colour, which tables keep their rows, macros/events/view only, PIN and
    port; the download (SS.download: the zip, or just index.html); how to run it on Windows, Mac or Linux."""

    def __init__(self, **properties):
        super().__init__(**properties)
        st = studio.cur()
        state.set_control_attr(self.title_box, "maxlength", 80)
        state.set_control_attr(self.subtitle_box, "maxlength", 80)
        state.set_control_attr(self.pin_box, "maxlength", 12)
        state.set_control_attr(self.pin_box, "inputmode", "numeric")
        state.set_control_attr(self.port_box, "min", 1024)
        state.set_control_attr(self.port_box, "max", 65535)
        self.colors_panel.add_event_handler("x-color", self._color)
        self.keep_panel.add_event_handler("x-keep", self._keep)
        self.dom_nodes["color_pick"].addEventListener("change", self._picked)
        self._os = state.store_get("os", None) or _default_os()
        self._fill()
        if st.read_only:
            for c in (self.title_box, self.subtitle_box, self.macros_box, self.events_box, self.readonly_box, self.pin_box, self.port_box):
                c.enabled = False
            self.dom_nodes["color_pick"].disabled = True

    def _fill(self):
        st = studio.cur()
        v = st.view("get")
        self.v = v
        self.title_box.text = v["title"]
        self.subtitle_box.text = v["subtitle"]
        self.subtitle_box.placeholder = "Made from " + v["fileName"]
        self.colors_panel.items = v["colors"]
        self.dom_nodes["color_pick"].value = v["color"].lower()
        self.keep_panel.items = v["tables"]
        self.no_tables.visible = not v["tables"]
        self.macros_box.checked, self.events_box.checked, self.readonly_box.checked = v["macros"], v["events"], v["readOnly"]
        self.pin_box.text = v["pin"]
        self.port_box.text = str(v["port"])
        self._steps()

    def _steps(self):
        v, os_ = self.v, self._os
        for name, el in (("win", self.os_win), ("mac", self.os_mac), ("linux", self.os_linux)):
            el.classes["on"] = name == os_
        s = STEPS[os_]
        self.s1h.text, self.s1p.text, self.s2h.text, self.s2p.text = s
        state.heading(self.s1h, 3)
        state.heading(self.s2h, 3)
        port = v["port"]
        self.addr.text = "http://192.168.1.20:%s" % port
        term = self.dom_nodes["term"]
        term.textContent = ""
        prompt = window.document.createElement("span")
        prompt.className = "g"
        prompt.textContent = ("C:\\Apps\\%s>" % v["slug"]) if os_ == "win" else "$"
        term.appendChild(prompt)
        cmd = " python server.py" if os_ == "win" else " python3 server.py"
        term.appendChild(window.document.createTextNode(
            cmd + "\n\n  %s is running.\n    On this computer:   http://localhost:%s/\n    On your network:    "
            "http://192.168.1.20:%s/   <- open this on phones\n" % (v["title"], port, port)))
        (self.dom_nodes["step2"] if os_ == "linux" else self.dom_nodes["after"]).appendChild(term)

    # ---- changes
    def _changed(self, header=False):
        st = studio.cur()
        if header:
            st.set_title_or_color()
        else:
            st.changed()

    @handle("title_box", "change")
    def title_box_change(self, **event_args):
        st = studio.cur()
        t = (self.title_box.text or "").strip()
        if t:
            st.settings["title"] = t
        else:
            st.settings.pop("title", None)
        self._changed(header=True)
        self.v["title"] = st.title()
        self.v["slug"] = str(ss.SS.slug(st.title()))
        self._steps()

    @handle("subtitle_box", "change")
    def subtitle_box_change(self, **event_args):
        studio.cur().settings["subtitle"] = (self.subtitle_box.text or "").strip()
        self._changed()

    @handle("pin_box", "change")
    def pin_box_change(self, **event_args):
        studio.cur().settings["pin"] = re.sub(r"\D", "", self.pin_box.text or "")[:12]
        self._changed()

    @handle("port_box", "lost_focus")
    def port_box_lost_focus(self, **event_args):
        try:
            port = int(self.port_box.text or 8080)
        except (TypeError, ValueError):
            port = 8080
        port = max(1024, min(65535, port))
        self.port_box.text = str(port)
        studio.cur().settings["port"] = port
        self.v["port"] = port
        self._changed()
        self._steps()

    @handle("macros_box", "change")
    def macros_box_change(self, **event_args):
        studio.cur().settings["macros"] = self.macros_box.checked
        self._changed()

    @handle("events_box", "change")
    def events_box_change(self, **event_args):
        studio.cur().settings["events"] = self.events_box.checked
        self._changed()

    @handle("readonly_box", "change")
    def readonly_box_change(self, **event_args):
        studio.cur().settings["readOnly"] = self.readonly_box.checked
        self._changed()

    def _set_color(self, color):
        st = studio.cur()
        if st.read_only:
            return
        st.settings["color"] = color.upper()
        self._changed(header=True)
        self._fill()

    def _color(self, color, **event_args):
        self._set_color(color)

    def _picked(self, event):
        self._set_color(str(self.dom_nodes["color_pick"].value))

    def _keep(self, name, on, **event_args):
        st = studio.cur()
        st.settings.setdefault("keep", {})[name] = on
        self._changed()

    def os_click(self, event):
        self._os = str(event.currentTarget.getAttribute("data-os"))
        state.store_set("os", self._os)
        self._steps()

    # ---- the download
    def _download(self, html_only, button):
        st = studio.cur()
        button.enabled = False
        try:
            name = ss.SS.download(st.bp, st.js_settings(), html_only)
        except Exception as e:
            state.toast("The download didn't work: %s" % e, "error")
            return
        finally:
            button.enabled = True
        state.toast("index.html downloaded" if html_only else
                    "Downloaded %s. Unzip it and double-click the start file." % name, "ok")
        if st.project.get("id"):
            state.call_quiet("note_download", st.project["id"])

    @handle("download_button", "click")
    def download_button_click(self, **event_args):
        self._download(False, self.download_button)

    @handle("html_button", "click")
    def html_button_click(self, **event_args):
        self._download(True, self.html_button)
