(function attachChatGPTDomResolver(root, factory) {
  const common = root.STVAIProviderCommon
    || (typeof require === "function" ? require("./provider-common.js") : null);
  const structural = root.STVAIGeminiDomResolver
    || (typeof require === "function" ? require("./gemini-dom-resolver.js") : null);
  const api = factory(common, structural);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIChatGPTDomResolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createChatGPTResolverModule(common, structural) {
  "use strict";

  const PROFILE_SCHEMA_VERSION = 1;
  const PROFILE_STORAGE_KEY = "stvaiChatGPTDomProfilesV1";
  const MAX_LOCAL_PROFILES = 5;

  const BUNDLED_SELECTORS = Object.freeze({
    composer: ["#prompt-textarea", "textarea[data-testid='prompt-textarea']", "main form [contenteditable='true']"],
    send: ["button[data-testid='send-button']", "button[aria-label='Send prompt']", "button[aria-label^='Send']"],
    stop: ["button[data-testid='stop-button']", "button[aria-label^='Stop' i]", "button[aria-label^='Dừng' i]"],
    response: ["article[data-testid^='conversation-turn-assistant']", "[data-message-author-role='assistant']"],
    completion: [
      "article[data-testid^='conversation-turn-assistant'] button[aria-label*='Copy' i]",
      "[data-message-author-role='assistant'] button[aria-label*='Copy' i]"
    ],
    temporaryLauncher: [
      "button[data-testid='temporary-chat-button']",
      "button[aria-label*='Temporary chat' i]",
      "button[aria-label*='trò chuyện tạm thời' i]"
    ],
    temporaryActive: [
      "button[data-testid='temporary-chat-button'][aria-pressed='true']",
      "button[aria-label*='Temporary chat' i][aria-pressed='true']"
    ]
  });

  function createChatGPTDomResolver(document, options = {}) {
    return structural.createStructuralDomResolver(document, {
      ...options,
      bundledSelectors: BUNDLED_SELECTORS,
      bundledProfileId: "chatgpt-current-v1",
      profileStorageKey: PROFILE_STORAGE_KEY,
      providerLabel: "ChatGPT"
    });
  }

  return Object.freeze({
    PROFILE_SCHEMA_VERSION,
    PROFILE_STORAGE_KEY,
    MAX_LOCAL_PROFILES,
    createChatGPTDomResolver,
    normalizeProfileStore: structural.normalizeProfileStore
  });
});
