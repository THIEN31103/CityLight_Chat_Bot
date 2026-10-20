# Monthly check of the encrypted off-VPS backup (A7, S46): decrypts the newest db-*.sql.gz.age with the private key
# and reads the whole dump in memory (age -> gunzip -> line count), so no plain data is written to disk.
# OK = decrypted, gzip complete, pg_dump's end marker present; prints the number of tables with data.
#   powershell -NoProfile -ExecutionPolicy Bypass -File infra\scripts\verify-backup.ps1 -Identity E:\citylight-backup-key.txt
# -Identity: the private key file (age-keygen output, or a passphrase-protected key: age asks for the passphrase).
param(
  [Parameter(Mandatory = $true)][string]$Identity,
  [string]$Dest = 'D:\CityLightBackups\vps',
  [string]$File,
  [string]$Age = 'age'
)
$ErrorActionPreference = 'Stop'
if (-not $File) { $File = (Get-ChildItem $Dest -Filter 'db-*.sql.gz.age' | Sort-Object Name | Select-Object -Last 1).FullName }
if (-not $File) { Write-Host "FAIL: no db-*.sql.gz.age in $Dest"; exit 1 }
$ageExe = (Get-Command $Age -ErrorAction SilentlyContinue).Source
if (-not $ageExe) { Write-Host "FAIL: age.exe not found (install it, or pass -Age <path to age.exe>)"; exit 1 }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ageExe
$psi.Arguments = "-d -i `"$Identity`" `"$File`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true # stderr stays on the console: passphrase prompt and age errors
$p = [System.Diagnostics.Process]::Start($psi)
$lines = 0; $copies = 0; $complete = $false
try {
  $gz = New-Object System.IO.Compression.GZipStream($p.StandardOutput.BaseStream, [System.IO.Compression.CompressionMode]::Decompress)
  $rd = New-Object System.IO.StreamReader($gz, [System.Text.Encoding]::UTF8)
  while ($null -ne ($l = $rd.ReadLine())) {
    $lines++
    if ($l.StartsWith('COPY ')) { $copies++ }
    if ($l -eq '-- PostgreSQL database dump complete') { $complete = $true }
  }
} catch {
  Write-Host "FAIL: $(Split-Path $File -Leaf): $($_.Exception.Message)"
  exit 1
} finally {
  $p.WaitForExit()
}
if ($p.ExitCode -ne 0) { Write-Host "FAIL: age exit $($p.ExitCode) (wrong key or damaged file)"; exit 1 }
if (-not $complete) { Write-Host "FAIL: $(Split-Path $File -Leaf) decrypted but the dump is incomplete ($lines lines)"; exit 1 }
Write-Host "OK: $(Split-Path $File -Leaf) decrypted, $lines lines, $copies tables with data, dump complete"
