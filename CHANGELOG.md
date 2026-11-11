# Changelog

All notable changes to Nexuzy PMS are recorded here. The project follows
[Semantic Versioning](https://semver.org/). Release tags use `v<version>` and
must match `package.json`.

## [Unreleased]

Billing, WhatsApp sharing, branding, expenses and restaurant advance-booking
release. The database upgrade is additive; existing rooms, menus, users and
financial records are preserved.

### Fixed — installed shortcut and first-run startup

- The installed desktop shortcut no longer fails silently when port 5000 is
  already occupied. Startup now tries ports 5001–5009 and writes the actual
  port to `data/runtime.json`, so the first-run setup wizard opens correctly
  even when a source checkout is already running.

### Added — about, updates and uninstall

- **Settings → About, Support & Uninstall** shows the Nexuzy Lab developer,
  website, GitHub repository, licence, runtime, donation link and optional UPI ID.
- Installed builds check GitHub releases once a day and show an update banner.
  Administrators can download the platform-matched installer, verify its
  published SHA-256 sidecar when present, and start the update from Settings.
  Portable/source builds are directed to the downloaded installer instead of
  being replaced automatically.
- Administrator-only uninstall action with a typed `UNINSTALL` confirmation.
  Windows uses the Inno uninstaller; Linux and macOS packages now include an
  `uninstall.sh`. Program files and shortcuts are removed while hotel data is
  preserved.
- Optional `NEXUZY_DONATION_URL`, `NEXUZY_DONATION_UPI` and `GITHUB_TOKEN`
  environment variables for the support block and release API.
- `npm run package:installers` creates one upload-ready ZIP containing the
  Windows, Linux and macOS installers, checksums and install guide.
- Tagged `v*` releases now build the Windows Setup on Windows and the
  Linux/macOS packages on Ubuntu, then publish the combined ZIP and individual
  updater assets automatically.

### Added — native desktop app and first-run setup

- `scripts/launch.js` opens Nexuzy PMS in its own Chromium app-mode window
  (Chrome, Edge, Brave or Chromium) with no browser address bar. It reuses an
  already-running local server through `data/runtime.json` and `/api/health`,
  and falls back to the default browser only when no Chromium is found.
- `scripts/create-shortcut.js` creates a hidden-console Windows `.lnk` launcher
  (a generated VBS runs Node without a terminal window), a Linux `.desktop`
  file with `Terminal=false`, or a macOS `.app` bundle, using the real Windows
  Desktop folder even when OneDrive redirects it.
- First-time setup now accepts a hotel logo, creates the local database, hotel
  profile, GST settings and master admin account in one step, and saves the
  logo for immediate use in the header and on bills.
- Admin-uploaded logos support PNG, JPG and WebP up to 1.5 MB, and the saved
  file is removed when replaced.

### Fixed — first-run setup and offline launch

- Tailwind CSS is now bundled at `public/vendor/tailwind.js` instead of loading
  from the online CDN, and the Google Fonts request was removed. Setup, login
  and the dashboard render correctly on a hotel PC with no internet connection.
- Hotel logos are resized to at most 1024 px and re-encoded as PNG (or JPEG when
  needed) before upload, so phone photos no longer exceed the logo limit and
  WebP logos no longer fail when embedded in PDF bills.
- Raised the JSON body limit from 2 MB to 8 MB for base64 logo uploads, and
  body-parser errors now return JSON (`413` for oversized images) instead of an
  HTML page that the browser reported as `Unexpected token '<'`.
- The hidden-window launcher now writes `data\launcher.log` and shows a native
  Windows dialog if the server exits or does not start within 30 seconds.

### Added — cross-platform installers and branded icon

- `installer/assets/nexuzy.ico` (9 sizes up to 256×256) is now used for the
  Windows Setup icon, Desktop/Start Menu shortcuts, uninstall entry, web
  favicon, and Linux/macOS application icons.
- Linux x64 packages: a self-extracting `Nexuzy-PMS-<version>-linux-x64.run`
  and `.tar.gz`, carrying Node.js and the matching SQLite N-API binding.
  Installation creates an application-menu entry and desktop shortcut under
  `~/.local/share/nexuzy-pms`.
- macOS packages for Intel and Apple Silicon: `.app` bundles with bundled Node.js
  and SQLite, plus `Install Nexuzy PMS.command`; hotel data is stored in
  `~/Library/Application Support/Nexuzy PMS`.
- `npm run build:installers` builds Windows, Linux and macOS artifacts together.
  macOS `.dmg`/`.pkg` creation and signing still require macOS tooling.

### Added — Windows installer with bundled Node.js

- `npm run build:installer` produces a single per-user
  `dist/installer/Nexuzy-PMS-Setup-<version>.exe` plus a SHA-256 file. The
  payload contains the matching Node.js win-x64 runtime, production
  dependencies, the app icon and a hidden-window launcher, so the target PC
  needs no Node.js, npm, administrator rights or internet connection.
- The installer creates Desktop and Start Menu shortcuts, stops a verified
  running PMS process before upgrading, and never packages or deletes `data\`,
  uploaded logos, backups or `.env`.
- Builds verify the Node.js release checksum and confirm the bundled runtime can
  load `sqlite3`, `pdfkit` and `express` before compiling with Inno Setup.

### Changed — bill branding

- Every booking bill, checkout invoice and restaurant bill shows the hotel's
  own logo as the primary brand and a **“Generated by Nexuzy PMS · Nexuzy Lab”**
  footer. Server-side PDFs stamp this footer, with page numbers, on every page.

### Performance

- Dashboard now reads room counters in one aggregate query and the remaining
  figures in one scalar query instead of about a dozen sequential queries.
- Profit & Loss builds monthly revenue and expenses in one grouped `UNION ALL`
  query instead of three separate grouped scans.
- Added indexes covering folio dates, settled restaurant orders, posted expenses,
  payment timestamps, room status, expected check-out and arrival dates.
- Static assets are cached for one hour while HTML stays revalidated, so app
  updates are picked up immediately without re-downloading scripts each screen.

### Added — guest bills and WhatsApp

- `GET /api/v1/reservations/:id/bill/pdf` prints a booking bill (stay, taxes,
  advances and balance) using the same booking reference.
- `GET /api/v1/reservations/:id/whatsapp`, `GET /api/v1/stays/:id/whatsapp`,
  `GET /api/v1/restaurant/orders/:id/whatsapp` and
  `GET /api/v1/restaurant/bookings/:id/whatsapp` return pre-filled `wa.me`
  links for web WhatsApp with the booking/bill number, amounts and UPI details.
- Bills download as PDF first so staff can attach them in the WhatsApp chat.
- Hotel logo uploaded in Settings is embedded in every generated PDF.

### Added — hotel logo

- `POST /api/v1/settings/logo` stores an admin-uploaded PNG/JPG/WebP beside the
  database and updates the header, favicon and PDF branding.
  `DELETE /api/v1/settings/logo` restores the default mark.
- WhatsApp country code is configurable in Hotel Profile settings.

### Added — hotel expenses

- New **Hotel Expenses** screen and `/api/v1/expenses` API: categories, vendor,
  payment mode (cash, UPI, card, bank, net banking, credit), period totals and
  audit-safe voiding.
- Dashboard now shows **Expenses Today** and **Net Today** (collections minus
  expenses). `GET /api/v1/reports/profit-loss` adds revenue excluding GST,
  GST collected, expenses, net profit and margin, plus revenue/expense/profit
  by month. **Reports → Profit & Loss** exposes the period filter, summary,
  monthly table and expense-category breakdown.

### Added — restaurant advance bookings

- `/api/v1/restaurant/bookings`: take an advance with a payment mode, confirm
  the booking automatically, record later advances, seat/complete/cancel, refund
  with approval and print an advance receipt PDF.
- Restaurant settlement and advance receipts accept **net banking** alongside
  cash, UPI, card and bank transfer.

### Added — booking changes and shortcuts

- Extend a reservation (`POST /api/v1/reservations/:id/extend`) or an in-house
  stay (`POST /api/v1/stays/:id/extend`) with a revised confirmation and audit
  record. Cancel and date-change workflows remain available from Manage.
- Installers and first-time setup create a desktop launcher on Windows, Linux
  and macOS (`npm run shortcut`), also available from Settings.

## [1.2.0] — 2026-11-10

Management, printable-bill and LAN-diagnostics release. The database upgrade is
additive; existing rooms, menus, users and financial records are preserved.

### Added — management screens

- Rooms & HK → **Manage Rooms & Types**: create, edit and delete room types and
  rooms, set floors, buildings, occupancy, rates, GST and amenities, with
  duplicate guards and safe-delete checks for rooms with history.
- Restaurant POS → **Manage Menu**: categories, items, selling prices, GST,
  kitchen/bar/bakery station, veg/non-veg and availability. Archived items leave
  the POS but remain on historical bills.
- Settings → **Staff Users & Access**: create staff logins, assign roles, activate
  or deactivate users and reset passwords from the UI. New users can sign in
  immediately with per-device sessions.

### Added — downloadable PDFs

- `GET /api/v1/folios/:id/invoice/pdf` generates a real A4 PDF tax invoice with
  property details, GSTIN, guest, HSN/SAC, tax breakup, bank/UPI details and
  payment balance.
- `GET /api/v1/restaurant/orders/:id/bill/pdf` generates a PDF for a settled
  restaurant bill. The POS bill dialog provides the download button.
- The invoice modal now has a dedicated **Download PDF** button alongside print.

### Fixed / improved

- LAN diagnostics now test the listener and the actual LAN URL, report the
  Windows firewall state and provide `enable-lan-firewall.bat` to add the
  required Node.js inbound rule.
- The LAN panel lists every private adapter URL (Ethernet and Wi-Fi) and lets
  staff choose the one their phone can reach; QR codes follow the selection.
- The primary LAN URL follows the default route instead of whichever adapter is
  listed first.
- LAN device sign-in works even when Windows classifies the hotel LAN as a
  Public network; the app still rejects public IP client addresses.
- Room, room-type and menu queries are scoped to the active property.
- Staff creation now validates username, password length and role, and writes an
  audit entry.
- Restaurant bill JSON includes its order id so the downloaded PDF uses the
  correct bill.

### Verification

- Legacy acceptance suite, P0 financial/LAN suite and the new management/PDF
  suite all pass.
- New PDFs are generated server-side with PDFKit and returned as
  `application/pdf` attachments.

## [1.1.0] — 2026-11-10

Financial-correctness, LAN-sharing and release-engineering release. Existing
hotel, POS, group-stay and billing behaviour is preserved; the database upgrade
is additive and idempotent.

### Added — advance bookings and confirmation

- Advance payment ledger per reservation, with receipt numbers
  (`ADV-YYYY-YY-00001`), payment method, transaction reference and cashier.
- Configurable advance requirement and due date. A booking can remain
  `awaiting_advance` until the required amount is received, and confirmation
  documents are blocked until confirmation conditions are met.
- Versioned bookings: `booking_quotation`, `booking_confirmation`,
  `advance_receipt` and `proforma_invoice` documents. Regenerating a document
  creates a new version and keeps the old one.
- Delivery status tracking and resend support for booking documents.
- Price-change preview: old total, new total, difference, advance received and
  revised balance, with explicit staff confirmation before saving.
- Cancellation with reason/user/time, advance refund records and reinstatement.

### Added — guest folio and checkout

- Chronological folio ledger exposing source, date/time, tax breakdown and
  reference for every charge, payment, refund and adjustment.
- Idempotent charge posting and payment recording. Retrying with the same
  idempotency key returns the original receipt instead of double-posting.
- Traceable charge reversal by an approver; posted entries are never deleted.
- Authorised folio credit refunds.
- Checkout bill preview with room, tax, restaurant and payment breakdown, plus
  restaurant bills paid separately shown as informational references only.
- Staff confirmation of the bill preview creates an immutable snapshot.
- Final invoice generated from the confirmed snapshot, with a unique number,
  locked after issue, duplicate-safe and printable.
- Guarded checkout: confirmed bill, no unexplained unpaid balance, refund
  acknowledgement, dirty-room status, housekeeping task and folio closure.
- Reconfirmation is required if folio charges change after bill confirmation.

### Added — restaurant reconciliation

- Server-authoritative menu pricing; client-supplied prices are ignored.
- Kitchen order tickets are generated only for newly added items, with separate
  rounds, cancellation reasons and reprint markers.
- Idempotent settlement, split tender, refund/void records and bill numbers.
- Room posting validates the active stay, is exactly-once, records the posting
  staff member and appears once in the folio.
- `/api/v1/restaurant/reconciliation` compares separately settled bills with
  room-posted orders so paid bills cannot be charged again at checkout.

### Added — security, audit and LAN access

- Per-device sessions (`lan_sessions`) with JWT session IDs, immediate
  revocation, session listing and admin-triggered sign-out.
- Last-active-administrator protection and session revocation when a user is
  deactivated.
- Audit entries for financial actions now include before/after values and device
  information.
- Local Network settings: disabled by default, explicit enable/disable,
  configurable port (default target 5000), host LAN IPv4 display, full URL,
  copy button, QR code and active device sessions.
- LAN guard on every request: loopback is always allowed; non-private client
  addresses are rejected; remote clients are rejected while LAN mode is off.
- Plain HTTP is labelled as unencrypted demo transport. HTTPS certificate
  provisioning is not included in this build.
- Health endpoint checks database connectivity; system health reports storage,
  backups, SMTP, network mode and background-job status.
- Version and explicit administrator-initiated GitHub update check.

### Added — release engineering

- `npm run lint`, `npm test`, `npm run migrate`, `npm run verify` and
  `npm run release:package`.
- Release packaging from an allow-list, excluding `.env`, databases, uploads,
  backups, dependencies and developer-only data.
- SHA-256 checksum files next to release archives.
- GitHub Actions CI and tag-driven release workflow.
- Launcher (`scripts/launch.js`) used by `start.bat`/`start.sh`; existing
  installations are detected and upgraded in place.

### Database

- Additive migration runner (`server/db/migrate.js`, `server/config/migrations.js`)
  with idempotent columns, indexes and new tables. The migration runs on startup
  and via `npm run migrate`.
- New tables: `document_sequences`, `booking_documents`, `checkout_snapshots`,
  `payment_refunds`, `lan_sessions`.
- SQLite now uses `busy_timeout=5000` and `BEGIN IMMEDIATE` transactions for
  payment, checkout, folio and room-assignment critical sections.

### Known limitations

- Room/floor/room-type master CRUD screens, group rooming-list editing, table
  merge/split, housekeeping templates, inventory purchasing, bulk import/export,
  recycle bin, scheduled backups, HTTPS certificate setup and in-app update
  application are **not** included in 1.1.0. See `docs/GAP_ANALYSIS.md`.
- Live push updates use normal request refreshes, not WebSockets.
- SMTP delivery requires configured credentials; otherwise documents are stored
  and marked `not_sent`.
- GST labels and treatment must be validated by a qualified tax professional
  before production use.

## [1.0.1] and earlier

See the repository commit history and GitHub Releases for earlier changes.
