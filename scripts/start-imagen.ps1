param(
    [switch]$NoBuild,

    [switch]$Verbose
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$startServiceScript = Join-Path $scriptRoot 'start-service.ps1'
if (-not (Test-Path $startServiceScript)) {
    throw "Cannot find start-service.ps1 at $startServiceScript"
}

$services = @('mcp-imagen-gpu')

$startArgs = @{
    Services     = $services
    NoBuild      = $NoBuild
    IncludeGpu   = $true
    VerboseOutput = $Verbose
}

& $startServiceScript @startArgs
