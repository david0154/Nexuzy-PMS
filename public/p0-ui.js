// Nexuzy PMS — P0 operational UI extensions.
// Loaded after app.js. Booking management, checkout bill confirmation,
// LAN/device panel, system health and update checks.

let managedReservationId = '';
let managedReservationData = null;
let checkoutPreviewState = null;
let lanStatusCache = null;

function money(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------- Booking management ----------
async function openReservationManage(reservationId) {
  managedReservationId = reservationId;
  const container = document.getElementById('reservation-manage-content');
  container.innerHTML = '<div class="text-slate-500 text-xs">Loading booking...</div>';
  openModal('modal-reservation-manage');
  try {
    const data = await api(`/reservations/${reservationId}`);
    managedReservationData = data;
    renderReservationManage(data);
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 text-xs">${err.message}</div>`;
  }
}

function renderReservationManage(data) {
  const r = data.reservation;
  const t = data.totals;
  const docs = data.documents || [];
  const payments = data.payments || [];
  const refunds = data.refunds || [];
  const canEdit = !['checked_out', 'cancelled', 'no_show', 'checked_in'].includes(r.status);
  const container = document.getElementById('reservation-manage-content');

  container.innerHTML = `
    <div class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-800">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-lg font-black text-white">${r.guest_name || 'Guest'}</h4>
          <span class="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-indigo-300 font-mono text-[11px]">${r.booking_reference}</span>
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${getReservationStatusBadge(r.status)}">${String(r.status).replace(/_/g, ' ')}</span>
          <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] uppercase">${(r.payment_status || 'unpaid').replace(/_/g, ' ')}</span>
        </div>
        <p class="text-xs text-slate-400 mt-1">
          ${r.guest_phone || ''} ${r.guest_email ? '· ' + r.guest_email : ''} · ${r.room_type_name}
          ${r.room_number ? '· Room ' + r.room_number : '· Room unassigned'}
        </p>
      </div>
      <div class="text-right">
        <div class="text-[10px] text-slate-500 uppercase font-bold">Booking total</div>
        <div class="text-xl font-mono font-black text-white">${money(t.total_amount)}</div>
        <div class="text-[11px] text-slate-400">Advance ${money(t.net_advance)} · Balance ${money(t.balance_due)}</div>
      </div>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4 text-xs">
      <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-slate-500">Check-in</div><div class="text-white font-mono mt-1">${r.check_in_date}</div></div>
      <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-slate-500">Check-out</div><div class="text-white font-mono mt-1">${r.check_out_date}</div></div>
      <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-slate-500">Nights × rate</div><div class="text-white font-mono mt-1">${data.nights} × ${money(r.rate_per_night)}</div></div>
      <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-slate-500">Advance required</div><div class="text-white font-mono mt-1">${money(r.advance_required)}${r.advance_due_date ? `<div class="text-[10px] text-amber-400">due ${r.advance_due_date}</div>` : ''}</div></div>
    </div>

    ${r.special_requests ? `<div class="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-200"><strong>Special request:</strong> ${r.special_requests}</div>` : ''}

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
        <h5 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Advance &amp; payment ledger</h5>
        ${payments.length ? `<div class="space-y-1.5 text-xs">${payments.map(p => `
          <div class="flex justify-between items-center">
            <div><span class="font-mono text-indigo-300">${p.receipt_number}</span><div class="text-[10px] text-slate-500">${p.payment_method} · ${String(p.created_at).slice(0, 16)}</div></div>
            <div class="font-mono text-emerald-400">${money(p.amount)}</div>
          </div>`).join('')}</div>` : '<div class="text-xs text-slate-500">No advance recorded yet.</div>'}
        ${refunds.length ? `<div class="mt-3 pt-3 border-t border-slate-700 text-xs"><div class="text-[10px] font-bold uppercase text-rose-300 mb-1">Refunds</div>${refunds.map(f => `<div class="flex justify-between"><span class="font-mono">${f.receipt_number}</span><span class="font-mono text-rose-300">-${money(f.amount)}</span></div>`).join('')}</div>` : ''}

        ${!['cancelled', 'checked_out', 'no_show'].includes(r.status) ? `
        <div class="mt-3 pt-3 border-t border-slate-700 space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <input type="number" id="res-adv-amount" class="input-field text-xs" placeholder="Advance amount" min="1">
            <select id="res-adv-method" class="input-field text-xs"><option value="upi">UPI</option><option value="cash">Cash</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="netbanking">Net banking</option></select>
          </div>
          <input type="text" id="res-adv-ref" class="input-field text-xs" placeholder="UPI / card / bank reference (optional)">
          <button onclick="reservationAddAdvance()" class="btn-primary text-xs w-full">Record Advance &amp; Receipt</button>
        </div>` : ''}
      </div>

      <div class="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
        <h5 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Booking documents</h5>
        ${docs.length ? `<div class="space-y-2 text-xs">${docs.map(d => `
          <div class="flex items-center justify-between gap-2 p-2 bg-slate-900/60 rounded-lg border border-slate-700">
            <div>
              <div class="font-mono text-white">${d.document_number}</div>
              <div class="text-[10px] text-slate-500 uppercase">${d.document_type.replace(/_/g, ' ')} · v${d.version} · ${d.delivery_status.replace(/_/g, ' ')}</div>
            </div>
            <div class="flex gap-1">
              <button onclick="viewBookingDocument('${d.id}')" class="px-2 py-1 bg-slate-800 rounded text-indigo-300 text-[10px] font-semibold">View</button>
              <button onclick="sendBookingDocument('${d.id}')" class="px-2 py-1 bg-slate-800 rounded text-emerald-300 text-[10px] font-semibold">Send</button>
            </div>
          </div>`).join('')}</div>` : '<div class="text-xs text-slate-500">No quotation or confirmation issued yet.</div>'}

        <div class="mt-3 pt-3 border-t border-slate-700 space-y-2">
          <button onclick="reservationIssueDocument('booking_quotation')" class="btn-secondary text-xs w-full">Generate Quotation</button>
          <button onclick="reservationIssueDocument('booking_confirmation')" class="btn-secondary text-xs w-full" ${['confirmed', 'checked_in', 'checked_out'].includes(r.status) ? '' : 'disabled title="Confirm the booking first"'}>Generate Confirmation</button>
        </div>
      </div>
    </div>

    ${canEdit ? `
    <div class="mt-4 bg-slate-800/40 border border-slate-700 rounded-xl p-4">
      <h5 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Edit stay &amp; charges</h5>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div><label class="input-label">Check-in</label><input type="date" id="res-edit-in" value="${r.check_in_date}" class="input-field text-xs"></div>
        <div><label class="input-label">Check-out</label><input type="date" id="res-edit-out" value="${r.check_out_date}" class="input-field text-xs"></div>
        <div><label class="input-label">Rate / night</label><input type="number" id="res-edit-rate" value="${r.rate_per_night}" class="input-field text-xs"></div>
      </div>
      <button onclick="reservationEditDates()" class="btn-primary text-xs mt-3">Review &amp; Save Changes</button>
      <p class="text-[10px] text-slate-500 mt-1">If the total changes, you will see the old total, new total, difference and revised balance before saving.</p>
    </div>` : ''}

    <div class="mt-4 flex flex-wrap gap-2">
      <button onclick="downloadReservationBill('${r.id}')" class="btn-secondary text-xs">⬇️ Bill PDF</button>
      <button onclick="whatsappReservationBill('${r.id}')" class="btn-secondary text-xs">💬 WhatsApp Bill</button>
      ${!['checked_out', 'cancelled', 'no_show', 'checked_in'].includes(r.status) ? `<button onclick="extendReservation('${r.id}')" class="btn-secondary text-xs">🌙 Extend Booking</button>` : ''}
      ${['awaiting_advance', 'tentative', 'enquiry'].includes(r.status) ? `<button onclick="reservationConfirmBooking()" class="btn-primary text-xs">Confirm Booking</button>` : ''}
      ${['cancelled', 'no_show'].includes(r.status) ? `<button onclick="reservationReinstate()" class="btn-secondary text-xs">Reinstate Booking</button>` : ''}
      ${!['cancelled', 'checked_out', 'checked_in'].includes(r.status) ? `<button onclick="handleCancelReservation('${r.id}')" class="px-3 py-2 bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white rounded-lg text-xs font-bold border border-rose-500/30">Cancel Booking</button>` : ''}
    </div>
  `;
}

async function reservationAddAdvance() {
  const amount = Number(document.getElementById('res-adv-amount').value);
  if (!amount || amount <= 0) return alert('Enter a valid advance amount');
  const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  try {
    const res = await api(`/reservations/${managedReservationId}/advances`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({
        amount,
        payment_method: document.getElementById('res-adv-method').value,
        transaction_ref: document.getElementById('res-adv-ref').value,
        idempotency_key: key
      })
    });
    alert(res.duplicate ? 'This payment was already recorded.' : `Advance recorded. Receipt ${res.receipt.receipt_number}`);
    loadReservationsData();
    openReservationManage(managedReservationId);
  } catch (err) {
    alert(err.message);
  }
}

