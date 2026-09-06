(function attachNameManager(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.STVAINameManager = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNameManagerApi() {
  "use strict";

  function element(document, tag, className, text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function brandIcon(document, className) {
    const branding = globalThis.STVAIBranding
      || (typeof require === "function" ? require("../shared/branding.js") : null);
    return branding.createIcon(document, className);
  }

  function parseNameGuide(value) {
    const rows = [];
    for (const line of String(value || "").split(/\r?\n/)) {
      const match = line.trim().match(/^\$([^=\r\n]{1,200})=([^\r\n]{1,300})$/u);
      if (match) rows.push({ source: match[1].trim(), target: match[2].trim() });
    }
    return rows;
  }

  function serializeRows(rows) {
    return rows.map(({ source, target }) => `$${source.trim()}=${target.trim()}`).join("\n");
  }

  const VIETNAMESE_SORTER = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
  function firstSortWord(value) {
    return String(value || "").trim().split(/\s+/u, 1)[0] || "";
  }
  function sortRowsByTranslatedName(rows) {
    return rows.map((row, index) => ({ ...row, index })).sort((left, right) => (
      VIETNAMESE_SORTER.compare(firstSortWord(left.target), firstSortWord(right.target))
      || VIETNAMESE_SORTER.compare(String(left.target || ""), String(right.target || ""))
      || left.index - right.index
    ));
  }

  function attachDraggable(root, handle, options = {}) {
    const handles = (Array.isArray(handle) ? handle : [handle]).filter(Boolean);
    const interactiveHandles = new Set(options.interactiveHandles || []);
    const dragThreshold = Math.max(0, Number(options.dragThreshold) || 4);
    const storageKey = options.storageKey || "stvai-panel-position";
    const requestedMargin = Number(options.margin);
    const margin = Number.isFinite(requestedMargin) ? Math.max(0, requestedMargin) : 12;
    let storage = options.storage;
    let disposed = false;
    if (!storage) {
      try { storage = root.ownerDocument.defaultView?.localStorage; } catch (_error) { storage = null; }
    }
    const legacySaved = (() => {
      try { return JSON.parse(storage?.getItem(storageKey) || "null"); } catch (_error) { return null; }
    })();
    const normalized = value => typeof value?.x === "number" && typeof value?.y === "number"
      && Number.isFinite(value.x) && Number.isFinite(value.y)
      ? { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) }
      : null;
    let position = normalized(options.initialPosition);
    const viewport = () => {
      const view = root.ownerDocument.defaultView;
      const visual = view?.visualViewport;
      return {
        left: Math.max(0, Number(visual?.offsetLeft) || 0),
        top: Math.max(0, Number(visual?.offsetTop) || 0),
        width: Math.max(1, Number(visual?.width) || Number(view?.innerWidth) || 1),
        height: Math.max(1, Number(visual?.height) || Number(view?.innerHeight) || 1)
      };
    };
    const currentScale = () => Math.max(0.5, Math.min(1.5, Number(options.getScale?.()) || 1));
    const measure = (area = viewport(), scale = currentScale()) => {
      const rect = root.getBoundingClientRect();
      const width = rect.width || 320;
      const height = rect.height || 240;
      const minLeft = area.left + margin;
      const minTop = area.top + margin;
      return {
        area,
        rect,
        scale,
        width,
        height,
        minLeft,
        minTop,
        maxLeft: Math.max(minLeft, area.left + area.width - width - margin),
        maxTop: Math.max(minTop, area.top + area.height - height - margin)
      };
    };
    const clamp = (left, top, measured = measure()) => {
      return {
        left: Math.max(measured.minLeft, Math.min(left, measured.maxLeft)),
        top: Math.max(measured.minTop, Math.min(top, measured.maxTop))
      };
    };
    const place = (left, top, measured = null) => {
      const value = clamp(left, top, measured || measure());
      root.style.transform = "none";
      const scale = measured?.scale || currentScale();
      root.style.left = `${value.left / scale}px`;
      root.style.top = `${value.top / scale}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
      return value;
    };
    const fromPixels = (value, measured = measure()) => {
      return {
        x: Math.max(0, Math.min(1, (value.left - measured.minLeft) / Math.max(1, measured.maxLeft - measured.minLeft))),
        y: Math.max(0, Math.min(1, (value.top - measured.minTop) / Math.max(1, measured.maxTop - measured.minTop)))
      };
    };
    const refresh = () => {
      if (disposed) return null;
      if (root.hidden || options.isAnimating?.()) return null;
      const area = viewport();
      const scale = currentScale();
      root.style.maxWidth = `${Math.max(1, (area.width - margin * 2) / scale)}px`;
      root.style.maxHeight = `${Math.max(1, (area.height - margin * 2) / scale)}px`;
      const measured = measure(area, scale);
      if (position) {
        return place(
          measured.minLeft + position.x * (measured.maxLeft - measured.minLeft),
          measured.minTop + position.y * (measured.maxTop - measured.minTop),
          measured
        );
      }
      return place(measured.rect.left, measured.rect.top, measured);
    };
    if (position) {
      root.dataset.savedPosition = "true";
      refresh();
    } else if (legacySaved && Number.isFinite(legacySaved.left) && Number.isFinite(legacySaved.top)) {
      root.dataset.savedPosition = "true";
      const measured = measure();
      const placed = place(legacySaved.left, legacySaved.top, measured);
      position = fromPixels(placed, measured);
      options.onPositionChange?.(position);
    }
    let drag = null;
    let suppressClickHandle = null;
    let suppressClickUntil = 0;
    const handleCleanups = [];
    for (const currentHandle of handles) {
      const previousTouchAction = currentHandle.style.touchAction;
      currentHandle.style.touchAction = "none";
      const pointerDown = (event) => {
        if (disposed) return;
        if (event.button != null && event.button !== 0) return;
        const interactiveTarget = event.target?.closest?.("button,input,textarea,select,a");
        if (interactiveTarget && !interactiveHandles.has(currentHandle)) return;
        options.onInteraction?.();
        const measured = measure();
        const rect = measured.rect;
        drag = {
          handle: currentHandle,
          id: event.pointerId,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          measured,
          placed: null
        };
        currentHandle.setPointerCapture?.(event.pointerId);
      };
      const pointerMove = (event) => {
        if (disposed) return;
        if (!drag || drag.handle !== currentHandle || drag.id !== event.pointerId) return;
        if (!drag.moved) {
          const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
          if (distance < dragThreshold) return;
          drag.moved = true;
        }
        drag.placed = place(event.clientX - drag.dx, event.clientY - drag.dy, drag.measured);
      };
      const finish = (event) => {
        if (disposed) return;
        if (!drag || drag.handle !== currentHandle || drag.id !== event.pointerId) return;
        if (drag.moved) {
          const measured = measure();
          const value = place(drag.placed?.left, drag.placed?.top, measured);
          position = fromPixels(value, measured);
          try { storage?.setItem(storageKey, JSON.stringify(value)); } catch (_error) { /* legacy preference only */ }
          options.onPositionChange?.(position);
          suppressClickHandle = currentHandle;
          suppressClickUntil = Date.now() + 400;
        }
        drag = null;
      };
      currentHandle.addEventListener("pointerdown", pointerDown);
      currentHandle.addEventListener("pointermove", pointerMove);
      currentHandle.addEventListener("pointerup", finish);
      currentHandle.addEventListener("pointercancel", finish);
      let suppressMovedClick = null;
      if (interactiveHandles.has(currentHandle)) {
        suppressMovedClick = event => {
          if (suppressClickHandle !== currentHandle || Date.now() > suppressClickUntil) return;
          suppressClickHandle = null;
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        currentHandle.addEventListener("click", suppressMovedClick, true);
      }
      handleCleanups.push(() => {
        currentHandle.removeEventListener("pointerdown", pointerDown);
        currentHandle.removeEventListener("pointermove", pointerMove);
        currentHandle.removeEventListener("pointerup", finish);
        currentHandle.removeEventListener("pointercancel", finish);
        if (suppressMovedClick) currentHandle.removeEventListener("click", suppressMovedClick, true);
        currentHandle.style.touchAction = previousTouchAction;
      });
    }
    const view = root.ownerDocument.defaultView;
    let frame = 0;
    let frameKind = "";
    const scheduleRefresh = () => {
      if (disposed || frame) return;
      const run = () => {
        frame = 0;
        frameKind = "";
        if (!disposed) refresh();
      };
      if (view?.requestAnimationFrame) {
        frame = view.requestAnimationFrame(run);
        frameKind = "animation";
      } else if (view?.setTimeout) {
        frame = view.setTimeout(run, 0);
        frameKind = "timeout";
      }
    };
    const viewportRefresh = () => { options.onInteraction?.(); scheduleRefresh(); };
    view?.addEventListener?.("resize", viewportRefresh);
    view?.visualViewport?.addEventListener?.("resize", viewportRefresh);
    const Observer = view?.ResizeObserver;
    const observer = Observer ? new Observer(scheduleRefresh) : null;
    observer?.observe?.(root);
    return {
      clamp: refresh,
      refresh,
      anchorTo(anchor, icon) {
        if (disposed) return null;
        const measured = measure();
        const rect = icon.getBoundingClientRect();
        const placed = place(
          measured.rect.left + anchor.x - (rect.left + rect.width / 2),
          measured.rect.top + anchor.y - (rect.top + rect.height / 2),
          measured
        );
        // Rebase the existing normalized position after a deliberate layout change.
        position = fromPixels(placed, measured);
        options.onPositionChange?.(position);
        return placed;
      },
      setUiScale(value) {
        if (disposed) return;
        options.onInteraction?.();
        root.style.zoom = String(Math.max(0.5, Math.min(1.5, Number(value) || 1)));
        scheduleRefresh();
      },
      destroy() {
        if (disposed) return;
        disposed = true;
        if (drag) {
          try { drag.handle.releasePointerCapture?.(drag.id); } catch (_error) { /* capture may already be gone */ }
          drag = null;
        }
        if (frame) {
          if (frameKind === "animation") view?.cancelAnimationFrame?.(frame);
          else if (frameKind === "timeout") view?.clearTimeout?.(frame);
          frame = 0;
          frameKind = "";
        }
        for (const cleanup of handleCleanups) cleanup();
        observer?.disconnect?.();
        view?.removeEventListener?.("resize", viewportRefresh);
        view?.visualViewport?.removeEventListener?.("resize", viewportRefresh);
      }
    };
  }

  function createNameManager(document, options = {}) {
    const root = element(document, "section", "stvai-name-manager");
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    const topbar = element(document, "header", "stvai-name-manager-topbar");
    const title = element(document, "strong", "stvai-name-manager-title", "Bộ Name");
    const titleBrand = element(document, "div", "stvai-name-manager-title-brand");
    titleBrand.append(brandIcon(document, "stvai-brand-icon stvai-name-manager-brand-icon"), title);
    const close = element(document, "button", "stvai-name-manager-close", "×");
    close.type = "button";
    topbar.append(titleBrand, close);
    const search = element(document, "input", "stvai-name-manager-search");
    search.type = "search";
    search.placeholder = "Tìm tiếng Trung hoặc tiếng Việt";
    const list = element(document, "div", "stvai-name-manager-list");
    const message = element(document, "p", "stvai-name-manager-message");
    const actions = element(document, "div", "stvai-name-manager-actions");
    const add = element(document, "button", "stvai-name-manager-add", "+ Thêm");
    const save = element(document, "button", "stvai-name-manager-save", "Lưu bộ Name");
    add.type = save.type = "button";
    actions.append(add, save);
    root.append(topbar, search, list, message, actions);
    const positionController = (options.attachDraggable || attachDraggable)(root, topbar, {
      storage: options.positionStorage,
      storageKey: "stvai-name-manager-position"
    });
    let pending = Promise.resolve();
    let saving = false;

    function setRowLocked(row, locked) {
      row.dataset.locked = locked ? "true" : "false";
      for (const input of row.querySelectorAll("input")) {
        input.readOnly = locked;
        input.setAttribute("aria-readonly", locked ? "true" : "false");
      }
    }

    function setSaving(value) {
      saving = Boolean(value);
      add.disabled = saving;
      save.disabled = saving;
      close.disabled = saving;
      for (const row of list.children) {
        const locked = row.dataset.locked === "true";
        for (const input of row.querySelectorAll("input")) {
          input.readOnly = saving || locked;
          input.setAttribute("aria-readonly", input.readOnly ? "true" : "false");
        }
        const remove = row.querySelector(".stvai-name-manager-delete");
        if (remove) remove.disabled = saving;
      }
    }

    function addRow(value = {}, { locked = false } = {}) {
      const row = element(document, "div", "stvai-name-manager-row");
      const source = element(document, "input", "stvai-name-manager-source");
      const target = element(document, "input", "stvai-name-manager-target");
      const remove = element(document, "button", "stvai-name-manager-delete", "Xóa");
      source.placeholder = "Tiếng Trung";
      target.placeholder = "Tiếng Việt";
      source.value = value.source || "";
      target.value = value.target || "";
      remove.type = "button";
      remove.addEventListener("click", () => { if (!saving) row.remove(); });
      row.append(source, target, remove);
      setRowLocked(row, locked);
      list.append(row);
      return row;
    }

    function load(value) {
      list.replaceChildren();
      for (const mapping of sortRowsByTranslatedName(parseNameGuide(value))) addRow(mapping, { locked: true });
      if (!list.children.length) addRow();
      message.textContent = "";
    }

    function filter() {
      const query = search.value.trim().toLocaleLowerCase("vi");
      for (const row of list.children) {
        const value = `${row.querySelector(".stvai-name-manager-source").value} ${row.querySelector(".stvai-name-manager-target").value}`.toLocaleLowerCase("vi");
        row.hidden = Boolean(query && !value.includes(query));
      }
    }

    function collect() {
      const rows = Array.from(list.children).map((row) => ({
        row,
        source: row.querySelector(".stvai-name-manager-source").value.trim(),
        target: row.querySelector(".stvai-name-manager-target").value.trim()
      })).filter(({ source, target }) => source || target);
      if (rows.some(({ source, target }) => !source || !target || /[=\r\n]/.test(source) || /[\r\n]/.test(target))) {
        return { error: "Có mục sai định dạng hoặc còn trống." };
      }
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.source)) return { error: "Có tiếng Trung bị trùng." };
        seen.add(row.source);
      }
      const sortedRows = sortRowsByTranslatedName(rows);
      return { value: serializeRows(sortedRows), rows: sortedRows };
    }

    search.addEventListener("input", filter);
    add.addEventListener("click", () => { if (!saving) addRow().querySelector("input")?.focus(); });
    close.addEventListener("click", () => { if (!saving) root.hidden = true; });
    save.addEventListener("click", () => {
      if (saving) return;
      const result = collect();
      if (result.error) { message.textContent = result.error; return; }
      setSaving(true);
      pending = pending.then(async () => {
        try {
          await options.onSave?.(result.value);
          for (const mapping of result.rows) list.append(mapping.row);
          for (const row of list.children) {
            const source = row.querySelector(".stvai-name-manager-source").value.trim();
            const target = row.querySelector(".stvai-name-manager-target").value.trim();
            if (source && target) setRowLocked(row, true);
          }
          message.textContent = "Đã lưu bộ Name riêng của tool.";
        } catch (error) {
          message.textContent = error?.message || "Không lưu được bộ Name.";
        } finally { setSaving(false); }
      });
    });
    load(options.nameGuide || "");
    return {
      root, search, add, save, message,
      open(value) {
        if (saving) return;
        load(value); root.hidden = false; positionController?.refresh?.(); search.focus();
      },
      close() { if (!saving) root.hidden = true; },
      destroy() { positionController?.destroy?.(); root.remove(); },
      refreshPosition() { return positionController?.refresh?.(); },
      whenIdle() { return pending; }
    };
  }

  return Object.freeze({ parseNameGuide, serializeRows, attachDraggable, createNameManager });
});
