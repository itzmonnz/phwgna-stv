(function attachFanqieUI(root, factory) {
  const api = factory(root.STVAIFanqieDictionary || (typeof require === 'function'
    ? require('../shared/fanqie-ui-dictionary.js') : null), root.STVAIFanqieTitles || (typeof require === 'function'
    ? require('../shared/fanqie-title-translator.js') : null), root.STVAIUI || (typeof require === 'function' ? require('./stv-ui.js') : null), root.STVAIFanqiePreferences || (typeof require === 'function' ? require('../shared/fanqie-preferences.js') : null), root.STVAINameManager || (typeof require === 'function' ? require('./stv-name-manager.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document && root.location.hostname === 'fanqienovel.com'
    && root.location.protocol === 'https:') api.start(root.document, api.createRuntimeStorage(root.chrome?.runtime));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dictionary, titles, ui, preferences, panels) {
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
    '.book-item-btn', '.info-label', '.page-abstract-header', '.add-bookshelf-btn',
    '.info-count-word .text', '.book-route-trackers a:first-child', '.info-last-title',
    '.book-item-text .tags', '.book-item .book-item-label'
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
    if (parent?.closest('.info-last-title') && source.startsWith('最近更新：')) return source.replace('最近更新：', 'Mới cập nhật: ');
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
      subscribe(callback) {
        const listener = message => {
          if (message?.type === 'STVAI_FANQIE_UI_CHANGED') callback(preferences.normalize(message.preferences));
        };
        runtime?.onMessage?.addListener(listener);
        return () => runtime?.onMessage?.removeListener(listener);
      },
      openSettings: () => runtime.sendMessage({ type: 'STVAI_OPEN_OPTIONS', site: 'fanqie' }),
      async get() {
        const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_UI_GET' });
        if (!result?.ok) throw new Error('fanqie_storage_unavailable');
        return { [storageKey]: preferences.normalize(result) };
      },
      async set(values) {
        const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_UI_SET', ...values[storageKey] });
        if (!result?.ok) throw new Error('fanqie_storage_unavailable');
      },
      translateTitle(source) { return runtime.sendMessage({ type: 'STVAI_FANQIE_TITLE_TRANSLATE', source }); },
      translateIntroduction(source) { return runtime.sendMessage({ type: 'STVAI_FANQIE_INTRODUCTION_TRANSLATE', source }); }
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
  function createTranslator(document, titleEngine, introductionEngine) {
    const originals = new Map();
    let layoutStyle;
    let enabled = true;
    let generation = 0;
    const pending = new WeakMap();
    function remember(node, source, translated, attribute) {
      originals.set(node, { source, translated, attribute });
    }
    function apply() {
      if (!enabled || !allowedPath(document.location.pathname)) return 0;
      if (!layoutStyle?.isConnected) {
        layoutStyle = document.createElement('style');
        layoutStyle.dataset.stvaiFanqieLayout = 'vi';
        // Fanqie pins this at left:202px, overlapping the longer Vietnamese tabs.
        layoutStyle.textContent = `
          .muye-search-filter .filter-entry{left:auto!important;right:0!important}
          .muye-header .muye-header-content{width:100%;max-width:1280px;padding:0 24px;box-sizing:border-box;gap:20px}
          .muye-header .muye-header-right{min-width:0;flex:1;gap:14px;height:auto;justify-content:flex-end}
          .muye-header .nav-item{margin:0!important;padding:0!important;flex:0 0 auto;font-size:13px;line-height:20px;white-space:nowrap}
          .muye-header .muye-header-search{flex:1 1 180px;min-width:130px;max-width:220px;margin:0!important}
          .muye-header .serial-divider{margin:0!important}
          .muye-header .slogin-user-avatar__info__name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .page-header-info .info-label{display:flex;flex-wrap:wrap;gap:8px;height:auto;line-height:1.5}
          .page-header-info .info-label span{height:auto;white-space:normal;margin:0;padding:3px 9px;font-size:12px;line-height:1.5}
          .page-header .page-header-info{height:auto!important;min-height:234px;overflow:visible!important;display:flow-root}
          .page-header-info .info{min-width:0;height:auto!important;min-height:234px;overflow:visible!important}
          .page-header-info .info-last{margin-top:18px!important;flex-wrap:wrap;height:auto!important;gap:6px 12px}
          .page-header-info .info-btn,.page-header-info .add-bookshelf-btn{position:static!important;display:inline-flex!important;vertical-align:top;align-items:center;justify-content:center;width:auto!important;min-width:132px!important;padding:0 16px!important;font-size:14px!important;white-space:nowrap;margin:16px 12px 0 0!important}
          .page-header-info .download-icon{position:static!important;display:inline-block!important;vertical-align:middle;margin-top:16px}
          .page-abstract-content{height:auto!important;max-height:none!important;-webkit-line-clamp:unset!important;-webkit-box-orient:initial!important;display:block!important;overflow:visible!important;margin-top:24px!important;margin-bottom:32px!important}
          .page-abstract-content p{font-family:Arial,sans-serif;font-size:16px;line-height:1.8;white-space:pre-line;overflow-wrap:anywhere}
          @media(max-width:1100px){.muye-header .muye-header-content{padding:0 14px;gap:12px}.muye-header .muye-header-right{gap:10px;flex-wrap:wrap}.muye-header .muye-header-search{flex-basis:140px}.muye-header{height:auto;min-height:64px}.muye-header .muye-header-content{height:auto;min-height:64px;padding-top:10px;padding-bottom:10px}}
        `;
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
        if (titleEngine.remote) {
          const rect = region.getBoundingClientRect();
          if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > document.defaultView.innerHeight) continue;
          const old = pending.get(region);
          if (old?.source === source && old.generation === generation && old.path === document.location.pathname
            && old.nodes.length === nodes.length && old.nodes.every((n, i) => n === nodes[i])) continue;
          const request = { source, generation, path: document.location.pathname, values: nodes.map(n => n.data), nodes };
          pending.set(region, request);
          Promise.resolve(titleEngine.convert(source, titleFont(document, region))).then(result => {
            if (!result || pending.get(region) !== request || !enabled || generation !== request.generation
              || document.location.pathname !== request.path || !allowedPath(document.location.pathname)
              || nodes.some((n, i) => !n.isConnected || !region.contains(n) || n.data !== request.values[i])
              || region.textContent !== source) return;
            nodes.forEach((n, i) => { const translated = i ? '' : result.text; remember(n, n.data, translated); n.data = translated; });
            const tooltip = `${result.source}\nDịch MyMemory`;
            remember(region, region.getAttribute('title'), tooltip, 'title');
            region.setAttribute('title', tooltip);
          }).catch(() => { /* Failure leaves the original title, never local cache. */ });
          continue;
        }
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
      if (introductionEngine && /^\/page\/\d+\/?$/.test(document.location.pathname)) {
        for (const region of document.querySelectorAll('.page-abstract-content p')) {
          const walker = document.createTreeWalker(region, 4), nodes = [];
          let node; while ((node = walker.nextNode())) nodes.push(node);
          if (!nodes.length || nodes.every(n => originals.get(n)?.translated === n.data)) continue;
          const source = nodes.map(n => n.data).join('');
          if (!/[\u3400-\u9fff]/.test(source)) continue;
          const old = pending.get(region);
          if (old?.source === source && old.generation === generation && old.path === document.location.pathname) continue;
          const request = { source, generation, path: document.location.pathname, values: nodes.map(n => n.data) };
          pending.set(region, request);
          Promise.resolve().then(() => introductionEngine(source)).then(result => {
            if (!result?.ok || result.source !== source.normalize('NFC').trim() || result.provider !== 'mymemory'
              || pending.get(region) !== request || !enabled || generation !== request.generation
              || document.location.pathname !== request.path || region.textContent !== source
              || nodes.some((n, i) => !n.isConnected || !region.contains(n) || n.data !== request.values[i])) return;
            nodes.forEach((n, i) => { const text = i ? '' : result.text; remember(n, n.data, text); n.data = text; });
          }).catch(() => { /* Leave source intact; no partial introduction. */ });
        }
      }
      return count;
    }
    function restore() {
      generation++;
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
    return { apply, restore, setTitleEngine(engine) { restore(); titleEngine = engine; apply(); }, setEnabled(value) { enabled = value === true; if (!enabled) restore(); else apply(); } };
  }

  async function start(document, storage, engineLoader) {
    if (!allowedPath(document.location.pathname) || document.getElementById('stvai-fanqie-ui')) return null;
    const translator = createTranslator(document, null, storage?.translateIntroduction ? async source => {
      const path = document.location.pathname;
      introStatus.textContent = 'Giới thiệu: đang dịch MyMemory…';
      let response;
      try { response = await storage.translateIntroduction(source); }
      catch (_) { response = { ok: false, reason: 'api_unavailable' }; }
      if (!stopped && language === 'vi' && path === document.location.pathname) introStatus.textContent = response?.ok
        ? `Giới thiệu: MyMemory${response.cacheHit ? ' · dùng cache' : ' · đã dịch'}`
        : ['daily_limit', 'quota_exceeded', 'api_backoff'].includes(response?.reason)
          ? 'Giới thiệu: hết hạn mức/tạm chờ API; giữ bản gốc' : 'Giới thiệu: API chưa dịch được; giữ bản gốc';
      return response;
    } : null);
    let stopped = false, loading = false, loaded = false, retryAfter = 0, loadGeneration = 0;
    const loadTitles = () => {
      if (stopped || loading || loaded || language !== 'vi' || Date.now() < retryAfter || !document.querySelector(titleRegions)) return;
      const runtime = document.defaultView.chrome?.runtime;
      const loader = engineLoader || (runtime?.getURL && document.defaultView.fetch
        ? () => titles.loadEngine(runtime, document.defaultView.fetch.bind(document.defaultView), titleProvider === 'mymemory') : null);
      if (!loader) return;
      loading = true;
      const currentGeneration = loadGeneration;
      const currentProvider = titleProvider;
      host.dataset.titleState = 'loading';
      Promise.resolve().then(loader).then(engine => {
        if (stopped || currentGeneration !== loadGeneration) return;
        if (currentProvider === 'mymemory' && storage?.translateTitle) {
          const engineDecoder = engine;
          const cache = new Map();
          engine = { remote: true, convert(source, font) {
            const decoded = engineDecoder.convert(source, font)?.source;
            if (!decoded) return null;
            if (!cache.has(decoded)) {
              const request = storage.translateTitle(decoded).then(response => {
                if (!response?.ok || response.provider !== 'mymemory' || response.source !== decoded) {
                  if (!stopped && currentGeneration === loadGeneration) {
                    status.textContent = failureLabel(response?.reason);
                    host.dataset.titleState = 'unavailable';
                  }
                  return null;
                }
                if (!stopped && currentGeneration === loadGeneration) status.textContent = 'Tên truyện: MyMemory · cache riêng';
                return { source: decoded, text: response.text };
              }).catch(() => { if (!stopped && currentGeneration === loadGeneration) status.textContent = 'MyMemory mất kết nối; giữ tên gốc'; return null; });
              cache.set(decoded, request);
              while (cache.size > 512) cache.delete(cache.keys().next().value);
            }
            return cache.get(decoded);
          } };
        }
        loaded = true; host.dataset.titleState = 'ready'; translator.setTitleEngine(engine);
      }).catch(() => {
        if (stopped || currentGeneration !== loadGeneration) return;
        retryAfter = Date.now() + 30000; host.dataset.titleState = 'unavailable';
        status.textContent = 'Chưa tải được bộ giải mã tên truyện';
      })
        .finally(() => { if (currentGeneration === loadGeneration) loading = false; });
    };
    let preference = preferences.normalize({ titleProvider: 'local' });
    let language = preference.language;
    let titleProvider = preference.titleProvider;
    try {
      const values = await storage?.get(storageKey);
      preference = preferences.normalize(values?.[storageKey] || { titleProvider: 'local' });
      language = preference.language; titleProvider = preference.titleProvider;
    } catch (_) { /* Bundled dictionary remains usable without storage. */ }
    const host = document.createElement('div');
    host.id = 'stvai-fanqie-ui';
    host.style.cssText = 'position:relative;z-index:2147483200';
    const shadow = host.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = document.defaultView.chrome?.runtime?.getURL?.('src/content/stv.css') || 'src/content/stv.css';
    const layout = document.createElement('style');
    layout.textContent = `
      :host { all: initial; }
      .stvai-toolbar { left: 12px; top: 50%; max-width: calc(100vw / var(--stvai-ui-scale, 1) - 24px); max-height: calc(100dvh / var(--stvai-ui-scale, 1) - 24px); }
      .stvai-fanqie-context { margin: 0; color: var(--stvai-text-muted); font-size: 12px; }
      .stvai-fanqie-controls { display: grid; gap: 8px; }
      .stvai-fanqie-controls label { display: grid; gap: 5px; font-size: 12px; }
      .stvai-fanqie-scale { width: 100%; padding: 8px; border-radius: 8px; color: var(--stvai-text); background: var(--stvai-surface); border: 1px solid var(--stvai-border); }
    `;
    let positionController;
    const toolbar = ui.createToolbar(document, {}, {
      initialCollapsed: preference.collapsed,
      onLayoutChange(anchor, icon) { positionController?.anchorTo(anchor, icon); },
      onCollapsedChange(collapsed) { if (preference.collapsed === collapsed) return; preference.collapsed = collapsed; void persist({ collapsed }); }
    });
    toolbar.root.dataset.site = 'fanqie';
    toolbar.root.setAttribute('aria-label', 'Phwgna Stv · Fanqie');
    toolbar.settings.setAttribute('aria-label', 'Mở cài đặt Fanqie');
    toolbar.root.style.setProperty('--stvai-ui-scale', String(preference.uiScale));
    // Reuse the STV shell, but do not expose unimplemented chapter/TTS actions.
    toolbar.root.querySelector('.stvai-actions').remove();
    for (const node of [toolbar.names, toolbar.clearCache, toolbar.cacheConfirmation, toolbar.progress,
      toolbar.recoveryStatus, toolbar.miniProgress, toolbar.miniCompleteRing, toolbar.miniTomoe]) node.remove();
    const controls = document.createElement('div'); controls.className = 'stvai-fanqie-controls';
    const context = document.createElement('p'); context.className = 'stvai-fanqie-context';
    context.textContent = 'Fanqie · giao diện, tên và giới thiệu truyện';
    const introStatus = document.createElement('p'); introStatus.className = 'stvai-fanqie-context';
    introStatus.setAttribute('role', 'status');
    context.append(introStatus);
    const providerButton = document.createElement('button');
    providerButton.type = 'button'; providerButton.className = 'stvai-button stvai-button--quiet';
    providerButton.dataset.fanqieAction = 'provider';
    const status = toolbar.status;
    const failureLabel = reason => ['daily_limit', 'quota_exceeded', 'api_backoff'].includes(reason)
      ? 'MyMemory tạm dừng/quota hết; dùng cache hoặc giữ tên gốc'
      : 'MyMemory chưa dịch được; giữ tên gốc';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stvai-button stvai-button--primary';
    button.dataset.fanqieAction = 'language';
    const updateButton = () => {
      introStatus.hidden = language !== 'vi';
      button.textContent = language === 'vi' ? 'Tiếng Việt · 中文' : '中文 · Tiếng Việt';
      button.title = 'Phwgna: dịch nhãn giao diện; tên truyện dùng nguồn đã chọn. Rê chuột tên để xem gốc. Không dịch chương hoặc bình luận.';
      providerButton.textContent = titleProvider === 'mymemory' ? 'Tên: MyMemory · đổi sang từ điển' : 'Tên: từ điển · bật MyMemory';
      providerButton.title = 'MyMemory dịch tên khi được chọn. Khi bật tiếng Việt, giới thiệu truyện cũng gửi tới MyMemory và lưu cache; dùng chung hạn mức 4.500 ký tự/ngày. Không gửi chương hoặc bình luận.';
    };
    const persist = async (patch = {}) => {
      host.dataset.storageState = 'saving';
      try {
        await storage?.set({ [storageKey]: {
          ...patch, version: dictionary.version, entries: dictionary.entries
        } });
        host.dataset.storageState = 'saved';
      } catch (_) {
        host.dataset.storageState = 'failed';
        button.title = 'Chưa lưu được ngôn ngữ và bộ nhãn; lựa chọn có thể mất khi tải lại trang.';
        status.textContent = 'Chưa lưu được cài đặt; hãy thử lại.';
      }
    };
    button.addEventListener('click', async () => {
      language = language === 'vi' ? 'zh' : 'vi';
      if (titleProvider === 'mymemory') {
        loadGeneration++; loaded = false; loading = false; retryAfter = 0; translator.setTitleEngine(null);
      }
      translator.setEnabled(language === 'vi'); updateButton(); await persist({ language }); loadTitles();
    });
    providerButton.addEventListener('click', async () => {
      titleProvider = titleProvider === 'mymemory' ? 'local' : 'mymemory';
      loadGeneration++; loaded = false; loading = false; retryAfter = 0;
      translator.setTitleEngine(null); updateButton();
      status.textContent = titleProvider === 'mymemory' ? 'Đang bật MyMemory…' : 'Tên truyện: từ điển cục bộ';
      await persist({ titleProvider }); loadTitles();
    });
    const scaleLabel = document.createElement('label'); scaleLabel.textContent = 'Kích thước menu';
    const scale = document.createElement('select'); scale.className = 'stvai-fanqie-scale stvai-provider-trigger';
    scale.dataset.fanqieAction = 'scale';
    for (const value of preferences.scales) {
      const option = document.createElement('option'); option.value = String(value); option.textContent = `${value * 100}%`;
      scale.append(option);
    }
    scale.value = String(preference.uiScale); scaleLabel.append(scale);
    scale.addEventListener('change', () => {
      preference.uiScale = ui.normalizeUiScale(scale.value);
      toolbar.root.style.setProperty('--stvai-ui-scale', String(preference.uiScale));
      positionController?.setUiScale(preference.uiScale);
      void persist({ uiScale: preference.uiScale });
    });
    controls.append(context, button, providerButton, scaleLabel);
    toolbar.root.querySelector('.stvai-menu-body').prepend(controls);
    toolbar.settings.addEventListener('click', async () => {
      try {
        const result = await storage?.openSettings?.();
        if (!result?.ok) status.textContent = 'Chưa mở được cài đặt Fanqie; hãy mở từ biểu tượng tiện ích.';
      } catch (_) { status.textContent = 'Chưa mở được cài đặt Fanqie; hãy thử lại.'; }
    });
    shadow.append(stylesheet, layout, toolbar.root); document.body.append(host);
    positionController = panels.attachDraggable(toolbar.root, toolbar.dragHandles, {
      // Avoid the website's localStorage: Fanqie position belongs to extension preferences.
      storage: {}, margin: 0, initialPosition: preference.position,
      getScale: () => preference.uiScale,
      isAnimating: () => toolbar.root.dataset.stvaiToolbarAnimating === 'true',
      onInteraction: () => toolbar.finishAnimation(),
      interactiveHandles: [toolbar.miniToggle],
      onPositionChange(position) { preference.position = position; void persist({ position }); }
    });
    const onStylesLoaded = () => positionController.refresh();
    stylesheet.addEventListener('load', onStylesLoaded);
    const unsubscribe = storage?.subscribe?.(next => {
      if (stopped) return;
      const titleChanged = titleProvider !== next.titleProvider || language !== next.language;
      const positionChanged = JSON.stringify(preference.position) !== JSON.stringify(next.position);
      const scaleChanged = preference.uiScale !== next.uiScale;
      preference = next; language = next.language; titleProvider = next.titleProvider;
      toolbar.root.style.setProperty('--stvai-ui-scale', String(next.uiScale)); scale.value = String(next.uiScale);
      if (scaleChanged) positionController.setUiScale(next.uiScale);
      if (positionChanged) positionController.setPosition(next.position);
      // Use the shell's own state transition for ARIA and collapse bookkeeping.
      if (toolbar.root.dataset.collapsed !== String(next.collapsed)) toolbar.menuToggle.click();
      if (titleChanged) {
        loadGeneration++; loaded = false; loading = false; retryAfter = 0; translator.setTitleEngine(null);
        status.textContent = titleProvider === 'mymemory' ? 'Tên truyện: MyMemory · chỉ gửi tên đang hiện' : 'Tên truyện: từ điển cục bộ';
        translator.setEnabled(language === 'vi'); updateButton(); loadTitles();
      }
    });
    translator.setEnabled(language === 'vi'); updateButton(); void persist();
    status.textContent = titleProvider === 'mymemory' ? 'Tên truyện: MyMemory · chỉ gửi tên đang hiện' : 'Tên truyện: từ điển cục bộ';
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
    const onScroll = () => { loadTitles(); translator.apply(); };
    document.defaultView.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.defaultView.addEventListener('resize', onScroll);
    return { translator, destroy() { stopped = true; unsubscribe?.(); positionController.destroy(); toolbar.finishAnimation(); stylesheet.removeEventListener('load', onStylesLoaded); loadGeneration++; observer.disconnect(); document.defaultView.removeEventListener('scroll', onScroll, true); document.defaultView.removeEventListener('resize', onScroll); document.defaultView.clearTimeout(timer); translator.restore(); host.remove(); } };
  }
  return Object.freeze({ createTranslator, createRuntimeStorage, start, storageKey, allowedPath });
});
