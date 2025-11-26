param(
    [Parameter(Mandatory = $true)]
    [string]$Domain,
    [ValidateSet('A','AAAA','MX','TXT','NS','SOA','CNAME','CAA','SRV','PTR')]
    [string]$RecordType = 'A'
)

function Invoke-DnstoolsLookup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Domain,
        [Parameter(Mandatory = $true)]
        [string]$RecordType
    )

    $baseUrl = if ($env:DNSTOOLS_MCP_URL -and $env:DNSTOOLS_MCP_URL.Trim()) {
        $env:DNSTOOLS_MCP_URL
    } else {
        "http://localhost:8018"
    }
    $baseUrl = $baseUrl.TrimEnd('/')

    $payload = @{ tool = 'lookup_record'; arguments = @{ domain = $Domain; record_type = $RecordType } } | ConvertTo-Json -Depth 4
    return Invoke-RestMethod -Uri "$baseUrl/invoke" -Method Post -ContentType 'application/json' -Body $payload -ErrorAction Stop
}

Invoke-DnstoolsLookup -Domain $Domain -RecordType $RecordType | ConvertTo-Json -Depth 5
