(function attachStvAccount(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIStvAccount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createStvAccountApi() {
  'use strict';
  const ACCOUNT_PATH = /^\/@(?:u_)?([1-9]\d{0,39})\/?$/;
  const ZERO_PATH = /^\/@(?:u_)?0\/?$/;
  const ZONES = 'header,nav,#header,#navbar,.header,.navbar,.topbar,[role="navigation"],#tm-nav-search-top-right,#shownbtnctn';
  const normalizeText = value => String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd');

  function safePath(anchor, location) {
    try {
      const url = new URL(anchor.getAttribute('href') || '', location.href);
      return url.origin === location.origin ? url.pathname : '';
    } catch (_) { return ''; }
  }

  function accountZone(anchor) {
    if (anchor.closest?.(ZONES)) return true;
    for (let node = anchor.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const semantic = normalizeText([node.id, node.className, node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'), node.getAttribute?.('role')].join(' '));
      if (/\b(account|profile|avatar|user|tai khoan|thong tin ca nhan|dang xuat)\b/.test(semantic)) return true;
    }
    return false;
  }

  function beforeContent(node, document) {
    const content = document.getElementById('inner');
    return Boolean(content && (node.compareDocumentPosition(content) & 4));
  }

  function inspect(document) {
    const location = document?.defaultView?.location;
    if (!document || !location) return { profileLinks: 0, trustedProfileLinks: 0, beforeContentProfileLinks: 0,
      exactProfileLinks: 0, slugProfileLinks: 0, accountAttributeSignals: 0, logoutSignals: 0, knownSlotCount: 0 };
    const result = { profileLinks: 0, trustedProfileLinks: 0, beforeContentProfileLinks: 0,
      exactProfileLinks: 0, slugProfileLinks: 0, accountAttributeSignals: 0, logoutSignals: 0,
      knownSlotCount: document.querySelectorAll('#tm-nav-search-top-right,#shownbtnctn').length };
    for (const anchor of document.querySelectorAll('a[href]')) {
      const path = safePath(anchor, location);
      if (!/^\/@[^/?#]{1,80}\/?$/.test(path)) continue;
      result.profileLinks++;
      if (accountZone(anchor)) result.trustedProfileLinks++;
      if (beforeContent(anchor, document)) result.beforeContentProfileLinks++;
      if (ACCOUNT_PATH.test(path) || ZERO_PATH.test(path)) result.exactProfileLinks++;
      else result.slugProfileLinks++;
    }
    const signals = document.querySelectorAll('[data-user-id],[data-userid],[data-uid],[userid],[uid],[onclick]');
    for (const node of signals) {
      if (!accountZone(node) && !beforeContent(node, document)) continue;
      if (node.hasAttribute('data-user-id') || node.hasAttribute('data-userid') || node.hasAttribute('data-uid')
        || node.hasAttribute('userid') || node.hasAttribute('uid')) result.accountAttributeSignals++;
      if (/\b(dang xuat|logout)\b/.test(normalizeText(node.textContent))) result.logoutSignals++;
    }
    return result;
  }

  function sample(document) {
    const location = document?.defaultView?.location;
    if (!document || !location) return { status: 'unknown' };
    const ids = new Set();
    let zero = false;
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (!accountZone(anchor)) continue;
      const path = safePath(anchor, location);
      const match = ACCOUNT_PATH.exec(path);
      if (match) ids.add(match[1]);
      else if (ZERO_PATH.test(path)) zero = true;
    }
    if (ids.size === 1 && !zero) return { status: 'account', id: [...ids][0] };
    if (ids.size > 1 || (ids.size && zero)) return { status: 'ambiguous' };
    const login = [...document.querySelectorAll('#loginformdiv,[id*="login" i],a[href*="login" i],button[class*="login" i],[onclick*="openloginmodal" i]')]
      .some(node => accountZone(node));
    if (zero || login) return { status: 'guest' };
    return { status: document.readyState === 'loading' ? 'pending' : 'unknown' };
  }

  function createResolver(document) {
    let previous = '', repeats = 0, stable = { status: 'pending' };
    return function resolve() {
      const next = sample(document);
      const signature = next.status === 'account' ? `account:${next.id}` : next.status;
      if (signature === previous) repeats++; else { previous = signature; repeats = 1; }
      if (next.status === 'ambiguous' || next.status === 'unknown') return { status: next.status };
      if (repeats < 2) return { status: 'pending' };
      stable = next;
      return { ...stable };
    };
  }

  function equal(left, right) {
    return left?.status === right?.status && (left?.status !== 'account' || left.id === right.id);
  }

  return Object.freeze({ sample, createResolver, equal, inspect });
});
