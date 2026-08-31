/* UI wiring: tabs, CRUD tables, modals, quotation/invoice two-step flow, payments. */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* Set once runLoginGate() resolves (see the bottom of this file); { username, isAdmin, isViewer }. */
let currentUser = null;

/* Called as the first line of every handler that mutates business data — the real
   enforcement for the view-only role (js/storage.js's writeList/writeObject throwing
   is only a backstop for anything that forgets this guard). */
function blockIfViewer() {
  if (currentUser && currentUser.isViewer) { toast('View-only account — changes are disabled'); return true; }
  return false;
}

/* Called as the second check (after blockIfViewer()) in every delete-like
   handler — regular non-admin Users keep full add/edit access, only Delete
   (and the equivalent "Clear All Data") is admin-only. js/storage.js's
   assertCanDelete() is only a backstop for anything that forgets this guard. */
function blockDeleteIfNotAdmin() {
  if (!currentUser || !currentUser.isAdmin) { toast('Only admins can delete records'); return true; }
  return false;
}

function todayISO() {
  // Not new Date().toISOString().slice(0,10) — that converts to UTC first, which
  // can show yesterday's or tomorrow's date depending on the local timezone
  // offset at the moment of the call. formatDateISO() formats local components.
  return formatDateISO(new Date());
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* Most mutating handlers call Store.saveX()/deleteX() with no try/catch, so a
   thrown error (the viewer/delete-restriction backstops in storage.js, or an
   edge case in a guard like ensureEditingRecordExists) surfaces as a silent,
   uncaught exception instead of a toast. Wrap a handler's function at its
   addEventListener(...) call site with this instead of restructuring each
   handler's body individually. */
function withErrorToast(fn) {
  return function (...args) {
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.catch === 'function') {
        result.catch((e) => toast('Something went wrong: ' + (e.message || e)));
      }
      return result;
    } catch (e) {
      toast('Something went wrong: ' + (e.message || e));
    }
  };
}

function openModal(id) { $('#' + id).classList.add('open'); }
function closeModal(id) { $('#' + id).classList.remove('open'); }

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openOverlay = document.querySelector('.modal-overlay.open');
  if (openOverlay) openOverlay.classList.remove('open');
});

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) {
    closeModal(e.target.getAttribute('data-close'));
  }
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

/* ---------------- Tabs (two-level: primary + Sales/Financials sub-navs) ---------------- */
const tabGroups = { sales: ['quotations', 'invoices', 'payments'], financials: ['summary', 'pnl', 'gst'], charts: ['companySalesChart', 'productSalesChart', 'pendingPaymentsChart', 'purchaseCompanyChart', 'expenseCategoryChart'] };
const lastSubTab = { sales: 'quotations', financials: 'summary', charts: 'companySalesChart' };

/* Admin-configurable tab layout (Settings > Tab Layout) — which of the 6
   primary nav tabs are visible/in what order. Error Logs is deliberately
   excluded: it keeps its own existing hardcoded admin-only visibility
   (see activateTab() below) and is always pinned last in the nav. */
const PRIMARY_NAV_DEFAULT_ORDER = ['financials', 'sales', 'purchases', 'products', 'companies', 'charts'];
const PRIMARY_NAV_LABELS = { financials: 'Financials', sales: 'Sales', purchases: 'Purchase', products: 'Products', companies: 'Company', charts: 'Charts' };

function normalizeTabOrder(savedOrder) {
  const valid = (savedOrder || []).filter((id) => PRIMARY_NAV_DEFAULT_ORDER.includes(id));
  const missing = PRIMARY_NAV_DEFAULT_ORDER.filter((id) => !valid.includes(id));
  return [...valid, ...missing]; // forward-compat: a future new tab not yet in a saved config just appends at the end
}

function primaryNavButtonEl(id) {
  return $(`.tabs-primary .tab-btn[data-group="${id}"]`) || $(`.tabs-primary .tab-btn[data-tab="${id}"]`);
}

/* Reorders the actual primary-nav <button> DOM elements and applies hide state.
   Reorder applies to everyone (including admins); hide only applies to
   non-admins — admins always see every tab so they can never lock themselves
   out of Settings. */
function applyTabLayout() {
  const layout = Store.getTabLayout();
  const order = normalizeTabOrder(layout.order);
  const nav = $('.tabs-primary');
  order.forEach((id) => { const btn = primaryNavButtonEl(id); if (btn) nav.appendChild(btn); });
  const errBtn = $('#navErrorLogs');
  if (errBtn) nav.appendChild(errBtn); // always pinned last, unaffected by config
  const hidden = (currentUser && currentUser.isAdmin) ? [] : (layout.hidden || []);
  order.forEach((id) => {
    const btn = primaryNavButtonEl(id);
    if (btn) btn.style.display = hidden.includes(id) ? 'none' : '';
  });
}

/* First-load landing tab: the hardcoded 'summary' default breaks if Financials
   is hidden for the current (non-admin) user, so pick the first visible tab instead. */
function getDefaultLandingTabId() {
  const layout = Store.getTabLayout();
  const hidden = (currentUser && currentUser.isAdmin) ? [] : (layout.hidden || []);
  const order = normalizeTabOrder(layout.order);
  const firstVisible = order.find((id) => !hidden.includes(id)) || 'financials';
  return tabGroups[firstVisible] ? lastSubTab[firstVisible] : firstVisible;
}

/* Always-fresh-on-tab-selection fetching (Supabase backend only —
   Store.refreshSupabaseKeys no-ops instantly for the file backend, so this
   list is harmless there too; it just means these tabs now also refresh on
   every click, not only at init() and after their own CRUD actions). Every
   tab here always refetches fresh from Supabase on every selection — there is
   no caching/skip-if-loaded — so cross-session changes (e.g. a company added
   or renamed in another session) show up on the very next visit to any tab
   that reads it, not just the Company tab itself. See "Always-fresh data on
   tab selection" in CLAUDE.md. */
const TAB_LAZY_KEYS = {
  products: [STORAGE_KEYS.products],
  companies: [STORAGE_KEYS.companies],
  quotations: [STORAGE_KEYS.quotations, STORAGE_KEYS.companies],
  invoices: [STORAGE_KEYS.invoices, STORAGE_KEYS.companies],
  payments: [STORAGE_KEYS.invoices, STORAGE_KEYS.companies],
  /* "Cash / Manual Expenses" is a second section inside the same #tab-purchases
     panel (see index.html), not a separate nav-activated tab — there is no
     data-tab="expenses" button anywhere, so an 'expenses' key here would never
     actually be requested via activateTab(). Expenses is folded into the
     purchases entry instead, so opening/returning to the Purchase tab refreshes
     both sections' data together. */
  purchases: [STORAGE_KEYS.purchases, STORAGE_KEYS.companies, STORAGE_KEYS.expenses],
  summary: [STORAGE_KEYS.invoices, STORAGE_KEYS.companies],
  pnl: [STORAGE_KEYS.invoices, STORAGE_KEYS.purchases, STORAGE_KEYS.expenses],
  gst: [STORAGE_KEYS.invoices, STORAGE_KEYS.purchases],
  companySalesChart: [STORAGE_KEYS.invoices, STORAGE_KEYS.companies],
  productSalesChart: [STORAGE_KEYS.invoices],
  pendingPaymentsChart: [STORAGE_KEYS.invoices, STORAGE_KEYS.companies],
  purchaseCompanyChart: [STORAGE_KEYS.purchases, STORAGE_KEYS.companies],
  expenseCategoryChart: [STORAGE_KEYS.expenses],
};

/* Where to show a Loading…/error placeholder while a refetch is in flight —
   only for tabs whose render target is a simple table body or accordion div.
   summary/pnl/gst/charts render straight into their own stat-card/canvas
   layout once the gate resolves; a fetch failure there still surfaces via the
   catch below's toast, it just doesn't get an in-panel placeholder first —
   the data fetched is equally fresh either way, this is cosmetic only. */
const TAB_LOADING_TARGET = {
  products: { selector: '#productsTbody', colspan: 8 },
  companies: { selector: '#companiesTbody', colspan: 6 },
  quotations: { selector: '#quotationsTbody', colspan: 4 },
  invoices: { selector: '#invoicesTbody', colspan: 9 },
  purchases: { selector: '#purchasesTbody', colspan: 9 },
  payments: { selector: '#paymentsByCompany' },
};

function showTabLoading(tabId, text) {
  const target = TAB_LOADING_TARGET[tabId];
  if (!target) return;
  const el = $(target.selector);
  if (!el) return;
  el.innerHTML = target.colspan
    ? `<tr class="empty-row"><td colspan="${target.colspan}">${escapeHtml(text)}</td></tr>`
    : `<div style="text-align:center;color:var(--text-muted);padding:30px;">${escapeHtml(text)}</div>`;
}

let currentTabId = null;

function groupForTab(tabId) {
  return Object.keys(tabGroups).find(g => tabGroups[g].includes(tabId)) || null;
}

async function activateTab(tabId) {
  if (tabId === 'errorLogs' && (!currentUser || !currentUser.isAdmin)) {
    toast('Admins only');
    return;
  }
  currentTabId = tabId;
  $$('.tab-panel').forEach(p => p.classList.remove('active'));
  $('#tab-' + tabId).classList.add('active');
  const lazyKeys = TAB_LAZY_KEYS[tabId];
  if (lazyKeys) {
    showTabLoading(tabId, 'Loading…');
    try {
      await Store.refreshSupabaseKeys(lazyKeys);
    } catch (e) {
      showTabLoading(tabId, 'Could not load data: ' + (e.message || e));
      toast('Could not load data: ' + (e.message || e));
      return;
    }
  }
  if (tabId === 'products') renderProducts();
  if (tabId === 'companies') renderCompanies();
  if (tabId === 'quotations') renderQuotations();
  if (tabId === 'invoices') renderInvoices();
  if (tabId === 'payments') renderPayments();
  if (tabId === 'purchases') { renderPurchases(); renderPurchasesByCompany(); renderExpenses(); }
  if (tabId === 'summary') renderSummary();
  if (tabId === 'pnl') renderProfitLoss();
  if (tabId === 'gst') renderGstPayment();
  if (tabId === 'companySalesChart') renderCompanySalesChart();
  if (tabId === 'productSalesChart') renderProductSalesChart();
  if (tabId === 'pendingPaymentsChart') renderPendingPaymentsChart();
  if (tabId === 'purchaseCompanyChart') renderPurchaseCompanyChart();
  if (tabId === 'expenseCategoryChart') renderExpenseCategoryChart();
  if (tabId === 'errorLogs') renderErrorLogs();
}

function setPrimaryActive(tabIdOrGroup) {
  $$('.tabs-primary .tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabIdOrGroup || b.dataset.group === tabIdOrGroup);
  });
}

function showSubnav(group) {
  $$('.tabs-sub').forEach(nav => nav.style.display = 'none');
  $$('.tabs-sub .tab-btn').forEach(b => b.classList.remove('active'));
  if (group) {
    const nav = $('#subnav-' + group);
    nav.style.display = 'flex';
    const activeSubId = lastSubTab[group];
    const activeBtn = nav.querySelector(`[data-tab="${activeSubId}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }
}

$$('.tabs-primary .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.group) {
      const group = btn.dataset.group;
      setPrimaryActive(group);
      showSubnav(group);
      activateTab(lastSubTab[group]);
    } else {
      setPrimaryActive(btn.dataset.tab);
      showSubnav(null);
      activateTab(btn.dataset.tab);
    }
  });
});

$$('.tabs-sub .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = groupForTab(btn.dataset.tab);
    lastSubTab[group] = btn.dataset.tab;
    $$('.tabs-sub .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activateTab(btn.dataset.tab);
  });
});

function fmt(n) {
  return (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function defaultQuotationAmount(it) {
  const required = Number(it.requiredQty) || 0;
  const qty = Number(it.qty) || 0;
  const rate = Number(it.rate) || 0;
  return round2((required > 0 ? required : qty) * rate);
}
function fmtDateShort(iso) {
  if (!iso) return '';
  return parseLocalDate(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
/** Formats a Date's LOCAL calendar components as "YYYY-MM-DD" — deliberately not
 *  .toISOString() (which converts to UTC and can shift the date by a day). */
function formatDateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso, days) {
  const d = parseLocalDate(iso);
  d.setDate(d.getDate() + (Number(days) || 0));
  return formatDateISO(d);
}
/** Every real (non-Proforma) invoice — Proforma Invoices carry no GST liability and are excluded from all financial reporting/aggregates (Sales, GST Payment, Profit & Loss, Payments, Outstanding, Charts, Excel exports). */
function realInvoices() {
  return Store.getInvoices().filter(inv => !inv.isProforma);
}

function invoiceBalance(inv) {
  const received = inv.payment && inv.payment.received ? Number(inv.payment.amountReceived) || 0 : 0;
  const tdsSettled = inv.payment && inv.payment.received && inv.payment.shortfallType === 'tds' ? Number(inv.payment.shortfallAmount) || 0 : 0;
  return (Number(inv.total) || 0) - received - tdsSettled;
}
function expectedPaymentDate(inv) {
  if (invoiceBalance(inv) <= 0.009) return '-';
  const company = Store.getCompanies().find(c => c.id === inv.companyId);
  if (!company) return '-';
  return fmtDateShort(addDays(inv.date, company.paymentTermsDays));
}
function companyName(id) {
  const c = Store.getCompanies().find(c => c.id === id);
  return c ? c.name : '(unknown)';
}

/* Reprinting an already-saved quotation/invoice should show the company/business
   details as they were at save time (billToSnapshot/profileSnapshot, set in
   buildDocDataFromDraft), not whatever they've since been edited to — otherwise
   correcting a customer's GSTIN or your own bank details today silently rewrites
   what a reprint of an old, already-filed document shows. Records saved before
   this existed have no snapshot, so they fall back to a live lookup exactly as
   before (no change for existing data), and a snapshot is merged over — not
   instead of — the live company so a deleted company still shows its saved name/
   address/GSTIN rather than going blank. */
function resolveBillToCompany(doc) {
  const live = Store.getCompanies().find(c => c.id === doc.companyId);
  return doc.billToSnapshot ? Object.assign({}, live, doc.billToSnapshot) : live;
}

function resolveDocProfile(doc) {
  const live = Store.getProfile();
  return doc.profileSnapshot ? Object.assign({}, live, doc.profileSnapshot) : live;
}

/* Narrows the window for two users generating the same auto-numbered document at
   nearly the same time: re-fetches the freshest copy of the relevant records right
   before a brand-new document is actually saved (a no-op on the local-file backend,
   which has no external source to refresh from — Store.refreshSupabaseKeys() already
   no-ops there) and, only if the number about to be saved has genuinely already been
   taken by something saved in the meantime, swaps in a freshly-recomputed one and
   lets the user know. Never touches a manually-typed number that doesn't actually
   collide. Only ever called for a brand-new document — an edit-save must never
   renumber an already-issued document. */
async function guardAgainstNumberCollision(lazyKeys, currentNo, existingNumbers, recomputeNextNo, fieldLabel) {
  try {
    await Store.refreshSupabaseKeys(lazyKeys);
  } catch (e) {
    return currentNo; // couldn't refresh — proceed with what's already shown rather than blocking the save
  }
  if (!existingNumbers().includes(currentNo)) return currentNo;
  const freshNo = recomputeNextNo();
  toast(`${fieldLabel} "${currentNo}" was just taken by another save — renumbered to ${freshNo}.`);
  return freshNo;
}

/* Called as the first check (after blockIfViewer()) in the Quotation/Invoice/
   Purchase Confirm/Save handlers, before any further work. If another session
   deletes the record being edited between the modal opening and Confirm being
   clicked, code further down the handler (e.g. getQuotationNoForDraft(), or
   looking up the existing invoice's payment sub-object) would otherwise throw
   an uncaught TypeError with no user-facing message. A brand-new document
   (falsy existingId) always passes — there's nothing to check yet. */
function ensureEditingRecordExists(kind, existingId, list) {
  if (!existingId) return true;
  if (list.some(r => r.id === existingId)) return true;
  toast('This record was deleted in another session — please close this and check the list.');
  return false;
}

/* =====================================================================
   Generic sortable table headers (click a <th data-sort-key> to sort)
   and filter state for the Products / Company / Purchase tab tables.
===================================================================== */
const sortState = {};
const SORT_RENDER_FNS = {};

function sortRows(rows, tableKey) {
  const st = sortState[tableKey];
  if (!st) return rows;
  const { key, dir, type } = st;
  const sorted = rows.slice().sort((a, b) => {
    let av = a[key], bv = b[key];
    if (type === 'number') {
      av = Number(av) || 0; bv = Number(bv) || 0;
    } else if (type === 'date') {
      av = av ? new Date(av).getTime() : 0; bv = bv ? new Date(bv).getTime() : 0;
    } else {
      av = (av === undefined || av === null) ? '' : String(av).toLowerCase();
      bv = (bv === undefined || bv === null) ? '' : String(bv).toLowerCase();
    }
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

function updateSortIndicators(tableKey) {
  const st = sortState[tableKey];
  $$(`th[data-sort-table="${tableKey}"]`).forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (st && th.getAttribute('data-sort-key') === st.key) {
      th.classList.add(st.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

document.addEventListener('click', (e) => {
  const th = e.target.closest && e.target.closest('th[data-sort-key]');
  if (!th) return;
  const tableKey = th.getAttribute('data-sort-table');
  const key = th.getAttribute('data-sort-key');
  const type = th.getAttribute('data-sort-type') || 'text';
  const current = sortState[tableKey];
  const dir = (current && current.key === key && current.dir === 'asc') ? 'desc' : 'asc';
  sortState[tableKey] = { key, dir, type };
  const renderFn = SORT_RENDER_FNS[tableKey];
  if (renderFn) renderFn();
});

const filterState = {
  products: { search: '', unit: '', gst: '' },
  companies: { search: '', type: '' },
  purchases: { search: '', company: '', status: '' },
  expenses: { search: '', category: '' },
};

/* =====================================================================
   PRODUCTS
===================================================================== */
function applyProductsFilter(products) {
  const f = filterState.products;
  return products.filter(p => {
    if (f.search) {
      const hay = `${p.name} ${p.hsnCode} ${p.details || ''}`.toLowerCase();
      if (!hay.includes(f.search.toLowerCase())) return false;
    }
    if (f.unit && p.unit !== f.unit) return false;
    if (f.gst && String(p.gstPercent) !== f.gst) return false;
    return true;
  });
}

function populateProductsFilterOptions() {
  const unitSel = $('#productsFilterUnit');
  const currentUnit = unitSel.value;
  const units = Store.getUnits().map(u => u.name);
  unitSel.innerHTML = `<option value="">All Units</option>` + units.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
  unitSel.value = currentUnit;
  const gstSel = $('#productsFilterGst');
  const currentGst = gstSel.value;
  const rates = Store.getGstRates().map(r => r.value).sort((a, b) => a - b);
  gstSel.innerHTML = `<option value="">All GST%</option>` + rates.map(r => `<option value="${r}">${r}%</option>`).join('');
  gstSel.value = currentGst;
}

function renderProducts() {
  const tbody = $('#productsTbody');
  const all = Store.getProducts();
  const products = sortRows(applyProductsFilter(all), 'products');
  if (!all.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No products yet. Click "Add Product" to create one.</td></tr>`;
  } else if (!products.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No products match your filters.</td></tr>`;
  } else {
    tbody.innerHTML = products.map(p => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.hsnCode)}</td>
        <td>${escapeHtml(p.details || '')}</td>
        <td>${p.packingQty}</td>
        <td>${escapeHtml(p.unit)}</td>
        <td>${fmt(p.rate)}</td>
        <td>${p.gstPercent}%</td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-edit-product="${p.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-product="${p.id}">Delete</button>
        </td>
      </tr>
    `).join('');
  }
  updateSortIndicators('products');
}

