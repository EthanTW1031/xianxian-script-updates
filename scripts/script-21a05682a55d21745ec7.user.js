// ==UserScript==
// @name         Shopee 回放加單
// @namespace    local.shopee.replay-add-order
// @version      0.1.1
// @description  只讀聊聊回放加單，使用直播解析器，輸出獨立回放 CSV 與核對清單
// @match        https://seller.shopee.tw/new-webchat/conversations*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

// Isolated candidate; Ethan authorized implementation on 2026-10-14.
// Requirements v0.7. No production backfill/publication in this stage.

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
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
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

  // src/replay-core.cjs
  var require_replay_core = __commonJS({
    "src/replay-core.cjs"(exports, module) {
      "use strict";
      var { problem, ordinal, decimal, safeUid, compareIds } = require_util();
      var HEADERS = Object.freeze(["擷取時間", "直播Session", "限定時段序號", "留言ID", "買家UID", "買家帳號", "原始留言", "正規化留言", "商品代號", "品名", "規格尺寸", "數量", "價格", "狀態", "待確認", "來源", "喊單則數", "彙總件數"]);
      var AUDIT_HEADERS = Object.freeze(["買家帳號", "訊息時間（台北）", "這則的第幾行", "原文", "結果", "說明"]);
      function dateParts(digits) {
        if (!/^[0-9]{6}$/u.test(digits)) throw problem("DATE", "標題日期必須是六碼年月日。");
        const year = 2e3 + Number(digits.slice(0, 2)), month = Number(digits.slice(2, 4)), day = Number(digits.slice(4, 6)), d = new Date(Date.UTC(year, month - 1, day));
        if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) throw problem("DATE", "標題日期不是真實年月日，不能開始。");
        return { year, month, day };
      }
      function titleDigits(value) {
        const text = String(value ?? "").normalize("NFKC").trim(), m = text.match(/^回放加單\s*([0-9]{6})$/u);
        if (!m) throw problem("TITLE", "標題要是「回放加單」加六碼年月日，例回放加單261013。");
        dateParts(m[1]);
        return m[1];
      }
      function firstLine(text) {
        return String(text ?? "").replace(/\r\n?/gu, "\n").split("\n")[0].normalize("NFKC").trim();
      }
      function heading(text, digits) {
        const m = firstLine(text).match(/^回放加單\s*([0-9]{6})$/u);
        return !!m && m[1] === digits;
      }
      var pad = (n) => String(n).padStart(2, "0");
      function defaultCutoff(digits) {
        const p = dateParts(digits), d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T09:00:00`;
      }
      function defaultTitle(now = Date.now()) {
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now - 864e5)), get = (t) => parts.find((p) => p.type === t).value;
        return `回放加單${get("year").slice(-2)}${get("month")}${get("day")}`;
      }
      function cutoffMillis(text) {
        const m = String(text ?? "").match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/u);
        if (!m) throw problem("CUTOFF", "請填截止的日期、時間（台北）。");
        const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]), h = Number(m[4]), minute = Number(m[5]), sec = Number(m[6] || 0);
        if (y < 2e3 || y > 2099 || h > 23 || minute > 59 || sec > 59) throw problem("CUTOFF", "截止日期時間不正確。");
        dateParts(`${String(y).slice(-2)}${pad(mo)}${pad(day)}`);
        return Date.UTC(y, mo - 1, day, h, minute, sec) - 288e5;
      }
      function replaySession(digits, codes) {
        const code = [...codes].sort(ordinal)[0], m = code?.match(/^([A-Z])([0-9]{2,3})$/u);
        if (!m) throw problem("CATALOG", "沒有可用商品碼。");
        return `99${digits}${String(m[1].charCodeAt(0) - 64).padStart(2, "0")}${m[2].length}${m[2].padStart(3, "0")}`;
      }
      function nanoIso(ns) {
        if (!decimal(ns)) throw problem("TIME", "訊息奈秒不是完整正整數文字，已停止。");
        const ms = BigInt(ns) / 1000000n;
        if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw problem("TIME", "訊息時間超出安全範圍，已停止。");
        const date = new Date(Number(ms));
        if (!Number.isFinite(date.getTime())) throw problem("TIME", "訊息時間無法轉換，已停止。");
        return date.toISOString();
      }
      function taipeiTime(ns) {
        return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(nanoIso(ns)));
      }
      function compareMessages(a, b) {
        const n = BigInt(a.nano) - BigInt(b.nano);
        return n < 0n ? -1 : n > 0n ? 1 : compareIds(a.id, b.id);
      }
      function createReplayCore({ parser, catalog, csv }) {
        function validate(input, now = Date.now()) {
          const digits = titleDigits(input.title), p = dateParts(digits), startMs = Date.UTC(p.year, p.month - 1, p.day) - 288e5, cutoffMs = cutoffMillis(input.cutoff);
          if (startMs >= cutoffMs) throw problem("PERIOD", "收單開始必須早於截止時間。");
          if (cutoffMs > now) throw problem("NOT_DUE", "還沒到截止時間，之後傳的會漏掉；請截止後再跑，或自行把截止改成現在以前。");
          const imported = catalog.parseCatalogTsv(input.catalogText);
          if (imported.hasBlockingErrors) throw problem("CATALOG", imported.errors.map((e) => e.message).join("\n"));
          if (!imported.validProducts.length) throw problem("CATALOG", "請貼上本場五欄商品清單，不能空白。");
          const products = new Map(imported.validProducts.map((p2) => [p2.productCode, p2])), codes = [...products.keys()].sort(ordinal);
          return { title: `回放加單${digits}`, digits, startMs, cutoffMs, startNs: BigInt(startMs) * 1000000n, cutoffNs: BigInt(cutoffMs) * 1000000n, products, codes, sessionId: replaySession(digits, codes), catalogWarnings: imported.warnings, catalogText: input.catalogText, cutoff: input.cutoff };
        }
        function candidates(searchRows, config) {
          const out = /* @__PURE__ */ new Map();
          for (const row of searchRows) {
            if (!decimal(row.message_nano_time) || !decimal(row.message_id) || !decimal(row.conversation_id) || !safeUid(row.to_id) || typeof row.to_name !== "string" || !row.to_name.trim()) throw problem("DATA", "搜尋買家身分與時間不完整，已停止。");
            const ns = BigInt(row.message_nano_time);
            if (ns < config.startNs || ns >= config.cutoffNs || !heading(row.text, config.digits)) continue;
            const old = out.get(row.conversation_id);
            if (old && (old.to_id !== row.to_id || old.to_name !== row.to_name)) throw problem("DATA", "同一對話的買家身分矛盾，已停止。");
            if (!old) out.set(row.conversation_id, { conversation_id: row.conversation_id, to_id: row.to_id, to_name: row.to_name, titleMessageId: row.message_id, titleNano: row.message_nano_time, titleMessages: [{ id: row.message_id, nano: row.message_nano_time }] });
            else old.titleMessages.push({ id: row.message_id, nano: row.message_nano_time });
          }
          return [...out.values()].sort((a, b) => BigInt(a.titleNano) < BigInt(b.titleNano) ? -1 : BigInt(a.titleNano) > BigInt(b.titleNano) ? 1 : compareIds(a.titleMessageId, b.titleMessageId));
        }
        function build(conversations, config, { complete = true } = {}) {
          const audits = [], items = [], counts = /* @__PURE__ */ new Map(), seenConversations = /* @__PURE__ */ new Set(), seenBuyers = /* @__PURE__ */ new Map();
          let sequence = 0, titleBuyers = 0;
          for (const value of conversations) {
            const c = value.conversation;
            if (!c || !decimal(c.id) || !safeUid(c.to_id) || typeof c.to_name !== "string" || !c.to_name.trim() || typeof c.is_blocked !== "boolean") throw problem("DATA", "回放買家身分或封鎖旗標無法確認，已停止。");
            if (seenConversations.has(c.id) || seenBuyers.has(c.to_name)) throw problem("DATA", "回放對話或買家身分重複，已停止。");
            seenConversations.add(c.id);
            seenBuyers.set(c.to_name, c.to_id);
            if (c.is_blocked) {
              audits.push({ account: c.to_name, nano: value.titleNano || null, line: 0, raw: "", result: "對話已封鎖", detail: "本次買家搜尋確認已封鎖，整位不收。", parts: [] });
              continue;
            }
            let active = false, ended = false, sawTitle = false;
            const messageIds = /* @__PURE__ */ new Set(), messages = [...value.messages].sort(compareMessages);
            for (const message of messages) {
              if (!decimal(message.id) || !decimal(message.nano) || message.conversation_id !== c.id || messageIds.has(message.id)) throw problem("DATA", "訊息身分、歸屬或重複情況不正確，已停止。");
              messageIds.add(message.id);
              if (message.type !== "text") continue;
              if (!safeUid(message.from_id)) throw problem("DATA", "訊息傳送者不是正安全整數，已停止。");
              if (message.from_id !== c.to_id) continue;
              if (typeof message.text !== "string") throw problem("DATA", "買家文字訊息格式不正確，已停止。");
              const ns = BigInt(message.nano), lines = message.text.replace(/\r\n?/gu, "\n").split("\n");
              const add = (raw, index, result, detail) => {
                const a = { account: c.to_name, nano: message.nano, line: index + 1, raw, result, detail, parts: [] };
                audits.push(a);
                return a;
              };
              if (ns < config.startNs || ns >= config.cutoffNs) {
                lines.forEach((raw, index) => {
                  if (raw.trim()) add(raw, index, ns >= config.cutoffNs ? "超過截止" : "不是訂單", ns >= config.cutoffNs ? "時間已到或超過截止，未收。" : "收單開始以前的訊息，未收。");
                });
                continue;
              }
              let begin = 0;
              if (heading(message.text, config.digits)) {
                active = true;
                ended = false;
                sawTitle = true;
                add(lines[0], 0, "不是訂單", "本張加單的開始標題。");
                begin = 1;
              } else if (firstLine(message.text).startsWith("回放加單")) {
                lines.forEach((raw, index) => {
                  if (raw.trim()) add(raw, index, "標題不符", "標題必須在第一行，四個中文字連續、單獨加六碼日期；本則未收。");
                });
                continue;
              }
              for (let index = begin; index < lines.length; index++) {
                const raw = lines[index];
                if (!raw.trim()) continue;
                const compact = raw.normalize("NFKC").replace(/\s/gu, "");
                if (active && compact === "結束") {
                  add(raw, index, "不是訂單", "本張加單到此結束；本行不計。");
                  active = false;
                  ended = true;
                  continue;
                }
                if (!active) {
                  add(raw, index, ended ? "在結束之後" : "不是訂單", ended ? "結束之後、下一個正確標題之前，未收。" : "尚未有本期有效標題，未收。");
                  continue;
                }
                const normalized = parser.normalizeMessage(raw), code = parser.LEADING_PRODUCT_CODE_PATTERN.exec(normalized)?.[1], a = add(raw, index, "不是訂單", "");
                if (!code) {
                  a.result = normalized.includes("+") ? "看不懂" : "不是訂單";
                  a.detail = "沒有有效的開頭商品碼，未放訂單檔。";
                  continue;
                }
                const product = config.products.get(code);
                if (!product) {
                  a.result = "不是這一場的商品碼";
                  a.detail = "只列核對清單，不進本場訂單檔。";
                  continue;
                }
                const parsed = parser.classifyMessage(raw, { activeCode: code, specProfile: product.specProfile });
                if (!parsed.items.length) {
                  a.detail = "抓單判讀為非訂單，未收。";
                  continue;
                }
                for (const part of parsed.items) {
                  if (!["confirmed", "needsReview"].includes(part.status)) throw problem("PARSER", "抓單解析狀態不支援，已停止。");
                  const key = JSON.stringify([c.to_name, part.productCode, part.variantOrSize ?? ""]), n = (counts.get(key) || 0) + 1;
                  counts.set(key, n);
                  const item = { ...part, key, sourceCount: n, order: sequence++, account: c.to_name, uid: String(c.to_id), messageId: message.id, nano: message.nano, capturedAt: nanoIso(message.nano), line: index + 1, raw, normalized, productName: product.productName, price: product.price, audit: a, retained: true };
                  items.push(item);
                  a.parts.push(item);
                }
              }
            }
            if (sawTitle) titleBuyers++;
          }
          const last = /* @__PURE__ */ new Map();
          for (const item of items) if (item.status === "confirmed") last.set(item.key, item);
          for (const item of items) if (item.status === "confirmed" && last.get(item.key) !== item) {
            item.retained = false;
            item.supersededBy = last.get(item.key);
          }
          const retained = items.filter((i) => i.retained).sort((a, b) => {
            const n = BigInt(a.nano) - BigInt(b.nano);
            return n < 0n ? -1 : n > 0n ? 1 : compareIds(a.messageId, b.messageId) || a.line - b.line || a.order - b.order;
          }), rows = retained.map((i) => [i.capturedAt, config.sessionId, "", i.messageId, i.uid, i.account, i.raw, i.normalized, i.productCode, i.productName, i.variantOrSize ?? "", i.quantity ?? "", i.price ?? "", i.status, i.needsReview ? "是" : "否", "observer", String(i.sourceCount), i.status === "confirmed" ? i.quantity ?? "" : ""]);
          for (const a of audits) if (a.parts.length) {
            const labels = [];
            const details = [];
            for (const i of a.parts) {
              const label = !i.retained ? "被同款後一次取代" : i.status === "confirmed" ? "已確認（收進檔）" : "待確認（收進檔）";
              if (!labels.includes(label)) labels.push(label);
              details.push(`${i.productCode} ${i.variantOrSize || "無規格"} ×${i.quantity ?? "（數量空白）"}：${label}${i.supersededBy ? `，被訊息 ${i.supersededBy.messageId} 第 ${i.supersededBy.line} 行取代` : ""}`);
            }
            a.result = labels.join("／");
            a.detail = details.join("；") + "。收進檔不等於成立，最後由控貨助手判斷。";
          }
          const positive = retained.filter((i) => Number.isSafeInteger(i.quantity) && i.quantity > 0), buyerSet = new Set(retained.map((i) => i.account)), confirmed = retained.filter((i) => i.status === "confirmed").length, pending = retained.length - confirmed;
          const resultCounts = {};
          for (const a of audits) {
            if (!a.parts.length) resultCounts[a.result] = (resultCounts[a.result] || 0) + 1;
          }
          return { config, complete, rows, audits, canExport: complete && positive.length > 0, summary: { titleBuyers, exportBuyers: buyerSet.size, rows: rows.length, confirmed, pending, zero: retained.filter((i) => i.quantity == null).length, positiveRows: positive.length, notCollected: resultCounts } };
        }
        function ordersCsv(result) {
          if (!result.canExport) throw problem("EXPORT", "沒有完整的正數量訂單列，不能匯出叫貨用檔。");
          return "\uFEFF" + [csv.serializeCsvRow(HEADERS, { dataRow: false }), ...result.rows.map((r) => csv.serializeCsvRow(r))].join("\r\n");
        }
        function auditCsv(result) {
          const rows = [AUDIT_HEADERS];
          if (!result.complete) rows.push(["", "", "", "", "不是訂單", "本次沒有讀完，不能用；這份只供核對，不能叫貨。"]);
          for (const a of result.audits) rows.push([a.account, a.nano ? taipeiTime(a.nano) : "", a.line || "", a.raw, a.result, a.detail]);
          return "\uFEFF" + rows.map((row, index) => row.map((value, column) => {
            const text = index > 0 && column === 0 ? csv.protectBuyerAccountValue(value) : index > 0 ? csv.protectSpreadsheetValue(value) : String(value ?? "");
            return csv.escapeCsvCell(text);
          }).join(",")).join("\r\n");
        }
        function filenames(config, complete = true) {
          const prefix = `${config.title}_${config.codes[0]}起`;
          return { orders: prefix + ".csv", audit: prefix + (complete ? "" : "_未讀完") + "_核對清單.csv" };
        }
        return { HEADERS, AUDIT_HEADERS, dateParts, titleDigits, heading, defaultTitle, defaultCutoff, cutoffMillis, replaySession, nanoIso, taipeiTime, validate, candidates, build, ordersCsv, auditCsv, filenames };
      }
      module.exports = { HEADERS, AUDIT_HEADERS, dateParts, titleDigits, heading, defaultTitle, defaultCutoff, cutoffMillis, replaySession, nanoIso, taipeiTime, createReplayCore };
    }
  });

  // src/chat-runtime.cjs
  var require_chat_runtime = __commonJS({
    "src/chat-runtime.cjs"(exports, module) {
      "use strict";
      var { problem, norm, decimal, safeUid, compareIds, canonical } = require_util();
      var LOCK_NAME = "shopee-settlement-notice:send";
      var PANELS = "[data-account-precheck],[data-settlement-notice],[data-winlist-shopee],[data-replay-add-order]";
      var LIMITS = Object.freeze({ root: 3e4, query: 15e3, page: 15e3, conversation: 1e4, poll: 200 });
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
        const entries = [...document.querySelectorAll('input[placeholder*="搜尋"]')].filter((e) => visible(e) && !e.closest(PANELS));
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
      async function ensureScope(mode, stop) {
        const input = inputElement(), labels = SCOPE_LABELS[mode], store = findStore(input), filter = store?.getState()?.searchReducer?.searchFilter;
        if (!store || !["string", "number"].includes(typeof filter)) throw problem("SCOPE", "無法核對搜尋範圍資料，已停止。");
        const bindings = scopeBindings.get(store) || {};
        if (bindings[mode] === filter || labels.includes(scopeText(input))) {
          bindings[mode] = filter;
          scopeBindings.set(store, bindings);
          return input;
        }
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
        const option = await wait(() => {
          const matches = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li,span')].filter((e) => visible(e) && !e.closest(PANELS) && nearSearch(e, input) && labels.includes(norm(e.textContent))).map(clickOwner).filter((e, i, a) => e && a.indexOf(e) === i);
          return matches.length === 1 ? matches[0] : null;
        }, 3e3, stop, "SCOPE", "搜尋範圍選項無法確認，已停止。");
        activate(option);
        await wait(() => labels.includes(scopeText(inputElement())) || !document.contains(option) || !visible(option), 3e3, stop, "SCOPE", "搜尋範圍切換未確認，已停止。");
        const after = store.getState()?.searchReducer?.searchFilter;
        if (!["string", "number"].includes(typeof after) || Object.entries(bindings).some(([key, value]) => key !== mode && value === after)) throw problem("SCOPE", "搜尋範圍資料無法區分，已停止。");
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
        const seen = /* @__PURE__ */ new Set(), messages = rel.all.map((mid) => {
          if (!decimal(mid) || seen.has(mid)) throw problem("DATA", "對話訊息編號重複或格式不正確，已停止。");
          seen.add(mid);
          const m = s.entityReducer.messages?.[mid];
          if (!object(m) || m.id !== mid || m.conversation_id !== id || !decimal(m.created_timestamp_nano) || !Number.isSafeInteger(m.created_timestamp) || BigInt(m.created_timestamp_nano) / 1000000000n !== BigInt(m.created_timestamp) || typeof m.type !== "string") throw problem("DATA", "訊息實體、時間或對話歸屬無法確認，已停止。");
          if (m.type === "text" && (!safeUid(m.from_id) || typeof m.content?.text !== "string")) throw problem("DATA", "文字訊息的傳送者或內容格式無法確認，已停止。");
          return { id: m.id, conversation_id: id, nano: m.created_timestamp_nano, seconds: m.created_timestamp, from_id: m.from_id, type: m.type, text: m.type === "text" ? m.content.text : "" };
        });
        for (let i = 1; i < messages.length; i++) if (BigInt(messages[i].nano) > BigInt(messages[i - 1].nano) || messages[i].nano === messages[i - 1].nano && compareIds(messages[i].id, messages[i - 1].id) > 0) throw problem("DATA", "對話訊息排序與預期不同，已停止。");
        return { conversation: { id, to_name: c.to_name, to_id: c.to_id, is_blocked: c.is_blocked }, messages, hasMoreOlder: rel.hasMoreOlderMessage };
      }
      function assertCandidateTitlesRead(value, candidate) {
        if (value.conversation.is_blocked) return;
        const expected = candidate.titleMessages ?? [{ id: candidate.titleMessageId, nano: candidate.titleNano }];
        const found = new Map(value.messages.map((message) => [message.id, message]));
        if (!Array.isArray(expected) || !expected.length || value.conversation.id !== candidate.conversation_id || expected.some((title) => {
          const message = found.get(title?.id);
          return !decimal(title?.id) || !decimal(title?.nano) || !message || message.conversation_id !== candidate.conversation_id || message.nano !== title.nano;
        })) throw problem("TITLE_NOT_READ", "對話沒有讀到與搜尋結果相符的標題訊息（訊息缺少或奈秒時間不同），讀取不完整，已停止。");
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
          }, timing.root, stop, "NOT_READY", "聊聊資料還沒準備好／讀不到資料，請等頁面載完再試。");
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
          let scroller = null;
          while (true) {
            safe(stop);
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
          const value = { conversation: frame.conversation, messages: [...collected.values()], hasMoreOlder: frame.hasMoreOlder };
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

  // src/replay-ui.cjs
  var require_replay_ui = __commonJS({
    "src/replay-ui.cjs"(exports, module) {
      "use strict";
      var chat2 = require_chat_runtime();
      var { problem, safeMessage } = require_util();
      var { mountPanel, gmAdapter } = require_panel();
      var VERSION = "0.1.1";
      var STORE = Object.freeze({ config: "replay:config:v1", panelPosition: "replay:panel-position:v1" });
      async function initReplay(core2) {
        const gm = gmAdapter(), ui2 = mountPanel({ attribute: "data-replay-add-order", title: `回放加單 v${VERSION}（只讀）`, colour: "#86501a", position: { left: Math.min(Math.round(innerWidth * 0.55), Math.max(18, innerWidth - 380)), top: 80 }, gm, positionKey: STORE.panelPosition, html: `
    <label>本期標題<input data-title></label><label>截止日期時間（台北）<input data-cutoff type="datetime-local" step="1"></label>
    <label>本場五欄商品清單<textarea data-catalog placeholder="商品碼、品名、顏色、尺寸、價格；從 Excel 複製貼上"></textarea></label><p data-preview class="mini"></p>
    <button data-start class="primary">核對後開始讀取</button><button data-stop class="danger stop hidden">緊急停止</button><p data-status class="status">請截止後再讀取。</p><p data-summary class="mini"></p>
    <div class="actions"><button data-export-orders disabled>匯出回放訂單檔</button><button data-export-audit disabled>匯出核對清單</button></div><p class="mini">本次讀到的買家文字才列入核對；不是全店普查。讀不完整不出叫貨檔。回放期間不要開始發明細。同一份檔只建一場、灌一次。</p><pre data-log></pre>` });
        if (!ui2) return;
        const $ = ui2.$, state = { running: false, stop: false, result: null, config: null, conversations: [], catalogWarnings: [], cutoffEdited: false };
        const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(/* @__PURE__ */ new Date());
        const initialTitle = core2.defaultTitle(), initialCutoff = core2.defaultCutoff(core2.titleDigits(initialTitle));
        let saved;
        try {
          saved = await gm.get(STORE.config, null);
        } catch {
          saved = null;
        }
        $("[data-title]").value = saved?.savedForDay === today() && typeof saved.title === "string" ? saved.title : initialTitle;
        $("[data-cutoff]").value = saved?.savedForDay === today() && typeof saved.cutoff === "string" ? saved.cutoff : initialCutoff;
        $("[data-catalog]").value = typeof saved?.catalogText === "string" ? saved.catalogText : "";
        try {
          state.cutoffEdited = $("[data-cutoff]").value !== core2.defaultCutoff(core2.titleDigits($("[data-title]").value));
        } catch {
          state.cutoffEdited = true;
        }
        async function save() {
          try {
            await gm.set(STORE.config, { title: $("[data-title]").value, cutoff: $("[data-cutoff]").value, catalogText: $("[data-catalog]").value, savedForDay: today() });
          } catch {
            ui2.show("設定沒有保存成功；仍可核對本次輸入，關頁前請自行保留商品清單。", true);
          }
        }
        function invalidate() {
          state.result = null;
          state.config = null;
          $("[data-summary]").textContent = "";
          controls();
        }
        function controls() {
          for (const s of ["[data-title]", "[data-cutoff]", "[data-catalog]", "[data-start]"]) $(s).disabled = state.running;
          $("[data-stop]").classList.toggle("hidden", !state.running);
          $("[data-export-orders]").disabled = state.running || !state.result?.canExport;
          $("[data-export-audit]").disabled = state.running || !state.result;
        }
        function input() {
          return { title: $("[data-title]").value, cutoff: $("[data-cutoff]").value, catalogText: $("[data-catalog]").value };
        }
        function preview() {
          try {
            const c = core2.validate(input());
            $("[data-preview]").textContent = `${c.title}；${c.codes.length} 個商品，${c.codes[0]}～${c.codes.at(-1)}；回放場次 ${c.sessionId}。`;
          } catch (error) {
            $("[data-preview]").textContent = safeMessage(error);
          }
        }
        $("[data-title]").addEventListener("input", () => {
          if (!state.cutoffEdited) {
            try {
              $("[data-cutoff]").value = core2.defaultCutoff(core2.titleDigits($("[data-title]").value));
            } catch {
            }
          }
          invalidate();
          preview();
          save();
        });
        $("[data-cutoff]").addEventListener("input", () => {
          state.cutoffEdited = true;
          invalidate();
          preview();
          save();
        });
        $("[data-catalog]").addEventListener("input", () => {
          invalidate();
          preview();
          save();
        });
        $("[data-stop]").addEventListener("click", () => {
          state.stop = true;
          ui2.show("停止中；不會再讀下一批，也不會出叫貨用檔。");
        });
        function showSummary(result) {
          const s = result.summary;
          $("[data-summary]").textContent = `${result.complete ? "讀取完成" : "沒有讀完，不能用"}。有效標題買家 ${s.titleBuyers} 位；收進檔 ${s.exportBuyers} 位、${s.rows} 列（確認 ${s.confirmed}、待確認 ${s.pending}，其中數量空白 ${s.zero}）。${Object.entries(s.notCollected).map(([k, v]) => `${k} ${v} 行`).join("、")}`;
        }
        $("[data-start]").addEventListener("click", async () => {
          if (state.running) return;
          let config;
          try {
            config = core2.validate(input());
            const warnings = config.catalogWarnings.length ? `
商品清單提醒：${config.catalogWarnings.map((w) => w.message).join("；")}` : "";
            if (!confirm(`核對本次回放：${config.title}
期間：${core2.taipeiTime(String(config.startNs))} 起～${core2.taipeiTime(String(config.cutoffNs))} 前
${config.codes.length} 個商品（${config.codes[0]}～${config.codes.at(-1)}）
場次編號：${config.sessionId}${warnings}
只讀訊息，不發送。確定開始？`)) return;
          } catch (error) {
            ui2.fail(error);
            return;
          }
          state.running = true;
          state.stop = false;
          state.result = null;
          state.config = config;
          state.conversations = [];
          controls();
          let readingCandidate = null;
          const runtime = chat2.createChatRuntime({ stop: () => state.stop, onStatus: ui2.show, allowConversation: true });
          try {
            await chat2.withLock(async () => {
              await runtime.ready(true);
              const search = await runtime.collectSearch(config.startNs), candidates = core2.candidates(search, config);
              ui2.log(`找到 ${candidates.length} 個本期候選對話。`);
              for (let i = 0; i < candidates.length; i++) {
                runtime.safe();
                ui2.show(`讀取候選對話 ${i + 1}／${candidates.length}`);
                readingCandidate = candidates[i];
                const value = await runtime.readConversation(readingCandidate, config.startNs);
                value.titleNano = candidates[i].titleNano;
                state.conversations.push(value);
                state.result = core2.build(state.conversations, config, { complete: false });
                showSummary(state.result);
                readingCandidate = null;
              }
              runtime.safe();
              state.result = core2.build(state.conversations, config, { complete: true });
              await runtime.cleanup();
              showSummary(state.result);
              ui2.show(state.result.canExport ? "讀取完成，請核對清單後匯出回放訂單檔。" : "這次沒有可交給控貨助手處理的正數量訂單列，只匯出核對清單。");
            });
          } catch (error) {
            state.result = state.result ? { ...state.result, complete: false, canExport: false } : core2.build([], config, { complete: false });
            if (error.code === "TITLE_NOT_READ" && readingCandidate) {
              state.result = { ...state.result, audits: [...state.result.audits, { account: readingCandidate.to_name, nano: readingCandidate.titleNano, line: 0, raw: "", result: "讀取不完整", detail: safeMessage(error), parts: [] }], summary: { ...state.result.summary, notCollected: { ...state.result.summary.notCollected, "讀取不完整": 1 } } };
            }
            showSummary(state.result);
            ui2.fail(error);
            ui2.log("本次未讀完，正式訂單檔不提供；請確認頁面與網路後整個重跑。");
          } finally {
            state.running = false;
            controls();
          }
        });
        $("[data-export-orders]").addEventListener("click", () => {
          if (state.running || !state.result?.canExport) return;
          try {
            const names = core2.filenames(state.config, true);
            if (confirm(`匯出 ${state.result.summary.exportBuyers} 位、${state.result.rows.length} 列？
收進檔不等於成立，最後以控貨助手判斷為準。
本檔只建一個新場次、只灌一次。`)) ui2.download(core2.ordersCsv(state.result), names.orders);
          } catch (error) {
            ui2.fail(error);
          }
        });
        $("[data-export-audit]").addEventListener("click", () => {
          if (state.running || !state.result) return;
          try {
            const names = core2.filenames(state.config, state.result.complete);
            ui2.download(core2.auditCsv(state.result), names.audit);
          } catch (error) {
            ui2.fail(error);
          }
        });
        preview();
        controls();
        return { state, ui: ui2 };
      }
      module.exports = { VERSION, STORE, initReplay };
    }
  });

  // vendor/live-capture/parser.js
  var parser_exports = {};
  __export(parser_exports, {
    BUILTIN_SPEC_KEYWORDS: () => BUILTIN_SPEC_KEYWORDS,
    CONFIRMED_ORDER_PATTERN: () => CONFIRMED_ORDER_PATTERN,
    LEADING_PRODUCT_CODE_PATTERN: () => LEADING_PRODUCT_CODE_PATTERN,
    PACKAGE_COLOR_KEYWORD: () => PACKAGE_COLOR_KEYWORD,
    PRODUCT_CODE_PATTERN: () => PRODUCT_CODE_PATTERN,
    SPEC_DIMENSIONS: () => SPEC_DIMENSIONS,
    canonicalizeSpecKeyword: () => canonicalizeSpecKeyword,
    classifyMessage: () => classifyMessage,
    compileSpecProfile: () => compileSpecProfile,
    normalizeMessage: () => normalizeMessage,
    normalizeProductCode: () => normalizeProductCode,
    parsePastOrderPrefix: () => parsePastOrderPrefix,
    tokenizeSpecText: () => tokenizeSpecText
  });

  // vendor/live-capture/constants.js
  var APP_PREFIX = "slocc:v1";
  var SESSION_KEY_PREFIX = `${APP_PREFIX}:session:`;
  var TAB_ID_KEY = `${APP_PREFIX}:tab-id`;
  var TAB_SESSION_KEY = `${APP_PREFIX}:tab-session`;
  var PRICE_REQUIRED_PREF_KEY = `${APP_PREFIX}:pref:priceRequired`;
  var COMMENT_HOST_SELECTOR = [
    '[class*="comment-content_"]',
    ".ReactVirtualized__List",
    ".ReactVirtualized__Grid",
    '[role="grid"]'
  ].join(",");
  var MAX_QUANTITY = 99;
  var RAW_CLASSIFICATIONS = Object.freeze({
    CONFIRMED: "confirmed",
    NEEDS_REVIEW: "needsReview",
    INACTIVE_CODE: "inactiveCode",
    PAUSED: "paused",
    CHAT: "chat",
    HOST: "host",
    PRODUCT_INQUIRY: "productInquiry"
  });
  var CAPTURE_ORIGINS = Object.freeze({
    INITIAL_SCAN: "initialScan",
    OBSERVER: "observer"
  });

  // vendor/live-capture/parser.js
  var PRODUCT_CODE_PATTERN = /^[A-Z][0-9]{2,3}$/u;
  var LEADING_PRODUCT_CODE_PATTERN = /^([A-Z](?:[0-9]{3}|[0-9]{2}))(?![0-9])/u;
  var CONFIRMED_ORDER_PATTERN = /^(?<productCode>[A-Z][0-9]{2,3})(?:\s+(?<variantOrSize>[A-Z0-9_-]{1,10}))?\s*\+\s*(?<quantity>[0-9]+)$/u;
  var SPEC_DIMENSIONS = Object.freeze({
    STYLE: "style",
    SIZE: "size"
  });
  var CLOTHING_SIZES = ["XS", "S", "M", "L", "XL", "XX", "XXL", "3L"];
  var SHOE_SIZES = Array.from({ length: 21 }, (_, index) => {
    const value = 35 + index / 2;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  });
  var COLORS = [
    "黑",
    "白",
    "灰",
    "藍",
    "綠",
    "粉",
    "黃",
    "杏",
    "紫",
    "紅",
    "咖",
    "奶",
    "燕",
    "可",
    "深灰",
    "淺灰",
    "深藍",
    "淺藍",
    "中灰",
    "中藍",
    "米灰"
  ];
  var BUILTIN_SPEC_KEYWORDS = Object.freeze({
    clothingSizes: Object.freeze(CLOTHING_SIZES),
    shoeSizes: Object.freeze(SHOE_SIZES),
    colors: Object.freeze(COLORS)
  });
  var PRODUCT_CODE_ANYWHERE_PATTERN = /[A-Z](?:[0-9]{3}|[0-9]{2})(?![0-9])/gu;
  var CUSTOM_KEYWORD_PRODUCT_CODE_PATTERN = /[A-Z][0-9]{2,3}(?![0-9])/u;
  var QUANTITY_MARKER_PATTERN = /\+\s*([0-9]+)/gu;
  var INVALID_CUSTOM_KEYWORD_PATTERN = /[+,\r\n]/u;
  var PAST_ORDER_MARKER = "過款";
  var PACKAGE_COLOR_KEYWORD = "包色";
  function normalizeMessage(value) {
    return String(value ?? "").normalize("NFKC").toUpperCase().trim().replace(/\s+/gu, " ");
  }
  function normalizeProductCode(value) {
    const normalized = normalizeMessage(value);
    return PRODUCT_CODE_PATTERN.test(normalized) ? normalized : null;
  }
  function canonicalizeSpecKeyword(value) {
    return normalizeMessage(value).replace(/\s+/gu, "");
  }
  function parsePastOrderPrefix(normalizedMessage) {
    if (!normalizedMessage.startsWith(PAST_ORDER_MARKER)) {
      return { marked: false, productCode: null, payload: null };
    }
    const payload = normalizedMessage.slice(PAST_ORDER_MARKER.length).trimStart();
    const productCode = payload.match(LEADING_PRODUCT_CODE_PATTERN)?.[1] ?? null;
    return { marked: true, productCode, payload };
  }
  function createTrie() {
    return { children: /* @__PURE__ */ new Map(), terminal: null };
  }
  function addTrieKeyword(root, keyword) {
    let node = root;
    for (const character of keyword.canonical) {
      if (!node.children.has(character)) {
        node.children.set(character, createTrie());
      }
      node = node.children.get(character);
    }
    node.terminal = keyword;
  }
  function builtinKeywordRecords() {
    return [
      ...COLORS.map((value) => ({ value, dimension: SPEC_DIMENSIONS.STYLE })),
      ...CLOTHING_SIZES.map((value) => ({ value, dimension: SPEC_DIMENSIONS.SIZE })),
      ...SHOE_SIZES.map((value) => ({ value, dimension: SPEC_DIMENSIONS.SIZE }))
    ];
  }
  function codePointLength(value) {
    return [...value].length;
  }
  function compileSpecProfile(profile = {}) {
    if (profile?.compiled === true) return profile;
    const errors = [];
    const mode = profile?.mode ?? "unset";
    const keywordByCanonical = /* @__PURE__ */ new Map();
    for (const entry of builtinKeywordRecords()) {
      const canonical = canonicalizeSpecKeyword(entry.value);
      keywordByCanonical.set(canonical, {
        canonical,
        value: entry.value,
        dimension: entry.dimension,
        custom: false,
        selected: false
      });
    }
    const sourceSlots = Array.isArray(profile?.customSlots) ? profile.customSlots : [];
    const customSlots = sourceSlots.map((source = {}, index) => {
      const value = normalizeMessage(source.value ?? "");
      const canonical = canonicalizeSpecKeyword(value);
      const selected = source.selected === true;
      const dimension = source.dimension ?? SPEC_DIMENSIONS.STYLE;
      if (!Object.values(SPEC_DIMENSIONS).includes(dimension)) {
        errors.push({
          code: "invalidCustomKeywordDimension",
          slot: index,
          value,
          dimension
        });
      }
      if (!canonical) {
        if (selected) errors.push({ code: "emptySelectedCustomKeyword", slot: index });
        return { value: "", canonical: "", selected, dimension };
      }
      if (codePointLength(canonical) > 10 || INVALID_CUSTOM_KEYWORD_PATTERN.test(value)) {
        errors.push({ code: "invalidCustomKeyword", slot: index, value });
        return { value, canonical, selected, dimension };
      }
      if (CUSTOM_KEYWORD_PRODUCT_CODE_PATTERN.test(canonical)) {
        errors.push({ code: "customKeywordIsProductCode", slot: index, value });
        return { value, canonical, selected, dimension };
      }
      if (canonical === PACKAGE_COLOR_KEYWORD) {
        errors.push({
          code: "customKeywordIsReserved",
          slot: index,
          value,
          reserved: PACKAGE_COLOR_KEYWORD
        });
        return { value, canonical, selected, dimension };
      }
      if (keywordByCanonical.has(canonical)) {
        errors.push({ code: "duplicateCustomKeyword", slot: index, value });
        return { value, canonical, selected, dimension };
      }
      keywordByCanonical.set(canonical, {
        canonical,
        value,
        dimension,
        custom: true,
        selected: false
      });
      return { value, canonical, selected, dimension };
    });
    const requestedSelected = /* @__PURE__ */ new Set();
    for (const dimension of Object.values(SPEC_DIMENSIONS)) {
      for (const value of profile?.selected?.[dimension] ?? []) {
        requestedSelected.add(canonicalizeSpecKeyword(value));
      }
    }
    for (const slot of customSlots) {
      if (slot.selected && slot.canonical) requestedSelected.add(slot.canonical);
    }
    for (const canonical of requestedSelected) {
      const keyword = keywordByCanonical.get(canonical);
      if (!keyword) {
        errors.push({ code: "unknownSelectedKeyword", value: canonical });
        continue;
      }
      keyword.selected = true;
    }
    const selectedByDimension = {
      [SPEC_DIMENSIONS.STYLE]: [],
      [SPEC_DIMENSIONS.SIZE]: []
    };
    for (const keyword of keywordByCanonical.values()) {
      if (keyword.selected) selectedByDimension[keyword.dimension].push(keyword.canonical);
    }
    const selectedCount = Object.values(selectedByDimension).reduce((total, values) => total + values.length, 0);
    const remainingStyles = new Set(selectedByDimension[SPEC_DIMENSIONS.STYLE]);
    const selectedStylesInDisplayOrder = [];
    for (const value of profile?.displayOrder ?? []) {
      const canonical = canonicalizeSpecKeyword(value);
      if (remainingStyles.delete(canonical)) selectedStylesInDisplayOrder.push(canonical);
    }
    selectedStylesInDisplayOrder.push(...remainingStyles);
    if (!["withSpecs", "noSpecs"].includes(mode)) {
      errors.push({ code: "profileModeUnset" });
    } else if (mode === "withSpecs" && selectedCount === 0) {
      errors.push({ code: "noSelectedKeywords" });
    } else if (mode === "noSpecs" && selectedCount > 0) {
      errors.push({ code: "noSpecsHasSelections" });
    }
    const trie = createTrie();
    for (const keyword of keywordByCanonical.values()) addTrieKeyword(trie, keyword);
    return {
      compiled: true,
      valid: errors.length === 0,
      errors,
      mode,
      customSlots,
      keywordByCanonical,
      selectedByDimension,
      selectedStylesInDisplayOrder,
      activeDimensions: Object.entries(selectedByDimension).filter(([, values]) => values.length > 0).map(([dimension]) => dimension),
      trie,
      profileRevision: profile?.profileRevision ?? null
    };
  }
  function tokenizeSpecText(value, compiledProfile) {
    const profile = compileSpecProfile(compiledProfile);
    const canonicalText = canonicalizeSpecKeyword(value);
    const tokens = [];
    const unknown = [];
    let cursor = 0;
    while (cursor < canonicalText.length) {
      let node = profile.trie;
      let lookahead = cursor;
      let terminal = null;
      let terminalEnd = cursor;
      while (lookahead < canonicalText.length) {
        node = node.children.get(canonicalText[lookahead]);
        if (!node) break;
        lookahead += 1;
        if (node.terminal) {
          terminal = node.terminal;
          terminalEnd = lookahead;
        }
      }
      const packageEnd = canonicalText.startsWith(PACKAGE_COLOR_KEYWORD, cursor) ? cursor + PACKAGE_COLOR_KEYWORD.length : cursor;
      if (packageEnd > terminalEnd) {
        terminal = {
          canonical: PACKAGE_COLOR_KEYWORD,
          value: PACKAGE_COLOR_KEYWORD,
          kind: "packageColor"
        };
        terminalEnd = packageEnd;
      }
      if (!terminal) {
        unknown.push(canonicalText[cursor]);
        cursor += 1;
        continue;
      }
      tokens.push(terminal);
      cursor = terminalEnd;
    }
    return { canonicalText, tokens, unknown: unknown.join("") };
  }
  function compatibleResult(normalizedMessage, classification, items = []) {
    return {
      normalizedMessage,
      classification,
      items,
      item: items[0] ?? null
    };
  }
  function reviewItem(productCode, fields = {}) {
    const item = {
      productCode,
      variantOrSize: fields.variantOrSize ?? "",
      specifications: fields.specifications ?? { style: null, size: null },
      specKey: fields.specKey ?? null,
      quantity: fields.quantity ?? null,
      segmentIndex: fields.segmentIndex ?? 0,
      segmentRaw: fields.segmentRaw ?? "",
      status: RAW_CLASSIFICATIONS.NEEDS_REVIEW,
      needsReview: true,
      reviewReason: fields.reviewReason ?? "malformedSegment",
      ruleVersion: fields.ruleVersion ?? 1,
      profileRevision: fields.profileRevision ?? null
    };
    if (Number.isSafeInteger(fields.expansionIndex)) {
      item.expansionIndex = fields.expansionIndex;
    }
    return item;
  }
  function parseLooseIntent(normalizedMessage, activeCode) {
    if (!activeCode || !normalizedMessage.startsWith(activeCode)) {
      return { productCode: null, variantOrSize: "", quantity: null };
    }
    const afterCode = normalizedMessage.slice(activeCode.length);
    const plusMatch = afterCode.match(/^(.*?)\s*\+\s*([0-9]+)/u);
    if (!plusMatch) {
      return {
        productCode: activeCode,
        variantOrSize: afterCode.replace("+", "").trim().slice(0, 30),
        quantity: null
      };
    }
    return {
      productCode: activeCode,
      variantOrSize: plusMatch[1].trim().slice(0, 30),
      quantity: Number.parseInt(plusMatch[2], 10)
    };
  }
  function confirmationDowngradeReason(options) {
    if (options.captureOrigin === CAPTURE_ORIGINS.INITIAL_SCAN) return "initialScan";
    if (options.stable === false) return "unstableSnapshot";
    if (options.hasReliableCommentId === false) return "fallbackCommentId";
    return null;
  }
  function segmentItems({
    activeCode,
    compiledProfile,
    segmentIndex,
    segmentRaw,
    specText,
    quantity,
    bareSegment,
    downgradeReason
  }) {
    const profileRevision = compiledProfile.profileRevision;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return [reviewItem(activeCode, {
        segmentIndex,
        segmentRaw,
        quantity: Number.isSafeInteger(quantity) ? quantity : null,
        reviewReason: "quantityOutOfRange",
        profileRevision
      })];
    }
    if (bareSegment) {
      return [reviewItem(activeCode, {
        segmentIndex,
        segmentRaw,
        quantity,
        reviewReason: "bareSegment",
        profileRevision
      })];
    }
    if (!compiledProfile.valid) {
      return [reviewItem(activeCode, {
        segmentIndex,
        segmentRaw,
        quantity,
        reviewReason: "invalidSpecProfile",
        profileRevision
      })];
    }
    const tokenized = tokenizeSpecText(specText, compiledProfile);
    if (compiledProfile.mode === "noSpecs") {
      if (tokenized.canonicalText) {
        return [reviewItem(activeCode, {
          segmentIndex,
          segmentRaw,
          quantity,
          reviewReason: "unexpectedSpec",
          profileRevision
        })];
      }
    }
    const packageTokens = tokenized.tokens.filter(
      (token) => token.kind === "packageColor"
    );
    if (packageTokens.length > 0) {
      const packageOnly = tokenized.unknown === "" && tokenized.tokens.length === 1 && packageTokens.length === 1 && tokenized.canonicalText === PACKAGE_COLOR_KEYWORD;
      if (!packageOnly) {
        return [reviewItem(activeCode, {
          segmentIndex,
          segmentRaw,
          variantOrSize: tokenized.canonicalText.slice(0, 30),
          quantity,
          reviewReason: "packageColorMixedSpec",
          profileRevision
        })];
      }
      if (compiledProfile.selectedStylesInDisplayOrder.length === 0) {
        return [reviewItem(activeCode, {
          segmentIndex,
          segmentRaw,
          variantOrSize: PACKAGE_COLOR_KEYWORD,
          quantity,
          reviewReason: "packageColorNoStyles",
          profileRevision
        })];
      }
      return compiledProfile.selectedStylesInDisplayOrder.map(
        (style, expansionIndex) => {
          const specifications2 = {
            [SPEC_DIMENSIONS.STYLE]: style,
            [SPEC_DIMENSIONS.SIZE]: null
          };
          const specKey2 = `v1:${JSON.stringify([style, ""])}`;
          if (downgradeReason) {
            return reviewItem(activeCode, {
              segmentIndex,
              expansionIndex,
              segmentRaw,
              variantOrSize: style,
              specifications: specifications2,
              specKey: specKey2,
              quantity,
              reviewReason: downgradeReason,
              profileRevision
            });
          }
          return {
            productCode: activeCode,
            variantOrSize: style,
            specifications: specifications2,
            specKey: specKey2,
            quantity,
            segmentIndex,
            expansionIndex,
            segmentRaw,
            status: RAW_CLASSIFICATIONS.CONFIRMED,
            needsReview: false,
            reviewReason: null,
            ruleVersion: 1,
            profileRevision
          };
        }
      );
    }
    const tokensByDimension = {
      [SPEC_DIMENSIONS.STYLE]: [],
      [SPEC_DIMENSIONS.SIZE]: []
    };
    for (const token of tokenized.tokens) tokensByDimension[token.dimension].push(token);
    const missingDimension = compiledProfile.activeDimensions.find(
      (dimension) => tokensByDimension[dimension].length === 0
    );
    const multipleDimension = Object.values(SPEC_DIMENSIONS).find(
      (dimension) => tokensByDimension[dimension].length > 1
    );
    const unselected = tokenized.tokens.find((token) => !token.selected);
    const reviewReason = tokenized.unknown || unselected ? "unknownSpecText" : missingDimension ? "missingDimension" : multipleDimension ? "multipleValuesInDimension" : null;
    const specifications = {
      [SPEC_DIMENSIONS.STYLE]: tokensByDimension[SPEC_DIMENSIONS.STYLE][0]?.canonical ?? null,
      [SPEC_DIMENSIONS.SIZE]: tokensByDimension[SPEC_DIMENSIONS.SIZE][0]?.canonical ?? null
    };
    const variantOrSize = [specifications.style, specifications.size].filter(Boolean).join("");
    const specKey = `v1:${JSON.stringify([
      specifications.style ?? "",
      specifications.size ?? ""
    ])}`;
    if (reviewReason || downgradeReason) {
      return [reviewItem(activeCode, {
        segmentIndex,
        segmentRaw,
        variantOrSize,
        specifications,
        specKey,
        quantity,
        reviewReason: reviewReason ?? downgradeReason,
        profileRevision
      })];
    }
    return [{
      productCode: activeCode,
      variantOrSize,
      specifications,
      specKey,
      quantity,
      segmentIndex,
      segmentRaw,
      status: RAW_CLASSIFICATIONS.CONFIRMED,
      needsReview: false,
      reviewReason: null,
      ruleVersion: 1,
      profileRevision
    }];
  }
  function differentProductCode(normalizedMessage, activeCode) {
    const codes = normalizedMessage.match(PRODUCT_CODE_ANYWHERE_PATTERN) ?? [];
    return codes.find((code) => code !== activeCode) ?? null;
  }
  function classifySegmented(normalizedMessage, activeCode, profile, options) {
    const compiledProfile = compileSpecProfile(profile);
    const conflictingCode = differentProductCode(normalizedMessage, activeCode);
    if (conflictingCode) {
      return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.NEEDS_REVIEW, [
        reviewItem(activeCode, {
          segmentRaw: normalizedMessage,
          reviewReason: "crossProductCode",
          profileRevision: compiledProfile.profileRevision
        })
      ]);
    }
    const items = [];
    const downgradeReason = confirmationDowngradeReason(options);
    let cursor = activeCode.length;
    let segmentIndex = 0;
    while (cursor < normalizedMessage.length) {
      while (normalizedMessage[cursor] === " ") cursor += 1;
      if (cursor >= normalizedMessage.length) break;
      const segmentStart = cursor;
      let repeatedCode = false;
      const nextCode = normalizedMessage.slice(cursor).match(LEADING_PRODUCT_CODE_PATTERN)?.[1];
      if (nextCode === activeCode) {
        repeatedCode = true;
        cursor += activeCode.length;
        while (normalizedMessage[cursor] === " ") cursor += 1;
      }
      QUANTITY_MARKER_PATTERN.lastIndex = cursor;
      const quantityMatch = QUANTITY_MARKER_PATTERN.exec(normalizedMessage);
      if (!quantityMatch) {
        items.push(reviewItem(activeCode, {
          segmentIndex,
          segmentRaw: normalizedMessage.slice(segmentStart),
          variantOrSize: normalizedMessage.slice(cursor).trim().slice(0, 30),
          reviewReason: "missingQuantity",
          profileRevision: compiledProfile.profileRevision
        }));
        break;
      }
      const specText = normalizedMessage.slice(cursor, quantityMatch.index);
      const quantity = Number.parseInt(quantityMatch[1], 10);
      const segmentEnd = QUANTITY_MARKER_PATTERN.lastIndex;
      const segmentRaw = normalizedMessage.slice(segmentStart, segmentEnd).trim();
      if (quantity !== 0) {
        items.push(...segmentItems({
          activeCode,
          compiledProfile,
          segmentIndex,
          segmentRaw,
          specText,
          quantity,
          bareSegment: segmentIndex > 0 && !repeatedCode && !canonicalizeSpecKeyword(specText),
          downgradeReason
        }));
      }
      segmentIndex += 1;
      cursor = segmentEnd;
    }
    const classification = items.some((item) => item.needsReview) ? RAW_CLASSIFICATIONS.NEEDS_REVIEW : items.length ? RAW_CLASSIFICATIONS.CONFIRMED : RAW_CLASSIFICATIONS.CHAT;
    return compatibleResult(normalizedMessage, classification, items);
  }
  function classifyLegacy(normalizedMessage, activeCode, options) {
    const strictMatch = normalizedMessage.match(CONFIRMED_ORDER_PATTERN);
    const strictQuantity = strictMatch ? Number.parseInt(strictMatch.groups.quantity, 10) : null;
    if (strictMatch?.groups.productCode === activeCode && strictQuantity === 0) {
      return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.CHAT);
    }
    const isStrictOrder = strictMatch?.groups.productCode === activeCode && Number.isSafeInteger(strictQuantity) && strictQuantity >= 1 && strictQuantity <= MAX_QUANTITY;
    const downgradeReason = confirmationDowngradeReason(options);
    if (isStrictOrder && !downgradeReason) {
      return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.CONFIRMED, [{
        productCode: activeCode,
        variantOrSize: strictMatch.groups.variantOrSize ?? "",
        quantity: strictQuantity,
        status: RAW_CLASSIFICATIONS.CONFIRMED,
        needsReview: false
      }]);
    }
    const loose = strictMatch ? {
      productCode: activeCode,
      variantOrSize: strictMatch.groups.variantOrSize ?? "",
      quantity: strictQuantity
    } : parseLooseIntent(normalizedMessage, activeCode);
    return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.NEEDS_REVIEW, [{
      ...loose,
      status: RAW_CLASSIFICATIONS.NEEDS_REVIEW,
      needsReview: true
    }]);
  }
  function historicalSpecProfile(latestProfileByCode, productCode) {
    const entry = latestProfileByCode?.get?.(productCode) ?? latestProfileByCode?.[productCode] ?? null;
    return entry?.specProfile ?? entry;
  }
  function classifyCodeIntent(normalizedMessage, productCode, specProfile, parserOptions) {
    return specProfile ? classifySegmented(normalizedMessage, productCode, specProfile, parserOptions) : classifyLegacy(normalizedMessage, productCode, parserOptions);
  }
  function preserveOriginalMessage(result, normalizedMessage) {
    return result.normalizedMessage === normalizedMessage ? result : { ...result, normalizedMessage };
  }
  function classifyMessage(rawMessage, options = {}) {
    const normalizedMessage = normalizeMessage(rawMessage);
    const activeCode = normalizeProductCode(options.activeCode);
    const captureOrigin = options.captureOrigin ?? CAPTURE_ORIGINS.OBSERVER;
    const stable = options.stable !== false;
    const hasReliableCommentId = options.hasReliableCommentId !== false;
    if (options.isHost === true) {
      return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.HOST);
    }
    const parserOptions = { captureOrigin, stable, hasReliableCommentId };
    const pastOrder = parsePastOrderPrefix(normalizedMessage);
    const intentMessage = pastOrder.marked ? pastOrder.payload : normalizedMessage;
    const leadingCode = intentMessage.match(LEADING_PRODUCT_CODE_PATTERN)?.[1];
    const hasPlus = intentMessage.includes("+");
    const matchesActivePrefix = Boolean(
      activeCode && intentMessage.startsWith(activeCode)
    );
    if (leadingCode && !hasPlus) {
      return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.PRODUCT_INQUIRY);
    }
    if (leadingCode === activeCode && hasPlus) {
      return preserveOriginalMessage(
        classifyCodeIntent(
          intentMessage,
          activeCode,
          options.specProfile,
          parserOptions
        ),
        normalizedMessage
      );
    }
    const historyProfile = leadingCode && hasPlus ? historicalSpecProfile(options.latestProfileByCode, leadingCode) : null;
    if (historyProfile) {
      return preserveOriginalMessage(
        classifySegmented(intentMessage, leadingCode, historyProfile, parserOptions),
        normalizedMessage
      );
    }
    if (matchesActivePrefix && hasPlus) {
      return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.NEEDS_REVIEW, [
        reviewItem(activeCode, {
          segmentRaw: intentMessage,
          ...parseLooseIntent(intentMessage, activeCode),
          reviewReason: "activePrefixConflict",
          profileRevision: options.specProfile?.profileRevision ?? null
        })
      ]);
    }
    if (leadingCode && hasPlus) {
      return compatibleResult(
        normalizedMessage,
        activeCode ? RAW_CLASSIFICATIONS.INACTIVE_CODE : RAW_CLASSIFICATIONS.PAUSED
      );
    }
    return compatibleResult(normalizedMessage, RAW_CLASSIFICATIONS.CHAT);
  }

  // vendor/live-capture/catalog-import.js
  var catalog_import_exports = {};
  __export(catalog_import_exports, {
    CATALOG_HEADERS: () => CATALOG_HEADERS,
    CATALOG_LIMITS: () => CATALOG_LIMITS,
    buildImportedSpecProfile: () => buildImportedSpecProfile,
    normalizePriceText: () => normalizePriceText,
    parseCatalogTsv: () => parseCatalogTsv,
    validateCatalogFields: () => validateCatalogFields
  });
  var CATALOG_HEADERS = Object.freeze([
    "商品碼",
    "品名",
    "顏色",
    "尺寸",
    "價格"
  ]);
  var CATALOG_LIMITS = Object.freeze({
    maxRows: 1e3,
    maxTextCodePoints: 2e6,
    maxFieldCodePoints: 2e3,
    maxProductNameCodePoints: 200,
    maxTokensPerDimension: 50,
    maxCustomTokens: 50,
    maxKeywordCodePoints: 10
  });
  var PRICE_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/u;
  var MULTI_VALUE_SEPARATOR = /[、,，;；]/u;
  var SIZE_RANGE_MARKER = /[~～]/u;
  var SIZE_RANGE_PATTERN = /^(?<start>[0-9]+(?:\.5)?)[~～](?<end>[0-9]+(?:\.5)?)(?<half>\(含半碼\))?$/u;
  var BUILTIN_STYLES = new Set(
    BUILTIN_SPEC_KEYWORDS.colors.map(canonicalizeSpecKeyword)
  );
  var BUILTIN_SIZES = new Set([
    ...BUILTIN_SPEC_KEYWORDS.clothingSizes,
    ...BUILTIN_SPEC_KEYWORDS.shoeSizes
  ].map(canonicalizeSpecKeyword));
  function orderedBuiltinValues(values, builtins) {
    const selected = new Set(values.map(canonicalizeSpecKeyword));
    return builtins.filter((value) => selected.has(canonicalizeSpecKeyword(value)));
  }
  function codePointLength2(value) {
    return [...String(value ?? "")].length;
  }
  function normalizeCell(value, { preserveInternalWhitespace = false } = {}) {
    const normalized = String(value ?? "").normalize("NFKC").trim();
    return preserveInternalWhitespace ? normalized : canonicalizeSpecKeyword(normalized);
  }
  function issue(code, field, sourceRow, value, message, severity = "error") {
    return { code, field, sourceRow, value, message, severity };
  }
  function formatHalfStep(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  function expandSizeRange(token, sourceRow) {
    const normalized = normalizeCell(token);
    if (!SIZE_RANGE_MARKER.test(normalized)) return { values: [normalized], errors: [] };
    const match = normalized.match(SIZE_RANGE_PATTERN);
    if (!match) {
      return {
        values: [],
        errors: [issue(
          "invalidSizeRange",
          "sizes",
          sourceRow,
          token,
          "尺寸範圍格式錯誤；請使用 38～44 或 35～45（含半碼）。"
        )]
      };
    }
    const start = Number(match.groups.start);
    const end = Number(match.groups.end);
    const includesHalfSizes = Boolean(match.groups.half);
    if (start > end) {
      return {
        values: [],
        errors: [issue(
          "descendingSizeRange",
          "sizes",
          sourceRow,
          token,
          "尺寸範圍起點不可大於終點。"
        )]
      };
    }
    if (!includesHalfSizes && (!Number.isInteger(start) || !Number.isInteger(end)) || includesHalfSizes && (!Number.isInteger(start * 2) || !Number.isInteger(end * 2))) {
      return {
        values: [],
        errors: [issue(
          "invalidSizeRangeStep",
          "sizes",
          sourceRow,
          token,
          "尺寸範圍端點必須是整數；含半碼範圍可使用 0.5。"
        )]
      };
    }
    const step = includesHalfSizes ? 0.5 : 1;
    const count = Math.floor((end - start) / step + 1 + Number.EPSILON);
    if (count > CATALOG_LIMITS.maxTokensPerDimension) {
      return {
        values: [],
        errors: [issue(
          "tooManySizeRangeValues",
          "sizes",
          sourceRow,
          token,
          `尺寸範圍展開後不可超過 ${CATALOG_LIMITS.maxTokensPerDimension} 個值。`
        )]
      };
    }
    return {
      values: Array.from({ length: count }, (_, index) => formatHalfStep(start + index * step)),
      errors: []
    };
  }
  function parseDimensionText(value, dimension, sourceRow) {
    const field = dimension === SPEC_DIMENSIONS.STYLE ? "styles" : "sizes";
    const raw = String(value ?? "").normalize("NFKC").trim();
    if (!raw) return { values: [], errors: [], warnings: [] };
    const values = [];
    const errors = [];
    const warnings = [];
    const seen = /* @__PURE__ */ new Set();
    for (const part of raw.split(MULTI_VALUE_SEPARATOR)) {
      const token = normalizeCell(part);
      if (!token) continue;
      const expanded = dimension === SPEC_DIMENSIONS.SIZE ? expandSizeRange(token, sourceRow) : { values: [token], errors: [] };
      errors.push(...expanded.errors);
      for (const expandedValue of expanded.values) {
        const canonical = canonicalizeSpecKeyword(expandedValue);
        if (seen.has(canonical)) {
          warnings.push(issue(
            "duplicateKeywordMerged",
            field,
            sourceRow,
            expandedValue,
            `重複關鍵字「${expandedValue}」已合併。`,
            "warning"
          ));
          continue;
        }
        seen.add(canonical);
        values.push(canonical);
      }
    }
    if (values.length > CATALOG_LIMITS.maxTokensPerDimension) {
      errors.push(issue(
        "tooManyDimensionKeywords",
        field,
        sourceRow,
        value,
        `${field === "styles" ? "顏色" : "尺寸"}最多 ${CATALOG_LIMITS.maxTokensPerDimension} 個值。`
      ));
    }
    return { values, errors, warnings };
  }
  function messageForProfileError(error) {
    const value = error.value ? `「${error.value}」` : "";
    const messages = {
      emptySelectedCustomKeyword: "選取的自訂關鍵字不可空白。",
      invalidCustomKeyword: `自訂關鍵字${value}格式錯誤或超過 10 個字。`,
      customKeywordIsProductCode: `自訂關鍵字${value}不可長得像商品碼。`,
      customKeywordIsReserved: `自訂關鍵字${value}不可使用保留字「${PACKAGE_COLOR_KEYWORD}」。`,
      duplicateCustomKeyword: `自訂關鍵字${value}與既有關鍵字重複。`,
      invalidCustomKeywordDimension: `自訂關鍵字${value}的顏色／尺寸分類無效。`,
      unknownSelectedKeyword: `找不到選取的關鍵字${value}。`,
      noSelectedKeywords: "有規格商品至少需要一個顏色或尺寸。",
      noSpecsHasSelections: "無規格商品不可同時選取顏色或尺寸。"
    };
    return messages[error.code] ?? `規格設定錯誤：${error.code}`;
  }
  function normalizePriceText(value, options = {}) {
    const normalized = String(value ?? "").normalize("NFKC").trim();
    if (!normalized) {
      if (options.priceRequired !== true) {
        return { valid: true, value: "999", priceIsProvisional: true };
      }
      return { valid: false, value: "", reason: "價格為必填。", code: "priceRequired" };
    }
    if (!PRICE_PATTERN.test(normalized)) {
      return {
        valid: false,
        value: normalized,
        reason: "價格只能使用數字與小數點，不可含逗號、貨幣符號、負號或指數。",
        code: "invalidPrice"
      };
    }
    return options.priceIsProvisional === true && normalized === "999" ? { valid: true, value: normalized, priceIsProvisional: true } : { valid: true, value: normalized };
  }
  function buildImportedSpecProfile({ styles = [], sizes = [] } = {}) {
    const customStyles = styles.filter((value) => !BUILTIN_STYLES.has(canonicalizeSpecKeyword(value)));
    const customSizes = sizes.filter((value) => !BUILTIN_SIZES.has(canonicalizeSpecKeyword(value)));
    const selectedStyles = styles.filter((value) => BUILTIN_STYLES.has(canonicalizeSpecKeyword(value)));
    const selectedSizes = sizes.filter((value) => BUILTIN_SIZES.has(canonicalizeSpecKeyword(value)));
    const customSlots = [
      ...customStyles.map((value) => ({
        value,
        selected: true,
        dimension: SPEC_DIMENSIONS.STYLE
      })),
      ...customSizes.map((value) => ({
        value,
        selected: true,
        dimension: SPEC_DIMENSIONS.SIZE
      }))
    ];
    return {
      mode: styles.length || sizes.length ? "withSpecs" : "noSpecs",
      selected: {
        style: selectedStyles,
        size: selectedSizes
      },
      customSlots,
      displayOrder: [
        ...orderedBuiltinValues(selectedStyles, BUILTIN_SPEC_KEYWORDS.colors),
        ...customStyles,
        ...orderedBuiltinValues(selectedSizes, BUILTIN_SPEC_KEYWORDS.clothingSizes),
        ...orderedBuiltinValues(selectedSizes, BUILTIN_SPEC_KEYWORDS.shoeSizes),
        ...customSizes
      ]
    };
  }
  function validateCatalogFields(fields = {}, options = {}) {
    const sourceRow = options.sourceRow ?? null;
    const errors = [];
    const warnings = [];
    const rawCode = String(fields.productCode ?? "").normalize("NFKC").trim();
    const productCode = normalizeProductCode(rawCode);
    if (!rawCode) {
      errors.push(issue(
        "productCodeRequired",
        "productCode",
        sourceRow,
        rawCode,
        "商品碼為必填。"
      ));
    } else if (!productCode) {
      errors.push(issue(
        "invalidProductCode",
        "productCode",
        sourceRow,
        rawCode,
        "商品碼必須是一個英文字母加兩或三位數字，例如 A01 或 A010。"
      ));
    }
    const productName = normalizeCell(fields.productName, {
      preserveInternalWhitespace: true
    });
    if (codePointLength2(productName) > CATALOG_LIMITS.maxProductNameCodePoints) {
      errors.push(issue(
        "productNameTooLong",
        "productName",
        sourceRow,
        productName,
        `品名不可超過 ${CATALOG_LIMITS.maxProductNameCodePoints} 個字。`
      ));
    }
    for (const [field, value] of Object.entries(fields)) {
      if (codePointLength2(value) > CATALOG_LIMITS.maxFieldCodePoints) {
        errors.push(issue(
          "catalogFieldTooLong",
          field,
          sourceRow,
          value,
          `單一欄位不可超過 ${CATALOG_LIMITS.maxFieldCodePoints} 個字。`
        ));
      }
    }
    const stylesResult = parseDimensionText(
      fields.stylesText ?? fields.styles,
      SPEC_DIMENSIONS.STYLE,
      sourceRow
    );
    const sizesResult = parseDimensionText(
      fields.sizesText ?? fields.sizes,
      SPEC_DIMENSIONS.SIZE,
      sourceRow
    );
    errors.push(...stylesResult.errors, ...sizesResult.errors);
    warnings.push(...stylesResult.warnings, ...sizesResult.warnings);
    const sizeSet = new Set(sizesResult.values);
    const conflicts = stylesResult.values.filter((value) => sizeSet.has(value));
    for (const value of conflicts) {
      errors.push(issue(
        "keywordDimensionConflict",
        "styles,sizes",
        sourceRow,
        value,
        `關鍵字「${value}」不可同時當顏色與尺寸。`
      ));
    }
    const price = normalizePriceText(fields.price, {
      priceRequired: options.priceRequired === true,
      priceIsProvisional: options.priceIsProvisional === true
    });
    if (!price.valid) {
      errors.push(issue(price.code, "price", sourceRow, price.value, price.reason));
    }
    const specProfile = buildImportedSpecProfile({
      styles: stylesResult.values,
      sizes: sizesResult.values
    });
    if (specProfile.customSlots.length > CATALOG_LIMITS.maxCustomTokens) {
      errors.push(issue(
        "tooManyCustomKeywords",
        "styles,sizes",
        sourceRow,
        specProfile.customSlots.length,
        `每個商品最多 ${CATALOG_LIMITS.maxCustomTokens} 個自訂關鍵字。`
      ));
    }
    const compiled = compileSpecProfile(specProfile);
    for (const profileError of compiled.errors) {
      errors.push(issue(
        profileError.code,
        "styles,sizes",
        sourceRow,
        profileError.value ?? "",
        messageForProfileError(profileError)
      ));
    }
    const noSpecsWarning = specProfile.mode === "noSpecs";
    if (noSpecsWarning) {
      warnings.push(issue(
        "noSpecsWarning",
        "styles,sizes",
        sourceRow,
        "",
        "無規格；請確認不是漏填顏色與尺寸。",
        "warning"
      ));
    }
    const product = errors.length || !productCode || !price.valid ? null : {
      recordVersion: 1,
      productCode,
      productName,
      price: price.value,
      priceIsProvisional: price.priceIsProvisional === true,
      specProfile,
      sourceRow
    };
    return {
      product,
      errors,
      warnings,
      noSpecsWarning,
      normalizedFields: {
        productCode: productCode ?? rawCode,
        productName,
        stylesText: stylesResult.values.join("、"),
        sizesText: sizesResult.values.join("、"),
        price: price.value
      }
    };
  }
  function isHeader(fields) {
    return CATALOG_HEADERS.every((value, index) => normalizeCell(fields[index], { preserveInternalWhitespace: true }) === value);
  }
  function parseCatalogTsv(text, options = {}) {
    const rawText2 = String(text ?? "").replace(/^\uFEFF/u, "");
    const rows = [];
    const globalErrors = [];
    if (codePointLength2(rawText2) > (options.maxTextCodePoints ?? CATALOG_LIMITS.maxTextCodePoints)) {
      globalErrors.push(issue(
        "catalogTextTooLong",
        "catalog",
        null,
        "",
        `貼上內容不可超過 ${options.maxTextCodePoints ?? CATALOG_LIMITS.maxTextCodePoints} 個字。`
      ));
      return {
        rows,
        validProducts: [],
        errors: globalErrors,
        warnings: [],
        hasBlockingErrors: true
      };
    }
    const nonEmptyLines = rawText2.split(/\r?\n/u).map((line, index) => ({ line, sourceRow: index + 1 })).filter(({ line }) => line.trim() !== "");
    let dataLines = nonEmptyLines;
    if (nonEmptyLines.length) {
      const firstFields = nonEmptyLines[0].line.split("	");
      if (firstFields.length === 5 && isHeader(firstFields)) dataLines = nonEmptyLines.slice(1);
    }
    if (dataLines.length > (options.maxRows ?? CATALOG_LIMITS.maxRows)) {
      globalErrors.push(issue(
        "tooManyCatalogRows",
        "catalog",
        null,
        dataLines.length,
        `一次最多匯入 ${options.maxRows ?? CATALOG_LIMITS.maxRows} 個商品。`
      ));
    }
    for (const { line, sourceRow } of dataLines) {
      const rawFields = line.split("	");
      if (rawFields.length !== 5) {
        rows.push({
          sourceRow,
          rawFields,
          normalizedFields: null,
          product: null,
          valid: false,
          noSpecsWarning: false,
          errors: [issue(
            "invalidColumnCount",
            "row",
            sourceRow,
            rawFields.length,
            `第 ${sourceRow} 列必須恰好五欄，目前為 ${rawFields.length} 欄。`
          )],
          warnings: []
        });
        continue;
      }
      const validation = validateCatalogFields({
        productCode: rawFields[0],
        productName: rawFields[1],
        stylesText: rawFields[2],
        sizesText: rawFields[3],
        price: rawFields[4]
      }, {
        sourceRow,
        priceRequired: options.priceRequired === true
      });
      rows.push({
        sourceRow,
        rawFields,
        ...validation,
        valid: Boolean(validation.product)
      });
    }
    const rowsByCode = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const code = row.product?.productCode ?? (row.normalizedFields && normalizeProductCode(row.normalizedFields.productCode));
      if (!code) continue;
      if (!rowsByCode.has(code)) rowsByCode.set(code, []);
      rowsByCode.get(code).push(row);
    }
    for (const [code, duplicateRows] of rowsByCode) {
      if (duplicateRows.length < 2) continue;
      for (const row of duplicateRows) {
        row.errors.push(issue(
          "duplicateProductCode",
          "productCode",
          row.sourceRow,
          code,
          `商品碼 ${code} 重複；所有同碼列均不套用。`
        ));
        row.product = null;
        row.valid = false;
      }
    }
    const validProducts = rows.filter((row) => row.product).map((row, importOrder) => ({
      ...row.product,
      importOrder,
      entryOrigin: "tsv"
    }));
    const errors = [...globalErrors, ...rows.flatMap((row) => row.errors)];
    const warnings = rows.flatMap((row) => row.warnings);
    return {
      rows,
      validProducts,
      errors,
      warnings,
      hasBlockingErrors: errors.length > 0
    };
  }

  // vendor/live-capture/csv.js
  var csv_exports = {};
  __export(csv_exports, {
    CSV_COLUMN_INDEX: () => CSV_COLUMN_INDEX,
    ORDER_HEADERS: () => ORDER_HEADERS,
    buildOrdersCsv: () => buildOrdersCsv,
    buildOrdersCsvParts: () => buildOrdersCsvParts,
    csvFileName: () => csvFileName,
    escapeCsvCell: () => escapeCsvCell,
    protectBuyerAccountValue: () => protectBuyerAccountValue,
    protectIdentifierValue: () => protectIdentifierValue,
    protectSpreadsheetValue: () => protectSpreadsheetValue,
    rowFromInactiveComment: () => rowFromInactiveComment,
    rowFromItem: () => rowFromItem,
    serializeCsvRow: () => serializeCsvRow
  });

  // vendor/live-capture/shout-history.js
  var SHOUT_HISTORY_LIMIT = 3e4;
  var EMPTY_HISTORY_LENGTH = '{"v":1,"e":[]}'.length;
  var DECIMAL_ID = /^[0-9]+$/u;
  var EXCEL_WRAPPED_ID = /^="[\s\S]*"$/u;
  var FORMULA_GUARDED_ID = /^'[\t\r\n ]*[=+\-@]/u;
  function ordinalCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function compareHistoryCommentIds(left, right) {
    const a = String(left ?? "").trim();
    const b = String(right ?? "").trim();
    if (!a || !b) throw new Error("COMMENT_ID_MISSING");
    if (EXCEL_WRAPPED_ID.test(a) || EXCEL_WRAPPED_ID.test(b)) {
      throw new Error("COMMENT_ID_NOT_UNWRAPPED");
    }
    if (FORMULA_GUARDED_ID.test(a) || FORMULA_GUARDED_ID.test(b)) {
      throw new Error("COMMENT_ID_FORMULA_GUARDED");
    }
    const ad = DECIMAL_ID.test(a), bd = DECIMAL_ID.test(b);
    if (ad !== bd) return ad ? -1 : 1;
    if (!ad) return ordinalCompare(a, b);
    const an = a.replace(/^0+(?=[0-9])/u, "") || "0";
    const bn = b.replace(/^0+(?=[0-9])/u, "") || "0";
    return an.length - bn.length || ordinalCompare(an, bn);
  }
  function rawText(value, label) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`喊單歷程缺少有效的${label}，請保留本場擷取資料。`);
    }
    return value;
  }
  function withItemContext(item, action) {
    try {
      return action();
    } catch (error) {
      if (!error.shoutHistoryContext) {
        const display = (value) => {
          try {
            return String(value ?? "（缺少）");
          } catch {
            return "（無法顯示）";
          }
        };
        error.message += `（買家帳號：${display(item?.username)}；留言 ID：${display(item?.sourceCommentId)}；項目 ID：${display(item?.itemId)}）`;
        error.shoutHistoryContext = true;
      }
      throw error;
    }
  }
  function historyPosition(item) {
    return withItemContext(item, () => {
      const sequence = item?.captureSequence;
      const segment = item?.segmentIndex ?? 0;
      if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(segment) || segment < 0) {
        throw new Error("喊單歷程的擷取位置無效，請保留本場擷取資料。");
      }
      return [sequence, segment, rawText(item?.itemId, "項目 ID")];
    });
  }
  function eventFromItem(item) {
    const at = rawText(item?.capturedAt, "擷取時間");
    const time = Date.parse(at);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(at) || !Number.isSafeInteger(time) || new Date(time).toISOString() !== at) {
      throw new Error("喊單歷程的擷取時間無效，請保留本場擷取資料。");
    }
    const id = rawText(item?.sourceCommentId, "留言 ID");
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error("喊單歷程的數量不是 1～99 的整數。");
    }
    const position = historyPosition(item);
    return { event: [at, id, quantity, String(item?.captureOrigin ?? ""), ...position], time };
  }
  function compareEvents(a, b) {
    return a[4] - b[4] || a[5] - b[5] || ordinalCompare(a[6], b[6]);
  }
  function createShoutHistory() {
    return { count: 0, jsonLength: EMPTY_HISTORY_LENGTH, events: [], max: null };
  }
  function addShoutHistory(history, item) {
    return withItemContext(item, () => {
      const { event, time } = eventFromItem(item);
      const max = history.max;
      if (!max || time > max.time || time === max.time && (compareHistoryCommentIds(event[1], max.event[1]) > 0 || compareHistoryCommentIds(event[1], max.event[1]) === 0 && compareEvents(event, max.event) > 0)) {
        history.max = { event, time };
      }
      if (history.events !== null) {
        const nextLength = history.jsonLength + JSON.stringify(event).length + (history.count ? 1 : 0);
        history.jsonLength = nextLength;
        if (nextLength > SHOUT_HISTORY_LIMIT) history.events = null;
        else history.events.push(event);
      }
      history.count += 1;
      return history;
    });
  }
  function serializeShoutHistory(history, representative) {
    if (!history?.count) {
      history = addShoutHistory(createShoutHistory(), representative);
    }
    if (history.events === null) {
      return JSON.stringify({
        v: 1,
        omitted: "too_long",
        n: history.count,
        p: historyPosition(representative),
        max: [history.max.event[0], history.max.event[1]]
      });
    }
    return JSON.stringify({ v: 1, e: history.events.slice().sort(compareEvents) });
  }
  function serializePendingPosition(item) {
    return JSON.stringify({ v: 1, p: historyPosition(item) });
  }

  // vendor/live-capture/aggregation.js
  function buyerKey(item) {
    const uid = String(item?.uid ?? "").trim();
    return uid ? `uid:${uid}` : `username:${String(item?.username ?? "")}`;
  }
  function itemSpecKey(item) {
    return item?.specKey ?? `legacy:${String(item?.variantOrSize ?? "")}`;
  }
  function aggregationKey(item) {
    const sessionId = String(item?.sessionId ?? "");
    const buyer = buyerKey(item);
    const productCode = String(item?.productCode ?? "");
    const specKey = String(itemSpecKey(item));
    return `${sessionId.length}:${sessionId}${buyer.length}:${buyer}${productCode.length}:${productCode}${specKey.length}:${specKey}`;
  }
  function safePositionInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : fallback;
  }
  function createOrderAggregation({ includeHistory = false } = {}) {
    return {
      orderLineCount: 0,
      reviewLineCount: 0,
      aggregatedUnitCount: 0,
      groups: /* @__PURE__ */ new Map(),
      ...includeHistory ? { includeHistory: true } : {}
    };
  }
  function compareItemToGroupPosition(item, group) {
    const itemSequence = safePositionInteger(
      item?.captureSequence,
      Number.MIN_SAFE_INTEGER
    );
    const groupSequence = safePositionInteger(
      group?.representativeCaptureSequence,
      Number.MIN_SAFE_INTEGER
    );
    if (itemSequence !== groupSequence) return itemSequence < groupSequence ? -1 : 1;
    const itemSegment = safePositionInteger(item?.segmentIndex, 0);
    const groupSegment = safePositionInteger(group?.representativeSegmentIndex, 0);
    if (itemSegment !== groupSegment) return itemSegment < groupSegment ? -1 : 1;
    const itemId = String(item?.itemId ?? "");
    const groupItemId = String(group?.representativeItemId ?? "");
    if (itemId === groupItemId) return 0;
    return itemId < groupItemId ? -1 : 1;
  }
  function addItemToAggregation(aggregation, item) {
    if (item?.status === "needsReview") {
      aggregation.reviewLineCount += 1;
      return aggregation;
    }
    const quantity = Number(item?.quantity);
    if (item?.status !== "confirmed" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return aggregation;
    aggregation.orderLineCount += 1;
    const key = aggregationKey(item);
    const existing = aggregation.groups.get(key);
    if (!existing) {
      aggregation.groups.set(key, {
        key,
        latestQuantity: quantity,
        sourceItemCount: 1,
        representativeItemId: item.itemId,
        representativeCaptureSequence: item.captureSequence,
        representativeSegmentIndex: item.segmentIndex,
        representativeActivationSequence: item.activationSequence,
        ...aggregation.includeHistory ? { shoutHistory: addShoutHistory(createShoutHistory(), item) } : {}
      });
      aggregation.aggregatedUnitCount += quantity;
      return aggregation;
    }
    existing.sourceItemCount += 1;
    if (aggregation.includeHistory) addShoutHistory(existing.shoutHistory, item);
    if (compareItemToGroupPosition(item, existing) > 0) {
      aggregation.aggregatedUnitCount += quantity - existing.latestQuantity;
      existing.latestQuantity = quantity;
      existing.representativeItemId = item.itemId;
      existing.representativeCaptureSequence = item.captureSequence;
      existing.representativeSegmentIndex = item.segmentIndex;
      existing.representativeActivationSequence = item.activationSequence;
    }
    return aggregation;
  }
  function buildOrderAggregation(items, options = {}) {
    const aggregation = createOrderAggregation(options);
    for (const item of items ?? []) addItemToAggregation(aggregation, item);
    return aggregation;
  }
  function orderAggregationView(aggregation) {
    return {
      orderLineCount: aggregation?.orderLineCount ?? 0,
      reviewLineCount: aggregation?.reviewLineCount ?? 0,
      groupCount: aggregation?.groups?.size ?? 0,
      aggregatedUnitCount: aggregation?.aggregatedUnitCount ?? 0
    };
  }

  // vendor/live-capture/csv.js
  var ORDER_HEADERS = [
    "擷取時間",
    "直播Session",
    "限定時段序號",
    "留言ID",
    "買家UID",
    "買家帳號",
    "原始留言",
    "正規化留言",
    "商品代號",
    "品名",
    "規格尺寸",
    "數量",
    "價格",
    "狀態",
    "待確認",
    "來源",
    "喊單則數",
    "彙總件數",
    "喊單歷程"
  ];
  var CSV_COLUMN_INDEX = Object.freeze({
    SESSION_ID: ORDER_HEADERS.indexOf("直播Session"),
    COMMENT_ID: ORDER_HEADERS.indexOf("留言ID"),
    BUYER_UID: ORDER_HEADERS.indexOf("買家UID"),
    BUYER_USERNAME: ORDER_HEADERS.indexOf("買家帳號"),
    RAW_MESSAGE: ORDER_HEADERS.indexOf("原始留言"),
    NORMALIZED_MESSAGE: ORDER_HEADERS.indexOf("正規化留言"),
    PRODUCT_NAME: ORDER_HEADERS.indexOf("品名"),
    VARIANT_OR_SIZE: ORDER_HEADERS.indexOf("規格尺寸"),
    PRICE: ORDER_HEADERS.indexOf("價格"),
    ORDER_LINE_COUNT: ORDER_HEADERS.indexOf("喊單則數"),
    AGGREGATED_UNIT_COUNT: ORDER_HEADERS.indexOf("彙總件數")
  });
  var FORMULA_PREFIX_PATTERN = /^[\t\r\n ]*[=+\-@]/u;
  var NUMERIC_IDENTIFIER_PATTERN = /^[0-9]+$/u;
  var IDENTIFIER_COLUMNS = /* @__PURE__ */ new Set([
    CSV_COLUMN_INDEX.SESSION_ID,
    CSV_COLUMN_INDEX.COMMENT_ID,
    CSV_COLUMN_INDEX.BUYER_UID
  ]);
  var BUYER_CONTROLLED_COLUMNS = /* @__PURE__ */ new Set([
    CSV_COLUMN_INDEX.BUYER_USERNAME,
    CSV_COLUMN_INDEX.RAW_MESSAGE,
    CSV_COLUMN_INDEX.NORMALIZED_MESSAGE,
    CSV_COLUMN_INDEX.PRODUCT_NAME,
    CSV_COLUMN_INDEX.VARIANT_OR_SIZE
  ]);
  function protectSpreadsheetValue(value) {
    const text = String(value ?? "");
    return FORMULA_PREFIX_PATTERN.test(text) ? `'${text}` : text;
  }
  function protectIdentifierValue(value) {
    const text = String(value ?? "");
    return NUMERIC_IDENTIFIER_PATTERN.test(text) ? `="${text}"` : protectSpreadsheetValue(text);
  }
  function protectBuyerAccountValue(value) {
    const text = protectSpreadsheetValue(value);
    return text ? `="${text.replace(/"/gu, '""')}"` : "";
  }
  function escapeCsvCell(value, { buyerControlled = false } = {}) {
    const protectedValue = buyerControlled ? protectSpreadsheetValue(value) : String(value ?? "");
    return `"${protectedValue.replace(/"/gu, '""')}"`;
  }
  function rowFromItem(item, comment, aggregate = {}) {
    const confirmed = item.status === "confirmed";
    const latestQuantity = confirmed ? aggregate.latestQuantity ?? item.quantity : item.quantity;
    return [
      item.capturedAt,
      item.sessionId,
      item.activationSequence,
      item.sourceCommentId,
      item.uid ?? comment?.uid ?? "",
      item.username ?? comment?.username ?? "",
      item.rawMessage ?? comment?.rawMessage ?? "",
      item.normalizedMessage ?? comment?.normalizedMessage ?? "",
      item.productCode ?? "",
      item.productName ?? "",
      item.variantOrSize ?? "",
      latestQuantity ?? "",
      item.price ?? "",
      item.status,
      item.needsReview ? "是" : "否",
      item.captureOrigin,
      confirmed ? aggregate.sourceItemCount ?? 1 : 1,
      confirmed ? latestQuantity ?? "" : "",
      confirmed ? serializeShoutHistory(aggregate.shoutHistory, item) : serializePendingPosition(item)
    ];
  }
  function rowFromInactiveComment(comment) {
    return [
      comment.firstSeenAt,
      comment.sessionId,
      comment.activationSequenceAtFirstSeen,
      comment.commentId,
      comment.uid,
      comment.username,
      comment.rawMessage,
      comment.normalizedMessage,
      "",
      "",
      "",
      "",
      "",
      "inactiveCode",
      "否",
      comment.captureOrigin,
      "",
      "",
      ""
    ];
  }
  function inactiveAuditRows(sessionData) {
    return Object.values(sessionData.comments).filter((comment) => comment.classification === "inactiveCode").map(rowFromInactiveComment);
  }
  function serializeCsvRow(row, { dataRow = true } = {}) {
    return row.map((value, columnIndex) => {
      if (dataRow && columnIndex === CSV_COLUMN_INDEX.BUYER_USERNAME) {
        return escapeCsvCell(protectBuyerAccountValue(value));
      }
      if (dataRow && IDENTIFIER_COLUMNS.has(columnIndex)) {
        return escapeCsvCell(protectIdentifierValue(value));
      }
      return escapeCsvCell(value, {
        buyerControlled: dataRow && BUYER_CONTROLLED_COLUMNS.has(columnIndex)
      });
    }).join(",");
  }
  function nextItemKey(sessionId, rows) {
    const last = rows.at(-1);
    return [sessionId, last.captureSequence, last.itemId];
  }
  async function buildPagedAggregation(repository, sessionId, options) {
    const aggregation = createOrderAggregation({ includeHistory: true });
    let afterKey = [sessionId, 0, ""];
    while (true) {
      const rows = await repository.readItemsPage(sessionId, {
        afterKey,
        cutoffSequence: options.cutoffSequence,
        limit: options.pageSize
      });
      if (!rows.length) break;
      for (const item of rows) addItemToAggregation(aggregation, item);
      afterKey = nextItemKey(sessionId, rows);
      if (rows.length < options.pageSize) break;
    }
    return aggregation;
  }
  async function buildOrdersCsvParts(repository, sessionId, options = {}) {
    const session = await repository.getSession(sessionId, { create: false });
    if (!session) throw new Error("找不到本場資料，無法匯出。");
    const cutoffSequence = options.cutoffSequence ?? session.nextCaptureSequence - 1;
    const pageSize = options.pageSize ?? 1e3;
    const parts = [`\uFEFF${serializeCsvRow(ORDER_HEADERS, { dataRow: false })}`];
    let rowCount = 0;
    const aggregation = await buildPagedAggregation(repository, sessionId, {
      cutoffSequence,
      pageSize
    });
    let afterKey = [sessionId, 0, ""];
    let processedItems = 0;
    while (true) {
      const rows = await repository.readItemsPage(sessionId, {
        afterKey,
        cutoffSequence,
        limit: pageSize
      });
      if (!rows.length) break;
      const csvRows = [];
      for (const item of rows) {
        processedItems += 1;
        if (item.status === "needsReview") {
          csvRows.push(rowFromItem(item));
          continue;
        }
        const group = aggregation.groups.get(aggregationKey(item));
        if (group?.representativeItemId === item.itemId) {
          csvRows.push(rowFromItem(item, null, group));
        }
      }
      if (csvRows.length) {
        parts.push(`\r
${csvRows.map((row) => serializeCsvRow(row)).join("\r\n")}`);
        rowCount += csvRows.length;
      }
      afterKey = nextItemKey(sessionId, rows);
      options.onProgress?.({ processed: processedItems, cutoffSequence });
      if (rows.length < pageSize) break;
    }
    if (options.includeInactive === true) {
      let afterSequence = 0;
      while (afterSequence < cutoffSequence) {
        const rows = await repository.readInactiveCommentsPage(sessionId, {
          afterSequence,
          cutoffSequence,
          limit: pageSize
        });
        if (!rows.length) break;
        parts.push(`\r
${rows.map((row) => serializeCsvRow(rowFromInactiveComment(row))).join("\r\n")}`);
        rowCount += rows.length;
        afterSequence = rows.at(-1).captureSequence;
        if (rows.length < pageSize) break;
      }
    }
    return {
      parts,
      rowCount,
      cutoffSequence,
      orderSummary: orderAggregationView(aggregation)
    };
  }
  function itemOrder(left, right) {
    const bySequence = Number(left.captureSequence ?? Number.MAX_SAFE_INTEGER) - Number(right.captureSequence ?? Number.MAX_SAFE_INTEGER);
    if (bySequence) return bySequence;
    const bySegment = Number(left.segmentIndex ?? 0) - Number(right.segmentIndex ?? 0);
    if (bySegment) return bySegment;
    const leftItemId = String(left.itemId ?? "");
    const rightItemId = String(right.itemId ?? "");
    if (leftItemId === rightItemId) return 0;
    return leftItemId < rightItemId ? -1 : 1;
  }
  function buildOrdersCsv(sessionData, options = {}) {
    const comments = sessionData.comments ?? {};
    const items = Object.values(sessionData.items ?? {}).sort(itemOrder);
    const aggregation = buildOrderAggregation(items, { includeHistory: true });
    const rows = [];
    for (const item of items) {
      if (item.status === "needsReview") {
        rows.push(rowFromItem(item, comments[item.sourceCommentId]));
        continue;
      }
      const group = aggregation.groups.get(aggregationKey(item));
      if (group?.representativeItemId === item.itemId) {
        rows.push(rowFromItem(item, comments[item.sourceCommentId], group));
      }
    }
    if (options.includeInactive === true) rows.push(...inactiveAuditRows(sessionData));
    const serializedRows = [
      serializeCsvRow(ORDER_HEADERS, { dataRow: false }),
      ...rows.map((row) => serializeCsvRow(row))
    ];
    return `\uFEFF${serializedRows.join("\r\n")}`;
  }
  function csvFileName(sessionId, now = /* @__PURE__ */ new Date()) {
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    const safeSession = String(sessionId).replace(/[^A-Za-z0-9_-]/gu, "_");
    return `shopee-live-${safeSession}-${date}.csv`;
  }

  // src/entry-replay.mjs
  var import_replay_core = __toESM(require_replay_core(), 1);
  var import_chat_runtime = __toESM(require_chat_runtime(), 1);
  var import_replay_ui = __toESM(require_replay_ui(), 1);
  var core = import_replay_core.default.createReplayCore({ parser: parser_exports, catalog: catalog_import_exports, csv: csv_exports });
  var API = { ...core, chat: import_chat_runtime.default, VERSION: import_replay_ui.default.VERSION, init: () => import_replay_ui.default.initReplay(core), parser: parser_exports, catalog: catalog_import_exports, csv: csv_exports };
  if (typeof window === "undefined") globalThis.__SHOPEE_CANDIDATE_NODE__ = API;
  else import_replay_ui.default.initReplay(core).catch(() => {
  });
})();
if(typeof window==='undefined'&&typeof module==='object'&&module.exports){module.exports=globalThis.__SHOPEE_CANDIDATE_NODE__;delete globalThis.__SHOPEE_CANDIDATE_NODE__;}
