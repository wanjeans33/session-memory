<#
  共享库（PowerShell）：脱敏、git 信息、digest 写入。
  被 claude-session-end.ps1 / codex-scrape.ps1 dot-source 引用。
#>
Set-StrictMode -Version Latest

# ── 脱敏（best-effort，见 DESIGN.md §5）─────────────────────────
function Get-RedactedText([string]$text) {
  if (-not $text) { return $text }
  $rx = @(
    @{ p = '(?s)-----BEGIN[^-]*PRIVATE KEY-----.*?-----END[^-]*PRIVATE KEY-----'; r = '[REDACTED:private-key]' },
    @{ p = 'sk-ant-[A-Za-z0-9_\-]{20,}';      r = '[REDACTED:anthropic-key]' },
    @{ p = 'sk-(?:proj-)?[A-Za-z0-9_\-]{20,}'; r = '[REDACTED:openai-key]' },
    @{ p = 'gh[pousr]_[A-Za-z0-9]{30,}';       r = '[REDACTED:github-token]' },
    @{ p = 'xox[baprs]-[A-Za-z0-9\-]{10,}';    r = '[REDACTED:slack-token]' },
    @{ p = 'AKIA[0-9A-Z]{16}';                 r = '[REDACTED:aws-key]' },
    @{ p = 'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'; r = '[REDACTED:jwt]' },
    @{ p = '(?i)(authorization"?\s*[:=]\s*"?\s*bearer\s+)[A-Za-z0-9._\-]+'; r = '${1}[REDACTED:bearer]' },
    @{ p = '(?i)((?:password|passwd|api[_-]?key|secret|access[_-]?token|token)"?\s*[:=]\s*"?)[^"\s,}]{6,}'; r = '${1}[REDACTED]' }
  )
  foreach ($e in $rx) { $text = [regex]::Replace($text, $e.p, $e.r) }
  return $text
}

# ── git 信息：主工作树根 + 当前分支/HEAD/worktree ─────────────
function Get-GitInfo([string]$cwd) {
  $info = @{ branch=$null; head=$null; dirty=$false; is_worktree=$false; worktree=$null; toplevel=$null; main_root=$null }
  if (-not $cwd -or -not (Test-Path $cwd)) { return $info }
  try {
    $top = (& git -C $cwd rev-parse --path-format=absolute --show-toplevel 2>$null)
    if (-not $top) { return $info }
    # 全部归一化为正斜杠、去尾斜杠，避免 / vs \ 比较出错
    $info.toplevel = (($top | Select-Object -First 1).Trim() -replace '\\','/').TrimEnd('/')
    $commonDir = (& git -C $cwd rev-parse --path-format=absolute --git-common-dir 2>$null | Select-Object -First 1).Trim()
    $info.main_root = ((Split-Path -Parent $commonDir) -replace '\\','/').TrimEnd('/')
    $info.is_worktree = ($info.toplevel.ToLower() -ne $info.main_root.ToLower())
    if ($info.is_worktree -and $info.toplevel.ToLower().StartsWith(($info.main_root.ToLower() + '/'))) {
      $info.worktree = $info.toplevel.Substring($info.main_root.Length).TrimStart('/')
    }
    $info.branch = (& git -C $cwd rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1).Trim()
    $info.head   = (& git -C $cwd rev-parse --short HEAD 2>$null | Select-Object -First 1).Trim()
    $status = (& git -C $cwd status --porcelain 2>$null)
    $info.dirty = [bool]$status
  } catch {}
  return $info
}

function Get-OsName {
  if ($env:OS -eq 'Windows_NT') { return 'windows' }
  if ($IsMacOS) { return 'macos' }
  return 'linux'
}

