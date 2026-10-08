(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIProviderTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'stvaiProviderTimelineV1';
  const TTL = 24 * 60 * 60 * 1000;
  const LIMIT = 1024 * 1024;
  const enums = {
    event: ['pool', 'send_start', 'send_end', 'reset_requested', 'reset_completed', 'reset_rejected', 'reset_reconciled', 'probe'],
    state: ['opening', 'preparing', 'recovering', 'ready', 'leased', 'restoring', 'failed', 'retiring', 'spent'],
    stage: ['idle', 'preparing', 'sending', 'waiting_response', 'completed', 'error', 'cancelled'],
    readyStep: ['idle', 'ready_1', 'ready_2', 'ready_3'],
    readyState: ['idle', 'waiting_marker', 'marker_seen', 'grace', 'confirmed', 'failed', 'rechecked_ready', 'rechecking_marker'],
    visibility: ['visible', 'hidden', 'prerender', 'unknown'],
    windowState: ['normal', 'minimized', 'maximized', 'fullscreen', 'unknown'],
    activity: ['progressing', 'responsive_no_progress', 'unreachable', 'unknown'],
    error: ['none', 'other', 'gemini_1095', 'ui_changed', 'provider_busy', 'provider_busy_timeout', 'provider_unreachable', 'send_not_confirmed', 'response_timeout', 'warm_evidence_missing', 'temporary_session_lost', 'temporary_unavailable', 'captcha', 'login_required', 'rate_limited', 'invalid_setup_response', 'gemini_account_probe_failed', 'cancelled'],
    trigger: ['pool_state', 'setup_send', 'batch_send', 'status', 'restart_temporary', 'account_reset', 'liveness', 'session_recovery', 'setup_recheck']
  };
  const numeric = ['at', 'tabId', 'session', 'requestOrdinal', 'generation', 'checkpoint', 'progressAt', 'firstSeenAt', 'acceptedAt', 'errorAt'];
  const booleans = ['focused', 'operationActive', 'errorVisible', 'errorLatched'];
  function sanitize(value) {
    const out = {};
    for (const [key, values] of Object.entries(enums)) {
      if (value?.[key] !== undefined) out[key] = values.includes(value[key]) ? value[key] : (key === 'error' ? 'other' : values.at(-1));
    }
    for (const key of numeric) if (Number.isFinite(value?.[key])) out[key] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value[key])));
    for (const key of booleans) if (typeof value?.[key] === 'boolean') out[key] = value[key];
    return out;
  }
  function trim(rows, at, sanitizeInput = false) {
    const counts = new Map();
    const out = [];
    for (const raw of (Array.isArray(rows) ? rows : []).slice(-5000).reverse()) {
      const row = sanitizeInput ? sanitize(raw) : raw;
      if (!Number.isInteger(row.tabId) || !row.at || row.at > at || at - row.at > TTL) continue;
      const count = counts.get(row.tabId) || 0;
      if (count >= 200) continue;
      counts.set(row.tabId, count + 1); out.push(row);
    }
    out.reverse();
    // All stored strings are fixed ASCII enums; JSON length is its byte size.
    while (JSON.stringify(out).length > LIMIT) out.shift();
    return out;
  }
  const prune = (rows, at) => trim(rows, at, true);
  function create({ read, write, now = Date.now }) {
    let rows;
    let serial = Promise.resolve();
    let queued = 0;
    let dirty = false;
    const signatures = new Map();
    const run = task => {
      const result = serial.then(task);
      serial = result.catch(() => {});
      return result;
    };
    async function load() {
      if (!rows) {
        rows = prune(await read(KEY), now());
        dirty = true;
        for (const row of rows) signatures.set(key(row), signature(row));
      }
      const before = rows.length;
      rows = trim(rows, now());
      if (rows.length !== before) {
        dirty = true; signatures.clear();
        for (const row of rows) signatures.set(key(row), signature(row));
      }
    }
    function signature(row) {
      const { at, ...state } = row;
      return JSON.stringify(state);
    }
    const key = row => `${row.tabId}:${row.event}:${row.trigger}`;
    return {
      append(value) { queued++; return run(async () => {
        queued--;
        await load();
        const row = sanitize({ ...value, at: now() });
        const sig = signature(row);
        if (Number.isInteger(row.tabId) && signatures.get(key(row)) !== sig) {
          rows.push(row); rows = trim(rows, now()); dirty = true;
          signatures.set(key(row), sig);
        }
        if (!queued && dirty) { await write(KEY, rows); dirty = false; }
      }); },
      recent() { return run(async () => {
        await load();
        if (dirty) { await write(KEY, rows); dirty = false; }
        return rows.map(row => ({ ...row }));
      }); }
    };
  }
  function identity(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  }
  return { KEY, TTL, LIMIT, sanitize, prune, create, identity };
});
