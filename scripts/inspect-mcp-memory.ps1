[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$ContainerName = "mcp-memory",
    [int]$LogTail = 200,
    [int]$StreamTimeoutSeconds = 2,
    [string]$ResultsDirectory = "C:\_dev\_models\tony\results",
    [string]$OutputFile
)

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

if (-not (Test-Path -LiteralPath $ResultsDirectory)) {
    New-Item -ItemType Directory -Path $ResultsDirectory -Force | Out-Null
}

if (-not $OutputFile) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutputFile = Join-Path -Path $ResultsDirectory -ChildPath "mcp-memory-$timestamp.log"
}

$outputItem = New-Item -ItemType File -Path $OutputFile -Force
$OutputFile = $outputItem.FullName

function Write-LogLine {
    param([string]$Line = "")
    $text = if ($null -eq $Line) { "" } else { $Line }
    Add-Content -LiteralPath $OutputFile -Value $text
    Write-Host $text
}

function Write-LogObject {
    param($Data)
    if ($null -eq $Data) { return }
    $Data | Out-String -Stream | ForEach-Object { Write-LogLine $_ }
}

function Write-Section {
    param([string]$Title)
    Write-LogLine ""
    Write-LogLine "== $Title =="
}

function Invoke-DotenvDocker {
    param([string[]]$CommandArgs)
    $command = @("dotenv-cli", "-e", $EnvFile, "--") + $CommandArgs
    return & npx @command
}

function Invoke-DockerExecCommand {
    param([string]$ShellCommand)
    $innerArgs = @("docker", "exec", $ContainerName, "bash", "-lc", $ShellCommand)
    return Invoke-DotenvDocker -CommandArgs $innerArgs
}

Write-Section "Container logs (last $LogTail lines)"
$containerLogs = Invoke-DotenvDocker -CommandArgs @("docker", "logs", $ContainerName, "--tail", $LogTail.ToString())
Write-LogObject $containerLogs

Write-Section "mcp-server-memory pids"
$pidScript = @'
for entry in /proc/[0-9]*; do
  if [ -f "$entry/cmdline" ]; then
    cmdline=$(tr '\0' ' ' < "$entry/cmdline")
    case "$cmdline" in
      *mcp-server-memory*)
        basename "$entry"
        ;;
    esac
  fi
done
'@
$pidOutput = Invoke-DockerExecCommand -ShellCommand $pidScript
Write-LogObject $pidOutput

$pidLines = @()
if ($pidOutput) {
    if ($pidOutput -is [array]) {
        $pidLines = $pidOutput
    }
    else {
        $pidLines = @($pidOutput)
    }
}

$pidList = $pidLines | Where-Object { $_ -match '^[0-9]+$' }
if (-not $pidList -or $pidList.Count -eq 0) {
    Write-LogLine "No running mcp-server-memory process found."
    Write-LogLine "Log saved to $OutputFile"
    exit 0
}

foreach ($procId in $pidList) {
    Write-Section "Process details (pid $procId)"
    $processDetails = Invoke-DockerExecCommand -ShellCommand "ps -p $procId -o pid,ppid,stat,etime,cmd"
    Write-LogObject $processDetails

    foreach ($fd in 1, 2) {
        $command = @"
if [ -e /proc/$procId/fd/$fd ]; then
  echo '--- fd$fd (pid $procId) ---'
  timeout ${StreamTimeoutSeconds}s cat /proc/$procId/fd/$fd || true
else
  echo 'fd $fd missing for pid $procId'
fi
"@
        $fdOutput = Invoke-DockerExecCommand -ShellCommand $command
        Write-LogObject $fdOutput
    }
}

Write-LogLine ""
Write-LogLine "Log saved to $OutputFile"
