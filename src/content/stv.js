(function attachChapterController(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIChapter = api;

  const inExtensionPage = typeof module !== "object"
    && root.document
    && root.chrome?.runtime
    && root.STVAICore
    && root.STVAIExtractor
    && root.STVAIUI
    && root.STVAITTSClient
    && root.STVAITTSPronunciation
    && root.STVAINameEditor
    && root.STVAINameManager
    && root.STVAINameAliases
    && root.STVAIPrefetch
    && root.STVAISites;
  if (inExtensionPage) {
    const bootstrapState = { stage: "script_started", errorCode: "none" };
    root.STVAIBootstrapState = bootstrapState;
    const dependencies = {
      document: root.document,
      location: root.location,
      runtime: root.chrome.runtime,
      storage: api.createRuntimeStorage(root.chrome.runtime),
      core: root.STVAICore,
      extractor: root.STVAIExtractor,
      ui: root.STVAIUI,
      ttsClient: root.STVAITTSClient,
      ttsPronunciation: root.STVAITTSPronunciation,
      nameEditor: root.STVAINameEditor,
      nameManager: root.STVAINameManager,
      nameAliases: root.STVAINameAliases,
      portableContent: root.STVAIPortableContent,
      prefetch: root.STVAIPrefetch,
      sites: root.STVAISites,
      networkRequest: root.STVAIPrefetch.request,
      parseHtml: (html) => new root.DOMParser().parseFromString(html, "text/html"),
      diagnosticState: bootstrapState
    };
    root.STVAIToolLifecycle = api.createToolLifecycle({
      runtime: root.chrome.runtime,
      document: root.document,
      sites: root.STVAISites,
      onDisable: () => root.STVAITTSClient.request(root.document, "release"),
      activate: (context) => api.bootstrap({ ...dependencies, ...context })
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createChapterModule() {
  "use strict";

  const MESSAGE_TYPES = Object.freeze({
    status: new Set(["STVAI_JOB_STATUS", "STV_JOB_STATUS"]),
    batch: new Set(["STVAI_BATCH_COMPLETE", "STV_BATCH_COMPLETE"]),
    complete: new Set(["STVAI_JOB_COMPLETE", "STV_JOB_COMPLETE"])
  });
  const AUTOMATION_CONSENT_VERSION = 2;
  const POOL_STATES = new Set(["preparing", "ready", "leased", "error", "disabled"]);
  const PREFETCH_SOURCE_RETRY_DELAYS_MS = Object.freeze([5_000, 10_000, 20_000, 30_000]);
  const SHARED_DOM_UI_SELECTOR = [
    ".stvai-toolbar",
    ".stvai-consent-backdrop",
    ".stvai-automation-consent-backdrop",
    ".stvai-tts-consent-backdrop",
    ".stvai-name-editor",
    ".stvai-name-manager",
    ".stvai-tts-pronunciation"
  ].join(",");

  function isTrustedUserGesture(event, view) {
    if (event?.isTrusted !== true) return false;
    const activation = view?.navigator?.userActivation;
    return !activation || activation.isActive === true;
  }

  function waitForPrefetchRetry(delayMs, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        resolve(value);
      };
      const aborted = () => finish(false);
      const timer = setTimeout(() => finish(true), Math.max(0, Number(delayMs) || 0));
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  function prefetchRetryDelayBucket(delayMs) {
    const value = Number(delayMs) || 0;
    if (value <= 5_000) return '5s';
    if (value <= 10_000) return '10s';
    if (value <= 20_000) return '20s';
    return '30s';
  }

  function isTrustedNativeInput(event) {
    return event?.isTrusted === true;
  }

  function installSharedDomEventGuard(document, verify = isTrustedUserGesture) {
    if (!document?.addEventListener || !document?.removeEventListener) {
      const noop = () => {};
      noop.protect = value => value;
      return noop;
    }
    const ownedNodes = new Set();
    const protectedRoots = new Set();
    const observers = new Set();
    const types = ["click", "change", "dblclick", "submit", "keydown", "keyup", "pointerdown"];
    const stopChapterArrowAtToolBoundary = (event) => {
      if (!["keydown", "keyup"].includes(event.type)
        || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const toolbar = document.querySelector?.(".stvai-toolbar");
      if (!toolbar?.isConnected || toolbar.dataset.collapsed === "true") return;
      // Preserve the browser's default caret/range behavior inside tool inputs,
      // but do not let STV's page-level chapter shortcut receive the key.
      event.stopPropagation?.();
    };
    const guardOwned = (event) => {
      if (verify(event, document.defaultView)) return;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    };
    const guard = (event) => {
      const path = event.composedPath?.() || [event.target];
      const owned = path.some(node => ownedNodes.has(node)
        || Boolean(node?.closest?.(SHARED_DOM_UI_SELECTOR)));
      if (owned) guardOwned(event);
    };
    const rememberTree = (root) => {
      if (!root?.addEventListener) return root;
      for (const node of [root, ...root.querySelectorAll?.("*") || []]) {
        if (ownedNodes.has(node)) continue;
        ownedNodes.add(node);
        // Keep the guard on the actual node even if the page detaches it.
        for (const type of types) node.addEventListener(type, guardOwned, true);
      }
      return root;
    };
    const protect = (root) => {
      if (!root || ownedNodes.has(root)) return root;
      rememberTree(root);
      protectedRoots.add(root);
      root.addEventListener("keydown", stopChapterArrowAtToolBoundary);
      root.addEventListener("keyup", stopChapterArrowAtToolBoundary);
      const Observer = document.defaultView?.MutationObserver;
      if (Observer) {
        const observer = new Observer(records => {
          for (const record of records) for (const node of record.addedNodes || []) rememberTree(node);
        });
        observer.observe(root, { childList: true, subtree: true });
        observers.add(observer);
      }
      return root;
    };
    for (const root of document.querySelectorAll?.(SHARED_DOM_UI_SELECTOR) || []) protect(root);
    for (const type of types) document.addEventListener(type, guard, true);
    const remove = () => {
      for (const type of types) document.removeEventListener(type, guard, true);
      for (const root of protectedRoots) {
        root.removeEventListener("keydown", stopChapterArrowAtToolBoundary);
        root.removeEventListener("keyup", stopChapterArrowAtToolBoundary);
      }
      protectedRoots.clear();
      for (const observer of observers) observer.disconnect();
      observers.clear();
      // Retained page references must never resurrect synthetic actions.
      // Node-local guards are collected with their nodes; release our references.
      ownedNodes.clear();
    };
    remove.protect = protect;
    return remove;
  }

  function setDiagnosticState(value, stage, errorCode = "none") {
    if (!value || typeof value !== "object") return;
    value.stage = stage;
    value.errorCode = errorCode;
  }

  function createDefaultJobId() {
    const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `stv-${suffix}`;
  }

  function storageGet(storage, keys) {
    return new Promise((resolve) => {
      try {
        storage.get(keys, (value) => resolve(value || {}));
      } catch (_error) {
        resolve({});
      }
    });
  }

  function storageSet(storage, value) {
    return new Promise((resolve, reject) => {
      try {
        storage.set(value, (writeError) => {
          const error = writeError || globalThis.chrome?.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function sendRuntime(runtime, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      try {
        const possiblePromise = runtime.sendMessage(message, (response) => {
          const runtimeError = globalThis.chrome?.runtime?.lastError;
          finish(response, runtimeError ? new Error(runtimeError.message) : null);
        });
        if (possiblePromise && typeof possiblePromise.then === "function") {
          possiblePromise.then((response) => finish(response), (error) => finish(undefined, error));
        }
      } catch (error) {
        finish(undefined, error);
      }
    });
  }

  function createRuntimeStorage(runtime) {
    return Object.freeze({
      get(keys, callback) {
        sendRuntime(runtime, { type: "STVAI_STORAGE_GET", keys }).then(
          (response) => callback?.(response?.values || {}),
          () => callback?.({})
        );
      },
      set(values, callback) {
        sendRuntime(runtime, { type: "STVAI_STORAGE_SET", values }).then(
          (response) => callback?.(response?.ok === true ? undefined : new Error('storage_write_failed')),
          () => callback?.(new Error('storage_write_failed'))
        );
      }
    });
  }

  function reasonLabel(reason) {
    const labels = {
      captcha: "Google yêu cầu xác minh; xử lý CAPTCHA trong tab Gemini rồi bấm Tiếp tục.",
      login: "Hãy đăng nhập trong tab AI rồi bấm Tiếp tục.",
      login_required: "Hãy đăng nhập trong tab AI rồi bấm Tiếp tục.",
      login_window_open: "Cửa sổ Chrome đăng nhập đã được mở. Đăng nhập xong, đóng cửa sổ đó rồi bấm Tiếp tục.",
      security_verification: "Google yêu cầu xác minh; xử lý CAPTCHA trong tab Gemini rồi bấm Tiếp tục.",
      login_browser_rejected: "Google từ chối cửa sổ tự động. Hãy mở cửa sổ Đăng nhập Chrome AI, đăng nhập xong rồi bấm Tiếp tục.",
      "rate-limit": "Dịch vụ AI đang giới hạn lượt. Hãy chờ rồi bấm Tiếp tục.",
      rate_limited: "Dịch vụ AI đang giới hạn lượt. Hãy chờ rồi bấm Tiếp tục.",
      "temporary-chat": "Temporary Chat chưa sẵn sàng. Kiểm tra tab AI rồi bấm Tiếp tục.",
      temporary_unavailable: "Temporary Chat chưa sẵn sàng. Kiểm tra tab AI rồi bấm Tiếp tục.",
      "ui-changed": "Không nhận diện được giao diện AI. Tiến độ đã được giữ lại.",
      ui_changed: "Không nhận diện được giao diện AI. Tiến độ đã được giữ lại.",
      ab_comparison: "ChatGPT đang yêu cầu chọn phản hồi. Hãy chọn thủ công rồi bấm Tiếp tục.",
      provider_tab_closed: "Tab AI đã đóng. Bấm Tiếp tục để mở một tab mới.",
      provider_unreachable: "Không kết nối được adapter trong tab AI. Hãy tải lại tab rồi bấm Tiếp tục.",
      api_client_unavailable: "Mô-đun API chưa sẵn sàng. Hãy tải lại tiện ích.",
      api_key_missing: "Chưa có API key cho dịch vụ đã chọn. Hãy nhập key trong Cài đặt.",
      invalid_api_key: "API key không hợp lệ hoặc không có quyền truy cập.",
      insufficient_credit: "Tài khoản API không đủ số dư/hạn mức.",
      safety_setting_unsupported: "Model Gemini này không chấp nhận Off Safety. Hãy đổi model hoặc tắt tùy chọn này.",
      api_returned_source_language: "API trả lại nội dung tiếng Trung. Đã thử sửa một lần và dừng để không chèn bản dịch sai.",
      provider_unavailable: "Dịch vụ API đang không khả dụng. Tiến độ đã được giữ lại.",
      network_error: "Không kết nối được dịch vụ API. Kiểm tra mạng rồi bấm Tiếp tục.",
      response_timeout: "Dịch vụ API phản hồi quá lâu. Tiến độ đã được giữ lại.",
        content_refused: "AI từ chối nội dung. Đã dừng; không tự thay bằng Convert.",
        diagnostic_tab_retained: "Đã giữ tab AI lỗi để chẩn đoán. Hãy lấy báo cáo rồi tự đóng tab.",
        send_not_confirmed: "Chưa xác nhận gửi — đã dừng để tránh gửi trùng.",
        provider_unreachable: "Mất kết nối với tab AI — đã dừng để tránh gửi trùng.",
        batch_recovery_exhausted: "Batch chưa hoàn tất — bấm Tiếp tục để thử lại.",
        legacy_recovery_discarded: "Đã bỏ hàng đợi tách nhóm cũ. Bấm Tiếp tục để thử lại nguyên batch.",
        provider_tab_close_failed: "Chưa đóng được tab AI lỗi. Đã dừng để tránh mở thừa tab.",
        fallback_unavailable: "Batch chưa có bản dịch AI. Bấm Tiếp tục để thử lại.",
      recovery_limit_reached: "Đã đạt giới hạn thử cứu batch. Tạm dừng để tránh gửi lặp.",
      invalid_response: "AI trả phản hồi không hợp lệ. Tiến độ đã hoàn thành vẫn được giữ.",
      service_worker_restarted: "Tiện ích nền vừa khởi động lại. Tiến độ đã giữ; bấm Tiếp tục."
    };
    return labels[reason] || "Quá trình dịch đang tạm dừng. Kiểm tra tab AI rồi bấm Tiếp tục.";
  }

  function sanitizedSettings(core, value) {
    const normalized = core.normalizeSettings(value || {});
    return {
      provider: normalized.provider,
      webAiTabCount: normalized.webAiTabCount,
      temporaryChat: normalized.temporaryChat,
      systemPrompt: normalized.systemPrompt,
      userPrompt: normalized.userPrompt,
      nameGuide: normalized.nameGuide,
      ttsPronunciationGuide: normalized.ttsPronunciationGuide,
      ttsPronunciationDefaultsVersion: normalized.ttsPronunciationDefaultsVersion,
      settingsDefaultsVersion: normalized.settingsDefaultsVersion,
      openrouterModel: normalized.openrouterModel,
      geminiApiModel: normalized.geminiApiModel,
      openaiApiModel: normalized.openaiApiModel,
      deepseekApiModel: normalized.deepseekApiModel,
      geminiSafetyOff: normalized.geminiSafetyOff,
      apiTemperature: normalized.apiTemperature,
      warmPoolEnabled: normalized.warmPoolEnabled === true || value?.warmPoolEnabled === true,
      autoTranslateOnChapter: normalized.autoTranslateOnChapter === true || value?.autoTranslateOnChapter === true
    };
  }

  function boundedCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.min(99, Math.max(0, Math.trunc(count))) : 0;
  }

  function safePoolErrorCode(value) {
    const code = String(value || "");
    return /^[a-z0-9_-]{1,64}$/i.test(code) ? code : "pool_error";
  }

  function sanitizePoolStatus(message) {
    const state = POOL_STATES.has(message?.state) ? message.state : "disabled";
    const readyCount = boundedCount(message?.readyCount);
    const leasedCount = boundedCount(message?.leasedCount);
    const totalCount = Math.max(readyCount, leasedCount, boundedCount(message?.totalCount));
    const targetCount = Math.min(5, Math.max(2, boundedCount(message?.targetCount) || 2));
    const bounded = (input, limit) => String(input || "").slice(0, limit);
    const rawDiagnostic = message?.uiDiagnostic;
    const uiDiagnostic = rawDiagnostic && typeof rawDiagnostic === "object" ? {
      schemaVersion: 1,
      provider: rawDiagnostic.provider === "gemini" ? "gemini" : "chatgpt",
      temporaryActive: rawDiagnostic.temporaryActive === true,
      composerFound: rawDiagnostic.composerFound === true,
      candidateCount: Math.max(0, Math.min(200, Number(rawDiagnostic.candidateCount) || 0)),
      candidates: Array.isArray(rawDiagnostic.candidates) ? rawDiagnostic.candidates.slice(0, 8).map((item) => ({
        tag: bounded(item?.tag, 64), className: bounded(item?.className, 240),
        ariaLabel: bounded(item?.ariaLabel, 240), title: bounded(item?.title, 240),
        testId: bounded(item?.testId, 240), disabled: item?.disabled === true,
        score: Math.max(-100, Math.min(100, Number(item?.score) || 0))
      })) : []
    } : undefined;
    return {
      state,
      readyCount,
      totalCount,
      leasedCount,
      targetCount,
      generalCount: Object.hasOwn(message || {}, "generalCount")
        ? Math.min(targetCount, boundedCount(message?.generalCount)) : targetCount,
      prefetchCount: Math.min(1, boundedCount(message?.prefetchCount)),
      generalReadyCount: Math.min(targetCount, boundedCount(message?.generalReadyCount)),
      prefetchState: POOL_STATES.has(message?.prefetchState) ? message.prefetchState : "disabled",
      reconfiguring: message?.reconfiguring === true,
      slotIndex: Math.max(1, boundedCount(message?.slotIndex) || leasedCount || 1),
      errorCode: state === "error" ? safePoolErrorCode(message?.errorCode) : "none",
      uiDiagnostic
    };
  }

  function createChapterController(dependencies) {
    const {
      document,
      location,
      runtime,
      storage,
      core,
      extractor,
      ui,
      ttsClient,
      ttsPronunciation,
      nameEditor,
      nameManager,
      nameAliases,
      portableContent,
      prefetch,
      networkRequest,
      parseHtml,
      diagnosticState,
      signal,
      prefetchRetryDelaysMs = PREFETCH_SOURCE_RETRY_DELAYS_MS,
      prefetchRetryWait = waitForPrefetchRetry,
      historyNavigation: navigatedThroughHistory = false,
      sameDocumentNavigation = false,
      createJobId = createDefaultJobId
    } = dependencies;

    const state = {
      status: "idle",
      view: "stv",
      translations: Object.create(null),
      translationOrigins: Object.create(null),
      fallbackCount: 0,
      completedBatches: 0,
      completedBatchIndexes: new Set(),
      batchAssignments: new Map(),
      totalBatches: 1,
      prefetchCompleted: 0,
      prefetchTotal: 0,
      prefetchRunning: false,
      prefetchCacheable: true,
      activeJobId: null,
      ttsActive: false,
      ttsPending: false,
      firstBatchReady: false,
      pool: {
        state: "disabled",
        readyCount: 0,
        totalCount: 0,
        leasedCount: 0,
        targetCount: 2,
        generalCount: 2,
        prefetchCount: 0,
        generalReadyCount: 0,
        prefetchState: "disabled",
        reconfiguring: false,
        errorCode: "none"
      }
    };
    let active = false;
    let destroyed = false;
    let chapter;
    let settings;
    let consent = false;
    let automationConsentVersion = 0;
    let automationConsentProvider = "";
    let ttsConsent = false;
    let ttsOverlayDrag;
    let toolbar;
    let nameEditorInstance;
    let nameManagerInstance;
    let toolbarPositionController;
    let uiScale = 1;
    let copyrightGuard;
    let nativeSync;
    let removeSharedDomEventGuard;
    let removeNativeListenGestureGuard;
    let trustedNativeListenGesture = false;
    let messageListener;
    let pending = Promise.resolve();
    let prefetchStarted = false;
    let prefetchJobId = "";
    let prefetchAbort = null;
    let prefetchGeneration = 0;
    let prefetchStatus = "";
    let toolbarStatus = "Sẵn sàng";
    let captchaRetry = false;
    let poolCaptchaCode = "";
    let originalViewPinned = false;
    const captchaToastMessage = "Dính captcha, xác thực xong ấn dịch lại";

    function setCaptchaRetry(reason) {
      captchaRetry = ["captcha", "security_verification"].includes(reason);
      if (captchaRetry) {
        ui.showToast?.(document, captchaToastMessage, { timeoutMs: 3_000 });
      }
      return captchaRetry;
    }

    function setPrefetchDiagnostic(patch = {}) {
      if (!diagnosticState || typeof diagnosticState !== "object") return;
      diagnosticState.prefetch = {
        ...(diagnosticState.prefetch || {}),
        ...patch,
        ...(patch.pageFetch ? { pageFetch: { ...(diagnosticState.prefetch?.pageFetch || {}), ...patch.pageFetch } } : {}),
        ...(patch.pageDom ? { pageDom: { ...(diagnosticState.prefetch?.pageDom || {}), ...patch.pageDom } } : {}),
        ...(patch.endpoint ? { endpoint: { ...(diagnosticState.prefetch?.endpoint || {}), ...patch.endpoint } } : {}),
        ...(patch.extraction ? { extraction: { ...(diagnosticState.prefetch?.extraction || {}), ...patch.extraction } } : {})
      };
    }

    function stopPrefetch() {
      ++prefetchGeneration;
      prefetchAbort?.abort();
      prefetchAbort = null;
      const jobId = prefetchJobId;
      prefetchJobId = "";
      prefetchStatus = "";
      state.prefetchCompleted = 0;
      state.prefetchTotal = 0;
      state.prefetchRunning = false;
      state.prefetchCacheable = true;
      if (active && toolbar) updateToolbar();
      return jobId ? sendRuntime(runtime, { type: "STV_CANCEL_JOB", jobId, reason: "prefetch_superseded" }).catch(() => undefined) : Promise.resolve();
    }

    function reportPrefetch(label) {
      prefetchStatus = label;
      if (active && state.status === 'completed') updateToolbar(label);
    }

    function prefetchErrorLabel(code) {
      const labels = {
        next_chapter_timeout: 'STV tải nguồn quá lâu',
        next_chapter_fetch_failed: 'không tải được nguồn STV',
        next_chapter_source_unavailable: 'STV chưa cung cấp nguồn Trung',
        next_chapter_identity_mismatch: 'nguồn không khớp chương kế',
        next_chapter_redirect_invalid: 'STV chuyển hướng sang trang khác',
        prefetch_not_allowed: 'chưa được phép hoặc đang có tác vụ khác',
        captcha: 'cần xử lý CAPTCHA trên tab AI',
        login_required: 'cần đăng nhập trên tab AI',
        rate_limited: 'AI đang giới hạn lượt',
        user_cancelled: 'đã hủy',
        tool_disabled: 'tool đang tắt'
      };
      return labels[code] || 'AI chưa sẵn sàng; kiểm tra tab AI';
    }

    function reportPrefetchFailure(code) {
      reportPrefetch(code === 'next_chapter_end'
        ? 'Đã đến chương cuối.'
        : `Dịch trước dừng: ${prefetchErrorLabel(code)}.`);
    }
    let ttsSessionId = "";
    let ttsGeneration = 0;
    let ttsOpening = false;
    let ttsCompleted = false;
    let ttsPausedForName = false;
    let unsubscribeTts;
    const chapterUrl = location.href;

    function nextListeningUrl() {
      const node = document.querySelector('#navnexttop[href], #navnextbot[href], a[rel="next"][href]');
      const candidate = node?.getAttribute('href') || prefetch?.findNextChapterUrl?.(document, chapterUrl);
      try {
        const url = new URL(candidate, chapterUrl);
        const current = new URL(chapterUrl);
        url.hash = '';
        return candidate && url.origin === current.origin && url.href !== current.href
          && url.pathname.split('/').slice(0, 5).join('/') === current.pathname.split('/').slice(0, 5).join('/')
          ? url.href : '';
      } catch (_error) { return ''; }
    }

    function enqueue(work) {
      pending = pending.then(work, work);
      return pending;
    }

    function runNow(work) {
      let result;
      try {
        result = Promise.resolve(work());
      } catch (error) {
        result = Promise.reject(error);
      }
      pending = pending.then(() => result, () => result);
      return result;
    }

    function hasVerifiedCompleteTranslation(reader) {
      if (!reader || state.status !== "completed" || state.fallbackCount !== 0) return false;
      if (!Number.isInteger(state.totalBatches) || state.totalBatches < 1) return false;
      for (let index = 0; index < state.totalBatches; index += 1) {
        if (!state.completedBatchIndexes.has(index)) return false;
      }
      if (!chapter.translatableBlocks.length) return false;
      const rendered = new Map(Array.from(reader.querySelectorAll("[data-block-id]"), (node) => [
        String(node.dataset.blockId || ""),
        node
      ]));
      return chapter.translatableBlocks.every((block) => {
        const id = String(block.id);
        const translated = typeof state.translations[id] === "string" ? state.translations[id].trim() : "";
        const paragraph = rendered.get(id);
        return Boolean(translated)
          && state.translationOrigins[id] === "ai"
          && paragraph?.textContent?.trim() === translated;
      });
    }

    function renderView(name) {
      if (!chapter || !toolbar) return;
      state.view = name;
      document.defaultView?.STVAINativeTrace?.setView(name);
      if (name === "stv") {
        ui.setChapterCompleteNotice(
          chapter.container.querySelector(".stvai-reader--translation"),
          false
        );
        copyrightGuard?.destroy();
        copyrightGuard = undefined;
        nameEditorInstance?.bind(null);
        chapter.container.hidden = false;
        nativeSync?.showOriginal({ preserveReader: state.ttsActive || ttsOpening });
        return;
      }
      const mode = name === "chinese" ? "chinese" : "translation";
      let reader = mode === "translation"
        ? nativeSync?.getBackgroundReader?.()
          || chapter.container.querySelector(".stvai-reader--translation")
        : null;
      if (reader) {
        ui.updateReaderView(reader, chapter.blocks, state.translations, mode, state.translationOrigins);
      } else {
        reader = ui.createReaderView(document, chapter.blocks, state.translations, mode, state.translationOrigins);
        reader.classList.add("stvai-reader--inline");
      }
      chapter.container.hidden = false;
      nativeSync.showReader(reader);
      ui.setChapterCompleteNotice(
        reader,
        name === "translation" && hasVerifiedCompleteTranslation(reader)
      );
      const hasTranslation = name === "translation"
        && Object.values(state.translations).some((text) => typeof text === "string" && text.trim());
      if (hasTranslation && !copyrightGuard) {
        copyrightGuard = ui.createCopyrightGuard(document, chapter.container);
      } else if (!hasTranslation && copyrightGuard) {
        copyrightGuard.destroy();
        copyrightGuard = undefined;
      }
      if (name === "translation") nameEditorInstance?.bind(reader);
      else nameEditorInstance?.bind(null);
      reader.dataset.stvaiTtsReady = String(state.firstBatchReady);
    }

    function updateToolbar(value) {
      if (typeof value === "string" && value.trim()) toolbarStatus = value;
      ui.setToolbarState(toolbar, {
        state: state.status,
        status: toolbarStatus,
        running: state.status === "running" || state.status === "waiting-provider",
        paused: state.status === "paused",
        completed: state.completedBatches,
        completedIndexes: Array.from(state.completedBatchIndexes),
        total: state.totalBatches,
        prefetchCompleted: state.prefetchCompleted,
        prefetchTotal: state.prefetchTotal,
        prefetchRunning: state.prefetchRunning,
        prefetchCacheable: state.prefetchCacheable,
        showingOriginal: state.view === "stv",
        canListen: state.firstBatchReady || listeningCanQueue(),
        listening: state.ttsActive,
        listeningPending: state.ttsPending || ttsOpening,
        captchaRetry
      });
    }

    function reportAction(value) {
      updateToolbar(value);
      ui.showToast?.(document, value, { kind: "notice", timeoutMs: 1_500 });
    }

    function listeningCanQueue() {
      return Boolean(state.activeJobId) && ["running", "waiting-provider"].includes(state.status);
    }

    function reportListening(message) {
      updateToolbar();
      ui.announceToolbar?.(toolbar, message);
    }

    const ttsListeningStates = new Set([
      "absent", "ready", "playing", "user_paused", "menu_paused", "waiting_batch", "completed"
    ]);

    function setTtsDiagnostic(patch = {}) {
      if (!diagnosticState || typeof diagnosticState !== "object") return;
      diagnosticState.tts = {
        ...(diagnosticState.tts || {}),
        controllerActive: state.ttsActive === true,
        pending: state.ttsPending === true,
        opening: ttsOpening === true,
        ...patch
      };
    }

    function recordAttachmentEvidence(stateName, reason, message, itemCount = 0) {
      if (!diagnosticState || typeof diagnosticState !== "object") return;
      diagnosticState.attachment = {
        state: stateName,
        reason,
        messageType: MESSAGE_TYPES.batch.has(message?.type) ? "batch"
          : MESSAGE_TYPES.complete.has(message?.type) ? "complete" : "other",
        batchIndex: Number.isInteger(Number(message?.batchIndex)) ? Math.max(0, Number(message.batchIndex)) : 0,
        itemCount: Math.max(0, Number(itemCount) || 0)
      };
    }

    function sourceAttachmentEvidence() {
      if (typeof extractor.validateChapterEvidence === "function") {
        return extractor.validateChapterEvidence(document, chapter, location.href);
      }
      return chapter?.container?.isConnected
        ? { ok: true, reason: "confirmed" }
        : { ok: false, reason: "source_container_detached" };
    }

    function validateTranslationItems(message, { completion = false } = {}) {
      const sourceEvidence = sourceAttachmentEvidence();
      if (!sourceEvidence.ok) return sourceEvidence;
      const items = Array.isArray(message?.items) ? message.items : [];
      if (!completion && !items.length) return { ok: false, reason: "items_empty" };
      const sourceOrder = new Map(chapter.translatableBlocks.map((block, index) => [String(block.id), index]));
      const seen = new Set();
      let previousIndex = -1;
      for (const item of items) {
        const id = typeof item?.id === "string" ? item.id : "";
        const text = typeof item?.text === "string" ? item.text.trim() : "";
        if (!id || !text) return { ok: false, reason: "item_invalid" };
        if (!sourceOrder.has(id)) return { ok: false, reason: "item_unknown" };
        if (seen.has(id)) return { ok: false, reason: "item_duplicate" };
        const index = sourceOrder.get(id);
        if (index <= previousIndex) return { ok: false, reason: "items_out_of_order" };
        previousIndex = index;
        seen.add(id);
        const existing = typeof state.translations[id] === "string" ? state.translations[id].trim() : "";
        if (existing && existing !== text) return { ok: false, reason: "item_conflict" };
      }
      if (!completion) {
        const batchIndex = Number(message.batchIndex);
        const totalBatches = Number(message.totalBatches);
        if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches)
          || totalBatches < 1 || batchIndex >= totalBatches) {
          return { ok: false, reason: "batch_identity_invalid" };
        }
        for (const id of seen) {
          const assigned = state.batchAssignments.get(id);
          if (assigned !== undefined && assigned !== batchIndex) {
            return { ok: false, reason: "block_batch_conflict" };
          }
        }
      } else {
        const translatedIds = new Set(Object.entries(state.translations)
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([id]) => id));
        for (const id of seen) translatedIds.add(id);
        if (!chapter.translatableBlocks.every(block => translatedIds.has(String(block.id)))) {
          return { ok: false, reason: "completion_incomplete" };
        }
      }
      return { ok: true, reason: "confirmed", items, ids: seen };
    }

    function rejectAttachment(message, evidence) {
      recordAttachmentEvidence("rejected", evidence.reason, message, message?.items?.length);
      updateToolbar("Đã chặn dữ liệu dịch không khớp nội dung gốc; tiến độ cũ được giữ lại.");
      return true;
    }

    function installNativeListenGestureGuard() {
      const verify = typeof dependencies.isTrustedNativeEvent === "function"
        ? dependencies.isTrustedNativeEvent
        : isTrustedNativeInput;
      const types = ["click", "pointerup", "touchend"];
      const remember = event => {
        const relay = event.target?.closest?.("[data-stvai-native-action-relay='true']");
        if (!relay || !chapter?.container?.contains(relay) || !verify(event)) return;
        trustedNativeListenGesture = true;
        document.defaultView?.queueMicrotask?.(() => { trustedNativeListenGesture = false; });
      };
      for (const type of types) document.addEventListener(type, remember, true);
      return () => {
        for (const type of types) document.removeEventListener(type, remember, true);
        trustedNativeListenGesture = false;
      };
    }

    function mergeItems(items) {
      let merged = 0;
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item.id !== "string" || typeof item.text !== "string") continue;
        if (!chapter.translatableBlocks.some((block) => block.id === item.id)) continue;
        state.translations[item.id] = item.text;
        state.translationOrigins[item.id] = item.origin === "convert" ? "convert" : "ai";
        merged += 1;
      }
      if (state.view === "translation") renderView("translation");
      else if (state.ttsActive) {
        const backgroundReader = nativeSync?.getBackgroundReader?.();
        if (backgroundReader) {
          ui.updateReaderView(backgroundReader, chapter.blocks, state.translations, "translation", state.translationOrigins);
          backgroundReader.dataset.stvaiTtsReady = String(state.firstBatchReady);
        }
      }
      return merged;
    }

    function sendTts(action) {
      if (!ttsClient?.request) return Promise.reject(new Error("Trình kết nối Nghe sách chưa sẵn sàng."));
      const options = action === "open" ? {
        pronunciations: ttsPronunciation?.parseGuide?.(settings.ttsPronunciationGuide) || []
      } : undefined;
      return ttsClient.request(document, action, options);
    }

    async function inspectListening() {
      setTtsDiagnostic({ stage: "inspecting", lastAction: "inspect", outcome: "none" });
      const result = await sendTts("inspect").catch(() => null);
      const listeningState = ttsListeningStates.has(result?.listeningState)
        ? result.listeningState : "unknown";
      setTtsDiagnostic({
        stage: listeningState === "unknown" ? "degraded" : "inspected",
        listeningState,
        lastAction: "inspect",
        outcome: listeningState === "unknown" ? "failed" : "ok"
      });
      return listeningState;
    }

    async function reconcileListening({ adopt = false } = {}) {
      const listeningState = await inspectListening();
      if (listeningState === "unknown") return { known: false, active: state.ttsActive, listeningState };
      const bridgeActive = listeningState !== "absent";
      if (state.ttsActive && !bridgeActive) {
        state.ttsActive = false;
        ttsCompleted = false;
        ttsOverlayDrag?.setEnabled?.(false);
        updateToolbar();
      } else if (adopt && !state.ttsActive && Boolean(ttsSessionId) && bridgeActive) {
        state.ttsActive = true;
        state.ttsPending = false;
        ttsCompleted = listeningState === "completed";
        ttsOverlayDrag?.setEnabled?.(true);
        ttsOverlayDrag?.refresh?.();
        updateToolbar();
      }
      setTtsDiagnostic({
        stage: bridgeActive ? "active" : "ready",
        listeningState,
        outcome: "ok"
      });
      return { known: true, active: bridgeActive, listeningState };
    }

    async function rearmListening() {
      if (!active || !state.ttsActive) return false;
      const result = await sendTts("resume").catch(() => null);
      if (result?.ok) {
        setTtsDiagnostic({ stage: "active", lastAction: "resume", outcome: "ok" });
        return true;
      }
      setTtsDiagnostic({ stage: "degraded", lastAction: "resume", outcome: "failed" });
      reportListening("Nghe sách chưa tự chạy lại — hãy mở player STV để tiếp tục.");
      return false;
    }

    async function stopListening(statusMessage = "") {
      const hadSession = state.ttsActive || state.ttsPending || ttsOpening || ttsSessionId;
      const hadPlayer = state.ttsActive || ttsOpening;
      ++ttsGeneration;
      state.ttsActive = false;
      state.ttsPending = false;
      ttsOpening = false;
      ttsPausedForName = false;
      const sessionId = ttsSessionId;
      ttsSessionId = "";
      ttsOverlayDrag?.setEnabled?.(false);
      nameEditorInstance?.bind(state.view === "translation"
        ? chapter.container.querySelector(".stvai-reader--translation")
        : null);
      if (statusMessage) reportListening(statusMessage);
      await Promise.all([
        hadPlayer || hadSession ? sendTts("stop").catch(() => undefined) : undefined,
        hadSession ? sendRuntime(runtime, { type: "STVAI_TTS_SESSION_CLEAR", sessionId }).catch(() => undefined) : undefined
      ]);
      setTtsDiagnostic({ stage: "stopped", listeningState: "absent", lastAction: "stop", outcome: "ok" });
    }

    async function startListening() {
      if (!active || state.ttsActive || ttsOpening || !state.firstBatchReady) return;
      const generation = ttsGeneration;
      const continuingSession = Boolean(ttsSessionId);
      ttsOpening = true;
      nameEditorInstance?.close?.();
      renderView("translation");
      try {
        const session = ttsSessionId
          ? await sendRuntime(runtime, { type: "STVAI_TTS_SESSION_UPDATE", sessionId: ttsSessionId,
            state: "playing_next", nextUrl: nextListeningUrl() })
          : await sendRuntime(runtime, { type: "STVAI_TTS_SESSION_START", currentUrl: chapterUrl, nextUrl: nextListeningUrl() });
        if (!session?.ok) throw new Error("Không lưu được phiên Nghe sách.");
        if (!active || generation !== ttsGeneration) {
          await sendRuntime(runtime, { type: "STVAI_TTS_SESSION_CLEAR", sessionId: session.sessionId || ttsSessionId });
          return;
        }
        ttsSessionId = session.sessionId || ttsSessionId;
        const result = await sendTts("open");
        if (!result?.ok) throw new Error("STV không thể mở trình Nghe sách.");
        // The command was dispatched synchronously. Stop/navigation has already
        // shut down that reader; a late acknowledgement must not stop its successor.
        if (!active || generation !== ttsGeneration) return;
        state.ttsActive = true;
        state.ttsPending = false;
        ttsCompleted = false;
        ttsOverlayDrag?.setEnabled?.(true);
        ttsOverlayDrag?.refresh?.();
        updateToolbar();
        setTtsDiagnostic({ stage: "active", listeningState: "ready", lastAction: "open", outcome: "ok" });
        if (continuingSession) await rearmListening();
        await completeListening();
      } catch (error) {
        setTtsDiagnostic({ stage: "degraded", listeningState: "unknown", lastAction: "open", outcome: "failed" });
        if (generation === ttsGeneration && active) {
          await stopListening(error?.message || "Không tìm thấy module Nghe sách của STV.");
        }
      } finally {
        if (generation === ttsGeneration) ttsOpening = false;
      }
    }

    async function completeListening() {
      if (!active || !state.ttsActive || state.status !== "completed" || ttsCompleted) return false;
      const result = await sendTts("complete").catch(() => null);
      if (result?.ok) {
        ttsCompleted = true;
        setTtsDiagnostic({ stage: "completed", listeningState: "completed", lastAction: "complete", outcome: "ok" });
        return true;
      }
      const listeningState = await inspectListening();
      if (listeningState === "completed") {
        ttsCompleted = true;
        setTtsDiagnostic({ stage: "completed", listeningState, lastAction: "complete", outcome: "ok" });
        return true;
      }
      setTtsDiagnostic({ stage: "degraded", listeningState, lastAction: "complete", outcome: "deferred" });
      reportListening("Nghe sách chưa nhận trạng thái hoàn tất — tool sẽ kiểm tra lại khi player cập nhật.");
      return false;
    }

    function resumeListeningAfterBatch() {
      const generation = ttsGeneration;
      enqueue(async () => {
        if (!active || generation !== ttsGeneration) return;
        if (state.ttsPending && state.firstBatchReady) await startListening();
        else if (state.ttsActive && state.status !== "completed") {
          const evidence = await reconcileListening();
          if (!evidence.known || evidence.active) {
            const result = await sendTts("watch").catch(() => null);
            setTtsDiagnostic({
              stage: result?.ok ? "active" : "degraded",
              lastAction: "watch",
              outcome: result?.ok ? "ok" : "deferred"
            });
          }
        }
        await completeListening();
      });
    }

    function startOrQueueListening() {
      if (state.firstBatchReady) return startListening();
      if (!listeningCanQueue()) {
        reportListening("Chưa có bản AI — hãy bấm Dịch AI trước.");
        return Promise.resolve();
      }
      state.ttsPending = true;
      reportListening("Nghe sách đang chờ batch 1…");
      return Promise.resolve();
    }

    function showTtsConsent() {
      if (document.querySelector(".stvai-tts-consent-backdrop")) return;
      const dialog = ui.createTtsConsentPanel(document);
      removeSharedDomEventGuard?.protect?.(dialog.root);
      document.body.append(dialog.root);
      dialog.activate();
      dialog.cancel.addEventListener("click", () => dialog.close(), { once: true });
      dialog.confirm.addEventListener("click", () => {
        enqueue(async () => {
          dialog.confirm.disabled = true;
          if (!active) return;
          await storageSet(storage, { ttsConsent: true, ttsConsentVersion: 2 });
          ttsConsent = true;
          dialog.close();
          await startOrQueueListening();
        });
      }, { once: true });
    }

    async function requestListening(source = "tool") {
      const controllerHadIntent = state.ttsActive || state.ttsPending || ttsOpening;
      if (source === "tool" && controllerHadIntent) return stopListening("Đã dừng nghe sách.");
      let evidence = null;
      if (state.ttsActive || (source === "native" && Boolean(ttsSessionId))) {
        evidence = await reconcileListening({ adopt: source === "native" });
      }
      if (source === "native" && (state.ttsActive || state.ttsPending || ttsOpening || evidence?.active)) {
        updateToolbar();
        return;
      }
      if (state.ttsActive || state.ttsPending || ttsOpening) return stopListening("Đã dừng nghe sách.");
      if (["paused", "error", "cancelled"].includes(state.status)) {
        reportListening("Bản dịch đang tạm dừng — chưa thể Nghe sách.");
        return;
      }
      if (!state.firstBatchReady && !listeningCanQueue()) {
        reportListening("Chưa có bản AI — hãy bấm Dịch AI trước.");
        return;
      }
      if (!ttsConsent) {
        showTtsConsent();
        return;
      }
      return startOrQueueListening();
    }

    async function buildStartMessage(jobId, manualStart, targetChapter = chapter, extra = {}) {
      return {
        type: "STV_START_JOB",
        manualStart: manualStart === true,
        jobId,
        provider: settings.provider,
        chapterId: targetChapter.chapterId,
        settings: { ...settings },
        blocks: targetChapter.translatableBlocks.map(({ id, text, convert }) => ({ id, text, convert: String(convert || "") })),
        ...extra
      };
    }

    async function prefetchNextChapter() {
      if (!prefetch?.findNextChapterUrl || !prefetch?.loadNextChapter || !networkRequest || !parseHtml) return;
      if (!active || prefetchStarted || state.status !== "completed" || automationConsentVersion !== AUTOMATION_CONSENT_VERSION
        || automationConsentProvider !== settings.provider) return;
      const nextUrl = prefetch.findNextChapterUrl(document, location.href);
      setPrefetchDiagnostic({ stage: "next_link", failureCode: "none", nextLinkFound: Boolean(nextUrl) });
      if (!nextUrl) { reportPrefetch('Bỏ qua dịch trước: chưa có liên kết Chương sau.'); return; }
      prefetchStarted = true;
      const generation = ++prefetchGeneration;
      const controller = new AbortController();
      prefetchAbort = controller;
      const setupSnapshot = core.stableSettingsPayload(settings);
      reportPrefetch("Đang lấy nguồn chương kế…");
      try {
        const retryDelays = (Array.isArray(prefetchRetryDelaysMs) && prefetchRetryDelaysMs.length
          ? prefetchRetryDelaysMs : PREFETCH_SOURCE_RETRY_DELAYS_MS)
          .map(value => Math.min(30_000, Math.max(0, Number(value) || 0)));
        let retryCount = 0;
        let result;
        for (;;) {
          try {
            result = await prefetch.loadNextChapter({
              url: nextUrl,
              signal: controller.signal,
              request: networkRequest,
              parse: parseHtml,
              extractor,
              splitIntoBatches: core.splitIntoBatches,
              onTrace: setPrefetchDiagnostic
            });
            setPrefetchDiagnostic({ sourceWait: { state: retryCount ? 'resolved' : 'idle', retryCount, nextDelayBucket: 'none' } });
            break;
          } catch (error) {
            if (!active || generation !== prefetchGeneration || controller.signal.aborted
              || state.status !== 'completed' || setupSnapshot !== core.stableSettingsPayload(settings)) return;
            if (error?.retryable !== true) throw error;
            const delayMs = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
            retryCount += 1;
            const delayBucket = prefetchRetryDelayBucket(delayMs);
            setPrefetchDiagnostic({ stage: 'waiting_source', failureCode: error?.message,
              sourceWait: { state: 'waiting', retryCount, nextDelayBucket: delayBucket } });
            reportPrefetch(`STV chưa có nguồn Trung — tự thử lại sau ${delayBucket.replace('s', ' giây')} (lần ${retryCount})…`);
            if (!await prefetchRetryWait(delayMs, controller.signal)) return;
          }
        }
        if (!active || generation !== prefetchGeneration || state.status !== "completed" || !result.batches.length
          || setupSnapshot !== core.stableSettingsPayload(settings)) return;
        // Send the full source to the trusted background for cache identity.
        // Only its first three batches may be sent to the AI during prefetch.
        const targetChapter = result.chapter;
        const jobId = `prefetch-${createJobId()}`;
        const message = await buildStartMessage(jobId, false, targetChapter, {
          prefetch: true,
          parentJobId: state.activeJobId,
          targetUrl: result.url
        });
        if (!active || generation !== prefetchGeneration || setupSnapshot !== core.stableSettingsPayload(settings)) return;
        prefetchJobId = jobId;
        state.prefetchCompleted = 0;
        state.prefetchTotal = Math.min(core.PREFETCH_BATCH_LIMIT, Math.max(1, result.batches.length));
        state.prefetchRunning = true;
        state.prefetchCacheable = true;
        setPrefetchDiagnostic({ stage: "dispatch_job", failureCode: "none",
          sourceWait: { state: 'resolved', retryCount, nextDelayBucket: 'none' } });
        reportPrefetch(`Đang dịch trước chương kế 0/${result.batches.length}…`);
        const response = await sendRuntime(runtime, message);
        if (active && generation === prefetchGeneration && state.status === "completed") {
          if (response?.status === "completed") {
            state.prefetchCompleted = state.prefetchTotal;
            state.prefetchRunning = false;
            state.prefetchCacheable = !response.fallbackCount;
            setPrefetchDiagnostic({ stage: "completed", failureCode: "none" });
            reportPrefetch(response.fallbackCount
              ? 'Dịch trước có câu Convert — không lưu cache chương kế.'
              : `Đã chuẩn bị ${result.batches.length}/${result.batches.length} batch chương kế.`);
          }
          else if (!response?.ok) {
            state.prefetchRunning = false;
            setPrefetchDiagnostic({ stage: "failed", failureCode: response?.reason });
            reportPrefetchFailure(response?.reason);
          }
        }
      } catch (error) {
        if (active && generation === prefetchGeneration && !controller.signal.aborted) {
          state.prefetchRunning = false;
          setPrefetchDiagnostic({ stage: "failed", failureCode: error?.message });
          reportPrefetchFailure(error?.message);
        }
      } finally {
        if (prefetchAbort === controller) prefetchAbort = null;
      }
    }

    async function startJob(manualStart = false, keepListening = false, resumedJobId = "") {
      if (!active || signal?.aborted) return;
      if (["running", "waiting-provider", "paused"].includes(state.status)) return;
      captchaRetry = false;
      originalViewPinned = false;
      void stopPrefetch();
      prefetchStarted = false;
      if (!core.hasTranslationPrompt(settings)) {
        state.status = "idle";
        updateToolbar("Chưa thiết lập prompt.");
        return;
      }
      if (!keepListening) await stopListening();
      const jobId = resumedJobId || createJobId();
      state.activeJobId = jobId;
      state.status = "waiting-provider";
      state.completedBatches = 0;
      state.completedBatchIndexes = new Set();
      state.batchAssignments = new Map();
      state.totalBatches = 1;
      state.translations = Object.create(null);
      state.translationOrigins = Object.create(null);
      state.fallbackCount = 0;
      state.firstBatchReady = false;
      ttsCompleted = false;
      if (state.view === "translation") renderView("translation");
      updateToolbar("Đang chuẩn bị chương…");
      try {
        const startMessage = await buildStartMessage(jobId, manualStart);
        if (!active || state.activeJobId !== jobId || state.status === "cancelled") return;
        if (keepListening) {
          if (!state.ttsPending || !ttsSessionId) return;
          startMessage.ttsSessionId = ttsSessionId;
        }
        const response = await sendRuntime(runtime, startMessage);
        if (!active || state.activeJobId !== jobId || state.status === "cancelled") return;
        if (!response || response.ok === false) {
          throw new Error(response?.error?.message || (response?.reason
            ? `Không khởi động được tác vụ dịch: ${response.reason}.`
            : "Không khởi động được tác vụ dịch."));
        }
        if (response.restartReason === "name_guide_changed") {
          reportAction("Áp dụng Bộ Name mới nên phải dịch lại.");
        }
        state.totalBatches = Math.max(1, Number(response.totalBatches) || 1);
        if (response.status !== "completed" && Array.isArray(response.cachedBatches)) {
          for (const cachedBatch of response.cachedBatches) {
            handleMessage({
              type: "STV_BATCH_COMPLETE",
              jobId,
              batchId: cachedBatch?.batchId,
              batchIndex: cachedBatch?.batchIndex,
              totalBatches: state.totalBatches,
              items: cachedBatch?.items,
              cached: true
            });
          }
        }
        if (response.status === "completed") {
          // The direct reply may arrive before (or without) the completion event.
          // Render its results through the same idempotent path before finishing.
          if (Array.isArray(response.items)) handleMessage({
            ...response, type: "STV_JOB_COMPLETE", jobId
          });
        } else if (response.status === "paused") {
          const alreadyPaused = state.status === "paused";
          state.status = "paused";
          if (!alreadyPaused) updateToolbar("Tab AI cần bạn kiểm tra trước khi tiếp tục.");
        } else if (response.status === "running") {
          state.status = "running";
          updateToolbar("Đang dịch chương…");
        } else {
          state.status = "waiting-provider";
          updateToolbar("Đang chờ tab AI sẵn sàng…");
        }
      } catch (error) {
        if (state.activeJobId !== jobId) return;
        state.status = "error";
        updateToolbar(error?.message || "Không thể kết nối tiện ích nền.");
      }
    }

    function showConsent() {
      if (document.querySelector(".stvai-consent-backdrop")) return;
      const dialog = ui.createConsentPanel(document, settings.provider);
      removeSharedDomEventGuard?.protect?.(dialog.root);
      document.body.append(dialog.root);
      dialog.activate();
      dialog.cancel.addEventListener("click", () => dialog.close(), { once: true });
      dialog.confirm.addEventListener("click", () => {
        enqueue(async () => {
          dialog.confirm.disabled = true;
          await storageSet(storage, { transmissionConsent: true });
          consent = true;
          dialog.close();
          await startJob(true);
        });
      }, { once: true });
    }

    function requestTranslation() {
      if (!consent) {
        showConsent();
        return Promise.resolve();
      }
      return startJob(true);
    }

    function showAutomationConsent() {
      if (document.querySelector(".stvai-consent-backdrop")) return;
      const dialog = ui.createAutomationConsentPanel(document, settings.provider, {
        autoTranslate: settings.autoTranslateOnChapter,
        tabCount: settings.webAiTabCount
      });
      removeSharedDomEventGuard?.protect?.(dialog.root);
      document.body.append(dialog.root);
      dialog.activate();
      dialog.cancel.addEventListener("click", () => dialog.close(), { once: true });
      dialog.confirm.addEventListener("click", () => {
        enqueue(async () => {
          dialog.confirm.disabled = true;
          await storageSet(storage, {
            automationConsentVersion: AUTOMATION_CONSENT_VERSION,
            automationConsentProvider: settings.provider
          });
          automationConsentVersion = AUTOMATION_CONSENT_VERSION;
          automationConsentProvider = settings.provider;
          dialog.close();
          await sendRuntime(runtime, {
            type: "STVAI_AUTOMATION_CONSENT_CHANGED",
            consentVersion: AUTOMATION_CONSENT_VERSION
          });
          if (settings.autoTranslateOnChapter) await startJob();
        });
      }, { once: true });
    }

    function automationRequested() {
      return core.hasTranslationPrompt(settings) && (settings.autoTranslateOnChapter
        || (core.isWebProvider(settings.provider) && settings.warmPoolEnabled));
    }

    function handlePoolStatus(message) {
      const pool = sanitizePoolStatus(message);
      const nextCaptchaCode = ["captcha", "security_verification"].includes(pool.errorCode)
        ? pool.errorCode
        : "";
      if (nextCaptchaCode && nextCaptchaCode !== poolCaptchaCode) {
        ui.showToast?.(document, captchaToastMessage, { timeoutMs: 3_000 });
      }
      poolCaptchaCode = nextCaptchaCode;
      state.pool = {
        state: pool.state,
        readyCount: pool.readyCount,
        totalCount: pool.totalCount,
        leasedCount: pool.leasedCount,
        targetCount: pool.targetCount,
        generalCount: pool.generalCount,
        prefetchCount: pool.prefetchCount,
        generalReadyCount: pool.generalReadyCount,
        prefetchState: pool.prefetchState,
        reconfiguring: pool.reconfiguring,
        errorCode: pool.errorCode
      };
      if (pool.uiDiagnostic) state.pool.uiDiagnostic = pool.uiDiagnostic;
      if (diagnosticState && typeof diagnosticState === "object") {
        diagnosticState.pool = { ...state.pool };
      }
      if (state.status === 'completed' && prefetchStatus) return;
      if (pool.reconfiguring) {
        updateToolbar(`Đang khởi động lại pool AI ${pool.readyCount}/${pool.targetCount}`);
      } else if (pool.state === "preparing") {
        updateToolbar(`Đang chuẩn bị AI ${pool.readyCount}/${pool.targetCount}`);
      } else if (pool.state === "ready") {
        updateToolbar(`Sẵn sàng ${pool.readyCount}/${pool.targetCount}`);
      } else if (pool.state === "leased") {
        updateToolbar(`Đang dùng tab ${pool.slotIndex}/${pool.targetCount}`);
      } else if (pool.state === "error") {
        updateToolbar(`Lỗi chuẩn bị AI: ${pool.errorCode}`);
      }
    }

    async function cancelJob() {
      void stopPrefetch();
      const stopping = stopListening("Đã dừng nghe sách.");
      if (!state.activeJobId || !["running", "waiting-provider", "paused"].includes(state.status)) return stopping;
      const jobId = state.activeJobId;
      state.status = "cancelled";
      updateToolbar("Đã hủy. Các batch đã hoàn tất vẫn được giữ trong bộ nhớ đệm.");
      await sendRuntime(runtime, { type: "STV_CANCEL_JOB", jobId }).catch(() => undefined);
      await stopping;
    }

    async function showOriginalChapter() {
      const jobIsActive = Boolean(state.activeJobId)
        && ["running", "waiting-provider", "paused"].includes(state.status);

      originalViewPinned = true;
      renderView("stv");
      updateToolbar(state.ttsActive
        ? "Đang xem bản gốc. Nghe sách và Dịch AI vẫn tiếp tục ở nền."
        : jobIsActive
          ? "Đang xem bản gốc. Dịch AI vẫn tiếp tục ở nền."
          : "Đang xem bản gốc. Cache bản dịch vẫn được giữ.");
    }

    async function resumeJob() {
      if (!state.activeJobId || state.status !== "paused") return;
      const jobId = state.activeJobId;
      captchaRetry = false;
      state.status = "running";
      updateToolbar("Đang tiếp tục…");
      try {
        const response = await sendRuntime(runtime, { type: "STV_RESUME_JOB", jobId });
        if (!response || response.ok === false) {
          throw new Error("Job không còn hoạt động trong tiện ích nền.");
        }
        if (response.paused) {
          state.status = "paused";
          setCaptchaRetry(response.reason);
          updateToolbar(reasonLabel(response.reason));
        }
      } catch (error) {
        state.status = "paused";
        updateToolbar(error?.message || "Chưa thể tiếp tục.");
      }
    }

    async function changeProvider(provider) {
      void stopPrefetch();
      const previousSettings = settings;
      const nextSettings = sanitizedSettings(core, { ...settings, provider });
      try {
        await storageSet(storage, { settings: nextSettings });
      } catch (_error) {
        settings = previousSettings;
        if (toolbar.provider.value === provider) toolbar.setProviderValue?.(previousSettings.provider);
        updateToolbar("Không lưu được dịch vụ AI. Đã giữ lựa chọn trước.");
        return false;
      }
      settings = nextSettings;
      if (automationRequested()
        && automationConsentProvider !== settings.provider) {
        showAutomationConsent();
      }
      return true;
    }

    function handleMessage(message) {
      if (message?.type === "STVAI_UI_SCALE_CHANGED") {
        uiScale = ui.normalizeUiScale?.(message.value) || 1;
        ui.applyUiScale?.(document, uiScale);
        toolbarPositionController?.setUiScale?.(uiScale);
        nameEditorInstance?.refreshPosition?.();
        nameManagerInstance?.refreshPosition?.();
        ttsOverlayDrag?.reflow?.();
        return true;
      }
      if (message?.type === "STVAI_PREFETCH_STATUS" && message.jobId === prefetchJobId) {
        setPrefetchDiagnostic({
          stage: message.status === "completed" ? "completed"
            : ['paused', 'failed', 'cancelled', 'error'].includes(message.status) ? "failed" : "running",
          failureCode: ['paused', 'failed', 'cancelled', 'error'].includes(message.status) ? message.reason : "none"
        });
        if (state.status === "completed") {
          const total = Math.min(core.PREFETCH_BATCH_LIMIT, Math.max(1, Number(message.total) || 1));
          const completed = Math.min(total, Math.max(0, Number(message.completed) || 0));
          const failed = ['paused', 'failed', 'cancelled', 'error'].includes(message.status);
          state.prefetchTotal = total;
          state.prefetchCompleted = completed;
          state.prefetchCacheable = message.cacheable !== false;
          state.prefetchRunning = !failed && message.status !== 'completed' && state.prefetchCacheable;
          if (message.cacheable === false) reportPrefetch('Dịch trước có câu Convert — không lưu cache chương kế.');
          else if (failed) reportPrefetchFailure(message.reason);
          else reportPrefetch(message.status === 'completed'
            ? `Đã chuẩn bị ${completed}/${total} batch chương kế.`
            : `Đang dịch trước chương kế ${completed}/${total}…`);
        }
        return true;
      }
      if (message?.type === "STVAI_POOL_STATUS") {
        handlePoolStatus(message);
        return true;
      }
      if (!message || message.jobId !== state.activeJobId) return false;
      if (["cancelled", "completed"].includes(state.status)) return false;

      if (MESSAGE_TYPES.batch.has(message.type)) {
        const attachment = validateTranslationItems(message);
        if (!attachment.ok) return rejectAttachment(message, attachment);
        const merged = mergeItems(message.items);
        const batchRendered = Array.isArray(message.items) && message.items.length > 0
          && merged === message.items.length;
        state.fallbackCount = Math.max(
          state.fallbackCount,
          Number(message.fallbackCount) || Object.values(state.translationOrigins).filter((value) => value === "convert").length
        );
        if (merged && state.view !== "translation" && !originalViewPinned) renderView("translation");
        state.totalBatches = Math.max(1, Number(message.totalBatches) || state.totalBatches);
        const completedIndex = Number(message.batchIndex);
        if (batchRendered && Number.isInteger(completedIndex) && completedIndex >= 0 && completedIndex < state.totalBatches) {
          for (const id of attachment.ids) state.batchAssignments.set(id, completedIndex);
          state.completedBatchIndexes.add(completedIndex);
          const batchIsAi = Array.isArray(message.items) && message.items.length > 0
            && message.items.every((item) => item?.origin !== "convert"
              && state.translationOrigins[item?.id] === "ai");
          if (completedIndex === 0 && merged && batchIsAi) state.firstBatchReady = true;
        }
        if (state.view === "translation") renderView("translation");
        state.completedBatches = state.completedBatchIndexes.size;
        state.status = "running";
        updateToolbar(`Đã dịch ${state.completedBatches}/${state.totalBatches} batch`);
        recordAttachmentEvidence("attached", "confirmed", message, message.items.length);
        resumeListeningAfterBatch();
        return true;
      }

      if (MESSAGE_TYPES.status.has(message.type)) {
        if (diagnosticState && message.batchDiagnostic) diagnosticState.batch = { ...message.batchDiagnostic };
        const batchNumber = Math.max(1, (Number(message.batchDiagnostic?.batchIndex) || 0) + 1);
        state.totalBatches = Math.max(1, Number(message.totalBatches) || state.totalBatches);
        state.completedBatches = state.completedBatchIndexes.size;
        state.fallbackCount = Math.max(state.fallbackCount, Number(message.fallbackCount) || 0);
        if (message.status === "paused") {
          state.status = "paused";
          setCaptchaRetry(message.reason);
          updateToolbar(message.reason === 'batch_recovery_exhausted'
            ? `Batch ${batchNumber} chưa hoàn tất — bấm Tiếp tục để thử lại.` : reasonLabel(message.reason));
          if (state.ttsActive || state.ttsPending || ttsOpening) enqueue(() => stopListening());
        } else if (message.status === "cancelled") {
          captchaRetry = false;
          state.status = "cancelled";
          updateToolbar("Đã hủy tác vụ dịch.");
          if (state.ttsActive || state.ttsPending) enqueue(() => stopListening());
        } else if (message.status === "failed" || message.status === "error") {
          captchaRetry = false;
          state.status = "error";
          updateToolbar(message.reason || "Dịch thất bại. Tiến độ đã hoàn thành vẫn được giữ.");
          if (state.ttsActive || state.ttsPending || ttsOpening) enqueue(() => stopListening());
        } else {
          captchaRetry = false;
          state.status = message.status === "waiting-provider" ? "waiting-provider" : "running";
          if (message.reason === "auto_retry") {
            updateToolbar(`Mất phản hồi từ AI. Đang thử lại ${Number(message.retryAttempt) || 1}/2…`);
          } else if (message.reason === 'retrying_whole_batch') {
            const expected = Math.max(0, Number(message.batchDiagnostic?.expectedCount) || 0);
            const actual = message.batchDiagnostic?.actualCount;
            const counts = Number.isFinite(actual) ? `nhận ${Math.max(0, actual)}/${expected} đoạn — ` : '';
            updateToolbar(`Batch ${batchNumber}: ${counts}đang thử lại nguyên batch…`);
          } else if (message.reason === 'rechecking_response') {
            updateToolbar(`Batch ${batchNumber}: đang kiểm tra phản hồi đến muộn đúng mã yêu cầu…`);
          } else if (message.reason === 'switching_ready_batch') {
            updateToolbar(`Batch ${batchNumber} vẫn lỗi — chuyển sang tab READY…`);
          } else if (message.reason === 'waiting_provider_busy') {
            updateToolbar("Gemini vẫn đang hoàn tất batch trước — tool đang tự chờ…");
          } else if (message.reason === 'switching_busy_tab') {
            updateToolbar("Gemini bị kẹt quá 30 giây — đang chuyển sang tab READY…");
          } else if (message.reason === 'api_temperature_default') {
            updateToolbar("Model không hỗ trợ Temperature — đang dùng mức mặc định của model.");
          } else {
            updateToolbar("Đang dịch chương…");
          }
        }
        return true;
      }

      if (MESSAGE_TYPES.complete.has(message.type)) {
        const attachment = validateTranslationItems(message, { completion: true });
        if (!attachment.ok) return rejectAttachment(message, attachment);
        mergeItems(message.items);
        state.fallbackCount = Math.max(
          Number(message.fallbackCount) || 0,
          Object.values(state.translationOrigins).filter((value) => value === "convert").length
        );
        state.totalBatches = Math.max(1, Number(message.totalBatches) || state.totalBatches);
        const chapterRendered = chapter.translatableBlocks.length > 0
          && chapter.translatableBlocks.every((block) => state.translations[block.id]?.trim());
        if (chapterRendered) {
          state.completedBatchIndexes = new Set(Array.from({ length: state.totalBatches }, (_, index) => index));
        }
        state.completedBatches = state.completedBatchIndexes.size;
        state.status = "completed";
        state.firstBatchReady = chapterRendered && chapter.translatableBlocks.every(
          (block) => state.translationOrigins[block.id] === "ai"
        );
        if (state.view === "translation" || !originalViewPinned) renderView("translation");
        updateToolbar(state.fallbackCount
          ? `Có ${state.fallbackCount} câu dùng Convert — chương này không được lưu cache`
          : message.cached ? "Đã tải bản dịch từ bộ nhớ đệm." : "Đã dịch xong chương.");
        recordAttachmentEvidence("attached", "confirmed", message, message.items?.length);
        resumeListeningAfterBatch();
        enqueue(() => prefetchNextChapter());
        return true;
      }
      return false;
    }

    async function init() {
      if (signal?.aborted || destroyed) return api;
      setDiagnosticState(diagnosticState, "path_check");
      if (!extractor.isChapterPath(location.pathname)) {
        setDiagnosticState(diagnosticState, "not_chapter");
        return api;
      }
      setDiagnosticState(diagnosticState, "extracting");
      try {
        chapter = extractor.extractChapter(document);
        if (prefetch?.prepareChapter) chapter = prefetch.prepareChapter(chapter);
        nativeSync = ui.createNativeSync(document, {
          container: chapter.container, blocks: chapter.blocks, sourceNodeBlockIds: chapter.sourceNodeBlockIds,
          onTrace: event => document.defaultView?.STVAINativeTrace?.record(event)
        });
        removeNativeListenGestureGuard = installNativeListenGestureGuard();
      } catch (error) {
        state.status = error?.code || "inactive";
        const errorCode = ["SOURCE_NOT_FOUND", "SOURCE_NOT_CHINESE"].includes(error?.code)
          ? error.code
          : "UNEXPECTED";
        setDiagnosticState(diagnosticState, "extracting", errorCode);
        return api;
      }
      setDiagnosticState(diagnosticState, "reading_storage");
      const stored = await storageGet(storage, [
        "settings",
        "toolEnabled",
        "transmissionConsent",
        "automationConsentVersion",
        "automationConsentProvider",
        "ttsConsent",
        "ttsConsentVersion",
        "stvaiToolbarCollapsed",
        "stvaiTtsOverlayPositionV1",
        "stvaiUiScale",
        "stvaiToolbarPositionV2",
        "stvaiNameEditorPositionV2",
        "stvaiNameManagerPositionV2"
      ]);
      if (signal?.aborted || destroyed) return api;
      if (stored.toolEnabled !== true) {
        await sendTts("release").catch(() => undefined);
        state.status = "disabled";
        setDiagnosticState(diagnosticState, "active");
        return api;
      }
      settings = sanitizedSettings(core, stored.settings);
      consent = stored.transmissionConsent === true;
      automationConsentVersion = Number(stored.automationConsentVersion) || 0;
      automationConsentProvider = typeof stored.automationConsentProvider === "string"
        ? stored.automationConsentProvider
        : "";
      ttsConsent = stored.ttsConsent === true && stored.ttsConsentVersion === 2;
      uiScale = ui.applyUiScale?.(document, stored.stvaiUiScale) || 1;
      removeSharedDomEventGuard = installSharedDomEventGuard(document, dependencies.isTrustedUiEvent);

      setDiagnosticState(diagnosticState, "creating_toolbar");
      toolbar = ui.createToolbar(document, settings, {
        initialCollapsed: stored.stvaiToolbarCollapsed === true,
        onLayoutChange(anchor, icon) {
          toolbarPositionController?.anchorTo?.(anchor, icon);
        },
        onCollapsedChange(collapsed) {
          void storageSet(storage, { stvaiToolbarCollapsed: collapsed === true }).catch(() => undefined);
        },
        onProviderChange(provider) {
          enqueue(() => changeProvider(provider));
        }
      });
      removeSharedDomEventGuard?.protect?.(toolbar.root);
      setDiagnosticState(diagnosticState, "inserting_toolbar");
      document.body.append(toolbar.root);
      ttsOverlayDrag = ui.createTtsOverlayDrag?.(document, {
        initialPosition: stored.stvaiTtsOverlayPositionV1,
        async onPronunciationOpen() {
          if (active && state.ttsActive) await sendTts('pronunciation-open');
        },
        async onPronunciationClose() {
          if (active && state.ttsActive) await sendTts('pronunciation-close');
        },
        async previewPronunciation(text, guide) {
          if (!active || !state.ttsActive) throw new Error('tts_not_active');
          let spokenText = typeof text === 'string' ? text.trim() : '';
          if (typeof guide === 'string') {
            const rules = ttsPronunciation?.parseGuide?.(guide) || [];
            const transformed = ttsPronunciation?.applyToText?.(spokenText, rules);
            if (typeof transformed === 'string') spokenText = transformed.trim();
          }
          if (!spokenText) return { ok: true, code: 'preview_silent', spokenText: '' };
          const result = await ttsClient.request(document, 'preview', { text: spokenText, timeoutMs: 10000 });
          return { ...(result || {}), spokenText };
        },
        async getPronunciationGuide() {
          const latest = await storageGet(storage, ['settings']);
          return sanitizedSettings(core, latest.settings || settings).ttsPronunciationGuide;
        },
        async savePronunciationGuide(value) {
          if (!active || typeof value !== 'string' || value.length > 20000) throw new Error('invalid_pronunciation');
          const latest = await storageGet(storage, ['settings']);
          if (!active) throw new Error('inactive');
          const merged = { ...(latest.settings || settings), ttsPronunciationGuide: value };
          await storageSet(storage, { settings: merged });
          settings = sanitizedSettings(core, { ...settings, ttsPronunciationGuide: value });
        },
        onPositionChange(position) {
          void storageSet(storage, { stvaiTtsOverlayPositionV1: position }).catch(() => undefined);
        },
        protectUiRoot(root) {
          return removeSharedDomEventGuard?.protect?.(root) || root;
        }
      });
      toolbarPositionController = nameManager?.attachDraggable?.(toolbar.root, toolbar.dragHandles || toolbar.dragHandle, {
        storageKey: "stvai-toolbar-position",
        isAnimating: () => toolbar.root.dataset.stvaiToolbarAnimating === "true",
        onInteraction: () => toolbar.finishAnimation?.(),
        margin: 0,
        initialPosition: stored.stvaiToolbarPositionV2,
        getScale: () => uiScale,
        onPositionChange(position) {
          void storageSet(storage, { stvaiToolbarPositionV2: position }).catch(() => undefined);
        },
        interactiveHandles: toolbar.miniToggle ? [toolbar.miniToggle] : []
      });
      if (nameEditor?.createNameEditor) {
        nameEditorInstance = nameEditor.createNameEditor(document, {
          attachDraggable(root, handle) {
            return nameManager?.attachDraggable?.(root, handle, {
              storageKey: "stvai-name-editor-position",
              margin: 0,
              initialPosition: stored.stvaiNameEditorPositionV2,
              getScale: () => uiScale,
              onPositionChange(position) {
                void storageSet(storage, { stvaiNameEditorPositionV2: position }).catch(() => undefined);
              }
            });
          },
          blockDataForBlock(blockId) {
            return {
              references: chapter.nameReferencesByBlock?.[blockId] || []
            };
          },
          romajiForSource(source) {
            return nameAliases?.lookup?.(source, settings.nameGuide) || "";
          },
          onBeforeOpen() {
            if (!state.ttsActive) return true;
            return sendTts("pause").then((result) => {
              if (result?.ok) {
                ttsPausedForName = true;
                return true;
              }
              reportListening("Không thể tạm dừng Nghe sách — Bộ Name chưa được mở.");
              return false;
            }, () => {
              reportListening("Không thể tạm dừng Nghe sách — Bộ Name chưa được mở.");
              return false;
            });
          },
          onClose() {
            if (!ttsPausedForName) return;
            ttsPausedForName = false;
            runNow(() => rearmListening());
          },
          async onPreview({ source, requestId }) {
            const response = await sendRuntime(runtime, {
              type: "STVAI_NAME_PREVIEW",
              requestId,
              source
            });
            if (!response?.ok || response.requestId !== requestId) {
              throw new Error(response?.reason || "preview-unavailable");
            }
            return response.preview || {};
          },
          async onJapaneseLookup({ source, disallowedCandidate, requestId }) {
            const response = await sendRuntime(runtime, {
              type: "STVAI_JAPANESE_NAME_LOOKUP",
              requestId,
              source,
              disallowedCandidate
            });
            if (!response?.ok || response.requestId !== requestId) {
              const error = new Error(response?.reason || "lookup-unavailable");
              error.tabCount = response?.targetCount;
              throw error;
            }
            return response.lookup || {};
          },
          async onSave(mapping) {
            await stopPrefetch();
            const nameGuide = nameEditor.appendNameMapping(
              settings.nameGuide,
              mapping.source,
              mapping.target
            );
            settings = sanitizedSettings(core, { ...settings, nameGuide });
            await storageSet(storage, { settings });
            reportAction(`Đã lưu Name $${mapping.source}=${mapping.target} — Bấm Dịch AI để dịch lại.`);
          }
        });
        removeSharedDomEventGuard?.protect?.(nameEditorInstance.root);
      }
      if (nameManager?.createNameManager) {
        nameManagerInstance = nameManager.createNameManager(document, {
          nameGuide: settings.nameGuide,
          attachDraggable(root, handle) {
            return nameManager.attachDraggable(root, handle, {
              storageKey: "stvai-name-manager-position",
              margin: 0,
              initialPosition: stored.stvaiNameManagerPositionV2,
              getScale: () => uiScale,
              onPositionChange(position) {
                void storageSet(storage, { stvaiNameManagerPositionV2: position }).catch(() => undefined);
              }
            });
          },
          async onSave(nameGuide) {
            await stopPrefetch();
            settings = sanitizedSettings(core, { ...settings, nameGuide });
            await storageSet(storage, { settings });
            reportAction("Đã lưu bộ Name riêng của tool — chương hiện tại không tự dịch lại.");
          },
          async onSyncStvName(draft) {
            const shared = portableContent?.readNameForImport?.(document.defaultView);
            if (!shared?.ok) {
              const messages = {
                stv_shared_name_missing: "STV chưa có Bộ Name dùng chung.",
                stv_shared_name_unavailable: "Không đọc được Bộ Name dùng chung của STV.",
                stv_shared_name_insecure: "Hãy mở STV bằng HTTPS để đồng bộ Bộ Name dùng chung.",
                stv_shared_name_invalid: "Bộ Name dùng chung của STV không hợp lệ.",
                portable_size_limit: "Bộ Name dùng chung của STV vượt giới hạn an toàn 512 KB.",
                portable_invalid_name: "Bộ Name dùng chung của STV không hợp lệ."
              };
              throw new Error(messages[shared?.code] || "Không đọc được Bộ Name dùng chung của STV.");
            }
            const imported = core.importStvSharedName(draft, shared.raw);
            await stopPrefetch();
            settings = sanitizedSettings(core, { ...settings, nameGuide: imported.value });
            await storageSet(storage, { settings });
            reportAction("Đã bổ sung Name STV vào Bộ Name chung — chương hiện tại không tự dịch lại.");
            return imported;
          }
        });
        removeSharedDomEventGuard?.protect?.(nameManagerInstance.root);
        document.body.append(nameManagerInstance.root);
      }

      setDiagnosticState(diagnosticState, "registering_listener");
      toolbar.translate.addEventListener("click", () => runNow(async () => {
        if (state.view === "stv" && ["running", "waiting-provider", "paused", "completed"].includes(state.status)) {
          originalViewPinned = false;
          renderView("translation");
          updateToolbar();
          if (!captchaRetry) return;
        }
        await (captchaRetry ? resumeJob() : requestTranslation());
      }));
      toolbar.original.addEventListener("click", () => runNow(showOriginalChapter));
      toolbar.cancel.addEventListener("click", () => runNow(cancelJob));
      toolbar.resume.addEventListener("click", () => enqueue(resumeJob));
      toolbar.listen.addEventListener("click", () => runNow(requestListening));
      toolbar.names.addEventListener("click", () => {
        nameManagerInstance?.open(settings.nameGuide);
      });
      toolbar.confirmClearCache.addEventListener("click", () => {
        if (destroyed || toolbar.cacheConfirmation.hidden || toolbar.clearCache.disabled || toolbar.cacheClearing) return;
        toolbar.closeCacheConfirmation(true);
        toolbar.cacheClearing = true;
        toolbar.clearCache.disabled = true;
        runNow(async () => {
          const result = await sendRuntime(runtime, { type: "STVAI_CLEAR_ALL_CACHE" }).catch(() => null);
          toolbar.cacheClearing = false;
          if (!destroyed) {
            if (result?.ok) reportAction("Đã xóa cache.");
            else updateToolbar("Không xóa được cache.");
          }
        });
      });
      toolbar.provider.addEventListener("change", () => {
        const provider = toolbar.provider.value;
        enqueue(() => changeProvider(provider));
      });
      toolbar.settings.addEventListener("click", () => {
        runNow(async () => {
          const response = await sendRuntime(runtime, { type: "STVAI_OPEN_OPTIONS" }).catch(() => null);
          if (!response?.ok) updateToolbar("Không mở được Cài đặt. Hãy tải lại tiện ích rồi thử lại.");
        });
      });
      messageListener = (message) => {
        handleMessage(message);
        return false;
      };
      runtime.onMessage.addListener(messageListener);
      active = true;
      unsubscribeTts = ttsClient?.subscribe?.(document, ({ code }) => {
        if (!active) return;
        // Page-visible status is not authority to create a continuing TTS session.
        // Sunshine touch is trusted browser input but may not set userActivation.
        // Accept it only while handling the real relayed STV button event.
        if (code === "native_listen_requested") {
          const activated = document.defaultView?.navigator?.userActivation?.isActive === true
            || trustedNativeListenGesture;
          trustedNativeListenGesture = false;
          if (activated) enqueue(() => requestListening("native"));
        }
        if (code === "reader_opened") {
          ttsOverlayDrag?.setEnabled?.(true);
          ttsOverlayDrag?.refresh?.();
          setTtsDiagnostic({ stage: "active", listeningState: "ready", lastAction: "status", outcome: "ok" });
          if (state.status === "completed" && state.ttsActive && !ttsCompleted) enqueue(completeListening);
        }
        if (code === "player_stopped") void stopListening("Đã dừng nghe sách.");
        if (code === "chapter_changed") {
          ttsOverlayDrag?.setEnabled?.(false);
          state.ttsActive = false;
          ++ttsGeneration;
          setTtsDiagnostic({ stage: "chapter_changed", listeningState: "absent", lastAction: "status", outcome: "ok" });
          // The next controller claims the session using its own URL. Do not
          // update it from the departed document after navigation.
        }
      });
      await sendTts("arm").catch(() => reportListening("Không thể bảo vệ Nghe sách của STV. Hãy tải lại tiện ích."));
      if (!active || signal?.aborted) return api;
      setDiagnosticState(diagnosticState, "active");
      let ttsClaim = null;
      if (ttsConsent) {
        const navigationType = document.defaultView?.performance?.getEntriesByType?.("navigation")?.[0]?.type;
        const historyNavigation = navigatedThroughHistory
          || navigationType === "back_forward";
        ttsClaim = await sendRuntime(runtime, { type: "STVAI_TTS_SESSION_CLAIM_NEXT", url: chapterUrl,
          historyNavigation, reload: !sameDocumentNavigation && navigationType === "reload" }).catch(() => null);
        if (!active || signal?.aborted) return api;
        if (ttsClaim?.ok && ttsClaim.claimed && typeof ttsClaim.sessionId === "string") {
          ttsSessionId = ttsClaim.sessionId;
          state.ttsPending = true;
          await startJob(false, true, typeof ttsClaim.jobId === "string" ? ttsClaim.jobId : "");
          return api;
        }
      }
      if (!active || signal?.aborted) return api;
      if (automationRequested()) {
        if (automationConsentVersion === AUTOMATION_CONSENT_VERSION
          && automationConsentProvider === settings.provider) {
          if (settings.autoTranslateOnChapter) await startJob();
        }
        else showAutomationConsent();
      }
      return api;
    }

    function destroy({ navigation = false } = {}) {
      if (destroyed) return;
      destroyed = true;
      void stopPrefetch();
      active = false;
      ++ttsGeneration;
      unsubscribeTts?.();
      ttsOverlayDrag?.destroy?.();
      toolbar?.finishAnimation?.();
      toolbarPositionController?.destroy?.();
      if (toolbar?.announcementTimer) document.defaultView?.clearTimeout?.(toolbar.announcementTimer);
      if (messageListener) runtime.onMessage.removeListener(messageListener);
      toolbar?.root.remove();
      copyrightGuard?.destroy();
      copyrightGuard = undefined;
      nameEditorInstance?.destroy();
      nameManagerInstance?.destroy();
      chapter?.container?.querySelectorAll(".stvai-chapter-complete").forEach((notice) => notice.remove());
      if (!navigation && (state.ttsActive || state.ttsPending || ttsOpening)) {
        state.ttsActive = false;
        void sendTts("stop").catch(() => undefined);
      }
      if (!navigation && ttsSessionId) void sendRuntime(runtime, { type: "STVAI_TTS_SESSION_CLEAR", sessionId: ttsSessionId }).catch(() => undefined);
      state.ttsPending = false;
      if (navigation && state.activeJobId && !["completed", "cancelled"].includes(state.status)) {
        void sendRuntime(runtime, { type: "STV_CANCEL_JOB", jobId: state.activeJobId, reason: "chapter_changed" }).catch(() => undefined);
      }
      nativeSync?.destroy();
      removeNativeListenGestureGuard?.();
      removeNativeListenGestureGuard = undefined;
      removeSharedDomEventGuard?.();
      removeSharedDomEventGuard = undefined;
      document.defaultView?.STVAINativeTrace?.setView("stv");
      active = false;
    }

    const api = {
      init,
      destroy,
      handleMessage,
      requestTranslation: () => enqueue(requestTranslation),
      whenIdle: () => pending,
      get active() { return active; },
      get state() { return state; }
    };
    signal?.addEventListener("abort", () => destroy({ navigation: signal.reason?.navigation === true }), { once: true });
    return api;
  }

  function waitForChapterRoot(document, timeoutMs, signal) {
    const sourceSelector = "#content-container .contentbox[cid] i[t]";
    const ready = () => {
      const token = document.querySelector(sourceSelector);
      if (!token || signal?.aborted) return false;
      const segments = document.location?.pathname.split('/').filter(Boolean) || [];
      return segments.length !== 5 || token.closest('.contentbox').getAttribute('cid') === segments[4];
    };
    if (signal?.aborted) return Promise.resolve(false);
    if (ready()) return Promise.resolve(true);
    const Observer = document.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (typeof Observer !== "function") return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = value => {
        clearTimeout(timeout);
        observer.disconnect();
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      const aborted = () => finish(false);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const observer = new Observer(() => {
        if (ready()) finish(true);
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["cid", "t"] });
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async function bootstrap(dependencies) {
    setDiagnosticState(dependencies.diagnosticState, "path_check");
    if (!dependencies.extractor.isChapterPath(dependencies.location.pathname)) {
      setDiagnosticState(dependencies.diagnosticState, "not_chapter");
      return null;
    }
    setDiagnosticState(dependencies.diagnosticState, "waiting_root");
    const found = await waitForChapterRoot(dependencies.document, 30_000, dependencies.signal);
    if (dependencies.signal?.aborted) return null;
    if (!found) {
      setDiagnosticState(dependencies.diagnosticState, "root_timeout", "SOURCE_NOT_FOUND");
      return null;
    }
    const controller = createChapterController(dependencies);
    try {
      await controller.init();
    } catch (error) {
      if (dependencies.diagnosticState?.errorCode === "none") {
        dependencies.diagnosticState.errorCode = "UNEXPECTED";
      }
      throw error;
    }
    return controller.active ? controller : null;
  }

  function createToolLifecycle({ runtime, activate, document, sites, onDisable, autoStart = true }) {
    if (!runtime?.onMessage?.addListener || typeof activate !== "function") {
      throw new TypeError("runtime and activate are required");
    }
    let controller = null;
    let disposed = false;
    let pending = Promise.resolve();
    let enabled = false;
    let generation = 0;
    let activation;
    let historyNavigationUrl = "";
    let sameDocumentNavigation = false;
    const window = document?.defaultView;
    const identity = () => {
      const root = sites?.chapterRoot
        ? sites.chapterRoot(document, window?.location.href)
        : document?.querySelector?.('#content-container .contentbox[cid]');
      return { url: window?.location.href, root, cid: root?.getAttribute('cid') };
    };
    let previous = identity();

    function invalidate(navigation) {
      generation++;
      activation?.abort({ navigation });
      controller?.destroy?.({ navigation });
      controller = null;
    }

    function setEnabled(value) {
      enabled = value;
      if (!enabled) {
        invalidate(false);
        void Promise.resolve(onDisable?.()).catch(() => undefined);
      }
      const expected = generation;
      const activationIsSameDocument = sameDocumentNavigation;
      sameDocumentNavigation = false;
      pending = pending.catch(() => undefined).then(async () => {
        if (disposed || expected !== generation) return false;
        if (enabled) {
          if (!controller?.active) {
            activation = new AbortController();
            const result = await activate({ signal: activation.signal,
              historyNavigation: Boolean(historyNavigationUrl && historyNavigationUrl === window?.location.href),
              sameDocumentNavigation: activationIsSameDocument });
            if (disposed || !enabled || expected !== generation) {
              result?.destroy?.({ navigation: activation.signal.reason?.navigation === true });
              return false;
            }
            controller = result;
          }
        }
        return controller?.active === true;
      });
      return pending;
    }

    function checkNavigation() {
      const next = identity();
      if (next.url === previous.url && next.root === previous.root && next.cid === previous.cid) return;
      previous = next;
      sameDocumentNavigation = true;
      invalidate(true);
      if (enabled && !disposed) void setEnabled(true).catch(() => undefined);
    }
    const onHistory = () => { historyNavigationUrl = window?.location.href || ""; checkNavigation(); };
    const onHide = () => invalidate(true);
    const onShow = event => {
      if (event.persisted && enabled) {
        historyNavigationUrl = window?.location.href || "";
        void setEnabled(true).catch(() => undefined);
      }
    };
    const observer = window?.MutationObserver ? new window.MutationObserver(checkNavigation) : null;
    observer?.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["cid"] });
    // pushState is not observable across isolated worlds; this cheap identity
    // check also catches URL-only swiftload without inspecting story text.
    const navigationTimer = window?.setInterval(checkNavigation, 250);
    window?.addEventListener("popstate", onHistory);
    window?.addEventListener("pagehide", onHide);
    window?.addEventListener("pageshow", onShow);

    const listener = (message, _sender, sendResponse) => {
      if (message?.type !== "STVAI_TOOL_ENABLED_CHANGED") return false;
      void setEnabled(message.enabled === true).then(
        (active) => sendResponse?.({ ok: true, active }),
        () => sendResponse?.({ ok: false, reason: "tool-lifecycle-failed" })
      );
      return true;
    };
    runtime.onMessage.addListener(listener);
    if (autoStart) void setEnabled(true).catch(() => undefined);

    return Object.freeze({
      setEnabled,
      whenIdle: () => pending,
      destroy() {
        disposed = true;
        invalidate(false);
        observer?.disconnect();
        window?.clearInterval(navigationTimer);
        window?.removeEventListener("popstate", onHistory);
        window?.removeEventListener("pagehide", onHide);
        window?.removeEventListener("pageshow", onShow);
        runtime.onMessage.removeListener?.(listener);
        controller?.destroy?.();
        controller = null;
      }
    });
  }

  return Object.freeze({
    createChapterController,
    createToolLifecycle,
    createDefaultJobId,
    sanitizedSettings,
    createRuntimeStorage,
    isTrustedUserGesture,
    isTrustedNativeInput,
    installSharedDomEventGuard,
    setDiagnosticState,
    waitForChapterRoot,
    bootstrap
  });
});
