// ==UserScript==
// @name         Shopee 多場結單通知
// @namespace    local.shopee.settlement-notice
// @version      0.2.1
// @description  自訂通知文字，匯入任意已確認買家 Excel，合併去重後手動核對並逐筆通知
// @match        https://seller.shopee.tw/new-webchat/conversations*
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* global ExcelJS, GM_getValue, GM_setValue, GM_registerMenuCommand, module */
(function settlementNotice() {
  "use strict";
  const VERSION = "0.2.1";
  const STORE = Object.freeze({ config: "settlement:config:v1", records: "settlement:records:v1", panelPosition: "settlement:panel-position:v1", batch: "settlement:batch:v1" });
  const DEFAULT_CONFIG = Object.freeze({
    template: "您好，感謝您於10/08～10/11期間於采兒直播間喊單，今天是10/12結單日，提醒您這期間購買的商品要一起結單呦！",
  });
  const CHAT_SELECTORS = Object.freeze({
    searchInputs: ['input[placeholder="搜尋全部"]', 'input[placeholder*="搜尋"]'],
    composers: ['textarea[placeholder="輸入文字"]', 'textarea[placeholder*="輸入"]', '[contenteditable="true"][role="textbox"]'],
  });
  const norm = value => String(value ?? "").normalize("NFKC").replace(/\uFEFF/gu, "").replace(/\s+/gu, " ").trim();
  const multiline = value => String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/gu, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  function problem(code, message) { const error = new Error(message); error.code = code; return error; }
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function validateConfig(input) {
    // 舊版日期／直播間欄位只用來把舊範本一次轉成完整文字，不參與任何發送限制。
    const legacy = {
      開始日: validDate(input?.startDate) ? input.startDate.slice(5).replace("-", "") : undefined,
      結束日: validDate(input?.endDate) ? input.endDate.slice(5).replace("-", "") : undefined,
      結單日: validDate(input?.closingDate) ? input.closingDate.slice(5).replace("-", "") : undefined,
      直播間: typeof input?.roomName === "string" ? input.roomName : undefined,
    };
    const config = { template: multiline(input?.template).replace(/\{(開始日|結束日|結單日|直播間)\}/gu, (token, name) => legacy[name] ?? token) };
    if (!config.template) throw problem("CONFIG", "通知範本不可空白。");
    renderMessage(config, "預覽帳號");
    return config;
  }
  function renderMessage(config, account) {
    const message = multiline(config.template).replace(/\{買家\}/gu, () => account);
    if (!message || message.length > 2000) throw problem("TEMPLATE", "通知內容不可空白，請控制在 2000 字元以內。");
    return message;
  }

  // 沿用明細 1.4.3 的帳號型別與 Excel 轉型攔截規則。只讀目前儲存格，不猜原帳號。
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
  // 只辨識優惠表版本標記；通知不計算或驗證優惠規則。
  function hasComboTitle(workbook) {
    const value = workbook.getWorksheet("設定與價格")?.getCell("N1").value;
    const text = typeof value === "string" ? value : value && typeof value === "object" &&
      Object.keys(value).length === 1 && Array.isArray(value.richText) &&
      value.richText.every(part => typeof part?.text === "string")
      ? value.richText.map(part => part.text).join("") : null;
    return text === "本場優惠 v1";
  }
  function extractConfirmed(workbook, filename) {
    const sheet = workbook.getWorksheet("已確認");
    if (!sheet || norm(sheet.getCell(5, 1).text) !== "買家帳號") throw problem("WORKBOOK", `${filename}：找不到「已確認」或 A5「買家帳號」，請使用聊聊明細發送表。`);
    const accounts = [], issues = [], markerRows = [];
    const hasCombo = hasComboTitle(workbook);
    for (let row = 6; row <= sheet.rowCount; row++) {
      const blank = value => value == null || value === "";
      if (hasCombo && sheet.getCell(row, 2).value === "組合優惠" &&
          [1, 6, 7].every(col => blank(sheet.getCell(row, col).value))) {
        markerRows.push(row);
        continue;
      }
      const value = sheet.getCell(row, 1).value;
      const result = validateBuyerAccount(value);
      const hasOrder = [2, 3, 4, 5, 6, 7].some(col => sheet.getCell(row, col).value != null && sheet.getCell(row, col).value !== "");
      if (!result.ok) issues.push(`${filename}／已確認 A${row}：帳號不是文字或疑似 Excel 轉型，請核對原始資料並改回正確文字。`);
      else if (!result.text && hasOrder) issues.push(`${filename}／已確認 A${row}：有商品資料卻沒有買家帳號。`);
      else if (result.text) accounts.push({ account: result.text, row });
    }
    if (issues.length) throw problem("ACCOUNT", issues.join("\n"));
    return { accounts, sourceRows: accounts.length, uniqueCount: new Set(accounts.map(item => item.account)).size, markerRows };
  }
  async function readWorkbook(buffer, filename) {
    if (typeof ExcelJS === "undefined") throw problem("EXCELJS", "Excel 元件尚未載入，請重新整理頁面。");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return extractConfirmed(workbook, filename);
  }
  function buildQueue(entries, input, batchId = "notice:default") {
    const config = validateConfig(input), byAccount = new Map(), issues = [];
    for (const entry of entries) {
      for (const source of entry.accounts) {
        let buyer = byAccount.get(source.account);
        if (!buyer) { buyer = { account: source.account, message: renderMessage(config, source.account), sources: [] }; byAccount.set(source.account, buyer); }
        buyer.sources.push({ file: entry.name, row: source.row });
      }
    }
    const items = [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account, "zh-Hant", { numeric: true }));
    if (!items.length) issues.push("目前沒有「已確認」買家帳號。");
    return { config, batchId, items, issues, sourceRows: entries.reduce((sum, entry) => sum + entry.sourceRows, 0) };
  }
  // 同一次通知以固定 ID＋帳號防重發；修改文字或增加 Excel 不會重設。
  function recordKey(batchId, account) { return JSON.stringify([batchId, account]); }
  function recordState(records, batchId, account) { return records[recordKey(batchId, account)]?.status || "ready"; }
  function runnableItems(queue, records) { return queue.items.filter(item => ["ready", "failed"].includes(recordState(records, queue.batchId, item.account))); }
  function assertRunAllowed(queue) {
    if (!queue?.items.length) throw problem("QUEUE", "請先匯入 Excel 並核對預覽。");
    if (queue.issues.length) throw problem("QUEUE", queue.issues.join("\n"));
  }
  function newBatch() {
    const unique = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return { id: `notice:${unique}`, createdAt: new Date().toISOString() };
  }
  function resolveBatch(saved, legacyConfig, records = {}) {
    if (typeof saved?.id === "string" && saved.id) return { id: saved.id, createdAt: saved.createdAt || new Date().toISOString() };
    // 舊日期只作歷史紀錄索引，保留舊防重發；沒有日期比較或場次限制。
    if (validDate(legacyConfig?.closingDate)) return { id: legacyConfig.closingDate, createdAt: new Date().toISOString() };
    const recent = Object.values(records).filter(record => typeof record?.batchId === "string" || validDate(record?.closingDate)).sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))[0];
    return recent ? { id: recent.batchId || recent.closingDate, createdAt: new Date().toISOString() } : newBatch();
  }
  function mergeBackup(current, backup, batchId) {
    if (![1, 2].includes(backup?.version) || !backup.records || typeof backup.records !== "object" || Array.isArray(backup.records)) throw problem("RECORDS", "這不是有效的發送紀錄備份。");
    const incoming = {}, merged = { ...current }, priority = { sent: 3, pending: 2, failed: 1 };
    for (const [key, record] of Object.entries(backup.records)) {
      const scope = record?.batchId || record?.closingDate;
      if (typeof scope !== "string" || !scope || (!record.batchId && !validDate(record.closingDate)) || typeof record?.account !== "string" || !record.account || !validateBuyerAccount(record.account).ok || !["sent", "pending", "failed"].includes(record.status) || key !== recordKey(scope, record.account)) throw problem("RECORDS", "備份中有無效發送紀錄，未匯入。");
      incoming[key] = { ...record, batchId: scope };
    }
    const sourceBatch = resolveBatch(backup.activeBatch, null, incoming).id;
    function retain(key, record) { if (priority[record.status] > (priority[merged[key]?.status] || 0)) merged[key] = record; }
    for (const [key, record] of Object.entries(incoming)) {
      retain(key, record);
      // 匯入備份用於繼續同一份通知；將備份當次紀錄合併到本次，避免換電腦重發。
      if (record.batchId === sourceBatch) retain(recordKey(batchId, record.account), { ...record, batchId });
    }
    return merged;
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
    const labels = { ready: "尚未發送", failed: "失敗，可再嘗試", pending: "可能已送出，請人工核對", sent: "已送出" };
    return toCsv([["買家帳號", "來源檔案", "狀態", "通知內容", "最後結果"], ...queue.items.map(item => {
      const record = records[recordKey(queue.batchId, item.account)];
      return [item.account, [...new Set(item.sources.map(source => source.file))].join("、"), labels[record?.status || "ready"] || "紀錄待核對", item.message, record?.detail || ""];
    })]);
  }

  // 聊聊 DOM 操作沿用現有明細腳本的搜尋、帳號核對與送出方式。
  function visible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }
  function firstVisible(selectors) {
    for (const selector of selectors) { const element = [...document.querySelectorAll(selector)].find(visible); if (element) return element; }
    return null;
  }
  function detectSecurityChallenge() {
    if (['iframe[src*="captcha" i]', 'iframe[src*="challenge" i]', 'iframe[title*="captcha" i]', '[class*="captcha" i]', '[id*="captcha" i]'].some(selector => [...document.querySelectorAll(selector)].some(visible))) return true;
    return [...document.querySelectorAll('[role="dialog"], [class*="modal" i]')].filter(visible).some(element => /拼圖驗證|完成拼圖|安全驗證|請驗證|captcha|security challenge/iu.test(norm(element.textContent)));
  }
  function assertSafe(stopRequested) {
    if (stopRequested?.()) throw problem("STOP", "已停止。");
    if (detectSecurityChallenge()) throw problem("SECURITY_CHALLENGE", "偵測到拼圖／安全驗證，已停止，請人工處理。");
    const otherStop = document.querySelector('[data-winlist-shopee="1"]')?.shadowRoot?.querySelector("[data-stop]");
    if (otherStop && !otherStop.classList.contains("wl-hidden") && visible(otherStop)) throw problem("OTHER_SENDER", "明細腳本正在發送，請先停止明細發送再執行結單通知。");
  }
  async function waitFor(predicate, timeoutMs, stopRequested) {
    const deadline = Date.now() + timeoutMs;
    do { assertSafe(stopRequested); const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < deadline);
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
    const rect = element.getBoundingClientRect(), x = rect.left + rect.width * horizontalRatio, y = rect.top + rect.height / 2;
    const pointed = document.elementFromPoint(x, y), target = pointed && (element === pointed || element.contains(pointed)) ? pointed : element;
    // Tampermonkey 的 window 可能是沙盒代理，不能作為 UIEventInit.view。
    // 不指定 view，讓瀏覽器使用預設 null，避免 PointerEvent／MouseEvent 建構失敗。
    const options = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
    const PointerCtor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    target.dispatchEvent(new PointerCtor("pointerdown", options)); target.dispatchEvent(new MouseEvent("mousedown", options));
    target.dispatchEvent(new PointerCtor("pointerup", { ...options, buttons: 0 })); target.dispatchEvent(new MouseEvent("mouseup", { ...options, buttons: 0 })); target.dispatchEvent(new MouseEvent("click", { ...options, buttons: 0 }));
  }
  function exactSearchResult(account, input) {
    const inputRect = input.getBoundingClientRect();
    return [...document.querySelectorAll("div,li,span,p")].filter(element => visible(element) && norm(element.textContent) === account && !element.closest("[data-settlement-notice],[data-winlist-shopee]")).map(label => {
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
    return [...document.querySelectorAll("div,span,p,h1,h2,h3")].find(element => visible(element) && !element.closest("[data-settlement-notice],[data-winlist-shopee]") && norm(element.textContent) === account && element.getBoundingClientRect().left > inputRect.right + 30 && element.getBoundingClientRect().top < 320) || null;
  }
  function findSendButton(composer) {
    const box = composer.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('button:not([disabled]),[role="button"]:not([aria-disabled="true"]),[aria-label*="send" i],[aria-label*="送出"],[aria-label*="發送"],[title*="send" i],[title*="送出"],[title*="發送"],[class*="send" i],[data-testid*="send" i],svg.chat-icon,svg')]
      .map(element => element.closest('button,[role="button"],[tabindex]:not([tabindex="-1"])') || element)
      .filter((element, index, items) => items.indexOf(element) === index && visible(element) && !element.closest("[data-settlement-notice],[data-winlist-shopee]") && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true")
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
  async function sendOne(item, { dryRun, stopRequested, beforeClick }) {
    let composer = null, clicked = false, input = null, filled = false;
    try {
      input = await waitFor(() => firstVisible(CHAT_SELECTORS.searchInputs), 10000, stopRequested);
      if (!input) throw problem("SEARCH_INPUT", "找不到搜尋框。");
      input.focus(); setNativeValue(input, ""); setNativeValue(input, item.account);
      const result = await waitFor(() => exactSearchResult(item.account, input), 8000, stopRequested);
      if (!result) throw problem("BUYER_NOT_FOUND", "搜尋不到完全相同的買家帳號，未送出。");
      assertSafe(stopRequested); activateElement(result.label);
      let verified = await waitFor(() => exactConversationHeader(item.account, input), 2500, stopRequested);
      if (!verified) { assertSafe(stopRequested); activateElement(result.row, 0.2); verified = await waitFor(() => exactConversationHeader(item.account, input), 2500, stopRequested); }
      if (!verified) { input.focus(); searchKey(input, "ArrowDown", 40); searchKey(input, "Enter", 13); verified = await waitFor(() => exactConversationHeader(item.account, input), 3000, stopRequested); }
      if (!verified) throw problem("HEADER", "右側對話帳號無法核對，未送出。");
      composer = await waitFor(() => firstVisible(CHAT_SELECTORS.composers), 8000, stopRequested);
      if (!composer) throw problem("COMPOSER", "找不到訊息輸入框，未送出。");
      if (multiline(composerText(composer))) throw problem("DRAFT", "買家對話已有草稿，請先人工處理；未覆寫、未送出。");
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
      clicked = true; activateElement(button);
      const cleared = await waitFor(() => document.contains(composer) && exactConversationHeader(item.account, input) && composerText(composer) === "", 7000, stopRequested);
      if (!cleared) throw problem("SEND_UNCERTAIN", "已點送出但未確認輸入框清空，請人工查看聊聊，暫停自動重試。");
    } finally {
      // 只清除本腳本填入、尚未點送出的文字；不動原草稿或可能已送出的對話。
      if (!clicked && filled && composer && document.contains(composer) && input && exactConversationHeader(item.account, input) && multiline(composerText(composer)) === multiline(item.message)) setComposer(composer, "");
    }
  }
  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type })), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function init() {
    if (document.querySelector("[data-settlement-notice]")) return;
    const host = document.createElement("div"); host.setAttribute("data-settlement-notice", "1"); document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const savedConfig = GM_getValue(STORE.config, null);
    const state = { entries: [], queue: null, running: false, importing: false, stop: false, logs: [], batch: resolveBatch(GM_getValue(STORE.batch, null), savedConfig, GM_getValue(STORE.records, {}) || {}) };
    let config;
    try { config = validateConfig(savedConfig || DEFAULT_CONFIG); } catch { config = { ...DEFAULT_CONFIG }; }
    GM_setValue(STORE.batch, state.batch); GM_setValue(STORE.config, config);
    root.innerHTML = `<style>
      :host{all:initial;font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#253047}
      *{box-sizing:border-box} .panel{position:fixed;left:18px;bottom:18px;width:450px;max-width:calc(100vw - 36px);max-height:88vh;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 8px 32px #0003;z-index:2147483646;overflow:hidden}
      header{padding:10px 14px;background:#473968;color:white;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;touch-action:none}.dragging header{cursor:grabbing}header button{background:#ffffff25;color:white;border:0;cursor:pointer}
      .body{padding:14px;max-height:calc(88vh - 48px);overflow:auto}.closed .body{display:none}h3{font-size:15px;margin:8px 0}p{margin:8px 0}.mini{font-size:12px;color:#566277}
      label{display:block;margin:8px 0}input,textarea,select,button{font:inherit}textarea,select{width:100%;padding:7px;border:1px solid #b8c2d1;border-radius:6px;background:white;color:#253047}textarea{resize:vertical;min-height:110px}
      .actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}button{padding:7px 10px;border:1px solid #b8c2d1;border-radius:6px;background:#f6f7fa;cursor:pointer}button.primary{background:#473968;border-color:#473968;color:white}button.danger{background:#b91c1c;color:white;border-color:#b91c1c}button:disabled{opacity:.5;cursor:default}
      .check{display:flex;gap:8px;align-items:start}.check input{margin-top:5px}.file{border-bottom:1px solid #e2e8f0;padding:8px 0;overflow-wrap:anywhere}.file button{float:right}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f3f9;padding:10px;border-radius:6px;margin:8px 0}.status{white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#b91c1c}.success{color:#166534}.stop{position:sticky;bottom:0;width:100%;margin-top:8px}.hidden{display:none}.log{font-size:12px;max-height:140px;overflow:auto}
    </style><section class="panel"><header><strong>多場結單通知 v${VERSION}</strong><button data-collapse>收合</button></header><div class="body">
      <h3>1. 通知範本</h3><label>通知文字<textarea data-config="template"></textarea></label><p class="mini">日期與直播間名稱直接寫在通知文字中。可使用 {買家} 代入帳號；修改後會更新預覽並保存。</p>
      <div class="actions"><button data-export-config>匯出範本設定</button><button data-import-config>匯入範本設定</button><input data-config-file type="file" accept=".json" hidden></div>
      <h3>2. 匯入要通知的 Excel</h3><input data-files type="file" accept=".xlsx" multiple><p class="mini">只讀「已確認」，不讀「待確認」或買家名冊。可一次多選或分次加入，份數不限；同一帳號只通知一次。</p>
      <div data-file-list></div><p data-summary class="status"></p>
      <label>買家預覽<select data-preview-select></select></label><p data-source class="mini"></p><pre data-preview>請先匯入 Excel。</pre>
      <div class="actions"><button data-export-list>匯出名單與結果 CSV</button><button data-export-records>備份發送紀錄</button><button data-import-records>匯入發送紀錄</button><input data-records-file type="file" accept=".json" hidden></div>
      <h3>3. 核對後啟動</h3><label class="check"><input data-dry type="checkbox" checked><span>演練：只搜尋前 3 位、核對帳號與輸入框，不填訊息、不送出。</span></label>
      <p class="mini">由員工決定通知時間；每次操作間隔 15～25 秒。請勿同時操作其他明細發送。</p>
      <label class="check"><input data-authorize type="checkbox"><span>我已核對買家帳號與完整通知文字，授權本次操作。</span></label>
      <button data-start class="primary">開始演練</button><p data-status class="status"></p><button data-stop class="danger stop hidden">緊急停止</button>
      <details><summary>可能已送出：人工核對</summary><p class="mini">中斷前已嘗試送出者不會自動重試。先到該買家聊聊核對，再指定結果。</p><select data-pending></select><div class="actions"><button data-mark-sent>確認已送出</button><button data-retry>確認沒送出，允許再試</button></div></details>
      <details><summary>日後發送另一份通知</summary><p class="mini">本次通知的防重發紀錄會一直保留。日後需要再次通知相同買家時，按下面按鈕開始新的通知，再選擇 Excel。</p><button data-new-notice>開始新的通知</button></details>
      <pre data-log class="log"></pre>
    </div></section>`;
    const $ = selector => root.querySelector(selector), settings = [...root.querySelectorAll("[data-config]")];
    const panel = $(".panel"), header = $("header");
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
    const readRecords = () => {
      const result = GM_getValue(STORE.records, {});
      if (!result || typeof result !== "object" || Array.isArray(result)) throw problem("RECORDS", "發送紀錄格式有問題，請先恢復紀錄備份。");
      return result;
    };
    const writeRecord = (item, status, detail) => {
      const records = readRecords();
      records[recordKey(state.queue.batchId, item.account)] = { account: item.account, batchId: state.queue.batchId, status, message: item.message, detail, time: new Date().toISOString() };
      GM_setValue(STORE.records, records);
    };
    const log = message => { state.logs.push(`${new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })} ${message}`); state.logs = state.logs.slice(-300); $("[data-log]").textContent = state.logs.join("\n"); $("[data-log]").scrollTop = $("[data-log]").scrollHeight; };
    function lockControls() {
      const locked = state.running || state.importing;
      for (const element of root.querySelectorAll("input,textarea,select,button")) if (!element.matches("[data-stop],[data-collapse]")) element.disabled = locked;
      $("[data-start]").disabled = locked || !state.queue?.items.length;
      $("[data-stop]").classList.toggle("hidden", !state.running);
    }
    function refreshPreview() {
      const item = state.queue?.items.find(entry => entry.account === $("[data-preview-select]").value);
      $("[data-preview]").textContent = item?.message || "請先匯入 Excel。";
      $("[data-source]").textContent = item ? `來源檔案：${[...new Set(item.sources.map(source => source.file))].join("、")}；狀態：${({ ready: "尚未發送", failed: "失敗，可再嘗試", pending: "可能已送出，請人工核對", sent: "已送出" })[recordState(readRecords(), state.queue.batchId, item.account)] || "待核對"}` : "";
    }
    function render() {
      try { config = validateConfig(Object.fromEntries(settings.map(input => [input.dataset.config, input.value]))); }
      catch (error) { state.queue = null; $("[data-preview]").textContent = "通知文字尚未完成，請修正後核對預覽。"; lockControls(); showStatus(error.message, true); return; }
      const records = readRecords(), previous = $("[data-preview-select]").value;
      $("[data-file-list]").innerHTML = state.entries.map((entry, index) => `<div class="file"><button data-remove="${index}">移除</button><strong>${escapeHtml(entry.name)}</strong><div>${entry.sourceRows} 筆，${entry.uniqueCount} 位已確認買家</div></div>`).join("");
      state.queue = buildQueue(state.entries, config, state.batch.id);
      const counts = { sent: 0, pending: 0, ready: 0 };
      for (const item of state.queue.items) { const status = recordState(records, state.queue.batchId, item.account); if (status === "sent") counts.sent++; else if (status === "pending") counts.pending++; else counts.ready++; }
      $("[data-summary]").textContent = `${state.entries.length} 份 Excel，${state.queue.sourceRows} 筆帳號資料，去重後 ${state.queue.items.length} 位買家。\n待發送 ${counts.ready}，已送出 ${counts.sent}，可能已送出 ${counts.pending}。${state.queue.issues.length ? "\n" + state.queue.issues.join("\n") : "\n已建立通知預覽，請核對後啟動。"}`;
      $("[data-summary]").className = `status ${state.queue.issues.length ? "error" : "success"}`;
      $("[data-preview-select]").innerHTML = state.queue.items.map(item => `<option value="${escapeHtml(item.account)}">${escapeHtml(item.account)}</option>`).join("");
      if (state.queue.items.some(item => item.account === previous)) $("[data-preview-select]").value = previous;
      $("[data-pending]").innerHTML = '<option value="">選擇待核對帳號</option>' + state.queue.items.filter(item => recordState(records, state.queue.batchId, item.account) === "pending").map(item => `<option value="${escapeHtml(item.account)}">${escapeHtml(item.account)}</option>`).join("");
      refreshPreview(); lockControls();
    }
    function setConfig(next) { config = validateConfig(next); for (const input of settings) input.value = config[input.dataset.config]; GM_setValue(STORE.config, config); $("[data-authorize]").checked = false; render(); }
    for (const input of settings) input.value = config[input.dataset.config];
    for (const input of settings) input.addEventListener("input", () => {
      $("[data-authorize]").checked = false;
      try { config = validateConfig(Object.fromEntries(settings.map(element => [element.dataset.config, element.value]))); GM_setValue(STORE.config, config); render(); showStatus(""); }
      catch (error) { state.queue = null; $("[data-preview]").textContent = "通知文字尚未完成，請修正後核對預覽。"; $("[data-start]").disabled = true; showStatus(error.message, true); }
    });
    $("[data-files]").addEventListener("change", async event => {
      const fileInput = event.currentTarget;
      state.importing = true; $("[data-authorize]").checked = false; lockControls();
      try {
        const files = [...fileInput.files], additions = [];
        // 整批先驗證，任一檔有錯就不新增這一批；也不保留舊的發送授權。
        for (const file of files) {
          if (!/\.xlsx$/iu.test(file.name) || file.name.startsWith("~$")) throw problem("FILE", "請選擇 .xlsx 明細發送表，勿選 Excel 暫存鎖定檔。");
          if (state.entries.some(entry => entry.name === file.name) || additions.some(entry => entry.name === file.name)) throw problem("FILE", `${file.name} 已加入；若改過 Excel，請先移除舊檔再匯入。`);
          additions.push({ name: file.name, ...await readWorkbook(await file.arrayBuffer(), file.name) });
        }
        state.entries.push(...additions); render(); showStatus(`已加入 ${additions.length} 份 Excel，尚未發送。`);
      } catch (error) { showStatus(error.message, true); }
      finally { fileInput.value = ""; state.importing = false; lockControls(); }
    });
    $("[data-file-list]").addEventListener("click", event => { if (event.target.matches("[data-remove]")) { state.entries.splice(Number(event.target.dataset.remove), 1); $("[data-authorize]").checked = false; render(); } });
    $("[data-preview-select]").addEventListener("change", refreshPreview);
    $("[data-dry]").addEventListener("change", () => { $("[data-authorize]").checked = false; $("[data-start]").textContent = $("[data-dry]").checked ? "開始演練" : "開始正式發送"; });
    $("[data-stop]").addEventListener("click", () => { state.stop = true; showStatus("正在停止；若已點送出，該筆會保留為待人工核對。"); });
    $("[data-collapse]").addEventListener("click", () => { panel.classList.toggle("closed"); $("[data-collapse]").textContent = panel.classList.contains("closed") ? "展開" : "收合"; keepPanelInView(); savePanelPosition(); });
    $("[data-export-config]").addEventListener("click", () => {
      try { const current = validateConfig(Object.fromEntries(settings.map(input => [input.dataset.config, input.value]))); download(JSON.stringify(current, null, 2), "結單通知範本.json", "application/json;charset=utf-8"); } catch (error) { showStatus(error.message, true); }
    });
    $("[data-import-config]").addEventListener("click", () => $("[data-config-file]").click());
    $("[data-config-file]").addEventListener("change", async event => {
      const fileInput = event.currentTarget;
      state.importing = true; lockControls();
      try { const file = fileInput.files[0]; if (file) { setConfig(JSON.parse((await file.text()).replace(/^\uFEFF/u, ""))); showStatus("已匯入通知範本，請重新核對文字與預覽。"); } } catch (error) { showStatus(error.message, true); }
      finally { fileInput.value = ""; state.importing = false; lockControls(); }
    });
    $("[data-export-list]").addEventListener("click", () => { try { if (!state.queue?.items.length) throw new Error("請先匯入 Excel。"); download(listCsv(state.queue, readRecords()), "結單通知_名單結果.csv", "text/csv;charset=utf-8"); } catch (error) { showStatus(error.message, true); } });
    $("[data-export-records]").addEventListener("click", () => download(JSON.stringify({ version: 2, activeBatch: state.batch, records: readRecords() }, null, 2), "結單通知_發送紀錄.json", "application/json;charset=utf-8"));
    $("[data-import-records]").addEventListener("click", () => $("[data-records-file]").click());
    $("[data-records-file]").addEventListener("change", async event => {
      const fileInput = event.currentTarget;
      state.importing = true; lockControls();
      try {
        const file = fileInput.files[0]; if (!file) return;
        const backup = JSON.parse((await file.text()).replace(/^\uFEFF/u, "")), merged = mergeBackup(readRecords(), backup, state.batch.id);
        GM_setValue(STORE.records, merged); $("[data-authorize]").checked = false; render(); showStatus("已合併發送紀錄；已送出與待核對紀錄優先保留。");
      } catch (error) { showStatus(error.message, true); }
      finally { fileInput.value = ""; state.importing = false; lockControls(); }
    });
    function resolvePending(sent) {
      try {
        const item = state.queue?.items.find(buyer => buyer.account === $("[data-pending]").value);
        if (!item || recordState(readRecords(), state.queue.batchId, item.account) !== "pending") throw new Error("請先選擇可能已送出的帳號。");
        if (!window.confirm(`${item.account}\n${sent ? "已到聊聊確認這筆通知已送出？將保留防重發。" : "已到聊聊確認這筆通知沒有送出？下次正式發送可能會再次通知這位買家。"}`)) return;
        writeRecord(item, sent ? "sent" : "failed", sent ? "人工確認已送出" : "人工確認未送出，允許重試"); $("[data-authorize]").checked = false; render();
      } catch (error) { showStatus(error.message, true); }
    }
    $("[data-mark-sent]").addEventListener("click", () => resolvePending(true)); $("[data-retry]").addEventListener("click", () => resolvePending(false));
    function assertCurrentBatch() {
      if (GM_getValue(STORE.batch, null)?.id !== state.batch.id) throw problem("BATCH_CHANGED", "另一分頁已開始新的通知，請重新整理後再匯入 Excel。");
    }
    async function beginNewNotice() {
      if (state.running || state.importing) { showStatus("請先停止或等目前操作完成。", true); return; }
      if (!window.confirm("開始新的通知會清除目前匯入名單，保留歷史發送紀錄。\n重新匯入後，同一帳號可以再次收到通知。是否開始？")) return;
      state.importing = true; $("[data-authorize]").checked = false; lockControls();
      try {
        if (!navigator.locks?.request) throw problem("LOCK", "瀏覽器不支援分頁發送鎖，請使用新版 Chrome／Edge。");
        await navigator.locks.request("shopee-settlement-notice:send", { ifAvailable: true }, lock => {
          if (!lock) throw problem("LOCK", "另一個聊聊分頁正在執行結單通知，請等待它完成。");
          state.batch = newBatch(); GM_setValue(STORE.batch, state.batch); state.entries = []; state.logs = []; $("[data-log]").textContent = "";
          render(); showStatus("已開始新的通知。請確認通知文字，再選擇要通知的 Excel。");
        });
      } catch (error) { showStatus(error.message, true); }
      finally { state.importing = false; lockControls(); }
    }
    $("[data-new-notice]").addEventListener("click", beginNewNotice);
    async function delay(milliseconds) {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) { assertSafe(() => state.stop); assertCurrentBatch(); await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now()))); }
    }
    async function run(dryRun) {
      const queue = state.queue;
      assertRunAllowed(queue); assertCurrentBatch(); assertSafe(() => state.stop);
      const pending = runnableItems(queue, readRecords()), items = dryRun ? pending.slice(0, 3) : pending;
      if (!items.length) { showStatus("沒有尚未發送的帳號；可能已送出的帳號請先人工核對。"); return; }
      let success = 0, failures = 0;
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        assertSafe(() => state.stop); assertCurrentBatch(); assertRunAllowed(queue);
        // 每筆重新讀紀錄，避免另一個分頁更新後還使用過期快照。
        if (!["ready", "failed"].includes(recordState(readRecords(), queue.batchId, item.account))) continue;
        let attempted = false;
        showStatus(`${dryRun ? "演練" : "發送"} ${index + 1}/${items.length}：${item.account}`);
        try {
          await sendOne(item, { dryRun, stopRequested: () => state.stop, beforeClick: () => { assertRunAllowed(queue); assertCurrentBatch(); writeRecord(item, "pending", "已準備點送出，結果待核對"); attempted = true; } });
          if (!dryRun) writeRecord(item, "sent", "點送出後，已確認同一對話輸入框清空");
          success++; log(`${item.account}：${dryRun ? "演練核對通過，沒有送出" : "已送出"}`);
        } catch (error) {
          failures++; log(`${item.account}：${error.message}`);
          if (!dryRun) writeRecord(item, attempted ? "pending" : "failed", error.message);
          if (attempted || ["STOP", "SECURITY_CHALLENGE", "OTHER_SENDER", "BATCH_CHANGED", "DRAFT"].includes(error.code)) throw error;
        }
        render();
        if (index < items.length - 1) await delay(dryRun ? 500 : 15000 + Math.floor(Math.random() * 10001));
      }
      showStatus(`${dryRun ? "演練" : "本次通知"}完成：${success} 位${dryRun ? "核對通過（未送出）" : "已送出"}，${failures} 位失敗。請匯出名單查看結果。`);
    }
    $("[data-start]").addEventListener("click", async () => {
      if (state.running || state.importing) return;
      try {
        if (!$("[data-authorize]").checked) throw problem("AUTHORIZE", "請先核對預覽，勾選本次操作授權。");
        const dryRun = $("[data-dry]").checked;
        assertRunAllowed(state.queue); assertCurrentBatch();
        if (!navigator.locks?.request) throw problem("LOCK", "瀏覽器不支援分頁發送鎖，請使用新版 Chrome／Edge。");
        state.running = true; state.stop = false; $("[data-authorize]").checked = false; lockControls();
        await navigator.locks.request("shopee-settlement-notice:send", { ifAvailable: true }, async lock => { if (!lock) throw problem("LOCK", "另一個聊聊分頁正在執行結單通知，請等待它完成。"); await run(dryRun); });
      } catch (error) { showStatus(error.message, true); }
      finally { state.running = false; state.stop = false; render(); }
    });
    render();
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("開啟多場結單通知", () => { panel.classList.remove("closed"); $("[data-collapse]").textContent = "收合"; keepPanelInView(); savePanelPosition(); });
      GM_registerMenuCommand("重設結單通知面板位置", () => { placePanel(18, window.innerHeight - panel.getBoundingClientRect().height - 18); savePanelPosition(); });
      GM_registerMenuCommand("開始新的結單通知", beginNewNotice);
    }
  }
  const testApi = { VERSION, STORE, DEFAULT_CONFIG, validateConfig, renderMessage, validateBuyerAccount, extractConfirmed, readWorkbook, buildQueue, recordKey, recordState, runnableItems, assertRunAllowed, resolveBatch, mergeBackup, listCsv, sendOne };
  if (typeof module !== "undefined" && module.exports) module.exports = testApi;
  if (typeof window !== "undefined" && typeof document !== "undefined" && location.hostname === "seller.shopee.tw" && location.pathname.startsWith("/new-webchat/conversations")) init();
})();
