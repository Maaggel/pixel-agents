@echo off
rem Double-click to run the adb helper. Finds adb-helper.ps1 beside this file, wherever the folder is.
powershell -NoLogo -NoExit -ExecutionPolicy Bypass -File "%~dp0adb-helper.ps1"
