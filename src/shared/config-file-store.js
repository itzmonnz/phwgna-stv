(function attachConfigFileStore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIConfigFileStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConfigFileStoreApi() {
  "use strict";

  const CONFIG_FILENAME = "phwgna-stv-config.json";
  const DB_NAME = "phwgna-stv-local-config";
  const STORE_NAME = "handles";
  const HANDLE_KEY = "config";

  function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function openDatabase(indexedDB) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error || new Error("Không mở được kho tệp cấu hình.")));
    });
  }

  async function readStoredHandle(indexedDB) {
    if (!indexedDB?.open) return undefined;
    const database = await openDatabase(indexedDB);
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(HANDLE_KEY);
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error || new Error("Không đọc được tệp cấu hình.")));
      });
    } finally { database.close(); }
  }

  async function storeHandle(indexedDB, handle) {
    if (!indexedDB?.open) return;
    const database = await openDatabase(indexedDB);
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
        transaction.addEventListener("complete", resolve);
        transaction.addEventListener("error", () => reject(transaction.error || new Error("Không nhớ được tệp cấu hình.")));
        transaction.addEventListener("abort", () => reject(transaction.error || new Error("Không nhớ được tệp cấu hình.")));
      });
    } finally { database.close(); }
  }

  function createConfigFileStore(dependencies = {}) {
    const picker = dependencies.showSaveFilePicker
      ?? (typeof globalThis.showSaveFilePicker === "function" ? globalThis.showSaveFilePicker.bind(globalThis) : undefined);
    const database = dependencies.indexedDB ?? globalThis.indexedDB;
    const loadHandle = dependencies.loadHandle || (() => readStoredHandle(database));
    const saveHandle = dependencies.saveHandle || (handle => storeHandle(database, handle));
    let handle;
    let prepared = false;

    async function prepare() {
      if (prepared) return handle;
      prepared = true;
      try { handle = await loadHandle(); } catch (_) { handle = undefined; }
      return handle;
    }

    async function chooseHandle() {
      if (typeof picker !== "function") {
        throw codedError("config_file_unsupported", "Trình duyệt này không hỗ trợ ghi đè tệp cấu hình.");
      }
      const selected = await picker({
        suggestedName: CONFIG_FILENAME,
        types: [{ description: "Cấu hình Phwgna STV", accept: { "application/json": [".json"] } }],
        excludeAcceptAllOption: true
      });
      handle = selected;
      await saveHandle(selected);
      return selected;
    }

    async function requirePermission(selected) {
      if (typeof selected?.queryPermission !== "function") return selected;
      let permission = await selected.queryPermission({ mode: "readwrite" });
      if (permission !== "granted" && typeof selected.requestPermission === "function") {
        permission = await selected.requestPermission({ mode: "readwrite" });
      }
      if (permission !== "granted") {
        throw codedError("config_file_permission_denied", "Chưa được phép ghi tệp cấu hình.");
      }
      return selected;
    }

    async function write(text, options = {}) {
      if (!prepared) await prepare();
      const selected = options.choose === true || !handle ? await chooseHandle() : handle;
      await requirePermission(selected);
      if (typeof selected?.createWritable !== "function") {
        throw codedError("config_file_invalid", "Tệp cấu hình đã chọn không còn hợp lệ.");
      }
      const writable = await selected.createWritable();
      try {
        await writable.write(String(text));
        await writable.close();
      } catch (error) {
        try { await writable.abort?.(); } catch (_) {}
        throw error;
      }
      return { ok: true, filename: CONFIG_FILENAME };
    }

    return Object.freeze({ prepare, write, filename: CONFIG_FILENAME });
  }

  return Object.freeze({ CONFIG_FILENAME, createConfigFileStore });
});
