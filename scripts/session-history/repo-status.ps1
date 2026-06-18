<#
.SYNOPSIS
  枚举仓库的分支 / worktree 状态，写入 <project>/session-history/index.json。
  供 session-share 技能把 digests 按分支挂载、生成 Project Status。
.PARAMETER Repo
  仓库内任意路径；默认当前目录。最终写到主工作树根。
#>
param([string]$Repo)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = (Get-Location).Path }

$commonDir = (& git -C $Repo rev-parse --path-format=absolute --git-common-dir 2>$null | Select-Object -First 1)
if (-not $commonDir) { Write-Error "not a git repo: $Repo"; exit 1 }
$mainRoot = (Split-Path -Parent $commonDir.Trim())
$mainRootFwd = ($mainRoot -replace '\\','/').TrimEnd('/')

# 默认分支（main / master）
$defaultBranch = 'main'
$hb = (& git -C $Repo rev-parse --verify -q refs/heads/main 2>$null)
if (-not $hb) { if (& git -C $Repo rev-parse --verify -q refs/heads/master 2>$null) { $defaultBranch = 'master' } }

# ── worktrees（--porcelain 块解析）──────────────────────────────
$worktrees = @()
$wtRaw = (& git -C $Repo worktree list --porcelain 2>$null)
$cur = $null
foreach ($line in $wtRaw) {
  if ($line -like 'worktree *') {
    if ($cur) { $worktrees += $cur }
    $p = ($line.Substring(9) -replace '\\','/').TrimEnd('/')
    if ($p -eq $mainRootFwd) { $rel = '.' }
    elseif ($p.ToLower().StartsWith(($mainRootFwd.ToLower() + '/'))) { $rel = $p.Substring($mainRootFwd.Length).TrimStart('/') }
    else { $rel = $p }
    $cur = [ordered]@{ path=$rel; branch=$null; head=$null; detached=$false; locked=$false }
  } elseif ($line -like 'HEAD *') { if ($cur) { $cur.head = $line.Substring(5).Substring(0,7) } }
  elseif ($line -like 'branch *') { if ($cur) { $cur.branch = ($line.Substring(7) -replace '^refs/heads/','') } }
  elseif ($line -eq 'detached') { if ($cur) { $cur.detached = $true } }
  elseif ($line -like 'locked*') { if ($cur) { $cur.locked = $true } }
}
if ($cur) { $worktrees += $cur }

# ── branches（含 ahead/behind vs 默认分支、最近提交）─────────────
$branches = @()
$refs = (& git -C $Repo for-each-ref --format='%(refname:short)|%(objectname:short)|%(committerdate:iso-strict)|%(authorname)' refs/heads 2>$null)
foreach ($r in $refs) {
  $parts = $r -split '\|', 4
  $name = $parts[0]
  $ahead = 0; $behind = 0
  if ($name -ne $defaultBranch) {
    $lr = (& git -C $Repo rev-list --left-right --count "$defaultBranch...$name" 2>$null)
    if ($lr) { $nums = $lr -split '\s+'; if ($nums.Count -ge 2) { $behind=[int]$nums[0]; $ahead=[int]$nums[1] } }
  }
  $branches += [ordered]@{ name=$name; head=$parts[1]; last_commit=$parts[2]; last_author=$parts[3]; ahead=$ahead; behind=$behind }
}

$index = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  repo = (Split-Path -Leaf $mainRoot)
  default_branch = $defaultBranch
  head = (& git -C $Repo rev-parse --short HEAD 2>$null | Select-Object -First 1).Trim()
  worktrees = $worktrees
  branches = $branches
}

$histDir = Join-Path $mainRoot 'session-history'
New-Item -ItemType Directory -Force -Path $histDir | Out-Null
$outPath = Join-Path $histDir 'index.json'
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($outPath, ($index | ConvertTo-Json -Depth 8), $utf8)
Write-Output $outPath
