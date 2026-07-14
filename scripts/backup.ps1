Set-Location (Join-Path $PSScriptRoot "..")
node server/db-maintenance.js backup
if ($LASTEXITCODE -ne 0) { exit 1 }
Get-ChildItem data/backups -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force -Confirm:$false
exit 0