$('#productsFilterSearch').addEventListener('input', (e) => { filterState.products.search = e.target.value; renderProducts(); });
$('#productsFilterUnit').addEventListener('change', (e) => { filterState.products.unit = e.target.value; renderProducts(); });
$('#productsFilterGst').addEventListener('change', (e) => { filterState.products.gst = e.target.value; renderProducts(); });
$('#productsFilterClear').addEventListener('click', () => {
  filterState.products = { search: '', unit: '', gst: '' };
  $('#productsFilterSearch').value = '';
  $('#productsFilterUnit').value = '';
  $('#productsFilterGst').value = '';
  renderProducts();
});

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function openProductModal(product) {
  $('#productModalTitle').textContent = product ? 'Edit Product' : 'Add Product';
  $('#productId').value = product ? product.id : '';
  $('#productName').value = product ? product.name : '';
  $('#productHsn').value = product ? product.hsnCode : '';
  $('#productDetails').value = product ? (product.details || '') : '';
  $('#productPackingQty').value = product ? product.packingQty : '';
  populateUnitOptions(product ? product.unit : undefined);
  $('#productRate').value = product ? product.rate : '';
  const defaultGstRate = Store.getGstRates().find(r => r.value === 18) || Store.getGstRates()[0];
  populateGstRateOptions($('#productGst'), product ? product.gstPercent : (defaultGstRate ? defaultGstRate.value : undefined));
  openModal('productModal');
}

$('#btnAddProduct').addEventListener('click', () => openProductModal(null));

/* #productForm's Save button lives outside the <form> in .modal-footer, so it's
   not the form's submit control — without this, pressing Enter in a field
   triggers the browser's default (no-op action) form submission, reloading the
   whole page and bouncing back through the login gate (persistSession:false). */
$('#productForm').addEventListener('submit', (e) => { e.preventDefault(); $('#saveProductBtn').click(); });

$('#saveProductBtn').addEventListener('click', withErrorToast(() => {
  if (blockIfViewer()) return;
  const form = $('#productForm');
  if (!form.reportValidity()) return;
  const product = {
    id: $('#productId').value || undefined,
    name: $('#productName').value.trim(),
    hsnCode: $('#productHsn').value.trim(),
    details: $('#productDetails').value.trim(),
    packingQty: Number($('#productPackingQty').value),
    unit: $('#productUnit').value.trim(),
    rate: Number($('#productRate').value),
    gstPercent: Number($('#productGst').value),
  };
  Store.saveProduct(product);
  closeModal('productModal');
  renderProducts();
  toast('Product saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const editId = e.target.getAttribute && e.target.getAttribute('data-edit-product');
  if (editId) openProductModal(Store.getProducts().find(p => p.id === editId));
  const delId = e.target.getAttribute && e.target.getAttribute('data-delete-product');
  if (delId) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    if (confirm('Delete this product?')) { Store.deleteProduct(delId); renderProducts(); toast('Product deleted'); }
  }
}));

/* =====================================================================
   COMPANY (unified sales customers + purchase vendors)
===================================================================== */
function companyTypeBadges(c) {
  const badges = [];
  if (c.isSalesCompany) badges.push('<span class="badge badge-success">Sales</span>');
  if (c.isPurchaseCompany) badges.push('<span class="badge badge-warning">Purchase</span>');
  return badges.join(' ') || '<span class="badge badge-muted">None</span>';
}

function applyCompaniesFilter(companies) {
  const f = filterState.companies;
  return companies.filter(c => {
    if (f.search) {
      const hay = `${c.name} ${c.address || ''} ${c.gstin || ''}`.toLowerCase();
      if (!hay.includes(f.search.toLowerCase())) return false;
    }
    if (f.type === 'sales' && !c.isSalesCompany) return false;
    if (f.type === 'purchase' && !c.isPurchaseCompany) return false;
    if (f.type === 'both' && !(c.isSalesCompany && c.isPurchaseCompany)) return false;
    return true;
  });
}

