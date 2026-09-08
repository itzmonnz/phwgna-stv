(function attachPrefetch(root, factory) {
  const api = factory(root.STVAISites || (typeof require === 'function' ? require('../shared/stv-sites.js') : null),
    root.STVAIExtractor || (typeof require === 'function' ? require('./stv-extractor.js') : null),
    root.STVAICore || (typeof require === 'function' ? require('../shared/core.js') : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.STVAIPrefetch = Object.freeze({ ...api, request: root.fetch.bind(root) });
})(typeof globalThis !== "undefined" ? globalThis : this, function createPrefetchApi(sites, extractor, core) {
  "use strict";

  function safeChapterUrl(value, baseUrl) {
    return sites.chapterUrl(value, baseUrl);
  }

  function findNextChapterUrl(document, baseUrl) {
    const candidates = [
      ...document.querySelectorAll("a[rel='next'][href], a#btnnextchapter[href], a[href]")
    ];
    for (const node of candidates) {
      const label = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`;
      if (!node.matches("[rel='next'], #btnnextchapter, #navnexttop, #navnextbot") && !/chương\s*sau/i.test(label)) continue;
      const url = sites.nextChapterUrl(node.getAttribute("href"), baseUrl);
      if (url) return url;
    }
    return "";
  }

  // STV's live token merging removes spacing around Chinese words/punctuation.
  // Use the same source-only representation for hashing AND batching on both paths.
  // Do not change the reader DOM, Convert, or Name references; preserve Latin spaces.
  function prepareChapter(chapter) {
    const translatableBlocks = chapter.translatableBlocks.map(block => ({ ...block,
      text: extractor.normalizeSourceParagraph(block.text)
    }));
    return { ...chapter, translatableBlocks, sourceText: translatableBlocks.map(block => block.text).join('\n\n') };
  }

  function responseClass(status, ok) {
    const value = Number(status) || 0;
    if (value >= 200 && value < 300) return "2xx";
    if (value >= 300 && value < 400) return "3xx";
    if (value >= 400 && value < 500) return "4xx";
    if (value >= 500 && value < 600) return "5xx";
    return ok ? "2xx" : "unknown";
  }

  function bytesBucket(value) {
    const count = String(value || "").length;
    if (!count) return "0";
    if (count <= 1_000) return "1-1000B";
    if (count <= 10_000) return "1-10KB";
    if (count <= 100_000) return "10-100KB";
    return "100KB+";
  }

  function markerBucket(count) {
    const value = Number(count) || 0;
    if (value <= 0) return "0";
    if (value === 1) return "1";
    if (value <= 10) return "2-10";
    if (value <= 100) return "11-100";
    return "101+";
  }

  function createTrace(options) {
    const startedAt = Date.now();
    const trace = {
      stage: "request_page",
      failureCode: "none",
      nextLinkFound: true,
      elapsedBucket: "<1s",
      pageFetch: { attempted: false, responseClass: "unknown", redirectState: "unknown", bytesBucket: "0" },
      pageDom: { matchingRoot: false, cidMatches: false, initialSourceMarkers: "0", otherRootCount: "0" },
      endpoint: { attempted: false, responseClass: "unknown", redirectState: "unknown", jsonValid: false,
        payloadCodeOk: false, payloadIdentityMatch: false, dataBytesBucket: "0" },
      extraction: { attempted: false, state: "idle", errorCode: "none", blockCount: "0", batchCount: 0 }
    };
    const elapsedBucket = () => {
      const elapsed = Date.now() - startedAt;
      return elapsed < 1_000 ? "<1s" : elapsed < 5_000 ? "1-5s" : elapsed < 20_000 ? "5-20s" : "20s+";
    };
    return {
      update(patch = {}) {
        for (const [key, value] of Object.entries(patch)) {
          trace[key] = value && typeof value === "object" && !Array.isArray(value)
            ? { ...(trace[key] || {}), ...value }
            : value;
        }
        trace.elapsedBucket = elapsedBucket();
        options.onTrace?.(structuredClone(trace));
      },
      fail(code) { this.update({ stage: "failed", failureCode: String(code || "next_chapter_source_unavailable") }); }
    };
  }

  function waitForSourceRetry(delayMs, signal) {
    if (signal.aborted) return Promise.reject(new Error('next_chapter_cancelled'));
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new Error('next_chapter_cancelled'));
      };
      const timer = setTimeout(finish, Math.max(0, Number(delayMs) || 0));
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async function fetchChapter(options, signal) {
    const trace = options.trace;
    const url = safeChapterUrl(options.url, options.url);
    if (!url) throw new TypeError("next_chapter_url_invalid");
    const fetchOptions = { credentials: "same-origin", cache: "no-store", redirect: "error", signal };
    trace?.update({ stage: "request_page", pageFetch: { attempted: true } });
    const response = await options.request(url, fetchOptions);
    trace?.update({ pageFetch: { responseClass: responseClass(response?.status, response?.ok) } });
    if (!response?.ok) throw new Error("next_chapter_fetch_failed");
    const finalUrl = safeChapterUrl(response.url || url, url);
    trace?.update({ pageFetch: { redirectState: finalUrl?.replace(/\/$/, '') === url.replace(/\/$/, '') ? "same_url" : "changed" } });
    if (!finalUrl || finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, '')) throw new Error("next_chapter_redirect_invalid");
    const pageHtml = await response.text();
    trace?.update({ stage: "parse_page", pageFetch: { bytesBucket: bytesBucket(pageHtml) } });
    let document = options.parse(pageHtml, finalUrl);
    if (signal.aborted) throw new Error("next_chapter_cancelled");
    const [, , host, style, bookId, chapterId] = new URL(url).pathname.split('/');
    let root = sites.chapterRoot(document, url);
    const otherChapterRoots = Array.from(document.querySelectorAll('#content-container .contentbox[cid]'))
      .filter(node => !node.closest('template,script,style,noscript,[hidden]'));
    trace?.update({ pageDom: {
      matchingRoot: Boolean(root),
      cidMatches: root?.getAttribute('cid') === chapterId,
      initialSourceMarkers: markerBucket(root?.querySelectorAll('i[t]:not([t=""])').length || 0),
      otherRootCount: markerBucket(otherChapterRoots.filter(node => node !== root).length)
    } });
    if (!root) {
      if (otherChapterRoots.length) throw new Error('next_chapter_identity_mismatch');
      const container = document.querySelector('#content-container') || document.createElement('div');
      if (!container.isConnected) {
        container.id = 'content-container';
        (document.body || document.documentElement).append(container);
      }
      root = document.createElement('div');
      root.className = 'contentbox';
      root.setAttribute('cid', chapterId);
      container.append(root);
    }
    if (root.getAttribute('cid') !== chapterId) throw new Error("next_chapter_identity_mismatch");
    if (!root.querySelector('i[t]:not([t=""])')) {
      // Observed STV readchapter endpoint. No rescan/prefetch side effects, copied
      // cookies, dynamic challenge values, or execution of scripts from the page.
      const endpoint = new URL('/index.php', url);
      endpoint.search = new URLSearchParams({ bookid: bookId, h: host, c: chapterId, ngmar: 'readc', sajax: 'readchapter', sty: style, exts: '' }).toString();
      trace?.update({ stage: "request_source_api", endpoint: { attempted: true } });
      let payload;
      const retryDelays = (Array.isArray(options.sourceRetryDelaysMs)
        ? options.sourceRetryDelaysMs : [1_000, 2_000])
        .slice(0, 2).map(value => Math.min(5_000, Math.max(0, Number(value) || 0)));
      for (let attempt = 0; ; attempt += 1) {
        const dataResponse = await options.request(endpoint.href, { ...fetchOptions, method: 'POST', body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        trace?.update({ endpoint: { responseClass: responseClass(dataResponse?.status, dataResponse?.ok),
          redirectState: !dataResponse?.url || dataResponse.url === endpoint.href ? "same_url" : "changed" } });
        if (!dataResponse?.ok) throw new Error('next_chapter_fetch_failed');
        if (dataResponse.url && dataResponse.url !== endpoint.href) throw new Error('next_chapter_redirect_invalid');
        try {
          payload = JSON.parse(await dataResponse.text());
          trace?.update({ stage: "parse_source_api", endpoint: { jsonValid: true, dataBytesBucket: bytesBucket(payload?.data) } });
        } catch (_) { throw new Error('next_chapter_source_unavailable'); }
        if (signal.aborted) throw new Error('next_chapter_cancelled');
        const payloadCodeOk = [0, '0'].includes(payload?.code) && typeof payload.data === 'string' && Boolean(payload.data.trim());
        const payloadIdentityMatch = String(payload?.bookid) === bookId && payload?.bookhost === host;
        const payloadHasIdentity = payload?.bookid != null || payload?.bookhost != null;
        const payloadSourceEmpty = typeof payload?.data !== 'string' || !payload.data.trim();
        trace?.update({ endpoint: { payloadCodeOk, payloadIdentityMatch } });
        if (payloadHasIdentity && !payloadIdentityMatch) {
          throw new Error('next_chapter_identity_mismatch');
        }
        if (payloadCodeOk) {
          if (!payloadIdentityMatch) throw new Error('next_chapter_identity_mismatch');
          break;
        }
        if (!payloadSourceEmpty || attempt >= retryDelays.length) {
          throw new Error('next_chapter_source_unavailable');
        }
        await waitForSourceRetry(retryDelays[attempt], signal);
        trace?.update({ stage: "request_source_api" });
      }
      // Match the line-break preprocessing observed on STV. Parsing stays inert.
      const html = payload.data.replace(/<br\s*\/?>/gi, '<br><br>').replace(/\r?\n+/g, '<br><br>');
      const content = options.parse(html, url);
      content.querySelectorAll('script, style, noscript, iframe, object, embed').forEach(node => node.remove());
      root.replaceChildren(...Array.from(content.body.childNodes));
      trace?.update({ pageDom: { initialSourceMarkers: markerBucket(root.querySelectorAll('i[t]:not([t=""])').length) } });
    }
    let chapter;
    trace?.update({ stage: "extract_source", extraction: { attempted: true, state: "running" } });
    try { chapter = prepareChapter(options.extractor.extractChapter(document, { url })); }
    catch (error) {
      trace?.update({ extraction: { state: "failed", errorCode: ["SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE"].includes(error?.code) ? error.code : "UNEXPECTED" } });
      throw new Error('next_chapter_source_unavailable');
    }
    const batches = options.splitIntoBatches(chapter.translatableBlocks, { maxChars: 5000, maxBlocks: 30 })
      .slice(0, core.PREFETCH_BATCH_LIMIT);
    trace?.update({ stage: "ready", extraction: { state: "ok", errorCode: "none",
      blockCount: markerBucket(chapter.translatableBlocks.length), batchCount: batches.length } });
    return { url: finalUrl, chapter, batches };
  }

  async function loadNextChapter(options = {}) {
    const controller = new AbortController();
    const trace = createTrace(options);
    trace.update();
    let timer;
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); trace.fail('next_chapter_cancelled'); reject(new Error('next_chapter_cancelled')); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      timer = setTimeout(() => { controller.abort(); trace.fail('next_chapter_timeout'); reject(new Error('next_chapter_timeout')); }, options.timeoutMs ?? 20000);
    });
    try {
      if (controller.signal.aborted) return await stopped;
      try {
        return await Promise.race([stopped, fetchChapter({ ...options, trace }, controller.signal)]);
      } catch (error) {
        if (!controller.signal.aborted) trace.fail(error?.message);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  return Object.freeze({ safeChapterUrl, findNextChapterUrl, prepareChapter, loadNextChapter });
});
