<#
  setup-jarvis.ps1
  One-shot, idempotent setup + verification for the JARVIS project.
  Safe to re-run: every step skips cleanly if already done.

  Run it by right-clicking this file -> "Run with PowerShell",
  or from a PowerShell prompt: .\setup-jarvis.ps1

  Everything printed also gets written to a timestamped log file in
  .\setup-logs\ so it can be reviewed later without watching it run live.
#>

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
Set-Location $root

# bun/psql write UTF-8 to stdout (including the emoji in JARVIS's own
# console.log calls). Windows PowerShell 5.1 decodes captured child-process
# output using [Console]::OutputEncoding, which defaults to the system's
# legacy codepage, not UTF-8 - without this, that output comes through as
# mojibake (seen live in setup-2026-08-27_18-20-27.log: "=???" etc. in
# place of emoji). This makes PowerShell decode it correctly instead.
# Wrapped in try/catch since setting console encoding can throw in a
# non-interactive host (e.g. no real console attached) - never worth
# failing the whole script over a cosmetic fix.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Non-fatal - worst case the console/log still shows mojibake for emoji,
    # exactly as before this fix, everything else still works.
}

$logDir = Join-Path $root "setup-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $logDir "setup-$stamp.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Write-Host $line
    # -Encoding UTF8 matters here for the same reason as above: Add-Content's
    # default encoding in Windows PowerShell 5.1 is NOT UTF-8, so without
    # this the log file would re-corrupt already-correct text on the way to
    # disk even after the console-decoding fix above.
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Section($title) {
    Log ""
    Log "==================================================="
    Log $title
    Log "==================================================="
}

$failures = @()

Section "STEP 0: Locate tools"

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Log "ERROR: 'bun' not found on PATH. Install it from https://bun.sh and re-run this script."
    $failures += "bun not installed"
} else {
    Log "bun found: $($bun.Source)"
    Log (bun --version | Out-String)
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
    # Common install location when the installer didn't add it to PATH
    $candidates = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue
    if ($candidates) {
        $psqlPath = $candidates[-1].FullName
        Log "psql not on PATH, found at $psqlPath instead"
        Set-Alias -Name psql -Value $psqlPath -Scope Script
    } else {
        Log "ERROR: PostgreSQL (psql) not found. Install PostgreSQL 16+ from https://www.postgresql.org/download/windows/ and re-run this script."
        $failures += "postgresql not installed"
    }
} else {
    Log "psql found: $($psql.Source)"
}

if ($failures.Count -gt 0) {
    Section "STOPPED - missing prerequisites"
    $failures | ForEach-Object { Log " - $_" }
    Log "Fix the above, then re-run this script. Full log: $logFile"
    exit 1
}

Section "STEP 1: Ensure PostgreSQL service is running"

$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pgService) {
    if ($pgService.Status -ne "Running") {
        Log "Starting service $($pgService.Name)..."
        try {
            Start-Service $pgService.Name
            Start-Sleep -Seconds 3
            Log "Service status: $((Get-Service $pgService.Name).Status)"
        } catch {
            Log "WARNING: couldn't start PostgreSQL service automatically: $_"
            Log "You may need to start it yourself (services.msc) or run this script as Administrator."
        }
    } else {
        Log "PostgreSQL service '$($pgService.Name)' is already running."
    }
} else {
    Log "WARNING: no Windows service matching 'postgresql*' found. If Postgres runs a different way on this machine, ignore this."
}

Section "STEP 2: Ensure the 'jarvis' role and database exist"

# Reads DATABASE_URL out of .env so this stays correct if it's ever changed,
# instead of hardcoding the current jarvis/jarvis/jarvis values.
$envFile = Join-Path $root ".env"
$dbUser = "jarvis"; $dbPass = "jarvis"; $dbName = "jarvis"
if (Test-Path $envFile) {
    $line = (Get-Content $envFile | Where-Object { $_ -match "^DATABASE_URL=" })
    if ($line -match "postgresql://([^:]+):([^@]+)@[^/]+/(\S+)") {
        $dbUser = $matches[1]; $dbPass = $matches[2]; $dbName = $matches[3]
    }
}
Log "Target role: $dbUser / database: $dbName"

# NOTE: these connect as the 'postgres' superuser, so PowerShell will prompt
# for the Postgres superuser password the first time (not the jarvis
# password above). Once the role/db exist, later re-runs skip straight past
# this with no prompt at all.
$roleCheck = & psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$dbUser'" 2>&1
if ($roleCheck -match "1") {
    Log "Role '$dbUser' already exists - skipping."
} else {
    Log "Creating role '$dbUser'..."
    & psql -U postgres -c "CREATE ROLE $dbUser WITH LOGIN PASSWORD '$dbPass';" 2>&1 | ForEach-Object { Log $_ }
}

$dbCheck = & psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$dbName'" 2>&1
if ($dbCheck -match "1") {
    Log "Database '$dbName' already exists - skipping."
} else {
    Log "Creating database '$dbName'..."
    & psql -U postgres -c "CREATE DATABASE $dbName OWNER $dbUser;" 2>&1 | ForEach-Object { Log $_ }
}

Section "STEP 3: Ensure OmniRoute is running"

$omniPort = if ($env:OMNIROUTE_PORT) { $env:OMNIROUTE_PORT } else { 20128 }
$omniKey = ""
if (Test-Path $envFile) {
    $keyLine = (Get-Content $envFile | Where-Object { $_ -match "^OMNIROUTE_API_KEY=" })
    if ($keyLine -match "^OMNIROUTE_API_KEY=(.+)$") { $omniKey = $matches[1].Trim('"') }
}

