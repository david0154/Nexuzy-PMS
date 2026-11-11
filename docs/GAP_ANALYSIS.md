# Nexuzy PMS — Requirements Gap Analysis

Baseline: the deployed Nexuzy PMS application at version **1.0.x**, compared
against the *Missing Features & Improvement Requirements* document.
Target of this pass: **1.2.0**.

Status meanings:

| Status | Meaning |
| --- | --- |
| **Already working** | Verified in the running application; no rebuild needed. |
| **Partially working** | Core behaviour exists, but listed sub-requirements are missing. |
| **Missing** | Not implemented in this pass. |
| **Needs verification** | Implemented, but requires the hotel's real devices/data or a qualified professional. |

Regression evidence for this pass:

- Existing acceptance suite: **18/18 passed** (`npm run test:legacy`).
- New P0 financial/LAN suite: **10/10 passed** (`npm run test:financial`).
- Management/PDF suite: **8/8 groups passed** (`node test/management-tests.js`).
- Combined `npm test`: all three suites passed.
- Live database upgrade tested on a copy of the deployed `data/nexuzy.db`
  (`npm run migrate`: 55 additive migrations, integrity `ok`).
- UI smoke-checked in a browser against a seeded test database: room/type
  management, menu management, staff-user creation, booking manage, booking
  documents, checkout bill preview, bill confirmation, invoice PDF download,
  restaurant bill PDF, LAN diagnostics/session panel and system health.

---

## 1. Room management

| Requirement | Status | Notes |
| --- | --- | --- |
| 1.1 Add/edit/duplicate room, full details, history | **Partially working** | Add and edit work in **Manage Rooms & Types**, with unique-number validation and delete guards. A one-click duplicate action and a dedicated room-history view are still missing. |
| Search/filter/sort rooms | **Partially working** | Room list is returned ordered by number; the room rack is visual. No server-side filter/sort UI. |
| Bulk create/import and bulk update | **Missing** | No import template or bulk editor. |
| 1.2 Floors and room types master | **Partially working** | Room-type add/edit/delete and room floor/building fields are in **Manage Rooms & Types**. Floors remain free text rather than a separate master. |
| Change room type preserving history | **Missing** | Schema keeps historical reservations/folios independent, but no UI action exists. |
| 1.3 Status controls (available/dirty/clean/inspected/OOO/OOS/blocked) | **Partially working** | Status values and room status update exist; OOO is shown in the rack. Block/unblock with reason and date range is **missing**. |
| Blocked/OOS rooms unsellable | **Partially working** | Availability now excludes `blocked`, `out_of_service` and `out_of_order`; there is no block creation workflow yet. |
| Prevent deletion with financial history; archive instead | **Partially working** | Delete is blocked when a room has stays, reservations, group rooms or restaurant orders. A formal archive action is still missing. |
| Status history / audit | **Partially working** | Room status changes write an audit entry. No dedicated status-history timeline. |

## 2. Restaurant, outlets and menu

| Requirement | Status | Notes |
| --- | --- | --- |
| 2.1 Outlet CRUD and outlet-level settings | **Missing** | The application operates one restaurant/bar context. Tax rate and bill prefix are property-level settings. |
| 2.2 Category CRUD, reorder, archive, subcategories | **Partially working** | **Manage Menu** supports add, rename and archive. Display-order API exists; drag reorder, subcategories and bulk import remain missing. |
| 2.3 Menu item CRUD/duplicate/archive, photos, SKU, availability schedule | **Partially working** | **Manage Menu** supports add, edit, price/GST/station changes, availability toggle and archive. Photos, SKU codes and scheduled availability remain missing. |
| 2.4 Variants and add-on groups | **Missing** | Item notes are supported; structured variants/add-ons are not. |
| 2.5 Item/category tax configuration and audit | **Partially working** | Menu items store a tax rate; changes are not restricted to a dedicated tax-admin role. Server ignores client-supplied prices. |

## 3. Restaurant table management

