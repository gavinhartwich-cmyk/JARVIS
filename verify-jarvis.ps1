<#
.SYNOPSIS
  JARVIS system verification - runs the 11-step check from Gavin's
  OmniRoute Routing Directive (2026-08-27) and categorizes every failure.

.DESCRIPTION
  Assumes setup-jarvis.ps1 has already been run at least once (Postgres
  role/db created, bun install done, .env in place). This script focuses on
  the *runtime* verification: services up, providers reachable, and each
  phase's real CLI command actually exercised end to end.

  For every step, the result is one of:
    PASS  - ran and returned real, non-error output
    FAIL  - ran and failed; category is one of:
              configuration | provider-availability | latency |
              authentication | application-code | windows-integration |
              hardware | unknown
    SKIP  - deliberately not run (see reason in the log)

  Nothing here is destructive by default. Provider-fallback testing (which
  requires deliberately taking OmniRoute down) is opt-in via -TestFallback.

.PARAMETER RepoPath
  Path to the JARVIS repo. Default: E:\JARVIS (or wherever this script is,
  if E:\JARVIS doesn't exist).

.PARAMETER TestFallback
  If set, step 11 actually stops OmniRoute mid-run to confirm the gateway
  falls back to Ollama, then restarts OmniRoute afterward. Off by default
  because it's the one genuinely disruptive step.

.PARAMETER VisionTestImage
  Path to an image file to use for the Phase 3 vision-test step. If not
  given, the script looks for any .png/.jpg under the repo's
  test-assets\ folder or the user's Pictures folder; if none is found,
  that step is SKIPped with instructions rather than guessed at.

.EXAMPLE
  .\verify-jarvis.ps1
  .\verify-jarvis.ps1 -TestFallback
  .\verify-jarvis.ps1 -VisionTestImage "C:\Users\Gavin\Pictures\desk.jpg"
#>

param(
  [string]$RepoPath = $(if (Test-Path "E:\JARVIS") { "E:\JARVIS" } else { $PSScriptRoot }),
  [switch]$TestFallback,
  [string]$VisionTestImage
)

$ErrorActionPreference = "Continue"

# bun writes UTF-8 to stdout (including the emoji in JARVIS's own
# console.log calls). Windows PowerShell 5.1 decodes captured child-process
# output using [Console]::OutputEncoding, which defaults to the system's
# legacy codepage, not UTF-8 - without this, that output comes through as
# mojibake (confirmed live in setup-jarvis.ps1's log - same underlying
# issue, fixed there the same way). Wrapped in try/catch since setting
# console encoding can throw in a non-interactive host; never worth failing
# the whole script over a cosmetic fix.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # Non-fatal.
}

$results = @()
$logDir = Join-Path $RepoPath "setup-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $logDir "verify-$timestamp.log"

