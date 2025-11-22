[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$SpecFile,
    [string[]]$ServiceFilter = @(),
    [string[]]$ToolFilter = @(),
    [int]$TimeoutSeconds = 15,
    [switch]$AsJson,
    [switch]$StopOnError
)

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        $scriptRoot = Get-Location
    } else {
        $scriptRoot = Split-Path -Parent $scriptPath
    }
}

if (-not $EnvFile) {
    $envCandidate = Join-Path -Path $scriptRoot -ChildPath '..\'
    $envCandidate = Join-Path -Path $envCandidate -ChildPath '.env'
    if (Test-Path -LiteralPath $envCandidate) {
        $EnvFile = (Resolve-Path -LiteralPath $envCandidate).Path
    } else {
        $EnvFile = $envCandidate
    }
}

if (-not $SpecFile) {
    $SpecFile = Join-Path -Path $scriptRoot -ChildPath 'mcp-tool-tests.json'
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

$ServiceFilter = Convert-FilterValues -Values $ServiceFilter
$ToolFilter = Convert-FilterValues -Values $ToolFilter

function Get-EnvMap {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) {
        return $map
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line.TrimStart().StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -lt 2) { continue }
        $key = $parts[0].Trim()
        if (-not $key) { continue }
        $map[$key] = $parts[1]
    }
    return $map
}

function Join-ServicePath {
    param([string]$BaseUrl, [string]$Path)
    if (-not $BaseUrl) { return $null }
    if (-not $Path) { return $BaseUrl }
    $cleanBase = $BaseUrl.TrimEnd('/')
    $cleanPath = if ($Path.StartsWith('/')) { $Path } else { '/' + $Path }
    return "$cleanBase$cleanPath"
}

if (-not (Test-Path $SpecFile)) {
    Write-Error "Spec file '$SpecFile' not found."
    exit 1
}

$tests = Get-Content -LiteralPath $SpecFile | ConvertFrom-Json
if ($ServiceFilter.Count -gt 0) {
    $tests = $tests | Where-Object {
        $serviceName = $_.service
        if ([string]::IsNullOrWhiteSpace($serviceName)) {
            $serviceName = $_.name
        }
        $ServiceFilter -contains $serviceName
    }
}
if ($ToolFilter.Count -gt 0) {
    $tests = $tests | Where-Object {
        $toolName = $_.tool
        if ([string]::IsNullOrWhiteSpace($toolName)) {
            return $false
        }
        $ToolFilter -contains $toolName
    }
}
if (-not $tests) {
    Write-Error "Spec file '$SpecFile' does not contain any test definitions."
    exit 1
}

$envMap = Get-EnvMap -Path $EnvFile
$results = @()

foreach ($test in $tests) {
    $name = $test.name
    $envVar = $test.envVar
    $path = $test.path
    $tool = $test.tool
    $arguments = $test.arguments

    $baseUrl = $null
    if ($envVar) {
        $baseUrl = [System.Environment]::GetEnvironmentVariable($envVar)
        if ([string]::IsNullOrWhiteSpace($baseUrl)) {
            $baseUrl = $envMap[$envVar]
        }
    }
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $results += [pscustomobject]@{
            Test = $name
            Tool = $tool
            Status = 'unconfigured'
            Detail = "Env var '$envVar' not set"
            Url = $null
        }
        if ($StopOnError) { break }
        continue
    }

    $target = Join-ServicePath -BaseUrl $baseUrl -Path $path
    $body = @{ tool = $tool; arguments = $arguments } | ConvertTo-Json -Depth 10

    try {
        $response = Invoke-RestMethod -UseBasicParsing -Uri $target -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSeconds
        $results += [pscustomobject]@{
            Test = $name
            Tool = $tool
            Status = 'ok'
            Detail = ($response | ConvertTo-Json -Depth 5)
            Url = $target
        }
    }
    catch {
        $results += [pscustomobject]@{
            Test = $name
            Tool = $tool
            Status = 'error'
            Detail = $_.Exception.Message
            Url = $target
        }
        if ($StopOnError) { break }
    }
}

if ($AsJson) {
    $results | ConvertTo-Json -Depth 5
} else {
    $results | Format-Table -AutoSize
}

if ($results | Where-Object { $_.Status -eq 'error' -or $_.Status -eq 'unconfigured' }) {
    exit 1
}
else {
    exit 0
}