async function reservationConfirmBooking() {
  try {
    const res = await api(`/reservations/${managedReservationId}/confirm`, { method: 'POST', body: '{}' });
    alert(`Booking confirmed. ${res.confirmation_document ? 'Confirmation ' + res.confirmation_document.document_number : ''}`);
    loadReservationsData();
    openReservationManage(managedReservationId);
  } catch (err) {
    alert(err.message);
  }
}

async function reservationEditDates() {
  const payload = {
    check_in_date: document.getElementById('res-edit-in').value,
    check_out_date: document.getElementById('res-edit-out').value,
    rate_per_night: Number(document.getElementById('res-edit-rate').value)
  };
  try {
    const res = await api(`/reservations/${managedReservationId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    alert(`Booking updated. Price difference: ${money(res.price_difference)}`);
    loadReservationsData();
    openReservationManage(managedReservationId);
  } catch (err) {
    if (err.data && err.data.requires_confirmation) {
      const s = err.data.change_summary;
      const proceed = confirm(
        `This change affects the booking total.\n\nOld total: ${money(s.old_total)}\n` +
        `New total: ${money(s.new_total)}\nDifference: ${money(s.difference)}\n` +
        `Advance received: ${money(s.advance_received)}\nRevised balance: ${money(s.revised_balance)}\n\nSave the change and issue a revised confirmation?`
      );
      if (!proceed) return;
      try {
        const res = await api(`/reservations/${managedReservationId}`, { method: 'PATCH', body: JSON.stringify({ ...payload, confirm_change: true }) });
        alert(`Booking updated. Price difference: ${money(res.price_difference)}`);
        loadReservationsData();
        openReservationManage(managedReservationId);
      } catch (innerErr) {
        alert(innerErr.message);
      }
    } else {
      alert(err.message);
    }
  }
}

async function reservationReinstate() {
  try {
    await api(`/reservations/${managedReservationId}/reinstate`, { method: 'POST', body: '{}' });
    alert('Booking reinstated');
    loadReservationsData();
    openReservationManage(managedReservationId);
  } catch (err) {
    alert(err.message);
  }
}

async function reservationIssueDocument(type) {
  try {
    const res = await api(`/reservations/${managedReservationId}/documents`, {
      method: 'POST',
      body: JSON.stringify({ document_type: type })
    });
    alert(`Issued ${res.document.document_number}`);
    openReservationManage(managedReservationId);
  } catch (err) {
    alert(err.message);
  }
}

async function viewBookingDocument(docId) {
  try {
    const res = await api(`/reservations/${managedReservationId}/documents/${docId}`);
    renderBookingDocument(res.document);
  } catch (err) {
    alert(err.message);
  }
}

function renderBookingDocument(doc) {
  const p = doc.payload || {};
  window.currentInvoicePdfPath = null;
  const pdfButton = document.getElementById('invoice-download-pdf');
  if (pdfButton) pdfButton.classList.add('hidden');
  document.getElementById('invoice-modal-title').textContent = p.document_label || 'Booking document';
  const rows = (p.payments || []).map(pay => `<tr><td class="py-1 px-2 font-mono">${pay.receipt_number}</td><td class="py-1 px-2">${pay.payment_method}</td><td class="py-1 px-2 text-right font-mono">${money(pay.amount)}</td></tr>`).join('');
  document.getElementById('invoice-printable-content').innerHTML = `
    <div class="pb-4 border-b border-slate-200">
      <div class="flex justify-between items-start">
        <div class="flex items-start gap-3">
          <img src="${p.property && p.property.logo_url ? p.property.logo_url : '/logo.png'}" alt="Hotel logo" class="h-12 w-auto object-contain">
          <div>
          <h2 class="text-xl font-black text-slate-900">${p.property ? p.property.name : 'Nexuzy PMS'}</h2>
          <p class="text-xs text-slate-600">${p.property ? [p.property.address, p.property.city, p.property.state].filter(Boolean).join(', ') : ''}</p>
          <p class="text-xs text-slate-600">${p.property ? p.property.phone + ' · ' + (p.property.email || '') : ''}</p>
          <p class="text-xs font-mono text-slate-800">GSTIN: ${p.property ? (p.property.gstin || 'Unregistered') : '—'}</p>
          </div>
        </div>
        <div class="text-right">
          <div class="inline-block px-3 py-1 bg-slate-100 border border-slate-300 text-slate-800 text-[11px] font-black uppercase tracking-wider rounded">${p.document_label || 'BOOKING DOCUMENT'}</div>
          <div class="mt-2 text-xs font-mono text-slate-700">${doc.document_number}</div>
          <div class="text-xs text-slate-500">Version ${doc.version} · ${String(doc.created_at).slice(0, 10)}</div>
        </div>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4 py-4 text-xs">
      <div>
        <div class="text-[10px] uppercase font-bold text-slate-500">Guest</div>
        <div class="text-slate-900 font-bold">${p.guest ? p.guest.name : ''}</div>
        <div class="text-slate-600">${p.guest ? (p.guest.phone || '') + ' ' + (p.guest.email || '') : ''}</div>
      </div>
      <div class="text-right">
        <div class="text-[10px] uppercase font-bold text-slate-500">Booking</div>
        <div class="font-mono text-slate-900">${p.booking ? p.booking.reference : ''}</div>
        <div class="text-slate-600">${p.booking ? p.booking.room_type : ''} ${p.booking && p.booking.room_number ? '(Room ' + p.booking.room_number + ')' : ''}</div>
        <div class="text-slate-600">${p.booking ? p.booking.check_in_date + ' → ' + p.booking.check_out_date + ' · ' + p.booking.nights + ' night(s)' : ''}</div>
      </div>
    </div>
    <table class="w-full text-xs my-2 border-t border-slate-200">
      <thead><tr class="text-[10px] text-slate-500 uppercase bg-slate-50"><th class="py-2 px-2 text-left">Description</th><th class="py-2 px-2 text-right">Amount</th></tr></thead>
      <tbody class="divide-y divide-slate-100">
        <tr><td class="py-1.5 px-2">Room charges (${p.booking ? p.booking.nights : 0} nights × ${money(p.booking ? p.booking.rate_per_night : 0)})</td><td class="py-1.5 px-2 text-right font-mono">${money(p.price_summary ? p.price_summary.room_total : 0)}</td></tr>
        <tr><td class="py-1.5 px-2">Taxes</td><td class="py-1.5 px-2 text-right font-mono">${money(p.price_summary ? p.price_summary.taxes : 0)}</td></tr>
        <tr><td class="py-1.5 px-2 font-bold">Estimated total</td><td class="py-1.5 px-2 text-right font-mono font-bold">${money(p.price_summary ? p.price_summary.total_amount : 0)}</td></tr>
        <tr><td class="py-1.5 px-2">Advance received</td><td class="py-1.5 px-2 text-right font-mono text-emerald-700">${money(p.price_summary ? p.price_summary.advance_received : 0)}</td></tr>
        <tr><td class="py-1.5 px-2 font-bold">Balance due</td><td class="py-1.5 px-2 text-right font-mono font-bold">${money(p.price_summary ? p.price_summary.balance_due : 0)}</td></tr>
      </tbody>
    </table>
    ${rows ? `<div class="mt-2 text-xs"><div class="font-bold text-slate-600 uppercase text-[10px] mb-1">Advance receipts</div><table class="w-full"><tbody>${rows}</tbody></table></div>` : ''}
    <div class="mt-3 p-3 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-600">
      <strong>Cancellation / refund policy:</strong> ${p.cancellation_policy ? p.cancellation_policy.summary : 'As per property policy.'}
      ${p.cancellation_policy && p.cancellation_policy.advance_due_date ? `<br>Advance due: ${p.cancellation_policy.advance_due_date}` : ''}
    </div>
    <p class="mt-3 text-[10px] text-slate-500">${p.disclaimer || ''}</p>
    <div class="mt-6 pt-3 border-t border-slate-200 flex justify-between text-[11px] text-slate-500">
      <span>${p.contact ? 'Contact: ' + (p.contact.phone || '') + ' ' + (p.contact.email || '') : ''}</span>
      <span>Authorised signatory</span>
    </div>
    <p class="mt-3 text-center text-[10px] text-slate-400">Generated by Nexuzy PMS · Nexuzy Lab</p>
  `;
  document.getElementById('modal-invoice').classList.remove('hidden');
}

async function sendBookingDocument(docId) {
  try {
    const res = await api(`/reservations/${managedReservationId}/documents/${docId}/send`, { method: 'POST', body: '{}' });
    alert(res.message);
    openReservationManage(managedReservationId);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Checkout bill ----------
async function openCheckoutPreview(stayId) {
  try {
    const res = await api(`/stays/${stayId}/checkout-preview`);
    checkoutPreviewState = { stayId, preview: res.preview };
    renderCheckoutPreview(res.preview);
    openModal('modal-checkout');
  } catch (err) {
    alert(err.message);
  }
}

function renderCheckoutPreview(preview) {
  const t = preview.totals;
  const container = document.getElementById('checkout-preview-content');
  const entries = preview.entries || [];
  const posted = preview.restaurant.posted_to_room || [];
  const separate = preview.restaurant.paid_separately || [];

  container.innerHTML = `
    <div class="flex flex-wrap justify-between gap-3 pb-3 border-b border-slate-800">
      <div>
        <div class="flex items-center gap-2">
          <h4 class="text-base font-black text-white">Room ${preview.stay.room_number} · ${preview.stay.guest.name}</h4>
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${preview.bill_confirmed ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${preview.bill_confirmed ? 'Bill confirmed' : 'Awaiting bill confirmation'}</span>
        </div>
        <p class="text-xs text-slate-400 mt-1">${preview.stay.room_type_name} · ${String(preview.stay.check_in_time).slice(0, 16)} → ${preview.stay.expected_check_out} · ${preview.stay.nights} night(s)</p>
        ${preview.stay.booking_reference ? `<p class="text-[11px] text-slate-500 font-mono mt-0.5">Booking ${preview.stay.booking_reference}</p>` : ''}
      </div>
      <div class="text-right">
        <div class="text-[10px] text-slate-500 uppercase font-bold">${t.balance_due > 0 ? 'Balance due' : (t.refund_due > 0 ? 'Refund due' : 'Settled')}</div>
        <div class="text-2xl font-mono font-black ${t.balance_due > 0 ? 'text-rose-400' : (t.refund_due > 0 ? 'text-amber-400' : 'text-emerald-400')}">${money(t.balance_due > 0 ? t.balance_due : t.refund_due)}</div>
      </div>
    </div>

    ${t.balance_due > 0 ? `<div class="mt-3 p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg text-[11px] text-rose-300">Unpaid balance must be settled before checkout, unless an authorised credit policy applies.</div>` : ''}
    ${t.refund_due > 0 ? `<div class="mt-3 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-[11px] text-amber-300">Guest is owed ${money(t.refund_due)}. Process the refund or acknowledge it before checkout.</div>` : ''}

    <div class="mt-4">
      <h5 class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Folio charges</h5>
      <div class="overflow-x-auto rounded-lg border border-slate-800">
        <table class="w-full text-[11px] text-slate-300">
          <thead class="bg-slate-800/70 text-slate-400 uppercase text-[10px]"><tr><th class="px-2 py-2 text-left">Date</th><th class="px-2 py-2 text-left">Source</th><th class="px-2 py-2 text-left">Description</th><th class="px-2 py-2 text-right">Tax</th><th class="px-2 py-2 text-right">Amount</th></tr></thead>
          <tbody class="divide-y divide-slate-800">
            ${entries.length ? entries.map(e => `<tr>
              <td class="px-2 py-1.5 font-mono text-slate-500">${e.date}</td>
              <td class="px-2 py-1.5 uppercase text-[9px] font-bold ${e.reference_type === 'restaurant_order' ? 'text-indigo-300' : 'text-slate-400'}">${e.department.replace(/_/g, ' ')}</td>
              <td class="px-2 py-1.5 text-white">${e.description}</td>
              <td class="px-2 py-1.5 text-right font-mono">${money(e.tax_amount)}</td>
              <td class="px-2 py-1.5 text-right font-mono font-bold">${money(e.total_amount)}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="text-center py-4 text-slate-500">No charges posted</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
      <div class="p-3 bg-slate-800/50 border border-slate-700 rounded-lg">
        <h5 class="text-[10px] font-bold uppercase text-emerald-300 mb-1.5">Restaurant posted to room (payable here)</h5>
        ${posted.length ? posted.map(o => `<div class="flex justify-between text-[11px] py-1 border-b border-slate-700/50 last:border-0">
          <span><span class="font-mono text-white">${o.order_number}</span> <span class="text-slate-500">· ${o.order_type.replace(/_/g, ' ')}</span></span>
          <span class="font-mono text-emerald-300">${money(o.folio_charge)}</span></div>`).join('') : '<div class="text-[11px] text-slate-500">None</div>'}
      </div>
      <div class="p-3 bg-slate-800/50 border border-slate-700 rounded-lg">
        <h5 class="text-[10px] font-bold uppercase text-slate-400 mb-1.5">Paid separately in outlet (not payable here)</h5>
        ${separate.length ? separate.map(o => `<div class="flex justify-between text-[11px] py-1 border-b border-slate-700/50 last:border-0">
          <span><span class="font-mono text-slate-300">${o.bill_number || o.order_number}</span> <span class="text-slate-500">· ${o.settlement_method || ''}</span></span>
          <span class="font-mono text-slate-400">${money(o.total_amount)}</span></div>`).join('') : '<div class="text-[11px] text-slate-500">None</div>'}
        <p class="text-[9px] text-slate-500 mt-2">Informational only. These bills were already settled and are excluded from the hotel checkout amount.</p>
      </div>
    </div>

    <div class="mt-4 p-4 bg-slate-800/60 border border-slate-700 rounded-xl grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
      <div><div class="text-slate-500">Room charges</div><div class="font-mono text-white">${money(t.room_charges)}</div></div>
      <div><div class="text-slate-500">Other charges</div><div class="font-mono text-white">${money(t.other_charges)}</div></div>
      <div><div class="text-slate-500">Discounts / adjustments</div><div class="font-mono text-white">${money(t.discounts_adjustments)}</div></div>
      <div><div class="text-slate-500">Tax</div><div class="font-mono text-white">${money(t.total_tax)}</div></div>
      <div><div class="text-slate-500">Gross charges</div><div class="font-mono font-bold text-white">${money(t.gross_charges)}</div></div>
      <div><div class="text-slate-500">Payments / advances</div><div class="font-mono text-emerald-400">${money(t.total_payments)}</div></div>
      <div><div class="text-slate-500">Refunds</div><div class="font-mono text-rose-300">${money(t.total_refunds)}</div></div>
      <div><div class="text-slate-500">Final balance</div><div class="font-mono font-black text-white">${money(t.balance)}</div></div>
    </div>

    <div class="mt-3 text-[10px] text-slate-500">
      ${(preview.tax_breakdown || []).map(x => `${x.tax_rate}% GST: taxable ${money(x.taxable_value)} · tax ${money(x.tax_amount)} (CGST ${money(x.cgst)} + SGST ${money(x.sgst)})`).join('<br>')}
    </div>

    ${preview.existing_invoice ? `<div class="mt-3 p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-[11px] text-emerald-300">Final invoice already issued: <span class="font-mono font-bold">${preview.existing_invoice.invoice_number}</span></div>` : ''}

    <div class="mt-4 flex flex-wrap gap-2">
      ${!preview.bill_confirmed ? `<button onclick="confirmCheckoutBill()" class="btn-primary text-xs">✅ Confirm Bill Preview</button>` : `<span class="px-3 py-2 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-bold">Bill confirmed by staff</span>`}
      <button onclick="openAddPaymentModal('${preview.folio.id}')" class="btn-secondary text-xs">💵 Record Payment</button>
      <button onclick="whatsappStayBill('${preview.stay.id}')" class="btn-secondary text-xs">💬 WhatsApp Bill</button>
      ${preview.bill_confirmed ? `<button onclick="generateCheckoutInvoice()" class="btn-secondary text-xs">🧾 ${preview.existing_invoice ? 'View Final Invoice' : 'Generate Final Invoice'}</button>` : ''}
      <button onclick="completeCheckout()" class="px-3 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold">🚪 Complete Checkout</button>
    </div>
  `;
}

async function confirmCheckoutBill() {
  if (!checkoutPreviewState) return;
  try {
    await api(`/stays/${checkoutPreviewState.stayId}/checkout-preview/confirm`, { method: 'POST', body: '{}' });
    alert('Bill preview confirmed and snapshotted. Collect any balance, then generate the final invoice.');
    await openCheckoutPreview(checkoutPreviewState.stayId);
  } catch (err) {
    alert(err.message);
  }
}

async function generateCheckoutInvoice() {
  if (!checkoutPreviewState) return;
  try {
    const res = await api(`/stays/${checkoutPreviewState.stayId}/invoice`, { method: 'POST', body: '{}' });
    if (res.duplicate) alert(`Invoice ${res.invoice.invoice_number} already exists. Showing the issued invoice.`);
    showInvoiceDocument(res.invoice);
    await openCheckoutPreview(checkoutPreviewState.stayId);
  } catch (err) {
    if (err.data && err.data.requires_bill_confirmation) {
      alert('Confirm the bill preview before generating the final invoice.');
    } else {
      alert(err.message);
    }
  }
}

async function completeCheckout() {
  if (!checkoutPreviewState) return;
  const preview = checkoutPreviewState.preview;
  if (!preview.bill_confirmed) {
    return alert('Confirm the checkout bill before completing checkout.');
  }
  if (preview.totals.balance_due > 0.004) {
    return alert(`Settle the outstanding balance of ${money(preview.totals.balance_due)} before checkout.`);
  }
  let refundAcknowledged = false;
  if (preview.totals.refund_due > 0.004) {
    refundAcknowledged = confirm(`Guest is owed ${money(preview.totals.refund_due)}. Acknowledge this refund and complete checkout?`);
    if (!refundAcknowledged) return;
  }
  if (!confirm(`Complete checkout for Room ${preview.stay.room_number}? This closes the folio and sends the room to housekeeping.`)) return;

  try {
    const res = await api(`/stays/${checkoutPreviewState.stayId}/check-out`, {
      method: 'POST',
      body: JSON.stringify({ refund_acknowledged: refundAcknowledged })
    });
    alert(`Room ${preview.stay.room_number} checked out.${res.invoice ? '\nInvoice ' + res.invoice.invoice_number : ''}\nHousekeeping notified.`);
    closeModal('modal-checkout');
    checkoutPreviewState = null;
    loadFrontDeskData();
    loadDashboardData();
    loadReservationsData();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Settings: LAN, health, version ----------
async function loadNetworkSettings() {
  try {
    const status = await api('/network/status');
    lanStatusCache = status;
    document.getElementById('lan-enabled').checked = Boolean(status.enabled);
    document.getElementById('lan-port').value = status.port;
    const urlSelect = document.getElementById('lan-url');
    const lanUrls = status.lan_urls && status.lan_urls.length
      ? status.lan_urls
      : (status.addresses || []).map(a => ({ interface: a.interface, address: a.address, url: `http://${a.address}:${status.port}` }));
    urlSelect.innerHTML = lanUrls.length
      ? lanUrls.map((item, index) => `<option value="${item.url}" data-address="${item.address}" ${item.url === status.lan_url || (!status.lan_url && index === 0) ? 'selected' : ''}>${item.url} (${item.interface || 'LAN'})</option>`).join('')
      : '<option value="">No private LAN address found</option>';
    document.getElementById('lan-hostname').textContent = status.host_name;
    document.getElementById('lan-address').textContent = status.addresses.length ? status.addresses.map(a => a.address).join(', ') : 'No private LAN address';
    document.getElementById('lan-current-port').textContent = status.port;
    document.getElementById('lan-active-sessions').textContent = status.active_sessions;
    const badge = document.getElementById('lan-mode-badge');
    badge.textContent = status.enabled ? 'LAN sharing ON' : 'Local only';
    badge.className = `px-2.5 py-1 rounded-lg text-[11px] font-bold border ${status.enabled ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
    const security = document.getElementById('lan-security-badge');
    security.textContent = status.security_mode === 'http_demo' ? 'HTTP demo · not encrypted' : 'HTTPS not available';
    security.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300';
    document.getElementById('lan-warnings').innerHTML = (status.warnings || []).map(w => `<div>⚠ ${w}</div>`).join('');
    await loadLanSessions();
    if (typeof runLanDiagnostics === 'function') runLanDiagnostics();
  } catch (err) {
    console.error('Network settings:', err);
  }
}

async function handleSaveLanConfig(event) {
  event.preventDefault();
  const enabled = document.getElementById('lan-enabled').checked;
  const port = Number(document.getElementById('lan-port').value);
  if (enabled && !confirm('Enable LAN sharing? Other devices on this private network will be able to reach the PMS sign-in page. Never forward this port from your router.')) {
    document.getElementById('lan-enabled').checked = lanStatusCache ? lanStatusCache.enabled : false;
    return;
  }
  try {
    const res = await api('/network/config', {
      method: 'PATCH',
      body: JSON.stringify({ enabled, port })
    });
    alert(res.message);
    await loadNetworkSettings();
  } catch (err) {
    alert(err.message);
    await loadNetworkSettings();
  }
}

function copyLanUrl() {
  const value = document.getElementById('lan-url').value;
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(() => alert('LAN URL copied')).catch(() => prompt('Copy this URL:', value));
  } else {
    prompt('Copy this URL:', value);
  }
}

async function showLanQr() {
  try {
    const select = document.getElementById('lan-url');
    const selected = select && select.selectedOptions ? select.selectedOptions[0] : null;
    const address = selected ? selected.dataset.address : null;
    const res = await api(`/network/qr${address ? `?address=${encodeURIComponent(address)}` : ''}`);
    document.getElementById('lan-qr-img').src = res.data_url;
    document.getElementById('lan-qr-container').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
}

async function loadLanSessions() {
  const container = document.getElementById('lan-sessions-list');
  if (!container) return;
  try {
    const data = await api('/auth/sessions');
    const active = (data.sessions || []).filter(s => s.is_active);
    if (!active.length) {
      container.innerHTML = '<div class="text-slate-500">No active device sessions.</div>';
      return;
    }
    container.innerHTML = active.map(s => `
      <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-lg">
        <div>
          <div class="text-white font-semibold">${s.full_name || s.username} <span class="text-slate-500 font-normal">@${s.username}</span></div>
          <div class="text-[10px] text-slate-500">${s.ip_address || '—'} · last seen ${String(s.last_seen_at || s.created_at).slice(0, 16)}</div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-mono text-slate-500">${String(s.id).slice(0, 8)}</span>
          <button onclick="revokeLanSession('${s.id}')" class="px-2 py-1 bg-rose-600/20 text-rose-300 rounded text-[10px] font-bold border border-rose-500/30">Revoke</button>
        </div>
      </div>`).join('');
  } catch (err) {
    container.innerHTML = `<div class="text-slate-500">${err.message}</div>`;
  }
}

async function revokeLanSession(sessionId) {
  if (!confirm('Revoke this device session? That device will be signed out immediately.')) return;
  try {
    await api(`/auth/sessions/${sessionId}/revoke`, { method: 'POST', body: '{}' });
    await loadLanSessions();
    await loadNetworkSettings();
  } catch (err) {
    alert(err.message);
  }
}

async function loadSystemHealth() {
  const container = document.getElementById('system-health-container');
  try {
    const [health, version] = await Promise.all([api('/system/health'), api('/system/version')]);
    document.getElementById('app-version-badge').textContent = `v${version.version}`;
    const checks = health.checks || {};
    const card = (label, value, status) => {
      const good = ['ok', 'configured', 'lan_enabled', 'local_only'].includes(status);
      const warning = ['none', 'not_configured'].includes(status);
      const color = good
        ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
        : (warning ? 'text-amber-300 border-amber-500/30 bg-amber-500/10' : 'text-rose-300 border-rose-500/30 bg-rose-500/10');
      return `<div class="p-3 rounded-xl border ${color}">
        <div class="text-[10px] uppercase font-bold opacity-70">${label}</div>
        <div class="text-xs font-semibold mt-0.5">${value}</div>
      </div>`;
    };
    container.innerHTML = [
      card('Database', `${checks.database.status} · ${checks.database.latency_ms || 0} ms`, checks.database.status),
      card('Storage', checks.storage.status === 'ok' ? 'Data directory writable' : checks.storage.error, checks.storage.status),
      card('Backups', checks.backups.count ? `${checks.backups.count} backup(s)` : 'No backups yet', checks.backups.status),
      card('Email', checks.email.status === 'configured' ? `SMTP ${checks.email.host}` : 'SMTP not configured', checks.email.status),
      card('Network', `${checks.network.status === 'lan_enabled' ? 'LAN on' : 'Local only'} · port ${checks.network.port}`, checks.network.status),
      card('Background jobs', checks.background_jobs.note, checks.background_jobs.status)
    ].join('');
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 text-xs">${err.message}</div>`;
  }
}

let latestUpdateInfo = null;
let downloadedUpdateInfo = null;

function uiEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function safeLink(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '#';
  } catch (err) {
    return '#';
  }
}

async function loadAboutApp() {
  const target = document.getElementById('about-app-container');
  if (!target) return;
  try {
    const data = await api('/system/about');
    window.__nexuzyAbout = data;
    const developer = data.developer || {};
    const installation = data.installation || {};
    const donation = data.donation || {};
    const platformLabel = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[data.platform] || data.platform;

    const links = [];
    if (developer.website) links.push(`<a class="text-indigo-400 hover:text-indigo-300 underline" href="${uiEscape(safeLink(developer.website))}" target="_blank" rel="noopener">Website</a>`);
    if (developer.email) links.push(`<a class="text-indigo-400 hover:text-indigo-300 underline" href="mailto:${uiEscape(developer.email)}">${uiEscape(developer.email)}</a>`);
    if (data.repository) links.push(`<a class="text-indigo-400 hover:text-indigo-300 underline" href="${uiEscape(safeLink(data.repository.url))}" target="_blank" rel="noopener">GitHub</a>`);

    const donationButton = donation.url
      ? `<a class="btn-primary text-xs inline-block" href="${uiEscape(safeLink(donation.url))}" target="_blank" rel="noopener">Donate / Support</a>`
      : '';
    const upi = donation.upi
      ? `<div class="flex flex-wrap items-center gap-2 mt-2"><span class="text-[11px] text-slate-400">UPI:</span><code class="text-[11px] text-emerald-300 bg-slate-950 border border-slate-700 rounded px-2 py-1">${uiEscape(donation.upi)}</code><button type="button" onclick="copyDonationUpi()" class="btn-secondary text-[11px]">Copy UPI ID</button></div>`
      : '';

    const isAdmin = typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'admin';
    const uninstallBlock = installation.uninstall_available && isAdmin
      ? `<button type="button" onclick="uninstallNexuzyPms()" class="px-3 py-2 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 text-xs font-bold rounded-lg">Uninstall Nexuzy PMS</button>`
      : `<span class="text-[11px] text-slate-500">${installation.uninstall_available ? 'Only an administrator can uninstall this app.' : 'Uninstall is available in the installed Windows, Linux and macOS builds, not when running from source.'}</span>`;

    target.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="p-3 rounded-xl border border-slate-700 bg-slate-800/40">
          <div class="text-[10px] uppercase font-bold text-slate-500">Product</div>
          <div class="text-sm font-bold text-white mt-1">${uiEscape(data.product)}</div>
          <div class="text-[11px] text-slate-400">Version ${uiEscape(data.version)}</div>
        </div>
        <div class="p-3 rounded-xl border border-slate-700 bg-slate-800/40">
          <div class="text-[10px] uppercase font-bold text-slate-500">Developer</div>
          <div class="text-sm font-bold text-white mt-1">${uiEscape(developer.name)}</div>
          <div class="text-[11px] text-slate-400">${uiEscape(developer.lead)} · ${uiEscape(developer.email)}</div>
        </div>
        <div class="p-3 rounded-xl border border-slate-700 bg-slate-800/40">
          <div class="text-[10px] uppercase font-bold text-slate-500">Runtime</div>
          <div class="text-sm font-bold text-white mt-1">${uiEscape(platformLabel)} ${uiEscape(data.arch)}</div>
          <div class="text-[11px] text-slate-400">Node ${uiEscape(data.node)} · ${uiEscape(data.license)} licence</div>
        </div>
        <div class="p-3 rounded-xl border border-slate-700 bg-slate-800/40">
          <div class="text-[10px] uppercase font-bold text-slate-500">Installation</div>
          <div class="text-sm font-bold text-white mt-1">${installation.installed ? 'Installed app' : 'Source / portable'}</div>
          <div class="text-[11px] text-slate-400 break-all">${uiEscape(installation.data_dir || '')}</div>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-3 text-xs">${links.join('<span class="text-slate-700">·</span>')}</div>

      <div class="mt-4 p-4 rounded-xl border border-indigo-500/30 bg-indigo-500/10 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-white">Support Nexuzy PMS</div>
          <div class="text-[11px] text-slate-400 max-w-xl">${uiEscape(donation.note || 'Support ongoing development of Nexuzy PMS.')}</div>
          ${upi}
        </div>
        ${donationButton}
      </div>

      <div class="mt-4 p-4 rounded-xl border border-rose-500/20 bg-rose-500/5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-rose-200">Remove this application</div>
          <div class="text-[11px] text-slate-400 max-w-2xl">Uninstalling removes the app only. Hotel data is kept in <code class="text-slate-300">${uiEscape(installation.data_dir || 'the data folder')}</code>. Take a backup first.</div>
        </div>
        ${uninstallBlock}
      </div>`;
  } catch (err) {
    target.innerHTML = `<div class="text-rose-400">${uiEscape(err.message)}</div>`;
  }
}

async function copyDonationUpi() {
  const upi = window.__nexuzyAbout && window.__nexuzyAbout.donation && window.__nexuzyAbout.donation.upi;
  if (!upi) return alert('No UPI ID is configured for donations.');
  try {
    await navigator.clipboard.writeText(upi);
    alert('UPI ID copied to the clipboard.');
  } catch (err) {
    prompt('Copy this UPI ID:', upi);
  }
}

async function uninstallNexuzyPms() {
  const installation = (window.__nexuzyAbout && window.__nexuzyAbout.installation) || {};
  if (!installation.uninstall_available) {
    return alert('Uninstall is available only in an installed Nexuzy PMS build.');
  }
  const typed = prompt('This removes Nexuzy PMS from this computer. Hotel data will be preserved, but take a backup first.\n\nType UNINSTALL to continue:');
  if (typed !== 'UNINSTALL') {
    if (typed !== null) alert('Uninstall cancelled. The confirmation text must be exactly UNINSTALL.');
    return;
  }
  try {
    const res = await api('/system/uninstall', { method: 'POST', body: JSON.stringify({ confirm: 'UNINSTALL' }) });
    alert(`${res.message}\n\nHotel data remains in:\n${installation.data_dir || 'the data folder'}`);
  } catch (err) {
    alert(err.message);
  }
}

function showUpdateBanner(info) {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  if (!banner || !text) return;
  text.textContent = `Nexuzy PMS v${info.latest_version} is available (you have v${info.current_version}).`;
  banner.classList.remove('hidden');
}

function dismissUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) banner.classList.add('hidden');
}

function openUpdateSettings() {
  dismissUpdateBanner();
  switchTab('settings');
  setTimeout(() => {
    const result = document.getElementById('update-check-result');
    if (result) result.scrollIntoView({ behavior: 'smooth', block: 'center' });
    checkForUpdates();
  }, 300);
}

async function checkForUpdates(options = {}) {
  const target = document.getElementById('update-check-result');
  if (!target) return;
  if (!options.silent) target.textContent = 'Checking the release service...';
  try {
    const res = await api(`/system/update-check${options.useCache ? '' : '?force=1'}`);
    latestUpdateInfo = res;
    if (!res.configured) {
      target.textContent = res.message || 'No release repository is configured.';
      return;
    }
    if (res.checked === false) {
      target.textContent = res.message || 'The release service could not be reached. Local PMS operation is unaffected.';
      return;
    }
    localStorage.setItem('nexuzy_update_checked_at', String(Date.now()));
    if (!res.update_available) {
      target.innerHTML = `<span class="text-emerald-300">You are on the latest version (v${uiEscape(res.current_version)}).</span>`;
      return;
    }

    showUpdateBanner(res);
    const asset = res.recommended_asset;
    target.innerHTML = `
      <div class="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-2">
        <div class="text-sm font-bold text-amber-200">Update available: v${uiEscape(res.latest_version)} <span class="text-slate-400 font-normal">(current v${uiEscape(res.current_version)})</span></div>
        ${res.published_at ? `<div class="text-[11px] text-slate-400">Published ${uiEscape(new Date(res.published_at).toLocaleDateString())}</div>` : ''}
        ${res.notes ? `<details class="text-[11px] text-slate-300"><summary class="cursor-pointer text-indigo-300">Release notes</summary><pre class="whitespace-pre-wrap font-sans mt-2 max-h-40 overflow-auto text-slate-400">${uiEscape(res.notes)}</pre></details>` : ''}
        <div id="update-actions" class="flex flex-wrap items-center gap-2 pt-1">
          ${asset ? `<button type="button" onclick="downloadUpdate()" class="btn-primary text-xs">Download v${uiEscape(res.latest_version)}</button>` : `<span class="text-[11px] text-amber-300">No installer is published for this platform yet.</span>`}
          ${res.release_url ? `<a class="btn-secondary text-xs" href="${uiEscape(safeLink(res.release_url))}" target="_blank" rel="noopener">Open release page</a>` : ''}
        </div>
        <div id="update-action-status" class="text-[11px] text-slate-400"></div>
      </div>`;
  } catch (err) {
    target.textContent = err.message;
  }
}

async function downloadUpdate() {
  const status = document.getElementById('update-action-status');
  if (status) status.textContent = 'Downloading the installer from GitHub...';
  try {
    const res = await api('/system/update/download', { method: 'POST', body: '{}' });
    downloadedUpdateInfo = res;
    if (!status) return;
    status.innerHTML = `${uiEscape(res.message)} <button type="button" onclick="installUpdate()" class="text-indigo-300 underline font-semibold ml-1">Install now</button>`;
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function installUpdate() {
  const status = document.getElementById('update-action-status');
  if (!downloadedUpdateInfo) {
    return alert('Download the update first.');
  }
  if (!confirm('Install this update now? Back up the database first. The app may close while files are replaced.')) return;
  if (status) status.textContent = 'Starting the installer...';
  try {
    const res = await api('/system/update/install', { method: 'POST', body: '{}' });
    if (status) status.textContent = res.message;
    if (res.manual) alert(res.message);
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function maybeAutoCheckUpdates() {
  if (typeof currentUser === 'undefined' || !currentUser || currentUser.role !== 'admin') return;
  const last = Number(localStorage.getItem('nexuzy_update_checked_at') || 0);
  if (Date.now() - last < 24 * 60 * 60 * 1000) return;
  try {
    const res = await api('/system/update-check');
    if (res.checked) {
      localStorage.setItem('nexuzy_update_checked_at', String(Date.now()));
      if (res.update_available) showUpdateBanner(res);
    }
  } catch (err) {
    // Update checks are optional; hotel operations continue without internet.
  }
}
