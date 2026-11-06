from anvil import *

from ._anvil_designer import ScreenEditTemplate
from ... import ss, state, studio


class ScreenEdit(ScreenEditTemplate):
    """Studio -> Screens: one screen. item = a screen from SS.screensView + first/last. Changes go straight into the
    studio's settings (studio.cur().sc_set / col_set); moving and new icons raise x-redraw on the panel."""

    def __init__(self, **properties):
        super().__init__(**properties)
        it, st = self.item, studio.cur()
        ro = st.read_only
        self.label_box.text = it["label"]
        state.set_control_attr(self.label_box, "aria-label", "Screen name")
        state.set_control_attr(self.label_box, "maxlength", 40)
        self.show_box.checked = not it.get("hidden")
        self.icon_button.role = ["st-iconbtn", "btn-icon", "ic-" + (it.get("icon") or "table")]
        state.set_control_attr(self.icon_button, "aria-label", "Icon for %s" % it["label"])
        state.set_control_attr(self.up_button, "aria-label", "Move %s up" % it["label"])
        state.set_control_attr(self.down_button, "aria-label", "Move %s down" % it["label"])
        state.set_control_attr(self.up_button, "data-key", it["id"] + "|up")
        state.set_control_attr(self.down_button, "data-key", it["id"] + "|down")
        self.up_button.enabled = not it.get("first") and not ro
        self.down_button.enabled = not it.get("last") and not ro
        self.table_part.visible = it["kind"] == "table"
        self.form_part.visible = it["kind"] == "form"
        self.grid_part.visible = it["kind"] not in ("table", "form")
        if it["kind"] == "table":
            names = [c["name"] for c in it["columns"]]
            self.title_dd.items = names
            self.title_dd.selected_value = it["titleCol"] if it["titleCol"] in names else (names[0] if names else None)
            self.status_dd.items = [("(none)", "")] + [(n, n) for n in names]
            self.status_dd.selected_value = it["statusCol"] if it["statusCol"] in names else ""
            state.set_control_attr(self.title_dd, "aria-label", "Card title column")
            state.set_control_attr(self.status_dd, "aria-label", "Status chips column")
            self.columns_panel.items = [dict(c, sc=it["id"]) for c in it["columns"]]
        elif it["kind"] == "form":
            self.fields_panel.items = it["fields"]
        else:
            self.grid_text.text = ("Shows %s as cells, like the sheet itself. People can type into cells that aren't "
                                   "formulas; the workbook's rules still apply." % it["sheet"])
        if ro:
            for c in (self.label_box, self.show_box, self.icon_button, self.title_dd, self.status_dd):
                c.enabled = False

    @handle("label_box", "change")
    def label_box_change(self, **event_args):
        studio.cur().sc_set(self.item["id"], "label", (self.label_box.text or "").strip())

    @handle("show_box", "change")
    def show_box_change(self, **event_args):
        studio.cur().sc_set(self.item["id"], "hidden", not self.show_box.checked)

    @handle("title_dd", "change")
    def title_dd_change(self, **event_args):
        studio.cur().sc_set(self.item["id"], "titleCol", self.title_dd.selected_value)

    @handle("status_dd", "change")
    def status_dd_change(self, **event_args):
        studio.cur().sc_set(self.item["id"], "statusCol", self.status_dd.selected_value or "")

    def _move(self, step, key):
        studio.cur().move_screen(self.item["id"], step)
        self.parent.raise_event("x-redraw", focus=key)

    @handle("up_button", "click")
    def up_button_click(self, **event_args):
        self._move(-1, self.item["id"] + "|up")

    @handle("down_button", "click")
    def down_button_click(self, **event_args):
        self._move(1, self.item["id"] + "|down")

    @handle("icon_button", "click")
    def icon_button_click(self, **event_args):
        from ...Dialogs.IconPicker import IconPicker
        name = alert(IconPicker(current=self.item.get("icon")), buttons=[], role="app-dialog", dismissible=True)
        if name:
            studio.cur().sc_set(self.item["id"], "icon", name)
            self.parent.raise_event("x-redraw")
