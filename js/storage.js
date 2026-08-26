/* localStorage-backed data access layer. All data is plain JSON. */

const STORAGE_KEYS = {
  products: 'qb_products',
  companies: 'qb_companies',
  profile: 'qb_profile',
  quotations: 'qb_quotations',
  invoices: 'qb_invoices',
  purchaseCompanies: 'qb_purchaseCompanies',
  purchases: 'qb_purchases',
  expenses: 'qb_expenses',
  units: 'qb_units',
  gstRates: 'qb_gstRates',
  expenseCategories: 'qb_expenseCategories',
  termsTemplates: 'qb_termsTemplates',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Once a data folder is connected, `fileData` becomes the live in-memory
   mirror of the on-disk JSON file and every read/write goes through it
   instead of localStorage — see the FILE-BACKED STORAGE section below. */
let fileData = null;

/* Pilot third backend: when `dataBackendMode === 'supabase'`, every entity moves
   through an in-memory `supabaseData` cache instead of `fileData`/localStorage —
   see the SUPABASE DATA BACKEND section below. Reads are synchronous from this
   cache (populated once when the mode turns on); writes update the cache
   synchronously and schedule an async background upsert, mirroring the existing
   fileData/writeQueue/persistToFile pattern exactly. */
let dataBackendMode = 'file';
let supabaseData = {};

/* Per-tab fetching (Supabase backend only — see js/app.js's TAB_LAZY_KEYS and
   Store.refreshSupabaseKeys). "Lazy" keys are the unboundedly-growing
   transactional entities plus companies/products, all of which now always
   refetch fresh on every tab visit rather than being cached for the session —
   see "Always-fresh data on tab selection" in CLAUDE.md. Everything else
   ("core") is small, needed by helpers that run unconditionally at init()
   regardless of which tab is active (dropdowns, config pick-lists, profile),
   and stays eagerly loaded once at login exactly like before. */
const LAZY_SUPABASE_KEYS = [STORAGE_KEYS.quotations, STORAGE_KEYS.invoices, STORAGE_KEYS.purchases, STORAGE_KEYS.expenses];
const CORE_SUPABASE_KEYS = Object.values(STORAGE_KEYS).filter((k) => k !== STORAGE_KEYS.purchaseCompanies && !LAZY_SUPABASE_KEYS.includes(k));

/* Every real entity key, i.e. every business-data key that actually gets
   pushed/pulled/backed up as a whole — `purchaseCompanies` is the one
   deliberate exception (a legacy, unused key kept only as a migration safety
   net, see the companies data-model note in CLAUDE.md). Shared by
   pushAllBusinessDataToSupabase (bulk "overwrite everything" push) and
   Store.fetchLatestDataFromSupabase (admin "download latest DB snapshot"
   button) so both agree on exactly which keys make up a full snapshot. */
const ALL_BUSINESS_DATA_KEYS = Object.values(STORAGE_KEYS).filter((k) => k !== STORAGE_KEYS.purchaseCompanies);

/* Backstop for the view-only role: app.js sets this once after login via
   Store.setViewerMode(). The real blocking happens in app.js's own handlers
   (see blockIfViewer()) — this only exists so a future Save button that
   forgets that guard fails loudly instead of silently persisting. */
let viewerMode = false;

function assertNotViewer() {
  if (viewerMode) throw new Error('View-only account — changes are disabled');
}

/* Backstop for restricting Delete to admins (regular non-admin Users keep
   edit access — see blockDeleteIfNotAdmin() in app.js for the real block).
   Called at the top of each true delete method below; not applicable to
   Store.saveProfile (used by "Clear All Data" too), since that method is
   shared with legitimate profile edits. */
let deleteRestricted = false;

function assertCanDelete() {
  if (deleteRestricted) throw new Error('Only admins can delete records');
}

function readList(key) {
  if (dataBackendMode === 'supabase') return supabaseData[key] ? supabaseData[key].slice() : [];
  if (fileData) return fileData[key] ? fileData[key].slice() : [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read', key, e);
    return [];
  }
}

function writeList(key, list) {
  assertNotViewer();
  if (dataBackendMode === 'supabase') {
    // Diffs against the last *confirmed-synced* baseline, not the immediate
    // pre-mutation value — identical in the normal case (they're kept in
    // lockstep after every success), but during an outage this lets a retry
    // correctly pick up every accumulated local edit since the last success
    // in one consolidated catch-up sync (see persistKeyToSupabase).
    const oldList = syncedSupabaseData[key] || [];
    supabaseData[key] = list;
    scheduleSupabasePersist(key, oldList, list);
    return;
  }
  if (fileData) { fileData[key] = list; schedulePersist(); return; }
  localStorage.setItem(key, JSON.stringify(list));
}

function readObject(key, fallback) {
  if (dataBackendMode === 'supabase') return (supabaseData[key] !== undefined && supabaseData[key] !== null) ? supabaseData[key] : fallback;
  if (fileData) return (fileData[key] !== undefined && fileData[key] !== null) ? fileData[key] : fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('Failed to read', key, e);
    return fallback;
  }
}

function writeObject(key, obj) {
  assertNotViewer();
  if (dataBackendMode === 'supabase') { supabaseData[key] = obj; scheduleSupabasePersist(key); return; }
  if (fileData) { fileData[key] = obj; schedulePersist(); return; }
  localStorage.setItem(key, JSON.stringify(obj));
}

