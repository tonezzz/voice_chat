param(
    [string]$Task = "Summarize the benefits of sequential thinking.",
    [string]$Endpoint = "http://localhost:8015/invoke"
)

$body = @{
    tool      = "sequential_thinking"
    arguments = @{ task = $Task }
} | ConvertTo-Json -Depth 3

try {
    $response = Invoke-RestMethod -Uri $Endpoint -Method Post -ContentType "application/json" -Body $body
    Write-Host "--- Sequential Thinking Response ---" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 6
} catch {
    Write-Host "Request failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.Exception.Response -and $_.Exception.Response.ContentLength -gt 0) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.BaseStream.Position = 0
        $reader.DiscardBufferedData()
        $errorBody = $reader.ReadToEnd()
        Write-Host "Server response:" -ForegroundColor Yellow
        Write-Host $errorBody
    }
    exit 1
}
