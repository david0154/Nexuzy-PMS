// Nexuzy PMS — inventory movements, suppliers and purchase orders UI.
// Loaded after app.js. All stock and money values are computed/validated by the server.

let stockItemsCache = [];
let suppliersCache = [];

function invEsc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function invMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function refreshStockItems() {
  const data = await api('/inventory/items');
  stockItemsCache = data.items || [];
  return stockItemsCache;
}

function openStockItemModal() {
  const form = document.getElementById('form-stock-item');
  if (form) form.reset();
  openModal('modal-stock-item');
}

async function handleAddStockItem(event) {
  event.preventDefault();
  try {
    await api('/inventory/items', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('stock-item-name').value.trim(),
        category: document.getElementById('stock-item-category').value,
        unit: document.getElementById('stock-item-unit').value.trim(),
        current_stock: Number(document.getElementById('stock-item-opening').value || 0),
        min_stock: Number(document.getElementById('stock-item-min').value || 0),
        cost_price: Number(document.getElementById('stock-item-cost').value || 0)
      })
    });
    closeModal('modal-stock-item');
    await loadInventoryData();
    await loadPurchasingData();
  } catch (err) {
    alert(err.message);
  }
}

async function openStockMovementModal(itemId) {
  try {
    const items = await refreshStockItems();
    if (!items.length) return alert('Add a stock item first.');
    const select = document.getElementById('movement-item');
    select.innerHTML = items.map(i => `<option value="${invEsc(i.id)}">${invEsc(i.name)} (${invEsc(i.current_stock)} ${invEsc(i.unit)})</option>`).join('');
    if (itemId) select.value = itemId;
    document.getElementById('form-stock-movement').reset();
    if (itemId) select.value = itemId;
    document.getElementById('movement-type').value = itemId ? 'issue' : 'purchase';
    openModal('modal-stock-movement');
  } catch (err) {
    alert(err.message);
  }
}

async function handleStockMovement(event) {
  event.preventDefault();
  const type = document.getElementById('movement-type').value;
  const directionEl = document.getElementById('movement-direction');
  try {
    await api('/inventory/movements', {
      method: 'POST',
      body: JSON.stringify({
        stock_item_id: document.getElementById('movement-item').value,
        movement_type: type,
        quantity: Number(document.getElementById('movement-quantity').value),
        unit_cost: document.getElementById('movement-cost').value === '' ? undefined : Number(document.getElementById('movement-cost').value),
        direction: type === 'adjustment' ? directionEl.value : undefined,
        reason: document.getElementById('movement-reason').value.trim() || undefined
      })
    });
    closeModal('modal-stock-movement');
    await loadInventoryData();
  } catch (err) {
    alert(err.message);
  }
}