const Store = {
  // Products
  getProducts() { return readList(STORAGE_KEYS.products); },
  saveProduct(product) {
    const list = readList(STORAGE_KEYS.products);
    if (product.id) {
      const idx = list.findIndex(p => p.id === product.id);
      if (idx >= 0) { list[idx] = product; }
    } else {
      product.id = uid();
      list.push(product);
    }
    writeList(STORAGE_KEYS.products, list);
    return product;
  },
  deleteProduct(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.products, readList(STORAGE_KEYS.products).filter(p => p.id !== id));
  },

  // Companies
  getCompanies() { return readList(STORAGE_KEYS.companies); },
  saveCompany(company) {
    const list = readList(STORAGE_KEYS.companies);
    if (company.id) {
      const idx = list.findIndex(c => c.id === company.id);
      if (idx >= 0) { list[idx] = company; }
    } else {
      company.id = uid();
      list.push(company);
    }
    writeList(STORAGE_KEYS.companies, list);
    return company;
  },
  deleteCompany(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.companies, readList(STORAGE_KEYS.companies).filter(c => c.id !== id));
  },

  // Business profile (singleton)
  getProfile() {
    return readObject(STORAGE_KEYS.profile, {
      name: '', address: '', gstin: '', logoDataUrl: '',
      bankName: '', bankAccountNo: '', bankIFSC: '', bankBranch: '', sealDataUrl: '',
    });
  },
  saveProfile(profile) {
    writeObject(STORAGE_KEYS.profile, profile);
    return profile;
  },

  // Quotations
  getQuotations() { return readList(STORAGE_KEYS.quotations); },
  saveQuotation(q) {
    const list = readList(STORAGE_KEYS.quotations);
    if (q.id) {
      const idx = list.findIndex(x => x.id === q.id);
      if (idx >= 0) { list[idx] = q; }
    } else {
      q.id = uid();
      q.createdAt = new Date().toISOString();
      list.push(q);
    }
    writeList(STORAGE_KEYS.quotations, list);
    return q;
  },
  deleteQuotation(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.quotations, readList(STORAGE_KEYS.quotations).filter(q => q.id !== id));
  },

  // Invoices
  getInvoices() { return readList(STORAGE_KEYS.invoices); },
  saveInvoice(inv) {
    const list = readList(STORAGE_KEYS.invoices);
    if (inv.id) {
      const idx = list.findIndex(x => x.id === inv.id);
      if (idx >= 0) { list[idx] = inv; }
    } else {
      inv.id = uid();
      inv.createdAt = new Date().toISOString();
      list.push(inv);
    }
    writeList(STORAGE_KEYS.invoices, list);
    return inv;
  },
  deleteInvoice(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.invoices, readList(STORAGE_KEYS.invoices).filter(i => i.id !== id));
  },

  // Purchases
  getPurchases() { return readList(STORAGE_KEYS.purchases); },
  savePurchase(p) {
    const list = readList(STORAGE_KEYS.purchases);
    if (p.id) {
      const idx = list.findIndex(x => x.id === p.id);
      if (idx >= 0) { list[idx] = p; }
    } else {
      p.id = uid();
      p.createdAt = new Date().toISOString();
      list.push(p);
    }
    writeList(STORAGE_KEYS.purchases, list);
    return p;
  },
  deletePurchase(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.purchases, readList(STORAGE_KEYS.purchases).filter(p => p.id !== id));
  },

  // Cash / manual expenses
  getExpenses() { return readList(STORAGE_KEYS.expenses); },
  saveExpense(e) {
    const list = readList(STORAGE_KEYS.expenses);
    if (e.id) {
      const idx = list.findIndex(x => x.id === e.id);
      if (idx >= 0) { list[idx] = e; }
    } else {
      e.id = uid();
      e.createdAt = new Date().toISOString();
      list.push(e);
    }
    writeList(STORAGE_KEYS.expenses, list);
    return e;
  },
  deleteExpense(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.expenses, readList(STORAGE_KEYS.expenses).filter(e => e.id !== id));
  },

  // Default Configurations: Units / Metrics
  getUnits() { return readList(STORAGE_KEYS.units); },
  saveUnit(u) {
    const list = readList(STORAGE_KEYS.units);
    if (u.id) {
      const idx = list.findIndex(x => x.id === u.id);
      if (idx >= 0) { list[idx] = u; }
    } else {
      u.id = uid();
      list.push(u);
    }
    writeList(STORAGE_KEYS.units, list);
    return u;
  },
  deleteUnit(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.units, readList(STORAGE_KEYS.units).filter(u => u.id !== id));
  },

  // Default Configurations: GST Rates
  getGstRates() { return readList(STORAGE_KEYS.gstRates); },
  saveGstRate(r) {
    const list = readList(STORAGE_KEYS.gstRates);
    if (r.id) {
      const idx = list.findIndex(x => x.id === r.id);
      if (idx >= 0) { list[idx] = r; }
    } else {
      r.id = uid();
      list.push(r);
    }
    writeList(STORAGE_KEYS.gstRates, list);
    return r;
  },
  deleteGstRate(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.gstRates, readList(STORAGE_KEYS.gstRates).filter(r => r.id !== id));
  },

  // Default Configurations: Expense Categories
  getExpenseCategories() { return readList(STORAGE_KEYS.expenseCategories); },
  saveExpenseCategory(c) {
    const list = readList(STORAGE_KEYS.expenseCategories);
    if (c.id) {
      const idx = list.findIndex(x => x.id === c.id);
      if (idx >= 0) { list[idx] = c; }
    } else {
      c.id = uid();
      list.push(c);
    }
    writeList(STORAGE_KEYS.expenseCategories, list);
    return c;
  },
  deleteExpenseCategory(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.expenseCategories, readList(STORAGE_KEYS.expenseCategories).filter(c => c.id !== id));
  },

  // Default Configurations: Terms & Conditions templates
  getTermsTemplates() { return readList(STORAGE_KEYS.termsTemplates); },
  saveTermsTemplate(t) {
    const list = readList(STORAGE_KEYS.termsTemplates);
    if (t.id) {
      const idx = list.findIndex(x => x.id === t.id);
      if (idx >= 0) { list[idx] = t; }
    } else {
      t.id = uid();
      list.push(t);
    }
    writeList(STORAGE_KEYS.termsTemplates, list);
    return t;
  },
  deleteTermsTemplate(id) {
    assertCanDelete();
    writeList(STORAGE_KEYS.termsTemplates, readList(STORAGE_KEYS.termsTemplates).filter(t => t.id !== id));
  },
};

