[CmdletBinding()]
param(
    [string]$EnvFile,
    [string[]]$Service = @(),
    [switch]$AsJson,
    [int]$TimeoutSeconds = 5
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
    $EnvFile = Join-Path -Path $scriptRoot -ChildPath '..\'
    $EnvFile = Join-Path -Path $EnvFile -ChildPath '.env'
    $EnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
}

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
        $value = $parts[1]
        $map[$key] = $value
    }
    return $map
}

function Resolve-ServiceUrl {
    param($Spec, $EnvMap)
    if ($Spec.ContainsKey('EnvVar')) {
        $value = $EnvMap[$Spec.EnvVar]
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }
    return $Spec.Url
}

function Join-ServicePath {
    param([string]$BaseUrl, [string]$Path)
    if (-not $BaseUrl) { return $null }
    if (-not $Path) { return $BaseUrl }
    $cleanBase = $BaseUrl.TrimEnd('/')
    $cleanPath = if ($Path.StartsWith('/')) { $Path } else { '/' + $Path }
    return "$cleanBase$cleanPath"
}

$defaultSpecs = @(
    @{ Name = 'server'; Url = 'http://localhost:3001'; Path = '/health' },
    @{ Name = 'mcp0'; EnvVar = 'MCP0_URL'; Path = '/health' },
    @{ Name = 'meeting'; EnvVar = 'MEETING_MCP_URL'; Path = '/health' },
    @{ Name = 'vms'; EnvVar = 'VMS_MCP_URL'; Path = '/health' },
    @{ Name = 'memento'; EnvVar = 'MEMENTO_MCP_URL'; Path = '/health' },
    @{ Name = 'tuya'; EnvVar = 'TUYA_MCP_URL'; Path = '/health' },
    @{ Name = 'github'; EnvVar = 'GITHUB_MCP_URL'; Path = '/health' },
    @{ Name = 'yolo'; EnvVar = 'YOLO_MCP_URL'; Path = '/' },
    @{ Name = 'imagen'; EnvVar = 'IMAGE_MCP_URL'; Path = '/' },
    @{ Name = 'idp'; EnvVar = 'IDP_MCP_URL'; Path = '/health' },
    @{ Name = 'bslip'; EnvVar = 'BSLIP_MCP_URL'; Path = '/health' }
)

if ($Service.Count -gt 0) {
    $specs = $defaultSpecs | Where-Object { $Service -contains $_.Name }
} else {
    $specs = $defaultSpecs
}

if (-not $specs.Count) {
    Write-Error "No matching services specified."
    exit 1
}

$envMap = Get-EnvMap -Path $EnvFile
$results = @()

foreach ($spec in $specs) {
    $baseUrl = Resolve-ServiceUrl -Spec $spec -EnvMap $envMap
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $results += [pscustomobject]@{
            Service = $spec.Name
            Status = 'unconfigured'
            Detail = "Env var '$($spec.EnvVar)' not set"
            Url = $null
        }
        continue
    }

    $target = Join-ServicePath -BaseUrl $baseUrl -Path $spec.Path
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $target -Method GET -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        $detail = "HTTP {0}" -f $response.StatusCode
        $results += [pscustomobject]@{
            Service = $spec.Name
            Status = if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { 'ok' } else { 'error' }
            Detail = $detail
            Url = $target
        }
    }
    catch {
        $results += [pscustomobject]@{
            Service = $spec.Name
            Status = 'error'
            Detail = $_.Exception.Message
            Url = $target
        }
    }
}

if ($AsJson) {
    $results | ConvertTo-Json -Depth 3
} else {
    $results | Format-Table -AutoSize
}

if ($results | Where-Object { $_.Status -eq 'error' }) {
    exit 1
}
else {
    exit 0
}
