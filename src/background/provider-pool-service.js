(function attachProviderPoolService(root, factory) {
  const contracts = root.STVAIBackgroundContracts
    || (typeof require === "function" ? require("./contracts.js") : null);
  const api = factory(contracts);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIProviderPoolService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createProviderPoolApi(contracts) {
  "use strict";

  function createProviderPoolService(options = {}) {
    const {
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
      acquireRecoverySlot, dispatchCurrent, probeProvider, restoreJobs, didRestoreJobs,
      retrySleep,
      nextStvPresenceGeneration, currentStvPresenceGeneration
    } = options;
    const {
      SETUP_PARTS, PROVIDER_URLS, READY_TIMEOUT_MS, CHATGPT_READY_TIMEOUT_MS,
      READY_SEND_TIMEOUT_MS, CHATGPT_READY_SEND_TIMEOUT_MS,
      CHATGPT_SETUP_INACTIVITY_MS, CHATGPT_SETUP_HARD_TIMEOUT_MS,
      READY_MARKER_GRACE_MS, MAX_WARM_REPLACEMENTS, MIN_POOL_TABS,
      MAX_POOL_TABS, POOL_STORAGE_KEY, OWNED_TABS_STORAGE_KEY,
      DEVELOPER_KEEP_TABS_KEY, OWNED_TABS_RECORD_VERSION, AUTHENTICATION_BLOCKERS,
      REPLACEABLE_WARM_FAILURES, isAuthenticationBlocker
    } = contracts;
    let poolFillOperation = null;
    let poolReconfigurationSerial = Promise.resolve();

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

    async function recycleOwnedSlot(slot, settings, options = {}) {
      if (!slot || !Number.isInteger(slot.providerTabId) || typeof tabs.update !== "function") return false;
      if (!warmPool.slots.includes(slot)) return false;
      if (!settings || settings.provider !== slot.provider) return false;
      if (!options.force && await developerKeepsFailedTabs()) return false;

      const targetUrl = ownedProviderUrl(settings.provider, settings.temporaryChat);
      const previousState = slot.state;
      const previousJobId = slot.jobId;
      const preparationAttemptId = createId("recycle-attempt");
      await releaseChatGPTSetupPerformanceLease(slot);
      slot.state = "opening";
      slot.jobId = "";
      slot.errorCode = "";
      slot.documentGeneration = (slot.documentGeneration || 0) + 1;
      slot.documentLoading = true;
      slot.documentLoadedAt = 0;
      slot.lastKnownUrl = targetUrl;
      slot.preparationAttemptId = preparationAttemptId;
      slot.preparationRequested = false;
      slot.preparationPasses = 0;
      slot.warmSessionId = createId("warm");
      slot.setupId = createId("setup");
      slot.setupSessionId = createId("setup-session");
      slot.warmJobId = createId("warm-job");
      slot.setupCheckpoint = 0;
      slot.setupState = "idle";
      slot.setupStage = "idle";
      slot.setupStageStartedAt = 0;
      slot.setupLastProgressAt = 0;
      slot.setupResumeCount = 0;
      slot.setupServiceWorkerRestarts = 0;
      slot.setupResumeAttempts = 0;
      slot.setupErrorCode = "";
      slot.firstBatchDispatchedAt = 0;
      await persistPool();
      try {
        await tabs.update(slot.providerTabId, { url: targetUrl });
        return true;
      } catch (_error) {
        if (!warmPool.slots.includes(slot) || slot.preparationAttemptId !== preparationAttemptId) return false;
        slot.state = previousState;
        slot.jobId = previousJobId;
        slot.documentLoading = false;
        slot.errorCode = "provider_tab_recycle_failed";
        await persistPool();
        return false;
      }
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
      slot.retryNotBefore = ["response_timeout", "send_not_confirmed"].includes(slot.errorCode)
        ? slot.failedAt
        : slot.failedAt + 8_000;
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

    async function reconcileUnconfirmedSetupMarker(slot, setupIndex, attempts, current) {
      const limit = Math.max(1, Math.trunc(Number(attempts) || 1));
      slot.readyWatchdogState = "rechecking_marker";
      for (let attempt = 0; attempt < limit; attempt += 1) {
        if (!current()) return false;
        if (await recheckSetupMarker(slot, setupIndex)) return true;
        if (attempt + 1 < limit) await retrySleep(READY_MARKER_GRACE_MS);
      }
      return false;
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
              const responseCode = response.error?.code;
              const recheckAttempts = responseCode === "send_not_confirmed"
                ? Math.max(1, Math.ceil((readyTimeoutMs - readySendTimeoutMs) / READY_MARKER_GRACE_MS))
                : 1;
              if (["response_timeout", "send_not_confirmed"].includes(responseCode)
                && await reconcileUnconfirmedSetupMarker(slot, setupIndex, recheckAttempts, current)) {
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
      let recycledInPlace = false;
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
        if (["send_not_confirmed", "response_timeout"].includes(failedSlot.errorCode)) {
          failedSlot.recoveryAttempts = nextAttempt;
          recycledInPlace = await recycleOwnedSlot(failedSlot, settings);
          if (recycledInPlace) {
            replacement = failedSlot;
            return;
          }
        }
        if (!(await removeOwnedSlot(failedSlot, { errorReason: failedSlot.errorCode }))) return;
        replacement = await createWarmSlot(settings, settingsHash, nextAttempt, failedSlot.purpose || "shared");
        replacement.errorIncidentKey = errorIncidentKey;
      });
      if (!replacement || !settings) {
        await notifyPoolStatus();
        return false;
      }
      if (recycledInPlace) {
        await notifyPoolStatus();
        await drainWarmWaiters();
        return true;
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
            && ((!owner && didRestoreJobs()) || ["completed", "cancelled"].includes(owner?.status)))) {
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
      const generation = nextStvPresenceGeneration();
      const cleanupIfStillGone = async () => {
        if (generation !== currentStvPresenceGeneration() || warmPool.stvTabs.size > 0) return;
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
              const recycled = warmPool.settings
                ? await recycleOwnedSlot(slot, warmPool.settings)
                : false;
              if (!recycled) {
                await removeOwnedSlot(slot, { removalReason: "job_completed" });
                if (warmPool.settings) await fillWarmPool(warmPool.settings, warmPool.settingsHash);
              }
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


    return Object.freeze({
      providerUrlFor, readyTimeoutFor, readySendTimeoutFor, ownedProviderUrl,
      providerUrl, providerMatchesUrl, isGeminiVerificationUrl,
      providerTabMatches, findPoolSlotByTab, findPoolSlotByJob,
      ownedDirectProviderForSender, developerKeepsFailedTabs, diagnosticHoldCode,
      retainDiagnosticTab, removeDiagnosticTab, removeOwnedSlot, recycleOwnedSlot,
      restorePoolMetadata, verifyPreparedSlot, verifiedReadySlot,
      verifiedReadySlotByPriority, acquireJapaneseLookupSlot,
      releaseJapaneseLookupSlot, cancelJapaneseLookup, markWarmSlotFailed,
      markWarmSlotRecovered, validateSetupProviderResult, recheckSetupMarker,
      prepareWarmSlot, createWarmSlot, replaceFailedWarmSlot, fillWarmPool,
      ensureWarmPool, performWarmPoolReconfiguration, reconfigureWarmPool,
      cleanupWarmPool, scheduleLastStvCleanup, assignWarmSlot, acquireWarmSlot,
      drainWarmWaiters, spendJobSlot, closeLegacyProviderTab, openProvider
    });
  }

  return Object.freeze({ createProviderPoolService });
});
