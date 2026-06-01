<#
.SYNOPSIS
  同步记忆仓库：拉取最新，归档本机会话，提交并推送。
.PARAMETER PullOnly
  只拉取，不归档/提交/推送（用于 SessionStart hook，开工前取最新）。
.EXAMPLE
  powershell -NoProfile -File scripts\sync.ps1            # 全量同步（手动或 SessionEnd）
  powershell -NoProfile -File scripts\sync.ps1 -PullOnly  # 仅拉取（SessionStart）
#>
param([switch]$PullOnly)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Push-Location $Repo
try {
  git pull --rebase --autostash
  if (-not $PullOnly) {
    & (Join-Path $PSScriptRoot 'archive-sessions.ps1') -Repo $Repo
    git add -A
    $changes = git status --porcelain
    if ($changes) {
      $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
      git commit -m "sync(windows): $stamp"
      git push
    }
  }
} finally {
  Pop-Location
}
