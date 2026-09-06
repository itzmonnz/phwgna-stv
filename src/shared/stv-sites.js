(function attachSites(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAISites = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSites() {
  'use strict';

  const ORIGINS = Object.freeze([
    'https://sangtacviet.app', 'https://sangtacviet.com',
    'http://sangtacviet.com', 'http://14.225.254.182'
  ]);

  function siteUrl(value, base) {
    try {
      if (typeof value !== 'string' || !value.trim()) return null;
      const url = new URL(value, base);
      if (!ORIGINS.includes(url.origin) || url.username || url.password || url.port) return null;
      return url;
    } catch (_) { return null; }
  }

  function parseChapter(value, options = {}) {
    const url = siteUrl(value, options.base);
    if (!url || url.search) return null;
    const match = url.pathname.match(/^\/truyen\/([\w-]+)\/(\d+)\/([\w-]+)(?:\/([\w-]+))?\/?$/);
    if (!match) return null;
    const chapterId = match[4] || String(options.chapterId || '');
    if (!/^[\w-]+$/.test(chapterId)) return null;
    url.hash = '';
    return Object.freeze({ origin: url.origin, url: url.href, source: match[1], style: match[2], bookId: match[3], chapterId,
      bookKey: JSON.stringify([match[1], match[2], match[3]]),
      chapterKey: JSON.stringify([match[1], match[2], match[3], chapterId]) });
  }

  function chapterUrl(value, base) {
    return parseChapter(value, { base })?.url || '';
  }

  function nextChapterUrl(value, base) {
    const current = parseChapter(base);
    const next = parseChapter(value, { base });
    if (!current || !next || current.bookKey !== next.bookKey || current.chapterId === next.chapterId) return '';
    return new URL(new URL(next.url).pathname, current.origin).href;
  }

  function zoomProfile(value, base) {
    const url = siteUrl(value, base);
    if (!url) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[0] === "truyen" ? "story" : "general";
  }

  function chapterRoot(document, value = document.URL) {
    const identity = parseChapter(value);
    const roots = Array.from(document.querySelectorAll('#content-container .contentbox[cid]'))
      .filter(node => !node.closest('template,script,style,noscript,[hidden]'));
    if (identity) return roots.find(node => node.getAttribute('cid') === identity.chapterId) || null;
    // Book-scoped sources can expose the current cid only in the DOM. Ambiguity
    // is not permission to use the previous chapter still on the page.
    return roots.length === 1 ? roots[0] : null;
  }

  return Object.freeze({ ORIGINS, siteUrl, parseChapter, chapterUrl, nextChapterUrl, zoomProfile, chapterRoot });
});
