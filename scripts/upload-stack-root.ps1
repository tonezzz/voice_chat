param(
    [string]$LocalPath = "stack-root-index.html",
    [string]$RemoteFileName = "index.html"
)

$ErrorActionPreference = 'Stop'

function Get-EnvVariablesFromFile {
    param([string]$FilePath)

    if (-not (Test-Path $FilePath)) {
        throw "Missing .env file at $FilePath"
    }

    $map = @{}
    Get-Content $FilePath | ForEach-Object {
        $line = $_.Trim()
        if (-not $line) { return }
        if ($line.StartsWith('#')) { return }
        $pair = $line -split '=', 2
        if ($pair.Length -ne 2) { return }
        $key = $pair[0].Trim()
        $value = $pair[1].Trim()
        if ($key) {
            $map[$key] = $value
        }
    }
    return $map
}

function New-FtpRequest {
    param(
        [string]$Uri,
        [string]$Method,
        [System.Net.NetworkCredential]$Credentials
    )

    $request = [System.Net.FtpWebRequest]::Create($Uri)
    $request.Credentials = $Credentials
    $request.Method = $Method
    $request.UseBinary = $true
    $request.UsePassive = $true
    $request.KeepAlive = $false
    return $request
}

function Ensure-FtpDirectories {
    param(
        [string]$BaseUri,
        [string]$RemotePath,
        [System.Net.NetworkCredential]$Credentials
    )

    $trimmed = $RemotePath.Trim('/')
    if (-not $trimmed) { return }

    $segments = $trimmed -split '/'
    $currentPath = ''
    foreach ($segment in $segments) {
        if (-not $segment) { continue }
        $currentPath += '/' + $segment
        $uri = "$BaseUri$currentPath"
        try {
            $request = New-FtpRequest -Uri $uri -Method ([System.Net.WebRequestMethods+Ftp]::MakeDirectory) -Credentials $Credentials
            $response = $request.GetResponse()
            $response.Close()
        } catch [System.Net.WebException] {
            $ftpResponse = $_.Exception.Response
            if ($ftpResponse) {
                $statusCode = $ftpResponse.StatusCode
                $ftpResponse.Close()
                if ($statusCode -ne [System.Net.FtpStatusCode]::ActionNotTakenFileUnavailable -and
                    $statusCode -ne [System.Net.FtpStatusCode]::ActionNotTakenFileUnavailableOrBusy) {
                    throw
                }
            } else {
                throw
            }
        }
    }
}

$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = Split-Path -Parent $scriptRoot
$envPath = Join-Path $repoRoot '.env'

$envVars = Get-EnvVariablesFromFile -FilePath $envPath

$ftpHost = $envVars['FTP_HOST']
$ftpUser = $envVars['FTP_USERNAME']
$ftpPass = $envVars['FTP_PASSWORD']
$ftpDir  = $envVars['FTP_REMOTE_PATH']

if (-not $ftpHost -or -not $ftpUser -or -not $ftpPass -or -not $ftpDir) {
    throw 'FTP variables are incomplete in .env'
}

$localFullPath = Join-Path $repoRoot $LocalPath
if (-not (Test-Path $localFullPath)) {
    throw "Local file not found: $localFullPath"
}

$ftpDir = $ftpDir.TrimEnd('/')
if (-not $ftpDir.StartsWith('/')) {
    $ftpDir = '/' + $ftpDir
}

$baseUri = "ftp://$ftpHost"
$credentials = New-Object System.Net.NetworkCredential($ftpUser, $ftpPass)

Ensure-FtpDirectories -BaseUri $baseUri -RemotePath $ftpDir -Credentials $credentials

$uploadUri = "$baseUri$ftpDir/$RemoteFileName"
$fileBytes = [System.IO.File]::ReadAllBytes($localFullPath)
$request = New-FtpRequest -Uri $uploadUri -Method ([System.Net.WebRequestMethods+Ftp]::UploadFile) -Credentials $credentials
$request.ContentLength = $fileBytes.Length

$requestStream = $request.GetRequestStream()
$requestStream.Write($fileBytes, 0, $fileBytes.Length)
$requestStream.Close()

$response = $request.GetResponse()
$response.Close()

Write-Host "Uploaded $localFullPath to $uploadUri (passive mode)"
