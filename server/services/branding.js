// Hotel logo storage shared by first-time setup and Settings.
// Images live beside the database (data/uploads) so a property move keeps the
// branding with its data. Only PNG, JPG and WebP are accepted.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1.5 * 1024 * 1024;

function dataDirectory() {
  return process.env.DB_PATH
    ? path.dirname(process.env.DB_PATH)
    : path.join(__dirname, '..', '..', 'data');
}

function saveHotelLogoDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    const error = new Error('Upload a PNG, JPG or WebP image file.');
    error.status = 400;
    throw error;
  }

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) {
    const error = new Error('The selected logo file is empty.');
    error.status = 400;
    throw error;
  }
  if (buffer.length > MAX_BYTES) {
    const error = new Error('Logo must be 1.5 MB or smaller. Resize the image and try again.');
    error.status = 400;
    throw error;
  }

  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const uploadDir = path.join(dataDirectory(), 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `hotel-logo-${Date.now()}.${ext}`;
  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, buffer);

  return { logoUrl: `/uploads/${filename}`, filePath, bytes: buffer.length };
}

function removeUploadedLogo(logoUrl) {
  if (!logoUrl || !String(logoUrl).startsWith('/uploads/')) return;
  const target = path.join(dataDirectory(), String(logoUrl).replace(/^\/+/, ''));
  try {
    fs.rmSync(target, { force: true });
  } catch (err) {
    // A stale logo file is harmless; never fail a settings save because of it.
  }
}

module.exports = { saveHotelLogoDataUrl, removeUploadedLogo, dataDirectory, MAX_BYTES };
