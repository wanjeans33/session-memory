<#
.SYNOPSIS
  汇聚 session-history/digests/*.json + index.json，按分支分组，输出紧凑 JSON 到 stdout。
  供 session-share 技能低成本消费（不必逐个读 digest 文件）。
.PARAMETER Repo
  仓库内任意路径；默认当前目录。
.PARAMETER Days
  只看最近 N 天的会话（默认 0 = 全部）。
#>
param([string]$Repo, [int]$Days = 0)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = (Get-Location).Path }
$commonDir = (& git -C $Repo rev-parse --path-format=absolute --git-common-dir 2>$null | Select-Object -First 1)
if (-not $commonDir) { Write-Error "not a git repo: $Repo"; exit 1 }
$mainRoot = (Split-Path -Parent $commonDir.Trim())
$histDir = Join-Path $mainRoot 'session-history'

$indexPath = Join-Path $histDir 'index.json'
$index = $null
if (Test-Path $indexPath) { $index = Get-Content $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json }

$cutoff = $null
if ($Days -gt 0) { $cutoff = (Get-Date).ToUniversalTime().AddDays(-$Days) }

$sessions = @()
$digDir = Join-Path $histDir 'digests'
if (Test-Path $digDir) {
  foreach ($f in (Get-ChildItem $digDir -Filter *.json -File)) {
    try { $d = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    if ($cutoff -and $d.ended_at) { try { if ([datetime]::Parse($d.ended_at) -lt $cutoff) { continue } } catch {} }
    $sessions += [ordered]@{
      ended_at=$d.ended_at; tool=$d.tool; branch=$d.git.branch
      worktree=$d.git.worktree; turns=$d.turns
      first_prompt=$d.first_prompt; summary=$d.summary
      files=$d.files_touched; next_steps=$d.next_steps
    }
  }
}

# 按分支分组
$byBranch = @{}
foreach ($s in $sessions) {
  $b = if ($s.branch) { $s.branch } else { '(unknown)' }
  if (-not $byBranch.ContainsKey($b)) { $byBranch[$b] = @() }
  $byBranch[$b] += $s
}
$groups = @()
foreach ($b in $byBranch.Keys) {
  $list = @($byBranch[$b] | Sort-Object { $_.ended_at } -Descending)
  $groups += [ordered]@{ branch=$b; session_count=$list.Count; sessions=$list }
}
$groups = @($groups | Sort-Object { $_.session_count } -Descending)

$out = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  repo = (Split-Path -Leaf $mainRoot)
  total_sessions = $sessions.Count
  index = $index
  branches = $groups
}
$out | ConvertTo-Json -Depth 10
