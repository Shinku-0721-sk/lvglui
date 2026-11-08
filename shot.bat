@echo off
rem Render one frame headlessly to out\preview.png (what the model looks at).
rem Thin wrapper over the CLI so project auto-detection works here too.
setlocal
call "%~dp0lvglui.bat" render --out "%~dp0out\preview.png" %*
exit /b %errorlevel%
