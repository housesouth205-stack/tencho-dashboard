# 月計画表の自動取込を1回動かす（タスクスケジューラが毎朝9:00に呼ぶ）。
# パスワードは setup.ps1 がこのPC・このユーザーでしか戻せない形（Windowsの暗号化）で保存している。
# 平文のパスワードはファイルに置かず、動かす間だけ環境変数で node に渡す。
param([switch]$Force)
$ErrorActionPreference = "Stop"
# node はUTF-8で書くので、PowerShell側もUTF-8で受ける（既定のShift_JISだと「失敗:」が文字化けした）
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$home2 = Join-Path $env:LOCALAPPDATA "TenchoPlanAuto"
$cfg = Get-Content (Join-Path $home2 "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$logFile = Join-Path $home2 "log.txt"

$sec = Get-Content (Join-Path $home2 "cred.txt") | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:TENCHO_PW = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $argsList = @((Join-Path $home2 "app\tools\plan-auto\run.mjs"), "--file", $cfg.file)
  if ($Force) { $argsList += "--force" }
  $out = & $cfg.node @argsList 2>&1 | Out-String
  $code = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:TENCHO_PW -ErrorAction SilentlyContinue
}
# 記録は直近500行だけ残す（毎日1〜2行なので1年以上ぶん）
$lines = @()
if (Test-Path $logFile) { $lines = Get-Content $logFile -Encoding UTF8 }
$lines += ($out.TrimEnd() -split "`r?`n")
$lines | Select-Object -Last 500 | Set-Content $logFile -Encoding UTF8
Write-Output $out
exit $code
