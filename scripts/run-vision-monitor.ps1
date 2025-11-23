<#
.SYNOPSIS
    Convenience wrapper to launch the mcp-debug vision monitor with alert + MCP forwarding settings.

.EXAMPLE
    ./run-vision-monitor.ps1 -Preset full -WebhookUrl "https://hooks.slack.com/..." -ForwardUrl "http://server:3001/detect-image" -Once
#>

[CmdletBinding()]
param(
    [ValidateSet('custom','baseline','alerts','full')]
    [string]$Preset = 'custom',
    [string]$Urls,
    [int]$IntervalSeconds,
    [int]$MaxHistory,
    [double]$MinConfidence,
    [string]$Classes,
    [switch]$Always,
    [string]$WebhookUrl,
    [switch]$IncludeImage,
    [string]$ForwardUrl,
    [ValidateSet('json','multipart')]
    [string]$ForwardMode,
    [string]$ForwardHeaders,
    [string]$AlertCommand,
    [switch]$Once,

    # Scheduled-task options
    [switch]$RegisterScheduledTask,
    [string]$TaskName = 'VisionMonitor',
    [int]$TaskIntervalMinutes = 5,
    [PSCredential]$TaskCredential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-StringValue {
    param(
        [string]$ParamName,
        [string]$Current,
        [string]$EnvValue,
        [string]$Fallback
    )

    if ($PSBoundParameters.ContainsKey($ParamName) -and -not [string]::IsNullOrWhiteSpace($Current)) {
        return $Current
    }
    if (-not [string]::IsNullOrWhiteSpace($EnvValue)) {
        return $EnvValue
    }
    return $Fallback
}

$presetSummary = switch ($Preset) {
    'baseline' { '5m cadence, capture only' }
    'alerts'   { '3m cadence, alert filter (error_banner,warning)' }
    'full'     { '3m cadence, alerts + MCP forwarding + screenshot embed' }
    default    { 'custom overrides' }
}

$Urls = Resolve-StringValue -ParamName 'Urls' -Current $Urls -EnvValue $env:VISION_URLS -Fallback 'http://client:5173'
$IntervalSeconds = [int](Resolve-StringValue -ParamName 'IntervalSeconds' -Current $IntervalSeconds -EnvValue $env:VISION_INTERVAL_SECONDS -Fallback '300')
$MaxHistory = [int](Resolve-StringValue -ParamName 'MaxHistory' -Current $MaxHistory -EnvValue $env:VISION_MAX_HISTORY -Fallback '5')
$MinConfidence = [double](Resolve-StringValue -ParamName 'MinConfidence' -Current $MinConfidence -EnvValue $env:VISION_ALERT_MIN_CONF -Fallback '0.4')
$Classes = Resolve-StringValue -ParamName 'Classes' -Current $Classes -EnvValue $env:VISION_ALERT_CLASSES -Fallback $null
$WebhookUrl = Resolve-StringValue -ParamName 'WebhookUrl' -Current $WebhookUrl -EnvValue $env:VISION_ALERT_WEBHOOK_URL -Fallback $null
$ForwardUrl = Resolve-StringValue -ParamName 'ForwardUrl' -Current $ForwardUrl -EnvValue $env:VISION_MCP_FORWARD_URL -Fallback $null
$ForwardMode = Resolve-StringValue -ParamName 'ForwardMode' -Current $ForwardMode -EnvValue $env:VISION_MCP_FORWARD_MODE -Fallback 'json'
$ForwardHeaders = Resolve-StringValue -ParamName 'ForwardHeaders' -Current $ForwardHeaders -EnvValue $env:VISION_MCP_FORWARD_HEADERS -Fallback $null
$AlertCommand = Resolve-StringValue -ParamName 'AlertCommand' -Current $AlertCommand -EnvValue $env:VISION_ALERT_COMMAND -Fallback $null

$AlwaysFlag = if ($PSBoundParameters.ContainsKey('Always')) { $true } elseif ($env:VISION_ALERT_ALWAYS) { $env:VISION_ALERT_ALWAYS -eq 'true' } else { $false }
$IncludeImageFlag = if ($PSBoundParameters.ContainsKey('IncludeImage')) { $true } elseif ($env:VISION_ALERT_INCLUDE_IMAGE) { $env:VISION_ALERT_INCLUDE_IMAGE -eq 'true' } else { $false }
$OnceFlag = if ($PSBoundParameters.ContainsKey('Once')) { $true } elseif ($env:VISION_ONCE) { $env:VISION_ONCE -eq 'true' } else { $false }

$explicit = @{
    Urls = $PSBoundParameters.ContainsKey('Urls')
    IntervalSeconds = $PSBoundParameters.ContainsKey('IntervalSeconds')
    MaxHistory = $PSBoundParameters.ContainsKey('MaxHistory')
    MinConfidence = $PSBoundParameters.ContainsKey('MinConfidence')
    Classes = $PSBoundParameters.ContainsKey('Classes')
    Always = $PSBoundParameters.ContainsKey('Always')
    WebhookUrl = $PSBoundParameters.ContainsKey('WebhookUrl')
    IncludeImage = $PSBoundParameters.ContainsKey('IncludeImage')
    ForwardUrl = $PSBoundParameters.ContainsKey('ForwardUrl')
    ForwardMode = $PSBoundParameters.ContainsKey('ForwardMode')
    ForwardHeaders = $PSBoundParameters.ContainsKey('ForwardHeaders')
    AlertCommand = $PSBoundParameters.ContainsKey('AlertCommand')
    Once = $PSBoundParameters.ContainsKey('Once')
}

function Set-PresetValueIfUnset {
    param(
        [string]$ParamName,
        [Object]$Value
    )
    if (-not $explicit[$ParamName]) {
        Set-Variable -Name $ParamName -Value $Value -Scope 0
    }
}

function Set-PresetFlagIfUnset {
    param(
        [string]$ParamName,
        [bool]$Value,
        [ref]$FlagVar
    )
    if (-not $explicit[$ParamName]) {
        $FlagVar.Value = $Value
    }
}

switch ($Preset) {
    'baseline' {
        Set-PresetValueIfUnset -ParamName 'IntervalSeconds' -Value 300
        Set-PresetValueIfUnset -ParamName 'MaxHistory' -Value 5
        Set-PresetValueIfUnset -ParamName 'MinConfidence' -Value 0.4
        Set-PresetValueIfUnset -ParamName 'Classes' -Value $null
        Set-PresetFlagIfUnset -ParamName 'Always' -Value $false -FlagVar ([ref]$AlwaysFlag)
        Set-PresetFlagIfUnset -ParamName 'IncludeImage' -Value $false -FlagVar ([ref]$IncludeImageFlag)
        Set-PresetValueIfUnset -ParamName 'WebhookUrl' -Value $null
        Set-PresetValueIfUnset -ParamName 'ForwardUrl' -Value $null
        Set-PresetValueIfUnset -ParamName 'ForwardMode' -Value 'json'
        Set-PresetValueIfUnset -ParamName 'ForwardHeaders' -Value $null
        Set-PresetValueIfUnset -ParamName 'AlertCommand' -Value $null
    }
    'alerts' {
        Set-PresetValueIfUnset -ParamName 'IntervalSeconds' -Value 180
        Set-PresetValueIfUnset -ParamName 'MaxHistory' -Value 10
        Set-PresetValueIfUnset -ParamName 'MinConfidence' -Value 0.45
        Set-PresetValueIfUnset -ParamName 'Classes' -Value 'error_banner,warning'
        Set-PresetFlagIfUnset -ParamName 'Always' -Value $false -FlagVar ([ref]$AlwaysFlag)
        Set-PresetFlagIfUnset -ParamName 'IncludeImage' -Value $false -FlagVar ([ref]$IncludeImageFlag)
        Set-PresetValueIfUnset -ParamName 'ForwardMode' -Value 'json'
    }
    'full' {
        Set-PresetValueIfUnset -ParamName 'IntervalSeconds' -Value 180
        Set-PresetValueIfUnset -ParamName 'MaxHistory' -Value 15
        Set-PresetValueIfUnset -ParamName 'MinConfidence' -Value 0.45
        Set-PresetValueIfUnset -ParamName 'Classes' -Value 'error_banner,warning'
        Set-PresetFlagIfUnset -ParamName 'Always' -Value $false -FlagVar ([ref]$AlwaysFlag)
        Set-PresetFlagIfUnset -ParamName 'IncludeImage' -Value $true -FlagVar ([ref]$IncludeImageFlag)
        Set-PresetValueIfUnset -ParamName 'ForwardUrl' -Value 'http://server:3001/detect-image'
        Set-PresetValueIfUnset -ParamName 'ForwardMode' -Value 'multipart'
        Set-PresetValueIfUnset -ParamName 'ForwardHeaders' -Value 'X-Forwarded-From: vision-monitor'
    }
    default { }
}

function Add-EnvPair {
    param(
        [Parameter(Mandatory)][string]$Key,
        [string]$Value,
        [switch]$AllowEmpty
    )
    if ([string]::IsNullOrEmpty($Value) -and -not $AllowEmpty.IsPresent) {
        return
    }
    $script:dockerEnvArgs += @('--env', "$Key=$Value")
}

$dockerEnvArgs = @()
Add-EnvPair -Key 'VISION_URLS' -Value $Urls
Add-EnvPair -Key 'VISION_INTERVAL_SECONDS' -Value $IntervalSeconds
Add-EnvPair -Key 'VISION_MAX_HISTORY' -Value $MaxHistory
Add-EnvPair -Key 'VISION_ALERT_MIN_CONF' -Value $MinConfidence
Add-EnvPair -Key 'VISION_ALERT_CLASSES' -Value $Classes
Add-EnvPair -Key 'VISION_ALERT_ALWAYS' -Value ($(if ($AlwaysFlag) { 'true' } else { 'false' })) -AllowEmpty
Add-EnvPair -Key 'VISION_ALERT_WEBHOOK_URL' -Value $WebhookUrl
Add-EnvPair -Key 'VISION_ALERT_INCLUDE_IMAGE' -Value ($(if ($IncludeImageFlag) { 'true' } else { 'false' })) -AllowEmpty
Add-EnvPair -Key 'VISION_MCP_FORWARD_URL' -Value $ForwardUrl
Add-EnvPair -Key 'VISION_MCP_FORWARD_MODE' -Value $ForwardMode
Add-EnvPair -Key 'VISION_MCP_FORWARD_HEADERS' -Value $ForwardHeaders
Add-EnvPair -Key 'VISION_ALERT_COMMAND' -Value $AlertCommand
Add-EnvPair -Key 'VISION_ONCE' -Value ($(if ($OnceFlag) { 'true' } else { 'false' })) -AllowEmpty

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

if ($RegisterScheduledTask) {
    Import-Module ScheduledTasks -ErrorAction Stop
    $scriptPath = (Resolve-Path $MyInvocation.MyCommand.Path).Path

    $scriptArgs = @('-NoProfile','-File',"`"$scriptPath`"")
    $scriptArgs += @('-Preset', $Preset)
    $scriptArgs += @('-Urls', "`"$Urls`"")
    $scriptArgs += @('-IntervalSeconds', $IntervalSeconds)
    $scriptArgs += @('-MaxHistory', $MaxHistory)
    $scriptArgs += @('-MinConfidence', $MinConfidence)
    if ($Classes) { $scriptArgs += @('-Classes', "`"$Classes`"") }
    if ($WebhookUrl) { $scriptArgs += @('-WebhookUrl', "`"$WebhookUrl`"") }
    if ($ForwardUrl) { $scriptArgs += @('-ForwardUrl', "`"$ForwardUrl`"") }
    if ($ForwardMode) { $scriptArgs += @('-ForwardMode', $ForwardMode) }
    if ($ForwardHeaders) { $scriptArgs += @('-ForwardHeaders', "`"$ForwardHeaders`"") }
    if ($AlertCommand) { $scriptArgs += @('-AlertCommand', "`"$AlertCommand`"") }
    if ($AlwaysFlag) { $scriptArgs += '-Always' }
    if ($IncludeImageFlag) { $scriptArgs += '-IncludeImage' }
    $scriptArgs += '-Once'

    $argumentString = $scriptArgs -join ' '
    $taskAction = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument $argumentString
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $TaskIntervalMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)

    if ($TaskCredential) {
        $principal = New-ScheduledTaskPrincipal -UserId $TaskCredential.UserName -LogonType Password -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Password ($TaskCredential.GetNetworkCredential().Password) -Force
    } else {
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType InteractiveToken -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Force
    }

    Write-Host "Scheduled task '$TaskName' created. It will run every $TaskIntervalMinutes minutes using preset '$Preset'."
    return
}

Push-Location $repoRoot
try {
    $dotenvArgs = @('dotenv-cli', '-e', '.env', '--', 'docker', 'exec', '-it')
    $dotenvArgs += $dockerEnvArgs
    $dotenvArgs += @('mcp-debug', 'mcp-browser-vision-watch')

    Write-Host "=== Vision monitor ==="
    Write-Host "Repo root   : $repoRoot"
    Write-Host "Target URLs : $Urls"
    Write-Host "Interval(s) : $IntervalSeconds"
    Write-Host "Max history : $MaxHistory"
    Write-Host "Min conf    : $MinConfidence"
    if ($WebhookUrl) { Write-Host "Webhook     : $WebhookUrl" }
    if ($ForwardUrl) { Write-Host "Forward URL : $ForwardUrl ($ForwardMode)" }
    if ($AlertCommand) { Write-Host "Command     : $AlertCommand" }
    if ($Classes) { Write-Host "Classes     : $Classes" }
    Write-Host "Preset      : $Preset ($presetSummary)"
    if ($OnceFlag) { Write-Host "Mode        : single pass" }
    Write-Host "Launching mcp-browser-vision-watch inside mcp-debug...`n"

    & npx @dotenvArgs
}
finally {
    Pop-Location
}
