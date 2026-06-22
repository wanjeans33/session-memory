<#
.SYNOPSIS
  Connect this memory repository to Claude Code on Windows:
    1) Create a memory junction: ~/.claude/projects/<encoded>/memory  →  <repo>\memory
    2) Add an @import for this repository's CLAUDE.md to ~/.claude/CLAUDE.md
    3) Merge settings/settings.shared.json into ~/.claude/settings.json
    4) Install hooks that pull at SessionStart and commit/push this repository at SessionEnd
  Session capture is manual via /session-memory save; no capture hooks are installed.
  Idempotent: safe to re-run. settings.json is backed up as settings.json.bak before changes.
  Junctions do not require administrator privileges.
#>
$ErrorActionPreference = 'Stop'
$Repo    = Split-Path -Parent $PSScriptRoot
$RepoFwd = $Repo -replace '\\', '/'
$claude  = Join-Path $env:USERPROFILE '.claude'

# Encode an absolute path as a Claude Code project directory name (spaces, :, \, /, _, and . become -).
function Get-EncodedProject([string]$p) { $p -replace '[ :\\/_.]', '-' }

Write-Host "Repository: $Repo"

# ── 1) Memory junction ──────────────────────────────────────
$encoded   = Get-EncodedProject $Repo
$projMem   = Join-Path $claude "projects\$encoded\memory"
$repoMem   = Join-Path $Repo 'memory'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $projMem) | Out-Null
New-Item -ItemType Directory -Force -Path $repoMem | Out-Null

if (Test-Path $projMem) {
  $item = Get-Item $projMem -Force
  if ($item.LinkType) {
    cmd /c rmdir "`"$projMem`"" | Out-Null            # Existing link: remove it first.
  } else {
    # Existing real directory: migrate its contents into the repository, then remove it.
    Get-ChildItem $projMem -Force -ErrorAction SilentlyContinue |
      Copy-Item -Destination $repoMem -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $projMem -Recurse -Force
  }
}
cmd /c mklink /J "`"$projMem`"" "`"$repoMem`"" | Out-Null
Write-Host "✓ Memory junction: $projMem -> $repoMem"

# ── 1b) Skill junctions: Claude uses ~/.claude/skills; Codex uses ~/.agents/skills ──
# Both clients point to the same repository copy to prevent version drift.
$skillsSrc = Join-Path $Repo 'skills'
if (Test-Path $skillsSrc) {
  $skillsDsts = @(
    (Join-Path $claude 'skills'),
    (Join-Path $env:USERPROFILE '.agents\skills')
  )
  foreach ($skillsDst in $skillsDsts) {
    New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null
    foreach ($sk in (Get-ChildItem $skillsSrc -Directory)) {
      $link = Join-Path $skillsDst $sk.Name
      if (Test-Path $link) {
        $li = Get-Item $link -Force
        if ($li.LinkType) { cmd /c rmdir "`"$link`"" | Out-Null }
        else { Remove-Item $link -Recurse -Force }   # Replace an existing real directory with the repository version.
      }
      cmd /c mklink /J "`"$link`"" "`"$($sk.FullName)`"" | Out-Null
      Write-Host "✓ Skill junction: $link -> $($sk.FullName)"
    }
  }
  # Remove the legacy session-share junction, renamed to session-memory.
  foreach ($skillsDst in $skillsDsts) {
    $oldLink = Join-Path $skillsDst 'session-share'
    if (Test-Path $oldLink) {
      $li = Get-Item $oldLink -Force
      if ($li.LinkType) { cmd /c rmdir "`"$oldLink`"" | Out-Null; Write-Host "✓ Removed legacy skill junction: session-share" }
    }
  }
}

# ── 2) CLAUDE.md @import ────────────────────────────────────
$userMd     = Join-Path $claude 'CLAUDE.md'
$importLine = "@$RepoFwd/CLAUDE.md"
$mdContent  = if (Test-Path $userMd) { Get-Content $userMd -Raw } else { '' }
if ($mdContent -notlike "*$importLine*") {
  Add-Content -Path $userMd -Value "`n# Cross-device shared memory (installed by claude-session-memory)`n$importLine`n"
  Write-Host "✓ Added import to ~/.claude/CLAUDE.md"
} else {
  Write-Host "• ~/.claude/CLAUDE.md already contains the import; skipped"
}

# ── 3)+4) settings.json merge and hooks ──────────────────────
$settingsPath = Join-Path $claude 'settings.json'
$settings = @{}
if (Test-Path $settingsPath) {
  Copy-Item $settingsPath "$settingsPath.bak" -Force          # Backup.
  $raw = Get-Content $settingsPath -Raw
  if ($raw.Trim()) {
    # PSCustomObject -> hashtable (PowerShell 5.1 has no -AsHashtable)
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

# Merge shared settings without overriding the user's existing keys.
$sharedPath = Join-Path $Repo 'settings\settings.shared.json'
if (Test-Path $sharedPath) {
  $shared = (Get-Content $sharedPath -Raw | ConvertFrom-Json)
  foreach ($p in $shared.PSObject.Properties) {
    if (-not $settings.ContainsKey($p.Name)) { $settings[$p.Name] = $p.Value }
  }
}

# Install hooks idempotently, deduplicating by command string.
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

# Capture is manual via /session-memory save: remove legacy capture hooks while preserving memory-sync hooks.
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
Write-Host "✓ Merged settings.json and installed memory-sync hooks (backup: settings.json.bak)"
Write-Host "• Session capture is manual: Claude uses /session-memory save; Codex uses `$session-memory save (or scripts\session-history\save.ps1)"
Write-Host ""
Write-Host "Done. Start a new Claude Code or Codex session to load the skills."
