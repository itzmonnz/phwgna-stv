(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(root.document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function install(document) {
    const apply = () => {
      for (const node of [document.documentElement, document.body]) if (node) {
        if (node.getAttribute('translate') !== 'no') node.setAttribute('translate', 'no');
        if (!node.classList.contains('notranslate')) node.classList.add('notranslate');
      }
      if (document.head && !document.head.querySelector('meta[name="google"][content="notranslate"]')) {
        const meta = document.createElement('meta');
        meta.name = 'google'; meta.content = 'notranslate'; document.head.append(meta);
      }
    };
    apply();
    const observer = new document.defaultView.MutationObserver(apply);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['translate', 'class'] });
    return () => observer.disconnect();
  }
  return { install };
});