| Requirement | Status | Notes |
| --- | --- | --- |
| Dining areas and table CRUD/rename/archive | **Partially working** | Tables exist with area/status; seeded and used by POS. No table master CRUD or archive. |
| Visual floor layout, drag/drop rearrange | **Partially working** | POS shows a table floor plan; no drag-and-drop editor. |
| Merge/split tables, transfer open order | **Missing** | Not implemented. |
| Table states and conflict prevention | **Partially working** | Available/occupied/billing states are tracked; no cleaning/reserved workflow or active-reservation conflict check on tables. |

## 4. Bookings and reservations

| Requirement | Status | Notes |
| --- | --- | --- |
| 4.1 Create/view/edit/extend/shorten/cancel/reinstate | **Partially working** | Create, manage, date/rate edit, cancel, refund and reinstate are implemented with permission checks. No duplicate booking action. |
| Recalculate availability and price; price-difference confirmation | **Already working** | Date/rate changes return a change summary and require `confirm_change`; revised confirmation versions are kept. |
| Cancellation reason/user/time/refund | **Already working** | Recorded on the reservation and in payment-refund records plus audit. |
| Status history and notes | **Partially working** | Audit entries and versioned documents exist; no dedicated status-history screen. |
| 4.2 Group bookings and rooming list add/remove/reassign | **Partially working** | Group creation, staggered check-in/out, room-wise status and group master folio already existed. Rooming-list editing and group advance allocation UI are limited. |
| Group must not check out until active rooms close | **Already working** | Existing group checkout logic enforces this. |
| 4.3 Calendar views and status filters | **Partially working** | Reservation table and status badges exist; no month/calendar view. |
| Prevent double booking and invalid assignment | **Already working** | Transactional overlap checks (including unpaid/tentative holds) reject conflicts; rooms now exclude blocked/OOS/OOO. |
| Show blocked/maintenance closures in availability | **Partially working** | Availability excludes them; no visual closure calendar. |
| Change history for dates/rates/rooms/status | **Partially working** | Audit history exists; no booking-specific timeline UI. |

## 5. POS, orders, KOT and restaurant billing

| Requirement | Status | Notes |
| --- | --- | --- |
| 5.1 Table/takeaway/delivery/room-service orders | **Already working** | Order types are supported by the POS. |
| Edit/remove items before preparation | **Partially working** | Adding rounds is supported; editing/removing sent items is restricted. |
| Notes, discounts, service charge, taxes | **Partially working** | Notes and tax exist; discounts/service charge are limited. |
| Hold/resume/transfer/merge/split orders | **Missing** | Not implemented. |
| 5.2 KOT new rounds only, station routing, states, cancel/reprint | **Partially working** | Additional KOT rounds contain only new items; cancel and reprint are audited. Kitchen/bar station routing and KDS state transitions are limited. |
| 5.3 Independent bills, split tender, partial payment, refund/void | **Partially working** | Bills, split tender, partial settlement and refund/void records exist. Sharing/emailing bills is limited to print. |
| Prevent already-paid restaurant bills being charged again at checkout | **Already working** | Room posting validates unpaid, eligible orders; checkout excludes separately settled bills and shows them informationally. |
| 5.4 Room posting with staff confirmation and exactly-once folio charge | **Already working** | Verifies active stay/room/guest, records posting staff, idempotent folio entry, reversal supported. |

## 6. Housekeeping and maintenance

| Requirement | Status | Notes |
| --- | --- | --- |
| Checklist templates and items | **Missing** | No template builder. |
| Task assignment, priority, states, inspection | **Partially working** | Housekeeping tasks exist and checkout creates a cleaning task; assignment/inspection workflow is basic. |
| Room cleaning/inspection notes, reopen failed tasks | **Missing** | Not implemented. |
| Maintenance requests, technician/vendor, cost, status | **Partially working** | Maintenance tickets exist for rooms; vendor/cost/close workflow is limited. |
| Block room from sale; restore after authorised completion | **Partially working** | OOO status blocks sale; no automatic maintenance-to-block or restore approval. |
| Staff/time/status history | **Partially working** | Audit entries exist; no dedicated history view. |

