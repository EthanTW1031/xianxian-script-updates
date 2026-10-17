// ==UserScript==
// @name         Shopee 帳號預檢
// @namespace    local.shopee.account-precheck
// @version      0.3.5
// @description  搜尋帳號與封鎖旗標，不發訊息；搜尋結果沒有封鎖欄位時才點進對話看封鎖；無損分開匯出預檢通過與待處理 CSV
// @match        https://seller.shopee.tw/new-webchat/conversations*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

// Isolated candidate; Ethan authorized implementation on 2026-10-14.
// Requirements v0.7.
// 0.3.2 (2026-10-16): search-scope menu options on the real chat page are div elements; Ethan asked Claude to fix directly.
// 0.3.3 (2026-10-16): when the buyer search result has no blocked flag, open that chat to read it (Ethan chose 甲); only accept the scope search box.
// 0.3.5 (2026-10-17): when the chat page never loads its search data, tell staff to reload the page (F5) instead of waiting; Ethan asked Claude to change it directly.

(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // src/util.cjs
  var require_util = __commonJS({
    "src/util.cjs"(exports, module) {
      "use strict";
      var TaskError = class extends Error {
        constructor(code, message) {
          super(message);
          this.name = "TaskError";
          this.code = code;
        }
      };
      var problem = (code, message) => new TaskError(code, message);
      var norm = (value) => String(value ?? "").normalize("NFKC").replace(/\uFEFF/gu, "").replace(/\s+/gu, " ").trim();
      var ordinal = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
      var decimal = (value) => typeof value === "string" && /^[0-9]+$/u.test(value) && BigInt(value) > 0n;
      var safeUid = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      var compareIds = (a, b) => {
        if (!decimal(a) || !decimal(b)) throw problem("DATA", "訊息編號不是完整數字文字，已停止。");
        return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
      };
      function clone(value) {
        if (value === null || value === void 0 || ["string", "number", "boolean"].includes(typeof value)) return value;
        if (Array.isArray(value)) return value.map(clone);
        if (typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]") throw problem("RECORDS", "紀錄含有不支援的資料，請保留紀錄並請人協助。");
        const out = {};
        for (const key of Object.keys(value)) Object.defineProperty(out, key, { value: clone(value[key]), writable: true, enumerable: true, configurable: true });
        return out;
      }
      function canonical(value) {
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort(ordinal).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
        if (value === void 0) return '"__undefined__"';
        return JSON.stringify(value);
      }
      async function sha256(bytes) {
        if (!globalThis.crypto?.subtle) throw problem("CRYPTO", "瀏覽器無法核對檔案，請使用新版 Chrome／Edge。");
        const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
        const hash = await crypto.subtle.digest("SHA-256", input);
        return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      var safeMessage = (error) => error instanceof TaskError ? error.message : "讀取失敗，已停止；請保留原檔並請人協助。";
      module.exports = { TaskError, problem, norm, ordinal, decimal, safeUid, compareIds, clone, canonical, sha256, safeMessage };
    }
  });

  // src/precheck-core.cjs
  var require_precheck_core = __commonJS({
    "src/precheck-core.cjs"(exports, module) {
      "use strict";
      var { problem, norm, clone } = require_util();
      var HEADERS = Object.freeze(["擷取時間", "直播Session", "限定時段序號", "留言ID", "買家UID", "買家帳號", "原始留言", "正規化留言", "商品代號", "品名", "規格尺寸", "數量", "價格", "狀態", "待確認", "來源", "喊單則數", "彙總件數"]);
      function effectiveBuyerText(value) {
        if (value == null) return { ok: true, text: "" };
        if (typeof value === "string") return { ok: true, text: value };
        if (typeof value !== "object" || Object.prototype.toString.call(value) === "[object Date]") return { ok: false, text: "" };
        if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) return { ok: typeof value.result === "string", text: typeof value.result === "string" ? value.result : "" };
        if (typeof value.text === "string") return { ok: true, text: value.text };
        if (Array.isArray(value.richText) && value.richText.every((part) => typeof part?.text === "string")) return { ok: true, text: value.richText.map((part) => part.text).join("") };
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
        const accounts = lines.map((line) => validateBuyerAccount(line));
        if (accounts.some((account) => !account.ok || /\s/u.test(account.text))) throw problem("BLACKLIST", "黑名單請每行填一個完整買家帳號，不可使用日期、科學記號或含空白的帳號。");
        return [...new Set(accounts.map((account) => account.text).filter(Boolean))];
      }
      function splitCsv(text) {
        const source = String(text).replace(/^\uFEFF/u, ""), records = [];
        let fields = [], field = "", quoted = false, start = 0;
        function push(end, ending = "") {
          fields.push(field.replace(/\r$/u, ""));
          records.push({ raw: source.slice(start, end), ending, fields, row: records.length + 1 });
          fields = [];
          field = "";
        }
        for (let i = 0; i < source.length; i++) {
          const ch = source[i];
          if (quoted) {
            if (ch === '"' && source[i + 1] === '"') {
              field += '"';
              i++;
            } else if (ch === '"') quoted = false;
            else field += ch;
          } else if (ch === '"') quoted = true;
          else if (ch === ",") {
            fields.push(field);
            field = "";
          } else if (ch === "\n") {
            const end = i > start && source[i - 1] === "\r" ? i - 1 : i;
            push(end, source.slice(end, i + 1));
            start = i + 1;
          } else field += ch;
        }
        if (quoted) throw problem("CSV_QUOTE", "直播 CSV 有未閉合的雙引號，請使用抓單匯出的原檔。");
        if (start < source.length) push(source.length);
        return records;
      }
      var blankRecord = (record) => !record.fields.some((cell) => String(cell).trim());
      function parseSource(buffer, filename) {
        if (!/\.csv$/iu.test(filename) || filename.startsWith("~$")) throw problem("FILE", "請選擇 .csv 直播原始檔，勿選 Excel 暫存鎖定檔。");
        const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer);
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw problem("UTF8", "檔案不是合法的 UTF-8，可能被 Excel 另存過，請用抓單匯出的原檔。");
        }
        const records = splitCsv(text);
        if (!records.length) throw problem("EMPTY", "檔案是空的，請選擇抓單匯出的原檔。");
        const actual = records[0].fields.map((value) => value.trim());
        if (![HEADERS.length, HEADERS.length + 1].includes(actual.length) || HEADERS.some((value, i) => actual[i] !== value) || actual.length === HEADERS.length + 1 && actual.at(-1) !== "喊單歷程") throw problem("HEADERS", `表頭必須是直播固定 18 欄，或在其後加第 19 欄「喊單歷程」，且順序相同。實際表頭：${actual.join("｜") || "（空白）"}`);
        let sourceRows = 0, inactiveRows = 0, emptyAccountRows = 0;
        const active = /* @__PURE__ */ new Set(), rowCounts = /* @__PURE__ */ new Map(), issues = [];
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
        entry.hash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return entry;
      }
      function batchId(hash, round) {
        return `precheck:${hash}:${round}`;
      }
      function recordKey(scope, account) {
        return JSON.stringify([scope, account]);
      }
      function recordState(records, scope, account) {
        return records[recordKey(scope, account)]?.status || "ready";
      }
      function pruneFiles(files, records, entry) {
        const prior = files.entries.find((file) => file.hash === entry.hash);
        const updated = { hash: entry.hash, round: prior?.round || 0, name: entry.name, usedAt: (/* @__PURE__ */ new Date()).toISOString() };
        const entries = [updated, ...files.entries.filter((file) => file.hash !== entry.hash)].slice(0, 20);
        const retained = new Set(entries.map((file) => file.hash)), nextRecords = {};
        for (const [key, record] of Object.entries(records)) {
          const hash = /^precheck:([a-f0-9]{64}):\d+$/u.exec(record.batchId)?.[1];
          if (retained.has(hash)) nextRecords[key] = record;
        }
        return { files: { ...files, entries }, records: nextRecords, round: updated.round };
      }
      function toCsv(rows) {
        return "\uFEFF" + rows.map((row, rowIndex) => row.map((value, colIndex) => {
          let text = String(value ?? "");
          if (rowIndex > 0 && colIndex === 0) text = `="${text.replace(/"/gu, '""')}"`;
          else if (/^[=+@\-\t\r]/u.test(text)) text = `'${text}`;
          return `"${text.replace(/"/gu, '""')}"`;
        }).join(",")).join("\r\n");
      }
      var LEGACY_LABELS = Object.freeze({ ready: "還沒查", sent: "已送出（舊）", manualSent: "已人工送出（舊）", blocked: "黑名單排除", searchUnconfirmed: "搜尋未確認", notFound: "搜尋未確認（舊）", pending: "舊的可能已送出，待重新查", draft: "舊的有草稿，待重新查", failed: "失敗，可再查" });
      var LABELS = Object.freeze({ ...LEGACY_LABELS, found: "找得到，留", chatBlocked: "聊聊已封鎖" });
      var RETRYABLE = Object.freeze(["ready", "failed", "pending", "draft"]);
      function itemState(queue, records, item) {
        return queue.blacklist?.includes(item.account) ? "blocked" : recordState(records, queue.batchId, item.account);
      }
      function buildQueue(entry, _unused = null, round = 0, blacklist = []) {
        return { batchId: batchId(entry.hash, round), blacklist: parseBlacklist(blacklist), items: entry.accounts.map((account) => ({ account, rowCount: entry.rowCounts.get(account) || 0 })) };
      }
      function runnableItems(queue, records) {
        return queue.items.filter((i) => RETRYABLE.includes(itemState(queue, records, i)));
      }
      function bucket(queue, records, item) {
        const state = itemState(queue, records, item), r = records[recordKey(queue.batchId, item.account)];
        if (state === "blocked") return "blacklist";
        if (state === "chatBlocked") return "chatBlocked";
        if (state === "found") return "found";
        if (state === "manualSent") return r?.code === "MANUAL_FOUND" ? "manualFound" : "legacySent";
        if (state === "sent") return "legacySent";
        if (["notFound", "searchUnconfirmed"].includes(state)) return "searchUnconfirmed";
        if (RETRYABLE.includes(state)) return "unchecked";
        throw problem("RECORDS", "預檢紀錄狀態不支援，已停止。");
      }
      function displayLabel(queue, records, item) {
        return itemState(queue, records, item) === "manualSent" && records[recordKey(queue.batchId, item.account)]?.code === "MANUAL_FOUND" ? "人工確認找得到" : LABELS[itemState(queue, records, item)];
      }
      function countsFor(queue, records) {
        const out = Object.fromEntries(Object.keys(LABELS).map((k) => [k, 0]));
        for (const i of queue.items) out[itemState(queue, records, i)]++;
        return out;
      }
      function summary(queue, records) {
        const out = { found: 0, manualFound: 0, legacySent: 0, chatBlocked: 0, searchUnconfirmed: 0, blacklist: 0, unchecked: 0 };
        for (const i of queue.items) out[bucket(queue, records, i)]++;
        out.total = queue.items.length;
        out.accepted = out.found + out.manualFound + out.legacySent;
        out.completed = out.total - out.unchecked;
        return out;
      }
      function summaryText(s) {
        return `找得到 ${s.found} 位、人工確認找得到 ${s.manualFound} 位、舊紀錄已送出 ${s.legacySent} 位、聊聊已封鎖 ${s.chatBlocked} 位、搜尋未確認 ${s.searchUnconfirmed} 位、黑名單 ${s.blacklist} 位、還沒查 ${s.unchecked} 位。`;
      }
      function streakWarning(queue, records) {
        let n = 0, max = 0;
        for (const i of queue.items) {
          n = bucket(queue, records, i) === "searchUnconfirmed" ? n + 1 : 0;
          max = Math.max(n, max);
        }
        return max >= 3 ? `有 ${max} 位連續搜尋未確認，請核對網路與搜尋畫面，再決定手動重查。` : "";
      }
      function listCsv(queue, records) {
        const priority = { blacklist: 0, chatBlocked: 0, searchUnconfirmed: 1, unchecked: 2, found: 3, manualFound: 3, legacySent: 3 };
        const items = [...queue.items].sort((a, b) => priority[bucket(queue, records, a)] - priority[bucket(queue, records, b)]);
        return toCsv([["買家帳號", "這位在檔裡有幾列", "狀態", "說明", "時間"], ...items.map((i) => {
          const r = records[recordKey(queue.batchId, i.account)];
          return [i.account, i.rowCount, displayLabel(queue, records, i), itemState(queue, records, i) === "blocked" ? "本腳本黑名單排除" : r?.detail || "", r?.time || ""];
        })]);
      }
      function exportPartition(entry, queue, records, pendingOnly = false) {
        if (!queue.items.length) throw problem("QUEUE", "檔案沒有可預檢的買家。");
        const s = summary(queue, records), excluded = new Set(queue.blacklist || []), accepted = /* @__PURE__ */ new Set();
        for (const i of queue.items) {
          const b = bucket(queue, records, i);
          if (["blacklist", "chatBlocked"].includes(b)) excluded.add(i.account);
          if (["found", "manualFound", "legacySent"].includes(b)) accepted.add(i.account);
        }
        const select = (r) => !excluded.has(r.account) && (pendingOnly ? !accepted.has(r.account) : accepted.has(r.account));
        const kept = entry.records.filter((r, index) => index === 0 || blankRecord(r) || select(r));
        if (!kept.slice(1).some((r) => !blankRecord(r))) throw problem(pendingOnly ? "NO_PENDING" : "NO_CONFIRMED", pendingOnly ? "沒有待處理資料。" : "沒有預檢通過的買家，不能產生叫貨用檔。");
        const removedRows = entry.records.length - kept.length, text = removedRows ? (entry.bom ? "\uFEFF" : "") + kept.map((r) => r.raw + r.ending).join("") : entry.text;
        const check = splitCsv(text);
        if (check.length !== kept.length || check.some((r, i) => r.raw !== kept[i].raw || r.ending !== kept[i].ending || i > 0 && !blankRecord(r) && !select({ account: validateBuyerAccount(r.fields[5]).text }))) throw problem("EXPORT_CHECK", "匯出自我檢查未通過，沒有下載；請保留原檔。");
        const excludedRows = entry.records.filter((r) => excluded.has(r.account)).length;
        const confirmation = [pendingOnly ? "這是待處理直播檔，請勿拿來叫貨。" : "這是預檢通過的直播檔，供控貨助手建立新場次。", summaryText(s), `排除 ${excludedRows} 列；此檔保留 ${kept.slice(1).filter((r) => !blankRecord(r)).length} 列。原檔不修改。`, s.unchecked ? "還沒查完；後續查完須重新匯出，並用新檔另建場次。" : "", streakWarning(queue, records), "確定匯出？"].filter(Boolean).join("\n");
        return { text, bytes: removedRows ? new TextEncoder().encode(text) : entry.bytes, filename: entry.name.replace(/\.csv$/iu, "") + (pendingOnly ? "_待處理.csv" : "_預檢通過.csv"), confirmation, removedRows };
      }
      var filteredExport = (e, q, r) => exportPartition(e, q, r);
      var pendingExport = (e, q, r) => exportPartition(e, q, r, true);
      module.exports = { HEADERS, LEGACY_LABELS, LABELS, RETRYABLE, validateBuyerAccount, parseBlacklist, splitCsv, parseSource, readSource, batchId, recordKey, recordState, itemState, buildQueue, runnableItems, countsFor, summary, summaryText, streakWarning, pruneFiles, toCsv, listCsv, filteredExport, pendingExport, exportPartition, displayLabel, blankRecord };
    }
  });

  // src/precheck-storage.cjs
  var require_precheck_storage = __commonJS({
    "src/precheck-storage.cjs"(exports, module) {
      "use strict";
      var { problem, clone, canonical, sha256 } = require_util();
      var core2 = require_precheck_core();
      var STORE = Object.freeze({ records: "precheck:records:v2", files: "precheck:files:v2", migration: "precheck:migration:v2", legacyRecords: "precheck:records:v1", legacyFiles: "precheck:files:v1", blacklist: "precheck:blacklist:v1", panelPosition: "precheck:panel-position:v1" });
      var emptyFiles = () => ({ entries: [], last: null });
      function validateRecords(records, legacy = false) {
        const labels = legacy ? core2.LEGACY_LABELS : core2.LABELS;
        if (!records || typeof records !== "object" || Array.isArray(records)) throw problem("RECORDS", "預檢紀錄格式有問題，請保留紀錄並請人協助。");
        for (const [key, r] of Object.entries(records)) if (!r || typeof r.account !== "string" || typeof r.batchId !== "string" || !Object.hasOwn(labels, r.status) || r.status === "ready" || key !== core2.recordKey(r.batchId, r.account)) throw problem("RECORDS", "預檢紀錄身分或狀態不正確，已停止。");
        return records;
      }
      function validateFiles(files) {
        if (!files || typeof files !== "object" || !Array.isArray(files.entries) || files.entries.some((f) => !f || !/^[a-f0-9]{64}$/u.test(f.hash) || !Number.isSafeInteger(f.round) || f.round < 0) || new Set(files.entries.map((f) => f.hash)).size !== files.entries.length) throw problem("RECORDS", "預檢檔案紀錄不正確，請保留紀錄並請人協助。");
        return files;
      }
      function createRepository(gm) {
        const get = async (k, d) => clone(await gm.get(k, d)), set = async (k, v) => {
          try {
            await gm.set(k, clone(v));
          } catch {
            throw problem("STORAGE", "紀錄無法保存，已停止；請保留頁面與原檔。");
          }
        };
        async function read() {
          return { records: validateRecords(await get(STORE.records)), files: validateFiles(await get(STORE.files)) };
        }
        async function migrate() {
          let journal = await get(STORE.migration);
          if (journal?.phase === "ready") return read();
          if (journal && journal.phase !== "pending") throw problem("RECORDS", "遷移標記格式不正確，已停止。");
          if (!journal) {
            if (await get(STORE.records) !== void 0 || await get(STORE.files) !== void 0) throw problem("RECORDS", "新版紀錄只有部分資料且沒有遷移證據，已停止，請勿清紀錄重跑。");
            const bundle = { records: validateRecords(await get(STORE.legacyRecords, {}), true), files: validateFiles(await get(STORE.legacyFiles, emptyFiles())) };
            journal = { phase: "pending", bundle, hash: await sha256(canonical(bundle)), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
            await set(STORE.migration, journal);
          }
          validateRecords(journal.bundle?.records, true);
          validateFiles(journal.bundle?.files);
          if (await sha256(canonical(journal.bundle)) !== journal.hash) throw problem("RECORDS", "遷移快照核對失敗，已停止；舊版紀錄保留。");
          await set(STORE.records, journal.bundle.records);
          await set(STORE.files, journal.bundle.files);
          const checked = await read();
          if (canonical(checked) !== canonical(journal.bundle)) throw problem("STORAGE", "新紀錄回讀不一致，遷移未完成，請保留紀錄。");
          await set(STORE.migration, { phase: "ready", sourceHash: journal.hash, completedAt: (/* @__PURE__ */ new Date()).toISOString() });
          return checked;
        }
        async function importEntry(entry) {
          const { files, records } = await read();
          const next = core2.pruneFiles(files, records, entry);
          await set(STORE.records, next.records);
          await set(STORE.files, next.files);
          return next;
        }
        async function assertBatch(queue, hash) {
          const value = await read();
          if (value.files.entries.find((f) => f.hash === hash)?.round !== Number(queue.batchId.split(":").at(-1))) throw problem("FILE_CHANGED", "另一分頁已重設或移除本檔，請重新匯入原檔再核對。");
          return value;
        }
        async function write(queue, entry, item, status, code, detail) {
          const value = await assertBatch(queue, entry.hash);
          if (!Object.hasOwn(core2.LABELS, status) || status === "ready") throw problem("RECORDS", "不支援的檢查結果。");
          value.records[core2.recordKey(queue.batchId, item.account)] = { account: item.account, batchId: queue.batchId, status, code, detail, time: (/* @__PURE__ */ new Date()).toISOString() };
          await set(STORE.records, value.records);
          await updateLast(queue, entry);
          return value.records;
        }
        async function updateLast(queue, entry) {
          const value = await assertBatch(queue, entry.hash), s = core2.summary(queue, value.records);
          value.files.last = { name: entry.name, hash: entry.hash, total: s.total, completed: s.completed, progressVersion: 2, time: (/* @__PURE__ */ new Date()).toISOString() };
          await set(STORE.files, value.files);
          return s;
        }
        async function recheck(queue, entry, all) {
          const value = await assertBatch(queue, entry.hash);
          if (all) {
            const file = value.files.entries.find((f) => f.hash === entry.hash);
            file.round++;
            await set(STORE.files, value.files);
            return file.round;
          }
          for (const item of queue.items) if (["notFound", "searchUnconfirmed"].includes(core2.itemState(queue, value.records, item))) delete value.records[core2.recordKey(queue.batchId, item.account)];
          await set(STORE.records, value.records);
          await updateLast(queue, entry);
          return Number(queue.batchId.split(":").at(-1));
        }
        return { get, set, read, migrate, importEntry, assertBatch, write, updateLast, recheck };
      }
      module.exports = { STORE, emptyFiles, validateRecords, validateFiles, createRepository };
    }
  });

  // src/chat-runtime.cjs
  var require_chat_runtime = __commonJS({
    "src/chat-runtime.cjs"(exports, module) {
      "use strict";
      var { problem, norm, decimal, safeUid, compareIds, canonical } = require_util();
      var LOCK_NAME = "shopee-settlement-notice:send";
      var PANELS = "[data-account-precheck],[data-settlement-notice],[data-winlist-shopee],[data-replay-add-order]";
      var LIMITS = Object.freeze({ root: 3e4, query: 15e3, page: 15e3, conversation: 1e4, scope: 2e4, poll: 200 });
      function visible(el) {
        if (!el) return false;
        const style = getComputedStyle(el), r = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && r.width > 0 && r.height > 0;
      }
      function safe(stop) {
        if (stop?.()) throw problem("STOP", "已停止。");
        if (navigator.onLine === false) throw problem("NETWORK", "目前沒有網路，已停止；請等網路恢復後重跑。");
        const selectors = ['iframe[src*="captcha" i]', 'iframe[src*="challenge" i]', 'iframe[title*="captcha" i]', '[class*="captcha" i]', '[id*="captcha" i]'];
        if (selectors.some((s) => [...document.querySelectorAll(s)].some((e) => visible(e) && !e.closest(PANELS)))) throw problem("SECURITY_CHALLENGE", "偵測到拼圖／安全驗證，已停止，請人工處理。");
        if ([...document.querySelectorAll('[role="dialog"],[class*="modal" i]')].some((e) => visible(e) && !e.closest(PANELS) && /拼圖驗證|完成拼圖|安全驗證|請驗證|captcha|security challenge/iu.test(norm(e.textContent)))) throw problem("SECURITY_CHALLENGE", "偵測到安全驗證，已停止。");
        const other = document.querySelector('[data-winlist-shopee="1"]')?.shadowRoot?.querySelector("[data-stop]");
        if (other && !other.classList.contains("wl-hidden") && visible(other)) throw problem("OTHER_SENDER", "明細正在發送，已停止；請先停止明細再操作。");
      }
      async function withLock(action) {
        if (!navigator.locks?.request) throw problem("LOCK", "瀏覽器不支援共用鎖，請使用新版 Chrome／Edge。");
        return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) throw problem("LOCK", "結單通知、回放或另一個預檢正在執行，請等它完成。");
          return action();
        });
      }
      async function sleep(ms, stop) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          safe(stop);
          await new Promise((r) => setTimeout(r, Math.min(LIMITS.poll, until - Date.now())));
        }
      }
      async function wait(predicate, ms, stop, code = "READ_FAILED", message = "讀取逾時／未讀完，已停止。") {
        const until = Date.now() + ms;
        do {
          safe(stop);
          const value = predicate();
          if (value) return value;
          await new Promise((r) => setTimeout(r, LIMITS.poll));
        } while (Date.now() < until);
        safe(stop);
        throw problem(code, message);
      }
      function inputElement() {
        const entries = [...document.querySelectorAll('input[placeholder*="搜尋"]')].filter((e) => SCOPE_MENU_LABELS.includes(e.placeholder) && visible(e) && !e.closest(PANELS));
        if (entries.length !== 1) throw problem("SEARCH_INPUT", "找不到唯一的聊聊搜尋框，已停止；請確認頁面正常。");
        return entries[0];
      }
      function nativeSearchValue(input, text) {
        if (!document.contains(input) || !visible(input)) throw problem("SEARCH_INPUT", "搜尋框已被替換，已停止。");
        input.focus();
        if (document.activeElement !== input) throw problem("FOCUS", "焦點不在搜尋框，已停止。");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      function activate(el) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = el.getBoundingClientRect(), clientX = r.left + r.width * 0.5, clientY = r.top + r.height * 0.5, top = document.elementFromPoint(clientX, clientY), target = top && (el.contains(top) || top.contains(el)) ? top : el;
        const mouse = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1, detail: 1 }, pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0.5 };
        target.focus?.();
        const P = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        for (const [name, C, init] of [["pointerover", P, pointer], ["mouseover", MouseEvent, mouse], ["pointerdown", P, pointer], ["mousedown", MouseEvent, mouse], ["pointerup", P, { ...pointer, buttons: 0 }], ["mouseup", MouseEvent, { ...mouse, buttons: 0 }], ["click", MouseEvent, { ...mouse, buttons: 0 }]]) target.dispatchEvent(new C(name, init));
      }
      function fiberOf(node) {
        const key = Object.keys(node || {}).find((k) => k.startsWith("__reactFiber$"));
        return key ? node[key] : null;
      }
      function findStore(input = inputElement()) {
        let node = input;
        for (let n = 0; node && n < 12; n++, node = node.parentElement) {
          let fiber = fiberOf(node);
          for (let d = 0; fiber && d < 200; d++, fiber = fiber.return) {
            const p = fiber.memoizedProps, s = p?.store || p?.value?.store;
            if (s && typeof s.getState === "function" && typeof s.subscribe === "function") {
              const state = s.getState();
              if (state && typeof state === "object" && (state.searchReducer || state.entityReducer)) return s;
            }
          }
        }
        return null;
      }
      function object(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
      }
      function rootStatus(state, replay = false) {
        const search = state?.searchReducer;
        if (search !== void 0 && !object(search)) return "invalid";
        const sr = search?.searchResult, p = search?.pagination;
        const required = [sr?.user, p?.user];
        if (replay) required.push(state?.messageReducer?.messagesRelatedMap, state?.entityReducer, state?.conversationReducer);
        if (required.some((v) => v === void 0)) return "waiting";
        if (required.some((v) => !object(v))) return "invalid";
        if (typeof sr.user.status !== "string" || !Array.isArray(sr.user.results) || typeof p.user.hasMore !== "boolean") return "invalid";
        return "ready";
      }
      function searchFrame(store, branch) {
        const s = store.getState()?.searchReducer;
        if (!object(s) || typeof s.keyword !== "string" || !["string", "number"].includes(typeof s.searchFilter)) throw problem("DATA", "搜尋資料格式不符合預期，已停止。");
        const b = s.searchResult?.[branch], p = s.pagination?.[branch];
        if (!b) return { keyword: s.keyword, filter: s.searchFilter, branch: null };
        if (!object(b) || typeof b.status !== "string" || !Array.isArray(b.results) || !object(p) || typeof p.hasMore !== "boolean") throw problem("DATA", "搜尋結果或分頁資料格式不符合預期，已停止。");
        return { keyword: s.keyword, filter: s.searchFilter, branch: { status: b.status, results: b.results, hasMore: p.hasMore } };
      }
      function projectResults(results, branch) {
        return results.map((r) => {
          if (!object(r)) throw problem("DATA", "搜尋結果項目格式異常，已停止。");
          if (branch === "user") {
            if (typeof r.to_name !== "string" || !r.to_name.trim()) throw problem("DATA", "搜尋結果帳號欄位格式異常，已停止。");
            return { id: typeof r.id === "string" ? r.id : null, to_name: r.to_name, to_id: typeof r.to_id === "number" ? r.to_id : null, is_blocked: typeof r.is_blocked === "boolean" ? r.is_blocked : null };
          }
          return { message_id: r.message_id, message_nano_time: r.message_nano_time, message_time: r.message_time, text: r.text, to_id: r.to_id, to_name: r.to_name, conversation_id: r.conversation_id };
        });
      }
      function classifyUser(results, account) {
        const exact = results.filter((r2) => r2.to_name === account);
        if (exact.length === 0) return { status: "searchUnconfirmed", code: "NO_EXACT_MATCH", detail: results.length ? `有 ${results.length} 筆部分相符、沒有完全相同。` : "搜尋結果 0 筆。" };
        if (exact.length !== 1) return { status: "searchUnconfirmed", code: "AMBIGUOUS", detail: "找到不只一筆完全相同的帳號，請人工核對。" };
        const r = exact[0];
        if (!decimal(r.id) || !safeUid(r.to_id) || typeof r.is_blocked !== "boolean") return { status: "searchUnconfirmed", code: "IDENTITY_INVALID", detail: "買家身分或封鎖旗標無法確認，請人工核對。" };
        return { status: r.is_blocked ? "chatBlocked" : "found", code: r.is_blocked ? "CHAT_BLOCKED" : "FOUND", detail: r.is_blocked ? "本次精確命中，但聊聊已封鎖，整位排除。" : "本次搜尋精確命中、沒封鎖；没有發送訊息。", conversation: r };
      }
      var SCOPE_LABELS = { all: ["搜尋全部", "全部"], message: ["搜尋訊息", "訊息"] };
      var SCOPE_MENU_LABELS = ["搜尋全部", "搜尋買家", "搜尋訊息", "搜尋訂單"];
      function inScopeMenu(option) {
        return [...option.parentElement?.children || []].some((s) => s !== option && visible(s) && SCOPE_MENU_LABELS.includes(norm(s.textContent)));
      }
      var scopeBindings = /* @__PURE__ */ new WeakMap();
      function nearSearch(node, input) {
        const a = node.getBoundingClientRect(), b = input.getBoundingClientRect();
        return a.left <= b.right + 80 && a.right >= b.left - 80 && a.top >= b.top - 50 && a.top <= b.bottom + 400;
      }
      function clickOwner(el) {
        for (let n = el, d = 0; n && d < 4; d++, n = n.parentElement) {
          if (n.matches('button,[role="button"],[role="option"],[role="menuitem"]')) return n;
          const f = fiberOf(n);
          if (typeof f?.memoizedProps?.onClick === "function") return n;
        }
        return null;
      }
      function scopeText(input) {
        let node = input.parentElement;
        for (let d = 0; node && d < 3; d++, node = node.parentElement) {
          for (const el of node.querySelectorAll('button,[role="button"],[aria-haspopup]')) if (visible(el) && nearSearch(el, input)) {
            const t = norm(el.textContent);
            if (Object.values(SCOPE_LABELS).flat().includes(t)) return t;
          }
        }
        return "";
      }
      function scopeLabel(input) {
        return scopeText(input) || norm(input.placeholder);
      }
      function validFilter(value) {
        return ["string", "number"].includes(typeof value);
      }
      function scopeMenuItems() {
        return [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li,span,div')].filter((e) => visible(e) && !e.closest(PANELS) && SCOPE_MENU_LABELS.includes(norm(e.textContent))).map(clickOwner).filter((e, i, a) => e && a.indexOf(e) === i && inScopeMenu(e));
      }
      async function ensureScope(mode, stop) {
        const input = inputElement(), labels = SCOPE_LABELS[mode], store = findStore(input), filter = store?.getState()?.searchReducer?.searchFilter;
        if (!store || !validFilter(filter)) throw problem("SCOPE", "無法核對搜尋範圍資料，已停止。");
        const bindings = scopeBindings.get(store) || {}, boundElsewhere = (value) => Object.entries(bindings).some(([key, v]) => key !== mode && v === value);
        if (bindings[mode] === filter || labels.includes(scopeText(input)) && !boundElsewhere(filter)) {
          bindings[mode] = filter;
          scopeBindings.set(store, bindings);
          return input;
        }
        const expectChange = !labels.includes(scopeLabel(input)) || boundElsewhere(filter) || bindings[mode] !== void 0 && bindings[mode] !== filter;
        const findOption = () => {
          const matches = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li,span,div')].filter((e) => visible(e) && !e.closest(PANELS) && nearSearch(e, input) && labels.includes(norm(e.textContent))).map(clickOwner).filter((e, i, a) => e && a.indexOf(e) === i && inScopeMenu(e));
          return matches.length === 1 ? matches[0] : null;
        };
        let option = findOption();
        if (!option) {
          let triggers = [];
          for (let node = input.parentElement, d = 0; node && d < 3; d++, node = node.parentElement) {
            triggers = [...node.querySelectorAll('button,[role="button"],[aria-haspopup],svg')].map(clickOwner).filter((e, i, a) => e && a.indexOf(e) === i && visible(e) && nearSearch(e, input));
            if (triggers.length) break;
          }
          const preferred = triggers.filter((e) => e.hasAttribute("aria-haspopup") || /搜尋|範圍|篩選/u.test([e.getAttribute("aria-label"), e.getAttribute("title")].join(" ")));
          if (preferred.length === 1) triggers = preferred;
          if (triggers.length !== 1) throw problem("SCOPE", "無法確認搜尋範圍選單，已停止；請人工切到需要的範圍再試。");
          safe(stop);
          activate(triggers[0]);
          option = await wait(findOption, LIMITS.scope, stop, "SCOPE", "搜尋範圍選項無法確認，已停止。");
        }
        safe(stop);
        activate(option);
        const settled = () => {
          if (scopeMenuItems().length) return null;
          const now = store.getState()?.searchReducer?.searchFilter;
          if (!validFilter(now)) throw problem("SCOPE", "無法核對搜尋範圍資料，已停止。");
          if (boundElsewhere(now) || bindings[mode] !== void 0 && bindings[mode] !== now) return null;
          if (expectChange) {
            if (now === filter) return null;
          } else {
            let current;
            try {
              current = inputElement();
            } catch (error) {
              if (error.code === "SEARCH_INPUT") return null;
              throw error;
            }
            if (!labels.includes(scopeLabel(current))) return null;
          }
          return { value: now };
        };
        const after = (await wait(settled, LIMITS.scope, stop, "SCOPE", "搜尋範圍切換未確認（選單沒收起，或頁面的範圍一直沒換過去），已停止。")).value;
        bindings[mode] = after;
        scopeBindings.set(store, bindings);
        return inputElement();
      }
      function ownEntityInProps(node, predicate) {
        let f = fiberOf(node);
        for (let depth = 0; f && depth < 12; depth++, f = f.return) {
          const props = f.memoizedProps;
          const scan = (v, n) => {
            if (!object(v) || n > 2 || typeof v.getState === "function") return false;
            if (predicate(v)) return true;
            return Object.keys(v).filter((k) => !["store", "children", "ref"].includes(k)).some((k) => {
              const child = v[k];
              return object(child) && scan(child, n + 1);
            });
          };
          if (scan(props, 0)) return true;
        }
        return false;
      }
      function columnRoot(input) {
        const ir = input.getBoundingClientRect();
        let n = input.parentElement;
        for (let d = 0; n && d < 10; d++, n = n.parentElement) {
          const r = n.getBoundingClientRect();
          if (r.width >= ir.width && r.width <= 700 && r.height >= 180) return n;
        }
        throw problem("UI_BINDING", "無法確認左側搜尋清單，已停止。");
      }
      function scrollParent(node) {
        for (let n = node?.parentElement, d = 0; n && d < 12; d++, n = n.parentElement) {
          const style = getComputedStyle(n);
          if (/auto|scroll/u.test(style.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
        }
        return null;
      }
      function validateSearchMessages(rows) {
        let previous = null;
        const seen = /* @__PURE__ */ new Set();
        for (const r of rows) {
          if (!decimal(r.message_id) || !decimal(r.conversation_id) || !decimal(r.message_nano_time) || !safeUid(r.to_id) || typeof r.to_name !== "string" || typeof r.text !== "string" || !Number.isSafeInteger(r.message_time) || BigInt(r.message_nano_time) / 1000000000n !== BigInt(r.message_time) || !r.text.normalize("NFKC").includes("回放加單")) throw problem("SEARCH_DATA", "回放搜尋資料與探查條件不同，已停止，不能匯出叫貨檔。");
          if (seen.has(r.message_id)) throw problem("SEARCH_DATA", "回放搜尋出現重複訊息，已停止。");
          seen.add(r.message_id);
          if (previous && (BigInt(r.message_nano_time) > BigInt(previous.message_nano_time) || r.message_nano_time === previous.message_nano_time && compareIds(r.message_id, previous.message_id) > 0)) throw problem("SEARCH_DATA", "回放搜尋排序與預期不同，已停止。");
          previous = r;
        }
        return rows;
      }
      function conversationFrame(store, id) {
        const s = store.getState(), c = s.entityReducer?.conversations?.[id], rel = s.messageReducer?.messagesRelatedMap?.[id];
        if (s.conversationReducer?.currentConversationId !== id) return null;
        if (!object(c) || !object(rel)) return null;
        if (c.id !== void 0 && c.id !== id) throw problem("DATA", "對話編號資料矛盾，已停止。");
        if (!safeUid(c.to_id) || typeof c.to_name !== "string" || typeof c.is_blocked !== "boolean" || !Array.isArray(rel.all) || typeof rel.hasMoreOlderMessage !== "boolean" || typeof rel.hasMoreLatestMessage !== "boolean") throw problem("DATA", "對話或訊息清單格式異常，已停止。");
        if (rel.hasMoreLatestMessage) throw problem("LATEST_NOT_LOADED", "這個對話尚未讀到最新一端，已停止；請人工確認後重跑。");
        const seen = /* @__PURE__ */ new Set(), precisions = /* @__PURE__ */ new Set(), messages = rel.all.map((mid) => {
          if (!decimal(mid) || seen.has(mid)) throw problem("DATA", "對話訊息編號重複或格式不正確，已停止。");
          seen.add(mid);
          const m = s.entityReducer.messages?.[mid];
          if (!object(m) || m.id !== mid || m.conversation_id !== id || !Number.isSafeInteger(m.created_timestamp) || m.created_timestamp <= 0 || typeof m.type !== "string") throw problem("DATA", "訊息實體、時間或對話歸屬無法確認，已停止。");
          const hasNano = m.created_timestamp_nano !== void 0;
          if (hasNano && (!decimal(m.created_timestamp_nano) || BigInt(m.created_timestamp_nano) / 1000000000n !== BigInt(m.created_timestamp))) throw problem("DATA", "訊息的奈秒時間和秒數對不上，已停止。");
          precisions.add(hasNano ? "nano" : "seconds");
          if (m.type === "text" && (!safeUid(m.from_id) || typeof m.content?.text !== "string")) throw problem("DATA", "文字訊息的傳送者或內容格式無法確認，已停止。");
          return { id: m.id, conversation_id: id, nano: hasNano ? m.created_timestamp_nano : String(BigInt(m.created_timestamp) * 1000000000n), seconds: m.created_timestamp, from_id: m.from_id, type: m.type, text: m.type === "text" ? m.content.text : "" };
        });
        if (precisions.size > 1) throw problem("DATA", "同一個對話的訊息時間格式不一致（有的有奈秒、有的沒有），已停止。");
        for (let i = 1; i < messages.length; i++) if (BigInt(messages[i].nano) > BigInt(messages[i - 1].nano) || messages[i].nano === messages[i - 1].nano && compareIds(messages[i].id, messages[i - 1].id) > 0) throw problem("DATA", "對話訊息排序與預期不同，已停止。");
        return { conversation: { id, to_name: c.to_name, to_id: c.to_id, is_blocked: c.is_blocked }, messages, hasMoreOlder: rel.hasMoreOlderMessage, precision: [...precisions][0] ?? null };
      }
      function assertCandidateTitlesRead(value, candidate) {
        if (value.conversation.is_blocked) return;
        const expected = candidate.titleMessages ?? [{ id: candidate.titleMessageId, nano: candidate.titleNano }];
        const found = new Map(value.messages.map((message) => [message.id, message]));
        const sameTime = (message, title) => value.precision === "seconds" ? BigInt(message.nano) / 1000000000n === BigInt(title.nano) / 1000000000n : message.nano === title.nano;
        if (!Array.isArray(expected) || !expected.length || value.conversation.id !== candidate.conversation_id || expected.some((title) => {
          const message = found.get(title?.id);
          return !decimal(title?.id) || !decimal(title?.nano) || !message || message.conversation_id !== candidate.conversation_id || !sameTime(message, title);
        })) throw problem("TITLE_NOT_READ", "對話沒有讀到與搜尋結果相符的標題訊息（訊息缺少或時間不同），讀取不完整，已停止。");
      }
      function createChatRuntime({ stop = () => false, onStatus = () => {
      }, limits = {}, allowConversation = false } = {}) {
        const timing = { ...LIMITS, ...limits };
        let store = null, searchScroller = null;
        function currentStore() {
          const found = findStore();
          if (!found) throw problem("STORE", "找不到聊聊資料，已停止。");
          if (store && store !== found) throw problem("STORE_CHANGED", "聊聊資料來源已被替換，已停止；請重跑。");
          store = found;
          return store;
        }
        async function ready(replay = false) {
          onStatus("等待聊聊資料準備好…");
          await wait(() => {
            let found;
            try {
              found = findStore();
            } catch (e) {
              if (e.code === "SEARCH_INPUT") return null;
              throw e;
            }
            if (!found) return null;
            const status = rootStatus(found.getState(), replay);
            if (status === "invalid") throw problem("DATA", "聊聊資料型別與預期不同，已停止。");
            if (status !== "ready") return null;
            store = found;
            return store;
          }, timing.root, stop, "NOT_READY", `聊聊頁面等了 ${Math.round(timing.root / 1e3)} 秒還沒準備好（搜尋或訊息功能沒有載入），再等也不會好；請按 F5 重新整理聊聊頁面，等約 20 秒後再重新開始。`);
        }
        async function query(target, branch = "user", mode = "all") {
          if (typeof target !== "string" || !target.trim()) throw problem("SEARCH_INPUT", "搜尋關鍵字不能空白。");
          await ensureScope(mode, stop);
          const input = inputElement(), s = currentStore(), initial = searchFrame(s, branch), filter = initial.filter;
          let phase = "clear", complete = null, failure = null, active = true, sawBranch = !!initial.branch, expectedInput = "";
          const check = () => {
            if (!active) return;
            try {
              safe(stop);
              if (inputElement() !== input || !document.contains(input)) throw problem("SEARCH_INPUT", "搜尋框被替換，已停止。");
              if (input.value !== expectedInput) throw problem("SEARCH_UNRELIABLE", "搜尋框內容被改掉，已停止本輪。");
              const f = searchFrame(currentStore(), branch);
              if (f.filter !== filter) throw problem("SCOPE", "搜尋範圍中途變動，已停止。");
              if (!f.branch) {
                if (sawBranch) throw problem("DATA", "搜尋資料中途消失，已停止。");
                return;
              }
              sawBranch = true;
              if (phase === "clear") {
                if (f.keyword === "") phase = "cleared";
                return;
              }
              if (phase === "cleared") return;
              if (phase === "reset") {
                if (f.keyword !== "" && f.keyword !== target) throw problem("SEARCH_UNRELIABLE", "搜尋關鍵字被改掉，已停止本輪。");
                if (f.keyword === target && f.branch.status === "" && f.branch.results.length === 0) phase = "result";
                return;
              }
              if (phase === "result") {
                if (f.keyword !== target) throw problem("SEARCH_UNRELIABLE", "搜尋關鍵字中途變動，已停止本輪。");
                if (f.branch.status === "succeed") {
                  complete = { results: projectResults(f.branch.results, branch), hasMore: f.branch.hasMore, filter };
                  phase = "complete";
                }
              }
            } catch (e) {
              failure = e;
            }
          };
          const cancel = s.subscribe(check);
          if (typeof cancel !== "function") throw problem("STORE", "聊聊資料訂閱不支援取消，已停止。");
          try {
            nativeSearchValue(input, "");
            await wait(() => {
              check();
              if (failure) throw failure;
              return phase === "cleared";
            }, timing.query, stop, "SEARCH_CLEAR_UNFINISHED", "清空搜尋框未完成，頁面搜尋沒有回應，已停止；本位尚未查詢，沒有記錄結果。");
            phase = "reset";
            expectedInput = target;
            nativeSearchValue(input, target);
            await wait(() => {
              check();
              if (failure) throw failure;
              return complete;
            }, timing.query, stop, "SEARCH_UNFINISHED", "未完成搜尋：沒有確認本次重設與完成。");
            return complete;
          } finally {
            active = false;
            cancel();
          }
        }
        async function collectSearch(startNs) {
          const q = await query("回放加單", "message", "message");
          let rows = validateSearchMessages(q.results), filter = q.filter;
          searchScroller = null;
          while (q.hasMore !== false && !(rows.length && BigInt(rows.at(-1).message_nano_time) < startNs)) {
            safe(stop);
            const input = inputElement();
            if (!searchScroller) {
              const ids = new Set(rows.map((r) => r.message_id)), root = columnRoot(input);
              const nodes = [...root.querySelectorAll("div,li,span")].filter((e) => visible(e) && ownEntityInProps(e, (v) => decimal(v.message_id) && ids.has(v.message_id)));
              searchScroller = nodes.map(scrollParent).find(Boolean);
              if (!searchScroller) throw problem("UI_BINDING", "無法確認訊息搜尋清單的捲動區，已停止。");
            }
            if (!document.contains(searchScroller)) throw problem("UI_BINDING", "搜尋清單被替換，已停止。");
            const before = rows.map((r) => canonical(r));
            searchScroller.scrollTop = searchScroller.scrollHeight;
            searchScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
            const next = await wait(() => {
              const f = searchFrame(currentStore(), "message");
              if (f.keyword !== "回放加單" || f.filter !== filter || inputElement().value !== "回放加單") throw problem("SEARCH_UNRELIABLE", "搜尋條件中途變動，已停止。");
              if (!f.branch) return null;
              if (f.branch.status !== "succeed") return null;
              const projected = validateSearchMessages(projectResults(f.branch.results, "message"));
              if (projected.length < before.length || before.some((v, i) => canonical(projected[i]) !== v)) throw problem("SEARCH_DATA", "搜尋結果前面的部分被改掉，已停止。");
              if (projected.length > before.length || f.branch.hasMore === false) return { results: projected, hasMore: f.branch.hasMore };
              return null;
            }, timing.page, stop);
            rows = next.results;
            q.hasMore = next.hasMore;
            onStatus(`已讀 ${rows.length} 筆搜尋結果`);
          }
          return rows;
        }
        async function openConversation(candidate) {
          if (!allowConversation) throw problem("FORBIDDEN", "帳號預檢不開對話。");
          const q = await query(candidate.to_name, "user", "all"), r = classifyUser(q.results, candidate.to_name);
          if (!r.conversation || r.conversation.id !== candidate.conversation_id || r.conversation.to_id !== candidate.to_id) throw problem("BUYER_BINDING", "候選買家的帳號／對話／UID 無法核對，已停止。");
          if (r.status === "chatBlocked") return { conversation: r.conversation, messages: [], hasMoreOlder: false };
          const input = inputElement(), root = columnRoot(input);
          const nodes = [...root.querySelectorAll("div,li,span,p")].filter((e) => visible(e) && norm(e.textContent) === candidate.to_name && ownEntityInProps(e, (v) => v.id === candidate.conversation_id && v.to_name === candidate.to_name && v.to_id === candidate.to_id));
          nodes.sort((a, b) => {
            const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
            return x.width * x.height - y.width * y.height;
          });
          if (!nodes.length) throw problem("UI_BINDING", "買家結果的畫面元素無法綁定對話，已停止。");
          activate(nodes[0]);
          const value = await wait(() => conversationFrame(currentStore(), candidate.conversation_id), timing.conversation, stop, "BUYER_BINDING", "沒有確認進入候選對話，已停止。");
          if (value.conversation.to_name !== candidate.to_name || value.conversation.to_id !== candidate.to_id) throw problem("BUYER_BINDING", "進入的買家對話不相符，已停止。");
          return value;
        }
        async function readConversation(candidate, startNs) {
          let frame = await openConversation(candidate);
          if (frame.conversation.is_blocked) return frame;
          const collected = /* @__PURE__ */ new Map();
          let scroller = null, precision = null;
          while (true) {
            safe(stop);
            if (frame.precision) {
              if (precision && precision !== frame.precision) throw problem("DATA", "同一個對話往上讀時，訊息時間格式變了（有的有奈秒、有的沒有），已停止。");
              precision = frame.precision;
            }
            for (const m of frame.messages) {
              const old = collected.get(m.id);
              if (old && canonical(old) !== canonical(m)) throw problem("DATA", "已讀的訊息內容或時間被改掉，已停止。");
              collected.set(m.id, m);
            }
            const oldest = frame.messages.at(-1);
            if (frame.hasMoreOlder === false || oldest && BigInt(oldest.nano) < startNs) break;
            if (!scroller) {
              const ids = new Set(frame.messages.map((m) => m.id));
              const nodes = [...document.querySelectorAll('[data-cy="webchat-message-receive"],[data-cy="webchat-message-send"]')].filter((e) => visible(e) && ownEntityInProps(e, (v) => v.conversation_id === candidate.conversation_id && decimal(v.id) && ids.has(v.id)));
              scroller = nodes.map(scrollParent).find(Boolean);
              if (!scroller) throw problem("UI_BINDING", "無法確認目標對話的訊息捲動區，已停止。");
            }
            if (!document.contains(scroller)) throw problem("UI_BINDING", "訊息捲動區被替換，已停止。");
            const known = new Set(collected.keys());
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
            frame = await wait(() => {
              const f = conversationFrame(currentStore(), candidate.conversation_id);
              if (!f) return null;
              if (f.conversation.to_name !== candidate.to_name || f.conversation.to_id !== candidate.to_id) throw problem("BUYER_BINDING", "對話身分中途變動，已停止。");
              return f.hasMoreOlder === false || f.messages.some((m) => !known.has(m.id)) ? f : null;
            }, timing.page, stop);
            onStatus(`已讀此對話 ${collected.size} 則訊息`);
          }
          const value = { conversation: frame.conversation, messages: [...collected.values()], hasMoreOlder: frame.hasMoreOlder, precision };
          assertCandidateTitlesRead(value, candidate);
          return value;
        }
        async function cleanup() {
          safe(stop);
          await ensureScope("all", stop);
          const input = inputElement();
          nativeSearchValue(input, "");
        }
        return { ready, query, collectSearch, readConversation, cleanup, delay: (ms) => sleep(ms, stop), safe: () => safe(stop) };
      }
      module.exports = { LOCK_NAME, LIMITS, PANELS, visible, safe, withLock, sleep, wait, inputElement, nativeSearchValue, activate, findStore, rootStatus, searchFrame, projectResults, classifyUser, ensureScope, validateSearchMessages, conversationFrame, assertCandidateTitlesRead, createChatRuntime };
    }
  });

  // src/precheck-block-check.cjs
  var require_precheck_block_check = __commonJS({
    "src/precheck-block-check.cjs"(exports, module) {
      "use strict";
      var chat2 = require_chat_runtime();
      var { problem, norm, decimal, safeUid } = require_util();
      var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
      function fiberOf(node) {
        const key = Object.keys(node || {}).find((k) => k.startsWith("__reactFiber$"));
        return key ? node[key] : null;
      }
      function ownEntityInProps(node, predicate) {
        let f = fiberOf(node);
        for (let depth = 0; f && depth < 12; depth++, f = f.return) {
          const props = f.memoizedProps;
          const scan = (v, n) => {
            if (!object(v) || n > 2 || typeof v.getState === "function") return false;
            if (predicate(v)) return true;
            return Object.keys(v).filter((k) => !["store", "children", "ref"].includes(k)).some((k) => {
              const child = v[k];
              return object(child) && scan(child, n + 1);
            });
          };
          if (scan(props, 0)) return true;
        }
        return false;
      }
      function columnRoot(input) {
        const ir = input.getBoundingClientRect();
        let n = input.parentElement;
        for (let d = 0; n && d < 10; d++, n = n.parentElement) {
          const r = n.getBoundingClientRect();
          if (r.width >= ir.width && r.width <= 700 && r.height >= 180) return n;
        }
        throw problem("BLOCK_CHECK_FAILED", "找不到左側搜尋清單。");
      }
      function classifyForPrecheck(results, account) {
        const base = chat2.classifyUser(results, account);
        if (base.code !== "IDENTITY_INVALID") return base;
        const exact = results.filter((r2) => r2.to_name === account);
        const r = exact[0];
        if (exact.length !== 1 || !safeUid(r.to_id) || typeof r.id !== "string" || !r.id) return base;
        if (decimal(r.id) && typeof r.is_blocked === "boolean") return base;
        return { status: "needsBlockCheck", code: "BLOCK_FLAG_MISSING", detail: "搜尋結果沒有封鎖欄位，要點進對話確認。", match: { id: r.id, to_name: r.to_name, to_id: r.to_id } };
      }
      function createBlockChecker({ stop = () => false, timeout = chat2.LIMITS.conversation } = {}) {
        return async function checkBlocked(match) {
          if (!object(match) || typeof match.to_name !== "string" || !match.to_name || !safeUid(match.to_id) || typeof match.id !== "string" || !match.id) throw problem("BLOCK_CHECK_FAILED", "搜尋結果的帳號或 UID 不完整。");
          const input = chat2.inputElement(), store = chat2.findStore(input);
          if (!store) throw problem("STORE", "找不到聊聊資料，已停止。");
          const nodes = [...columnRoot(input).querySelectorAll("div,li,span,p")].filter((e) => chat2.visible(e) && !e.closest(chat2.PANELS) && norm(e.textContent) === match.to_name && ownEntityInProps(e, (v) => v.id === match.id && v.to_name === match.to_name && v.to_id === match.to_id));
          nodes.sort((a, b) => {
            const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
            return x.width * x.height - y.width * y.height;
          });
          if (!nodes.length) throw problem("BLOCK_CHECK_FAILED", "搜尋結果的畫面對不上這位買家。");
          chat2.safe(stop);
          chat2.activate(nodes[0]);
          return chat2.wait(() => {
            const state = store.getState(), id = state.conversationReducer?.currentConversationId;
            if (!decimal(id)) return null;
            const c = state.entityReducer?.conversations?.[id];
            if (!object(c) || c.to_id !== match.to_id) return null;
            if (c.to_name !== match.to_name || c.id !== void 0 && c.id !== id) throw problem("BLOCK_CHECK_FAILED", "打開的對話和搜尋的帳號對不上。");
            return typeof c.is_blocked === "boolean" ? { conversationId: id, is_blocked: c.is_blocked } : null;
          }, timeout, stop, "BLOCK_CHECK_FAILED", "點進對話後讀不到封鎖狀態。");
        };
      }
      module.exports = { classifyForPrecheck, createBlockChecker };
    }
  });

  // src/panel.cjs
  var require_panel = __commonJS({
    "src/panel.cjs"(exports, module) {
      "use strict";
      var { safeMessage } = require_util();
      var BASE_CSS = `:host{all:initial;font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#26354b}*{box-sizing:border-box}.panel{position:fixed;width:360px;max-width:calc(100vw - 24px);max-height:78vh;background:#fff;border:1px solid #bac7d8;border-radius:10px;box-shadow:0 6px 28px #0003;z-index:2147483646;overflow:hidden}header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;cursor:grab;touch-action:none;color:#fff}header button{background:#ffffff22;color:#fff;border:0}.body{padding:12px;max-height:calc(78vh - 44px);overflow:auto}.closed .body,.hidden{display:none}label{display:block;margin:7px 0}textarea,input,select,button{font:inherit}textarea,input:not([type=checkbox]),select{width:100%;padding:6px;border:1px solid #aebccd;border-radius:5px}textarea{min-height:85px;resize:vertical}button{padding:6px 9px;border:1px solid #b6c4d6;border-radius:5px;background:#f5f8fc;cursor:pointer}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.primary{background:#176e63;color:#fff}.danger{background:#b43030;color:white}.status,.mini,pre{white-space:pre-wrap;overflow-wrap:anywhere}.mini{font-size:12px;color:#596b81}.error{color:#aa2525}pre{max-height:145px;overflow:auto;background:#eef4fa;padding:7px;margin:7px 0}.check{display:flex;gap:7px;align-items:start}.stop{position:sticky;bottom:0;width:100%}`;
      function mountPanel({ attribute, title, html, colour = "#176e63", position = { left: 18, top: 18 }, gm, positionKey }) {
        if (document.querySelector(`[${attribute}]`)) return null;
        const host = document.createElement("div");
        host.setAttribute(attribute, "1");
        document.documentElement.append(host);
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `<style>${BASE_CSS}</style><section class="panel"><header style="background:${colour}"><strong>${title}</strong><button data-collapse>收合</button></header><div class="body">${html}</div></section>`;
        const $ = (selector) => root.querySelector(selector), panel = $(".panel"), header = $("header");
        let drag = null;
        function place(left, top) {
          const r = panel.getBoundingClientRect();
          panel.style.left = `${Math.min(Math.max(8, left), Math.max(8, innerWidth - r.width - 8))}px`;
          panel.style.top = `${Math.min(Math.max(8, top), Math.max(8, innerHeight - Math.min(r.height, 80) - 8))}px`;
        }
        const save = () => {
          const r = panel.getBoundingClientRect();
          Promise.resolve(gm.set(positionKey, { left: Math.round(r.left), top: Math.round(r.top) })).catch(() => {
          });
        };
        place(position.left, position.top);
        Promise.resolve(gm.get(positionKey, null)).then((p) => {
          if (Number.isFinite(p?.left) && Number.isFinite(p?.top)) place(p.left, p.top);
        }).catch(() => {
        });
        function end(e) {
          if (!drag || e?.pointerId != null && e.pointerId !== drag.id) return;
          const id = drag.id;
          drag = null;
          save();
          if (header.hasPointerCapture?.(id)) header.releasePointerCapture(id);
        }
        header.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.target.closest("button")) return;
          const r = panel.getBoundingClientRect();
          drag = { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top };
          header.setPointerCapture?.(e.pointerId);
          e.preventDefault();
        });
        header.addEventListener("pointermove", (e) => {
          if (drag?.id === e.pointerId) place(e.clientX - drag.x, e.clientY - drag.y);
        });
        for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) header.addEventListener(event, end);
        window.addEventListener("blur", () => end());
        window.addEventListener("resize", () => {
          const r = panel.getBoundingClientRect();
          place(r.left, r.top);
        });
        $("[data-collapse]").addEventListener("click", () => {
          panel.classList.toggle("closed");
          $("[data-collapse]").textContent = panel.classList.contains("closed") ? "展開" : "收合";
        });
        const show = (message, error = false) => {
          const target = $("[data-status]");
          if (target) {
            target.textContent = message;
            target.classList.toggle("error", error);
          }
        };
        const logs = [];
        const log = (message) => {
          logs.push(`${(/* @__PURE__ */ new Date()).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })} ${message}`);
          if (logs.length > 150) logs.shift();
          if ($("[data-log]")) $("[data-log]").textContent = logs.join("\n");
        };
        function download(content, name) {
          const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" })), a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1e3);
        }
        if (gm.menu) {
          gm.menu(`開啟${title}`, () => {
            panel.classList.remove("closed");
            $("[data-collapse]").textContent = "收合";
          });
          gm.menu(`重設${title}位置`, () => {
            place(position.left, position.top);
            save();
          });
        }
        return { host, root, $, panel, show, log, download, fail: (error) => show(safeMessage(error), true) };
      }
      function gmAdapter() {
        return { get: (key, fallback) => typeof GM_getValue === "function" ? GM_getValue(key, fallback) : fallback, set: (key, value) => {
          if (typeof GM_setValue !== "function") throw new Error("GM storage unavailable");
          return GM_setValue(key, value);
        }, menu: typeof GM_registerMenuCommand === "function" ? GM_registerMenuCommand : null };
      }
      module.exports = { mountPanel, gmAdapter };
    }
  });

  // src/precheck-ui.cjs
  var require_precheck_ui = __commonJS({
    "src/precheck-ui.cjs"(exports, module) {
      "use strict";
      var core2 = require_precheck_core();
      var storage2 = require_precheck_storage();
      var chat2 = require_chat_runtime();
      var blockCheck = require_precheck_block_check();
      var { problem, safeMessage } = require_util();
      var { mountPanel, gmAdapter } = require_panel();
      var VERSION = "0.3.5";
      async function initPrecheck() {
        const gm = gmAdapter(), ui2 = mountPanel({ attribute: "data-account-precheck", title: `帳號預檢 v${VERSION}（只查、不發）`, position: { left: Math.min(Math.round(innerWidth * 0.28), Math.max(18, innerWidth - 380)), top: 80 }, gm, positionKey: storage2.STORE.panelPosition, html: `
    <label>直播原始 CSV（一份）<input data-files type="file" accept=".csv"></label><p data-file-list class="mini">請選原始檔，不要選篩選後的檔。</p><p data-resume class="mini"></p>
    <details><summary>本腳本黑名單</summary><label>每行一個完整帳號<textarea data-blacklist></textarea></label><button data-save-blacklist>儲存黑名單</button><p class="mini">名單只存本腳本；修改後按儲存才生效。</p></details>
    <label>買家與狀態<select data-preview-select></select></label><p data-source class="mini"></p><div class="actions"><button data-mark-manual>這位人工確認找得到（留）</button><button data-mark-blocked>這位列入黑名單</button></div>
    <label class="check"><input data-dry type="checkbox" checked><span>演練：前 3 位待查者，只顯示判斷、不寫結果。</span></label><button data-start class="primary">開始演練</button><button data-stop class="danger stop hidden">緊急停止</button>
    <p data-status class="status">正在準備紀錄…</p><p data-summary class="mini"></p><div class="actions"><button data-export-filtered>匯出預檢通過的直播檔</button><button data-export-pending>匯出待處理直播檔</button><button data-export-list>匯出名單與結果</button></div>
    <button data-recheck>搜尋未確認的重新查一次</button><details><summary>整份重新查</summary><button data-new-round>這份檔重新全部查一次</button></details><p class="mini">完全不發訊息；只有搜尋結果沒有封鎖欄位的客人，才點進對話看封鎖（對話會變已讀）。預檢時不要發明細。待處理檔不能拿來叫貨；後續更新須重新匯出、另建場次。</p><pre data-log></pre>` });
        if (!ui2) return;
        const $ = ui2.$, repo = storage2.createRepository(gm);
        const state = { entry: null, queue: null, round: 0, records: {}, blacklist: [], busy: true, running: false, stop: false, booted: false };
        function controls() {
          const disabled = state.busy || state.running || !state.booted;
          for (const s of ["[data-files]", "[data-save-blacklist]", "[data-start]", "[data-dry]", "[data-blacklist]"]) $(s).disabled = disabled;
          for (const s of ["[data-export-filtered]", "[data-export-pending]", "[data-export-list]", "[data-new-round]", "[data-recheck]", "[data-preview-select]", "[data-mark-manual]", "[data-mark-blocked]"]) $(s).disabled = disabled || !state.entry;
          $("[data-recheck]").disabled = disabled || !state.queue?.items.some((i) => ["notFound", "searchUnconfirmed"].includes(core2.itemState(state.queue, state.records, i)));
          $("[data-start]").disabled = disabled || !state.queue?.items.length;
          $("[data-stop]").classList.toggle("hidden", !state.running);
          $("[data-start]").textContent = $("[data-dry]").checked ? "開始演練" : "開始檢查";
          const account = $("[data-preview-select]").value, item = state.queue?.items.find((i) => i.account === account);
          if (item) $("[data-mark-manual]").disabled = disabled || ["blocked", "chatBlocked"].includes(core2.itemState(state.queue, state.records, item));
        }
        async function render() {
          if (state.queue) {
            const value = await repo.read();
            state.records = value.records;
            $("[data-summary]").textContent = [core2.summaryText(core2.summary(state.queue, state.records)), core2.streakWarning(state.queue, state.records)].filter(Boolean).join("\n");
            const selection = $("[data-preview-select]").value;
            $("[data-preview-select]").replaceChildren(...state.queue.items.map((i) => {
              const option = document.createElement("option");
              option.value = i.account;
              option.textContent = `${i.account}：${core2.displayLabel(state.queue, state.records, i)}`;
              return option;
            }));
            if (state.queue.items.some((i) => i.account === selection)) $("[data-preview-select]").value = selection;
            const item = state.queue.items.find((i) => i.account === $("[data-preview-select]").value);
            $("[data-source]").textContent = item ? `原檔 ${item.rowCount} 列；${core2.displayLabel(state.queue, state.records, item)}` : "";
            $("[data-recheck]").disabled = state.running || state.busy || !state.queue.items.some((i) => ["notFound", "searchUnconfirmed"].includes(core2.itemState(state.queue, state.records, i)));
          }
          controls();
        }
        async function checkCurrent() {
          const list = core2.parseBlacklist(await repo.get(storage2.STORE.blacklist, []));
          if (JSON.stringify(list) !== JSON.stringify(state.blacklist) || JSON.stringify(core2.parseBlacklist($("[data-blacklist]").value)) !== JSON.stringify(list)) throw problem("BLACKLIST_UNSAVED", "黑名單未儲存或已在別的分頁變動，請核對並儲存後再操作。");
          return repo.assertBatch(state.queue, state.entry.hash);
        }
        $("[data-stop]").addEventListener("click", () => {
          state.stop = true;
          ui2.show("停止中；不會再查下一位。");
        });
        $("[data-dry]").addEventListener("change", controls);
        $("[data-preview-select]").addEventListener("change", () => render().catch(ui2.fail));
        $("[data-files]").addEventListener("change", async (e) => {
          if (state.running || state.busy || !state.booted) return;
          const file = e.target.files?.[0];
          if (!file) return;
          state.busy = true;
          controls();
          try {
            const entry = await core2.readSource(await file.arrayBuffer(), file.name);
            await chat2.withLock(async () => {
              const previous = (await repo.read()).files.last;
              const next = await repo.importEntry(entry);
              state.entry = entry;
              state.round = next.round;
              state.queue = core2.buildQueue(entry, null, next.round, state.blacklist);
              state.records = next.records;
              await repo.updateLast(state.queue, entry);
              $("[data-file-list]").textContent = `${entry.name}：${entry.sourceRows} 資料列、${entry.accounts.length} 位；稽核留言 ${entry.inactiveRows} 列、無帳號 ${entry.emptyAccountRows} 列。`;
              $("[data-resume]").textContent = "";
              ui2.show(previous?.name === entry.name && previous.hash !== entry.hash ? "檔名相同但內容不同，這是新的批次，請重新核對。" : "已匯入原檔；內容相同就接續既有進度。");
            });
          } catch (error) {
            ui2.fail(error);
          } finally {
            state.busy = false;
            await render().catch(ui2.fail);
          }
        });
        $("[data-save-blacklist]").addEventListener("click", async () => {
          if (state.running || state.busy) return;
          try {
            await chat2.withLock(async () => {
              state.blacklist = core2.parseBlacklist($("[data-blacklist]").value);
              await repo.set(storage2.STORE.blacklist, state.blacklist);
              $("[data-blacklist]").value = state.blacklist.join("\n");
              if (state.queue) state.queue.blacklist = state.blacklist;
              ui2.show(`已儲存 ${state.blacklist.length} 位黑名單。`);
              await render();
            });
          } catch (error) {
            ui2.fail(error);
          }
        });
        async function selected(manual) {
          if (state.running || state.busy || !state.queue) return;
          const item = state.queue.items.find((i) => i.account === $("[data-preview-select]").value);
          if (!item) return;
          try {
            await chat2.withLock(async () => {
              const { records } = await checkCurrent();
              if (["blocked", "chatBlocked"].includes(core2.itemState(state.queue, records, item)) && manual) throw problem("BLOCKED", "此人已排除，不能用人工確認放回叫貨檔。");
              const prompt = manual ? `你已人工核對本批帳號 ${item.account} 找得到、沒有封鎖？
只記人工確認，不代表明細送達，也不發訊息。` : `將 ${item.account} 列入本腳本黑名單？此人的全部原始列會從叫貨檔及待處理檔排除。`;
              if (!confirm(prompt)) return;
              if (manual) await repo.write(state.queue, state.entry, item, "manualSent", "MANUAL_FOUND", "人工確認本批帳號找得到");
              else {
                state.blacklist = core2.parseBlacklist([...state.blacklist, item.account]);
                state.queue.blacklist = state.blacklist;
                await repo.set(storage2.STORE.blacklist, state.blacklist);
                $("[data-blacklist]").value = state.blacklist.join("\n");
              }
              await render();
            });
          } catch (error) {
            ui2.fail(error);
          }
        }
        $("[data-mark-manual]").addEventListener("click", () => selected(true));
        $("[data-mark-blocked]").addEventListener("click", () => selected(false));
        for (const [selector, kind] of [["[data-export-filtered]", "passed"], ["[data-export-pending]", "pending"], ["[data-export-list]", "list"]]) $(selector).addEventListener("click", async () => {
          if (state.running || state.busy || !state.entry) return;
          try {
            await chat2.withLock(async () => {
              const { records } = await checkCurrent();
              if (kind === "list") {
                ui2.download(core2.listCsv(state.queue, records), state.entry.name.replace(/\.csv$/iu, "") + "_預檢結果.csv");
                return;
              }
              const result = kind === "pending" ? core2.pendingExport(state.entry, state.queue, records) : core2.filteredExport(state.entry, state.queue, records);
              if (confirm(result.confirmation)) ui2.download(result.bytes, result.filename);
            });
          } catch (error) {
            ui2.fail(error);
          }
        });
        async function reset(all) {
          if (state.running || state.busy || !state.entry) return;
          try {
            await chat2.withLock(async () => {
              await checkCurrent();
              if (!confirm(all ? "本檔全部重新搜尋一次，不發訊息；黑名單仍排除。確定？" : "把搜尋未確認的人改回待查？不會自己開始，之後請再按開始。")) return;
              state.round = await repo.recheck(state.queue, state.entry, all);
              state.queue = core2.buildQueue(state.entry, null, state.round, state.blacklist);
              await render();
              ui2.show("已重設，請再按開始。");
            });
          } catch (error) {
            ui2.fail(error);
          }
        }
        $("[data-recheck]").addEventListener("click", () => reset(false));
        $("[data-new-round]").addEventListener("click", () => reset(true));
        $("[data-start]").addEventListener("click", async () => {
          if (state.running || state.busy || !state.queue?.items.length) return;
          state.running = true;
          state.stop = false;
          controls();
          try {
            await chat2.withLock(async () => {
              const { records } = await checkCurrent(), dry = $("[data-dry]").checked, all = core2.runnableItems(state.queue, records), items = dry ? all.slice(0, 3) : all;
              if (!items.length) {
                ui2.show("沒有待查者；搜尋未確認需手動重查。");
                return;
              }
              const runtime = chat2.createChatRuntime({ stop: () => state.stop, onStatus: ui2.show, allowConversation: false }), checkBlocked = blockCheck.createBlockChecker({ stop: () => state.stop });
              await runtime.ready(false);
              for (let index = 0; index < items.length; index++) {
                runtime.safe();
                const current = await checkCurrent(), item = items[index];
                if (!core2.RETRYABLE.includes(core2.itemState(state.queue, current.records, item))) continue;
                ui2.show(`${dry ? "演練" : "檢查"} ${index + 1}／${items.length}：${item.account}`);
                let result;
                try {
                  const q = await runtime.query(item.account, "user", "all");
                  result = blockCheck.classifyForPrecheck(q.results, item.account);
                } catch (error) {
                  if (error.code !== "SEARCH_UNFINISHED") throw error;
                  result = { status: "searchUnconfirmed", code: error.code, detail: "未完成搜尋：沒有看到本次重設與完成，請人工核對後手動重查。" };
                }
                if (result.status === "needsBlockCheck") {
                  ui2.show(`${dry ? "演練" : "檢查"} ${index + 1}／${items.length}：${item.account}（點進對話看封鎖）`);
                  try {
                    const b = await checkBlocked(result.match);
                    result = b.is_blocked ? { status: "chatBlocked", code: "CHAT_BLOCKED_AFTER_OPEN", detail: "搜尋結果沒有封鎖欄位；點進對話確認：聊聊已封鎖，整位排除。" } : { status: "found", code: "FOUND_AFTER_OPEN", detail: "搜尋結果沒有封鎖欄位；點進對話確認沒封鎖（對話會變已讀），沒有發送訊息。" };
                  } catch (error) {
                    if (error.code !== "BLOCK_CHECK_FAILED") throw error;
                    result = { status: "searchUnconfirmed", code: "BLOCK_CHECK_FAILED", detail: `找得到帳號，但點進對話確認封鎖沒有成功（${error.message}），請人工核對。` };
                  }
                }
                if (!dry) await repo.write(state.queue, state.entry, item, result.status, result.code, result.detail);
                ui2.log(`${item.account}：${result.status === "found" ? "找得到，留" : result.status === "chatBlocked" ? "聊聊已封鎖，排除" : "搜尋未確認"}${/_AFTER_OPEN$/u.test(result.code) ? "（點進對話確認）" : ""}${dry ? "（演練，不寫結果）" : ""}`);
                await render();
                if (index < items.length - 1) await runtime.delay(dry ? 500 : 2e3 + Math.floor(Math.random() * 2001));
              }
              await runtime.cleanup();
              ui2.show(dry ? "演練完成，沒有寫檢查結果；請核對後取消演練再正式查。" : "本次檢查完成，請核對摘要並匯出。");
            });
          } catch (error) {
            ui2.fail(error);
          } finally {
            state.running = false;
            await render().catch(ui2.fail);
          }
        });
        controls();
        try {
          await chat2.withLock(() => repo.migrate());
          state.blacklist = core2.parseBlacklist(await repo.get(storage2.STORE.blacklist, []));
          $("[data-blacklist]").value = state.blacklist.join("\n");
          const last = (await repo.read()).files.last;
          if (last) $("[data-resume]").textContent = last.progressVersion === 2 ? `上次 ${last.name} 已查 ${last.completed}／${last.total} 位。重新選同一份原檔會接著查。` : `上次原檔：${last.name}。這是舊版進度，重新匯入後由本版核對待查者。`;
          state.booted = true;
          ui2.show("紀錄準備好了；本版只搜尋，不發訊息、不開對話。");
        } catch (error) {
          ui2.fail(error);
        } finally {
          state.busy = false;
          controls();
        }
        return { state, repo, ui: ui2 };
      }
      module.exports = { VERSION, initPrecheck };
    }
  });

  // src/entry-precheck.mjs
  var import_precheck_core = __toESM(require_precheck_core(), 1);
  var import_precheck_storage = __toESM(require_precheck_storage(), 1);
  var import_chat_runtime = __toESM(require_chat_runtime(), 1);
  var import_precheck_ui = __toESM(require_precheck_ui(), 1);
  var API = { ...import_precheck_core.default, ...import_precheck_storage.default, chat: import_chat_runtime.default, VERSION: import_precheck_ui.default.VERSION, init: import_precheck_ui.default.initPrecheck };
  if (typeof window === "undefined") globalThis.__SHOPEE_CANDIDATE_NODE__ = API;
  else import_precheck_ui.default.initPrecheck().catch(() => {
  });
})();
if(typeof window==='undefined'&&typeof module==='object'&&module.exports){module.exports=globalThis.__SHOPEE_CANDIDATE_NODE__;delete globalThis.__SHOPEE_CANDIDATE_NODE__;}