function Test-OmniRoute {
    try {
        $headers = @{}
        if ($omniKey) { $headers["Authorization"] = "Bearer $omniKey" }
        $resp = Invoke-WebRequest -Uri "http://localhost:$omniPort/v1/models" -Headers $headers -TimeoutSec 3 -ErrorAction Stop
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-OmniRoute) {
    Log "OmniRoute already running on port $omniPort."
} else {
    $omniCmd = Get-Command omniroute -ErrorAction SilentlyContinue
    if (-not $omniCmd) {
        Log "WARNING: 'omniroute' command not found on PATH. Start it yourself, or tell me how you normally launch it so I can fix this script."
        $failures += "omniroute command not found"
    } else {
        # npm's global shims come in three flavors (omniroute, omniroute.cmd,
        # omniroute.ps1). Get-Command can resolve to the .ps1 one, which
        # Start-Process can't launch directly ("%1 is not a valid Win32
        # application"). Even the .cmd shim is unreliable launched directly
        # via Start-Process, because redirecting stdout/stderr forces
        # UseShellExecute=false, and CreateProcess doesn't know how to run a
        # .cmd on its own - it needs cmd.exe to interpret it. So always
        # route through "cmd.exe /c" explicitly, which works either way.
        $cmdSibling = [System.IO.Path]::ChangeExtension($omniCmd.Source, ".cmd")
        if (-not (Test-Path $cmdSibling)) { $cmdSibling = $omniCmd.Source }
        $launchFile = "cmd.exe"
        $launchArgs = @("/c", "`"$cmdSibling`"")

        # OmniRoute writes its own PID file at server\.pid and (per its logs)
        # appears to refuse a second instance while that file exists - even
        # after the process that wrote it already exited (e.g. the terminal
        # it was running in got closed, which shows up in its app.log as a
        # clean "Received SIGHUP" shutdown, but the .pid file is never
        # cleaned up after that). Clear the stale lock before starting;
        # harmless if OmniRoute is actually not running, since the port
        # check above already would have short-circuited this whole block.
        $pidFile = Join-Path $env:USERPROFILE ".omniroute\server\.pid"
        if (Test-Path $pidFile) {
            Log "Removing stale OmniRoute lock file: $pidFile"
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        }

        Log "Starting OmniRoute ($launchFile $($launchArgs -join ' '))..."
        $omniOut = Join-Path $logDir "omniroute-out-$stamp.log"
        $omniErr = Join-Path $logDir "omniroute-err-$stamp.log"
        Start-Process -FilePath $launchFile -ArgumentList $launchArgs -WindowStyle Hidden -RedirectStandardOutput $omniOut -RedirectStandardError $omniErr
        # Last run: OmniRoute's own log showed a real ~70s cold boot
        # (companion listeners didn't come up until t+68s) - comfortably
        # longer than the old 30s budget. Give it up to 2 minutes.
        $tries = 0
        $up = $false
        while (-not $up -and $tries -lt 40) {
            Start-Sleep -Seconds 3
            $up = Test-OmniRoute
            $tries++
        }
        if ($up) {
            Log "OmniRoute is up (took ~$($tries * 3)s). Runs in the background - safe to close this window afterward."
        } else {
            Log "WARNING: OmniRoute still not responding on port $omniPort after ~$($tries * 3)s."
            Log "Our own redirect logs: $omniOut / $omniErr"
            # Our redirect files have come back empty before even when
            # something happened, so also surface OmniRoute's own real log
            # (it logs to this file itself, regardless of how it was
            # launched) - this is the log that actually shows what happened.
            $realLog = Join-Path $env:USERPROFILE ".omniroute\logs\application\app.log"
            if (Test-Path $realLog) {
                Log "Last 15 lines of OmniRoute's own log ($realLog):"
                Get-Content $realLog -Tail 15 | ForEach-Object { Log "    $_" }
            }
            # Find out what port the process is actually listening on,
            # instead of just guessing 20128 is wrong - this settles it.
            if (Test-Path $pidFile) {
                $realPid = (Get-Content $pidFile -Raw).Trim()
                $conns = Get-NetTCPConnection -State Listen -OwningProcess $realPid -ErrorAction SilentlyContinue
                if ($conns) {
                    Log "Process $realPid is listening on port(s): $(($conns.LocalPort | Sort-Object -Unique) -join ', ')"
                } else {
                    Log "Process $realPid isn't listening on anything yet (or already exited) - likely still mid-startup, or it crashed."
                }
            }
            $failures += "omniroute did not come up in time"
        }
    }
}

Section "STEP 4: bun install"
bun install 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { $failures += "bun install failed (exit $LASTEXITCODE)" }

Section "STEP 5: bun run typecheck"
bun run typecheck 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { $failures += "typecheck failed (exit $LASTEXITCODE)" }

Section "STEP 6: bun run db:push"
bun run db:push 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { $failures += "db:push failed (exit $LASTEXITCODE)" }

Section "STEP 7: bun run dev  (Phase 0 vertical-slice test)"
bun run dev 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { $failures += "bun run dev failed (exit $LASTEXITCODE)" }

Section "DONE"
if ($failures.Count -eq 0) {
    Log "All steps completed with no errors. Full log: $logFile"
} else {
    Log "Completed with $($failures.Count) problem(s):"
    $failures | ForEach-Object { Log " - $_" }
    Log "Full log: $logFile"
}
