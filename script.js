const DB_NAME = 'expenditure-db';
const DB_VERSION = 4;
let db;
const LOCK_TIMEOUT = 30 * 60 * 1000;
let lastActivity = Date.now();
let autoLockInterval = null;

if (window.location.hostname === '127.0.0.1' || window.location.hostname === '0.0.0.0') {
  window.location.replace('http://localhost:' + window.location.port);
}

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('incomes')) {
        database.createObjectStore('incomes', { keyPath: 'id', autoIncrement: true });
      }
      if (!database.objectStoreNames.contains('expenses')) {
        database.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
      }
      if (!database.objectStoreNames.contains('_crypto')) {
        database.createObjectStore('_crypto');
      }
      if (!database.objectStoreNames.contains('_prf')) {
        database.createObjectStore('_prf');
      }
    };
  });
}

function deleteEncryptionKey() {
  return new Promise((resolve, reject) => {
    const t = db.transaction('_crypto', 'readwrite');
    const r = t.objectStore('_crypto').delete('encryption-key');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

let worker = null;
let msgId = 0;
const pendingRequests = new Map();

function initWorker() {
  try {
    worker = new Worker('crypto-worker.js');
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if (ok) pending.resolve(result);
        else pending.reject(new Error(error || 'Worker error'));
      }
    };
    worker.onerror = (err) => {
      console.error('Crypto worker error:', err);
      scheduleWorkerRestart();
    };
  } catch (err) {
    console.error('Failed to create crypto worker:', err);
  }
}

let workerRestartTimer = null;
let workerRestartCount = 0;
const MAX_WORKER_RESTARTS = 3;

function scheduleWorkerRestart() {
  if (workerRestartTimer) return;
  if (workerRestartCount >= MAX_WORKER_RESTARTS) {
    console.error('Crypto worker failed to start after', MAX_WORKER_RESTARTS, 'attempts');
    return;
  }
  workerRestartCount++;
  workerRestartTimer = setTimeout(() => {
    workerRestartTimer = null;
    terminateWorker();
    initWorker();
  }, 2000);
}

function terminateWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error('Worker terminated'));
    pendingRequests.delete(id);
  }
}

function postToWorker(type, data, transfer) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Worker not available'));
      return;
    }
    const id = ++msgId;
    pendingRequests.set(id, { resolve, reject });
    if (transfer) {
      worker.postMessage({ id, type, data }, transfer);
    } else {
      worker.postMessage({ id, type, data });
    }
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Worker request timed out'));
      }
    }, 10000);
  });
}

function loadPrfData() {
  return new Promise((resolve, reject) => {
    const t = db.transaction('_prf', 'readonly');
    const r = t.objectStore('_prf').get('prf-data');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function savePrfData(data) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('_prf', 'readwrite');
    const r = t.objectStore('_prf').put(data, 'prf-data');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

function deletePrfData() {
  return new Promise((resolve, reject) => {
    const t = db.transaction('_prf', 'readwrite');
    const r = t.objectStore('_prf').delete('prf-data');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function hasEncryptionKey() {
  const prfData = await loadPrfData();
  if (prfData) return true;
  const result = await postToWorker('has-key');
  return result.ok;
}

async function usePrfFlow() {
  const prfData = await loadPrfData();
  return !!prfData;
}

async function addItem(storeName, data) {
  const payload = await postToWorker('encrypt', data);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.add(payload);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllItems(storeName) {
  const items = await new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (items.length === 0) return [];
  if (items[0].iv) {
    return Promise.all(items.map(async item => {
      const data = await postToWorker('decrypt', { iv: new Uint8Array(item.iv), data: new Uint8Array(item.data) });
      data.id = item.id;
      return data;
    }));
  }
  return items;
}

function deleteItem(storeName, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function updateItem(storeName, data) {
  const id = data.id;
  const clear = { ...data };
  delete clear.id;
  const payload = { id, ...await postToWorker('encrypt', clear) };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(payload);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function clearStore(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function webauthnRpId() {
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === '0.0.0.0') return 'localhost';
  return host;
}

function webauthnAvailable() {
  if (!window.PublicKeyCredential) return { ok: false, reason: 'WebAuthn is not supported in this browser.' };
  const host = window.location.hostname;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && host !== '127.0.0.1') {
    return { ok: false, reason: 'WebAuthn requires a domain name. Use http://localhost:8080 instead of http://' + host + ':8080.' };
  }
  if (host === '127.0.0.1' || host === '0.0.0.0') {
    return { ok: true, redirect: 'http://localhost:' + window.location.port };
  }
  if (window.location.protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1') {
    return { ok: false, reason: 'WebAuthn requires HTTPS or localhost.' };
  }
  return { ok: true };
}

async function createCredential() {
  return navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Expenditure', id: webauthnRpId() },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'expenditure-user',
        displayName: 'Expenditure'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required'
      },
      timeout: 60000
    }
  });
}

async function createCredentialWithPrf() {
  return navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Expenditure', id: webauthnRpId() },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'expenditure-user',
        displayName: 'Expenditure'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required'
      },
      timeout: 60000,
      extensions: {
        prf: {}
      }
    }
  });
}

