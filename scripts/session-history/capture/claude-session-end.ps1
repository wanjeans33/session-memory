<#
.SYNOPSIS
  Claude Code SessionEnd hook：把刚结束的会话抽成一条 digest + 脱敏原文，
  写进**目标项目**的 session-history/。
.DESCRIPTION
  hook 会通过 stdin 传入 JSON：{ session_id, transcript_path, cwd, hook_event_name, reason }。
  也支持手动测试：-TranscriptPath <jsonl> [-Cwd <dir>]。
  设计见 DESIGN.md。任何异常都吞掉并 exit 0，绝不打断 Claude。
#>
param([string]$TranscriptPath, [string]$Cwd)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

try {
  # 1) 取输入：优先 stdin（hook），否则用参数（手动测试）
  $stdin = ''
  if (-not $TranscriptPath) {
    try { $stdin = [Console]::In.ReadToEnd() } catch {}
    if ($stdin.Trim()) {
      $h = $stdin | ConvertFrom-Json
      $TranscriptPath = $h.transcript_path
      if (-not $Cwd) { $Cwd = $h.cwd }
      $sessionId = $h.session_id
    }
  }
  if (-not $TranscriptPath -or -not (Test-Path -LiteralPath $TranscriptPath)) { exit 0 }
  $lines = [System.IO.File]::ReadAllLines($TranscriptPath, [System.Text.Encoding]::UTF8)
  if (-not $lines) { exit 0 }

  # 2) 解析 transcript（共享解析器）
  $p = Get-ClaudeTranscriptInfo $lines
  $id = $p.id
  if (-not $id) { if ($sessionId) { $id = $sessionId } else { $id = [System.IO.Path]::GetFileNameWithoutExtension($TranscriptPath) } }
  if (-not $Cwd) { $Cwd = $p.cwd }

  # 3) git 信息（用当前 cwd 现算 HEAD/dirty/worktree；分支优先用 transcript 内嵌的）
  $g = Get-GitInfo $Cwd
  $projectRoot = if ($g.main_root) { $g.main_root } elseif ($Cwd) { $Cwd } else { (Split-Path -Parent $TranscriptPath) }
  # 分支：优先 transcript 内嵌（会话发生时的分支），但忽略空 / detached 的 "HEAD"，回退到 live git
  if ($p.branch -and $p.branch -ne 'HEAD') { $g.branch = $p.branch }
  $project = Split-Path -Leaf $projectRoot

  $rel = ConvertTo-RelFiles $p.files $projectRoot
  $fpTrunc = $null
  if ($p.first_prompt) { $r = Get-RedactedText $p.first_prompt; $fpTrunc = $r.Substring(0,[Math]::Min(200,$r.Length)) }

  $digest = [ordered]@{
    schema=1; id=$id; tool='claude-cli'; origin=$null
    machine=$env:COMPUTERNAME; os=(Get-OsName); project=$project
    cwd=($Cwd -replace '\\','/')
    git=[ordered]@{ branch=$g.branch; is_worktree=$g.is_worktree; worktree=$g.worktree; head=$g.head; dirty=$g.dirty }
    started_at=$p.started_at; ended_at=$p.ended_at; turns=$p.turns
    first_prompt=$fpTrunc
    summary=''; files_touched=$rel; tools_used=$p.tools; next_steps=@()
    cli_version=$p.version; transcript_ref=$null
  }

  # 4) 脱敏原文
  $redacted = $lines | ForEach-Object { Get-RedactedText $_ }

  $out = Write-SessionDigest -Digest $digest -RedactedLines $redacted -ProjectRoot $projectRoot
  Write-Output "session-history digest written: $out"
} catch {
  # 永不打断 Claude
}
exit 0
