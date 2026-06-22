<#
.SYNOPSIS
  把 Claude Code 会话（CLI / Desktop 共用 ~/.claude/projects/<encoded>/<id>.jsonl）抽成
  digest + 脱敏原文，写进对应项目的 session-history/。手动调用，无 hook。
.DESCRIPTION
  模式（互斥，默认 -Current）：
    -Current            采集【当前会话】= cwd 对应 projects 目录里 mtime 最新的 *.jsonl
    -All                扫 ~/.claude/projects/**/*.jsonl 全部会话（按 digest 文件名幂等去重）
    -TranscriptPath X   指定单个 jsonl
  设计见 DESIGN.md。由 save.ps1 调用，也可单独跑。
.PARAMETER Cwd          覆盖 -Current 的工作目录（默认当前目录）
.PARAMETER ProjectsDir  覆盖 ~/.claude/projects（测试用）
#>
param([switch]$Current, [switch]$All, [string]$TranscriptPath, [string]$Cwd, [string]$ProjectsDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')
if (-not $ProjectsDir) { $ProjectsDir = Join-Path $env:USERPROFILE '.claude\projects' }

function Save-OneTranscript([string]$tp) {
  if (-not (Test-Path -LiteralPath $tp)) { return $null }
  $lines = [System.IO.File]::ReadAllLines($tp, [System.Text.Encoding]::UTF8)
  if (-not $lines) { return $null }
  $p = Get-ClaudeTranscriptInfo $lines
  $id = $p.id
  if (-not $id) { $id = [System.IO.Path]::GetFileNameWithoutExtension($tp) }
  $cwd = $p.cwd
  $g = Get-GitInfo $cwd
  $projectRoot = if ($g.main_root) { $g.main_root } elseif ($cwd) { $cwd } else { (Split-Path -Parent $tp) }
  if ($p.branch -and $p.branch -ne 'HEAD') { $g.branch = $p.branch }
  $project = Split-Path -Leaf $projectRoot
  $rel = ConvertTo-RelFiles $p.files $projectRoot
  $fpTrunc = $null
  if ($p.first_prompt) { $r = Get-RedactedText $p.first_prompt; $fpTrunc = $r.Substring(0,[Math]::Min(200,$r.Length)) }
  $digest = [ordered]@{
    schema=1; id=$id; tool='claude-cli'; origin=$null
    machine=$env:COMPUTERNAME; os=(Get-OsName); project=$project
    cwd=(($cwd) -replace '\\','/')
    git=[ordered]@{ branch=$g.branch; is_worktree=$g.is_worktree; worktree=$g.worktree; head=$g.head; dirty=$g.dirty }
    started_at=$p.started_at; ended_at=$p.ended_at; turns=$p.turns
    first_prompt=$fpTrunc
    summary=''; files_touched=$rel; tools_used=$p.tools; next_steps=@()
    cli_version=$p.version; transcript_ref=$null
  }
  $redacted = $lines | ForEach-Object { Get-RedactedText $_ }
  return (Write-SessionDigest -Digest $digest -RedactedLines $redacted -ProjectRoot $projectRoot)
}

$targets = @()
if ($TranscriptPath) {
  $targets = @($TranscriptPath)
} elseif ($All) {
  if (Test-Path $ProjectsDir) { $targets = @(Get-ChildItem $ProjectsDir -Recurse -Filter *.jsonl -File | Where-Object { $_.FullName -notmatch '\\memory\\' } | ForEach-Object { $_.FullName }) }
} else {
  # -Current（默认）
  if (-not $Cwd) { $Cwd = (Get-Location).Path }
  $enc = Get-EncodedProject $Cwd
  $projDir = Join-Path $ProjectsDir $enc
  if (Test-Path $projDir) {
    $latest = Get-ChildItem $projDir -Filter *.jsonl -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) { $targets = @($latest.FullName) }
  }
}

$n = 0
foreach ($t in $targets) {
  try { $out = Save-OneTranscript $t; if ($out) { $n++ } } catch {}
}
Write-Output "claude-scrape: wrote $n digest(s)."
