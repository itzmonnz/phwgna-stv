(function attachOptions(root, factory) {
  const core = root.STVAICore || (typeof require === "function" ? require("../src/shared/core.js") : null);
  const pronunciation = root.STVAITTSPronunciation || (typeof require === "function" ? require("../src/shared/tts-pronunciation.js") : null);
  const history = root.STVAINativeHistory || (typeof require === "function" ? require("../src/shared/native-history.js") : null);
  const portable = root.STVAINativePortable || (typeof require === "function" ? require("../src/shared/native-portable.js") : null);
  const dataBackup = root.STVAIDataBackup || (typeof require === "function" ? require("../src/shared/data-backup.js") : null);
  const api = factory(core, root.STVAISites, pronunciation, history, portable, dataBackup);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAIOptions = api;

  if (root.document && root.chrome?.storage?.local) {
    root.document.addEventListener("DOMContentLoaded", () => {
      api.initOptions({ document: root.document, chromeApi: root.chrome }).catch((error) => {
        const status = root.document.getElementById("saveStatus");
        if (status) {
          status.textContent = error instanceof Error ? error.message : "Không thể mở cài đặt.";
          status.dataset.tone = "error";
        }
      });
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createOptionsApi(core, defaultSites, pronunciation, history, portable, dataBackup) {
  "use strict";

  const STORAGE_KEY = "settings";
  const CREDENTIALS_KEY = "apiCredentials";
  const DEVELOPER_KEEP_TABS_KEY = "developerKeepAiTabs";
  const UI_SCALE_KEY = "stvaiUiScale";
  const UI_POSITION_KEYS = Object.freeze([
    "stvaiTtsOverlayPositionV1", "stvaiToolbarPositionV2",
    "stvaiNameEditorPositionV2", "stvaiNameManagerPositionV2"
  ]);
  const UI_BOOLEAN_KEYS = Object.freeze(["stvaiNavigationExpanded", "stvaiToolbarCollapsed"]);
  const UI_ZOOM_KEYS = Object.freeze(["stvaiZoomGeneralPercent", "stvaiZoomStoryPercent"]);
  const UI_BACKUP_KEYS = Object.freeze([UI_SCALE_KEY, ...UI_BOOLEAN_KEYS, ...UI_POSITION_KEYS, ...UI_ZOOM_KEYS]);
  const HISTORY_KEY = "stvai-native-history-v1";
  const PORTABLE_KEY = "stvai-native-portable-v1";
  const ROLLBACK_KEY = "stvai-data-rollback-v1";
  const UI_SCALES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5]);
  const PROVIDERS = Object.freeze(["chatgpt", "gemini", "openrouter_api", "gemini_api", "openai_api", "deepseek_api"]);
  const API_PROVIDERS = Object.freeze(PROVIDERS.filter((provider) => provider.endsWith("_api")));
  const MODEL_KEYS = Object.freeze({ openrouter_api: "openrouterModel", gemini_api: "geminiApiModel", openai_api: "openaiApiModel", deepseek_api: "deepseekApiModel" });
  const SETTING_KEYS = Object.freeze([
    "provider",
    "webAiTabCount",
    "temporaryChat",
    "warmPoolEnabled",
    "autoTranslateOnChapter",
    "openrouterModel",
    "geminiApiModel",
    "openaiApiModel",
    "deepseekApiModel",
    "geminiSafetyOff",
    "apiTemperature",
    "systemPrompt",
    "userPrompt",
    "nameGuide",
    "ttsPronunciationGuide"
  ]);
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  function normalizeUiScale(value) {
    const number = Number(value);
    return UI_SCALES.includes(number) ? number : 1;
  }

  function sanitizeUi(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const result = {};
    if (UI_SCALES.includes(Number(source[UI_SCALE_KEY]))) result[UI_SCALE_KEY] = Number(source[UI_SCALE_KEY]);
    for (const key of UI_BOOLEAN_KEYS) if (typeof source[key] === "boolean") result[key] = source[key];
    for (const key of UI_POSITION_KEYS) {
      const value = source[key];
      if (typeof value?.x !== "number" || typeof value?.y !== "number"
        || !Number.isFinite(value.x) || !Number.isFinite(value.y)) continue;
      result[key] = { x: Math.min(1, Math.max(0, value.x)), y: Math.min(1, Math.max(0, value.y)) };
    }
    for (const key of UI_ZOOM_KEYS) {
      const value = Math.round(Number(source[key]));
      if (Number.isFinite(value) && value >= 25 && value <= 500) result[key] = value;
    }
    return result;
  }

  function renderSupportedSites(document, sites = defaultSites) {
    const list = document?.getElementById("supportedSitesList");
    if (!list) return [];
    list.replaceChildren();
    const origins = Array.isArray(sites?.ORIGINS) ? sites.ORIGINS : [];
    const links = [];
    for (const origin of origins) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `${origin}/`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = origin;
      item.append(link);
      if (new URL(origin).protocol === "http:") {
        const badge = document.createElement("span");
        badge.className = "supported-sites__badge";
        badge.textContent = "HTTP";
        item.append(badge);
      }
      list.append(item);
      links.push(link);
    }
    return links;
  }

  const FALLBACK_DEFAULTS = Object.freeze({
    provider: "gemini",
    webAiTabCount: 3,
    temporaryChat: true,
    warmPoolEnabled: true,
    autoTranslateOnChapter: true,
    openrouterModel: "openrouter/auto",
    geminiApiModel: "gemini-2.5-flash",
    openaiApiModel: "gpt-5.4",
    deepseekApiModel: "deepseek-chat",
    geminiSafetyOff: false,
    apiTemperature: 0.3,
    systemPrompt: core?.DEFAULT_SETTINGS?.systemPrompt || "",
    userPrompt: core?.DEFAULT_SETTINGS?.userPrompt || "",
    nameGuide: core?.DEFAULT_SETTINGS?.nameGuide || "",
    ttsPronunciationGuide: core?.DEFAULT_SETTINGS?.ttsPronunciationGuide || "",
    ttsPronunciationDefaultsVersion: core?.DEFAULT_SETTINGS?.ttsPronunciationDefaultsVersion || 1,
    settingsDefaultsVersion: core?.SETTINGS_DEFAULTS_VERSION || 1
  });

  function copySettings(settings) {
    return {
      provider: settings.provider,
      webAiTabCount: settings.webAiTabCount,
      temporaryChat: settings.temporaryChat,
      warmPoolEnabled: settings.warmPoolEnabled,
      autoTranslateOnChapter: settings.autoTranslateOnChapter,
      openrouterModel: settings.openrouterModel,
      geminiApiModel: settings.geminiApiModel,
      openaiApiModel: settings.openaiApiModel,
      deepseekApiModel: settings.deepseekApiModel,
      geminiSafetyOff: settings.geminiSafetyOff,
      apiTemperature: settings.apiTemperature,
      systemPrompt: settings.systemPrompt,
      userPrompt: settings.userPrompt,
      nameGuide: settings.nameGuide,
      ttsPronunciationGuide: settings.ttsPronunciationGuide,
      ttsPronunciationDefaultsVersion: settings.ttsPronunciationDefaultsVersion,
      settingsDefaultsVersion: settings.settingsDefaultsVersion
    };
  }

  function safeDefaults(candidate) {
    if (!candidate || typeof candidate !== "object") return copySettings(FALLBACK_DEFAULTS);
    return {
      provider: PROVIDERS.includes(candidate.provider) ? candidate.provider : "gemini",
      webAiTabCount: Number.isFinite(Number(candidate.webAiTabCount))
        ? Math.min(5, Math.max(2, Math.trunc(Number(candidate.webAiTabCount))))
        : FALLBACK_DEFAULTS.webAiTabCount,
      temporaryChat: true,
      warmPoolEnabled: true,
      autoTranslateOnChapter: true,
      openrouterModel: typeof candidate.openrouterModel === "string" && candidate.openrouterModel.trim() ? candidate.openrouterModel.trim() : FALLBACK_DEFAULTS.openrouterModel,
      geminiApiModel: typeof candidate.geminiApiModel === "string" && candidate.geminiApiModel.trim() ? candidate.geminiApiModel.trim() : FALLBACK_DEFAULTS.geminiApiModel,
      openaiApiModel: typeof candidate.openaiApiModel === "string" && candidate.openaiApiModel.trim() ? candidate.openaiApiModel.trim() : FALLBACK_DEFAULTS.openaiApiModel,
      deepseekApiModel: typeof candidate.deepseekApiModel === "string" && candidate.deepseekApiModel.trim() ? candidate.deepseekApiModel.trim() : FALLBACK_DEFAULTS.deepseekApiModel,
      geminiSafetyOff: candidate.geminiSafetyOff === true,
      apiTemperature: Number.isFinite(Number(candidate.apiTemperature))
        ? Math.min(2, Math.max(0, Math.round(Number(candidate.apiTemperature) * 10) / 10))
        : FALLBACK_DEFAULTS.apiTemperature,
      systemPrompt: typeof candidate.systemPrompt === "string" ? candidate.systemPrompt : FALLBACK_DEFAULTS.systemPrompt,
      userPrompt: typeof candidate.userPrompt === "string" ? candidate.userPrompt : FALLBACK_DEFAULTS.userPrompt,
      nameGuide: typeof candidate.nameGuide === "string" ? candidate.nameGuide : "",
      ttsPronunciationGuide: typeof candidate.ttsPronunciationGuide === "string"
        ? candidate.ttsPronunciationGuide.slice(0, 20_000)
        : FALLBACK_DEFAULTS.ttsPronunciationGuide,
      ttsPronunciationDefaultsVersion: Number.isFinite(Number(candidate.ttsPronunciationDefaultsVersion))
        ? Math.max(0, Math.trunc(Number(candidate.ttsPronunciationDefaultsVersion)))
        : FALLBACK_DEFAULTS.ttsPronunciationDefaultsVersion,
      settingsDefaultsVersion: Number.isFinite(Number(candidate.settingsDefaultsVersion))
        ? Math.max(0, Math.trunc(Number(candidate.settingsDefaultsVersion)))
        : FALLBACK_DEFAULTS.settingsDefaultsVersion
    };
  }

  const DEFAULT_SETTINGS = Object.freeze(safeDefaults(core?.DEFAULT_SETTINGS));

  function sanitizeSettings(candidate, { strict = false } = {}) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      if (strict) throw new Error("Tệp JSON không chứa cài đặt hợp lệ.");
      return copySettings(DEFAULT_SETTINGS);
    }

    if (strict && Object.hasOwn(candidate, "provider") && !PROVIDERS.includes(candidate.provider)) {
      throw new Error("Giá trị provider chỉ có thể là chatgpt hoặc gemini.");
    }
    if (strict && Object.hasOwn(candidate, "temporaryChat") && typeof candidate.temporaryChat !== "boolean") {
      throw new Error("Giá trị temporaryChat phải là true hoặc false.");
    }
    if (strict && Object.hasOwn(candidate, "webAiTabCount")
      && (!Number.isInteger(Number(candidate.webAiTabCount)) || Number(candidate.webAiTabCount) < 2 || Number(candidate.webAiTabCount) > 5)) {
      throw new Error("Số tab AI phải là số nguyên từ 2 đến 5.");
    }
    for (const key of ["warmPoolEnabled", "autoTranslateOnChapter"]) {
      if (strict && Object.hasOwn(candidate, key) && typeof candidate[key] !== "boolean") {
        throw new Error(`Giá trị ${key} phải là true hoặc false.`);
      }
    }

    const result = copySettings(DEFAULT_SETTINGS);
    if (PROVIDERS.includes(candidate.provider)) result.provider = candidate.provider;
    if (Number.isInteger(Number(candidate.webAiTabCount)) && Number(candidate.webAiTabCount) >= 2 && Number(candidate.webAiTabCount) <= 5) {
      result.webAiTabCount = Number(candidate.webAiTabCount);
    }
    if (typeof candidate.geminiSafetyOff === "boolean") result.geminiSafetyOff = candidate.geminiSafetyOff;
    if (Object.hasOwn(candidate, "apiTemperature")) {
      const temperature = Number(candidate.apiTemperature);
      if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
        result.apiTemperature = Math.round(temperature * 10) / 10;
      } else if (strict) {
        throw new Error("Temperature phải là số từ 0 đến 2.");
      }
    }
    for (const key of ["openrouterModel", "geminiApiModel", "openaiApiModel", "deepseekApiModel"]) {
      if (typeof candidate[key] === "string" && candidate[key].trim()) result[key] = candidate[key].trim();
      else if (strict && Object.hasOwn(candidate, key)) throw new Error(`${key} must be a non-empty string.`);
    }
    for (const key of ["systemPrompt", "userPrompt", "nameGuide", "ttsPronunciationGuide"]) {
      if (typeof candidate[key] === "string") {
        if (key === "ttsPronunciationGuide" && candidate[key].length > 20_000) {
          if (strict) throw new Error("Danh sách phát âm vượt quá giới hạn an toàn.");
          result[key] = candidate[key].slice(0, 20_000);
        } else result[key] = key === "nameGuide" && core?.normalizeNameGuide
          ? core.normalizeNameGuide(candidate[key])
          : candidate[key];
      }
      else if (strict && Object.hasOwn(candidate, key)) throw new Error(`Giá trị ${key} phải là chuỗi.`);
    }
    return result;
  }

  function parseImportText(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Tệp không phải JSON hợp lệ.");
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Tệp JSON không chứa cài đặt hợp lệ.");
    }
    const candidate = Object.hasOwn(payload, "settings") ? payload.settings : payload;
    return sanitizeSettings(candidate, { strict: true });
  }

  function createExportPayload(settings) {
    const exported = sanitizeSettings(settings);
    delete exported.ttsPronunciationDefaultsVersion;
    delete exported.settingsDefaultsVersion;
    return {
      format: "stv-ai-translator-settings",
      version: 1,
      settings: exported
    };
  }

  function storageGet(chromeApi, key = STORAGE_KEY) {
    return new Promise((resolve, reject) => {
      chromeApi.storage.local.get(key, (result) => {
        const error = chromeApi.runtime?.lastError;
        if (error) reject(new Error(error.message || "Không thể đọc cài đặt."));
        else resolve(result?.[key]);
      });
    });
  }

  function storageWrite(chromeApi, payload) {
    return new Promise((resolve, reject) => {
      chromeApi.storage.local.set(payload, () => {
        const error = chromeApi.runtime?.lastError;
        if (error) reject(new Error(error.message || "Không thể lưu dữ liệu."));
        else resolve();
      });
    });
  }

  function storageRemove(chromeApi, keys) {
    if (!keys.length || typeof chromeApi.storage.local.remove !== "function") return Promise.resolve();
    return new Promise((resolve, reject) => chromeApi.storage.local.remove(keys, () => {
      const error = chromeApi.runtime?.lastError;
      if (error) reject(new Error(error.message || "Không thể xóa dữ liệu cũ.")); else resolve();
    }));
  }

  function storageSet(chromeApi, settings) {
    return new Promise((resolve, reject) => {
      chromeApi.storage.local.set({ [STORAGE_KEY]: copySettings(settings) }, () => {
        const error = chromeApi.runtime?.lastError;
        if (error) reject(new Error(error.message || "Không thể lưu cài đặt."));
        else resolve();
      });
    });
  }

  function runtimeCall(chromeApi, message) {
    return new Promise((resolve, reject) => {
      chromeApi.runtime.sendMessage(message, value => {
        const error = chromeApi.runtime?.lastError;
        if (error) reject(new Error(error.message || "Không thể kết nối phần nền."));
        else resolve(value);
      });
    });
  }

  function readForm(document, base = {}) {
    return sanitizeSettings({
      ...base,
      provider: document.getElementById("provider").value,
      webAiTabCount: Number(document.getElementById("webAiTabCount").value),
      apiTemperature: Number(document.getElementById("apiTemperature").value),
      systemPrompt: document.getElementById("systemPrompt").value,
      userPrompt: document.getElementById("userPrompt").value,
      nameGuide: document.getElementById("nameGuide").value,
      ttsPronunciationGuide: document.getElementById("ttsPronunciationGuide").value
    });
  }

  function writeForm(document, settings) {
    const safe = sanitizeSettings(settings);
    document.getElementById("provider").value = safe.provider;
    document.getElementById("webAiTabCount").value = String(safe.webAiTabCount);
    document.getElementById("geminiSafetyOff").checked = safe.geminiSafetyOff;
    document.getElementById("apiTemperature").value = String(safe.apiTemperature);
    document.getElementById("apiTemperatureValue").textContent = safe.apiTemperature.toFixed(1);
    document.getElementById("systemPrompt").value = safe.systemPrompt;
    document.getElementById("userPrompt").value = safe.userPrompt;
    document.getElementById("nameGuide").value = safe.nameGuide;
    document.getElementById("ttsPronunciationGuide").value = safe.ttsPronunciationGuide;
  }

  function setStatus(document, message, tone = "neutral") {
    const status = document.getElementById("saveStatus");
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function defaultDownload(text, document, filename = "phwgna-stv-backup.json") {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function readFileText(file) {
    if (typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")));
      reader.addEventListener("error", () => reject(new Error("Không thể đọc tệp JSON.")));
      reader.readAsText(file);
    });
  }

  function validateImportFile(file) {
    if (!file || typeof file.size !== "number") throw new Error("Không tìm thấy tệp JSON.");
    if (file.size > MAX_IMPORT_BYTES) throw new Error("Tệp JSON quá lớn; giới hạn là 5 MB.");
    return true;
  }

  async function initOptions({ document, chromeApi, downloadText = defaultDownload }) {
    if (!document || !chromeApi?.storage?.local) {
      throw new Error("Không tìm thấy bộ nhớ của tiện ích.");
    }

    const form = document.getElementById("settingsForm");
    renderSupportedSites(document);
    const importInput = document.getElementById("importFile");
    const storedSettings = await storageGet(chromeApi);
    let draftSettings;
    let migratedSettings = storedSettings;
    let settingsChanged = false;
    if (storedSettings && typeof storedSettings === "object" && core?.migrateSettingsDefaults) {
      const migration = core.migrateSettingsDefaults(storedSettings);
      migratedSettings = migration.settings;
      settingsChanged = migration.changed;
    }
    if (migratedSettings && typeof migratedSettings === "object" && pronunciation?.migrateGuide) {
      const migration = pronunciation.migrateGuide(
        typeof migratedSettings.ttsPronunciationGuide === "string"
          ? migratedSettings.ttsPronunciationGuide
          : DEFAULT_SETTINGS.ttsPronunciationGuide,
        migratedSettings.ttsPronunciationDefaultsVersion
      );
      draftSettings = sanitizeSettings({
        ...migratedSettings,
        ttsPronunciationGuide: migration.guide,
        ttsPronunciationDefaultsVersion: migration.version
      });
      if (settingsChanged || migration.changed) await storageSet(chromeApi, draftSettings);
    } else {
      draftSettings = sanitizeSettings(migratedSettings);
      if (settingsChanged) await storageSet(chromeApi, draftSettings);
    }
    let formBaseline = copySettings(draftSettings);
    let uiScale = normalizeUiScale(await storageGet(chromeApi, UI_SCALE_KEY));
    let developerKeepAiTabs = await storageGet(chromeApi, DEVELOPER_KEEP_TABS_KEY) === true;
    const storedCredentials = await storageGet(chromeApi, CREDENTIALS_KEY);
    const credentials = {};
    for (const provider of API_PROVIDERS) if (typeof storedCredentials?.[provider] === "string") credentials[provider] = storedCredentials[provider];
    let currentProvider = draftSettings.provider;
    let pendingImportText = "";
    const importPreview = document.getElementById("importPreview");
    const restoreImportButton = document.getElementById("restoreImportButton");
    const storedRollback = await storageGet(chromeApi, ROLLBACK_KEY);
    restoreImportButton.hidden = storedRollback?.format !== dataBackup?.FORMAT;
    async function readUi() {
      const values = {};
      for (const key of UI_BACKUP_KEYS) values[key] = await storageGet(chromeApi, key);
      return sanitizeUi(values);
    }

    function captureApiFields() {
      if (!API_PROVIDERS.includes(currentProvider)) return;
      credentials[currentProvider] = String(document.getElementById("apiKey").value || "").trim();
      const model = String(document.getElementById("apiModel").value || "").trim();
      if (model) draftSettings[MODEL_KEYS[currentProvider]] = model;
      if (currentProvider === "gemini_api") draftSettings.geminiSafetyOff = document.getElementById("geminiSafetyOff").checked;
    }
    function updateProviderPanel() {
      const isApi = API_PROVIDERS.includes(currentProvider);
      document.getElementById("apiPanel").hidden = !isApi;
      document.getElementById("webAiTabCountRow").hidden = isApi;
      document.getElementById("geminiSafetyRow").hidden = currentProvider !== "gemini_api";
      if (isApi) {
        document.getElementById("apiKey").value = credentials[currentProvider] || "";
        document.getElementById("apiModel").value = draftSettings[MODEL_KEYS[currentProvider]] || "";
      }
      document.getElementById("apiTestStatus").textContent = "";
    }
    writeForm(document, draftSettings);
    const uiScaleInput = document.getElementById(UI_SCALE_KEY);
    const uiScaleOutput = document.getElementById(`${UI_SCALE_KEY}Value`);
    const showUiScale = value => {
      uiScale = normalizeUiScale(value);
      uiScaleInput.value = String(uiScale);
      uiScaleOutput.textContent = `${Math.round(uiScale * 100)}%`;
      return uiScale;
    };
    showUiScale(uiScale);
    let uiScaleWrite = Promise.resolve();
    document.getElementById("developerKeepAiTabs").checked = developerKeepAiTabs;
    updateProviderPanel();
    setStatus(document, "Đã tải cài đặt.");

    const portableStatus = document.getElementById("portableStatus");
    const portableCandidates = document.getElementById("portableCandidates");
    const portableItemsNode = document.getElementById("portableItems");
    const portableStart = document.getElementById("portableLearnStart");
    const portableFinish = document.getElementById("portableLearnFinish");
    const portableApprove = document.getElementById("portableApprove");
    let portableSessionId = "", portableItems = [];
    const portableLabel = category => category === "nativeNames" ? "Bộ Name STV" : "Cài đặt STV";
    function portableItemIdentity(item) {
      const inferredKey = String(item.storageKey || String(item.itemId || "").replace(/^[^:]+:/, ""));
      const scope = item.scope || (inferredKey === "qtOnline0" ? "shared"
        : item.category === "nativeNames" ? "story" : "setting");
      if (scope === "shared") return {
        title: "Bộ Name dùng chung",
        description: "Áp dụng cho mọi truyện"
      };
      if (item.category === "nativeNames") return {
        title: "Bộ Name STV đã chọn",
        description: inferredKey ? `Khóa STV: ${inferredKey}` : "Dữ liệu Name đã xác nhận"
      };
      return {
        title: "Cài đặt STV",
        description: inferredKey ? `Khóa STV: ${inferredKey}` : "Cài đặt đã xác nhận"
      };
    }
    function setPortableStatus(message, tone = "neutral") {
      portableStatus.textContent = message;
      portableStatus.dataset.tone = tone;
    }
    function renderPortableItems(items) {
      portableItems = Array.isArray(items) ? items.filter(item => item?.scope !== "story") : [];
      portableItemsNode.replaceChildren();
      const scopeOrder = { shared: 0, custom: 1, setting: 2 };
      portableItems.sort((left, right) => {
        const leftIdentity = portableItemIdentity(left), rightIdentity = portableItemIdentity(right);
        const leftScope = left.scope || (leftIdentity.title.includes("dùng chung") ? "shared" : left.category === "nativeNames" ? "custom" : "setting");
        const rightScope = right.scope || (rightIdentity.title.includes("dùng chung") ? "shared" : right.category === "nativeNames" ? "custom" : "setting");
        return (scopeOrder[leftScope] ?? 9) - (scopeOrder[rightScope] ?? 9)
          || leftIdentity.title.localeCompare(rightIdentity.title, "vi");
      });
      for (const item of portableItems) {
        const identity = portableItemIdentity(item);
        const row = document.createElement("div"); row.className = "portable-row";
        const meta = document.createElement("div"); meta.className = "portable-row__meta";
        const title = document.createElement("strong"); title.textContent = identity.title;
        const detail = document.createElement("div"); detail.className = "field-help";
        detail.textContent = `${identity.description} · ${Number(item.keyCount) || 0} tên miền · ${Number(item.chars) || 0} ký tự · Đang bật`;
        meta.append(title, detail);
        const spacer = document.createElement("span");
        const disable = document.createElement("button"); disable.type = "button";
        disable.className = "button button--secondary"; disable.textContent = "Tắt";
        disable.setAttribute("aria-label", `Tắt đồng bộ ${identity.title}`);
        disable.addEventListener("click", async () => {
          disable.disabled = true;
          try {
            const response = await runtimeCall(chromeApi, { type: "STVAI_PORTABLE_DISABLE", itemId: item.itemId });
            if (!response?.ok) throw new Error(response?.code || "Không tắt được đồng bộ.");
            renderPortableItems(response.items); setPortableStatus("Đã tắt đồng bộ; dữ liệu trên STV được giữ nguyên.", "success");
          } catch (error) { setPortableStatus(error.message, "error"); disable.disabled = false; }
        });
        row.append(meta, spacer, disable); portableItemsNode.append(row);
      }
      setPortableStatus(portableItems.length
        ? `Đang đồng bộ ${portableItems.length} mục dữ liệu STV.`
        : "Chưa có dữ liệu STV gốc được đồng bộ.", portableItems.length ? "success" : "neutral");
    }
    function renderPortableCandidates(candidates) {
      portableCandidates.replaceChildren();
      for (const candidate of candidates || []) {
        const row = document.createElement("div"); row.className = "portable-row"; row.dataset.key = candidate.key;
        const meta = document.createElement("label"); meta.className = "portable-row__meta";
        const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = true;
        const key = document.createElement("code"); key.textContent = candidate.key;
        const detail = document.createElement("span"); detail.className = "field-help";
        detail.textContent = ` ${candidate.kind === "array" ? "Danh sách" : "Dữ liệu"} · ${Number(candidate.chars) || 0} ký tự`;
        meta.append(enabled, " ", key, detail);
        const category = document.createElement("select"); category.setAttribute("aria-label", `Loại dữ liệu ${candidate.key}`);
        for (const [value, label] of [["nativeNames", "Bộ Name STV"], ["nativePreferences", "Cài đặt STV"]]) {
          const option = document.createElement("option"); option.value = value; option.textContent = label; category.append(option);
        }
        const target = document.createElement("select"); target.setAttribute("aria-label", `Ghép dữ liệu ${candidate.key}`);
        const newItem = document.createElement("option"); newItem.value = ""; newItem.textContent = "Tạo mục đồng bộ mới"; target.append(newItem);
        for (const item of portableItems) {
          const option = document.createElement("option"); option.value = item.itemId;
          option.textContent = `Ghép với ${portableLabel(item.category)}`; target.append(option);
        }
        row.append(meta, category, target); portableCandidates.append(row);
      }
      portableApprove.hidden = !(candidates || []).length;
    }
    if (typeof chromeApi.runtime?.sendMessage === "function") {
      try {
        const response = await runtimeCall(chromeApi, { type: "STVAI_PORTABLE_STATUS" });
        if (response?.ok) {
          renderPortableItems(response.items);
          portableSessionId = response.sessionId || "";
          portableFinish.disabled = !portableSessionId;
        }
      } catch (_) { setPortableStatus("Chưa kết nối được dịch vụ đồng bộ STV.", "error"); }
    }
    portableStart.addEventListener("click", async () => {
      portableStart.disabled = true;
      try {
        const response = await runtimeCall(chromeApi, { type: "STVAI_PORTABLE_LEARN_START" });
        if (!response?.ok) throw new Error(response?.code === "portable_no_stv_tab"
          ? "Hãy mở một tab STV HTTPS rồi thử lại." : "Không bắt đầu được quá trình tìm dữ liệu.");
        portableSessionId = response.sessionId; portableFinish.disabled = false;
        setPortableStatus("Hãy sang tab STV, sửa hoặc lưu Bộ Name/cài đặt cần đồng bộ, rồi quay lại bấm Kiểm tra thay đổi.", "success");
      } catch (error) { setPortableStatus(error.message, "error"); portableStart.disabled = false; }
    });
    portableFinish.addEventListener("click", async () => {
      portableFinish.disabled = true;
      try {
        const response = await runtimeCall(chromeApi, { type: "STVAI_PORTABLE_LEARN_FINISH", sessionId: portableSessionId });
        if (!response?.ok) throw new Error("Không đọc được thay đổi từ tab STV đã chọn.");
        renderPortableCandidates(response.candidates);
        setPortableStatus(response.candidates.length ? "Chọn loại dữ liệu rồi xác nhận đồng bộ." : "Không tìm thấy dữ liệu JSON an toàn vừa thay đổi.");
      } catch (error) { setPortableStatus(error.message, "error"); portableFinish.disabled = false; }
    });
    portableApprove.addEventListener("click", async () => {
      const selections = Array.from(portableCandidates.querySelectorAll(".portable-row")).flatMap(row => {
        if (!row.querySelector('input[type="checkbox"]').checked) return [];
        const selection = { key: row.dataset.key, category: row.querySelectorAll("select")[0].value };
        const itemId = row.querySelectorAll("select")[1].value;
        if (itemId) selection.itemId = itemId;
        return [selection];
      });
      if (!selections.length) { setPortableStatus("Hãy chọn ít nhất một dữ liệu.", "error"); return; }
      portableApprove.disabled = true;
      try {
        const response = await runtimeCall(chromeApi, { type: "STVAI_PORTABLE_APPROVE", sessionId: portableSessionId, selections });
        if (!response?.ok) throw new Error(response?.code || "Không lưu được dữ liệu STV.");
        portableSessionId = ""; renderPortableCandidates([]); renderPortableItems(response.items);
        portableStart.disabled = false; portableFinish.disabled = true;
        setPortableStatus("Đã bật đồng bộ dữ liệu STV gốc.", "success");
      } catch (error) { setPortableStatus(error.message, "error"); portableApprove.disabled = false; }
    });

    async function save() {
      const saveButton = document.getElementById("saveButton");
      saveButton.disabled = true;
      setStatus(document, "Đang lưu cài đặt…");
      try {
        captureApiFields();
        const formSettings = readForm(document, draftSettings);
        const latestSettings = sanitizeSettings(await storageGet(chromeApi));
        const mergedSettings = copySettings(latestSettings);
        for (const key of SETTING_KEYS) {
          if (formSettings[key] !== formBaseline[key]) mergedSettings[key] = formSettings[key];
        }
        draftSettings = sanitizeSettings(mergedSettings);
        developerKeepAiTabs = document.getElementById("developerKeepAiTabs").checked;
        const payload = {
          [STORAGE_KEY]: copySettings(draftSettings),
          [DEVELOPER_KEEP_TABS_KEY]: developerKeepAiTabs
        };
        if (API_PROVIDERS.includes(draftSettings.provider) || Object.keys(credentials).length) payload[CREDENTIALS_KEY] = { ...credentials };
        await storageWrite(chromeApi, payload);
        formBaseline = copySettings(draftSettings);
        currentProvider = draftSettings.provider;
        writeForm(document, draftSettings);
        updateProviderPanel();
        setStatus(document, "Đã lưu cài đặt.", "success");
        return draftSettings;
      } finally {
        saveButton.disabled = false;
      }
    }

    async function reset() {
      await uiScaleWrite.catch(() => undefined);
      draftSettings = copySettings(DEFAULT_SETTINGS);
      formBaseline = copySettings(DEFAULT_SETTINGS);
      currentProvider = draftSettings.provider;
      writeForm(document, DEFAULT_SETTINGS);
      developerKeepAiTabs = false;
      showUiScale(1);
      document.getElementById("developerKeepAiTabs").checked = false;
      await storageWrite(chromeApi, {
        [STORAGE_KEY]: copySettings(DEFAULT_SETTINGS),
        [DEVELOPER_KEEP_TABS_KEY]: false,
        [UI_SCALE_KEY]: 1
      });
      updateProviderPanel();
      setStatus(document, "Đã khôi phục và lưu cài đặt mặc định.", "success");
      return copySettings(DEFAULT_SETTINGS);
    }

    async function importText(text) {
      let payload;
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
      if (payload?.format === dataBackup?.FORMAT) {
        const validated = dataBackup.validatePayload(payload, { sanitizeSettings, history, portable });
        if (!validated.ok) throw new Error(`Tệp sao lưu không hợp lệ (${validated.code}).`);
        const currentSettings = sanitizeSettings(await storageGet(chromeApi));
        const currentHistory = await storageGet(chromeApi, HISTORY_KEY);
        const currentPortable = await storageGet(chromeApi, PORTABLE_KEY);
        const currentUi = await readUi();
        const rollback = dataBackup.createPayload({
          settings: currentSettings,
          ui: currentUi,
          history: currentHistory,
          portable: currentPortable
        });
        rollback.missingUiKeys = UI_BACKUP_KEYS.filter(key => !Object.hasOwn(currentUi, key));
        const settings = validated.settings;
        const importedUi = sanitizeUi(validated.ui);
        const importedUiScale = Object.hasOwn(importedUi, UI_SCALE_KEY)
          ? importedUi[UI_SCALE_KEY] : normalizeUiScale(currentUi[UI_SCALE_KEY]);
        await storageWrite(chromeApi, {
          [ROLLBACK_KEY]: rollback,
          [STORAGE_KEY]: copySettings(settings),
          ...importedUi,
          [HISTORY_KEY]: dataBackup.mergeHistory(currentHistory, validated.history),
          [PORTABLE_KEY]: dataBackup.mergePortable(currentPortable, validated.portable)
        });
        draftSettings = settings;
        formBaseline = copySettings(settings);
        currentProvider = settings.provider;
        uiScale = showUiScale(importedUiScale);
        writeForm(document, settings);
        updateProviderPanel();
        setStatus(document, "Đã nhập và lưu dữ liệu.", "success");
        return settings;
      }
      if (payload?.name && typeof payload.name === 'object' && !Array.isArray(payload.name)) {
        const validated = dataBackup.validateStvExport(payload, {
          history, portable, origins: defaultSites.ORIGINS
        });
        if (!validated.ok) throw new Error(`Tệp STV không hợp lệ (${validated.code}).`);
        const currentHistory = await storageGet(chromeApi, HISTORY_KEY);
        const currentPortable = await storageGet(chromeApi, PORTABLE_KEY);
        const currentUi = await readUi();
        const rollback = dataBackup.createPayload({
          settings: sanitizeSettings(await storageGet(chromeApi)), ui: currentUi,
          history: currentHistory, portable: currentPortable
        });
        rollback.missingUiKeys = UI_BACKUP_KEYS.filter(key => !Object.hasOwn(currentUi, key));
        await storageWrite(chromeApi, {
          [ROLLBACK_KEY]: rollback,
          [HISTORY_KEY]: dataBackup.mergeHistory(currentHistory, validated.history),
          [PORTABLE_KEY]: dataBackup.mergePortable(currentPortable, validated.portable)
        });
        setStatus(document, "Đã nhập lịch sử và Bộ Name từ STV.", "success");
        return copySettings(draftSettings);
      }
      const settings = parseImportText(text);
      const currentUi = await readUi();
      const rollback = dataBackup.createPayload({
        settings: sanitizeSettings(await storageGet(chromeApi)),
        ui: currentUi,
        history: await storageGet(chromeApi, HISTORY_KEY),
        portable: await storageGet(chromeApi, PORTABLE_KEY)
      });
      rollback.missingUiKeys = UI_BACKUP_KEYS.filter(key => !Object.hasOwn(currentUi, key));
      await storageWrite(chromeApi, { [ROLLBACK_KEY]: rollback, [STORAGE_KEY]: copySettings(settings) });
      draftSettings = settings;
      formBaseline = copySettings(settings);
      currentProvider = settings.provider;
      writeForm(document, settings);
      updateProviderPanel();
      setStatus(document, "Đã nhập và lưu cài đặt.", "success");
      return settings;
    }

    function previewImportText(text) {
      let payload;
      try { payload = JSON.parse(text); } catch (_) { throw new Error("Tệp không phải JSON hợp lệ."); }
      let summary;
      if (payload?.format === dataBackup?.FORMAT) {
        const validated = dataBackup.validatePayload(payload, { sanitizeSettings, history, portable });
        if (!validated.ok) throw new Error(`Tệp sao lưu không hợp lệ (${validated.code}).`);
        const created = new Date(validated.generatedAt || Date.now());
        const date = [created.getUTCDate(), created.getUTCMonth() + 1].map(value => String(value).padStart(2, "0"))
          .concat(created.getUTCFullYear()).join("/");
        const shelfCount = Object.keys(validated.history.entries || {}).length;
        const nativeNameCount = Object.values(validated.portable.items || {}).filter(item => item.category === "nativeNames").length;
        const nativePreferenceCount = Object.values(validated.portable.items || {}).filter(item => item.category === "nativePreferences").length;
        summary = `${date}: cài đặt tool, ${shelfCount} mục lịch sử, ${nativeNameCount} Bộ Name STV và ${nativePreferenceCount} cài đặt STV.`;
      } else if (payload?.name && typeof payload.name === 'object' && !Array.isArray(payload.name)) {
        const validated = dataBackup.validateStvExport(payload, {
          history, portable, origins: defaultSites.ORIGINS
        });
        if (!validated.ok) throw new Error(`Tệp STV không hợp lệ (${validated.code}).`);
        summary = `Tệp STV: ${validated.historyCount} mục lịch sử và ${validated.nativeNameCount} Bộ Name. Cài đặt tool được giữ nguyên.`;
      } else {
        parseImportText(text);
        summary = "Tệp cài đặt tool phiên bản cũ. Dữ liệu STV hiện tại sẽ được giữ nguyên.";
      }
      pendingImportText = text;
      document.getElementById("importPreviewSummary").textContent = summary;
      importPreview.hidden = false;
      return summary;
    }

    async function confirmImport() {
      if (!pendingImportText) throw new Error("Chưa chọn tệp dữ liệu để nhập.");
      const text = pendingImportText;
      pendingImportText = "";
      try {
        const settings = await importText(text);
        restoreImportButton.hidden = false;
        return settings;
      } finally {
        importPreview.hidden = true;
      }
    }

    async function restoreLastImport() {
      const rollback = await storageGet(chromeApi, ROLLBACK_KEY);
      const validated = dataBackup.validatePayload(rollback, { sanitizeSettings, history, portable });
      if (!validated.ok) throw new Error("Không còn bản hoàn tác hợp lệ.");
      const settings = validated.settings;
      const restoredUi = sanitizeUi(validated.ui);
      const restoredUiScale = normalizeUiScale(restoredUi[UI_SCALE_KEY]);
      await storageWrite(chromeApi, {
        [ROLLBACK_KEY]: null,
        [STORAGE_KEY]: copySettings(settings),
        ...restoredUi,
        [HISTORY_KEY]: validated.history,
        [PORTABLE_KEY]: validated.portable
      });
      await storageRemove(chromeApi, Array.isArray(rollback.missingUiKeys)
        ? rollback.missingUiKeys.filter(key => UI_BACKUP_KEYS.includes(key)) : []);
      draftSettings = settings;
      formBaseline = copySettings(settings);
      currentProvider = settings.provider;
      uiScale = showUiScale(restoredUiScale);
      writeForm(document, settings);
      updateProviderPanel();
      restoreImportButton.hidden = true;
      setStatus(document, "Đã hoàn tác lần nhập gần nhất.", "success");
      return settings;
    }

    async function exportData() {
      captureApiFields();
      const payload = dataBackup.createPayload({
        settings: readForm(document, draftSettings),
        ui: await readUi(),
        history: await storageGet(chromeApi, HISTORY_KEY),
        portable: await storageGet(chromeApi, PORTABLE_KEY)
      });
      const text = `${JSON.stringify(payload, null, 2)}\n`;
      downloadText(text, document, "phwgna-stv-backup.json");
      setStatus(document, "Đã xuất tệp sao lưu dữ liệu.", "success");
      return payload;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save().catch((error) => setStatus(document, error.message, "error"));
    });
    document.getElementById("provider").addEventListener("change", () => {
      captureApiFields();
      currentProvider = document.getElementById("provider").value;
      draftSettings.provider = currentProvider;
      updateProviderPanel();
    });
    document.getElementById("toggleApiKey").addEventListener("click", () => {
      const input = document.getElementById("apiKey");
      input.type = input.type === "password" ? "text" : "password";
      document.getElementById("toggleApiKey").textContent = input.type === "password" ? "Hiện" : "Ẩn";
    });
    document.getElementById("apiTemperature").addEventListener("input", (event) => {
      document.getElementById("apiTemperatureValue").textContent = Number(event.currentTarget.value).toFixed(1);
    });
    uiScaleInput.addEventListener("input", event => {
      const value = showUiScale(event.currentTarget.value);
      uiScaleWrite = uiScaleWrite.catch(() => undefined).then(() => storageWrite(chromeApi, {
        [UI_SCALE_KEY]: value
      })).then(() => setStatus(document, `Đã lưu kích thước menu ${Math.round(value * 100)}%.`, "success"),
        error => setStatus(document, error?.message || "Không lưu được kích thước menu.", "error"));
    });
    async function testApi() {
      captureApiFields();
      const button = document.getElementById("testApi");
      const status = document.getElementById("apiTestStatus");
      button.disabled = true;
      status.textContent = "Đang kiểm tra…";
      try {
        const response = await new Promise((resolve, reject) => chromeApi.runtime.sendMessage({
          type: "STVAI_TEST_API", provider: currentProvider,
          apiKey: credentials[currentProvider] || "",
          model: draftSettings[MODEL_KEYS[currentProvider]],
          safetyOff: currentProvider === "gemini_api" && draftSettings.geminiSafetyOff
        }, (value) => {
          const error = chromeApi.runtime?.lastError;
          if (error) reject(new Error(error.message)); else resolve(value);
        }));
        if (!response?.ok) throw new Error(response?.reason || "API test failed");
        status.textContent = `Đã kết nối ${response.model || "model"} trong ${response.latencyMs || 0} ms.`;
        return response;
      } catch (error) {
        status.textContent = `Không thể kết nối: ${error.message}`;
        return { ok: false, reason: error.message };
      } finally { button.disabled = false; }
    }
    document.getElementById("testApi").addEventListener("click", () => { void testApi(); });
    form.addEventListener("input", event => {
      if (event.target?.id !== UI_SCALE_KEY) setStatus(document, "Có thay đổi chưa lưu.");
    });
    document.getElementById("resetButton").addEventListener("click", () => {
      reset().catch((error) => setStatus(document, error.message, "error"));
    });
    document.getElementById("importButton").addEventListener("click", () => importInput.click());
    document.getElementById("importPreviewCancel").addEventListener("click", () => {
      pendingImportText = "";
      importPreview.hidden = true;
    });
    document.getElementById("importPreviewConfirm").addEventListener("click", () => {
      void confirmImport().catch(error => setStatus(document, error.message, "error"));
    });
    restoreImportButton.addEventListener("click", () => {
      void restoreLastImport().catch(error => setStatus(document, error.message, "error"));
    });
    document.getElementById("exportButton").addEventListener("click", () => {
      void exportData().catch(error => setStatus(document, error.message, "error"));
    });
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        validateImportFile(file);
        previewImportText(await readFileText(file));
      } catch (error) {
        setStatus(document, error instanceof Error ? error.message : "Không thể nhập cài đặt.", "error");
      } finally {
        importInput.value = "";
      }
    });

    return Object.freeze({ save, reset, importText, previewImportText, confirmImport, restoreLastImport, exportData, testApi });
  }

  return Object.freeze({
    DEFAULT_SETTINGS,
    SETTING_KEYS,
    sanitizeSettings,
    parseImportText,
    createExportPayload,
    validateImportFile,
    renderSupportedSites,
    initOptions
  });
});
