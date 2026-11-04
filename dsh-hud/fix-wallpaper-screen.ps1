# 自动把 DSH HUD 壁纸落到目标屏：优先 iPad（spacedesk 虚拟屏），否则主屏。
# Lively 的 monitor 编号写在 WallpaperLayout.json 的 LivelyScreen.Index 里，
# 换电脑 / 插拔显示器后编号会变，所以每次启动都重新读取，不再写死。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\fix-wallpaper-screen.ps1
#       可选参数：-Prefer spacedesk|primary   -Library <工程路径>   -Quiet

param(
  [string]$Prefer = 'spacedesk',
  [string]$Library = '',
  [int]$WaitLively = 45,
  [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshDisp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);
  public static List<string[]> All() {
    var res = new List<string[]>();
    var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(d);
    for (uint i = 0; EnumDisplayDevices(null, i, ref d, 0); i++) {
      if ((d.StateFlags & 1) == 0) { d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(d); continue; }
      res.Add(new string[] { d.DeviceName, d.DeviceString });
      d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(d);
    }
    return res;
  }
}
"@

$log = Join-Path $PSScriptRoot 'wallpaper-screen.log'
function Log($msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  if (-not $Quiet) { Write-Host $line }
}

$exe = 'C:\Program Files\Lively Wallpaper\Lively.exe'
if (-not (Test-Path $exe)) { Log 'Lively 未安装，跳过'; exit 0 }

$deadline = (Get-Date).AddSeconds($WaitLively)
while (-not (Get-Process Lively -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { Log '等待 Lively 超时'; exit 0 }
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 2

if (-not $Library) { $Library = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers\dshhaloflux.001' }
if (-not (Test-Path (Join-Path $Library 'LivelyInfo.json'))) { Log "找不到壁纸工程：$Library"; exit 0 }

$layoutPath = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\WallpaperLayout.json'
function Read-Layout {
  try {
    $j = Get-Content $layoutPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if (-not $j) { return @() }
    return @($j)
  } catch { return @() }
}

# 适配器名（判断哪块是 spacedesk 虚拟屏）
$adapters = @{}
foreach ($d in [DshDisp]::All()) { $adapters[$d[0]] = $d[1] }

function Get-Screens {
  Read-Layout | ForEach-Object {
    [pscustomobject]@{
      Index   = [int]$_.LivelyScreen.Index
      Device  = [string]$_.LivelyScreen.DeviceName
      Adapter = [string]$adapters[$_.LivelyScreen.DeviceName]
      Primary = [bool]$_.LivelyScreen.IsPrimary
    }
  }
}

# ---- 选目标 ----
$screens = @(Get-Screens)
$target = $null

if ($Prefer -eq 'spacedesk') {
  $target = $screens | Where-Object { $_.Adapter -match 'spacedesk' } | Select-Object -First 1
}
if (-not $target) { $target = $screens | Where-Object { $_.Primary } | Select-Object -First 1 }

# 目标屏还没被 Lively 记录过：探测它的编号
if (-not $target) {
  $want = if ($Prefer -eq 'spacedesk') {
    @([DshDisp]::All() | Where-Object { $_[1] -match 'spacedesk' } | Select-Object -First 1)[0]
  } else { [System.Windows.Forms.Screen]::PrimaryScreen.DeviceName }
  if (-not $want) { Log '找不到目标屏（既无 spacedesk 也无主屏）'; exit 0 }
  Log "目标设备 $want 尚未被 Lively 记录，开始探测编号"
  & $exe closewp --monitor -1 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  $found = $false
  for ($i = 1; $i -le 8; $i++) {
    & $exe setwp --file $Library --monitor $i 2>&1 | Out-Null
    $hit = $null
    for ($t = 0; $t -lt 10 -and -not $hit; $t++) {
      Start-Sleep -Milliseconds 500
      $hit = @(Get-Screens) | Where-Object { $_.Device -eq $want -and $_.Index -eq $i }
    }
    if ($hit) {
      Log "探测到 $want = Lively monitor $i"
      $target = $hit
      $found = $true
      break
    }
    & $exe closewp --monitor $i 2>&1 | Out-Null
  }
  if (-not $found) {
    Log '探测失败，回退主屏'
    $target = @(Get-Screens) | Where-Object { $_.Primary } | Select-Object -First 1
  }
}

if (-not $target) { Log '未找到可用的目标屏'; exit 0 }

Log ("目标屏 = {0} (Lively monitor {1}, adapter={2})" -f $target.Device, $target.Index, $target.Adapter)

# ---- 应用：只在目标屏设置，其它屏清掉 ----
& $exe setwp --file $Library --monitor $target.Index 2>&1 | Out-Null
Start-Sleep -Seconds 1
foreach ($s in @(Get-Screens)) {
  if ($s.Index -ne $target.Index) { & $exe closewp --monitor $s.Index 2>&1 | Out-Null }
}
Log '壁纸屏幕已更新'
