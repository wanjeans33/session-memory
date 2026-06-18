<#
.SYNOPSIS
  同步【记忆仓库】：拉取最新，提交本机对 memory/ 与 CLAUDE.md 的改动并推送。
  （会话历史不在这里——见 scripts/session-history/，按项目落地。）
.PARAMETER PullOnly
  只拉取，不提交/推送（用于 SessionStart hook，开工前取最新）。
.EXAMPLE
  powershell -NoProfile -File scripts\memory-sync\sync.ps1            # 全量同步（手动或 SessionEnd）
  powershell -NoProfile -File scripts\memory-sync\sync.ps1 -PullOnly  # 仅拉取（SessionStart）
#>
param([switch]$PullOnly)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $Repo
try {
  git pull --rebase --autostash
  if (-not $PullOnly) {
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
