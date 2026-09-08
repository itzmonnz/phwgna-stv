(function attachUI(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createUI() {
  "use strict";

  const UI_SCALES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5]);
  const VIETNAMESE_SORTER = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });
  function firstSortWord(value) {
    return String(value || '').trim().split(/\s+/u, 1)[0] || '';
  }
  function compareFirstWord(left, right) {
    return VIETNAMESE_SORTER.compare(firstSortWord(left), firstSortWord(right))
      || VIETNAMESE_SORTER.compare(String(left || ''), String(right || ''));
  }
  function pronunciationGroup(source) {
    const value = String(source || '').trim();
    if (!/^\p{L}/u.test(value)) return 0;
    const letters = value.match(/\p{L}/gu) || [];
    const allUppercase = letters.length > 0 && letters.every(letter => (
      letter === letter.toLocaleUpperCase('vi') && letter !== letter.toLocaleLowerCase('vi')
    ));
    return allUppercase ? 1 : 2;
  }
  function sortPronunciationMappings(mappings) {
    return mappings.map((mapping, index) => ({ ...mapping, index })).sort((left, right) => (
      pronunciationGroup(left.source) - pronunciationGroup(right.source)
      || compareFirstWord(left.source, right.source)
      || left.index - right.index
    ));
  }
  function normalizeUiScale(value) {
    const number = Number(value);
    return UI_SCALES.includes(number) ? number : 1;
  }
  function applyUiScale(document, value) {
    const scale = normalizeUiScale(value);
    document?.documentElement?.style?.setProperty("--stvai-ui-scale", String(scale));
    return scale;
  }

  function circularPoint(center, radius, angle) {
    const radians = (angle - 90) * Math.PI / 180;
    const round = number => Number(number.toFixed(4));
    return { x: round(center + radius * Math.cos(radians)), y: round(center + radius * Math.sin(radians)) };
  }

  function circularProgressArc(index, total, center = 24, radius = 22) {
    const stepAngle = 360 / total;
    const gapAngle = Math.min(24, stepAngle * 0.36);
    const arcAngle = stepAngle - gapAngle;
    const start = circularPoint(center, radius, index * stepAngle + gapAngle / 2);
    const end = circularPoint(center, radius, (index + 1) * stepAngle - gapAngle / 2);
    return {
      arcAngle,
      path: `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${arcAngle > 180 ? 1 : 0} 1 ${end.x} ${end.y}`
    };
  }

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function motion() {
    return globalThis.STVAIMotion || null;
  }

  function brandIconUrl() {
    const branding = globalThis.STVAIBranding
      || (typeof require === "function" ? require("../shared/branding.js") : null);
    if (branding?.iconUrl) return branding.iconUrl();
    try {
      if (typeof globalThis.chrome?.runtime?.getURL === "function") {
        return globalThis.chrome.runtime.getURL("assets/icons/phwgna-cat-128.png");
      }
    } catch (_error) {
      // Non-extension previews keep the stable relative fallback.
    }
    return "assets/icons/phwgna-cat-128.png";
  }

  function brandIcon(document, className = "stvai-brand-icon") {
    const branding = globalThis.STVAIBranding
      || (typeof require === "function" ? require("../shared/branding.js") : null);
    if (branding?.createIcon) return branding.createIcon(document, className);
    const image = element(document, "img", className);
    image.src = "assets/icons/phwgna-cat-128.png";
    image.alt = "";
    image.draggable = false;
    image.setAttribute("aria-hidden", "true");
    return image;
  }

  function consentBrand(document, text) {
    const brand = element(document, "div", "stvai-consent-brand");
    brand.append(
      brandIcon(document, "stvai-brand-icon stvai-consent-brand-icon"),
      element(document, "span", "stvai-consent-eyebrow", text)
    );
    return brand;
  }

  function safeImageUrl(value, base) {
    try {
      const url = new URL(String(value || ""), base || "https://sangtacviet.app/");
      if (url.protocol === "https:") return url.href;
      const sites = globalThis.STVAISites || (typeof require === "function" ? require("../shared/stv-sites.js") : null);
      return url.protocol === "http:" && sites?.siteUrl?.(url.href) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  const COPYRIGHT_NOTICE = "App do phwgna phát triển, bất kì phiên bản trả phí khác đều là lừa đảo";

  function createCopyrightGuard(document, chapterContainer) {
    if (!document || !chapterContainer?.parentNode) {
      throw new Error("Không thể gắn thông báo bản quyền.");
    }
    const host = document.createElement("aside");
    host.className = "stvai-copyright-notice";
    host.setAttribute("data-stvai-copyright", "protected");
    host.setAttribute("role", "note");
    host.setAttribute("aria-label", COPYRIGHT_NOTICE);

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block !important;
        box-sizing: border-box;
        width: max-content !important;
        max-width: calc(100% - 24px);
        margin: 0 auto 14px !important;
      }
      .notice {
        box-sizing: border-box;
        width: auto;
        max-width: 100%;
        padding: 10px 14px;
        border: 1px solid rgba(34, 211, 238, .38);
        border-left: 4px solid #22d3ee;
        border-radius: 8px;
        background: rgba(15, 23, 42, .92);
        color: #f8fafc;
        font: 700 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
    `;
    const line = document.createElement("div");
    line.className = "notice";
    line.textContent = COPYRIGHT_NOTICE;
    shadow.append(style, line);

    const parent = chapterContainer.parentNode;
    let destroyed = false;
    let observedParent;
    const Observer = document.defaultView?.MutationObserver || globalThis.MutationObserver;
    let observer;

    function observeParent(currentParent) {
      if (!observer || observedParent === currentParent) return;
      observer.disconnect();
      observer.observe(currentParent, {
        attributes: true,
        childList: true,
        subtree: true
      });
      observedParent = currentParent;
    }

    function ensureIntegrity() {
      if (destroyed || !chapterContainer.parentNode) return;
      const currentParent = chapterContainer.parentNode;
      if (host.parentNode !== currentParent || host.nextSibling !== chapterContainer) {
        currentParent.insertBefore(host, chapterContainer);
      }
      if (host.className !== "stvai-copyright-notice") host.className = "stvai-copyright-notice";
      if (host.getAttribute("data-stvai-copyright") !== "protected") {
        host.setAttribute("data-stvai-copyright", "protected");
      }
      if (host.getAttribute("role") !== "note") host.setAttribute("role", "note");
      if (host.getAttribute("aria-label") !== COPYRIGHT_NOTICE) {
        host.setAttribute("aria-label", COPYRIGHT_NOTICE);
      }
      observeParent(currentParent);
    }

    parent.insertBefore(host, chapterContainer);
    observer = typeof Observer === "function" ? new Observer(ensureIntegrity) : null;
    observeParent(parent);

    return Object.freeze({
      destroy() {
        destroyed = true;
        observer?.disconnect();
        host.remove();
      }
    });
  }

  function applyTranslationOrigin(paragraph, origin, mode) {
    const value = mode === "translation" && origin === "convert" ? "convert" : "";
    paragraph.classList.toggle("stvai-reader-paragraph--convert", value === "convert");
    if (value) paragraph.dataset.translationOrigin = value;
    else delete paragraph.dataset.translationOrigin;
  }

  function createTextBlock(document, block, values, mode, inline, origins) {
    const className = inline ? "stvai-reader-inline-text" : "stvai-reader-paragraph";
    // STV's native sentence scanner skips text directly inside SPAN.
    const paragraph = element(document, inline ? "i" : "p", className);
    paragraph.dataset.blockId = String(block.id);
    if (mode === "translation") {
      paragraph.textContent = typeof values[block.id] === "string" && values[block.id].trim()
        ? values[block.id].trim()
        : "";
      if (!values[block.id]) {
        paragraph.classList.add("stvai-reader-paragraph--pending");
        paragraph.setAttribute("aria-label", "Đang chờ bản dịch");
      }
    } else {
      paragraph.textContent = String(block.text || "");
    }
    applyTranslationOrigin(paragraph, origins?.[block.id], mode);
    return paragraph;
  }

  function isInlineNative(block) {
    return block?.kind === "native" && block.inline === true;
  }

  function paragraphGroupOf(block) {
    return block?.kind === "text" && typeof block.paragraphGroup === "string"
      ? block.paragraphGroup.trim()
      : "";
  }

  function appendInlineSeparator(document, line) {
    if (!line.lastChild || /\s$/.test(line.lastChild.textContent || "")) return;
    line.append(document.createTextNode(" "));
  }

  function nativeNodeAvailable(block) {
    // A live anchor with a removed node means STV expired/consumed it.
    return block.node?.nodeType === 1 && !(block.anchor?.isConnected && !block.node.isConnected);
  }

  const BUYER_PRESENTATION_PROPERTIES = new Set([
    "color", "fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight",
    "letterSpacing", "textAlign", "textDecoration", "textTransform", "whiteSpace"
  ]);

  function createBuyerAttribution(document, block) {
    const footer = element(document, "div", "stvai-buyer-attribution");
    footer.dataset.stvaiTtsExclude = "true";
    for (const [property, value] of Object.entries(block.presentation || {})) {
      if (BUYER_PRESENTATION_PROPERTIES.has(property) && typeof value === "string") {
        footer.style[property] = value;
      }
    }
    if (nativeNodeAvailable(block)) footer.append(block.node);
    else footer.textContent = String(block.text || "");
    return footer;
  }

  function createReaderView(document, blocks, translations, mode, translationOrigins) {
    const root = element(document, "article", `stvai-reader stvai-reader--${mode}`);
    root.dataset.mode = mode;
    const values = translations && typeof translations === "object" ? translations : {};
    const hasTranslation = (blocks || []).some((block) =>
      block.kind === "text"
      && typeof values[block.id] === "string"
      && values[block.id].trim()
    );
    if (mode === "translation" && !hasTranslation) {
      const empty = element(
        document,
        "p",
        "stvai-reader-paragraph stvai-reader-paragraph--pending",
        "Chưa có bản dịch. Bấm Dịch AI để bắt đầu."
      );
      root.append(empty);
      return root;
    }
    const sourceBlocks = Array.isArray(blocks) ? blocks : [];
    for (let index = 0; index < sourceBlocks.length;) {
      const block = sourceBlocks[index];
      if (
        (block.kind === "text" && isInlineNative(sourceBlocks[index + 1]))
        || (isInlineNative(block) && !isInlineNative(sourceBlocks[index - 1]))
      ) {
        const line = element(document, "p", "stvai-reader-paragraph stvai-reader-paragraph--inline-run");
        while (index < sourceBlocks.length) {
          const item = sourceBlocks[index];
          if (item.kind === "text") {
            if (isInlineNative(sourceBlocks[index - 1])) appendInlineSeparator(document, line);
            line.append(createTextBlock(document, item, values, mode, true, translationOrigins));
            index += 1;
            if (!isInlineNative(sourceBlocks[index])) break;
            continue;
          }
          if (isInlineNative(item)) {
            appendInlineSeparator(document, line);
            if (nativeNodeAvailable(item)) line.append(item.node);
            index += 1;
            if (sourceBlocks[index]?.kind !== "text" && !isInlineNative(sourceBlocks[index])) break;
            continue;
          }
          break;
        }
        root.append(line);
        continue;
      }
      if (block.kind === "native") {
        if (nativeNodeAvailable(block)) root.append(block.node);
        index += 1;
        continue;
      }
      if (block.kind === "buyer_attribution") {
        root.append(createBuyerAttribution(document, block));
        index += 1;
        continue;
      }
      if (block.kind === "image") {
        const src = safeImageUrl(block.src, document.URL);
        if (!src) {
          index += 1;
          continue;
        }
        const figure = element(document, "figure", "stvai-reader-figure");
        const image = element(document, "img", "stvai-reader-image");
        image.addEventListener("error", () => figure.remove(), { once: true });
        image.src = src;
        image.alt = String(block.alt || "Minh họa trong chương");
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        figure.append(image);
        root.append(figure);
        index += 1;
        continue;
      }
      const paragraphGroup = paragraphGroupOf(block);
      if (paragraphGroup && block.kind === "text") {
        const groupedBlocks = [];
        let cursor = index;
        while (
          cursor < sourceBlocks.length
          && sourceBlocks[cursor]?.kind === "text"
          && paragraphGroupOf(sourceBlocks[cursor]) === paragraphGroup
        ) {
          groupedBlocks.push(sourceBlocks[cursor]);
          cursor += 1;
        }
        if (groupedBlocks.length > 1) {
          const paragraph = element(
            document,
            "p",
            "stvai-reader-paragraph stvai-reader-paragraph--group"
          );
          groupedBlocks.forEach((item, itemIndex) => {
            if (itemIndex > 0) paragraph.append(document.createTextNode(" "));
            paragraph.append(createTextBlock(document, item, values, mode, true, translationOrigins));
          });
          root.append(paragraph);
          index = cursor;
          continue;
        }
      }
      if (block.kind === "text") root.append(createTextBlock(document, block, values, mode, false, translationOrigins));
      index += 1;
    }
    return root;
  }

  function restoreNativeBlocks(blocks) {
    for (const block of blocks || []) {
      if (block.kind !== "native" && block.kind !== "buyer_attribution") continue;
      if (!block.node || !block.anchor?.parentNode) continue;
      block.anchor.parentNode.insertBefore(block.node, block.anchor);
    }
  }

  function createNativeSync(document, options) {
    const container = options?.container;
    if (!container?.append) throw new TypeError("chapter container is required");
    const blocks = Array.isArray(options?.blocks) ? options.blocks : [];
    const sourceNodeBlockIds = options?.sourceNodeBlockIds;
    const onTrace = typeof options?.onTrace === "function" ? options.onTrace : () => {};
    const Observer = document.defaultView?.MutationObserver || globalThis.MutationObserver;
    const lateRecords = [];
    let sourceLayer = null;
    let reader = null;
    let observer = null;
    let suppress = false;
    const cid = container.getAttribute("cid");
    const nativeActionRelays = new Map();
    const nativeImageObservers = new Map();

    const candidateSelector = [
      "a", "img", "picture", "video", "audio", "svg", "canvas", "iframe", "button",
      "[role='button']", "[onclick]", "[onmousedown]", "[ontouchup]", ".btn"
    ].join(",");

    function candidateType(node) {
      if (node.matches("button,[role='button'],.btn")) return "button";
      if (node.matches("a")) return "link";
      if (node.matches("img,picture,svg,canvas")) return "image";
      if (node.matches("video,audio,iframe")) return "media";
      return "interactive";
    }

    function disarmNativeActionRelay(node) {
      const cleanup = nativeActionRelays.get(node);
      if (!cleanup) return;
      cleanup();
      nativeActionRelays.delete(node);
    }

    function armNativeActionRelay(node) {
      if (
        nativeActionRelays.has(node)
        || !node.hasAttribute("ontouchup")
        || node.hasAttribute("onclick")
        || node.hasAttribute("onmousedown")
      ) return;
      const relay = event => {
        if (!reader?.contains(node)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        node.dispatchEvent(new document.defaultView.CustomEvent("stvai:native-action", {
          bubbles: true,
          cancelable: false
        }));
      };
      node.dataset.stvaiNativeActionRelay = "true";
      node.addEventListener("click", relay, true);
      nativeActionRelays.set(node, () => {
        node.removeEventListener("click", relay, true);
        delete node.dataset.stvaiNativeActionRelay;
      });
    }

    function nativeImagesWithin(node) {
      if (node?.nodeType !== 1) return [];
      if (node.matches("img")) return [node];
      return Array.from(node.querySelectorAll?.("img") || []);
    }

    function observeNativeImages(node) {
      for (const image of nativeImagesWithin(node)) {
        if (nativeImageObservers.has(image)) continue;
        const markBroken = () => image.classList.add("stvai-native-image--broken");
        const markLoaded = () => image.classList.remove("stvai-native-image--broken");
        image.addEventListener("error", markBroken);
        image.addEventListener("load", markLoaded);
        nativeImageObservers.set(image, () => {
          image.removeEventListener("error", markBroken);
          image.removeEventListener("load", markLoaded);
          image.classList.remove("stvai-native-image--broken");
        });
        if (image.complete === true && typeof image.naturalWidth === "number") {
          if (image.naturalWidth > 0) markLoaded();
          else markBroken();
        }
      }
    }

    function sourceBoundary(node) {
      if (!container.contains(node)) return { before: null, after: null };
      const walker = document.createTreeWalker(container, 1);
      let before = null;
      let after = null;
      let passed = false;
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current === node) {
          passed = true;
          continue;
        }
        if (!current.matches?.("i[t]") || reader?.contains(current) || node.contains(current)) continue;
        if (!passed) before = current;
        else {
          after = current;
          break;
        }
      }
      return { before, after };
    }

    function placeInReader(node, boundary, record) {
      const beforeId = sourceNodeBlockIds?.get?.(boundary.before) || "";
      const afterId = sourceNodeBlockIds?.get?.(boundary.after) || "";
      record.beforeId = beforeId; record.afterId = afterId;
      const peers = lateRecords.filter(item => item !== record && item.beforeId === beforeId
        && item.afterId === afterId && reader.contains(item.node) && container.contains(item.anchor));
      peers.sort((a, b) => a.anchor.compareDocumentPosition(b.anchor) & 4 ? -1 : 1);
      const next = peers.find(item => node.compareDocumentPosition(item.anchor) & 4);
      const previous = peers.at(-1);
      if (next || previous) {
        if (next) next.node.before(node); else previous.node.after(node);
        return beforeId && afterId ? "both" : beforeId ? "before" : "after";
      }
      const beforeBlock = beforeId
        ? Array.from(reader.querySelectorAll("[data-block-id]")).find(item => item.dataset.blockId === beforeId)
        : null;
      const afterBlock = afterId
        ? Array.from(reader.querySelectorAll("[data-block-id]")).find(item => item.dataset.blockId === afterId)
        : null;
      if (afterBlock && (!beforeBlock || beforeId !== afterId)) {
        afterBlock.parentNode.insertBefore(node, afterBlock);
        return boundary.before ? "both" : "after";
      }
      if (beforeBlock) {
        beforeBlock.parentNode.insertBefore(node, beforeBlock.nextSibling);
        return boundary.after ? "both" : "before";
      }
      if (afterBlock) {
        afterBlock.parentNode.insertBefore(node, afterBlock);
        return "after";
      }
      return "none";
    }

    function portal(node) {
      if (!reader?.isConnected || !container.contains(node) || reader.contains(node) || node.matches("i[t]")) return;
      const boundary = sourceBoundary(node);
      let record = lateRecords.find(item => item.node === node);
      if (!record) {
        const anchor = document.createComment("stvai-late-native");
        node.after(anchor);
        record = { node, anchor, type: candidateType(node) };
        lateRecords.push(record);
      }
      const resolved = placeInReader(node, boundary, record);
      if (resolved !== "none") {
        armNativeActionRelay(node);
        observeNativeImages(node);
      }
      if (record.resolved === resolved && resolved === "none") return;
      record.resolved = resolved;
      onTrace({
        type: resolved === "none" ? "native_position_unresolved" : "native_moved_to_reader",
        candidateType: record.type,
        boundary: resolved,
        handlers: {
          onclick: node.hasAttribute("onclick"),
          onmousedown: node.hasAttribute("onmousedown"),
          ontouchup: node.hasAttribute("ontouchup")
        }
      });
    }

    function candidatesFrom(node) {
      if (node?.nodeType !== 1 || reader?.contains(node)) return [];
      const found = node.matches(candidateSelector) ? [node] : Array.from(node.querySelectorAll(candidateSelector));
      return found.filter(candidate => !candidate.closest("script,template,noscript,.stvai-reader")
        && !candidate.matches("i[t]") && !candidate.parentElement?.closest(candidateSelector));
    }

    function observe() {
      observer?.disconnect();
      if (typeof Observer !== "function" || !sourceLayer) return;
      observer = new Observer(records => {
        if (suppress || !reader?.isConnected || container.getAttribute("cid") !== cid) return;
        for (const record of records) {
          for (const added of record.addedNodes) {
            for (const candidate of candidatesFrom(added)) portal(candidate);
          }
        }
      });
      observer.observe(container, { childList: true, subtree: true });
    }

    function showReader(nextReader) {
      if (!nextReader || container.getAttribute("cid") !== cid) return;
      if (reader === nextReader && reader.isConnected) return;
      if (reader) showOriginal();
      suppress = true;
      observer?.disconnect();
      reader = nextReader;
      if (!sourceLayer) {
        container.classList.add("stvai-native-sync-active");
        sourceLayer = element(document, "div", "stvai-native-source-layer");
        sourceLayer.setAttribute("aria-hidden", "true");
        const sourceNodes = Array.from(container.childNodes).filter(node => node !== reader);
        sourceLayer.append(...sourceNodes);
        container.append(sourceLayer);
      }
      container.append(reader);
      for (const block of blocks) {
        if (block.kind === "native" && reader.contains(block.node)) {
          armNativeActionRelay(block.node);
          observeNativeImages(block.node);
          onTrace({ type: "native_moved_to_reader", candidateType: candidateType(block.node), boundary: "both" });
        }
      }
      for (const candidate of candidatesFrom(container)) portal(candidate);
      suppress = false;
      observe();
    }

    function showOriginal() {
      suppress = true;
      observer?.disconnect();
      if (container.getAttribute("cid") !== cid || (sourceLayer && !container.contains(sourceLayer))) {
        reader?.remove(); reader = null; sourceLayer = null;
        container.classList.remove("stvai-native-sync-active");
        suppress = false;
        return;
      }
      for (const block of blocks) {
        if ((block.kind === "native" || block.kind === "buyer_attribution")
          && reader?.contains(block.node) && container.contains(block.anchor)) {
          disarmNativeActionRelay(block.node);
          block.anchor.before(block.node);
          if (block.kind === "native") {
            onTrace({ type: "native_restored_to_source", candidateType: candidateType(block.node), boundary: "both" });
          }
        }
      }
      for (const record of lateRecords) {
        if (reader?.contains(record.node) && container.contains(record.anchor)) {
          disarmNativeActionRelay(record.node);
          record.anchor.parentNode.insertBefore(record.node, record.anchor);
          onTrace({ type: "native_restored_to_source", candidateType: record.type, boundary: record.resolved });
        }
      }
      reader?.remove();
      reader = null;
      if (sourceLayer?.parentNode === container) {
        sourceLayer.replaceWith(...Array.from(sourceLayer.childNodes));
      }
      sourceLayer = null;
      container.classList.remove("stvai-native-sync-active");
      suppress = false;
    }

    return Object.freeze({
      showReader,
      showOriginal,
      destroy() {
        showOriginal();
        for (const node of Array.from(nativeActionRelays.keys())) disarmNativeActionRelay(node);
        for (const cleanup of nativeImageObservers.values()) cleanup();
        nativeImageObservers.clear();
        observer?.disconnect();
        observer = null;
      }
    });
  }

  function updateReaderView(reader, blocks, translations, mode, translationOrigins) {
    if (!reader) return reader;
    const values = translations && typeof translations === "object" ? translations : {};
    const paragraphsById = new Map();
    for (const node of reader.querySelectorAll("[data-block-id]")) {
      if (!paragraphsById.has(node.dataset.blockId)) paragraphsById.set(node.dataset.blockId, node);
    }
    for (const block of blocks || []) {
      if (block.kind !== "text") continue;
      const id = String(block.id);
      const paragraph = paragraphsById.get(id);
      if (!paragraph) continue;
      const translated = typeof values[id] === "string" ? values[id].trim() : "";
      const text = mode === "translation" ? translated : String(block.text || "");
      if (paragraph.textContent !== text) paragraph.textContent = text;
      paragraph.classList.toggle("stvai-reader-paragraph--pending", mode === "translation" && !translated);
      if (mode === "translation" && !translated) {
        paragraph.setAttribute("aria-label", "Đang chờ bản dịch");
      } else {
        paragraph.removeAttribute("aria-label");
      }
      applyTranslationOrigin(paragraph, translationOrigins?.[id], mode);
    }
    return reader;
  }

  function setChapterCompleteNotice(reader, visible) {
    if (!reader) return null;
    const parent = reader.parentElement;
    const existing = [
      ...Array.from(reader.querySelectorAll(":scope > .stvai-chapter-complete")),
      ...Array.from(parent?.querySelectorAll(":scope > .stvai-chapter-complete") || [])
    ];
    for (const notice of existing) notice.remove();
    if (!visible || !parent || !reader.classList.contains("stvai-reader--translation")) return null;
    const notice = element(reader.ownerDocument, "div", "stvai-chapter-complete");
    const icon = element(reader.ownerDocument, "span", "stvai-chapter-complete-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.style.backgroundImage = `url("${brandIconUrl()}")`;
    notice.append(
      icon,
      element(reader.ownerDocument, "span", "stvai-chapter-complete-name", "phwgna")
    );
    notice.setAttribute("aria-label", "phwgna");
    notice.dataset.stvaiTtsExclude = "true";
    reader.insertAdjacentElement("afterend", notice);
    return notice;
  }

  function button(document, className, text, ariaLabel) {
    const node = element(document, "button", className, text);
    node.type = "button";
    if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
    return node;
  }

  function createNavigationControls(document, navigation = document.defaultView?.history, options = {}) {
    const root = element(document, "nav", "stvai-navigation");
    root.setAttribute("aria-label", "Điều hướng trang STV");
    root.dataset.layout = ["site", "global"].includes(options.layout) ? options.layout : "chapter";
    const launcher = button(document, "stvai-navigation-launcher", "↔", "Mở điều khiển trang");
    launcher.setAttribute("aria-expanded", "false");
    const back = button(document, "stvai-navigation-button stvai-navigation-button--back", "←", "Quay lại trang trước");
    const forward = button(document, "stvai-navigation-button stvai-navigation-button--forward", "→", "Đi tới trang sau");
    const zoomOut = button(document, "stvai-navigation-button stvai-navigation-button--back stvai-navigation-button--zoom-out", "−", "Thu nhỏ trang 10%");
    const zoomIn = button(document, "stvai-navigation-button stvai-navigation-button--forward stvai-navigation-button--zoom-in", "+", "Phóng to trang 10%");
    const allowAction = event => typeof options.isTrustedUiEvent !== "function"
      || options.isTrustedUiEvent(event, document.defaultView) === true;
    back.addEventListener("click", event => { if (allowAction(event)) navigation?.back?.(); });
    forward.addEventListener("click", event => { if (allowAction(event)) navigation?.forward?.(); });
    root.append(launcher, back, forward, zoomOut, zoomIn);
    const actions = [back, forward, zoomOut, zoomIn];
    const setExpanded = value => {
      const expanded = root.dataset.layout !== "global" || value === true;
      root.dataset.expanded = String(expanded);
      launcher.setAttribute("aria-expanded", String(expanded));
      launcher.setAttribute("aria-label", expanded ? "Ẩn điều khiển trang" : "Mở điều khiển trang");
      for (const action of actions) action.hidden = !expanded;
      return expanded;
    };
    launcher.hidden = root.dataset.layout !== "global";
    setExpanded(root.dataset.layout !== "global" || options.initialExpanded === true);
    launcher.addEventListener("click", event => {
      if (!allowAction(event)) return;
      const expanded = setExpanded(root.dataset.expanded !== "true");
      options.onExpandedChange?.(expanded);
    });
    const view = document.defaultView;
    let uiScale = normalizeUiScale(options.uiScale);
    let buttonSize = 46 * uiScale;
    let buttonGap = 8 * uiScale;
    let rowWidth = buttonSize * 4 + buttonGap * 3;
    let started = false;
    let mutationObserver = null;
    let resizeObserver = null;
    let observedOverlay = null;
    let scheduled = 0;

    const rectOf = (node) => {
      try { return node?.getBoundingClientRect?.(); } catch (_error) { return null; }
    };
    const isExtensionSurface = (node) => Boolean(node?.closest?.(
      ".stvai-navigation,.stvai-toolbar,.stvai-name-editor,.stvai-name-manager,.stvai-consent-backdrop,.stvai-tts-consent-backdrop"
    ));
    const isNativeTopOverlay = (node) => {
      if (!node || node === document.body || node === document.documentElement || isExtensionSurface(node)) return false;
      if (node.hidden || node.closest?.("[hidden]")) return false;
      const rect = rectOf(node);
      if (!rect || rect.width < 120 || rect.height < 64 || rect.bottom <= 12 || rect.top > 70) return false;
      const style = view?.getComputedStyle?.(node);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      return ["fixed", "absolute", "sticky"].includes(style.position);
    };
    const normalizeSemantic = value => String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const isRecognizedStvMenu = node => {
      if (!node || isExtensionSurface(node)) return false;
      const semantic = normalizeSemantic([
        node.getAttribute?.("role"), node.getAttribute?.("aria-label"), node.getAttribute?.("title"),
        node.id, node.className, String(node.textContent || "").slice(0, 500)
      ].join(" "));
      return /\b(bo name|bo ten|name manager|avatar|user menu|account|profile|tai khoan|thong tin ca nhan|cai dat|dang xuat|dropdown-menu)\b/.test(semantic);
    };
    const findNativeTopOverlay = () => {
      if (!view || typeof document.elementsFromPoint !== "function") return null;
      const width = Math.max(0, Number(view.innerWidth) || 0);
      const sampleY = 35;
      const samples = [35, Math.max(35, width - 35)];
      const candidates = new Set();
      for (const x of samples) {
        for (const hit of document.elementsFromPoint(x, sampleY) || []) {
          for (let node = hit; node && node !== document.body; node = node.parentElement) {
            if (isNativeTopOverlay(node)
              && (root.dataset.layout !== "global" || isRecognizedStvMenu(node))) candidates.add(node);
          }
        }
      }
      return [...candidates]
        .map((node) => ({ node, rect: rectOf(node) }))
        .filter(({ rect }) => rect && rect.bottom < (Number(view.innerHeight) || Infinity) - buttonSize)
        .sort((left, right) => right.rect.bottom - left.rect.bottom || left.rect.width - right.rect.width)[0] || null;
    };
    const findNativeBottomOverlay = () => {
      if (!view || typeof document.elementsFromPoint !== "function") return null;
      const width = Math.max(0, Number(view.innerWidth) || 0);
      const height = Math.max(0, Number(view.innerHeight) || 0);
      const candidates = new Set();
      for (const x of [35, width / 2, Math.max(35, width - 35)]) {
        for (const hit of document.elementsFromPoint(x, Math.max(0, height - 35)) || []) {
          for (let node = hit; node && node !== document.body; node = node.parentElement) {
            if (isNativeTopOverlay(node)) continue;
            if (!node || node === document.documentElement || isExtensionSurface(node)) continue;
            if (node.hidden || node.closest?.("[hidden]")) continue;
            const rect = rectOf(node);
            const style = view?.getComputedStyle?.(node);
            if (!rect || rect.width < 120 || rect.height < 44 || rect.bottom < height - 12) continue;
            if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
            if (["fixed", "absolute", "sticky"].includes(style.position)) candidates.add(node);
          }
        }
      }
      return [...candidates]
        .map((node) => ({ node, rect: rectOf(node) }))
        .filter(({ rect }) => rect && rect.top > buttonGap)
        .sort((left, right) => left.rect.top - right.rect.top || left.rect.width - right.rect.width)[0] || null;
    };
    const findOpenNativeDialog = () => {
      if (root.dataset.layout !== "site") return null;
      return [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],[aria-modal="true"]')]
        .find((node) => {
          if (isExtensionSurface(node) || node.hidden || node.closest?.("[hidden]")) return false;
          const rect = rectOf(node);
          const style = view?.getComputedStyle?.(node);
          return Boolean(rect && rect.width >= 120 && rect.height >= 120
            && style && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0);
        }) || null;
    };
    const watchOverlaySize = (node) => {
      if (observedOverlay === node) return;
      resizeObserver?.disconnect?.();
      observedOverlay = node || null;
      if (node && view?.ResizeObserver) {
        resizeObserver = new view.ResizeObserver(() => schedulePlacement());
        resizeObserver.observe(node);
      } else {
        resizeObserver = null;
      }
    };
    const refreshPlacement = () => {
      const siteLayout = root.dataset.layout === "site";
      const dialog = findOpenNativeDialog();
      if (dialog) {
        watchOverlaySize(dialog);
        root.dataset.nativeOverlay = "dialog";
        root.style.removeProperty("--stvai-navigation-top");
        root.style.removeProperty("--stvai-navigation-bottom");
        root.style.removeProperty("--stvai-navigation-left");
        return true;
      }
      const overlay = siteLayout ? findNativeBottomOverlay() : findNativeTopOverlay();
      watchOverlaySize(overlay?.node);
      if (!overlay) {
        if (root.dataset.nativeOverlay !== "false") root.dataset.nativeOverlay = "false";
        root.style.removeProperty("--stvai-navigation-top");
        root.style.removeProperty("--stvai-navigation-bottom");
        root.style.removeProperty("--stvai-navigation-left");
        return false;
      }
      const width = Math.max(rowWidth + 16, Number(view.innerWidth) || rowWidth + 16);
      const height = Math.max(buttonSize + 16, Number(view.innerHeight) || buttonSize + 16);
      if (siteLayout) {
        const bottom = Math.min(Math.ceil(height - overlay.rect.top) + buttonGap, height - buttonSize - buttonGap);
        const left = Math.round(Math.max(buttonGap, Math.min((width - rowWidth) / 2, width - rowWidth - buttonGap)));
        root.dataset.nativeOverlay = "bottom";
        root.style.removeProperty("--stvai-navigation-top");
        root.style.setProperty("--stvai-navigation-bottom", `${bottom}px`);
        root.style.setProperty("--stvai-navigation-left", `${left}px`);
        return true;
      }
      const top = Math.min(Math.ceil(overlay.rect.bottom) + buttonGap, height - buttonSize - buttonGap);
      const centered = overlay.rect.left + (overlay.rect.width - rowWidth) / 2;
      const left = Math.round(Math.max(buttonGap, Math.min(centered, width - rowWidth - buttonGap)));
      root.dataset.nativeOverlay = "true";
      root.style.setProperty("--stvai-navigation-top", `${top}px`);
      root.style.setProperty("--stvai-navigation-left", `${left}px`);
      return true;
    };
    const schedulePlacement = () => {
      if (scheduled) return;
      const run = () => { scheduled = 0; refreshPlacement(); };
      scheduled = view?.requestAnimationFrame?.(run) || view?.setTimeout?.(run, 0) || 0;
    };
    const setUiScale = value => {
      uiScale = applyUiScale(document, value);
      buttonSize = 46 * uiScale;
      buttonGap = 8 * uiScale;
      rowWidth = buttonSize * 4 + buttonGap * 3;
      root.style.setProperty("--stvai-navigation-button-size", `${buttonSize}px`);
      root.style.setProperty("--stvai-navigation-gap", `${buttonGap}px`);
      root.style.setProperty("--stvai-navigation-step", `${buttonSize + buttonGap}px`);
      root.style.setProperty("--stvai-navigation-offset-2", `${(buttonSize + buttonGap) * 2}px`);
      root.style.setProperty("--stvai-navigation-offset-3", `${(buttonSize + buttonGap) * 3}px`);
      root.style.setProperty("--stvai-navigation-row-width", `${rowWidth}px`);
      root.style.setProperty("--stvai-navigation-row-half", `${rowWidth / 2}px`);
      root.style.setProperty("--stvai-navigation-launcher-size", `${48 * uiScale}px`);
      root.style.setProperty("--stvai-navigation-button-font-size", `${30 * uiScale}px`);
      root.style.setProperty("--stvai-navigation-launcher-font-size", `${25 * uiScale}px`);
      root.style.setProperty("--stvai-navigation-button-radius", `${13 * uiScale}px`);
      root.style.setProperty("--stvai-navigation-launcher-radius", `${14 * uiScale}px`);
      if (started) schedulePlacement();
      return uiScale;
    };
    setUiScale(uiScale);
    const mutationCanMoveOverlay = (record) => {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      if (!target || root.contains(target)) return false;
      if (observedOverlay && (target === observedOverlay || observedOverlay.contains(target) || target.contains(observedOverlay))) return true;
      const rect = rectOf(target);
      const viewportHeight = Number(view?.innerHeight) || 0;
      if (rect && (rect.top < 80 || (root.dataset.layout === "site" && rect.bottom > viewportHeight - 80))) return true;
      return [...(record.addedNodes || [])].some((node) => {
        const added = node.nodeType === 1 ? node : node.parentElement;
        const addedRect = rectOf(added);
        return addedRect && (addedRect.top < 80
          || (root.dataset.layout === "site" && addedRect.bottom > viewportHeight - 80));
      });
    };
    const startAvoidingNativeOverlays = () => {
      if (started) return refreshPlacement();
      started = true;
      const Observer = view?.MutationObserver;
      if (Observer && document.body) {
        mutationObserver = new Observer((records) => {
          if (records.some(mutationCanMoveOverlay)) schedulePlacement();
        });
        mutationObserver.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class", "hidden", "style"]
        });
      }
      view?.addEventListener?.("resize", schedulePlacement);
      return refreshPlacement();
    };
    const destroy = () => {
      mutationObserver?.disconnect?.();
      resizeObserver?.disconnect?.();
      view?.removeEventListener?.("resize", schedulePlacement);
      if (scheduled) {
        view?.cancelAnimationFrame?.(scheduled);
        view?.clearTimeout?.(scheduled);
        scheduled = 0;
      }
      started = false;
    };
    return {
      root, launcher, back, forward, zoomOut, zoomIn, setExpanded,
      setUiScale,
      startAvoidingNativeOverlays,
      refreshPlacement,
      destroy
    };
  }

  function createTtsOverlayDrag(document, options = {}) {
    const view = document.defaultView;
    const margin = Math.max(0, Number(options.margin) || 0);
    const threshold = Math.max(1, Number(options.dragThreshold) || 5);
    const cleanups = new Map();
    const pronunciationClosers = new Map();
    const bindingKinds = new Map();
    let enabled = false;
    let position = sanitizePosition(options.initialPosition);
    let settingsPosition = null;
    let observer = null;
    let pendingVoiceAnchor = null;

    function sanitizePosition(value) {
      return typeof value?.x === "number" && typeof value?.y === "number"
        && Number.isFinite(value.x) && Number.isFinite(value.y)
        ? { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) }
        : null;
    }

    function bounds(node) {
      const rect = node.getBoundingClientRect();
      const width = Math.max(1, Number(rect.width) || 54);
      const height = Math.max(1, Number(rect.height) || 54);
      const maxLeft = Math.max(margin, (Number(view?.innerWidth) || width + margin * 2) - width - margin);
      const maxTop = Math.max(margin, (Number(view?.innerHeight) || height + margin * 2) - height - margin);
      return { rect, width, height, maxLeft, maxTop };
    }

    function place(node, left, top, measured = null) {
      const value = measured || bounds(node);
      const clampedLeft = Math.max(margin, Math.min(Number(left) || 0, value.maxLeft));
      const clampedTop = Math.max(margin, Math.min(Number(top) || 0, value.maxTop));
      node.style.position = "fixed";
      node.style.left = `${clampedLeft}px`;
      node.style.top = `${clampedTop}px`;
      node.style.right = "auto";
      node.style.bottom = "auto";
      node.style.transform = "none";
      return { left: clampedLeft, top: clampedTop, ...value };
    }

    function savedPosition(kind) {
      return kind === "settings" ? settingsPosition : position;
    }

    function placeSaved(node, kind = "overlay") {
      const saved = savedPosition(kind);
      if (!saved) return;
      const value = bounds(node);
      place(
        node,
        margin + saved.x * Math.max(0, value.maxLeft - margin),
        margin + saved.y * Math.max(0, value.maxTop - margin)
      );
    }

    function save(node, kind = "overlay") {
      const value = bounds(node);
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      const next = {
        x: value.maxLeft === margin ? 0 : Math.max(0, Math.min(1, (left - margin) / (value.maxLeft - margin))),
        y: value.maxTop === margin ? 0 : Math.max(0, Math.min(1, (top - margin) / (value.maxTop - margin)))
      };
      if (kind === "settings") settingsPosition = next;
      else {
        position = next;
        options.onPositionChange?.({ ...position });
      }
    }

    function ensureBrand(container) {
      if (!container || container.querySelector(".stvai-tts-brand-icon")) return;
      container.prepend(brandIcon(document, "stvai-brand-icon stvai-tts-brand-icon"));
    }

    function decorateOverlay(node) {
      if (!node?.matches?.(".tts-control-overlay")) return;
      node.dataset.stvaiTtsSkinned = "true";
      ensureBrand(node.querySelector(".tts-header-title"));
      node.querySelector('#tts-stop-btn')?.remove();
      const jump = node.querySelector('#tts-jump-input');
      const jumpGroup = jump?.parentElement;
      if (jumpGroup?.parentElement?.classList.contains('tts-nav-header')) jumpGroup.remove();
      else {
        jump?.remove();
        node.querySelector('#tts-jump-btn')?.remove();
      }
    }

    function addPronunciationEditor(container) {
      if (container.querySelector('.stvai-tts-pronunciation-toggle')) return;
      const toggle = button(document, 'stvai-button stvai-tts-pronunciation-toggle', 'Chỉnh phát âm');
      const panel = element(document, 'section', 'stvai-tts-pronunciation');
      panel.hidden = true;
      const win = container.closest('.window');
      const header = win.querySelector('.head');
      const title = element(document, 'span', 'stvai-tts-pronunciation-title', 'Chỉnh phát âm');
      const columns = element(document, 'div', 'stvai-tts-pronunciation-columns');
      columns.append(element(document, 'span', '', 'Từ gốc'), element(document, 'span', '', 'Cách đọc'));
      const list = element(document, 'div', 'stvai-tts-pronunciation-list');
      const hint = element(document, 'p', 'stvai-tts-pronunciation-hint');
      hint.append(
        'Từ viết hoa toàn bộ tính là 1 trường hợp phát âm riêng, ',
        element(document, 'br'),
        'nhập [bỏ qua] để TTS không đọc từ đó.'
      );
      const sample = element(document, 'div', 'stvai-tts-pronunciation-sample');
      const sampleLabel = element(document, 'label', 'stvai-tts-pronunciation-sample-label', 'Thử cách đọc');
      const sampleControls = element(document, 'div', 'stvai-tts-pronunciation-sample-controls');
      const sampleInput = element(document, 'input', 'stvai-tts-pronunciation-sample-input');
      sampleInput.type = 'text';
      sampleInput.maxLength = 200;
      sampleInput.placeholder = 'Ví dụ: AI đạt 1.5 điểm';
      sampleInput.spellcheck = false;
      sampleInput.setAttribute('aria-label', 'Nội dung cần thử cách đọc');
      const samplePreview = button(document, 'stvai-button stvai-tts-pronunciation-sample-preview', '▶ Preview');
      const sampleResult = element(document, 'p', 'stvai-tts-pronunciation-sample-result');
      sampleResult.setAttribute('role', 'status');
      sampleLabel.htmlFor = sampleInput.id = 'stvai-tts-pronunciation-sample-input';
      sampleControls.append(sampleInput, samplePreview);
      sample.append(sampleLabel, sampleControls, sampleResult);
      const status = element(document, 'p', 'stvai-tts-pronunciation-status');
      status.setAttribute('role', 'status');
      const actions = element(document, 'div', 'stvai-tts-pronunciation-actions');
      const saveButton = button(document, 'stvai-button stvai-tts-pronunciation-save', 'Lưu phát âm');
      const cancel = button(document, 'stvai-button stvai-tts-pronunciation-cancel', '←');
      cancel.setAttribute('aria-label', 'Quay lại cài đặt TTS, bỏ thay đổi chưa lưu');
      cancel.title = 'Quay lại';
      header.prepend(cancel);
      header.querySelector('.headtext')?.after(title);
      const add = button(document, 'stvai-button stvai-tts-pronunciation-add', '+ Thêm');
      actions.append(add, saveButton);
      panel.append(columns, list, actions, status, hint, sample);
      container.append(toggle, panel);
      options.protectUiRoot?.(toggle);
      options.protectUiRoot?.(panel);
      options.protectUiRoot?.(cancel);
      const nativeCloser = win.querySelector('.closer');
      if (nativeCloser) options.protectUiRoot?.(nativeCloser);
      const dialogSurface = win.firstElementChild || panel;
      let selectingText = false;
      let pendingSelectionClick = false;
      let selectionClickTimer = 0;
      const clearPendingSelectionClick = () => {
        pendingSelectionClick = false;
        view?.removeEventListener?.('click', blockPendingSelectionClick, true);
        if (selectionClickTimer) view?.clearTimeout?.(selectionClickTimer);
        selectionClickTimer = 0;
      };
      const blockPendingSelectionClick = event => {
        if (!pendingSelectionClick) return;
        clearPendingSelectionClick();
        if (dialogSurface.contains(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const armSelectionClickGuard = () => {
        clearPendingSelectionClick();
        pendingSelectionClick = true;
        view?.addEventListener?.('click', blockPendingSelectionClick, true);
        selectionClickTimer = view?.setTimeout?.(clearPendingSelectionClick, 0) || 0;
      };
      const clearTextSelection = () => {
        selectingText = false;
        view?.removeEventListener?.('pointerup', finishTextSelection, true);
        view?.removeEventListener?.('mouseup', finishTextSelection, true);
        view?.removeEventListener?.('blur', clearTextSelection, true);
      };
      const finishTextSelection = event => {
        if (!selectingText) return;
        if (event.type === 'mouseup') clearTextSelection();
        if (dialogSurface.contains(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        armSelectionClickGuard();
      };
      const beginTextSelection = event => {
        if (panel.hidden || event.button !== 0 || !event.target?.matches?.('input, textarea')) return;
        clearTextSelection();
        selectingText = true;
        view?.addEventListener?.('pointerup', finishTextSelection, true);
        view?.addEventListener?.('mouseup', finishTextSelection, true);
        view?.addEventListener?.('blur', clearTextSelection, true);
      };
      panel.addEventListener('mousedown', beginTextSelection, true);
      let generation = 0;
      let previewTask = 0;
      let saving = false;
      function addRow(source = '', spoken = '') {
        const row = element(document, 'div', 'stvai-tts-pronunciation-row');
        for (const [name, value, label, limit] of [['source', source, 'Từ gốc', 100], ['spoken', spoken, 'Cách đọc', 200]]) {
          const input = element(document, 'input', `stvai-tts-pronunciation-${name}`);
          input.type = 'text'; input.value = value; input.maxLength = limit;
          input.setAttribute('aria-label', label); input.placeholder = label;
          input.spellcheck = false;
          row.append(input);
        }
        const remove = button(document, 'stvai-button stvai-tts-pronunciation-delete', '×');
        const preview = button(document, 'stvai-button stvai-tts-pronunciation-preview', '▶');
        preview.title = 'Nghe thử bằng giọng hiện tại';
        preview.setAttribute('aria-label', 'Nghe thử cách đọc');
        preview.addEventListener('click', async () => {
          if (saving) return;
          const text = row.querySelector('.stvai-tts-pronunciation-spoken').value.trim();
          if (!text) { status.textContent = 'Nhập Cách đọc để nghe thử.'; return; }
          if (text.toLocaleLowerCase('vi') === '[bỏ qua]') {
            status.textContent = 'Từ hoặc ký tự này sẽ không được đọc.';
            return;
          }
          if (typeof options.previewPronunciation !== 'function') { status.textContent = 'Mở Nghe sách trước khi nghe thử.'; return; }
          const current = generation;
          const task = ++previewTask;
          preview.disabled = true;
          status.textContent = 'Đang tải giọng hiện tại…';
          try {
            const result = await options.previewPronunciation(text);
            if (current !== generation || task !== previewTask || saving) return;
            if (result == null || result.code === 'preview_playing') status.textContent = 'Đang nghe thử.';
            else if (result.code === 'preview_cancelled') status.textContent = 'Đã dừng nghe thử.';
            else status.textContent = 'Chưa nghe thử được bằng giọng hiện tại. Hãy thử lại.';
          } catch (_) {
            if (current === generation && task === previewTask && !saving) status.textContent = 'Chưa nghe thử được bằng giọng hiện tại. Hãy thử lại.';
          } finally {
            if (current === generation && !saving) preview.disabled = false;
          }
        });
        remove.setAttribute('aria-label', 'Xóa quy tắc phát âm');
        remove.addEventListener('click', () => { row.remove(); add.disabled = list.children.length >= 200; });
        row.append(preview, remove);
        options.protectUiRoot?.(row);
        list.append(row);
        add.disabled = list.children.length >= 200;
        return row;
      }
      function busy(value) {
        for (const control of panel.querySelectorAll('input, button')) control.disabled = value;
        add.disabled = value || list.children.length >= 200;
      }
      function draftGuide() {
        const lines = [];
        for (const row of list.children) {
          const source = row.querySelector('.stvai-tts-pronunciation-source').value.trim();
          const spoken = row.querySelector('.stvai-tts-pronunciation-spoken').value.trim();
          if (source && spoken && !/[=\r\n]/u.test(source)) lines.push(`${source}=${spoken}`);
        }
        return lines.join('\n');
      }
      samplePreview.addEventListener('click', async () => {
        if (saving) return;
        const text = sampleInput.value.trim();
        if (!text) { sampleResult.textContent = 'Nhập nội dung cần thử.'; return; }
        if (typeof options.previewPronunciation !== 'function') { sampleResult.textContent = 'Mở Nghe sách trước khi nghe thử.'; return; }
        const current = generation;
        const task = ++previewTask;
        samplePreview.disabled = true;
        sampleResult.textContent = 'Đang áp dụng bộ lọc…';
        try {
          const result = await options.previewPronunciation(text, draftGuide());
          if (current !== generation || task !== previewTask || saving) return;
          if (result?.code === 'preview_silent' || !result?.spokenText) {
            sampleResult.textContent = 'Nội dung này sẽ không được đọc.';
          } else if (result.code === 'preview_cancelled') {
            sampleResult.textContent = 'Đã dừng nghe thử.';
          } else {
            sampleResult.textContent = `Sẽ đọc: ${result.spokenText}`;
          }
        } catch (_) {
          if (current === generation && task === previewTask && !saving) sampleResult.textContent = 'Chưa nghe thử được bằng giọng hiện tại. Hãy thử lại.';
        } finally {
          if (current === generation && !saving) samplePreview.disabled = false;
        }
      });
      add.addEventListener('click', () => {
        if (list.children.length < 200) addRow().querySelector('input').focus();
      });
      let opened = false;
      const closeEditor = () => {
        clearTextSelection();
        clearPendingSelectionClick();
        ++generation;
        ++previewTask;
        panel.hidden = true;
        delete win.dataset.stvaiPronunciationOpen;
        toggle.setAttribute('aria-expanded', 'false');
        if (opened) {
          opened = false;
          void Promise.resolve(options.onPronunciationClose?.()).catch(() => {});
        }
      };
      pronunciationClosers.set(win, closeEditor);
      nativeCloser?.addEventListener('click', closeEditor);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', async () => {
        const current = ++generation;
        ++previewTask;
        panel.hidden = false;
        win.dataset.stvaiPronunciationOpen = 'true';
        const body = container.closest('.body');
        if (body) body.scrollTop = 0;
        toggle.setAttribute('aria-expanded', 'true');
        busy(true);
        status.textContent = 'Đang tải…';
        try {
          opened = true;
          await options.onPronunciationOpen?.();
          if (current !== generation || !panel.isConnected || !enabled) return;
          const guide = await options.getPronunciationGuide?.();
          if (current !== generation || !panel.isConnected || !enabled) return;
          list.replaceChildren();
          sampleInput.value = '';
          sampleResult.textContent = '';
          const mappings = [];
          for (const line of (typeof guide === 'string' ? guide : '').split(/\r?\n/u)) {
            const separator = line.indexOf('=');
            if (separator < 0 || !line.slice(0, separator).trim() || !line.slice(separator + 1).trim()) continue;
            mappings.push({
              source: line.slice(0, separator).trim(),
              spoken: line.slice(separator + 1).trim()
            });
          }
          for (const mapping of sortPronunciationMappings(mappings)) addRow(mapping.source, mapping.spoken);
          busy(false);
          status.textContent = '';
          (list.querySelector('input') || add).focus({ preventScroll: true });
        } catch (_error) {
          if (current === generation) status.textContent = 'Chưa tải được. Bấm ← rồi mở lại Chỉnh phát âm để thử lại.';
        }
      });
      cancel.addEventListener('click', () => {
        closeEditor();
        toggle.focus({ preventScroll: true });
      });
      saveButton.addEventListener('click', async () => {
        if (saveButton.disabled || !enabled) return;
        const mappings = [];
        for (const row of list.children) {
          const source = row.querySelector('.stvai-tts-pronunciation-source').value.trim();
          const spoken = row.querySelector('.stvai-tts-pronunciation-spoken').value.trim();
          if (!source && !spoken) continue;
          if (!source || !spoken || /[=\r\n]/u.test(source)) {
            status.textContent = 'Điền đủ Từ gốc và Cách đọc; Từ gốc không chứa dấu =.';
            return;
          }
          mappings.push({ source, spoken, row });
        }
        const sortedMappings = sortPronunciationMappings(mappings);
        const lines = sortedMappings.map(({ source, spoken }) => `${source}=${spoken}`);
        const guide = lines.join('\n');
        if (lines.length > 200 || guide.length > 20000) {
          status.textContent = 'Danh sách quá dài (tối đa 200 quy tắc, 20.000 ký tự).';
          return;
        }
        saving = true;
        ++previewTask;
        busy(true);
        cancel.disabled = toggle.disabled = true;
        sampleResult.textContent = '';
        status.textContent = 'Đang lưu…';
        try {
          if (typeof options.savePronunciationGuide !== 'function') throw new Error('unavailable');
          await options.savePronunciationGuide(guide);
          for (const mapping of sortedMappings) list.append(mapping.row);
          status.textContent = 'Đã lưu. Áp dụng ở lần mở Nghe sách tiếp theo.';
        } catch (_error) {
          status.textContent = 'Chưa lưu được. Nội dung vẫn được giữ để thử lại.';
        } finally {
          saving = false;
          busy(false);
          cancel.disabled = toggle.disabled = false;
        }
      });
    }

    function decorateVoiceMenu(menu) {
      if (!menu?.matches?.(".custom-select-menu") || menu.dataset.stvaiTtsVoiceMenu === "true") return;
      const existingAnchor = menu.parentElement?.matches?.("[data-stvai-tts-voice-anchor='true']")
        ? menu.parentElement
        : null;
      const anchor = existingAnchor || pendingVoiceAnchor;
      const settings = anchor?.closest?.(".window[data-stvai-tts-settings='true']");
      if (!anchor) return;
      if (!settings || !anchor.isConnected) {
        pendingVoiceAnchor = null;
        return;
      }
      anchor.dataset.stvaiTtsVoiceAnchor = "true";
      menu.dataset.stvaiTtsVoiceMenu = "true";
      if (!existingAnchor) {
        pendingVoiceAnchor = null;
        anchor.append(menu);
      }
    }

    const rememberVoiceAnchor = event => {
      if (!enabled) return;
      const trigger = event.target?.closest?.(".voiceselect");
      const settings = trigger?.closest?.(".window[data-stvai-tts-settings='true']");
      pendingVoiceAnchor = settings ? trigger.closest(".tts-config-item") : null;
    };

    function decorateSettingsWindow(node) {
      const win = node?.matches?.(".window") ? node : node?.closest?.(".window");
      if (!win) return;
      const title = win.querySelector(".headtext")?.textContent?.trim() || "";
      const container = win.querySelector(".tts-config-container");
      if (!container || !/^Cài đặt Text-to-Speech$/i.test(title)) return;
      win.dataset.stvaiTtsSettings = "true";
      ensureBrand(win.querySelector(".head"));
      const color = container.querySelector("#highlight-color.tts-color-input, #highlight-color[type='color']");
      const redundant = color?.closest?.(".tts-config-section");
      if (redundant && container.contains(redundant)) redundant.dataset.stvaiTtsRedundant = "highlight-color";
      addPronunciationEditor(container);
      const panel = win.firstElementChild;
      if (panel) bind(panel, "settings");
    }

    function decorateTree(node) {
      if (!node || node.nodeType !== 1) return;
      decorateOverlay(node.closest?.('.tts-control-overlay'));
      if (node.matches?.(".tts-control-overlay")) decorateOverlay(node);
      for (const overlay of node.querySelectorAll?.(".tts-control-overlay") || []) decorateOverlay(overlay);
      if (node.matches?.(".custom-select-menu")) decorateVoiceMenu(node);
      for (const menu of node.querySelectorAll?.(".custom-select-menu") || []) decorateVoiceMenu(menu);
      decorateSettingsWindow(node);
      for (const win of node.querySelectorAll?.(".window") || []) decorateSettingsWindow(win);
    }

    function bind(node, kind = "overlay") {
      if (!node || cleanups.has(node)) return;
      if (kind === "overlay") decorateOverlay(node);
      const original = {
        title: node.getAttribute("title"),
        tabindex: node.getAttribute("tabindex"),
        touchAction: node.style.touchAction,
        handleTouchAction: ""
      };
      node.dataset.stvaiTtsDraggable = "true";
      node.title = original.title
        ? `${original.title} — Kéo để di chuyển`
        : kind === "settings" ? "Kéo để di chuyển cài đặt Nghe sách" : "Kéo để di chuyển Nghe sách";
      if (!/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(node.tagName) && original.tabindex == null) node.tabIndex = 0;
      const dragHandle = kind === "settings" ? node.querySelector(".head") : node.querySelector(".tts-drag-handle");
      const effectiveHandle = dragHandle || node;
      original.handleTouchAction = effectiveHandle.style.touchAction;
      effectiveHandle.style.touchAction = "none";
      placeSaved(node, kind);
      let drag = null;
      let suppressClickUntil = 0;

      const interactiveTarget = target => Boolean(target?.closest?.(
        "button,input,select,textarea,a,[role='button'],.closer,.fuller,.minimize"
      ));
      const acceptsDrag = event => effectiveHandle.contains(event.target)
        && (event.target === node || !interactiveTarget(event.target));
      const blockNativeDrag = event => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      const pointerDown = event => {
        if (!enabled || !acceptsDrag(event) || (event.button != null && event.button !== 0)) return;
        const measured = bounds(node);
        const rect = measured.rect;
        drag = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          moved: false,
          measured
        };
      };
      const pointerMove = event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < threshold) return;
        if (!drag.moved) {
          drag.moved = true;
          node.setPointerCapture?.(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
        place(node, event.clientX - drag.dx, event.clientY - drag.dy, drag.measured);
      };
      const pointerFinish = event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (drag.moved) {
          event.preventDefault();
          event.stopPropagation();
          save(node, kind);
          suppressClickUntil = Date.now() + 500;
        }
        drag = null;
      };
      const suppressMovedClick = event => {
        if (Date.now() > suppressClickUntil) return;
        suppressClickUntil = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const keyDown = event => {
        if (!enabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        if (event.target !== node && event.target !== effectiveHandle) return;
        const rect = node.getBoundingClientRect();
        const step = event.shiftKey ? 1 : 10;
        const horizontal = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const vertical = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        event.preventDefault();
        place(node, rect.left + horizontal, rect.top + vertical);
        save(node, kind);
      };
      effectiveHandle.addEventListener("mousedown", blockNativeDrag, true);
      effectiveHandle.addEventListener("touchstart", blockNativeDrag, { capture: true, passive: false });
      node.addEventListener("pointerdown", pointerDown, true);
      node.addEventListener("pointermove", pointerMove, true);
      node.addEventListener("pointerup", pointerFinish, true);
      node.addEventListener("pointercancel", pointerFinish, true);
      node.addEventListener("click", suppressMovedClick, true);
      node.addEventListener("keydown", keyDown, true);
      bindingKinds.set(node, kind);
      cleanups.set(node, () => {
        effectiveHandle.removeEventListener("mousedown", blockNativeDrag, true);
        effectiveHandle.removeEventListener("touchstart", blockNativeDrag, true);
        node.removeEventListener("pointerdown", pointerDown, true);
        node.removeEventListener("pointermove", pointerMove, true);
        node.removeEventListener("pointerup", pointerFinish, true);
        node.removeEventListener("pointercancel", pointerFinish, true);
        node.removeEventListener("click", suppressMovedClick, true);
        node.removeEventListener("keydown", keyDown, true);
        delete node.dataset.stvaiTtsDraggable;
        if (original.title == null) node.removeAttribute("title"); else node.setAttribute("title", original.title);
        if (original.tabindex == null) node.removeAttribute("tabindex"); else node.setAttribute("tabindex", original.tabindex);
        node.style.touchAction = original.touchAction;
        effectiveHandle.style.touchAction = original.handleTouchAction;
      });
    }

    function refresh() {
      if (!enabled) return null;
      const overlays = [...document.querySelectorAll(".tts-control-overlay")];
      for (const node of overlays) bind(node);
      for (const win of document.querySelectorAll(".window")) decorateSettingsWindow(win);
      for (const menu of document.querySelectorAll(".custom-select-menu")) decorateVoiceMenu(menu);
      return overlays.at(-1) || null;
    }

    function reflow() {
      if (!enabled) return null;
      const latest = refresh();
      for (const node of cleanups.keys()) if (node.isConnected) placeSaved(node, bindingKinds.get(node));
      return latest;
    }

    const onResize = () => {
      if (!enabled) return;
      for (const node of cleanups.keys()) if (node.isConnected) placeSaved(node, bindingKinds.get(node));
    };
    if (view?.MutationObserver && document.body) {
      observer = new view.MutationObserver(records => {
        if (!enabled) return;
        for (const [win, close] of pronunciationClosers) {
          if (!win.isConnected) { close(); pronunciationClosers.delete(win); }
        }
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (added?.nodeType !== 1) continue;
            decorateTree(added);
            if (added.matches?.(".tts-control-overlay")) bind(added);
            for (const overlay of added.querySelectorAll?.(".tts-control-overlay") || []) bind(overlay);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    document.addEventListener?.("click", rememberVoiceAnchor, true);
    view?.addEventListener?.("resize", onResize);

    return {
      refresh,
      reflow,
      setEnabled(value) {
        enabled = value === true;
        if (enabled) refresh();
        else {
          pendingVoiceAnchor = null;
          for (const close of pronunciationClosers.values()) close();
          for (const cleanup of cleanups.values()) cleanup();
          cleanups.clear();
          bindingKinds.clear();
        }
      },
      destroy() {
        enabled = false;
        pendingVoiceAnchor = null;
        for (const close of pronunciationClosers.values()) close();
        pronunciationClosers.clear();
        observer?.disconnect();
        document.removeEventListener?.("click", rememberVoiceAnchor, true);
        view?.removeEventListener?.("resize", onResize);
        for (const cleanup of cleanups.values()) cleanup();
        cleanups.clear();
        bindingKinds.clear();
      }
    };
  }

  function createToolbar(document, settings, options = {}) {
    const root = element(document, "section", "stvai-toolbar stvai-toolbar--side-menu");
    root.setAttribute("aria-label", "Phwgna Stv");
    root.dataset.collapsed = String(options.initialCollapsed === true);

    const identity = element(document, "div", "stvai-identity");
    identity.append(
      brandIcon(document, "stvai-brand-icon stvai-identity-mark"),
      element(document, "span", "stvai-identity-name phwgna-product-name", "Phwgna Stv")
    );

    const menuToggle = button(
      document,
      "stvai-menu-toggle",
      "‹",
      "Thu gọn menu Phwgna Stv"
    );
    menuToggle.setAttribute("aria-expanded", "true");
    menuToggle.setAttribute("aria-controls", "stvai-menu-body");
    const miniToggle = button(
      document,
      "stvai-mini-toggle",
      "",
      "Mở menu Phwgna Stv"
    );
    miniToggle.dataset.stvaiInteractiveDragHandle = "true";
    miniToggle.setAttribute("aria-expanded", "true");
    miniToggle.setAttribute("aria-controls", "stvai-menu-body");
    const miniProgress = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    miniProgress.classList.add("stvai-mini-progress");
    miniProgress.dataset.visible = "false";
    miniProgress.setAttribute("viewBox", "0 0 48 48");
    miniProgress.setAttribute("aria-hidden", "true");
    miniProgress.setAttribute("focusable", "false");
    const miniCompleteRing = element(document, "span", "stvai-mini-complete-ring");
    miniCompleteRing.dataset.active = "false";
    miniCompleteRing.setAttribute("aria-hidden", "true");
    const miniTomoe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    miniTomoe.classList.add("stvai-mini-tomoe");
    miniTomoe.dataset.active = "false";
    miniTomoe.dataset.count = "0";
    miniTomoe.setAttribute("viewBox", "0 0 80 80");
    miniTomoe.setAttribute("aria-hidden", "true");
    miniTomoe.setAttribute("focusable", "false");
    const tomoeSpinner = document.createElementNS("http://www.w3.org/2000/svg", "g");
    tomoeSpinner.classList.add("stvai-mini-tomoe-spinner");
    const tomoeTailPath = "M 30.2 2.1 C 37.8 2.7 44.8 8.4 47.4 17.2 C 42.5 11.9 37.3 9.5 32.2 10.5 C 33.5 7.1 32.8 4.1 30.2 2.1 Z";
    const protectTomoePaint = (node) => {
      // STV applies late SVG-wide paint rules. Inline important values keep the
      // tool-owned glyph black without allowing those page rules to turn it white.
      node.style.setProperty("fill", "#000000", "important");
      node.style.setProperty("filter",
        "drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.82)) drop-shadow(0 0 3px rgba(0, 0, 0, 0.38))",
        "important");
    };
    const createTomoe = (index, rotation) => {
      const seed = document.createElementNS("http://www.w3.org/2000/svg", "g");
      seed.classList.add("stvai-mini-tomoe-seed");
      seed.dataset.tomoeIndex = String(index);
      const glyph = document.createElementNS("http://www.w3.org/2000/svg", "g");
      glyph.classList.add("stvai-mini-tomoe-glyph");
      glyph.setAttribute("transform", "translate(40 16) rotate(-45) scale(0.6) translate(-28 -8)");
      const tail = document.createElementNS("http://www.w3.org/2000/svg", "path");
      tail.classList.add("stvai-mini-tomoe-body");
      tail.setAttribute("d", tomoeTailPath);
      protectTomoePaint(tail);
      const head = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      head.classList.add("stvai-mini-tomoe-body");
      head.setAttribute("cx", "28");
      head.setAttribute("cy", "8");
      head.setAttribute("r", "6.5");
      protectTomoePaint(head);
      glyph.append(tail, head);
      seed.append(glyph);
      if (rotation) seed.setAttribute("transform", `rotate(${rotation} 40 40)`);
      return seed;
    };
    tomoeSpinner.append(createTomoe(0, 0), createTomoe(1, 120), createTomoe(2, 240));
    miniTomoe.append(tomoeSpinner);
    miniToggle.append(
      brandIcon(document, "stvai-brand-icon stvai-menu-toggle-icon stvai-mini-toggle-icon"),
      miniProgress,
      miniCompleteRing,
      miniTomoe
    );
    const header = element(document, "div", "stvai-menu-header");
    header.append(identity, menuToggle, miniToggle);

    const providerLabel = element(document, "div", "stvai-field-label");
    providerLabel.append(element(document, "span", "stvai-field-label-text", "Dịch vụ AI"));
    const provider = element(document, "select", "stvai-provider");
    provider.setAttribute("aria-label", "Chọn dịch vụ AI");
    provider.setAttribute("aria-hidden", "true");
    provider.tabIndex = -1;
    const webGroup = element(document, "optgroup");
    webGroup.label = "AI Web";
    const apiGroup = element(document, "optgroup");
    apiGroup.label = "AI API";
    const providerGroups = [
      ["AI Web", webGroup, [["chatgpt", "ChatGPT Web"], ["gemini", "Gemini Web"]]],
      ["AI API", apiGroup, [
        ["openrouter_api", "OpenRouter"], ["gemini_api", "Gemini API"],
        ["openai_api", "GPT API"], ["deepseek_api", "DeepSeek API"]
      ]]
    ];
    for (const [, group, entries] of providerGroups) {
      for (const [value, label] of entries) {
        const option = element(document, "option", "", label);
        option.value = value;
        group.append(option);
      }
    }
    provider.append(webGroup, apiGroup);
    const selectedProvider = String(settings?.provider || "chatgpt");
    provider.value = [...provider.options].some((option) => option.value === selectedProvider) ? selectedProvider : "chatgpt";
    const providerPicker = element(document, "div", "stvai-provider-picker");
    const providerTrigger = button(document, "stvai-provider-trigger", "", "Chọn dịch vụ AI");
    providerTrigger.setAttribute("aria-haspopup", "listbox");
    providerTrigger.setAttribute("aria-expanded", "false");
    const providerList = element(document, "div", "stvai-provider-list");
    providerList.hidden = true;
    providerList.setAttribute("role", "listbox");
    providerList.setAttribute("aria-label", "Danh sách dịch vụ AI");
    const providerButtons = [];
    for (const [groupLabel, , entries] of providerGroups) {
      const group = element(document, "div", "stvai-provider-group");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", groupLabel);
      group.append(element(document, "span", "stvai-provider-group-label", groupLabel));
      for (const [value, label] of entries) {
        const option = button(document, "stvai-provider-option", label);
        option.dataset.providerValue = value;
        option.setAttribute("role", "option");
        group.append(option);
        providerButtons.push(option);
      }
      providerList.append(group);
    }

    function syncProviderPicker() {
      const selected = [...provider.options].find(option => option.value === provider.value) || provider.options[0];
      providerTrigger.textContent = selected?.textContent || "Chọn dịch vụ AI";
      for (const option of providerButtons) {
        option.setAttribute("aria-selected", String(option.dataset.providerValue === provider.value));
      }
    }

    function closeProviderMenu(restoreFocus = false) {
      providerList.hidden = true;
      providerTrigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) providerTrigger.focus();
    }

    function openProviderMenu(focusSelected = false) {
      if (provider.disabled || providerTrigger.disabled) return;
      providerList.hidden = false;
      providerTrigger.setAttribute("aria-expanded", "true");
      if (focusSelected) {
        (providerButtons.find(option => option.dataset.providerValue === provider.value) || providerButtons[0])?.focus();
      }
    }

    providerTrigger.addEventListener("click", () => {
      if (providerList.hidden) openProviderMenu(); else closeProviderMenu();
    });
    providerTrigger.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") closeProviderMenu();
      else openProviderMenu(true);
    });
    function selectProviderOption(option) {
      const changed = provider.value !== option.dataset.providerValue;
      provider.value = option.dataset.providerValue;
      syncProviderPicker();
      closeProviderMenu(true);
      if (!changed) return;
      if (typeof options.onProviderChange === "function") options.onProviderChange(provider.value);
      else provider.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
    }
    providerList.addEventListener("keydown", event => {
      const current = providerButtons.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeProviderMenu(true);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        if (current >= 0) {
          event.preventDefault();
          selectProviderOption(providerButtons[current]);
        }
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? providerButtons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + providerButtons.length) % providerButtons.length;
      providerButtons[next]?.focus();
    });
    for (const option of providerButtons) {
      option.addEventListener("click", () => selectProviderOption(option));
    }
    providerPicker.addEventListener("focusout", () => {
      document.defaultView?.setTimeout?.(() => {
        if (!providerPicker.contains(document.activeElement)) closeProviderMenu();
      }, 0);
    });
    provider.addEventListener("change", syncProviderPicker);
    syncProviderPicker();
    providerPicker.append(provider, providerTrigger, providerList);
    providerLabel.append(providerPicker);

    const translate = button(document, "stvai-button stvai-button--primary", "Dịch AI");
    const original = button(
      document,
      "stvai-button stvai-button--quiet stvai-button--original",
      "Bản gốc",
      "Dừng bản dịch và hiện lại nội dung gốc của Sáng Tác Việt"
    );
    original.disabled = true;
    const cancel = button(document, "stvai-button stvai-button--quiet", "Hủy");
    cancel.hidden = true;
    const resume = button(document, "stvai-button stvai-button--primary", "Tiếp tục");
    resume.hidden = true;
    const listen = button(
      document,
      "stvai-button stvai-button--listen",
      "Nghe sách",
      "Nghe bản dịch AI bằng trình Nghe sách của Sáng Tác Việt"
    );
    listen.disabled = true;

    const statusArea = element(document, "div", "stvai-status-area");
    const status = element(document, "span", "stvai-status", "Sẵn sàng");
    status.setAttribute("aria-live", "polite");
    const progress = element(document, "div", "stvai-progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Tiến độ dịch chương");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "1");
    progress.setAttribute("aria-valuenow", "0");
    statusArea.append(status, progress);
    if (document.location?.protocol === "http:") {
      statusArea.prepend(element(document, "span", "stvai-http-warning", "Cảnh báo: kết nối STV không được mã hóa"));
    }

    const settingsButton = button(
      document,
      "stvai-button stvai-button--settings",
      "Cài đặt",
      "Mở cài đặt Phwgna Stv"
    );
    const namesButton = button(
      document,
      "stvai-button stvai-button--names",
      "Bộ Name",
      "Mở trình quản lý bộ Name"
    );

    const actionGroup = element(document, "div", "stvai-actions");
    actionGroup.append(providerLabel, translate, original, cancel, resume, listen);
    const menuBody = element(document, "div", "stvai-menu-body");
    menuBody.id = "stvai-menu-body";
    const clearCache = button(document, "stvai-button stvai-button--clear-cache", "Xóa cache");
    const cacheConfirmation = element(document, "div", "stvai-cache-confirmation");
    cacheConfirmation.id = "stvai-cache-confirmation";
    cacheConfirmation.hidden = true;
    cacheConfirmation.setAttribute("role", "group");
    cacheConfirmation.setAttribute("aria-label", "Xóa toàn bộ cache dịch?");
    const cacheConfirmationText = element(
      document,
      "p",
      "stvai-cache-confirmation-text",
      "Thao tác này xóa toàn bộ bản dịch đã lưu. Các chương đó sẽ cần dịch lại."
    );
    const confirmClearCache = button(document, "stvai-button stvai-cache-confirm", "Xóa");
    const cancelClearCache = button(document, "stvai-button stvai-cache-cancel", "Hủy");
    cacheConfirmation.append(cacheConfirmationText, confirmClearCache, cancelClearCache);
    clearCache.setAttribute("aria-controls", cacheConfirmation.id);
    clearCache.setAttribute("aria-expanded", "false");
    function closeCacheConfirmation(restoreFocus = false) {
      cacheConfirmation.hidden = true;
      clearCache.hidden = false;
      clearCache.setAttribute("aria-expanded", "false");
      if (restoreFocus) clearCache.focus();
    }
    clearCache.addEventListener("click", () => {
      if (clearCache.disabled) return;
      clearCache.hidden = true;
      cacheConfirmation.hidden = false;
      clearCache.setAttribute("aria-expanded", "true");
      motion()?.reveal?.(cacheConfirmation);
      cancelClearCache.focus();
    });
    cancelClearCache.addEventListener("click", () => closeCacheConfirmation(true));
    cacheConfirmation.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeCacheConfirmation(true);
    });
    menuBody.append(actionGroup, namesButton, clearCache, cacheConfirmation, statusArea, settingsButton);
    const announcement = element(document, "div", "stvai-tts-announcement");
    announcement.hidden = true;
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    root.append(header, menuBody, announcement);

    const setCollapsed = (collapsed, notify = false, animate = false) => {
      collapsed = collapsed === true;
      motion()?.finishToolbar?.(root);
      const iconForState = () => root.dataset.collapsed === "true"
        ? miniToggle.querySelector(".stvai-mini-toggle-icon") : identity.querySelector(".stvai-identity-mark");
      const before = animate ? root.getBoundingClientRect() : null;
      const iconBefore = animate ? iconForState().getBoundingClientRect() : null;
      if (collapsed) {
        closeCacheConfirmation();
        closeProviderMenu();
      }
      root.dataset.collapsed = String(collapsed);
      menuToggle.setAttribute("aria-expanded", String(!collapsed));
      miniToggle.setAttribute("aria-expanded", String(!collapsed));
      menuToggle.setAttribute("aria-label", collapsed
        ? "Mở menu Phwgna Stv"
        : "Thu gọn menu Phwgna Stv");
      miniToggle.setAttribute("aria-label", collapsed
        ? `Mở menu Phwgna Stv${miniToggle.dataset.progressSummary || ""}`
        : `Thu gọn menu Phwgna Stv${miniToggle.dataset.progressSummary || ""}`);
      if (animate) {
        if (iconBefore?.width > 0) options.onLayoutChange?.({
          x: iconBefore.left + iconBefore.width / 2,
          y: iconBefore.top + iconBefore.height / 2
        }, iconForState());
        const after = root.getBoundingClientRect();
        const scale = Number.parseFloat(document.defaultView?.getComputedStyle(root).zoom) || 1;
        motion()?.toggleToolbar?.(root, collapsed, before?.width > 0 ? {
          from: { width: before.width / scale, height: before.height / scale },
          to: { width: after.width / scale, height: after.height / scale }
        } : undefined);
      }
      if (notify) options.onCollapsedChange?.(collapsed);
      return collapsed;
    };
    setCollapsed(options.initialCollapsed === true);
    const toggleCollapsed = () => setCollapsed(root.dataset.collapsed !== "true", true, true);
    menuToggle.addEventListener("click", toggleCollapsed);
    miniToggle.addEventListener("click", toggleCollapsed);

    return {
      root,
      finishAnimation: () => motion()?.finishToolbar?.(root),
      menuToggle,
      miniToggle,
      miniProgress,
      miniCompleteRing,
      miniTomoe,
      announcement,
      dragHandle: header,
      dragHandles: [header, miniToggle],
      provider,
      providerTrigger,
      providerList,
      closeProviderMenu,
      setProviderValue(value) {
        provider.value = value;
        syncProviderPicker();
      },
      translate,
      original,
      cancel,
      resume,
      listen,
      status,
      progress,
      names: namesButton,
      clearCache,
      cacheConfirmation,
      confirmClearCache,
      closeCacheConfirmation,
      cacheClearing: false,
      settings: settingsButton
    };
  }

  function announceToolbar(toolbar, message, options = {}) {
    if (!toolbar?.announcement) return;
    const view = toolbar.root.ownerDocument.defaultView;
    if (toolbar.announcementTimer) view?.clearTimeout?.(toolbar.announcementTimer);
    const text = String(message || "").trim();
    toolbar.announcement.textContent = text;
    toolbar.announcement.hidden = !text;
    if (!toolbar.announcement.hidden) {
      const rect = toolbar.root.getBoundingClientRect();
      toolbar.announcement.dataset.placement = rect.top < 100 ? "below" : "above";
      const timeoutMs = Math.max(1, Math.min(10_000, Number(options.timeoutMs) || 2800));
      toolbar.announcementTimer = view?.setTimeout?.(() => {
        toolbar.announcement.hidden = true;
        toolbar.announcementTimer = 0;
      }, timeoutMs);
    }
  }

  function showToast(document, message, options = {}) {
    document.querySelector(".stvai-toast")?.remove();
    const kind = options.kind === "notice" ? "notice" : "error";
    const toast = element(document, "div", `stvai-toast stvai-toast--${kind}`, String(message || "").trim());
    if (kind === "notice") toast.setAttribute("aria-hidden", "true");
    else {
      toast.setAttribute("role", "alert");
      toast.setAttribute("aria-live", "assertive");
    }
    document.body.append(toast);
    const defaultTimeout = kind === "notice" ? 1_500 : 3_000;
    const timeoutMs = Math.max(1, Math.min(10_000, Number(options.timeoutMs) || defaultTimeout));
    document.defaultView?.setTimeout?.(() => toast.remove(), timeoutMs);
    return toast;
  }

  function setToolbarState(toolbar, state) {
    const value = state || {};
    if (typeof value.status === "string") toolbar.status.textContent = value.status;
    const total = Math.max(1, Number(value.total) || 1);
    const requestedIndexes = Array.isArray(value.completedIndexes)
      ? value.completedIndexes
      : Array.from({ length: Math.min(total, Math.max(0, Number(value.completed) || 0)) }, (_, index) => index);
    const completedIndexes = new Set(requestedIndexes
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < total));
    const completed = completedIndexes.size;
    const busy = Boolean(value.running || value.paused);
    const captchaRetry = value.captchaRetry === true;
    toolbar.progress.setAttribute("aria-valuemax", String(total));
    toolbar.progress.setAttribute("aria-valuenow", String(completed));
    toolbar.progress.style.setProperty("--stvai-batch-count", String(total));
    if (toolbar.progress.children.length !== total) {
      const segments = Array.from({ length: total }, (_, index) => {
        const segment = toolbar.progress.ownerDocument.createElement("span");
        segment.className = "stvai-progress-segment";
        segment.dataset.batchIndex = String(index);
        segment.setAttribute("aria-hidden", "true");
        return segment;
      });
      toolbar.progress.replaceChildren(...segments);
    }
    for (const segment of toolbar.progress.children) {
      const next = completedIndexes.has(Number(segment.dataset.batchIndex));
      const changed = next && !segment.classList.contains("is-complete");
      segment.classList.toggle("is-complete", next);
      if (changed) motion()?.completeProgress?.(segment);
    }

    const miniProgress = toolbar.miniProgress;
    if (miniProgress) {
      const visible = busy || completed > 0;
      miniProgress.dataset.visible = String(visible);
      if (miniProgress.children.length !== total) {
        const radius = 20.5;
        const segments = Array.from({ length: total }, (_, index) => {
          const segment = miniProgress.ownerDocument.createElementNS("http://www.w3.org/2000/svg", total === 1 ? "circle" : "path");
          segment.classList.add("stvai-mini-progress-segment");
          segment.dataset.batchIndex = String(index);
          if (total === 1) {
            segment.dataset.arcAngle = "360";
            segment.setAttribute("cx", "24");
            segment.setAttribute("cy", "24");
            segment.setAttribute("r", String(radius));
          } else {
            const arc = circularProgressArc(index, total, 24, radius);
            segment.dataset.arcAngle = String(arc.arcAngle);
            segment.setAttribute("d", arc.path);
          }
          return segment;
        });
        miniProgress.replaceChildren(...segments);
      }
      for (const segment of miniProgress.children) {
        segment.classList.toggle("is-complete", completedIndexes.has(Number(segment.dataset.batchIndex)));
      }
      const chapterComplete = value.state === "completed" && completed === total;
      const prefetchTotal = Math.min(3, Math.max(0, Number(value.prefetchTotal) || 0));
      const prefetchCompleted = Math.min(prefetchTotal, Math.max(0, Number(value.prefetchCompleted) || 0));
      const prefetchRunning = value.prefetchRunning === true;
      const prefetchCacheable = value.prefetchCacheable !== false;
      const tomoeCount = chapterComplete && prefetchCacheable ? prefetchCompleted : 0;
      const tomoeActive = tomoeCount > 0;
      // Keep the completed-chapter ring visible while the next chapter is only
      // preparing (0/N). Hand the indicator over once the first cached batch
      // has produced a visible tomoe, so the mini dock never goes blank.
      const prefetchOwnsIndicator = chapterComplete && tomoeActive;
      miniProgress.dataset.running = String(value.running === true && !chapterComplete);
      miniProgress.dataset.complete = String(chapterComplete);
      toolbar.miniCompleteRing.dataset.active = String(chapterComplete && !prefetchOwnsIndicator);
      if (toolbar.miniTomoe) {
        toolbar.miniTomoe.dataset.active = String(tomoeActive);
        toolbar.miniTomoe.dataset.count = String(tomoeCount);
        toolbar.miniTomoe.dataset.running = String(prefetchRunning);
        const tomoeSeeds = toolbar.miniTomoe.querySelectorAll('.stvai-mini-tomoe-seed');
        const tomoeAngles = tomoeCount === 1
          ? [0]
          : tomoeCount === 2
            ? [0, 180]
            : tomoeCount === 3
              ? [0, 120, 240]
              : [];
        for (const seed of tomoeSeeds) {
          const index = Number(seed.dataset.tomoeIndex);
          const angle = tomoeAngles[index];
          if (Number.isFinite(angle) && angle !== 0) {
            seed.setAttribute('transform', `rotate(${angle} 40 40)`);
          } else {
            seed.removeAttribute('transform');
          }
        }
      }
      const action = toolbar.root.dataset.collapsed === "true" ? "Mở" : "Thu gọn";
      const summary = visible ? ` — đã dịch ${completed}/${total} batch` : "";
      const prefetchSummary = prefetchTotal > 0 ? `; dịch trước chương kế ${prefetchCompleted}/${prefetchTotal} batch` : "";
      toolbar.miniToggle.dataset.progressSummary = summary;
      toolbar.miniToggle.setAttribute("aria-label", `${action} menu Phwgna Stv${summary}${prefetchSummary}`);
      toolbar.miniToggle.title = visible ? `Tiến độ chương: ${completed}/${total} batch${prefetchSummary}` : "";
    }
    toolbar.root.dataset.state = value.state || "idle";
    toolbar.clearCache.disabled = busy || toolbar.cacheClearing;
    if (busy) toolbar.closeCacheConfirmation();
    toolbar.translate.hidden = busy && !captchaRetry && value.showingOriginal !== true;
    toolbar.translate.textContent = captchaRetry ? "Dịch lại" : "Dịch AI";
    toolbar.provider.disabled = busy;
    toolbar.providerTrigger.disabled = busy;
    if (busy) toolbar.closeProviderMenu();
    toolbar.original.disabled = value.showingOriginal === true;
    toolbar.cancel.hidden = !busy;
    toolbar.resume.hidden = !value.paused || captchaRetry;
    const listening = value.listening === true;
    const listeningPending = value.listeningPending === true;
    toolbar.listen.disabled = !value.canListen && !listening && !listeningPending;
    toolbar.listen.textContent = listening || listeningPending ? "Dừng nghe" : "Nghe sách";
    toolbar.listen.setAttribute("aria-pressed", listening || listeningPending ? "true" : "false");
  }

  function createModalFocusManager(document, root, initialFocus) {
    let active = false;
    let previousFocus = null;
    const focusableSelector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusable = () => Array.from(root.querySelectorAll(focusableSelector))
      .filter(node => !node.hidden && node.getAttribute("aria-hidden") !== "true");
    const onKeyDown = event => {
      if (!active || event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    return {
      activate() {
        if (active) return;
        active = true;
        previousFocus = document.activeElement;
        root.addEventListener("keydown", onKeyDown);
        Promise.resolve().then(() => {
          if (!active || !root.isConnected) return;
          (initialFocus && !initialFocus.disabled ? initialFocus : focusable()[0] || root).focus();
        });
      },
      close() {
        if (active) root.removeEventListener("keydown", onKeyDown);
        active = false;
        root.remove();
        if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
        previousFocus = null;
      }
    };
  }

  function createConsentPanel(document, provider) {
    const labels = { chatgpt: "ChatGPT Web", gemini: "Gemini Web", openrouter_api: "OpenRouter API", gemini_api: "Gemini API", openai_api: "OpenAI API", deepseek_api: "DeepSeek API" };
    const label = labels[provider] || "dịch vụ AI";
    const root = element(document, "div", "stvai-consent-backdrop");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "stvai-consent-title");
    const panel = element(document, "section", "stvai-consent");
    const brand = consentBrand(document, "XÁC NHẬN LẦN ĐẦU");
    const title = element(document, "h2", "stvai-consent-title", "Gửi chương sang dịch vụ AI?");
    title.id = "stvai-consent-title";
    const description = element(
      document,
      "p",
      "stvai-consent-description",
      `Tiện ích sẽ gửi nguyên văn tiếng Trung của chương đang mở tới ${label} trong tab Cốc Cốc đã đăng nhập. Tiện ích không đọc mật khẩu hoặc cookie.`
    );
    if (String(provider || "").endsWith("_api")) {
      description.textContent = `Tiện ích sẽ gửi nguyên văn tiếng Trung của chương đang mở tới ${label} bằng API key đã lưu cục bộ. API key không được đưa vào trang truyện.`;
    }
    const note = element(
      document,
      "p",
      "stvai-consent-note",
      "Chỉ chương hiện tại được gửi. Bạn có thể hủy trước hoặc trong quá trình dịch."
    );
    const actions = element(document, "div", "stvai-consent-actions");
    const cancel = button(document, "stvai-button stvai-button--quiet", "Quay lại");
    const confirm = button(document, "stvai-button stvai-button--primary", `Gửi tới ${label}`);
    actions.append(cancel, confirm);
    panel.append(brand, title, description, note, actions);
    root.append(panel);
    return { root, confirm, cancel, ...createModalFocusManager(document, root, cancel) };
  }

  function createAutomationConsentPanel(document, provider, options = {}) {
    const labels = {
      gemini: "Gemini Web",
      chatgpt: "ChatGPT Web",
      openrouter_api: "OpenRouter API",
      gemini_api: "Gemini API",
      openai_api: "OpenAI API",
      deepseek_api: "DeepSeek API"
    };
    const label = labels[provider] || "dịch vụ AI";
    const apiMode = String(provider || "").endsWith("_api");
    const autoTranslate = options.autoTranslate !== false;
    const tabCount = Math.min(5, Math.max(2, Math.trunc(Number(options.tabCount)) || 2));
    const root = element(document, "div", "stvai-consent-backdrop stvai-automation-consent-backdrop");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "stvai-automation-consent-title");
    const panel = element(document, "section", "stvai-consent");
    const brand = consentBrand(document, "XÁC NHẬN TỰ ĐỘNG");
    const title = element(
      document,
      "h2",
      "stvai-consent-title",
      apiMode
        ? "Tự động dịch chương qua API?"
        : (autoTranslate ? "Tự động chuẩn bị và dịch chương?" : `Chuẩn bị sẵn ${tabCount} tab AI?`)
    );
    title.id = "stvai-automation-consent-title";
    const description = element(
      document,
      "p",
      "stvai-consent-description",
      apiMode
        ? `Khi mở chương, tiện ích sẽ gửi prompt, bộ Name và nội dung cần dịch trực tiếp tới ${label}. Không mở tab AI Web.`
        : `Tiện ích sẽ gửi trước System Prompt, User Prompt và bộ Name/thuật ngữ tới ${label} để chuẩn bị ${tabCount} tab AI.`
    );
    const note = element(
      document,
      "p",
      "stvai-consent-note",
      apiMode
        ? "Chỉ API key của nhà cung cấp đã chọn được dùng. API key không được gửi vào trang STV, cache hay chẩn đoán."
        : autoTranslate
        ? "Khi bạn mở một chương, tiện ích sẽ tự động gửi nội dung chương sang dịch vụ AI và bắt đầu dịch. Mật khẩu và cookie không được đọc."
        : "Nội dung chương chỉ được gửi khi bạn bấm Dịch AI. Mật khẩu và cookie không được đọc."
    );
    if (autoTranslate) {
      note.append(document.createTextNode(" Sau khi chương hiện tại hoàn tất, tối đa 3 batch đầu của chương kế có thể được gửi trước để giảm thời gian chờ."));
    }
    const actions = element(document, "div", "stvai-consent-actions");
    const cancel = button(
      document,
      "stvai-button stvai-button--quiet",
      (apiMode || autoTranslate) ? "Không tự động" : "Không chuẩn bị"
    );
    const confirm = button(
      document,
      "stvai-button stvai-button--primary",
      (apiMode || autoTranslate) ? "Cho phép và dịch" : "Cho phép chuẩn bị"
    );
    actions.append(cancel, confirm);
    panel.append(brand, title, description, note, actions);
    root.append(panel);
    return { root, confirm, cancel, ...createModalFocusManager(document, root, cancel) };
  }

  function createTtsConsentPanel(document) {
    const root = element(document, "div", "stvai-consent-backdrop stvai-tts-consent-backdrop");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "stvai-tts-consent-title");
    const panel = element(document, "section", "stvai-consent");
    const brand = consentBrand(document, "XÁC NHẬN LẦN ĐẦU");
    const title = element(document, "h2", "stvai-consent-title", "Nghe sách bằng bản dịch AI?");
    title.id = "stvai-tts-consent-title";
    const description = element(
      document,
      "p",
      "stvai-consent-description",
      "Bản dịch AI trên trang sẽ được gửi qua dịch vụ giọng đọc của STV (Sáng Tác Việt). Tiện ích chỉ kích hoạt trình Nghe sách đang có trên trang."
    );
    const note = element(
      document,
      "p",
      "stvai-consent-note",
      "Giọng đọc, tốc độ, cao độ và màu tô sáng tiếp tục dùng cài đặt của STV. Khi STV chuyển sang Chương sau, tool sẽ tự động gửi chương đó cho AI và chỉ đọc tiếp sau khi batch đầu đã dịch xong."
    );
    const actions = element(document, "div", "stvai-consent-actions");
    const cancel = button(document, "stvai-button stvai-button--quiet", "Quay lại");
    const confirm = button(document, "stvai-button stvai-button--primary", "Nghe sách");
    actions.append(cancel, confirm);
    panel.append(brand, title, description, note, actions);
    root.append(panel);
    return { root, confirm, cancel, ...createModalFocusManager(document, root, cancel) };
  }

  return Object.freeze({
    UI_SCALES,
    normalizeUiScale,
    applyUiScale,
    createCopyrightGuard,
    createReaderView,
    updateReaderView,
    setChapterCompleteNotice,
    restoreNativeBlocks,
    createNativeSync,
    createNavigationControls,
    createTtsOverlayDrag,
    createToolbar,
    announceToolbar,
    showToast,
    setToolbarState,
    createConsentPanel,
    createAutomationConsentPanel,
    createTtsConsentPanel,
    safeImageUrl
  });
});
