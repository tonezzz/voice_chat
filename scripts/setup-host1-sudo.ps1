param(
    [string]$HostAlias = "host1",
    [string]$User = "chaba",
    [string]$SudoersFile = "/etc/sudoers.d/chaba-nopasswd"
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[setup-host1-sudo] $msg" -ForegroundColor Cyan }

$line = "$User ALL=(ALL) NOPASSWD:ALL"
$remoteCmd = "printf '%s\n' '$line' | sudo tee $SudoersFile >/dev/null && sudo chmod 440 $SudoersFile"

Write-Info "Granting passwordless sudo for $User on $HostAlias ($SudoersFile)"
& ssh $HostAlias $remoteCmd
Write-Info "Done."
