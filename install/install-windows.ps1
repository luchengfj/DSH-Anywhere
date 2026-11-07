#Requires -Version 5.1
<#
.SYNOPSIS
    DSH Anywhere - Windows installer (relay + host adapter).
.DESCRIPTION
    Zero third-party dependencies. Operates on an EXISTING checkout of this
    repository: it writes start scripts + config under the state dir
    (default: $env:USERPROFILE\.dsh-anywhere = "~/.dsh-anywhere"), and can
    register an at-logon Scheduled Task or a Startup-folder launcher for the
    relay. No elevation is required for the current user's own task.

    Run:  powershell -ExecutionPolicy Bypass -File install\install-windows.ps1
    Help: powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Help
.EXAMPLE
    .\install\install-windows.ps1 -Mode All -Task
.EXAMPLE
    .\install\install-windows.ps1 -Mode Host -StateHome D:\dsh-anywhere-state
#>
[CmdletBinding()]
param(
    [ValidateSet('All','Relay','Host')] [string] $Mode = 'All',
    [switch] $RelayOnly,           # alias for -Mode Relay
    [switch] $HostOnly,            # alias for -Mode Host
    [switch] $Task,                # register an at-logon Scheduled Task for the relay
    [switch] $Startup,             # put a launcher .cmd into the Startup folder
    [switch] $NoTask,              # explicitly skip task/startup
    [string] $Src,                 # path to the checkout (default: parent of this script)
    [string] $StateHome,           # state dir (default: $env:USERPROFILE\.dsh-anywhere)
    [int]    $RelayPort = 8787,
    [string] $BindAddr = '0.0.0.0',
    [switch] $Help
)

$ErrorActionPreference = 'Stop'

function Write-Say   { param([string]$m) Write-Host $m }
function Write-Warn2 { param([string]$m) Write-Warning $m }
function Die         { param([string]$m) Write-Error $m; exit 1 }

if ($Help) {
    Write-Host @'
DSH Anywhere - Windows installer

Usage: powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 [options]

  -Mode All|Relay|Host   what to configure (default: All = relay + host)
  -RelayOnly             shortcut for -Mode Relay
  -HostOnly              shortcut for -Mode Host
  -Task                  register an at-logon Scheduled Task for the relay (no admin needed)
  -Startup               add a launcher .cmd to the current user's Startup folder
  -Src DIR               checkout path (default: parent of this script)
  -StateHome DIR         state dir (default: %USERPROFILE%\.dsh-anywhere)
  -RelayPort N           relay port baked into start scripts (default 8787)
  -BindAddr ADDR         relay bind address (default 0.0.0.0; 127.0.0.1 behind a proxy)
  -Help                  this text

No npm install is needed: the project has zero third-party npm dependencies.
Edit the generated host-config.ps1 to point the host adapter at a remote relay.
'@
    exit 0
}

if ($RelayOnly) { $Mode = 'Relay' }
if ($HostOnly)  { $Mode = 'Host' }
$NeedHost  = ($Mode -ne 'Relay')
$NeedRelay = ($Mode -ne 'Host')
if ($NoTask) { $Task = $false; $Startup = $false }
if (($Task -or $Startup) -and -not $NeedRelay) {
    Write-Warn2 "-Task/-Startup apply to the relay; ignored because mode is Host."
    $Task = $false; $Startup = $false
}

# ------------------------------------------------------------------ node ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Die "node not found in PATH. Install Node.js >= 22 (see install/README.md)." }
$NodeExe = $nodeCmd.Source
$nodeVer = (& $NodeExe --version 2>$null)
if (-not $nodeVer) { Die "cannot run: node --version" }
$nodeMajor = 0
if ($nodeVer -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 22) { Die "Node.js >= 22 is required, found $nodeVer. Upgrade node." }
Write-Say ("node:     {0} ({1})" -f $nodeVer, $NodeExe)
if ($nodeMajor -ge 23) {
    Write-Say "zstd:     built-in zlib.zstdDecompressSync (no system zstd needed)"
} else {
    $z = Get-Command zstd -ErrorAction SilentlyContinue
    if ($z) { Write-Say ("zstd:     {0} (CLI fallback OK)" -f $z.Source) }
    else {
        Write-Warn2 "Node $nodeVer has no built-in zstd decoder: install the zstd CLI."
        Write-Warn2 "  winget install --id facebook.zstd   (or: choco install zstd)"
        Write-Warn2 "  Without it the host adapter cannot decode ~/.dsh/sessions/*.jsonl.zstd"
    }
}

