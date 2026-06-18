<#
.SYNOPSIS
  扫描 Claude Desktop 的 Claude Code 会话（%APPDATA%\Claude\claude-code-sessions\**\local_*.json），
  转 digest + 脱敏原文，按各自 cwd 归到对应项目仓库 session-history/。
.DESCRIPTION
  Desktop 的 local_*.json 是【元数据】（cliSessionId / cwd / branch / title / completedTurns…），
  真正的对话 transcript 由内置 CLI 写在 ~/.claude/projects/<encoded>/<cliSessionId>.jsonl。
  本脚本按 cliSessionId 找到 transcript，复用 Claude 解析器，并用元数据的 title/branch 增强。
  去重：若某会话已被 CLI 的 SessionEnd hook 采过（同 id 的 claude-cli digest 存在），默认跳过。
  增量：游标 ~/.claude/.desktop-scrape-cursor（按元数据文件 mtime）。
  Desktop 无 hook，手动/定时触发。
.PARAMETER All          忽略游标全量重扫。
.PARAMETER Force        即使已有同会话的 claude-cli digest 也写。
.PARAMETER SessionsDir  覆盖默认 sessions 目录（测试用）。
.PARAMETER ProjectsDir  覆盖默认 ~/.claude/projects（测试用）。
#>
param([switch]$All, [switch]$Force, [string]$SessionsDir, [string]$ProjectsDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

if (-not $SessionsDir) { $SessionsDir = Join-Path $env:APPDATA 'Claude\claude-code-sessions' }
if (-not $ProjectsDir) { $ProjectsDir = Join-Path $env:USERPROFILE '.claude\projects' }
if (-not (Test-Path $SessionsDir)) { Write-Output "no Desktop sessions dir: $SessionsDir"; exit 0 }
$cursorFile = Join-Path $env:USERPROFILE '.claude\.desktop-scrape-cursor'
$cursor = 0L
if (-not $All -and (Test-Path $cursorFile)) { try { $cursor = [long](Get-Content $cursorFile -Raw).Trim() } catch { $cursor = 0L } }

function ToIso([long]$ms) { if ($ms -le 0) { return $null }; return [DateTimeOffset]::FromUnixTimeMilliseconds($ms).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ') }
# StrictMode 下安全取属性（元数据字段可能缺失）
function Get-Prop($o, [string]$n) { if ($null -ne $o -and $o.PSObject.Properties[$n]) { return $o.$n } return $null }

$metaFiles = Get-ChildItem $SessionsDir -Recurse -Filter 'local_*.json' -File | Sort-Object LastWriteTime
$newCursor = $cursor; $written = 0; $skipped = 0; $deduped = 0; $byProject = @{}

foreach ($mf in $metaFiles) {
  $ticks = $mf.LastWriteTime.ToUniversalTime().Ticks
  if (-not $All -and $ticks -le $cursor) { continue }
  if ($ticks -gt $newCursor) { $newCursor = $ticks }

  try { $m = Get-Content $mf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
  $cliId = Get-Prop $m 'cliSessionId'
  if (-not $cliId) { continue }
  $wtPath = Get-Prop $m 'worktreePath'
  $cwd = if ($wtPath) { $wtPath } else { Get-Prop $m 'cwd' }
  if (-not $cwd) { continue }
  $mBranch = Get-Prop $m 'branch'; $mTitle = Get-Prop $m 'title'

  $g = Get-GitInfo $cwd
  if (-not $g.main_root) { $skipped++; continue }
  $projectRoot = $g.main_root
  $project = Split-Path -Leaf $projectRoot

  # 去重：同会话已被 CLI hook 采过？
  $idClean = ($cliId -replace '[^A-Za-z0-9]',''); $shortId = $idClean.Substring(0,[Math]::Min(8,$idClean.Length))
  $cliDigestGlob = Join-Path $projectRoot "session-history\digests\*-claude-cli-$shortId.json"
  if (-not $Force -and (Test-Path $cliDigestGlob)) { $deduped++; continue }

  # 找 transcript
  $tr = Get-ChildItem $ProjectsDir -Recurse -Filter "$cliId.jsonl" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  $ct = Get-Prop $m 'completedTurns'; if ($null -eq $ct) { $ct = 0 }
  $createdMs = Get-Prop $m 'createdAt'; $lastMs = Get-Prop $m 'lastActivityAt'
  $redacted = $null; $rel = @(); $tools = @{}; $turns = $ct; $firstPrompt = $mTitle
  $started = ToIso ([long]($createdMs)); $ended = ToIso ([long]($lastMs)); $version = $null

  if ($tr) {
    $lines = [System.IO.File]::ReadAllLines($tr.FullName, [System.Text.Encoding]::UTF8)
    $p = Get-ClaudeTranscriptInfo $lines
    $rel = ConvertTo-RelFiles $p.files $projectRoot
    $tools = $p.tools
    if ($p.turns -gt 0) { $turns = $p.turns }
    if ($p.first_prompt) { $firstPrompt = $p.first_prompt }
    if ($p.started_at) { $started = $p.started_at }
    if ($p.ended_at) { $ended = $p.ended_at }
    if ($p.branch -and $p.branch -ne 'HEAD') { $g.branch = $p.branch }
    $version = $p.version
    $redacted = $lines | ForEach-Object { Get-RedactedText $_ }
  }
  # 元数据分支最权威（worktree/分支由 Desktop 记录）
  if ($mBranch -and $mBranch -ne 'HEAD') { $g.branch = $mBranch }

  $fpTrunc = $null
  if ($firstPrompt) { $rp = Get-RedactedText ([string]$firstPrompt); $fpTrunc = $rp.Substring(0,[Math]::Min(200,$rp.Length)) }

  $digest = [ordered]@{
    schema=1; id=$cliId; tool='claude-desktop'; origin='desktop'
    machine=$env:COMPUTERNAME; os=(Get-OsName); project=$project
    cwd=($cwd -replace '\\','/')
    git=[ordered]@{ branch=$g.branch; is_worktree=$g.is_worktree; worktree=$g.worktree; head=$g.head; dirty=$g.dirty }
    started_at=$started; ended_at=$ended; turns=$turns
    first_prompt=$fpTrunc; title=$mTitle
    summary=''; files_touched=$rel; tools_used=$tools; next_steps=@()
    cli_version=$version; transcript_ref=$null
  }
  [void](Write-SessionDigest -Digest $digest -RedactedLines $redacted -ProjectRoot $projectRoot)
  $written++
  if ($byProject.ContainsKey($project)) { $byProject[$project]++ } else { $byProject[$project]=1 }
}

Set-Content -LiteralPath $cursorFile -Value $newCursor -Encoding ASCII
Write-Output "desktop-scrape: wrote $written, deduped $deduped (已被 CLI 采过), skipped $skipped (non-git)."
$byProject.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