/**
 * One-time merge of the old separate `purchaseCompanies` store into `companies`,
 * tagged with isSalesCompany/isPurchaseCompany flags. Guarded so it only ever runs once;
 * the old qb_purchaseCompanies key is left in place (unused) as an implicit safety net.
 */
function migrateCompaniesV2() {
  const FLAG = 'qb_companiesMigratedV2';
  if (localStorage.getItem(FLAG)) return;
  const companies = readList(STORAGE_KEYS.companies)
    .map(c => Object.assign({ isSalesCompany: true, isPurchaseCompany: false }, c));
  const purchaseCompanies = readList(STORAGE_KEYS.purchaseCompanies)
    .map(c => Object.assign({}, c, { isSalesCompany: false, isPurchaseCompany: true }));
  writeList(STORAGE_KEYS.companies, companies.concat(purchaseCompanies));
  localStorage.setItem(FLAG, '1');
}
migrateCompaniesV2();

/**
 * One-time seed of the Default Configurations tables (Units, GST Rates, Expense Categories)
 * with the values that used to be hardcoded <datalist> suggestions, so upgrading doesn't leave
 * any picker empty. Guarded so it only ever runs once. Terms & Conditions intentionally starts
 * empty — no legal text is fabricated on the user's behalf.
 */
function seedDefaultConfig() {
  const FLAG = 'qb_configSeeded';
  if (localStorage.getItem(FLAG)) return;
  if (!readList(STORAGE_KEYS.units).length) {
    writeList(STORAGE_KEYS.units, ['Kilogram', 'Gram', 'Liters', 'Numbers', 'Meters', 'Box', 'Dozen'].map(name => ({ id: uid(), name })));
  }
  if (!readList(STORAGE_KEYS.gstRates).length) {
    writeList(STORAGE_KEYS.gstRates, [5, 18, 28].map(value => ({ id: uid(), value })));
  }
  if (!readList(STORAGE_KEYS.expenseCategories).length) {
    writeList(STORAGE_KEYS.expenseCategories, ['Travel', 'Commission', 'Office Supplies', 'Utilities', 'Miscellaneous'].map(name => ({ id: uid(), name })));
  }
  localStorage.setItem(FLAG, '1');
}
seedDefaultConfig();

/* =====================================================================
   FILE-BACKED STORAGE (File System Access API)
   Data lives in a real file, Data/business-suite-data.json, instead of
   the browser's localStorage. A directory handle is remembered in
   IndexedDB purely as a pointer to that folder so the picker isn't
   re-shown on every load — the handle is not the data itself; all real
   data lives only in the JSON file on disk. Chrome/Edge only: browsers
   without the File System Access API show a permanent blocking message
   instead of falling back to localStorage.
===================================================================== */
const DATA_FILE_NAME = 'business-suite-data.json';
const SECRETS_FILE_NAME = 'business-suite-secrets.json';
/* Fixed, well-known location of the Data folder relative to index.html — see
   the "fetch-based fast path" in bootstrapDataSource() below. This assumes
   Data/ is served alongside index.html by the same static server (true for
   this project's layout); it's only ever used as a permission-free read
   shortcut, never as the sole source of truth. */
const DATA_DIR = 'Data/';
const HANDLE_DB_NAME = 'qb_fileHandleDB';
const HANDLE_STORE_NAME = 'handles';
const HANDLE_KEY = 'dataFolderHandle';

let resolveStoreReady;
Store.ready = new Promise((resolve) => { resolveStoreReady = resolve; });
Store.dataFileLabel = 'Not connected';

let currentFileHandle = null;
let writeQueue = Promise.resolve();

/* Secrets file (Data/business-suite-secrets.json, alongside the main data file) —
   holds only the Supabase connection config (URL/anon key/active-backend flag).
   Login credentials are NOT stored here: they live exclusively in Supabase Auth's
   own auth.users table, hashed by Supabase itself — never in this app's files. */
let secretsFileData = null;
let currentSecretsFileHandle = null;
let secretsWriteQueue = Promise.resolve();

function defaultSecrets() {
  return { dbConnection: { supabaseUrl: '', supabaseAnonKey: '', useSupabaseActive: false } };
}

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(HANDLE_STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSavedDirHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
      const req = tx.objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function saveDirHandle(handle) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
      tx.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to remember the data folder for next time', e);
  }
}

async function verifyReadWritePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/** Snapshot everything currently in localStorage (post migration/seed) for one-time
 *  migration into a freshly created data file. The legacy `purchaseCompanies` key is
 *  intentionally dropped — it's already unused, superseded by the merged `companies` list. */
function collectLocalStorageSnapshot() {
  const snapshot = {};
  Object.values(STORAGE_KEYS).forEach((key) => {
    if (key === STORAGE_KEYS.purchaseCompanies) return;
    const raw = localStorage.getItem(key);
    snapshot[key] = raw ? JSON.parse(raw) : (key === STORAGE_KEYS.profile ? null : []);
  });
  return snapshot;
}

function schedulePersist() {
  if (offlineBypassMode) {
    bypassModeHasUnsyncedChanges = true;
    notifyConnectivityChanged();
  }
  writeQueue = writeQueue.then(persistToFile);
}

async function persistToFile() {
  if (!currentFileHandle) { markUnsavedNoFolder(); return; }
  try {
    const writable = await currentFileHandle.createWritable();
    await writable.write(JSON.stringify(fileData, null, 2));
    await writable.close();
    setFileStatus('saved');
  } catch (e) {
    console.error('Failed to save the data file', e);
    setFileStatus('error');
  }
}

let unsavedNoFolderNotified = false;

/* Called instead of silently no-op'ing whenever a write can't be persisted
   because no folder is connected yet (the fetch-based read-only bootstrap,
   see bootstrapDataSource()). The edit already applied to fileData in
   memory — this just makes the "not saved to disk yet" state visible.
   Suppressed entirely while dataBackendMode === 'supabase': in that mode
   business data is never routed through persistToFile()/persistSecretsToFile()
   at all — writeList/writeObject send it straight to Supabase (see above) —
   so the only caller that can still reach here is SecretsStore.saveDbConnection's
   persistSecretsToFile(), persisting the local DB-connection config file, not
   business data. Surfacing "⚠️ Not saved — click to connect Data folder" in that
   case wrongly implied real data was at risk when it was already safely in the
   database, so the nudge only makes sense for the local-file backend. */
