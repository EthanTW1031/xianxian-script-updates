// ==UserScript==
// @name         FB 收件匣姓名搜尋助手（含前天）
// @namespace    local.fb-inbox-finder
// @version      1.0.0
// @description  分段搜尋目前收件匣的姓名；搜尋今天到前天，找到或越過日期界線時停止。
// @match        https://business.facebook.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const TITLE = '[data-surface$="/lib:thread_title"]';
  const ROW = /(?:^|[:/])thread_list\/thread_row(\d+)$/;
  const TZ = 'Asia/Taipei';
  const normalize = s => String(s).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\s]/g, '').toLocaleLowerCase('en-US');
  function taipeiDay(now = new Date()) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return Object.fromEntries(p.map(x => [x.type, x.value]));
  }
  function cutoff(now = new Date()) {
    const p = taipeiDay(now);
    // 台灣前天 00:00；包含前天整天，並非往回 48 小時。
    return Date.UTC(+p.year, +p.month - 1, +p.day - 2) - 8 * 3600000;
  }
  function formatDay(ms) {
    return new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' }).format(ms);
  }
  function parseStamp(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(raw) * 1000;
    return Number.isFinite(n) && n > Date.UTC(2000, 0, 1) && n < Date.UTC(2100, 0, 1) ? n : null;
  }
  function matches(name, query, partial = false) {
    const n = normalize(name), q = normalize(query);
    return !!q && (partial ? n.includes(q) : n === q);
  }
  const identity = r => `${r.name}\u0000${r.at}`;
  function newScan() { return { last: -1, at: Infinity, seen: new Map(), count: 0 }; }
  function inspectBatch(rows, state, query, boundary, partial = false) {
    if (!rows.length) return { kind: 'wait' };
    const sorted = [...rows].sort((a, b) => a.index - b.index);
    for (const r of sorted) {
      if (!r.name || !Number.isInteger(r.index) || !Number.isFinite(r.at)) return { kind: 'error', message: '無法辨識姓名或日期，已停止；本次搜尋未完成。' };
      if (state.seen.has(r.index) && state.seen.get(r.index) !== identity(r)) return { kind: 'error', message: '搜尋途中清單順序改變，已停止；請重新開始。' };
    }
    const fresh = sorted.filter(r => r.index > state.last);
    let prevIndex = state.last, prevAt = state.at;
    // 先檢查整批，避免置頂或其他排序讓日期提早截斷。
    for (const r of fresh) {
      if (r.index !== prevIndex + 1) return { kind: 'error', message: '清單出現缺列或未從頂端開始，已停止；請重新開始。' };
      if (r.at > prevAt) return { kind: 'error', message: '清單並非依時間由新到舊排列，已停止。請取消優先／篩選排序後重試。' };
      prevIndex = r.index; prevAt = r.at;
    }
    for (const r of fresh) {
      if (r.at < boundary) return { kind: 'boundary', row: r };
      state.seen.set(r.index, identity(r)); state.last = r.index; state.at = r.at; state.count++;
      if (matches(r.name, query, partial)) return { kind: 'found', row: r };
    }
    return { kind: fresh.length ? 'progress' : 'wait' };
  }
  // 供本機測試使用；瀏覽器中不建立全域函式或匯出客戶資料。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalize, cutoff, parseStamp, matches, newScan, inspectBatch, ROW };
    return;
  }
  if (document.getElementById('local-fb-finder')) return;

  function findScroller() {
    const candidates = new Set();
    for (const title of document.querySelectorAll(TITLE)) {
      for (let p = title.parentElement; p && p !== document.body; p = p.parentElement) {
        const css = getComputedStyle(p), rect = p.getBoundingClientRect();
        if (/(auto|scroll)/.test(css.overflowY) && p.clientHeight > 80 && rect.width > 150 && rect.height > 80) {
          candidates.add(p); break;
        }
      }
    }
    if (candidates.size !== 1) throw new Error('無法唯一辨識左側清單。請開啟收件匣並等待對話載入。');
    return [...candidates][0];
  }
  function readRows(scroller) {
    const result = [];
    for (const title of scroller.querySelectorAll(TITLE)) {
      let row = title.parentElement;
      while (row && row !== scroller && !ROW.test(row.getAttribute('data-surface') || '')) row = row.parentElement;
      if (!row || row === scroller) throw new Error('FB 對話列結構已變更，請更新腳本。');
      const stamp = row.querySelector('abbr[data-utime]');
      result.push({ index: +row.getAttribute('data-surface').match(ROW)[1], name: title.textContent.trim(),
        at: parseStamp(stamp?.getAttribute('data-utime')), element: row.parentElement });
    }
    return result.sort((a, b) => a.index - b.index);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const host = document.createElement('div'); host.id = 'local-fb-finder';
  host.style.cssText = 'position:fixed;right:18px;top:110px;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{font:14px/1.5 system-ui,"Microsoft JhengHei",sans-serif;color:#172b40}
      *{box-sizing:border-box} .panel{width:292px;background:#fff;border:1px solid #bccbd9;border-radius:12px;box-shadow:0 6px 28px #102d4530;overflow:hidden}
      header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#eef5ff;cursor:move;user-select:none;font-weight:700}
      main{padding:12px}label{display:block}input[type=text]{width:100%;padding:9px;border:1px solid #a6b7ca;border-radius:7px;margin:5px 0 8px;font:inherit}
      .hint{font-size:12px;color:#52677d;margin:4px 0 8px}.buttons{display:flex;gap:8px;margin:10px 0}
      button{font:inherit;border:1px solid #bccbd9;border-radius:7px;padding:7px 12px;cursor:pointer;background:#fff;color:#172b40}
      button.primary{background:#1769d3;color:white;border-color:#1769d3}button:disabled{opacity:.5;cursor:default}
      #toggle{padding:0 8px}#status{white-space:pre-line;overflow-wrap:anywhere;background:#f3f6fa;padding:9px;border-radius:7px;max-height:190px;overflow:auto}
      .range{font-weight:600;font-size:13px}.partial{font-size:13px}input[type=checkbox]{vertical-align:middle}
    </style>
    <section class="panel"><header><span>FB 姓名搜尋助手</span><button id="toggle" aria-label="收合或展開">−</button></header>
    <main><label>客人 FB 姓名<input id="query" type="text" autocomplete="off" placeholder="輸入姓名"></label>
    <label class="partial"><input type="checkbox" id="partial"> 部分姓名符合即可</label>
    <p class="range" id="range"></p><div class="hint">依台灣日期，包含前天整天。搜尋目前清單；開始時自動回到頂端。</div>
    <div class="buttons"><button class="primary" id="start">開始搜尋</button><button id="stop" disabled>停止</button></div>
    <div id="status" role="status" aria-live="polite">準備就緒。找到後會標示該列，由你點開對話。</div>
    <div class="hint">Esc 可停止。可拖曳標題移動面板。</div></main></section>`;
  document.body.append(host);
  const $ = id => root.getElementById(id);
  let token = 0, running = false, clearHighlight = () => {};
  function range() { $('range').textContent = `範圍：${formatDay(cutoff())} 00:00 起 ～ 今天`; }
  function status(text) { $('status').textContent = text; }
  function finish(text) {
    running = false; token++;
    $('start').disabled = false; $('stop').disabled = true;
    $('query').disabled = false; $('partial').disabled = false;
    status(text);
  }
  function highlight(scroller, row) {
    const box = row.element;
    const top = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
    let marked = null, restore = () => {};
    const apply = () => {
      if (!scroller.isConnected) { observer.disconnect(); restore(); return; }
      let current;
      try { current = readRows(scroller).find(r => r.index === row.index && identity(r) === identity(row))?.element; } catch { return; }
      if (current === marked) return;
      restore(); marked = current;
      if (!current) { restore = () => {}; return; }
      const old = [current.style.outline, current.style.outlineOffset];
      current.style.outline = '3px solid #e09600'; current.style.outlineOffset = '-3px';
      restore = () => { current.style.outline = old[0]; current.style.outlineOffset = old[1]; };
    };
    const observer = new MutationObserver(apply);
    observer.observe(scroller, { childList: true, subtree: true }); apply();
    clearHighlight = () => { observer.disconnect(); restore(); };
  }
  async function start() {
    const query = $('query').value.trim(), partial = $('partial').checked;
    if (!normalize(query)) { status('請先輸入客人姓名。'); $('query').focus(); return; }
    clearHighlight(); range(); running = true; const mine = ++token;
    $('start').disabled = true; $('stop').disabled = false; $('query').disabled = true; $('partial').disabled = true;
    const boundary = cutoff(), url = location.href, began = Date.now(), state = newScan();
    let scroller, noProgress = Date.now(), lastFingerprint = '', awaitingTop = true;
    const active = () => running && token === mine;
    try {
      scroller = findScroller(); scroller.scrollTo({ top: 0, behavior: 'instant' });
      status('回到清單頂端，等待載入……');
      await sleep(850);
      while (active()) {
        if (location.href !== url || !scroller.isConnected) throw new Error('頁面或收件匣已切換，本次搜尋已停止。');
        if (cutoff() !== boundary) throw new Error('已跨午夜，請重新開始以更新日期範圍。');
        if (Date.now() - began > 10 * 60000) throw new Error('已達 10 分鐘上限，本次搜尋未完成。');
        const rows = readRows(scroller);
        if (awaitingTop) {
          if (rows[0]?.index === 0 && scroller.scrollTop < 5) awaitingTop = false;
          else {
            if (Date.now() - began > 12000) throw new Error('清單頂端未載入，請稍後重新開始。');
            scroller.scrollTo({ top: 0, behavior: 'instant' }); await sleep(500); continue;
          }
        }
        const result = inspectBatch(rows, state, query, boundary, partial);
        if (result.kind === 'error') throw new Error(result.message);
        if (result.kind === 'found') {
          highlight(scroller, result.row);
          finish(`找到「${result.row.name}」\n最後對話：${formatDay(result.row.at)}\n已停止，請點左側標示的對話。`); return;
        }
        if (result.kind === 'boundary') {
          finish(`範圍內未找到「${query}」。\n已查 ${state.count} 列，遇到早於 ${formatDay(boundary)} 的對話，自動停止。\n依最後對話時間判斷，未確認下單管道。`); return;
        }
        const fp = rows.map(r => `${r.index}:${r.at}:${r.name}`).join('|');
        if (fp !== lastFingerprint) { lastFingerprint = fp; noProgress = Date.now(); }
        if (Date.now() - noProgress > 15000) throw new Error(`清單到底或載入停滯，已停止。已查 ${state.count} 列；尚未確認到達日期界線，本次搜尋未完成。`);
        status(`搜尋「${query}」中，已查 ${state.count} 列。\n${state.count ? '目前查到：' + formatDay(state.at) : '等待載入……'}\n遇到早於 ${formatDay(boundary)} 的對話會停止。`);
        // 捲動不能越過已讀取區段；保留約半個畫面的重疊，等待虛擬列重繪。
        if (rows.length) {
          const step = Math.max(30, Math.floor(scroller.clientHeight * .55));
          const coveredBottom = rows[rows.length - 1].element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
          const safeTop = Math.max(scroller.scrollTop, coveredBottom - scroller.clientHeight * .45);
          scroller.scrollTo({ top: Math.min(scroller.scrollTop + step, safeTop), behavior: 'instant' });
        }
        await sleep(850);
      }
    } catch (err) { if (active()) finish(err.message || '搜尋發生錯誤，已停止。'); }
  }
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => finish('已手動停止。重新開始會從頂端搜尋。'));
  $('query').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!running) start(); } });
  document.addEventListener('keydown', e => { if (running && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('已按 Esc 停止。'); } }, true);
  // 使用者接手、換頁或切分頁時停止，避免搶動捲軸。
  for (const event of ['pointerdown', 'wheel', 'touchstart']) document.addEventListener(event, e => {
    if (running && !e.composedPath().includes(host)) finish('你已接手操作，搜尋已停止。');
  }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) finish('分頁已移到背景，搜尋已停止；回來後可重新開始。'); });
  $('toggle').addEventListener('click', () => { const main = root.querySelector('main'); main.hidden = !main.hidden; $('toggle').textContent = main.hidden ? '+' : '−'; });
  root.querySelector('header').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const header = e.currentTarget; header.setPointerCapture(e.pointerId);
    const move = ev => { host.style.right = 'auto'; host.style.left = Math.max(0, Math.min(innerWidth - 292, ev.clientX - dx)) + 'px'; host.style.top = Math.max(0, Math.min(innerHeight - 45, ev.clientY - dy)) + 'px'; };
    const end = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', end); header.removeEventListener('pointercancel', end); };
    header.addEventListener('pointermove', move); header.addEventListener('pointerup', end); header.addEventListener('pointercancel', end);
  });
  range();
  setInterval(() => {
    const inbox = /\/latest\/inbox(?:\/|$)/.test(location.pathname);
    host.hidden = !inbox;
    if (!inbox && running) finish('已離開收件匣，搜尋已停止。');
    if (!running) range();
  }, 1000);
})();
