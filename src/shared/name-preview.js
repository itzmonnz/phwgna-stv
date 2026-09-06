(function attachNamePreview(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAINamePreview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNamePreviewApi() {
  "use strict";

  const CACHE_KEY = "stvai-name-preview-cache-v2";
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

  function validateSource(value) {
    const source = String(value || "").trim();
    if (!source || !CJK_RE.test(source)) throw new TypeError("Hãy chọn một cụm tiếng Trung.");
    if (Array.from(source).length > 80) throw new TypeError("Cụm tiếng Trung quá dài để xem trước.");
    return source;
  }

  function translationFromPayload(payload) {
    const status = Number(payload?.responseStatus);
    const text = typeof payload?.responseData?.translatedText === "string"
      ? payload.responseData.translatedText.trim()
      : "";
    if (status !== 200 || !text || text.length > 1_000) {
      throw new TypeError("Phản hồi dịch không hợp lệ.");
    }
    return text;
  }

  function googleTranslationFromPayload(payload) {
    const segments = Array.isArray(payload?.[0]) ? payload[0] : [];
    const text = segments
      .map((segment) => typeof segment?.[0] === "string" ? segment[0] : "")
      .join("")
      .trim();
    if (!text || text.length > 1_000) {
      throw new TypeError("Phản hồi dịch không hợp lệ.");
    }
    return text;
  }

  function buildJapaneseNamePrompt(value) {
    const source = validateSource(value);
    return `${JSON.stringify(source)} dịch ra tên nhật romaji là gì, chỉ trả lời đáp án, không giải thích, chú thích.`;
  }

  function looksLikeRomajiName(value) {
    const words = String(value || "").split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 5) return false;
    return words.every((word) => {
      const first = Array.from(word.replace(/^[.'’\-]+/, ""))[0] || "";
      return first && first === first.toLocaleUpperCase("en") && first !== first.toLocaleLowerCase("en");
    });
  }

  function sanitizeJapaneseNameResponse(value, englishFallback = "") {
    const firstLine = String(value || "")
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/^```[^\r\n]*[\r\n]?|[\r\n]?```$/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";
    let candidate = firstLine
      .replace(/\*\*|__/g, "")
      .replace(/`/g, "")
      .replace(/^(?:[-*]\s*)?(?:(?:the\s+)?romaji(?:\s+(?:is|would be))?|answer|đáp án)\s*[:：-]?\s*/iu, "")
      .replace(/\s*[（(][^）)]*[）)](?:\s*.*)?$/u, "")
      .replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!candidate || candidate.length > 120 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(candidate)) return "";
    if (!/^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}\s.'’\-]*$/u.test(candidate)) return "";
    if (!looksLikeRomajiName(candidate)) return "";
    const normalized = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
    if (normalized(candidate) === normalized(englishFallback)) return "";
    return candidate;
  }

  function storageGet(storage, key) {
    if (!storage?.get) return Promise.resolve({});
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value && typeof value === "object" ? value : {});
      };
      try {
        const possiblePromise = storage.get(key, finish);
        if (possiblePromise?.then) possiblePromise.then(finish, () => finish({}));
      } catch (_error) {
        finish({});
      }
    });
  }

  function storageSet(storage, value) {
    if (!storage?.set) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const possiblePromise = storage.set(value, finish);
        if (possiblePromise?.then) possiblePromise.then(finish, finish);
      } catch (_error) {
        finish();
      }
    });
  }

  function createNamePreviewService(options = {}) {
    const fetchFn = options.fetchFn || ((...argumentsList) => globalThis.fetch(...argumentsList));
    const storage = options.storage;
    const timeoutMs = Math.max(50, Number(options.timeoutMs) || 3_000);
    const maxEntries = Math.max(1, Number(options.maxEntries) || 500);
    const now = options.now || Date.now;
    const cache = new Map();
    let loaded;

    async function loadCache() {
      if (loaded) return loaded;
      loaded = storageGet(storage, CACHE_KEY).then((stored) => {
        const entries = Array.isArray(stored[CACHE_KEY]) ? stored[CACHE_KEY] : [];
        for (const entry of entries) {
          if (!entry || typeof entry.source !== "string") continue;
          const provider = entry.provider === "google" || entry.provider === "mymemory"
            ? entry.provider
            : "";
          if (typeof entry.en !== "string" || !entry.en.trim() || !provider) continue;
          cache.set(entry.source, {
            en: entry.en.trim(),
            provider,
            at: Number(entry.at) || 0
          });
        }
      });
      return loaded;
    }

    async function persist() {
      const entries = Array.from(cache, ([source, value]) => ({ source, ...value }));
      await storageSet(storage, { [CACHE_KEY]: entries });
    }

    function trimCache() {
      while (cache.size > maxEntries) {
        let oldestSource = "";
        let oldestAt = Infinity;
        for (const [source, entry] of cache) {
          if (entry.at < oldestAt) {
            oldestAt = entry.at;
            oldestSource = source;
          }
        }
        cache.delete(oldestSource);
      }
    }

    async function requestTranslation(url, parser, externalSignal) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      externalSignal?.addEventListener?.("abort", abort, { once: true });
      if (externalSignal?.aborted) controller.abort();
      try {
        const response = await fetchFn(url.toString(), {
          method: "GET",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal
        });
        if (!response?.ok) throw new TypeError("Phản hồi dịch không hợp lệ.");
        return parser(await response.json());
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener?.("abort", abort);
      }
    }

    function translateGoogleEnglish(source, externalSignal) {
      const url = new URL("https://translate.googleapis.com/translate_a/single");
      url.searchParams.set("client", "gtx");
      url.searchParams.set("sl", "zh-CN");
      url.searchParams.set("tl", "en");
      url.searchParams.set("dt", "t");
      url.searchParams.set("q", source);
      return requestTranslation(url, googleTranslationFromPayload, externalSignal);
    }

    function translateMyMemoryEnglish(source, externalSignal) {
      const url = new URL("https://api.mymemory.translated.net/get");
      url.searchParams.set("q", source);
      url.searchParams.set("langpair", "zh-CN|en");
      return requestTranslation(url, translationFromPayload, externalSignal);
    }

    async function translateEnglish(source, externalSignal) {
      try {
        return { en: await translateGoogleEnglish(source, externalSignal), provider: "google" };
      } catch (error) {
        if (externalSignal?.aborted) throw error;
        return { en: await translateMyMemoryEnglish(source, externalSignal), provider: "mymemory" };
      }
    }

    async function preview(value, requestOptions = {}) {
      const source = validateSource(value);
      await loadCache();
      const cached = cache.get(source);
      if (cached?.en) {
        cached.at = now();
        return { source, vi: "", en: cached.en, errors: {} };
      }

      const result = { source, vi: "", en: "", errors: {} };
      let translated;
      try {
        translated = await translateEnglish(source, requestOptions.signal);
        result.en = translated.en;
      } catch (error) {
        if (requestOptions.signal?.aborted) {
          const abortError = new Error("Preview cancelled");
          abortError.name = "AbortError";
          throw abortError;
        }
        result.errors.en = "preview_unavailable";
      }
      if (result.en) {
        cache.set(source, { en: result.en, provider: translated.provider, at: now() });
        trimCache();
        await persist();
      }
      return result;
    }

    return Object.freeze({ preview });
  }

  return Object.freeze({
    CACHE_KEY,
    validateSource,
    translationFromPayload,
    googleTranslationFromPayload,
    buildJapaneseNamePrompt,
    sanitizeJapaneseNameResponse,
    createNamePreviewService
  });
});
