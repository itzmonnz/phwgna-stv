(function attachTtsSessionService(root, factory) {
  const contracts = root.STVAIBackgroundContracts
    || (typeof require === "function" ? require("./contracts.js") : null);
  const api = factory(contracts);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAITtsSessionService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTtsSessionApi(contracts) {
  "use strict";

  function createTtsSessionService(options = {}) {
    const { sites, storage, tabs, storageCall, resolveStvSenderChapter, createId } = options;
    const sessionStorage = storage && storage.session;
    const prefix = contracts.TTS_SESSION_PREFIX;
    let serial = Promise.resolve();

    function withLock(operation) {
      const next = serial.then(operation, operation);
      serial = next.catch(() => undefined);
      return next;
    }

    function chapterUrl(value) {
      return sites.chapterUrl(value);
    }

    function followingUrl(value, currentValue) {
      const current = sites.parseChapter(currentValue);
      const next = sites.parseChapter(value, { base: currentValue });
      if (!current || !next || current.origin !== next.origin
        || current.bookKey !== next.bookKey || current.chapterId === next.chapterId) return "";
      return next.url;
    }

    async function clear(tabId) {
      return withLock(async () => {
        if (!sessionStorage?.remove) return;
        if (Number.isInteger(tabId)) {
          await storageCall(sessionStorage, "remove", `${prefix}${tabId}`);
        } else {
          const stored = await storageCall(sessionStorage, "get", null);
          const keys = Object.keys(stored || {}).filter(key => key.startsWith(prefix));
          if (keys.length) await storageCall(sessionStorage, "remove", keys);
        }
      });
    }

    async function trackNavigation(tabId, value) {
      if (!value || !sessionStorage?.get) return;
      return withLock(async () => {
        const key = `${prefix}${tabId}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        if (!session) return;
        const url = chapterUrl(value);
        if (url === session.currentUrl) return;
        const current = sites.parseChapter(session.currentUrl);
        const destination = sites.parseChapter(url);
        const followsListeningIntent = session.intent === true
          && current && destination
          && current.origin === destination.origin
          && current.bookKey === destination.bookKey
          && current.chapterId !== destination.chapterId
          && ["playing", "playing_next", "waiting_next"].includes(session.state);
        if (url && (url === session.nextUrl || followsListeningIntent)) {
          await storageCall(sessionStorage, "set", {
            [key]: { ...session, nextUrl: url, state: "waiting_next" }
          });
        } else await storageCall(sessionStorage, "remove", key);
      });
    }

    async function authorizeStart(message, sender, accept) {
      if (!message.ttsSessionId) { accept?.(); return true; }
      return withLock(async () => {
        if (!sessionStorage?.get) return false;
        const key = `${prefix}${sender.tab.id}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        const consent = await storageCall(storage.local, "get", ["ttsConsent", "ttsConsentVersion", "toolEnabled"]);
        const currentChapter = resolveStvSenderChapter(sender, message.chapterId);
        if (!consent.ttsConsent || consent.ttsConsentVersion !== 2 || !consent.toolEnabled
          || session?.sessionId !== message.ttsSessionId || session.state !== "waiting_batch_1"
          || session.currentUrl !== currentChapter?.url) return false;
        if (accept) {
          if (session.jobId !== message.jobId) return false;
          accept();
        } else {
          if (session.jobId && session.jobId !== message.jobId) return false;
          if (!session.jobId) {
            await storageCall(sessionStorage, "set", { [key]: { ...session, jobId: message.jobId } });
          }
        }
        return true;
      });
    }

    async function releaseStart(message, sender) {
      if (!message.ttsSessionId || !Number.isInteger(sender?.tab?.id)) return;
      return withLock(async () => {
        const key = `${prefix}${sender.tab.id}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        if (session?.sessionId !== message.ttsSessionId || session.jobId !== message.jobId) return;
        const { jobId: _jobId, ...unclaimed } = session;
        await storageCall(sessionStorage, "set", { [key]: unclaimed });
      });
    }

    async function handle(message, sender) {
      const tabId = sender?.tab?.id;
      const requestedChapter = sites.parseChapter(message?.currentUrl || message?.url);
      const currentChapter = resolveStvSenderChapter(sender, requestedChapter?.chapterId || "");
      const url = currentChapter?.url || "";
      if (!Number.isInteger(tabId) || !url || (sender.frameId != null && sender.frameId !== 0)) {
        return { ok: false, reason: "unauthorized-sender" };
      }
      return withLock(async () => {
        if (!sessionStorage?.get || !sessionStorage?.set || !sessionStorage?.remove) {
          return { ok: false, reason: "storage_unavailable" };
        }
        const key = `${prefix}${tabId}`;
        const stored = await storageCall(sessionStorage, "get", key);
        const session = stored?.[key];
        if (message.type === "STVAI_TTS_SESSION_CLEAR") {
          if (session && session.currentUrl === url
            && (!message.sessionId || message.sessionId === session.sessionId)) {
            await storageCall(sessionStorage, "remove", key);
          }
          return { ok: true };
        }
        const consent = await storageCall(storage?.local, "get", ["toolEnabled", "ttsConsent", "ttsConsentVersion"]);
        if (consent?.toolEnabled !== true || consent.ttsConsent !== true || consent.ttsConsentVersion !== 2) {
          await storageCall(sessionStorage, "remove", key);
          return { ok: false, reason: "tts_consent_required" };
        }
        if (message.type === "STVAI_TTS_SESSION_START") {
          if (chapterUrl(message.currentUrl) !== url) return { ok: false, reason: "chapter_mismatch" };
          const nextUrl = followingUrl(message.nextUrl, url);
          const value = { tabId, currentUrl: url, nextUrl, state: "playing", intent: true,
            sessionId: createId("tts-session") };
          await storageCall(sessionStorage, "set", { [key]: value });
          return { ok: true, state: value.state, sessionId: value.sessionId };
        }
        if (message.type === "STVAI_TTS_SESSION_CLAIM_NEXT") {
          if (!session) return { ok: true, claimed: false };
          const continuingCurrentChapter = message.historyNavigation !== true && message.reload !== true
            && chapterUrl(message.url) === url && session.currentUrl === url
            && ["playing", "waiting_batch_1", "playing_next"].includes(session.state);
          if (continuingCurrentChapter) {
            const live = await tabs.get(tabId).catch(() => null);
            if (chapterUrl(live?.url) !== url) return { ok: true, claimed: false, holdNative: true };
            const value = { ...session, state: "waiting_batch_1" };
            await storageCall(sessionStorage, "set", { [key]: value });
            return { ok: true, claimed: true, state: value.state, sessionId: value.sessionId,
              ...(value.jobId ? { jobId: value.jobId } : {}) };
          }
          if (message.historyNavigation === true || message.reload === true || chapterUrl(message.url) !== url || session.nextUrl !== url) {
            if (session.currentUrl !== url || message.historyNavigation === true || message.reload === true) await storageCall(sessionStorage, "remove", key);
            const holdNative = message.historyNavigation !== true && message.reload !== true
              && session.currentUrl === url;
            return { ok: true, claimed: false, ...(holdNative ? { holdNative: true } : {}) };
          }
          const live = await tabs.get(tabId).catch(() => null);
          if (chapterUrl(live?.url) !== url) return { ok: true, claimed: false };
          const value = { tabId, currentUrl: url, nextUrl: "", state: "waiting_batch_1", intent: true,
            sessionId: createId("tts-session") };
          await storageCall(sessionStorage, "set", { [key]: value });
          return { ok: true, claimed: true, state: value.state, sessionId: value.sessionId };
        }
        if (!session || session.sessionId !== message.sessionId || session.currentUrl !== url) {
          return { ok: false, reason: "stale-tts-session" };
        }
        if (!["waiting_next", "waiting_batch_1", "playing_next"].includes(message.state)) {
          return { ok: false, reason: "invalid-tts-state" };
        }
        const nextUrl = followingUrl(message.nextUrl, url);
        await storageCall(sessionStorage, "set", { [key]: { ...session, state: message.state,
          nextUrl: message.state === "playing_next" ? nextUrl : session.nextUrl } });
        return { ok: true };
      });
    }

    return Object.freeze({ clear, trackNavigation, authorizeStart, releaseStart, handle });
  }

  return Object.freeze({ createTtsSessionService });
});
