(function attachDistributionChannel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIDistribution = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDistributionChannel() {
  "use strict";

  const CHANNEL = "direct";
  const SITE_ROOT = "https://itzmonnz.github.io/phwgna-stv/";
  const TOOLS_URL = "https://github.com/itzmonnz/phwgna-stv/releases";

  function usesExternalUpdater() {
    return CHANNEL !== "web-store";
  }

  return Object.freeze({ CHANNEL, SITE_ROOT, TOOLS_URL, usesExternalUpdater });
});
