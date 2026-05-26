let cryptoKey = null;

function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('expenditure-db', 3);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('_crypto')) {
        db.createObjectStore('_crypto');
      }
    };
  });
}

async function storeEncryptionKey(key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('_crypto', 'readwrite');
    const r = t.objectStore('_crypto').put(key, 'encryption-key');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function loadEncryptionKey() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('_crypto', 'readonly');
    const r = t.objectStore('_crypto').get('encryption-key');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function deleteEncryptionKey() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('_crypto', 'readwrite');
    const r = t.objectStore('_crypto').delete('encryption-key');
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function encryptData(data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  return { iv, data: new Uint8Array(ciphertext) };
}

async function decryptData(payload) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: payload.iv }, cryptoKey, payload.data
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function readAllFromStore(store) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const s = t.objectStore(store);
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function writeToStore(store, payload) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    const r = s.put(payload);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

self.onerror = function (e) {
  e.preventDefault();
  console.error('Unhandled worker error:', e.message);
};

self.onmessage = async (e) => {
  const { id, type, data } = e.data;
  try {
    let result;
    switch (type) {
      case 'generate-key':
        cryptoKey = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        await storeEncryptionKey(cryptoKey);
        result = { ok: true };
        break;
      case 'load-key':
        cryptoKey = await loadEncryptionKey();
        result = { ok: !!cryptoKey };
        break;
      case 'encrypt':
        result = await encryptData(data);
        break;
      case 'decrypt':
        result = await decryptData(data);
        break;
      case 'has-key':
        result = { ok: !!(await loadEncryptionKey()) };
        break;
      case 'clear-key':
        cryptoKey = null;
        result = { ok: true };
        break;
      case 'delete-key':
        cryptoKey = null;
        await deleteEncryptionKey();
        result = { ok: true };
        break;
      case 'reencrypt-all':
        for (const store of ['incomes', 'expenses']) {
          const items = await readAllFromStore(store);
          if (items.length > 0 && !items[0].iv) {
            for (const item of items) {
              const id = item.id;
              delete item.id;
              const payload = { id, ...await encryptData(item) };
              await writeToStore(store, payload);
            }
          }
        }
        result = { ok: true };
        break;
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
