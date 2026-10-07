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
    if (!tabs.length) return null;
    const view = document.defaultView;
    const select = (site, focus = false) => {
      site = ['fanqie','qidian'].includes(site) ? site : 'stv';
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
    for (const site of ['fanqie','qidian']) {
      const form = document.getElementById(site + 'SettingsForm');
      if (!form) continue;
    const status = document.getElementById(site + 'SaveStatus');
    const save = document.getElementById(site + 'SaveButton');
    const fields = {
      language: document.getElementById(site + 'Language'),
      titleProvider: document.getElementById(site + 'TitleProvider'),
      uiScale: document.getElementById(site + 'UiScale'),
      collapsed: document.getElementById(site + 'Collapsed')
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
        const result = await runtime.sendMessage({ type: 'STVAI_' + site.toUpperCase() + '_UI_SET', ...patch });
        if (!result?.ok) throw new Error('save_failed');
        fill(result); dirty.clear(); status.textContent = `Đã lưu. Các tab ${site === 'qidian' ? 'Qidian' : 'Fanqie'} đang mở được áp dụng ngay.`;
      } catch (_) { status.textContent = 'Chưa lưu được. Hãy thử lại; cài đặt STV vẫn được giữ.'; }
      finally {
        saving = false; save.disabled = false;
        for (const field of Object.values(fields)) field.disabled = false;
      }
    });
    save.disabled = true;
    for (const field of Object.values(fields)) field.disabled = true;
    try {
      const result = await runtime.sendMessage({ type: 'STVAI_' + site.toUpperCase() + '_UI_GET' });
      if (!result?.ok) throw new Error('read_failed');
      fill(result); loaded = true; save.disabled = false; status.textContent = 'Sẵn sàng.';
      for (const field of Object.values(fields)) field.disabled = false;
    } catch (_) { status.textContent = `Chưa tải được cài đặt ${site === 'qidian' ? 'Qidian' : 'Fanqie'}. Hãy tải lại trang cài đặt.`; }
    }
    return { select, destroy() { view.removeEventListener('hashchange', onHash); } };
  }
  return Object.freeze({ init });
});
