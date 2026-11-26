// Shared outbound mail helper. Configuration is read from system_settings so
// credentials are never passed through the client on a resend.
const nodemailer = require('nodemailer');
const db = require('../config/database');

async function getSmtpConfig() {
  const row = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_config'");
  if (!row) return null;
  try {
    const config = JSON.parse(row.setting_value);
    if (!config.host || !config.user) return null;
    return config;
  } catch (err) {
    return null;
  }
}

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: Number(config.port) || 587,
    secure: Boolean(config.secure),
    auth: { user: config.user, pass: config.pass }
  });
}

async function sendDocumentEmail({ to, subject, html, text }) {
  const config = await getSmtpConfig();
  if (!config) {
    return { sent: false, reason: 'SMTP is not configured' };
  }
  if (!to) {
    return { sent: false, reason: 'Guest email address is not available' };
  }
  const transporter = createTransport(config);
  const property = await db.get('SELECT name FROM properties LIMIT 1');
  const hotelName = property ? property.name : 'Nexuzy PMS';
  await transporter.sendMail({
    from: `"${hotelName}" <${config.from_email || config.user}>`,
    to,
    subject,
    text,
    html
  });
  return { sent: true };
}

module.exports = { getSmtpConfig, createTransport, sendDocumentEmail };