function Write-Log {
  param([string]$Message)
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
  Write-Host $line
  # -Encoding UTF8 matters here too: Add-Content's default encoding in
  # Windows PowerShell 5.1 is NOT UTF-8, so without this the log file would
  # re-corrupt already-correct text on the way to disk.
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Add-Result {
  param(
    [string]$Step,
    [ValidateSet("PASS", "FAIL", "SKIP")][string]$Status,
    [string]$Category = "",
    [string]$Detail = ""
  )
  $script:results += [PSCustomObject]@{
    Step     = $Step
    Status   = $Status
    Category = $Category
    Detail   = $Detail
  }
  $marker = switch ($Status) { "PASS" { "[OK]" }; "FAIL" { "[FAIL]" }; "SKIP" { "[SKIP]" } }
  Write-Log "$marker [$Step] $Status $(if ($Category) { "($Category)" }) $Detail"
}

# Every FAIL's "Detail" above is only the last handful of lines - and
# JARVIS's own cli.ts always prints a trailing blank line (and a
# "Disconnected from PostgreSQL"-style line) in its finally block
# regardless of which command ran, so on a real failure that tail can be
# blank or unhelpful even when the full output has the actual answer
# earlier in it. Dump the complete captured stdout+stderr for every
# Invoke-JarvisCommand call, right into the same log, so a failure never
# requires a second round trip just to see what the command actually
# printed.
function Write-FullOutput {
  param([string]$Label, [hashtable]$Result)
  Write-Log "----- FULL OUTPUT [$Label] (exit=$($Result.ExitCode)) -----"
  if ($Result.Output) {
    $Result.Output -split "`n" | ForEach-Object { Write-Log "    $_" }
  } else {
    Write-Log "    (empty)"
  }
  Write-Log "----- END FULL OUTPUT [$Label] -----"
}

# Rough, cheap failure classifier - good enough to point you at the right
# fix, not a substitute for reading the actual error.
function Get-FailureCategory {
  param([string]$Output)
  if ($Output -match "ECONNREFUSED|is OmniRoute running|is .ollama serve. running|Could not reach|Unable to connect|actively refused") { return "provider-availability" }
  if ($Output -match "401|403|Unauthorized|invalid.*api.*key|API key") { return "authentication" }
  if ($Output -match "timed? ?out|TimeoutError|ETIMEDOUT") { return "latency" }
  if ($Output -match "not recognized as|command not found|ENOENT|No such file") { return "configuration" }
  if ($Output -match "PowerShell|Win32|COM object|System\.Management") { return "windows-integration" }
  if ($Output -match "microphone|audio device|no input device|camera") { return "hardware" }
  if ($Output -match "TypeError|ReferenceError|is not a function|undefined is not") { return "application-code" }
  return "unknown"
}

# One-time resolution of the real "bun" launch target, cached for every
# Invoke-JarvisCommand call below. Just like "omniroute" earlier in this
# script, "bun" can resolve to a native bun.exe (the official installer) OR
# to an npm-created .cmd/.ps1 shim (if it was installed with
# "npm install -g bun") - Start-Process/Process launching a shim directly
# is the exact same unreliable pattern already confirmed and fixed for
# omniroute above (routed through cmd.exe /c there). This resolves it once
# up front instead of guessing per call.
$script:BunLauncherFile = $null
$script:BunLauncherPrefix = ""
function Resolve-BunLauncher {
  if ($script:BunLauncherFile) { return }
  $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bunCmd) {
    Write-Log "WARNING: could not resolve 'bun' via Get-Command - falling back to literal 'bun' and hoping PATH resolves it."
    $script:BunLauncherFile = "bun"
    return
  }
  $bunPath = $bunCmd.Source
  if ($bunPath -like "*.cmd" -or $bunPath -like "*.bat") {
    # NOTE (2026-08-28, capture-mechanism rewrite): this used to route
    # through an explicit inner "cmd.exe /c" here, because the OLD
    # Invoke-JarvisCommand launched things via a raw .NET Process with no
    # shell at all, and .NET can't exec a .cmd/.bat directly as FileName
    # without one. Invoke-CapturedCommand now ALWAYS wraps every launch in
    # exactly one outer cmd.exe of its own (for file-based redirection -
    # see its comments) - and that single outer cmd.exe can already run a
    # .cmd/.bat file directly as the first token of its own /c payload, the
    # same as typing the path at a cmd prompt. Nesting a SECOND cmd.exe
    # here on top of that would mean re-quoting an already-quoted command
    # line through two independent passes of cmd.exe's notoriously
    # inconsistent quote handling - a real source of corruption for a
    # shim path or arguments containing spaces/quotes. Just point straight
    # at the shim; the outer wrapper handles it.
    Write-Log "bun resolved to a shim ($bunPath) - the verify script's own cmd.exe wrapper will invoke it directly."
    $script:BunLauncherFile = $bunPath
  } elseif ($bunPath -like "*.ps1") {
    $cmdSibling = [System.IO.Path]::ChangeExtension($bunPath, ".cmd")
    if (Test-Path $cmdSibling) {
      Write-Log "bun resolved to a .ps1 shim - using its .cmd sibling ($cmdSibling) directly."
      $script:BunLauncherFile = $cmdSibling
    } else {
      Write-Log "bun resolved to a .ps1 shim with no .cmd sibling - launching via powershell.exe -File."
      $script:BunLauncherFile = "powershell.exe"
      $script:BunLauncherPrefix = "-NoProfile -ExecutionPolicy Bypass -File `"$bunPath`""
    }
  } else {
    $script:BunLauncherFile = $bunPath
  }
}

function Invoke-CapturedCommand {
  # Root cause of every timeout in the first verify run: Start-Process
  # -NoNewWindow combined with -RedirectStandardOutput/-RedirectStandardError
  # is a long-documented PowerShell hang - -NoNewWindow makes the child
  # SHARE the parent's console instead of getting its own, which can
  # deadlock the redirection and also lets a still-alive orphaned child
  # bleed output onto a later step's capture (this matches step 7's
  # garbled detail text, which looked like leftover Phase 0 output - almost
  # certainly an orphan from an earlier "killed" step that was never
  # actually terminated, just detached from).
  #
  # A second, separate, and probably even bigger bug was found and fixed
  # here at the same time: the parameter was originally named $Args. That
  # collides with $Args/$args, PowerShell's own automatic variable for a
  # function's unbound leftover arguments - actually running this against
  # a fake CLI in a sandbox (not just reading it) showed the named
  # parameter binding silently loses the value: inside the function,
  # $Args always came back empty no matter what was passed to it. So
  # every call in the original script was really invoking "bun run dev "
  # with nothing after "dev" - not "bun run dev test", not
  # "bun run dev conversation ...", nothing. That alone, independent of
  # the Start-Process/redirection issue above, is enough by itself to
  # explain every step timing out identically regardless of which
  # subcommand it claimed to run. Renamed to $CommandArgs everywhere.
  #
  # Third bug, found from the 19:21:55 run after the first two fixes:
  # process runs, exits 0, and real side effects happen (Notepad genuinely
  # opens/closes, the LLM classifier genuinely fires) - but captured
  # Output comes back completely empty for every command that goes
  # through the "dev" package.json script name. Root cause: package.json
  # defines "dev": "bun run src/cli.ts" - so "bun run dev" doesn't run
  # cli.ts directly, it matches the package.json script NAME "dev" first,
  # which bun then executes by shelling out to the system shell to run the
  # literal string "bun run src/cli.ts" as a brand new command line. Fixed
  # by dropping "run" entirely and calling the file directly - "bun
  # src/cli.ts <args>" - bun's most primitive execution mode.
  #
  # FOURTH bug, found from the 2026-08-28 21:16 run on Gavin's actual
  # machine, AFTER all three fixes above were already in place and
  # verified working end-to-end in a Linux sandbox: Step 0's own
  # dependency-free sanity check (a bare bun one-liner, no cli.ts, no
  # imports, nothing that could fail for a JARVIS-specific reason) came
  # back with BOTH stdout and stderr completely empty - "stdout captured:
  # []" / "stderr captured: []" - despite the process exiting cleanly
  # (code 0). That isolates the failure to the capture mechanism itself,
  # specifically on this machine: something here (a security product
  # hooking CreateProcess, a handle-inheritance quirk, or similar) is
  # silently breaking .NET's own in-memory pipe redirection
  # (ProcessStartInfo.RedirectStandardOutput/Error + ReadToEndAsync) even
  # though the child process itself runs and exits correctly - changing
  # *how* those pipes are read (event-based vs Task-based, timing, etc.)
  # can't fix this, because the pipes are receiving nothing to begin with.
  #
  # Fixed by not routing capture through .NET pipes at all: the real
  # command is wrapped in one outer `cmd.exe /d /c ... > file 2> file`, so
  # cmd.exe's own shell redirection operators write stdout/stderr directly
  # to real files at the OS level - a completely different code path from
  # ProcessStartInfo's pipe redirection, and one that doesn't depend on it
  # working. `cmd /c` also correctly propagates the wrapped command's own
  # exit code as its own ($LASTEXITCODE / %ERRORLEVEL% passthrough is
  # standard cmd.exe behavior), so Success/ExitCode below are unaffected
  # by the extra wrapping layer. Verified deterministic across 3 full runs
  # x 10 repeated iterations each against a fake ~2MB-per-stream
  # stdout+stderr producer in a Linux sandbox (via pwsh) before shipping,
  # zero failures. Resolve-BunLauncher was also simplified alongside this
  # (2026-08-28) so a .cmd/.bat shim is pointed at directly instead of
  # pre-wrapped in its own inner "cmd.exe /c" - this outer wrapper is now
  # the ONLY cmd.exe involved in any case, deliberately avoiding a second,
  # nested cmd.exe invocation (which would mean re-parsing an
  # already-quoted command line through cmd.exe's own notoriously
  # inconsistent quoting twice) - exercised in the same sandbox with a
  # shim path containing spaces and multi-word quoted arguments.
  #
  # On timeout, the whole process TREE is killed via taskkill /T /F (not
  # just the top PID), so no orphan lingers to corrupt a later step.
  #
  # Factored out of Invoke-JarvisCommand so Step 0's sanity check exercises
  # this EXACT same code path (not a separately-maintained copy that could
  # silently drift from what every real step actually uses) - if Step 0
  # passes, every later step's capture is known-good, not just assumed so.
  #
  # FIFTH bug, found from the 23:08 run right after the fourth fix shipped:
  # every single step - including ones that should take many real seconds
  # (an LLM round trip, Notepad opening) - completed in about two seconds
  # total, with capture back to fully empty AND the exit code itself
  # rendering blank. That combination (near-instant completion, nothing
  # produced at all) pointed at the outer cmd.exe never successfully
  # running the real command, not just a capture gap. Root cause: the
  # ArgumentList fix for bug four is correct in general, but wrong
  # specifically for a `cmd.exe /c <payload>` invocation - when the
  # payload argument itself contains embedded double quotes (it always
  # does here: the quoted exe path, the quoted redirect targets), .NET's
  # ArgumentList serializer backslash-escapes each embedded `"` the way a
  # normal CommandLineToArgvW-compliant program expects - but cmd.exe does
  # NOT parse `/c` payloads that way; it does its own idiosyncratic
  # quote-handling and has no idea what a backslash-escaped quote means,
  # so it sees literal stray backslashes and a scrambled quote structure.
  # Reproduced exactly in a Linux sandbox by hand-simulating .NET's own
  # escaping algorithm against this function's real inner command string -
  # confirmed the command cmd.exe would actually receive is corrupted this
  # way. This is a well-documented, general pitfall of invoking `cmd /c`
  # programmatically (affects more than just .NET), not specific to this
  # script's logic being wrong in isolation.
  #
  # Fixed by not passing the complex quoted command through argv escaping
  # AT ALL: it's written as plain text into a temporary .bat file instead,
  # and cmd.exe is only ever given that file's PATH as its /c argument -
  # a simple string with no embedded quotes of its own, so there is
  # nothing left for any layer to mis-escape. A .bat file's contents are
  # read from disk and interpreted by cmd.exe exactly as if typed at an
  # interactive prompt, with no argv round-trip involved.
  param([string]$FileName, [string]$Arguments, [int]$TimeoutSec = 180, [string]$WorkDir = ".")
  $proc = $null
  $tmpId = [guid]::NewGuid().ToString('N')
  $stdoutFile = Join-Path ([System.IO.Path]::GetTempPath()) "jarvis-verify-out-$tmpId.txt"
  $stderrFile = Join-Path ([System.IO.Path]::GetTempPath()) "jarvis-verify-err-$tmpId.txt"
  $batFile = Join-Path ([System.IO.Path]::GetTempPath()) "jarvis-verify-cmd-$tmpId.bat"
  try {
    $batContent = "@echo off`r`n`"$FileName`" $Arguments > `"$stdoutFile`" 2> `"$stderrFile`"`r`nexit /b %ERRORLEVEL%`r`n"
    [System.IO.File]::WriteAllText($batFile, $batContent, [System.Text.Encoding]::ASCII)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    # SIXTH bug, found from the 11:35 run right after the fifth fix shipped:
    # every step now failed instantly and uniformly with a genuinely useful
    # error for once (the new try/catch did its job) - "You cannot call a
    # method on a null-valued expression", from the very first
    # $psi.ArgumentList.Add(...) call. ArgumentList is a real
    # ProcessStartInfo property (added .NET Framework 4.7.2 / .NET Core
    # 2.1), and it worked perfectly in every test run against pwsh
    # (PowerShell 7 / .NET) in this sandbox - but Gavin's machine runs
    # Windows PowerShell 5.1 on the full .NET Framework, a genuinely
    # different runtime this sandbox has no way to install and actually
    # exercise, and evidently ArgumentList comes back null there on first
    # access instead of auto-vivifying an empty collection the way it does
    # under pwsh. Rather than chase a version-specific compatibility gap in
    # a property this script no longer even needs the smarts of - the
    # .bat-file fix already means the only thing being passed as an
    # argument is a plain temp path with no embedded quotes to escape -
    # dropped ArgumentList entirely and went back to a plain .Arguments
    # string, which has worked identically across every PowerShell/.NET
    # version there's ever been and carries none of this risk.
    $psi.Arguments = "/d /c `"$batFile`""
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    # Stdin redirected-then-closed immediately, so if the command ever
    # tries to read a line from stdin with no console attached it gets an
    # instant EOF instead of hanging until the timeout kills it.
    try { $proc.StandardInput.Close() } catch { }

    $finished = $proc.WaitForExit([int]($TimeoutSec * 1000))
    if (-not $finished) {
      try { & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null } catch { }
      try { [void]$proc.WaitForExit(5000) } catch { }
      # SEVENTH bug, found 2026-08-30: this branch used to return a bare
      # "TIMED OUT" string with no attempt to read the redirect files -
      # which is exactly why every single timeout ever logged showed zero
      # partial output, even on steps with real, useful progress (Phase 0's
      # own checks print as they complete). cmd.exe's redirection writes
      # stdout/stderr to these files continuously as the child runs, not
      # only at clean exit, so whatever made it to disk before the kill is
      # sitting right there. Read it the same way the success path does,
      # so a timeout finally shows what actually happened before the cutoff
      # instead of a dead end that looks identical whether the process was
      # one line or one page into its work.
      $partialStdout = ""; $partialStderr = ""
      for ($i = 0; $i -lt 5; $i++) {
        try {
          if (Test-Path -LiteralPath $stdoutFile) { $partialStdout = [System.IO.File]::ReadAllText($stdoutFile) }
          if (Test-Path -LiteralPath $stderrFile) { $partialStderr = [System.IO.File]::ReadAllText($stderrFile) }
          break
        } catch { Start-Sleep -Milliseconds 200 }
      }
      $partialCombined = "$partialStdout`n$partialStderr".Trim()
      $timeoutMsg = "TIMED OUT after ${TimeoutSec}s"
      if ($partialCombined) {
        $timeoutMsg += " - partial output captured before kill:`n$partialCombined"
      } else {
        $timeoutMsg += " - no output was written to the redirect files before the kill (genuinely produced nothing yet, not just uncaptured)."
      }
      return @{ Success = $false; Output = $timeoutMsg; ExitCode = -1 }
    }

    $exitCode = -999
    try { $exitCode = [int]$proc.ExitCode } catch { $exitCode = -998 }

    # The outer cmd.exe has exited, which means its own redirection
    # handles are closed and the files are complete - but retry briefly
    # anyway in case the filesystem hasn't finished flushing.
    $stdout = ""; $stderr = ""
    for ($i = 0; $i -lt 10; $i++) {
      try {
        if (Test-Path -LiteralPath $stdoutFile) { $stdout = [System.IO.File]::ReadAllText($stdoutFile) }
        if (Test-Path -LiteralPath $stderrFile) { $stderr = [System.IO.File]::ReadAllText($stderrFile) }
        break
      } catch { Start-Sleep -Milliseconds 200 }
    }
    $combined = "$stdout`n$stderr"
    if (-not (Test-Path -LiteralPath $stdoutFile) -and -not (Test-Path -LiteralPath $stderrFile)) {
      # Neither file ever got created - the wrapper itself failed before
      # the real command ran. Surface that plainly instead of a silent
      # blank, so a NEW problem here is diagnosable from the log alone.
      $combined = "[DIAGNOSTIC: neither redirect file was created - cmd.exe (exit $exitCode) likely failed before running the real command. .bat content was:`n$batContent]"
    }
    return @{ Success = ($exitCode -eq 0); Output = $combined; ExitCode = $exitCode }
  } catch {
    # Belt-and-suspenders: surface the real exception instead of letting a
    # bug here ever again show up as a silent blank result.
    return @{ Success = $false; Output = "Invoke-CapturedCommand threw: $($_.Exception.GetType().FullName): $($_.Exception.Message)"; ExitCode = -997 }
  } finally {
    if ($proc) { try { $proc.Dispose() } catch { } }
    Remove-Item -Path $stdoutFile, $stderrFile, $batFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-JarvisCommand {
  param([string]$CommandArgs, [int]$TimeoutSec = 180)
  Resolve-BunLauncher
  Push-Location $RepoPath
  try {
    $fullArgs = if ($script:BunLauncherPrefix) { "$($script:BunLauncherPrefix) src/cli.ts $CommandArgs" } else { "src/cli.ts $CommandArgs" }
    return Invoke-CapturedCommand -FileName $script:BunLauncherFile -Arguments $fullArgs -TimeoutSec $TimeoutSec -WorkDir $RepoPath
  } finally {
    Pop-Location
  }
}

Write-Log "=========================================="
Write-Log "JARVIS Verification - $timestamp"
Write-Log "Repo: $RepoPath"
Write-Log "=========================================="

# --- Load .env into this process's environment (steps below need it) ---
$envPath = Join-Path $RepoPath ".env"
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
  }
  Write-Log "Loaded .env from $envPath"
} else {
  Write-Log "WARNING: no .env found at $envPath - provider keys won't be loaded."
}

# ============================================================
# Step 0: Sanity-check the capture mechanism itself, isolated from cli.ts
# entirely - added 2026-08-27 after a run where EVERY step past step 4 came
# back with fully empty captured output (not just a truncated tail - the
# complete stdout+stderr dump was blank) while step 5 hit its full 180s
# timeout, yet real side effects (Notepad opening/closing) kept proving the
# underlying commands were actually running. That split (real execution,
# zero captured text) means either something is wrong with Invoke-
# JarvisCommand's capture itself on this machine specifically (it passed
# every test I could run in a Linux sandbox, but this machine is the real
# target and the only one that matters), or something specific to running
# the full cli.ts is swallowing its own output before this function ever
# sees it. This step tells those two apart with a trivial, dependency-free
# bun one-liner - no Postgres, no gateway, no imports, nothing that could
# fail for a JARVIS-specific reason - so a failure here points squarely at
# the capture layer, and a pass here (with cli.ts itself still empty)
# points squarely at something inside cli.ts's own execution.
# ============================================================
Write-Log "`n--- Step 0: Capture mechanism sanity check (bare bun, no cli.ts) ---"
Resolve-BunLauncher
$rawArgs = if ($script:BunLauncherPrefix) {
  "$($script:BunLauncherPrefix) -e `"console.log('CAPTURE_TEST_STDOUT_OK'); console.error('CAPTURE_TEST_STDERR_OK');`""
} else {
  "-e `"console.log('CAPTURE_TEST_STDOUT_OK'); console.error('CAPTURE_TEST_STDERR_OK');`""
}
# Runs through the exact same Invoke-CapturedCommand helper every real step
# below uses (see its comments for the file-redirection rewrite and why) -
# so a PASS here means every later step's capture is known-good on this
# machine, not just assumed so from a sandbox test elsewhere.
$diagResult = Invoke-CapturedCommand -FileName $script:BunLauncherFile -Arguments $rawArgs -TimeoutSec 15 -WorkDir $RepoPath
if ($diagResult.ExitCode -eq -1 -and $diagResult.Output -match "^TIMED OUT") {
  Add-Result -Step "0. Capture sanity check" -Status FAIL -Category "windows-integration" -Detail "The trivial bun one-liner itself timed out after 15s - something is wrong launching bun at all (FileName=$($script:BunLauncherFile), Args=$rawArgs), separate from anything cli.ts-specific."
} else {
  Write-Log "    stdout+stderr captured: [$($diagResult.Output.Trim())]"
  if ($diagResult.Output -match "CAPTURE_TEST_STDOUT_OK" -and $diagResult.Output -match "CAPTURE_TEST_STDERR_OK") {
    Add-Result -Step "0. Capture sanity check" -Status PASS -Detail "Capture mechanism works correctly on this machine - a later step showing empty output is specific to that step's command, not the harness."
  } else {
    Add-Result -Step "0. Capture sanity check" -Status FAIL -Category "windows-integration" -Detail "Process ran and exited (code $($diagResult.ExitCode)) but expected markers were not captured - the capture mechanism itself is broken on this machine (FileName=$($script:BunLauncherFile), Prefix=$($script:BunLauncherPrefix))."
  }
}

# ============================================================
# Step 1: Start Ollama
# ============================================================
Write-Log "`n--- Step 1: Ollama ---"
$ollamaUp = $false
try {
  $r = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 5
  $ollamaUp = $true
} catch { $ollamaUp = $false }

if (-not $ollamaUp) {
  Write-Log "Ollama not responding - attempting to start it..."
  try {
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    $tries = 0
    while (-not $ollamaUp -and $tries -lt 10) {
      Start-Sleep -Seconds 2
      try {
        $r = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 3
        $ollamaUp = $true
      } catch { $tries++ }
    }
  } catch {
    Add-Result -Step "1. Start Ollama" -Status FAIL -Category "configuration" -Detail "ollama executable not found on PATH: $($_.Exception.Message)"
  }
}
if ($ollamaUp) {
  Add-Result -Step "1. Start Ollama" -Status PASS -Detail "Responding on :11434"
} elseif ($results[-1].Step -ne "1. Start Ollama") {
  Add-Result -Step "1. Start Ollama" -Status FAIL -Category "provider-availability" -Detail "Not reachable on :11434 after starting."
}

# ============================================================
# Step 2: Confirm required local models are installed
# ============================================================
Write-Log "`n--- Step 2: Required local models ---"
$requiredModels = @(
  @{ Name = ($env:OLLAMA_MODEL); Default = "qwen2.5-coder:1.5b"; Purpose = "text (Ollama fallback)" },
  @{ Name = ($env:OLLAMA_VISION_MODEL); Default = "moondream"; Purpose = "vision" }
)
if ($ollamaUp) {
  try {
    $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 5
    $installed = $tags.models | ForEach-Object { $_.name }
    foreach ($m in $requiredModels) {
      $wanted = if ($m.Name) { $m.Name } else { $m.Default }
      $have = $installed | Where-Object { $_ -eq $wanted -or $_ -like "$wanted*" }
      if ($have) {
        Add-Result -Step "2. Model: $wanted" -Status PASS -Detail "$($m.Purpose) - installed"
      } else {
        Add-Result -Step "2. Model: $wanted" -Status FAIL -Category "configuration" -Detail "$($m.Purpose) - NOT pulled. Run: ollama pull $wanted"
      }
    }
  } catch {
    Add-Result -Step "2. Required local models" -Status FAIL -Category "provider-availability" -Detail $_.Exception.Message
  }
} else {
  Add-Result -Step "2. Required local models" -Status SKIP -Detail "Ollama not up - see step 1"
}

# ============================================================
# Step 3: Start OmniRoute
# ============================================================
Write-Log "`n--- Step 3: OmniRoute ---"
$omniUp = $false
try {
  $r = Invoke-WebRequest -Uri "http://localhost:20128/v1/models" -TimeoutSec 5 -Headers @{ Authorization = "Bearer $($env:OMNIROUTE_API_KEY)" }
  $omniUp = ($r.StatusCode -eq 200)
} catch { $omniUp = $false }

if (-not $omniUp) {
  Write-Log "OmniRoute not responding - attempting to start it..."
  # Clean up a stale lock file from an earlier session, if present - this
  # was a confirmed real blocker last time (a manually-closed session
  # leaves server\.pid behind without deleting it).
  $pidFile = Join-Path $env:USERPROFILE ".omniroute\server\.pid"
  if (Test-Path $pidFile) {
    Write-Log "Removing stale OmniRoute lock file: $pidFile"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  $omniCmd = Get-Command omniroute -ErrorAction SilentlyContinue
  if ($omniCmd) {
    $cmdPath = $omniCmd.Source
    if ($cmdPath -like "*.ps1") {
      $sibling = [System.IO.Path]::ChangeExtension($cmdPath, ".cmd")
      if (Test-Path $sibling) { $cmdPath = $sibling }
    }
    # Route through cmd.exe /c explicitly - Start-Process launching a .cmd
    # directly with output redirection is unreliable (confirmed last run).
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$cmdPath`"" -WindowStyle Hidden

    Write-Log "Waiting for OmniRoute to come up (cold boot can take ~70s)..."
    $tries = 0
    while (-not $omniUp -and $tries -lt 40) {
      Start-Sleep -Seconds 3
      try {
        $r = Invoke-WebRequest -Uri "http://localhost:20128/v1/models" -TimeoutSec 3 -Headers @{ Authorization = "Bearer $($env:OMNIROUTE_API_KEY)" }
        $omniUp = ($r.StatusCode -eq 200)
      } catch { $tries++ }
    }
  } else {
    Add-Result -Step "3. Start OmniRoute" -Status FAIL -Category "configuration" -Detail "omniroute command not found on PATH - run: npm install -g omniroute"
  }
}

if ($omniUp) {
  Add-Result -Step "3. Start OmniRoute" -Status PASS -Detail "Responding on :20128"
} elseif ($results[-1].Step -ne "3. Start OmniRoute") {
  $appLog = Join-Path $env:USERPROFILE ".omniroute\logs\application\app.log"
  $tail = if (Test-Path $appLog) { (Get-Content $appLog -Tail 15) -join " | " } else { "(no app.log found)" }
  Add-Result -Step "3. Start OmniRoute" -Status FAIL -Category "provider-availability" -Detail "Not reachable on :20128 after ~120s wait. Log tail: $tail"
}

# ============================================================
# Step 4: Confirm OMNIROUTE_API_KEY loaded correctly
# ============================================================
Write-Log "`n--- Step 4: OMNIROUTE_API_KEY ---"
if (-not $env:OMNIROUTE_API_KEY) {
  Add-Result -Step "4. OMNIROUTE_API_KEY" -Status FAIL -Category "configuration" -Detail "Not set in .env"
} elseif (-not $omniUp) {
  Add-Result -Step "4. OMNIROUTE_API_KEY" -Status SKIP -Detail "Key is set, but couldn't confirm it's accepted - OmniRoute isn't up (see step 3)"
} else {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:20128/v1/models" -TimeoutSec 5 -Headers @{ Authorization = "Bearer $($env:OMNIROUTE_API_KEY)" }
    if ($r.StatusCode -eq 200) {
      Add-Result -Step "4. OMNIROUTE_API_KEY" -Status PASS -Detail "Accepted by /v1/models"
    } else {
      Add-Result -Step "4. OMNIROUTE_API_KEY" -Status FAIL -Category "authentication" -Detail "Unexpected status: $($r.StatusCode)"
    }
  } catch {
    Add-Result -Step "4. OMNIROUTE_API_KEY" -Status FAIL -Category "authentication" -Detail $_.Exception.Message
  }
}

# ============================================================
# Step 4.5: OmniRoute chat-completion smoke test (real request, ~20s cap)
# ============================================================
# Steps 3/4 only prove OmniRoute's own HTTP server is up and that the API
# key in .env is accepted by /v1/models - that endpoint just returns a
# model catalog, it does NOT prove OmniRoute can actually complete a real
# chat request. That needs at least one upstream provider to be genuinely
# connected and authenticated on OmniRoute's OWN side (its dashboard, not
# JARVIS's .env) - a self-hosted aggregator with zero working upstreams
# behind it can still answer /v1/models with 200 while every real
# completion hangs or errors. Step 5 below exercises this for real, but
# through 5+ sequential agent calls that can take up to 180s to fail, so a
# broken OmniRoute completion doesn't get isolated until the whole
# pipeline has already timed out. This does the single smallest possible
# completion request directly over HTTP - no cli.ts, no orchestrator, no
# agents, no bun process at all - with a tight 20s cap, so a real
# OmniRoute problem shows up here in seconds instead of 3 minutes, and
# answers directly whether OmniRoute itself is the thing set up wrong.
# Verified against a fake local server standing in for OmniRoute covering:
# a real 200+content reply, a 200 with empty content (the "no upstream
# provider" shape), a 500, a timeout, and connection-refused - all five
# categorized and reported correctly before this shipped.
Write-Log "`n--- Step 4.5: OmniRoute chat-completion smoke test ---"
if (-not $omniUp) {
  Add-Result -Step "4.5. OmniRoute completion smoke test" -Status SKIP -Detail "OmniRoute isn't up - see step 3"
} else {
  $smokeModel = if ($env:OMNIROUTE_MODEL) { $env:OMNIROUTE_MODEL } else { "auto" }
  # BUG FIX (2026-08-28 run): this body omitted "stream" entirely. The real
  # omniroute-provider.ts always sends "stream": false explicitly - this
  # smoke test didn't, and the 21:16 run failed with "Invalid JSON
  # primitive: data." which is PowerShell's ConvertFrom-Json choking on an
  # SSE-formatted body ("data: {...}\n\n") - i.e. OmniRoute answered with a
  # streaming response because nothing here told it not to. That's a bug in
  # THIS test, not evidence OmniRoute has no working provider: JARVIS's own
  # code was never actually exposed to this, since it always sets
  # stream:false. Added explicitly so this test matches real production
  # traffic.
  $smokeBody = @{
    model       = $smokeModel
    messages    = @(@{ role = "user"; content = "Reply with exactly one word: OK" })
    max_tokens  = 5
    temperature = 0
    stream      = $false
  } | ConvertTo-Json -Depth 5
  $swSmoke = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $smokeResp = Invoke-WebRequest -Uri "http://localhost:20128/v1/chat/completions" -Method Post `
      -Headers @{ Authorization = "Bearer $($env:OMNIROUTE_API_KEY)"; "Content-Type" = "application/json" } `
      -Body $smokeBody -TimeoutSec 20
    $swSmoke.Stop()
    $rawContent = $smokeResp.Content
    try {
      $smokeJson = $rawContent | ConvertFrom-Json
    } catch {
      # Belt-and-suspenders: if OmniRoute still answers with an SSE body
      # despite stream:false (a real OmniRoute-side quirk, not a "no
      # provider" situation), pull the last real data line out and parse
      # that instead of failing the whole step on a parse error alone.
      $dataLines = $rawContent -split "`n" | Where-Object { $_ -like "data:*" -and $_ -notlike "*[DONE]*" }
      if ($dataLines.Count -gt 0) {
        $smokeJson = ($dataLines[-1] -replace '^data:\s*', '') | ConvertFrom-Json
      } else {
        throw
      }
    }
    $smokeContent = $smokeJson.choices[0].message.content
    $smokeModelUsed = $smokeJson.model
    if ($smokeResp.StatusCode -eq 200 -and $smokeContent) {
      Add-Result -Step "4.5. OmniRoute completion smoke test" -Status PASS -Detail "Real completion in $([int]$swSmoke.Elapsed.TotalSeconds)s via model '$smokeModelUsed'. Reply: '$($smokeContent.Trim())'"
    } else {
      Add-Result -Step "4.5. OmniRoute completion smoke test" -Status FAIL -Category "provider-availability" -Detail "Got HTTP $($smokeResp.StatusCode) after $([int]$swSmoke.Elapsed.TotalSeconds)s but no completion content came back - this points at OmniRoute having no working upstream provider for model '$smokeModel', check OmniRoute's own dashboard for a connected/authenticated provider."
    }
  } catch {
    $swSmoke.Stop()
    $errBody = ""
    try {
      $respStream = $_.Exception.Response.GetResponseStream()
      if ($respStream) { $errBody = (New-Object System.IO.StreamReader($respStream)).ReadToEnd() }
    } catch { }
    $cat = Get-FailureCategory "$($_.Exception.Message) $errBody"
    Add-Result -Step "4.5. OmniRoute completion smoke test" -Status FAIL -Category $cat -Detail "Failed after $([int]$swSmoke.Elapsed.TotalSeconds)s using model '$smokeModel': $($_.Exception.Message) $errBody -- this points at OmniRoute itself (check its dashboard for at least one connected/authenticated upstream provider), not at JARVIS's own code."
  }
}

# ============================================================
# Step 5: Phase 0 live vertical slice
# ============================================================
# Timeout raised again 480s -> 630s (2026-08-30), now that partial-output
# capture on timeout is finally working (see Invoke-CapturedCommand's
# SEVENTH bug above) and actually showed why: a real run's captured output
# proved all 5 pipeline agents (researcher -> reasoner -> critic ->
# fact-checker -> synthesizer) completed with real confidence scores, and
# it died right after printing "Synthesizing results..." - which is NOT
# the synthesizer agent finishing (that already happened, one line above).
# orchestrator.ts's synthesizeResults() makes a SIXTH real LLM call -
# synthesizer.execute() again, this time over the combined output of all
# 5 agents - that the previous 480s figure never accounted for (it was
# computed as 5 calls x 90s = 450s + margin). Six calls x 90s (cli.ts's
# per-call timeoutMs) = 540s true worst case, not 450s. 630s gives real
# margin above that. If this still routinely runs long, pinning
# OMNIROUTE_MODEL to a specific faster model instead of "auto" (in .env)
# is worth trying - "auto" is convenient but doesn't let you pick for
# speed, and a live run showed "auto" sometimes cascading through several
# failed free-tier attempts before reaching a working paid model.
$r = Invoke-JarvisCommand -CommandArgs "test" -TimeoutSec 630
Write-FullOutput -Label "5.test" -Result $r
if ($r.Success) {
  Add-Result -Step "5. Phase 0 vertical slice" -Status PASS -Detail "Exit 0"
} else {
  Add-Result -Step "5. Phase 0 vertical slice" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail ($r.Output -split "`n" | Select-Object -Last 5) -join " "
}

# ============================================================
# Step 6: Conversational intelligence test
# ============================================================
Write-Log "`n--- Step 6: Conversation (Phase 1.5) ---"
$r = Invoke-JarvisCommand -CommandArgs 'conversation "Hey Jarvis, are you online and working?"' -TimeoutSec 120
Write-FullOutput -Label "6.conversation" -Result $r
if ($r.Success -and $r.Output -match "JARVIS:") {
  Add-Result -Step "6. Conversation (Phase 1.5)" -Status PASS -Detail "Got a real reply"
} else {
  Add-Result -Step "6. Conversation (Phase 1.5)" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail (($r.Output -split "`n" | Select-Object -Last 5) -join " ")
}

# ------------------------------------------------------------
# Step 6b: Conversational app-control (2026-08-27 feature) - "open
# Notepad" should actually launch it and reply proactively, not just
# talk about it. Opens then closes Notepad so nothing is left running.
# ------------------------------------------------------------
Write-Log "`n--- Step 6b: Conversational app-control (open/close Notepad) ---"
$rOpen = Invoke-JarvisCommand -CommandArgs 'conversation "open Notepad"' -TimeoutSec 60
Write-FullOutput -Label "6b.open" -Result $rOpen
$openedReally = (Get-Process -Name notepad -ErrorAction SilentlyContinue) -ne $null
if ($rOpen.Success -and $rOpen.Output -match "JARVIS:" -and $openedReally) {
  Add-Result -Step "6b. Conversational app-control (open)" -Status PASS -Detail "Notepad process confirmed running after the conversational request"
} elseif ($rOpen.Success -and $rOpen.Output -match "JARVIS:" -and -not $openedReally) {
  Add-Result -Step "6b. Conversational app-control (open)" -Status FAIL -Category "application-code" -Detail "Got a reply but no Notepad process was found running - action may not have actually executed. Reply: $((($rOpen.Output -split "JARVIS:")[-1]).Trim())"
} else {
  Add-Result -Step "6b. Conversational app-control (open)" -Status FAIL -Category (Get-FailureCategory $rOpen.Output) -Detail (($rOpen.Output -split "`n" | Select-Object -Last 5) -join " ")
}
Start-Sleep -Seconds 1
$rClose = Invoke-JarvisCommand -CommandArgs 'conversation "close Notepad"' -TimeoutSec 60
Write-FullOutput -Label "6b.close" -Result $rClose
Start-Sleep -Seconds 1
$stillRunning = (Get-Process -Name notepad -ErrorAction SilentlyContinue) -ne $null
if ($rClose.Success -and -not $stillRunning) {
  Add-Result -Step "6b. Conversational app-control (close)" -Status PASS -Detail "Notepad confirmed closed after the conversational request"
} else {
  Add-Result -Step "6b. Conversational app-control (close)" -Status FAIL -Category (Get-FailureCategory $rClose.Output) -Detail "Notepad still running or command failed - you may need to close it manually"
  Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------
# Step 6c: Natural-language app-control (2026-08-27 feature) - deliberately
# colloquial phrasing that the regex fast path will NOT match, to confirm
# the LLM classifier tier is actually catching it (not just the free
# regex path passing). This is the "not blocky like Alexa" test.
# ------------------------------------------------------------
Write-Log "`n--- Step 6c: Natural-language app-control (indirect phrasing, no exact keywords) ---"
$rNatural = Invoke-JarvisCommand -CommandArgs 'conversation "hey, could you get notepad going for me real quick"' -TimeoutSec 90
Write-FullOutput -Label "6c.natural" -Result $rNatural
$openedNaturally = (Get-Process -Name notepad -ErrorAction SilentlyContinue) -ne $null
if ($rNatural.Success -and $openedNaturally) {
  Add-Result -Step "6c. Natural-language app-control" -Status PASS -Detail "Colloquial phrasing (not matched by the regex tier) correctly opened Notepad via the LLM classifier"
} else {
  Add-Result -Step "6c. Natural-language app-control" -Status FAIL -Category (Get-FailureCategory $rNatural.Output) -Detail "Colloquial phrasing did not open Notepad - classifier may have missed it, or the provider call itself failed. Reply: $((($rNatural.Output -split "JARVIS:")[-1]).Trim())"
}
Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue

# ============================================================
# Step 7: Phase 1 developer pipeline (safe, small, no --approve)
# ============================================================
Write-Log "`n--- Step 7: Phase 1 developer pipeline (no --approve, so nothing gets committed) ---"
# EIGHTH bug, found from the 23:47:57 run: this requirement asked for a
# one-line comment above callModel() "explaining what it does" - which an
# EARLIER real fix in this same file already added (a whole block
# documenting its behavior and history). The Coder correctly looked at the
# real existing file content and said no change was needed - a legitimate,
# correct answer, not a bug - but developer.ts at the time treated any
# step4 non-success as a hard failure, so this step FAILed for a task that
# had, in effect, already been completed by prior work. Fixed on two
# fronts: developer.ts now returns a distinct non-failure status when the
# Coder determines a requirement is already satisfied, AND this requirement
# text is made self-refreshing (unique marker per run) so it can never
# again be pre-satisfied by a previous run's own output - keeping this step
# an actual live test of the Coder's editing ability, not a fossil.
# Timeout raised 600s -> 1500s (2026-08-30): a real run's captured partial
# output (see Invoke-CapturedCommand's SEVENTH bug above) showed the
# retry logic (added for the three-different-failure-modes issue) working
# exactly as designed - architect and planner both completed, then the
# Coder agent genuinely used its full 3-attempt budget - but the whole
# command got killed by THIS timeout mid-way through attempt 3, before it
# could even fail cleanly and let the pipeline report a real result. The
# 600s figure was never sized for the full worst-case chain: architect(1)
# + planner(1) + coder(up to 3 retries) + code-review(1) + security-review(1)
# + verify(1) = up to 8 real LLM calls even on a clean run, or up to 10 if
# the build/test debug loop fires (2 more debugger attempts) - each capped
# at 120s (developer.ts's timeoutMs) - true worst case is 1200s, not 600s.
# 1500s gives real margin above that instead of killing a pipeline that's
# genuinely still working through its own (real, evidence-based) retry
# budget.
$devReq = "Add this exact one-line comment directly above the callModel method in src/core/conversation-intelligence.ts: // verify-jarvis.ps1 Step 7 marker $timestamp (do not change behavior, do not remove any existing comments)"
$r = Invoke-JarvisCommand -CommandArgs "developer `"$devReq`"" -TimeoutSec 1500
Write-FullOutput -Label "7.developer" -Result $r
if ($r.Success) {
  Add-Result -Step "7. Phase 1 developer pipeline" -Status PASS -Detail "Pipeline ran to the approval gate (nothing committed - no --approve was passed)"
} else {
  Add-Result -Step "7. Phase 1 developer pipeline" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail (($r.Output -split "`n" | Select-Object -Last 8) -join " ")
}

# ============================================================
# Step 8: Voice reply
# ============================================================
Write-Log "`n--- Step 8: Voice reply (Phase 2) ---"
$r = Invoke-JarvisCommand -CommandArgs 'voice-reply "This is a verification test of voice output."' -TimeoutSec 120
Write-FullOutput -Label "8.voice-reply" -Result $r
if ($r.Success -and $r.Output -match "Spoken reply saved to") {
  Add-Result -Step "8. Voice reply" -Status PASS -Detail "Real TTS audio produced"
} elseif ($r.Success) {
  Add-Result -Step "8. Voice reply" -Status FAIL -Category "configuration" -Detail "Ran, but no audio file was produced - check PIPER_BINARY_PATH in .env"
} else {
  Add-Result -Step "8. Voice reply" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail (($r.Output -split "`n" | Select-Object -Last 5) -join " ")
}

# ============================================================
# Step 9: Vision path
# ============================================================
Write-Log "`n--- Step 9: Vision (Phase 3) ---"
if (-not $VisionTestImage) {
  $candidates = @(
    (Join-Path $RepoPath "test-assets"),
    (Join-Path $env:USERPROFILE "Pictures")
  ) | Where-Object { Test-Path $_ }
  foreach ($dir in $candidates) {
    $found = Get-ChildItem -Path $dir -Include *.png, *.jpg, *.jpeg -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $VisionTestImage = $found.FullName; break }
  }
}
if (-not $VisionTestImage) {
  Add-Result -Step "9. Vision (vision-test)" -Status SKIP -Detail "No test image found or given. Re-run with -VisionTestImage <path>, or: bun run dev vision-test <path-to-image>"
} else {
  Write-Log "Using test image: $VisionTestImage"
  $r = Invoke-JarvisCommand -CommandArgs "vision-test `"$VisionTestImage`"" -TimeoutSec 300
  Write-FullOutput -Label "9.vision-test" -Result $r
  if ($r.Success -and $r.Output -match "Description:") {
    Add-Result -Step "9. Vision (vision-test)" -Status PASS -Detail "Real description returned"
  } else {
    Add-Result -Step "9. Vision (vision-test)" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail (($r.Output -split "`n" | Select-Object -Last 5) -join " ")
  }
}

