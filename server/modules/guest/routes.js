// Guest room portal.
//
// A permanent room QR resolves to the room's active occupied stay. The guest
// receives a separate, expiring, stay-bound session token (only its SHA-256
// hash is stored). Every request re-validates the session against the stay,
// room, property and expiry, so changing a room id in the browser cannot expose
// another guest's bill.

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { authenticateToken, requireRoles } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { round2, recalcFolio } = require('../../services/billing');
const { effectiveRestaurantTaxRate, taxConfig } = require('../../services/tax');

const guestRouter = express.Router();
const staffRouter = express.Router();

const SESSION_HOURS = 24;
const REQUEST_CATEGORIES = {
  reception: { label: 'Reception assistance', housekeeping: false },
  housekeeping: { label: 'Housekeeping', housekeeping: true },
  towels: { label: 'Fresh towels', housekeeping: true },
  cleaning: { label: 'Room cleaning', housekeeping: true },
  maintenance: { label: 'Maintenance', housekeeping: false },
  room_service: { label: 'Room service', housekeeping: false },
  general: { label: 'General assistance', housekeeping: false },
  problem: { label: 'Report a problem', housekeeping: false }
};

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function nowSql(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

// Lightweight per-IP throttle for the unauthenticated QR resolution endpoint.
const resolveAttempts = new Map();
function allowResolve(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const entry = resolveAttempts.get(key);
  if (!entry || now - entry.startedAt > windowMs) {
    resolveAttempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= 60;
}

function publicHotel(property) {
  return {
    name: property.name,
    logo_url: property.logo_url,
    currency_symbol: property.currency_symbol || '₹',
    wifi_instructions: property.wifi_instructions ||
      "Please connect your mobile phone to the hotel's Wi-Fi network before using restaurant ordering and guest services.",
    reception_contact: property.reception_contact || property.phone || null,
    emergency_contact: property.emergency_contact || null,
    features: {
      restaurant_ordering: Number(property.guest_order_enabled) === 1,
      room_bill: Number(property.guest_bill_enabled) === 1,
      service_requests: Number(property.guest_service_enabled) === 1,
      help_support: Number(property.guest_help_enabled) === 1
    },
    contacts: {
      reception: property.reception_contact || property.phone || null,
      emergency: property.emergency_contact || null
    }
  };
}

// ------------------------------------------------------------------
// POST /api/v1/guest-room/resolve   { qr_token }
// ------------------------------------------------------------------
guestRouter.post('/resolve', async (req, res) => {
  try {
    if (!allowResolve(req.socket && req.socket.remoteAddress)) {
      return res.status(429).json({ success: false, error: 'Too many attempts. Please wait a few minutes and scan again.' });
    }

    const qrToken = String(req.body.qr_token || req.body.token || '').trim();
    if (!/^[a-f0-9]{32,128}$/i.test(qrToken)) {
      return res.status(400).json({ success: false, error: 'This QR code is not valid. Please contact reception.' });
    }

    const qr = await db.get(
      `SELECT q.*, r.room_number, r.floor, r.building, r.operational_status, r.property_id AS room_property_id,
              p.*
       FROM room_qr_codes q
       JOIN rooms r ON q.room_id = r.id
       JOIN properties p ON q.property_id = p.id
       WHERE q.qr_token = ?`,
      [qrToken]
    );

    if (!qr) return res.status(404).json({ success: false, error: 'This QR code was not recognised. Please contact reception.' });
    if (qr.is_active !== 1) {
      return res.status(403).json({ success: false, error: 'Guest QR access for this room is currently disabled. Please contact reception.' });
    }
    if (qr.room_property_id !== qr.property_id) {
      return res.status(409).json({ success: false, error: 'This QR code is misconfigured. Please contact reception.' });
    }
    if (Number(qr.guest_portal_enabled) !== 1) {
      return res.status(403).json({ success: false, error: 'Guest services are currently disabled. Please contact reception.' });
    }
    if (['out_of_order', 'out_of_service', 'blocked'].includes(qr.operational_status)) {
      return res.status(409).json({ success: false, error: 'This room is not available for guest services. Please contact reception.' });
    }

    const stay = await db.get(
      `SELECT s.*, g.first_name, g.last_name, g.phone AS guest_phone,
              f.id AS folio_id, f.status AS folio_status,
              res.booking_reference
       FROM stays s
       JOIN guests g ON s.primary_guest_id = g.id
       LEFT JOIN folios f ON f.stay_id = s.id
       LEFT JOIN reservations res ON s.reservation_id = res.id
       WHERE s.room_id = ? AND s.property_id = ? AND s.status = 'occupied'
       ORDER BY s.check_in_time DESC LIMIT 1`,
      [qr.room_id, qr.property_id]
    );
    if (!stay) {
      return res.status(409).json({
        success: false,
        error: 'No checked-in guest is staying in this room. Please contact reception to check in.'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = uuidv4();
    await db.transaction(async (conn) => {
      // Keep the session list bounded; checkout revokes everything for the stay.
      const active = await conn.all(
        "SELECT id FROM guest_sessions WHERE stay_id = ? AND status = 'active' ORDER BY created_at DESC",
        [stay.id]
      );
      for (const extra of active.slice(9)) {
        await conn.run("UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?", [extra.id]);
      }
      await conn.run(
        `INSERT INTO guest_sessions
         (id, property_id, room_id, stay_id, guest_id, token_hash, token_prefix, status, expires_at, created_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          sessionId, qr.property_id, qr.room_id, stay.id, stay.primary_guest_id,
          hashToken(token), token.slice(0, 8), nowSql(SESSION_HOURS * 3600 * 1000),
          (req.socket && req.socket.remoteAddress) || null
        ]
      );
    });

    await logAudit({
      propertyId: qr.property_id,
      action: 'GUEST_SESSION_OPENED',
      entityType: 'guest_session',
      entityId: sessionId,
      details: { room_number: qr.room_number, stay_number: stay.stay_number },
      req
    });

    res.json({
      success: true,
      session_token: token,
      expires_in_hours: SESSION_HOURS,
      hotel: publicHotel(qr),
      room: {
        number: qr.room_number,
        floor: qr.floor,
        building: qr.building
      },
      guest: {
        name: `${stay.first_name || ''} ${stay.last_name || ''}`.trim() || 'Guest'
      },
      stay: {
        stay_number: stay.stay_number,
        booking_reference: stay.booking_reference,
        check_in_time: stay.check_in_time,
        expected_check_out: stay.expected_check_out
      }
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// Guest session middleware
// ------------------------------------------------------------------
async function requireGuest(req, res, next) {
  try {
    const header = req.headers['x-guest-session'];
    const bearer = req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const token = String(header || bearer || req.query.token || (req.body && req.body.guest_token) || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(401).json({ success: false, error: 'Guest session required. Please scan your room QR again.' });
    }

    const session = await db.get(
      `SELECT gs.id, gs.property_id, gs.room_id, gs.stay_id, gs.guest_id,
              gs.token_hash, gs.status, gs.expires_at, gs.revoked_at,
              s.status AS stay_status, s.check_in_time, s.expected_check_out,
              s.adults, s.children, s.primary_guest_id, s.stay_number,
              g.first_name, g.last_name,
              r.room_number, r.operational_status,
              p.name AS prop_name, p.logo_url AS prop_logo_url,
              p.currency_symbol AS prop_currency_symbol,
              p.wifi_instructions AS prop_wifi_instructions,
              p.reception_contact AS prop_reception_contact,
              p.emergency_contact AS prop_emergency_contact,
              p.phone AS prop_phone,
              p.guest_portal_enabled, p.guest_order_enabled, p.guest_bill_enabled,
              p.guest_service_enabled, p.guest_help_enabled,
              p.restaurant_tax_enabled, p.default_restaurant_tax_rate,
              p.local_tax_name, p.local_tax_enabled, p.local_tax_amount,
              p.local_tax_max_guests, p.rounding_enabled, p.room_qr_enabled
       FROM guest_sessions gs
       JOIN stays s ON gs.stay_id = s.id
       JOIN guests g ON s.primary_guest_id = g.id
       JOIN rooms r ON gs.room_id = r.id
       JOIN properties p ON gs.property_id = p.id
       WHERE gs.token_hash = ?`,
      [hashToken(token)]
    );

    if (!session) return res.status(401).json({ success: false, error: 'Guest session is not valid. Please scan your room QR again.' });
    if (session.status !== 'active' || session.revoked_at) {
      return res.status(401).json({ success: false, error: 'Your guest session has ended. Please scan your room QR again.' });
    }
    if (new Date(String(session.expires_at).replace(' ', 'T') + 'Z').getTime() < Date.now()) {
      await db.run("UPDATE guest_sessions SET status = 'expired' WHERE id = ?", [session.id]);
      return res.status(401).json({ success: false, error: 'Your guest session has expired. Please scan your room QR again.' });
    }
    if (session.stay_status !== 'occupied') {
      await db.run("UPDATE guest_sessions SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE stay_id = ?", [session.stay_id]);
      return res.status(403).json({ success: false, error: 'This stay has ended. Please contact reception.' });
    }
    if (session.operational_status !== 'occupied') {
      return res.status(403).json({ success: false, error: 'This room is not currently occupied. Please contact reception.' });
    }

    // The session's property, room and stay must all still agree.
    const stay = await db.get(
      'SELECT * FROM stays WHERE id = ? AND room_id = ? AND property_id = ?',
      [session.stay_id, session.room_id, session.property_id]
    );
    if (!stay || stay.status !== 'occupied') {
      return res.status(403).json({ success: false, error: 'This stay is no longer active.' });
    }

    const property = {
      id: session.property_id,
      name: session.prop_name,
      logo_url: session.prop_logo_url,
      currency_symbol: session.prop_currency_symbol,
      wifi_instructions: session.prop_wifi_instructions,
      reception_contact: session.prop_reception_contact,
      emergency_contact: session.prop_emergency_contact,
      phone: session.prop_phone,
      guest_portal_enabled: session.guest_portal_enabled,
      guest_order_enabled: session.guest_order_enabled,
      guest_bill_enabled: session.guest_bill_enabled,
      guest_service_enabled: session.guest_service_enabled,
      guest_help_enabled: session.guest_help_enabled,
      restaurant_tax_enabled: session.restaurant_tax_enabled,
      default_restaurant_tax_rate: session.default_restaurant_tax_rate,
      local_tax_name: session.local_tax_name,
      local_tax_enabled: session.local_tax_enabled,
      local_tax_amount: session.local_tax_amount,
      local_tax_max_guests: session.local_tax_max_guests,
      rounding_enabled: session.rounding_enabled,
      room_qr_enabled: session.room_qr_enabled
    };

    req.guestSession = session;
    req.guestStay = stay;
    req.guestProperty = property;
    db.run(
      `UPDATE guest_sessions SET last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 minute'))`,
      [session.id]
    ).catch(() => {});
    next();
  } catch (err) {
    console.error('[guest-auth]', err.message);
    res.status(503).json({ success: false, error: 'Guest services are temporarily unavailable. Please contact reception.' });
  }
}

guestRouter.use(requireGuest);

// GET /api/v1/guest-room/menu
guestRouter.get('/menu', async (req, res) => {
  try {
    const property = req.guestProperty;
    const categories = await db.all(
      `SELECT id, name, display_order FROM menu_categories
       WHERE property_id = ? AND is_active = 1 ORDER BY display_order ASC, name ASC`,
      [property.id]
    );
    const items = await db.all(
      `SELECT id, category_id, name, description, price, unit, station, tax_rate, is_veg, is_available
       FROM menu_items WHERE property_id = ? AND is_available = 1 ORDER BY name ASC`,
      [property.id]
    );
    const addons = await db.all(
      `SELECT a.id, a.menu_item_id, a.name, a.price
       FROM menu_addons a
       JOIN menu_items i ON a.menu_item_id = i.id
       WHERE i.property_id = ? AND a.is_active = 1 AND i.is_available = 1`,
      [property.id]
    );

    const addonsByItem = new Map();
    for (const addon of addons) {
      if (!addonsByItem.has(addon.menu_item_id)) addonsByItem.set(addon.menu_item_id, []);
      addonsByItem.get(addon.menu_item_id).push(addon);
    }

    res.json({
      success: true,
      ordering_enabled: Number(property.guest_order_enabled) === 1 && Number(property.guest_service_enabled) === 1,
      restaurant_tax_enabled: Number(property.restaurant_tax_enabled) === 1,
      categories,
      items: items.map(item => ({
        ...item,
        tax_rate: effectiveRestaurantTaxRate(property, item),
        addons: addonsByItem.get(item.id) || []
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function orderStatusLabel(tickets, orderStatus) {
  if (orderStatus === 'cancelled') return 'cancelled';
  if (!tickets.length) return 'received';
  const statuses = tickets.map(t => t.status);
  if (statuses.every(s => s === 'cancelled')) return 'cancelled';
  if (statuses.every(s => s === 'served')) return 'served';
  if (statuses.every(s => ['ready', 'served'].includes(s))) return 'ready';
  if (statuses.some(s => s === 'preparing')) return 'preparing';
  if (statuses.some(s => s === 'ready')) return 'ready';
  if (statuses.every(s => s === 'new')) return 'new';
  return statuses[0] || 'new';
}

async function loadGuestOrders(stayId, propertyId) {
  const orders = await db.all(
    `SELECT * FROM restaurant_orders
     WHERE stay_id = ? AND property_id = ? AND order_type = 'room_service'
     ORDER BY created_at DESC LIMIT 100`,
    [stayId, propertyId]
  );
  for (const order of orders) {
    order.items = await db.all(
      'SELECT id, item_name, quantity, unit_price, tax_rate, tax_amount, total_amount, status, notes, addons_json FROM order_items WHERE order_id = ? ORDER BY created_at ASC',
      [order.id]
    );
    order.tickets = await db.all(
      'SELECT kot_number, station, status, round_number, created_at FROM kitchen_tickets WHERE order_id = ? ORDER BY round_number ASC',
      [order.id]
    );
    order.tracking_status = orderStatusLabel(order.tickets, order.status);
  }
  return orders;
}

// GET /api/v1/guest-room/orders
guestRouter.get('/orders', async (req, res) => {
  try {
    const orders = await loadGuestOrders(req.guestStay.id, req.guestProperty.id);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/guest-room/orders
guestRouter.post('/orders', async (req, res) => {
  try {
    const property = req.guestProperty;
    if (Number(property.guest_order_enabled) !== 1) {
      return res.status(403).json({ success: false, error: 'Restaurant ordering is currently disabled. Please call reception.' });
    }

    const key = String(req.headers['idempotency-key'] || req.body.idempotency_key || '').trim() || null;
    if (key) {
      const existing = await db.get(
        'SELECT * FROM restaurant_orders WHERE property_id = ? AND idempotency_key = ?',
        [property.id, key]
      );
      if (existing) {
        return res.json({
          success: true,
          duplicate: true,
          message: 'This order was already received.',
          order: { id: existing.id, order_number: existing.order_number, total_amount: existing.total_amount }
        });
      }
    }

    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) return res.status(400).json({ success: false, error: 'Add at least one item to your order' });
    if (rawItems.length > 40) return res.status(400).json({ success: false, error: 'Too many items in one order' });

    const lines = [];
    for (const raw of rawItems) {
      const menuItem = await db.get(
        'SELECT * FROM menu_items WHERE id = ? AND property_id = ?',
        [raw.menu_item_id, property.id]
      );
      if (!menuItem) throw httpError('One of the selected items is not available at this hotel.');
      if (Number(menuItem.is_available) !== 1) throw httpError(`${menuItem.name} is currently unavailable.`);

      const quantity = Number(raw.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        throw httpError(`Choose a whole quantity between 1 and 50 for ${menuItem.name}.`);
      }
      const notes = raw.notes ? String(raw.notes).slice(0, 250) : null;

      // Add-on prices come from the database, never from the browser.
      const addonIds = Array.isArray(raw.addon_ids) ? [...new Set(raw.addon_ids.map(String))] : [];
      let addonTotal = 0;
      let addonRows = [];
      if (addonIds.length) {
        addonRows = await db.all(
          `SELECT * FROM menu_addons
           WHERE menu_item_id = ? AND is_active = 1
             AND id IN (${addonIds.map(() => '?').join(',')})`,
          [menuItem.id, ...addonIds]
        );
        if (addonRows.length !== addonIds.length) {
          throw httpError(`An add-on for ${menuItem.name} is no longer available.`);
        }
        addonTotal = round2(addonRows.reduce((sum, a) => sum + Number(a.price || 0), 0));
      }

      const unitPrice = round2(menuItem.price);
      const taxRate = effectiveRestaurantTaxRate(property, menuItem);
      const lineSub = round2((unitPrice + addonTotal) * quantity);
      const lineTax = round2(lineSub * (taxRate / 100));
      lines.push({
        menuItem,
        quantity,
        unitPrice,
        taxRate,
        lineSub,
        lineTax,
        total: round2(lineSub + lineTax),
        notes,
        addonRows,
        addonsJson: addonRows.length ? JSON.stringify(addonRows.map(a => ({ id: a.id, name: a.name, price: a.price }))) : null
      });
    }

    const subtotal = round2(lines.reduce((sum, l) => sum + l.lineSub, 0));
    const taxAmount = round2(lines.reduce((sum, l) => sum + l.lineTax, 0));
    const totalAmount = round2(subtotal + taxAmount);

    const result = await db.transaction(async (conn) => {
      const folio = await conn.get(
        'SELECT * FROM folios WHERE stay_id = ? AND property_id = ? ORDER BY created_at DESC LIMIT 1',
        [req.guestStay.id, property.id]
      );
      if (!folio) throw httpError('No room folio was found. Please contact reception.', 409);
      if (folio.status === 'closed') throw httpError('The room folio is closed. Please contact reception.', 409);

      const orderId = uuidv4();
      const orderNumber = `ORD-G-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`;
      await conn.run(
        `INSERT INTO restaurant_orders
         (id, order_number, property_id, order_type, stay_id, room_id, status,
          subtotal, tax_amount, total_amount, waiter_name, guest_name, idempotency_key,
          payment_status, posted_folio_id, settlement_method, settled_at, updated_at)
         VALUES (?, ?, ?, 'room_service', ?, ?, 'active', ?, ?, ?, NULL, ?, ?, 'posted_to_room', ?, 'room_folio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          orderId, orderNumber, property.id, req.guestStay.id, req.guestStay.room_id,
          subtotal, taxAmount, totalAmount,
          `${req.guestSession.first_name || ''} ${req.guestSession.last_name || ''}`.trim() || 'Guest',
          key, folio.id
        ]
      );

      const stations = new Map();
      for (const line of lines) {
        const itemId = uuidv4();
        await conn.run(
          `INSERT INTO order_items
           (id, order_id, menu_item_id, item_name, quantity, unit_price, tax_rate, tax_amount,
            total_amount, status, notes, addons_json, kot_round)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 1)`,
          [
            itemId, orderId, line.menuItem.id, line.menuItem.name, line.quantity,
            line.unitPrice, line.taxRate, line.lineTax, line.total, line.notes, line.addonsJson
          ]
        );
        const station = ['kitchen', 'bar', 'bakery'].includes(line.menuItem.station) ? line.menuItem.station : 'kitchen';
        if (!stations.has(station)) stations.set(station, []);
        stations.get(station).push({ ...line, orderItemId: itemId });
      }

      const kotNumbers = [];
      for (const [station, stationLines] of stations.entries()) {
        const kotId = uuidv4();
        const kotNumber = `KOT-G-${Date.now().toString().slice(-6)}-${station.slice(0, 1).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`;
        kotNumbers.push(kotNumber);
        await conn.run(
          `INSERT INTO kitchen_tickets
           (id, kot_number, order_id, table_id, room_id, station, status, round_number, notes, created_by)
           VALUES (?, ?, ?, NULL, ?, ?, 'new', 1, ?, NULL)`,
          [kotId, kotNumber, orderId, req.guestStay.room_id, station, `Guest QR order ${orderNumber}`]
        );
        for (const line of stationLines) {
          await conn.run('UPDATE order_items SET kot_id = ? WHERE id = ?', [kotId, line.orderItemId]);
        }
      }

      // Post exactly once to the guest's own folio.
      const taxLabelRate = lines.length ? lines[0].taxRate : 0;
      await conn.run(
        `INSERT INTO folio_entries
         (id, folio_id, date, department, description, quantity, unit_price, tax_rate, tax_amount,
          total_amount, reference_id, reference_type, created_by, idempotency_key)
         VALUES (?, ?, date('now'), 'room_service', ?, 1, ?, ?, ?, ?, ?, 'restaurant_order', NULL, ?)`,
        [
          uuidv4(), folio.id, `Restaurant Order ${orderNumber} (guest QR)`,
          subtotal, taxLabelRate, taxAmount, totalAmount, orderId, `restaurant-order:${orderId}`
        ]
      );

      await conn.run(
        `UPDATE restaurant_orders
         SET status = 'posted_to_room', posted_folio_id = ?, payment_status = 'posted_to_room',
             settlement_method = 'room_folio', settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [folio.id, orderId]
      );

      await recalcFolio(conn, folio.id);
      if (key) {
        await conn.run(
          `INSERT OR IGNORE INTO idempotency_records (id, property_id, scope, idempotency_key, reference_id)
           VALUES (?, ?, 'guest_order', ?, ?)`,
          [uuidv4(), property.id, key, orderId]
        );
      }

      return { orderId, orderNumber, kotNumbers, folioId: folio.id };
    });

    await logAudit({
      propertyId: property.id,
      action: 'GUEST_RESTAURANT_ORDER',
      entityType: 'restaurant_order',
      entityId: result.orderId,
      details: {
        order_number: result.orderNumber,
        room_number: req.guestSession.room_number,
        stay_id: req.guestStay.id,
        total_amount: totalAmount,
        kot_numbers: result.kotNumbers
      },
      req
    });

    res.json({
      success: true,
      message: 'Order sent to the kitchen. It has been added to your room bill.',
      order: {
        id: result.orderId,
        order_number: result.orderNumber,
        subtotal,
        tax_amount: taxAmount,
        total_amount: totalAmount,
        status: 'new',
        kot_numbers: result.kotNumbers
      }
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, error: err.message });
  }
});

// GET /api/v1/guest-room/bill
guestRouter.get('/bill', async (req, res) => {
  try {
    const property = req.guestProperty;
    if (Number(property.guest_bill_enabled) !== 1) {
      return res.status(403).json({ success: false, error: 'The room bill is not available on the guest portal. Please contact reception.' });
    }

    const folio = await db.get(
      'SELECT * FROM folios WHERE stay_id = ? AND property_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.guestStay.id, property.id]
    );
    if (!folio) {
      return res.json({
        success: true,
        empty: true,
        hotel: publicHotel(property),
        room_number: req.guestSession.room_number,
        currency_symbol: property.currency_symbol || '₹',
        summary: { total_charges: 0, payments_received: 0, balance: 0 }
      });
    }

    const entries = await db.all(
      'SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY date ASC, created_at ASC',
      [folio.id]
    );
    const payments = await db.all(
      `SELECT amount, payment_method, payment_type, receipt_number, created_at
       FROM payments WHERE folio_id = ? AND COALESCE(status, 'posted') = 'posted'
       ORDER BY created_at ASC`,
      [folio.id]
    );
    const refunds = await db.all(
      'SELECT amount, refund_method, reason, receipt_number, created_at FROM payment_refunds WHERE folio_id = ? ORDER BY created_at ASC',
      [folio.id]
    ).catch(() => []);

    const room = entries.filter(e => e.department === 'room_rent');

    // The night audit posts one night at a time, so halfway through a two-night
    // stay the folio held a single night of rent. The guest bill also previews
    // the nights still to be posted so the payable amount covers the whole stay.
    const stayNights = Math.max(1, Math.round(
      (new Date(req.guestStay.expected_check_out) - new Date(req.guestStay.check_in_time)) / 86400000
    ) || 1);
    const postedNights = room.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    const pendingNights = Math.max(0, stayNights - postedNights);
    let projectedRoomCharge = 0;
    if (pendingNights > 0) {
      const rate = Number(req.guestStay.nightly_rate) || 0;
      const lastRoomEntry = room[room.length - 1] || {};
      const taxRate = lastRoomEntry.tax_rate !== undefined
        ? Number(lastRoomEntry.tax_rate) || 0
        : Number(property.default_room_tax_rate) || 0;
      const nightTax = round2(rate * (taxRate / 100));
      projectedRoomCharge = round2((rate + nightTax) * pendingNights);
      room.push({
        date: null,
        description: `Room rent - ${pendingNights} night(s) to be posted by night audit`,
        quantity: pendingNights,
        unit_price: rate,
        tax_rate: taxRate,
        tax_amount: round2(nightTax * pendingNights),
        total_amount: projectedRoomCharge,
        department: 'room_rent',
        pending: true
      });
    }

    const restaurant = entries.filter(e => ['restaurant', 'room_service'].includes(e.department));
    const localTax = entries.filter(e => e.department === 'local_tax');
    const rounding = entries.filter(e => e.department === 'rounding');
    const other = entries.filter(e => !['room_rent', 'restaurant', 'room_service', 'local_tax', 'rounding'].includes(e.department));
    const totalCharges = round2(entries.reduce((sum, e) => sum + Number(e.total_amount || 0), 0) + projectedRoomCharge);
    const totalPaid = round2(payments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
    const totalRefunds = round2(refunds.reduce((sum, r) => sum + Number(r.amount || 0), 0));
    const balance = round2(totalCharges - totalPaid + totalRefunds);

    const simplify = (list) => list.map(e => ({
      date: e.date,
      description: e.description,
      quantity: e.quantity,
      unit_price: e.unit_price,
      tax_rate: e.tax_rate,
      tax_amount: e.tax_amount,
      total_amount: e.total_amount,
      department: e.department,
      pending: Boolean(e.pending)
    }));

    res.json({
      success: true,
      refreshed_at: new Date().toISOString(),
      hotel: publicHotel(property),
      room_number: req.guestSession.room_number,
      stay_number: req.guestStay.stay_number,
      guest_name: `${req.guestSession.first_name || ''} ${req.guestSession.last_name || ''}`.trim() || 'Guest',
      check_in_time: req.guestStay.check_in_time,
      expected_check_out: req.guestStay.expected_check_out,
      stay_nights: stayNights,
      pending_room_nights: pendingNights,
      currency_symbol: property.currency_symbol || '₹',
      folio_status: folio.status,
      charges: {
        room: { lines: simplify(room), total: round2(room.reduce((s, e) => s + Number(e.total_amount || 0), 0)), tax: round2(room.reduce((s, e) => s + Number(e.tax_amount || 0), 0)) },
        restaurant: { lines: simplify(restaurant), total: round2(restaurant.reduce((s, e) => s + Number(e.total_amount || 0), 0)), tax: round2(restaurant.reduce((s, e) => s + Number(e.tax_amount || 0), 0)) },
        local_tax: { name: property.local_tax_name || 'Local Tax', lines: simplify(localTax), total: round2(localTax.reduce((s, e) => s + Number(e.total_amount || 0), 0)) },
        other: { lines: simplify(other), total: round2(other.reduce((s, e) => s + Number(e.total_amount || 0), 0)) },
        rounding_adjustment: round2(rounding.reduce((s, e) => s + Number(e.total_amount || 0), 0))
      },
      payments: payments.map(p => ({
        receipt_number: p.receipt_number,
        amount: p.amount,
        method: p.payment_method,
        type: p.payment_type,
        date: p.created_at
      })),
      refunds,
      summary: {
        room_charges: round2(room.reduce((s, e) => s + Number(e.total_amount || 0), 0)),
        restaurant_charges: round2(restaurant.reduce((s, e) => s + Number(e.total_amount || 0), 0)),
        local_tax: round2(localTax.reduce((s, e) => s + Number(e.total_amount || 0), 0)),
        other_charges: round2(other.reduce((s, e) => s + Number(e.total_amount || 0), 0)),
        total_taxes: round2(entries.reduce((s, e) => s + Number(e.tax_amount || 0), 0)),
        total_charges: totalCharges,
        payments_received: totalPaid,
        refunds: totalRefunds,
        balance,
        balance_due: balance > 0 ? balance : 0,
        refund_due: balance < 0 ? Math.abs(balance) : 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/guest-room/requests
guestRouter.get('/requests', async (req, res) => {
  try {
    const requests = await db.all(
      `SELECT id, category, description, priority, status, assigned_to, resolution_notes, created_at, completed_at
       FROM guest_requests WHERE stay_id = ? AND property_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      [req.guestStay.id, req.guestProperty.id]
    );
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/guest-room/requests
guestRouter.post('/requests', async (req, res) => {
  try {
    const property = req.guestProperty;
    if (Number(property.guest_service_enabled) !== 1) {
      return res.status(403).json({ success: false, error: 'Guest service requests are currently disabled. Please call reception.' });
    }

    const category = String(req.body.category || '').trim().toLowerCase();
    if (!REQUEST_CATEGORIES[category]) {
      return res.status(400).json({
        success: false,
        error: `Choose a valid request type: ${Object.keys(REQUEST_CATEGORIES).join(', ')}`
      });
    }
    const description = req.body.description ? String(req.body.description).trim().slice(0, 500) : '';
    if (['problem', 'general', 'maintenance'].includes(category) && !description) {
      return res.status(400).json({ success: false, error: 'Please describe what you need help with.' });
    }

    const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body.priority)
      ? req.body.priority
      : (category === 'problem' ? 'high' : 'normal');

    const id = uuidv4();
    await db.transaction(async (conn) => {
      await conn.run(
        `INSERT INTO guest_requests
         (id, property_id, room_id, stay_id, guest_session_id, category, description, priority, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
        [
          id, property.id, req.guestStay.room_id, req.guestStay.id, req.guestSession.id,
          category, description || REQUEST_CATEGORIES[category].label, priority
        ]
      );

      if (REQUEST_CATEGORIES[category].housekeeping) {
        await conn.run(
          `INSERT INTO housekeeping_tasks
           (id, property_id, room_id, task_type, status, priority, notes)
           VALUES (?, ?, ?, 'guest_request', 'dirty', ?, ?)`,
          [uuidv4(), property.id, req.guestStay.room_id, priority, `Guest request: ${REQUEST_CATEGORIES[category].label}${description ? ' — ' + description : ''}`]
        );
      }
    });

    await logAudit({
      propertyId: property.id,
      action: 'GUEST_SERVICE_REQUEST',
      entityType: 'guest_request',
      entityId: id,
      details: { category, priority, room_number: req.guestSession.room_number, stay_id: req.guestStay.id },
      req
    });

    res.status(201).json({
      success: true,
      message: 'Your request has been sent to the hotel team.',
      request: {
        id,
        category,
        category_label: REQUEST_CATEGORIES[category].label,
        status: 'pending',
        priority
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// Staff guest-request inbox
// ------------------------------------------------------------------
const REQUEST_ROLES = ['admin', 'general_manager', 'front_desk', 'reception', 'housekeeping', 'maintenance', 'cashier'];

staffRouter.get('/guest-requests', authenticateToken, requireRoles(...REQUEST_ROLES), async (req, res) => {
  try {
    const where = ['gr.property_id = ?'];
    const params = [req.user.property_id];
    if (req.query.status) { where.push('gr.status = ?'); params.push(req.query.status); }
    if (req.query.category) { where.push('gr.category = ?'); params.push(req.query.category); }
    if (req.query.room_number) { where.push('r.room_number = ?'); params.push(req.query.room_number); }

    const requests = await db.all(
      `SELECT gr.*, r.room_number, s.stay_number, u.full_name AS assigned_to_name,
              g.first_name || ' ' || COALESCE(g.last_name, '') AS guest_name
       FROM guest_requests gr
       JOIN rooms r ON gr.room_id = r.id
       JOIN stays s ON gr.stay_id = s.id
       LEFT JOIN guests g ON s.primary_guest_id = g.id
       LEFT JOIN users u ON gr.assigned_to = u.id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE gr.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                gr.created_at ASC`,
      params
    );
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

staffRouter.patch('/guest-requests/:id', authenticateToken, requireRoles(...REQUEST_ROLES), async (req, res) => {
  try {
    const request = await db.get(
      `SELECT gr.*, r.room_number FROM guest_requests gr
       JOIN rooms r ON gr.room_id = r.id
       WHERE gr.id = ? AND gr.property_id = ?`,
      [req.params.id, req.user.property_id]
    );
    if (!request) return res.status(404).json({ success: false, error: 'Guest request not found' });

    const status = req.body.status || request.status;
    if (!['pending', 'accepted', 'in_progress', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid request status' });
    }
    const assignedTo = req.body.assigned_to !== undefined ? req.body.assigned_to : request.assigned_to;
    if (assignedTo) {
      const user = await db.get(
        'SELECT id FROM users WHERE id = ? AND (property_id = ? OR property_id IS NULL) AND is_active = 1',
        [assignedTo, req.user.property_id]
      );
      if (!user) return res.status(400).json({ success: false, error: 'Assigned staff member is not active in this property' });
    }

    await db.run(
      `UPDATE guest_requests
       SET status = ?, assigned_to = ?, resolution_notes = COALESCE(?, resolution_notes),
           updated_at = CURRENT_TIMESTAMP,
           completed_at = CASE WHEN ? IN ('completed', 'rejected') THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE id = ? AND property_id = ?`,
      [
        status, assignedTo || null,
        req.body.resolution_notes !== undefined ? String(req.body.resolution_notes).slice(0, 1000) : null,
        status, request.id, req.user.property_id
      ]
    );

    await logAudit({
      propertyId: req.user.property_id,
      userId: req.user.id,
      action: 'UPDATE_GUEST_REQUEST',
      entityType: 'guest_request',
      entityId: request.id,
      beforeValue: { status: request.status, assigned_to: request.assigned_to },
      afterValue: { status, assigned_to: assignedTo || null },
      details: { room_number: request.room_number, category: request.category },
      req
    });

    res.json({ success: true, message: `Request marked as ${status.replace(/_/g, ' ')}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { guestRouter, staffRouter };
