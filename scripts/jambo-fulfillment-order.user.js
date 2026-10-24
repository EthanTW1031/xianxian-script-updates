// ==UserScript==
// @name         Jambo 灌單
// @namespace    https://jambolive.tv/
// @version      0.1.10
// @description  在 JAMBO 新增訂單頁，照控貨助手的灌單表逐列幫貝貝💕建單；每列都用訂單查詢核對，結果不明就停、不重送
// @match        https://jambolive.tv/console/order/new/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_getTab
// @grant        GM_saveTab
// ==/UserScript==

/* 規格：claude_gpt\篡改猴灌單腳本_需求_Claude提案_v0.3.md（2026-10-18）
   0.1.5 另照 claude_gpt\GPT複驗_Jambo灌單0.1.4_v0.1.md 修兩項：
   ① 換頁監看在腳本第一刻就裝上（document-start），並且要能證明比頁面其他程式早開始才自動接續；
   ② 貝貝💕在同商品＋同款式已經有「不是腳本建的單」→ 那一列待人工確認・未嘗試，逐列選（Ethan 2026-10-23 選甲）。
   0.1.6 照 claude_gpt\GPT複驗_Jambo灌單0.1.5_v0.1.md：送後「看到的新單」不再算腳本認得的單（只有核對完成的、員工明確確認的）。 */

