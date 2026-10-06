(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STVAIFanqieTitleApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const storageKey = 'stvai-fanqie-mymemory-v1';
  const budget = 4500; // Conservative local budget, not a promise of provider quota.
  const day = 86400000;
  function validSource(source) {
    return typeof source === 'string' && source.length <= 160 && source.trim()
      && /[\u3400-\u9fff]/.test(source) && !/[\ue000-\uf8ff\r\n\x00-\x1f<>]/.test(source)
      && new TextEncoder().encode(source).length <= 500;
  }
  function validText(text) {
    return typeof text === 'string' && text.trim() && text.length <= 800
      && !/[<>\x00-\x1f\u3400-\u9fff\ue000-\uf8ff]/.test(text)
      && !/MYMEMORY WARNING|QUOTA|QUERY LENGTH|INVALID LANGUAGE/i.test(text);
  }
  function createService({ read, write, request: fetcher = globalThis.fetch, now = Date.now, enabled = async () => true }) {
    let queue = Promise.resolve();
    const inflight = new Map();
    async function run(source) {
      if (!await enabled()) return { ok: false, reason: 'disabled' };
      const raw = await read(storageKey);
      const state = raw?.version === 1 ? raw : {};
      const entries = (Array.isArray(state.entries) ? state.entries : [])
        .filter(e => e?.provider === 'mymemory' && validSource(e.source) && validText(e.text)).slice(-2000);
      const hit = entries.find(e => e.source === source);
      if (hit) return { ok: true, source, text: hit.text, provider: 'mymemory', cacheHit: true };
      const stamp = now();
      let windowStart = Number(state.windowStart) || stamp;
      let used = Math.max(0, Number(state.used) || 0);
      if (stamp - windowStart >= day) { windowStart = stamp; used = 0; }
      if (Number(state.blockedUntil) > stamp) return { ok: false, reason: 'api_backoff' };
      if (used + Array.from(source).length > budget) return { ok: false, reason: 'daily_limit' };
      const record = { version: 1, windowStart, used: used + Array.from(source).length, entries, blockedUntil: 0 };
      // Reserve before HTTP: worker restart never resets the consumed budget.
      await write(storageKey, record);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const url = new URL('https://api.mymemory.translated.net/get');
        url.searchParams.set('q', source); url.searchParams.set('langpair', 'zh-CN|vi');
        const response = await fetcher(url.href, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 429 ? 'quota_exceeded' : 'api_unavailable');
        const data = await response.json();
        if (data.quotaFinished || Number(data.responseStatus) === 429) throw new Error('quota_exceeded');
        if (Number(data.responseStatus) !== 200 || !validText(data.responseData?.translatedText)) throw new Error('invalid_translation');
        const text = data.responseData.translatedText.trim();
        record.entries.push({ provider: 'mymemory', source, text });
        record.entries = record.entries.slice(-2000);
        await write(storageKey, record);
        return { ok: true, source, text, provider: 'mymemory', cacheHit: false };
      } catch (error) {
        const reason = ['quota_exceeded', 'invalid_translation', 'api_unavailable'].includes(error.message)
          ? error.message : 'api_unavailable';
        record.blockedUntil = stamp + (reason === 'quota_exceeded' ? day : 60000);
        await write(storageKey, record);
        return { ok: false, reason };
      } finally { clearTimeout(timeout); }
    }
    function translate(source) {
      if (!validSource(source)) return Promise.resolve({ ok: false, reason: 'invalid_title' });
      source = source.normalize('NFC').trim();
      if (inflight.has(source)) return inflight.get(source);
      if (inflight.size >= 64) return Promise.resolve({ ok: false, reason: 'api_backoff' });
      const request = queue.then(() => run(source)).catch(() => ({ ok: false, reason: 'storage_unavailable' }));
      queue = request.then(() => {});
      inflight.set(source, request);
      request.finally(() => inflight.delete(source));
      return request;
    }
    return { translate };
  }
  return { createService, validSource, storageKey, budget };
});
