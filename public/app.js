// Nexuzy PMS - Core Client Application
// Conforms to Nexuzy PMS PRD: Hotel, Restaurant, Group Stays, POS, Folios, GST, Housekeeping, Night Audit, Backups (.nxp), Setup Wizard & SMTP

const API_BASE = '/api/v1';

let currentUser = null;
let currentProperty = null;
let activeTab = 'dashboard';

// Restaurant POS State
let posOrderType = 'dine_in';
let selectedTableId = 'tbl-1';
let selectedRoomId = '';
let posCart = [];
let posCategories = [];
let posMenuItems = [];
let activePosOrderId = '';

// =========================================================
// API HELPER
// =========================================================
async function api(path, options = {}) {
  const token = localStorage.getItem('nexuzy_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) {
      handleLogout();
      throw new Error('Session expired. Please log in.');
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  } catch (err) {
    console.error(`API Error [${path}]:`, err);
    throw err;
  }
}

// =========================================================
// INITIALIZATION & FIRST-TIME SETUP CHECK
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  try {
    // 1. Check if property is initialized
    const statusRes = await api('/setup/status');
    if (!statusRes.initialized) {
      // Show First-Time Setup Wizard!
      showSetupWizard();
      return;
    }

    // 2. Check for token
    const token = localStorage.getItem('nexuzy_token');
    if (!token) {
      showLoginModal();
      return;
    }

    const meRes = await api('/auth/me');
    currentUser = meRes.user;
    updateUserUI();

    const propRes = await api('/properties/current');
    currentProperty = propRes.property;
    updatePropertyUI();

    hideLoginModal();
    hideSetupWizard();
    switchTab('dashboard');
  } catch (err) {
    showLoginModal();
  }
}

function showSetupWizard() {
  document.getElementById('modal-setup-wizard').classList.remove('hidden');
  document.getElementById('login-modal').classList.add('hidden');
}

function hideSetupWizard() {
  document.getElementById('modal-setup-wizard').classList.add('hidden');
}

function showLoginModal() {
  document.getElementById('login-modal').classList.remove('hidden');
  document.getElementById('modal-setup-wizard').classList.add('hidden');
}

function hideLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}

// Handle First Time Hotel Setup
async function handleFirstTimeSetup(e) {
  e.preventDefault();
  const errorEl = document.getElementById('setup-error');
  errorEl.classList.add('hidden');

  const payload = {
    hotel_name: document.getElementById('setup-hotel-name').value.trim(),
    hotel_code: document.getElementById('setup-hotel-code').value.trim(),
    phone: document.getElementById('setup-phone').value.trim(),
    email: document.getElementById('setup-email').value.trim(),
    address: document.getElementById('setup-address').value.trim(),
    city: document.getElementById('setup-city').value.trim(),
    state: document.getElementById('setup-state').value.trim(),
    country: document.getElementById('setup-country').value.trim(),
    gstin: document.getElementById('setup-gstin').value.trim(),
    bank_name: document.getElementById('setup-bank-name').value.trim(),
    bank_account_number: document.getElementById('setup-bank-acc').value.trim(),
    bank_ifsc: document.getElementById('setup-bank-ifsc').value.trim(),
    bank_branch: document.getElementById('setup-bank-branch').value.trim(),
    upi_id: document.getElementById('setup-upi-id').value.trim(),
    upi_name: document.getElementById('setup-upi-name').value.trim(),
    default_room_tax_rate: Number(document.getElementById('setup-room-tax').value) || 12.0,
    default_restaurant_tax_rate: Number(document.getElementById('setup-rest-tax').value) || 5.0,
    currency_symbol: document.getElementById('setup-currency-sym').value.trim() || '₹',
    admin_full_name: document.getElementById('setup-admin-name').value.trim(),
    admin_email: document.getElementById('setup-admin-email').value.trim(),
    admin_username: document.getElementById('setup-admin-username').value.trim(),
    admin_password: document.getElementById('setup-admin-password').value
  };

  try {
    const res = await api('/setup/initialize', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    localStorage.setItem('nexuzy_token', res.token);
    currentUser = res.user;
    currentProperty = res.property;
    updateUserUI();
    updatePropertyUI();

    hideSetupWizard();
    alert('Hotel setup complete! Welcome to Nexuzy PMS.');
    switchTab('dashboard');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

// Handle Login
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    localStorage.setItem('nexuzy_token', data.token);
    currentUser = data.user;
    updateUserUI();

    const propRes = await api('/properties/current');
    currentProperty = propRes.property;
    updatePropertyUI();

    hideLoginModal();
    switchTab('dashboard');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

function handleLogout() {
  localStorage.removeItem('nexuzy_token');
  currentUser = null;
  showLoginModal();
}

function updateUserUI() {
  if (!currentUser) return;
  document.getElementById('header-user-name').textContent = currentUser.full_name;
  document.getElementById('header-user-role').textContent = currentUser.role.replace('_', ' ');
}

function updatePropertyUI() {
  if (!currentProperty) return;
  document.getElementById('header-prop-name').textContent = currentProperty.name;
  document.getElementById('header-prop-code').textContent = currentProperty.code;
  document.getElementById('header-gstin').textContent = currentProperty.gstin || 'Not Configured';
  document.getElementById('header-business-date').textContent = currentProperty.business_date;
}

// =========================================================
// TAB SWITCHING
// =========================================================
function switchTab(tabId) {
  activeTab = tabId;

  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.remove('active-tab');
  });
  const activeBtn = document.getElementById(`tab-btn-${tabId}`);
  if (activeBtn) activeBtn.classList.add('active-tab');

  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.add('hidden');
  });

  const activeContent = document.getElementById(`tab-${tabId}`);
  if (activeContent) activeContent.classList.remove('hidden');

  if (tabId === 'dashboard') loadDashboardData();
  else if (tabId === 'frontdesk') loadFrontDeskData();
  else if (tabId === 'groups') loadGroupsData();
  else if (tabId === 'reservations') loadReservationsData();
  else if (tabId === 'rooms') loadRoomsHousekeepingData();
  else if (tabId === 'restaurant') loadRestaurantPosData();
  else if (tabId === 'folios') loadFoliosData();
  else if (tabId === 'cashier') loadCashierShiftData();
  else if (tabId === 'inventory') loadInventoryData();
  else if (tabId === 'nightaudit') loadNightAuditData();
  else if (tabId === 'reports') loadReportsData();
  else if (tabId === 'settings') loadSettingsData();
}

// =========================================================
// 1. DASHBOARD
// =========================================================
async function loadDashboardData() {
  try {
    const data = await api('/reports/dashboard');
    const hm = data.hotel_metrics;
    const rm = data.restaurant_metrics;
    const fm = data.financial_metrics;

    document.getElementById('stat-occupancy-rate').textContent = `${hm.occupancy_percentage}%`;
    document.getElementById('stat-occupied-rooms').textContent = hm.occupied_rooms;
    document.getElementById('stat-total-rooms').textContent = hm.total_rooms;
    document.getElementById('stat-available-rooms').textContent = hm.available_rooms;
    document.getElementById('stat-clean-rooms').textContent = hm.clean_rooms;
    document.getElementById('stat-inhouse-guests').textContent = hm.in_house_guests;
    document.getElementById('stat-today-arrivals').textContent = hm.today_arrivals;
    document.getElementById('stat-open-kots').textContent = rm.open_kots;
    document.getElementById('stat-active-tables').textContent = rm.occupied_tables;
    document.getElementById('stat-today-collections').textContent = `₹${(fm.total_collections_today || 0).toLocaleString()}`;

    const roomsRes = await api('/rooms');
    renderRoomRack(roomsRes.rooms);
  } catch (err) {
    console.error('Error loading dashboard:', err);
  }
}

