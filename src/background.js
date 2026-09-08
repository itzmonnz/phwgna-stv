if (typeof importScripts === "function") {
  importScripts("shared/distribution-channel.js");
  const backgroundImports = ["shared/stv-sites.js", "shared/native-history.js", "shared/history-sync.js", "shared/native-portable.js", "shared/portable-sync.js", "shared/core.js", "shared/tts-pronunciation.js", "shared/cache.js", "shared/name-preview.js", "shared/api-providers.js"];
  if (globalThis.STVAIDistribution?.usesExternalUpdater?.() !== false) backgroundImports.push("shared/update-check.js");
  backgroundImports.push("shared/onboarding.js", "shared/error-journal.js");
  importScripts(...backgroundImports);
}

(function attachBackground(root, factory) {
  const core = root.STVAICore || (typeof require === "function" ? require("./shared/core.js") : null);
  const pronunciation = root.STVAITTSPronunciation || (typeof require === "function" ? require("./shared/tts-pronunciation.js") : null);
  const cacheApi = root.STVAICache || (typeof require === "function" ? require("./shared/cache.js") : null);
  const previewApi = root.STVAINamePreview || (typeof require === "function" ? require("./shared/name-preview.js") : null);
  const apiProviders = root.STVAIApiProviders || (typeof require === "function" ? require("./shared/api-providers.js") : null);
  const sites = root.STVAISites || (typeof require === 'function' ? require('./shared/stv-sites.js') : null);
  const historyApi = root.STVAIHistorySync || (typeof require === 'function' ? require('./shared/history-sync.js') : null);
  const portableSyncApi = root.STVAIPortableSync || (typeof require === 'function' ? require('./shared/portable-sync.js') : null);
  const updateApi = root.STVAIUpdateCheck || (typeof require === "function" ? require("./shared/update-check.js") : null);
  const distributionApi = root.STVAIDistribution || (typeof require === "function" ? require("./shared/distribution-channel.js") : null);
  const onboardingApi = root.STVAIOnboarding || (typeof require === "function" ? require("./shared/onboarding.js") : null);
  const errorJournalApi = root.STVAIErrorJournal || (typeof require === "function" ? require("./shared/error-journal.js") : null);
  const api = factory(core, pronunciation, cacheApi, previewApi, apiProviders, sites, historyApi, portableSyncApi, updateApi, onboardingApi, errorJournalApi, distributionApi);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAIBackground = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundApi(defaultCore, pronunciation, cacheApi, previewApi, defaultApiProviders, sites, historyApi, portableSyncApi, defaultUpdateApi, defaultOnboardingApi, defaultErrorJournalApi, defaultDistribution) {
  "use strict";

  const SETUP_PARTS = ["introduction", "system", "names"];
  const PROVIDER_URLS = Object.freeze({
    chatgpt: "https://chatgpt.com/",
    gemini: "https://gemini.google.com/app"
  });
  const JOB_STORAGE_PREFIX = "stvai-active-job:";
  const POOL_STORAGE_KEY = "stvai-warm-pool";
  const OWNED_TABS_STORAGE_KEY = "stvai-owned-provider-tabs";
  const DOM_PROFILES_STORAGE_KEY = "stvaiDomProfilesV1";
  const CHATGPT_DOM_PROFILES_STORAGE_KEY = "stvaiChatGPTDomProfilesV1";
  const DEVELOPER_KEEP_TABS_KEY = "developerKeepAiTabs";
  const TTS_SESSION_PREFIX = "stvai-tts-session:";
  const AUTOMATION_CONSENT_VERSION = 2;
  const MIN_POOL_TABS = 2;
  const MAX_POOL_TABS = 5;
  const READY_TIMEOUT_MS = 10_000;
  const CHATGPT_READY_TIMEOUT_MS = 13_000;
  const READY_SEND_TIMEOUT_MS = 5_000;
  const CHATGPT_READY_SEND_TIMEOUT_MS = 8_000;
  const CHATGPT_SETUP_INACTIVITY_MS = 30_000;
  const CHATGPT_SETUP_HARD_TIMEOUT_MS = 60_000;
  const READY_MARKER_GRACE_MS = 2_000;
  const MAX_WARM_REPLACEMENTS = 1;
  const PERFORMANCE_HEARTBEAT_MS = 2_000;
  const AUTHENTICATION_BLOCKERS = new Set([
    "login_required", "login_window_open", "captcha", "security_verification", "login_browser_rejected"
  ]);
  const REPLACEABLE_WARM_FAILURES = new Set([
    "content_refused", "ui_changed", "temporary_unavailable", "provider_unreachable",
    "provider_tab_failed", "warm_evidence_missing", "invalid_setup_response",
    "send_not_confirmed", "response_timeout"
  ]);
  const DOM_PROFILE_ROLES = new Set([
    "composer", "send", "stop", "response", "completion", "temporaryLauncher", "temporaryActive"
  ]);

  function sanitizeDomProfileStore(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.profiles)) return null;
    const profiles = [];
    const ids = new Set();
    for (const input of value.profiles.slice(0, 5)) {
      const id = /^[a-z0-9_-]{1,80}$/i.test(String(input?.id || "")) ? String(input.id) : "";
      if (!id || ids.has(id) || input?.schemaVersion !== 1) continue;
      const descriptors = {};
      for (const [role, raw] of Object.entries(input.descriptors || {})) {
        if (!DOM_PROFILE_ROLES.has(role) || !raw || typeof raw !== "object") continue;
        const tag = /^[a-z0-9-]{1,40}$/i.test(String(raw.tag || "")) ? String(raw.tag).toLowerCase() : "";
        if (!tag) continue;
        const descriptor = { tag };
        if (/^[a-z0-9_-]{1,40}$/i.test(String(raw.role || ""))) descriptor.role = String(raw.role).toLowerCase();
        if (typeof raw.contenteditable === "boolean") descriptor.contenteditable = raw.contenteditable;
        if (/^[a-z0-9_-]{1,24}$/i.test(String(raw.type || ""))) descriptor.type = String(raw.type).toLowerCase();
        if (/^[\p{L}\p{N} _-]{1,40}$/u.test(String(raw.semantic || ""))) descriptor.semantic = String(raw.semantic).toLowerCase();
        for (const field of ["classes", "parentClasses"]) {
          if (Array.isArray(raw[field])) descriptor[field] = raw[field].filter(item => (
            typeof item === "string" && /^[a-z0-9_-]{1,80}$/i.test(item)
          )).slice(0, 8);
        }
        if (/^[a-z0-9-]{1,40}$/i.test(String(raw.parentTag || ""))) descriptor.parentTag = String(raw.parentTag).toLowerCase();
        descriptors[role] = descriptor;
      }
      if (!Object.keys(descriptors).length) continue;
      ids.add(id);
      profiles.push({
        id,
        schemaVersion: 1,
        updatedAt: Math.max(0, Number(input.updatedAt) || 0),
        descriptors
      });
    }
    return { schemaVersion: 1, profiles };
  }

  function isAuthenticationBlocker(code) {
    return AUTHENTICATION_BLOCKERS.has(String(code || ""));
  }

  function batchIdAt(index) {
    return `B${String(index + 1).padStart(4, "0")}`;
  }

  function cachedConvertText(value) {
    return String(value || "")
      .replace(/\s*\(h\u1ebft ch\u01b0\u01a1ng\)\s*$/iu, "")
      .trim();
  }

  function exactItems(items, blocks) {
    if (!Array.isArray(items) || items.length !== blocks.length) return false;
    return blocks.every((block, index) => (
      items[index]
      && String(items[index].id) === block.id
      && typeof items[index].text === "string"
      && items[index].text.trim().length > 0
      && (items[index].origin !== "convert"
        || cachedConvertText(items[index].text) === String(block.convert || "").trim())
    ));
  }

  function createBackgroundController(options = {}) {
    const core = options.core || defaultCore;
    const cache = options.cache;
    const tabs = options.tabs;
    const windows = options.windows;
    const debuggerApi = options.debuggerApi;
    const storage = options.storage;
    const runtime = options.runtime;
    const updateChecker = options.updateChecker;
    const extensionVersion = String(options.extensionVersion || "0.0.0");
    const historySync = historyApi.createHistorySync({ storage, tabs });
    const portableSync = options.portableSync || portableSyncApi.createPortableSync({ storage, tabs });
    const apiClient = options.apiClient || defaultApiProviders?.createApiClient?.();
    const namePreview = options.namePreview
      || previewApi?.createNamePreviewService?.({ storage: storage?.local });
    const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 1_500));
    const retrySleep = options.retrySleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const setPerformanceInterval = typeof options.setPerformanceInterval === "function"
      ? options.setPerformanceInterval
      : (callback, milliseconds) => setInterval(callback, milliseconds);
    const clearPerformanceInterval = typeof options.clearPerformanceInterval === "function"
      ? options.clearPerformanceInterval
      : (timer) => clearInterval(timer);
    const now = options.now || Date.now;
    const warmTemporaryTimeoutMs = Math.max(1, Number(options.warmTemporaryTimeoutMs ?? 12_000) || 12_000);
    const providerReadyAttempts = Math.max(1, Number(options.providerReadyAttempts ?? 20) || 1);
    const providerReadyDelayMs = Math.max(0, Number(options.providerReadyDelayMs ?? 250) || 0);
    const providerReadyPasses = Math.max(1, Number(options.providerReadyPasses ?? 12) || 1);
    const providerDiagnosticTimeoutMs = Math.max(1, Number(options.providerDiagnosticTimeoutMs ?? 750) || 750);
    const poolCleanupDelayMs = Math.max(0, Number(options.poolCleanupDelayMs ?? 1_500));
    const poolCleanupSleep = options.poolCleanupSleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (!core || !cache || !tabs) throw new TypeError("core, cache, and tabs are required");

    const onboardingService = defaultOnboardingApi?.createOnboardingService && storage?.local && runtime?.getURL
      ? defaultOnboardingApi.createOnboardingService({ core, storage, tabs, runtime, version: 1 })
      : null;
    const errorJournal = defaultErrorJournalApi?.createErrorJournal?.({
      storage: storage?.local,
      now,
      extensionVersion
    });

    const jobs = new Map();
    const terminalJobLimit = Math.max(1, Math.min(100, Math.trunc(Number(options.terminalJobLimit ?? 20) || 20)));
    let terminalJobSequence = 0;
    function retainTerminalJob(job) {
      if (!job || !["cancelled", "completed"].includes(job.status)) return;
      job.terminalSequence = ++terminalJobSequence;
      const terminal = Array.from(jobs.values())
        .filter(candidate => ["cancelled", "completed"].includes(candidate.status))
        .sort((left, right) => (left.terminalSequence || 0) - (right.terminalSequence || 0));
      while (terminal.length > terminalJobLimit) {
        const expiredIndex = terminal.findIndex(candidate => candidate !== job);
        if (expiredIndex < 0) break;
        const [expired] = terminal.splice(expiredIndex, 1);
        jobs.delete(expired.id);
      }
    }
    const activeNamePreviews = new Map();
    const activeJapaneseLookups = new Map();
    const sessionStorage = storage && storage.session;
    const createId = typeof options.createId === "function"
      ? options.createId
      : (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const warmPool = {
      slots: [],
      diagnosticTabs: [],
      stvTabs: new Map(),
      suspendedStvTabs: new Set(),
      waiters: [],
      provider: "",
      settingsHash: "",
      settings: null,
      errorCode: "",
      restored: false,
      restorePromise: null,
      providerWindowId: null,
      unexpectedReplacementCount: 0,
      targetCount: MIN_POOL_TABS,
      generation: 0,
      reconfiguring: false
    };
    let poolFillOperation = null;
    let poolSerial = Promise.resolve();
    let poolReconfigurationSerial = Promise.resolve();
    let ttsSerial = Promise.resolve();
    const providerForegroundSerials = new Map();
    const providerPerformanceLeases = new Map();
    const providerDebuggerBlockedTabs = new Set();
    let stvPresenceGeneration = 0;

    function withPoolLock(operation) {
      const next = poolSerial.then(operation, operation);
      poolSerial = next.catch(() => undefined);
      return next;
    }

    function withTtsLock(operation) {
      const next = ttsSerial.then(operation, operation);
      ttsSerial = next.catch(() => undefined);
      return next;
    }

    function ttsChapterUrl(value) {
      return sites.chapterUrl(value);
    }

    function ttsNextUrl(value, currentValue) {
      const current = sites.parseChapter(currentValue);
      const next = sites.parseChapter(value, { base: currentValue });
      if (!current || !next || current.origin !== next.origin
        || current.bookKey !== next.bookKey || current.chapterId === next.chapterId) return "";
      return next.url;
    }

    async function clearTtsSession(tabId) {
      return withTtsLock(async () => {
        if (!sessionStorage?.remove) return;
        if (Number.isInteger(tabId)) {
          await storageCall(sessionStorage, "remove", `${TTS_SESSION_PREFIX}${tabId}`);
        } else {
          const stored = await storageCall(sessionStorage, "get", null);
          const keys = Object.keys(stored || {}).filter(key => key.startsWith(TTS_SESSION_PREFIX));
          if (keys.length) await storageCall(sessionStorage, "remove", keys);
        }
      });
    }

    async function trackTtsNavigation(tabId, value) {
      if (!value || !sessionStorage?.get) return;
      return withTtsLock(async () => {
        const key = `${TTS_SESSION_PREFIX}${tabId}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        if (!session) return;
        const url = ttsChapterUrl(value);
        if (url === session.currentUrl) return;
        const current = sites.parseChapter(session.currentUrl);
        const destination = sites.parseChapter(url);
        const followsListeningIntent = session.intent === true
          && current && destination
          && current.origin === destination.origin
          && current.bookKey === destination.bookKey
          && current.chapterId !== destination.chapterId
          && ["playing", "playing_next", "waiting_next"].includes(session.state);
        if (url && (url === session.nextUrl || followsListeningIntent)) {
          await storageCall(sessionStorage, "set", {
            [key]: { ...session, nextUrl: url, state: "waiting_next" }
          });
        } else await storageCall(sessionStorage, "remove", key);
      });
    }

    async function authorizeTtsStart(message, sender, accept) {
      if (!message.ttsSessionId) { accept?.(); return true; }
      return withTtsLock(async () => {
        if (!sessionStorage?.get) return false;
        const key = `${TTS_SESSION_PREFIX}${sender.tab.id}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        const consent = await storageCall(storage.local, "get", ["ttsConsent", "ttsConsentVersion", "toolEnabled"]);
        const currentChapter = resolveStvSenderChapter(sender, message.chapterId);
        if (!consent.ttsConsent || consent.ttsConsentVersion !== 2 || !consent.toolEnabled
          || session?.sessionId !== message.ttsSessionId || session.state !== "waiting_batch_1"
          || session.currentUrl !== currentChapter?.url) return false;
        if (accept) {
          if (session.jobId !== message.jobId) return false;
          accept();
        } else {
          if (session.jobId && session.jobId !== message.jobId) return false;
          if (!session.jobId) {
            await storageCall(sessionStorage, "set", { [key]: { ...session, jobId: message.jobId } });
          }
        }
        return true;
      });
    }

    async function handleTtsSession(message, sender) {
      const tabId = sender?.tab?.id;
      const requestedChapter = sites.parseChapter(message?.currentUrl || message?.url);
      const currentChapter = resolveStvSenderChapter(sender, requestedChapter?.chapterId || "");
      const url = currentChapter?.url || "";
      if (!Number.isInteger(tabId) || !url || (sender.frameId != null && sender.frameId !== 0)) {
        return { ok: false, reason: "unauthorized-sender" };
      }
      return withTtsLock(async () => {
        if (!sessionStorage?.get || !sessionStorage?.set || !sessionStorage?.remove) {
          return { ok: false, reason: "storage_unavailable" };
        }
        const key = `${TTS_SESSION_PREFIX}${tabId}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        if (message.type === "STVAI_TTS_SESSION_CLEAR") {
          // A late event from the departed chapter cannot clear the next owner.
          if (session && session.currentUrl === url
            && (!message.sessionId || message.sessionId === session.sessionId)) {
            await storageCall(sessionStorage, "remove", key);
          }
          return { ok: true };
        }
        const consent = await storageCall(storage?.local, "get", ["toolEnabled", "ttsConsent", "ttsConsentVersion"]);
        if (consent?.toolEnabled !== true || consent.ttsConsent !== true || consent.ttsConsentVersion !== 2) {
          await storageCall(sessionStorage, "remove", key);
          return { ok: false, reason: "tts_consent_required" };
        }
        if (message.type === "STVAI_TTS_SESSION_START") {
          if (ttsChapterUrl(message.currentUrl) !== url) return { ok: false, reason: "chapter_mismatch" };
          const nextUrl = ttsNextUrl(message.nextUrl, url);
          const value = { tabId, currentUrl: url, nextUrl, state: "playing", intent: true,
            sessionId: createId("tts-session") };
          await storageCall(sessionStorage, "set", { [key]: value });
          return { ok: true, state: value.state, sessionId: value.sessionId };
        }
        if (message.type === "STVAI_TTS_SESSION_CLAIM_NEXT") {
          if (!session) return { ok: true, claimed: false };
          const continuingCurrentChapter = message.historyNavigation !== true && message.reload !== true
            && ttsChapterUrl(message.url) === url && session.currentUrl === url
            && ["playing", "waiting_batch_1", "playing_next"].includes(session.state);
          if (continuingCurrentChapter) {
            const live = await tabs.get(tabId).catch(() => null);
            if (ttsChapterUrl(live?.url) !== url) return { ok: true, claimed: false, holdNative: true };
            const value = { ...session, state: "waiting_batch_1" };
            await storageCall(sessionStorage, "set", { [key]: value });
            return { ok: true, claimed: true, state: value.state, sessionId: value.sessionId,
              ...(value.jobId ? { jobId: value.jobId } : {}) };
          }
          if (message.historyNavigation === true || message.reload === true || ttsChapterUrl(message.url) !== url || session.nextUrl !== url) {
            if (session.currentUrl !== url || message.historyNavigation === true || message.reload === true) await storageCall(sessionStorage, "remove", key);
            const holdNative = message.historyNavigation !== true && message.reload !== true
              && session.currentUrl === url;
            return { ok: true, claimed: false,
              ...(holdNative ? { holdNative: true } : {}) };
          }
          const live = await tabs.get(tabId).catch(() => null);
          if (ttsChapterUrl(live?.url) !== url) return { ok: true, claimed: false };
          const value = { tabId, currentUrl: url, nextUrl: "", state: "waiting_batch_1", intent: true,
            sessionId: createId("tts-session") };
          await storageCall(sessionStorage, "set", { [key]: value });
          return { ok: true, claimed: true, state: value.state, sessionId: value.sessionId };
        }
        if (!session || session.sessionId !== message.sessionId || session.currentUrl !== url) {
          return { ok: false, reason: "stale-tts-session" };
        }
        if (!["waiting_next", "waiting_batch_1", "playing_next"].includes(message.state)) {
          return { ok: false, reason: "invalid-tts-state" };
        }
        const nextUrl = ttsNextUrl(message.nextUrl, url);
        await storageCall(sessionStorage, "set", { [key]: { ...session, state: message.state,
          nextUrl: message.state === "playing_next" ? nextUrl : session.nextUrl } });
        return { ok: true };
      });
    }

    function withProviderForegroundLock(tabId, operation) {
      const previous = providerForegroundSerials.get(tabId) || Promise.resolve();
      const next = previous.then(operation, operation);
      const guarded = next.catch(() => undefined);
      providerForegroundSerials.set(tabId, guarded);
      void guarded.finally(() => {
        if (providerForegroundSerials.get(tabId) === guarded) providerForegroundSerials.delete(tabId);
      });
      return next;
    }

    function performanceStage(message) {
      if (message?.phase === "setup") return `ready_${Math.max(1, Number(message.setupIndex) + 1)}`;
      if (message?.phase === "batch" || message?.phase === "repair") return "batch";
      return String(message?.phase || "idle");
    }

    function updateSlotPerformanceLease(tabId, state, stage = "", timeoutMs = 0, reason = "") {
      const slot = findPoolSlotByTab(tabId);
      if (!slot) return;
      slot.performanceLeaseState = state;
      slot.performanceLeaseStage = stage;
      slot.performanceLeaseTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
      slot.performanceLeaseStartedAt = state === "active" ? now() : 0;
      slot.performanceLeaseReason = String(reason || "");
    }

    async function refreshProviderPerformanceLease(tabId, lease) {
      if (!lease?.attached) return;
      if (lease.refreshPromise) return lease.refreshPromise;
      lease.refreshPromise = (async () => {
        const target = { tabId };
        await protectOwnedProviderTab(tabId);
        try {
          await debuggerApi.sendCommand(target, "Page.setWebLifecycleState", { state: "active" });
        } catch (_error) { lease.unsupportedCommands.add("lifecycle"); }
        try {
          await debuggerApi.sendCommand(target, "Emulation.setIdleOverride", {
            isUserActive: true,
            isScreenUnlocked: true
          });
        } catch (_error) { lease.unsupportedCommands.add("idle"); }
        if (lease.syntheticFocusAllowed) {
          try {
            await debuggerApi.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true });
            lease.focusEmulated = true;
          } catch (_error) { lease.unsupportedCommands.add("focus"); }
        } else if (lease.focusEmulated) {
          try {
            await debuggerApi.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: false });
          } catch (_error) { lease.unsupportedCommands.add("focus"); }
          lease.focusEmulated = false;
        }
        if (!lease.attached || providerPerformanceLeases.get(tabId) !== lease) return;
        lease.lastRefreshAt = now();
        const slot = findPoolSlotByTab(tabId);
        if (slot) {
          slot.performanceHeartbeatState = "active";
          slot.performanceHeartbeatAt = lease.lastRefreshAt;
          slot.performanceUnsupportedCommands = [...lease.unsupportedCommands];
        }
      })();
      try {
        return await lease.refreshPromise;
      } finally {
        lease.refreshPromise = null;
      }
    }

    function stopProviderPerformanceHeartbeat(lease) {
      if (!lease?.heartbeatTimer) return;
      clearPerformanceInterval(lease.heartbeatTimer);
      lease.heartbeatTimer = null;
      const slot = findPoolSlotByTab(lease.tabId);
      if (slot) slot.performanceHeartbeatState = "inactive";
    }

    async function acquireProviderPerformanceLease(tabId, message = {}) {
      let lease;
      await withProviderForegroundLock(tabId, async () => {
        lease = providerPerformanceLeases.get(tabId);
        if (lease) {
          lease.references += 1;
          lease.stage = performanceStage(message) || lease.stage;
          lease.timeoutMs = Math.max(0, Number(message.timeoutMs) || lease.timeoutMs || 0);
          lease.syntheticFocusAllowed = lease.syntheticFocusAllowed && message.syntheticFocusAllowed !== false;
          await refreshProviderPerformanceLease(tabId, lease);
          updateSlotPerformanceLease(tabId, lease.attached ? "active" : "fallback", lease.stage, lease.timeoutMs, lease.reason);
          return;
        }

        lease = {
          attached: false,
          focusEmulated: false,
          syntheticFocusAllowed: message.syntheticFocusAllowed !== false,
          references: 1,
          stage: performanceStage(message),
          timeoutMs: Math.max(0, Number(message.timeoutMs) || 0),
          reason: "",
          heartbeatTimer: null,
          lastRefreshAt: 0,
          refreshPromise: null,
          unsupportedCommands: new Set()
        };
        lease.tabId = tabId;
        providerPerformanceLeases.set(tabId, lease);
        if (providerDebuggerBlockedTabs.has(tabId)) {
          lease.reason = "debugger_detached";
          updateSlotPerformanceLease(tabId, "fallback", lease.stage, lease.timeoutMs, lease.reason);
          return;
        }
        const target = { tabId };
        try {
          await debuggerApi.attach(target, "0.1");
          lease.attached = true;
        } catch (_error) {
          lease.reason = "debugger_attach_failed";
          updateSlotPerformanceLease(tabId, "fallback", lease.stage, lease.timeoutMs, lease.reason);
          return;
        }
        await refreshProviderPerformanceLease(tabId, lease);
        lease.heartbeatTimer = setPerformanceInterval(
          () => refreshProviderPerformanceLease(tabId, lease),
          PERFORMANCE_HEARTBEAT_MS
        );
        lease.heartbeatTimer?.unref?.();
        updateSlotPerformanceLease(tabId, "active", lease.stage, lease.timeoutMs);
      });
      return lease;
    }

    async function releaseProviderPerformanceLease(tabId) {
      await withProviderForegroundLock(tabId, async () => {
        const lease = providerPerformanceLeases.get(tabId);
        if (!lease) return;
        lease.references -= 1;
        if (lease.references > 0) return;
        providerPerformanceLeases.delete(tabId);
        stopProviderPerformanceHeartbeat(lease);
        const wasAttached = lease.attached;
        lease.attached = false;
        if (lease.refreshPromise) await lease.refreshPromise.catch(() => undefined);
        updateSlotPerformanceLease(tabId, "inactive");
        if (!wasAttached) return;
        const target = { tabId };
        if (lease.focusEmulated) {
          try {
            await debuggerApi.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: false });
          } catch (_error) { /* detaching below also clears the override */ }
        }
        try { await debuggerApi.sendCommand(target, "Emulation.clearIdleOverride", {}); } catch (_error) { /* optional */ }
        try { await debuggerApi.detach(target); } catch (_error) { /* target already closed */ }
      });
    }

    async function handleDebuggerDetached(source, reason) {
      const tabId = source?.tabId;
      if (!Number.isInteger(tabId)) return;
      const lease = providerPerformanceLeases.get(tabId);
      if (!lease) return;
      providerPerformanceLeases.delete(tabId);
      stopProviderPerformanceHeartbeat(lease);
      lease.attached = false;
      providerDebuggerBlockedTabs.add(tabId);
      updateSlotPerformanceLease(tabId, "detached", lease.stage, lease.timeoutMs, reason || "debugger_detached");
      await persistPool();
      await notifyPoolStatus();
    }

    async function withProviderPerformanceLease(provider, tabId, message, operation) {
      if (provider === "gemini") {
        // Any debugger emulation on a hidden Gemini document can make the SPA
        // reconcile its transient route back to a normal conversation. Keep
        // the tab non-discardable, but leave lifecycle, idle and focus entirely
        // under Chromium/Gemini control so Temporary Chat remains authoritative.
        await protectOwnedProviderTab(tabId);
        return operation();
      }
      if (
        provider !== "chatgpt"
        || typeof debuggerApi?.attach !== "function"
        || typeof debuggerApi?.sendCommand !== "function"
        || typeof debuggerApi?.detach !== "function"
      ) {
        return operation();
      }
      await acquireProviderPerformanceLease(tabId, message);
      try {
        return await operation();
      } finally {
        await releaseProviderPerformanceLease(tabId);
      }
    }

    async function holdChatGPTSetupPerformanceLease(slot) {
      if (!slot || slot.provider !== "chatgpt" || slot.setupPerformanceLeaseActive) return;
      await acquireProviderPerformanceLease(slot.providerTabId, {
        phase: "setup",
        timeoutMs: CHATGPT_SETUP_HARD_TIMEOUT_MS
      });
      slot.setupPerformanceLeaseActive = true;
    }

    async function releaseChatGPTSetupPerformanceLease(slot) {
      if (!slot?.setupPerformanceLeaseActive) return;
      slot.setupPerformanceLeaseActive = false;
      await releaseProviderPerformanceLease(slot.providerTabId);
    }

    async function sendProviderMessage(provider, tabId, message) {
      if (!["chatgpt", "gemini"].includes(provider)) {
        return tabs.sendMessage(tabId, message);
      }
      const performanceMessage = {
        ...message,
        performanceMode: provider === "chatgpt" ? "stable" : "max"
      };
      return withProviderPerformanceLease(
        provider,
        tabId,
        performanceMessage,
        () => tabs.sendMessage(tabId, performanceMessage)
      );
    }

    async function protectOwnedProviderTab(tabId) {
      if (!Number.isInteger(tabId) || typeof tabs.update !== "function") return false;
      try {
        await tabs.update(tabId, { autoDiscardable: false });
        return true;
      } catch (_error) {
        // Older Chromium builds may not expose this property; translation can still continue.
        return false;
      }
    }

    async function resolveProviderWindowId() {
      if (Number.isInteger(warmPool.providerWindowId)) return warmPool.providerWindowId;
      if (typeof tabs.get !== "function") return null;
      for (const slot of warmPool.slots) {
        if (!Number.isInteger(slot.providerTabId)) continue;
        try {
          const tab = await tabs.get(slot.providerTabId);
          if (Number.isInteger(tab?.windowId)) {
            warmPool.providerWindowId = tab.windowId;
            return tab.windowId;
          }
        } catch (_error) {
          // Try another live owned tab.
        }
      }
      return null;
    }

    async function createOwnedProviderTab(url) {
      const tab = await tabs.create({ url, active: false });
      if (Number.isInteger(tab?.windowId)) warmPool.providerWindowId = tab.windowId;
      return tab;
    }

    function registerStvTab(tabId, url) {
      stvPresenceGeneration += 1;
      warmPool.stvTabs.set(tabId, sites.siteUrl(String(url || ""))?.href || "");
    }

    function hasEligibleStvTab() {
      return Array.from(warmPool.stvTabs.keys()).some((tabId) => !warmPool.suspendedStvTabs.has(tabId));
    }

    function normalizedPoolTarget(settings = warmPool.settings) {
      const value = Math.trunc(Number(settings?.webAiTabCount));
      return Number.isFinite(value) ? Math.min(MAX_POOL_TABS, Math.max(MIN_POOL_TABS, value)) : MIN_POOL_TABS;
    }

    function desiredPoolPurposes(targetCount = warmPool.targetCount) {
      if (targetCount <= MIN_POOL_TABS) return ["shared", "shared"];
      return ["general", "prefetch", ...Array.from({ length: targetCount - 2 }, () => "general")];
    }

    function requestedPurposePriorities(job, mode = "normal") {
      if (warmPool.targetCount <= MIN_POOL_TABS) return ["shared"];
      if (mode === "lookup" || (mode === "recovery" && job?.prefetch !== true)) {
        return ["general", "prefetch"];
      }
      if (job?.prefetch === true) return ["prefetch", "general"];
      return ["general"];
    }

    function slotMatchesPurpose(slot, purpose) {
      return purpose === "shared" ? slot?.purpose === "shared" : slot?.purpose === purpose;
    }

    function hasExactPoolRoles(targetCount) {
      if (warmPool.slots.length !== targetCount) return false;
      const remaining = desiredPoolPurposes(targetCount);
      for (const slot of warmPool.slots) {
        const index = remaining.indexOf(slot.purpose || "shared");
        if (index < 0) return false;
        remaining.splice(index, 1);
      }
      return remaining.length === 0;
    }

    function exposeSlotFailureToPool(slot) {
      if (!slot) return;
      if (isAuthenticationBlocker(slot.errorCode) || warmPool.targetCount <= MIN_POOL_TABS) {
        warmPool.errorCode = slot.errorCode;
        return;
      }
      if (slot.purpose === "prefetch") return;
      const hasAlternative = warmPool.slots.some((candidate) => candidate !== slot
        && slotMatchesPurpose(candidate, slot.purpose)
        && !["failed", "retiring"].includes(candidate.state));
      if (!hasAlternative) warmPool.errorCode = slot.errorCode;
    }

    function nextReadySlot(provider, settingsHash) {
      return warmPool.slots.find((candidate) => (
        candidate.provider === provider
        && candidate.settingsHash === settingsHash
        && candidate.state === "ready"
      )) || null;
    }

    function storageCall(area, method, argument) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value, error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        };
        try {
          const possiblePromise = area[method](argument, (value) => {
            const runtimeError = globalThis.chrome?.runtime?.lastError;
            finish(value, runtimeError ? new Error(runtimeError.message) : null);
          });
          if (possiblePromise && typeof possiblePromise.then === "function") {
            possiblePromise.then((value) => finish(value), (error) => finish(undefined, error));
          }
        } catch (error) {
          finish(undefined, error);
        }
      });
    }

    function jobStorageKey(jobId) {
      return `${JOB_STORAGE_PREFIX}${jobId}`;
    }

    function isStvUrl(value) {
      return Boolean(sites.siteUrl(value));
    }

    function resolveStvSenderChapter(sender, expectedChapterId = "") {
      if (!sender?.tab || (sender.frameId != null && sender.frameId !== 0)) return null;
      const urls = [sender.tab.url, sender.url]
        .filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index);
      if (!urls.length || urls.some((value) => !isStvUrl(value))) return null;
      const identities = urls
        .map((value) => sites.parseChapter(value, expectedChapterId ? { chapterId: expectedChapterId } : undefined))
        .filter(Boolean);
      if (!identities.length) return null;
      const reference = identities[0];
      if (identities.some((identity) => identity.origin !== reference.origin || identity.bookKey !== reference.bookKey)) {
        return null;
      }
      if (!expectedChapterId) return reference;
      return identities.find((identity) => identity.chapterId === expectedChapterId) || null;
    }

    function sanitizeProviderUiDiagnostic(value) {
      if (!value || typeof value !== "object") return undefined;
      const bounded = (input, limit) => String(input || "").slice(0, limit);
      const candidates = Array.isArray(value.candidates) ? value.candidates.slice(0, 8).map((item) => ({
        tag: bounded(item?.tag, 64),
        className: bounded(item?.className, 240),
        ariaLabel: bounded(item?.ariaLabel, 240),
        title: bounded(item?.title, 240),
        testId: bounded(item?.testId, 240),
        disabled: item?.disabled === true,
        score: Math.max(-100, Math.min(100, Number(item?.score) || 0))
      })) : [];
      return {
        schemaVersion: 1,
        provider: value.provider === "gemini" ? "gemini" : "chatgpt",
        temporaryActive: value.temporaryActive === true,
        composerFound: value.composerFound === true,
        candidateCount: Math.max(0, Math.min(200, Number(value.candidateCount) || 0)),
        candidates
      };
    }

    function publicPoolSnapshot() {
      const slots = warmPool.slots.map((slot) => ({
        slotId: slot.slotId,
        providerTabId: slot.providerTabId,
        provider: slot.provider,
        purpose: ["shared", "general", "prefetch"].includes(slot.purpose) ? slot.purpose : "shared",
        state: slot.state,
        warmSessionId: slot.warmSessionId,
        settingsHash: slot.settingsHash,
        setupSessionId: slot.setupSessionId || "",
        setupCheckpoint: Math.max(0, Math.min(3, Number(slot.setupCheckpoint) || 0)),
        setupState: slot.setupState || "idle",
        setupLastProgressAt: Math.max(0, Number(slot.setupLastProgressAt) || 0),
        setupResumeCount: Math.max(0, Number(slot.setupResumeCount) || 0),
        setupServiceWorkerRestarts: Math.max(0, Number(slot.setupServiceWorkerRestarts) || 0),
        setupErrorCode: slot.setupErrorCode || "",
        firstBatchDispatchedAt: Math.max(0, Number(slot.firstBatchDispatchedAt) || 0),
        errorCode: slot.errorCode || "",
        jobId: slot.jobId || "",
        uiDiagnostic: slot.uiDiagnostic,
        performanceLease: {
          state: slot.performanceLeaseState || "inactive",
          stage: slot.performanceLeaseStage || "",
          timeoutMs: Math.max(0, Number(slot.performanceLeaseTimeoutMs) || 0),
          elapsedMs: slot.performanceLeaseStartedAt
            ? Math.max(0, now() - slot.performanceLeaseStartedAt)
            : 0,
          reason: slot.performanceLeaseReason || "",
          heartbeatState: slot.performanceHeartbeatState || "inactive",
          heartbeatElapsedMs: slot.performanceHeartbeatAt
            ? Math.max(0, now() - slot.performanceHeartbeatAt)
            : 0,
          unsupportedCommands: Array.isArray(slot.performanceUnsupportedCommands)
            ? slot.performanceUnsupportedCommands.slice(0, 3)
            : []
        },
        readyWatchdog: {
          attemptId: slot.preparationAttemptId || "",
          step: slot.readyWatchdogStep || "",
          state: slot.readyWatchdogState || "idle",
          validationSource: slot.readyValidationSource || "none",
          validationReason: slot.readyValidationReason || "none",
          firstSeenAt: Math.max(0, Number(slot.readyFirstSeenAt) || 0),
          stablePolls: Math.max(0, Number(slot.readyStablePolls) || 0),
          timeoutMs: Math.max(0, Number(slot.readyWatchdogTimeoutMs) || 0),
          graceMs: Math.max(0, Number(slot.readyWatchdogGraceMs) || 0)
        }
      }));
      const readyCount = slots.filter((slot) => slot.state === "ready").length;
      const leasedCount = slots.filter((slot) => ["leased", "name_lookup"].includes(slot.state)).length;
      const generalSlots = slots.filter((slot) => slot.purpose !== "prefetch");
      const prefetchSlot = slots.find((slot) => slot.purpose === "prefetch");
      const generalReadyCount = generalSlots.filter((slot) => slot.state === "ready").length;
      let state = "preparing";
      if (!slots.length) state = "disabled";
      else if (warmPool.errorCode || (warmPool.targetCount <= MIN_POOL_TABS && slots.some((slot) => slot.state === "failed"))) state = "error";
      else if (leasedCount) state = "leased";
      else if (readyCount === warmPool.targetCount) state = "ready";
      else if (warmPool.targetCount > MIN_POOL_TABS && generalReadyCount > 0
        && slots.every((slot) => ["ready", "failed"].includes(slot.state))) state = "ready";
      const uiDiagnostic = slots.find((slot) => slot.uiDiagnostic)?.uiDiagnostic;
      return {
        state,
        readyCount,
        leasedCount,
        totalCount: slots.length,
        targetCount: warmPool.targetCount,
        generalCount: generalSlots.length,
        prefetchCount: prefetchSlot ? 1 : 0,
        generalReadyCount,
        prefetchState: prefetchSlot?.state || "disabled",
        reconfiguring: warmPool.reconfiguring === true,
        slotIndex: leasedCount ? slots.findIndex((slot) => ["leased", "name_lookup"].includes(slot.state)) + 1 : undefined,
        errorCode: warmPool.errorCode || slots.find((slot) => slot.errorCode)?.errorCode || "",
        slots,
        diagnosticTabs: warmPool.diagnosticTabs.map((entry) => ({
          providerTabId: entry.providerTabId,
          provider: entry.provider,
          reason: entry.reason,
          retainedAt: entry.retainedAt
        })),
        uiDiagnostic
      };
    }

    function allowlistedPoolStatus() {
      const snapshot = publicPoolSnapshot();
      const activeLease = snapshot.slots.find((slot) => slot.performanceLease.state === "active");
      return {
        state: snapshot.state,
        readyCount: snapshot.readyCount,
        leasedCount: snapshot.leasedCount,
        totalCount: snapshot.totalCount,
        targetCount: snapshot.targetCount,
        generalCount: snapshot.generalCount,
        prefetchCount: snapshot.prefetchCount,
        generalReadyCount: snapshot.generalReadyCount,
        prefetchState: snapshot.prefetchState,
        reconfiguring: snapshot.reconfiguring,
        diagnosticCount: snapshot.diagnosticTabs.length,
        slotIndex: snapshot.slotIndex,
        errorCode: snapshot.errorCode,
        performanceLeaseState: activeLease ? "active" : "inactive",
        performanceLeaseStage: activeLease?.performanceLease.stage || ""
      };
    }

    function sanitizeProviderSupportDiagnostic(value) {
      if (!value || typeof value !== "object" || value.component !== "provider-content") return undefined;
      const pick = (source, keys) => Object.fromEntries(keys.map(key => [key, source?.[key]]));
      const domRoles = new Set(["composer", "send", "stop", "response", "completion", "temporaryLauncher", "temporaryActive"]);
      const safeDomEnum = (input, allowed, fallback) => allowed.has(input) ? input : fallback;
      const safeDomName = (input, limit = 40) => /^[a-z0-9_-]+$/i.test(String(input || ""))
        ? String(input).toLowerCase().slice(0, limit) : "";
      const rawDom = value.domResolution && typeof value.domResolution === "object" ? value.domResolution : {};
      const roles = {};
      for (const [role, raw] of Object.entries(rawDom.roles || {})) {
        if (!domRoles.has(role) || !raw || typeof raw !== "object") continue;
        roles[role] = {
          source: safeDomEnum(raw.source, new Set(["bundled", "local", "scanner", "none"]), "none"),
          profileId: /^[a-z0-9_-]{1,80}$/i.test(String(raw.profileId || "")) ? String(raw.profileId) : "",
          confidence: safeDomEnum(raw.confidence, new Set(["high", "medium", "low"]), "low"),
          reason: safeDomEnum(raw.reason, new Set(["selector_match", "profile_match", "semantic_match", "no_safe_candidate", "not_checked"]), "not_checked"),
          candidateCount: safeDomEnum(raw.candidateCount, new Set(["0", "1", "2-5", "6+"]), "0")
        };
      }
      const stableClass = /send|stop|temp|chat|prompt|composer|response|footer|markdown|editor|textarea/i;
      const semantics = new Set(["", "send", "gửi", "stop", "dừng", "temporary", "tạm thời", "chat", "trò chuyện", "prompt", "message", "tin nhắn"]);
      const evidence = Array.isArray(rawDom.evidence) ? rawDom.evidence.slice(0, 7).map(raw => {
        if (!raw || typeof raw !== "object" || !domRoles.has(raw.role)) return null;
        return {
          role: raw.role,
          tag: safeDomName(raw.tag) || "unknown",
          parentTag: safeDomName(raw.parentTag),
          roleAttribute: safeDomName(raw.roleAttribute),
          contenteditable: raw.contenteditable === true,
          semantic: safeDomEnum(String(raw.semantic || "").toLowerCase(), semantics, ""),
          classHints: Array.isArray(raw.classHints) ? raw.classHints.filter(item => (
            typeof item === "string" && item.length <= 80 && stableClass.test(item)
          )).slice(0, 8) : [],
          disabled: raw.disabled === true,
          hidden: raw.hidden === true
        };
      }).filter(Boolean) : [];
      const runtimeKeys = ["stage", "phase", "errorCode", "readyStep", "readyState", "stablePolls", "timeoutMs", "graceMs",
        "batchAttempt", "expectedCount", "actualCount", "validationReason", "generationState", "sendState",
        "performanceMode", "pageVisibility", "pageFocused", "sendConfirmedAt", "firstMutationAt", "completionSeenAt", "acceptedAt",
        "composerState", "composerLengthBucket", "inputEventDispatched", "sendButtonState", "clickAttempted",
        "submissionConfirmed", "requestAlreadyPresent"];
      return {
        schemaVersion: 3,
        component: "provider-content",
        provider: value.provider === "gemini" ? "gemini" : value.provider === "chatgpt" ? "chatgpt" : "unknown",
        status: value.status === "ready" ? "ready" : "blocked",
        page: pick(value.page, ["readyState", "bodyPresent"]),
        adapter: pick(value.adapter, ["loaded", "state", "code"]),
        selectors: pick(value.selectors, ["composer", "sendButton", "responses", "temporaryControl"]),
        interaction: {
          composer: pick(value.interaction?.composer, ["selector", "empty", "disabled"]),
          actions: Array.isArray(value.interaction?.actions)
            ? value.interaction.actions.slice(0, 8).map(action => pick(action, ["kind", "signal", "enabled"]))
            : [],
          temporary: pick(value.interaction?.temporary, ["state", "selector", "urlFlag", "heading", "controlCount", "pressed", "intent"])
        },
        domResolution: {
          schemaVersion: 1,
          localProfileCount: Math.max(0, Math.min(5, Number(rawDom.localProfileCount) || 0)),
          roles,
          evidence
        },
        runtime: pick(value.runtime, runtimeKeys)
      };
    }

    async function getSupportDiagnostics(message, sender) {
      const senderUrl = String(sender?.url || "");
      if (sender?.tab || !senderUrl.startsWith("chrome-extension://") || !senderUrl.includes("/popup/popup.html")) {
        return { ok: false, reason: "trusted-context-required" };
      }
      const sourceTabId = Number(message.sourceTabId);
      if (!Number.isInteger(sourceTabId) || !warmPool.stvTabs.has(sourceTabId)) {
        return { ok: false, reason: "source-tab-unavailable" };
      }
      const safeJob = job => ({
        kind: job.prefetch ? "prefetch" : "foreground",
        status: String(job.status || "unknown"),
        phase: String(job.phase || "idle"),
        workState: String(job.workState || "queued"),
        batchIndex: Math.max(0, Number(job.batchIndex) || 0),
        totalBatches: Math.max(0, Math.min(10_000, job.batches?.length || 0)),
        completedBatches: Math.max(0, Math.min(10_000, job.completed?.size || 0)),
        batchAttempt: Math.max(0, Math.min(3, Number(job.batchAttempts) || 0)),
        recoveryStage: String(job.recoveryStage || "initial"),
        activeRequest: Boolean(job.activeRequestId),
        unsentRequest: Boolean(job.unsentRequestId),
        lastError: String(job.lastBatchError || "none")
      });
      const jobsForTab = Array.from(jobs.values()).filter(job => job.sourceTabId === sourceTabId)
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, 3).map(safeJob);
      const slots = await Promise.all(warmPool.slots.slice(0, MAX_POOL_TABS).map(async slot => {
        let providerDiagnostic;
        try {
          const response = await tabs.sendMessage(slot.providerTabId, { type: "STVAI_GET_PAGE_DIAGNOSTICS" });
          providerDiagnostic = sanitizeProviderSupportDiagnostic(response?.diagnostic);
        } catch (_error) {
          providerDiagnostic = undefined;
        }
        return {
          provider: slot.provider === "gemini" ? "gemini" : "chatgpt",
          purpose: ["shared", "general", "prefetch"].includes(slot.purpose) ? slot.purpose : "shared",
          state: String(slot.state || "unknown"),
          errorCode: String(slot.errorCode || "none"),
          hasJob: Boolean(slot.jobId),
          readyWatchdog: {
            step: String(slot.readyWatchdogStep || "idle"),
            state: String(slot.readyWatchdogState || "idle"),
            validationSource: String(slot.readyValidationSource || "none"),
            validationReason: String(slot.readyValidationReason || "none")
          },
          setup: {
            checkpoint: Math.max(0, Math.min(3, Number(slot.setupCheckpoint) || 0)),
            state: String(slot.setupState || "idle"),
            stage: String(slot.setupStage || "idle"),
            lastProgressAt: Math.max(0, Number(slot.setupLastProgressAt) || 0),
            resumeCount: Math.max(0, Number(slot.setupResumeCount) || 0),
            serviceWorkerRestarts: Math.max(0, Number(slot.setupServiceWorkerRestarts) || 0),
            ready3Persisted: Number(slot.setupCheckpoint) >= 3,
            leased: slot.state === "leased",
            firstBatchDispatched: Number(slot.firstBatchDispatchedAt) > 0,
            errorCode: String(slot.setupErrorCode || "none")
          },
          performanceLease: { state: String(slot.performanceLeaseState || "inactive"), stage: String(slot.performanceLeaseStage || "idle") },
          ...(providerDiagnostic ? { providerDiagnostic } : {})
        };
      }));
      return { ok: true, support: { schemaVersion: 1, targetCount: warmPool.targetCount, reconfiguring: warmPool.reconfiguring === true, jobs: jobsForTab, slots } };
    }

    async function persistOwnedProviderTabs() {
      if (!storage?.local?.set) return;
      const record = {
        version: 1,
        tabs: [...warmPool.slots, ...warmPool.diagnosticTabs]
          .filter((entry) => Number.isInteger(entry.providerTabId))
          .map((entry) => ({ tabId: entry.providerTabId, provider: entry.provider }))
      };
      try {
        await storageCall(storage.local, "set", { [OWNED_TABS_STORAGE_KEY]: record });
      } catch (_error) {
        // The session pool remains usable; this registry only prevents orphan tabs.
      }
    }

    async function persistPool() {
      await persistOwnedProviderTabs();
      if (!sessionStorage?.set) return;
      const record = {
        version: 5,
        provider: warmPool.provider,
        settingsHash: warmPool.settingsHash,
        targetCount: warmPool.targetCount,
        generation: warmPool.generation,
        reconfiguring: warmPool.reconfiguring === true,
        suspendedStvTabIds: Array.from(warmPool.suspendedStvTabs),
        diagnosticTabs: warmPool.diagnosticTabs.map((entry) => ({
          providerTabId: entry.providerTabId,
          provider: entry.provider,
          reason: entry.reason,
          retainedAt: entry.retainedAt
        })),
        slots: warmPool.slots.map((slot) => ({
          slotId: slot.slotId,
          providerTabId: slot.providerTabId,
          provider: slot.provider,
          purpose: ["shared", "general", "prefetch"].includes(slot.purpose) ? slot.purpose : "shared",
          state: slot.state,
          warmSessionId: slot.warmSessionId,
          settingsHash: slot.settingsHash,
          setupId: slot.setupId || "",
          setupSessionId: slot.setupSessionId || "",
          warmJobId: slot.warmJobId || "",
          setupCheckpoint: Math.max(0, Math.min(3, Number(slot.setupCheckpoint) || 0)),
          setupState: slot.setupState || "idle",
          setupLastProgressAt: Math.max(0, Number(slot.setupLastProgressAt) || 0),
          setupResumeCount: Math.max(0, Number(slot.setupResumeCount) || 0),
          setupServiceWorkerRestarts: Math.max(0, Number(slot.setupServiceWorkerRestarts) || 0),
          setupResumeAttempts: Math.max(0, Number(slot.setupResumeAttempts) || 0),
          setupErrorCode: slot.setupErrorCode || "",
          firstBatchDispatchedAt: Math.max(0, Number(slot.firstBatchDispatchedAt) || 0),
          errorCode: slot.errorCode || "",
          jobId: slot.jobId || ""
        }))
      };
      try {
        await storageCall(sessionStorage, "set", { [POOL_STORAGE_KEY]: record });
      } catch (_error) {
        // Pool persistence is an optimization only.
      }
    }

    async function clearPersistedPool() {
      if (storage?.local?.set) {
        try {
          await storageCall(storage.local, "set", {
            [OWNED_TABS_STORAGE_KEY]: { version: 1, tabs: [] }
          });
        } catch (_error) {
          // Ignore optional ownership cleanup failures.
        }
      }
      if (!sessionStorage?.remove) return;
      try {
        await storageCall(sessionStorage, "remove", POOL_STORAGE_KEY);
      } catch (_error) {
        // Ignore optional session cleanup failures.
      }
    }

    function serializeJob(job) {
      return {
        version: 2,
        id: job.id,
        prefetch: job.prefetch === true,
        workflow: ["chapter", "prefetch", "tts"].includes(job.workflow) ? job.workflow : "chapter",
        cacheable: job.cacheable !== false,
        completed: Array.from(job.completed.entries()),
        sourceTabId: job.sourceTabId,
        provider: job.provider,
        providerTabId: job.providerTabId,
        warmSessionId: job.warmSessionId || "",
        settingsHash: job.settingsHash || "",
        poolSlotId: job.poolSlotId || "",
        status: job.status,
        settings: job.settings,
        cacheIdentity: job.cacheIdentity,
        blocks: job.blocks,
        batchIndex: job.batchIndex,
        setupId: job.setupId,
        setupIndex: job.setupIndex,
        setupAttempts: job.setupAttempts,
        retryAttempts: job.retryAttempts || 0,
        automaticRecoveryCycles: job.automaticRecoveryCycles || 0,
        phase: job.phase,
        repairBlocks: job.repairBlocks,
        repairAttempts: job.repairAttempts,
        partialItems: Array.from(job.partialItems.entries()),
        recoveryQueue: job.recoveryQueue,
        recoveryItems: Array.from(job.recoveryItems.entries()),
        requestSequence: job.requestSequence || 0,
        recoveryRequests: job.recoveryRequests || 0,
        usedRequestIds: Array.from(job.usedRequestIds || []),
        workState: job.workState || "queued",
        batchAttempts: job.batchAttempts || 0,
        batchSwitched: job.batchSwitched === true,
        recoveryStage: job.recoveryStage || "initial",
        activeRequestId: job.activeRequestId || "",
        validationDiagnostic: job.validationDiagnostic || null,
        lastBatchError: job.lastBatchError || "",
        unsentRequestId: job.unsentRequestId || "",
        busyStartedAt: Math.max(0, Number(job.busyStartedAt) || 0),
        busyRetryCount: Math.max(0, Number(job.busyRetryCount) || 0),
        busyRequestId: job.busyRequestId || "",
        refusalReplacementAttempts: job.refusalReplacementAttempts || 0,
        apiTemperatureFallback: job.apiTemperatureFallback === true,
        pauseReason: job.pauseReason || ""
      };
    }

    async function removePersistedJob(jobId) {
      if (!sessionStorage?.remove) return;
      try {
        await storageCall(sessionStorage, "remove", jobStorageKey(jobId));
      } catch (_error) {
        // Session persistence is recovery-only; translation remains usable without it.
      }
    }

    async function persistJob(job) {
      if (!sessionStorage?.set || !job) return;
      if (job.status === "cancelled" || (job.status === "completed" && job.cacheable !== false)) {
        await removePersistedJob(job.id);
        return;
      }
      try {
        await storageCall(sessionStorage, "set", {
          [jobStorageKey(job.id)]: serializeJob(job)
        });
      } catch (_error) {
        // Do not fail a live translation because optional session recovery is unavailable.
      }
    }

    async function sendToTab(tabId, message) {
      if (!Number.isInteger(tabId)) return undefined;
      try {
        return await tabs.sendMessage(tabId, message);
      } catch (_error) {
        return undefined;
      }
    }

    async function notifyPoolStatus() {
      const snapshot = publicPoolSnapshot();
      const activeLease = snapshot.slots.find((slot) => slot.performanceLease.state === "active");
      const message = {
        type: "STVAI_POOL_STATUS",
        state: snapshot.state,
        readyCount: snapshot.readyCount,
        leasedCount: snapshot.leasedCount,
        totalCount: snapshot.totalCount,
        targetCount: snapshot.targetCount,
        generalCount: snapshot.generalCount,
        prefetchCount: snapshot.prefetchCount,
        generalReadyCount: snapshot.generalReadyCount,
        prefetchState: snapshot.prefetchState,
        reconfiguring: snapshot.reconfiguring,
        errorCode: snapshot.errorCode,
        performanceLeaseState: activeLease ? "active" : "inactive",
        performanceLeaseStage: activeLease?.performanceLease.stage || ""
      };
      if (snapshot.uiDiagnostic) message.uiDiagnostic = snapshot.uiDiagnostic;
      if (snapshot.slotIndex) message.slotIndex = snapshot.slotIndex;
      await Promise.all(Array.from(warmPool.stvTabs.keys(), (tabId) => sendToTab(tabId, message)));
    }

    async function readAutomationConfig(settingsOverride) {
      let stored = {};
      if (storage?.local?.get) {
        try {
          stored = await storageCall(storage.local, "get", [
            "settings",
            "toolEnabled",
            "automationConsentVersion",
            "automationConsentProvider"
          ]);
        } catch (_error) {
          stored = {};
        }
      }
      const storedSettings = await migratePersistedSettings(stored?.settings);
      const settings = core.normalizeSettings({
        ...core.DEFAULT_SETTINGS,
        ...storedSettings,
        ...(settingsOverride || {})
      });
      return {
        settings,
        consented: Number(stored?.automationConsentVersion) >= AUTOMATION_CONSENT_VERSION
          && stored?.automationConsentProvider === settings.provider,
        enabled: core.isWebProvider(settings.provider)
          && stored?.toolEnabled === true
          && settings.warmPoolEnabled !== false
          && core.hasTranslationPrompt(settings)
      };
    }

    async function hashSettings(settings) {
      return core.sha256Hex(JSON.stringify({
        provider: settings.provider,
        temporaryChat: settings.temporaryChat,
        protocol: core.TRANSLATION_PROTOCOL_VERSION,
        setup: core.createSetupMessages({ settings })
      }));
    }

    const prefetchParents = new Map();
    const prefetchParentKey = tabId => `stvai-prefetch-parent:${tabId}`;

    async function clearPrefetchParent(tabId) {
      prefetchParents.delete(tabId);
      if (sessionStorage?.remove) await storageCall(sessionStorage, 'remove', prefetchParentKey(tabId));
    }

    async function rememberPrefetchParent(job) {
      if (job.prefetch) return;
      const proof = { jobId: job.id, sourceTabId: job.sourceTabId,
        settingsHash: await core.sha256Hex(core.stableSettingsPayload(job.settings)) };
      prefetchParents.set(job.sourceTabId, proof);
      if (sessionStorage?.set) await storageCall(sessionStorage, 'set', { [prefetchParentKey(job.sourceTabId)]: proof }).catch(() => undefined);
    }

    async function hasPrefetchParent(message, tabId, settings) {
      const stored = prefetchParents.get(tabId) || (sessionStorage?.get
        ? (await storageCall(sessionStorage, 'get', prefetchParentKey(tabId)))?.[prefetchParentKey(tabId)] : null);
      const current = await readAutomationConfig();
      return stored?.sourceTabId === tabId && stored.jobId === message.parentJobId
        && current.consented && core.stableSettingsPayload(current.settings) === core.stableSettingsPayload(settings)
        && stored.settingsHash === await core.sha256Hex(core.stableSettingsPayload(settings));
    }

    async function notifyPrefetch(job, status, reason) {
      await sendToTab(job.sourceTabId, { type: 'STVAI_PREFETCH_STATUS', jobId: job.id,
        status, completed: job.completed.size, total: job.batches.length, cacheable: job.cacheable !== false,
        ...(reason ? { reason } : {}) });
    }

    async function notifyStatus(job, status, reason) {
      await persistJob(job);
      if (job.prefetch) return notifyPrefetch(job, status, reason);
      const message = {
        type: "STV_JOB_STATUS",
        jobId: job.id,
        status,
        provider: job.provider,
        completedBatches: job.completed.size,
        totalBatches: job.batches.length,
        batchDiagnostic: {
          batchIndex: job.batchIndex,
          attempt: job.batchAttempts || 0,
          stage: job.recoveryStage || "initial",
          expectedCount: currentBatch(job)?.length || 0,
          actualCount: job.validationDiagnostic?.actualCount ?? null,
          reason: job.validationDiagnostic?.reason || job.lastBatchError || "none",
          requestState: job.workState || "queued"
        },
        fallbackCount: Array.from(job.completed.values()).flat()
          .filter((item) => item?.origin === "convert").length
      };
      if (reason) message.reason = reason;
      if (reason === "auto_retry") message.retryAttempt = job.retryAttempts || 0;
      await sendToTab(job.sourceTabId, message);
    }

    function diagnosticPhase(job) {
      return ["prefetch", "tts"].includes(job?.workflow) ? job.workflow : job?.phase || "unknown";
    }

    async function pause(job, reason) {
      if (["cancelled", "completed"].includes(job.status)) {
        return { ok: false, reason: `${job.status}-job` };
      }
      job.status = "paused";
      job.pauseReason = reason || "provider_error";
      job.pending = false;
      await errorJournal?.append?.(`${job.id}:${job.batchIndex}`, {
        kind: "job_paused",
        provider: job.provider,
        phase: diagnosticPhase(job),
        batchIndex: job.batchIndex,
        batchAttempt: job.batchAttempts || job.retryAttempts || 0,
        errorCode: reason || "provider_error",
        validationReason: job.validationDiagnostic?.reason || reason,
        expectedCount: currentBatch(job)?.length || 0,
        actualCount: job.validationDiagnostic?.actualCount ?? 0,
        outcome: "failed"
      });
      await notifyStatus(job, "paused", job.pauseReason);
      return { ok: true, paused: true, reason: job.pauseReason };
    }

    async function loadSettings(message) {
      let stored = {};
      if (storage && storage.local && typeof storage.local.get === "function") {
        try {
          const result = await storage.local.get("settings");
          stored = await migratePersistedSettings(result?.settings);
        } catch (_error) {
          stored = {};
        }
      }
      return core.normalizeSettings
        ? core.normalizeSettings({ ...core.DEFAULT_SETTINGS, ...stored, ...(message.settings || {}), provider: message.provider || message.settings?.provider || stored.provider })
        : { ...core.DEFAULT_SETTINGS, ...stored, ...(message.settings || {}) };
    }

    async function loadApiKey(provider) {
      if (!storage?.local?.get) return "";
      try {
        const stored = await storageCall(storage.local, "get", "apiCredentials");
        return typeof stored?.apiCredentials?.[provider] === "string" ? stored.apiCredentials[provider] : "";
      } catch (_error) {
        return "";
      }
    }

    function apiModel(settings) {
      const keys = {
        openrouter_api: "openrouterModel", gemini_api: "geminiApiModel",
        openai_api: "openaiApiModel", deepseek_api: "deepseekApiModel"
      };
      return settings[keys[settings.provider]] || "";
    }

    async function cacheIdentity(chapter, settings, blocks, allBatches) {
      const promptPayload = core.stableSettingsPayload
        ? core.stableSettingsPayload({ ...settings, nameGuide: "" })
        : JSON.stringify({ systemPrompt: settings.systemPrompt, userPrompt: settings.userPrompt });
      return {
        provider: settings.provider,
        webAiTabCount: settings.webAiTabCount,
        chapterId: chapter.chapterId,
        chapterKey: chapter.chapterKey,
        batchHash: await core.sha256Hex(JSON.stringify(allBatches.map(batch => batch.map(({ id, text }) => [id, text])))),
        sourceHash: await core.sha256Hex(blocks.map(block => block.text).join('\n\n')),
        promptHash: await core.sha256Hex(promptPayload),
        nameHash: await core.sha256Hex(core.normalizeNameGuide ? core.normalizeNameGuide(settings.nameGuide) : settings.nameGuide || "")
      };
    }

    function batchInputHash(batch) {
      return core.sha256Hex(JSON.stringify(batch.map(({ id, text }) => [id, text])));
    }

    let restorePromise;
    let jobsRestoredSuccessfully = false;

    async function restoreStoredJob(record) {
      if (!record || ![1, 2].includes(record.version) || typeof record.id !== "string") return null;
      if (!Number.isInteger(record.sourceTabId) || !Array.isArray(record.blocks)) return null;
      const blocks = record.blocks.map((block) => ({
        id: String(block && block.id || ""),
        text: String(block && block.text || ""),
        convert: String(block && block.convert || "")
      })).filter((block) => block.id && block.text);
      if (!blocks.length) return null;

      let batches;
      try {
        batches = core.splitIntoBatches(blocks, core.TRANSLATION_BATCH_LIMITS);
        if (record.prefetch === true) batches = batches.slice(0, core.PREFETCH_BATCH_LIMIT);
      } catch (_error) {
        await removePersistedJob(record.id);
        return null;
      }
      const settings = core.normalizeSettings(record.settings || {});
      const identity = record.cacheIdentity;
      let saved;
      try {
        saved = identity?.chapterKey && identity?.batchHash ? await cache.getChapter(identity) : null;
      } catch (_error) {
        await removePersistedJob(record.id);
        return null;
      }
      const completed = new Map();
      const sessionCompleted = new Map(Array.isArray(record.completed) ? record.completed : []);
      for (let index = 0; index < batches.length; index += 1) {
        const id = batchIdAt(index);
        const items = sessionCompleted.get(id) || saved?.batches?.[id]?.items;
        if (exactItems(items, batches[index])) completed.set(id, core.filterTranslationItems(items, batches[index]));
      }
      if (completed.size === batches.length && record.cacheable !== false) {
        await removePersistedJob(record.id);
        return null;
      }
      let batchIndex = 0;
      while (batchIndex < batches.length && completed.has(batchIdAt(batchIndex))) batchIndex += 1;

      const setupId = typeof record.setupId === "string" && record.setupId
        ? record.setupId
        : `setup-${record.id}`;
      const phase = ["batch", "repair"].includes(record.phase) ? record.phase : "batch";
      // Subgroups from older builds cannot be mapped safely to a full-batch retry.
      const legacyRecovery = Boolean(record.recoveryQueue?.length || record.recoveryItems?.length || record.repairBlocks?.length || record.partialItems?.length);
      const partialItems = new Map();
      const repairBlocks = [];
      const recoveryQueue = [];
      const recoveryItems = new Map();
      const restoredPoolSlotId = typeof record.poolSlotId === "string" ? record.poolSlotId : "";
      const restoredWarmSessionId = restoredPoolSlotId && typeof record.warmSessionId === "string"
        ? record.warmSessionId
        : "";
      const restoredSettingsHash = restoredPoolSlotId && typeof record.settingsHash === "string"
        ? record.settingsHash
        : "";
      const job = {
        id: record.id,
        prefetch: record.prefetch === true,
        workflow: ["chapter", "prefetch", "tts"].includes(record.workflow)
          ? record.workflow : record.prefetch === true ? "prefetch" : "chapter",
        cacheable: record.cacheable !== false && Boolean(identity?.chapterKey && identity?.batchHash),
        sourceTabId: record.sourceTabId,
        provider: settings.provider,
        providerTabId: Number.isInteger(record.providerTabId) ? record.providerTabId : null,
        warmSessionId: restoredWarmSessionId,
        settingsHash: restoredSettingsHash,
        poolSlotId: restoredPoolSlotId,
        status: completed.size === batches.length ? "completed" : "paused",
        settings,
        cacheIdentity: identity,
        blocks,
        batches,
        completed,
        batchIndex,
        setupId,
        setupMessages: core.isApiProvider(settings.provider) ? [] : core.createSetupMessages({ setupId, jobId: record.id, settings }),
        setupIndex: core.isApiProvider(settings.provider) ? 0 : (restoredPoolSlotId ? core.createSetupMessages({ setupId, jobId: record.id, settings }).length : 0),
        setupAttempts: Math.max(0, Number(record.setupAttempts) || 0),
        retryAttempts: Math.max(0, Number(record.retryAttempts) || 0),
        automaticRecoveryCycles: Math.max(0, Math.min(1, Number(record.automaticRecoveryCycles) || 0)),
        phase: core.isApiProvider(settings.provider)
          ? (["batch", "repair"].includes(phase) ? phase : "batch")
          : (restoredPoolSlotId && ["batch", "repair"].includes(phase) ? phase : "setup"),
        pending: false,
        repairBlocks,
        repairAttempts: Math.max(0, Number(record.repairAttempts) || 0),
        partialItems,
        recoveryQueue,
        recoveryItems,
        requestSequence: Math.max(0, Number(record.requestSequence) || 0),
        recoveryRequests: Math.max(0, Number(record.recoveryRequests) || 0),
        batchAttempts: Math.max(0, Math.min(3, Number(record.batchAttempts) || 0)),
        batchSwitched: record.batchSwitched === true,
        recoveryStage: ['initial', 'retry_same_tab', 'switching_ready', 'exhausted'].includes(record.recoveryStage) ? record.recoveryStage : 'initial',
        activeRequestId: /^batch_\d+_\d{4}$/.test(record.activeRequestId || '') ? record.activeRequestId : '',
        validationDiagnostic: record.validationDiagnostic || null,
        lastBatchError: typeof record.lastBatchError === 'string' ? record.lastBatchError : '',
        usedRequestIds: new Set(record.usedRequestIds || []),
        workState: "queued",
        unsentRequestId: /^batch_\d+_\d{4}$/.test(record.unsentRequestId || "") ? record.unsentRequestId : "",
        busyStartedAt: Math.max(0, Number(record.busyStartedAt) || 0),
        busyRetryCount: Math.max(0, Number(record.busyRetryCount) || 0),
        busyRequestId: /^batch_\d+_\d{4}$/.test(record.busyRequestId || "") ? record.busyRequestId : "",
        refusalReplacementAttempts: Math.max(0, Number(record.refusalReplacementAttempts) || 0),
        stableSignature: "",
        stableReads: 0,
        apiAbortController: null,
        apiTemperatureFallback: record.apiTemperatureFallback === true,
        pauseReason: legacyRecovery ? "legacy_recovery_discarded" : record.status === "paused" && record.pauseReason
          ? String(record.pauseReason)
          : "service_worker_restarted"
      };
      jobs.set(job.id, job);
      if (job.status !== "completed") await notifyStatus(job, "paused", job.pauseReason);
      return job;
    }

    async function restoreJobs() {
      if (!sessionStorage?.get) return 0;
      if (restorePromise) return restorePromise;
      restorePromise = (async () => {
        let stored;
        try {
          stored = await storageCall(sessionStorage, "get", null);
        } catch (_error) {
          return 0;
        }
        let restored = 0;
        for (const [key, record] of Object.entries(stored || {})) {
          if (!key.startsWith(JOB_STORAGE_PREFIX) || jobs.has(record?.id)) continue;
          if (await restoreStoredJob(record)) restored += 1;
        }
        jobsRestoredSuccessfully = true;
        return restored;
      })();
      return restorePromise;
    }

    async function ensureJob(jobId) {
      if (jobs.has(jobId)) return jobs.get(jobId);
      await restoreJobs();
      return jobs.get(jobId) || null;
    }

    function providerUrlFor(provider, temporaryChat) {
      if (provider === "chatgpt" && temporaryChat) {
        return `${PROVIDER_URLS.chatgpt}?temporary-chat=true`;
      }
      return PROVIDER_URLS[provider];
    }

    function readyTimeoutFor(provider) {
      return provider === "chatgpt" ? CHATGPT_READY_TIMEOUT_MS : READY_TIMEOUT_MS;
    }

    function readySendTimeoutFor(provider) {
      return provider === "chatgpt" ? CHATGPT_READY_SEND_TIMEOUT_MS : READY_SEND_TIMEOUT_MS;
    }

    function ownedProviderUrl(provider, temporaryChat) {
      return providerUrlFor(provider, temporaryChat);
    }

    function providerUrl(job) {
      return providerUrlFor(job.provider, job.settings.temporaryChat);
    }

    function providerMatchesUrl(provider, value) {
      try {
        const parsed = new URL(String(value || ""));
        const origin = parsed.origin;
        return provider === "gemini"
          ? origin === "https://gemini.google.com"
          : origin === "https://chatgpt.com";
      } catch (_error) {
        return false;
      }
    }

    function isGeminiVerificationUrl(value) {
      try {
        const parsed = new URL(String(value || ""));
        return parsed.protocol === "https:"
          && /(^|\.)google\.com$/i.test(parsed.hostname)
          && parsed.pathname.startsWith("/sorry");
      } catch (_error) {
        return false;
      }
    }

    async function providerTabMatches(provider, tabId, fallbackUrl = "") {
      let url = fallbackUrl;
      if (typeof tabs.get === "function" && Number.isInteger(tabId)) {
        try {
          const tab = await tabs.get(tabId);
          url = tab?.url || url;
        } catch (_error) {
          return false;
        }
      }
      return url ? providerMatchesUrl(provider, url) : true;
    }

    function findPoolSlotByTab(tabId) {
      return warmPool.slots.find((slot) => slot.providerTabId === tabId) || null;
    }

    function findPoolSlotByJob(jobId) {
      return warmPool.slots.find((slot) => slot.jobId === jobId) || null;
    }

    async function ownedDirectProviderForSender(sender) {
      const provider = providerMatchesUrl("gemini", sender?.url || sender?.tab?.url) ? "gemini"
        : providerMatchesUrl("chatgpt", sender?.url || sender?.tab?.url) ? "chatgpt" : "";
      if (!(sender?.frameId == null || sender.frameId === 0)
        || !Number.isInteger(sender?.tab?.id)
        || !provider
        || !storage?.local?.get) return "";
      try {
        const stored = await storageCall(storage.local, "get", OWNED_TABS_STORAGE_KEY);
        const record = stored?.[OWNED_TABS_STORAGE_KEY];
        return record?.version === 1 && Array.isArray(record.tabs) && record.tabs.some(entry => (
          entry?.tabId === sender.tab.id && entry?.provider === provider
        )) ? provider : "";
      } catch (_error) {
        return "";
      }
    }

    async function developerKeepsFailedTabs() {
      if (!storage?.local?.get) return false;
      try {
        const stored = await storageCall(storage.local, "get", DEVELOPER_KEEP_TABS_KEY);
        return stored?.[DEVELOPER_KEEP_TABS_KEY] === true;
      } catch (_error) {
        return false;
      }
    }

    function diagnosticHoldCode(reason) {
      const safe = String(reason || "automatic_cleanup").toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 44);
      return `diagnostic_hold_${safe || "automatic_cleanup"}`;
    }

    function retainDiagnosticTab(slot, reason) {
      if (!Number.isInteger(slot?.providerTabId)) return;
      if (!warmPool.diagnosticTabs.some((entry) => entry.providerTabId === slot.providerTabId)) {
        warmPool.diagnosticTabs.push({
          providerTabId: slot.providerTabId,
          provider: slot.provider === "gemini" ? "gemini" : "chatgpt",
          reason: diagnosticHoldCode(reason),
          retainedAt: now()
        });
      }
      const index = warmPool.slots.indexOf(slot);
      if (index >= 0) warmPool.slots.splice(index, 1);
    }

    async function removeDiagnosticTab(entry) {
      if (!entry) return;
      if (Number.isInteger(entry.providerTabId) && typeof tabs.remove === "function") {
        try { await tabs.remove(entry.providerTabId); } catch (_error) { /* already closed */ }
      }
      const index = warmPool.diagnosticTabs.indexOf(entry);
      if (index >= 0) warmPool.diagnosticTabs.splice(index, 1);
    }

    async function removeOwnedSlot(slot, options = {}) {
      if (!slot) return;
      const removalReason = String(options.errorReason || options.removalReason
        || (slot.state === "failed" ? slot.errorCode : "automatic_cleanup"));
      if (!options.force && await developerKeepsFailedTabs()) {
        await releaseChatGPTSetupPerformanceLease(slot);
        retainDiagnosticTab(slot, removalReason);
        await persistPool();
        return true;
      }
      slot.state = "retiring";
      await persistPool();
      await releaseChatGPTSetupPerformanceLease(slot);
      if (Number.isInteger(slot.providerTabId) && typeof tabs.remove === "function") {
        try {
          await tabs.remove(slot.providerTabId);
        } catch (_error) {
          let stillPresent = true;
          try { stillPresent = Boolean(await tabs.get(slot.providerTabId)); }
          catch (_missing) { stillPresent = false; }
          if (stillPresent) {
            warmPool.errorCode = "provider_tab_close_failed";
            await persistPool();
            return false;
          }
        }
      }
      const index = warmPool.slots.indexOf(slot);
      if (index >= 0) warmPool.slots.splice(index, 1);
      if (!warmPool.slots.some((candidate) => Number.isInteger(candidate.providerTabId))) {
        warmPool.providerWindowId = null;
      }
      await persistPool();
      return true;
    }

    async function restorePoolMetadata() {
      if (warmPool.restored) return;
      if (warmPool.restorePromise) return warmPool.restorePromise;
      warmPool.restorePromise = (async () => {
        let stored = {};
        if (sessionStorage?.get) {
          try {
            stored = await storageCall(sessionStorage, "get", POOL_STORAGE_KEY);
          } catch (_error) {
            stored = {};
          }
        }
        const record = stored?.[POOL_STORAGE_KEY];
        const keepDiagnosticTabs = await developerKeepsFailedTabs();
        if ([2, 3, 4, 5].includes(record?.version) && Array.isArray(record.slots)) {
          warmPool.suspendedStvTabs = new Set(
            (Array.isArray(record.suspendedStvTabIds) ? record.suspendedStvTabIds : [])
              .filter(Number.isInteger)
          );
          warmPool.provider = typeof record.provider === "string" ? record.provider : "";
          warmPool.settingsHash = typeof record.settingsHash === "string" ? record.settingsHash : "";
          warmPool.targetCount = record.version >= 5
            ? Math.min(MAX_POOL_TABS, Math.max(MIN_POOL_TABS, Math.trunc(Number(record.targetCount)) || MIN_POOL_TABS))
            : MIN_POOL_TABS;
          warmPool.generation = record.version >= 5 ? Math.max(0, Math.trunc(Number(record.generation)) || 0) : 0;
          // A persisted true value means the previous worker stopped mid-change.
          // The new worker reconciles target/roles below instead of inheriting a
          // lock that can no longer be released by the old process.
          warmPool.reconfiguring = false;
          const legacyDiagnosticTabs = record.slots.filter((slot) => slot?.state === "diagnostic_held");
          const recordedSlots = record.slots.filter((slot) => slot?.state !== "diagnostic_held").slice(0, MAX_POOL_TABS);
          if (keepDiagnosticTabs) {
            const persistedDiagnosticTabs = Array.isArray(record.diagnosticTabs) ? record.diagnosticTabs : [];
            warmPool.diagnosticTabs = [...persistedDiagnosticTabs, ...legacyDiagnosticTabs]
              .filter((entry, index, entries) => Number.isInteger(entry?.providerTabId)
                && index === entries.findIndex((candidate) => candidate?.providerTabId === entry.providerTabId))
              .map((entry) => ({
                providerTabId: entry.providerTabId,
                provider: entry?.provider === "gemini" ? "gemini" : "chatgpt",
                reason: String(entry?.reason || entry?.errorCode || "diagnostic_hold_unknown"),
                retainedAt: Math.max(0, Number(entry?.retainedAt) || 0)
              }));
          }
          for (const slot of recordedSlots) {
            const resumableChatGPT = slot?.provider === "chatgpt" && slot?.state === "preparing"
              && typeof slot?.setupSessionId === "string" && slot.setupSessionId;
            if (["ready", "leased", "retiring"].includes(slot?.state) || resumableChatGPT
              || !Number.isInteger(slot?.providerTabId)) continue;
            if (typeof tabs.remove === "function") {
              try { await tabs.remove(slot.providerTabId); } catch (_error) { /* already closed */ }
            }
          }
          warmPool.slots = recordedSlots.filter((slot) => ["ready", "leased", "retiring"].includes(slot?.state)
            || (slot?.provider === "chatgpt" && slot?.state === "preparing" && slot?.setupSessionId)).map((slot) => ({
            slotId: String(slot?.slotId || createId("slot")),
            providerTabId: Number.isInteger(slot?.providerTabId) ? slot.providerTabId : null,
            provider: slot?.provider === "gemini" ? "gemini" : "chatgpt",
            purpose: ["shared", "general", "prefetch"].includes(slot?.purpose)
              ? slot.purpose : warmPool.targetCount <= MIN_POOL_TABS ? "shared" : "general",
            state: slot?.state === "retiring" ? "retiring" : "restoring",
            restoreState: slot?.state === "leased" ? "leased"
              : slot?.state === "preparing" ? "preparing" : "ready",
            warmSessionId: String(slot?.warmSessionId || ""),
            settingsHash: String(slot?.settingsHash || ""),
            setupId: String(slot?.setupId || ""),
            setupSessionId: String(slot?.setupSessionId || ""),
            warmJobId: String(slot?.warmJobId || ""),
            setupCheckpoint: Math.max(0, Math.min(3, Number(slot?.setupCheckpoint) || 0)),
            setupState: String(slot?.setupState || "idle"),
            setupLastProgressAt: Math.max(0, Number(slot?.setupLastProgressAt) || 0),
            setupResumeCount: Math.max(0, Number(slot?.setupResumeCount) || 0),
            setupServiceWorkerRestarts: Math.max(0, Number(slot?.setupServiceWorkerRestarts) || 0) + 1,
            setupResumeAttempts: Math.max(0, Number(slot?.setupResumeAttempts) || 0),
            setupErrorCode: String(slot?.setupErrorCode || ""),
            firstBatchDispatchedAt: Math.max(0, Number(slot?.firstBatchDispatchedAt) || 0),
            errorCode: "",
            jobId: slot?.state === "leased" ? String(slot?.jobId || "") : "",
            restored: true
          })).filter((slot) => (
            Number.isInteger(slot.providerTabId)
            && slot.warmSessionId
            && slot.settingsHash
          ));
        }

        if (!storage?.local?.get) return;
        let ownership;
        try {
          ownership = await storageCall(storage.local, "get", OWNED_TABS_STORAGE_KEY);
        } catch (_error) {
          ownership = {};
        }
        const ownedRecord = ownership?.[OWNED_TABS_STORAGE_KEY];
        const trackedTabIds = new Set([...warmPool.slots, ...warmPool.diagnosticTabs]
          .map((entry) => entry.providerTabId));
        const ownedTabs = ownedRecord?.version === 1 && Array.isArray(ownedRecord.tabs)
          ? ownedRecord.tabs.slice(0, 32)
          : [];
        for (const entry of ownedTabs) {
          if (!Number.isInteger(entry?.tabId) || trackedTabIds.has(entry.tabId)) continue;
          let liveTab;
          try {
            liveTab = typeof tabs.get === "function" ? await tabs.get(entry.tabId) : null;
          } catch (_error) {
            liveTab = null;
          }
          const provider = entry?.provider === "gemini" ? "gemini" : "chatgpt";
          if (!liveTab?.url || !providerMatchesUrl(provider, liveTab.url)) continue;
          if (typeof tabs.remove === "function") {
            try { await tabs.remove(entry.tabId); } catch (_error) { /* already closed */ }
          }
        }
        await persistOwnedProviderTabs();
      })();
      try {
        await warmPool.restorePromise;
      } finally {
        warmPool.restored = true;
        warmPool.restorePromise = null;
      }
    }

    async function verifyPreparedSlot(slot) {
      if (!(await providerTabMatches(slot.provider, slot.providerTabId, slot.lastKnownUrl))) return false;
      let response;
      try {
        response = await tabs.sendMessage(slot.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
      } catch (_error) {
        return false;
      }
      const state = response?.state;
      return state?.state === "ready"
        && state.prepared?.warmSessionId === slot.warmSessionId
        && state.prepared?.settingsHash === slot.settingsHash;
    }

    async function verifiedReadySlot(provider, settingsHash, purpose = "shared") {
      for (const slot of warmPool.slots.slice()) {
        if (slot.state !== "ready" || slot.provider !== provider || slot.settingsHash !== settingsHash
          || !slotMatchesPurpose(slot, purpose)) continue;
        if (await verifyPreparedSlot(slot)) return slot;
        await removeOwnedSlot(slot, { errorReason: "warm_evidence_missing" });
      }
      return null;
    }

    async function verifiedReadySlotByPriority(provider, settingsHash, purposes) {
      for (const purpose of purposes) {
        const slot = await verifiedReadySlot(provider, settingsHash, purpose);
        if (slot) return slot;
      }
      return null;
    }

    async function acquireJapaneseLookupSlot(lookupJobId) {
      if (!(await ensureWarmPool())) return null;
      let acquired = null;
      await withPoolLock(async () => {
        await restorePoolMetadata();
        const slot = await verifiedReadySlotByPriority(
          warmPool.provider,
          warmPool.settingsHash,
          requestedPurposePriorities(null, "lookup")
        );
        if (slot) {
          slot.state = "name_lookup";
          slot.jobId = lookupJobId;
          slot.errorCode = "";
          acquired = slot;
          await persistPool();
        }
        if (!acquired && warmPool.settings && warmPool.slots.length < warmPool.targetCount) {
          await fillWarmPool(warmPool.settings, warmPool.settingsHash);
        }
      });
      await notifyPoolStatus();
      return acquired;
    }

    async function releaseJapaneseLookupSlot(entry, reusable) {
      if (!entry?.slotId) return;
      await withPoolLock(async () => {
        const slot = warmPool.slots.find((candidate) => (
          candidate.slotId === entry.slotId
          && candidate.jobId === entry.lookupJobId
          && candidate.state === "name_lookup"
        ));
        if (!slot) return;
        if (reusable) {
          slot.state = "ready";
          slot.jobId = "";
          slot.errorCode = "";
          await persistPool();
        } else {
          await removeOwnedSlot(slot, { removalReason: "name_lookup_not_reusable" });
          if (warmPool.settings) await fillWarmPool(warmPool.settings, warmPool.settingsHash);
        }
      });
      await notifyPoolStatus();
      await drainWarmWaiters();
    }

    async function cancelJapaneseLookup(entry) {
      if (!entry) return;
      entry.controller?.abort();
      if (Number.isInteger(entry.providerTabId)) {
        await sendToTab(entry.providerTabId, {
          type: "STVAI_PROVIDER_CANCEL",
          jobId: entry.lookupJobId,
          requestId: entry.requestId
        });
      }
    }

    async function markWarmSlotFailed(slot, code) {
      const wasLeased = slot.state === "leased";
      slot.state = "failed";
      slot.errorCode = String(code || "warm_failed");
      slot.failedAt = now();
      slot.errorIncidentKey ||= `setup:${slot.slotId}:${slot.openedAt || slot.failedAt}`;
      await errorJournal?.append?.(slot.errorIncidentKey, {
        kind: "setup_failed",
        provider: slot.provider,
        phase: "setup",
        errorCode: slot.errorCode,
        validationReason: slot.readyValidationReason || slot.setupErrorCode || slot.errorCode,
        batchAttempt: slot.recoveryAttempts || 0,
        setupCheckpoint: slot.setupCheckpoint || 0,
        setupState: slot.setupState || "idle",
        setupStage: slot.setupStage || "idle",
        readyStep: slot.readyWatchdogStep || "idle",
        readyState: slot.readyWatchdogState || "idle",
        lastProgressAt: slot.setupLastProgressAt || 0,
        resumeCount: slot.setupResumeCount || 0,
        serviceWorkerRestarts: slot.setupServiceWorkerRestarts || 0,
        watchdogTimeoutMs: slot.readyWatchdogTimeoutMs || 0,
        watchdogGraceMs: slot.readyWatchdogGraceMs || 0,
        ready3Persisted: Number(slot.setupCheckpoint) >= 3,
        slotLeased: wasLeased,
        firstBatchDispatched: Number(slot.firstBatchDispatchedAt) > 0,
        performanceMode: slot.provider === "chatgpt" ? "stable" : "max",
        outcome: REPLACEABLE_WARM_FAILURES.has(slot.errorCode) ? "still_running" : "failed"
      });
      slot.retryNotBefore = slot.errorCode === "response_timeout" ? slot.failedAt : slot.failedAt + 8_000;
      exposeSlotFailureToPool(slot);
      await persistPool();
      await notifyPoolStatus();
      if (REPLACEABLE_WARM_FAILURES.has(slot.errorCode)
        && (slot.recoveryAttempts || 0) < MAX_WARM_REPLACEMENTS) {
        setTimeout(() => { void replaceFailedWarmSlot(slot); }, 0);
      }
    }

    async function markWarmSlotRecovered(slot) {
      const incidentKey = String(slot?.errorIncidentKey || "");
      if (!incidentKey) return;
      slot.errorIncidentKey = "";
      await errorJournal?.append?.(incidentKey, {
        kind: "setup_recovered",
        outcome: "recovered",
        onlyExisting: true
      });
    }

    function validateSetupProviderResult(payload, expected) {
      const receipt = payload?.setupValidation;
      const expectedPart = String(expected.part || "");
      const expectedMarker = String(core.READY_MARKERS[expectedPart] || "");
      if (receipt && Number(receipt.schemaVersion) === 1) {
        const ok = receipt.ok === true
          && String(receipt.part || "") === expectedPart
          && String(receipt.marker || "") === expectedMarker;
        if (ok) return { ok: true, source: "provider_receipt", reason: "ok" };
      }
      const fallback = core.validateSetupResponse(payload?.response ?? payload?.text, expected);
      return {
        ...fallback,
        source: "background_fallback",
        reason: fallback.ok ? "ok" : (receipt ? "ready_receipt_mismatch" : fallback.reason)
      };
    }

    async function recheckSetupMarker(slot, setupIndex) {
      const setupPart = SETUP_PARTS[setupIndex];
      const responseMarker = core.READY_MARKERS[setupPart];
      try {
        const receipt = await tabs.sendMessage(slot.providerTabId, {
          type: "STVAI_PROVIDER_READY_RECHECK",
          setupPart,
          responseMarker,
          ...(setupIndex === SETUP_PARTS.length - 1 ? {
            warmSessionId: slot.warmSessionId,
            settingsHash: slot.settingsHash
          } : {})
        });
        const confirmed = receipt?.ok === true
          && receipt.confirmed === true
          && receipt.part === setupPart
          && receipt.marker === responseMarker;
        if (confirmed) {
          slot.readyWatchdogState = "rechecked_ready";
          slot.readyValidationSource = "provider_recheck";
          slot.readyValidationReason = "ok";
        }
        return confirmed;
      } catch (_error) {
        return false;
      }
    }

    async function prepareWarmSlot(slot, settings, options = {}) {
      if (!slot) return false;
      if (slot.documentLoading) return false;
      if (slot.state === "preparing") {
        slot.preparationRequested = true;
        return false;
      }
      if (!["opening", "restoring"].includes(slot.state)) return false;
      const generation = slot.documentGeneration || 0;
      const preparationAttemptId = createId("ready-attempt");
      slot.preparationAttemptId = preparationAttemptId;
      const current = () => warmPool.slots.includes(slot)
        && (slot.documentGeneration || 0) === generation
        && slot.preparationAttemptId === preparationAttemptId
        && !slot.documentLoading;
      const restoring = slot.state === "restoring";
      if (!restoring) slot.state = "preparing";
      if (!(await providerTabMatches(slot.provider, slot.providerTabId, slot.lastKnownUrl))) {
        if (!current()) return false;
        await markWarmSlotFailed(slot, "provider_origin_mismatch");
        return false;
      }
      if (restoring) {
        if (slot.provider === "chatgpt" && slot.restoreState === "preparing" && slot.setupSessionId) {
          try {
            const restoredStatus = await tabs.sendMessage(slot.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
            const setup = restoredStatus?.state?.setup;
            if (setup?.setupSessionId === slot.setupSessionId) {
              slot.setupCheckpoint = Math.max(slot.setupCheckpoint || 0, Math.min(3, Number(setup.checkpoint) || 0));
              slot.setupState = String(setup.state || "running");
              slot.setupLastProgressAt = Math.max(0, Number(setup.lastProgressAt) || 0);
              slot.setupResumeCount = Math.max(0, Number(setup.resumeCount) || 0);
              slot.setupErrorCode = String(setup.errorCode || "");
            }
          } catch (_error) {
            // The content script may still be waking; the normal preparation probe retries below.
          }
          if (!current()) return false;
          slot.state = "opening";
          delete slot.restoreState;
          await persistPool();
          return prepareWarmSlot(slot, settings, options);
        }
        const verified = await verifyPreparedSlot(slot);
        if (!current()) return false;
        if (verified) {
          slot.state = slot.restoreState === "leased" && slot.jobId ? "leased" : "ready";
          delete slot.restoreState;
          slot.errorCode = "";
          await persistPool();
          return true;
        }
        await removeOwnedSlot(slot, { errorReason: "restore_evidence_missing" });
        return false;
      }

      await persistPool();
      if (!current()) return false;
      let status;
      for (let attempt = 0; attempt < providerReadyAttempts; attempt += 1) {
        if (now() - Number(slot.documentLoadedAt || slot.openedAt) >= 60_000) {
          await markWarmSlotFailed(slot, "provider_unreachable");
          return false;
        }
        try {
          status = await tabs.sendMessage(slot.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
          if (!current()) return false;
          slot.uiDiagnostic = sanitizeProviderUiDiagnostic(status?.state?.diagnostic);
          break;
        } catch (_error) {
          if (!options.deferUnavailable || attempt === providerReadyAttempts - 1) break;
          await retrySleep(providerReadyDelayMs);
          if (!current()) return false;
        }
      }
      if (!status) {
        if (options.deferUnavailable) {
          slot.state = "opening";
          slot.preparationPasses = Math.max(0, Number(slot.preparationPasses) || 0) + 1;
          await persistPool();
          const retryRequested = slot.preparationRequested === true;
          slot.preparationRequested = false;
          if (retryRequested || slot.preparationPasses < providerReadyPasses) {
            await retrySleep(providerReadyDelayMs);
            if (!current()) return false;
            return prepareWarmSlot(slot, settings, options);
          }
          slot.preparationPasses = 0;
          await markWarmSlotFailed(slot, "provider_unreachable");
          return false;
        }
        await markWarmSlotFailed(slot, "provider_unreachable");
        return false;
      }
      slot.preparationPasses = 0;
      if (status?.state?.state !== "ready") {
        if (options.deferUnavailable && !status?.state?.state && !status?.error?.code) {
          slot.state = "opening";
          await persistPool();
          return false;
        }
        await markWarmSlotFailed(slot, status?.error?.code || status?.state?.code || status?.state?.state || "provider_unavailable");
        return false;
      }

      const prompts = core.createSetupMessages({
        setupId: slot.setupId,
        jobId: slot.warmJobId,
        settings
      });
      const readyTimeoutMs = readyTimeoutFor(slot.provider);
      const readySendTimeoutMs = readySendTimeoutFor(slot.provider);
      let setupComplete = false;
      if (slot.provider === "chatgpt") {
        await holdChatGPTSetupPerformanceLease(slot);
        const steps = prompts.map((prompt, setupIndex) => ({
          jobId: slot.warmJobId,
          setupIndex,
          setupPart: SETUP_PARTS[setupIndex],
          responseMarker: core.READY_MARKERS[SETUP_PARTS[setupIndex]],
          prompt
        }));
        slot.readyWatchdogStep = `ready_${Math.min(3, (slot.setupCheckpoint || 0) + 1)}`;
        slot.readyWatchdogState = "waiting_marker";
        slot.readyWatchdogTimeoutMs = CHATGPT_SETUP_HARD_TIMEOUT_MS;
        slot.readyWatchdogGraceMs = READY_MARKER_GRACE_MS;
        slot.setupStageStartedAt ||= now();
        let response;
        try {
          response = await sendProviderMessage(slot.provider, slot.providerTabId, {
            type: "STVAI_PROVIDER_SETUP_START",
            provider: "chatgpt",
            setupSessionId: slot.setupSessionId,
            setupId: slot.setupId,
            warmSessionId: slot.warmSessionId,
            settingsHash: slot.settingsHash,
            temporaryChat: settings.temporaryChat,
            temporaryTimeoutMs: warmTemporaryTimeoutMs,
            inactivityTimeoutMs: CHATGPT_SETUP_INACTIVITY_MS,
            hardTimeoutMs: CHATGPT_SETUP_HARD_TIMEOUT_MS,
            markerGraceMs: READY_MARKER_GRACE_MS,
            steps
          });
        } catch (_error) {
          if (!current()) return false;
          await releaseChatGPTSetupPerformanceLease(slot);
          await markWarmSlotFailed(slot, "provider_unreachable");
          return false;
        }
        if (!current()) return false;
        if (!response?.ok) {
          await releaseChatGPTSetupPerformanceLease(slot);
          await markWarmSlotFailed(slot, response?.error?.code || "warm_setup_failed");
          return false;
        }
        slot.setupCheckpoint = Math.max(
          Number(slot.setupCheckpoint) || 0,
          Math.max(0, Math.min(3, Number(response.checkpoint) || 0))
        );
        slot.setupState = String(response.state || "running");
        slot.setupLastProgressAt ||= now();
        await persistPool();
        setupComplete = response.state === "completed" && slot.setupCheckpoint === 3;
      } else setupComplete = await withProviderPerformanceLease(
        slot.provider,
        slot.providerTabId,
        { phase: "setup", setupIndex: 0, timeoutMs: readyTimeoutMs },
        async () => {
          for (let setupIndex = 0; setupIndex < prompts.length; setupIndex += 1) {
            const setupPart = SETUP_PARTS[setupIndex];
            const finalSetup = setupIndex === prompts.length - 1;
            const providerMessage = {
              type: "STVAI_PROVIDER_SEND",
              phase: "setup",
              jobId: slot.warmJobId,
              setupIndex,
              setupId: slot.setupId,
              setupPart,
              responseMarker: core.READY_MARKERS[setupPart],
              prompt: prompts[setupIndex],
              temporaryTimeoutMs: warmTemporaryTimeoutMs,
              sendTimeoutMs: readySendTimeoutMs,
              timeoutMs: readyTimeoutMs,
              markerGraceMs: READY_MARKER_GRACE_MS,
              temporaryChat: settings.temporaryChat,
              ...(finalSetup ? {
                warmSessionId: slot.warmSessionId,
                settingsHash: slot.settingsHash
              } : {})
            };
            slot.readyWatchdogStep = `ready_${setupIndex + 1}`;
            slot.readyWatchdogState = "waiting_marker";
            slot.readyWatchdogTimeoutMs = readyTimeoutMs;
            slot.readyWatchdogGraceMs = READY_MARKER_GRACE_MS;
            slot.setupStageStartedAt = now();
            let response;
            try {
              response = await sendProviderMessage(slot.provider, slot.providerTabId, providerMessage);
            } catch (_error) {
              if (!current()) return false;
              await markWarmSlotFailed(slot, "provider_unreachable");
              return false;
            }
            if (!current()) return false;
            if (response?.ok === false) {
              if (response.error?.code === "response_timeout"
                && await recheckSetupMarker(slot, setupIndex)) {
                response = {
                  ok: true,
                  response: core.READY_MARKERS[setupPart],
                  setupValidation: {
                    schemaVersion: 1,
                    ok: true,
                    part: setupPart,
                    marker: core.READY_MARKERS[setupPart],
                    reason: "ok"
                  },
                  stability: {
                    state: "confirmed",
                    firstSeenAt: now(),
                    stablePolls: 2,
                    timeoutMs: readyTimeoutMs,
                    graceMs: READY_MARKER_GRACE_MS
                  }
                };
              }
            }
            if (response?.ok === false) {
              await markWarmSlotFailed(slot, response.error?.code || "warm_setup_failed");
              return false;
            }
            if (response?.outcomeCode === "content_refused") {
              await markWarmSlotFailed(slot, "content_refused");
              return false;
            }
            if (!(response && typeof response.response === "string")) return false;
            if (response.stability && typeof response.stability === "object") {
              slot.readyWatchdogState = response.stability.state === "confirmed" ? "confirmed" : "marker_seen";
              slot.readyFirstSeenAt = Math.max(0, Number(response.stability.firstSeenAt) || 0);
              slot.readyStablePolls = Math.max(0, Number(response.stability.stablePolls) || 0);
            }
            const validation = validateSetupProviderResult(response, {
              jobId: slot.warmJobId,
              setupId: slot.setupId,
              part: setupPart
            });
            slot.readyValidationSource = validation.source;
            slot.readyValidationReason = validation.reason;
            if (!validation.ok) {
              await markWarmSlotFailed(slot, "invalid_setup_response");
              return false;
            }
          }
          return true;
        }
      );
      if (!setupComplete) return false;
      await releaseChatGPTSetupPerformanceLease(slot);
      const verified = await verifyPreparedSlot(slot);
      if (!current()) return false;
      if (!verified) {
        await markWarmSlotFailed(slot, "warm_evidence_missing");
        return false;
      }
      slot.state = "ready";
      slot.preparationRequested = false;
      slot.preparationPasses = 0;
      slot.errorCode = "";
      warmPool.errorCode = "";
      if (warmPool.slots.length === warmPool.targetCount
        && warmPool.slots.every((candidate) => candidate.state === "ready")) {
        warmPool.unexpectedReplacementCount = 0;
      }
      await markWarmSlotRecovered(slot);
      await persistPool();
      return true;
    }

    async function createWarmSlot(settings, settingsHash, recoveryAttempts = 0, purpose = "shared") {
      if (warmPool.slots.length >= warmPool.targetCount) return null;
      const targetUrl = ownedProviderUrl(settings.provider, settings.temporaryChat);
      const slot = {
        slotId: createId("slot"),
        providerTabId: null,
        provider: settings.provider,
        purpose,
        state: "opening",
        warmSessionId: createId("warm"),
        settingsHash,
        setupId: createId("setup"),
        setupSessionId: createId("setup-session"),
        warmJobId: createId("warm-job"),
        setupCheckpoint: 0,
        setupState: "idle",
        setupStage: "idle",
        setupLastProgressAt: 0,
        setupResumeCount: 0,
        setupServiceWorkerRestarts: 0,
        setupResumeAttempts: 0,
        setupErrorCode: "",
        firstBatchDispatchedAt: 0,
        errorCode: "",
        jobId: "",
        recoveryAttempts: Math.max(0, Number(recoveryAttempts) || 0),
        openedAt: now(),
        documentLoadedAt: 0,
        failedAt: 0
      };
      warmPool.slots.push(slot);
      let tab;
      try {
        tab = await createOwnedProviderTab(targetUrl);
      } catch (_error) {
        await markWarmSlotFailed(slot, "provider_tab_failed");
        return slot;
      }
      if (!tab || !Number.isInteger(tab.id)) {
        await markWarmSlotFailed(slot, "provider_tab_failed");
        return slot;
      }
      slot.providerTabId = tab.id;
      const currentUrlMatches = providerMatchesUrl(settings.provider, tab.url);
      const navigationUrl = tab.pendingUrl || targetUrl;
      slot.documentLoading = tab.status === "loading"
        || (!currentUrlMatches && providerMatchesUrl(settings.provider, navigationUrl));
      slot.lastKnownUrl = currentUrlMatches ? tab.url : navigationUrl;
      await protectOwnedProviderTab(tab.id);
      await persistPool();
      return slot;
    }

    async function replaceFailedWarmSlot(failedSlot) {
      let replacement = null;
      let settings = null;
      const retryDelay = Math.max(0, Number(failedSlot?.retryNotBefore || 0) - now());
      if (retryDelay) await retrySleep(retryDelay);
      await withPoolLock(async () => {
        if (!warmPool.slots.includes(failedSlot)
          || failedSlot.state !== "failed"
          || !REPLACEABLE_WARM_FAILURES.has(failedSlot.errorCode)) return;
        if ((failedSlot.recoveryAttempts || 0) >= MAX_WARM_REPLACEMENTS) return;
        if (!warmPool.settings || !hasEligibleStvTab()) {
          await removeOwnedSlot(failedSlot, { errorReason: failedSlot.errorCode });
          return;
        }
        settings = warmPool.settings;
        const settingsHash = failedSlot.settingsHash;
        const nextAttempt = (failedSlot.recoveryAttempts || 0) + 1;
        const errorIncidentKey = failedSlot.errorIncidentKey;
        if (!(await removeOwnedSlot(failedSlot, { errorReason: failedSlot.errorCode }))) return;
        replacement = await createWarmSlot(settings, settingsHash, nextAttempt, failedSlot.purpose || "shared");
        replacement.errorIncidentKey = errorIncidentKey;
      });
      if (!replacement || !settings) {
        await notifyPoolStatus();
        return false;
      }
      await prepareWarmSlot(replacement, settings, { deferUnavailable: true });
      await notifyPoolStatus();
      await drainWarmWaiters();
      return replacement.state === "ready";
    }

    async function fillWarmPool(settings, settingsHash) {
      if (isAuthenticationBlocker(warmPool.errorCode)) return;
      if (poolFillOperation) {
        if (warmPool.slots.some((slot) => slot.state === "ready")) return;
        await Promise.race([poolFillOperation.firstReady, poolFillOperation.all]);
        return;
      }
      const activeLegacyTabs = () => Array.from(jobs.values()).filter((job) => (
        Number.isInteger(job.providerTabId)
        && !job.poolSlotId
        && !["cancelled", "completed"].includes(job.status)
      )).length;
      const hadReadySlot = warmPool.slots.some((slot) => (
        slot.provider === settings.provider
        && slot.settingsHash === settingsHash
        && slot.state === "ready"
      ));
      const createdSlots = [];
      const desiredPurposes = desiredPoolPurposes(warmPool.targetCount);
      const outstandingPurposes = [...desiredPurposes];
      for (const slot of warmPool.slots) {
        const index = outstandingPurposes.indexOf(slot.purpose || "shared");
        if (index >= 0) outstandingPurposes.splice(index, 1);
      }
      while (warmPool.slots.length + activeLegacyTabs() < warmPool.targetCount && outstandingPurposes.length) {
        const slot = await createWarmSlot(settings, settingsHash, 0, outstandingPurposes.shift());
        if (!slot) break;
        createdSlots.push(slot);
        if (createdSlots.length === 1) {
          try {
            const probe = await tabs.sendMessage(slot.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
            slot.uiDiagnostic = sanitizeProviderUiDiagnostic(probe?.state?.diagnostic);
            const probeCode = probe?.error?.code
              || (probe?.state?.state && probe.state.state !== "ready" ? probe?.state?.code : "");
            if (isAuthenticationBlocker(probeCode)) {
              await markWarmSlotFailed(slot, probeCode);
              break;
            }
          } catch (_error) {
            // The bridge may still be loading. Preparation below will classify it safely.
          }
        }
      }
      if (!createdSlots.length) return;
      let cursor = 0;
      let resolveFirstReady;
      const operation = { firstReady: null, all: null };
      operation.firstReady = new Promise((resolve) => { resolveFirstReady = resolve; });
      const worker = async () => {
        while (cursor < createdSlots.length) {
          const slot = createdSlots[cursor++];
          await prepareWarmSlot(slot, settings, { deferUnavailable: true });
          if (slot.state === "ready") resolveFirstReady();
          setTimeout(() => {
            void notifyPoolStatus();
            void drainWarmWaiters();
          }, 0);
        }
      };
      const workers = Array.from({ length: Math.min(2, createdSlots.length) }, () => worker());
      operation.all = Promise.all(workers).finally(() => {
        resolveFirstReady();
        if (poolFillOperation === operation) poolFillOperation = null;
      });
      poolFillOperation = operation;
      if (!hadReadySlot) await Promise.race([operation.firstReady, operation.all]);
    }

    async function ensureWarmPool(settingsOverride) {
      const config = await readAutomationConfig(settingsOverride);
      await restorePoolMetadata();
      const targetCount = normalizedPoolTarget(config.settings);
      const remainingPurposes = desiredPoolPurposes(targetCount);
      const hasInvalidRole = warmPool.slots.some((slot) => {
        const index = remainingPurposes.indexOf(slot.purpose || "shared");
        if (index < 0) return true;
        remainingPurposes.splice(index, 1);
        return false;
      });
      const rolesMismatch = warmPool.slots.length > 0 && (
        warmPool.targetCount !== targetCount
        || hasInvalidRole
      );
      if (rolesMismatch && !warmPool.reconfiguring) return reconfigureWarmPool(config);
      return withPoolLock(async () => {
        if (!config.consented || !config.enabled || !hasEligibleStvTab()) {
          await notifyPoolStatus();
          return false;
        }
        warmPool.targetCount = normalizedPoolTarget(config.settings);
        const settingsHash = await hashSettings(config.settings);
        const configurationChanged = warmPool.provider && (
          warmPool.provider !== config.settings.provider || warmPool.settingsHash !== settingsHash
        );
        if (configurationChanged) {
          const stale = warmPool.slots.filter((slot) => slot.state !== "leased"
            && (slot.provider !== config.settings.provider || slot.settingsHash !== settingsHash));
          for (const slot of stale) await removeOwnedSlot(slot, { removalReason: "settings_changed" });
        }
        warmPool.provider = config.settings.provider;
        warmPool.settingsHash = settingsHash;
        warmPool.settings = config.settings;

        await restoreJobs();
        for (const slot of [...warmPool.slots]) {
          const owner = slot.jobId ? jobs.get(slot.jobId) : null;
          const wasLeased = slot.state === "leased"
            || (slot.state === "restoring" && slot.restoreState === "leased");
          if (slot.state === "retiring" || (wasLeased
            && ((!owner && jobsRestoredSuccessfully) || ["completed", "cancelled"].includes(owner?.status)))) {
            if (await removeOwnedSlot(slot, { removalReason: "restored_job_finished" })) {
              if (owner?.poolSlotId === slot.slotId) {
                owner.poolSlotId = "";
                owner.providerTabId = null;
                await persistJob(owner);
              }
              if (warmPool.errorCode === "provider_tab_close_failed") warmPool.errorCode = "";
            }
            continue;
          }
          if (slot.state === "restoring") await prepareWarmSlot(slot, config.settings);
        }
        await fillWarmPool(config.settings, settingsHash);
        await persistPool();
        await notifyPoolStatus();
        return true;
      });
    }

    async function performWarmPoolReconfiguration(config) {
      const resumable = [];
      const paused = [];
      let closeFailed = false;
      const nextTargetCount = normalizedPoolTarget(config.settings);
      const nextSettingsHash = await hashSettings(config.settings);
      await withPoolLock(async () => {
        warmPool.reconfiguring = true;
        warmPool.generation += 1;
        warmPool.targetCount = nextTargetCount;
        warmPool.provider = config.settings.provider;
        warmPool.settingsHash = nextSettingsHash;
        warmPool.settings = config.settings;
        await persistPool();
        await notifyPoolStatus();
        for (const job of jobs.values()) {
          if (!core.isWebProvider(job.provider) || ["completed", "cancelled"].includes(job.status)) continue;
          await sendToTab(job.providerTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id });
          const canResume = ["starting", "running", "waiting-provider"].includes(job.status)
            && core.stableSettingsPayload(job.settings) === core.stableSettingsPayload(config.settings);
          job.providerTabId = null;
          job.poolSlotId = "";
          job.warmSessionId = "";
          job.settingsHash = "";
          job.activeRequestId = "";
          job.unsentRequestId = "";
          job.pending = false;
          job.workState = "queued";
          job.batchAttempts = 0;
          job.batchSwitched = false;
          job.recoveryStage = "initial";
          if (canResume) {
            job.settings = { ...job.settings, webAiTabCount: config.settings.webAiTabCount };
            job.status = "waiting-provider";
            job.pauseReason = "";
            resumable.push(job);
          } else {
            job.status = "paused";
            job.pauseReason ||= "pool_settings_changed";
            paused.push(job);
          }
          await persistJob(job);
        }
        warmPool.waiters.length = 0;
        for (const slot of [...warmPool.slots]) {
          slot.preparationAttemptId = createId("retired-ready-attempt");
          if (!(await removeOwnedSlot(slot, { force: true, removalReason: "pool_size_changed" }))) {
            closeFailed = true;
            break;
          }
        }
        poolFillOperation = null;
        warmPool.errorCode = closeFailed ? "provider_tab_close_failed" : "";
        warmPool.reconfiguring = false;
        await persistPool();
      });
      await notifyPoolStatus();
      if (closeFailed) {
        for (const job of resumable) {
          job.status = "paused";
          job.pauseReason = "provider_tab_close_failed";
          await notifyStatus(job, "paused", job.pauseReason);
        }
        return false;
      }
      await ensureWarmPool(config.settings);
      for (const job of paused) await notifyStatus(job, "paused", job.pauseReason);
      for (const job of resumable) void acquireWarmSlot(job);
      return true;
    }

    function reconfigureWarmPool(config) {
      const run = async () => {
        const targetCount = normalizedPoolTarget(config.settings);
        const settingsHash = await hashSettings(config.settings);
        if (!warmPool.reconfiguring
          && warmPool.targetCount === targetCount
          && warmPool.provider === config.settings.provider
          && warmPool.settingsHash === settingsHash
          && hasExactPoolRoles(targetCount)) return true;
        return performWarmPoolReconfiguration(config);
      };
      const next = poolReconfigurationSerial.then(run, run);
      poolReconfigurationSerial = next.catch(() => undefined);
      return next;
    }

    async function cleanupWarmPool() {
      return withPoolLock(async () => {
        const owned = [...warmPool.slots];
        warmPool.waiters.length = 0;
        warmPool.provider = "";
        warmPool.settingsHash = "";
        warmPool.settings = null;
        warmPool.providerWindowId = null;
        warmPool.errorCode = "";
        for (const slot of owned) await removeOwnedSlot(slot, { removalReason: "stv_pool_cleanup" });
        if (warmPool.suspendedStvTabs.size || warmPool.slots.length || warmPool.diagnosticTabs.length) await persistPool();
        else await clearPersistedPool();
        await notifyPoolStatus();
      });
    }

    async function scheduleLastStvCleanup() {
      const generation = ++stvPresenceGeneration;
      const cleanupIfStillGone = async () => {
        if (generation !== stvPresenceGeneration || warmPool.stvTabs.size > 0) return;
        await cleanupWarmPool();
      };
      if (poolCleanupDelayMs === 0) {
        await cleanupIfStillGone();
        return;
      }
      void (async () => {
        await poolCleanupSleep(poolCleanupDelayMs);
        await cleanupIfStillGone();
      })();
    }

    function assignWarmSlot(job, slot) {
      slot.state = "leased";
      slot.jobId = job.id;
      slot.errorCode = "";
      job.providerTabId = slot.providerTabId;
      job.warmSessionId = slot.warmSessionId;
      job.settingsHash = slot.settingsHash;
      job.poolSlotId = slot.slotId;
      job.phase = "batch";
      job.setupIndex = job.setupMessages.length;
      job.status = "running";
      job.pauseReason = "";
      job.pending = false;
    }

    async function acquireWarmSlot(job) {
      if (job.recoveryStage === "switching_ready") return acquireRecoverySlot(job);
      if (["cancelled", "paused", "completed"].includes(job.status)) return true;
      const config = await readAutomationConfig(job.settings);
      if (!config.consented || !config.enabled) return false;
      if (warmPool.reconfiguring) {
        if (!warmPool.waiters.includes(job.id)) warmPool.waiters.push(job.id);
        job.status = "waiting-provider";
        await persistJob(job);
        await notifyStatus(job, "waiting-provider", "pool_reconfiguring");
        return true;
      }
      await ensureWarmPool(job.settings);
      if (["cancelled", "paused", "completed"].includes(job.status)) return true;
      let assigned = false;
      let blockedReason = "";
      await withPoolLock(async () => {
        if (["cancelled", "paused", "completed"].includes(job.status)) return;
        const settingsHash = await hashSettings(job.settings);
        const priorities = requestedPurposePriorities(job);
        let slot = await verifiedReadySlotByPriority(job.provider, settingsHash, priorities);
        if (!slot) {
          const spent = warmPool.slots.filter((candidate) => candidate.state === "spent");
          for (const candidate of spent) await removeOwnedSlot(candidate, { removalReason: "spent_before_lease" });
          if (spent.length || warmPool.slots.length < warmPool.targetCount) {
            await fillWarmPool(job.settings, settingsHash);
            slot = await verifiedReadySlotByPriority(job.provider, settingsHash, priorities);
          }
        }
        if (!slot) {
          if (isAuthenticationBlocker(warmPool.errorCode)) {
            blockedReason = warmPool.errorCode;
            return;
          }
          if (!warmPool.waiters.includes(job.id)) warmPool.waiters.push(job.id);
          job.status = "waiting-provider";
          await persistJob(job);
          await notifyStatus(job, "waiting-provider", "pool_waiting");
          return;
        }
        if (["cancelled", "paused", "completed"].includes(job.status)) return;
        assignWarmSlot(job, slot);
        assigned = true;

        // Retire spent slots before opening replacements so the configured live
        // tab limit is never exceeded.
        const spent = warmPool.slots.filter((candidate) => candidate.state === "spent");
        for (const candidate of spent) await removeOwnedSlot(candidate, { removalReason: "spent_after_lease" });
        await fillWarmPool(job.settings, settingsHash);
        await persistPool();
      });
      await notifyPoolStatus();
      if (blockedReason) {
        await pause(job, blockedReason);
        return true;
      }
      if (!assigned) return true;
      await notifyStatus(job, "running");
      await dispatchCurrent(job);
      return true;
    }

    async function drainWarmWaiters() {
      // Recovery may lease READY, but cannot rebuild the standby to force a retry.
      for (const jobId of [...warmPool.waiters]) {
        const job = jobs.get(jobId);
        if (job?.status === "waiting-provider" && job.recoveryStage === "switching_ready") {
          await acquireRecoverySlot(job);
        }
      }
      const runnable = [];
      const mismatched = [];
      await withPoolLock(async () => {
        if (!warmPool.waiters.length || !warmPool.settings) return;
        const spent = warmPool.slots.filter((slot) => slot.state === "spent");
        for (const slot of spent) await removeOwnedSlot(slot, { removalReason: "spent_waiter_cleanup" });
        if (spent.length) await fillWarmPool(warmPool.settings, warmPool.settingsHash);
        let refilled = false;
        while (warmPool.waiters.length) {
          let selected = null;
          const index = warmPool.waiters.findIndex((jobId) => {
            const job = jobs.get(jobId);
            return job && job.status === "waiting-provider" && job.recoveryStage !== "switching_ready";
          });
          if (index >= 0) {
            const job = jobs.get(warmPool.waiters[index]);
            const slot = await verifiedReadySlotByPriority(
              warmPool.provider,
              warmPool.settingsHash,
              requestedPurposePriorities(job)
            );
            if (slot) selected = { index, job, slot };
          }
          if (!selected) {
            if (!refilled) {
              refilled = true;
              await fillWarmPool(warmPool.settings, warmPool.settingsHash);
              continue;
            }
            break;
          }
          const { index: nextIndex, job, slot } = selected;
          warmPool.waiters.splice(nextIndex, 1);
          const jobSettingsChanged = core.stableSettingsPayload(job.settings)
            !== core.stableSettingsPayload(warmPool.settings);
          if (job.provider !== slot.provider || (await hashSettings(job.settings)) !== slot.settingsHash
            || jobSettingsChanged) {
            job.status = "paused";
            job.pauseReason = "pool_settings_changed";
            job.pending = false;
            mismatched.push(job);
            continue;
          }
          assignWarmSlot(job, slot);
          runnable.push(job);
        }
        await persistPool();
      });
      await notifyPoolStatus();
      for (const job of mismatched) await notifyStatus(job, "paused", job.pauseReason);
      for (const job of runnable) {
        await notifyStatus(job, "running");
        await dispatchCurrent(job);
      }
    }

    async function spendJobSlot(job, options = {}) {
      if (!job?.poolSlotId) return;
      await restorePoolMetadata();
      const automation = await readAutomationConfig(job.settings);
      await withPoolLock(async () => {
        const slot = warmPool.slots.find((candidate) => candidate.slotId === job.poolSlotId);
        if (slot) {
          if (!automation.consented || !automation.enabled
            || (!hasEligibleStvTab() && !options.preserveWithoutStv)) {
            await removeOwnedSlot(slot, { removalReason: "automation_disabled_or_stv_gone" });
          } else {
            slot.state = "spent";
            slot.jobId = "";
            if (job.status === "completed") {
              await removeOwnedSlot(slot, { removalReason: "job_completed" });
              if (warmPool.settings) await fillWarmPool(warmPool.settings, warmPool.settingsHash);
            }
            await persistPool();
          }
        }
      });
      job.poolSlotId = "";
      await notifyPoolStatus();
      if (!options.deferDrain) await drainWarmWaiters();
    }

    async function closeLegacyProviderTab(job) {
      if (!job || job.poolSlotId || !Number.isInteger(job.providerTabId)) return;
      const tabId = job.providerTabId;
      job.providerTabId = null;
      if (typeof tabs.remove === "function") {
        try { await tabs.remove(tabId); } catch (_error) { /* already closed */ }
      }
    }

    async function openProvider(job) {
      let tab;
      await withPoolLock(async () => {
        const activeLegacyCount = Array.from(jobs.values()).filter((candidate) => (
          candidate.id !== job.id
          && Number.isInteger(candidate.providerTabId)
          && !candidate.poolSlotId
          && !["cancelled", "completed"].includes(candidate.status)
        )).length;
        if (warmPool.slots.length + activeLegacyCount >= warmPool.targetCount) {
          throw new Error("provider_tab_limit");
        }
        tab = await createOwnedProviderTab(ownedProviderUrl(
          job.provider,
          job.settings.temporaryChat
        ));
        if (!tab || !Number.isInteger(tab.id)) throw new Error("Provider tab was not created");
        job.providerTabId = tab.id;
        await protectOwnedProviderTab(tab.id);
      });
      job.status = "waiting-provider";
      await notifyStatus(job, "waiting-provider");
      await probeProvider(job);
      return tab;
    }

    function currentBatch(job) {
      return job.batches[job.batchIndex] || null;
    }

    function resetStable(job) {
      job.stableSignature = "";
      job.stableReads = 0;
    }

    function clearBusyState(job) {
      job.busyStartedAt = 0;
      job.busyRetryCount = 0;
      job.busyRequestId = "";
    }

    function resetProviderSession(job) {
      job.unsentRequestId = "";
      job.phase = "setup";
      job.setupIndex = 0;
      job.setupAttempts = 0;
      job.retryAttempts = 0;
      clearBusyState(job);
      job.repairBlocks = [];
      job.repairAttempts = 0;
      job.recoveryQueue = [];
      job.recoveryItems = new Map();
      job.pending = false;
      resetStable(job);
    }

    async function completeJob(job, cached) {
      job.status = "completed";
      job.pending = false;
      await persistJob(job);
      // A small content-free receipt survives worker suspension during the next
      // chapter load; completed jobs themselves are removed from session storage.
      await rememberPrefetchParent(job);
      const items = job.batches.flatMap((_batch, index) => job.completed.get(batchIdAt(index)) || []);
      const fallbackCount = items.filter((item) => item?.origin === "convert").length;
      const totalBatches = job.batches.length;
      // Release the completed lease before notifying the reader, which can start
      // prefetch or acknowledge slowly while its document is navigating.
      if (!cached) {
        if (job.poolSlotId) await spendJobSlot(job);
        else await closeLegacyProviderTab(job);
      }
      if (job.prefetch) await notifyPrefetch(job, 'completed');
      if (!job.prefetch) {
        await sendToTab(job.sourceTabId, {
          type: "STV_JOB_COMPLETE",
          jobId: job.id,
          items,
          totalBatches,
          cached: Boolean(cached),
          fallbackCount
        });
      }
      retainTerminalJob(job);
      return { ok: true, jobId: job.id, status: "completed", cached: Boolean(cached), items, totalBatches, fallbackCount };
    }

    function sameCacheIdentity(left, right) {
      return ["provider", "chapterId", "chapterKey", "batchHash", "sourceHash", "promptHash", "nameHash"]
        .every(key => typeof left?.[key] === "string" && left[key] === right?.[key]);
    }

    async function replayExistingJob(job) {
      const items = [];
      for (let index = 0; index < job.batches.length; index += 1) {
        const batchItems = job.completed.get(batchIdAt(index));
        if (!batchItems) continue;
        items.push(...batchItems);
        await sendToTab(job.sourceTabId, {
          type: "STV_BATCH_COMPLETE",
          jobId: job.id,
          batchId: batchIdAt(index),
          batchIndex: index,
          totalBatches: job.batches.length,
          items: batchItems,
          cached: true
        });
      }
      const fallbackCount = items.filter(item => item?.origin === "convert").length;
      if (job.status === "completed") {
        await sendToTab(job.sourceTabId, {
          type: "STV_JOB_COMPLETE",
          jobId: job.id,
          items,
          cached: true,
          fallbackCount,
          totalBatches: job.batches.length
        });
      } else {
        await notifyStatus(job, job.status, job.pauseReason || "");
      }
      return {
        ok: true,
        jobId: job.id,
        status: job.status,
        cached: job.status === "completed",
        items,
        totalBatches: job.batches.length,
        fallbackCount,
        reattached: true
      };
    }

    async function advance(job, options = {}) {
      while (job.batchIndex < job.batches.length && job.completed.has(batchIdAt(job.batchIndex))) {
        job.batchIndex += 1;
      }
      if (job.batchIndex >= job.batches.length) return completeJob(job, false);
      job.phase = "batch";
      job.retryAttempts = 0;
      job.automaticRecoveryCycles = 0;
      job.repairBlocks = [];
      job.repairAttempts = 0;
      job.partialItems = new Map();
      job.recoveryQueue = [];
      job.recoveryItems = new Map();
      job.batchAttempts = 0;
      job.batchSwitched = false;
      job.recoveryStage = "initial";
      job.workState = "queued";
      job.validationDiagnostic = null;
      job.lastBatchError = "";
      clearBusyState(job);
      resetStable(job);
      await persistJob(job);
      if (options.deferDispatch === true) return { ok: true, deferred: true };
      return dispatchCurrent(job);
    }

    async function recoverAcceptedStaleStop(job, details) {
      const oldTabId = job.providerTabId;
      const oldSlotId = job.poolSlotId;
      const incidentKey = `${job.id}:${details.completedBatchIndex}`;
      await errorJournal?.append?.(incidentKey, {
        kind: "stale_stop_detected",
        provider: job.provider,
        phase: diagnosticPhase(job),
        batchIndex: details.completedBatchIndex,
        batchAttempt: details.batchAttempt,
        errorCode: "stale_stop_after_accept",
        validationReason: "stale_stop_after_accept",
        expectedCount: details.expectedCount,
        actualCount: details.expectedCount,
        staleStopWaitMs: details.stableMs,
        outcome: "still_running"
      });

      if (job.batchIndex >= job.batches.length) {
        const recovery = await sendToTab(oldTabId, {
          type: "STVAI_PROVIDER_RECOVER_STALE_STOP",
          jobId: job.id,
          requestId: details.requestId,
          timeoutMs: 3_000
        });
        await errorJournal?.append?.(incidentKey, {
          kind: recovery?.ok === true && recovery.state === "stop_cleared"
            ? "stale_stop_cleared" : "stale_stop_replaced",
          errorCode: "stale_stop_after_accept",
          outcome: "recovered",
          onlyExisting: true
        });
        return completeJob(job, false);
      }

      await advance(job, { deferDispatch: true });
      const recovery = await sendToTab(oldTabId, {
        type: "STVAI_PROVIDER_RECOVER_STALE_STOP",
        jobId: job.id,
        requestId: details.requestId,
        timeoutMs: 3_000
      });
      if (recovery?.ok === true && recovery.state === "stop_cleared") {
        await errorJournal?.append?.(incidentKey, {
          kind: "stale_stop_cleared",
          errorCode: "stale_stop_after_accept",
          outcome: "recovered",
          onlyExisting: true
        });
        return dispatchCurrent(job);
      }

      await notifyStatus(job, "running", "switching_busy_tab");
      let closed = false;
      const slot = oldSlotId
        ? warmPool.slots.find(candidate => candidate.slotId === oldSlotId && candidate.jobId === job.id)
        : null;
      if (slot) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(slot) || slot.jobId !== job.id) return;
          job.providerTabId = null;
          closed = await removeOwnedSlot(slot, { errorReason: "stale_stop_after_accept" });
        });
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab(job);
        closed = !Number.isInteger(job.providerTabId);
      }
      if (!closed) return pause(job, "provider_tab_close_failed");

      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      job.activeRequestId = "";
      job.unsentRequestId = "";
      job.workState = "queued";
      await persistJob(job);
      await errorJournal?.append?.(incidentKey, {
        kind: "stale_stop_replaced",
        errorCode: "stale_stop_after_accept",
        tabClosed: true,
        outcome: "recovered",
        onlyExisting: true
      });
      if (!await acquireWarmSlot(job)) return pause(job, "provider_unavailable");
      return { ok: true, switched: true };
    }

    async function saveCompletedBatch(job, items, options = {}) {
      const id = batchIdAt(job.batchIndex);
      const completedBatchIndex = job.batchIndex;
      const completedBatchAttempt = job.batchAttempts || 0;
      const expectedCount = currentBatch(job)?.length || items.length;
      if (items.some((item) => item.origin === "convert")) job.cacheable = false;
      if (job.cacheable === false) await cache.deleteChapter(job.cacheIdentity);
      else await cache.putBatch(job.cacheIdentity, id, items, {
        inputHash: await batchInputHash(currentBatch(job) || [])
      });
      job.completed.set(id, items);
      await errorJournal?.append?.(`${job.id}:${completedBatchIndex}`, {
        kind: "batch_recovered",
        provider: job.provider,
        phase: diagnosticPhase(job),
        batchIndex: completedBatchIndex,
        batchAttempt: job.batchAttempts || 0,
        outcome: "recovered",
        onlyExisting: true
      });
      if (job.prefetch) await notifyPrefetch(job, 'running');
      if (!job.prefetch) {
        await sendToTab(job.sourceTabId, {
          type: "STV_BATCH_COMPLETE",
          jobId: job.id,
          batchId: id,
          batchIndex: job.batchIndex,
          totalBatches: job.batches.length,
          items,
          cached: false
        });
      }
      job.batchIndex += 1;
      await persistJob(job);
      if (job.provider === "gemini"
        && options.providerTabDisposition === "recover_after_accept"
        && /^batch_\d+_\d{4}$/.test(String(options.requestId || ""))) {
        return recoverAcceptedStaleStop(job, {
          completedBatchIndex,
          batchAttempt: completedBatchAttempt,
          expectedCount,
          requestId: String(options.requestId),
          stableMs: Math.max(0, Math.min(3_000, Number(options.stableMs) || 0))
        });
      }
      return advance(job);
    }

    function currentWorkBlocks(job) {
      return currentBatch(job);
    }

    function canRotateBatch(job) {
      return ["chatgpt", "gemini"].includes(job.provider) && Boolean(job.poolSlotId || job.batchSwitched);
    }

    function malformedBatchResponse(reason) {
      return ["line_count_mismatch", "response_id_mismatch", "invalid_response", "incomplete_response"]
        .includes(String(reason || ""));
    }

    async function providerFailureMetadata(tabId) {
      if (!Number.isInteger(tabId)) return {};
      let timeoutId;
      try {
        const response = await Promise.race([
          tabs.sendMessage(tabId, { type: "STVAI_GET_PAGE_DIAGNOSTICS" }),
          new Promise(resolve => {
            timeoutId = setTimeout(() => resolve(null), providerDiagnosticTimeoutMs);
          })
        ]);
        const runtimeDiagnostic = response?.diagnostic?.runtime || {};
        return {
          generationState: ["generating", "stopped", "stale_stop_confirmed", "unknown"].includes(runtimeDiagnostic.generationState)
            ? runtimeDiagnostic.generationState : "unknown",
          sendState: ["confirmed", "unconfirmed", "unknown"].includes(runtimeDiagnostic.sendState)
            ? runtimeDiagnostic.sendState : "unknown",
          completionSeen: Number(runtimeDiagnostic.completionSeenAt) > 0,
          composerState: runtimeDiagnostic.composerState,
          sendButtonState: runtimeDiagnostic.sendButtonState
        };
      } catch (_error) {
        return {};
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    async function acquireRecoverySlot(job) {
      let assigned = false;
      let blockedReason = "";
      const runnable = () => ["running", "waiting-provider"].includes(job.status)
        && job.recoveryStage === "switching_ready" && !job.poolSlotId;
      await withPoolLock(async () => {
        if (!runnable()) return;
        const config = await readAutomationConfig(job.settings);
        if (!runnable()) return;
        if (!config.enabled || !config.consented) { blockedReason = "automation_disabled"; return; }
        const settingsHash = await hashSettings(job.settings);
        const claimReadySlot = async () => {
          const slot = await verifiedReadySlotByPriority(
            job.provider,
            settingsHash,
            requestedPurposePriorities(job, "recovery")
          );
          if (!runnable()) return;
          if (slot) {
            assignWarmSlot(job, slot);
            assigned = true;
          }
        };
        await claimReadySlot();
        if (!assigned && !blockedReason && warmPool.slots.length < warmPool.targetCount) {
          await fillWarmPool(config.settings, settingsHash);
          await claimReadySlot();
        }
        warmPool.waiters = warmPool.waiters.filter(id => id !== job.id);
        if (assigned) {
          await fillWarmPool(config.settings, settingsHash);
          await persistPool();
          await persistJob(job);
        } else if (!blockedReason) {
          if (isAuthenticationBlocker(warmPool.errorCode)) blockedReason = warmPool.errorCode;
          else {
            warmPool.waiters.push(job.id);
            job.status = "waiting-provider";
            await persistJob(job);
          }
        }
      });
      if (!assigned && !runnable()) return true;
      if (assigned && job.status !== "running") return true;
      if (!assigned && blockedReason) { await pause(job, blockedReason); return true; }
      if (!assigned) { await notifyStatus(job, "waiting-provider", "pool_waiting"); return true; }
      await notifyStatus(job, "running");
      await dispatchCurrent(job);
      return true;
    }

    async function recoverBatch(job, reason) {
      if (job.status !== "running") return { ok: false, reason: "not-runnable" };
      const failedBatchIndex = job.batchIndex;
      const incidentKey = `${job.id}:${failedBatchIndex}`;
      job.workState = "settled";
      job.pending = false;
      job.lastBatchError = reason;
      const failedSlot = warmPool.slots.find(candidate => (
        candidate.slotId === job.poolSlotId && candidate.jobId === job.id
      ));
      const providerMetadata = await providerFailureMetadata(job.providerTabId);
      await errorJournal?.append?.(incidentKey, {
        kind: "response_rejected",
        provider: job.provider,
        phase: diagnosticPhase(job),
        batchIndex: failedBatchIndex,
        batchAttempt: job.batchAttempts || 0,
        errorCode: reason,
        validationReason: job.validationDiagnostic?.reason || reason,
        expectedCount: currentBatch(job)?.length || 0,
        actualCount: job.validationDiagnostic?.actualCount ?? 0,
        nonEmptyLineCount: job.validationDiagnostic?.nonEmptyLineCount ?? 0,
        labelCount: job.validationDiagnostic?.labelCount ?? 0,
        missingLabels: job.validationDiagnostic?.missingLabels || [],
        duplicateLabels: job.validationDiagnostic?.duplicateLabels || [],
        labelsOutOfOrder: job.validationDiagnostic?.labelsOutOfOrder === true,
        responseIdState: job.validationDiagnostic?.responseIdState || "unknown",
        ready3Persisted: Boolean(failedSlot)
          && (job.provider !== "chatgpt" || Number(failedSlot.setupCheckpoint) >= 3),
        slotLeased: failedSlot?.state === "leased",
        firstBatchDispatched: Number(failedSlot?.firstBatchDispatchedAt) > 0,
        ...providerMetadata,
        outcome: "still_running"
      });
      const replaceMalformedSession = malformedBatchResponse(reason) && canRotateBatch(job);
      if (!replaceMalformedSession && (job.batchAttempts || 0) < 2) {
        job.recoveryStage = "retry_same_tab";
        job.workState = "queued";
        resetStable(job);
        await errorJournal?.append?.(incidentKey, {
          kind: "retry_scheduled", recoveryStage: job.recoveryStage
        });
        await notifyStatus(job, "running", "retrying_whole_batch");
        return dispatchCurrent(job);
      }
      if (core.isApiProvider(job.provider) && reason === "source_language_unchanged") {
        job.recoveryStage = "exhausted";
        return pause(job, "api_returned_source_language");
      }
      if ((!replaceMalformedSession && (job.batchAttempts >= 3 || job.batchSwitched)) || !canRotateBatch(job)) {
        job.recoveryStage = "exhausted";
        return pause(job, "batch_recovery_exhausted");
      }
      // Claim the switch before any await; duplicate results cannot retire another slot.
      job.batchSwitched = true;
      job.recoveryStage = "switching_ready";
      const oldTabId = job.providerTabId;
      const oldSlotId = job.poolSlotId;
      const requestId = job.activeRequestId;
      await notifyStatus(job, "running", "switching_ready_batch");
      if (job.status !== "running" || job.activeRequestId !== requestId) return { ok: false, reason: "not-runnable" };
      await sendToTab(oldTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id, requestId });
      let closed = false;
      await withPoolLock(async () => {
        if (job.status !== "running" || job.activeRequestId !== requestId) return;
        const slot = warmPool.slots.find(candidate => candidate.slotId === oldSlotId && candidate.jobId === job.id);
        if (slot) {
          // onRemoved can arrive while removal persists its metadata. It must
          // never mistake this intentionally retired tab for a live legacy job.
          job.providerTabId = null;
          closed = await removeOwnedSlot(slot, { errorReason: reason });
        }
      });
      await errorJournal?.append?.(incidentKey, {
        kind: "tab_retired",
        recoveryStage: job.recoveryStage,
        tabClosed: closed
      });
      if (job.status !== "running" || job.activeRequestId !== requestId) return { ok: false, reason: "not-runnable" };
      if (!closed) return pause(job, "provider_tab_close_failed");
      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      job.unsentRequestId = "";
      job.workState = "queued";
      resetStable(job);
      await persistJob(job);
      if (replaceMalformedSession && job.batchAttempts >= 3) {
        if (job.provider === "gemini" && (job.automaticRecoveryCycles || 0) < 1) {
          job.automaticRecoveryCycles = (job.automaticRecoveryCycles || 0) + 1;
          job.batchAttempts = 0;
          job.batchSwitched = false;
          job.recoveryStage = "initial";
          job.activeRequestId = "";
          await persistJob(job);
          await notifyStatus(job, "running", "automatic_recovery_cycle");
          if (!await acquireWarmSlot(job)) return pause(job, "provider_unavailable");
          return { ok: true, automaticRecovery: true };
        }
        job.recoveryStage = "exhausted";
        const result = await pause(job, "batch_recovery_exhausted");
        await ensureWarmPool(job.settings);
        return result;
      }
      if (!await acquireWarmSlot(job)) return pause(job, "provider_unavailable");
      if (job.status === "running" && Number.isInteger(job.providerTabId)) {
        await errorJournal?.append?.(incidentKey, {
          kind: "tab_replaced",
          recoveryStage: job.recoveryStage
        });
      }
      return { ok: true, switched: true };
    }

    async function processTranslation(job, message, authoritative) {
      const id = batchIdAt(job.batchIndex);
      if (message.batchId && message.batchId !== id) return { ok: false, reason: "stale-batch" };
      if (message.requestId && job.activeRequestId && message.requestId !== job.activeRequestId) {
        return { ok: false, reason: "stale-request" };
      }
      if (job.workState === "settled") return { ok: false, reason: "settled-request" };
      const expectedBlocks = currentWorkBlocks(job);
      if (String(message.outcomeCode || "") === "content_refused") {
        job.workState = "settled";
        return pause(job, "content_refused");
      }
      const signature = `${job.phase}\u0000${message.requestId || id}\u0000${String(message.text || "")}`;
      if (!authoritative) {
        if (job.stableSignature === signature) job.stableReads += 1;
        else {
          job.stableSignature = signature;
          job.stableReads = 1;
        }
        if (job.stableReads < 2) return { ok: true, stable: false };
      }

      // Settle synchronously before cache writes or subgroup dispatch can yield.
      job.workState = "settled";

      const validation = core.validateTranslationResponse(message.text, {
        jobId: job.id,
        batchId: id,
        requestId: message.requestId || job.activeRequestId || id,
        expectedIds: expectedBlocks.map((block) => block.id),
        allowBare: core.isApiProvider(job.provider)
      });
      const responseShape = core.analyzeTranslationResponseShape?.(message.text, {
        expectedCount: expectedBlocks.length,
        expectedResponseId: message.requestId || job.activeRequestId || id
      }) || {};
      job.validationDiagnostic = {
        expectedCount: expectedBlocks.length,
        actualCount: validation.actualCount ?? validation.items.length,
        reason: validation.ok ? "ok" : (validation.reason || "invalid_response"),
        ...responseShape
      };
      const outcomeCode = String(message.outcomeCode || "ok");
      if (validation.ok) {
        if (core.isApiProvider(job.provider) && core.validateApiTranslationItems) {
          const languageValidation = core.validateApiTranslationItems(validation.items, expectedBlocks);
          if (!languageValidation.ok) {
            job.validationDiagnostic.reason = languageValidation.reason;
            return recoverBatch(job, languageValidation.reason);
          }
        }
        const items = core.filterTranslationItems(
          validation.items.map((item) => ({ ...item, origin: "ai" })), expectedBlocks
        );
        return saveCompletedBatch(job, items, {
          providerTabDisposition: message.providerTabDisposition,
          requestId: message.requestId,
          stableMs: message.stableMs
        });
      }
      return recoverBatch(job, validation.reason || (outcomeCode !== "ok" ? outcomeCode : "invalid_response"));
    }

    async function processProviderResult(job, message, authoritative) {
      if (job.status === "cancelled") return { ok: false, reason: "cancelled-job" };
      if (job.status === "completed") return { ok: false, reason: "completed-job" };
      if (job.status === "paused") return { ok: false, reason: "paused-job" };
      if (message.phase !== job.phase) return { ok: false, reason: "stale-phase" };

      if (job.phase === "setup") {
        if (message.setupIndex != null && Number(message.setupIndex) !== job.setupIndex) {
          return { ok: false, reason: "stale-setup" };
        }
        const validation = validateSetupProviderResult(message, {
          jobId: job.id,
          setupId: job.setupId,
          part: SETUP_PARTS[job.setupIndex]
        });
        if (!validation.ok) {
          job.setupAttempts += 1;
          if (job.setupAttempts > 2) return pause(job, "invalid_setup_response");
          await dispatchCurrent(job);
          return { ok: true, retry: true };
        }
        job.setupIndex += 1;
        job.setupAttempts = 0;
        job.retryAttempts = 0;
        if (job.setupIndex >= job.setupMessages.length) {
          job.phase = "batch";
          resetStable(job);
        }
        await persistJob(job);
        await dispatchCurrent(job);
        return { ok: true, accepted: true };
      }
      return processTranslation(job, message, authoritative);
    }

    function currentProviderMessage(job) {
      if (job.phase === "setup") {
        return {
          type: "STVAI_PROVIDER_SEND",
          phase: "setup",
          jobId: job.id,
          setupIndex: job.setupIndex,
          setupId: job.setupId,
          setupPart: SETUP_PARTS[job.setupIndex],
          responseMarker: core.READY_MARKERS[SETUP_PARTS[job.setupIndex]],
          prompt: job.setupMessages[job.setupIndex],
          temporaryTimeoutMs: warmTemporaryTimeoutMs,
          sendTimeoutMs: readySendTimeoutFor(job.provider),
          timeoutMs: readyTimeoutFor(job.provider),
          markerGraceMs: READY_MARKER_GRACE_MS,
          temporaryChat: job.settings.temporaryChat
        };
      }
      const id = batchIdAt(job.batchIndex);
      const blocks = currentWorkBlocks(job);
      const reconcilingUnconfirmedSend = Boolean(job.unsentRequestId);
      job.requestSequence = Math.max(0, Number(job.requestSequence) || 0) + 1;
      job.usedRequestIds ||= new Set();
      let requestId = job.unsentRequestId || core.createBatchResponseId(job.batchIndex);
      if (!job.unsentRequestId) {
        while (job.usedRequestIds.has(requestId)) {
          const separator = requestId.lastIndexOf("_");
          requestId = requestId.slice(0, separator + 1) + String((Number(requestId.slice(separator + 1)) + 1) % 10000).padStart(4, "0");
        }
      }
      job.usedRequestIds.add(requestId);
      job.workState = "sending";
      job.activeRequestId = requestId;
      if (!reconcilingUnconfirmedSend) job.batchAttempts = (job.batchAttempts || 0) + 1;
      const prompt = core.createBatchPrompt({
          jobId: job.id,
          batchId: id,
          requestId,
          responseId: requestId,
          batchIndex: job.batchIndex,
          totalBatches: job.batches.length,
          blocks,
          settings: job.settings
        });
      const message = {
        type: "STVAI_PROVIDER_SEND",
        phase: job.phase,
        jobId: job.id,
        batchId: id,
        requestId,
        expectedIds: blocks.map((block) => block.id),
        recovery: job.batchAttempts > 1,
        batchAttempt: job.batchAttempts,
        prompt,
        sendTimeoutMs: 30_000,
        timeoutMs: 60_000,
        temporaryChat: job.settings.temporaryChat
      };
      if (job.warmSessionId && job.settingsHash) {
        message.requiredWarmSessionId = job.warmSessionId;
        message.requiredSettingsHash = job.settingsHash;
      }
      return message;
    }

    async function retryCurrent(job, reason) {
      if (job.status !== "running") return { ok: false, reason: "not-runnable" };
      if (job.phase !== "setup") {
        job.workState = "settled";
        if (job.provider === "gemini" && ["provider_busy", "provider_busy_timeout"].includes(reason)) {
          const requestId = job.unsentRequestId || job.activeRequestId;
          const alreadyTracked = job.busyRequestId === requestId && job.busyStartedAt > 0;
          if (reason === "provider_busy_timeout") {
            job.busyStartedAt = Math.max(1, Math.min(job.busyStartedAt || now(), now() - 30_000));
          } else if (!job.busyStartedAt) {
            job.busyStartedAt = now();
          }
          if (!alreadyTracked) job.busyRetryCount = Math.max(0, Number(job.busyRetryCount) || 0) + 1;
          job.busyRequestId = requestId;
          job.unsentRequestId = requestId;
          job.workState = "queued";
          await persistJob(job);
          await notifyStatus(job, "running", reason === "provider_busy_timeout"
            ? "switching_busy_tab" : "waiting_provider_busy");
          if (reason === "provider_busy_timeout" || now() - job.busyStartedAt >= 30_000) {
            return recoverBusyGeminiTab(job);
          }
          await retrySleep(Math.min(retryDelayMs, Math.max(0, 30_000 - (now() - job.busyStartedAt))));
          if (job.status !== "running") return { ok: false, reason: "not-runnable" };
          return dispatchCurrent(job);
        }
        if (reason === "temporary_unavailable" && job.provider === "gemini"
          && job.settings?.temporaryChat !== false) {
          return recoverLostGeminiTemporaryChat(job);
        }
        if (reason === "send_not_confirmed" && job.provider === "gemini"
          && job.unsentRequestId && job.retryAttempts < 1) {
          job.retryAttempts += 1;
          job.workState = "queued";
          await notifyStatus(job, "running", "rechecking_send");
          await retrySleep(retryDelayMs);
          if (job.status !== "running") return { ok: false, reason: "not-runnable" };
          return dispatchCurrent(job);
        }
        if (["response_timeout", "network_error", "provider_unavailable"].includes(reason)) return recoverBatch(job, reason);
        return pause(job, reason);
      }
      const retryable = new Set([
        "response_timeout", "provider_busy", "provider_unreachable", "network_error", "provider_unavailable"
      ]);
      if (!retryable.has(reason) || job.retryAttempts >= 2) {
        job.retryAttempts = 0;
        return pause(job, reason);
      }
      job.retryAttempts += 1;
      await notifyStatus(job, "running", "auto_retry");
      await retrySleep(retryDelayMs);
      if (job.status !== "running") return { ok: false, reason: "not-runnable" };
      return dispatchCurrent(job);
    }

    async function recoverBusyGeminiTab(job) {
      const oldTabId = job.providerTabId;
      const oldSlotId = job.poolSlotId;
      const requestId = job.busyRequestId || job.unsentRequestId || job.activeRequestId;
      const slot = oldSlotId
        ? warmPool.slots.find((candidate) => candidate.slotId === oldSlotId && candidate.jobId === job.id)
        : null;
      const incidentKey = `${job.id}:${job.batchIndex}`;
      // Claim the switch before awaiting diagnostics so duplicate results cannot
      // retire another slot while this recovery is in progress.
      job.workState = "queued";
      job.recoveryStage = "switching_ready";
      job.batchSwitched = true;
      await notifyStatus(job, "running", "switching_busy_tab");
      if (job.status !== "running" || job.activeRequestId !== requestId) {
        return { ok: false, reason: "not-runnable" };
      }
      const providerMetadata = await providerFailureMetadata(oldTabId);
      await errorJournal?.append?.(incidentKey, {
        kind: "response_rejected",
        provider: job.provider,
        phase: diagnosticPhase(job),
        batchIndex: job.batchIndex,
        batchAttempt: job.batchAttempts || 0,
        errorCode: "provider_busy_timeout",
        validationReason: "provider_busy_timeout",
        expectedCount: currentBatch(job)?.length || 0,
        busyWaitMs: Math.min(30_000, Math.max(0, now() - Number(job.busyStartedAt || now()))),
        busyRetryCount: job.busyRetryCount || 0,
        slotLeased: slot?.state === "leased",
        firstBatchDispatched: Number(slot?.firstBatchDispatchedAt) > 0,
        ...providerMetadata,
        outcome: "still_running"
      });
      if (job.status !== "running" || job.activeRequestId !== requestId) {
        return { ok: false, reason: "not-runnable" };
      }
      await sendToTab(oldTabId, {
        type: "STVAI_PROVIDER_CANCEL",
        jobId: job.id,
        requestId
      });

      let closed = false;
      if (slot) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(slot) || slot.jobId !== job.id) return;
          job.providerTabId = null;
          closed = await removeOwnedSlot(slot, { errorReason: "provider_busy_timeout" });
        });
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab(job);
        closed = !Number.isInteger(job.providerTabId);
      }
      if (!closed) return pause(job, "provider_tab_close_failed");
      await errorJournal?.append?.(incidentKey, {
        kind: "tab_retired",
        errorCode: "provider_busy_timeout",
        recoveryStage: job.recoveryStage,
        tabClosed: true
      });

      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      job.activeRequestId = "";
      job.unsentRequestId = requestId;
      await persistJob(job);
      return acquireRecoverySlot(job);
    }

    async function recoverLostGeminiTemporaryChat(job) {
      const oldTabId = job.providerTabId;
      const oldSlotId = job.poolSlotId;
      const slot = oldSlotId
        ? warmPool.slots.find((candidate) => candidate.slotId === oldSlotId && candidate.jobId === job.id)
        : null;
      job.workState = "queued";
      await notifyStatus(job, "running", "recovering_temporary_chat");
      await sendToTab(oldTabId, {
        type: "STVAI_PROVIDER_CANCEL",
        jobId: job.id,
        requestId: job.activeRequestId
      });

      let closed = false;
      if (slot) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(slot) || slot.jobId !== job.id) return;
          // Detach the job before tabs.remove can synchronously deliver onRemoved.
          job.providerTabId = null;
          closed = await removeOwnedSlot(slot, { errorReason: "temporary_unavailable" });
        });
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab(job);
        closed = !Number.isInteger(job.providerTabId);
      }
      if (!closed) return pause(job, "provider_tab_close_failed");

      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      job.unsentRequestId = "";
      job.activeRequestId = "";
      // The adapter refuses this request before Send, so it must not consume a
      // translation attempt or force the user into the manual recovery path.
      job.batchAttempts = Math.max(0, (job.batchAttempts || 0) - 1);
      resetStable(job);
      await persistJob(job);
      if (!await acquireWarmSlot(job)) return pause(job, "provider_unavailable");
      return { ok: true, recovering: true };
    }

    async function dispatchCurrent(job) {
      if (job.pending || job.status !== "running") return { ok: false, reason: "not-runnable" };
      if (job.phase !== "setup") {
        if (job.workState === "sending") return { ok: false, reason: "request-in-flight" };
        const limit = canRotateBatch(job) ? 3 : 2;
        if ((job.batchAttempts || 0) >= limit && !job.unsentRequestId) return pause(job, "batch_recovery_exhausted");
      }
      if (job.phase !== "setup" && !currentBatch(job)) return completeJob(job, false);
      if (core.isApiProvider(job.provider)) return dispatchApi(job);
      const slot = job.poolSlotId
        ? warmPool.slots.find((candidate) => candidate.slotId === job.poolSlotId)
        : null;
      if (!(await providerTabMatches(job.provider, job.providerTabId, slot?.lastKnownUrl || ""))) {
        if (slot) {
          slot.state = "failed";
          slot.errorCode = "provider_origin_mismatch";
          exposeSlotFailureToPool(slot);
          await persistPool();
          await notifyPoolStatus();
        }
        return pause(job, "provider_origin_mismatch");
      }
      if (job.pending || job.status !== "running" || (job.phase !== "setup" && job.workState === "sending")) return { ok: false, reason: "not-runnable" };
      const providerMessage = currentProviderMessage(job);
      const providerTabId = job.providerTabId;
      if (slot && job.phase === "batch" && !slot.firstBatchDispatchedAt) {
        slot.firstBatchDispatchedAt = now();
        await persistPool();
      }
      job.pending = true;
      await persistJob(job);
      if (job.status !== "running" || job.providerTabId !== providerTabId) return { ok: false, reason: "not-runnable" };
      let response;
      try {
        response = await sendProviderMessage(
          job.provider,
          job.providerTabId,
          providerMessage
        );
      } catch (_error) {
        if (job.status !== "running" || job.providerTabId !== providerTabId || (providerMessage.requestId && providerMessage.requestId !== job.activeRequestId)) return { ok: false, reason: "stale-provider-response" };
        job.pending = false;
        return retryCurrent(job, "provider_unreachable");
      }
      if (job.status !== "running" || job.providerTabId !== providerTabId || (providerMessage.requestId && providerMessage.requestId !== job.activeRequestId)) return { ok: false, reason: "stale-provider-response" };
      job.pending = false;
      if (!response || typeof response !== "object" || !("response" in response || response.ok === false)) {
        clearBusyState(job);
        return { ok: true, pendingExternalResult: true };
      }
      if (response.jobId && String(response.jobId) !== job.id) {
        return { ok: false, reason: "stale-provider-response" };
      }
      if (response.ok === false) {
        if (["send_not_confirmed", "ui_changed"].includes(response.error?.code)) {
          job.unsentRequestId = providerMessage.requestId;
        }
        return retryCurrent(job, response.error && response.error.code || "provider_error");
      }
      job.unsentRequestId = "";
      job.retryAttempts = 0;
      clearBusyState(job);
      return processProviderResult(job, {
        ...providerMessage,
        text: response.response,
        outcomeCode: response.outcomeCode || "ok",
        setupValidation: response.setupValidation,
        completionMode: response.completionMode,
        providerTabDisposition: response.providerTabDisposition,
        stableMs: response.stableMs
      }, true);
    }

    async function dispatchApi(job) {
      if (!apiClient?.translate) return pause(job, "api_client_unavailable");
      job.pending = true;
      const apiKey = await loadApiKey(job.provider);
      if (job.status !== "running") return { ok: false, reason: "not-runnable" };
      if (!apiKey.trim()) return pause(job, "api_key_missing");
      const providerMessage = currentProviderMessage(job);
      const blocks = currentWorkBlocks(job);
      const messages = core.createApiMessages({
        jobId: job.id,
        batchId: providerMessage.batchId,
        requestId: providerMessage.requestId,
        batchIndex: job.batchIndex,
        totalBatches: job.batches.length,
        blocks,
        settings: job.settings,
        retryReason: providerMessage.recovery ? job.lastBatchError : ""
      });
      const controller = new AbortController();
      job.apiAbortController?.abort();
      job.apiAbortController = controller;
      try {
        await persistJob(job);
        if (job.status !== "running" || controller.signal.aborted || job.activeRequestId !== providerMessage.requestId) {
          return { ok: false, reason: "not-runnable" };
        }
        const response = await apiClient.translate({
          provider: job.provider,
          apiKey,
          model: apiModel(job.settings),
          safetyOff: job.provider === "gemini_api" && job.settings.geminiSafetyOff,
          temperature: job.apiTemperatureFallback ? undefined : job.settings.apiTemperature,
          system: messages.system,
          user: messages.user,
          signal: controller.signal
        });
        if (job.status !== "running" || job.activeRequestId !== providerMessage.requestId || job.apiAbortController !== controller) {
          return { ok: false, reason: "stale-provider-response" };
        }
        job.pending = false;
        job.apiAbortController = null;
        job.retryAttempts = 0;
        if (response.temperatureFallback) {
          job.apiTemperatureFallback = true;
          await notifyStatus(job, "running", "api_temperature_default");
        }
        return processProviderResult(job, { ...providerMessage, text: response.text, outcomeCode: response.outcomeCode || "ok" }, true);
      } catch (error) {
        if (job.status !== "running" || job.activeRequestId !== providerMessage.requestId
          || job.apiAbortController !== controller || error?.code === "request_cancelled") return { ok: false, reason: "stale-provider-response" };
        job.pending = false;
        job.apiAbortController = null;
        if (["content_refused", "incomplete_response", "invalid_response", "empty_response"].includes(error?.code)) {
          return processProviderResult(job, {
            ...providerMessage,
            text: "",
            outcomeCode: error.code === "empty_response" ? "incomplete_response" : error.code
          }, true);
        }
        return retryCurrent(job, typeof error?.code === "string" ? error.code : "provider_error");
      } finally {
        if (job.apiAbortController === controller) {
          job.pending = false;
          job.apiAbortController = null;
        }
      }
    }

    async function probeProvider(job, options = {}) {
      if (!job || job.status !== "waiting-provider" || !Number.isInteger(job.providerTabId)) return;
      let response;
      try {
        response = await tabs.sendMessage(job.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
      } catch (_error) {
        if (options.pauseIfUnavailable) await pause(job, "provider_unreachable");
        return;
      }
      const state = response && response.state;
      if (!state || !state.state) {
        if (options.pauseIfUnavailable) await pause(job, "provider_unreachable");
        return;
      }
      if (state.state !== "ready") {
        await pause(job, state.code || state.state);
        return;
      }
      job.status = "running";
      job.pauseReason = "";
      await notifyStatus(job, "running");
      await dispatchCurrent(job);
    }

    const pendingPrefetch = new Map();
    const ttsStartFlights = new Map();

    function cancelPendingPrefetch(tabId, jobId) {
      for (const admission of pendingPrefetch.values()) {
        if (admission.tabId === tabId && (!jobId || admission.jobId === jobId)) admission.cancelled = true;
      }
    }

    function startJob(message, sender) {
      const flightKey = message?.ttsSessionId && Number.isInteger(sender?.tab?.id)
        ? `${sender.tab.id}:${message.ttsSessionId}:${String(message.jobId || "")}`
        : "";
      if (flightKey && ttsStartFlights.has(flightKey)) return ttsStartFlights.get(flightKey);
      const operation = startJobReserved(message, sender);
      if (!flightKey) return operation;
      const tracked = operation.finally(() => {
        if (ttsStartFlights.get(flightKey) === tracked) ttsStartFlights.delete(flightKey);
      });
      ttsStartFlights.set(flightKey, tracked);
      return tracked;
    }

    async function startJobReserved(message, sender) {
      const admission = { reserved: false, tabId: sender?.tab?.id, jobId: message.jobId, cancelled: false };
      const key = `${admission.tabId}:${admission.jobId}`;
      if (message.prefetch) {
        if (Array.from(pendingPrefetch.values()).some(item => item.tabId === admission.tabId && !item.cancelled)) return { ok: false, reason: 'prefetch_not_allowed' };
        pendingPrefetch.set(key, admission);
      } else cancelPendingPrefetch(admission.tabId);
      try {
        return await startJobAttempt(message, sender, admission);
      } finally {
        if (pendingPrefetch.get(key) === admission) pendingPrefetch.delete(key);
        // Failed admission must remain retryable, without releasing another
        // controller's reservation or a job that has already been accepted.
        if (admission.reserved && message.ttsSessionId && !jobs.has(message.jobId) && Number.isInteger(sender?.tab?.id)) {
          await withTtsLock(async () => {
            const key = `${TTS_SESSION_PREFIX}${sender.tab.id}`;
            const stored = await storageCall(sessionStorage, "get", key);
            const session = stored?.[key];
            if (session?.sessionId !== message.ttsSessionId || session.jobId !== message.jobId) return;
            const { jobId, ...unclaimed } = session;
            await storageCall(sessionStorage, "set", { [key]: unclaimed });
          });
        }
      }
    }

    async function startJobAttempt(message, sender, admission) {
      const id = String(message.jobId || "");
      if (!id || !sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
        return { ok: false, reason: "invalid-start" };
      }
      if (!isStvSender(sender)) return { ok: false, reason: 'unauthorized-sender' };
      const admissionPhase = message.ttsSessionId ? "tts" : message.prefetch === true ? "prefetch" : "chapter";
      const logAdmissionFailure = async (errorCode) => errorJournal?.append?.(
        `admission:${id}:${admissionPhase}:${now()}`,
        {
          kind: admissionPhase === "tts" ? "tts_handoff_failed"
            : admissionPhase === "prefetch" ? "prefetch_failed" : "chapter_failed",
          provider: message.provider,
          phase: admissionPhase,
          errorCode,
          validationReason: errorCode,
          outcome: "failed"
        }
      );
      if (typeof message.chapterId !== "string" || !message.chapterId.trim()) {
        await logAdmissionFailure("invalid-chapter");
        return { ok: false, reason: "invalid-chapter" };
      }
      const current = resolveStvSenderChapter(sender, message.prefetch === true ? "" : message.chapterId);
      const chapter = message.prefetch === true ? sites.parseChapter(message.targetUrl) : current;
      if (!current || !chapter || chapter.chapterId !== message.chapterId
        || (message.prefetch === true && (chapter.origin !== current.origin || chapter.bookKey !== current.bookKey
          || chapter.chapterId === current.chapterId))) {
        await logAdmissionFailure("invalid-chapter");
        return { ok: false, reason: "invalid-chapter" };
      }
      if (!await authorizeTtsStart(message, sender)) {
        await logAdmissionFailure("tts_handoff_failed");
        return { ok: false, reason: "stale-tts-session" };
      }
      admission.reserved = Boolean(message.ttsSessionId);
      const toolState = storage?.local?.get
        ? await storageCall(storage.local, "get", "toolEnabled").catch(() => ({}))
        : {};
      if (Object.hasOwn(toolState || {}, "toolEnabled") && toolState.toolEnabled !== true) {
        return { ok: false, reason: "tool_disabled" };
      }
      if (isStvUrl(sender.tab.url) || !sender.tab.url) {
        registerStvTab(sender.tab.id, sender.tab.url);
      }
      await restorePoolMetadata();
      if (core.isWebProvider(message.provider)) {
        if (message.manualStart === true) {
          warmPool.suspendedStvTabs.delete(sender.tab.id);
          await persistPool();
        } else if (warmPool.suspendedStvTabs.has(sender.tab.id)) {
          return { ok: false, reason: "user_cancelled" };
        }
      }
      const blocks = (Array.isArray(message.blocks) ? message.blocks : []).map((block) => ({
        id: String(block && block.id || ""),
        text: String(block && block.text || ""),
        convert: String(block && block.convert || "")
      })).filter((block) => block.id && block.text);
      if (!blocks.length) return { ok: false, reason: "empty-chapter" };
      if (new Set(blocks.map(block => block.id)).size !== blocks.length) return { ok: false, reason: 'invalid-blocks' };

      const settings = await loadSettings(message);
      if (message.prefetch === true) {
        await restoreJobs();
        const config = await readAutomationConfig(settings);
        if (!config.consented || !await hasPrefetchParent(message, sender.tab.id, settings)
          || Array.from(jobs.values()).some(job => job.sourceTabId === sender.tab.id && !["completed", "cancelled"].includes(job.status))) {
          return { ok: false, reason: "prefetch_not_allowed" };
        }
      }
      if (!core.hasTranslationPrompt(settings)) {
        return { ok: false, reason: "prompt_not_configured" };
      }
      let batches;
      let allBatches;
      try {
        allBatches = core.splitIntoBatches(blocks, core.TRANSLATION_BATCH_LIMITS);
        batches = allBatches;
        if (message.prefetch === true) batches = batches.slice(0, core.PREFETCH_BATCH_LIMIT);
      } catch (error) {
        if (error instanceof RangeError) return { ok: false, reason: "block-too-large" };
        throw error;
      }
      const identity = await cacheIdentity(chapter, settings, blocks, allBatches);
      await restoreJobs();
      if (!message.prefetch) await clearPrefetchParent(sender.tab.id);
      if (admission.cancelled) return { ok: false, reason: 'user_cancelled' };
      const existing = jobs.get(id);
      if (existing && existing.status !== "cancelled" && message.ttsSessionId && existing.sourceTabId === sender.tab.id
        && existing.prefetch !== true && sameCacheIdentity(existing.cacheIdentity, identity)) {
        return replayExistingJob(existing);
      }
      if (existing && !["cancelled", "completed"].includes(existing.status)) {
        return { ok: false, reason: "job-exists" };
      }
      for (const priorJob of jobs.values()) {
        if (
          priorJob.id !== id
          && priorJob.sourceTabId === sender.tab.id
          && !["cancelled", "completed"].includes(priorJob.status)
        ) {
          if (message.prefetch) return { ok: false, reason: 'prefetch_not_allowed' };
          priorJob.status = "cancelled";
          priorJob.pending = false;
          priorJob.apiAbortController?.abort();
          priorJob.apiAbortController = null;
          await sendToTab(priorJob.providerTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: priorJob.id });
          await notifyStatus(priorJob, "cancelled", "superseded");
          if (priorJob.poolSlotId) await spendJobSlot(priorJob);
          else await closeLegacyProviderTab(priorJob);
          retainTerminalJob(priorJob);
        }
      }
      const setupId = `setup-${id}`;
      const job = {
        id,
        prefetch: message.prefetch === true,
        workflow: admissionPhase,
        cacheable: true,
        sourceTabId: sender.tab.id,
        provider: settings.provider,
        providerTabId: null,
        warmSessionId: "",
        settingsHash: "",
        poolSlotId: "",
        status: "starting",
        settings,
        cacheIdentity: identity,
        blocks,
        batches,
        completed: new Map(),
        batchIndex: 0,
        setupId,
        setupMessages: core.isApiProvider(settings.provider) ? [] : core.createSetupMessages({ setupId, jobId: id, settings }),
        setupIndex: 0,
        setupAttempts: 0,
        retryAttempts: 0,
        automaticRecoveryCycles: 0,
        phase: core.isApiProvider(settings.provider) ? "batch" : "setup",
        pending: false,
        repairBlocks: [],
        repairAttempts: 0,
        partialItems: new Map(),
        recoveryQueue: [],
        recoveryItems: new Map(),
        requestSequence: 0,
        recoveryRequests: 0,
        workState: "queued",
        usedRequestIds: new Set(),
        refusalReplacementAttempts: 0,
        busyStartedAt: 0,
        busyRetryCount: 0,
        busyRequestId: "",
        stableSignature: "",
        stableReads: 0,
        apiAbortController: null,
        apiTemperatureFallback: false
      };
      if (admission.cancelled) return { ok: false, reason: 'user_cancelled' };
      if (!await authorizeTtsStart(message, sender, () => jobs.set(id, job))) {
        return { ok: false, reason: "stale-tts-session" };
      }
      await persistJob(job);

      const saved = await cache.getChapter(identity);
      const inputHashes = Object.fromEntries(await Promise.all(batches.map(async (batch, index) => ([
        batchIdAt(index),
        await batchInputHash(batch)
      ]))));
      const compatible = typeof cache.getCompatibleBatches === "function"
        ? await cache.getCompatibleBatches(identity, inputHashes)
        : null;
      if (admission.cancelled || job.status === 'cancelled') return { ok: false, reason: 'user_cancelled' };
      for (let index = 0; index < batches.length; index += 1) {
        const batchId = batchIdAt(index);
        const items = saved?.batches?.[batchId]?.items || compatible?.batches?.[batchId]?.items;
        if (exactItems(items, batches[index])) job.completed.set(batchId, core.filterTranslationItems(items, batches[index]));
      }
      if (job.completed.size === batches.length) return completeJob(job, true);
      for (let index = 0; index < batches.length; index += 1) {
        const batchId = batchIdAt(index);
        const items = job.completed.get(batchId);
        if (!items) continue;
        if (!job.prefetch) {
          await sendToTab(job.sourceTabId, {
            type: "STV_BATCH_COMPLETE",
            jobId: job.id,
            batchId,
            batchIndex: index,
            totalBatches: batches.length,
            items,
            cached: true
          });
        }
      }
      while (job.completed.has(batchIdAt(job.batchIndex))) job.batchIndex += 1;
      await persistJob(job);

      if (admission.cancelled || job.status === 'cancelled') return { ok: false, reason: 'user_cancelled' };
      if (core.isApiProvider(job.provider)) {
        job.status = "running";
        await notifyStatus(job, "running");
        const dispatched = await dispatchCurrent(job);
        return {
          ok: dispatched?.ok !== false || job.status === "completed",
          jobId: id,
          status: job.status,
          cached: false,
          providerTabId: null,
          totalBatches: batches.length,
          fallbackCount: Array.from(job.completed.values()).flat().filter((item) => item?.origin === "convert").length,
          paused: job.status === "paused",
          reason: job.pauseReason || dispatched?.reason || ""
        };
      }

      if (await acquireWarmSlot(job)) {
        return {
          ok: true,
          jobId: id,
          status: job.status,
          cached: false,
          providerTabId: job.providerTabId,
          totalBatches: batches.length,
          fallbackCount: Array.from(job.completed.values()).flat().filter((item) => item?.origin === "convert").length,
          paused: job.status === "paused",
          reason: job.pauseReason || ""
        };
      }

      try {
        await openProvider(job);
      } catch (error) {
        if (error?.message === "provider_tab_limit") {
          await pause(job, "provider_tab_limit");
          return { ok: false, reason: "provider-tab-limit" };
        }
        await pause(job, "provider_tab_failed");
        return { ok: false, reason: "provider-tab-failed" };
      }
      return {
        ok: true,
        jobId: id,
        status: job.status,
        cached: false,
        providerTabId: job.providerTabId,
        totalBatches: batches.length,
        fallbackCount: Array.from(job.completed.values()).flat().filter((item) => item?.origin === "convert").length,
        paused: job.status === "paused",
        reason: job.pauseReason || ""
      };
    }

    async function cancelJob(message, sender) {
      cancelPendingPrefetch(sender?.tab?.id, String(message.jobId || ''));
      const job = await ensureJob(String(message.jobId || ""));
      if (!job) return { ok: false, reason: "stale-job" };
      if (sender?.tab?.id !== job.sourceTabId) return { ok: false, reason: "wrong-source-tab" };
      if (job.status === "cancelled") return { ok: true, cancelled: true };
      if (!job.prefetch) await clearPrefetchParent(job.sourceTabId);
      if (!job.prefetch && core.isWebProvider(job.provider) && message.reason !== "chapter_changed") {
        warmPool.suspendedStvTabs.add(job.sourceTabId);
        await persistPool();
      }
      job.status = "cancelled";
      job.pending = false;
      job.apiAbortController?.abort();
      job.apiAbortController = null;
      await sendToTab(job.providerTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id });
      await notifyStatus(job, "cancelled");
      if (job.poolSlotId) await spendJobSlot(job);
      else await closeLegacyProviderTab(job);
      if (core.isWebProvider(job.provider) && !hasEligibleStvTab()) {
        await cleanupWarmPool();
      }
      retainTerminalJob(job);
      return { ok: true, cancelled: true };
    }

    async function resumeJob(message, sender) {
      const job = await ensureJob(String(message.jobId || ""));
      if (!job) return { ok: false, reason: "stale-job" };
      if (sender?.tab?.id !== job.sourceTabId) return { ok: false, reason: "wrong-source-tab" };
      if (job.status !== "paused") return { ok: false, reason: "job-not-paused" };
      if (!job.unsentRequestId
        && job.lastBatchError === "response_timeout"
        && /^batch_\d+_\d{4}$/.test(job.activeRequestId || "")
        && Number.isInteger(job.providerTabId)) {
        job.unsentRequestId = job.activeRequestId;
      }
      job.batchAttempts = 0;
      job.batchSwitched = false;
      job.recoveryStage = "initial";
      job.workState = "queued";
      job.status = "running";
      job.pauseReason = "";
      if (core.isApiProvider(job.provider)) {
        job.status = "running";
        job.pauseReason = "";
        await notifyStatus(job, "running");
        await dispatchCurrent(job);
        return { ok: true, resumed: true };
      }
      if (isAuthenticationBlocker(warmPool.errorCode)) {
        await withPoolLock(async () => {
          for (const slot of [...warmPool.slots]) {
            if (slot.state === "failed" && isAuthenticationBlocker(slot.errorCode)) {
              await removeOwnedSlot(slot, { removalReason: "authentication_retry" });
            }
          }
          warmPool.errorCode = "";
          await persistPool();
        });
        job.providerTabId = null;
        job.poolSlotId = "";
        job.warmSessionId = "";
        job.settingsHash = "";
        resetProviderSession(job);
        job.status = "running";
        job.pauseReason = "";
        if (await acquireWarmSlot(job)) {
          return {
            ok: true,
            resumed: job.status === "running",
            paused: job.status === "paused",
            reason: job.pauseReason
          };
        }
      }
      if (job.poolSlotId) {
        warmPool.stvTabs.set(job.sourceTabId, sites.siteUrl(String(sender?.tab?.url || ""))?.href || "");
        await ensureWarmPool(job.settings);
        const slot = warmPool.slots.find((candidate) => (
          candidate.slotId === job.poolSlotId
          && candidate.jobId === job.id
          && candidate.state === "leased"
          && candidate.providerTabId === job.providerTabId
          && candidate.warmSessionId === job.warmSessionId
          && candidate.settingsHash === job.settingsHash
        ));
        if (slot && await verifyPreparedSlot(slot)) {
          job.status = "running";
          job.pauseReason = "";
          await notifyStatus(job, "running");
          await dispatchCurrent(job);
          return { ok: true, resumed: true };
        }
        if (slot) await withPoolLock(() => removeOwnedSlot(slot, { errorReason: "resume_evidence_missing" }));
        job.providerTabId = null;
        job.poolSlotId = "";
        job.warmSessionId = "";
        job.settingsHash = "";
        resetProviderSession(job);
        if (await acquireWarmSlot(job)) return { ok: true, resumed: true };
      }
      if (!Number.isInteger(job.providerTabId)) {
        if (await acquireWarmSlot(job)) return { ok: true, resumed: true };
        try {
          resetProviderSession(job);
          await openProvider(job);
          return { ok: true, resumed: true };
        } catch (_error) {
          await pause(job, "provider_tab_failed");
          return { ok: false, reason: "provider-tab-failed" };
        }
      }
      job.status = "running";
      job.pauseReason = "";
      await notifyStatus(job, "running");
      await dispatchCurrent(job);
      return { ok: true, resumed: true };
    }

    async function providerResult(message, sender) {
      const warmSlot = warmPool.slots.find((slot) => (
        slot.warmJobId === String(message.jobId || "")
        && slot.providerTabId === sender?.tab?.id
      ));
      if (warmSlot) {
        const validation = core.validateSetupResponse(message.text, {
          jobId: warmSlot.warmJobId,
          setupId: warmSlot.setupId,
          part: SETUP_PARTS[0]
        });
        if (!validation.ok || !(await verifyPreparedSlot(warmSlot))) {
          await markWarmSlotFailed(warmSlot, validation.ok ? "warm_evidence_missing" : "invalid_setup_response");
          return { ok: false, reason: warmSlot.errorCode };
        }
        warmSlot.state = "ready";
        warmSlot.errorCode = "";
        warmPool.errorCode = "";
        await markWarmSlotRecovered(warmSlot);
        await persistPool();
        await notifyPoolStatus();
        await drainWarmWaiters();
        return { ok: true, ready: true };
      }
      const job = await ensureJob(String(message.jobId || ""));
      if (!job) return { ok: false, reason: "stale-job" };
      if (job.status === "cancelled") return { ok: false, reason: "cancelled-job" };
      if (sender?.tab?.id !== job.providerTabId) return { ok: false, reason: "wrong-provider-tab" };
      return processProviderResult(job, message, false);
    }

    async function providerStatus(message, sender) {
      await restoreJobs();
      const warmSlot = findPoolSlotByTab(sender?.tab?.id);
      if (warmSlot
        && warmSlot.state === "failed"
        && message.status === "ready"
        && REPLACEABLE_WARM_FAILURES.has(warmSlot.errorCode)) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(warmSlot) || warmSlot.state !== "failed") return;
          warmSlot.state = "opening";
          warmSlot.errorCode = "";
          warmSlot.failedAt = 0;
          warmSlot.retryNotBefore = 0;
          await persistPool();
        });
      }
      if (warmSlot && ["opening", "preparing"].includes(warmSlot.state)) {
        if (message.status && message.status !== "ready") {
          await markWarmSlotFailed(warmSlot, message.reason || message.status);
          return { ok: false, reason: warmSlot.errorCode };
        }
        await prepareWarmSlot(warmSlot, warmPool.settings || (await loadSettings({ provider: warmSlot.provider })));
        await notifyPoolStatus();
        await drainWarmWaiters();
        return { ok: warmSlot.state === "ready", ready: warmSlot.state === "ready" };
      }
      const job = Array.from(jobs.values()).find((candidate) => candidate.providerTabId === sender?.tab?.id);
      if (!job) return { ok: false, reason: "unknown-provider-tab" };
      if (job.status !== "waiting-provider") return { ok: true, ignored: true };
      if (message.status && message.status !== "ready") return pause(job, message.reason || message.status);
      job.status = "running";
      job.pauseReason = "";
      await notifyStatus(job, "running");
      await dispatchCurrent(job);
      return { ok: true, ready: true };
    }

    async function providerSetupProgress(message, sender) {
      const slot = findPoolSlotByTab(sender?.tab?.id);
      if (!slot || slot.provider !== "chatgpt") return { ok: false, reason: "unknown-provider-tab" };
      if (!slot.setupSessionId || String(message.setupSessionId || "") !== slot.setupSessionId) {
        return { ok: false, reason: "stale-setup-session" };
      }
      const checkpoint = Math.max(0, Math.min(3, Number(message.checkpoint) || 0));
      slot.setupCheckpoint = Math.max(Number(slot.setupCheckpoint) || 0, checkpoint);
      slot.setupState = ["running", "completed", "failed"].includes(message.state) ? message.state : "running";
      slot.setupStage = ["waiting_composer", "sending", "waiting_marker", "confirmed", "resuming", "completed", "failed"]
        .includes(message.stage) ? message.stage : "waiting_marker";
      slot.setupLastProgressAt = Math.max(0, Number(message.lastProgressAt) || now());
      slot.setupResumeCount = Math.max(0, Number(message.resumeCount) || 0);
      slot.setupErrorCode = typeof message.errorCode === "string" ? message.errorCode : "";
      slot.readyWatchdogStep = slot.setupCheckpoint >= 3 ? "ready_3" : `ready_${slot.setupCheckpoint + 1}`;
      slot.readyWatchdogState = slot.setupStage === "confirmed" || slot.setupStage === "completed"
        ? "confirmed"
        : slot.setupStage;
      await persistPool();
      if (slot.setupState === "completed" && slot.setupCheckpoint === 3) {
        await releaseChatGPTSetupPerformanceLease(slot);
        if (!(await verifyPreparedSlot(slot))) {
          await markWarmSlotFailed(slot, "warm_evidence_missing");
          return { ok: false, reason: slot.errorCode };
        }
        slot.state = "ready";
        slot.errorCode = "";
        warmPool.errorCode = "";
        await persistPool();
        await notifyPoolStatus();
        await drainWarmWaiters();
        return { ok: true, ready: true };
      }
      if (slot.setupState === "failed") {
        if ((slot.setupResumeAttempts || 0) < 1) {
          slot.setupResumeAttempts = (slot.setupResumeAttempts || 0) + 1;
          slot.state = "opening";
          slot.setupState = "resuming";
          await persistPool();
          await prepareWarmSlot(slot, warmPool.settings || (await loadSettings({ provider: "chatgpt" })));
          return { ok: true, resumed: true };
        }
        await releaseChatGPTSetupPerformanceLease(slot);
        await markWarmSlotFailed(slot, slot.setupErrorCode || "warm_setup_failed");
        return { ok: false, reason: slot.errorCode };
      }
      await notifyPoolStatus();
      return { ok: true, checkpoint: slot.setupCheckpoint };
    }

    const CLIENT_STORAGE_KEYS = Object.freeze([
      "settings", "toolEnabled", "transmissionConsent", "automationConsentVersion",
      "automationConsentProvider", "ttsConsent", "ttsConsentVersion",
      "stvaiNavigationExpanded", "stvaiToolbarCollapsed",
      "stvaiTtsOverlayPositionV1", "stvaiUiScale",
      "stvaiToolbarPositionV2", "stvaiNameEditorPositionV2", "stvaiNameManagerPositionV2"
    ]);

    function isStvSender(sender) {
      return (sender?.frameId == null || sender.frameId === 0)
        && isStvUrl(sender?.url || sender?.tab?.url);
    }

    function clientSafeSettings(value) {
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

    async function migratePersistedSettings(value) {
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

    function clientTtsOverlayPosition(value) {
      if (typeof value?.x !== "number" || typeof value?.y !== "number"
        || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
      return {
        x: Math.min(1, Math.max(0, value.x)),
        y: Math.min(1, Math.max(0, value.y))
      };
    }

    function clientUiScale(value) {
      const number = Number(value);
      return [0.5, 0.75, 1, 1.25, 1.5].includes(number) ? number : 1;
    }

    async function clientStorageGet(message, sender) {
      if (!isStvSender(sender)) return { ok: false, reason: "unauthorized-sender" };
      const requested = Array.isArray(message.keys) ? message.keys : [message.keys];
      const keys = requested.filter((key) => CLIENT_STORAGE_KEYS.includes(key));
      const stored = keys.length && storage?.local?.get
        ? await storageCall(storage.local, "get", keys)
        : {};
      const values = {};
      for (const key of keys) {
        if (key === "settings") {
          const storedSettings = await migratePersistedSettings(stored?.settings);
          values.settings = clientSafeSettings(storedSettings);
        }
        else if (["stvaiTtsOverlayPositionV1", "stvaiToolbarPositionV2", "stvaiNameEditorPositionV2", "stvaiNameManagerPositionV2"].includes(key)) {
          const position = clientTtsOverlayPosition(stored?.[key]);
          if (position) values[key] = position;
        }
        else if (key === "stvaiUiScale") values[key] = clientUiScale(stored?.[key]);
        else if (Object.hasOwn(stored || {}, key)) values[key] = stored[key];
      }
      return { ok: true, values };
    }

    async function clientStorageSet(message, sender) {
      if (!isStvSender(sender)) return { ok: false, reason: "unauthorized-sender" };
      if (!storage?.local?.set) return { ok: false, reason: "storage_unavailable" };
      const source = message?.values && typeof message.values === "object" ? message.values : {};
      const values = {};
      for (const key of CLIENT_STORAGE_KEYS) {
        if (!Object.hasOwn(source, key)) continue;
        if (key === "settings") values.settings = clientSafeSettings(source.settings);
        else if (["transmissionConsent", "ttsConsent", "stvaiNavigationExpanded", "stvaiToolbarCollapsed"].includes(key)
          && typeof source[key] === "boolean") values[key] = source[key];
        else if (key === "automationConsentVersion" && Number.isFinite(Number(source[key]))) values[key] = Math.max(0, Math.trunc(Number(source[key])));
        else if (key === "ttsConsentVersion" && source[key] === 2) values[key] = 2;
        else if (key === "automationConsentProvider" && core.PROVIDERS.includes(source[key])) values[key] = source[key];
        else if (["stvaiTtsOverlayPositionV1", "stvaiToolbarPositionV2", "stvaiNameEditorPositionV2", "stvaiNameManagerPositionV2"].includes(key)) {
          const position = clientTtsOverlayPosition(source[key]);
          if (position) values[key] = position;
        }
        else if (key === "stvaiUiScale" && [0.5, 0.75, 1, 1.25, 1.5].includes(Number(source[key]))) {
          values[key] = Number(source[key]);
        }
      }
      if (!Object.keys(values).length) return { ok: false, reason: "empty-patch" };
      await storageCall(storage.local, "set", values);
      return { ok: true };
    }

    const zoomQueues = new Map();
    const zoomNavigations = new Map();
    const ZOOM_STORAGE_KEYS = Object.freeze({
      general: "stvaiZoomGeneralPercent",
      story: "stvaiZoomStoryPercent"
    });

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

    async function changePageZoom(message, sender) {
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
        // Native page zoom, isolated from other STV tabs. No reload or AI message.
        await tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
        await tabs.setZoom(tabId, percent / 100);
        await storageCall(storage?.local, "set", { [context.storageKey]: percent }).catch(() => undefined);
        return { ok: true, percent };
      });
    }

    async function restorePageZoom(_message, sender) {
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
        if (navigation?.profile === zoomProfileForUrl(url)) {
          return { ok: false, reason: "zoom_navigation" };
        }
        if (!isStvUrl(url) || (tab.pendingUrl && tab.pendingUrl !== url)) {
          return { ok: false, reason: "stale-page" };
        }
        const enabled = await storageCall(storage?.local, "get", "toolEnabled");
        if (enabled?.toolEnabled !== true) return { ok: false, reason: "tool_disabled" };
        const profile = zoomProfileForUrl(url);
        const storageKey = ZOOM_STORAGE_KEYS[profile];
        if (!storageKey) return { ok: false, reason: "unsupported-page" };
        await storageCall(storage?.local, "set", { [storageKey]: percent });
        return { ok: true, percent, profile };
      });
    }

    async function handleMessage(message, sender = {}) {
      if (["STVAI_ONBOARDING_STATUS", "STVAI_ONBOARDING_OPEN_PROVIDER", "STVAI_ONBOARDING_FINISH"].includes(message?.type)) {
        return onboardingService?.handleMessage(message, sender)
          || { ok: false, reason: "onboarding-unavailable" };
      }
      switch (message && message.type) {
        case "STVAI_PROVIDER_BUSY_PROGRESS": {
          const job = await ensureJob(String(message.jobId || ""));
          const requestId = String(message.requestId || "");
          const state = String(message.state || "");
          if (!job || job.provider !== "gemini") return { ok: false, reason: "stale-job" };
          if (sender?.tab?.id !== job.providerTabId) return { ok: false, reason: "wrong-provider-tab" };
          if (!/^batch_\d+_\d{4}$/.test(requestId) || requestId !== job.activeRequestId) {
            return { ok: false, reason: "stale-request" };
          }
          if (!["waiting", "cleared", "timeout"].includes(state)) return { ok: false, reason: "invalid-state" };
          if (state === "waiting") {
            job.busyStartedAt ||= now();
            job.busyRetryCount = Math.max(0, Number(job.busyRetryCount) || 0) + 1;
            job.busyRequestId = requestId;
            job.unsentRequestId = requestId;
            const resumedAfterRestart = job.status === "paused" && job.pauseReason === "service_worker_restarted";
            if (resumedAfterRestart) {
              job.status = "running";
              job.pauseReason = "";
              job.pending = false;
              job.workState = "queued";
            }
            await persistJob(job);
            await notifyStatus(job, "running", "waiting_provider_busy");
            if (resumedAfterRestart) setTimeout(() => { void dispatchCurrent(job); }, 0);
          }
          return { ok: true };
        }
        case "STVAI_DOM_PROFILES_GET": {
          const provider = await ownedDirectProviderForSender(sender);
          if (!provider || (message.provider && message.provider !== provider)) return { ok: false, reason: "unauthorized-provider-tab" };
          const key = provider === "chatgpt" ? CHATGPT_DOM_PROFILES_STORAGE_KEY : DOM_PROFILES_STORAGE_KEY;
          const stored = await storageCall(storage.local, "get", key).catch(() => ({}));
          const value = sanitizeDomProfileStore(stored?.[key])
            || { schemaVersion: 1, profiles: [] };
          return { ok: true, value };
        }
        case "STVAI_DOM_PROFILES_SET": {
          const provider = await ownedDirectProviderForSender(sender);
          if (!provider || (message.provider && message.provider !== provider)) return { ok: false, reason: "unauthorized-provider-tab" };
          let serialized = "";
          try { serialized = JSON.stringify(message.value); } catch (_error) { /* rejected below */ }
          if (!serialized || serialized.length > 32_000) return { ok: false, reason: "invalid-dom-profiles" };
          const value = sanitizeDomProfileStore(message.value);
          if (!value) return { ok: false, reason: "invalid-dom-profiles" };
          const key = provider === "chatgpt" ? CHATGPT_DOM_PROFILES_STORAGE_KEY : DOM_PROFILES_STORAGE_KEY;
          await storageCall(storage.local, "set", { [key]: value });
          return { ok: true };
        }
        case "STVAI_GET_UPDATE_STATUS":
        case "STVAI_CHECK_UPDATE": {
          if (sender?.tab) return { ok: false, reason: "trusted-context-required" };
          if (!updateChecker?.check) return { ok: false, reason: "update-unavailable" };
          const state = await updateChecker.check({
            force: message.type === "STVAI_CHECK_UPDATE",
            currentVersion: extensionVersion
          });
          return {
            ok: true,
            available: state?.available === true && state?.signatureStatus === "valid",
            version: /^\d+\.\d+\.\d+$/.test(String(state?.version || "")) ? state.version : "",
            signatureStatus: state?.signatureStatus === "valid" ? "valid" : "invalid",
            errorCode: /^[a-z0-9_-]{1,40}$/i.test(String(state?.errorCode || "")) ? state.errorCode : "unknown"
          };
        }
        case "STVAI_OPEN_UPDATE": {
          if (sender?.tab) return { ok: false, reason: "trusted-context-required" };
          if (!updateChecker?.check || typeof tabs?.create !== "function") {
            return { ok: false, reason: "update-unavailable" };
          }
          const state = await updateChecker.check({ force: false, currentVersion: extensionVersion });
          if (state?.available !== true || state?.signatureStatus !== "valid"
            || !defaultUpdateApi?.validReleaseUrl?.(state.releaseUrl)) {
            return { ok: false, reason: "update-unavailable" };
          }
          await tabs.create({ url: state.releaseUrl, active: true });
          return { ok: true };
        }
        case "STVAI_PAGE_ZOOM":
          return changePageZoom(message, sender);
        case "STVAI_PAGE_ZOOM_RESTORE":
          return restorePageZoom(message, sender);
        case 'STVAI_HISTORY_SYNC':
          return historySync.handle(message, sender);
        case 'STVAI_PORTABLE_SYNC':
          return portableSync.handle(message, sender);
        case 'STVAI_PORTABLE_STATUS':
        case 'STVAI_PORTABLE_LEARN_START':
        case 'STVAI_PORTABLE_LEARN_FINISH':
        case 'STVAI_PORTABLE_APPROVE':
        case 'STVAI_PORTABLE_DISABLE': {
          const senderUrl = String(sender?.url || '');
          if (!senderUrl.startsWith('chrome-extension://') || !senderUrl.includes('/options/options.html')) {
            return { ok: false, reason: 'unauthorized-sender' };
          }
          if (message.type === 'STVAI_PORTABLE_STATUS') return portableSync.status();
          if (message.type === 'STVAI_PORTABLE_LEARN_START') return portableSync.startLearning();
          if (message.type === 'STVAI_PORTABLE_LEARN_FINISH') return portableSync.finishLearning(String(message.sessionId || ''));
          if (message.type === 'STVAI_PORTABLE_APPROVE') return portableSync.approveLearning(message);
          return portableSync.disable(String(message.itemId || ''));
        }
        case "STVAI_TTS_SESSION_START":
        case "STVAI_TTS_SESSION_CLAIM_NEXT":
        case "STVAI_TTS_SESSION_UPDATE":
        case "STVAI_TTS_SESSION_CLEAR":
          return handleTtsSession(message, sender);
        case "STVAI_TEST_API": {
          const senderUrl = String(sender?.url || "");
          if (!senderUrl.startsWith("chrome-extension://") || !senderUrl.includes("/options/options.html")) return { ok: false, reason: "unauthorized-sender" };
          if (!core.isApiProvider(message.provider) || !apiClient?.testConnection) return { ok: false, reason: "unsupported-provider" };
          try {
            const result = await apiClient.testConnection({
              provider: message.provider,
              apiKey: String(message.apiKey || await loadApiKey(message.provider)),
              model: String(message.model || ""),
              safetyOff: message.provider === "gemini_api" && message.safetyOff === true
            });
            return { ok: true, model: String(result.model || ""), latencyMs: Number(result.latencyMs) || 0 };
          } catch (error) {
            return { ok: false, reason: typeof error?.code === "string" ? error.code : "provider_error" };
          }
        }
        case "STVAI_STORAGE_GET":
          return clientStorageGet(message, sender);
        case "STVAI_STORAGE_SET":
          return clientStorageSet(message, sender);
        case "STVAI_JAPANESE_NAME_LOOKUP": {
          if (!isStvSender(sender)) return { ok: false, reason: "lookup-source-denied" };
          if (!previewApi?.buildJapaneseNamePrompt || !previewApi?.sanitizeJapaneseNameResponse) {
            return { ok: false, reason: "lookup-unavailable" };
          }
          const requestId = String(message.requestId || "");
          if (!requestId || requestId.length > 100) return { ok: false, reason: "invalid-lookup-request" };
          let consent = false;
          try {
            const stored = await storageCall(storage?.local, "get", "transmissionConsent");
            consent = stored?.transmissionConsent === true;
          } catch (_error) {
            consent = false;
          }
          if (!consent) return { ok: false, requestId, reason: "lookup-consent-required" };
          const automation = await readAutomationConfig();
          if (!automation.consented) {
            return { ok: false, requestId, reason: "lookup-automation-consent-required" };
          }
          const tabId = sender.tab.id;
          await cancelJapaneseLookup(activeJapaneseLookups.get(tabId));
          const controller = new AbortController();
          const entry = {
            controller,
            requestId,
            lookupJobId: createId("name-lookup"),
            providerTabId: null,
            slotId: ""
          };
          activeJapaneseLookups.set(tabId, entry);
          let reusable = false;
          try {
            const source = previewApi.validateSource(message.source);
            const prompt = previewApi.buildJapaneseNamePrompt(source);
            const slot = await acquireJapaneseLookupSlot(entry.lookupJobId);
            if (!slot) return {
              ok: false,
              requestId,
              reason: "lookup-provider-busy",
              targetCount: warmPool.targetCount
            };
            entry.providerTabId = slot.providerTabId;
            entry.slotId = slot.slotId;
            if (controller.signal.aborted || activeJapaneseLookups.get(tabId) !== entry) {
              return { ok: false, requestId, reason: "lookup-cancelled" };
            }
            const response = await sendProviderMessage(slot.provider, slot.providerTabId, {
              type: "STVAI_PROVIDER_SEND",
              phase: "name_lookup",
              jobId: entry.lookupJobId,
              requestId,
              prompt,
              timeoutMs: 60_000,
              temporaryChat: false,
              requiredWarmSessionId: slot.warmSessionId,
              requiredSettingsHash: slot.settingsHash
            });
            if (controller.signal.aborted || activeJapaneseLookups.get(tabId) !== entry) {
              return { ok: false, requestId, reason: "lookup-cancelled" };
            }
            if (response?.ok !== true) return { ok: false, requestId, reason: "lookup-unavailable" };
            reusable = true;
            const candidate = previewApi.sanitizeJapaneseNameResponse(
              response.response,
              String(message.disallowedCandidate || message.englishFallback || "").slice(0, 200)
            );
            const lookup = { source, candidates: candidate ? [candidate] : [], provider: "ai" };
            return { ok: true, requestId, lookup };
          } catch (error) {
            return {
              ok: false,
              requestId,
              reason: error?.name === "AbortError" ? "lookup-cancelled" : "lookup-unavailable"
            };
          } finally {
            await releaseJapaneseLookupSlot(entry, reusable && !controller.signal.aborted);
            if (activeJapaneseLookups.get(tabId) === entry) activeJapaneseLookups.delete(tabId);
          }
        }
        case "STVAI_NAME_PREVIEW": {
          if (!isStvSender(sender)) return { ok: false, reason: "preview-source-denied" };
          if (!namePreview?.preview) return { ok: false, reason: "preview-unavailable" };
          const requestId = String(message.requestId || "");
          if (!requestId || requestId.length > 100) return { ok: false, reason: "invalid-preview-request" };
          let consent = false;
          try {
            const stored = await storageCall(storage?.local, "get", "transmissionConsent");
            consent = stored?.transmissionConsent === true;
          } catch (_error) {
            consent = false;
          }
          if (!consent) return { ok: false, requestId, reason: "preview-consent-required" };
          const tabId = sender.tab.id;
          activeNamePreviews.get(tabId)?.abort();
          const controller = new AbortController();
          activeNamePreviews.set(tabId, controller);
          try {
            const preview = await namePreview.preview(message.source, { signal: controller.signal });
            if (activeNamePreviews.get(tabId) !== controller) {
              return { ok: false, requestId, reason: "preview-cancelled" };
            }
            return { ok: true, requestId, preview };
          } catch (error) {
            return {
              ok: false,
              requestId,
              reason: error?.name === "AbortError" ? "preview-cancelled" : "preview-unavailable"
            };
          } finally {
            if (activeNamePreviews.get(tabId) === controller) activeNamePreviews.delete(tabId);
          }
        }
        case "STVAI_AUTOMATION_CONSENT_CHANGED": {
          if (!isStvUrl(sender?.tab?.url) || Number(message.consentVersion) < AUTOMATION_CONSENT_VERSION) {
            return { ok: false, reason: "automation-consent-denied" };
          }
          registerStvTab(sender.tab.id, sender.tab.url);
          const enabled = await ensureWarmPool();
          return { ok: true, enabled, pool: allowlistedPoolStatus() };
        }
        case "STVAI_GET_POOL_STATUS":
          return { ok: true, pool: allowlistedPoolStatus() };
        case "STVAI_GET_SUPPORT_DIAGNOSTICS":
          return getSupportDiagnostics(message, sender);
        case "STVAI_DIAGNOSTIC_EVENT": {
          const incomingKinds = new Set([
            "provider_fault", "ready_watchdog", "chapter_failed", "prefetch_failed", "tts_handoff_failed"
          ]);
          const incomingPhases = new Set(["setup", "batch", "prefetch", "chapter", "tts", "pool"]);
          const provider = isStvSender(sender)
            ? (core.PROVIDERS.includes(message.provider) ? message.provider : "unknown")
            : await ownedDirectProviderForSender(sender);
          if (!provider) return { ok: false, reason: "unauthorized-sender" };
          if (!incomingKinds.has(message.kind) || !incomingPhases.has(message.phase)) {
            return { ok: false, reason: "invalid-diagnostic-event" };
          }
          await errorJournal?.append?.(`client:${sender.tab.id}:${message.phase}:${now()}`, {
            kind: message.kind,
            provider,
            phase: message.phase,
            errorCode: message.errorCode,
            validationReason: message.validationReason,
            expectedCount: message.expectedCount,
            actualCount: message.actualCount,
            batchIndex: message.batchIndex,
            batchAttempt: message.batchAttempt,
            outcome: message.outcome === "still_running" ? "still_running" : "failed"
          });
          return { ok: true };
        }
        case "STVAI_GET_ERROR_REPORT": {
          const senderUrl = String(sender?.url || "");
          if (sender?.tab || !senderUrl.startsWith("chrome-extension://") || !senderUrl.includes("/popup/popup.html")) {
            return { ok: false, reason: "trusted-context-required" };
          }
          return {
            ok: true,
            report: {
              schemaVersion: 1,
              generatedAt: now(),
              incident: await errorJournal?.latest?.() || null
            }
          };
        }
        case "STVAI_CLEAR_ERROR_LOG": {
          const senderUrl = String(sender?.url || "");
          if (sender?.tab || !senderUrl.startsWith("chrome-extension://") || !senderUrl.includes("/popup/popup.html")) {
            return { ok: false, reason: "trusted-context-required" };
          }
          const cleared = await errorJournal?.clear?.();
          return cleared === true
            ? { ok: true }
            : { ok: false, reason: "error-log-clear-failed" };
        }
        case "STVAI_GET_TOOL_ENABLED": {
          if (sender?.tab) return { ok: false, reason: "trusted-context-required" };
          const stored = storage?.local?.get
            ? await storageCall(storage.local, "get", "toolEnabled").catch(() => ({}))
            : {};
          return { ok: true, enabled: stored?.toolEnabled === true };
        }
        case "STVAI_SET_TOOL_ENABLED": {
          if (sender?.tab) return { ok: false, reason: "trusted-context-required" };
          const enabled = message.enabled === true;
          if (!enabled) for (const admission of pendingPrefetch.values()) admission.cancelled = true;
          if (storage?.local?.set) await storageCall(storage.local, "set", { toolEnabled: enabled });
          if (!enabled) {
            await clearTtsSession();
            await restorePoolMetadata();
            for (const job of jobs.values()) {
              if (["cancelled", "completed"].includes(job.status)) continue;
              job.status = "cancelled";
              job.pending = false;
              job.apiAbortController?.abort();
              job.apiAbortController = null;
              await sendToTab(job.providerTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id });
              await notifyStatus(job, "cancelled");
              retainTerminalJob(job);
            }
            warmPool.suspendedStvTabs.clear();
            await cleanupWarmPool();
          } else {
            void ensureWarmPool().catch(() => undefined);
          }
          return { ok: true, enabled };
        }
        case "STV_START_JOB":
        case "STVAI_START_JOB":
          return startJob(message, sender);
        case "STVAI_CLEAR_CHAPTER_CACHE": {
          if (!isStvSender(sender) || typeof message.chapterId !== "string"
            || typeof message.sourceHash !== "string" || !message.sourceHash) {
            return { ok: false, reason: "unauthorized-sender" };
          }
          const senderChapter = resolveStvSenderChapter(sender, message.chapterId);
          if (!senderChapter || senderChapter.chapterId !== message.chapterId) {
            return { ok: false, reason: "chapter_mismatch" };
          }
          const matches = (identity) => identity?.chapterKey
            ? identity.chapterKey === senderChapter.chapterKey && identity.sourceHash === message.sourceHash
            : identity?.chapterId === message.chapterId && identity.sourceHash === message.sourceHash;
          for (const job of jobs.values()) {
            if (!matches(job.cacheIdentity)) continue;
            job.cacheable = false;
            await persistJob(job);
          }
          for (const record of await cache.listChapters()) {
            if (matches(record)) await cache.deleteChapter(record);
          }
          return { ok: true };
        }
        case "STVAI_CLEAR_ALL_CACHE": {
          if (!isStvSender(sender)) return { ok: false, reason: "unauthorized-sender" };
          for (const job of jobs.values()) {
            job.cacheable = false;
            await persistJob(job);
          }
          await cache.clearAll();
          return { ok: true };
        }
        case "STV_CANCEL_JOB":
        case "STVAI_CANCEL_JOB":
          return cancelJob(message, sender);
        case "STV_RESUME_JOB":
        case "STVAI_RESUME_JOB":
          return resumeJob(message, sender);
        case "STVAI_PROVIDER_RESULT":
        case "STV_PROVIDER_RESULT":
          return providerResult(message, sender);
        case "STVAI_PROVIDER_PAUSED": {
          const job = await ensureJob(String(message.jobId || ""));
          if (!job) return { ok: false, reason: "stale-job" };
          if (sender?.tab?.id !== job.providerTabId) return { ok: false, reason: "wrong-provider-tab" };
          return pause(job, message.reason);
        }
        case "STVAI_PROVIDER_READY":
        case "STVAI_PROVIDER_STATUS":
          return providerStatus(message, sender);
        case "STVAI_PROVIDER_SETUP_PROGRESS":
          return providerSetupProgress(message, sender);
        case "STVAI_OPEN_OPTIONS": {
          if (typeof runtime?.openOptionsPage === "function") {
            await runtime.openOptionsPage();
            return { ok: true };
          }
          if (typeof runtime?.getURL === "function" && typeof tabs?.create === "function") {
            await tabs.create({
              url: runtime.getURL("options/options.html"),
              active: true
            });
            return { ok: true };
          }
          return { ok: false, reason: "options-unavailable" };
        }
        default:
          return undefined;
      }
    }

    async function handleTabUpdated(tabId, changeInfo, tab = {}) {
      const navigationUrl = String(changeInfo?.url || tab?.url || "");
      const stvUrlChanged = typeof changeInfo?.url === "string" && isStvUrl(navigationUrl);
      if ((changeInfo?.status === "loading" || stvUrlChanged) && isStvUrl(navigationUrl)) {
        zoomNavigations.set(tabId, {
          profile: zoomProfileForUrl(navigationUrl)
        });
      }
      await trackTtsNavigation(tabId, changeInfo?.url || tab?.url);
      if (changeInfo?.status === "loading") {
        providerDebuggerBlockedTabs.delete(tabId);
        const loadingSlot = findPoolSlotByTab(tabId);
        if (loadingSlot && !loadingSlot.documentLoading && !["failed", "retiring"].includes(loadingSlot.state)) {
          loadingSlot.documentGeneration = (loadingSlot.documentGeneration || 0) + 1;
          loadingSlot.documentLoading = true;
          if (loadingSlot.state !== "leased") {
            loadingSlot.state = "opening";
            loadingSlot.setupStageStartedAt = 0;
            loadingSlot.preparationRequested = false;
            loadingSlot.warmJobId = createId("warm-job");
            loadingSlot.setupId = createId("setup");
            loadingSlot.warmSessionId = createId("warm");
          }
          await persistPool();
        }
        return;
      }
      if (!changeInfo || changeInfo.status !== "complete") {
        if (stvUrlChanged && typeof tabs?.getZoom === "function") {
          await restoreZoomForTab(tabId, navigationUrl);
        }
        return;
      }
      const url = tab?.url || changeInfo.url || "";
      if (isStvUrl(url)) {
        const previousUrl = warmPool.stvTabs.get(tabId);
        registerStvTab(tabId, url);
        if (previousUrl && previousUrl !== url) {
          // Map iterators include entries added during await. Snapshot the old
          // jobs so cleanup cannot consume a READY tab leased by the new page.
          for (const job of Array.from(jobs.values())) {
            if (job.sourceTabId !== tabId || ["completed", "cancelled"].includes(job.status)) continue;
            job.status = "cancelled";
            job.pending = false;
            job.apiAbortController?.abort();
            await sendToTab(job.providerTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id });
            await persistJob(job);
            if (job.poolSlotId) {
              await withPoolLock(async () => {
                const used = warmPool.slots.find((candidate) => candidate.slotId === job.poolSlotId);
                if (used) await removeOwnedSlot(used, { removalReason: "stv_navigation" });
                job.poolSlotId = "";
              });
            } else await closeLegacyProviderTab(job);
            retainTerminalJob(job);
          }
        }
        await ensureWarmPool();
        if (typeof tabs?.getZoom === "function") await restoreZoomForTab(tabId, url);
        return;
      }
      if (url && warmPool.stvTabs.has(tabId)) {
        await handleTabRemoved(tabId);
        return;
      }
      const slot = findPoolSlotByTab(tabId);
      if (slot) {
        if (slot.state === "retiring") return;
        slot.documentLoading = false;
        if (url) slot.lastKnownUrl = url;
        if (url && !providerMatchesUrl(slot.provider, url)) {
          const failureCode = slot.provider === "gemini" && isGeminiVerificationUrl(url)
            ? "captcha"
            : "provider_origin_mismatch";
          const leasedJob = slot.jobId ? jobs.get(slot.jobId) : null;
          if (leasedJob && !["cancelled", "completed"].includes(leasedJob.status)) {
            await pause(leasedJob, failureCode);
          }
          slot.state = "failed";
          slot.errorCode = failureCode;
          exposeSlotFailureToPool(slot);
          await persistPool();
          await notifyPoolStatus();
          return;
        }
        if (slot.state === "ready") {
          if (await verifyPreparedSlot(slot)) return;
          slot.documentLoadedAt = now();
          slot.state = "opening";
          slot.errorCode = "";
          slot.setupStageStartedAt = 0;
          slot.preparationRequested = false;
          await persistPool();
          await prepareWarmSlot(slot, warmPool.settings || (await loadSettings({ provider: slot.provider })));
          await notifyPoolStatus();
          await drainWarmWaiters();
          return;
        }
        if (slot.state === "failed") {
          if (isAuthenticationBlocker(slot.errorCode)) return;
          if ((slot.recoveryAttempts || 0) >= 1) return;
          if (retryDelayMs > 0 && Date.now() - Number(slot.failedAt || 0) < retryDelayMs) return;
          slot.recoveryAttempts = (slot.recoveryAttempts || 0) + 1;
          slot.state = "opening";
          slot.errorCode = "";
          await prepareWarmSlot(slot, warmPool.settings || (await loadSettings({ provider: slot.provider })));
          await notifyPoolStatus();
          await drainWarmWaiters();
          return;
        }
        if (["opening", "preparing", "restoring"].includes(slot.state)) {
          slot.documentLoadedAt = now();
          await prepareWarmSlot(slot, warmPool.settings || (await loadSettings({ provider: slot.provider })));
          await notifyPoolStatus();
          await drainWarmWaiters();
          return;
        }
        if (slot.state === "leased" && !(await verifyPreparedSlot(slot))) {
          const leasedJob = jobs.get(slot.jobId);
          if (leasedJob) await pause(leasedJob, "warm_session_lost");
          slot.state = "failed";
          slot.errorCode = "warm_session_lost";
          exposeSlotFailureToPool(slot);
          await persistPool();
          await notifyPoolStatus();
          return;
        }
      }
      await restoreJobs();
      const job = Array.from(jobs.values()).find((candidate) => candidate.providerTabId === tabId);
      if (job) await probeProvider(job, { pauseIfUnavailable: true });
    }

    async function handleTabRemoved(tabId) {
      await historySync.forgetTab(tabId);
      cancelPendingPrefetch(tabId);
      await clearPrefetchParent(tabId);
      await clearTtsSession(tabId);
      providerPerformanceLeases.delete(tabId);
      providerDebuggerBlockedTabs.delete(tabId);
      await restoreJobs();
      const wasStvTab = warmPool.stvTabs.delete(tabId);
      warmPool.suspendedStvTabs.delete(tabId);
      if (wasStvTab) await persistPool();
      const lastStvTabClosed = wasStvTab && warmPool.stvTabs.size === 0;
      for (const sourceJob of jobs.values()) {
        if (
          sourceJob.sourceTabId === tabId
          && !["cancelled", "completed"].includes(sourceJob.status)
        ) {
          sourceJob.status = "cancelled";
          sourceJob.pending = false;
          sourceJob.apiAbortController?.abort();
          sourceJob.apiAbortController = null;
          await sendToTab(sourceJob.providerTabId, {
            type: "STVAI_PROVIDER_CANCEL",
            jobId: sourceJob.id
          });
          await removePersistedJob(sourceJob.id);
          if (sourceJob.poolSlotId) {
            await spendJobSlot(sourceJob, lastStvTabClosed
              ? { preserveWithoutStv: true, deferDrain: true }
              : undefined);
          } else {
            await closeLegacyProviderTab(sourceJob);
          }
          retainTerminalJob(sourceJob);
        }
      }
      if (lastStvTabClosed) {
        await scheduleLastStvCleanup();
        return;
      }
      const poolSlot = findPoolSlotByTab(tabId);
      if (poolSlot) {
        // The retirement owner removes metadata and schedules the replacement.
        if (poolSlot.state === "retiring") return;
        const leasedJob = poolSlot.jobId ? jobs.get(poolSlot.jobId) : null;
        const index = warmPool.slots.indexOf(poolSlot);
        if (index >= 0) warmPool.slots.splice(index, 1);
        if (leasedJob && !["cancelled", "completed"].includes(leasedJob.status)) {
          leasedJob.providerTabId = null;
          leasedJob.poolSlotId = "";
          await pause(leasedJob, "provider_tab_closed");
        }
        await persistPool();
        await notifyPoolStatus();
        if (warmPool.stvTabs.size && warmPool.unexpectedReplacementCount < 1) {
          warmPool.unexpectedReplacementCount += 1;
          await retrySleep(retryDelayMs);
          await ensureWarmPool();
        }
        return;
      }
      const diagnosticTab = warmPool.diagnosticTabs.find((entry) => entry.providerTabId === tabId);
      if (diagnosticTab) {
        warmPool.diagnosticTabs.splice(warmPool.diagnosticTabs.indexOf(diagnosticTab), 1);
        await persistPool();
        await notifyPoolStatus();
        return;
      }
      const job = Array.from(jobs.values()).find((candidate) => candidate.providerTabId === tabId);
      if (job && !["cancelled", "completed"].includes(job.status)) {
        job.providerTabId = null;
        await pause(job, "provider_tab_closed");
      }
    }

    async function handleStorageChanged(changes, areaName) {
      if (areaName !== "local" || !changes) return;
      if (Object.hasOwn(changes, "stvaiUiScale")) {
        const value = clientUiScale(changes.stvaiUiScale?.newValue);
        try {
          const openTabs = typeof tabs?.query === "function" ? await tabs.query({}) : [];
          await Promise.all((openTabs || []).filter(tab => isStvUrl(tab?.url)).map(tab =>
            Promise.resolve(tabs.sendMessage(tab.id, { type: "STVAI_UI_SCALE_CHANGED", value })).catch(() => undefined)));
        } catch (_error) { /* live UI sync is best effort */ }
      }
      if (!Object.hasOwn(changes, "settings")
        && !Object.hasOwn(changes, "automationConsentVersion")
        && !Object.hasOwn(changes, "toolEnabled")
        && !Object.hasOwn(changes, DEVELOPER_KEEP_TABS_KEY)) return;
      await restorePoolMetadata();
      if (changes[DEVELOPER_KEEP_TABS_KEY]?.newValue !== true) {
        await withPoolLock(async () => {
          for (const entry of [...warmPool.diagnosticTabs]) await removeDiagnosticTab(entry);
          await persistPool();
        });
      }
      if (warmPool.stvTabs.size === 0) return;
      const config = await readAutomationConfig();
      const oldPoolTarget = normalizedPoolTarget(core.normalizeSettings(changes.settings?.oldValue || {}));
      const newPoolTarget = normalizedPoolTarget(config.settings);
      const poolCountChanged = Boolean(changes.settings && oldPoolTarget !== newPoolTarget);
      const settingsChanged = changes.settings && core.stableSettingsPayload(changes.settings.oldValue || {})
        !== core.stableSettingsPayload(changes.settings.newValue || {});
      const nameOnlySettingsChange = Boolean(settingsChanged
        && changes.settings?.oldValue && changes.settings?.newValue
        && core.stableSettingsPayload({ ...changes.settings.oldValue, nameGuide: "" })
          === core.stableSettingsPayload({ ...changes.settings.newValue, nameGuide: "" }));
      if (settingsChanged || changes.toolEnabled?.newValue === false || !config.consented) {
        for (const admission of pendingPrefetch.values()) admission.cancelled = true;
      }
      for (const job of Array.from(jobs.values())) {
        if (!job.prefetch || ['completed', 'cancelled'].includes(job.status)) continue;
        if (!config.consented || changes.toolEnabled?.newValue === false
          || core.stableSettingsPayload(config.settings) !== core.stableSettingsPayload(job.settings)) {
          await cancelJob({ jobId: job.id, reason: 'prefetch_superseded' }, { tab: { id: job.sourceTabId } });
        }
      }
      if (poolCountChanged && config.consented && config.enabled) {
        await reconfigureWarmPool(config);
        return;
      }
      if (nameOnlySettingsChange && config.consented && config.enabled && warmPool.slots.length) {
        await notifyPoolStatus();
        return;
      }
      if (config.consented && config.enabled) {
        await ensureWarmPool(config.settings);
        return;
      }
      await withPoolLock(async () => {
        for (const slot of warmPool.slots.filter((candidate) => candidate.state !== "leased")) {
          await removeOwnedSlot(slot, { removalReason: "automation_disabled" });
        }
        warmPool.waiters.length = 0;
        warmPool.errorCode = "";
        await persistPool();
      });
      await notifyPoolStatus();
    }

    return Object.freeze({
      handleMessage,
      handleTabUpdated,
      handleTabRemoved,
      handleZoomChanged,
      handleDebuggerDetached,
      handleStorageChanged,
      handleInstalled(details) {
        return onboardingService?.handleInstalled(details) || Promise.resolve({ ok: false, reason: "onboarding-unavailable" });
      },
      probeProvider,
      restoreJobs,
      ensureWarmPool,
      getPoolSnapshot: publicPoolSnapshot,
      getJob(id) {
        return jobs.get(String(id)) || null;
      }
    });
  }

  function registerServiceWorker(chromeApi, rootObject = globalThis) {
    if (!chromeApi?.runtime?.onMessage?.addListener || !rootObject.indexedDB) return null;
    if (typeof chromeApi.storage?.local?.setAccessLevel === "function") {
      try {
        const result = chromeApi.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        result?.catch?.(() => undefined);
      } catch (_error) {
        // Chrome 102+ supports this; older Chromium remains outside the secure API-key baseline.
      }
    }
    const repository = cacheApi.createCacheRepository({ indexedDB: rootObject.indexedDB });
    const updateChecker = defaultDistribution?.usesExternalUpdater?.() === false
      ? null
      : defaultUpdateApi?.createUpdateChecker?.({ storage: chromeApi.storage?.local });
    const extensionVersion = chromeApi.runtime?.getManifest?.().version || "0.0.0";
    const controller = createBackgroundController({
      core: defaultCore,
      cache: repository,
      tabs: chromeApi.tabs,
      windows: chromeApi.windows,
      debuggerApi: chromeApi.debugger,
      storage: chromeApi.storage,
      runtime: chromeApi.runtime,
      apiClient: defaultApiProviders?.createApiClient?.(),
      updateChecker,
      extensionVersion
    });
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      Promise.resolve(controller.handleMessage(message, sender)).then(
        (result) => sendResponse(result),
        () => sendResponse({ ok: false, reason: "background-error" })
      );
      return true;
    });
    chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
      void controller.handleTabUpdated(tabId, changeInfo, tab);
    });
    chromeApi.tabs?.onRemoved?.addListener((tabId) => {
      void controller.handleTabRemoved(tabId);
    });
    chromeApi.tabs?.onZoomChange?.addListener((changeInfo) => {
      void controller.handleZoomChanged(changeInfo);
    });
    chromeApi.debugger?.onDetach?.addListener((source, reason) => {
      void controller.handleDebuggerDetached(source, reason);
    });
    chromeApi.storage?.onChanged?.addListener((changes, areaName) => {
      void controller.handleStorageChanged(changes, areaName);
    });
    chromeApi.runtime?.onInstalled?.addListener((details) => {
      void controller.handleInstalled(details).catch(() => undefined);
    });
    void controller.restoreJobs();
    void updateChecker?.check?.({ currentVersion: extensionVersion }).catch(() => undefined);
    return controller;
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.tabs && typeof indexedDB !== "undefined") {
    registerServiceWorker(chrome, globalThis);
  }

  return Object.freeze({ createBackgroundController, registerServiceWorker });
});