# ------------------------------------------------------------------ source ---
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { Die "cannot determine script directory; pass -Src explicitly." }
$defaultSrc = Split-Path -Parent $scriptDir
if ($Src)                      { $SrcDir = $Src }
elseif ($env:DSH_ANYWHERE_SRC) { $SrcDir = $env:DSH_ANYWHERE_SRC }
else                           { $SrcDir = $defaultSrc }
try { $SrcDir = (Resolve-Path -LiteralPath $SrcDir).Path } catch { Die "source dir not found: $SrcDir (pass -Src)" }
Write-Say ("source:   {0}" -f $SrcDir)
if ($NeedRelay) {
    if (-not (Test-Path -LiteralPath (Join-Path $SrcDir 'relay\server.mjs'))) {
        Die "relay\server.mjs missing in $SrcDir (pass -Src <checkout>)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $SrcDir 'phone'))) {
        Write-Warn2 "phone\ missing: relay will have no PWA to serve until it exists."
    }
}
if ($NeedHost) {
    if (-not (Test-Path -LiteralPath (Join-Path $SrcDir 'host\cli.mjs'))) {
        Die "host\cli.mjs missing in $SrcDir (pass -Src <checkout>)"
    }
}

# -------------------------------------------------------------- state dir ---
if ($StateHome)                 { $StateDir = $StateHome }
elseif ($env:DSH_ANYWHERE_HOME) { $StateDir = $env:DSH_ANYWHERE_HOME }
else                            { $StateDir = Join-Path $env:USERPROFILE '.dsh-anywhere' }
try { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
catch { Die "cannot create state dir: $StateDir" }
Write-Say ("state:    {0}" -f $StateDir)

# Templates use @@TOKEN@@ placeholders; the single-quoted here-strings keep
# every $ literal so the generated scripts own their own variables.
function Expand-Tpl {
    param([string]$t)
    $t = $t.Replace('@@SRC@@',  $SrcDir)
    $t = $t.Replace('@@HOME@@', $StateDir)
    $t = $t.Replace('@@NODE@@', $NodeExe)
    $t = $t.Replace('@@PORT@@', [string]$RelayPort)
    $t = $t.Replace('@@BIND@@', $BindAddr)
    return $t
}

$relayTpl = @'
# DSH Anywhere relay - generated by install-windows.ps1 (re-run to refresh).
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '@@SRC@@'
if (-not $env:DSH_ANYWHERE_HOME) { $env:DSH_ANYWHERE_HOME = '@@HOME@@' }
if (-not $env:PORT) { $env:PORT = '@@PORT@@' }
if (-not $env:HOST) { $env:HOST = '@@BIND@@' }
Write-Host 'DSH Anywhere relay starting...' -ForegroundColor Cyan
Write-Host ('  home : ' + $env:DSH_ANYWHERE_HOME) -ForegroundColor DarkGray
Write-Host ('  url  : http://127.0.0.1:' + $env:PORT + '/') -ForegroundColor DarkGray
Write-Host ('  code : ' + (Join-Path $env:DSH_ANYWHERE_HOME 'pair-code.txt')) -ForegroundColor DarkGray
& '@@NODE@@' 'relay/server.mjs'
'@

$hostTpl = @'
# DSH Anywhere host adapter - generated by install-windows.ps1.
# Config: @@HOME@@\host-config.ps1  (dot-sourced below; edit it, keep it private)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '@@SRC@@'
if (-not $env:DSH_ANYWHERE_HOME) { $env:DSH_ANYWHERE_HOME = '@@HOME@@' }
$cfg = Join-Path $env:DSH_ANYWHERE_HOME 'host-config.ps1'
if (Test-Path -LiteralPath $cfg) { . $cfg }
# On a box that also runs the relay, reuse its auto-generated secret.
if (-not $env:DSH_ANYWHERE_TOKEN) {
    $secretPath = Join-Path $env:DSH_ANYWHERE_HOME 'secret'
    if (Test-Path -LiteralPath $secretPath) {
        $env:DSH_ANYWHERE_TOKEN = (Get-Content -LiteralPath $secretPath -Raw).Trim()
    }
}
if (-not $env:DSH_ANYWHERE_RELAY) { throw "DSH_ANYWHERE_RELAY is empty. Edit $cfg" }
if (-not $env:DSH_ANYWHERE_TOKEN) { throw "DSH_ANYWHERE_TOKEN is empty. Copy the relay secret into $cfg" }
Write-Host ('DSH Anywhere host -> ' + $env:DSH_ANYWHERE_RELAY) -ForegroundColor Cyan
& '@@NODE@@' 'host/cli.mjs'
'@

$configTpl = @'
# DSH Anywhere host adapter config - dot-sourced by host-start.ps1.
# Keep this file and the token private. PowerShell syntax: $env:VAR = 'value'
#
# 1) Full base URL of the relay (http:// or https://, no trailing slash):
$env:DSH_ANYWHERE_RELAY = 'http://127.0.0.1:8787'
#
# 2) The SAME token the relay uses. On the relay box:
#      type %USERPROFILE%\.dsh-anywhere\secret
#    Paste its exact contents here. If the relay runs on THIS box you may
#    leave it empty: host-start.ps1 reads the secret automatically.
$env:DSH_ANYWHERE_TOKEN = ''
#
# 3) Optional overrides:
# $env:DSH_ANYWHERE_HOST_NAME = 'win-study'
# $env:DSH_ANYWHERE_HOST_ID   = ''      # empty = persisted random stable id
# $env:DSH_HOME               = "$env:USERPROFILE\.dsh"
'@

$relayPath  = Join-Path $StateDir 'relay-start.ps1'
$hostPath   = Join-Path $StateDir 'host-start.ps1'
$configPath = Join-Path $StateDir 'host-config.ps1'

if ($NeedRelay) {
    Set-Content -LiteralPath $relayPath -Value (Expand-Tpl $relayTpl) -Encoding UTF8
    Write-Say ("wrote:    {0}" -f $relayPath)
}
if ($NeedHost) {
    Set-Content -LiteralPath $hostPath -Value (Expand-Tpl $hostTpl) -Encoding UTF8
    Write-Say ("wrote:    {0}" -f $hostPath)
    if (-not (Test-Path -LiteralPath $configPath)) {
        Set-Content -LiteralPath $configPath -Value (Expand-Tpl $configTpl) -Encoding UTF8
        Write-Say ("wrote:    {0}  <-- EDIT THIS before a remote host" -f $configPath)
    } else {
        Write-Say ("kept:     {0} (already exists)" -f $configPath)
    }
}

# ------------------------------------------------- Scheduled Task / Startup ---
$psExe   = (Get-Command powershell.exe).Source
$taskArg = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $relayPath)

