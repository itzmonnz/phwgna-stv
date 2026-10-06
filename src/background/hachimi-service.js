(function(root, factory) {
  const api = factory(root.STVAIHachimiText || (typeof require === 'function' ? require('../shared/hachimi-text.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIHachimiService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(text) {
  'use strict';
  const providerUrl = 'https://moxhi.vietphrase.app/#phwgna-hachimi40';
  const cacheKey = 'stvai-hachimi40-cache-v1';
  const journalKey = 'stvai-hachimi40-dispatch-v1';
  function createService({ tabs, read, write, enabled = async () => true, pollMs = 500, timeout = 270000 }) {
    let queue = Promise.resolve(), queued = 0, cache = null;
    const pending = new Map();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function providerTab() {
      const existing = (await tabs.query({ url: 'https://moxhi.vietphrase.app/*' })).filter(tab => tab.url === providerUrl);
      // Never take over a user's Mặc Hi tab or focus/minimize any window.
      const tab = existing[0] || await tabs.create({ url: providerUrl, active: false });
      if (!Number.isInteger(tab?.id)) throw Error('provider_unreachable');
      await tabs.update(tab.id, { autoDiscardable: false });
      return tab;
    }
    async function dispatch(source, key) {
      let journal = await read(journalKey);
      const tab = await providerTab();
      if (journal && (journal.key !== key || journal.source !== source || journal.tabId !== tab.id)) {
        // A previous worker may still be translating. Do not overlap or reuse its output.
        if (journal.tabId === tab.id) {
          const state = await tabs.sendMessage(tab.id, { type: 'STVAI_HACHIMI_STATUS', requestId: journal.requestId });
          if (!['completed', 'failed', 'missing'].includes(state?.state)) throw Error('provider_busy');
        }
        journal = null;
      }
      const requestId = journal?.requestId || `h40_${crypto.randomUUID().replace(/-/g, '')}`;
      let started = Boolean(journal);
      let reloaded = false;
      if (!journal) await write(journalKey, { key, source, tabId: tab.id, requestId });
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
          if (!result.ok) { await write(journalKey, null); throw Error(result.reason || 'model_error'); }
          if (result.requestId !== requestId || result.source !== source || result.model !== text.model || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 4000) throw Error('response_mismatch');
          if (!text.validOutput(result.text)) { await write(journalKey, null); throw Error('invalid_translation'); }
          await write(journalKey, null); return result.text;
        }
        if (state?.ok === false) { await write(journalKey, null); throw Error(state.reason || 'provider_unreachable'); }
        await sleep(pollMs);
      }
      throw Error('model_timeout');
    }
    async function run(source, kind, key) {
      if (!(await enabled())) return { ok: false, reason: 'disabled' };
      if (!cache) { const saved = await read(cacheKey); cache = saved?.version === 1 && saved.entries && typeof saved.entries === 'object' ? saved.entries : {}; }
      const hit = cache[key];
      if (hit?.source === source && hit.kind === kind && hit.model === text.model && text.validOutput(hit.text)) return { ok: true, ...hit, provider: text.model, cacheHit: true };
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
      const entry = { source, kind, model: text.model, text: output };
      cache[key] = entry;
      // Bound both entry count and total bytes; old MyMemory cache is never read.
      while (Object.keys(cache).length > 3000 || JSON.stringify(cache).length > 2000000) delete cache[Object.keys(cache)[0]];
      await write(cacheKey, { version: 1, entries: cache });
      return { ok: true, ...entry, provider: text.model, cacheHit: false };
    }
    function translate(input, kind = 'title') {
      const source = text.normalize(input, kind);
      if (!source) return Promise.resolve({ ok: false, reason: 'invalid_source' });
      const key = JSON.stringify([text.model, kind, source]);
      if (pending.has(key)) return pending.get(key);
      if (queued >= 100) return Promise.resolve({ ok: false, reason: 'queue_full' });
      queued++;
      const task = queue.then(() => run(source, kind, key)).catch(e => ({ ok: false, reason: ['disabled', 'provider_busy', 'model_timeout', 'model_error', 'provider_edited', 'model_unavailable', 'auto_translate_enabled', 'provider_ui_changed', 'response_receipt_missing', 'response_mismatch', 'invalid_translation'].includes(e.message) ? e.message : 'provider_unreachable' }))
        .finally(() => { queued--; pending.delete(key); });
      pending.set(key, task); queue = task.then(() => undefined); return task;
    }
    return { translate };
  }
  return { createService, providerUrl, cacheKey, journalKey };
});
