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
  const CONFIG_FORMAT = "phwgna-stv-prompts-name";
  const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

  function parseConfigPayload(input) {
    let payload = input;
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).byteLength > MAX_CONFIG_BYTES) return null;
      try { payload = JSON.parse(input); } catch (_) { return null; }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.format !== CONFIG_FORMAT || ![1, 2, 3].includes(payload.version)) return null;
    const limits = Object.freeze({ systemPrompt: 250_000, refusalSystemPrompt: 250_000, userPrompt: 250_000, nameGuide: 1_000_000, ttsPronunciationGuide: 20_000 });
    const result = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (key === "refusalSystemPrompt" && payload.version < 2) continue;
      if (key === "userPrompt" && payload.version >= 2) continue;
      if (typeof payload[key] !== "string" || payload[key].length > limit) return null;
      result[key] = payload[key];
    }
    if (payload.version >= 3) {
      const providers = new Set(["chatgpt", "gemini", "openrouter_api", "gemini_api", "openai_api", "deepseek_api"]);
      if (providers.has(payload.provider)) result.provider = payload.provider;
      const tabCount = Math.trunc(Number(payload.webAiTabCount));
      if (tabCount >= 2 && tabCount <= 10) result.webAiTabCount = tabCount;
      for (const key of ["temporaryChat", "warmPoolEnabled", "autoTranslateOnChapter", "geminiSafetyOff", "geminiRefusalFallbackEnabled", "geminiAccountRotationEnabled"]) {
        if (typeof payload[key] === "boolean") result[key] = payload[key];
      }
      for (const key of ["openrouterModel", "geminiApiModel", "openaiApiModel", "deepseekApiModel"]) {
        if (typeof payload[key] === "string" && payload[key].length <= 200) result[key] = payload[key];
      }
      const temperature = Number(payload.apiTemperature);
      if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) result.apiTemperature = temperature;
      const ui = payload.ui;
      if (ui && typeof ui === "object" && !Array.isArray(ui)) {
        const safeUi = {};
        const scales = new Set([0.5, 0.75, 1, 1.25, 1.5]);
        if (scales.has(Number(ui.stvaiUiScale))) safeUi.stvaiUiScale = Number(ui.stvaiUiScale);
        for (const [key, value] of Object.entries(ui)) {
          if (/^stvai(?:NavigationExpanded|ToolbarCollapsed)$/.test(key) && typeof value === "boolean") safeUi[key] = value;
          if (/^stvaiZoom(?:General|Story)Percent$/.test(key)
            && Number.isInteger(value) && value >= 25 && value <= 500) safeUi[key] = value;
          if (/^stvai(?:TtsOverlayPositionV1|ToolbarPositionV2|NameEditorPositionV2|NameManagerPositionV2)$/.test(key)
            && Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
            safeUi[key] = { x: Math.min(1, Math.max(0, value.x)), y: Math.min(1, Math.max(0, value.y)) };
          }
        }
        result.ui = safeUi;
      }
    }
    return result;
  }

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

  return Object.freeze({ CONFIG_FILENAME, CONFIG_FORMAT, MAX_CONFIG_BYTES, parseConfigPayload, createConfigFileStore });
});
