<#
.SYNOPSIS
  把本项目 session-history/ 里的会话「导入」到当前端的会话列表（CLI --resume + Desktop sidebar），
  标题前缀来源标签如 "(codex) …"。手动命令（由 /session-memory read 调用）。
.DESCRIPTION
  -List                 列出本项目 session-history/ 的候选会话（base、tool、machine、title）。
  -Import -Ids <base,…> 导入指定会话（用 -List 给出的 base 名，逗号分隔）。
    -Targets cli,desktop  注入目标（默认 cli）。
  注入逻辑：
    · Claude 来源（claude-cli/claude-desktop）：transcript 本就是 Claude jsonl → 复制成新会话，首条 user 消息前缀标签。
    · Codex 来源：rollout 非 Claude 格式 → 生成最小占位 jsonl（first_prompt + 指向脱敏原文的说明）。
  限制：仅同 OS 导入（cwd 绝对路径/项目编码因 OS 而异）；Codex 为占位非全保真。
.PARAMETER Cwd                覆盖工作目录（默认当前；决定导入到哪个项目的列表）
.PARAMETER ProjectsDir        覆盖 ~/.claude/projects（测试用）
.PARAMETER DesktopSessionsDir 覆盖 %APPDATA%\Claude\claude-code-sessions（测试用）
#>
param([switch]$List, [switch]$Import, [string]$Ids, [string]$Targets='cli', [string]$Cwd, [string]$ProjectsDir, [string]$DesktopSessionsDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'capture\_lib.ps1')
if (-not $Cwd) { $Cwd = (Get-Location).Path }
if (-not $ProjectsDir) { $ProjectsDir = Join-Path $env:USERPROFILE '.claude\projects' }
if (-not $DesktopSessionsDir) { $DesktopSessionsDir = Join-Path $env:APPDATA 'Claude\claude-code-sessions' }

$g = Get-GitInfo $Cwd
$root = if ($g.main_root) { $g.main_root } else { $Cwd }
$histDir = Join-Path $root 'session-history'
$digestDir = Join-Path $histDir 'digests'
if (-not (Test-Path $digestDir)) { Write-Output "本项目无 session-history/digests（先在别处 save，再 git pull）。"; exit 0 }

function Label([string]$tool) {
  switch ($tool) { 'codex' { 'codex' } 'claude-desktop' { 'desktop' } 'claude-cli' { 'cli' } default { $tool } }
}