function markUnsavedNoFolder() {
  if (dataBackendMode === 'supabase') return;
  setFileStatus('unsaved');
  if (!unsavedNoFolderNotified) {
    unsavedNoFolderNotified = true;
    if (typeof toast === 'function') {
      toast('Changes aren\'t saved to a file yet — click the indicator above to connect your Data folder.');
    }
  }
}

/* The #dataFileIndicator button exists to surface *local-file* connection
   status ("Data File" in the Settings menu) — while dataBackendMode ===
   'supabase', business data lives in the database instead, and its status
   (connected/syncing/unreachable) already has its own dedicated home, the
   #dbConnectivityBanner (see updateConnectivityBanner() in app.js). Showing
   a static "☁️ Supabase (cloud)" button alongside that banner was redundant
   and, worse, implied the button's local-file actions (Switch Folder, etc.)
   were still the relevant thing to click. Hidden outright instead. */
function updateDataFileIndicatorVisibility() {
  const el = document.getElementById('dataFileIndicator');
  if (el) el.style.display = (dataBackendMode === 'supabase') ? 'none' : '';
}

function setFileStatus(status) {
  const el = document.getElementById('dataFileIndicator');
  if (!el) return;
  el.classList.toggle('data-file-error', status === 'error');
  el.classList.toggle('data-file-unsaved', status === 'unsaved');
  if (status === 'unsaved') {
    el.textContent = '⚠️ Not saved — click to connect Data folder';
    el.title = 'Changes are only in memory. Click to connect a Data folder and save them to a real file.';
  } else if (status === 'error') {
    el.title = 'Failed to save changes to the data file — check that the folder still exists and permission hasn’t been revoked.';
  } else {
    el.textContent = '📄 ' + Store.dataFileLabel;
    el.title = 'Click to view/switch your connected data file';
  }
}

/* `heading` is optional and only touches the card's <h2> when explicitly passed:
   omitted (the original folder-connect call sites in initFileStorage below) leaves
   whatever heading is already showing untouched — normally the HTML's default
   "Connect Your Data Folder". Passed as '' hides the heading entirely, for the
   generic post-folder "Loading…"/"Checking Database Connection" states where
   "Connect Your Data Folder" no longer applies and showing both looked like a
   mismatched two-line message ("Connect Your Data Folder - Checking Database
   Connection"). Passed as a non-empty string swaps in that heading instead. */
function showGate(message, showButton, heading) {
  const titleEl = document.getElementById('fileGateTitle');
  const msg = document.getElementById('fileGateMessage');
  const btn = document.getElementById('fileGateSelectBtn');
  if (heading !== undefined && titleEl) {
    titleEl.textContent = heading;
    titleEl.style.display = heading ? '' : 'none';
  }
  if (msg) msg.textContent = message;
  if (btn) btn.style.display = showButton ? 'inline-flex' : 'none';
}

function hideGate() {
  const overlay = document.getElementById('fileGateOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function connectDirHandle(dirHandle) {
  const granted = await verifyReadWritePermission(dirHandle);
  if (!granted) throw new Error('Permission to the selected folder was not granted.');
  const fileHandle = await dirHandle.getFileHandle(DATA_FILE_NAME, { create: true });
  const file = await fileHandle.getFile();
  const text = await file.text();
  let data;
  if (!text.trim()) {
    data = collectLocalStorageSnapshot();
  } else {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`"${DATA_FILE_NAME}" in that folder isn't valid JSON. Pick a different (or empty) folder.`);
    }
  }
  const wasEmpty = !text.trim();
  currentFileHandle = fileHandle;
  fileData = data;
  Store.dataFileLabel = dirHandle.name + '/' + DATA_FILE_NAME;
  if (wasEmpty) await persistToFile();

  // Same directory handle, same get-or-create pattern, for the secrets file.
  const secretsHandle = await dirHandle.getFileHandle(SECRETS_FILE_NAME, { create: true });
  const secretsFile = await secretsHandle.getFile();
  const secretsText = await secretsFile.text();
  let secrets;
  if (!secretsText.trim()) {
    secrets = defaultSecrets();
  } else {
    try {
      secrets = JSON.parse(secretsText);
    } catch (e) {
      throw new Error(`"${SECRETS_FILE_NAME}" in that folder isn't valid JSON. Pick a different (or empty) folder.`);
    }
  }
  currentSecretsFileHandle = secretsHandle;
  secretsFileData = secrets;
  if (!secretsText.trim()) await persistSecretsToFile();

  await saveDirHandle(dirHandle);
  const indicator = document.getElementById('dataFileIndicator');
  if (indicator) indicator.textContent = '📄 ' + Store.dataFileLabel;
}

function scheduleSecretsPersist() {
  secretsWriteQueue = secretsWriteQueue.then(persistSecretsToFile);
}

async function persistSecretsToFile() {
  if (!currentSecretsFileHandle) { markUnsavedNoFolder(); return; }
  try {
    const writable = await currentSecretsFileHandle.createWritable();
    await writable.write(JSON.stringify(secretsFileData, null, 2));
    await writable.close();
  } catch (e) {
    console.error('Failed to save the secrets file', e);
  }
}

async function fetchJsonNoThrow(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}

Store.isFolderConnected = function isFolderConnected() { return !!currentFileHandle; };

Store.setViewerMode = function setViewerMode(isViewer) { viewerMode = !!isViewer; };

Store.setDeleteRestricted = function setDeleteRestricted(isRestricted) { deleteRestricted = !!isRestricted; };

