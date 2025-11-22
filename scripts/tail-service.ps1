param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Services,

    [switch]$IncludeGpu,

    [switch]$SinceStart
)

$ErrorActionPreference = 'Stop'

function Get-ComposeArguments {
    param(
        [switch]$IncludeGpu,
        [string]$Command,
        [string[]]$CommandArgs
    )

    $root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    $composeFiles = @(
        Join-Path $root 'docker-compose.yml'
    )
    $optional = Join-Path $root 'docker-compose.optional.yml'
    if (Test-Path $optional) {
        $composeFiles += $optional
    }
    if ($IncludeGpu) {
        $gpu = Join-Path $root 'docker-compose.gpu.yml'
        if (Test-Path $gpu) {
            $composeFiles += $gpu
        } else {
            Write-Warning "docker-compose.gpu.yml not found"
        }
    }

    $composeArgs = @()
    foreach ($file in $composeFiles) {
        $composeArgs += @('-f', $file)
    }
    $composeArgs += $Command
    $composeArgs += $CommandArgs
    return @($root, $composeArgs)
}

$logArgs = @('logs')
if (-not $SinceStart) {
    $logArgs += '--since'
    $logArgs += '10m'
}
$logArgs += '-f'
$logArgs += '--'
$logArgs += $Services

$rootAndArgs = Get-ComposeArguments -IncludeGpu:$IncludeGpu -Command 'logs' -CommandArgs $logArgs[1..($logArgs.Count - 1)]
$root = $rootAndArgs[0]
$composeArgs = $rootAndArgs[1]

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'docker'
$psi.WorkingDirectory = $root
$psi.ArgumentList.Add('compose')
foreach ($arg in $composeArgs) {
    $psi.ArgumentList.Add($arg)
}
$psi.UseShellExecute = $false

[System.Diagnostics.Process]::Start($psi)
