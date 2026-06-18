<#
.SYNOPSIS
  扫描 Codex CLI 的 rollout 会话（~/.codex/sessions/**/rollout-*.jsonl），
  转成统一 digest + 脱敏原文，按各自 cwd 归到对应**项目仓库**的 session-history/。
.DESCRIPTION
  增量：游标存 ~/.claude/.codex-scrape-cursor（上次处理到的最新文件 mtime ticks）。
  幂等：digest 文件名由 id+结束时间决定，重复扫描会覆盖同一文件。
  Codex 无 SessionEnd hook，可手动/定时/在 config.toml 的 notify 里触发本脚本。
.PARAMETER All      忽略游标，全量重扫。
.PARAMETER SessionsDir  覆盖默认 ~/.codex/sessions。
#>
param([switch]$All, [string]$SessionsDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

if (-not $SessionsDir) { $SessionsDir = Join-Path $env:USERPROFILE '.codex\sessions' }
if (-not (Test-Path $SessionsDir)) { Write-Output "no codex sessions dir: $SessionsDir"; exit 0 }
$cursorFile = Join-Path $env:USERPROFILE '.claude\.codex-scrape-cursor'
$cursor = 0L
if (-not $All -and (Test-Path $cursorFile)) { try { $cursor = [long](Get-Content $cursorFile -Raw).Trim() } catch { $cursor = 0L } }

$injectPrefixes = @('# AGENTS.md','<INSTRUCTIONS','<permissions','<user_instructions','<environment_context','<system','<context')
function Test-RealUser([string]$t) {
  if (-not $t) { return $false }
  $s = $t.TrimStart()
  foreach ($p in $injectPrefixes) { if ($s.StartsWith($p)) { return $false } }
  return $true
}

$files = Get-ChildItem $SessionsDir -Recurse -Filter 'rollout-*.jsonl' -File | Sort-Object LastWriteTime
$newCursor = $cursor
$written = 0; $skipped = 0; $byProject = @{}

foreach ($file in $files) {
  $ticks = $file.LastWriteTime.ToUniversalTime().Ticks
  if (-not $All -and $ticks -le $cursor) { continue }
  if ($ticks -gt $newCursor) { $newCursor = $ticks }

  try { $lines = [System.IO.File]::ReadAllLines($file.FullName, [System.Text.Encoding]::UTF8) } catch { continue }
  if (-not $lines) { continue }

  $id=$null; $cwd=$null; $origin=$null; $cliVer=$null; $startedAt=$null; $endedAt=$null
  $turns=0; $firstPrompt=$null
  $files2 = New-Object System.Collections.Generic.HashSet[string]
  $tools = @{}

  foreach ($ln in $lines) {
    if (-not $ln.Trim()) { continue }
    try { $o = $ln | ConvertFrom-Json } catch { continue }
    if ($o.timestamp) { if (-not $startedAt) { $startedAt = $o.timestamp }; $endedAt = $o.timestamp }
    if ($o.type -eq 'session_meta' -and $o.payload) {
      $id = $o.payload.id; $cwd = $o.payload.cwd; $origin = $o.payload.originator; $cliVer = $o.payload.cli_version
      continue
    }
    if ($o.type -ne 'response_item' -or -not $o.payload) { continue }
    $p = $o.payload
    switch ($p.type) {
      'message' {
        if ($p.role -eq 'user' -and $p.content) {
          $txt = $null
          foreach ($it in $p.content) { if ($it.type -eq 'input_text' -and $it.text) { $txt = $it.text; break } }
          if ((Test-RealUser $txt)) { $turns++; if (-not $firstPrompt) { $firstPrompt = $txt } }
        }
      }
      'function_call'      { if ($p.name) { if ($tools.ContainsKey($p.name)) { $tools[$p.name]++ } else { $tools[$p.name]=1 } } }
      'custom_tool_call'   {
        if ($p.name) { if ($tools.ContainsKey($p.name)) { $tools[$p.name]++ } else { $tools[$p.name]=1 } }
        if ($p.name -eq 'apply_patch' -and $p.input) {
          foreach ($pl in ($p.input -split "`n")) {
            $m = [regex]::Match($pl, '^\*\*\* (?:Add|Update|Delete) File: (.+)$')
            if ($m.Success) { [void]$files2.Add($m.Groups[1].Value.Trim()) }
          }
        }
      }
    }
  }
  if (-not $id) { $id = [System.IO.Path]::GetFileNameWithoutExtension($file.Name) }

  $g = Get-GitInfo $cwd
  if (-not $g.main_root) { $skipped++; continue }   # 非 git 仓库的会话跳过（无处可归）
  $projectRoot = $g.main_root
  $project = Split-Path -Leaf $projectRoot

  $rootResolved = try { (Resolve-Path -LiteralPath $projectRoot).Path } catch { $projectRoot }
  $rr = $rootResolved -replace '\\','/'
  $rel = @()
  foreach ($f in $files2) {
    $fp = $f -replace '\\','/'
    if ($fp.ToLower().StartsWith($rr.ToLower())) { $fp = $fp.Substring($rr.Length).TrimStart('/') }
    $rel += $fp
  }
  $fpTrunc = $null
  if ($firstPrompt) { $rp = Get-RedactedText $firstPrompt; $fpTrunc = $rp.Substring(0,[Math]::Min(200,$rp.Length)) }

  $digest = [ordered]@{
    schema=1; id=$id; tool='codex'; origin=$origin
    machine=$env:COMPUTERNAME; os=(Get-OsName); project=$project
    cwd=($cwd -replace '\\','/')
    git=[ordered]@{ branch=$g.branch; is_worktree=$g.is_worktree; worktree=$g.worktree; head=$g.head; dirty=$g.dirty }
    started_at=$startedAt; ended_at=$endedAt; turns=$turns
    first_prompt=$fpTrunc
    summary=''; files_touched=$rel; tools_used=$tools; next_steps=@()
    cli_version=$cliVer; transcript_ref=$null
  }
  $redacted = $lines | ForEach-Object { Get-RedactedText $_ }
  [void](Write-SessionDigest -Digest $digest -RedactedLines $redacted -ProjectRoot $projectRoot)
  $written++
  if ($byProject.ContainsKey($project)) { $byProject[$project]++ } else { $byProject[$project]=1 }
}

if (-not $All) { Set-Content -LiteralPath $cursorFile -Value $newCursor -Encoding ASCII }
elseif ($newCursor -gt 0) { Set-Content -LiteralPath $cursorFile -Value $newCursor -Encoding ASCII }

Write-Output "codex-scrape: wrote $written digest(s), skipped $skipped (non-git)."
$byProject.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
