(function attachProviderCommon(root, factory) {
  const api = factory(root.STVAICore || (typeof require === "function" ? require("../shared/core.js") : null));
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAIProviderCommon = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createProviderCommon(core) {
  "use strict";

  const diagnosticState = {
    stage: "idle",
    phase: "idle",
    errorCode: "none",
    readyStep: "idle",
    readyState: "idle",
    readyFirstSeenAt: 0,
    stablePolls: 0,
    timeoutMs: 0,
    graceMs: 0,
    batchAttempt: 0,
    expectedCount: 0,
    actualCount: 0,
    validationReason: "none",
    generationState: "unknown",
    sendState: "idle",
    performanceMode: "off",
    pageVisibility: "unknown",
    pageFocused: false,
    sendConfirmedAt: 0,
    firstMutationAt: 0,
    completionSeenAt: 0,
    acceptedAt: 0,
    composerState: "not_found",
    composerLengthBucket: "0",
    inputEventDispatched: false,
    sendButtonState: "not_found",
    clickAttempted: false,
    submissionConfirmed: false,
    requestAlreadyPresent: false
  };

  function setDiagnosticState(stage, phase, errorCode = "none") {
    diagnosticState.stage = stage;
    diagnosticState.phase = ["setup", "batch", "repair"].includes(phase) ? phase : "idle";
    diagnosticState.errorCode = typeof errorCode === "string" ? errorCode : "provider_error";
  }

  function resetReadyDiagnostic(message) {
    const isSetup = message?.phase === "setup";
    diagnosticState.readyStep = isSetup
      ? `ready_${Math.max(1, (Number(message.setupIndex) || 0) + 1)}`
      : "idle";
    diagnosticState.readyState = isSetup ? "waiting_marker" : "idle";
    diagnosticState.readyFirstSeenAt = 0;
    diagnosticState.stablePolls = 0;
    diagnosticState.timeoutMs = isSetup ? Math.max(0, Number(message.timeoutMs) || 0) : 0;
    diagnosticState.graceMs = isSetup ? Math.max(0, Number(message.markerGraceMs) || 0) : 0;
  }

  function updateReadyDiagnostic(state) {
    diagnosticState.readyState = String(state?.state || diagnosticState.readyState);
    diagnosticState.readyFirstSeenAt = Math.max(0, Number(state?.firstSeenAt) || 0);
    diagnosticState.stablePolls = Math.max(0, Number(state?.stablePolls) || 0);
  }

  function getDiagnosticState() {
    return { ...diagnosticState };
  }

  function updateSubmissionDiagnostic(adapter) {
    const value = adapter.getSubmissionDiagnostic?.();
    if (!value || typeof value !== "object") return false;
    diagnosticState.composerState = ["not_found", "empty_before_write", "filled", "write_failed", "cleared_after_send"]
      .includes(value.composerState) ? value.composerState : "not_found";
    diagnosticState.composerLengthBucket = ["0", "1-100", "101-1000", "1001-5000", "5001+"]
      .includes(value.composerLengthBucket) ? value.composerLengthBucket : "0";
    diagnosticState.inputEventDispatched = value.inputEventDispatched === true;
    diagnosticState.sendButtonState = ["not_found", "disabled", "enabled", "clicked", "stop_visible",
      "submission_confirmed", "click_unconfirmed"].includes(value.sendButtonState) ? value.sendButtonState : "not_found";
    diagnosticState.clickAttempted = value.clickAttempted === true;
    diagnosticState.submissionConfirmed = value.submissionConfirmed === true;
    diagnosticState.requestAlreadyPresent = value.requestAlreadyPresent === true;
    return true;
  }

  class ProviderError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ProviderError";
      this.code = code;
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function isVisible(element) {
    if (!element) return false;
    const view = element.ownerDocument?.defaultView;
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const inlineStyle = current.getAttribute("style") || "";
      if (/(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))/i.test(inlineStyle)) return false;
      if (view?.getComputedStyle) {
        const computed = view.getComputedStyle(current);
        if (computed.display === "none" || computed.visibility === "hidden" || computed.visibility === "collapse") {
          return false;
        }
      }
    }
    return true;
  }

  function findVisible(document, selectors) {
    for (const selector of selectors) {
      const match = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (match) return match;
    }
    return null;
  }

  function textOf(element) {
    if (!element) return "";
    return String(element.innerText || element.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function pageHasText(document, selectors, pattern) {
    return selectors.some((selector) => Array.from(document.querySelectorAll(selector))
      .some((element) => isVisible(element) && pattern.test(textOf(element))));
  }

  function setComposerText(composer, value, options = {}) {
    if (options.focus !== false) composer.focus();
    if (composer instanceof composer.ownerDocument.defaultView.HTMLTextAreaElement
      || composer instanceof composer.ownerDocument.defaultView.HTMLInputElement) {
      composer.value = value;
    } else {
      const lines = String(value).split("\n");
      const nodes = [];
      lines.forEach((line, index) => {
        if (index > 0) nodes.push(composer.ownerDocument.createElement("br"));
        if (line) nodes.push(composer.ownerDocument.createTextNode(line));
      });
      composer.replaceChildren(...nodes);
    }
    const view = composer.ownerDocument.defaultView;
    const InputEventClass = view.InputEvent || view.Event;
    composer.dispatchEvent(new InputEventClass("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
  }

  function buttonIsEnabled(button) {
    return Boolean(button)
      && isVisible(button)
      && !button.disabled
      && button.getAttribute("aria-disabled") !== "true";
  }

  // Share the same signals with diagnostics: a stale Send label must not mask Stop.
  function classifyAction(button) {
    if (!button) return null;
    const signals = [
      ["aria", `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`],
      ["testid", `${button.getAttribute("data-testid") || ""} ${button.getAttribute("data-test-id") || ""}`],
      ["icon", [textOf(button), ...Array.from(button.querySelectorAll("mat-icon, [data-icon-name], [data-icon], [aria-label], [title]"))
        .flatMap(element => [textOf(element), element.getAttribute("data-icon-name"), element.getAttribute("data-icon"),
          element.getAttribute("aria-label"), element.getAttribute("title")])].filter(Boolean).join(" ")],
      ["class", `${typeof button.className === "string" ? button.className : ""} ${typeof button.parentElement?.className === "string" ? button.parentElement.className : ""}`]
    ];
    for (const [kind, pattern] of [["stop", /(?:^|\W)(?:stop|dừng)(?:\W|$)/i], ["send", /(?:^|\W)(?:send|gửi)(?:\W|$)/i]]) {
      for (const [signal, value] of signals) {
        if (pattern.test(value)) return { kind, signal, enabled: buttonIsEnabled(button) };
      }
    }
    return null;
  }

  async function waitForChangeOrTimer(options, intervalMs, sleep) {
    if (typeof options.waitForChange === "function") {
      const event = await options.waitForChange({ timeoutMs: intervalMs, signal: options.signal });
      options.onWaitSignal?.(event);
      return;
    }
    await sleep(intervalMs);
  }

  async function waitForElement(readElement, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const intervalMs = options.intervalMs ?? 100;
    const now = options.now || Date.now;
    const sleep = options.sleep || delay;
    const start = now();

    while (true) {
      if (options.signal?.aborted) {
        throw new ProviderError("cancelled", "Tác vụ đã bị hủy.");
      }
      const element = readElement();
      if (element) return element;
      if (now() - start >= timeoutMs) {
        throw new ProviderError("ui_changed", "Không tìm thấy điều khiển cần thiết trên trang AI.");
      }
      await waitForChangeOrTimer(options, intervalMs, sleep);
    }
  }

  async function waitForStableResponse(readResponse, options = {}) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 500;
    const now = options.now || Date.now;
    const sleep = options.sleep || delay;
    const ignored = String(options.ignoreValue || "").trim();
    const acceptValue = typeof options.acceptValue === "function" ? options.acceptValue : () => true;
    const normalizeValue = typeof options.normalizeValue === "function"
      ? options.normalizeValue
      : (value) => value;
    const start = now();
    const primaryDeadline = start + timeoutMs;
    const markerGraceMs = Math.max(0, Number(options.markerGraceMs) || 0);
    const onStabilityChange = typeof options.onStabilityChange === "function"
      ? options.onStabilityChange
      : () => {};
    let previous = "";
    let matchingPolls = 0;
    let markerFirstSeenAt = null;
    let graceActive = false;
    let reportedState = "";

    function report(state) {
      if (state === reportedState && state !== "marker_seen") return;
      reportedState = state;
      onStabilityChange({
        state,
        firstSeenAt: markerFirstSeenAt ?? 0,
        stablePolls: matchingPolls,
        timeoutMs,
        graceMs: markerGraceMs
      });
    }

    report("waiting_marker");

    while (true) {
      if (options.signal?.aborted) {
        throw new ProviderError("cancelled", "Tác vụ đã bị hủy.");
      }

      const current = String(normalizeValue(await readResponse()) || "").trim();
      if (current && current !== ignored && acceptValue(current)) {
        if (markerFirstSeenAt === null) {
          markerFirstSeenAt = now();
          report("marker_seen");
        }
        if (current === previous) {
          matchingPolls += 1;
        } else {
          previous = current;
          matchingPolls = 1;
        }
        if (matchingPolls >= 2) {
          report("confirmed");
          return current;
        }
      } else {
        previous = "";
        matchingPolls = 0;
      }

      const currentTime = now();
      if (!graceActive && currentTime >= primaryDeadline && markerFirstSeenAt !== null && markerGraceMs > 0) {
        graceActive = true;
        report("grace");
      }
      const deadline = graceActive ? primaryDeadline + markerGraceMs : primaryDeadline;
      if (currentTime >= deadline) {
        report("failed");
        throw new ProviderError("response_timeout", "Đã hết thời gian chờ phản hồi ổn định từ trang AI.");
      }
      await waitForChangeOrTimer(options, intervalMs, sleep);
    }
  }

  function classifyTerminalResponse(raw, message, terminalCode) {
    if (terminalCode) return String(terminalCode);
    const text = String(raw || "").trim();
    const requestId = String(message?.requestId || message?.batchId || "");
    if (text.split(/\r?\n/, 1)[0]?.trim() === requestId) return "incomplete_response";
    const header = text.match(/^STVAI_RESULT\s+(\S+)\s+(\S+)/);
    if (header
      && header[1] === String(message?.jobId || "")
      && header[2] === requestId) {
      return "incomplete_response";
    }
    const value = parseJsonObject(text);
    if (value
      && String(value.job_id) === String(message?.jobId || "")
      && String(value.batch_id) === requestId) {
      return "incomplete_response";
    }
    if (/\b(?:i (?:am sorry|cannot|can't|won't)|unable to (?:help|assist|comply)|content (?:was )?blocked)\b|(?:xin lỗi|rất tiếc).{0,80}(?:không thể|không hỗ trợ|từ chối)|(?:không thể|không được phép).{0,80}(?:hỗ trợ|dịch|đáp ứng)/iu.test(text)) {
      return "content_refused";
    }
    return "invalid_response";
  }

  async function waitForResponseOutcome(readState, message, options = {}) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 500;
    const incompleteGraceMs = Math.max(0, Number(options.incompleteGraceMs) || 0);
    const staleStopGraceMs = message?.phase === "batch"
      ? Math.max(0, Number(options.staleStopGraceMs) || 0)
      : 0;
    const now = options.now || Date.now;
    const sleep = options.sleep || delay;
    const ignored = String(options.ignoreValue || "").trim();
    const start = now();
    const primaryDeadline = start + timeoutMs;
    const markerGraceMs = message?.phase === "setup"
      ? Math.max(0, Number(options.markerGraceMs) || 0)
      : 0;
    const onStabilityChange = typeof options.onStabilityChange === "function"
      ? options.onStabilityChange
      : () => {};
    let previousKey = "";
    let matchingPolls = 0;
    let markerFirstSeenAt = null;
    let incompleteStableSince = null;
    let staleStopStableSince = null;
    let staleStopText = "";
    let graceActive = false;
    let reportedState = "";

    function report(state) {
      if (state === reportedState && state !== "marker_seen") return;
      reportedState = state;
      onStabilityChange({
        state,
        firstSeenAt: markerFirstSeenAt ?? 0,
        stablePolls: matchingPolls,
        timeoutMs,
        graceMs: markerGraceMs
      });
    }

    report("waiting_marker");

    while (true) {
      if (options.signal?.aborted) throw new ProviderError("cancelled", "Tác vụ đã bị hủy.");
      const rawState = await readState();
      const state = rawState && typeof rawState === "object"
        ? rawState
        : { text: rawState, generating: undefined };
      const text = String(state.text || "").trim();
      const terminalCode = typeof state.terminalCode === "string" ? state.terminalCode : "";
      const currentBatchResponse = message?.phase === "batch"
        && responseHasRequestId(text, message.requestId || message.batchId);
      const changed = Boolean(terminalCode)
        || Boolean(text && (text !== ignored || currentBatchResponse));
      const protocolValid = changed && responseMatchesMessage(text, message);
      const currentTime = now();
      const staleStopCandidate = staleStopGraceMs > 0
        && protocolValid
        && state.generating === true
        && state.staleStopCandidate === true;
      if (staleStopCandidate) {
        if (text !== staleStopText) {
          staleStopText = text;
          staleStopStableSince = currentTime;
        }
        if (staleStopStableSince !== null && currentTime - staleStopStableSince >= staleStopGraceMs) {
          diagnosticState.generationState = "stale_stop_confirmed";
          return {
            response: text,
            outcomeCode: "ok",
            completionMode: "stable_response_with_stale_stop",
            stableMs: currentTime - staleStopStableSince
          };
        }
      } else {
        staleStopText = "";
        staleStopStableSince = null;
      }
      if (message.phase === "batch") {
        const validation = core.validateTranslationResponse(text, { ...message, allowBare: false });
        diagnosticState.actualCount = validation.actualCount ?? validation.items.length;
        diagnosticState.validationReason = validation.ok ? "ok" : (validation.reason || "invalid_response");
        diagnosticState.generationState = state.generating === true ? "generating" : state.generating === false ? "stopped" : "unknown";
      }
      if (message?.phase === "setup" && protocolValid && markerFirstSeenAt === null) {
        markerFirstSeenAt = now();
        report("marker_seen");
      }
      const valid = protocolValid && (message?.phase === "setup"
        ? state.generating !== true
        : state.generating === false);
      const explicitRefusal = terminalCode === "content_refused" && state.generating !== true;
      const terminalInvalid = changed && (state.generating === false || explicitRefusal) && !protocolValid;
      const terminalOutcome = terminalInvalid
        ? classifyTerminalResponse(text, message, terminalCode)
        : "";
      const key = valid
        ? `valid\u0000${text}`
        : terminalInvalid
          ? `terminal\u0000${terminalCode}\u0000${text}`
          : "";
      if (key) {
        if (key === previousKey) matchingPolls += 1;
        else {
          previousKey = key;
          matchingPolls = 1;
          incompleteStableSince = terminalOutcome === "incomplete_response" ? currentTime : null;
        }
        const requiredPolls = terminalOutcome === "incomplete_response"
          ? Math.max(2, Number(options.incompleteStablePolls ?? 6) || 2)
          : 2;
        const incompleteGraceComplete = terminalOutcome !== "incomplete_response"
          || incompleteGraceMs === 0
          || (incompleteStableSince !== null && currentTime - incompleteStableSince >= incompleteGraceMs);
        const incompleteReachedResponseTimeout = terminalOutcome !== "incomplete_response"
          || currentTime >= primaryDeadline;
        if (matchingPolls >= requiredPolls && incompleteGraceComplete && incompleteReachedResponseTimeout) {
          if (message?.phase === "setup") report("confirmed");
          return {
            response: text,
            outcomeCode: valid ? "ok" : terminalOutcome,
            ...(valid ? { completionMode: "normal_completion" } : {}),
            stability: message?.phase === "setup" ? {
              state: "confirmed",
              firstSeenAt: markerFirstSeenAt ?? 0,
              stablePolls: matchingPolls,
              timeoutMs,
              graceMs: markerGraceMs
            } : undefined
          };
        }
      } else {
        previousKey = "";
        matchingPolls = 0;
        incompleteStableSince = null;
      }
      if (!graceActive && currentTime >= primaryDeadline && markerFirstSeenAt !== null && markerGraceMs > 0) {
        graceActive = true;
        report("grace");
      }
      const markerDeadline = graceActive ? primaryDeadline + markerGraceMs : primaryDeadline;
      const incompleteDeadline = incompleteStableSince === null || incompleteGraceMs === 0
        ? primaryDeadline
        : Math.min(primaryDeadline + incompleteGraceMs, incompleteStableSince + incompleteGraceMs);
      const staleStopDeadline = staleStopStableSince === null
        ? primaryDeadline
        : Math.min(primaryDeadline + staleStopGraceMs, staleStopStableSince + staleStopGraceMs);
      const deadline = Math.max(markerDeadline, incompleteDeadline, staleStopDeadline);
      if (currentTime >= deadline) {
        if (message?.phase === "setup") report("failed");
        throw new ProviderError("response_timeout", "Đã hết thời gian chờ phản hồi ổn định từ trang AI.");
      }
      await waitForChangeOrTimer(options, intervalMs, sleep);
    }
  }

  function extractProtocolResponse(raw, message) {
    const text = String(raw || "").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim();
    return text;
  }

  function parseJsonObject(raw) {
    const text = String(raw || "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_error) {
      return null;
    }
  }

  function responseHasRequestId(raw, requestId) {
    const expected = String(requestId || "").trim();
    if (!expected) return false;
    const text = String(raw || "").replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/^```[^\n]*\n?|\n?```$/g, "").trim();
    if (text.split(/\r?\n/, 1)[0]?.trim() === expected) return true;
    const header = text.match(/^STVAI_RESULT\s+(\S+)\s+(\S+)/);
    if (header?.[2] === expected) return true;
    return String(parseJsonObject(text)?.batch_id || "") === expected;
  }

  function responseMatchesMessage(raw, message) {
    if (!message?.phase) return true;
    if (message.phase === "name_lookup") {
      const text = String(raw || "").trim();
      return Boolean(text && text.length <= 2_000);
    }
    if (message.phase === "setup") {
      return Boolean(core?.validateSetupResponse(raw, {
        jobId: message.jobId,
        setupId: message.setupId || `setup-${message.jobId}`,
        part: message.setupPart,
        responseMarker: message.responseMarker
      }).ok);
    }
    return Boolean(core?.validateTranslationResponse(raw, { ...message, allowBare: false }).ok);
  }

  function serializeError(error) {
    const code = typeof error?.code === "string" ? error.code : "provider_error";
    const safeMessages = {
      provider_error: "Trang AI không thể hoàn tất yêu cầu.",
      cancelled: "Tác vụ đã bị hủy.",
      response_timeout: "Đã hết thời gian chờ phản hồi ổn định từ trang AI.",
      send_not_confirmed: "Chưa xác nhận gửi — đã dừng để tránh gửi trùng.",
      login_required: "Bạn cần đăng nhập vào trang AI rồi tiếp tục.",
      captcha: "Trang AI đang yêu cầu xác minh CAPTCHA thủ công.",
      security_verification: "Trang AI đang yêu cầu xác minh bảo mật thủ công.",
      login_browser_rejected: "Google đã từ chối cửa sổ tự động. Hãy đăng nhập bằng cửa sổ Chrome AI thường.",
      rate_limited: "Trang AI đang giới hạn lượt sử dụng. Hãy thử lại sau.",
      ui_changed: "Không nhận diện được giao diện trang AI hiện tại.",
      ab_comparison: "Trang AI đang yêu cầu lựa chọn phản hồi thủ công.",
      temporary_unavailable: "Không thể bật chế độ trò chuyện tạm thời trên giao diện hiện tại.",
      provider_busy: "Một tác vụ dịch khác đang chạy trong tab này.",
      provider_busy_timeout: "Gemini vẫn đang sinh phản hồi sau thời gian chờ.",
      job_not_active: "Không có tác vụ đang chạy tương ứng.",
      warm_session_mismatch: "Phiên AI đã chuẩn bị không khớp với cài đặt dịch hiện tại.",
      content_refused: "AI đã từ chối xử lý nội dung này.",
      incomplete_response: "AI đã trả thiếu nội dung cần dịch.",
      invalid_response: "AI đã trả phản hồi không đúng định dạng."
    };
    return { code, message: safeMessages[code] || safeMessages.provider_error };
  }

  function createProviderMessageHandler(adapter, defaults = {}) {
    let activeJob = null;
    let preparedEvidence = null;
    let acceptedStaleStop = null;

    return async function handleProviderMessage(message) {
      const type = message?.type;
      if (type === "STVAI_PROVIDER_STATUS") {
        const setup = typeof defaults.getSetupState === "function" ? defaults.getSetupState() : null;
        return {
          ok: true,
          state: {
            ...adapter.getStatus(),
            prepared: preparedEvidence ? { ...preparedEvidence } : null,
            ...(setup ? { setup: { ...setup } } : {})
          }
        };
      }

      if (type === "STVAI_PROVIDER_READY_RECHECK") {
        const part = String(message?.setupPart || "");
        const expectedMarker = String(core?.READY_MARKERS?.[part] || "");
        const requestedMarker = String(message?.responseMarker || "");
        if (!expectedMarker || requestedMarker !== expectedMarker) {
          return { ok: false, confirmed: false, error: { code: "invalid_message" } };
        }
        const responseState = typeof adapter.readResponseState === "function"
          ? adapter.readResponseState()
          : { text: adapter.readLatestResponse?.(), generating: undefined };
        const generating = responseState?.generating === true;
        const latestMatches = extractProtocolResponse(responseState?.text, {
          phase: "setup",
          responseMarker: expectedMarker
        }) === expectedMarker;
        const markerFound = adapter.hasResponseMarker?.(expectedMarker) === true || latestMatches;
        const confirmed = markerFound && !generating;
        if (confirmed && part === "names" && message?.warmSessionId && message?.settingsHash) {
          preparedEvidence = {
            warmSessionId: String(message.warmSessionId),
            settingsHash: String(message.settingsHash)
          };
        }
        return {
          ok: true,
          confirmed,
          part,
          marker: expectedMarker,
          ...(!confirmed ? { reason: generating ? "generating" : "marker_missing" } : {})
        };
      }

      if (type === "STVAI_PROVIDER_SETUP_EVIDENCE") {
        preparedEvidence = message?.warmSessionId && message?.settingsHash
          ? { warmSessionId: message.warmSessionId, settingsHash: message.settingsHash }
          : null;
        return { ok: true };
      }

      if (type === "STVAI_PROVIDER_RECOVER_STALE_STOP") {
        const requestId = String(message?.requestId || "");
        if (activeJob || !acceptedStaleStop
          || acceptedStaleStop.jobId !== String(message?.jobId || "")
          || acceptedStaleStop.requestId !== requestId
          || typeof adapter.recoverStaleStop !== "function") {
          return { ok: false, state: "replace_after_accept" };
        }
        acceptedStaleStop = null;
        try {
          const state = await adapter.recoverStaleStop({
            requestId,
            timeoutMs: Math.max(1, Number(message?.timeoutMs) || 3_000)
          });
          return {
            ok: true,
            state: state === "stop_cleared" ? "stop_cleared" : "replace_after_accept"
          };
        } catch (_error) {
          return { ok: true, state: "replace_after_accept" };
        }
      }

      if (type === "STVAI_PROVIDER_CANCEL" || type === "STV_PROVIDER_CANCEL") {
        if (!activeJob || activeJob.jobId !== message.jobId
          || (message.requestId && message.requestId !== activeJob.requestId)) {
          return {
            ok: false,
            jobId: message.jobId,
            error: serializeError(new ProviderError("job_not_active"))
          };
        }
        activeJob.controller.abort();
        setDiagnosticState("cancelled", activeJob.phase, "cancelled");
        return { ok: true, jobId: message.jobId, cancelled: true };
      }

      if (type !== "STVAI_PROVIDER_SEND" && type !== "STV_PROVIDER_SEND") {
        return undefined;
      }

      const jobId = String(message.jobId || "");
      if (!jobId || typeof message.prompt !== "string") {
        return {
          ok: false,
          jobId,
          error: { code: "invalid_message", message: "Yêu cầu gửi đến trang AI không hợp lệ." }
        };
      }
      const requiresWarmSession = ["batch", "repair", "name_lookup"].includes(message.phase)
        && (Object.prototype.hasOwnProperty.call(message, "requiredWarmSessionId")
          || Object.prototype.hasOwnProperty.call(message, "requiredSettingsHash"));
      if (requiresWarmSession && (!preparedEvidence
        || message.requiredWarmSessionId !== preparedEvidence.warmSessionId
        || message.requiredSettingsHash !== preparedEvidence.settingsHash)) {
        return {
          ok: false,
          jobId,
          error: serializeError(new ProviderError("warm_session_mismatch"))
        };
      }
      if (activeJob) {
        return { ok: false, jobId, error: serializeError(new ProviderError("provider_busy")) };
      }

      const controller = new AbortController();
      activeJob = { jobId, requestId: message.requestId, controller, phase: message.phase };
      try {
        diagnosticState.batchAttempt = message.phase === "batch" ? Math.min(3, Math.max(0, Number(message.batchAttempt) || 0)) : 0;
        diagnosticState.expectedCount = message.phase === "batch" ? (message.expectedIds?.length || 0) : 0;
        diagnosticState.actualCount = 0;
        diagnosticState.validationReason = "none";
        diagnosticState.generationState = "unknown";
        diagnosticState.sendState = "pending";
        diagnosticState.sendConfirmedAt = 0;
        diagnosticState.firstMutationAt = 0;
        diagnosticState.completionSeenAt = 0;
        diagnosticState.acceptedAt = 0;
        diagnosticState.composerState = "not_found";
        diagnosticState.composerLengthBucket = "0";
        diagnosticState.inputEventDispatched = false;
        diagnosticState.sendButtonState = "not_found";
        diagnosticState.clickAttempted = false;
        diagnosticState.submissionConfirmed = false;
        diagnosticState.requestAlreadyPresent = false;
        const performance = typeof adapter.setPerformanceMode === "function"
          ? adapter.setPerformanceMode(message.performanceMode)
          : (typeof adapter.getPerformanceState === "function" ? adapter.getPerformanceState() : null);
        diagnosticState.performanceMode = ["max", "stable"].includes(performance?.mode) ? performance.mode : "off";
        diagnosticState.pageVisibility = ["visible", "hidden", "prerender"].includes(performance?.visibility)
          ? performance.visibility
          : "unknown";
        diagnosticState.pageFocused = Boolean(performance?.focused);
        if (message.phase === "setup") preparedEvidence = null;
        resetReadyDiagnostic({
          ...message,
          timeoutMs: message.timeoutMs ?? defaults.timeoutMs,
          markerGraceMs: message.phase === "setup" ? (message.markerGraceMs ?? 2_000) : 0
        });
        setDiagnosticState("preparing", message.phase);
        let status = adapter.getStatus();
        if (typeof adapter.waitUntilReady === "function"
          && (status.state === "ready" || status.code === "ui_changed")) {
          await adapter.waitUntilReady({
            signal: controller.signal,
            timeoutMs: message.sendTimeoutMs ?? defaults.sendTimeoutMs
          });
          status = adapter.getStatus();
        }
        const mayRecoverTemporarySetup = defaults.provider === "gemini"
          && message.phase === "setup"
          && status.code === "temporary_unavailable";
        if (status.state !== "ready" && !mayRecoverTemporarySetup) {
          throw new ProviderError(status.code || "ui_changed", status.message);
        }

        if (typeof adapter.prepareSession === "function") {
          await adapter.prepareSession({
            temporaryChat: message.temporaryChat !== false,
            phase: message.phase,
            timeoutMs: message.temporaryTimeoutMs,
            signal: controller.signal
          });
        }
        const previousResponse = typeof adapter.readLatestResponse === "function"
          ? adapter.readLatestResponse()
          : "";
        setDiagnosticState("sending", message.phase);
        const submission = await adapter.sendPrompt(message.prompt, {
          signal: controller.signal,
          requestId: message.requestId,
          timeoutMs: message.sendTimeoutMs,
          onBusyState: defaults.provider === "gemini" ? (state) => {
            if (!chromeApi?.runtime?.sendMessage || !["waiting", "cleared", "timeout"].includes(state)) return;
            try {
              const pending = chromeApi.runtime.sendMessage({
                type: "STVAI_PROVIDER_BUSY_PROGRESS",
                jobId,
                requestId: String(message.requestId || ""),
                state
              });
              pending?.catch?.(() => undefined);
            } catch (_error) {
              // Progress reporting is best-effort and must never block Send.
            }
          } : undefined
        });
        updateSubmissionDiagnostic(adapter);
        diagnosticState.sendState = submission?.alreadySent ? "reconciled" : "confirmed";
        diagnosticState.sendConfirmedAt = Date.now();
        setDiagnosticState("waiting_response", message.phase);
        const readState = () => {
            const performanceState = adapter.getPerformanceState?.();
            if (performanceState) {
              diagnosticState.pageVisibility = ["visible", "hidden", "prerender"].includes(performanceState.visibility)
                ? performanceState.visibility
                : "unknown";
              diagnosticState.pageFocused = Boolean(performanceState.focused);
            }
            const currentStatus = adapter.getStatus();
            const state = typeof adapter.readResponseState === "function"
              ? adapter.readResponseState()
              : null;
            if (currentStatus.state !== "ready") {
              const submittedGeminiTemporaryChat = defaults.provider === "gemini"
                && message.phase === "batch"
                && currentStatus.code === "temporary_unavailable"
                && ["confirmed", "reconciled"].includes(diagnosticState.sendState);
              const submittedGeminiUiTransition = defaults.provider === "gemini"
                && message.phase === "batch"
                && currentStatus.code === "ui_changed"
                && ["confirmed", "reconciled"].includes(diagnosticState.sendState);
              // Once a batch Send is confirmed, losing Gemini's temporary-route
              // marker must not discard the response already being generated.
              // Gemini may also rebuild/remove its composer while the response
              // remains readable. UI structure is no longer send evidence after
              // confirmation; response evidence and its timeout decide recovery.
              // READY setup is intentionally stricter.
              if (!submittedGeminiTemporaryChat && !submittedGeminiUiTransition) {
                throw new ProviderError(currentStatus.code || "ui_changed", currentStatus.message);
              }
            }
            if (state) {
              const responseText = String(state?.text || "").trim();
              const currentBatchResponse = message.phase === "batch"
                && responseHasRequestId(responseText, message.requestId || message.batchId);
              if (state?.generating === false
                && responseText
                && (responseText !== String(previousResponse || "").trim() || currentBatchResponse)
                && !diagnosticState.completionSeenAt) {
                diagnosticState.completionSeenAt = Date.now();
              }
              return state;
            }
            return adapter.readLatestResponse();
          };
        const onWaitSignal = (event) => {
          if (event?.kind === "mutation" && !diagnosticState.firstMutationAt) {
            diagnosticState.firstMutationAt = Math.max(0, Number(event.at) || Date.now());
          }
        };
        const outcome = typeof adapter.readResponseState === "function"
          ? await waitForResponseOutcome(readState, message, {
            signal: controller.signal,
            timeoutMs: message.timeoutMs ?? defaults.timeoutMs,
            intervalMs: defaults.intervalMs,
            now: defaults.now,
            sleep: defaults.sleep,
            waitForChange: adapter.waitForResponseChange,
            onWaitSignal,
            ignoreValue: submission?.alreadySent ? "" : previousResponse,
            markerGraceMs: message.phase === "setup" ? (message.markerGraceMs ?? 2_000) : 0,
            incompleteGraceMs: message.phase === "batch" ? defaults.incompleteGraceMs : 0,
            staleStopGraceMs: message.phase === "batch" ? defaults.staleStopGraceMs : 0,
            onStabilityChange: message.phase === "setup" ? updateReadyDiagnostic : undefined
          })
          : {
            response: await waitForStableResponse(readState, {
              signal: controller.signal,
              timeoutMs: message.timeoutMs ?? defaults.timeoutMs,
              intervalMs: defaults.intervalMs,
              now: defaults.now,
              sleep: defaults.sleep,
              waitForChange: adapter.waitForResponseChange,
              onWaitSignal,
              ignoreValue: submission?.alreadySent ? "" : previousResponse,
              normalizeValue: (value) => extractProtocolResponse(value, message),
              acceptValue: (value) => responseMatchesMessage(value, message),
              markerGraceMs: message.phase === "setup" ? (message.markerGraceMs ?? 2_000) : 0,
              onStabilityChange: message.phase === "setup" ? updateReadyDiagnostic : undefined
            }),
            outcomeCode: "ok"
          };
        diagnosticState.acceptedAt = Date.now();
        if (message.phase === "setup" && outcome.stability) updateReadyDiagnostic(outcome.stability);
        if (message.phase === "setup"
          && typeof message.warmSessionId === "string"
          && message.warmSessionId
          && typeof message.settingsHash === "string"
          && message.settingsHash) {
          preparedEvidence = {
            warmSessionId: message.warmSessionId,
            settingsHash: message.settingsHash
          };
        }
        if (typeof adapter.onAccepted === "function") {
          try {
            await adapter.onAccepted(message, outcome);
          } catch (_error) {
            // Optional local DOM learning must never turn an accepted translation into a failure.
          }
        }
        if (message.phase === "batch" && outcome.completionMode === "stable_response_with_stale_stop") {
          acceptedStaleStop = { jobId, requestId: String(message.requestId || "") };
        }
        setDiagnosticState("completed", message.phase, outcome.outcomeCode === "ok" ? "none" : outcome.outcomeCode);
        const setupValidation = message.phase === "setup"
          ? core.validateSetupResponse(outcome.response, {
            jobId: message.jobId,
            setupId: message.setupId || `setup-${message.jobId}`,
            part: message.setupPart,
            responseMarker: message.responseMarker
          })
          : null;
        if (setupValidation) diagnosticState.validationReason = setupValidation.reason;
        return {
          ok: true,
          jobId,
          response: outcome.response,
          outcomeCode: outcome.outcomeCode,
          ...(outcome.completionMode ? { completionMode: outcome.completionMode } : {}),
          ...(outcome.completionMode === "stable_response_with_stale_stop"
            ? { stableMs: Math.max(0, Number(outcome.stableMs) || 0) }
            : {}),
          ...(outcome.completionMode === "stable_response_with_stale_stop"
            ? { providerTabDisposition: "recover_after_accept" }
            : {}),
          ...(setupValidation ? {
            setupValidation: {
              schemaVersion: 1,
              ok: setupValidation.ok,
              part: String(message.setupPart || ""),
              marker: setupValidation.marker,
              reason: setupValidation.reason
            }
          } : {}),
          ...(message.phase === "setup" ? { stability: outcome.stability } : {})
        };
      } catch (error) {
        if (typeof adapter.onFailure === "function") {
          try {
            await adapter.onFailure(error);
          } catch (_profileError) {
            // A failed profile cleanup cannot hide the provider error that caused it.
          }
        }
        const hasSubmissionEvidence = updateSubmissionDiagnostic(adapter);
        const failedBeforeGeminiSend = defaults.provider === "gemini"
          && message.phase === "batch"
          && typeof error?.code !== "string"
          && hasSubmissionEvidence
          && diagnosticState.sendState === "pending"
          && !diagnosticState.clickAttempted
          && !diagnosticState.submissionConfirmed
          && !diagnosticState.requestAlreadyPresent;
        const reportedError = failedBeforeGeminiSend
          ? new ProviderError("send_not_confirmed", "Gemini gặp lỗi trước khi gửi nội dung.")
          : error;
        if (reportedError?.code === "send_not_confirmed") diagnosticState.sendState = "unconfirmed";
        setDiagnosticState("error", message.phase,
          typeof reportedError?.code === "string" ? reportedError.code : "provider_error");
        return { ok: false, jobId, error: serializeError(reportedError) };
      } finally {
        if (activeJob?.jobId === jobId) activeJob = null;
      }
    };
  }

  function createProviderSetupCoordinator(adapter, handler, chromeApi, defaults = {}) {
    let setupTask = null;
    let setupState = null;
    let resumeMessage = null;

    const snapshot = () => setupState ? { ...setupState } : null;
    const progress = async (stage, extra = {}) => {
      if (!setupState) return;
      setupState = {
        ...setupState,
        stage,
        state: stage === "completed" ? "completed" : stage === "failed" ? "failed" : "running",
        lastProgressAt: Date.now(),
        ...extra
      };
      try {
        await chromeApi.runtime.sendMessage({
          type: "STVAI_PROVIDER_SETUP_PROGRESS",
          provider: defaults.provider,
          setupSessionId: setupState.setupSessionId,
          checkpoint: setupState.checkpoint,
          state: setupState.state,
          stage: setupState.stage,
          lastProgressAt: setupState.lastProgressAt,
          resumeCount: setupState.resumeCount,
          errorCode: setupState.errorCode
        });
      } catch (_error) {
        // The tab owns the state machine; a sleeping service worker can query the checkpoint later.
      }
    };

    async function run(message) {
      const hardTimeoutMs = Math.max(1, Number(message.hardTimeoutMs) || 60_000);
      const inactivityTimeoutMs = Math.max(1, Number(message.inactivityTimeoutMs) || 30_000);
      const startedAt = Date.now();
      try {
        if (typeof adapter.prepareSession === "function") {
          await adapter.prepareSession({
            temporaryChat: message.temporaryChat !== false,
            phase: "setup",
            timeoutMs: message.temporaryTimeoutMs
          });
        }
        for (let index = setupState.checkpoint; index < message.steps.length; index += 1) {
          const hardRemainingMs = hardTimeoutMs - (Date.now() - startedAt);
          if (hardRemainingMs <= 0) throw new ProviderError("response_timeout");
          const stepTimeoutMs = Math.max(1, Math.min(inactivityTimeoutMs, hardRemainingMs));
          const step = message.steps[index];
          await progress("waiting_composer", { checkpoint: index, errorCode: "" });
          const existing = typeof adapter.readLatestResponse === "function" ? adapter.readLatestResponse() : "";
          const alreadyConfirmed = adapter.hasResponseMarker?.(step.responseMarker) === true
            || responseMatchesMessage(existing, { ...step, phase: "setup" });
          if (!alreadyConfirmed) {
            await progress("sending", { checkpoint: index });
            await progress("waiting_marker", { checkpoint: index });
            const result = await handler({
              type: "STVAI_PROVIDER_SEND",
              phase: "setup",
              setupId: message.setupId,
              temporaryChat: message.temporaryChat,
              temporaryTimeoutMs: message.temporaryTimeoutMs,
              sendTimeoutMs: stepTimeoutMs,
              timeoutMs: stepTimeoutMs,
              markerGraceMs: message.markerGraceMs,
              ...(index === message.steps.length - 1 ? {
                warmSessionId: message.warmSessionId,
                settingsHash: message.settingsHash
              } : {}),
              ...step
            });
            if (!result?.ok) throw new ProviderError(result?.error?.code || "provider_error");
          } else if (index === message.steps.length - 1) {
            await handler({
              type: "STVAI_PROVIDER_SETUP_EVIDENCE",
              warmSessionId: message.warmSessionId,
              settingsHash: message.settingsHash
            });
          }
          setupState.checkpoint = index + 1;
          await progress("confirmed", { checkpoint: setupState.checkpoint });
        }
        await progress("completed", { checkpoint: message.steps.length, errorCode: "" });
      } catch (error) {
        await progress("failed", { errorCode: serializeError(error).code });
      } finally {
        setupTask = null;
        if (resumeMessage) {
          const pendingResume = resumeMessage;
          resumeMessage = null;
          setupState = { ...setupState, state: "running", stage: "resuming", errorCode: "" };
          setupTask = run(pendingResume);
        }
      }
    }

    function start(message) {
      const steps = Array.isArray(message?.steps) ? message.steps : [];
      if (!message?.setupSessionId || steps.length !== 3) {
        return { ok: false, error: { code: "invalid_message" } };
      }
      if (setupTask) {
        if (setupState?.setupSessionId !== message.setupSessionId) {
          return { ok: false, error: { code: "provider_busy" } };
        }
        setupState.resumeCount += 1;
        resumeMessage = message;
        return { ok: true, accepted: true, checkpoint: setupState.checkpoint, state: "running" };
      }
      const sameSession = setupState?.setupSessionId === message.setupSessionId;
      setupState = {
        schemaVersion: 1,
        setupSessionId: message.setupSessionId,
        checkpoint: sameSession ? setupState.checkpoint : 0,
        state: "running",
        stage: sameSession ? "resuming" : "waiting_composer",
        lastProgressAt: Date.now(),
        resumeCount: sameSession ? setupState.resumeCount + 1 : 0,
        errorCode: ""
      };
      setupTask = run(message);
      return { ok: true, accepted: true, checkpoint: setupState.checkpoint, state: "running" };
    }

    return Object.freeze({ getState: snapshot, start });
  }

  async function announceProviderReadiness(adapter, chromeApi, options = {}) {
    const provider = options.provider;
    if (!["chatgpt", "gemini"].includes(provider) || typeof chromeApi?.runtime?.sendMessage !== "function") {
      return false;
    }
    const timeoutMs = Math.max(0, Number(options.readyAnnouncementTimeoutMs ?? 60_000) || 0);
    const waitMs = Math.max(50, Number(options.readyAnnouncementWaitMs ?? 500) || 500);
    const maxChecks = Math.max(1, Number(options.readyAnnouncementMaxChecks ?? 1_000) || 1);
    const startedAt = Date.now();
    for (let check = 0; check < maxChecks && Date.now() - startedAt <= timeoutMs; check += 1) {
      let status;
      try { status = adapter.getStatus?.(); } catch (_error) { status = null; }
      if (status?.state === "ready") {
        try {
          const response = await chromeApi.runtime.sendMessage({
            type: "STVAI_PROVIDER_READY",
            provider,
            status: "ready"
          });
          if (response?.reason !== "unknown-provider-tab") return true;
        } catch (_error) {
          // A service-worker startup race is retried within the same bounded window.
        }
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      try {
        if (typeof adapter.waitForResponseChange === "function") {
          await adapter.waitForResponseChange({ timeoutMs: Math.min(waitMs, remaining) });
        } else {
          await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, remaining)));
        }
      } catch (_error) {
        return false;
      }
    }
    return false;
  }

  function registerRuntimeListener(adapter, chromeApi, options) {
    if (!chromeApi?.runtime?.onMessage?.addListener) return null;
    let coordinator;
    const handler = createProviderMessageHandler(adapter, {
      ...options,
      getSetupState: () => coordinator?.getState() || null
    });
    coordinator = createProviderSetupCoordinator(adapter, handler, chromeApi, options);
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "STVAI_PROVIDER_SETUP_START" && options?.provider === "chatgpt") {
        sendResponse(coordinator.start(message));
        return true;
      }
      const supported = [
        "STVAI_PROVIDER_STATUS",
        "STVAI_PROVIDER_READY_RECHECK",
        "STVAI_PROVIDER_SEND",
        "STVAI_PROVIDER_RECOVER_STALE_STOP",
        "STVAI_PROVIDER_CANCEL",
        "STV_PROVIDER_SEND",
        "STV_PROVIDER_CANCEL"
      ].includes(message?.type);
      if (!supported) return false;
      handler(message).then(sendResponse);
      return true;
    });
    void announceProviderReadiness(adapter, chromeApi, options).catch(() => undefined);
    return handler;
  }

  return Object.freeze({
    ProviderError,
    buttonIsEnabled,
    announceProviderReadiness,
    createProviderMessageHandler,
    createProviderSetupCoordinator,
    classifyTerminalResponse,
    classifyAction,
    extractProtocolResponse,
    findVisible,
    isVisible,
    getDiagnosticState,
    pageHasText,
    responseHasRequestId,
    responseMatchesMessage,
    registerRuntimeListener,
    setComposerText,
    textOf,
    waitForElement,
    waitForResponseOutcome,
    waitForStableResponse
  });
});