async function authenticate() {
  return navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: webauthnRpId(),
      userVerification: 'required'
    },
    mediation: 'required'
  });
}

const balanceAmountEl = document.getElementById('balanceAmount');
const balanceLabelText = document.getElementById('balanceLabelText');
const balanceSubtitleEl = document.getElementById('balanceSubtitle');
const healthProgressEl = document.getElementById('healthProgress');
const healthPercentEl = document.getElementById('healthPercent');
const healthStatusEl = document.getElementById('healthStatus');
const totalIncomeEl = document.getElementById('totalIncome');
const totalExpensesEl = document.getElementById('totalExpenses');
const incomeListEl = document.getElementById('incomeList');
const expenseListEl = document.getElementById('expenseList');
const expenseCountEl = document.getElementById('expenseCount');
const paidStatEl = document.getElementById('paidStat');
const pendingStatEl = document.getElementById('pendingStat');
const missedStatEl = document.getElementById('missedStat');
const incomeModal = document.getElementById('incomeModal');
const expenseModal = document.getElementById('expenseModal');
const importModal = document.getElementById('importModal');
const incomeForm = document.getElementById('incomeForm');
const expenseForm = document.getElementById('expenseForm');
const importForm = document.getElementById('importForm');
const deleteModal = document.getElementById('deleteModal');
const deleteMessage = document.getElementById('deleteMessage');
const settingsModal = document.getElementById('settingsModal');
const toastContainer = document.getElementById('toastContainer');
const currentDateEl = document.getElementById('currentDate');
const lockOverlay = document.getElementById('lockOverlay');
const lockTitle = document.getElementById('lockTitle');
const lockSubtitle = document.getElementById('lockSubtitle');
const lockError = document.getElementById('lockError');
const unlockBtn = document.getElementById('unlockBtn');

let editingExpenseId = null;

const today = new Date();
const isMobile = window.innerWidth <= 480;
const dateStr = today.toLocaleDateString('en-US', isMobile
  ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
  : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
);
currentDateEl.textContent = dateStr;

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getStatusInfo(exp) {
  if (exp.status === 'paid') return { label: 'Paid', cls: 'paid' };
  if (exp.status === 'missed') return { label: 'Missed', cls: 'missed' };
  const now = new Date();
  const dueDate = new Date(exp.date);
  const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { label: 'Missed', cls: 'missed' };
  if (diffDays <= 3) return { label: 'Pending', cls: 'pending-soon' };
  return { label: 'Pending', cls: 'pending-far' };
}

function sanitizeInput(str) {
  return String(str).replace(/[<>&"']/g, function (m) {
    switch (m) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&#x27;';
      default: return m;
    }
  });
}

function sanitizeObject(obj) {
  const out = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      out[key] = typeof obj[key] === 'string' ? sanitizeInput(obj[key]) : obj[key];
    }
  }
  return out;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = type === 'success' ? '\u2713' : '\u2715';

  const text = document.createElement('span');
  text.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(text);
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

function createIncomeItem(inc) {
  const item = document.createElement('div');
  item.className = 'item';

  const info = document.createElement('div');
  info.className = 'item-info';

  const name = document.createElement('div');
  name.className = 'item-name';
  name.textContent = inc.source;

  const date = document.createElement('div');
  date.className = 'item-date';
  date.textContent = formatDate(inc.date);

  info.appendChild(name);
  info.appendChild(date);

  const amount = document.createElement('div');
  amount.className = 'item-amount income';

  const amtSpan = document.createElement('span');
  amtSpan.textContent = formatCurrency(inc.amount);

  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.dataset.deleteIncome = inc.id;
  delBtn.title = 'Delete';
  delBtn.textContent = '\u2715';

  amount.appendChild(amtSpan);
  amount.appendChild(delBtn);

  item.appendChild(info);
  item.appendChild(amount);

  return item;
}

