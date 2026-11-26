# Local Network (LAN) Setup

Nexuzy PMS normally runs on one host computer. LAN mode lets other staff devices
on the **same private Wi-Fi/LAN** use that same installation from a browser. The
host computer keeps the only database; client devices never store a writable
copy.

> **Security first.** LAN mode is off by default. Never forward the PMS port from
> your router or expose it to the public internet. This build serves plain HTTP;
> passwords and session data are **not encrypted in transit**. Use it only on a
> trusted private network until HTTPS is implemented.

## 1. Start the host

1. Start the PMS on the host with `start.bat` (Windows) or `./start.sh`
   (Linux/macOS), or run `npm start`.
2. Open `http://localhost:5000` on the host and sign in as an administrator.
3. Confirm the Dashboard and Settings screens load normally.

If port 5000 is occupied, start with another port, for example:

```bash
PORT=5050 npm start
```

The Settings panel always shows the port the server is actually listening on.

## 2. Enable LAN access

1. Go to **Settings & Backup → Local Network & Connected Devices**.
2. Read the warning, then tick **Enable access on this local network**.
3. Set the port (default target `5000`) and click **Apply Network Settings**.
4. Confirm the panel shows:
   - host computer name;
   - private LAN IPv4 address (for example `192.168.1.20`);
   - port;
   - full URL (for example `http://192.168.1.20:5000`);
   - security status: **HTTP demo · not encrypted**;
   - active device sessions.
5. Use **Copy URL** or **Show QR** to open the URL on another device.

If the port is already in use, the server keeps the previous working port and
shows an error. Choose another port; the displayed URL updates to match.

## 3. Connect staff devices

1. Put the device on the same private Wi-Fi/LAN as the host.
2. Open the displayed URL (or scan the QR code).
3. Sign in with that staff member's own account. Do not share the administrator
   account between devices.
4. Confirm the role restrictions match the person's job: for example, a captain
   should not see financial reversal or settings actions.

Every device gets its own session. Administrators can review **Recent Device
Sessions** and click **Revoke** to sign a device out immediately.

## 4. Windows firewall

The most common reason a phone cannot connect is Windows Firewall. On the hotel
computer, double-click **`enable-lan-firewall.bat`** and approve the Administrator
prompt. The script allows inbound TCP only for the installed Node.js executable.
Windows often marks a working hotel LAN as **Public** when it has no internet
gateway, so the rule covers the Windows network profiles; Nexuzy PMS still rejects
every non-private client address itself.

You can also use **Settings → Local Network → Test LAN Connection**; the checks
report the listener, the actual LAN URL, the firewall rule and the Windows
network profile.

To add the recommended executable-specific rule manually (administrator
PowerShell, adjust the Node path if needed):

```powershell
New-NetFirewallRule -DisplayName "Nexuzy PMS LAN (Node.js)" -Direction Inbound `
  -Program "C:\Program Files\nodejs\node.exe" -Protocol TCP -Action Allow -Profile Any
```

The rule is limited to the Node executable, and the PMS rejects every non-private
client address. Remove or disable the rule when LAN mode is not in use. Never
create a router port-forward for this port.

## 5. Network requirements and troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Other device cannot open the URL | Wrong adapter URL, different Wi-Fi/VLAN, guest isolation, or firewall | Select the LAN URL for the adapter the phone shares; run `enable-lan-firewall.bat` as Administrator; use Test LAN Connection. |
| Host URL changed | DHCP gave the host a new address | Open Settings and refresh; use a DHCP reservation for a stable address. |
| Port conflict on start | Another program owns the port | Choose another port in Settings or start with `PORT=<number>`. |
| `403 LAN access is disabled` | LAN mode is off | Enable it in Settings, or use the host's `localhost` URL. |
| `403` for a public address | Request came from a non-private network | Connect through the private LAN only. |
| Page opens but sign-in fails | Wrong account, deactivated user, or revoked session | Sign in with an active staff account; ask an administrator to check sessions. |
| Works on host, not on phone | Phone on mobile data or guest Wi-Fi | Join the hotel's private Wi-Fi and disable mobile data for the test. |

Guest Wi-Fi client isolation, VLAN separation, different subnets and managed
switch rules can all prevent devices from reaching the host. Manual `IP:port`
access is always available; mDNS discovery is not included in this build.

## 6. Operating rules

- Keep the host powered on, awake and connected. If the host sleeps, shuts down,
  disconnects or the PMS server stops, every client loses access.
- Clients must not keep a separate editable copy of the database. All writes go
  to the host server.
- Retrying a dropped request is safe for payments, folio charges, restaurant
  settlement, invoices and orders because those endpoints use idempotency keys.
- Disable LAN mode immediately if an unknown device appears. Existing localhost
  access on the host continues to work.
- Use individual accounts. Do not share one login across reception, POS and
  housekeeping devices.

## 7. Backups before upgrades or host migration

The host is the single source of truth.

1. On the host, go to **Settings & Backup** and export a `.nxp` package.
2. Copy the `.nxp` file to another computer or drive.
3. Note the application version and port.
4. Only then replace application files or move to a new host.

To migrate to a new computer:

1. Install the same or newer Nexuzy PMS version on the new host.
2. Start it once and complete the setup wizard.
3. Restore the `.nxp` package from **Settings & Backup**.
4. Sign in, verify rooms, bookings, folios and restaurant bills.
5. Re-enable LAN mode and update staff bookmarks to the new host URL.

The database lives in `data/` and backups in `backups/`. Release packages never
contain either directory.

## 8. Before relying on LAN mode

- [ ] Host starts and opens locally.
- [ ] LAN mode enabled; URL, IP and port are correct.
- [ ] Second computer and phone can sign in with separate accounts.
- [ ] Role restrictions verified on each device.
- [ ] A booking created on device A appears on device B.
- [ ] A restaurant order/KOT created on device B appears on device A.
- [ ] Two devices cannot assign the same room twice.
- [ ] Payments and folio balances match on all devices without duplicates.
- [ ] Disabling LAN mode blocks remote devices while the host still works.
- [ ] Internet disconnected; core LAN operations still work.
- [ ] Host restart preserves all records.
- [ ] Firewall allows only the PMS port on private networks.
- [ ] Staff understand that plain HTTP is not encrypted in transit.

HTTPS, mDNS discovery, automatic scheduled backups and in-app update application
are not part of version 1.2.0. See `docs/GAP_ANALYSIS.md`.
