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

  # 2) 解析 transcript
  $firstTs=$null; $lastTs=$null; $branch=$null; $tcwd=$null; $version=$null
  $id=$null; $turns=0; $firstPrompt=$null
  $files = New-Object System.Collections.Generic.HashSet[string]
  $tools = @{}
  $editTools = @('Edit','Write','MultiEdit','NotebookEdit')

  foreach ($ln in $lines) {
    if (-not $ln.Trim()) { continue }
    try { $o = $ln | ConvertFrom-Json } catch { continue }
    if ($o.PSObject.Properties.Name -contains 'timestamp' -and $o.timestamp) {
      if (-not $firstTs) { $firstTs = $o.timestamp }; $lastTs = $o.timestamp
    }
    if ($o.PSObject.Properties.Name -contains 'sessionId' -and $o.sessionId -and -not $id) { $id = $o.sessionId }
    if ($o.PSObject.Properties.Name -contains 'gitBranch' -and $o.gitBranch -and -not $branch) { $branch = $o.gitBranch }
    if ($o.PSObject.Properties.Name -contains 'cwd' -and $o.cwd -and -not $tcwd) { $tcwd = $o.cwd }
    if ($o.PSObject.Properties.Name -contains 'version' -and $o.version -and -not $version) { $version = $o.version }
    if ($o.type -eq 'user' -and $o.message -and $o.message.role -eq 'user') {
      $c = $o.message.content
      $text = $null
      if ($c -is [string]) { $text = $c }
      elseif ($c) {
        $isToolResult = $false
        foreach ($it in $c) {
          if ($it.type -eq 'tool_result') { $isToolResult = $true }
          if ($it.type -eq 'text' -and -not $text) { $text = $it.text }
        }
        if ($isToolResult) { $text = $null }
      }
      if ($text -and -not ($text.StartsWith('<'))) {
        $turns++
        if (-not $firstPrompt) { $firstPrompt = $text }
      }
    }
    if ($o.type -eq 'assistant' -and $o.message -and $o.message.content) {
      foreach ($it in $o.message.content) {
        if ($it.type -eq 'tool_use') {
          $n = $it.name
          if ($n) { if ($tools.ContainsKey($n)) { $tools[$n]++ } else { $tools[$n] = 1 } }
          if ($editTools -contains $n -and $it.input -and $it.input.file_path) {
            [void]$files.Add([string]$it.input.file_path)
          }
        }
      }
    }
  }
  if (-not $id) { if ($sessionId) { $id = $sessionId } else { $id = [System.IO.Path]::GetFileNameWithoutExtension($TranscriptPath) } }
  if (-not $Cwd) { $Cwd = $tcwd }

  # 3) git 信息（用当前 cwd 现算 HEAD/dirty/worktree；分支优先用 transcript 内嵌的）
  $g = Get-GitInfo $Cwd
  $projectRoot = if ($g.main_root) { $g.main_root } elseif ($Cwd) { $Cwd } else { (Split-Path -Parent $TranscriptPath) }
  # 分支：优先 transcript 内嵌（会话发生时的分支），但忽略空 / detached 的 "HEAD"，回退到 live git
  if ($branch -and $branch -ne 'HEAD') { $g.branch = $branch }
  $project = Split-Path -Leaf $projectRoot

  # files_touched 转相对路径
  $rootResolved = try { (Resolve-Path -LiteralPath $projectRoot).Path } catch { $projectRoot }
  $rel = @()
  foreach ($f in $files) {
    $fp = $f -replace '\\','/'
    $rr = $rootResolved -replace '\\','/'
    if ($fp.ToLower().StartsWith($rr.ToLower())) { $fp = $fp.Substring($rr.Length).TrimStart('/') }
    $rel += $fp
  }

  $fpTrunc = $null
  if ($firstPrompt) { $r = Get-RedactedText $firstPrompt; $fpTrunc = $r.Substring(0,[Math]::Min(200,$r.Length)) }

  $digest = [ordered]@{
    schema=1; id=$id; tool='claude-cli'; origin=$null
    machine=$env:COMPUTERNAME; os=(Get-OsName); project=$project
    cwd=($Cwd -replace '\\','/')
    git=[ordered]@{ branch=$g.branch; is_worktree=$g.is_worktree; worktree=$g.worktree; head=$g.head; dirty=$g.dirty }
    started_at=$firstTs; ended_at=$lastTs; turns=$turns
    first_prompt=$fpTrunc
    summary=''; files_touched=$rel; tools_used=$tools; next_steps=@()
    cli_version=$version; transcript_ref=$null
  }

  # 4) 脱敏原文
  $redacted = $lines | ForEach-Object { Get-RedactedText $_ }

  $out = Write-SessionDigest -Digest $digest -RedactedLines $redacted -ProjectRoot $projectRoot
  Write-Output "session-history digest written: $out"
} catch {
  # 永不打断 Claude
}
exit 0
