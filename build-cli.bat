@echo off
rem Build wrapper for the CLI/MCP.
rem All paths arrive via environment variables, so no long -D quoting is needed
rem (passing a quoted path through `cmd /c` silently eats the quotes on Windows).
rem TMP is redirected because cl.exe otherwise fails with C1083 Permission denied
rem when this runs from a GUI-spawned process.
setlocal
set "VSLANG=1033"
if not exist "%LVGLUI_BUILD%\tmp" mkdir "%LVGLUI_BUILD%\tmp"
set "TMP=%LVGLUI_BUILD%\tmp"
set "TEMP=%TMP%"
call "%LVGLUI_VCVARS%" >nul
if errorlevel 1 exit /b 1
"%LVGLUI_CMAKE%" -S "%LVGLUI_TOOL%" -B "%LVGLUI_BUILD%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MAKE_PROGRAM="%LVGLUI_NINJA%" -C "%LVGLUI_BUILD%\lvglui.cmake"
if errorlevel 1 exit /b 1
"%LVGLUI_CMAKE%" --build "%LVGLUI_BUILD%"
exit /b %errorlevel%