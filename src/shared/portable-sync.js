(function attachPortableSync(root, factory) {
  const codec = root.STVAINativePortable || (typeof require === 'function' ? require('./native-portable.js') : null);
  const sites = root.STVAISites || (typeof require === 'function' ? require('./stv-sites.js') : null);
  const api = factory(codec, sites);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIPortableSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPortableSyncApi(codec, sites) {
  'use strict';
  const LEARNING_KEY = 'stvai-native-portable-learning-v1';
  const fail = code => ({ ok: false, code });

  function createPortableSync({ storage, tabs, now = Date.now, createId = () => crypto.randomUUID() }) {
    let serial = Promise.resolve();
    function handle(message, sender) {
      const result = serial.then(() => exchange(message, sender)).catch(() => fail('portable_storage_unavailable'));
      serial = result.then(() => undefined);
      return result;
    }

    async function readState() {
      const stored = (await storage.local.get(codec.STATE_KEY))[codec.STATE_KEY];
      return stored?.schema === 1 ? structuredClone(stored) : codec.emptyState();
    }

    async function clearLearning() {
      if (typeof storage.session.remove === 'function') await storage.session.remove(LEARNING_KEY);
      else await storage.session.set({ [LEARNING_KEY]: undefined });
    }

    async function startLearning() {
      const open = typeof tabs?.query === 'function' ? await tabs.query({}) : [];
      const eligible = (open || []).filter(tab => {
        const url = sites?.siteUrl?.(tab?.url);
        return Number.isInteger(tab?.id) && url?.protocol === 'https:';
      }).sort((left, right) => Number(right.active) - Number(left.active)
        || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
      if (!eligible.length) return fail('portable_no_stv_tab');
      const tab = eligible[0], sessionId = createId(), origin = sites.siteUrl(tab.url).origin;
      const response = await tabs.sendMessage(tab.id, { type: 'STVAI_PORTABLE_LEARN_START', sessionId });
      if (!response?.ok) return fail('portable_learning_unavailable');
      await storage.session.set({ [LEARNING_KEY]: { sessionId, tabId: tab.id, origin, startedAt: now(), candidates: null } });
      return { ok: true, sessionId, origin };
    }

    async function finishLearning(sessionId) {
      const session = (await storage.session.get(LEARNING_KEY))[LEARNING_KEY];
      if (!session || session.sessionId !== sessionId) return fail('portable_learning_stale');
      const response = await tabs.sendMessage(session.tabId, { type: 'STVAI_PORTABLE_LEARN_FINISH', sessionId });
      if (!response?.ok || !Array.isArray(response.candidates)) return fail('portable_learning_unavailable');
      const candidates = [];
      for (const candidate of response.candidates.slice(0, codec.MAX_KEYS)) {
        const inspected = codec.inspectCandidate(candidate?.key, candidate?.raw);
        if (!inspected.ok) continue;
        candidates.push({ key: candidate.key, raw: candidate.raw, descriptor: inspected });
      }
      await storage.session.set({ [LEARNING_KEY]: { ...session, candidates } });
      return { ok: true, sessionId, origin: session.origin,
        candidates: candidates.map(value => value.descriptor) };
    }

    async function approveLearning(message) {
      const session = (await storage.session.get(LEARNING_KEY))[LEARNING_KEY];
      if (!session || session.sessionId !== message?.sessionId || !Array.isArray(session.candidates)
        || !Array.isArray(message?.selections)) return fail('portable_learning_stale');
      let state = await readState();
      for (const selection of message.selections) {
        const candidate = session.candidates.find(value => value.key === selection?.key);
        if (!candidate) return fail('portable_unknown_candidate');
        const approved = codec.approveCandidate(state, {
          origin: session.origin, key: candidate.key, raw: candidate.raw,
          category: selection.category, itemId: selection.itemId
        });
        if (!approved.ok) return approved;
        state = approved.state;
      }
      await storage.local.set({ [codec.STATE_KEY]: state });
      await clearLearning();
      return { ok: true, items: codec.publicDescriptors(state) };
    }

    async function status() {
      const state = await readState();
      const learning = (await storage.session.get(LEARNING_KEY))[LEARNING_KEY];
      return { ok: true, items: codec.publicDescriptors(state), learning: Boolean(learning),
        sessionId: typeof learning?.sessionId === 'string' ? learning.sessionId : '' };
    }

    async function disable(itemId) {
      const state = await readState();
      if (!Object.hasOwn(state.items, itemId)) return fail('portable_unknown_mapping');
      delete state.items[itemId];
      for (const origin of Object.keys(state.mappings)) {
        delete state.mappings[origin][itemId];
        delete state.origins[origin]?.last?.[itemId];
        delete state.origins[origin]?.pending?.[itemId];
        delete state.origins[origin]?.candidates?.[itemId];
      }
      state.revision++;
      await storage.local.set({ [codec.STATE_KEY]: state });
      return { ok: true, items: codec.publicDescriptors(state) };
    }

    async function authorized(sender) {
      const url = sites?.siteUrl?.(sender?.url);
      if (!url || url.protocol !== 'https:' || !Number.isInteger(sender?.tab?.id)
        || sender.frameId !== 0 || typeof sender.documentId !== 'string') return null;
      if (tabs?.get) {
        const tab = await tabs.get(sender.tab.id);
        if (sites.siteUrl(tab?.url)?.href !== url.href) return null;
      }
      return url;
    }

    function validState(value) {
      return value?.schema === 1 && value.items && value.mappings && value.origins;
    }

    async function exchange(message, sender) {
      const url = await authorized(sender);
      if (!url) return fail(sites?.siteUrl?.(sender?.url)?.protocol === 'http:'
        ? 'portable_insecure_origin' : 'portable_unauthorized');
      if (!['config', 'discover', 'observe', 'applied', 'aborted'].includes(message?.action)) return fail('portable_invalid_message');
      const stored = (await storage.local.get(codec.STATE_KEY))[codec.STATE_KEY];
      const state = validState(stored) ? structuredClone(stored) : codec.emptyState();
      if (message.action === 'discover') {
        const chapter = sites.parseChapter(url.href);
        const key = `${chapter?.source || ''}${chapter?.bookId || ''}`;
        const discoveredKey = message.key === codec.SHARED_NAME_KEY ? codec.SHARED_NAME_KEY : key;
        if ((!chapter && discoveredKey !== codec.SHARED_NAME_KEY) || message.key !== discoveredKey
          || typeof message.raw !== 'string') return fail('portable_unknown_mapping');
        const inspected = codec.inspectCandidate(discoveredKey, message.raw, 'nativeNames');
        if (!inspected.ok || inspected.kind !== 'stv-name') return fail(inspected.code || 'portable_invalid_name');
        const itemId = `nativeNames:${discoveredKey}`;
        const existing = state.items[itemId];
        if (existing && (existing.category !== 'nativeNames'
          || existing.shapeFingerprint !== inspected.shapeFingerprint)) return fail('portable_shape_mismatch');
        if (!state.items[itemId]) {
          const approved = codec.approveCandidate(state, { origin: url.origin, key: discoveredKey,
            category: 'nativeNames', raw: message.raw });
          if (!approved.ok) return approved;
          Object.assign(state, approved.state);
        } else if (!state.mappings[url.origin]?.[itemId]) {
          state.mappings[url.origin] ||= {};
          state.mappings[url.origin][itemId] = discoveredKey;
          state.items[itemId].keysByOrigin[url.origin] = discoveredKey;
          state.origins[url.origin] ||= { initialized: false, last: {}, backups: {}, pending: {}, candidates: {} };
        }
        for (const origin of sites.ORIGINS.filter(value => value.startsWith('https://'))) {
          state.mappings[origin] ||= {};
          state.mappings[origin][itemId] = discoveredKey;
          state.items[itemId].keysByOrigin[origin] = discoveredKey;
          if (!state.origins[origin]) state.origins[origin] = {
            initialized: origin === url.origin, last: origin === url.origin ? { [itemId]: message.raw } : {},
            backups: {}, pending: {}, candidates: {}
          };
        }
        state.revision++;
        await storage.local.set({ [codec.STATE_KEY]: state });
        return { ok: true, itemId };
      }
      const mapping = state.mappings[url.origin] || {};
      if (message.action === 'config' && message.activeKey !== undefined && typeof message.activeKey !== 'string') {
        return fail('portable_invalid_message');
      }
      const chapter = sites.parseChapter(url.href);
      const expectedActiveKey = chapter ? `${chapter.source}${chapter.bookId}` : '';
      if (message.action === 'config' && message.activeKey && message.activeKey !== expectedActiveKey) {
        return fail('portable_unknown_mapping');
      }
      const mappings = Object.entries(mapping)
        .filter(([itemId, key]) => state.items[itemId]?.kind !== 'stv-name'
          || key === codec.SHARED_NAME_KEY || key === (message.activeKey || ''))
        .map(([itemId, key]) => ({ itemId, key }));
      if (message.action === 'config') return { ok: true, revision: state.revision, mappings };
      const origin = state.origins[url.origin] || { initialized: false, last: {}, backups: {}, pending: {}, candidates: {} };
      origin.last ||= {}; origin.backups ||= {}; origin.pending ||= {}; origin.candidates ||= {};
      state.origins[url.origin] = origin;

      if (['applied', 'aborted'].includes(message.action)) {
        const pending = origin.pending[message.itemId];
        if (!pending || pending.token !== message.token || pending.after !== message.raw) return fail('portable_stale_write');
        if (message.action === 'applied') origin.last[message.itemId] = pending.after;
        delete origin.candidates[message.itemId];
        delete origin.pending[message.itemId];
        await storage.local.set({ [codec.STATE_KEY]: state });
        return { ok: true, revision: state.revision };
      }

      if (!message.values || typeof message.values !== 'object' || Array.isArray(message.values)) return fail('portable_invalid_message');
      for (const itemId of Object.keys(message.values)) if (!Object.hasOwn(mapping, itemId)) return fail('portable_unknown_mapping');
      for (const { itemId, key } of mappings) {
        const value = message.values[itemId];
        if (!value || value.key !== key || (value.raw !== null && typeof value.raw !== 'string')) return fail('portable_invalid_message');
        if (value.raw !== null) {
          const inspected = codec.inspectCandidate(key, value.raw, state.items[itemId]?.category);
          if (!inspected.ok || inspected.shapeFingerprint !== state.items[itemId]?.shapeFingerprint) {
            return fail(inspected.code || 'portable_shape_mismatch');
          }
        }
      }

      let changed = false;
      const held = new Set();
      for (const { itemId } of mappings) {
        const current = message.values[itemId].raw;
        const pending = origin.pending[itemId];
        if (pending) {
          if (current === pending.after) {
            origin.last[itemId] = current;
            delete origin.pending[itemId];
            changed = true;
          } else if (current !== pending.before || pending.expires <= now()) return fail('portable_write_uncertain');
          continue;
        }
        if (!origin.initialized) continue;
        if (Object.hasOwn(origin.last, itemId) && origin.last[itemId] !== current) {
          const candidate = origin.candidates[itemId];
          if (!candidate || candidate.raw !== current) {
            origin.candidates[itemId] = { raw: current };
            held.add(itemId);
            changed = true;
            continue;
          }
          delete origin.candidates[itemId];
          const item = state.items[itemId];
          state.revision++;
          item.raw = current;
          item.deleted = current === null;
          item.revision = state.revision;
          origin.last[itemId] = current;
          changed = true;
        } else if (Object.hasOwn(origin.candidates, itemId)) { delete origin.candidates[itemId]; changed = true; }
      }
      if (!origin.initialized) {
        origin.initialized = true;
        for (const { itemId } of mappings) origin.last[itemId] = message.values[itemId].raw;
        changed = true;
      }

      const writes = [];
      for (const { itemId, key } of mappings) {
        const item = state.items[itemId];
        const current = message.values[itemId].raw;
        const desired = item?.deleted ? null : item?.raw;
        if (held.has(itemId)) continue;
        if (!item || current === desired) continue;
        if (!Object.hasOwn(origin.backups, itemId)) origin.backups[itemId] = current;
        const pending = origin.pending[itemId] || {
          token: createId(), before: current, after: desired, expires: now() + 5000
        };
        origin.pending[itemId] = pending;
        writes.push({ itemId, key, raw: desired, token: pending.token });
        changed = true;
      }
      if (changed) await storage.local.set({ [codec.STATE_KEY]: state });
      return { ok: true, revision: state.revision, writes };
    }
    return Object.freeze({ handle, startLearning, finishLearning, approveLearning, status, disable });
  }
  return Object.freeze({ createPortableSync, LEARNING_KEY });
});
