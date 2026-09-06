(function attachBranding(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.STVAIBranding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBrandingApi(root) {
  "use strict";

  const ICON_PATH = "assets/icons/phwgna-cat-128.png";

  function iconUrl() {
    try {
      if (typeof root.chrome?.runtime?.getURL === "function") {
        return root.chrome.runtime.getURL(ICON_PATH);
      }
    } catch (_error) {
      // Tests and non-extension previews use the stable relative asset path.
    }
    return ICON_PATH;
  }

  function createIcon(document, className = "stvai-brand-icon") {
    const image = document.createElement("img");
    image.className = className;
    image.src = iconUrl();
    image.alt = "";
    image.draggable = false;
    image.setAttribute("aria-hidden", "true");
    image.setAttribute("decoding", "async");
    return image;
  }

  return Object.freeze({ ICON_PATH, iconUrl, createIcon });
});
