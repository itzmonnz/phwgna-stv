(function attachNameEditor(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAINameEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNameEditorApi() {
  "use strict";

  const core = globalThis.STVAICore
    || (typeof require === "function" ? require("../shared/core.js") : null);

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const WORD_RE = /[\p{L}\p{N}]/u;

  function tokenizeSource(value) {
    const text = String(value || "");
    const tokens = [];
    let index = 0;
    while (index < text.length) {
      const character = String.fromCodePoint(text.codePointAt(index));
      const width = character.length;
      if (CJK_RE.test(character)) {
        tokens.push({ text: character, start: index, end: index + width });
        index += width;
        continue;
      }
      if (WORD_RE.test(character)) {
        const start = index;
        let content = character;
        index += width;
        while (index < text.length) {
          const next = String.fromCodePoint(text.codePointAt(index));
          if (!WORD_RE.test(next) || CJK_RE.test(next)) break;
          content += next;
          index += next.length;
        }
        tokens.push({ text: content, start, end: index });
        continue;
      }
      index += width;
    }
    return tokens;
  }

  function appendNameMapping(guide, source, target) {
    const left = String(source || "").trim();
    const right = String(target || "").trim();
    if (!left || !right || left.length > 80 || right.length > 200 || /[=\r\n]/.test(left + right)) {
      throw new TypeError("Name không hợp lệ.");
    }
    if (core?.mergeNameGuides) return core.mergeNameGuides(guide, `$${left}=${right}`).value;
    return `${String(guide || "").trim()}\n$${left}=${right}`.trim();
  }

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function brandIcon(document, className) {
    const branding = globalThis.STVAIBranding
      || (typeof require === "function" ? require("../shared/branding.js") : null);
    return branding.createIcon(document, className);
  }

  function createNameEditor(document, options = {}) {
    const root = element(document, "section", "stvai-name-editor");
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Bổ sung Name");

    const selectionView = element(document, "div", "stvai-name-step stvai-name-step--selection");
    const topbar = element(document, "div", "stvai-name-topbar");
    const chooserTitle = element(document, "strong", "stvai-name-chooser-title", "Chọn cụm từ");
    const chooserBrand = element(document, "div", "stvai-name-title-brand");
    chooserBrand.append(brandIcon(document, "stvai-brand-icon stvai-name-brand-icon"), chooserTitle);
    const cancel = element(document, "button", "stvai-name-cancel", "×");
    cancel.type = "button";
    cancel.setAttribute("aria-label", "Đóng bộ Name");
    const expandLeft = element(document, "button", "stvai-name-expand-left", "<<");
    const expandRight = element(document, "button", "stvai-name-expand-right", ">>");
    expandLeft.type = "button";
    expandRight.type = "button";
    expandLeft.setAttribute("aria-label", "Mở rộng sang trái");
    expandRight.setAttribute("aria-label", "Mở rộng sang phải");
    topbar.append(chooserBrand, expandLeft, expandRight, cancel);

    const tokenList = element(document, "div", "stvai-name-tokens");
    tokenList.setAttribute("aria-label", "Câu tiếng Trung");

    const quick = element(document, "div", "stvai-name-quick");
    quick.hidden = true;
    const sourceLabel = element(document, "label", "stvai-name-label stvai-name-source-label", "Từ gốc");
    const sourceInput = element(document, "input", "stvai-name-source");
    sourceInput.type = "text";
    sourceInput.readOnly = true;
    sourceLabel.append(sourceInput);
    const hanvietLabel = element(document, "label", "stvai-name-label", "Hán Việt");
    const hanvietInput = element(document, "input", "stvai-name-hanviet");
    hanvietInput.type = "text";
    hanvietInput.readOnly = true;
    hanvietLabel.append(hanvietInput);
    const targetLabel = element(document, "div", "stvai-name-label stvai-name-label--vietphrase");
    const targetLabelText = element(document, "span", "stvai-name-label-text", "Thuần Việt");
    const targetInput = element(document, "input", "stvai-name-target");
    targetInput.type = "text";
    targetInput.setAttribute("aria-label", "Thuần Việt");
    const quickVietphrase = element(document, "div", "stvai-name-vietphrase stvai-name-vietphrase--quick");
    quickVietphrase.setAttribute("aria-label", "Gợi ý Vietphrase từ STV");
    quickVietphrase.setAttribute("role", "listbox");
    quickVietphrase.hidden = true;
    const quickVietphraseToggle = element(document, "button", "stvai-name-vietphrase-toggle stvai-name-vietphrase-toggle--quick", "⌄");
    quickVietphraseToggle.type = "button";
    quickVietphraseToggle.hidden = true;
    quickVietphraseToggle.setAttribute("aria-label", "Mở gợi ý Thuần Việt");
    quickVietphraseToggle.setAttribute("aria-expanded", "false");
    quickVietphraseToggle.setAttribute("aria-haspopup", "listbox");
    const quickVietphraseInputRow = element(document, "div", "stvai-name-vietphrase-input-row");
    const quickVietphraseField = element(document, "div", "stvai-name-vietphrase-field");
    quickVietphraseInputRow.append(targetInput, quickVietphraseToggle);
    quickVietphraseField.append(quickVietphraseInputRow, quickVietphrase);
    targetLabel.append(targetLabelText, quickVietphraseField);

    const message = element(document, "span", "stvai-name-message");
    message.setAttribute("aria-live", "polite");
    const actions = element(document, "div", "stvai-name-actions");
    const save = element(document, "button", "stvai-name-save", "Lưu nhanh");
    save.type = "button";
    const addName = element(document, "button", "stvai-name-add", "Thêm Name");
    addName.type = "button";
    actions.append(message, save, addName);
    quick.append(sourceLabel, hanvietLabel, targetLabel, actions);
    selectionView.append(topbar, tokenList, quick);

    const compareView = element(document, "div", "stvai-name-step stvai-name-step--compare");
    compareView.hidden = true;
    const compareTopbar = element(document, "div", "stvai-name-compare-topbar");
    const back = element(document, "button", "stvai-name-back", "←");
    back.type = "button";
    back.setAttribute("aria-label", "Quay lại chọn cụm từ");
    const compareTitle = element(document, "strong", "stvai-name-title", "Chọn cách dịch Name");
    const compareBrand = element(document, "div", "stvai-name-title-brand stvai-name-title-brand--compare");
    compareBrand.append(brandIcon(document, "stvai-brand-icon stvai-name-compare-brand-icon"), compareTitle);
    const compareCancel = element(document, "button", "stvai-name-cancel stvai-name-cancel--compare", "×");
    compareCancel.type = "button";
    compareCancel.setAttribute("aria-label", "Đóng bộ Name");
    compareTopbar.append(back, compareBrand, compareCancel);
    const positionController = options.attachDraggable?.(root, [topbar, compareTopbar]);

    const candidateList = element(document, "div", "stvai-name-candidates");
    const candidateInputs = Object.create(null);
    const candidateButtons = Object.create(null);
    const compareVietphrase = element(document, "div", "stvai-name-vietphrase stvai-name-vietphrase--compare");
    compareVietphrase.setAttribute("aria-label", "Gợi ý Vietphrase từ STV");
    compareVietphrase.setAttribute("role", "listbox");
    compareVietphrase.hidden = true;
    const compareVietphraseToggle = element(document, "button", "stvai-name-vietphrase-toggle stvai-name-vietphrase-toggle--compare", "⌄");
    compareVietphraseToggle.type = "button";
    compareVietphraseToggle.hidden = true;
    compareVietphraseToggle.setAttribute("aria-label", "Mở gợi ý Tiếng Việt");
    compareVietphraseToggle.setAttribute("aria-expanded", "false");
    compareVietphraseToggle.setAttribute("aria-haspopup", "listbox");
    let japaneseLookup = null;
    let romajiSuggestions = null;
    let finalChoiceLocked = false;
    const candidateDefinitions = [
      ["source", "Tiếng Trung"],
      ["hanviet", "Hán Việt"],
      ["english", "Tiếng Anh"],
      ["romaji", "Tên Nhật / Romaji"],
      ["vietnamese", "Tiếng Việt"]
    ];
    for (const [kind, labelText] of candidateDefinitions) {
      const row = element(document, "div", "stvai-name-candidate");
      row.dataset.kind = kind;
      const label = element(document, "span", "stvai-name-candidate-label", labelText);
      const input = element(document, "input", "stvai-name-candidate-input");
      input.type = "text";
      input.readOnly = true;
      const use = element(document, "button", "stvai-name-use", "Dùng");
      use.type = "button";
      use.addEventListener("click", () => {
        if (input.value) {
          finalInput.value = input.value;
          finalChoiceLocked = true;
        }
        finalSave.disabled = !selectedSource() || !finalInput.value.trim();
      });
      candidateInputs[kind] = input;
      candidateButtons[kind] = use;
      if (kind === "vietnamese") {
        const field = element(document, "div", "stvai-name-vietphrase-field");
        const inputRow = element(document, "div", "stvai-name-vietphrase-input-row");
        inputRow.append(input, compareVietphraseToggle);
        field.append(inputRow, compareVietphrase);
        row.append(label, field, use);
      } else {
        row.append(label, input, use);
      }
      if (kind === "romaji") {
        japaneseLookup = element(document, "button", "stvai-name-japanese-lookup", "Tra tên Nhật");
        japaneseLookup.type = "button";
        japaneseLookup.disabled = typeof options.onJapaneseLookup !== "function";
        romajiSuggestions = element(document, "div", "stvai-name-romaji-suggestions");
        romajiSuggestions.setAttribute("aria-label", "Các tên Nhật tìm thấy");
        row.append(japaneseLookup, romajiSuggestions);
      }
      candidateList.append(row);
    }
    const finalLabel = element(document, "label", "stvai-name-final-label", "Tên sẽ lưu");
    const finalInput = element(document, "input", "stvai-name-final");
    finalInput.type = "text";
    finalLabel.append(finalInput);
    const compareActions = element(document, "div", "stvai-name-actions stvai-name-actions--compare");
    const compareMessage = element(document, "span", "stvai-name-message stvai-name-compare-message");
    compareMessage.setAttribute("aria-live", "polite");
    const finalSave = element(document, "button", "stvai-name-final-save", "Lưu vào bộ Name");
    finalSave.type = "button";
    compareActions.append(compareMessage, finalSave);
    compareView.append(compareTopbar, candidateList, finalLabel, compareActions);
    root.append(selectionView, compareView);
    document.body.append(root);

    function setVietphraseOpen(toggle, list, open) {
      const nextOpen = Boolean(open && !toggle.hidden && list.childElementCount);
      list.hidden = !nextOpen;
      toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      toggle.textContent = nextOpen ? "⌃" : "⌄";
    }

    function bindVietphraseDisclosure(toggle, list, input) {
      toggle.addEventListener("click", () => {
        setVietphraseOpen(toggle, list, toggle.getAttribute("aria-expanded") !== "true");
      });
      input.addEventListener("click", () => {
        if (!toggle.hidden) setVietphraseOpen(toggle, list, true);
      });
    }

    bindVietphraseDisclosure(quickVietphraseToggle, quickVietphrase, targetInput);
    bindVietphraseDisclosure(compareVietphraseToggle, compareVietphrase, candidateInputs.vietnamese);

    let reader = null;
    let paragraph = null;
    let paragraphText = "";
    let blockId = "";
    let references = [];
    let sourceTokens = [];
    let start = -1;
    let end = -1;
    let saving = false;
    let editorSession = 0;
    let pendingSave = Promise.resolve();
    let pendingPreview = Promise.resolve();
    let pendingOpen = Promise.resolve();
    let pendingJapaneseLookup = Promise.resolve();
    let previewTimer = null;
    let resolveScheduledPreview = null;
    let previewRequest = 0;
    let japaneseLookupRequest = 0;
    let previewState = { source: "", hanviet: "", english: "", romaji: "", vietnamese: "" };
    let pendingTap = null;
    let pointerGesture = null;
    let lastOpened = null;
    let openingNode = null;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const tapTimeoutMs = Math.max(1, Number(options.tapTimeoutMs) || 500);
    const tapDistancePx = Math.max(1, Number(options.tapDistancePx) || 32);
    const moveThresholdPx = Math.max(1, Number(options.moveThresholdPx) || 12);
    const interactiveSelector = "a,button,input,textarea,select,label,img,video,audio,iframe,[role='button'],[contenteditable='true']";

    function selectedSource() {
      if (start < 0 || end < start) return "";
      return sourceTokens.slice(start, end + 1).map((token) => token.source).join("").trim();
    }

    function selectedTokenValue(field) {
      if (start < 0 || end < start) return "";
      return sourceTokens.slice(start, end + 1)
        .map((token) => String(token[field] || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .trim();
    }

    function selectedHanViet() {
      if (start < 0 || end < start) return "";
      const selected = sourceTokens.slice(start, end + 1);
      if (selected.some((token) => !String(token.hint || "").trim())) return "";
      return selectedTokenValue("hint");
    }

    function selectedVietphraseAlternatives() {
      if (start < 0 || end < start) return [];
      const selected = sourceTokens.slice(start, end + 1);
      const base = selected.map((token) => String(token.convert || "").trim());
      const values = [];
      const add = (parts) => {
        const value = parts.filter(Boolean).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
        if (value && value.length <= 200 && !values.includes(value)) values.push(value);
      };
      add(base);
      for (let tokenIndex = 0; tokenIndex < selected.length && values.length < 12; tokenIndex += 1) {
        const alternatives = Array.isArray(selected[tokenIndex].alternatives)
          ? selected[tokenIndex].alternatives
          : [];
        for (const rawAlternative of alternatives) {
          const alternative = String(rawAlternative || "").replace(/\s+/g, " ").trim();
          if (!alternative) continue;
          const parts = base.slice();
          parts[tokenIndex] = alternative;
          add(parts);
          if (values.length >= 12) break;
        }
      }
      return values;
    }

    function renderVietphraseSuggestions() {
      const alternatives = selectedVietphraseAlternatives();
      const makeButton = (value, onChoose) => {
        const button = element(document, "button", "stvai-name-vietphrase-suggestion", value);
        button.type = "button";
        button.setAttribute("role", "option");
        button.addEventListener("click", () => onChoose(value));
        return button;
      };
      quickVietphrase.replaceChildren(...alternatives.map((value) => makeButton(value, (choice) => {
        targetInput.value = choice;
        save.disabled = !sourceInput.value || !choice;
        addName.disabled = save.disabled;
        setVietphraseOpen(quickVietphraseToggle, quickVietphrase, false);
      })));
      compareVietphrase.replaceChildren(...alternatives.map((value) => makeButton(value, (choice) => {
        previewState.vietnamese = choice;
        candidateInputs.vietnamese.value = choice;
        candidateButtons.vietnamese.disabled = false;
        finalInput.value = choice;
        finalChoiceLocked = true;
        finalSave.disabled = !selectedSource() || !choice;
        setVietphraseOpen(compareVietphraseToggle, compareVietphrase, false);
      })));
      const available = alternatives.length >= 2;
      quickVietphraseToggle.hidden = !available;
      compareVietphraseToggle.hidden = !available;
      quickVietphraseToggle.disabled = !available;
      compareVietphraseToggle.disabled = !available;
      setVietphraseOpen(quickVietphraseToggle, quickVietphrase, false);
      setVietphraseOpen(compareVietphraseToggle, compareVietphrase, false);
    }

    function updateCandidateInputs() {
      const values = {
        source: previewState.source,
        hanviet: previewState.hanviet,
        english: previewState.english,
        romaji: previewState.romaji,
        vietnamese: previewState.vietnamese
      };
      for (const [kind, value] of Object.entries(values)) {
        candidateInputs[kind].value = value;
        candidateButtons[kind].disabled = !value;
      }
    }

    function clearRomajiSuggestions() {
      japaneseLookupRequest += 1;
      romajiSuggestions?.replaceChildren();
      if (japaneseLookup) {
        japaneseLookup.textContent = "Tra tên Nhật";
        japaneseLookup.disabled = typeof options.onJapaneseLookup !== "function";
      }
    }

    function renderRomajiSuggestions(candidates) {
      if (!romajiSuggestions) return;
      romajiSuggestions.replaceChildren(...candidates.map((candidate) => {
        const button = element(document, "button", "stvai-name-romaji-suggestion", candidate);
        button.type = "button";
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          previewState.romaji = candidate;
          candidateInputs.romaji.value = candidate;
          candidateButtons.romaji.disabled = false;
          finalInput.value = candidate;
          finalChoiceLocked = true;
          finalSave.disabled = !selectedSource() || !candidate;
          Array.from(romajiSuggestions.children).forEach((item) => {
            item.setAttribute("aria-pressed", item === button ? "true" : "false");
          });
        });
        return button;
      }));
    }

    function cancelScheduledPreview() {
      if (previewTimer != null) clearTimeout(previewTimer);
      previewTimer = null;
      resolveScheduledPreview?.();
      resolveScheduledPreview = null;
    }

    function updateLocalPreview() {
      cancelScheduledPreview();
      clearRomajiSuggestions();
      const source = selectedSource();
      const convert = selectedTokenValue("convert");
      previewRequest += 1;
      const requestId = previewRequest;
      previewState = {
        source,
        hanviet: selectedHanViet(),
        english: "",
        romaji: String(options.romajiForSource?.(source) || "").trim(),
        vietnamese: convert
      };
      finalChoiceLocked = false;
      targetInput.value = convert;
      hanvietInput.value = previewState.hanviet;
      updateCandidateInputs();
      renderVietphraseSuggestions();
      quick.hidden = start < 0;
      if (!source) {
        message.textContent = start >= 0
          ? "Cụm này do STV chèn, không có chữ Trung. Hãy mở rộng sang từ bên cạnh."
          : "Chọn cụm nguồn trong câu Convert.";
        pendingPreview = Promise.resolve();
        return;
      }
      message.textContent = "";
      pendingPreview = Promise.resolve();
    }

    function requestRemotePreview() {
      cancelScheduledPreview();
      const source = selectedSource();
      const requestId = ++previewRequest;
      if (typeof options.onPreview !== "function") {
        pendingPreview = Promise.resolve();
        return;
      }
      message.textContent = "Đang dịch nhanh…";
      pendingPreview = new Promise((resolve) => {
        resolveScheduledPreview = resolve;
        previewTimer = setTimeout(async () => {
          previewTimer = null;
          resolveScheduledPreview = null;
          try {
            const remote = await options.onPreview({ source, requestId: `name-${requestId}` });
            if (requestId !== previewRequest || selectedSource() !== source) return;
            if (typeof remote?.en === "string") previewState.english = remote.en.trim();
            updateCandidateInputs();
            message.textContent = remote?.en
              ? "Đã có gợi ý dịch."
              : "Không kết nối được dịch vụ; đang dùng bản Convert.";
          } catch (_error) {
            if (requestId === previewRequest) {
              message.textContent = "Không kết nối được dịch vụ; đang dùng bản Convert.";
            }
          } finally {
            resolve();
          }
        }, Math.max(0, Number(options.previewDelayMs ?? 200)));
      });
    }

    function selectableIndex(from, direction) {
      for (let index = from + direction; index >= 0 && index < sourceTokens.length; index += direction) {
        if (sourceTokens[index].selectable) return index;
      }
      return -1;
    }

    function refreshSelection() {
      sourceInput.value = selectedSource();
      Array.from(tokenList.querySelectorAll(".stvai-name-token")).forEach((button) => {
        const index = Number(button.dataset.tokenIndex);
        const selected = start >= 0 && index >= start && index <= end;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      expandLeft.disabled = start < 0 || selectableIndex(start, -1) < 0;
      expandRight.disabled = end < 0 || selectableIndex(end, 1) < 0;
      save.disabled = !sourceInput.value || !targetInput.value.trim();
      addName.disabled = save.disabled;
    }

    function selectionChanged() {
      updateLocalPreview();
      refreshSelection();
    }

    function choose(index) {
      start = index;
      end = index;
      selectionChanged();
    }

    function open(event, nextParagraph) {
      close(false);
      paragraph = nextParagraph;
      paragraphText = paragraph.textContent || "";
      blockId = paragraph.dataset.blockId || "";
      const blockData = options.blockDataForBlock?.(blockId) || {};
      references = Array.isArray(blockData.references)
        ? blockData.references.map((item) => ({ ...item }))
        : [];
      sourceTokens = references.filter((item) => item.kind === "token").map((item) => ({
        ...item,
        source: String(item.source || ""),
        selectable: item.selectable !== false && Boolean(String(item.source || "").trim())
      }));
      start = -1;
      end = -1;
      targetInput.value = "";
      hanvietInput.value = "";
      quick.hidden = true;
      saving = false;
      previewRequest += 1;
      cancelScheduledPreview();
      selectionView.hidden = false;
      compareView.hidden = true;
      root.dataset.step = "selection";
      delete root.dataset.match;
      message.textContent = sourceTokens.some((token) => token.selectable)
        ? "Chọn cụm nguồn trong câu Convert."
        : "Không có cụm nguồn STV để chọn.";
      let tokenIndex = 0;
      tokenList.replaceChildren(...references.map((item) => {
        if (item.kind === "context") {
          return element(document, "span", "stvai-name-context", item.text);
        }
        const index = tokenIndex;
        tokenIndex += 1;
        const label = String(item.convert || item.alternatives?.[0] || item.hint || item.source || "");
        const button = element(document, "button", "stvai-name-token", label);
        button.type = "button";
        button.dataset.tokenIndex = String(index);
        button.setAttribute("aria-pressed", "false");
        button.dataset.hasSource = sourceTokens[index]?.selectable ? "true" : "false";
        button.disabled = !label.trim() || !sourceTokens[index]?.selectable;
        if (!button.disabled) button.addEventListener("click", () => choose(index));
        return button;
      }));
      root.hidden = false;
      refreshSelection();
      const viewportWidth = document.defaultView?.innerWidth || 1024;
      const viewportHeight = document.defaultView?.innerHeight || 768;
      const anchorX = Number(event.clientX) || Math.round(viewportWidth / 2);
      const anchorY = Number(event.clientY) || Math.round(viewportHeight / 2);
      const panelWidth = Math.min(520, viewportWidth - 24);
      const left = Math.max(12, Math.min(anchorX + 12, viewportWidth - panelWidth - 12));
      root.style.width = `${panelWidth}px`;
      if (root.dataset.savedPosition !== "true") {
        root.style.left = `${left}px`;
        const panelHeight = Math.min(520, viewportHeight - 24);
        root.style.top = `${Math.max(12, Math.min(anchorY + 12, viewportHeight - panelHeight - 12))}px`;
      }
      positionController?.refresh?.();
    }

    function resetTap() {
      pendingTap = null;
      pointerGesture = null;
    }

    function blockFromEvent(event) {
      if (event.target?.closest?.(interactiveSelector)) return null;
      const nextParagraph = event.target?.closest?.("[data-block-id]");
      if (!nextParagraph || !reader?.contains(nextParagraph)) return null;
      if (nextParagraph.dataset.translationOrigin === "convert"
        || nextParagraph.classList.contains("stvai-reader-paragraph--pending")) return null;
      if (options.isBlockEligible && options.isBlockEligible(nextParagraph) !== true) return null;
      return nextParagraph;
    }

    function requestOpen(event, nextParagraph) {
      const proceed = () => {
        if (!reader?.contains(nextParagraph)) return false;
        open(event, nextParagraph);
        lastOpened = { node: nextParagraph, at: now() };
        return true;
      };
      if (typeof options.onBeforeOpen !== "function") return proceed();
      if (openingNode) return false;
      let permission;
      try { permission = options.onBeforeOpen({ blockId: nextParagraph.dataset.blockId || "", node: nextParagraph }); }
      catch (_error) { return false; }
      if (!permission || typeof permission.then !== "function") {
        return permission === false ? false : proceed();
      }
      openingNode = nextParagraph;
      pendingOpen = pendingOpen.then(async () => {
        let allowed = false;
        try { allowed = await permission; } catch (_error) { allowed = false; }
        if (allowed !== false) proceed();
      }).finally(() => {
        if (openingNode === nextParagraph) openingNode = null;
      });
      return true;
    }

    function point(event) {
      return { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
    }

    function pointerDown(event) {
      if (event.button != null && event.button !== 0) return;
      const node = blockFromEvent(event);
      if (!node) return;
      const value = point(event);
      pointerGesture = { node, ...value, moved: false };
    }

    function pointerMove(event) {
      if (!pointerGesture) return;
      const value = point(event);
      if (Math.hypot(value.x - pointerGesture.x, value.y - pointerGesture.y) > moveThresholdPx) {
        pointerGesture.moved = true;
        pendingTap = null;
      }
    }

    function click(event) {
      const node = blockFromEvent(event);
      if (!node) { resetTap(); return; }
      if (pointerGesture && (pointerGesture.node !== node || pointerGesture.moved)) {
        resetTap();
        return;
      }
      pointerGesture = null;
      const value = { node, at: now(), ...point(event) };
      const previous = pendingTap;
      const matches = previous && previous.node === node
        && value.at - previous.at <= tapTimeoutMs
        && Math.hypot(value.x - previous.x, value.y - previous.y) <= tapDistancePx;
      pendingTap = matches ? null : value;
      if (!matches) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestOpen(event, node);
    }

    function doubleClick(event) {
      const node = blockFromEvent(event);
      if (!node) return;
      if (openingNode) return;
      if (lastOpened?.node === node && now() - lastOpened.at <= 100) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingTap = null;
      requestOpen(event, node);
    }

    function scroll() { resetTap(); }

    function close(notify = true) {
      const wasOpen = !root.hidden;
      editorSession += 1;
      previewRequest += 1;
      clearRomajiSuggestions();
      cancelScheduledPreview();
      paragraph = null;
      paragraphText = "";
      root.hidden = true;
      if (wasOpen && notify) options.onClose?.();
    }

    function bind(nextReader) {
      if (reader !== (nextReader || null)) close(false);
      if (reader) {
        reader.removeEventListener("pointerdown", pointerDown, true);
        reader.removeEventListener("pointermove", pointerMove, true);
        reader.removeEventListener("pointercancel", resetTap, true);
        reader.removeEventListener("click", click, true);
        reader.removeEventListener("dblclick", doubleClick, true);
      }
      document.defaultView?.removeEventListener?.("scroll", scroll, true);
      resetTap();
      reader = nextReader || null;
      if (reader) {
        reader.addEventListener("pointerdown", pointerDown, true);
        reader.addEventListener("pointermove", pointerMove, true);
        reader.addEventListener("pointercancel", resetTap, true);
        reader.addEventListener("click", click, true);
        reader.addEventListener("dblclick", doubleClick, true);
        document.defaultView?.addEventListener?.("scroll", scroll, true);
      }
    }

    expandLeft.addEventListener("click", () => {
      const next = selectableIndex(start, -1);
      if (next >= 0) start = next;
      selectionChanged();
    });
    expandRight.addEventListener("click", () => {
      const next = selectableIndex(end, 1);
      if (next >= 0) end = next;
      selectionChanged();
    });
    targetInput.addEventListener("input", () => {
      save.disabled = !sourceInput.value || !targetInput.value.trim();
      addName.disabled = save.disabled;
    });
    cancel.addEventListener("click", close);
    compareCancel.addEventListener("click", close);
    back.addEventListener("click", () => {
      compareView.hidden = true;
      selectionView.hidden = false;
      root.dataset.step = "selection";
      save.focus();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    function persist(target, statusNode, button) {
      const source = selectedSource();
      const normalizedTarget = target.trim();
      if (saving || !source || !normalizedTarget) return;
      const saveSession = editorSession;
      const mapping = { source, target: normalizedTarget, blockId };
      saving = true;
      button.disabled = true;
      pendingSave = pendingSave.then(async () => {
        if (saveSession === editorSession) statusNode.textContent = "Đang lưu…";
        try {
          appendNameMapping("", mapping.source, mapping.target);
          await options.onSave?.(mapping);
          if (saveSession === editorSession) close();
        } catch (error) {
          if (saveSession !== editorSession) return;
          saving = false;
          statusNode.textContent = error?.message || "Không lưu được Name.";
          button.disabled = !selectedSource() || !normalizedTarget;
        }
      });
    }
    save.addEventListener("click", () => persist(targetInput.value, message, save));
    addName.addEventListener("click", () => {
      if (!selectedSource() || !targetInput.value.trim()) return;
      previewState.vietnamese = targetInput.value.trim();
      updateCandidateInputs();
      finalInput.value = previewState.vietnamese;
      finalChoiceLocked = false;
      finalSave.disabled = false;
      selectionView.hidden = true;
      compareView.hidden = false;
      root.dataset.step = "compare";
      compareMessage.textContent = previewState.romaji
        ? "Chọn một gợi ý hoặc tự sửa."
        : "Nếu đây là tên Nhật, bấm Tra tên Nhật để tìm cách viết Romaji.";
      finalInput.focus();
      requestRemotePreview();
    });
    japaneseLookup?.addEventListener("click", () => {
      const source = selectedSource();
      if (!source || typeof options.onJapaneseLookup !== "function") return;
      japaneseLookupRequest += 1;
      const lookupId = japaneseLookupRequest;
      japaneseLookup.disabled = true;
      japaneseLookup.textContent = "Đang tra…";
      compareMessage.textContent = "Đang tra tên Nhật từ cụm tiếng Trung…";
      pendingJapaneseLookup = Promise.resolve(options.onJapaneseLookup({
        source,
        disallowedCandidate: previewState.english,
        requestId: `japanese-${lookupId}`
      })).then((result) => {
        if (lookupId !== japaneseLookupRequest || selectedSource() !== source) return;
        const candidates = Array.from(new Set((Array.isArray(result?.candidates) ? result.candidates : [])
          .map((value) => String(value || "").replace(/\s+/g, " ").trim())
          .filter((value) => value && value.length <= 120)));
        renderRomajiSuggestions(candidates);
        if (candidates.length) {
          previewState.romaji = candidates[0];
          candidateInputs.romaji.value = candidates[0];
          candidateButtons.romaji.disabled = false;
          if (!finalChoiceLocked) finalInput.value = candidates[0];
          compareMessage.textContent = "AI đã trả Romaji. Hãy kiểm tra rồi chọn kết quả phù hợp.";
        } else {
          compareMessage.textContent = "Không tìm thấy tên Nhật. Hãy nhập tay hoặc chọn gợi ý khác.";
        }
      }).catch((error) => {
        if (lookupId === japaneseLookupRequest) {
          const tabCount = Math.min(5, Math.max(2, Math.trunc(Number(error?.tabCount)) || 2));
          compareMessage.textContent = error?.message === "lookup-provider-busy"
            ? `${tabCount} tab AI đang bận — hãy tra lại sau.`
            : "Không kết nối được dịch vụ tra tên Nhật.";
        }
      }).finally(() => {
        if (lookupId === japaneseLookupRequest) {
          japaneseLookup.disabled = false;
          japaneseLookup.textContent = "Tra lại tên Nhật";
        }
      });
    });
    finalInput.addEventListener("input", () => {
      finalChoiceLocked = true;
      finalSave.disabled = !selectedSource() || !finalInput.value.trim();
    });
    finalSave.addEventListener("click", () => persist(finalInput.value, compareMessage, finalSave));

    return {
      root,
      bind,
      close,
      async whenIdle() {
        await pendingPreview;
        await pendingOpen;
        await pendingJapaneseLookup;
        await pendingSave;
      },
      destroy() {
        close(false);
        bind(null);
        positionController?.destroy?.();
        root.remove();
      },
      refreshPosition() { return positionController?.refresh?.(); }
    };
  }

  return Object.freeze({ tokenizeSource, appendNameMapping, createNameEditor });
});