function renderCompanies() {
  const tbody = $('#companiesTbody');
  const all = Store.getCompanies();
  const companies = sortRows(applyCompaniesFilter(all), 'companies');
  if (!all.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No companies yet. Click "Add Company" to create one.</td></tr>`;
  } else if (!companies.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No companies match your filters.</td></tr>`;
  } else {
    tbody.innerHTML = companies.map(c => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.address || '')}</td>
        <td>${escapeHtml(c.gstin || '')}</td>
        <td>Net ${Number(c.paymentTermsDays) || 0} days</td>
        <td>${companyTypeBadges(c)}</td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-edit-company="${c.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-company="${c.id}">Delete</button>
        </td>
      </tr>
    `).join('');
  }
  updateSortIndicators('companies');
}

$('#companiesFilterSearch').addEventListener('input', (e) => { filterState.companies.search = e.target.value; renderCompanies(); });
$('#companiesFilterType').addEventListener('change', (e) => { filterState.companies.type = e.target.value; renderCompanies(); });
$('#companiesFilterClear').addEventListener('click', () => {
  filterState.companies = { search: '', type: '' };
  $('#companiesFilterSearch').value = '';
  $('#companiesFilterType').value = '';
  renderCompanies();
});

function openCompanyModal(company) {
  $('#companyModalTitle').textContent = company ? 'Edit Company' : 'Add Company';
  $('#companyId').value = company ? company.id : '';
  $('#companyName').value = company ? company.name : '';
  $('#companyAddress').value = company ? (company.address || '') : '';
  $('#companyGstin').value = company ? (company.gstin || '') : '';
  $('#companyPaymentTerms').value = company ? (Number(company.paymentTermsDays) || 0) : 30;
  $('#companyIsSales').checked = company ? !!company.isSalesCompany : true;
  $('#companyIsPurchase').checked = company ? !!company.isPurchaseCompany : false;
  openModal('companyModal');
}

$('#btnAddCompany').addEventListener('click', () => openCompanyModal(null));

/* Same Enter-key/page-reload fix as #productForm above — see that comment. */
$('#companyForm').addEventListener('submit', (e) => { e.preventDefault(); $('#saveCompanyBtn').click(); });

$('#saveCompanyBtn').addEventListener('click', withErrorToast(() => {
  if (blockIfViewer()) return;
  const form = $('#companyForm');
  if (!form.reportValidity()) return;
  const company = {
    id: $('#companyId').value || undefined,
    name: $('#companyName').value.trim(),
    address: $('#companyAddress').value.trim(),
    gstin: $('#companyGstin').value.trim().toUpperCase(),
    paymentTermsDays: Number($('#companyPaymentTerms').value) || 0,
    isSalesCompany: $('#companyIsSales').checked,
    isPurchaseCompany: $('#companyIsPurchase').checked,
  };
  Store.saveCompany(company);
  closeModal('companyModal');
  renderCompanies();
  populateCompanyDropdowns();
  populatePurchasesFilterOptions();
  toast('Company saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const editId = e.target.getAttribute && e.target.getAttribute('data-edit-company');
  if (editId) openCompanyModal(Store.getCompanies().find(c => c.id === editId));
  const delId = e.target.getAttribute && e.target.getAttribute('data-delete-company');
  if (delId) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    if (confirm('Delete this company?')) { Store.deleteCompany(delId); renderCompanies(); populateCompanyDropdowns(); populatePurchasesFilterOptions(); toast('Company deleted'); }
  }
}));

/* =====================================================================
   BUSINESS PROFILE
===================================================================== */
function loadProfileForm() {
  const p = Store.getProfile();
  $('#profName').value = p.name || '';
  $('#profGstin').value = p.gstin || '';
  $('#profAddress').value = p.address || '';
  $('#profFooterText').value = p.footerText || '';
  $('#profLogoWidthPx').value = p.logoWidthPx || '';
  $('#profLogoHeightPx').value = p.logoHeightPx || '';
  $('#profBankName').value = p.bankName || '';
  $('#profBankAccountNo').value = p.bankAccountNo || '';
  $('#profBankIFSC').value = p.bankIFSC || '';
  $('#profBankBranch').value = p.bankBranch || '';
  setImagePreview('#profLogoPreview', p.logoDataUrl);
  setImagePreview('#profSealPreview', p.sealDataUrl);
  $('#appTitleHeading').textContent = p.name || 'Business Suite';
  document.title = p.name ? `${p.name} — Quotations & Invoicing` : 'Business Suite — Quotations & Invoicing';
  $('#topbarBizName').textContent = p.name ? 'Quotations & Invoicing' : 'Set up your Business Profile to get started';
  $$('#profileModal .accordion-header').forEach((header) => {
    header.classList.remove('expanded');
    header.nextElementSibling.style.display = 'none';
  });
}

$$('#profileModal .accordion-header').forEach((header) => {
  header.addEventListener('click', () => {
    const expanded = header.classList.toggle('expanded');
    header.nextElementSibling.style.display = expanded ? '' : 'none';
  });
});

function setImagePreview(sel, dataUrl) {
  const img = $(sel);
  if (dataUrl) { img.src = dataUrl; img.style.display = 'block'; } else { img.style.display = 'none'; }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let pendingLogoDataUrl = null;
let pendingSealDataUrl = null;

$('#profLogoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingLogoDataUrl = await fileToDataUrl(file);
  setImagePreview('#profLogoPreview', pendingLogoDataUrl);
});
$('#profSealFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingSealDataUrl = await fileToDataUrl(file);
  setImagePreview('#profSealPreview', pendingSealDataUrl);
});

$('#profileForm').addEventListener('submit', withErrorToast((e) => {
  e.preventDefault();
  if (blockIfViewer()) return;
  const existing = Store.getProfile();
  const profile = {
    name: $('#profName').value.trim(),
    gstin: $('#profGstin').value.trim().toUpperCase(),
    address: $('#profAddress').value.trim(),
    footerText: $('#profFooterText').value.trim(),
    logoWidthPx: Number($('#profLogoWidthPx').value) || null,
    logoHeightPx: Number($('#profLogoHeightPx').value) || null,
    bankName: $('#profBankName').value.trim(),
    bankAccountNo: $('#profBankAccountNo').value.trim(),
    bankIFSC: $('#profBankIFSC').value.trim().toUpperCase(),
    bankBranch: $('#profBankBranch').value.trim(),
    logoDataUrl: pendingLogoDataUrl || existing.logoDataUrl || '',
    sealDataUrl: pendingSealDataUrl || existing.sealDataUrl || '',
  };
  Store.saveProfile(profile);
  loadProfileForm();
  closeModal('profileModal');
  toast('Business profile saved');
}));

$('#btnOpenSettings').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#settingsDropdown').classList.toggle('open');
});

$('#settingsDropdown').addEventListener('click', (e) => {
  const action = e.target.getAttribute('data-settings-action');
  if (!action) return;
  $('#settingsDropdown').classList.remove('open');
  if (action === 'defaultConfig') {
    renderAllConfigTables();
    openModal('defaultConfigModal');
    return;
  }
  if (action === 'syncToDb' || action === 'downloadDbSnapshot') return; // handled by their own dedicated listeners below
  if (!currentUser || !currentUser.isAdmin) { toast('Admins only'); return; }
  if (action === 'profile') {
    loadProfileForm();
    openModal('profileModal');
  } else if (action === 'dataFile') {
    openDataFileModal();
  } else if (action === 'userConfig') {
    openUserConfigModal();
  } else if (action === 'dbConnection') {
    openDbConnectionModal();
  } else if (action === 'tabLayout') {
    openTabLayoutModal();
  }
});

$('#btnLogout').addEventListener('click', async () => {
  try { await SupabaseClient.signOut(); } catch (e) { /* proceed to reload regardless */ }
  location.reload();
});

/* Settings > Tab Layout (admin-only) — lets an admin choose which of the 6
   configurable primary nav tabs regular Users/Viewers can see, and reorder
   them. Edits happen on a local draft object; nothing is persisted until
   "Save Tab Layout" is clicked. See PRIMARY_NAV_DEFAULT_ORDER/applyTabLayout
   above. */
let tabLayoutDraft = null;

function renderTabLayoutRows() {
  const tbody = $('#tabLayoutBody');
  tbody.innerHTML = tabLayoutDraft.order.map((id, idx) => `
    <tr data-layout-id="${id}">
      <td>
        <button type="button" class="btn-icon" data-move="up" data-id="${id}" ${idx === 0 ? 'disabled' : ''}>&#9650;</button>
        <button type="button" class="btn-icon" data-move="down" data-id="${id}" ${idx === tabLayoutDraft.order.length - 1 ? 'disabled' : ''}>&#9660;</button>
      </td>
      <td>${PRIMARY_NAV_LABELS[id]}</td>
      <td><label><input type="checkbox" data-visible-toggle data-id="${id}" ${tabLayoutDraft.hidden.includes(id) ? '' : 'checked'}> Visible</label></td>
    </tr>`).join('');
}

function openTabLayoutModal() {
  const saved = Store.getTabLayout();
  tabLayoutDraft = { order: normalizeTabOrder(saved.order), hidden: (saved.hidden || []).slice() };
  renderTabLayoutRows();
  openModal('tabLayoutModal');
}

$('#tabLayoutBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-move]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const i = tabLayoutDraft.order.indexOf(id);
  const j = btn.getAttribute('data-move') === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= tabLayoutDraft.order.length) return;
  [tabLayoutDraft.order[i], tabLayoutDraft.order[j]] = [tabLayoutDraft.order[j], tabLayoutDraft.order[i]];
  renderTabLayoutRows();
});

$('#tabLayoutBody').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-visible-toggle]');
  if (!cb) return;
  const id = cb.getAttribute('data-id');
  tabLayoutDraft.hidden = tabLayoutDraft.hidden.filter((h) => h !== id);
  if (!cb.checked) tabLayoutDraft.hidden.push(id);
});

$('#resetTabLayoutBtn').addEventListener('click', () => {
  tabLayoutDraft = { order: PRIMARY_NAV_DEFAULT_ORDER.slice(), hidden: [] };
  renderTabLayoutRows();
});

$('#saveTabLayoutBtn').addEventListener('click', withErrorToast(() => {
  if (!currentUser || !currentUser.isAdmin) { toast('Admins only'); return; }
  Store.saveTabLayout({ order: tabLayoutDraft.order.slice(), hidden: tabLayoutDraft.hidden.slice() });
  applyTabLayout();
  closeModal('tabLayoutModal');
  toast('Tab layout saved');
}));

function openDataFileModal() {
  $('#dataFilePathText').value = Store.dataFileLabel;
  const connected = Store.isFolderConnected();
  const usingSupabase = Store.getDataBackendMode() === 'supabase';
  $('#dataFileNotConnectedHint').style.display = (!connected && !usingSupabase) ? 'block' : 'none';
  $('#dataFileSupabaseHint').style.display = usingSupabase ? 'block' : 'none';
  $('#connectFolderToSaveBtn').style.display = connected ? 'none' : 'inline-flex';
  $('#switchDataFolderBtn').style.display = connected ? 'inline-flex' : 'none';
  openModal('dataFileModal');
}
$('#dataFileIndicator').addEventListener('click', openDataFileModal);

$('#switchDataFolderBtn').addEventListener('click', async () => {
  try {
    const switched = await Store.switchDataFolder();
    if (switched) {
      closeModal('dataFileModal');
      init();
      toast('Switched data folder');
    }
  } catch (e) {
    toast('Could not switch data folder: ' + (e.message || e));
  }
});

$('#connectFolderToSaveBtn').addEventListener('click', async () => {
  try {
    const connected = await Store.connectFolderToSave();
    if (connected) {
      closeModal('dataFileModal');
      toast('Data folder connected — your changes are now saved to a real file.');
    }
  } catch (e) {
    toast('Could not connect a data folder: ' + (e.message || e));
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.settings-menu')) {
    $('#settingsDropdown').classList.remove('open');
  }
});

/* ---------------- User Configuration (admin-only) ---------------- */
/* Login credentials live only in Supabase Auth — this modal never sees or
   stores a password, only usernames/roles via the `profiles` table. */
async function renderUserConfigTable() {
  const tbody = $('#userConfigTbody');
  tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Loading…</td></tr>`;
  try {
    const profiles = await SupabaseClient.listProfiles();
    if (!profiles.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="3">No users yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = profiles.map(p => `
      <tr>
        <td>${escapeHtml(p.username)}</td>
        <td>${p.isAdmin ? '<span class="badge badge-success">Admin</span>' : p.isViewer ? '<span class="badge badge-muted">Viewer</span>' : '<span class="badge badge-muted">User</span>'}</td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-reset-user="${escapeHtml(p.username)}">Reset Password</button>
          <button class="btn btn-secondary btn-sm" data-toggle-admin-user="${escapeHtml(p.username)}" data-current-admin="${p.isAdmin}">${p.isAdmin ? 'Revoke Admin' : 'Make Admin'}</button>
          <button class="btn btn-secondary btn-sm" data-toggle-viewer-user="${escapeHtml(p.username)}" data-current-viewer="${p.isViewer}">${p.isViewer ? 'Remove Viewer' : 'Make Viewer'}</button>
          <button class="btn btn-danger btn-sm" data-delete-user="${escapeHtml(p.username)}">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Could not load users: ${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

async function openUserConfigModal() {
  $('#newUserUsername').value = '';
  $('#newUserPassword').value = '';
  $('#newUserIsAdmin').checked = false;
  $('#newUserIsViewer').checked = false;
  openModal('userConfigModal');
  await renderUserConfigTable();
}

$('#createUserBtn').addEventListener('click', async () => {
  const username = $('#newUserUsername').value.trim();
  const password = $('#newUserPassword').value;
  const isAdmin = $('#newUserIsAdmin').checked;
  const isViewer = $('#newUserIsViewer').checked;
  if (!username || !password) { toast('User ID and password are required'); return; }
  try {
    await SupabaseClient.createUser(username, password, isAdmin);
    if (isViewer && !isAdmin) await SupabaseClient.setViewerFlag(username, true);
    $('#newUserUsername').value = '';
    $('#newUserPassword').value = '';
    $('#newUserIsAdmin').checked = false;
    $('#newUserIsViewer').checked = false;
    await renderUserConfigTable();
    toast('User created');
  } catch (e) {
    toast('Could not create user: ' + (e.message || e));
  }
});

document.addEventListener('click', async (e) => {
  const resetUsername = e.target.getAttribute('data-reset-user');
  const toggleUsername = e.target.getAttribute('data-toggle-admin-user');
  const toggleViewerUsername = e.target.getAttribute('data-toggle-viewer-user');
  const deleteUsername = e.target.getAttribute('data-delete-user');
  if (resetUsername) {
    $('#resetPasswordUsername').value = resetUsername;
    $('#resetPasswordUserLabel').textContent = `Setting a new password for "${resetUsername}".`;
    $('#resetPasswordValue').value = '';
    openModal('resetPasswordModal');
  } else if (toggleUsername) {
    const currentlyAdmin = e.target.getAttribute('data-current-admin') === 'true';
    try {
      await SupabaseClient.setAdminFlag(toggleUsername, !currentlyAdmin);
      await renderUserConfigTable();
      toast('Role updated');
    } catch (err) {
      toast('Could not update role: ' + (err.message || err));
    }
  } else if (toggleViewerUsername) {
    const currentlyViewer = e.target.getAttribute('data-current-viewer') === 'true';
    try {
      await SupabaseClient.setViewerFlag(toggleViewerUsername, !currentlyViewer);
      await renderUserConfigTable();
      toast('Role updated');
    } catch (err) {
      toast('Could not update role: ' + (err.message || err));
    }
  } else if (deleteUsername) {
    let confirmed;
    try { confirmed = confirm('Delete user "' + deleteUsername + '"? This cannot be undone.'); } catch (err) { return; }
    if (!confirmed) return;
    try {
      await SupabaseClient.deleteUser(deleteUsername);
      await renderUserConfigTable();
      toast('User deleted');
    } catch (err) {
      toast('Could not delete user: ' + (err.message || err));
    }
  }
});

$('#confirmResetPasswordBtn').addEventListener('click', withErrorToast(async () => {
  const username = $('#resetPasswordUsername').value;
  const newPassword = $('#resetPasswordValue').value;
  if (!newPassword) { toast('Enter a new password'); return; }
  try {
    await SupabaseClient.resetPassword(username, newPassword);
    closeModal('resetPasswordModal');
    toast('Password reset');
  } catch (err) {
    toast('Could not reset password: ' + (err.message || err));
  }
}));

/* ---------------- DB Connection (admin-only) ---------------- */
async function openDbConnectionModal() {
  const cfg = await SecretsStore.getDbConnection();
  $('#dbConnUrl').value = cfg.supabaseUrl;
  $('#dbConnKey').value = cfg.supabaseAnonKey;
  $('#dbConnActive').checked = cfg.useSupabaseActive;
  $('#dbConnTestResult').textContent = '';
  openModal('dbConnectionModal');
}

$('#dbConnTestBtn').addEventListener('click', async () => {
  const url = $('#dbConnUrl').value.trim();
  const key = $('#dbConnKey').value.trim();
  const resultEl = $('#dbConnTestResult');
  if (!url || !key) { resultEl.textContent = 'Enter a URL and key first.'; return; }
  resultEl.textContent = 'Testing…';
  const result = await Store.testSupabaseConnection(url, key);
  resultEl.textContent = result.message;
  resultEl.style.color = result.ok ? 'var(--success)' : 'var(--danger)';
});

$('#saveDbConnectionBtn').addEventListener('click', async () => {
  const url = $('#dbConnUrl').value.trim();
  const key = $('#dbConnKey').value.trim();
  const wantsActive = $('#dbConnActive').checked;
  const cfg = await SecretsStore.getDbConnection();
  const wasActive = cfg.useSupabaseActive;

  if (!url || !key) { toast('Project URL and anon key are required'); return; }

  if (!wantsActive) {
    await SecretsStore.saveDbConnection({ supabaseUrl: url, supabaseAnonKey: key, useSupabaseActive: false });
    SupabaseClient.init(url, key);
    if (wasActive) await Store.deactivateSupabaseBackend();
    closeModal('dbConnectionModal');
    if (wasActive) { init(); toast('Switched back to the local data file'); }
    else toast('DB Connection saved');
    return;
  }

  SupabaseClient.init(url, key);

  if (wasActive) {
    await SecretsStore.saveDbConnection({ supabaseUrl: url, supabaseAnonKey: key, useSupabaseActive: true });
    closeModal('dbConnectionModal');
    toast('DB Connection saved');
    return;
  }

  let choice = null;
  try {
    if (confirm('Push your current local data to Supabase now? This overwrites whatever is currently in Supabase.\n\nClick Cancel to choose "Pull from Supabase" instead.')) {
      choice = 'push';
    } else if (confirm('Pull Supabase\'s existing data instead? This replaces what you see locally with whatever is already in Supabase.\n\nClick Cancel to abort and leave Supabase off.')) {
      choice = 'pull';
    }
  } catch (err) { /* fall through to Cancelled below */ }
  if (!choice) { toast('Cancelled'); return; }
  try {
    await Store.activateSupabaseBackend(choice);
    closeModal('dbConnectionModal');
    init();
    toast('Supabase is now the active data source');
  } catch (e) {
    toast('Could not switch to Supabase: ' + (e.message || e));
  }
});

$('#clearProfileBtn').addEventListener('click', withErrorToast(() => {
  if (blockIfViewer()) return;
  if (blockDeleteIfNotAdmin()) return;
  if (!confirm('Clear all Business Profile data, including the logo and seal? This cannot be undone.')) return;
  pendingLogoDataUrl = null;
  pendingSealDataUrl = null;
  $('#profLogoFile').value = '';
  $('#profSealFile').value = '';
  Store.saveProfile({
    name: '', address: '', gstin: '', logoDataUrl: '',
    footerText: '', logoWidthPx: null, logoHeightPx: null,
    bankName: '', bankAccountNo: '', bankIFSC: '', bankBranch: '', sealDataUrl: '',
  });
  loadProfileForm();
  toast('Business profile cleared');
}));

/* =====================================================================
   Shared: company dropdowns & product picker
===================================================================== */
/* preserveIds ({quotation, invoice, purchase}, all optional) lets an edit handler
   say "keep this company's id selectable even if it's no longer in the live
   filtered list" (e.g. a company later un-flagged as Sales/Purchase, or
   deleted) — without this, reopening such a record for edit would silently
   leave the select on its blank default, the same fallback-injection treatment
   populateUnitOptions()/populateGstRateOptions()/populateExpenseCategoryOptions()
   already give their own pick-lists. */
function populateCompanyDropdowns(preserveIds) {
  preserveIds = preserveIds || {};
  const companies = Store.getCompanies();
  function buildSelect(selectEl, filterFn, placeholder, preserveId) {
    let opts = companies.filter(filterFn);
    if (preserveId && !opts.some(c => c.id === preserveId)) {
      const existing = companies.find(c => c.id === preserveId);
      const label = existing ? `${existing.name} (not currently listed)` : '(no longer available)';
      opts = opts.concat([{ id: preserveId, name: label }]);
    }
    selectEl.innerHTML = `<option value="">${placeholder}</option>` + opts.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  }
  buildSelect($('#quotationCompany'), c => c.isSalesCompany, '-- Select Company --', preserveIds.quotation);
  buildSelect($('#invoiceCompany'), c => c.isSalesCompany, '-- Select Company --', preserveIds.invoice);
  buildSelect($('#purchaseCompany'), c => c.isPurchaseCompany, '-- Select Purchase Company --', preserveIds.purchase);
}

function populateProductPicker(selectEl) {
  const products = Store.getProducts();
  selectEl.innerHTML = `<option value="">-- Select Product --</option>` +
    products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.unit)})</option>`).join('');
}

/* =====================================================================
   Quotation / Invoice shared line-item + totals engine
===================================================================== */
const draft = { quotation: { items: [] }, invoice: { items: [] }, purchase: { items: [] } };

function companiesStoreForKind(kind) {
  const companies = Store.getCompanies();
  return kind === 'purchase' ? companies.filter(c => c.isPurchaseCompany) : companies.filter(c => c.isSalesCompany);
}

function addLineItemToDraft(kind, productId) {
  const product = Store.getProducts().find(p => p.id === productId);
  if (!product) return;
  const item = {
    productId: product.id,
    name: product.name,
    hsnCode: product.hsnCode,
    unit: product.unit,
    qty: 1,
    rate: product.rate,
    gstPercent: product.gstPercent,
    details: product.details || '',
  };
  if (kind === 'quotation') item.amount = defaultQuotationAmount(item);
  draft[kind].items.push(item);
  renderLineItems(kind);
}

function renderLineItems(kind) {
  const tbody = $('#' + kind + 'LineItemsBody');
  const items = draft[kind].items;
  const isQuotation = kind === 'quotation';
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${isQuotation ? 7 : 4}">No line items added yet.</td></tr>`;
  } else {
    tbody.innerHTML = items.map((it, idx) => {
      if (isQuotation && it.amount == null) it.amount = defaultQuotationAmount(it);
      return `
      <tr>
        <td>${escapeHtml(it.name)}</td>
        <td class="num-col"><input type="number" min="0" step="any" value="${it.qty}" data-line-field="qty" data-line-idx="${idx}" data-line-kind="${kind}"></td>
        ${isQuotation ? `<td class="num-col"><input type="number" min="0" step="any" value="${it.requiredQty || ''}" data-line-field="requiredQty" data-line-idx="${idx}" data-line-kind="${kind}"></td>` : ''}
        ${isQuotation ? `<td>${escapeHtml(it.unit)}</td>` : ''}
        <td class="num-col"><input type="number" min="0" step="0.01" value="${it.rate}" data-line-field="rate" data-line-idx="${idx}" data-line-kind="${kind}"></td>
        ${isQuotation
          ? `<td class="num-col"><input type="number" min="0" step="0.01" value="${round2(it.amount)}" data-line-field="amount" data-line-idx="${idx}" data-line-kind="${kind}"></td>`
          : ''}
        <td><button type="button" class="remove-line" data-remove-line="${idx}" data-remove-kind="${kind}">&times;</button></td>
      </tr>
      <tr class="line-details-row">
        <td colspan="${isQuotation ? 7 : 4}"><textarea placeholder="Additional details for this line (optional)" data-line-field="details" data-line-idx="${idx}" data-line-kind="${kind}">${escapeHtml(it.details || '')}</textarea></td>
      </tr>`;
    }).join('');
  }
  renderTotalsBox(kind);
}

function handleLineFieldChange(e) {
  const field = e.target.getAttribute('data-line-field');
  if (!field) return;
  const kind = e.target.getAttribute('data-line-kind');
  const idx = Number(e.target.getAttribute('data-line-idx'));
  if (field === 'details') {
    draft[kind].items[idx].details = e.target.value;
    return;
  }
  const it = draft[kind].items[idx];
  if (kind === 'quotation' && field === 'amount') {
    it.amount = Number(e.target.value) || 0;
  } else {
    it[field] = Number(e.target.value);
    if (kind === 'quotation' && (field === 'qty' || field === 'rate' || field === 'requiredQty')) {
      it.amount = defaultQuotationAmount(it);
      const amountInput = $(`[data-line-field="amount"][data-line-idx="${idx}"][data-line-kind="${kind}"]`);
      if (amountInput) amountInput.value = it.amount;
    }
  }
  renderTotalsBox(kind);
}
document.addEventListener('input', handleLineFieldChange);
document.addEventListener('change', handleLineFieldChange);

document.addEventListener('click', (e) => {
  const removeIdx = e.target.getAttribute('data-remove-line');
  if (removeIdx !== null && removeIdx !== undefined && e.target.hasAttribute('data-remove-line')) {
    const kind = e.target.getAttribute('data-remove-kind');
    draft[kind].items.splice(Number(removeIdx), 1);
    renderLineItems(kind);
  }
});

function currentInterState(kind) {
  const companySel = $('#' + kind + 'Company');
  const companyId = companySel ? companySel.value : '';
  const company = companiesStoreForKind(kind).find(c => c.id === companyId);
  const profile = Store.getProfile();
  return company ? isInterState(profile.gstin, company.gstin) : false;
}

$('#quotationCompany').addEventListener('change', () => renderTotalsBox('quotation'));
$('#invoiceCompany').addEventListener('change', () => renderTotalsBox('invoice'));
$('#purchaseCompany').addEventListener('change', () => renderTotalsBox('purchase'));

function renderTotalsBox(kind) {
  const interState = currentInterState(kind);
  const totals = computeTotals(draft[kind].items, interState);
  draft[kind].totals = totals;
  const box = $('#' + kind + 'TotalsBox');
  const rows = [];
  rows.push(`<div class="row"><span>Subtotal</span><span>${fmt(totals.subtotal)}</span></div>`);
  if (interState) {
    rows.push(`<div class="row"><span>IGST</span><span>${fmt(totals.igst)}</span></div>`);
  } else {
    rows.push(`<div class="row"><span>CGST</span><span>${fmt(totals.cgst)}</span></div>`);
    rows.push(`<div class="row"><span>SGST</span><span>${fmt(totals.sgst)}</span></div>`);
  }
  rows.push(`<div class="row grand"><span>Grand Total</span><span>${fmt(totals.total)}</span></div>`);
  if (kind === 'invoice' && $('#invoiceIsAdvancePayment').checked) {
    const advance = Number($('#invoiceAdvanceAmount').value) || 0;
    rows.push(`<div class="row"><span>Less: Advance Received</span><span>${fmt(advance)}</span></div>`);
    rows.push(`<div class="row grand"><span>Balance Due</span><span>${fmt(totals.total - advance)}</span></div>`);
  }
  box.innerHTML = rows.join('');
}

/* =====================================================================
   QUOTATIONS
===================================================================== */
function renderQuotations() {
  const tbody = $('#quotationsTbody');
  let quotations = Store.getQuotations().map(q => Object.assign({}, q, { _companyName: companyName(q.companyId) }));
  quotations = sortState.quotations ? sortRows(quotations, 'quotations') : quotations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!quotations.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No quotations yet.</td></tr>`;
    updateSortIndicators('quotations');
    return;
  }
  tbody.innerHTML = quotations.map(q => `
    <tr>
      <td>${escapeHtml(q.quotationNo)}</td>
      <td>${fmtDateShort(q.date)}</td>
      <td>${escapeHtml(q._companyName)}</td>
      <td class="actions-cell">
        <button class="btn btn-secondary btn-sm" data-edit-quotation="${q.id}">Edit</button>
        <button class="btn btn-secondary btn-sm" data-pdf-quotation="${q.id}">Download PDF</button>
        <button class="btn btn-danger btn-sm" data-delete-quotation="${q.id}">Delete</button>
      </td>
    </tr>
  `).join('');
  updateSortIndicators('quotations');
}

function resetQuotationModal() {
  draft.quotation = { items: [], terms: Store.getTermsTemplates().map(t => t.text) };
  $('#quotationId').value = '';
  $('#quotationDate').value = todayISO();
  populateCompanyDropdowns();
  $('#quotationCompany').value = '';
  $('#quotationShowSubtotal').checked = false;
  $('#quotationShowTax').checked = false;
  $('#quotationShowGrandTotal').checked = false;
  $('#quotationShowAmount').checked = false;
  populateProductPicker($('#quotationProductPicker'));
  renderLineItems('quotation');
  renderQuotationTerms();
  showQuotationStep('form');
}

function renderQuotationTerms() {
  const tbody = $('#quotationTermsBody');
  const terms = draft.quotation.terms || [];
  if (!terms.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">No terms added.</td></tr>`;
    return;
  }
  tbody.innerHTML = terms.map((t, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><textarea data-term-field data-term-idx="${idx}">${escapeHtml(t)}</textarea></td>
      <td><button type="button" class="remove-line" data-remove-term="${idx}">&times;</button></td>
    </tr>
  `).join('');
}

document.addEventListener('input', (e) => {
  if (!e.target.hasAttribute('data-term-field')) return;
  const idx = Number(e.target.getAttribute('data-term-idx'));
  draft.quotation.terms[idx] = e.target.value;
});

document.addEventListener('click', (e) => {
  if (!e.target.hasAttribute('data-remove-term')) return;
  const idx = Number(e.target.getAttribute('data-remove-term'));
  draft.quotation.terms.splice(idx, 1);
  renderQuotationTerms();
});

$('#quotationAddTermBtn').addEventListener('click', () => {
  draft.quotation.terms = draft.quotation.terms || [];
  draft.quotation.terms.push('');
  renderQuotationTerms();
  const textareas = $$('#quotationTermsBody textarea');
  if (textareas.length) textareas[textareas.length - 1].focus();
});

function getQuotationDisplayOptions() {
  return {
    showSubtotal: $('#quotationShowSubtotal').checked,
    showTax: $('#quotationShowTax').checked,
    showGrandTotal: $('#quotationShowGrandTotal').checked,
    showAmount: $('#quotationShowAmount').checked,
  };
}

function getQuotationTerms() {
  // Terms are now edited directly in the form (see #quotationTermsBody) and live in
  // draft.quotation.terms: seeded once from the current config templates for a brand-new
  // quotation (resetQuotationModal) or from the quotation's own stored terms when editing
  // (data-edit-quotation handler) — either way, edits made here only affect this quotation,
  // never the config templates themselves.
  return draft.quotation.terms || [];
}

function getQuotationNoForDraft() {
  const existingId = $('#quotationId').value;
  if (existingId) {
    return Store.getQuotations().find(q => q.id === existingId).quotationNo;
  }
  return getNextQuotationNo();
}

function showQuotationStep(step) {
  const isForm = step === 'form';
  $('#quotationStepForm').style.display = isForm ? '' : 'none';
  $('#quotationStepPreview').style.display = isForm ? 'none' : '';
  $('#quotationStepLabel1').classList.toggle('active', isForm);
  $('#quotationStepLabel2').classList.toggle('active', !isForm);
  $('#quotationNextBtn').style.display = isForm ? '' : 'none';
  $('#quotationEditBtn').style.display = isForm ? 'none' : '';
  $('#quotationDownloadBtn').style.display = isForm ? 'none' : '';
  $('#quotationConfirmBtn').style.display = isForm ? 'none' : '';
}

$('#btnAddQuotation').addEventListener('click', () => {
  if (!Store.getCompanies().some(c => c.isSalesCompany) || !Store.getProducts().length) {
    toast('Add at least one product and company first');
    return;
  }
  resetQuotationModal();
  openModal('quotationModal');
});

$('#quotationAddLineBtn').addEventListener('click', () => {
  const productId = $('#quotationProductPicker').value;
  if (!productId) { toast('Select a product first'); return; }
  addLineItemToDraft('quotation', productId);
});

function buildDocDataFromDraft(kind, extra) {
  const companyId = $('#' + kind + 'Company').value;
  const company = companiesStoreForKind(kind).find(c => c.id === companyId);
  const totals = draft[kind].totals || computeTotals(draft[kind].items, currentInterState(kind));
  const snapshotFields = {};
  if (kind !== 'purchase') {
    // Purchases have no PDF, so there's nothing to reprint later — no snapshot needed.
    // Frozen here (recomputed fresh on every save, including a re-save from Edit) so a
    // later edit to the company or business profile doesn't retroactively change what a
    // reprint of this saved document shows — see resolveBillToCompany/resolveDocProfile.
    // Text fields only (no logo/seal) to avoid duplicating large images into every record.
    const profile = Store.getProfile();
    snapshotFields.billToSnapshot = company ? { name: company.name, address: company.address || '', gstin: company.gstin || '' } : null;
    snapshotFields.profileSnapshot = {
      name: profile.name || '', address: profile.address || '', gstin: profile.gstin || '',
      bankName: profile.bankName || '', bankAccountNo: profile.bankAccountNo || '',
      bankIFSC: profile.bankIFSC || '', bankBranch: profile.bankBranch || '',
    };
  }
  const docData = Object.assign({
    id: $('#' + kind + 'Id').value || undefined,
    companyId,
    date: $('#' + kind + 'Date').value,
    items: draft[kind].items,
    subtotal: totals.subtotal,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    total: totals.total,
  }, snapshotFields, extra || {});
  return [docData, company];
}

function renderDocPreview(container, docData, company, docTitle, isInvoice) {
  const profile = Store.getProfile();
  const interState = isInterState(profile.gstin, company ? company.gstin : '');
  const opts = Object.assign({ showSubtotal: true, showTax: true, showGrandTotal: true, showAmount: false }, docData.displayOptions || {});
  const showRequired = !isInvoice && docData.items.some(it => Number(it.requiredQty) > 0);

  const rowsHtml = docData.items.map((it, idx) => {
    const taxable = it.qty * it.rate;
    const tax = taxable * it.gstPercent / 100;
    const detailsHtml = it.details ? `<div class="line-details">${escapeHtml(it.details)}</div>` : '';
    if (isInvoice) {
      return `<tr>
        <td>${idx + 1}</td><td class="product-col">${escapeHtml(it.name)}${detailsHtml}</td><td>${escapeHtml(it.hsnCode)}</td>
        <td>${it.qty}</td><td>${fmt(it.rate)}</td><td>${escapeHtml(it.unit)}</td>
        <td>${it.gstPercent}%</td><td>${fmt(tax)}</td><td>${fmt(taxable + tax)}</td>
      </tr>`;
    }
    const quotationAmount = it.amount != null ? Number(it.amount) : defaultQuotationAmount(it);
    return `<tr>
      <td>${idx + 1}</td><td class="product-col">${escapeHtml(it.name)}${detailsHtml}</td>
      <td>${it.qty} ${escapeHtml(it.unit)}</td>
      ${showRequired ? `<td>${Number(it.requiredQty) > 0 ? it.requiredQty : '-'}</td>` : ''}
      <td>${fmt(it.rate)} per ${escapeHtml(it.unit || 'unit')}</td>
      ${opts.showAmount ? `<td>${fmt(quotationAmount)}</td>` : ''}
    </tr>`;
  }).join('');

  const theadHtml = isInvoice
    ? `<tr><th>#</th><th class="product-col">Product</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Per</th><th>GST%</th><th>Tax</th><th>Amount</th></tr>`
    : `<tr><th>#</th><th class="product-col">Product</th><th>Qty</th>${showRequired ? '<th>Required</th>' : ''}<th>Rate</th>${opts.showAmount ? '<th>Amount</th>' : ''}</tr>`;

  const taxRowsHtml = !opts.showTax ? '' : (interState
    ? `<div class="row"><span>IGST</span><span>${fmt(docData.igst)}</span></div>`
    : `<div class="row"><span>CGST</span><span>${fmt(docData.cgst)}</span></div><div class="row"><span>SGST</span><span>${fmt(docData.sgst)}</span></div>`);

  let bankHtml = '';
  if (isInvoice) {
    const includeSeal = docData.includeSeal !== false;
    const includeSignatory = docData.includeSignatory !== false;
    const sealBoxHtml = includeSeal ? `<div class="seal-box">${profile.sealDataUrl ? `<img src="${profile.sealDataUrl}">` : 'Company Seal'}</div>` : '';
    const signatoryHtml = includeSignatory ? `
      <div class="seal-wrap">
        <div class="seal-caption">For ${escapeHtml(profile.name || 'Business Name')}</div>
        ${sealBoxHtml}
        <div class="seal-caption">Authorized Signatory</div>
      </div>` : sealBoxHtml;
    bankHtml = `
      <div class="doc-footer-block">
        <div>
          <h4 style="margin:0 0 6px;font-size:12px;color:#667085;text-transform:uppercase;">Bank Details</h4>
          <div>${escapeHtml(profile.bankName || 'Not set')}</div>
          <div>A/c No: ${escapeHtml(profile.bankAccountNo || '-')}</div>
          <div>IFSC: ${escapeHtml(profile.bankIFSC || '-')}</div>
          <div>Branch: ${escapeHtml(profile.bankBranch || '-')}</div>
        </div>
        ${signatoryHtml}
      </div>`;
  }

  const headRightHtml = isInvoice ? `
    <div class="doc-title">${docTitle}</div>
    <div>Invoice No: ${escapeHtml(docData.invoiceNo || '(will be assigned)')}</div>
    <div>Invoice Date: ${fmtDateShort(docData.date)}</div>
    <div>Challan No: ${escapeHtml(docData.challanNo || (docData.showChallanDash ? '-' : ''))}</div>
    <div>Challan Date: ${docData.challanDate ? fmtDateShort(docData.challanDate) : (docData.showChallanDash ? '-' : '')}</div>
  ` : `
    <div class="doc-title">${docTitle}</div>
    <div>Quote No: ${escapeHtml(docData.quotationNo || '(will be assigned)')}</div>
    <div>Quote Date: ${fmtDateShort(docData.date)}</div>
  `;

  container.innerHTML = `
    <div class="doc-head">
      <div class="doc-head-left">
        ${profile.logoDataUrl ? `<img class="doc-logo" src="${profile.logoDataUrl}">` : ''}
        <div>
          <div class="biz-title">${escapeHtml(profile.name || 'Your Business Name')}</div>
          <div>${escapeHtml(profile.address || '')}</div>
          ${profile.gstin ? `<div>GSTIN: ${escapeHtml(profile.gstin)}</div>` : ''}
        </div>
      </div>
      <div class="doc-head-right">${headRightHtml}</div>
    </div>
    <div class="bill-to">
      <h4>${isInvoice ? 'Bill To' : 'To'}</h4>
      <div>${escapeHtml(company ? company.name : '')}</div>
      <div>${escapeHtml(company ? company.address || '' : '')}</div>
      ${company && company.gstin ? `<div>GSTIN: ${escapeHtml(company.gstin)}</div>` : ''}
    </div>
    ${isInvoice ? `
    <div class="po-block">
      <div>PO No: ${escapeHtml(docData.poNumber || '')}</div>
      <div>PO Date: ${docData.poDate ? fmtDateShort(docData.poDate) : ''}</div>
    </div>` : ''}
    <table>
      <thead>${theadHtml}</thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="totals-box">
      ${opts.showSubtotal ? `<div class="row"><span>Subtotal</span><span>${fmt(docData.subtotal)}</span></div>` : ''}
      ${taxRowsHtml}
      ${opts.showGrandTotal ? `<div class="row grand"><span>Grand Total</span><span>${fmt(docData.total)}</span></div>` : ''}
      ${isInvoice && docData.isAdvancePayment ? `
        <div class="row"><span>Less: Advance Received</span><span>${fmt(docData.advanceAmount)}</span></div>
        <div class="row grand"><span>Balance Due</span><span>${fmt(docData.total - (Number(docData.advanceAmount) || 0))}</span></div>` : ''}
    </div>
    ${!isInvoice && docData.terms && docData.terms.length ? `
      <div class="doc-terms">
        <div class="doc-terms-title">Terms &amp; Conditions</div>
        <ol>${docData.terms.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ol>
      </div>` : ''}
    ${isInvoice ? `<div class="amount-words">Amount in Words: ${amountInWords(docData.total)}</div>` : ''}
    ${bankHtml}
    <div class="doc-address-footer">${escapeHtml(profile.name || '')} — ${escapeHtml(profile.address || '')}</div>
  `;
}

$('#quotationNextBtn').addEventListener('click', () => {
  if (!$('#quotationCompany').value) { toast('Select a company'); return; }
  if (!$('#quotationDate').value) { toast('Date is required'); return; }
  if (!draft.quotation.items.length) { toast('Add at least one line item'); return; }
  const [docData, company] = buildDocDataFromDraft('quotation', {
    quotationNo: getQuotationNoForDraft(),
    displayOptions: getQuotationDisplayOptions(),
    terms: getQuotationTerms(),
  });
  renderDocPreview($('#quotationPreviewContent'), docData, company, 'QUOTATION', false);
  showQuotationStep('preview');
});

$('#quotationEditBtn').addEventListener('click', () => showQuotationStep('form'));

function getQuotationDraftDoc() {
  return buildDocDataFromDraft('quotation', {
    quotationNo: getQuotationNoForDraft(),
    displayOptions: getQuotationDisplayOptions(),
    terms: getQuotationTerms(),
  });
}

$('#quotationDownloadBtn').addEventListener('click', () => {
  const [docData, company] = getQuotationDraftDoc();
  const doc = buildQuotationPdf(docData, company, Store.getProfile());
  doc.save(`${docData.quotationNo.replace(/\//g, '-')}.pdf`);
});

$('#quotationConfirmBtn').addEventListener('click', withErrorToast(async () => {
  if (blockIfViewer()) return;
  const isNew = !$('#quotationId').value;
  if (!ensureEditingRecordExists('quotation', $('#quotationId').value, Store.getQuotations())) return;
  const [docData] = getQuotationDraftDoc();
  if (isNew) {
    docData.quotationNo = await guardAgainstNumberCollision(
      [STORAGE_KEYS.quotations], docData.quotationNo,
      () => Store.getQuotations().map(q => q.quotationNo),
      getNextQuotationNo, 'Quotation No'
    );
  }
  Store.saveQuotation(docData);
  closeModal('quotationModal');
  renderQuotations();
  toast('Quotation saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const editId = e.target.getAttribute && e.target.getAttribute('data-edit-quotation');
  if (editId) {
    const q = Store.getQuotations().find(x => x.id === editId);
    draft.quotation = { items: JSON.parse(JSON.stringify(q.items)), terms: JSON.parse(JSON.stringify(q.terms || [])) };
    $('#quotationId').value = q.id;
    $('#quotationDate').value = q.date;
    populateProductPicker($('#quotationProductPicker'));
    populateCompanyDropdowns({ quotation: q.companyId });
    $('#quotationCompany').value = q.companyId;
    const opts = Object.assign({ showSubtotal: true, showTax: true, showGrandTotal: true, showAmount: false }, q.displayOptions || {});
    $('#quotationShowSubtotal').checked = opts.showSubtotal;
    $('#quotationShowTax').checked = opts.showTax;
    $('#quotationShowGrandTotal').checked = opts.showGrandTotal;
    $('#quotationShowAmount').checked = opts.showAmount;
    renderLineItems('quotation');
    renderQuotationTerms();
    showQuotationStep('form');
    openModal('quotationModal');
  }
  const pdfId = e.target.getAttribute && e.target.getAttribute('data-pdf-quotation');
  if (pdfId) {
    const q = Store.getQuotations().find(x => x.id === pdfId);
    const doc = buildQuotationPdf(q, resolveBillToCompany(q), resolveDocProfile(q));
    doc.save(`${q.quotationNo.replace(/\//g, '-')}.pdf`);
  }
  const delId = e.target.getAttribute && e.target.getAttribute('data-delete-quotation');
  if (delId) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    if (confirm('Delete this quotation?')) { Store.deleteQuotation(delId); renderQuotations(); toast('Quotation deleted'); }
  }
}));

/* =====================================================================
   INVOICES
===================================================================== */
function paymentStatusBadge(inv) {
  if (!inv.payment || !inv.payment.received) return `<span class="badge badge-muted">Unpaid</span>`;
  if (inv.payment.shortfallType === 'tds' && inv.payment.shortfallAmount > 0.009) {
    return `<span class="badge badge-success">TDS Deducted</span>`;
  }
  if (inv.payment.shortfallAmount > 0.009) {
    return `<span class="badge badge-warning">Partially Paid</span>`;
  }
  return `<span class="badge badge-success">Paid</span>`;
}

function renderInvoices() {
  const tbody = $('#invoicesTbody');
  let invoices = Store.getInvoices().map(inv => Object.assign({}, inv, {
    _companyName: companyName(inv.companyId),
    _gst: (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0),
    _status: paymentStatusText(inv),
  }));
  invoices = sortState.invoices ? sortRows(invoices, 'invoices') : invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!invoices.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No invoices yet.</td></tr>`;
    updateSortIndicators('invoices');
    return;
  }
  tbody.innerHTML = invoices.map(inv => `
    <tr>
      <td>${escapeHtml(inv.invoiceNo)}${inv.isProforma ? ' <span class="badge badge-muted">Proforma</span>' : ''}</td>
      <td>${escapeHtml(inv.challanNo || '-')}</td>
      <td>${fmtDateShort(inv.date)}</td>
      <td>${escapeHtml(inv._companyName)}</td>
      <td>${fmt(inv.subtotal)}</td>
      <td>${fmt(inv._gst)}</td>
      <td>${fmt(inv.total)}</td>
      <td>${paymentStatusBadge(inv)}</td>
      <td class="actions-cell">
        <button class="btn btn-secondary btn-sm" data-edit-invoice="${inv.id}">Edit</button>
        <button class="btn btn-secondary btn-sm" data-pdf-invoice="${inv.id}">Download PDF</button>
        <button class="btn btn-danger btn-sm" data-delete-invoice="${inv.id}">Delete</button>
      </td>
    </tr>
  `).join('');
  updateSortIndicators('invoices');
}

function resetInvoiceModal() {
  draft.invoice = { items: [] };
  $('#invoiceId').value = '';
  $('#invoiceDate').value = todayISO();
  populateCompanyDropdowns();
  $('#invoiceCompany').value = '';
  $('#invoiceNo').value = getNextInvoiceNo();
  $('#invoiceChallanNo').value = getNextChallanNo();
  $('#invoiceChallanDate').value = todayISO();
  $('#invoiceChallanNo').disabled = false;
  $('#invoiceChallanDate').disabled = false;
  $('#invoicePoNumber').value = '';
  $('#invoicePoDate').value = '';
  $('#invoiceIncludeSeal').checked = true;
  $('#invoiceIncludeSignatory').checked = true;
  $('#invoiceShowChallanDash').checked = false;
  $('#invoiceIsProforma').checked = false;
  $('#invoiceIsAdvancePayment').checked = false;
  $('#invoiceIsAdvancePayment').disabled = false;
  $('#invoiceAdvanceAmount').value = '';
  $('#invoiceAdvanceAmountRow').style.display = 'none';
  $('#invoiceNoLabel').textContent = 'Invoice No';
  populateProductPicker($('#invoiceProductPicker'));
  renderLineItems('invoice');
  showInvoiceStep('form');
}

$('#invoiceIsProforma').addEventListener('change', () => {
  const isProforma = $('#invoiceIsProforma').checked;
  $('#invoiceNoLabel').textContent = isProforma ? 'Proforma Invoice No' : 'Invoice No';
  if (!$('#invoiceId').value) { // only auto-renumber a brand-new invoice, never an edit
    $('#invoiceNo').value = isProforma ? getNextProformaInvoiceNo() : getNextInvoiceNo();
  }
  $('#invoiceIsAdvancePayment').disabled = isProforma;
  if (isProforma && $('#invoiceIsAdvancePayment').checked) {
    $('#invoiceIsAdvancePayment').checked = false;
    $('#invoiceAdvanceAmount').value = '';
    $('#invoiceAdvanceAmountRow').style.display = 'none';
    renderTotalsBox('invoice');
  }
});

$('#invoiceIsAdvancePayment').addEventListener('change', () => {
  $('#invoiceAdvanceAmountRow').style.display = $('#invoiceIsAdvancePayment').checked ? '' : 'none';
  if (!$('#invoiceIsAdvancePayment').checked) $('#invoiceAdvanceAmount').value = '';
  renderTotalsBox('invoice');
});

$('#invoiceAdvanceAmount').addEventListener('input', () => renderTotalsBox('invoice'));

$('#invoiceShowChallanDash').addEventListener('change', () => {
  const checked = $('#invoiceShowChallanDash').checked;
  $('#invoiceChallanNo').disabled = checked;
  $('#invoiceChallanDate').disabled = checked;
  if (checked) {
    $('#invoiceChallanNo').value = '';
    $('#invoiceChallanDate').value = '';
  } else {
    $('#invoiceChallanNo').value = getNextChallanNo();
    $('#invoiceChallanDate').value = todayISO();
  }
});

function showInvoiceStep(step) {
  const isForm = step === 'form';
  $('#invoiceStepForm').style.display = isForm ? '' : 'none';
  $('#invoiceStepPreview').style.display = isForm ? 'none' : '';
  $('#invoiceStepLabel1').classList.toggle('active', isForm);
  $('#invoiceStepLabel2').classList.toggle('active', !isForm);
  $('#invoiceNextBtn').style.display = isForm ? '' : 'none';
  $('#invoiceEditBtn').style.display = isForm ? 'none' : '';
  $('#invoiceDownloadBtn').style.display = isForm ? 'none' : '';
  $('#invoiceConfirmBtn').style.display = isForm ? 'none' : '';
}

$('#btnAddInvoice').addEventListener('click', () => {
  if (!Store.getCompanies().some(c => c.isSalesCompany) || !Store.getProducts().length) {
    toast('Add at least one product and company first');
    return;
  }
  resetInvoiceModal();
  openModal('invoiceModal');
});

$('#invoiceAddLineBtn').addEventListener('click', () => {
  const productId = $('#invoiceProductPicker').value;
  if (!productId) { toast('Select a product first'); return; }
  addLineItemToDraft('invoice', productId);
});

function getInvoiceDraftDoc() {
  return buildDocDataFromDraft('invoice', {
    invoiceNo: $('#invoiceNo').value.trim(),
    challanNo: $('#invoiceChallanNo').value.trim(),
    challanDate: $('#invoiceChallanDate').value,
    poNumber: $('#invoicePoNumber').value.trim(),
    poDate: $('#invoicePoDate').value,
    includeSeal: $('#invoiceIncludeSeal').checked,
    includeSignatory: $('#invoiceIncludeSignatory').checked,
    showChallanDash: $('#invoiceShowChallanDash').checked,
    isProforma: $('#invoiceIsProforma').checked,
    isAdvancePayment: $('#invoiceIsAdvancePayment').checked,
    advanceAmount: $('#invoiceIsAdvancePayment').checked ? (Number($('#invoiceAdvanceAmount').value) || 0) : null,
  });
}

$('#invoiceNextBtn').addEventListener('click', () => {
  if (!$('#invoiceCompany').value) { toast('Select a company'); return; }
  if (!$('#invoiceDate').value) { toast('Invoice Date is required'); return; }
  if (!draft.invoice.items.length) { toast('Add at least one line item'); return; }
  if (!$('#invoiceNo').value.trim()) { toast('Invoice No is required'); return; }
  if ($('#invoiceIsAdvancePayment').checked && !(Number($('#invoiceAdvanceAmount').value) > 0)) {
    toast('Advance Amount is required');
    return;
  }
  const [docData, company] = getInvoiceDraftDoc();
  docData.amountInWords = amountInWords(docData.total);
  renderDocPreview($('#invoicePreviewContent'), docData, company, docData.isProforma ? 'PROFORMA INVOICE' : 'TAX INVOICE', true);
  showInvoiceStep('preview');
});

$('#invoiceEditBtn').addEventListener('click', () => showInvoiceStep('form'));

$('#invoiceDownloadBtn').addEventListener('click', () => {
  const [docData, company] = getInvoiceDraftDoc();
  docData.amountInWords = amountInWords(docData.total);
  const doc = buildInvoicePdf(docData, company, Store.getProfile());
  doc.save(`${docData.invoiceNo.replace(/\//g, '-')}.pdf`);
});

$('#invoiceConfirmBtn').addEventListener('click', withErrorToast(async () => {
  if (blockIfViewer()) return;
  const isNew = !$('#invoiceId').value;
  if (!ensureEditingRecordExists('invoice', $('#invoiceId').value, Store.getInvoices())) return;
  const [docData] = getInvoiceDraftDoc();
  docData.amountInWords = amountInWords(docData.total);
  if (isNew) {
    if (docData.isAdvancePayment && docData.advanceAmount > 0) {
      const shortfall = docData.total - docData.advanceAmount;
      docData.payment = {
        received: true,
        amountReceived: docData.advanceAmount,
        paymentDate: docData.date,
        shortfallType: shortfall > 0.009 ? 'pending' : null,
        shortfallAmount: shortfall > 0.009 ? shortfall : 0,
      };
    } else {
      docData.payment = { received: false, amountReceived: null, paymentDate: null, shortfallType: null, shortfallAmount: 0 };
    }
    docData.invoiceNo = await guardAgainstNumberCollision(
      [STORAGE_KEYS.invoices], docData.invoiceNo,
      () => Store.getInvoices().map(i => i.invoiceNo),
      docData.isProforma ? getNextProformaInvoiceNo : getNextInvoiceNo, 'Invoice No'
    );
    if (docData.challanNo) {
      docData.challanNo = await guardAgainstNumberCollision(
        [STORAGE_KEYS.invoices], docData.challanNo,
        () => Store.getInvoices().map(i => i.challanNo).filter(Boolean),
        getNextChallanNo, 'Challan No'
      );
    }
  } else {
    const existing = Store.getInvoices().find(i => i.id === docData.id);
    docData.payment = existing.payment;
  }
  Store.saveInvoice(docData);
  closeModal('invoiceModal');
  renderInvoices();
  renderPayments();
  toast('Invoice saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const editId = e.target.getAttribute && e.target.getAttribute('data-edit-invoice');
  if (editId) {
    const inv = Store.getInvoices().find(x => x.id === editId);
    draft.invoice = { items: JSON.parse(JSON.stringify(inv.items)) };
    $('#invoiceId').value = inv.id;
    $('#invoiceDate').value = inv.date;
    $('#invoiceNo').value = inv.invoiceNo;
    $('#invoiceChallanNo').value = inv.challanNo || '';
    $('#invoiceChallanDate').value = inv.challanDate || '';
    $('#invoicePoNumber').value = inv.poNumber || '';
    $('#invoicePoDate').value = inv.poDate || '';
    $('#invoiceIncludeSeal').checked = inv.includeSeal !== false;
    $('#invoiceIncludeSignatory').checked = inv.includeSignatory !== false;
    $('#invoiceShowChallanDash').checked = !!inv.showChallanDash;
    $('#invoiceChallanNo').disabled = !!inv.showChallanDash;
    $('#invoiceChallanDate').disabled = !!inv.showChallanDash;
    $('#invoiceIsProforma').checked = !!inv.isProforma;
    $('#invoiceNoLabel').textContent = inv.isProforma ? 'Proforma Invoice No' : 'Invoice No';
    $('#invoiceIsAdvancePayment').checked = !!inv.isAdvancePayment;
    $('#invoiceIsAdvancePayment').disabled = !!inv.isProforma;
    $('#invoiceAdvanceAmount').value = inv.advanceAmount != null ? inv.advanceAmount : '';
    $('#invoiceAdvanceAmountRow').style.display = inv.isAdvancePayment ? '' : 'none';
    populateProductPicker($('#invoiceProductPicker'));
    populateCompanyDropdowns({ invoice: inv.companyId });
    $('#invoiceCompany').value = inv.companyId;
    renderLineItems('invoice');
    showInvoiceStep('form');
    openModal('invoiceModal');
  }
  const pdfId = e.target.getAttribute && e.target.getAttribute('data-pdf-invoice');
  if (pdfId) {
    const inv = Store.getInvoices().find(x => x.id === pdfId);
    const doc = buildInvoicePdf(inv, resolveBillToCompany(inv), resolveDocProfile(inv));
    doc.save(`${inv.invoiceNo.replace(/\//g, '-')}.pdf`);
  }
  const delId = e.target.getAttribute && e.target.getAttribute('data-delete-invoice');
  if (delId) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    if (confirm('Delete this invoice?')) { Store.deleteInvoice(delId); renderInvoices(); renderPayments(); toast('Invoice deleted'); }
  }
}));

/* =====================================================================
   PURCHASES
===================================================================== */
function purchasePaymentBadge(p) {
  return p.paymentDone ? '<span class="badge badge-success">Paid</span>' : '<span class="badge badge-muted">Unpaid</span>';
}

function applyPurchasesFilter(purchases) {
  const f = filterState.purchases;
  return purchases.filter(p => {
    if (f.search) {
      const hay = `${p.purchaseNo} ${p._companyName} ${p.paymentNote || ''}`.toLowerCase();
      if (!hay.includes(f.search.toLowerCase())) return false;
    }
    if (f.company && p.companyId !== f.company) return false;
    if (f.status === 'paid' && !p.paymentDone) return false;
    if (f.status === 'unpaid' && p.paymentDone) return false;
    return true;
  });
}

function populatePurchasesFilterOptions() {
  const sel = $('#purchasesFilterCompany');
  const current = sel.value;
  const companies = Store.getCompanies().filter(c => c.isPurchaseCompany).slice().sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = `<option value="">All Companies</option>` + companies.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value = current;
}

function renderPurchases() {
  const tbody = $('#purchasesTbody');
  const all = Store.getPurchases();
  let purchases = all.map(p => Object.assign({}, p, {
    _companyName: companyName(p.companyId),
    _gst: (Number(p.cgst) || 0) + (Number(p.sgst) || 0) + (Number(p.igst) || 0),
    _status: p.paymentDone ? 'Paid' : 'Unpaid',
  }));
  purchases = applyPurchasesFilter(purchases);
  purchases = sortState.purchases ? sortRows(purchases, 'purchases') : purchases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!all.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No purchases yet.</td></tr>`;
  } else if (!purchases.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No purchases match your filters.</td></tr>`;
  } else {
    tbody.innerHTML = purchases.map(p => `
      <tr>
        <td>${escapeHtml(p.purchaseNo)}</td>
        <td>${fmtDateShort(p.date)}</td>
        <td>${escapeHtml(p._companyName)}</td>
        <td>${fmt(p.subtotal)}</td>
        <td>${fmt(p._gst)}</td>
        <td>${fmt(p.total)}</td>
        <td>${purchasePaymentBadge(p)}</td>
        <td class="truncate-cell" title="${escapeHtml(p.paymentNote || '')}">${escapeHtml(p.paymentNote || '-')}</td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-edit-purchase="${p.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-purchase="${p.id}">Delete</button>
        </td>
      </tr>
    `).join('');
  }
  updateSortIndicators('purchases');
}

$('#purchasesFilterSearch').addEventListener('input', (e) => { filterState.purchases.search = e.target.value; renderPurchases(); });
$('#purchasesFilterCompany').addEventListener('change', (e) => { filterState.purchases.company = e.target.value; renderPurchases(); });
$('#purchasesFilterStatus').addEventListener('change', (e) => { filterState.purchases.status = e.target.value; renderPurchases(); });
$('#purchasesFilterClear').addEventListener('click', () => {
  filterState.purchases = { search: '', company: '', status: '' };
  $('#purchasesFilterSearch').value = '';
  $('#purchasesFilterCompany').value = '';
  $('#purchasesFilterStatus').value = '';
  renderPurchases();
});

let expandedPurchaseCompanies = new Set();

function purchaseRow(p) {
  return `
    <tr>
      <td>${escapeHtml(p.purchaseNo)}</td>
      <td>${fmtDateShort(p.date)}</td>
      <td>${fmt(p.subtotal)}</td>
      <td>${fmt((Number(p.cgst) || 0) + (Number(p.sgst) || 0) + (Number(p.igst) || 0))}</td>
      <td>${fmt(p.total)}</td>
      <td>${purchasePaymentBadge(p)}</td>
    </tr>`;
}

function renderPurchasesByCompany() {
  const container = $('#purchasesByCompany');
  const purchases = Store.getPurchases();
  if (!purchases.length) {
    container.innerHTML = `<div class="card" style="padding:30px; text-align:center; color:var(--text-muted);">No purchases yet.</div>`;
    return;
  }
  const companies = Store.getCompanies().filter(c => c.isPurchaseCompany);
  const groups = companies.map(c => {
    let list = purchases.filter(p => p.companyId === c.id).map(p => Object.assign({}, p, {
      _gst: (Number(p.cgst) || 0) + (Number(p.sgst) || 0) + (Number(p.igst) || 0),
      _status: p.paymentDone ? 'Paid' : 'Unpaid',
    }));
    list = sortState.purchasesByCompany ? sortRows(list, 'purchasesByCompany') : list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { company: c, purchases: list };
  }).filter(g => g.purchases.length > 0);

  container.innerHTML = groups.map(g => {
    const total = g.purchases.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
    const expanded = expandedPurchaseCompanies.has(g.company.id);
    const meta = `${g.purchases.length} purchase${g.purchases.length === 1 ? '' : 's'} · Total ${fmt(total)}`;
    return `
    <div class="card accordion-item">
      <div class="accordion-header ${expanded ? 'expanded' : ''}" data-toggle-purchase-company="${g.company.id}">
        <span class="accordion-caret">&#9656;</span>
        <span class="accordion-title">${escapeHtml(g.company.name)}</span>
        <span class="accordion-meta">${meta}</span>
      </div>
      <div class="accordion-body" style="display:${expanded ? '' : 'none'};">
        <table>
          <thead>
            <tr>
              <th class="sortable" data-sort-table="purchasesByCompany" data-sort-key="purchaseNo" data-sort-type="text">Purchase No</th>
              <th class="sortable" data-sort-table="purchasesByCompany" data-sort-key="date" data-sort-type="date">Date</th>
              <th class="sortable" data-sort-table="purchasesByCompany" data-sort-key="subtotal" data-sort-type="number">Total</th>
              <th class="sortable" data-sort-table="purchasesByCompany" data-sort-key="_gst" data-sort-type="number">GST</th>
              <th class="sortable" data-sort-table="purchasesByCompany" data-sort-key="total" data-sort-type="number">Purchase Total</th>
              <th class="sortable" data-sort-table="purchasesByCompany" data-sort-key="_status" data-sort-type="text">Payment Status</th>
            </tr>
          </thead>
          <tbody>${g.purchases.map(purchaseRow).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
  updateSortIndicators('purchasesByCompany');
}

document.addEventListener('click', (e) => {
  const toggleHeader = e.target.closest && e.target.closest('[data-toggle-purchase-company]');
  if (toggleHeader) {
    const cid = toggleHeader.getAttribute('data-toggle-purchase-company');
    if (expandedPurchaseCompanies.has(cid)) expandedPurchaseCompanies.delete(cid); else expandedPurchaseCompanies.add(cid);
    renderPurchasesByCompany();
  }
});

function resetPurchaseModal() {
  draft.purchase = { items: [] };
  $('#purchaseModalTitle').textContent = 'Add Purchase';
  $('#purchaseId').value = '';
  $('#purchaseDate').value = todayISO();
  populateCompanyDropdowns();
  $('#purchaseCompany').value = '';
  $('#purchaseNo').value = getNextPurchaseNo();
  $('#purchasePaymentDone').checked = false;
  $('#purchasePaymentNote').value = '';
  populateProductPicker($('#purchaseProductPicker'));
  renderLineItems('purchase');
}

$('#btnAddPurchase').addEventListener('click', () => {
  if (!Store.getCompanies().some(c => c.isPurchaseCompany) || !Store.getProducts().length) {
    toast('Add at least one product and purchase company first');
    return;
  }
  resetPurchaseModal();
  openModal('purchaseModal');
});

$('#purchaseAddLineBtn').addEventListener('click', () => {
  const productId = $('#purchaseProductPicker').value;
  if (!productId) { toast('Select a product first'); return; }
  addLineItemToDraft('purchase', productId);
});

$('#savePurchaseBtn').addEventListener('click', withErrorToast(async () => {
  if (blockIfViewer()) return;
  if (!$('#purchaseCompany').value) { toast('Select a purchase company'); return; }
  if (!$('#purchaseDate').value) { toast('Date is required'); return; }
  if (!draft.purchase.items.length) { toast('Add at least one line item'); return; }
  if (!$('#purchaseNo').value.trim()) { toast('Purchase No is required'); return; }
  const isNew = !$('#purchaseId').value;
  if (!ensureEditingRecordExists('purchase', $('#purchaseId').value, Store.getPurchases())) return;
  const [docData] = buildDocDataFromDraft('purchase', {
    purchaseNo: $('#purchaseNo').value.trim(),
    paymentDone: $('#purchasePaymentDone').checked,
    paymentNote: $('#purchasePaymentNote').value.trim(),
  });
  if (isNew) {
    docData.purchaseNo = await guardAgainstNumberCollision(
      [STORAGE_KEYS.purchases], docData.purchaseNo,
      () => Store.getPurchases().map(p => p.purchaseNo),
      getNextPurchaseNo, 'Purchase No'
    );
  }
  Store.savePurchase(docData);
  closeModal('purchaseModal');
  renderPurchases();
  renderPurchasesByCompany();
  toast('Purchase saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const editId = e.target.getAttribute && e.target.getAttribute('data-edit-purchase');
  if (editId) {
    const p = Store.getPurchases().find(x => x.id === editId);
    draft.purchase = { items: JSON.parse(JSON.stringify(p.items)) };
    $('#purchaseModalTitle').textContent = 'Edit Purchase';
    $('#purchaseId').value = p.id;
    $('#purchaseDate').value = p.date;
    $('#purchaseNo').value = p.purchaseNo;
    $('#purchasePaymentDone').checked = !!p.paymentDone;
    $('#purchasePaymentNote').value = p.paymentNote || '';
    populateProductPicker($('#purchaseProductPicker'));
    populateCompanyDropdowns({ purchase: p.companyId });
    $('#purchaseCompany').value = p.companyId;
    renderLineItems('purchase');
    openModal('purchaseModal');
  }
  const delId = e.target.getAttribute && e.target.getAttribute('data-delete-purchase');
  if (delId) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    if (confirm('Delete this purchase?')) { Store.deletePurchase(delId); renderPurchases(); renderPurchasesByCompany(); toast('Purchase deleted'); }
  }
}));

/* =====================================================================
   CASH / MANUAL EXPENSES
===================================================================== */
function applyExpensesFilter(expenses) {
  const f = filterState.expenses;
  return expenses.filter(e => {
    if (f.search) {
      const hay = `${e.category} ${e.description || ''}`.toLowerCase();
      if (!hay.includes(f.search.toLowerCase())) return false;
    }
    if (f.category && e.category !== f.category) return false;
    return true;
  });
}

function populateExpensesFilterOptions() {
  const sel = $('#expensesFilterCategory');
  const current = sel.value;
  const categories = Store.getExpenseCategories().map(c => c.name);
  sel.innerHTML = `<option value="">All Categories</option>` + categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = current;
}

function renderExpenses() {
  const tbody = $('#expensesTbody');
  const all = Store.getExpenses();
  let expenses = applyExpensesFilter(all);
  expenses = sortState.expenses ? sortRows(expenses, 'expenses') : expenses.sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!all.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No expenses recorded yet.</td></tr>`;
  } else if (!expenses.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No expenses match your filters.</td></tr>`;
  } else {
    tbody.innerHTML = expenses.map(e => `
      <tr>
        <td>${fmtDateShort(e.date)}</td>
        <td>${escapeHtml(e.category)}</td>
        <td>${escapeHtml(e.description || '')}</td>
        <td>${fmt(e.amount)}</td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-edit-expense="${e.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-expense="${e.id}">Delete</button>
        </td>
      </tr>
    `).join('');
  }
  updateSortIndicators('expenses');
}

$('#expensesFilterSearch').addEventListener('input', (e) => { filterState.expenses.search = e.target.value; renderExpenses(); });
$('#expensesFilterCategory').addEventListener('change', (e) => { filterState.expenses.category = e.target.value; renderExpenses(); });
$('#expensesFilterClear').addEventListener('click', () => {
  filterState.expenses = { search: '', category: '' };
  $('#expensesFilterSearch').value = '';
  $('#expensesFilterCategory').value = '';
  renderExpenses();
});

function openExpenseModal(expense) {
  $('#expenseModalTitle').textContent = expense ? 'Edit Expense' : 'Add Expense';
  $('#expenseId').value = expense ? expense.id : '';
  $('#expenseDate').value = expense ? expense.date : todayISO();
  populateExpenseCategoryOptions(expense ? expense.category : undefined);
  $('#expenseDescription').value = expense ? (expense.description || '') : '';
  $('#expenseAmount').value = expense ? expense.amount : '';
  openModal('expenseModal');
}

$('#btnAddExpense').addEventListener('click', () => openExpenseModal(null));

/* Same Enter-key/page-reload fix as #productForm above — see that comment. */
$('#expenseForm').addEventListener('submit', (e) => { e.preventDefault(); $('#saveExpenseBtn').click(); });

$('#saveExpenseBtn').addEventListener('click', withErrorToast(() => {
  if (blockIfViewer()) return;
  const form = $('#expenseForm');
  if (!form.reportValidity()) return;
  const expense = {
    id: $('#expenseId').value || undefined,
    date: $('#expenseDate').value,
    category: $('#expenseCategory').value.trim(),
    description: $('#expenseDescription').value.trim(),
    amount: Number($('#expenseAmount').value),
  };
  Store.saveExpense(expense);
  closeModal('expenseModal');
  renderExpenses();
  toast('Expense saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const editId = e.target.getAttribute && e.target.getAttribute('data-edit-expense');
  if (editId) openExpenseModal(Store.getExpenses().find(x => x.id === editId));
  const delId = e.target.getAttribute && e.target.getAttribute('data-delete-expense');
  if (delId) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    if (confirm('Delete this expense?')) { Store.deleteExpense(delId); renderExpenses(); toast('Expense deleted'); }
  }
}));

/* =====================================================================
   DEFAULT CONFIGURATIONS (Units, GST Rates, Expense Categories, Terms & Conditions)
   These are pick-lists only — every consumer (Products, line items, Expenses, Quotations)
   copies the selected value by plain value at the moment it's chosen/saved, so editing or
   deleting a config row here never retroactively changes any previously-saved record.
===================================================================== */
const CONFIG_TYPES = {
  unit: {
    getAll: () => Store.getUnits(), save: (r) => Store.saveUnit(r), del: (id) => Store.deleteUnit(id),
    field: 'name', fieldKind: 'text', label: 'Unit Name', tbody: '#unitsConfigTbody',
  },
  gstRate: {
    getAll: () => Store.getGstRates(), save: (r) => Store.saveGstRate(r), del: (id) => Store.deleteGstRate(id),
    field: 'value', fieldKind: 'number', label: 'GST Rate (%)', tbody: '#gstRatesConfigTbody',
  },
  expenseCategory: {
    getAll: () => Store.getExpenseCategories(), save: (r) => Store.saveExpenseCategory(r), del: (id) => Store.deleteExpenseCategory(id),
    field: 'name', fieldKind: 'text', label: 'Category Name', tbody: '#expenseCategoriesConfigTbody',
  },
  term: {
    getAll: () => Store.getTermsTemplates(), save: (r) => Store.saveTermsTemplate(r), del: (id) => Store.deleteTermsTemplate(id),
    field: 'text', fieldKind: 'textarea', label: 'Clause Text', tbody: '#termsConfigTbody',
  },
};

function renderConfigTable(type) {
  const cfg = CONFIG_TYPES[type];
  const tbody = $(cfg.tbody);
  const rows = cfg.getAll();
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="2">No entries yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(String(r[cfg.field]))}${cfg.field === 'value' ? '%' : ''}</td>
      <td class="actions-cell">
        <button class="btn btn-secondary btn-sm" data-edit-config-type="${type}" data-edit-config-id="${r.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-delete-config-type="${type}" data-delete-config-id="${r.id}">Delete</button>
      </td>
    </tr>`).join('');
}
function renderUnitsConfig() { renderConfigTable('unit'); }
function renderGstRatesConfig() { renderConfigTable('gstRate'); }
function renderExpenseCategoriesConfig() { renderConfigTable('expenseCategory'); }
function renderTermsConfig() { renderConfigTable('term'); }
function renderAllConfigTables() { renderUnitsConfig(); renderGstRatesConfig(); renderExpenseCategoriesConfig(); renderTermsConfig(); }

function openConfigModal(type, id) {
  const cfg = CONFIG_TYPES[type];
  const item = id ? cfg.getAll().find(r => r.id === id) : null;
  $('#configItemModalTitle').textContent = (item ? 'Edit ' : 'Add ') + cfg.label;
  $('#configItemType').value = type;
  $('#configItemId').value = item ? item.id : '';
  $('#configItemTextFieldWrap').style.display = cfg.fieldKind === 'text' ? '' : 'none';
  $('#configItemNumberFieldWrap').style.display = cfg.fieldKind === 'number' ? '' : 'none';
  $('#configItemTextareaFieldWrap').style.display = cfg.fieldKind === 'textarea' ? '' : 'none';
  if (cfg.fieldKind === 'text') {
    $('#configItemFieldLabel').textContent = cfg.label;
    $('#configItemTextValue').value = item ? item[cfg.field] : '';
  }
  if (cfg.fieldKind === 'number') {
    $('#configItemNumberValue').value = item ? item[cfg.field] : '';
  }
  if (cfg.fieldKind === 'textarea') {
    $('#configItemTextareaValue').value = item ? item[cfg.field] : '';
  }
  openModal('configItemModal');
}

function refreshConfigConsumers(type) {
  if (type === 'unit') { populateUnitOptions(); populateProductsFilterOptions(); }
  if (type === 'gstRate') { populateGstRateOptions($('#productGst')); populateProductsFilterOptions(); }
  if (type === 'expenseCategory') { populateExpenseCategoryOptions(); populateExpensesFilterOptions(); }
}

$('#saveConfigItemBtn').addEventListener('click', withErrorToast(() => {
  if (blockIfViewer()) return;
  const type = $('#configItemType').value;
  const cfg = CONFIG_TYPES[type];
  const value = cfg.fieldKind === 'text' ? $('#configItemTextValue').value.trim()
    : cfg.fieldKind === 'number' ? Number($('#configItemNumberValue').value)
    : $('#configItemTextareaValue').value.trim();
  if (cfg.fieldKind !== 'number' && !value) { toast('Value is required'); return; }
  if (cfg.fieldKind === 'number' && !($('#configItemNumberValue').value)) { toast('Value is required'); return; }
  const editingId = $('#configItemId').value;
  if (type === 'gstRate' && Store.getGstRates().some(r => r.id !== editingId && r.value === value)) {
    toast(`A GST Rate of ${value}% already exists`);
    return;
  }
  const record = { id: editingId || undefined, [cfg.field]: value };
  cfg.save(record);
  closeModal('configItemModal');
  renderConfigTable(type);
  refreshConfigConsumers(type);
  toast('Saved');
}));

document.addEventListener('click', withErrorToast((e) => {
  const addType = e.target.getAttribute && e.target.getAttribute('data-add-config');
  if (addType) openConfigModal(addType, null);
  const editType = e.target.getAttribute && e.target.getAttribute('data-edit-config-type');
  if (editType) openConfigModal(editType, e.target.getAttribute('data-edit-config-id'));
  const delType = e.target.getAttribute && e.target.getAttribute('data-delete-config-type');
  if (delType) {
    if (blockIfViewer()) return;
    if (blockDeleteIfNotAdmin()) return;
    const delId = e.target.getAttribute('data-delete-config-id');
    if (confirm('Delete this entry? Existing records that used it will keep their own saved value.')) {
      CONFIG_TYPES[delType].del(delId);
      renderConfigTable(delType);
      refreshConfigConsumers(delType);
      toast('Deleted');
    }
  }
}));

function populateUnitOptions(selectedValue) {
  const el = $('#productUnit');
  let names = Store.getUnits().map(u => u.name);
  if (selectedValue && !names.includes(selectedValue)) names = names.concat([selectedValue]);
  el.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (selectedValue) el.value = selectedValue;
}

function populateGstRateOptions(selectEl, selectedValue) {
  let values = Store.getGstRates().map(r => r.value);
  if (selectedValue !== undefined && selectedValue !== null && selectedValue !== '' && !values.includes(Number(selectedValue))) {
    values = values.concat([Number(selectedValue)]);
  }
  values.sort((a, b) => a - b);
  selectEl.innerHTML = values.map(v => `<option value="${v}">${v}%</option>`).join('');
  if (selectedValue !== undefined && selectedValue !== null && selectedValue !== '') selectEl.value = String(Number(selectedValue));
}

function populateExpenseCategoryOptions(selectedValue) {
  const el = $('#expenseCategory');
  let names = Store.getExpenseCategories().map(c => c.name);
  if (selectedValue && !names.includes(selectedValue)) names = names.concat([selectedValue]);
  el.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (selectedValue) el.value = selectedValue;
}

/* =====================================================================
   PAYMENTS (grouped by company, collapsible — default collapsed)
===================================================================== */
let expandedPaymentCompanies = new Set();

function paymentInvoiceRow(inv) {
  const pay = inv.payment || {};
  return `
    <tr>
      <td>${escapeHtml(inv.invoiceNo)}</td>
      <td>${fmt(inv.subtotal)}</td>
      <td>${fmt((Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0))}</td>
      <td>${fmt(inv.total)}</td>
      <td>${pay.received ? fmt(pay.amountReceived) : '-'}</td>
      <td>${pay.received && pay.shortfallType === 'pending' && pay.shortfallAmount > 0.009 ? fmt(pay.shortfallAmount) : '-'}</td>
      <td>${pay.received && pay.shortfallType === 'tds' && pay.shortfallAmount > 0.009 ? fmt(pay.shortfallAmount) : '-'}</td>
      <td>${pay.received ? fmtDateShort(pay.paymentDate) : '-'}</td>
      <td>${expectedPaymentDate(inv)}</td>
      <td>${paymentStatusBadge(inv)}</td>
      <td class="actions-cell">
        <button class="btn btn-success btn-sm" data-record-payment="${inv.id}">${pay.received ? 'Edit Payment' : 'Record Payment'}</button>
      </td>
    </tr>`;
}

function renderPayments() {
  const container = $('#paymentsByCompany');
  const invoices = realInvoices();
  if (!invoices.length) {
    container.innerHTML = `<div class="card" style="padding:30px; text-align:center; color:var(--text-muted);">No invoices yet.</div>`;
    return;
  }
  const companies = Store.getCompanies();
  const groups = companies.map(c => {
    let list = invoices.filter(i => i.companyId === c.id).map(inv => {
      const pay = inv.payment || {};
      return Object.assign({}, inv, {
        _gst: (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0),
        _amountReceived: pay.received ? (Number(pay.amountReceived) || 0) : 0,
        _pending: pay.received && pay.shortfallType === 'pending' ? (Number(pay.shortfallAmount) || 0) : 0,
        _tds: pay.received && pay.shortfallType === 'tds' ? (Number(pay.shortfallAmount) || 0) : 0,
        _paymentDate: pay.received ? pay.paymentDate : '',
        _status: paymentStatusText(inv),
      });
    });
    list = sortState.payments ? sortRows(list, 'payments') : list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { company: c, invoices: list };
  }).filter(g => g.invoices.length > 0);

  container.innerHTML = groups.map(g => {
    const outstanding = g.invoices.reduce((sum, inv) => sum + Math.max(invoiceBalance(inv), 0), 0);
    const expanded = expandedPaymentCompanies.has(g.company.id);
    const meta = `${g.invoices.length} invoice${g.invoices.length === 1 ? '' : 's'} · Outstanding ${fmt(outstanding)}`;
    return `
    <div class="card accordion-item">
      <div class="accordion-header ${expanded ? 'expanded' : ''}" data-toggle-company="${g.company.id}">
        <span class="accordion-caret">&#9656;</span>
        <span class="accordion-title">${escapeHtml(g.company.name)}</span>
        <span class="accordion-meta">${meta}</span>
      </div>
      <div class="accordion-body" style="display:${expanded ? '' : 'none'};">
        <table>
          <thead>
            <tr>
              <th class="sortable" data-sort-table="payments" data-sort-key="invoiceNo" data-sort-type="text">Invoice No</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="subtotal" data-sort-type="number">Total</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="_gst" data-sort-type="number">GST</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="total" data-sort-type="number">Invoice Total</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="_amountReceived" data-sort-type="number">Amount Received</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="_pending" data-sort-type="number">Pending</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="_tds" data-sort-type="number">TDS</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="_paymentDate" data-sort-type="date">Payment Date</th>
              <th>Expected Payment</th>
              <th class="sortable" data-sort-table="payments" data-sort-key="_status" data-sort-type="text">Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${g.invoices.map(paymentInvoiceRow).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
  updateSortIndicators('payments');
}

document.addEventListener('click', (e) => {
  const invId = e.target.getAttribute && e.target.getAttribute('data-record-payment');
  if (invId) openPaymentModal(invId);
  const toggleHeader = e.target.closest && e.target.closest('[data-toggle-company]');
  if (toggleHeader) {
    const cid = toggleHeader.getAttribute('data-toggle-company');
    if (expandedPaymentCompanies.has(cid)) expandedPaymentCompanies.delete(cid); else expandedPaymentCompanies.add(cid);
    renderPayments();
  }
});

function openPaymentModal(invoiceId) {
  const inv = Store.getInvoices().find(i => i.id === invoiceId);
  $('#paymentInvoiceId').value = inv.id;
  $('#paymentInvoiceTotal').value = fmt(inv.total);
  const pay = inv.payment || {};
  $('#paymentAmountReceived').value = pay.received ? pay.amountReceived : inv.total;
  $('#paymentDate').value = pay.received && pay.paymentDate ? pay.paymentDate : todayISO();
  $('#paymentShortfallType').value = pay.shortfallType || 'pending';
  updateShortfallVisibility(inv.total);
  openModal('paymentModal');
}

function updateShortfallVisibility(invoiceTotal) {
  const received = Number($('#paymentAmountReceived').value) || 0;
  const shortfall = Number(invoiceTotal) - received;
  const wrap = $('#paymentShortfallWrap');
  const hint = $('#paymentShortfallHint');
  if (shortfall > 0.009) {
    wrap.style.display = '';
    hint.textContent = `Amount received is less than invoice total by ${fmt(shortfall)}. Please classify the shortfall.`;
  } else if (shortfall < -0.009) {
    wrap.style.display = 'none';
    hint.textContent = `Amount received exceeds invoice total by ${fmt(-shortfall)}.`;
  } else {
    wrap.style.display = 'none';
    hint.textContent = '';
  }
}

$('#paymentAmountReceived').addEventListener('input', () => {
  const total = Number(String($('#paymentInvoiceTotal').value).replace(/,/g, ''));
  updateShortfallVisibility(total);
});

$('#savePaymentBtn').addEventListener('click', withErrorToast(() => {
  if (blockIfViewer()) return;
  const invoiceId = $('#paymentInvoiceId').value;
  const inv = Store.getInvoices().find(i => i.id === invoiceId);
  const amountReceived = Number($('#paymentAmountReceived').value);
  const paymentDate = $('#paymentDate').value;
  if (!paymentDate || isNaN(amountReceived)) { toast('Amount received and payment date are required'); return; }
  const shortfall = inv.total - amountReceived;
  const payment = {
    received: true,
    amountReceived,
    paymentDate,
    shortfallType: shortfall > 0.009 ? $('#paymentShortfallType').value : null,
    shortfallAmount: shortfall > 0.009 ? shortfall : 0,
  };
  inv.payment = payment;
  Store.saveInvoice(inv);
  closeModal('paymentModal');
  renderInvoices();
  renderPayments();
  toast('Payment recorded');
}));

/* =====================================================================
   SUMMARY (outstanding by company + sales over time)
===================================================================== */
function computeCompanyOutstanding() {
  const companies = Store.getCompanies();
  const invoices = realInvoices();
  return companies.map(c => {
    const invs = invoices.filter(i => i.companyId === c.id);
    let owed = 0, gstOwed = 0, subtotalOwed = 0, unpaidCount = 0, oldestUnpaidDate = null;
    invs.forEach(inv => {
      const bal = invoiceBalance(inv);
      if (bal > 0.009) {
        owed += bal;
        gstOwed += (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0);
        subtotalOwed += Number(inv.subtotal) || 0;
        unpaidCount++;
        if (!oldestUnpaidDate || new Date(inv.date) < new Date(oldestUnpaidDate)) oldestUnpaidDate = inv.date;
      }
    });
    const expectedDate = oldestUnpaidDate ? addDays(oldestUnpaidDate, c.paymentTermsDays) : null;
    return { company: c, invoiceCount: invs.length, unpaidCount, owed, gstOwed, subtotalOwed, expectedDate };
  }).filter(r => r.invoiceCount > 0);
}

function renderSummaryOutstanding() {
  const tbody = $('#summaryOutstandingTbody');
  let rows = computeCompanyOutstanding().map(r => Object.assign({}, r, { _companyName: r.company.name }));
  rows = sortState.summaryOutstanding ? sortRows(rows, 'summaryOutstanding') : rows;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No invoices yet.</td></tr>`;
    updateSortIndicators('summaryOutstanding');
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.company.name)}</td>
      <td>${r.unpaidCount}</td>
      <td>${r.subtotalOwed > 0.009 ? fmt(r.subtotalOwed) : '-'}</td>
      <td>${r.gstOwed > 0.009 ? fmt(r.gstOwed) : '-'}</td>
      <td>${r.owed > 0.009 ? fmt(r.owed) : '-'}</td>
      <td>${r.expectedDate ? fmtDateShort(r.expectedDate) : '-'}</td>
    </tr>
  `).join('');
  updateSortIndicators('summaryOutstanding');
}

let summaryPeriodMode = 'annual';

function computeSalesByPeriod(mode) {
  const invoices = realInvoices();
  const map = new Map();
  invoices.forEach(inv => {
    const key = mode === 'annual' ? currentFinancialYear(parseLocalDate(inv.date)) : inv.date.slice(0, 7);
    if (!map.has(key)) map.set(key, { sales: 0, received: 0, tds: 0 });
    const row = map.get(key);
    row.sales += Number(inv.total) || 0;
    row.received += inv.payment && inv.payment.received ? Number(inv.payment.amountReceived) || 0 : 0;
    row.tds += inv.payment && inv.payment.received && inv.payment.shortfallType === 'tds' ? Number(inv.payment.shortfallAmount) || 0 : 0;
  });
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({
      key,
      period: mode === 'annual' ? `FY ${key}` : formatMonthLabel(key),
      sales: v.sales,
      received: v.received,
      tds: v.tds,
      pending: v.sales - v.received - v.tds,
    }));
}

function formatMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function renderSummarySales() {
  const tbody = $('#summarySalesTbody');
  let rows = computeSalesByPeriod(summaryPeriodMode);
  rows = sortState.summarySales ? sortRows(rows, 'summarySales') : rows;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No invoices yet.</td></tr>`;
    updateSortIndicators('summarySales');
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.period)}</td>
      <td>${fmt(r.sales)}</td>
      <td>${fmt(r.received)}</td>
      <td>${fmt(r.tds)}</td>
      <td>${fmt(r.pending)}</td>
    </tr>
  `).join('');
  updateSortIndicators('summarySales');
}

$('#summaryAnnualBtn').addEventListener('click', () => {
  summaryPeriodMode = 'annual';
  $('#summaryAnnualBtn').classList.add('active');
  $('#summaryMonthlyBtn').classList.remove('active');
  renderSummarySales();
});
$('#summaryMonthlyBtn').addEventListener('click', () => {
  summaryPeriodMode = 'monthly';
  $('#summaryMonthlyBtn').classList.add('active');
  $('#summaryAnnualBtn').classList.remove('active');
  renderSummarySales();
});

function renderSummary() {
  renderSummaryOutstanding();
  renderSummarySales();
}

/* =====================================================================
   PROFIT & LOSS
===================================================================== */
function computeProfitLossByPeriod(mode) {
  const map = new Map();
  function ensure(key) {
    if (!map.has(key)) map.set(key, { sales: 0, purchases: 0, expenses: 0, tds: 0 });
    return map.get(key);
  }
  const keyFor = (dateStr) => mode === 'annual' ? currentFinancialYear(parseLocalDate(dateStr)) : dateStr.slice(0, 7);
  realInvoices().forEach(inv => {
    const row = ensure(keyFor(inv.date));
    row.sales += Number(inv.subtotal) || 0;
    row.tds += inv.payment && inv.payment.received && inv.payment.shortfallType === 'tds' ? Number(inv.payment.shortfallAmount) || 0 : 0;
  });
  Store.getPurchases().forEach(p => { ensure(keyFor(p.date)).purchases += Number(p.subtotal) || 0; });
  Store.getExpenses().forEach(e => { ensure(keyFor(e.date)).expenses += Number(e.amount) || 0; });
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({
      key,
      period: mode === 'annual' ? `FY ${key}` : formatMonthLabel(key),
      ...v,
      profit: v.sales - v.purchases - v.expenses,
    }));
}

let pnlPeriodMode = 'annual';

function renderProfitLoss() {
  const rows = computeProfitLossByPeriod(pnlPeriodMode);
  const totals = rows.reduce((acc, r) => ({
    sales: acc.sales + r.sales,
    purchases: acc.purchases + r.purchases,
    expenses: acc.expenses + r.expenses,
    profit: acc.profit + r.profit,
    tds: acc.tds + r.tds,
  }), { sales: 0, purchases: 0, expenses: 0, profit: 0, tds: 0 });

  $('#pnlStatCards').innerHTML = `
    <div class="stat-card"><div class="label">Total Sales</div><div class="value">${fmt(totals.sales)}</div></div>
    <div class="stat-card"><div class="label">Total Purchases</div><div class="value">${fmt(totals.purchases)}</div></div>
    <div class="stat-card"><div class="label">Total Expenses</div><div class="value">${fmt(totals.expenses)}</div></div>
    <div class="stat-card"><div class="label">Total TDS Deducted</div><div class="value">${fmt(totals.tds)}</div></div>
    <div class="stat-card ${totals.profit < 0 ? 'negative' : 'positive'}"><div class="label">Net Profit / Loss</div><div class="value">${fmt(totals.profit)}</div></div>
  `;

  const tbody = $('#pnlTbody');
  const sortedRows = sortState.pnl ? sortRows(rows, 'pnl') : rows;
  if (!sortedRows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No sales, purchases, or expenses recorded yet.</td></tr>`;
    updateSortIndicators('pnl');
    return;
  }
  tbody.innerHTML = sortedRows.map(r => `
    <tr>
      <td>${escapeHtml(r.period)}</td>
      <td>${fmt(r.sales)}</td>
      <td>${fmt(r.tds)}</td>
      <td>${fmt(r.purchases)}</td>
      <td>${fmt(r.expenses)}</td>
      <td>${fmt(r.profit)}</td>
    </tr>
  `).join('');
  updateSortIndicators('pnl');
}

$('#pnlAnnualBtn').addEventListener('click', () => {
  pnlPeriodMode = 'annual';
  $('#pnlAnnualBtn').classList.add('active');
  $('#pnlMonthlyBtn').classList.remove('active');
  renderProfitLoss();
});
$('#pnlMonthlyBtn').addEventListener('click', () => {
  pnlPeriodMode = 'monthly';
  $('#pnlMonthlyBtn').classList.add('active');
  $('#pnlAnnualBtn').classList.remove('active');
  renderProfitLoss();
});

/* =====================================================================
   GST PAYMENT (monthly output vs. input GST owed to the government)
===================================================================== */
function computeGSTByPeriod(mode) {
  const map = new Map();
  function ensure(key) {
    if (!map.has(key)) map.set(key, { output: 0, input: 0 });
    return map.get(key);
  }
  const keyFor = (dateStr) => mode === 'annual' ? currentFinancialYear(parseLocalDate(dateStr)) : dateStr.slice(0, 7);
  realInvoices().forEach(inv => {
    const row = ensure(keyFor(inv.date));
    row.output += (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0);
  });
  Store.getPurchases().forEach(p => {
    const row = ensure(keyFor(p.date));
    row.input += (Number(p.cgst) || 0) + (Number(p.sgst) || 0) + (Number(p.igst) || 0);
  });
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({
      key,
      period: mode === 'annual' ? `FY ${key}` : formatMonthLabel(key),
      output: v.output,
      input: v.input,
      net: v.output - v.input,
      dueDate: mode === 'monthly' ? gstDueDate(key) : null,
    }));
}

function gstDueDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 20).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

let gstPeriodMode = 'annual';

function renderGstPayment() {
  const rows = computeGSTByPeriod(gstPeriodMode);
  const totals = rows.reduce((acc, r) => ({
    output: acc.output + r.output,
    input: acc.input + r.input,
    net: acc.net + r.net,
  }), { output: 0, input: 0, net: 0 });

  $('#gstStatCards').innerHTML = `
    <div class="stat-card"><div class="label">Total Output GST (Collected)</div><div class="value">${fmt(totals.output)}</div></div>
    <div class="stat-card"><div class="label">Total Input GST (ITC)</div><div class="value">${fmt(totals.input)}</div></div>
    <div class="stat-card"><div class="label">Net GST Payable</div><div class="value">${fmt(totals.net)}</div></div>
  `;

  const tbody = $('#gstTbody');
  const sortedRows = sortState.gst ? sortRows(rows, 'gst') : rows;
  if (!sortedRows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No invoices or purchases recorded yet.</td></tr>`;
    updateSortIndicators('gst');
    return;
  }
  tbody.innerHTML = sortedRows.map(r => `
    <tr>
      <td>${escapeHtml(r.period)}</td>
      <td>${fmt(r.output)}</td>
      <td>${fmt(r.input)}</td>
      <td>${fmt(r.net)}</td>
      <td>${r.dueDate ? escapeHtml(r.dueDate) : '-'}</td>
    </tr>
  `).join('');
  updateSortIndicators('gst');
}

$('#gstAnnualBtn').addEventListener('click', () => {
  gstPeriodMode = 'annual';
  $('#gstAnnualBtn').classList.add('active');
  $('#gstMonthlyBtn').classList.remove('active');
  renderGstPayment();
});
$('#gstMonthlyBtn').addEventListener('click', () => {
  gstPeriodMode = 'monthly';
  $('#gstMonthlyBtn').classList.add('active');
  $('#gstAnnualBtn').classList.remove('active');
  renderGstPayment();
});

/* =====================================================================
   CHARTS (Charts tab: Company Sales / Product Sales / Pending Payments /
   Purchases by Company / Cash-Manual Expenses)
===================================================================== */
const CHART_COLORS = ['#2f6fed', '#1a9c5f', '#d9432f', '#b8860b', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0d9488'];
function colorForIndex(i) { return CHART_COLORS[i % CHART_COLORS.length]; }

/** Sums every invoice's total by company — all-time, no period filter, so any invoice (past, present, or backdated) always counts. */
function computeCompanySalesTotals() {
  const totals = new Map(); // companyId -> total
  realInvoices().forEach(inv => {
    totals.set(inv.companyId, (totals.get(inv.companyId) || 0) + (Number(inv.total) || 0));
  });
  return Array.from(totals.entries())
    .map(([companyId, total]) => ({ name: companyName(companyId) || 'Unknown Company', value: Math.round(total * 100) / 100 }))
    .filter(s => s.value > 0.009)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sums every invoice line item's total (qty*rate*(1+gst%), matching pdf.js's buildItemRows) by product name — all-time, no period filter. */
function computeProductSalesTotals() {
  const totals = new Map(); // product name -> total
  realInvoices().forEach(inv => {
    (inv.items || []).forEach(item => {
      const taxable = (Number(item.qty) || 0) * (Number(item.rate) || 0);
      const lineTotal = taxable * (1 + (Number(item.gstPercent) || 0) / 100);
      totals.set(item.name, (totals.get(item.name) || 0) + lineTotal);
    });
  });
  return Array.from(totals.entries())
    .map(([name, total]) => ({ name, value: Math.round(total * 100) / 100 }))
    .filter(s => s.value > 0.009)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Indian FY quarter: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar (aligns with currentFinancialYear's Apr-start FY). */
function financialQuarterOf(date) {
  const month = date.getMonth(); // 0 = Jan
  if (month >= 3 && month <= 5) return 1;
  if (month >= 6 && month <= 8) return 2;
  if (month >= 9 && month <= 11) return 3;
  return 4;
}

function salesTrendPeriodKey(mode, dateStr) {
  const d = parseLocalDate(dateStr);
  if (mode === 'annual') {
    const fy = currentFinancialYear(d);
    return { key: fy, label: `FY ${fy}` };
  }
  if (mode === 'quarterly') {
    const fy = currentFinancialYear(d);
    const q = financialQuarterOf(d);
    return { key: `${fy}-Q${q}`, label: `Q${q} FY ${fy}` };
  }
  const ym = dateStr.slice(0, 7);
  return { key: ym, label: formatMonthLabel(ym) };
}

/** Groups invoice totals by company and by period (mode: 'monthly' | 'quarterly' | 'annual') for the Trend bar view. */
function computeCompanySalesByPeriod(mode) {
  const periodLabels = new Map();
  const companyTotals = new Map(); // companyId -> Map(periodKey -> total)

  realInvoices().forEach(inv => {
    const { key, label } = salesTrendPeriodKey(mode, inv.date);
    if (!periodLabels.has(key)) periodLabels.set(key, label);
    if (!companyTotals.has(inv.companyId)) companyTotals.set(inv.companyId, new Map());
    const perPeriod = companyTotals.get(inv.companyId);
    perPeriod.set(key, (perPeriod.get(key) || 0) + (Number(inv.total) || 0));
  });

  const sortedKeys = Array.from(periodLabels.keys()).sort();
  const labels = sortedKeys.map(k => periodLabels.get(k));
  const datasets = Array.from(companyTotals.entries())
    .map(([companyId, perPeriod]) => ({
      name: companyName(companyId) || 'Unknown Company',
      data: sortedKeys.map(k => Math.round((perPeriod.get(k) || 0) * 100) / 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { labels, datasets };
}

/** Groups each invoice line item's total by product name and period (mode: 'monthly' | 'quarterly' | 'annual') for the Trend bar view. */
function computeProductSalesByPeriod(mode) {
  const periodLabels = new Map();
  const productTotals = new Map(); // product name -> Map(periodKey -> total)

  realInvoices().forEach(inv => {
    const { key, label } = salesTrendPeriodKey(mode, inv.date);
    if (!periodLabels.has(key)) periodLabels.set(key, label);
    (inv.items || []).forEach(item => {
      const taxable = (Number(item.qty) || 0) * (Number(item.rate) || 0);
      const lineTotal = taxable * (1 + (Number(item.gstPercent) || 0) / 100);
      if (!productTotals.has(item.name)) productTotals.set(item.name, new Map());
      const perPeriod = productTotals.get(item.name);
      perPeriod.set(key, (perPeriod.get(key) || 0) + lineTotal);
    });
  });

  const sortedKeys = Array.from(periodLabels.keys()).sort();
  const labels = sortedKeys.map(k => periodLabels.get(k));
  const datasets = Array.from(productTotals.entries())
    .map(([name, perPeriod]) => ({
      name,
      data: sortedKeys.map(k => Math.round((perPeriod.get(k) || 0) * 100) / 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { labels, datasets };
}

/** Sums every purchase's total by company — all-time, no period filter, mirrors computeCompanySalesTotals. */
function computePurchaseCompanyTotals() {
  const totals = new Map(); // companyId -> total
  Store.getPurchases().forEach(p => {
    totals.set(p.companyId, (totals.get(p.companyId) || 0) + (Number(p.total) || 0));
  });
  return Array.from(totals.entries())
    .map(([companyId, total]) => ({ name: companyName(companyId) || 'Unknown Company', value: Math.round(total * 100) / 100 }))
    .filter(s => s.value > 0.009)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sums every cash/manual expense's amount by category — all-time, no period filter. */
function computeExpenseCategoryTotals() {
  const totals = new Map(); // category -> total
  Store.getExpenses().forEach(e => {
    const cat = e.category || 'Uncategorized';
    totals.set(cat, (totals.get(cat) || 0) + (Number(e.amount) || 0));
  });
  return Array.from(totals.entries())
    .map(([name, total]) => ({ name, value: Math.round(total * 100) / 100 }))
    .filter(s => s.value > 0.009)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Groups purchase totals by company and by period (mode: 'monthly' | 'quarterly' | 'annual') for the Trend bar view. */
function computePurchaseCompanyByPeriod(mode) {
  const periodLabels = new Map();
  const companyTotals = new Map(); // companyId -> Map(periodKey -> total)

  Store.getPurchases().forEach(p => {
    const { key, label } = salesTrendPeriodKey(mode, p.date);
    if (!periodLabels.has(key)) periodLabels.set(key, label);
    if (!companyTotals.has(p.companyId)) companyTotals.set(p.companyId, new Map());
    const perPeriod = companyTotals.get(p.companyId);
    perPeriod.set(key, (perPeriod.get(key) || 0) + (Number(p.total) || 0));
  });

  const sortedKeys = Array.from(periodLabels.keys()).sort();
  const labels = sortedKeys.map(k => periodLabels.get(k));
  const datasets = Array.from(companyTotals.entries())
    .map(([companyId, perPeriod]) => ({
      name: companyName(companyId) || 'Unknown Company',
      data: sortedKeys.map(k => Math.round((perPeriod.get(k) || 0) * 100) / 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { labels, datasets };
}

/** Groups expense amounts by category and by period (mode: 'monthly' | 'quarterly' | 'annual') for the Trend bar view. */
function computeExpenseCategoryByPeriod(mode) {
  const periodLabels = new Map();
  const categoryTotals = new Map(); // category -> Map(periodKey -> total)

  Store.getExpenses().forEach(e => {
    const { key, label } = salesTrendPeriodKey(mode, e.date);
    if (!periodLabels.has(key)) periodLabels.set(key, label);
    const cat = e.category || 'Uncategorized';
    if (!categoryTotals.has(cat)) categoryTotals.set(cat, new Map());
    const perPeriod = categoryTotals.get(cat);
    perPeriod.set(key, (perPeriod.get(key) || 0) + (Number(e.amount) || 0));
  });

  const sortedKeys = Array.from(periodLabels.keys()).sort();
  const labels = sortedKeys.map(k => periodLabels.get(k));
  const datasets = Array.from(categoryTotals.entries())
    .map(([name, perPeriod]) => ({
      name,
      data: sortedKeys.map(k => Math.round((perPeriod.get(k) || 0) * 100) / 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { labels, datasets };
}

/** Shared pie renderer (Breakdown view): destroys any prior instance and either draws the pie or shows the empty-state card. */
function renderPieChart(canvasSel, emptyElSel, prevInstance, slices) {
  const canvas = $(canvasSel);
  const emptyEl = $(emptyElSel);
  if (prevInstance) prevInstance.destroy();

  if (!slices.length) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'block';
    return null;
  }
  canvas.style.display = 'block';
  emptyEl.style.display = 'none';

  return new Chart(canvas.getContext('2d'), {
    type: 'pie',
    data: {
      labels: slices.map(s => s.name),
      datasets: [{ data: slices.map(s => s.value), backgroundColor: slices.map((_, i) => colorForIndex(i)) }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right' },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } },
      },
    },
  });
}

/** Shared grouped-bar renderer (Trend view): one bar series per company/product, periods along the x-axis. */
function renderBarChart(canvasSel, emptyElSel, prevInstance, labels, datasets) {
  const canvas = $(canvasSel);
  const emptyEl = $(emptyElSel);
  if (prevInstance) prevInstance.destroy();

  if (!datasets.length) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'block';
    return null;
  }
  canvas.style.display = 'block';
  emptyEl.style.display = 'none';

  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map((ds, i) => ({ label: ds.name, data: ds.data, backgroundColor: colorForIndex(i) })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmt(v) } } },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
      },
    },
  });
}

/**
 * Company Sales, Product Sales, Purchases by Company, and Cash/Manual Expenses (by Category)
 * each toggle between a Breakdown pie (all-time totals, always reflects every record regardless
 * of date) and a Trend bar chart (Monthly/Quarterly/FY, one series per company/product/category)
 * — sharing this one config-driven implementation instead of near-identical copies.
 */
const SALES_CHARTS = {
  company: { prefix: 'companySales', computeTotals: computeCompanySalesTotals, computeByPeriod: computeCompanySalesByPeriod },
  product: { prefix: 'productSales', computeTotals: computeProductSalesTotals, computeByPeriod: computeProductSalesByPeriod },
  purchaseCompany: { prefix: 'purchaseCompany', computeTotals: computePurchaseCompanyTotals, computeByPeriod: computePurchaseCompanyByPeriod },
  expenseCategory: { prefix: 'expenseCategory', computeTotals: computeExpenseCategoryTotals, computeByPeriod: computeExpenseCategoryByPeriod },
};
const salesChartState = {
  company: { view: 'breakdown', trend: 'annual', instance: null },
  product: { view: 'breakdown', trend: 'annual', instance: null },
  purchaseCompany: { view: 'breakdown', trend: 'annual', instance: null },
  expenseCategory: { view: 'breakdown', trend: 'annual', instance: null },
};

function renderSalesChart(key) {
  const cfg = SALES_CHARTS[key];
  const state = salesChartState[key];
  const canvasSel = `#${cfg.prefix}ChartCanvas`;
  const emptySel = `#${cfg.prefix}ChartEmpty`;
  if (state.view === 'trend') {
    const { labels, datasets } = cfg.computeByPeriod(state.trend);
    state.instance = renderBarChart(canvasSel, emptySel, state.instance, labels, datasets);
  } else {
    state.instance = renderPieChart(canvasSel, emptySel, state.instance, cfg.computeTotals());
  }
}

function wireSalesChartToggles(key) {
  const p = SALES_CHARTS[key].prefix;
  $(`#${p}ViewBreakdownBtn`).addEventListener('click', () => {
    salesChartState[key].view = 'breakdown';
    $(`#${p}ViewBreakdownBtn`).classList.add('active');
    $(`#${p}ViewTrendBtn`).classList.remove('active');
    $(`#${p}TrendToggleRow`).style.display = 'none';
    renderSalesChart(key);
  });
  $(`#${p}ViewTrendBtn`).addEventListener('click', () => {
    salesChartState[key].view = 'trend';
    $(`#${p}ViewTrendBtn`).classList.add('active');
    $(`#${p}ViewBreakdownBtn`).classList.remove('active');
    $(`#${p}TrendToggleRow`).style.display = 'flex';
    renderSalesChart(key);
  });
  const trendIds = { monthly: `#${p}MonthlyBtn`, quarterly: `#${p}QuarterlyBtn`, annual: `#${p}AnnualBtn` };
  Object.entries(trendIds).forEach(([mode, id]) => {
    $(id).addEventListener('click', () => {
      salesChartState[key].trend = mode;
      Object.values(trendIds).forEach(i => $(i).classList.remove('active'));
      $(id).classList.add('active');
      renderSalesChart(key);
    });
  });
}
wireSalesChartToggles('company');
wireSalesChartToggles('product');
wireSalesChartToggles('purchaseCompany');
wireSalesChartToggles('expenseCategory');

function renderCompanySalesChart() { renderSalesChart('company'); }
function renderProductSalesChart() { renderSalesChart('product'); }
function renderPurchaseCompanyChart() { renderSalesChart('purchaseCompany'); }
function renderExpenseCategoryChart() { renderSalesChart('expenseCategory'); }

let pendingPaymentsChartInstance = null;
function renderPendingPaymentsChart() {
  const slices = computeCompanyOutstanding()
    .filter(r => r.owed > 0.009)
    .map(r => ({ name: r.company.name, value: Math.round(r.owed * 100) / 100 }));
  pendingPaymentsChartInstance = renderPieChart('#pendingPaymentsChartCanvas', '#pendingPaymentsChartEmpty', pendingPaymentsChartInstance, slices);
}

/* =====================================================================
   EXCEL EXPORT
===================================================================== */
function paymentStatusText(inv) {
  if (!inv.payment || !inv.payment.received) return 'Unpaid';
  if (inv.payment.shortfallType === 'tds' && inv.payment.shortfallAmount > 0.009) return 'TDS Deducted';
  if (inv.payment.shortfallAmount > 0.009) return 'Partially Paid';
  return 'Paid';
}

function invoiceExportRow(inv) {
  return {
    'Invoice No': inv.invoiceNo,
    'Date': inv.date,
    'Company': companyName(inv.companyId),
    'Subtotal': Number(inv.subtotal) || 0,
    'CGST': Number(inv.cgst) || 0,
    'SGST': Number(inv.sgst) || 0,
    'IGST': Number(inv.igst) || 0,
    'Total': Number(inv.total) || 0,
    'Amount Received': inv.payment && inv.payment.received ? Number(inv.payment.amountReceived) || 0 : 0,
    'Payment Date': inv.payment && inv.payment.received ? (inv.payment.paymentDate || '') : '',
    'Shortfall Type': inv.payment && inv.payment.shortfallType ? (inv.payment.shortfallType === 'tds' ? 'TDS' : 'Pending') : '',
    'Shortfall Amount': inv.payment ? Number(inv.payment.shortfallAmount) || 0 : 0,
    'Balance Due': Math.round(invoiceBalance(inv) * 100) / 100,
    'Status': paymentStatusText(inv),
  };
}

function paymentExportRow(inv) {
  return {
    'Invoice No': inv.invoiceNo,
    'Date': inv.date,
    'Company': companyName(inv.companyId),
    'Invoice Total': Number(inv.total) || 0,
    'Amount Received': inv.payment && inv.payment.received ? Number(inv.payment.amountReceived) || 0 : 0,
    'Payment Date': inv.payment && inv.payment.received ? (inv.payment.paymentDate || '') : '',
    'Balance Due': Math.round(invoiceBalance(inv) * 100) / 100,
    'Expected Payment Date': expectedPaymentDate(inv),
    'Status': paymentStatusText(inv),
  };
}

function purchaseExportRow(p) {
  return {
    'Purchase No': p.purchaseNo,
    'Date': p.date,
    'Company': companyName(p.companyId),
    'Subtotal': Number(p.subtotal) || 0,
    'CGST': Number(p.cgst) || 0,
    'SGST': Number(p.sgst) || 0,
    'IGST': Number(p.igst) || 0,
    'Total': Number(p.total) || 0,
    'Payment Done': p.paymentDone ? 'Yes' : 'No',
    'Payment Note': p.paymentNote || '',
  };
}

function expenseExportRow(e) {
  return {
    'Date': e.date,
    'Category': e.category,
    'Description': e.description || '',
    'Amount': Number(e.amount) || 0,
  };
}

/* Free-text fields (company names, payment notes, descriptions) reach exported
 * rows unsanitized — a value starting with =/+/-/@ would otherwise export as a
 * live formula Excel may execute on open. Prefixing with a straight quote is
 * Excel's own "treat as text" escape and doesn't change how the value displays. */
function sanitizeForExcel(value) {
  return (typeof value === 'string' && /^[=+\-@]/.test(value)) ? `'${value}` : value;
}

function downloadWorkbook(sheets, filename) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const safeRows = rows.map(row => {
      const safe = {};
      Object.keys(row).forEach(k => { safe[k] = sanitizeForExcel(row[k]); });
      return safe;
    });
    const ws = safeRows.length ? XLSX.utils.json_to_sheet(safeRows) : XLSX.utils.aoa_to_sheet([['No data for this selection']]);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  });
  XLSX.writeFile(wb, filename);
}

