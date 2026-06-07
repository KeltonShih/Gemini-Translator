const SETTINGS_KEY = "translator.settings";
const CACHE_PREFIX = "translator.cache.";
const TERM_CACHE_PREFIX = "translator.term.";
const SETTINGS_VERSION = 2;
const LEGACY_DEFAULT_TRANSLATION_MODEL = "gemini-2.5-pro";

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.1-flash-lite",
  lookupModel: "gemini-3.1-flash-lite",
  settingsVersion: SETTINGS_VERSION
};

chrome.runtime.onInstalled.addListener(() => {
  lockStorageToTrustedContexts();
});

chrome.runtime.onStartup.addListener(() => {
  lockStorageToTrustedContexts();
});

async function lockStorageToTrustedContexts() {
  if (!chrome.storage.local.setAccessLevel) {
    return;
  }

  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS"
    });
  } catch (error) {
    console.warn("Unable to restrict storage access.", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: normalizeError(error)
      });
    });
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_SETTINGS_STATUS":
      return getSettingsStatus();
    case "SAVE_SETTINGS":
      return saveSettings(message.settings);
    case "DELETE_API_KEY":
      return deleteApiKey();
    case "TEST_API_KEY":
      return testApiKey(message.apiKey, message.model);
    case "TRANSLATE_CHUNK":
      return translateChunk(message.payload);
    case "LOOKUP_TERM":
      return lookupTerm(message.payload);
    case "GET_PAGE_CACHE":
      return getPageCache(message.payload);
    case "SET_PAGE_CACHE":
      return setPageCache(message.payload);
    case "CLEAR_PAGE_CACHE":
      return clearPageCache(message.payload);
    case "PAGE_TRANSLATOR_STATUS":
      return { ok: true };
    default:
      throw new Error("Unsupported message type.");
  }
}

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const storedSettings = result[SETTINGS_KEY] || {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings
  };
  const shouldMigrateLegacyDefault =
    !storedSettings.settingsVersion &&
    settings.model === LEGACY_DEFAULT_TRANSLATION_MODEL;

  if (shouldMigrateLegacyDefault) {
    settings.model = DEFAULT_SETTINGS.model;
  }

  if (shouldMigrateLegacyDefault || !storedSettings.settingsVersion) {
    settings.settingsVersion = SETTINGS_VERSION;
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  return settings;
}

async function getSettingsStatus() {
  const settings = await getSettings();
  return {
    ok: true,
    hasApiKey: Boolean(settings.apiKey),
    model: settings.model,
    lookupModel: settings.lookupModel
  };
}

async function saveSettings(rawSettings = {}) {
  const current = await getSettings();
  const settings = {
    ...current,
    apiKey: String(rawSettings.apiKey || "").trim(),
    model: String(rawSettings.model || DEFAULT_SETTINGS.model).trim(),
    lookupModel: String(rawSettings.lookupModel || DEFAULT_SETTINGS.lookupModel).trim(),
    settingsVersion: SETTINGS_VERSION
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return getSettingsStatus();
}

async function deleteApiKey() {
  const settings = await getSettings();
  settings.apiKey = "";
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return getSettingsStatus();
}

async function testApiKey(apiKey, model) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("請先輸入 Gemini API Key。");
  }

  const response = await callGemini({
    apiKey: key,
    model: model || DEFAULT_SETTINGS.lookupModel,
    prompt: "Reply with a JSON object that confirms the connection works.",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        message: { type: "string" }
      },
      required: ["ok", "message"]
    },
    timeoutMs: 30000
  });

  const parsed = parseJsonResponse(response);
  return {
    ok: true,
    message: parsed.message || "Gemini API Key 可以使用。"
  };
}

async function translateChunk(payload = {}) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("尚未設定 Gemini API Key。");
  }

  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  if (!segments.length) {
    return {
      ok: true,
      translations: []
    };
  }

  const prompt = buildTranslationPrompt(segments);
  const response = await callGemini({
    apiKey: settings.apiKey,
    model: settings.model,
    prompt,
    schema: translationSchema(),
    timeoutMs: 90000
  });
  const parsed = parseJsonResponse(response);
  const translations = validateTranslations(segments, parsed.translations || []);

  return {
    ok: true,
    model: settings.model,
    translations
  };
}

async function lookupTerm(payload = {}) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("尚未設定 Gemini API Key。");
  }

  const term = String(payload.term || "").trim();
  const context = String(payload.context || "").trim();
  if (!term) {
    throw new Error("請先選取要查詢的原文字詞。");
  }

  const cacheKey = TERM_CACHE_PREFIX + stableHash([term.toLowerCase(), context, settings.lookupModel].join("\n"));
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) {
    return {
      ok: true,
      cached: true,
      result: cached[cacheKey]
    };
  }

  const prompt = buildLookupPrompt(term, context);
  const response = await callGemini({
    apiKey: settings.apiKey,
    model: settings.lookupModel,
    prompt,
    schema: lookupSchema(),
    timeoutMs: 45000
  });
  const result = parseJsonResponse(response);

  await chrome.storage.local.set({
    [cacheKey]: {
      ...result,
      createdAt: Date.now()
    }
  });

  return {
    ok: true,
    cached: false,
    result
  };
}

async function getPageCache(payload = {}) {
  const key = pageCacheKey(payload);
  const result = await chrome.storage.local.get(key);
  return {
    ok: true,
    cache: result[key] || null
  };
}

