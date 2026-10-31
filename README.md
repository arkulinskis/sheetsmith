# Sheetsmith

Sheetsmith turns an Excel workbook (.xlsx / .xlsm), with its tables, formulas, validation rules, conditional formats
and VBA macros, into a web app plus a one-file Python server that runs on any computer on a local network. People
upload a workbook, adjust the app in a studio, preview it live, and download a zip (`index.html`, `server.py`, start
scripts, README). Everyone on the same Wi-Fi then shares the app and its data. Built on [Anvil](https://anvil.works).

- **App repo:** github.com/arkulinskis/sheetsmith (branch `master`). Anvil pulls `master`.
- **Live:** https://sheetsmith.anvil.app

## What it does

**For visitors (no account):**
- Landing page with a drop zone: **try a workbook without signing up** (read in memory by `inspect_workbook`, nothing
  stored; the studio opens on `#project/draft`), then sign up to keep it.
- Three made-up **example workbooks** (Juniper Bakery orders, Fernhill Tool Library, Northgate Floors quote), openable by anyone.
- **Guide** (`#guide`): what converts, the supported formula functions and VBA objects (listed live from the engine),
  running the app on a network, limits.

**For members:**
- **Projects** (`#home`): drop a workbook to upload it, your projects as cards, examples. Up to 60 projects of 12 MB.
- **Studio** (`#project/<id>/<tab>`):
  - *Overview:* counts (sheets, tables, formulas and % supported, rules, macros that run), the app's screens, notes.
  - *Screens:* rename, reorder, re-icon, hide screens; per column: label, type (text, money, date, choice…), show/hide;
    card title and status-chip columns.
  - *Rules:* data validation in plain words, conditional formats with swatches, functions used (supported or not), names.
  - *Macros:* score ring, each procedure (Runs / Partly / Won't run, with reasons and lines), button labels and
    on/off, highlighted code.
  - *Preview:* the real generated app in an iframe (memory only), computer or phone frame, light or dark, full window.
  - *Get the app:* name, subtitle, colour, which tables keep their rows, macros/events/view-only switches, PIN, port →
    **Download the app (.zip)** or just `index.html`; step-by-step run instructions per OS.
  - Settings save as you change them; examples can be copied ("Make my copy"); re-read with the newest reader; delete.

**The generated app (runtime/):** list + form screens for tables (search, status chips, sort, phone cards, totals,
calculated columns, live calculated fields in the form), form screens for label/input sheets (results update as you
type), grid screens for other sheets (cells, formula bar, keyboard editing), the workbook's validation with its own
messages, conditional colours, macro buttons that run the VBA (MsgBox / InputBox dialogs), Worksheet_Change /
Workbook_Open / Worksheet_Activate events, UDFs in formulas, CSV/xlsx export, an Activity list, PIN screen,
light/dark, add-to-home-screen. Modes: `server` (shared via server.py), `local` (opened as a file: this browser only),
`preview` (in the studio).

**server.py (stdlib only, Python 3.8+):** serves the app on the LAN and prints the address, SQLite storage
(`data/app.db`), sync by revision (polling), activity log with names, daily backups (30 kept), `--pin`, `--port`,
`--reset`, Excel export with real tables and formulas (checked in real Excel), manifest + icon for phones.

**For admins** (`#admin`; arkulinskis@gmail.com becomes an admin on first sign-in): overview (people, projects,
downloads), **Projects** (all projects, search, delete), feedback inbox, users, demo data (the examples).

## Setting it up in Anvil (once)

1. In the Anvil editor: **Create app → Clone from GitHub**, and paste `https://github.com/arkulinskis/sheetsmith`.
2. **Users** service: email + password, sign-up allowed (already set in `anvil.yaml`; check it).
3. Open the app in the editor. If it shows a **Schema Mismatch** alert, choose **"The schema of the source code is correct"** so Anvil creates the tables.
4. **Run** it and sign up with **arkulinskis@gmail.com** straight away (that account becomes the admin).
5. **Publish** (Publish → public URL, or your own domain).

## Working on it

See `.claude/skills/sheetsmith/SKILL.md`. In short:

```
python -I tools/check.py --ui                    # syntax, server + engine + end-to-end + headless UI tests → ALL CHECKS PASSED
python -I tools/preview/devserver.py 8765        # the app on in-memory data: http://localhost:8765/  (?as=ana#home, ?as=admin#admin)
node tools/testing/test_engine.js                # the formula + VBA engine on its own
python -I tools/testing/test_app_e2e.py          # build a real app, run server.py, export, drive it in Chrome
python tools/deploy.py                           # dry run (needs PyYAML, so no -I)
python tools/deploy.py --push "Message"          # deploy: commit + push to GitHub, Anvil pulls it
```

## Project layout

```
runtime/        the app people download: formula.js (workbook model + Excel formulas), vba.js (VBA interpreter + checker),
                app.js + app.css (the app's UI), server.py (the LAN server), README.txt, start.bat, start.sh
web/            Sheetsmith's own interface: core.js/core.css, app.js, pages/*.html (_builder = the zip builder + shared bits)
client_code/    Main.py (the only Anvil form: bridge, sign-in, uploads via anvil.js.to_media), legal.py
server_code/    WorkbookReader.py (xlsx parser), VbaReader.py (vbaProject.bin), Blueprint.py (screens, types), Projects.py,
                SampleBooks.py (the example workbooks), DemoData.py, Admin.py, Accounts.py, Feedback.py, common.py, legal_server.py
assets/         icon.svg + generated PNG icons (served at _/theme/<name>)
tools/          sync_to_anvil.py (settings, schema, RUNTIME_ASSETS), deploy.py, check.py, preview/ (dev server, UI tests, shots), testing/
```
