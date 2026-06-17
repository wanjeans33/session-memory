<#
.SYNOPSIS
  只为【当前 repo】启用/关闭 Claude 会话采集（按 repo 范围）。
  把 SessionEnd 采集 hook 写进 <repo>/.claude/settings.local.json —— 该文件是
  本地的、不应提交（含本机绝对路径）。这样只有你显式启用的仓库才会采集。
.DESCRIPTION
  与全局安装（install-windows.ps1 -CaptureScope global）二选一，避免重复采集（一次会话生成两条 digest）。
  幂等：可重复运行。
.PARAMETER Repo    目标仓库内任意路径；默认当前目录。
.PARAMETER Remove  反向操作：移除该 repo 的采集 hook。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-capture-here.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-capture-here.ps1 -Remove
#>
param([string]$Repo, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = (Get-Location).Path }

# 本脚本在 <memory-repo>\scripts 下，采集脚本在同级 capture\ 里
$captureScriptFwd = ((Join-Path $PSScriptRoot 'capture\claude-session-end.ps1') -replace '\\','/')
$captureCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$captureScriptFwd`""

$top = (& git -C $Repo rev-parse --show-toplevel 2>$null | Select-Object -First 1)
if (-not $top) { Write-Error "不是 git 仓库: $Repo"; exit 1 }
$root = $top.Trim()
$claudeDir = Join-Path $root '.claude'
$settingsPath = Join-Path $claudeDir 'settings.local.json'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

function ConvertTo-HT($o) {
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    $h = @{}; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-HT $p.Value }; return $h
  } elseif ($o -is [System.Collections.IEnumerable] -and $o -isnot [string]) {
    return @($o | ForEach-Object { ConvertTo-HT $_ })
  } else { return $o }
}

$settings = @{}
if (Test-Path $settingsPath) {
  $raw = Get-Content $settingsPath -Raw
  if ($raw.Trim()) { $settings = ConvertTo-HT ($raw | ConvertFrom-Json) }
}
if (-not $settings.ContainsKey('hooks')) { $settings['hooks'] = @{} }
if (-not $settings['hooks'].ContainsKey('SessionEnd')) { $settings['hooks']['SessionEnd'] = @() }

# 过滤掉已存在的同 command 分组（用于去重 / 移除）
$kept = @(); $found = $false
foreach ($grp in @($settings['hooks']['SessionEnd'])) {
  $cmds = @($grp.hooks | ForEach-Object { $_.command })
  if ($cmds -contains $captureCmd) { $found = $true; if ($Remove) { continue } }
  $kept += $grp
}
if (-not $Remove -and -not $found) {
  $kept += @{ hooks = @(@{ type = 'command'; command = $captureCmd }) }
}
$settings['hooks']['SessionEnd'] = $kept

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 12), $utf8)

if ($Remove) {
  Write-Host "✓ 已移除采集 hook：$settingsPath"
} else {
  Write-Host "✓ 已为本 repo 启用采集：$settingsPath"
  Write-Host "  建议把 .claude/settings.local.json 加入该仓库 .gitignore（它含本机绝对路径，不应提交）。"
}
