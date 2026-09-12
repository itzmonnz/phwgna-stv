(function attachTranslationJobService(root, factory) {
  const contracts = root.STVAIBackgroundContracts
    || (typeof require === "function" ? require("./contracts.js") : null);
  const api = factory(contracts);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAITranslationJobService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTranslationJobApi(contracts) {
  "use strict";

  function createTranslationJobService(options = {}) {
    const {
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
      removeOwnedSlot, recycleOwnedSlot, requestedPurposePriorities, resolveStvSenderChapter,
      restoreJobs, restorePoolMetadata, sendProviderMessage, spendJobSlot,
      validateSetupProviderResult, verifiedReadySlotByPriority, verifyPreparedSlot,
      isStvSender, sites, warmTemporaryTimeoutMs, providerDiagnosticTimeoutMs
    } = options;
    const {
      SETUP_PARTS, READY_MARKER_GRACE_MS, REPLACEABLE_WARM_FAILURES,
      batchIdAt, exactItems, isAuthenticationBlocker
    } = contracts;
    const PREFETCH_NAME_RECEIPT_PREFIX = "stvai-prefetch-name-receipt:";

    function prefetchNameReceiptKey(sourceTabId) {
      return `${PREFETCH_NAME_RECEIPT_PREFIX}${sourceTabId}`;
    }

    async function rememberPrefetchNameReceipt(job) {
      if (!job?.prefetch || job.cacheable === false || !sessionStorage?.set) return;
      const identity = job.cacheIdentity;
      const fields = ["provider", "chapterId", "chapterKey", "batchHash", "sourceHash", "promptHash", "nameHash"];
      if (!fields.every((field) => typeof identity?.[field] === "string" && identity[field])) return;
      const receipt = {
        version: 1,
        sourceTabId: job.sourceTabId,
        ...Object.fromEntries(fields.map((field) => [field, identity[field]]))
      };
      await storageCall(sessionStorage, "set", {
        [prefetchNameReceiptKey(job.sourceTabId)]: receipt
      }).catch(() => undefined);
    }

    async function consumeNameChangeRestartReason(sourceTabId, identity) {
      if (!sessionStorage?.get || !sessionStorage?.remove) return "";
      const key = prefetchNameReceiptKey(sourceTabId);
      const stored = await storageCall(sessionStorage, "get", key).catch(() => ({}));
      const receipt = stored?.[key];
      if (receipt?.version !== 1 || receipt.sourceTabId !== sourceTabId
        || typeof receipt.chapterKey !== "string" || receipt.chapterKey !== identity?.chapterKey) return "";

      // Reaching the prefetched chapter consumes the receipt even when its source
      // changed. This prevents an old prefetch from explaining a later restart.
      await storageCall(sessionStorage, "remove", key).catch(() => undefined);
      const sameTranslationInput = ["provider", "chapterId", "chapterKey", "batchHash", "sourceHash", "promptHash"]
        .every((field) => typeof identity?.[field] === "string" && receipt[field] === identity[field]);
      return sameTranslationInput && typeof receipt.nameHash === "string"
        && receipt.nameHash !== identity.nameHash
        ? "name_guide_changed"
        : "";
    }

    async function clearPrefetchNameReceipt(sourceTabId) {
      if (!sessionStorage?.remove) return;
      await storageCall(sessionStorage, "remove", prefetchNameReceiptKey(sourceTabId)).catch(() => undefined);
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
      return { ok: true, jobId: job.id, status: "completed", cached: Boolean(cached), items, totalBatches, fallbackCount,
        restartReason: job.restartReason || "" };
    }

    function cachedBatchSnapshot(job) {
      const batches = [];
      for (let index = 0; index < job.batches.length; index += 1) {
        const items = job.completed.get(batchIdAt(index));
        if (!items) continue;
        batches.push({
          batchId: batchIdAt(index),
          batchIndex: index,
          items
        });
      }
      return batches;
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
      let released = false;
      const slot = oldSlotId
        ? warmPool.slots.find(candidate => candidate.slotId === oldSlotId && candidate.jobId === job.id)
        : null;
      if (slot) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(slot) || slot.jobId !== job.id) return;
          job.providerTabId = null;
          released = await recycleOwnedSlot(slot, warmPool.settings || job.settings);
          if (!released) released = await removeOwnedSlot(slot, { errorReason: "stale_stop_after_accept" });
        });
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab(job);
        released = !Number.isInteger(job.providerTabId);
      }
      if (!released) return pause(job, "provider_tab_close_failed");

      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      job.activeRequestId = "";
      job.unsentRequestId = "";
      job.workState = "queued";
      job.recoveryStage = "switching_ready";
      await persistJob(job);
      await errorJournal?.append?.(incidentKey, {
        kind: slot?.state === "opening" ? "stale_stop_recycled" : "stale_stop_replaced",
        errorCode: "stale_stop_after_accept",
        tabClosed: slot?.state !== "opening",
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
      await rememberPrefetchNameReceipt(job);
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
        const contentValidation = core.validateTranslationItems?.(validation.items, expectedBlocks)
          || core.validateApiTranslationItems?.(validation.items, expectedBlocks)
          || { ok: true, reason: "ok" };
        if (!contentValidation.ok) {
          job.validationDiagnostic.reason = contentValidation.reason;
          return recoverBatch(job, contentValidation.reason);
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
          settings: job.settings,
          retryReason: job.batchAttempts > 1 ? job.lastBatchError : ""
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
        if (["gemini", "chatgpt"].includes(job.provider) && reason === "response_timeout"
          && /^batch_\d+_\d{4}$/.test(job.activeRequestId || "")) {
          if (job.retryAttempts < 1) {
            // A confirmed Send can finish just after our response watchdog.
            // Re-read the exact request once before creating another marker or
            // retiring the tab. The adapter will not click again when it sees
            // the existing user-query marker.
            job.retryAttempts += 1;
            job.unsentRequestId = job.activeRequestId;
            job.workState = "queued";
            await persistJob(job);
            await notifyStatus(job, "running", "rechecking_response");
            await retrySleep(retryDelayMs);
            if (job.status !== "running") return { ok: false, reason: "not-runnable" };
            return dispatchCurrent(job);
          }
          // The exact request stayed unresolved through its bounded recheck.
          // Consume the recovery budget and move on without an infinite loop.
          job.unsentRequestId = "";
          job.retryAttempts = 0;
          job.batchAttempts = Math.max(2, Number(job.batchAttempts) || 0);
        }
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
        if (reason === "send_not_confirmed" && ["gemini", "chatgpt"].includes(job.provider)
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
        if (admission.reserved && message.ttsSessionId && !jobs.has(message.jobId)) {
          await ttsSession.releaseStart(message, sender);
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
      if (!await ttsSession.authorizeStart(message, sender)) {
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
      if (!await ttsSession.authorizeStart(message, sender, () => jobs.set(id, job))) {
        return { ok: false, reason: "stale-tts-session" };
      }
      await persistJob(job);
      if (!job.prefetch) {
        job.restartReason = await consumeNameChangeRestartReason(job.sourceTabId, identity);
      }

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
        const contentValidation = exactItems(items, batches[index])
          ? (core.validateTranslationItems?.(items, batches[index])
            || core.validateApiTranslationItems?.(items, batches[index])
            || { ok: true })
          : { ok: false };
        if (contentValidation.ok) job.completed.set(batchId, core.filterTranslationItems(items, batches[index]));
      }
      if (job.completed.size === batches.length) return completeJob(job, true);
      // A tab can navigate between the first cached push and the following
      // pushes. Include the cache snapshot in the reply that is bound to the
      // requesting document so the new reader can reconcile any missed event.
      const cachedBatches = cachedBatchSnapshot(job);
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
          reason: job.pauseReason || dispatched?.reason || "",
          restartReason: job.restartReason || "",
          cachedBatches
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
          reason: job.pauseReason || "",
          restartReason: job.restartReason || "",
          cachedBatches
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
        reason: job.pauseReason || "",
        restartReason: job.restartReason || "",
        cachedBatches
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

    return Object.freeze({
      currentBatch,
      completeJob,
      advance,
      dispatchCurrent,
      probeProvider,
      startJob,
      cancelJob,
      resumeJob,
      providerResult,
      providerStatus,
      providerSetupProgress,
      acquireRecoverySlot,
      cancelPendingPrefetch,
      clearPrefetchNameReceipt,
      cancelAllPendingPrefetch() {
        for (const admission of pendingPrefetch.values()) admission.cancelled = true;
      }
    });
  }

  return Object.freeze({ createTranslationJobService });
});
