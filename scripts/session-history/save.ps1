<#
.SYNOPSIS
  把会话存进项目的 session-history/。手动命令（由 /session-memory save 调用）。
.DESCRIPTION
  -Current（默认）：只存【当前会话】（cwd 对应项目里最新的那条）。
  -All           ：扫本机所有端的会话（Claude CLI/Desktop + Codex）入各自项目。
  -Commit        ：写完后把该项目的 session-history/ 单独 commit（仅 -Current 有意义）。
.PARAMETER Cwd   覆盖工作目录（默认当前目录）
#>
param([switch]$Current, [switch]$All, [switch]$Commit, [string]$Cwd)
$ErrorActionPreference = 'Stop'
$cap = Join-Path $PSScriptRoot 'capture'
. (Join-Path $cap '_lib.ps1')
if (-not $Cwd) { $Cwd = (Get-Location).Path }
$ps = "powershell -NoProfile -ExecutionPolicy Bypass -File"

if ($All) {
  Write-Output "save -All：扫描所有端…"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cap 'claude-scrape.ps1') -All
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cap 'codex-scrape.ps1') -All
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cap 'desktop-scrape.ps1') -All
  Write-Output "save -All 完成。"
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cap 'claude-scrape.ps1') -Current -Cwd $Cwd
  if ($Commit) {
    $g = Get-GitInfo $Cwd
    if ($g.main_root) {
      $ok = Invoke-SessionHistoryCommit $g.main_root "chore(session-history): save current session"
      Write-Output $(if ($ok) { "已提交 session-history。" } else { "无改动可提交。" })
    }
  }
}