/* Triggers a browser download of a plain JS object as a formatted JSON file —
 * used by the "Download DB Snapshot" button below. A transient <a download>
 * + object URL is the standard no-backend way to save a file; revoked right
 * after the click since the browser has already captured the blob by then. */
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Admin-only: pulls the freshest copy of every entity straight from Supabase
 * (independent of dataBackendMode — works whether the app's active backend is
 * currently 'file' or 'supabase') and downloads it as business-suite-data.json,
 * shaped exactly like the real local data file. Lets an admin grab an
 * up-to-date backup/inspection copy without switching the session's data
 * source over. Hidden outright for non-admins via body.non-admin in
 * css/style.css; this check is the backstop in case it's reached another way. */
$('#btnDownloadDbSnapshot').addEventListener('click', withErrorToast(async () => {
  if (!currentUser || !currentUser.isAdmin) { toast('Admins only'); return; }
  toast('Fetching latest data from the database…');
  const snapshot = await Store.fetchLatestDataFromSupabase();
  downloadJSON(snapshot, 'business-suite-data.json');
  toast('Downloaded the latest database snapshot');
}));

/* =====================================================================
   SYNC TO DB (Admin-only) — pushes the local file's current data to
   Supabase, but only after showing a full field-level diff for review.
   Deliberately independent of dataBackendMode, mirroring the Download DB
   Snapshot button above; see Store.computeSyncDiff/syncPushToSupabase.
===================================================================== */
const SYNC_ENTITY_LABELS = {
  [STORAGE_KEYS.products]: 'Products',
  [STORAGE_KEYS.companies]: 'Companies',
  [STORAGE_KEYS.profile]: 'Business Profile',
  [STORAGE_KEYS.quotations]: 'Quotations',
  [STORAGE_KEYS.invoices]: 'Invoices',
  [STORAGE_KEYS.purchases]: 'Purchases',
  [STORAGE_KEYS.expenses]: 'Expenses',
  [STORAGE_KEYS.units]: 'Units',
  [STORAGE_KEYS.gstRates]: 'GST Rates',
  [STORAGE_KEYS.expenseCategories]: 'Expense Categories',
  [STORAGE_KEYS.termsTemplates]: 'Terms & Conditions',
};

