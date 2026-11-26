# Room QR & Guest Portal

Each room has **one permanent QR code**. The QR encodes an opaque, unguessable
room token; it is not a guest identity and it does not change between guests.
Scanning it opens the mobile guest portal on the hotel LAN.

```
Room poster QR  ->  /guest-room.html?qr=<room token>
                         |
                         v
               POST /api/v1/guest-room/resolve
                         |
                         v
        Temporary guest session (stay-bound, expiring, revocable)
```

## Why the QR is permanent

- Reception can print and laminate a poster once. Replacing a guest, an
  extension or a checkout does **not** invalidate the wall poster.
- The QR only identifies the room. The guest session is created only when the
  room has a currently checked-in stay.
- If a poster is lost or leaked, an admin can **Regenerate** that room's QR.
  Regeneration replaces the room token and immediately revokes every guest
  session opened from the old QR. Other rooms are unaffected.
- Disabling a room QR also revokes active sessions for that room.

Only the guest **session** tokens are stored as SHA-256 hashes. The permanent
room token must be recoverable to reprint the same poster, so it is stored as
the room's QR secret and is never placed in guest session storage.

## Setup

1. Start the PMS on the hotel server and note the LAN address, for example
   `http://192.168.1.10:5000`.
2. Open **Settings → Tax Configuration & Guest Portal**.
3. Set **Guest portal LAN address** to that address, and fill in the Wi-Fi
   network name, Wi-Fi password, optional instructions, reception and emergency
   contacts.
4. Enable room QR, guest portal and the services the hotel wants to offer.
5. Open **Room QR**, click **Generate All**, then **Print Posters** or
   **Download PDF**. Each A4 poster contains the hotel name, room number, QR,
   Wi-Fi network name and password, and guest instructions.

`localhost`, `127.0.0.1` and `0.0.0.0` are rejected for guest URLs. A saved
address that is not an address of this computer is also ignored in favour of
the detected Wi-Fi/Ethernet address, so an old IP cannot be printed into new
posters. Use **Use this computer's detected Wi-Fi address** in Settings to fill
the current one. Guests scan
from their own phones, so a loopback URL can never work. Localhost is permitted
only in automated tests (`NODE_ENV=test`) or with the explicit
`NEXUZY_ALLOW_LOOPBACK_GUEST_URL` override.

## Guest portal

After scanning, the guest sees the room number and can:

- browse the live restaurant menu (with database-priced add-ons);
- place a room-service order, which creates KOTs for the kitchen/bar and posts
  exactly once to the room folio;
- follow order and KOT status;
- view the room bill (welcome amenities are never shown as charges);
- request housekeeping, maintenance, amenities, room service or help.

The portal is served only on the hotel LAN. Do not expose it directly to the
public internet; use a VPN or an authenticated reverse proxy if remote access is
ever required.

## Financial rules enforced on the server

- The browser sends menu item ids, quantities and add-on ids only. It never
  sends prices, tax, totals or a payable amount.
- Prices and add-on prices come from the database for the guest's property.
- Restaurant GST is **off by default**. While off, orders post with zero GST.
  When enabled, the server computes GST from the property/room-type settings.
- Guest order submission requires an idempotency key. A retried request returns
  the existing order and does not create a second order, KOT or folio charge.
- Checkout uses `POST /api/v1/stays/:id/checkout-payment` with only a payment
  method. The server computes local tax, rounding and the amount collected.
- Local tax is charged once per eligible guest-night using deterministic
  ledger keys (`local-tax:<stayId>:<date>`), including at check-in, extension
  and checkout catch-up.
- Optional rounding is to the nearest whole rupee and is posted as its own
  `rounding` ledger entry.
- Checkout issues the final invoice and receipt, closes the stay and folio,
  creates the housekeeping task and revokes the guest session.

## API summary

Guest endpoints (header `X-Guest-Session: <token>` after resolve):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/guest-room/resolve` | Exchange a room QR token for a stay-bound session |
| GET | `/api/v1/guest-room/menu` | Property menu, add-ons and GST visibility |
| GET/POST | `/api/v1/guest-room/orders` | Order history / place an order |
| GET | `/api/v1/guest-room/bill` | Current room bill |
| GET/POST | `/api/v1/guest-room/requests` | Guest requests |

Staff endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/api/v1/room-qr` | List / generate room QRs |
| POST | `/api/v1/room-qr/generate-all` | Generate QRs for every room |
| PATCH | `/api/v1/room-qr/:roomId` | Enable/disable (disable revokes sessions) |
| POST | `/api/v1/room-qr/:roomId/regenerate` | Replace token and revoke old sessions |
| GET | `/api/v1/room-qr/:roomId/poster.png` | Single poster PNG |
| GET | `/api/v1/room-qr/:roomId/poster.pdf` | Single A4 poster PDF |
| GET/PATCH | `/api/v1/guest-requests` | Guest request inbox |

Every staff endpoint is property-scoped: a user can only see or change records
for their own `property_id`.

## Tests

`npm run test:security` covers:

- cross-property settings, rooms, folios, menu items, stock items, reservations
  and check-in attempts;
- every stock movement type, invalid input, insufficient stock, duplicate item
  names, permanent movement ledger and concurrent stock updates;
- local tax per guest-night, checkout idempotency and rounding adjustment;
- room QR generation, disable/rejection, guest ordering, single KOT, single
  folio posting, guest bill isolation, guest requests and checkout session
  revocation;
- the permanent QR working for the next guest without exposing the previous
  guest's bill.
