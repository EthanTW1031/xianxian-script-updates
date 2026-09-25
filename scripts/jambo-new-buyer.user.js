// ==UserScript==
// @name         Jambo 新買家檢查
// @namespace    https://jambolive.tv/
// @version      4.0.3
// @description  訂單頁掃描 NEW 新買家並匯出含嵌入頭像的 Excel 核對名單
// @match        https://jambolive.tv/console/order/*
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @grant        GM_xmlhttpRequest
// @connect      graph.facebook.com
// @connect      fbcdn.net
// @connect      fbsbx.com
// @connect      cdn.jambolive.tv
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (!window.location.pathname.startsWith('/console/order/')) return;
  const PANEL_ID = 'jambo-new-buyer-excel-panel';
  if (document.getElementById(PANEL_ID)) return;
  // Support the current Jambo fan cell and both earlier name layouts.
  const NAME_SELECTOR = '.jb-fan-cell__name, .jb-name-line__name, .fans-info-name';
  const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const state = { busy: false, stop: false, fingerprint: '', stale: false, scope: '', snapshot: null };
  const activeRequests = new Set();
  let panel;

  function accountCell(row) {
    const cell = row.querySelector(NAME_SELECTOR)?.closest('td');
    return cell?.closest('tr') === row ? cell : null;
  }

  function orderRows() {
    const identified = [...document.querySelectorAll('tr[id^="order-"]')];
    if (identified.length) return identified;
    return [...document.querySelectorAll('table tbody tr')].filter(row => accountCell(row));
  }

  function imageUrl(image) {
    for (const value of [image?.getAttribute('data-src'), image?.currentSrc, image?.getAttribute('src')]) {
      if (!value) continue;
      try {
        const url = new URL(value, window.location.href);
        if (url.protocol === 'https:') return url.href;
      } catch { /* Invalid or unavailable avatar: retain the text card. */ }
    }
    return '';
  }

  function readBuyer(row, index) {
    const cell = accountCell(row);
    if (!cell) return null;
    const name = cleanText(cell.querySelector(NAME_SELECTOR)?.textContent);
    if (!name) return null;
    const avatar = cell.querySelector('.jb-fan-avatar, .account-photo-container');
    const marker = cell.querySelector('.jb-fan-avatar__jamboer, .icon-jamboer');
    const markerContent = marker ? window.getComputedStyle(marker).content : '';
    const isNew = Boolean(avatar?.classList.contains('is-new')) ||
      /icon_jamboer_new\.png/i.test([
        markerContent, marker?.getAttribute('src'), marker?.getAttribute('data-src')
      ].join(' '));
    const image = cell.querySelector('img.jb-fan-avatar__img, img.account-photo');
    const photo = imageUrl(image);
    let id = '';
    // Account IDs stay strings; Facebook IDs can exceed JavaScript's safe integer range.
    for (const value of [image?.getAttribute('data-src'), image?.currentSrc, image?.getAttribute('src')]) {
      const match = String(value || '').match(/graph\.facebook\.com\/(?:v\d+(?:\.\d+)?\/)?(\d+)\/picture/i);
      if (match) { id = match[1]; break; }
    }
    if (!id) {
      id = cell.querySelector('[onclick*="get_fans_summary"]')?.getAttribute('onclick')
        ?.match(/get_fans_summary\(['"](\d+)['"]/)?.[1] || '';
    }
    return {
      name, id, photo, isNew, markerKnown: Boolean(avatar || marker), row,
      // Missing IDs must never cause two different people with the same name to merge.
      key: id ? `fb:${id}` : `unverified:${row.id || index}`,
    };
  }

  function collect() {
    const rows = orderRows();
    const groups = new Map();
    let unreadable = 0, unknownMarkers = 0, missingIds = 0, newRows = 0;
    rows.forEach((row, index) => {
      const buyer = readBuyer(row, index);
      if (!buyer) { unreadable++; return; }
      if (!buyer.markerKnown) unknownMarkers++;
      if (!buyer.isNew) return;
      newRows++;
      if (!buyer.id) missingIds++;
      if (!groups.has(buyer.key)) groups.set(buyer.key, { ...buyer, aliases: [], count: 0 });
      const group = groups.get(buyer.key);
      if (!group.aliases.includes(buyer.name)) group.aliases.push(buyer.name);
      if (!group.photo && buyer.photo) group.photo = buyer.photo;
      group.count++;
    });
    return { buyers: [...groups.values()], total: rows.length, newRows, unreadable, unknownMarkers, missingIds };
  }

  function scopeFingerprint() {
    const filterNames = new Set(['kind','search_field','search','search_begin','search_end','from_name','is_from_id','commodity_id','sessions','begin','end']);
    const filters = [...document.querySelectorAll('#form_search input, #form_search select')]
      .filter(e => filterNames.has(e.name)).map(e => [e.name, e.value]);
    return JSON.stringify([window.location.href, filters]);
  }

  function pageFingerprint() {
    const rows = orderRows().map((row, index) => {
      const buyer = readBuyer(row, index);
      return [row.id || index, buyer?.id, buyer?.name, buyer?.isNew, buyer?.markerKnown];
    });
    return JSON.stringify([scopeFingerprint(), rows]);
  }

  function hasOrderTable() {
    return orderRows().length > 0 || [...document.querySelectorAll('table')].some(table => {
      const headings = [...(table.rows[0]?.cells || [])].map(h => cleanText(h.textContent));
      return headings.includes('訂單編號') && headings.includes('FB帳號');
    });
  }

  function loadMoreButton() {
    const more = document.getElementById('more');
    if (!more) return null;
    const button = more.querySelector('[onclick*="orders_more"]');
    if (!button || button.disabled || !/^載入更多[.。…]*$/.test(cleanText(button.textContent))) return null;
    for (let element = button; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || element.hidden) return null;
    }
    return button;
  }

  function completionSignal() {
    const more = document.getElementById('more');
    return !loadMoreButton() && (more ? cleanText(more.textContent).includes('載入完成') : hasOrderTable());
  }

  function ensureRunning() {
    if (state.stop) throw new Error('已停止掃描');
    if (state.scope && scopeFingerprint() !== state.scope) throw new Error('掃描期間搜尋條件已變動，請重新掃描');
  }

  function status(text, warning = false) {
    const element = panel.querySelector('[data-role="status"]');
    element.textContent = text;
    element.classList.toggle('jna-warning', warning);
  }

  async function waitForBatch(previousCount) {
    const started = Date.now();
    let lastCount = previousCount, stableSince = Date.now();
    while (Date.now() - started < 30000) {
      ensureRunning();
      const count = orderRows().length;
      if (count !== lastCount) { lastCount = count; stableSince = Date.now(); }
      status(`正在載入訂單：${count} 筆`);
      if (Date.now() - stableSince >= 1000 && (count > previousCount || completionSignal())) return;
      await delay(200);
    }
    throw new Error('「載入更多」逾時，請確認網路後重新掃描');
  }

  async function loadAllOrders() {
    if (!hasOrderTable()) throw new Error('找不到訂單表格，請在訂單清單頁操作');
    let loads = 0, noButtonSince = Date.now(), lastCount = orderRows().length, stableSince = Date.now();
    while (true) {
      ensureRunning();
      const count = orderRows().length;
      if (count !== lastCount) { lastCount = count; stableSince = Date.now(); }
      const button = loadMoreButton();
      if (button) {
        if (loads >= 200) throw new Error('訂單批次超過上限，尚未全部載入');
        status(`載入全部訂單：目前 ${count} 筆`);
        button.scrollIntoView({ block: 'center', behavior: 'auto' });
        button.click();
        loads++;
        await waitForBatch(count);
        noButtonSince = Date.now();
        stableSince = Date.now();
        continue;
      }
      status(`確認訂單完整性：目前 ${count} 筆`);
      if (completionSignal() && Date.now() - stableSince >= 3000) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        await delay(800);
        ensureRunning();
        if (orderRows().length === count && completionSignal()) return;
        stableSince = Date.now();
        noButtonSince = Date.now();
      }
      if (Date.now() - noButtonSince >= 15000) throw new Error('無法確認訂單是否全部載入');
      await delay(250);
    }
  }

  async function waitForStableMarkers() {
    const started = Date.now();
    let previous = '', stableSince = Date.now();
    while (Date.now() - started < 20000) {
      ensureRunning();
      const fingerprint = pageFingerprint();
      if (fingerprint !== previous) { previous = fingerprint; stableSince = Date.now(); }
      const result = collect();
      status(`確認 NEW 標記：已讀取 ${result.total} 筆訂單`);
      if (!result.unreadable && !result.unknownMarkers && Date.now() - stableSince >= 4000) {
        if (!completionSignal()) throw new Error('頁面又出現待載入訂單，請重新掃描');
        return;
      }
      await delay(300);
    }
    const result = collect();
    const issues = [];
    if (result.unreadable) issues.push(`${result.unreadable} 筆買家姓名欄位無法辨識，網站版型可能已更新`);
    if (result.unknownMarkers) issues.push(`${result.unknownMarkers} 筆 NEW 標記無法確認`);
    throw new Error(issues.join('；') || '買家欄位或 NEW 標記持續變動，請稍後重新掃描');
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function render(result, complete, reason = '') {
    state.snapshot = {
      ...result,
      buyers: result.buyers.map(({ row, ...buyer }) => ({ ...buyer, aliases: [...buyer.aliases] })),
      complete, reason, scannedAt: new Date(), sourceUrl: window.location.href,
      scope: scopeFingerprint(),
    };
    const countLabel = result.missingIds ? `${result.buyers.length} 組新買家（含待確認帳號）` : `${result.buyers.length} 位新買家`;
    panel.querySelector('[data-role="summary"]').textContent = `已掃描 ${result.total} 筆訂單 · ${result.newRows} 筆 NEW 訂單 · ${countLabel}`;
    status(complete ? '掃描完成，可以匯出 Excel。' : `結果尚未完整：${reason}`, !complete);
    updateExportButton();
  }

  async function scan() {
    if (state.busy) return;
    state.busy = true;
    state.stop = false;
    state.stale = false;
    state.scope = scopeFingerprint();
    state.fingerprint = '';
    state.snapshot = null;
    updateExportButton();
    panel.querySelector('[data-role="scan"]').disabled = true;
    panel.querySelector('[data-role="stop"]').disabled = false;
    panel.querySelector('[data-role="summary"]').textContent = '準備掃描…';
    const originalScroll = { left: window.scrollX, top: window.scrollY };
    try {
      await loadAllOrders();
      await waitForStableMarkers();
      ensureRunning();
      const result = collect();
      const issues = [];
      if (result.unreadable) issues.push(`${result.unreadable} 筆買家欄位無法辨識`);
      if (result.unknownMarkers) issues.push(`${result.unknownMarkers} 筆新客標記無法確認`);
      if (result.missingIds) issues.push(`${result.missingIds} 筆新客訂單缺少帳號 ID，已分別保留`);
      render(result, issues.length === 0, issues.join('；'));
    } catch (error) {
      render(collect(), false, cleanText(error?.message || error));
    } finally {
      state.fingerprint = pageFingerprint();
      if (scopeFingerprint() !== state.scope) state.stale = true;
      state.busy = false;
      panel.querySelector('[data-role="scan"]').disabled = false;
      panel.querySelector('[data-role="stop"]').disabled = true;
      updateExportButton();
      window.scrollTo({ ...originalScroll, behavior: 'auto' });
    }
  }

  function updateExportButton() {
    const button = panel?.querySelector('[data-role="export"]');
    if (!button) return;
    button.disabled = state.busy || state.stale || !state.snapshot;
    button.textContent = state.snapshot && !state.snapshot.complete
      ? '匯出部分名單（結果尚未完整）' : '匯出 Excel（含頭像）';
  }

  function requestAvatar(url) {
    return new Promise((resolve, reject) => {
      const allowed = ['graph.facebook.com', 'fbcdn.net', 'fbsbx.com', 'cdn.jambolive.tv'];
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !allowed.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
        reject(new Error('頭像來源不在允許清單')); return;
      }
      let request, finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        activeRequests.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => { finish(new Error('已停止匯出')); request?.abort(); };
      // Anonymous requests can use fetch mode, so enforce our own timeout as well.
      const timer = window.setTimeout(() => {
        finish(new Error('頭像下載逾時')); request?.abort();
      }, 15000);
      activeRequests.add(cancel);
      try {
        request = GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'arraybuffer', anonymous: true, timeout: 15000,
          onload: response => {
            if (response.status < 200 || response.status >= 300) { finish(new Error(`頭像 HTTP ${response.status}`)); return; }
            const bytes = new Uint8Array(response.response || new ArrayBuffer(0));
            if (!bytes.length || bytes.length > 5 * 1024 * 1024) { finish(new Error('頭像空白或超過 5 MB')); return; }
            let mime = '';
            if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
            else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = 'image/png';
            else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) mime = 'image/gif';
            else if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') mime = 'image/webp';
            if (!mime) { finish(new Error('頭像回應不是可用圖片')); return; }
            finish(null, new Blob([bytes], { type: mime }));
          },
          onerror: () => finish(new Error('頭像下載失敗')),
          ontimeout: () => finish(new Error('頭像下載逾時')),
          onabort: () => finish(new Error('頭像下載已取消')),
        });
      } catch (error) { finish(error); }
    });
  }

  function normalizeAvatar(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        activeRequests.delete(cancel);
        image.onload = image.onerror = null;
        URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(new Error('已停止匯出'));
      const timer = window.setTimeout(() => finish(new Error('頭像解碼逾時')), 8000);
      activeRequests.add(cancel);
      image.onerror = () => finish(new Error('頭像格式無法開啟'));
      image.onload = () => {
        try {
          if (!image.naturalWidth || !image.naturalHeight) throw new Error('頭像尺寸無效');
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 192;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('無法處理頭像');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 192, 192);
          const scale = Math.min(192 / image.naturalWidth, 192 / image.naturalHeight);
          const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
          context.drawImage(image, (192 - width) / 2, (192 - height) / 2, width, height);
          finish(null, { base64: canvas.toDataURL('image/jpeg', 0.88), extension: 'jpeg' });
        } catch (error) { finish(error); }
      };
      image.src = url;
    });
  }

  async function downloadAvatars(buyers) {
    const images = new Map();
    let index = 0, completed = 0;
    async function worker() {
      while (index < buyers.length) {
        ensureRunning();
        const buyer = buyers[index++];
        try {
          if (!buyer.photo) throw new Error('頁面沒有頭像網址');
          const blob = await requestAvatar(buyer.photo);
          ensureRunning();
          images.set(buyer.key, await normalizeAvatar(blob));
        } catch (error) {
          images.set(buyer.key, { error: cleanText(error?.message || error) });
        }
        ensureRunning();
        completed++;
        status(`正在嵌入頭像：${completed}/${buyers.length}`);
      }
    }
    // Wait for all workers, including failures, before allowing another operation.
    // ExcelJS's browser bundle may install a Promise polyfill without allSettled.
    const outcomes = await Promise.all(Array.from({ length: Math.min(3, buyers.length) }, () =>
      worker().then(() => ({ error: null }), error => ({ error }))
    ));
    const failure = outcomes.find(outcome => outcome.error);
    if (failure) throw failure.error;
    return images;
  }

  function dateLabel(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  }

  function buildWorkbook(snapshot, images) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Jambo 新買家 Excel';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('新買家名單', {
      views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
      pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5' },
    });
    sheet.columns = [{width:18},{width:26},{width:12},{width:26},{width:12},{width:42}];
    const failedImages = snapshot.buyers.filter(b => !images.get(b.key)?.base64).length;
    sheet.getCell('A1').value = '新買家名單';
    sheet.getCell('A1').font = { name: 'Microsoft JhengHei', size: 16, bold: true };
    sheet.getRow(1).height = 28;
    sheet.getRow(2).values = ['掃描結果', snapshot.complete ? '掃描完成' : '結果尚未完整', null, snapshot.missingIds ? '新買家組數（含待確認）' : '新買家人數', snapshot.buyers.length];
    sheet.getRow(3).values = ['掃描時間', dateLabel(snapshot.scannedAt), null, '頭像未載入', failedImages];
    sheet.getRow(2).height = 24;
    sheet.getRow(3).height = 24;
    sheet.getRow(4).height = 10;
    sheet.getRow(5).values = ['頭像','買家姓名','訂單筆數','帳號 ID','已確認','備註'];
    sheet.getRow(5).height = 26;
    sheet.getRow(5).eachCell(cell => {
      cell.font = { name: 'Microsoft JhengHei', size: 11, bold: true, color: {argb:'FFFFFFFF'} };
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF274C3C'} };
      cell.alignment = { vertical:'middle', horizontal:'center' };
    });
    snapshot.buyers.forEach((buyer, index) => {
      const image = images.get(buyer.key);
      const notes = [];
      if (!buyer.id) notes.push('缺少帳號 ID，未合併同名買家');
      if (!image?.base64) notes.push(`頭像未載入：${image?.error || '無可用圖片'}`);
      const row = sheet.addRow([image?.base64 ? null : '無頭像', buyer.aliases.join('／'), buyer.count, buyer.id ? String(buyer.id) : null, null, notes.join('；') || null]);
      row.height = 84;
      row.eachCell({ includeEmpty:true }, cell => {
        cell.font = { name:'Microsoft JhengHei', size:11, color:{argb:'FF24332B'} };
        cell.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
        cell.border = { bottom:{ style:'hair', color:{argb:'FFDCE5DF'} } };
      });
      row.getCell(1).alignment = { vertical:'middle', horizontal:'center' };
      row.getCell(3).numFmt = '#,##0';
      row.getCell(3).alignment = { vertical:'middle', horizontal:'right' };
      row.getCell(4).numFmt = '@';
      row.getCell(5).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFFAE5'} };
      row.getCell(5).dataValidation = { type:'list', allowBlank:true, formulae:['"已確認,待確認"'] };
      if (image?.base64) {
        const id = workbook.addImage({ base64:image.base64, extension:image.extension });
        // Explicit pixel size avoids ExcelJS interpreting fractional custom-width
        // columns as tiny EMU offsets. 84 pt rows = 112 px: 8 + 96 + 8 padding.
        sheet.addImage(id, {
          tl: { col:0, row:row.number-1 },
          ext: { width:96, height:96 },
          editAs:'oneCell',
        });
      }
    });
    // Header only is a valid export when no NEW buyers were found.
    sheet.autoFilter = { from:'A5', to:`F${Math.max(5,sheet.rowCount)}` };
    for (const number of [2,3]) sheet.getRow(number).eachCell(cell => {
      cell.font = {name:'Microsoft JhengHei',size:10,color:{argb:'FF526158'}};
      cell.alignment = {vertical:'middle',wrapText:true};
    });
    if (!snapshot.complete) sheet.getCell('B2').font = {name:'Microsoft JhengHei',size:11,bold:true,color:{argb:'FFB45309'}};
    const info = workbook.addWorksheet('掃描資訊', {views:[{showGridLines:false}]});
    info.columns = [{width:24},{width:95}];
    const scope = JSON.parse(snapshot.scope)[1];
    const metadata = [
      ['項目','內容'], ['掃描時間',dateLabel(snapshot.scannedAt)],
      ['匯出時間',dateLabel(new Date())], ['掃描結果',snapshot.complete?'掃描完成':'結果尚未完整'],
      ['未完整原因',snapshot.reason || null], ['已掃描訂單筆數',snapshot.total],
      ['NEW 訂單筆數',snapshot.newRows], ['新買家組數',snapshot.buyers.length],
      ['缺少帳號 ID 的訂單',snapshot.missingIds], ['頭像未載入筆數',failedImages],
      ['判定範圍','只依目前訂單頁的 Jambo NEW 標記整理，不查詢歷史付款單。'],
      ['名單時間','本檔為掃描當下的快照；後續訂單或 NEW 標記異動需重新掃描匯出。'],
      ['來源頁面',snapshot.sourceUrl], ['搜尋條件',scope.map(([key,value])=>`${key}=${value}`).join('\n')],
    ];
    metadata.forEach((values,index)=>{
      const row=info.addRow(values);
      row.height=index>=10?Math.max(42,Math.ceil(String(values[1]).length/75)*16):24;
      if(index===13) row.height=Math.min(300,Math.max(42,scope.length*16));
      row.eachCell(cell=>{cell.font={name:'Microsoft JhengHei',size:11};cell.alignment={vertical:'top',wrapText:true};});
    });
    info.getRow(1).eachCell(cell=>{
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF274C3C'}};
      cell.font={name:'Microsoft JhengHei',size:11,bold:true,color:{argb:'FFFFFFFF'}};
    });
    return { workbook, failedImages };
  }

  function triggerDownload(buffer, filename) {
    const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href=url; link.download=filename;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url),30000);
  }

  async function exportExcel() {
    if (state.busy || !state.snapshot) return;
    if (state.stale || pageFingerprint() !== state.fingerprint) {
      state.stale=true; updateExportButton(); status('訂單或標記已變動，請重新掃描後匯出。',true); return;
    }
    if (typeof ExcelJS === 'undefined') { status('Excel 元件未載入，請重新整理或檢查 Tampermonkey 的外部元件下載。',true); return; }
    state.busy=true; state.stop=false;
    updateExportButton();
    panel.querySelector('[data-role="scan"]').disabled=true;
    panel.querySelector('[data-role="stop"]').disabled=false;
    try {
      const snapshot=state.snapshot;
      const images=await downloadAvatars(snapshot.buyers);
      ensureRunning();
      const {workbook,failedImages}=buildWorkbook(snapshot,images);
      status('正在產生 Excel 檔案…');
      const buffer=await workbook.xlsx.writeBuffer();
      ensureRunning();
      if (pageFingerprint() !== state.fingerprint) {
        state.stale=true;
        throw new Error('匯出期間訂單或標記已變動，請重新掃描');
      }
      const stamp=dateLabel(snapshot.scannedAt).replace(/[: ]/g,'-');
      triggerDownload(buffer, `${stamp}_新買家名單${snapshot.complete?'':'_結果尚未完整'}.xlsx`);
      status(`已匯出 ${snapshot.buyers.length} 組新買家${failedImages?`；${failedImages} 張頭像未載入，已保留姓名`:''}${snapshot.complete?'':'；結果尚未完整，請見檔案說明'}`,failedImages>0||!snapshot.complete);
    } catch(error) {
      status(`匯出未完成：${cleanText(error?.message||error)}`,true);
    } finally {
      state.busy=false;
      panel.querySelector('[data-role="scan"]').disabled=false;
      panel.querySelector('[data-role="stop"]').disabled=true;
      updateExportButton();
    }
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const style = element('style');
    style.textContent = `
      #${PANEL_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:320px;max-width:calc(100vw - 16px);padding:12px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#24332b;box-shadow:0 8px 28px #182c2426;font:14px/1.5 Arial,"Microsoft JhengHei",sans-serif;box-sizing:border-box}
      #${PANEL_ID} *{box-sizing:border-box}
      #${PANEL_ID}.jna-collapsed{width:220px}
      #${PANEL_ID}.jna-collapsed .jna-body{display:none}
      #${PANEL_ID} .jna-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
      #${PANEL_ID} button{cursor:pointer;font:inherit}
      #${PANEL_ID} button:disabled{opacity:.55;cursor:default}
      #${PANEL_ID} .jna-toggle{border:1px solid #d0d5dd;background:white;border-radius:6px;width:28px;height:28px}
      #${PANEL_ID} .jna-body{max-height:calc(100vh - 110px);overflow:auto;padding-top:10px}
      #${PANEL_ID} .jna-actions{display:flex;gap:8px}
      #${PANEL_ID} .jna-scan{flex:1;background:#087443;color:white;border:0;border-radius:7px;padding:9px}
      #${PANEL_ID} .jna-stop{background:white;border:1px solid #d0d5dd;border-radius:7px;padding:9px}
      #${PANEL_ID} .jna-status{font-size:13px;color:#087443;margin:9px 0}
      #${PANEL_ID} .jna-warning{color:#b45309}
      #${PANEL_ID} .jna-summary{font-size:12px;color:#526158;margin:8px 0}
      #${PANEL_ID} .jna-export{width:100%;padding:9px;border:0;border-radius:7px;background:#245b95;color:white}
      #${PANEL_ID} .jna-note{font-size:11px;color:#66756c;margin:9px 0 0}
      #${PANEL_ID} .jna-empty{grid-column:1/-1;color:#66756c}
      #${PANEL_ID} button:focus-visible{outline:3px solid #349a69;outline-offset:2px}
    `;
    document.head.append(style);
    panel = element('section', undefined, 'jna-collapsed');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'Jambo 新買家 Excel');
    panel.innerHTML = `
      <div class="jna-header"><strong>新買家 Excel</strong><button type="button" class="jna-toggle" aria-label="展開新買家 Excel" aria-expanded="false">+</button></div>
      <div class="jna-body">
        <div class="jna-actions"><button type="button" class="jna-scan" data-role="scan">載入全部訂單並掃描</button><button type="button" class="jna-stop" data-role="stop" disabled>停止</button></div>
        <div class="jna-status" data-role="status" role="status" aria-live="polite">按下掃描，整理目前篩選範圍的新買家。</div>
        <div class="jna-summary" data-role="summary"></div>
        <button type="button" class="jna-export" data-role="export" disabled>匯出 Excel（含頭像）</button>
        <p class="jna-note">只依目前篩選範圍的 NEW 標記整理，相同帳號只列一次。Excel 保留掃描當下的名單。</p>
      </div>`;
    document.body.append(panel);
    let clamp = () => {};
    panel.querySelector('.jna-toggle').addEventListener('click', event => {
      const collapsed = panel.classList.toggle('jna-collapsed');
      event.currentTarget.textContent = collapsed ? '+' : '−';
      event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
      event.currentTarget.setAttribute('aria-label', `${collapsed ? '展開' : '收合'}新買家 Excel`);
      window.requestAnimationFrame(clamp);
    });
    panel.querySelector('[data-role="scan"]').addEventListener('click', scan);
    panel.querySelector('[data-role="export"]').addEventListener('click', exportExcel);
    panel.querySelector('[data-role="stop"]').addEventListener('click', () => {
      state.stop = true;
      for (const cancel of [...activeRequests]) cancel();
      status('正在停止…', true);
    });
    clamp = makePanelDraggable(panel, panel.querySelector('.jna-header'), 'jambo-new-buyer-avatar-position-v3');
    let refreshTimer;
    function checkStale() {
      if (state.busy || !state.fingerprint || state.stale) return;
      if (pageFingerprint() !== state.fingerprint) {
        state.stale = true;
        updateExportButton();
        status('結果需更新：訂單、NEW 標記或搜尋條件已變動，請重新掃描。', true);
      }
    }
    const observer = new MutationObserver(mutations => {
      if (mutations.every(mutation => panel.contains(mutation.target))) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(checkStale, 400);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('change', event => { if (!panel.contains(event.target)) checkStale(); });
    document.addEventListener('input', event => { if (!panel.contains(event.target)) checkStale(); });
  }

  function makePanelDraggable(panel, handle, storageKey) {
    const viewportPadding = 8;
    let dragState = null;

    const clampPosition = () => {
      if (!panel.style.left || panel.style.left === 'auto') return;

      const rect = panel.getBoundingClientRect();
      const maximumLeft = Math.max(
        viewportPadding,
        window.innerWidth - rect.width - viewportPadding
      );
      const maximumTop = Math.max(
        viewportPadding,
        window.innerHeight - rect.height - viewportPadding
      );
      const left = Math.min(
        maximumLeft,
        Math.max(viewportPadding, Number.parseFloat(panel.style.left) || rect.left)
      );
      const top = Math.min(
        maximumTop,
        Math.max(viewportPadding, Number.parseFloat(panel.style.top) || rect.top)
      );

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const savePosition = () => {
      const rect = panel.getBoundingClientRect();
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ left: rect.left, top: rect.top })
        );
      } catch (error) {
        console.warn('[Jambo 面板] 無法記住拖曳位置', error);
      }
    };

    const finishDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      handle.classList.remove('jambo-panel-dragging');
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // 指標可能已經被瀏覽器釋放。
      }
      clampPosition();
      savePosition();
    };

    handle.style.cursor = 'grab';
    handle.style.touchAction = 'none';
    handle.style.userSelect = 'none';

    handle.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0 ||
        event.target.closest('button, input, select, textarea, a, label')
      ) {
        return;
      }

      const rect = panel.getBoundingClientRect();
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('jambo-panel-dragging');
      handle.style.cursor = 'grabbing';
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const maximumLeft = Math.max(
        viewportPadding,
        window.innerWidth - panel.offsetWidth - viewportPadding
      );
      const maximumTop = Math.max(
        viewportPadding,
        window.innerHeight - panel.offsetHeight - viewportPadding
      );
      const left = Math.min(
        maximumLeft,
        Math.max(viewportPadding, event.clientX - dragState.offsetX)
      );
      const top = Math.min(
        maximumTop,
        Math.max(viewportPadding, event.clientY - dragState.offsetY)
      );

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    handle.addEventListener('pointerup', (event) => {
      handle.style.cursor = 'grab';
      finishDrag(event);
    });
    handle.addEventListener('pointercancel', (event) => {
      handle.style.cursor = 'grab';
      finishDrag(event);
    });

    try {
      const savedPosition = JSON.parse(
        window.localStorage.getItem(storageKey) || 'null'
      );
      if (
        savedPosition &&
        Number.isFinite(savedPosition.left) &&
        Number.isFinite(savedPosition.top)
      ) {
        panel.style.left = `${savedPosition.left}px`;
        panel.style.top = `${savedPosition.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    } catch (error) {
      console.warn('[Jambo 面板] 無法讀取拖曳位置', error);
    }

    window.addEventListener('resize', clampPosition);
    window.requestAnimationFrame(clampPosition);
    return clampPosition;
  }


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
