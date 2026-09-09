if (typeof importScripts === "function") {
  importScripts("shared/distribution-channel.js");
  const backgroundImports = [
    "background/contracts.js",
    "background/tts-session-service.js",
    "background/client-service.js",
    "background/translation-job-service.js",
    "background/provider-pool-service.js",
    "background/message-router.js",
    "shared/stv-sites.js",
    "shared/native-history.js",
    "shared/history-sync.js",
    "shared/native-portable.js",
    "shared/portable-sync.js",
    "shared/core.js",
    "shared/tts-pronunciation.js",
    "shared/cache.js",
    "shared/name-preview.js",
    "shared/api-providers.js"
  ];
  if (globalThis.STVAIDistribution?.usesExternalUpdater?.() !== false) {
    backgroundImports.push("shared/update-check.js");
  }
  backgroundImports.push("shared/onboarding.js", "shared/error-journal.js", "background/controller.js");
  importScripts(...backgroundImports);
}

(function attachBackgroundBootstrap(root) {
  "use strict";
  const controllerApi = root.STVAIBackgroundController
    || (typeof require === "function" ? require("./background/controller.js") : null);
  if (typeof module === "object" && module.exports) module.exports = controllerApi;
  root.STVAIBackground = controllerApi;

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.tabs && typeof indexedDB !== "undefined") {
    controllerApi.registerServiceWorker(chrome, root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