/* Called from app.js's runSupabaseResumeFailedGate() when the user explicitly
   chooses "Use Local Data File Instead" after a Database-flag-on Supabase
   resume failure — never invoked automatically/silently (see CLAUDE.md's
   "Access control & Supabase" section). Session-only: does not touch the
   saved useSupabaseActive flag, so the app tries Supabase again next reload.
   Mirrors the normal fetch fast-path's own read-only fallback shape exactly
   (fetchJsonNoThrow then collectLocalStorageSnapshot()) — actual writes are
   already handled by the existing lazy write-time folder-connect flow the
   moment an edit is made with no folder connected yet, so nothing new is
   needed here for "Read/Write" to work, only for the initial read. */
Store.recoverToLocalFileAfterSupabaseFailure = async function recoverToLocalFileAfterSupabaseFailure() {
  dataBackendMode = 'file';
  updateDataFileIndicatorVisibility();
  const fetchedData = await fetchJsonNoThrow(DATA_DIR + DATA_FILE_NAME);
  fileData = fetchedData || collectLocalStorageSnapshot();
  Store.dataFileLabel = DATA_DIR + DATA_FILE_NAME + ' (read-only — Supabase unreachable; connect a folder to save changes)';
  const indicator = document.getElementById('dataFileIndicator');
  if (indicator) indicator.textContent = '👁️ ' + Store.dataFileLabel;
};

/* Called from app.js's runDatabaseConnectivityGate() when the *pre-login*
   connectivity check fails and the user explicitly chooses "Load from Data
   File" — distinct from recoverToLocalFileAfterSupabaseFailure() above, which
   only ever runs *after* a successful login. This one skips login entirely for
   the session (see CLAUDE.md) — currentUser is deliberately left null; the
   existing null-safe defaults in blockIfViewer()/blockDeleteIfNotAdmin() already
   degrade sensibly (not treated as a viewer, but treated as non-admin, so
   Delete stays blocked by default). Never touches the saved useSupabaseActive
   flag — Supabase is tried again normally on the next reload. */
Store.enterOfflineBypassMode = async function enterOfflineBypassMode() {
  dataBackendMode = 'file';
  offlineBypassMode = true;
  bypassModeHasUnsyncedChanges = false;
  const fetchedData = await fetchJsonNoThrow(DATA_DIR + DATA_FILE_NAME);
  fileData = fetchedData || collectLocalStorageSnapshot();
  Store.dataFileLabel = DATA_DIR + DATA_FILE_NAME + ' (offline — not connected to the database)';
  notifyConnectivityChanged();
};

/* Called once the user completes "Log In & Sync" (app.js) — a real session now
   exists, so the offline-bypass framing no longer applies, whether or not they
   actually chose to push their local changes up to Supabase in that same flow. */
Store.clearOfflineBypassMode = function clearOfflineBypassMode() {
  offlineBypassMode = false;
  bypassModeHasUnsyncedChanges = false;
  notifyConnectivityChanged();
};

/* Single read for the DB connectivity banner (app.js) — keeps state ownership
   here and rendering in app.js, matching how Store.dataFileLabel/setFileStatus()
   already split those concerns for the file backend. */
Store.getConnectivityStatus = function getConnectivityStatus() {
  return {
    mode: dataBackendMode,
    offlineBypass: offlineBypassMode,
    bypassHasUnsynced: bypassModeHasUnsyncedChanges,
    supabaseHealthy,
    pendingCount: pendingRetryKeys.size,
  };
};

/* Permission-free fast path: Data/ is served alongside index.html by the same
   static server, so its files are reachable via a plain same-origin fetch —
   no File System Access permission involved. This is a read-only shortcut
   only: `currentFileHandle`/`currentSecretsFileHandle` stay null, so writes
   still have nowhere to persist until Store.connectFolderToSave() runs (see
   below) — the four choke-point primitives already handle that gracefully.
   Falls back to the folder-first initFileStorage() flow only when the
   secrets file can't be fetched at all (a genuinely fresh install with
   nothing in Data/ yet), since there's no way to persist a first-time
   Supabase config without folder write access. */
async function bootstrapDataSource() {
  const fetchedSecrets = await fetchJsonNoThrow(DATA_DIR + SECRETS_FILE_NAME);
  if (!fetchedSecrets) {
    await initFileStorage();
    return;
  }

  secretsFileData = fetchedSecrets;

  const useSupabase = !!(fetchedSecrets.dbConnection && fetchedSecrets.dbConnection.useSupabaseActive);
  if (useSupabase) {
    Store.dataFileLabel = 'Supabase (cloud)';
  } else {
    const fetchedData = await fetchJsonNoThrow(DATA_DIR + DATA_FILE_NAME);
    fileData = fetchedData || collectLocalStorageSnapshot();
    Store.dataFileLabel = DATA_DIR + DATA_FILE_NAME + ' (read-only — not yet connected)';
  }

  const indicator = document.getElementById('dataFileIndicator');
  if (indicator) indicator.textContent = (useSupabase ? '☁️ ' : '👁️ ') + Store.dataFileLabel;

  /* Deliberately not hideGate() here: the Supabase setup/connectivity/login
     gates in app.js still need to run before real app content should show.
     Keeping this overlay up (message updated to a neutral "Loading…") avoids
     a flash of the raw, unrendered app underneath while those async checks
     run — app.js calls hideGate() itself once the whole chain resolves. */
  showGate('Loading…', false, '');
  resolveStoreReady();
}

async function initFileStorage() {
  if (typeof window.showDirectoryPicker !== 'function') {
    showGate('This app stores its data in a real local file using a browser feature (the File System Access API) available only in Google Chrome and Microsoft Edge. Please reopen this app in Chrome or Edge to continue.', false);
    return; // Store.ready is intentionally never resolved
  }

  showGate('Checking for a previously connected data folder…', false);
  const remembered = await getSavedDirHandle();
  if (remembered) {
    try {
      await connectDirHandle(remembered);
      showGate('Loading…', false, ''); // see bootstrapDataSource's fast path for why this isn't hideGate()
      resolveStoreReady();
      return;
    } catch (e) {
      console.warn('Could not reconnect to the remembered data folder', e);
    }
  }

  showGate('Select (or create) the "Data" folder inside this project to store your business data in a real file, independent of the browser.', true);
  document.getElementById('fileGateSelectBtn').addEventListener('click', async () => {
    try {
      showGate('Waiting for folder selection…', false);
      const dirHandle = await window.showDirectoryPicker({ id: 'business-suite-data', mode: 'readwrite' });
      await connectDirHandle(dirHandle);
      showGate('Loading…', false, ''); // see bootstrapDataSource's fast path for why this isn't hideGate()
      resolveStoreReady();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        showGate('Select (or create) the "Data" folder inside this project to store your business data in a real file, independent of the browser.', true);
        return;
      }
      console.error(e);
      showGate('Could not connect to that folder: ' + (e.message || e) + ' Please try again.', true);
    }
  });
}

