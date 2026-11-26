# Allows Nexuzy PMS (Node.js) to accept connections from private networks.
# Run this once on the hotel computer as Administrator, then restart the app.
$ErrorActionPreference = 'Stop'
$ruleName = 'Nexuzy PMS LAN (Node.js)'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'This script must be run as Administrator. Right-click and choose "Run with PowerShell" or use enable-lan-firewall.bat.'
  exit 1
}

$node = (Get-Command node -ErrorAction Stop).Source
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  # Windows frequently labels a working hotel LAN as "Public" when it has no
  # internet gateway. The rule is limited to the Node executable; Nexuzy PMS
  # independently rejects every non-private client address in the application.
  Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Action Allow -Profile Any
  Write-Host "Firewall rule already exists and is enabled: $ruleName"
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Program $node `
    -Protocol TCP `
    -Action Allow `
    -Profile Any `
    -Description 'Nexuzy PMS local-network access. Only the app process is opened; the app rejects public IP clients.' | Out-Null
  Write-Host "Created firewall rule: $ruleName"
}

Write-Host "Node.js: $node"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '1. Enable LAN sharing inside Nexuzy PMS > Settings > Local Network.'
Write-Host '2. Open Settings > Local Network and use the LAN URL for the adapter your phone can reach.'
Write-Host '3. If the phone still cannot connect, check guest Wi-Fi isolation or use the host Ethernet address.'
Write-Host ''
Write-Host 'Do not create a router port-forward. This server is for the private LAN only.'
