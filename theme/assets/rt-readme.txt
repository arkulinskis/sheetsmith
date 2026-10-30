{{TITLE}}
Made with Sheetsmith from {{FILE}} on {{DATE}}.

WHAT'S IN THIS FOLDER
  index.html             the app
  server.py              shares the app on your network (Python 3.8 or newer, nothing else to install)
  Start (Windows).bat    double-click this on Windows
  start.command          double-click this on a Mac
  start.sh               Linux or Raspberry Pi:  sh start.sh

START IT
  1. Put this folder on the computer that will share the app. It has to stay on while people use the app.
  2. Windows: double-click "Start (Windows).bat".
     Mac: double-click start.command (the first time, right-click it and choose Open).
     Linux / Raspberry Pi: open a terminal in this folder and type:  python3 server.py
  3. A window shows two addresses. Open the "On your network" one (it looks like http://192.168.1.20:{{PORT}}/)
     on any phone, tablet or computer connected to the same Wi-Fi or office network.
  Windows may ask whether Python may use the network: tick "Private networks" and click Allow.
  On a phone, use "Add to Home Screen" in the browser menu to open it like an app.

NO PYTHON YET?
  Windows: download it from https://www.python.org/downloads/ and tick "Add python.exe to PATH" while
           installing (or install "Python 3.12" from the Microsoft Store).
  Mac:     the first time you run start.command, macOS offers to install the developer tools; say yes.
           Or download it from https://www.python.org/downloads/
  Linux / Raspberry Pi: it's already installed.

YOUR DATA
  Everything is saved on the computer that runs server.py, in data/app.db, with a copy every day in
  data/backups. Nothing is sent to the internet.
  Excel copy any time: in the app, Export > Excel workbook.
  Start over with the workbook's data:   python server.py --reset    (the old data is kept in data/backups)
  Moving to another computer: copy the whole folder, data folder included.
  A new version from Sheetsmith: replace index.html and server.py, keep the data folder. Your data stays.

OPTIONS
  python server.py --port 9000      use another port
  python server.py --pin 4821       ask for a PIN before opening the app{{PIN_NOTE}}
  python server.py --no-browser     don't open a browser on this computer when it starts

WITHOUT THE SERVER
  You can also simply open index.html in a browser. It works the same way, but changes are saved in
  that browser only, so nobody else sees them.

KEEP IT SAFE
  Anyone who can reach this computer on the network can open the app, so use it on networks you trust
  (home, office, shop, workshop) and set a PIN if you want to keep it to your team.

WHAT CAME ACROSS FROM THE WORKBOOK
{{REPORT}}