Store.switchDataFolder = async function switchDataFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ id: 'business-suite-data', mode: 'readwrite' });
    await connectDirHandle(dirHandle);
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
    console.error(e);
    throw e;
  }
};

let connectFolderToSavePromise = null;

/** Used when the app is running off the fetch-based read-only bootstrap (see
 *  bootstrapDataSource()) and a write needs somewhere to persist to. Unlike
 *  connectDirHandle (which reads the chosen folder's file OVER the in-memory
 *  copy), this writes the CURRENT in-memory fileData/secretsFileData INTO the
 *  chosen folder — preserving whatever was fetched plus any edits made while
 *  read-only, rather than discarding them. Returns false if the picker is
 *  cancelled, true on success. */
Store.connectFolderToSave = async function connectFolderToSave() {
  if (currentFileHandle) return true;
  if (connectFolderToSavePromise) return connectFolderToSavePromise;
  connectFolderToSavePromise = (async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({ id: 'business-suite-data', mode: 'readwrite' });
      const granted = await verifyReadWritePermission(dirHandle);
      if (!granted) throw new Error('Permission to the selected folder was not granted.');

      const fileHandle = await dirHandle.getFileHandle(DATA_FILE_NAME, { create: true });
      currentFileHandle = fileHandle;
      if (!fileData) fileData = collectLocalStorageSnapshot();
      Store.dataFileLabel = dirHandle.name + '/' + DATA_FILE_NAME;
      await persistToFile();

      const secretsHandle = await dirHandle.getFileHandle(SECRETS_FILE_NAME, { create: true });
      currentSecretsFileHandle = secretsHandle;
      if (!secretsFileData) secretsFileData = defaultSecrets();
      await persistSecretsToFile();

      await saveDirHandle(dirHandle);
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      console.error(e);
      throw e;
    }
  })();
  try {
    return await connectFolderToSavePromise;
  } finally {
    connectFolderToSavePromise = null;
  }
};

/* =====================================================================
   SECRETS STORE — Supabase connection config only (no credentials; see
   the comment above `secretsFileData`). Async (unlike the rest of `Store`)
   since saving/reading the anon key goes through js/crypto.js's Web Crypto
   calls — an isolated, deliberate exception to Store's synchronous
   convention, matching how Store.switchDataFolder is already async.
===================================================================== */
const SecretsStore = {
  async getDbConnection() {
    const cfg = (secretsFileData && secretsFileData.dbConnection) || defaultSecrets().dbConnection;
    return {
      supabaseUrl: cfg.supabaseUrl || '',
      supabaseAnonKey: cfg.supabaseAnonKey ? await decryptSecret(cfg.supabaseAnonKey) : '',
      useSupabaseActive: !!cfg.useSupabaseActive,
    };
  },
  async saveDbConnection({ supabaseUrl, supabaseAnonKey, useSupabaseActive }) {
    if (!secretsFileData) secretsFileData = defaultSecrets();
    secretsFileData.dbConnection = {
      supabaseUrl: supabaseUrl || '',
      supabaseAnonKey: supabaseAnonKey ? await encryptSecret(supabaseAnonKey) : '',
      useSupabaseActive: !!useSupabaseActive,
    };
    scheduleSecretsPersist();
  },
};

/* =====================================================================
   SUPABASE DATA BACKEND (pilot) — a third backend for the same four
   choke-point primitives above. `business_data` is a generic key/value
   table (one row per STORAGE_KEYS entry) mirroring `fileData` 1:1, so no
   per-entity schema/queries are needed. Protected by RLS requiring a real
   authenticated session (see CLAUDE.md) — these calls only succeed once
   the user has logged in via SupabaseClient.
===================================================================== */
let supabaseWriteQueue = Promise.resolve();

/* Connectivity tracking for the DB connectivity banner (see CLAUDE.md) —
   `syncedSupabaseData` mirrors `supabaseData` but only for list-type keys whose
   last persist attempt actually succeeded; `pendingRetryKeys` is every key
   (list or object) with at least one unconfirmed change. The gap between
   `syncedSupabaseData[key]` and `supabaseData[key]` is exactly "what hasn't
   reached the server yet," and is what a retry re-diffs against. */
let syncedSupabaseData = {};
let pendingRetryKeys = new Set();
let supabaseHealthy = true;
let connectivityPollTimer = null;

/* Set once by Store.enterOfflineBypassMode() when the pre-login connectivity
   check fails and the user chooses to work offline for this session — see
   app.js's runDatabaseConnectivityGate(). Never set for the ordinary
   already-logged-in mid-session outage path (that's pendingRetryKeys above). */
let offlineBypassMode = false;
let bypassModeHasUnsyncedChanges = false;

function notifyConnectivityChanged() {
  updateDataFileIndicatorVisibility();
  if (typeof updateConnectivityBanner === 'function') updateConnectivityBanner();
}

function scheduleSupabasePersist(key, oldList, newList) {
  supabaseWriteQueue = supabaseWriteQueue.then(() => persistKeyToSupabase(key, oldList, newList));
}

/** Id-level diff between two lists of records with an `id` field: `upserts` are
 *  records that are new or changed in `newList`, `deletedIds` are ids present in
 *  `oldList` but missing from `newList`. Used so a Supabase write can apply just
 *  the one intended change onto the freshest server copy instead of blindly
 *  overwriting with a possibly-stale in-memory list (see persistKeyToSupabase). */
