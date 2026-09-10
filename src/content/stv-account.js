(function attachStvAccount(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIStvAccount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createStvAccountApi() {
  'use strict';
  const ACCOUNT_PATH = /^\/@(?:u_)?([1-9]\d{0,39})\/?$/;
  const ZERO_PATH = /^\/@(?:u_)?0\/?$/;
  const ZONES = 'header,nav,#header,#navbar,.header,.navbar,.topbar,[role="navigation"]';
  const normalizeText = value => String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase();

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
    const login = document.querySelector('#loginformdiv,[id*="login" i],a[href*="login" i],button[class*="login" i]');
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

  return Object.freeze({ sample, createResolver, equal });
});
