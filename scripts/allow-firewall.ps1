# Liminn — dev-time Windows Firewall allowance.
#
# Run once on a Windows machine where `npm run electron:dev` / `npm start`
# is used. Production installs get the rule via build/installer.nsh; this
# script is for dev builds that don't go through NSIS.
#
# Usage (elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
# or right-click → Run as administrator.
#
# Removes any prior rule with the same name so repeated runs don't pile
# up duplicates pointing at stale electron.exe paths across node_modules
# reinstalls.

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "This script must run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell and choose 'Run as administrator', then rerun." -ForegroundColor Yellow
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $repoRoot "node_modules\electron\dist\electron.exe"

if (-not (Test-Path $electronExe)) {
    Write-Host "Could not find electron.exe at:" -ForegroundColor Red
    Write-Host "  $electronExe"
    Write-Host "Run 'npm install' first, then rerun this script." -ForegroundColor Yellow
    exit 1
}

$ruleName = "Liminn Dev"

Write-Host "Removing any existing '$ruleName' rule..."
netsh advfirewall firewall delete rule name="$ruleName" 2>&1 | Out-Null

Write-Host "Adding inbound allow rule for $electronExe..."
$addResult = netsh advfirewall firewall add rule `
    name="$ruleName" `
    dir=in `
    action=allow `
    program="$electronExe" `
    enable=yes `
    profile=any `
    edgetraversal=yes

if ($LASTEXITCODE -ne 0) {
    Write-Host "netsh failed:" -ForegroundColor Red
    Write-Host $addResult
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Done. '$ruleName' now allows inbound connections to Liminn in dev mode." -ForegroundColor Green
Write-Host "Production installs (.exe from the installer) get a separate 'Liminn' rule automatically."
