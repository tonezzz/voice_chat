Param(
    [string]$EnvPath = "$PSScriptRoot\..\.env"
)

if (-not (Test-Path $EnvPath)) {
    Write-Error "Env file not found at $EnvPath"
    exit 1
}

$envMap = @{}
Get-Content $EnvPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)=(.*)$') {
        $envMap[$matches[1]] = $matches[2]
    }
}

$hostname = $envMap['NOIP_DDNS_HOSTNAME']
$username = $envMap['NOIP_DDNS_USERNAME']
$password = $envMap['NOIP_DDNS_PASSWORD']
$userAgent = $envMap['NOIP_DDNS_USER_AGENT']

if ([string]::IsNullOrWhiteSpace($hostname) -or [string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($password)) {
    Write-Error 'Missing NOIP_DDNS_* environment values. Update .env and retry.'
    exit 1
}

if ([string]::IsNullOrWhiteSpace($userAgent)) {
    $userAgent = 'voice-chat-noip-updater/1.0 admin@example.com'
}

$ip = Invoke-RestMethod -Uri 'https://api.ipify.org'
$authString = '{0}:{1}' -f $username, $password
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($authString))
$headers = @{
    Authorization = "Basic $auth"
    'User-Agent' = $userAgent
}

$url = "https://dynupdate.no-ip.com/nic/update?hostname=$hostname&myip=$ip"
$response = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing
Write-Host "No-IP response: $($response.Content.Trim()) (set $hostname -> $ip)"
