# Main: the app's only Anvil form (the Startup Form). Its HTML is MAIN_MARKUP in tools/sync_to_anvil.py.
#
# The whole interface is JavaScript (web/): web/core.js draws the shell and routes #hash pages.
# This form only does what must happen in Anvil's Python:
#   - start the app with the signed-in user (one server call, so Anvil's loading spinner shows)
#   - bridge(kind, payload): run server calls for the pages, and sign in / sign up / sign out
#   - tell the Privacy & Terms kit (legal.py) who is signed in
# Locally, tools/preview/harness.js plays this part against the dev server. Keep the two in step.
from ._anvil_designer import MainTemplate
from anvil import *
import json

import anvil.js
import anvil.server
import anvil.users
from anvil.js import window

from .. import legal

# Colours for the Privacy & Terms page (match web/core.css).
LEGAL_THEME = {"accent": "#1d7a4f"}

AUTH_ERRORS = [
    (anvil.users.UserExists, "An account with that email already exists. Try signing in."),
    (anvil.users.EmailNotConfirmed, "Please confirm your email first. Check your inbox for the link."),
    (anvil.users.AccountIsNotEnabled, "This account is disabled."),
    (anvil.users.TooManyPasswordFailures, "Too many wrong attempts. Wait a while, or reset your password."),
    (anvil.users.PasswordNotAcceptable, None),  # Anvil's own message says what's wrong
    (anvil.users.AuthenticationFailed, "That email and password don't match."),
]


def _me():
    return anvil.server.call("get_me")


def _auth(kind, p):
    email = (p.get("email") or "").strip()
    try:
        if kind == "login":
            anvil.users.login_with_email(email, p.get("password") or "", remember=True)
        elif kind == "signup":
            anvil.users.signup_with_email(email, p.get("password") or "", remember=True)
            if anvil.users.get_user() is None:
                return {"ok": True, "me": None,
                        "message": "Account created. Check your email for a confirmation link, then sign in."}
            name = (p.get("name") or "").strip()
            if name:
                anvil.server.call("update_profile", name)
        elif kind == "reset":
            try:
                anvil.users.send_password_reset_email(email)
            except anvil.users.AuthenticationFailed:
                pass  # same answer either way, so nobody can find out which emails have accounts
            return {"ok": True, "message": "If that email has an account, a reset link is on its way."}
        elif kind == "logout":
            anvil.users.logout()
            legal.signed_out()
            return {"ok": True, "me": None}
    except anvil.users.AuthenticationFailed as e:
        for cls, msg in AUTH_ERRORS:
            if isinstance(e, cls):
                return {"ok": False, "error": msg or str(e) or "Please choose a stronger password."}
        return {"ok": False, "error": str(e)}
    me = _me()
    legal.refresh_soon()  # records the sign-up tick box, or reminds people to review new terms
    return {"ok": True, "me": me}


class Main(MainTemplate):
    def __init__(self, **properties):
        super().__init__(**properties)
        self._started = False
        self.add_event_handler("show", self._on_show)

    def _on_show(self, **event_args):
        # Mount in `show`, not __init__: the form's DOM isn't on the page before that.
        if self._started:
            return
        self._started = True
        legal.setup(LEGAL_THEME)
        me = _me()
        window.UI.start(anvil.js.get_dom_node(self), self._bridge, json.dumps({"me": me}))
        if me:
            legal.refresh_soon()

    def _bridge(self, kind, payload_json):
        """Called from JS (UI.api / UI.auth). Always returns a JSON string: {"result": ...} or {"error": ...}."""
        p = json.loads(payload_json) if payload_json else {}
        try:
            if kind == "call":
                call = anvil.server.call_s if p.get("quiet") else anvil.server.call
                # Server replies are JSON-friendly (tools/testing/test_server.py checks every one).
                return json.dumps({"result": call(p["fn"], *(p.get("args") or []))})
            if kind == "upload":
                # UI.upload(fn, file, ...): the browser File becomes Anvil Media (streamed, no JSON copy of the bytes)
                media = anvil.js.to_media(window.UI._file)
                return json.dumps({"result": anvil.server.call(p["fn"], media, *(p.get("args") or []))})
            if kind in ("login", "signup", "reset", "logout"):
                return json.dumps({"result": _auth(kind, p)})
            return json.dumps({"error": "Unknown request: %s" % kind})
        except anvil.server.SessionExpiredError:
            return json.dumps({"error": "Your session expired. Reload the page and sign in again.", "reload": True})
        except anvil.server.AppOfflineError:
            return json.dumps({"error": "You seem to be offline. Check your connection and try again."})
        except anvil.server.PermissionDenied as e:
            return json.dumps({"error": str(e) or "You don't have access to that.", "denied": True})
        except Exception as e:
            print("bridge %s %s failed: %r" % (kind, p.get("fn", ""), e))
            return json.dumps({"error": "Something went wrong. Please try again.", "detail": repr(e)[:300]})
