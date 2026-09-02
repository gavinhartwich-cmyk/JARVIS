<#
.SYNOPSIS
  Installs a Windows Startup-folder shortcut so JARVIS starts
  automatically, hidden, every time you log in.

.DESCRIPTION
  [ADDED 2026-09-02] Deliberately a SEPARATE, opt-in script from
  start-jarvis.ps1 - run start-jarvis.ps1/stop-jarvis.ps1 by hand a few
  times first and confirm that flow actually works well before this
  starts running automatically every login. Creates a real .lnk in the
  current user's Startup folder (shell:startup) via the standard
  WScript.Shell COM shortcut API - the same mechanism Windows' own
  "Startup apps" settings page manages, no new dependency. Easy to
  remove: uninstall-jarvis-autostart.ps1, or by hand (Win+R -> shell:startup).

.PARAMETER RepoPath
  Path to the JARVIS repo. Default: wherever this script itself lives.

.EXAMPLE
  .\install-jarvis-autostart.ps1
#>
param(
  [string]$RepoPath = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "JARVIS.lnk"
$startScript = Join-Path $RepoPath "start-jarvis.ps1"

if (-not (Test-Path $startScript)) {
  Write-Error "start-jarvis.ps1 not found at $startScript - run this from the JARVIS repo root."
  exit 1
}

$powershellCmd = Get-Command powershell -ErrorAction SilentlyContinue
if (-not $powershellCmd) {
  Write-Error "'powershell' not found on PATH - can't build the startup shortcut's target."
  exit 1
}

$wshell = New-Object -ComObject WScript.Shell
$shortcut = $wshell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellCmd.Source
# -WindowStyle Hidden here hides THIS launcher's own console - the real
# JARVIS process it starts is already hidden independently by
# start-jarvis.ps1's own Start-Process -WindowStyle Hidden call.
$shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$shortcut.WorkingDirectory = $RepoPath
$shortcut.Description = "Starts JARVIS in the background at login"
$shortcut.Save()

Write-Output "Installed: $shortcutPath"
Write-Output "JARVIS will now start automatically (hidden) the next time you log in."
Write-Output "To undo: .\uninstall-jarvis-autostart.ps1  (or delete the shortcut yourself: Win+R -> shell:startup)"
