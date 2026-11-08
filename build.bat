@echo off
rem Build the host-side LVGL UI previewer.
rem Requires Visual Studio 2022 (C++ workload). Re-run after editing ui\*.c.
setlocal
call "D:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (echo [FATAL] vcvars64.bat failed & exit /b 1)
set "CMAKE=E:\Espressif\tools\cmake\4.0.3\bin\cmake.exe"
set "NINJA=E:\Espressif\tools\ninja\1.12.1\ninja.exe"
if not exist "%CMAKE%" (echo [FATAL] cmake not found & exit /b 1)
"%CMAKE%" -S "%~dp0." -B "%~dp0build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MAKE_PROGRAM="%NINJA%"
if errorlevel 1 exit /b 1
"%CMAKE%" --build "%~dp0build"
exit /b %errorlevel%
