(function attachBackground(root, factory) {
  const contracts = root.STVAIBackgroundContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const ttsSessionApi = root.STVAITtsSessionService || (typeof require === "function" ? require("./tts-session-service.js") : null);
  const clientServiceApi = root.STVAIBackgroundClientService || (typeof require === "function" ? require("./client-service.js") : null);
  const translationJobApi = root.STVAITranslationJobService || (typeof require === "function" ? require("./translation-job-service.js") : null);
  const providerPoolApi = root.STVAIProviderPoolService || (typeof require === "function" ? require("./provider-pool-service.js") : null);
  const messageRouterApi = root.STVAIBackgroundMessageRouter || (typeof require === "function" ? require("./message-router.js") : null);
  const core = root.STVAICore || (typeof require === "function" ? require("../shared/core.js") : null);
  const pronunciation = root.STVAITTSPronunciation || (typeof require === "function" ? require("../shared/tts-pronunciation.js") : null);
  const cacheApi = root.STVAICache || (typeof require === "function" ? require("../shared/cache.js") : null);
  const previewApi = root.STVAINamePreview || (typeof require === "function" ? require("../shared/name-preview.js") : null);
  const apiProviders = root.STVAIApiProviders || (typeof require === "function" ? require("../shared/api-providers.js") : null);
  const sites = root.STVAISites || (typeof require === 'function' ? require('../shared/stv-sites.js') : null);
  const historyApi = root.STVAIAccountHistorySync || (typeof require === 'function' ? require('../shared/account-history-sync.js') : null);
  const portableSyncApi = root.STVAIPortableSync || (typeof require === 'function' ? require('../shared/portable-sync.js') : null);
  const updateApi = root.STVAIUpdateCheck || (typeof require === "function" ? require("../shared/update-check.js") : null);
  const distributionApi = root.STVAIDistribution || (typeof require === "function" ? require("../shared/distribution-channel.js") : null);
  const onboardingApi = root.STVAIOnboarding || (typeof require === "function" ? require("../shared/onboarding.js") : null);
  const errorJournalApi = root.STVAIErrorJournal || (typeof require === "function" ? require("../shared/error-journal.js") : null);
  const api = factory(contracts, ttsSessionApi, clientServiceApi, translationJobApi, providerPoolApi, messageRouterApi, core, pronunciation, cacheApi, previewApi, apiProviders, sites, historyApi, portableSyncApi, updateApi, onboardingApi, errorJournalApi, distributionApi);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAIBackgroundController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundApi(contracts, ttsSessionApi, clientServiceApi, translationJobApi, providerPoolApi, messageRouterApi, defaultCore, pronunciation, cacheApi, previewApi, defaultApiProviders, sites, historyApi, portableSyncApi, defaultUpdateApi, defaultOnboardingApi, defaultErrorJournalApi, defaultDistribution) {
  "use strict";

  const {
    SETUP_PARTS, PROVIDER_URLS, JOB_STORAGE_PREFIX, POOL_STORAGE_KEY,
    OWNED_TABS_STORAGE_KEY, DOM_PROFILES_STORAGE_KEY, CHATGPT_DOM_PROFILES_STORAGE_KEY,
    DEVELOPER_KEEP_TABS_KEY, AUTOMATION_CONSENT_VERSION,
    MIN_POOL_TABS, MAX_POOL_TABS, READY_TIMEOUT_MS, CHATGPT_READY_TIMEOUT_MS,
    READY_SEND_TIMEOUT_MS, CHATGPT_READY_SEND_TIMEOUT_MS, CHATGPT_SETUP_INACTIVITY_MS,
    CHATGPT_SETUP_HARD_TIMEOUT_MS, READY_MARKER_GRACE_MS, MAX_WARM_REPLACEMENTS,
    PERFORMANCE_HEARTBEAT_MS, JOB_RECORD_VERSION, POOL_RECORD_VERSION,
    OWNED_TABS_RECORD_VERSION, DOM_PROFILE_RECORD_VERSION, AUTHENTICATION_BLOCKERS,
    REPLACEABLE_WARM_FAILURES, sanitizeDomProfileStore, isAuthenticationBlocker,
    batchIdAt, exactItems
  } = contracts;

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
    let acquireRecoverySlotPort = async () => false;
    let poolSerial = Promise.resolve();
    const providerForegroundSerials = new Map();
    const providerPerformanceLeases = new Map();
    const providerDebuggerBlockedTabs = new Set();
    let stvPresenceGeneration = 0;

    function withPoolLock(operation) {
      const next = poolSerial.then(operation, operation);
      poolSerial = next.catch(() => undefined);
      return next;
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
      return ["general", "prefetch"];
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

    const ttsSession = ttsSessionApi.createTtsSessionService({
      sites,
      storage,
      tabs,
      storageCall,
      resolveStvSenderChapter,
      createId
    });
    const clientService = clientServiceApi.createClientService({
      core,
      pronunciation,
      sites,
      storage,
      tabs,
      storageCall,
      isStvUrl
    });
    const isStvSender = clientService.isStvSender;
    const migratePersistedSettings = clientService.migrateSettings;

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
        version: OWNED_TABS_RECORD_VERSION,
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
        version: POOL_RECORD_VERSION,
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
            [OWNED_TABS_STORAGE_KEY]: { version: OWNED_TABS_RECORD_VERSION, tabs: [] }
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
        version: JOB_RECORD_VERSION,
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
      const relevantNameGuide = core.selectRelevantNameGuide
        ? core.selectRelevantNameGuide(settings.nameGuide, blocks)
        : (core.normalizeNameGuide ? core.normalizeNameGuide(settings.nameGuide) : settings.nameGuide || "");
      return {
        provider: settings.provider,
        webAiTabCount: settings.webAiTabCount,
        chapterId: chapter.chapterId,
        chapterKey: chapter.chapterKey,
        batchHash: await core.sha256Hex(JSON.stringify(allBatches.map(batch => batch.map(({ id, text }) => [id, text])))),
        sourceHash: await core.sha256Hex(blocks.map(block => block.text).join('\n\n')),
        promptHash: await core.sha256Hex(promptPayload),
        // Only Name mappings that can reach this chapter affect its translation.
        // Adding an unrelated Name must not invalidate already translated batches.
        nameHash: await core.sha256Hex(relevantNameGuide)
      };
    }

    function batchInputHash(batch) {
      return core.sha256Hex(JSON.stringify(batch.map(({ id, text }) => [id, text])));
    }

    let restorePromise;
    let jobsRestoredSuccessfully = false;

    async function restoreStoredJob(record) {
      if (!record || ![1, JOB_RECORD_VERSION].includes(record.version) || typeof record.id !== "string") return null;
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

    let translationJobs;
    const providerPool = providerPoolApi.createProviderPoolService({
      core, tabs, windows, storage, sessionStorage, runtime, debuggerApi, now,
      warmTemporaryTimeoutMs, providerReadyAttempts, providerReadyDelayMs,
      providerReadyPasses, poolCleanupDelayMs, poolCleanupSleep, jobs, warmPool,
      activeJapaneseLookups, activeNamePreviews, errorJournal, createId,
      withPoolLock, withProviderForegroundLock, holdChatGPTSetupPerformanceLease,
      releaseChatGPTSetupPerformanceLease, withProviderPerformanceLease,
      sendProviderMessage,
      protectOwnedProviderTab, resolveProviderWindowId, createOwnedProviderTab,
      registerStvTab, hasEligibleStvTab, normalizedPoolTarget, desiredPoolPurposes,
      requestedPurposePriorities, slotMatchesPurpose, hasExactPoolRoles,
      exposeSlotFailureToPool, nextReadySlot, storageCall, isStvUrl,
      resolveStvSenderChapter, publicPoolSnapshot, allowlistedPoolStatus,
      sanitizeProviderUiDiagnostic, sanitizeProviderSupportDiagnostic,
      persistOwnedProviderTabs, persistPool,
      clearPersistedPool, persistJob, removePersistedJob, sendToTab,
      notifyPoolStatus, readAutomationConfig, hashSettings, clearPrefetchParent,
      hasPrefetchParent, notifyStatus, diagnosticPhase, pause, loadSettings,
      acquireRecoverySlot: (...args) => acquireRecoverySlotPort(...args),
      dispatchCurrent: (...args) => translationJobs.dispatchCurrent(...args),
      probeProvider: (...args) => translationJobs.probeProvider(...args),
      restoreJobs: (...args) => restoreJobs(...args),
      didRestoreJobs: () => jobsRestoredSuccessfully, retrySleep,
      nextStvPresenceGeneration: () => ++stvPresenceGeneration,
      currentStvPresenceGeneration: () => stvPresenceGeneration
    });
    const {
      providerUrlFor, readyTimeoutFor, readySendTimeoutFor, ownedProviderUrl,
      providerUrl, providerMatchesUrl, isGeminiVerificationUrl,
      providerTabMatches, findPoolSlotByTab, findPoolSlotByJob,
      ownedDirectProviderForSender, developerKeepsFailedTabs, diagnosticHoldCode,
      retainDiagnosticTab, removeDiagnosticTab, removeOwnedSlot,
      restorePoolMetadata, verifyPreparedSlot, verifiedReadySlot,
      verifiedReadySlotByPriority, acquireJapaneseLookupSlot,
      releaseJapaneseLookupSlot, cancelJapaneseLookup, markWarmSlotFailed,
      markWarmSlotRecovered, validateSetupProviderResult, recheckSetupMarker,
      prepareWarmSlot, createWarmSlot, replaceFailedWarmSlot, fillWarmPool,
      ensureWarmPool, performWarmPoolReconfiguration, reconfigureWarmPool,
      cleanupWarmPool, scheduleLastStvCleanup, assignWarmSlot, acquireWarmSlot,
      drainWarmWaiters, spendJobSlot, closeLegacyProviderTab, openProvider
    } = providerPool;
    translationJobs = translationJobApi.createTranslationJobService({
      core, cache, apiClient, retryDelayMs, retrySleep, now, tabs, storage,
      sessionStorage, createId, jobs, warmPool, ttsSession, errorJournal,
      retainTerminalJob, withPoolLock, storageCall, loadSettings, loadApiKey,
      apiModel, hashSettings, cacheIdentity, batchInputHash, ensureJob, sendToTab,
      notifyStatus, notifyPrefetch, pause, persistJob, removePersistedJob,
      readAutomationConfig, acquireWarmSlot, assignWarmSlot, cleanupWarmPool,
      clearPrefetchParent, closeLegacyProviderTab, diagnosticPhase, drainWarmWaiters,
      ensureWarmPool, exposeSlotFailureToPool, fillWarmPool, findPoolSlotByTab,
      hasEligibleStvTab, hasPrefetchParent, isStvUrl, markWarmSlotFailed,
      markWarmSlotRecovered, notifyPoolStatus, openProvider, persistPool,
      prepareWarmSlot, providerTabMatches, readySendTimeoutFor, readyTimeoutFor,
      registerStvTab, releaseChatGPTSetupPerformanceLease, rememberPrefetchParent,
      removeOwnedSlot, requestedPurposePriorities, resolveStvSenderChapter,
      restoreJobs, restorePoolMetadata, sendProviderMessage, spendJobSlot,
      validateSetupProviderResult, verifiedReadySlotByPriority, verifyPreparedSlot,
      isStvSender, sites, warmTemporaryTimeoutMs, providerDiagnosticTimeoutMs
    });
    acquireRecoverySlotPort = translationJobs.acquireRecoverySlot;
    const {
      currentBatch, completeJob, advance, dispatchCurrent, probeProvider,
      startJob, cancelJob, resumeJob, providerResult, providerStatus,
      providerSetupProgress
    } = translationJobs;
    async function handleLegacyMessage(message, sender = {}) {
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
          return clientService.changeZoom(message, sender);
        case "STVAI_PAGE_ZOOM_RESTORE":
          return clientService.restoreZoom(message, sender);
        case 'STVAI_HISTORY_SYNC':
          return historySync.handle(message, sender);
        case 'STVAI_HISTORY_STATUS': {
          const senderUrl = String(sender?.url || '');
          if (!senderUrl.startsWith('chrome-extension://') || !senderUrl.includes('/options/options.html')) {
            return { ok: false, reason: 'unauthorized-sender' };
          }
          return historySync.status();
        }
        case 'STVAI_HISTORY_LEGACY_PREVIEW':
        case 'STVAI_HISTORY_LEGACY_IMPORT': {
          const senderUrl = String(sender?.url || '');
          if (!senderUrl.startsWith('chrome-extension://') || !senderUrl.includes('/options/options.html')) {
            return { ok: false, reason: 'unauthorized-sender' };
          }
          return message.type === 'STVAI_HISTORY_LEGACY_PREVIEW'
            ? historySync.previewLegacy() : historySync.importLegacy(message);
        }
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
          return ttsSession.handle(message, sender);
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
          return clientService.storageGet(message, sender);
        case "STVAI_STORAGE_SET":
          return clientService.storageSet(message, sender);
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
          if (!enabled) translationJobs.cancelAllPendingPrefetch();
          if (storage?.local?.set) await storageCall(storage.local, "set", { toolEnabled: enabled });
          if (!enabled) {
            await ttsSession.clear();
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

    const messageRouter = messageRouterApi.createMessageRouter({
      aliases: {
        STV_START_JOB: "STVAI_START_JOB",
        STV_CANCEL_JOB: "STVAI_CANCEL_JOB",
        STV_RESUME_JOB: "STVAI_RESUME_JOB",
        STV_PROVIDER_RESULT: "STVAI_PROVIDER_RESULT",
        STVAI_PROVIDER_READY: "STVAI_PROVIDER_STATUS"
      },
      routes: {
        STVAI_PAGE_ZOOM: (message, sender) => clientService.changeZoom(message, sender),
        STVAI_PAGE_ZOOM_RESTORE: (message, sender) => clientService.restoreZoom(message, sender),
        STVAI_STORAGE_GET: (message, sender) => clientService.storageGet(message, sender),
        STVAI_STORAGE_SET: (message, sender) => clientService.storageSet(message, sender),
        STVAI_TTS_SESSION_START: (message, sender) => ttsSession.handle(message, sender),
        STVAI_TTS_SESSION_CLAIM_NEXT: (message, sender) => ttsSession.handle(message, sender),
        STVAI_TTS_SESSION_UPDATE: (message, sender) => ttsSession.handle(message, sender),
        STVAI_TTS_SESSION_CLEAR: (message, sender) => ttsSession.handle(message, sender),
        STVAI_START_JOB: (message, sender) => startJob(message, sender),
        STVAI_CANCEL_JOB: (message, sender) => cancelJob(message, sender),
        STVAI_RESUME_JOB: (message, sender) => resumeJob(message, sender),
        STVAI_PROVIDER_RESULT: (message, sender) => providerResult(message, sender),
        STVAI_PROVIDER_STATUS: (message, sender) => providerStatus(message, sender),
        STVAI_PROVIDER_SETUP_PROGRESS: (message, sender) => providerSetupProgress(message, sender)
      },
      fallback: handleLegacyMessage
    });
    const handleMessage = messageRouter.handleMessage;

    async function handleTabUpdated(tabId, changeInfo, tab = {}) {
      const navigationUrl = String(changeInfo?.url || tab?.url || "");
      const stvUrlChanged = typeof changeInfo?.url === "string" && isStvUrl(navigationUrl);
      if ((changeInfo?.status === "loading" || stvUrlChanged) && isStvUrl(navigationUrl)) {
        clientService.trackNavigation(tabId, navigationUrl);
      }
      await ttsSession.trackNavigation(tabId, changeInfo?.url || tab?.url);
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
          await clientService.restoreZoomForTab(tabId, navigationUrl);
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
        if (typeof tabs?.getZoom === "function") await clientService.restoreZoomForTab(tabId, url);
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
      translationJobs.cancelPendingPrefetch(tabId);
      await translationJobs.clearPrefetchNameReceipt(tabId);
      await clearPrefetchParent(tabId);
      await ttsSession.clear(tabId);
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
        const value = clientService.uiScale(changes.stvaiUiScale?.newValue);
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
        translationJobs.cancelAllPendingPrefetch();
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
      handleZoomChanged: clientService.handleZoomChanged,
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

  return Object.freeze({ createBackgroundController, registerServiceWorker });
});
