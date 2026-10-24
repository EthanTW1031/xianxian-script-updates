// ==UserScript==
// @name         Shopee 未結標查詢
// @namespace    local.shopee.unsettled-check
// @version      0.1.2
// @description  匯入發送表，唯讀核對期限內一元賣場下單金額，列出未結單與人工待核名單
// @match        https://seller.shopee.tw/portal/sale/order*
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==
/* global ExcelJS, GM_getValue, GM_setValue, GM_registerMenuCommand, module */
(function unsettledCheck() {
  "use strict";
  const VERSION = "0.1.2";
  // Monetary engine: exact function text from detail 1.5.0, SHA256 cbeec4328f3350f212330678b32f69eba67ca451e15714a26487c764cd3730df.
  const DetailCore = (() => {
  const SHIPPING_NOTICE = "僅限使用蝦皮店到店/711/全家/新竹物流方式結單";
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
  const ROSTER_TITLE = "買家名冊 v1";
  const ROSTER_PREFIX = "SHOPEE_BUYER_ROSTER_V1:";
  const MISSING_ROSTER_WARNING = "這份檔沒有買家名冊，無法核對帳號是否被 Excel 改過";
  const INVALID_ROSTER_WARNING = "買家名冊無法使用，請核對原始資料與帳號；本次僅做帳號型別與樣式檢查";
  const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const ACCOUNT_DATE = new RegExp(`^(?:\\d+-${MONTH}(?:-\\d{2})?|${MONTH}-\\d{2}|\\d+月\\d+日|\\d{4}/\\d{1,2}/\\d{1,2})$`, "u");
  const ACCOUNT_SCIENTIFIC = /^[+-]?\d+(?:\.\d+)?E[+-]\d+$/u;
  const ACCOUNT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  const ACCOUNT_ERROR = /^(?:TRUE|FALSE|#NAME\?|#VALUE!|#REF!|#DIV\/0!|#N\/A|#NUM!|#NULL!)$/u;


  const COMBO_PROMOTION_SCHEMA_VERSION = 1;
  const COMBO_TITLE = "本場優惠 v1";
  const COMBO_RESERVED_CODE = "組合優惠";
  const COMBO_HEADERS = ["組別", "優惠商品", "算法", "件數", "金額"];
  const COMBO_TYPES = { bundle: "幾件一組共多少", each: "幾件以上每件多少" };
  const COMBO_FORBIDDEN_LABELS = new Set(["商品編號", "審核單價", "來源價格", "開頭範本", "結尾範本", "場次日期", "結單日", "直播Session", "場次日期來源", "結單日來源"]);


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

  function normalizeCsvCell(value) {
    const raw = String(value ?? "").replace(/^\uFEFF/u, "").trim();
    const excelText = raw.match(/^="((?:[^"]|"")*)"$/u);
    return excelText ? excelText[1].replace(/""/gu, '"') : raw;
  }

  function buyerAccountError(errors) {
    const error = new Error(errors.join("；"));
    error.code = "BUYER_ACCOUNT_REVIEW_REQUIRED";
    error.details = { issues: errors };
    return error;
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

  function validateBuyerAccount(value) {
    const result = effectiveBuyerText(value);
    const text = result.ok ? normalizeText(normalizeCsvCell(result.text)) : "";
    const converted = ACCOUNT_DATE.test(text) || ACCOUNT_SCIENTIFIC.test(text) || ACCOUNT_ISO.test(text) || ACCOUNT_ERROR.test(text);
    return { ok: result.ok && !converted, text, reason: !result.ok ? "non-text" : converted ? "excel-shape" : "" };
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\uFEFF/g, "")
      .replace(/\s+/gu, " ")
      .trim();
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

  function rosterFingerprint(meta, rows) {
    return hashString(JSON.stringify([meta.schema, meta.session, meta.scope, meta.count, rows.map(row => [row.account, row.buyerUid])]));
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function hasRosterArea(sheet) {
    return cellText(sheet.getCell("J1")) === ROSTER_TITLE || cellText(sheet.getCell("J2")) === "名冊買家帳號" ||
      cellText(sheet.getCell("K2")) === "名冊買家UID" || cellText(sheet.getCell("L1")).startsWith(ROSTER_PREFIX);
  }

  function cellText(cell) {
    return normalizeText(cellValue(cell));
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

  function formatSourceRows(row) {
    const rows = sourceRowsOf(row);
    return rows.length ? `第 ${rows.join("、")} 列` : "列號不明";
  }

  function sourceRowsOf(row) {
    if (Array.isArray(row.sourceRows)) {
      return [...new Set(row.sourceRows.filter(Number.isInteger))].sort(
        (left, right) => left - right,
      );
    }
    return Number.isInteger(row.sourceRow) ? [row.sourceRow] : [];
  }

  function normalizeProductCode(value) {
    return normalizeText(value).replace(/\s+/gu, "").toUpperCase();
  }

  function comboTableFromSheet(sheet) {
    const matrix = Array.from({ length: Math.max(2, sheet.rowCount) }, (_, index) => COMBO_HEADERS.map((_, column) => sheet.getCell(index + 1, column + 14).value));
    return parseComboTableCells(matrix);
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

  function comboTextCell(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && Object.keys(value).every(key => key === "richText") &&
      Array.isArray(value.richText) && value.richText.every(part => part && typeof part.text === "string")) {
      return value.richText.map(part => part.text).join("");
    }
    return value;
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

  function parseStrictPositiveInteger(value) {
    const text = String(value ?? "").replace(/,/gu, "").trim();
    if (!text) return { state: "empty", value: null };
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { state: "invalid", value: null };
    }
    return { state: "ok", value: parsed };
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

  function parseNumber(value) {
    const parsed = Number(String(value ?? "").replace(/,/gu, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
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

  function normalizeMultilineText(value) {
    return String(value ?? "")
      .replace(/\uFEFF/g, "")
      .replace(/\r\n?/gu, "\n")
      .trim();
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

  function naturalCompare(left, right) {
    return String(left).localeCompare(String(right), "zh-Hant", {
      numeric: true,
      sensitivity: "base",
    });
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

  function applyTemplate(template, values) {
    return String(template ?? "")
      .replace(/\{買家\}/gu, values.account)
      .replace(/\{日期\}/gu, values.eventDate)
      .replace(/\{結單日\}/gu, values.closingDate);
  }

  function makeSentKey(session, account) {
    return `${normalizeText(session)}\u001F${normalizeText(account)}`;
  }

  function localDateLabel(date = new Date()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function nextDateLabel() {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return localDateLabel(date);
  }
    return { readReviewedWorkbook, buildQueue, cellValue, cellText, findHeaderRow, readReviewedRows, readReviewedPrices, readMultiPriceCodes, readMessageSettings, readBuyerRoster, effectiveBuyerText, validateBuyerAccount, readBuyerUid, comboTableFromSheet, totalWithShopeeFee };
  })();
  const DAY = 86400, ORIGIN = "https://seller.shopee.tw";
  const PATHS = Object.freeze({index:"/api/v3/order/search_order_list_index", detail:"/api/v3/order/get_one_order"});
  const LABELS = Object.freeze({settled:"已結單",review:"人工待核",short:"金額不足",cancelled:"期限內只有取消單",early:"結單日前已下單",late:"期限後才下單",none:"沒有訂單",outsideCancelled:"範圍內只有期間外的取消單"});
  const KNOWN = new Set(["1/1/待出貨","2/2/待出貨","1/1/已出貨","2/2/已出貨","2/2/已送達","4/11/已完成(鑑賞期內)","4/11/已完成","4/10/已完成"]);
  const text = value => String(value ?? "");
  const esc = value => text(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  function fault(code,message) { const e=new Error(message); e.code=code; return e; }
  function ensure(ok,code,message) { if(!ok) throw fault(code,message); }
  function safeInt(n,label,min=0) { ensure(typeof n === "number" && Number.isSafeInteger(n) && n>=min,"SCHEMA",`${label}不是可確認的整數`); return n; }
  function add(a,b) { return safeInt(a+b,"合計"); }
  function idText(value,label="編號",allowZero=false) {
    ensure((typeof value==="number" && Number.isSafeInteger(value)) || typeof value==="string","SCHEMA",`${label}格式或精度無法確認`);
    const s=String(value); ensure(/^(?:0|[1-9]\d*)$/.test(s) && (allowZero || s!=="0") && s.length<=16 && BigInt(s)<=BigInt(Number.MAX_SAFE_INTEGER),"SCHEMA",`${label}格式或精度無法確認`); return s;
  }
  function dateStart(value) {
    ensure(typeof value==="string" && /^\d{4}-\d{2}-\d{2}$/.test(value),"INPUT","請填完整日期（年/月/日）");
    const ms=Date.parse(value+"T00:00:00+08:00");
    ensure(Number.isFinite(ms) && new Date(ms+28800000).toISOString().slice(0,10)===value,"INPUT","日期不存在"); return ms/1000;
  }
  function dateValue(sec) { return new Date(sec*1000+28800000).toISOString().slice(0,10); }
  function taipei(sec) { return sec==null ? "" : new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(sec*1000)); }
  function makeWindow(closing,lower,upper=Math.floor(Date.now()/1000)) {
    const start=dateStart(closing),from=dateStart(lower); safeInt(upper,"查詢時間",1);
    ensure(from<=start,"INPUT","查詢起點不能晚於結單日");
    return {closing,lower,from,start,end:start+4*DAY,upper,reminder:upper<start+4*DAY};
  }
  function sheetDate(raw,closing) {
    const ref=dateStart(closing), year=Number(closing.slice(0,4)), month=Number(closing.slice(5,7));
    if(raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString().slice(0,10);
    if(typeof raw==="number" && Number.isFinite(raw) && raw>0 && raw<100000) return new Date(Date.UTC(1899,11,30)+Math.floor(raw)*DAY*1000).toISOString().slice(0,10);
    if(raw && typeof raw==="object") raw=DetailCore.cellValue({value:raw});
    const s=text(raw).trim(), full=s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/), part=s.match(/^(\d{1,2})[/-](\d{1,2})$/);
    if(!full&&!part) return null;
    const y=full?Number(full[1]):year-(Number(part[1])>month?1:0),m=full?Number(full[2]):Number(part[1]),d=full?Number(full[3]):Number(part[2]);
    const out=`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    try { dateStart(out); return out; } catch { return null; }
  }
  async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join(""); }
  function stable(value) {
    if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
    if(value && typeof value==="object") return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
    return JSON.stringify(value);
  }
  async function importBook(bytes,name,id,fee=false) {
    ensure(typeof ExcelJS!=="undefined","EXCEL","Excel 元件尚未載入，請重新整理");
    const wb=new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
    const [confirmed,pending,settingsSheet]=wb.worksheets;
    ensure(confirmed?.name==="已確認"&&pending?.name==="待確認"&&settingsSheet?.name==="設定與價格","WORKBOOK",`${name}：前三張工作表必須是已確認、待確認、設定與價格`);
    const header=DetailCore.findHeaderRow(confirmed); ensure(header>0,"WORKBOOK",`${name}：找不到買家帳號／商品編號表頭`);
    const comboPromotions=DetailCore.comboTableFromSheet(settingsSheet),markerRows=new Set(),amountSources=new Map();
    if(comboPromotions!==null) {
      for(let r=header+1;r<=confirmed.rowCount;r++) {
        const blank=v=>v==null||v==="";
        if(confirmed.getCell(r,2).value==="組合優惠"&&[1,6,7].every(c=>blank(confirmed.getCell(r,c).value))) markerRows.add(r);
        const amount=confirmed.getCell(r,7).value;
        amountSources.set(r,amount&&typeof amount==="object"&&("formula" in amount||"sharedFormula" in amount)?amount.result==null||amount.result===""?"fallback":"formula-result":amount==null||amount===""?"fallback":"number");
      }
    }
    const rows=DetailCore.readReviewedRows(confirmed,comboPromotions!==null?markerRows:null);
    ensure(rows.length>0,"WORKBOOK",`${name}：「已確認」沒有買家資料`);
    const config=DetailCore.readMessageSettings(settingsSheet,{chargeShopeeFee:fee,openingTemplate:"",closingTemplate:"",eventDate:"",closingDate:""},comboPromotions!==null);
    const roster=DetailCore.readBuyerRoster(settingsSheet,config.session), rawAccounts=new Map(), inputWarnings=new Map();
    for(const row of rows) {
      const extracted=DetailCore.effectiveBuyerText(confirmed.getCell(row.sourceRow,1).value);
      const raw=extracted.text.trim();
      ensure(raw!==""&&!/\s/u.test(raw),"ACCOUNT",`${name} 第${row.sourceRow}列帳號無法確認`);
      if(rawAccounts.has(row.account)&&rawAccounts.get(row.account)!==raw) throw fault("ACCOUNT",`${name}：不同原始帳號正規化後相同，不能形成完整名單`);
      rawAccounts.set(row.account,raw);
      if(raw!==row.account) inputWarnings.set(raw,"帳號原文與明細正規化結果不同，請核對");
      row.buyerUid=roster.accounts?.get(row.account)||"";
    }
    const prices=DetailCore.readReviewedPrices(settingsSheet), multi=DetailCore.readMultiPriceCodes(settingsSheet);
    // Exact 1.5.0 monetary engine. Message templates are intentionally neutral for a query-only tool.
    const queue=DetailCore.buildQueue(rows,prices,{...config,chargeShopeeFee:fee,openingTemplate:"",closingTemplate:"",closingDate:""},config.session,multi,comboPromotions!==null?{comboPromotions,amountSources}:null);
    const buyers=queue.items.map(item=>{
      const account=rawAccounts.get(item.account), originals=rows.filter(r=>r.account===item.account);
      const signature=stable({rows:originals.map(r=>({code:r.code,productName:r.productName,color:r.color,size:r.size,quantity:r.quantity,directAmount:r.directAmount,amountState:r.amountState,source:amountSources.get(r.sourceRow)||r.amountState})).map(stable).sort(),prices:[...prices].sort(),multi:[...multi].sort(),comboPromotions,fee});
      const uids=[...new Set(originals.map(r=>r.buyerUid).filter(Boolean))];
      return {account,total:safeInt(item.total,"明細金額"),goodsTotal:item.goodsTotal,feeAmount:item.feeAmount,discountTotal:item.discountTotal||0,promotionSkips:item.promotionSkips||[],signature,uids,identityWarnings:inputWarnings.has(account)?[inputWarnings.get(account)]:[]};
    });
    const warnings=[...queue.warnings]; if(roster.warning) warnings.push(roster.warning);
    if(comboPromotions!==null&&!markerRows.size) warnings.push("優惠標記列被刪除，請核對原始發送版本");
    return {id,name,sha256:await digest(bytes),fee,session:config.session,eventRaw:settingsSheet.getCell("H4").value,closingRaw:settingsSheet.getCell("H5").value,sourceRows:rows.length,uniqueCount:buyers.length,total:buyers.reduce((a,b)=>add(a,b.total),0),buyers,warnings,markerRows:[...markerRows]};
  }
  function choiceKey(session,account) { return JSON.stringify([session,account]); }
  function prepare(entries,choices={},closing="") {
    const issues=[],conflicts=[],groups=new Map(), warnings=[];
    for(const entry of entries) {
      if(entry.error) { issues.push(`${entry.name}：${entry.error}`); continue; }
      const session=text(entry.sessionOverride??entry.session).trim();
      if(!session) { issues.push(`${entry.name}：請指定這份表的 Session`); continue; }
      if(!groups.has(session)) groups.set(session,new Map());
      for(const buyer of entry.buyers) {
        if(!groups.get(session).has(buyer.account)) groups.get(session).set(buyer.account,[]);
        groups.get(session).get(buyer.account).push({entry,buyer});
      }
      warnings.push(...entry.warnings.map(w=>`${entry.name}：${w}`));
      if(closing) {
        const event=sheetDate(entry.eventRaw,closing), date=sheetDate(entry.closingRaw,closing);
        if(!event) warnings.push(`${entry.name}：讀不到場次日期，請確認查詢起點`);
        else if(dateStart(event)>=dateStart(closing)) warnings.push(`${entry.name}：場次日期 ${event} 在結單日當天或之後，可能是下一期`);
        else if(dateStart(closing)-dateStart(event)>7*DAY) warnings.push(`${entry.name}：場次日期 ${event} 可能是上一期`);
        if(date&&date!==closing) warnings.push(`${entry.name}：發送表結單日 ${date}，本次填 ${closing}，請核對`);
        if(!date) warnings.push(`${entry.name}：發送表未填或讀不到結單日`);
      }
    }
    const buyers=new Map(), selections=[];
    for(const [session,accounts] of groups) for(const [account,sources] of accounts) {
      const key=choiceKey(session,account),same=new Set(sources.map(s=>s.buyer.signature)).size===1;
      let picked=sources[0];
      if(sources.length>1) {
        if(!same) {
          const selected=sources.find(s=>s.entry.id===choices[key]);
          conflicts.push({key,session,account,sources:sources.map(s=>({id:s.entry.id,name:s.entry.name,total:s.buyer.total})),selected:selected?.entry.id||""});
          if(!selected) { issues.push(`${session}／${account}：請選擇有效明細來源`); continue; }
          picked=selected;
        } else if(choices[key]) picked=sources.find(s=>s.entry.id===choices[key])||picked;
      }
      if(!buyers.has(account)) buyers.set(account,{account,due:0,sources:[],uids:[],identityWarnings:[]});
      const b=buyers.get(account); b.due=add(b.due,picked.buyer.total); b.uids.push(...sources.flatMap(s=>s.buyer.uids)); b.identityWarnings.push(...sources.flatMap(s=>s.buyer.identityWarnings));
      const provenance={session,file:picked.entry.name,fileId:picked.entry.id,sha256:picked.entry.sha256,event:closing?sheetDate(picked.entry.eventRaw,closing):null,fee:picked.entry.fee,total:picked.buyer.total,deduplicated:sources.length>1&&same,available:sources.map(s=>s.entry.name)};
      b.sources.push(provenance); selections.push({account,...provenance});
    }
    const result=[...buyers.values()]; if(!result.length) issues.push("目前沒有可查詢的已確認買家");
    return {buyers:result,issues:[...new Set(issues)],conflicts,warnings:[...new Set(warnings)],selections};
  }
  function parseOrder(d,expected,whitelist,unpaidPairs=[]) {
    ensure(d&&typeof d==="object"&&!Array.isArray(d),"SCHEMA","訂單明細缺資料");
    const id=idText(d.order_id,"訂單ID"); ensure(id===idText(expected),"SCHEMA","明細與索引訂單ID不符");
    const uid=idText(d.buyer_user?.user_id,"買家UID"), account=d.buyer_user?.user_name;
    ensure(typeof account==="string"&&account.trim()!==""&&!/\s/u.test(account.trim()),"SCHEMA","訂單帳號缺漏或格式不明");
    ensure(typeof d.order_sn==="string"&&d.order_sn.trim()!=="","SCHEMA","缺少訂單編號");
    const created=safeInt(d.create_time,"成立時間",1), status=safeInt(d.status,"狀態"),ext=safeInt(d.status_ext,"狀態細分"),ret=idText(d.return_id,"退貨旗標",true);
    const label=d.status_info_v2?.status; ensure(typeof label==="string"&&label.trim()!=="","SCHEMA","訂單狀態文字缺漏");
    ensure(Array.isArray(d.order_items)&&d.order_items.length>0,"SCHEMA","訂單商品資料缺漏");
    const items=d.order_items.map(i=>{
      ensure(i&&typeof i==="object"&&!Array.isArray(i),"SCHEMA","商品列格式不明");
      const itemId=idText(i.item_id,"商品ID"),modelId=idText(i.model_id,"規格ID",true),amount=safeInt(i.amount,"商品件數",1),lineStatus=safeInt(i.status,"商品列狀態");
      ensure(typeof i.product?.name==="string"&&i.product.name.trim()!=="","SCHEMA","商品名稱缺漏");
      for(const k of ["item_list","bundle_deal_model","bundle_deal_product"]) if(i[k]!=null) ensure(Array.isArray(i[k])&&i[k].length===0,"SCHEMA","看不懂的巢狀商品或組合，已停止");
      ensure(i.bundle_deal==null,"SCHEMA","看不懂的巢狀商品或組合，已停止");
      const reviewTag=i.show_rr_tag===true||i.show_cancellation_tag===true||
        (typeof i.rr_tag_qty==="number"&&i.rr_tag_qty>0)||(typeof i.cancellation_tag_qty==="number"&&i.cancellation_tag_qty>0);
      return {itemId,modelId,amount,name:i.product.name,lineStatus,reviewTag};
    });
    let kind="pending", reason="狀態組合尚未確認";
    if(ret!=="0") reason="有退貨退款，請人工核對";
    else if(status===5&&label==="不成立"&&[6,8].includes(ext)) {kind="cancelled";reason="不成立";}
    else if(KNOWN.has(`${status}/${ext}/${label}`)) {kind="effective";reason="";}
    else if(label==="尚未付款"&&unpaidPairs.some(([s,e])=>s===status&&e===ext)) {kind="effective";reason="尚未付款（已確認對應）";}
    // No invented numeric mapping for unpaid orders is shipped. Unverified combinations remain reviewable.
    if(ret==="0"&&items.some(i=>i.lineStatus===3)) {kind="pending";reason="商品列含退貨狀態，與主訂單旗標需核對";}
    else if(kind!=="cancelled"&&items.some(i=>!(i.lineStatus===1||(i.lineStatus===2&&status===4&&(label==="已完成"||label==="已完成(鑑賞期內)")))||i.reviewTag)) {kind="pending";reason="商品列狀態或退貨／部分取消標記需人工核對";}
    const quantity=items.filter(i=>whitelist.has(i.itemId)).reduce((sum,i)=>add(sum,i.amount),0);
    return {id,orderSn:d.order_sn,account:account.trim(),uid,created,status,ext,label,hasReturn:ret!=="0",kind,reason,quantity,items,otherGoods:items.some(i=>!whitelist.has(i.itemId))};
  }
  function parseWhitelist(value) { const ids=[...new Set(text(value).split(/[\s,，]+/u).filter(Boolean).map(v=>idText(v,"一元商品ID")))]; ensure(ids.length>0,"INPUT","請填一元商品ID白名單"); return new Set(ids); }
  function periodOf(created,w) { return created<w.start?"early":created<w.end?"period":"late"; }
  function classify(buyer,orders,w,identityWarnings=[]) {
    const bins={early:[],period:[],late:[]}; for(const o of orders) if(o.created>=w.from&&o.created<=w.upper) bins[periodOf(o.created,w)].push(o);
    const all=Object.values(bins).flat(), p=bins.period,valid=p.filter(o=>o.kind==="effective"), pending=p.filter(o=>o.kind==="pending"),money=valid.reduce((s,o)=>add(s,o.quantity),0);
    const pendingMoney=pending.reduce((s,o)=>add(s,o.quantity),0), early=bins.early.filter(o=>o.kind==="effective"), late=bins.late.filter(o=>o.kind==="effective");
    const identity=[...new Set([...buyer.identityWarnings,...identityWarnings])];
    let category;
    if(identity.length) category="review";
    else if(money>=buyer.due) category="settled";
    else if(pending.length) category="review";
    else if(valid.length) category="short";
    else if(p.length&&p.every(o=>o.kind==="cancelled")) category="cancelled";
    else if(!p.length&&early.length) category="early";
    else if(late.length) category="late";
    else if(!all.length) category="none";
    else if(all.every(o=>o.kind==="cancelled")) category="outsideCancelled";
    else if(all.some(o=>o.kind==="pending")) category="review";
    else throw fault("CLASSIFICATION","訂單分類無法完整判定，未產生名單");
    const notes=[...identity];
    for(const [period,list] of Object.entries(bins)) {
      const title={early:"結單日前",period:"期間內",late:"期限後"}[period],cancel=list.filter(o=>o.kind==="cancelled"),wait=list.filter(o=>o.kind==="pending"),yes=list.filter(o=>o.kind==="effective");
      if(period!=="period"&&yes.length) notes.push(`${title}有效單${yes.length}筆，件數合計${yes.reduce((s,o)=>add(s,o.quantity),0)}，最後${taipei(Math.max(...yes.map(o=>o.created)))}`);
      if(cancel.length) notes.push(`${title}取消單${cancel.length}筆`);
      if(wait.length) notes.push(`${title}待核${wait.length}筆：${[...new Set(wait.map(o=>o.reason+"／"+o.label))].join("；")}`);
    }
    if(all.some(o=>o.otherGoods)) notes.push("訂單裡有其他商品，只計一元商品");
    return {...buyer,category,label:LABELS[category],money,pendingMoney,shortfall:Math.max(buyer.due-money,0),overpaid:Math.max(money-buyer.due,0),last:all.length?Math.max(...all.map(o=>o.created)):null,lastEffective:all.some(o=>o.kind==="effective")?Math.max(...all.filter(o=>o.kind==="effective").map(o=>o.created)):null,earlyMoney:early.reduce((s,o)=>add(s,o.quantity),0),lateMoney:late.reduce((s,o)=>add(s,o.quantity),0),notes,orders:all};
  }
  function identityMap(buyers,orders) {
    const byAccount=new Map(),byUid=new Map(),warnings=new Map();
    const note=(account,message)=>{if(!warnings.has(account)) warnings.set(account,new Set());warnings.get(account).add(message);};
    const feed=(account,uid)=>{if(!uid)return;if(!byAccount.has(account))byAccount.set(account,new Set());byAccount.get(account).add(uid);if(!byUid.has(uid))byUid.set(uid,new Set());byUid.get(uid).add(account);};
    buyers.forEach(b=>b.uids.forEach(uid=>feed(b.account,uid)));orders.forEach(o=>feed(o.account,o.uid));
    for(const [account,uids] of byAccount) if(uids.size>1) note(account,"同一帳號對應不同UID，身份待核");
    for(const accounts of byUid.values()) if(accounts.size>1) for(const account of accounts) note(account,"同一UID對應不同帳號，身份待核");
    return new Map([...warnings].map(([k,v])=>[k,[...v]]));
  }
  function buildResult(buyers,orders,w,meta={}) {
    const identity=identityMap(buyers,orders),byAccount=new Map();
    for(const o of orders) { if(!byAccount.has(o.account))byAccount.set(o.account,[]);byAccount.get(o.account).push(o); }
    const order=["none","outsideCancelled","cancelled","short","review","late","early","settled"];
    const rows=buyers.map(b=>classify(b,byAccount.get(b.account)||[],w,identity.get(b.account)||[])).sort((a,b)=>order.indexOf(a.category)-order.indexOf(b.category)||a.account.localeCompare(b.account));
    return {version:VERSION,window:w,meta,rows,summary:rows.reduce((a,r)=>(a[r.category]=(a[r.category]||0)+1,a),{}),title:w.reminder?`期限未到（${taipei(w.end-1)}），這是提醒名單，不是黑名單`:`逾期名單（期限 ${taipei(w.end-1)} 已過，供人工審核）`};
  }
  function copyAccounts(result,selected) { ensure(result,"STALE","結果已失效，請重新查詢");return result.rows.filter(r=>r.category!=="settled"&&selected.has(r.category)).map(r=>r.account).join("\n"); }
  function abortCheck(signal) { if(signal?.aborted) throw fault("STOP","本輪已停止或輸入已變更，結果作廢"); }
  function scheduler({limit=4,interval=100,signal}={}) {
    let active=0,batchStarts=0,batchAt=0,timer=null; const queue=[];
    function pump() {
      if(timer) {clearTimeout(timer);timer=null;}
      if(signal?.aborted) {while(queue.length)queue.shift().reject(fault("STOP","查詢已停止"));return;}
      const now=Date.now(); if(now-batchAt>=interval){batchAt=now;batchStarts=0;}
      while(queue.length&&active<limit&&batchStarts<limit) {
        const task=queue.shift();active++;batchStarts++;
        Promise.resolve().then(()=>{abortCheck(signal);return task.fn();}).then(task.resolve,task.reject).finally(()=>{active--;pump();});
      }
      if(queue.length&&active<limit) timer=setTimeout(pump,Math.max(1,interval-(Date.now()-batchAt)));
    }
    signal?.addEventListener("abort",pump,{once:true});
    return fn=>new Promise((resolve,reject)=>{queue.push({fn,resolve,reject});pump();});
  }
  function cookieToken(cookie) {
    const parts=text(cookie).split(";").map(s=>s.trim()).filter(s=>s.startsWith("SPC_CDS="));
    ensure(parts.length===1,"SESSION","讀不到登入驗證資訊，請重新整理或重新登入");
    const value=parts[0].slice(8);ensure(value!==""&&value.length<512,"SESSION","登入驗證資訊無法確認，請重新整理");return value;
  }
  function createApi({fetchFn=fetch,cookie=()=>document.cookie,signal,timeout=20000,interval=100}={}) {
    const schedule=scheduler({signal,interval});
    async function request(path,params={}) {
      ensure(Object.values(PATHS).includes(path),"ENDPOINT","不允許的查詢端點");
      for(let attempt=0;attempt<3;attempt++) {
        abortCheck(signal);
        try { return await schedule(async()=>{
          const token=cookieToken(cookie()),url=new URL(path,ORIGIN);
          url.searchParams.set("SPC_CDS",token);url.searchParams.set("SPC_CDS_VER","2");
          if(params.id)url.searchParams.set("order_id",idText(params.id));
          const controller=new AbortController();const abort=()=>controller.abort(); signal?.addEventListener("abort",abort,{once:true});
          let timer;
          try {
            return await Promise.race([(async()=>{
              const response=await fetchFn(url.href,{method:path===PATHS.index?"POST":"GET",credentials:"same-origin",headers:path===PATHS.index?{"Content-Type":"application/json"}:{},...(path===PATHS.index?{body:JSON.stringify(params.body)}:{}),signal:controller.signal,redirect:"error"});
              if(response.status===401||response.status===403)throw fault("SECURITY","登入或安全驗證已改變，查詢停止");
              ensure(response.ok,"HTTP","訂單查詢HTTP失敗");
              if(response.headers?.get("content-type")?.includes("text/html"))throw fault("SECURITY","收到登入或驗證頁，查詢停止");
              let json;try{json=await response.json();}catch{throw fault("SCHEMA","訂單回應不是有效JSON");}
              ensure(json&&json.code===0&&json.data&&typeof json.data==="object","API","訂單查詢回應未成功或缺少資料");return json.data;
            })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fault("TIMEOUT","訂單查詢逾時"));},timeout);})]);
          } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);}
        }); }
        catch(e) {abortCheck(signal);if(["SECURITY","SESSION","SCHEMA","ENDPOINT"].includes(e.code)||attempt===2) throw fault(e.code||"NETWORK",e.code?e.message:"訂單查詢連線失敗，整輪作廢");}
      }
    }
    return {index:(page,sentinel,tab=100)=>{ensure([100,200].includes(tab),"ENDPOINT","不允許的查詢頁籤");return request(PATHS.index,{body:{order_list_tab:tab,entity_type:1,pagination:{from_page_number:page-1,page_number:page,page_size:40,...(sentinel?{page_sentinel:sentinel}:{})},filter:{fulfillment_type:0,is_drop_off:0,fulfillment_source:0,action_filter:0},sort:{sort_type:3,ascending:false}}});},detail:id=>request(PATHS.detail,{id})};
  }
  function parseSentinel(raw) { ensure(typeof raw==="string"&&/^\d+,\d+$/.test(raw),"CURSOR","翻頁記號缺漏或格式改變");const [s,id]=raw.split(",");return {time:safeInt(Number(s),"翻頁時間",1),id:idText(id)}; }
  function orderFingerprint(o) {return stable(o);}
  async function scan(api,w,whitelist,signal,progress=()=>{},cache=null) {
    let page=1,cursor=null,lastTime=Infinity,indexCount=0,duplicates=0;const cursors=new Set(),map=new Map(),bounds=[];
    for(;;) {
      abortCheck(signal); const data=await api.index(page,cursor);abortCheck(signal);
      ensure(Array.isArray(data.index_list)&&data.index_list.length<=40&&data.pagination,"SCHEMA","索引清單或分頁資料格式不明");
      const total=safeInt(data.pagination.total,"索引總數");
      if(data.pagination.page_number!=null)ensure(data.pagination.page_number===page,"CURSOR","索引回應頁碼不符，整輪作廢");
      if(data.pagination.page_size!=null)ensure(data.pagination.page_size===40,"SCHEMA","索引每頁筆數設定改變，整輪作廢");
      if(!data.index_list.length) {ensure(map.size>=total,"INCOMPLETE","索引空頁但沒有讀到明確結束，整輪作廢");break;}
      const ids=data.index_list.map(i=>{ensure(i&&typeof i==="object"&&!Array.isArray(i),"SCHEMA","索引不是有效物件");idText(i.shop_id,"賣場ID");ensure(typeof i.region_id==="string"&&i.region_id!=="","SCHEMA","索引地區缺漏");return idText(i.order_id);});
      const orders=await Promise.all(ids.map(async id=>{
        const o=cache?.get(id)||parseOrder(await api.detail(id),id,whitelist);abortCheck(signal);return o;
      }));
      let fresh=0;
      for(const o of orders) {
        indexCount++; ensure(o.created<=lastTime,"ORDERING","索引成立時間不是由新到舊，整輪作廢");lastTime=o.created;
        if(map.has(o.id)) {duplicates++;ensure(orderFingerprint(map.get(o.id))===orderFingerprint(o),"CHANGED","同一訂單內容改變，整輪作廢");}
        else {map.set(o.id,o);fresh++;}
      }
      ensure(fresh>0,"CURSOR","索引頁只有重複訂單，整輪作廢");
      const oldest=orders.at(-1),newest=orders[0];bounds.push({page,firstId:newest.id,firstTime:newest.created,lastId:oldest.id,lastTime:oldest.created});
      progress({phase:cache?2:1,page,indexCount,unique:map.size,oldest:oldest.created});
      if(oldest.created<w.from)break;
      const next=data.pagination.next_page_sentinel;
      if(!next) {ensure(map.size>=total,"INCOMPLETE","索引尚未到查詢起點卻缺翻頁記號，整輪作廢");break;}
      const tail=parseSentinel(next);ensure(tail.id===oldest.id&&tail.time===oldest.created,"CURSOR","翻頁記號與實際訂單邊界不符，整輪作廢");
      if(data.pagination.previous_page_sentinel) {
        const head=parseSentinel(data.pagination.previous_page_sentinel);ensure(head.id===newest.id&&head.time===newest.created,"CURSOR","索引起始邊界不符，整輪作廢");
      }
      ensure(!cursors.has(next)&&next!==cursor,"CURSOR","翻頁記號循環或未前進，整輪作廢");cursors.add(next);cursor=next;page++;
    }
    ensure(indexCount-duplicates===map.size,"INCOMPLETE","索引與解析筆數無法對帳");
    return {map,bounds,indexCount,duplicates,parsed:map.size};
  }
  async function reconcile(api,buyers,w,whitelist,signal,progress) {
    const first=await scan(api,w,whitelist,signal,progress);
    const second=await scan(api,w,whitelist,signal,progress,first.map);abortCheck(signal);
    const within=map=>new Set([...map.values()].filter(o=>o.created>=w.from&&o.created<=w.upper).map(o=>o.id));
    const a=within(first.map),b=within(second.map);ensure(a.size===b.size&&[...a].every(id=>b.has(id)),"CHANGED","第二遍完整區間訂單ID不同，整輪作廢，請重新查詢");
    let orders=[...first.map.values()].filter(o=>a.has(o.id));
    let unpaidMeta=null;
    if(orders.some(o=>o.label==="尚未付款"&&!o.hasReturn)) {
      // D9: verify unpaid membership using the same read-only index endpoint (tab 200),
      // rather than inventing an unobserved numeric status mapping.
      const unpaidApi={detail:api.detail,index:(page,cursor)=>api.index(page,cursor,200)};
      const one=await scan(unpaidApi,w,whitelist,signal,p=>progress?.({...p,phase:3}),first.map);
      const two=await scan(unpaidApi,w,whitelist,signal,p=>progress?.({...p,phase:4}),first.map);
      const u=within(one.map),v=within(two.map);
      ensure(u.size===v.size&&[...u].every(id=>v.has(id)),"CHANGED","尚未付款索引在核對期間改變，整輪作廢");
      ensure([...u].every(id=>a.has(id)),"CHANGED","未付款索引與全部訂單索引不一致，整輪作廢");
      orders=orders.map(o=>o.label==="尚未付款"&&!o.hasReturn&&u.has(o.id)&&![1,2,4,5].includes(o.status)&&o.items.every(i=>i.lineStatus===1&&!i.reviewTag)?{...o,kind:"effective",reason:"尚未付款（以兩遍未付款索引確認，不推測數字對應）"}:o);
      unpaidMeta={checkedIds:u.size,method:"同一索引API，order_list_tab=200，兩遍ID集合核對"};
    }
    return buildResult(buyers,orders,w,{started:w.upper,ended:Math.floor(Date.now()/1000),first:{indexCount:first.indexCount,unique:first.map.size,duplicates:first.duplicates,parsed:first.parsed,bounds:first.bounds},second:{indexCount:second.indexCount,unique:second.map.size,duplicates:second.duplicates,bounds:second.bounds},checkedIds:a.size,unpaid:unpaidMeta,completeness:"兩遍固定區間ID一致；讀取期間觀察到的狀態，並非快照"});
  }
  function runState() {
    let epoch=0,controller=null,result=null;
    return {get result(){return result;},invalidate(){epoch++;controller?.abort();controller=null;result=null;},begin(){this.invalidate();controller=new AbortController();return {epoch,signal:controller.signal};},publish(token,value){ensure(token.epoch===epoch&&!token.signal.aborted,"STALE","結果已失效");result=value;},valid(token){return token.epoch===epoch&&!token.signal.aborted;}};
  }
  function exportBook(result) {
    ensure(result,"STALE","結果已失效，請重新查詢");const wb=new ExcelJS.Workbook();
    const summary=wb.addWorksheet("名單"),audit=wb.addWorksheet("逐訂單核對"),settled=wb.addWorksheet("已結單"),sources=wb.addWorksheet("來源與選擇");
    const meta=[result.title,"讀取期間觀察到的狀態；兩次ID集合觀察一致並非快照",`結單日 ${result.window.closing}；期限 ${taipei(result.window.end-1)}；起點 ${taipei(result.window.from)}；上界 ${taipei(result.window.upper)}`,`開始 ${taipei(result.meta.started)}；結束 ${taipei(result.meta.ended)}；完整性 ${result.meta.completeness}`,`第一遍：索引 ${result.meta.first?.indexCount??"未記錄"}、唯一 ${result.meta.first?.unique??"未記錄"}、解析 ${result.meta.first?.parsed??"未記錄"}；第二遍：索引 ${result.meta.second?.indexCount??"未記錄"}、唯一 ${result.meta.second?.unique??"未記錄"}；固定區間 ${result.meta.checkedIds??"未記錄"}筆`,`一元商品ID ${(result.meta.whitelist||[]).join("、")}`];
    const selected=result.meta.selections||[],lines=meta;
    const headers=["分類","帳號","在哪幾場","明細金額","期間內有效件數","期間內待核件數","差額","多付","最後一次下單時間","最後有效下單時間","結單日前有效合計","期限後有效合計","備註"];
    function setup(sheet,cols) {for(const line of lines){const row=sheet.addRow([String(line)]);sheet.mergeCells(row.number,1,row.number,cols.length);row.height=30;}sheet.addRow([]);const header=sheet.addRow(cols);header.height=32;header.font={bold:true,color:{argb:"FFFFFFFF"}};header.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF175866"}};sheet.views=[{state:"frozen",ySplit:header.number}];sheet.columns=cols.map((_,i)=>({width:i===1?25:i===2||i===12?52:24}));return header.number;}
    const sr=setup(summary,headers),tr=setup(settled,headers);
    const blankCells=values=>values.map(v=>v===""?null:v);
    const output=r=>blankCells([r.label,String(r.account),r.sources.map(s=>`${s.file}／${s.event||"日期未讀到"}／${s.session}`).join("；"),r.due,r.money,r.pendingMoney,r.shortfall,r.overpaid,taipei(r.last),taipei(r.lastEffective),r.earlyMoney,r.lateMoney,r.notes.join("；")]);
    for(const r of result.rows)(r.category==="settled"?settled:summary).addRow(output(r));
    const ar=setup(audit,["訂單ID","訂單編號","帳號","成立時間（台北）","主狀態文字","主狀態數字","狀態細分","時段","判定","有效計入件數","待核件數","有退貨","商品ID","各列件數","備註"]);
    for(const r of result.rows) for(const o of r.orders) audit.addRow(blankCells([String(o.id),String(o.orderSn),String(o.account),taipei(o.created),String(o.label),o.status,o.ext,{early:"結單日前",period:"期間內",late:"期限後"}[periodOf(o.created,result.window)],{effective:"有效",cancelled:"取消",pending:"待核"}[o.kind],o.kind==="effective"?o.quantity:0,o.kind==="pending"?o.quantity:0,o.hasReturn?"有":"無",o.items.map(i=>i.itemId).join("、"),o.items.map(i=>`${i.itemId}/${i.modelId} x${i.amount}`).join("；"),o.reason]));
    const pr=setup(sources,["帳號","Session","選用檔案","場次日期","10%手續費","本場金額","來源SHA256","相同內容已去重","候選檔案"]);
    for(const s of selected)sources.addRow([String(s.account),String(s.session),String(s.file),s.event||"日期未讀到",s.fee?"有":"無",s.total,String(s.sha256),s.deduplicated?"是":"否",(s.available||[]).join("；")]);
    for(const [sheet,row] of [[summary,sr],[audit,ar],[settled,tr],[sources,pr]]) {
      sheet.eachRow((r,n)=>{r.alignment={vertical:"top",wrapText:true};if(n>row){let height=1;r.eachCell((c,col)=>{if(typeof c.value==="string"){c.numFmt="@";height=Math.max(height,Math.ceil(c.value.length/Math.max(8,(sheet.getColumn(col).width||24)/1.6)));}});r.height=Math.min(409,Math.max(30,height*17));}});
      sheet.autoFilter={from:{row,column:1},to:{row,column:sheet.columnCount}};
    }
    return wb;
  }

/* BEGIN ETHAN TOOL DOCK V1 */
function createEthanToolDock({id,label,name,version,order,colour,panel,collapse,lockRunning=false,lockText='發送中',onOpen=()=>{}}){
  const doc=panel.ownerDocument;
  let dock=doc.getElementById('ethan-tool-dock-v1');
  const css=(node,values)=>{node.style.setProperty('all','initial','important');for(const [key,value]of Object.entries(values))node.style.setProperty(key,value,'important');};
  if(!dock){dock=doc.createElement('div');dock.id='ethan-tool-dock-v1';css(dock,{position:'fixed',right:'16px',bottom:'16px','z-index':'2147483647',display:'flex',gap:'6px','align-items':'center','pointer-events':'none',margin:'0',padding:'0',transform:'none',float:'none',width:'max-content',height:'auto','max-width':'none','max-height':'none'});doc.documentElement.append(dock);}
  if(dock.querySelector('[data-dock-tool="'+id+'"]'))return null;
  const host=doc.createElement('div');host.dataset.dockTool=id;
  css(host,{display:'block',position:'relative',order:String(order),'pointer-events':'auto',margin:'0',padding:'0',transform:'none',float:'none',width:'max-content',height:'30px','max-width':'none','max-height':'none','flex-shrink':'0'});
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML='<style>:host{all:initial}*{box-sizing:border-box}button{position:relative;height:30px;margin:0;padding:0 10px;border:1px solid var(--tool);border-radius:7px;background:var(--tool);color:#fff;box-shadow:0 2px 7px #0003;font:bold 13px/28px "Microsoft JhengHei",sans-serif;white-space:nowrap;cursor:pointer}button.open{background:#fff;color:var(--tool)}button.error{background:#b91c1c;border-color:#b91c1c;color:#fff}.dot{position:absolute;right:-3px;top:-3px;width:8px;height:8px;background:#dc2626;border-radius:50%;box-shadow:0 0 0 1px #fff}.dot[hidden]{display:none}</style><button type="button"><span></span><i class="dot" hidden></i></button>';
  const button=shadow.querySelector('button'),text=shadow.querySelector('span'),dot=shadow.querySelector('.dot');button.style.setProperty('--tool',colour);
  if(collapse){for(const [key,value]of Object.entries({'min-width':'52px',width:'auto',height:'28px',padding:'0 6px','font-size':'12px','line-height':'26px','white-space':'nowrap','flex-shrink':'0'}))collapse.style.setProperty(key,value);}
  dock.append(host);let opened=false,notice=false,serial=0;const phases=new Map();
  const current=phase=>{if(!phases.has(phase))phases.set(phase,{running:false,error:false,complete:false,done:null,total:null,serial:0});return phases.get(phase);};
  const busy=()=>[...phases.values()].some(p=>p.running);
  function render(){const values=[...phases.values()],error=values.some(p=>p.error),active=values.filter(p=>p.running).sort((a,b)=>b.serial-a.serial)[0],complete=values.some(p=>p.complete);let suffix='';
    if(error)text.textContent='⚠ '+label;
    else{if(active)suffix=Number.isFinite(active.done)&&Number.isFinite(active.total)&&active.total>0?' '+active.done+'/'+active.total:' 跑中';else if(!opened&&complete)suffix=' ✓';text.textContent=label+suffix;}
    button.classList.toggle('open',opened);button.classList.toggle('error',error);button.setAttribute('aria-pressed',String(opened));button.title=name+' v'+version+'；點一下'+(opened?'收起':'打開');button.setAttribute('aria-label',button.title);dot.hidden=!notice;
    if(collapse){const locked=lockRunning&&busy();collapse.disabled=locked;collapse.textContent=locked?lockText:'收合';collapse.title=locked?'跑的時候不能收合；要停請按緊急停止（或停止）':'收合面板';collapse.setAttribute('aria-expanded',String(opened));collapse.setAttribute('aria-label',locked?lockText+'，不能收合':'收合面板');}
  }
  function open(){opened=true;for(const p of phases.values())p.complete=false;panel.style.setProperty('visibility','visible','important');panel.inert=false;panel.removeAttribute('aria-hidden');onOpen();render();}
  function close(focus=true){if(lockRunning&&busy())return false;opened=false;panel.style.setProperty('visibility','hidden','important');panel.inert=true;panel.setAttribute('aria-hidden','true');if(focus)button.focus({preventScroll:true});render();return true;}
  function toggle(){if(opened)close();else open();}
  for(const type of ['pointerdown','pointerup','click','dblclick'])host.addEventListener(type,event=>event.stopPropagation());
  button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();toggle();});
  if(collapse)collapse.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();close();});
  close(false);
  return {host,button,open,close,toggle,get opened(){return opened;},setNotice(value){notice=!!value;render();},
    status(error=false,phase='main'){const p=current(phase);p.error=!!error;if(error){p.complete=false;open();}render();},
    setBadge({phase='main',running,done,total,outcome,start=false,reset=false}={}){if(reset)phases.delete(phase);const p=current(phase);p.serial=++serial;if(typeof running==='boolean')p.running=running;if(Number.isFinite(done))p.done=Math.max(0,Math.floor(done));if(Number.isFinite(total))p.total=Math.max(0,Math.floor(total));if(start){p.error=false;p.complete=false;p.done=null;p.total=null;open();}if(outcome){p.running=false;p.complete=outcome==='complete';if(outcome!=='complete')p.complete=false;}render();},
    geometry(){const r=panel.getBoundingClientRect();return r.width>0&&r.height>0&&[r.left,r.top,r.width,r.height].every(Number.isFinite)?r:null;}
  };
}
/* END ETHAN TOOL DOCK V1 */

  function mount() {
    if(location.origin!==ORIGIN||location.pathname!=="/portal/sale/order"||document.querySelector("[data-unsettled-check]")) return;
    const host=document.createElement("div");host.dataset.unsettledCheck="1";
    const root=host.attachShadow({mode:"open"});
    root.innerHTML=`<style>
      :host{all:initial;position:fixed;right:18px;top:90px;z-index:2147483000;font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#19323b}
      *{box-sizing:border-box}section{width:min(780px,calc(100vw - 24px));max-height:85vh;background:#fff;border:1px solid #a9c1c9;border-radius:12px;box-shadow:0 8px 32px #0003;overflow:hidden}
      header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#175866;color:white;cursor:move}h2{font-size:17px;margin:0}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #aec7ce;border-radius:5px;background:#f0f6f7;padding:6px 10px;color:#174753}button:disabled{opacity:.45;cursor:default}header button{background:white}
      main{padding:14px;max-height:calc(85vh - 52px);overflow:auto}label{display:inline-block;margin:5px 8px 5px 0}input[type=date],input[type=text],select{border:1px solid #a9bfc5;border-radius:4px;padding:5px;max-width:100%}input[type=text]{width:260px}input[data-session]{width:190px}.files>div{margin:8px 0;padding:8px;background:#f3f7f8;border-radius:6px}.muted{color:#526b73;font-size:12px}.warn{color:#855800;background:#fff4d9;padding:7px;white-space:pre-wrap}.error{color:#a30020;white-space:pre-wrap}.status{white-space:pre-wrap;margin:10px 0}table{border-collapse:collapse;font-size:12px;min-width:620px;width:100%}th,td{padding:6px;border-bottom:1px solid #d9e2e5;text-align:left;vertical-align:top}th{background:#eef5f6;white-space:nowrap}.scroll{overflow:auto}td.note{min-width:210px}.banner{font-size:18px;font-weight:bold;padding:10px;background:#e5f3f2;margin:8px 0}.banner.reminder{color:#a50020;background:#fff0ef}.hide{display:none}summary{cursor:pointer;font-weight:bold}fieldset{border:1px solid #cad9de;margin:10px 0;padding:8px}.action{background:#175866;color:white}.stop{color:#9c1630}
    </style><section><header><h2>Shopee 未結標查詢</h2><button data-collapse>收合</button></header><main>
      <p class="muted">匯入本期全部發送表，核對一元賣場下單金額。退貨退款及身份疑義另列人工待核。</p>
      <label>發送表（可多選） <input data-files type="file" accept=".xlsx" multiple></label>
      <div class="files" data-files-list></div>
      <div><label>結單日 <input data-closing type="date"></label><label>查詢起點 <input data-lower type="date"></label></div>
      <label><input data-lower-confirm type="checkbox">我已確認查詢起點與推定年份</label>
      <div><label>一元商品 ID（多個以逗號分隔） <input data-whitelist type="text" value="19464283801"></label></div>
      <div data-period class="muted"></div><div data-conflicts></div><div data-preview class="muted"></div><div data-warnings class="warn hide"></div>
      <div><button data-start class="action">核對後開始查詢</button> <button data-stop class="stop" disabled>停止並作廢結果</button></div>
      <div data-status class="status" aria-live="polite">請先加入發送表，填結單日並確認起點。</div>
      <div data-result class="hide"><div data-banner class="banner"></div><div data-counts></div>
        <fieldset><legend>選取要複製的類別（預設不選）</legend><div data-categories></div><button data-copy disabled>複製所選類別帳號</button> <button data-export disabled>匯出核對 Excel</button></fieldset>
        <div class="scroll" data-table></div><details><summary data-settled-title>已結單</summary><div class="scroll" data-settled></div></details>
      </div>
    </main></section>`;
    document.documentElement.append(host);
    const $=s=>root.querySelector(s), state={entries:[],choices:{},sequence:0,importing:false,running:false,lowerDirty:false,prepared:null,closed:false};
    function orderListSignature() {
      return [...document.querySelectorAll('a[href]')].map(link=>link.href)
        .filter(href=>/^https:\/\/seller\.shopee\.tw\/portal\/sale\/order\/\d+(?:[?#].*)?$/.test(href)).join("\n");
    }
    const dock=createEthanToolDock({id:'unsettled',label:'未結標',name:'Shopee 未結標查詢',version:VERSION,order:10,colour:'#175866',panel:host,collapse:$("[data-collapse]")});
    let dockError='';
    function dockBegin(phase){dockError='';dock.status(false);dock.setBadge({phase:'main',running:true,start:true,reset:true});}
    const runs=runState(),downloadUrls=new Set(); let currentUrl=location.href,currentOrderList=orderListSignature();
    const status=(message,error=false)=>{$("[data-status]").textContent=message;$("[data-status]").classList.toggle("error",error);if(error&&dockError!==message){dockError=message;dock.status(true);}};
    function buttons() {
      $("[data-start]").disabled=state.running||state.importing;$("[data-stop]").disabled=!state.running;
      $("[data-copy]").disabled=!runs.result||!root.querySelector("[data-category]:checked");$("[data-export]").disabled=!runs.result;
    }
    function invalidate(message="輸入或頁面已變更，請重新查詢。") {
      dock.setBadge({running:false,outcome:"cancelled"});
      runs.invalidate();state.running=false;state.activeRun=null;$("[data-result]").classList.add("hide");$("[data-categories]").replaceChildren();buttons();status(message);
    }
    function closing() {const value=$("[data-closing]").value;if(value)dateStart(value);return value;}
    function render() {
      let close="";try{close=closing();}catch(e){status(e.message,true);}
      state.prepared=prepare(state.entries,state.choices,close);
      $("[data-files-list]").innerHTML=state.entries.map(e=>`<div><strong>${esc(e.name)}</strong> <button data-remove="${esc(e.id)}">移除</button>${e.error?`<div class="error">${esc(e.error)}</div>`:`<div class="muted">場次 ${esc(close?sheetDate(e.eventRaw,close)||"讀不到":text(DetailCore.cellValue({value:e.eventRaw})))}／表內結單日 ${esc(close?sheetDate(e.closingRaw,close)||"未填":text(DetailCore.cellValue({value:e.closingRaw})))}／${e.sourceRows}列、${e.uniqueCount}位／明細合計 ${e.total.toLocaleString("zh-TW")}</div><label>Session <input data-session="${esc(e.id)}" type="text" value="${esc(e.sessionOverride??e.session)}" placeholder="空白時請人工指定"></label><label><input data-fee="${esc(e.id)}" type="checkbox" ${e.fee?"checked":""}>這份明細發送時有加10%手續費</label>`}</div>`).join("");
      $("[data-conflicts]").innerHTML=state.prepared.conflicts.map(c=>`<fieldset><legend>${esc(c.session)}／${esc(c.account)}：請選來源</legend><select data-choice="${esc(c.key)}"><option value="">尚未選擇</option>${c.sources.map(s=>`<option value="${esc(s.id)}" ${c.selected===s.id?"selected":""}>${esc(s.name)}（${s.total}）</option>`).join("")}</select></fieldset>`).join("");
      const duplicates=state.prepared.selections.filter(s=>s.deduplicated);
      $("[data-preview]").textContent=`目前 ${state.entries.length}份表、合併 ${state.prepared.buyers.length}位；明細合計 ${state.prepared.buyers.reduce((s,b)=>add(s,b.due),0).toLocaleString("zh-TW")}。${duplicates.length?`相同場次內容已去重${duplicates.length}組。`:""}`;
      const warnings=[...state.prepared.issues,...state.prepared.warnings];$("[data-warnings]").textContent=warnings.join("\n");$("[data-warnings]").classList.toggle("hide",!warnings.length);
      if(close) {
        const start=dateStart(close);$("[data-period]").textContent=`結單日 ${close} → 期限 ${taipei(start+4*DAY-1)}（台北時間）；${dateValue(start+4*DAY)} 起為逾期查詢。`;
        if(!state.lowerDirty) {
          const dates=state.entries.filter(e=>!e.error).map(e=>sheetDate(e.eventRaw,close)).filter(Boolean).sort();
          $("[data-lower]").value=dates[0]||"";
        }
      } else $("[data-period]").textContent="";
      buttons();
    }
    const bytesById=new Map();
    $("[data-files]").addEventListener("change",async event=>{
      const fileInput=event.target,files=[...fileInput.files];
      invalidate("正在讀取發送表……");state.importing=true;dockBegin("import");buttons();const token=runs.begin();
      try {
        const added=[];
        for(const file of files) {
          const id=`file-${++state.sequence}`;
          try {ensure(/\.xlsx$/i.test(file.name),"WORKBOOK","請選xlsx發送表");const bytes=await file.arrayBuffer();const entry=await importBook(bytes,file.name,id,false);bytesById.set(id,bytes);added.push(entry);}
          catch(e){added.push({id,name:file.name,error:e.message});}
        }
        if(!runs.valid(token))return;
        state.entries.push(...added);state.choices={};$("[data-lower-confirm]").checked=false;render();status(added.some(e=>e.error)?"有檔案讀不到，請移除錯誤檔並重新匯入。":"已讀取發送表，請核對來源、費率與起點。",added.some(e=>e.error));
      } finally {state.importing=false;dock.setBadge({running:false});fileInput.value="";buttons();}
    });
    $("[data-files-list]").addEventListener("click",event=>{
      const id=event.target.closest("[data-remove]")?.dataset.remove;if(!id)return;
      invalidate();state.entries=state.entries.filter(e=>e.id!==id);bytesById.delete(id);state.choices={};$("[data-lower-confirm]").checked=false;render();
    });
    $("[data-files-list]").addEventListener("input",event=>{if(event.target.matches("[data-session]"))invalidate();});
    $("[data-files-list]").addEventListener("change",async event=>{
      const entry=state.entries.find(e=>e.id===(event.target.dataset.session||event.target.dataset.fee));if(!entry)return;
      invalidate();state.choices={};$("[data-lower-confirm]").checked=false;
      if(event.target.matches("[data-session]")){entry.sessionOverride=event.target.value;render();return;}
      state.importing=true;dockBegin("import");buttons();const token=runs.begin();
      try {const updated=await importBook(bytesById.get(entry.id),entry.name,entry.id,event.target.checked);if(runs.valid(token)){Object.assign(entry,updated);render();}}
      catch(e){if(runs.valid(token)){entry.error=e.message;render();status(e.message,true);}}
      finally{state.importing=false;dock.setBadge({running:false});buttons();}
    });
    $("[data-conflicts]").addEventListener("change",e=>{invalidate();state.choices[e.target.dataset.choice]=e.target.value;render();});
    for(const selector of ["[data-closing]","[data-lower]","[data-whitelist]"]) $(selector).addEventListener("input",()=>{
      invalidate();$("[data-lower-confirm]").checked=false;if(selector==="[data-lower]")state.lowerDirty=true;render();
    });
    $("[data-lower-confirm]").addEventListener("change",()=>invalidate());
    function table(rows) {return `<table><thead><tr>${["分類","帳號","場次來源","明細","期間內有效","期間內待核","差額／多付","最後下單（台北）","備註"].map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.label)}</td><td>${esc(r.account)}</td><td>${r.sources.map(s=>esc(`${s.file}／${s.event||"日期未知"}／${s.session}`)).join("<br>")}</td><td>${r.due}</td><td>${r.money}</td><td>${r.pendingMoney}</td><td>${r.shortfall}／${r.overpaid}</td><td>${esc(taipei(r.last))}</td><td class="note">${esc(r.notes.join("；"))}</td></tr>`).join("")}</tbody></table>`;}
    function showResult(result) {
      $("[data-result]").classList.remove("hide");$("[data-banner]").textContent=result.title;$("[data-banner]").classList.toggle("reminder",result.window.reminder);
      $("[data-counts]").textContent=`共 ${result.rows.length}位；`+Object.entries(result.summary).map(([k,n])=>`${LABELS[k]} ${n}`).join("、")+`。${result.meta.completeness}`;
      $("[data-categories]").innerHTML=Object.entries(LABELS).filter(([k])=>k!=="settled"&&result.summary[k]).map(([k,label])=>`<label><input data-category value="${k}" type="checkbox">${label}（${result.summary[k]}）</label>`).join("");
      $("[data-table]").innerHTML=table(result.rows.filter(r=>r.category!=="settled"));$("[data-settled]").innerHTML=table(result.rows.filter(r=>r.category==="settled"));$("[data-settled-title]").textContent=`已結單（${result.summary.settled||0}位）`;buttons();
    }
    $("[data-categories]").addEventListener("change",buttons);
    $("[data-start]").addEventListener("click",async()=>{
      if(state.running||state.importing)return;
      invalidate("正在核對輸入……");let token;
      try {
        ensure(location.pathname==="/portal/sale/order","PAGE","請回到我的銷售訂單清單");
        render();ensure(!state.prepared.issues.length,"INPUT",state.prepared.issues.join("\n"));ensure($("[data-lower-confirm]").checked,"INPUT","請勾選確認查詢起點與推定年份");
        const w=makeWindow(closing(),$("[data-lower]").value),whitelist=parseWhitelist($("[data-whitelist]").value);cookieToken(document.cookie);
        token=runs.begin();state.activeRun=token;state.running=true;dockBegin("query");buttons();status("開始讀取訂單，第1遍……");
        const api=createApi({signal:token.signal});
        const result=await reconcile(api,state.prepared.buyers,w,whitelist,token.signal,p=>{if(runs.valid(token))status(`第${p.phase}遍／第${p.page}頁：已讀${p.indexCount}筆（${p.unique}個ID），讀到${taipei(p.oldest)}`);});
        result.meta.whitelist=[...whitelist];result.meta.selections=state.prepared.selections;
        runs.publish(token,result);showResult(result);dock.setBadge({running:false,outcome:"complete"});status("讀取完成；兩遍固定區間ID一致。請逐位核對後選類別複製或匯出。");
      } catch(e) {if(!token||runs.valid(token)){runs.invalidate();$("[data-result]").classList.add("hide");status(`沒有讀完，不能用：${e.message}`,true);}}
      finally {if(state.activeRun===token){state.running=false;state.activeRun=null;}dock.setBadge({running:state.running||state.importing});buttons();}
    });
    $("[data-stop]").addEventListener("click",()=>invalidate("已停止，這輪結果作廢。"));
    $("[data-copy]").addEventListener("click",async()=>{
      try {const selected=new Set([...root.querySelectorAll("[data-category]:checked")].map(e=>e.value));ensure(selected.size,"INPUT","請先選要複製的類別");const result=runs.result;const value=copyAccounts(result,selected);await navigator.clipboard.writeText(value);ensure(result===runs.result,"STALE","結果已失效");status(`已複製${value?value.split("\n").length:0}個帳號。`);}catch(e){status(e.message,true);}
    });
    $("[data-export]").addEventListener("click",async()=>{
      try {const result=runs.result,wb=exportBook(result);const bytes=await wb.xlsx.writeBuffer();ensure(result&&result===runs.result,"STALE","結果已失效，未匯出");const url=URL.createObjectURL(new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));downloadUrls.add(url);const a=document.createElement("a");a.href=url;a.download=`${result.window.reminder?"提醒名單":"逾期名單"}_${result.window.closing}_未結標核對.xlsx`;a.click();setTimeout(()=>{downloadUrls.delete(url);URL.revokeObjectURL(url);},1000);}catch(e){status(e.message,true);}
    });
    
    const positionKey="unsettled:panel-position:v1";
    function place(p) {if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))return;host.style.right="auto";host.style.left=Math.max(0,Math.min(p.x,innerWidth-70))+"px";host.style.top=Math.max(0,Math.min(p.y,innerHeight-45))+"px";}
    try{if(typeof GM_getValue==="function")place(GM_getValue(positionKey,null));}catch{}
    let drag=null;$("header").addEventListener("pointerdown",e=>{if(e.target.closest("button"))return;const rect=host.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:rect.left,top:rect.top};$("header").setPointerCapture(e.pointerId);});
    $("header").addEventListener("pointermove",e=>{if(drag)place({x:drag.left+e.clientX-drag.x,y:drag.top+e.clientY-drag.y});});
    $("header").addEventListener("pointerup",()=>{if(!drag)return;drag=null;if(typeof GM_setValue==="function"){const r=host.getBoundingClientRect();GM_setValue(positionKey,{x:r.left,y:r.top});}});
    if(typeof GM_registerMenuCommand==="function")GM_registerMenuCommand("重設未結標查詢面板位置",()=>{place({x:Math.max(10,innerWidth-800),y:90});if(typeof GM_setValue==="function")GM_setValue(positionKey,{x:Math.max(10,innerWidth-800),y:90});});
    function routeChanged() {
      const list=orderListSignature();
      if(location.href!==currentUrl){currentUrl=location.href;invalidate("頁面已切換，舊結果作廢。");}
      else if(list!==currentOrderList&&(state.running||runs.result))invalidate("訂單清單已切換，舊結果作廢。");
      currentOrderList=list;
      const supported=location.pathname==="/portal/sale/order";host.style.display=supported?"":"none";dock.host.style.setProperty("display",supported?"block":"none","important");
    }
    addEventListener("popstate",routeChanged);addEventListener("hashchange",routeChanged);addEventListener("pagehide",()=>invalidate("頁面已離開，查詢停止。"));
    window.navigation?.addEventListener("navigate",event=>{if(!downloadUrls.has(event.destination.url))invalidate("頁面正在切換，查詢停止。");});
    setInterval(routeChanged,200);
    document.addEventListener("click",e=>{
      if(e.composedPath().includes(host)||!(state.running||runs.result))return;
      const target=e.target instanceof Element?e.target:e.target?.parentElement;
      if(target?.closest('a[href],[role="tab"]'))invalidate("你正在切換頁面或頁籤，本輪及舊結果作廢，請重新查詢。");
    },true);
    render();
  }
  const api={VERSION,DetailCore,LABELS,PATHS,dateStart,dateValue,taipei,makeWindow,sheetDate,importBook,prepare,choiceKey,parseOrder,parseWhitelist,classify,identityMap,buildResult,copyAccounts,cookieToken,createApi,parseSentinel,scan,reconcile,runState,exportBook,scheduler,mount};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(typeof window!=="undefined"&&typeof document!=="undefined")mount();

})();
