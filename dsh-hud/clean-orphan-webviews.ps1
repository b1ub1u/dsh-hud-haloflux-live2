# HALOFLUX - 清理 Lively WebView2 孤儿进程与临时目录
# 问题背景: Lively 的 WebView2 壁纸播放器被重建(exit code -1)时会留下一套不回收的 GPU 子进程,
# 每次约占 2~3.5 GB 私有内存, 只能重启系统回收; 累积会顶满提交内存 -> 0xE0000008 (OOM)。
# 本脚本只清理"确实过期且无人使用"的历史实例, 永远保留当前活动的一套。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File clean-orphan-webviews.ps1

$ErrorActionPreference = 'SilentlyContinue'

$tmp = Join-Path $env:TEMP 'Lively Wallpaper\CEF'
$maxAgeMin = 3   # 超过 3 分钟未更新的 CEF 目录才"候选"为孤儿

# 1) 收集所有 Lively WebView2 进程 -> 其 CEF 目录名
#    注意: 循环变量绝不能用 $pid —— PowerShell 的 $PID 是只读自动变量, 赋值会抛异常,
#    整个循环体一次都不会执行(旧版本就是这么"永远 killed 0"的假修复)。
#    注意: 正则必须是 CEF\\([^\\]+)\\EBWebView (双反斜杠)。写成单反斜杠会编译失败
#    ("Unterminated character class"), 而 -match 在 SilentlyContinue 下静默吞掉,
#    于是映射恒空、下面的"在用保护"完全失效, 脚本就会删掉正在显示的壁纸的 CEF 目录。
$procs = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
$uddByProcId = @{}
foreach ($p in $procs) {
  if ($p.CommandLine -match 'CEF\\([^\\]+)\\EBWebView') { $uddByProcId[[int]$p.ProcessId] = $Matches[1] }
}

# 2) 哪些 CEF 目录正被活进程占用 —— 这些永远不能删
$inUse = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($k in $uddByProcId.Keys) { [void]$inUse.Add([string]$uddByProcId[$k]) }

# 2b) 失效保护: 有 WebView2 进程但一个目录都没解析出来, 说明正则/命令行格式变了。
#     这时绝不能凭"没过期"去猜, 直接放弃删除, 只报告。
$detectionBroken = ($procs.Count -gt 0 -and $inUse.Count -eq 0)
if ($detectionBroken) {
  Write-Host ("ABORT: {0} 个 WebView2 进程在跑, 但解析不出任何 CEF 目录 (正则失效?)。为避免误删正在使用的壁纸目录, 本次不删任何东西。" -f $procs.Count)
}

# 3) 删除过期且未被占用的目录
$cut = (Get-Date).AddMinutes(-$maxAgeMin)
$dirs = Get-ChildItem $tmp -Directory -ErrorAction SilentlyContinue
$removed = 0
$skipped = 0
if (-not $detectionBroken) {
  foreach ($d in $dirs) {
    if ($d.LastWriteTime -ge $cut) { continue }                 # 还新, 跳过
    if ($inUse.Contains($d.Name)) {                             # 过期但正被使用, 绝不能删
      $skipped++
      Write-Host ("KEEP in-use dir {0} (age {1:N1} min)" -f $d.Name, ((Get-Date) - $d.LastWriteTime).TotalMinutes)
      continue
    }
    Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    $removed++
    Write-Host ("DEL orphan dir {0}" -f $d.Name)
  }
}

# 4) 杀掉 user-data-dir 目录已不存在的 Lively WebView2 进程 (孤儿 GPU/renderer 进程)
#    这类进程特征是 Handles 极小(通常=2) 且私有内存巨大, Stop-Process 往往无效, 只有重启能回收;
#    这里尽力而为, 失败也不算错误。
$killed = 0
if (-not $detectionBroken) {
  foreach ($procId in $uddByProcId.Keys) {
    $udd = $uddByProcId[$procId]
    $dir = Join-Path $tmp $udd
    if (-not (Test-Path $dir)) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      $killed++
      Write-Host ("KILL orphan proc {0} (udd {1})" -f $procId, $udd)
    }
  }
}

Write-Host ("clean-orphan-webviews done: removed {0} stale dirs, kept {1} in-use, killed {2} orphan processes" -f $removed, $skipped, $killed)
