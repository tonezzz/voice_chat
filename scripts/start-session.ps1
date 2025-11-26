param(
    [string]$Workspace = "c:\_dev\windsurf_ai\voice_chat",
    [switch]$SkipCompose,
    [switch]$SkipPolicy
)

$ErrorActionPreference = 'Stop'

function Invoke-CommandWithDotenv {
    param(
        [Parameter(Mandatory = $true)][string]$WorkspacePath,
        [Parameter(Mandatory = $true)][string]$Command
    )

    $fullCommand = "cd /d $WorkspacePath && npx dotenv-cli -e .env -- $Command"
    Write-Host "[start-session] running: cmd /c $fullCommand" -ForegroundColor Cyan
    $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $fullCommand -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Command failed with exit code $($process.ExitCode)"
    }
}

Write-Host "=== Cascade start-session ===" -ForegroundColor Green
Write-Host "Workspace: $Workspace" -ForegroundColor Green

if (-not $SkipPolicy) {
    $policyPath = "c:\_dev\_models\tony\ws_policy\no_interrup.txt"
    if (Test-Path $policyPath) {
        Write-Host "\n--- Shared Workflow (no_interrup.txt) ---" -ForegroundColor Yellow
        Get-Content $policyPath | Write-Host
        Write-Host "--- end ---\n" -ForegroundColor Yellow
    } else {
        Write-Warning "no_interrup.txt not found at $policyPath"
    }
} else {
    Write-Host "[start-session] Skipping policy display per flag."
}

try {
    docker info | Out-Null
} catch {
    throw "Docker does not appear to be running. Please start Docker Desktop and retry."
}

if (-not $SkipCompose) {
    Invoke-CommandWithDotenv -WorkspacePath $Workspace -Command "docker compose up -d server redis"
} else {
    Write-Host "[start-session] Skipping docker compose start per flag."
}

Write-Host "\n--- Service status ---" -ForegroundColor Yellow
cmd /c "docker ps --filter name=voice-chat-server --filter name=voice-chat-redis"

Write-Host "\nSession bootstrap complete. Happy hacking!" -ForegroundColor Green
