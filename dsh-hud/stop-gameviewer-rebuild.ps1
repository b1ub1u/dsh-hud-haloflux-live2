# HALOFLUX - 停 GameViewer 虚拟显示器 + 彻底重建 Lively 壁纸
# 必须右键本文件 -> "使用 PowerShell 运行"(或以管理员身份运行)，否则停不掉 GameViewer 服务。
# 背景: GameViewer 的虚拟显示器(2560x1600)导致 explorer 反复重启 -> Lively 重建壁纸 ->
#        WebView2 播放器崩溃循环 -> 孤儿 GPU 进程堆积吃显存。停掉它即可根因治理。

$ErrorActionPreference = 'SilentlyContinue'

function Resolve-LivelyExe {
  if ($env:HALOFLUX_LIVELY_EXE -and (Test-Path $env:HALOFLUX_LIVELY_EXE)) { return $env:HALOFLUX_LIVELY_EXE }
  $c = @(
    (Join-Path $env:ProgramFiles 'Lively Wallpaper\Lively.exe'),
    (Join-Path $env:ProgramW6432 'Lively Wallpaper\Lively.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper\Lively.exe'),
    'C:\Program Files\Lively Wallpaper\Lively.exe'
  )
  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

Write-Host '== 1) 停止 GameViewer 服务与进程 =='
Stop-Service -Name 'GameViewerService' -Force -ErrorAction SilentlyContinue
Get-Process -Name 'GameViewerService','GameViewerHealthd','GameViewerServer' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4

$vga = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'GameViewer' }
Write-Host ('GameViewer 虚拟显卡: ' + $(if ($vga) { '仍在 (STILL PRESENT)' } else { '已移除 (REMOVED)' }))

Write-Host '== 2) 彻底重启 Lively（宿主 + 播放器 + 所有 WebView2 孤儿） =='
Stop-Process -Name 'Lively.exe','Lively.Player.WebView2.exe' -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -match 'Lively' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5
if (-not (Get-Process Lively -ErrorAction SilentlyContinue)) {
  $lively = Resolve-LivelyExe
  if ($lively) { Start-Process $lively } else { Write-Host 'Lively.exe 未找到，跳过启动' }
  Start-Sleep -Seconds 18
}
Write-Host ('Lively: ' + $(if (Get-Process Lively -ErrorAction SilentlyContinue) { 'UP' } else { 'DOWN - 需手动启动 Lively' }))

Write-Host '== 3) 重新选屏（确保只落在主显示器） =='
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$fix = Join-Path $here 'fix-wallpaper-screen.ps1'
if (Test-Path $fix) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $fix -Quiet -WaitLively 30
} else {
  Write-Host ('fix-wallpaper-screen.ps1 未找到: ' + $fix)
}
Start-Sleep -Seconds 3

Write-Host ('== 4) 显存: ' + ((nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>$null) -join ' ').Trim() + ' MiB ==')
Write-Host '完成。请观察几分钟：若 Lively 日志不再出现 "CoreWebView2 process failed: Crashed"，根因已除。'
Write-Host '注意: 7GB 历史孤儿 GPU 进程只有重启电脑才能回收；本脚本只停崩溃、防新增堆积。'
