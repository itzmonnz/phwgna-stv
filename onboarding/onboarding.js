(function attachOnboardingPage(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIOnboardingPage = api;
  if (root.document && root.chrome?.runtime) {
    void api.initOnboarding({ document: root.document, chromeApi: root.chrome });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createOnboardingPageApi() {
  "use strict";

  function send(chromeApi, message) {
    return new Promise((resolve) => {
      chromeApi.runtime.sendMessage(message, (response) => {
        if (chromeApi.runtime.lastError) resolve({ ok: false, reason: "background-unavailable" });
        else resolve(response || { ok: false, reason: "empty-response" });
      });
    });
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  async function initOnboarding({ document, chromeApi }) {
    const statusNode = document.getElementById("providerStatus");
    const providerName = document.getElementById("providerName");
    const openButton = document.getElementById("openProvider");
    const retryButton = document.getElementById("retryProvider");
    const finishButton = document.getElementById("finishOnboarding");
    const skipButton = document.getElementById("skipOnboarding");
    let providerReady = false;
    let finishPending = null;

    function render(result) {
      const name = result?.provider === "chatgpt" ? "ChatGPT" : "Gemini";
      providerName.textContent = name;
      openButton.textContent = `Mở ${name}`;
      providerReady = result?.providerReady === true;
      if (providerReady) {
        statusNode.textContent = `${name} đã sẵn sàng.`;
        statusNode.dataset.state = "ready";
        finishButton.disabled = false;
      } else {
        statusNode.textContent = `${name} chưa sẵn sàng — hãy đăng nhập rồi bấm Kiểm tra lại.`;
        statusNode.dataset.state = "waiting";
        finishButton.disabled = true;
      }
      return result;
    }

    async function retryProvider() {
      setBusy(retryButton, true);
      statusNode.textContent = "Đang kiểm tra…";
      const result = await send(chromeApi, { type: "STVAI_ONBOARDING_STATUS" });
      setBusy(retryButton, false);
      if (!result?.ok) {
        statusNode.textContent = "Chưa kết nối được với extension. Hãy mở trang Extensions và bấm Tải lại.";
        statusNode.dataset.state = "error";
        return result;
      }
      return render(result);
    }

    async function openProvider() {
      setBusy(openButton, true);
      const result = await send(chromeApi, { type: "STVAI_ONBOARDING_OPEN_PROVIDER" });
      setBusy(openButton, false);
      if (!result?.ok) {
        statusNode.textContent = "Không mở được trang AI. Hãy kiểm tra trình duyệt rồi thử lại.";
        statusNode.dataset.state = "error";
      }
      return result;
    }

    function finish() {
      if (finishPending) return finishPending;
      setBusy(finishButton, true);
      setBusy(skipButton, true);
      finishPending = (async () => {
        let succeeded = false;
        try {
          const result = await send(chromeApi, { type: "STVAI_ONBOARDING_FINISH" });
          succeeded = result?.ok === true;
          if (!succeeded) {
            statusNode.textContent = "Không mở được STV. Bạn vẫn có thể mở STV bằng tab mới.";
            statusNode.dataset.state = "error";
          }
          return result;
        } finally {
          finishPending = null;
          finishButton.setAttribute("aria-busy", "false");
          skipButton.setAttribute("aria-busy", "false");
          if (!succeeded) {
            finishButton.disabled = !providerReady;
            skipButton.disabled = false;
          }
        }
      })();
      return finishPending;
    }

    openButton.addEventListener("click", () => { void openProvider(); });
    retryButton.addEventListener("click", () => { void retryProvider(); });
    finishButton.addEventListener("click", () => { void finish(); });
    skipButton.addEventListener("click", () => { void finish(); });
    await retryProvider();
    return Object.freeze({ openProvider, retryProvider, finish });
  }

  return Object.freeze({ initOnboarding });
});
