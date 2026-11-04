param(
  [string]$Action = 'status',
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# The wallpaper itself runs in WebView2 and registers a media session too.
# Prefer a real player; fall back to whatever is actually playing.
$sessions = @($mgr.GetSessions())
$preferred = 'QQMusic|Spotify|Netease|CloudMusic|foobar|MusicBee|AIMP|vlc|PotPlayer|KuGou|Kuwo|QQMusic'
$session = $null
foreach ($cand in $sessions) {
  if ($cand.SourceAppUserModelId -match $preferred) {
    try { if ($cand.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { $session = $cand; break } } catch {}
    if (-not $session) { $session = $cand }
  }
}
if (-not $session) {
  foreach ($cand in $sessions) {
    try { if ($cand.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { $session = $cand; break } } catch {}
  }
}
if (-not $session) { $session = $mgr.GetCurrentSession() }

$result = [ordered]@{ ok = $false; title = ''; artist = ''; album = ''; app = ''; status = 'none' }

if ($null -ne $session) {
  try {
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $session.GetPlaybackInfo()
    $result.ok = $true
    $result.title = [string]$props.Title
    $result.artist = [string]$props.Artist
    $result.album = [string]$props.AlbumTitle
    $result.app = [string]$session.SourceAppUserModelId
    $result.status = [string]$info.PlaybackStatus
    switch ($Action) {
      'next' { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
      'prev' { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
      'toggle' { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
      default { }
    }
  } catch {
    $result.status = 'error: ' + $_.Exception.Message
  }
}

$json = $result | ConvertTo-Json -Compress
if ($OutFile) {
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} else {
  Write-Output $json
}