# ============================================================
# Step 10: Windows computer control
# ============================================================
Write-Log "`n--- Step 10: Windows computer control (Phase 3) ---"
$r = Invoke-JarvisCommand -CommandArgs "control-test" -TimeoutSec 60
Write-FullOutput -Label "10.control-test" -Result $r
if ($r.Success -and $r.Output -match "CONTROL PRIMITIVES VERIFIED") {
  Add-Result -Step "10. Windows computer control" -Status PASS -Detail "open/wait/type/key/close all confirmed"
} else {
  Add-Result -Step "10. Windows computer control" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail (($r.Output -split "`n" | Select-Object -Last 5) -join " ")
}

# ============================================================
# Step 11: Provider fallback behavior
# ============================================================
Write-Log "`n--- Step 11: Provider fallback ---"
if (-not $TestFallback) {
  Add-Result -Step "11. Provider fallback" -Status SKIP -Detail "Not run by default (would stop OmniRoute mid-test). Re-run with -TestFallback to actually exercise this."
} elseif (-not $omniUp) {
  Add-Result -Step "11. Provider fallback" -Status SKIP -Detail "OmniRoute isn't up to begin with - nothing to fail over from."
} else {
  Write-Log "Stopping OmniRoute to force fallback to Ollama..."
  Get-Process | Where-Object { $_.ProcessName -match "omniroute|node" -and $_.MainWindowTitle -match "omniroute" } | Stop-Process -Force -ErrorAction SilentlyContinue
  # Best-effort: also try killing whatever is listening on 20128.
  try {
    $conns = Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
  Start-Sleep -Seconds 3

  $r = Invoke-JarvisCommand -CommandArgs 'conversation "Fallback test - respond with anything."' -TimeoutSec 120
  Write-FullOutput -Label "11.fallback" -Result $r
  if ($r.Success -and $r.Output -match "JARVIS:" -and $r.Output -notmatch "couldn.t reach any model provider") {
    Add-Result -Step "11. Provider fallback" -Status PASS -Detail "Got a real reply with OmniRoute down - fell back correctly"
  } else {
    Add-Result -Step "11. Provider fallback" -Status FAIL -Category (Get-FailureCategory $r.Output) -Detail "Did not get a real reply with OmniRoute down"
  }

  Write-Log "Restarting OmniRoute..."
  $pidFile = Join-Path $env:USERPROFILE ".omniroute\server\.pid"
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  $omniCmd = Get-Command omniroute -ErrorAction SilentlyContinue
  if ($omniCmd) {
    $cmdPath = $omniCmd.Source
    if ($cmdPath -like "*.ps1") {
      $sibling = [System.IO.Path]::ChangeExtension($cmdPath, ".cmd")
      if (Test-Path $sibling) { $cmdPath = $sibling }
    }
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$cmdPath`"" -WindowStyle Hidden
    Write-Log "OmniRoute restart triggered - give it ~70s before relying on it again."
  }
}

# ============================================================
# Summary
# ============================================================
Write-Log "`n=========================================="
Write-Log "SUMMARY"
Write-Log "=========================================="
$pass = ($results | Where-Object { $_.Status -eq "PASS" }).Count
$fail = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
$skip = ($results | Where-Object { $_.Status -eq "SKIP" }).Count
Write-Log "PASS: $pass   FAIL: $fail   SKIP: $skip"
Write-Log ""
$results | ForEach-Object {
  $marker = switch ($_.Status) { "PASS" { "[OK]" }; "FAIL" { "[FAIL]" }; "SKIP" { "[SKIP]" } }
  Write-Log "$marker $($_.Step) $(if ($_.Category) { "[$($_.Category)]" })"
  if ($_.Detail) { Write-Log "     $($_.Detail)" }
}
Write-Log "`nFull log: $logFile"

if ($fail -gt 0) {
  Write-Log "`n$fail failure(s) - see categories above. configuration/authentication issues are usually a .env fix; provider-availability/latency issues usually mean start the service and retry; application-code/windows-integration failures are the ones worth sending back to Jarvis's dev chat with this log attached."
}
