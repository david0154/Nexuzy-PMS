// Nexuzy PMS — Room QR management, printable posters and tax/guest settings.
// Loaded after app.js.

let roomQrState = { rooms: [], selected: new Set(), data: null, posterRoom: null };

function qrMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function qrEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function qrAuthFetch(path, options = {}) {
  const token = localStorage.getItem('nexuzy_token');
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    handleLogout();
    throw new Error('Session expired. Please log in again.');
  }
  if (!response.ok) {
    let message = 'Request failed';
    try { message = (await response.json()).error || message; } catch (err) { /* binary error */ }
    throw new Error(message);
  }
  return response;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function openBlobForPrint(blob) {
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    alert('Allow pop-ups for Nexuzy PMS to open the printable poster, then print from the PDF viewer.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

async function suggestGuestLanUrl() {
  const input = document.getElementById('guest-lan-url');
  const hint = document.getElementById('guest-lan-hint');
  if (!input) return;
  try {
    const status = await api('/network/status');
    const detected = status.guest_lan_url || status.lan_url;
    if (!detected) {
      if (hint) hint.textContent = 'No private LAN address detected. Connect this computer to the hotel Wi-Fi or Ethernet, then try again.';
      return;
    }
    input.value = detected;
    if (hint) hint.textContent = `Detected ${detected}. Save the configuration, then regenerate or reprint room QR posters.`;
  } catch (err) {
    if (hint) hint.textContent = err.message;
  }
}

function updateLocalTaxPreview() {
  const preview = document.getElementById('tax-local-preview');
  if (!preview) return;
  const amount = Number((document.getElementById('tax-local-amount') || {}).value || 0);
  const cap = Number((document.getElementById('tax-local-max-guests') || {}).value || 0);
  const guests = cap > 0 ? cap : 3;
  preview.textContent = amount > 0
    ? `Example: ₹${amount} × ${guests} guest${guests === 1 ? '' : 's'} × 3 nights = ₹${(amount * guests * 3).toLocaleString('en-IN')}`
    : 'Enter an amount per guest per night to see the calculation.';
}

document.addEventListener('DOMContentLoaded', () => {
  ['tax-local-amount', 'tax-local-max-guests'].forEach(id => {
    const field = document.getElementById(id);
    if (field) field.addEventListener('input', updateLocalTaxPreview);
  });
  updateLocalTaxPreview();
});

async function loadRoomQrManagement() {
  const tbody = document.getElementById('tbody-room-qr');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-6 text-center text-slate-500 text-xs">Loading room QR codes…</td></tr>';
  try {
    const data = await api('/room-qr');
    roomQrState.data = data;
    roomQrState.rooms = data.rooms || [];
    roomQrState.selected = new Set();

    const summary = document.getElementById('roomqr-summary');
    if (summary) {
      const s = data.summary || {};
      summary.innerHTML = `
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-[10px] uppercase text-slate-500 font-bold">Rooms</div><div class="text-xl font-black text-white mt-1">${s.total || 0}</div></div>
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-[10px] uppercase text-slate-500 font-bold">Active QR</div><div class="text-xl font-black text-emerald-400 mt-1">${s.active || 0}</div></div>
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-[10px] uppercase text-slate-500 font-bold">Disabled</div><div class="text-xl font-black text-amber-400 mt-1">${s.disabled || 0}</div></div>
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700"><div class="text-[10px] uppercase text-slate-500 font-bold">Not generated</div><div class="text-xl font-black text-slate-300 mt-1">${s.not_generated || 0}</div></div>`;
    }

    const warning = document.getElementById('roomqr-warning');
    if (warning) {
      if (!data.portal_base_url) {
        warning.classList.remove('hidden');
        warning.textContent = data.portal_warning || 'No private LAN guest address is configured. Connect this computer to the hotel Wi-Fi/Ethernet before generating QR codes. Guest URLs never use localhost.';
      } else if (data.portal_warning) {
        warning.classList.remove('hidden');
        warning.textContent = data.portal_warning;
      } else {
        warning.classList.add('hidden');
      }
    }
    const baseLabel = document.getElementById('roomqr-base-url');
    if (baseLabel) baseLabel.textContent = data.portal_base_url || 'Not configured';

    const floorSelect = document.getElementById('roomqr-floor-filter');
    const buildingSelect = document.getElementById('roomqr-building-filter');
    if (floorSelect && floorSelect.options.length <= 1) {
      [...new Set(roomQrState.rooms.map(r => r.floor).filter(Boolean))].sort().forEach(floor => {
        floorSelect.insertAdjacentHTML('beforeend', `<option value="${qrEscape(floor)}">${qrEscape(floor)}</option>`);
      });
    }
    if (buildingSelect && buildingSelect.options.length <= 1) {
      [...new Set(roomQrState.rooms.map(r => r.building).filter(Boolean))].sort().forEach(building => {
        buildingSelect.insertAdjacentHTML('beforeend', `<option value="${qrEscape(building)}">${qrEscape(building)}</option>`);
      });
    }

    renderRoomQrTable();
    loadGuestRequestInbox();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-rose-400 text-xs">${qrEscape(err.message)}</td></tr>`;
  }
}

function qrStatusBadge(status) {
  if (status === 'active') return '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Active</span>';
  if (status === 'disabled') return '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">Disabled</span>';
  return '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">Not Generated</span>';
}

function renderRoomQrTable() {
  const tbody = document.getElementById('tbody-room-qr');
  if (!tbody) return;
  const search = (document.getElementById('roomqr-search')?.value || '').toLowerCase().trim();
  const floor = document.getElementById('roomqr-floor-filter')?.value || '';
  const building = document.getElementById('roomqr-building-filter')?.value || '';

  const rows = roomQrState.rooms.filter(room => {
    if (search && !String(room.room_number).toLowerCase().includes(search)) return false;
    if (floor && room.floor !== floor) return false;
    if (building && room.building !== building) return false;
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-6 text-center text-slate-500 text-xs">No rooms match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(room => `
    <tr class="hover:bg-slate-800/40">
      <td class="px-4 py-3">
        <input type="checkbox" data-qr-select="${room.room_id}" ${roomQrState.selected.has(room.room_id) ? 'checked' : ''} class="h-3.5 w-3.5 accent-indigo-500">
      </td>
      <td class="px-4 py-3 font-bold text-white">Room ${qrEscape(room.room_number)}</td>
      <td class="px-4 py-3 text-slate-400">${qrEscape(room.floor || '—')}</td>
      <td class="px-4 py-3 text-slate-400">${qrEscape(room.building || '—')}</td>
      <td class="px-4 py-3">${qrStatusBadge(room.qr_status)}<div class="text-[10px] text-slate-500 mt-1">${room.generated_at ? qrEscape(String(room.generated_at).slice(0, 10)) : '—'}</div></td>
      <td class="px-4 py-3">
        <div class="flex flex-wrap justify-end gap-1.5">
          ${room.qr_status === 'not_generated'
            ? `<button onclick="generateRoomQr('${room.room_id}')" class="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold">Generate</button>`
            : `
              <button onclick="previewRoomQr('${room.room_id}')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold">View</button>
              <button onclick="downloadRoomQr('${room.room_id}','pdf')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold">Print</button>
              <button onclick="downloadRoomQr('${room.room_id}','png')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold">PNG</button>
              <button onclick="toggleRoomQr('${room.room_id}', ${room.qr_status === 'active' ? 'false' : 'true'})" class="px-2 py-1 rounded ${room.qr_status === 'active' ? 'bg-amber-600/80 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'} text-white text-[10px] font-bold">${room.qr_status === 'active' ? 'Disable' : 'Enable'}</button>
              <button onclick="regenerateRoomQr('${room.room_id}', '${qrEscape(room.room_number)}')" class="px-2 py-1 rounded bg-rose-700/80 hover:bg-rose-600 text-white text-[10px] font-bold">Rotate</button>`
          }
        </div>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-qr-select]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) roomQrState.selected.add(input.dataset.qrSelect);
      else roomQrState.selected.delete(input.dataset.qrSelect);
    });
  });
}

