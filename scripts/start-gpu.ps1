$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot 'start-mcp-profile.ps1'
if (-not (Test-Path $helper)) {
    throw "Cannot find start-mcp-profile.ps1 at $helper"
}

& $helper -Action 'up' -Profiles @('internal-gpu')
