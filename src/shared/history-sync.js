(function (root, factory) {
  let retried = false;
  const loadNodeModule = typeof module === 'object' && module && typeof module.require === 'function'
    ? module.require.bind(module)
    : null;
  function attach() {
    if (root.STVAIHistorySync) return root.STVAIHistorySync;
    const codec = root.STVAINativeHistory
      || (loadNodeModule ? loadNodeModule('./native-history.js') : null);
    const sites = root.STVAISites
      || (loadNodeModule ? loadNodeModule('./stv-sites.js') : null);
    if (!codec || !sites) {
      if (!retried && typeof root.setTimeout === 'function') {
        retried = true;
        root.setTimeout(attach, 0);
      }
      return null;
    }
    const api = factory(codec, sites);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.STVAIHistorySync = api;
    return api;
  }
  attach();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (codec, sites) {
  'use strict';
  const STATE_KEY = 'stvai-native-history-v1';
  const SESSION_KEY = 'stvai-native-history-documents-v1';
  const INSECURE_RANKS = new Set(codec.PRIORITY
    .map((origin, rank) => ({ origin, rank }))
    .filter(({ origin }) => origin.startsWith('http://'))
    .map(({ rank }) => rank));
  const fail = code => ({ ok: false, code });
  const positions = raw => Object.fromEntries(codec.parse(raw).records.map(r => [codec.key(r), r.current]));

  function createHistorySync({ storage, tabs, now = Date.now, createId = () => crypto.randomUUID() }) {
    let serial = Promise.resolve();
    // Serialise all origins, not merely each tab. No dependency on translation jobs.
    function handle(message, sender) {
      const result = serial.then(() => exchange(message, sender)).catch(() => fail('history_storage_unavailable'));
      serial = result.then(() => undefined);
      return result;
    }
    async function exchange(message, sender) {
      const url = sites.siteUrl(sender?.url);
      if (!url || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0
        || typeof sender.documentId !== 'string' || sender.documentId.length > 128
        || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return fail('history_unauthorized');
      if (url.protocol !== 'https:') return fail('history_insecure_origin');
      if (!['begin', 'observe', 'poll', 'prepare', 'applied', 'aborted'].includes(message.action)) return fail('history_invalid_message');
      if (!['begin', 'poll'].includes(message.action) && message.raw !== null && typeof message.raw !== 'string') return fail('history_invalid_message');
      if (typeof message.documentToken !== 'string' || message.documentToken.length > 128) return fail('history_invalid_message');
      if (Object.hasOwn(message, 'raw') && !codec.parse(message.raw).ok) return fail(codec.parse(message.raw).code);
      // An ACK records a write already authorised for this document. The page
      // may have navigated or the user may have deleted the entry since the set.
      // Do not require its OLD snapshot to still equal live localStorage.
      if (['applied', 'aborted'].includes(message.action)) {
        const saved = (await storage.local.get(STATE_KEY))[STATE_KEY];
        const target = saved?.origins?.[url.origin], pending = target?.pending;
        if (!pending || pending.tabId !== sender.tab.id || pending.documentId !== sender.documentId
          || pending.documentToken !== message.documentToken || pending.ticket !== message.ticket
          || pending.token !== message.token || pending.after !== message.raw) return fail('history_stale_snapshot');
        if (message.action === 'applied') target.lastRaw = pending.after;
        delete target.pending;
        await storage.local.set({ [STATE_KEY]: saved });
        return { ok: true, revision: saved.revision };
      }
      const tab = await tabs.get(sender.tab.id);
      if (sites.siteUrl(tab?.url)?.href !== url.href) return fail('history_stale_document');
      // Probe the ACTIVE top frame, not the sender's potentially stale/BFCache
      // document. URL alone cannot distinguish two documents at the same URL.
      const probe = await tabs.sendMessage(sender.tab.id, { type: 'STVAI_HISTORY_DOCUMENT_PROBE' }, { frameId: 0 });
      if (probe?.documentToken !== message.documentToken || probe.url !== url.href) return fail('history_stale_document');
      if (typeof message.chapterId !== 'string' || message.chapterId.length > 100
        || probe.chapterId !== message.chapterId) return fail('history_stale_document');
      if (Object.hasOwn(message, 'raw') && probe.raw !== message.raw) return fail('history_stale_snapshot');
      const sessions = (await storage.session.get(SESSION_KEY))[SESSION_KEY] || { epoch: createId(), clock: 0, docs: {} };
      let doc = sessions.docs[sender.tab.id];
      if (message.action === 'begin') {
        if (message.url !== url.href || !Number.isSafeInteger(message.navigation) || message.navigation < 1) return fail('history_invalid_message');
        if (doc?.documentId === sender.documentId && message.navigation <= doc.navigation) {
          return message.navigation === doc.navigation && doc.url === url.href
            && doc.chapterId === message.chapterId ? { ok: true, ticket: doc.ticket } : fail('history_stale_document');
        }
        doc = { documentId: sender.documentId, navigation: message.navigation, url: url.href,
          chapterId: message.chapterId, ticket: createId(), order: ++sessions.clock, read: false };
        sessions.docs[sender.tab.id] = doc;
        await storage.session.set({ [SESSION_KEY]: sessions });
        return { ok: true, ticket: doc.ticket };
      }
      if (!doc || doc.documentId !== sender.documentId || doc.url !== url.href || doc.ticket !== message.ticket
        || doc.chapterId !== message.chapterId) return fail('history_stale_document');
      const state = (await storage.local.get(STATE_KEY))[STATE_KEY] || { schema: 1, revision: 0, entries: {}, origins: {} };
      if (state.schema !== 1 || !state.entries || !state.origins) return fail('history_invalid_data');
      const previous = JSON.stringify(state);
      const insecureKeys = new Set(Array.isArray(state.insecureKeys)
        ? state.insecureKeys.filter(key => typeof key === 'string').slice(0, codec.MAX_RECORDS)
        : []);
      let removedInsecureHistory = false;
      for (const [key, value] of Object.entries(state.entries)) {
        if (!INSECURE_RANKS.has(value?.rank)) continue;
        delete state.entries[key];
        insecureKeys.add(key);
        removedInsecureHistory = true;
      }
      if (removedInsecureHistory) {
        state.insecureKeys = [...insecureKeys];
        state.revision++;
      }
      const origin = state.origins[url.origin] || { observed: false, lastRaw: null, suppressed: [] };
      state.origins[url.origin] = origin;
      const allowedRecords = () => Object.entries(state.entries)
        .filter(([key]) => !origin.suppressed.includes(key)).map(([, value]) => value.record);
      const needsCleanup = () => {
        const live = codec.parse(probe.raw);
        return live.ok && live.records.some(record => insecureKeys.has(codec.key(record)));
      };
      const response = () => ({ ok: true, revision: state.revision, records: allowedRecords(),
        needsCleanup: needsCleanup() });
      async function persist() {
        if (JSON.stringify(state) === previous) return;
        if (Object.keys(state.entries).length > codec.MAX_RECORDS || JSON.stringify(state).length > 8_000_000) throw new Error('size');
        await storage.local.set({ [STATE_KEY]: state });
      }
      if (message.action === 'poll') {
        await persist();
        return message.revision === state.revision && !needsCleanup()
          ? { ok: true, unchanged: true, revision: state.revision } : response();
      }
      const parsed = codec.parse(message.raw);
      if (!parsed.ok) return fail(parsed.code);
      if (message.action === 'prepare') {
        if (!origin.observed || origin.lastRaw !== message.raw || state.revision !== message.revision) return fail('history_stale_snapshot');
        if (origin.pending) return fail(origin.pending.expires > now() ? 'history_write_busy' : 'history_write_uncertain');
        const trustedRaw = codec.removeKeys(message.raw, insecureKeys);
        const merged = codec.mergeRaw(trustedRaw, allowedRecords());
        if (merged === (message.raw || '')) return { ok: true, unchanged: true, revision: state.revision };
        if (!Object.hasOwn(origin, 'backup')) origin.backup = message.raw;
        origin.pending = { token: createId(), ticket: doc.ticket, tabId: sender.tab.id,
          documentId: sender.documentId, documentToken: message.documentToken,
          before: message.raw, after: merged, expires: now() + 5000 };
        await persist(); // Backup and write intent durable BEFORE native localStorage is touched.
        return { ok: true, token: origin.pending.token, raw: merged, revision: state.revision };
      }
      const chapter = sites.parseChapter(url.href, { chapterId: probe.readChapterId });
      const reading = message.read === true && chapter
        ? parsed.records.find(r => String(r.host) === chapter.source && String(r.id) === chapter.bookId
          && codec.current(r.current).chapterId === chapter.chapterId && probe.readChapterId === chapter.chapterId) : null;
      if (message.read === true && !reading) return fail('history_read_mismatch');
      // A previous writer may have gone away before acknowledging its write.
      // Its durable intent still identifies the resulting snapshot as an echo.
      const echo = origin.pending?.after === message.raw;
      if (echo) { origin.lastRaw = message.raw; delete origin.pending; }
      if (origin.pending) return fail(origin.pending.expires > now() ? 'history_write_busy' : 'history_write_uncertain');
      const changed = !origin.observed || message.raw !== origin.lastRaw;
      if (changed) {
        const old = origin.observed ? positions(origin.lastRaw) : {};
        const fresh = positions(message.raw);
        for (const key of Object.keys(old)) {
          if (!Object.hasOwn(fresh, key) && !origin.suppressed.includes(key)) origin.suppressed.push(key);
        }
        const rank = codec.PRIORITY.indexOf(url.origin);
        for (const record of parsed.records) {
          const key = codec.key(record);
          if (insecureKeys.has(key) || codec.current(record.current).chapterId === '0') continue; // Native unread bookmark, not a reading position.
          if (origin.suppressed.includes(key) || (origin.observed && old[key] === record.current)) continue;
          const existing = state.entries[key];
          // Changed native data after a browser/extension session gap has unknown
          // age, so compare legacy priorities instead of inventing a timestamp.
          const protectedRead = existing?.kind === 'read' && (existing.epoch === sessions.epoch || !origin.observed);
          if (!existing || (!protectedRead && rank <= existing.rank)) {
            state.entries[key] = { record: codec.portable(record), kind: 'legacy', rank, order: 0, epoch: sessions.epoch };
          }
        }
        origin.lastRaw = message.raw;
        origin.observed = true;
        delete origin.pending;
        state.revision++;
      }
      if (reading && !doc.read) {
        const key = codec.key(reading);
        if (insecureKeys.delete(key)) {
          state.insecureKeys = [...insecureKeys];
          state.revision++;
        }
        const existing = state.entries[key];
        origin.suppressed = origin.suppressed.filter(value => value !== key);
        if (!existing || existing.kind !== 'read' || existing.epoch !== sessions.epoch || doc.order > existing.order) {
          state.entries[key] = { record: codec.portable(reading), kind: 'read', rank: codec.PRIORITY.indexOf(url.origin),
            epoch: sessions.epoch, order: doc.order };
          state.revision++;
        }
        // Persist data first; replay of the same order cannot change its winner.
        await persist();
        doc.read = true;
        await storage.session.set({ [SESSION_KEY]: sessions });
      } else await persist();
      return response();
    }
    async function forgetTab(tabId) {
      const result = serial.then(async () => {
        const value = (await storage.session.get(SESSION_KEY))[SESSION_KEY];
        if (value?.docs?.[tabId]) { delete value.docs[tabId]; await storage.session.set({ [SESSION_KEY]: value }); }
      }).catch(() => undefined);
      serial = result;
      return result;
    }
    return Object.freeze({ handle, forgetTab });
  }
  return Object.freeze({ createHistorySync, STATE_KEY, SESSION_KEY });
});
