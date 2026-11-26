// Shared outbound mail helper. Configuration is read from system_settings so
// credentials are never passed through the client on a resend.
const nodemailer = require('nodemailer');
const db = require('../config/database');

function trim(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// Mail hosts differ in how they treat pasted credentials: a trailing space in a
// password or a "mail.example.com:465" host breaks authentication silently.
// Normalising here keeps every send path (test mail, documents) consistent.
function normalizeSmtpConfig(raw) {
  const config = raw || {};
  let host = trim(config.host);
  host = host.replace(/^smtps?:\/\//i, '').replace(/\/+$/, '');
  const portMatch = host.match(/:(\d+)$/);
  const port = Number(portMatch ? portMatch[1] : config.port) || 587;
  host = host.replace(/:\d+$/, '');

  // Port 465 is implicit TLS. Sending plaintext to it looks like a hung
  // connection ("Greeting never received"), so TLS is forced for that port even
  // when the checkbox was left unticked.
  const secure = port === 465 ? true : config.secure === true || config.secure === 'true' || config.secure === 1;

  return {
    host,
    port,
    secure,
    requireTLS: !secure && port === 587,
    user: trim(config.user),
    // Passwords may legitimately contain spaces, so only outer whitespace is
    // removed (not trimmed inside the value).
    pass: String(config.pass === undefined || config.pass === null ? '' : config.pass).replace(/^\s+|\s+$/g, ''),
    from_email: trim(config.from_email) || trim(config.user)
  };
}

async function getSmtpConfig() {
  const row = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_config'");
  if (!row) return null;
  try {
    const config = normalizeSmtpConfig(JSON.parse(row.setting_value));
    if (!config.host || !config.user) return null;
    return config;
  } catch (err) {
    return null;
  }
}

function createTransport(config) {
  const smtp = normalizeSmtpConfig(config);
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTLS,
    auth: { user: smtp.user, pass: smtp.pass },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000
  });
}

// Turns low-level SMTP failures into something the front desk can act on.
function describeSmtpError(err, config = {}) {
  const code = err && err.code ? String(err.code) : '';
  const response = err && err.response ? String(err.response) : '';
  const message = err && err.message ? String(err.message) : 'Unknown mail error';
  const combined = `${code} ${response} ${message}`;

  if (/EAUTH|535|534|Invalid login|authentication/i.test(combined)) {
    return 'The mail server rejected the username or password. Check the full email address as the username and the mailbox password.';
  }
  if (/ETIMEDOUT|Greeting never received|timeout/i.test(combined) && Number(config.port) === 465) {
    return 'Port 465 needs SSL/TLS. Tick "Use SSL/TLS" (it is enabled automatically for port 465 after this update) and try again.';
  }
  if (/ETIMEDOUT|Greeting never received|timeout/i.test(combined)) {
    return 'The mail server did not answer in time. Check the SMTP host, the port and whether the provider blocks outgoing mail.';
  }
  if (/ECONNECTION|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/i.test(combined)) {
    return `Could not connect to ${config.host || 'the mail server'}. Check the SMTP host and port.`;
  }
  if (/self.signed|certificate|CERT_/i.test(combined)) {
    return 'The mail server certificate could not be verified. Ask the mail provider for a valid TLS certificate.';
  }
  if (/EENVELOPE|553|550|Recipient address rejected/i.test(combined)) {
    return `The mail server rejected the recipient or sender address. "${config.from_email || config.user || ''}" must be a mailbox on this server.`;
  }
  return message;
}

async function sendMail(config, message) {
  const smtp = normalizeSmtpConfig(config);
  const transporter = createTransport(smtp);
  const { from_name: fromName, ...rest } = message;
  return transporter.sendMail({
    from: `"${fromName || 'Nexuzy PMS'}" <${smtp.from_email || smtp.user}>`,
    ...rest
  });
}

async function verifySmtp(config) {
  const smtp = normalizeSmtpConfig(config);
  const transporter = createTransport(smtp);
  await transporter.verify();
  return smtp;
}

async function sendDocumentEmail({ to, subject, html, text, attachments = [] }) {
  const config = await getSmtpConfig();
  if (!config) {
    return { sent: false, reason: 'SMTP is not configured' };
  }
  if (!to) {
    return { sent: false, reason: 'Guest email address is not available' };
  }
  const property = await db.get('SELECT name FROM properties LIMIT 1');
  const hotelName = property ? property.name : 'Nexuzy PMS';
  try {
    await sendMail(config, {
      from_name: hotelName,
      to,
      subject,
      text,
      html,
      attachments
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: describeSmtpError(err, config), error: err.message };
  }
}

module.exports = {
  getSmtpConfig,
  createTransport,
  normalizeSmtpConfig,
  describeSmtpError,
  sendMail,
  verifySmtp,
  sendDocumentEmail
};
