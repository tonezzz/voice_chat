param(
    [Parameter(Mandatory = $true)]
    [string]$Text,

    [string]$Speaker = 'noina',

    [string]$Output = 'tts_test.wav',

    [switch]$Stream
)

try {
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
} catch {
    throw "Unable to load System.Net.Http assembly: $($_.Exception.Message)"
}

$apiKey = $env:AI4THAI_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'AI4THAI_API_KEY is not set in the environment/.env file.'
}

$headers = @{ Apikey = $apiKey }
$body = @{ text = $Text; speaker = $Speaker } | ConvertTo-Json -Compress

Write-Output "Requesting speech synthesis for speaker '$Speaker'..."
$response = Invoke-RestMethod -Uri 'https://api.aiforthai.in.th/vaja' -Method Post -Headers $headers -Body $body -ContentType 'application/json'
$response | ConvertTo-Json -Compress | Write-Output

if (-not $response.audio_url) {
    throw 'No audio_url returned from VAJA API.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($Output)

if ($Stream.IsPresent) {
    Write-Output 'Streaming download...'
    $handler = New-Object System.Net.Http.HttpClientHandler
    $client = New-Object System.Net.Http.HttpClient($handler)
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $response.audio_url)
    $request.Headers.Add('Apikey', $apiKey)
    $httpResponse = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
    $httpResponse.EnsureSuccessStatusCode() | Out-Null
    $inputStream = $httpResponse.Content.ReadAsStreamAsync().Result
    $fileStream = [System.IO.File]::Open($resolvedOutput, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $buffer = New-Object byte[] 65536
        $total = 0
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $total += $read
            Write-Output ("Downloaded {0:N0} bytes" -f $total)
        }
    }
    finally {
        $fileStream.Dispose()
        $inputStream.Dispose()
        $client.Dispose()
    }
} else {
    Invoke-RestMethod -Uri $response.audio_url -Headers $headers -OutFile $resolvedOutput
}

Write-Output "Saved audio to $resolvedOutput"
Write-Output "Audio URL: $($response.audio_url)"
