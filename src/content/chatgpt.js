(function attachChatGPTAdapter(root, factory) {
  const common = root.STVAIProviderCommon
    || (typeof require === "function" ? require("./provider-common.js") : null);
  const resolverModule = root.STVAIChatGPTDomResolver
    || (typeof require === "function" ? require("./chatgpt-dom-resolver.js") : null);
  const api = factory(common, resolverModule, root.chrome);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAIChatGPT = api;

  if (root.document && root.chrome?.runtime?.onMessage) {
    common.registerRuntimeListener(api.createChatGPTAdapter(root.document, {
      profileStorage: api.createProfileStorage(root.chrome)
    }), root.chrome, { provider: "chatgpt" });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createChatGPTModule(common, resolverModule) {
  "use strict";

  const COMPOSERS = [
    "#prompt-textarea",
    "textarea[data-testid='prompt-textarea']",
    "main form [contenteditable='true']"
  ];
  const SEND_BUTTONS = [
    "button[data-testid='send-button']",
    "button[aria-label='Send prompt']",
    "button[aria-label^='Send']"
  ];
  const STOP_BUTTONS = [
    "button[data-testid='stop-button']",
    "button[aria-label^='Stop' i]",
    "button[aria-label^='Dừng' i]"
  ];
  const RESPONSES = [
    "article[data-testid^='conversation-turn-assistant']",
    "[data-message-author-role='assistant']"
  ];
  const USER_MESSAGES = [
    "article[data-testid^='conversation-turn-user']",
    "[data-message-author-role='user']"
  ];
  const TEMPORARY_CONTROLS = [
    "button[data-testid='temporary-chat-button']",
    "button[aria-label*='Temporary chat']",
    "button[aria-label*='temporary chat']"
  ];
  const TEMPORARY_INTRO_TITLE = /^(?:temporary chat|trò chuyện tạm thời)$/i;
  const TEMPORARY_INTRO_CONTINUE = /^(?:continue|tiếp tục)$/i;
  const TEMPORARY_INTRO_DISMISS = /(?:^|\b)(?:close|dismiss|đóng|tắt)(?:\b|$)/i;

  function runtimeMessage(chromeApi, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      try {
        const possible = chromeApi?.runtime?.sendMessage?.(message, value => {
          const runtimeError = chromeApi.runtime?.lastError;
          finish(value, runtimeError ? new Error(runtimeError.message || "runtime_error") : null);
        });
        if (possible?.then) possible.then(value => finish(value), error => finish(undefined, error));
        if (!chromeApi?.runtime?.sendMessage) finish(undefined, new Error("runtime_unavailable"));
      } catch (error) { finish(undefined, error); }
    });
  }

  function createProfileStorage(chromeApi) {
    const key = resolverModule.PROFILE_STORAGE_KEY;
    return Object.freeze({
      async get(requestedKey) {
        if (requestedKey !== key) return {};
        const response = await runtimeMessage(chromeApi, { type: "STVAI_DOM_PROFILES_GET", provider: "chatgpt" });
        return response?.ok ? { [key]: response.value } : {};
      },
      async set(entries) {
        if (!entries || !Object.hasOwn(entries, key)) return;
        const response = await runtimeMessage(chromeApi, {
          type: "STVAI_DOM_PROFILES_SET", provider: "chatgpt", value: entries[key]
        });
        if (!response?.ok) throw new Error(response?.reason || "profile_storage_failed");
      }
    });
  }

  function createChatGPTAdapter(document, options = {}) {
    const sleep = options.sleep;
    let activeBatchRequestId = "";
    let learnedCurrentDocument = false;
    let performanceMode = "off";
    const verifiedReadySteps = new Set();
    let submissionDiagnostic = createSubmissionDiagnostic();
    const domResolver = options.domResolver || resolverModule.createChatGPTDomResolver(document, {
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

    function setPerformanceMode(mode) {
      performanceMode = mode === "max" ? "max" : mode === "stable" ? "stable" : "off";
      document.documentElement?.classList.toggle("stvai-chatgpt-performance-max", performanceMode === "max");
      return getPerformanceState();
    }

    function getPerformanceState() {
      return {
        mode: performanceMode,
        visibility: ["visible", "hidden", "prerender"].includes(document.visibilityState)
          ? document.visibilityState
          : "unknown",
        focused: Boolean(document.hasFocus?.())
      };
    }

    function findComposer() {
      return domResolver.resolve("composer").element || common.findVisible(document, COMPOSERS);
    }

    function findSendButton() {
      return domResolver.resolve("send", { composer: findComposer() }).element
        || common.findVisible(document, SEND_BUTTONS);
    }

    function findStopButton() {
      return domResolver.resolve("stop", { composer: findComposer() }).element
        || common.findVisible(document, STOP_BUTTONS);
    }

    function hasABComparison() {
      return Boolean(common.findVisible(document, [
        "[data-testid='response-comparison']",
        "[aria-label*='response do you prefer']"
      ])) || common.pageHasText(
        document,
        ["main", "[role='dialog']"],
        /which response do you prefer|choose (?:the )?better response/i
      );
    }

    function getStatus() {
      if (common.pageHasText(
        document,
        ["body"],
        /performing security verification|verif(?:y|ies) you are not a bot|protect against malicious bots|checking (?:if )?(?:the )?site connection is secure/i
      )) {
        return { state: "paused", code: "security_verification", message: "Hãy hoàn tất bước xác minh bảo mật thủ công trên ChatGPT." };
      }
      if (hasABComparison()) {
        return {
          state: "paused",
          code: "ab_comparison",
          message: "ChatGPT đang yêu cầu bạn chọn một phản hồi. Hãy chọn thủ công rồi tiếp tục."
        };
      }
      if (common.findVisible(document, [
        "iframe[src*='captcha']",
        "iframe[src*='challenge']",
        ".g-recaptcha",
        ".cf-turnstile",
        "#challenge-running"
      ])) {
        return { state: "paused", code: "captcha", message: "Hãy hoàn tất CAPTCHA thủ công trên ChatGPT." };
      }
      if (common.findVisible(document, [
        "button[data-testid='login-button']",
        "a[href*='/auth/login']",
        "a[href*='/auth/0']"
      ])) {
        return { state: "paused", code: "login_required", message: "Hãy đăng nhập ChatGPT rồi tiếp tục." };
      }
      if (common.pageHasText(
        document,
        ["[role='alert']", "[data-testid='conversation-turn-error']", ".error-message"],
        /usage limit|rate limit|too many requests|try again later|reached (?:the|your) limit/i
      )) {
        return { state: "paused", code: "rate_limited", message: "ChatGPT đang giới hạn lượt sử dụng." };
      }
      const composer = findComposer();
      const conversationIsRendering = !composer && Boolean(
        findStopButton()
        || domResolver.resolve("response").element
        || common.findVisible(document, RESPONSES)
      );
      if (!composer && !conversationIsRendering) {
        return { state: "paused", code: "ui_changed", message: "Không nhận diện được ô nhập của ChatGPT." };
      }
      return { state: "ready" };
    }

    async function waitUntilReady({ signal, timeoutMs } = {}) {
      return common.waitForElement(findComposer, {
        timeoutMs: timeoutMs ?? options.sendTimeoutMs ?? 10_000,
        intervalMs: options.pollIntervalMs ?? 100,
        now: options.now,
        sleep,
        signal
      });
    }

    function temporaryIsActive(control) {
      return control?.getAttribute("aria-pressed") === "true"
        || control?.getAttribute("data-state") === "on"
        || control?.getAttribute("data-state") === "checked";
    }

    function temporaryPageIsActive() {
      if (!findComposer()) return false;
      try {
        if (new URL(document.defaultView.location.href).searchParams.get("temporary-chat") === "true") {
          return true;
        }
      } catch (_error) {
        // The visible page heading below remains the authoritative fallback.
      }
      return Array.from(document.querySelectorAll("h1, h2, [role='heading']")).some((heading) => (
        common.isVisible(heading)
        && /^(temporary chat|trò chuyện tạm thời)$/i.test(common.textOf(heading))
      ));
    }

    function temporaryIntroContainerMatches(container) {
      if (!common.isVisible(container)) return false;
      const heading = Array.from(container.querySelectorAll("h1, h2, h3, [role='heading'], div, span, p, strong")).find((candidate) => (
          common.isVisible(candidate) && TEMPORARY_INTRO_TITLE.test(common.textOf(candidate))
      ));
      const continueButton = Array.from(container.querySelectorAll("button")).find((button) => (
        common.buttonIsEnabled(button) && TEMPORARY_INTRO_CONTINUE.test(common.textOf(button))
      ));
      return Boolean(heading && continueButton);
    }

    function findTemporaryIntroDialog() {
      const semanticDialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
        .find(temporaryIntroContainerMatches);
      if (semanticDialog) return semanticDialog;

      const continueButtons = Array.from(document.querySelectorAll("button")).filter((button) => (
        common.buttonIsEnabled(button) && TEMPORARY_INTRO_CONTINUE.test(common.textOf(button))
      ));
      for (const continueButton of continueButtons) {
        let container = continueButton.parentElement;
        for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
          if (["BODY", "HTML"].includes(container.tagName)) break;
          if (temporaryIntroContainerMatches(container) && findTemporaryIntroDismiss(container)) return container;
        }
      }
      return null;
    }

    function findTemporaryIntroDismiss(dialog) {
      const buttons = Array.from(dialog?.querySelectorAll("button") || []).filter(common.buttonIsEnabled);
      const semantic = buttons.find((button) => TEMPORARY_INTRO_DISMISS.test([
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.getAttribute("data-testid")
      ].filter(Boolean).join(" ")));
      if (semantic) return semantic;
      const glyph = buttons.find((button) => /^[×✕✖x]$/i.test(common.textOf(button)));
      if (glyph) return glyph;
      const iconOnly = buttons.filter((button) => !common.textOf(button) && button.querySelector("svg"));
      return iconOnly.length === 1 ? iconOnly[0] : null;
    }

    async function dismissTemporaryIntroPopup({ signal, timeoutMs = 2_000 } = {}) {
      const dialog = findTemporaryIntroDialog();
      if (!dialog) return false;
      const dismiss = findTemporaryIntroDismiss(dialog);
      if (!dismiss) {
        throw new common.ProviderError(
          "temporary_unavailable",
          "Hãy đóng popup giới thiệu Temporary Chat trên ChatGPT."
        );
      }
      dismiss.click();
      try {
        await common.waitForElement(
          () => (!dialog.isConnected || !common.isVisible(dialog)) ? (findComposer() || document.body) : null,
          {
            timeoutMs: Math.max(0, timeoutMs),
            intervalMs: options.pollIntervalMs ?? 100,
            now: options.now,
            sleep,
            signal
          }
        );
      } catch (error) {
        if (error?.code === "cancelled") throw error;
        throw new common.ProviderError(
          "temporary_unavailable",
          "Không đóng được popup giới thiệu Temporary Chat trên ChatGPT."
        );
      }
      return true;
    }

    async function prepareSession({ temporaryChat = true, signal, timeoutMs } = {}) {
      if (!temporaryChat) return;
      const now = options.now || Date.now;
      const stageTimeoutMs = timeoutMs ?? options.temporaryTimeoutMs ?? 10_000;
      const startedAt = now();
      const remaining = () => Math.max(0, stageTimeoutMs - (now() - startedAt));
      await dismissTemporaryIntroPopup({ signal, timeoutMs: Math.min(2_000, remaining()) });
      if (temporaryPageIsActive()) return;
      let control;
      try {
        const ready = await common.waitForElement(
          () => {
            if (temporaryPageIsActive()) return { activePage: true };
            return common.findVisible(document, TEMPORARY_CONTROLS);
          },
          {
            timeoutMs: remaining(),
            intervalMs: options.pollIntervalMs ?? 100,
            now: options.now,
            sleep,
            signal
          }
        );
        if (ready.activePage) {
          await dismissTemporaryIntroPopup({ signal, timeoutMs: Math.min(2_000, remaining()) });
          return;
        }
        control = ready;
      } catch (error) {
        if (error?.code === "cancelled") throw error;
        throw new common.ProviderError(
          "temporary_unavailable",
          "Không tìm thấy chế độ Temporary Chat trên ChatGPT."
        );
      }
      if (!temporaryIsActive(control)) control.click();
      try {
        await common.waitForElement(
          () => temporaryPageIsActive() ? (findComposer() || document.body) : null,
          {
            timeoutMs: remaining(),
            intervalMs: options.pollIntervalMs ?? 100,
            now: options.now,
            sleep,
            signal
          }
        );
      } catch (error) {
        if (error?.code === "cancelled") throw error;
        throw new common.ProviderError(
          "temporary_unavailable",
          "Không xác nhận được chế độ Temporary Chat trên ChatGPT."
        );
      }
      await dismissTemporaryIntroPopup({ signal, timeoutMs: Math.min(2_000, remaining()) });
    }

    async function sendPrompt(prompt, sendOptions = {}) {
      submissionDiagnostic = createSubmissionDiagnostic();
      await dismissTemporaryIntroPopup({
        signal: sendOptions.signal,
        timeoutMs: Math.min(2_000, sendOptions.timeoutMs ?? options.sendTimeoutMs ?? 30_000)
      });
      const state = getStatus();
      if (state.state !== "ready") {
        throw new common.ProviderError(state.code, state.message);
      }
      const requestId = String(sendOptions.requestId || "").trim();
      activeBatchRequestId = /^batch_\d+_\d{4}$/.test(requestId) ? requestId : "";
      const alreadySent = () => Boolean(requestId) && USER_MESSAGES.some((selector) => (
        Array.from(document.querySelectorAll(selector)).some((node) => (
          common.textOf(node).split(/\r?\n/, 1)[0]?.trim() === requestId
        ))
      ));
      if (alreadySent()) {
        submissionDiagnostic.requestAlreadyPresent = true;
        submissionDiagnostic.submissionConfirmed = true;
        submissionDiagnostic.sendButtonState = "submission_confirmed";
        return { alreadySent: true };
      }
      if (findStopButton()) {
        submissionDiagnostic.sendButtonState = "stop_visible";
        throw new common.ProviderError("provider_busy", "ChatGPT đang sinh phản hồi; nội dung chưa được gửi.");
      }
      const composer = findComposer();
      if (!composer) {
        submissionDiagnostic.composerState = "not_found";
        throw new common.ProviderError("ui_changed", "Không tìm thấy ô nhập ChatGPT.");
      }
      const before = readComposerText(composer);
      submissionDiagnostic.composerState = before ? "filled" : "empty_before_write";
      if (before !== prompt.trim()) {
        common.setComposerText(composer, prompt);
        submissionDiagnostic.inputEventDispatched = true;
      }
      const after = readComposerText(composer);
      submissionDiagnostic.composerLengthBucket = lengthBucket(after);
      submissionDiagnostic.composerState = after === prompt.trim() ? "filled" : "write_failed";
      if (after !== prompt.trim()) {
        throw new common.ProviderError("ui_changed", "ChatGPT không nhận đủ nội dung trong ô nhập.");
      }

      const now = options.now || Date.now;
      const stageTimeoutMs = sendOptions.timeoutMs ?? options.sendTimeoutMs ?? 30_000;
      const startedAt = now();
      const remaining = () => Math.max(0, stageTimeoutMs - (now() - startedAt));
      const waitOptions = {
        intervalMs: options.pollIntervalMs ?? 100,
        now: options.now,
        sleep,
        waitForChange: options.now || options.sleep ? undefined : waitForResponseChange,
        signal: sendOptions.signal
      };
      const readEnabledSend = () => {
        if (findStopButton()) {
          submissionDiagnostic.sendButtonState = "stop_visible";
          return null;
        }
        const candidate = findSendButton();
        submissionDiagnostic.sendButtonState = candidate
          ? (common.buttonIsEnabled(candidate) ? "enabled" : "disabled")
          : "not_found";
        return common.buttonIsEnabled(candidate) ? candidate : null;
      };
      await common.waitForElement(
        readEnabledSend,
        { ...waitOptions, timeoutMs: remaining() }
      );
      const settleMs = Math.max(0, Number(options.sendSettleMs ?? 300) || 0);
      if (settleMs) {
        const settleSleep = options.sleep || ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
        await settleSleep(Math.min(settleMs, remaining()));
      }
      const button = await common.waitForElement(
        () => {
          if (alreadySent()) return document.body;
          return readEnabledSend();
        },
        { ...waitOptions, timeoutMs: remaining() }
      );
      if (alreadySent()) {
        submissionDiagnostic.requestAlreadyPresent = true;
        submissionDiagnostic.submissionConfirmed = true;
        submissionDiagnostic.sendButtonState = "submission_confirmed";
        return { alreadySent: true };
      }
      submissionDiagnostic.clickAttempted = true;
      submissionDiagnostic.sendButtonState = "clicked";
      button.focus?.();
      button.click();
      try {
        await common.waitForElement(
          () => {
            if (alreadySent() || findStopButton()) return document.body;
            const currentComposer = findComposer();
            if (!composer.isConnected || (currentComposer && !readComposerText(currentComposer))) {
              return currentComposer || document.body;
            }
            return null;
          },
          {
            ...waitOptions,
            timeoutMs: Math.min(remaining(), options.sendConfirmTimeoutMs ?? remaining())
          }
        );
        submissionDiagnostic.submissionConfirmed = true;
        submissionDiagnostic.sendButtonState = "submission_confirmed";
        const currentComposer = findComposer();
        if (currentComposer && !readComposerText(currentComposer)) {
          submissionDiagnostic.composerState = "cleared_after_send";
        }
        return;
      } catch (error) {
        if (error?.code === "cancelled") throw error;
      }
      submissionDiagnostic.sendButtonState = "click_unconfirmed";
      throw new common.ProviderError(
        "send_not_confirmed",
        "ChatGPT chưa nhận thao tác gửi nội dung."
      );
    }

    function readResponseText(response) {
      if (!response) return "";
      const content = response.querySelector(".markdown, [data-message-content], .prose");
      if (content) return common.textOf(content);

      const sanitized = response.cloneNode(true);
      sanitized.querySelectorAll("button, [role='button'], [role='toolbar']")
        .forEach(control => control.remove());
      return common.textOf(sanitized);
    }

    function responseElements() {
      const resolved = domResolver.resolve("response").element;
      const seen = new Set();
      const responses = [];
      for (const selector of RESPONSES) {
        for (const element of document.querySelectorAll(selector)) {
          if (!seen.has(element) && common.isVisible(element)) {
            seen.add(element);
            responses.push(element);
          }
        }
      }
      if (resolved && !seen.has(resolved) && common.isVisible(resolved)) responses.push(resolved);
      return responses;
    }

    function findLatestResponse() {
      const responses = responseElements();
      if (!responses.length) return "";
      if (activeBatchRequestId) {
        const matching = responses.map((element, index) => ({
          element,
          index,
          text: readResponseText(element)
        })).filter(candidate => common.responseHasRequestId(candidate.text, activeBatchRequestId))
          .sort((left, right) => right.text.length - left.text.length || right.index - left.index);
        if (matching.length) return matching[0].element;
      }
      responses.sort((a, b) => {
        const relation = a.compareDocumentPosition(b);
        return relation & 4 ? -1 : relation & 2 ? 1 : 0;
      });
      return responses[responses.length - 1];
    }

    function readLatestResponse() {
      return readResponseText(findLatestResponse());
    }

    function hasResponseMarker(marker) {
      const expected = String(marker || "").trim();
      if (!expected) return false;
      for (const response of responseElements()) {
        if (readResponseText(response) === expected) return true;
      }
      return false;
    }

    function readResponseState() {
      const text = readLatestResponse();
      const response = findLatestResponse();
      const complete = Boolean(domResolver.resolve("completion", { response }).element);
      const refused = common.classifyTerminalResponse(text, null, "") === "content_refused";
      return {
        text,
        generating: findStopButton() ? true : refused || complete || findSendButton() ? false : null,
        terminalCode: refused && !findStopButton() ? "content_refused" : ""
      };
    }

    function waitForResponseChange({ timeoutMs = 500, signal } = {}) {
      const Observer = document.defaultView?.MutationObserver;
      if (!Observer || !document.documentElement) return Promise.resolve({ kind: "timer", at: Date.now() });
      return new Promise((resolve, reject) => {
        let observer;
        let timer;
        const finish = value => {
          clearTimeout(timer);
          observer?.disconnect();
          signal?.removeEventListener("abort", abort);
          resolve(value);
        };
        const abort = () => {
          clearTimeout(timer); observer?.disconnect();
          reject(new common.ProviderError("cancelled", "Tác vụ đã bị hủy."));
        };
        if (signal?.aborted) return abort();
        observer = new Observer(() => finish({ kind: "mutation", at: Date.now() }));
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
        timer = setTimeout(() => finish({ kind: "timer", at: Date.now() }), Math.max(0, Number(timeoutMs) || 0));
        signal?.addEventListener("abort", abort, { once: true });
      });
    }

    async function onAccepted(message) {
      if (message?.phase === "setup") {
        const index = Number(message.setupIndex);
        if (Number.isInteger(index) && index >= 0 && index <= 2) verifiedReadySteps.add(index);
        return;
      }
      if (message?.phase !== "batch" || verifiedReadySteps.size !== 3 || learnedCurrentDocument) return;
      learnedCurrentDocument = await domResolver.learnVerified();
    }

    async function onFailure(error) {
      if (error?.code !== "ui_changed") return;
      const snapshot = domResolver.getDiagnosticSnapshot?.();
      const profileIds = new Set(Object.values(snapshot?.roles || {})
        .filter(role => role?.source === "local" && role.profileId).map(role => role.profileId));
      for (const profileId of profileIds) await domResolver.invalidateProfile(profileId);
    }

    return Object.freeze({
      findComposer,
      findSendButton,
      getSubmissionDiagnostic,
      getDomDiagnostic: () => domResolver.probe(),
      getPerformanceState,
      getStatus,
      hasResponseMarker,
      onAccepted,
      onFailure,
      prepareSession,
      readLatestResponse,
      readResponseState,
      ready: () => domResolver.ready?.(),
      setPerformanceMode,
      waitForResponseChange,
      waitUntilReady,
      sendPrompt
    });
  }

  return Object.freeze({ createChatGPTAdapter, createProfileStorage });
});
