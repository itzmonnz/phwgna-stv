(function attachFanqieUI(root, factory) {
  const api = factory(root.STVAIFanqieDictionary || (typeof require === 'function'
    ? require('../shared/fanqie-ui-dictionary.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document && root.location.hostname === 'fanqienovel.com'
    && root.location.protocol === 'https:') api.start(root.document, api.createRuntimeStorage(root.chrome?.runtime));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dictionary) {
  'use strict';
  const storageKey = 'stvai-fanqie-ui-v1';
  const regions = [
    '.muye-header .nav-item', '.muye-mobile-nav .nav-item-text',
    '.slogin-user-avatar__buttons__item', '.home-link-item-left-text-title',
    '.muye-home-block-title', '.muye-bottom-choiceness-title', '.muye-bottom-rank-header',
    '.muye-bottom-block-title', '.update-list-header', '.float-wrapper-item',
    '.muye-stack-filter-panel', '.stack-order-tab', '.page-directory-header h3 span',
    '.info-btn', '.reader-toolbar'
  ].join(',');
  const excluded = 'script,style,textarea,[contenteditable],.muye-home-news-content-item,.muye-stack-book-list,.page-directory-content,.reader-content,[class*="comment"]';
  const translations = new Map(dictionary.entries.flatMap(entry => entry.source.endsWith('：')
    ? [[entry.source, entry.vietnamese], [entry.source.slice(0, -1), entry.vietnamese.replace(/:$/, '')]]
    : [[entry.source, entry.vietnamese]]));
  const allowedPath = path => /^\/$|^\/(library|rank)\/?$|^\/(page|reader)\/\d+\/?$/.test(path);

  function createRuntimeStorage(runtime) {
    return {
      async get() {
        const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_UI_GET' });
        if (!result?.ok) throw new Error('fanqie_storage_unavailable');
        return { [storageKey]: { language: result.language } };
      },
      async set(values) {
        const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_UI_SET', language: values[storageKey].language });
        if (!result?.ok) throw new Error('fanqie_storage_unavailable');
      }
    };
  }

  function createTranslator(document) {
    const originals = new Map();
    let enabled = true;
    function remember(node, source, translated, attribute) {
      originals.set(node, { source, translated, attribute });
    }
    function apply() {
      if (!enabled || !allowedPath(document.location.pathname)) return 0;
      for (const node of originals.keys()) if (!node.isConnected) originals.delete(node);
      let count = 0;
      for (const region of document.querySelectorAll(regions)) {
        if (region.closest(excluded)) continue;
        const walker = document.createTreeWalker(region, 4);
        let node;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest(excluded)) continue;
          const source = node.data.trim();
          const translated = translations.get(source);
          if (!translated) continue;
          const replacement = node.data.replace(source, translated);
          remember(node, node.data, replacement);
          node.data = replacement;
          count += 1;
        }
      }
      for (const input of document.querySelectorAll('.muye-header-search input[placeholder]')) {
        const source = input.getAttribute('placeholder');
        const translated = translations.get(source);
        if (!translated) continue;
        remember(input, source, translated, 'placeholder');
        input.setAttribute('placeholder', translated);
        count += 1;
      }
      return count;
    }
    function restore() {
      for (const [node, entry] of originals) {
        // React/site updates own the latest value: never restore stale text.
        const current = entry.attribute ? node.getAttribute(entry.attribute) : node.data;
        if (node.isConnected && current === entry.translated) {
          if (entry.attribute) node.setAttribute(entry.attribute, entry.source);
          else node.data = entry.source;
        }
      }
      originals.clear();
    }
    return { apply, restore, setEnabled(value) { enabled = value === true; if (!enabled) restore(); else apply(); } };
  }

  async function start(document, storage) {
    if (!allowedPath(document.location.pathname) || document.getElementById('stvai-fanqie-ui')) return null;
    const translator = createTranslator(document);
    let language = 'vi';
    try {
      const values = await storage?.get(storageKey);
      if (values?.[storageKey]?.language === 'zh') language = 'zh';
    } catch (_) { /* Bundled dictionary remains usable without storage. */ }
    const host = document.createElement('div');
    host.id = 'stvai-fanqie-ui';
    host.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:1000';
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = 'font:14px sans-serif;max-width:180px;padding:9px 12px;border:1px solid #999;border-radius:8px;background:#fff;color:#222;cursor:pointer';
    const updateButton = () => {
      button.textContent = language === 'vi' ? 'Tiếng Việt · 中文' : '中文 · Tiếng Việt';
      button.title = 'Phwgna: chỉ dịch nhãn giao diện cố định; không dịch truyện hoặc bình luận';
    };
    const persist = async () => {
      host.dataset.storageState = 'saving';
      try {
        await storage?.set({ [storageKey]: {
          version: dictionary.version, language, entries: dictionary.entries
        } });
        host.dataset.storageState = 'saved';
      } catch (_) {
        host.dataset.storageState = 'failed';
        button.title = 'Chưa lưu được ngôn ngữ và bộ nhãn; lựa chọn có thể mất khi tải lại trang.';
      }
    };
    button.addEventListener('click', () => {
      language = language === 'vi' ? 'zh' : 'vi';
      translator.setEnabled(language === 'vi'); updateButton(); void persist();
    });
    shadow.append(button); document.body.append(host);
    translator.setEnabled(language === 'vi'); updateButton(); void persist();
    let timer;
    const observer = new document.defaultView.MutationObserver(() => {
      if (timer) return;
      timer = document.defaultView.setTimeout(() => {
        timer = null;
        if (!allowedPath(document.location.pathname)) translator.restore();
        else translator.apply();
      }, 80);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder'] });
    return { translator, destroy() { observer.disconnect(); document.defaultView.clearTimeout(timer); translator.restore(); host.remove(); } };
  }
  return Object.freeze({ createTranslator, createRuntimeStorage, start, storageKey, allowedPath });
});
