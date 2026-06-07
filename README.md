# Gemini Translator

這是一個 Chrome Extension，用 Gemini API 將目前瀏覽的網頁原地翻譯成繁體中文（台灣用語），並保留原本的排版、圖片、表格、連結、程式碼區塊與數學公式。

## 使用方式

1. 在 Chrome 開啟 `chrome://extensions/`。
2. 打開「開發人員模式」。
3. 點「載入未封裝項目」。
4. 選擇這個資料夾：`/Users/keltonshih/Documents/Chrome翻譯擴充功能`。
5. 點擴充功能圖示，先進入「設定 API Key」。
6. 貼上你的 Gemini API Key，儲存並測試連線。
7. 回到想翻譯的網頁，點「翻譯成中文」。

預設翻譯模型是 `gemini-3.1-flash-lite`。它比 Pro 更適合整頁翻譯這種大量、需要低延遲的工作。

## 主要功能

- 將目前頁面主要文字翻成繁體中文，支援英文、日文、韓文與多種歐文內容。
- 文章可見標題與瀏覽器分頁標題也會一起翻譯。
- 直接替換原 DOM 文字，不把頁面重建成純文字。
- 保留圖片、表格、連結、程式碼區塊、數學公式和大多數頁面互動。
- 可在「原文」與「翻譯」之間即時切換，不重新呼叫 Gemini。
- 同一頁翻譯後會快取，重新整理後可重用。
- 翻譯模式會優先使用微軟正黑體顯示中文。
- 翻譯模式會把原本斜體強調改成粗體，專有名詞、英文縮寫與括號內英文術語也會用粗體顯示。
- 選取翻譯後的中文，會在網頁內顯示對應原文段落。
- 原文段落會標亮對應的原文句子或片段。
- 在原文浮窗內把滑鼠停在英文單字上，或選取英文單字或片語，右側會展開查字卡。

## 目前限制

- API Key 儲存在本機 Chrome Extension storage；這比寫死在程式碼安全，但 Chrome Extension 端仍不能像伺服器端一樣完全保密。
- 第一版用句段與文字節點對應，原文 highlight 是穩定優先，不保證每次都能做到逐字級對齊。
- `chrome://`、Chrome Web Store、其他擴充功能頁與部分受限制頁面無法翻譯。
- SPA 或動態載入的新內容會提示可重新翻譯，但尚未做全自動追翻。
- 超長頁面可能受到 Gemini API Token、速率或 Chrome local storage 空間限制。

## 第一版檔案

- `manifest.json`：Manifest V3 設定。
- `popup.html` / `popup.js` / `popup.css`：擴充功能按鈕彈窗。
- `options.html` / `options.js` / `options.css`：Gemini API Key 設定頁。
- `background.js`：Gemini API 呼叫、設定與快取管理。
- `content.js`：DOM 掃描、翻譯套用、切換、原文浮窗與查字詞功能。
