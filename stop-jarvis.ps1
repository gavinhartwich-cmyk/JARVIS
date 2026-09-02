<#
.SYNOPSIS
  Stops a JARVIS instance started by start-jarvis.ps1, gracefully.

.DESCRIPTION
  [ADDED 2026-09-02] A hidden, no-console background process on Windows
  genuinely can't be sent a real SIGINT/SIGTERM from another process the
  way `kill` does on POSIX - there's no equivalent cross-process signal
  API for a console-less process, and Stop-Process only force-terminates
  (TerminateProcess), which would skip cli.ts's own shutdown() entirely
  and leak the mic-capture/wake-word-daemon/Chatterbox/native-HUD child
  processes it exists to clean up.

  Real substitute instead of a fake/forced stop: this touches a
  .jarvis-stop flag file that the running `listen` process polls for
  every second (see cli.ts's own comment on this exact mechanism) and,
  on seeing it, runs its real shutdown() path - same clean teardown as
  pressing Ctrl+C in a foreground terminal. Force-kill is a real,
  disclosed fallback only if that doesn't happen within -TimeoutSeconds.

.PARAMETER RepoPath
  Path to the JARVIS repo. Default: wherever this script itself lives.

.PARAMETER TimeoutSeconds
  How long to wait for a graceful shutdown before force-killing. Default 15.

.EXAMPLE
  .\stop-jarvis.ps1
#>
param(
  [string]$RepoPath = $PSScriptRoot,
  [int]$TimeoutSeconds = 15
)

$pidFile = Join-Path $RepoPath ".jarvis.pid"
$stopFile = Join-Path $RepoPath ".jarvis-stop"

if (-not (Test-Path $pidFile)) {
  Write-Output "No .jarvis.pid found - JARVIS doesn't appear to be running (or wasn't started via start-jarvis.ps1)."
  exit 0
}

$targetPidText = Get-Content $pidFile -ErrorAction SilentlyContinue
$targetPid = 0
$validPid = $targetPidText -and [int]::TryParse($targetPidText, [ref]$targetPid)
$proc = if ($validPid) { Get-Process -Id $targetPid -ErrorAction SilentlyContinue } else { $null }

if (-not $proc) {
  Write-Output "The PID in .jarvis.pid isn't running - already stopped. Cleaning up stale files."
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
  exit 0
}

Write-Output "Requesting graceful shutdown of JARVIS (PID $targetPid)..."
New-Item -ItemType File -Path $stopFile -Force | Out-Null

$waited = 0
while ($waited -lt $TimeoutSeconds) {
  Start-Sleep -Seconds 1
  $waited++
  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
    Write-Output "JARVIS stopped cleanly after ${waited}s."
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    exit 0
  }
}

Write-Output "JARVIS didn't exit within ${TimeoutSeconds}s - forcing it closed. Its mic-capture/wake-word-daemon/Chatterbox/native-HUD child processes may not have been cleaned up gracefully - worth checking Task Manager if this happens."
Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
