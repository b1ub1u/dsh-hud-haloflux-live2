<#
  DSH HUD 一键安装 / One-click installer
  -----------------------------------------------------------
  在解压后的项目根目录运行：
      powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\install.ps1

  它会自动完成：
    1. 环境检查（Node 20+ / PowerShell）
    2. 缺 Lively Wallpaper 就用 winget 自动安装
    3. 注入壁纸工程到 Lively 库（dshhaloflux.001）并设为桌面壁纸
    4. 写开机自启（当前用户 Startup 目录）
    5. 启动数据服务并做健康检查
    6. 自动选择壁纸屏幕（iPad/spacedesk 优先，否则主屏），底部安全边距对齐任务栏+1px

  可选参数：
      -Port <int>        数据服务端口，默认 7788
      -SkipLively        跳过 Lively 安装与壁纸设置（只装服务）
      -Uninstall         卸载（等价于运行 uninstall.ps1）
#>
param(
  [int]$Port = 7788,
  [switch]$SkipLively,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath          # ...\dsh-hud
$root = Split-Path -Parent $here                   # 项目根
$halo = Join-Path $root 'haloflux'
$proj = Join-Path $here 'wall-proj'

function Step($n, $msg) { Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    ✓ $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    ! $msg" -ForegroundColor Yellow }
function Fail($msg)     { Write-Host "    ✗ $msg" -ForegroundColor Red }

if ($Uninstall) {
  $u = Join-Path $here 'uninstall.ps1'
  if (Test-Path $u) { & powershell -NoProfile -ExecutionPolicy Bypass -File $u; exit $LASTEXITCODE }
  Fail '找不到 uninstall.ps1'; exit 1
}

Write-Host ''
Write-Host '=========================================' -ForegroundColor White
Write-Host '   DSH × HALOFLUX  Live Desktop Wallpaper' -ForegroundColor White
Write-Host '=========================================' -ForegroundColor White
Write-Host ''

# ---------------------------------------------------------------- 1. 环境检查
Step 1 '检查运行环境'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail '未找到 Node.js。请先安装 Node 20+：https://nodejs.org  或 winget install OpenJS.NodeJS.LTS'
  exit 1
}
$ver = (& node --version) -replace 'v', ''
$major = [int]($ver -split '\.')[0]
if ($major -lt 20) { Fail "Node 版本过低（$ver），需要 20 及以上"; exit 1 }
Ok "Node.js $ver — $($node.Source)"

if (-not (Test-Path (Join-Path $halo 'lab.html'))) {
  Fail '缺少 haloflux\lab.html。请保持 dsh-hud 与 haloflux 在同一父目录下。'
  exit 1
}
Ok 'HALOFLUX 视觉文件完整'

# 检测 DSH 会话目录（数据源）
$dshHome = Join-Path $HOME '.dsh'
if (Test-Path $dshHome) {
  Ok "检测到 DeepSeek Harness：$dshHome"
} else {
  Warn "未找到 $dshHome —— 壁纸会显示待命，装上 DSH 后自动有数据"
}

# ---------------------------------------------------------------- 2. Lively
function Resolve-LivelyExe {
  # Resolve Lively from env / usual install dirs / registry instead of one hard-coded path.
  if ($env:HALOFLUX_LIVELY_EXE -and (Test-Path $env:HALOFLUX_LIVELY_EXE)) { return $env:HALOFLUX_LIVELY_EXE }
  $c = @(
    (Join-Path $env:ProgramFiles 'Lively Wallpaper\Lively.exe'),
    (Join-Path $env:ProgramW6432 'Lively Wallpaper\Lively.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper\Lively.exe'),
    'C:\Program Files\Lively Wallpaper\Lively.exe',
    'C:\Program Files (x86)\Lively Wallpaper\Lively.exe'
  )
  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }
  foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
    foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $v = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
      if ($v.DisplayName -like '*Lively*' -and $v.InstallLocation) {
        $e = Join-Path $v.InstallLocation 'Lively.exe'
        if (Test-Path $e) { return $e }
      }
    }
  }
  return $null
}
$LIVELY_EXE = Resolve-LivelyExe
$LIVELY_LIB = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers\dshhaloflux.001'

if (-not $SkipLively) {
  Step 2 '准备壁纸宿主 Lively Wallpaper'
  if (Test-Path $LIVELY_EXE) {
    Ok 'Lively Wallpaper 已安装'
  } else {
    Warn '未安装 Lively，尝试用 winget 自动安装…'
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      Fail '找不到 winget，无法自动安装。请手动安装后重跑：'
      Write-Host '      winget install --id rocksdanister.LivelyWallpaper' -ForegroundColor Gray
      $SkipLively = $true
    } else {
      & winget install --id rocksdanister.LivelyWallpaper --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-Null
      if (Test-Path $LIVELY_EXE) { Ok 'Lively Wallpaper 安装完成' }
      else { Fail 'Lively 安装失败，请手动安装后重跑'; $SkipLively = $true }
    }
  }
}

