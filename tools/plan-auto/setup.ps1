# 月計画表の自動取込（PC版）の準備。最初に1回だけ、店長が自分で実行する。
#   powershell -ExecutionPolicy Bypass -File tools\plan-auto\setup.ps1
# やること：
#   1. 取込に使うプログラムを %LOCALAPPDATA%\TenchoPlanAuto\app に写す
#      （作業中のフォルダを直接動かすと、作業の途中の状態で毎朝動いてしまうため）
#   2. ダッシュボードのログインパスワードを聞いて、このPC・このユーザーでしか戻せない形で保存する
#   3. いちど本当に取り込んでみて結果を見せる
#   4. 毎朝9:00に動く予約をWindowsに入れる（PCが切れていたら次に起動したときに動く）
# プログラムを直したあとは、もう一度このスクリプトを実行すれば写し直される（パスワードは聞き直さない）。
param(
  [string]$File = "\\DESKTOP-V6MF90E\Desktop\2026年月計画表.xlsx",
  [string]$Time = "09:00",
  [switch]$ResetPassword
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$home2 = Join-Path $env:LOCALAPPDATA "TenchoPlanAuto"
$app = Join-Path $home2 "app"
New-Item -ItemType Directory -Force $app | Out-Null

Write-Host "1/4 プログラムを写しています…"
$files = @(
  "tools\plan-auto\run.mjs", "tools\plan-auto\run.ps1",
  "src\lib\xlsx.full.min.js", "src\core\config.js", "src\util\dates.js", "src\util\sheetjs.js",
  "src\import\monthlyPlanXlsx.js", "src\import\monthlyPlanRecords.js"
)
foreach ($f in $files) {
  $to = Join-Path $app $f
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Copy-Item (Join-Path $repo $f) $to -Force
}
Copy-Item (Join-Path $repo "tools\plan-auto\run.ps1") (Join-Path $home2 "run.ps1") -Force

$node = (Get-Command node -ErrorAction Stop).Source
@{ file = $File; node = $node } | ConvertTo-Json | Set-Content (Join-Path $home2 "config.json") -Encoding UTF8
if (-not (Test-Path -LiteralPath $File)) { Write-Warning "月計画表が見つかりません: $File （共有フォルダに繋がっているか確認してください）" }

$cred = Join-Path $home2 "cred.txt"
if ($ResetPassword -or -not (Test-Path $cred)) {
  Write-Host "2/4 ダッシュボードにログインするときのパスワードを入れてください（画面には出ません）"
  Read-Host "パスワード" -AsSecureString | ConvertFrom-SecureString | Set-Content $cred
} else {
  Write-Host "2/4 パスワードは保存済みです（入れ直すときは -ResetPassword を付けて実行）"
}

Write-Host "3/4 いちど取り込んでみます…"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $home2 "run.ps1") -Force
if ($LASTEXITCODE -ne 0) {
  Write-Warning "取込に失敗しました。上の「失敗:」の文を確認してください（パスワード違いなら -ResetPassword を付けて実行し直す）"
  exit 1
}

Write-Host "4/4 毎朝 $Time に動く予約を入れます…"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $home2 'run.ps1')`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
# PCが切れていて9:00を逃したら、次に起動したときに動かす。ノートPCの電池でも止めない
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "TenchoPlanAuto" -Action $action -Trigger $trigger -Settings $settings `
  -Description "店長ダッシュボード：月計画表を毎朝取り込む（tools/plan-auto）" -Force | Out-Null
Write-Host "完了：毎朝 $Time に $File を取り込みます。結果は予実タブの上の行と $home2\log.txt で見られます。"
