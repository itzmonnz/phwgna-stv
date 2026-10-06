(function attachFanqieUI(root, factory) {
  const api = factory(root.STVAIFanqieDictionary || (typeof require === 'function'
    ? require('../shared/fanqie-ui-dictionary.js') : null), root.STVAIFanqieTitles || (typeof require === 'function'
    ? require('../shared/fanqie-title-translator.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document && root.location.hostname === 'fanqienovel.com'
    && root.location.protocol === 'https:') api.start(root.document, api.createRuntimeStorage(root.chrome?.runtime));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dictionary, titles) {
  'use strict';
  const storageKey = 'stvai-fanqie-ui-v1';
  const regions = [
    '.muye-header .nav-item', '.muye-mobile-nav .nav-item-text',
    '.slogin-user-avatar__buttons__item', '.home-link-item-left-text-title',
    '.muye-home-block-title', '.muye-bottom-choiceness-title', '.muye-bottom-rank-header',
    '.muye-bottom-block-title', '.update-list-header', '.float-wrapper-item',
    '.muye-stack-filter-panel', '.stack-order-tab', '.page-directory-header h3 span',
    '.info-btn', '.reader-toolbar', '.muye-header-nav-item',
    '.writer-login .slogin-pc-form-header__title__tab',
    '.writer-login .slogin-form-input__error', '.writer-login .slogin-form-input__button-text',
    '.writer-login .slogin-form-protocol__text', '.writer-login .slogin-form-button',
    'a[href^="/writer/zone/tutorial"]', 'a[href^="/writer/zone/help"]',
    'a[href^="/welfare"]', 'a[href^="/protocal/agreement"]', 'a[href^="/protocal/privacy"]',
    '.slogin-user-avatar__menu-item__content', '.muye-category-item',
    '.zone-footer-ctn-left a', '.zone-footer-ctn-left p',
    '.zone-footer-ctn-right-wechat-desc', '.zone-footer-ctn-right-tiktok-desc',
    '.muye-search-bar .search-btn', '.muye-search-filter .byte-tabs-header-title',
    '.muye-search-filter .filter-entry', '.muye-search-filter-panel', '.muye-search-hint',
    '.book-item-btn'
  ].join(',');
  const excluded = 'script,style,textarea,[contenteditable],.muye-home-news-content-item,.muye-stack-book-list,.page-directory-content,.reader-content,[class*="comment"]';
  const translations = new Map(dictionary.entries.flatMap(entry => entry.source.endsWith('：')
    ? [[entry.source, entry.vietnamese], [entry.source.slice(0, -1), entry.vietnamese.replace(/:$/, '')]]
    : [[entry.source, entry.vietnamese]]));
  const allowedPath = dictionary.allowedPath;
  const footerPrefixes = ['广告投放：', '不良信息举报邮箱：', '意见建议邮箱：',
    '违法和不良信息举报电话：', '版权咨询：'];

  function translateNode(node) {
    const source = node.data.trim();
    const parent = node.parentElement;
    if (source === '和' && parent?.closest('.writer-login .slogin-form-protocol__text')) return 'và';
    if (parent?.closest('.muye-search-hint')) {
      if (source === '共') return 'Có';
      if (source === '项相关的结果') return 'kết quả liên quan';
    }
    if (parent?.closest('.zone-footer-ctn-left p')) {
      const prefix = footerPrefixes.find(label => source.startsWith(label));
      if (prefix) return source.replace(prefix, translations.get(prefix));
    }
    return translations.get(source);
  }

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

  const titleRegions = '.muye-bottom-choiceness-item .book-text .title, .muye-bottom-rank-content h3.title, .update-item.book-name a[href^="/page/"], .book-item-text .title, a.book-item-title[href^="/page/"], .muye-stack-book-list .book-name, .page-header-info .info-name h1';
  function titleFont(document, region) {
    const owner = region.closest('[class*="font-"]');
    const family = Array.from(owner?.classList || []).find(name => /^font-[a-zA-Z0-9]+$/.test(name))?.slice(5);
    if (!family) return null;
    for (const style of document.querySelectorAll('style')) {
      const rule = new RegExp(`font-family:\\s*["']?${family}["']?\\s*;[^}]*`).exec(style.textContent);
      const hash = rule && /\/([a-f0-9]{15})(?:-\d+)?\.woff2/.exec(rule[0]);
      if (hash) return hash[1];
    }
    return null;
  }
  function createTranslator(document, titleEngine) {
    const originals = new Map();
    let layoutStyle;
    let enabled = true;
    function remember(node, source, translated, attribute) {
      originals.set(node, { source, translated, attribute });
    }
    function apply() {
      if (!enabled || !allowedPath(document.location.pathname)) return 0;
      if (!layoutStyle?.isConnected) {
        layoutStyle = document.createElement('style');
        layoutStyle.dataset.stvaiFanqieLayout = 'vi';
        // Fanqie pins this at left:202px, overlapping the longer Vietnamese tabs.
        layoutStyle.textContent = '.muye-search-filter .filter-entry{left:auto!important;right:0!important}';
        (document.head || document.documentElement).append(layoutStyle);
      }
      for (const node of originals.keys()) if (!node.isConnected) originals.delete(node);
      let count = 0;
      for (const region of document.querySelectorAll(regions)) {
        if (region.closest(excluded)) continue;
        const walker = document.createTreeWalker(region, 4);
        let node;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest(excluded)) continue;
          const source = node.data.trim();
          const translated = translateNode(node);
          if (!translated) continue;
          const replacement = node.data.replace(source, translated);
          remember(node, node.data, replacement);
          node.data = replacement;
          count += 1;
        }
      }
      for (const input of document.querySelectorAll('.muye-header-search input[placeholder], .writer-login input[placeholder], .muye-search-bar .search-input[placeholder]')) {
        const source = input.getAttribute('placeholder');
        const translated = translations.get(source);
        if (!translated) continue;
        remember(input, source, translated, 'placeholder');
        input.setAttribute('placeholder', translated);
        count += 1;
      }
      if (titleEngine) for (const region of document.querySelectorAll(titleRegions)) {
        if (region.closest('script,style,textarea,[contenteditable],[class*="comment"],.reader-content')) continue;
        const walker = document.createTreeWalker(region, 4), nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);
        if (!nodes.length || nodes.every(n => originals.get(n)?.translated === n.data)) continue;
        const source = nodes.map(n => n.data).join('');
        const result = titleEngine.convert(source, titleFont(document, region));
        if (!result || result.text === source.trim()) continue;
        nodes.forEach((n, i) => {
          const translated = i ? '' : result.text;
          remember(n, n.data, translated); n.data = translated;
        });
        const tooltip = `${result.source || source.trim()}\nDịch từ điển${result.partial ? ' — còn từ chưa biết' : ''}. CVDICT · Phong Phan · CC BY-SA 4.0`;
        // Preserve original tooltip too; a site's fresh attribute wins on restore.
        const previous = originals.get(region);
        const nativeTitle = previous && region.getAttribute('title') === previous.translated
          ? previous.source : region.getAttribute('title');
        remember(region, nativeTitle, tooltip, 'title');
        region.setAttribute('title', tooltip);
        count++;
      }
      return count;
    }
    function restore() {
      layoutStyle?.remove(); layoutStyle = null;
      for (const [node, entry] of originals) {
        // React/site updates own the latest value: never restore stale text.
        const current = entry.attribute ? node.getAttribute(entry.attribute) : node.data;
        if (node.isConnected && current === entry.translated) {
          if (entry.attribute && entry.source === null) node.removeAttribute(entry.attribute);
          else if (entry.attribute) node.setAttribute(entry.attribute, entry.source);
          else node.data = entry.source;
        }
      }
      originals.clear();
    }
    return { apply, restore, setTitleEngine(engine) { titleEngine = engine; apply(); }, setEnabled(value) { enabled = value === true; if (!enabled) restore(); else apply(); } };
  }

  async function start(document, storage, engineLoader) {
    if (!allowedPath(document.location.pathname) || document.getElementById('stvai-fanqie-ui')) return null;
    const translator = createTranslator(document);
    let stopped = false, loading = false, loaded = false, retryAfter = 0;
    const loadTitles = () => {
      if (stopped || loading || loaded || language !== 'vi' || Date.now() < retryAfter || !document.querySelector(titleRegions)) return;
      const runtime = document.defaultView.chrome?.runtime;
      const loader = engineLoader || (runtime?.getURL && document.defaultView.fetch
        ? () => titles.loadEngine(runtime, document.defaultView.fetch.bind(document.defaultView)) : null);
      if (!loader) return;
      loading = true;
      host.dataset.titleState = 'loading';
      Promise.resolve().then(loader).then(engine => {
        if (stopped) return;
        loaded = true; host.dataset.titleState = 'ready'; translator.setTitleEngine(engine);
      }).catch(() => { retryAfter = Date.now() + 30000; if (!stopped) host.dataset.titleState = 'unavailable'; })
        .finally(() => { loading = false; });
    };
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
      button.title = 'Phwgna: dịch giao diện và tên truyện bằng từ điển; rê chuột tên để xem gốc. Không dịch chương hoặc bình luận.';
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
      translator.setEnabled(language === 'vi'); updateButton(); loadTitles(); void persist();
    });
    shadow.append(button); document.body.append(host);
    translator.setEnabled(language === 'vi'); updateButton(); void persist();
    loadTitles();
    let timer;
    const observer = new document.defaultView.MutationObserver(() => {
      if (timer) return;
      timer = document.defaultView.setTimeout(() => {
        timer = null;
        if (!allowedPath(document.location.pathname)) translator.restore();
        else { loadTitles(); translator.apply(); }
      }, 80);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder'] });
    return { translator, destroy() { stopped = true; observer.disconnect(); document.defaultView.clearTimeout(timer); translator.restore(); host.remove(); } };
  }
  return Object.freeze({ createTranslator, createRuntimeStorage, start, storageKey, allowedPath });
});
