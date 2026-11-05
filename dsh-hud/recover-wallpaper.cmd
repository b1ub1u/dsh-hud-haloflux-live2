@echo off
REM ============================================================
REM  HALOFLUX - quick recover wallpaper after screen switch / drop
REM  Double-click this file. Requires Lively Wallpaper installed.
REM  Pass /silent (or -silent) for logon auto-run: no browser, no pause.
REM
REM  WARNING (2026-11-06, measured): every "setwp --file reload" detaches the
REM  current WebView2 player and builds a new one. Players detached this way
REM  leave a GPU process holding ~2-3.5 GB that CANNOT be killed without a
REM  reboot. That is why nothing reloads automatically any more: this script
REM  is the ONLY reload path, and it runs because a human asked for it.
REM  Run dsh-hud\clean-orphan-webviews.ps1 afterwards to clear what it leaked.
REM ============================================================
setlocal
set HERE=%~dp0

REM --- silent flag FIRST: every message below respects it ---
set SILENT=0
if /i "%~1"=="/silent" set SILENT=1
if /i "%~1"=="-silent" set SILENT=1

REM --- locate Lively: env override > known install paths > registry ---
REM Nothing machine-specific is hard-coded; override with HALOFLUX_LIVELY_EXE.
set "LIVE="
if defined HALOFLUX_LIVELY_EXE if exist "%HALOFLUX_LIVELY_EXE%" set LIVE=%HALOFLUX_LIVELY_EXE%
if not defined LIVE (
  for %%P in (
    "%ProgramFiles%\Lively Wallpaper\Lively.exe"
    "%ProgramW6432%\Lively Wallpaper\Lively.exe"
    "%LOCALAPPDATA%\Programs\Lively Wallpaper\Lively.exe"
    "%ProgramFiles(x86)%\Lively Wallpaper\Lively.exe"
  ) do (
    if not defined LIVE if exist %%P set LIVE=%%~P
  )
)
if not defined LIVE (
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$ks=@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Lively Wallpaper','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Lively Wallpaper'); foreach($k in $ks){ $r=(Get-ItemProperty $k -ErrorAction SilentlyContinue).InstallLocation; if($r){ $e=Join-Path $r 'Lively.exe'; if(Test-Path $e){ Write-Output $e; break } } }"`) do (
    if not defined LIVE if exist "%%P" set LIVE=%%P
  )
)
if not defined LIVE (
  echo [HALOFLUX] Lively.exe not found. Install Lively Wallpaper, or set HALOFLUX_LIVELY_EXE to its full path.
  if "%SILENT%"=="0" pause
  exit /b 1
)

REM --- check data service on 7788 (best-effort) ---
set SRV=0
powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if %errorlevel% equ 0 set SRV=1

if %SRV%==0 (
  if %SILENT%==1 (
    echo [HALOFLUX] 7788 not ready yet - proceeding best-effort; wallpaper self-recovers when server is up.
  ) else (
    echo [HALOFLUX] 7788 is DOWN. Start the server first:
    echo           powershell -File "%HERE%start.ps1"
    pause
    exit /b 1
  )
)

REM --- Lively host must be alive; it can die when DSH exits / display resets ---
powershell -NoProfile -Command "if(Get-Process Lively -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if errorlevel 1 (
  echo [HALOFLUX] Lively host is DOWN - starting it ...
  start "" "%LIVE%"
  powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(40); while(-not (Get-Process Lively -ErrorAction SilentlyContinue) -and (Get-Date) -lt $d){ Start-Sleep -Milliseconds 800 }; Start-Sleep -Seconds 8"
  REM re-check: reloading while the host never came up just wastes a player
  powershell -NoProfile -Command "if(Get-Process Lively -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
  if errorlevel 1 (
    echo [HALOFLUX] Lively still not running - giving up instead of reloading into the void.
    if "%SILENT%"=="0" (
      echo           check "%LIVE%" and try again.
      pause
    )
    exit /b 1
  )
) else (
  echo [HALOFLUX] Lively host is running.
)

echo [HALOFLUX] force reload wallpaper (re-inject bridge.js) ...
"%LIVE%" setwp --file reload
timeout /t 6 >nul

echo [HALOFLUX] re-select screen + align taskbar margin ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%fix-wallpaper-screen.ps1" -Quiet -WaitLively 30

REM --- reclaim the player this reload just leaked (best-effort, silent) ---
if exist "%HERE%clean-orphan-webviews.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%clean-orphan-webviews.ps1" >nul 2>&1
)

if %SILENT%==0 (
  if %SRV%==1 (
    echo [HALOFLUX] open browser preview ...
    start http://127.0.0.1:7788/
  )
  echo [HALOFLUX] done. Wallpaper is back.
  timeout /t 3 >nul
) else (
  echo [HALOFLUX] silent recover complete.
)
endlocal
