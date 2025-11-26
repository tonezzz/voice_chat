# Firewall rules for KK1 stack
# Run from an elevated PowerShell session: powershell -NoProfile -ExecutionPolicy Bypass -File .\firewall-kk1.ps1

$rules = @(
    @{ Name = 'KK1 HTTP 80';    Protocol = 'TCP'; LocalPort = 80  },
    @{ Name = 'KK1 HTTPS 443';  Protocol = 'TCP'; LocalPort = 443 },
    @{ Name = 'KK1 Proxy 4173'; Protocol = 'TCP'; LocalPort = 4173 }
)

foreach ($rule in $rules) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule

    New-NetFirewallRule -DisplayName $rule.Name `
        -Direction Inbound -Action Allow -Protocol $rule.Protocol `
        -LocalPort $rule.LocalPort -Profile Any
}

# Allow ICMP echo (ping)
Get-NetFirewallRule -DisplayName 'KK1 ICMPv4 Echo' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'KK1 ICMPv4 Echo' `
    -Direction Inbound -Action Allow -Protocol ICMPv4 -IcmpType 8 -Profile Any
