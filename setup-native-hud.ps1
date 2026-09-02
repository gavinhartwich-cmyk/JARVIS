<#
.SYNOPSIS
  Builds the native JARVIS HUD overlay (native-hud/) - a real WPF+WebView2
  Windows app that replaces the previous Edge --app-mode browser window.

.DESCRIPTION
  Windows-only by design (WPF has no cross-platform equivalent) - unlike
  setup-voice.ps1/setup-chatterbox.ps1, there is deliberately no .sh
  companion for this script.

  Requires the .NET 8 SDK:
    winget install --id Microsoft.DotNet.SDK.8
  or https://dotnet.microsoft.com/download/dotnet/8.0

  Builds a Release, framework-dependent exe (not self-contained - keeps
  the build fast and out of git, same reasoning as tools/piper,
  tools/whisper, tools/chatterbox being gitignored builds rather than
  committed binaries) at:
    native-hud\bin\Release\net8.0-windows\JarvisHud.exe

  src/cli.ts's 'listen' command looks for exactly that path - if it's not
  there, 'listen' falls back to the previous Edge --app-mode window
  automatically (with a console note), it does not hard-fail.

.EXAMPLE
  .\setup-native-hud.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$projectDir = Join-Path $repoRoot "native-hud"

$dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnetCmd) {
  Write-Host "dotnet CLI not found on PATH. Install the .NET 8 SDK first:" -ForegroundColor Red
  Write-Host "  winget install --id Microsoft.DotNet.SDK.8"
  Write-Host "  (or https://dotnet.microsoft.com/download/dotnet/8.0)"
  exit 1
}

Write-Host "Building native JARVIS HUD (native-hud/) ..."
Push-Location $projectDir
try {
  dotnet build -c Release
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$exePath = Join-Path $projectDir "bin\Release\net8.0-windows\JarvisHud.exe"
if (Test-Path $exePath) {
  Write-Host "Built: $exePath" -ForegroundColor Green
  Write-Host "'bun run dev listen' will now use this instead of the Edge app-mode window."
} else {
  Write-Host "dotnet build reported success but the expected exe wasn't found at:" -ForegroundColor Yellow
  Write-Host "  $exePath"
  Write-Host "Check native-hud\JarvisHud.csproj's TargetFramework still matches this path."
}
