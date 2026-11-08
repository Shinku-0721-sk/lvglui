@echo off
rem lvglui - headless render + live preview for LVGL screens written in C.
rem   lvglui render [--out path] [--frames 12] [--no-build] [--quiet]
rem   lvglui build | preview | doctor
setlocal
node "%~dp0cli\lvglui.mjs" %*
exit /b %errorlevel%