function createExpenseItem(exp) {
  const status = getStatusInfo(exp);
  const itemCls = showCriticalBorder ? (status.cls === 'pending-soon' ? 'warning' : status.cls === 'missed' ? 'critical' : '') : '';

  const item = document.createElement('div');
  item.className = 'item' + (itemCls ? ' ' + itemCls : '');

  const info = document.createElement('div');
  info.className = 'item-info';

  const name = document.createElement('div');
  name.className = 'item-name';
  name.textContent = exp.description;

  const date = document.createElement('div');
  date.className = 'item-date';
  date.textContent = formatDate(exp.date);

  info.appendChild(name);
  info.appendChild(date);

  const amount = document.createElement('div');
  amount.className = 'item-amount expense';

  if (showExpenseCategory) {
    const catTag = document.createElement('span');
    catTag.className = 'category-tag';
    catTag.textContent = exp.category;
    amount.appendChild(catTag);
  } else {
    const statusTag = document.createElement('span');
    statusTag.className = 'status-tag ' + status.cls;
    statusTag.textContent = status.label;
    amount.appendChild(statusTag);
  }

  const amtToggle = document.createElement('span');
  amtToggle.className = 'amount-toggle';
  amtToggle.textContent = showExpensePercent
    ? (totalExpenseForPct > 0 ? Math.round((exp.amount / totalExpenseForPct) * 100) + '%' : '0%')
    : formatCurrency(exp.amount);

  const editBtn = document.createElement('button');
  editBtn.className = 'delete-btn';
  editBtn.dataset.editExpense = exp.id;
  editBtn.title = 'Edit';
  editBtn.textContent = '\u270E';

  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.dataset.deleteExpense = exp.id;
  delBtn.title = 'Delete';
  delBtn.textContent = '\u2715';

  amount.appendChild(amtToggle);
  amount.appendChild(editBtn);
  amount.appendChild(delBtn);

  item.appendChild(info);
  item.appendChild(amount);

  return item;
}

let totalExpenseForPct = 0;

async function updateUI() {
  const incomes = await getAllItems('incomes');
  const expenses = await getAllItems('expenses');
  incomesCache = incomes;
  expensesCache = expenses;

  const totalIncome = incomes.reduce((sum, inc) => sum + inc.amount, 0);
  const totalExpense = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const balance = totalIncome - totalExpense;

  const paidExpenses = expenses.filter(e => e.status === 'paid');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const pendingExpenses = expenses.filter(e => e.status === 'pending' && new Date(e.date) >= now);
  const missedExpenses = expenses.filter(e => e.status === 'missed' || (e.status === 'pending' && new Date(e.date) < now));
  const totalPaid = paidExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalPending = pendingExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalMissed = missedExpenses.reduce((sum, e) => sum + e.amount, 0);

  if (balanceViewMode === 'pending') {
    balanceLabelText.textContent = 'Pending Expenses';
    balanceAmountEl.textContent = formatCurrency(totalPending);
    balanceAmountEl.className = 'balance-amount';
    if (totalPending > 0) balanceAmountEl.classList.add('pending');
    else balanceAmountEl.classList.add('zero');
    balanceSubtitleEl.textContent = '';
    balanceSubtitleEl.title = '';
  } else if (balanceViewMode === 'paid') {
    balanceLabelText.textContent = 'Paid Expenses';
    balanceAmountEl.textContent = formatCurrency(totalPaid);
    balanceAmountEl.className = 'balance-amount';
    if (totalPaid > 0) balanceAmountEl.classList.add('positive');
    else balanceAmountEl.classList.add('zero');
    balanceSubtitleEl.textContent = '';
    balanceSubtitleEl.title = '';
  } else if (balanceViewMode === 'missed') {
    balanceLabelText.textContent = 'Missed Expenses';
    balanceAmountEl.textContent = formatCurrency(totalMissed);
    balanceAmountEl.className = 'balance-amount';
    if (totalMissed > 0) balanceAmountEl.classList.add('negative');
    else balanceAmountEl.classList.add('zero');
    balanceSubtitleEl.textContent = '';
    balanceSubtitleEl.title = '';
  } else {
    balanceLabelText.textContent = 'Available Balance';
    balanceAmountEl.textContent = formatCurrency(Math.max(balance, 0));
    balanceAmountEl.className = 'balance-amount';
    if (balance > 0) balanceAmountEl.classList.add('positive');
    else if (balance < 0) balanceAmountEl.classList.add('negative');
    else balanceAmountEl.classList.add('zero');
    balanceSubtitleEl.textContent = '';
    balanceSubtitleEl.title = '';
  }

  totalIncomeEl.textContent = formatCurrency(totalIncome);
  totalExpensesEl.textContent = showExpensePercent ? (totalIncome > 0 ? Math.round((totalExpense / totalIncome) * 100) + '%' : '0%') : formatCurrency(totalExpense);
  totalExpensesEl.style.color = 'var(--danger)';

  const circumference = 2 * Math.PI * 34;
  let healthPercent = 0;
  if (totalIncome > 0 && balance > 0) {
    healthPercent = Math.min(100, Math.round((balance / totalIncome) * 100));
  } else if (balance <= 0) {
    healthPercent = 0;
  }

  healthPercentEl.textContent = healthPercent + '%';
  const offset = circumference - (healthPercent / 100) * circumference;
  healthProgressEl.style.strokeDasharray = circumference;
  healthProgressEl.style.strokeDashoffset = offset;

  healthProgressEl.classList.remove('good', 'great');
  if (healthPercent >= 50) {
    healthProgressEl.classList.add('great');
    healthStatusEl.textContent = 'Looking healthy';
  } else if (healthPercent >= 20) {
    healthProgressEl.classList.add('good');
    healthStatusEl.textContent = 'Manage spending carefully';
  } else if (healthPercent > 0) {
    healthStatusEl.textContent = 'Budget is tight';
  } else {
    healthStatusEl.textContent = totalIncome === 0 ? 'Add income to get started' : 'Expenses exceed income';
  }

  incomeListEl.textContent = '';
  if (incomes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No incomes added yet';
    incomeListEl.appendChild(empty);
  } else {
    for (const inc of incomes) {
      incomeListEl.appendChild(createIncomeItem(inc));
    }
  }

  expenseListEl.textContent = '';
  if (expenses.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No expenses recorded';
    expenseListEl.appendChild(empty);
  } else {
    const sortedExpenses = [...expenses].sort((a, b) => {
      const priority = { missed: 0, 'pending-soon': 1, 'pending-far': 2, paid: 3 };
      return priority[getStatusInfo(a).cls] - priority[getStatusInfo(b).cls];
    });
    totalExpenseForPct = totalExpense;
    for (const exp of sortedExpenses) {
      expenseListEl.appendChild(createExpenseItem(exp));
    }
  }

  expenseCountEl.textContent = '(' + expenses.length + ')';
  pendingStatEl.textContent = 'Pending (' + pendingExpenses.length + ')';
  paidStatEl.textContent = 'Paid (' + paidExpenses.length + ')';
  missedStatEl.textContent = 'Missed (' + missedExpenses.length + ')';
  pendingStatEl.classList.toggle('active', balanceViewMode === 'pending');
  paidStatEl.classList.toggle('active', balanceViewMode === 'paid');
  missedStatEl.classList.toggle('active', balanceViewMode === 'missed');

  document.querySelectorAll('[data-delete-income]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingDelete = { store: 'incomes', id: parseInt(btn.dataset.deleteIncome), label: 'income' };
      deleteModal.querySelector('.modal-title').textContent = 'Delete Income';
      deleteMessage.textContent = 'Are you sure you want to delete this income?';
      openModal(deleteModal);
    });
  });

  document.querySelectorAll('[data-delete-expense]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingDelete = { store: 'expenses', id: parseInt(btn.dataset.deleteExpense), label: 'expense' };
      deleteModal.querySelector('.modal-title').textContent = 'Delete Expense';
      deleteMessage.textContent = 'Are you sure you want to delete this expense?';
      openModal(deleteModal);
    });
  });

  document.querySelectorAll('[data-edit-expense]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const expenses = await getAllItems('expenses');
      const expense = expenses.find(e => e.id === parseInt(btn.dataset.editExpense));
      if (!expense) return;
      editingExpenseId = expense.id;
      expenseForm.querySelector('[name="description"]').value = expense.description;
      expenseForm.querySelector('[name="amount"]').value = expense.amount;
      expenseForm.querySelector('[name="category"]').value = expense.category;
      expenseForm.querySelector('[name="date"]').value = expense.date;
      expenseForm.querySelector('[name="status"]').value = expense.status || 'pending';
      expenseModal.querySelector('.modal-title').textContent = 'Edit Expense';
      expenseModal.querySelector('.modal-submit').textContent = 'Save Changes';
      openModal(expenseModal);
    });
  });
}

