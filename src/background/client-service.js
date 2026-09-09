(function attachClientService(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIBackgroundClientService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createClientServiceApi() {
  "use strict";

  const CLIENT_STORAGE_KEYS = Object.freeze([
    "settings", "toolEnabled", "transmissionConsent", "automationConsentVersion",
    "automationConsentProvider", "ttsConsent", "ttsConsentVersion",
    "stvaiNavigationExpanded", "stvaiToolbarCollapsed",
    "stvaiTtsOverlayPositionV1", "stvaiUiScale",
    "stvaiToolbarPositionV2", "stvaiNameEditorPositionV2", "stvaiNameManagerPositionV2"
  ]);
  const POSITION_KEYS = new Set([
    "stvaiTtsOverlayPositionV1", "stvaiToolbarPositionV2",
    "stvaiNameEditorPositionV2", "stvaiNameManagerPositionV2"
  ]);
  const BOOLEAN_KEYS = new Set([
    "transmissionConsent", "ttsConsent", "stvaiNavigationExpanded", "stvaiToolbarCollapsed"
  ]);
  const UI_SCALES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5]);
  const ZOOM_STORAGE_KEYS = Object.freeze({
    general: "stvaiZoomGeneralPercent",
    story: "stvaiZoomStoryPercent"
  });

  function createClientService(options = {}) {
    const { core, pronunciation, sites, storage, tabs, storageCall, isStvUrl } = options;
    const zoomQueues = new Map();
    const zoomNavigations = new Map();

    function isStvSender(sender) {
      return (sender?.frameId == null || sender.frameId === 0)
        && isStvUrl(sender?.url || sender?.tab?.url);
    }

    function safeSettings(value) {
      const settings = core.normalizeSettings(value || {});
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
        ttsPronunciationGuide: settings.ttsPronunciationGuide,
        ttsPronunciationDefaultsVersion: settings.ttsPronunciationDefaultsVersion,
        settingsDefaultsVersion: settings.settingsDefaultsVersion,
        nameGuide: settings.nameGuide
      };
    }

    async function migrateSettings(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      let settings = { ...value };
      let changed = false;
      if (core?.migrateSettingsDefaults) {
        const migration = core.migrateSettingsDefaults(settings);
        settings = migration.settings;
        changed = migration.changed;
      }
      if (pronunciation?.migrateGuide) {
        const migration = pronunciation.migrateGuide(
          typeof settings.ttsPronunciationGuide === "string"
            ? settings.ttsPronunciationGuide
            : pronunciation.DEFAULT_GUIDE,
          settings.ttsPronunciationDefaultsVersion
        );
        settings = {
          ...settings,
          ttsPronunciationGuide: migration.guide,
          ttsPronunciationDefaultsVersion: migration.version
        };
        changed = changed || migration.changed;
      }
      if (changed && storage?.local?.set) {
        await storageCall(storage.local, "set", { settings });
      }
      return settings;
    }

    function position(value) {
      if (typeof value?.x !== "number" || typeof value?.y !== "number"
        || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
      return {
        x: Math.min(1, Math.max(0, value.x)),
        y: Math.min(1, Math.max(0, value.y))
      };
    }

    function uiScale(value) {
      const number = Number(value);
      return UI_SCALES.includes(number) ? number : 1;
    }

    async function storageGet(message, sender) {
      if (!isStvSender(sender)) return { ok: false, reason: "unauthorized-sender" };
      const requested = Array.isArray(message.keys) ? message.keys : [message.keys];
      const keys = requested.filter((key) => CLIENT_STORAGE_KEYS.includes(key));
      const stored = keys.length && storage?.local?.get
        ? await storageCall(storage.local, "get", keys)
        : {};
      const values = {};
      for (const key of keys) {
        if (key === "settings") {
          const storedSettings = await migrateSettings(stored?.settings);
          values.settings = safeSettings(storedSettings);
        } else if (POSITION_KEYS.has(key)) {
          const savedPosition = position(stored?.[key]);
          if (savedPosition) values[key] = savedPosition;
        } else if (key === "stvaiUiScale") values[key] = uiScale(stored?.[key]);
        else if (Object.hasOwn(stored || {}, key)) values[key] = stored[key];
      }
      return { ok: true, values };
    }

    async function storageSet(message, sender) {
      if (!isStvSender(sender)) return { ok: false, reason: "unauthorized-sender" };
      if (!storage?.local?.set) return { ok: false, reason: "storage_unavailable" };
      const source = message?.values && typeof message.values === "object" ? message.values : {};
      const values = {};
      for (const key of CLIENT_STORAGE_KEYS) {
        if (!Object.hasOwn(source, key)) continue;
        if (key === "settings") values.settings = safeSettings(source.settings);
        else if (BOOLEAN_KEYS.has(key) && typeof source[key] === "boolean") values[key] = source[key];
        else if (key === "automationConsentVersion" && Number.isFinite(Number(source[key]))) values[key] = Math.max(0, Math.trunc(Number(source[key])));
        else if (key === "ttsConsentVersion" && source[key] === 2) values[key] = 2;
        else if (key === "automationConsentProvider" && core.PROVIDERS.includes(source[key])) values[key] = source[key];
        else if (POSITION_KEYS.has(key)) {
          const savedPosition = position(source[key]);
          if (savedPosition) values[key] = savedPosition;
        } else if (key === "stvaiUiScale" && UI_SCALES.includes(Number(source[key]))) {
          values[key] = Number(source[key]);
        }
      }
      if (!Object.keys(values).length) return { ok: false, reason: "empty-patch" };
      await storageCall(storage.local, "set", values);
      return { ok: true };
    }

    function zoomPercent(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return 0;
      const percent = Math.round(number);
      return percent >= 25 && percent <= 500 ? percent : 0;
    }

    function zoomProfileForUrl(value) {
      return sites?.zoomProfile?.(value) || "";
    }

    function queueZoom(tabId, operation) {
      const previous = zoomQueues.get(tabId) || Promise.resolve();
      const pending = previous.then(operation, operation)
        .catch(() => ({ ok: false, reason: "zoom_unavailable" }));
      zoomQueues.set(tabId, pending);
      return pending.finally(() => {
        if (zoomQueues.get(tabId) === pending) zoomQueues.delete(tabId);
      });
    }

    async function stableZoomContext(tabId, sourceUrl) {
      const stored = await storageCall(storage?.local, "get", "toolEnabled");
      if (stored?.toolEnabled !== true) return null;
      const tab = await tabs.get(tabId);
      if (tab.url !== sourceUrl || (tab.pendingUrl && tab.pendingUrl !== sourceUrl)) return null;
      const profile = zoomProfileForUrl(sourceUrl);
      return profile ? { tab, profile, storageKey: ZOOM_STORAGE_KEYS[profile] } : null;
    }

    async function changeZoom(message, sender) {
      const tabId = sender?.tab?.id;
      const sourceUrl = sender?.url || sender?.tab?.url;
      if (!isStvSender(sender) || !Number.isInteger(tabId)) return { ok: false, reason: "unauthorized-sender" };
      if (message.direction !== 1 && message.direction !== -1) return { ok: false, reason: "invalid_zoom_direction" };
      return queueZoom(tabId, async () => {
        const context = await stableZoomContext(tabId, sourceUrl);
        if (!context) return { ok: false, reason: "stale-page" };
        const current = await tabs.getZoom(tabId);
        if (!Number.isFinite(current) || current <= 0) return { ok: false, reason: "zoom_unavailable" };
        if (!await stableZoomContext(tabId, sourceUrl)) return { ok: false, reason: "stale-page" };
        const percent = Math.max(25, Math.min(500, Math.round(current * 100) + message.direction * 10));
        await tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
        await tabs.setZoom(tabId, percent / 100);
        await storageCall(storage?.local, "set", { [context.storageKey]: percent }).catch(() => undefined);
        return { ok: true, percent };
      });
    }

    async function restoreZoom(_message, sender) {
      const tabId = sender?.tab?.id;
      const sourceUrl = sender?.url || sender?.tab?.url;
      if (!isStvSender(sender) || !Number.isInteger(tabId)) return { ok: false, reason: "unauthorized-sender" };
      return restoreZoomForTab(tabId, sourceUrl);
    }

    async function restoreZoomForTab(tabId, sourceUrl) {
      const result = await queueZoom(tabId, async () => {
        const context = await stableZoomContext(tabId, sourceUrl);
        if (!context) return { ok: false, reason: "stale-page" };
        const current = await tabs.getZoom(tabId);
        if (!Number.isFinite(current) || current <= 0) return { ok: false, reason: "zoom_unavailable" };
        const stored = await storageCall(storage?.local, "get", context.storageKey);
        const savedPercent = zoomPercent(stored?.[context.storageKey]);
        if (!savedPercent) {
          const percent = Math.max(25, Math.min(500, Math.round(current * 100)));
          await storageCall(storage?.local, "set", { [context.storageKey]: percent }).catch(() => undefined);
          return { ok: true, percent, profile: context.profile, initialized: true };
        }
        if (!await stableZoomContext(tabId, sourceUrl)) return { ok: false, reason: "stale-page" };
        if (Math.round(current * 100) !== savedPercent) {
          await tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
          await tabs.setZoom(tabId, savedPercent / 100);
        }
        return { ok: true, percent: savedPercent, profile: context.profile };
      });
      const navigation = zoomNavigations.get(tabId);
      if (navigation?.profile === zoomProfileForUrl(sourceUrl)) zoomNavigations.delete(tabId);
      return result;
    }

    function trackNavigation(tabId, url) {
      zoomNavigations.set(tabId, { profile: zoomProfileForUrl(url) });
    }

    async function handleZoomChanged(changeInfo = {}) {
      const tabId = Number(changeInfo.tabId);
      const percent = zoomPercent(Number(changeInfo.newZoomFactor) * 100);
      if (!Number.isInteger(tabId) || !percent || typeof tabs?.get !== "function") {
        return { ok: false, reason: "invalid_zoom_event" };
      }
      return queueZoom(tabId, async () => {
        const tab = await tabs.get(tabId);
        const url = String(tab?.url || "");
        const navigation = zoomNavigations.get(tabId);
        if (navigation?.profile === zoomProfileForUrl(url)) return { ok: false, reason: "zoom_navigation" };
        if (!isStvUrl(url) || (tab.pendingUrl && tab.pendingUrl !== url)) return { ok: false, reason: "stale-page" };
        const enabled = await storageCall(storage?.local, "get", "toolEnabled");
        if (enabled?.toolEnabled !== true) return { ok: false, reason: "tool_disabled" };
        const profile = zoomProfileForUrl(url);
        const storageKey = ZOOM_STORAGE_KEYS[profile];
        if (!storageKey) return { ok: false, reason: "unsupported-page" };
        await storageCall(storage?.local, "set", { [storageKey]: percent });
        return { ok: true, percent, profile };
      });
    }

    return Object.freeze({
      isStvSender,
      safeSettings,
      migrateSettings,
      uiScale,
      storageGet,
      storageSet,
      changeZoom,
      restoreZoom,
      restoreZoomForTab,
      trackNavigation,
      handleZoomChanged
    });
  }

  return Object.freeze({ createClientService });
});
