(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root.chrome?.runtime?.onMessage && root.document) api.install(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const sidebarsOpenedByProbe = new WeakSet();

  function openCollapsedSidebar(document) {
    const controls = [...document.querySelectorAll("button")];
    const toggle = controls.find(button => {
      const label = String(button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
      return /^(?:Mở thanh bên|Open sidebar|Expand sidebar|Show navigation)$/i.test(label)
        && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    });
    if (!toggle) return false;
    sidebarsOpenedByProbe.add(document);
    toggle.click();
    return true;
  }

  function restoreSidebar(document) {
    if (!sidebarsOpenedByProbe.has(document)) return false;
    const controls = [...document.querySelectorAll("button")];
    const toggle = controls.find(button => {
      const label = String(button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
      return /^(?:\u0110\u00f3ng thanh b\u00ean|Close sidebar|Collapse sidebar|Hide navigation)$/i.test(label)
        && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    });
    sidebarsOpenedByProbe.delete(document);
    if (!toggle) return false;
    toggle.click();
    return true;
  }

  // Read only account controls. Personal labels never cross the page boundary.
  async function readAccountDom(document, location, crypto) {
    const digest = async value => [...new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(String(value).trim().toLowerCase())
    ))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (location.origin === "https://accounts.google.com" && location.pathname === "/SignOutOptions") {
      const rows = await Promise.all([...document.querySelectorAll('button[name="Email"]')].map(async button => {
        const index = Number(button.id.match(/\d+$/)?.[0] ?? -1);
        return { index, key: await digest(button.value) };
      }));
      return { kind: "chooser", rows };
    }
    if (location.origin !== "https://gemini.google.com") return { kind: "blocked" };
    const avatar = document.querySelector("a.mavatar-footer-left");
    const email = String(avatar?.getAttribute("aria-label") || "").match(/[^\s()]+@[^\s()]+/)?.[0];
    const tierElement = document.querySelector(".mavatar-tier-label");
    // Gemini removes the paid-tier label from the DOM while its sidebar is
    // collapsed. Account rotation used to interpret that missing label as a
    // Free account and reject every signed-in Pro account before Temporary
    // Chat could start. Open the existing sidebar once and let the background
    // probe retry after Gemini renders the trusted account controls.
    if (!tierElement && openCollapsedSidebar(document)) return { kind: "loading" };
    const tier = String(tierElement?.textContent || "").trim();
    const chooser = avatar?.getAttribute("href");
    let chooserUrl = "";
    try {
      const url = new URL(chooser, location.href);
      if (url.origin === "https://accounts.google.com" && url.pathname === "/SignOutOptions") {
        // Retain only the observed, fixed Gemini continuation, never tokens.
        chooserUrl = "https://accounts.google.com/SignOutOptions?continue=https://gemini.google.com";
      }
    } catch (_) { /* incomplete page */ }
    const snapshot = {
      kind: avatar && email ? "gemini" : "loading",
      key: email ? await digest(email) : "",
      paid: /^(?:Pro|Ultra|Advanced|Google AI Pro|Google AI Ultra)$/i.test(tier),
      index: Number(location.pathname.match(/^\/u\/(\d+)\//)?.[1] || 0),
      busy: Boolean(document.querySelector('button[aria-label*="Stop"],button[aria-label*="Dừng"]')),
      chooserUrl
    };
    restoreSidebar(document);
    return snapshot;
  }

  function install(root) {
    // Top-level account controls only; never sign-in forms or account settings.
    if (root.top !== root || !(root.location.origin === "https://gemini.google.com"
      || (root.location.origin === "https://accounts.google.com" && root.location.pathname === "/SignOutOptions"))) return;
    root.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== "STVAI_GEMINI_ACCOUNT_SNAPSHOT" || sender.id !== root.chrome.runtime.id) return;
      readAccountDom(root.document, root.location, root.crypto).then(
        snapshot => sendResponse({ ok: true, snapshot }),
        () => sendResponse({ ok: false, error: { code: "gemini_account_probe_failed" } })
      );
      return true;
    });
  }
  return Object.freeze({ readAccountDom, openCollapsedSidebar, restoreSidebar, install });
});