function clearUI() {
  incomeListEl.textContent = '';
  expenseListEl.textContent = '';
  balanceAmountEl.textContent = 'R0';
  balanceAmountEl.className = 'balance-amount zero';
  balanceLabelText.textContent = 'Available Balance';
  balanceSubtitleEl.textContent = '';
  balanceSubtitleEl.title = '';
  totalIncomeEl.textContent = 'R0';
  totalExpensesEl.textContent = 'R0';
  totalExpensesEl.style.color = 'var(--danger)';
  healthPercentEl.textContent = '0%';
  healthStatusEl.textContent = 'Add income to get started';
  expenseCountEl.textContent = '';
  pendingStatEl.textContent = 'Pending (0)';
  paidStatEl.textContent = 'Paid (0)';
  missedStatEl.textContent = 'Missed (0)';
}

function openModal(modal) {
  modal.classList.add('active');
}

function closeModal(modal) {
  modal.classList.remove('active');
  if (modal === expenseModal) {
    editingExpenseId = null;
    expenseForm.reset();
    expenseForm.querySelector('[name="status"]').value = 'pending';
    expenseModal.querySelector('.modal-title').textContent = 'Add Expense';
    expenseModal.querySelector('.modal-submit').textContent = 'Add Expense';
  }
  if (modal === deleteModal) {
    pendingDelete = null;
  }
}

function showLockOverlay() {
  lockError.style.display = 'none';
  lockError.textContent = '';
  unlockBtn.disabled = false;
  lockOverlay.classList.add('active');
}

