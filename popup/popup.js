(function attachPopup(root, factory) {
  const api = factory(
    root.STVAIDiagnostics || (typeof require === "function" ? require("../src/content/stv-diagnostics.js") : null),
    root.STVAIDistribution || (typeof require === "function" ? require("../src/shared/distribution-channel.js") : null)
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIPopup = api;

  if (typeof module !== "object" && root.document && root.chrome?.tabs) {
    root.document.addEventListener("DOMContentLoaded", () => {
      void api.initPopup({ document: root.document, chromeApi: root.chrome, distribution: root.STVAIDistribution });
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPopupApi(diagnostics, defaultDistribution) {
  "use strict";

  const MESSAGE_TYPE = "STVAI_GET_PAGE_DIAGNOSTICS";
  const GET_TOOL_ENABLED = "STVAI_GET_TOOL_ENABLED";
  const SET_TOOL_ENABLED = "STVAI_SET_TOOL_ENABLED";
  const GET_UPDATE_STATUS = "STVAI_GET_UPDATE_STATUS";
  const CHECK_UPDATE = "STVAI_CHECK_UPDATE";
  const OPEN_UPDATE = "STVAI_OPEN_UPDATE";
  const GET_ERROR_REPORT = "STVAI_GET_ERROR_REPORT";
  const CLEAR_ERROR_LOG = "STVAI_CLEAR_ERROR_LOG";
  const COUNT_VALUES = new Set(["0", "1", "many"]);
  const MARKER_VALUES = new Set(["0", "1", "2-10", "11-100", "101+"]);
  const STATUS_VALUES = new Set([
    "active",
    "toolbar_missing",
    "extraction_failed",
    "source_missing",
    "chapter_root_missing",
    "not_chapter"
  ]);

  function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function safeEnum(value, allowed, fallback) {
    return allowed.has(value) ? value : fallback;
  }

  function safeVersion(value) {
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(value)
      ? value.slice(0, 40)
      : "unknown";
  }

  function sanitizeStvDiagnostic(value) {
    const input = safeObject(value);
    const page = safeObject(input.page);
    const modules = safeObject(input.modules);
    const selectors = safeObject(input.selectors);
    const presentation = safeObject(input.presentation);
    const extraction = safeObject(input.extraction);
    const bootstrap = safeObject(input.bootstrap);
    const count = (key) => safeEnum(selectors[key], COUNT_VALUES, "0");
    const markers = (key) => safeEnum(selectors[key], MARKER_VALUES, "0");
    const safeBootstrap = {
      stage: safeEnum(
        bootstrap.stage,
        new Set([
          "unknown", "script_started", "path_check", "not_chapter", "waiting_root",
          "root_timeout", "extracting", "reading_storage", "creating_toolbar",
          "inserting_toolbar", "registering_listener", "active"
        ]),
        "unknown"
      ),
      errorCode: safeEnum(
        bootstrap.errorCode,
        new Set(["none", "SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE", "UNEXPECTED"]),
        "UNEXPECTED"
      )
    };
    const sharedBootstrap = diagnostics.sanitizeBootstrap?.(bootstrap);
    if (sharedBootstrap?.prefetch) safeBootstrap.prefetch = sharedBootstrap.prefetch;
    const pool = safeObject(bootstrap.pool);
    if (Object.keys(pool).length) {
      const bounded = (value, limit) => String(value || "").slice(0, limit);
      const ui = safeObject(pool.uiDiagnostic);
      safeBootstrap.pool = {
        state: safeEnum(pool.state, new Set(["disabled", "preparing", "ready", "leased", "error"]), "error"),
        readyCount: Math.max(0, Math.min(2, Number(pool.readyCount) || 0)),
        totalCount: Math.max(0, Math.min(2, Number(pool.totalCount) || 0)),
        leasedCount: Math.max(0, Math.min(2, Number(pool.leasedCount) || 0)),
        errorCode: /^[a-z0-9_-]{1,64}$/i.test(String(pool.errorCode || "")) ? String(pool.errorCode) : "other"
      };
      if (Object.keys(ui).length) {
        safeBootstrap.pool.uiDiagnostic = {
          schemaVersion: 1,
          provider: ui.provider === "gemini" ? "gemini" : "chatgpt",
          temporaryActive: ui.temporaryActive === true,
          composerFound: ui.composerFound === true,
          candidateCount: Math.max(0, Math.min(200, Number(ui.candidateCount) || 0)),
          candidates: Array.isArray(ui.candidates) ? ui.candidates.slice(0, 8).map((item) => ({
            tag: bounded(item?.tag, 64), className: bounded(item?.className, 240),
            ariaLabel: bounded(item?.ariaLabel, 240), title: bounded(item?.title, 240),
            testId: bounded(item?.testId, 240), disabled: item?.disabled === true,
            score: Math.max(-100, Math.min(100, Number(item?.score) || 0))
          })) : []
        };
      }
    }

    return {
      schemaVersion: 3,
      component: "stv-content",
      extensionVersion: safeVersion(input.extensionVersion),
      status: safeEnum(input.status, STATUS_VALUES, "not_chapter"),
      page: {
        originClass: page.originClass === "sangtacviet" ? "sangtacviet" : "other",
        pathClass: page.pathClass === "chapter_candidate" ? "chapter_candidate" : "not_chapter",
        readyState: safeEnum(page.readyState, new Set(["loading", "interactive", "complete", "unknown"]), "unknown"),
        bodyPresent: page.bodyPresent === true
      },
      modules: {
        diagnostics: modules.diagnostics === true,
        core: modules.core === true,
        extractor: modules.extractor === true,
        ui: modules.ui === true,
        chapter: modules.chapter === true
      },
      selectors: {
        contentContainer: count("contentContainer"),
        strictChapterRoot: count("strictChapterRoot"),
        rootWithoutCid: count("rootWithoutCid"),
        rootOutsideContainer: count("rootOutsideContainer"),
        knownChapterElement: count("knownChapterElement"),
        sourceMarkersInRoot: markers("sourceMarkersInRoot"),
        sourceMarkersInDocument: markers("sourceMarkersInDocument"),
        imagesInRoot: count("imagesInRoot"),
        frames: count("frames"),
        toolbar: count("toolbar")
      },
      extraction: {
        state: safeEnum(extraction.state, new Set(["ok", "failed", "unavailable"]), "unavailable"),
        errorCode: safeEnum(
          extraction.errorCode,
          new Set(["none", "SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE", "UNEXPECTED"]),
          "UNEXPECTED"
        )
      },
      bootstrap: safeBootstrap,
      nativeTrace: diagnostics.sanitizeNativeTrace(input.nativeTrace),
      historySync: diagnostics.sanitizeHistorySync(input.historySync),
      presentation: {
        toolbarConnected: presentation.toolbarConnected === true,
        hiddenAttribute: presentation.hiddenAttribute === true,
        display: safeEnum(
          presentation.display,
          new Set(["none", "grid", "block", "flex", "inline", "inline-block", "other", "unavailable"]),
          "unavailable"
        ),
        visibility: safeEnum(
          presentation.visibility,
          new Set(["visible", "hidden", "collapse", "other", "unavailable"]),
          "unavailable"
        )
      }
    };
  }

  function sanitizeProviderDiagnostic(value) {
    const input = safeObject(value);
    const page = safeObject(input.page);
    const adapter = safeObject(input.adapter);
    const selectors = safeObject(input.selectors);
    const interaction = safeObject(input.interaction);
    const interactionComposer = safeObject(interaction.composer);
    const interactionTemporary = safeObject(interaction.temporary);
    const domResolution = safeObject(input.domResolution);
    const runtime = safeObject(input.runtime);
    const count = (key) => safeEnum(selectors[key], COUNT_VALUES, "0");
    return {
      schemaVersion: 3,
      component: "provider-content",
      extensionVersion: safeVersion(input.extensionVersion),
      provider: safeEnum(input.provider, new Set(["chatgpt", "gemini"]), "unknown"),
      status: safeEnum(input.status, new Set(["ready", "blocked"]), "blocked"),
      page: {
        readyState: safeEnum(page.readyState, new Set(["loading", "interactive", "complete", "unknown"]), "unknown"),
        bodyPresent: page.bodyPresent === true
      },
      adapter: {
        loaded: adapter.loaded === true,
        state: safeEnum(adapter.state, new Set(["ready", "paused", "unknown"]), "unknown"),
        code: safeEnum(adapter.code, new Set([
          "none", "captcha", "login_required", "rate_limited", "ui_changed", "ab_comparison",
          "temporary_unavailable", "unknown"
        ]), "unknown")
      },
      selectors: {
        composer: count("composer"),
        sendButton: count("sendButton"),
        responses: count("responses"),
        temporaryControl: count("temporaryControl")
      },
      interaction: {
        composer: {
          selector: safeEnum(interactionComposer.selector, new Set([
            "role_textbox", "prompt_textarea", "textarea", "none"
          ]), "none"),
          empty: interactionComposer.empty === true,
          disabled: interactionComposer.disabled === true
        },
        actions: Array.isArray(interaction.actions) ? interaction.actions.slice(0, 8).map((value) => {
          const action = safeObject(value);
          const kind = safeEnum(action.kind, new Set(["send", "stop"]), "unknown");
          const signal = safeEnum(action.signal, new Set(["aria", "testid", "icon", "class"]), "unknown");
          return kind === "unknown" || signal === "unknown" ? null : {
            kind,
            signal,
            enabled: action.enabled === true
          };
        }).filter(Boolean) : [],
        temporary: {
          urlFlag: safeEnum(interactionTemporary.urlFlag, new Set(["on", "off", "unknown"]), "unknown"),
          heading: safeEnum(interactionTemporary.heading, new Set(["active", "absent"]), "absent"),
          controlCount: safeEnum(interactionTemporary.controlCount, COUNT_VALUES, "0"),
          pressed: safeEnum(interactionTemporary.pressed, new Set(["true", "false", "mixed", "unknown"]), "unknown"),
          intent: safeEnum(interactionTemporary.intent, new Set(["enable", "disable", "unknown"]), "unknown")
        }
      },
      domResolution: sanitizeDomResolution(domResolution),
      runtime: {
        stage: safeEnum(runtime.stage, new Set([
          "idle", "preparing", "sending", "waiting_response", "completed", "error", "cancelled"
        ]), "idle"),
        phase: safeEnum(runtime.phase, new Set(["idle", "setup", "batch", "repair"]), "idle"),
        errorCode: safeEnum(runtime.errorCode, new Set([
          "none", "response_timeout", "send_not_confirmed", "provider_busy", "provider_unreachable", "captcha",
          "login_required", "rate_limited", "ui_changed", "ab_comparison", "temporary_unavailable",
          "provider_error", "cancelled", "content_refused", "incomplete_response", "recovering_response", "fallback_unavailable"
        ]), "none"),
        readyStep: safeEnum(runtime.readyStep, new Set(["idle", "ready_1", "ready_2", "ready_3"]), "idle"),
        readyState: safeEnum(runtime.readyState, new Set(["idle", "waiting_marker", "marker_seen", "grace", "confirmed", "failed"]), "idle"),
        stablePolls: Math.max(0, Math.min(2, Number(runtime.stablePolls) || 0)),
        timeoutMs: Math.max(0, Math.min(60_000, Number(runtime.timeoutMs) || 0)),
        graceMs: Math.max(0, Math.min(10_000, Number(runtime.graceMs) || 0)),
        batchAttempt: Math.max(0, Math.min(3, Number(runtime.batchAttempt) || 0)),
        expectedCount: Math.max(0, Math.min(10_000, Number(runtime.expectedCount) || 0)),
        actualCount: Math.max(0, Math.min(10_000, Number(runtime.actualCount) || 0)),
        validationReason: safeEnum(runtime.validationReason, new Set([
          "none", "ok", "line_count_mismatch", "response_id_mismatch", "invalid_response",
          "ready_marker_missing", "ready_marker_mismatch", "ready_receipt_mismatch"
        ]), "other"),
        generationState: safeEnum(runtime.generationState, new Set(["generating", "stopped", "unknown"]), "unknown"),
        sendState: safeEnum(runtime.sendState, new Set(["idle", "pending", "confirmed", "reconciled", "unconfirmed"]), "idle"),
        performanceMode: safeEnum(runtime.performanceMode, new Set(["off", "max"]), "off"),
        pageVisibility: safeEnum(runtime.pageVisibility, new Set(["visible", "hidden", "prerender", "unknown"]), "unknown"),
        pageFocused: runtime.pageFocused === true,
        sendConfirmedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.sendConfirmedAt) || 0)),
        firstMutationAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.firstMutationAt) || 0)),
        completionSeenAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.completionSeenAt) || 0)),
        acceptedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.acceptedAt) || 0)),
        composerState: safeEnum(runtime.composerState, new Set(["not_found", "empty_before_write", "filled", "write_failed", "cleared_after_send"]), "not_found"),
        composerLengthBucket: safeEnum(runtime.composerLengthBucket, new Set(["0", "1-100", "101-1000", "1001-5000", "5001+"]), "0"),
        inputEventDispatched: runtime.inputEventDispatched === true,
        sendButtonState: safeEnum(runtime.sendButtonState, new Set(["not_found", "disabled", "enabled", "clicked", "stop_visible", "submission_confirmed", "click_unconfirmed"]), "not_found"),
        clickAttempted: runtime.clickAttempted === true,
        submissionConfirmed: runtime.submissionConfirmed === true,
        requestAlreadyPresent: runtime.requestAlreadyPresent === true
      }
    };
  }

  function sanitizeSupport(value) {
    const input = safeObject(value);
    const jobStates = new Set(["idle", "waiting-provider", "running", "paused", "completed", "cancelled", "failed", "error"]);
    const phases = new Set(["idle", "setup", "batch", "repair", "completed"]);
    const workStates = new Set(["queued", "sending", "settled"]);
    const slotStates = new Set(["opening", "preparing", "ready", "leased", "name_lookup", "retiring", "restoring", "spent", "failed"]);
    const bounded = (value, max = 10_000) => Math.max(0, Math.min(max, Number(value) || 0));
    return {
      schemaVersion: 1,
      targetCount: Math.min(5, Math.max(2, Math.trunc(Number(input.targetCount)) || 2)),
      reconfiguring: input.reconfiguring === true,
      jobs: Array.isArray(input.jobs) ? input.jobs.slice(0, 3).map(raw => {
        const job = safeObject(raw);
        return {
          kind: safeEnum(job.kind, new Set(["foreground", "prefetch"]), "foreground"),
          status: safeEnum(job.status, jobStates, "idle"),
          phase: safeEnum(job.phase, phases, "idle"),
          workState: safeEnum(job.workState, workStates, "queued"),
          batchIndex: bounded(job.batchIndex), totalBatches: bounded(job.totalBatches), completedBatches: bounded(job.completedBatches),
          batchAttempt: bounded(job.batchAttempt, 3),
          recoveryStage: safeEnum(job.recoveryStage, new Set(["initial", "retry_same_tab", "switching_ready", "exhausted"]), "initial"),
          activeRequest: job.activeRequest === true, unsentRequest: job.unsentRequest === true,
          lastError: /^[a-z0-9_-]{1,64}$/i.test(String(job.lastError || "")) ? String(job.lastError) : "other"
        };
      }) : [],
      slots: Array.isArray(input.slots) ? input.slots.slice(0, 5).map(raw => {
        const slot = safeObject(raw);
        const watchdog = safeObject(slot.readyWatchdog);
        const lease = safeObject(slot.performanceLease);
        return {
          provider: safeEnum(slot.provider, new Set(["gemini", "chatgpt"]), "gemini"),
          purpose: safeEnum(slot.purpose, new Set(["shared", "general", "prefetch"]), "shared"),
          state: safeEnum(slot.state, slotStates, "failed"),
          errorCode: /^[a-z0-9_-]{1,64}$/i.test(String(slot.errorCode || "")) ? String(slot.errorCode) : "other",
          hasJob: slot.hasJob === true,
          readyWatchdog: {
            step: safeEnum(watchdog.step, new Set(["idle", "ready_1", "ready_2", "ready_3"]), "idle"),
            state: safeEnum(watchdog.state, new Set(["idle", "waiting_marker", "marker_seen", "grace", "confirmed", "failed"]), "idle"),
            validationSource: safeEnum(watchdog.validationSource, new Set(["none", "provider_receipt", "background_fallback"]), "none"),
            validationReason: safeEnum(watchdog.validationReason, new Set([
              "none", "ok", "ready_marker_missing", "ready_marker_mismatch", "ready_receipt_mismatch"
            ]), "other")
          },
          performanceLease: {
            state: safeEnum(lease.state, new Set(["inactive", "active", "fallback", "detached"]), "inactive"),
            stage: safeEnum(lease.stage, new Set(["idle", "temporary", "ready_1", "ready_2", "ready_3", "batch"]), "idle")
          },
          ...(slot.providerDiagnostic ? { providerDiagnostic: sanitizeProviderDiagnostic(slot.providerDiagnostic) } : {})
        };
      }) : []
    };
  }

  function sanitizeDomResolution(value) {
    const input = safeObject(value);
    const roleNames = new Set(["composer", "send", "stop", "response", "completion", "temporaryLauncher", "temporaryActive"]);
    const sources = new Set(["bundled", "local", "scanner", "none"]);
    const confidences = new Set(["high", "medium", "low"]);
    const reasons = new Set(["selector_match", "profile_match", "semantic_match", "no_safe_candidate", "not_checked"]);
    const counts = new Set(["0", "1", "2-5", "6+"]);
    const semantics = new Set(["", "send", "gửi", "stop", "dừng", "temporary", "tạm thời", "chat", "trò chuyện", "prompt", "message", "tin nhắn"]);
    const stableClass = /send|stop|temp|chat|prompt|composer|response|footer|markdown|editor|textarea/i;
    const safeName = (value, limit = 40) => /^[a-z0-9_-]+$/i.test(String(value || ""))
      ? String(value).toLowerCase().slice(0, limit) : "";
    const roles = {};
    for (const [role, rawValue] of Object.entries(safeObject(input.roles))) {
      if (!roleNames.has(role)) continue;
      const value = safeObject(rawValue);
      roles[role] = {
        source: safeEnum(value.source, sources, "none"),
        profileId: /^[a-z0-9_-]{1,80}$/i.test(String(value.profileId || "")) ? String(value.profileId) : "",
        confidence: safeEnum(value.confidence, confidences, "low"),
        reason: safeEnum(value.reason, reasons, "not_checked"),
        candidateCount: safeEnum(value.candidateCount, counts, "0")
      };
    }
    const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 7).map(rawValue => {
      const value = safeObject(rawValue);
      if (!roleNames.has(value.role)) return null;
      return {
        role: value.role,
        tag: safeName(value.tag) || "unknown",
        parentTag: safeName(value.parentTag),
        roleAttribute: safeName(value.roleAttribute),
        contenteditable: value.contenteditable === true,
        semantic: safeEnum(String(value.semantic || "").toLowerCase(), semantics, ""),
        classHints: Array.isArray(value.classHints) ? value.classHints.filter(item => (
          typeof item === "string" && item.length <= 80 && stableClass.test(item)
        )).slice(0, 8) : [],
        disabled: value.disabled === true,
        hidden: value.hidden === true
      };
    }).filter(Boolean) : [];
    return {
      schemaVersion: 1,
      localProfileCount: Math.max(0, Math.min(5, Number(input.localProfileCount) || 0)),
      roles,
      evidence
    };
  }

  function sanitizeDiagnostic(value) {
    return safeObject(value).component === "provider-content"
      ? sanitizeProviderDiagnostic(value)
      : sanitizeStvDiagnostic(value);
  }

  function sanitizeErrorReport(value) {
    const input = safeObject(value);
    const raw = safeObject(input.incident);
    if (!Object.keys(raw).length) {
      return { schemaVersion: 1, generatedAt: Math.max(0, Number(input.generatedAt) || 0), incident: null };
    }
    const providers = new Set(["chatgpt", "gemini", "openrouter_api", "gemini_api", "openai_api", "deepseek_api", "unknown"]);
    const phases = new Set(["setup", "batch", "prefetch", "chapter", "tts", "name_lookup", "pool", "unknown"]);
    const outcomes = new Set(["still_running", "recovered", "failed"]);
    const responseStates = new Set(["match", "mismatch", "missing", "unknown"]);
    const generationStates = new Set(["generating", "stopped", "unknown"]);
    const sendStates = new Set(["confirmed", "unconfirmed", "unknown"]);
    const composerStates = new Set(["not_found", "empty_before_write", "filled", "write_failed", "cleared_after_send", "unknown"]);
    const sendButtonStates = new Set(["not_found", "disabled", "enabled", "clicked", "stop_visible", "submission_confirmed", "click_unconfirmed", "unknown"]);
    const recoveryStages = new Set(["initial", "retry_same_tab", "switching_ready", "exhausted", "unknown"]);
    const setupStates = new Set(["idle", "running", "completed", "failed", "resuming", "unknown"]);
    const setupStages = new Set(["idle", "waiting_composer", "sending", "waiting_marker", "confirmed", "resuming", "completed", "failed", "unknown"]);
    const readySteps = new Set(["idle", "ready_1", "ready_2", "ready_3", "unknown"]);
    const readyStates = new Set(["idle", "waiting_marker", "marker_seen", "rechecked_ready", "confirmed", "waiting_composer", "sending", "resuming", "failed", "unknown"]);
    const performanceModes = new Set(["stable", "max", "none", "unknown"]);
    const errorCodes = new Set([
      "line_count_mismatch", "response_id_mismatch", "invalid_response", "incomplete_response",
      "response_timeout", "send_not_confirmed", "content_refused", "provider_unreachable",
      "provider_unavailable", "network_error", "provider_error", "ui_changed", "temporary_unavailable",
      "login_required", "login_window_open", "captcha", "security_verification", "login_browser_rejected",
      "batch_recovery_exhausted", "provider_tab_close_failed", "provider_origin_mismatch",
      "invalid_setup_response", "warm_setup_failed", "provider_tab_failed", "provider_tab_closed", "provider_tab_limit",
      "warm_evidence_missing", "warm_session_lost", "source_language_unchanged",
      "api_client_unavailable", "api_key_missing", "provider_busy", "automation_disabled",
      "api_returned_source_language", "invalid-chapter", "SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE",
      "prefetch_source_unavailable", "tts_handoff_failed", "other"
    ]);
    const eventKinds = new Set([
      "response_rejected", "retry_scheduled", "tab_retired", "tab_replaced", "batch_recovered", "setup_recovered",
      "job_paused", "provider_fault", "setup_failed", "ready_watchdog", "chapter_failed",
      "prefetch_failed", "tts_handoff_failed"
    ]);
    const safeCode = value => safeEnum(String(value || ""), errorCodes, "other");
    const safeCount = (value, maximum = 10_000) => Math.max(0, Math.min(maximum, Math.trunc(Number(value) || 0)));
    const safeLabels = value => Array.isArray(value)
      ? value.map(Number).filter(item => Number.isInteger(item) && item >= 1 && item <= 30).slice(0, 30)
      : [];
    const timeline = Array.isArray(raw.timeline) ? raw.timeline.slice(0, 16).map(item => {
      const event = safeObject(item);
      return {
        elapsedMs: safeCount(event.elapsedMs, 60 * 60 * 1000),
        kind: safeEnum(event.kind, eventKinds, "provider_fault"),
        ...(event.errorCode ? { errorCode: safeCode(event.errorCode) } : {}),
        ...(event.recoveryStage ? { recoveryStage: safeEnum(event.recoveryStage, recoveryStages, "unknown") } : {}),
        ...(typeof event.tabClosed === "boolean" ? { tabClosed: event.tabClosed } : {})
      };
    }) : [];
    return {
      schemaVersion: 1,
      generatedAt: Math.max(0, Number(input.generatedAt) || 0),
      incident: {
        schemaVersion: 1,
        occurredAt: Math.max(0, Number(raw.occurredAt) || 0),
        extensionVersion: safeVersion(raw.extensionVersion),
        provider: safeEnum(raw.provider, providers, "unknown"),
        phase: safeEnum(raw.phase, phases, "unknown"),
        batchIndex: safeCount(raw.batchIndex),
        batchAttempt: safeCount(raw.batchAttempt, 3),
        errorCode: safeCode(raw.errorCode),
        validationReason: safeCode(raw.validationReason),
        expectedCount: safeCount(raw.expectedCount),
        actualCount: safeCount(raw.actualCount),
        nonEmptyLineCount: safeCount(raw.nonEmptyLineCount),
        labelCount: safeCount(raw.labelCount, 30),
        missingLabels: safeLabels(raw.missingLabels),
        duplicateLabels: safeLabels(raw.duplicateLabels),
        labelsOutOfOrder: raw.labelsOutOfOrder === true,
        responseIdState: safeEnum(raw.responseIdState, responseStates, "unknown"),
        generationState: safeEnum(raw.generationState, generationStates, "unknown"),
        sendState: safeEnum(raw.sendState, sendStates, "unknown"),
        completionSeen: raw.completionSeen === true,
        composerState: safeEnum(raw.composerState, composerStates, "unknown"),
        sendButtonState: safeEnum(raw.sendButtonState, sendButtonStates, "unknown"),
        setupCheckpoint: safeCount(raw.setupCheckpoint, 3),
        setupState: safeEnum(raw.setupState, setupStates, "unknown"),
        setupStage: safeEnum(raw.setupStage, setupStages, "unknown"),
        readyStep: safeEnum(raw.readyStep, readySteps, "unknown"),
        readyState: safeEnum(raw.readyState, readyStates, "unknown"),
        lastProgressAt: safeCount(raw.lastProgressAt, Number.MAX_SAFE_INTEGER),
        resumeCount: safeCount(raw.resumeCount, 100),
        serviceWorkerRestarts: safeCount(raw.serviceWorkerRestarts, 100),
        watchdogTimeoutMs: safeCount(raw.watchdogTimeoutMs, 120_000),
        watchdogGraceMs: safeCount(raw.watchdogGraceMs, 30_000),
        ready3Persisted: raw.ready3Persisted === true,
        slotLeased: raw.slotLeased === true,
        firstBatchDispatched: raw.firstBatchDispatched === true,
        performanceMode: safeEnum(raw.performanceMode, performanceModes, "unknown"),
        outcome: safeEnum(raw.outcome, outcomes, "still_running"),
        ageSeconds: safeCount(raw.ageSeconds, 60 * 60),
        timeline
      }
    };
  }

  function createExportPayload(diagnostic, support, errorReport) {
    return {
      format: "stv-ai-translator-diagnostic",
      version: 3,
      ...(diagnostic ? { diagnostic: sanitizeDiagnostic(diagnostic) } : {}),
      ...(support ? { support: sanitizeSupport(support) } : {}),
      ...(errorReport ? { errorReport: sanitizeErrorReport(errorReport) } : {})
    };
  }

  async function defaultCopyText(text, document) {
    const clipboard = document.defaultView?.navigator?.clipboard || globalThis.navigator?.clipboard;
    if (clipboard?.writeText) return clipboard.writeText(text);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand?.("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }

  function callbackCall(chromeApi, invoke) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      try {
        const possiblePromise = invoke((value) => {
          const runtimeError = chromeApi.runtime?.lastError;
          finish(value, runtimeError ? new Error(runtimeError.message || "Chrome runtime error") : null);
        });
        if (possiblePromise && typeof possiblePromise.then === "function") {
          possiblePromise.then((value) => finish(value), (error) => finish(undefined, error));
        }
      } catch (error) {
        finish(undefined, error);
      }
    });
  }

  function queryActiveTab(chromeApi) {
    return callbackCall(chromeApi, (callback) => (
      chromeApi.tabs.query({ active: true, currentWindow: true }, callback)
    ));
  }

  function requestDiagnostic(chromeApi, tabId) {
    return callbackCall(chromeApi, (callback) => (
      chromeApi.tabs.sendMessage(tabId, { type: MESSAGE_TYPE }, callback)
    ));
  }

  function runtimeMessage(chromeApi, message) {
    return callbackCall(chromeApi, (callback) => chromeApi.runtime.sendMessage(message, callback));
  }

  function renderToolToggle(document, enabled) {
    const toggle = document.getElementById("toolToggle");
    toggle.setAttribute("aria-checked", enabled ? "true" : "false");
    toggle.disabled = false;
    document.getElementById("toolToggleStatus").textContent = enabled
      ? "Đang bật — tự động xử lý trên STV"
      : "Đang tắt — không mở tab AI";
  }

  function renderUpdateStatus(document, response) {
    const panel = document.getElementById("updatePanel");
    const text = document.getElementById("updateText");
    if (!panel || !text) return;
    const available = response?.ok === true
      && response.available === true
      && response.signatureStatus === "valid"
      && /^\d+\.\d+\.\d+$/.test(String(response.version || ""));
    panel.hidden = !available;
    if (available) text.textContent = `Có bản cập nhật ${response.version}`;
  }

  function statusCopy(diagnostic) {
    if (diagnostic.component === "provider-content") {
      const providerName = diagnostic.provider === "gemini" ? "Gemini" : "ChatGPT";
      const runtimeDetails = {
        preparing: "Extension đang chuẩn bị phiên AI.",
        sending: "Extension đang điền và gửi tin nhắn.",
        waiting_response: `Đang chờ ${providerName} trả lời cho pha ${diagnostic.runtime.phase}.`,
        completed: "Phản hồi gần nhất đã được extension tiếp nhận.",
        error: `Adapter vừa gặp lỗi: ${diagnostic.runtime.errorCode}.`,
        cancelled: "Tác vụ gần nhất đã bị hủy.",
        idle: "Hiện không có tin nhắn nào đang được xử lý."
      };
      return diagnostic.status === "ready"
        ? {
          pill: "Đã kết nối",
          title: `${providerName} đã sẵn sàng`,
          detail: runtimeDetails[diagnostic.runtime.stage] || runtimeDetails.idle
        }
        : {
          pill: "Cần kiểm tra",
          title: `Chưa thể điều khiển ${providerName}`,
          detail: diagnostic.adapter.code === "ui_changed"
            ? "Không nhận diện được ô nhập hoặc giao diện AI vừa thay đổi."
            : `Trạng thái adapter: ${diagnostic.adapter.code}.`
        };
    }
    const values = {
      active: {
        pill: "Đang bật",
        title: "Tiện ích đang hoạt động",
        detail: "Đã nhận diện chương và thanh dịch trên trang hiện tại."
      },
      toolbar_missing: {
        pill: "Cần kiểm tra",
        title: "Đã thấy chương, chưa thấy thanh dịch",
        detail: "Hãy sao chép chẩn đoán và gửi lại để kiểm tra bước khởi tạo giao diện."
      },
      extraction_failed: {
        pill: "Không đọc được nguồn",
        title: "Đã thấy chương nhưng chưa thể đọc nguyên văn",
        detail: diagnostic.extraction.errorCode === "SOURCE_NOT_CHINESE"
          ? "Dữ liệu nguồn hiện không đủ ký tự tiếng Trung để dịch an toàn."
          : diagnostic.extraction.errorCode === "SOURCE_NOT_FOUND"
            ? "Các thẻ nguồn có mặt nhưng không tạo được đoạn nguyên văn khả dụng."
            : "Bước đọc nguyên văn gặp lỗi không xác định; hãy sao chép chẩn đoán và gửi lại."
      },
      source_missing: {
        pill: "Thiếu nguồn Trung",
        title: "Không tìm thấy thẻ nguyên văn Trung",
        detail: "Nguồn truyện này có thể dùng cấu trúc khác với i[t]."
      },
      chapter_root_missing: {
        pill: "Thiếu vùng chương",
        title: "Không tìm thấy vùng nội dung chương",
        detail: "Trang có thể chưa tải xong hoặc Sáng Tác Việt đã đổi cấu trúc."
      },
      not_chapter: {
        pill: "Không hỗ trợ",
        title: "Tab này không phải trang chương",
        detail: "Mở một chương Sáng Tác Việt rồi bấm lại biểu tượng S."
      }
    };
    return values[diagnostic.status] || values.not_chapter;
  }

  function printableCount(value) {
    if (value === "many") return "Nhiều";
    return String(value || "0").replace("-", "–");
  }

  function renderDiagnostic(document, diagnostic) {
    const copy = statusCopy(diagnostic);
    const app = document.getElementById("popupApp");
    const providerPage = diagnostic.component === "provider-content";
    app.dataset.state = providerPage ? (diagnostic.status === "ready" ? "active" : "toolbar_missing") : diagnostic.status;
    app.setAttribute("aria-busy", "false");
    document.getElementById("statusPill").textContent = copy.pill;
    document.getElementById("statusTitle").textContent = copy.title;
    document.getElementById("statusDetail").textContent = copy.detail;
    document.getElementById("metricLabelOne").textContent = providerPage ? "Ô nhập" : "Vùng chương";
    document.getElementById("metricLabelTwo").textContent = providerPage ? "Nút gửi" : "Thẻ nguồn Trung";
    document.getElementById("metricLabelThree").textContent = providerPage ? "Phản hồi" : "Thanh dịch";
    document.getElementById("chapterRootCount").textContent = printableCount(
      providerPage ? diagnostic.selectors.composer : diagnostic.selectors.strictChapterRoot
    );
    document.getElementById("sourceMarkerCount").textContent = printableCount(
      providerPage ? diagnostic.selectors.sendButton : diagnostic.selectors.sourceMarkersInRoot
    );
    document.getElementById("toolbarCount").textContent = printableCount(
      providerPage ? diagnostic.selectors.responses : diagnostic.selectors.toolbar
    );
    document.getElementById("exportDiagnostic").disabled = false;
  }

  function renderUnavailable(document) {
    const app = document.getElementById("popupApp");
    app.dataset.state = "unavailable";
    app.setAttribute("aria-busy", "false");
    document.getElementById("statusPill").textContent = "Cần tải lại";
    document.getElementById("statusTitle").textContent = "Chưa kết nối được với trang";
    document.getElementById("statusDetail").textContent = "Hãy mở đúng chương STV, tải lại trang rồi bấm biểu tượng S lần nữa.";
    document.getElementById("exportDiagnostic").disabled = true;
  }

  function renderStoredError(document, report) {
    const incident = sanitizeErrorReport(report).incident;
    if (!incident) return false;
    const app = document.getElementById("popupApp");
    app.dataset.state = "toolbar_missing";
    app.setAttribute("aria-busy", "false");
    document.getElementById("statusPill").textContent = "Lỗi gần đây";
    document.getElementById("statusTitle").textContent = "Có báo cáo lỗi trong 1 giờ qua";
    document.getElementById("statusDetail").textContent = incident.outcome === "recovered"
      ? "Lỗi gần nhất đã tự phục hồi; báo cáo vẫn còn để đối chiếu."
      : "Tab gây lỗi có thể đã đóng; bạn vẫn có thể sao chép báo cáo bên dưới.";
    document.getElementById("exportDiagnostic").disabled = false;
    return true;
  }

  function renderNoRecentError(document) {
    const app = document.getElementById("popupApp");
    app.dataset.state = "unavailable";
    app.setAttribute("aria-busy", "false");
    document.getElementById("statusPill").textContent = "Không có lỗi";
    document.getElementById("statusTitle").textContent = "Không có lỗi trong 1 giờ qua";
    document.getElementById("statusDetail").textContent = "Nhật ký lỗi đang trống.";
    document.getElementById("exportDiagnostic").disabled = true;
  }

  async function initPopup({ document, chromeApi, copyText = defaultCopyText, distribution = defaultDistribution }) {
    if (!document || !chromeApi?.tabs) throw new TypeError("document and chrome.tabs are required");
    const exportButton = document.getElementById("exportDiagnostic");
    const clearErrorLog = document.getElementById("clearErrorLog");
    const liveStatus = document.getElementById("liveStatus");
    const toolToggle = document.getElementById("toolToggle");
    let diagnostic;
    let activeTab;
    let toolEnabled = false;
    const externalUpdates = distribution?.usesExternalUpdater?.() !== false;
    const updateRow = document.querySelector(".update-row");
    if (updateRow) updateRow.hidden = !externalUpdates;
    const canCheckUpdate = externalUpdates && typeof chromeApi.runtime?.sendMessage === "function";
    const initialUpdate = canCheckUpdate
      ? runtimeMessage(chromeApi, { type: GET_UPDATE_STATUS }).catch(() => null)
      : Promise.resolve(null);

    document.getElementById("checkUpdate")?.addEventListener("click", async () => {
      const button = document.getElementById("checkUpdate");
      if (!canCheckUpdate || button.disabled) return;
      button.disabled = true;
      button.textContent = "Đang kiểm tra…";
      try {
        const response = await runtimeMessage(chromeApi, { type: CHECK_UPDATE });
        renderUpdateStatus(document, response);
        liveStatus.textContent = response?.available === true
          ? "Có bản cập nhật."
          : response?.errorCode === "none" && response?.signatureStatus === "valid"
            ? "Đang dùng bản mới nhất."
            : "Chưa kiểm tra được cập nhật.";
      } catch (_error) {
        liveStatus.textContent = "Chưa kiểm tra được cập nhật.";
      } finally {
        button.disabled = false;
        button.textContent = "Kiểm tra cập nhật";
      }
    });

    document.getElementById("openUpdate")?.addEventListener("click", async () => {
      const button = document.getElementById("openUpdate");
      if (!canCheckUpdate || button.disabled) return;
      button.disabled = true;
      try {
        const response = await runtimeMessage(chromeApi, { type: OPEN_UPDATE });
        if (!response?.ok) throw new Error(response?.reason || "update-unavailable");
      } catch (_error) {
        liveStatus.textContent = "Không mở được bản cập nhật.";
      } finally {
        button.disabled = false;
      }
    });

    toolToggle.addEventListener("click", async () => {
      if (toolToggle.disabled) return;
      const nextEnabled = !toolEnabled;
      toolToggle.disabled = true;
      liveStatus.textContent = nextEnabled ? "Đang bật công cụ…" : "Đang tắt và dọn tab AI…";
      try {
        const response = await runtimeMessage(chromeApi, { type: SET_TOOL_ENABLED, enabled: nextEnabled });
        if (!response?.ok) throw new Error(response?.reason || "toggle-failed");
        toolEnabled = response.enabled === true;
        renderToolToggle(document, toolEnabled);
        let pageUpdated = true;
        if (Number.isInteger(activeTab?.id) && diagnostic?.component === "stv-content") {
          const pageResponse = await callbackCall(chromeApi, (callback) => chromeApi.tabs.sendMessage(
            activeTab.id,
            { type: "STVAI_TOOL_ENABLED_CHANGED", enabled: toolEnabled },
            callback
          )).catch(() => null);
          pageUpdated = pageResponse?.ok === true;
        }
        liveStatus.textContent = pageUpdated
          ? toolEnabled ? "Đã bật công cụ." : "Đã tắt công cụ."
          : "Đã lưu trạng thái. Phiên extension cũ cần bạn tải lại trang một lần.";
      } catch (_error) {
        renderToolToggle(document, toolEnabled);
        liveStatus.textContent = "Không đổi được trạng thái. Hãy tải lại tiện ích rồi thử lại.";
      }
    });

    document.getElementById("openSettings").addEventListener("click", () => {
      const possiblePromise = chromeApi.runtime?.openOptionsPage?.();
      if (possiblePromise && typeof possiblePromise.catch === "function") {
        possiblePromise.catch(() => undefined);
      }
    });
    exportButton.addEventListener("click", async () => {
      exportButton.disabled = true;
      try {
        let support;
        const errorResponse = await runtimeMessage(chromeApi, { type: GET_ERROR_REPORT }).catch(() => null);
        const errorReport = errorResponse?.ok ? errorResponse.report : undefined;
        if (diagnostic?.component === "stv-content" && Number.isInteger(activeTab?.id)) {
          const response = await runtimeMessage(chromeApi, {
            type: "STVAI_GET_SUPPORT_DIAGNOSTICS",
            sourceTabId: activeTab.id
          }).catch(() => null);
          if (response?.ok) support = response.support;
        }
        const text = `${JSON.stringify(createExportPayload(diagnostic, support, errorReport), null, 2)}\n`;
        await copyText(text, document);
        liveStatus.textContent = errorReport?.incident
          ? "Đã sao chép lỗi mới nhất. Bạn có thể dán trực tiếp vào chat."
          : "Không có lỗi trong 1 giờ qua; đã sao chép trạng thái hiện tại.";
      } catch (_error) {
        liveStatus.textContent = "Không sao chép được. Hãy thử lại hoặc kiểm tra quyền clipboard.";
      } finally {
        exportButton.disabled = false;
      }
    });
    clearErrorLog.addEventListener("click", async () => {
      clearErrorLog.disabled = true;
      try {
        const response = await runtimeMessage(chromeApi, { type: CLEAR_ERROR_LOG });
        if (!response?.ok) throw new Error("clear-failed");
        if (!diagnostic) renderNoRecentError(document);
        liveStatus.textContent = "Đã xóa nhật ký lỗi. Cache và cài đặt được giữ nguyên.";
      } catch (_error) {
        liveStatus.textContent = "Không xóa được nhật ký lỗi.";
      } finally {
        clearErrorLog.disabled = false;
      }
    });

    try {
      const tabs = await queryActiveTab(chromeApi);
      activeTab = Array.isArray(tabs) ? tabs[0] : undefined;
      const tabId = activeTab?.id;
      if (!Number.isInteger(tabId)) throw new Error("Active tab unavailable");
      const response = await requestDiagnostic(chromeApi, tabId);
      if (!response?.ok || !response.diagnostic) throw new Error("Diagnostic unavailable");
      diagnostic = sanitizeDiagnostic(response.diagnostic);
      renderDiagnostic(document, diagnostic);
    } catch (_error) {
      diagnostic = undefined;
      const errorResponse = await runtimeMessage(chromeApi, { type: GET_ERROR_REPORT }).catch(() => null);
      if (!errorResponse?.ok) renderUnavailable(document);
      else if (!renderStoredError(document, errorResponse.report)) renderNoRecentError(document);
    }

    try {
      const response = await runtimeMessage(chromeApi, { type: GET_TOOL_ENABLED });
      toolEnabled = response?.ok === true && response.enabled === true;
    } catch (_error) {
      toolEnabled = false;
    }
    renderToolToggle(document, toolEnabled);
    if (externalUpdates) renderUpdateStatus(document, await initialUpdate);

    return Object.freeze({ get diagnostic() { return diagnostic; } });
  }

  return Object.freeze({
    MESSAGE_TYPE,
    GET_TOOL_ENABLED,
    SET_TOOL_ENABLED,
    GET_UPDATE_STATUS,
    CHECK_UPDATE,
    OPEN_UPDATE,
    sanitizeDiagnostic,
    sanitizeSupport,
    sanitizeErrorReport,
    createExportPayload,
    initPopup
  });
});
