<#
.SYNOPSIS
  Starts JARVIS running in the background, hidden - no terminal window,
  no command to type when you actually want to talk to it.

.DESCRIPTION
  [ADDED 2026-09-02] Per Gavin: "Jarvis is still a test when he should be
  running and pop up when asked not need to run a command when I want to
  talk to him." Previously the only way to talk to JARVIS was
  `bun run dev listen` in a visible terminal you had to open and leave
  running. This launches the exact same real pipeline (wake word -> STT ->
  LLM -> TTS, real app-control, the native HUD) as a hidden background
  process instead - same code, same behavior, just not tied to a terminal
  window you have to keep open.

  Real, disclosed scope of this first version: this script starts JARVIS
  for the CURRENT login session when you run it. It does NOT install
  auto-start-at-login by itself - see install-jarvis-autostart.ps1 for
  that, deliberately kept separate so you can test this manually first
  before it starts running every time you log in.

  A PID file (.jarvis.pid) tracks the running instance so stop-jarvis.ps1
  can find and gracefully stop it later, and so this script itself can
  tell "already running" apart from "not running" instead of blindly
  launching a second copy on top of an existing one.

.PARAMETER RepoPath
  Path to the JARVIS repo. Default: wherever this script itself lives.

.EXAMPLE
  .\start-jarvis.ps1
#>
param(
  [string]$RepoPath = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$pidFile = Join-Path $RepoPath ".jarvis.pid"
$stopFile = Join-Path $RepoPath ".jarvis-stop"
$logDir = Join-Path $RepoPath "logs"
$logFile = Join-Path $logDir "jarvis.log"
$errLogFile = Join-Path $logDir "jarvis.err.log"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

# Real "already running?" check - not just "does the PID file exist" (a
# stale file from a crash/force-kill would otherwise block every future
# start forever).
if (Test-Path $pidFile) {
  $existingPidText = Get-Content $pidFile -ErrorAction SilentlyContinue
  $existingPid = 0
  if ($existingPidText -and [int]::TryParse($existingPidText, [ref]$existingPid)) {
    $existingProc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existingProc) {
      Write-Output "JARVIS already appears to be running (PID $existingPid). Run .\stop-jarvis.ps1 first if you want to restart it."
      exit 0
    }
  }
  Write-Output "Found a stale .jarvis.pid (process not actually running) - clearing it."
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# Clear any leftover stop-flag from a previous run (e.g. one that was
# force-killed before it got a chance to clean this up itself).
if (Test-Path $stopFile) {
  Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
}

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
  Write-Error "'bun' not found on PATH. Install it from https://bun.sh and re-run this script."
  exit 1
}
$bunPath = $bunCmd.Source

# Same real invocation as running `bun run dev listen` by hand at a
# terminal (package.json's "dev" script is `bun run src/cli.ts`, and bun
# forwards "listen" through to it) - not a different/lighter code path.
$proc = Start-Process `
  -FilePath $bunPath `
  -ArgumentList @("run", "dev", "listen") `
  -WorkingDirectory $RepoPath `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errLogFile `
  -PassThru

$proc.Id | Out-File -FilePath $pidFile -Encoding ascii -NoNewline

Write-Output "JARVIS started in the background (PID $($proc.Id))."
Write-Output "  Log:        $logFile"
Write-Output "  Error log:  $errLogFile"
Write-Output ""
Write-Output "Say 'Jarvis' any time - the native HUD is hidden until it actually hears you, then pops up on its own."
Write-Output "To stop it:  .\stop-jarvis.ps1"
Write-Output "To check on it while it's running: Get-Content '$logFile' -Tail 20 -Wait"
