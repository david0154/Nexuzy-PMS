# Nexuzy PMS

<p align="center">
  <img src="public/logo.png" alt="Nexuzy PMS Logo" width="180">
</p>

<h3 align="center">Hotel, Restaurant, Bar, Front Desk, Billing & Property Operations Management System</h3>

<p align="center">
  <strong>Developed by Nexuzy Lab</strong><br>
  Lead Developer & Maintainer: <strong>David</strong> (<a href="mailto:david@nexuzy.in">david@nexuzy.in</a>)<br>
  Website: <a href="https://nexuzy.in">https://nexuzy.in</a> &middot; 
  Support Maintenance: <a href="https://razorpay.me/@nexuzylab">razorpay.me/@nexuzylab</a><br>
  License: <strong>MIT</strong>
</p>

---

## 🌟 Key Features

- **No Demo Data Required (Clean Production Mode)**: Includes an automated **1st-Time Setup Wizard** asking for Hotel Name, Address, Contact, GSTIN (optional), Bank details (Bank, A/C #, IFSC, Branch), UPI ID, Room/Restaurant GST tax rates, and Master Admin credentials.
- **Official Branding**: Built-in Nexuzy PMS vector logo & favicon configured across headers, login, and printable invoices.
- **Cross-Platform One-Click Install**:
  - **Windows**: `install.bat` and `start.bat`
  - **Linux & macOS**: `install.sh` and `start.sh`
  - **Docker**: `docker compose up -d`
  - **Linux Daemon**: `deploy/nexuzy-pms.service` (systemd)
- **Portable `.nxp` Backup & Restore**: Export your entire hotel database into a verified, checksum-protected **`.nxp`** file and restore it on any other computer (Windows, macOS, Linux) with a single click.
- **Google Drive Cloud Backup**: Automated offsite cloud backups to your designated Google Drive folder.
- **SMTP Mail System**: Integrated `nodemailer` support for Gmail, Outlook, Amazon SES, or custom cPanel mail with a built-in "Send Test Email" diagnostic tool.
- **India GST & Flexible Billing**: SAC/HSN codes (`996311` for rooms, `996331` for restaurant), intra-state CGST (50%) + SGST (50%) tax breakdown, Bank details and UPI VPA printed directly on invoices.
- **Group Staggered Check-In & Check-Out (PRD Section 7)**: Independent room schedules under one master group booking. Check in only arriving rooms; check out departed rooms while others remain occupied.
- **Restaurant POS & Room Service (PRD Section 11 & 34)**: Table floor plan, 5% F&B GST, live Kitchen Display System (KDS), separate restaurant bills, and **Post to Room** folio charging.

---

## 🚀 Easy Installation Guide

### Windows
1. Double-click **`install.bat`** (installs dependencies and prepares storage).
2. Double-click **`start.bat`** (starts the PMS and automatically opens your browser).

### Linux & macOS
1. Open terminal and run:
   ```bash
   chmod +x install.sh start.sh
   ./install.sh
   ./start.sh
   ```
2. Open **[http://localhost:5000](http://localhost:5000)** in your browser.

### Docker (Any OS)
```bash
docker compose up -d
```

---

## ⚙️ 1st-Time Setup vs. Demo Seed

1. **Clean Production Mode (Recommended)**:
   - When launching on a fresh install, the **1st-Time Setup Wizard** automatically opens.
   - Enter your Hotel Name, Phone, Address, GSTIN (optional), Bank account, IFSC, UPI ID, and Administrator credentials.
   - Click **Launch Property** — your hotel is now active with zero dummy data!

2. **Demo Mode (For Evaluation & Testing)**:
   - To populate demo data (*Grand Nexuzy Hotel & Suites* with rooms, menu, in-house stays, and group offsite):
     ```bash
     npm run seed
     ```
   - Default demo password for all staff accounts: `admin123`

---

## 💾 Backups, Portable `.nxp` & Google Drive

- **Export `.nxp` Package**: Go to **Settings & Backup** ➔ click **Export & Download .nxp Package**. Saves a complete verified snapshot.
- **Restore on Another Computer**: Open Nexuzy PMS on your new machine ➔ **Settings & Backup** ➔ select the `.nxp` file ➔ click **Upload & Restore Database**.
- **Google Drive Sync**: Enter your Google Drive Folder ID under **Settings & Backup** ➔ click **Sync to Google Drive Now**.

---

## 🧪 Automated Testing

Execute the comprehensive 14-test suite validating reservation double-booking prevention, staggered group operations, room-service folio posting, GST calculations, and night audit:
```bash
npm test
```

---

## 🛡️ License & Contributing

Nexuzy PMS is open-source software licensed under the [MIT License](LICENSE).
Contributions and bug reports are welcome via [GitHub Pull Requests](CONTRIBUTING.md).
