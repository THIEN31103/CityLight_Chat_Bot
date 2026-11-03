# Off-VPS copy of the daily backups (M11): pulls the backup files that are not here yet, verifies size, keeps
# KeepDays days. Runs on Bảo's laptop from Task Scheduler ("CityLight backup pull", daily 08:30 + at logon, catches
# up when the laptop was off). Log: <Dest>\pull.log
# Encrypted only (A7, S46): pulls the age copies db-*.sql.gz.age / uploads-*.tar.gz.age. Until the VPS makes them
# (no infra/backup-recipients.txt there yet) it falls back to the plain files and logs "WARN plain". Check a copy
# can be decrypted with verify-backup.ps1 (needs the private key).
# S61: also the trial stack's backups (TrialRemoteDir -> TrialDest); a VPS without a trial stack logs "no files".
#   powershell -NoProfile -ExecutionPolicy Bypass -File infra\scripts\pull-backups.ps1
param(
  [string]$Dest = 'D:\CityLightBackups\vps',
  [string]$HostName = 'ubuntu@13.55.91.187',
  [string]$Key = "$env:USERPROFILE\.ssh\citylight_aws",
  [string]$RemoteDir = '/opt/citylight/backups',
  [string]$TrialDest = 'D:\CityLightBackups\vps-trial',
  [string]$TrialRemoteDir = '/opt/citylight/backups-trial',
  [int]$KeepDays = 60
)
$ErrorActionPreference = 'Stop'

# name<TAB>size of the VPS files matching the patterns (none -> empty)
function RemoteList([string]$dir, [string]$patterns) {
  # no double quotes inside: Windows PowerShell 5.1 mangles them for native commands (backup names have no spaces)
  $out = & ssh -i $Key -o BatchMode=yes -o ConnectTimeout=20 $HostName "cd $dir 2>/dev/null && for f in $patterns; do [ -f `$f ] && stat -c '%n`t%s' `$f; done; true"
  if ($LASTEXITCODE -ne 0) { throw "ssh list failed ($LASTEXITCODE)" }
  @($out | Where-Object { $_ })
}

function Pull([string]$dir, [string]$to) {
  New-Item -ItemType Directory -Force $to | Out-Null
  $log = Join-Path $to 'pull.log'
  function Log($m) { "$(Get-Date -Format s) $m" | Tee-Object -FilePath $log -Append }
  try {
    $remote = RemoteList $dir 'db-*.sql.gz.age uploads-*.tar.gz.age'
    $mode = 'encrypted'
    if (-not $remote.Count) {
      $remote = RemoteList $dir 'db-*.sql.gz uploads-*.tar.gz'
      $mode = 'WARN plain (VPS has no .age backups yet: set up infra/backup-recipients.txt, runbook 4)'
    }
    $got = 0
    foreach ($line in $remote) {
      $name, $size = $line -split "`t"
      $local = Join-Path $to $name
      if ((Test-Path $local) -and (Get-Item $local).Length -eq [long]$size) { continue }
      & scp -i $Key -o BatchMode=yes -q "${HostName}:$dir/$name" "$local.part"
      if ($LASTEXITCODE -ne 0) { throw "scp $name failed ($LASTEXITCODE)" }
      if ((Get-Item "$local.part").Length -ne [long]$size) { throw "size mismatch $name" }
      Move-Item -Force "$local.part" $local
      $got++
    }
    $old = Get-ChildItem $to -File | Where-Object { $_.Name -match '^(db|uploads)-' -and $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
    $old | Remove-Item
    $newest = Get-ChildItem $to -File | Where-Object { $_.Name -like 'db-*.sql.gz*' } | Sort-Object Name | Select-Object -Last 1
    Log "ok ($mode): $got new, $($old.Count) pruned, newest $($newest.Name)"
    return $true
  } catch {
    Log "FAIL: $_"
    return $false
  }
}

$ok = Pull $RemoteDir $Dest
$okTrial = Pull $TrialRemoteDir $TrialDest
if (-not ($ok -and $okTrial)) { exit 1 }
