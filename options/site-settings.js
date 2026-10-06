(function (root, factory) {
  const preferences = root.STVAIFanqiePreferences || (typeof require === 'function' ? require('../src/shared/fanqie-preferences.js') : null);
  const api = factory(preferences);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document && root.chrome?.runtime) root.document.addEventListener('DOMContentLoaded', () => {
    void api.init(root.document, root.chrome.runtime);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (preferences) {
  'use strict';
  async function init(document, runtime) {
    const tabs = [...document.querySelectorAll('[data-settings-site]')];
    const form = document.getElementById('fanqieSettingsForm');
    if (!tabs.length || !form) return null;
    const view = document.defaultView;
    const select = (site, focus = false) => {
      site = site === 'fanqie' ? 'fanqie' : 'stv';
      for (const tab of tabs) {
        const selected = tab.dataset.settingsSite === site;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
        document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
        if (selected && focus) tab.focus();
      }
    };
    const onHash = () => select(view.location.hash.slice(1));
    view.addEventListener('hashchange', onHash); onHash();
    for (const tab of tabs) {
      const activate = () => { view.history.replaceState(null, '', '#' + tab.dataset.settingsSite); select(tab.dataset.settingsSite, true); };
      tab.addEventListener('click', activate);
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[index].click();
      });
    }
    const status = document.getElementById('fanqieSaveStatus');
    const save = document.getElementById('fanqieSaveButton');
    const fields = {
      language: document.getElementById('fanqieLanguage'),
      titleProvider: document.getElementById('fanqieTitleProvider'),
      uiScale: document.getElementById('fanqieUiScale'),
      collapsed: document.getElementById('fanqieCollapsed')
    };
    const dirty = new Set(); let loaded = false, saving = false;
    function fill(value) {
      const pref = preferences.normalize(value);
      for (const [key, field] of Object.entries(fields)) {
        if (key === 'collapsed') field.checked = pref[key]; else field.value = String(pref[key]);
      }
    }
    for (const [key, field] of Object.entries(fields)) field.addEventListener('change', () => {
      dirty.add(key); status.textContent = 'Có thay đổi chưa lưu.';
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!loaded || saving) return;
      const patch = {};
      for (const key of dirty) patch[key] = key === 'collapsed' ? fields[key].checked : fields[key].value;
      saving = true; save.disabled = true; status.textContent = 'Đang lưu…';
      for (const field of Object.values(fields)) field.disabled = true;
      try {
        const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_UI_SET', ...patch });
        if (!result?.ok) throw new Error('save_failed');
        fill(result); dirty.clear(); status.textContent = 'Đã lưu. Các tab Fanqie đang mở được áp dụng ngay.';
      } catch (_) { status.textContent = 'Chưa lưu được. Hãy thử lại; cài đặt STV vẫn được giữ.'; }
      finally {
        saving = false; save.disabled = false;
        for (const field of Object.values(fields)) field.disabled = false;
      }
    });
    save.disabled = true;
    for (const field of Object.values(fields)) field.disabled = true;
    try {
      const result = await runtime.sendMessage({ type: 'STVAI_FANQIE_UI_GET' });
      if (!result?.ok) throw new Error('read_failed');
      fill(result); loaded = true; save.disabled = false; status.textContent = 'Sẵn sàng.';
      for (const field of Object.values(fields)) field.disabled = false;
    } catch (_) { status.textContent = 'Chưa tải được cài đặt Fanqie. Hãy tải lại trang cài đặt.'; }
    return { select, destroy() { view.removeEventListener('hashchange', onHash); } };
  }
  return Object.freeze({ init });
});
