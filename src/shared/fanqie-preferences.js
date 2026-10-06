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
      titleProvider: value.titleProvider === 'local' ? 'local' : 'mymemory',
      uiScale: scales.includes(Number(value.uiScale)) ? Number(value.uiScale) : 1,
      collapsed: value.collapsed !== false
    };
  }
  function patch(previous, update) {
    const next = normalize(previous);
    for (const key of Object.keys(next)) if (Object.hasOwn(update, key)) next[key] = update[key];
    return normalize(next);
  }
  return Object.freeze({ storageKey, scales, normalize, patch });
});
