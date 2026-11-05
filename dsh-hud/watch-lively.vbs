' HALOFLUX - Lively wallpaper WATCHER (v3, observe-only)
' Watches three signals and only writes them to lively-watch.log:
'   1) Lively.exe gone
'   2) WallpaperLayout.json changed (display plug/unplug, screen switch)
'   3) /stats reports 0 SSE clients for 3 consecutive polls (wallpaper page quiet)
' It deliberately does NOT recover any more - see the note above the main loop.
' Started at logon by watch-lively-startup.vbs (shell:startup).
Option Explicit

Dim fso, sh, here, recover, logPath, layoutPath
Dim lastLayout, deadRounds
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here     = fso.GetParentFolderName(WScript.ScriptFullName)
recover  = here & "\recover-wallpaper.cmd"
logPath  = here & "\lively-watch.log"
layoutPath = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Lively Wallpaper\WallpaperLayout.json"

Const CHECK_MS = 60000   ' poll every 60s while healthy
Const COOL_MS  = 90000   ' after a recover, wait before checking again

If OtherInstanceRunning() Then WScript.Quit

lastLayout = ReadFile(layoutPath)
deadRounds = 0
Log "watchdog v2 started, poll=" & (CHECK_MS \ 1000) & "s"

' OBSERVE-ONLY (2026-11-06).
' v2 used to run recover-wallpaper.cmd automatically on three signals. Every one of
' those triggers a "setwp --file reload", and a reload detaches the live WebView2
' player and builds a new one. The detached player's GPU process keeps 2-3.5 GB of
' committed memory and cannot be killed without a reboot, so the watchdog was
' manufacturing the OOM it was meant to prevent. Signals also fire during a normal
' Lively restart, which turned one outage into a reload loop.
'
' Now it only records what it saw. Run dsh-hud\recover-wallpaper.cmd by hand when
' you actually want the wallpaper back.
Do While True
  Dim reason, layoutNow
  reason = ""
  layoutNow = ""

  If Not LivelyRunning() Then
    reason = "Lively.exe not running"
  Else
    layoutNow = ReadFile(layoutPath)
    If layoutNow <> "" Then
      If lastLayout <> "" And layoutNow <> lastLayout Then reason = "display layout changed"
      lastLayout = layoutNow
    End If
    If reason = "" Then
      If SseClients() = 0 Then
        deadRounds = deadRounds + 1
        If deadRounds >= 3 Then reason = "no SSE clients for 3 polls"
      Else
        deadRounds = 0   ' -1 (probe failed) also counts as healthy
      End If
    End If
  End If

  If reason <> "" Then
    ' Report once per outage; never act. The human decides.
    Log reason & " -> NOT recovering (observe-only; run recover-wallpaper.cmd to fix)"
    deadRounds = 0
    lastLayout = ReadFile(layoutPath)
    WScript.Sleep COOL_MS
  Else
    WScript.Sleep CHECK_MS
  End If
Loop

' Conservative on WMI failure: assume alive so we never trigger a false recover.
Function LivelyRunning()
  On Error Resume Next
  Dim wmi, col
  LivelyRunning = True
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then Exit Function
  Set col = wmi.ExecQuery("Select ProcessId From Win32_Process Where Name = 'Lively.exe'")
  If Err.Number <> 0 Then Exit Function
  LivelyRunning = (col.Count > 0)
  On Error GoTo 0
End Function

' Returns SSE client count from /stats, or -1 when the probe is unavailable.
Function SseClients()
  On Error Resume Next
  Dim http, txt, re, matches
  SseClients = -1
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:7788/stats", False
  http.Send
  If Err.Number <> 0 Then Exit Function
  If http.Status <> 200 Then Exit Function
  txt = http.responseText
  Set re = New RegExp
  re.Pattern = """clients"":(\d+)"
  re.IgnoreCase = True
  Set matches = re.Execute(txt)
  If matches.Count > 0 Then SseClients = CInt(matches(0).SubMatches(0))
  On Error GoTo 0
End Function

Function ReadFile(path)
  On Error Resume Next
  Dim f, t
  ReadFile = ""
  If Not fso.FileExists(path) Then Exit Function
  Set f = fso.OpenTextFile(path, 1)
  If Err.Number <> 0 Then Exit Function
  t = f.ReadAll
  f.Close
  ReadFile = t
  On Error GoTo 0
End Function

Function OtherInstanceRunning()
  On Error Resume Next
  Dim wmi, col, p, n, meName
  OtherInstanceRunning = False
  meName = LCase(fso.GetFileName(WScript.ScriptFullName))
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then Exit Function
  Set col = wmi.ExecQuery("Select CommandLine From Win32_Process Where Name = 'wscript.exe'")
  If Err.Number <> 0 Then Exit Function
  n = 0
  For Each p In col
    If Not IsNull(p.CommandLine) Then
      If InStr(LCase(p.CommandLine), meName) > 0 Then n = n + 1
    End If
  Next
  OtherInstanceRunning = (n > 1)
  On Error GoTo 0
End Function

Sub Log(msg)
  On Error Resume Next
  Dim f
  If fso.FileExists(logPath) Then
    If fso.GetFile(logPath).Size > 65536 Then
      Set f = fso.OpenTextFile(logPath, 2, True)
      f.WriteLine Now & "  [log rotated]"
      f.Close
    End If
  End If
  Set f = fso.OpenTextFile(logPath, 8, True)
  f.WriteLine Now & "  " & msg
  f.Close
  On Error GoTo 0
End Sub