function diffListsById(oldList, newList) {
  const oldById = new Map(oldList.map(r => [r.id, r]));
  const newIds = new Set(newList.map(r => r.id));
  const upserts = newList.filter(r => {
    const prev = oldById.get(r.id);
    return !prev || JSON.stringify(prev) !== JSON.stringify(r);
  });
  const deletedIds = oldList.filter(r => !newIds.has(r.id)).map(r => r.id);
  return { upserts, deletedIds };
}

/** For a list-type key (oldList/newList both arrays — see writeList), every
 *  Store.saveX()/deleteX() call already flattens its one intended change into a
 *  full replacement array, so persisting that array as-is would silently
 *  overwrite anything another session saved to a *different* record of the same
 *  entity type in the meantime. Instead, re-fetch the freshest server copy and
 *  apply only the id-level diff this write actually intended (see
 *  diffListsById) onto it, then persist and cache *that* reconciled result —
 *  which also has the side effect of healing this session's in-memory copy with
 *  anyone else's concurrent changes it wouldn't otherwise see until the next
 *  tab refresh. For an object-type key (oldList/newList undefined — profile,
 *  a singleton with no per-record concept), falls back to the previous
 *  plain-overwrite behavior unchanged. */
async function persistKeyToSupabase(key, oldList, newList) {
  const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
  if (!client) return;
  try {
    if (Array.isArray(oldList) && Array.isArray(newList)) {
      const { data: row, error: fetchError } = await client.from('business_data').select('value').eq('key', key).maybeSingle();
      if (fetchError) throw fetchError;
      const freshList = Array.isArray(row && row.value) ? row.value : [];
      const { upserts, deletedIds } = diffListsById(oldList, newList);
      const deletedSet = new Set(deletedIds);
      const upsertIds = new Set(upserts.map(r => r.id));
      const reconciled = freshList.filter(r => !deletedSet.has(r.id) && !upsertIds.has(r.id)).concat(upserts);
      supabaseData[key] = reconciled;
      const { error } = await client.from('business_data').upsert({ key, value: reconciled, updated_at: new Date().toISOString() });
      if (error) {
        ErrorLog.record('Failed to sync "' + key + '" to Supabase', error, { source: 'persistKeyToSupabase' });
        pendingRetryKeys.add(key);
      } else {
        syncedSupabaseData[key] = reconciled;
        pendingRetryKeys.delete(key);
      }
      notifyConnectivityChanged();
      return;
    }
    const value = supabaseData[key] !== undefined ? supabaseData[key] : null;
    const { error } = await client.from('business_data').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) {
      ErrorLog.record('Failed to sync "' + key + '" to Supabase', error, { source: 'persistKeyToSupabase' });
      pendingRetryKeys.add(key);
    } else {
      pendingRetryKeys.delete(key);
    }
    notifyConnectivityChanged();
  } catch (e) {
    ErrorLog.record('Failed to sync "' + key + '" to Supabase', e, { source: 'persistKeyToSupabase' });
    pendingRetryKeys.add(key);
    notifyConnectivityChanged();
  }
}

async function fetchSupabaseKeysBatch(keys) {
  const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
  if (!client) throw new Error('Supabase is not connected.');
  const { data, error } = await client.from('business_data').select('key, value').in('key', keys);
  if (error) {
    ErrorLog.record('Failed to fetch data from Supabase', error, { source: 'fetchSupabaseKeysBatch', details: 'keys: ' + keys.join(', ') });
    throw error;
  }
  const map = {};
  (data || []).forEach((row) => { map[row.key] = row.value; });
  return map;
}

/* Routed through the admin_push_business_data RPC (SECURITY DEFINER, re-checks
   is_admin server-side) rather than a direct multi-row upsert against
   business_data — a raw upsert here was only ever gated by the DB Connection
   modal's client-side "admins only" check, which a regular logged-in User
   could bypass entirely via devtools and overwrite every row of shared cloud
   data. Normal per-record CRUD (Store.saveX/deleteX) is unaffected — it still
   goes straight to business_data under the existing RLS, unchanged; only this
   deliberate "overwrite everything" bulk action is now truly admin-only. */
async function pushAllBusinessDataToSupabase() {
  const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
  if (!client) throw new Error('Supabase is not connected.');
  const snapshot = fileData || collectLocalStorageSnapshot();
  const rows = ALL_BUSINESS_DATA_KEYS.map((key) => ({ key, value: snapshot[key] !== undefined ? snapshot[key] : null }));
  const { error } = await client.rpc('admin_push_business_data', { p_rows: rows });
  if (error) {
    ErrorLog.record('Failed to push local data to Supabase', error, { source: 'pushAllBusinessDataToSupabase' });
    throw error;
  }
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return map;
}

/* Admin-only "download latest DB snapshot" button (js/app.js, next to Export
   in the header). Deliberately independent of dataBackendMode — always reads
   straight from Supabase's business_data table regardless of whether the
   app's *active* backend is currently 'file' or 'supabase', so an admin can
   pull a fresh backup of what's actually in the database without switching
   the whole session's data source over just to do it. Returns a plain object
   shaped exactly like business-suite-data.json (one property per storage
   key), ready to be downloaded as-is. Throws (surfaced as a toast by
   withErrorToast) if Supabase isn't configured/reachable or the session
   isn't authenticated — same failure mode fetchSupabaseKeysBatch already
   has for every other caller. */
Store.fetchLatestDataFromSupabase = async function fetchLatestDataFromSupabase() {
  const map = await fetchSupabaseKeysBatch(ALL_BUSINESS_DATA_KEYS);
  const snapshot = {};
  ALL_BUSINESS_DATA_KEYS.forEach((key) => {
    snapshot[key] = map[key] !== undefined ? map[key] : (key === STORAGE_KEYS.profile ? null : []);
  });
  return snapshot;
};

Store.getDataBackendMode = function getDataBackendMode() { return dataBackendMode; };