function renderRoomRack(rooms) {
  const container = document.getElementById('dashboard-room-rack');
  container.innerHTML = '';

  if (!rooms.length) {
    container.innerHTML = `<div class="col-span-5 text-center py-6 text-slate-500 text-xs">No rooms configured yet. Add your rooms in Rooms & HK.</div>`;
    return;
  }

  rooms.forEach(r => {
    let colorClass = 'bg-slate-800/80 border-slate-700 text-slate-300';
    let statusText = 'Available';

    if (r.operational_status === 'occupied') {
      colorClass = 'bg-indigo-950/50 border-indigo-500/50 text-indigo-300';
      statusText = 'Occupied';
    } else if (r.operational_status === 'out_of_order') {
      colorClass = 'bg-rose-950/50 border-rose-500/50 text-rose-300';
      statusText = 'Out of Order';
    } else if (r.housekeeping_status === 'dirty') {
      colorClass = 'bg-amber-950/50 border-amber-500/50 text-amber-300';
      statusText = 'Vacant Dirty';
    } else if (r.housekeeping_status === 'clean' || r.housekeeping_status === 'inspected') {
      colorClass = 'bg-emerald-950/50 border-emerald-500/50 text-emerald-300';
      statusText = 'Ready Clean';
    }

    const card = document.createElement('div');
    card.className = `p-3 rounded-xl border ${colorClass} flex flex-col justify-between transition hover:scale-[1.02] cursor-pointer shadow-sm`;
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-base font-black text-white">#${r.room_number}</span>
        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-900/60 uppercase">${r.room_type_code}</span>
      </div>
      <div class="mt-2 text-[11px] truncate font-medium">
        ${r.current_guest_name ? `👤 ${r.current_guest_name}` : statusText}
      </div>
      <div class="mt-1 flex items-center justify-between text-[10px] text-slate-400">
        <span>${r.floor || 'Floor 1'}</span>
        <span class="font-mono">₹${r.base_rate}</span>
      </div>
    `;

    card.onclick = () => {
      if (r.active_stay_id) {
        switchTab('frontdesk');
      } else {
        openWalkInModalWithRoom(r.id);
      }
    };

    container.appendChild(card);
  });
}

// =========================================================
// 2. FRONT DESK & STAYS
// =========================================================
async function loadFrontDeskData() {
  try {
    const inHouseRes = await api('/stays/in-house');
    document.getElementById('inhouse-count').textContent = inHouseRes.in_house_count;
    renderInHouseTable(inHouseRes.stays);

    const arrivalsRes = await api('/stays/arrivals');
    renderArrivalsTable(arrivalsRes.individual_arrivals, arrivalsRes.group_arrivals);
  } catch (err) {
    console.error('Error loading front desk:', err);
  }
}

function renderInHouseTable(stays) {
  const tbody = document.getElementById('tbody-inhouse');
  tbody.innerHTML = '';

  if (!stays.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-500">No active in-house stays right now.</td></tr>`;
    return;
  }

  stays.forEach(s => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/40 transition';
    tr.innerHTML = `
      <td class="px-4 py-3 font-black text-white">Room ${s.room_number}</td>
      <td class="px-4 py-3 font-mono text-[11px] text-indigo-400">${s.stay_number}</td>
      <td class="px-4 py-3 font-medium text-white">${s.guest_name}</td>
      <td class="px-4 py-3 text-slate-400 font-mono">${s.guest_phone || '—'}</td>
      <td class="px-4 py-3 text-slate-400">${s.check_in_time.slice(0, 16)}</td>
      <td class="px-4 py-3 text-slate-400">${s.expected_check_out}</td>
      <td class="px-4 py-3 text-right font-mono font-bold ${s.balance > 0 ? 'text-amber-400' : 'text-emerald-400'}">
        ₹${(s.balance || 0).toLocaleString()}
      </td>
      <td class="px-4 py-3 text-center space-x-1">
        <button onclick="viewFolio('${s.folio_id}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded text-[11px] font-semibold border border-slate-700">Folio</button>
        <button onclick="handleCheckOutStay('${s.id}', '${s.room_number}', ${s.balance})" class="px-2 py-1 bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white rounded text-[11px] font-semibold border border-rose-500/30">Checkout</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderArrivalsTable(indArrivals = [], grpArrivals = []) {
  const tbody = document.getElementById('tbody-arrivals');
  tbody.innerHTML = '';

  const allArrivals = [
    ...indArrivals.map(a => ({ ...a, is_group: false })),
    ...grpArrivals.map(a => ({ ...a, is_group: true }))
  ];

  if (!allArrivals.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-500">No arrivals scheduled for today.</td></tr>`;
    return;
  }

  allArrivals.forEach(a => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/40 transition';
    tr.innerHTML = `
      <td class="px-4 py-3 font-mono text-[11px] text-indigo-400">
        ${a.is_group ? a.group_booking_number : a.booking_reference}
        ${a.is_group ? '<span class="ml-1 text-[9px] px-1 bg-indigo-500/20 text-indigo-300 rounded">Group</span>' : ''}
      </td>
      <td class="px-4 py-3 font-medium text-white">${a.guest_name}</td>
      <td class="px-4 py-3 text-slate-400">${a.room_type_name}</td>
      <td class="px-4 py-3 font-bold text-white">${a.room_number ? `#${a.room_number}` : '<span class="text-amber-400">Unassigned</span>'}</td>
      <td class="px-4 py-3 font-mono text-emerald-400">₹${a.is_group ? 'Master' : (a.deposit_paid || 0)}</td>
      <td class="px-4 py-3 text-center">
        ${a.is_group 
          ? `<button onclick="switchTab('groups')" class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px] font-semibold">Group Actions</button>`
          : `<button onclick="handleCheckInReservation('${a.id}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-semibold">Check-In</button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleCheckInReservation(resId) {
  try {
    await api('/stays/check-in-reservation', {
      method: 'POST',
      body: JSON.stringify({ reservation_id: resId })
    });
    alert('Guest checked in successfully!');
    loadFrontDeskData();
  } catch (err) {
    alert(err.message);
  }
}

async function handleCheckOutStay(stayId, roomNumber, balance) {
  let allowOverride = false;
  if (balance > 0) {
    const proceed = confirm(`Room ${roomNumber} has an unpaid balance of ₹${balance}. Proceed with authorized checkout override?`);
    if (!proceed) return;
    allowOverride = true;
  } else {
    if (!confirm(`Confirm checkout for Room ${roomNumber}?`)) return;
  }

  try {
    await api(`/stays/${stayId}/check-out`, {
      method: 'POST',
      body: JSON.stringify({ allow_override: allowOverride })
    });
    alert(`Room ${roomNumber} checked out! Released to Housekeeping dirty.`);
    loadFrontDeskData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 3. GROUP BOOKINGS (STAGGERED CHECK-IN/OUT)
// =========================================================
async function loadGroupsData() {
  try {
    const data = await api('/groups');
    const container = document.getElementById('groups-list-container');
    container.innerHTML = '';

    if (!data.groups.length) {
      container.innerHTML = `<div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-500">No group reservations found. Click "Create Group Booking" above.</div>`;
      return;
    }

    for (const g of data.groups) {
      const fullGroup = await api(`/groups/${g.id}`);
      renderGroupCard(fullGroup.group, fullGroup.rooms, fullGroup.masterFolio, container);
    }
  } catch (err) {
    console.error('Error loading groups:', err);
  }
}

function renderGroupCard(group, rooms, masterFolio, container) {
  let statusBadge = 'bg-slate-800 text-slate-300 border-slate-700';
  if (group.status === 'partially_checked_in') statusBadge = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
  else if (group.status === 'fully_checked_in') statusBadge = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
  else if (group.status === 'partially_checked_out') statusBadge = 'bg-sky-500/20 text-sky-300 border-sky-500/30';
  else if (group.status === 'completed') statusBadge = 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30';

  const card = document.createElement('div');
  card.className = 'bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl';
  card.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
      <div>
        <div class="flex items-center space-x-3">
          <h3 class="text-lg font-black text-white">${group.group_name}</h3>
          <span class="px-2 py-0.5 text-xs font-mono rounded bg-slate-800 text-indigo-400 border border-slate-700">${group.group_booking_number}</span>
          <span class="px-2 py-0.5 text-xs font-bold rounded uppercase tracking-wider border ${statusBadge}">${group.status.replace(/_/g, ' ')}</span>
        </div>
        <p class="text-xs text-slate-400 mt-1">
          Organizer: <span class="text-white">${group.contact_name}</span> (${group.contact_phone}) | 
          Planning Dates: <span class="text-white">${group.planned_start_date}</span> to <span class="text-white">${group.planned_end_date}</span>
        </p>
      </div>

      <div class="flex items-center space-x-4">
        <div class="text-right">
          <div class="text-[11px] text-slate-400 uppercase font-semibold">Master Deposit / Balance</div>
          <div class="text-sm font-mono font-bold ${masterFolio && masterFolio.balance > 0 ? 'text-amber-400' : 'text-emerald-400'}">
            Deposit: ₹${(group.deposit_amount || 0).toLocaleString()} | Balance: ₹${masterFolio ? (masterFolio.balance || 0).toLocaleString() : 0}
          </div>
        </div>
        <button onclick="viewFolio('${group.master_folio_id}')" class="btn-secondary text-xs">
          Master Folio
        </button>
      </div>
    </div>

    <div class="mt-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-xs font-bold text-slate-300">
          Independent Room Stay Records (${rooms.length} rooms)
        </div>
        <div class="flex items-center space-x-2">
          <button onclick="handleBulkGroupCheckIn('${group.id}')" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow-sm">
            🛎️ Check In Selected
          </button>
          <button onclick="handleBulkGroupCheckOut('${group.id}')" class="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold transition shadow-sm">
            🚪 Check Out Selected
          </button>
        </div>
      </div>

      <div class="overflow-x-auto rounded-xl border border-slate-800">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-slate-800/80 text-slate-400 uppercase tracking-wider text-[11px]">
            <tr>
              <th class="px-3 py-2.5 w-10 text-center">
                <input type="checkbox" onchange="toggleAllGroupCheckboxes('${group.id}', this)" class="rounded bg-slate-700 border-slate-600">
              </th>
              <th class="px-3 py-2.5">Room</th>
              <th class="px-3 py-2.5">Occupant Guest</th>
              <th class="px-3 py-2.5">Planned Dates</th>
              <th class="px-3 py-2.5">Actual In</th>
              <th class="px-3 py-2.5">Actual Out</th>
              <th class="px-3 py-2.5">Rate</th>
              <th class="px-3 py-2.5">Folio</th>
              <th class="px-3 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800" id="tbody-group-${group.id}">
            ${rooms.map(r => `
              <tr class="hover:bg-slate-800/40">
                <td class="px-3 py-2.5 text-center">
                  <input type="checkbox" name="grp-room-check-${group.id}" value="${r.id}" class="rounded bg-slate-700 border-slate-600">
                </td>
                <td class="px-3 py-2.5 font-bold text-white">#${r.room_number || 'Unassigned'}</td>
                <td class="px-3 py-2.5 text-white font-medium">${r.guest_name || 'Group Guest'}</td>
                <td class="px-3 py-2.5 text-slate-400">${r.planned_check_in} to ${r.planned_check_out}</td>
                <td class="px-3 py-2.5 font-mono text-[11px] text-slate-400">${r.actual_check_in ? r.actual_check_in.slice(0, 16) : '—'}</td>
                <td class="px-3 py-2.5 font-mono text-[11px] text-slate-400">${r.actual_check_out ? r.actual_check_out.slice(0, 16) : '—'}</td>
                <td class="px-3 py-2.5 font-mono">₹${r.nightly_rate}</td>
                <td class="px-3 py-2.5">
                  ${r.folio_id 
                    ? `<button onclick="viewFolio('${r.folio_id}')" class="text-indigo-400 font-mono hover:underline">₹${r.balance || 0}</button>`
                    : '—'}
                </td>
                <td class="px-3 py-2.5">
                  <span class="px-2 py-0.5 text-[10px] font-bold rounded uppercase ${getStayStatusBadge(r.status)}">
                    ${r.status}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  container.appendChild(card);
}

function getStayStatusBadge(status) {
  if (status === 'checked_in') return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
  if (status === 'checked_out') return 'bg-slate-800 text-slate-400 border border-slate-700';
  if (status === 'reserved') return 'bg-amber-500/20 text-amber-300 border border-amber-500/30';
  return 'bg-rose-500/20 text-rose-300';
}

function toggleAllGroupCheckboxes(groupId, masterCheckbox) {
  const checkboxes = document.querySelectorAll(`input[name="grp-room-check-${groupId}"]`);
  checkboxes.forEach(cb => cb.checked = masterCheckbox.checked);
}

async function handleBulkGroupCheckIn(groupId) {
  const checkboxes = document.querySelectorAll(`input[name="grp-room-check-${groupId}"]:checked`);
  const selectedIds = Array.from(checkboxes).map(cb => cb.value);

  if (!selectedIds.length) {
    alert('Please select at least one reserved room to check in.');
    return;
  }

  try {
    const res = await api(`/groups/${groupId}/check-in-selected`, {
      method: 'POST',
      body: JSON.stringify({ room_reservation_ids: selectedIds })
    });
    alert(res.message);
    loadGroupsData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function handleBulkGroupCheckOut(groupId) {
  const checkboxes = document.querySelectorAll(`input[name="grp-room-check-${groupId}"]:checked`);
  const selectedIds = Array.from(checkboxes).map(cb => cb.value);

  if (!selectedIds.length) {
    alert('Please select at least one occupied room to check out.');
    return;
  }

  const transferToMaster = confirm('Transfer outstanding balances of selected rooms to the Group Master Folio?');

  try {
    const res = await api(`/groups/${groupId}/check-out-selected`, {
      method: 'POST',
      body: JSON.stringify({
        room_reservation_ids: selectedIds,
        transfer_balance_to_master: transferToMaster
      })
    });
    alert(res.message);
    loadGroupsData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 4. RESERVATIONS
// =========================================================
async function loadReservationsData() {
  try {
    const data = await api('/reservations');
    const tbody = document.getElementById('tbody-reservations');
    tbody.innerHTML = '';

    if (!data.reservations.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-500">No reservations found.</td></tr>`;
      return;
    }

    data.reservations.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-800/40';
      tr.innerHTML = `
        <td class="px-4 py-3 font-mono text-indigo-400 font-bold">${r.booking_reference}</td>
        <td class="px-4 py-3 font-medium text-white">${r.guest_name}<div class="text-[10px] text-slate-400">${r.guest_phone}</div></td>
        <td class="px-4 py-3 text-slate-300">${r.room_type_name} ${r.room_number ? `(#${r.room_number})` : ''}</td>
        <td class="px-4 py-3 text-slate-400">${r.check_in_date} to ${r.check_out_date}</td>
        <td class="px-4 py-3 font-mono">₹${r.rate_per_night}</td>
        <td class="px-4 py-3 font-mono text-emerald-400">₹${r.deposit_paid}</td>
        <td class="px-4 py-3">
          <span class="px-2 py-0.5 text-[10px] font-bold rounded uppercase ${r.status === 'confirmed' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-400'}">
            ${r.status}
          </span>
        </td>
        <td class="px-4 py-3 text-center space-x-1">
          ${r.status === 'confirmed' 
            ? `<button onclick="handleCheckInReservation('${r.id}')" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-semibold">Check-In</button>
               <button onclick="handleCancelReservation('${r.id}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-rose-300 rounded text-[11px] font-semibold border border-slate-700">Cancel</button>`
            : '—'}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Error loading reservations:', err);
  }
}

async function handleCancelReservation(id) {
  if (!confirm('Are you sure you want to cancel this reservation?')) return;
  try {
    await api(`/reservations/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Guest requested cancellation' })
    });
    alert('Reservation cancelled');
    loadReservationsData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 5. ROOMS & HOUSEKEEPING
// =========================================================
async function loadRoomsHousekeepingData() {
  try {
    const hkData = await api('/housekeeping/tasks');
    const hkContainer = document.getElementById('housekeeping-tasks-list');
    hkContainer.innerHTML = '';

    if (!hkData.tasks.length) {
      hkContainer.innerHTML = `<div class="text-slate-500 text-xs py-4">No pending housekeeping tasks.</div>`;
    } else {
      hkData.tasks.forEach(t => {
        const item = document.createElement('div');
        item.className = 'p-3 bg-slate-800/60 border border-slate-800 rounded-xl flex items-center justify-between';
        item.innerHTML = `
          <div>
            <div class="flex items-center space-x-2">
              <span class="text-sm font-black text-white">Room #${t.room_number}</span>
              <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 uppercase">${t.task_type.replace('_', ' ')}</span>
              <span class="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${t.priority === 'urgent' ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-700 text-slate-300'}">${t.priority}</span>
            </div>
            <p class="text-xs text-slate-400 mt-1">${t.notes || 'Routine cleaning required'}</p>
          </div>
          <div class="flex items-center space-x-2">
            <select onchange="updateHkTaskStatus('${t.id}', this.value)" class="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white">
              <option value="dirty" ${t.status === 'dirty' ? 'selected' : ''}>Dirty</option>
              <option value="cleaning" ${t.status === 'cleaning' ? 'selected' : ''}>Cleaning</option>
              <option value="cleaned" ${t.status === 'cleaned' ? 'selected' : ''}>Cleaned</option>
              <option value="inspected" ${t.status === 'inspected' ? 'selected' : ''}>Inspected Ready</option>
            </select>
          </div>
        `;
        hkContainer.appendChild(item);
      });
    }

    const maintData = await api('/maintenance/tickets');
    const maintContainer = document.getElementById('maintenance-tickets-list');
    maintContainer.innerHTML = '';

    if (!maintData.tickets.length) {
      maintContainer.innerHTML = `<div class="text-slate-500 text-xs py-4">No active maintenance tickets.</div>`;
    } else {
      maintData.tickets.forEach(m => {
        const item = document.createElement('div');
        item.className = 'p-3 bg-slate-800/60 border border-slate-800 rounded-xl space-y-1';
        item.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-white">${m.title}</span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 uppercase">${m.status}</span>
          </div>
          <p class="text-[11px] text-slate-400">${m.description || ''}</p>
          <div class="flex justify-between items-center text-[10px] text-slate-500 pt-1">
            <span>Room ${m.room_number || 'General'}</span>
            ${m.status !== 'completed' 
              ? `<button onclick="resolveMaintenanceTicket('${m.id}')" class="text-emerald-400 hover:underline">Mark Resolved</button>` 
              : '<span class="text-emerald-400 font-semibold">Resolved</span>'}
          </div>
        `;
        maintContainer.appendChild(item);
      });
    }
  } catch (err) {
    console.error('Error loading rooms & hk:', err);
  }
}

