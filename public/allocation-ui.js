// Nexuzy PMS — room allocation, live availability and transfer UI.
// All decisions are made by the server; this file only presents and confirms.

let allocationState = {
  rooms: [],
  unassigned: [],
  reservations: [],
  dateFrom: null,
  dateTo: null,
  timelineFrom: null,
  days: 14,
  roomTypes: []
};

function allocEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function allocMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function allocDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function allocStatusBadge(status) {
  const styles = {
    available: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    occupied: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    reserved: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
    cleaning: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    maintenance: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    blocked: 'bg-slate-600/40 text-slate-300 border-slate-500/40',
    checkout_pending: 'bg-orange-500/20 text-orange-300 border-orange-500/30'
  };
  const labels = {
    available: 'Available', occupied: 'Occupied', reserved: 'Reserved', cleaning: 'Cleaning',
    maintenance: 'Maintenance', blocked: 'Blocked', checkout_pending: 'Checkout pending'
  };
  return `<span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase border ${styles[status] || styles.blocked}">${labels[status] || allocEsc(status)}</span>`;
}

function allocationQuery() {
  const params = new URLSearchParams({
    check_in: document.getElementById('alloc-check-in').value,
    check_out: document.getElementById('alloc-check-out').value,
    guests: document.getElementById('alloc-guests').value || '1',
    status: document.getElementById('alloc-status').value || 'all'
  });
  const roomType = document.getElementById('alloc-room-type').value;
  if (roomType) params.set('room_type_id', roomType);
  const bed = document.getElementById('alloc-bed').value;
  if (bed) params.set('bed_type', bed);
  const ac = document.getElementById('alloc-ac').value;
  if (ac) params.set('ac_type', ac);
  if (document.getElementById('alloc-accessible').checked) params.set('accessible', '1');
  if (document.getElementById('alloc-immediate').checked) params.set('immediate', '1');
  return params;
}

