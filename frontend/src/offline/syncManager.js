import {
  countOutboxItems,
  deleteOfflinePhoto,
  getOfflinePhoto,
  getOutboxItems,
  removeOutboxItem,
  dataUrlToFile,
} from "./db";

class SyncManager {
  constructor() {
    this.isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
    this.isSyncing = false;
    this.pendingCount = 0;
    this.lastSyncTime = null;
    this.lastSyncMessage = "";
    this.subscribers = new Set();
    this.healthCheckTimer = null;
    this.apiClient = null;
    this.onRefreshData = null;

    if (typeof window !== "undefined") {
      this.initListeners();
    }
  }

  setApiClient(apiFn, refreshFn) {
    this.apiClient = apiFn;
    this.onRefreshData = refreshFn;
  }

  initListeners() {
    window.addEventListener("online", () => {
      this.checkServerAndSync("Conexão com a rede detectada");
    });

    window.addEventListener("offline", () => {
      this.isOnline = false;
      this.notify();
    });

    window.addEventListener("focus", () => {
      this.checkServerAndSync("Janela ativa");
    });

    // Check count on load
    this.updatePendingCount();

    // Heartbeat check every 12 seconds
    this.healthCheckTimer = window.setInterval(() => {
      this.checkHealth();
    }, 12_000);
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    callback(this.getState());
    return () => this.subscribers.delete(callback);
  }

  notify() {
    const state = this.getState();
    this.subscribers.forEach((cb) => {
      try {
        cb(state);
      } catch (err) {
        console.error("Erro no subscriber do SyncManager:", err);
      }
    });
  }

  getState() {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: this.pendingCount,
      lastSyncTime: this.lastSyncTime,
      lastSyncMessage: this.lastSyncMessage,
    };
  }

  async updatePendingCount() {
    this.pendingCount = await countOutboxItems();
    this.notify();
    return this.pendingCount;
  }

  async checkHealth() {
    try {
      const response = await fetch("/api/health", {
        signal: AbortSignal.timeout(3500),
        cache: "no-store",
      });
      if (response.ok) {
        const wasOffline = !this.isOnline;
        this.isOnline = true;
        if (wasOffline) {
          this.triggerSync();
        } else if (this.pendingCount > 0 && !this.isSyncing) {
          this.triggerSync();
        }
      } else {
        this.isOnline = false;
      }
    } catch {
      this.isOnline = false;
    }
    this.notify();
  }

  async checkServerAndSync() {
    await this.checkHealth();
    if (this.isOnline) {
      await this.triggerSync();
    }
  }

  async triggerSync() {
    if (this.isSyncing || !this.apiClient) return;

    await this.updatePendingCount();
    if (this.pendingCount === 0) return;

    this.isSyncing = true;
    this.lastSyncMessage = "Sincronizando dados com o servidor...";
    this.notify();

    let syncedItems = 0;
    try {
      const items = await getOutboxItems();
      for (const item of items) {
        try {
          await this.processItem(item);
          await removeOutboxItem(item.id);
          syncedItems++;
          await this.updatePendingCount();
        } catch (itemError) {
          // If network error during sync, stop and wait for next connection
          if (
            itemError?.name === "ApiConnectionError" ||
            itemError?.message?.includes("Failed to fetch") ||
            itemError?.message?.includes("NetworkError") ||
            itemError?.message?.includes("timeout")
          ) {
            this.isOnline = false;
            this.lastSyncMessage = "Conexão perdida durante a sincronização. Retomará assim que reconectar.";
            break;
          }

          // If validation error from server (4xx), log and remove so it doesn't block the queue
          console.error("Item falhou na sincronização e foi descartado:", item, itemError);
          await removeOutboxItem(item.id);
          await this.updatePendingCount();
        }
      }

      if (syncedItems > 0) {
        this.lastSyncTime = Date.now();
        this.lastSyncMessage = `Sincronização concluída: ${syncedItems} item(ns) enviado(s) ao servidor!`;
        if (typeof this.onRefreshData === "function") {
          try {
            await this.onRefreshData();
          } catch (refreshErr) {
            console.warn("Erro ao atualizar dados pós-sincronização:", refreshErr);
          }
        }
      }
    } catch (globalError) {
      console.error("Erro geral no SyncManager:", globalError);
      this.lastSyncMessage = "Erro ao sincronizar.";
    } finally {
      this.isSyncing = false;
      await this.updatePendingCount();
      this.notify();

      // Clear sync message after 5 seconds
      setTimeout(() => {
        if (this.lastSyncMessage.startsWith("Sincronização concluída")) {
          this.lastSyncMessage = "";
          this.notify();
        }
      }, 5000);
    }
  }

  async processItem(item) {
    const payload = { ...(item.payload || {}) };

    // 1. Process photoBefore if stored offline
    if (item.photoBeforeId) {
      const photoRecord = await getOfflinePhoto(item.photoBeforeId);
      if (photoRecord?.dataUrl) {
        const file = dataUrlToFile(photoRecord.dataUrl, "photo_before.jpg");
        const formData = new FormData();
        formData.append("file", file);
        const uploadResult = await this.apiClient("/upload", { method: "POST", body: formData });
        payload.photo_before = uploadResult.url;
        await deleteOfflinePhoto(item.photoBeforeId);
      }
    }

    // 2. Process photoAfter if stored offline
    if (item.photoAfterId) {
      const photoRecord = await getOfflinePhoto(item.photoAfterId);
      if (photoRecord?.dataUrl) {
        const file = dataUrlToFile(photoRecord.dataUrl, "photo_after.jpg");
        const formData = new FormData();
        formData.append("file", file);
        const uploadResult = await this.apiClient("/upload", { method: "POST", body: formData });
        payload.photo_after = uploadResult.url;
        await deleteOfflinePhoto(item.photoAfterId);
      }
    }

    // 3. Process single photoFile if stored offline (cleaning history, etc.)
    if (item.photoFileId) {
      const photoRecord = await getOfflinePhoto(item.photoFileId);
      if (photoRecord?.dataUrl) {
        const file = dataUrlToFile(photoRecord.dataUrl, "photo.jpg");
        const formData = new FormData();
        formData.append("file", file);
        const uploadResult = await this.apiClient("/upload", { method: "POST", body: formData });
        payload.photo_url = uploadResult.url;
        await deleteOfflinePhoto(item.photoFileId);
      }
    }

    // 4. Send API request
    const options = {
      method: item.method || "POST",
    };
    if (payload && Object.keys(payload).length > 0) {
      options.body = JSON.stringify(payload);
    }

    return await this.apiClient(item.endpoint, options);
  }
}

export const syncManager = new SyncManager();
