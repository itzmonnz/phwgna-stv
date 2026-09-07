(function attachPortableContent(root, factory) {
  const codec = root.STVAINativePortable || (typeof require === 'function' ? require('../shared/native-portable.js') : null);
  const sites = root.STVAISites || (typeof require === 'function' ? require('../shared/stv-sites.js') : null);
  const api = factory(codec, sites);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIPortableContent = api;
  const current = sites?.siteUrl?.(root.location?.href || '');
  if (root.document && root.chrome?.runtime?.sendMessage && root === root.top
    && current?.protocol === 'https:' && !root.STVAIPortableObserver) {
    root.STVAIPortableObserver = api.createObserver({ window: root });
    root.STVAIPortableObserver.start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPortableContent(codec, sites) {
  'use strict';

  function readSharedName(window) {
    if (sites?.siteUrl?.(window?.location?.href || '')?.protocol !== 'https:') {
      return { ok: false, code: 'stv_shared_name_insecure' };
    }
    const key = codec?.SHARED_NAME_KEY || 'qtOnline0';
    let raw;
    try { raw = window?.localStorage?.getItem(key); }
    catch (_) { return { ok: false, code: 'stv_shared_name_unavailable' }; }
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'stv_shared_name_missing' };
    const inspected = codec?.inspectCandidate?.(key, raw, 'nativeNames');
    if (!inspected?.ok || inspected.kind !== 'stv-name') {
      return { ok: false, code: inspected?.code || 'stv_shared_name_invalid' };
    }
    return { ok: true, key, raw };
  }

  function readNameForImport(window) {
    if (sites?.siteUrl?.(window?.location?.href || '')?.protocol !== 'https:') {
      return { ok: false, code: 'stv_shared_name_insecure' };
    }
    const key = codec?.SHARED_NAME_KEY || 'qtOnline0';
    let editorValue = '';
    try {
      const editor = window?.document?.getElementById?.('namewd');
      if (editor?.tagName === 'TEXTAREA' && typeof editor.value === 'string') editorValue = editor.value;
    } catch (_) { return { ok: false, code: 'stv_shared_name_unavailable' }; }
    if (!editorValue.trim()) return readSharedName(window);
    const inspected = codec?.inspectCandidate?.(key, editorValue, 'nativeNames');
    if (!inspected?.ok || inspected.kind !== 'stv-name') {
      return { ok: false, code: inspected?.code || 'stv_shared_name_invalid' };
    }
    return { ok: true, key, raw: editorValue };
  }

  function createObserver({ window, send = message => window.chrome.runtime.sendMessage(message) }) {
    let running = false, stopped = false, interval;
    let learning = null;
    const discovered = new Map();
    const secure = () => sites?.siteUrl?.(window.location.href)?.protocol === 'https:';
    const read = key => {
      try { return window.localStorage.getItem(key); } catch (_) { return null; }
    };
    function safeSnapshot() {
      const values = new Map();
      try {
        for (let index = 0; index < window.localStorage.length; index++) {
          const key = window.localStorage.key(index), raw = key == null ? null : read(key);
          if (raw != null && codec.inspectCandidate(key, raw).ok) values.set(key, raw);
        }
      } catch (_) { /* inaccessible storage produces an empty candidate list */ }
      return values;
    }
    function startLearning(sessionId) {
      if (!secure() || typeof sessionId !== 'string' || !sessionId) return { ok: false, code: 'portable_insecure_origin' };
      learning = { sessionId, before: safeSnapshot() };
      return { ok: true };
    }
    function finishLearning(sessionId) {
      if (!learning || learning.sessionId !== sessionId) return { ok: false, code: 'portable_learning_stale' };
      const after = safeSnapshot(), candidates = [], descriptors = [];
      for (const [key, raw] of after) {
        if (learning.before.get(key) === raw) continue;
        const descriptor = codec.inspectCandidate(key, raw);
        if (!descriptor.ok) continue;
        candidates.push({ key, raw });
        descriptors.push(descriptor);
      }
      learning = null;
      return { ok: true, candidates, descriptors };
    }
    function currentName() {
      const chapter = sites?.parseChapter?.(window.location.href);
      const parts = window.document?.getElementById('hiddenid')?.textContent?.split(';');
      if (!chapter || !parts || parts.length < 3
        || parts[0] !== chapter.bookId || parts[2] !== chapter.source) return null;
      const key = `${chapter.source}${chapter.bookId}`;
      return { key, raw: read(key) };
    }
    async function tick() {
      if (running || stopped || !secure() || window.document?.visibilityState === 'hidden') return;
      running = true;
      try {
        const nativeName = currentName();
        const sharedName = readSharedName(window);
        for (const candidate of [nativeName, sharedName.ok ? sharedName : null]) {
          if (candidate?.raw == null || discovered.get(candidate.key) === candidate.raw) continue;
          const response = await send({ type: 'STVAI_PORTABLE_SYNC', action: 'discover',
            key: candidate.key, raw: candidate.raw });
          if (response?.ok) discovered.set(candidate.key, candidate.raw);
        }
        const config = await send({ type: 'STVAI_PORTABLE_SYNC', action: 'config', activeKey: nativeName?.key || '' });
        if (!config?.ok || !Array.isArray(config.mappings) || !config.mappings.length) return;
        const values = {};
        for (const mapping of config.mappings) values[mapping.itemId] = { key: mapping.key, raw: read(mapping.key) };
        const response = await send({ type: 'STVAI_PORTABLE_SYNC', action: 'observe', values });
        if (!response?.ok || !Array.isArray(response.writes)) return;
        for (const write of response.writes) {
          const before = values[write.itemId]?.raw;
          const settle = action => send({ type: 'STVAI_PORTABLE_SYNC', action, itemId: write.itemId,
            token: write.token, raw: write.raw });
          if (read(write.key) !== before) { await settle('aborted'); continue; }
          try {
            if (write.raw === null) window.localStorage.removeItem(write.key);
            else window.localStorage.setItem(write.key, write.raw);
          } catch (_) { await settle('aborted'); continue; }
          await settle('applied');
        }
      } catch (_) { /* retry on the next storage event/tick */ }
      finally { running = false; }
    }
    function onStorage() { void tick(); }
    function onMessage(message, sender, reply) {
      if (sender.id !== window.chrome?.runtime?.id || sender.tab) return false;
      if (message?.type === 'STVAI_PORTABLE_LEARN_START') reply(startLearning(message.sessionId));
      else if (message?.type === 'STVAI_PORTABLE_LEARN_FINISH') reply(finishLearning(message.sessionId));
      else return false;
      return false;
    }
    function start() {
      if (interval || stopped || !secure()) return;
      window.addEventListener('storage', onStorage);
      window.document?.addEventListener('visibilitychange', onStorage);
      window.chrome?.runtime?.onMessage?.addListener(onMessage);
      interval = window.setInterval(tick, 1000);
      void tick();
    }
    function stop() {
      stopped = true; window.clearInterval(interval);
      window.removeEventListener('storage', onStorage);
      window.document?.removeEventListener('visibilitychange', onStorage);
      window.chrome?.runtime?.onMessage?.removeListener(onMessage);
    }
    return Object.freeze({ start, stop, tick, startLearning, finishLearning });
  }
  return Object.freeze({ readSharedName, readNameForImport, createObserver });
});
