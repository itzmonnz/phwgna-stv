(function attachGeminiDomResolver(root, factory) {
  const common = root.STVAIProviderCommon
    || (typeof require === "function" ? require("./provider-common.js") : null);
  const api = factory(common);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIGeminiDomResolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createResolverModule(common) {
  "use strict";

  const PROFILE_SCHEMA_VERSION = 1;
  const PROFILE_STORAGE_KEY = "stvaiDomProfilesV1";
  const MAX_LOCAL_PROFILES = 5;
  const ROLES = Object.freeze([
    "composer", "send", "stop", "response", "completion", "temporaryLauncher", "temporaryActive"
  ]);
  const CONTROL_WORDS = /send|gửi|stop|dừng|temporary|tạm thời|chat|trò chuyện|prompt|message|tin nhắn/i;
  const STABLE_CLASS_WORDS = /send|stop|temp|chat|prompt|composer|response|footer|markdown|editor|textarea/i;
  const BUNDLED_SELECTORS = Object.freeze({
    composer: [
      ".ql-editor[contenteditable='true']",
      "rich-textarea [contenteditable='true']",
      "[contenteditable='true'][role='textbox']"
    ],
    send: ["button[aria-label='Send message']", "button[aria-label^='Send']", "button[aria-label^='Gửi' i]"],
    stop: ["button[aria-label^='Stop' i]", "button[aria-label^='Dừng' i]", "button[aria-label*='stop response' i]"],
    response: ["model-response"],
    completion: ["model-response .response-footer", "model-response .response-actions"],
    temporaryLauncher: [
      "[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-button:not(.temp-chat-on) button",
      "gem-icon-button.temp-chat-button:not(.temp-chat-on) button",
      "side-nav-sparkle-button > button[data-test-id='side-nav-sparkle-button']"
    ],
    temporaryActive: [
      "chat-window.is-temporary-chat",
      "[data-test-id='temp-chat-button-container'] gem-icon-button.temp-chat-on",
      "gem-icon-button.temp-chat-on"
    ]
  });

  function safeClassTokens(element) {
    const value = typeof element?.className === "string" ? element.className : "";
    return value.split(/\s+/).filter(token => token && token.length <= 80 && STABLE_CLASS_WORDS.test(token)).slice(0, 8);
  }

  function composedParent(element) {
    return element?.parentElement || element?.getRootNode?.()?.host || null;
  }

  function collectElements(document, limit = 2_000) {
    const output = [];
    const seen = new Set();
    function visit(element) {
      if (!element || seen.has(element) || output.length >= limit) return;
      seen.add(element);
      output.push(element);
      if (element.shadowRoot) for (const child of element.shadowRoot.children) visit(child);
      for (const child of element.children || []) visit(child);
    }
    visit(document.documentElement);
    return output;
  }

  function countBucket(value) {
    if (!value) return "0";
    if (value === 1) return "1";
    return value <= 5 ? "2-5" : "6+";
  }

  function confidenceFor(score, highThreshold) {
    if (score >= highThreshold) return "high";
    if (score >= Math.max(40, highThreshold - 25)) return "medium";
    return "low";
  }

  function commonAncestorNear(first, second, maxDepth = 6) {
    if (!first || !second) return false;
    const ancestors = new Set();
    let current = first;
    for (let depth = 0; current && depth <= maxDepth; depth += 1, current = composedParent(current)) {
      if (!/^(?:html|body)$/i.test(current.localName || "")) ancestors.add(current);
    }
    current = second;
    for (let depth = 0; current && depth <= maxDepth; depth += 1, current = composedParent(current)) {
      if (ancestors.has(current)) return true;
    }
    if (first.getRootNode?.() !== second.getRootNode?.()) return false;
    current = second;
    for (let step = 0; current && step < maxDepth; step += 1) {
      current = current.nextElementSibling;
      if (current === first || current?.contains?.(first)) return true;
    }
    return false;
  }

  function semanticText(element) {
    return [
      element?.getAttribute?.("aria-label"), element?.getAttribute?.("title"),
      element?.getAttribute?.("data-testid"), element?.getAttribute?.("data-test-id"),
      safeClassTokens(element).join(" ")
    ].filter(Boolean).join(" ");
  }

  function buildDescriptor(element) {
    if (!element) return null;
    const parent = composedParent(element);
    const semantic = semanticText(element).toLocaleLowerCase("vi");
    return {
      tag: String(element.localName || "").toLowerCase().slice(0, 40),
      role: String(element.getAttribute?.("role") || "").toLowerCase().slice(0, 40),
      contenteditable: element.getAttribute?.("contenteditable") === "true",
      type: String(element.getAttribute?.("type") || "").toLowerCase().slice(0, 24),
      semantic: CONTROL_WORDS.test(semantic) ? semantic.match(CONTROL_WORDS)?.[0]?.toLowerCase() || "control" : "",
      classes: safeClassTokens(element),
      parentTag: String(parent?.localName || "").toLowerCase().slice(0, 40),
      parentClasses: safeClassTokens(parent)
    };
  }

  function sanitizeDescriptor(value) {
    if (!value || typeof value !== "object") return null;
    const descriptor = {
      tag: /^[a-z0-9-]{1,40}$/i.test(String(value.tag || "")) ? String(value.tag).toLowerCase() : "",
      role: /^[a-z0-9_-]{0,40}$/i.test(String(value.role || "")) ? String(value.role).toLowerCase() : "",
      contenteditable: value.contenteditable === true,
      type: /^[a-z0-9_-]{0,24}$/i.test(String(value.type || "")) ? String(value.type).toLowerCase() : "",
      semantic: CONTROL_WORDS.test(String(value.semantic || "")) ? String(value.semantic).toLowerCase().slice(0, 40) : "",
      classes: Array.isArray(value.classes) ? value.classes.filter(item => (
        typeof item === "string" && item.length <= 80 && STABLE_CLASS_WORDS.test(item)
      )).slice(0, 8) : [],
      parentTag: /^[a-z0-9-]{0,40}$/i.test(String(value.parentTag || "")) ? String(value.parentTag).toLowerCase() : "",
      parentClasses: Array.isArray(value.parentClasses) ? value.parentClasses.filter(item => (
        typeof item === "string" && item.length <= 80 && STABLE_CLASS_WORDS.test(item)
      )).slice(0, 8) : []
    };
    return descriptor.tag ? descriptor : null;
  }

  function normalizeProfileStore(value) {
    if (!value || Number(value.schemaVersion) !== PROFILE_SCHEMA_VERSION || !Array.isArray(value.profiles)) {
      return { schemaVersion: PROFILE_SCHEMA_VERSION, profiles: [] };
    }
    const ids = new Set();
    const profiles = value.profiles.map(profile => {
      if (!profile || typeof profile !== "object" || Number(profile.schemaVersion) !== PROFILE_SCHEMA_VERSION) return null;
      const id = /^[a-z0-9_-]{1,80}$/i.test(String(profile.id || "")) ? String(profile.id) : "";
      if (!id || ids.has(id)) return null;
      const descriptors = {};
      for (const role of ROLES) {
        const descriptor = sanitizeDescriptor(profile.descriptors?.[role]);
        if (descriptor) descriptors[role] = descriptor;
      }
      if (!Object.keys(descriptors).length) return null;
      ids.add(id);
      return {
        id,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        updatedAt: Math.max(0, Number(profile.updatedAt) || 0),
        descriptors
      };
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LOCAL_PROFILES);
    return { schemaVersion: PROFILE_SCHEMA_VERSION, profiles };
  }

  function hashDescriptor(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function storageRead(storage, key) {
    if (!storage?.get) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value?.[key]);
      };
      try {
        const possible = storage.get(key, finish);
        if (possible?.then) possible.then(finish, () => finish(undefined));
      } catch (_error) {
        finish(undefined);
      }
    });
  }

  function storageWrite(storage, key, value) {
    if (!storage?.set) return Promise.resolve(false);
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      try {
        const possible = storage.set({ [key]: value }, finish);
        if (possible?.then) possible.then(finish, () => {
          if (settled) return;
          settled = true;
          resolve(false);
        });
      } catch (_error) {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }
    });
  }

  function createGeminiDomResolver(document, options = {}) {
    if (!document?.querySelectorAll) throw new TypeError("document is required");
    const storage = options.storage;
    const profileStorageKey = options.profileStorageKey || PROFILE_STORAGE_KEY;
    const bundledSelectors = options.bundledSelectors || BUNDLED_SELECTORS;
    const bundledProfileId = options.bundledProfileId || "gemini-current-v1";
    const providerLabel = options.providerLabel || "Gemini";
    let localStore = { schemaVersion: PROFILE_SCHEMA_VERSION, profiles: [] };
    const observedDescriptors = {};
    const lastResults = {};
    const hydration = storageRead(storage, profileStorageKey).then(value => {
      localStore = normalizeProfileStore(value);
      return localStore;
    });

    function allElements() {
      return collectElements(document);
    }

    function queryBundled(role, context = {}) {
      if (options.disableBundledProfiles) return null;
      const selectors = bundledSelectors[role] || [];
      const matches = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (!common.isVisible(element)) continue;
          if (["send", "stop", "temporaryLauncher"].includes(role) && !common.buttonIsEnabled(element)) continue;
          if (role === "send" && common.classifyAction(element)?.kind === "stop") continue;
          if (["send", "stop"].includes(role) && context.composer
            && !commonAncestorNear(element, context.composer)) continue;
          matches.push(element);
        }
      }
      if (!matches.length) return null;
      return role === "response" ? matches[matches.length - 1] : matches[0];
    }

    function descriptorScore(element, descriptor) {
      if (!element || !descriptor || String(element.localName || "").toLowerCase() !== descriptor.tag) return -1;
      let score = 35;
      if (descriptor.role && element.getAttribute("role") === descriptor.role) score += 20;
      if (descriptor.contenteditable && element.getAttribute("contenteditable") === "true") score += 20;
      if (descriptor.type && element.getAttribute("type") === descriptor.type) score += 10;
      const classes = new Set(safeClassTokens(element));
      score += descriptor.classes.filter(value => classes.has(value)).length * 8;
      const parent = composedParent(element);
      if (descriptor.parentTag && parent?.localName === descriptor.parentTag) score += 5;
      const parentClasses = new Set(safeClassTokens(parent));
      score += descriptor.parentClasses.filter(value => parentClasses.has(value)).length * 4;
      if (descriptor.semantic && semanticText(element).toLocaleLowerCase("vi").includes(descriptor.semantic)) score += 15;
      return score;
    }

    function queryLocal(role, context = {}) {
      const candidates = allElements();
      for (const profile of localStore.profiles) {
        const descriptor = profile.descriptors[role];
        if (!descriptor) continue;
        const ranked = candidates.map(element => ({ element, score: descriptorScore(element, descriptor) }))
          .filter(candidate => candidate.score >= 70 && common.isVisible(candidate.element))
          .filter(candidate => {
            if (!["send", "stop"].includes(role)) return true;
            if (!common.buttonIsEnabled(candidate.element)) return false;
            const action = common.classifyAction(candidate.element);
            if (action?.kind !== role || (role === "send" && action.signal === "class")) return false;
            return !context.composer || commonAncestorNear(candidate.element, context.composer);
          })
          .sort((a, b) => b.score - a.score);
        if (ranked.length) return { ...ranked[0], profileId: profile.id, candidateCount: ranked.length };
      }
      return null;
    }

    function scannerScore(role, element, context) {
      if (!common.isVisible(element)) return -100;
      const tag = String(element.localName || "").toLowerCase();
      const action = tag === "button" ? common.classifyAction(element) : null;
      const semantic = semanticText(element);
      let score = 0;
      if (role === "composer") {
        if (!["textarea", "input", "div", "p"].includes(tag)) return -100;
        if (element.getAttribute("role") === "textbox") score += 35;
        if (element.getAttribute("contenteditable") === "true") score += 30;
        if (["textarea", "input"].includes(tag)) score += 20;
        if (/prompt|message|tin nhắn/i.test(semantic)) score += 15;
      } else if (role === "send" || role === "stop") {
        if (tag !== "button" || !common.buttonIsEnabled(element)) return -100;
        if (action?.kind === role && !(role === "send" && action.signal === "class")) score += 55;
        else return -100;
        score += 20;
        if (context?.composer && commonAncestorNear(element, context.composer)) score += 25;
      } else if (role === "response") {
        if (tag === "model-response") score += 100;
        if (element.getAttribute("data-message-author-role") === "assistant") score += 90;
        if (element.getAttribute("role") === "article" && /response|assistant/i.test(semantic)) score += 70;
      } else if (role === "completion") {
        if (!context?.response || !context.response.contains?.(element)) return -100;
        if (/response-footer|response-actions/.test(safeClassTokens(element).join(" "))) score += 90;
        if (/copy response|sao chép phản hồi/i.test(semantic)) score += 75;
      } else if (role === "temporaryLauncher") {
        if (tag !== "button" || !common.buttonIsEnabled(element)) return -100;
        if (/temporary|tạm thời|temp-chat/i.test(semantic)) score += 90;
        if (element.getAttribute("aria-pressed") === "false") score += 10;
      } else if (role === "temporaryActive") {
        if (/is-temporary-chat|temp-chat-on/.test(safeClassTokens(element).join(" "))) score += 100;
        if (/temporary|tạm thời|temp-chat/i.test(semantic) && element.getAttribute("aria-pressed") === "true") score += 90;
      }
      return score;
    }

    function resolve(role, context = {}) {
      if (!ROLES.includes(role)) throw new TypeError(`Unsupported ${providerLabel} DOM role: ${role}`);
      const bundled = queryBundled(role, context);
      if (bundled) {
        observedDescriptors[role] = buildDescriptor(bundled);
        return lastResults[role] = {
          role, element: bundled, source: "bundled", profileId: bundledProfileId,
          confidence: "high", reason: "selector_match", candidateCount: 1
        };
      }
      const local = queryLocal(role, context);
      if (local) {
        observedDescriptors[role] = buildDescriptor(local.element);
        return lastResults[role] = {
          role, element: local.element, source: "local", profileId: local.profileId,
          confidence: "high", reason: "profile_match", candidateCount: local.candidateCount
        };
      }
      const elements = allElements();
      const scannerContext = { ...context };
      if (role === "completion" && !scannerContext.response) scannerContext.response = resolve("response").element;
      const ranked = elements.map(element => ({ element, score: scannerScore(role, element, scannerContext) }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
      const highThreshold = ["send", "temporaryLauncher", "temporaryActive", "completion"].includes(role) ? 90 : 70;
      const best = ranked[0];
      const confidence = confidenceFor(best?.score || 0, highThreshold);
      const safe = confidence === "high";
      if (safe) observedDescriptors[role] = buildDescriptor(best.element);
      return lastResults[role] = {
        role,
        element: safe ? best.element : null,
        source: "scanner",
        profileId: "",
        confidence,
        reason: safe ? "semantic_match" : "no_safe_candidate",
        candidateCount: ranked.length
      };
    }

    async function learnVerified(now = Date.now()) {
      await hydration;
      const descriptors = Object.fromEntries(Object.entries(observedDescriptors).filter(([, value]) => value));
      if (!descriptors.composer || !descriptors.response || Object.keys(descriptors).length < 3) return false;
      const id = `local-${hashDescriptor(descriptors)}`;
      const next = normalizeProfileStore({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profiles: [
          { id, schemaVersion: PROFILE_SCHEMA_VERSION, updatedAt: now, descriptors },
          ...localStore.profiles.filter(profile => profile.id !== id)
        ]
      });
      const saved = await storageWrite(storage, profileStorageKey, next);
      if (saved) localStore = next;
      return saved;
    }

    async function invalidateProfile(profileId) {
      await hydration;
      if (!profileId || !localStore.profiles.some(profile => profile.id === profileId)) return false;
      const next = { ...localStore, profiles: localStore.profiles.filter(profile => profile.id !== profileId) };
      const saved = await storageWrite(storage, profileStorageKey, next);
      if (saved) localStore = next;
      return saved;
    }

    function getDiagnosticSnapshot() {
      const roles = {};
      const evidence = [];
      for (const role of ROLES) {
        const result = lastResults[role];
        roles[role] = result ? {
          source: result.source,
          profileId: result.profileId,
          confidence: result.confidence,
          reason: result.reason,
          candidateCount: countBucket(result.candidateCount)
        } : { source: "none", profileId: "", confidence: "low", reason: "not_checked", candidateCount: "0" };
        if (result?.element) {
          const descriptor = buildDescriptor(result.element);
          evidence.push({
            role,
            tag: descriptor.tag,
            parentTag: descriptor.parentTag,
            roleAttribute: descriptor.role,
            contenteditable: descriptor.contenteditable,
            semantic: descriptor.semantic,
            classHints: descriptor.classes,
            disabled: result.element.disabled === true || result.element.getAttribute?.("aria-disabled") === "true",
            hidden: !common.isVisible(result.element)
          });
        }
      }
      return {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        localProfileCount: Math.min(MAX_LOCAL_PROFILES, localStore.profiles.length),
        roles,
        evidence: evidence.slice(0, ROLES.length)
      };
    }

    function probe() {
      const composer = resolve("composer").element;
      const response = resolve("response").element;
      resolve("send", { composer });
      resolve("stop", { composer });
      resolve("completion", { response });
      resolve("temporaryLauncher");
      resolve("temporaryActive");
      return getDiagnosticSnapshot();
    }

    return Object.freeze({
      resolve,
      ready: () => hydration,
      learnVerified,
      invalidateProfile,
      getDiagnosticSnapshot,
      probe
    });
  }

  return Object.freeze({
    PROFILE_SCHEMA_VERSION,
    PROFILE_STORAGE_KEY,
    MAX_LOCAL_PROFILES,
    createGeminiDomResolver,
    createStructuralDomResolver: createGeminiDomResolver,
    normalizeProfileStore
  });
});
