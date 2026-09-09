(function attachDiagnostics(root, factory) {
  const api = factory(root.STVAISites || (typeof require === 'function' ? require('../shared/stv-sites.js') : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIDiagnostics = api;

  const inExtensionPage = typeof module !== "object"
    && root.document
    && root.location
    && root.chrome?.runtime?.onMessage;
  if (inExtensionPage && sitesHost(root.location)) {
    if (!root.STVAINativeTrace) {
      root.STVAINativeTrace = api.createNativeTraceTracker({ document: root.document, location: root.location });
    }
    if (!root.STVAIDiagnosticListener) root.STVAIDiagnosticListener = api.registerDiagnosticListener({
      runtime: root.chrome.runtime,
      document: root.document,
      location: root.location,
      rootObject: root
    });
  }
  function sitesHost(location) { return Boolean(root.STVAISites?.siteUrl(location.href)); }
})(typeof globalThis !== "undefined" ? globalThis : this, function createDiagnosticsApi(sites) {
  "use strict";

  const MESSAGE_TYPE = "STVAI_GET_PAGE_DIAGNOSTICS";

  function sanitizeHistorySync(value) {
    const allowedErrors = ['none', 'history_invalid_data', 'history_size_limit', 'history_stale_snapshot',
      'history_write_busy', 'history_write_uncertain', 'history_storage_unavailable', 'history_stale_document', 'history_read_mismatch',
      'history_unauthorized', 'history_insecure_origin', 'history_unavailable'];
    const count = number => Number.isSafeInteger(number) ? Math.max(0, Math.min(100000, number)) : 0;
    return {
      status: ['idle', 'synced', 'error'].includes(value?.status) ? value.status : 'unavailable',
      errorCode: allowedErrors.includes(value?.errorCode) ? value.errorCode : 'history_unavailable',
      recordCount: count(value?.recordCount), writeCount: count(value?.writeCount),
      toc: ['not_applicable', 'synced', 'history_toc_unrecognized'].includes(value?.toc) ? value.toc : 'not_applicable'
    };
  }

  function countBucket(value) {
    const count = Number(value) || 0;
    if (count <= 0) return "0";
    if (count === 1) return "1";
    return "many";
  }

  function markerBucket(value) {
    if (["0", "1", "2-10", "11-100", "101+"].includes(value)) return value;
    const count = Number(value) || 0;
    if (count <= 0) return "0";
    if (count === 1) return "1";
    if (count <= 10) return "2-10";
    if (count <= 100) return "11-100";
    return "101+";
  }

  // Passive, chapter-local counters only. Never retain text, IDs, event bodies or input activity.
  function createNativeTraceTracker({ document, location, now = Date.now }) {
    const selector = "a,img,picture,video,audio,svg,canvas,iframe,button,[role='button'],[onclick],[onmousedown],[ontouchup],.btn";
    let chapter, cid, url, seen, initialTokens, started, translatedAt = null, data;
    const bucket = elapsed => elapsed < 1000 ? "<1s" : elapsed < 5000 ? "1-5s" : elapsed <= 30000 ? "5-30s" : ">30s";
    function candidates(node) {
      if (node?.nodeType !== 1) return [];
      const found = node.matches(selector) ? [node] : Array.from(node.querySelectorAll(selector));
      return found.filter(item => !item.matches("i[t]")
        && !item.closest("script,template,.stvai-reader,.stvai-toolbar")
        && !item.parentElement?.closest(selector));
    }
    function observeNode(node, initial) {
      if (seen.has(node)) return;
      seen.add(node);
      const type = node.matches("button,[role='button'],.btn") ? "button" : node.matches("a") ? "link"
        : node.matches("img,picture,svg,canvas") ? "image" : node.matches("video,audio,iframe") ? "media" : "interactive";
      if (!data.candidateTypes.includes(type)) data.candidateTypes.push(type);
      for (const name of ["onclick", "onmousedown", "ontouchup"]) data.handlers[name] ||= node.hasAttribute(name);
      data[initial ? "initialNative" : "lateNative"]++;
      data.state = initial ? "native_present_initially" : data.view === "translation" ? "native_inserted_after_translation" : "native_inserted_late";
      if (data.firstSeenBucket === "none") data.firstSeenBucket = bucket(now() - started);
      data.sinceTranslationBucket = translatedAt === null ? "none" : bucket(now() - translatedAt);
    }
    function refresh() {
      const current = sites.chapterRoot(document, location.href);
      // Losing a root is evidence, not a new chapter that should erase the trace.
      if (!current && chapter && !chapter.isConnected && location.href === url) return false;
      if (current && current !== chapter && current.getAttribute("cid") === cid && location.href === url) {
        chapter = current;
        return false;
      }
      const identityChanged = current !== chapter || current?.getAttribute("cid") !== cid || location.href !== url;
      if (!identityChanged) return false;
      chapter = current; cid = current?.getAttribute("cid"); url = location.href;
      seen = new WeakSet(); started = now(); translatedAt = null;
      initialTokens = Array.from(chapter?.querySelectorAll("i[t]") || []);
      data = { state: "native_not_generated", view: "stv", initialTokens: initialTokens.length,
        initialNative: 0, lateNative: 0, movedNative: 0, restoredNative: 0, unresolvedNative: 0,
        candidateTypes: [], handlers: { onclick: false, onmousedown: false, ontouchup: false },
        firstSeenBucket: "none", sinceTranslationBucket: "none", boundary: "none" };
      for (const node of candidates(chapter)) observeNode(node, true);
      return true;
    }
    refresh();
    const observer = new document.defaultView.MutationObserver(records => {
      if (refresh()) return;
      for (const record of records) {
        if (!chapter?.contains(record.target) || record.target.closest?.(".stvai-reader")) continue;
        for (const added of record.addedNodes) for (const node of candidates(added)) observeNode(node, false);
      }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["cid"] });
    return {
      setView(view) { refresh(); if (view === "translation" && data.view !== view) translatedAt = now(); data.view = view; },
      record(event) {
        refresh();
        const field = { native_moved_to_reader: "movedNative", native_restored_to_source: "restoredNative", native_position_unresolved: "unresolvedNative" }[event.type];
        if (!field) return;
        data[field]++; data.state = event.type; data.boundary = event.boundary || "none";
      },
      snapshot() {
        refresh();
        const source = chapter?.querySelector(".stvai-native-source-layer") || chapter;
        const style = source ? document.defaultView.getComputedStyle(source) : null;
        const detached = chapter?.isConnected !== true || initialTokens.some(node => !node.isConnected);
        const rect = source?.getBoundingClientRect();
        return { ...data, handlers: { ...data.handlers }, candidateTypes: [...data.candidateTypes],
          state: detached ? "source_dom_detached" : data.state,
          rootConnected: chapter?.isConnected === true,
          sourceTreeState: detached ? chapter?.isConnected ? "replaced" : "detached" : "connected",
          currentTokens: chapter?.querySelectorAll("i[t]").length || 0,
          presentation: { display: style?.display, visibility: style?.visibility,
            opacity: !style ? "unavailable" : style.opacity === "0" ? "zero" : Number(style.opacity || 1) < 1 ? "partial" : "opaque",
            pointerEvents: !style ? "unavailable" : style.pointerEvents === "none" ? "none" : "active",
            hasSize: Boolean(rect?.width && rect?.height) } };
      },
      destroy() { observer.disconnect(); initialTokens = []; seen = new WeakSet(); chapter = null; }
    };
  }

  function isChapterPath(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean);
    return parts[0] === "truyen" && parts.length >= 4;
  }

  function readyState(value) {
    return ["loading", "interactive", "complete"].includes(value) ? value : "unknown";
  }

  function displayValue(value) {
    return ["none", "grid", "block", "flex", "inline", "inline-block"].includes(value)
      ? value
      : "other";
  }

  function visibilityValue(value) {
    return ["visible", "hidden", "collapse"].includes(value) ? value : "other";
  }

  function presentationFor(toolbar, styleReader) {
    if (!toolbar) {
      return {
        toolbarConnected: false,
        hiddenAttribute: false,
        display: "unavailable",
        visibility: "unavailable"
      };
    }

    let style;
    try {
      style = typeof styleReader === "function" ? styleReader(toolbar) : null;
    } catch (_error) {
      style = null;
    }
    return {
      toolbarConnected: toolbar.isConnected === true,
      hiddenAttribute: toolbar.hasAttribute("hidden"),
      display: style ? displayValue(style.display) : "unavailable",
      visibility: style ? visibilityValue(style.visibility) : "unavailable"
    };
  }

  function probeExtraction(extractorApi, document, url) {
    if (!extractorApi || typeof extractorApi.extractChapter !== "function") {
      return { state: "unavailable", errorCode: "none" };
    }
    try {
      extractorApi.extractChapter(document, { url, preserveNative: false });
      return { state: "ok", errorCode: "none" };
    } catch (error) {
      const code = ["SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE"].includes(error?.code)
        ? error.code
        : "UNEXPECTED";
      return { state: "failed", errorCode: code };
    }
  }

  function sanitizeBootstrap(value) {
    const input = value && typeof value === "object" ? value : {};
    const stages = new Set([
      "unknown",
      "script_started",
      "path_check",
      "not_chapter",
      "waiting_root",
      "root_timeout",
      "extracting",
      "reading_storage",
      "creating_toolbar",
      "inserting_toolbar",
      "registering_listener",
      "active"
    ]);
    const errors = new Set(["none", "SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE", "UNEXPECTED"]);
    const result = {
      stage: stages.has(input.stage) ? input.stage : "unknown",
      errorCode: errors.has(input.errorCode) ? input.errorCode : "UNEXPECTED"
    };
    if (input.batch && typeof input.batch === 'object') {
      const batch = input.batch;
      const count = (value, max = 10000) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.trunc(value))) : 0;
      const reasonCodes = ['none', 'ok', 'line_count_mismatch', 'response_id_mismatch', 'invalid_response', 'incomplete_response',
        'content_refused', 'response_timeout', 'send_not_confirmed', 'provider_unreachable', 'provider_unavailable', 'network_error'];
      result.batch = {
        batchIndex: count(batch.batchIndex), attempt: count(batch.attempt, 3),
        expectedCount: count(batch.expectedCount), actualCount: batch.actualCount === null ? null : count(batch.actualCount),
        stage: ['initial', 'retry_same_tab', 'switching_ready', 'exhausted'].includes(batch.stage) ? batch.stage : 'unknown',
        requestState: ['queued', 'sending', 'settled'].includes(batch.requestState) ? batch.requestState : 'unknown',
        reason: reasonCodes.includes(batch.reason) ? batch.reason : 'other'
      };
    }
    if (input.prefetch && typeof input.prefetch === "object") {
      const value = input.prefetch;
      const safeEnum = (candidate, allowed, fallback) => allowed.includes(candidate) ? candidate : fallback;
      const marker = candidate => markerBucket(candidate);
      const response = candidate => safeEnum(candidate, ["unknown", "2xx", "3xx", "4xx", "5xx"], "unknown");
      const redirect = candidate => safeEnum(candidate, ["unknown", "same_url", "changed"], "unknown");
      const bytes = candidate => safeEnum(candidate, ["0", "1-1000B", "1-10KB", "10-100KB", "100KB+"], "0");
      const pageFetch = value.pageFetch && typeof value.pageFetch === "object" ? value.pageFetch : {};
      const pageDom = value.pageDom && typeof value.pageDom === "object" ? value.pageDom : {};
      const endpoint = value.endpoint && typeof value.endpoint === "object" ? value.endpoint : {};
      const extraction = value.extraction && typeof value.extraction === "object" ? value.extraction : {};
      result.prefetch = {
        stage: safeEnum(value.stage, ["idle", "next_link", "request_page", "parse_page", "request_source_api", "request_source_warmup",
          "parse_source_api", "extract_source", "waiting_source", "dispatch_job", "running", "ready", "completed", "failed", "cancelled"], "idle"),
        failureCode: safeEnum(value.failureCode, ["none", "next_chapter_timeout", "next_chapter_fetch_failed",
          "next_chapter_source_unavailable", "next_chapter_identity_mismatch", "next_chapter_redirect_invalid",
          "next_chapter_end", "next_chapter_cancelled", "prefetch_not_allowed", "provider_unavailable",
          "send_not_confirmed", "ui_changed", "captcha", "login_required", "rate_limited"], "other"),
        elapsedBucket: safeEnum(value.elapsedBucket, ["<1s", "1-5s", "5-20s", "20s+"], "<1s"),
        nextLinkFound: value.nextLinkFound === true,
        pageFetch: { attempted: pageFetch.attempted === true, responseClass: response(pageFetch.responseClass),
          redirectState: redirect(pageFetch.redirectState), bytesBucket: bytes(pageFetch.bytesBucket) },
        pageDom: { matchingRoot: pageDom.matchingRoot === true, cidMatches: pageDom.cidMatches === true,
          initialSourceMarkers: marker(pageDom.initialSourceMarkers), otherRootCount: marker(pageDom.otherRootCount) },
        endpoint: { attempted: endpoint.attempted === true, responseClass: response(endpoint.responseClass),
          redirectState: redirect(endpoint.redirectState), jsonValid: endpoint.jsonValid === true,
          jsonEnvelope: safeEnum(endpoint.jsonEnvelope, ["clean", "prefixed", "empty", "invalid"], "unknown"),
          payloadCodeOk: endpoint.payloadCodeOk === true, payloadIdentityMatch: endpoint.payloadIdentityMatch === true,
          dataBytesBucket: bytes(endpoint.dataBytesBucket), warmupAttempted: endpoint.warmupAttempted === true,
          warmupResponseClass: safeEnum(endpoint.warmupResponseClass, ["unknown", "2xx", "3xx", "4xx", "5xx", "failed"], "unknown") },
        sourceWait: {
          state: safeEnum(value.sourceWait?.state, ["idle", "waiting", "resolved"], "idle"),
          retryCount: Math.max(0, Math.min(1000, Math.trunc(Number(value.sourceWait?.retryCount) || 0))),
          nextDelayBucket: safeEnum(value.sourceWait?.nextDelayBucket, ["none", "5s", "10s", "20s", "30s"], "none")
        },
        extraction: { attempted: extraction.attempted === true,
          state: safeEnum(extraction.state, ["idle", "running", "ok", "failed"], "idle"),
          errorCode: safeEnum(extraction.errorCode, ["none", "SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE", "UNEXPECTED"], "UNEXPECTED"),
          blockCount: marker(extraction.blockCount), batchCount: Math.max(0, Math.min(3, Number(extraction.batchCount) || 0)) }
      };
    }
    if (input.pool && typeof input.pool === "object") {
      const poolStates = new Set(["disabled", "preparing", "ready", "leased", "error"]);
      const poolErrors = new Set([
        "none", "", "provider_unreachable", "provider_tab_failed", "provider_unavailable",
        "warm_setup_failed", "warm_evidence_missing", "invalid_setup_response",
        "warm_session_lost", "warm_session_mismatch", "provider_origin_mismatch", "captcha", "login_required", "login_window_open",
        "security_verification", "login_browser_rejected",
        "rate_limit", "ab_choice", "temporary_chat_unavailable", "ui_changed"
      ]);
      const boundedCount = (count) => Math.max(0, Math.min(2, Number(count) || 0));
      result.pool = {
        state: poolStates.has(input.pool.state) ? input.pool.state : "error",
        readyCount: boundedCount(input.pool.readyCount),
        totalCount: boundedCount(input.pool.totalCount),
        leasedCount: boundedCount(input.pool.leasedCount),
        errorCode: poolErrors.has(input.pool.errorCode) ? (input.pool.errorCode || "none") : "other"
      };
      const rawUi = input.pool.uiDiagnostic;
      if (rawUi && typeof rawUi === "object") {
        const bounded = (value, limit) => String(value || "").slice(0, limit);
        result.pool.uiDiagnostic = {
          schemaVersion: 1,
          provider: rawUi.provider === "gemini" ? "gemini" : "chatgpt",
          temporaryActive: rawUi.temporaryActive === true,
          composerFound: rawUi.composerFound === true,
          candidateCount: Math.max(0, Math.min(200, Number(rawUi.candidateCount) || 0)),
          candidates: Array.isArray(rawUi.candidates) ? rawUi.candidates.slice(0, 8).map((item) => ({
            tag: bounded(item?.tag, 64), className: bounded(item?.className, 240),
            ariaLabel: bounded(item?.ariaLabel, 240), title: bounded(item?.title, 240),
            testId: bounded(item?.testId, 240), disabled: item?.disabled === true,
            score: Math.max(-100, Math.min(100, Number(item?.score) || 0))
          })) : []
        };
      }
    }
    return result;
  }

  function sanitizeNativeTrace(value) {
    const input = value && typeof value === "object" ? value : {};
    const allowedState = new Set([
      "native_present_initially", "native_inserted_late", "native_inserted_after_translation",
      "source_dom_detached", "native_position_unresolved", "native_not_generated",
      "native_moved_to_reader", "native_restored_to_source"
    ]);
    const allowedTypes = new Set(["button", "link", "image", "media", "interactive"]);
    const presentation = input.presentation && typeof input.presentation === "object"
      ? input.presentation : {};
    return {
      state: allowedState.has(input.state) ? input.state : "native_not_generated",
      view: ["stv", "translation", "chinese"].includes(input.view) ? input.view : "stv",
      rootConnected: input.rootConnected === true,
      sourceTreeState: ["connected", "detached", "replaced", "changed_chapter"].includes(input.sourceTreeState)
        ? input.sourceTreeState : "detached",
      initialTokens: markerBucket(input.initialTokens),
      currentTokens: markerBucket(input.currentTokens),
      initialNative: markerBucket(input.initialNative),
      lateNative: markerBucket(input.lateNative),
      movedNative: markerBucket(input.movedNative),
      restoredNative: markerBucket(input.restoredNative),
      unresolvedNative: markerBucket(input.unresolvedNative),
      candidateTypes: Array.from(new Set(Array.isArray(input.candidateTypes)
        ? input.candidateTypes.filter((item) => allowedTypes.has(item)).slice(0, 5) : [])),
      handlers: {
        onclick: input.handlers?.onclick === true,
        onmousedown: input.handlers?.onmousedown === true,
        ontouchup: input.handlers?.ontouchup === true
      },
      firstSeenBucket: ["none", "<1s", "1-5s", "5-30s", ">30s"].includes(input.firstSeenBucket)
        ? input.firstSeenBucket : "none",
      sinceTranslationBucket: ["none", "<1s", "1-5s", "5-30s", ">30s"].includes(input.sinceTranslationBucket)
        ? input.sinceTranslationBucket : "none",
      boundary: ["none", "before", "after", "both"].includes(input.boundary) ? input.boundary : "none",
      presentation: {
        display: displayValue(presentation.display),
        visibility: visibilityValue(presentation.visibility),
        opacity: ["zero", "partial", "opaque", "unavailable"].includes(presentation.opacity)
          ? presentation.opacity : "unavailable",
        pointerEvents: ["none", "active", "unavailable"].includes(presentation.pointerEvents)
          ? presentation.pointerEvents : "unavailable",
        hasSize: presentation.hasSize === true
      }
    };
  }

  function createDiagnosticSnapshot(options) {
    const document = options?.document;
    const location = options?.location;
    if (!document?.querySelectorAll || !location) {
      throw new TypeError("document and location are required");
    }

    const strictRoots = document.querySelectorAll("#content-container .contentbox[cid]");
    const strictRoot = sites.chapterRoot(document, location.href) || null;
    const sourceMarkersInRoot = strictRoot ? strictRoot.querySelectorAll("i[t]").length : 0;
    const toolbarElements = document.querySelectorAll(".stvai-toolbar");
    const chapterCandidate = isChapterPath(location.pathname);
    const extraction = probeExtraction(options.extractorApi, document, location.href);

    let status = "active";
    if (!chapterCandidate) status = "not_chapter";
    else if (strictRoots.length === 0) status = "chapter_root_missing";
    else if (sourceMarkersInRoot === 0) status = "source_missing";
    else if (toolbarElements.length === 0) {
      status = extraction.state === "failed" ? "extraction_failed" : "toolbar_missing";
    }

    const moduleInput = options.modules || {};
    const styleReader = options.getComputedStyle
      || document.defaultView?.getComputedStyle?.bind(document.defaultView);

    return {
      schemaVersion: 3,
      component: "stv-content",
      extensionVersion: typeof options.extensionVersion === "string" ? options.extensionVersion : "unknown",
      status,
      page: {
        originClass: sites.siteUrl(location.origin) ? "sangtacviet" : "other",
        pathClass: chapterCandidate ? "chapter_candidate" : "not_chapter",
        readyState: readyState(document.readyState),
        bodyPresent: Boolean(document.body)
      },
      modules: {
        diagnostics: true,
        core: moduleInput.core === true,
        extractor: moduleInput.extractor === true,
        ui: moduleInput.ui === true,
        chapter: moduleInput.chapter === true
      },
      selectors: {
        contentContainer: countBucket(document.querySelectorAll("#content-container").length),
        strictChapterRoot: countBucket(strictRoots.length),
        rootWithoutCid: countBucket(document.querySelectorAll("#content-container .contentbox").length),
        rootOutsideContainer: countBucket(document.querySelectorAll(".contentbox[cid]").length),
        knownChapterElement: countBucket(document.querySelectorAll("#cld-book-chapter").length),
        sourceMarkersInRoot: markerBucket(sourceMarkersInRoot),
        sourceMarkersInDocument: markerBucket(document.querySelectorAll("i[t]").length),
        imagesInRoot: countBucket(strictRoot ? strictRoot.querySelectorAll("img").length : 0),
        frames: countBucket(document.querySelectorAll("iframe").length),
        toolbar: countBucket(toolbarElements.length)
      },
      extraction,
      bootstrap: sanitizeBootstrap(options.bootstrapState),
      presentation: presentationFor(toolbarElements[0] || null, styleReader),
      nativeTrace: sanitizeNativeTrace(options.nativeTrace),
      historySync: sanitizeHistorySync(options.historySync)
    };
  }

  function registerDiagnosticListener(options) {
    const runtime = options?.runtime;
    if (!runtime?.onMessage?.addListener) {
      throw new TypeError("runtime.onMessage is required");
    }
    const rootObject = options.rootObject || {};
    const listener = (message, _sender, sendResponse) => {
      if (message?.type !== MESSAGE_TYPE) return false;
      const manifest = typeof runtime.getManifest === "function" ? runtime.getManifest() : {};
      const diagnostic = createDiagnosticSnapshot({
        document: options.document,
        location: options.location,
        extensionVersion: manifest?.version,
        extractorApi: rootObject.STVAIExtractor,
        bootstrapState: rootObject.STVAIBootstrapState,
        nativeTrace: rootObject.STVAINativeTrace?.snapshot?.(),
        historySync: rootObject.STVAIHistoryObserver?.snapshot?.(),
        getComputedStyle: rootObject.getComputedStyle?.bind(rootObject),
        modules: {
          core: Boolean(rootObject.STVAICore),
          extractor: Boolean(rootObject.STVAIExtractor),
          ui: Boolean(rootObject.STVAIUI),
          chapter: Boolean(rootObject.STVAIChapter)
        }
      });
      if (typeof sendResponse === "function") sendResponse({ ok: true, diagnostic });
      return false;
    };
    runtime.onMessage.addListener(listener);
    return () => runtime.onMessage.removeListener?.(listener);
  }

  return Object.freeze({
    MESSAGE_TYPE,
    countBucket,
    markerBucket,
    isChapterPath,
    probeExtraction,
    sanitizeBootstrap,
    sanitizeNativeTrace,
    sanitizeHistorySync,
    createNativeTraceTracker,
    createDiagnosticSnapshot,
    registerDiagnosticListener
  });
});
