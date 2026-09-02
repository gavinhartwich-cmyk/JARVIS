<#
.SYNOPSIS
  Removes the Startup-folder shortcut installed by install-jarvis-autostart.ps1.
  Does not stop an already-running JARVIS instance - see stop-jarvis.ps1 for that.

.EXAMPLE
  .\uninstall-jarvis-autostart.ps1
#>
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "JARVIS.lnk"

if (Test-Path $shortcutPath) {
  Remove-Item $shortcutPath -Force
  Write-Output "Removed: $shortcutPath"
  Write-Output "JARVIS will no longer start automatically at login."
} else {
  Write-Output "No autostart shortcut found at $shortcutPath - nothing to remove."
}
