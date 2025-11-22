[CmdletBinding()]
param(
    [string]$EnvFile,
    [string[]]$HealthService = @(),
    [string[]]$ToolService = @(),
    [string[]]$ToolFilter = @(),
    [string]$SpecFile,
    [int]$HealthTimeoutSeconds = 5,
    [int]$ToolTimeoutSeconds = 15,
    [switch]$HealthOnly,
    [switch]$ToolsOnly,
    [switch]$AsJson,
    [switch]$StopOnError
)

if ($HealthOnly -and $ToolsOnly) {
    throw 'HealthOnly and ToolsOnly cannot both be specified.'
}

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        $scriptRoot = Get-Location
    }
    else {
        $scriptRoot = Split-Path -Parent $scriptPath
    }
}

if (-not $EnvFile) {
    $envCandidate = Join-Path -Path $scriptRoot -ChildPath '..\'
    $envCandidate = Join-Path -Path $envCandidate -ChildPath '.env'
    if (Test-Path -LiteralPath $envCandidate) {
        $EnvFile = (Resolve-Path -LiteralPath $envCandidate).Path
    }
    else {
        $EnvFile = $envCandidate
    }
}

$healthScript = Join-Path -Path $scriptRoot -ChildPath 'check-mcp-health.ps1'
$toolScript = Join-Path -Path $scriptRoot -ChildPath 'invoke-mcp-tools.ps1'

if (-not (Test-Path -LiteralPath $healthScript)) {
    throw "Health script not found at $healthScript"
}
if (-not (Test-Path -LiteralPath $toolScript)) {
    throw "Tool script not found at $toolScript"
}

function Convert-FilterValues {
    param([string[]]$Values)
    $expanded = @()
    foreach ($value in $Values) {
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $segments = $value -split ','
        foreach ($segment in $segments) {
            $trimmed = $segment.Trim()
            if ($trimmed) {
                $expanded += $trimmed
            }
        }
    }
    return $expanded
}

$HealthService = Convert-FilterValues -Values $HealthService
$ToolService = Convert-FilterValues -Values $ToolService
$ToolFilter = Convert-FilterValues -Values $ToolFilter

function Invoke-HealthChecks {
    param(
        [string]$HealthScript,
        [hashtable]$Arguments
    )
    Write-Host '== MCP Health Checks ==' -ForegroundColor Cyan
    & $HealthScript @Arguments
    return $LASTEXITCODE
}

function Invoke-ToolChecks {
    param(
        [string]$ToolScript,
        [hashtable]$Arguments
    )
    Write-Host '== MCP Tool Invocations ==' -ForegroundColor Cyan
    & $ToolScript @Arguments
    return $LASTEXITCODE
}

$overallExit = 0

if (-not $ToolsOnly) {
    $healthArgs = @{
        TimeoutSeconds = $HealthTimeoutSeconds
    }
    if ($EnvFile) { $healthArgs.EnvFile = $EnvFile }
    if ($HealthService.Count -gt 0) { $healthArgs.Service = $HealthService }
    if ($AsJson) { $healthArgs.AsJson = $true }

    $healthExit = Invoke-HealthChecks -HealthScript $healthScript -Arguments $healthArgs
    if ($healthExit -ne 0) {
        $overallExit = $healthExit
        if ($StopOnError) {
            exit $overallExit
        }
    }
}

if (-not $HealthOnly) {
    $toolArgs = @{
        TimeoutSeconds = $ToolTimeoutSeconds
    }
    if ($EnvFile) { $toolArgs.EnvFile = $EnvFile }
    if ($SpecFile) { $toolArgs.SpecFile = $SpecFile }
    if ($ToolService.Count -gt 0) { $toolArgs.ServiceFilter = $ToolService }
    if ($ToolFilter.Count -gt 0) { $toolArgs.ToolFilter = $ToolFilter }
    if ($AsJson) { $toolArgs.AsJson = $true }
    if ($StopOnError) { $toolArgs.StopOnError = $true }

    $toolExit = Invoke-ToolChecks -ToolScript $toolScript -Arguments $toolArgs
    if ($toolExit -ne 0) {
        $overallExit = $toolExit
    }
}

exit $overallExit
