// Permanent room QR identities and printable A4 posters.
//
// The QR token identifies a room, never a guest. A guest session created after
// scanning is a separate, stay-bound credential.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const network = require('../modules/network/service');

const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '..', '..', 'data');

function newQrToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isLoopbackHost(value) {
  return /^(https?:\/\/)?(localhost|127\.|\[::1\])/i.test(String(value || ''));
}

function configuredHost(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname;
  } catch (err) {
    return '';
  }
}

async function localAddresses() {
  try {
    const status = await network.status();
    return (status.addresses || []).map(a => a.address);
  } catch (err) {
    return [];
  }
}

async function guestPortalInfo(property) {
  const configured = String((property && property.lan_guest_url) || '').trim() || String(process.env.NEXUZY_GUEST_BASE_URL || '').trim();
  const allowLoopback = process.env.NODE_ENV === 'test' || Boolean(process.env.NEXUZY_ALLOW_LOOPBACK_GUEST_URL);
  let warning = null;

  if (configured) {
    if (isLoopbackHost(configured) && !allowLoopback) {
      warning = 'The configured guest address is localhost. Guests cannot scan it; the detected Wi-Fi address is used instead.';
    } else {
      const host = configuredHost(configured);
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      if (isIp) {
        const locals = await localAddresses();
        if (locals.length && !locals.includes(host)) {
          warning = `The configured guest address ${host} is not an address of this computer. The current Wi-Fi/LAN address is used instead. Update Settings to remove this warning.`;
        } else {
          return { base_url: configured.replace(/\/+$/, ''), configured, warning: null };
        }
      } else {
        return { base_url: configured.replace(/\/+$/, ''), configured, warning: null };
      }
    }
  }

  // Never advertise localhost or a stale adapter address to a guest phone.
  try {
    const status = await network.status();
    const candidates = [status.guest_lan_url, status.lan_url, ...(status.lan_urls || []).map(u => u.url)]
      .filter(Boolean)
      .filter(url => !isLoopbackHost(url));
    if (candidates.length) {
      return { base_url: String(candidates[0]).replace(/\/+$/, ''), configured: configured || null, warning };
    }
  } catch (err) {
    // Fall through to the explicit error below.
  }
  return { base_url: null, configured: configured || null, warning: warning || 'No private LAN address is available. Connect this computer to the hotel Wi-Fi/Ethernet.' };
}

async function guestBaseUrl(property) {
  const info = await guestPortalInfo(property);
  return info.base_url;
}

function guestUrl(baseUrl, token) {
  return `${baseUrl}/guest-room.html?qr=${encodeURIComponent(token)}`;
}

function resolveLogoPath(logoUrl) {
  const value = String(logoUrl || '');
  if (value.startsWith('/uploads/')) {
    const candidate = path.join(DATA_DIR, value.replace(/^\/+/, ''));
    return fs.existsSync(candidate) ? candidate : null;
  }
  const pub = path.join(__dirname, '..', '..', 'public', value.replace(/^\/+/, '') || 'logo.png');
  return fs.existsSync(pub) ? pub : null;
}

async function qrPngBuffer(url, width = 1024) {
  return QRCode.toBuffer(url, {
    type: 'png',
    width,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' }
  });
}

function wrapText(doc, text, options) {
  doc.text(String(text || ''), options);
}

/**
 * Streams a print-ready A4 poster (one page per room) to an Express response.
 */