## 7. Inventory, suppliers and purchasing

| Requirement | Status | Notes |
| --- | --- | --- |
| 7.1 Product catalogue CRUD/import/stock locations | **Partially working** | Seeded inventory items and basic stock screens; no bulk import or multi-store tracking. |
| 7.2 Supplier master and history | **Partially working** | Supplier data exists in the inventory module; CRUD/history is limited. |
| 7.3 Recipes/BOM, automatic consumption, wastage | **Missing** | Not implemented. |
| 7.4 Purchase orders, partial delivery, adjustments, transfers, counts, valuation | **Missing** | Only basic stock adjustment exists. |

## 8. Staff, users, roles and shifts

| Requirement | Status | Notes |
| --- | --- | --- |
| User add/edit/activate/deactivate | **Already working** | Admin user management with PATCH and deactivation. |
| Granular per-module/action permissions | **Partially working** | Role-based route guards are enforced server-side; there is no permission matrix editor. |
| Role create/edit/duplicate | **Missing** | Fixed role set. |
| Last-active-administrator protection | **Already working** | Enforced on role/status changes. |
| Revoke sessions on deactivation | **Already working** | Per-device sessions are revoked immediately. |
| Shifts, attendance, handover | **Partially working** | Cashier shifts exist; staff scheduling/attendance is missing. |
| Permission-change audit | **Partially working** | User changes are audited; no dedicated permission-history report. |

## 9. Administration, data and system health

| Requirement | Status | Notes |
| --- | --- | --- |
| Bulk import/export with preview and errors | **Missing** | Not implemented. |
| Comprehensive audit log with before/after | **Partially working** | Financial actions and status changes are audited with before/after and device. Audit log viewer exists; coverage is not exhaustive. |
| Recycle bin and safe restore | **Missing** | Not implemented. |
| Scheduled backups, status, retention | **Partially working** | Manual `.nxp` export, Google Drive sync and backup listing exist; no scheduler or retention policy. |
| Restore workflow with confirmation | **Partially working** | `.nxp` upload/restore exists; no pre-restore backup enforcement or restore test report. |
| System health panel | **Already working** | Database, storage, backups, SMTP, network and background-job status are shown. |
| Failed jobs and safe retry | **Missing** | No background job runner in this build. |
| Export logs without secrets | **Missing** | No log export. |

## 10. Advance booking, advance payment and confirmation

| Requirement | Status | Notes |
| --- | --- | --- |
| Quotation and estimate | **Already working** | Versioned `booking_quotation` / `proforma_invoice` documents with print view. |
| Availability check before accepting | **Already working** | Availability endpoint and booking overlap transaction. |
| Configurable advance amount/percentage/due date/policy | **Already working** | Property-level advance policy and per-booking required advance/due date. |
| Awaiting-advance confirmation conditions | **Already working** | Confirmation document/status blocked until required advance is received, unless an authorised policy allows otherwise. |
| Full status set | **Already working** | Enquiry, tentative, awaiting advance, confirmed, partially/fully paid, cancelled, no-show, checked-in/out. |
| Confirmation content and delivery tracking | **Already working** | Reference, guest, dates, room, price summary, advance, balance, policy, contact; send/resend and delivery status. |
| Multiple advances, methods, references, receipts | **Already working** | Ledger plus receipt document per payment; reprint/share view. |
| Advance refund/forfeiture with approval/audit | **Already working** | Authorised refund workflow with reason and audit; original payments unchanged. |
| Distinguish quotation/receipt/invoice | **Already working** | Separate document types and disclaimers. |
| Automatic payment gateway collection | **Missing** | Payments are recorded by staff; no online gateway. |

## 11. Check-in, folio and final checkout bill

