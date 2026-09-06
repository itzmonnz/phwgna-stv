(function attachProviderDiagnostics(root, factory) {
  const api = factory(root.STVAIProviderCommon || (typeof require === "function" ? require("./provider-common.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIProviderDiagnostics = api;

  const inExtensionPage = typeof module !== "object"
    && root.document
    && root.location
    && root.chrome?.runtime?.onMessage;
  if (inExtensionPage) {
    api.registerProviderDiagnosticListener({
      runtime: root.chrome.runtime,
      document: root.document,
      location: root.location,
      rootObject: root
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createProviderDiagnosticsApi(common) {
  "use strict";

  const MESSAGE_TYPE = "STVAI_GET_PAGE_DIAGNOSTICS";
  const COMPOSERS = [
    "[contenteditable='true'][role='textbox']",
    "#prompt-textarea[contenteditable='true']",
    "textarea"
  ];
  const SEND_BUTTONS = [
    "button[aria-label^='Send' i]",
    "button[aria-label^='Gửi' i]",
    "button.send-button",
    ".send-button button"
  ];
  const RESPONSES = ["model-response", "[data-message-author-role='assistant']"];
  const TEMPORARY_CONTROLS = [
    "[aria-label*='Temporary chat' i]",
    "[aria-label*='trò chuyện tạm thời' i]",
    "[data-test-id*='temporary-chat']",
    "[data-testid*='temporary-chat']"
  ];

  function countBucket(count) {
    const value = Number(count) || 0;
    if (value <= 0) return "0";
    if (value === 1) return "1";
    return "many";
  }

  function countSelectors(document, selectors) {
    const elements = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) elements.add(element);
    }
    return countBucket(elements.size);
  }

  function safeEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function providerFor(location) {
    if (location.origin === "https://chatgpt.com") return "chatgpt";
    if (location.origin === "https://gemini.google.com") return "gemini";
    return "unknown";
  }

  function classifyComposer(document) {
    const candidates = [
      ["role_textbox", "[contenteditable='true'][role='textbox']"],
      ["prompt_textarea", "#prompt-textarea[contenteditable='true']"],
      ["textarea", "textarea"]
    ];
    for (const [selectorName, selector] of candidates) {
      const element = document.querySelector(selector);
      if (!element) continue;
      return {
        selector: selectorName,
        empty: !String(element.textContent || element.value || "").trim(),
        disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true"
      };
    }
    return { selector: "none", empty: true, disabled: false };
  }

  function classifyAction(button) {
    return common?.classifyAction(button) || null;
  }

  function classifyActions(document) {
    return Array.from(document.querySelectorAll("button"))
      .map(classifyAction)
      .filter(Boolean)
      .slice(0, 8);
  }

  function classifyTemporary(document, location, runtime = {}) {
    const controls = Array.from(new Set(TEMPORARY_CONTROLS.flatMap((selector) => (
      Array.from(document.querySelectorAll(selector))
    ))));
    const pressedValues = new Set(controls.map((control) => control.getAttribute("aria-pressed"))
      .filter((value) => value === "true" || value === "false"));
    const labels = controls.map((control) => control.getAttribute("aria-label") || "").join(" ");
    let urlFlag = "off";
    try {
      urlFlag = new URL(location.href).searchParams.get("temporary-chat") === "true" ? "on" : "off";
    } catch (_error) {
      urlFlag = "unknown";
    }
    const headingActive = Array.from(document.querySelectorAll("h1, h2, [role='heading']")).some((heading) => (
      /^(?:temporary chat|trò chuyện tạm thời|cuộc trò chuyện tạm thời)$/i.test(String(heading.textContent || "").trim())
    ));
    let state = "normal";
    let selector = "none";
    if (location.origin === "https://gemini.google.com") {
      const chatWindow = document.querySelector("chat-window.is-temporary-chat");
      const topIndicator = document.querySelector(
        "[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-on"
      );
      const launcher = document.querySelector(
        "side-nav-sparkle-button > button[data-test-id='side-nav-sparkle-button']"
      );
      const topLauncher = document.querySelector(
        "[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-button:not(.temp-chat-on) > button"
      );
      if (chatWindow) {
        state = "verified_temp";
        selector = "chat_window_class";
      } else if (topIndicator) {
        state = "verified_temp";
        selector = "top_indicator";
      } else if (topLauncher) {
        state = "normal";
        selector = "top_bar_launcher";
      } else if (launcher?.disabled || launcher?.getAttribute("aria-disabled") === "true") {
        state = "activating";
        selector = "disabled_launcher";
      } else if (!launcher && ["preparing", "sending", "waiting_response"].includes(runtime.stage)) {
        state = "lost_temp";
      }
    }
    return {
      state,
      selector,
      urlFlag,
      heading: headingActive ? "active" : "absent",
      controlCount: countBucket(controls.length),
      pressed: pressedValues.size === 1 ? Array.from(pressedValues)[0] : pressedValues.size > 1 ? "mixed" : "unknown",
      intent: /(?:turn off|disable|exit|tắt|thoát)/i.test(labels)
        ? "disable"
        : /(?:turn on|enable|start|bật)/i.test(labels) ? "enable" : "unknown"
    };
  }

  const DOM_ROLES = [
    "composer", "send", "stop", "response", "completion", "temporaryLauncher", "temporaryActive"
  ];
  const DOM_SOURCES = ["bundled", "local", "scanner", "none"];
  const DOM_CONFIDENCE = ["high", "medium", "low"];
  const DOM_REASONS = ["selector_match", "profile_match", "semantic_match", "no_safe_candidate", "not_checked"];
  const DOM_COUNTS = ["0", "1", "2-5", "6+"];
  const DOM_SEMANTICS = ["", "send", "gửi", "stop", "dừng", "temporary", "tạm thời", "chat", "trò chuyện", "prompt", "message", "tin nhắn"];
  const STABLE_CLASS_WORDS = /send|stop|temp|chat|prompt|composer|response|footer|markdown|editor|textarea/i;

  function safeDomName(value, limit = 40) {
    const text = String(value || "").toLowerCase();
    return /^[a-z0-9_-]+$/i.test(text) ? text.slice(0, limit) : "";
  }

  function sanitizeDomResolution(value) {
    const input = value && typeof value === "object" ? value : {};
    const roles = {};
    for (const role of DOM_ROLES) {
      const raw = input.roles?.[role];
      if (!raw || typeof raw !== "object") continue;
      roles[role] = {
        source: safeEnum(raw.source, DOM_SOURCES, "none"),
        profileId: /^[a-z0-9_-]{1,80}$/i.test(String(raw.profileId || "")) ? String(raw.profileId) : "",
        confidence: safeEnum(raw.confidence, DOM_CONFIDENCE, "low"),
        reason: safeEnum(raw.reason, DOM_REASONS, "not_checked"),
        candidateCount: safeEnum(raw.candidateCount, DOM_COUNTS, "0")
      };
    }
    const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, DOM_ROLES.length).map(raw => {
      if (!raw || typeof raw !== "object" || !DOM_ROLES.includes(raw.role)) return null;
      return {
        role: raw.role,
        tag: safeDomName(raw.tag) || "unknown",
        parentTag: safeDomName(raw.parentTag),
        roleAttribute: safeDomName(raw.roleAttribute),
        contenteditable: raw.contenteditable === true,
        semantic: safeEnum(String(raw.semantic || "").toLowerCase(), DOM_SEMANTICS, ""),
        classHints: Array.isArray(raw.classHints) ? raw.classHints.filter(item => (
          typeof item === "string" && item.length <= 80 && STABLE_CLASS_WORDS.test(item)
        )).slice(0, 8) : [],
        disabled: raw.disabled === true,
        hidden: raw.hidden === true
      };
    }).filter(Boolean) : [];
    return {
      schemaVersion: 1,
      localProfileCount: Math.max(0, Math.min(5, Number(input.localProfileCount) || 0)),
      roles,
      evidence
    };
  }

  function createProviderDiagnosticSnapshot(options) {
    const document = options?.document;
    const location = options?.location;
    if (!document?.querySelectorAll || !location) throw new TypeError("document and location are required");
    const runtime = options.runtimeState && typeof options.runtimeState === "object"
      ? options.runtimeState
      : {};
    const adapterStatus = options.adapterStatus && typeof options.adapterStatus === "object"
      ? options.adapterStatus
      : {};
    return {
      schemaVersion: 3,
      component: "provider-content",
      extensionVersion: typeof options.extensionVersion === "string" ? options.extensionVersion : "unknown",
      provider: providerFor(location),
      status: adapterStatus.state === "ready" ? "ready" : "blocked",
      page: {
        readyState: safeEnum(document.readyState, ["loading", "interactive", "complete"], "unknown"),
        bodyPresent: Boolean(document.body)
      },
      adapter: {
        loaded: options.adapterLoaded === true,
        state: safeEnum(adapterStatus.state, ["ready", "paused"], "unknown"),
        code: safeEnum(adapterStatus.code, [
          "none", "captcha", "login_required", "security_verification", "login_browser_rejected", "rate_limited", "ui_changed", "ab_comparison",
          "temporary_unavailable"
        ], adapterStatus.state === "ready" ? "none" : "unknown")
      },
      selectors: {
        composer: countSelectors(document, COMPOSERS),
        sendButton: countSelectors(document, SEND_BUTTONS),
        responses: countSelectors(document, RESPONSES),
        temporaryControl: countSelectors(document, TEMPORARY_CONTROLS)
      },
      interaction: {
        composer: classifyComposer(document),
        actions: classifyActions(document),
        temporary: classifyTemporary(document, location, runtime)
      },
      domResolution: sanitizeDomResolution(options.domResolution),
      runtime: {
        stage: safeEnum(runtime.stage, [
          "idle", "preparing", "sending", "waiting_response", "completed", "error", "cancelled"
        ], "idle"),
        phase: safeEnum(runtime.phase, ["idle", "setup", "batch", "repair"], "idle"),
        errorCode: safeEnum(runtime.errorCode, [
          "none", "response_timeout", "send_not_confirmed", "provider_busy", "provider_busy_timeout", "provider_unreachable", "captcha",
          "login_required", "security_verification", "login_browser_rejected", "rate_limited", "ui_changed", "ab_comparison", "temporary_unavailable",
          "provider_error", "cancelled", "content_refused", "incomplete_response",
          "recovering_response", "fallback_unavailable"
        ], "none"),
        readyStep: safeEnum(runtime.readyStep, ["idle", "ready_1", "ready_2", "ready_3"], "idle"),
        readyState: safeEnum(runtime.readyState, [
          "idle", "waiting_marker", "marker_seen", "grace", "confirmed", "failed"
        ], "idle"),
        readyFirstSeenAt: Math.max(0, Number(runtime.readyFirstSeenAt) || 0),
        stablePolls: Math.max(0, Math.min(2, Number(runtime.stablePolls) || 0)),
        timeoutMs: Math.max(0, Math.min(60_000, Number(runtime.timeoutMs) || 0)),
        graceMs: Math.max(0, Math.min(10_000, Number(runtime.graceMs) || 0)),
        batchAttempt: Math.max(0, Math.min(3, Number(runtime.batchAttempt) || 0)),
        expectedCount: Math.max(0, Math.min(10000, Number(runtime.expectedCount) || 0)),
        actualCount: Math.max(0, Math.min(10000, Number(runtime.actualCount) || 0)),
        validationReason: safeEnum(runtime.validationReason, [
          "none", "ok", "line_count_mismatch", "response_id_mismatch", "invalid_response",
          "ready_marker_missing", "ready_marker_mismatch", "ready_receipt_mismatch"
        ], "other"),
        generationState: safeEnum(runtime.generationState, ["generating", "stopped", "stale_stop_confirmed", "unknown"], "unknown"),
        sendState: safeEnum(runtime.sendState, ["idle", "pending", "confirmed", "reconciled", "unconfirmed"], "idle"),
        performanceMode: safeEnum(runtime.performanceMode, ["off", "stable", "max"], "off"),
        pageVisibility: safeEnum(runtime.pageVisibility, ["visible", "hidden", "prerender", "unknown"], "unknown"),
        pageFocused: runtime.pageFocused === true,
        sendConfirmedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.sendConfirmedAt) || 0)),
        firstMutationAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.firstMutationAt) || 0)),
        completionSeenAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.completionSeenAt) || 0)),
        acceptedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(runtime.acceptedAt) || 0)),
        composerState: safeEnum(runtime.composerState, ["not_found", "empty_before_write", "filled", "write_failed", "cleared_after_send"], "not_found"),
        composerLengthBucket: safeEnum(runtime.composerLengthBucket, ["0", "1-100", "101-1000", "1001-5000", "5001+"], "0"),
        inputEventDispatched: runtime.inputEventDispatched === true,
        sendButtonState: safeEnum(runtime.sendButtonState, ["not_found", "disabled", "enabled", "clicked", "stop_visible",
          "submission_confirmed", "click_unconfirmed"], "not_found"),
        clickAttempted: runtime.clickAttempted === true,
        submissionConfirmed: runtime.submissionConfirmed === true,
        requestAlreadyPresent: runtime.requestAlreadyPresent === true
      }
    };
  }

  function registerProviderDiagnosticListener(options) {
    const runtime = options?.runtime;
    if (!runtime?.onMessage?.addListener) throw new TypeError("runtime.onMessage is required");
    const rootObject = options.rootObject || {};
    const listener = (message, _sender, sendResponse) => {
      if (message?.type !== MESSAGE_TYPE) return false;
      Promise.resolve().then(async () => {
        const provider = providerFor(options.location);
        const adapterApi = provider === "chatgpt" ? rootObject.STVAIChatGPT : rootObject.STVAIGemini;
        let adapterStatus = { state: "paused", code: "ui_changed" };
        let domResolution;
        try {
          const adapterOptions = provider === "gemini" && adapterApi?.createProfileStorage
            ? { profileStorage: adapterApi.createProfileStorage(rootObject.chrome) }
            : undefined;
          const adapter = adapterApi?.[`create${provider === "chatgpt" ? "ChatGPT" : "Gemini"}Adapter`]?.(
            options.document,
            adapterOptions
          );
          await adapter?.ready?.();
          if (adapter?.getStatus) adapterStatus = adapter.getStatus();
          if (adapter?.getDomDiagnostic) domResolution = adapter.getDomDiagnostic();
        } catch (_error) {
          // Snapshot remains structural and safe when an adapter cannot be created.
        }
        const diagnostic = createProviderDiagnosticSnapshot({
          document: options.document,
          location: options.location,
          extensionVersion: runtime.getManifest?.()?.version,
          adapterLoaded: Boolean(adapterApi),
          adapterStatus,
          domResolution,
          runtimeState: rootObject.STVAIProviderCommon?.getDiagnosticState?.()
        });
        sendResponse?.({ ok: true, diagnostic });
      });
      return true;
    };
    runtime.onMessage.addListener(listener);
    return () => runtime.onMessage.removeListener?.(listener);
  }

  return Object.freeze({
    MESSAGE_TYPE,
    countBucket,
    createProviderDiagnosticSnapshot,
    sanitizeDomResolution,
    registerProviderDiagnosticListener
  });
});
