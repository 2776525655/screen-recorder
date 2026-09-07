@echo off
chcp 65001 >nul
title ScreenRec - Recorder
cd /d "%~dp0"

echo.
echo ============================================
echo    ScreenRec  -  one-click run
echo ============================================
echo.

echo [1/3] checking environment...
if not exist "node_modules\electron\dist\electron.exe" goto :missing_electron
if not exist "node_modules\.bin\electron.cmd" goto :missing_electron
if not exist "bin\ffmpeg.exe" goto :missing_ffmpeg

echo [2/3] building latest code (renderer + main)...
call npm run build
if errorlevel 1 goto :build_failed

echo [3/3] starting app...
call npm run start

echo.
echo App has exited.
pause
exit /b 0

:missing_electron
echo.
echo [ERROR] Electron is not installed yet.
echo         Open a terminal in this folder and run:  npm install
echo         then double-click this script again.
pause
exit /b 1

:missing_ffmpeg
echo.
echo [ERROR] bin\ffmpeg.exe not found. The recording engine needs it.
echo         Please re-download ffmpeg and put it in the bin folder.
pause
exit /b 1

:build_failed
echo.
echo [ERROR] Build failed. Please check the error messages above.
pause
exit /b 1