# ── -List ──────────────────────────────────────────────────────
if (-not $Import) {
  $rows = @()
  foreach ($f in (Get-ChildItem $digestDir -Filter *.json -File | Sort-Object Name -Descending)) {
    try { $d = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    $ttl = if ($d.PSObject.Properties['title'] -and $d.title) { $d.title } else { $d.first_prompt }
    $rows += [ordered]@{ base=$f.BaseName; tool=$d.tool; machine=$d.machine; ended_at=$d.ended_at; title=$ttl }
  }
  $rows | ConvertTo-Json -Depth 5
  exit 0
}

# ── -Import ────────────────────────────────────────────────────
$wantTargets = ($Targets -split ',') | ForEach-Object { $_.Trim().ToLower() }
$wantBases = @()
if ($Ids) { $wantBases = ($Ids -split ',') | ForEach-Object { $_.Trim() } }
if (-not $wantBases) { Write-Output "用 -Ids 指定要导入的 base（逗号分隔），可先 -List。"; exit 0 }

$encCur = Get-EncodedProject $Cwd
$targetProjDir = Join-Path $ProjectsDir $encCur
New-Item -ItemType Directory -Force -Path $targetProjDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false

# Desktop 账号/工作区 UUID：从现存任一 local_*.json 父目录反查
$desktopScope = $null
if ($wantTargets -contains 'desktop') {
  $anyLocal = Get-ChildItem $DesktopSessionsDir -Recurse -Filter 'local_*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($anyLocal) { $desktopScope = $anyLocal.Directory.FullName }
}

$done = 0
foreach ($base in $wantBases) {
  $dp = Join-Path $digestDir "$base.json"
  if (-not (Test-Path $dp)) { Write-Output "跳过（找不到）：$base"; continue }
  $d = Get-Content $dp -Raw -Encoding UTF8 | ConvertFrom-Json
  $label = Label $d.tool
  $newId = [guid]::NewGuid().ToString()
  $title = if ($d.PSObject.Properties['title'] -and $d.title) { $d.title } else { $d.first_prompt }
  if (-not $title) { $title = '(无标题)' }
  $taggedTitle = "($label) $title"
  $branch = if ($d.git -and $d.git.branch) { $d.git.branch } else { '' }

  # 1) 造当前端的 Claude jsonl
  $srcTs = $null
  if ($d.transcript_ref) { $cand = Join-Path $root $d.transcript_ref; if (Test-Path $cand) { $srcTs = $cand } }
  $outLines = @()
  if ($srcTs -and ($d.tool -eq 'claude-cli' -or $d.tool -eq 'claude-desktop')) {
    # Claude 原文：复制并给首条 user 消息打标签
    $lines = [System.IO.File]::ReadAllLines($srcTs, [System.Text.Encoding]::UTF8)
    $tagged = $false
    foreach ($ln in $lines) {
      if (-not $tagged -and $ln -match '"type"\s*:\s*"user"') {
        try {
          $o = $ln | ConvertFrom-Json
          if ($o.type -eq 'user' -and $o.message -and $o.message.role -eq 'user') {
            $c = $o.message.content
            if ($c -is [string]) { $o.message.content = "($label) $c"; $tagged = $true }
            elseif ($c) { foreach ($it in $c) { if (-not $tagged -and $it.type -eq 'text') { $it.text = "($label) $($it.text)"; $tagged = $true } } }
            $ln = ($o | ConvertTo-Json -Depth 30 -Compress)
          }
        } catch {}
      }
      $outLines += $ln
    }
  } else {
    # Codex / 无原文：最小占位会话
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $u = [ordered]@{ type='user'; message=[ordered]@{ role='user'; content="($label) $($d.first_prompt)" }; timestamp=$d.started_at; sessionId=$newId; cwd=($Cwd -replace '\\','/'); gitBranch=$branch; version='imported' }
    $note = "[导入自 $($d.tool)（$($d.machine)）] turns=$($d.turns)。原会话脱敏原文见 $($d.transcript_ref)。文件改动：" + (($d.files_touched) -join ', ')
    $a = [ordered]@{ type='assistant'; message=[ordered]@{ role='assistant'; content=@([ordered]@{ type='text'; text=$note }) }; timestamp=$d.ended_at; sessionId=$newId }
    $outLines = @(($u | ConvertTo-Json -Depth 10 -Compress), ($a | ConvertTo-Json -Depth 10 -Compress))
  }
  $jsonlPath = Join-Path $targetProjDir "$newId.jsonl"
  [System.IO.File]::WriteAllLines($jsonlPath, $outLines, $utf8)
  $msg = "导入 $base → CLI: $jsonlPath"

  # 2) Desktop descriptor（可选）
  if ($wantTargets -contains 'desktop' -and $desktopScope) {
    $toMs = { param($iso) if ($iso) { try { [DateTimeOffset]::Parse($iso).ToUnixTimeMilliseconds() } catch { 0 } } else { 0 } }
    $desc = [ordered]@{
      sessionId = "local_$([guid]::NewGuid().ToString())"; cliSessionId = $newId
      cwd = $Cwd; originCwd = $Cwd; worktreePath = ''; branch = $branch
      title = $taggedTitle; titleSource = 'auto'
      createdAt = (& $toMs $d.started_at); lastActivityAt = (& $toMs $d.ended_at)
      model = 'claude-opus-4-8'; isArchived = $false; permissionMode = 'auto'; completedTurns = $d.turns
    }
    $descPath = Join-Path $desktopScope ("local_" + $desc.sessionId.Substring(6) + '.json')
    [System.IO.File]::WriteAllText($descPath, ($desc | ConvertTo-Json -Depth 8), $utf8)
    $msg += " | Desktop: $descPath"
  } elseif ($wantTargets -contains 'desktop') {
    $msg += " | Desktop: 跳过（未找到现存 local_*.json 反查账号目录）"
  }
  Write-Output $msg
  $done++
}
Write-Output "read: 导入 $done 条。"