| Requirement | Status | Notes |
| --- | --- | --- |
| 11.1 Retrieve booking, verify status/readiness/payment, walk-in, assign room, record staff | **Already working** | Check-in validates booking/room, blocks OOO/blocked rooms, records `checked_in_by`, creates/activates folio with advance. |
| Identity/document requirements | **Partially working** | Guest ID fields exist; no configurable mandatory-document policy. |
| 11.2 Chronological folio with source/tax/reference, approved charges, payments, balance | **Already working** | Ledger view with source, tax, reference, payments, refunds and balance. |
| Prevent duplicate posting; traceable reversal | **Already working** | Idempotency keys and reversal entries. |
| 11.3 A/B/C/D restaurant settlement cases | **Already working** | Posted orders appear once; separately paid bills are excluded and listed informationally; mixed settlement supported; room service uses the same posting path. |
| 11.4 Complete preview and staff confirmation | **Already working** | Preview totals, tax breakdown, restaurant references, discount/credit/refund summary; confirmation snapshots the bill. |
| Corrections before finalisation with reason/audit | **Partially working** | Reversal/adjustment and re-confirmation supported; a dedicated pre-checkout correction form with mandatory reason is limited. |
| Split payment and refund due | **Already working** | Multiple payments/methods; refund-due acknowledgement guard. |
| No checkout with unexplained balance | **Already working** | Checkout rejects unpaid balance unless an approver override is used. |
| 11.5 Final invoice only after confirmation, unique number, GST details, PDF/print/email | **Partially working** | Snapshot-gated unique invoice with server-generated PDF download, print, and SMTP sharing. A dedicated PDF email-attachment flow remains missing. |
| Mark checked out only after financial/operational checks | **Already working** | Invoice/folio/room/HK checks in a transaction. |
| Close folio; authorised post-checkout correction | **Already working** | Folio locked on checkout; correction through reversal/credit note paths, not by editing history. |
| Room dirty + housekeeping task | **Already working** | Checkout updates room status and creates a task. |
| 11.6 Document type distinction | **Already working** | Quotation, confirmation, advance receipt, payment receipt, final tax invoice, credit/refund record and pro forma. |

## 12. Reports and reconciliation

| Requirement | Status | Notes |
| --- | --- | --- |
| Room inventory/status, room change history | **Partially working** | Room status rack and basic reports; room change history is audit-only. |
| Booking conversion/cancellation/no-show/extension | **Missing** | Not implemented as dedicated reports. |
| Advance collection/outstanding/allocation/refund | **Partially working** | Data and ledger exist; no dedicated report screen. |
| Folio and checkout settlement | **Partially working** | Folio data and invoice register available; settlement report is limited. |
| Final invoice register, tax summary, credit/refund | **Partially working** | GST summary and invoice data exist; credit/refund register is limited. |
| Restaurant sales/availability | **Partially working** | Basic sales reporting exists. |
| KOT time/cancellations/voids | **Missing** | Data is recorded; no report. |
| Separate-payment vs room-posting reconciliation | **Already working** | `/api/v1/restaurant/reconciliation` and checkout informational section. |
| Table utilisation/outlet performance | **Missing** | Not implemented. |
| Housekeeping/maintenance downtime | **Missing** | Not implemented. |
| Stock reports | **Partially working** | Basic stock list; movement/recipe/wastage reports missing. |
| Staff access/shift/audit | **Partially working** | Audit log and shifts exist; combined access report missing. |
| Backup/system health history | **Partially working** | Current status only; no history. |
| Filters and export with permission checks | **Partially working** | Some date/status filters exist; broad export not implemented. |

## 13. Global rules and acceptance criteria

