param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Services,

    [switch]$NoBuild,

    [switch]$IncludeGpu,

    [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repoRoot = Split-Path -Parent $scriptDir

function Resolve-ComposeFiles {
    param(
        [switch]$IncludeGpu
    )

    $files = @()
    $root = $repoRoot

    $main = Join-Path $root 'docker-compose.yml'
    if (-not (Test-Path $main)) {
        throw "Cannot find docker-compose.yml at $main"
    }
    $files += $main

    $optional = Join-Path $root 'docker-compose.optional.yml'
    if (Test-Path $optional) {
        $files += $optional
    }

    if ($IncludeGpu) {
        $gpu = Join-Path $root 'docker-compose.gpu.yml'
        if (Test-Path $gpu) {
            $files += $gpu
        } else {
            Write-Warning "--IncludeGpu requested, but docker-compose.gpu.yml was not found."
        }
    }

    return ,$files
}

$composeFiles = Resolve-ComposeFiles -IncludeGpu:$IncludeGpu

$composeArgs = @()
foreach ($file in $composeFiles) {
    $composeArgs += @('-f', $file)
}
$composeArgs += 'up'
$composeArgs += '-d'
if (-not $NoBuild) {
    $composeArgs += '--build'
}
$composeArgs += '--remove-orphans'
$composeArgs += '--'
$composeArgs += $Services

$exe = 'docker'
$fullArgs = @('compose') + $composeArgs

if ($VerboseOutput) {
    Write-Host "Running:`n$exe $($fullArgs -join ' ')" -ForegroundColor Cyan
}

Push-Location $repoRoot
try {
    & $exe @fullArgs
    $exit = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($exit -ne 0) {
    throw "docker compose exited with code $exit"
}
