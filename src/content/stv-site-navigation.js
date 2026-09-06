(function attachSiteNavigation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAISiteNavigation = api;

  if (typeof module !== "object" && root.document && root.chrome?.runtime && root.STVAIUI
    && root === root.top && !root.STVAISiteNavigationLifecycle) {
    root.STVAISiteNavigationLifecycle = api.createLifecycle({
      document: root.document,
      runtime: root.chrome.runtime,
      ui: root.STVAIUI,
      autoStart: true
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSiteNavigationModule() {
  "use strict";

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

  function trustedUserGesture(event, view) {
    if (event?.isTrusted !== true) return false;
    const activation = view?.navigator?.userActivation;
    return !activation || activation.isActive === true;
  }

  function createController({ document, runtime, ui, isTrustedUiEvent = trustedUserGesture }) {
    let controls = null;
    let destroyed = false;
    let zoomQueue = Promise.resolve();
    let remountObserver = null;
    return Object.freeze({
      async mount() {
        if (destroyed || controls || !document.body) return;
        const restoredZoom = await sendRuntime(runtime, {
          type: "STVAI_PAGE_ZOOM_RESTORE"
        }).catch(() => null);
        const stored = await sendRuntime(runtime, {
          type: "STVAI_STORAGE_GET",
          keys: ["stvaiNavigationExpanded", "stvaiUiScale"]
        }).catch(() => ({ values: {} }));
        if (destroyed || controls || !document.body) return;
        controls = ui.createNavigationControls(document, undefined, {
          layout: "global",
          uiScale: stored?.values?.stvaiUiScale,
          initialExpanded: stored?.values?.stvaiNavigationExpanded === true,
          isTrustedUiEvent,
          onExpandedChange(expanded) {
            void sendRuntime(runtime, {
              type: "STVAI_STORAGE_SET",
              values: { stvaiNavigationExpanded: expanded === true }
            }).catch(() => undefined);
          }
        });
        const changeZoom = direction => {
          zoomQueue = zoomQueue.then(async () => {
            if (destroyed) return;
            const response = await sendRuntime(runtime, { type: "STVAI_PAGE_ZOOM", direction });
            if (destroyed || !controls) return;
            const suffix = response?.ok ? ` (${response.percent}%)` : " — chưa thể đổi zoom";
            controls.zoomOut.title = `Thu nhỏ trang 10%${suffix}`;
            controls.zoomIn.title = `Phóng to trang 10%${suffix}`;
          }).catch(() => {
            if (!destroyed && controls) {
              controls.zoomOut.title = "Chưa thể đổi zoom. Thử lại.";
              controls.zoomIn.title = "Chưa thể đổi zoom. Thử lại.";
            }
          });
        };
        controls.zoomOut.addEventListener("click", event => {
          if (isTrustedUiEvent(event, document.defaultView)) changeZoom(-1);
        });
        controls.zoomIn.addEventListener("click", event => {
          if (isTrustedUiEvent(event, document.defaultView)) changeZoom(1);
        });
        if (restoredZoom?.ok) {
          controls.zoomOut.title = `Thu nhỏ trang 10% (${restoredZoom.percent}%)`;
          controls.zoomIn.title = `Phóng to trang 10% (${restoredZoom.percent}%)`;
        }
        document.body.append(controls.root);
        controls.startAvoidingNativeOverlays?.();
        const Observer = document.defaultView?.MutationObserver;
        if (Observer && document.documentElement) {
          remountObserver = new Observer(() => {
            if (!destroyed && controls && !controls.root.isConnected && document.body) {
              document.body.append(controls.root);
            }
          });
          remountObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
      },
      setUiScale(value) {
        ui.applyUiScale?.(document, value);
        controls?.setUiScale?.(value);
      },
      whenIdle() { return zoomQueue; },
      destroy() {
        destroyed = true;
        remountObserver?.disconnect();
        remountObserver = null;
        controls?.destroy?.();
        controls?.root.remove();
        controls = null;
      }
    });
  }

  function createLifecycle({ document, runtime, ui, autoStart = true, isTrustedUiEvent = trustedUserGesture }) {
    let controller = null;
    let disposed = false;
    let pending = Promise.resolve();

    const ensureMounted = async () => {
      if (disposed) return false;
      if (!controller) {
        controller = createController({ document, runtime, ui, isTrustedUiEvent });
        await controller.mount();
      }
      return true;
    };
    const setEnabled = () => {
      pending = pending.catch(() => undefined).then(ensureMounted);
      return pending;
    };
    const listener = (message, _sender, sendResponse) => {
      if (message?.type === "STVAI_UI_SCALE_CHANGED") {
        controller?.setUiScale?.(message.value);
        sendResponse?.({ ok: true });
        return false;
      }
      if (message?.type !== "STVAI_TOOL_ENABLED_CHANGED") return false;
      void setEnabled().then(
        active => sendResponse?.({ ok: true, active }),
        () => sendResponse?.({ ok: false, reason: "site-navigation-failed" })
      );
      return true;
    };
    runtime.onMessage?.addListener?.(listener);
    if (autoStart) {
      pending = pending.then(ensureMounted);
    }

    return Object.freeze({
      setEnabled,
      async whenIdle() {
        await pending;
        await controller?.whenIdle?.();
      },
      destroy() {
        disposed = true;
        runtime.onMessage?.removeListener?.(listener);
        controller?.destroy();
        controller = null;
      }
    });
  }

  return Object.freeze({ trustedUserGesture, createController, createLifecycle });
});
