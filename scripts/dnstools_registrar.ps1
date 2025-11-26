param(
    [Parameter(Mandatory = $true)]
    [string]$Domain
)

$baseUrl = if ($env:DNSTOOLS_MCP_URL -and $env:DNSTOOLS_MCP_URL.Trim()) {
    $env:DNSTOOLS_MCP_URL
} else {
    "http://localhost:8018"
}
$baseUrl = $baseUrl.TrimEnd('/')

$payload = @{ tool = 'registrar_lookup'; arguments = @{ domain = $Domain } } | ConvertTo-Json -Depth 3
$result = Invoke-RestMethod -Uri "$baseUrl/invoke" -Method Post -ContentType 'application/json' -Body $payload -ErrorAction Stop
Write-Host ($result | ConvertTo-Json -Depth 6)
