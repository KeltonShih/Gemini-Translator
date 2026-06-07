(() => {
  if (window.__geminiPageTranslatorTw) {
    window.__geminiPageTranslatorTw.reconnect();
    return;
  }

  const EXCLUDED_TAGS = new Set([
    "CODE",
    "PRE",
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
    "INPUT",
    "SVG",
    "MATH",
    "KBD",
    "SAMP",
    "VAR",
    "NOSCRIPT",
    "SELECT",
    "OPTION"
  ]);
  const BLOCK_TAGS = new Set([
    "P",
    "LI",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "TD",
    "TH",
    "DT",
    "DD",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "ARTICLE",
    "SECTION"
  ]);
  const MAX_CHUNK_CHARS = 6500;
  const MAX_CHUNK_ITEMS = 60;
  const MIN_TEXT_LENGTH = 2;
  const TRANSLATABLE_TEXT_PATTERN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
  const LOOKUP_TEXT_PATTERN = /[\p{L}\p{N}]/u;
  const NON_LATIN_LOOKUP_PATTERN = /[\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

  const state = {
    mode: "idle",
    error: "",
    progress: 0,
    records: [],
    blocks: [],
    titleRecord: null,
    pageFingerprint: "",
    currentUrl: location.href,
    dynamicUpdateDetected: false,
    overlayClosedUntil: 0,
    overlay: null,
    lookupController: null
  };

  const api = {
    reconnect,
    getStatus,
    translatePage,
    showOriginal,
    showTranslation,
    clearPageCache
  };

  window.__geminiPageTranslatorTw = api;
  chrome.runtime.onMessage.addListener(handleMessage);
  setupSelectionListener();
  setupSpaWatcher();
  setupMutationWatcher();

  function reconnect() {
    sendStatus();
  }

  function handleMessage(message, sender, sendResponse) {
    handleCommand(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        state.mode = "error";
        state.error = error?.message || "頁面翻譯工具發生錯誤。";
        const status = getStatus();
        sendStatus();
        sendResponse({
          ok: false,
          error: state.error,
          status
        });
      });
    return true;
  }

  async function handleCommand(message) {
    switch (message?.type) {
      case "PING":
        return { ok: true };
      case "GET_STATUS":
        return { ok: true, status: getStatus() };
      case "TRANSLATE_PAGE":
        await translatePage();
        return { ok: true, status: getStatus() };
      case "SHOW_ORIGINAL":
        showOriginal();
        return { ok: true, status: getStatus() };
      case "SHOW_TRANSLATION":
        showTranslation();
        return { ok: true, status: getStatus() };
      case "CLEAR_PAGE_CACHE":
        await clearPageCache();
        return { ok: true, status: getStatus() };
      default:
        return { ok: false, error: "Unsupported command." };
    }
  }

  function getStatus() {
    if (state.mode === "translating") {
      return {
        state: "translating",
        title: "正在翻譯頁面",
        detail: progressDetail(),
        progress: state.progress
      };
    }

    if (state.mode === "translated") {
      return {
        state: "translated",
        title: "目前顯示翻譯",
        detail: state.error
          ? state.error
          : state.dynamicUpdateDetected
          ? "頁面出現新內容，可按「翻譯成中文」更新。"
          : "你可以選取中文查看對應原文，也可以切回原文。",
        progress: 100
      };
    }

    if (state.mode === "original") {
      return {
        state: "original",
        title: "目前顯示原文",
        detail: "已保存翻譯結果，可立即切回翻譯版。",
        progress: 100
      };
    }

    if (state.mode === "error") {
      return {
        state: "error",
        title: "翻譯失敗",
        detail: state.error || "請稍後再試。",
        progress: 0
      };
    }

    return {
      state: "idle",
      title: "尚未翻譯",
      detail: "按「翻譯成中文」後，頁面會原地替換成繁體中文。",
      progress: 0
    };
  }

  async function translatePage() {
    dismissOverlay();
    state.mode = "translating";
    state.error = "";
    state.progress = 3;
    state.dynamicUpdateDetected = false;
    sendStatus();

    const scan = scanPage();
    state.records = scan.records;
    state.blocks = scan.blocks;
    state.titleRecord = scan.titleRecord;
    state.pageFingerprint = scan.fingerprint;

    if (!scan.records.length) {
      state.mode = "error";
      state.error = "這個頁面沒有找到適合翻譯的主要文字。";
      sendStatus();
      return;
    }

    state.progress = 8;
    sendStatus();

    const cached = await loadCache();
    if (cached && applyCache(cached)) {
      state.mode = "translated";
      state.progress = 100;
      sendStatus();
      return;
    }

    const chunks = buildChunks(scan.records);
    const failed = [];

    for (let index = 0; index < chunks.length; index += 1) {
      state.progress = Math.round(10 + (index / Math.max(chunks.length, 1)) * 80);
      sendStatus();

      const chunk = chunks[index];
      try {
        await translateChunkWithFallback(chunk, failed);
      } catch (error) {
        failed.push(...chunk.map((record) => record.id));
      }
    }

    rebuildBlocks();
    applyTranslations();
    await saveCache();

    state.mode = "translated";
    state.error = failed.length
      ? `有 ${failed.length} 段沒有翻譯成功，其餘內容已套用。`
      : "";
    state.progress = 100;
    sendStatus();
  }

  function showOriginal() {
    dismissOverlay();
    for (const record of state.records) {
      if (record.kind === "documentTitle") {
        document.title = record.originalText;
        continue;
      }
      replaceRecordNode(record, document.createTextNode(record.originalText));
      record.renderedAsRichText = false;
    }
    document.documentElement.removeAttribute("data-gemini-translated");
    state.mode = state.records.length ? "original" : "idle";
    sendStatus();
  }

  function showTranslation() {
    dismissOverlay();
    applyTranslations();
    state.mode = state.records.length ? "translated" : "idle";
    sendStatus();
  }

  async function clearPageCache() {
    const fingerprint = state.pageFingerprint || scanPage().fingerprint;
    await chrome.runtime.sendMessage({
      type: "CLEAR_PAGE_CACHE",
      payload: {
        url: location.href,
        fingerprint
      }
    });
    state.mode = state.records.length ? state.mode : "idle";
    state.error = "";
    sendStatus();
  }

  function scanPage() {
    const mainRoot = findMainRoot();
    const roots = findScanRoots(mainRoot);
    const records = [];
    const blockMap = new Map();
    const seenNodes = new Set();
    let index = 0;

    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return shouldTranslateTextNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });

      let node;
      while ((node = walker.nextNode())) {
        if (seenNodes.has(node)) {
          continue;
        }
        seenNodes.add(node);

        const text = node.nodeValue || "";
        const core = text.trim();
        const blockElement = findBlockElement(node.parentElement, root);
        const blockId = getBlockId(blockElement, blockMap.size);
        if (!blockMap.has(blockId)) {
          blockMap.set(blockId, {
            id: blockId,
            element: blockElement,
            nodeIds: [],
            originalText: "",
            translatedText: ""
          });
        }

        const record = createRecord(node, text, core, blockId, index);
        records.push(record);
        blockMap.get(blockId).nodeIds.push(record.id);
        index += 1;
      }
    }

    const titleRecord = createDocumentTitleRecord(index);
    if (titleRecord) {
      records.push(titleRecord);
    }

    const blocks = Array.from(blockMap.values());
    for (const block of blocks) {
      const blockRecords = records.filter((record) => record.blockId === block.id);
      block.originalText = joinBlockText(blockRecords.map((record) => record.coreOriginal));
      block.translatedText = "";
    }

    return {
      records,
      blocks,
      titleRecord,
      fingerprint: createFingerprint(records)
    };
  }

  function findScanRoots(mainRoot) {
    const roots = [mainRoot];
    const titleCandidates = document.querySelectorAll([
      "h1",
      "[itemprop='headline']",
      "[property='og:title']",
      ".title",
      ".post-title",
      ".entry-title",
      ".article-title"
    ].join(","));

    for (const element of titleCandidates) {
      if (!element || element.tagName === "META") {
        continue;
      }
      if (roots.some((root) => root.contains(element))) {
        continue;
      }
      if (!isElementVisible(element)) {
        continue;
      }
      roots.push(element);
    }

    return roots;
  }

  function createRecord(node, originalText, coreOriginal, blockId, index) {
    const prefix = originalText.match(/^\s*/)?.[0] || "";
    const suffix = originalText.match(/\s*$/)?.[0] || "";
    const protectedText = protectText(coreOriginal);
    const originalHash = stableHash(coreOriginal);

    return {
      id: `t_${index}_${originalHash}`,
      blockId,
      node,
      renderedAsRichText: false,
      originalText,
      coreOriginal,
      prefix,
      suffix,
      protectedText: protectedText.text,
      placeholders: protectedText.placeholders,
      translatedCore: "",
      translatedText: "",
      originalHash
    };
  }

  function createDocumentTitleRecord(index) {
    const title = document.title.trim();
    if (!title || title.length < MIN_TEXT_LENGTH || !hasTranslatableText(title)) {
      return null;
    }

    const protectedText = protectText(title);
    const originalHash = stableHash(title);
    return {
      id: `document_title_${originalHash}`,
      kind: "documentTitle",
      blockId: "__document_title__",
      node: null,
      renderedAsRichText: false,
      originalText: title,
      coreOriginal: title,
      prefix: "",
      suffix: "",
      protectedText: protectedText.text,
      placeholders: protectedText.placeholders,
      translatedCore: "",
      translatedText: "",
      originalHash
    };
  }

  function shouldTranslateTextNode(node) {
    const text = node.nodeValue || "";
    const core = text.trim();
    if (core.length < MIN_TEXT_LENGTH) {
      return false;
    }
    if (!hasTranslatableText(core)) {
      return false;
    }
    if (looksNonTranslatable(core)) {
      return false;
    }

    const parent = node.parentElement;
    if (!parent || hasExcludedAncestor(parent)) {
      return false;
    }
    if (!isElementVisible(parent)) {
      return false;
    }
    return true;
  }

  function hasTranslatableText(text) {
    return TRANSLATABLE_TEXT_PATTERN.test(text);
  }

  function hasExcludedAncestor(element) {
    let current = element;
    while (current && current !== document.body) {
      if (EXCLUDED_TAGS.has(current.tagName)) {
        return true;
      }
      if (current.closest?.("[data-gemini-translator-ui]")) {
        return true;
      }
      if (current.isContentEditable) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function isElementVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function looksNonTranslatable(text) {
    const trimmed = text.trim();
    if (/^(https?:\/\/|www\.)\S+$/i.test(trimmed)) {
      return true;
    }
    if (/^[\w.-]+\.(js|ts|tsx|jsx|json|css|html|md|py|rb|go|rs|java|kt|swift|php|yml|yaml|xml)$/i.test(trimmed)) {
      return true;
    }
    if (/^[$>#]\s+\S+/.test(trimmed)) {
      return true;
    }
    if (/^[A-Z0-9_./:-]{2,}$/.test(trimmed)) {
      return true;
    }
    return false;
  }

  function findMainRoot() {
    const candidates = [
      "article",
      "main",
      "[role='main']",
      ".post",
      ".entry-content",
      ".article-content",
      ".content"
    ];

    let best = null;
    let bestScore = 0;
    for (const selector of candidates) {
      for (const element of document.querySelectorAll(selector)) {
        const score = visibleTextLength(element);
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
    }

    return bestScore > 500 ? best : document.body;
  }

  function visibleTextLength(element) {
    if (!isElementVisible(element)) {
      return 0;
    }
    return (element.innerText || "").trim().length;
  }

  function findBlockElement(element, root) {
    let current = element;
    while (current && current !== root && current !== document.body) {
      if (BLOCK_TAGS.has(current.tagName)) {
        return current;
      }
      current = current.parentElement;
    }
    return element || root;
  }

  function getBlockId(element, fallbackIndex) {
    if (!element.dataset.geminiTranslatorBlockId) {
      element.dataset.geminiTranslatorBlockId = `b_${fallbackIndex}_${stableHash(getElementPath(element))}`;
    }
    return element.dataset.geminiTranslatorBlockId;
  }

  function getElementPath(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 8) {
      const parent = current.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, current) : 0;
      parts.push(`${current.tagName}:${index}`);
      current = parent;
    }
    return parts.reverse().join("/");
  }

  function protectText(text) {
    const placeholders = [];
    let protectedText = text;
    const patterns = [
      /https?:\/\/[^\s<>"']+/gi,
      /\b[\w.-]+\.(?:js|ts|tsx|jsx|json|css|html|md|py|rb|go|rs|java|kt|swift|php|yml|yaml|xml)\b/gi,
      /`[^`]+`/g,
      /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\([^)]*\))+\b/g,
      /\b(?:Token|Prompt|RAG|LoRA|PEFT|API|CLI|MCP|Agent|Multi-Agent|Workflow|Context Window|Tool Calling)\b/g
    ];

    for (const pattern of patterns) {
      protectedText = protectedText.replace(pattern, (match) => {
        const key = `[[KEEP_${placeholders.length}]]`;
        placeholders.push({ key, value: match });
        return key;
      });
    }

    return {
      text: protectedText,
      placeholders
    };
  }

  function restorePlaceholders(text, placeholders) {
    let restored = text;
    for (const item of placeholders) {
      restored = restored.split(item.key).join(item.value);
    }
    return restored;
  }

  function buildChunks(records) {
    const chunks = [];
    let current = [];
    let charCount = 0;

    for (const record of records) {
      const length = record.protectedText.length;
      if (
        current.length &&
        (current.length >= MAX_CHUNK_ITEMS || charCount + length > MAX_CHUNK_CHARS)
      ) {
        chunks.push(current);
        current = [];
        charCount = 0;
      }

      current.push(record);
      charCount += length;
    }

    if (current.length) {
      chunks.push(current);
    }
    return chunks;
  }

  async function translateChunkWithFallback(chunk, failed) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_CHUNK",
        payload: {
          segments: chunk.map((record) => ({
            id: record.id,
            text: record.protectedText
          }))
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "翻譯失敗。");
      }

      for (const item of response.translations) {
        const record = chunk.find((candidate) => candidate.id === item.id);
        if (record) {
          record.translatedCore = restorePlaceholders(item.text, record.placeholders);
          record.translatedText = record.prefix + record.translatedCore + record.suffix;
        }
      }
    } catch (error) {
      if (chunk.length > 1) {
        const middle = Math.ceil(chunk.length / 2);
        await translateChunkWithFallback(chunk.slice(0, middle), failed);
        await translateChunkWithFallback(chunk.slice(middle), failed);
        return;
      }

      const [record] = chunk;
      failed.push(record.id);
      record.translatedCore = record.coreOriginal;
      record.translatedText = record.originalText;
    }
  }

  function applyTranslations() {
    for (const record of state.records) {
      if (record.kind === "documentTitle") {
        if (record.translatedCore || record.translatedText) {
          document.title = record.translatedCore || record.translatedText;
        }
        continue;
      }
      if (record.node?.isConnected && record.translatedText) {
        replaceRecordNode(record, buildTranslatedNode(record));
      }
    }
    ensureTranslatedFontStyle();
    document.documentElement.setAttribute("data-gemini-translated", "true");
  }

  function replaceRecordNode(record, nextNode) {
    if (!record.node?.isConnected || !record.node.parentNode) {
      return;
    }

    record.node.parentNode.replaceChild(nextNode, record.node);
    record.node = nextNode;
  }

  function buildTranslatedNode(record) {
    const emphasisRanges = findEmphasisRanges(record.translatedText);
    if (!emphasisRanges.length) {
      record.renderedAsRichText = false;
      return document.createTextNode(record.translatedText);
    }

    const wrapper = document.createElement("span");
    wrapper.dataset.geminiTranslatedText = "true";
    wrapper.dataset.recordId = record.id;

    let cursor = 0;
    for (const range of emphasisRanges) {
      if (range.start > cursor) {
        wrapper.appendChild(document.createTextNode(record.translatedText.slice(cursor, range.start)));
      }

      const strong = document.createElement("strong");
      strong.dataset.geminiTerm = "true";
      strong.textContent = record.translatedText.slice(range.start, range.end);
      wrapper.appendChild(strong);
      cursor = range.end;
    }

    if (cursor < record.translatedText.length) {
      wrapper.appendChild(document.createTextNode(record.translatedText.slice(cursor)));
    }

    record.renderedAsRichText = true;
    return wrapper;
  }

  function findEmphasisRanges(text) {
    const value = String(text || "");
    const ranges = [];
    const cjkTermWithOriginalPattern = /(?:[A-Za-z][A-Za-z0-9.+-]*\s+)?[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]{1,24}(?:\s*[A-Za-z0-9][A-Za-z0-9.+-]*)?\s*[（(][^（）()\n]{1,80}[）)]/g;
    const latinTermWithOriginalPattern = /\b[A-Z][A-Za-z0-9.+-]*(?:\s+[A-Z][A-Za-z0-9.+-]*){0,4}\s*[（(][^（）()\n]{1,80}[）)]/g;
    const patterns = [
      cjkTermWithOriginalPattern,
      latinTermWithOriginalPattern,
      /\b(?:AI|AGI|API|CLI|MCP|GPU|CPU|RAG|LoRA|PEFT|Token|Prompt|Agent|Workflow|Gemini|ChatGPT|Claude|OpenAI|DeepMind|Google|Transformer|Turing|Dartmouth|Pascaline)\b/g,
      /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b/g,
      /\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(value))) {
        if (shouldSkipEmphasisMatch(value, match.index, match[0])) {
          continue;
        }
        ranges.push({
          start: match.index,
          end: match.index + match[0].length
        });
      }
    }

    return mergeRanges(ranges);
  }

  function shouldSkipEmphasisMatch(text, start, match) {
    const before = text.slice(Math.max(0, start - 8), start);
    return /https?:\/\/|www\.$/i.test(before + match);
  }

  function rebuildBlocks() {
    for (const block of state.blocks) {
      const blockRecords = state.records.filter((record) => record.blockId === block.id);
      block.originalText = joinBlockText(blockRecords.map((record) => record.coreOriginal));
      block.translatedText = joinBlockText(blockRecords.map((record) => record.translatedCore || record.coreOriginal));
    }
  }

  function joinBlockText(parts) {
    return parts
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function createFingerprint(records) {
    const sample = records
      .slice(0, 80)
      .map((record) => record.originalHash)
      .join("|");
    return stableHash([location.origin, location.pathname, records.length, sample].join("\n"));
  }

  async function loadCache() {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PAGE_CACHE",
      payload: {
        url: location.href,
        fingerprint: state.pageFingerprint
      }
    });

    return response?.cache || null;
  }

  function applyCache(cache) {
    if (!cache?.records?.length) {
      return false;
    }

    const cachedById = new Map(cache.records.map((record) => [record.id, record]));
    const cachedByHash = new Map();
    for (const record of cache.records) {
      if (!cachedByHash.has(record.originalHash)) {
        cachedByHash.set(record.originalHash, []);
      }
      cachedByHash.get(record.originalHash).push(record);
    }

    let applied = 0;
    for (const record of state.records) {
      let cached = cachedById.get(record.id);
      if (!cached || cached.originalHash !== record.originalHash) {
        cached = cachedByHash.get(record.originalHash)?.shift();
      }
      if (cached?.translatedText) {
        record.translatedCore = cached.translatedCore || cached.translatedText.trim();
        record.translatedText = record.prefix + record.translatedCore + record.suffix;
        applied += 1;
      }
    }

    if (applied < Math.max(1, Math.floor(state.records.length * 0.75))) {
      return false;
    }

    rebuildBlocks();
    applyTranslations();
    return true;
  }

  async function saveCache() {
    const records = state.records.map((record) => ({
      id: record.id,
      blockId: record.blockId,
      originalHash: record.originalHash,
      coreOriginal: record.coreOriginal,
      translatedCore: record.translatedCore,
      translatedText: record.translatedText
    }));

    const blocks = state.blocks.map((block) => ({
      id: block.id,
      nodeIds: block.nodeIds,
      originalText: block.originalText,
      translatedText: block.translatedText
    }));

    await chrome.runtime.sendMessage({
      type: "SET_PAGE_CACHE",
      payload: {
        url: location.href,
        title: document.title,
        fingerprint: state.pageFingerprint,
        records,
        blocks
      }
    });
  }

  function setupSelectionListener() {
    let timer = null;
    document.addEventListener("selectionchange", () => {
      clearTimeout(timer);
      timer = setTimeout(handleSelection, 160);
    });
  }

  function handleSelection() {
    if (Date.now() < state.overlayClosedUntil) {
      return;
    }
    if (state.mode !== "translated") {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText || selectedText.length < 2) {
      return;
    }

    if (isSelectionInsideOverlay(range)) {
      handleOverlaySelection(selection);
      return;
    }

    const selectedRecordRanges = findRecordRangesInSelection(range);
    if (!selectedRecordRanges.length) {
      return;
    }

    showOriginalOverlay({
      selectedText,
      range,
      selections: selectedRecordRanges
    });
  }

  function isSelectionInsideOverlay(range) {
    if (!state.overlay) {
      return false;
    }

    const root = range.commonAncestorContainer?.getRootNode?.();
    return root === state.overlay.shadow ||
      state.overlay.host.contains(range.commonAncestorContainer);
  }

  function findRecordRangesInSelection(range) {
    return state.records.map((record) => {
      if (!record.node?.isConnected) {
        return null;
      }
      try {
        if (!range.intersectsNode(record.node)) {
          return null;
        }
        return getRecordSelectionRange(record, range);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  function getRecordSelectionRange(record, range) {
    const fullText = getRecordRenderedText(record);
    let start = 0;
    let end = fullText.length;

    if (record.node.nodeType === Node.TEXT_NODE && range.startContainer === record.node) {
      start = range.startOffset;
    }
    if (record.node.nodeType === Node.TEXT_NODE && range.endContainer === record.node) {
      end = range.endOffset;
    }

    if (record.node.nodeType === Node.ELEMENT_NODE) {
      const selectedInsideRecord = getSelectedTextInsideRecord(record, range);
      if (selectedInsideRecord) {
        const index = fullText.indexOf(selectedInsideRecord);
        if (index >= 0) {
          start = index;
          end = index + selectedInsideRecord.length;
        }
      }
    }

    if (end <= start) {
      return null;
    }

    const selectedText = fullText.slice(start, end).trim();
    if (!selectedText) {
      return null;
    }

    const coreStart = record.prefix.length;
    const coreEnd = Math.max(coreStart, fullText.length - record.suffix.length);
    const relativeStart = Math.max(0, Math.min(record.translatedCore.length, start - coreStart));
    const relativeEnd = Math.max(0, Math.min(record.translatedCore.length, end - coreStart));

    return {
      record,
      selectedText,
      relativeStart: Math.min(relativeStart, relativeEnd),
      relativeEnd: Math.max(relativeStart, relativeEnd || relativeStart)
    };
  }

  function getRecordRenderedText(record) {
    return record.node.nodeType === Node.TEXT_NODE
      ? record.node.nodeValue || ""
      : record.node.textContent || "";
  }

  function getSelectedTextInsideRecord(record, range) {
    if (record.node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const startInside = record.node.contains(range.startContainer);
    const endInside = record.node.contains(range.endContainer);
    if (startInside && endInside) {
      return range.toString().trim();
    }

    return "";
  }

  function showOriginalOverlay({ selectedText, range, selections }) {
    const block = state.blocks.find((candidate) => candidate.id === selections[0].record.blockId);
    if (!block) {
      return;
    }

    const blockSelections = selections.filter((selection) => selection.record.blockId === block.id);
    const blockText = buildBlockTextForOverlay(block.id);
    const highlightRanges = blockSelections
      .map((selection) => findAlignedOriginalRange(selection, blockText.originalRanges))
      .filter(Boolean);
    const rect = range.getBoundingClientRect();
    const highlightedOriginal = renderOriginalText(blockText.originalText, highlightRanges);
    const overlay = ensureOverlay();

    overlay.selected.textContent = selectedText;
    overlay.original.innerHTML = highlightedOriginal;
    overlay.lookupArea.hidden = true;
    overlay.lookupResult.innerHTML = "";
    overlay.term.textContent = "";
    overlay.card.classList.remove("has-lookup");
    overlay.currentContext = blockText.originalText || block.originalText;
    overlay.host.style.left = `${Math.min(window.innerWidth - 24, Math.max(12, rect.left + window.scrollX))}px`;
    overlay.host.style.top = `${Math.max(12, rect.bottom + window.scrollY + 10)}px`;
    overlay.host.hidden = false;
    overlay.host.style.display = "block";
  }

  function buildBlockTextForOverlay(blockId) {
    const blockRecords = state.records.filter((record) => record.blockId === blockId);
    const original = buildJoinedTextWithRanges(blockRecords, "coreOriginal");
    const translated = buildJoinedTextWithRanges(blockRecords, "translatedCore");

    return {
      originalText: original.text,
      translatedText: translated.text,
      originalRanges: original.ranges,
      translatedRanges: translated.ranges
    };
  }

  function buildJoinedTextWithRanges(records, field) {
    let text = "";
    const ranges = [];

    for (const record of records) {
      const value = String(record[field] || "").trim();
      if (!value) {
        continue;
      }

      if (text) {
        text += " ";
      }

      const start = text.length;
      text += value;
      ranges.push({
        recordId: record.id,
        start,
        end: text.length,
        text: value
      });
    }

    return { text, ranges };
  }

  function findAlignedOriginalRange(selection, originalRanges) {
    const record = selection.record;
    const originalRange = originalRanges.find((range) => range.recordId === record.id);
    if (!originalRange) {
      return null;
    }

    const originalSentences = splitSentences(record.coreOriginal);
    const translatedSentences = splitSentences(record.translatedCore || record.coreOriginal);

    if (originalSentences.length > 1 && translatedSentences.length > 1) {
      const selectedIndexes = translatedSentences
        .map((sentence, index) => rangesOverlap(
          sentence.start,
          sentence.end,
          selection.relativeStart,
          selection.relativeEnd
        ) ? index : -1)
        .filter((index) => index >= 0);

      if (selectedIndexes.length) {
        const originalIndexes = selectedIndexes
          .map((index) => Math.min(index, originalSentences.length - 1));
        const start = Math.min(...originalIndexes);
        const end = Math.max(...originalIndexes);
        return {
          start: originalRange.start + originalSentences[start].start,
          end: originalRange.start + originalSentences[end].end
        };
      }
    }

    return {
      start: originalRange.start,
      end: originalRange.end
    };
  }

  function splitSentences(text) {
    const value = String(text || "").trim();
    if (!value) {
      return [];
    }

    const sentences = [];
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      const next = value[index + 1] || "";
      const isChineseEnd = /[。！？]/.test(char);
      const isWesternEnd = /[.!?]/.test(char) && (next === "" || /\s/.test(next));

      if (isChineseEnd || isWesternEnd) {
        const end = index + 1;
        pushSentence(sentences, value, start, end);
        start = end;
        while (start < value.length && /\s/.test(value[start])) {
          start += 1;
        }
      }
    }

    pushSentence(sentences, value, start, value.length);
    return sentences.length ? sentences : [{ text: value, start: 0, end: value.length }];
  }

  function pushSentence(sentences, value, start, end) {
    const raw = value.slice(start, end);
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }

    const leadingWhitespace = raw.search(/\S/);
    const offset = leadingWhitespace < 0 ? 0 : leadingWhitespace;
    sentences.push({
      text: trimmed,
      start: start + offset,
      end: start + offset + trimmed.length
    });
  }

  function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    return leftStart < rightEnd && rightStart < leftEnd;
  }

  function renderOriginalText(text, highlightRanges) {
    const ranges = mergeRanges(highlightRanges.map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end))
    })).filter((range) => range.end > range.start));

    if (!ranges.length) {
      return wrapLookupTerms(text);
    }

    let html = "";
    let cursor = 0;
    for (const range of ranges) {
      html += wrapLookupTerms(text.slice(cursor, range.start));
      html += `<mark>${wrapLookupTerms(text.slice(range.start, range.end))}</mark>`;
      cursor = range.end;
    }
    html += wrapLookupTerms(text.slice(cursor));
    return html;
  }

  function mergeRanges(ranges) {
    const sorted = ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];

    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end) {
        merged.push({ ...range });
      } else {
        last.end = Math.max(last.end, range.end);
      }
    }

    return merged;
  }

  function wrapLookupTerms(text) {
    const value = String(text || "");
    const ranges = getLookupTermRanges(value);
    if (!ranges.length) {
      return escapeHtml(value);
    }

    let html = "";
    let cursor = 0;

    for (const range of ranges) {
      html += escapeHtml(value.slice(cursor, range.start));
      html += `<span class="gt-word" data-term="${escapeAttribute(range.term)}">${escapeHtml(value.slice(range.start, range.end))}</span>`;
      cursor = range.end;
    }

    html += escapeHtml(value.slice(cursor));
    return html;
  }

  function getLookupTermRanges(value) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
      const ranges = [];

      for (const segment of segmenter.segment(value)) {
        if (!segment.isWordLike) {
          continue;
        }

        const term = cleanLookupTerm(segment.segment);
        if (!isLookupTerm(term)) {
          continue;
        }

        ranges.push({
          start: segment.index,
          end: segment.index + segment.segment.length,
          term
        });
      }

      return ranges;
    }

    return getFallbackLookupTermRanges(value);
  }

  function getFallbackLookupTermRanges(value) {
    const fallbackPattern = /[A-Za-z\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F]*(?:[’'-][A-Za-z0-9\u00C0-\u024F]+)*|[\u0370-\u03FF\u0400-\u04FF][\u0370-\u03FF\u0400-\u04FF0-9-]*|[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]{1,12}/g;
    const ranges = [];
    let match;

    while ((match = fallbackPattern.exec(value))) {
      const term = cleanLookupTerm(match[0]);
      if (!isLookupTerm(term)) {
        continue;
      }

      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        term
      });
    }

    return ranges;
  }

  function ensureOverlay() {
    if (state.overlay) {
      return state.overlay;
    }

    const host = document.createElement("div");
    host.dataset.geminiTranslatorUi = "true";
    host.style.position = "absolute";
    host.style.zIndex = "2147483647";
    host.style.display = "none";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          color-scheme: light;
          --ink: #23211d;
          --muted: #716c62;
          --paper: #fffdf7;
          --line: #ded6c6;
          --accent: #0f766e;
          --accent-soft: rgba(15, 118, 110, 0.12);
          --mark: #ffe08a;
          all: initial;
          font-family: ui-sans-serif, "PingFang TC", "Noto Sans TC", sans-serif;
        }
        .card {
          width: min(460px, calc(100vw - 24px));
          max-height: min(560px, calc(100vh - 28px));
          overflow: auto;
          border: 1px solid var(--line);
          border-radius: 8px;
          background: var(--paper);
          box-shadow: 0 18px 60px rgba(28, 24, 16, 0.22);
          color: var(--ink);
        }
        .card.has-lookup {
          width: min(760px, calc(100vw - 24px));
        }
        .bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--line);
        }
        .label {
          color: var(--accent);
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        button {
          min-height: 30px;
          border: 1px solid var(--line);
          border-radius: 7px;
          background: white;
          color: var(--ink);
          font: 700 12px/1 ui-sans-serif, "PingFang TC", sans-serif;
          cursor: pointer;
        }
        button:hover {
          border-color: var(--accent);
        }
        .content {
          padding: 12px;
        }
        .card.has-lookup .content {
          display: grid;
          grid-template-columns: minmax(300px, 1fr) 260px;
          gap: 12px;
          align-items: start;
        }
        .source-pane {
          min-width: 0;
        }
        .selected {
          margin: 0 0 10px;
          padding: 8px 10px;
          border-radius: 7px;
          border: 1px solid rgba(15, 118, 110, 0.18);
          background: rgba(255, 255, 255, 0.62);
          font-size: 13px;
          line-height: 1.45;
        }
        .original {
          margin: 0;
          font-family: ui-serif, Georgia, "Times New Roman", serif;
          font-size: 15px;
          line-height: 1.65;
          user-select: text;
          -webkit-user-select: text;
        }
        mark {
          border-radius: 4px;
          background: var(--mark);
          color: inherit;
          padding: 0 2px;
        }
        .gt-word {
          border-radius: 3px;
          cursor: help;
          transition: background 120ms ease, box-shadow 120ms ease;
        }
        .gt-word:hover {
          background: var(--accent-soft);
          box-shadow: 0 0 0 2px var(--accent-soft);
        }
        .lookup {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--line);
        }
        .card.has-lookup .lookup {
          position: sticky;
          top: 0;
          margin-top: 0;
          padding-top: 0;
          padding-left: 12px;
          border-top: 0;
          border-left: 1px solid var(--line);
        }
        .term {
          margin: 0 0 8px;
          font-weight: 800;
        }
        .lookup-result {
          color: var(--ink);
          font-size: 13px;
          line-height: 1.6;
        }
        .lookup-result dl {
          display: grid;
          grid-template-columns: 84px 1fr;
          gap: 6px 10px;
          margin: 8px 0 0;
        }
        .lookup-result dt {
          color: var(--muted);
          font-weight: 800;
        }
        .lookup-result dd {
          margin: 0;
        }
      </style>
      <article class="card">
        <header class="bar">
          <span class="label">原文</span>
          <button class="close" type="button">關閉</button>
        </header>
        <div class="content">
          <div class="source-pane">
            <p class="selected"></p>
            <p class="original"></p>
          </div>
          <section class="lookup" hidden>
            <p class="term"></p>
            <button class="lookup-btn" type="button">查這個字</button>
            <div class="lookup-result"></div>
          </section>
        </div>
      </article>
    `;

    const overlay = {
      host,
      shadow,
      card: shadow.querySelector(".card"),
      selected: shadow.querySelector(".selected"),
      original: shadow.querySelector(".original"),
      close: shadow.querySelector(".close"),
      lookupArea: shadow.querySelector(".lookup"),
      lookupButton: shadow.querySelector(".lookup-btn"),
      lookupResult: shadow.querySelector(".lookup-result"),
      term: shadow.querySelector(".term"),
      currentTerm: "",
      currentContext: ""
    };

    overlay.close.addEventListener("pointerdown", closeOverlayFromEvent, { capture: true });
    overlay.close.addEventListener("click", closeOverlayFromEvent, { capture: true });
    document.addEventListener("pointerdown", (event) => {
      if (!isOverlayVisible()) {
        return;
      }
      if (state.overlay.host.contains(event.target)) {
        return;
      }
      dismissOverlay(true);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOverlayVisible()) {
        dismissOverlay(true);
      }
    });
    attachOverlayInteractions(overlay);
    state.overlay = overlay;
    return overlay;
  }

  function closeOverlayFromEvent(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }
    dismissOverlay(true);
  }

  function isOverlayVisible() {
    return Boolean(state.overlay && state.overlay.host.style.display !== "none");
  }

  function attachOverlayInteractions(overlay) {
    overlay.lookupButton.addEventListener("click", () => lookupSelectedTerm(overlay));
    overlay.original.addEventListener("mouseover", (event) => {
      const word = findWordElement(event.target);
      if (!word) {
        return;
      }
      window.clearTimeout(overlay.hoverTimer);
      overlay.hoverTimer = window.setTimeout(() => {
        prepareTermLookup(overlay, word.dataset.term || word.textContent, true);
      }, 650);
    });
    overlay.original.addEventListener("mouseout", (event) => {
      if (findWordElement(event.target)) {
        window.clearTimeout(overlay.hoverTimer);
      }
    });
    overlay.original.addEventListener("click", (event) => {
      const word = findWordElement(event.target);
      if (word) {
        prepareTermLookup(overlay, word.dataset.term || word.textContent, true);
      }
    });
    overlay.shadow.addEventListener("mouseup", () => {
      setTimeout(() => {
        const shadowSelection = overlay.shadow.getSelection
          ? overlay.shadow.getSelection()
          : window.getSelection();
        handleOverlaySelection(shadowSelection);
      }, 0);
    });
  }

  function findWordElement(target) {
    const element = target?.nodeType === Node.TEXT_NODE
      ? target.parentElement
      : target;
    return element?.closest?.(".gt-word") || null;
  }

  function handleOverlaySelection(selection) {
    const term = selection.toString().trim();
    if (!isLookupTerm(cleanLookupTerm(term))) {
      return;
    }

    const overlay = ensureOverlay();
    prepareTermLookup(overlay, term, false);
  }

  function prepareTermLookup(overlay, rawTerm, fromHover) {
    const term = cleanLookupTerm(rawTerm);
    if (!term) {
      return;
    }

    overlay.currentTerm = term;
    overlay.term.textContent = term;
    overlay.lookupResult.textContent = fromHover
      ? "滑鼠停留偵測到這個字，點下方按鈕查詢。"
      : "";
    overlay.lookupButton.hidden = false;
    overlay.lookupArea.hidden = false;
    overlay.card.classList.add("has-lookup");
    fitOverlayToViewport(overlay);
  }

  function fitOverlayToViewport(overlay) {
    const rect = overlay.host.getBoundingClientRect();
    const overflowRight = rect.right - (window.innerWidth - 12);
    if (overflowRight <= 0) {
      return;
    }

    const currentLeft = Number.parseFloat(overlay.host.style.left || "0");
    const nextLeft = Math.max(window.scrollX + 12, currentLeft - overflowRight);
    overlay.host.style.left = `${nextLeft}px`;
  }

  function cleanLookupTerm(rawTerm) {
    const term = String(rawTerm || "")
      .trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, "");

    if (!isLookupTerm(term)) {
      return "";
    }

    return term.length > 80 ? term.slice(0, 80).trim() : term;
  }

  function isLookupTerm(term) {
    const value = String(term || "").trim();
    if (!LOOKUP_TEXT_PATTERN.test(value)) {
      return false;
    }

    return value.length >= 2 || NON_LATIN_LOOKUP_PATTERN.test(value);
  }

  async function lookupSelectedTerm(overlay) {
    const term = overlay.currentTerm;
    if (!term) {
      return;
    }

    overlay.lookupButton.hidden = true;
    overlay.lookupResult.textContent = "正在查詢字詞。";

    const response = await chrome.runtime.sendMessage({
      type: "LOOKUP_TERM",
      payload: {
        term,
        context: overlay.currentContext
      }
    });

    if (!response?.ok) {
      overlay.lookupResult.textContent = response?.error || "查詢失敗。";
      overlay.lookupButton.hidden = false;
      return;
    }

    overlay.lookupResult.innerHTML = renderLookupResult(response.result);
  }

  function renderLookupResult(result = {}) {
    return `
      <dl>
        <dt>中文</dt>
        <dd>${escapeHtml(result.translation || "")}</dd>
        ${result.reading ? `<dt>讀音</dt><dd>${escapeHtml(result.reading)}</dd>` : ""}
        <dt>詞性</dt>
        <dd>${escapeHtml(result.partOfSpeech || "未標示")}</dd>
        <dt>此處意思</dt>
        <dd>${escapeHtml(result.meaningInContext || "")}</dd>
        <dt>常見用法</dt>
        <dd>${escapeHtml(result.commonUsage || "未提供")}</dd>
        <dt>例句</dt>
        <dd>${escapeHtml(result.example || "未提供")}</dd>
      </dl>
    `;
  }

  function dismissOverlay(clearSelection = false) {
    if (state.overlay) {
      window.clearTimeout(state.overlay.hoverTimer);
      state.overlay.host.style.display = "none";
      state.overlay.host.hidden = true;
    }
    state.overlayClosedUntil = Date.now() + 450;
    if (clearSelection) {
      window.getSelection()?.removeAllRanges();
      state.overlay?.shadow?.getSelection?.()?.removeAllRanges();
    }
  }

  function setupSpaWatcher() {
    setInterval(() => {
      if (state.currentUrl !== location.href) {
        state.currentUrl = location.href;
        dismissOverlay();
        state.mode = "idle";
        state.records = [];
        state.blocks = [];
        state.titleRecord = null;
        state.pageFingerprint = "";
        state.dynamicUpdateDetected = false;
        sendStatus();
      }
    }, 800);
  }

  function setupMutationWatcher() {
    const observer = new MutationObserver((mutations) => {
      if (state.mode !== "translated") {
        return;
      }
      const hasAddedText = mutations.some((mutation) => {
        return Array.from(mutation.addedNodes || []).some((node) => {
          if (isTranslatorUiNode(node)) {
            return false;
          }
          return node.nodeType === Node.TEXT_NODE || node.textContent?.trim();
        });
      });
      if (hasAddedText) {
        state.dynamicUpdateDetected = true;
        sendStatus();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function isTranslatorUiNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    return Boolean(
      node.dataset?.geminiTranslatorUi ||
      node.closest?.("[data-gemini-translator-ui]")
    );
  }

  function progressDetail() {
    if (state.progress < 10) {
      return "正在分析頁面文字與排除程式碼區塊。";
    }
    if (state.progress < 90) {
      return "正在分段送出 Gemini 翻譯，完成後會直接套用在原頁面。";
    }
    return "正在套用翻譯並保存快取。";
  }

  function sendStatus() {
    chrome.runtime.sendMessage({
      type: "PAGE_TRANSLATOR_STATUS",
      status: getStatus()
    }).catch(() => {});
  }

  function ensureTranslatedFontStyle() {
    if (document.querySelector("style[data-gemini-translator-font]")) {
      return;
    }

    const style = document.createElement("style");
    style.dataset.geminiTranslatorFont = "true";
    style.textContent = `
      html[data-gemini-translated="true"] body,
      html[data-gemini-translated="true"] body :not(code):not(pre):not(kbd):not(samp):not(var):not(textarea):not(input):not(select):not(option):not([data-gemini-translator-ui]) {
        font-family: "Microsoft JhengHei", "微軟正黑體", "PingFang TC", "Noto Sans TC", sans-serif !important;
      }
      html[data-gemini-translated="true"] code,
      html[data-gemini-translated="true"] pre,
      html[data-gemini-translated="true"] kbd,
      html[data-gemini-translated="true"] samp,
      html[data-gemini-translated="true"] var {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
      }
      html[data-gemini-translated="true"] em,
      html[data-gemini-translated="true"] i,
      html[data-gemini-translated="true"] cite,
      html[data-gemini-translated="true"] dfn,
      html[data-gemini-translated="true"] [data-gemini-term="true"] {
        font-style: normal !important;
        font-weight: 800 !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
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
})();
