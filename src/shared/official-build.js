(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PhwgnaOfficialBuild = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OFFICIAL_REPOSITORY = "https://github.com/itzmonnz/phwgna-stv";
  const OWNER_FINGERPRINT = "85ac74c199d0a6028bce843d6f68d7632317912b460aad1a7431193767ec9871";

  function shortFingerprint(value) {
    const fingerprint = String(value || "");
    return fingerprint.length > 18
      ? `${fingerprint.slice(0, 12)}…${fingerprint.slice(-6)}`
      : fingerprint;
  }

  function render(documentRef, chromeApi) {
    if (!documentRef) return;
    let version = "—";
    try {
      version = String(chromeApi?.runtime?.getManifest?.()?.version || "—");
    } catch (_error) {
      // Identity remains useful when the runtime API is unavailable in tests/previews.
    }
    for (const node of documentRef.querySelectorAll("[data-phwgna-version]")) {
      node.textContent = version;
    }
    for (const node of documentRef.querySelectorAll("[data-phwgna-fingerprint]")) {
      node.textContent = shortFingerprint(OWNER_FINGERPRINT);
      node.title = OWNER_FINGERPRINT;
    }
    for (const card of documentRef.querySelectorAll("[data-phwgna-official-identity]")) {
      const link = card.querySelector("a");
      if (link) link.href = OFFICIAL_REPOSITORY;
    }
  }

  if (typeof document !== "undefined") {
    const start = () => render(document, typeof chrome !== "undefined" ? chrome : undefined);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }

  return Object.freeze({ OFFICIAL_REPOSITORY, OWNER_FINGERPRINT, shortFingerprint, render });
});
