// IndexedDB wrapper for Routiner Offline-First functionality
const DB_NAME = "routiner_offline_db";
const DB_VERSION = 2;

let dbPromise = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Session store: auth credentials, company and user profile
        if (!db.objectStoreNames.contains("auth")) {
          db.createObjectStore("auth", { keyPath: "key" });
        }

        // Cache store: locations, tasks, history, dashboard, team, sectors, notifications
        if (!db.objectStoreNames.contains("cache")) {
          db.createObjectStore("cache", { keyPath: "key" });
        }

        // Outbox queue: pending mutations to sync when reconnected
        if (!db.objectStoreNames.contains("outbox")) {
          const outboxStore = db.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
          outboxStore.createIndex("createdAt", "createdAt", { unique: false });
          outboxStore.createIndex("status", "status", { unique: false });
        }

        // Photos store: local blobs / base64 for photos taken while offline
        if (!db.objectStoreNames.contains("photos")) {
          db.createObjectStore("photos", { keyPath: "id" });
        }

        // Chave não exportável usada para proteger dados sensíveis da outbox.
        if (!db.objectStoreNames.contains("crypto")) {
          db.createObjectStore("crypto", { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

// ======================== AUTH SESSION ========================

export async function saveAuthSession(account) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("auth", "readwrite");
      tx.objectStore("auth").put({
        key: "session",
        account,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("Erro ao salvar sessão offline:", error);
  }
}

export async function getAuthSession() {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("auth", "readonly");
      const req = tx.objectStore("auth").get("session");
      req.onsuccess = () => resolve(req.result ? req.result.account : null);
      req.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("Erro ao ler sessão offline:", error);
    return null;
  }
}

export async function clearAuthSession() {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("auth", "readwrite");
      tx.objectStore("auth").delete("session");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("Erro ao limpar sessão offline:", error);
  }
}

// ======================== CACHE STORE ========================

export async function saveCache(key, data) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cache", "readwrite");
      tx.objectStore("cache").put({
        key,
        data,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Erro ao salvar cache [${key}]:`, error);
  }
}

export async function getCache(key) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cache", "readonly");
      const req = tx.objectStore("cache").get(key);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Erro ao ler cache [${key}]:`, error);
    return null;
  }
}

// ======================== PHOTOS STORE ========================

export async function saveOfflinePhoto(fileOrBlob) {
  const db = await getDB();
  const id = `photo_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (typeof fileOrBlob === "string" && fileOrBlob.startsWith("data:")) {
    const [header, encoded] = fileOrBlob.split(",");
    const mime = header.match(/data:(.*?);base64/)?.[1] || "image/jpeg";
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    fileOrBlob = new Blob([bytes], { type: mime });
  }

  // Convert to base64 data URL for easy display and serialization
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(fileOrBlob);
  });

  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").put({
      id,
      dataUrl,
      type: fileOrBlob.type || "image/jpeg",
      name: fileOrBlob.name || "photo.jpg",
      createdAt: Date.now(),
    });
    tx.oncomplete = () => resolve({ id, dataUrl });
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOfflinePhoto(id) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("photos", "readonly");
      const req = tx.objectStore("photos").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Erro ao buscar foto [${id}]:`, error);
    return null;
  }
}

export async function deleteOfflinePhoto(id) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("photos", "readwrite");
      tx.objectStore("photos").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Erro ao deletar foto [${id}]:`, error);
  }
}

// Convert base64 data URL back to Blob / File for uploading when online
export function dataUrlToFile(dataUrl, filename = "photo.jpg") {
  const arr = dataUrl.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

// ======================== OUTBOX QUEUE ========================

export async function addToOutbox(item) {
  const db = await getDB();
  const payload = item.payload || {};
  const encryptedPayload = await encryptOutboxPayload(payload);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const record = {
      ...item,
      payload: undefined,
      payloadEncrypted: encryptedPayload,
      status: "pending",
      retries: 0,
      createdAt: Date.now(),
    };
    const req = tx.objectStore("outbox").add(record);
    req.onsuccess = () => resolve({ ...record, id: req.result });
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOutboxItems() {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const req = tx.objectStore("outbox").getAll();
      req.onsuccess = async () => {
        const items = await Promise.all((req.result || []).filter((item) => item.status !== "failed").map(async (item) => ({
          ...item,
          payload: item.payloadEncrypted
            ? await decryptOutboxPayload(item.payloadEncrypted)
            : (item.payload || {}),
        })));
        items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        resolve(items);
      };
      req.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("Erro ao buscar itens da outbox:", error);
    return [];
  }
}

async function getCryptoKey() {
  const db = await getDB();
  const existing = await new Promise((resolve, reject) => {
    const request = db.transaction("crypto", "readonly").objectStore("crypto").get("outbox-key");
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => reject(request.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await new Promise((resolve, reject) => {
    const tx = db.transaction("crypto", "readwrite");
    tx.objectStore("crypto").put({ key: "outbox-key", value: key });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

async function encryptOutboxPayload(payload) {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  return { iv: Array.from(iv), data: Array.from(ciphertext) };
}

async function decryptOutboxPayload(encrypted) {
  try {
    const key = await getCryptoKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(encrypted.iv) },
      key,
      new Uint8Array(encrypted.data),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    console.error("Não foi possível abrir um item protegido da fila offline.", error);
    return {};
  }
}

export async function removeOutboxItem(id) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Erro ao remover outbox [${id}]:`, error);
  }
}

export async function markOutboxItemFailed(id, errorMessage) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      const store = tx.objectStore("outbox");
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) {
          store.put({ ...request.result, status: "failed", errorMessage, failedAt: Date.now() });
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Erro ao marcar outbox [${id}]:`, error);
  }
}

export async function countOutboxItems() {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const req = tx.objectStore("outbox").getAll();
      req.onsuccess = () => resolve((req.result || []).filter((item) => item.status !== "failed").length);
      req.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}