| Rule | Status | Notes |
| --- | --- | --- |
| Permission checks on financial actions | **Already working** | Server-side role guards on refunds, reversals, overrides and admin settings. |
| Destructive confirmation and impact display | **Partially working** | Destructive UI actions confirm; no universal impact preview. |
| Historical data not corrupted by master edits | **Already working** | Documents/snapshots store values; no destructive room/master deletes. |
| Prefer archive over hard delete | **Partially working** | No financial deletes; archive coverage is incomplete. |
| Immutable posted financial records | **Already working** | Reversal/refund/credit entries only, with audit. |
| Server-side validation | **Already working** | Pricing, availability, payments and checkout validated on the server. |
| Duplicate submission prevention | **Already working** | Idempotency keys plus unique document/receipt numbers and `BEGIN IMMEDIATE`. |
| Transaction-safe checkout/payment/assignment | **Already working** | Critical sections use immediate transactions and recomputed balances. |
| Property date/time/currency display | **Partially working** | INR and property timezone are configured; some list timestamps use ISO strings. |
| Empty/loading/success/error states | **Partially working** | Common states exist; not audited on every screen. |
| Audit history for important operations | **Partially working** | Financial and status operations covered; not every master-data action. |
| Regression tests before/after | **Already working** | Legacy suite retained and run; new suite added. |
| Test case per requirement | **Partially working** | All P0 items covered; P1/P2 gaps listed above are not implemented, so no tests. |

## 14. Implementation priority

**P0 delivered and tested:** advance ledger and receipts, confirmation
conditions, folio, checkout preview/confirmation, final invoice/payment
settlement, restaurant reconciliation, duplicate payment/charge prevention,
financial audit/roles.

**P1 partially delivered:** booking edits/price confirmation, cancellation and
reinstatement; KOT rounds/cancel/reprint; room availability protections. Room,
menu, table, housekeeping and staff masters remain largely missing.

**P2 not delivered:** inventory/purchasing, bulk import/export, recycle bin,
scheduled backup controls, expanded reports.

## 15. Release build, installer and update experience

| Requirement | Status | Notes |
| --- | --- | --- |
| Single manifest version, semver, matching tags, changelog | **Already working** | `package.json` 1.2.0, `CHANGELOG.md`, tag-checking verification. |
| Downloadable versioned GitHub release with stable latest link | **Partially working** | Release workflow builds zip + SHA-256 on `v*` tags. Assets and tag must still be published by the owner. |
| Build from tagged clean checkout; lint/tests/verify before publish | **Already working** | `.github/workflows/release.yml` runs install, lint, tests, package, verify. |
| Fail release when checks fail | **Already working** | Workflow stops on any failed step. |
| No `.env`, database, guest data, node_modules in package | **Already working** | Allow-list packaging and verification. |
| Test downloaded package | **Partially working** | CI can smoke-test the archive; manual install test is still required on Windows. |
| Keep previous releases for rollback | **Already working** | GitHub Releases retain prior versions. |
| Windows/Linux/macOS packaging and launcher | **Partially working** | Launcher and `.bat`/`.sh` scripts work; no native installer/shortcuts or bundled runtime. |
| Per-user install without admin | **Partially working** | ZIP extraction into a user folder works; no installer. |
| Preserve data across upgrade/uninstall | **Already working** | `data/` and `backups/` are separate and excluded from packages. |
| Detect existing install | **Already working** | Launcher reuses the existing folder and database. |
| First-launch setup wizard and safe DB init | **Already working** | Existing setup wizard and property/admin creation. No default admin password is shipped in production mode. |
| Health/version/data/backup on first launch | **Partially working** | Version/health panel exists; first-launch summary is not shown automatically. |
| In-app update check | **Already working** | Admin-initiated GitHub latest-release check with notes and asset links. |
| Download/apply update, pre-update backup, rollback | **Missing** | Not implemented; updates are manual ZIP replacement with a documented backup step. |

## 16. Local network access

