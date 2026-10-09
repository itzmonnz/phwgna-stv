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
      geminiAccounts, recoverGemini1095Slot,
      retainTerminalJob, withPoolLock, storageCall, loadSettings, loadApiKey,
      apiModel, hashSettings, cacheIdentity, batchInputHash, batchPresentationHash, batchSourceHashes, ensureJob, sendToTab,
      notifyStatus, notifyPrefetch, pause, persistJob, removePersistedJob,
      readAutomationConfig, acquireWarmSlot, assignWarmSlot, cleanupWarmPool,
      clearPrefetchParent, closeLegacyProviderTab, diagnosticPhase, drainWarmWaiters,
      ensureWarmPool, exposeSlotFailureToPool, fillWarmPool, findPoolSlotByTab,
      hasEligibleStvTab, hasPrefetchParent, isStvUrl, markWarmSlotFailed,
      markWarmSlotRecovered, notifyPoolStatus, openProvider, persistPool,
      prepareWarmSlot, restartLeasedGeminiSlot, recoverGeminiSlotInPlace, retryFailedGeminiSlots, cancelGeminiRecovery, providerTabMatches, readySendTimeoutFor, readyTimeoutFor,
      wakeOrphanedReadyLease,
      registerStvTab, releaseChatGPTSetupPerformanceLease, rememberPrefetchParent,
      removeOwnedSlot, recycleOwnedSlot, requestedPurposePriorities, resolveStvSenderChapter,
      restoreJobs, restorePoolMetadata, sendProviderMessage, spendJobSlot,
      validateSetupProviderResult, verifiedReadySlotByPriority, verifyPreparedSlot,
      isStvSender, sites, warmTemporaryTimeoutMs, providerDiagnosticTimeoutMs
    } = options;
    const resumeOperations = new Map();
    const {
      SETUP_PARTS, READY_MARKER_GRACE_MS, REPLACEABLE_WARM_FAILURES,
      GEMINI_SEND_NOT_CONFIRMED_RETRIES, GEMINI_SESSION_BATCH_LIMIT,
      batchIdAt, exactItems, isAuthenticationBlocker
    } = contracts;
    const PREFETCH_NAME_RECEIPT_PREFIX = "stvai-prefetch-name-receipt:";
    const REFUSAL_API_BATCH_LIMIT = 5;
    const REFUSAL_API_ATTEMPT_LIMIT = 2;
    const REFUSAL_RESCUE_QUEUE_LIMIT = 2;

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

    function ensureParallelBatchState(job) {
      if (!Array.isArray(job.batchStates) || job.batchStates.length !== job.batches.length) {
        job.batchStates = Array.from({ length: job.batches.length }, (_value, index) => (
          job.completed.has(batchIdAt(index)) ? "completed" : "pending"
        ));
      }
      if (!Array.isArray(job.rescueApiQueue)) job.rescueApiQueue = [];
      return job.batchStates;
    }

    function nextNormalBatchIndex(job, from = job.batchIndex) {
      const states = ensureParallelBatchState(job);
      let index = Math.max(0, Number(from) || 0);
      while (index < job.batches.length && states[index] !== "pending") index += 1;
      return index;
    }

    function rescueQueueDepth(job) {
      return Array.isArray(job.rescueLane?.queue) ? job.rescueLane.queue.length : 0;
    }

    function rescueTaskExists(job, batchIndex) {
      const lane = job.rescueLane;
      return Boolean(lane?.current?.batchIndex === batchIndex
        || lane?.queue?.some(task => task?.batchIndex === batchIndex)
        || job.rescueApiActive?.batchIndex === batchIndex
        || job.rescueApiQueue?.some(task => task?.batchIndex === batchIndex));
    }

    function removeDuplicateRescueTasks(job, batchIndex) {
      const lane = job.rescueLane;
      if (lane?.queue) lane.queue = lane.queue.filter(task => task?.batchIndex !== batchIndex);
      if (job.rescueApiQueue) job.rescueApiQueue = job.rescueApiQueue.filter(task => task?.batchIndex !== batchIndex);
    }

    function safeLaneTask(batchIndex, requestId, attempts = 0, metadata = {}) {
      return {
        batchIndex: Math.max(0, Math.trunc(Number(batchIndex) || 0)),
        requestId: String(requestId || ""),
        attempts: Math.max(0, Math.min(3, Math.trunc(Number(attempts)) || 0)),
        system2Attempts: Math.max(0, Math.min(2, Math.trunc(Number(metadata.system2Attempts)) || 0)),
        technicalRecoveryAttempts: Math.max(0, Math.min(3, Math.trunc(Number(metadata.technicalRecoveryAttempts)) || 0)),
        receiptAttempts: Math.max(0, Math.min(3, Math.trunc(Number(metadata.receiptAttempts)) || 0))
      };
    }

    function receiptKey(lane, requestId) {
      return `${lane}:${String(requestId || "")}`;
    }

    function recordDispatch(job, lane, task, status, extra = {}) {
      if (!job || !task?.requestId) return;
      const records = job.dispatchReceipts && typeof job.dispatchReceipts === "object"
        ? job.dispatchReceipts : (job.dispatchReceipts = {});
      const key = receiptKey(lane, task.requestId);
      const previous = records[key] || {};
      records[key] = {
        jobId: job.id,
        batchId: batchIdAt(task.batchIndex),
        batchIndex: task.batchIndex,
        requestId: task.requestId,
        generation: Math.max(0, Number(job.generation || job.documentGeneration) || 0),
        lane: lane === "rescue" ? "rescue" : "normal",
        tabId: Number.isInteger(extra.tabId) ? extra.tabId : (Number.isInteger(previous.tabId) ? previous.tabId : null),
        status: String(status || previous.status || "dispatch_started"),
        attempts: Math.max(0, Number(task.attempts) || 0),
        system2Attempts: Math.max(0, Number(task.system2Attempts) || 0),
        technicalRecoveryAttempts: Math.max(0, Number(task.technicalRecoveryAttempts) || 0),
        updatedAt: now(),
        ...(extra.reason ? { reason: String(extra.reason).slice(0, 64) } : {}),
        ...(extra.outcomeCode ? { outcomeCode: String(extra.outcomeCode).slice(0, 64) } : {})
      };
      const keys = Object.keys(records);
      if (keys.length > 24) {
        keys.sort((a, b) => Number(records[a]?.updatedAt || 0) - Number(records[b]?.updatedAt || 0));
        for (const stale of keys.slice(0, keys.length - 24)) delete records[stale];
      }
    }

    function refreshParallelStatus(job) {
      job.parallelStatus = {
        normalBatchIndex: job.batchIndex < job.batches.length ? job.batchIndex : null,
        rescueBatchIndex: Number.isInteger(job.rescueLane?.current?.batchIndex)
          ? job.rescueLane.current.batchIndex : null,
        rescueQueueCount: rescueQueueDepth(job),
        rescueActive: Boolean(job.rescueLane),
        apiFallbackActive: Boolean(job.rescueApiActive)
      };
    }

    function normalLaneHasInflightRequest(job) {
      return ensureParallelBatchState(job).some((state) => state === "normal_inflight")
        && /^batch_\d+_\d{4}$/.test(String(job.activeRequestId || ""))
        && Number.isInteger(job.providerTabId);
    }

    async function pauseParallelAfterNormalSettles(job, reason) {
      const pauseReason = String(reason || "provider_error");
      if (!normalLaneHasInflightRequest(job)) return pause(job, pauseReason);
      job.parallelPauseReason = pauseReason;
      refreshParallelStatus(job);
      await persistJob(job);
      await notifyStatus(job, "running", "refusal_api_failed_waiting_normal");
      return { ok: true, deferredPause: true, reason: pauseReason };
    }

    function resetProviderSession(job) {
      job.unsentRequestId = "";
      job.phase = "setup";
      job.setupIndex = 0;
      job.setupAttempts = 0;
      job.retryAttempts = 0;
      job.sendNotConfirmedAttempts = 0;
      job.receiptMissingAttempts = 0;
      clearBusyState(job);
      job.repairBlocks = [];
      job.repairAttempts = 0;
      job.recoveryQueue = [];
      job.recoveryItems = new Map();
      job.pending = false;
      resetStable(job);
    }

    async function completeJob(job, cached) {
      if (job.completed.size !== job.batches.length) {
        refreshParallelStatus(job);
        await persistJob(job);
        return { ok: true, waitingRescue: true };
      }
      if (!cached && job.rescueLane) await releaseParallelRescueLane(job);
      job.status = "completed";
      job.pending = false;
      await persistJob(job);
      // A small content-free receipt survives worker suspension during the next
      // chapter load; completed jobs themselves are removed from session storage.
      await rememberPrefetchParent(job);
      const items = job.batches.flatMap((_batch, index) => job.completed.get(batchIdAt(index)) || []);
      const fallbackCount = items.filter((item) => item?.origin === "convert").length;
      const totalBatches = job.batches.length;
      const apiBatchIndexes = cached ? [] : Array.from(job.apiBatchIndexes || [])
        .filter((index) => Number.isInteger(index) && index >= 0 && index < totalBatches)
        .sort((a, b) => a - b);
      // Release ownership before notifying the reader, but never wait for the
      // completed Gemini conversation to finish a full READY reset. The reset
      // continues durably in the background while another READY slot can accept
      // next-chapter prefetch immediately.
      let completedReset;
      if (!cached) {
        if (job.poolSlotId) completedReset = await spendJobSlot(job, { deferReadyReset: true, resetAfterChapter: true, deferStartUntilNotified: true });
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
          fallbackCount,
          apiBatchIndexes
        });
      }
      if (completedReset) void recoverGeminiSlotInPlace(completedReset, warmPool.settings || job.settings, {afterChapterNotification: true});
      retainTerminalJob(job);
      return { ok: true, jobId: job.id, status: "completed", cached: Boolean(cached), items, totalBatches, fallbackCount,
        apiBatchIndexes,
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

    async function replayExistingJob(job, options = {}) {
      const emit = options.emit !== false;
      const items = [];
      for (let index = 0; index < job.batches.length; index += 1) {
        const batchItems = job.completed.get(batchIdAt(index));
        if (!batchItems) continue;
        items.push(...batchItems);
        if (emit) await sendToTab(job.sourceTabId, {
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
      if (job.status === "completed" && emit) {
        await sendToTab(job.sourceTabId, {
          type: "STV_JOB_COMPLETE",
          jobId: job.id,
          items,
          cached: true,
          fallbackCount,
          totalBatches: job.batches.length
        });
      } else if (emit) {
        await notifyStatus(job, job.status, job.pauseReason || "");
      }
      return {
        ok: true,
        jobId: job.id,
        status: job.status,
        cached: job.status === "completed",
        apiBatchIndexes: job.status === "completed"
          ? []
          : Array.from(job.apiBatchIndexes || []).sort((a, b) => a - b),
        items,
        cachedBatches: cachedBatchSnapshot(job),
        totalBatches: job.batches.length,
        fallbackCount,
        reattached: true
      };
    }

    async function replayJob(message, sender) {
      if (!isStvSender(sender)) return { ok: false, reason: "unauthorized-sender" };
      const job = await ensureJob(String(message?.jobId || ""));
      if (!job || job.prefetch === true) return { ok: false, reason: "stale-job" };
      if (job.sourceTabId !== sender?.tab?.id) return { ok: false, reason: "wrong-source-tab" };
      return replayExistingJob(job, { emit: false });
    }

    async function advance(job, options = {}) {
      job.batchIndex = nextNormalBatchIndex(job, job.batchIndex);
      if (job.batchIndex >= job.batches.length) {
        if (job.completed.size === job.batches.length
          && !job.rescueLane?.current && rescueQueueDepth(job) === 0
          && !job.rescueApiActive && !(job.rescueApiQueue?.length)) {
          return completeJob(job, false);
        }
        const hasParallelWork = ensureParallelBatchState(job).some((state) => (
          ["rescue_queued", "rescue_inflight", "api_inflight"].includes(state)
        ));
        if (!hasParallelWork) return pause(job, "incomplete_response");
        job.normalBackpressure = true;
        refreshParallelStatus(job);
        await notifyStatus(job, "running", "waiting_refusal_lane");
        return { ok: true, waitingRescue: true };
      }
      if (rescueQueueDepth(job) >= REFUSAL_RESCUE_QUEUE_LIMIT) {
        job.normalBackpressure = true;
        refreshParallelStatus(job);
        await notifyStatus(job, "running", "refusal_queue_full");
        return { ok: true, waitingRescue: true };
      }
      job.normalBackpressure = false;
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
      job.recoveryExcludedSlotId = "";
      job.workState = "queued";
      job.validationDiagnostic = null;
      job.lastBatchError = "";
      clearBusyState(job);
      resetStable(job);
      await persistJob(job);
      if (options.deferDispatch === true) return { ok: true, deferred: true };
      return dispatchCurrent(job);
    }

    async function recoverOrphanedReadyLease(slot) {
      if (!slot?.jobId || slot.state !== "ready") return false;
      await restoreJobs();
      const job = jobs.get(slot.jobId);
      if (!job || ["completed", "cancelled"].includes(job.status)) {
        await withPoolLock(async () => {
          if (slot.state !== "ready" || !slot.jobId) return;
          slot.jobId = "";
          slot.laneRole = "";
          await persistPool();
        });
        return false;
      }
      if (slot.laneRole === "rescue") {
        const lane = job.rescueLane;
        if (!lane || lane.slotId !== slot.slotId || lane.providerTabId !== slot.providerTabId
          || !lane.queue?.length || lane.running
          || !["running", "paused"].includes(job.status)
          || (job.status === "paused" && !["service_worker_restarted", "temporary_unavailable"].includes(job.pauseReason))
          || !await verifyPreparedSlot(slot)) return false;
        let claimed = false;
        await withPoolLock(async () => {
          if (slot.state !== "ready" || slot.jobId !== job.id || job.rescueLane !== lane
            || lane.running || !lane.queue.length) return;
          slot.state = "leased";
          lane.ready = true;
          lane.warmSessionId = String(slot.warmSessionId || "");
          lane.settingsHash = String(slot.settingsHash || "");
          job.status = "running";
          job.pauseReason = "";
          job.resumeAfterRestore = false;
          await persistPool();
          await persistJob(job);
          claimed = true;
        });
        if (!claimed) return false;
        await runParallelRescueLane(job);
        return true;
      }
      if (!job || !["running", "paused"].includes(job.status)
        || (job.status === "paused" && job.pauseReason !== "service_worker_restarted")
        || job.provider !== "gemini"
        || job.poolSlotId !== slot.slotId || job.providerTabId !== slot.providerTabId
        || job.phase !== "batch" || job.pending || job.resetContinuationPending !== true
        || job.workState !== "settled"
        || job.batchIndex >= job.batches.length
        || ensureParallelBatchState(job)[job.batchIndex] !== "pending") return false;
      if (!await verifyPreparedSlot(slot)) return false;
      let claimed = false;
      await withPoolLock(async () => {
        if (slot.state !== "ready" || slot.jobId !== job.id
          || !["running", "paused"].includes(job.status)
          || (job.status === "paused" && job.pauseReason !== "service_worker_restarted")
          || job.pending || job.workState !== "settled"
          || ensureParallelBatchState(job)[job.batchIndex] !== "pending") return;
        slot.state = "leased";
        job.status = "running";
        job.resumeAfterRestore = false;
        job.pauseReason = "";
        job.warmSessionId = String(slot.warmSessionId || "");
        job.settingsHash = String(slot.settingsHash || "");
        await persistPool();
        await persistJob(job);
        claimed = true;
      });
      if (!claimed) return false;
      await advance(job);
      job.resetContinuationPending = false;
      await persistJob(job);
      return true;
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

    async function commitBatchAt(job, completedBatchIndex, items, slot = null, options = {}) {
      const id = batchIdAt(completedBatchIndex);
      const sourceBatch = job.batches[completedBatchIndex] || [];
      if (job.completed.has(id)) return { id, duplicate: true };
      if (items.some((item) => item.fallbackReason === "safety_placeholder_missing_convert")) job.cacheable = false;
      if (job.cacheable === false) await cache.deleteChapter(job.cacheIdentity);
      else await cache.putBatch(job.cacheIdentity, id, items, {
        inputHash: await batchInputHash(sourceBatch),
        presentationHash: await batchPresentationHash(sourceBatch),
        sourceHashes: await batchSourceHashes(sourceBatch)
      });
      await rememberPrefetchNameReceipt(job);
      job.completed.set(id, items);
      if (options.apiUsed === true) job.apiBatchIndexes.add(completedBatchIndex);
      ensureParallelBatchState(job)[completedBatchIndex] = "completed";
      if (slot && job.provider === "gemini") {
        if (job.settings.geminiAccountRotationEnabled === true && options.apiUsed !== true) {
          await geminiAccounts?.markBatchSucceeded?.(slot.providerTabId);
        }
        slot.batchUseCount = Math.min(
          GEMINI_SESSION_BATCH_LIMIT,
          Math.max(0, Number(slot.batchUseCount) || 0) + 1
        );
        await persistPool();
      }
      if (!job.prefetch) {
        await sendToTab(job.sourceTabId, {
          type: "STV_BATCH_COMPLETE",
          jobId: job.id,
          batchId: id,
          batchIndex: completedBatchIndex,
          totalBatches: job.batches.length,
          items,
          cached: false,
          apiUsed: options.apiUsed === true
        });
      }
      refreshParallelStatus(job);
      await persistJob(job);
      return { id, duplicate: false };
    }

    async function saveCompletedBatch(job, items, options = {}) {
      const completedBatchIndex = job.batchIndex;
      const completedBatchAttempt = job.batchAttempts || 0;
      const expectedCount = currentBatch(job)?.length || items.length;
      const completedSlot = job.poolSlotId
        ? warmPool.slots.find(candidate => candidate.slotId === job.poolSlotId
          && candidate.jobId === job.id)
        : null;
      await commitBatchAt(job, completedBatchIndex, items, completedSlot, {
        apiUsed: core.isApiProvider(job.provider) || options.resumeWebAfterFallback === true
      });
      job.refusalSanitizeAttempted = false;
      const rescuedOnThisBatch = job.refusalRescueActive === true;
      job.refusalRescueActive = false;
      if (rescuedOnThisBatch) job.refusalRescueOutcome = "succeeded";
      await errorJournal?.append?.(`${job.id}:${completedBatchIndex}`, {
        kind: "batch_recovered",
        provider: job.provider,
        phase: diagnosticPhase(job),
        batchIndex: completedBatchIndex,
        batchAttempt: job.batchAttempts || 0,
        outcome: "recovered",
        onlyExisting: true
      });
      if (job.prefetch) await notifyPrefetch(job, 'running', rescuedOnThisBatch ? "refusal_system2_succeeded" : undefined);
      if (!job.prefetch && rescuedOnThisBatch) await notifyStatus(job, "running", "refusal_system2_succeeded");
      job.batchIndex += 1;
      job.batchIndex = nextNormalBatchIndex(job, job.batchIndex);
      await persistJob(job);
      if (job.parallelPauseReason) {
        const pauseReason = job.parallelPauseReason;
        job.parallelPauseReason = "";
        await persistJob(job);
        return pause(job, pauseReason);
      }
      if (rescuedOnThisBatch && job.provider === "gemini" && job.status === "running"
        && Number.isInteger(job.providerTabId) && job.poolSlotId) {
        const slot = warmPool.slots.find(candidate => candidate.slotId === job.poolSlotId
          && candidate.jobId === job.id);
        job.resetContinuationPending = true;
        await persistJob(job);
        if (!slot || !await restartLeasedGeminiSlot(slot, job.settings, { timeoutMs: warmTemporaryTimeoutMs })) {
          return pause(job, "provider_unavailable");
        }
        job.warmSessionId = String(slot.warmSessionId || "");
        job.settingsHash = String(slot.settingsHash || "");
        await persistJob(job);
      }
      if (options.resumeWebAfterFallback === true && core.isWebProvider(job.provider)) {
        job.refusalApiPending = false;
        job.refusalApiRequestId = "";
        job.refusalApiAttempts = 0;
        job.providerTabId = null;
        job.poolSlotId = "";
        job.warmSessionId = "";
        job.settingsHash = "";
        const advanced = await advance(job, { deferDispatch: true });
        if (job.status === "completed") return advanced;
        await notifyStatus(job, "running", "returning_to_web_pool");
        if (!await acquireWarmSlot(job)) return pause(job, "provider_unavailable");
        return { ok: true, resumedWeb: true };
      }
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
      if (job.provider === "gemini" && job.batchIndex < job.batches.length
        && completedSlot?.batchUseCount >= GEMINI_SESSION_BATCH_LIMIT) {
        job.resetContinuationPending = true;
        await persistJob(job);
        if (!await restartLeasedGeminiSlot(completedSlot, job.settings, {
          timeoutMs: warmTemporaryTimeoutMs
        })) return pause(job, "provider_unavailable");
        job.warmSessionId = String(completedSlot.warmSessionId || "");
        job.settingsHash = String(completedSlot.settingsHash || "");
        await persistJob(job);
      }
      const advanced = await advance(job);
      job.resetContinuationPending = false;
      await persistJob(job);
      return advanced;
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
        && ["switching_ready", "handoff_batch"].includes(job.recoveryStage) && !job.poolSlotId;
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
            requestedPurposePriorities(job, "recovery"),
            job.recoveryExcludedSlotId || ""
          );
          if (!runnable()) return;
          if (slot) {
            assignWarmSlot(job, slot);
            job.recoveryExcludedSlotId = "";
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
      if (!assigned) {
        await notifyStatus(job, "waiting-provider",
          job.recoveryStage === "handoff_batch" ? "waiting_ready_tab" : "pool_waiting");
        return true;
      }
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
          && (job.provider !== "chatgpt" || Number(failedSlot.setupCheckpoint) >= SETUP_PARTS.length),
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
        // Prefetch runs in the background and can receive a late response from
        // a tab that was just recycled. Give that lane one additional bounded
        // recovery cycle so a transient handoff race does not stop the next
        // chapter permanently. Foreground jobs keep the stricter single-cycle
        // budget to avoid hiding a real provider failure from the reader.
        const maxAutomaticRecoveryCycles = job.prefetch ? 2 : 1;
        if (job.provider === "gemini"
          && (job.automaticRecoveryCycles || 0) < maxAutomaticRecoveryCycles) {
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
      const refusalApiFallback = message.refusalApiFallback === true;
      if (String(message.outcomeCode || "") === "content_refused") {
        job.workState = "settled";
        if (refusalApiFallback) return pause(job, "refusal_api_content_refused");
        if (job.provider === "gemini" && job.settings?.geminiRefusalFallbackEnabled === true) {
          job.lastBatchError = "content_refused";
          return enqueueParallelRefusal(job, message);
        }
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
          core.materializeSafetyFallbackItems(
            validation.items.map((item) => ({ ...item, origin: "ai" })), expectedBlocks
          ), expectedBlocks
        );
        return saveCompletedBatch(job, items, {
          providerTabDisposition: message.providerTabDisposition,
          requestId: message.requestId,
          stableMs: message.stableMs,
          resumeWebAfterFallback: refusalApiFallback
        });
      }
      if (refusalApiFallback) {
        return retryRefusalApiFallback(job, validation.reason || (outcomeCode !== "ok" ? outcomeCode : "invalid_response"));
      }
      return recoverBatch(job, validation.reason || (outcomeCode !== "ok" ? outcomeCode : "invalid_response"));
    }

    async function detachRefusedWebSlot(job) {
      const oldTabId = job.providerTabId;
      const oldSlotId = job.poolSlotId;
      await sendToTab(oldTabId, {
        type: "STVAI_PROVIDER_CANCEL",
        jobId: job.id,
        requestId: job.activeRequestId
      });
      let slot = null;
      await withPoolLock(async () => {
        slot = warmPool.slots.find(candidate => candidate.slotId === oldSlotId && candidate.jobId === job.id) || null;
        if (!slot) return;
        slot.state = "recovering";
        slot.jobId = "";
        slot.errorCode = "temporary_session_lost";
        slot.recoveryJobId = createId("setup-recovery");
        slot.recoveryCancelled = false;
        slot.recoveryStage = "clear_owned_prompt";
        await persistPool();
      });
      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      if (slot && typeof recoverGeminiSlotInPlace === "function") {
        void recoverGeminiSlotInPlace(slot, warmPool.settings || job.settings);
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab({ ...job, providerTabId: oldTabId, poolSlotId: "" });
      }
      await notifyPoolStatus();
    }

    async function startRefusalApiFallback(job, message) {
      const batchId = batchIdAt(job.batchIndex);
      job.refusalApiBatchIds ||= new Set();
      if (!job.refusalApiBatchIds.has(batchId)
        && job.refusalApiBatchIds.size >= REFUSAL_API_BATCH_LIMIT) {
        return pause(job, "refusal_fallback_limit_reached");
      }
      const requestId = String(message.requestId || job.activeRequestId || "");
      if (!/^batch_\d+_\d{4}$/.test(requestId)) return pause(job, "invalid_response");
      job.refusalApiBatchIds.add(batchId);
      job.refusalApiPending = true;
      job.refusalApiRequestId = requestId;
      job.refusalApiAttempts = 0;
      job.activeRequestId = requestId;
      job.unsentRequestId = "";
      job.pending = false;
      job.workState = "queued";
      await persistJob(job);
      await notifyStatus(job, "running", "refusal_api_fallback");
      await detachRefusedWebSlot(job);
      if (job.status !== "running" || job.activeRequestId !== requestId) {
        return { ok: false, reason: "not-runnable" };
      }
      return dispatchRefusalFallbackApi(job);
    }

    async function runGeminiRefusalRescue(job) {
      const slot = job.poolSlotId
        ? warmPool.slots.find(candidate => candidate.slotId === job.poolSlotId && candidate.jobId === job.id)
        : null;
      if (!slot || !Number.isInteger(job.providerTabId)) return pause(job, "provider_unavailable");
      const rescuePrompt = core.createRefusalSetupPrompt?.(job.settings);
      if (!rescuePrompt) return startRefusalApiFallback(job, { requestId: job.activeRequestId });
      const refusedRequestId = job.unsentRequestId || job.activeRequestId;
      job.refusalRescueActive = true;
      job.refusalRescueOutcome = "pending";
      job.workState = "queued";
      job.pending = false;
      await notifyStatus(job, "running", "refusal_system2_rescue");
      const restarted = await restartLeasedGeminiSlot(slot, job.settings, {
        timeoutMs: warmTemporaryTimeoutMs,
        suppressAutomaticReplacement: true,
        setupPrompts: [rescuePrompt],
        setupParts: ["introduction"],
        setupMarkers: { introduction: core.REFUSAL_READY_MARKER }
      });
      if (!restarted || job.status !== "running") {
        job.refusalRescueActive = false;
        job.refusalRescueOutcome = "api_fallback";
        return startRefusalApiFallback(job, { requestId: refusedRequestId });
      }
      // Rebuilding Temporary Chat creates fresh READY evidence for this same
      // physical tab. The rescued batch must require that new evidence; keeping
      // the lease's old warmSessionId makes the content script reject the batch
      // as warm_session_mismatch before it can click Send.
      job.warmSessionId = String(slot.warmSessionId || "");
      job.settingsHash = String(slot.settingsHash || "");
      job.unsentRequestId = refusedRequestId;
      job.activeRequestId = "";
      job.batchAttempts = Math.max(0, (job.batchAttempts || 0) - 1);
      job.refusalRescueOutcome = "ready";
      await persistJob(job);
      await notifyStatus(job, "running", "refusal_system2_ready");
      return dispatchCurrent(job);
    }

    function rescueLaneSlot(job) {
      const lane = job.rescueLane;
      if (!lane?.slotId) return null;
      return warmPool.slots.find((candidate) => candidate.slotId === lane.slotId
        && candidate.jobId === job.id && candidate.laneRole === "rescue") || null;
    }

    async function ensureParallelRescueReady(job) {
      const lane = job.rescueLane;
      const slot = rescueLaneSlot(job);
      if (!lane || !slot || !Number.isInteger(lane.providerTabId)) return false;
      if (lane.ready && lane.warmSessionId === slot.warmSessionId
        && lane.settingsHash === slot.settingsHash) return true;
      // A worker can disappear after System Prompt 2 reaches READY but before
      // its reset continuation records the lane identity. Reuse that verified
      // one-step rescue chat; restarting a READY slot would fail and strand the
      // refused batch even though the same physical tab is prepared.
      if (slot.state === "ready" && slot.laneRole === "rescue"
        && await verifyPreparedSlot(slot)) {
        let adopted = false;
        await withPoolLock(async () => {
          if (slot.state !== "ready" || slot.jobId !== job.id || job.rescueLane !== lane) return;
          slot.state = "leased";
          lane.warmSessionId = String(slot.warmSessionId || "");
          lane.settingsHash = String(slot.settingsHash || "");
          lane.ready = true;
          lane.batchUseCount = 0;
          job.refusalRescueOutcome = "ready";
          await persistPool();
          await persistJob(job);
          adopted = true;
        });
        if (adopted) {
          await notifyStatus(job, "running", "refusal_system2_ready");
          return true;
        }
      }
      const rescuePrompt = core.createRefusalSetupPrompt?.(job.settings);
      if (!rescuePrompt) return false;
      lane.ready = false;
      refreshParallelStatus(job);
      await notifyStatus(job, "running", "refusal_system2_rescue");
      const restarted = await restartLeasedGeminiSlot(slot, job.settings, {
        timeoutMs: warmTemporaryTimeoutMs,
        suppressAutomaticReplacement: true,
        setupPrompts: [rescuePrompt],
        setupParts: ["introduction"],
        setupMarkers: { introduction: core.REFUSAL_READY_MARKER }
      });
      if (!restarted || ["cancelled", "completed", "paused"].includes(job.status)) return false;
      slot.laneRole = "rescue";
      slot.jobId = job.id;
      lane.providerTabId = slot.providerTabId;
      lane.warmSessionId = String(slot.warmSessionId || "");
      lane.settingsHash = String(slot.settingsHash || "");
      lane.ready = true;
      lane.batchUseCount = 0;
      job.refusalRescueOutcome = "ready";
      refreshParallelStatus(job);
      await persistPool();
      await notifyStatus(job, "running", "refusal_system2_ready");
      return true;
    }

    function rescueProviderMessage(job, task) {
      const lane = job.rescueLane;
      const blocks = job.batches[task.batchIndex] || [];
      return {
        type: "STVAI_PROVIDER_SEND",
        phase: "batch",
        lane: "rescue",
        jobId: job.id,
        batchId: batchIdAt(task.batchIndex),
        requestId: task.requestId,
        expectedIds: blocks.map((block) => block.id),
        recovery: true,
        batchAttempt: Math.max(1, task.attempts + 1),
        prompt: core.createBatchPrompt({
          jobId: job.id,
          batchId: batchIdAt(task.batchIndex),
          requestId: task.requestId,
          responseId: task.requestId,
          batchIndex: task.batchIndex,
          totalBatches: job.batches.length,
          blocks,
          settings: job.settings,
          retryReason: "content_refused"
        }),
        sendTimeoutMs: 30_000,
        timeoutMs: 60_000,
        temporaryChat: job.settings.temporaryChat,
        requiredWarmSessionId: lane?.warmSessionId || "",
        requiredSettingsHash: lane?.settingsHash || ""
      };
    }

    async function maybeFinishParallelJob(job) {
      if (["cancelled", "completed", "paused"].includes(job.status)) return false;
      if (job.completed.size !== job.batches.length || job.rescueLane?.current
        || rescueQueueDepth(job) || job.rescueApiActive || job.rescueApiQueue?.length) return false;
      await completeJob(job, false);
      return true;
    }

    async function releaseParallelRescueLane(job, options = {}) {
      const lane = job.rescueLane;
      if (!lane) return true;
      const slot = rescueLaneSlot(job);
      if (!slot) {
        job.rescueLane = null;
        return true;
      }
      if (options.promoteToNormal === true) {
        const restarted = await restartLeasedGeminiSlot(slot, job.settings, {
          timeoutMs: warmTemporaryTimeoutMs
        });
        if (!restarted) return false;
        slot.laneRole = "normal";
        slot.jobId = job.id;
        job.providerTabId = slot.providerTabId;
        job.poolSlotId = slot.slotId;
        job.warmSessionId = String(slot.warmSessionId || "");
        job.settingsHash = String(slot.settingsHash || "");
        job.rescueLane = null;
        job.status = "running";
        job.pauseReason = "";
        await persistPool();
        await persistJob(job);
        return true;
      }
      const restarted = await restartLeasedGeminiSlot(slot, job.settings, {
        timeoutMs: warmTemporaryTimeoutMs
      });
      if (restarted) {
        slot.state = "ready";
        slot.jobId = "";
        slot.laneRole = "";
        slot.errorCode = "";
        slot.firstBatchDispatchedAt = 0;
      } else {
        slot.state = "recovering";
        slot.jobId = "";
        slot.laneRole = "";
        slot.errorCode = "temporary_session_lost";
        slot.recoveryJobId ||= createId("setup-recovery");
        slot.recoveryStage = "clear_owned_prompt";
        void recoverGeminiSlotInPlace(slot, warmPool.settings || job.settings);
      }
      job.rescueLane = null;
      await persistPool();
      await notifyPoolStatus();
      void drainWarmWaiters();
      return restarted;
    }

    async function resumeParallelNormalLane(job) {
      if (["cancelled", "completed", "paused"].includes(job.status)) return;
      if (job.parallelPauseReason) return;
      if (ensureParallelBatchState(job).some((state) => state === "normal_inflight")) return;
      if (job.refusalApiBatchIds?.size >= REFUSAL_API_BATCH_LIMIT
        && job.completed.size < job.batches.length) {
        return pause(job, "refusal_fallback_limit_reached");
      }
      if (rescueQueueDepth(job) >= REFUSAL_RESCUE_QUEUE_LIMIT) {
        if (job.rescueLane && !job.rescueLane.running) void runParallelRescueLane(job);
        return;
      }
      job.batchIndex = nextNormalBatchIndex(job, job.batchIndex);
      if (job.batchIndex >= job.batches.length) {
        await maybeFinishParallelJob(job);
        return;
      }
      job.normalBackpressure = false;
      if (!job.poolSlotId || !Number.isInteger(job.providerTabId)) {
        job.status = "running";
        const acquired = await acquireWarmSlot(job);
        if (job.poolSlotId && Number.isInteger(job.providerTabId)) return;
        if (!acquired || (!job.rescueLane?.current && rescueQueueDepth(job) === 0)) {
          warmPool.waiters = warmPool.waiters.filter((jobId) => jobId !== job.id);
          if (await releaseParallelRescueLane(job, { promoteToNormal: true })) {
            await advance(job);
          }
        }
        return;
      }
      if (!job.pending && job.workState !== "sending") await advance(job);
    }

    async function processParallelRescueResult(job, task, message) {
      const lane = job.rescueLane;
      if (!lane || lane.current !== task || ["cancelled", "completed", "paused"].includes(job.status)) {
        return { ok: false, reason: "stale-provider-response" };
      }
      if (message.requestId && message.requestId !== task.requestId) {
        recordDispatch(job, "rescue", task, "rejected", { tabId: lane.providerTabId, reason: "stale_request" });
        return { ok: false, reason: "stale-request" };
      }
      if (String(message.outcomeCode || "") === "content_refused") {
        if ((task.system2Attempts || 0) < 2) {
          ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
          lane.current = null;
          removeDuplicateRescueTasks(job, task.batchIndex);
          lane.queue.unshift(task);
          lane.ready = false;
          recordDispatch(job, "rescue", task, "content_refused_retry", {
            tabId: lane.providerTabId, reason: "content_refused", outcomeCode: "content_refused"
          });
          await persistJob(job);
          await notifyStatus(job, "running", "refusal_system2_retry");
          return { ok: true, retry: true };
        }
        ensureParallelBatchState(job)[task.batchIndex] = "api_inflight";
        lane.current = null;
        job.refusalApiPending = true;
        job.refusalApiRequestId = task.requestId;
        lane.batchUseCount = Math.min(GEMINI_SESSION_BATCH_LIMIT, (lane.batchUseCount || 0) + 1);
        job.refusalRescueOutcome = "api_fallback";
        removeDuplicateRescueTasks(job, task.batchIndex);
        job.rescueApiQueue.push(task);
        recordDispatch(job, "rescue", task, "api_queued", {
          tabId: lane.providerTabId, reason: "system2_refused_twice", outcomeCode: "content_refused"
        });
        refreshParallelStatus(job);
        await notifyStatus(job, "running", "refusal_api_fallback");
        startParallelRescueApi(job);
        return { ok: true, apiFallback: true };
      }
      const blocks = job.batches[task.batchIndex] || [];
      const validation = core.validateTranslationResponse(message.text, {
        jobId: job.id,
        batchId: batchIdAt(task.batchIndex),
        requestId: task.requestId,
        expectedIds: blocks.map((block) => block.id),
        allowBare: false
      });
      const contentValidation = validation.ok
        ? (core.validateTranslationItems?.(validation.items, blocks)
          || core.validateApiTranslationItems?.(validation.items, blocks)
          || { ok: true })
        : { ok: false, reason: validation.reason || "invalid_response" };
      if (!validation.ok || !contentValidation.ok) {
        task.attempts = Math.max(0, Number(task.attempts) || 0) + 1;
        if ((task.system2Attempts || 0) < 2) {
          ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
          lane.current = null;
          removeDuplicateRescueTasks(job, task.batchIndex);
          lane.queue.unshift(task);
          lane.ready = false;
          recordDispatch(job, "rescue", task, "invalid_response_retry", {
            tabId: lane.providerTabId, reason: contentValidation.reason || validation.reason || "invalid_response"
          });
          await persistJob(job);
          await notifyStatus(job, "running", "refusal_system2_retry");
          return { ok: true, retry: true };
        }
        ensureParallelBatchState(job)[task.batchIndex] = "api_inflight";
        lane.current = null;
        job.refusalApiPending = true;
        job.refusalApiRequestId = task.requestId;
        job.refusalRescueOutcome = "api_fallback";
        removeDuplicateRescueTasks(job, task.batchIndex);
        job.rescueApiQueue.push(task);
        recordDispatch(job, "rescue", task, "api_queued", {
          tabId: lane.providerTabId, reason: "system2_invalid_twice"
        });
        await notifyStatus(job, "running", "refusal_api_fallback");
        startParallelRescueApi(job);
        return { ok: true, apiFallback: true };
      }
      const items = core.filterTranslationItems(
        core.materializeSafetyFallbackItems(
          validation.items.map((item) => ({ ...item, origin: "ai" })), blocks
        ), blocks
      );
      const slot = rescueLaneSlot(job);
      await commitBatchAt(job, task.batchIndex, items, slot);
      recordDispatch(job, "rescue", task, "response_received", {
        tabId: lane.providerTabId, outcomeCode: String(message.outcomeCode || "ok")
      });
      lane.current = null;
      lane.batchUseCount = Math.min(GEMINI_SESSION_BATCH_LIMIT, (lane.batchUseCount || 0) + 1);
      job.refusalRescueOutcome = "succeeded";
      await errorJournal?.append?.(`${job.id}:${task.batchIndex}`, {
        kind: "batch_recovered", provider: job.provider, phase: diagnosticPhase(job),
        batchIndex: task.batchIndex, batchAttempt: task.attempts + 1,
        outcome: "recovered", onlyExisting: true
      });
      await notifyStatus(job, "running", "refusal_system2_succeeded");
      return { ok: true, accepted: true };
    }

    async function runParallelRescueLane(job) {
      const lane = job.rescueLane;
      if (!lane || lane.running || ["cancelled", "completed", "paused"].includes(job.status)) return;
      lane.running = true;
      try {
        while (job.rescueLane === lane && !["cancelled", "completed", "paused"].includes(job.status)) {
          if (!lane.current) lane.current = lane.queue.shift() || null;
          if (!lane.current) {
            refreshParallelStatus(job);
            await persistJob(job);
            await resumeParallelNormalLane(job);
            await maybeFinishParallelJob(job);
            break;
          }
          if (!lane.ready || lane.batchUseCount >= GEMINI_SESSION_BATCH_LIMIT) {
            if (!await ensureParallelRescueReady(job)) {
              const task = lane.current;
              lane.current = null;
              ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
              removeDuplicateRescueTasks(job, task.batchIndex);
              lane.queue.unshift(task);
              const slot = rescueLaneSlot(job);
              await pause(job, String(slot?.errorCode || "temporary_unavailable"));
              break;
            }
          }
          const task = lane.current;
          ensureParallelBatchState(job)[task.batchIndex] = "rescue_inflight";
          task.awaitingSystem2Response = true;
          recordDispatch(job, "rescue", task, "dispatch_started", { tabId: lane.providerTabId });
          refreshParallelStatus(job);
          await persistJob(job);
          const providerMessage = rescueProviderMessage(job, task);
          let response;
          try {
            response = await sendProviderMessage("gemini", lane.providerTabId, providerMessage);
          } catch (_error) {
            response = { ok: false, error: { code: "provider_unreachable" } };
          }
          if (!response || typeof response !== "object") {
            // Chrome can complete the content-script handler while the
            // service-worker side receives an empty receipt.  Do not leave the
            // rescue batch permanently in rescue_inflight: check the same tab
            // first, then retry the same request identity a bounded number of
            // times.  This preserves batchId/requestId and avoids a duplicate
            // logical batch after a transient channel loss.
            task.receiptAttempts = Math.max(0, Number(task.receiptAttempts) || 0) + 1;
            task.technicalRecoveryAttempts = Math.max(0, Number(task.technicalRecoveryAttempts) || 0) + 1;
            recordDispatch(job, "rescue", task, "response_missing", {
              tabId: lane.providerTabId, reason: "response_missing"
            });
            const status = await sendToTab(lane.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
            const providerBusy = status?.state?.operation?.active === true;
            if (providerBusy && task.receiptAttempts < 3) {
              await retrySleep(Math.min(retryDelayMs, 500));
              continue;
            }
            ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
            lane.current = null;
            if (task.receiptAttempts >= 3) {
              removeDuplicateRescueTasks(job, task.batchIndex);
              lane.queue.unshift(task);
              await pause(job, "response_receipt_missing");
              break;
            }
            removeDuplicateRescueTasks(job, task.batchIndex);
            lane.queue.unshift(task);
            await notifyStatus(job, "running", "response_missing");
            await persistJob(job);
            await retrySleep(Math.min(retryDelayMs, 500));
            continue;
          }
          if (!("response" in response || response.ok === false)) {
            task.technicalRecoveryAttempts = Math.max(0, Number(task.technicalRecoveryAttempts) || 0) + 1;
            recordDispatch(job, "rescue", task, "rejected", {
              tabId: lane.providerTabId, reason: "response_receipt_missing"
            });
            ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
            lane.current = null;
            if (task.technicalRecoveryAttempts >= 3) {
              removeDuplicateRescueTasks(job, task.batchIndex);
              lane.queue.unshift(task);
              await pause(job, "response_receipt_missing");
              break;
            }
            removeDuplicateRescueTasks(job, task.batchIndex);
            lane.queue.unshift(task);
            await notifyStatus(job, "running", "response_missing");
            continue;
          }
          if (response.ok === false) {
            const code = String(response.error?.code || "provider_unavailable");
            if (code === "gemini_1095" && job.settings.geminiAccountRotationEnabled === true) {
              const recovered = await recoverGemini1095Slot(rescueLaneSlot(job), job.settings, {
                shouldStop: () => job.rescueLane !== lane || ["cancelled", "paused", "completed"].includes(job.status),
                setupPrompts: [core.createRefusalSetupPrompt(job.settings)],
                setupParts: ["introduction"],
                setupMarkers: { introduction: core.REFUSAL_READY_MARKER },
                onAccountRecovery: decision => notifyStatus(job, "running", decision.action === "rotated" ? "gemini_account_rotated" : "gemini_1095_retry")
              });
              if (!recovered) {
                lane.current = null;
                task.awaitingSystem2Response = false;
                ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
                removeDuplicateRescueTasks(job, task.batchIndex);
                lane.queue.unshift(task);
                await pause(job, rescueLaneSlot(job)?.errorCode || code);
                break;
              }
              const slot = rescueLaneSlot(job);
              lane.ready = true;
              lane.warmSessionId = slot.warmSessionId;
              lane.settingsHash = slot.settingsHash;
              lane.batchUseCount = 0;
              await persistJob(job);
              continue;
            }
            task.technicalRecoveryAttempts = Math.max(0, Number(task.technicalRecoveryAttempts) || 0) + 1;
            recordDispatch(job, "rescue", task, "rejected", {
              tabId: lane.providerTabId, reason: code
            });
            if (["captcha", "login_required", "security_verification", "ui_changed", "provider_unreachable"].includes(code)) {
              ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
              lane.current = null;
              removeDuplicateRescueTasks(job, task.batchIndex);
              lane.queue.unshift(task);
              await pause(job, code);
              break;
            }
            ensureParallelBatchState(job)[task.batchIndex] = "rescue_queued";
            lane.current = null;
            if (task.technicalRecoveryAttempts >= 3) {
              removeDuplicateRescueTasks(job, task.batchIndex);
              lane.queue.unshift(task);
              await pause(job, code);
              break;
            }
            removeDuplicateRescueTasks(job, task.batchIndex);
            lane.queue.unshift(task);
            lane.ready = false;
            continue;
          }
          if (task.awaitingSystem2Response === true) {
            task.system2Attempts = Math.min(2, Math.max(0, Number(task.system2Attempts) || 0) + 1);
            task.awaitingSystem2Response = false;
          }
          await processParallelRescueResult(job, task, {
            ...providerMessage,
            text: response.response,
            outcomeCode: response.outcomeCode || "ok"
          });
          await resumeParallelNormalLane(job);
          if (job.refusalApiBatchIds?.size >= REFUSAL_API_BATCH_LIMIT
            && job.completed.size < job.batches.length
            && job.status === "waiting-provider") {
            await pause(job, "refusal_fallback_limit_reached");
          }
        }
      } finally {
        lane.running = false;
        refreshParallelStatus(job);
        await persistJob(job);
      }
    }

    function startParallelRescueApi(job) {
      if (job.rescueApiPromise) return job.rescueApiPromise;
      const runPromise = runParallelRescueApi(job);
      const trackedPromise = runPromise.finally(() => {
        if (job.rescueApiPromise === trackedPromise) job.rescueApiPromise = null;
      });
      job.rescueApiPromise = trackedPromise;
      return trackedPromise;
    }

    async function runParallelRescueApi(job) {
      if (job.rescueApiRunning || ["cancelled", "completed", "paused"].includes(job.status)) return;
      job.rescueApiRunning = true;
      try {
        while (job.rescueApiQueue.length && !["cancelled", "completed", "paused"].includes(job.status)) {
          const task = job.rescueApiQueue.shift();
          job.rescueApiActive = task;
          job.refusalApiPending = true;
          job.refusalApiRequestId = task.requestId;
          if (!job.refusalApiBatchIds.has(batchIdAt(task.batchIndex))
            && job.refusalApiBatchIds.size >= REFUSAL_API_BATCH_LIMIT) {
            ensureParallelBatchState(job)[task.batchIndex] = "api_inflight";
            job.rescueApiQueue.unshift(task);
            job.rescueApiActive = null;
            await pauseParallelAfterNormalSettles(job, "refusal_fallback_limit_reached");
            break;
          }
          job.refusalApiBatchIds.add(batchIdAt(task.batchIndex));
          const apiKey = await loadApiKey("gemini_api");
          if (!apiKey.trim()) {
            ensureParallelBatchState(job)[task.batchIndex] = "api_inflight";
            job.rescueApiQueue.unshift(task);
            job.rescueApiActive = null;
            await persistJob(job);
            await pauseParallelAfterNormalSettles(job, "api_key_missing");
            break;
          }
          const blocks = job.batches[task.batchIndex] || [];
          const messages = core.createRefusalFallbackMessages({
            responseId: task.requestId,
            blocks,
            settings: job.settings,
            retryReason: "content_refused"
          });
          let accepted = false;
          for (let attempt = 0; attempt < REFUSAL_API_ATTEMPT_LIMIT && !accepted; attempt += 1) {
            const controller = new AbortController();
            job.rescueApiAbortController = controller;
            try {
          const response = await apiClient.translate({
                provider: "gemini_api", apiKey,
                model: String(job.settings?.geminiApiModel || core.DEFAULT_SETTINGS.geminiApiModel),
                safetyOff: true, temperature: job.apiTemperatureFallback ? undefined : job.settings.apiTemperature,
                system: messages.system, user: messages.user, signal: controller.signal
              });
              const extracted = core.extractExpectedBatchResponse(response.text, task.requestId);
              const validation = core.validateTranslationResponse(extracted.ok ? extracted.text : response.text, {
                jobId: job.id,
                batchId: batchIdAt(task.batchIndex),
                requestId: task.requestId,
                expectedIds: blocks.map((block) => block.id),
                allowBare: true
              });
              const contentValidation = validation.ok
                ? (core.validateApiTranslationItems?.(validation.items, blocks)
                  || core.validateTranslationItems?.(validation.items, blocks)
                  || { ok: true })
                : { ok: false, reason: validation.reason || extracted.reason || response.outcomeCode || "invalid_response" };
              if (!validation.ok || !contentValidation.ok || response.outcomeCode === "content_refused") {
                if (attempt + 1 >= REFUSAL_API_ATTEMPT_LIMIT) {
                  throw Object.assign(new Error("refusal API failed"), {
                    code: response.outcomeCode === "content_refused"
                      ? "refusal_api_content_refused" : contentValidation.reason
                  });
                }
                continue;
              }
              const items = core.filterTranslationItems(
                core.materializeSafetyFallbackItems(
                  validation.items.map((item) => ({ ...item, origin: "ai" })), blocks
                ), blocks
              );
              await commitBatchAt(job, task.batchIndex, items, null, { apiUsed: true });
              accepted = true;
            } catch (error) {
              if (controller.signal.aborted || ["cancelled", "completed"].includes(job.status)) break;
              if (attempt + 1 >= REFUSAL_API_ATTEMPT_LIMIT) {
                ensureParallelBatchState(job)[task.batchIndex] = "api_inflight";
                job.rescueApiQueue.unshift(task);
                job.rescueApiActive = null;
                await persistJob(job);
                await pauseParallelAfterNormalSettles(
                  job,
                  typeof error?.code === "string" ? error.code : "provider_unavailable"
                );
              } else await retrySleep(retryDelayMs);
            } finally {
              if (job.rescueApiAbortController === controller) job.rescueApiAbortController = null;
            }
          }
          if (job.parallelPauseReason) break;
          job.rescueApiActive = null;
          if (!job.rescueApiQueue.length) {
            job.refusalApiPending = false;
            job.refusalApiRequestId = "";
          }
          refreshParallelStatus(job);
          await persistJob(job);
          await resumeParallelNormalLane(job);
          await maybeFinishParallelJob(job);
        }
      } finally {
        job.rescueApiRunning = false;
        job.rescueApiActive = null;
        refreshParallelStatus(job);
        await persistJob(job);
      }
    }

    async function enqueueParallelRefusal(job, message) {
      const batchIndex = job.batchIndex;
      const requestId = String(message.requestId || job.activeRequestId || "");
      if (!/^batch_\d+_\d{4}$/.test(requestId)) return pause(job, "invalid_response");
      ensureParallelBatchState(job)[batchIndex] = "rescue_queued";
      const task = safeLaneTask(batchIndex, requestId);
      const firstRefusal = !job.rescueLane;
      if (firstRefusal) {
        const slot = job.poolSlotId
          ? warmPool.slots.find(candidate => candidate.slotId === job.poolSlotId && candidate.jobId === job.id)
          : null;
        if (!slot || !Number.isInteger(job.providerTabId)) return runGeminiRefusalRescue(job);
        slot.laneRole = "rescue";
        job.rescueLane = {
          slotId: slot.slotId,
          providerTabId: slot.providerTabId,
          warmSessionId: "",
          settingsHash: "",
          ready: false,
          batchUseCount: 0,
          current: null,
          queue: [task],
          running: false
        };
        job.providerTabId = null;
        job.poolSlotId = "";
        job.warmSessionId = "";
        job.settingsHash = "";
      } else {
        if (rescueTaskExists(job, batchIndex)) return { ok: true, duplicate: true };
        if (rescueQueueDepth(job) >= REFUSAL_RESCUE_QUEUE_LIMIT) {
          return pause(job, "refusal_queue_full");
        }
        job.rescueLane.queue.push(task);
      }
      job.refusalRescueAttempted = true;
      job.refusalRescueActive = false;
      job.refusalRescueOutcome = "pending";
      job.pending = false;
      job.workState = "queued";
      job.activeRequestId = "";
      job.unsentRequestId = "";
      job.batchAttempts = 0;
      job.batchIndex = nextNormalBatchIndex(job, batchIndex + 1);
      refreshParallelStatus(job);
      await persistPool();
      await notifyStatus(job, "running", "refusal_parallel_started");
      const apiRunningBefore = job.rescueApiRunning === true;
      const rescueRun = runParallelRescueLane(job);
      if (job.rescueLane?.queue?.length) {
        // A refusal can arrive in the small gap where the rescue lane is
        // finishing its empty-queue pass. Recheck once after that pass so a
        // queued batch cannot remain stranded in rescue_queued.
        setTimeout(() => { void runParallelRescueLane(job); }, 0);
      }
      if (job.batchIndex < job.batches.length && rescueQueueDepth(job) < REFUSAL_RESCUE_QUEUE_LIMIT) {
        if (!job.poolSlotId) await acquireWarmSlot(job);
        else await advance(job);
      } else {
        job.normalBackpressure = true;
        await persistJob(job);
      }
      for (let pass = 0; pass < 12 && rescueQueueDepth(job) > 0
        && !["cancelled", "completed", "paused"].includes(job.status); pass += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
        await runParallelRescueLane(job);
      }
      // Keep direct callers (and the MV3 message response) informed when both
      // lanes can finish synchronously.  A provider that hands the result back
      // through a later content-script message still returns from its lane at
      // the pending boundary; the later message resumes the same lane.
      await rescueRun;
      // A normal-lane refusal can be discovered while the API worker is
      // already inside its own loop. Waiting on that same promise here would
      // deadlock the worker; its queue will be drained by the current loop.
      if (job.rescueApiPromise && !apiRunningBefore) await job.rescueApiPromise;
      return { ok: true, parallelRescue: true };
    }

    async function retryRefusalApiFallback(job, reason) {
      job.pending = false;
      job.workState = "queued";
      job.lastBatchError = String(reason || "invalid_response");
      if ((job.refusalApiAttempts || 0) >= REFUSAL_API_ATTEMPT_LIMIT) {
        return pause(job, job.lastBatchError);
      }
      await persistJob(job);
      await notifyStatus(job, "running", "refusal_api_retry");
      await retrySleep(retryDelayMs);
      if (job.status !== "running") return { ok: false, reason: "not-runnable" };
      return dispatchRefusalFallbackApi(job);
    }

    async function dispatchRefusalFallbackApi(job) {
      if (!job.refusalApiPending || job.status !== "running" || !apiClient?.translate) {
        return pause(job, apiClient?.translate ? "not-runnable" : "api_client_unavailable");
      }
      const requestId = String(job.refusalApiRequestId || job.activeRequestId || "");
      const batchId = batchIdAt(job.batchIndex);
      if (!/^batch_\d+_\d{4}$/.test(requestId)) return pause(job, "invalid_response");
      const apiKey = await loadApiKey("gemini_api");
      if (job.status !== "running" || !job.refusalApiPending || job.activeRequestId !== requestId) {
        return { ok: false, reason: "not-runnable" };
      }
      if (!apiKey.trim()) return pause(job, "api_key_missing");
      const blocks = currentWorkBlocks(job);
      const messages = core.createRefusalFallbackMessages({
        responseId: requestId,
        blocks,
        settings: job.settings,
        retryReason: job.lastBatchError
      });
      const controller = new AbortController();
      job.apiAbortController?.abort();
      job.apiAbortController = controller;
      job.pending = true;
      job.workState = "sending";
      job.refusalApiAttempts = Math.max(0, Number(job.refusalApiAttempts) || 0) + 1;
      await persistJob(job);
      try {
        const response = await apiClient.translate({
          provider: "gemini_api",
          apiKey,
          model: job.settings.geminiApiModel,
          safetyOff: true,
          temperature: job.apiTemperatureFallback ? undefined : job.settings.apiTemperature,
          system: messages.system,
          user: messages.user,
          signal: controller.signal
        });
        if (job.status !== "running" || !job.refusalApiPending
          || job.activeRequestId !== requestId || job.apiAbortController !== controller) {
          return { ok: false, reason: "stale-provider-response" };
        }
        job.pending = false;
        job.apiAbortController = null;
        const extracted = core.extractExpectedBatchResponse(response.text, requestId);
        if (!extracted.ok) return retryRefusalApiFallback(job, extracted.reason);
        return processProviderResult(job, {
          phase: "batch",
          jobId: job.id,
          batchId,
          requestId,
          text: extracted.text,
          outcomeCode: response.outcomeCode || "ok",
          refusalApiFallback: true
        }, true);
      } catch (error) {
        if (job.status !== "running" || !job.refusalApiPending
          || job.activeRequestId !== requestId || job.apiAbortController !== controller
          || error?.code === "request_cancelled") {
          return { ok: false, reason: "stale-provider-response" };
        }
        job.pending = false;
        job.apiAbortController = null;
        const code = typeof error?.code === "string" ? error.code : "provider_error";
        if (["network_error", "provider_unavailable", "rate_limited", "response_timeout", "incomplete_response", "empty_response"].includes(code)) {
          return retryRefusalApiFallback(job, code === "empty_response" ? "incomplete_response" : code);
        }
        if (code === "content_refused") return pause(job, "refusal_api_content_refused");
        return pause(job, code);
      } finally {
        if (job.apiAbortController === controller) {
          job.pending = false;
          job.apiAbortController = null;
        }
      }
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
          retryReason: job.batchAttempts > 1 ? job.lastBatchError : "",
          refusalSanitize: job.refusalSanitizeAttempted === true
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
      if (reason === "gemini_1095" && job.provider === "gemini"
        && job.settings.geminiAccountRotationEnabled === true) {
        const requestId = job.unsentRequestId || job.activeRequestId;
        const slot = findPoolSlotByTab(job.providerTabId);
        job.pending = false;
        job.workState = "queued";
        job.unsentRequestId = requestId;
        await persistJob(job);
        const recovered = await recoverGemini1095Slot(slot, job.settings, {
          shouldStop: () => job.status !== "running" || job.providerTabId !== slot?.providerTabId,
          onAccountRecovery: decision => notifyStatus(job, "running", decision.action === "rotated" ? "gemini_account_rotated" : "gemini_1095_retry")
        });
        if (job.status !== "running") return { ok: false, reason: "not-runnable" };
        if (!recovered) return pause(job, slot?.errorCode || reason);
        job.warmSessionId = slot.warmSessionId;
        job.settingsHash = slot.settingsHash;
        await persistJob(job);
        return dispatchCurrent(job);
      }
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
          return handoffGeminiBatch(job, reason);
        }
        if (reason === "send_not_confirmed" && job.provider === "gemini" && job.unsentRequestId) {
          return handoffGeminiBatch(job, reason);
        }
        if (reason === "send_not_confirmed" && ["gemini", "chatgpt"].includes(job.provider)
          && job.unsentRequestId
          && (job.sendNotConfirmedAttempts || 0) < (job.provider === "gemini"
            ? GEMINI_SEND_NOT_CONFIRMED_RETRIES : 1)) {
          job.sendNotConfirmedAttempts = (job.sendNotConfirmedAttempts || 0) + 1;
          job.workState = "queued";
          await notifyStatus(job, "running", "rechecking_send");
          await retrySleep(retryDelayMs);
          if (job.status !== "running") return { ok: false, reason: "not-runnable" };
          return dispatchCurrent(job);
        }
        if (reason === "send_not_confirmed" && job.provider === "gemini"
          && job.unsentRequestId && (job.sendNotConfirmedAttempts || 0) >= GEMINI_SEND_NOT_CONFIRMED_RETRIES
          && (job.sendNotConfirmedAttempts || 0) === GEMINI_SEND_NOT_CONFIRMED_RETRIES) {
          // The same marker was rejected repeatedly. Retire this Gemini
          // conversation once, then let the normal warm-pool path open a
          // fresh Temporary Chat. A later failure pauses instead of looping.
          job.sendNotConfirmedAttempts += 1;
          await persistJob(job);
          return recoverLostGeminiTemporaryChat(job);
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

    async function handoffGeminiBatch(job, reason) {
      if (job.status !== "running" || job.provider !== "gemini") {
        return { ok: false, reason: "not-runnable" };
      }
      const requestId = job.unsentRequestId || job.activeRequestId;
      const oldSlotId = job.poolSlotId;
      const oldTabId = job.providerTabId;
      const incidentKey = `${job.id}:${job.batchIndex}`;
      job.recoveryStage = "handoff_batch";
      job.recoveryExcludedSlotId = oldSlotId || "";
      job.workState = "queued";
      job.pending = false;
      job.batchSwitched = true;
      await notifyStatus(job, "running", "switching_batch_tab");
      if (job.status !== "running") return { ok: false, reason: "not-runnable" };
      await sendToTab(oldTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id, requestId });
      let failedSlot = null;
      await withPoolLock(async () => {
        failedSlot = warmPool.slots.find(candidate => (
          candidate.slotId === oldSlotId && candidate.jobId === job.id
        ));
        if (!failedSlot) return;
        // Keep the physical tab alive, but make it unavailable to the pool while
        // its Temporary Chat is rebuilt in the background.
        failedSlot.state = "recovering";
        failedSlot.jobId = "";
        failedSlot.recoveryJobId = job.id;
        failedSlot.recoveryCancelled = false;
        failedSlot.errorCode = reason;
        failedSlot.recoveryAttempts = Math.max(0, Number(failedSlot.recoveryAttempts) || 0) + 1;
        job.providerTabId = null;
        job.poolSlotId = "";
        job.warmSessionId = "";
        job.settingsHash = "";
        job.activeRequestId = "";
        job.unsentRequestId = requestId;
        await persistPool();
      });
      if (!failedSlot) {
        job.providerTabId = null;
        job.poolSlotId = "";
      }
      await errorJournal?.append?.(incidentKey, {
        kind: "batch_handoff",
        provider: "gemini",
        phase: diagnosticPhase(job),
        batchIndex: job.batchIndex,
        errorCode: reason,
        recoveryStage: job.recoveryStage,
        tabRetained: Boolean(failedSlot),
        outcome: "still_running"
      });
      await persistJob(job);
      if (failedSlot && typeof recoverGeminiSlotInPlace === "function") {
        void recoverGeminiSlotInPlace(failedSlot, warmPool.settings || job.settings);
      }
      if (!await acquireRecoverySlot(job)) return pause(job, "provider_unavailable");
      return { ok: true, switched: true };
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
      job.recoveryExcludedSlotId = oldSlotId || "";
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

      if (slot) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(slot) || slot.jobId !== job.id) return;
          // A busy timeout means the conversation is stuck, not that the
          // physical tab is unusable. Keep it visible and recover it in place
          // while the unchanged request is handed to another READY slot.
          slot.state = "recovering";
          slot.jobId = "";
          slot.errorCode = "provider_busy_timeout";
          slot.recoveryJobId = job.id;
          slot.recoveryCancelled = false;
          job.providerTabId = null;
          job.poolSlotId = "";
          job.warmSessionId = "";
          job.settingsHash = "";
          job.activeRequestId = "";
          await persistPool();
        });
        void recoverGeminiSlotInPlace?.(slot, warmPool.settings || job.settings);
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab(job);
        job.providerTabId = null;
        job.poolSlotId = "";
        job.warmSessionId = "";
        job.settingsHash = "";
        job.activeRequestId = "";
      }
      job.unsentRequestId = requestId;
      await persistJob(job);
      return acquireRecoverySlot(job);
    }

    async function recoverLostGeminiTemporaryChat(job) {
      const oldTabId = job.providerTabId;
      const oldSlotId = job.poolSlotId;
      const requestId = job.unsentRequestId || job.activeRequestId;
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

      if (slot && typeof restartLeasedGeminiSlot === "function") {
        const restarted = await restartLeasedGeminiSlot(slot, job.settings, {
          timeoutMs: warmTemporaryTimeoutMs
        });
        if (restarted && job.status === "running" && job.poolSlotId === slot.slotId) {
          job.providerTabId = slot.providerTabId;
          job.warmSessionId = slot.warmSessionId;
          job.settingsHash = slot.settingsHash;
          job.unsentRequestId = /^batch_\d+_\d{4}$/.test(requestId || "") ? requestId : "";
          job.activeRequestId = "";
          job.batchAttempts = Math.max(0, (job.batchAttempts || 0) - 1);
          resetStable(job);
          await persistJob(job);
          return dispatchCurrent(job);
        }
      }

      if (slot) {
        await withPoolLock(async () => {
          if (!warmPool.slots.includes(slot) || slot.jobId !== job.id) return;
          // Losing Temporary Chat is a conversation failure, not a physical
          // tab failure. Detach the batch, keep this tab unavailable to other
          // jobs and let the durable recovery loop open New chat + Temporary
          // Chat + READY 1/2 on this same tab.
          slot.state = "recovering";
          slot.jobId = "";
          slot.errorCode = "temporary_session_lost";
          slot.recoveryJobId ||= createId("setup-recovery");
          slot.recoveryCancelled = false;
          slot.recoveryStage = "clear_owned_prompt";
          job.providerTabId = null;
          job.poolSlotId = "";
          job.warmSessionId = "";
          job.settingsHash = "";
          await persistPool();
        });
        void recoverGeminiSlotInPlace?.(slot, warmPool.settings || job.settings);
      } else if (Number.isInteger(oldTabId)) {
        await closeLegacyProviderTab(job);
        if (Number.isInteger(job.providerTabId)) return pause(job, "provider_tab_close_failed");
      }

      job.providerTabId = null;
      job.poolSlotId = "";
      job.warmSessionId = "";
      job.settingsHash = "";
      // A 1095/Temporary reset restores the prompt before Gemini accepts it.
      // Keep the exact batch marker so a replacement tab retries the same
      // logical request instead of manufacturing a second request identity.
      job.unsentRequestId = /^batch_\d+_\d{4}$/.test(requestId || "") ? requestId : "";
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
        if (job.phase === "batch") {
          const state = ensureParallelBatchState(job)[job.batchIndex];
          if (state && !["pending", "normal_inflight"].includes(state)) {
            job.batchIndex = nextNormalBatchIndex(job, job.batchIndex);
            if (job.batchIndex >= job.batches.length) return maybeFinishParallelJob(job);
            if (job.workState !== "sending") return dispatchCurrent(job);
            return { ok: true, skipped: true, reason: "batch_not_pending" };
          }
        }
        if (job.workState === "sending") return { ok: false, reason: "request-in-flight" };
        const limit = canRotateBatch(job) ? 3 : 2;
        if ((job.batchAttempts || 0) >= limit && !job.unsentRequestId) return pause(job, "batch_recovery_exhausted");
      }
      if (job.phase !== "setup" && !currentBatch(job)) return completeJob(job, false);
      if (job.refusalApiPending === true) return dispatchRefusalFallbackApi(job);
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
      if (job.pending || job.status !== "running" || (job.phase !== "setup" && job.workState === "sending")) {
        return { ok: false, reason: "not-runnable" };
      }
      const providerMessage = currentProviderMessage(job);
      const providerTabId = job.providerTabId;
      if (slot && job.phase === "batch" && !slot.firstBatchDispatchedAt) {
        slot.firstBatchDispatchedAt = now();
        await persistPool();
      }
      if (job.phase === "batch" && job.batchIndex < job.batches.length) {
        ensureParallelBatchState(job)[job.batchIndex] = "normal_inflight";
        refreshParallelStatus(job);
      }
      const normalTask = job.phase === "batch" ? {
        batchIndex: job.batchIndex,
        requestId: String(providerMessage.requestId || ""),
        attempts: Math.max(0, Number(job.batchAttempts) || 0),
        system2Attempts: 0,
        technicalRecoveryAttempts: Math.max(0, Number(job.receiptMissingAttempts) || 0)
      } : null;
      if (normalTask?.requestId) recordDispatch(job, "normal", normalTask, "dispatch_started", { tabId: providerTabId });
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
      if (!response || typeof response !== "object") {
        // The provider handler may still be running even when tabs.sendMessage
        // returned no receipt. Recheck the exact request on the same physical
        // tab only; a missing channel acknowledgement must never rotate tabs.
        clearBusyState(job);
        job.receiptMissingAttempts = Math.max(0, Number(job.receiptMissingAttempts) || 0) + 1;
        if (normalTask) {
          normalTask.technicalRecoveryAttempts = job.receiptMissingAttempts;
          recordDispatch(job, "normal", normalTask, "response_missing", {
            tabId: providerTabId, reason: "response_missing"
          });
        }
        if (job.receiptMissingAttempts > 2) return pause(job, "response_receipt_missing");
        job.unsentRequestId = providerMessage.requestId;
        job.workState = "queued";
        await persistJob(job);
        await notifyStatus(job, "running", "response_missing");
        if (!job.receiptRetryTimer) {
          job.receiptRetryTimer = setTimeout(() => {
            job.receiptRetryTimer = null;
            if (job.status === "running" && job.providerTabId === providerTabId
              && job.activeRequestId === providerMessage.requestId && !job.pending) {
              void dispatchCurrent(job);
            }
          }, Math.min(retryDelayMs, 500));
          job.receiptRetryTimer?.unref?.();
        }
        return { ok: true, pendingExternalResult: true, reason: "response_receipt_missing" };
      }
      if (!("response" in response || response.ok === false)) {
        if (normalTask) recordDispatch(job, "normal", normalTask, "response_missing", {
          tabId: providerTabId, reason: "response_receipt_missing"
        });
        clearBusyState(job);
        return { ok: true, pendingExternalResult: true };
      }
      if (response.jobId && String(response.jobId) !== job.id) {
        return { ok: false, reason: "stale-provider-response" };
      }
      if (response.ok === false) {
        if (normalTask) recordDispatch(job, "normal", normalTask, "rejected", {
          tabId: providerTabId, reason: response.error?.code || "provider_error"
        });
        if (["send_not_confirmed", "ui_changed"].includes(response.error?.code)) {
          job.unsentRequestId = providerMessage.requestId;
        }
        return retryCurrent(job, response.error && response.error.code || "provider_error");
      }
      job.unsentRequestId = "";
      job.retryAttempts = 0;
      job.sendNotConfirmedAttempts = 0;
      job.receiptMissingAttempts = 0;
      if (normalTask) recordDispatch(job, "normal", normalTask, "response_received", {
        tabId: providerTabId, outcomeCode: response.outcomeCode || "ok"
      });
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
      job.parallelPauseReason = "";
      await notifyStatus(job, "running");
      await dispatchCurrent(job);
    }

    const pendingPrefetch = new Map();
    const prefetchStartFlights = new Map();
    const ttsStartFlights = new Map();

    function cancelPendingPrefetch(tabId, jobId) {
      for (const admission of pendingPrefetch.values()) {
        if (admission.tabId === tabId && (!jobId || admission.jobId === jobId)) admission.cancelled = true;
      }
    }

    function startJob(message, sender) {
      const prefetchFlightKey = message?.prefetch === true && Number.isInteger(sender?.tab?.id)
        ? `${sender.tab.id}:${String(message.parentJobId || "")}:${String(message.chapterId || "")}:${String(message.targetUrl || "")}`
        : "";
      if (prefetchFlightKey && prefetchStartFlights.has(prefetchFlightKey)) {
        return prefetchStartFlights.get(prefetchFlightKey);
      }
      const flightKey = message?.ttsSessionId && Number.isInteger(sender?.tab?.id)
        ? `${sender.tab.id}:${message.ttsSessionId}:${String(message.jobId || "")}`
        : "";
      if (flightKey && ttsStartFlights.has(flightKey)) return ttsStartFlights.get(flightKey);
      const operation = startJobReserved(message, sender);
      if (prefetchFlightKey) {
        const trackedPrefetch = operation.finally(() => {
          if (prefetchStartFlights.get(prefetchFlightKey) === trackedPrefetch) prefetchStartFlights.delete(prefetchFlightKey);
        });
        prefetchStartFlights.set(prefetchFlightKey, trackedPrefetch);
        return trackedPrefetch;
      }
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
        if (Array.from(pendingPrefetch.values()).some(item => item.tabId === admission.tabId && !item.cancelled)) return { ok: false, reason: 'prefetch_busy' };
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
        if (!config.consented) return { ok: false, reason: "prefetch_consent_required" };
        if (!await hasPrefetchParent(message, sender.tab.id, settings)) {
          return { ok: false, reason: "prefetch_parent_invalid" };
        }
        const activeSourceJob = Array.from(jobs.values()).find(job => job.sourceTabId === sender.tab.id
          && !["completed", "cancelled"].includes(job.status));
        if (activeSourceJob) {
          const samePrefetch = activeSourceJob.prefetch === true
            && activeSourceJob.cacheIdentity?.chapterId === chapter.chapterId
            && core.stableSettingsPayload(activeSourceJob.settings) === core.stableSettingsPayload(settings);
          if (samePrefetch) return replayExistingJob(activeSourceJob, { emit: false });
          return { ok: false, reason: "prefetch_busy" };
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
      if (existing && existing.status !== "cancelled" && existing.sourceTabId === sender.tab.id
        && existing.prefetch !== true && sameCacheIdentity(existing.cacheIdentity, identity)) {
        return replayExistingJob(existing);
      }
      if (existing && !["cancelled", "completed"].includes(existing.status)) {
        return { ok: false, reason: "job-exists" };
      }
      const attachable = Array.from(jobs.values()).find((priorJob) => (
        priorJob.id !== id
        && priorJob.sourceTabId === sender.tab.id
        && priorJob.prefetch !== true
        && message.prefetch !== true
        && !["cancelled", "completed"].includes(priorJob.status)
        && sameCacheIdentity(priorJob.cacheIdentity, identity)
      ));
      if (attachable) return replayExistingJob(attachable, { emit: false });
      for (const priorJob of jobs.values()) {
        if (
          priorJob.id !== id
          && priorJob.sourceTabId === sender.tab.id
          && !["cancelled", "completed"].includes(priorJob.status)
        ) {
          if (message.prefetch) return { ok: false, reason: 'prefetch_busy' };
          priorJob.status = "cancelled";
          priorJob.pending = false;
          if (typeof cancelGeminiRecovery === "function") await cancelGeminiRecovery(priorJob.id);
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
        createdAt: now(),
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
        batchStates: Array.from({ length: batches.length }, () => "pending"),
        dispatchReceipts: {},
        apiBatchIndexes: new Set(),
        normalBackpressure: false,
        rescueLane: null,
        rescueApiActive: null,
        rescueApiQueue: [],
        setupId,
        setupMessages: core.isApiProvider(settings.provider) ? [] : core.createSetupMessages({ setupId, jobId: id, settings }),
        setupIndex: 0,
        setupAttempts: 0,
        retryAttempts: 0,
        sendNotConfirmedAttempts: 0,
        receiptMissingAttempts: 0,
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
        refusalApiBatchIds: new Set(),
        refusalApiPending: false,
        refusalApiRequestId: "",
        refusalApiAttempts: 0,
        refusalSanitizeAttempted: false,
        refusalRescueAttempted: false,
        refusalRescueActive: false,
        refusalRescueOutcome: "none",
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
        {
          inputHash: await batchInputHash(batch),
          presentationHash: await batchPresentationHash(batch),
          sourceHashes: await batchSourceHashes(batch)
        }
      ]))));
      const compatible = typeof cache.getCompatibleBatches === "function"
        ? await cache.getCompatibleBatches(identity, inputHashes)
        : null;
      if (admission.cancelled || job.status === 'cancelled') return { ok: false, reason: 'user_cancelled' };
      for (let index = 0; index < batches.length; index += 1) {
        const batchId = batchIdAt(index);
        const compatibleBatch = compatible?.batches?.[batchId];
        let items = saved?.batches?.[batchId]?.items || compatibleBatch?.items;
        if (compatibleBatch?.sourceSequenceMatch === true
          && Array.isArray(items) && items.length === batches[index].length) {
          items = items.map((item, itemIndex) => ({ ...item, id: batches[index][itemIndex].id }));
        }
        const contentValidation = exactItems(items, batches[index])
          ? (core.validateTranslationItems?.(items, batches[index])
            || core.validateApiTranslationItems?.(items, batches[index])
            || { ok: true })
          : { ok: false };
        if (contentValidation.ok) {
          job.completed.set(batchId, core.filterTranslationItems(items, batches[index]));
          job.batchStates[index] = "completed";
        }
      }
      if (job.completed.size === batches.length) return completeJob(job, true);
      // A tab can navigate between the first cached push and the following
      // pushes. Include the cache snapshot in the reply that is bound to the
      // requesting document so the new reader can reconcile any missed event.
      const cachedBatches = cachedBatchSnapshot(job);
      const cacheHitIndexes = cachedBatches.map(batch => batch.batchIndex);
      const cacheMissIndexes = batches.map((_batch, index) => index)
        .filter(index => !job.completed.has(batchIdAt(index)));
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
          apiBatchIndexes: Array.from(job.apiBatchIndexes || []).sort((a, b) => a - b),
          paused: job.status === "paused",
          reason: job.pauseReason || dispatched?.reason || "",
          restartReason: job.restartReason || "",
          cachedBatches, cacheHitIndexes, cacheMissIndexes
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
          cachedBatches, cacheHitIndexes, cacheMissIndexes
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
        cachedBatches, cacheHitIndexes, cacheMissIndexes
      };
    }

    async function cancelJob(message, sender) {
      cancelPendingPrefetch(sender?.tab?.id, String(message.jobId || ''));
      const job = await ensureJob(String(message.jobId || ""));
      if (!job) return { ok: false, reason: "stale-job" };
      if (sender?.tab?.id !== job.sourceTabId) return { ok: false, reason: "wrong-source-tab" };
      if (job.status === "cancelled") return { ok: true, cancelled: true };
      // A departed chapter can deliver its navigation cleanup after a prefetch
      // has already committed every batch. Completion is terminal: never spend
      // or recycle the provider slot a second time for this stale cancellation.
      if (job.status === "completed") return { ok: true, cancelled: false, completed: true };
      if (!job.prefetch) await clearPrefetchParent(job.sourceTabId);
      if (!job.prefetch && core.isWebProvider(job.provider) && message.reason !== "chapter_changed") {
        warmPool.suspendedStvTabs.add(job.sourceTabId);
        await persistPool();
      }
      job.status = "cancelled";
      job.pending = false;
      if (typeof cancelGeminiRecovery === "function") await cancelGeminiRecovery(job.id);
      job.apiAbortController?.abort();
      job.apiAbortController = null;
      job.rescueApiAbortController?.abort();
      job.rescueApiAbortController = null;
      await sendToTab(job.providerTabId, { type: "STVAI_PROVIDER_CANCEL", jobId: job.id });
      if (Number.isInteger(job.rescueLane?.providerTabId)) {
        await sendToTab(job.rescueLane.providerTabId, {
          type: "STVAI_PROVIDER_CANCEL", jobId: job.id,
          requestId: job.rescueLane.current?.requestId || ""
        });
      }
      await notifyStatus(job, "cancelled");
      if (job.rescueLane) await releaseParallelRescueLane(job);
      if (job.poolSlotId) await spendJobSlot(job);
      else await closeLegacyProviderTab(job);
      if (core.isWebProvider(job.provider) && !hasEligibleStvTab()) {
        await cleanupWarmPool();
      }
      retainTerminalJob(job);
      return { ok: true, cancelled: true };
    }

    async function resumeJob(message, sender) {
      const key = String(message?.jobId || "");
      const existing = resumeOperations.get(key);
      if (existing) return existing;
      const operation = resumeJobCore(message, sender).finally(() => {
        if (resumeOperations.get(key) === operation) resumeOperations.delete(key);
      });
      resumeOperations.set(key, operation);
      return operation;
    }

    async function resumeJobCore(message, sender) {
      const job = await ensureJob(String(message.jobId || ""));
      if (!job) return { ok: false, reason: "stale-job" };
      if (sender?.tab?.id !== job.sourceTabId) return { ok: false, reason: "wrong-source-tab" };
      if (job.status !== "paused") return { ok: false, reason: "job-not-paused" };
      if (job.provider === "gemini" && !Number.isInteger(job.providerTabId)) {
        await retryFailedGeminiSlots?.(job.settings);
      }
      if (job.resetContinuationPending === true && job.workState === "settled"
        && job.pauseReason === "service_worker_restarted") {
        await restorePoolMetadata();
        const resetSlot = warmPool.slots.find((slot) => slot.slotId === job.poolSlotId
          && slot.jobId === job.id && slot.providerTabId === job.providerTabId);
        if (resetSlot?.state === "ready" && await wakeOrphanedReadyLease?.(resetSlot)) {
          return { ok: true, resumed: true, recoveredReset: true };
        }
        if (resetSlot && ["opening", "preparing", "restoring", "recovering"].includes(resetSlot.state)) {
          return { ok: true, waitingReset: true };
        }
      }
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
      job.parallelPauseReason = "";
      if (job.rescueLane || job.rescueApiQueue?.length || job.rescueApiActive) {
        await restorePoolMetadata();
        // The persisted flag belongs to the legacy single-lane fallback. A
        // restored parallel job must consume its concrete API task queue so
        // the normal lane never dispatches that same batch a second time.
        job.refusalApiPending = false;
        job.refusalApiRequestId = "";
        if (job.rescueApiActive) {
          job.rescueApiQueue.unshift(job.rescueApiActive);
          job.rescueApiActive = null;
        }
        if (job.rescueLane?.current) {
          job.rescueLane.queue.unshift(job.rescueLane.current);
          job.rescueLane.current = null;
        }
        let rescueRun = null;
        let apiRun = null;
        if (job.rescueLane) {
          job.rescueLane.ready = false;
          job.rescueLane.running = false;
          rescueRun = runParallelRescueLane(job);
        }
        if (job.rescueApiQueue?.length) apiRun = startParallelRescueApi(job);
        await resumeParallelNormalLane(job);
        await Promise.allSettled([rescueRun, apiRun].filter(Boolean));
        if (job.rescueApiPromise) await job.rescueApiPromise;
        await maybeFinishParallelJob(job);
        return { ok: true, resumed: true, parallelRescue: true };
      }
      if (job.refusalApiPending === true) {
        await notifyStatus(job, "running", "refusal_api_fallback");
        await dispatchCurrent(job);
        return { ok: true, resumed: true };
      }
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
            const authenticationSlot = slot.state === "failed" && isAuthenticationBlocker(slot.errorCode);
            const preparationStoppedByAuthentication = ["opening", "preparing", "restoring", "recovering"].includes(slot.state);
            if (!authenticationSlot && !preparationStoppedByAuthentication) continue;
            await recycleOwnedSlot(slot, warmPool.settings || job.settings, { force: true });
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
        await wakeOrphanedReadyLease?.(warmSlot);
        await drainWarmWaiters();
        return { ok: true, ready: true };
      }
      const job = await ensureJob(String(message.jobId || ""));
      if (!job) return { ok: false, reason: "stale-job" };
      if (job.status === "cancelled") return { ok: false, reason: "cancelled-job" };
      if (sender?.tab?.id === job.rescueLane?.providerTabId) {
        const task = job.rescueLane.current;
        if (!task) return { ok: false, reason: "stale-request" };
        if ((!message.requestId || message.requestId === task.requestId)
          && task.awaitingSystem2Response === true) {
          task.system2Attempts = Math.min(2, Math.max(0, Number(task.system2Attempts) || 0) + 1);
          task.awaitingSystem2Response = false;
        }
        recordDispatch(job, "rescue", task, "dispatch_acknowledged", {
          tabId: sender.tab.id,
          ...(message.requestId && message.requestId !== task.requestId ? { reason: "stale_request" } : {})
        });
        const result = await processParallelRescueResult(job, task, message);
        void runParallelRescueLane(job);
        await resumeParallelNormalLane(job);
        return result;
      }
      if (sender?.tab?.id !== job.providerTabId) return { ok: false, reason: "wrong-provider-tab" };
      const normalTask = {
        batchIndex: Math.max(0, Number(job.batchIndex) || 0),
        requestId: String(message.requestId || job.activeRequestId || ""),
        attempts: Math.max(0, Number(job.batchAttempts) || 0)
      };
      recordDispatch(job, "normal", normalTask, "dispatch_acknowledged", {
        tabId: sender.tab.id,
        ...(message.requestId && message.requestId !== job.activeRequestId ? { reason: "stale_request" } : {})
      });
      // Provider content scripts publish this only after their own completion
      // and stability checks. The sender tab, job, batch and request identities
      // are all verified again here, and processTranslation validates the full
      // response shape. Accept one receipt so a stable Gemini answer is not
      // stranded when the original long-lived tabs.sendMessage channel is
      // lost during an MV3 service-worker restart.
      return processProviderResult(job, message, true);
    }

    async function providerStatus(message, sender) {
      await restoreJobs();
      let warmSlot = findPoolSlotByTab(sender?.tab?.id);
      // Chrome can restore the visible Gemini tabs with fresh tab IDs after
      // Turbo restarts.  The persisted pool still points at the old IDs, so a
      // perfectly valid READY heartbeat would otherwise be reported as an
      // unknown provider tab and leave STV waiting forever.  Rebind only when
      // the old physical tab is gone and the new tab proves the exact warm
      // identity; never claim an unrelated Gemini tab.
      if (!warmSlot && Number.isInteger(sender?.tab?.id)
        && await providerTabMatches("gemini", sender.tab.id, sender?.url || sender?.tab?.url || "")) {
        const candidates = warmPool.slots.filter((slot) => slot.provider === "gemini"
          && ["restoring", "preparing", "ready"].includes(slot.state)
          && Number.isInteger(slot.providerTabId)
          && slot.providerTabId !== sender.tab.id
          && slot.warmSessionId && slot.settingsHash);
        for (const candidate of candidates) {
          if (await providerTabMatches("gemini", candidate.providerTabId, candidate.lastKnownUrl || "")) continue;
          try {
            const live = await tabs.sendMessage(sender.tab.id, { type: "STVAI_PROVIDER_STATUS" });
            const state = live?.state;
            const prepared = state?.prepared;
            const exactReady = state?.state === "ready"
              && state?.operation?.active !== true
              && state?.runtime?.stage !== "error"
              && prepared?.warmSessionId === candidate.warmSessionId
              && prepared?.settingsHash === candidate.settingsHash;
            if (!exactReady) continue;
            candidate.providerTabId = sender.tab.id;
            if (Number.isInteger(sender.tab.windowId)) candidate.providerWindowId = sender.tab.windowId;
            candidate.state = "ready";
            candidate.restoreState = "ready";
            candidate.sessionState = String(state?.session?.state || "temporary_active");
            candidate.setupState = "completed";
            candidate.setupCheckpoint = SETUP_PARTS.length;
            candidate.setupStage = "completed";
            candidate.errorCode = "";
            await persistPool();
            await notifyPoolStatus();
            await drainWarmWaiters();
            warmSlot = candidate;
            break;
          } catch (_error) {
            // Try the next persisted slot; no new tab is created here.
          }
        }
      }
      // Gemini can complete READY 2 in the content script after the original
      // setup reply channel has disappeared.  The tab then sends a metadata-
      // only READY heartbeat.  Reclaim the prepared evidence directly before
      // starting another setup pass; this is what wakes a chapter otherwise
      // stuck at "waiting for AI" with two visible READY replies.
      if (warmSlot && warmSlot.provider === "gemini"
        && ["preparing", "restoring"].includes(warmSlot.state)
        && message.status === "ready"
        && message.type === "STVAI_PROVIDER_READY") {
        try {
          const live = await tabs.sendMessage(warmSlot.providerTabId, { type: "STVAI_PROVIDER_STATUS" });
          const state = live?.state;
          const prepared = state?.prepared;
          const evidenceMatches = state?.state === "ready"
            && state?.operation?.active !== true
            && state?.runtime?.stage !== "error"
            && prepared?.warmSessionId === warmSlot.warmSessionId
            && prepared?.settingsHash === warmSlot.settingsHash;
          if (evidenceMatches) {
            warmSlot.state = "ready";
            warmSlot.sessionState = String(state?.session?.state || "temporary_active");
            warmSlot.setupState = "completed";
            warmSlot.setupCheckpoint = SETUP_PARTS.length;
            warmSlot.setupStage = "completed";
            warmSlot.errorCode = "";
            await persistPool();
            await notifyPoolStatus();
            await drainWarmWaiters();
            return { ok: true, ready: true, recoveredSetup: true };
          }
        } catch (_error) {
          // Fall through to the normal bounded preparation path below.
        }
      }
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
      if (warmSlot && ["opening", "preparing", "restoring"].includes(warmSlot.state)) {
        if (message.status && message.status !== "ready") {
          await markWarmSlotFailed(warmSlot, message.reason || message.status);
          return { ok: false, reason: warmSlot.errorCode };
        }
        await prepareWarmSlot(warmSlot, warmPool.settings || (await loadSettings({ provider: warmSlot.provider })));
        await notifyPoolStatus();
        await drainWarmWaiters();
        return { ok: warmSlot.state === "ready", ready: warmSlot.state === "ready" };
      }
      if (warmSlot && warmSlot.state === "ready" && message.status === "ready") {
        // A READY provider can outlive the MV3 service worker. If the worker was
        // suspended after the slot became ready, the detached pool callback
        // that normally drains queued jobs may never run. Treat the provider's
        // READY heartbeat as a durable wake-up signal for those jobs.
        await wakeOrphanedReadyLease?.(warmSlot);
        await drainWarmWaiters();
        return { ok: true, ready: true, recoveredWaiters: true };
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
      const incomingState = ["running", "completed", "failed"].includes(message.state) ? message.state : "running";
      if (slot.setupState === "completed" && incomingState !== "completed") {
        return { ok: true, ready: slot.state === "ready", ignored: "setup-already-completed" };
      }
      const incomingProgressAt = Math.max(0, Number(message.lastProgressAt) || 0);
      const incomingRevision = Math.max(0, Number(message.progressRevision) || 0);
      const currentRevision = Math.max(0, Number(slot.setupProgressRevision) || 0);
      if (incomingRevision > 0 && currentRevision > 0 && incomingRevision < currentRevision) {
        return { ok: true, ignored: "stale-setup-revision" };
      }
      if (incomingState === "failed"
        && ((incomingRevision > 0
          && incomingRevision === Math.max(0, Number(slot.setupLastFailureRevision) || 0))
          || (incomingRevision === 0 && incomingProgressAt > 0
            && incomingProgressAt === Math.max(0, Number(slot.setupLastFailureProgressAt) || 0)))) {
        return { ok: true, ignored: "setup-failure-already-processed" };
      }
      if (incomingState === "failed") {
        slot.setupLastFailureProgressAt = incomingProgressAt || now();
        slot.setupLastFailureRevision = incomingRevision;
      }
      slot.setupProgressRevision = Math.max(currentRevision, incomingRevision);
      const checkpoint = Math.max(0, Math.min(SETUP_PARTS.length, Number(message.checkpoint) || 0));
      slot.setupCheckpoint = Math.max(Number(slot.setupCheckpoint) || 0, checkpoint);
      slot.setupState = incomingState;
      slot.setupStage = ["waiting_composer", "sending", "waiting_marker", "confirmed", "resuming", "completed", "failed"]
        .includes(message.stage) ? message.stage : "waiting_marker";
      slot.setupLastProgressAt = incomingProgressAt || now();
      slot.setupResumeCount = Math.max(0, Number(message.resumeCount) || 0);
      slot.setupErrorCode = typeof message.errorCode === "string" ? message.errorCode : "";
      slot.readyWatchdogStep = slot.setupCheckpoint >= SETUP_PARTS.length ? `ready_${SETUP_PARTS.length}` : `ready_${slot.setupCheckpoint + 1}`;
      slot.readyWatchdogState = slot.setupStage === "confirmed" || slot.setupStage === "completed"
        ? "confirmed"
        : slot.setupStage;
      await persistPool();
      if (slot.setupState === "completed" && slot.setupCheckpoint === SETUP_PARTS.length) {
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
      replayJob,
      cancelJob,
      resumeJob,
      providerResult,
      providerStatus,
      providerSetupProgress,
      recoverOrphanedReadyLease,
      ensureParallelRescueReady,
      acquireRecoverySlot,
      releaseParallelRescueLane,
      cancelPendingPrefetch,
      clearPrefetchNameReceipt,
      cancelAllPendingPrefetch() {
        for (const admission of pendingPrefetch.values()) admission.cancelled = true;
      }
    });
  }

  return Object.freeze({ createTranslationJobService });
});
