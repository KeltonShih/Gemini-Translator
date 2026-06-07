const elements = {
  statusPill: document.getElementById("statusPill"),
  statusTitle: document.getElementById("statusTitle"),
  statusDetail: document.getElementById("statusDetail"),
  progressWrap: document.getElementById("progressWrap"),
  progressBar: document.getElementById("progressBar"),
  translateBtn: document.getElementById("translateBtn"),
  showOriginalBtn: document.getElementById("showOriginalBtn"),
  showTranslationBtn: document.getElementById("showTranslationBtn"),
  optionsBtn: document.getElementById("optionsBtn"),
  clearCacheBtn: document.getElementById("clearCacheBtn")
};

let activeTabId = null;
let hasApiKey = false;

document.addEventListener("DOMContentLoaded", initializePopup);

elements.translateBtn.addEventListener("click", () => sendPageCommand("TRANSLATE_PAGE"));
elements.showOriginalBtn.addEventListener("click", () => sendPageCommand("SHOW_ORIGINAL"));
elements.showTranslationBtn.addEventListener("click", () => sendPageCommand("SHOW_TRANSLATION"));
elements.clearCacheBtn.addEventListener("click", () => sendPageCommand("CLEAR_PAGE_CACHE"));
elements.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PAGE_TRANSLATOR_STATUS") {
    renderStatus(message.status);
  }
});

async function initializePopup() {
  setBusy("正在確認設定", "我先確認 API Key 與目前頁面能不能翻譯。");

  const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS_STATUS" });
  hasApiKey = Boolean(settings?.hasApiKey);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;

  if (!activeTabId || !isTranslatableUrl(tab.url)) {
    renderStatus({
      state: "blocked",
      title: "這個頁面不能翻譯",
      detail: "Chrome 系統頁、擴充功能頁或特殊頁面無法注入翻譯工具。"
    });
    return;
  }

  if (!hasApiKey) {
    renderStatus({
      state: "missing-key",
      title: "尚未設定 Gemini API Key",
      detail: "請先到設定頁儲存 API Key，再回來翻譯目前頁面。"
    });
    return;
  }

  await ensureContentScript();
  await sendPageCommand("GET_STATUS", { silent: true });
}

async function ensureContentScript() {
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, { type: "PING" });
    if (response?.ok) {
      return;
    }
  } catch {
    // The script has not been injected yet.
  }

  await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    files: ["content.js"]
  });
}

async function sendPageCommand(type, options = {}) {
  if (!activeTabId) {
    return;
  }

  if (!options.silent) {
    setControlsDisabled(true);
  }

  try {
    await ensureContentScript();
    const response = await chrome.tabs.sendMessage(activeTabId, { type });
    if (response?.status) {
      renderStatus(response.status);
    } else if (response?.ok === false) {
      renderStatus({
        state: "error",
        title: "操作失敗",
        detail: response.error || "頁面沒有回應。"
      });
    }
  } catch (error) {
    renderStatus({
      state: "error",
      title: "無法操作這個頁面",
      detail: error?.message || "請重新整理頁面後再試一次。"
    });
  } finally {
    if (!options.silent) {
      setControlsDisabled(false);
    }
  }
}

function renderStatus(status = {}) {
  const state = status.state || "idle";
  elements.statusTitle.textContent = status.title || statusTitleForState(state);
  elements.statusDetail.textContent = status.detail || "";
  elements.statusPill.textContent = pillTextForState(state);
  elements.statusPill.className = `pill ${state === "error" || state === "blocked" ? "error" : ""} ${state === "translated" ? "ready" : ""}`;

  const progress = Number(status.progress || 0);
  elements.progressWrap.hidden = state !== "translating";
  elements.progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;

  const canTranslate = hasApiKey && !["blocked", "translating", "missing-key"].includes(state);
  const canToggle = state === "translated" || state === "original";

  elements.translateBtn.disabled = !canTranslate;
  elements.showOriginalBtn.disabled = !canToggle || state === "original";
  elements.showTranslationBtn.disabled = !canToggle || state === "translated";
  elements.clearCacheBtn.disabled = !hasApiKey || state === "blocked" || state === "translating";
}

function setBusy(title, detail) {
  renderStatus({
    state: "loading",
    title,
    detail
  });
}

function setControlsDisabled(disabled) {
  elements.translateBtn.disabled = disabled;
  elements.showOriginalBtn.disabled = disabled;
  elements.showTranslationBtn.disabled = disabled;
  elements.clearCacheBtn.disabled = disabled;
}

function isTranslatableUrl(url = "") {
  return /^https?:\/\//i.test(url);
}

function statusTitleForState(state) {
  const titles = {
    idle: "尚未翻譯",
    original: "目前顯示原文",
    translated: "目前顯示翻譯",
    translating: "翻譯中",
    error: "發生錯誤",
    loading: "讀取中",
    blocked: "無法翻譯",
    "missing-key": "尚未設定 API Key"
  };
  return titles[state] || "尚未翻譯";
}

function pillTextForState(state) {
  const labels = {
    idle: "未翻譯",
    original: "原文",
    translated: "已翻譯",
    translating: "翻譯中",
    error: "錯誤",
    loading: "讀取中",
    blocked: "受限制",
    "missing-key": "需設定"
  };
  return labels[state] || "未翻譯";
}
