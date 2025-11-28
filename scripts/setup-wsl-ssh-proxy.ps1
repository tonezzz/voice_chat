param(
    [string]$KeyName = "wsl_debug_ed25519",
    [string]$WslUser = $env:USERNAME,
    [int]$ProxyPort = 2222,
    [string]$KeySource = "C:/_dev/_models/tony/conf/chaba-idc",
    [string]$KeyTarget = "C:/_chaba/chaba-1/mcp-debug/keys"
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[setup-wsl-ssh] $msg" -ForegroundColor Cyan }

function Ensure-Key {
    $src = Join-Path $KeySource $KeyName
    if (-not (Test-Path $src)) {
        throw "Key '$src' not found. Update -KeySource or create the key first."
    }
    if (-not (Test-Path $KeyTarget)) {
        Write-Info "Creating target directory $KeyTarget"
        New-Item -ItemType Directory -Path $KeyTarget | Out-Null
    }
    $dst = Join-Path $KeyTarget $KeyName
    Write-Info "Copying $src -> $dst"
    Copy-Item -Path $src -Destination $dst -Force
}

function Ensure-PortProxy {
    $wslIp = (wsl hostname -I).Trim().Split(' ')[0]
    if (-not $wslIp) {
        throw "Unable to determine WSL IP. Ensure WSL is running and try again."
    }
    Write-Info "Detected WSL IP: $wslIp"
    Write-Info "Updating portproxy rules on port $ProxyPort"
    netsh interface portproxy delete v4tov4 listenport=$ProxyPort listenaddress=0.0.0.0 2>$null | Out-Null
    netsh interface portproxy add v4tov4 listenport=$ProxyPort listenaddress=0.0.0.0 connectport=22 connectaddress=$wslIp | Out-Null
    $ruleName = "WSL SSH Proxy $ProxyPort"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        Write-Info "Adding firewall rule $ruleName"
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $ProxyPort -Action Allow -Profile Any | Out-Null
    }
}

Ensure-Key
Ensure-PortProxy

Write-Info "Done. Run inside container: docker exec mcp-debug env WSL_USER=$WslUser mcp-wsl test"
