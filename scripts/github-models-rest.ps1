[CmdletBinding()]
param(
    [string]$EnvFile = "c:\_dev\windsurf_ai\voice_chat\.env",
    [string]$ResultsDirectory = "C:\_dev\_models\tony\debugging",
    [string]$CatalogOutputFile,
    [string]$InferenceOutputFile,
    [string]$ModelId = "gpt-4o-mini",
    [int]$MaxOutputTokens = 256,
    [switch]$SkipCatalog,
    [switch]$SkipInference,
    [switch]$Quiet
)

function Ensure-Directory {
    param([string]$Path)
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-EnvValue {
    param([string]$EnvPath, [string]$Key)
    if (-not (Test-Path -LiteralPath $EnvPath)) {
        throw "Env file '$EnvPath' not found"
    }
    foreach ($line in Get-Content -LiteralPath $EnvPath) {
        if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
        $name, $value = $line -split '=', 2
        if ($name.Trim() -eq $Key) {
            return $value
        }
    }
    return $null
}

Ensure-Directory -Path $ResultsDirectory

$token = Get-EnvValue -EnvPath $EnvFile -Key 'GITHUB_MODEL_TOKEN'
if (-not $token) {
    throw "GITHUB_MODEL_TOKEN not found in $EnvFile"
}

$headers = @{
    Authorization          = "Bearer $token"
    "X-GitHub-Api-Version" = "2022-11-28"
    Accept                 = "application/json"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $CatalogOutputFile) {
    $CatalogOutputFile = Join-Path $ResultsDirectory "github-models-catalog-$timestamp.json"
}
if (-not $InferenceOutputFile) {
    $InferenceOutputFile = Join-Path $ResultsDirectory "github-models-inference-$timestamp.json"
}

function Invoke-GitHubRequest {
    param(
        [string]$Uri,
        [string]$Method = 'GET',
        $Body = $null
    )
    $params = @{ Uri = $Uri; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
    if ($Body) {
        $params.Body = $Body
        $params.ContentType = 'application/json'
    }
    return Invoke-RestMethod @params
}

if (-not $SkipCatalog) {
    try {
        $catalog = Invoke-GitHubRequest -Uri 'https://models.github.ai/v1/models'
        $catalog | ConvertTo-Json -Depth 8 | Out-File -FilePath $CatalogOutputFile -Encoding utf8
        if (-not $Quiet) {
            Write-Host "Saved catalog to $CatalogOutputFile"
        }
    }
    catch {
        Write-Warning "Failed to download catalog: $($_.Exception.Message)"
    }
}

if (-not $SkipInference) {
    $body = @{
        model = $ModelId
        messages = @(
            @{
                role = 'system'
                content = 'You are a helpful assistant.'
            },
            @{
                role = 'user'
                content = 'Say hello from GitHub Models via REST.'
            }
        )
        max_tokens = $MaxOutputTokens
    } | ConvertTo-Json -Depth 6
    try {
        $inference = Invoke-GitHubRequest -Uri 'https://models.github.ai/v1/chat/completions' -Method 'POST' -Body $body
        $inference | ConvertTo-Json -Depth 8 | Out-File -FilePath $InferenceOutputFile -Encoding utf8
        if (-not $Quiet) {
            Write-Host "Saved inference response to $InferenceOutputFile"
        }
    }
    catch {
        Write-Warning "Failed to run inference: $($_.Exception.Message)"
    }
}
