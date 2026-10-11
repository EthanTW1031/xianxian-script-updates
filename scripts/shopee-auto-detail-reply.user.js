// ==UserScript==
// @name         Shopee 自動回覆明細
// @namespace    local.shopee.auto-reply-detail
// @version      1.5.0
// @description  聊聊頁手動匯入已審核 Excel，預覽後安全逐筆發送
// @match        https://seller.shopee.tw/new-webchat/conversations*
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* global module */

(function shopeeAutoReplyDetail() {
  "use strict";

  // 必須與檔案開頭的 @version 完全相同：面板顯示的是這個常數，不是 @version。
  // v1.1.7 曾漏改這裡，導致面板顯示 1.1.5、現場無法判斷實際安裝版本。
  const VERSION = "1.5.0";
  const SHIPPING_NOTICE = "僅限使用蝦皮店到店/711/全家/新竹物流方式結單";
  const STORE = Object.freeze({
    sent: "winlist-shopee:sent:v3",
    sentLegacy: "winlist-shopee:sent:v2",
    failed: "winlist-shopee:failed:v1",
    blacklist: "winlist-shopee:blacklist:v1",
    logs: "winlist-shopee:logs:v2",
    config: "winlist-shopee:config:v2",
    panelPosition: "shopee-auto-reply:panel-position:v1",
    panelSize: "shopee-auto-reply:panel-size:v1",
  });
  const FAILED_RECORD_LIMIT = 5000;
  const ORDER_HEADERS = Object.freeze([
    "買家帳號",
    "商品編號",
    "商品名稱",
    "顏色",
    "尺寸",
    "數量",
    "金額(小計)",
  ]);
  const SIZE_TOKENS = Object.freeze([
    "XXL",
    "XS",
    "5L",
    "4L",
    "3L",
    "2L",
    "XL",
    "45",
    "44",
    "43",
    "42",
    "41",
    "40",
    "39",
    "38",
    "37",
    "36",
    "35",
    "L",
    "M",
    "S",
  ]);
  const CHAT_SELECTORS = Object.freeze({
    searchInputs: [
      'input[placeholder="搜尋全部"]',
      'input[placeholder*="搜尋"]',
    ],
    composers: [
      'textarea[placeholder="輸入文字"]',
      'textarea[placeholder*="輸入"]',
      '[contenteditable="true"][role="textbox"]',
    ],
  });

  function localDateLabel(date = new Date()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function nextDateLabel() {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return localDateLabel(date);
  }

  const DEFAULT_CONFIG = Object.freeze({
    openingTemplate: "您好，此為 {日期} {買家}家明細",
    closingTemplate: "請您於 {結單日} 前結單 謝謝",
    eventDate: localDateLabel(),
    closingDate: nextDateLabel(),
    eventDateSource: "來源不明",
    closingDateSource: "來源不明",
    testMode: true,
    testCount: 3,
    minDelaySeconds: 15,
    maxDelaySeconds: 25,
  });

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\uFEFF/g, "")
      .replace(/\s+/gu, " ")
      .trim();
  }
  function parseBlacklist(value) {
    const lines = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/u);
    const accounts = lines.map(line => validateBuyerAccount(line));
    if (accounts.some(account => !account.ok || /\s/u.test(account.text))) throw createAutomationError("BLACKLIST_INVALID", "黑名單請每行填一個完整買家帳號，不可使用日期、科學記號或含空白的帳號。");
    return [...new Set(accounts.map(account => account.text).filter(Boolean))];
  }
  function loadBlacklist() { return parseBlacklist(GM_getValue(STORE.blacklist, [])); }
  function markManualSent(sent, item, session, blacklist = [], at = new Date().toISOString()) {
    if (blacklist.includes(item.account)) throw createAutomationError("BLACKLISTED", "此帳號已列入黑名單，不能標記為人工補送。");
    const next = updateSentRecord(sent, item, session, "sent", at);
    next[item.id].source = "manual";
    return next;
  }

  function normalizeMultilineText(value) {
    return String(value ?? "")
      .replace(/\uFEFF/g, "")
      .replace(/\r\n?/gu, "\n")
      .trim();
  }

  function normalizeCsvCell(value) {
    const raw = String(value ?? "").replace(/^\uFEFF/u, "").trim();
    const excelText = raw.match(/^="((?:[^"]|"")*)"$/u);
    return excelText ? excelText[1].replace(/""/gu, '"') : raw;
  }

  function parseNumber(value) {
    const parsed = Number(String(value ?? "").replace(/,/gu, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseStrictPositiveInteger(value) {
    const text = String(value ?? "").replace(/,/gu, "").trim();
    if (!text) return { state: "empty", value: null };
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { state: "invalid", value: null };
    }
    return { state: "ok", value: parsed };
  }

  function formatMoney(value) {
    return Math.round(Number(value) || 0).toLocaleString("zh-TW");
  }

  function totalWithShopeeFee(goodsTotal) {
    if (!Number.isSafeInteger(goodsTotal) || goodsTotal < 0) {
      throw new Error("商品總金額超出有效整數範圍，無法計算手續費。");
    }
    // 以整數運算避免乘 1.1 的浮點誤差；每位買家合計後才捨去小數。
    const total = BigInt(goodsTotal) * 110n / 100n;
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("含手續費總金額超出有效整數範圍。");
    }
    return Number(total);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;")
      .replace(/'/gu, "&#039;");
  }

  function parseCsv(text) {
    const source = String(text ?? "").replace(/^\uFEFF/u, "");
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (character === '"' && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n") {
        row.push(field.replace(/\r$/u, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }

    if (field.length || row.length) {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
    }
    return rows.filter((candidate) =>
      candidate.some((cell) => normalizeText(cell)),
    );
  }

  function splitColorSize(specification) {
    const compact = normalizeText(specification).replace(/\s+/gu, "");
    const upper = compact.toUpperCase();
    const size = SIZE_TOKENS.find((token) => upper.endsWith(token)) || "";
    if (!size) return { color: compact, size: "" };
    return {
      color: compact.slice(0, compact.length - size.length),
      size,
    };
  }

  // v1.1.7：抓單的「品名」本身就以商品代號開頭（H71 雪花棉…、H91雪花棉…），
  // 訊息前面又會再接一次代號，客人會看到「H71 H71 雪花棉…」。這裡把品名開頭
  // 重複的代號切掉；代號與品名之間有沒有空格都處理。
  function stripCodePrefix(code, productName) {
    const name = normalizeText(productName);
    const key = normalizeText(code);
    if (!name || !key) return name;
    if (!name.toUpperCase().startsWith(key.toUpperCase())) return name;
    const rest = name.slice(key.length);
    // 代號後面緊接英數字時，代表可能切到較長代號（例：H7/H71、A01/A01A），不切。
    if (/^[A-Za-z0-9]/u.test(rest)) return name;
    return rest.replace(/^[\s\-－—:：、]+/u, "") || name;
  }

  function parseLiveCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error("CSV 沒有可處理的資料列。");

    const headers = rows[0].map(normalizeText);
    const required = [
      "直播Session",
      "留言ID",
      "買家帳號",
      "原始留言",
      "商品代號",
      "品名",
      "規格尺寸",
      "數量",
      "價格",
      "狀態",
      "待確認",
      "彙總件數",
    ];
    const missing = required.filter((header) => !headers.includes(header));
    if (missing.length) {
      throw new Error(`CSV 缺少必要欄位：${missing.join("、")}`);
    }

    const indexes = Object.fromEntries(
      headers.map((header, index) => [header, index]),
    );
    const records = [];
    const identityErrors = [];
    const warnings = [];

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const get = (header) =>
        normalizeCsvCell(row[indexes[header]] ?? "");
      if (get("狀態") === "inactiveCode") continue;
      const accountResult = validateBuyerAccount(get("買家帳號"));
      const account = accountResult.text;
      let buyerUid = "";
      if (!accountResult.ok) identityErrors.push(accountProblem(`CSV 第 ${rowIndex + 1} 列`, get("買家帳號")));
      try { buyerUid = readBuyerUid(get("買家UID")); }
      catch (error) { identityErrors.push(`CSV 第 ${rowIndex + 1} 列：${error.message}`); }
      if (!accountResult.ok) continue;
      const code = normalizeText(get("商品代號")).toUpperCase();
      const productName = normalizeText(get("品名"));
      const rawQuantity = parseNumber(get("數量"));
      const aggregatedQuantity = parseNumber(get("彙總件數"));
      const quantity = aggregatedQuantity > 0
        ? aggregatedQuantity
        : rawQuantity;
      const price = parseNumber(get("價格"));
      if (!account || !code || !productName || quantity <= 0) {
        warnings.push(
          `第 ${rowIndex + 1} 列缺少帳號、商品編號、品名或有效數量，已跳過。`,
        );
        continue;
      }

      const status = normalizeText(get("狀態")).toLowerCase();
      const pendingFlag = normalizeText(get("待確認"));
      const specification = splitColorSize(get("規格尺寸"));
      records.push({
        session: normalizeText(get("直播Session")),
        messageId: normalizeText(get("留言ID")),
        account,
        buyerUid,
        code,
        productName,
        color: specification.color,
        size: specification.size,
        quantity,
        price,
        bucket:
          status === "confirmed" && pendingFlag !== "是"
            ? "confirmed"
            : "review",
        status,
        pendingFlag,
        rawMessage: normalizeText(get("原始留言")),
      });
    }

    if (identityErrors.length) throw buyerAccountError(identityErrors);
    if (!records.length) {
      throw new Error("CSV 中沒有可用的喊單資料。");
    }
    return { records, warnings };
  }

  function naturalCompare(left, right) {
    return String(left).localeCompare(String(right), "zh-Hant", {
      numeric: true,
      sensitivity: "base",
    });
  }

  const ROSTER_TITLE = "買家名冊 v1";
  const ROSTER_PREFIX = "SHOPEE_BUYER_ROSTER_V1:";
  const MISSING_ROSTER_WARNING = "這份檔沒有買家名冊，無法核對帳號是否被 Excel 改過";
  const INVALID_ROSTER_WARNING = "買家名冊無法使用，請核對原始資料與帳號；本次僅做帳號型別與樣式檢查";
  const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const ACCOUNT_DATE = new RegExp(`^(?:\\d+-${MONTH}(?:-\\d{2})?|${MONTH}-\\d{2}|\\d+月\\d+日|\\d{4}/\\d{1,2}/\\d{1,2})$`, "u");
  const ACCOUNT_SCIENTIFIC = /^[+-]?\d+(?:\.\d+)?E[+-]\d+$/u;
  const ACCOUNT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  const ACCOUNT_ERROR = /^(?:TRUE|FALSE|#NAME\?|#VALUE!|#REF!|#DIV\/0!|#N\/A|#NUM!|#NULL!)$/u;

  function effectiveBuyerText(value) {
    if (value == null) return { ok: true, text: "" };
    if (typeof value === "string") return { ok: true, text: value };
    if (typeof value !== "object" || Object.prototype.toString.call(value) === "[object Date]") return { ok: false, text: "" };
    if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) {
      return typeof value.result === "string" ? { ok: true, text: value.result } : { ok: false, text: "" };
    }
    if (typeof value.text === "string") return { ok: true, text: value.text };
    if (Array.isArray(value.richText) && value.richText.every(part => typeof part?.text === "string")) {
      return { ok: true, text: value.richText.map(part => part.text).join("") };
    }
    return { ok: false, text: "" };
  }

  function validateBuyerAccount(value) {
    const result = effectiveBuyerText(value);
    const text = result.ok ? normalizeText(normalizeCsvCell(result.text)) : "";
    const converted = ACCOUNT_DATE.test(text) || ACCOUNT_SCIENTIFIC.test(text) || ACCOUNT_ISO.test(text) || ACCOUNT_ERROR.test(text);
    return { ok: result.ok && !converted, text, reason: !result.ok ? "non-text" : converted ? "excel-shape" : "" };
  }

  function accountProblem(label, value) {
    const display = buyerValueDisplay(value);
    return `${label}買家帳號「${display}」不是文字或疑似被 Excel 轉型；請從原始資料核對並以文字改回正確帳號，只改顯示格式不能還原。`;
  }

  function buyerValueDisplay(value) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return Number.isFinite(value.getTime()) ? `日期 ${value.getUTCFullYear()}/${value.getUTCMonth() + 1}/${value.getUTCDate()}` : "無效日期";
    }
    if (typeof value === "number") return `數字 ${value}`;
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) {
        return Object.hasOwn(value, "result") ? buyerValueDisplay(value.result) : "公式（沒有已儲存的文字結果）";
      }
      if (value.error) return `錯誤值 ${value.error}`;
      const text = effectiveBuyerText(value);
      if (text.ok) return text.text;
    }
    return String(value ?? "");
  }

  function buyerAccountError(errors) {
    const error = new Error(errors.join("；"));
    error.code = "BUYER_ACCOUNT_REVIEW_REQUIRED";
    error.details = { issues: errors };
    return error;
  }

  function readBuyerUid(value) {
    if (value == null || value === "") return "";
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && String(value).length <= 15) return String(value);
    if (typeof value === "string") {
      const text = normalizeCsvCell(value); // UID 不做帳號的 NFKC／空白壓縮。
      if (!text || /^[0-9]+$/u.test(text)) return text;
    }
    if (value && typeof value === "object") {
      const result = effectiveBuyerText(value);
      if (result.ok) return readBuyerUid(result.text);
    }
    throw buyerAccountError(["買家 UID 格式或精度無法確認，請從原始資料核對，不得四捨五入或猜測。"]);
  }

  function rosterRows(sources) {
    const byAccount = new Map(), byUid = new Map(), errors = [];
    for (const [index, row] of sources.entries()) {
      const account = validateBuyerAccount(row.account);
      if (typeof row.account !== "string" || !account.ok) { errors.push(accountProblem(`名冊來源第 ${index + 1} 列`, row.account)); continue; }
      if (!account.text) continue;
      let uid;
      try { uid = readBuyerUid(row.buyerUid); } catch (error) { errors.push(`名冊來源第 ${index + 1} 列：${error.message}`); continue; }
      const previous = byAccount.get(account.text);
      if (previous && uid && previous !== uid) errors.push(`帳號「${account.text}」對應不同 UID：${previous}／${uid}。`);
      if (uid && byUid.has(uid) && byUid.get(uid) !== account.text) errors.push(`UID ${uid} 對應不同帳號：${byUid.get(uid)}／${account.text}。`);
      byAccount.set(account.text, previous || uid);
      if (uid) byUid.set(uid, account.text);
    }
    if (errors.length) throw buyerAccountError(errors);
    return [...byAccount].map(([account, buyerUid]) => ({ account, buyerUid }))
      .sort((a, b) => a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
  }

  function rosterFingerprint(meta, rows) {
    return hashString(JSON.stringify([meta.schema, meta.session, meta.scope, meta.count, rows.map(row => [row.account, row.buyerUid])]));
  }

  function hasRosterArea(sheet) {
    return cellText(sheet.getCell("J1")) === ROSTER_TITLE || cellText(sheet.getCell("J2")) === "名冊買家帳號" ||
      cellText(sheet.getCell("K2")) === "名冊買家UID" || cellText(sheet.getCell("L1")).startsWith(ROSTER_PREFIX);
  }

  function writeBuyerRoster(sheet, model) {
    const visible = [...model.confirmedRows, ...model.reviewRows];
    const rows = rosterRows(Array.isArray(model.buyerRoster) ? [...model.buyerRoster, ...visible] : visible.map(row => ({ account: row.account, buyerUid: "" })));
    const meta = { schema: 1, session: normalizeText(model.session), scope: Array.isArray(model.buyerRoster) ? "來源 CSV" : "本檔可見買家", count: rows.length };
    meta.fingerprint = rosterFingerprint(meta, rows);
    sheet.getCell("J1").value = ROSTER_TITLE;
    sheet.getCell("J2").value = "名冊買家帳號";
    sheet.getCell("K2").value = "名冊買家UID";
    sheet.getCell("L1").value = ROSTER_PREFIX + JSON.stringify(meta);
    sheet.getColumn(10).width = 24; sheet.getColumn(11).width = 22; sheet.getColumn(12).width = 28;
    sheet.getColumn(10).numFmt = "@"; sheet.getColumn(11).numFmt = "@"; sheet.getColumn(12).numFmt = "@";
    rows.forEach((row, index) => {
      sheet.getCell(index + 3, 10).value = row.account;
      sheet.getCell(index + 3, 11).value = row.buyerUid;
    });
    return { meta, rows };
  }

  function readBuyerRoster(sheet, session) {
    if (!hasRosterArea(sheet)) return { accounts: null, warning: MISSING_ROSTER_WARNING };
    try {
      const raw = cellText(sheet.getCell("L1"));
      if (!raw.startsWith(ROSTER_PREFIX)) throw new Error();
      const meta = JSON.parse(raw.slice(ROSTER_PREFIX.length));
      if (meta.schema !== 1 || meta.session !== session || !["來源 CSV", "本檔可見買家"].includes(meta.scope) ||
          !Number.isSafeInteger(meta.count) || meta.count < 0 || meta.count > Math.max(0, sheet.rowCount - 2) ||
          cellText(sheet.getCell("J1")) !== ROSTER_TITLE || cellText(sheet.getCell("J2")) !== "名冊買家帳號" || cellText(sheet.getCell("K2")) !== "名冊買家UID") throw new Error();
      const rawRows = Array.from({ length: meta.count }, (_, index) => {
        const result = effectiveBuyerText(sheet.getCell(index + 3, 10).value);
        if (!result.ok || !result.text) throw new Error();
        return { account: result.text, buyerUid: readBuyerUid(sheet.getCell(index + 3, 11).value) };
      });
      const rows = rosterRows(rawRows);
      if (rows.length !== rawRows.length || rosterFingerprint(meta, rows) !== meta.fingerprint) throw new Error();
      return { accounts: new Map(rows.map(row => [row.account, row.buyerUid])), meta, warning: "" };
    } catch { return { accounts: null, warning: INVALID_ROSTER_WARNING }; }
  }

  function buildReviewModel(parsed) {
    const buyerRoster = rosterRows(parsed.records);
    const grouped = new Map();
    const products = new Map();
    const sessions = new Set();

    for (const record of parsed.records) {
      if (record.session) sessions.add(record.session);
      if (!products.has(record.code)) {
        products.set(record.code, {
          code: record.code,
          productName: record.productName,
          sourcePrices: [],
        });
      }
      const product = products.get(record.code);
      if (!product.sourcePrices.includes(record.price)) {
        product.sourcePrices.push(record.price);
      }

      const key = [
        record.bucket,
        record.account,
        record.code,
        record.productName,
        record.color,
        record.size,
        record.price,
      ].join("\u001F");
      if (!grouped.has(key)) {
        grouped.set(key, {
          bucket: record.bucket,
          account: record.account,
          buyerUid: record.buyerUid || "",
          code: record.code,
          productName: record.productName,
          color: record.color,
          size: record.size,
          unitPrice: record.price,
          quantity: 0,
          rawMessages: [],
        });
      }
      const target = grouped.get(key);
      target.quantity += record.quantity;
      if (record.rawMessage && !target.rawMessages.includes(record.rawMessage)) {
        target.rawMessages.push(record.rawMessage);
      }
    }

    const sortRows = (rows) =>
      rows.sort(
        (left, right) =>
          naturalCompare(left.account, right.account) ||
          naturalCompare(left.code, right.code) ||
          naturalCompare(left.color, right.color) ||
          naturalCompare(left.size, right.size),
      );
    const rows = [...grouped.values()].map((row) => ({
      ...row,
      rawMessage: row.rawMessages.join(" / "),
    }));
    const priceRows = [...products.values()]
      .sort((left, right) => naturalCompare(left.code, right.code))
      .map((product) => ({
        ...product,
        reviewedPrice:
          product.sourcePrices.length === 1
            ? product.sourcePrices[0] || 0
            : null,
        warning:
          product.sourcePrices.length > 1
            ? `ℹ️ 多個有效來源價，G 欄已逐列沿用：${product.sourcePrices.join(" / ")}`
            : "",
      }));

    return {
      buyerRoster,
      session: [...sessions].join("、"),
      confirmedRows: sortRows(
        rows.filter((row) => row.bucket === "confirmed"),
      ),
      reviewRows: sortRows(rows.filter((row) => row.bucket === "review")),
      priceRows,
      warnings: parsed.warnings,
    };
  }

  function formulaCell(formula, result) {
    return { formula, result };
  }

  function styleHeaderRow(sheet, rowNumber, endColumn) {
    const row = sheet.getRow(rowNumber);
    row.height = 25;
    for (let column = 1; column <= endColumn; column += 1) {
      const cell = row.getCell(column);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF374151" },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    }
  }

  function applyDataSheetStyles(sheet, dataCount, pending) {
    const endColumn = 7;
    const lastDataRow = 5 + dataCount;
    sheet.views = [{ state: "frozen", ySplit: 5 }];
    sheet.autoFilter = {
      from: { row: 5, column: 1 },
      to: { row: 5, column: endColumn },
    };
    sheet.getRow(1).height = 30;
    sheet.getCell("A1").font = {
      bold: true,
      size: 16,
      color: { argb: "FFFFFFFF" },
    };
    sheet.getCell("A1").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: pending ? "FFF59E0B" : "FF16A34A" },
    };
    sheet.getCell("A1").alignment = {
      vertical: "middle",
      horizontal: "left",
    };
    styleHeaderRow(sheet, 5, endColumn);
    const widths = [22, 12, 34, 14, 10, 10, 14];
    widths.forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(6).numFmt = "0";
    sheet.getColumn(1).numFmt = "@";
    sheet.getColumn(7).numFmt = "#,##0";

    for (let rowNumber = 6; rowNumber <= lastDataRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      row.alignment = { vertical: "middle", wrapText: true };
      for (let column = 1; column <= endColumn; column += 1) {
        row.getCell(column).border = {
          bottom: { style: "hair", color: { argb: "FFD1D5DB" } },
        };
      }
    }
    sheet.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: {
        left: 0.25,
        right: 0.25,
        top: 0.5,
        bottom: 0.5,
        header: 0.2,
        footer: 0.2,
      },
    };
  }

  function populateDataSheet(sheet, title, rows, priceRows, pending) {
    const endColumnLetter = "G";
    const multiPriceNote =
      "黃底代表同一個商品編號出現不同價格，請確認是不是打錯。";
    sheet.mergeCells(`A1:${endColumnLetter}1`);
    sheet.getCell("A1").value = title;
    sheet.getCell("A2").value = "總金額";
    sheet.getCell("D2").value = "資料列數";
    sheet.getCell("E2").value = formulaCell(
      "COUNTA(A6:A5000)",
      rows.length,
    );
    sheet.mergeCells(`A3:${endColumnLetter}3`);
    const baseNote = pending
      ? "人工審核：必填為買家帳號、商品編號、數量、金額(小計)；商品名稱／顏色／尺寸可留空。G 欄是該列小計，不是單價。確認要收後，把 A:G 資料列剪下貼到工作表1「已確認」。留在本表不發送。"
      : "完整發送清單：程式重新上傳後只讀本工作表。商品名稱／顏色／尺寸可留空；G 欄是該列小計，不是單價。單一價商品可在「設定與價格」改審核單價；多價商品的 G 欄已逐列保留原檔價格。";
    sheet.getCell("A3").value = `${baseNote}${multiPriceNote}`;
    sheet.getCell("A3").font = {
      color: { argb: "FF92400E" },
      italic: true,
    };
    sheet.getCell("A3").alignment = {
      vertical: "middle",
      wrapText: true,
    };
    sheet.getRow(3).height = pending ? 58 : 48;
    sheet.getRow(5).values = [...ORDER_HEADERS];

    const priceEndRow = Math.max(3, 2 + priceRows.length);
    const productsByCode = new Map(
      priceRows.map((priceRow) => [priceRow.code, priceRow]),
    );
    rows.forEach((row, index) => {
      const rowNumber = 6 + index;
      sheet.getRow(rowNumber).values = [
        row.account,
        row.code,
        row.productName,
        row.color || null,
        row.size || null,
        row.quantity,
      ];
      sheet.getCell(rowNumber, 1).numFmt = "@";
      const product = productsByCode.get(row.code);
      const hasMultipleSourcePrices =
        (product?.sourcePrices?.length || 0) > 1;
      const price = hasMultipleSourcePrices
        ? row.unitPrice
        : product?.reviewedPrice || 0;
      const formula = hasMultipleSourcePrices
        ? `INDEX($F$1:$F$5000,ROW())*${price}`
        : `INDEX($F$1:$F$5000,ROW())*IFERROR(VLOOKUP(INDEX($B$1:$B$5000,ROW()),'設定與價格'!$A$3:$D$${priceEndRow},4,FALSE),0)`;
      sheet.getCell(`G${rowNumber}`).value = formulaCell(
        formula,
        row.quantity * price,
      );
      if (hasMultipleSourcePrices) {
        for (const column of ["B", "G"]) {
          const cell = sheet.getCell(`${column}${rowNumber}`);
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFF1C7" },
          };
          cell.font = {
            ...(cell.font || {}),
            color: { argb: "FF6B4600" },
          };
        }
      }
    });

    if (rows.length) {
      sheet.getCell("G2").value = formulaCell(
        "SUM(G6:G5000)",
        rows.reduce(
          (sum, row) => {
            const product = productsByCode.get(row.code);
            const price =
              (product?.sourcePrices?.length || 0) > 1
                ? row.unitPrice
                : product?.reviewedPrice || 0;
            return sum + row.quantity * price;
          },
          0,
        ),
      );
    } else {
      sheet.getCell("G2").value = 0;
    }
    sheet.getCell("G2").numFmt = "#,##0";
    applyDataSheetStyles(sheet, rows.length, pending);
  }

  function addPriceAudit(settingsSheet, priceRows) {
    settingsSheet.mergeCells("A1:E1");
    settingsSheet.getCell("A1").value =
      "商品價格審核（單一價可改 D；多價商品逐列沿用 G）";
    settingsSheet.getCell("A1").font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    settingsSheet.getCell("A1").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0F766E" },
    };
    settingsSheet.getRow(2).values = [
      "商品編號",
      "商品名稱",
      "來源價格",
      "審核單價",
      "價格警示",
    ];
    for (let column = 1; column <= 5; column += 1) {
      const cell = settingsSheet.getRow(2).getCell(column);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF115E59" },
      };
      cell.alignment = { horizontal: "center" };
    }
    priceRows.forEach((product, index) => {
      const rowNumber = index + 3;
      const isInformation = product.warning?.startsWith("ℹ️");
      settingsSheet.getCell(`A${rowNumber}`).value = product.code;
      settingsSheet.getCell(`B${rowNumber}`).value = product.productName;
      settingsSheet.getCell(`C${rowNumber}`).value =
        product.sourcePrices.join(" / ");
      settingsSheet.getCell(`D${rowNumber}`).value = product.reviewedPrice;
      settingsSheet.getCell(`E${rowNumber}`).value = product.warning || null;
      settingsSheet.getCell(`D${rowNumber}`).numFmt = "#,##0";
      settingsSheet.getCell(`D${rowNumber}`).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb: isInformation
            ? "FFE0F2FE"
            : product.warning
              ? "FFFFE4B5"
              : "FFE0F2FE",
        },
      };
      if (product.warning) {
        settingsSheet.getCell(`E${rowNumber}`).font = {
          color: { argb: isInformation ? "FF0369A1" : "FFB91C1C" },
          bold: !isInformation,
        };
      }
    });
    [12, 34, 18, 14, 42].forEach((width, index) => {
      settingsSheet.getColumn(1 + index).width = width;
    });
    settingsSheet.views = [{ state: "frozen", ySplit: 2 }];
  }

  function addMessageSettings(settingsSheet, config, session) {
    settingsSheet.mergeCells("G1:H1");
    settingsSheet.getCell("G1").value = "客人訊息設定（可編輯）";
    settingsSheet.getCell("G1").font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    settingsSheet.getCell("G1").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF7C3AED" },
    };
    const settings = [
      ["開頭範本", config.openingTemplate],
      ["結尾範本", config.closingTemplate],
      ["場次日期", config.eventDate],
      ["結單日", config.closingDate],
      ["直播Session", session],
      ["場次日期來源", config.eventDateSource || "來源不明"],
      ["結單日來源", config.closingDateSource || "來源不明"],
    ];
    settings.forEach(([label, value], index) => {
      const rowNumber = 2 + index;
      settingsSheet.getCell(`G${rowNumber}`).value = label;
      settingsSheet.getCell(`G${rowNumber}`).font = { bold: true };
      settingsSheet.getCell(`G${rowNumber}`).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEDE9FE" },
      };
      settingsSheet.getCell(`H${rowNumber}`).value = value;
      settingsSheet.getCell(`H${rowNumber}`).alignment = {
        wrapText: true,
        vertical: "top",
      };
    });
    settingsSheet.getColumn(7).width = 15;
    settingsSheet.getColumn(8).width = 48;
  }

  const COMBO_PROMOTION_SCHEMA_VERSION = 1;
  const COMBO_TITLE = "本場優惠 v1";
  const COMBO_RESERVED_CODE = "組合優惠";
  const COMBO_HEADERS = ["組別", "優惠商品", "算法", "件數", "金額"];
  const COMBO_TYPES = { bundle: "幾件一組共多少", each: "幾件以上每件多少" };
  const COMBO_FORBIDDEN_LABELS = new Set(["商品編號", "審核單價", "來源價格", "開頭範本", "結尾範本", "場次日期", "結單日", "直播Session", "場次日期來源", "結單日來源"]);

  function comboError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function comboSafe(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      const tooLarge = typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)));
      const message = tooLarge ? "數字太大，超出可計算範圍。" : minimum === 2
        ? value === 0 || value == null || value === "" ? "沒有填，請填 2 以上的整數。"
          : !Number.isInteger(value) ? "必須填整數，而且至少是 2。" : "要是 2 以上的整數。"
        : minimum > 0 ? "沒有填，或不是大於 0 的整數。" : "必須是 0 以上的整數。";
      throw comboError("COMBO_NUMERIC_INVALID", `${label}${message}`);
    }
    return value;
  }

  function parseComboProductCodes(value, label = "優惠商品") {
    const tokens = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、\s]+/u).filter(Boolean) : null;
    if (!tokens || tokens.some((token) => typeof token !== "string")) throw comboError("COMBO_V1", `${label}必須填商品編號文字。`);
    const codes = tokens.map(normalizeProductCode);
    if (!codes.length || codes.some((code) => !code)) throw comboError("COMBO_V1", `${label}沒有商品編號。`);
    const seen = new Set();
    for (const code of codes) {
      if (seen.has(code)) throw comboError("COMBO_V2", `${label}重複商品編號 ${code}。`);
      seen.add(code);
    }
    return codes.sort(naturalCompare);
  }

  function normalizeComboPromotions(input) {
    if (input == null) return [];
    if (!Array.isArray(input)) throw comboError("COMBO_V1", "優惠設定必須是組別清單。");
    if (input.length > 30) throw comboError("COMBO_V12", "優惠最多 30 組。");
    const codesUsed = new Set(), idsUsed = new Set();
    return input.map((group, index) => {
      const label = group?.sourceRow ? `優惠表第 ${group.sourceRow} 列／第 ${index + 1} 組：` : `第 ${index + 1} 組：`;
      if (!group || typeof group !== "object") throw comboError("COMBO_V1", `${label}資料不完整。`);
      const groupId = comboSafe(group.groupId, `${label}組別`, 1);
      if (idsUsed.has(groupId)) throw comboError("COMBO_V2", `${label}組別 ${groupId} 重複。`);
      idsUsed.add(groupId);
      const productCodes = parseComboProductCodes(group.productCodes, `${label}優惠商品`);
      if (productCodes.length > 20) throw comboError("COMBO_V12", `${label}最多 20 個標。`);
      for (const code of productCodes) {
        if (code === COMBO_RESERVED_CODE || COMBO_FORBIDDEN_LABELS.has(code)) throw comboError("COMBO_V10", `${label}${code} 是優惠表保留文字，不能設優惠。`);
        if (codesUsed.has(code)) throw comboError("COMBO_V2", `${label}${code} 已出現在其他組。`);
        codesUsed.add(code);
      }
      if (!Array.isArray(group.rules) || !group.rules.length) throw comboError("COMBO_V1", `${label}沒有優惠規則。`);
      if (group.rules.length > 5) throw comboError("COMBO_V12", `${label}最多 5 條規則。`);
      const ruleKeys = new Set();
      const rules = group.rules.map((rule, ruleIndex) => {
        const ruleLabel = rule?.sourceRow ? `優惠表第 ${rule.sourceRow} 列／組別 ${groupId}：` : `${label}第 ${ruleIndex + 1} 條：`;
        if (!rule || !Object.hasOwn(COMBO_TYPES, rule.type)) throw comboError("COMBO_V7", `${ruleLabel}算法必須是幾件一組或幾件以上每件。`);
        const quantity = comboSafe(rule.quantity, `${ruleLabel}件數`, 2);
        const amount = comboSafe(rule.amount, `${ruleLabel}金額`, 1);
        const key = `${rule.type}:${quantity}`;
        if (ruleKeys.has(key)) throw comboError("COMBO_V9", `${ruleLabel}同算法與件數 ${quantity} 重複。`);
        ruleKeys.add(key);
        const normalized = { type: rule.type, quantity, amount };
        if (rule.sourceRow) Object.defineProperty(normalized, "sourceRow", { value: rule.sourceRow });
        return normalized;
      });
      const normalized = { groupId, productCodes, rules };
      if (group.sourceRow) Object.defineProperty(normalized, "sourceRow", { value: group.sourceRow });
      return normalized;
    });
  }

  function validateComboPromotions(input, prices, multiPriceCodes = new Set(), rows = []) {
    const groups = normalizeComboPromotions(input);
    for (const [index, group] of groups.entries()) {
      const label = `${group.sourceRow ? `優惠表第 ${group.sourceRow} 列／` : ""}第 ${index + 1} 組（${group.productCodes.join("、")}）：`;
      let unitPrice;
      for (const code of group.productCodes) {
        if (!prices.has(code)) throw comboError("COMBO_V3", `${label}本場價格表沒有 ${code}。可能是這一場沒有這個標的訂單，或編號打錯；請核對後從這一組拿掉。`);
        if (multiPriceCodes.has(code)) throw comboError("COMBO_V4", `${label}${code} 是多價商品。`);
        const price = prices.get(code);
        if (!Number.isSafeInteger(price) || price <= 0) throw comboError("COMBO_V6", `${label}${code} 審核單價 ${price} ${typeof price === "number" && (!Number.isFinite(price) || (Number.isInteger(price) && !Number.isSafeInteger(price))) ? "數字太大，超出可計算範圍。" : "必須是大於 0 的整數。"}`);
        if (unitPrice != null && price !== unitPrice) throw comboError("COMBO_V5", `${label}${code} 單價 ${price} 與同組單價 ${unitPrice} 不同。`);
        unitPrice = price;
      }
      for (const [ruleIndex, rule] of group.rules.entries()) {
        const original = comboSafe(rule.quantity * unitPrice, `${label}第 ${ruleIndex + 1} 條件數 × 單價`);
        if (rule.amount >= (rule.type === "bundle" ? original : unitPrice)) {
          const ruleLabel = `${rule.sourceRow ? `優惠表第 ${rule.sourceRow} 列／` : ""}第 ${index + 1} 組（${group.productCodes.join("、")}）：`;
          throw comboError("COMBO_V8", `${ruleLabel}第 ${ruleIndex + 1} 條優惠金額 ${rule.amount} 沒有比原價便宜，請連優惠規則一起修改。`);
        }
      }
    }
    for (const row of rows) if (normalizeProductCode(row.code) === COMBO_RESERVED_CODE) throw comboError("COMBO_V10", `「已確認」${formatSourceRows(row)}商品編號 ${COMBO_RESERVED_CODE} 是有優惠表時的保留字。`);
    return groups;
  }

  function summarizeComboPromotions(items, groups) {
    const summaryGroups = groups.map((group) => ({ groupId: group.groupId, productCodes: [...group.productCodes], unitPrice: group.unitPrice, appliedBuyerCount: 0, discountTotal: 0, skippedBuyerCount: 0 }));
    const byId = new Map(summaryGroups.map((group) => [group.groupId, group]));
    const applied = new Set(), skipped = new Set();
    let discountTotal = 0, skippedBuyerGroupCount = 0;
    for (const item of items) {
      for (const discount of item.discounts || []) {
        applied.add(item.account);
        const group = byId.get(discount.groupId);
        if (!group) throw comboError("COMBO_SUMMARY_INVALID", "折抵的組別不在優惠設定裡。");
        group.appliedBuyerCount++;
        group.discountTotal = comboSafe(group.discountTotal + discount.discountAmount, "組別折抵合計");
        discountTotal = comboSafe(discountTotal + discount.discountAmount, "折抵合計");
      }
      for (const skip of item.promotionSkips || []) {
        skipped.add(item.account); skippedBuyerGroupCount++;
        const group = byId.get(skip.groupId);
        if (!group) throw comboError("COMBO_SUMMARY_INVALID", "跳過的組別不在優惠設定裡。");
        group.skippedBuyerCount++;
      }
    }
    return { appliedBuyerCount: applied.size, discountTotal, skippedBuyerCount: skipped.size, skippedBuyerGroupCount, groups: summaryGroups };
  }

  function calculateComboPromotions(rows, groups, prices, amountSources = new Map()) {
    const byAccount = new Map();
    for (const row of rows) {
      comboSafe(row.quantity, `「已確認」${formatSourceRows(row)}數量`, 1);
      comboSafe(row.directAmount, `「已確認」${formatSourceRows(row)}小計`, 1);
      if (!byAccount.has(row.account)) byAccount.set(row.account, { account: row.account, rows: [], originalGoodsTotal: 0, discountTotal: 0, discounts: [], promotionSkips: [] });
      const buyer = byAccount.get(row.account);
      buyer.rows.push(row);
      buyer.originalGoodsTotal = comboSafe(buyer.originalGoodsTotal + row.directAmount, `${row.account} 商品小計合計`);
    }
    const warnings = [], summaries = [];
    let budget = 0;
    for (const group of groups) {
      const unitPrice = prices.get(group.productCodes[0]);
      const selected = new Set(group.productCodes), eligible = [];
      let maximum = 0;
      for (const buyer of byAccount.values()) {
        const groupRows = buyer.rows.filter((row) => selected.has(row.code));
        if (!groupRows.length) continue;
        let quantity = 0, originalAmount = 0;
        const mismatchedRows = [];
        for (const row of groupRows) {
          quantity = comboSafe(quantity + row.quantity, `${buyer.account}／組別 ${group.groupId} 件數`);
          originalAmount = comboSafe(originalAmount + row.directAmount, `${buyer.account}／組別 ${group.groupId} 小計`);
          const expectedAmount = comboSafe(row.quantity * unitPrice, `「已確認」${formatSourceRows(row)}數量 × 審核單價`);
          if (row.directAmount !== expectedAmount) mismatchedRows.push({ sourceRow: row.sourceRow, quantity: row.quantity, reviewedUnitPrice: unitPrice, expectedAmount, actualAmount: row.directAmount, amountSource: amountSources.get(row.sourceRow) || (row.amountState === "empty" || row.amountState === "formula-missing" ? "fallback" : "number") });
        }
        const productCodes = [...new Set(groupRows.map((row) => row.code))].sort(naturalCompare);
        if (mismatchedRows.length) {
          buyer.promotionSkips.push({ groupId: group.groupId, productCodes, quantity, originalAmount, reason: "AMOUNT_MISMATCH", mismatchedRows });
          warnings.push(`買家 ${buyer.account}／${productCodes.join("、")} 本組商品小計與數量 × 審核單價不符，本組未另套用組合優惠，採用 G 欄金額；請核對金額及公式是否已重算。`);
        } else { eligible.push({ buyer, productCodes, quantity, originalAmount }); maximum = Math.max(maximum, quantity); }
      }
      budget = comboSafe(budget + maximum, "各組最大件數合計");
      if (budget > 100_000) throw comboError("COMBO_V12", `各組最大件數合計 ${budget} 超過 100,000（組別 ${group.groupId}）。`);
      const best = new Array(maximum + 1); best[0] = 0;
      for (let count = 1; count <= maximum; count++) {
        let value = comboSafe(best[count - 1] + unitPrice, `組別 ${group.groupId} 第 ${count} 件原價加法`);
        for (const rule of group.rules) if (rule.type === "bundle" && rule.quantity <= count) value = Math.min(value, comboSafe(best[count - rule.quantity] + rule.amount, `組別 ${group.groupId} 組合價加法`));
        best[count] = value;
      }
      for (const entry of eligible) {
        const original = comboSafe(entry.quantity * unitPrice, `${entry.buyer.account}／組別 ${group.groupId} 原價`);
        let payableAmount = best[entry.quantity];
        for (const rule of group.rules) if (rule.type === "each" && rule.quantity <= entry.quantity) payableAmount = Math.min(payableAmount, comboSafe(entry.quantity * rule.amount, `${entry.buyer.account}／組別 ${group.groupId} 每件優惠乘法`));
        const discountAmount = comboSafe(original - payableAmount, `${entry.buyer.account}／組別 ${group.groupId} 折抵`);
        if (discountAmount > 0) {
          entry.buyer.discountTotal = comboSafe(entry.buyer.discountTotal + discountAmount, `${entry.buyer.account} 折抵合計`);
          entry.buyer.discounts.push({ groupId: group.groupId, productCodes: entry.productCodes, quantity: entry.quantity, description: `${entry.productCodes.join("、")} 共 ${entry.quantity} 件`, originalAmount: entry.originalAmount, payableAmount, discountAmount });
        }
      }
      summaries.push({ groupId: group.groupId, productCodes: group.productCodes, unitPrice });
    }
    for (const buyer of byAccount.values()) if (buyer.originalGoodsTotal - buyer.discountTotal <= 0) throw comboError("COMBO_V11", `${buyer.account} 折抵後的商品金額必須大於 0。`);
    return { byAccount, warnings, summary: summarizeComboPromotions([...byAccount.values()], summaries) };
  }

  function preflightComboPromotions(model, input) {
    const prices = new Map(model.priceRows.map((row) => [row.code, row.reviewedPrice]));
    const multi = new Set(model.priceRows.filter((row) => (row.sourcePrices?.length || 0) > 1).map((row) => row.code));
    const rows = model.confirmedRows.map((row, index) => {
      const price = multi.has(row.code) ? row.unitPrice : prices.get(row.code) || 0;
      return { ...row, sourceRow: index + 6, directAmount: row.quantity * price };
    });
    const groups = validateComboPromotions(input, prices, multi, rows);
    const result = calculateComboPromotions(rows, groups, prices);
    return { comboPromotions: groups, promotionSummary: result.summary };
  }

  function comboTextCell(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && Object.keys(value).every(key => key === "richText") &&
      Array.isArray(value.richText) && value.richText.every(part => part && typeof part.text === "string")) {
      return value.richText.map(part => part.text).join("");
    }
    return value;
  }

  function parseComboTableCells(matrix) {
    const isBlank = (value) => value == null || value === "";
    const title = comboTextCell(matrix[0]?.[0]);
    const header = COMBO_HEADERS.map((_, index) => comboTextCell(matrix[1]?.[index]));
    const hasData = matrix.slice(2).some(row => row.some(value => !isBlank(value)));
    if (isBlank(title) && header.every(isBlank) && !hasData) return null;
    if (title !== COMBO_TITLE) {
      const occupied = matrix.flatMap((values, index) => values.map((value, column) =>
        (index === 0 && column !== 0) || isBlank(value) ? null : `${String.fromCharCode(78 + column)}${index + 1}（第 ${index + 1} 列）`)).filter(Boolean);
      throw comboError("COMBO_TABLE_INVALID", `「設定與價格」N～R 欄是本場優惠表的位置；${occupied[0] || "N1（第 1 列）"}有內容，N1 標題或版本不正確。若這一場不設定優惠，請清除這裡的內容；若要使用優惠，請修好本場優惠的標題、表頭與規則後再匯入。`);
    }
    for (let index = 0; index < header.length; index++) if (header[index] !== COMBO_HEADERS[index]) throw comboError("COMBO_TABLE_INVALID", `優惠表 ${String.fromCharCode(78 + index)}2 表頭必須是「${COMBO_HEADERS[index]}」。`);
    const groups = new Map(); let ended = false;
    for (let row = 3; row <= matrix.length; row++) {
      const values = matrix[row - 1];
      if (values.every(isBlank)) { ended = true; continue; }
      if (ended) throw comboError("COMBO_TABLE_INVALID", `優惠表第 ${row} 列在空列之後仍有規則。`);
      const [id, rawCodes, rawType, quantity, amount] = values;
      const codeText = comboTextCell(rawCodes), typeText = comboTextCell(rawType);
      if (!Number.isSafeInteger(id) || id <= 0 || typeof codeText !== "string" || typeof typeText !== "string" || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(amount)) {
        const tooLarge = [id, quantity, amount].some(value => typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))));
        throw comboError("COMBO_TABLE_INVALID", `優惠表第 ${row} 列：${tooLarge ? "數字太大，超出可計算範圍。" : "組別、件數、金額必須填整數數值，優惠商品與算法必須是文字；不接受公式、日期或其他型別。"}`);
      }
      const productCodes = parseComboProductCodes(codeText, `優惠表第 ${row} 列`);
      const type = Object.keys(COMBO_TYPES).find((key) => COMBO_TYPES[key] === typeText);
      if (!type) throw comboError("COMBO_V7", `優惠表第 ${row} 列算法不正確。`);
      if (!groups.has(id)) groups.set(id, { groupId: id, productCodes, rules: [], sourceRow: row });
      const group = groups.get(id);
      if (JSON.stringify(group.productCodes) !== JSON.stringify(productCodes)) throw comboError("COMBO_TABLE_INVALID", `優惠表第 ${row} 列：組別 ${id} 的優惠商品集合不一致。`);
      group.rules.push({ type, quantity, amount, sourceRow: row });
    }
    return normalizeComboPromotions([...groups.values()]);
  }

  function comboTableFromSheet(sheet) {
    const matrix = Array.from({ length: Math.max(2, sheet.rowCount) }, (_, index) => COMBO_HEADERS.map((_, column) => sheet.getCell(index + 1, column + 14).value));
    return parseComboTableCells(matrix);
  }

  function writeComboTable(confirmed, settingsSheet, groups, count) {
    const marker = count + 6;
    confirmed.getCell(marker, 2).value = COMBO_RESERVED_CODE;
    confirmed.getCell(marker, 3).value = "本場有設定組合優惠，折抵由聊聊腳本計算；腳本要 1.5.0 以上。請不要刪除這一列。";
    confirmed.getCell(marker, 3).alignment = { wrapText: true, vertical: "middle" };
    settingsSheet.getCell("N1").value = COMBO_TITLE;
    settingsSheet.getCell("O1").value = "改這張表會改變每位買家的折抵；改完存檔再匯入";
    COMBO_HEADERS.forEach((value, index) => { settingsSheet.getCell(2, 14 + index).value = value; });
    let row = 3;
    for (const group of groups) for (const rule of group.rules) {
      [group.groupId, group.productCodes.join("、"), COMBO_TYPES[rule.type], rule.quantity, rule.amount].forEach((value, index) => { settingsSheet.getCell(row, 14 + index).value = value; });
      settingsSheet.getCell(row, 16).dataValidation = { type: "list", allowBlank: false, formulae: ['"幾件一組共多少,幾件以上每件多少"'], showErrorMessage: true, errorTitle: "算法不正確", error: "請選擇其中一種算法。" };
      row++;
    }
    [10, 28, 24, 12, 14].forEach((width, index) => { settingsSheet.getColumn(14 + index).width = width; });
    for (let column = 14; column <= 18; column++) {
      const cell = settingsSheet.getCell(2, column);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF115E59" } };
    }
  }

  async function createReviewWorkbook(model, config = DEFAULT_CONFIG, options = {}) {
    const errors = [];
    for (const [label, rows] of [["已確認", model.confirmedRows], ["待確認", model.reviewRows]]) {
      rows.forEach((row, index) => {
        if (typeof row.account !== "string" || !validateBuyerAccount(row.account).ok) errors.push(accountProblem(`「${label}」第 ${index + 6} 列`, row.account));
      });
    }
    if (errors.length) throw buyerAccountError(errors);
    if (typeof ExcelJS === "undefined") {
      throw new Error("Excel 元件尚未載入，請重新整理頁面後再試。");
    }
    const promotionInput = options.comboPromotions;
    const promotionPreflight = promotionInput != null && (!Array.isArray(promotionInput) || promotionInput.length) ? preflightComboPromotions(model, promotionInput) : null;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Shopee 自動回覆明細";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.forceFullCalc = true;

    const confirmed = workbook.addWorksheet("已確認", {
      properties: { tabColor: { argb: "FF16A34A" } },
    });
    const review = workbook.addWorksheet("待確認", {
      properties: { tabColor: { argb: "FFF59E0B" } },
    });
    const settingsSheet = workbook.addWorksheet("設定與價格", {
      properties: { tabColor: { argb: "FF7C3AED" } },
    });
    populateDataSheet(
      confirmed,
      `已確認｜直播 Session ${model.session || "未標示"}`,
      model.confirmedRows,
      model.priceRows,
      false,
    );
    populateDataSheet(
      review,
      `待確認｜直播 Session ${model.session || "未標示"}`,
      model.reviewRows,
      model.priceRows,
      true,
    );
    addPriceAudit(settingsSheet, model.priceRows);
    addMessageSettings(
      settingsSheet,
      { ...DEFAULT_CONFIG, ...config },
      model.session,
    );
    writeBuyerRoster(settingsSheet, model);
    if (promotionPreflight) writeComboTable(confirmed, settingsSheet, promotionPreflight.comboPromotions, model.confirmedRows.length);
    return workbook.xlsx.writeBuffer();
  }

  function cellValue(cell) {
    const value = cell?.value;
    if (value == null) return "";
    if (typeof value !== "object") return value;
    if ("text" in value) return value.text;
    if ("result" in value) return value.result;
    if ("richText" in value) {
      return value.richText.map((part) => part.text).join("");
    }
    return "";
  }

  function cellText(cell) {
    return normalizeText(cellValue(cell));
  }

  function parseReviewedAmountCell(cell) {
    const raw = cell?.value;
    if (
      raw &&
      typeof raw === "object" &&
      "formula" in raw &&
      (raw.result == null || normalizeText(raw.result) === "")
    ) {
      return { state: "formula-missing", value: null };
    }
    return parseStrictPositiveInteger(cellValue(cell));
  }

  function findHeaderRow(sheet) {
    for (
      let rowNumber = 1;
      rowNumber <= Math.min(20, sheet.rowCount);
      rowNumber += 1
    ) {
      if (
        cellText(sheet.getCell(rowNumber, 1)) === "買家帳號" &&
        cellText(sheet.getCell(rowNumber, 2)) === "商品編號"
      ) {
        return rowNumber;
      }
    }
    return 0;
  }

  function readReviewedRows(sheet, markerRows = null) {
    const headerRow = findHeaderRow(sheet);
    if (!headerRow) {
      throw new Error(`${sheet.name} 找不到七欄資料表頭。`);
    }
    const rows = [];
    const errors = [];
    for (
      let rowNumber = headerRow + 1;
      rowNumber <= sheet.rowCount;
      rowNumber += 1
    ) {
      if (markerRows?.has(rowNumber)) continue;
      const accountCell = sheet.getCell(rowNumber, 1);
      const accountResult = validateBuyerAccount(accountCell.value);
      const account = accountResult.text;
      const code = cellText(sheet.getCell(rowNumber, 2)).toUpperCase();
      const productName = cellText(sheet.getCell(rowNumber, 3));
      const color = cellText(sheet.getCell(rowNumber, 4));
      const size = cellText(sheet.getCell(rowNumber, 5)).toUpperCase();
      const quantityCell = sheet.getCell(rowNumber, 6);
      const quantityResult = parseStrictPositiveInteger(
        cellValue(quantityCell),
      );
      const amountCell = sheet.getCell(rowNumber, 7);
      const amountResult = parseReviewedAmountCell(amountCell);
      const hasAnyValue = [
        account,
        code,
        productName,
        color,
        size,
        cellText(quantityCell),
        cellText(amountCell),
      ].some(Boolean) || (!accountResult.ok && accountCell.value != null);
      if (!hasAnyValue) continue;
      if (!accountResult.ok) { errors.push(accountProblem(`「${sheet.name}」第 ${rowNumber} 列`, accountCell.value)); continue; }

      // v1.1.6：商品名稱／顏色／尺寸改為選填。
      // 直播抓單常常只抓到顏色（上衣類無尺寸），甚至整個規格欄都是空的；
      // 空白代表「這個品項沒有這個規格」，不是漏填，不該擋下整批匯入。
      const missing = [];
      if (!account) missing.push("買家帳號");
      if (!code) missing.push("商品編號");
      if (quantityResult.state === "empty") missing.push("數量");
      if (missing.length) {
        errors.push(
          `「${sheet.name}」第 ${rowNumber} 列缺少：${missing.join("、")}`,
        );
      }
      if (quantityResult.state === "invalid") {
        errors.push(
          `「${sheet.name}」第 ${rowNumber} 列的數量必須是大於 0 的整數`,
        );
      }
      if (amountResult.state === "invalid") {
        errors.push(
          `「${sheet.name}」第 ${rowNumber} 列的金額必須是大於 0 的整數`,
        );
      }
      if (
        missing.length ||
        quantityResult.state === "invalid" ||
        amountResult.state === "invalid"
      ) {
        continue;
      }
      rows.push({
        account,
        code,
        productName,
        color,
        size,
        quantity: quantityResult.value,
        directAmount: amountResult.value,
        amountState: amountResult.state,
        sourceRow: rowNumber,
      });
    }
    if (errors.length) {
      throw new Error(errors.join("；"));
    }
    return rows;
  }

  function readReviewedPrices(settingsSheet) {
    let location = null;
    for (
      let rowNumber = 1;
      rowNumber <= Math.min(20, settingsSheet.rowCount);
      rowNumber += 1
    ) {
      for (let column = 1; column <= 20; column += 1) {
        if (column >= 10 && column <= 12 && hasRosterArea(settingsSheet)) continue;
        if (
          cellText(settingsSheet.getCell(rowNumber, column)) === "商品編號" &&
          cellText(settingsSheet.getCell(rowNumber, column + 3)) === "審核單價"
        ) {
          location = { rowNumber, codeColumn: column, priceColumn: column + 3 };
          break;
        }
      }
      if (location) break;
    }
    if (!location) {
      return new Map();
    }
    const prices = new Map();
    for (
      let rowNumber = location.rowNumber + 1;
      rowNumber <= settingsSheet.rowCount;
      rowNumber += 1
    ) {
      const code = cellText(
        settingsSheet.getCell(rowNumber, location.codeColumn),
      ).toUpperCase();
      if (!code) continue;
      prices.set(
        code,
        parseNumber(
          cellValue(settingsSheet.getCell(rowNumber, location.priceColumn)),
        ),
      );
    }
    return prices;
  }

  function readMultiPriceCodes(settingsSheet) {
    let location = null;
    for (
      let rowNumber = 1;
      rowNumber <= Math.min(20, settingsSheet.rowCount);
      rowNumber += 1
    ) {
      for (let column = 1; column <= 20; column += 1) {
        if (column >= 10 && column <= 12 && hasRosterArea(settingsSheet)) continue;
        if (
          cellText(settingsSheet.getCell(rowNumber, column)) === "商品編號" &&
          cellText(settingsSheet.getCell(rowNumber, column + 2)) ===
            "來源價格"
        ) {
          location = {
            rowNumber,
            codeColumn: column,
            sourcePriceColumn: column + 2,
          };
          break;
        }
      }
      if (location) break;
    }
    if (!location) return new Set();
    const codes = new Set();
    for (
      let rowNumber = location.rowNumber + 1;
      rowNumber <= settingsSheet.rowCount;
      rowNumber += 1
    ) {
      const code = cellText(
        settingsSheet.getCell(rowNumber, location.codeColumn),
      ).toUpperCase();
      if (!code) continue;
      const sourcePrices = cellText(
        settingsSheet.getCell(rowNumber, location.sourcePriceColumn),
      )
        .split(/\s*\/\s*/u)
        .map(parseNumber)
        .filter((price) => Number.isFinite(price) && price > 0);
      if (new Set(sourcePrices).size > 1) codes.add(code);
    }
    return codes;
  }

  function readMessageSettings(settingsSheet, fallback = DEFAULT_CONFIG, ignoreComboArea = false) {
    const values = {};
    const labels = new Set([
      "開頭範本",
      "結尾範本",
      "場次日期",
      "結單日",
      "直播Session",
      "場次日期來源",
      "結單日來源",
    ]);
    for (
      let rowNumber = 1;
      rowNumber <= settingsSheet.rowCount;
      rowNumber += 1
    ) {
      for (let column = 1; column <= 20; column += 1) {
        if (ignoreComboArea && column >= 14 && column <= 18) continue;
        if (column >= 10 && column <= 12 && hasRosterArea(settingsSheet)) continue;
        const label = cellText(settingsSheet.getCell(rowNumber, column));
        if (!labels.has(label)) continue;
        const settingCell = settingsSheet.getCell(rowNumber, column + 1);
        const rawValue = settingCell.value;
        const isDateSetting = label === "場次日期" || label === "結單日";
        const value = isDateSetting && rawValue instanceof Date &&
          Number.isFinite(rawValue.getTime())
          ? `${rawValue.getUTCMonth() + 1}/${rawValue.getUTCDate()}`
          : cellValue(settingCell);
        values[label] =
          label === "開頭範本" || label === "結尾範本"
            ? normalizeMultilineText(value)
            : normalizeText(value);
      }
    }
    return {
      chargeShopeeFee: fallback.chargeShopeeFee === true,
      openingTemplate:
        Object.hasOwn(values, "開頭範本") ? values["開頭範本"] : fallback.openingTemplate,
      closingTemplate:
        Object.hasOwn(values, "結尾範本") ? values["結尾範本"] : fallback.closingTemplate,
      eventDate: values["場次日期"] || fallback.eventDate,
      closingDate: values["結單日"] || "",
      session: values["直播Session"] || "",
      eventDateSource:
        values["場次日期來源"] ||
        fallback.eventDateSource ||
        "來源不明",
      closingDateSource:
        values["結單日"]
          ? values["結單日來源"] || fallback.closingDateSource || "來源不明"
          : "未設定",
    };
  }

  function mergeReviewedRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
      const key = [
        row.account,
        row.code,
        row.productName,
        row.color,
        row.size,
      ].join("\u001F");
      if (!grouped.has(key)) {
        grouped.set(key, {
          ...row,
          quantity: 0,
          directAmount: 0,
          sourceRows: [],
        });
      }
      const target = grouped.get(key);
      target.quantity += row.quantity;
      target.directAmount += row.directAmount;
      const sourceRows = Array.isArray(row.sourceRows)
        ? row.sourceRows
        : Number.isInteger(row.sourceRow)
          ? [row.sourceRow]
          : [];
      target.sourceRows.push(...sourceRows);
    }
    return [...grouped.values()]
      .map((row) => ({
        ...row,
        sourceRows: [...new Set(row.sourceRows)].sort(
          (left, right) => left - right,
        ),
      }))
      .sort(
        (left, right) =>
          naturalCompare(left.account, right.account) ||
          naturalCompare(left.code, right.code) ||
          naturalCompare(left.color, right.color) ||
          naturalCompare(left.size, right.size),
      );
  }

  function sourceRowsOf(row) {
    if (Array.isArray(row.sourceRows)) {
      return [...new Set(row.sourceRows.filter(Number.isInteger))].sort(
        (left, right) => left - right,
      );
    }
    return Number.isInteger(row.sourceRow) ? [row.sourceRow] : [];
  }

  function formatSourceRows(row) {
    const rows = sourceRowsOf(row);
    return rows.length ? `第 ${rows.join("、")} 列` : "列號不明";
  }

  function applyTemplate(template, values) {
    return String(template ?? "")
      .replace(/\{買家\}/gu, values.account)
      .replace(/\{日期\}/gu, values.eventDate)
      .replace(/\{結單日\}/gu, values.closingDate);
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function makeSentKey(session, account) {
    return `${normalizeText(session)}\u001F${normalizeText(account)}`;
  }

  function createSentRecord(
    item,
    session,
    status,
    sentAt = new Date().toISOString(),
  ) {
    return {
      account: item.account,
      session: normalizeText(session),
      status,
      sentAt,
      messageHash: item.messageHash,
    };
  }

  function updateSentRecord(
    sent,
    item,
    session,
    status,
    sentAt = new Date().toISOString(),
  ) {
    return {
      ...(sent || {}),
      [item.id]: createSentRecord(item, session, status, sentAt),
    };
  }

  function legacySentEntry(record) {
    return {
      id: `${record.account}:${record.messageHash}`,
      record: {
        account: record.account,
        sentAt: record.sentAt,
        session: record.session,
        messageHash: record.messageHash,
      },
    };
  }

  function migrateSentV2ToV3(sentV2 = {}, sentV3 = {}) {
    const next = Object.fromEntries(
      Object.entries(sentV3 || {}).map(([key, record]) => [
        key,
        {
          ...record,
          legacyIds: Array.isArray(record?.legacyIds)
            ? [...new Set(record.legacyIds)].sort()
            : [],
        },
      ]),
    );
    const grouped = new Map();
    for (const [legacyId, legacyRecord] of Object.entries(sentV2 || {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const account = normalizeText(legacyRecord?.account);
      if (!account) continue;
      const session = normalizeText(legacyRecord?.session);
      const separator = legacyId.lastIndexOf(":");
      const messageHash =
        normalizeText(legacyRecord?.messageHash) ||
        (separator >= 0 ? legacyId.slice(separator + 1) : "");
      const key = makeSentKey(session, account);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({
        legacyId,
        account,
        session,
        sentAt: normalizeText(legacyRecord?.sentAt),
        messageHash,
      });
    }

    for (const [key, records] of grouped.entries()) {
      const legacyIds = records.map((record) => record.legacyId).sort();
      if (next[key]) {
        next[key] = {
          ...next[key],
          status: next[key].status || "sent",
          legacyIds: [
            ...new Set([...(next[key].legacyIds || []), ...legacyIds]),
          ].sort(),
        };
        continue;
      }
      const latest = [...records].sort((left, right) => {
        const leftTime = Date.parse(left.sentAt);
        const rightTime = Date.parse(right.sentAt);
        const timeDifference =
          (Number.isFinite(rightTime) ? rightTime : 0) -
          (Number.isFinite(leftTime) ? leftTime : 0);
        return timeDifference || left.legacyId.localeCompare(right.legacyId);
      })[0];
      next[key] = {
        account: latest.account,
        session: latest.session,
        status: latest.session ? "sent" : "uncertain",
        sentAt: latest.sentAt,
        messageHash: latest.messageHash,
        migratedFrom: "v2",
        legacyIds,
      };
    }

    return {
      sent: next,
      changed: JSON.stringify(next) !== JSON.stringify(sentV3 || {}),
    };
  }

  function resolveQueueItemState(item, sent, blacklist = []) {
    const record = sent?.[item.id] || null;
    if (blacklist.includes(item.account)) return { deliveryStatus: "excluded", contentChanged: false, sendByDefault: false, record };
    if (!record) {
      return {
        deliveryStatus: "none",
        contentChanged: false,
        sendByDefault: true,
        record: null,
      };
    }
    const deliveryStatus =
      record.status === "uncertain" ? "uncertain" : "sent";
    return {
      deliveryStatus,
      contentChanged:
        Boolean(record.messageHash) &&
        record.messageHash !== item.messageHash,
      sendByDefault: deliveryStatus !== "sent",
      record,
    };
  }

  function queueItemStatusLabel(item, sent, blacklist = []) {
    const itemState = resolveQueueItemState(item, sent, blacklist);
    if (itemState.deliveryStatus === "excluded") return "（黑名單排除）";
    if (itemState.deliveryStatus === "uncertain") {
      return itemState.contentChanged
        ? "（可能已發送，且內容已變動）"
        : "（可能已發送，請先看一下聊聊）";
    }
    if (itemState.deliveryStatus === "sent") {
      if (itemState.record?.source === "manual") return itemState.contentChanged ? "（已人工補送，內容已變動）" : "（已人工補送）";
      return itemState.contentChanged
        ? "（內容已變動，建議重發）"
        : "（已發送）";
    }
    return "";
  }

  function summarizeQueueStates(items, sent, blacklist = []) {
    const states = items.map((item) => resolveQueueItemState(item, sent, blacklist));
    return {
      total: items.length,
      manualSent: states.filter(state => state.deliveryStatus === "sent" && state.record?.source === "manual").length,
      excluded: states.filter(state => state.deliveryStatus === "excluded").length,
      sent: states.filter(
        (itemState) => itemState.deliveryStatus === "sent",
      ).length,
      uncertain: states.filter(
        (itemState) => itemState.deliveryStatus === "uncertain",
      ).length,
      changed: states.filter((itemState) => itemState.contentChanged).length,
      sendByDefault: states.filter((itemState) => itemState.sendByDefault)
        .length,
    };
  }

  function createAutomationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function requireExactSearchResult(result) {
    if (result) return result;
    throw createAutomationError(
      "SEARCH_UNCONFIRMED",
      "20 秒內未辨識到完全相同的搜尋結果，搜尋未確認，未送出；請人工核對，不能據此認定帳號不存在。",
    );
  }

  function failureCategory(code) {
    return ["BUYER_NOT_FOUND", "SEARCH_UNCONFIRMED"].includes(code)
      ? "search_unconfirmed"
      : "process_failed";
  }

  function createFailedRecord(
    item,
    session,
    error,
    stage,
    at = new Date().toISOString(),
  ) {
    return {
      account: item.account,
      session: normalizeText(session),
      code: normalizeText(error?.code) || "PROCESS_FAILED",
      reason: String(error?.message || error || "未知錯誤").trim(),
      stage: normalizeText(stage),
      at,
      messageHash: item.messageHash,
    };
  }

  function pruneFailedRecords(failed, limit = FAILED_RECORD_LIMIT) {
    const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
    return Object.fromEntries(
      Object.entries(failed || {})
        .filter(
          ([key, record]) =>
            normalizeText(key) &&
            record &&
            typeof record === "object" &&
            normalizeText(record.account),
        )
        .sort(([leftKey, left], [rightKey, right]) => {
          const leftTime = Date.parse(left.at);
          const rightTime = Date.parse(right.at);
          return (
            (Number.isFinite(rightTime) ? rightTime : 0) -
              (Number.isFinite(leftTime) ? leftTime : 0) ||
            naturalCompare(leftKey, rightKey)
          );
        })
        .slice(0, normalizedLimit),
    );
  }

  function updateFailedRecord(
    failed,
    item,
    session,
    error,
    stage,
    at = new Date().toISOString(),
  ) {
    return pruneFailedRecords({
      ...(failed || {}),
      [item.id]: createFailedRecord(item, session, error, stage, at),
    });
  }

  function removeFailedRecord(failed, itemOrKey) {
    const key =
      typeof itemOrKey === "string" ? itemOrKey : normalizeText(itemOrKey?.id);
    const next = { ...(failed || {}) };
    if (key) delete next[key];
    return next;
  }

  function buildUnsentViewModel(items, sent, failed, blacklist = []) {
    const view = {
      totalExcel: (items || []).length,
      totalUnsent: 0,
      uncertain: [],
      buyerNotFound: [],
      searchUnconfirmed: [],
      excluded: [],
      processFailed: [],
      unattempted: [],
    };
    for (const item of items || []) {
      const itemState = resolveQueueItemState(item, sent, blacklist);
      if (itemState.deliveryStatus === "sent") continue;
      const failedRecord = failed?.[item.id] || null;
      const row = {
        account: item.account,
        total: item.total,
        message: item.message,
        code: normalizeText(failedRecord?.code),
        reason: String(failedRecord?.reason || ""),
        stage: normalizeText(failedRecord?.stage),
        at: normalizeText(failedRecord?.at),
        messageHash: item.messageHash,
      };
      if (itemState.deliveryStatus === "excluded") {
        view.excluded.push({ ...row, code: "BLACKLISTED", reason: "使用者明確列入黑名單，不發送", stage: "EXCLUDED" });
      } else if (itemState.deliveryStatus === "uncertain") {
        view.uncertain.push(row);
      } else if (!failedRecord) {
        view.unattempted.push(row);
      } else if (failureCategory(failedRecord.code) === "search_unconfirmed") {
        view.searchUnconfirmed.push(row);
      } else {
        view.processFailed.push(row);
      }
    }
    for (const rows of [
      view.uncertain,
      view.buyerNotFound,
      view.searchUnconfirmed,
      view.processFailed,
      view.unattempted,
    ]) {
      rows.sort((left, right) => naturalCompare(left.account, right.account));
      view.totalUnsent += rows.length;
    }
    view.excluded.sort((left, right) => naturalCompare(left.account, right.account));
    return view;
  }

  function orderedUnsentRows(view) {
    const withLabel = (rows, categoryLabel) =>
      [...rows]
        .sort((left, right) => naturalCompare(left.account, right.account))
        .map((row) => ({ ...row, categoryLabel }));
    return [
      ...withLabel(view.excluded || [], "黑名單排除"),
      ...withLabel(view.searchUnconfirmed || [], "搜尋未確認"),
      ...withLabel(view.buyerNotFound || [], "搜尋未確認（舊紀錄）"),
      ...withLabel(view.uncertain, "可能已發送"),
      ...withLabel(view.processFailed, "中途失敗"),
      ...withLabel(view.unattempted, "尚未嘗試"),
    ];
  }

  function protectCsvFormula(value) {
    const text = String(value ?? "");
    const probe = text.replace(/^[ \u00A0]*/u, "");
    return /^[=+\-@\t\r]/u.test(probe) ? `'${text}` : text;
  }

  function quoteCsvCell(value) {
    return `"${protectCsvFormula(value).replace(/"/gu, '""')}"`;
  }

  function quoteBuyerAccountCsv(value) {
    const guarded = protectCsvFormula(value);
    const literal = guarded ? `="${guarded.replace(/"/gu, '""')}"` : "";
    return `"${literal.replace(/"/gu, '""')}"`;
  }

  function buildUnsentCsv(view) {
    const headers = [
      "買家帳號",
      "分類",
      "原因",
      "停在階段",
      "總金額",
      "訊息全文",
    ];
    const rows = orderedUnsentRows(view).map((row) => [
      row.account,
      row.categoryLabel,
      row.reason,
      row.stage,
      row.total,
      row.message,
    ]);
    return `\uFEFF${[headers, ...rows]
      .map((row, index) => row.map((value, column) => index > 0 && column === 0
        ? quoteBuyerAccountCsv(value)
        : quoteCsvCell(value)).join(","))
      .join("\r\n")}`;
  }

  function buildUnsentCopyText(view) {
    const lines = [];
    const append = (title, rows) => {
      if (!rows.length) return;
      lines.push(title);
      for (const row of rows) {
        const details = [
          `${row.account}　$${formatMoney(row.total)}`,
          row.reason,
          row.stage ? `停在 ${row.stage}` : "",
          row.message,
        ].filter(Boolean);
        lines.push(details.join("\n"));
      }
    };
    append("黑名單排除", view.excluded || []);
    append("搜尋未確認", view.searchUnconfirmed || []);
    append("搜尋未確認（舊紀錄）", view.buyerNotFound || []);
    append("❓ 可能已發送", view.uncertain);
    append("⚠️ 中途失敗", view.processFailed);
    if (view.unattempted.length) {
      lines.push(`ℹ️ 尚未嘗試：${view.unattempted.length} 位`);
    }
    return lines.join("\n\n");
  }

  function buildRunSummary(counts) {
    const sent = Math.max(0, Number(counts?.sent) || 0);
    const uncertain = Math.max(0, Number(counts?.uncertain) || 0);
    const buyerNotFound = Math.max(
      0,
      Number(counts?.buyerNotFound) || 0,
    );
    const processFailed = Math.max(0, Number(counts?.processFailed) || 0);
    const unsent = buyerNotFound + processFailed;
    return {
      sent,
      uncertain,
      buyerNotFound,
      processFailed,
      unsent,
      kind: uncertain || unsent ? "warn" : "success",
      message:
        `本輪完成：確定送出 ${sent} 位、可能已發送 ${uncertain} 位、` +
        `未送出 ${unsent} 位（搜尋未確認 ${buyerNotFound}、中途失敗 ${processFailed}）。`,
    };
  }

  function localDateFileLabel(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function safeFilenamePart(value, fallback = "未標示") {
    return (
      normalizeText(value).replace(/[\\/:*?"<>|\u0000-\u001F]/gu, "_") ||
      fallback
    );
  }

  function buildUnsentCsvFilename(session, date = new Date()) {
    return `未送出清單_${safeFilenamePart(session)}_${localDateFileLabel(date)}.csv`;
  }

  function normalizeProductCode(value) {
    return normalizeText(value).replace(/\s+/gu, "").toUpperCase();
  }

  function parseProductCodes(value) {
    return [
      ...new Set(
        String(value ?? "")
          .split(/[,，]/u)
          .map(normalizeProductCode)
          .filter(Boolean),
      ),
    ];
  }

  function filterQueueItemsByProductCodes(items, value) {
    const codes = parseProductCodes(value);
    const matchedCodes = new Set();
    const matchedItems = (items || [])
      .filter((item) => {
        const itemCodes = new Set(
          (item.rows || []).map((row) => normalizeProductCode(row.code)),
        );
        let matched = false;
        for (const code of codes) {
          if (!itemCodes.has(code)) continue;
          matchedCodes.add(code);
          matched = true;
        }
        return matched;
      })
      .sort((left, right) => naturalCompare(left.account, right.account));
    return {
      codes,
      items: matchedItems,
      missingCodes: codes.filter((code) => !matchedCodes.has(code)),
    };
  }

  function buildResendViewModel(
    items,
    sent,
    codeInput,
    authorized = false,
    expanded = false,
  ) {
    const result = filterQueueItemsByProductCodes(items, codeInput);
    const sentCount = result.items.filter(
      (item) =>
        resolveQueueItemState(item, sent).deliveryStatus === "sent",
    ).length;
    let statusMessage = "";
    if (!result.codes.length) {
      statusMessage = "請先輸入商品編號";
    } else if (!result.items.length) {
      statusMessage = `這場沒有人買 ${result.codes.join("、")}。請確認編號是不是打錯了。`;
    } else if (result.missingCodes.length) {
      statusMessage = `其中 ${result.missingCodes.join("、")} 這場沒有人買。`;
    }
    return {
      ...result,
      sentCount,
      visibleAccounts: (expanded
        ? result.items
        : result.items.slice(0, 5)
      ).map((item) => item.account),
      hasMore: result.items.length > 5,
      expanded,
      statusMessage,
      buttonText: `重發給這 ${result.items.length} 位`,
      disabled: !authorized || !result.items.length,
    };
  }

  function isDeleteConfirmation(value) {
    return String(value ?? "").trim() === "刪除";
  }

  function sessionRecordCount(sent, session) {
    const normalizedSession = normalizeText(session);
    return Object.values(sent || {}).filter(
      (record) => normalizeText(record?.session) === normalizedSession,
    ).length;
  }

  function clearSessionSentRecords(sentV3, sentV2, session) {
    const normalizedSession = normalizeText(session);
    const nextV3 = {};
    const nextV2 = {};
    let removedV3 = 0;
    let removedV2 = 0;
    for (const [key, record] of Object.entries(sentV3 || {})) {
      if (normalizeText(record?.session) === normalizedSession) {
        removedV3 += 1;
      } else {
        nextV3[key] = record;
      }
    }
    for (const [key, record] of Object.entries(sentV2 || {})) {
      if (normalizeText(record?.session) === normalizedSession) {
        removedV2 += 1;
      } else {
        nextV2[key] = record;
      }
    }
    return {
      sentV3: nextV3,
      sentV2: nextV2,
      removedV3,
      removedV2,
    };
  }

  function formatQueueTime(createdAt) {
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime())) return "時間不明";
    return date.toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function loadSentHistory() {
    const sentV2 = GM_getValue(STORE.sentLegacy, {});
    const sentV3 = GM_getValue(STORE.sent, {});
    const migrated = migrateSentV2ToV3(sentV2, sentV3);
    if (migrated.changed) GM_setValue(STORE.sent, migrated.sent);
    return migrated.sent;
  }

  function loadFailedHistory() {
    const stored = GM_getValue(STORE.failed, {});
    const pruned = pruneFailedRecords(stored);
    if (JSON.stringify(pruned) !== JSON.stringify(stored)) {
      GM_setValue(STORE.failed, pruned);
    }
    return pruned;
  }

  function buildQueue(
    rows,
    prices,
    config,
    session = "",
    multiPriceCodes = new Set(),
    comboOptions = null,
  ) {
    if (!normalizeText(config.closingDate) && String(config.closingTemplate ?? "").includes("{結單日}")) {
      throw new Error("結單日已留空，但結尾範本仍含 {結單日}；請刪除結尾的日期句，或填入結單日。");
    }
    const errors = [];
    const warnings = [];
    const finalizedRows = [];

    for (const row of rows) {
      if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
        errors.push(
          `「已確認」${formatSourceRows(row)}的數量必須是大於 0 的整數`,
        );
        continue;
      }
      const reviewedPrice = prices.get(row.code);
      const hasReviewedPrice =
        Number.isFinite(reviewedPrice) && reviewedPrice > 0;
      const amountResult = row.amountState
        ? { state: row.amountState, value: row.directAmount }
        : parseStrictPositiveInteger(row.directAmount);
      let finalAmount = null;

      if (amountResult.state === "ok") {
        finalAmount = amountResult.value;
      } else if (
        amountResult.state === "empty" ||
        amountResult.state === "formula-missing"
      ) {
        if (hasReviewedPrice) {
          finalAmount = Math.round(row.quantity * reviewedPrice);
          warnings.push(
            `「已確認」${formatSourceRows(row)}金額欄無有效數值，已改用審核單價回推（${formatMoney(finalAmount)}）`,
          );
        } else {
          errors.push(
            `「已確認」${formatSourceRows(row)}沒有有效金額；請用 Excel 開啟並存檔一次讓公式重算，或直接把 G 欄改成純數字`,
          );
          continue;
        }
      } else {
        errors.push(
          `「已確認」${formatSourceRows(row)}的金額必須是大於 0 的整數`,
        );
        continue;
      }

      finalAmount = Math.round(finalAmount);
      if (
        amountResult.state === "ok" &&
        hasReviewedPrice &&
        finalAmount !== Math.round(row.quantity * reviewedPrice)
      ) {
        warnings.push(
          `「已確認」${formatSourceRows(row)} ${row.code} 的小計 ${formatMoney(finalAmount)} 與數量 ${row.quantity} × 審核單價 ${formatMoney(reviewedPrice)} 不符；已採用 G 欄小計，請確認金額`,
        );
      }
      finalizedRows.push({
        ...row,
        directAmount: finalAmount,
      });
    }

    if (errors.length) {
      throw new Error([...new Set(errors)].join("；"));
    }

    const inconsistentRows = new Set();
    const rowsByCode = new Map();
    for (const row of finalizedRows) {
      if (!rowsByCode.has(row.code)) rowsByCode.set(row.code, []);
      rowsByCode.get(row.code).push(row);
    }
    for (const [code, codeRows] of rowsByCode.entries()) {
      if (multiPriceCodes.has(code)) continue;
      if (codeRows.length < 2) continue;
      const units = codeRows.map((row) =>
        Math.round(row.directAmount / row.quantity),
      );
      if (new Set(units).size < 2) continue;
      codeRows.forEach((row) => inconsistentRows.add(row));
      const detail = codeRows
        .map(
          (row, index) =>
            `${formatSourceRows(row)} ${formatMoney(units[index])}`,
        )
        .join("、");
      warnings.push(
        `「已確認」${code} 各列換算單價不一致（${detail}），請確認金額欄填的是小計`,
      );
    }

    const manualRiskRows = finalizedRows.filter((row) => {
      const reviewedPrice = prices.get(row.code);
      return (
        row.quantity >= 2 &&
        (!Number.isFinite(reviewedPrice) || reviewedPrice <= 0) &&
        !multiPriceCodes.has(row.code) &&
        !inconsistentRows.has(row)
      );
    });
    if (manualRiskRows.length) {
      warnings.push(
        [
          "請確認以下人工列的金額為小計而非單價：",
          ...manualRiskRows.map(
            (row) =>
              `「已確認」${formatSourceRows(row)} ${row.code} 數量 ${row.quantity} 金額 ${formatMoney(row.directAmount)}（換算單價 ${formatMoney(row.directAmount / row.quantity)}）`,
          ),
        ].join("\n"),
      );
    }

    const comboGroups = comboOptions ? validateComboPromotions(comboOptions.comboPromotions, prices, multiPriceCodes, finalizedRows) : null;
    const comboResult = comboGroups ? calculateComboPromotions(finalizedRows, comboGroups, prices, comboOptions.amountSources) : null;
    if (comboResult) warnings.push(...comboResult.warnings);
    const mergedRows = mergeReviewedRows(finalizedRows);
    const byAccount = new Map();
    for (const row of mergedRows) {
      if (!byAccount.has(row.account)) byAccount.set(row.account, []);
      byAccount.get(row.account).push({
        ...row,
        amount: row.directAmount,
      });
    }

    const items = [...byAccount.entries()]
      .sort(([left], [right]) => naturalCompare(left, right))
      .map(([account, accountRows]) => {
        const originalGoodsTotal = accountRows.reduce((sum, row) => sum + row.amount, 0);
        const promotion = comboResult?.byAccount.get(account);
        const goodsTotal = promotion ? originalGoodsTotal - promotion.discountTotal : originalGoodsTotal;
        const chargeShopeeFee = config.chargeShopeeFee === true;
        const total = chargeShopeeFee ? totalWithShopeeFee(goodsTotal) : goodsTotal;
        const opening = applyTemplate(config.openingTemplate, {
          account,
          eventDate: config.eventDate,
          closingDate: config.closingDate,
        });
        const closing = applyTemplate(config.closingTemplate, {
          account,
          eventDate: config.eventDate,
          closingDate: config.closingDate,
        });
        const lines = accountRows.map((row) => {
          // 選填欄位可能全空：收集有值的片段再 join，避免留下多餘空格。
          const spec = `${row.color || ""}${row.size || ""}`;
          const parts = [
            row.code,
            stripCodePrefix(row.code, row.productName),
            spec,
          ].filter(Boolean);
          return `${parts.join(" ")} +${row.quantity} $${formatMoney(row.amount)}`;
        });
        const message = [
          opening,
          `${account}：`,
          ...lines,
          ...(promotion ? promotion.discounts.map((discount) => `組合優惠（${discount.description}）-$${formatMoney(discount.discountAmount)}`) : []),
          chargeShopeeFee
            ? `總金額為：$${formatMoney(goodsTotal)} + 10%手續費 = ${total}`
            : `總金額為：$${formatMoney(total)}`,
          closing,
          chargeShopeeFee && !closing.includes(SHIPPING_NOTICE) ? SHIPPING_NOTICE : "",
        ]
          .filter(Boolean)
          .join("\n");
        const messageHash = hashString(message);
        return {
          id: makeSentKey(session, account),
          messageHash,
          account,
          rows: accountRows,
          goodsTotal,
          feeAmount: total - goodsTotal,
          total,
          message,
          ...(promotion ? { originalGoodsTotal, discountTotal: promotion.discountTotal, discounts: promotion.discounts, promotionSkips: promotion.promotionSkips } : {}),
        };
      });
    return {
      version: 4,
      createdAt: new Date().toISOString(),
      session,
      chargeShopeeFee: config.chargeShopeeFee === true,
      eventDate: config.eventDate,
      closingDate: config.closingDate,
      eventDateSource: config.eventDateSource || "來源不明",
      closingDateSource: config.closingDateSource || "來源不明",
      items,
      warnings: [...new Set(warnings)],
      ...(comboResult ? { promotionSchemaVersion: COMBO_PROMOTION_SCHEMA_VERSION, comboPromotions: comboGroups, promotionSummary: comboResult.summary } : {}),
    };
  }

  function panelDateSourceLabel(source) {
    if (source === "程式預填") return "程式預填，請確認";
    if (source === "命令列指定") return "已指定";
    return "來源不明，請確認";
  }

  function formatQueueDateSummary(queue) {
    if (!queue) return "";
    return (
      `本次訊息日期：場次 ${queue.eventDate || "未填"}（${panelDateSourceLabel(queue.eventDateSource)}）` +
      (queue.closingDate
        ? `・結單 ${queue.closingDate}（${panelDateSourceLabel(queue.closingDateSource)}）`
        : "・結單日未設定")
    );
  }

  async function readReviewedWorkbook(arrayBuffer, fallbackConfig = DEFAULT_CONFIG, options = {}) {
    if (typeof ExcelJS === "undefined") {
      throw new Error("Excel 元件尚未載入，請重新整理頁面後再試。");
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const confirmed = workbook.worksheets[0];
    const pending = workbook.worksheets[1];
    if (!confirmed || confirmed.name !== "已確認") {
      throw new Error("Excel 工作表1必須是「已確認」。");
    }
    if (!pending || pending.name !== "待確認") {
      throw new Error("Excel 工作表2必須是「待確認」。");
    }
    const settingsSheet = workbook.worksheets[2];
    if (!settingsSheet || settingsSheet.name !== "設定與價格") {
      throw new Error(
        "這個 Excel 的第 3 張工作表必須是「設定與價格」，目前找不到正確工作表，無法讀取單價與訊息範本。\n" +
          "請重新用程式產生一份 Excel，再重新匯入。",
      );
    }
    const comboPromotions = comboTableFromSheet(settingsSheet);
    const markerRows = new Set(), amountSources = new Map();
    if (comboPromotions !== null) {
      for (let row = findHeaderRow(confirmed) + 1; row <= confirmed.rowCount; row++) {
        const blank = (value) => value == null || value === "";
        if (confirmed.getCell(row, 2).value === COMBO_RESERVED_CODE && [1, 6, 7].every((column) => blank(confirmed.getCell(row, column).value))) markerRows.add(row);
        const amount = confirmed.getCell(row, 7).value;
        amountSources.set(row, amount && typeof amount === "object" && ("formula" in amount || "sharedFormula" in amount) ? amount.result == null || amount.result === "" ? "fallback" : "formula-result" : amount == null || amount === "" ? "fallback" : "number");
      }
    }
    const settings = readMessageSettings(settingsSheet, {
      ...DEFAULT_CONFIG,
      ...fallbackConfig,
    }, comboPromotions !== null);
    const rows = readReviewedRows(confirmed, comboPromotions !== null ? markerRows : null);
    if (comboPromotions !== null) validateComboPromotions(comboPromotions, readReviewedPrices(settingsSheet), readMultiPriceCodes(settingsSheet), rows);
    const roster = readBuyerRoster(settingsSheet, settings.session);
    const identityWarnings = roster.warning ? [roster.warning] : [];
    const outside = [];
    for (const row of rows) {
      row.buyerUid = roster.accounts?.get(row.account) || "";
      if (roster.accounts && !roster.accounts.has(row.account)) outside.push(row.account);
    }
    if (outside.length) identityWarnings.push(`名冊外帳號：${[...new Set(outside)].join("、")}；請核對原始資料與發送預覽。`);
    if (!rows.length && !(options.allowEmptyCombo === true && comboPromotions !== null && markerRows.size > 0)) {
      throw new Error(
        "「已確認」工作表沒有可發送的資料列；待確認資料不會自動併入。",
      );
    }
    const queue = buildQueue(
      rows,
      readReviewedPrices(settingsSheet),
      settings,
      settings.session,
      readMultiPriceCodes(settingsSheet),
      comboPromotions !== null ? { comboPromotions, amountSources } : null,
    );
    if (comboPromotions !== null && !markerRows.size) queue.warnings.push("這份發送表的優惠標記列被刪除了；請確認每個人的聊聊腳本都是 1.5.0 以上，舊版會照原價發");
    queue.reviewWarnings = [...queue.warnings];
    queue.identityWarnings = identityWarnings;
    queue.warnings.push(...identityWarnings);
    queue.buyerRoster = roster.meta || null;
    return queue;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("瀏覽器拒絕複製，請改用匯出 CSV。");
  }

  function loadConfig() {
    return {
      ...DEFAULT_CONFIG,
      ...(typeof GM_getValue === "function"
        ? GM_getValue(STORE.config, {})
        : {}),
    };
  }

  function saveConfig(config) {
    GM_setValue(STORE.config, config);
  }

  const PANEL_STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wl-panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: min(430px, calc(100vw - 32px)); min-width:320px;
      max-width:min(50vw, calc(100vw - 32px)); min-height:200px;
      max-height:calc(100vh - 32px); resize:both;
      overflow: auto; color: #202124; background: #fff; border: 1px solid #dfe3e8;
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.24);
      font: 13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    .wl-panel.wl-collapsed { min-height:0; resize:none; }
    .wl-panel.wl-collapsed .wl-body { display: none; }
    .wl-head {
      display:flex; align-items:center; gap:8px; padding:10px 12px;
      color:#fff; background:#ee4d2d; cursor:move; user-select:none;
      touch-action:none;
    }
    .wl-head strong { flex:1; }
    .wl-head button { color:#fff; background:rgba(255,255,255,.2); cursor:pointer; }
    .wl-body { padding:12px; }
    .wl-section { margin-bottom:10px; padding:10px; border:1px solid #e0e3e7; border-radius:9px; }
    .wl-section h3 { margin:0 0 8px; font-size:14px; }
    .wl-field { display:block; margin-top:7px; }
    .wl-field > span { display:block; margin-bottom:3px; color:#5f6368; font-size:12px; }
    .wl-field input, .wl-field textarea, .wl-field select {
      width:100%; padding:7px; border:1px solid #c7cdd3; border-radius:7px; font:inherit;
    }
    .wl-field textarea { min-height:60px; resize:vertical; }
    .wl-actions { display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; }
    .wl-btn { border:0; border-radius:7px; padding:7px 10px; cursor:pointer; font:inherit; font-weight:700; background:#eef1f4; }
    .wl-btn:disabled { cursor:not-allowed; opacity:.5; }
    .wl-btn-primary { color:#fff; background:#ee4d2d; }
    .wl-btn-danger { color:#fff; background:#b91c1c; }
    .wl-status { margin-top:8px; padding:8px; border-radius:7px; white-space:pre-wrap; background:#f1f3f4; }
    .wl-error { color:#8a1c13; background:#ffe5e0; }
    .wl-warn { color:#6b4600; background:#fff1c7; }
    .wl-success { color:#137333; background:#e6f4ea; }
    .wl-preview { max-height:32vh; overflow:auto; margin-top:7px; padding:8px; border:1px solid #e5e7ea; border-radius:7px; white-space:pre-wrap; }
    .wl-check { display:flex; gap:7px; align-items:flex-start; margin-top:8px; }
    .wl-check input[type="checkbox"] { margin-top:3px; }
    .wl-mini { margin:6px 0 0; color:#5f6368; font-size:11px; }
    .wl-log { max-height:24vh; overflow:auto; margin-top:8px; padding:7px; color:#374151; background:#f8fafc; white-space:pre-wrap; font:11px/1.4 ui-monospace,monospace; }
    .wl-resend-list { max-height:20vh; overflow:auto; margin-top:8px; padding:8px; border:1px solid #e5e7ea; border-radius:7px; background:#f8fafc; }
    .wl-resend-list p { margin:0 0 6px; }
    .wl-unsent-block { margin-top:8px; padding:8px; border-radius:7px; }
    .wl-unsent-block strong { display:block; margin-bottom:4px; }
    .wl-unsent-list { max-height:18vh; overflow:auto; white-space:pre-wrap; font:11px/1.5 ui-monospace,monospace; }
    .wl-unsent-neutral { color:#374151; background:#f1f3f4; }
    .wl-hidden { display:none !important; }
    .wl-stop { position:sticky; bottom:8px; width:100%; margin-top:8px; padding:12px; border:0; border-radius:9px; color:#fff; background:#b91c1c; font-weight:800; cursor:pointer; }
  `;

  function createPanel(title) {
    const host = document.createElement("div");
    host.dataset.winlistShopee = "1";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${PANEL_STYLES}</style>
      <section class="wl-panel">
        <header class="wl-head">
          <strong>${escapeHtml(title)} v${VERSION}</strong>
          <button class="wl-btn" data-collapse type="button">收合</button>
        </header>
        <div class="wl-body"></div>
      </section>
    `;
    document.body.append(host);
    const panel = shadow.querySelector(".wl-panel");
    const header = shadow.querySelector(".wl-head");
    const savedPosition = GM_getValue(STORE.panelPosition, null);
    const savedSize = GM_getValue(STORE.panelSize, null);
    const sizeLimits = () => ({
      minWidth: 320,
      maxWidth: Math.max(
        320,
        Math.min(window.innerWidth * 0.5, window.innerWidth - 32),
      ),
      minHeight: 200,
      maxHeight: Math.max(200, window.innerHeight - 32),
    });
    const clampSize = (width, height) => {
      const limits = sizeLimits();
      return {
        width: Math.min(
          Math.max(limits.minWidth, Number(width) || 430),
          limits.maxWidth,
        ),
        height: Math.min(
          Math.max(limits.minHeight, Number(height) || limits.minHeight),
          limits.maxHeight,
        ),
      };
    };
    if (
      Number.isFinite(savedSize?.width) &&
      Number.isFinite(savedSize?.height)
    ) {
      const restoredSize = clampSize(savedSize.width, savedSize.height);
      panel.style.width = `${Math.round(restoredSize.width)}px`;
      panel.style.height = `${Math.round(restoredSize.height)}px`;
    }
    const placePanel = (left, top) => {
      const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - 48);
      panel.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
      panel.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      placePanel(
        Number.isFinite(savedPosition?.left)
          ? savedPosition.left
          : rect.left,
        Number.isFinite(savedPosition?.top)
          ? savedPosition.top
          : rect.top,
      );
    });
    let sizeSaveTimer = null;
    let expandedHeight = null;
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (panel.classList.contains("wl-collapsed")) return;
            const rect = panel.getBoundingClientRect();
            expandedHeight = rect.height;
            clearTimeout(sizeSaveTimer);
            sizeSaveTimer = setTimeout(() => {
              if (panel.classList.contains("wl-collapsed")) return;
              const size = clampSize(rect.width, rect.height);
              GM_setValue(STORE.panelSize, {
                width: Math.round(size.width),
                height: Math.round(size.height),
              });
            }, 250);
          })
        : null;
    resizeObserver?.observe(panel);
    let dragState = null;
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      placePanel(
        event.clientX - dragState.offsetX,
        event.clientY - dragState.offsetY,
      );
    });
    const finishDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const rect = panel.getBoundingClientRect();
      GM_setValue(STORE.panelPosition, {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      });
      dragState = null;
      if (header.hasPointerCapture(event.pointerId)) {
        header.releasePointerCapture(event.pointerId);
      }
    };
    header.addEventListener("pointerup", finishDrag);
    header.addEventListener("pointercancel", finishDrag);
    shadow.querySelector("[data-collapse]").addEventListener("click", (event) => {
      const collapsing = !panel.classList.contains("wl-collapsed");
      if (collapsing) {
        expandedHeight = panel.getBoundingClientRect().height;
        panel.classList.add("wl-collapsed");
        panel.style.height = "";
      } else {
        panel.classList.remove("wl-collapsed");
        if (Number.isFinite(expandedHeight)) {
          panel.style.height = `${Math.round(expandedHeight)}px`;
        }
      }
      event.currentTarget.textContent = collapsing ? "展開" : "收合";
    });
    return {
      host,
      root: shadow,
      body: shadow.querySelector(".wl-body"),
      panel,
    };
  }

  function visible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element) return element;
    }
    return null;
  }

  function detectSecurityChallenge() {
    const selectors = [
      'iframe[src*="captcha" i]',
      'iframe[src*="challenge" i]',
      'iframe[title*="captcha" i]',
      '[class*="captcha" i]',
      '[id*="captcha" i]',
    ];
    if (selectors.some((selector) =>
      [...document.querySelectorAll(selector)].some(visible),
    )) {
      return true;
    }
    const pattern = /拼圖驗證|完成拼圖|安全驗證|請驗證|captcha|security challenge/iu;
    return [...document.querySelectorAll('[role="dialog"], [class*="modal" i]')]
      .filter(visible)
      .some((element) => pattern.test(normalizeText(element.textContent)));
  }

  async function waitFor(predicate, timeoutMs, stopRequested) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (stopRequested?.()) throw new Error("使用者已緊急停止。");
      if (detectSecurityChallenge()) {
        throw createAutomationError(
          "SECURITY_CHALLENGE",
          "偵測到拼圖／安全驗證，已立即停止；不會嘗試繞過。",
        );
      }
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  function setNativeValue(element, value) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function composerIsEmpty(composer) {
    return composer instanceof HTMLTextAreaElement
      ? composer.value === ""
      : normalizeText(composer.textContent) === "";
  }

  function clickableElement(element) {
    return (
      element.closest(
        'button,[role="button"],[tabindex]:not([tabindex="-1"])',
      ) || element
    );
  }

  function findSendButton(composer) {
    const composerRect = composer.getBoundingClientRect();
    const rawCandidates = [
      ...document.querySelectorAll(
        [
          'button:not([disabled])',
          '[role="button"]:not([aria-disabled="true"])',
          '[aria-label*="send" i]',
          '[aria-label*="送出"]',
          '[aria-label*="發送"]',
          '[title*="send" i]',
          '[title*="送出"]',
          '[title*="發送"]',
          '[class*="send" i]',
          '[data-testid*="send" i]',
          "svg.chat-icon",
          "svg",
        ].join(","),
      ),
    ];
    const candidates = rawCandidates
      .map(clickableElement)
      .filter((element, index, items) => items.indexOf(element) === index)
      .filter(
        (element) =>
          visible(element) &&
          !element.closest('[data-winlist-shopee="1"]') &&
          element.getAttribute("aria-disabled") !== "true" &&
          !element.hasAttribute("disabled"),
      )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (
          rect.width < 12 ||
          rect.height < 12 ||
          rect.width > 120 ||
          rect.height > 120 ||
          rect.right < composerRect.right - 150 ||
          rect.left > composerRect.right + 50 ||
          rect.bottom < composerRect.top - 25 ||
          rect.top > composerRect.bottom + 45
        ) {
          return null;
        }
        const metadata = normalizeText(
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-testid"),
            element.id,
            element.getAttribute("class"),
          ].join(" "),
        );
        const text = normalizeText(element.textContent);
        const distance =
          Math.abs(rect.right - composerRect.right) +
          Math.abs(rect.bottom - composerRect.bottom);
        let score = 300 - distance;
        if (/send|submit|送出|發送/iu.test(metadata)) score += 500;
        if (/send|submit|送出|發送/iu.test(text)) score += 300;
        if (element.tagName === "BUTTON") score += 60;
        if (element.getAttribute("role") === "button") score += 40;
        if (text && !/send|submit|送出|發送/iu.test(text)) score -= 120;
        return { element, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.element || null;
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

  function dispatchSearchKey(element, key, code, keyCode) {
    const options = {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, options);
      Object.defineProperty(event, "keyCode", { get: () => keyCode });
      Object.defineProperty(event, "which", { get: () => keyCode });
      element.dispatchEvent(event);
    }
  }

  function activateSendButton(button) {
    activateElement(button);
  }

  function exactSearchResult(account, searchInput) {
    const inputRect = searchInput.getBoundingClientRect();
    const candidates = [...document.querySelectorAll("div,li,span,p")]
      .filter(
        (element) =>
          visible(element) &&
          !element.closest('[data-winlist-shopee="1"]') &&
          normalizeText(element.textContent) === account,
      )
      .map((label) => {
        let row = label;
        while (row.parentElement) {
          const rect = row.getBoundingClientRect();
          if (rect.width >= 180 && rect.height >= 32 && rect.height <= 100) break;
          row = row.parentElement;
        }
        return { row, label };
      })
      .sort((left, right) => {
        const leftRect = left.label.getBoundingClientRect();
        const rightRect = right.label.getBoundingClientRect();
        return (
          leftRect.width * leftRect.height -
          rightRect.width * rightRect.height
        );
      })
      .filter(
        (candidate, index, items) =>
          items.findIndex((item) => item.row === candidate.row) === index,
      )
      .filter((candidate) => {
        const rect = candidate.row.getBoundingClientRect();
        return (
          normalizeText(candidate.row.textContent) === account &&
          rect.left <= inputRect.right + 80 &&
          rect.right >= inputRect.left - 30 &&
          rect.top >= inputRect.bottom - 10 &&
          rect.height >= 32 &&
          rect.height <= 100
        );
      })
      .sort(
        (left, right) =>
          left.row.getBoundingClientRect().top -
          right.row.getBoundingClientRect().top,
      );
    return candidates[0] || null;
  }

  function exactConversationHeader(account, searchInput) {
    const inputRect = searchInput.getBoundingClientRect();
    return [...document.querySelectorAll("div,span,p,h1,h2,h3")]
      .filter(
        (element) =>
          visible(element) &&
          normalizeText(element.textContent) === account &&
          element.getBoundingClientRect().left > inputRect.right + 30 &&
          element.getBoundingClientRect().top < 320,
      )[0] || null;
  }

  async function sendOneItem(item, stopRequested, reportStage = () => {}) {
    const searchInput = await waitFor(
      () => firstVisible(CHAT_SELECTORS.searchInputs),
      10000,
      stopRequested,
    );
    if (!searchInput) {
      throw createAutomationError(
        "SEARCH_INPUT_NOT_FOUND",
        "找不到「搜尋全部」輸入框。",
      );
    }
    searchInput.focus();
    setNativeValue(searchInput, "");
    setNativeValue(searchInput, item.account);
    reportStage("SEARCH_TYPED");

    const result = await waitFor(
      () => {
        if (navigator.onLine === false || !document.contains(searchInput) || !visible(searchInput) || normalizeText(searchInput.value) !== item.account) throw createAutomationError("SEARCH_UNRELIABLE", "搜尋框、搜尋文字或網路狀態已變動，未送出；請人工核對。");
        return exactSearchResult(item.account, searchInput);
      },
      20000,
      stopRequested,
    );
    requireExactSearchResult(result);
    reportStage("RESULT_FOUND");
    activateElement(result.label);
    reportStage("RESULT_LABEL_CLICKED");

    let verified = await waitFor(
      () => exactConversationHeader(item.account, searchInput),
      2500,
      stopRequested,
    );
    if (!verified) {
      activateElement(result.row, 0.2);
      reportStage("RESULT_ROW_CLICKED");
      verified = await waitFor(
        () => exactConversationHeader(item.account, searchInput),
        2500,
        stopRequested,
      );
    }
    if (!verified) {
      searchInput.focus();
      dispatchSearchKey(searchInput, "ArrowDown", "ArrowDown", 40);
      await new Promise((resolve) => setTimeout(resolve, 150));
      dispatchSearchKey(searchInput, "Enter", "Enter", 13);
      verified = await waitFor(
        () => exactConversationHeader(item.account, searchInput),
        3000,
        stopRequested,
      );
    }
    if (!verified) {
      throw createAutomationError(
        "CHAT_HEADER_UNVERIFIED",
        "右側對話帳號未能嚴格比對，為避免發錯人已跳過。",
      );
    }
    reportStage("HEADER_VERIFIED");

    const composer = await waitFor(
      () => firstVisible(CHAT_SELECTORS.composers),
      8000,
      stopRequested,
    );
    if (!composer) {
      throw createAutomationError(
        "COMPOSER_NOT_FOUND",
        "找不到訊息輸入框。",
      );
    }
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      setNativeValue(composer, item.message);
    } else {
      composer.textContent = item.message;
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: item.message,
        }),
      );
    }
    reportStage("COMPOSER_FILLED");
    if (detectSecurityChallenge()) {
      throw createAutomationError(
        "SECURITY_CHALLENGE",
        "偵測到拼圖／安全驗證，已立即停止；不會嘗試繞過。",
      );
    }
    const sendButton = await waitFor(
      () => findSendButton(composer),
      5000,
      stopRequested,
    );
    if (!sendButton) {
      throw createAutomationError(
        "SEND_BUTTON_NOT_FOUND",
        "找不到訊息輸入框右下角的橘色送出按鈕，未送出。",
      );
    }
    reportStage("SEND_BUTTON_FOUND");
    reportStage("SEND_CLICKED");
    activateSendButton(sendButton);
    const cleared = await waitFor(
      () =>
        !document.contains(composer) ||
        composerIsEmpty(composer),
      7000,
      stopRequested,
    );
    if (!cleared) {
      throw createAutomationError(
        "SEND_NOT_CONFIRMED",
        "已嘗試點擊橘色送出按鈕，但輸入框未清空，因此不記錄為成功。",
      );
    }
    reportStage("SEND_CONFIRMED");
  }

  function initPartB() {
    const savedConfig = loadConfig();
    const state = {
      queue: null,
      sent: loadSentHistory(),
      failed: loadFailedHistory(),
      blacklist: loadBlacklist(),
      logs: GM_getValue(STORE.logs, []),
      running: false,
      importing: false,
      stopRequested: false,
      resendExpanded: false,
    };
    const shell = createPanel("自動回覆明細");
    shell.body.innerHTML = `
      <div class="wl-section">
        <h3>1. 手動匯入已審核 Excel</h3>
        <label class="wl-field"><span>選擇人工審核並存檔後的 .xlsx</span><input data-b-xlsx type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
        <label class="wl-check"><input data-shopee-fee type="checkbox"><span>加收 10% 手續費（小數捨去），加上指定物流說明</span></label>
        <div class="wl-status wl-hidden" data-import-status></div>
        <p class="wl-mini">只讀工作表1「已確認」；留在工作表2「待確認」的資料不會發送。選檔與預覽不會自動送出訊息。</p>
      </div>
      <div class="wl-section">
        <h3>2. 發送前預覽</h3>
        <details><summary>黑名單（所有場次都不發送）</summary><label class="wl-field"><span>每行一個完整帳號</span><textarea data-blacklist rows="3"></textarea></label><button class="wl-btn" data-save-blacklist type="button">儲存黑名單</button><p class="wl-mini">修改後需按儲存才生效。名單只存於明細腳本；預檢名單需另行維護。</p><div class="wl-status" data-blacklist-status></div></details>
        <div class="wl-status" data-summary></div>
        <div class="wl-status wl-warn wl-hidden" data-message-dates></div>
        <label class="wl-field"><span>買家</span><select data-preview-select></select></label>
        <div class="wl-preview" data-preview></div>
        <div class="wl-actions"><button class="wl-btn" data-mark-manual type="button">這位明細已人工補送</button><button class="wl-btn" data-mark-blocked type="button">這位列入黑名單</button></div>
        <div class="wl-actions"><button class="wl-btn" data-clear-import type="button">清除已匯入 Excel</button></div>
      </div>
      <div class="wl-section">
        <h3>3. 發送控制</h3>
        <label class="wl-check"><input data-test-mode type="checkbox"><span>測試模式，只跑前 <input data-test-count type="number" min="1" max="50" style="width:64px"> 位尚未發送的買家</span></label>
        <p class="wl-mini">正式模式會引用完整尚未發送清單。每筆成功後隨機等待 15–25 秒。若出現拼圖／安全驗證，腳本立即停止，不繞過驗證。</p>
        <div class="wl-status wl-warn wl-hidden" data-known-not-found></div>
        <label class="wl-check"><input data-authorize type="checkbox"><span>我已核對預覽與帳號，授權本次自動送出</span></label>
        <div class="wl-actions">
          <button class="wl-btn wl-btn-primary" data-start type="button">開始發送</button>
          <button class="wl-btn" data-export type="button">匯出紀錄</button>
        </div>
        <div class="wl-status wl-hidden" data-run-status></div>
        <div class="wl-log" data-log></div>
        <div class="wl-status wl-error" data-reset-info></div>
        <label class="wl-field"><span>確定的話，請輸入「刪除」兩個字</span><input data-reset-sent-input type="text" placeholder="在這裡輸入"></label>
        <div class="wl-actions"><button class="wl-btn wl-btn-danger" data-reset-sent type="button" disabled>清除本場發送紀錄</button></div>
      </div>
      <div class="wl-section wl-hidden" data-resend-section>
        <h3>4. 依商品編號批次重發</h3>
        <div class="wl-status wl-warn" data-resend-time></div>
        <label class="wl-field"><span>哪個商品要重發？（多個用逗號隔開）</span><input data-resend-codes type="text" placeholder="H02, A05"></label>
        <div class="wl-status wl-hidden" data-resend-status></div>
        <div class="wl-resend-list">
          <p data-resend-summary>請先輸入商品編號</p>
          <div data-resend-accounts></div>
          <button class="wl-btn wl-hidden" data-resend-toggle type="button">展開</button>
        </div>
        <label class="wl-check"><input data-resend-authorize type="checkbox"><span>我已核對上面名單，授權重發</span></label>
        <div class="wl-actions"><button class="wl-btn wl-btn-primary" data-resend-start type="button" disabled>重發給這 0 位</button></div>
        <p class="wl-mini" data-resend-mini>會重新送出完整明細；每則之間隨機等待 15–25 秒。</p>
      </div>
      <div class="wl-section wl-hidden" data-unsent-section>
        <h3 data-unsent-title>5. 未送出清單</h3>
        <div class="wl-unsent-block wl-error wl-hidden" data-unsent-not-found>
          <strong data-unsent-not-found-title></strong>
          <div class="wl-mini">搜尋未確認不代表帳號不存在；請核對聊聊與載入狀態，再決定是否重查。</div>
          <div class="wl-unsent-list" data-unsent-not-found-list></div>
        </div>
        <div class="wl-unsent-block wl-warn wl-hidden" data-unsent-uncertain>
          <strong data-unsent-uncertain-title></strong>
          <div class="wl-mini">先到聊聊確認，未確認前不要重發。</div>
          <div class="wl-unsent-list" data-unsent-uncertain-list></div>
        </div>
        <div class="wl-unsent-block wl-warn wl-hidden" data-unsent-failed>
          <strong data-unsent-failed-title></strong>
          <div class="wl-mini">請先查看原因與停止階段；排除頁面問題後，再由人決定是否重跑。</div>
          <div class="wl-unsent-list" data-unsent-failed-list></div>
        </div>
        <div class="wl-unsent-block wl-unsent-neutral wl-hidden" data-unsent-unattempted></div>
        <div class="wl-unsent-block wl-unsent-neutral wl-hidden" data-excluded></div>
        <div class="wl-actions">
          <button class="wl-btn" data-unsent-copy type="button">複製清單</button>
          <button class="wl-btn" data-unsent-export type="button">匯出未送出 CSV</button>
        </div>
        <div class="wl-status wl-hidden" data-unsent-action-status></div>
      </div>
      <button class="wl-stop wl-hidden" data-stop type="button">緊急停止</button>
    `;

    const xlsxInput = shell.root.querySelector("[data-b-xlsx]");
    const shopeeFee = shell.root.querySelector("[data-shopee-fee]");
    const importStatus = shell.root.querySelector("[data-import-status]");
    const summary = shell.root.querySelector("[data-summary]");
    const messageDates = shell.root.querySelector("[data-message-dates]");
    const previewSelect = shell.root.querySelector("[data-preview-select]");
    const preview = shell.root.querySelector("[data-preview]");
    const manualButton = shell.root.querySelector("[data-mark-manual]");
    const blockedButton = shell.root.querySelector("[data-mark-blocked]");
    const blacklistInput = shell.root.querySelector("[data-blacklist]");
    const blacklistButton = shell.root.querySelector("[data-save-blacklist]");
    const blacklistStatus = shell.root.querySelector("[data-blacklist-status]");
    const excludedList = shell.root.querySelector("[data-excluded]");
    blacklistInput.value = state.blacklist.join("\n");
    const testMode = shell.root.querySelector("[data-test-mode]");
    const testCount = shell.root.querySelector("[data-test-count]");
    const authorize = shell.root.querySelector("[data-authorize]");
    const knownNotFound = shell.root.querySelector("[data-known-not-found]");
    const startButton = shell.root.querySelector("[data-start]");
    const stopButton = shell.root.querySelector("[data-stop]");
    const runStatus = shell.root.querySelector("[data-run-status]");
    const logElement = shell.root.querySelector("[data-log]");
    const resetInfo = shell.root.querySelector("[data-reset-info]");
    const resetSentInput = shell.root.querySelector("[data-reset-sent-input]");
    const resetSentButton = shell.root.querySelector("[data-reset-sent]");
    const resendSection = shell.root.querySelector("[data-resend-section]");
    const resendTime = shell.root.querySelector("[data-resend-time]");
    const resendCodes = shell.root.querySelector("[data-resend-codes]");
    const resendStatus = shell.root.querySelector("[data-resend-status]");
    const resendSummary = shell.root.querySelector("[data-resend-summary]");
    const resendAccounts = shell.root.querySelector("[data-resend-accounts]");
    const resendToggle = shell.root.querySelector("[data-resend-toggle]");
    const resendAuthorize = shell.root.querySelector(
      "[data-resend-authorize]",
    );
    const resendStart = shell.root.querySelector("[data-resend-start]");
    const resendMini = shell.root.querySelector("[data-resend-mini]");
    const unsentSection = shell.root.querySelector("[data-unsent-section]");
    const unsentTitle = shell.root.querySelector("[data-unsent-title]");
    const unsentNotFound = shell.root.querySelector(
      "[data-unsent-not-found]",
    );
    const unsentNotFoundTitle = shell.root.querySelector(
      "[data-unsent-not-found-title]",
    );
    const unsentNotFoundList = shell.root.querySelector(
      "[data-unsent-not-found-list]",
    );
    const unsentUncertain = shell.root.querySelector(
      "[data-unsent-uncertain]",
    );
    const unsentUncertainTitle = shell.root.querySelector(
      "[data-unsent-uncertain-title]",
    );
    const unsentUncertainList = shell.root.querySelector(
      "[data-unsent-uncertain-list]",
    );
    const unsentFailed = shell.root.querySelector("[data-unsent-failed]");
    const unsentFailedTitle = shell.root.querySelector(
      "[data-unsent-failed-title]",
    );
    const unsentFailedList = shell.root.querySelector(
      "[data-unsent-failed-list]",
    );
    const unsentUnattempted = shell.root.querySelector(
      "[data-unsent-unattempted]",
    );
    const unsentCopy = shell.root.querySelector("[data-unsent-copy]");
    const unsentExport = shell.root.querySelector("[data-unsent-export]");
    const unsentActionStatus = shell.root.querySelector(
      "[data-unsent-action-status]",
    );
    testMode.checked = savedConfig.testMode !== false;
    testCount.value = String(savedConfig.testCount || 3);

    const persistLogs = () => {
      state.logs = state.logs.slice(-1000);
      GM_setValue(STORE.logs, state.logs);
      logElement.textContent = state.logs
        .slice(-80)
        .map(
          (entry) =>
            `${entry.time} [${entry.status}] ${entry.account || "-"} ${entry.message}`,
        )
        .join("\n");
      logElement.scrollTop = logElement.scrollHeight;
    };
    const addLog = (status, account, message) => {
      state.logs.push({
        time: new Date().toLocaleString("zh-TW", { hour12: false }),
        status,
        account,
        message,
      });
      persistLogs();
    };
    const showRunStatus = (message, kind = "") => {
      runStatus.className = `wl-status ${kind ? `wl-${kind}` : ""}`;
      runStatus.textContent = message;
    };
    const showImportStatus = (message, kind = "") => {
      importStatus.className = `wl-status ${kind ? `wl-${kind}` : ""}`;
      importStatus.textContent = message;
    };
    const renderResetControls = () => {
      const session = state.queue?.session ?? null;
      const count =
        session == null ? 0 : sessionRecordCount(state.sent, session);
      if (session == null) {
        resetInfo.textContent =
          "請先匯入本場 Excel，才能清除該場的發送紀錄。";
      } else if (!normalizeText(session)) {
        resetInfo.textContent =
          `這個 Excel 沒有場次資訊，清除會影響所有沒有場次的 ${count} 筆紀錄。\n` +
          `接著只要按下開始發送，這些買家都可能再收到一次明細。`;
      } else {
        resetInfo.textContent =
          `這會把本場 ${count} 位全部變回「還沒發送」。\n` +
          `接著只要按下開始發送，這些買家都會再收到一次明細。\n` +
          `其他場次的紀錄不受影響。`;
      }
      resetSentInput.disabled = state.running || session == null || !count;
      resetSentButton.disabled =
        state.running ||
        session == null ||
        !count ||
        !isDeleteConfirmation(resetSentInput.value);
    };
    const renderResendControls = () => {
      const items = (state.queue?.items || []).filter(item => !state.blacklist.includes(item.account));
      const hasHistory =
        state.queue &&
        sessionRecordCount(state.sent, state.queue.session) > 0;
      resendSection.classList.toggle("wl-hidden", !hasHistory);
      if (!hasHistory) return;
      const view = buildResendViewModel(
        items,
        state.sent,
        resendCodes.value,
        resendAuthorize.checked,
        state.resendExpanded,
      );
      resendTime.textContent =
        `目前面板上的是 ${formatQueueTime(state.queue.createdAt)} 匯入的 Excel。\n` +
        "如果剛改過價格，請先重新匯入，再重發。";
      resendStatus.className = `wl-status ${view.statusMessage ? "wl-warn" : "wl-hidden"}`;
      resendStatus.textContent = view.statusMessage;
      resendSummary.textContent = view.items.length
        ? `買過這些商品的有 ${view.items.length} 位，其中 ${view.sentCount} 位已經發過。`
        : "請先輸入商品編號";
      resendAccounts.textContent = view.visibleAccounts.join("、");
      resendToggle.classList.toggle("wl-hidden", !view.hasMore);
      resendToggle.textContent = state.resendExpanded
        ? "收合"
        : `展開全部 ${view.items.length} 位`;
      resendToggle.disabled = state.running || !view.hasMore;
      resendCodes.disabled = state.running;
      resendAuthorize.disabled = state.running || !view.items.length;
      resendStart.textContent = view.buttonText;
      resendStart.disabled = state.running || view.disabled;
      resendMini.textContent = view.items.length
        ? `會重新送出這 ${view.items.length} 位的完整明細，包含已經發過的 ${view.sentCount} 位。每則之間隨機等待 15–25 秒。`
          : "會重新送出完整明細；每則之間隨機等待 15–25 秒。";
    };
    const renderUnsentControls = () => {
      const view = buildUnsentViewModel(
        state.queue?.items || [],
        state.sent,
        state.failed,
        state.blacklist,
      );
      const hasQueue = Boolean(state.queue);
      unsentSection.classList.toggle(
        "wl-hidden",
        !hasQueue || (!view.totalUnsent && !view.excluded.length),
      );
      knownNotFound.classList.toggle(
        "wl-hidden",
        !hasQueue || !view.searchUnconfirmed.length,
      );
      knownNotFound.textContent = view.searchUnconfirmed.length
        ? `這份 Excel 有 ${view.searchUnconfirmed.length} 位搜尋未確認；請先人工核對，不能據此認定帳號不存在。`
        : "";
      if (!hasQueue) return;

      unsentTitle.textContent =
        `5. 未送出清單（這份 Excel 共 ${view.totalExcel} 位；` +
        `未送出／待確認 ${view.totalUnsent} 位；黑名單排除 ${view.excluded.length} 位）`;
      excludedList.classList.toggle("wl-hidden", !view.excluded.length);
      excludedList.textContent = view.excluded.length ? `黑名單排除（不發送）：${view.excluded.map(row => row.account).join("、")}` : "";
      const setBlock = (block, title, list, rows, formatter) => {
        block.classList.toggle("wl-hidden", !rows.length);
        title.textContent = rows.length ? formatter.title(rows.length) : "";
        list.textContent = rows.map(formatter.row).join("\n");
      };
      setBlock(
        unsentNotFound,
        unsentNotFoundTitle,
        unsentNotFoundList,
        view.searchUnconfirmed,
        {
          title: (count) => `搜尋未確認（${count} 位）`,
          row: (row) => `${row.account}　$${formatMoney(row.total)}`,
        },
      );
      setBlock(
        unsentUncertain,
        unsentUncertainTitle,
        unsentUncertainList,
        view.uncertain,
        {
          title: (count) => `❓ 可能已發送（${count} 位）`,
          row: (row) =>
            [
              `${row.account}　$${formatMoney(row.total)}`,
              row.stage ? `停在 ${row.stage}` : "",
              row.reason,
            ]
              .filter(Boolean)
              .join("｜"),
        },
      );
      setBlock(
        unsentFailed,
        unsentFailedTitle,
        unsentFailedList,
        view.processFailed,
        {
          title: (count) => `⚠️ 中途失敗（${count} 位）`,
          row: (row) =>
            [
              `${row.account}　$${formatMoney(row.total)}`,
              row.stage ? `停在 ${row.stage}` : "",
              row.reason,
            ]
              .filter(Boolean)
              .join("｜"),
        },
      );
      unsentUnattempted.classList.toggle(
        "wl-hidden",
        !view.unattempted.length,
      );
      unsentUnattempted.textContent = view.unattempted.length
        ? `ℹ️ 尚未嘗試（${view.unattempted.length} 位）：這些人尚未輪到，不是執行失敗。`
        : "";
      unsentCopy.disabled = state.running || state.importing || (!view.totalUnsent && !view.excluded.length);
      unsentExport.disabled = state.running || state.importing || (!view.totalUnsent && !view.excluded.length);
    };
    const renderQueue = () => {
      const items = state.queue?.items || [];
      const previousIndex = Number(previewSelect.value) || 0;
      const queueSummary = summarizeQueueStates(items, state.sent, state.blacklist);
      summary.textContent = state.queue
        ? `Session：${state.queue.session || "未標示"}\n共 ${queueSummary.total} 位；已發送 ${queueSummary.sent}（人工 ${queueSummary.manualSent}）；黑名單排除 ${queueSummary.excluded}；內容已變動 ${queueSummary.changed}；可能已發送 ${queueSummary.uncertain}；預設可發送 ${queueSummary.sendByDefault}`
        : "尚未手動匯入已審核 Excel。";
      if (state.queue?.chargeShopeeFee) summary.textContent += "\n手續費：10%，每位買家合計後捨去小數。";
      if (state.queue?.promotionSummary) summary.textContent += `\n本場組合優惠：${state.queue.promotionSummary.appliedBuyerCount} 位買家套用，共折 $${formatMoney(state.queue.promotionSummary.discountTotal)}${state.queue.promotionSummary.skippedBuyerCount ? `；${state.queue.promotionSummary.skippedBuyerCount} 位買家有金額不符的組未另折抵` : ""}`;
      if (state.queue?.warnings?.length) summary.textContent += `\n請先核對：\n${state.queue.warnings.join("\n")}`;
      xlsxInput.disabled = state.running || state.importing;
      shopeeFee.disabled = state.running || state.importing;
      messageDates.classList.toggle("wl-hidden", !state.queue);
      messageDates.textContent = formatQueueDateSummary(state.queue);
      previewSelect.innerHTML = items
        .map(
          (item, index) =>
            `<option value="${index}">${escapeHtml(item.account)}${queueItemStatusLabel(item, state.sent, state.blacklist)}</option>`,
        )
          .join("");
      previewSelect.value = String(Math.min(previousIndex, Math.max(0, items.length - 1)));
      previewSelect.disabled = state.running || state.importing || !items.length;
      blacklistInput.disabled = blacklistButton.disabled = state.running || state.importing;
      startButton.disabled = state.running || !items.length;
      const renderSelected = () => {
        const item = items[Number(previewSelect.value) || 0];
        preview.textContent = item?.message || "沒有預覽資料";
        manualButton.disabled = state.running || state.importing || !item || state.blacklist.includes(item.account) || state.sent[item.id]?.source === "manual";
        blockedButton.disabled = state.running || state.importing || !item || state.blacklist.includes(item.account);
      };
      previewSelect.onchange = renderSelected;
      renderSelected();
      renderResetControls();
      renderResendControls();
      renderUnsentControls();
    };
    const refreshSentHistory = () => {
      state.sent = loadSentHistory();
      state.failed = loadFailedHistory();
      state.blacklist = loadBlacklist();
      renderQueue();
    };
    function saveBlacklist(value) {
      const next = parseBlacklist(value);
      GM_setValue(STORE.blacklist, next);
      state.blacklist = next; blacklistInput.value = next.join("\n");
      authorize.checked = resendAuthorize.checked = false;
      blacklistStatus.textContent = `已儲存 ${next.length} 位黑名單。`;
      renderQueue();
    }
    blacklistInput.addEventListener("input", () => { authorize.checked = resendAuthorize.checked = false; blacklistStatus.textContent = "尚未儲存，請按儲存黑名單。"; });
    blacklistButton.addEventListener("click", () => {
      if (state.running || state.importing) return;
      try { saveBlacklist(blacklistInput.value); } catch (error) { showRunStatus(error.message, "error"); }
    });
    function resolveSelected(manual) {
      if (state.running || state.importing || !state.queue) return;
      refreshSentHistory();
      const queue = state.queue, item = queue.items[Number(previewSelect.value) || 0];
      if (!item || (manual && state.blacklist.includes(item.account))) return;
      const prompt = manual
        ? `確認已人工補送此份 Excel 的完整明細給 ${item.account}？\n場次：${queue.session || "未標示"}\n${item.message}\n只更新紀錄，不會再次送出。`
        : `將 ${item.account} 列入黑名單？之後所有場次與商品重發都不會向此帳號送出。`;
      if (!window.confirm(prompt)) return;
      if (state.queue !== queue || state.running || state.importing) return;
      try {
        if (manual) {
          const next = markManualSent(loadSentHistory(), item, queue.session, loadBlacklist());
          GM_setValue(STORE.sent, next); state.sent = next;
          const failures = removeFailedRecord(loadFailedHistory(), item);
          GM_setValue(STORE.failed, failures); state.failed = failures;
          addLog("MANUAL_SENT", item.account, "使用者核對本場完整明細，確認已人工補送；未執行送出");
        } else {
          saveBlacklist([...loadBlacklist(), item.account]);
          addLog("BLACKLISTED", item.account, "使用者明確列入黑名單，不發送");
        }
        authorize.checked = resendAuthorize.checked = false;
        renderQueue();
        showRunStatus(`${item.account}：${manual ? "已人工補送" : "黑名單排除"}。只更新紀錄，沒有送出訊息。`, "success");
      } catch (error) { refreshSentHistory(); showRunStatus(`紀錄更新未完成：${error.message}。請保留頁面核對。`, "error"); }
    }
    manualButton.addEventListener("click", () => resolveSelected(true));
    blockedButton.addEventListener("click", () => resolveSelected(false));
    const importSelectedWorkbook = async () => {
      if (state.running) {
        showImportStatus("發送進行中，請先按緊急停止再更換 Excel。", "warn");
        return;
      }
      state.queue = null;
      authorize.checked = false;
      resendAuthorize.checked = false;
      resendCodes.value = "";
      state.resendExpanded = false;
      resetSentInput.value = "";
      unsentActionStatus.className = "wl-status wl-hidden";
      unsentActionStatus.textContent = "";
      renderQueue();
      const file = xlsxInput.files?.[0];
      if (!file) return;
      state.importing = true;
      renderQueue();
      try {
        state.queue = await readReviewedWorkbook(
          await file.arrayBuffer(),
          { ...loadConfig(), chargeShopeeFee: shopeeFee.checked },
        );
        refreshSentHistory();
        const warningText = state.queue.warnings?.length
          ? `\n\n請先確認以下提醒：\n${state.queue.warnings.join("\n")}`
          : "";
        showImportStatus(
          `已匯入「${file.name}」\n建立 ${state.queue.items.length} 位買家的發送預覽；尚未送出。${warningText}`,
          state.queue.warnings?.length ? "warn" : "success",
        );
      } catch (error) {
        state.queue = null;
        renderQueue();
        showImportStatus(error.message || String(error), "error");
      } finally {
        state.importing = false;
        renderQueue();
      }
    };
    xlsxInput.addEventListener("change", importSelectedWorkbook);
    shopeeFee.addEventListener("change", importSelectedWorkbook);
    async function interruptibleDelay(milliseconds, label) {
      const endsAt = Date.now() + milliseconds;
      while (Date.now() < endsAt) {
        if (state.stopRequested) throw new Error("使用者已緊急停止。");
        if (detectSecurityChallenge()) {
          throw createAutomationError(
            "SECURITY_CHALLENGE",
            "偵測到拼圖／安全驗證，已立即停止。",
          );
        }
        const remaining = Math.max(
          0,
          Math.ceil((endsAt - Date.now()) / 1000),
        );
        showRunStatus(`${label}\n距離下一位約 ${remaining} 秒`);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(500, endsAt - Date.now())),
        );
      }
    }
    async function runQueue(request = null) {
      if (state.running) return;
      refreshSentHistory();
      try {
        if (JSON.stringify(parseBlacklist(blacklistInput.value)) !== JSON.stringify(state.blacklist)) throw createAutomationError("BLACKLIST_UNSAVED", "黑名單尚未儲存或已在另一分頁變動，請先核對並儲存黑名單。");
      } catch (error) { showRunStatus(error.message, "error"); return; }
      const isResend = request?.mode === "resend";
      const allItems = isResend
        ? request.items
        : state.queue?.items || [];
      if (!allItems.length) {
        showRunStatus("沒有可發送的清單。", "error");
        return;
      }
      if (!isResend && !authorize.checked) {
        showRunStatus("請先勾選授權本次自動送出。", "error");
        return;
      }
      if (isResend && !resendAuthorize.checked) {
        showRunStatus("請先核對重發名單並勾選授權重發。", "error");
        return;
      }

      const nextConfig = {
        ...loadConfig(),
        testMode: testMode.checked,
        testCount: Math.max(
          1,
          Math.floor(Number(testCount.value) || 3),
        ),
        minDelaySeconds: 15,
        maxDelaySeconds: 25,
      };
      saveConfig(nextConfig);
      const allowedItems = allItems.filter(item => !state.blacklist.includes(item.account));
      const unsent = isResend
        ? allowedItems
        : allowedItems.filter(
            (item) =>
              resolveQueueItemState(item, state.sent, state.blacklist).sendByDefault,
          );
      const items =
        !isResend && nextConfig.testMode
          ? unsent.slice(0, nextConfig.testCount)
          : unsent;
      if (!items.length) {
        showRunStatus("清單已完成或已列入黑名單，沒有可發送者。", "success");
        return;
      }
      const runCounts = {
        sent: 0,
        uncertain: 0,
        buyerNotFound: 0,
        processFailed: 0,
      };

      state.running = true;
      state.stopRequested = false;
      startButton.disabled = true;
      stopButton.classList.remove("wl-hidden");
      renderQueue();
      addLog(
        "START",
        "",
        isResend
          ? `批次重發，共 ${items.length} 位`
          : `${nextConfig.testMode ? "測試" : "正式"}模式，共 ${items.length} 位`,
      );
      try {
        for (let index = 0; index < items.length; index += 1) {
          if (state.stopRequested) throw new Error("使用者已緊急停止。");
          const item = items[index];
          showRunStatus(
            `處理 ${index + 1}/${items.length}：${item.account}`,
          );
          if (
            state.blacklist.includes(item.account) || (!isResend &&
            !resolveQueueItemState(item, state.sent, state.blacklist).sendByDefault)
          ) {
            addLog("SKIP", item.account, "已有成功紀錄，不重發");
            continue;
          }
          let lastStage = "SEARCH";
          const reportStage = (stage) => {
            lastStage = stage;
            addLog("STAGE", item.account, stage);
            if (stage === "SEND_CLICKED") {
              state.sent = updateSentRecord(
                state.sent,
                item,
                state.queue.session,
                "uncertain",
              );
              GM_setValue(STORE.sent, state.sent);
              renderQueue();
            }
          };
          try {
            await sendOneItem(item, () => state.stopRequested, reportStage);
            state.sent = updateSentRecord(
              state.sent,
              item,
              state.queue.session,
              "sent",
            );
            GM_setValue(STORE.sent, state.sent);
            const sentRecord = state.sent[item.id];
            const legacy = legacySentEntry(sentRecord);
            GM_setValue(STORE.sentLegacy, {
              ...GM_getValue(STORE.sentLegacy, {}),
              [legacy.id]: legacy.record,
            });
            state.failed = removeFailedRecord(state.failed, item);
            GM_setValue(STORE.failed, state.failed);
            runCounts.sent += 1;
            addLog(
              "SENT",
              item.account,
              `已送出，總金額 $${formatMoney(item.total)}`,
            );
            renderQueue();
          } catch (error) {
            if (
              error.code === "SECURITY_CHALLENGE" ||
              String(error.message).includes("緊急停止")
            ) {
              throw error;
            }
            state.failed = updateFailedRecord(
              state.failed,
              item,
              state.queue.session,
              error,
              lastStage,
            );
            GM_setValue(STORE.failed, state.failed);
            if (
              resolveQueueItemState(item, state.sent).deliveryStatus ===
              "uncertain"
            ) {
              runCounts.uncertain += 1;
            } else if (failureCategory(error.code) === "search_unconfirmed") {
              runCounts.buyerNotFound += 1;
            } else {
              runCounts.processFailed += 1;
            }
            addLog(
              "SKIP",
              item.account,
              `${error.message || String(error)}（停在 ${lastStage}）`,
            );
            renderQueue();
          }
          if (index < items.length - 1) {
            const seconds =
              nextConfig.minDelaySeconds +
              Math.random() *
                (nextConfig.maxDelaySeconds -
                  nextConfig.minDelaySeconds);
            await interruptibleDelay(
              seconds * 1000,
              `已完成 ${index + 1}/${items.length}`,
            );
          }
        }
        const runSummary = buildRunSummary(runCounts);
        showRunStatus(runSummary.message, runSummary.kind);
        addLog("DONE", "", runSummary.message);
      } catch (error) {
        showRunStatus(error.message || String(error), "warn");
        addLog("STOP", "", error.message || String(error));
      } finally {
        state.running = false;
        state.stopRequested = false;
        startButton.disabled = false;
        stopButton.classList.add("wl-hidden");
        (isResend ? resendAuthorize : authorize).checked = false;
        renderQueue();
      }
    }

    async function runResendQueue() {
      if (state.running) return;
      refreshSentHistory();
      const view = buildResendViewModel(
        (state.queue?.items || []).filter(item => !state.blacklist.includes(item.account)),
        state.sent,
        resendCodes.value,
        resendAuthorize.checked,
        state.resendExpanded,
      );
      if (!view.items.length) {
        showRunStatus(
          view.statusMessage || "請先輸入有買家的商品編號。",
          "error",
        );
        return;
      }
      if (!resendAuthorize.checked) {
        showRunStatus("請先核對重發名單並勾選授權重發。", "error");
        return;
      }
      await runQueue({ mode: "resend", items: view.items });
    }

    shell.root
      .querySelector("[data-clear-import]")
      .addEventListener("click", () => {
        if (state.running) {
          showImportStatus("發送進行中，不能清除 Excel。", "warn");
          return;
        }
        state.queue = null;
        xlsxInput.value = "";
        authorize.checked = false;
        resendAuthorize.checked = false;
        resendCodes.value = "";
        state.resendExpanded = false;
        resetSentInput.value = "";
        unsentActionStatus.className = "wl-status wl-hidden";
        unsentActionStatus.textContent = "";
        renderQueue();
        showImportStatus("已清除；請重新選擇已審核 Excel。");
      });
    unsentCopy.addEventListener("click", async () => {
      const view = buildUnsentViewModel(
        state.queue?.items || [],
        state.sent,
        state.failed,
        state.blacklist,
      );
      try {
        await copyTextToClipboard(buildUnsentCopyText(view));
        unsentActionStatus.className = "wl-status wl-success";
        unsentActionStatus.textContent = `已複製 ${view.totalUnsent} 位未送出／待確認資料、${view.excluded.length} 位黑名單排除紀錄。`;
      } catch (error) {
        unsentActionStatus.className = "wl-status wl-error";
        unsentActionStatus.textContent = error.message || String(error);
      }
    });
    unsentExport.addEventListener("click", () => {
      const view = buildUnsentViewModel(
        state.queue?.items || [],
        state.sent,
        state.failed,
        state.blacklist,
      );
      downloadBlob(
        new Blob([buildUnsentCsv(view)], {
          type: "text/csv;charset=utf-8",
        }),
        buildUnsentCsvFilename(state.queue?.session),
      );
      unsentActionStatus.className = "wl-status wl-success";
      unsentActionStatus.textContent = `已匯出 ${view.totalUnsent} 位待處理、${view.excluded.length} 位黑名單排除紀錄；尚未嘗試排最後。`;
    });
    startButton.addEventListener("click", () => runQueue());
    resendCodes.addEventListener("input", () => {
      resendAuthorize.checked = false;
      state.resendExpanded = false;
      renderResendControls();
    });
    resendAuthorize.addEventListener("change", renderResendControls);
    resendToggle.addEventListener("click", () => {
      state.resendExpanded = !state.resendExpanded;
      renderResendControls();
    });
    resendStart.addEventListener("click", runResendQueue);
    resetSentInput.addEventListener("input", renderResetControls);
    stopButton.addEventListener("click", () => {
      state.stopRequested = true;
      showRunStatus("已要求緊急停止；目前這一步結束後不再繼續。", "warn");
    });
    shell.root.querySelector("[data-export]").addEventListener("click", () => {
      downloadBlob(
        new Blob([JSON.stringify(state.logs, null, 2)], {
          type: "application/json;charset=utf-8",
        }),
        `聊聊發送紀錄_${new Date().toISOString().slice(0, 10)}.json`,
      );
    });
    shell.root
      .querySelector("[data-reset-sent]")
      .addEventListener("click", () => {
        if (state.running) {
          showRunStatus("發送進行中，請先按緊急停止再清除紀錄。", "warn");
          return;
        }
        const session = state.queue?.session;
        if (session == null) {
          showRunStatus("請先匯入本場已審核 Excel。", "error");
          return;
        }
        const count = sessionRecordCount(state.sent, session);
        if (!count) {
          showRunStatus("本場目前沒有發送紀錄可清除。");
          return;
        }
        if (!isDeleteConfirmation(resetSentInput.value)) {
          showRunStatus("請在確認欄完整輸入「刪除」。", "error");
          return;
        }
        const cleared = clearSessionSentRecords(
          state.sent,
          GM_getValue(STORE.sentLegacy, {}),
          session,
        );
        state.sent = cleared.sentV3;
        GM_setValue(STORE.sent, cleared.sentV3);
        GM_setValue(STORE.sentLegacy, cleared.sentV2);
        resetSentInput.value = "";
        addLog(
          "RESET",
          "",
          `已清除本場 ${cleared.removedV3} 筆發送紀錄（v2 ${cleared.removedV2} 筆）`,
        );
        renderQueue();
        showRunStatus(
          normalizeText(session)
            ? `已清除本場 ${cleared.removedV3} 筆發送紀錄；其他場次不受影響。`
            : `已清除所有沒有場次的 ${cleared.removedV3} 筆發送紀錄。`,
          "success",
        );
      });
    renderQueue();
    persistLogs();
  }

  const testApi = {
    parseBlacklist,
    markManualSent,
    sendOneItem,
    COMBO_PROMOTION_SCHEMA_VERSION,
    parseComboProductCodes,
    normalizeComboPromotions,
    validateComboPromotions,
    calculateComboPromotions,
    preflightComboPromotions,
    summarizeComboPromotions,
    parseComboTableCells,
    comboTableFromSheet,

    buyerValueDisplay,
    effectiveBuyerText,
    validateBuyerAccount,
    readBuyerUid,
    rosterRows,
    readBuyerRoster,
    totalWithShopeeFee,
    normalizeText,
    normalizeCsvCell,
    parseCsv,
    splitColorSize,
    parseLiveCsv,
    buildReviewModel,
    mergeReviewedRows,
    buildQueue,
    createReviewWorkbook,
    readReviewedWorkbook,
    hashString,
    makeSentKey,
    createSentRecord,
    updateSentRecord,
    legacySentEntry,
    migrateSentV2ToV3,
    resolveQueueItemState,
    queueItemStatusLabel,
    summarizeQueueStates,
    createAutomationError,
    requireExactSearchResult,
    failureCategory,
    createFailedRecord,
    pruneFailedRecords,
    updateFailedRecord,
    removeFailedRecord,
    buildUnsentViewModel,
    orderedUnsentRows,
    protectCsvFormula,
    quoteCsvCell,
    buildUnsentCsv,
    buildUnsentCopyText,
    buildRunSummary,
    localDateFileLabel,
    safeFilenamePart,
    buildUnsentCsvFilename,
    initPartB,
    normalizeProductCode,
    parseProductCodes,
    filterQueueItemsByProductCodes,
    buildResendViewModel,
    isDeleteConfirmation,
    sessionRecordCount,
    clearSessionSentRecords,
    formatQueueTime,
    formatQueueDateSummary,
    detectSecurityChallenge,
    activateElement,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = testApi;
  }
  if (typeof window === "undefined" || typeof document === "undefined") return;

  if (
    location.hostname === "seller.shopee.tw" &&
    location.pathname.startsWith("/new-webchat/conversations")
  ) {
    initPartB();
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("開啟自動回覆明細", () => {
        document
          .querySelector('[data-winlist-shopee="1"]')
          ?.shadowRoot?.querySelector(".wl-panel")
          ?.classList.remove("wl-collapsed");
      });
    }
  }
})();
