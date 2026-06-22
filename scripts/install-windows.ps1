<#
.SYNOPSIS
  在 Windows 上把 Claude Code 接入这个记忆仓库：
    1) 记忆目录联接（junction）：~/.claude/projects/<encoded>/memory  →  <repo>\memory
    2) 在 ~/.claude/CLAUDE.md 写入 @import 引用仓库的 CLAUDE.md（全局规则）
    3) 合并 settings/settings.shared.json 进 ~/.claude/settings.json
    4) 安装 hooks：SessionStart 拉取 / SessionEnd 提交推送【记忆仓库】
  会话采集已改为手动命令 /session-memory save，不再安装采集 hook（并会清理历史装过的）。
  幂等：可重复运行。修改 settings.json 前会自动备份为 settings.json.bak。
  junction 无需管理员权限。
#>
$ErrorActionPreference = 'Stop'
$Repo    = Split-Path -Parent $PSScriptRoot
$RepoFwd = $Repo -replace '\\', '/'
$claude  = Join-Path $env:USERPROFILE '.claude'

# 把绝对路径编码成 Claude Code 的项目文件夹名（空格 : \ / _ . 都变成 -）
function Get-EncodedProject([string]$p) { $p -replace '[ :\\/_.]', '-' }

Write-Host "仓库: $Repo"

# ── 1) 记忆 junction ─────────────────────────────────────────
$encoded   = Get-EncodedProject $Repo
$projMem   = Join-Path $claude "projects\$encoded\memory"
$repoMem   = Join-Path $Repo 'memory'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $projMem) | Out-Null
New-Item -ItemType Directory -Force -Path $repoMem | Out-Null

if (Test-Path $projMem) {
  $item = Get-Item $projMem -Force
  if ($item.LinkType) {
    cmd /c rmdir "`"$projMem`"" | Out-Null            # 已是链接，先移除
  } else {
    # 真实目录：把已有内容迁移进仓库，再删除
    Get-ChildItem $projMem -Force -ErrorAction SilentlyContinue |
      Copy-Item -Destination $repoMem -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $projMem -Recurse -Force
  }
}
cmd /c mklink /J "`"$projMem`"" "`"$repoMem`"" | Out-Null
Write-Host "✓ 记忆 junction: $projMem -> $repoMem"

# ── 1b) 技能 junction：~/.claude/skills/<name> -> <repo>\skills\<name> ──
$skillsSrc = Join-Path $Repo 'skills'
$skillsDst = Join-Path $claude 'skills'
if (Test-Path $skillsSrc) {
  New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null
  foreach ($sk in (Get-ChildItem $skillsSrc -Directory)) {
    $link = Join-Path $skillsDst $sk.Name
    if (Test-Path $link) {
      $li = Get-Item $link -Force
      if ($li.LinkType) { cmd /c rmdir "`"$link`"" | Out-Null }
      else { Remove-Item $link -Recurse -Force }   # 旧真实目录：用仓库版本覆盖
    }
    cmd /c mklink /J "`"$link`"" "`"$($sk.FullName)`"" | Out-Null
    Write-Host "✓ 技能 junction: $link -> $($sk.FullName)"
  }
  # 清理已改名的旧技能链接 session-share（现为 session-memory）
  $oldLink = Join-Path $skillsDst 'session-share'
  if (Test-Path $oldLink) {
    $li = Get-Item $oldLink -Force
    if ($li.LinkType) { cmd /c rmdir "`"$oldLink`"" | Out-Null; Write-Host "✓ 已移除旧技能链接 session-share" }
  }
}

# ── 2) CLAUDE.md @import ─────────────────────────────────────
$userMd     = Join-Path $claude 'CLAUDE.md'
$importLine = "@$RepoFwd/CLAUDE.md"
$mdContent  = if (Test-Path $userMd) { Get-Content $userMd -Raw } else { '' }
if ($mdContent -notlike "*$importLine*") {
  Add-Content -Path $userMd -Value "`n# 多端同步的全局记忆（由 claude-session-memory 安装）`n$importLine`n"
  Write-Host "✓ 已在 ~/.claude/CLAUDE.md 写入 import"
} else {
  Write-Host "• ~/.claude/CLAUDE.md 已包含 import，跳过"
}

# ── 3)+4) settings.json 合并 + hooks ─────────────────────────
$settingsPath = Join-Path $claude 'settings.json'
$settings = @{}
if (Test-Path $settingsPath) {
  Copy-Item $settingsPath "$settingsPath.bak" -Force          # 备份
  $raw = Get-Content $settingsPath -Raw
  if ($raw.Trim()) {
    # PSCustomObject -> hashtable（PS5.1 没有 -AsHashtable）
    $obj = $raw | ConvertFrom-Json
    function ConvertTo-HT($o) {
      if ($o -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-HT $p.Value }; return $h
      } elseif ($o -is [System.Collections.IEnumerable] -and $o -isnot [string]) {
        return @($o | ForEach-Object { ConvertTo-HT $_ })
      } else { return $o }
    }
    $settings = ConvertTo-HT $obj
  }
}

# 合并 shared 设置（不覆盖用户已设置的同名键）
$sharedPath = Join-Path $Repo 'settings\settings.shared.json'
if (Test-Path $sharedPath) {
  $shared = (Get-Content $sharedPath -Raw | ConvertFrom-Json)
  foreach ($p in $shared.PSObject.Properties) {
    if (-not $settings.ContainsKey($p.Name)) { $settings[$p.Name] = $p.Value }
  }
}

# 安装 hooks（幂等：按 command 字符串去重）
$startCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$RepoFwd/scripts/memory-sync/sync.ps1`" -PullOnly"
$endCmd   = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$RepoFwd/scripts/memory-sync/sync.ps1`""
if (-not $settings.ContainsKey('hooks')) { $settings['hooks'] = @{} }

function Add-Hook($hooks, $event, $command) {
  if (-not $hooks.ContainsKey($event)) { $hooks[$event] = @() }
  $exists = $false
  foreach ($grp in $hooks[$event]) {
    foreach ($h in $grp.hooks) { if ($h.command -eq $command) { $exists = $true } }
  }
  if (-not $exists) {
    $hooks[$event] = @($hooks[$event]) + @(@{ hooks = @(@{ type = 'command'; command = $command }) })
  }
  return $hooks
}
$settings['hooks'] = Add-Hook $settings['hooks'] 'SessionStart' $startCmd
$settings['hooks'] = Add-Hook $settings['hooks'] 'SessionEnd'   $endCmd

# 会话采集已改为手动 /session-memory save —— 移除历史可能装过的采集 hook（保留 memory-sync 的 sync hook）
$capPatterns = @('claude-session-end.ps1','claude-scrape.ps1','/session-history/capture/')
if ($settings['hooks'].ContainsKey('SessionEnd')) {
  $settings['hooks']['SessionEnd'] = @($settings['hooks']['SessionEnd'] | Where-Object {
    $cmds = @($_.hooks | ForEach-Object { $_.command })
    $isCap = $false
    foreach ($c in $cmds) { foreach ($pat in $capPatterns) { if ($c -like "*$pat*") { $isCap = $true } } }
    -not $isCap
  })
}

$settings | ConvertTo-Json -Depth 12 | Set-Content -Path $settingsPath -Encoding UTF8
Write-Host "✓ 已合并 settings.json 并安装 memory-sync hooks（备份在 settings.json.bak）"
Write-Host "• 会话采集为手动：项目里用 /session-memory save（或 scripts\session-history\save.ps1）"
Write-Host ""
Write-Host "完成。新开一个 Claude Code 会话即可生效。"
