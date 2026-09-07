(function attachExtractor(root, factory) {
  const api = factory(root.STVAISites || (typeof require === 'function' ? require('../shared/stv-sites.js') : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createExtractor(sites) {
  "use strict";

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const MAX_TEXT_BLOCK_CHARS = 3000;
  const COLLAPSED_TEXT_BLOCK_CHARS = 1000;
  const STV_FILENAME_EXTENSION_RE = /^\.(?:jpe?g|png|gif|webp|bmp|avif)$/iu;
  const STV_FILENAME_TRAILING_CLOSERS_RE = /^[\s)\]}】》）］｝〉」』”’]*$/u;
  const STV_FILENAME_TRAILING_CLOSERS_END_RE = /[\s)\]}】》）］｝〉」』”’]+$/u;
  const STV_FILENAME_ARTIFACT_MAX_CHARS = 240;

  class ExtractionError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ExtractionError";
      this.code = code;
    }
  }

  function isChapterPath(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean);
    // Some STV sources (for example Fanqie) render the current chapter on a
    // book-scoped route without a chapter id in the URL. Treat the route only
    // as a candidate here; extractChapter remains the authoritative DOM gate.
    return parts[0] === "truyen" && parts.length >= 4;
  }

  function normalizeLine(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[\t ]+/g, " ")
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/\s+([，。！？；：、,.!?;:])/g, "$1")
      .replace(/([，。！？；：、])\s+/g, "$1")
      .replace(/([（【《“‘])\s+/g, "$1")
      .replace(/\s+([）】》”’])/g, "$1")
      .trim();
  }

  function normalizeParagraph(value) {
    return String(value || "")
      .split("\n")
      .map(normalizeLine)
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  // Source only: match STV's token-spacing cleanup before measuring or splitting
  // a paragraph. Keep Latin word boundaries and actual line breaks intact.
  function normalizeSourceParagraph(value) {
    return normalizeParagraph(value).split("\n").map(line => line
      .replace(/([\p{Script=Han}，。！？；：、【】“”‘’（）《》~]) +/gu, '$1')
      .replace(/ +(?=[\p{Script=Han}，。！？；：、【】“”‘’（）《》~])/gu, '')).join("\n");
  }

  function cjkRatio(value) {
    const text = String(value || "");
    const cjk = (text.match(CJK_RE) || []).length;
    const meaningful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    return meaningful ? cjk / meaningful : 0;
  }

  function splitLongParagraph(value, maxChars) {
    const text = String(value || "");
    const limit = Math.max(1, Number(maxChars) || MAX_TEXT_BLOCK_CHARS);
    const pieces = [];
    let cursor = 0;
    while (cursor < text.length) {
      let end = Math.min(text.length, cursor + limit);
      if (end < text.length) {
        const window = text.slice(cursor, end);
        let natural = -1;
        for (const punctuation of ["\n", "。", "！", "？", "；", ".", "!", "?"]) {
          natural = Math.max(natural, window.lastIndexOf(punctuation));
        }
        if (natural >= Math.floor(limit * 0.6)) end = cursor + natural + 1;
        const lastCode = text.charCodeAt(end - 1);
        const nextCode = text.charCodeAt(end);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          end -= 1;
        }
      }
      pieces.push(text.slice(cursor, end));
      cursor = end;
    }
    return pieces;
  }

  function paragraphSplitLimit(value) {
    const text = String(value || "");
    const naturalBoundaries = (text.match(/[\n。！？；.!?]/g) || []).length;
    return text.length > COLLAPSED_TEXT_BLOCK_CHARS && naturalBoundaries >= 2
      ? COLLAPSED_TEXT_BLOCK_CHARS
      : MAX_TEXT_BLOCK_CHARS;
  }

  function mergeContext(items, value, node = null) {
    const text = String(value || "");
    if (!text) return;
    const previous = items[items.length - 1];
    if (previous?.kind === "context" && previous.node === node) previous.text += text;
    else items.push({ kind: "context", text, node });
  }

  const BUYER_ATTRIBUTION_PATTERN = /^Người\s+mua\s*:\s*(\S(?:.*\S)?)\s*,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/iu;
  const PRESENTATION_PROPERTIES = Object.freeze([
    "color", "fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight",
    "letterSpacing", "textAlign", "textDecoration", "textTransform", "whiteSpace"
  ]);

  function validBuyerAttribution(value) {
    const text = normalizeParagraph(value);
    const match = text.match(BUYER_ATTRIBUTION_PATTERN);
    if (!match) return false;
    const day = Number(match[2]);
    const month = Number(match[3]);
    const year = Number(match[4]);
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2999) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function sliceReferenceItems(items, endOffset) {
    const result = [];
    let cursor = 0;
    for (const item of items) {
      const contribution = item.kind === "token" ? item.source : item.text;
      const next = cursor + contribution.length;
      if (cursor >= endOffset) break;
      if (next <= endOffset) result.push({ ...item });
      else if (item.kind === "context") result.push({ ...item, text: contribution.slice(0, endOffset - cursor) });
      cursor = next;
    }
    return compactReference(result);
  }

  function contextNodesAfter(items, startOffset) {
    const nodes = [];
    let cursor = 0;
    for (const item of items) {
      const contribution = item.kind === "token" ? item.source : item.text;
      const next = cursor + contribution.length;
      if (item.kind === "context" && next > startOffset && item.node?.nodeType === 3 && !nodes.includes(item.node)) {
        nodes.push(item.node);
      }
      cursor = next;
    }
    return nodes;
  }

  function presentationOf(document, node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const computed = element && document.defaultView?.getComputedStyle?.(element);
    const result = Object.create(null);
    if (!computed) return result;
    for (const property of PRESENTATION_PROPERTIES) {
      const value = String(computed[property] || "").trim();
      if (value) result[property] = value;
    }
    return result;
  }

  function exactBuyerElement(container, textNodes, footerText) {
    for (const textNode of textNodes) {
      for (let element = textNode.parentElement; element && element !== container; element = element.parentElement) {
        if (element.querySelector?.("i[t]") || normalizeParagraph(element.textContent) !== footerText) continue;
        return element;
      }
    }
    return null;
  }

  function extractTrailingBuyerAttribution(document, container, items, preserveNative) {
    const raw = referenceSource(items).replace(/\r/g, "");
    const line = raw.match(/(?:^|\n)[\t ]*(Người\s+mua\s*:[^\n]*)[\t ]*$/iu);
    if (!line || !validBuyerAttribution(line[1])) return null;
    const footerText = normalizeParagraph(line[1]);
    const footerStart = line.index + line[0].indexOf(line[1]);
    let cursor = 0;
    let lastTokenEnd = -1;
    for (const item of items) {
      const contribution = item.kind === "token" ? item.source : item.text;
      cursor += contribution.length;
      if (item.kind === "token") lastTokenEnd = cursor;
    }
    if (lastTokenEnd < 0 || footerStart < lastTokenEnd) return null;

    const textNodes = contextNodesAfter(items, footerStart);
    const exactNode = exactBuyerElement(container, textNodes, footerText);
    const styleSource = exactNode || textNodes[0] || container;
    let anchor = null;
    if (exactNode && preserveNative !== false) {
      anchor = document.createComment("stvai-buyer-attribution");
      exactNode.after(anchor);
    }
    return {
      storyItems: sliceReferenceItems(items, line.index),
      block: {
        id: "B0001",
        kind: "buyer_attribution",
        text: footerText,
        node: exactNode,
        anchor,
        presentation: presentationOf(document, styleSource)
      }
    };
  }

  function splitReferenceParagraphs(items) {
    const paragraphs = [];
    let current = [];
    let lineBreaks = 0;

    function finish() {
      while (current[0]?.kind === "context" && !current[0].text.trim()) current.shift();
      while (current.at(-1)?.kind === "context" && !current.at(-1).text.trim()) current.pop();
      if (current.length) paragraphs.push(current);
      current = [];
      lineBreaks = 0;
    }

    for (const item of items) {
      if (item.kind !== "context" || !item.text.includes("\n")) {
        if (item.kind === "context" && !item.text.trim() && lineBreaks > 0) continue;
        lineBreaks = 0;
        if (item.kind === "context") mergeContext(current, item.text);
        else current.push(item);
        continue;
      }
      const parts = item.text.split(/(\n)/);
      for (const part of parts) {
        if (!part) continue;
        if (part === "\n") {
          lineBreaks += 1;
          if (lineBreaks >= 2) finish();
          else mergeContext(current, "\n");
        } else if (part.trim()) {
          lineBreaks = 0;
          mergeContext(current, part);
        }
      }
    }
    finish();
    return paragraphs;
  }

  function referenceSource(items) {
    return items.map((item) => item.kind === "token" ? item.source : item.text).join("");
  }

  function referenceConvert(items) {
    return normalizeParagraph(items.map((item) => {
      if (item.kind !== "token") return item.text;
      return item.convert || item.alternatives?.[0] || item.source;
    }).join("").replace(/\r/g, ""));
  }

  function isStvFilenameArtifact(items) {
    let lastIndex = items.length - 1;
    let trailingText = "";
    while (lastIndex >= 0 && items[lastIndex].kind === "context") {
      trailingText = items[lastIndex].text + trailingText;
      lastIndex -= 1;
    }
    if (!STV_FILENAME_TRAILING_CLOSERS_RE.test(trailingText)) return false;

    const last = items[lastIndex];
    if (last?.kind !== "token" || !STV_FILENAME_EXTENSION_RE.test(last.source)) return false;
    const token = last.node;
    if (token?.nodeType !== 1 || token.tagName !== "I") return false;
    if (normalizeLine(token.getAttribute("h") || "").toLowerCase() !== last.source.toLowerCase()) return false;
    if (!/^\s*pr\s*\(\s*this\s*\)\s*;?\s*$/iu.test(token.getAttribute("onclick") || "")) return false;
    const source = normalizeSourceParagraph(referenceSource(items).replace(/\r/g, ""));
    if (!source || source.length > STV_FILENAME_ARTIFACT_MAX_CHARS) return false;
    const sourceWithoutTrailingClosers = source.replace(STV_FILENAME_TRAILING_CLOSERS_END_RE, "");
    if (!sourceWithoutTrailingClosers.toLowerCase().endsWith(last.source.toLowerCase())) return false;
    const basename = sourceWithoutTrailingClosers.slice(0, -last.source.length).trim();
    return Boolean(basename) && !/[。！？；!?;]/u.test(basename);
  }

  function compactReference(items) {
    const compacted = [];
    for (const item of items) {
      if (item.kind === "context") {
        mergeContext(compacted, item.text.replace(/[\t ]+/g, " "), item.node);
      } else {
        compacted.push({ ...item });
      }
    }
    while (compacted[0]?.kind === "context" && !compacted[0].text.trim()) compacted.shift();
    while (compacted.at(-1)?.kind === "context" && !compacted.at(-1).text.trim()) compacted.pop();
    return compacted;
  }

  function referencesForPieces(items, pieces) {
    if (pieces.length === 1) return [compactReference(items)];
    const ranges = [];
    let pieceCursor = 0;
    for (const piece of pieces) {
      ranges.push({ start: pieceCursor, end: pieceCursor + piece.length });
      pieceCursor += piece.length;
    }
    const results = pieces.map(() => []);
    let rawPrefix = "";
    let normalizedStart = 0;

    function containingPiece(position) {
      const index = ranges.findIndex((range) => position >= range.start && position < range.end);
      return index >= 0 ? index : Math.max(0, ranges.length - 1);
    }

    for (const item of items) {
      const contribution = item.kind === "token" ? item.source : item.text;
      rawPrefix += contribution;
      const normalizedPrefix = normalizeSourceParagraph(rawPrefix);
      const normalizedEnd = normalizedPrefix.length;
      if (normalizedEnd === normalizedStart) {
        results[containingPiece(normalizedStart)].push({ ...item });
        continue;
      }
      for (let pieceIndex = 0; pieceIndex < ranges.length; pieceIndex += 1) {
        const overlapStart = Math.max(normalizedStart, ranges[pieceIndex].start);
        const overlapEnd = Math.min(normalizedEnd, ranges[pieceIndex].end);
        if (overlapStart >= overlapEnd) continue;
        if (item.kind === "context") {
          results[pieceIndex].push({ ...item });
          continue;
        }
        const coversWholeToken = overlapStart === normalizedStart && overlapEnd === normalizedEnd;
        if (coversWholeToken) {
          results[pieceIndex].push({ ...item });
          continue;
        }
        const source = item.source.length === normalizedEnd - normalizedStart
          ? item.source.slice(overlapStart - normalizedStart, overlapEnd - normalizedStart)
          : normalizedPrefix.slice(overlapStart, overlapEnd);
        results[pieceIndex].push({
          ...item,
          source,
          convert: source,
          alternatives: [],
          hint: "",
          selectable: Boolean(source)
        });
      }
      normalizedStart = normalizedEnd;
    }
    return results.map(compactReference);
  }

  function extractChapter(document, options) {
    const config = options || {};
    const container = sites.chapterRoot(document, config.url || document.URL);
    if (!container || !container.querySelector("i[t]")) {
      throw new ExtractionError(
        "SOURCE_NOT_FOUND",
        "Không tìm thấy nguyên văn tiếng Trung trong chương này."
      );
    }

    const blocks = [];
    const nameReferencesByBlock = Object.create(null);
    const sourceNodeBlockIds = new WeakMap();
    let paragraphIndex = 0;
    let paragraphGroupIndex = 0;
    let nativeIndex = 0;
    let started = false;
    let pendingReferenceItems = [];

    function isInlineNativeElement(element) {
      const computed = document.defaultView?.getComputedStyle?.(element)?.display || "";
      if (computed) return computed === "contents" || computed.startsWith("inline");
      return ["A", "I", "IMG", "SPAN", "SVG"].includes(element.tagName);
    }

    function appendText(value, node) {
      if (started) mergeContext(pendingReferenceItems, String(value || ""), node);
    }

    function flushText(final = false) {
      const attribution = final
        ? extractTrailingBuyerAttribution(document, container, pendingReferenceItems, options?.preserveNative)
        : null;
      const paragraphs = splitReferenceParagraphs(attribution?.storyItems || pendingReferenceItems);
      for (const referenceItems of paragraphs) {
        if (isStvFilenameArtifact(referenceItems)) continue;
        const text = normalizeSourceParagraph(referenceSource(referenceItems).replace(/\r/g, ""));
        if (!text) continue;
        paragraphGroupIndex += 1;
        const paragraphGroup = `G${String(paragraphGroupIndex).padStart(4, "0")}`;
        const pieces = splitLongParagraph(text, paragraphSplitLimit(text));
        const references = referencesForPieces(referenceItems, pieces);
        for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
          const segment = pieces[pieceIndex];
          paragraphIndex += 1;
          const id = `P${String(paragraphIndex).padStart(4, "0")}`;
          blocks.push({
            id,
            kind: "text",
            text: segment,
            convert: referenceConvert(references[pieceIndex]),
            paragraphGroup
          });
          nameReferencesByBlock[id] = references[pieceIndex].map(({ node: _node, ...item }) => item);
          for (const reference of references[pieceIndex]) {
            if (reference.kind === "token" && reference.node?.nodeType === 1) {
              sourceNodeBlockIds.set(reference.node, id);
            }
          }
        }
      }
      if (attribution) blocks.push(attribution.block);
      pendingReferenceItems = [];
    }

    function visit(node) {
      if (node.nodeType === 3) {
        appendText(String(node.nodeValue || "").replace(/\s+/g, " "), node);
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node;
      const tagName = element.tagName;
      if (element.classList.contains("stvai-reader")) return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tagName) || element.hidden) return;
      if (tagName === "I" && element.hasAttribute("t")) {
        started = true;
        const source = String(element.getAttribute("t") || "").trim();
        const selectable = Boolean(source);
        pendingReferenceItems.push({
          kind: "token",
          node: element,
          source,
          convert: normalizeLine(element.textContent || ""),
          alternatives: String(element.getAttribute("v") || "")
            .split("/")
            .map((value) => normalizeLine(value))
            .filter(Boolean),
          hint: normalizeLine(element.getAttribute("h") || ""),
          partOfSpeech: String(element.getAttribute("p") || ""),
          isName: element.getAttribute("isname") === "true",
          selectable
        });
        return;
      }
      if (/^H[1-6]$/.test(tagName)) {
        if (started) flushText();
        for (const child of element.childNodes) visit(child);
        if (started) flushText();
        return;
      }
      if (!started) {
        for (const child of element.childNodes) visit(child);
        return;
      }
      if (tagName === "BR") {
        mergeContext(pendingReferenceItems, "\n", element);
        return;
      }
      if (
        element.matches(
          "a, img, picture, video, audio, svg, canvas, iframe, button, "
          + "[role='button'], [onclick], [onmousedown], [ontouchup]"
        )
        || element.classList.contains("btn")
      ) {
        flushText();
        nativeIndex += 1;
        const anchor = document.createComment(`stvai-native-${nativeIndex}`);
        if (options?.preserveNative !== false) element.after(anchor);
        blocks.push({
          id: `N${String(nativeIndex).padStart(4, "0")}`,
          kind: "native",
          node: element,
          anchor,
          inline: isInlineNativeElement(element)
        });
        return;
      }
      for (const child of element.childNodes) visit(child);
    }

    for (const child of container.childNodes) visit(child);
    flushText(true);

    const translatableBlocks = blocks.filter((block) => block.kind === "text");
    if (!translatableBlocks.length) {
      throw new ExtractionError("SOURCE_NOT_FOUND", "Chương không có đoạn tiếng Trung khả dụng.");
    }
    const sourceText = translatableBlocks.map((block) => block.text).join("\n\n");
    const ratio = cjkRatio(sourceText);
    if (ratio < (Number(config.minCjkRatio) || 0.15)) {
      throw new ExtractionError(
        "SOURCE_NOT_CHINESE",
        "Nguyên văn tìm được không đủ ký tự tiếng Trung để gửi dịch an toàn."
      );
    }

    return {
      container,
      chapterId: container.getAttribute("cid") || "",
      blocks,
      translatableBlocks,
      nameReferencesByBlock,
      sourceNodeBlockIds,
      sourceText,
      cjkRatio: ratio
    };
  }

  return Object.freeze({
    ExtractionError,
    isChapterPath,
    normalizeParagraph,
    normalizeSourceParagraph,
    cjkRatio,
    splitLongParagraph,
    extractChapter
  });
});