const optionsBtn = document.getElementById('optionsBtn');
const optionsDropdown = document.getElementById('optionsDropdown');

optionsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const rect = optionsBtn.getBoundingClientRect();
  optionsDropdown.style.left = '';
  optionsDropdown.style.right = (window.innerWidth - rect.right) + 'px';
  optionsDropdown.style.top = (rect.bottom + 8) + 'px';
  optionsDropdown.classList.toggle('active');
});

document.addEventListener('click', () => {
  optionsDropdown.classList.remove('active');
});

function escapeCsv(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function generateCsv() {
  const header = ['type', 'source', 'description', 'amount', 'category', 'date', 'status', '%'];
  const rows = [header];
  const totalIncome = incomesCache.reduce((sum, i) => sum + i.amount, 0);
  for (const i of incomesCache) {
    rows.push(['income', escapeCsv(i.source), '', i.amount, '', escapeCsv(i.date), '', '']);
  }
  rows.push(['total income', '', '', totalIncome, '', '', '', '']);
  const totalExpenses = expensesCache.reduce((sum, e) => sum + e.amount, 0);
  rows.push(['total expenses', '', '', totalExpenses, '', '', '', '']);
  const totalExpensePct = 100;
  rows.push(['total expense %', '', '', '', '', '', '', totalExpensePct]);
  const availableBalance = totalIncome - totalExpenses;
  const availPct = totalIncome > 0 ? ((availableBalance / totalIncome) * 100).toFixed(1) : '';
  rows.push(['available balance', '', '', availableBalance.toFixed(2), '', '', '', availPct]);
  for (const e of expensesCache) {
    const pct = totalExpenses > 0 ? ((e.amount / totalExpenses) * 100) : '';
    rows.push(['expense', '', escapeCsv(e.description), e.amount, escapeCsv(e.category), escapeCsv(e.date), escapeCsv(e.status || 'pending'), pct]);
  }
  return rows.map(r => r.join(',')).join('\n');
}

function downloadCsv(csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const ts = d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + '-' + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0') + String(d.getSeconds()).padStart(2,'0');
  a.download = 'expenditure-export-' + ts + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let showExpenseCategory = false;
let showExpensePercent = false;
let showCriticalBorder = localStorage.getItem('showCriticalBorder') === 'true';
let pendingDelete = null;
let pendingConfirm = null;
let incomesCache = [];
let expensesCache = [];
let balanceViewMode = 'balance';

document.getElementById('exportBtn').addEventListener('click', () => {
  optionsDropdown.classList.remove('active');
  const csv = generateCsv();
  downloadCsv(csv);
  showToast('Data exported as CSV');
});

document.getElementById('importBtn').addEventListener('click', () => {
  optionsDropdown.classList.remove('active');
  openModal(importModal);
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  optionsDropdown.classList.remove('active');
  document.getElementById('criticalBorderToggle').checked = showCriticalBorder;
  openModal(settingsModal);
});

document.getElementById('lockAppBtn').addEventListener('click', () => {
  optionsDropdown.classList.remove('active');
  postToWorker('clear-key').catch(() => {});
  incomesCache = [];
  expensesCache = [];
  balanceViewMode = 'balance';
  clearUI();
  lockTitle.textContent = 'Unlock Expenditure';
  lockSubtitle.textContent = 'Use your device biometrics or PIN to unlock your data.';
  unlockBtn.textContent = 'Unlock with Device';
  showLockOverlay();
});

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = importForm.querySelector('[name="csvFile"]');
  const file = fileInput.files[0];
  if (!file) return;

  const text = await file.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) {
    showToast('CSV file is empty or missing header', 'error');
    return;
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const typeIdx = headers.indexOf('type');
  const sourceIdx = headers.indexOf('source');
  const descIdx = headers.indexOf('description');
  const amountIdx = headers.indexOf('amount');
  const catIdx = headers.indexOf('category');
  const dateIdx = headers.indexOf('date');
  const statusIdx = headers.indexOf('status');

  if (typeIdx === -1 || amountIdx === -1 || dateIdx === -1) {
    showToast('CSV must have type, amount, and date columns', 'error');
    return;
  }

  function parseVal(idx, row) {
    if (idx === -1) return '';
    let val = row[idx].trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/""/g, '"');
    }
    return val;
  }

  const incomes = [];
  const expenses = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map(s => s.trim());
    const type = parseVal(typeIdx, row).toLowerCase();
    const amount = parseFloat(parseVal(amountIdx, row));
    const date = parseVal(dateIdx, row);
    if (isNaN(amount) || !date) continue;
    if (type === 'income') {
      incomes.push(sanitizeObject({ source: parseVal(sourceIdx, row) || 'Imported', amount, date }));
    } else if (type === 'expense') {
      const status = parseVal(statusIdx, row) || 'pending';
      expenses.push(sanitizeObject({ description: parseVal(descIdx, row) || 'Imported', amount, category: parseVal(catIdx, row) || 'Other', date, status }));
    }
  }

  await clearStore('incomes');
  await clearStore('expenses');
  for (const inc of incomes) await addItem('incomes', inc);
  for (const exp of expenses) await addItem('expenses', exp);

  closeModal(importModal);
  importForm.reset();
  showToast('Imported ' + incomes.length + ' incomes and ' + expenses.length + ' expenses');
  updateUI();
});

