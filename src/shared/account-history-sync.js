(function (root, factory) {
  let retried = false;
  const loadNodeModule = typeof module === 'object' && module && typeof module.require === 'function'
    ? module.require.bind(module) : null;
  function attach() {
    if (root.STVAIAccountHistorySync) return root.STVAIAccountHistorySync;
    const base = root.STVAIHistorySync || (loadNodeModule ? loadNodeModule('./history-sync.js') : null);
    const sites = root.STVAISites || (loadNodeModule ? loadNodeModule('./stv-sites.js') : null);
    const codec = root.STVAINativeHistory || (loadNodeModule ? loadNodeModule('./native-history.js') : null);
    if (!base || !sites || !codec) {
      if (!retried && typeof root.setTimeout === 'function') { retried = true; root.setTimeout(attach, 0); }
      return null;
    }
    const api = factory(base, sites, codec, root.crypto);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.STVAIAccountHistorySync = api;
    return api;
  }
  attach();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAccountHistoryApi(base, sites, codec, cryptoProvider) {
  'use strict';
  const STATE_KEY = 'stvai-native-history-v2';
  const LEGACY_KEY = base.STATE_KEY || 'stvai-native-history-v1';
  const SESSION_KEY = 'stvai-native-history-documents-v2';
  const PREVIEW_KEY = 'stvai-native-history-legacy-preview-v2';
  const SECURE_ORIGINS = sites.ORIGINS.filter(origin => origin.startsWith('https://'));
  const fail = code => ({ ok: false, code });
  const emptyShelf = () => ({ schema: 1, revision: 0, entries: {}, order: [], progress: {}, tombstones: {}, origins: {} });
  const clone = value => structuredClone(value);

  function safeShelf(input) {
    if (!input || input.schema !== 1 || !input.entries || typeof input.entries !== 'object') return emptyShelf();
    const shelf = emptyShelf();
    shelf.revision = Math.max(0, Number(input.revision) || 0);
    shelf.entries = clone(input.entries || {});
    shelf.order = Array.isArray(input.order) ? [...input.order] : Object.keys(shelf.entries);
    shelf.progress = clone(input.progress || {});
    shelf.tombstones = clone(input.tombstones || {});
    return shelf;
  }

  function emptyRoot(legacy, now) {
    const shelf = safeShelf(legacy);
    return { schema: 2, revision: 0, scopes: {}, bindings: {}, legacy: {
      shelf, available: Object.keys(shelf.entries).length > 0, importedTo: '', importedAt: 0, migratedAt: now()
    } };
  }

  async function defaultHash(id) {
    if (!cryptoProvider?.subtle) throw new Error('crypto');
    const bytes = new TextEncoder().encode(`stv-account-v1:${id}`);
    const digest = await cryptoProvider.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function normalizeProof(value) {
    if (value?.status === 'guest') return { status: 'guest' };
    if (value?.status === 'account' && /^[1-9]\d{0,39}$/.test(String(value.id || ''))) {
      return { status: 'account', id: String(value.id) };
    }
    return { status: ['pending', 'unknown', 'ambiguous'].includes(value?.status) ? value.status : 'unknown' };
  }
  const sameProof = (left, right) => left.status === right.status
    && (left.status !== 'account' || left.id === right.id);
  const labelFor = key => key.startsWith('account:') ? `Tài khoản •${key.slice(-4).toUpperCase()}` : 'Chưa đăng nhập';

  function mergeShelf(current, incoming) {
    const state = safeShelf(current);
    for (const [key, value] of Object.entries(incoming?.entries || {})) {
      state.entries[key] = clone(value); delete state.tombstones[key];
    }
    for (const [key, value] of Object.entries(incoming?.progress || {})) {
      if (!state.entries[key] || !/^\d{1,100}$/.test(String(value?.through || ''))) continue;
      const local = /^\d{1,100}$/.test(String(state.progress[key]?.through || '')) ? BigInt(state.progress[key].through) : -1n;
      const remote = BigInt(value.through);
      state.progress[key] = { through: String(local >= remote ? local : remote) };
    }
    const order = [...new Set([...(incoming?.order || []), ...Object.keys(incoming?.entries || {}), ...state.order])];
    state.order = order.filter(key => Object.hasOwn(state.entries, key));
    state.revision = Math.max(state.revision, Number(incoming?.revision) || 0) + 1;
    return state;
  }

  function captureLegacyRaw(root, raw) {
    if (root.legacy.importedTo) return;
    const parsed = codec.parse(raw);
    if (!parsed.ok || !parsed.records.length) return;
    const shelf = emptyShelf();
    for (const record of parsed.records) {
      const safe = codec.portable(record), key = codec.key(safe);
      shelf.entries[key] = { record: safe, kind: 'backup', rank: 0, order: 0, epoch: 'legacy' };
      shelf.order.push(key);
      const chapter = codec.current(safe.current)?.chapterId;
      if (/^\d{1,100}$/.test(String(chapter || '')) && chapter !== '0') shelf.progress[key] = { through: chapter };
    }
    root.legacy.shelf = mergeShelf(root.legacy.shelf, shelf); root.legacy.available = true;
  }

  function createHistorySync({ storage, tabs, now = Date.now, createId, hashAccountId = defaultHash }) {
    let serial = Promise.resolve();
    const services = new Map();
    async function loadRoot() {
      const saved = (await storage.local.get(STATE_KEY))[STATE_KEY];
      if (saved?.schema === 2 && saved.scopes && saved.bindings && saved.legacy) return saved;
      const legacy = (await storage.local.get(LEGACY_KEY))[LEGACY_KEY];
      const root = emptyRoot(legacy, now);
      await storage.local.set({ [STATE_KEY]: root });
      return root;
    }
    async function saveRoot(root) {
      root.revision = Math.max(0, Number(root.revision) || 0) + 1;
      if (JSON.stringify(root).length > 8_000_000) throw new Error('size');
      await storage.local.set({ [STATE_KEY]: root });
    }
    async function scopeFor(proof, origin) {
      if (proof.status === 'guest') return `guest:${origin}`;
      if (proof.status !== 'account') return '';
      return `account:${await hashAccountId(proof.id)}`;
    }
    function scopedStorage(scopeKey) {
      return {
        local: {
          async get(key) {
            const root = await loadRoot();
            return { [key]: clone(root.scopes[scopeKey]?.shelf || emptyShelf()) };
          },
          async set(value) {
            const root = await loadRoot();
            root.scopes[scopeKey] ||= { shelf: emptyShelf() };
            root.scopes[scopeKey].shelf = clone(value[LEGACY_KEY] || emptyShelf());
            await saveRoot(root);
          }
        },
        session: {
          async get(key) {
            const saved = (await storage.session.get(SESSION_KEY))[SESSION_KEY] || { scopes: {} };
            return { [key]: clone(saved.scopes[scopeKey]) };
          },
          async set(value) {
            const saved = (await storage.session.get(SESSION_KEY))[SESSION_KEY] || { scopes: {} };
            saved.scopes[scopeKey] = clone(value[base.SESSION_KEY]);
            await storage.session.set({ [SESSION_KEY]: saved });
          }
        }
      };
    }
    function service(scopeKey) {
      if (!services.has(scopeKey)) services.set(scopeKey, base.createHistorySync({
        storage: scopedStorage(scopeKey), tabs, now, createId
      }));
      return services.get(scopeKey);
    }
    async function activeProof(sender, messageProof) {
      const url = sites.siteUrl(sender?.url);
      if (!url || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0) return { ok: false, code: 'history_unauthorized' };
      if (url.protocol !== 'https:') return { ok: false, code: 'history_insecure_origin' };
      const tab = await tabs.get(sender.tab.id);
      if (sites.siteUrl(tab?.url)?.href !== url.href) return { ok: false, code: 'history_stale_document' };
      const probe = await tabs.sendMessage(sender.tab.id, { type: 'STVAI_HISTORY_ACCOUNT_PROBE' }, { frameId: 0 });
      const claimed = normalizeProof(messageProof), live = normalizeProof(probe?.accountProof);
      if (!sameProof(claimed, live)) return { ok: false, code: 'history_account_changed' };
      return { ok: true, proof: live, url, tabId: sender.tab.id, raw: typeof probe?.raw === 'string' || probe?.raw === null ? probe.raw : null };
    }
    async function exchange(message, sender) {
      const checked = await activeProof(sender, message.accountProof);
      if (!checked.ok) return fail(checked.code);
      const proof = checked.proof;
      const scopeKey = await scopeFor(proof, checked.url.origin);
      const root = await loadRoot();
      const previousBinding = root.bindings[checked.url.origin];
      root.bindings[checked.url.origin] = {
        status: proof.status, scopeKey, label: scopeKey ? labelFor(scopeKey) : '',
        tabId: checked.tabId, lastSeenAt: now()
      };
      if (message.action === 'identity') { await saveRoot(root); return { ok: true, identityOnly: true }; }
      if (!scopeKey) { await saveRoot(root); return fail('history_account_unresolved'); }
      root.scopes[scopeKey] ||= { shelf: emptyShelf() };
      if (proof.status === 'account' && previousBinding?.scopeKey !== scopeKey) {
        captureLegacyRaw(root, checked.raw);
        const originState = root.scopes[scopeKey].shelf.origins[checked.url.origin] || { suppressed: [] };
        if (!Object.hasOwn(originState, 'backup')) originState.backup = checked.raw;
        originState.observed = true; originState.lastRaw = checked.raw; originState.lastSeenAt = now();
        originState.suppressed ||= [];
        delete originState.pending; delete originState.syncedRevision;
        root.scopes[scopeKey].shelf.origins[checked.url.origin] = originState;
        const parsed = codec.parse(checked.raw);
        if (parsed.ok) {
          for (const record of parsed.records) {
            const key = codec.key(record);
            if (!Object.hasOwn(root.scopes[scopeKey].shelf.entries, key)) {
              root.scopes[scopeKey].shelf.tombstones[key] = { revision: root.scopes[scopeKey].shelf.revision + 1 };
            }
          }
        }
      }
      await saveRoot(root);
      return service(scopeKey).handle(message, sender);
    }
    function handle(message, sender) {
      const result = serial.then(() => exchange(message, sender)).catch(() => fail('history_storage_unavailable'));
      serial = result.then(() => undefined);
      return result;
    }
    async function status() {
      return serial.then(async () => {
        const root = await loadRoot();
        return { ok: true, schema: 2, origins: SECURE_ORIGINS.map(origin => {
          const binding = root.bindings[origin];
          const shelf = binding?.scopeKey ? root.scopes[binding.scopeKey]?.shelf : null;
          const state = binding?.status === 'account' ? 'account' : binding?.status === 'guest' ? 'guest'
            : binding?.status === 'ambiguous' ? 'ambiguous' : binding ? 'pending' : 'unseen';
          return { origin, status: state, accountLabel: binding?.label || '',
            recordCount: Object.keys(shelf?.entries || {}).length, lastSeenAt: Number(binding?.lastSeenAt) || 0 };
        }), legacy: { available: root.legacy.available === true, imported: Boolean(root.legacy.importedTo),
          recordCount: Object.keys(root.legacy.shelf?.entries || {}).length } };
      });
    }
    async function previewLegacy() {
      return serial.then(async () => {
        const root = await loadRoot();
        const accounts = [...new Map(Object.values(root.bindings).filter(value => value?.status === 'account' && value.scopeKey)
          .map(value => [value.scopeKey, { accountKey: value.scopeKey, label: value.label }])).values()];
        const nonce = createId ? createId() : `${now()}-${Math.random().toString(16).slice(2)}`;
        await storage.session.set({ [PREVIEW_KEY]: { nonce, accounts: accounts.map(value => value.accountKey), expires: now() + 120000 } });
        return { ok: true, nonce, accounts, available: root.legacy.available === true,
          imported: Boolean(root.legacy.importedTo), recordCount: Object.keys(root.legacy.shelf?.entries || {}).length };
      });
    }
    async function importLegacy(message) {
      const result = serial.then(async () => {
        const root = await loadRoot();
        if (root.legacy.importedTo) return { ok: true, alreadyImported: true, accountLabel: labelFor(root.legacy.importedTo) };
        const preview = (await storage.session.get(PREVIEW_KEY))[PREVIEW_KEY];
        if (!preview || preview.nonce !== message.nonce || preview.expires < now()
          || !preview.accounts.includes(message.accountKey)) return fail('history_legacy_confirmation_invalid');
        const binding = Object.values(root.bindings).find(value => value?.scopeKey === message.accountKey && value.status === 'account');
        if (!binding) return fail('history_account_unavailable');
        const tab = await tabs.get(binding.tabId);
        if (!tab) return fail('history_account_unavailable');
        const probe = await tabs.sendMessage(binding.tabId, { type: 'STVAI_HISTORY_ACCOUNT_PROBE' }, { frameId: 0 });
        const proof = normalizeProof(probe?.accountProof);
        if (proof.status !== 'account' || await scopeFor(proof, sites.siteUrl(tab.url)?.origin) !== message.accountKey) {
          return fail('history_account_changed');
        }
        root.scopes[message.accountKey] ||= { shelf: emptyShelf() };
        root.scopes[message.accountKey].shelf = mergeShelf(root.scopes[message.accountKey].shelf, root.legacy.shelf);
        root.legacy.importedTo = message.accountKey; root.legacy.importedAt = now(); root.legacy.available = false;
        await saveRoot(root);
        return { ok: true, accountLabel: labelFor(message.accountKey),
          recordCount: Object.keys(root.legacy.shelf.entries || {}).length };
      }).catch(() => fail('history_storage_unavailable'));
      serial = result.then(() => undefined);
      return result;
    }
    async function forgetTab(tabId) {
      await Promise.allSettled([...services.values()].map(value => value.forgetTab(tabId)));
    }
    return Object.freeze({ handle, status, previewLegacy, importLegacy, forgetTab });
  }
  return Object.freeze({ STATE_KEY, LEGACY_KEY, SESSION_KEY, createHistorySync, safeShelf, mergeShelf });
});
