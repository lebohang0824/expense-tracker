const DB_NAME = 'expenditure-db';
const DB_VERSION = 1;
let db;

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
        const incomeStore = database.createObjectStore('incomes', { keyPath: 'id', autoIncrement: true });
        incomeStore.createIndex('source', 'source', { unique: false });
        incomeStore.createIndex('date', 'date', { unique: false });
      }
      
      if (!database.objectStoreNames.contains('expenses')) {
        const expenseStore = database.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
        expenseStore.createIndex('description', 'description', { unique: false });
        expenseStore.createIndex('date', 'date', { unique: false });
        expenseStore.createIndex('category', 'category', { unique: false });
        expenseStore.createIndex('status', 'status', { unique: false });
      }
    };
  });
}

function addItem(storeName, data) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.add(data);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllItems(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

function updateItem(storeName, data) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(data);
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

const balanceAmountEl = document.getElementById('balanceAmount');
const healthProgressEl = document.getElementById('healthProgress');
const healthPercentEl = document.getElementById('healthPercent');
const healthStatusEl = document.getElementById('healthStatus');
const totalIncomeEl = document.getElementById('totalIncome');
const totalExpensesEl = document.getElementById('totalExpenses');
const incomeListEl = document.getElementById('incomeList');
const expenseListEl = document.getElementById('expenseList');
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

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);
  
  setTimeout(() => toast.classList.add('show'), 10);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

async function updateUI() {
  const incomes = await getAllItems('incomes');
  const expenses = await getAllItems('expenses');
  incomesCache = incomes;
  expensesCache = expenses;

  const totalIncome = incomes.reduce((sum, inc) => sum + inc.amount, 0);
  const totalExpense = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const balance = totalIncome - totalExpense;

  balanceAmountEl.textContent = formatCurrency(Math.max(balance, 0));
  balanceAmountEl.className = 'balance-amount';
  if (balance > 0) balanceAmountEl.classList.add('positive');
  else if (balance < 0) balanceAmountEl.classList.add('negative');
  else balanceAmountEl.classList.add('zero');

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

  healthPercentEl.textContent = `${healthPercent}%`;
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

  if (incomes.length === 0) {
    incomeListEl.innerHTML = '<div class="empty">No incomes added yet</div>';
  } else {
    incomeListEl.innerHTML = incomes.map(inc => `
      <div class="item">
        <div class="item-info">
          <div class="item-name">${inc.source}</div>
          <div class="item-date">${formatDate(inc.date)}</div>
        </div>
        <div class="item-amount income">
          <span>${formatCurrency(inc.amount)}</span>
          <button class="delete-btn" data-delete-income="${inc.id}" title="Delete">✕</button>
        </div>
      </div>
    `).join('');
  }

  if (expenses.length === 0) {
    expenseListEl.innerHTML = '<div class="empty">No expenses recorded</div>';
  } else {
    const sortedExpenses = [...expenses].sort((a, b) => {
const priority = { missed: 0, 'pending-soon': 1, 'pending-far': 2, paid: 3 };
return priority[getStatusInfo(a).cls] - priority[getStatusInfo(b).cls];
});
    expenseListEl.innerHTML = sortedExpenses.map(exp => {
      const status = getStatusInfo(exp);
      const itemCls = showCriticalBorder ? (status.cls === 'pending-soon' ? 'warning' : status.cls === 'missed' ? 'critical' : '') : '';
      return `
      <div class="item${itemCls ? ' ' + itemCls : ''}">
        <div class="item-info">
          <div class="item-name">${exp.description}</div>
          <div class="item-date">${formatDate(exp.date)}</div>
        </div>
        <div class="item-amount expense">
          ${showExpenseCategory
            ? `<span class="category-tag">${exp.category}</span>`
            : `<span class="status-tag ${status.cls}">${status.label}</span>`
          }
          <span class="amount-toggle">${showExpensePercent ? (totalExpense > 0 ? Math.round((exp.amount / totalExpense) * 100) + '%' : '0%') : formatCurrency(exp.amount)}</span>
          <button class="delete-btn" data-edit-expense="${exp.id}" title="Edit">✎</button>
          <button class="delete-btn" data-delete-expense="${exp.id}" title="Delete">✕</button>
        </div>
      </div>`
    }).join('');
  }

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
  a.download = `expenditure-export-${ts}.csv`;
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
      incomes.push({ source: parseVal(sourceIdx, row) || 'Imported', amount, date });
    } else if (type === 'expense') {
      const status = parseVal(statusIdx, row) || 'pending';
      expenses.push({ description: parseVal(descIdx, row) || 'Imported', amount, category: parseVal(catIdx, row) || 'Other', date, status });
    }
  }

  await clearStore('incomes');
  await clearStore('expenses');

  for (const inc of incomes) {
    await addItem('incomes', inc);
  }
  for (const exp of expenses) {
    await addItem('expenses', exp);
  }

  closeModal(importModal);
  importForm.reset();
  showToast(`Imported ${incomes.length} incomes and ${expenses.length} expenses`);
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
  showToast(`${label.charAt(0).toUpperCase() + label.slice(1)} deleted`);
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
  const data = {
    source: formData.get('source'),
    amount: parseFloat(formData.get('amount')),
    date: formData.get('date')
  };
  
  await addItem('incomes', data);
  closeModal(incomeModal);
  incomeForm.reset();
  showToast('Income added successfully');
  updateUI();
});

expenseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(expenseForm);
  const data = {
    description: formData.get('description'),
    amount: parseFloat(formData.get('amount')),
    category: formData.get('category'),
    date: formData.get('date'),
    status: formData.get('status') || 'pending'
  };

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

initDB().then(() => {
  updateUI();
});
