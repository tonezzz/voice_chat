param(
    [string]$KeySource = "C:/_dev/_models/tony/conf/chaba-idc/host1_ed25519",
    [string]$KeyName = "host1_ed25519",
    [string]$HostAlias = "host1",
    [string]$HostName = "chaba.surf-thailand.com",
    [string]$HostUser = "chaba"
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[setup-host1-ssh] $msg" -ForegroundColor Cyan }

$sshDir = Join-Path $env:USERPROFILE ".ssh"
if (-not (Test-Path $sshDir)) {
    Write-Info "Creating $sshDir"
    New-Item -ItemType Directory -Path $sshDir | Out-Null
}

$destKey = Join-Path $sshDir $KeyName
if (-not (Test-Path $KeySource)) {
    throw "Key source $KeySource not found"
}
Write-Info "Copying $KeySource -> $destKey"
Copy-Item -Path $KeySource -Destination $destKey -Force

Write-Info "Tightening ACLs on $destKey"
icacls $destKey /inheritance:r | Out-Null
icacls $destKey /grant:r "$env:USERNAME:R" SYSTEM:R | Out-Null

$configPath = Join-Path $sshDir "config"
if (-not (Test-Path $configPath)) {
    Write-Info "Creating ssh config at $configPath"
    New-Item -ItemType File -Path $configPath | Out-Null
}

$configBlock = @"
Host $HostAlias
  HostName $HostName
  User $HostUser
  IdentityFile $destKey
  IdentitiesOnly yes
"@

$configContent = Get-Content $configPath -Raw -ErrorAction SilentlyContinue
if ($configContent -notmatch "Host\s+$([regex]::Escape($HostAlias))\b") {
    Write-Info "Appending host entry $HostAlias to ssh config"
    Add-Content -Path $configPath -Value "`n$configBlock"
} else {
    Write-Info "Host entry $HostAlias already present; not duplicating"
}

Write-Info "Done. You can now run: ssh $HostAlias"