async function updateHkTaskStatus(taskId, newStatus) {
  try {
    await api(`/housekeeping/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus })
    });
    loadRoomsHousekeepingData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function resolveMaintenanceTicket(ticketId) {
  try {
    await api(`/maintenance/tickets/${ticketId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' })
    });
    alert('Maintenance ticket resolved!');
    loadRoomsHousekeepingData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 6. RESTAURANT POS & KDS
// =========================================================
async function loadRestaurantPosData() {
  try {
    const tablesRes = await api('/restaurant/tables');
    renderPosTables(tablesRes.tables);

    const menuRes = await api('/restaurant/menu');
    posCategories = menuRes.categories;
    posMenuItems = menuRes.items;
    renderPosCategories(posCategories);
    renderPosMenuGrid(posMenuItems);

    const staysRes = await api('/stays/in-house');
    const roomSelect = document.getElementById('pos-room-select');
    roomSelect.innerHTML = '<option value="">-- Select Occupied Room --</option>';
    staysRes.stays.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.room_id;
      opt.textContent = `Room ${s.room_number} - ${s.guest_name}`;
      roomSelect.appendChild(opt);
    });

    renderPosCart();
  } catch (err) {
    console.error('Error loading POS:', err);
  }
}

function renderPosTables(tables) {
  const container = document.getElementById('pos-tables-grid');
  container.innerHTML = '';

  tables.forEach(t => {
    const isSelected = selectedTableId === t.id && posOrderType === 'dine_in';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `p-2 rounded-xl border text-center transition ${isSelected ? 'bg-indigo-600 border-indigo-500 text-white shadow-md' : t.status === 'occupied' ? 'bg-amber-950/40 border-amber-500/50 text-amber-300' : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'}`;
    btn.innerHTML = `
      <div class="font-black text-sm">${t.table_number}</div>
      <div class="text-[10px] uppercase font-semibold mt-0.5">${t.status}</div>
    `;
    btn.onclick = () => {
      selectOrderType('dine_in');
      selectedTableId = t.id;
      renderPosTables(tables);
      document.getElementById('cart-order-type-badge').textContent = `Dine-In: ${t.table_number}`;
    };
    container.appendChild(btn);
  });
}

function selectOrderType(type) {
  posOrderType = type;
  document.getElementById('btn-type-dinein').className = type === 'dine_in' ? 'px-2.5 py-1 text-xs rounded-lg bg-indigo-600 text-white font-medium' : 'px-2.5 py-1 text-xs rounded-lg bg-slate-800 text-slate-300 font-medium';
  document.getElementById('btn-type-takeaway').className = type === 'takeaway' ? 'px-2.5 py-1 text-xs rounded-lg bg-indigo-600 text-white font-medium' : 'px-2.5 py-1 text-xs rounded-lg bg-slate-800 text-slate-300 font-medium';
  document.getElementById('btn-type-roomservice').className = type === 'room_service' ? 'px-2.5 py-1 text-xs rounded-lg bg-indigo-600 text-white font-medium' : 'px-2.5 py-1 text-xs rounded-lg bg-slate-800 text-slate-300 font-medium';

  const roomSelectContainer = document.getElementById('pos-room-selector-container');
  if (type === 'room_service') {
    roomSelectContainer.classList.remove('hidden');
    document.getElementById('cart-order-type-badge').textContent = 'Room Service';
  } else if (type === 'takeaway') {
    roomSelectContainer.classList.add('hidden');
    document.getElementById('cart-order-type-badge').textContent = 'Takeaway Order';
  } else {
    roomSelectContainer.classList.add('hidden');
    document.getElementById('cart-order-type-badge').textContent = 'Dine-In Table';
  }
}

