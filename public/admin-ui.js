// Management screens added after the core PMS UI.
// Kept in a separate file so the main application script stays maintainable.

const ROLE_LABELS = {
  admin: 'Administrator',
  general_manager: 'General Manager',
  front_desk: 'Front Desk',
  cashier: 'Cashier',
  captain: 'Restaurant Captain',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
  inventory: 'Store / Inventory'
};

function adminEscape(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adminMoney(value) {
  return `₹${(Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function roleOptions(selected) {
  return Object.entries(ROLE_LABELS).map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`
  ).join('');
}

// =========================================================
// ROOM & ROOM-TYPE MANAGEMENT
// =========================================================
const roomManagerState = { types: [], rooms: [] };

async function openRoomManager() {
  openModal('modal-room-manager');
  await loadRoomManager();
}

async function loadRoomManager() {
  try {
    const [typesRes, roomsRes] = await Promise.all([api('/rooms/types'), api('/rooms')]);
    roomManagerState.types = typesRes.roomTypes || [];
    roomManagerState.rooms = roomsRes.rooms || [];
    renderRoomManager();
  } catch (err) {
    alert(err.message);
  }
}

function renderRoomManager() {
  const typeContainer = document.getElementById('room-types-table');
  const roomContainer = document.getElementById('rooms-table');
  const typeSelect = document.getElementById('room-type-select');
  if (!typeContainer || !roomContainer || !typeSelect) return;

  const selectedType = typeSelect.value;
  typeSelect.innerHTML = roomManagerState.types.length
    ? roomManagerState.types.map(t => `<option value="${t.id}">${adminEscape(t.name)} (${adminEscape(t.code)})</option>`).join('')
    : '<option value="">Create a room type first</option>';
  if (selectedType && roomManagerState.types.some(t => t.id === selectedType)) typeSelect.value = selectedType;

  typeContainer.innerHTML = roomManagerState.types.length ? roomManagerState.types.map(t => `
    <div class="flex items-center justify-between gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-lg">
      <div class="min-w-0">
        <div class="font-bold text-white truncate">${adminEscape(t.name)} <span class="text-[10px] font-mono text-slate-400">${adminEscape(t.code)}</span></div>
        <div class="text-[10px] text-slate-400">${adminMoney(t.base_rate)} · ${t.max_occupancy} guests · GST ${t.tax_rate}% · ${t.room_count || 0} rooms</div>
      </div>
      <div class="flex gap-1 shrink-0">
        <button onclick="editRoomType('${t.id}')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px]">Edit</button>
        <button onclick="deleteRoomType('${t.id}')" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px]">Delete</button>
      </div>
    </div>
  `).join('') : '<div class="text-slate-500 py-3">No room types yet.</div>';

  roomContainer.innerHTML = roomManagerState.rooms.length ? roomManagerState.rooms.map(r => `
    <div class="flex items-center justify-between gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-lg">
      <div class="min-w-0">
        <div class="font-bold text-white">Room ${adminEscape(r.room_number)} <span class="text-[10px] text-slate-400">${adminEscape(r.room_type_name)}</span></div>
        <div class="text-[10px] text-slate-400">${adminEscape(r.floor || 'Floor 1')} · ${adminEscape(r.building || 'Main Wing')} · ${adminEscape(String(r.operational_status || '').replace(/_/g, ' '))}</div>
      </div>
      <div class="flex gap-1 shrink-0">
        <button onclick="editRoom('${r.id}')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px]">Edit</button>
        <button onclick="deleteRoom('${r.id}')" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px]">Delete</button>
      </div>
    </div>
  `).join('') : '<div class="text-slate-500 py-3">No rooms yet. Create a room type, then add rooms.</div>';
}

function resetRoomTypeForm() {
  const form = document.getElementById('form-room-type');
  if (!form) return;
  form.reset();
  document.getElementById('room-type-id').value = '';
  document.getElementById('room-type-occupancy').value = 2;
  document.getElementById('room-type-extra').value = 500;
  document.getElementById('room-type-tax').value = 12;
}

function editRoomType(id) {
  const type = roomManagerState.types.find(t => t.id === id);
  if (!type) return;
  document.getElementById('room-type-id').value = type.id;
  document.getElementById('room-type-name').value = type.name || '';
  document.getElementById('room-type-code').value = type.code || '';
  document.getElementById('room-type-rate').value = type.base_rate || 0;
  document.getElementById('room-type-occupancy').value = type.max_occupancy || 2;
  document.getElementById('room-type-extra').value = type.extra_adult_rate || 0;
  document.getElementById('room-type-tax').value = type.tax_rate || 0;
  document.getElementById('room-type-amenities').value = type.amenities || '';
}