async function setPageCache(payload = {}) {
  const key = pageCacheKey(payload);
  const cache = {
    url: payload.url,
    title: payload.title,
    fingerprint: payload.fingerprint,
    model: payload.model,
    records: payload.records || [],
    blocks: payload.blocks || [],
    createdAt: Date.now()
  };

  try {
    await chrome.storage.local.set({ [key]: cache });
    return {
      ok: true
    };
  } catch (error) {
    return {
      ok: false,
      error: "翻譯完成，但快取空間不足，重新整理後可能需要再翻一次。"
    };
  }
}

async function clearPageCache(payload = {}) {
  const key = pageCacheKey(payload);
  await chrome.storage.local.remove(key);
  return {
    ok: true
  };
}

function pageCacheKey(payload = {}) {
  return CACHE_PREFIX + stableHash([
    normalizeUrl(payload.url || ""),
    payload.fingerprint || ""
  ].join("\n"));
}

function buildTranslationPrompt(segments) {
  return [
    "You are translating a web page into Traditional Chinese for Taiwan readers.",
    "Return JSON only. Do not include markdown.",
    "",
    "Rules:",
    "- Translate naturally in Traditional Chinese, Taiwan usage, technical book style.",
    "- Do not use Simplified Chinese or Mainland China technical terms.",
    "- Preserve every placeholder exactly, for example [[KEEP_0]].",
    "- Preserve URLs, filenames, commands, API names, class names, function names, variables, and identifiers.",
    "- Keep these English terms in English unless a Chinese explanation is needed: Token, Prompt, RAG, LoRA, PEFT, API, CLI, MCP, Agent, Multi-Agent, Workflow, Context Window, Tool Calling.",
    "- For named entities and domain terms from any source language, use translated text(original source text copied verbatim from the input segment), for example 深度學習(deep learning), 東京大學(東京大学), 神經網路(ニューラルネットワーク), 인공지능(인공지능).",
    "- Apply translated text(original source text) to people, organizations, products, models, places, book or article titles, and technical terms whenever they appear.",
    "- The text inside parentheses must be copied from the input segment. Never replace a Japanese, Korean, Chinese, or other non-English source term with an English canonical term unless that exact English term appears in the input.",
    "- If the input says 深層学習, write 深度學習(深層学習), not 深度學習(deep learning). If the input says ニューラルネットワーク, write 神經網路(ニューラルネットワーク), not 神經網路(neural network).",
    "- Keep the same id for each translated segment.",
    "- Return the translations in the same order as the input.",
    "",
    "Input JSON:",
    JSON.stringify({ segments })
  ].join("\n");
}

function buildLookupPrompt(term, context) {
  return [
    "Explain the selected source-language word or phrase for a Traditional Chinese reader in Taiwan.",
    "Return JSON only. Do not include markdown.",
    "",
    "Requirements:",
    "- Focus on the meaning in this context.",
    "- Use Traditional Chinese and Taiwan wording.",
    "- If it is a technical term, explain the technical sense clearly.",
    "- Keep the selected original term visible.",
    "- If the term is Japanese, Korean, Chinese, or another non-English language, put pronunciation or reading in the reading field only when it helps understanding.",
    "",
    "Selected term:",
    term,
    "",
    "Original context:",
    context
  ].join("\n");
}

function translationSchema() {
  return {
    type: "object",
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" }
          },
          required: ["id", "text"]
        }
      }
    },
    required: ["translations"]
  };
}

function lookupSchema() {
  return {
    type: "object",
    properties: {
      term: { type: "string" },
      translation: { type: "string" },
      reading: { type: "string" },
      partOfSpeech: { type: "string" },
      meaningInContext: { type: "string" },
      commonUsage: { type: "string" },
      example: { type: "string" }
    },
    required: ["term", "translation", "meaningInContext"]
  };
}

async function callGemini({ apiKey, model, prompt, schema, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: schema
        }
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(formatGeminiError(response.status, body));
    }

    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Gemini API 回應逾時，請稍後再試。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonResponse(data) {
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini 沒有回傳可解析的內容。");
  }

  try {
    return JSON.parse(stripJsonFence(text));
  } catch (error) {
    throw new Error("Gemini 回傳格式無法解析。");
  }
}

function stripJsonFence(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function validateTranslations(segments, translations) {
  const byId = new Map();
  for (const translation of translations) {
    if (translation?.id) {
      byId.set(String(translation.id), String(translation.text || ""));
    }
  }

  return segments.map((segment) => {
    if (!byId.has(segment.id)) {
      throw new Error("Gemini 回傳的翻譯數量或 ID 不一致。");
    }
    return {
      id: segment.id,
      text: byId.get(segment.id)
    };
  });
}

function formatGeminiError(status, body) {
  if (status === 400) {
    return "Gemini API 請求格式或 Token 長度有問題。";
  }
  if (status === 401 || status === 403) {
    return "Gemini API Key 無效或沒有權限。";
  }
  if (status === 429) {
    return "Gemini API 使用量或速率已達限制，請稍後再試。";
  }
  if (status >= 500) {
    return "Gemini API 目前不穩定，請稍後再試。";
  }

  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || `Gemini API 錯誤：${status}`;
  } catch {
    return `Gemini API 錯誤：${status}`;
  }
}

function normalizeError(error) {
  return error?.message || "發生未知錯誤。";
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function stableHash(input) {
  let hash = 2166136261;
  const text = String(input);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
