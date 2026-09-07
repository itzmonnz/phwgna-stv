(function attachPortable(root, factory) {
  const sites = root.STVAISites || (typeof require === 'function' ? require('./stv-sites.js') : null);
  const api = factory(sites);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAINativePortable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createNativePortable(sites) {
  'use strict';

  const STATE_KEY = 'stvai-native-portable-v1';
  const SHARED_NAME_KEY = 'qtOnline0';
  const MAX_KEY_CHARS = 120;
  const MAX_VALUE_CHARS = 512 * 1024;
  const MAX_KEYS = 20;
  const MAX_NATIVE_NAME_KEYS = 500;
  const MAX_TOTAL_CHARS = 2 * 1024 * 1024;
  const MAX_DEPTH = 8;
  const MAX_NODES = 10_000;
  const CATEGORIES = new Set(['nativeNames', 'nativePreferences']);
  const SENSITIVE_NAME = /(?:auth|bearer|cookie|credential|csrf|jwt|login|oauth|pass(?:word)?|refresh|secret|session|token)/i;
  const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
  const OPAQUE_SECRET = /^(?:[a-f0-9]{32,}|[A-Za-z0-9+/_=-]{48,})$/;
  const fail = code => ({ ok: false, code });

  function fingerprint(value) {
    let result = 2166136261;
    for (const character of value) {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619) >>> 0;
    }
    return result.toString(16).padStart(8, '0');
  }

  function inspectStvName(key, raw) {
    if (!/^-?[A-Za-z0-9][A-Za-z0-9_-]{0,79}\d{1,30}$/.test(key) || typeof raw !== 'string') return null;
    if (raw.length > MAX_VALUE_CHARS) return fail('portable_size_limit');
    const rows = raw.split('~//~');
    if (!rows.length || rows.length > 20_000) return fail('portable_complexity_limit');
    let rules = 0;
    for (const row of rows) {
      if (!row) continue;
      if (row.length > 20_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(row)) return fail('portable_invalid_name');
      if (key !== SHARED_NAME_KEY && !row.includes('=') && !row.includes('->')) return null;
      rules++;
    }
    return rules ? { ok: true, key, chars: raw.length, kind: 'stv-name', fields: [],
      shapeFingerprint: fingerprint('stv-name-v1') } : null;
  }

  function parseJson(raw) {
    if (typeof raw !== 'string') return fail('portable_json_required');
    if (raw.length > MAX_VALUE_CHARS) return fail('portable_size_limit');
    let value;
    try { value = JSON.parse(raw); } catch (_) { return fail('portable_json_required'); }
    if (!value || typeof value !== 'object') return fail('portable_json_required');
    return { ok: true, value };
  }

  function inspectValue(value) {
    let nodes = 0;
    const visit = (entry, depth) => {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) return 'portable_complexity_limit';
      if (typeof entry === 'string' && (JWT.test(entry) || OPAQUE_SECRET.test(entry))) return 'portable_sensitive_value';
      if (!entry || typeof entry !== 'object') return '';
      for (const [key, child] of Object.entries(entry)) {
        if (SENSITIVE_NAME.test(key)) return 'portable_sensitive_shape';
        const error = visit(child, depth + 1);
        if (error) return error;
      }
      return '';
    };
    return visit(value, 0);
  }

  function shapeOf(value) {
    const kind = Array.isArray(value) ? 'array' : 'object';
    // Only schema-like ASCII keys are safe to display. Native Name maps often
    // use the actual Chinese names as object keys, which are user data.
    const fields = kind === 'object' ? Object.keys(value)
      .filter(key => /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key)).sort().slice(0, 40) : [];
    const shape = kind === 'array'
      ? `array:${value.length ? typeof value[0] : 'empty'}`
      : `object:${fields.join('|')}`;
    return { kind, fields, shapeFingerprint: fingerprint(shape) };
  }

  function inspectCandidate(key, raw, category) {
    if (typeof key !== 'string' || !key || key.length > MAX_KEY_CHARS || SENSITIVE_NAME.test(key)) {
      return fail('portable_sensitive_key');
    }
    if (category === undefined || category === 'nativeNames') {
      const nativeName = inspectStvName(key, raw);
      if (nativeName) return nativeName;
    }
    const parsed = parseJson(raw);
    if (!parsed.ok) return parsed;
    const unsafe = inspectValue(parsed.value);
    if (unsafe) return fail(unsafe);
    return { ok: true, key, chars: raw.length, ...shapeOf(parsed.value) };
  }

  function emptyState() {
    return { schema: 1, revision: 0, items: {}, mappings: {}, origins: {} };
  }

  function validSecureOrigin(origin) {
    const parsed = sites?.siteUrl?.(`${origin}/`);
    return parsed?.origin === origin && parsed.protocol === 'https:';
  }

  function cloneState(state) {
    return state && state.schema === 1 && state.items && typeof state.items === 'object'
      && state.mappings && typeof state.mappings === 'object'
      && state.origins && typeof state.origins === 'object'
      ? structuredClone(state)
      : emptyState();
  }

  function withoutStoryNames(inputState) {
    const state = cloneState(inputState);
    const removed = [];
    for (const [itemId, item] of Object.entries(state.items)) {
      const keys = Object.values(item?.keysByOrigin || {});
      if (item?.category !== 'nativeNames' || item?.kind !== 'stv-name'
        || keys.includes(SHARED_NAME_KEY)) continue;
      removed.push(itemId);
      delete state.items[itemId];
      for (const origin of Object.keys(state.mappings)) {
        delete state.mappings[origin]?.[itemId];
        delete state.origins[origin]?.last?.[itemId];
        delete state.origins[origin]?.backups?.[itemId];
        delete state.origins[origin]?.pending?.[itemId];
        delete state.origins[origin]?.candidates?.[itemId];
      }
    }
    if (removed.length) state.revision++;
    return { state, changed: removed.length > 0, removed };
  }

  function descriptor(itemId, item) {
    const storageKeys = [...new Set(Object.values(item.keysByOrigin || {}).filter(key => typeof key === 'string'))];
    const sharedName = item.category === 'nativeNames' && storageKeys.includes(SHARED_NAME_KEY);
    const scope = item.category !== 'nativeNames' ? 'setting'
      : sharedName ? 'shared'
        : item.kind === 'stv-name' ? 'story' : 'custom';
    return { itemId, category: item.category, revision: item.revision, keyCount: Object.keys(item.keysByOrigin).length,
      kind: item.kind, fields: [...item.fields], chars: item.raw == null ? 0 : item.raw.length,
      scope, storageKey: sharedName ? SHARED_NAME_KEY : (storageKeys[0] || ''),
      storyTitle: scope === 'story' && typeof item.storyTitle === 'string' ? item.storyTitle : '' };
  }

  function approveCandidate(inputState, candidate) {
    const origin = String(candidate?.origin || '');
    const key = String(candidate?.key || '');
    const category = String(candidate?.category || '');
    if (!validSecureOrigin(origin)) return fail('portable_insecure_origin');
    if (!CATEGORIES.has(category)) return fail('portable_invalid_category');
    const inspected = inspectCandidate(key, candidate?.raw, category);
    if (!inspected.ok) return inspected;
    if (inspected.kind === 'stv-name' && category !== 'nativeNames') return fail('portable_invalid_category');
    const state = cloneState(inputState);
    const itemId = typeof candidate.itemId === 'string' && state.items[candidate.itemId]
      ? candidate.itemId : `${category}:${key}`;
    const existing = state.items[itemId];
    if (existing && (existing.category !== category || existing.shapeFingerprint !== inspected.shapeFingerprint)) {
      return fail('portable_shape_mismatch');
    }
    const categoryCount = Object.values(state.items).filter(item => item?.category === category).length;
    const categoryLimit = category === 'nativeNames' ? MAX_NATIVE_NAME_KEYS : MAX_KEYS;
    if (!existing && categoryCount >= categoryLimit) return fail('portable_key_limit');
    const nextRevision = state.revision + 1;
    state.items[itemId] = existing ? {
      ...existing, keysByOrigin: { ...existing.keysByOrigin, [origin]: key }
    } : {
      category, raw: candidate.raw, revision: nextRevision, deleted: false,
      kind: inspected.kind, fields: inspected.fields, shapeFingerprint: inspected.shapeFingerprint,
      keysByOrigin: { [origin]: key }
    };
    state.mappings[origin] = { ...(state.mappings[origin] || {}), [itemId]: key };
    state.origins[origin] = state.origins[origin] || { initialized: true, last: {}, backups: {}, pending: {} };
    state.origins[origin].initialized = true;
    state.origins[origin].last[itemId] = candidate.raw;
    state.revision = nextRevision;
    const total = Object.values(state.items).reduce((sum, item) => sum + (item.raw?.length || 0), 0);
    if (total > MAX_TOTAL_CHARS) return fail('portable_total_size_limit');
    return { ok: true, state, descriptor: descriptor(itemId, state.items[itemId]) };
  }

  function publicDescriptors(state) {
    if (!state || state.schema !== 1) return [];
    return Object.entries(state.items || {})
      .filter(([, item]) => item?.category !== 'nativeNames' || item?.kind !== 'stv-name'
        || Object.values(item.keysByOrigin || {}).includes(SHARED_NAME_KEY))
      .map(([itemId, item]) => descriptor(itemId, item));
  }

  return Object.freeze({ STATE_KEY, SHARED_NAME_KEY, MAX_KEY_CHARS, MAX_VALUE_CHARS, MAX_KEYS, MAX_NATIVE_NAME_KEYS, MAX_TOTAL_CHARS,
    inspectCandidate, emptyState, approveCandidate, publicDescriptors, validSecureOrigin, withoutStoryNames });
});