function syncRecordLabel(record) {
  if (!record) return '(none)';
  return record.invoiceNo || record.quotationNo || record.purchaseNo || record.name || record.value || record.text
    || (record.date ? `${record.date}${record.category ? ' — ' + record.category : ''}` : record.id);
}

function formatDiffValue(v) {
  if (v === undefined || v === null || v === '') return '<em>(empty)</em>';
  if (typeof v === 'object') return `<code>${escapeHtml(JSON.stringify(v))}</code>`;
  return escapeHtml(String(v));
}

function diffFieldsTable(changes) {
  return `<table class="diff-table"><thead><tr><th>Field</th><th>Current (DB)</th><th>New (Local)</th></tr></thead><tbody>
    ${changes.map(c => `<tr><td>${escapeHtml(c.field)}</td><td>${formatDiffValue(c.oldValue)}</td><td>${formatDiffValue(c.newValue)}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderSyncDiffModal(diff) {
  let totalChanges = 0;
  const sections = ALL_BUSINESS_DATA_KEYS.map((key) => {
    const d = diff[key];
    if (!d) return '';
    const label = SYNC_ENTITY_LABELS[key] || key;
    if (d.type === 'object') {
      if (!d.changes.length) return '';
      totalChanges += 1;
      return `<details open><summary><strong>${escapeHtml(label)}</strong> — changed</summary>${diffFieldsTable(d.changes)}</details>`;
    }
    const { added, changed, removed } = d;
    if (!added.length && !changed.length && !removed.length) return '';
    totalChanges += added.length + changed.length + removed.length;
    const addedHtml = added.length ? `<div><strong>Added (${added.length}):</strong> ${added.map(r => escapeHtml(syncRecordLabel(r))).join(', ')}</div>` : '';
    const removedHtml = removed.length ? `<div><strong>Removed (${removed.length}):</strong> ${removed.map(r => escapeHtml(syncRecordLabel(r))).join(', ')}</div>` : '';
    const changedHtml = changed.length ? changed.map(c => `
      <details><summary>Changed: ${escapeHtml(syncRecordLabel(c.record))}</summary>${diffFieldsTable(c.changes)}</details>`).join('') : '';
    return `<details open><summary><strong>${escapeHtml(label)}</strong> — ${added.length} added, ${changed.length} changed, ${removed.length} removed</summary>
      <div style="padding:8px 0 8px 16px;">${addedHtml}${removedHtml}${changedHtml}</div>
    </details>`;
  }).filter(Boolean).join('');

  $('#syncDiffBody').innerHTML = totalChanges ? sections : '<p>No differences — local data already matches the database.</p>';
  $('#confirmSyncBtn').style.display = totalChanges ? '' : 'none';
}

$('#btnSyncToDb').addEventListener('click', withErrorToast(async () => {
  if (!currentUser || !currentUser.isAdmin) { toast('Admins only'); return; }
  toast('Comparing local data with the database…');
  const diff = await Store.computeSyncDiff();
  renderSyncDiffModal(diff);
  openModal('syncDiffModal');
}));

$('#confirmSyncBtn').addEventListener('click', withErrorToast(async () => {
  if (!currentUser || !currentUser.isAdmin) { toast('Admins only'); return; }
  await Store.syncPushToSupabase();
  closeModal('syncDiffModal');
  toast('Synced local data to the database');
}));

function invoicePeriodKey(mode, dateStr) {
  return mode === 'annual' ? currentFinancialYear(parseLocalDate(dateStr)) : dateStr.slice(0, 7);
}

function getInvoicePeriodOptions(mode) {
  const keys = new Set(realInvoices().map(inv => invoicePeriodKey(mode, inv.date)));
  return Array.from(keys).sort().reverse().map(key => ({
    value: key,
    label: mode === 'annual' ? `FY ${key}` : formatMonthLabel(key),
  }));
}

function getFinancialYearOptions() {
  const keys = new Set([
    ...realInvoices().map(inv => currentFinancialYear(parseLocalDate(inv.date))),
    ...Store.getPurchases().map(p => currentFinancialYear(parseLocalDate(p.date))),
    ...Store.getExpenses().map(e => currentFinancialYear(parseLocalDate(e.date))),
  ]);
  return Array.from(keys).sort().reverse();
}

let exportPeriodMode = 'monthly';

function populateExportPeriodSelect() {
  const options = getInvoicePeriodOptions(exportPeriodMode);
  const sel = $('#exportPeriodValue');
  sel.innerHTML = options.length
    ? options.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')
    : `<option value="">No invoices yet</option>`;
}

function populateExportFYSelect() {
  const fys = getFinancialYearOptions();
  const sel = $('#exportFYValue');
  sel.innerHTML = fys.length
    ? fys.map(fy => `<option value="${fy}">FY ${fy}</option>`).join('')
    : `<option value="">No data yet</option>`;
}

function populateExportCompanySelect() {
  const companies = Store.getCompanies().filter(c => c.isSalesCompany).slice().sort((a, b) => a.name.localeCompare(b.name));
  const sel = $('#exportCompanyId');
  sel.innerHTML = companies.length
    ? companies.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">No companies yet</option>`;
}

function updateExportFieldsVisibility() {
  const type = $('#exportType').value;
  $('#exportPeriodFields').style.display = type === 'invoicesByPeriod' ? '' : 'none';
  $('#exportFYFields').style.display = type === 'fySummary' ? '' : 'none';
  $('#exportCompanyFields').style.display = type === 'invoicesByCompany' ? '' : 'none';
  if (type === 'invoicesByPeriod') populateExportPeriodSelect();
  if (type === 'fySummary') populateExportFYSelect();
  if (type === 'invoicesByCompany') populateExportCompanySelect();
}

$('#btnOpenExport').addEventListener('click', () => {
  $('#exportType').value = 'invoicesByPeriod';
  exportPeriodMode = 'monthly';
  $('#exportPeriodModeMonthlyBtn').classList.add('active');
  $('#exportPeriodModeAnnualBtn').classList.remove('active');
  updateExportFieldsVisibility();
  openModal('exportModal');
});

$('#exportType').addEventListener('change', updateExportFieldsVisibility);

$('#exportPeriodModeMonthlyBtn').addEventListener('click', () => {
  exportPeriodMode = 'monthly';
  $('#exportPeriodModeMonthlyBtn').classList.add('active');
  $('#exportPeriodModeAnnualBtn').classList.remove('active');
  populateExportPeriodSelect();
});
$('#exportPeriodModeAnnualBtn').addEventListener('click', () => {
  exportPeriodMode = 'annual';
  $('#exportPeriodModeAnnualBtn').classList.add('active');
  $('#exportPeriodModeMonthlyBtn').classList.remove('active');
  populateExportPeriodSelect();
});

function exportInvoicesByPeriod(mode, key) {
  const invoices = realInvoices()
    .filter(inv => invoicePeriodKey(mode, inv.date) === key)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const label = mode === 'annual' ? `FY_${key}` : key;
  downloadWorkbook([{ name: 'Invoices', rows: invoices.map(invoiceExportRow) }], `Invoices_${label}.xlsx`);
}

function exportFinancialYearSummary(fy) {
  const inFY = (dateStr) => currentFinancialYear(parseLocalDate(dateStr)) === fy;
  const invoices = realInvoices().filter(inv => inFY(inv.date)).sort((a, b) => new Date(a.date) - new Date(b.date));
  const purchases = Store.getPurchases().filter(p => inFY(p.date)).sort((a, b) => new Date(a.date) - new Date(b.date));
  const expenses = Store.getExpenses().filter(e => inFY(e.date)).sort((a, b) => new Date(a.date) - new Date(b.date));
  downloadWorkbook([
    { name: 'Invoices', rows: invoices.map(invoiceExportRow) },
    { name: 'Payments', rows: invoices.map(paymentExportRow) },
    { name: 'Purchases', rows: purchases.map(purchaseExportRow) },
    { name: 'Expenses', rows: expenses.map(expenseExportRow) },
  ], `Financial_Summary_FY_${fy}.xlsx`);
}

function exportInvoicesByCompany(companyId) {
  const invoices = realInvoices()
    .filter(inv => inv.companyId === companyId)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const safeName = companyName(companyId).replace(/[^a-z0-9]+/gi, '_');
  downloadWorkbook([{ name: 'Invoices', rows: invoices.map(invoiceExportRow) }], `Invoices_${safeName}.xlsx`);
}

$('#downloadExportBtn').addEventListener('click', () => {
  const type = $('#exportType').value;
  if (type === 'invoicesByPeriod') {
    const key = $('#exportPeriodValue').value;
    if (!key) { toast('No invoices available for that selection'); return; }
    exportInvoicesByPeriod(exportPeriodMode, key);
  } else if (type === 'fySummary') {
    const fy = $('#exportFYValue').value;
    if (!fy) { toast('No data available to export'); return; }
    exportFinancialYearSummary(fy);
  } else if (type === 'invoicesByCompany') {
    const companyId = $('#exportCompanyId').value;
    if (!companyId) { toast('Select a company first'); return; }
    exportInvoicesByCompany(companyId);
  }
  closeModal('exportModal');
  toast('Export downloaded');
});

/* =====================================================================
   ERROR LOGS (Admin-only) — reads/writes go straight through ErrorLog, not
   Store/TAB_LAZY_KEYS, since error_logs is a real per-row Supabase table,
   independent of whichever backend (file/Supabase) holds business data.
===================================================================== */
async function renderErrorLogs() {
  const tbody = $('#errorLogsTbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Loading…</td></tr>`;
  try {
    let rows = await ErrorLog.fetchRecent(200);
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No errors logged yet.</td></tr>`;
      return;
    }
    rows = sortState.errorLogs ? sortRows(rows, 'errorLogs') : rows;
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtml(new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</td>
        <td>${escapeHtml(r.source || '-')}</td>
        <td>${escapeHtml(r.message || '-')}</td>
        <td>${escapeHtml(r.probable_cause || '-')}</td>
        <td>${escapeHtml(r.username || '-')}</td>
        <td>${r.details ? `<details><summary>View</summary><pre>${escapeHtml(r.details)}</pre></details>` : '-'}</td>
      </tr>
    `).join('');
    updateSortIndicators('errorLogs');
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Could not load logs: ${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

$('#errorLogsRefreshBtn').addEventListener('click', renderErrorLogs);

$('#errorLogsClearBtn').addEventListener('click', async () => {
  const days = Number($('#errorLogsClearDays').value) || 30;
  if (!confirm(`Delete all logs older than ${days} day(s)? This cannot be undone.`)) return;
  try {
    await ErrorLog.clearOlderThan(days);
    await renderErrorLogs();
    toast('Old logs cleared');
  } catch (e) {
    toast('Could not clear logs: ' + (e.message || e));
  }
});

/* =====================================================================
   INIT
===================================================================== */
Object.assign(SORT_RENDER_FNS, {
  products: renderProducts,
  companies: renderCompanies,
  quotations: renderQuotations,
  invoices: renderInvoices,
  purchases: renderPurchases,
  purchasesByCompany: renderPurchasesByCompany,
  expenses: renderExpenses,
  payments: renderPayments,
  summaryOutstanding: renderSummaryOutstanding,
  summarySales: renderSummarySales,
  pnl: renderProfitLoss,
  gst: renderGstPayment,
  errorLogs: renderErrorLogs,
});

function init() {
  loadProfileForm();
  populateProductsFilterOptions();
  renderProducts();
  renderCompanies();
  populateCompanyDropdowns();
  populatePurchasesFilterOptions();
  populateExpensesFilterOptions();
  populateUnitOptions();
  populateGstRateOptions($('#productGst'));
  populateExpenseCategoryOptions();
  applyTabLayout();
  /* Quotations/Invoices/Purchases/Expenses/Payments/Summary no longer render
     here unconditionally — they go through activateTab's lazy-fetch gate
     instead (see TAB_LAZY_KEYS above), so re-render whichever tab is actually
     showing. On the very first load (currentTabId still null), the landing
     tab is no longer hardcoded to Summary — getDefaultLandingTabId() picks
     the first tab actually visible to the current user, in case Financials
     has been hidden for a non-admin via Tab Layout; this also requires
     re-driving setPrimaryActive/showSubnav here (the hardcoded HTML 'active'
     classes only match the true default), while later init() re-calls
     (Switch Folder, DB Connection save, etc.) keep reusing currentTabId
     exactly as before. */
  if (!currentTabId) {
    const landing = getDefaultLandingTabId();
    const landingGroup = groupForTab(landing);
    setPrimaryActive(landingGroup || landing);
    showSubnav(landingGroup);
  }
  activateTab(currentTabId || getDefaultLandingTabId());
  updateConnectivityBanner();
}

/* Renders the header connectivity banner from Store.getConnectivityStatus() —
   called from init() (so a fresh load shows the right state immediately) and
   from storage.js's notifyConnectivityChanged() on every state change
   (poll result, successful/failed persist, entering/leaving offline bypass).
   Three mutually exclusive groups: connected-to-Supabase monitoring, the
   pre-login offline-bypass state (with its "Log In & Sync" recovery button),
   or plain local-file mode with neither — hidden entirely in that last case. */
function updateConnectivityBanner() {
  const status = Store.getConnectivityStatus();
  const banner = $('#dbConnectivityBanner');
  const text = $('#dbConnectivityText');
  const syncBtn = $('#bypassLoginSyncBtn');
  banner.classList.remove('db-connectivity-ok', 'db-connectivity-warn', 'db-connectivity-down');

  if (status.mode === 'supabase') {
    syncBtn.style.display = 'none';
    banner.style.display = 'flex';
    if (status.supabaseHealthy && status.pendingCount === 0) {
      banner.classList.add('db-connectivity-ok');
      text.textContent = 'Database connected';
    } else if (status.supabaseHealthy && status.pendingCount > 0) {
      banner.classList.add('db-connectivity-warn');
      text.textContent = `Database connected — syncing ${status.pendingCount} pending change(s)…`;
    } else if (status.pendingCount > 0) {
      banner.classList.add('db-connectivity-down');
      text.textContent = `Database unreachable — ${status.pendingCount} change(s) waiting to sync`;
    } else {
      banner.classList.add('db-connectivity-down');
      text.textContent = 'Database unreachable';
    }
  } else if (status.offlineBypass) {
    banner.style.display = 'flex';
    banner.classList.add('db-connectivity-down');
    syncBtn.style.display = '';
    text.textContent = status.bypassHasUnsynced
      ? 'Working offline — changes not yet synced to the database'
      : 'Working offline — not connected to the database';
  } else {
    banner.style.display = 'none';
    syncBtn.style.display = 'none';
  }
}

$('#bypassLoginSyncBtn').addEventListener('click', withErrorToast(async () => {
  await runLoginGate();
  if (confirm('Sync your local changes made while offline up to the database now? This will overwrite the database\'s copy of any records you changed.')) {
    await Store.activateSupabaseBackend('push');
    Store.clearOfflineBypassMode();
    toast('Synced — now connected to the database');
    init();
  } else {
    Store.clearOfflineBypassMode();
    toast('Logged in — you can sync later from DB Connection');
    updateConnectivityBanner();
  }
}));

/* ---------------- Bootstrap gates: file folder -> Supabase setup -> login -> app ---------------- */

/* First run only: ask for the Supabase Project URL/anon key once, then remember them.
   Every load after that, this just re-initializes the client from the saved config. */
async function runSupabaseSetupGate() {
  const cfg = await SecretsStore.getDbConnection();
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    SupabaseClient.init(cfg.supabaseUrl, cfg.supabaseAnonKey);
    return;
  }
  return new Promise((resolve) => {
    const overlay = $('#supabaseSetupGateOverlay');
    const errorEl = $('#supabaseSetupError');
    overlay.style.display = 'flex';
    $('#supabaseSetupSaveBtn').addEventListener('click', async function onSave() {
      const url = $('#supabaseSetupUrl').value.trim();
      const key = $('#supabaseSetupKey').value.trim();
      if (!url || !key) {
        errorEl.textContent = 'Both fields are required.';
        errorEl.style.display = 'block';
        return;
      }
      await SecretsStore.saveDbConnection({ supabaseUrl: url, supabaseAnonKey: key, useSupabaseActive: false });
      SupabaseClient.init(url, key);
      overlay.style.display = 'none';
      resolve();
    });
  });
}

/* Runs fresh every time it's invoked (no persisted session, by design) — real
   password verification happens on Supabase's server via SupabaseClient.signIn.
   The actual submit listeners are registered exactly once, below, at module
   load — runLoginGate() itself just shows the overlay and hands out a promise
   resolved by the next successful submit, so it's safely re-invokable. This
   matters because "Log In & Sync" (the offline-bypass recovery action) can
   trigger a real login a second time in the same session, not just once at boot. */
let pendingLoginResolve = null;

async function handleLoginSubmit() {
  if (!pendingLoginResolve) return;
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  const errorEl = $('#loginError');
  errorEl.style.display = 'none';
  try {
    await SupabaseClient.signIn(username, password);
    currentUser = await SupabaseClient.getMyProfile();
    ErrorLog.record('Login succeeded', null, { source: 'SupabaseClient.signIn', username });
    Store.setViewerMode(currentUser.isViewer);
    document.body.classList.toggle('viewer-mode', !!currentUser.isViewer);
    Store.setDeleteRestricted(!currentUser.isAdmin);
    document.body.classList.toggle('non-admin', !currentUser.isAdmin);
    $('#loginGateOverlay').style.display = 'none';
    const resolve = pendingLoginResolve;
    pendingLoginResolve = null;
    resolve();
  } catch (e) {
    // The proactive runDatabaseConnectivityGate() (below) already catches a fully
    // unreachable database before this screen even shows — this classification is
    // for the rarer case where that check passed but the real sign-in still fails
    // (a genuine wrong password, or an auth-layer flake right after the check).
    errorEl.textContent = ErrorLog.guessProbableCause(e) || ('Could not log in: ' + (e.message || e));
    errorEl.style.display = 'block';
  }
}
$('#loginSubmitBtn').addEventListener('click', handleLoginSubmit);
$('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLoginSubmit(); });

async function runLoginGate() {
  return new Promise((resolve) => {
    $('#loginGateOverlay').style.display = 'flex';
    pendingLoginResolve = resolve;
  });
}

/* Proactive, one-time check at boot — before the login screen ever shows — so a
   genuine database outage doesn't masquerade as "wrong password" (handled above
   only for the rarer post-check failure). Never re-triggered mid-session; that's
   the separate, ongoing connectivity banner (updateConnectivityBanner()) instead.
   Resolves true only if the user explicitly chose to bypass login and work
   offline; false if connectivity is fine (or was restored via Retry). */
async function runDatabaseConnectivityGate() {
  if (!SupabaseClient.isInitialized()) return false;
  const cfg = await SecretsStore.getDbConnection();
  // The file-gate overlay is still up at this point (app.js's bootstrap chain
  // hasn't called hideGate() yet — see the bottom of this file), so give this
  // wait its own accurate heading instead of leaving the stale "Connect Your
  // Data Folder" / "Loading…" text showing while the connectivity check is
  // in flight. Message cleared since the heading alone says it all here.
  showGate('', false, 'Checking Database Connection');
  const result = await Store.testSupabaseConnection(cfg.supabaseUrl, cfg.supabaseAnonKey);
  if (result.ok) return false;

  return new Promise((resolve) => {
    const overlay = $('#dbConnectivityGateOverlay');
    overlay.style.display = 'flex';
    $('#dbConnectivityRetryBtn').addEventListener('click', async () => {
      // Hide this failure card and let the always-on file-gate overlay underneath
      // (lower z-index, never actually dismissed until the whole bootstrap chain
      // finishes) show the same "Checking Database Connection" state the initial
      // check used — so a retry gives the same visible feedback instead of the
      // button just sitting there silently during the network round-trip.
      overlay.style.display = 'none';
      showGate('', false, 'Checking Database Connection');
      const retryResult = await Store.testSupabaseConnection(cfg.supabaseUrl, cfg.supabaseAnonKey);
      if (retryResult.ok) {
        resolve(false);
      } else {
        overlay.style.display = 'flex';
        toast('Still could not reach the database.');
      }
    });
    $('#dbConnectivityLoadFileBtn').addEventListener('click', () => {
      overlay.style.display = 'none';
      resolve(true);
    });
  });
}

/* If Supabase was left active last session, resume it silently (pull fresh from
   Supabase rather than re-prompting) so the pilot state survives a reload. If it
   wasn't active but is configured, ping it in the background so connection
   problems surface early without blocking the app. A resume failure while the
   Database flag is on must never silently fall through to anything (previously
   it silently degraded to the browser's own localStorage) — the user is asked
   explicitly via runSupabaseResumeFailedGate() instead. */
async function resumeActiveSupabaseBackend() {
  try {
    const cfg = await SecretsStore.getDbConnection();
    if (cfg.useSupabaseActive && SupabaseClient.isInitialized()) {
      await Store.activateSupabaseBackend('pull');
    } else if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
      Store.testSupabaseConnection(cfg.supabaseUrl, cfg.supabaseAnonKey).catch(() => {});
    }
  } catch (e) {
    console.error('Could not resume the Supabase data backend.', e);
    ErrorLog.record('Could not resume the Supabase data backend', e, { source: 'resumeActiveSupabaseBackend' });
    await runSupabaseResumeFailedGate();
  }
}

/* Blocks until the user picks Retry (re-attempts the Supabase pull, and can be
   clicked again on repeated failure) or Use Local Data File Instead (a
   session-only fallback via Store.recoverToLocalFileAfterSupabaseFailure() —
   the saved useSupabaseActive flag is untouched, so Supabase is tried again on
   the next reload). Reuses the same .file-gate-overlay/.file-gate-card pattern
   as the other three bootstrap gates. */
async function runSupabaseResumeFailedGate() {
  return new Promise((resolve) => {
    const overlay = $('#supabaseResumeFailedOverlay');
    overlay.style.display = 'flex';
    $('#supabaseResumeRetryBtn').addEventListener('click', async () => {
      try {
        await Store.activateSupabaseBackend('pull');
        overlay.style.display = 'none';
        resolve();
      } catch (e) {
        ErrorLog.record('Retry: could not resume the Supabase data backend', e, { source: 'resumeActiveSupabaseBackend.retry' });
        toast('Still could not reach Supabase.');
      }
    });
    $('#supabaseResumeUseLocalBtn').addEventListener('click', async () => {
      await Store.recoverToLocalFileAfterSupabaseFailure();
      overlay.style.display = 'none';
      resolve();
    });
  });
}

Store.ready
  .then(runSupabaseSetupGate)
  .then(async () => {
    const bypassed = await runDatabaseConnectivityGate();
    if (bypassed) {
      await Store.enterOfflineBypassMode();
      return; // skip login + resumeActiveSupabaseBackend entirely for this session
    }
    await runLoginGate();
    await resumeActiveSupabaseBackend();
  })
  .then(() => {
    // The file-gate overlay (repurposed as a generic "Loading…" cover once its
    // own job is done — see storage.js's bootstrapDataSource/initFileStorage)
    // has been up continuously since first paint, so the specific gates above
    // (Setup/Connectivity/Login/Resume-failed) always render on top of *something*
    // rather than a flash of unrendered app content. Only now, once the whole
    // chain is genuinely done, do we dismiss it and reveal the real app.
    hideGate();
    init();
  });
