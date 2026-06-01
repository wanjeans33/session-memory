<#
.SYNOPSIS
  把本机的 Claude Code 会话记录（*.jsonl）复制到仓库的 sessions/windows/ 下作为归档。
  只复制文件，不做 git 操作（由 sync.ps1 负责 commit/push）。
.NOTES
  排除 memory 目录（它是指向仓库的 junction，复制会造成自我嵌套）。
#>
param([string]$Repo)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }

$projects = Join-Path $env:USERPROFILE '.claude\projects'
$dest     = Join-Path $Repo 'sessions\windows'
if (-not (Test-Path $projects)) { return }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Get-ChildItem -Path $projects -Recurse -Filter *.jsonl -File |
  Where-Object { $_.FullName -notmatch '\\memory\\' } |
  ForEach-Object {
    $rel    = $_.FullName.Substring($projects.Length).TrimStart('\')
    $target = Join-Path $dest $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
  }
