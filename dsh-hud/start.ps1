# DSH × HALOFLUX live monitor — start the local data bridge (with supervisor)
# usage:  powershell -File dsh-hud/start.ps1 [-Port 7788]
param([int]$Port = 7788)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
$env:HUD_PORT = "$Port"
$log = Join-Path $PSScriptRoot 'server.log'

function Log($msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line -ForegroundColor DarkGray
}

Write-Host "DSH HUD starting on http://127.0.0.1:$Port/" -ForegroundColor Cyan

# 顺手把壁纸落到正确的屏幕（iPad/spacedesk 优先，否则主屏），不再写死显示器编号
$fix = Join-Path $PSScriptRoot 'fix-wallpaper-screen.ps1'
if (Test-Path $fix) {
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$fix`"", '-Quiet', '-WaitLively', '90') `
    -WindowStyle Hidden | Out-Null
}

# 守护循环：node 崩了自动拉起（5 秒后重试），输出写进 server.log
$server = Join-Path $PSScriptRoot 'server.mjs'
while ($true) {
  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($existing) { Log ("port $Port already in use, supervisor exits"); exit 0 }
  Log 'starting server.mjs'
  try {
    & node $server $here 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
    Log 'node exited normally (unexpected for a server)'
  } catch {
    Log ('node crashed: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 5
}