async function streamPosterPdf(res, property, rooms) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Room QR Posters — ${property.name}` } });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 80;
  let first = true;

  for (const room of rooms) {
    if (!first) doc.addPage();
    first = false;

    const baseUrl = room.portal_base_url || await guestBaseUrl(property);
    const url = room.qr_url || (baseUrl ? guestUrl(baseUrl, room.qr_token) : '');
    const qrBuffer = url ? await qrPngBuffer(url, 1200) : null;

    // Header band
    doc.rect(40, 40, contentWidth, 58).fill('#111111');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
      .text(String(property.name || 'HOTEL').toUpperCase(), 55, 51, { width: contentWidth - 30, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#dddddd')
      .text('GUEST SERVICES', 55, 78, { width: contentWidth - 30, align: 'center' });

    const logo = resolveLogoPath(property.logo_url);
    if (logo) {
      try {
        doc.image(logo, 50, 108, { fit: [58, 58], align: 'center', valign: 'center' });
      } catch (err) { /* A missing or unreadable logo must not block printing. */ }
    }

    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(30)
      .text(`ROOM ${room.room_number}`, 40, 108, { width: contentWidth, align: 'center' });
    doc.font('Helvetica').fontSize(11).fillColor('#333333')
      .text('WELCOME TO OUR HOTEL', 40, 146, { width: contentWidth, align: 'center' });

    if (qrBuffer) {
      doc.image(qrBuffer, (pageWidth - 220) / 2, 172, { width: 220, height: 220 });
    } else {
      doc.rect((pageWidth - 220) / 2, 172, 220, 220).strokeColor('#000000').lineWidth(2).stroke();
      doc.fontSize(10).fillColor('#000000')
        .text('QR unavailable: configure the hotel guest portal LAN address in Settings.', (pageWidth - 220) / 2 + 10, 265, { width: 200, align: 'center' });
    }

    let y = 408;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000')
      .text('RESTAURANT ORDERING', 60, y, { width: contentWidth - 40, align: 'center' });
    doc.font('Helvetica').fontSize(9.5).fillColor('#222222')
      .text('Scan here to browse the restaurant menu and order food directly to your room.', 70, y + 17, { width: contentWidth - 60, align: 'center' });

    y += 48;
    doc.font('Helvetica-Bold').fontSize(12)
      .text('HELP & SUPPORT', 60, y, { width: contentWidth - 40, align: 'center' });
    doc.font('Helvetica').fontSize(9.5)
      .text('Scan here to request housekeeping, room service, reception assistance or maintenance.', 70, y + 17, { width: contentWidth - 60, align: 'center' });

    y += 48;
    doc.rect(55, y, contentWidth - 30, 112).strokeColor('#000000').lineWidth(1).stroke();
    doc.font('Helvetica-Bold').fontSize(10.5)
      .text('WI-FI ACCESS', 70, y + 11, { width: contentWidth - 60 });
    const wifiName = String(property.wifi_name || '').trim();
    const wifiPassword = String(property.wifi_password || '').trim();
    if (wifiName || wifiPassword) {
      doc.font('Helvetica').fontSize(9).fillColor('#222222');
      if (wifiName) doc.text(`Network: ${wifiName}`, 70, y + 29, { width: contentWidth - 60 });
      if (wifiPassword) doc.text(`Password: ${wifiPassword}`, 70, y + 43, { width: contentWidth - 60 });
      doc.fontSize(8).fillColor('#555555')
        .text(property.wifi_instructions || 'Connect to this Wi-Fi, then scan the QR code above for room service and dining.', 70, y + 60, { width: contentWidth - 60, lineGap: 1.5 });
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#222222')
        .text(property.wifi_instructions || 'Connect to the hotel Wi-Fi, then scan the QR code above for room service and dining.', 70, y + 29, { width: contentWidth - 60, lineGap: 2 });
    }

    doc.font('Helvetica').fontSize(7.5).fillColor('#555555')
      .text('Powered by Nexuzy PMS', 40, 758, { width: contentWidth, align: 'center' });

    if (property.reception_contact) {
      doc.fontSize(7.5).fillColor('#333333')
        .text(`Reception: ${property.reception_contact}`, 40, 772, { width: contentWidth, align: 'center' });
    }
  }

  doc.end();
}

module.exports = {
  newQrToken,
  guestBaseUrl,
  guestPortalInfo,
  guestUrl,
  qrPngBuffer,
  streamPosterPdf,
  resolveLogoPath
};