document.getElementById('deleteConfirm').addEventListener('click', async () => {
  if (pendingConfirm) {
    const fn = pendingConfirm;
    pendingConfirm = null;
    closeModal(deleteModal);
    await fn();
    return;
  }
  if (!pendingDelete) return;
  await deleteItem(pendingDelete.store, pendingDelete.id);
  const label = pendingDelete.label;
  pendingDelete = null;
  closeModal(deleteModal);
  showToast(label.charAt(0).toUpperCase() + label.slice(1) + ' deleted');
  updateUI();
});

document.getElementById('deleteCancel').addEventListener('click', () => {
  pendingConfirm = null;
  pendingDelete = null;
  closeModal(deleteModal);
});

document.getElementById('criticalBorderToggle').addEventListener('change', (e) => {
  showCriticalBorder = e.target.checked;
  localStorage.setItem('showCriticalBorder', showCriticalBorder);
  updateUI();
});

document.getElementById('clearStorageBtn').addEventListener('click', () => {
  closeModal(settingsModal);
  pendingConfirm = async () => {
    await clearStore('incomes');
    await clearStore('expenses');
    await deletePrfData();
    await deleteEncryptionKey();
    await postToWorker('delete-key').catch(() => {});
    showToast('All data cleared');
    updateUI();
  };
  deleteModal.querySelector('.modal-title').textContent = 'Clear All Data';
  deleteMessage.textContent = 'Are you sure you want to delete all data? This cannot be undone.';
  openModal(deleteModal);
});

totalExpensesEl.addEventListener('click', () => {
  showExpensePercent = !showExpensePercent;
  updateUI();
});

balanceAmountEl.addEventListener('click', () => {
  const modes = ['balance', 'pending', 'paid', 'missed'];
  const idx = modes.indexOf(balanceViewMode);
  balanceViewMode = modes[(idx + 1) % modes.length];
  updateUI();
});

pendingStatEl.addEventListener('click', () => {
  balanceViewMode = balanceViewMode === 'pending' ? 'balance' : 'pending';
  updateUI();
});

paidStatEl.addEventListener('click', () => {
  balanceViewMode = balanceViewMode === 'paid' ? 'balance' : 'paid';
  updateUI();
});

missedStatEl.addEventListener('click', () => {
  balanceViewMode = balanceViewMode === 'missed' ? 'balance' : 'missed';
  updateUI();
});

document.getElementById('addIncomeBtn').addEventListener('click', () => openModal(incomeModal));
expenseListEl.addEventListener('click', (e) => {
  const toggle = e.target.closest('.amount-toggle');
  if (toggle) {
    showExpensePercent = !showExpensePercent;
    updateUI();
    return;
  }
  const badge = e.target.closest('.status-tag, .category-tag');
  if (!badge) return;
  showExpenseCategory = !showExpenseCategory;
  updateUI();
});

document.getElementById('addExpenseBtn').addEventListener('click', () => {
  editingExpenseId = null;
  expenseForm.reset();
  expenseForm.querySelector('[name="date"]').valueAsDate = today;
  expenseForm.querySelector('[name="status"]').value = 'pending';
  expenseModal.querySelector('.modal-title').textContent = 'Add Expense';
  expenseModal.querySelector('.modal-submit').textContent = 'Add Expense';
  openModal(expenseModal);
});

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    closeModal(incomeModal);
    closeModal(expenseModal);
    closeModal(importModal);
    closeModal(deleteModal);
    closeModal(settingsModal);
  });
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal(incomeModal);
      closeModal(expenseModal);
      closeModal(importModal);
      closeModal(deleteModal);
      closeModal(settingsModal);
      pendingDelete = null;
      pendingConfirm = null;
    }
  });
});

incomeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(incomeForm);
  const data = sanitizeObject({
    source: formData.get('source'),
    amount: parseFloat(formData.get('amount')),
    date: formData.get('date')
  });
  await addItem('incomes', data);
  closeModal(incomeModal);
  incomeForm.reset();
  showToast('Income added successfully');
  updateUI();
});

expenseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(expenseForm);
  const data = sanitizeObject({
    description: formData.get('description'),
    amount: parseFloat(formData.get('amount')),
    category: formData.get('category'),
    date: formData.get('date'),
    status: formData.get('status') || 'pending'
  });
  if (editingExpenseId) {
    data.id = editingExpenseId;
    await updateItem('expenses', data);
    showToast('Expense updated');
  } else {
    await addItem('expenses', data);
    showToast('Expense recorded');
  }
  closeModal(expenseModal);
  expenseForm.reset();
  editingExpenseId = null;
  expenseModal.querySelector('.modal-title').textContent = 'Add Expense';
  expenseModal.querySelector('.modal-submit').textContent = 'Add Expense';
  updateUI();
});

