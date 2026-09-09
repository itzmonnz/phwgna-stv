(function attachMessageRouter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIBackgroundMessageRouter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMessageRouterApi() {
  "use strict";

  function createMessageRouter(options = {}) {
    const routes = options.routes || Object.create(null);
    const aliases = options.aliases || Object.create(null);
    const fallback = typeof options.fallback === "function" ? options.fallback : () => undefined;

    async function handleMessage(message, sender = {}) {
      const type = String(message?.type || "");
      const route = routes[aliases[type] || type];
      if (typeof route === "function") return route(message, sender);
      return fallback(message, sender);
    }

    return Object.freeze({ handleMessage });
  }

  return Object.freeze({ createMessageRouter });
});