# 解析 Claude transcript（jsonl 行数组）→ 关键字段。Claude CLI 与 Desktop 共用同一 transcript 格式。
function Get-ClaudeTranscriptInfo([string[]]$lines) {
  $r = @{ id=$null; started_at=$null; ended_at=$null; branch=$null; cwd=$null; version=$null; turns=0; first_prompt=$null; files=@(); tools=@{} }
  $set = New-Object System.Collections.Generic.HashSet[string]
  $editTools = @('Edit','Write','MultiEdit','NotebookEdit')
  foreach ($ln in $lines) {
    if (-not $ln.Trim()) { continue }
    try { $o = $ln | ConvertFrom-Json } catch { continue }
    if ($o.PSObject.Properties.Name -contains 'timestamp' -and $o.timestamp) { if (-not $r.started_at) { $r.started_at = $o.timestamp }; $r.ended_at = $o.timestamp }
    if ($o.PSObject.Properties.Name -contains 'sessionId' -and $o.sessionId -and -not $r.id) { $r.id = $o.sessionId }
    if ($o.PSObject.Properties.Name -contains 'gitBranch' -and $o.gitBranch -and -not $r.branch) { $r.branch = $o.gitBranch }
    if ($o.PSObject.Properties.Name -contains 'cwd' -and $o.cwd -and -not $r.cwd) { $r.cwd = $o.cwd }
    if ($o.PSObject.Properties.Name -contains 'version' -and $o.version -and -not $r.version) { $r.version = $o.version }
    if ($o.type -eq 'user' -and $o.message -and $o.message.role -eq 'user') {
      $c = $o.message.content; $text = $null
      if ($c -is [string]) { $text = $c }
      elseif ($c) {
        $isTR = $false
        foreach ($it in $c) { if ($it.type -eq 'tool_result') { $isTR = $true }; if ($it.type -eq 'text' -and -not $text) { $text = $it.text } }
        if ($isTR) { $text = $null }
      }
      if ($text -and -not ($text.StartsWith('<'))) { $r.turns++; if (-not $r.first_prompt) { $r.first_prompt = $text } }
    }
    if ($o.type -eq 'assistant' -and $o.message -and $o.message.content) {
      foreach ($it in $o.message.content) {
        if ($it.type -eq 'tool_use') {
          $n = $it.name
          if ($n) { if ($r.tools.ContainsKey($n)) { $r.tools[$n]++ } else { $r.tools[$n] = 1 } }
          if ($editTools -contains $n -and $it.input -and $it.input.file_path) { [void]$set.Add([string]$it.input.file_path) }
        }
      }
    }
  }
  $r.files = @($set)
  return $r
}

# files 绝对路径 -> 相对 $root（正斜杠）
function ConvertTo-RelFiles($files, [string]$root) {
  $rr = ($root -replace '\\','/')
  $out = @()
  foreach ($f in $files) {
    $fp = $f -replace '\\','/'
    if ($fp.ToLower().StartsWith($rr.ToLower())) { $fp = $fp.Substring($rr.Length).TrimStart('/') }
    $out += $fp
  }
  return $out
}

# ── 写 digest + 脱敏 transcript 到目标项目 session-history/ ─────
# $digest: hashtable；$redactedLines: string[]（已脱敏的 transcript 行，可为 $null 表示不存原文）
function Write-SessionDigest {
  param($Digest, [string[]]$RedactedLines, [string]$ProjectRoot)
  if (-not $ProjectRoot) { throw "ProjectRoot required" }
  $utf8 = New-Object System.Text.UTF8Encoding $false   # 无 BOM，利于 git diff
  $histDir = Join-Path $ProjectRoot 'session-history'
  $digestDir = Join-Path $histDir 'digests'
  $tsDir = Join-Path $histDir 'transcripts'
  New-Item -ItemType Directory -Force -Path $digestDir | Out-Null

  $ended = if ($Digest.ended_at) { [datetime]::Parse($Digest.ended_at).ToString('yyyy-MM-dd_HHmmss') } else { 'unknown' }
  $idClean = ($Digest.id -replace '[^A-Za-z0-9]','')
  $shortId = $idClean.Substring(0, [Math]::Min(8, $idClean.Length))
  $base = "$ended-$($Digest.tool)-$shortId"

  if ($RedactedLines) {
    New-Item -ItemType Directory -Force -Path $tsDir | Out-Null
    $tsPath = Join-Path $tsDir "$base.jsonl"
    [System.IO.File]::WriteAllLines($tsPath, $RedactedLines, $utf8)
    $Digest.transcript_ref = "session-history/transcripts/$base.jsonl"
  }
  $digestPath = Join-Path $digestDir "$base.json"
  [System.IO.File]::WriteAllText($digestPath, ($Digest | ConvertTo-Json -Depth 12), $utf8)

  if ($env:SESSION_HISTORY_AUTOCOMMIT -eq '1') {
    try {
      & git -C $ProjectRoot add -- session-history 2>$null
      $st = & git -C $ProjectRoot status --porcelain -- session-history 2>$null
      if ($st) { & git -C $ProjectRoot commit -q -m "chore(session-history): $base" -- session-history 2>$null }
    } catch {}
  }
  return $digestPath
}