async function loadAllocationPage() {
  const from = document.getElementById('alloc-check-in');
  const to = document.getElementById('alloc-check-out');
  if (from && !from.value) from.value = allocDate(0);
  if (to && !to.value) to.value = allocDate(1);
  if (!allocationState.timelineFrom) allocationState.timelineFrom = from ? from.value : allocDate(0);
  allocationState.dateFrom = from ? from.value : null;
  allocationState.dateTo = to ? to.value : null;

  const tbody = document.getElementById('tbody-allocation-rooms');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-500">Loading availability…</td></tr>';

  try {
    if (!allocationState.roomTypes.length) {
      const types = await api('/rooms/types');
      allocationState.roomTypes = types.roomTypes || [];
      const select = document.getElementById('alloc-room-type');
      if (select && select.options.length <= 1) {
        allocationState.roomTypes.forEach(type => {
          select.insertAdjacentHTML('beforeend', `<option value="${allocEsc(type.id)}">${allocEsc(type.name)}</option>`);
        });
      }
    }

    const query = allocationQuery();
    const [dashboard, availability, unassigned, timeline] = await Promise.all([
      api(`/allocation/dashboard?${query.toString()}`),
      api(`/allocation/availability?${query.toString()}`),
      api('/allocation/unassigned'),
      api(`/allocation/timeline?from=${encodeURIComponent(allocationState.timelineFrom)}&days=${allocationState.days}`)
    ]);

    allocationState.rooms = availability.rooms || [];
    allocationState.unassigned = unassigned.reservations || [];
    renderAllocationSummary(dashboard);
    renderAllocationRooms();
    renderUnassignedReservations();
    renderAllocationRecent(dashboard.recent_activity || []);
    renderAllocationTimeline(timeline);

    const count = document.getElementById('alloc-availability-count');
    if (count) count.textContent = `${availability.available} of ${availability.total} rooms match ${availability.check_in} → ${availability.check_out}`;
    const alertBox = document.getElementById('alloc-alert');
    if (alertBox) {
      if (dashboard.counts.unassigned_reservations > 0) {
        alertBox.classList.remove('hidden');
        alertBox.textContent = `${dashboard.counts.unassigned_reservations} reservation(s) have no room assigned. Open one below to see the recommended room.`;
      } else {
        alertBox.classList.add('hidden');
      }
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-400">${allocEsc(err.message)}</td></tr>`;
  }
}

function renderAllocationSummary(data) {
  const container = document.getElementById('alloc-summary');
  if (!container) return;
  const c = data.counts || {};
  const cards = [
    ['Total rooms', c.total, 'slate'], ['Available for dates', c.available, 'emerald'],
    ['Occupied', c.occupied, 'sky'], ['Reserved', c.reserved, 'violet'],
    ['Awaiting cleaning', c.cleaning, 'amber'], ['Maintenance', c.maintenance, 'rose'],
    ['Unassigned', c.unassigned_reservations, 'orange'], ['Arrivals / departures', `${c.arrivals} / ${c.departures}`, 'indigo']
  ];
  const colors = {
    slate: 'text-white', emerald: 'text-emerald-400', sky: 'text-sky-400', violet: 'text-violet-400',
    amber: 'text-amber-400', rose: 'text-rose-400', orange: 'text-orange-400', indigo: 'text-indigo-300'
  };
  container.innerHTML = cards.map(([label, value, tone]) => `
    <div class="p-3 bg-slate-900 border border-slate-800 rounded-xl">
      <div class="text-[9px] uppercase tracking-wider font-bold text-slate-500">${label}</div>
      <div class="text-xl font-black ${colors[tone]} mt-1">${value == null ? 0 : value}</div>
    </div>`).join('');
}

function renderAllocationRooms() {
  const tbody = document.getElementById('tbody-allocation-rooms');
  if (!tbody) return;
  if (!allocationState.rooms.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-500">No rooms match these filters.</td></tr>';
    return;
  }
  tbody.innerHTML = allocationState.rooms.map(room => {
    const reservation = room.current_reservation;
    const stay = room.current_stay;
    const actions = [];
    if (room.available) {
      actions.push(`<button onclick="openAllocationAssignModal()" class="text-[10px] font-bold text-indigo-300">Assign</button>`);
    }
    if (stay && stay.stay_id) {
      actions.push(`<button onclick="openRoomTransferModal('${allocEsc(stay.stay_id)}')" class="text-[10px] font-bold text-teal-300">Change</button>`);
    }
    if (reservation && reservation.reservation_id) {
      actions.push(`<button onclick="unassignReservation('${allocEsc(reservation.reservation_id)}','${allocEsc(room.room_number)}')" class="text-[10px] font-bold text-rose-300">Unassign</button>`);
    }
    if (!room.available && !stay && !reservation) {
      actions.push(`<button onclick="openAllocationAssignModal()" class="text-[10px] font-bold text-slate-500">Details</button>`);
    }
    return `<tr class="hover:bg-slate-800/40">
      <td class="px-3 py-2">
        <div class="font-bold text-white">#${allocEsc(room.room_number)}</div>
        <div class="text-[9px] text-slate-500">${allocEsc(room.building || '')} ${allocEsc(room.floor || '')}</div>
      </td>
      <td class="px-3 py-2 text-slate-300">${allocEsc(room.room_type_name)}</td>
      <td class="px-3 py-2 text-slate-400">${allocEsc(String(room.bed_type || '').replace(/_/g, ' '))} · ${room.ac_type === 'non_ac' ? 'Non-AC' : 'AC'}</td>
      <td class="px-3 py-2 font-mono">${allocEsc(room.capacity)}</td>
      <td class="px-3 py-2 font-mono">${allocMoney(room.rate)}</td>
      <td class="px-3 py-2">${allocStatusBadge(room.status)}
        ${room.housekeeping_status && room.housekeeping_status !== 'clean' ? `<div class="text-[9px] text-amber-400 mt-0.5">HK: ${allocEsc(room.housekeeping_status)}</div>` : ''}
        ${room.unavailable_reason ? `<div class="text-[9px] text-slate-500 mt-0.5 max-w-[220px]">${allocEsc(room.unavailable_reason)}</div>` : ''}
      </td>
      <td class="px-3 py-2 text-right whitespace-nowrap space-x-2">${actions.join('')}</td>
    </tr>`;
  }).join('');
}

function renderUnassignedReservations() {
  const tbody = document.getElementById('tbody-unassigned');
  if (!tbody) return;
  if (!allocationState.unassigned.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center py-4 text-slate-500">Every reservation has a room.</td></tr>';
    return;
  }
  tbody.innerHTML = allocationState.unassigned.map(res => `
    <tr class="hover:bg-slate-800/40">
      <td class="px-3 py-2"><div class="font-bold text-white">${allocEsc(res.guest_name)}</div><div class="text-[9px] text-slate-500">${allocEsc(res.room_type_name)} · ${res.adult_count || 1}A ${res.child_count || 0}C</div></td>
      <td class="px-3 py-2 text-slate-400"><div>${allocEsc(res.check_in_date)}</div><div class="text-[9px]">${allocEsc(res.check_out_date)}</div></td>
      <td class="px-3 py-2 text-right"><button onclick="openAllocationAssignModal('${allocEsc(res.id)}')" class="px-2 py-1 rounded bg-indigo-600 text-white text-[10px] font-bold">Recommend</button></td>
    </tr>`).join('');
}

function renderAllocationRecent(activity) {
  const box = document.getElementById('alloc-recent');
  if (!box) return;
  if (!activity.length) {
    box.innerHTML = '<div class="text-slate-500">No room allocations yet.</div>';
    return;
  }
  box.innerHTML = activity.slice(0, 7).map(row => `
    <div class="flex justify-between gap-2 border-b border-slate-800/70 pb-1.5">
      <div><span class="text-white font-bold">#${allocEsc(row.room_number)}</span> ${allocEsc(row.guest_name || row.booking_reference || '')}
        <div class="text-[9px] text-slate-500">${allocEsc(String(row.assigned_at || '').slice(0, 16))} · ${allocEsc(row.allocation_status)}</div>
      </div>
      <div class="text-right text-slate-500">${allocEsc(row.assigned_by_name || '')}</div>
    </div>`).join('');
}

function renderAllocationTimeline(data) {
  const container = document.getElementById('alloc-timeline');
  if (!container) return;
  if (!data.dates || !data.dates.length) {
    container.innerHTML = '<div class="text-slate-500 text-xs">No timeline data.</div>';
    return;
  }
  const colors = {
    available: 'bg-emerald-500/20 text-emerald-200',
    occupied: 'bg-sky-500/25 text-sky-200',
    reserved: 'bg-violet-500/25 text-violet-200',
    cleaning: 'bg-amber-500/25 text-amber-200',
    maintenance: 'bg-rose-500/25 text-rose-200',
    checkout_pending: 'bg-orange-500/25 text-orange-200'
  };
  container.innerHTML = `<table class="w-full text-[10px] text-slate-300 border-collapse min-w-[900px]">
    <thead><tr><th class="sticky left-0 bg-slate-900 p-2 text-left text-slate-500 uppercase text-[9px]">Room</th>
      ${data.dates.map(day => `<th class="p-1.5 text-center text-slate-500 font-mono font-normal min-w-[62px]">${day.slice(5)}</th>`).join('')}
    </tr></thead>
    <tbody>${data.rooms.map(room => `<tr class="border-t border-slate-800">
      <td class="sticky left-0 bg-slate-900 p-2"><span class="font-bold text-white">#${allocEsc(room.room_number)}</span><div class="text-[9px] text-slate-500">${allocEsc(room.room_type_name)}</div></td>
      ${room.cells.map(cell => `<td class="p-0.5"><div title="${allocEsc(cell.label)}${cell.reference ? ` · ${allocEsc(cell.reference)}` : ''}" class="rounded px-1 py-2 text-center font-bold ${colors[cell.status] || colors.available}">${allocEsc(cell.label)}</div></td>`).join('')}
    </tr>`).join('')}</tbody></table>`;
}

function shiftAllocationTimeline(days) {
  const base = allocationState.timelineFrom || allocDate(0);
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  allocationState.timelineFrom = date.toISOString().slice(0, 10);
  loadAllocationPage();
}

async function populateAllocationReservations() {
  const select = document.getElementById('alloc-assign-reservation');
  if (!select) return;
  const data = await api('/reservations');
  const active = (data.reservations || []).filter(res =>
    !['checked_out', 'cancelled', 'no_show'].includes(res.status)
  );
  allocationState.reservations = active;
  select.innerHTML = active.length
    ? active.map(res => `<option value="${allocEsc(res.id)}">${allocEsc(res.booking_reference)} · ${allocEsc(res.guest_name)}${res.room_number ? ` · Room ${allocEsc(res.room_number)}` : ' · Unassigned'}</option>`).join('')
    : '<option value="">No active reservations</option>';
}

async function openAllocationAssignModal(reservationId = null) {
  try {
    await populateAllocationReservations();
    const select = document.getElementById('alloc-assign-reservation');
    if (reservationId && select.querySelector(`option[value="${reservationId}"]`)) select.value = reservationId;
    if (!select.value) {
      const firstUnassigned = allocationState.unassigned[0];
      if (firstUnassigned) select.value = firstUnassigned.id;
    }
    document.getElementById('alloc-assign-reason').value = '';
    document.getElementById('alloc-override').checked = false;
    openModal('modal-allocation-assign');
    await loadAllocationRecommendations();
  } catch (err) {
    alert(err.message);
  }
}

async function loadAllocationRecommendations() {
  const select = document.getElementById('alloc-assign-reservation');
  const box = document.getElementById('alloc-recommendations');
  const summary = document.getElementById('alloc-assign-summary');
  if (!select || !select.value || !box) return;
  box.innerHTML = '<div class="text-slate-500 text-xs">Ranking available rooms…</div>';
  try {
    const result = await api('/allocation/recommend', {
      method: 'POST',
      body: JSON.stringify({ reservation_id: select.value, limit: 8 })
    });
    const reservation = allocationState.reservations.find(r => r.id === select.value);
    if (summary && reservation) {
      summary.textContent = `${reservation.check_in_date} → ${reservation.check_out_date} · ${reservation.adult_count || 1} adult(s), ${reservation.child_count || 0} child(ren) · ${reservation.room_type_name}`;
    }
    if (!result.rooms.length) {
      box.innerHTML = '<div class="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-300 text-xs">No suitable room is available for this reservation. Change dates, room type or free a room.</div>';
      document.getElementById('alloc-assign-room').innerHTML = '';
      return;
    }
    box.innerHTML = result.rooms.map((room, index) => `
      <button type="button" onclick="chooseAllocationRoom('${allocEsc(room.id)}')" class="block w-full text-left p-3 rounded-xl border ${index === 0 ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-700 bg-slate-800/40'} hover:border-indigo-400">
        <div class="flex justify-between gap-2">
          <div><span class="font-bold text-white">Room ${allocEsc(room.room_number)}</span> <span class="text-[10px] text-slate-400">${allocEsc(room.room_type_name)} · ${allocMoney(room.rate)}</span></div>
          <span class="text-[10px] font-mono text-indigo-300">Score ${room.score}</span>
        </div>
        <div class="text-[10px] text-slate-400 mt-1">${allocEsc(room.recommendation)}</div>
      </button>`).join('');
    const roomSelect = document.getElementById('alloc-assign-room');
    roomSelect.innerHTML = result.rooms.map(room => `<option value="${allocEsc(room.id)}">Room ${allocEsc(room.room_number)} · ${allocEsc(room.room_type_name)}</option>`).join('');
    roomSelect.value = result.rooms[0].id;
  } catch (err) {
    box.innerHTML = `<div class="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-300 text-xs">${allocEsc(err.message)}</div>`;
  }
}

function chooseAllocationRoom(roomId) {
  const select = document.getElementById('alloc-assign-room');
  if (select) select.value = roomId;
}

async function assignSelectedReservation() {
  const reservationId = document.getElementById('alloc-assign-reservation').value;
  const roomId = document.getElementById('alloc-assign-room').value;
  if (!reservationId || !roomId) return alert('Choose a reservation and a room.');
  try {
    const res = await api('/allocation/assign', {
      method: 'POST',
      body: JSON.stringify({
        reservation_id: reservationId,
        room_id: roomId,
        mode: 'manual',
        override: document.getElementById('alloc-override').checked,
        reason: document.getElementById('alloc-assign-reason').value.trim() || null
      })
    });
    alert(res.message);
    closeModal('modal-allocation-assign');
    loadAllocationPage();
  } catch (err) {
    alert(err.message);
  }
}

async function autoAssignSelectedReservation() {
  const reservationId = document.getElementById('alloc-assign-reservation').value;
  if (!reservationId) return alert('Choose a reservation.');
  if (!confirm('Assign the highest-ranked available room automatically?')) return;
  try {
    const res = await api('/allocation/assign', {
      method: 'POST',
      body: JSON.stringify({ reservation_id: reservationId, mode: 'auto', override: true })
    });
    alert(res.message || `Room ${res.room.room_number} assigned.`);
    closeModal('modal-allocation-assign');
    loadAllocationPage();
  } catch (err) {
    alert(err.message);
  }
}

async function unassignSelectedReservation() {
  const reservationId = document.getElementById('alloc-assign-reservation').value;
  if (!reservationId) return alert('Choose a reservation.');
  unassignReservation(reservationId);
}

async function unassignReservation(reservationId, roomNumber = '') {
  const reason = prompt(`Unassign${roomNumber ? ` Room ${roomNumber}` : ' the room'} from this reservation?\nReason (optional):`);
  if (reason === null) return;
  try {
    const res = await api('/allocation/unassign', {
      method: 'POST',
      body: JSON.stringify({ reservation_id: reservationId, reason: reason || 'Unassigned by reception' })
    });
    alert(res.message);
    closeModal('modal-allocation-assign');
    loadAllocationPage();
  } catch (err) {
    alert(err.message);
  }
}

async function openRoomTransferModal(stayId = null) {
  try {
    const data = await api('/stays/in-house');
    const stays = data.stays || [];
    if (!stays.length) return alert('There are no in-house guests to move.');
    const select = document.getElementById('transfer-stay');
    select.innerHTML = stays.map(stay => `<option value="${allocEsc(stay.id)}">Room ${allocEsc(stay.room_number)} · ${allocEsc(stay.guest_name)} · ${allocEsc(stay.stay_number)}</option>`).join('');
    if (stayId && select.querySelector(`option[value="${stayId}"]`)) select.value = stayId;
    document.getElementById('transfer-reason').value = '';
    openModal('modal-room-transfer');
    await loadTransferRooms();
  } catch (err) {
    alert(err.message);
  }
}

async function loadTransferRooms() {
  const stayId = document.getElementById('transfer-stay').value;
  const select = document.getElementById('transfer-room');
  if (!select) return;
  select.innerHTML = '<option value="">Loading available rooms…</option>';
  try {
    const data = await api(`/allocation/availability?check_in=${allocDate(0)}&check_out=${allocDate(1)}&immediate=1&status=available`);
    const stay = (await api('/stays/in-house')).stays.find(s => s.id === stayId);
    const rooms = (data.rooms || []).filter(room => room.available && room.id !== (stay && stay.room_id));
    select.innerHTML = rooms.length
      ? rooms.map(room => `<option value="${allocEsc(room.id)}">Room ${allocEsc(room.room_number)} · ${allocEsc(room.room_type_name)} · ${allocMoney(room.rate)}</option>`).join('')
      : '<option value="">No ready rooms available</option>';
  } catch (err) {
    select.innerHTML = `<option value="">${allocEsc(err.message)}</option>`;
  }
}

async function submitRoomTransfer() {
  const stayId = document.getElementById('transfer-stay').value;
  const newRoomId = document.getElementById('transfer-room').value;
  const reason = document.getElementById('transfer-reason').value.trim();
  if (!stayId || !newRoomId) return alert('Choose a stay and a ready room.');
  if (!reason) return alert('A reason is required for a room change.');
  if (!confirm('Move this guest? The old room will be sent to housekeeping, the old guest QR session will be closed, and the guest must scan the new room QR.')) return;
  try {
    const res = await api('/allocation/transfer', {
      method: 'POST',
      body: JSON.stringify({ stay_id: stayId, new_room_id: newRoomId, reason })
    });
    alert(res.message);
    closeModal('modal-room-transfer');
    loadAllocationPage();
    if (typeof loadFrontDeskData === 'function') loadFrontDeskData();
  } catch (err) {
    alert(err.message);
  }
}
