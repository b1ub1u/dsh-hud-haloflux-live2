# Verify the DSH HUD wallpaper stack after a reboot.
# usage: pwsh -File dsh-hud/verify-after-reboot.ps1
# Prints one line per check and exits 0 only if everything is healthy.

$ErrorActionPreference = 'SilentlyContinue'
$fail = 0

function Check($name, $ok, $detail) {
  $mark = if ($ok) { '[ OK ]' } else { '[FAIL]' }
  "{0} {1,-28} {2}" -f $mark, $name, $detail
  if (-not $ok) { $script:fail++ }
}

# 1. startup launcher
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-hud-start.vbs'
Check 'startup launcher' (Test-Path $vbs) $vbs

# 2. server listening
$listen = (netstat -ano | Select-String ':7788\s.*LISTENING')
Check 'port 7788 listening' ([bool]$listen) $(if ($listen) { 'yes' } else { 'no' })

# 3. server responds
$stats = $null
try { $stats = Invoke-RestMethod 'http://127.0.0.1:7788/stats' -TimeoutSec 5 } catch {}
Check '/stats responds' ([bool]$stats) $(if ($stats) { "rss=$($stats.rssMB)MB clients=$($stats.clients) uptime=$([math]::Round($stats.uptimeMs/60000,1))min" } else { 'unreachable' })

# 4. wallpaper page
$wall = $null
try { $wall = Invoke-WebRequest 'http://127.0.0.1:7788/wall' -UseBasicParsing -TimeoutSec 5 } catch {}
Check '/wall renders' ($wall -and $wall.StatusCode -eq 200) $(if ($wall) { "$($wall.RawContentLength) bytes" } else { 'failed' })

# 5. Lively process
$lively = Get-Process Lively
Check 'Lively running' ([bool]$lively) $(if ($lively) { "pid=$($lively.Id)" } else { 'not running' })

# 6. Lively wallpaper target
$layoutPath = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\WallpaperLayout.json'
$layout = Get-Content $layoutPath -Raw
Check 'wallpaper = HALOFLUX' ($layout -match 'dshhaloflux') $layoutPath

# 7. node process for the server
$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh-hud\\server.mjs|dsh-hud/server.mjs' }
Check 'server node process' ([bool]$node) $(if ($node) { "pid=$($node.ProcessId)" } else { 'not found' })

""
if ($fail -eq 0) { 'RESULT: all checks passed — wallpaper stack survived reboot.' } else { "RESULT: $fail check(s) failed." }
exit $fail
