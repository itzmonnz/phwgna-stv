(function attachApiProviders(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIApiProviders = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApiProviders() {
  "use strict";
  const API_PROVIDERS = Object.freeze(["openrouter_api", "gemini_api", "openai_api", "deepseek_api"]);
  const DEFAULT_MODELS = Object.freeze({
    openrouter_api: "openrouter/auto",
    gemini_api: "gemini-2.5-flash",
    openai_api: "gpt-5.4",
    deepseek_api: "deepseek-chat"
  });
  const SAFETY_CATEGORIES = Object.freeze([
    "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"
  ]);

  class ApiProviderError extends Error {
    constructor(code, providerCode = "") {
      super(code || "provider_error");
      this.name = "ApiProviderError";
      this.code = code || "provider_error";
      this.providerCode = String(providerCode || "").slice(0, 48);
    }
  }
  const isApiProvider = (provider) => API_PROVIDERS.includes(provider);
  const safeModel = (provider, model) => String(model || "").trim() || DEFAULT_MODELS[provider] || "";

  function httpCode(status, input) {
    if (input.provider === "gemini_api" && input.safetyOff && status === 400) return "safety_setting_unsupported";
    if (status === 401 || status === 403) return "invalid_api_key";
    if (status === 402) return "insufficient_credit";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "provider_unavailable";
    return "provider_error";
  }

  function requestSpec(input, testOnly) {
    if (!isApiProvider(input.provider)) throw new ApiProviderError("unsupported_provider");
    if (!String(input.apiKey || "").trim()) throw new ApiProviderError("api_key_missing");
    const model = safeModel(input.provider, input.model);
    const system = testOnly ? "Connection test." : String(input.system || "");
    const user = testOnly ? "Reply only OK." : String(input.user || "");
    const headers = { "content-type": "application/json" };
    let url;
    let body;
    if (input.provider === "gemini_api") {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      headers["x-goog-api-key"] = String(input.apiKey).trim();
      body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: testOnly ? 16 : 8192 }
      };
      if (!testOnly && !input.omitTemperature && Number.isFinite(Number(input.temperature))) {
        body.generationConfig.temperature = Number(input.temperature);
      }
      if (input.safetyOff) body.safetySettings = SAFETY_CATEGORIES.map((category) => ({ category, threshold: "OFF" }));
    } else if (input.provider === "openai_api") {
      url = "https://api.openai.com/v1/responses";
      headers.Authorization = `Bearer ${String(input.apiKey).trim()}`;
      body = { model, instructions: system, input: user, store: false, max_output_tokens: testOnly ? 16 : 8192 };
      if (!testOnly && !input.omitTemperature && Number.isFinite(Number(input.temperature))) {
        body.temperature = Number(input.temperature);
      }
    } else {
      url = input.provider === "openrouter_api"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.deepseek.com/chat/completions";
      headers.Authorization = `Bearer ${String(input.apiKey).trim()}`;
      body = {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: false,
        max_tokens: testOnly ? 16 : 8192
      };
      if (!testOnly && !input.omitTemperature && Number.isFinite(Number(input.temperature))) {
        body.temperature = Number(input.temperature);
      }
    }
    return { url, headers, body, model };
  }

  function outputText(provider, payload) {
    if (provider === "gemini_api") {
      const candidate = payload?.candidates?.[0];
      const finish = String(candidate?.finishReason || "").toUpperCase();
      if (payload?.promptFeedback?.blockReason || ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT"].includes(finish)) {
        throw new ApiProviderError("content_refused", finish || "blocked");
      }
      return (candidate?.content?.parts || []).map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
    }
    if (provider === "openai_api") {
      if (typeof payload?.output_text === "string") return payload.output_text.trim();
      return (payload?.output || []).flatMap((item) => item?.content || []).map((item) => item?.text || "").join("").trim();
    }
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : "";
  }

  function temperatureUnsupported(status, payload) {
    if (Number(status) !== 400) return false;
    const error = payload?.error;
    const code = String(error?.param || error?.code || "").toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    return code === "temperature"
      || (message.includes("temperature") && /unsupported|not supported|unknown|invalid parameter/.test(message));
  }

  function createApiClient(dependencies = {}) {
    const fetchImpl = dependencies.fetch || globalThis.fetch;
    const now = dependencies.now || Date.now;
    const setTimer = dependencies.setTimeout || globalThis.setTimeout;
    const clearTimer = dependencies.clearTimeout || globalThis.clearTimeout;
    async function execute(input, testOnly) {
      if (typeof fetchImpl !== "function") throw new ApiProviderError("network_error");
      const controller = new AbortController();
      const onAbort = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener?.("abort", onAbort, { once: true });
      let timedOut = false;
      const started = now();
      const timer = setTimer(() => { timedOut = true; controller.abort(); }, Math.max(1000, Number(input.timeoutMs) || (testOnly ? 15000 : 90000)));
      const readPayload = async (response) => {
        try {
          return await response.json();
        } catch (_error) {
          if (timedOut) throw new ApiProviderError("response_timeout");
          if (input.signal?.aborted) throw new ApiProviderError("request_cancelled");
          if (response?.ok) throw new ApiProviderError("invalid_response");
          return {};
        }
      };
      try {
        let temperatureFallback = false;
        let spec = requestSpec(input, testOnly);
        let response = await fetchImpl(spec.url, {
          method: "POST", headers: spec.headers, body: JSON.stringify(spec.body),
          credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal
        });
        let payload = await readPayload(response);
        if (!response?.ok && !testOnly && !input.omitTemperature
          && Number.isFinite(Number(input.temperature)) && temperatureUnsupported(response.status, payload)) {
          temperatureFallback = true;
          spec = requestSpec({ ...input, omitTemperature: true }, testOnly);
          response = await fetchImpl(spec.url, {
            method: "POST", headers: spec.headers, body: JSON.stringify(spec.body),
            credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal
          });
          payload = await readPayload(response);
        }
        if (!response?.ok) throw new ApiProviderError(httpCode(Number(response?.status) || 0, input), response?.status);
        const text = outputText(input.provider, payload);
        if (!text) throw new ApiProviderError("empty_response");
        return { ok: true, text, outcomeCode: "ok", providerCode: "", model: String(payload?.model || spec.model),
          latencyMs: Math.max(0, now() - started), temperatureFallback };
      } catch (error) {
        if (error instanceof ApiProviderError) throw error;
        if (timedOut) throw new ApiProviderError("response_timeout");
        if (input.signal?.aborted) throw new ApiProviderError("request_cancelled");
        throw new ApiProviderError("network_error");
      } finally {
        clearTimer(timer);
        input.signal?.removeEventListener?.("abort", onAbort);
      }
    }
    return Object.freeze({
      translate: (input) => execute(input, false),
      async testConnection(input) {
        const result = await execute(input, true);
        return { ok: true, model: result.model, latencyMs: result.latencyMs, outcomeCode: result.outcomeCode };
      }
    });
  }

  return Object.freeze({ API_PROVIDERS, DEFAULT_MODELS, SAFETY_CATEGORIES, ApiProviderError, isApiProvider, createApiClient });
});
