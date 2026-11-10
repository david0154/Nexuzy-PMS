# Nexuzy PMS

**Hotel, Restaurant, Bar, Front Desk, Billing & Property Operations Management System**

Developed by **Nexuzy Lab**  
Lead Developer & Maintainer: **David** ([david@nexuzy.in](mailto:david@nexuzy.in))  
Website: [https://nexuzy.in](https://nexuzy.in)  
Maintenance & Project Support: [https://razorpay.me/@nexuzylab](https://razorpay.me/@nexuzylab)  
License: **MIT**

---

## 🌟 Overview & Vision

**Nexuzy PMS** is a modular, high-performance, open-source property management system designed for hotels, resorts, lodges, guest houses, serviced apartments, and hospitality businesses. It unifies hotel front desk operations with restaurant dining POS, bar orders, room service, GST billing, inventory, and night audit in one lightweight, offline-resilient application.

### Key Architectural Highlights
- **Modular Monolith**: Clean separation between business logic, routes, and transactional SQLite storage.
- **Offline & LAN Resilience**: Built to run entirely on the local property LAN without requiring external cloud subscriptions.
- **Double-Booking Protected**: Strict transactional locking prevents concurrent overlapping room assignments.
- **Independent Room Stays under Group Bookings**: Flagship support for **staggered check-in and checkout** where individual rooms under a group master reservation can arrive and depart on independent schedules.
- **Flexible Billing & India GST Support**: Department-wise invoicing, CGST/SGST/IGST breakdown, SAC codes (`996311` for lodging, `996331` for restaurant), advance deposit receipts, and separate restaurant receipts vs. combined hotel folios.
- **Restaurant "Post to Room"**: Dine-in and room-service charges can be posted directly to occupied guest folios with 5% GST, eliminating duplicate collection.

---

## 🚀 Quickstart Guide

### 1. Requirements
- Node.js LTS (v18+ or v20+)
- npm (v9+ or v10+)

### 2. Installation
```bash
git clone https://github.com/nexuzy-lab/nexuzy-pms.git
cd nexuzy-pms
npm install
```

### 3. Seed Database
Initialize the schema and demo property data (*Grand Nexuzy Hotel & Suites*):
```bash
npm run seed
```

### 4. Start Server & UI
```bash
npm start
```
Open **[http://localhost:5000](http://localhost:5000)** in your browser or connect across the local network using `http://<server-ip>:5000`.

### 5. Run Automated Acceptance Tests
Execute the comprehensive 14-test integration and PRD acceptance test suite:
```bash
npm test
```

---

## 👥 Default Demo Staff Accounts

All demo accounts use the default password: **`admin123`**

| Role | Username | Full Name | Access Scope |
| :--- | :--- | :--- | :--- |
| **Super Admin** | `admin` | David Administrator | Full property setup, audit, financials |
| **General Manager** | `manager` | Priya Sharma | Operations, reports, approvals |
| **Front Desk** | `reception` | Rahul Verma | Check-in, checkout, reservations, folios |
| **Cashier** | `cashier` | Sneha Patel | Shift open/close, billing, payments |
| **Restaurant Captain** | `captain` | Vikram Roy | Tables, dining orders, room service |
| **Kitchen Staff** | `chef` | Chef Sanjeev | Kitchen Display System (KDS), KOTs |
| **Housekeeping** | `housekeeping` | Sunita Bai | Room cleaning board, room status sync |
| **Maintenance** | `maintenance` | Ramesh Kumar | Repairs, out-of-order room controls |
| **Store / Inventory** | `store` | Anil Gupta | Stock register, stock receipts & wastage |

---

## 🏨 Functional Modules

### 1. Front Desk & In-House Stays
- Real-time room rack showing occupied, vacant clean, vacant dirty, and out of order rooms.
- Instant Walk-in Check-in with immediate guest registration, rate selection, and initial deposit receipt.
- Stay checkout with automated unpaid balance checks and automatic checkout cleaning task generation.

### 2. Group Bookings & Staggered Operations (PRD Section 7)
- **Master Group Reservation**: Parent record tracking group planning dates, master folio, and group deposit.
- **Individual Room Stays**: Each room slot has independent occupant details, planned/actual arrival and departure timestamps.
- **Staggered Check-In**: Check-in a subset of rooms (e.g. rooms arriving on day 1), leaving others in expected arrival state without changing group integrity.
- **Staggered Check-Out**: Depart early rooms, optionally transfer their folio balances to the master group folio, and release the rooms to housekeeping dirty while remaining group rooms stay occupied.

### 3. Restaurant POS & Kitchen Display System (KDS) (PRD Section 11 & 34)
- **Table Floor Plan**: Live status of dining tables (Available, Occupied, Reserved).
- **Interactive Menu**: Category filtering, Veg/Non-Veg indicators, 5% Restaurant GST calculation.
- **Kitchen Order Tickets (KOT)**: Send rounds to kitchen/bar station; update preparation status in real-time.
- **Flexible Billing**:
  - *Option 1*: Settle directly by Cash, UPI, or Card for walk-in dining without requiring a hotel room.
  - *Option 2*: **Post to Room** posts food charges directly to an active guest stay's folio, validated against occupied room state.

### 4. Billing, India GST & Guest Folios (PRD Section 12 & 35)
- Itemized charges ledger for Room Rent, Restaurant, Room Service, Laundry, Extra Bed, and Taxes.
- Folio charge transfers (Room Folio ➔ Group Master Folio) with immutable audit records.
- Printable **India GST Tax Invoices** with SAC codes, CGST/SGST 50/50 intra-state split, guest GSTIN, and business details.
- Distinct handling of Booking Confirmation, Advance Deposit Receipt, and Final Tax Invoice.

### 5. Housekeeping & Maintenance (PRD Section 9 & 10)
- Separation of commercial room availability from housekeeping readiness.
- Cleaning status workflow: `Dirty` ➔ `Cleaning` ➔ `Cleaned` ➔ `Inspected Ready`.
- Maintenance tickets can block room commercial availability as `Out of Order` until verified resolved.

### 6. Cashier Shifts & Night Audit (PRD Section 12.4 & 25)
- **Cashier Shifts**: Opening float, cash in drawer, UPI, Card, and Room Postings with variance calculation at shift close.
- **Night Audit Wizard**: Verifies open shifts and pending arrivals, posts nightly room rent and taxes to all occupied folios, advances the property business date by 1 day, and enforces idempotency protection against duplicate execution.

---

## 📡 REST API Summary

All endpoints are versioned under `/api/v1`:

- **Auth**: `POST /auth/login`, `GET /auth/me`, `GET /auth/users`, `POST /auth/users`
- **Rooms**: `GET /rooms`, `POST /rooms`, `PATCH /rooms/:id/status`, `GET /rooms/availability`, `GET /rooms/types`
- **Reservations**: `GET /reservations`, `POST /reservations`, `POST /reservations/:id/cancel`
- **Groups**: `GET /groups`, `POST /groups`, `GET /groups/:id`, `POST /groups/:id/check-in-selected`, `POST /groups/:id/check-out-selected`
- **Front Desk**: `GET /stays/in-house`, `GET /stays/arrivals`, `POST /stays/walk-in`, `POST /stays/:id/check-out`, `POST /stays/:id/room-move`
- **Folios & Invoices**: `GET /folios/:id`, `POST /folios/:id/entries`, `POST /folios/:id/payments`, `POST /folios/:id/transfers`, `POST /folios/:id/invoice`
- **Restaurant**: `GET /restaurant/tables`, `GET /restaurant/menu`, `POST /restaurant/orders`, `POST /restaurant/orders/:id/send-kitchen`, `GET /restaurant/kds`, `POST /restaurant/orders/:id/settle`, `POST /restaurant/orders/:id/post-to-room`
- **Housekeeping**: `GET /housekeeping/tasks`, `POST /housekeeping/tasks`, `PATCH /housekeeping/tasks/:id`
- **Maintenance**: `GET /maintenance/tickets`, `POST /maintenance/tickets`, `PATCH /maintenance/tickets/:id`
- **Cashier**: `GET /cashier/current-shift`, `POST /cashier/open-shift`, `POST /cashier/close-shift`, `GET /cashier/history`
- **Inventory**: `GET /inventory/items`, `POST /inventory/items`, `POST /inventory/movements`
- **Night Audit**: `GET /night-audit/status`, `POST /night-audit/run`
- **Reports**: `GET /reports/dashboard`, `GET /reports/revenue`, `GET /reports/tax`, `GET /reports/audit`

---

## 💖 Community & Maintenance Support

Nexuzy PMS is open-source under the MIT License. Optional financial contributions help Nexuzy Lab maintain, document, and enhance features:  
**Support Maintenance**: [https://razorpay.me/@nexuzylab](https://razorpay.me/@nexuzylab)
