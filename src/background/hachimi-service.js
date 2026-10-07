(function(root, factory) {
  const api = factory(root.STVAIHachimiText || (typeof require === 'function' ? require('../shared/hachimi-text.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIHachimiService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(text) {
  'use strict';
  const providerUrl = 'https://moxhi.vietphrase.app/#phwgna-hachimi40';
  const cacheKey = 'stvai-hachimi40-cache-v1';
  const journalKey = 'stvai-hachimi40-dispatch-v2';
  const legacyJournalKey = 'stvai-hachimi40-dispatch-v1';
  const DEFAULT_POLL_MS = 250;
  const GROUP_MAX_ITEMS = 12;
  const GROUP_MAX_INPUT = 1200;
  function createService({ tabs, read, write, enabled = async () => true, pollMs = DEFAULT_POLL_MS, timeout = 270000, poolSize = 2 }) {
    const maxSlots = Math.max(1, Math.min(2, Math.trunc(Number(poolSize) || 2)));
    let queued = 0, cache = null, cacheLoading = null, tabsLoading = null, draining = false, active = 0, fairness = 0;
    const waiting = [];
    const pending = new Map();
    const slotLocks = new Set();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function providerTabs() {
      if (tabsLoading) return tabsLoading;
      tabsLoading = (async () => {
      const existing = (await tabs.query({ url: 'https://moxhi.vietphrase.app/*' }))
        .filter(tab => tab.url === providerUrl && Number.isInteger(tab.id));
      const result = [];
      const add = tab => { if (tab?.id && !result.some(candidate => candidate.id === tab.id)) result.push(tab); };
      existing.forEach(add);
      for (let attempts = 0; typeof tabs.create === 'function' && result.length < maxSlots && attempts < maxSlots * 2; attempts++) {
        const before = result.length;
        add(await tabs.create({ url: providerUrl, active: false }));
        if (result.length === before) break;
      }
      if (!result.length) throw Error('provider_unreachable');
      for (const tab of result) await tabs.update(tab.id, { autoDiscardable: false });
      return result.slice(0, maxSlots);
      })().finally(() => { tabsLoading = null; });
      return tabsLoading;
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
    async function dispatch(source, key) {
      const journals = await readJournals();
      const tabsList = await providerTabs();
      const journal = journals.find(item => item.key === key && item.source === source);
      const used = new Set([...journals.map(item => item.slotId), ...slotLocks]);
      const slotIndex = journal ? journal.slotId : tabsList.findIndex((_, index) => !used.has(index));
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
      let started = Boolean(journal);
      let reloaded = false;
      if (!journal) { journal = { slotId: slotIndex, key, source, tabId: tab.id, requestId }; await writeJournals([...journals, journal]); }
      const clearJournal = async () => writeJournals((await readJournals()).filter(item => item.slotId !== slotIndex || item.requestId !== requestId));
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
            if (current.url !== providerUrl) throw Error('provider_unreachable');
            if (current.status !== 'loading') { reloaded = true; await tabs.reload(tab.id); }
          }
          await sleep(pollMs); continue;
        }
        if (state?.state === 'missing' && !started) {
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
        const part = kind === 'title' ? text.prepare(parts[i].source, 'title') : { input: parts[i].source, prefix: '' };
        results.push(text.finish(await dispatch(part.input, `${key}:${i}`), part));
      }
      const output = text.finish(results.map((result, i) => result + (i + 1 < results.length && !parts[i].separator && !parts[i + 1].separator ? ' ' : '')).join(''), { prefix: prepared.prefix });
      if (!output.trim()) return { ok: false, reason: 'empty_translation' };
      return save(source, kind, key, output);
    }
    function groupInput(item) {
      if (!['title', 'author', 'chapter', 'description'].includes(item.kind)) return null;
      const prepared = text.prepare(item.source, item.kind);
      const parts = text.segments(prepared.input, 240);
      return parts.length === 1 && parts[0].source && !/[\r\n]/.test(prepared.input) ? prepared : null;
    }
    function failure(e) {
      return { ok: false, reason: ['disabled', 'provider_busy', 'model_timeout', 'model_error', 'provider_edited', 'model_unavailable', 'auto_translate_enabled', 'provider_ui_changed', 'response_receipt_missing', 'response_mismatch', 'invalid_translation'].includes(e.message) ? e.message : 'provider_unreachable' };
    }
    function takeNext() {
      if (!waiting.length) return null;
      const preferred = fairness < 4
        ? waiting.findIndex(item => item.priority < 2)
        : waiting.findIndex(item => item.priority >= 2);
      const index = preferred >= 0 ? preferred : 0;
      const item = waiting.splice(index, 1)[0];
      fairness = item.priority >= 2 ? 0 : fairness + 1;
      return item;
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
      if (pending.has(key)) return pending.get(key);
      if (queued >= 100) return Promise.resolve({ ok: false, reason: 'queue_full' });
      queued++;
      const task = (async () => {
        await loadCache();
        if (!(await enabled())) return { ok: false, reason: 'disabled' };
        const hit = cached(source, kind, key);
        if (hit) return hit;
        return new Promise(resolve => {
          waiting.push({ source, kind, key, priority: Math.max(0, Math.min(2, Number(options.priority) || 0)), resolve });
          scheduleDrain();
        });
      })().catch(failure)
        .finally(() => { queued--; pending.delete(key); });
      pending.set(key, task); return task;
    }
    return { translate, poolSize: maxSlots };
  }
  return { createService, providerUrl, cacheKey, journalKey };
});
