(function attachGeminiAdapter(root, factory) {
  const common = root.STVAIProviderCommon
    || (typeof require === "function" ? require("./provider-common.js") : null);
  const resolverModule = root.STVAIGeminiDomResolver
    || (typeof require === "function" ? require("./gemini-dom-resolver.js") : null);
  const api = factory(common, resolverModule, root.chrome);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAIGemini = api;

  if (root.document && root.chrome?.runtime?.onMessage) {
    common.registerRuntimeListener(api.createGeminiAdapter(root.document, {
      profileStorage: api.createProfileStorage(root.chrome)
    }), root.chrome, { provider: "gemini", incompleteGraceMs: 3_000, staleStopGraceMs: 3_000 });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createGeminiModule(common, resolverModule) {
  "use strict";

  const SEND_BUTTONS = [
    "button[aria-label='Send message']",
    "button[aria-label^='Send']",
    "button[aria-label^='Gửi' i]"
  ];
  const TEMPORARY_LAUNCHERS = [
    "[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-button:not(.temp-chat-on) button",
    "gem-icon-button.temp-chat-button:not(.temp-chat-on) button",
    "side-nav-sparkle-button > button[data-test-id='side-nav-sparkle-button']",
    "button[aria-label*='Temporary chat' i]",
    "button[aria-label*='Cuộc trò chuyện tạm thời' i]"
  ];
  const TEMPORARY_ACTIVE_INDICATORS = [
    "chat-window.is-temporary-chat",
    "[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-on",
    "gem-icon-button.temp-chat-on"
  ];

  function runtimeMessage(chromeApi, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      try {
        const possible = chromeApi?.runtime?.sendMessage?.(message, value => {
          const runtimeError = chromeApi.runtime?.lastError;
          finish(value, runtimeError ? new Error(runtimeError.message || "runtime_error") : null);
        });
        if (possible?.then) possible.then(value => finish(value), error => finish(undefined, error));
        if (!chromeApi?.runtime?.sendMessage) finish(undefined, new Error("runtime_unavailable"));
      } catch (error) {
        finish(undefined, error);
      }
    });
  }

  function createProfileStorage(chromeApi) {
    const key = resolverModule.PROFILE_STORAGE_KEY;
    return Object.freeze({
      async get(requestedKey) {
        if (requestedKey !== key) return {};
        const response = await runtimeMessage(chromeApi, { type: "STVAI_DOM_PROFILES_GET" });
        return response?.ok ? { [key]: response.value } : {};
      },
      async set(entries) {
        if (!entries || !Object.hasOwn(entries, key)) return;
        const response = await runtimeMessage(chromeApi, {
          type: "STVAI_DOM_PROFILES_SET",
          value: entries[key]
        });
        if (!response?.ok) throw new Error(response?.reason || "profile_storage_failed");
      }
    });
  }

  function createGeminiAdapter(document, options = {}) {
    let temporaryRequired = false;
    let verifiedTemporaryOnce = false;
    let temporaryMissingSince = null;
    let activeBatchRequestId = "";
    let learnedCurrentDocument = false;
    const verifiedReadySteps = new Set();
    const now = options.now || Date.now;
    const temporaryLossGraceMs = Math.max(0, Number(options.temporaryLossGraceMs ?? 500) || 0);
    const eventWaiter = options.now || options.sleep ? undefined : waitForResponseChange;
    let submissionDiagnostic = createSubmissionDiagnostic();
    const domResolver = options.domResolver || resolverModule.createGeminiDomResolver(document, {
      storage: options.profileStorage
    });

    function createSubmissionDiagnostic() {
      return {
        composerState: "not_found",
        composerLengthBucket: "0",
        inputEventDispatched: false,
        sendButtonState: "not_found",
        clickAttempted: false,
        submissionConfirmed: false,
        requestAlreadyPresent: false
      };
    }

    function lengthBucket(value) {
      const count = String(value || "").length;
      if (!count) return "0";
      if (count <= 100) return "1-100";
      if (count <= 1_000) return "101-1000";
      if (count <= 5_000) return "1001-5000";
      return "5001+";
    }

    function getSubmissionDiagnostic() {
      return { ...submissionDiagnostic };
    }

    function readComposerText(composer) {
      if (!composer) return "";
      if ("value" in composer && typeof composer.value === "string") return composer.value.trim();
      if (typeof composer.innerText === "string") return composer.innerText.replace(/\u00a0/g, " ").trim();
      const readNode = (node) => {
        if (node.nodeType === 3) return node.nodeValue || "";
        if (node.nodeName === "BR") return "\n";
        return Array.from(node.childNodes || []).map(readNode).join("");
      };
      return readNode(composer).replace(/\u00a0/g, " ").trim();
    }

    function comparableComposerText(value) {
      // Compare content without treating the editor's visual whitespace as lost text.
      // This normalization never changes the actual prompt written to the composer.
      return String(value || "").replace(/\s+/gu, " ").trim();
    }

    function updateSendButtonState() {
      if (findStopButton()) {
        submissionDiagnostic.sendButtonState = "stop_visible";
        return null;
      }
      const button = findSendButton();
      if (button) submissionDiagnostic.sendButtonState = "enabled";
      else {
        const candidates = SEND_BUTTONS.flatMap(selector => Array.from(document.querySelectorAll(selector)));
        submissionDiagnostic.sendButtonState = candidates.length ? "disabled" : "not_found";
      }
      return button;
    }

    function setPerformanceMode(mode) {
      const enabled = mode === "max";
      document.documentElement?.classList.toggle("stvai-gemini-performance-max", enabled);
      return getPerformanceState();
    }

    function getPerformanceState() {
      return {
        mode: document.documentElement?.classList.contains("stvai-gemini-performance-max") ? "max" : "off",
        visibility: ["visible", "hidden", "prerender"].includes(document.visibilityState)
          ? document.visibilityState
          : "unknown",
        focused: Boolean(document.hasFocus?.())
      };
    }

    function waitForResponseChange(waitOptions = {}) {
      const timeoutMs = Math.max(0, Number(waitOptions.timeoutMs ?? options.mutationFallbackMs ?? 500) || 0);
      const signal = waitOptions.signal;
      const MutationObserverClass = document.defaultView?.MutationObserver;
      if (!MutationObserverClass || !document.documentElement) {
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new common.ProviderError("cancelled", "Tác vụ đã bị hủy."));
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(new common.ProviderError("cancelled", "Tác vụ đã bị hủy."));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve({ kind: "timer", at: Date.now() });
          }, timeoutMs);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const responseSelectors = "model-response, .response-footer, .response-container-header-processing-state, button, [contenteditable='true']";
        const isRelevantNode = (node) => {
          const element = node?.nodeType === 1 ? node : node?.parentElement;
          return Boolean(element?.matches?.(responseSelectors)
            || element?.closest?.(responseSelectors)
            || element?.querySelector?.(responseSelectors));
        };
        const finish = (value, error) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(value);
        };
        const onAbort = () => finish(null, new common.ProviderError("cancelled", "Tác vụ đã bị hủy."));
        const observer = new MutationObserverClass((mutations) => {
          const relevant = mutations.some((mutation) => isRelevantNode(mutation.target)
            || Array.from(mutation.addedNodes || []).some(isRelevantNode)
            || Array.from(mutation.removedNodes || []).some(isRelevantNode));
          if (relevant) finish({ kind: "mutation", at: Date.now() });
        });
        const timer = setTimeout(() => finish({ kind: "timer", at: Date.now() }), timeoutMs);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["class", "aria-label", "aria-disabled", "disabled"]
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    function findComposer() {
      return domResolver.resolve("composer").element;
    }

    function controlLooksLikeStop(button) {
      return common.classifyAction(button)?.kind === "stop";
    }

    function findSendButton() {
      const resolved = domResolver.resolve("send", { composer: findComposer() }).element;
      return resolved && !controlLooksLikeStop(resolved) ? resolved : null;
    }

    function findStopButton() {
      return domResolver.resolve("stop", { composer: findComposer() }).element || null;
    }

    function getStatus() {
      if (common.pageHasText(
        document,
        ["body"],
        /this browser or app may not be secure|try using a different browser/i
      )) {
        return { state: "paused", code: "login_browser_rejected", message: "Google đã từ chối cửa sổ tự động. Hãy đăng nhập bằng cửa sổ Chrome AI thường." };
      }
      if (common.findVisible(document, [
        "iframe[src*='captcha']",
        "iframe[src*='challenge']",
        ".g-recaptcha",
        ".cf-turnstile"
      ])) {
        return { state: "paused", code: "captcha", message: "Hãy hoàn tất CAPTCHA thủ công trên Gemini." };
      }
      if (common.findVisible(document, [
        "a[href*='/signin']",
        "a[href*='accounts.google.com/ServiceLogin']",
        "button[aria-label*='Sign in']"
      ])) {
        return { state: "paused", code: "login_required", message: "Hãy đăng nhập Gemini rồi tiếp tục." };
      }
      if (common.pageHasText(
        document,
        ["[role='alert']", ".error-message", "mat-error"],
        /usage limit|rate limit|too many requests|try again later|reached (?:the|your) limit/i
      )) {
        return { state: "paused", code: "rate_limited", message: "Gemini đang giới hạn lượt sử dụng." };
      }
      if (!findComposer()) {
        return { state: "paused", code: "ui_changed", message: "Không nhận diện được ô nhập của Gemini." };
      }
      if (temporaryRequired && verifiedTemporaryOnce) {
        if (temporaryPageIsActive()) temporaryMissingSince = null;
        else if (findTemporaryLaunchers().some((control) => common.buttonIsEnabled(control))) {
          if (temporaryMissingSince === null) temporaryMissingSince = now();
          if (now() - temporaryMissingSince >= temporaryLossGraceMs) {
            return {
              state: "paused",
              code: "temporary_unavailable",
              message: "Gemini đã rời Temporary Chat sau khi gửi. Tool sẽ thay đúng tab này."
            };
          }
        } else temporaryMissingSince = null;
      }
      return { state: "ready" };
    }

    function temporaryPageIsActive() {
      if (!findComposer()) return false;
      return Boolean(domResolver.resolve("temporaryActive").element)
        || TEMPORARY_ACTIVE_INDICATORS.some((selector) => document.querySelector(selector));
    }

    function temporaryControlScore(control) {
      if (!control || !common.isVisible(control) || controlLooksLikeStop(control)) return -100;
      const fields = [
        control.className,
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("data-test-id"),
        control.getAttribute("data-testid")
      ].filter(Boolean).join(" ").toLocaleLowerCase("vi");
      let score = 0;
      if (/temp-chat|temporary-chat/.test(fields)) score += 10;
      if (/temporary (?:chat|conversation)|(?:cuộc )?trò chuyện tạm thời/.test(fields)) score += 10;
      if (/(?:temp|tạm thời)/.test(fields) && /(?:chat|trò chuyện)/.test(fields)) score += 4;
      if (control.tagName === "BUTTON") score += 3;
      return common.buttonIsEnabled(control) ? score : score - 20;
    }

    function actionableTemporaryControl(control) {
      if (!control) return null;
      if (control.tagName === "GEM-ICON-BUTTON") {
        const nested = Array.from(control.querySelectorAll("button, [role='button']"))
          .find((candidate) => common.buttonIsEnabled(candidate));
        if (nested) return nested;
      }
      return control;
    }

    function findTemporaryLaunchers() {
      const seen = new Set();
      const candidates = [];
      const append = (control, index, score) => {
        const actionable = actionableTemporaryControl(control);
        if (!actionable || seen.has(actionable) || !common.isVisible(actionable)) return;
        seen.add(actionable);
        candidates.push({ control: actionable, index, score });
      };
      Array.from(document.querySelectorAll("button, [role='button'], gem-icon-button"))
        .forEach((control, index) => {
          const score = temporaryControlScore(control);
          if (score >= 8) append(control, index, score);
        });
      TEMPORARY_LAUNCHERS.forEach((selector, selectorIndex) => {
        Array.from(document.querySelectorAll(selector)).forEach((control, index) => {
          append(control, 100_000 + selectorIndex * 1_000 + index, temporaryControlScore(control));
        });
      });
      append(domResolver.resolve("temporaryLauncher").element, 200_000, 100);
      return candidates
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((item) => item.control);
    }

    async function waitForStableTemporary(signal, timeoutMs) {
      let consecutiveReads = 0;
      await common.waitForElement(
        () => {
          if (!temporaryPageIsActive()) {
            consecutiveReads = 0;
            return null;
          }
          consecutiveReads += 1;
          return consecutiveReads >= 2 ? domResolver.resolve("temporaryActive").element
            || document.querySelector("chat-window.is-temporary-chat")
            || document.querySelector("[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-on")
            || document.querySelector("gem-icon-button.temp-chat-on")
            : null;
        },
        {
          timeoutMs: timeoutMs ?? options.temporaryTimeoutMs ?? 5_000,
          intervalMs: options.pollIntervalMs ?? 100,
          now: options.now,
          sleep: options.sleep,
          waitForChange: eventWaiter,
          signal
        }
      );
    }

    async function prepareSession({ temporaryChat = true, signal, timeoutMs } = {}) {
      await domResolver.ready?.();
      temporaryRequired = temporaryChat;
      if (!temporaryChat) return;
      const stageTimeoutMs = timeoutMs ?? options.temporaryTimeoutMs ?? 10_000;
      const startedAt = now();
      const remaining = () => Math.max(0, stageTimeoutMs - (now() - startedAt));
      if (temporaryPageIsActive()) {
        await waitForStableTemporary(signal, remaining());
        verifiedTemporaryOnce = true;
        return;
      }
      if (verifiedTemporaryOnce) {
        throw new common.ProviderError(
          "temporary_unavailable",
          "Gemini đã thoát khỏi Temporary Chat. Tool đã dừng trước khi gửi prompt tiếp theo."
        );
      }
      const attempted = new WeakSet();
      const attemptTimeoutMs = Math.max(1, Number(options.temporaryAttemptMs ?? 1_500) || 1_500);
      const pollSleep = options.sleep || ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
      while (remaining() > 0) {
        if (temporaryPageIsActive()) {
          await waitForStableTemporary(signal, remaining());
          verifiedTemporaryOnce = true;
          return;
        }
        const control = findTemporaryLaunchers().find((candidate) => (
          !attempted.has(candidate) && common.buttonIsEnabled(candidate)
        ));
        if (!control) {
          const waitMs = Math.min(options.pollIntervalMs ?? 100, remaining());
          if (eventWaiter) await eventWaiter({ timeoutMs: waitMs, signal });
          else await pollSleep(waitMs);
          if (signal?.aborted) throw new common.ProviderError("cancelled", "Tác vụ đã bị hủy.");
          continue;
        }
        attempted.add(control);
        control.focus?.();
        control.click();
        try {
          await waitForStableTemporary(signal, Math.min(attemptTimeoutMs, remaining()));
          verifiedTemporaryOnce = true;
          return;
        } catch (error) {
          if (error?.code === "cancelled") throw error;
        }
      }
      throw new common.ProviderError(
        "temporary_unavailable",
        "Không xác nhận được chế độ trò chuyện tạm thời trên Gemini."
      );
    }

    async function sendPrompt(prompt, sendOptions = {}) {
      await domResolver.ready?.();
      submissionDiagnostic = createSubmissionDiagnostic();
      const promptText = String(prompt || "").trim();
      const comparablePrompt = comparableComposerText(promptText);
      const state = getStatus();
      if (state.state !== "ready") {
        throw new common.ProviderError(state.code, state.message);
      }
      if (temporaryRequired && !temporaryPageIsActive()) {
        throw new common.ProviderError(
          "temporary_unavailable",
          "Gemini không còn ở Temporary Chat. Prompt chưa được gửi."
        );
      }
      const requestId = String(sendOptions.requestId || "");
      activeBatchRequestId = /^batch_\d+_\d{4}$/.test(requestId) ? requestId : "";
      const alreadySent = () => /^batch_\d+_\d{4}$/.test(requestId)
        && Array.from(document.querySelectorAll("user-query"))
          .some(node => common.textOf(node).split(/\r?\n/, 1)[0]?.trim() === requestId);
      const reconcileExistingRequest = () => {
        if (!alreadySent()) return false;
        submissionDiagnostic.requestAlreadyPresent = true;
        submissionDiagnostic.submissionConfirmed = true;
        submissionDiagnostic.sendButtonState = "submission_confirmed";
        return true;
      };
      if (reconcileExistingRequest()) return { alreadySent: true };
      const waitOptions = {
        intervalMs: options.pollIntervalMs ?? 100,
        now: options.now,
        sleep: options.sleep,
        waitForChange: eventWaiter,
        signal: sendOptions.signal
      };
      const now = options.now || Date.now;
      const busyTimeoutMs = sendOptions.busyTimeoutMs ?? sendOptions.timeoutMs ?? options.sendTimeoutMs ?? 30_000;
      async function waitForBusyTab() {
        if (!findStopButton()) return false;
        submissionDiagnostic.sendButtonState = "stop_visible";
        sendOptions.onBusyState?.("waiting");
        try {
          await common.waitForElement(
            () => (reconcileExistingRequest() || !findStopButton()) ? document.body : null,
            { ...waitOptions, timeoutMs: busyTimeoutMs }
          );
        } catch (error) {
          if (error?.code === "cancelled") throw error;
          sendOptions.onBusyState?.("timeout");
          throw new common.ProviderError(
            "provider_busy_timeout",
            "Gemini vẫn đang sinh phản hồi sau thời gian chờ; nội dung chưa được gửi."
          );
        }
        sendOptions.onBusyState?.("cleared");
        return reconcileExistingRequest();
      }
      if (await waitForBusyTab()) return { alreadySent: true };
      const stageTimeoutMs = sendOptions.timeoutMs ?? options.sendTimeoutMs ?? 30_000;
      let startedAt = now();
      const remaining = () => Math.max(0, stageTimeoutMs - (now() - startedAt));
      const composer = findComposer();
      if (!composer) {
        submissionDiagnostic.composerState = "not_found";
        throw new common.ProviderError("ui_changed", "Không tìm thấy ô nhập Gemini.");
      }
      const before = readComposerText(composer);
      submissionDiagnostic.composerState = before ? "filled" : "empty_before_write";
      if (comparableComposerText(before) !== comparablePrompt) {
        common.setComposerText(composer, prompt);
        submissionDiagnostic.inputEventDispatched = true;
      }
      const after = readComposerText(composer);
      submissionDiagnostic.composerLengthBucket = lengthBucket(after);
      submissionDiagnostic.composerState = comparableComposerText(after) === comparablePrompt ? "filled" : "write_failed";
      if (comparableComposerText(after) !== comparablePrompt) {
        throw new common.ProviderError("ui_changed", "Gemini không nhận đủ nội dung trong ô nhập.");
      }
      const button = await common.waitForElement(
        () => {
          const candidate = updateSendButtonState();
          return common.buttonIsEnabled(candidate) ? candidate : null;
        },
        { ...waitOptions, timeoutMs: remaining() }
      );
      const settleMs = Math.max(0, Number(options.sendSettleMs ?? 500) || 0);
      if (settleMs) {
        const settleSleep = options.sleep || ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
        await settleSleep(settleMs);
        if (sendOptions.signal?.aborted) throw new common.ProviderError("cancelled", "Tác vụ đã bị hủy.");
      }
      let settledButton = await common.waitForElement(
        () => {
          const candidate = updateSendButtonState();
          return common.buttonIsEnabled(candidate) ? candidate : null;
        },
        { ...waitOptions, timeoutMs: remaining() }
      );
      if (reconcileExistingRequest()) return { alreadySent: true };
      if (await waitForBusyTab()) return { alreadySent: true };
      if (submissionDiagnostic.sendButtonState === "stop_visible") {
        startedAt = now();
        settledButton = await common.waitForElement(
          () => {
            const candidate = updateSendButtonState();
            return common.buttonIsEnabled(candidate) ? candidate : null;
          },
          { ...waitOptions, timeoutMs: remaining() }
        );
      }
      const settledComposer = findComposer();
      const settledText = readComposerText(settledComposer);
      if (!settledComposer || comparableComposerText(settledText) !== comparablePrompt) {
        submissionDiagnostic.composerLengthBucket = lengthBucket(settledText);
        submissionDiagnostic.composerState = "write_failed";
        throw new common.ProviderError("ui_changed", "Gemini không giữ đủ nội dung trước khi gửi.");
      }
      submissionDiagnostic.clickAttempted = true;
      submissionDiagnostic.sendButtonState = "clicked";
      settledButton.focus?.();
      settledButton.click();
      try {
        await common.waitForElement(
          () => {
            if (alreadySent()) return document.body;
            if (findStopButton()) return document.body;
            const current = findComposer();
            return current && !readComposerText(current) ? current : null;
          },
          {
            ...waitOptions,
            timeoutMs: Math.min(remaining(), options.sendConfirmTimeoutMs ?? remaining())
          }
        );
        submissionDiagnostic.submissionConfirmed = true;
        submissionDiagnostic.sendButtonState = "submission_confirmed";
        const currentComposer = findComposer();
        if (currentComposer && !common.textOf(currentComposer).trim()) submissionDiagnostic.composerState = "cleared_after_send";
        return;
      } catch (error) {
        if (error?.code === "cancelled") throw error;
      }

      submissionDiagnostic.sendButtonState = "click_unconfirmed";
      throw new common.ProviderError(
        "send_not_confirmed",
        "Gemini chưa nhận thao tác gửi nội dung."
      );
    }

    function responseContent(element) {
      return element?.querySelector(".markdown")
        || element?.querySelector("message-content")
        || element?.querySelector(".response-content")
        || element;
    }

    function responseElements(resolved) {
      const selectors = [
        "model-response",
        "[data-message-author-role='assistant']",
        ".markdown",
        "message-content",
        ".response-content"
      ];
      const seen = new Set();
      const responses = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element) || !common.isVisible(element)) continue;
          seen.add(element);
          if (responses.some(response => response.contains?.(element))) continue;
          responses.push(element);
        }
      }
      if (resolved && !seen.has(resolved) && common.isVisible(resolved)) responses.push(resolved);
      return responses;
    }

    function findLatestResponse() {
      const resolved = domResolver.resolve("response").element;
      if (!activeBatchRequestId) return resolved;
      const matching = responseElements(resolved)
        .map((element, index) => ({
          element,
          index,
          text: common.textOf(responseContent(element))
        }))
        .filter(candidate => common.responseHasRequestId(candidate.text, activeBatchRequestId))
        .sort((left, right) => right.text.length - left.text.length || right.index - left.index);
      return matching[0]?.element || resolved;
    }

    function readLatestResponse() {
      const latest = findLatestResponse();
      if (!latest) return "";
      return common.textOf(responseContent(latest));
    }

    function hasResponseMarker(marker) {
      const expected = String(marker || "").trim();
      if (!expected) return false;
      const latest = findLatestResponse();
      return responseElements(latest).some((response) => {
        const content = response.querySelector(".markdown")
          || response.querySelector("message-content")
          || response.querySelector(".response-content")
          || response;
        return common.textOf(content).trim() === expected;
      });
    }

    function readResponseState() {
      const text = readLatestResponse();
      const latestResponse = findLatestResponse();
      const responseComplete = Boolean(domResolver.resolve("completion", { response: latestResponse }).element);
      const sendVisible = Array.from(document.querySelectorAll('button')).some(button => {
        const action = common.classifyAction(button);
        return common.isVisible(button) && action?.kind === 'send' && action.signal !== 'class';
      });
      const stopButton = findStopButton();
      const generating = stopButton ? true : (responseComplete || sendVisible) ? false : null;
      const refused = common.classifyTerminalResponse(text, null, "") === "content_refused";
      return {
        text,
        generating,
        staleStopCandidate: Boolean(stopButton),
        terminalCode: refused && !generating ? "content_refused" : ""
      };
    }

    async function recoverStaleStop({ timeoutMs = 3_000 } = {}) {
      const stop = findStopButton();
      if (!stop) return "stop_cleared";
      stop.click();
      const recoveryTimeoutMs = Math.max(1, Number(options.staleStopRecoveryMs ?? timeoutMs) || 3_000);
      try {
        await common.waitForElement(
          () => !findStopButton() && common.buttonIsEnabled(findSendButton()) ? document.body : null,
          {
            timeoutMs: recoveryTimeoutMs,
            intervalMs: options.pollIntervalMs ?? 100,
            now: options.now,
            sleep: options.sleep,
            waitForChange: eventWaiter
          }
        );
        return "stop_cleared";
      } catch (_error) {
        return "replace_after_accept";
      }
    }

    async function onAccepted(message) {
      if (message?.phase === "setup") {
        const setupIndex = Number(message.setupIndex);
        if (Number.isInteger(setupIndex) && setupIndex >= 0 && setupIndex <= 2) verifiedReadySteps.add(setupIndex);
        return;
      }
      if (message?.phase !== "batch" || verifiedReadySteps.size !== 3 || learnedCurrentDocument) return;
      learnedCurrentDocument = await domResolver.learnVerified();
    }

    async function onFailure(error) {
      if (error?.code !== "ui_changed") return;
      const snapshot = domResolver.getDiagnosticSnapshot?.();
      const profileIds = new Set(Object.values(snapshot?.roles || {})
        .filter(role => role?.source === "local" && role.profileId)
        .map(role => role.profileId));
      for (const profileId of profileIds) await domResolver.invalidateProfile(profileId);
    }

    return Object.freeze({
      findComposer,
      findSendButton,
      getSubmissionDiagnostic,
      getPerformanceState,
      getDomDiagnostic: () => domResolver.probe?.() || domResolver.getDiagnosticSnapshot(),
      getStatus,
      hasResponseMarker,
      onAccepted,
      onFailure,
      prepareSession,
      ready: () => domResolver.ready?.(),
      readLatestResponse,
      readResponseState,
      recoverStaleStop,
      setPerformanceMode,
      waitForResponseChange: eventWaiter,
      sendPrompt
    });
  }

  return Object.freeze({ createGeminiAdapter, createProfileStorage });
});
