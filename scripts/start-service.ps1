param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Services,

    [switch]$NoBuild,

    [switch]$IncludeGpu,

    [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'

function Resolve-ComposeFiles {
    param(
        [switch]$IncludeGpu
    )

    $files = @()
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    $root = Split-Path -Parent $root

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

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.ArgumentList.Add('compose')
foreach ($arg in $composeArgs) {
    $psi.ArgumentList.Add($arg)
}
$psi.WorkingDirectory = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false
$psi.UseShellExecute = $false

$process = [System.Diagnostics.Process]::Start($psi)
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
    throw "docker compose exited with code $($process.ExitCode)"
}
