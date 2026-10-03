(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIGeminiAccountService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "stvai-gemini-accounts-v1";
  const RETRY_LIMIT = 5;
  const COOLDOWN_MS = 60 * 60 * 1000;
  const validKey = key => /^[a-f0-9]{64}$/.test(String(key || ""));
  const validIndex = index => Number.isInteger(index) && index >= 0 && index < 20;
  const accountUrl = index => `https://gemini.google.com/u/${index}/app`;
  const fault = code => Object.assign(new Error(code), { code });

  function sanitizeState(input) {
    const state = { version: 1, accounts: [], selectedKey: "", retries: {}, initialAlternateSelected: false };
    if (input?.version !== 1) return state;
    const keys = new Set();
    for (const row of Array.isArray(input.accounts) ? input.accounts.slice(0, 20) : []) {
      if (!validKey(row?.key) || !validIndex(row?.index) || row.paid !== true || keys.has(row.key)) continue;
      keys.add(row.key);
      state.accounts.push({ key: row.key, index: row.index, paid: true,
        cooldownUntil: Math.max(0, Number(row.cooldownUntil) || 0) });
    }
    if (keys.has(input.selectedKey)) state.selectedKey = input.selectedKey;
    state.initialAlternateSelected = input.initialAlternateSelected === true;
    if (input.scanPending === true && validIndex(input.scanOriginIndex)) {
      state.scanPending = true;
      state.scanOriginIndex = input.scanOriginIndex;
    }
    for (const [tabId, value] of Object.entries(input.retries || {})) {
      if (!/^\d+$/.test(tabId) || !keys.has(value?.key)) continue;
      state.retries[tabId] = { key: value.key, count: Math.min(RETRY_LIMIT, Math.max(0, Math.trunc(Number(value.count) || 0))) };
    }
    return state;
  }

  function createGeminiAccountService(options) {
    const { storage, storageCall, tabs } = options;
    const now = options.now || Date.now;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const preferAlternateAccount = options.preferAlternateAccount === true;
    let serial = Promise.resolve();
    const locked = fn => {
      const next = serial.then(fn, fn);
      serial = next.catch(() => undefined);
      return next;
    };
    const load = async () => sanitizeState((await storageCall(storage.local, "get", STORAGE_KEY))?.[STORAGE_KEY]);
    const save = state => storageCall(storage.local, "set", { [STORAGE_KEY]: sanitizeState(state) });
    async function read(tabId) {
      if (options.read) return options.read(tabId);
      const result = await tabs.sendMessage(tabId, { type: "STVAI_GEMINI_ACCOUNT_SNAPSHOT" });
      if (!result?.ok || !result.snapshot) throw fault("gemini_account_probe_failed");
      return result.snapshot;
    }
    async function wait(tabId, kind, stopped, expectedUrl = "", expectedKey = "") {
      let identityMismatches = 0;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (stopped?.()) throw fault("cancelled");
        try {
          if (expectedUrl && typeof tabs.get === "function") {
            const tab = await tabs.get(tabId);
            if (tab.status === "loading" || new URL(tab.url).pathname !== new URL(expectedUrl).pathname) {
              await sleep(250);
              continue;
            }
          }
          const state = await read(tabId);
          if (state?.kind === kind && (!expectedKey || state.key === expectedKey)) return state;
          if (state?.kind === kind && expectedKey && state.key !== expectedKey) {
            if (++identityMismatches >= 3) throw fault("gemini_account_identity_changed");
          }
          if (state?.kind === "blocked") throw fault("login_required");
        } catch (error) {
          if (["cancelled", "login_required", "gemini_account_identity_changed"].includes(error.code)) throw error;
        }
        await sleep(250);
      }
      throw fault("gemini_account_probe_failed");
    }
    async function navigate(tabId, url, kind, stopped) {
      if (stopped?.()) throw fault("cancelled");
      await tabs.update(tabId, { url });
      return wait(tabId, kind, stopped, url);
    }
    async function scan(tabId, stopped) {
      const original = await wait(tabId, "gemini", stopped);
      if (original.busy || !original.chooserUrl) throw fault("provider_busy");
      const previous = await load();
      previous.scanPending = true;
      previous.scanOriginIndex = original.index;
      await save(previous);
      const chooser = await navigate(tabId, original.chooserUrl, "chooser", stopped);
      const rows = (chooser.rows || []).filter(row => validKey(row.key) && validIndex(row.index));
      if (!rows.length || rows.length > 20 || new Set(rows.map(row => row.index)).size !== rows.length) {
        throw fault("gemini_account_probe_failed");
      }
      const state = { version: 1, accounts: [], selectedKey: "", retries: previous.retries,
        initialAlternateSelected: previous.initialAlternateSelected,
        scanPending: true, scanOriginIndex: original.index };
      try {
        for (const row of rows) {
          const actual = await navigate(tabId, accountUrl(row.index), "gemini", stopped);
          if (actual.key !== row.key) throw fault("gemini_account_identity_changed");
          if (!actual.paid) continue;
          state.accounts.push({ ...row, paid: true,
            cooldownUntil: previous.accounts.find(old => old.key === row.key)?.cooldownUntil || 0 });
          state.selectedKey = state.accounts.some(old => old.key === original.key) ? original.key : state.accounts[0].key;
          await save(state); // partial verified inventory survives worker suspension
        }
        if (!state.accounts.length) throw fault("gemini_paid_account_missing");
        const saved = state.accounts.find(row => row.key === previous.selectedKey && row.cooldownUntil <= now());
        const alternate = preferAlternateAccount && !previous.initialAlternateSelected
          && (saved?.index ?? original.index) === 0
          ? state.accounts.find(row => row.index !== 0 && row.cooldownUntil <= now()) : null;
        const selected = alternate || saved || state.accounts.find(row => row.key === original.key && row.cooldownUntil <= now())
          || state.accounts.find(row => row.cooldownUntil <= now());
        if (!selected) throw fault("gemini_accounts_cooling_down");
        state.selectedKey = selected.key;
        if (preferAlternateAccount) {
          state.initialAlternateSelected = previous.initialAlternateSelected || selected.index !== 0;
        }
        delete state.scanPending;
        delete state.scanOriginIndex;
        await save(state);
        await select(tabId, selected, stopped);
        return state;
      } catch (error) {
        // Restore a known route, without erasing the partial verified inventory.
        if (!stopped?.()) await navigate(tabId, accountUrl(original.index), "gemini", stopped).catch(() => undefined);
        throw error;
      }
    }
    async function select(tabId, row, stopped) {
      await navigate(tabId, accountUrl(row.index), "gemini", stopped);
      const actual = await wait(tabId, "gemini", stopped, accountUrl(row.index), row.key);
      if (actual.key !== row.key) throw fault("gemini_account_identity_changed");
      if (!actual.paid) throw fault("gemini_paid_account_missing");
      return actual;
    }
    async function ensure(tabId, stopped) {
      let state = await load();
      if (state.scanPending) {
        await navigate(tabId, accountUrl(state.scanOriginIndex), "gemini", stopped);
        state = await scan(tabId, stopped);
      } else if (!state.accounts.length) state = await scan(tabId, stopped);
      if (preferAlternateAccount && !state.initialAlternateSelected) {
        const saved = state.accounts.find(row => row.key === state.selectedKey && row.cooldownUntil <= now());
        const alternate = saved?.index === 0
          ? state.accounts.find(row => row.index !== 0 && row.cooldownUntil <= now()) : null;
        if (alternate) state.selectedKey = alternate.key;
        state.initialAlternateSelected = Boolean(alternate || (saved && saved.index !== 0));
        await save(state);
      }
      const selected = state.accounts.find(row => row.key === state.selectedKey && row.cooldownUntil <= now())
        || state.accounts.find(row => row.cooldownUntil <= now());
      if (!selected) throw fault("gemini_accounts_cooling_down");
      const actual = await wait(tabId, "gemini", stopped);
      if (actual.busy) throw fault("provider_busy");
      if (actual.kind !== "gemini" || actual.key !== selected.key || !actual.paid) await select(tabId, selected, stopped);
      state.selectedKey = selected.key;
      await save(state);
      return selected;
    }
    return Object.freeze({
      verifyCurrent: tabId => locked(async () => {
        const state = await load();
        const actual = await wait(tabId, "gemini");
        if (actual.kind !== "gemini" || !actual.paid || !state.accounts.some(row => row.key === actual.key)) {
          throw fault("gemini_paid_account_missing");
        }
        return true;
      }),
      preferredUrl: () => locked(async () => {
        const state = await load();
        const selected = state.accounts.find(row => row.key === state.selectedKey && row.cooldownUntil <= now())
          || state.accounts.find(row => row.cooldownUntil <= now())
          || state.accounts.find(row => row.key === state.selectedKey);
        return selected ? accountUrl(selected.index) : "";
      }),
      ensureSelected: (tabId, stopped) => locked(() => ensure(tabId, stopped)),
      scan: (tabId, stopped) => locked(() => scan(tabId, stopped)),
      async recover1095(tabId, stopped) {
        return locked(async () => {
          const state = await load();
          const actual = await wait(tabId, "gemini", stopped);
          if (actual.busy) throw fault("provider_busy");
          const current = state.accounts.find(row => row.key === actual.key);
          if (!current || !actual.paid) throw fault("gemini_paid_account_missing");
          const retries = state.retries[tabId]?.key === current.key ? state.retries[tabId].count : 0;
          let selected = current;
          let action = "retry";
          if (retries >= RETRY_LIMIT || current.cooldownUntil > now()) {
            current.cooldownUntil = Math.max(current.cooldownUntil, now() + COOLDOWN_MS);
            const start = state.accounts.indexOf(current);
            selected = [...state.accounts.slice(start + 1), ...state.accounts.slice(0, start)]
              .find(row => row.cooldownUntil <= now());
            action = "rotated";
            if (!selected) {
              await save(state);
              throw fault("gemini_accounts_cooling_down");
            }
          }
          state.selectedKey = selected.key;
          if (preferAlternateAccount && selected.index !== 0) state.initialAlternateSelected = true;
          state.retries[tabId] = { key: selected.key, count: action === "retry" ? retries + 1 : 0 };
          await save(state); // reserve retry/selection before navigation
          await select(tabId, selected, stopped);
          return { action, attempt: state.retries[tabId].count, accountOrdinal: selected.index + 1 };
        });
      },
      markBatchSucceeded: tabId => locked(async () => {
        const state = await load();
        delete state.retries[tabId];
        await save(state);
      }),
      status: () => locked(async () => {
        const state = await load();
        return { paidCount: state.accounts.length,
          selectedOrdinal: (state.accounts.find(row => row.key === state.selectedKey)?.index ?? -1) + 1,
          coolingDownCount: state.accounts.filter(row => row.cooldownUntil > now()).length };
      })
    });
  }
  return Object.freeze({ STORAGE_KEY, RETRY_LIMIT, COOLDOWN_MS, accountUrl, sanitizeState, createGeminiAccountService });
});
