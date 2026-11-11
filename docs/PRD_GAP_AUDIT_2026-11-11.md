# Nexuzy PMS — PRD Gap Audit (2026-11-11)

Scope: review of the public main branch against the uploaded Nexuzy PMS Missing Features & Improvement Requirements specification. This is a code-level review, not a staging deployment or full UI walkthrough.

## Verified repository structure
Existing Express/SQLite application with modules for authentication, properties, rooms, reservations, group bookings, stays, folios, restaurant, housekeeping, maintenance, cashier, inventory, night audit, reports, setup, backup and settings. Frontend is a static SPA in public/. CI matrix targets Ubuntu, Windows and macOS on Node 18 and 20.

## Findings from inspected code

| PRD area | Audit status | Evidence / gap |
|---|---|---|
| Room management | Partial | Room list/create/status and room types exist. Edit/archive/floor CRUD/history not demonstrated; status endpoint accepts unvalidated values and does not verify property ownership. |
| Restaurant/outlets/menu | Partial | Menu categories/items/variants and orders exist. Multiple outlets, add-on groups, scheduled availability and archive safeguards not demonstrated. |
| Table management | Partial | Table records and section field exist; visual layout, table merge/split, order transfer and conflict-safe reservations not verified. |
| Bookings/groups | Partial | Reservations and group room stays exist. Staggered group operations exist; broad booking edits, quote/confirmation policies and change history not fully demonstrated. |
| POS/KOT/settlement | Partial | Orders, order items, KOT records and direct settlement/room posting exist. Additional KOT rounds, split tender, refunds and duplicate-safe reprints need validation. |
| Housekeeping/maintenance | Partial | Task/ticket tables and basic routes exist; templates, inspection, assignment and full status lifecycle require implementation/verification. |
| Inventory/purchasing | Partial | Stock item and stock movement foundations exist. Suppliers, recipes/BOM, purchase approvals/receipts, transfers and expiry/batch traceability not demonstrated. |
| Roles/users/shifts | Partial | Role names/guard, user create/list and cashier shifts exist. Granular permissions, last-admin protection and session revocation not demonstrated. |
| Administration/health | Partial | Health endpoint and .nxp backup export/restore exist. Restore verification, job health/retry UI and recycle-bin workflows not demonstrated. |
| Advance booking/payments | Partial / high risk | Reservation has deposit_required/deposit_paid; payments support advance type. Allocation/receipt, confirmation conditions, duplicate prevention and immutable adjustment workflow need work. |
| Folio/checkout/invoice | Partial / high risk | Folio ledger, payments, invoice creation and checkout exist, but calculation and authorization safeguards have material gaps. |
| Reports | Partial | Reports module exists; requested reconciliation and operational reports not all verified. |
| Release/installer | Partial | Windows install/start scripts and CI exist. Version/tag/release assets, checksums, tested installer, upgrade/rollback and persistent-data protection not demonstrated. |
| LAN sharing | Partial / unsafe default | Server binds to 0.0.0.0 immediately, default port 5000; no explicit owner opt-in, LAN URL/QR, private-interface enforcement, HTTPS trust flow or session controls demonstrated. |

## P0 issues confirmed by source inspection

1. server/modules/stays/routes.js: checkout accepts allow_override directly from request body. A non-admin client can set it true and bypass an outstanding folio balance. This is not an authorized policy check.
2. server/modules/folios/routes.js: payment endpoint records payment and reduces folio balance without verifying folio exists, is open, belongs to caller property, or payment is not above outstanding balance. It accepts arbitrary payment_method strings. No idempotency key.
3. server/modules/folios/routes.js: charge endpoint does not check folio state/property and accepts negative or non-finite quantity, price or tax values.
4. server/modules/folios/routes.js: invoice endpoint derives subtotal from quantity × unit_price but ignores stored total_amount and does not ensure a stable invoice/checkout state. It labels document a tax invoice before reviewed, authorized checkout is established.
5. server/middleware/auth.js: JWT signing falls back to a hard-coded secret when JWT_SECRET is absent.
6. server/app.js: unrestricted CORS is enabled globally.
7. server/index.js: network server listens on all interfaces without owner opt-in; LAN exposure is a default rather than the PRD's explicit opt-in mode.

## Test/release observations
- npm test has 18 broad integration scenarios, but does not exercise payment over-collection, closed-folio posting, payment replay/idempotency, client checkout override, or default LAN exposure.
- Tests call seed with force=true; run only in isolated CI/test DB. Never run against hotel production data.
- CI currently uses Node 18 and 20; supported runtime compatibility should be checked against dependencies.
- Repository contains three committed .nxp backup packages under backups/. Remove from source control if they contain real hotel/guest data; never publish customer data or secrets.

## Recommended implementation order
P0: financial transaction integrity, authorization, immutable adjustments, checkout preview/confirmation, room-posting reconciliation, and secrets/CORS/LAN safe defaults.
P1: room/menu/table/booking/housekeeping/staff workflows.
P2: supplier purchasing/recipes, operational dashboards, restore testing, installer/update automation and cross-platform UX.

## Status discipline
Partial means some code foundation was found; it does not certify the user-facing workflow is complete. Not demonstrated means this inspection did not find adequate evidence; it is not proof that no UI exists. Test every item in staging on the actual packaged application before marking it complete.
