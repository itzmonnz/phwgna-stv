(function attachTtsClient(root, factory) {
  const pronunciation = root.STVAITTSPronunciation || (typeof require === "function" ? require("../shared/tts-pronunciation.js") : null);
  const api = factory(pronunciation);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAITTSClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTtsClientApi(pronunciation) {
  "use strict";

  const COMMAND_EVENT = "stvai:tts-command";
  const RESULT_EVENT = "stvai:tts-result";
  const STATUS_EVENT = "stvai:tts-status";
  const ACTIONS = new Set(["arm", "inspect", "open", "watch", "complete", "pause", "resume", "stop", "release", "pronunciation-open", "pronunciation-close", "preview"]);
  const LISTENING_STATES = new Set(["absent", "ready", "playing", "user_paused", "menu_paused", "waiting_batch", "completed"]);
  const STATUS_CODES = new Set(["chapter_changed", "player_stopped", "reader_opened", "native_listen_requested"]);

  function createRequestId() {
    return `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function request(document, action, options = {}) {
    if (!ACTIONS.has(action)) return Promise.reject(new Error("Lệnh TTS không hợp lệ."));
    if (action === 'preview' && (typeof options.text !== 'string' || !options.text.trim() || options.text.length > 200)) {
      return Promise.reject(new Error('Nội dung nghe thử phải dài từ 1 đến 200 ký tự.'));
    }
    const requestId = String(options.requestId || createRequestId());
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) {
      return Promise.reject(new Error("Mã lệnh TTS không hợp lệ."));
    }
    const timeoutMs = Math.max(1, Math.min(10_000, Number(options.timeoutMs) || 2500));
    let pronunciations;
    if (action === "open" && Object.hasOwn(options, "pronunciations")) {
      try { pronunciations = pronunciation.sanitizeRules(options.pronunciations, { strict: true }); }
      catch (error) { return Promise.reject(error); }
    }
    const Window = document.defaultView;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        document.removeEventListener(RESULT_EVENT, onResult);
        if (error) reject(error);
        else resolve(value);
      };
      const onResult = (event) => {
        try {
          const value = JSON.parse(String(event.detail || ""));
          if (value?.requestId !== requestId) return;
          if (!value.ok) finish(undefined, new Error(String(value.code || "STV TTS không khả dụng.")));
          else if (action === "inspect") {
            if (value.code !== "inspected" || !LISTENING_STATES.has(value.listeningState)) return;
            finish({ ok: true, requestId, code: "inspected", listeningState: value.listeningState });
          } else finish({ ok: true, requestId, code: String(value.code || "ok") });
        } catch (_error) {
          // Ignore malformed events from the host page and keep waiting for the matching response.
        }
      };
      const timeout = setTimeout(() => finish(undefined, new Error("STV TTS không phản hồi.")), timeoutMs);
      document.addEventListener(RESULT_EVENT, onResult);
      const command = { action, requestId };
      if (action === 'preview') command.text = options.text.trim();
      if (action === "open" && pronunciations) command.pronunciations = pronunciations;
      document.dispatchEvent(new Window.CustomEvent(COMMAND_EVENT, {
        detail: JSON.stringify(command)
      }));
    });
  }

  function subscribe(document, listener) {
    if (typeof listener !== "function") throw new TypeError("TTS status listener is required.");
    const onStatus = (event) => {
      try {
        const value = JSON.parse(String(event.detail || ""));
        if (!STATUS_CODES.has(value?.code)) return;
        listener({ code: value.code });
      } catch (_error) {
        // The page is untrusted. Ignore malformed or non-allowlisted status events.
      }
    };
    document.addEventListener(STATUS_EVENT, onStatus);
    return () => document.removeEventListener(STATUS_EVENT, onStatus);
  }

  return Object.freeze({ COMMAND_EVENT, RESULT_EVENT, STATUS_EVENT, createRequestId, request, subscribe });
});
