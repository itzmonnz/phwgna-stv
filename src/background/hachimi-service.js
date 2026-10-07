(function(root, factory) {
  const api = factory(root.STVAIHachimiText || (typeof require === 'function' ? require('../shared/hachimi-text.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIHachimiService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(text) {
  'use strict';
  const providerUrl = 'https://moxhi.vietphrase.app/#phwgna-hachimi40';
  const cacheKey = 'stvai-hachimi40-cache-v1';
  const journalKey = 'stvai-hachimi40-dispatch-v2';
  const poolKey = 'stvai-hachimi40-pool-v1';
  const legacyJournalKey = 'stvai-hachimi40-dispatch-v1';
  const DEFAULT_POLL_MS = 250;
  const GROUP_MAX_ITEMS = 12;
  const GROUP_MAX_INPUT = 1200;
  function createService({ tabs, read, write, enabled = async () => true, pollMs = DEFAULT_POLL_MS, timeout = 270000, poolSize = 2 }) {
    const maxSlots = Math.max(1, Math.min(2, Math.trunc(Number(poolSize) || 2)));
    let queued = 0, cache = null, cacheLoading = null, tabsLoading = null, pool = null, draining = false, active = 0;
    const waiting = [];
    const pending = new Map();
    const priorities = new Map();
    const slotLocks = new Set();
    let journalUpdates = Promise.resolve();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function providerTabs(requestedSlots = maxSlots) {
      if (tabsLoading) return tabsLoading;
      tabsLoading = (async () => {
      // URL queries can omit a freshly created/loading tab. Ownership must
      // survive those gaps and worker restarts, rather than creating a new pool.
      if (!pool) {
        const saved = await read(poolKey);
        pool = Array.from({ length: maxSlots }, (_, slotId) => {
          const entry = saved?.version === 1 && saved.slots?.[slotId];
          return entry && (Number.isInteger(entry.tabId) || entry.creating === true) ? { ...entry } : null;
        });
      }
      const persist = () => write(poolKey, { version: 1, slots: pool });
      const open = await tabs.query({});
      const owned = open.filter(tab => (tab.url === providerUrl || tab.pendingUrl === providerUrl) && Number.isInteger(tab.id));
      let journals = await readJournals();
      // A closed physical tab cannot retain a receipt. Release only identities
      // whose absence Chrome explicitly confirms; query gaps alone prove nothing.
      const closedIds = new Set();
      for (const item of journals) {
        if (open.some(tab => tab.id === item.tabId) || !tabs.get) continue;
        try { await tabs.get(item.tabId); }
        catch (e) { if (/No tab with id|Invalid tab ID/i.test(e.message || '')) closedIds.add(item.tabId); }
      }
      if (closedIds.size) {
        await updateJournals(current => current.filter(item => !closedIds.has(item.tabId)));
        journals = journals.filter(item => !closedIds.has(item.tabId));
      }
      const targetSlots = Math.max(1, Math.min(maxSlots, Math.trunc(Number(requestedSlots) || maxSlots)));
      const result = Array(maxSlots);
      const claimed = new Set(pool.filter(Boolean).map(entry => entry.tabId).filter(Number.isInteger));
      for (let slotId = 0; slotId < targetSlots; slotId++) {
        const entry = pool[slotId];
        if (Number.isInteger(entry?.tabId)) {
          let tab = open.find(candidate => candidate.id === entry.tabId);
          if (!tab && tabs.get) {
            try { tab = await tabs.get(entry.tabId); }
            catch (e) {
              // Only affirmative evidence of closure permits replacement.
              if (/No tab with id|Invalid tab ID/i.test(e.message || '')) {
                claimed.delete(entry.tabId); pool[slotId] = null; await persist();
                continue;
              }
            }
          }
          if (!tab || tab.url === providerUrl || tab.pendingUrl === providerUrl || !tab.url || (tab.url === 'about:blank' && tab.status === 'loading')) {
            result[slotId] = tab || { id: entry.tabId, url: providerUrl, status: 'loading' };
          }
        }
      }
      for (let slotId = 0; slotId < targetSlots; slotId++) {
        if (result[slotId] || Number.isInteger(pool[slotId]?.tabId)) continue;
        const journal = journals.find(item => item.slotId === slotId);
        const candidate = owned.find(tab => !claimed.has(tab.id) && (!journal || journal.tabId === tab.id));
        if (candidate) {
          result[slotId] = candidate; claimed.add(candidate.id);
          pool[slotId] = { tabId: candidate.id }; await persist();
        } else if (journal) {
          // An unresolved receipt stays tied to its original physical tab.
          result[slotId] = { id: journal.tabId, url: providerUrl };
          claimed.add(journal.tabId); pool[slotId] = { tabId: journal.tabId }; await persist();
        } else if (!pool[slotId]?.creating && typeof tabs.create === 'function') {
          // Persist the reservation BEFORE create. An ambiguous create error
          // or worker restart must not open another tab on the next retry.
          pool[slotId] = { creating: true }; await persist();
          const created = await tabs.create({ url: providerUrl, active: false });
          if (!Number.isInteger(created?.id) || claimed.has(created.id)) throw Error('provider_creation_uncertain');
          result[slotId] = created; claimed.add(created.id);
          pool[slotId] = { tabId: created.id }; await persist();
        }
      }
      if (!result.some(Boolean)) throw Error(pool.some(entry => entry?.creating) ? 'provider_creation_uncertain' : 'provider_unreachable');
      for (const tab of result.filter(Boolean)) await tabs.update(tab.id, { autoDiscardable: false });
      return result;
      })().finally(() => { tabsLoading = null; });
      return tabsLoading;
    }
    async function warm() {
      if (!(await enabled())) return { ok: false, reason: 'disabled' };
      const tabsList = await providerTabs(1);
      const tab = tabsList[0];
      if (!tab?.id) throw Error('provider_unreachable');
      // The page performs the WebGPU model initialization itself. Opening the
      // owned tab here moves that work ahead of the first translation without
      // creating a fake request or keeping the service worker alive while the
      // page loads. Normal dispatch still waits for the real ready signal.
      return { ok: true, tabId: tab.id };
    }
    function normalizeJournals(value) {
      if (value?.version === 2 && Array.isArray(value.slots)) return value.slots.filter(Boolean);
      if (value?.requestId && Number.isInteger(value.tabId)) return [{ slotId: 0, ...value }];
      return [];
    }
    async function readJournals() {
      const current = await read(journalKey);
      if (current) return normalizeJournals(current);
      return normalizeJournals(await read(legacyJournalKey));
    }
    async function writeJournals(slots) { await write(journalKey, { version: 2, slots }); }
    function updateJournals(change) {
      const task = journalUpdates.then(async () => writeJournals(change(await readJournals())));
      journalUpdates = task.catch(() => {});
      return task;
    }
    async function dispatch(source, key) {
      // Dispatch keeps the established pool behavior: once real work starts,
      // restore all configured slots so concurrent requests can run in parallel.
      // The separate warm() path intentionally starts only slot 0 in advance.
      const tabsList = await providerTabs();
      const journals = await readJournals();
      const journal = journals.find(item => item.key === key && item.source === source);
      const used = new Set([...journals.map(item => item.slotId), ...slotLocks]);
      const slotIndex = journal ? journal.slotId : tabsList.findIndex((tab, index) => tab && !used.has(index));
      if (slotIndex < 0 || !tabsList[slotIndex] || slotLocks.has(slotIndex)) throw Error('provider_busy');
      slotLocks.add(slotIndex);
      try {
        return await dispatchOnSlot(source, key, slotIndex, tabsList[slotIndex], journal, journals);
      } finally { slotLocks.delete(slotIndex); }
    }
    async function dispatchOnSlot(source, key, slotIndex, tab, existingJournal, journals) {
      let journal = existingJournal;
      if (journal && journal.tabId !== tab.id) throw Error('provider_busy');
      const requestId = journal?.requestId || `h40_${crypto.randomUUID().replace(/-/g, '')}`;
      // Old journals have an uncertain dispatch state and must stay conservative.
      let started = Boolean(journal && journal.dispatchStarted !== false);
      let reloaded = false;
      if (!journal) { journal = { slotId: slotIndex, key, source, tabId: tab.id, requestId, dispatchStarted: false }; await updateJournals(current => [...current, journal]); }
      const clearJournal = () => updateJournals(current => current.filter(item => item.slotId !== slotIndex || item.requestId !== requestId));
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (!(await enabled())) throw Error('disabled');
        let state;
        try { state = await tabs.sendMessage(tab.id, { type: 'STVAI_HACHIMI_STATUS', requestId }); }
        catch (e) {
          // An extension update invalidates old content scripts. Reload only our
          // existing physical tab, before dispatch, when no request was in flight.
          if (!started && !reloaded && tabs.reload && /Receiving end does not exist|Extension context invalidated|Could not establish connection/i.test(e.message || '')) {
            const current = tabs.get ? await tabs.get(tab.id) : tab;
            if (current.status === 'loading' && (current.pendingUrl === providerUrl || current.url === providerUrl || !current.url)) {
              await sleep(pollMs); continue;
            }
            if (current.url !== providerUrl) throw Error('provider_unreachable');
            if (current.status !== 'loading') { reloaded = true; await tabs.reload(tab.id); }
          }
          await sleep(pollMs); continue;
        }
        if (state?.state === 'missing' && !started) {
          journal = { ...journal, dispatchStarted: true };
          await updateJournals(current => current.map(item => item.slotId === slotIndex && item.requestId === requestId ? journal : item));
          started = true; // Persisted receipt on the provider makes a lost ACK safe.
          try { state = await tabs.sendMessage(tab.id, { type: 'STVAI_HACHIMI_TRANSLATE', requestId, source, model: text.model }); }
          catch (_) { continue; }
        } else if (state?.state === 'missing' && started) {
          throw Error('response_receipt_missing');
        }
        if (state?.result) {
          const result = state.result;
          if (!result.ok) { await clearJournal(); throw Error(result.reason || 'model_error'); }
          if (result.requestId !== requestId || result.source !== source || result.model !== text.model || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 10000) throw Error('response_mismatch');
          if (!text.validOutput(result.text)) { await clearJournal(); throw Error('invalid_translation'); }
          await clearJournal(); return result.text;
        }
        if (state?.ok === false) { await clearJournal(); throw Error(state.reason || 'provider_unreachable'); }
        await sleep(pollMs);
      }
      throw Error('model_timeout');
    }
    async function loadCache() {
      if (!cacheLoading) cacheLoading = (async () => { const saved = await read(cacheKey); cache = saved?.version === 1 && saved.entries && typeof saved.entries === 'object' ? saved.entries : {}; })();
      await cacheLoading;
    }
    function cached(source, kind, key) {
      const hit = cache[key];
      return hit?.source === source && hit.kind === kind && hit.model === text.model && text.validOutput(hit.text)
        ? { ok: true, ...hit, text: kind === 'title' ? text.finish(hit.text, { prefix: '', wrapped: true }) : hit.text, provider: text.model, cacheHit: true } : null;
    }
    async function save(source, kind, key, output) {
      const entry = { source, kind, model: text.model, text: output };
      cache[key] = entry;
      while (Object.keys(cache).length > 10000 || JSON.stringify(cache).length > 2000000) delete cache[Object.keys(cache)[0]];
      await write(cacheKey, { version: 1, entries: cache });
      return { ok: true, ...entry, provider: text.model, cacheHit: false };
    }
    async function run(source, kind, key) {
      if (!(await enabled())) return { ok: false, reason: 'disabled' };
      const hit = cached(source, kind, key);
      if (hit) return hit;
      const prepared = text.prepare(source, kind);
      const parts = text.segments(kind === 'title' ? source : prepared.input, ['title', 'author', 'chapter'].includes(kind) ? 240 : 160);
      const results = [];
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].separator || !/[\u3400-\u9fff]/u.test(parts[i].source)) { results.push(parts[i].separator ?? parts[i].source); continue; }
        // Yield between model dispatches; never cancel an in-flight receipt.
        while (waiting.some(item => Math.floor(item.priority / 10) < Math.floor(priorities.get(key) / 10))) {
          await processGroup([takeNext()]);
        }
        const part = kind === 'title' ? text.prepare(parts[i].source, 'title') : { input: parts[i].source, prefix: '' };
        results.push(text.finish(await dispatch(part.input, `${key}:${i}`), part));
      }
      const output = text.finish(results.map((result, i) => result + (i + 1 < results.length && !parts[i].separator && !parts[i + 1].separator ? ' ' : '')).join(''), { prefix: prepared.prefix });
      if (!output.trim()) return { ok: false, reason: 'empty_translation' };
      return save(source, kind, key, output);
    }
    function groupInput(item) {
      if (!['title', 'author', 'chapter', 'description', 'comment', 'ui', 'category'].includes(item.kind)) return null;
      const prepared = text.prepare(item.source, item.kind);
      const parts = text.segments(prepared.input, 240);
      return parts.length === 1 && parts[0].source && !/[\r\n]/.test(prepared.input) ? prepared : null;
    }
    function failure(e) {
      return { ok: false, reason: ['disabled', 'provider_busy', 'provider_creation_uncertain', 'model_timeout', 'model_error', 'provider_edited', 'model_unavailable', 'auto_translate_enabled', 'provider_ui_changed', 'response_receipt_missing', 'response_mismatch', 'invalid_translation'].includes(e.message) ? e.message : 'provider_unreachable' };
    }
    function takeNext() {
      if (!waiting.length) return null;
      let index = 0;
      for (let i = 1; i < waiting.length; i++) if (waiting[i].priority < waiting[index].priority) index = i;
      return waiting.splice(index, 1)[0];
    }
    async function processGroup(group) {
      try {
        if (!(await enabled())) throw Error('disabled');
        if (group.length > 1) {
          const input = group.map((item, i) => `${i + 1}. ${groupInput(item).input}`).join('\n');
          const output = await dispatch(input, JSON.stringify(group.map(item => item.key)));
          const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          const matches = lines.map(line => /^(\d+)\.\s*(.+)$/.exec(line));
          if (lines.length === group.length && matches.every((match, i) => match && Number(match[1]) === i + 1 && text.validOutput(match[2]))) {
            for (let i = 0; i < group.length; i++) {
              const item = group[i];
              item.resolve(await save(item.source, item.kind, item.key, text.finish(matches[i][2], groupInput(item))));
            }
            return;
          }
        }
        for (const item of group) {
          try { item.resolve(await run(item.source, item.kind, item.key)); }
          catch (e) { item.resolve(failure(e)); }
        }
      } catch (e) { for (const item of group) item.resolve(failure(e)); }
    }
    async function drain() {
      try {
        while (waiting.length && active < maxSlots) {
          const first = takeNext(), group = [first];
          let size = groupInput(first)?.input.length || GROUP_MAX_INPUT;
          if (groupInput(first)) for (let i = 0; i < waiting.length && group.length < GROUP_MAX_ITEMS;) {
            const item = waiting[i], prepared = groupInput(item);
            if (item.kind === first.kind && item.priority === first.priority && prepared && size + prepared.input.length + 5 <= GROUP_MAX_INPUT) {
              waiting.splice(i, 1); group.push(item); size += prepared.input.length + 5;
            } else i++;
          }
          active++;
          void processGroup(group).finally(() => { active--; scheduleDrain(); });
        }
      } finally { draining = false; }
    }
    function scheduleDrain() {
      if (!draining && waiting.length && active < maxSlots) {
        draining = true;
        setTimeout(() => { void drain(); }, 0);
      }
    }
    function translate(input, kind = 'title', options = {}) {
      const source = text.normalize(input, kind);
      if (!source) return Promise.resolve({ ok: false, reason: 'invalid_source' });
      const key = JSON.stringify([text.model, kind, source]);
      const priority = Number.isInteger(options.priority) && options.priority >= 0 && options.priority <= 26 ? options.priority : 20 + text.priority(kind);
      if (pending.has(key)) {
        priorities.set(key, Math.min(priorities.get(key), priority));
        const item = waiting.find(item => item.key === key);
        if (item) item.priority = priorities.get(key);
        return pending.get(key);
      }
      priorities.set(key, priority);
      let counted = false;
      const task = (async () => {
        await loadCache();
        if (!(await enabled())) return { ok: false, reason: 'disabled' };
        const hit = cached(source, kind, key);
        if (hit) return hit;
        // Reserve capacity for deliberate user actions, without evicting or
        // resending provider work already in flight. Cache hits never need a slot.
        if (queued >= (priorities.get(key) < 10 ? 124 : 100)) return { ok: false, reason: 'queue_full' };
        queued++;
        counted = true;
        return new Promise(resolve => {
          waiting.push({ source, kind, key, priority: priorities.get(key), resolve });
          scheduleDrain();
        });
      })().catch(failure)
        .finally(() => { if (counted) queued--; pending.delete(key); priorities.delete(key); });
      pending.set(key, task); return task;
    }
    return { translate, warm, poolSize: maxSlots };
  }
  return { createService, providerUrl, cacheKey, journalKey, poolKey };
});
