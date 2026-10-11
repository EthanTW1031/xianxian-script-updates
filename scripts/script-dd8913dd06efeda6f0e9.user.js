// ==UserScript==
// @name         Shopee 帳號預檢
// @namespace    local.shopee.account-precheck
// @version      0.2.1
// @description  預檢作業訊息、明確排除黑名單，分開匯出已確認發送與待處理直播 CSV
// @match        https://seller.shopee.tw/new-webchat/conversations*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* global GM_getValue, GM_setValue, GM_registerMenuCommand, module */
(function accountPrecheck() {
  "use strict";
  const VERSION = "0.2.1";
  const STORE = Object.freeze({ config: "precheck:config:v1", records: "precheck:records:v1", files: "precheck:files:v1", blacklist: "precheck:blacklist:v1", panelPosition: "precheck:panel-position:v1" });
  const DEFAULT_CONFIG = Object.freeze({ template: "此為采兒小鋪作業用訊息,請勿回覆" });
  const HEADERS = Object.freeze(["擷取時間", "直播Session", "限定時段序號", "留言ID", "買家UID", "買家帳號", "原始留言", "正規化留言", "商品代號", "品名", "規格尺寸", "數量", "價格", "狀態", "待確認", "來源", "喊單則數", "彙總件數"]);
  const LABELS = Object.freeze({ ready: "尚未發送", sent: "已送出", manualSent: "已人工送出", blocked: "黑名單排除", searchUnconfirmed: "搜尋未確認", notFound: "搜尋未確認（舊紀錄）", pending: "可能已送出", draft: "有草稿，沒發", failed: "失敗，可再試" });
  const PANEL_SELECTOR = "[data-account-precheck],[data-settlement-notice],[data-winlist-shopee]";
  const LOCK_NAME = "shopee-settlement-notice:send";
  const CHAT_SELECTORS = Object.freeze({ searchInputs: ['input[placeholder="搜尋全部"]', 'input[placeholder*="搜尋"]'], composers: ['textarea[placeholder="輸入文字"]', 'textarea[placeholder*="輸入"]', '[contenteditable="true"][role="textbox"]'] });
  const norm = value => String(value ?? "").normalize("NFKC").replace(/\uFEFF/gu, "").replace(/\s+/gu, " ").trim();
  const multiline = value => String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/gu, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  function problem(code, message) { const error = new Error(message); error.code = code; return error; }
  function renderMessage(config, account) {
    const message = multiline(config.template).replace(/\{買家\}/gu, () => account);
    if (!message || message.length > 2000) throw problem("TEMPLATE", "作業用訊息不可空白，請控制在 2000 字元以內。");
    return message;
  }
  function validateConfig(input) { const config = { template: multiline(input?.template) }; renderMessage(config, "預覽帳號"); return config; }
  function effectiveBuyerText(value) {
    if (value == null) return { ok: true, text: "" };
    if (typeof value === "string") return { ok: true, text: value };
    if (typeof value !== "object" || Object.prototype.toString.call(value) === "[object Date]") return { ok: false, text: "" };
    if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) return { ok: typeof value.result === "string", text: typeof value.result === "string" ? value.result : "" };
    if (typeof value.text === "string") return { ok: true, text: value.text };
    if (Array.isArray(value.richText) && value.richText.every(part => typeof part?.text === "string")) return { ok: true, text: value.richText.map(part => part.text).join("") };
    return { ok: false, text: "" };
  }
  function validateBuyerAccount(value) {
    const extracted = effectiveBuyerText(value);
    let text = extracted.text.trim();
    const wrapped = text.match(/^="((?:[^"]|"")*)"$/u);
    if (wrapped) text = wrapped[1].replace(/""/gu, '"');
    text = norm(text);
    const converted = /^(?:\d+-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:-\d{2})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}|\d+月\d+日|\d{4}\/\d{1,2}\/\d{1,2}|[+-]?\d+(?:\.\d+)?E[+-]\d+|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|TRUE|FALSE|#NAME\?|#VALUE!|#REF!|#DIV\/0!|#N\/A|#NUM!|#NULL!)$/u.test(text);
    return { ok: extracted.ok && !converted, text };
  }
  function parseBlacklist(value) {
    const lines = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/u);
    const accounts = lines.map(line => validateBuyerAccount(line));
    if (accounts.some(account => !account.ok || /\s/u.test(account.text))) throw problem("BLACKLIST", "黑名單請每行填一個完整買家帳號，不可使用日期、科學記號或含空白的帳號。");
    return [...new Set(accounts.map(account => account.text).filter(Boolean))];
  }
  function itemState(queue, records, item) {
    return queue.blacklist?.includes(item.account) ? "blocked" : recordState(records, queue.batchId, item.account);
  }

  // 切欄與控貨助手 parseCsv 相同，額外保留每筆原文與空白筆，供無損刪列。
  function splitCsv(text) {
    const source = String(text).replace(/^\uFEFF/u, ""), records = [];
    let fields = [], field = "", quoted = false, start = 0;
    function push(end, ending = "") { fields.push(field.replace(/\r$/u, "")); records.push({ raw: source.slice(start, end), ending, fields, row: records.length + 1 }); fields = []; field = ""; }
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { fields.push(field); field = ""; }
      else if (ch === "\n") { const end = i > start && source[i - 1] === "\r" ? i - 1 : i; push(end, source.slice(end, i + 1)); start = i + 1; }
      else field += ch;
    }
    if (quoted) throw problem("CSV_QUOTE", "直播 CSV 有未閉合的雙引號，請使用抓單匯出的原檔。");
    if (start < source.length) push(source.length);
    return records;
  }
  const blankRecord = record => !record.fields.some(cell => String(cell).trim());
  function parseSource(buffer, filename) {
    if (!/\.csv$/iu.test(filename) || filename.startsWith("~$")) throw problem("FILE", "請選擇 .csv 直播原始檔，勿選 Excel 暫存鎖定檔。");
    const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw problem("UTF8", "檔案不是合法的 UTF-8，可能被 Excel 另存過，請用抓單匯出的原檔。"); }
    const records = splitCsv(text);
    if (!records.length) throw problem("EMPTY", "檔案是空的，請選擇抓單匯出的原檔。");
    const actual = records[0].fields.map(value => value.trim());
    if (![HEADERS.length, HEADERS.length + 1].includes(actual.length) ||
        HEADERS.some((value, i) => actual[i] !== value) ||
        (actual.length === HEADERS.length + 1 && actual.at(-1) !== "喊單歷程")) throw problem("HEADERS", `表頭必須是直播固定 18 欄，或在其後加第 19 欄「喊單歷程」，且順序相同。實際表頭：${actual.join("｜") || "（空白）"}`);
    let sourceRows = 0, inactiveRows = 0, emptyAccountRows = 0;
    const active = new Set(), rowCounts = new Map(), issues = [];
    for (const record of records.slice(1)) {
      if (blankRecord(record)) continue;
      sourceRows++;
      if (record.fields.length !== actual.length) throw problem("WIDTH", `第 ${record.row} 列不是 ${actual.length} 格（實際 ${record.fields.length} 格），整份未匯入。`);
      const account = validateBuyerAccount(record.fields[5]);
      if (!account.ok) issues.push(`第 ${record.row} 列：帳號疑似被 Excel 轉型，請核對抓單匯出的原檔。`);
      record.account = account.text;
      if (account.text) rowCounts.set(account.text, (rowCounts.get(account.text) || 0) + 1);
      const inactive = record.fields[13].trim() === "inactiveCode";
      if (inactive) inactiveRows++;
      if (!account.text) emptyAccountRows++;
      if (!inactive && account.text) active.add(account.text);
    }
    if (issues.length) throw problem("ACCOUNT", issues.join("\n"));
    if (!sourceRows) throw problem("EMPTY", "檔案只有表頭，沒有資料列，整份未匯入。");
    const accounts = [...active].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
    return { name: filename, bytes, text, records, accounts, rowCounts, sourceRows, inactiveRows, emptyAccountRows, bom: text.startsWith("\uFEFF"), newline: /\r?\n/u.exec(text)?.[0] || "\n", trailing: text.endsWith("\n") };
  }
  async function readSource(buffer, filename) {
    const entry = parseSource(buffer, filename);
    const hash = await crypto.subtle.digest("SHA-256", entry.bytes);
    entry.hash = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return entry;
  }
  function batchId(hash, round) { return `precheck:${hash}:${round}`; }
  function recordKey(scope, account) { return JSON.stringify([scope, account]); }
  function recordState(records, scope, account) { return records[recordKey(scope, account)]?.status || "ready"; }
  function buildQueue(entry, input, round = 0, blacklist = []) {
    const config = validateConfig(input);
    return { batchId: batchId(entry.hash, round), blacklist: parseBlacklist(blacklist), items: entry.accounts.map(account => ({ account, message: renderMessage(config, account), rowCount: entry.rowCounts.get(account) || 0 })) };
  }
  function runnableItems(queue, records) { return queue.items.filter(item => ["ready", "failed"].includes(itemState(queue, records, item))); }
  function countsFor(queue, records) {
    const counts = Object.fromEntries(Object.keys(LABELS).map(key => [key, 0]));
    for (const item of queue.items) counts[itemState(queue, records, item)]++;
    return counts;
  }
  function streakWarning(queue, records) {
    let count = 0, maximum = 0;
    for (const item of queue.items) { count = ["notFound", "searchUnconfirmed"].includes(itemState(queue, records, item)) ? count + 1 : 0; maximum = Math.max(maximum, count); }
    return maximum >= 3 ? `有 ${maximum} 位連續搜尋未確認，請先確認網路與搜尋畫面，再手動重查。` : "";
  }
  function pruneFiles(files, records, entry) {
    const prior = files.entries.find(file => file.hash === entry.hash);
    const updated = { hash: entry.hash, round: prior?.round || 0, name: entry.name, usedAt: new Date().toISOString() };
    const entries = [updated, ...files.entries.filter(file => file.hash !== entry.hash)].slice(0, 20);
    const retained = new Set(entries.map(file => file.hash)), nextRecords = {};
    for (const [key, record] of Object.entries(records)) {
      const hash = /^precheck:([a-f0-9]{64}):\d+$/u.exec(record.batchId)?.[1];
      if (retained.has(hash)) nextRecords[key] = record;
    }
    return { files: { ...files, entries }, records: nextRecords, round: updated.round };
  }
  function toCsv(rows) {
    return "\uFEFF" + rows.map((row, rowIndex) => row.map((value, colIndex) => {
      let text = String(value ?? "");
      // 帳號用固定文字公式保存，Excel 開啟 CSV 時不會吞掉前導零。
      // 公式只有跳脫過的字串常數，帳號內的等號等字元不會被當成運算。
      if (rowIndex > 0 && colIndex === 0) text = `="${text.replace(/"/gu, '""')}"`;
      else if (/^[=+@\-\t\r]/u.test(text)) text = `'${text}`;
      return `"${text.replace(/"/gu, '""')}"`;
    }).join(",")).join("\r\n");
  }
  function listCsv(queue, records) {
    const priority = { blocked: 0, notFound: 1, searchUnconfirmed: 1, pending: 1, draft: 1, failed: 1, ready: 1, sent: 2, manualSent: 2 };
    const items = [...queue.items].sort((a, b) => priority[itemState(queue, records, a)] - priority[itemState(queue, records, b)]);
    return toCsv([["買家帳號", "這位在檔裡有幾列", "狀態", "說明", "時間"], ...items.map(item => {
      const record = records[recordKey(queue.batchId, item.account)];
      return [item.account, item.rowCount, LABELS[itemState(queue, records, item)], itemState(queue, records, item) === "blocked" ? "使用者明確列入黑名單，不發送、不納入叫貨檔" : record?.detail || "", record?.time || ""];
    })]);
  }
  function exportPartition(entry, queue, records, pendingOnly = false) {
    const counts = countsFor(queue, records), blocked = new Set([...(queue.blacklist || []), ...queue.items.filter(item => itemState(queue, records, item) === "blocked").map(item => item.account)]);
    const accepted = new Set(queue.items.filter(item => ["sent", "manualSent"].includes(itemState(queue, records, item))).map(item => item.account));
    if (!queue.items.length) throw problem("QUEUE", "檔案沒有可預檢的買家，請核對原檔。");
    const select = record => !blocked.has(record.account) && (pendingOnly ? !accepted.has(record.account) : accepted.has(record.account));
    const kept = entry.records.filter((record, index) => index === 0 || blankRecord(record) || select(record));
    if (!kept.slice(1).some(record => !blankRecord(record))) throw problem(pendingOnly ? "NO_PENDING" : "NO_CONFIRMED", pendingOnly ? "沒有待處理資料。" : "沒有已確認發送成功的買家，不能產生叫貨用直播檔；請先處理待處理名單。");
    const removedRows = entry.records.length - kept.length;
    const text = removedRows ? (entry.bom ? "\uFEFF" : "") + kept.map(record => record.raw + record.ending).join("") : entry.text;
    const check = splitCsv(text);
    if (check.length !== kept.length || check.some((record, i) => record.raw !== kept[i].raw || (i > 0 && !blankRecord(record) && !select({ account: validateBuyerAccount(record.fields[5]).text })))) throw problem("EXPORT_CHECK", "匯出自我檢查未通過，沒有下載，請保留原檔並重新核對。");
    const pendingCount = queue.items.length - accepted.size - counts.blocked;
    const blockedRows = entry.records.filter(record => blocked.has(record.account)).length;
    const messages = [pendingOnly ? "這是待處理直播檔，尚未確認可發送，請勿拿來叫貨。" : "只匯出已確認發送成功的買家，供控貨助手建立新場次。",
      `已確認：${accepted.size} 位（自動 ${counts.sent}、人工 ${counts.manualSent}）。`, `待處理：${pendingCount} 位；黑名單排除：${counts.blocked} 位、${blockedRows} 列。`,
      `此檔保留 ${kept.slice(1).filter(record => !blankRecord(record)).length} 列；原檔不修改。`];
    if (!pendingOnly && pendingCount) messages.push("未確認者沒有放進這份檔；可另外匯出待處理直播檔，處理成功後重新匯出並建立新場次。");
    const warning = streakWarning(queue, records); if (warning) messages.push(warning);
    messages.push("確定匯出？");
    return { text, bytes: removedRows ? new TextEncoder().encode(text) : entry.bytes, confirmation: messages.join("\n"), filename: entry.name.replace(/\.csv$/iu, "") + (pendingOnly ? "_待處理.csv" : "_僅已確認發送.csv"), removedRows };
  }
  function filteredExport(entry, queue, records) { return exportPartition(entry, queue, records); }
  function pendingExport(entry, queue, records) { return exportPartition(entry, queue, records, true); }
  function visible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }
  function firstVisible(selectors) {
    for (const selector of selectors) { const element = [...document.querySelectorAll(selector)].find(element => visible(element) && !element.closest(PANEL_SELECTOR)); if (element) return element; }
    return null;
  }
  function detectSecurityChallenge() {
    if (['iframe[src*="captcha" i]', 'iframe[src*="challenge" i]', 'iframe[title*="captcha" i]', '[class*="captcha" i]', '[id*="captcha" i]'].some(selector => [...document.querySelectorAll(selector)].some(element => visible(element) && !element.closest(PANEL_SELECTOR)))) return true;
    return [...document.querySelectorAll('[role="dialog"], [class*="modal" i]')].filter(element => visible(element) && !element.closest(PANEL_SELECTOR)).some(element => /拼圖驗證|完成拼圖|安全驗證|請驗證|captcha|security challenge/iu.test(norm(element.textContent)));
  }
  function assertSafe(stopRequested) {
    if (stopRequested?.()) throw problem("STOP", "已停止。");
    if (navigator.onLine === false) throw problem("SEARCH_UNRELIABLE", "電腦目前沒有網路，已停止。網路恢復後按開始，會從這一位接著跑。");
    if (detectSecurityChallenge()) throw problem("SECURITY_CHALLENGE", "偵測到拼圖／安全驗證，已停止，請人工處理。");
    const otherStop = document.querySelector('[data-winlist-shopee="1"]')?.shadowRoot?.querySelector("[data-stop]");
    if (otherStop && !otherStop.classList.contains("wl-hidden") && visible(otherStop)) throw problem("OTHER_SENDER", "明細腳本正在發送，請先停止明細發送再執行帳號預檢。");
  }
  async function waitFor(predicate, timeoutMs, stopRequested) {
    const deadline = Date.now() + timeoutMs;
    do { assertSafe(stopRequested); const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < deadline);
    assertSafe(stopRequested);
    return null;
  }
  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value); else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function composerText(composer) { return composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent; }
  function setComposer(composer, text) {
    if (composer instanceof HTMLTextAreaElement) setNativeValue(composer, text);
    else { composer.textContent = text; composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); }
  }
  function activateElement(element, horizontalRatio = 0.5) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    const clientX =
      rect.left +
      rect.width * Math.min(0.9, Math.max(0.1, horizontalRatio));
    const clientY = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(clientX, clientY);
    const target =
      topElement &&
      (element.contains(topElement) || topElement.contains(element))
        ? topElement
        : element;
    // 重要修正（v1.1.4）：不要傳 view。
    // Tampermonkey 沙箱裡的 window 是包裝物件，無法被轉成 UIEventInit.view 要求的
    // 真正 Window，會讓 PointerEvent/MouseEvent 建構子在第一步就拋
    // "Failed to construct 'PointerEvent': ... Failed to convert value to 'Window'"，
    // 導致整個點擊完全沒發生（搜尋得到卻點不進買家）。一般點擊不需要 view。
    // MouseEvent 與 PointerEvent 各自用不含 view 的 init，欄位分開避免互相污染。
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      detail: 1,
    };
    const pointerInit = {
      ...mouseInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0.5,
    };
    if (typeof target.focus === "function") target.focus();
    const PointerCtor =
      typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    target.dispatchEvent(new PointerCtor("pointerover", pointerInit));
    target.dispatchEvent(new MouseEvent("mouseover", mouseInit));
    target.dispatchEvent(new PointerCtor("pointerdown", pointerInit));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    target.dispatchEvent(new PointerCtor("pointerup", { ...pointerInit, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { ...mouseInit, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", { ...mouseInit, buttons: 0 }));
  }

  function exactSearchResult(account, input) {
    const inputRect = input.getBoundingClientRect();
    return [...document.querySelectorAll("div,li,span,p")].filter(element => visible(element) && norm(element.textContent) === account && !element.closest(PANEL_SELECTOR)).map(label => {
      let row = label;
      while (row.parentElement) { const rect = row.getBoundingClientRect(); if (rect.width >= 180 && rect.height >= 32 && rect.height <= 100) break; row = row.parentElement; }
      return { row, label };
    }).filter(({ row }) => {
      const rect = row.getBoundingClientRect();
      return norm(row.textContent) === account && rect.left <= inputRect.right + 80 && rect.right >= inputRect.left - 30 && rect.top >= inputRect.bottom - 10 && rect.height >= 32 && rect.height <= 100;
    }).sort((a, b) => a.label.getBoundingClientRect().width * a.label.getBoundingClientRect().height - b.label.getBoundingClientRect().width * b.label.getBoundingClientRect().height)[0] || null;
  }
  function exactConversationHeader(account, input) {
    const inputRect = input.getBoundingClientRect();
    return [...document.querySelectorAll("div,span,p,h1,h2,h3")].find(element => visible(element) && !element.closest(PANEL_SELECTOR) && norm(element.textContent) === account && element.getBoundingClientRect().left > inputRect.right + 30 && element.getBoundingClientRect().top < 320) || null;
  }
  function findSendButton(composer) {
    const box = composer.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('button:not([disabled]),[role="button"]:not([aria-disabled="true"]),[aria-label*="send" i],[aria-label*="送出"],[aria-label*="發送"],[title*="send" i],[title*="送出"],[title*="發送"],[class*="send" i],[data-testid*="send" i],svg.chat-icon,svg')]
      .map(element => element.closest('button,[role="button"],[tabindex]:not([tabindex="-1"])') || element)
      .filter((element, index, items) => items.indexOf(element) === index && visible(element) && !element.closest(PANEL_SELECTOR) && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true")
      .map(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12 || rect.width > 120 || rect.height > 120 || rect.right < box.right - 150 || rect.left > box.right + 50 || rect.bottom < box.top - 25 || rect.top > box.bottom + 45) return null;
        const metadata = ["aria-label", "title", "data-testid", "class"].map(name => element.getAttribute(name)).join(" ") + element.id;
        const text = norm(element.textContent);
        let score = 300 - Math.abs(rect.right - box.right) - Math.abs(rect.bottom - box.bottom);
        if (/send|submit|送出|發送/iu.test(metadata)) score += 500;
        if (/send|submit|送出|發送/iu.test(text)) score += 300;
        if (element.tagName === "BUTTON") score += 60;
        if (text && !/send|submit|送出|發送/iu.test(text)) score -= 120;
        return { element, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }
  function searchKey(element, key, keyCode) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, "keyCode", { get: () => keyCode }); Object.defineProperty(event, "which", { get: () => keyCode }); element.dispatchEvent(event);
    }
  }
  async function sendOne(item, { dryRun, stopRequested, beforeClick, onClick }) {
    let composer = null, clicked = false, input = null, filled = false;
    try {
      input = await waitFor(() => firstVisible(CHAT_SELECTORS.searchInputs), 10000, stopRequested);
      if (!input) throw problem("SEARCH_INPUT", "找不到搜尋框。");
      input.focus(); setNativeValue(input, ""); setNativeValue(input, item.account);
      const result = await waitFor(() => exactSearchResult(item.account, input), 20000, stopRequested);
      if (!result) {
        assertSafe(stopRequested);
        if (!visible(input) || !document.contains(input) || norm(input.value) !== item.account) throw problem("SEARCH_UNRELIABLE", "搜尋框不見了或搜尋文字變了，已停止。這一位還沒查，請確認畫面正常後按開始。");
        throw problem("SEARCH_UNCONFIRMED", "20 秒內未辨識到完全相同的搜尋結果，搜尋未確認，未送出；可人工核對後手動重查。");
      }
      assertSafe(stopRequested); activateElement(result.label);
      let verified = await waitFor(() => exactConversationHeader(item.account, input), 2500, stopRequested);
      if (!verified) { assertSafe(stopRequested); activateElement(result.row, 0.2); verified = await waitFor(() => exactConversationHeader(item.account, input), 2500, stopRequested); }
      if (!verified) { input.focus(); searchKey(input, "ArrowDown", 40); searchKey(input, "Enter", 13); verified = await waitFor(() => exactConversationHeader(item.account, input), 3000, stopRequested); }
      if (!verified) throw problem("HEADER", "右側對話帳號無法核對，未送出。");
      composer = await waitFor(() => firstVisible(CHAT_SELECTORS.composers), 8000, stopRequested);
      if (!composer) throw problem("COMPOSER", "找不到訊息輸入框，未送出。");
      if (multiline(composerText(composer))) throw problem("DRAFT", "買家對話已有草稿，帳號找得到；保留草稿，這位沒發。");
      if (dryRun) return;
      assertSafe(stopRequested);
      if (!exactConversationHeader(item.account, input)) throw problem("HEADER", "對話帳號已變動，未送出。");
      composer.focus(); setComposer(composer, item.message); filled = true;
      const button = await waitFor(() => findSendButton(composer), 5000, stopRequested);
      if (!button) throw problem("SEND_BUTTON", "找不到送出按鈕，未送出。");
      assertSafe(stopRequested);
      if (!exactConversationHeader(item.account, input) || !document.contains(composer) || multiline(composerText(composer)) !== multiline(item.message)) throw problem("CHAT_CHANGED", "對話或通知內容已變動，未送出。");
      // 在送出前持久保存 pending。即使關頁／斷線，重新匯入也不會自動重發。
      beforeClick();
      assertSafe(stopRequested);
      clicked = true; onClick?.(); activateElement(button);
      const cleared = await waitFor(() => document.contains(composer) && exactConversationHeader(item.account, input) && composerText(composer) === "", 7000, stopRequested);
      if (!cleared) throw problem("SEND_UNCERTAIN", "已點送出但未確認輸入框清空，請人工查看聊聊，暫停自動重試。");
    } finally {
      // 只清除本腳本填入、尚未點送出的文字；不動原草稿或可能已送出的對話。
      if (!clicked && filled && composer && document.contains(composer) && input && exactConversationHeader(item.account, input) && multiline(composerText(composer)) === multiline(item.message)) setComposer(composer, "");
    }
  }
  function download(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function init() {
    if (document.querySelector("[data-account-precheck]")) return;
    const host = document.createElement("div"); host.setAttribute("data-account-precheck", "1"); document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const state = { entry: null, queue: null, round: 0, running: false, importing: false, stop: false, logs: [], configValid: true, blacklist: [] };
    try { state.blacklist = parseBlacklist(GM_getValue(STORE.blacklist, [])); }
    catch (error) { host.remove(); throw error; }
    let config;
    const savedConfig = GM_getValue(STORE.config, DEFAULT_CONFIG);
    try { config = validateConfig(savedConfig); }
    catch { config = { template: typeof savedConfig?.template === "string" ? savedConfig.template : "" }; state.configValid = false; }
    root.innerHTML = `<style>
      :host{all:initial;font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#253047}*{box-sizing:border-box}
      .panel{position:fixed;left:18px;top:18px;width:440px;max-width:calc(100vw - 36px);max-height:88vh;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 8px 32px #0003;z-index:2147483646;overflow:hidden}
      header{padding:10px 14px;background:#116466;color:white;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;touch-action:none}.dragging header{cursor:grabbing}header button{background:#ffffff25;color:white;border:0}
      .body{padding:14px;max-height:calc(88vh - 48px);overflow:auto}.closed .body,.hidden{display:none}h3{font-size:15px;margin:8px 0}p{margin:8px 0}.mini{font-size:12px;color:#566277}
      label{display:block;margin:8px 0}input,textarea,select,button{font:inherit}textarea,select{width:100%;padding:7px;border:1px solid #b8c2d1;border-radius:6px;background:white;color:#253047}textarea{resize:vertical;min-height:90px}
      .actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}button{padding:7px 10px;border:1px solid #b8c2d1;border-radius:6px;background:#f6f7fa;cursor:pointer}button.primary{background:#116466;color:white}button.danger{background:#b91c1c;color:white}button:disabled{opacity:.5;cursor:default}
      .check{display:flex;gap:8px;align-items:start}.check input{margin-top:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f8f7;padding:10px;border-radius:6px;margin:8px 0}.status,.file{white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#b91c1c}.warning{color:#9a3412}.log{font-size:12px;max-height:140px;overflow:auto}.stop{position:sticky;bottom:0;width:100%;margin-top:8px}
    </style><section class="panel"><header><strong>帳號預檢 v${VERSION}</strong><button data-collapse>收合</button></header><div class="body">
      <h3>1. 作業用訊息</h3><label>訊息文字<textarea data-config="template"></textarea></label><p class="mini">可用 {買家} 代入帳號。修改後會保存，請重新核對並勾授權。</p>
      <details><summary>黑名單（不發送、不納入叫貨檔）</summary><label>每行一個完整帳號<textarea data-blacklist></textarea></label><button data-save-blacklist>儲存黑名單</button><p class="mini">只以此名單判定黑名單；缺少輸入框不會自動判成黑名單。修改後需按儲存才生效。名單僅存於本腳本。</p><p data-blacklist-status></p></details>
      <h3>2. 匯入直播原始檔</h3><input data-files type="file" accept=".csv"><p class="mini">一次一份抓單匯出的原始 CSV。沒喊單的留言和沒有帳號的列不發訊息。</p><p data-resume class="status"></p><div data-file-list class="file"></div><p data-summary class="status"></p>
      <h3>3. 買家預覽</h3><select data-preview-select></select><p data-source class="mini"></p><pre data-preview>請先匯入直播原始檔。</pre><div class="actions"><button data-mark-manual>這位作業訊息已人工送出</button><button data-mark-blocked>這位列入黑名單</button></div>
      <h3>4. 核對後啟動</h3><label class="check"><input data-dry type="checkbox" checked><span>演練：只搜尋前 3 位尚未發送的買家，不填訊息、不送出。</span></label><p class="mini">正式發送每位間隔 15～25 秒。請留在此分頁，電腦不要睡眠，預檢時不要開始發明細。</p>
      <label class="check"><input data-authorize type="checkbox"><span>我已核對買家帳號與完整訊息，授權本次操作。</span></label><button data-start class="primary">開始演練</button><p data-status class="status"></p><button data-stop class="danger stop hidden">緊急停止</button>
      <h3>5. 匯出與處理</h3><div class="actions"><button data-export-filtered>匯出僅已確認發送的直播檔</button><button data-export-pending>匯出待處理直播檔</button><button data-export-list>匯出名單與結果</button></div><div data-not-found class="hidden"><p>目前搜尋未確認的帳號：</p><pre data-not-found-list></pre><button data-recheck>搜尋未確認的重新查一次</button></div><p class="mini">待處理檔不能拿來叫貨。處理成功後須重新匯出，並用新檔建立新場次。</p><p data-streak class="warning"></p>
      <details><summary>這份檔重新全部發一次</summary><p class="mini">已發過的人會再收到一次，請確認有需要才按。</p><button data-new-round>這份檔重新全部發一次</button></details><h3>紀錄</h3><pre data-log class="log"></pre>
    </div></section>`;
    const $ = selector => root.querySelector(selector), panel = $(".panel"), header = $("header");
    const savedPosition = GM_getValue(STORE.panelPosition, null);
    let drag = null;
    function placePanel(left, top) {
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.min(Math.max(8, left), Math.max(8, window.innerWidth - rect.width - 8))}px`;
      panel.style.top = `${Math.min(Math.max(8, top), Math.max(8, window.innerHeight - rect.height - 8))}px`;
      panel.style.right = "auto"; panel.style.bottom = "auto";
    }
    function savePanelPosition() {
      const rect = panel.getBoundingClientRect();
      GM_setValue(STORE.panelPosition, { left: Math.round(rect.left), top: Math.round(rect.top) });
    }
    function keepPanelInView() {
      if (!panel.style.top) return;
      const rect = panel.getBoundingClientRect(); placePanel(rect.left, rect.top);
    }
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      placePanel(Number.isFinite(savedPosition?.left) ? savedPosition.left : rect.left, Number.isFinite(savedPosition?.top) ? savedPosition.top : rect.top);
    });
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      header.setPointerCapture(event.pointerId); panel.classList.add("dragging"); event.preventDefault();
    });
    header.addEventListener("pointermove", event => {
      if (drag?.id === event.pointerId) placePanel(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });
    function finishDrag(event) {
      if (!drag || (event?.pointerId != null && drag.id !== event.pointerId)) return;
      const id = drag.id; drag = null; panel.classList.remove("dragging"); savePanelPosition();
      if (header.hasPointerCapture(id)) header.releasePointerCapture(id);
    }
    header.addEventListener("pointerup", finishDrag);
    header.addEventListener("pointercancel", finishDrag);
    header.addEventListener("lostpointercapture", finishDrag);
    window.addEventListener("blur", () => finishDrag());
    window.addEventListener("resize", () => { keepPanelInView(); savePanelPosition(); });
    if (typeof ResizeObserver === "function") new ResizeObserver(keepPanelInView).observe(panel);
    const showStatus = (message, error = false) => { $("[data-status]").textContent = message; $("[data-status]").className = `status ${error ? "error" : ""}`; };
    const log = message => { state.logs.push(`${new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })} ${message}`); state.logs = state.logs.slice(-300); $("[data-log]").textContent = state.logs.join("\n"); $("[data-log]").scrollTop = $("[data-log]").scrollHeight; };
    function readRecords() {
      const records = GM_getValue(STORE.records, {});
      if (!records || typeof records !== "object" || Array.isArray(records) || Object.entries(records).some(([key, record]) => !record || !Object.hasOwn(LABELS, record.status) || record.status === "ready" || key !== recordKey(record.batchId, record.account))) throw problem("RECORDS", "預檢紀錄格式有問題，已停止。請保留紀錄並請人協助檢查。");
      return records;
    }
    function readFiles() {
      const files = GM_getValue(STORE.files, { entries: [], last: null });
      if (!files || !Array.isArray(files.entries) || files.entries.some(file => !/^[a-f0-9]{64}$/u.test(file.hash) || !Number.isSafeInteger(file.round) || file.round < 0)) throw problem("RECORDS", "預檢檔案紀錄格式有問題，請保留紀錄並請人協助檢查。");
      return files;
    }
    function updateLast() {
      const files = readFiles(), counts = countsFor(state.queue, readRecords());
      files.last = { name: state.entry.name, hash: state.entry.hash, total: state.queue.items.length, completed: state.queue.items.length - counts.ready, time: new Date().toISOString() };
      GM_setValue(STORE.files, files);
    }
    function writeRecord(item, status, code, detail) {
      const records = readRecords();
      records[recordKey(state.queue.batchId, item.account)] = { account: item.account, batchId: state.queue.batchId, status, code, detail, time: new Date().toISOString() };
      try { GM_setValue(STORE.records, records); updateLast(); }
      catch (error) { throw problem("STORAGE", `紀錄無法保存，已停止，請保留頁面並請人協助檢查。${error.message}`); }
    }
    function assertCurrentFile() {
      if (readFiles().entries.find(file => file.hash === state.entry?.hash)?.round !== state.round) throw problem("FILE_CHANGED", "另一分頁已重設或移除這份檔的紀錄，請重新匯入原檔再核對。");
      state.blacklist = parseBlacklist(GM_getValue(STORE.blacklist, []));
      if (state.queue) state.queue.blacklist = state.blacklist;
      if (JSON.stringify(parseBlacklist($("[data-blacklist]").value)) !== JSON.stringify(state.blacklist)) throw problem("BLACKLIST_UNSAVED", "黑名單尚未儲存或已在另一分頁變動，請先核對並儲存黑名單。");
    }
    function lockControls() {
      const locked = state.running || state.importing;
      for (const element of root.querySelectorAll("input,textarea,select,button")) if (!element.matches("[data-stop],[data-collapse]")) element.disabled = locked;
      $("[data-start]").disabled = locked || !state.configValid || !state.queue?.items.length;
      for (const selector of ["[data-export-filtered]", "[data-export-pending]", "[data-export-list]", "[data-new-round]", "[data-recheck]", "[data-mark-manual]", "[data-mark-blocked]"]) $(selector).disabled = locked || !state.entry;
      const selected = state.queue?.items.find(item => item.account === $("[data-preview-select]").value);
      $("[data-mark-manual]").disabled = locked || !state.configValid || !selected || itemState(state.queue, readRecords(), selected) === "blocked";
      $("[data-mark-blocked]").disabled = locked || !selected || state.blacklist.includes(selected.account);
      $("[data-stop]").classList.toggle("hidden", !state.running);
    }
    function refreshPreview() {
      const item = state.queue?.items.find(buyer => buyer.account === $("[data-preview-select]").value);
      $("[data-preview]").textContent = state.configValid ? item?.message || "請先匯入直播原始檔。" : "訊息尚未完成，請修正後核對預覽。";
      $("[data-source]").textContent = item ? `這位在檔裡有 ${item.rowCount} 列；狀態：${LABELS[itemState(state.queue, readRecords(), item)]}` : "";
      $("[data-mark-manual]").disabled = state.running || state.importing || !item || itemState(state.queue, readRecords(), item) === "blocked";
    }
    function render() {
      try {
        const records = readRecords(), files = readFiles(), previous = $("[data-preview-select]").value;
        $("[data-resume]").textContent = !state.entry && files.last && files.last.completed < files.last.total ? `上次的檔 ${files.last.name} 查到 ${files.last.completed}／${files.last.total} 位。重新選同一份檔，就會接著跑，已送出的人不會再收到訊息；失敗的會再試。` : "";
        if (state.entry) {
          const entry = state.entry, counts = countsFor(state.queue, records);
          $("[data-file-list]").textContent = `${entry.name}\n${entry.sourceRows} 列資料、${state.queue.items.length} 位買家。\n沒喊單的留言 ${entry.inactiveRows} 列、沒有帳號 ${entry.emptyAccountRows} 列，這些不發訊息。`;
          $("[data-summary]").textContent = Object.keys(LABELS).map(status => `${LABELS[status]} ${counts[status]} 位`).join("、");
          $("[data-preview-select]").innerHTML = state.queue.items.map(item => `<option value="${escapeHtml(item.account)}">${escapeHtml(item.account)}</option>`).join("");
          if (state.queue.items.some(item => item.account === previous)) $("[data-preview-select]").value = previous;
          const missing = state.queue.items.filter(item => ["notFound", "searchUnconfirmed"].includes(itemState(state.queue, records, item)));
          $("[data-not-found]").classList.toggle("hidden", !missing.length); $("[data-not-found-list]").textContent = missing.map(item => item.account).join("\n");
          $("[data-streak]").textContent = streakWarning(state.queue, records);
        }
        refreshPreview(); lockControls();
      } catch (error) { state.configValid = false; lockControls(); showStatus(error.message, true); }
    }
    $("[data-config]").value = config.template;
    $("[data-blacklist]").value = state.blacklist.join("\n");
    function saveBlacklist(accounts) {
      const next = parseBlacklist(accounts);
      GM_setValue(STORE.blacklist, next); state.blacklist = next;
      $("[data-blacklist]").value = next.join("\n");
      if (state.queue) state.queue.blacklist = next;
      $("[data-authorize]").checked = false;
      $("[data-blacklist-status]").textContent = `已儲存 ${next.length} 位黑名單。`;
      render();
    }
    $("[data-blacklist]").addEventListener("input", () => { $("[data-authorize]").checked = false; $("[data-blacklist-status]").textContent = "尚未儲存，請按儲存黑名單。"; });
    $("[data-save-blacklist]").addEventListener("click", async () => {
      if (state.running || state.importing) return;
      try { await withLock(() => saveBlacklist($("[data-blacklist]").value)); } catch (error) { showStatus(error.message, true); }
    });
    async function resolveSelected(manual) {
      if (state.running || state.importing || !state.entry) return;
      const item = state.queue.items.find(buyer => buyer.account === $("[data-preview-select]").value);
      if (!item) return;
      if (manual && (!state.configValid || itemState(state.queue, readRecords(), item) === "blocked")) return;
      const confirmation = manual ? `確認已人工送出本檔的作業訊息給 ${item.account}？\n${item.message}\n只更新紀錄，不會送出訊息。` : `將 ${item.account} 列入黑名單？後續不發送，此帳號所有列不納入叫貨或待處理直播檔。`;
      if (!window.confirm(confirmation)) return;
      try { await withLock(() => { assertCurrentFile(); if (manual && state.blacklist.includes(item.account)) throw problem("BLACKLISTED", "此帳號已列入黑名單，不能標記為人工送出。"); if (manual) writeRecord(item, "manualSent", "MANUAL_CONFIRMED", "使用者核對本檔作業訊息，確認已人工送出"); else saveBlacklist([...state.blacklist, item.account]); $("[data-authorize]").checked = false; render(); showStatus(`${item.account}：${manual ? "已人工送出" : "黑名單排除"}，只更新紀錄。`); }); }
      catch (error) { showStatus(error.message, true); }
    }
    $("[data-mark-manual]").addEventListener("click", () => resolveSelected(true));
    $("[data-mark-blocked]").addEventListener("click", () => resolveSelected(false));
    $("[data-config]").addEventListener("input", () => {
      $("[data-authorize]").checked = false;
      try {
        // 即使暫時清空，也保存文字；不能帶著舊預覽發送。
        GM_setValue(STORE.config, { template: $("[data-config]").value });
        const next = validateConfig({ template: $("[data-config]").value });
        const queue = state.entry ? buildQueue(state.entry, next, state.round, state.blacklist) : null;
        config = next; state.queue = queue; state.configValid = true; render(); showStatus("");
      } catch (error) { state.configValid = false; refreshPreview(); lockControls(); showStatus(error.message, true); }
    });
    $("[data-preview-select]").addEventListener("change", refreshPreview);
    $("[data-dry]").addEventListener("change", () => { $("[data-authorize]").checked = false; $("[data-start]").textContent = $("[data-dry]").checked ? "開始演練" : "開始正式發送"; });
    $("[data-stop]").addEventListener("click", () => { state.stop = true; showStatus("正在停止；還沒查的人會原樣留在匯出的檔裡。"); });
    $("[data-collapse]").addEventListener("click", () => { panel.classList.toggle("closed"); $("[data-collapse]").textContent = panel.classList.contains("closed") ? "展開" : "收合"; keepPanelInView(); savePanelPosition(); });
    async function withLock(action) {
      if (!navigator.locks?.request) throw problem("LOCK", "瀏覽器不支援分頁發送鎖，請使用新版 Chrome／Edge。");
      return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, lock => { if (!lock) throw problem("LOCK", "結單通知或另一個帳號預檢正在執行，請等它完成。"); return action(); });
    }
    $("[data-files]").addEventListener("change", async event => {
      const input = event.currentTarget;
      if (state.running || state.importing) return;
      state.importing = true; $("[data-authorize]").checked = false; lockControls();
      try {
        if (!input.files.length) return;
        if (input.files.length !== 1) throw problem("FILE", "一次只能匯入一份直播原始 CSV。");
        const file = input.files[0], entry = await readSource(await file.arrayBuffer(), file.name);
        await withLock(() => {
          const files = readFiles(), changed = files.last?.name === entry.name && files.last?.hash !== entry.hash;
          const next = pruneFiles(files, readRecords(), entry), nextConfig = validateConfig({ template: $("[data-config]").value }), queue = buildQueue(entry, nextConfig, next.round, state.blacklist);
          GM_setValue(STORE.records, next.records); GM_setValue(STORE.files, next.files);
          state.entry = entry; state.round = next.round; state.queue = queue; config = nextConfig; state.configValid = true; updateLast(); render();
          showStatus(changed ? "這份檔的內容和上次那一份不一樣，會當成新的檔，所有人都會再收到訊息。" : "已匯入；同一份檔會接著跑，請核對訊息與買家預覽。");
        });
      } catch (error) { showStatus(error.message, true); }
      finally { input.value = ""; state.importing = false; lockControls(); }
    });
    $("[data-export-filtered]").addEventListener("click", () => {
      try { if (state.running || state.importing || !state.entry) return; assertCurrentFile(); const result = filteredExport(state.entry, state.queue, readRecords()); if (window.confirm(result.confirmation)) download(result.bytes, result.filename, "text/csv;charset=utf-8"); }
      catch (error) { showStatus(error.message, true); }
    });
    $("[data-export-list]").addEventListener("click", () => {
      try { if (state.running || state.importing || !state.entry) return; assertCurrentFile(); download(listCsv(state.queue, readRecords()), state.entry.name.replace(/\.csv$/iu, "") + "_預檢結果.csv", "text/csv;charset=utf-8"); }
      catch (error) { showStatus(error.message, true); }
    });
    $("[data-export-pending]").addEventListener("click", () => {
      try { if (state.running || state.importing || !state.entry) return; assertCurrentFile(); const result = pendingExport(state.entry, state.queue, readRecords()); if (window.confirm(result.confirmation)) download(result.bytes, result.filename, "text/csv;charset=utf-8"); }
      catch (error) { showStatus(error.message, true); }
    });
    async function resetRecords(all) {
      if (state.running || state.importing || !state.entry) return;
      try {
        assertCurrentFile();
        const missing = state.queue.items.filter(item => ["notFound", "searchUnconfirmed"].includes(itemState(state.queue, readRecords(), item)));
        if (!all && !missing.length) return;
        const message = all ? "這份檔裡已經發過的人會再收到一次，黑名單仍排除，其餘人回到尚未發送。確定？" : `會把目前『搜尋未確認』的 ${missing.length} 位改回『尚未發送』。之後勾授權、按開始，會重新搜尋這幾位；搜尋得到的會收到訊息。確定？`;
        if (!window.confirm(message)) return;
        state.importing = true; lockControls();
        await withLock(() => {
          assertCurrentFile();
          if (all) {
            const files = readFiles(), file = files.entries.find(entry => entry.hash === state.entry.hash); file.round++;
            GM_setValue(STORE.files, files); state.round = file.round; state.queue = buildQueue(state.entry, config, state.round, state.blacklist);
          } else {
            const records = readRecords(); for (const item of missing) delete records[recordKey(state.queue.batchId, item.account)]; GM_setValue(STORE.records, records);
          }
          updateLast(); $("[data-authorize]").checked = false; render(); showStatus("已改回尚未發送。請重新核對、勾授權，再按開始。");
        });
      } catch (error) { showStatus(error.message, true); }
      finally { state.importing = false; render(); }
    }
    $("[data-recheck]").addEventListener("click", () => resetRecords(false));
    $("[data-new-round]").addEventListener("click", () => resetRecords(true));
    async function delay(milliseconds) {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) { assertSafe(() => state.stop); assertCurrentFile(); await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now()))); }
    }
    async function run(dryRun) {
      const queue = state.queue;
      if (!state.configValid || !queue?.items.length) throw problem("QUEUE", "請先匯入有買家帳號的直播原始檔，並核對訊息。");
      assertCurrentFile(); assertSafe(() => state.stop);
      const records = readRecords(), items = dryRun ? queue.items.filter(item => itemState(queue, records, item) === "ready").slice(0, 3) : runnableItems(queue, records);
      if (!items.length) { showStatus("沒有可發送的帳號；搜尋未確認者需按『搜尋未確認的重新查一次』。黑名單不發送。"); return; }
      for (let index = 0; index < items.length; index++) {
        const item = items[index]; assertSafe(() => state.stop); assertCurrentFile();
        if (!["ready", "failed"].includes(itemState(queue, readRecords(), item))) continue;
        showStatus(`${dryRun ? "演練" : "預檢"} ${index + 1}／${items.length}：${item.account}`);
        let clicked = false, prepared = false;
        try {
          await sendOne(item, { dryRun, stopRequested: () => state.stop, beforeClick: () => { assertCurrentFile(); writeRecord(item, "pending", "PREPARED", "已準備點送出，結果待核對"); prepared = true; }, onClick: () => { clicked = true; } });
          if (!dryRun) writeRecord(item, "sent", "", "點送出後，已確認同一對話輸入框清空");
          log(`${item.account}：${dryRun ? "演練核對通過，沒有送出" : "已送出"}`);
        } catch (error) {
          log(`${item.account}：${error.message}`);
          const fatal = ["STOP", "SECURITY_CHALLENGE", "OTHER_SENDER", "SEARCH_UNRELIABLE", "SEARCH_INPUT", "FILE_CHANGED", "BLACKLIST_UNSAVED", "STORAGE", "RECORDS"].includes(error.code);
          if (!dryRun) {
            if (fatal && !clicked) {
              // pending 已先存，若送出前收到停止仍須回到尚未發送；硬關頁則保留 pending。
              if (prepared) { const next = readRecords(); delete next[recordKey(queue.batchId, item.account)]; GM_setValue(STORE.records, next); updateLast(); }
            } else writeRecord(item, clicked ? "pending" : error.code === "SEARCH_UNCONFIRMED" ? "searchUnconfirmed" : error.code === "DRAFT" ? "draft" : "failed", error.code || "UNKNOWN", error.message);
          }
          render(); if (fatal) throw error;
        }
        render();
        if (index < items.length - 1) await delay(dryRun ? 500 : 15000 + Math.floor(Math.random() * 10001));
      }
      showStatus(`${dryRun ? "演練" : "本次預檢"}完成。${dryRun ? "沒有填字、送出或寫發送紀錄。" : "請核對各狀態；叫貨用直播檔只納入已確認發送者，其他資料另匯出待處理。"}`);
    }
    $("[data-start]").addEventListener("click", async () => {
      if (state.running || state.importing) return;
      try {
        if (!$("[data-authorize]").checked) throw problem("AUTHORIZE", "請先核對預覽，勾選本次操作授權。");
        const dryRun = $("[data-dry]").checked; state.running = true; state.stop = false; $("[data-authorize]").checked = false; lockControls();
        await withLock(() => run(dryRun));
      } catch (error) { showStatus(error.message, true); }
      finally { state.running = false; state.stop = false; render(); }
    });
    render();
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("開啟帳號預檢", () => { panel.classList.remove("closed"); $("[data-collapse]").textContent = "收合"; keepPanelInView(); savePanelPosition(); });
      GM_registerMenuCommand("重設帳號預檢面板位置", () => { placePanel(18, 18); savePanelPosition(); });
    }
  }
  const testApi = { VERSION, STORE, DEFAULT_CONFIG, HEADERS, LABELS, LOCK_NAME, norm, validateConfig, renderMessage, validateBuyerAccount, parseBlacklist, itemState, splitCsv, parseSource, readSource, batchId, recordKey, recordState, buildQueue, runnableItems, countsFor, streakWarning, pruneFiles, toCsv, listCsv, filteredExport, pendingExport, sendOne, activateElement };
  if (typeof module !== "undefined" && module.exports) module.exports = testApi;
  if (typeof window !== "undefined" && typeof document !== "undefined" && location.hostname === "seller.shopee.tw" && location.pathname.startsWith("/new-webchat/conversations")) init();
})();
