#Requires -Version 5.0
<#
.SYNOPSIS
  Back up / restore Claude Code session history to a private git repo.
.EXAMPLE
  sync.ps1 setup   -Remote https://github.com/you/claude-session-backup.git
  sync.ps1 backup
  sync.ps1 restore            # additive (never clobbers local)
  sync.ps1 restore -Force     # overwrite local with repo version
  sync.ps1 status
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'backup', 'restore', 'status')]
    [string]$Action = 'status',
    [string]$Remote,
    [switch]$IncludeToolResults,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$ProjectsDir  = Join-Path $ClaudeDir 'projects'
$RepoDir      = Join-Path $ClaudeDir 'session-backup'
$RepoProjects = Join-Path $RepoDir 'projects'
$ThisHost     = $env:COMPUTERNAME

function Test-Repo { Test-Path (Join-Path $RepoDir '.git') }

function Invoke-GitChecked([string[]]$GitArgs) {
    & git -C $RepoDir @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

function Invoke-GitQuiet([string[]]$GitArgs) {
    # Best-effort git (e.g. pull before an upstream exists); never fatal.
    & git -C $RepoDir @GitArgs 2>&1 | Out-Null
    $global:LASTEXITCODE = 0
}

function Copy-Tree([string]$Src, [string]$Dst, [string[]]$Extra) {
    if (-not (Test-Path $Src)) { return }
    New-Item -ItemType Directory -Force -Path $Dst | Out-Null
    $args = @($Src, $Dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    if (-not $IncludeToolResults) { $args += @('/XD', 'tool-results') }
    $args += @('/XF', '*.jpg', '*.jpeg', '*.png', '*.gif', '*.pdf', '*.webp')
    $args += $Extra
    robocopy @args | Out-Null
    $code = $LASTEXITCODE
    $global:LASTEXITCODE = 0
    if ($code -ge 8) { throw "robocopy '$Src' -> '$Dst' failed (exit $code)" }
}

switch ($Action) {

    'setup' {
        if (Test-Repo) {
            Write-Host "Already set up at $RepoDir"
            & git -C $RepoDir remote -v
            break
        }
        if (-not $Remote) {
            throw "First-time setup needs -Remote <git-url>. Create an EMPTY private GitHub repo first, then pass its clone URL."
        }
        if (Test-Path $RepoDir) {
            throw "$RepoDir exists but is not a git repo. Remove or rename it, then retry."
        }
        & git clone $Remote $RepoDir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }

        Set-Content -Path (Join-Path $RepoDir '.gitattributes') -Value '* -text' -Encoding ascii
        New-Item -ItemType Directory -Force -Path $RepoProjects | Out-Null
        Set-Content -Path (Join-Path $RepoProjects '.gitkeep') -Value '' -Encoding ascii
        $readme = Join-Path $RepoDir 'README.md'
        if (-not (Test-Path $readme)) {
            Set-Content -Path $readme -Encoding utf8 -Value "# Claude Code session backup`n`nManaged by the session-sync skill. Holds transcripts + memory from ~/.claude/projects."
        }
        Invoke-GitChecked @('add', '-A')
        & git -C $RepoDir diff --cached --quiet
        if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0; Invoke-GitChecked @('commit', '-m', "init session-backup from $ThisHost") }
        $global:LASTEXITCODE = 0
        Invoke-GitChecked @('push', '-u', 'origin', 'HEAD')
        Write-Host "Setup complete: $RepoDir -> $Remote"
    }

    'backup' {
        if (-not (Test-Repo)) { throw "Not set up. Run: sync.ps1 setup -Remote <git-url>" }
        Invoke-GitQuiet @('pull', '--no-edit')
        Copy-Tree $ProjectsDir $RepoProjects @()
        Invoke-GitChecked @('add', '-A')
        & git -C $RepoDir diff --cached --quiet
        if ($LASTEXITCODE -eq 0) { $global:LASTEXITCODE = 0; Write-Host 'No changes to back up.'; break }
        $global:LASTEXITCODE = 0
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Invoke-GitChecked @('commit', '-m', "backup from $ThisHost at $stamp")
        & git -C $RepoDir push
        if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0; Invoke-GitQuiet @('pull', '--no-edit'); Invoke-GitChecked @('push') }
        $global:LASTEXITCODE = 0
        Write-Host 'Backed up to remote.'
    }

    'restore' {
        if (-not (Test-Repo)) { throw "Not set up. Run setup first." }
        Invoke-GitQuiet @('pull', '--no-edit')
        $extra = if ($Force) { @() } else { @('/XO', '/XN', '/XC') }  # additive-only unless -Force
        Copy-Tree $RepoProjects $ProjectsDir $extra
        Write-Host "Restore complete (Force=$Force)."
    }

    'status' {
        Write-Host "Claude dir : $ClaudeDir"
        Write-Host "Backup repo: $RepoDir"
        if (Test-Repo) {
            & git -C $RepoDir remote get-url origin
            & git -C $RepoDir log -1 --format='last commit: %h %ci (%an)'
            $n = (Get-ChildItem $RepoProjects -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue | Measure-Object).Count
            Write-Host "transcripts in repo: $n"
        }
        else {
            Write-Host 'Not set up yet. Run: sync.ps1 setup -Remote <git-url>'
        }
        $global:LASTEXITCODE = 0
    }
}
