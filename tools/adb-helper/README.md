# adb helper

A PowerShell script for Windows that gets an Android device connected over adb and then offers a
menu of things to do with it. Made for the Galaxy Tab 2 that shows the office (`android/`), but
it works for any device.

## Setup

1. Copy `adb-helper.ps1` and `adb-helper.cmd` into a folder of their own, for example
   `C:\Mix\Programs\adb`.
2. Double-click `adb-helper.cmd`. It runs the script from wherever the folder is, with no
   execution-policy prompt, and leaves the window open when you quit.

   The first run downloads adb (Google's platform-tools) into that folder if it is not there, and
   offers to put the folder on your PATH, so `adb` and `adb-helper` work in any new terminal.
3. Choose `s` in the menu for desktop and Start menu shortcuts.

adb is downloaded rather than kept in this repo: it stays current, and Google's SDK license does
not allow redistributing its binaries.

## What it does

It tries one fix at a time and stops as soon as a device is online: ask, wait for the handshake,
`adb reconnect offline`, restart the adb server, then stop every `adb.exe` on the PC - other tools
(TabScreen Host among them) bring their own adb, and two versions sharing the adb server is the
classic cause of a device stuck on `offline`. After that it walks you through replugging and
toggling USB debugging, and shows which USB drivers Windows has for the device.

Then a menu:

- **Install an APK** from the `apks` folder beside the script (newest first, Enter takes the
  newest), or drag a file into the window. `install -r` keeps the app's settings. Offers to start
  the Pixel Agents viewer afterwards.
- **Start the Pixel Agents viewer.**
- **Save the viewer's log** to a file - do this before closing the app if the tablet freezes.
- **Screenshot**, **shell**, **uninstall**.
- **adb over Wi-Fi**: switch a cabled device to Wi-Fi, or connect to one by IP.

The APK is built with `cd android && JAVA_HOME=~/.local/jdk ./gradlew --no-daemon :app:assembleDebug`
and copied to `build/pixel-agents-viewer-<version>-debug.apk`.