function renderPosCategories(categories) {
  const container = document.getElementById('pos-category-pills');
  container.innerHTML = '<button onclick="filterMenuByCategory(\'all\')" class="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs font-semibold">All Items</button>';

  categories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium border border-slate-700';
    btn.textContent = c.name;
    btn.onclick = () => filterMenuByCategory(c.id);
    container.appendChild(btn);
  });
}

function filterMenuByCategory(catId) {
  if (catId === 'all') {
    renderPosMenuGrid(posMenuItems);
  } else {
    const filtered = posMenuItems.filter(i => i.category_id === catId);
    renderPosMenuGrid(filtered);
  }
}

function renderPosMenuGrid(items) {
  const container = document.getElementById('pos-menu-grid');
  container.innerHTML = '';

  items.forEach(it => {
    const card = document.createElement('div');
    card.className = 'p-3 bg-slate-800/60 border border-slate-700 rounded-xl flex flex-col justify-between hover:border-indigo-500 transition cursor-pointer';
    card.innerHTML = `
      <div>
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-white">${it.name}</span>
          <span class="text-[10px] px-1 rounded ${it.is_veg ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'} font-bold">
            ${it.is_veg ? 'VEG' : 'NON-VEG'}
          </span>
        </div>
        <p class="text-[11px] text-slate-400 mt-1 line-clamp-2">${it.description || ''}</p>
      </div>
      <div class="flex items-center justify-between mt-3 pt-2 border-t border-slate-700">
        <span class="text-sm font-mono font-bold text-emerald-400">₹${it.price}</span>
        <button type="button" onclick="addToPosCart('${it.id}')" class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold">
          + Add
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

function addToPosCart(itemId) {
  const item = posMenuItems.find(i => i.id === itemId);
  if (!item) return;

  const existing = posCart.find(c => c.menuItemId === itemId);
  if (existing) {
    existing.qty++;
  } else {
    posCart.push({
      menuItemId: item.id,
      name: item.name,
      price: item.price,
      qty: 1,
      taxRate: item.tax_rate || 5.0
    });
  }
  renderPosCart();
}

function updateCartQty(index, delta) {
  posCart[index].qty += delta;
  if (posCart[index].qty <= 0) {
    posCart.splice(index, 1);
  }
  renderPosCart();
}

function clearPosCart() {
  posCart = [];
  renderPosCart();
}

function renderPosCart() {
  const container = document.getElementById('pos-cart-items');
  container.innerHTML = '';

  if (!posCart.length) {
    container.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">No items selected yet. Click menu items to add.</div>`;
    document.getElementById('pos-cart-subtotal').textContent = '₹0.00';
    document.getElementById('pos-cart-tax').textContent = '₹0.00';
    document.getElementById('pos-cart-total').textContent = '₹0.00';
    return;
  }

  let subtotal = 0;
  let tax = 0;

  posCart.forEach((it, idx) => {
    const lineSub = it.price * it.qty;
    const lineTax = Math.round(lineSub * (it.taxRate / 100) * 100) / 100;
    subtotal += lineSub;
    tax += lineTax;

    const div = document.createElement('div');
    div.className = 'py-2 flex items-center justify-between text-xs';
    div.innerHTML = `
      <div class="flex-1 pr-2">
        <div class="font-medium text-white">${it.name}</div>
        <div class="text-[10px] text-slate-400 font-mono">₹${it.price} each</div>
      </div>
      <div class="flex items-center space-x-1.5">
        <button onclick="updateCartQty(${idx}, -1)" class="w-5 h-5 rounded bg-slate-800 text-slate-300 flex items-center justify-center font-bold hover:bg-slate-700">-</button>
        <span class="w-6 text-center font-bold text-white font-mono">${it.qty}</span>
        <button onclick="updateCartQty(${idx}, 1)" class="w-5 h-5 rounded bg-slate-800 text-slate-300 flex items-center justify-center font-bold hover:bg-slate-700">+</button>
      </div>
      <div class="w-16 text-right font-mono font-bold text-white">
        ₹${lineSub}
      </div>
    `;
    container.appendChild(div);
  });

  const total = subtotal + tax;
  document.getElementById('pos-cart-subtotal').textContent = `₹${subtotal.toLocaleString()}`;
  document.getElementById('pos-cart-tax').textContent = `₹${tax.toLocaleString()}`;
  document.getElementById('pos-cart-total').textContent = `₹${total.toLocaleString()}`;
}

async function handleSendToKitchen() {
  if (!posCart.length) {
    alert('Please add items to cart before sending to kitchen.');
    return;
  }

  const roomId = document.getElementById('pos-room-select').value;
  if (posOrderType === 'room_service' && !roomId) {
    alert('Please select an occupied room for Room Service.');
    return;
  }

  try {
    const payload = {
      order_type: posOrderType,
      table_id: posOrderType === 'dine_in' ? selectedTableId : null,
      room_id: posOrderType === 'room_service' ? roomId : null,
      items: posCart.map(c => ({
        menu_item_id: c.menuItemId,
        item_name: c.name,
        quantity: c.qty,
        unit_price: c.price,
        tax_rate: c.taxRate
      }))
    };

    const res = await api('/restaurant/orders', { method: 'POST', body: JSON.stringify(payload) });
    activePosOrderId = res.orderId;

    await api(`/restaurant/orders/${res.orderId}/send-kitchen`, {
      method: 'POST',
      body: JSON.stringify({ station: 'kitchen', notes: 'KOT round' })
    });

    alert(`Order ${res.orderNumber} sent to Kitchen KDS!`);
    clearPosCart();
    loadRestaurantPosData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function openSettleDirectModal() {
  const method = prompt('Select payment method for separate restaurant bill (cash / upi / card):', 'upi');
  if (!method) return;

  try {
    let orderIdToSettle = activePosOrderId;
    if (posCart.length) {
      const payload = {
        order_type: posOrderType,
        table_id: posOrderType === 'dine_in' ? selectedTableId : null,
        items: posCart.map(c => ({
          menu_item_id: c.menuItemId,
          item_name: c.name,
          quantity: c.qty,
          unit_price: c.price,
          tax_rate: c.taxRate
        }))
      };
      const res = await api('/restaurant/orders', { method: 'POST', body: JSON.stringify(payload) });
      orderIdToSettle = res.orderId;
    }

    const settleRes = await api(`/restaurant/orders/${orderIdToSettle}/settle`, {
      method: 'POST',
      body: JSON.stringify({ payment_method: method.toLowerCase() })
    });

    alert(`Restaurant bill settled! Bill Number: ${settleRes.billNumber}`);
    clearPosCart();
    loadRestaurantPosData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function handlePostToRoom() {
  let roomId = document.getElementById('pos-room-select').value;
  if (!roomId) {
    const promptRoom = prompt('Enter room number (e.g. 101) to post charge:');
    if (!promptRoom) return;
    const rooms = (await api('/rooms')).rooms;
    const found = rooms.find(r => r.room_number === promptRoom.trim());
    if (!found) {
      alert(`Room ${promptRoom} not found.`);
      return;
    }
    roomId = found.id;
  }

  try {
    let orderIdToPost = activePosOrderId;
    if (posCart.length) {
      const payload = {
        order_type: 'room_service',
        room_id: roomId,
        items: posCart.map(c => ({
          menu_item_id: c.menuItemId,
          item_name: c.name,
          quantity: c.qty,
          unit_price: c.price,
          tax_rate: c.taxRate
        }))
      };
      const res = await api('/restaurant/orders', { method: 'POST', body: JSON.stringify(payload) });
      orderIdToPost = res.orderId;
    }

    const postRes = await api(`/restaurant/orders/${orderIdToPost}/post-to-room`, {
      method: 'POST',
      body: JSON.stringify({ room_id: roomId })
    });

    alert(postRes.message);
    clearPosCart();
    loadRestaurantPosData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

function setPosSubTab(sub) {
  if (sub === 'pos') {
    document.getElementById('subtab-pos').classList.remove('hidden');
    document.getElementById('subtab-kds').classList.add('hidden');
    document.getElementById('pos-btn-pos').className = 'px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold';
    document.getElementById('pos-btn-kds').className = 'px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold';
  } else {
    document.getElementById('subtab-pos').classList.add('hidden');
    document.getElementById('subtab-kds').classList.remove('hidden');
    document.getElementById('pos-btn-pos').className = 'px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold';
    document.getElementById('pos-btn-kds').className = 'px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold';
    loadKdsTickets();
  }
}

async function loadKdsTickets() {
  try {
    const data = await api('/restaurant/kds');
    const container = document.getElementById('kds-tickets-container');
    container.innerHTML = '';

    if (!data.tickets.length) {
      container.innerHTML = `<div class="col-span-3 text-center py-12 text-slate-500">No active kitchen tickets. All orders served!</div>`;
      return;
    }

    data.tickets.forEach(kt => {
      const card = document.createElement('div');
      card.className = 'bg-slate-800/80 border border-slate-700 rounded-xl p-4 shadow-md space-y-3';
      card.innerHTML = `
        <div class="flex items-center justify-between pb-2 border-b border-slate-700">
          <div>
            <span class="text-sm font-black text-amber-400 font-mono">${kt.kot_number}</span>
            <span class="text-xs text-white font-bold ml-2">${kt.table_number ? `Table ${kt.table_number}` : `Room #${kt.room_number || 'Takeaway'}`}</span>
          </div>
          <span class="text-[10px] px-1.5 py-0.5 rounded uppercase font-bold ${kt.status === 'ready' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${kt.status}</span>
        </div>
        <div class="space-y-1 text-xs">
          ${(kt.items || []).map(i => `
            <div class="flex justify-between text-slate-200">
              <span>${i.quantity}x ${i.item_name}</span>
              <span class="text-[10px] text-slate-400 uppercase">${i.status}</span>
            </div>
          `).join('')}
        </div>
        <div class="pt-2 border-t border-slate-700 flex justify-end space-x-2">
          ${kt.status === 'preparing' 
            ? `<button onclick="updateKdsTicketStatus('${kt.id}', 'ready')" class="px-3 py-1 bg-emerald-600 text-white rounded text-xs font-bold">Mark Ready</button>`
            : `<button onclick="updateKdsTicketStatus('${kt.id}', 'served')" class="px-3 py-1 bg-indigo-600 text-white rounded text-xs font-bold">Mark Served</button>`}
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error('Error loading KDS:', err);
  }
}

async function updateKdsTicketStatus(kotId, status) {
  try {
    await api(`/restaurant/kds/${kotId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    loadKdsTickets();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 7. BILLING & GST FOLIOS
// =========================================================
let currentSelectedFolioId = '';

async function loadFoliosData() {
  try {
    const stays = (await api('/stays/in-house')).stays;
    const groups = (await api('/groups')).groups;

    const selector = document.getElementById('folio-selector');
    selector.innerHTML = '';

    stays.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.folio_id;
      opt.textContent = `Room ${s.room_number}: ${s.guest_name} (${s.folio_number || 'Folio'})`;
      selector.appendChild(opt);
    });

    groups.forEach(g => {
      if (g.master_folio_id) {
        const opt = document.createElement('option');
        opt.value = g.master_folio_id;
        opt.textContent = `[Group Master] ${g.group_name} (${g.group_booking_number})`;
        selector.appendChild(opt);
      }
    });

    if (currentSelectedFolioId) {
      selector.value = currentSelectedFolioId;
    } else if (selector.options.length) {
      currentSelectedFolioId = selector.options[0].value;
    }

    loadSelectedFolio();
  } catch (err) {
    console.error('Error loading folios:', err);
  }
}

async function loadSelectedFolio() {
  const folioId = document.getElementById('folio-selector').value || currentSelectedFolioId;
  if (!folioId) return;
  currentSelectedFolioId = folioId;

  try {
    const data = await api(`/folios/${folioId}`);
    renderFolioDetails(data.folio, data.entries, data.payments);
  } catch (err) {
    console.error('Error loading folio detail:', err);
  }
}

function viewFolio(folioId) {
  currentSelectedFolioId = folioId;
  switchTab('folios');
}

function renderFolioDetails(folio, entries, payments) {
  const container = document.getElementById('folio-detail-container');
  container.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
      <div>
        <div class="flex items-center space-x-3">
          <h3 class="text-lg font-black text-white">
            ${folio.folio_type === 'group_master' ? `Group Master Folio: ${folio.group_name}` : `Room Folio: Room ${folio.room_number || 'Direct'}`}
          </h3>
          <span class="px-2 py-0.5 text-xs font-mono rounded bg-slate-800 text-indigo-400 border border-slate-700">${folio.folio_number}</span>
          <span class="px-2 py-0.5 text-xs font-bold rounded uppercase ${folio.status === 'settled' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${folio.status}</span>
        </div>
        <p class="text-xs text-slate-400 mt-1">
          Guest: <span class="text-white">${folio.guest_name || folio.group_name || 'Valued Guest'}</span> | 
          ${folio.guest_phone ? `Phone: <span class="text-white">${folio.guest_phone}</span> | ` : ''}
          ${folio.guest_gstin ? `GSTIN: <span class="text-white font-mono">${folio.guest_gstin}</span> | ` : ''}
          Stay: <span class="text-white font-mono">${folio.stay_number || 'Master'}</span>
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button onclick="openAddChargeModal('${folio.id}')" class="btn-secondary text-xs">
          ➕ Post Charge
        </button>
        <button onclick="openAddPaymentModal('${folio.id}')" class="btn-primary text-xs">
          💵 Record Payment
        </button>
        <button onclick="generateTaxInvoice('${folio.id}')" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow-sm">
          🖨️ GST Tax Invoice
        </button>
      </div>
    </div>

    <!-- Charges Ledger Table -->
    <div class="mt-4">
      <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Itemized Ledger Charges</h4>
      <div class="overflow-x-auto rounded-xl border border-slate-800">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-slate-800/80 text-slate-400 uppercase tracking-wider text-[11px]">
            <tr>
              <th class="px-3 py-2.5">Date</th>
              <th class="px-3 py-2.5">Department</th>
              <th class="px-3 py-2.5">Description</th>
              <th class="px-3 py-2.5 text-right">Qty</th>
              <th class="px-3 py-2.5 text-right">Unit Price</th>
              <th class="px-3 py-2.5 text-right">GST %</th>
              <th class="px-3 py-2.5 text-right">Tax (₹)</th>
              <th class="px-3 py-2.5 text-right">Total (₹)</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            ${entries.length ? entries.map(e => `
              <tr class="hover:bg-slate-800/40">
                <td class="px-3 py-2 text-slate-400 font-mono">${e.date}</td>
                <td class="px-3 py-2 uppercase text-[10px] text-indigo-400 font-bold">${e.department.replace('_', ' ')}</td>
                <td class="px-3 py-2 text-white font-medium">${e.description}</td>
                <td class="px-3 py-2 text-right font-mono">${e.quantity}</td>
                <td class="px-3 py-2 text-right font-mono">₹${e.unit_price}</td>
                <td class="px-3 py-2 text-right font-mono">${e.tax_rate}%</td>
                <td class="px-3 py-2 text-right font-mono text-slate-400">₹${e.tax_amount || 0}</td>
                <td class="px-3 py-2 text-right font-mono font-bold text-white">₹${e.total_amount}</td>
              </tr>
            `).join('') : `<tr><td colspan="8" class="text-center py-4 text-slate-500">No charges recorded yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Payments Ledger Table -->
    <div class="mt-4">
      <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Recorded Payments & Deposits</h4>
      <div class="overflow-x-auto rounded-xl border border-slate-800">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-slate-800/80 text-slate-400 uppercase tracking-wider text-[11px]">
            <tr>
              <th class="px-3 py-2.5">Receipt #</th>
              <th class="px-3 py-2.5">Date</th>
              <th class="px-3 py-2.5">Method</th>
              <th class="px-3 py-2.5">Cashier</th>
              <th class="px-3 py-2.5">Reference / Notes</th>
              <th class="px-3 py-2.5 text-right">Amount (₹)</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            ${payments.length ? payments.map(p => `
              <tr class="hover:bg-slate-800/40">
                <td class="px-3 py-2 text-indigo-400 font-mono font-bold">${p.receipt_number}</td>
                <td class="px-3 py-2 text-slate-400 font-mono">${p.created_at.slice(0, 16)}</td>
                <td class="px-3 py-2 uppercase text-[10px] font-bold text-white">${p.payment_method}</td>
                <td class="px-3 py-2 text-slate-400">${p.cashier_name || 'Cashier'}</td>
                <td class="px-3 py-2 text-slate-400">${p.transaction_ref || p.notes || '—'}</td>
                <td class="px-3 py-2 text-right font-mono font-bold text-emerald-400">₹${p.amount}</td>
              </tr>
            `).join('') : `<tr><td colspan="6" class="text-center py-4 text-slate-500">No payments recorded yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Summary Box -->
    <div class="mt-6 p-4 bg-slate-800/50 rounded-xl border border-slate-700/80 flex flex-wrap justify-between items-center gap-4">
      <div class="flex space-x-6 text-xs">
        <div>
          <span class="text-slate-400">Total Charges:</span>
          <span class="font-bold text-white font-mono ml-1 text-sm">₹${(folio.total_charges || 0).toLocaleString()}</span>
        </div>
        <div>
          <span class="text-slate-400">Total Payments:</span>
          <span class="font-bold text-emerald-400 font-mono ml-1 text-sm">₹${(folio.total_payments || 0).toLocaleString()}</span>
        </div>
      </div>
      <div class="text-right">
        <span class="text-xs text-slate-400 mr-2 uppercase font-semibold">Net Folio Balance:</span>
        <span class="text-xl font-mono font-black ${folio.balance > 0 ? 'text-amber-400' : 'text-emerald-400'}">
          ₹${(folio.balance || 0).toLocaleString()}
        </span>
      </div>
    </div>
  `;
}

// Generate Printable Tax Invoice With Logo, Bank Details & UPI String
async function generateTaxInvoice(folioId) {
  try {
    const res = await api(`/folios/${folioId}/invoice`, { method: 'POST' });
    const inv = res.invoice;

    const printable = document.getElementById('invoice-printable-content');
    printable.innerHTML = `
      <div class="flex justify-between items-start pb-4 border-b border-slate-200">
        <div class="flex items-start space-x-3">
          <img src="${inv.property.logo_url || '/logo.png'}" alt="Hotel Logo" class="h-16 w-auto object-contain">
          <div>
            <h2 class="text-xl font-black text-slate-900">${inv.property.name}</h2>
            <p class="text-xs text-slate-600 mt-0.5">${inv.property.address || ''}, ${inv.property.city || ''}, ${inv.property.state || ''}</p>
            <p class="text-xs text-slate-600">Phone: ${inv.property.phone} | Email: ${inv.property.email || ''}</p>
            <div class="mt-1 text-xs font-mono font-bold text-slate-800">GSTIN: ${inv.property.gstin || 'Unregistered / Exempt'}</div>
          </div>
        </div>
        <div class="text-right">
          <div class="inline-block px-3 py-1 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-black uppercase tracking-wider rounded">
            TAX INVOICE
          </div>
          <div class="mt-2 text-xs font-mono text-slate-600">Invoice #: <strong class="text-slate-900">${inv.invoice_number}</strong></div>
          <div class="text-xs font-mono text-slate-600">Date: ${inv.date}</div>
        </div>
      </div>

      <div class="py-3 border-b border-slate-200 text-xs flex justify-between">
        <div>
          <span class="font-bold text-slate-500 uppercase tracking-wider text-[10px]">Billed To:</span>
          <div class="font-bold text-slate-900 text-sm mt-0.5">${inv.customer.name}</div>
          ${inv.customer.company ? `<div class="text-slate-600">${inv.customer.company}</div>` : ''}
          ${inv.customer.gstin ? `<div class="text-slate-700 font-mono font-semibold">Customer GSTIN: ${inv.customer.gstin}</div>` : ''}
        </div>
        <div class="text-right text-slate-500 text-[11px]">
          <div>Supply Place: <span class="text-slate-800 font-semibold">${inv.property.state || 'Karnataka'} (Intra-State)</span></div>
          <div>Applicable Tax: <span class="text-slate-800 font-semibold">CGST (50%) + SGST (50%)</span></div>
        </div>
      </div>

      <table class="w-full text-left text-xs my-4 divide-y divide-slate-200">
        <thead>
          <tr class="text-[10px] text-slate-500 uppercase tracking-wider bg-slate-50">
            <th class="py-2 px-2">Description</th>
            <th class="py-2 px-2">SAC/HSN</th>
            <th class="py-2 px-2 text-right">Qty</th>
            <th class="py-2 px-2 text-right">Rate (₹)</th>
            <th class="py-2 px-2 text-right">GST %</th>
            <th class="py-2 px-2 text-right">Tax (₹)</th>
            <th class="py-2 px-2 text-right">Amount (₹)</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          ${inv.items.map(it => `
            <tr>
              <td class="py-2 px-2 font-medium text-slate-900">${it.description}</td>
              <td class="py-2 px-2 font-mono text-slate-500 text-[11px]">${it.department === 'restaurant' ? '996331' : '996311'}</td>
              <td class="py-2 px-2 text-right font-mono">${it.quantity}</td>
              <td class="py-2 px-2 text-right font-mono">₹${it.unit_price}</td>
              <td class="py-2 px-2 text-right font-mono">${it.tax_rate}%</td>
              <td class="py-2 px-2 text-right font-mono text-slate-600">₹${it.tax_amount || 0}</td>
              <td class="py-2 px-2 text-right font-mono font-bold text-slate-900">₹${it.total_amount}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <!-- Tax Breakup, Totals, Bank & UPI Info -->
      <div class="pt-3 border-t border-slate-200 grid grid-cols-2 gap-4">
        <div class="text-xs p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-1">
          <div class="font-bold text-slate-700 uppercase text-[10px] tracking-wider mb-1">Bank Settlement Details</div>
          <div>Bank: <strong class="text-slate-900">${inv.property.bank_name || 'HDFC Bank'}</strong></div>
          <div>A/C #: <strong class="font-mono text-slate-900">${inv.property.bank_account_number || '50200012345678'}</strong></div>
          <div>IFSC: <strong class="font-mono text-slate-900">${inv.property.bank_ifsc || 'HDFC0001234'}</strong></div>
          <div>UPI VPA: <strong class="font-mono text-indigo-700">${inv.property.upi_id || 'hotel@upi'}</strong></div>
        </div>

        <div class="space-y-1.5 text-xs text-right">
          <div class="flex justify-between text-slate-600">
            <span>Taxable Value:</span>
            <span class="font-mono text-slate-900 font-bold">₹${inv.subtotal.toLocaleString()}</span>
          </div>
          <div class="flex justify-between text-slate-600">
            <span>CGST (Central Tax):</span>
            <span class="font-mono text-slate-900">₹${inv.cgst.toLocaleString()}</span>
          </div>
          <div class="flex justify-between text-slate-600">
            <span>SGST (State Tax):</span>
            <span class="font-mono text-slate-900">₹${inv.sgst.toLocaleString()}</span>
          </div>
          <div class="flex justify-between text-slate-900 font-bold border-t border-slate-200 pt-2 text-sm">
            <span>Grand Total:</span>
            <span class="font-mono text-indigo-700 text-base">₹${inv.grand_total.toLocaleString()}</span>
          </div>
          <div class="flex justify-between text-slate-600 pt-1">
            <span>Amount Paid:</span>
            <span class="font-mono text-emerald-700 font-semibold">₹${inv.paid_amount.toLocaleString()}</span>
          </div>
          <div class="flex justify-between text-slate-900 font-bold border-t border-slate-200 pt-1">
            <span>Balance Due:</span>
            <span class="font-mono ${inv.balance_due > 0 ? 'text-amber-600' : 'text-slate-900'}">₹${inv.balance_due.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div class="pt-6 mt-4 border-t border-slate-200 flex justify-between items-end text-[11px] text-slate-500">
        <div>
          <p>Thank you for choosing ${inv.property.name}.</p>
          <p class="text-[10px] mt-0.5">Computer generated GST invoice. Valid without physical signature.</p>
        </div>
        <div class="text-right">
          <div class="border-b border-slate-400 w-40 mb-1"></div>
          <div>Authorized Signatory</div>
        </div>
      </div>
    `;

    document.getElementById('modal-invoice').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 8. CASHIER SHIFTS
// =========================================================
async function loadCashierShiftData() {
  try {
    const shiftRes = await api('/cashier/current-shift');
    const actionsContainer = document.getElementById('cashier-shift-actions');
    const cardContainer = document.getElementById('cashier-shift-status-card');

    if (shiftRes.has_open_shift) {
      const s = shiftRes.shift;
      actionsContainer.innerHTML = `
        <button onclick="handleCloseShift()" class="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition">
          🔒 Close Active Shift
        </button>
      `;

      cardContainer.innerHTML = `
        <div class="flex justify-between items-start pb-4 border-b border-slate-800">
          <div>
            <div class="flex items-center space-x-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <h3 class="font-bold text-white text-base">Active Cashier Shift (${s.cashier_name})</h3>
            </div>
            <p class="text-xs text-slate-400 mt-1">Shift opened at ${s.opening_time}</p>
          </div>
          <div class="text-right">
            <span class="text-xs text-slate-400">Opening Float:</span>
            <span class="font-mono font-bold text-white text-sm ml-1">₹${s.opening_float}</span>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
          <div class="stat-card">
            <div class="text-xs text-slate-400">Cash Collections</div>
            <div class="text-xl font-bold font-mono text-emerald-400 mt-1">₹${s.total_cash}</div>
          </div>
          <div class="stat-card">
            <div class="text-xs text-slate-400">UPI Collections</div>
            <div class="text-xl font-bold font-mono text-indigo-400 mt-1">₹${s.total_upi}</div>
          </div>
          <div class="stat-card">
            <div class="text-xs text-slate-400">Card Collections</div>
            <div class="text-xl font-bold font-mono text-sky-400 mt-1">₹${s.total_card}</div>
          </div>
          <div class="stat-card">
            <div class="text-xs text-slate-400">Room Folio Postings</div>
            <div class="text-xl font-bold font-mono text-amber-400 mt-1">₹${s.total_room_postings}</div>
          </div>
        </div>
      `;
    } else {
      actionsContainer.innerHTML = `
        <button onclick="handleOpenShift()" class="btn-primary">
          🔓 Open New Cashier Shift
        </button>
      `;
      cardContainer.innerHTML = `
        <div class="text-center py-6 text-slate-400 text-xs">
          You do not have an active cashier shift open. Click "Open New Cashier Shift" to start accepting payments.
        </div>
      `;
    }

    const historyRes = await api('/cashier/history');
    const tbody = document.getElementById('tbody-shift-history');
    tbody.innerHTML = '';
    historyRes.shifts.forEach(h => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-800/40';
      tr.innerHTML = `
        <td class="px-4 py-3 font-medium text-white">${h.cashier_name}</td>
        <td class="px-4 py-3 font-mono text-slate-400">${h.opening_time.slice(0, 16)}</td>
        <td class="px-4 py-3 font-mono text-slate-400">${h.closing_time ? h.closing_time.slice(0, 16) : 'Still Open'}</td>
        <td class="px-4 py-3 font-mono">₹${h.opening_float}</td>
        <td class="px-4 py-3 font-mono text-emerald-400">₹${h.total_cash}</td>
        <td class="px-4 py-3 font-mono text-indigo-400">₹${h.total_upi + h.total_card}</td>
        <td class="px-4 py-3 font-mono text-amber-400">₹${h.total_room_postings}</td>
        <td class="px-4 py-3 font-mono font-bold text-white">₹${h.closing_cash || '—'}</td>
        <td class="px-4 py-3 text-right font-mono font-bold ${h.variance === 0 ? 'text-emerald-400' : 'text-rose-400'}">
          ₹${h.variance || 0}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Error loading cashier shifts:', err);
  }
}

async function handleOpenShift() {
  const floatStr = prompt('Enter opening cash float (₹):', '5000');
  if (floatStr === null) return;
  const float = Number(floatStr) || 0;

  try {
    await api('/cashier/open-shift', {
      method: 'POST',
      body: JSON.stringify({ opening_float: float, notes: 'Operational Shift' })
    });
    alert('Cashier shift opened successfully!');
    loadCashierShiftData();
  } catch (err) {
    alert(err.message);
  }
}

async function handleCloseShift() {
  const cashStr = prompt('Count and enter actual drawer cash (₹):');
  if (cashStr === null) return;
  const closingCash = Number(cashStr) || 0;

  try {
    const res = await api('/cashier/close-shift', {
      method: 'POST',
      body: JSON.stringify({ closing_cash: closingCash, notes: 'Shift closed' })
    });
    const s = res.summary;
    alert(`Shift closed!\nExpected Cash: ₹${s.expected_cash}\nCounted Cash: ₹${s.counted_cash}\nVariance: ₹${s.variance}`);
    loadCashierShiftData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 9. INVENTORY
// =========================================================
async function loadInventoryData() {
  try {
    const data = await api('/inventory/items');
    const tbody = document.getElementById('tbody-inventory');
    tbody.innerHTML = '';

    data.items.forEach(it => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-800/40';
      tr.innerHTML = `
        <td class="px-4 py-3 font-medium text-white">${it.name}</td>
        <td class="px-4 py-3 text-slate-400 uppercase text-[10px] font-bold">${it.category.replace('_', ' ')}</td>
        <td class="px-4 py-3 font-mono font-bold ${it.is_low_stock ? 'text-rose-400' : 'text-white'}">${it.current_stock}</td>
        <td class="px-4 py-3 text-slate-400">${it.unit}</td>
        <td class="px-4 py-3 font-mono text-slate-500">${it.min_stock}</td>
        <td class="px-4 py-3 font-mono">₹${it.cost_price}</td>
        <td class="px-4 py-3 text-center">
          ${it.is_low_stock 
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">LOW STOCK</span>` 
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">Adequate</span>`}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Error loading inventory:', err);
  }
}

// =========================================================
// 10. NIGHT AUDIT
// =========================================================
async function loadNightAuditData() {
  try {
    const data = await api('/night-audit/status');
    const card = document.getElementById('night-audit-status-card');

    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <span class="text-xs uppercase font-bold text-slate-400">Current Property Business Date</span>
          <div class="text-2xl font-black font-mono text-indigo-400 mt-0.5">${data.current_business_date}</div>
        </div>
        <div>
          ${data.already_run_today 
            ? `<span class="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">✔ Today's Audit Already Completed</span>`
            : `<span class="px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 text-xs font-bold border border-amber-500/30">Pending Night Audit Run</span>`}
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4 text-xs">
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700">
          <div class="text-slate-400">Occupied Stays for Rent Posting</div>
          <div class="text-lg font-bold text-white mt-1">${data.occupied_rooms_count} stays</div>
        </div>
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700">
          <div class="text-slate-400">Open Cashier Shifts</div>
          <div class="text-lg font-bold ${data.open_shifts_count > 0 ? 'text-amber-400' : 'text-emerald-400'} mt-1">${data.open_shifts_count} open</div>
        </div>
        <div class="p-3 bg-slate-800/60 rounded-xl border border-slate-700">
          <div class="text-slate-400">Pending Expected Arrivals</div>
          <div class="text-lg font-bold text-white mt-1">${data.pending_arrivals_count} pending</div>
        </div>
      </div>
    `;

    const tbody = document.getElementById('tbody-night-audit-history');
    tbody.innerHTML = '';
    data.audit_history.forEach(h => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-800/40';
      tr.innerHTML = `
        <td class="px-4 py-3 font-mono text-white">${h.business_date}</td>
        <td class="px-4 py-3 font-mono text-indigo-400 font-bold">${h.new_business_date}</td>
        <td class="px-4 py-3 font-mono">${h.rooms_charged}</td>
        <td class="px-4 py-3 font-mono text-emerald-400">₹${h.total_room_revenue}</td>
        <td class="px-4 py-3 font-mono text-slate-400">₹${h.total_tax}</td>
        <td class="px-4 py-3 text-slate-300">${h.run_by}</td>
        <td class="px-4 py-3 text-center">
          <span class="px-2 py-0.5 text-[10px] font-bold rounded bg-emerald-500/20 text-emerald-300 uppercase">${h.status}</span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Error loading night audit:', err);
  }
}

async function executeNightAudit() {
  const confirmMsg = 'Confirm execution of Night Audit?\n\n1. Post nightly room rent and 12% GST to all occupied folios\n2. Reconcile daily transactions\n3. Advance the property business date by 1 day';
  if (!confirm(confirmMsg)) return;

  try {
    const res = await api('/night-audit/run', { method: 'POST' });
    const s = res.summary;
    alert(`Night Audit completed successfully!\n\nRooms Charged: ${s.rooms_charged}\nRevenue Posted: ₹${s.room_revenue_posted}\nTaxes: ₹${s.taxes_posted}\nNew Business Date: ${s.new_business_date}`);

    const propRes = await api('/properties/current');
    currentProperty = propRes.property;
    updatePropertyUI();

    loadNightAuditData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// 11. REPORTS & AUDIT
// =========================================================
async function loadReportsData() {
  try {
    const revData = await api('/reports/revenue');
    const revContainer = document.getElementById('revenue-department-breakdown');
    revContainer.innerHTML = '';

    (revData.department_revenue || []).forEach(d => {
      const item = document.createElement('div');
      item.className = 'flex justify-between items-center text-xs p-2.5 bg-slate-800/60 rounded-xl border border-slate-700/60';
      item.innerHTML = `
        <div>
          <span class="font-bold text-white uppercase text-[11px]">${d.department.replace('_', ' ')}</span>
          <span class="text-[10px] text-slate-400 ml-2">(${d.transaction_count} txns)</span>
        </div>
        <div class="text-right">
          <span class="font-mono font-bold text-emerald-400">₹${(d.gross_amount || 0).toLocaleString()}</span>
        </div>
      `;
      revContainer.appendChild(item);
    });

    const taxData = await api('/reports/tax');
    const taxContainer = document.getElementById('gst-summary-breakdown');
    taxContainer.innerHTML = '';

    (taxData.gst_breakdown || []).forEach(t => {
      const item = document.createElement('div');
      item.className = 'flex justify-between items-center text-xs p-2.5 bg-slate-800/60 rounded-xl border border-slate-700/60';
      item.innerHTML = `
        <div>
          <span class="font-bold text-indigo-400 font-mono">${t.tax_rate}% GST Rate</span>
          <span class="text-[10px] text-slate-400 ml-2">Taxable: ₹${(t.taxable_value || 0).toLocaleString()}</span>
        </div>
        <div class="text-right font-mono">
          <div class="text-white font-bold">Total GST: ₹${(t.total_gst || 0).toLocaleString()}</div>
          <div class="text-[10px] text-slate-400">CGST: ₹${t.cgst} | SGST: ₹${t.sgst}</div>
        </div>
      `;
      taxContainer.appendChild(item);
    });

    const auditData = await api('/reports/audit');
    const tbody = document.getElementById('tbody-audit-logs');
    tbody.innerHTML = '';

    auditData.logs.forEach(l => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-800/40';
      tr.innerHTML = `
        <td class="px-4 py-2.5 font-mono text-slate-400 text-[11px]">${l.created_at.slice(0, 19)}</td>
        <td class="px-4 py-2.5 text-slate-300">${l.user_full_name || 'System'}</td>
        <td class="px-4 py-2.5 font-bold font-mono text-indigo-400 text-[11px]">${l.action}</td>
        <td class="px-4 py-2.5 uppercase text-[10px] text-slate-400">${l.entity_type}</td>
        <td class="px-4 py-2.5 text-slate-300 truncate max-w-xs text-[11px]">${l.details || '—'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Error loading reports:', err);
  }
}

// =========================================================
// 12. SETTINGS, BACKUP, MAIL & GOOGLE DRIVE
// =========================================================
async function loadSettingsData() {
  try {
    const data = await api('/settings');
    const p = data.property || {};
    const smtp = data.smtp || {};
    const gdrive = data.gdrive || {};

    // Populate Hotel profile form
    document.getElementById('edit-hotel-name').value = p.name || '';
    document.getElementById('edit-hotel-phone').value = p.phone || '';
    document.getElementById('edit-hotel-gstin').value = p.gstin || '';
    document.getElementById('edit-bank-name').value = p.bank_name || '';
    document.getElementById('edit-bank-acc').value = p.bank_account_number || '';
    document.getElementById('edit-bank-ifsc').value = p.bank_ifsc || '';
    document.getElementById('edit-upi-id').value = p.upi_id || '';

    // Populate SMTP form
    document.getElementById('smtp-host').value = smtp.host || '';
    document.getElementById('smtp-port').value = smtp.port || 587;
    document.getElementById('smtp-user').value = smtp.user || '';
    document.getElementById('smtp-pass').value = smtp.pass || '';
    document.getElementById('smtp-from').value = smtp.from_email || '';
    document.getElementById('smtp-secure').checked = Boolean(smtp.secure);

    // Populate Google Drive form
    document.getElementById('gdrive-folder-id').value = gdrive.folder_id || '';
    document.getElementById('gdrive-enabled').checked = Boolean(gdrive.enabled);
    const badge = document.getElementById('gdrive-status-badge');
    badge.textContent = `Status: ${gdrive.status || 'Not Configured'} ${gdrive.last_sync ? `(Last sync: ${gdrive.last_sync.slice(0, 16)})` : ''}`;
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

async function handleSaveHotelProfile(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('edit-hotel-name').value,
    phone: document.getElementById('edit-hotel-phone').value,
    gstin: document.getElementById('edit-hotel-gstin').value,
    bank_name: document.getElementById('edit-bank-name').value,
    bank_account_number: document.getElementById('edit-bank-acc').value,
    bank_ifsc: document.getElementById('edit-bank-ifsc').value,
    upi_id: document.getElementById('edit-upi-id').value
  };

  try {
    const res = await api('/settings/property', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    alert(res.message);
    currentProperty = res.property;
    updatePropertyUI();
  } catch (err) {
    alert(err.message);
  }
}

async function handleSaveSmtpSettings(e) {
  e.preventDefault();
  const payload = {
    host: document.getElementById('smtp-host').value.trim(),
    port: document.getElementById('smtp-port').value,
    user: document.getElementById('smtp-user').value.trim(),
    pass: document.getElementById('smtp-pass').value,
    from_email: document.getElementById('smtp-from').value.trim(),
    secure: document.getElementById('smtp-secure').checked
  };

  try {
    const res = await api('/settings/smtp', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    alert(res.message);
  } catch (err) {
    alert(err.message);
  }
}

async function handleSendTestEmail() {
  const target = prompt('Enter recipient email address to send test email:');
  if (!target) return;

  try {
    const res = await api('/settings/test-email', {
      method: 'POST',
      body: JSON.stringify({ target_email: target.trim() })
    });
    alert(res.message);
  } catch (err) {
    alert(err.message);
  }
}

async function handleSaveGDriveSettings(e) {
  e.preventDefault();
  const payload = {
    folder_id: document.getElementById('gdrive-folder-id').value.trim(),
    enabled: document.getElementById('gdrive-enabled').checked
  };

  try {
    const res = await api('/settings/gdrive', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    alert(res.message);
    loadSettingsData();
  } catch (err) {
    alert(err.message);
  }
}

async function handleSyncGDriveNow() {
  try {
    const res = await api('/backup/gdrive-sync', { method: 'POST' });
    alert(res.message);
    loadSettingsData();
  } catch (err) {
    alert(err.message);
  }
}

// Restore from uploaded .nxp file
async function handleRestoreNxpFile() {
  const fileInput = document.getElementById('nxp-file-input');
  if (!fileInput.files.length) {
    alert('Please select a .nxp package file to restore.');
    return;
  }

  const confirmRestore = confirm('WARNING: Restoring will overwrite all current data with the contents of this .nxp backup package.\n\nDo you want to proceed?');
  if (!confirmRestore) return;

  const file = fileInput.files[0];
  const reader = new FileReader();

  reader.onload = async (e) => {
    try {
      const parsedData = JSON.parse(e.target.result);
      const res = await api('/backup/restore-nxp', {
        method: 'POST',
        body: JSON.stringify(parsedData)
      });
      alert(res.message);
      location.reload();
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  };

  reader.readAsText(file);
}

// =========================================================
// MODALS
// =========================================================
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

async function openWalkInModal() {
  const rooms = (await api('/rooms')).rooms.filter(r => r.operational_status === 'available');
  const select = document.getElementById('walkin-room-select');
  select.innerHTML = '';

  rooms.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.dataset.rate = r.base_rate;
    opt.textContent = `Room ${r.room_number} - ${r.room_type_name} (₹${r.base_rate}/night)`;
    select.appendChild(opt);
  });

  onWalkInRoomChange();
  openModal('modal-walkin');
}

function openWalkInModalWithRoom(roomId) {
  openWalkInModal().then(() => {
    const select = document.getElementById('walkin-room-select');
    select.value = roomId;
    onWalkInRoomChange();
  });
}

function onWalkInRoomChange() {
  const select = document.getElementById('walkin-room-select');
  const opt = select.selectedOptions[0];
  if (opt) {
    document.getElementById('walkin-rate').value = opt.dataset.rate || 2800;
  }
}

async function handleWalkInSubmit(e) {
  e.preventDefault();
  const payload = {
    first_name: document.getElementById('walkin-first-name').value,
    last_name: document.getElementById('walkin-last-name').value,
    phone: document.getElementById('walkin-phone').value,
    email: document.getElementById('walkin-email').value,
    room_id: document.getElementById('walkin-room-select').value,
    nights: document.getElementById('walkin-nights').value,
    rate_per_night: document.getElementById('walkin-rate').value,
    deposit_paid: document.getElementById('walkin-deposit').value
  };

  try {
    await api('/stays/walk-in', { method: 'POST', body: JSON.stringify(payload) });
    alert('Walk-in guest checked in successfully!');
    closeModal('modal-walkin');
    loadDashboardData();
    loadFrontDeskData();
  } catch (err) {
    alert(err.message);
  }
}

async function openNewReservationModal() {
  const roomTypes = (await api('/rooms/types')).roomTypes;
  const select = document.getElementById('res-room-type');
  select.innerHTML = '';

  roomTypes.forEach(rt => {
    const opt = document.createElement('option');
    opt.value = rt.id;
    opt.dataset.rate = rt.base_rate;
    opt.textContent = `${rt.name} (₹${rt.base_rate}/night)`;
    select.appendChild(opt);
  });

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  document.getElementById('res-check-in').value = today;
  document.getElementById('res-check-out').value = tomorrow;

  onResRoomTypeChange();
  openModal('modal-reservation');
}

async function onResRoomTypeChange() {
  const typeSelect = document.getElementById('res-room-type');
  const opt = typeSelect.selectedOptions[0];
  if (opt) {
    document.getElementById('res-rate').value = opt.dataset.rate || 2800;
  }

  const checkIn = document.getElementById('res-check-in').value;
  const checkOut = document.getElementById('res-check-out').value;
  if (checkIn && checkOut && opt) {
    const availRes = await api(`/rooms/availability?check_in=${checkIn}&check_out=${checkOut}&room_type_id=${opt.value}`);
    const roomSelect = document.getElementById('res-room-select');
    roomSelect.innerHTML = '<option value="">-- Assign Later at Check-In --</option>';
    availRes.rooms.forEach(r => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = `Room ${r.room_number}`;
      roomSelect.appendChild(o);
    });
  }
}

async function handleReservationSubmit(e) {
  e.preventDefault();
  const payload = {
    guest_data: {
      first_name: document.getElementById('res-first-name').value,
      phone: document.getElementById('res-phone').value
    },
    check_in_date: document.getElementById('res-check-in').value,
    check_out_date: document.getElementById('res-check-out').value,
    room_type_id: document.getElementById('res-room-type').value,
    assigned_room_id: document.getElementById('res-room-select').value || null,
    rate_per_night: document.getElementById('res-rate').value,
    deposit_amount: document.getElementById('res-deposit').value
  };

  try {
    const res = await api('/reservations', { method: 'POST', body: JSON.stringify(payload) });
    alert(`Reservation confirmed! Booking Reference: ${res.bookingReference}`);
    closeModal('modal-reservation');
    loadReservationsData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function openNewGroupModal() {
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10);
  document.getElementById('grp-start-date').value = today;
  document.getElementById('grp-end-date').value = nextWeek;

  const container = document.getElementById('grp-room-slots-container');
  container.innerHTML = '';
  addGroupRoomRow();
  addGroupRoomRow();
  addGroupRoomRow();

  openModal('modal-group');
}

async function addGroupRoomRow() {
  const container = document.getElementById('grp-room-slots-container');
  const roomTypes = (await api('/rooms/types')).roomTypes;
  const rooms = (await api('/rooms')).rooms.filter(r => r.operational_status === 'available');

  const rowId = `grp-slot-${Date.now()}-${Math.random().toString().slice(2, 6)}`;
  const div = document.createElement('div');
  div.id = rowId;
  div.className = 'grid grid-cols-4 gap-2 items-center p-2 bg-slate-800 rounded-lg text-xs';
  div.innerHTML = `
    <select name="slot-type" class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white">
      ${roomTypes.map(rt => `<option value="${rt.id}" data-rate="${rt.base_rate}">${rt.name}</option>`).join('')}
    </select>
    <select name="slot-room" class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white">
      <option value="">Unassigned</option>
      ${rooms.map(r => `<option value="${r.id}">Room #${r.room_number}</option>`).join('')}
    </select>
    <input type="text" name="slot-guest" placeholder="Guest Name" class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white">
    <div class="flex items-center space-x-1">
      <input type="number" name="slot-rate" value="3500" class="w-16 px-1.5 py-1 bg-slate-900 border border-slate-700 rounded text-white font-mono">
      <button type="button" onclick="document.getElementById('${rowId}').remove()" class="text-rose-400 font-bold px-1">&times;</button>
    </div>
  `;
  container.appendChild(div);
}

async function handleGroupSubmit(e) {
  e.preventDefault();
  const slotRows = document.querySelectorAll('#grp-room-slots-container > div');
  if (!slotRows.length) {
    alert('Please add at least one room slot.');
    return;
  }

  const rooms = [];
  slotRows.forEach(row => {
    rooms.push({
      room_type_id: row.querySelector('[name="slot-type"]').value,
      assigned_room_id: row.querySelector('[name="slot-room"]').value || null,
      guest_name: row.querySelector('[name="slot-guest"]').value || 'Group Member',
      nightly_rate: Number(row.querySelector('[name="slot-rate"]').value) || 3500
    });
  });

  const payload = {
    group_name: document.getElementById('grp-name').value,
    booking_source: document.getElementById('grp-source').value,
    contact_name: document.getElementById('grp-contact-name').value,
    contact_phone: document.getElementById('grp-contact-phone').value,
    planned_start_date: document.getElementById('grp-start-date').value,
    planned_end_date: document.getElementById('grp-end-date').value,
    deposit_amount: document.getElementById('grp-deposit').value,
    rooms
  };

  try {
    const res = await api('/groups', { method: 'POST', body: JSON.stringify(payload) });
    alert(`Group booking created! Group #: ${res.groupBookingNumber}`);
    closeModal('modal-group');
    loadGroupsData();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

function openAddChargeModal(folioId) {
  currentSelectedFolioId = folioId;
  openModal('modal-add-charge');
}

async function handleAddChargeSubmit(e) {
  e.preventDefault();
  const payload = {
    department: document.getElementById('charge-dept').value,
    description: document.getElementById('charge-desc').value,
    quantity: document.getElementById('charge-qty').value,
    unit_price: document.getElementById('charge-price').value,
    tax_rate: document.getElementById('charge-tax-rate').value
  };

  try {
    await api(`/folios/${currentSelectedFolioId}/entries`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    alert('Charge posted to folio successfully!');
    closeModal('modal-add-charge');
    loadSelectedFolio();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

function openAddPaymentModal(folioId) {
  currentSelectedFolioId = folioId;
  openModal('modal-add-payment');
}

async function handleAddPaymentSubmit(e) {
  e.preventDefault();
  const payload = {
    amount: document.getElementById('pay-amount').value,
    payment_method: document.getElementById('pay-method').value,
    transaction_ref: document.getElementById('pay-ref').value,
    notes: document.getElementById('pay-notes').value
  };

  try {
    const res = await api(`/folios/${currentSelectedFolioId}/payments`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    alert(`Payment recorded! Receipt Number: ${res.receiptNumber}`);
    closeModal('modal-add-payment');
    loadSelectedFolio();
    loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

function filterInHouseTable() {
  const query = document.getElementById('search-inhouse').value.toLowerCase();
  const rows = document.querySelectorAll('#tbody-inhouse tr');
  rows.forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}