(function () {
  'use strict';

  // ───────────────────────── 核心（純函式，Node 測試直接載入） ─────────────────────────
  const CORE = (function () {
    const VERSION = '0.1.10';
    const SPEC_VERSION = 'jfo-spec-v0.3';
    const BEI = Object.freeze({ name: '貝貝💕', fromId: 'U11ed8dd57346a7b0265042bf9eaf2951' });
    const HEADERS = Object.freeze(['處理順序', '商品編號', '精確款式', '庫存來源總庫存', '蝦皮需灌入量', '灌完還剩', '操作進度']);
    const PROGRESS_VALUES = Object.freeze(['待處理', '已完成']);
    // 0.1.7（Ethan 2026-10-24：「讓他能接受 "預"，其他中文字不行」）：預購商品的編號是「預」＋數字（JAMBO 名稱例：1023-預02 …）
    const CODE_RE = /^(?:[A-Z]|預)[0-9]{2,3}$/u;
    const INSUFFICIENT_MESSAGE = '商品數量不足，是否繼續建立訂單？';
    const AUTOCOMPLETE_LIMIT = 10;
    const ORDER_PAGE_SIZE = 200;

    const STATE_LABEL = Object.freeze({
      pending: '待處理',
      submitted: '可能已提交',
      completed: '已確認完成',
      prior_confirmed: '先前已確認',
      original_done: '原檔標已完成（人工註記，未核對）',
      insufficient: '不足跳過',
      manual_untried: '待人工確認・未嘗試',
      unresolved: '待人工確認・結果不明',
      manual_found: '人工：已找到這張單',
      manual_other: '人工：其他',
    });

    function decodeUtf8Strict(bytes) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { ok: true, text };
      } catch (_error) {
        return { ok: false, error: '這份檔不是 UTF-8 格式，可能被 Excel 另存成別的格式。請用控貨助手重新另存灌單表，或在 Excel 另存時選「CSV UTF-8」。' };
      }
    }

    // RFC 4180：引號、引號內逗號與換行、"" 跳脫；CRLF 或 LF
    function parseCsv(text) {
      const rows = [];
      let row = [];
      let cell = '';
      let i = 0;
      let quoted = false;
      let cellStarted = false;
      const n = text.length;
      while (i < n) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"') {
            if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
            quoted = false; i += 1;
            if (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
              return { ok: false, error: `第 ${rows.length + 1} 列：引號後面多了字` };
            }
            continue;
          }
          cell += ch; i += 1; continue;
        }
        if (ch === '"') {
          if (cellStarted || cell !== '') return { ok: false, error: `第 ${rows.length + 1} 列：欄位中間有引號` };
          quoted = true; cellStarted = true; i += 1; continue;
        }
        if (ch === ',') { row.push(cell); cell = ''; cellStarted = false; i += 1; continue; }
        if (ch === '\r' || ch === '\n') {
          row.push(cell); rows.push(row); row = []; cell = ''; cellStarted = false;
          if (ch === '\r' && text[i + 1] === '\n') i += 2; else i += 1;
          continue;
        }
        cell += ch; cellStarted = true; i += 1;
      }
      if (quoted) return { ok: false, error: '檔案結尾的引號沒有關上' };
      if (cell !== '' || cellStarted || row.length) { row.push(cell); rows.push(row); }
      return { ok: true, rows };
    }

    function strictInt(text) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) return null;
      const value = Number(text);
      return Number.isSafeInteger(value) ? value : null;
    }

    function parseTable(rows) {
      const errors = [];
      if (!rows.length) return { ok: false, errors: ['檔案是空的'] };
      const header = rows[0];
      if (header.length !== HEADERS.length || header.some((h, idx) => h !== HEADERS[idx])) {
        return { ok: false, errors: [`第一列要剛好是：${HEADERS.join(',')}`] };
      }
      const items = [];
      const seenKeys = new Map();
      let lastOrder = 0;
      for (let r = 1; r < rows.length; r += 1) {
        const cells = rows[r];
        const line = r + 1;
        if (cells.length === 1 && cells[0] === '') continue; // 空白列
        if (cells.length !== HEADERS.length) { errors.push(`第 ${line} 列：要 7 欄，這列是 ${cells.length} 欄`); continue; }
        const [oText, code, style, dText, eText, fText, g] = cells;
        const o = strictInt(oText);
        const D = strictInt(dText);
        const E = strictInt(eText);
        const F = strictInt(fText);
        const bad = [];
        if (o === null || o <= 0) bad.push('處理順序不是正整數');
        if (D === null) bad.push('庫存來源總庫存不是 0 以上整數');
        if (E === null || E < 1) bad.push('蝦皮需灌入量要是 1 以上整數');
        if (F === null) bad.push('灌完還剩不是 0 以上整數');
        if (!CODE_RE.test(code)) bad.push(`商品編號「${code}」格式不對（要一個大寫字母或「預」＋2～3 位數字）`);
        if (!PROGRESS_VALUES.includes(g)) bad.push(`操作進度只能是「待處理」或「已完成」，這列是「${g}」`);
        if (D !== null && E !== null && F !== null && D - E !== F) bad.push(`總庫存 ${D} − 灌入 ${E} 不等於灌完還剩 ${F}`);
        if (o !== null && o <= lastOrder) bad.push('處理順序要由小到大');
        const key = `${code}\u0000${style}`;
        if (seenKeys.has(key)) bad.push(`商品編號＋精確款式和第 ${seenKeys.get(key)} 列重複`);
        if (bad.length) { errors.push(`第 ${line} 列（${code} ${style}）：${bad.join('；')}`); continue; }
        seenKeys.set(key, line);
        lastOrder = o;
        items.push({ o, code, style, D, E, F, G: g, line });
      }
      if (!items.length && !errors.length) errors.push('檔案裡沒有資料列');
      return errors.length ? { ok: false, errors } : { ok: true, items };
    }

    function daysInMonth(month) {
      return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    }

    function validPrefix(prefix) {
      if (!/^[0-9]{4}$/u.test(prefix)) return false;
      const month = Number(prefix.slice(0, 2));
      const day = Number(prefix.slice(2));
      return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(month);
    }

    function prefixFromFileName(fileName) {
      const match = /^([0-9]{4})(?![0-9])/u.exec(String(fileName || ''));
      if (!match || !validPrefix(match[1])) return { ok: false };
      return { ok: true, prefix: match[1] };
    }

    function productNameMatches(name, prefix, code) {
      const head = `${prefix}-${code}`;
      if (typeof name !== 'string' || !name.startsWith(head)) return false;
      const next = name.charAt(head.length);
      return !/[0-9]/u.test(next);
    }

    function resolveProduct(content, prefix, code) {
      if (!Array.isArray(content)) return { ok: false, reason: '商品搜尋沒有回應' };
      if (content.length >= AUTOCOMPLETE_LIMIT) {
        return { ok: false, reason: `搜「${prefix}-${code}」得到 ${content.length} 筆（頁面最多顯示 ${AUTOCOMPLETE_LIMIT} 筆），可能被截斷` };
      }
      const hits = content.filter((item) => item && productNameMatches(item.value, prefix, code));
      if (hits.length !== 1) return { ok: false, reason: `「${prefix}-${code}」對到 ${hits.length} 個在架商品` };
      const item = hits[0];
      if (!Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0) return { ok: false, reason: '商品序號讀不到' };
      if (item.combined === true) return { ok: false, reason: '這是組合商品，腳本不處理' };
      return { ok: true, item };
    }

    function readQuantity(source, esm) {
      const raw = esm ? source.stock_quantity : source.quantity;
      const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?[0-9]+$/u.test(raw) ? Number(raw) : NaN);
      return Number.isSafeInteger(value) ? value : null;
    }

    function styleQuantity(item, style) {
      const styles = Array.isArray(item.styles) ? item.styles : null;
      if (!styles) return { ok: false, reason: '商品的款式資料讀不到' };
      const esm = item.enable_stock_management === true;
      if (styles.some((s) => s && s.sub_keyword)) return { ok: false, reason: '這個商品有子款式，腳本還不處理' };
      if (style) {
        const hits = styles.filter((s) => s && s.keyword === style && !s.sub_keyword);
        if (hits.length !== 1) return { ok: false, reason: `款式「${style}」對到 ${hits.length} 個` };
        const q = readQuantity(hits[0], esm);
        if (q === null) return { ok: false, reason: '款式數量讀不到' };
        return { ok: true, q };
      }
      if (styles.length) return { ok: false, reason: '表上沒有款式，但商品有款式' };
      const q = readQuantity(item, esm);
      if (q === null) return { ok: false, reason: '商品數量讀不到' };
      return { ok: true, q };
    }

    // 預檢與送前的分類（Q2 丙；＝F 不灌）
    function classifyQuantity(row, q) {
      if (q === row.F) return 'manual_untried';
      if (q < row.E) return 'insufficient';
      return 'ok';
    }

    // 新單要是有效的「未成立單」：10-18 只讀查詢時貝貝的單依狀態分組全是 notestablished、trash_kind 全空白（分組統計只在當時的查詢輸出，沒寫進證據檔；證據檔留的是 G29 那 8 張）。
    // 棄單、狀態缺失、其他狀態（含已成立）都不算，交給人看（GPT 複審 F2）
    const NEW_ORDER_STATUS = 'notestablished';
    // 0.1.9（Ethan 2026-10-24：「只有『預』開頭的列，新單狀態 tobeconfirmed（預購）也算成功」）：
    // 真 JAMBO 預購商品的單（含客人的）狀態全是 tobeconfirmed／預購，不會是未成立。一般商品照舊只認未成立。
    const PREORDER_STATUS = 'tobeconfirmed';
    function isPreorderCode(code) { return /^預/u.test(String(code || '')); }
    function orderMatches(order, ctx) {
      const reasons = [];
      const okStatus = order.status === NEW_ORDER_STATUS || (isPreorderCode(ctx.code) && order.status === PREORDER_STATUS);
      if (!okStatus) reasons.push(`狀態是「${order.status || '（空白）'}」，不是${isPreorderCode(ctx.code) ? '未成立單或預購單' : '未成立單'}`);
      if (order.trash_kind) reasons.push(`有棄單標記「${order.trash_kind}」`);
      if (order.from_id !== ctx.fromId) reasons.push('帳號 ID 不同');
      if (Number(order.user_id) !== Number(ctx.shopId)) reasons.push('店家不同');
      if (Number(order.commodity_id) !== Number(ctx.commodityId)) reasons.push('商品序號不同');
      if ((order.has_style || '') !== (ctx.style || '')) reasons.push(`款式是「${order.has_style || ''}」`);
      if (Number(order.quantity) !== ctx.E) reasons.push(`件數是 ${order.quantity}`);
      if (!productNameMatches(String(order.name || ''), ctx.prefix, ctx.code)) reasons.push('品名開頭不是這個商品');
      return reasons;
    }

    // 訂單查詢結果的完整性：每頁是陣列、翻頁有結束、不重複張數＝總數、每張屬於店家＋貝貝＋這個商品
    function checkOrderPages(countOnly, pages, ctx) {
      if (!Number.isSafeInteger(countOnly) || countOnly < 0) return { complete: false, reason: '訂單總數讀不到' };
      if (!Array.isArray(pages) || !pages.length) return { complete: false, reason: '訂單查詢沒有回應' };
      if (pages.some((p) => !Array.isArray(p))) return { complete: false, reason: '訂單查詢回應不是清單（可能登出或錯誤頁）' };
      if (pages[pages.length - 1].length !== 0) return { complete: false, reason: '訂單翻頁沒有正常結束' };
      const map = {};
      let total = 0;
      for (const page of pages) {
        for (const order of page) {
          total += 1;
          if (!order || !Number.isSafeInteger(order.id)) return { complete: false, reason: '有訂單沒有單號' };
          if (Number(order.user_id) !== Number(ctx.shopId)) return { complete: false, reason: `單 ${order.id} 的店家不是 ${ctx.shopId}` };
          if (order.from_id !== ctx.fromId) return { complete: false, reason: `單 ${order.id} 的帳號 ID 不是貝貝` };
          if (Number(order.commodity_id) !== Number(ctx.commodityId)) return { complete: false, reason: `單 ${order.id} 的商品序號不同` };
          map[String(order.id)] = {
            id: order.id,
            serial: order.serial || '',
            name: order.name || '',
            has_style: order.has_style || '',
            quantity: order.quantity,
            status: order.status || '',
            trash_kind: order.trash_kind || '',
            commodity_id: order.commodity_id,
            from_id: order.from_id,
            user_id: order.user_id,
            created_time: order.created_time || '',
          };
        }
      }
      const unique = Object.keys(map).length;
      if (unique !== total) return { complete: false, reason: '翻頁出現重複的單' };
      if (unique !== countOnly) return { complete: false, reason: `訂單總數 ${countOnly} 和實際讀到的 ${unique} 張不同` };
      return { complete: true, orders: map };
    }

    const BASELINE_FIELDS = ['has_style', 'quantity', 'status', 'trash_kind', 'commodity_id', 'from_id', 'user_id'];

    function diffOrders(before, after) {
      const changed = [];
      for (const id of Object.keys(before)) {
        const a = after[id];
        if (!a) { changed.push(`${id} 不見了`); continue; }
        for (const field of BASELINE_FIELDS) {
          if (String(a[field]) !== String(before[id][field])) changed.push(`${id} 的 ${field} 變了`);
        }
      }
      const newIds = Object.keys(after).filter((id) => !Object.prototype.hasOwnProperty.call(before, id)).sort();
      return { baselineChanged: changed.length > 0, changed, newIds };
    }

    // 人工填的單號（例 BD261023-358241064 或 358241064，可多個用空白隔開）→ 訂單編號
    function orderIdsFromText(text) {
      return String(text || '').split(/[\s,，、]+/u).map((t) => t.trim()).filter(Boolean)
        .map((t) => { const m = /([0-9]+)$/u.exec(t); return m ? String(Number(m[1])) : ''; })
        .filter((id) => id && id !== '0');
    }

    // 0.1.5（GPT 複驗 0.1.4 問題二；Ethan 10-23 選甲）：
    // 同商品（訂單查詢本來就只查這個商品序號＋貝貝）、同款式、沒有棄單標記、又不是腳本認得的單 → 視為「腳本以外已有的單」。
    // 狀態不限（未成立、已成立都算），寧可多問。knownIds 是 Set（字串單號）。
    function unmanagedOrders(orders, style, knownIds) {
      const out = [];
      for (const id of Object.keys(orders || {}).sort()) {
        const o = orders[id];
        if (!o || o.trash_kind) continue;
        if ((o.has_style || '') !== (style || '')) continue;
        if (knownIds && knownIds.has(String(o.id))) continue;
        out.push({ id: String(o.id), serial: o.serial || '', quantity: o.quantity, status: o.status || '', created_time: o.created_time || '' });
      }
      return out;
    }
    function describeOrders(list) {
      return list.map((o) => `${o.serial || o.id}×${o.quantity}${o.created_time ? ` ${o.created_time}` : ''}${o.status && o.status !== 'notestablished' ? `（${o.status}）` : ''}`).join('、');
    }

    // v0.3 §4：命中第一列就停在那一列
    function judgeAfterSubmit(input) {
      const delta = input.newOrders || [];
      const T = input.qpre - input.e;
      const out = (state, code, reason) => ({ state, code, reason });
      if (!input.complete) return out('unresolved', 'incomplete', `訂單證據不完整：${input.incompleteReason || ''}`.trim());
      if (input.baselineChanged) return out('unresolved', 'baseline_changed', `送出前就有的單不見或被改：${(input.changed || []).join('、')}`);
      if (input.rejectedBeforeSubmit && delta.length >= 1) return out('unresolved', 'rejected_but_new', '看到數量不足視窗，卻又有新單');
      if (delta.length >= 2) return out('unresolved', 'multiple_new', `多了 ${delta.length} 張新單，可能送了兩次`);
      if (delta.length === 1 && delta[0].reasons.length) return out('unresolved', 'new_mismatch', `新單和這列不符：${delta[0].reasons.join('、')}`);
      if (delta.length === 0 && input.rejectedBeforeSubmit && input.shortage) return out('insufficient', 'insufficient', '按儲存時頁面說數量不足，已按取消，確認沒有送出');
      if (delta.length === 0 && input.pageProblem) return out('unresolved', 'page_problem', `頁面出現其他狀況：${input.pageProblem}`);
      if (delta.length === 0) return out('unresolved', 'no_new', '查不到這次的新單，看起來沒存到（不會自動重送）');
      if (!Number.isSafeInteger(input.qpost)) return out('unresolved', 'qpost_unknown', '有新單，但灌後數量讀不到');
      if (input.qpost === input.qpre) return out('unresolved', 'qpost_unchanged', '有新單，但數量沒有變');
      if (input.qpost === T - input.e) return out('unresolved', 'minus_e_again', `灌完又剛好少了 ${input.e} 件，可能送了兩次（也可能是客人剛好買走）`);
      if (input.qpost === T) return out('completed', 'ok', '');
      return out('completed', 'ok_diff', `數量差異 ${input.qpost - T}，來源未確認`);
    }

    function csvCell(value) {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
    }

    const RESULT_HEADERS = Object.freeze([...HEADERS, '狀態', 'Qpre', 'T', 'Qpost', 'Qpre−D', 'Qpost−T', 'Qpost−F', '訂單編號', '全部新單號', '商品序號', '時間', '原因', '人工結論', '最後讀到的量']);

    function resultCsv(rows) {
      const lines = [RESULT_HEADERS.map(csvCell).join(',')];
      for (const row of rows) {
        const has = (v) => Number.isSafeInteger(v);
        const progress = row.state === 'completed' || row.state === 'manual_found' ? '已完成' : row.G;
        const manualText = row.manual ? `${row.manual.conclusion}${row.manual.orderId ? `（單號 ${row.manual.orderId}）` : ''}${row.manual.note ? `：${row.manual.note}` : ''}｜${row.manual.at}` : '';
        const ackText = Array.isArray(row.priorAck) && row.priorAck.length ? `人工確認單號 ${row.priorAck.join(' ')} 是上一輪的舊單、這列要再灌｜${row.priorAckAt || ''}` : '';
        const manual = [manualText, ackText].filter(Boolean).join('；');
        lines.push([
          row.o, row.code, row.style, row.D, row.E, row.F, progress,
          STATE_LABEL[row.state] || row.state,
          has(row.qpre) ? row.qpre : '',
          has(row.t) ? row.t : '',
          has(row.qpost) ? row.qpost : '',
          has(row.qpre) ? row.qpre - row.D : '',
          has(row.qpost) && has(row.t) ? row.qpost - row.t : '',
          has(row.qpost) ? row.qpost - row.F : '',
          row.orderSerial || row.orderId || '',
          (row.newIds || []).join(' '),
          row.commodityId || '',
          row.at || '',
          row.reason || '',
          manual,
          has(row.qfinal) ? row.qfinal : (row.finalUnreadable ? '讀不到' : ''),
        ].map(csvCell).join(','));
      }
      return `﻿${lines.join('\r\n')}\r\n`;
    }

    function summarize(rows) {
      const counts = {};
      for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
      return counts;
    }

    return {
      VERSION, SPEC_VERSION, BEI, HEADERS, STATE_LABEL, INSUFFICIENT_MESSAGE, AUTOCOMPLETE_LIMIT, ORDER_PAGE_SIZE,
      decodeUtf8Strict, parseCsv, parseTable, validPrefix, prefixFromFileName, productNameMatches,
      resolveProduct, styleQuantity, classifyQuantity, orderMatches, checkOrderPages, diffOrders,
      orderIdsFromText, unmanagedOrders, describeOrders,
      judgeAfterSubmit, resultCsv, summarize, csvCell,
    };
  })();

  if (typeof module === 'object' && module && module.exports) {
    module.exports = CORE;
    return;
  }

  // ───────────────────────── 瀏覽器端 ─────────────────────────
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.top !== W.self) return;
  if (!/^\/console\/order\/new\/?$/u.test(W.location.pathname)) return;
  const rootAtEntry = W.document.documentElement;
  if (W.__jfoInitDone || (rootAtEntry && rootAtEntry.dataset.jfoInit)) return;
  W.__jfoInitDone = true;
  if (rootAtEntry) rootAtEntry.dataset.jfoInit = '1';

  // ── 0.1.5：換頁監看在這裡就裝上（GPT 複驗 0.1.4 問題一）──
  // 腳本用 @run-at document-start：篡改猴在頁面任何程式執行前注入。從這一行到下面裝好監聽，中間沒有任何等待。
  // 已經開始、還在等回應的換頁，晚裝的監聽完全看不到（10-23 在 Chrome 155 實測：navigation.transition 是 null、currentEntry 不變、收不到事件），
  // 所以「開始監看之前有沒有別的換頁」只能靠「腳本開始得夠早」：
  //   文件還在載入、還沒有 body、頁面上除了自己以外一個 <script> 都還沒有 → 頁面自己的程式還沒有機會執行、畫面也還沒有東西可以點。
  //   這不能排除更早執行、又不留 <script> 的其他擴充套件，也看不到網址列直接打網址（瀏覽器不發事件）；這兩項寫在交回文件的殘留風險。
  // 不夠早（例如篡改猴晚注入），就不自動接續，停下要人按「繼續」。
  const entryFacts = (() => {
    const d = W.document;
    const scripts = d.scripts ? Array.from(d.scripts).filter((s) => s !== d.currentScript).length : -1;
    const facts = { readyState: d.readyState, hasBody: !!d.body, otherScripts: scripts };
    facts.early = facts.readyState === 'loading' && !facts.hasBody && facts.otherScripts === 0;
    return facts;
  })();
  // 換頁計數器（GPT 複驗 0.1.3 的 X5-R2；0.1.5 改在入口就裝）：任何換頁（含頁面別的程式發起的）都加一，從不重設。
  // 腳本自己會讓頁面換掉的動作（按儲存、換頁回空白表單）一定在「計數還是 0」的核對之後才做，做完頁面就換了；
  // 所以按下前、換頁前只要看到計數不是 0，就代表這一頁已經有別的換頁開始。下載檔案（例如按「下載結果」）不算換頁。
  const navLog = { seq: 0, last: '', installed: false };
  if (hasNavigationApi()) installNavSentinel();

  const doc = W.document;
  const LOCK_PREFIX = 'jambo-fulfillment';
  const RECHECK_TIMES = 5;
  const RECHECK_DELAY = 2000;
  const SUBMIT_WATCH_MS = 20000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nowText = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const randomId = () => {
    const a = new Uint8Array(12);
    W.crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  async function sha256Hex(bytes) {
    const digest = await W.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function waitFor(fn, ms, label) {
    const t0 = Date.now();
    for (;;) {
      let value = null;
      try { value = fn(); } catch (_e) { value = null; }
      if (value) return value;
      if (Date.now() - t0 > (ms || 8000)) throw new Error(`等待逾時：${label || ''}`);
      await sleep(100);
    }
  }

  const ctx = {
    $: null,
    shopId: null,
    tabId: null,
    gen: randomId(),
    lockHeld: false,
    disabledReason: '',
    dockDisabledKind: 'environment',
    busy: false,
    navigating: false,
    loaded: null, // 選檔後還沒建立輪次的資料
    precheck: null,
    autoResumed: false, // 這一頁是不是自動接續（不是人按的）
  };

  // ── GM 儲存（寫入一定讀回比對）──
  function storeKey() { return `jfo:v1:${ctx.shopId}:${CORE.BEI.fromId}`; }
  function emptyState() {
    return { schema: 1, shopId: ctx.shopId, fromId: CORE.BEI.fromId, owner: null, expect: null, rounds: [], activeRoundId: null };
  }
  function loadState() {
    const raw = GM_getValue(storeKey(), null);
    if (raw === null || raw === undefined) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== 1) throw new Error('灌單紀錄格式不認得');
    return parsed;
  }
  function saveState(state) {
    const text = JSON.stringify(state);
    GM_setValue(storeKey(), text);
    const back = GM_getValue(storeKey(), null);
    if (back !== text) throw new Error('灌單紀錄寫入後讀回不同');
  }
  function gmGetTab() {
    return new Promise((resolve, reject) => {
      try {
        const r = GM_getTab((tab) => resolve(tab || {}));
        if (r && typeof r.then === 'function') r.then((tab) => resolve(tab || {}), reject);
      } catch (error) { reject(error); }
    });
  }
  async function gmSaveTab(tab) {
    const r = GM_saveTab(tab);
    if (r && typeof r.then === 'function') await r;
    const back = await gmGetTab();
    if (JSON.stringify(back) !== JSON.stringify(tab)) throw new Error('分頁紀錄寫入後讀回不同');
  }

  function activeRound(state) {
    return state.rounds.find((r) => r.roundId === state.activeRoundId) || null;
  }
  function blockingRows(state) {
    const out = [];
    for (const round of state.rounds) {
      round.rows.forEach((row, index) => {
        if (row.state === 'submitted' || row.state === 'unresolved') out.push({ round, row, index });
      });
    }
    return out;
  }
  function isOwner(state) {
    return !!(state.owner && state.owner.tabId === ctx.tabId && state.owner.gen === ctx.gen);
  }
  // 腳本認得的單（0.1.6 依 GPT 複驗 0.1.5 收斂）：只有
  //   ① 送後核對完成、確定是這一列建的那一張（row.orderId）；
  //   ② 員工明確確認的單號（「已在 JAMBO 找到這張單」填的單號、「這一列已經灌過」那幾張）；
  //   ③「這一列」人工確認過是上一輪舊單的單號（priorAck；只算這一列，不外推到別列、別輪）。
  // 送後「看到的新單」（newIds）只是證據，不代表那些單是這一列的、也不代表已確認——不收進來
  // （例：一列送後看到兩張新單，員工只確認其中一張，另一張別款式的單仍要在它那一列被問）。
  // 同款單不在這裡面＝腳本以外已有的單（手動灌、別台電腦灌…）。
  function knownOrderIds(state, roundId, index) {
    const ids = new Set();
    for (const round of state.rounds) {
      for (const row of round.rows) {
        if (row.orderId) ids.add(String(row.orderId));
        for (const id of row.manualOrderIds || []) ids.add(String(id));
        if (row.manual && row.manual.orderId) for (const id of CORE.orderIdsFromText(row.manual.orderId)) ids.add(id);
      }
    }
    if (roundId) {
      const round = state.rounds.find((r) => r.roundId === roundId);
      const row = round && round.rows[index];
      for (const id of (row && row.priorAck) || []) ids.add(String(id));
    }
    return ids;
  }

  // ── 頁面 ──
  function $q(selector) { return ctx.$(selector); }
  function field(name) { return ctx.$(`[name='${name}']`); }
  function readShopId() {
    const sources = [];
    sources.push(W.GA4_USER_ID);
    sources.push(W.AI_ASSISTANT_OPTIONS && W.AI_ASSISTANT_OPTIONS.userId);
    try {
      const src = String(ctx.$('#order-name').autocomplete('option', 'source'));
      const m = /\/console\/api\/commodities\/([0-9]+)\//u.exec(src);
      sources.push(m ? m[1] : undefined);
    } catch (_e) { sources.push(undefined); }
    const values = sources.map((v) => (v === undefined || v === null ? null : String(v)));
    if (values.some((v) => v === null || !/^[0-9]+$/u.test(v))) return { ok: false, reason: '店家編號有來源讀不到' };
    if (new Set(values).size !== 1) return { ok: false, reason: `店家編號三個來源不一致：${values.join('／')}` };
    return { ok: true, shopId: values[0] };
  }
  function accountOk() {
    return field('from_name').val() === CORE.BEI.name && field('from_id').val() === CORE.BEI.fromId;
  }
  function formBlank() {
    return !field('name').val() && !field('commodity_id').val() && !field('style').val() && !field('sub_style').val();
  }
  function openDialog() {
    return doc.querySelector('dialog[open]');
  }
  function cleanUrl() {
    const u = new URL('/console/order/new/', W.location.origin);
    u.search = `?provider=&from_id=${encodeURIComponent(CORE.BEI.fromId)}&from_name=${encodeURIComponent(CORE.BEI.name)}&object_id=`;
    return u.toString();
  }
  function staticChecks() {
    const shop = readShopId();
    if (!shop.ok) return shop.reason;
    if (shop.shopId !== ctx.shopId) return '店家編號和開頁時不同';
    if (!accountOk()) return '帳號不是貝貝💕（或帳號 ID 不對）';
    if (field('is_part_number').prop('checked')) return '「以料號搜尋」被勾起來了';
    if (field('from_id').attr('data-is-vip') === 'true') return '貝貝💕被設成 VIP，頁面會改價格，腳本不處理';
    return '';
  }

  // 送前完整核對（同步）：S8 用一次，最後一次 await 之後、click 之前再用一次
  function preSubmitProblems(row, item, qpre) {
    const checks = [];
    const p2 = staticChecks();
    if (p2) checks.push(p2);
    if (field('name').val() !== item.value) checks.push('商品名');
    if (field('commodity_id').val() !== String(item.id)) checks.push('商品序號');
    if (field('style').val() !== (row.style || '') || field('sub_style').val() !== '') checks.push('款式');
    if (field('quantity').val() !== String(row.E)) checks.push(`件數是 ${field('quantity').val()}`);
    if (String(field('price').val()) !== String(item.price)) checks.push('價格和商品資料不同');
    if (String(field('cost').val()) !== String(item.cost)) checks.push('成本和商品資料不同');
    if (String(field('discount').val()) !== String(item.discount)) checks.push('折扣和商品資料不同');
    if (String(field('session').val()) !== String(item.session || '')) checks.push('場次和商品資料不同');
    if (String($q('#remaining_quantity').html()).trim() !== String(qpre)) checks.push(`剩餘數量顯示 ${$q('#remaining_quantity').html()}`);
    if (openDialog()) checks.push('有開著的視窗');
    return checks;
  }

  // autocomplete：觸發頁面原本的搜尋，等這一次的回應
  function acSearch($inp, term) {
    return new Promise((resolve, reject) => {
      const inst = $inp.autocomplete('instance');
      let done = false;
      const handler = (_event, ui) => {
        if (inst.term !== term) return;
        done = true;
        $inp.off('autocompleteresponse', handler);
        resolve(ui && Array.isArray(ui.content) ? ui.content.slice() : []);
      };
      $inp.on('autocompleteresponse', handler);
      $inp.trigger('focus');
      $inp.val(term);
      $inp.autocomplete('search', term);
      setTimeout(() => {
        if (done) return;
        $inp.off('autocompleteresponse', handler);
        reject(new Error(`搜尋「${term}」逾時`));
      }, 15000);
    });
  }
  async function acPick($inp, item) {
    const $ = ctx.$;
    const inst = $inp.autocomplete('instance');
    const li = await waitFor(() => {
      const w = $inp.autocomplete('widget');
      if (!w.is(':visible')) return null;
      const m = w.find('li').filter((_i, el) => $(el).data('ui-autocomplete-item') === item);
      return m.length === 1 ? m : null;
    }, 8000, '選單出現');
    let tries = 0;
    while (tries < 5 && !(inst.menu.active && inst.menu.active[0] === li[0])) {
      inst.menu.focus($.Event('mouseenter'), li);
      tries += 1;
    }
    if (!(inst.menu.active && inst.menu.active[0] === li[0])) throw new Error('選單項目選不到');
    inst.menu.select($.Event('click'));
  }
  function acClear($inp) {
    try { $inp.autocomplete('close'); } catch (_e) { /* 沒開也沒關係 */ }
    $inp.val('');
  }

  // 只讀：搜這個商品、取目標款式的量（不選）
  async function readProductQuantity(prefix, row) {
    const $inp = $q('#order-name');
    const content = await acSearch($inp, `${prefix}-${row.code}`);
    const product = CORE.resolveProduct(content, prefix, row.code);
    acClear($inp);
    if (!product.ok) return { ok: false, reason: product.reason };
    const sq = CORE.styleQuantity(product.item, row.style);
    if (!sq.ok) return { ok: false, reason: sq.reason, item: product.item };
    return { ok: true, item: product.item, q: sq.q };
  }

  // 訂單查詢（只讀；頁面自己用的介面）
  function postOrders(params) {
    return new Promise((resolve, reject) => {
      ctx.$.ajax({ type: 'POST', url: `/console/api/orders/get/${ctx.shopId}/`, data: params, dataType: 'json', timeout: 20000 })
        .done((data) => resolve(data))
        .fail((xhr, status) => reject(new Error(`訂單查詢失敗（${status || ''} ${xhr && xhr.status}）`)));
    });
  }
  function orderQuery(commodityId) {
    return {
      cs_mode: 0, request_user_id: ctx.shopId, first: '', search: CORE.BEI.fromId, is_from_id: true,
      search_field: 'from_name', from_name: '', search_style: '', commodity_id: String(commodityId), kind: 'all',
      provider: '', sessions: '', begin: '', end: '', search_begin: '', search_end: '',
      default_order_by: 'desc', default_order_item: 'date', managed_pickup_point: '',
    };
  }
  async function readOrders(commodityId) {
    const base = orderQuery(commodityId);
    const evidenceCtx = { shopId: ctx.shopId, fromId: CORE.BEI.fromId, commodityId };
    try {
      const count = await postOrders({ ...base, count_only: true });
      const pages = [];
      let last = '';
      const maxPages = Math.floor((Number.isSafeInteger(count) ? count : 0) / CORE.ORDER_PAGE_SIZE) + 2;
      for (let p = 0; p <= maxPages; p += 1) {
        const data = await postOrders(last ? { ...base, last } : base);
        pages.push(data);
        if (!Array.isArray(data) || data.length === 0) break;
        last = String(data[data.length - 1].id);
      }
      return CORE.checkOrderPages(count, pages, evidenceCtx);
    } catch (error) {
      return { complete: false, reason: error.message };
    }
  }

  // ── 面板 ──
  const ui = {};
  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'style') node.setAttribute('style', v);
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children || []) node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    return node;
  }
  function button(text, onClick, id) {
    return el('button', { type: 'button', id: id || '', style: 'margin:2px 4px 2px 0;padding:4px 10px;border:1px solid #c33;background:#fff;color:#c33;border-radius:4px;cursor:pointer;font-size:13px', onclick: onClick, text });
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
  let dock=null,dockBusy=false,dockReady=false,dockLastState='',dockFault='';
  function dockError(key){if(!dock)return;if(key!==dockFault){dockFault=key;dock.status(true);}}
  function dockWarning(kind,key){if(!dock)return;if(!key){dockFault='';dock.status(false);return;}if(kind==='error'){dockFault='';dockError(key);}else if(kind==='notice')dock.setNotice(true);}
  function dockExecution(running){if(!dock)return;const started=running&&!dockBusy;dockBusy=running;if(started){dockFault='';dock.status(false);dock.setBadge({running:true,start:true,reset:true});}else dock.setBadge({running});}
  function dockState(state){if(!dock)return;const round=activeRound(state),mine=ctx.lockHeld&&isOwner(state),running=ctx.busy||!!(mine&&round?.status==='running');
    dockExecution(running);
    const pending=!!blockingRows(state).length||!!round?.rows.some(row=>row.state==='manual_untried')||!!round?.finalNotes?.length;
    dock.setNotice(!ctx.lockHeld||!!(round&&['paused','stopped'].includes(round.status))||pending||!!(ctx.loaded&&!ctx.loaded.prefix));
    const signature=round?round.roundId+':'+round.status+':'+(round.doneAt||''):'idle';
    if(signature!==dockLastState){dockReady=!!(round?.status==='done'&&dockLastState.startsWith(round.roundId+':running:')&&!pending&&!dockFault);dockLastState=signature;}
    if(dockReady&&!running&&!dockFault){dock.setBadge({running:false,outcome:'complete'});dockReady=false;}
  }
  function buildPanel() {
    const panel = el('div', { id: 'jfo-panel', style: 'position:fixed;top:70px;right:12px;width:440px;max-height:82vh;overflow:auto;z-index:2147483000;background:#fff;border:2px solid #c33;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.2);font:13px/1.5 sans-serif;color:#222;padding:10px' });
    ui.title = el('div', { style: 'font-weight:bold;font-size:15px;margin-bottom:6px', text: 'Jambo 灌單' });
    ui.status = el('div', { id: 'jfo-status', style: 'white-space:pre-wrap;margin-bottom:6px', text: '準備中…' });
    ui.prefix = el('div', { id: 'jfo-prefix', style: 'font-size:22px;font-weight:bold;color:#c33;margin:4px 0' });
    ui.file = el('input', { type: 'file', id: 'jfo-file', accept: '.csv', style: 'margin:4px 0' });
    ui.file.addEventListener('change', onFileChosen);
    ui.prefixInput = el('input', { type: 'text', id: 'jfo-prefix-input', placeholder: '日期前綴（四碼，例 1016）', style: 'display:none;width:160px;margin:4px 0' });
    ui.prefixInput.addEventListener('change', onPrefixTyped);
    ui.controls = el('div', { id: 'jfo-controls', style: 'margin:6px 0' });
    ui.warn = el('div', { id: 'jfo-warn', style: 'color:#a00;white-space:pre-wrap' });
    ui.table = el('div', { id: 'jfo-table', style: 'margin-top:6px' });
    ui.issues = el('div', { id: 'jfo-issues', style: 'margin-top:6px' });
    ui.log = el('div', { id: 'jfo-log', style: 'margin-top:6px;color:#555;font-size:12px;white-space:pre-wrap;max-height:160px;overflow:auto' });
    const notice = el('div', { style: 'font-size:12px;color:#555;margin:4px 0', text: '灌單期間，請不要有人（包含別台電腦）手動新增貝貝💕的訂單；腳本會把多出來的單當成異常而停下。' });
    panel.append(ui.title, ui.status, ui.prefix, ui.file, ui.prefixInput, notice, ui.warn, ui.controls, ui.issues, ui.table, ui.log);
    doc.body.appendChild(panel);
    const collapse=button("收合",()=>{},"jfo-collapse");ui.title.appendChild(collapse);
    dock=createEthanToolDock({id:"jambo-fulfillment",label:"灌單",name:"Jambo 灌單",version:CORE.VERSION,order:20,colour:"#cc3333",panel,collapse,lockRunning:true,lockText:"灌單中"});
  }
  function log(text) {
    if (!ui.log) return;
    ui.log.textContent = `${nowText().slice(11)} ${text}\n${ui.log.textContent}`.slice(0, 6000);
  }
  function setStatus(text) { if (ui.status) ui.status.textContent = text; }
  function setWarn(text, dockKind='error') { if (ui.warn) ui.warn.textContent = text || ''; dockWarning(dockKind,text); }

  function render() {
    if (!ui.controls) return;
    ui.controls.textContent = '';
    ui.issues.textContent = '';
    ui.table.textContent = '';
    if (ctx.disabledReason) {
      dock?.setBadge({running:false,outcome:"cancelled",reset:true});dock?.status(false);dock?.setNotice(ctx.dockDisabledKind!=="irrelevant");
      setStatus(`灌單停用：${ctx.disabledReason}`);
      if (ui.file) ui.file.style.display = 'none';
      return;
    }
    let state;
    try { state = loadState(); } catch (error) { dockError("record:"+error.message);setStatus(`紀錄讀不到：${error.message}`); return; }
    const round = activeRound(state);
    dockState(state);
    const roundOpen = !!round && round.status !== 'done' && round.status !== 'closed';
    const blockers = blockingRows(state);
    if (!ctx.lockHeld) {
      setStatus('另一個分頁正在使用灌單（或剛重新整理）。這個分頁只能看，不能操作。');
      if (round && roundOpen) {
        ui.controls.append(button('接手（原分頁已關或卡住時才按）', onTakeoverFromReadOnly, 'jfo-takeover-readonly'));
      }
      if (round) renderRows(round);
      return;
    }
    if (blockers.length) renderBlockers(state, blockers);
    if (round) {
      const owner = state.owner;
      const mine = isOwner(state);
      const sameTab = !!(owner && owner.tabId === ctx.tabId);
      const label = { running: '灌單中', paused: '已暫停', stopped: '已停止', done: '已做完', closed: '已結束' }[round.status] || round.status;
      setStatus(`輪次 ${round.roundId.slice(0, 6)}｜${round.fileName}｜前綴 ${round.prefix}（${round.prefixSource === 'file' ? '從檔名' : '員工填的'}）｜${label}${owner && !sameTab && roundOpen ? '｜原本由另一個分頁執行' : ''}${round.status === 'paused' && round.pauseReason ? `\n${round.pauseReason}` : ''}`);
      ui.prefix.textContent = round.prefix;
      if (round.status === 'running' && mine) {
        ui.controls.append(button('暫停（做完這一列就停）', onPause, 'jfo-pause'));
      } else if (roundOpen) {
        if (!blockers.length) {
          if (owner && !sameTab && round.status === 'running') ui.controls.append(button('接手', onTakeover, 'jfo-takeover'));
          else ui.controls.append(button('繼續', onStart, 'jfo-start'));
        }
        ui.controls.append(button('結束這一輪', onCloseRound, 'jfo-close-round'));
      }
      ui.controls.append(button('下載結果', onDownload, 'jfo-download'));
      renderPrior(round);
      renderRows(round);
    } else {
      setStatus(blockers.length ? '有還沒處理的列，先處理才能開始新的灌單。' : '請選灌單表（控貨助手另存的 .csv）。');
    }
    if (ctx.loaded && !roundOpen) renderLoaded();
  }

  function renderRows(round) {
    const counts = CORE.summarize(round.rows);
    const summary = Object.entries(counts).map(([k, v]) => `${CORE.STATE_LABEL[k] || k} ${v}`).join('、');
    ui.table.appendChild(el('div', { id: 'jfo-summary', style: 'font-weight:bold;margin:4px 0', text: `共 ${round.rows.length} 列：${summary}` }));
    const table = el('table', { style: 'border-collapse:collapse;width:100%;font-size:12px' });
    table.appendChild(el('tr', {}, ['順序', '商品', '款式', 'D', 'E', 'Qpre', 'Qpost', '狀態'].map((h) => el('th', { style: 'border-bottom:1px solid #ccc;text-align:left', text: h }))));
    for (const row of round.rows) {
      const tr = el('tr', { 'data-o': String(row.o), 'data-state': row.state }, [
        String(row.o), row.code, row.style || '（無）', String(row.D), String(row.E),
        Number.isSafeInteger(row.qpre) ? String(row.qpre) : '', Number.isSafeInteger(row.qpost) ? String(row.qpost) : '',
        (CORE.STATE_LABEL[row.state] || row.state) + (row.reason ? `：${row.reason}` : ''),
      ].map((t) => el('td', { style: 'border-bottom:1px solid #eee;vertical-align:top', text: t })));
      table.appendChild(tr);
    }
    ui.table.appendChild(table);
  }

  function renderBlockers(state, blockers) {
    ui.issues.appendChild(el('div', { style: 'font-weight:bold;color:#a00', text: '以下的列結果不明，要先在 JAMBO 訂單頁查過、選一個結論，才能繼續或開新的灌單（腳本不會自動重送）：' }));
    for (const { round, row, index } of blockers) {
      const box = el('div', { class: 'jfo-blocker', 'data-round': round.roundId, 'data-index': String(index), style: 'border:1px solid #f99;padding:4px;margin:4px 0' });
      box.appendChild(el('div', { text: `第 ${row.o} 列 ${row.code} ${row.style || '（無款式）'} ×${row.E}｜${CORE.STATE_LABEL[row.state]}${row.reason ? `：${row.reason}` : ''}${row.newIds && row.newIds.length ? `｜新單：${row.newIds.join(' ')}` : ''}` }));
      if (row.state === 'submitted') {
        box.appendChild(button('核對這一列', () => onVerifyBlocker(round.roundId, index)));
      } else {
        const orderInput = el('input', { type: 'text', placeholder: '找到的單號', style: 'width:150px' });
        const noteInput = el('input', { type: 'text', placeholder: '說明', style: 'width:150px' });
        box.append(orderInput, noteInput, el('br'));
        box.appendChild(button('已在 JAMBO 找到這張單', () => onResolve(round.roundId, index, 'found', orderInput.value, noteInput.value)));
        box.appendChild(button('確定沒有建立', () => onResolve(round.roundId, index, 'not_created', '', noteInput.value)));
        box.appendChild(button('其他（寫說明）', () => onResolve(round.roundId, index, 'other', '', noteInput.value)));
      }
      ui.issues.appendChild(box);
    }
  }

  // 0.1.5：已有不是腳本建的同款單的列，逐列選結論（Ethan 10-23 選甲）。灌單中不能選，避免和主迴圈同時改紀錄。
  function renderPrior(round) {
    const rows = round.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.state === 'manual_untried' && Array.isArray(row.priorUnknown) && row.priorUnknown.length);
    if (!rows.length) return;
    const wrap = el('div', { id: 'jfo-prior', style: 'margin:6px 0' });
    wrap.appendChild(el('div', { style: 'font-weight:bold;color:#a00', text: `有 ${rows.length} 列，貝貝💕在同商品＋同款式已經有不是腳本建的單，腳本沒有灌。請到 JAMBO 確認後逐列選：` }));
    const running = round.status === 'running';
    if (running) wrap.appendChild(el('div', { style: 'color:#a00;font-size:12px', text: '灌單中不能選；請按暫停，或等這一輪做完。' }));
    for (const { row, index } of rows) {
      const box = el('div', { class: 'jfo-prior-row', 'data-o': String(row.o), style: 'border:1px solid #f99;padding:4px;margin:4px 0' });
      box.appendChild(el('div', { text: `第 ${row.o} 列 ${row.code} ${row.style || '（無款式）'} ×${row.E}｜已有：${CORE.describeOrders(row.priorUnknown)}` }));
      if (!running) {
        box.appendChild(button('這一列已經灌過（記成完成，不灌）', () => onPriorResolve(round.roundId, index, 'done'), `jfo-prior-done-${row.o}`));
        box.appendChild(button('這是上一輪的舊單，這一列要再灌', () => onPriorResolve(round.roundId, index, 'again'), `jfo-prior-again-${row.o}`));
      }
      wrap.appendChild(box);
    }
    ui.issues.appendChild(wrap);
  }

  function onPriorResolve(roundId, index, kind) {
    try {
      const state = loadState();
      const round = state.rounds.find((r) => r.roundId === roundId);
      const row = round && round.rows[index];
      if (!row || row.state !== 'manual_untried' || !Array.isArray(row.priorUnknown) || !row.priorUnknown.length) return;
      if (round.status === 'running') throw new Error('灌單中不能改，請先按暫停、等這一列做完');
      if (round.status === 'closed') throw new Error('這一輪已經結束，不能改');
      const ids = row.priorUnknown.map((o) => String(o.id));
      if (kind === 'done') {
        row.manual = { conclusion: '腳本以外已灌過（人工確認）', orderId: row.priorUnknown.map((o) => o.serial || o.id).join(' '), note: '', at: nowText(), previousReason: row.reason, previousState: row.state };
        row.manualOrderIds = ids;
        row.state = 'manual_found';
        log(`第 ${row.o} 列人工結論：腳本以外已灌過，記成完成（單號 ${ids.join(' ')}）`);
      } else if (kind === 'again') {
        row.priorAck = [...new Set([...(row.priorAck || []), ...ids])];
        row.priorAckAt = nowText();
        row.priorUnknown = [];
        row.state = 'pending';
        row.reason = '';
        if (round.status === 'done') { round.status = 'paused'; round.pauseReason = '有列改回待處理，請按「繼續」'; }
        state.activeRoundId = round.roundId;
        log(`第 ${row.o} 列人工結論：單號 ${ids.join(' ')} 是上一輪的舊單，這一列改回待處理（按「繼續」才會灌）`);
      } else {
        return;
      }
      saveState(state);
      render();
    } catch (error) { setWarn(error.message); }
  }

  function renderLoaded() {
    const L = ctx.loaded;
    ui.table.appendChild(el('div', { text: `檔名：${L.fileName}｜${L.items.length} 列｜處理順序 ${L.items[0].o}～${L.items[L.items.length - 1].o}｜共 ${L.items.reduce((a, r) => a + r.E, 0)} 件` }));
    if (L.prefix) ui.prefix.textContent = L.prefix;
    if (L.existingOpen) {
      ui.table.appendChild(el('div', { style: 'color:#a00', text: '這份表有一輪還沒做完，請按「續做這一輪」。' }));
      ui.controls.append(button('續做這一輪', onResumeExisting, 'jfo-resume-existing'));
      return;
    }
    if (L.existingDone) ui.table.appendChild(el('div', { style: 'color:#a00', text: `這份表已經灌完過（${L.existingDone.createdAt}）。真的要再灌一輪（例如回放），請按「這是新的一輪」。` }));
    if (L.overlaps.length) {
      ui.table.appendChild(el('div', { style: 'color:#a00', text: `有 ${L.overlaps.length} 列和以前已確認完成的列重疊：` }));
      ui.table.appendChild(el('div', { id: 'jfo-overlaps', style: 'font-size:12px;white-space:pre-wrap', text: L.overlaps.map((x) => `第 ${x.o} 列 ${x.code} ${x.style || '（無）'}｜以前：${x.at}${x.serial ? ` 單號 ${x.serial}` : ''}`).join('\n') }));
    }
    if (!ctx.precheck || ctx.precheck.contentId !== L.contentId) {
      ui.controls.append(button('預檢', onPrecheck, 'jfo-precheck'));
      return;
    }
    const P = ctx.precheck;
    ui.table.appendChild(el('div', { id: 'jfo-precheck-result', style: 'white-space:pre-wrap;font-size:12px', text: P.lines.join('\n') }));
    if (P.hardErrors.length) {
      dockError('precheck:'+P.hardErrors.join('\n'));setWarn(`預檢有問題，整份不能開始：\n${P.hardErrors.join('\n')}`,'display');
      ui.controls.append(button('重新預檢', onPrecheck, 'jfo-precheck'));
      return;
    }
    const needAck = L.overlaps.length > 0 || !!L.existingDone;
    if (needAck && !L.ack) {
      ui.controls.append(button('這是新的一輪', () => { L.ack = { at: nowText(), overlaps: L.overlaps.length }; render(); }, 'jfo-new-round'));
      return;
    }
    ui.controls.append(button('開始', onCreateAndStart, 'jfo-start'));
  }

  // ── 選檔 ──
  async function onFileChosen() {
    if (ctx.disabledReason) return;
    setWarn('');
    ctx.loaded = null;
    ctx.precheck = null;
    const file = ui.file.files && ui.file.files[0];
    if (!file) { render(); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decoded = CORE.decodeUtf8Strict(bytes);
    if (!decoded.ok) { setWarn(decoded.error); render(); return; }
    const csv = CORE.parseCsv(decoded.text);
    if (!csv.ok) { setWarn(`讀檔失敗：${csv.error}`); render(); return; }
    const table = CORE.parseTable(csv.rows);
    if (!table.ok) { setWarn(`灌單表有問題，整份不能開始：\n${table.errors.join('\n')}`); render(); return; }
    const pf = CORE.prefixFromFileName(file.name);
    const fileHash = await sha256Hex(bytes);
    ctx.loaded = { fileName: file.name, fileHash, text: decoded.text, items: table.items, prefix: pf.ok ? pf.prefix : '', prefixSource: pf.ok ? 'file' : 'typed', overlaps: [], ack: null };
    if (!pf.ok) {
      ui.prefixInput.style.display = '';
      setWarn('檔名開頭不是日期四碼，請在下面填日期前綴（例 1016），填好按 Enter。','notice');
      render();
      return;
    }
    ui.prefixInput.style.display = 'none';
    await finishLoad();
  }
  async function onPrefixTyped() {
    if (!ctx.loaded) return;
    const value = ui.prefixInput.value.trim();
    if (!CORE.validPrefix(value)) { setWarn('日期前綴要是四碼月日，例 1016','notice'); return; }
    setWarn('');
    ctx.loaded.prefix = value;
    ctx.loaded.prefixSource = 'typed';
    await finishLoad();
  }
  async function finishLoad() {
    const L = ctx.loaded;
    L.contentId = `${L.fileHash}|${ctx.shopId}|${CORE.BEI.fromId}|${L.prefix}|${CORE.SPEC_VERSION}`;
    const state = loadState();
    const same = state.rounds.filter((r) => r.contentId === L.contentId);
    L.existingOpen = same.find((r) => r.status !== 'done' && r.status !== 'closed') || null;
    L.existingDone = same.filter((r) => r.status === 'done').pop() || null;
    const completed = [];
    for (const round of state.rounds) {
      for (const row of round.rows) {
        if ((row.state === 'completed' || row.state === 'manual_found') && round.prefix === L.prefix) completed.push({ round, row });
      }
    }
    L.overlaps = L.items.filter((item) => completed.some((c) => c.row.code === item.code && c.row.style === item.style)).map((item) => {
      const c = completed.filter((x) => x.row.code === item.code && x.row.style === item.style).pop();
      return { o: item.o, code: item.code, style: item.style, at: c.row.at, serial: c.row.orderSerial || '' };
    });
    render();
  }

  // ── 預檢 ──
  async function onPrecheck() {
    if (ctx.busy || !ctx.loaded) return;
    ctx.busy = true;dockExecution(true);
    setWarn('');
    try {
      const L = ctx.loaded;
      const problem = staticChecks();
      if (problem) throw new Error(problem);
      if (!formBlank()) throw new Error('表單不是空白的，請重新整理頁面');
      const state = loadState();
      const blockers = blockingRows(state);
      const hardErrors = [];
      if (blockers.length) hardErrors.push(`同店家＋貝貝有 ${blockers.length} 列結果不明，要先處理`);
      const lines = [];
      const mapping = {};
      const known = knownOrderIds(state);
      const orderCache = {};
      for (const item of L.items) {
        setStatus(`預檢中：第 ${item.o} 列 ${item.code} ${item.style}`);
        if (item.G === '已完成') { lines.push(`第 ${item.o} 列 ${item.code} ${item.style}：原檔標已完成，不灌`); continue; }
        const r = await readProductQuantity(L.prefix, item);
        if (!r.ok) { hardErrors.push(`第 ${item.o} 列 ${item.code} ${item.style || '（無款式）'}：${r.reason}`); continue; }
        mapping[item.o] = { commodityId: String(r.item.id), name: r.item.value };
        // 0.1.5：貝貝💕在這個商品＋款式已有不是腳本建的單 → 這列不會灌（開始後送前會再查一次）
        const cid = String(r.item.id);
        if (!orderCache[cid]) orderCache[cid] = await readOrdersRetry(cid);
        const ev = orderCache[cid];
        if (!ev.complete) { hardErrors.push(`第 ${item.o} 列 ${item.code} ${item.style || '（無款式）'}：查貝貝💕的訂單不完整（${ev.reason}）`); continue; }
        const unknown = CORE.unmanagedOrders(ev.orders, item.style, known);
        if (unknown.length) {
          lines.push(`第 ${item.o} 列 ${item.code} ${item.style || '（無）'}：現在 ${r.q}，D ${item.D}，E ${item.E} → 待人工確認・未嘗試（貝貝💕已有不是腳本建的同款單：${CORE.describeOrders(unknown)}；開始後不會灌，做完再逐列選）`);
          continue;
        }
        const cls = CORE.classifyQuantity(item, r.q);
        const label = { ok: '可灌', manual_untried: '待人工確認・未嘗試（現在量剛好等於灌完還剩，可能已經灌過）', insufficient: '不足跳過（預覽）' }[cls];
        lines.push(`第 ${item.o} 列 ${item.code} ${item.style || '（無）'}：現在 ${r.q}，D ${item.D}，E ${item.E} → ${label}`);
      }
      if (!formBlank()) {
        // 預檢只打字不選，理論上不會留東西；保險起見要求重新整理
        hardErrors.push('預檢後表單不是空白的，請重新整理後再預檢');
      }
      ctx.precheck = { contentId: L.contentId, at: nowText(), lines, hardErrors, mapping };
      log(`預檢完成：${L.items.length} 列，硬錯 ${hardErrors.length}`);
    } catch (error) {
      setWarn(`預檢停止：${error.message}`);
    } finally {
      ctx.busy = false;dockExecution(false);
      render();
    }
  }

  // ── 建立輪次並開始 ──
  async function onCreateAndStart() {
    if (ctx.busy || !ctx.loaded || !ctx.precheck || ctx.precheck.hardErrors.length) return;
    ctx.busy = true;dockExecution(true);
    try {
      const L = ctx.loaded;
      const state = loadState();
      if (blockingRows(state).length) throw new Error('有結果不明的列，先處理');
      if (state.rounds.some((r) => r.contentId === L.contentId && r.status !== 'done' && r.status !== 'closed')) throw new Error('這份表有一輪還沒做完');
      const round = {
        roundId: randomId(), contentId: L.contentId, fileName: L.fileName, fileHash: L.fileHash, prefix: L.prefix, prefixSource: L.prefixSource,
        specVersion: CORE.SPEC_VERSION, createdAt: nowText(), status: 'running', pauseRequested: false, ack: L.ack, csvText: L.text,
        rows: L.items.map((item) => ({
          ...item,
          state: item.G === '已完成' ? 'original_done' : 'pending',
          commodityId: ctx.precheck.mapping[item.o] ? ctx.precheck.mapping[item.o].commodityId : null,
          qpre: null, t: null, qpost: null, orderId: null, orderSerial: '', newIds: [], baseline: null, at: '', reason: '', manual: null,
        })),
      };
      state.rounds.push(round);
      state.activeRoundId = round.roundId;
      state.owner = { tabId: ctx.tabId, gen: ctx.gen, at: nowText() };
      state.expect = null;
      saveState(state);
      ctx.loaded = null;
      ctx.precheck = null;
      log('開始灌單');
    } catch (error) {
      setWarn(`不能開始：${error.message}`);
      ctx.busy = false;dockExecution(false);
      render();
      return;
    }
    ctx.busy = false;dockExecution(false);
    ctx.autoResumed = false; // 人按的
    runLoop();
  }

  async function onResumeExisting() {
    if (!ctx.loaded || !ctx.loaded.existingOpen) return;
    const state = loadState();
    state.activeRoundId = ctx.loaded.existingOpen.roundId;
    saveState(state);
    ctx.loaded = null;
    render();
  }

  async function onStart() {
    if (ctx.busy) return;
    try {
      const state = loadState();
      const round = activeRound(state);
      if (!round) return;
      if (blockingRows(state).length) throw new Error('有結果不明的列，先處理');
      round.status = 'running';
      round.pauseRequested = false;
      round.pauseReason = '';
      state.owner = { tabId: ctx.tabId, gen: ctx.gen, at: nowText() };
      state.expect = null;
      saveState(state);
    } catch (error) { setWarn(error.message); return; }
    ctx.autoResumed = false; // 人按的
    runLoop();
  }
  const onTakeover = onStart;

  function onPause() {
    try {
      const state = loadState();
      const round = activeRound(state);
      if (!round) return;
      round.pauseRequested = true;
      saveState(state);
      log('收到暫停，做完這一列就停');
    } catch (error) { setWarn(error.message); }
  }

  function onCloseRound() {
    try {
      const state = loadState();
      const round = activeRound(state);
      if (!round) return;
      if (round.rows.some((r) => r.state === 'submitted' || r.state === 'unresolved')) throw new Error('這一輪還有結果不明的列，不能結束');
      round.status = 'closed';
      state.activeRoundId = null;
      saveState(state);
      render();
    } catch (error) { setWarn(error.message); }
  }

  function onDownload() {
    const state = loadState();
    const round = activeRound(state);
    if (!round) return;
    const blob = new W.Blob([CORE.resultCsv(round.rows)], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: W.URL.createObjectURL(blob), download: `${round.fileName.replace(/\.csv$/iu, '')}-灌單結果.csv` });
    doc.body.appendChild(a);
    a.click();
    a.remove();
  }

  function onResolve(roundId, index, kind, orderId, note) {
    try {
      const state = loadState();
      const round = state.rounds.find((r) => r.roundId === roundId);
      const row = round && round.rows[index];
      if (!row || row.state !== 'unresolved') return;
      if (kind === 'found' && !/^[A-Z0-9-]+$/iu.test(orderId.trim())) throw new Error('請填找到的單號');
      if (kind === 'other' && !note.trim()) throw new Error('請寫說明');
      const conclusion = { found: '已在 JAMBO 找到這張單', not_created: '確定沒有建立', other: '其他' }[kind];
      row.manual = { conclusion, orderId: kind === 'found' ? orderId.trim() : '', note: note.trim(), at: nowText(), previousReason: row.reason, previousState: row.state };
      row.state = kind === 'found' ? 'manual_found' : kind === 'not_created' ? 'pending' : 'manual_other';
      saveState(state);
      log(`第 ${row.o} 列人工結論：${conclusion}`);
      render();
    } catch (error) { setWarn(error.message); }
  }

  async function onVerifyBlocker(roundId, index) {
    if (ctx.busy) return;
    ctx.busy = true;dockExecution(true);
    try { await verifySubmitted(roundId, index); } finally { ctx.busy = false;dockExecution(false); render(); }
  }

  // ── 送出後核對（重載後或手動）──
  async function verifySubmitted(roundId, index) {
    let state = loadState();
    const round = state.rounds.find((r) => r.roundId === roundId);
    const row = round && round.rows[index];
    if (!row || row.state !== 'submitted') return;
    setStatus(`核對第 ${row.o} 列 ${row.code} ${row.style}…`);
    const evidence = await readOrdersWithRecheck(row);
    const input = { complete: evidence.complete, incompleteReason: evidence.reason, qpre: row.qpre, e: row.E, newOrders: [], baselineChanged: false, changed: [] };
    if (evidence.complete) {
      const diff = CORE.diffOrders(row.baseline, evidence.orders);
      input.baselineChanged = diff.baselineChanged;
      input.changed = diff.changed;
      input.newOrders = diff.newIds.map((id) => ({ id, order: evidence.orders[id], reasons: CORE.orderMatches(evidence.orders[id], { fromId: CORE.BEI.fromId, shopId: ctx.shopId, commodityId: row.commodityId, style: row.style, E: row.E, prefix: round.prefix, code: row.code }) }));
      if (!input.baselineChanged && input.newOrders.length === 1 && !input.newOrders[0].reasons.length) {
        try {
          const r = await readProductQuantity(round.prefix, row);
          if (r.ok && String(r.item.id) === String(row.commodityId)) input.qpost = r.q;
        } catch (_e) { /* 讀不到就留空 */ }
      }
    }
    const verdict = CORE.judgeAfterSubmit(input);
    state = loadState();
    const fresh = state.rounds.find((r) => r.roundId === roundId).rows[index];
    fresh.state = verdict.state;
    fresh.reason = verdict.reason;
    fresh.qpost = Number.isSafeInteger(input.qpost) ? input.qpost : null;
    fresh.newIds = input.newOrders.map((x) => String(x.id));
    if (verdict.state === 'completed') {
      fresh.orderId = String(input.newOrders[0].id);
      fresh.orderSerial = input.newOrders[0].order.serial || '';
    }
    fresh.verifiedAt = nowText();
    if (verdict.state === 'unresolved') state.rounds.find((r) => r.roundId === roundId).status = 'stopped';
    saveState(state);
    log(`第 ${fresh.o} 列：${CORE.STATE_LABEL[fresh.state]}${fresh.reason ? `（${fresh.reason}）` : ''}`);
    return verdict;
  }

  // 0.1.8（Ethan 10-24 真頁面：H56、H74 送出後查到「總數 1、清單 0 張」，過一下再查就正常）：
  // 訂單證據不完整時先等 2 秒重查，最多 INCOMPLETE_RETRIES 次；還是不完整才當不完整（只讀，不會多送）
  const INCOMPLETE_RETRIES = 5;
  async function readOrdersRetry(commodityId) {
    let evidence = await readOrders(commodityId);
    for (let i = 0; i < INCOMPLETE_RETRIES && !evidence.complete; i += 1) {
      await sleep(RECHECK_DELAY);
      evidence = await readOrders(commodityId);
    }
    if (!evidence.complete) evidence = { ...evidence, reason: `${evidence.reason || ''}（重查 ${INCOMPLETE_RETRIES} 次仍是這樣）` };
    return evidence;
  }

  async function readOrdersWithRecheck(row) {
    let evidence = await readOrdersRetry(row.commodityId);
    for (let i = 0; i < RECHECK_TIMES; i += 1) {
      if (!evidence.complete) return evidence;
      const diff = CORE.diffOrders(row.baseline, evidence.orders);
      if (diff.newIds.length || diff.baselineChanged) return evidence;
      await sleep(RECHECK_DELAY);
      evidence = await readOrdersRetry(row.commodityId);
    }
    return evidence;
  }

  // ── 主迴圈（只在持有鎖、是擁有者時跑）──
  async function runLoop() {
    if (ctx.busy) return;
    ctx.busy = true;dockExecution(true);
    try {
      for (;;) {
        let state = loadState();
        const round = activeRound(state);
        if (!round || round.status !== 'running') break;
        if (!isOwner(state)) { setWarn('擁有者不是這個分頁，停止'); break; }
        render();
        const submittedIndex = round.rows.findIndex((r) => r.state === 'submitted');
        if (submittedIndex >= 0) {
          const verdict = await verifySubmitted(round.roundId, submittedIndex);
          if (!verdict || verdict.state === 'unresolved') break;
          continue;
        }
        if (blockingRows(state).length) { stopRound('有結果不明的列'); break; }
        if (round.pauseRequested) {
          round.status = 'paused';
          round.pauseRequested = false;
          saveState(state);
          log('已暫停');
          break;
        }
        const index = round.rows.findIndex((r) => r.state === 'pending');
        if (index < 0) { await finishRound(round.roundId); break; }
        const outcome = await processRow(round.roundId, index);
        if (outcome === 'navigating') return; // 頁面要換了，不解除 busy
        if (outcome === 'stop') break;
      }
    } catch (error) {
      stopRound(`程式錯誤：${error.message}`);
    }
    ctx.busy = false;dockExecution(false);
    render();
  }

  function stopRound(reason) {
    try {
      const state = loadState();
      const round = activeRound(state);
      if (round && round.status === 'running') {
        round.status = 'stopped';
        round.stopReason = reason;
        saveState(state);
      }
    } catch (_e) { /* 讀寫都壞了就只能顯示 */ }
    setWarn(`已停止：${reason}`);
    log(`停止：${reason}`);
  }

  function updateRow(roundId, index, patch) {
    const state = loadState();
    const row = state.rounds.find((r) => r.roundId === roundId).rows[index];
    Object.assign(row, patch);
    saveState(state);
    return state;
  }

  async function processRow(roundId, index) {
    let state = loadState();
    let round = state.rounds.find((r) => r.roundId === roundId);
    const row = round.rows[index];
    setStatus(`第 ${row.o} 列 ${row.code} ${row.style || '（無款式）'} ×${row.E}`);
    // S1
    const problem = staticChecks();
    if (problem) { stopRound(problem); return 'stop'; }
    if (!formBlank()) { stopRound('表單不是空白的'); return 'stop'; }
    if (openDialog()) { stopRound('頁面有開著的視窗'); return 'stop'; }
    if (!row.commodityId) { stopRound(`第 ${row.o} 列沒有預檢的商品序號`); return 'stop'; }
    // S5：送前集合 B
    const before = await readOrdersRetry(row.commodityId);
    if (!before.complete) {
      updateRow(roundId, index, { reason: `送前訂單證據不完整：${before.reason}` });
      stopRound(`第 ${row.o} 列送前訂單證據不完整：${before.reason}`);
      return 'stop';
    }
    // 0.1.5：貝貝💕在這個商品＋款式已有「不是腳本建的單」→ 不灌、待人工確認・未嘗試（Ethan 10-23 選甲；GPT 複驗 0.1.4 問題二）
    const unknown = CORE.unmanagedOrders(before.orders, row.style, knownOrderIds(state, roundId, index));
    if (unknown.length) {
      updateRow(roundId, index, {
        state: 'manual_untried', priorUnknown: unknown, at: nowText(),
        reason: `貝貝💕在這個商品＋款式已經有不是腳本建的單：${CORE.describeOrders(unknown)}，沒有灌。請在面板選結論`,
      });
      log(`第 ${row.o} 列：已有不是腳本建的同款單，沒有灌`);
      return 'next';
    }
    // S2～S4：搜商品、讀 Qpre
    const $name = $q('#order-name');
    const content = await acSearch($name, `${round.prefix}-${row.code}`);
    const product = CORE.resolveProduct(content, round.prefix, row.code);
    if (!product.ok) { acClear($name); stopRound(`第 ${row.o} 列：${product.reason}`); return 'stop'; }
    if (String(product.item.id) !== String(row.commodityId)) { acClear($name); stopRound(`第 ${row.o} 列：商品序號和預檢不同`); return 'stop'; }
    const sq = CORE.styleQuantity(product.item, row.style);
    if (!sq.ok) { acClear($name); stopRound(`第 ${row.o} 列：${sq.reason}`); return 'stop'; }
    const qpre = sq.q;
    const cls = CORE.classifyQuantity(row, qpre);
    if (cls !== 'ok') {
      acClear($name);
      const reason = cls === 'manual_untried' ? '現在量剛好等於灌完還剩，可能已經灌過，沒有灌' : `現在 ${qpre} 件，不夠 ${row.E} 件，沒有灌`;
      updateRow(roundId, index, { state: cls, qpre, reason, at: nowText() });
      log(`第 ${row.o} 列：${CORE.STATE_LABEL[cls]}`);
      await waitFor(() => formBlank(), 3000, '表單清空');
      return 'next';
    }
    await acPick($name, product.item);
    await waitFor(() => field('commodity_id').val() === String(product.item.id), 5000, '商品選好');
    await sleep(300);
    // S3：款式
    if (row.style) {
      const $style = $q("input[name='style_search']");
      const styleContent = await acSearch($style, row.style);
      const want = styleContent.filter((it) => it && it.value === `${row.style} `);
      if (want.length !== 1) { stopRound(`第 ${row.o} 列：款式選單裡「${row.style}」有 ${want.length} 個`); return 'stop'; }
      await acPick($style, want[0]);
      await waitFor(() => field('style').val() === row.style && field('sub_style').val() === '', 5000, '款式選好');
      await sleep(200);
    }
    // S7：件數
    const $qty = field('quantity');
    $qty.trigger('focus').val(String(row.E)).trigger('input').trigger('change').trigger('blur');
    await sleep(300);
    // S8：送前核對
    const item = product.item;
    const checks = preSubmitProblems(row, item, qpre);
    if (checks.length) { stopRound(`第 ${row.o} 列送前核對不過：${checks.join('、')}（沒有送出）`); return 'stop'; }
    // S9：寫入「可能已提交」並讀回
    const nonce = randomId();
    try {
      state = loadState();
      round = state.rounds.find((r) => r.roundId === roundId);
      if (!isOwner(state)) { stopRound('擁有者不是這個分頁（沒有送出）'); return 'stop'; }
      Object.assign(round.rows[index], {
        state: 'submitted', qpre, t: qpre - row.E, baseline: before.orders, at: nowText(), reason: '',
        query: { commodityId: row.commodityId, kind: 'all', byFromId: true }, submitNonce: nonce,
      });
      state.expect = { nonce, tabId: ctx.tabId, kind: 'submit', at: nowText(), atMs: Date.now() };
      saveState(state);
      const tab = await gmGetTab();
      await gmSaveTab({ ...tab, jfoTabId: ctx.tabId, expectNonce: nonce });
    } catch (error) {
      // 沒寫成功就不點；把剛才可能寫一半的狀態退回待處理
      try {
        const s = loadState();
        const r = s.rounds.find((x) => x.roundId === roundId).rows[index];
        if (r.state === 'submitted' && r.submitNonce === nonce) { r.state = 'pending'; r.reason = `送前紀錄寫入失敗：${error.message}`; s.expect = null; saveState(s); }
      } catch (_e) { /* 讀寫都壞了：下面停下，紀錄若停在可能已提交，下次會核對 */ }
      stopRound(`送前紀錄寫入失敗，沒有送出：${error.message}`);
      return 'stop';
    }
    // S10：最後一次 await 已經結束。從這裡到 click 之間全部同步，不再等任何東西（GPT 複審 F1）
    state = loadState();
    const check = state.rounds.find((r) => r.roundId === roundId).rows[index];
    const late = preSubmitProblems(row, item, qpre);
    if (!isOwner(state)) late.push('擁有者不是這個分頁');
    if (check.state !== 'submitted' || check.submitNonce !== nonce) late.push('紀錄變了');
    if (!ctx.lockHeld) late.push('沒有拿著分頁鎖');
    if (!hasNavigationApi()) late.push('瀏覽器沒有 Navigation API（請更新 Chrome）');
    if (navLog.seq !== 0) late.push(`這一頁載入後已經有別的換頁（${navLog.last}）`);
    if (!late.length) {
      // 記下按下的時間（同步寫）：新頁面用它核對「這次換頁是不是剛剛按下造成的」
      try {
        state.expect = { ...(state.expect || {}), nonce, tabId: ctx.tabId, kind: 'submit', goAtMs: Date.now() };
        saveState(state);
      } catch (error) { late.push(`記錄按下時間失敗：${error.message}`); }
    }
    if (late.length) {
      // 還沒按：把「可能已提交」退回待處理（同步寫）；退不回去就留著，下次會核對（查不到新單→待人工確認）
      try {
        const s = loadState();
        const r = s.rounds.find((x) => x.roundId === roundId).rows[index];
        if (r.state === 'submitted' && r.submitNonce === nonce) {
          r.state = 'pending';
          r.reason = `按下前最後核對不過：${late.join('、')}（沒有送出）`;
          r.submitNonce = null;
          if (s.expect && s.expect.nonce === nonce) s.expect = null;
          saveState(s);
        }
      } catch (_e) { /* 見上 */ }
      stopRound(`第 ${row.o} 列按下前最後核對不過：${late.join('、')}（沒有送出）`);
      return 'stop';
    }
    ctx.navigating = false;
    const onLeave = () => { ctx.navigating = true; };
    W.addEventListener('beforeunload', onLeave);
    W.addEventListener('pagehide', onLeave);
    armNavigationWatch(nonce, 'submit');
    W.name = `jfo:${nonce}`;
    doc.getElementById('create_another').click();
    log(`第 ${row.o} 列送出 ${row.code} ${row.style || ''} ×${row.E}`);
    // S11：等換頁或視窗
    const t0 = Date.now();
    for (;;) {
      if (ctx.navigating) return 'navigating';
      const dialog = openDialog();
      if (dialog) return await handleDialog(roundId, index, dialog);
      if (Date.now() - t0 > SUBMIT_WATCH_MS) {
        if (ctx.navigating) return 'navigating';
        await markUnresolvedInPage(roundId, index, '按了儲存之後頁面沒有反應');
        return 'stop';
      }
      await sleep(100);
    }
  }

  // 真頁面 jbConfirm 的結構（10-18 讀）：dialog.jb-modal > .jb-modal__content > [.jb-modal__header（有標題才有）]
  // ＋ .jb-modal__body > p（訊息）＋ .jb-modal__footer > 取消 [data-jb-confirm="0"]、確定 [data-jb-confirm="1"]
  function dialogText(dialog) {
    const clone = dialog.cloneNode(true);
    clone.querySelectorAll('button').forEach((b) => b.remove());
    return clone.textContent.replace(/\s+/gu, ' ').trim();
  }
  function isInsufficientDialog(dialog) {
    if (!dialog.matches('dialog.jb-modal')) return false;
    if (dialog.querySelector('.jb-modal__title, .jb-modal__header')) return false;
    const paragraphs = dialog.querySelectorAll('.jb-modal__body p');
    if (paragraphs.length !== 1) return false;
    if (paragraphs[0].textContent !== CORE.INSUFFICIENT_MESSAGE) return false;
    if (dialogText(dialog) !== CORE.INSUFFICIENT_MESSAGE) return false;
    const buttons = dialog.querySelectorAll('[data-jb-confirm]');
    return buttons.length === 2 && !!dialog.querySelector('[data-jb-confirm="0"]') && !!dialog.querySelector('[data-jb-confirm="1"]');
  }

  async function handleDialog(roundId, index, dialog) {
    if (!isInsufficientDialog(dialog)) {
      await markUnresolvedInPage(roundId, index, `按儲存後跳出視窗：${dialogText(dialog).slice(0, 60)}（沒有按任何鈕）`);
      return 'stop';
    }
    const cancel = dialog.querySelector('[data-jb-confirm="0"]');
    if (!cancel) { await markUnresolvedInPage(roundId, index, '數量不足視窗找不到取消鈕'); return 'stop'; }
    cancel.click();
    try { await waitFor(() => !doc.contains(dialog) || !dialog.open, 5000, '視窗關閉'); } catch (_e) { await markUnresolvedInPage(roundId, index, '數量不足視窗關不掉'); return 'stop'; }
    await sleep(800);
    const state = loadState();
    const round = state.rounds.find((r) => r.roundId === roundId);
    const row = round.rows[index];
    const stillHere = !ctx.navigating && W.document.documentElement.dataset.jfoInit === '1';
    const formKept = field('commodity_id').val() === String(row.commodityId) && field('quantity').val() === String(row.E) && field('style').val() === (row.style || '');
    if (!stillHere || !formKept) { await markUnresolvedInPage(roundId, index, '按了取消，但無法確認頁面沒有送出'); return 'stop'; }
    const evidence = await readOrdersWithRecheck(row);
    const input = { complete: evidence.complete, incompleteReason: evidence.reason, qpre: row.qpre, e: row.E, rejectedBeforeSubmit: true, shortage: true, newOrders: [], baselineChanged: false };
    if (evidence.complete) {
      const diff = CORE.diffOrders(row.baseline, evidence.orders);
      input.baselineChanged = diff.baselineChanged;
      input.changed = diff.changed;
      input.newOrders = diff.newIds.map((id) => ({ id, order: evidence.orders[id], reasons: [] }));
    }
    const verdict = CORE.judgeAfterSubmit(input);
    const s2 = loadState();
    const r2 = s2.rounds.find((r) => r.roundId === roundId);
    Object.assign(r2.rows[index], { state: verdict.state, reason: verdict.reason || `頁面視窗：${CORE.INSUFFICIENT_MESSAGE}`, newIds: input.newOrders.map((x) => String(x.id)) });
    if (verdict.state === 'unresolved') r2.status = 'stopped';
    s2.expect = null;
    saveState(s2);
    if (verdict.state !== 'insufficient') { setWarn(`已停止：${verdict.reason}`); return 'stop'; }
    log(`第 ${row.o} 列：不足跳過（頁面擋下、已確認沒有送出）`);
    // 表單已填，換頁回到空白表單再繼續
    return navigateClean();
  }

  async function markUnresolvedInPage(roundId, index, reason) {
    try {
      const state = loadState();
      const round = state.rounds.find((r) => r.roundId === roundId);
      Object.assign(round.rows[index], { state: 'unresolved', reason });
      round.status = 'stopped';
      state.expect = null;
      saveState(state);
    } catch (_e) { /* 紀錄留在可能已提交，下次會核對 */ }
    setWarn(`已停止：${reason}`);
    log(`停止：${reason}`);
  }

  async function navigateClean() {
    const nonce = randomId();
    const state = loadState();
    state.expect = { nonce, tabId: ctx.tabId, kind: 'reload', at: nowText(), atMs: Date.now() };
    saveState(state);
    const tab = await gmGetTab();
    await gmSaveTab({ ...tab, jfoTabId: ctx.tabId, expectNonce: nonce });
    // 從這裡到換頁全部同步：記時間、開始監看、換頁
    if (!hasNavigationApi()) { stopRound('瀏覽器沒有 Navigation API，不換頁（請更新 Chrome）'); return 'stop'; }
    if (navLog.seq !== 0) { stopRound(`這一頁載入後已經有別的換頁（${navLog.last || '不明'}），不換頁`); return 'stop'; }
    const s2 = loadState();
    s2.expect = { ...(s2.expect || {}), goAtMs: Date.now() };
    saveState(s2);
    armNavigationWatch(nonce, 'reload');
    W.name = `jfo:${nonce}`;
    W.location.assign(cleanUrl());
    return 'navigating';
  }

  // 0.1.3 起沒有 Navigation API 就整個停用（GPT 複驗 0.1.2 的 N1；Ethan 10-18 選「沒 API 就停用」）
  function hasNavigationApi() {
    return !!(W.navigation && typeof W.navigation.addEventListener === 'function');
  }

  // GPT 複驗 X5-R1：按下（或換頁）之後，舊頁面在消失前看到的每一次換頁都要記下來。
  // 第一次、而且長得像「這一次預期的換頁」的那一個放過（送出＝帶表單資料回到新增訂單頁；換頁＝沒有表單資料、目的地剛好是乾淨網址），
  // 其他任何換頁（點連結、重新整理、別的程式換網址、別的表單送出）都在紀錄上標「被打斷」，新頁面看到就不自動接續。
  // 換頁計數器的監聽（navLog 與呼叫點在瀏覽器端最前面，見那裡的說明）
  function installNavSentinel() {
    W.navigation.addEventListener('navigate', (event) => {
      if (event.downloadRequest !== null && event.downloadRequest !== undefined) return;
      navLog.seq += 1;
      const dest = event.destination && event.destination.url ? String(event.destination.url).replace(W.location.origin, '') : '不明';
      navLog.last = `${event.navigationType || '不明'}${event.formData ? '（表單）' : ''}：${dest}`;
    });
    navLog.installed = true;
  }

  let currentWatch = null;
  function armNavigationWatch(nonce, kind) {
    let ownSeen = false;
    currentWatch = nonce; // 新的監看一開始，舊的就作廢（例如「數量不足」取消後換頁回空白表單）
    const taint = (why) => {
      if (currentWatch !== nonce) return;
      let ok = false;
      try {
        const s = loadState();
        if (!s.expect || s.expect.nonce !== nonce) return; // 記號已經撤回或用掉：沒有東西要標
        if (!s.expect.tainted) { s.expect.tainted = why; saveState(s); }
        ok = true;
      } catch (_e) { ok = false; }
      // GPT 複驗 0.1.2 的 N2：記號寫不進去，就不能當成「沒被打斷」。
      // 同步清掉 window.name 的換頁記號，新頁面就認不出是同一個分頁 → 放掉鎖、只能看、要人按「接手」
      if (!ok) W.name = '';
    };
    const expectedUrl = cleanUrl();
    const nav = W.navigation;
    if (!hasNavigationApi()) return false;
    {
      nav.addEventListener('navigate', (event) => {
        const dest = event.destination && event.destination.url ? String(event.destination.url) : '';
        let destPath = '';
        try { destPath = new URL(dest, W.location.href).pathname; } catch (_e) { destPath = ''; }
        const own = !ownSeen && (kind === 'submit'
          ? !!event.formData && /^\/console\/order\/new\/?$/u.test(destPath)
          : !event.formData && dest === expectedUrl && (event.navigationType === 'push' || event.navigationType === 'replace'));
        // 換到和目前一樣的網址時，瀏覽器會把 push 當成 replace，兩種都算
        if (own) { ownSeen = true; return; }
        taint(`送出或換頁途中又有別的換頁（${event.navigationType || '不明'}：${dest.replace(W.location.origin, '') || '不明'}）`);
      });
    }
    return true;
  }

  async function finishRound(roundId) {
    const state = loadState();
    const round = state.rounds.find((r) => r.roundId === roundId);
    setStatus('全部做完，最後再讀一次全表數量…');
    const notes = [];
    for (let i = 0; i < round.rows.length; i += 1) {
      const row = round.rows[i];
      if (row.state !== 'completed') continue;
      let r = null;
      try { r = await readProductQuantity(round.prefix, row); } catch (_e) { r = null; }
      if (r && r.ok) {
        row.qfinal = r.q;
        row.finalUnreadable = false;
        if (r.q !== row.t) notes.push(`第 ${row.o} 列 ${row.code} ${row.style}：現在 ${r.q}，灌完應是 ${row.t}（來源未確認）`);
      } else {
        row.qfinal = null;
        row.finalUnreadable = true;
        notes.push(`第 ${row.o} 列 ${row.code} ${row.style}：最後核對讀不到數量${r && r.reason ? `（${r.reason}）` : ''}`);
      }
    }
    round.finalNotes = notes;
    round.status = 'done';
    round.doneAt = nowText();
    saveState(state);
    const counts = CORE.summarize(round.rows);
    const allDone = !round.rows.some((r) => r.state === 'unresolved' || r.state === 'submitted');
    const priorRows = round.rows.filter((r) => r.state === 'manual_untried' && Array.isArray(r.priorUnknown) && r.priorUnknown.length).length;
    log(`本輪結束：${Object.entries(counts).map(([k, v]) => `${CORE.STATE_LABEL[k]} ${v}`).join('、')}`);
    setWarn(`${allDone ? '本輪已做完。' : '本輪結束，但有待人工確認的列。'}${priorRows ? `\n有 ${priorRows} 列貝貝💕已有不是腳本建的同款單，腳本沒有灌，請在上面逐列選。` : ''}${notes.length ? `\n最後核對要留意的：\n${notes.join('\n')}` : ''}`,'notice');
  }

  // ── 啟動 ──
  async function boot() {
    try {
      await waitFor(() => W.jQuery && W.jQuery.ui && W.jQuery('#order-name').length && W.jQuery('#order-name').autocomplete('instance'), 20000, '頁面載入');
    } catch (_e) {
      return; // 不是正常的新增訂單頁就不出現
    }
    ctx.$ = W.jQuery;
    if (doc.documentElement && !doc.documentElement.dataset.jfoInit) doc.documentElement.dataset.jfoInit = '1';
    buildPanel();
    const missing = [];
    if (typeof GM_getValue !== 'function') missing.push('GM_getValue');
    if (typeof GM_setValue !== 'function') missing.push('GM_setValue');
    if (typeof GM_getTab !== 'function') missing.push('GM_getTab');
    if (typeof GM_saveTab !== 'function') missing.push('GM_saveTab');
    if (missing.length) { ctx.dockDisabledKind = 'environment'; ctx.disabledReason = `篡改猴缺少 ${missing.join('、')}`; render(); return; }
    if (!W.navigator.locks || typeof W.navigator.locks.request !== 'function') { ctx.dockDisabledKind = 'environment'; ctx.disabledReason = '瀏覽器不支援分頁鎖（Web Locks）'; render(); return; }
    if (!hasNavigationApi()) { ctx.dockDisabledKind = 'environment'; ctx.disabledReason = '這個 Chrome 太舊，沒有 Navigation API（Chrome 102 以後才有），灌單停用。請更新 Chrome 後再用'; render(); return; }
    // 換頁監看已經在開頁第一刻裝好（見瀏覽器端最前面）；沒裝上就不灌
    if (!navLog.installed) { ctx.dockDisabledKind = 'environment'; ctx.disabledReason = '換頁監看沒有在開頁第一刻裝上，灌單停用。請重新整理頁面'; render(); return; }
    const shop = readShopId();
    if (!shop.ok) { ctx.dockDisabledKind = 'environment'; ctx.disabledReason = shop.reason; render(); return; }
    ctx.shopId = shop.shopId;
    if (!accountOk()) {
      ctx.dockDisabledKind = 'irrelevant'; ctx.disabledReason = '這一頁的帳號不是貝貝💕';
      render();
      ui.controls.appendChild(el('a', { href: cleanUrl(), text: '打開貝貝💕的新增訂單頁' }));
      return;
    }
    if (!formBlank()) { ctx.dockDisabledKind = 'irrelevant'; ctx.disabledReason = '開頁時表單不是空白的（例如複製訂單），這一頁不灌單'; render(); return; }
    try {
      const tab = await gmGetTab();
      if (tab.jfoTabId) ctx.tabId = tab.jfoTabId;
      else { ctx.tabId = randomId(); await gmSaveTab({ ...tab, jfoTabId: ctx.tabId }); }
    } catch (error) { ctx.dockDisabledKind = 'environment'; ctx.disabledReason = `分頁身分讀寫失敗：${error.message}`; render(); return; }
    await tryLockLoop();
  }

  // 整頁只持有一次鎖；拿到後判斷要不要留著
  let releaseLock = null;
  function acquireLock() {
    return new Promise((resolve) => {
      W.navigator.locks.request(`${LOCK_PREFIX}:${ctx.shopId}:${CORE.BEI.fromId}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        ctx.lockHeld = true;
        resolve(true);
        return new Promise((release) => { releaseLock = () => { ctx.lockHeld = false; releaseLock = null; release(); }; });
      });
    });
  }

  let lockTimer = null;
  async function tryLockLoop() {
    for (let i = 0; i < 4 && !ctx.lockHeld; i += 1) {
      if (await acquireLock()) break;
      await sleep(300);
    }
    if (ctx.lockHeld && await afterLock()) return;
    render();
    if (!lockTimer) {
      lockTimer = setInterval(async () => {
        if (ctx.lockHeld || ctx.busy) return;
        if (await acquireLock()) {
          if (await afterLock()) { clearInterval(lockTimer); lockTimer = null; }
        }
        render();
      }, 3000);
    }
  }

  // 這一頁是不是腳本自己造成的換頁（GPT 複審 X5、複驗 X5-R1）。全部要成立才自動接續：
  // 1. 換頁記號在 GM、分頁儲存、window.name 三處都相同（window.name 只跟著同一個分頁走，window.open 開的新分頁沒有）
  // 2. 舊頁面在消失前沒有看到別的換頁（armNavigationWatch 沒有標「被打斷」）
  // 3. 導覽類型是 navigate（手動重新整理是 reload、上一頁是 back_forward）、來源頁是新增訂單頁
  // 4. 這一頁開始載入的時間（performance.timeOrigin）在按下（或換頁）後 1 秒內
  //    （10-18 模擬實測：表單送出轉址回來的頁面，timeOrigin 是「按下送出」那一刻，伺服器延遲 0 或 4 秒都只差 4 毫秒）
  // 5. 送出的那一種：要是轉址回來的（redirectCount≥1，表單送出後 302 回新增訂單頁）
  // 6. 記號 2 分鐘內
  // 任何一條不成立，只要確定是同一個分頁，就核對可能已提交的列、暫停、要按「繼續」
  const EXPECT_TTL_MS = 120000;
  const GO_WINDOW_MS = 1000;
  function navigationFacts(state, tab) {
    const e = state.expect;
    const entry = W.performance && W.performance.getEntriesByType ? W.performance.getEntriesByType('navigation')[0] : null;
    const navType = entry ? entry.type : '';
    const redirects = entry && Number.isFinite(entry.redirectCount) ? entry.redirectCount : 0;
    let refOk = false;
    try {
      const ref = new URL(doc.referrer);
      refOk = ref.origin === W.location.origin && /^\/console\/order\/new\/?$/u.test(ref.pathname);
    } catch (_e) { refOk = false; }
    const sameTab = !!e && e.tabId === ctx.tabId && tab.expectNonce === e.nonce && W.name === `jfo:${e.nonce}`;
    const fresh = !!e && Number.isFinite(e.atMs) && Date.now() - e.atMs < EXPECT_TTL_MS;
    const tainted = !!e && !!e.tainted;
    const startGap = e && Number.isFinite(e.goAtMs) && W.performance ? Math.round(W.performance.timeOrigin - e.goAtMs) : null;
    const timeOk = startGap !== null && startGap > -500 && startGap < GO_WINDOW_MS;
    const redirectOk = !!e && (e.kind !== 'submit' || redirects >= 1);
    const ours = sameTab && !tainted && navType === 'navigate' && refOk && timeOk && redirectOk && fresh;
    const why = [];
    if (tainted) why.push(e.tainted);
    if (navType !== 'navigate') why.push(`導覽類型 ${navType || '不明'}`);
    if (!refOk) why.push('來源頁不是新增訂單頁');
    if (!timeOk) why.push(`開始載入的時間和按下差 ${startGap === null ? '不明' : `${startGap} 毫秒`}`);
    if (!redirectOk) why.push('不是送出後轉址回來的');
    if (!fresh) why.push('記號過期');
    return { sameTab, ours, navType, refOk, fresh, tainted, startGap, redirects, why };
  }

  // 回傳 true＝這頁留著鎖；false＝別的分頁正在灌，放掉鎖只能看
  async function afterLock() {
    let autoResume = false;
    try {
      const state = loadState();
      const tab = await gmGetTab();
      const round = activeRound(state);
      const facts = navigationFacts(state, tab);
      if (state.expect && facts.sameTab) {
        // 同一個分頁：記號用掉。只有確定是自己造成的換頁才自動接續；手動重新整理、上一頁、逾時都要按「繼續」
        // 0.1.5：還要這一頁到現在沒有任何換頁（navLog.seq＝0）。
        // 0.1.8（Ethan 10-24 選擇）：真篡改猴在 JAMBO 注入得比頁面晚，entryFacts.early 每頁都是假，每列都要按繼續；
        // Ethan 決定拿掉「要證明比頁面早」這個條件（腳本啟動前那一小段的換頁看不到，接受這個殘留）。early 照樣記在 lastNavFacts。
        const pageWhy = [];
        if (navLog.seq !== 0) pageWhy.push(`這一頁載入後已經有別的換頁（${navLog.last || '不明'}）`);
        if (round) {
          round.lastNavFacts = {
            at: nowText(), kind: state.expect.kind, navType: facts.navType, startGap: facts.startGap, redirects: facts.redirects,
            interrupted: state.expect.tainted || '', ours: facts.ours,
            early: entryFacts.early, entry: { readyState: entryFacts.readyState, hasBody: entryFacts.hasBody, otherScripts: entryFacts.otherScripts },
            seqAtDecision: navLog.seq, lastNav: navLog.last,
          };
        }
        state.expect = null;
        if (facts.ours && state.owner && state.owner.tabId === ctx.tabId && !pageWhy.length) {
          state.owner = { tabId: ctx.tabId, gen: ctx.gen, at: nowText() };
          autoResume = true;
        } else if (round && round.status === 'running') {
          round.status = 'paused';
          round.pauseReason = facts.ours && state.owner && state.owner.tabId === ctx.tabId
            ? `${pageWhy.join('；')}，請確認後按「繼續」`
            : `頁面不是腳本自己換的（${facts.why.join('；') || '擁有者不同'}），請確認後按「繼續」`;
        }
        saveState(state);
        await gmSaveTab({ ...tab, expectNonce: null });
        W.name = '';
      } else {
        // 別的分頁正在換頁（記號不是這頁的），或別的分頁是擁有者且正在灌 → 放掉鎖，只能看
        const othersReload = !!state.expect;
        const othersRunning = round && round.status === 'running' && state.owner && state.owner.tabId !== ctx.tabId;
        if (othersReload || othersRunning) {
          if (releaseLock) releaseLock();
          return false;
        }
        // 自己這個分頁、沒有換頁記號卻停在「灌單中」：是手動重新整理或當掉後重開，改成暫停
        if (round && round.status === 'running' && !isOwner(state)) {
          round.status = 'paused';
          round.pauseReason = '頁面重新整理過，請確認後按「繼續」';
          saveState(state);
        }
      }
      // 結果不明的「可能已提交」先核對（只讀）
      const st2 = loadState();
      for (const { round: r, index, row } of blockingRows(st2)) {
        if (row.state === 'submitted') await verifySubmitted(r.roundId, index);
      }
    } catch (error) {
      setWarn(`讀紀錄失敗：${error.message}`);
    }
    render();
    if (autoResume) { dockExecution(true);ctx.autoResumed = true; runLoop(); }
    return true;
  }

  // 只能看的分頁：員工按「接手」才拿鎖；接手後先核對可能已提交的列，再按「繼續」
  async function onTakeoverFromReadOnly() {
    if (ctx.lockHeld) return;
    if (!(await acquireLock())) { setWarn('另一個分頁還在用，拿不到控制權','notice'); return; }
    try {
      const state = loadState();
      state.expect = null;
      state.owner = { tabId: ctx.tabId, gen: ctx.gen, at: nowText() };
      const round = activeRound(state);
      if (round && round.status === 'running') round.status = 'paused';
      saveState(state);
      for (const { round: r, index, row } of blockingRows(loadState())) {
        if (row.state === 'submitted') await verifySubmitted(r.roundId, index);
      }
      if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
      log('已接手，請確認後按「繼續」');
    } catch (error) { setWarn(error.message); }
    render();
  }

  boot();
})();