incomeForm.date.valueAsDate = today;
expenseForm.date.valueAsDate = today;

unlockBtn.addEventListener('click', async () => {
  lockError.style.display = 'none';
  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Authenticating...';
  let hasKey;
  let isPrf = false;

  try {
    const wa = webauthnAvailable();
    if (!wa.ok) {
      lockError.textContent = wa.reason;
      lockError.style.display = 'block';
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Unlock with Device';
      return;
    }
    if (wa.redirect) {
      window.location.href = wa.redirect;
      return;
    }

    hasKey = await hasEncryptionKey();

    if (hasKey) {
      isPrf = await usePrfFlow();
      if (isPrf) {
        const prfData = await loadPrfData();
        const salt = prfData.salt;
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: webauthnRpId(),
            userVerification: 'required',
            extensions: {
              prf: {
                eval: { first: salt }
              }
            }
          }
        });
        const prfResult = assertion.getClientExtensionResults().prf;
        if (!prfResult || !prfResult.results || !prfResult.results.first) {
          throw new Error('PRF not supported by authenticator');
        }
        const rawBuffer = prfResult.results.first;
        await postToWorker('import-key', new Uint8Array(rawBuffer), [rawBuffer]);
        delete prfResult.results.first;
      } else {
        await authenticate();
        const result = await postToWorker('load-key');
        if (!result.ok) {
          lockError.textContent = 'Encryption key not found. Data may be corrupted.';
          lockError.style.display = 'block';
          unlockBtn.disabled = false;
          unlockBtn.textContent = 'Unlock with Device';
          return;
        }
      }
    } else {
      const cred = await createCredentialWithPrf();
      const credPrf = cred.getClientExtensionResults().prf;
      if (credPrf && credPrf.enabled) {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: webauthnRpId(),
            userVerification: 'required',
            allowCredentials: [{
              type: 'public-key',
              id: new Uint8Array(cred.rawId)
            }],
            extensions: {
              prf: {
                eval: { first: salt }
              }
            }
          }
        });
        const prfResult = assertion.getClientExtensionResults().prf;
        if (!prfResult || !prfResult.results || !prfResult.results.first) {
          throw new Error('PRF evaluation failed');
        }
        const rawBuffer = prfResult.results.first;
        await postToWorker('import-key', new Uint8Array(rawBuffer), [rawBuffer]);
        delete prfResult.results.first;
        const credId = new Uint8Array(cred.rawId);
        await savePrfData({ salt, credId });
        await postToWorker('reencrypt-all');
      } else {
        await createCredential();
        await postToWorker('generate-key');
        await postToWorker('reencrypt-all');
      }
    }

    trackActivity();
    startAutoLockTimer();
    lockOverlay.classList.remove('active');
    updateUI();
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      unlockBtn.textContent = hasKey ? 'Unlock with Device' : 'Set Up';
    } else {
      lockError.textContent = err.message || 'Unlock failed. Please try again.';
      lockError.style.display = 'block';
      unlockBtn.textContent = hasKey ? 'Unlock with Device' : 'Set Up';
    }
    unlockBtn.disabled = false;
  }
});

function trackActivity() {
  lastActivity = Date.now();
}

function handleActivity() {
  lastActivity = Date.now();
}

function startAutoLockTimer() {
  if (autoLockInterval) clearInterval(autoLockInterval);
  autoLockInterval = setInterval(() => {
    if (Date.now() - lastActivity > LOCK_TIMEOUT) {
      lockApp();
    }
  }, 60000);
}

function stopAutoLockTimer() {
  if (autoLockInterval) {
    clearInterval(autoLockInterval);
    autoLockInterval = null;
  }
}

async function lockApp() {
  stopAutoLockTimer();
  await postToWorker('clear-key').catch(() => {});
  incomesCache = [];
  expensesCache = [];
  balanceViewMode = 'balance';
  clearUI();
  lockTitle.textContent = 'Unlock Expenditure';
  lockSubtitle.textContent = 'Use your device biometrics or PIN to unlock your data.';
  unlockBtn.textContent = 'Unlock with Device';
  showLockOverlay();
} 

document.addEventListener('click', handleActivity);
document.addEventListener('keydown', handleActivity);
document.addEventListener('scroll', handleActivity);
document.addEventListener('touchstart', handleActivity);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    lastActivity = Date.now();
  } else {
    if (Date.now() - lastActivity > LOCK_TIMEOUT) {
      lockApp();
    }
  }
});

