(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIFanqiePreferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const storageKey = 'stvai-fanqie-ui-v1';
  const scales = Object.freeze([0.5, 0.75, 1, 1.25, 1.5]);
  function normalize(value = {}) {
    return {
      language: value.language === 'zh' ? 'zh' : 'vi',
      titleProvider: 'hachimi40',
      uiScale: scales.includes(Number(value.uiScale)) ? Number(value.uiScale) : 1,
      collapsed: value.collapsed !== false,
      position: typeof value.position?.x === 'number' && typeof value.position?.y === 'number'
        && Number.isFinite(value.position.x) && Number.isFinite(value.position.y)
        ? { x: Math.max(0, Math.min(1, value.position.x)), y: Math.max(0, Math.min(1, value.position.y)) } : null
    };
  }
  function patch(previous, update) {
    const next = normalize(previous);
    for (const key of Object.keys(next)) if (Object.hasOwn(update, key)) next[key] = update[key];
    return normalize(next);
  }
  return Object.freeze({ storageKey, scales, normalize, patch });
});
