<#
  register-maintenance-tasks.ps1
  ------------------------------------------------------------------
  Registers the OS-level (free, built-in Windows Task Scheduler) jobs that run
  Pandoro's Box DB maintenance even when the Ops server / worker is not running.
  Each task simply invokes the tiered CLI:

      node server/db-maintenance.js cron nightly | weekly | monthly

  The SAME tiers also run in-process via the scheduler when `npm run ops` is up
  (with OPS_SCHEDULER=1). These schtasks are the belt-and-braces layer so the DB
  is still checked, backed up, and healed on a laptop that isn't always serving.

  Everything is free: SQLite PRAGMAs + better-sqlite3 online backup + schtasks.
  No paid services, no network required.

  USAGE (from the repo root, in PowerShell):
      pwsh ./scripts/register-maintenance-tasks.ps1            # register/refresh
      pwsh ./scripts/register-maintenance-tasks.ps1 -Remove    # unregister
      pwsh ./scripts/register-maintenance-tasks.ps1 -WhatIf    # preview only

  Notes:
   - Runs under the CURRENT user, only when logged on (no stored password, no
     elevation). That's deliberate — it keeps this a zero-privilege, zero-secret
     setup. Change -RunLevel / -LogonType below if you want it to run unattended.
   - Times are local. Nightly 03:15, Weekly Sun 03:40, Monthly 1st 04:10 — spaced
     so they never start on top of each other.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

# --- Locate node + the repo root (this script lives in <repo>/scripts) ---------
$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodeCmd  = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $NodeCmd) { throw "node was not found on PATH. Install Node.js or add it to PATH, then re-run." }
$NodeExe  = $NodeCmd.Source
$Script   = Join-Path $RepoRoot "server\db-maintenance.js"
if (-not (Test-Path $Script)) { throw "Cannot find $Script — run this from inside the rate-my-rep repo." }

# --- The three tiers: task name, tier arg, and trigger -------------------------
$Prefix = "PandorosBox-DBMaintenance"
$Tasks = @(
  @{ Tier = "nightly"; Name = "$Prefix-Nightly"; Trigger = (New-ScheduledTaskTrigger -Daily -At 3:15am) },
  @{ Tier = "weekly";  Name = "$Prefix-Weekly";  Trigger = (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3:40am) },
  @{ Tier = "monthly"; Name = "$Prefix-Monthly"; Trigger = (New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At 4:10am) }
)

if ($Remove) {
  foreach ($t in $Tasks) {
    if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
      if ($PSCmdlet.ShouldProcess($t.Name, "Unregister scheduled task")) {
        Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
        Write-Host "removed $($t.Name)"
      }
    } else {
      Write-Host "not present: $($t.Name)"
    }
  }
  return
}

# Run as the current user, only while logged on. No stored password, no elevation.
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
              -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

foreach ($t in $Tasks) {
  # -WorkingDirectory pins the cwd so relative paths (data/, server/) resolve.
  $Action = New-ScheduledTaskAction -Execute $NodeExe `
              -Argument "server\db-maintenance.js cron $($t.Tier)" `
              -WorkingDirectory $RepoRoot
  if ($PSCmdlet.ShouldProcess($t.Name, "Register scheduled task ($($t.Tier))")) {
    Register-ScheduledTask -TaskName $t.Name -Action $Action -Trigger $t.Trigger `
      -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Host "registered $($t.Name)  ->  `"$NodeExe`" server\db-maintenance.js cron $($t.Tier)  (cwd: $RepoRoot)"
  }
}

Write-Host ""
Write-Host "Done. Inspect with:  Get-ScheduledTask -TaskName '$Prefix-*'"
Write-Host "Run one now with:     Start-ScheduledTask -TaskName '$Prefix-Nightly'"
Write-Host "Remove all with:      pwsh ./scripts/register-maintenance-tasks.ps1 -Remove"