async function showStockLedger(itemId) {
  try {
    const data = await api(`/inventory/items/${itemId}/movements`);
    document.getElementById('stock-ledger-title').textContent = `${data.item.name} · ${data.item.current_stock} ${data.item.unit} in stock`;
    const tbody = document.getElementById('stock-ledger-body');
    tbody.innerHTML = data.movements.length ? data.movements.map(m => `
      <tr>
        <td class="px-2 py-1.5 font-mono text-slate-500">${invEsc(String(m.created_at || '').slice(0, 16))}</td>
        <td class="px-2 py-1.5 uppercase text-[10px] font-bold text-indigo-300">${invEsc(String(m.movement_type).replace(/_/g, ' '))}</td>
        <td class="px-2 py-1.5 text-right font-mono">${invEsc(m.quantity)}</td>
        <td class="px-2 py-1.5 text-right font-mono text-slate-400">${invEsc(m.previous_stock)} → ${invEsc(m.new_stock)}</td>
        <td class="px-2 py-1.5 text-slate-400">${invEsc(m.reason || m.reference || '—')}</td>
        <td class="px-2 py-1.5 text-slate-500">${invEsc(m.created_by_name || '—')}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="text-center py-4 text-slate-500">No movements recorded</td></tr>';
    openModal('modal-stock-ledger');
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Suppliers ----------
async function loadPurchasingData() {
  try {
    const [supplierRes, poRes] = await Promise.all([
      api('/purchasing/suppliers'),
      api('/purchasing/purchase-orders')
    ]);
    suppliersCache = supplierRes.suppliers || [];
    renderSuppliers(suppliersCache);
    renderPurchaseOrders(poRes.purchase_orders || []);
  } catch (err) {
    console.error('Error loading purchasing:', err);
  }
}

function renderSuppliers(suppliers) {
  const tbody = document.getElementById('tbody-suppliers');
  if (!tbody) return;
  if (!suppliers.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-slate-500">No suppliers yet</td></tr>';
    return;
  }
  tbody.innerHTML = suppliers.map(s => `
    <tr class="hover:bg-slate-800/40">
      <td class="px-3 py-2">
        <div class="font-bold text-white">${invEsc(s.name)}</div>
        <div class="text-[10px] text-slate-500">${invEsc(s.company || s.contact_person || '')}</div>
      </td>
      <td class="px-3 py-2 text-slate-400">${invEsc(s.phone || '—')}</td>
      <td class="px-3 py-2 font-mono ${Number(s.outstanding_balance) > 0 ? 'text-amber-300' : 'text-slate-400'}">${invMoney(s.outstanding_balance)}</td>
      <td class="px-3 py-2 text-right">
        <button onclick="openSupplierPayment('${invEsc(s.id)}')" class="text-[10px] font-bold text-emerald-300 hover:text-emerald-200">Pay</button>
      </td>
    </tr>`).join('');
}

function renderPurchaseOrders(orders) {
  const tbody = document.getElementById('tbody-purchase-orders');
  if (!tbody) return;
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-slate-500">No purchase orders yet</td></tr>';
    return;
  }
  const badge = s => {
    const tone = s === 'received' ? 'bg-emerald-500/20 text-emerald-300'
      : s === 'approved' ? 'bg-sky-500/20 text-sky-300'
      : s === 'cancelled' ? 'bg-rose-500/20 text-rose-300'
      : 'bg-amber-500/20 text-amber-300';
    return `<span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase ${tone}">${invEsc(s.replace(/_/g, ' '))}</span>`;
  };
  tbody.innerHTML = orders.map(o => `
    <tr class="hover:bg-slate-800/40">
      <td class="px-3 py-2 font-mono text-white">${invEsc(o.po_number)}</td>
      <td class="px-3 py-2 text-slate-300">${invEsc(o.supplier_name || '—')}</td>
      <td class="px-3 py-2 font-mono">${invMoney(o.total_amount)}</td>
      <td class="px-3 py-2">${badge(o.status)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">
        ${o.status === 'draft' ? `<button onclick="approvePurchaseOrder('${invEsc(o.id)}')" class="text-[10px] font-bold text-sky-300 mr-2">Approve</button>` : ''}
        ${['approved', 'partially_received'].includes(o.status) ? `<button onclick="receivePurchaseOrder('${invEsc(o.id)}')" class="text-[10px] font-bold text-emerald-300 mr-2">Receive</button>` : ''}
        ${['draft', 'pending_approval', 'approved'].includes(o.status) ? `<button onclick="cancelPurchaseOrder('${invEsc(o.id)}')" class="text-[10px] font-bold text-rose-300">Cancel</button>` : ''}
      </td>
    </tr>`).join('');
}

function openSupplierModal() {
  const form = document.getElementById('form-supplier');
  if (form) form.reset();
  openModal('modal-supplier');
}

async function handleAddSupplier(event) {
  event.preventDefault();
  try {
    await api('/purchasing/suppliers', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('supplier-name').value.trim(),
        company: document.getElementById('supplier-company').value.trim() || undefined,
        phone: document.getElementById('supplier-phone').value.trim() || undefined,
        email: document.getElementById('supplier-email').value.trim() || undefined,
        gstin: document.getElementById('supplier-gstin').value.trim() || undefined,
        payment_terms: document.getElementById('supplier-terms').value.trim() || undefined
      })
    });
    closeModal('modal-supplier');
    await loadPurchasingData();
  } catch (err) {
    alert(err.message);
  }
}

async function openSupplierPayment(supplierId) {
  const supplier = suppliersCache.find(s => s.id === supplierId);
  if (!supplier) return;
  const raw = prompt(`Outstanding: ${invMoney(supplier.outstanding_balance)}\nAmount paid to ${supplier.name}:`);
  if (raw === null) return;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return alert('Enter a valid payment amount.');
  const method = (prompt('Payment method: cash, upi, card or bank', 'upi') || '').toLowerCase();
  if (!['cash', 'upi', 'card', 'bank'].includes(method)) return alert('Invalid payment method.');
  try {
    await api(`/purchasing/suppliers/${supplierId}/payments`, {
      method: 'POST',
      body: JSON.stringify({ amount, payment_method: method })
    });
    await loadPurchasingData();
  } catch (err) {
    alert(err.message);
  }
}

