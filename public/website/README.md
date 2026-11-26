# Nexuzy PMS — website & field guide

A static, dependency-free website that is served by the existing Nexuzy PMS Express server.

## Routes

With the PMS running:

- **Homepage:** `https://pms.nexuzy.in`
- **Illustrated field guide:** `http://pms.nexuzy.in/docs.html`

The homepage and guide are also ordinary static files, so they can be opened from a local file server or deployed to any static host. Relative asset paths are used throughout.

## Files

```text
public/website/
├── index.html                 Marketing homepage
├── docs.html                  Complete illustrated guide
├── README.md
└── assets/
    ├── logo.png               Actual Nexuzy PMS logo
    ├── favicon.png
    ├── css/site.css           Shared visual system + print styles
    ├── js/site.js             Homepage gallery, filters, lightbox, nav
    ├── js/docs.js             Guide search, TOC, progress, copy, lightbox
    └── screenshots/           All 17 source screenshots
```

## Screenshot inventory

| File | Screen |
|---|---|
| `dashboard.png` | Operations dashboard |
| `front-desk.png` | Front desk and in-house stays |
| `reservation-app.png` | Reservations workspace |
| `reservation-booking.png` | Create a reservation |
| `rooms-and-rates.png` | Rooms, types and rates |
| `restaurant-menu.png` | Menu management |
| `restaurant-tables.png` | Table bookings and advances |
| `restaurant-order.png` | Restaurant POS and KDS |
| `advance-booking-bill.png` | Advance booking receipt |
| `billing-gst-folio.png` | Guest folio and payments |
| `gst-invoice.png` | India GST tax invoice |
| `expenses.png` | Hotel expense ledger |
| `profit-loss-audit.png` | Profit, GST and audit trail |
| `settings.png` | Settings, backups and integrations |
| `setup-step-1.png` | First-run setup: property |
| `setup-step-2.png` | First-run setup: operations |
| `setup-complete.png` | Setup complete |

All 17 images are used in the homepage gallery and in the guide.

## Editing notes

- There is no build step. Edit the HTML, CSS, or JS directly.
- The homepage gallery data lives in `assets/js/site.js`; the guide content lives in `docs.html`.
- The guide search indexes every section automatically; no separate index needs maintaining.
- Use `Ctrl+P` / the guide’s **Print / save as PDF** action for a printable manual.
- Keep the screenshot filenames stable so the gallery and guide lightboxes continue to resolve.
- The site has no external font or JavaScript dependency and works offline on the same machine as the PMS.
