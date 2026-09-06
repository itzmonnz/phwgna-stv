(function attachUpdateCheck(root, factory) {
  const api = factory(root.crypto);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIUpdateCheck = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createUpdateCheckApi(defaultCrypto) {
  "use strict";

  const UPDATE_STORAGE_KEY = "stvaiUpdateStateV1";
  const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
  const DEFAULT_METADATA_URL = "https://raw.githubusercontent.com/itzmonnz/phwgna-stv-updates/main/latest.json";
  const DEFAULT_PUBLIC_KEY_SPKI = "MCowBQYDK2VwAyEAdwbLQBCaDRrm+NrjMWtlLX2cnTnuvBakw4RU7ybMN3I=";
  const MAX_METADATA_BYTES = 8_192;

  function canonicalUpdatePayload(value) {
    return JSON.stringify({
      version: value.version,
      releaseUrl: value.releaseUrl,
      sha256: value.sha256,
      publishedAt: value.publishedAt
    });
  }

  function decodeBase64(value) {
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(String(value || ""), "base64"));
    const binary = atob(String(value || ""));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function encodeText(value) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "utf8"));
    throw new TypeError("TextEncoder unavailable");
  }

  function validVersion(value) {
    return /^\d+\.\d+\.\d+$/.test(String(value || ""));
  }

  function compareVersions(left, right) {
    if (!validVersion(left) || !validVersion(right)) return 0;
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function validReleaseUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:"
        && url.username === ""
        && url.password === ""
        && url.port === ""
        && url.hostname === "github.com"
        && url.pathname.startsWith("/itzmonnz/phwgna-stv-updates/releases/");
    } catch (_error) {
      return false;
    }
  }

  function sanitizeMetadata(value) {
    if (!value || typeof value !== "object") return null;
    const metadata = {
      version: String(value.version || ""),
      releaseUrl: String(value.releaseUrl || ""),
      sha256: String(value.sha256 || "").toLowerCase(),
      publishedAt: String(value.publishedAt || ""),
      signature: String(value.signature || "")
    };
    if (!validVersion(metadata.version)
      || !validReleaseUrl(metadata.releaseUrl)
      || !/^[a-f0-9]{64}$/.test(metadata.sha256)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(metadata.publishedAt)
      || Number.isNaN(Date.parse(metadata.publishedAt))
      || !/^[a-z0-9+/]{80,120}={0,2}$/i.test(metadata.signature)) {
      return null;
    }
    return metadata;
  }

  async function verifyMetadata(metadata, publicKeySpki, cryptoProvider = defaultCrypto) {
    if (!cryptoProvider?.subtle) return false;
    try {
      const key = await cryptoProvider.subtle.importKey(
        "spki",
        decodeBase64(publicKeySpki),
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      return cryptoProvider.subtle.verify(
        { name: "Ed25519" },
        key,
        decodeBase64(metadata.signature),
        encodeText(canonicalUpdatePayload(metadata))
      );
    } catch (_error) {
      return false;
    }
  }

  function storageRead(storage) {
    if (!storage?.get) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value?.[UPDATE_STORAGE_KEY]);
      };
      try {
        const possible = storage.get(UPDATE_STORAGE_KEY, finish);
        if (possible?.then) possible.then(finish, () => finish(undefined));
      } catch (_error) {
        finish(undefined);
      }
    });
  }

  function storageWrite(storage, state) {
    if (!storage?.set) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const possible = storage.set({ [UPDATE_STORAGE_KEY]: state }, finish);
        if (possible?.then) possible.then(finish, finish);
      } catch (_error) {
        finish();
      }
    });
  }

  function sanitizeState(value) {
    const input = value && typeof value === "object" ? value : {};
    return {
      lastCheckedAt: Math.max(0, Number(input.lastCheckedAt) || 0),
      available: input.available === true,
      version: validVersion(input.version) ? input.version : "",
      releaseUrl: validReleaseUrl(input.releaseUrl) ? input.releaseUrl : "",
      sha256: /^[a-f0-9]{64}$/i.test(String(input.sha256 || "")) ? String(input.sha256).toLowerCase() : "",
      publishedAt: typeof input.publishedAt === "string" ? input.publishedAt.slice(0, 40) : "",
      signature: /^[a-z0-9+/]{80,120}={0,2}$/i.test(String(input.signature || "")) ? String(input.signature) : "",
      signatureStatus: ["valid", "invalid", "unchecked"].includes(input.signatureStatus) ? input.signatureStatus : "unchecked",
      errorCode: ["none", "offline", "invalid_metadata", "invalid_signature", "http_error"].includes(input.errorCode)
        ? input.errorCode : "none"
    };
  }

  function createUpdateChecker(options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const storage = options.storage;
    const now = options.now || Date.now;
    const metadataUrl = options.metadataUrl || DEFAULT_METADATA_URL;
    const publicKeySpki = options.publicKeySpki || DEFAULT_PUBLIC_KEY_SPKI;
    const cryptoProvider = options.crypto || defaultCrypto;

    async function verifyCachedState(state, currentVersion) {
      if (state.signatureStatus !== "valid") return { ...state, available: false };
      const metadata = sanitizeMetadata(state);
      if (!metadata || !await verifyMetadata(metadata, publicKeySpki, cryptoProvider)) {
        return {
          ...state,
          available: false,
          version: "",
          releaseUrl: "",
          sha256: "",
          publishedAt: "",
          signature: "",
          signatureStatus: "invalid",
          errorCode: "invalid_signature"
        };
      }
      return { ...state, available: compareVersions(metadata.version, currentVersion) > 0 };
    }

    async function check({ force = false, currentVersion = "" } = {}) {
      const stored = sanitizeState(await storageRead(storage));
      const previous = await verifyCachedState(stored, currentVersion);
      const checkedAt = now();
      if (!force && previous.lastCheckedAt && checkedAt - previous.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) {
        if (stored.signatureStatus === "valid" && previous.signatureStatus !== "valid") {
          await storageWrite(storage, previous);
        }
        return previous;
      }
      try {
        const response = await fetchImpl(metadataUrl, {
          cache: "no-store",
          credentials: "omit",
          redirect: "error"
        });
        if (!response?.ok) {
          const state = { ...previous, lastCheckedAt: checkedAt, errorCode: "http_error" };
          await storageWrite(storage, state);
          return state;
        }
        const text = await response.text();
        if (text.length > MAX_METADATA_BYTES) throw new TypeError("metadata_too_large");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (_error) {
          parsed = null;
        }
        const metadata = sanitizeMetadata(parsed);
        if (!metadata) {
          const state = {
            lastCheckedAt: checkedAt, available: false, version: "", releaseUrl: "", sha256: "",
            publishedAt: "", signatureStatus: "invalid", errorCode: "invalid_metadata"
          };
          await storageWrite(storage, state);
          return state;
        }
        const signatureValid = await verifyMetadata(metadata, publicKeySpki, cryptoProvider);
        if (!signatureValid) {
          const state = {
            lastCheckedAt: checkedAt, available: false, version: "", releaseUrl: "", sha256: "",
            publishedAt: "", signatureStatus: "invalid", errorCode: "invalid_signature"
          };
          await storageWrite(storage, state);
          return state;
        }
        const state = {
          lastCheckedAt: checkedAt,
          available: compareVersions(metadata.version, currentVersion) > 0,
          version: metadata.version,
          releaseUrl: metadata.releaseUrl,
          sha256: metadata.sha256,
          publishedAt: metadata.publishedAt,
          signature: metadata.signature,
          signatureStatus: "valid",
          errorCode: "none"
        };
        await storageWrite(storage, state);
        return state;
      } catch (_error) {
        const state = { ...previous, lastCheckedAt: checkedAt, errorCode: "offline" };
        await storageWrite(storage, state);
        return state;
      }
    }

    return Object.freeze({ check });
  }

  return Object.freeze({
    UPDATE_STORAGE_KEY,
    UPDATE_CHECK_INTERVAL_MS,
    DEFAULT_METADATA_URL,
    DEFAULT_PUBLIC_KEY_SPKI,
    canonicalUpdatePayload,
    compareVersions,
    validReleaseUrl,
    sanitizeMetadata,
    verifyMetadata,
    createUpdateChecker
  });
});
