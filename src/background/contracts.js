(function attachBackgroundContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIBackgroundContracts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundContracts() {
  "use strict";

  const SETUP_PARTS = Object.freeze(["introduction", "system", "names"]);
  const PROVIDER_URLS = Object.freeze({
    chatgpt: "https://chatgpt.com/",
    gemini: "https://gemini.google.com/app"
  });
  const JOB_STORAGE_PREFIX = "stvai-active-job:";
  const POOL_STORAGE_KEY = "stvai-warm-pool";
  const OWNED_TABS_STORAGE_KEY = "stvai-owned-provider-tabs";
  const DOM_PROFILES_STORAGE_KEY = "stvaiDomProfilesV1";
  const CHATGPT_DOM_PROFILES_STORAGE_KEY = "stvaiChatGPTDomProfilesV1";
  const DEVELOPER_KEEP_TABS_KEY = "developerKeepAiTabs";
  const TTS_SESSION_PREFIX = "stvai-tts-session:";
  const AUTOMATION_CONSENT_VERSION = 2;
  const MIN_POOL_TABS = 2;
  const MAX_POOL_TABS = 5;
  const READY_TIMEOUT_MS = 30_000;
  const CHATGPT_READY_TIMEOUT_MS = 13_000;
  const READY_SEND_TIMEOUT_MS = 5_000;
  const CHATGPT_READY_SEND_TIMEOUT_MS = 8_000;
  const CHATGPT_SETUP_INACTIVITY_MS = 30_000;
  const CHATGPT_SETUP_HARD_TIMEOUT_MS = 60_000;
  const READY_MARKER_GRACE_MS = 2_000;
  const MAX_WARM_REPLACEMENTS = 2;
  const PERFORMANCE_HEARTBEAT_MS = 2_000;
  const JOB_RECORD_VERSION = 2;
  const POOL_RECORD_VERSION = 5;
  const OWNED_TABS_RECORD_VERSION = 1;
  const DOM_PROFILE_RECORD_VERSION = 1;
  const AUTHENTICATION_BLOCKERS = new Set([
    "login_required", "login_window_open", "captcha", "security_verification", "login_browser_rejected"
  ]);
  const REPLACEABLE_WARM_FAILURES = new Set([
    "content_refused", "ui_changed", "temporary_unavailable", "provider_unreachable",
    "provider_tab_failed", "warm_evidence_missing", "invalid_setup_response",
    "send_not_confirmed", "response_timeout"
  ]);
  const DOM_PROFILE_ROLES = new Set([
    "composer", "send", "stop", "response", "completion", "temporaryLauncher", "temporaryActive"
  ]);

  function sanitizeDomProfileStore(value) {
    if (!value || value.schemaVersion !== DOM_PROFILE_RECORD_VERSION || !Array.isArray(value.profiles)) return null;
    const profiles = [];
    const ids = new Set();
    for (const input of value.profiles.slice(0, 5)) {
      const id = /^[a-z0-9_-]{1,80}$/i.test(String(input?.id || "")) ? String(input.id) : "";
      if (!id || ids.has(id) || input?.schemaVersion !== DOM_PROFILE_RECORD_VERSION) continue;
      const descriptors = {};
      for (const [role, raw] of Object.entries(input.descriptors || {})) {
        if (!DOM_PROFILE_ROLES.has(role) || !raw || typeof raw !== "object") continue;
        const tag = /^[a-z0-9-]{1,40}$/i.test(String(raw.tag || "")) ? String(raw.tag).toLowerCase() : "";
        if (!tag) continue;
        const descriptor = { tag };
        if (/^[a-z0-9_-]{1,40}$/i.test(String(raw.role || ""))) descriptor.role = String(raw.role).toLowerCase();
        if (typeof raw.contenteditable === "boolean") descriptor.contenteditable = raw.contenteditable;
        if (/^[a-z0-9_-]{1,24}$/i.test(String(raw.type || ""))) descriptor.type = String(raw.type).toLowerCase();
        if (/^[\p{L}\p{N} _-]{1,40}$/u.test(String(raw.semantic || ""))) descriptor.semantic = String(raw.semantic).toLowerCase();
        for (const field of ["classes", "parentClasses"]) {
          if (Array.isArray(raw[field])) descriptor[field] = raw[field].filter(item => (
            typeof item === "string" && /^[a-z0-9_-]{1,80}$/i.test(item)
          )).slice(0, 8);
        }
        if (/^[a-z0-9-]{1,40}$/i.test(String(raw.parentTag || ""))) descriptor.parentTag = String(raw.parentTag).toLowerCase();
        descriptors[role] = descriptor;
      }
      if (!Object.keys(descriptors).length) continue;
      ids.add(id);
      profiles.push({
        id,
        schemaVersion: DOM_PROFILE_RECORD_VERSION,
        updatedAt: Math.max(0, Number(input.updatedAt) || 0),
        descriptors
      });
    }
    return { schemaVersion: DOM_PROFILE_RECORD_VERSION, profiles };
  }

  function isAuthenticationBlocker(code) {
    return AUTHENTICATION_BLOCKERS.has(String(code || ""));
  }

  function batchIdAt(index) {
    return `B${String(index + 1).padStart(4, "0")}`;
  }

  function cachedConvertText(value) {
    return String(value || "")
      .replace(/\s*\(h\u1ebft ch\u01b0\u01a1ng\)\s*$/iu, "")
      .trim();
  }

  function exactItems(items, blocks) {
    if (!Array.isArray(items) || items.length !== blocks.length) return false;
    return blocks.every((block, index) => (
      items[index]
      && String(items[index].id) === block.id
      && typeof items[index].text === "string"
      && items[index].text.trim().length > 0
      && (items[index].origin !== "convert"
        || cachedConvertText(items[index].text) === String(block.convert || "").trim())
    ));
  }

  return Object.freeze({
    SETUP_PARTS,
    PROVIDER_URLS,
    JOB_STORAGE_PREFIX,
    POOL_STORAGE_KEY,
    OWNED_TABS_STORAGE_KEY,
    DOM_PROFILES_STORAGE_KEY,
    CHATGPT_DOM_PROFILES_STORAGE_KEY,
    DEVELOPER_KEEP_TABS_KEY,
    TTS_SESSION_PREFIX,
    AUTOMATION_CONSENT_VERSION,
    MIN_POOL_TABS,
    MAX_POOL_TABS,
    READY_TIMEOUT_MS,
    CHATGPT_READY_TIMEOUT_MS,
    READY_SEND_TIMEOUT_MS,
    CHATGPT_READY_SEND_TIMEOUT_MS,
    CHATGPT_SETUP_INACTIVITY_MS,
    CHATGPT_SETUP_HARD_TIMEOUT_MS,
    READY_MARKER_GRACE_MS,
    MAX_WARM_REPLACEMENTS,
    PERFORMANCE_HEARTBEAT_MS,
    JOB_RECORD_VERSION,
    POOL_RECORD_VERSION,
    OWNED_TABS_RECORD_VERSION,
    DOM_PROFILE_RECORD_VERSION,
    AUTHENTICATION_BLOCKERS,
    REPLACEABLE_WARM_FAILURES,
    DOM_PROFILE_ROLES,
    sanitizeDomProfileStore,
    isAuthenticationBlocker,
    batchIdAt,
    cachedConvertText,
    exactItems
  });
});
