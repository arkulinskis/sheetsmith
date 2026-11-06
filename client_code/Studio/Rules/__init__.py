from anvil import *

from ._anvil_designer import RulesTemplate
from ... import studio


class Rules(RulesTemplate):
    """Studio -> Rules: data validation, conditional formats, the formula functions used, named ranges."""

    def __init__(self, **properties):
        super().__init__(**properties)
        st = studio.cur()
        v = st.view("rules")
        rules, formats, fns = v["rules"], v["formats"], v["functions"]
        self.rules_count.text, self.formats_count.text = str(len(rules)), str(len(formats))
        self.rules_panel.items = rules
        for el in (self.rules_note, self.rules_table):
            el.visible = bool(rules)
        self.no_rules.visible = not rules
        self.formats_panel.items = formats
        for el in (self.formats_note, self.formats_table):
            el.visible = bool(formats)
        self.no_formats.visible = not formats
        self.formulas_count.text = str(v["total"])
        self.engine_note.text = ("They calculate live in the app, in the browser, with Sheetsmith's formula engine "
                                 "(%d Excel functions)." % v["engineCount"])
        self.fns_panel.items = fns
        self.no_fns.visible = not fns
        self.broken.text = "\n".join(v["broken"])
        self.broken.visible = bool(v["broken"])
        self.names_card.visible = bool(v["names"])
        self.names_count.text = str(len(v["names"]))
        self.names_panel.items = v["names"]
