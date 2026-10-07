(function attachFanqieUI(root, factory) {
  const api = factory(root.STVAIFanqieDictionary || (typeof require === 'function'
    ? require('../shared/fanqie-ui-dictionary.js') : null), root.STVAIFanqieTitles || (typeof require === 'function'
    ? require('../shared/fanqie-title-translator.js') : null), root.STVAIUI || (typeof require === 'function' ? require('./stv-ui.js') : null), root.STVAIFanqiePreferences || (typeof require === 'function' ? require('../shared/fanqie-preferences.js') : null), root.STVAINameManager || (typeof require === 'function' ? require('./stv-name-manager.js') : null), root.STVAIFanqieBookPreview || (typeof require === 'function' ? require('./fanqie-book-preview.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document && root.location.hostname === 'fanqienovel.com'
    && root.location.protocol === 'https:') api.start(root.document, api.createRuntimeStorage(root.chrome?.runtime));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dictionary, titles, ui, preferences, panels, previews) {
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
    '.book-item-text .tags', '.book-item .book-item-label',
    '.home-link-item-left-text-content', '.muye-home-top-rank-desc',
    '.muye-home-top-rank-list-item-info-cate', '.writer-list-current-first .level',
    '.writer-list-current-first .desc', '.muye-home-news-content-more', '.muye-bottom-rank-content-header',
    '.home-copyright-text-content', '.home-copyright-text-button', '.home-publish-list-button',
    '.home-publish-list-item-text-second-time', '.update-list-item > .update-item:first-child',
    '.muye-rank-menu .arco-menu-item', '.muye-rank-wrap-header', '.rank-label-info',
    '.muye-rank-menu .arco-menu-inline-header', '.rank-info', '.rank-label-info .title',
    '.rank-label-info .item p', '.muye-rank-wrap-header p',
    '.rank-book-item .book-item-footer-status', '.rank-book-item .book-item-count',
    '.rank-book-item .book-item-footer-last', '.rank-book-item .book-item-footer-time',
    '.author-zone-tab-item', '.tutorial-item-text-title', '.tutorial-item-text-content',
    '.home-authortalk-title-text', '.home-authortalk-list-item-card1-content-introduction',
    '.home-publish-list-item-text-second-from'
  ].join(',');
  const excluded = 'script,style,textarea,[contenteditable],.muye-home-news-content-item,.muye-stack-book-list,.page-directory-content,.reader-content';
  const translations = new Map(dictionary.entries.flatMap(entry => entry.source.endsWith('：')
    ? [[entry.source, entry.vietnamese], [entry.source.slice(0, -1), entry.vietnamese.replace(/:$/, '')]]
    : [[entry.source, entry.vietnamese]]));
  const allowedPath = dictionary.allowedPath;
  const footerPrefixes = ['广告投放：', '不良信息举报邮箱：', '意见建议邮箱：',
    '违法和不良信息举报电话：', '版权咨询：'];

  function translateNode(node) {
    const source = node.data.trim();
    const parent = node.parentElement;
    if (parent?.closest('.muye-rank-menu,.muye-rank-wrap-header')) {
      const fixed = new Map([
        ['榜单说明', 'Thông tin bảng xếp hạng'],
        ['阅读榜', 'Bảng đọc nhiều'],
        ['新书榜', 'Bảng truyện mới'],
        ['男频阅读榜', 'Xếp hạng truyện nam · Đọc nhiều'],
        ['男频新书榜', 'Xếp hạng truyện nam · Truyện mới'],
        ['女频阅读榜', 'Xếp hạng truyện nữ · Đọc nhiều'],
        ['女频新书榜', 'Xếp hạng truyện nữ · Truyện mới']
      ]);
      if (fixed.has(source)) return fixed.get(source);
      if (source.startsWith('统计时间截止至')) return source.replace('统计时间截止至', 'Thời gian thống kê đến ');
      if (source.startsWith('适用对象：')) return source.replace('适用对象：', 'Áp dụng cho: ');
    }
    if (source.startsWith('适用对象：')) return source.replace('适用对象：', 'Áp dụng cho: ');
    if (parent?.closest('.writer-list-current-first .desc') && source.startsWith('代表作')) return source.replace('代表作', 'Tác phẩm tiêu biểu: ');
    if (parent?.closest('.muye-bottom-rank-content-header')) {
      if (source === '阅读榜') return 'Đọc nhiều';
      if (source === '新书榜') return 'Truyện mới';
      const rank = /^(.*)·(阅读榜|新书榜)$/.exec(source);
      if (rank && translations.has(rank[1])) return `${translations.get(rank[1])} · ${rank[2] === '阅读榜' ? 'Đọc nhiều' : 'Truyện mới'}`;
      if (source.startsWith('仅展示原创作品，统计时间截止至')) return source.replace('仅展示原创作品，统计时间截止至', 'Chỉ gồm truyện gốc · Số liệu đến ');
    }
    if (parent?.closest('.home-publish-list-item-text-second-time') && source.startsWith('签约日期')) return source.replace('签约日期', 'Ngày ký hợp đồng');
    // Short navigation labels fit the original desktop and mobile menu slots.
    if (parent?.closest('.muye-header .nav-item,.muye-mobile-nav .nav-item-text')) {
      const short = { '原创榜': 'Xếp hạng', '作家专区': 'Tác giả', '版权专区': 'Bản quyền' };
      if (short[source]) return short[source];
    }
    if (parent?.closest('.float-wrapper-item')) {
      const short = { '番茄小说网': 'Fanqie', '番茄小说': 'Fanqie', '帮助中心': 'Trợ giúp' };
      if (short[source]) return short[source];
    }
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
      async loadBook(bookId) { const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_BOOK_PREVIEW', bookId }); return result?.ok ? result.book : null; },
      async loadBookIndex() { const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_BOOK_PREVIEW' }); return result?.ok ? result.books : []; },
      async loadRankBooks(rank) { const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_BOOK_PREVIEW', rank }); return result?.ok ? result.books : []; },
      translateText(source, kind, priority = 0) { return runtime.sendMessage({ type: 'STVAI_FANQIE_TEXT_TRANSLATE', source, kind, priority }); },
      translateIntroduction(source, priority = 0) { return runtime.sendMessage({ type: 'STVAI_FANQIE_INTRODUCTION_TRANSLATE', source, priority }); }
    };
  }

  const titleRegions = '.muye-bottom-choiceness-item .book-text .title, .muye-bottom-rank-content h3.title, .muye-home-top-rank-list-item-info-name, .update-item.book-name a[href^="/page/"], .book-item-text .title, a.book-item-title[href^="/page/"], .muye-stack-book-list .book-name, .page-header-info .info-name h1, .home-publish-list-item-text-first-book, .rank-book-item .title, .tutorial-item-text-title, [class*="article"] h1, [class*="article-title"], [class*="article"] [class*="title"]';
  const metadataRegions = '.author-name-text, .author-desc, .book-item-author, .book-text .author, .book-item-text .author, .muye-home-top-rank-list-item-info-author, a.chapter-item-title[href^="/reader/"], a.update-item-chapter[href^="/reader/"], .page-abstract-content p, .muye-reader-title, .muye-reader-nav-title, .muye-home-news-content-item, .writer-list-current-first .bottom .title, .writer-list-current-first .desc, .muye-bottom-rank-content .book-text .desc, .update-item-author, .home-publish-list-item-text-first-author, .home-publish-list-item-text-second-from, .rank-book-item .author, .rank-book-item .desc, .rank-book-item .book-item-footer-last .chapter, .home-authortalk-list-item-card1-content-introduction, [class*="article-author"], [class*="article-byline"], [class*="article-desc"], [class*="article-content"], [class*="article"] [class*="author"], [class*="article"] [class*="desc"], [class*="article"] [class*="content"]';
  const commentRegions = '.comment, [class*="comment-content"], [class*="comment-text"], [class*="comment-item"] .content, [class*="reply-content"], [class*="reply-text"]';
  const genreRegions = '.muye-home-top-rank-list-item-info-cate, .rank-book-item .category, .book-item-text .category, .book-item-category, .book-item-text .genre';
  const categoryRegions = `.book-item-text .tags, .book-item .book-item-label, .info-label, .rank-book-item .tags,${genreRegions}`;
  function contentPriority(kind) { return ({ ui: 0, title: 1, category: 2, introduction: 3, description: 3, author: 4, chapter: 5, comment: 6 })[kind] ?? 6; }
  const fallbackScope = /(?:book|rank|home|writer|author|tutorial|publish|search|category|library|menu|header|update|news|zone|article|detail|richtext|markdown)/i;
  const fallbackBlocked = /(?:comment|reply|user|avatar|account|login|password|phone|email|form|input|textarea|button|reader-content|chapter-content|copyright|footer|nav-item)/i;
  const knownRegions = `${regions},${titleRegions},${metadataRegions}`;
  function metadataKind(region) {
    if (region.matches(categoryRegions)) return region.matches(genreRegions) ? 'category' : 'ui';
    const className = typeof region.className === 'string' ? region.className : '';
    if (/(?:comment|reply)/i.test(className)) return 'comment';
    if (/(?:author|byline)/i.test(className)) return 'author';
    if (/(?:desc|abstract|intro|summary|content)/i.test(className)) return 'description';
    if (region.matches('.page-abstract-content p')) return 'introduction';
    if (region.matches('.author-desc, .muye-home-news-content-item, .writer-list-current-first .desc, .muye-bottom-rank-content .book-text .desc, .rank-book-item .desc, .home-authortalk-list-item-card1-content-introduction')) return 'description';
    if (region.matches('a.chapter-item-title, a.update-item-chapter, .muye-reader-title')) return 'chapter';
    if (region.matches('.author-name-text, .book-item-author, .book-text .author, .book-item-text .author, .muye-home-top-rank-list-item-info-author, .writer-list-current-first .bottom .title, .update-item-author, .home-publish-list-item-text-first-author, .rank-book-item .author')) return 'author';
    return 'title';
  }
  function fallbackKind(region) {
    const classes = typeof region.className === 'string' ? region.className : '';
    if (/(?:tag|label|menu|header|filter)/i.test(classes)) return 'ui';
    if (/(?:category|cate|genre)/i.test(classes)) return 'category';
    if (/(?:comment|reply)/i.test(classes)) return 'comment';
    if (/(?:author|writer|creator)/i.test(classes)) return 'author';
    if (/(?:desc|abstract|intro|summary|content|bio)/i.test(classes)) return 'description';
    if (/(?:chapter|latest|update)/i.test(classes)) return 'chapter';
    return 'title';
  }
  function fallbackRegions(document) {
    const found = [];
    const walker = document.createTreeWalker(document.body, 4);
    let node;
    while ((node = walker.nextNode()) && found.length < 128) {
      const source = node.data.trim();
      if (!source || source.length > 240 || !/[\u3400-\u9fff\ue000-\uf8ff]/u.test(source)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(excluded) || parent.closest(knownRegions)) continue;
      const chain = [];
      for (let current = parent; current && current !== document.body; current = current.parentElement) chain.push(current);
      if (!chain.some(element => fallbackScope.test(String(element.className || '')))) continue;
      if (chain.some(element => fallbackBlocked.test(String(element.className || '')) || /^(INPUT|TEXTAREA|BUTTON|SELECT)$/i.test(element.tagName))) continue;
      const region = parent;
      if (region.children.length > 4 || region.textContent.trim() !== source) continue;
      if (found.includes(region)) continue;
      found.push(region);
    }
    return found;
  }
  function visibleTitle(document, region) {
    const rect = region.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const view = document.defaultView;
    const bounds = { left: rect.left ?? 0, right: rect.right ?? rect.width, top: rect.top, bottom: rect.bottom };
    if (view.getComputedStyle(region).visibility === 'hidden') return false;
    for (let parent = region.parentElement; parent; parent = parent.parentElement) {
      // Root scrolling is clipped by the viewport, not the scrolled body's box.
      if (parent === document.body || parent === document.documentElement) continue;
      const style = view.getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (/hidden|clip|auto|scroll/.test(style.overflowX || style.overflow)) {
        bounds.left = Math.max(bounds.left, box.left); bounds.right = Math.min(bounds.right, box.right);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY || style.overflow)) {
        bounds.top = Math.max(bounds.top, box.top); bounds.bottom = Math.min(bounds.bottom, box.bottom);
      }
    }
    return bounds.right > Math.max(0, bounds.left) && bounds.left < view.innerWidth
      && bounds.bottom > Math.max(0, bounds.top) && bounds.top < view.innerHeight;
  }
  function titleFont(document, region) {
    const owner = region.closest('[class*="font-"]') || region.querySelector('[class*="font-"]');
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
    let layoutStyle, copyrightLabel, nextApply;
    let inflight = 0;
    let enabled = true;
    let generation = 0;
    let pending = new WeakMap();
    let remoteTranslated = new WeakSet();
    function remember(node, source, translated, attribute) {
      const previous = originals.get(node);
      const current = attribute ? node.getAttribute(attribute) : node.data;
      const original = previous && previous.attribute === attribute && current === previous.translated
        && (attribute || /[\u3400-\u9fff]/u.test(previous.translated)) ? previous.source : source;
      originals.set(node, { source: original, translated, attribute });
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
          .muye-header .muye-header-right{min-width:0;flex:1;gap:24px;height:auto;justify-content:flex-end;align-items:center}
          .muye-header .nav-item{position:relative;margin:0!important;padding:0!important;height:32px!important;flex:0 0 auto;font-family:Arial,sans-serif;font-size:14px;line-height:20px;white-space:nowrap;text-align:center}
          .muye-header .nav-item>a{display:flex;align-items:center;justify-content:center;min-height:32px;font:inherit;line-height:20px}
          .muye-header .nav-item-bar{position:absolute;left:0;bottom:0;margin:0!important}
          .muye-header .muye-header-search{flex:1 1 180px;min-width:130px;max-width:220px;margin:0!important}
          .muye-header .serial-divider{margin:0!important}
          .muye-header .slogin-user-avatar__info__name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .page-header-info .info-label{display:flex;flex-wrap:wrap;gap:8px;height:auto;line-height:1.5}
          .page-header-info .info-name{height:auto!important;min-height:32px;line-height:1.4}
          .page-header-info .info-name h1{margin:0!important;line-height:1.4;white-space:normal;overflow-wrap:anywhere}
          .page-header-info .info-label span{height:auto;white-space:normal;margin:0;padding:3px 9px;font-size:12px;line-height:1.5}
          .page-header .page-header-info{height:auto!important;min-height:234px;overflow:visible!important;display:flow-root}
          .page-header-info .info{min-width:0;height:auto!important;min-height:234px;overflow:visible!important}
          .page-header-info .info-last{margin-top:18px!important;flex-wrap:wrap;height:auto!important;gap:6px 12px}
          .page-header-info .info-btn,.page-header-info .add-bookshelf-btn{position:static!important;display:inline-flex!important;vertical-align:top;align-items:center;justify-content:center;box-sizing:border-box;height:36px!important;width:auto!important;min-width:132px!important;padding:0 16px!important;font-family:Arial,sans-serif!important;font-size:14px!important;line-height:20px!important;white-space:nowrap;margin:16px 12px 0 0!important}
          .page-header-info .info-btn>a,.page-header-info .add-bookshelf-btn>span{display:flex!important;align-items:center;justify-content:center;height:auto!important;min-height:0!important;width:auto!important;line-height:20px!important;font:inherit!important;margin:0!important;padding:0!important}
          .page-header-info .download-icon{position:static!important;display:inline-block!important;vertical-align:middle;margin-top:16px}
          .float-wrapper{width:88px!important;box-sizing:border-box;padding:8px 0!important}
          .float-wrapper .float-wrapper-item{display:flex!important;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:88px!important;height:72px!important;box-sizing:border-box;text-align:center!important}
          .float-wrapper .float-wrapper-item-icon{display:block!important;flex:0 0 20px;margin:0!important;width:20px;height:20px;line-height:20px!important}
          .float-wrapper .float-wrapper-item>div{box-sizing:border-box;width:100%;padding:0 6px;font-family:Arial,sans-serif;font-size:12px;line-height:18px!important;text-align:center!important;white-space:normal;overflow-wrap:normal}
          .home-link-item-left-text-content{height:auto!important;line-height:18px;font-family:Arial,sans-serif;font-size:12px}
          .muye-home-top-rank-list-item-info-cate{height:auto!important;white-space:normal!important;line-height:16px!important;overflow:visible!important;font-family:Arial,sans-serif;font-size:12px}
          .writer-list-current-first .level{width:auto!important;max-width:100%;height:auto!important;box-sizing:border-box;line-height:18px;font-family:Arial,sans-serif;font-size:11px;white-space:nowrap}
          .page-abstract-content{height:auto!important;max-height:none!important;-webkit-line-clamp:unset!important;-webkit-box-orient:initial!important;display:block!important;overflow:visible!important;margin-top:24px!important;margin-bottom:32px!important}
          .page-abstract-content p{font-family:Arial,sans-serif;font-size:16px;line-height:1.8;white-space:pre-line;overflow-wrap:anywhere}
          .author-name-text,.author-desc,.muye-reader-title{font-family:Arial,sans-serif;line-height:1.5;overflow-wrap:anywhere}
          .muye-bottom-choiceness-item .book-text .author{max-width:100%;height:auto!important;min-height:20px;white-space:normal!important;overflow:hidden!important;overflow-wrap:anywhere;line-height:20px!important;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
          .muye-bottom-choiceness-item .book-text .title{overflow:hidden!important;overflow-wrap:anywhere;line-height:24px!important}
          .muye-bottom-rank-category .muye-horizon-scroll-outer{overflow-x:auto!important;overflow-y:hidden!important;scrollbar-width:thin}
          .muye-bottom-rank-category .muye-horizon-scroll-wrapper{display:flex!important;width:max-content!important;gap:10px;transform:none!important;padding:0 4px}
          .muye-bottom-rank-category .muye-category-item{flex:0 0 auto!important;width:auto!important;max-width:none!important;margin:0!important;padding:0 14px!important;box-sizing:border-box;white-space:nowrap;line-height:36px!important;height:36px!important;font-family:Arial,sans-serif;font-size:13px}
          .muye-bottom-rank-content-header{height:auto!important;min-height:62px;line-height:1.5}
          .muye-bottom-rank-content-header a span{font-family:Arial,sans-serif;white-space:normal;overflow-wrap:anywhere}
          .muye-bottom-rank-content .rank-text-left{min-width:0;overflow:hidden}
          .muye-bottom-rank-content .rank-text{min-width:0}
          .muye-bottom-rank-content .rank-text h3.title{min-width:0;max-width:100%;overflow:hidden!important;text-overflow:ellipsis;white-space:nowrap}
          .muye-bottom-rank-content .rank-text-change{flex-shrink:0;margin-left:8px}
          .muye-bottom-rank-content .author{overflow:hidden!important;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
          .writer-list-current-first .bottom{height:auto!important;min-height:120px;box-sizing:border-box;padding-bottom:12px}
          .writer-list-current-first .wrapper-item{height:auto!important;min-height:277px;vertical-align:top}
          .writer-list-current-first .wrapper{height:auto!important;min-height:277px}
          .writer-list-current-first .bottom .title{height:auto!important;min-height:24px;max-width:100%;overflow:hidden;white-space:normal;overflow-wrap:anywhere;line-height:22px;font-family:Arial,sans-serif}
          .writer-list-current-first .desc{height:auto!important;max-width:100%;white-space:normal!important;overflow-wrap:anywhere;font-family:Arial,sans-serif;font-size:12px;line-height:18px}
          .zone-footer-ctn{flex-wrap:wrap;gap:24px;align-items:center}
          .zone-footer-ctn-left{flex:1 1 460px;min-width:0;width:auto!important;overflow-wrap:anywhere}
          .zone-footer-ctn-right{display:flex!important;gap:24px;flex-wrap:wrap;width:auto!important;max-width:560px;flex:1 1 424px;margin:0!important}
          .zone-footer-ctn-right-wechat,.zone-footer-ctn-right-tiktok{flex:1 1 200px!important;width:200px!important;max-width:260px;margin:0!important;text-align:center}
          .zone-footer-ctn-right-wechat-desc,.zone-footer-ctn-right-tiktok-desc{position:static!important;left:auto!important;right:auto!important;width:100%!important;height:auto!important;white-space:normal!important;overflow-wrap:anywhere;line-height:18px!important;margin-top:10px}
          .home-copyright-text-title:has([data-stvai-copyright])>svg{display:none}
          .home-copyright-text-title [data-stvai-copyright]{font-family:Arial,sans-serif;font-size:28px;line-height:1.4;color:#fff}
          .home-copyright-text-content{height:auto!important;white-space:normal;line-height:1.6;max-width:900px;margin-left:auto;margin-right:auto}
          /* Use native scrolling with a quiet, narrow handle rather than
             adding another draggable control or a scrolling script. */
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer){scrollbar-width:auto!important;scrollbar-color:auto!important}
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer)::-webkit-scrollbar{width:5px;height:5px}
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer)::-webkit-scrollbar-track{background:transparent}
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer)::-webkit-scrollbar-thumb{background:rgba(100,110,120,.28);border-radius:999px}
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer)::-webkit-scrollbar-thumb:hover{background:rgba(100,110,120,.52)}
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer)::-webkit-scrollbar-button{display:none;width:0;height:0}
          :is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer)::-webkit-scrollbar-corner{background:transparent}
          @supports not selector(::-webkit-scrollbar){:is(html,.muye-home-top-rank-list,.muye-home-write-block,.muye-bottom-choiceness-content,.muye-bottom-rank-view,.muye-horizon-scroll-outer){scrollbar-width:thin!important;scrollbar-color:rgba(100,110,120,.28) transparent!important}}
          /* Reflow page columns; only carousel tracks retain their native
             widths and scroll inside their own bounded viewport. */
          @media(max-width:1100px){
            html,body{min-width:0!important;overflow-x:visible!important}
            #app{width:100%!important;min-width:0!important;overflow-x:clip}
            .muye,.muye-home-wrapper,.muye-home,.muye-home-banner,.muye-home-notice-container,.muye-home-recommend-block,.muye-home-write-block,.muye-bottom-choiceness,.muye-bottom-choiceness-bg,.muye-bottom-rank,.muye-bottom-rank-block,.muye-bottom-rank-wrapper,.muye-bottom-rank-content,.zone-footer-ctn{width:100%!important;min-width:0!important;max-width:100%!important;box-sizing:border-box}
            .muye-home{padding:0 16px!important}
            .muye-home-banner{overflow:hidden}
            .muye-home-banner .arco-carousel{width:100%!important;max-width:100%}
            .muye-home-notice{width:100%!important;left:0!important;flex-wrap:wrap;gap:12px;box-sizing:border-box;padding:16px}
            .muye-home-notice .home-link-item{flex:1 1 240px;min-width:0;max-width:100%;margin:0!important}
            .muye-home-recommend-block{flex-wrap:wrap;gap:24px;height:auto!important}
            .muye-home-top-rank,.muye-home-news-block{height:auto!important;margin:0!important;min-width:0;width:100%!important}
            .muye-home-top-rank{flex:1 1 840px}
            .muye-home-news-block{flex:1 1 274px}
            .muye-home-top-rank-list{max-width:100%;overflow-x:auto}
            .muye-home-write-block,.muye-bottom-choiceness-content{max-width:100%!important;overflow-x:auto!important;overflow-y:hidden}
            .muye-bottom-choiceness-content{width:100%!important;left:0!important;transform:none!important}
            .muye-bottom-choiceness-content>.wrapper{width:1440px!important;max-width:none!important}
            .muye-bottom-rank-view{width:100%!important;overflow-x:auto!important;overflow-y:hidden}
            .muye-bottom-rank-content{padding:0 16px!important}
            .muye-bottom-rank-category{max-width:100%;box-sizing:border-box}
            .muye-bottom-rank-content>.absolute-btn{display:none}
            .home-copyright,.home-copyright-text,.home-copyright-text-content{max-width:100%!important;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere}
            .muye-header{width:100%!important;min-width:0!important}
            .muye-header .muye-header-content{width:100%!important;min-width:0!important;max-width:100%!important}
          }
          @media(max-width:1100px){.muye-header .muye-header-content{padding:0 14px;gap:12px}.muye-header .muye-header-right{gap:10px;flex-wrap:wrap}.muye-header .muye-header-search{flex-basis:140px}.muye-header{height:auto;min-height:64px}.muye-header .muye-header-content{height:auto;min-height:64px;padding-top:10px;padding-bottom:10px}}
        `;
        (document.head || document.documentElement).append(layoutStyle);
      }
      const copyrightTitle = document.querySelector('.home-copyright-text-title');
      if (copyrightTitle && !copyrightLabel?.isConnected) {
        copyrightLabel = document.createElement('span'); copyrightLabel.dataset.stvaiCopyright = '';
        copyrightLabel.textContent = 'Chuyển thể tác phẩm'; copyrightTitle.append(copyrightLabel);
      }
      for (const node of originals.keys()) if (!node.isConnected) originals.delete(node);
      let count = 0;
      for (const region of document.querySelectorAll(regions)) {
        if (region.closest(excluded)) continue;
        // Send this mixed label/work-list in its original Chinese, rather than
        // feeding Vietnamese diacritics through Chinese-only segmentation.
        if (titleEngine?.remote && region.matches('.writer-list-current-first .desc')) continue;
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
      const candidates = Array.from(document.querySelectorAll(titleEngine?.remote ? `${titleRegions},${metadataRegions},${categoryRegions},${commentRegions}` : titleRegions));
      const fixedLabels = new Set();
      if (titleEngine?.remote) {
        for (const region of document.querySelectorAll(regions)) {
          if (region.closest(excluded) || region.closest('.writer-login,input,textarea,[contenteditable]')) continue;
          const walker = document.createTreeWalker(region, 4);
          let node;
          while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent || parent.children.length || !/[\u3400-\u9fff]/u.test(node.data)
              || parent.closest(`${titleRegions},${metadataRegions},${categoryRegions},${commentRegions}`)) continue;
            fixedLabels.add(parent);
          }
        }
        candidates.push(...fixedLabels);
        for (const region of fallbackRegions(document)) candidates.push(region);
      }
      const kindOf = region => fixedLabels.has(region) ? 'ui' : region.matches(`${titleRegions},${metadataRegions},${categoryRegions},${commentRegions}`) ? metadataKind(region) : fallbackKind(region);
      // Translate all loaded page content in bounded waves, ordered by kind.
      const priorityOf = region => (visibleTitle(document, region) ? 10 : 20) + contentPriority(kindOf(region));
      if (titleEngine?.remote) {
        candidates.sort((a, b) => priorityOf(a) - priorityOf(b));
      }
      if (titleEngine) for (const region of new Set(candidates)) {
        if (region.closest('script,style,textarea,[contenteditable],.reader-content')) continue;
        const walker = document.createTreeWalker(region, 4), nodes = [];
        const isComment = region.matches(commentRegions);
        let node;
        while ((node = walker.nextNode())) {
          if (isComment && node.parentElement?.closest(commentRegions) !== region) continue;
          if (isComment && node.parentElement?.closest('button,[role="button"],input,textarea,[contenteditable],[class*="comment-author"],[class*="comment-user"],[class*="user-name"],[class*="comment-time"],[class*="comment-action"],[class*="reply-action"]')) continue;
          nodes.push(node);
        }
        if (!nodes.length || nodes.every(n => originals.get(n)?.translated === n.data) && (!titleEngine.remote || remoteTranslated.has(region))) continue;
        const source = nodes.map(n => n.data).join('');
        if (titleEngine.remote) {
          if (!/[\u3400-\u9fff\ue000-\uf8ff]/u.test(source)) continue;
          const kind = kindOf(region);
          if (kind === 'chapter' && !/^\/(?:page|reader)\/\d+\/?$/.test(document.location.pathname)) continue;
          const old = pending.get(region);
          if (old?.source === source && (!old.retryAt || Date.now() < old.retryAt) && old.generation === generation && old.path === document.location.pathname
            && old.nodes.length === nodes.length && old.nodes.every((n, i) => n === nodes[i])) {
            const priority = priorityOf(region);
            if (priority < old.priority) { old.priority = priority; void Promise.resolve(titleEngine.convert(source, titleFont(document, region), kind, priority)).catch(() => {}); }
            continue;
          }
          if (inflight >= 24) continue;
          const priority = priorityOf(region);
          const request = { source, priority, generation, path: document.location.pathname, values: nodes.map(n => n.data), nodes };
          pending.set(region, request);
          inflight++;
          Promise.resolve(titleEngine.convert(source, titleFont(document, region), kind, priority)).then(result => {
            if (!result) request.retryAt = Date.now() + 5000;
            if (!result || pending.get(region) !== request || !enabled || generation !== request.generation
              || document.location.pathname !== request.path || !allowedPath(document.location.pathname)
              || nodes.some((n, i) => !n.isConnected || !region.contains(n) || n.data !== request.values[i])
              || (!isComment && region.textContent !== source)) return;
            nodes.forEach((n, i) => { const translated = i ? '' : result.text; remember(n, n.data, translated); n.data = translated; });
            remoteTranslated.add(region);
            const tooltip = `${result.text}\n${result.source}\nHachimi 40 · ngocdang83 · CC BY 4.0`;
            remember(region, region.getAttribute('title'), tooltip, 'title');
            region.setAttribute('title', tooltip);
          }).catch(() => { /* Failure leaves the original title, never local cache. */ }).finally(() => {
            if (generation === request.generation) inflight--;
            if (enabled && generation === request.generation && !nextApply) nextApply = document.defaultView.setTimeout(() => { nextApply = null; apply(); }, 32);
          });
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
          if (old?.source === source && (!old.retryAt || Date.now() < old.retryAt) && old.generation === generation && old.path === document.location.pathname) continue;
          const priority = (visibleTitle(document, region) ? 10 : 20) + 3;
          const request = { source, priority, generation, path: document.location.pathname, values: nodes.map(n => n.data) };
          pending.set(region, request);
          Promise.resolve().then(() => introductionEngine(source, priority)).then(result => {
            if (!result?.ok || result.source !== source.normalize('NFC').trim() || result.provider !== 'hachimi40'
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
      inflight = 0;
      remoteTranslated = new WeakSet();
      document.defaultView.clearTimeout(nextApply); nextApply = null;
      copyrightLabel?.remove(); copyrightLabel = null;
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
    return { apply, restore, notifyNavigation() {
      generation++;
      inflight = 0;
      pending = new WeakMap();
      remoteTranslated = new WeakSet();
      apply();
    }, setTitleEngine(engine) { restore(); titleEngine = engine; apply(); }, setEnabled(value) { enabled = value === true; if (!enabled) restore(); else apply(); } };
  }

  async function start(document, storage, engineLoader) {
    if (!allowedPath(document.location.pathname) || document.getElementById('stvai-fanqie-ui')) return null;
    const translator = createTranslator(document, null);
    let stopped = false, loading = false, loaded = false, retryAfter = 0, loadGeneration = 0;
    let previewDecoder;
    const loadTitles = () => {
      if (stopped || loading || loaded || language !== 'vi' || Date.now() < retryAfter || !document.querySelector(`${titleRegions},${metadataRegions}`)) return;
      const runtime = document.defaultView.chrome?.runtime;
      const loader = engineLoader || (runtime?.getURL && document.defaultView.fetch
        ? () => titles.loadEngine(runtime, document.defaultView.fetch.bind(document.defaultView), true) : null);
      if (!loader) return;
      loading = true;
      const currentGeneration = loadGeneration;
      const currentProvider = titleProvider;
      host.dataset.titleState = 'loading';
      Promise.resolve().then(loader).then(engine => {
        if (stopped || currentGeneration !== loadGeneration) return;
        previewDecoder = engine;
        if (currentProvider === 'hachimi40' && (storage?.translateText || storage?.translateTitle)) {
          const engineDecoder = engine;
          const cache = new Map();
          const failures = new Map();
          const priorities = new Map();
          engine = { remote: true, convert(source, font, kind = 'title', priority = 0) {
            const decoded = engineDecoder.decode ? engineDecoder.decode(source, font) : engineDecoder.convert(source, font)?.source;
            if (!decoded) return null;
            const key = `${kind}:${decoded}`;
            const failed = failures.get(key);
            if (failed && Date.now() < failed.until) return null;
            if (cache.has(key) && priority < priorities.get(key)) {
              priorities.set(key, priority);
              void Promise.resolve(storage.translateText?.(decoded, kind, priority)).catch(() => {});
            }
            if (!cache.has(key)) {
              priorities.set(key, priority);
              status.textContent = 'Hachimi 40 đang dịch trên máy…';
              const call = storage.translateText ? storage.translateText(decoded, kind, priority) : kind === 'title' ? storage.translateTitle(decoded, priority) : storage.translateIntroduction?.(decoded, priority);
              const request = Promise.resolve(call).then(response => {
                if (!response?.ok || response.provider !== 'hachimi40' || response.source !== decoded) {
                  if (!stopped && currentGeneration === loadGeneration) {
                    status.textContent = failureLabel(response?.reason);
                    host.dataset.titleState = 'unavailable';
                  }
                  return null;
                }
                if (!stopped && currentGeneration === loadGeneration) {
                  status.textContent = `Hachimi 40 · ${response.cacheHit ? 'dùng cache' : 'đã dịch trên máy'}`;
                  if (kind === 'introduction') introStatus.textContent = 'Giới thiệu: Hachimi 40';
                }
                return { source: decoded, text: response.text };
              }).catch(() => { if (!stopped && currentGeneration === loadGeneration) status.textContent = 'Hachimi 40 chưa sẵn sàng; giữ chữ gốc'; return null; });
              cache.set(key, request);
              void request.then(result => {
                if (result) { failures.delete(key); return; }
                // Do not memoize a transport/provider failure as a permanent
                // translation. Back off, then retry only while this page lives.
                cache.delete(key);
                const attempts = (failures.get(key)?.attempts || 0) + 1;
                const delay = Math.min(60000, 5000 * 2 ** Math.min(attempts - 1, 4));
                failures.set(key, { attempts, until: Date.now() + delay });
                document.defaultView.setTimeout(() => {
                  if (!stopped && currentGeneration === loadGeneration) translator.apply();
                }, delay);
              });
              while (cache.size > 512) cache.delete(cache.keys().next().value);
            }
            return cache.get(key);
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
    const failureLabel = reason => {
      const labels = { provider_busy: 'Bộ dịch đang bận', model_timeout: 'Tải/dịch mô hình quá lâu', model_error: 'Mô hình gặp lỗi', provider_unreachable: 'Không kết nối được tab Mặc Hi', provider_ui_changed: 'Giao diện Mặc Hi đã thay đổi', response_receipt_missing: 'Thiếu biên nhận dịch', queue_full: 'Hàng dịch đang đầy', invalid_translation: 'Đầu ra có ký tự lỗi' };
      return `Hachimi 40: ${labels[reason] || 'chưa dịch được'}; giữ chữ gốc`;
    };
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stvai-button stvai-button--primary';
    button.dataset.fanqieAction = 'language';
    const updateButton = () => {
      introStatus.hidden = language !== 'vi';
      button.textContent = language === 'vi' ? 'Tiếng Việt · 中文' : '中文 · Tiếng Việt';
      button.title = 'Dịch toàn bộ nội dung công khai đã tải: giao diện/tag → tên truyện → thể loại → mô tả → tác giả → tên chương → bình luận. Tên chương chỉ dịch khi mở truyện. Rê chuột để xem gốc.';
      providerButton.textContent = 'Hachimi 40 · thử lại phần chưa dịch';
      providerButton.title = 'Dịch trên máy qua tối đa hai tab Mặc Hi chạy nền, không quota API. Dịch cả phần ngoài màn hình đã tải, dùng cache riêng. Giữ nguyên nội dung chương và ô nhập.';
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
      if (titleProvider === 'hachimi40') {
        loadGeneration++; loaded = false; loading = false; retryAfter = 0; translator.setTitleEngine(null);
      }
      translator.setEnabled(language === 'vi'); updateButton(); await persist({ language }); loadTitles();
    });
    providerButton.addEventListener('click', async () => {
      titleProvider = 'hachimi40';
      loadGeneration++; loaded = false; loading = false; retryAfter = 0;
      translator.setTitleEngine(null); updateButton();
      status.textContent = 'Đang kiểm tra lại Hachimi 40…';
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
        status.textContent = 'Hachimi 40 · dịch nhóm và danh mục chương';
        translator.setEnabled(language === 'vi'); updateButton(); loadTitles();
      }
    });
    const preview = previews?.install(document, { loadBook: id => storage?.loadBook?.(id), loadBookIndex: () => storage?.loadBookIndex?.(), loadRankBooks: rank => storage?.loadRankBooks?.(rank), decodeName: (source,node) => previewDecoder?.decode?.(source,titleFont(document,node)) || source, translate: async (source, kind) => {
      if (language !== 'vi') return { text: source };
      if (kind === 'category' && translations.has(source)) return { text: translations.get(source) };
      const response = await storage?.translateText?.(source, kind, 0);
      return response?.ok && response.provider === 'hachimi40' && response.source === source ? { text: response.text } : { reason: response?.ok ? 'response_mismatch' : response?.reason || 'provider_unreachable' };
    } });
    translator.setEnabled(language === 'vi'); updateButton(); void persist();
    status.textContent = 'Hachimi 40 · dịch nhóm và danh mục chương';
    loadTitles();
    let timer;
    let lastPath = document.location.pathname;
    const checkRoute = () => {
      const path = document.location.pathname;
      if (path === lastPath) return;
      lastPath = path;
      preview?.dismiss();
      if (!allowedPath(path)) { translator.restore(); return; }
      translator.notifyNavigation?.();
      loadTitles();
      if (!timer) timer = document.defaultView.setTimeout(() => { timer = null; translator.apply(); }, 120);
    };
    const onRouteEvent = () => checkRoute();
    document.defaultView.addEventListener('popstate', onRouteEvent);
    document.defaultView.addEventListener('hashchange', onRouteEvent);
    const observer = new document.defaultView.MutationObserver(() => {
      if (timer) return;
      timer = document.defaultView.setTimeout(() => {
        timer = null;
        checkRoute();
        if (!allowedPath(document.location.pathname)) translator.restore();
        else { loadTitles(); translator.apply(); }
      }, 80);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder'] });
    const onScroll = () => { loadTitles(); translator.apply(); };
    const onCarouselTransition = event => {
      if (event.target?.closest?.('.byte-carousel,.writer-list-current-first .fix-wrapper')) onScroll();
    };
    document.addEventListener('transitionend', onCarouselTransition, true);
    document.defaultView.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.defaultView.addEventListener('resize', onScroll);
    return { translator, destroy() { stopped = true; preview?.destroy(); unsubscribe?.(); positionController.destroy(); toolbar.finishAnimation(); stylesheet.removeEventListener('load', onStylesLoaded); loadGeneration++; observer.disconnect(); document.removeEventListener('transitionend', onCarouselTransition, true); document.defaultView.removeEventListener('scroll', onScroll, true); document.defaultView.removeEventListener('resize', onScroll); document.defaultView.removeEventListener('popstate', onRouteEvent); document.defaultView.removeEventListener('hashchange', onRouteEvent); document.defaultView.clearTimeout(timer); translator.restore(); host.remove(); } };
  }
  return Object.freeze({ createTranslator, createRuntimeStorage, start, storageKey, allowedPath });
});
