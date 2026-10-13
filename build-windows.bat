@echo off
rem ============================================================
rem  Bla builder - packages the whole application into bla.exe
rem  Double-click this file, or run it from a terminal.
rem ============================================================
setlocal EnableExtensions EnableDelayedExpansion
title Bla builder
cd /d %~dp0

echo.
echo  ============================================================
echo    Bla builder
echo    Packages the chat server + web client into one bla.exe
echo  ============================================================
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f delims= %%v in ('node -p process.versions.node') do set NODEVER=%%v
for /f tokens=1,2 delims=. %%a in (!NODEVER!) do set MAJOR=%%a & set MINOR=%%b
if !MAJOR! LSS 22 goto :old_node
if !MAJOR! EQU 22 if !MINOR! LSS 5 goto :old_node
echo  [1/3] Node.js !NODEVER! found

rem ---------- 2. Build dependencies ----------
if not exist node_modules\esbuild\package.json goto :install
if not exist node_modulesesedit\package.json goto :install
echo  [2/3] Build dependencies already installed
goto :build

:install
echo  [2/3] Installing build dependencies, one time, needs internet
echo        npm install
call npm install --no-audit --no-fund
if errorlevel 1 goto :no_npm

:build
echo  [3/3] Building bla.exe, this takes about a minute
echo.
node --no-warnings scripts\build.js %*
if errorlevel 1 goto :failed
if not exist distla.exe goto :failed

echo.
echo  ============================================================
echo    Done - your executable is ready:
echo.
echo      %CD%\dist\bla.exe
echo.
echo    Run it, then open http://localhost:3000
echo    The first account you register becomes the instance admin.
echo  ============================================================
goto :end

:no_node
echo.
echo  [X] Node.js was not found.
echo.
echo      Bla is built with Node.js 22.5 or newer:
echo      https://nodejs.org/en/download
goto :end

:old_node
echo.
echo  [X] Node.js !NODEVER! is too old.
echo      Please install Node.js 22.5 or newer: https://nodejs.org/en/download
goto :end

:no_npm
echo.
echo  [X] npm install failed - usually a network problem or a proxy.
echo      Fix the connection and run this file again.
goto :end

:failed
echo.
echo  ============================================================
echo    The single-file build did not finish.
echo  ============================================================
echo.
echo    Details are above; the full log is in dist\build-error.log
echo.
echo    If dist\bla.exe exists, the file was built but Windows would not
echo    start it for the safety check - antivirus can do that. Try running
echo    dist\bla.exe directly, or rebuild with:  node scripts\build.js --no-verify
echo.
echo    There is a fallback that skips the executable surgery entirely:
echo    a portable folder (bla.exe + app + web client + launcher).
echo.
set /p TRY=    Build the portable folder instead? [y/N] 
if /i not !TRY!==y goto :end
echo.
node --no-warnings scripts\build.js --portable
if errorlevel 1 goto :end
echo.
echo  Portable build ready in: %CD%\dist\Bla-win32-x64
echo  Open that folder and run Bla.cmd
goto :end

:end
echo.
pause
