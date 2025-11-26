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

$domain = $envMap['GODADDY_DDNS_DOMAIN']
$record = $envMap['GODADDY_DDNS_RECORD']
$ttlRaw = $envMap['GODADDY_DDNS_TTL']
$ttl = 0
$apiKey = $envMap['GODADDY_DDNS_API_KEY']
$apiSecret = $envMap['GODADDY_DDNS_API_SECRET']

if ([string]::IsNullOrWhiteSpace($domain) -or [string]::IsNullOrWhiteSpace($record) -or [string]::IsNullOrWhiteSpace($apiKey) -or [string]::IsNullOrWhiteSpace($apiSecret)) {
    Write-Error 'Missing GoDaddy DDNS environment values. Check .env placeholders.'
    exit 1
}

if (-not [int]::TryParse($ttlRaw, [ref]$ttl) -or $ttl -lt 600) {
    $ttl = 600
}

$ip = Invoke-RestMethod -Uri 'https://api.ipify.org'
$body = @(
    @{ data = $ip; ttl = $ttl }
) | ConvertTo-Json

$headers = @{
    Authorization = ('sso-key {0}:{1}' -f $apiKey, $apiSecret)
    'Content-Type' = 'application/json'
    Accept = 'application/json'
}

$url = "https://api.godaddy.com/v1/domains/$domain/records/A/$record"
Invoke-RestMethod -Method Put -Uri $url -Headers $headers -Body $body
Write-Host "Updated $record.$domain -> $ip (ttl=$ttl)"