window.addEventListener('beforeunload', () => {
  postToWorker('clear-key').catch(() => {});
  stopAutoLockTimer();
});

function detectExtensions() {
  const detected = [];

  try {
    const nativeMap = Function.prototype.toString.call(Array.prototype.map);
    if (!nativeMap.includes('[native code]')) {
      detected.push('prototype modification detected');
    }
  } catch (e) {
    detected.push('prototype tampering detected');
  }

  try {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (src.startsWith('chrome-extension:') || src.startsWith('moz-extension:') || src.startsWith('safari-extension:')) {
        detected.push('extension iframe: ' + src.split('/')[2]);
      }
    }
  } catch (e) {
  }

  try {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.getAttribute && el.getAttribute('data-extension-id')) {
        detected.push('extension element detected');
        break;
      }
    }
  } catch (e) {
  }

  try {
    if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) {
      detected.push('Chrome extension runtime: ' + window.chrome.runtime.id);
    }
  } catch (e) {
  }

  return detected;
}

function showExtensionWarning(extensions) {
  const existing = document.getElementById('extensionWarning');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'extensionWarning';
  banner.className = 'extension-warning';

  const text = document.createElement('span');
  text.textContent = 'Warning: ' + extensions.length + ' browser extension' + (extensions.length > 1 ? 's' : '') + ' detected. Extensions can read your encrypted data. For financial privacy, use a browser profile without extensions.';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'extension-warning-dismiss';
  dismissBtn.textContent = '\u2715';
  dismissBtn.setAttribute('aria-label', 'Dismiss warning');

  banner.appendChild(text);
  banner.appendChild(dismissBtn);

  const lockModal = lockOverlay.querySelector('.modal');
  if (lockModal) {
    lockModal.parentNode.insertBefore(banner, lockModal);
  }

  dismissBtn.addEventListener('click', () => {
    banner.remove();
    try {
      localStorage.setItem('extWarningDismissed', 'true');
    } catch (e) {
    }
  });
}

function checkExtensions() {
  try {
    const dismissed = localStorage.getItem('extWarningDismissed') === 'true';
    if (dismissed) return;

    const extensions = detectExtensions();
    if (extensions.length > 0) {
      showExtensionWarning(extensions);
      console.log('Extension detection results:', extensions);
    }
  } catch (e) {
    console.error('Extension detection error:', e);
  }
}

function blockNetworkExfiltration() {
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    let requestUrl;
    try {
      requestUrl = new URL(url, window.location.href);
    } catch (e) {
      return origFetch.apply(this, arguments);
    }
    const host = requestUrl.hostname;
    if (host === window.location.hostname || host === 'localhost' || host === '127.0.0.1') {
      return origFetch.apply(this, arguments);
    }
    if (requestUrl.protocol === 'blob:' || requestUrl.protocol === 'data:') {
      return origFetch.apply(this, arguments);
    }
    return Promise.reject(new TypeError('Blocked by security policy: ' + url));
  };

  const OrigXHR = window.XMLHttpRequest;
  function SecureXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, async, user, password) {
      let requestUrl;
      try {
        requestUrl = new URL(url, window.location.href);
      } catch (e) {
        origOpen(method, url, async !== false, user, password);
        return;
      }
      const host = requestUrl.hostname;
      if (host === window.location.hostname || host === 'localhost' || host === '127.0.0.1') {
        origOpen(method, url, async !== false, user, password);
        return;
      }
      if (requestUrl.protocol === 'blob:' || requestUrl.protocol === 'data:') {
        origOpen(method, url, async !== false, user, password);
        return;
      }
      throw new TypeError('Blocked by security policy: ' + url);
    };
    return xhr;
  }
  SecureXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = SecureXHR;
}

initDB().then(async () => {
  initWorker();
  blockNetworkExfiltration();

  const wa = webauthnAvailable();
  if (wa.redirect) {
    window.location.href = wa.redirect;
    return;
  }
  if (!wa.ok) {
    lockTitle.textContent = 'Unlock Unavailable';
    lockSubtitle.textContent = wa.reason;
    unlockBtn.style.display = 'none';
    showLockOverlay();
    return;
  }

  try {
    const hasKey = await hasEncryptionKey();
    if (hasKey) {
      lockTitle.textContent = 'Unlock Expenditure';
      lockSubtitle.textContent = 'Use your device biometrics or PIN to unlock your data.';
      unlockBtn.textContent = 'Unlock with Device';
    } else {
      lockTitle.textContent = 'Set Up Device Unlock';
      lockSubtitle.textContent = 'Secure your data with your device\u2019s biometrics or PIN.';
      unlockBtn.textContent = 'Set Up';
    }
  } catch (e) {
    lockTitle.textContent = 'Unlock Unavailable';
    lockSubtitle.textContent = 'Security module failed to load. Please refresh the page.';
    unlockBtn.style.display = 'none';
  }
  showLockOverlay();
  checkExtensions();
});
