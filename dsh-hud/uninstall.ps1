<#
  DSH HUD 卸载 / Uninstaller
  -----------------------------------------------------------
      powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\uninstall.ps1

  会清理：
    1. 停止数据服务（node 进程）
    2. 撤掉桌面壁纸并从 Lively 库删除壁纸工程
    3. 删除开机自启 VBS
  保留：项目文件本身（想彻底删就自己删目录）
#>
param([int]$Port = 7788)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $PSCommandPath

function Step($msg) { Write-Host "  → $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    ✓ $msg" -ForegroundColor Green }

Write-Host ''
Write-Host '  DSH HUD 卸载' -ForegroundColor White
Write-Host '  ----------------------------' -ForegroundColor DarkGray

# 1. 停服务
Step '停止数据服务'
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Seconds 2
  Ok "已停止监听 $Port 的进程"
} else {
  Ok "端口 $Port 无监听，跳过"
}

# 2. 撤壁纸 + 删库
Step '撤掉桌面壁纸'
$exe = 'C:\Program Files\Lively Wallpaper\Lively.exe'
$lib = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers\dshhaloflux.001'
if (Test-Path $exe) {
  # 从所有屏幕撤掉
  for ($i = 1; $i -le 8; $i++) { & $exe closewp --monitor $i 2>&1 | Out-Null }
  Ok '已撤掉壁纸（Lively 保留安装）'
} else {
  Ok 'Lively 未安装，跳过'
}

if (Test-Path $lib) {
  Remove-Item $lib -Recurse -Force
  Ok '已从 Lively 库删除壁纸工程'
} else {
  Ok 'Lively 库中无壁纸工程，跳过'
}

# 3. 删自启
Step '删除开机自启'
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-hud-start.vbs'
if (Test-Path $vbs) { Remove-Item $vbs -Force; Ok '已删除 dsh-hud-start.vbs' }
else { Ok '无自启文件，跳过' }

Write-Host ''
Write-Host '  卸载完成。项目文件和 Lively Wallpaper 本身都保留了。' -ForegroundColor Green
Write-Host '  想彻底清干净：删除项目目录 + 卸载 Lively。' -ForegroundColor Gray
Write-Host ''
