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

function readList(key) {
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
  if (fileData) { fileData[key] = list; schedulePersist(); return; }
  localStorage.setItem(key, JSON.stringify(list));
}

function readObject(key, fallback) {
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
const HANDLE_DB_NAME = 'qb_fileHandleDB';
const HANDLE_STORE_NAME = 'handles';
const HANDLE_KEY = 'dataFolderHandle';

let resolveStoreReady;
Store.ready = new Promise((resolve) => { resolveStoreReady = resolve; });
Store.dataFileLabel = 'Not connected';

let currentFileHandle = null;
let writeQueue = Promise.resolve();

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
  writeQueue = writeQueue.then(persistToFile);
}

async function persistToFile() {
  if (!currentFileHandle) return;
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

function setFileStatus(status) {
  const el = document.getElementById('dataFileIndicator');
  if (!el) return;
  el.classList.toggle('data-file-error', status === 'error');
  el.title = status === 'error'
    ? 'Failed to save changes to the data file — check that the folder still exists and permission hasn’t been revoked.'
    : 'Click to view/switch your connected data file';
}

function showGate(message, showButton) {
  const msg = document.getElementById('fileGateMessage');
  const btn = document.getElementById('fileGateSelectBtn');
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
  await saveDirHandle(dirHandle);
  const indicator = document.getElementById('dataFileIndicator');
  if (indicator) indicator.textContent = '📄 ' + Store.dataFileLabel;
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
      hideGate();
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
      hideGate();
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

initFileStorage();
