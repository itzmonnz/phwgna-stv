(function attachCache(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.STVAICache = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCacheApi() {
  "use strict";

  const DEFAULT_MAX_CHAPTERS = 20;
  const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
  const IDENTITY_FIELDS = ["provider", "chapterId", "sourceHash", "promptHash", "nameHash"];

  function clone(value) {
    if (value == null) return value;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function buildCacheKey(identity) {
    const values = IDENTITY_FIELDS.map((field) => {
      const value = identity && identity[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`Missing cache identity field: ${field}`);
      }
      return value;
    });
    if (identity.chapterKey != null || identity.batchHash != null) {
      if (typeof identity.chapterKey !== 'string' || !identity.chapterKey
        || typeof identity.batchHash !== 'string' || !identity.batchHash) throw new TypeError('Incomplete chapter cache identity');
      return JSON.stringify(['v2', identity.chapterKey, identity.batchHash, ...values]);
    }
    return JSON.stringify(values);
  }

  function storedIdentityFromKey(record) {
    if (!record || typeof record.key !== "string") return null;
    let parts;
    try {
      parts = JSON.parse(record.key);
    } catch (_error) {
      return null;
    }
    if (!Array.isArray(parts)) return null;
    const identityValues = IDENTITY_FIELDS.map((field) => record[field]);
    if (parts[0] === "v2" && parts.length === IDENTITY_FIELDS.length + 3) {
      const chapterKey = parts[1];
      const batchHash = parts[2];
      if (typeof chapterKey !== "string" || !chapterKey || typeof batchHash !== "string" || !batchHash) return null;
      if (!parts.slice(3).every((value, index) => value === identityValues[index])) return null;
      if (record.chapterKey != null && record.chapterKey !== chapterKey) return null;
      if (record.batchHash != null && record.batchHash !== batchHash) return null;
      return { key: record.key, chapterKey, batchHash };
    }
    if (parts.length !== IDENTITY_FIELDS.length || record.chapterKey != null || record.batchHash != null) return null;
    if (!parts.every((value, index) => value === identityValues[index])) return null;
    return { key: record.key };
  }

  function listedRecord(record) {
    const listed = clone(record);
    const storedIdentity = storedIdentityFromKey(listed);
    if (storedIdentity?.chapterKey) {
      listed.chapterKey = storedIdentity.chapterKey;
      listed.batchHash = storedIdentity.batchHash;
    }
    return listed;
  }

  function byteLength(value) {
    const text = JSON.stringify(value);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
    if (typeof Buffer === "function") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function hasAiItems(items) {
    return Array.isArray(items) && items.length > 0 && items.every((item) => (
      item?.origin === "ai"
      && typeof item.id === "string" && item.id.trim().length > 0
      && typeof item.text === "string" && item.text.trim().length > 0
    ));
  }

  function hasOnlyAiBatches(record) {
    if (!record?.batches || typeof record.batches !== "object" || Array.isArray(record.batches)) return false;
    const batches = Object.values(record.batches);
    return batches.length > 0 && batches.every((batch) => hasAiItems(batch?.items));
  }

  function validInputHash(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  }

  function createMemoryDriver() {
    const records = new Map();
    return {
      kind: "memory",
      async get(key) {
        return clone(records.get(key) || null);
      },
      async put(record) {
        records.set(record.key, clone(record));
      },
      async delete(key) {
        records.delete(key);
      },
      async clear() {
        records.clear();
      },
      async getAll() {
        return Array.from(records.values(), clone);
      }
    };
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function createIndexedDbDriver(indexedDBFactory, options = {}) {
    if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") {
      throw new TypeError("IndexedDB is unavailable");
    }
    const dbName = options.dbName || "stv-ai-translator";
    const storeName = options.storeName || "chapters";
    let opening;

    function open() {
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        const request = indexedDBFactory.open(dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          opening = null;
          reject(request.error || new Error("Could not open translation cache"));
        };
      });
      return opening;
    }

    async function store(mode) {
      const db = await open();
      return db.transaction(storeName, mode).objectStore(storeName);
    }

    return {
      kind: "indexeddb",
      async get(key) {
        return (await requestResult((await store("readonly")).get(key))) || null;
      },
      async put(record) {
        await requestResult((await store("readwrite")).put(record));
      },
      async delete(key) {
        await requestResult((await store("readwrite")).delete(key));
      },
      async clear() {
        await requestResult((await store("readwrite")).clear());
      },
      async getAll() {
        return await requestResult((await store("readonly")).getAll());
      }
    };
  }

  function createCacheRepository(options = {}) {
    const maxChapters = options.maxChapters ?? DEFAULT_MAX_CHAPTERS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const now = options.now || Date.now;
    const driver = options.driver || createIndexedDbDriver(options.indexedDB || globalThis.indexedDB, options);
    const keyQueues = new Map();

    if (!Number.isInteger(maxChapters) || maxChapters < 1) {
      throw new TypeError("maxChapters must be a positive integer");
    }
    if (!Number.isFinite(maxBytes) || maxBytes < 1) {
      throw new TypeError("maxBytes must be positive");
    }

    async function prune() {
      const records = await driver.getAll();
      let totalBytes = records.reduce((sum, record) => sum + (record.sizeBytes || byteLength(record)), 0);
      const chapterGroups = new Map();
      for (const record of records) {
        const stored = storedIdentityFromKey(record);
        const groupKey = stored?.chapterKey ? `chapter:${stored.chapterKey}` : `record:${record.key}`;
        const group = chapterGroups.get(groupKey) || { key: groupKey, accessedAt: 0, records: [] };
        group.records.push(record);
        group.accessedAt = Math.max(group.accessedAt, record.accessedAt || 0);
        chapterGroups.set(groupKey, group);
      }
      if (chapterGroups.size <= maxChapters && totalBytes <= maxBytes) return;

      const groups = Array.from(chapterGroups.values()).sort((left, right) => {
        const accessDifference = left.accessedAt - right.accessedAt;
        return accessDifference || left.key.localeCompare(right.key);
      });
      const deletedKeys = new Set();
      while (groups.length > maxChapters) {
        const oldestGroup = groups.shift();
        for (const record of oldestGroup.records) {
          totalBytes -= record.sizeBytes || byteLength(record);
          deletedKeys.add(record.key);
          await driver.delete(record.key);
        }
      }

      const remainingRecords = records.filter(record => !deletedKeys.has(record.key));
      remainingRecords.sort((left, right) => {
        const accessDifference = (left.accessedAt || 0) - (right.accessedAt || 0);
        if (accessDifference !== 0) return accessDifference;
        return String(left.key).localeCompare(String(right.key));
      });
      while (totalBytes > maxBytes && remainingRecords.length) {
        const oldest = remainingRecords.shift();
        totalBytes -= oldest.sizeBytes || byteLength(oldest);
        await driver.delete(oldest.key);
      }
    }

    function serializeKey(key, operation) {
      const previous = keyQueues.get(key) || Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      keyQueues.set(key, current);
      return current.finally(() => {
        if (keyQueues.get(key) === current) keyQueues.delete(key);
      });
    }

    async function getChapter(identity) {
      const key = buildCacheKey(identity);
      return serializeKey(key, async () => {
        const record = await driver.get(key);
        if (!record) return null;
        // Older records without provenance cannot prove they came from AI.
        // Never infer provenance from Vietnamese text or from a cache hit.
        if (!hasOnlyAiBatches(record)) {
          await driver.delete(key);
          return null;
        }
        record.accessedAt = now();
        record.sizeBytes = byteLength({ ...record, sizeBytes: 0 });
        await driver.put(record);
        return clone(record);
      });
    }

    async function getCompatibleBatches(identity, inputHashes) {
      if (
        typeof identity?.chapterKey !== "string"
        || !identity.chapterKey
        || !inputHashes
        || typeof inputHashes !== "object"
        || Array.isArray(inputHashes)
      ) return null;
      const requested = Object.entries(inputHashes)
        .filter(([batchId, inputHash]) => typeof batchId === "string" && batchId && validInputHash(inputHash));
      if (!requested.length) return null;
      const matches = {};
      const records = (await driver.getAll()).sort((left, right) => (
        (right?.updatedAt || 0) - (left?.updatedAt || 0)
      ));
      for (const record of records) {
        const stored = storedIdentityFromKey(record);
        if (!stored?.chapterKey || !hasOnlyAiBatches(record)) continue;
        if (stored.chapterKey !== identity.chapterKey) continue;
        if (!["provider", "chapterId", "promptHash", "nameHash"].every(field => (
          typeof identity[field] === "string" && record[field] === identity[field]
        ))) continue;
        for (const [batchId, inputHash] of requested) {
          if (matches[batchId]) continue;
          const batch = record.batches?.[batchId];
          if (batch?.inputHash === inputHash && hasAiItems(batch.items)) matches[batchId] = clone(batch);
        }
      }
      return Object.keys(matches).length ? { batches: matches } : null;
    }

    async function putBatch(identity, batchId, items, metadata = {}) {
      if (typeof batchId !== "string" || batchId.length === 0) {
        throw new TypeError("batchId is required");
      }
      if (!Array.isArray(items)) throw new TypeError("items must be an array");

      const key = buildCacheKey(identity);
      return serializeKey(key, async () => {
        if (!hasAiItems(items)) {
          await driver.delete(key);
          return null;
        }
        const timestamp = now();
        const existing = await driver.get(key);
        const record = hasOnlyAiBatches(existing) ? existing : {
          key,
          ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])),
          createdAt: timestamp,
          batches: {}
        };
        if (typeof identity.chapterKey === "string" && typeof identity.batchHash === "string") {
          record.chapterKey = identity.chapterKey;
          record.batchHash = identity.batchHash;
        }
        record.batches = record.batches || {};
        record.batches[batchId] = {
          items: clone(items),
          savedAt: timestamp,
          ...(validInputHash(metadata.inputHash) ? { inputHash: metadata.inputHash.toLowerCase() } : {})
        };
        record.updatedAt = timestamp;
        record.accessedAt = timestamp;
        record.sizeBytes = byteLength({ ...record, sizeBytes: 0 });
        await driver.put(record);
        await prune();
        return clone(record);
      });
    }

    return Object.freeze({
      driver,
      limits: Object.freeze({ maxChapters, maxBytes }),
      getChapter,
      getCompatibleBatches,
      putBatch,
      prune,
      async listChapters() {
        return (await driver.getAll()).map(listedRecord);
      },
      async deleteChapter(identity) {
        const key = storedIdentityFromKey(identity)?.key || buildCacheKey(identity);
        await serializeKey(key, () => driver.delete(key));
      },
      async clearAll() {
        await Promise.allSettled(Array.from(keyQueues.values()));
        if (typeof driver.clear === "function") {
          await driver.clear();
          return;
        }
        for (const record of await driver.getAll()) await driver.delete(record.key);
      }
    });
  }

  return Object.freeze({
    DEFAULT_MAX_CHAPTERS,
    DEFAULT_MAX_BYTES,
    buildCacheKey,
    createCacheRepository,
    createIndexedDbDriver,
    createMemoryDriver
  });
});