async function openPurchaseOrderModal() {
  try {
    const [supplierRes, items] = await Promise.all([api('/purchasing/suppliers'), refreshStockItems()]);
    suppliersCache = supplierRes.suppliers || [];
    if (!suppliersCache.length) return alert('Add a supplier first.');
    const supplierSelect = document.getElementById('po-supplier');
    supplierSelect.innerHTML = suppliersCache.map(s => `<option value="${invEsc(s.id)}">${invEsc(s.name)}</option>`).join('');
    const itemOptions = items.map(i => `<option value="${invEsc(i.id)}">${invEsc(i.name)} (${invEsc(i.unit)})</option>`).join('');
    document.getElementById('po-lines').innerHTML = poLineMarkup(itemOptions);
    document.getElementById('po-expected-date').value = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    document.getElementById('po-notes').value = '';
    openModal('modal-purchase-order');
  } catch (err) {
    alert(err.message);
  }
}

function poLineMarkup(itemOptions) {
  return `<div class="grid grid-cols-12 gap-2 items-end po-line">
    <div class="col-span-5"><label class="input-label">Item</label><select class="input-field po-item">${itemOptions}</select></div>
    <div class="col-span-2"><label class="input-label">Qty</label><input type="number" min="0.001" step="0.001" value="1" class="input-field po-qty"></div>
    <div class="col-span-3"><label class="input-label">Unit cost</label><input type="number" min="0" step="0.01" value="0" class="input-field po-cost"></div>
    <div class="col-span-2"><button type="button" onclick="this.closest('.po-line').remove()" class="btn-secondary text-xs w-full">Remove</button></div>
  </div>`;
}

function addPurchaseOrderLine() {
  const container = document.getElementById('po-lines');
  const options = stockItemsCache.map(i => `<option value="${invEsc(i.id)}">${invEsc(i.name)} (${invEsc(i.unit)})</option>`).join('');
  container.insertAdjacentHTML('beforeend', poLineMarkup(options));
}

async function handleCreatePurchaseOrder(event) {
  event.preventDefault();
  const lines = Array.from(document.querySelectorAll('#po-lines .po-line')).map(line => ({
    stock_item_id: line.querySelector('.po-item').value,
    quantity: Number(line.querySelector('.po-qty').value),
    unit_cost: Number(line.querySelector('.po-cost').value),
    tax_rate: 0
  })).filter(l => l.stock_item_id && l.quantity > 0);
  if (!lines.length) return alert('Add at least one order line.');
  try {
    await api('/purchasing/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: document.getElementById('po-supplier').value,
        expected_date: document.getElementById('po-expected-date').value || undefined,
        notes: document.getElementById('po-notes').value.trim() || undefined,
        items: lines
      })
    });
    closeModal('modal-purchase-order');
    await loadPurchasingData();
  } catch (err) {
    alert(err.message);
  }
}

async function approvePurchaseOrder(id) {
  if (!confirm('Approve this purchase order? Staff can then receive the goods.')) return;
  try {
    await api(`/purchasing/purchase-orders/${id}/approve`, { method: 'POST', body: '{}' });
    await loadPurchasingData();
  } catch (err) {
    alert(err.message);
  }
}

async function cancelPurchaseOrder(id) {
  if (!confirm('Cancel this purchase order?')) return;
  try {
    await api(`/purchasing/purchase-orders/${id}/cancel`, { method: 'POST', body: '{}' });
    await loadPurchasingData();
  } catch (err) {
    alert(err.message);
  }
}

async function receivePurchaseOrder(id) {
  try {
    const detail = await api(`/purchasing/purchase-orders/${id}`);
    const order = detail.purchase_order;
    const lines = (order.items || []).map(item => ({
      id: item.id,
      received_quantity: Number(item.quantity) - Number(item.received_quantity)
    })).filter(l => l.received_quantity > 0);
    if (!lines.length) return alert('Everything on this order has already been received.');
    if (!confirm(`Receive ${lines.length} line(s) in full? Stock will increase immediately.`)) return;
    const res = await api(`/purchasing/purchase-orders/${id}/receive`, {
      method: 'POST',
      body: JSON.stringify({ items: lines })
    });
    alert(res.message);
    await loadPurchasingData();
    await loadInventoryData();
  } catch (err) {
    alert(err.message);
  }
}
