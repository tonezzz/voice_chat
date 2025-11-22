[CmdletBinding()]
param(
    [string]$Port = $env:PORT,
    [string]$VmsHost = $env:VMS_HOST,
    [string]$VmsPort = $env:VMS_PORT,
    [string]$VmsAccessId = $env:VMS_ACCESS_ID,
    [string]$VmsAccessPw = $env:VMS_ACCESS_PW,
    [int]$VmsImgWidth,
    [int]$VmsImgHeight,
    [string]$VmsPixelFormat = $env:VMS_PIXEL_FORMAT
)

if (-not $Port) { $Port = '8006' }
if (-not $VmsHost) { $VmsHost = '127.0.0.1' }
if (-not $VmsPort) { $VmsPort = '3300' }
if (-not $VmsAccessId) { $VmsAccessId = 'admin' }
if (-not $VmsAccessPw) { $VmsAccessPw = 'admin' }
if (-not $VmsImgWidth) { $VmsImgWidth = 320 }
if (-not $VmsImgHeight) { $VmsImgHeight = 240 }
if (-not $VmsPixelFormat) { $VmsPixelFormat = 'RGB' }

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$serviceDir = Join-Path $repoRoot 'mcp_vms'
$vendorDir = Join-Path $serviceDir 'vendor'

if (-not (Test-Path (Join-Path $serviceDir 'main.py'))) {
    throw "Unable to locate mcp_vms/main.py under $serviceDir. Run this script from the repo root scripts/ folder."
}

if (-not (Test-Path $vendorDir)) {
    throw "Missing vendor directory at $vendorDir. Copy the VMS DLLs + vmspy.pyd before starting the bridge."
}

Write-Host '=== mcp-vms bridge ==='
Write-Host "Repo root : $repoRoot"
Write-Host "Service    : $serviceDir"
Write-Host "Vendor dir : $vendorDir"
Write-Host ("Endpoint   : http://localhost:{0}" -f $Port)
Write-Host ("VMS target : {0}:{1}" -f $VmsHost, $VmsPort)

Set-Location $serviceDir

$env:PYTHONPATH = $vendorDir
$env:PORT = $Port
$env:VMS_HOST = $VmsHost
$env:VMS_PORT = $VmsPort
$env:VMS_ACCESS_ID = $VmsAccessId
$env:VMS_ACCESS_PW = $VmsAccessPw
$env:VMS_IMG_WIDTH = $VmsImgWidth
$env:VMS_IMG_HEIGHT = $VmsImgHeight
$env:VMS_PIXEL_FORMAT = $VmsPixelFormat

$python = Get-Command python -ErrorAction Stop | Select-Object -ExpandProperty Source
Write-Host "Using python : $python"
Write-Host 'Press Ctrl+C to stop the bridge.'

python .\main.py