| Requirement | Status | Notes |
| --- | --- | --- |
| Explicit LAN enable/disable, disabled by default | **Already working** | Settings panel; persisted configuration; immediate re-evaluation of every request. |
| Configurable port, default 5000, conflict handling | **Already working** | Port change rebinds in-process; `EADDRINUSE` restores the previous port and reports the conflict. |
| Bind LAN interface, show host IPv4 and full URL | **Already working** | Binds `0.0.0.0`; panel shows host name, private IPv4, port and URL. |
| Copy button and QR code | **Already working** | Both in the Local Network panel. |
| Stable hostname, mDNS | **Missing** | Host name is shown; no mDNS advertisement. Manual IP:port always available. |
| Detect IP changes and refresh | **Partially working** | Status is computed per request; UI refresh is manual. |
| HTTPS with local certificate and trust instructions | **Missing** | Plain HTTP only, explicitly labelled unencrypted demo mode. Private keys are never exposed. |
| Never expose via router port forwarding | **Already working** | Documented warning plus non-private client rejection. |
| Per-device login and server-side roles | **Already working** | Individual accounts and JWT sessions per device; LAN egress still requires auth. |
| Secure cookies/CSRF/rate limiting/login throttling | **Partially working** | HttpOnly cookie/JWT and same-site practices exist; no dedicated CSRF token or login throttle. |
| Immediate LAN disable | **Already working** | Disabling blocks remote requests while loopback continues. |
| Private-network restriction | **Already working** | Loopback allowed; RFC1918/link-local allowed; public clients rejected. |
| Simultaneous clients, shared DB, transactions | **Already working** | All clients use the host database; critical writes are transactional. |
| Stale edit/conflict detection | **Partially working** | Reservation version exists; no universal optimistic-concurrency check or conflict UI. |
| Live updates for rooms/orders/KOT/dashboard | **Missing** | No WebSocket/SSE; screens refresh on navigation/actions. |
| Session list and revocation | **Already working** | Admin panel lists active sessions and revokes immediately. |
| Responsive desktop/tablet/mobile UI | **Partially working** | Responsive Tailwind layout; not device-tested in this pass. |
| Works without internet | **Already working** | Core app is local; only fonts/Tailwind CDN and optional integrations need internet. |
| Host shutdown/disconnection guidance | **Already working** | Explained in the LAN panel. |
| Host single source of truth, no client DB copy | **Already working** | Browser clients hold no writable database. |
| Scheduled automatic backups / host control | **Partially working** | Manual `.nxp` and Google Drive sync; no scheduler. |
| Shutdown warning / crash restart | **Partially working** | Graceful signal shutdown; no active-session warning or supervisor. |
| Health endpoint, safe logging | **Already working** | `/api/health`, `/api/v1/system/health`; no passwords/tokens logged. |
| Host migration/recovery docs | **Already working** | `docs/LAN_SETUP.md`. |
| Safe retry after dropped connection | **Already working** | Idempotency keys on payments, charges, settlement, invoices and orders. |

## 17. Release and LAN priority

**Release P0:** versioned release and pipeline implemented; installer is a
launcher + ZIP, not a native installer; pre-update backup is documented and
manual, not automated.

**LAN P0:** enable/disable, address display, configurable port, per-device auth,
shared transactional database and private-network restriction are implemented.

**LAN P1:** QR/copy and session revocation are implemented; HTTPS, live updates
and scheduled backups remain missing.

**LAN P2:** mDNS, in-app update application and extra installers remain missing.

---

## Verification still required by the hotel

1. Install the packaged ZIP on a clean Windows host and confirm data survives an
   upgrade over an existing installation.
2. Connect a second PC and a phone on the real hotel Wi-Fi, sign in with staff
   accounts, and confirm role restrictions.
3. Test two devices assigning the same room and editing the same booking.
4. Confirm the host firewall allows only the configured PMS port on private
   networks.
5. Validate GST document labels, HSN/SAC codes and tax treatment with a
   qualified Indian tax professional.
6. Confirm SMTP delivery and Google Drive backup credentials with the hotel's
   real accounts.
7. Decide whether plain HTTP is acceptable on the hotel LAN or whether the
   HTTPS certificate workflow must be completed before staff use.