async function generateRoomQr(roomId) {
  try {
    const res = await api('/room-qr/generate', { method: 'POST', body: JSON.stringify({ room_ids: [roomId] }) });
    alert(res.message);
    await loadRoomQrManagement();
  } catch (err) { alert(err.message); }
}

async function generateAllRoomQr() {
  if (!confirm('Generate permanent QR codes for every room that does not have one yet?')) return;
  try {
    const res = await api('/room-qr/generate-all', { method: 'POST', body: JSON.stringify({}) });
    alert(res.message);
    await loadRoomQrManagement();
  } catch (err) { alert(err.message); }
}

async function generateSelectedRoomQr() {
  const ids = [...roomQrState.selected];
  if (!ids.length) return alert('Select at least one room first.');
  try {
    const res = await api('/room-qr/generate', { method: 'POST', body: JSON.stringify({ room_ids: ids }) });
    alert(res.message);
    await loadRoomQrManagement();
  } catch (err) { alert(err.message); }
}

async function toggleRoomQr(roomId, enable) {
  try {
    const res = await api(`/room-qr/${roomId}`, { method: 'PATCH', body: JSON.stringify({ is_active: enable }) });
    alert(res.message);
    await loadRoomQrManagement();
  } catch (err) { alert(err.message); }
}

async function disableSelectedRoomQr() {
  const ids = [...roomQrState.selected];
  if (!ids.length) return alert('Select at least one room first.');
  if (!confirm(`Disable guest QR access for ${ids.length} room(s)? Printed posters for these rooms will stop working.`)) return;
  try {
    for (const id of ids) {
      await api(`/room-qr/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
    }
    alert('Selected room QR access disabled.');
    await loadRoomQrManagement();
  } catch (err) { alert(err.message); }
}

async function regenerateRoomQr(roomId, roomNumber) {
  if (!confirm(`Rotate the QR for Room ${roomNumber}? The old printed poster will stop working and must be replaced.`)) return;
  try {
    const res = await api(`/room-qr/${roomId}/regenerate`, { method: 'POST', body: JSON.stringify({}) });
    alert(res.message);
    await loadRoomQrManagement();
  } catch (err) { alert(err.message); }
}

async function downloadRoomQr(roomId, format) {
  try {
    const response = await qrAuthFetch(`/room-qr/${roomId}/poster?format=${format}`);
    const blob = await response.blob();
    const room = roomQrState.rooms.find(r => r.room_id === roomId);
    const name = `room-${room ? room.room_number : roomId}-qr.${format === 'png' ? 'png' : 'pdf'}`;
    saveBlob(blob, name);
  } catch (err) { alert(err.message); }
}

async function downloadSelectedRoomQr() {
  const ids = roomQrState.selected.size ? [...roomQrState.selected] : roomQrState.rooms.filter(r => r.qr_token || r.qr_status !== 'not_generated').map(r => r.room_id);
  if (!ids.length) return alert('No generated QR codes to print.');
  try {
    const response = await qrAuthFetch('/room-qr/posters/pdf', {
      method: 'POST',
      body: JSON.stringify({ room_ids: ids })
    });
    const blob = await response.blob();
    saveBlob(blob, 'nexuzy-room-qr-posters.pdf');
  } catch (err) { alert(err.message); }
}

async function printSelectedRoomQr() {
  const ids = roomQrState.selected.size ? [...roomQrState.selected] : roomQrState.rooms.filter(r => r.qr_status !== 'not_generated').map(r => r.room_id);
  if (!ids.length) return alert('No generated QR codes to print.');
  try {
    const response = await qrAuthFetch('/room-qr/posters/pdf', {
      method: 'POST',
      body: JSON.stringify({ room_ids: ids })
    });
    openBlobForPrint(await response.blob());
  } catch (err) { alert(err.message); }
}

async function previewRoomQr(roomId) {
  try {
    roomQrState.posterRoom = roomQrState.rooms.find(r => r.room_id === roomId) || null;
    const info = await api(`/room-qr/${roomId}`);
    const qr = info.qr || {};
    const img = document.getElementById('qr-poster-img');
    const link = document.getElementById('qr-portal-link');
    const meta = document.getElementById('qr-poster-meta');
    const response = await qrAuthFetch(`/room-qr/${roomId}/poster?format=png`);
    const blob = await response.blob();
    if (img) img.src = URL.createObjectURL(blob);
    if (link) {
      link.textContent = qr.portal_url || 'Guest portal address not configured';
      link.href = qr.portal_url || '#';
      link.target = '_blank';
      link.rel = 'noopener';
    }
    if (meta) meta.textContent = `Room ${qr.room_number || ''} · ${qr.operational_status || ''} · ${qr.qr_status || ''}`;
    openModal('modal-qr-poster');
  } catch (err) { alert(err.message); }
}

function printCurrentRoomQr() {
  if (!roomQrState.posterRoom) return;
  downloadRoomQr(roomQrState.posterRoom.room_id, 'pdf');
}

function selectAllRoomQr(checked) {
  const visibleIds = roomQrState.rooms
    .filter(room => {
      const search = (document.getElementById('roomqr-search')?.value || '').toLowerCase().trim();
      const floor = document.getElementById('roomqr-floor-filter')?.value || '';
      const building = document.getElementById('roomqr-building-filter')?.value || '';
      if (search && !String(room.room_number).toLowerCase().includes(search)) return false;
      if (floor && room.floor !== floor) return false;
      if (building && room.building !== building) return false;
      return true;
    })
    .map(room => room.room_id);
  roomQrState.selected = new Set(checked ? visibleIds : []);
  renderRoomQrTable();
}

// ------------------------------------------------------------------
// Tax, QR and guest portal settings
// ------------------------------------------------------------------
function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(Number(value));
}

function populateTaxSettings(property) {
  const p = property || {};
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value === undefined || value === null ? '' : value;
  };
  setValue('tax-room-gst', p.default_room_tax_rate ?? 12);
  setValue('tax-restaurant-gst', p.default_restaurant_tax_rate ?? 5);
  setChecked('tax-restaurant-enabled', p.restaurant_tax_enabled);
  setChecked('tax-local-enabled', p.local_tax_enabled);
  setValue('tax-local-name', p.local_tax_name || 'Local Tax');
  setValue('tax-local-amount', p.local_tax_amount ?? 0);
  setValue('tax-local-max-guests', p.local_tax_max_guests ?? 0);
  setValue('tax-local-start', p.local_tax_start_date || '');
  setValue('tax-local-end', p.local_tax_end_date || '');
  setChecked('tax-rounding-enabled', p.rounding_enabled);
  setChecked('guest-room-qr-enabled', p.room_qr_enabled);
  setChecked('guest-portal-enabled', p.guest_portal_enabled);
  setChecked('guest-order-enabled', p.guest_order_enabled);
  setChecked('guest-bill-enabled', p.guest_bill_enabled);
  setChecked('guest-service-enabled', p.guest_service_enabled);
  setChecked('guest-help-enabled', p.guest_help_enabled);
  setValue('guest-lan-url', p.lan_guest_url || '');
  setValue('guest-wifi-instructions', p.wifi_instructions || '');
  setValue('guest-wifi-name', p.wifi_name || '');
  setValue('guest-wifi-password', p.wifi_password || '');
  setValue('guest-reception-contact', p.reception_contact || '');
  setValue('guest-emergency-contact', p.emergency_contact || '');
  refreshGuestLanHint();
}

async function refreshGuestLanHint() {
  const input = document.getElementById('guest-lan-url');
  const hint = document.getElementById('guest-lan-hint');
  if (!input || !hint) return;
  try {
    const status = await api('/network/status');
    const reachable = status.guest_lan_url || status.lan_url;
    const saved = String(input.value || '').trim();
    if (reachable && (!saved || /^(https?:\/\/)?(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(saved))) {
      hint.textContent = `This computer's reachable guest URL is ${reachable}. Click “Use this computer's detected Wi-Fi address” to fill it in.`;
    } else if (saved) {
      hint.textContent = `Saved guest URL: ${saved}. A guest phone must be on the same private network.`;
    } else {
      hint.textContent = 'Leave blank to use the detected address automatically.';
    }
  } catch (err) { /* Non-blocking hint only. */ }
}

function toggleWifiPasswordVisibility() {
  const input = document.getElementById('guest-wifi-password');
  const button = input && input.parentElement && input.parentElement.querySelector('button');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (button) button.textContent = show ? 'Hide' : 'Show';
}

async function handleSaveTaxConfig(event) {
  event.preventDefault();
  const value = (id) => document.getElementById(id)?.value;
  const checked = (id) => Boolean(document.getElementById(id)?.checked);
  let lanGuestUrl = value('guest-lan-url') || null;
  const hint = document.getElementById('guest-lan-hint');

  // A guest phone can never open 127.0.0.1/localhost: that means "this phone".
  // Replace a loopback or stale address with the host's real Wi-Fi/LAN URL so
  // saved QR codes always contain a reachable address and the current port.
  if (lanGuestUrl && /^(https?:\/\/)?(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(lanGuestUrl)) {
    try {
      const status = await api('/network/status');
      if (status.guest_lan_url) {
        lanGuestUrl = status.guest_lan_url;
        const input = document.getElementById('guest-lan-url');
        if (input) input.value = lanGuestUrl;
        if (hint) hint.textContent = `localhost was replaced with the reachable Wi-Fi address ${lanGuestUrl}.`;
        alert(`localhost cannot be used by a guest phone. The detected Wi-Fi address was used instead:\n${lanGuestUrl}`);
      } else {
        lanGuestUrl = null;
        if (hint) hint.textContent = 'No private LAN address was detected. Connect this computer to Wi-Fi/Ethernet; QR codes will stay unset until then.';
      }
    } catch (err) {
      if (hint) hint.textContent = err.message;
      alert(`Could not verify the guest LAN address: ${err.message}`);
      return;
    }
  }

  const payload = {
    default_room_tax_rate: Number(value('tax-room-gst')),
    default_restaurant_tax_rate: Number(value('tax-restaurant-gst')),
    restaurant_tax_enabled: checked('tax-restaurant-enabled'),
    local_tax_enabled: checked('tax-local-enabled'),
    local_tax_name: value('tax-local-name'),
    local_tax_amount: Number(value('tax-local-amount') || 0),
    local_tax_max_guests: Number(value('tax-local-max-guests') || 0),
    local_tax_start_date: value('tax-local-start') || null,
    local_tax_end_date: value('tax-local-end') || null,
    rounding_enabled: checked('tax-rounding-enabled'),
    room_qr_enabled: checked('guest-room-qr-enabled'),
    guest_portal_enabled: checked('guest-portal-enabled'),
    guest_order_enabled: checked('guest-order-enabled'),
    guest_bill_enabled: checked('guest-bill-enabled'),
    guest_service_enabled: checked('guest-service-enabled'),
    guest_help_enabled: checked('guest-help-enabled'),
    lan_guest_url: lanGuestUrl,
    wifi_instructions: value('guest-wifi-instructions'),
    wifi_name: value('guest-wifi-name'),
    wifi_password: value('guest-wifi-password'),
    reception_contact: value('guest-reception-contact'),
    emergency_contact: value('guest-emergency-contact')
  };

  try {
    const res = await api('/settings/property', { method: 'PATCH', body: JSON.stringify(payload) });
    currentProperty = res.property;
    updatePropertyUI();
    if (typeof loadRoomQrManagement === 'function') await loadRoomQrManagement();
    alert('Tax, Wi-Fi and guest portal configuration saved. Regenerate or reprint QR posters to show the latest Wi-Fi details.');
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Guest service request inbox ----------
async function loadGuestRequestInbox() {
  const tbody = document.getElementById('tbody-guest-requests');
  if (!tbody) return;
  try {
    const data = await api('/guest-requests');
    const requests = (data.requests || []).filter(r => !['completed', 'rejected'].includes(r.status));
    if (!requests.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-slate-500">No open guest requests</td></tr>';
      return;
    }
    const tone = s => s === 'pending' ? 'bg-amber-500/20 text-amber-300'
      : s === 'accepted' ? 'bg-sky-500/20 text-sky-300'
      : 'bg-indigo-500/20 text-indigo-300';
    tbody.innerHTML = requests.map(r => `
      <tr class="hover:bg-slate-800/40">
        <td class="px-4 py-2 font-bold text-white">${qrEscape(r.room_number || '—')}</td>
        <td class="px-4 py-2 uppercase text-[10px] font-bold text-slate-400">${qrEscape(String(r.category || '').replace(/_/g, ' '))}</td>
        <td class="px-4 py-2 text-slate-300">${qrEscape(r.description || r.notes || '—')}<div class="text-[9px] text-slate-500">${qrEscape(String(r.created_at || '').slice(0, 16))}</div></td>
        <td class="px-4 py-2"><span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase ${tone(r.status)}">${qrEscape(String(r.status).replace(/_/g, ' '))}</span></td>
        <td class="px-4 py-2 text-right whitespace-nowrap">
          ${r.status === 'pending' ? `<button onclick="updateGuestRequestStatus('${qrEscape(r.id)}','accepted')" class="text-[10px] font-bold text-sky-300 mr-2">Accept</button>` : ''}
          <button onclick="updateGuestRequestStatus('${qrEscape(r.id)}','completed')" class="text-[10px] font-bold text-emerald-300">Complete</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-rose-400">${qrEscape(err.message)}</td></tr>`;
  }
}

async function updateGuestRequestStatus(id, status) {
  try {
    await api(`/guest-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await loadGuestRequestInbox();
  } catch (err) {
    alert(err.message);
  }
}