if ($Task) {
    try {
        $act = New-ScheduledTaskAction -Execute $psExe -Argument $taskArg -WorkingDirectory $SrcDir
        $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $desc = 'DSH Anywhere relay (REST + SSE + hosted phone PWA). Created by install-windows.ps1.'
        Register-ScheduledTask -TaskName 'DSH Anywhere Relay' -Action $act -Trigger $trg -Description $desc -Force | Out-Null
        Write-Say 'task:     registered "DSH Anywhere Relay" (runs at logon)'
        Write-Say '          start now: Start-ScheduledTask -TaskName "DSH Anywhere Relay"'
    } catch {
        Write-Warn2 ("could not register Scheduled Task: {0}" -f $_.Exception.Message)
        Write-Warn2 "Use -Startup instead (Startup-folder launcher needs no admin), or run relay-start.ps1 manually."
    }
}

if ($Startup) {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $launcher = Join-Path $startupDir 'dsh-anywhere-relay.cmd'
    $launcherBody = @"
@echo off
rem Generated by install-windows.ps1 - launches the DSH Anywhere relay at logon.
start "" /min "$psExe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$relayPath"
"@
    try {
        Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding ASCII
        Write-Say ("startup:  {0}" -f $launcher)
    } catch {
        Write-Warn2 ("could not write Startup launcher: {0}" -f $_.Exception.Message)
    }
}

# ------------------------------------------------------------------ summary ---
Write-Host ''
Write-Say '== DSH Anywhere install complete =='
Write-Say ("  mode  : {0}" -f $Mode)
Write-Say ("  source: {0}" -f $SrcDir)
Write-Say ("  state : {0}" -f $StateDir)
Write-Host ''
Write-Say 'Manual launch (from any PowerShell, no task needed):'
if ($NeedRelay) { Write-Say ("  relay : powershell -ExecutionPolicy Bypass -File {0}" -f $relayPath) }
if ($NeedHost)  { Write-Say ("  host  : edit {0}, then  powershell -ExecutionPolicy Bypass -File {1}" -f $configPath, $hostPath) }
Write-Host ''
Write-Say ("Phone PWA    : http://<relay-host>:{0}/" -f $RelayPort)
Write-Say ("Pairing code : type {0}" -f (Join-Path $StateDir 'pair-code.txt'))
Write-Say ("Token        : type {0}  (same value in host-config.ps1)" -f (Join-Path $StateDir 'secret'))
Write-Host ''
Write-Say 'Security: keep the token and pairing code private; do not expose the relay'
Write-Say '          on the public internet without TLS (Tailscale / HTTPS proxy).'
