// IndexedDB wrapper for Routiner Offline-First functionality
const DB_NAME = "routiner_offline_db";
const DB_VERSION = 1;

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
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const record = {
      ...item,
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
      req.onsuccess = () => {
        const items = req.result || [];
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

export async function countOutboxItems() {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const req = tx.objectStore("outbox").count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}
