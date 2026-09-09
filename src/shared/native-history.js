(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAINativeHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_LENGTH = 1_000_000;
  const MAX_RECORDS = 2000;
  // Append new origins so persisted legacy ranks keep their original meaning.
  const PRIORITY = ['https://sangtacviet.com', 'http://sangtacviet.com', 'https://sangtacviet.app', 'http://14.225.254.182', 'https://sangtacviet.vip'];
  const key = record => JSON.stringify([String(record.host), String(record.id)]);
  function id(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
    return /^(?:[\w-]{1,100})$/.test(String(value ?? '')) ? String(value) : '';
  }
  function current(value) {
    if (typeof value !== 'string' || value.length > 5000) return null;
    const parts = value.split('-,-');
    return parts.length === 2 && id(parts[0]) ? { chapterId: parts[0], title: parts[1] } : null;
  }
  function parse(raw) {
    if (raw == null || raw === '') return { ok: true, records: [], chunks: [] };
    if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return { ok: false, code: 'history_size_limit' };
    try {
      const chunks = raw.split('~/~');
      if (chunks.length > MAX_RECORDS) return { ok: false, code: 'history_size_limit' };
      const records = chunks.map(JSON.parse);
      const keys = new Set();
      for (const entry of records) {
        if (!entry || Array.isArray(entry) || !id(entry.host) || !id(entry.id)
          || !current(entry.current) || typeof entry.name !== 'string' || entry.name.length > 2000
          || keys.has(key(entry))) return { ok: false, code: 'history_invalid_data' };
        keys.add(key(entry));
      }
      return { ok: true, records, chunks };
    } catch (_) { return { ok: false, code: 'history_invalid_data' }; }
  }
  // Native STV renders labels as HTML in some menus. Escape once at the
  // cross-origin boundary; never copy thumbnail URLs or arbitrary metadata.
  function safeLabel(value) {
    return value.replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function portable(record) {
    const parsed = parse(JSON.stringify(record));
    if (!parsed.ok) throw new Error(parsed.code);
    const position = current(record.current);
    return { host: id(record.host), id: id(record.id), name: safeLabel(record.name), thumb: '', chapter: 0,
      current: `${position.chapterId}-,-${safeLabel(position.title)}` };
  }
  function removeKeys(raw, keys) {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(parsed.code);
    const blocked = keys instanceof Set ? keys : new Set(keys || []);
    const result = parsed.chunks.filter((_chunk, index) => !blocked.has(key(parsed.records[index]))).join('~/~');
    if (!parse(result).ok) throw new Error('history_invalid_data');
    return result;
  }
  function mergeRaw(raw, updates) {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(parsed.code);
    if (!updates.length) return raw || '';
    const local = new Map(parsed.records.map((entry, index) => [key(entry), { entry, chunk: parsed.chunks[index] }]));
    const used = new Set(), chunks = [];
    // Shared records arrive in canonical recent-reading order. Rebuild that
    // portion in exactly that order while retaining each origin's safe native
    // metadata. Origin-only unread bookmarks follow in their original order.
    for (const record of updates) {
      const safe = portable(record), identity = key(safe);
      if (used.has(identity)) continue;
      used.add(identity);
      const found = local.get(identity);
      chunks.push(found
        ? (safe.current !== found.entry.current ? JSON.stringify({ ...found.entry, current: safe.current }) : found.chunk)
        : JSON.stringify(safe));
    }
    for (let index = 0; index < parsed.records.length; index++) {
      if (!used.has(key(parsed.records[index]))) chunks.push(parsed.chunks[index]);
    }
    const result = chunks.join('~/~');
    if (!parse(result).ok) throw new Error('history_size_limit');
    return result;
  }
  return Object.freeze({ parse, portable, removeKeys, mergeRaw, key, id, current, PRIORITY, MAX_LENGTH, MAX_RECORDS });
});
