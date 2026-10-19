# Off-VPS copy of the daily backups (M11): pulls db-*.sql.gz / uploads-*.tar.gz that are not here yet,
# verifies size, keeps KeepDays days. Runs on Bảo's laptop from Task Scheduler ("CityLight backup pull",
# daily 08:30 + at logon, catches up when the laptop was off). Log: <Dest>\pull.log
#   powershell -NoProfile -ExecutionPolicy Bypass -File infra\scripts\pull-backups.ps1
param(
  [string]$Dest = 'D:\CityLightBackups\vps',
  [string]$HostName = 'ubuntu@13.55.91.187',
  [string]$Key = "$env:USERPROFILE\.ssh\citylight_aws",
  [string]$RemoteDir = '/opt/citylight/backups',
  [int]$KeepDays = 60
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dest | Out-Null
$log = Join-Path $Dest 'pull.log'
function Log($m) { "$(Get-Date -Format s) $m" | Tee-Object -FilePath $log -Append }

try {
  # name<TAB>size for every backup file on the VPS
  $remote = & ssh -i $Key -o BatchMode=yes -o ConnectTimeout=20 $HostName "cd $RemoteDir && stat -c '%n`t%s' db-*.sql.gz uploads-*.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "ssh list failed ($LASTEXITCODE)" }
  $got = 0
  foreach ($line in $remote) {
    $name, $size = $line -split "`t"
    $local = Join-Path $Dest $name
    if ((Test-Path $local) -and (Get-Item $local).Length -eq [long]$size) { continue }
    & scp -i $Key -o BatchMode=yes -q "${HostName}:$RemoteDir/$name" "$local.part"
    if ($LASTEXITCODE -ne 0) { throw "scp $name failed ($LASTEXITCODE)" }
    if ((Get-Item "$local.part").Length -ne [long]$size) { throw "size mismatch $name" }
    Move-Item -Force "$local.part" $local
    $got++
  }
  $old = Get-ChildItem $Dest -File | Where-Object { $_.Name -match '^(db|uploads)-' -and $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
  $old | Remove-Item
  $newest = Get-ChildItem $Dest -Filter 'db-*.sql.gz' | Sort-Object Name | Select-Object -Last 1
  Log "ok: $got new, $($old.Count) pruned, newest $($newest.Name)"
} catch {
  Log "FAIL: $_"
  exit 1
}
