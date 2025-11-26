[CmdletBinding()]
param(
    [string]$EndpointUri = 'http://localhost:8200/invoke',
    [ValidateSet('tools.invoke', 'tools/call')]
    [string]$RpcMethod = 'tools/call',
    [string]$ToolName = 'list_models',
    [hashtable]$ToolArguments = @{},
    [hashtable]$Headers = @{},
    [int]$TimeoutSeconds = 30,
    [string]$ResultsDirectory = 'C:\_dev\_models\tony\debugging',
    [string]$OutputFile,
    [switch]$Quiet
)

function Ensure-Directory {
    param([string]$Path)
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

Ensure-Directory -Path $ResultsDirectory

if (-not $OutputFile) {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputFile = Join-Path -Path $ResultsDirectory -ChildPath "github-mcp-invoke-$timestamp.log"
}

$outputItem = New-Item -ItemType File -Path $OutputFile -Force
$OutputFile = $outputItem.FullName

function Write-LogLine {
    param([string]$Line = '')
    $text = if ($null -eq $Line) { '' } else { $Line }
    Add-Content -LiteralPath $OutputFile -Value $text
    if (-not $Quiet) {
        Write-Host $text
    }
}

function Write-Section {
    param([string]$Title)
    Write-LogLine ''
    Write-LogLine "== $Title =="
}

if (-not $Headers) {
    $Headers = @{}
}
if (-not $Headers.ContainsKey('Accept')) {
    $Headers['Accept'] = 'application/json'
}

$payloadRoot = @{
    tool = $ToolName
    arguments = $ToolArguments
}

$payloadJson = $payloadRoot | ConvertTo-Json -Depth 10

Write-Section 'Request'
Write-LogLine "Endpoint : $EndpointUri"
Write-LogLine "Method   : $RpcMethod"
Write-LogLine "Tool     : $ToolName"
Write-LogLine "Headers  :"
$Headers.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-LogLine "  $_"
}
Write-LogLine 'Payload  :'
$payloadJson | Out-String -Stream | ForEach-Object { Write-LogLine "  $_" }

try {
    $response = Invoke-RestMethod -Uri $EndpointUri -Method Post -Body $payloadJson -ContentType 'application/json' -Headers $Headers -TimeoutSec $TimeoutSeconds
    Write-Section 'Response'
    $response | ConvertTo-Json -Depth 10 | Out-String -Stream | ForEach-Object { Write-LogLine $_ }
    $status = 0
}
catch {
    Write-Section 'Response (error)'
    Write-LogLine $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        Write-LogLine $_.ErrorDetails.Message
    }
    $status = 1
}

Write-Section 'Summary'
Write-LogLine "Saved output to $OutputFile"

exit $status
