(function attachErrorJournal(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIErrorJournal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createErrorJournalApi() {
  "use strict";

  const STORAGE_KEY = "stvai-error-journal-v1";
  const DEFAULT_TTL_MS = 60 * 60 * 1000;
  const DEFAULT_LIMIT = 20;
  const PROVIDERS = new Set(["chatgpt", "gemini", "openrouter_api", "gemini_api", "openai_api", "deepseek_api", "unknown"]);
  const PHASES = new Set(["setup", "batch", "prefetch", "chapter", "tts", "name_lookup", "pool", "unknown"]);
  const OUTCOMES = new Set(["still_running", "recovered", "failed"]);
  const RESPONSE_ID_STATES = new Set(["match", "mismatch", "missing", "unknown"]);
  const GENERATION_STATES = new Set(["generating", "stopped", "stale_stop_confirmed", "unknown"]);
  const SEND_STATES = new Set(["confirmed", "unconfirmed", "unknown"]);
  const COMPOSER_STATES = new Set(["not_found", "empty_before_write", "filled", "write_failed", "cleared_after_send", "unknown"]);
  const SEND_BUTTON_STATES = new Set(["not_found", "disabled", "enabled", "clicked", "stop_visible", "submission_confirmed", "click_unconfirmed", "unknown"]);
  const RECOVERY_STAGES = new Set(["initial", "retry_same_tab", "switching_ready", "exhausted", "unknown"]);
  const SETUP_STATES = new Set(["idle", "running", "completed", "failed", "resuming", "unknown"]);
  const SETUP_STAGES = new Set(["idle", "waiting_composer", "sending", "waiting_marker", "confirmed", "resuming", "completed", "failed", "unknown"]);
  const READY_STEPS = new Set(["idle", "ready_1", "ready_2", "ready_3", "unknown"]);
  const READY_STATES = new Set(["idle", "waiting_marker", "marker_seen", "rechecked_ready", "confirmed", "waiting_composer", "sending", "resuming", "failed", "unknown"]);
  const PERFORMANCE_MODES = new Set(["stable", "max", "none", "unknown"]);
  const EVENT_KINDS = new Set([
    "response_rejected", "retry_scheduled", "tab_retired", "tab_replaced",
    "batch_recovered", "setup_recovered", "job_paused", "provider_fault", "setup_failed",
    "ready_watchdog", "chapter_failed", "prefetch_failed", "tts_handoff_failed",
    "stale_stop_detected", "stale_stop_cleared", "stale_stop_recycled", "stale_stop_replaced"
  ]);
  const ERROR_CODES = new Set([
    "line_count_mismatch", "response_id_mismatch", "invalid_response", "incomplete_response",
    "response_timeout", "send_not_confirmed", "content_refused", "provider_unreachable",
    "provider_unavailable", "network_error", "provider_error", "ui_changed", "temporary_unavailable",
    "login_required", "login_window_open", "captcha", "security_verification", "login_browser_rejected",
    "batch_recovery_exhausted", "provider_tab_close_failed", "provider_origin_mismatch",
    "invalid_setup_response", "warm_setup_failed", "provider_tab_failed", "provider_tab_closed", "provider_tab_limit",
    "warm_evidence_missing", "warm_session_lost", "source_language_unchanged",
    "api_client_unavailable", "api_key_missing", "provider_busy", "provider_busy_timeout", "automation_disabled",
    "api_returned_source_language", "stale_stop_after_accept", "invalid-chapter", "SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE",
    "prefetch_source_unavailable", "tts_handoff_failed", "other"
  ]);

  function boundedInteger(value, maximum = 10_000) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.trunc(number))) : 0;
  }

  function safeEnum(value, values, fallback) {
    const text = String(value || "");
    return values.has(text) ? text : fallback;
  }

  function safeVersion(value) {
    const text = String(value || "");
    return /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(text) ? text.slice(0, 40) : "unknown";
  }

  function opaqueKey(value) {
    let first = 2166136261;
    let second = 2246822519;
    for (const character of String(value || "")) {
      const point = character.codePointAt(0);
      first = Math.imul(first ^ point, 16777619);
      second = Math.imul(second ^ point, 3266489917);
    }
    return `incident-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  }

  function sanitizeEvent(value, occurredAt) {
    const input = value && typeof value === "object" ? value : {};
    return {
      elapsedMs: boundedInteger(Number(input.at || occurredAt) - occurredAt, 60 * 60 * 1000),
      kind: safeEnum(input.kind, EVENT_KINDS, "provider_fault"),
      ...(input.errorCode ? { errorCode: safeEnum(input.errorCode, ERROR_CODES, "other") } : {}),
      ...(input.recoveryStage ? { recoveryStage: safeEnum(input.recoveryStage, RECOVERY_STAGES, "unknown") } : {}),
      ...(typeof input.tabClosed === "boolean" ? { tabClosed: input.tabClosed } : {})
    };
  }

  function sanitizeIncident(value, nowValue, ttlMs) {
    const input = value && typeof value === "object" ? value : {};
    const occurredAt = boundedInteger(input.occurredAt, Number.MAX_SAFE_INTEGER);
    const updatedAt = boundedInteger(input.updatedAt || occurredAt, Number.MAX_SAFE_INTEGER);
    if (!occurredAt || nowValue - updatedAt > ttlMs || updatedAt > nowValue + 60_000) return null;
    const internalKey = /^incident-[a-f0-9]{16}$/.test(String(input.internalKey || "")) ? String(input.internalKey) : "";
    if (!internalKey) return null;
    return {
      schemaVersion: 1,
      internalKey,
      occurredAt,
      updatedAt,
      extensionVersion: safeVersion(input.extensionVersion),
      provider: safeEnum(input.provider, PROVIDERS, "unknown"),
      phase: safeEnum(input.phase, PHASES, "unknown"),
      batchIndex: boundedInteger(input.batchIndex),
      batchAttempt: boundedInteger(input.batchAttempt, 3),
      errorCode: safeEnum(input.errorCode, ERROR_CODES, "other"),
      validationReason: safeEnum(input.validationReason || input.errorCode, ERROR_CODES, "other"),
      expectedCount: boundedInteger(input.expectedCount),
      actualCount: boundedInteger(input.actualCount),
      nonEmptyLineCount: boundedInteger(input.nonEmptyLineCount),
      labelCount: boundedInteger(input.labelCount, 30),
      missingLabels: Array.isArray(input.missingLabels)
        ? input.missingLabels.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 30).slice(0, 30)
        : [],
      duplicateLabels: Array.isArray(input.duplicateLabels)
        ? input.duplicateLabels.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 30).slice(0, 30)
        : [],
      labelsOutOfOrder: input.labelsOutOfOrder === true,
      responseIdState: safeEnum(input.responseIdState, RESPONSE_ID_STATES, "unknown"),
      generationState: safeEnum(input.generationState, GENERATION_STATES, "unknown"),
      sendState: safeEnum(input.sendState, SEND_STATES, "unknown"),
      completionSeen: input.completionSeen === true,
      composerState: safeEnum(input.composerState, COMPOSER_STATES, "unknown"),
      sendButtonState: safeEnum(input.sendButtonState, SEND_BUTTON_STATES, "unknown"),
      setupCheckpoint: boundedInteger(input.setupCheckpoint, 3),
      setupState: safeEnum(input.setupState, SETUP_STATES, "unknown"),
      setupStage: safeEnum(input.setupStage, SETUP_STAGES, "unknown"),
      readyStep: safeEnum(input.readyStep, READY_STEPS, "unknown"),
      readyState: safeEnum(input.readyState, READY_STATES, "unknown"),
      lastProgressAt: boundedInteger(input.lastProgressAt, Number.MAX_SAFE_INTEGER),
      resumeCount: boundedInteger(input.resumeCount, 100),
      serviceWorkerRestarts: boundedInteger(input.serviceWorkerRestarts, 100),
      watchdogTimeoutMs: boundedInteger(input.watchdogTimeoutMs, 120_000),
      watchdogGraceMs: boundedInteger(input.watchdogGraceMs, 30_000),
      busyWaitMs: boundedInteger(input.busyWaitMs, 30_000),
      busyRetryCount: boundedInteger(input.busyRetryCount, 100),
      staleStopWaitMs: boundedInteger(input.staleStopWaitMs, 3_000),
      ready3Persisted: input.ready3Persisted === true,
      slotLeased: input.slotLeased === true,
      firstBatchDispatched: input.firstBatchDispatched === true,
      performanceMode: safeEnum(input.performanceMode, PERFORMANCE_MODES, "unknown"),
      outcome: safeEnum(input.outcome, OUTCOMES, "still_running"),
      timeline: Array.isArray(input.timeline)
        ? input.timeline.slice(-16).map(event => sanitizeEvent(event, occurredAt))
        : []
    };
  }

  function publicIncident(value, nowValue) {
    if (!value) return null;
    const { internalKey: _internalKey, updatedAt: _updatedAt, ...safe } = value;
    return {
      ...safe,
      ageSeconds: boundedInteger((nowValue - value.occurredAt) / 1000, 60 * 60)
    };
  }

  function createErrorJournal({ storage, now = Date.now, extensionVersion = "0.0.0", ttlMs = DEFAULT_TTL_MS, limit = DEFAULT_LIMIT } = {}) {
    let serial = Promise.resolve();
    const safeLimit = Math.max(1, Math.min(20, boundedInteger(limit, 20) || DEFAULT_LIMIT));
    const safeTtl = Math.max(1, Math.min(DEFAULT_TTL_MS, boundedInteger(ttlMs, DEFAULT_TTL_MS) || DEFAULT_TTL_MS));

    async function readIncidents() {
      if (!storage?.get) return [];
      let stored = {};
      try { stored = await storage.get(STORAGE_KEY); } catch (_error) { return []; }
      const nowValue = now();
      const raw = stored?.[STORAGE_KEY]?.incidents;
      return (Array.isArray(raw) ? raw : [])
        .map(value => sanitizeIncident(value, nowValue, safeTtl))
        .filter(Boolean)
        .sort((left, right) => left.occurredAt - right.occurredAt)
        .slice(-safeLimit);
    }

    async function writeIncidents(incidents) {
      if (!storage?.set) return false;
      try {
        await storage.set({ [STORAGE_KEY]: { version: 1, incidents: incidents.slice(-safeLimit) } });
        return true;
      } catch (_error) {
        // Diagnostics must never interrupt translation.
        return false;
      }
    }

    function enqueue(operation) {
      const next = serial.then(operation, operation);
      serial = next.catch(() => undefined);
      return next;
    }

    function append(internalKey, context = {}) {
      return enqueue(async () => {
        const rawKey = String(internalKey || "");
        if (!rawKey) return null;
        const key = opaqueKey(rawKey);
        const timestamp = now();
        const incidents = await readIncidents();
        let incident = incidents.find(value => value.internalKey === key);
        if (!incident && context.onlyExisting === true) return null;
        if (!incident) {
          incident = sanitizeIncident({
            schemaVersion: 1,
            internalKey: key,
            occurredAt: timestamp,
            updatedAt: timestamp,
            extensionVersion,
            provider: context.provider,
            phase: context.phase,
            batchIndex: context.batchIndex,
            batchAttempt: context.batchAttempt,
            errorCode: context.errorCode,
            validationReason: context.validationReason,
            expectedCount: context.expectedCount,
            actualCount: context.actualCount,
            nonEmptyLineCount: context.nonEmptyLineCount,
            labelCount: context.labelCount,
            missingLabels: context.missingLabels,
            duplicateLabels: context.duplicateLabels,
            labelsOutOfOrder: context.labelsOutOfOrder,
            responseIdState: context.responseIdState,
            generationState: context.generationState,
            sendState: context.sendState,
            completionSeen: context.completionSeen,
            composerState: context.composerState,
            sendButtonState: context.sendButtonState,
            setupCheckpoint: context.setupCheckpoint,
            setupState: context.setupState,
            setupStage: context.setupStage,
            readyStep: context.readyStep,
            readyState: context.readyState,
            lastProgressAt: context.lastProgressAt,
            resumeCount: context.resumeCount,
            serviceWorkerRestarts: context.serviceWorkerRestarts,
            watchdogTimeoutMs: context.watchdogTimeoutMs,
            watchdogGraceMs: context.watchdogGraceMs,
            busyWaitMs: context.busyWaitMs,
            busyRetryCount: context.busyRetryCount,
            staleStopWaitMs: context.staleStopWaitMs,
            ready3Persisted: context.ready3Persisted,
            slotLeased: context.slotLeased,
            firstBatchDispatched: context.firstBatchDispatched,
            performanceMode: context.performanceMode,
            outcome: context.outcome || "still_running",
            timeline: []
          }, timestamp, safeTtl);
          if (!incident) return null;
          incidents.push(incident);
        }
        incident.updatedAt = timestamp;
        incident.batchAttempt = Math.max(incident.batchAttempt, boundedInteger(context.batchAttempt, 3));
        if (context.errorCode && incident.errorCode === "other") {
          incident.errorCode = safeEnum(context.errorCode, ERROR_CODES, "other");
        }
        if (context.validationReason && incident.validationReason === "other") {
          incident.validationReason = safeEnum(context.validationReason, ERROR_CODES, "other");
        }
        if (context.expectedCount != null) incident.expectedCount = boundedInteger(context.expectedCount);
        if (context.actualCount != null) incident.actualCount = boundedInteger(context.actualCount);
        if (context.nonEmptyLineCount != null) incident.nonEmptyLineCount = boundedInteger(context.nonEmptyLineCount);
        if (context.labelCount != null) incident.labelCount = boundedInteger(context.labelCount, 30);
        if (Array.isArray(context.missingLabels)) incident.missingLabels = context.missingLabels
          .map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 30).slice(0, 30);
        if (Array.isArray(context.duplicateLabels)) incident.duplicateLabels = context.duplicateLabels
          .map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 30).slice(0, 30);
        if (typeof context.labelsOutOfOrder === "boolean") incident.labelsOutOfOrder = context.labelsOutOfOrder;
        if (context.responseIdState) incident.responseIdState = safeEnum(context.responseIdState, RESPONSE_ID_STATES, "unknown");
        if (context.generationState) incident.generationState = safeEnum(context.generationState, GENERATION_STATES, "unknown");
        if (context.sendState) incident.sendState = safeEnum(context.sendState, SEND_STATES, "unknown");
        if (typeof context.completionSeen === "boolean") incident.completionSeen = context.completionSeen;
        if (context.composerState) incident.composerState = safeEnum(context.composerState, COMPOSER_STATES, "unknown");
        if (context.sendButtonState) incident.sendButtonState = safeEnum(context.sendButtonState, SEND_BUTTON_STATES, "unknown");
        if (context.setupCheckpoint != null) incident.setupCheckpoint = boundedInteger(context.setupCheckpoint, 3);
        if (context.setupState) incident.setupState = safeEnum(context.setupState, SETUP_STATES, "unknown");
        if (context.setupStage) incident.setupStage = safeEnum(context.setupStage, SETUP_STAGES, "unknown");
        if (context.readyStep) incident.readyStep = safeEnum(context.readyStep, READY_STEPS, "unknown");
        if (context.readyState) incident.readyState = safeEnum(context.readyState, READY_STATES, "unknown");
        if (context.lastProgressAt != null) incident.lastProgressAt = boundedInteger(context.lastProgressAt, Number.MAX_SAFE_INTEGER);
        if (context.resumeCount != null) incident.resumeCount = boundedInteger(context.resumeCount, 100);
        if (context.serviceWorkerRestarts != null) incident.serviceWorkerRestarts = boundedInteger(context.serviceWorkerRestarts, 100);
        if (context.watchdogTimeoutMs != null) incident.watchdogTimeoutMs = boundedInteger(context.watchdogTimeoutMs, 120_000);
        if (context.watchdogGraceMs != null) incident.watchdogGraceMs = boundedInteger(context.watchdogGraceMs, 30_000);
        if (context.busyWaitMs != null) incident.busyWaitMs = boundedInteger(context.busyWaitMs, 30_000);
        if (context.busyRetryCount != null) incident.busyRetryCount = boundedInteger(context.busyRetryCount, 100);
        if (context.staleStopWaitMs != null) incident.staleStopWaitMs = boundedInteger(context.staleStopWaitMs, 3_000);
        if (typeof context.ready3Persisted === "boolean") incident.ready3Persisted = context.ready3Persisted;
        if (typeof context.slotLeased === "boolean") incident.slotLeased = context.slotLeased;
        if (typeof context.firstBatchDispatched === "boolean") incident.firstBatchDispatched = context.firstBatchDispatched;
        if (context.performanceMode) incident.performanceMode = safeEnum(context.performanceMode, PERFORMANCE_MODES, "unknown");
        if (context.outcome) incident.outcome = safeEnum(context.outcome, OUTCOMES, incident.outcome);
        incident.timeline.push(sanitizeEvent({ ...context, at: timestamp }, incident.occurredAt));
        incident.timeline = incident.timeline.slice(-16);
        await writeIncidents(incidents);
        return publicIncident(incident, timestamp);
      });
    }

    async function latest() {
      return enqueue(async () => {
        const incidents = await readIncidents();
        await writeIncidents(incidents);
        return publicIncident(incidents.at(-1) || null, now());
      });
    }

    async function clear() {
      return enqueue(async () => {
        return writeIncidents([]);
      });
    }

    return Object.freeze({ append, latest, clear });
  }

  return Object.freeze({ createErrorJournal, STORAGE_KEY, DEFAULT_TTL_MS, DEFAULT_LIMIT });
});
