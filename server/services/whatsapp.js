// WhatsApp sharing helpers.
// Bills are shared through web WhatsApp (wa.me / web.whatsapp.com) with a
// pre-filled message. The staff member attaches the downloaded PDF in the
// WhatsApp chat; no WhatsApp Business API account is required.

function normalizePhone(raw, defaultCountryCode = '91') {
  let digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  const code = String(defaultCountryCode || '91').replace(/\D/g, '') || '91';
  if (digits.length === 10) digits = code + digits;
  else if (digits.startsWith('0') && digits.length === 11) digits = code + digits.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return null;
  return digits;
}

function whatsappUrl(phone, message) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(String(message || ''))}`;
}

function formatMoney(value) {
  return `Rs. ${(Number(value) || 0).toFixed(2)}`;
}

module.exports = { normalizePhone, whatsappUrl, formatMoney };
