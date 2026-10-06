(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.location?.origin === 'https://moxhi.vietphrase.app' && root.location.hash === '#phwgna-hachimi40') api.install(root.document, root.chrome.runtime);
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function createProvider(document, { timeout = 240000, interval = 100 } = {}) {
    const receipts = new Map();
    let active = null;
    const q = name => document.querySelector(`[data-ref="${name}"]`);
    const sleep = ms => new Promise(resolve => document.defaultView.setTimeout(resolve, ms));
    const busy = () => Boolean(q('goBtn')?.disabled || q('cancelBtn') && !q('cancelBtn').hidden);
    const error = reason => ({ ok: false, reason });
    async function waitFor(test) {
      const end = Date.now() + timeout;
      while (!test()) { if (Date.now() > end) throw Error('model_timeout'); await sleep(interval); }
    }
    async function run(entry) {
      let observer;
      try {
        await waitFor(() => q('modelSelect') && q('goBtn') && q('src') && q('out'));
        if (busy()) throw Error('provider_busy');
        const select = q('modelSelect');
        if (![...select.options].some(option => option.value === 'hachimi40')) throw Error('model_unavailable');
        if (select.value !== 'hachimi40') {
          select.value = 'hachimi40'; select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
        }
        await waitFor(() => select.value === 'hachimi40' && q('loading')?.hidden && q('gate')?.hidden && !busy()
          && /Hachimi 40/.test(q('chipBadge')?.textContent || ''));
        q('settingsBtn')?.click();
        await waitFor(() => document.querySelector('#auto-toggle'));
        const auto = document.querySelector('#auto-toggle');
        if (auto.checked) auto.click();
        if (auto.checked) throw Error('auto_translate_enabled');
        q('panelCloseBtn')?.click();
        const input = q('src');
        const setter = Object.getOwnPropertyDescriptor(document.defaultView.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, entry.source);
        input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
        if (busy()) throw Error('provider_busy');
        let changed = false, started = false;
        observer = new document.defaultView.MutationObserver(() => { changed = true; });
        observer.observe(q('out'), { subtree: true, childList: true, characterData: true });
        entry.state = 'running';
        q('goBtn').click();
        await waitFor(() => {
          started ||= busy();
          if (!q('errBanner')?.hidden) throw Error('model_error');
          if (input.value !== entry.source || select.value !== 'hachimi40') throw Error('provider_edited');
          return (started || changed) && changed && !busy() && Boolean(q('out')?.textContent.trim());
        });
        entry.result = { ok: true, requestId: entry.requestId, source: entry.source, model: 'hachimi40', text: q('out').textContent.trim() };
        entry.state = 'completed';
      } catch (e) {
        entry.state = 'failed';
        entry.result = error(['model_timeout', 'provider_busy', 'model_unavailable', 'auto_translate_enabled', 'model_error', 'provider_edited'].includes(e.message) ? e.message : 'provider_ui_changed');
        // Never accept the old output on an error or automatically submit again.
      } finally { observer?.disconnect(); active = null; }
    }
    function handle(message) {
      const id = message?.requestId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return error('invalid_request');
      const old = receipts.get(id);
      if (message.type === 'STVAI_HACHIMI_STATUS') return old ? { ok: true, state: old.state, result: old.result } : { ok: true, state: 'missing' };
      if (message.type !== 'STVAI_HACHIMI_TRANSLATE') return error('invalid_request');
      if (typeof message.source !== 'string' || !message.source.trim() || message.source.length > 1240 || message.model !== 'hachimi40') return error('invalid_source');
      if (old) return old.source === message.source ? { ok: true, state: old.state, result: old.result } : error('request_mismatch');
      if (active || busy()) return error('provider_busy');
      const entry = { requestId: id, source: message.source, state: 'preparing' };
      receipts.set(id, entry); active = id;
      while (receipts.size > 512) receipts.delete(receipts.keys().next().value);
      void run(entry);
      return { ok: true, state: entry.state };
    }
    return { handle };
  }
  function install(document, runtime) {
    const provider = createProvider(document);
    runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== runtime.id || sender.tab || !['STVAI_HACHIMI_TRANSLATE', 'STVAI_HACHIMI_STATUS'].includes(message?.type)) return false;
      respond(provider.handle(message)); return false;
    });
    return provider;
  }
  return { createProvider, install };
});
