param(
    [string]$Domain = "chaba.surf-thailand.com"
)

$baseUrl = if ($env:DNSTOOLS_MCP_URL -and $env:DNSTOOLS_MCP_URL.Trim()) {
    $env:DNSTOOLS_MCP_URL
} else {
    "http://localhost:8018"
}
$baseUrl = $baseUrl.TrimEnd('/')
Write-Host "Testing mcp-dnstools at $baseUrl (domain=$Domain)"

$health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -ErrorAction Stop
Write-Host "/health =>" ($health | ConvertTo-Json -Depth 5)

$payload = @{ tool = 'lookup_record'; arguments = @{ domain = $Domain; record_type = 'A' } } | ConvertTo-Json -Depth 5
$result = Invoke-RestMethod -Uri "$baseUrl/invoke" -Method Post -ContentType 'application/json' -Body $payload -ErrorAction Stop
Write-Host "lookup_record =>" ($result | ConvertTo-Json -Depth 5)