# ---------------------------------------------------------------- 3. 注入壁纸工程
$monitor = 1
if (-not $SkipLively) {
  Step 3 '注入壁纸工程到 Lively 库'
  if (-not (Test-Path $proj)) { Fail "缺少壁纸工程目录：$proj"; exit 1 }

  # Lively 库目录准备
  $libRoot = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers'
  New-Item -ItemType Directory -Force -Path $libRoot | Out-Null
  if (Test-Path $LIVELY_LIB) { Remove-Item $LIVELY_LIB -Recurse -Force }
  Copy-Item $proj $LIVELY_LIB -Recurse
  Ok "壁纸工程已复制：$LIVELY_LIB"

  # 确保 Lively 在跑（setwp 需要宿主进程）
  if (-not (Get-Process Lively -ErrorAction SilentlyContinue)) {
    Start-Process $LIVELY_EXE
    $deadline = (Get-Date).AddSeconds(40)
    while (-not (Get-Process Lively -ErrorAction SilentlyContinue)) {
      if ((Get-Date) -gt $deadline) { Warn '等待 Lively 启动超时'; break }
      Start-Sleep -Milliseconds 800
    }
    Start-Sleep -Seconds 3
    Ok 'Lively 已启动'
  }

  # 应用壁纸到主屏（setwp 是 Lively 官方 CLI）
  Step 4 '设置桌面壁纸'
  try {
    & $LIVELY_EXE setwp --file $LIVELY_LIB --monitor $monitor 2>&1 | Out-Null
    Start-Sleep -Seconds 6
    $layout = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\WallpaperLayout.json'
    if ((Test-Path $layout) -and (Get-Content $layout -Raw) -match 'dshhaloflux') {
      Ok '壁纸已挂到桌面'
    } else {
      Warn '壁纸布局未确认，可稍后在 Lively 里手动选择 HALOFLUX × DSH LIVE'
    }
  } catch { Warn "setwp 调用失败：$($_.Exception.Message)" }
}

# ---------------------------------------------------------------- 5. 开机自启
Step 5 '写入开机自启'
$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'dsh-hud-start.vbs'
$vbs = @"
' DSH HUD auto start at logon
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$here\start.ps1"" -Port $Port", 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII
Ok "已写入：$vbsPath"

# ---------------------------------------------------------------- 6. 启动服务
Step 6 '启动数据服务'
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Ok "端口 $Port 已有服务在跑（pid $($existing.OwningProcess)），跳过启动"
} else {
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
                  '-File', "`"$here\start.ps1`"", '-Port', $Port `
    -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try { $s = Invoke-RestMethod "http://127.0.0.1:$Port/stats" -TimeoutSec 4; $ready = $true; break } catch {}
  }
  if ($ready) { Ok "服务已就绪：rss=$($s.rssMB)MB" }
  else { Fail "服务未响应，请手动运行 $here\start.ps1 查看报错" }
}

# ---------------------------------------------------------------- 7. 屏幕对齐
if (-not $SkipLively) {
  Step 7 '对齐壁纸屏幕与任务栏安全边距'
  $fix = Join-Path $here 'fix-wallpaper-screen.ps1'
  if (Test-Path $fix) {
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $fix -Quiet -WaitLively 30 2>&1 | Out-Null
      Ok '屏幕已对齐（选屏 + 任务栏安全边距）'
    } catch { Warn '屏幕对齐脚本未成功，壁纸可能显示在别的屏幕' }
  }
}

# ---------------------------------------------------------------- 完成
Write-Host ''
Write-Host '=========================================' -ForegroundColor Green
Write-Host '   安装完成 / Installation complete' -ForegroundColor Green
Write-Host '=========================================' -ForegroundColor Green
Write-Host ''
Write-Host "  预览地址： http://127.0.0.1:$Port/" -ForegroundColor White
Write-Host "  健康检查： http://127.0.0.1:$Port/stats" -ForegroundColor Gray
Write-Host ''
Write-Host '  常用操作：' -ForegroundColor Cyan
Write-Host "    重载壁纸    & `"$LIVELY_EXE`" setwp --file reload"
Write-Host '    重新选屏    powershell -File dsh-hud\fix-wallpaper-screen.ps1'
Write-Host '    重启后自检  powershell -File dsh-hud\verify-after-reboot.ps1'
Write-Host '    完全卸载    powershell -File dsh-hud\install.ps1 -Uninstall'
Write-Host ''
