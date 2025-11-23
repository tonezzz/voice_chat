param(
    [ValidateSet("up", "down", "restart")]
    [string]$Action = "up",

    [string[]]$Profiles = @("internal-cpu"),

    [string[]]$Services = @(),

    [switch]$NoBuild,

    [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'

if (-not $Profiles -or $Profiles.Count -eq 0) {
    $Profiles = @("internal-cpu")
}

$repoRoot = Split-Path -Parent $PSScriptRoot

$composeArgs = @()
foreach ($mcpProfile in $Profiles) {
    if ([string]::IsNullOrWhiteSpace($mcpProfile)) {
        continue
    }
    $composeArgs += "--profile"
    $composeArgs += $mcpProfile.Trim()
}

switch ($Action) {
    'up' {
        $composeArgs += @('up', '-d')
        if (-not $NoBuild) {
            $composeArgs += '--build'
        }
        $composeArgs += '--remove-orphans'
    }
    'down' {
        $composeArgs += 'down'
        $composeArgs += '--remove-orphans'
    }
    'restart' {
        $composeArgs += 'restart'
    }
}
if ($Services -and $Services.Count -gt 0) {
    foreach ($svc in $Services) {
        if ([string]::IsNullOrWhiteSpace($svc)) {
            continue
        }
        $composeArgs += $svc.Trim()
    }
}

$composeCommand = "npx dotenv-cli -e .env -- docker compose " + ($composeArgs -join ' ')
$cdPart = "cd /d `"$repoRoot`""
$fullCommand = "$cdPart && $composeCommand"

if ($VerboseOutput) {
    Write-Host "Running: cmd /c \"$fullCommand\"" -ForegroundColor Cyan
}

$process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $fullCommand -NoNewWindow -PassThru
$process.WaitForExit()
$exitCode = $process.ExitCode
if ($null -eq $exitCode) {
    $exitCode = 0
}
if ($exitCode -ne 0) {
    throw "docker compose exited with code $exitCode"
}