async function handleRoomTypeSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('room-type-id').value;
  const payload = {
    name: document.getElementById('room-type-name').value.trim(),
    code: document.getElementById('room-type-code').value.trim(),
    base_rate: Number(document.getElementById('room-type-rate').value),
    max_occupancy: Number(document.getElementById('room-type-occupancy').value),
    extra_adult_rate: Number(document.getElementById('room-type-extra').value),
    tax_rate: Number(document.getElementById('room-type-tax').value),
    amenities: document.getElementById('room-type-amenities').value.trim()
  };
  try {
    await api(id ? `/rooms/types/${id}` : '/rooms/types', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    resetRoomTypeForm();
    await loadRoomManager();
    if (typeof loadDashboardData === 'function') loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteRoomType(id) {
  if (!confirm('Delete this room type? It must not be used by any room or booking.')) return;
  try {
    await api(`/rooms/types/${id}`, { method: 'DELETE' });
    await loadRoomManager();
  } catch (err) {
    alert(err.message);
  }
}

function resetRoomForm() {
  const form = document.getElementById('form-room');
  if (!form) return;
  form.reset();
  document.getElementById('room-id').value = '';
  document.getElementById('room-building').value = 'Main Wing';
}

function editRoom(id) {
  const room = roomManagerState.rooms.find(r => r.id === id);
  if (!room) return;
  document.getElementById('room-id').value = room.id;
  document.getElementById('room-number').value = room.room_number || '';
  document.getElementById('room-type-select').value = room.room_type_id;
  document.getElementById('room-floor').value = room.floor || '';
  document.getElementById('room-building').value = room.building || 'Main Wing';
  document.getElementById('room-features').value = room.features || '';
}

async function handleRoomSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('room-id').value;
  const payload = {
    room_number: document.getElementById('room-number').value.trim(),
    room_type_id: document.getElementById('room-type-select').value,
    floor: document.getElementById('room-floor').value.trim(),
    building: document.getElementById('room-building').value.trim(),
    features: document.getElementById('room-features').value.trim()
  };
  if (!payload.room_type_id) return alert('Create a room type before adding rooms.');
  try {
    await api(id ? `/rooms/${id}` : '/rooms', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    resetRoomForm();
    await loadRoomManager();
    if (typeof loadRoomsHousekeepingData === 'function') loadRoomsHousekeepingData();
    if (typeof loadDashboardData === 'function') loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteRoom(id) {
  if (!confirm('Delete this room? Rooms with bookings or history cannot be deleted.')) return;
  try {
    await api(`/rooms/${id}`, { method: 'DELETE' });
    await loadRoomManager();
    if (typeof loadRoomsHousekeepingData === 'function') loadRoomsHousekeepingData();
    if (typeof loadDashboardData === 'function') loadDashboardData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// RESTAURANT MENU MANAGEMENT
// =========================================================
const menuManagerState = { categories: [], items: [] };

async function openMenuManager() {
  openModal('modal-menu-manager');
  await loadMenuManager();
}

async function loadMenuManager() {
  try {
    const data = await api('/restaurant/menu/manage');
    menuManagerState.categories = data.categories || [];
    menuManagerState.items = data.items || [];
    renderMenuManager();
  } catch (err) {
    alert(err.message);
  }
}

function renderMenuManager() {
  const categoryList = document.getElementById('menu-categories-list');
  const itemList = document.getElementById('menu-items-list');
  const categorySelect = document.getElementById('menu-item-category');
  if (!categoryList || !itemList || !categorySelect) return;

  const selectedCategory = categorySelect.value;
  const activeCategories = menuManagerState.categories.filter(c => c.is_active);
  categorySelect.innerHTML = activeCategories.length
    ? activeCategories.map(c => `<option value="${c.id}">${adminEscape(c.name)}</option>`).join('')
    : '<option value="">Create a category first</option>';
  if (selectedCategory && activeCategories.some(c => c.id === selectedCategory)) categorySelect.value = selectedCategory;

  categoryList.innerHTML = menuManagerState.categories.length ? menuManagerState.categories.map(c => `
    <div class="flex items-center justify-between gap-2 p-2 bg-slate-800/50 border border-slate-700 rounded-lg ${c.is_active ? '' : 'opacity-60'}">
      <div>
        <div class="font-bold text-white">${adminEscape(c.name)}</div>
        <div class="text-[10px] text-slate-400">${c.item_count} items${c.is_active ? '' : ' · archived'}</div>
      </div>
      <div class="flex gap-1">
        <button onclick="renameMenuCategory('${c.id}')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px]">Rename</button>
        <button onclick="archiveMenuCategory('${c.id}')" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px]">Archive</button>
      </div>
    </div>
  `).join('') : '<div class="text-slate-500">No categories yet.</div>';

  itemList.innerHTML = menuManagerState.items.length ? menuManagerState.items.map(i => `
    <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-lg ${i.is_available ? '' : 'opacity-60'}">
      <div class="min-w-0">
        <div class="font-bold text-white">${adminEscape(i.name)}
          <span class="ml-1 text-[9px] px-1.5 py-0.5 rounded ${i.is_veg ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}">${i.is_veg ? 'VEG' : 'NON-VEG'}</span>
          ${i.is_available ? '' : '<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">UNAVAILABLE</span>'}
        </div>
        <div class="text-[10px] text-slate-400">${adminEscape(i.category_name)} · ${adminMoney(i.price)} · GST ${i.tax_rate}% · ${adminEscape(i.station)}</div>
      </div>
      <div class="flex gap-1">
        <button onclick="toggleMenuItem('${i.id}', ${i.is_available ? 'false' : 'true'})" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px]">${i.is_available ? 'Mark unavailable' : 'Mark available'}</button>
        <button onclick="editMenuItem('${i.id}')" class="px-2 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 text-[10px]">Edit</button>
        <button onclick="archiveMenuItem('${i.id}')" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px]">Archive</button>
      </div>
    </div>
  `).join('') : '<div class="text-slate-500">No menu items yet.</div>';
}

async function handleMenuCategorySubmit(event) {
  event.preventDefault();
  const name = document.getElementById('menu-category-name').value.trim();
  if (!name) return;
  try {
    await api('/restaurant/menu/categories', { method: 'POST', body: JSON.stringify({ name }) });
    document.getElementById('menu-category-name').value = '';
    await loadMenuManager();
    if (typeof loadRestaurantPosData === 'function') loadRestaurantPosData();
  } catch (err) {
    alert(err.message);
  }
}

async function renameMenuCategory(id) {
  const category = menuManagerState.categories.find(c => c.id === id);
  if (!category) return;
  const name = prompt('Category name:', category.name);
  if (!name || !name.trim()) return;
  try {
    await api(`/restaurant/menu/categories/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
    await loadMenuManager();
    if (typeof loadRestaurantPosData === 'function') loadRestaurantPosData();
  } catch (err) {
    alert(err.message);
  }
}

async function archiveMenuCategory(id) {
  if (!confirm('Archive this category? Move its items to another category first.')) return;
  try {
    await api(`/restaurant/menu/categories/${id}`, { method: 'DELETE' });
    await loadMenuManager();
    if (typeof loadRestaurantPosData === 'function') loadRestaurantPosData();
  } catch (err) {
    alert(err.message);
  }
}

function resetMenuItemForm() {
  const form = document.getElementById('form-menu-item');
  if (!form) return;
  form.reset();
  document.getElementById('menu-item-id').value = '';
  document.getElementById('menu-item-tax').value = 5;
  document.getElementById('menu-item-veg').checked = true;
  document.getElementById('menu-item-available').checked = true;
}

function editMenuItem(id) {
  const item = menuManagerState.items.find(i => i.id === id);
  if (!item) return;
  document.getElementById('menu-item-id').value = item.id;
  document.getElementById('menu-item-name').value = item.name || '';
  document.getElementById('menu-item-category').value = item.category_id;
  document.getElementById('menu-item-price').value = item.price || 0;
  document.getElementById('menu-item-tax').value = item.tax_rate || 0;
  document.getElementById('menu-item-station').value = item.station || 'kitchen';
  document.getElementById('menu-item-veg').checked = Boolean(item.is_veg);
  document.getElementById('menu-item-available').checked = Boolean(item.is_available);
  document.getElementById('menu-item-description').value = item.description || '';
}

async function handleMenuItemSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('menu-item-id').value;
  const payload = {
    name: document.getElementById('menu-item-name').value.trim(),
    category_id: document.getElementById('menu-item-category').value,
    price: Number(document.getElementById('menu-item-price').value),
    tax_rate: Number(document.getElementById('menu-item-tax').value),
    station: document.getElementById('menu-item-station').value,
    is_veg: document.getElementById('menu-item-veg').checked,
    is_available: document.getElementById('menu-item-available').checked,
    description: document.getElementById('menu-item-description').value.trim()
  };
  if (!payload.category_id) return alert('Create a menu category first.');
  try {
    await api(id ? `/restaurant/menu/items/${id}` : '/restaurant/menu/items', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    resetMenuItemForm();
    await loadMenuManager();
    if (typeof loadRestaurantPosData === 'function') loadRestaurantPosData();
  } catch (err) {
    alert(err.message);
  }
}

async function toggleMenuItem(id, available) {
  try {
    await api(`/restaurant/menu/items/${id}`, { method: 'PATCH', body: JSON.stringify({ is_available: available }) });
    await loadMenuManager();
    if (typeof loadRestaurantPosData === 'function') loadRestaurantPosData();
  } catch (err) {
    alert(err.message);
  }
}

async function archiveMenuItem(id) {
  if (!confirm('Archive this item? It disappears from the POS but remains on past bills.')) return;
  try {
    await api(`/restaurant/menu/items/${id}`, { method: 'DELETE' });
    await loadMenuManager();
    if (typeof loadRestaurantPosData === 'function') loadRestaurantPosData();
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// STAFF USER MANAGEMENT
// =========================================================
let staffUsersCache = [];

async function openUserManager() {
  openModal('modal-user-manager');
  await loadStaffUsers();
}

async function loadStaffUsers() {
  try {
    const data = await api('/auth/users');
    staffUsersCache = data.users || [];
    renderStaffUsers();
    renderStaffUserSummary();
  } catch (err) {
    console.error('Staff users:', err);
    const container = document.getElementById('staff-users-list');
    if (container) container.innerHTML = `<div class="text-rose-400">${adminEscape(err.message)}</div>`;
  }
}

function renderStaffUserSummary() {
  const container = document.getElementById('staff-user-summary');
  if (!container) return;
  const active = staffUsersCache.filter(u => u.is_active);
  if (!staffUsersCache.length) {
    container.innerHTML = '<div class="text-slate-500 text-xs">No staff users found.</div>';
    return;
  }
  container.innerHTML = staffUsersCache.slice(0, 6).map(u => `
    <div class="p-2.5 bg-slate-800/50 border border-slate-700 rounded-lg">
      <div class="text-xs font-bold text-white">${adminEscape(u.full_name)} ${u.is_active ? '' : '<span class="text-[9px] text-rose-300">INACTIVE</span>'}</div>
      <div class="text-[10px] text-slate-400">@${adminEscape(u.username)} · ${adminEscape(ROLE_LABELS[u.role] || u.role)}</div>
    </div>
  `).join('') + `<div class="p-2.5 text-[11px] text-slate-400">${active.length} active of ${staffUsersCache.length} staff logins</div>`;
}

function renderStaffUsers() {
  const container = document.getElementById('staff-users-list');
  if (!container) return;
  if (!staffUsersCache.length) {
    container.innerHTML = '<div class="text-slate-500">No staff users yet. Use the form above to add one.</div>';
    return;
  }
  container.innerHTML = staffUsersCache.map(u => {
    const isSelf = typeof currentUser !== 'undefined' && currentUser && currentUser.id === u.id;
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-2 items-center p-2.5 bg-slate-800/50 border border-slate-700 rounded-lg">
        <div class="lg:col-span-4">
          <div class="font-bold text-white">${adminEscape(u.full_name)} ${isSelf ? '<span class="text-[9px] text-indigo-300">YOU</span>' : ''}</div>
          <div class="text-[10px] text-slate-400">@${adminEscape(u.username)} · ${adminEscape(u.email || 'no email')}</div>
        </div>
        <div class="lg:col-span-3">
          <select id="user-role-${u.id}" class="input-field text-xs py-1.5">${roleOptions(u.role)}</select>
        </div>
        <div class="lg:col-span-2">
          <label class="flex items-center gap-2 text-[11px] text-slate-300">
            <input type="checkbox" id="user-active-${u.id}" ${u.is_active ? 'checked' : ''} ${isSelf ? 'disabled' : ''} class="rounded bg-slate-800 border-slate-700"> Active
          </label>
        </div>
        <div class="lg:col-span-3 flex justify-end gap-1">
          <button onclick="saveStaffUser('${u.id}')" class="px-2 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 text-[10px]">Save</button>
          <button onclick="resetStaffPassword('${u.id}')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[10px]">Reset password</button>
        </div>
      </div>
    `;
  }).join('');
}

async function handleCreateUser(event) {
  event.preventDefault();
  const payload = {
    username: document.getElementById('new-user-username').value.trim(),
    full_name: document.getElementById('new-user-fullname').value.trim(),
    email: document.getElementById('new-user-email').value.trim(),
    phone: document.getElementById('new-user-phone').value.trim(),
    role: document.getElementById('new-user-role').value,
    password: document.getElementById('new-user-password').value
  };
  try {
    const res = await api('/auth/users', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('form-new-user').reset();
    document.getElementById('new-user-role').value = 'front_desk';
    await loadStaffUsers();
    alert(res.message || 'Staff user created');
  } catch (err) {
    alert(err.message);
  }
}

async function saveStaffUser(id) {
  const role = document.getElementById(`user-role-${id}`).value;
  const activeEl = document.getElementById(`user-active-${id}`);
  try {
    await api(`/auth/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role, is_active: activeEl ? activeEl.checked : undefined })
    });
    await loadStaffUsers();
    alert('User access updated');
  } catch (err) {
    alert(err.message);
  }
}

async function resetStaffPassword(id) {
  const password = prompt('Enter a new password (minimum 8 characters). This signs the user out everywhere.');
  if (password === null) return;
  if (password.length < 8) return alert('Password must be at least 8 characters.');
  try {
    const res = await api(`/auth/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    alert(res.message || 'Password reset');
  } catch (err) {
    alert(err.message);
  }
}

// =========================================================
// PDF DOWNLOADS
// =========================================================
async function downloadAuthorizedFile(path, fallbackName) {
  const token = localStorage.getItem('nexuzy_token');
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (res.status === 401) {
      if (typeof handleLogout === 'function') handleLogout();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      let message = 'Could not download the PDF';
      try {
        const data = await res.json();
        if (data.error) message = data.error;
      } catch (err) { /* response was not JSON */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const filename = match ? match[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    alert(err.message);
  }
}

function downloadInvoicePdf() {
  if (!window.currentInvoicePdfPath) {
    return alert('This document is not a final tax invoice. Generate the final invoice first.');
  }
  downloadAuthorizedFile(window.currentInvoicePdfPath, 'tax-invoice.pdf');
}

// =========================================================
// RESTAURANT BILL VIEW + PDF
// =========================================================
let currentRestaurantBill = null;

async function showRestaurantBill(orderId) {
  try {
    const data = await api(`/restaurant/orders/${orderId}/bill`);
    currentRestaurantBill = data.bill;
    const bill = data.bill;
    const container = document.getElementById('restaurant-bill-content');
    container.innerHTML = `
      <div class="flex justify-between items-start pb-3 border-b border-slate-800">
        <div>
          <div class="text-base font-bold text-white">${adminEscape(bill.property.name)}</div>
          <div class="text-[10px] text-slate-400">${adminEscape([bill.property.address, bill.property.city, bill.property.state].filter(Boolean).join(', '))}</div>
          <div class="text-[10px] text-slate-400">GSTIN: ${adminEscape(bill.property.gstin || 'Unregistered')}</div>
        </div>
        <div class="text-right">
          <div class="text-[10px] uppercase tracking-wider text-indigo-300 font-bold">Restaurant Bill</div>
          <div class="font-mono text-white text-xs">${adminEscape(bill.bill_number)}</div>
          <div class="text-[10px] text-slate-400">${adminEscape(String(bill.settled_at || '').slice(0, 16))}</div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 py-3 text-[11px] text-slate-400">
        <div>Order: <span class="text-white font-mono">${adminEscape(bill.order_number)}</span></div>
        <div>Type: <span class="text-white">${adminEscape(String(bill.order_type || '').replace(/_/g, ' '))}</span></div>
        <div>Table: <span class="text-white">${adminEscape(bill.table_number || '—')}</span></div>
        <div>Room: <span class="text-white">${adminEscape(bill.room_number || '—')}</span></div>
      </div>
      <table class="w-full text-left text-xs border-t border-slate-800">
        <thead><tr class="text-[10px] uppercase text-slate-500"><th class="py-2">Item</th><th class="py-2 text-right">Qty</th><th class="py-2 text-right">Rate</th><th class="py-2 text-right">Tax</th><th class="py-2 text-right">Amount</th></tr></thead>
        <tbody class="divide-y divide-slate-800">
          ${(bill.items || []).map(item => `
            <tr>
              <td class="py-2 text-white">${adminEscape(item.item_name)}</td>
              <td class="py-2 text-right text-slate-300">${item.quantity}</td>
              <td class="py-2 text-right text-slate-300">${adminMoney(item.unit_price)}</td>
              <td class="py-2 text-right text-slate-300">${adminMoney(item.tax_amount)}</td>
              <td class="py-2 text-right text-white font-mono">${adminMoney(item.total_amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="mt-3 ml-auto w-64 space-y-1 text-xs">
        <div class="flex justify-between text-slate-400"><span>Subtotal</span><span class="text-white">${adminMoney(bill.subtotal)}</span></div>
        <div class="flex justify-between text-slate-400"><span>GST</span><span class="text-white">${adminMoney(bill.tax_amount)}</span></div>
        <div class="flex justify-between border-t border-slate-800 pt-1 font-bold text-white"><span>Total</span><span>${adminMoney(bill.total_amount)}</span></div>
        <div class="flex justify-between text-slate-400"><span>Payment</span><span class="text-white uppercase">${adminEscape(bill.payment_method || '')}</span></div>
      </div>
      <div class="pt-3 mt-3 border-t border-slate-800 text-center text-[10px] text-slate-500">
        Generated by Nexuzy PMS · Nexuzy Lab
      </div>
      <div class="flex flex-wrap justify-end gap-2 pt-4">
        <button onclick="downloadRestaurantBillPdf()" class="btn-primary text-xs">⬇️ Download PDF Bill</button>
        <button onclick="whatsappRestaurantBill()" class="btn-secondary text-xs">💬 WhatsApp Bill</button>
        <button onclick="closeModal('modal-restaurant-bill')" class="btn-secondary text-xs">Close</button>
      </div>
    `;
    openModal('modal-restaurant-bill');
  } catch (err) {
    alert(err.message);
  }
}

function downloadRestaurantBillPdf() {
  if (!currentRestaurantBill) return alert('No restaurant bill loaded.');
  downloadAuthorizedFile(`/restaurant/orders/${currentRestaurantBill.id}/bill/pdf`, `${currentRestaurantBill.bill_number}.pdf`);
}

// =========================================================
// LAN DIAGNOSTICS
// =========================================================
async function runLanDiagnostics() {
  const container = document.getElementById('lan-diagnostics');
  if (!container) return;
  container.innerHTML = '<div class="text-slate-500">Running connection checks...</div>';
  try {
    const data = await api('/network/diagnostics');
    container.innerHTML = (data.checks || []).map(check => {
      const icon = check.ok === null ? 'ℹ️' : (check.ok ? '✅' : '❌');
      const color = check.ok === null ? 'text-slate-400' : (check.ok ? 'text-emerald-300' : 'text-rose-300');
      return `<div class="${color}">${icon} <strong>${adminEscape(check.label)}</strong> — ${adminEscape(check.detail)}</div>`;
    }).join('') + (data.firewall && data.firewall.supported && !(data.firewall.present && data.firewall.enabled)
      ? '<div class="mt-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-amber-200">Windows Firewall is likely blocking other devices. On the hotel computer, double-click <strong>enable-lan-firewall.bat</strong> and approve the Administrator prompt, then try the LAN URL again.</div>'
      : '') + ((data.network_profiles || []).some(p => /public/i.test(p.category))
      ? `<div class="mt-2 p-2 bg-sky-500/10 border border-sky-500/30 rounded text-sky-200">Windows labels ${adminEscape((data.network_profiles || []).filter(p => /public/i.test(p.category)).map(p => p.name).join(', '))} as a Public network. The firewall helper opens only the Node process, and the PMS still rejects public IP clients. If phones still fail, use the URL for the interface they share.</div>`
      : '');
  } catch (err) {
    container.innerHTML = `<div class="text-rose-300">${adminEscape(err.message)}</div>`;
  }
}
