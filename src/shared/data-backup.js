(function attachDataBackup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIDataBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDataBackup() {
  'use strict';
  const FORMAT = 'phwgna-stv-backup';
  const VERSION = 1;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const fail = code => ({ ok: false, code });

  function safeShelf(input) {
    const shelf = { schema: 1, revision: Math.max(0, Number(input?.revision) || 0), entries: {}, order: [], progress: {}, tombstones: {} };
    const entries = input?.entries || {};
    const orderedKeys = [...new Set([...(Array.isArray(input?.order) ? input.order : []), ...Object.keys(entries)])]
      .filter(key => typeof key === 'string' && Object.hasOwn(entries, key));
    for (const key of orderedKeys) {
      const value = entries[key];
      if (value?.record) shelf.entries[key] = { record: structuredClone(value.record) };
    }
    shelf.order = orderedKeys.filter(key => Object.hasOwn(shelf.entries, key));
    for (const [key, value] of Object.entries(input?.progress || {})) {
      if (Object.hasOwn(shelf.entries, key) && /^\d{1,100}$/.test(String(value?.through || ''))) {
        shelf.progress[key] = { through: String(value.through) };
      }
    }
    for (const [key, value] of Object.entries(input?.tombstones || {})) {
      shelf.tombstones[key] = { revision: Math.max(0, Number(value?.revision) || 0) };
    }
    return shelf;
  }

  function portableCategory(input, category) {
    const items = {}, mappings = {};
    for (const [itemId, item] of Object.entries(input?.items || {})) {
      if (item?.category !== category) continue;
      items[itemId] = {
        category, raw: item.deleted ? null : item.raw, deleted: item.deleted === true,
        revision: Math.max(0, Number(item.revision) || 0), kind: item.kind,
        fields: Array.isArray(item.fields) ? [...item.fields] : [], shapeFingerprint: item.shapeFingerprint,
        keysByOrigin: { ...(item.keysByOrigin || {}) }
      };
    }
    for (const [origin, originMappings] of Object.entries(input?.mappings || {})) {
      for (const [itemId, key] of Object.entries(originMappings || {})) {
        if (!items[itemId]) continue;
        mappings[origin] ||= {};
        mappings[origin][itemId] = key;
      }
    }
    return { items, mappings };
  }

  function createPayload(data, generatedAt = Date.now()) {
    return {
      format: FORMAT, version: VERSION, generatedAt,
      tool: { settings: structuredClone(data.settings || {}), ui: structuredClone(data.ui || {}) },
      stv: {
        shelf: safeShelf(data.history),
        nativeNames: portableCategory(data.portable, 'nativeNames'),
        nativePreferences: portableCategory(data.portable, 'nativePreferences')
      }
    };
  }

  function validateShelf(input, history) {
    if (!input || input.schema !== 1 || !input.entries || !input.tombstones) return null;
    const result = { schema: 1, revision: Math.max(0, Number(input.revision) || 0), entries: {}, order: [], progress: {}, tombstones: {}, origins: {} };
    for (const [key, value] of Object.entries(input.entries)) {
      let safe;
      try { safe = history.portable(value?.record); } catch (_) { return null; }
      if (history.key(safe) !== key) return null;
      result.entries[key] = { record: safe, kind: 'backup', rank: 0, order: 0, epoch: 'backup' };
    }
    result.order = [...new Set([...(Array.isArray(input.order) ? input.order : []), ...Object.keys(result.entries)])]
      .filter(key => typeof key === 'string' && Object.hasOwn(result.entries, key));
    for (const [key, value] of Object.entries(input.progress || {})) {
      if (!Object.hasOwn(result.entries, key) || !/^\d{1,100}$/.test(String(value?.through || ''))) return null;
      result.progress[key] = { through: String(value.through) };
    }
    for (const [key, value] of Object.entries(input.tombstones)) {
      let identity;
      try { identity = JSON.parse(key); } catch (_) { return null; }
      if (!Array.isArray(identity) || identity.length !== 2 || !history.id(identity[0]) || !history.id(identity[1])) return null;
      result.tombstones[key] = { revision: Math.max(0, Number(value?.revision) || 0) };
      delete result.entries[key];
      delete result.progress[key];
      result.order = result.order.filter(value => value !== key);
    }
    if (Object.keys(result.entries).length + Object.keys(result.tombstones).length > history.MAX_RECORDS) return null;
    return result;
  }

  function validateStvExport(payload, dependencies) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !payload.name || typeof payload.name !== 'object' || Array.isArray(payload.name)) {
      return fail('backup_invalid_format');
    }
    const parsed = dependencies.history.parse(payload.tusach ?? '');
    if (!parsed.ok) return fail('backup_history_invalid');
    const shelfInput = { schema: 1, revision: 0, entries: {}, order: [], progress: {}, tombstones: {} };
    for (const record of parsed.records) {
      const safe = dependencies.history.portable(record);
      const key = dependencies.history.key(safe);
      shelfInput.entries[key] = { record: safe };
      shelfInput.order.push(key);
    }
    const historyState = validateShelf(shelfInput, dependencies.history);
    if (!historyState) return fail('backup_history_invalid');
    const origins = [...new Set((dependencies.origins || []).filter(origin => dependencies.portable.validSecureOrigin(origin)))];
    if (!origins.length) return fail('backup_portable_invalid');
    let portableState = dependencies.portable.emptyState();
    for (const [key, raw] of Object.entries(payload.name)) {
      const inspected = dependencies.portable.inspectCandidate(key, raw, 'nativeNames');
      if (!inspected.ok || inspected.kind !== 'stv-name') return fail('backup_portable_invalid');
      const itemId = `nativeNames:${key}`;
      for (const origin of origins) {
        const approved = dependencies.portable.approveCandidate(portableState, {
          origin, key, category: 'nativeNames', raw, itemId: portableState.items[itemId] ? itemId : undefined
        });
        if (!approved.ok) return fail('backup_portable_invalid');
        portableState = approved.state;
      }
    }
    for (const origin of Object.keys(portableState.origins)) {
      portableState.origins[origin] = { initialized: false, last: {}, backups: {}, pending: {}, candidates: {} };
    }
    return { ok: true, history: historyState, portable: portableState,
      historyCount: parsed.records.length, nativeNameCount: Object.keys(portableState.items).length };
  }

  function validatePortableCategory(input, category, portable, state) {
    if (!input || typeof input !== 'object' || !input.items || !input.mappings) return false;
    for (const [itemId, item] of Object.entries(input.items)) {
      if (!/^(?:nativeNames|nativePreferences):.{1,120}$/.test(itemId) || item?.category !== category) return false;
      const mappings = Object.entries(input.mappings).flatMap(([origin, values]) => (
        Object.hasOwn(values || {}, itemId) ? [[origin, values[itemId]]] : []));
      if (!mappings.length) return false;
      if (item.deleted === true) {
        if (item.raw !== null || !['array', 'object', 'stv-name'].includes(item.kind)
          || !/^[a-f0-9]{8}$/.test(String(item.shapeFingerprint || ''))) return false;
        state.items[itemId] = { category, raw: null, deleted: true, revision: Math.max(0, Number(item.revision) || 0),
          kind: item.kind, fields: Array.isArray(item.fields) ? item.fields.filter(value => /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)).slice(0, 40) : [],
          shapeFingerprint: item.shapeFingerprint, keysByOrigin: {} };
        for (const [origin, key] of mappings) {
          const probe = item.kind === 'stv-name' ? portable.inspectCandidate(key, '$x=x', 'nativeNames')
            : portable.inspectCandidate(key, '{}', category);
          if (!portable.validSecureOrigin(origin) || !probe.ok || probe.kind !== item.kind) return false;
          state.items[itemId].keysByOrigin[origin] = key;
          state.mappings[origin] ||= {}; state.mappings[origin][itemId] = key;
          state.origins[origin] ||= { initialized: false, last: {}, backups: {}, pending: {} };
        }
        continue;
      }
      let next = state;
      for (const [origin, key] of mappings) {
        const approved = portable.approveCandidate(next, { origin, key, category, raw: item.raw,
          itemId: next.items[itemId] ? itemId : undefined });
        if (!approved.ok) return false;
        next = approved.state;
        if (!state.items[itemId] && approved.descriptor.itemId !== itemId) {
          const generatedId = approved.descriptor.itemId;
          next.items[itemId] = next.items[generatedId]; delete next.items[generatedId];
          for (const values of Object.values(next.mappings)) {
            if (Object.hasOwn(values, generatedId)) { values[itemId] = values[generatedId]; delete values[generatedId]; }
          }
          for (const originState of Object.values(next.origins)) {
            if (Object.hasOwn(originState.last || {}, generatedId)) { originState.last[itemId] = originState.last[generatedId]; delete originState.last[generatedId]; }
          }
        }
      }
      Object.assign(state, next);
    }
    return true;
  }

  function validatePayload(payload, dependencies) {
    if (!payload || payload.format !== FORMAT || payload.version !== VERSION || !payload.tool || !payload.stv) return fail('backup_invalid_format');
    let settings;
    try { settings = dependencies.sanitizeSettings(payload.tool.settings, { strict: true }); }
    catch (_) { return fail('backup_settings_invalid'); }
    const historyState = validateShelf(payload.stv.shelf, dependencies.history);
    if (!historyState) return fail('backup_history_invalid');
    const portableState = dependencies.portable.emptyState();
    if (!validatePortableCategory(payload.stv.nativeNames, 'nativeNames', dependencies.portable, portableState)
      || !validatePortableCategory(payload.stv.nativePreferences, 'nativePreferences', dependencies.portable, portableState)) {
      return fail('backup_portable_invalid');
    }
    for (const origin of Object.keys(portableState.origins)) {
      portableState.origins[origin] = { initialized: false, last: {}, backups: {}, pending: {} };
    }
    return { ok: true, settings, ui: payload.tool.ui && typeof payload.tool.ui === 'object' ? structuredClone(payload.tool.ui) : {},
      history: historyState, portable: portableState, generatedAt: Math.max(0, Number(payload.generatedAt) || 0) };
  }

  function mergeHistory(current, incoming) {
    const state = current?.schema === 1 ? structuredClone(current) : { schema: 1, revision: 0, entries: {}, order: [], progress: {}, tombstones: {}, origins: {} };
    state.entries ||= {}; state.order ||= []; state.progress ||= {}; state.tombstones ||= {}; state.origins ||= {};
    for (const [key, value] of Object.entries(incoming.entries || {})) {
      state.entries[key] = structuredClone(value); delete state.tombstones[key];
    }
    for (const [key, value] of Object.entries(incoming.progress || {})) {
      if (!Object.hasOwn(state.entries, key) || !/^\d{1,100}$/.test(String(value?.through || ''))) continue;
      const local = /^\d{1,100}$/.test(String(state.progress[key]?.through || '')) ? BigInt(state.progress[key].through) : -1n;
      const remote = BigInt(value.through);
      state.progress[key] = { through: String(local >= remote ? local : remote) };
    }
    for (const [key, value] of Object.entries(incoming.tombstones || {})) {
      state.tombstones[key] = structuredClone(value); delete state.entries[key];
      delete state.progress[key];
      state.order = state.order.filter(value => value !== key);
    }
    const incomingOrder = [...new Set([...(Array.isArray(incoming.order) ? incoming.order : []), ...Object.keys(incoming.entries || {})])]
      .filter(key => Object.hasOwn(state.entries, key));
    state.order = [...incomingOrder, ...state.order.filter(key => !incomingOrder.includes(key) && Object.hasOwn(state.entries, key))];
    for (const key of Object.keys(state.entries)) if (!state.order.includes(key)) state.order.push(key);
    state.revision = Math.max(Number(state.revision) || 0, Number(incoming.revision) || 0) + 1;
    return state;
  }

  function mergePortable(current, incoming) {
    const state = current?.schema === 1 ? structuredClone(current) : { schema: 1, revision: 0, items: {}, mappings: {}, origins: {} };
    state.items ||= {}; state.mappings ||= {}; state.origins ||= {};
    for (const [itemId, item] of Object.entries(incoming.items || {})) state.items[itemId] = structuredClone(item);
    for (const [origin, mappings] of Object.entries(incoming.mappings || {})) {
      state.mappings[origin] = { ...(state.mappings[origin] || {}), ...structuredClone(mappings) };
      state.origins[origin] ||= { initialized: false, last: {}, backups: {}, pending: {} };
      state.origins[origin].pending = {};
    }
    state.revision = Math.max(Number(state.revision) || 0, Number(incoming.revision) || 0) + 1;
    return state;
  }

  return Object.freeze({ FORMAT, VERSION, MAX_IMPORT_BYTES, createPayload, validatePayload, validateStvExport,
    mergeHistory, mergePortable });
});