/** reconcileMode: 'push' (local file's current data replaces Supabase's — since
 *  it all comes from fileData, already fully in memory, every key is loaded) or
 *  'pull' (Supabase's current data replaces the in-memory active copy — only the
 *  small "core" keys are fetched eagerly; the transactional + companies/products
 *  keys are left for Store.refreshSupabaseKeys() to fetch fresh on each tab
 *  visit). */
Store.activateSupabaseBackend = async function activateSupabaseBackend(reconcileMode) {
  let map;
  if (reconcileMode === 'push') map = await pushAllBusinessDataToSupabase();
  else if (reconcileMode === 'pull') map = await fetchSupabaseKeysBatch(CORE_SUPABASE_KEYS);
  else throw new Error('Unknown reconcile mode: ' + reconcileMode);
  supabaseData = map;
  // Whatever was just pushed/pulled is, by definition, the confirmed server
  // state right now — seed the sync baseline to match so the very next write
  // diffs against reality instead of an empty baseline (which would otherwise
  // treat every existing record as a fresh upsert on the first write).
  syncedSupabaseData = Object.assign({}, map);
  pendingRetryKeys.clear();
  dataBackendMode = 'supabase';
  updateDataFileIndicatorVisibility();
  const cfg = await SecretsStore.getDbConnection();
  await SecretsStore.saveDbConnection(Object.assign({}, cfg, { useSupabaseActive: true }));
  startConnectivityPolling();
};

/* Called from js/app.js's activateTab() before rendering a tab that depends on
   one or more of TAB_LAZY_KEYS, so those tabs always show the current Supabase
   state rather than a session-stale snapshot (see "Always-fresh data on tab
   selection" in CLAUDE.md) — always refetches, no caching. No-ops instantly for
   the file backend, which is what lets app.js call this unconditionally without
   branching on backend mode. */
Store.refreshSupabaseKeys = async function refreshSupabaseKeys(keys) {
  if (dataBackendMode !== 'supabase') return;
  // Never refetch a key with an unconfirmed local change still pending retry —
  // the server's copy is known-stale relative to what's in memory, and
  // overwriting supabaseData[key] with it would silently discard the user's
  // own not-yet-synced edit from view (the retry queue would still hold it,
  // but it would vanish from every rendered table until the retry lands).
  const keysToFetch = keys.filter((k) => !pendingRetryKeys.has(k));
  if (!keysToFetch.length) return;
  const map = await fetchSupabaseKeysBatch(keysToFetch);
  Object.assign(supabaseData, map);
  Object.assign(syncedSupabaseData, map);
};

Store.deactivateSupabaseBackend = async function deactivateSupabaseBackend() {
  dataBackendMode = 'file';
  updateDataFileIndicatorVisibility();
  stopConnectivityPolling();
  pendingRetryKeys.clear();
  syncedSupabaseData = {};
  const cfg = await SecretsStore.getDbConnection();
  await SecretsStore.saveDbConnection(Object.assign({}, cfg, { useSupabaseActive: false }));
};

/* Periodic health check + retry trigger for the DB connectivity banner. Reuses
   the real authenticated client (not the throwaway one Store.testSupabaseConnection
   uses for the DB Connection modal's manual test) so a cheap read against the
   actual RLS-protected table is a meaningful signal of "would my real operations
   work right now," not just raw network reachability. When a poll succeeds and
   there are pending (failed-then-queued) keys, re-attempts each of them. */
async function pollSupabaseConnectivity() {
  if (dataBackendMode !== 'supabase') return;
  const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
  if (!client) return;
  let healthy = false;
  try {
    const { error } = await client.from('business_data').select('key').limit(1);
    healthy = !error;
  } catch (e) {
    healthy = false;
  }
  supabaseHealthy = healthy;
  if (healthy && pendingRetryKeys.size > 0) {
    Array.from(pendingRetryKeys).forEach((key) => {
      scheduleSupabasePersist(key, syncedSupabaseData[key] || [], supabaseData[key] || []);
    });
  }
  notifyConnectivityChanged();
}

const CONNECTIVITY_POLL_INTERVAL_MS = 20000;

function startConnectivityPolling() {
  if (connectivityPollTimer) return;
  connectivityPollTimer = setInterval(pollSupabaseConnectivity, CONNECTIVITY_POLL_INTERVAL_MS);
  pollSupabaseConnectivity();
}

function stopConnectivityPolling() {
  if (connectivityPollTimer) {
    clearInterval(connectivityPollTimer);
    connectivityPollTimer = null;
  }
}

/** Reachability check shared by the DB Connection modal's "Test Connection" button
 *  and the proactive pre-login connectivity gate. Uses a throwaway, unauthenticated
 *  client — the anon role has no grant at all on business_data (only `authenticated`
 *  does, see CLAUDE.md), so a healthy project always answers an anon select with a
 *  specific "42501 permission denied for table business_data" error. That exact
 *  signature is the one error that still counts as "reached Supabase" — anything
 *  else (a wrong/invalid key, a paused or genuinely down project, a network/DNS
 *  failure) means this check can't tell "healthy but anon-blocked" apart from
 *  "actually unreachable," so it must be treated as unreachable. A prior version
 *  treated ANY returned error as "reached," which meant a paused project (which
 *  still answers with *some* error response rather than a network exception) was
 *  silently misreported as healthy — masking the pre-login connectivity gate. */
Store.testSupabaseConnection = async function testSupabaseConnection(url, anonKey) {
  try {
    const client = supabase.createClient(url, anonKey);
    const { error } = await client.from('business_data').select('key').limit(1);
    if (!error) {
      return { ok: true, message: 'Connected successfully.' };
    }
    if (error.code === '42501') {
      return { ok: true, message: 'Reached Supabase (server responded: ' + error.message + '). This is expected before logging in.' };
    }
    return { ok: false, message: 'Could not reach Supabase: ' + error.message };
  } catch (e) {
    ErrorLog.record('Could not reach Supabase', e, { source: 'testSupabaseConnection' });
    return { ok: false, message: 'Could not reach Supabase: ' + (e.message || e) };
  }
};

bootstrapDataSource();
