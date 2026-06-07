const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const lookupModelSelect = document.getElementById("lookupModel");
const toggleKeyBtn = document.getElementById("toggleKeyBtn");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const deleteBtn = document.getElementById("deleteBtn");
const message = document.getElementById("message");

document.addEventListener("DOMContentLoaded", loadSettings);
toggleKeyBtn.addEventListener("click", toggleKeyVisibility);
saveBtn.addEventListener("click", saveSettings);
testBtn.addEventListener("click", testConnection);
deleteBtn.addEventListener("click", deleteApiKey);

async function loadSettings() {
  const result = await chrome.storage.local.get("translator.settings");
  const settings = result["translator.settings"] || {};
  apiKeyInput.value = settings.apiKey || "";
  modelSelect.value = settings.model || "gemini-3.1-flash-lite";
  lookupModelSelect.value = settings.lookupModel || "gemini-3.1-flash-lite";
}

function toggleKeyVisibility() {
  const show = apiKeyInput.type === "password";
  apiKeyInput.type = show ? "text" : "password";
  toggleKeyBtn.textContent = show ? "隱藏" : "顯示";
}

async function saveSettings() {
  setMessage("正在儲存設定。");
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: {
      apiKey: apiKeyInput.value,
      model: modelSelect.value,
      lookupModel: lookupModelSelect.value
    }
  });

  if (response?.ok) {
    setMessage("設定已儲存。", "ok");
  } else {
    setMessage(response?.error || "儲存失敗。", "error");
  }
}

async function testConnection() {
  setMessage("正在測試 Gemini API。");
  const response = await chrome.runtime.sendMessage({
    type: "TEST_API_KEY",
    apiKey: apiKeyInput.value,
    model: lookupModelSelect.value
  });

  if (response?.ok) {
    setMessage(response.message || "Gemini API Key 可以使用。", "ok");
  } else {
    setMessage(response?.error || "測試失敗。", "error");
  }
}

async function deleteApiKey() {
  const response = await chrome.runtime.sendMessage({ type: "DELETE_API_KEY" });
  if (response?.ok) {
    apiKeyInput.value = "";
    setMessage("API Key 已刪除。", "ok");
  } else {
    setMessage(response?.error || "刪除失敗。", "error");
  }
}

function setMessage(text, state = "") {
  message.textContent = text;
  message.className = `message ${state}`;
}
