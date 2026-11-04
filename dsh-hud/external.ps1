param([string]$OutFile = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ExtWin2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // every top-level window of the given processes: hwnd|w|h|visible|minimized|class|title
  public static List<string> All(uint[] pids) {
    var set = new HashSet<uint>(pids);
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (!set.Contains(p)) return true;
      var cn = new StringBuilder(128); GetClassName(h, cn, 128);
      var tt = new StringBuilder(512); GetWindowText(h, tt, 512);
      RECT r; GetWindowRect(h, out r);
      int w = r.R - r.L, hh = r.B - r.T;
      list.Add(h.ToInt64() + "|" + w + "|" + hh + "|" + IsWindowVisible(h) + "|" + IsIconic(h) + "|" + cn + "|" + tt.ToString().Replace("|", " "));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
$ocrEngine = $null
try { $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch {}

function Get-OcrText([string]$file) {
  if (-not $ocrEngine) { return '' }
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file)) ([Windows.Storage.StorageFile])
  $stream = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($ocrEngine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  return (($res.Lines | ForEach-Object { $_.Text }) -join "`n")
}

function Capture-Window([IntPtr]$hwnd, [string]$file) {
  $rect = New-Object ExtWin2+RECT
  [void][ExtWin2]::GetWindowRect($hwnd, [ref]$rect)
  $w = $rect.R - $rect.L; $h = $rect.B - $rect.T
  if ($w -le 0 -or $h -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][ExtWin2]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return $true
}

$BLOCK = '^(返回|前进|跳转到内容|隐藏侧边栏|显示侧边栏|应用程序菜单|文件|编辑|视图|帮助|应用导航|首页|图像|定时任务|资料库|插件|探索|代码审查|GPT|地图|站点|项目|用量|有可用更新|打开个人资料菜单|切换模式.*|询问 ChatGPT|选择 ChatGPT 模型|ChatGPT 可能会出错.*|为项目、作品集.*|关闭 ChatGPT 信标横幅|新建聊天|搜索|.*创建新聊天|已归档.*|跳转.*)$'

# 代理/操作电脑模式的窗口（ChatGPT 在替用户执行任务时会出现）
$AGENT_RE = 'is using your computer|Esc to cancel|正在使用你的电脑|正在操作'

function Get-ChatGptInfo {
  $pids = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($pids.Count -eq 0) { return [ordered]@{ name='ChatGPT'; running=$false; state='未运行'; snippet=''; work=''; agent=$false; title='' } }

  $wins = @([ExtWin2]::All([uint32[]]$pids))
  $fg = [ExtWin2]::GetForegroundWindow().ToInt64()
  $agent = $false; $agentTitle = ''
  foreach ($w in $wins) {
    $p = $w -split '\|'
    if ($p.Count -ge 7 -and $p[6] -match $AGENT_RE) { $agent = $true; $agentTitle = $p[6]; break }
  }

  # 选一个信息最多的窗口：可见的优先，其次看面积（最小化窗口也给 UIA 一次机会）
  $best = $null; $bestScore = -1; $vis = $false; $min = $false; $title = ''
  foreach ($w in $wins) {
    $p = $w -split '\|'
    if ($p.Count -lt 7) { continue }
    if ($p[5] -notmatch 'Chrome_WidgetWin') { continue }
    $area = [int]$p[1] * [int]$p[2]
    if ($area -lt 10000) { $area = 1 }             # 最小化窗口的 rect 是负坐标/很小
    $score = $area + $(if ($p[3] -eq 'True') { 1000000 } else { 0 })
    if ($score -gt $bestScore) { $bestScore = $score; $best = $w; $vis = ($p[3] -eq 'True'); $min = ($p[4] -eq 'True'); $title = $p[6] }
  }

  $state = '后台'
  if ($best) {
    if ($vis) { $state = '已打开' }
    if (($best -split '\|')[0] -eq "$fg") { $state = '使用中' }
    if ($min) { $state = '最小化' }
  }
  if ($agent) { $state = '执行中' }

  $snippet = ''; $work = ''
  if ($best) {
    try {
      $h = [IntPtr][int64](($best -split '\|')[0])
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $kept = New-Object System.Collections.ArrayList
      for ($i = 0; $i -lt $all.Count; $i++) {
        $n = $all[$i].Current.Name
        if (-not $n) { continue }
        $n = ($n -replace '\s+', ' ').Trim()
        if ($n.Length -lt 12) { continue }
        if ($n -match $BLOCK) { continue }
        if ($n -match '^Worked for (.+)$') { $work = $Matches[1]; continue }
        [void]$kept.Add($n)
      }
      $tail = @($kept | Select-Object -Last 2)
      $snippet = ($tail -join ' / ')
      if ($snippet.Length -gt 120) { $snippet = $snippet.Substring(0, 118) + '...' }
    } catch {}
  }
  return [ordered]@{ name='ChatGPT'; running=$true; state=$state; snippet=$snippet; work=$work; agent=$agent; title=$title }
}

$apps = @()
try { $apps += Get-ChatGptInfo } catch { $apps += [ordered]@{ name='ChatGPT'; running=$false; state='读取失败'; snippet=''; work=''; agent=$false; title='' } }

# ---------- generic UIA probe for other desktop AI apps (WorkBuddy / MiniMax Code / Doubao) ----------
$PROC_BLOCK = '^(返回|前进|跳转到内容|隐藏侧边栏|显示侧边栏|应用程序菜单|文件|编辑|视图|帮助|应用导航|首页|设置|新建|搜索|关闭|最小化|最大化|还原)$'

function Get-UiaAppInfo([string]$procName, [int]$maxSnippet = 110) {
  $procs = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    return [ordered]@{ name=$procName; running=$false; state='未运行'; snippet=''; work=''; agent=$false; title='' }
  }
  $pids = @($procs | Select-Object -ExpandProperty Id)
  $wins = @([ExtWin2]::All([uint32[]]$pids))
  $fg = [ExtWin2]::GetForegroundWindow().ToInt64()
  $best = $null; $bestScore = -1; $vis = $false; $min = $false; $title = ''
  foreach ($w in $wins) {
    $p = $w -split '\|'
    if ($p.Count -lt 7) { continue }
    $area = [int]$p[1] * [int]$p[2]
    if ($area -lt 10000) { continue }          # minimised / hidden windows have no useful content
    $score = $area + $(if ($p[3] -eq 'True') { 1000000 } else { 0 })
    if ($score -gt $bestScore) { $bestScore = $score; $best = $w; $vis = ($p[3] -eq 'True'); $min = ($p[4] -eq 'True'); $title = $p[6] }
  }
  if (-not $best) {
    return [ordered]@{ name=$procName; running=$true; state='后台'; snippet=''; work=''; agent=$false; title='' }
  }
  $state = '后台'
  if ($vis) { $state = '已打开' }
  if (($best -split '\|')[0] -eq "$fg") { $state = '使用中' }
  if ($min) { $state = '最小化' }
  if ($title -match '生成|思考|运行|执行|responding|generating') { $state = '执行中' }

  $snippet = ''
  try {
    $hwndStr = ($best -split '\|')[0]
    $h = [IntPtr]([int64]$hwndStr)
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $kept = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $all.Count; $i++) {
      $n = $all[$i].Current.Name
      if (-not $n) { continue }
      $n = ($n -replace '\s+', ' ').Trim()
      if ($n.Length -lt 10 -or $n.Length -gt 2000) { continue }
      if ($n -match $PROC_BLOCK) { continue }
      [void]$kept.Add($n)
    }
    $tail = @($kept | Select-Object -Last 2)
    $snippet = ($tail -join ' / ')
    if ($snippet.Length -gt $maxSnippet) { $snippet = $snippet.Substring(0, ($maxSnippet - 2)) + '...' }
  } catch {}
  return [ordered]@{ name=$procName; running=$true; state=$state; snippet=$snippet; work=''; agent=$false; title=$title }
}

foreach ($pn in @('WorkBuddy', 'MiniMax Code', 'Doubao')) {
  try { $apps += Get-UiaAppInfo -procName $pn } catch {
    $apps += [ordered]@{ name=$pn; running=$false; state='读取失败'; snippet=''; work=''; agent=$false; title='' }
  }
}

$json = [ordered]@{ at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); apps = $apps } | ConvertTo-Json -Depth 6 -Compress
if ($OutFile) {
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} else {
  Write-Output $json
}
