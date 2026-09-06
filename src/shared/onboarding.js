(function attachOnboarding(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIOnboarding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createOnboardingApi() {
  "use strict";

  const STORAGE_KEY = "stvaiOnboarding";
  const DEFAULT_VERSION = 1;
  const PROVIDER_URLS = Object.freeze({
    gemini: "https://gemini.google.com/app",
    chatgpt: "https://chatgpt.com/"
  });
  const PROVIDER_PATTERNS = Object.freeze({
    gemini: ["https://gemini.google.com/*"],
    chatgpt: ["https://chatgpt.com/*"]
  });
  const STV_PATTERNS = Object.freeze([
    "https://sangtacviet.app/*",
    "https://sangtacviet.com/*",
    "http://sangtacviet.com/*",
    "http://14.225.254.182/*"
  ]);

  function callChrome(target, method, argument) {
    return new Promise((resolve, reject) => {
      try {
        let settled = false;
        const callback = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const result = target[method](argument, callback);
        if (result?.then) result.then(callback, reject);
        else if (target[method].length < 2 && !settled) callback(result);
      } catch (error) {
        reject(error);
      }
    });
  }

  function createOnboardingService(options = {}) {
    const core = options.core;
    const storage = options.storage;
    const tabs = options.tabs;
    const runtime = options.runtime;
    const version = Math.max(1, Number(options.version || DEFAULT_VERSION));
    if (!core || !storage?.local || !tabs || !runtime?.getURL) {
      throw new TypeError("core, storage.local, tabs, and runtime are required");
    }

    async function readState() {
      return callChrome(storage.local, "get", ["settings", STORAGE_KEY]);
    }

    async function writeState(patch) {
      await callChrome(storage.local, "set", patch);
    }

    async function openOnboarding() {
      await tabs.create({ url: runtime.getURL("onboarding/onboarding.html"), active: true });
    }

    async function handleInstalled(details = {}) {
      const reason = String(details.reason || "");
      const stored = await readState();
      const current = stored?.[STORAGE_KEY];
      if (reason === "install") {
        const patch = { [STORAGE_KEY]: { version, completed: false } };
        if (!stored?.settings || typeof stored.settings !== "object") {
          patch.settings = core.normalizeSettings({ ...core.DEFAULT_SETTINGS, provider: "gemini" });
        }
        await writeState(patch);
        await openOnboarding();
        return { ok: true, opened: true };
      }
      if (reason !== "update") return { ok: true, opened: false };
      if (!current || typeof current !== "object") {
        await writeState({ [STORAGE_KEY]: { version, completed: true, migrated: true } });
        return { ok: true, opened: false };
      }
      if (Number(current.version) < version) {
        await writeState({ [STORAGE_KEY]: { version, completed: false } });
        await openOnboarding();
        return { ok: true, opened: true };
      }
      return { ok: true, opened: false };
    }

    async function query(patterns) {
      try { return await tabs.query({ url: patterns }); }
      catch (_error) { return []; }
    }

    async function status() {
      const stored = await readState();
      const settings = core.normalizeSettings(stored?.settings || core.DEFAULT_SETTINGS);
      const provider = settings.provider === "chatgpt" ? "chatgpt" : "gemini";
      const candidates = await query(PROVIDER_PATTERNS[provider]);
      let providerReady = false;
      for (const tab of candidates) {
        if (!Number.isInteger(tab?.id)) continue;
        try {
          const response = await tabs.sendMessage(tab.id, { type: "STVAI_PROVIDER_STATUS" });
          const state = String(response?.state?.state || response?.state || "");
          if (response?.ok === true && ["ready", "idle"].includes(state)) {
            providerReady = true;
            break;
          }
        } catch (_error) {
          // A loading or signed-out provider tab is reported as not ready.
        }
      }
      return {
        ok: true,
        provider,
        providerReady,
        completed: stored?.[STORAGE_KEY]?.completed === true
      };
    }

    async function openProvider() {
      const stored = await readState();
      const settings = core.normalizeSettings(stored?.settings || core.DEFAULT_SETTINGS);
      const provider = settings.provider === "chatgpt" ? "chatgpt" : "gemini";
      const existing = (await query(PROVIDER_PATTERNS[provider])).find((tab) => Number.isInteger(tab?.id));
      if (existing) await tabs.update(existing.id, { active: true });
      else await tabs.create({ url: PROVIDER_URLS[provider], active: true });
      return { ok: true, provider };
    }

    async function finish() {
      await writeState({ [STORAGE_KEY]: { version, completed: true } });
      const existing = (await query(STV_PATTERNS)).find((tab) => Number.isInteger(tab?.id));
      if (existing) await tabs.update(existing.id, { active: true });
      else await tabs.create({ url: "https://sangtacviet.app/", active: true });
      return { ok: true };
    }

    async function handleMessage(message, sender = {}) {
      const trustedPrefix = runtime.getURL("onboarding/");
      const senderUrl = typeof sender?.url === "string" ? sender.url : "";
      if (sender?.tab || !senderUrl.startsWith(trustedPrefix)) {
        return { ok: false, reason: "trusted-context-required" };
      }
      if (message?.type === "STVAI_ONBOARDING_STATUS") return status();
      if (message?.type === "STVAI_ONBOARDING_OPEN_PROVIDER") return openProvider();
      if (message?.type === "STVAI_ONBOARDING_FINISH") return finish();
      return undefined;
    }

    return Object.freeze({ handleInstalled, handleMessage, status, openProvider, finish });
  }

  return Object.freeze({ createOnboardingService, STORAGE_KEY, DEFAULT_VERSION });
});
