(function attachTtsBridge(root, factory) {
  const sites = root.STVAISites || (typeof require === "function" ? require("../shared/stv-sites.js") : null);
  const pronunciation = root.STVAITTSPronunciation || (typeof require === "function" ? require("../shared/tts-pronunciation.js") : null);
  const api = factory(sites, pronunciation);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAITTSBridge = api;
  if (typeof module !== "object" && root.document) api.install(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function createTtsBridgeApi(sites, pronunciation) {
  "use strict";

  const COMMAND_EVENT = "stvai:tts-command";
  const RESULT_EVENT = "stvai:tts-result";
  const STATUS_EVENT = "stvai:tts-status";
  const NATIVE_ACTION_EVENT = "stvai:native-action";
  const ACTIONS = new Set(["arm", "inspect", "open", "watch", "complete", "pause", "resume", "stop", "release", "pronunciation-open", "pronunciation-close", "preview"]);
  const AUTO_FOLLOW_IDLE_MS = 3000;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  const TOOL_SURFACE_SELECTOR = [
    ".stvai-toolbar", ".stvai-navigation", ".stvai-name-editor", ".stvai-name-manager",
    ".stvai-consent-backdrop", ".stvai-tts-consent-backdrop", ".stvai-toast", ".tts-control-overlay"
  ].join(",");
  const INTERACTIVE_SELECTOR = [
    "input", "textarea", "select", "button", "a", "[role='button']", "[contenteditable='true']",
    "[contenteditable='']", "[contenteditable='plaintext-only']"
  ].join(",");
  const FOLLOW_HOLD_SELECTOR = [
    ".stvai-name-editor", ".stvai-name-manager", ".stvai-tts-pronunciation",
    "[data-stvai-tts-pronunciation]", ".window[data-stvai-tts-settings='true']",
    ".tts-control-overlay [role='dialog']",
    ".tts-control-overlay [role='menu']", ".tts-control-overlay [role='listbox']",
    ".tts-control-overlay dialog[open]", ".tts-control-overlay [aria-expanded='true']"
  ].join(",");

  function validateCommand(value) {
    if (!value || typeof value !== "object" || !ACTIONS.has(value.action)) {
      throw new Error("Lệnh TTS không hợp lệ.");
    }
    const requestId = String(value.requestId || "");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) {
      throw new Error("Mã lệnh TTS không hợp lệ.");
    }
    const command = { action: value.action, requestId };
    if (value.action === 'preview') {
      if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200) throw new Error('invalid_preview');
      command.text = value.text.trim();
    }
    if (value.action === "open") command.pronunciations = pronunciation.sanitizeRules(
      Object.hasOwn(value, "pronunciations") ? value.pronunciations : [],
      { strict: true }
    );
    return command;
  }

  function createBridge(root) {
    const document = root.document;
    let guardedContainer = null;
    let guardedCid = "";
    let guardedUrl = "";
    let guardedReader = null;
    let openingReader = null;
    let internalCall = 0;
    let owned = false;
    let armed = false;
    let disposed = false;
    let overlayInteraction = false;
    let pausedByTool = false;
    let menuPaused = false;
    let pronunciationOpen = false;
    let pronunciationOwnsPause = false;
    let cancelPreview = () => {};
    let pausedAtBatchEnd = false;
    let documentComplete = false;
    let completionNotified = false;
    const focusedSentences = new Set();
    const focusableSentences = new Set();
    const sentenceFocusCleanupTimers = new Map();
    let autoFollowTimer = null;
    let listFollowTimer = null;
    let pageScrollbarDrag = null;
    let listScrollbarDrag = null;
    let latestHighlight = null;
    let continuingSentenceFocus = false;
    let sentenceGlass = null;
    let sentenceAnimationFrame = null;
    let smoothFollowActive = false;
    let followMenuOpen = false;
    let pronunciationReplacer = pronunciation.createReplacer([]);
    const GATE_KEY = "stvai:tts-ai-only";
    const ARM_KEY = "stvai:tts-armed";
    // This page-visible bit can only inhibit native playback. It never grants
    // permission to translate/resume; that lives in chrome.storage.session.
    try {
      owned = root.sessionStorage.getItem(GATE_KEY) === "1";
      armed = root.sessionStorage.getItem(ARM_KEY) === "1" || owned;
    } catch (_) { /* unavailable */ }
    const hooked = new WeakMap();
    const unhook = [];
    let lastNativeRequestAt = 0;

    function setOwned(value) {
      owned = value;
      try {
        if (value) root.sessionStorage.setItem(GATE_KEY, "1");
        else root.sessionStorage.removeItem(GATE_KEY);
      } catch (_) { /* in-memory gate remains active */ }
    }

    function setArmed(value) {
      armed = value;
      try {
        if (value) root.sessionStorage.setItem(ARM_KEY, "1");
        else root.sessionStorage.removeItem(ARM_KEY);
      } catch (_) { /* in-memory gate remains active */ }
    }

    function internally(operation) {
      internalCall++;
      try { return operation(); } finally { internalCall--; }
    }

    // Watch known STV entrypoints, including modules assigned after document_start.
    // Do not poll, clone the TTS module, or alter its configuration.
    function intercept(object, key, transform) {
      if (!object || !["object", "function"].includes(typeof object)) return;
      let keys = hooked.get(object);
      if (!keys) { keys = new Set(); hooked.set(object, keys); }
      if (keys.has(key)) return;
      keys.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) {
        transform(object[key]);
        return;
      }
      let original = object[key];
      let current = transform(original);
      const getter = () => current;
      Object.defineProperty(object, key, {
        configurable: true, enumerable: descriptor?.enumerable ?? true,
        get: getter, set(value) { original = value; current = transform(value); }
      });
      unhook.push(() => {
        if (Object.getOwnPropertyDescriptor(object, key)?.get === getter) {
          Object.defineProperty(object, key, { configurable: true, enumerable: descriptor?.enumerable ?? true,
            writable: true, value: original });
        }
      });
    }

    // STV tokenization is synchronous. Exclude native subtrees during that scan,
    // then restore the same nodes/listeners before yielding to the page.
    function withAiText(operation) {
      const reader = guardedReader || openingReader;
      if (!reader) return operation();
      const selector = "[data-stvai-tts-exclude='true'],a,img,picture,video,audio,svg,canvas,iframe,button,[role='button'],[onclick],[onmousedown],[ontouchup],.btn";
      const parked = Array.from(reader.querySelectorAll(selector))
        .filter(node => !node.parentElement?.closest(selector))
        .map(node => { const anchor = document.createComment("stvai-tts-native"); node.before(anchor); node.remove(); return { node, anchor }; });
      const changedText = [];
      const walker = document.createTreeWalker(reader, root.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const spoken = pronunciationReplacer(node.nodeValue);
        if (spoken === node.nodeValue) continue;
        changedText.push({ node, value: node.nodeValue });
        node.nodeValue = spoken;
      }
      try { return operation(); }
      finally {
        for (const { node, value } of changedText) node.nodeValue = value;
        for (const { node, anchor } of parked) anchor.replaceWith(node);
      }
    }

    function gateMethod(object, key, onStop = false, allowBoundReader = () => false, textScan = false, nativeStart = false) {
      intercept(object, key, (method) => typeof method !== "function" ? method : function (...args) {
        const invoke = () => textScan && owned ? withAiText(() => method.apply(this, args)) : method.apply(this, args);
        if (disposed || (!owned && !armed) || internalCall) return invoke();
        if (key === "stop" && menuPaused && overlayInteraction) pausedByTool = false;
        if (chapterChanged()) holdForChapter();
        if (guardedReader && allowBoundReader(args)) return invoke();
        // STV removes its TTS overlay when the visible chapter subtree changes.
        // Switching to the native/Convert view parks the same AI reader in the
        // document, so that automatic cleanup must not close the listening UI.
        // A click/keydown inside the overlay is still an explicit user close.
        if (key === "removeOverlay" && guardedReader && !overlayInteraction) return undefined;
        if (nativeStart) {
          const now = Date.now();
          if (now - lastNativeRequestAt >= 500) {
            lastNativeRequestAt = now;
            emitStatus("native_listen_requested");
          }
          return undefined;
        }
        if (!onStop) return undefined;
        const userStop = overlayInteraction;
        const result = internally(() => method.apply(this, args));
        // Native chapter completion may synchronously stop before changing URL.
        root.queueMicrotask(() => {
          if (disposed || !owned) return;
          if (chapterChanged()) holdForChapter();
          else if (guardedReader && userStop) {
            stopPlayer(true);
            clearGuard();
            setOwned(false);
            emitStatus("player_stopped");
          }
        });
        return result;
      });
    }

    intercept(root, "speaker", value => { gateMethod(value, "readBook", false, () => false, false, true); return value; });
    function gateTtsUi(value) {
      intercept(value, "updateActiveSentence", method => typeof method !== 'function' ? method : function (...args) {
        if (!owned || !guardedReader || (listFollowTimer == null && !listScrollbarDrag)) return method.apply(this, args);
        // STV combines active-row styling and scrolling in this method. Keep
        // styling current while the user browses, without invoking its scroll.
        const list = this.overlay?.querySelector('#tts-sentence-list');
        list?.querySelectorAll('.tts-sentence-item').forEach(item => {
          item.classList.toggle('active', Number(item.dataset.index) === this.player?.currentSentenceIndex);
        });
      });
      gateMethod(value, "onContentLoaded");
      gateMethod(value, "setDocument", false, args => args[0] === guardedReader, true);
      gateMethod(value, "extractSentences", false, () => true, true);
      gateMethod(value, "removeOverlay", true);
      intercept(value, "player", player => {
        intercept(player, "highlighter", highlighter => {
          intercept(highlighter, "highlight", method => typeof method !== "function" ? method : function (nodes, ...args) {
            latestHighlight = { highlighter: this, method, nodes: Array.isArray(nodes) ? [...nodes] : nodes, args };
            syncFollowMenuState();
            if (owned && guardedReader) {
              suppressOwnedNativeHighlight(this, nodes);
              const sameGroup = continuingSentenceFocus && matchesFocusedSentences(nodes);
              continuingSentenceFocus = sameGroup;
              focusHighlightedNodes(nodes);
              if (!sameGroup) renderSentenceGlass(nodes, !followMenuOpen && autoFollowTimer == null);
              return undefined;
            }
            const result = method.call(this, nodes, ...args);
            suppressOwnedNativeHighlight(this, nodes);
            focusHighlightedNodes(nodes);
            return result;
          });
          intercept(highlighter, "clear", method => typeof method !== "function" ? method : function (...args) {
            const result = method.apply(this, args);
            // Native onended clears before incrementing the sentence index.
            // Preserve only a confirmed automatic continuation in the same group;
            // native stop sets isPlaying=false before reaching this method.
            const index = player.currentSentenceIndex;
            if (owned && guardedReader?.isConnected && !chapterChanged() && !internalCall
              && !overlayInteraction && !menuPaused && player.isPlaying === true
              && Number.isInteger(index) && index >= 0
              && matchesFocusedSentences(player.tokenizedSentences?.[index]?.nodes)
              && matchesFocusedSentences(player.tokenizedSentences?.[index + 1]?.nodes)) {
              continuingSentenceFocus = true;
              return result;
            }
            latestHighlight = null;
            removeFocusedSentences();
            return result;
          });
          return highlighter;
        });
        gateMethod(player, "setDocument", false, args => args[0] === guardedReader, true);
        gateMethod(player, "watch", false, args => args[0] === true, true);
        gateMethod(player, "tryUpdateAndPlayOnNewSentence", false, () => true, true);
        gateMethod(player, "notifyDocumentComplete");
        // STV also calls stop() for Pause and before jumping to another sentence.
        // Only removeOverlay() represents closing the listening UI/session.
        gateMethod(player, "stop", false, () => Boolean(guardedReader));
        return player;
      });
      return value;
    }
    intercept(root, "ttsUI", gateTtsUi);

    function stopSmoothFollow() {
      if (!smoothFollowActive) return;
      smoothFollowActive = false;
      root.scrollBy?.({ top: 0, left: 0, behavior: 'instant' });
    }

    const onFollowScrollEnd = () => { smoothFollowActive = false; };
    root.addEventListener?.('scrollend', onFollowScrollEnd);

    function cancelAutoFollow() {
      if (listFollowTimer != null) root.clearTimeout(listFollowTimer);
      listFollowTimer = null;
      stopSmoothFollow();
      if (autoFollowTimer != null) root.clearTimeout(autoFollowTimer);
      autoFollowTimer = null;
      latestHighlight = null;
      followMenuOpen = false;
      pageScrollbarDrag = null;
      listScrollbarDrag = null;
    }

    function resumeAutoFollow() {
      autoFollowTimer = null;
      syncFollowMenuState();
      if (followMenuOpen) return;
      const pending = latestHighlight;
      if (!owned || !guardedReader?.isConnected || !pending || !Array.isArray(pending.nodes)) return;
      suppressOwnedNativeHighlight(pending.highlighter, pending.nodes);
      focusHighlightedNodes(pending.nodes);
      renderSentenceGlass(pending.nodes, true);
    }

    function hasOpenFollowMenu() {
      return Array.from(document.querySelectorAll(FOLLOW_HOLD_SELECTOR)).some(element => (
        element.isConnected
        && !element.closest("[hidden]")
        && element.getAttribute("aria-hidden") !== "true"
      ));
    }

    function scheduleAutoFollow() {
      if (!owned || !guardedReader?.isConnected) return;
      if (pageScrollbarDrag) return;
      if (autoFollowTimer != null) root.clearTimeout(autoFollowTimer);
      autoFollowTimer = root.setTimeout(resumeAutoFollow, AUTO_FOLLOW_IDLE_MS);
    }

    function syncFollowMenuState() {
      const open = hasOpenFollowMenu();
      if (open === followMenuOpen) return open;
      followMenuOpen = open;
      if (open) {
        stopSmoothFollow();
        if (autoFollowTimer != null) root.clearTimeout(autoFollowTimer);
        autoFollowTimer = null;
      } else {
        scheduleAutoFollow();
      }
      return open;
    }

    function isToolOrControl(target) {
      return Boolean(target?.closest?.(`${TOOL_SURFACE_SELECTOR},${INTERACTIVE_SELECTOR}`));
    }

    function deferAutoFollow(event) {
      if (!owned || !guardedReader?.isConnected || isToolOrControl(event?.target)) return;
      stopSmoothFollow();
      scheduleAutoFollow();
    }

    function onReadingKey(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || !SCROLL_KEYS.has(event.key)) return;
      deferAutoFollow(event);
    }

    function onReadingPointer(event) {
      if (!owned || !guardedReader?.isConnected || isToolOrControl(event?.target)) return;
      const middleButton = event.button === 1;
      if (!middleButton && event.button != null && event.button !== 0) return;
      const viewport = document.documentElement;
      const inVerticalScrollbar = Number(event.clientX) >= Number(viewport?.clientWidth || root.innerWidth);
      const inHorizontalScrollbar = Number(event.clientY) >= Number(viewport?.clientHeight || root.innerHeight);
      if (!middleButton && !inVerticalScrollbar && !inHorizontalScrollbar) return;
      stopSmoothFollow();
      if (autoFollowTimer != null) root.clearTimeout(autoFollowTimer);
      autoFollowTimer = null;
      pageScrollbarDrag = { id: event.pointerId ?? "mouse" };
    }

    function scheduleListFollow(scroller, ui) {
      if (listFollowTimer != null) root.clearTimeout(listFollowTimer);
      listFollowTimer = root.setTimeout(() => {
        listFollowTimer = null;
        if (owned && guardedReader?.isConnected && !chapterChanged() && root.ttsUI === ui && scroller.isConnected) ui.updateActiveSentence?.();
      }, AUTO_FOLLOW_IDLE_MS);
    }

    function onListReadingInput(event) {
      if (!owned || !guardedReader?.isConnected) return;
      const scroller = event.target?.closest?.('.tts-sentence-scroller');
      if (!scroller || !root.ttsUI?.overlay?.contains(scroller)) return;
      if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (event.type === 'keydown' && (event.altKey || event.ctrlKey || event.metaKey || !SCROLL_KEYS.has(event.key))) return;
      if (event.type === 'pointerdown') {
        const rect = scroller.getBoundingClientRect();
        const scale = rect.width / scroller.offsetWidth || 1;
        const scrollbarStart = rect.left + (scroller.clientLeft + scroller.clientWidth) * scale;
        if (event.button !== 1 && !(event.button === 0 && event.clientX >= scrollbarStart)) return;
        if (listFollowTimer != null) root.clearTimeout(listFollowTimer);
        listFollowTimer = null;
        scroller.scrollTo?.({ top: scroller.scrollTop, left: scroller.scrollLeft, behavior: 'instant' });
        listScrollbarDrag = { id: event.pointerId ?? "mouse", scroller, ui: root.ttsUI };
        return;
      }
      if (listScrollbarDrag) return;
      if (listFollowTimer != null) root.clearTimeout(listFollowTimer);
      // Cancel any native smooth scroll already in progress in this list only.
      scroller.scrollTo?.({ top: scroller.scrollTop, left: scroller.scrollLeft, behavior: 'instant' });
      scheduleListFollow(scroller, root.ttsUI);
    }

    function onReadingPointerMove(event) {
      const id = event.pointerId ?? "mouse";
      if (pageScrollbarDrag?.id === id && autoFollowTimer != null) {
        root.clearTimeout(autoFollowTimer);
        autoFollowTimer = null;
      }
      if (listScrollbarDrag?.id === id && listFollowTimer != null) {
        root.clearTimeout(listFollowTimer);
        listFollowTimer = null;
      }
    }

    function finishReadingPointer(event) {
      const id = event?.pointerId ?? "mouse";
      if (pageScrollbarDrag?.id === id) {
        pageScrollbarDrag = null;
        scheduleAutoFollow();
      }
      if (listScrollbarDrag?.id === id) {
        const { scroller, ui } = listScrollbarDrag;
        listScrollbarDrag = null;
        if (scroller.isConnected) scheduleListFollow(scroller, ui);
      }
    }

    function finishAllReadingPointers() {
      if (pageScrollbarDrag) {
        pageScrollbarDrag = null;
        scheduleAutoFollow();
      }
      if (listScrollbarDrag) {
        const { scroller, ui } = listScrollbarDrag;
        listScrollbarDrag = null;
        if (scroller.isConnected) scheduleListFollow(scroller, ui);
      }
    }
    for (const event of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
      document.addEventListener(event, onListReadingInput, { capture: true, passive: true });
    }

    document.addEventListener("wheel", deferAutoFollow, { capture: true, passive: true });
    document.addEventListener("touchmove", deferAutoFollow, { capture: true, passive: true });
    document.addEventListener("keydown", onReadingKey, true);
    document.addEventListener("pointerdown", onReadingPointer, true);
    document.addEventListener("pointermove", onReadingPointerMove, true);
    document.addEventListener("pointerup", finishReadingPointer, true);
    document.addEventListener("pointercancel", finishReadingPointer, true);
    root.addEventListener?.("blur", finishAllReadingPointers);
    const followMenuObserver = typeof root.MutationObserver === "function"
      ? new root.MutationObserver(syncFollowMenuState)
      : null;
    followMenuObserver?.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "open"]
    });

    function emitStatus(code) {
      document.dispatchEvent(new root.CustomEvent(STATUS_EVENT, {
        detail: JSON.stringify({ code })
      }));
    }

    function playerForPage() {
      return root.ttsUI?.player || null;
    }

    function clearSentenceFocus() {
      continuingSentenceFocus = false;
      stopSentenceAnimation();
      sentenceGlass?.remove();
      sentenceGlass = null;
      for (const timer of sentenceFocusCleanupTimers.values()) root.clearTimeout(timer);
      sentenceFocusCleanupTimers.clear();
      for (const sentence of focusedSentences) sentence.classList?.remove("stvai-tts-sentence-active");
      focusedSentences.clear();
      for (const sentence of focusableSentences) {
        sentence.classList?.remove("stvai-tts-sentence-focusable");
        clearSentenceScale(sentence);
      }
      focusableSentences.clear();
    }

    function cancelSentenceFocusCleanup(sentence) {
      const timer = sentenceFocusCleanupTimers.get(sentence);
      if (timer != null) root.clearTimeout(timer);
      sentenceFocusCleanupTimers.delete(sentence);
    }

    function scheduleSentenceFocusCleanup(sentence) {
      if (!sentence) return;
      cancelSentenceFocusCleanup(sentence);
      const timer = root.setTimeout(() => {
        sentenceFocusCleanupTimers.delete(sentence);
        if (sentence.classList?.contains("stvai-tts-sentence-active")) return;
        sentence.classList?.remove("stvai-tts-sentence-focusable");
        clearSentenceScale(sentence);
        focusableSentences.delete(sentence);
      }, 240);
      sentenceFocusCleanupTimers.set(sentence, timer);
    }

    function removeFocusedSentences() {
      continuingSentenceFocus = false;
      stopSentenceAnimation();
      sentenceGlass?.remove();
      sentenceGlass = null;
      for (const previous of focusedSentences) {
        previous.classList?.remove("stvai-tts-sentence-active");
        scheduleSentenceFocusCleanup(previous);
      }
      focusedSentences.clear();
    }

    function setFocusedSentences(nextSentences) {
      const next = Array.from(new Set(nextSentences || []));
      if (!next.length || next.some((sentence) => sentence === guardedReader || !guardedReader?.contains(sentence))) {
        return removeFocusedSentences();
      }
      if (next.length === focusedSentences.size && next.every((sentence) => focusedSentences.has(sentence))) return;
      removeFocusedSentences();
      for (const sentence of next) {
        cancelSentenceFocusCleanup(sentence);
        sentence.classList.add("stvai-tts-sentence-focusable");
        sentence.classList.add("stvai-tts-sentence-active");
        focusableSentences.add(sentence);
        focusedSentences.add(sentence);
      }
      fitSentenceScale(latestHighlight?.nodes);
    }

    function sentenceRects(nodes) {
      const rects = [];
      for (const node of nodes || []) {
        if (!node || !guardedReader.contains(node) || node === guardedReader) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects?.() || []) {
          if (rect.width > 0 && rect.height > 0) rects.push(rect);
        }
      }
      return rects;
    }

    function clearSentenceScale(sentence) {
      for (const property of ['--stvai-sentence-scale', '--stvai-sentence-origin-x', '--stvai-sentence-origin-y']) sentence.style.removeProperty(property);
    }

    function stopSentenceAnimation() {
      if (sentenceAnimationFrame != null) root.cancelAnimationFrame?.(sentenceAnimationFrame);
      sentenceAnimationFrame = null;
    }

    function fitSentenceScale(nodes) {
      if (!guardedReader || !focusedSentences.size) return;
      stopSentenceAnimation();
      // Measure the unscaled text without changing DOM nodes or TTS offsets.
      const originals = [...focusedSentences].map(node => ({ node, transform: node.style.transform, transition: node.style.transition }));
      for (const { node } of originals) { node.style.transition = 'none'; node.style.transform = 'none'; }
      const rects = sentenceRects(nodes);
      if (rects.length) {
        const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
        const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
        const cy = (top + bottom) / 2;
        const viewportLeft = root.visualViewport?.offsetLeft || 0;
        const viewportRight = viewportLeft + (root.visualViewport?.width || root.innerWidth);
        const scale = Math.max(1, Math.min(1.11, (viewportRight - left - 8) / (right - left)));
        for (const { node } of originals) {
          const box = node.getBoundingClientRect();
          const zoom = box.width / node.offsetWidth || 1;
          node.style.setProperty('--stvai-sentence-origin-x', `${(left - box.left) / zoom}px`);
          node.style.setProperty('--stvai-sentence-origin-y', `${(cy - box.top) / zoom}px`);
          node.style.setProperty('--stvai-sentence-scale', String(scale));
          root.getComputedStyle?.(node).transform;
        }
      }
      for (const { node, transform, transition } of originals) {
        node.style.transform = transform;
        node.style.transition = transition;
      }
      if (!root.requestAnimationFrame || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const start = root.performance.now();
      const followGrowth = () => {
        sentenceAnimationFrame = null;
        if (!guardedReader?.isConnected || !focusedSentences.size) return;
        renderSentenceGlass(nodes, false);
        if (root.performance.now() - start < 250) sentenceAnimationFrame = root.requestAnimationFrame(followGrowth);
      };
      sentenceAnimationFrame = root.requestAnimationFrame(followGrowth);
    }

    function renderSentenceGlass(nodes, center = false) {
      if (!owned || !guardedReader?.isConnected || !Array.isArray(nodes)) return;
      const rects = sentenceRects(nodes);
      if (!rects.length) { sentenceGlass?.remove(); sentenceGlass = null; return; }
      const left = Math.min(...rects.map(r => r.left));
      const right = Math.max(...rects.map(r => r.right));
      const top = Math.min(...rects.map(r => r.top));
      const bottom = Math.max(...rects.map(r => r.bottom));
      const host = guardedReader.getBoundingClientRect();
      // Range rects use rendered viewport pixels; absolute children use local
      // coordinates. Divide by the actual scale, including CSS zoom.
      const sx = host.width / guardedReader.offsetWidth || 1;
      const sy = host.height / guardedReader.offsetHeight || sx;
      if (!sentenceGlass) {
        sentenceGlass = document.createElement('div');
        sentenceGlass.className = 'stvai-tts-sentence-glass';
        sentenceGlass.dataset.stvaiTtsExclude = 'true';
        sentenceGlass.setAttribute('aria-hidden', 'true');
        guardedReader.append(sentenceGlass);
      }
      Object.assign(sentenceGlass.style, {
        left: `${(left - host.left) / sx - 4}px`,
        top: `${(top - host.top) / sy - 4}px`,
        width: `${(right - left) / sx + 8}px`,
        height: `${(bottom - top) / sy + 8}px`
      });
      if (center) {
        const viewport = root.visualViewport;
        const height = viewport?.height || root.innerHeight;
        const target = bottom - top > height ? top + height / 2 - 12 : (top + bottom) / 2;
        const reducedMotion = root.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        smoothFollowActive = !reducedMotion;
        root.scrollBy?.({ top: target - (viewport?.offsetTop || 0) - height / 2, left: 0, behavior: reducedMotion ? 'instant' : 'smooth' });
      }
    }

    const onSentenceResize = () => {
      if (!latestHighlight || !owned || chapterChanged()) return;
      syncFollowMenuState();
      fitSentenceScale(latestHighlight.nodes);
      renderSentenceGlass(latestHighlight.nodes, !followMenuOpen && autoFollowTimer == null);
    };
    root.addEventListener?.('resize', onSentenceResize);
    root.visualViewport?.addEventListener?.('resize', onSentenceResize);
    const sentenceResizeObserver = typeof root.ResizeObserver === 'function' ? new root.ResizeObserver(onSentenceResize) : null;

    function sentenceFocusTargets(nodes) {
      if (!owned || !guardedReader || !Array.isArray(nodes)) return [];
      const elements = Array.from(new Set(nodes.map((node) => {
        if (node?.nodeType === 1) return node;
        if (node?.nodeType === 3) return node.parentElement;
        return null;
      }).filter((element) => element && element !== guardedReader && guardedReader.contains(element))));
      if (elements.length <= 1) return elements;
      const blocks = elements.map((element) => element.closest?.("[data-block-id]"));
      return blocks.every((element) => element && guardedReader.contains(element)) ? Array.from(new Set(blocks)) : [];
    }

    function matchesFocusedSentences(nodes) {
      const next = sentenceFocusTargets(nodes);
      return next.length > 0 && next.length === focusedSentences.size && next.every(node => focusedSentences.has(node));
    }

    function focusHighlightedNodes(nodes) {
      setFocusedSentences(sentenceFocusTargets(nodes));
    }

    function suppressOwnedNativeHighlight(highlighter, nodes) {
      if (!owned || !guardedReader || !Array.isArray(nodes)) return;
      const belongsToReader = nodes.some((node) => {
        const element = node?.nodeType === 1 ? node : node?.nodeType === 3 ? node.parentElement : null;
        return element && guardedReader.contains(element);
      });
      if (!belongsToReader) return;

      for (const highlighted of highlighter?.highlightedNodes || []) {
        if (highlighted?.classList?.contains("tts-highlight")) {
          highlighted.remove();
          continue;
        }
        if (highlighted?.nodeType === 1 && guardedReader.contains(highlighted)) {
          highlighted.style.backgroundColor = "";
        }
      }
      for (const node of nodes) {
        if (node?.nodeType === 1 && guardedReader.contains(node)) node.style.backgroundColor = "";
      }
    }

    function stopPlayer(removeOverlay) {
      internally(() => {
        const player = playerForPage();
        player?.unWatch?.();
        player?.stop?.();
        if (removeOverlay) root.ttsUI?.removeOverlay?.();
      });
    }

    function clearGuard() {
      sentenceResizeObserver?.disconnect();
      cancelPreview();
      pronunciationOpen = pronunciationOwnsPause = false;
      cancelAutoFollow();
      pausedByTool = false;
      menuPaused = false;
      pausedAtBatchEnd = false;
      documentComplete = false;
      completionNotified = false;
      clearSentenceFocus();
      guardedContainer = null;
      guardedCid = "";
      guardedUrl = "";
      guardedReader = null;
      pronunciationReplacer = pronunciation.createReplacer([]);
    }

    function chapterChanged() {
      if (!guardedContainer) return false;
      const current = sites?.chapterRoot
        ? sites.chapterRoot(document, root.location?.href)
        : document.querySelector("#content-container .contentbox[cid]");
      const readerParkedForOriginalView = guardedReader?.isConnected
        && guardedReader.dataset?.stvaiTtsBackground === "true";
      return !guardedContainer.isConnected
        || current !== guardedContainer
        || !guardedReader?.isConnected
        || (!guardedContainer.contains(guardedReader) && !readerParkedForOriginalView)
        || String(current?.getAttribute("cid") || "") !== guardedCid
        || String(root.location?.href || "") !== guardedUrl;
    }

    function holdForChapter() {
      if (!guardedContainer) return;
      pausedByTool = false;
      clearGuard();
      stopPlayer(true);
      emitStatus("chapter_changed");
    }

    function inspectListening(requestId) {
      if (!owned || !guardedReader?.isConnected || chapterChanged()) {
        return { ok: true, requestId, code: "inspected", listeningState: "absent" };
      }
      const player = playerForPage();
      if (!player) return { ok: true, requestId, code: "inspected", listeningState: "absent" };
      let listeningState = "ready";
      if (menuPaused) listeningState = "menu_paused";
      else if (player.isPlaying === true) listeningState = "playing";
      else if (documentComplete && completionNotified) listeningState = "completed";
      else if (player.isUserStopped === true) listeningState = "user_paused";
      else if (Boolean(player.watchInterval)
        || (Array.isArray(player.tokenizedSentences)
          && Number(player.currentSentenceIndex) >= player.tokenizedSentences.length)) {
        listeningState = "waiting_batch";
      }
      return { ok: true, requestId, code: "inspected", listeningState };
    }

    const onPageHide = () => { if (owned) holdForChapter(); };
    const onHistory = () => { if (chapterChanged()) holdForChapter(); };
    const onOverlayInput = event => {
      if (!event.target?.closest?.('.tts-control-overlay')) return;
      overlayInteraction = true;
      root.queueMicrotask(() => { overlayInteraction = false; });
    };
    document.addEventListener("click", onOverlayInput, true);
    document.addEventListener("keydown", onOverlayInput, true);
    root.addEventListener?.("pagehide", onPageHide);
    root.addEventListener?.("popstate", onHistory);
    for (const method of ["pushState", "replaceState"]) {
      intercept(root.history, method, original => typeof original !== "function" ? original : function (...args) {
        const result = original.apply(this, args);
        onHistory();
        return result;
      });
    }

    const Observer = root.MutationObserver;
    const observer = typeof Observer === "function" ? new Observer(() => {
      if (!chapterChanged()) return;
      holdForChapter();
    }) : null;
    observer?.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["cid"] });

    function open(requestId, pronunciations) {
      const container = sites?.chapterRoot
        ? sites.chapterRoot(document, root.location?.href)
        : document.querySelector("#content-container .contentbox[cid]");
      if (!container) return { ok: false, requestId, code: "chapter_missing" };
      const reader = container.querySelector(".stvai-reader--translation[data-stvai-tts-ready=\"true\"]");
      if (!reader || !Array.from(reader.querySelectorAll("[data-block-id]")).some((node) => node.textContent.trim())) {
        return { ok: false, requestId, code: "translation_not_ready" };
      }
      if (guardedReader === reader && !chapterChanged()) return { ok: true, requestId, code: "opened" };
      openingReader = reader;
      pronunciationReplacer = pronunciation.createReplacer(pronunciations);
      const existing = root.ttsUI;

      if (!root.ttsUI) {
        if (typeof root.speaker?.readBook !== "function") {
          setOwned(false);
          return { ok: false, requestId, code: "stv_tts_unavailable" };
        }
        const previousContainer = root.contentcontainer;
        const previousId = reader.id;
        if (!previousId) reader.id = `stvai-tts-${String(container.getAttribute("cid") || "chapter")}`;
        try {
          root.contentcontainer = reader.id;
          withAiText(() => root.speaker.readBook());
        } finally {
          root.contentcontainer = previousContainer;
          if (!previousId) reader.removeAttribute("id");
        }
      }

      const ui = root.ttsUI;
      gateTtsUi(ui);
      if (!ui?.player || !["setDocument", "watch", "unWatch", "stop", "notifyDocumentComplete"]
        .every(method => typeof ui.player[method] === "function")
        || typeof ui.extractSentences !== "function") {
        if (!existing && ui?.player) {
          internally(() => {
            ui.player.unWatch?.();
            ui.player.stop?.();
            ui.removeOverlay?.();
          });
        }
        clearGuard();
        setOwned(false);
        return { ok: false, requestId, code: "stv_tts_changed" };
      }
      const previousDocument = ui.element || ui.player.document || null;
      guardedContainer = container;
      guardedCid = String(container.getAttribute("cid") || "");
      guardedUrl = String(root.location?.href || "");
      guardedReader = reader;
      sentenceResizeObserver?.observe(reader);
      documentComplete = false;
      completionNotified = false;
      menuPaused = false;
      pausedAtBatchEnd = false;
      setOwned(true);
      try {
        if (existing?.player) {
          existing.player.unWatch?.();
          existing.player.stop?.();
        }
        if (typeof ui.setDocument === "function") ui.setDocument(reader);
        else {
          ui.element = reader;
          ui.player.setDocument(reader);
        }
        ui.extractSentences?.();
        if (existing || !document.querySelector(".tts-control-overlay")) ui.renderOverlay?.();
        clearSentenceFocus();
        ui.player.watch?.(true);
      } catch (_error) {
        internally(() => {
          ui.player.unWatch?.();
          ui.player.stop?.();
          if (!existing) ui.removeOverlay?.();
          else if (previousDocument && previousDocument !== reader) ui.player.setDocument?.(previousDocument);
        });
        clearGuard();
        setOwned(false);
        return { ok: false, requestId, code: "stv_tts_changed" };
      }
      emitStatus("reader_opened");
      pausedByTool = false;
      return { ok: true, requestId, code: "opened" };
    }

    async function previewText(command, player) {
      cancelPreview();
      const provider = player.provider;
      if (!pronunciationOpen || !menuPaused || provider?.isDirectOnly || typeof provider?.fetchAudio !== 'function') {
        return { ok: false, requestId: command.requestId, code: 'preview_unavailable' };
      }
      let cancelled = false, timedOut = false, audio, url, timer, finish;
      const cancellation = new Promise(resolve => { finish = resolve; });
      const cleanup = () => {
        cancelled = true;
        root.clearTimeout(timer);
        if (audio) {
          audio.onended = audio.onerror = null;
          audio.pause(); audio.removeAttribute('src'); audio.load();
          audio = null;
        }
        if (url) { root.URL.revokeObjectURL(url); url = null; }
        finish(null);
      };
      cancelPreview = cleanup;
      timer = root.setTimeout(() => { timedOut = true; cleanup(); }, 8000);
      try {
        // STV blob providers take the active provider's voice/rate/pitch options.
        // Preview never enters the book's sentence queue or audio cache.
        const blob = await Promise.race([provider.fetchAudio(command.text, { ...provider.options }), cancellation]);
        if (cancelled || disposed || chapterChanged() || !pronunciationOpen) {
          cleanup();
          return { ok: !timedOut, requestId: command.requestId, code: timedOut ? 'preview_timeout' : 'preview_cancelled' };
        }
        if (!(blob instanceof root.Blob) || !blob.size) throw new Error('empty_audio');
        root.clearTimeout(timer);
        timer = root.setTimeout(cleanup, 60000);
        url = root.URL.createObjectURL(blob);
        audio = new root.Audio(url);
        const rate = Number(provider.getPlaybackOptions?.().playbackRate);
        if (Number.isFinite(rate) && rate > 0) audio.playbackRate = rate;
        audio.onended = cleanup;
        audio.onerror = cleanup;
        await audio.play();
        return { ok: true, requestId: command.requestId, code: 'preview_playing' };
      } catch (_) {
        cleanup();
        return { ok: false, requestId: command.requestId, code: 'preview_failed' };
      }
    }

    function handle(rawCommand) {
      const command = validateCommand(rawCommand);
      if (command.action === "arm") {
        if (!armed && !owned && root.ttsUI?.player?.isPlaying) {
          internally(() => {
            root.ttsUI.player.unWatch?.();
            root.ttsUI.player.stop?.();
            root.ttsUI.removeOverlay?.();
          });
        }
        setArmed(true);
        return { ok: true, requestId: command.requestId, code: "armed" };
      }
      if (command.action === "release") {
        pausedByTool = false;
        if (guardedReader) stopPlayer(true);
        clearGuard();
        setOwned(false);
        setArmed(false);
        return { ok: true, requestId: command.requestId, code: "released" };
      }
      if (command.action === "stop") {
        pausedByTool = false;
        stopPlayer(true);
        clearGuard();
        setOwned(false);
        return { ok: true, requestId: command.requestId, code: "stopped" };
      }
      if (chapterChanged()) holdForChapter();
      if (command.action === "inspect") return inspectListening(command.requestId);
      if (command.action === "open") {
        setArmed(true);
        try { return internally(() => open(command.requestId, command.pronunciations)); }
        finally { openingReader = null; }
      }
      if (!guardedReader) return { ok: false, requestId: command.requestId, code: "translation_not_ready" };
      const player = playerForPage();
      if (!player) return { ok: false, requestId: command.requestId, code: "stv_tts_unavailable" };
      if (command.action === 'pronunciation-open') {
        if (!pronunciationOpen) {
          pronunciationOwnsPause = !menuPaused;
          handle({ action: 'pause', requestId: command.requestId });
          pronunciationOpen = true;
        }
        return { ok: true, requestId: command.requestId, code: 'pronunciation_opened' };
      }
      if (command.action === 'pronunciation-close') {
        cancelPreview();
        const resume = pronunciationOpen && pronunciationOwnsPause;
        pronunciationOpen = pronunciationOwnsPause = false;
        return resume ? handle({ action: 'resume', requestId: command.requestId })
          : { ok: true, requestId: command.requestId, code: 'pronunciation_closed' };
      }
      if (command.action === 'preview') return previewText(command, player);
      if (command.action === "pause") {
        if (menuPaused) return { ok: true, requestId: command.requestId, code: "paused" };
        pausedByTool = player.isPlaying === true || (player.isUserStopped === false && Boolean(player.watchInterval));
        pausedAtBatchEnd = !player.isPlaying && player.isUserStopped === false
          && Array.isArray(player.tokenizedSentences)
          && player.currentSentenceIndex >= player.tokenizedSentences.length;
        menuPaused = true;
        internally(() => { player.unWatch(); player.stop?.(); });
        return { ok: true, requestId: command.requestId, code: "paused" };
      }
      if (command.action === "resume") {
        const closingMenu = menuPaused;
        const shouldResume = menuPaused ? pausedByTool : player.isPlaying === false;
        if (shouldResume && typeof player.resume !== "function") {
          return { ok: false, requestId: command.requestId, code: "stv_tts_changed" };
        }
        menuPaused = false;
        if (!shouldResume) {
          if (closingMenu) internally(() => { if (documentComplete) player.unWatch(); else player.watch(true); });
          pausedAtBatchEnd = false;
          return { ok: true, requestId: command.requestId, code: player.isPlaying ? "already_playing" : "user_paused" };
        }
        internally(() => {
          root.ttsUI?.extractSentences?.();
          // watch() does not clear STV's isUserStopped flag. Native resume()
          // restarts the current sentence; completed documents must not watch
          // again, since STV uses absence of a watcher to emit FINISH at EOF.
          if (documentComplete) {
            notifyCompletion(player);
            if (Array.isArray(player.tokenizedSentences)
              && player.currentSentenceIndex >= player.tokenizedSentences.length) return;
          } else {
            player.watch?.(true);
            // At temporary EOF the native watcher owns starting newly appended
            // text. Calling resume as well would queue that sentence twice.
            if (pausedAtBatchEnd) return;
          }
          player.resume();
        });
        pausedByTool = false;
        pausedAtBatchEnd = false;
        return { ok: true, requestId: command.requestId, code: "resumed" };
      }
      if (command.action === "watch") {
        if (menuPaused || documentComplete) {
          return { ok: true, requestId: command.requestId, code: "watch_deferred" };
        }
        internally(() => {
          // The reader grows batch by batch. Refresh STV's sentence list before
          // rearming its watcher so reaching the temporary end of batch 1 does
          // not strand playback while later verified AI batches arrive.
          root.ttsUI?.extractSentences?.();
          player.watch?.(true);
        });
        return { ok: true, requestId: command.requestId, code: "watching" };
      }
      if (command.action === "complete") {
        documentComplete = true;
        if (!menuPaused) internally(() => notifyCompletion(player));
        return { ok: true, requestId: command.requestId, code: "completed" };
      }
    }

    function notifyCompletion(player) {
      if (completionNotified) return;
      completionNotified = true;
      try { player.notifyDocumentComplete(); }
      catch (error) { completionNotified = false; throw error; }
    }

    return Object.freeze({
      handle,
      destroy() {
        disposed = true;
        observer?.disconnect();
        followMenuObserver?.disconnect();
        root.removeEventListener?.('resize', onSentenceResize);
        root.removeEventListener?.('scrollend', onFollowScrollEnd);
        root.visualViewport?.removeEventListener?.('resize', onSentenceResize);
        root.removeEventListener?.("pagehide", onPageHide);
        root.removeEventListener?.("popstate", onHistory);
        document.removeEventListener("click", onOverlayInput, true);
        document.removeEventListener("keydown", onOverlayInput, true);
        document.removeEventListener("wheel", deferAutoFollow, true);
        document.removeEventListener("touchmove", deferAutoFollow, true);
        document.removeEventListener("keydown", onReadingKey, true);
        document.removeEventListener("pointerdown", onReadingPointer, true);
        document.removeEventListener("pointermove", onReadingPointerMove, true);
        document.removeEventListener("pointerup", finishReadingPointer, true);
        document.removeEventListener("pointercancel", finishReadingPointer, true);
        root.removeEventListener?.("blur", finishAllReadingPointers);
        for (const event of ['wheel', 'touchmove', 'keydown', 'pointerdown']) document.removeEventListener(event, onListReadingInput, true);
        if (guardedReader) stopPlayer(true);
        clearGuard();
        for (const restore of unhook.reverse()) restore();
      }
    });
  }

  function install(root) {
    const bridge = createBridge(root);
    const nativeActionListener = event => {
      const node = event.target;
      if (
        node?.nodeType !== 1
        || node.dataset?.stvaiNativeActionRelay !== "true"
        || !node.isConnected
        || !node.closest?.("#content-container .contentbox[cid]")
      ) return;
      const source = String(node.getAttribute("ontouchup") || "").trim();
      const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\(\)\s*;?$/.exec(source);
      if (!match) return;
      const action = root[match[1]];
      if (typeof action !== "function") return;
      action.call(root);
    };
    const listener = (event) => {
      let parsed;
      let response;
      try {
        parsed = JSON.parse(String(event.detail || ""));
        response = bridge.handle(parsed);
      } catch (_error) {
        response = {
          ok: false,
          requestId: /^[a-zA-Z0-9_-]{1,100}$/.test(String(parsed?.requestId || ""))
            ? String(parsed.requestId)
            : "invalid",
          code: "invalid_command"
        };
      }
      const deliver = value => root.document.dispatchEvent(new root.CustomEvent(RESULT_EVENT, {
        detail: JSON.stringify(value)
      }));
      if (response?.then) response.then(deliver, () => deliver({ ok: false, requestId: parsed.requestId, code: 'preview_failed' }));
      else deliver(response);
    };
    root.document.addEventListener(COMMAND_EVENT, listener);
    root.document.addEventListener(NATIVE_ACTION_EVENT, nativeActionListener);
    return () => {
      root.document.removeEventListener(COMMAND_EVENT, listener);
      root.document.removeEventListener(NATIVE_ACTION_EVENT, nativeActionListener);
      bridge.destroy();
    };
  }

  return Object.freeze({
    COMMAND_EVENT, RESULT_EVENT, STATUS_EVENT, NATIVE_ACTION_EVENT,
    createBridge, install, validateCommand
  });
});
