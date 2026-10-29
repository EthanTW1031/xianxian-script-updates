// ==UserScript==
// @name         Jambo 商品庫存
// @namespace    https://jambolive.tv/
// @version      2.1.6
// @description  獨立匯出含圖片、成本價與直購價的商品庫存及五欄商品清單 XLSX
// @match        https://jambolive.tv/console/commodity/*
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @grant        GM_xmlhttpRequest
// @connect      cdn.jambolive.tv
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
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
  let dock=null;

  if (!window.location.pathname.startsWith('/console/commodity/')) return;

  const PANEL_ID = 'jambo-inventory-export-panel';
  if(document.documentElement.hasAttribute('data-ethan-boot-stock'))return;
  document.documentElement.setAttribute('data-ethan-boot-stock','1');
  const PANEL_POSITION_STORAGE_KEY = 'jambo-inventory-panel-position-v1';
  const PREPARE_BUTTON_ID = 'jambo-load-expand-all';
  const LOAD_MORE_LABEL = '載入更多';
  const XLSX_IMAGE_SIZE = 540;
  const XLSX_IMAGE_COLUMN_WIDTH = 78;
  const XLSX_IMAGE_HEIGHT_POINTS = 405;

  const cleanText = (value) =>
    String(value ?? '')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const delay = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds));

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

  const parseStock = (value) => {
    const match = cleanText(value).match(/[+-]?\d[\d,]*/);
    return match ? match[0].replaceAll(',', '') : '';
  };

  const PRODUCT_CODE_PATTERN = /^[A-Z][0-9]{2,3}$/u;
  const CATALOG_SIZE_TOKENS = [
    'XXXXL',
    '4XL',
    'XXXL',
    '3XL',
    'XXL',
    '2XL',
    'XL',
    'XX',
    'XS',
    '3L',
    'FREE',
    'F',
    'L',
    'M',
    'S',
    '大',
    '中',
    '小',
  ];

  const normalizeCatalogToken = (value) =>
    cleanText(value).normalize('NFKC').replace(/\s+/gu, '').toUpperCase();

  const uniqueCatalogTokens = (values) => {
    const seen = new Set();
    const output = [];

    for (const value of values) {
      const text = cleanText(value).normalize('NFKC');
      const key = normalizeCatalogToken(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(text);
    }

    return output;
  };

  function parseMoney(value) {
    const normalized = cleanText(value)
      .normalize('NFKC')
      .replace(/\s+/gu, '');
    const match = normalized.match(/^\$?([0-9][0-9,]*)$/u);
    if (!match) return null;

    const number = Number(match[1].replaceAll(',', ''));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function getModernProductRow(nameElement) {
    const row = nameElement.closest('#commodity-table tbody > tr');
    return row?.querySelector(':scope > [data-jb-cell="title"]') ? row : null;
  }

  function getModernTable() {
    const table = document.getElementById('commodity-table');
    return table?.querySelector('[data-jb-cell], [data-jb-col]') ? table : null;
  }

  function getProductNames() {
    const table = getModernTable();
    if (table) {
      return Array.from(table.querySelectorAll('tbody > tr')).map((row) =>
        row.querySelector('[data-jb-cell="title"] .jb-media-cell__body > .u-block')
      ).filter(Boolean);
    }
    return Array.from(document.querySelectorAll('p.name'));
  }

  function getProductName(nameElement) {
    if (!getModernProductRow(nameElement)) return cleanText(nameElement.textContent);
    // 款式數量是名稱 span 的子元素，不屬於商品名稱。
    return cleanText(Array.from(nameElement.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent).join(''));
  }

  function findProductInfoTable(nameElement) {
    const modernRow = getModernProductRow(nameElement);
    if (modernRow) return modernRow;
    const productContainer = nameElement.parentElement;
    if (!productContainer) return null;

    return (
      Array.from(productContainer.querySelectorAll(':scope > table')).find(
        (table) =>
          Array.from(table.querySelectorAll('td')).some(
            (cell) =>
              cleanText(cell.children?.[0]?.textContent) === '銷售方式'
          )
      ) ?? null
    );
  }

  function readProductInfoValue(infoTable, label) {
    if (!infoTable) return '';

    if (infoTable.matches('#commodity-table tbody > tr')) {
      if (label === '銷售方式') {
        return cleanText(infoTable.querySelector('[data-jb-cell="title"] .jb-badge')?.textContent);
      }
      const columns = { '關鍵字': 'keyword', '成本': 'cost', '直購價/起標價': 'price' };
      const column = columns[label];
      return column ? cleanText(infoTable.querySelector(`:scope > [data-jb-col="${column}"]`)?.textContent) : '';
    }

    const cell = Array.from(infoTable.querySelectorAll('td')).find(
      (candidate) =>
        cleanText(candidate.children?.[0]?.textContent) === label
    );
    return cleanText(cell?.children?.[1]?.textContent);
  }

  function cleanCatalogProductName(productName, code) {
    let output = cleanText(productName).replace(/^\d{4}\s*[-－]\s*/u, '');
    const normalizedCode = normalizeCatalogToken(code);

    if (
      normalizedCode &&
      normalizeCatalogToken(output).startsWith(normalizedCode)
    ) {
      output = output
        .slice(cleanText(code).length)
        .replace(/^[\s\-_:：－]+/u, '');
    }

    return cleanText(output) || cleanText(productName);
  }

  function splitStyleAndSize(style) {
    const normalized = cleanText(style).normalize('NFKC');
    const normalizedUpper = normalized.toUpperCase();

    for (const token of CATALOG_SIZE_TOKENS) {
      if (!normalizedUpper.endsWith(token)) continue;
      const color = cleanText(normalized.slice(0, normalized.length - token.length));
      if (!color) continue;
      return { color, size: normalized.slice(-token.length) };
    }

    return null;
  }

  function analyzeCatalogStyles(styleValues) {
    const styles = uniqueCatalogTokens(
      styleValues.filter((style) => cleanText(style) !== '全部')
    );

    if (!styles.length) {
      return {
        colors: [],
        sizes: [],
        mode: 'single',
        warning: '',
      };
    }

    const normalizedSizeTokens = new Set(
      CATALOG_SIZE_TOKENS.map(normalizeCatalogToken)
    );
    if (
      styles.every((style) =>
        normalizedSizeTokens.has(normalizeCatalogToken(style))
      )
    ) {
      return {
        colors: [],
        sizes: styles,
        mode: 'size-only',
        warning: '',
      };
    }

    const splitStyles = styles.map(splitStyleAndSize);
    if (splitStyles.every(Boolean)) {
      const colors = uniqueCatalogTokens(
        splitStyles.map((entry) => entry.color)
      );
      const sizes = uniqueCatalogTokens(
        splitStyles.map((entry) => entry.size)
      );
      const actualCombinations = new Set(
        splitStyles.map((entry) =>
          normalizeCatalogToken(`${entry.color}${entry.size}`)
        )
      );
      const expectedCombinationCount = colors.length * sizes.length;

      if (
        sizes.length >= 2 &&
        actualCombinations.size === expectedCombinationCount
      ) {
        return {
          colors,
          sizes,
          mode: 'color-size',
          warning: '',
        };
      }

      return {
        colors: styles,
        sizes: [],
        mode: 'raw-style',
        warning:
          '商品樣式看起來含尺寸，但無法驗證為完整的顏色×尺寸組合，已保守地將原樣式放入顏色欄',
      };
    }

    return {
      colors: styles,
      sizes: [],
      mode: 'color-only',
      warning: '',
    };
  }

  function extractCatalogProduct(nameElement, styleValues) {
    const rawProductName = getProductName(nameElement);
    const infoTable = findProductInfoTable(nameElement);
    const code = normalizeCatalogToken(
      readProductInfoValue(infoTable, '關鍵字')
    );
    const saleMethod = cleanText(
      readProductInfoValue(infoTable, '銷售方式')
    );
    const priceText = readProductInfoValue(infoTable, '直購價/起標價');
    const directPurchasePrice =
      saleMethod === '直購' ? parseMoney(priceText) : null;
    const specifications = analyzeCatalogStyles(styleValues);
    const issues = [];

    if (!infoTable) issues.push('找不到商品銷售資料表');
    if (!PRODUCT_CODE_PATTERN.test(code)) {
      issues.push(`商品碼「${code || '空白'}」不是預期的英文字母＋2–3位數字`);
    }
    if (saleMethod !== '直購') {
      issues.push(`銷售方式「${saleMethod || '空白'}」不是直購，不擷取起標價`);
    } else if (
      !Number.isSafeInteger(directPurchasePrice) ||
      directPurchasePrice <= 0
    ) {
      issues.push(`直購價「${priceText || '空白'}」必須大於 0`);
    }
    if (specifications.warning) issues.push(specifications.warning);

    return {
      code,
      name: cleanCatalogProductName(rawProductName, code),
      colors: specifications.colors,
      sizes: specifications.sizes,
      price: directPurchasePrice,
      rawProductName,
      saleMethod,
      styleMode: specifications.mode,
      issues,
    };
  }

  function extractInventoryPrices(nameElement, catalogProduct) {
    const costText = readProductInfoValue(
      findProductInfoTable(nameElement),
      '成本'
    );
    const cost = parseMoney(costText);
    const directPurchasePrice =
      Number.isSafeInteger(catalogProduct.price) && catalogProduct.price > 0
        ? catalogProduct.price
        : null;

    return {
      cost,
      directPurchasePrice,
      costIssue:
        cost === null
          ? `成本價「${costText || '空白'}」必須是 0 以上整數`
          : '',
      priceIssue:
        catalogProduct.saleMethod !== '直購'
          ? `銷售方式「${catalogProduct.saleMethod || '空白'}」不是直購，不擷取起標價`
          : directPurchasePrice === null
            ? '直購價缺少有效的大於 0 整數，請確認商品銷售資料'
            : '',
    };
  }

  const getDirectCells = (row, tagName) =>
    Array.from(row.children).filter((element) => element.tagName === tagName);

  function getProductProgress() {
    const loaded = getProductNames().length;
    const progressElement = Array.from(
      document.querySelectorAll('div, span, p')
    ).find((element) =>
      /^總數\s*\d+\s*\/\s*\d+$/.test(cleanText(element.textContent))
    );
    const match = cleanText(progressElement?.textContent).match(
      /^總數\s*(\d+)\s*\/\s*(\d+)$/
    );

    return {
      loaded,
      reportedLoaded: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null,
    };
  }

  function findLoadMoreButton() {
    return (
      Array.from(document.querySelectorAll('button')).find(
        (button) =>
          !button.closest(`#${PANEL_ID}`) &&
          cleanText(button.textContent).startsWith(LOAD_MORE_LABEL)
      ) ?? null
    );
  }

  function isAllProductsLoaded() {
    const progress = getProductProgress();
    if (progress.total !== null &&
        (progress.loaded !== progress.total || progress.reportedLoaded !== progress.total)) return false;
    if (getModernTable()) {
      const marker = document.querySelector('#commodity-app .jb-table-scroll__foot');
      return progress.total !== null && !findLoadMoreButton() &&
        cleanText(marker?.textContent).includes('載入完成');
    }
    return Array.from(document.querySelectorAll('.loading-indicator')).some(
      (indicator) => cleanText(indicator.textContent).includes('載入完成')
    );
  }

  async function waitForLoadState(timeout = 30000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const progress = getProductProgress();
      const loadMoreButton = findLoadMoreButton();

      showStatus(
        `等待商品資料：${progress.loaded}${
          progress.total === null ? '' : `/${progress.total}`
        }`
      );

      if (loadMoreButton && !loadMoreButton.disabled) {
        return { type: 'more', button: loadMoreButton, progress };
      }

      if (isAllProductsLoaded()) {
        await delay(500);

        const confirmedButton = findLoadMoreButton();
        const confirmedProgress = getProductProgress();
        if (confirmedButton && !confirmedButton.disabled) continue;

        if (
          isAllProductsLoaded() &&
          confirmedProgress.loaded === progress.loaded
        ) {
          return { type: 'complete', button: null, progress: confirmedProgress };
        }
      }

      await delay(250);
    }

    throw new Error('等待 Jambo 商品資料完成逾時');
  }

  async function waitForBatchLoad(previousCount, timeout = 30000) {
    const startedAt = Date.now();
    let didIncrease = false;
    let lastCount = previousCount;
    let stableSince = Date.now();

    while (Date.now() - startedAt < timeout) {
      const progress = getProductProgress();
      if (progress.loaded !== lastCount) {
        lastCount = progress.loaded;
        stableSince = Date.now();
      }
      if (progress.loaded > previousCount) didIncrease = true;

      showStatus(
        `載入商品中：${progress.loaded}${
          progress.total === null ? '' : `/${progress.total}`
        }`
      );

      const loadMoreButton = findLoadMoreButton();
      if (
        didIncrease &&
        Date.now() - stableSince >= 750 &&
        ((loadMoreButton && !loadMoreButton.disabled) || isAllProductsLoaded())
      ) {
        return;
      }

      await delay(250);
    }

    throw new Error('等待下一批商品載入逾時');
  }

  async function loadAllProducts() {
    const maximumLoads = 100;
    let loadCount = 0;

    for (let attempt = 0; attempt < maximumLoads; attempt += 1) {
      const state = await waitForLoadState();
      if (state.type === 'complete') break;

      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'auto',
      });
      await delay(300);

      const loadMoreButton = findLoadMoreButton();
      if (!loadMoreButton || loadMoreButton.disabled) continue;

      loadMoreButton.scrollIntoView({ block: 'center', behavior: 'auto' });
      loadMoreButton.click();
      loadCount += 1;
      await waitForBatchLoad(state.progress.loaded);
    }

    const progress = getProductProgress();
    if (!isAllProductsLoaded()) {
      throw new Error('商品載入尚未完成');
    }

    if (progress.total !== null && progress.loaded !== progress.total) {
      throw new Error(`商品尚未全部載入（${progress.loaded}/${progress.total}）`);
    }

    if (getModernTable()) {
      const ids = getProductNames().map((name) => cleanText(
        getModernProductRow(name)?.querySelector('[data-jb-cell="head"]')?.textContent
      ));
      if (ids.some((id) => !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error('商品序號缺漏或重複，請重新搜尋後再試');
      }
    }
    return { ...progress, loadCount };
  }

  function isInventoryExpanded(icon) {
    const transform = window.getComputedStyle(icon).transform;
    if (!transform || transform === 'none') return false;

    try {
      const matrix = new DOMMatrixReadOnly(transform);
      return matrix.a < 0 && matrix.d < 0;
    } catch {
      return transform.startsWith('matrix(-1');
    }
  }

  function getCollapsedInventoryControls() {
    return getProductNames()
      .map((nameElement) => {
        const icon = nameElement.parentElement?.querySelector(
          'svg[data-testid="ExpandCircleDownIcon"]'
        );

        if (!icon || isInventoryExpanded(icon)) return null;
        return icon.parentElement;
      })
      .filter(Boolean);
  }

  async function waitForCollapsedCountToDrop(previousCount, timeout = 2000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      await delay(50);
      if (getCollapsedInventoryControls().length < previousCount) return true;
    }

    return false;
  }

  function getModernInventoryExpandButton(nameElement) {
    const stockCell = getModernProductRow(nameElement)?.querySelector(':scope > [data-label="總庫存/樣式"]');
    // Limit clicks to the stock cell's own expand button; never use product actions.
    const buttons = Array.from(stockCell?.querySelectorAll(':scope > button') || [])
      .filter((button) => cleanText(button.textContent) === '展開');
    if (buttons.length > 1) throw new Error(`商品「${getProductName(nameElement)}」展開按鈕不唯一，已停止`);
    return buttons[0] || null;
  }

  function findModernProductName(id) {
    const matches = getProductNames().filter((name) =>
      cleanText(getModernProductRow(name)?.querySelector(':scope > [data-jb-cell="head"]')?.textContent) === id
    );
    if (matches.length > 1) throw new Error(`商品序號 ${id} 重複，請重新搜尋後再試`);
    return matches[0] || null;
  }

  async function waitForModernInventory(product, timeout = 5000) {
    const startedAt = Date.now();
    let lastError;
    do {
      // React may replace a row after expanding it. Resolve by product ID each time.
      const name = findModernProductName(product.id);
      if (name) {
        if (getProductName(name) !== product.name ||
            cleanText(name.querySelector('.jb-caption')?.textContent) !== product.styleCaption) {
          throw new Error('展開期間商品名稱或樣式數已變動，請重新搜尋後再試');
        }
        try {
          readModernStockRows(name);
          if (!getModernInventoryExpandButton(name)) return;
        } catch (error) {
          if (error?.code !== 'INCOMPLETE_STYLES') throw error;
          lastError = error;
        }
      }
      await delay(50);
    } while (Date.now() - startedAt < timeout);
    throw new Error(`商品「${product.name}」展開後仍未完成：${lastError?.message || '請確認商品仍在目前清單，稍後重新按「載入＋展開全部」'}`);
  }

  async function expandModernProducts() {
    const products = getProductNames().map((name) => ({
      id: cleanText(getModernProductRow(name)?.querySelector(':scope > [data-jb-cell="head"]')?.textContent),
      name: getProductName(name),
      styleCaption: cleanText(name.querySelector('.jb-caption')?.textContent),
    }));
    if (products.some((product) => !/^\d+$/.test(product.id)) ||
        new Set(products.map((product) => product.id)).size !== products.length) {
      throw new Error('商品序號缺漏或重複，請重新搜尋後再試');
    }
    let expandedCount = 0;
    for (const [index, product] of products.entries()) {
      const name = findModernProductName(product.id);
      if (!name || getProductName(name) !== product.name ||
          cleanText(name.querySelector('.jb-caption')?.textContent) !== product.styleCaption) {
        throw new Error('展開期間商品清單已變動，請重新搜尋後再試');
      }
      const button = getModernInventoryExpandButton(name);
      if (button) {
        if (button.disabled) throw new Error(`商品「${product.name}」展開按鈕尚未可用，請稍後重試`);
        dock?.setBadge({running:true,done:index+1,total:products.length});
        showStatus(`展開商品款式中：${index + 1}/${products.length}`);
        button.click();
        await waitForModernInventory(product);
        expandedCount += 1;
      } else {
        readModernStockRows(name);
      }
    }
    const current = getProductNames();
    if (current.length !== products.length) throw new Error('展開期間商品清單已變動，請重新搜尋後再試');
    for (const product of products) {
      const name = findModernProductName(product.id);
      if (!name || getProductName(name) !== product.name ||
          cleanText(name.querySelector('.jb-caption')?.textContent) !== product.styleCaption) {
        throw new Error('展開期間商品清單已變動，請重新搜尋後再試');
      }
      readModernStockRows(name);
    }
    return { expandedCount, expandableCount: expandedCount };
  }

  async function expandAllProducts() {
    if (getModernTable()) return expandModernProducts();
    const initialCount = getCollapsedInventoryControls().length;
    let expandedCount = 0;

    while (expandedCount < initialCount) {
      const controls = getCollapsedInventoryControls();
      if (controls.length === 0) break;

      const control = controls[0];
      if (!control?.isConnected) {
        await delay(50);
        continue;
      }

      control.click();
      const didExpand = await waitForCollapsedCountToDrop(controls.length);
      if (!didExpand) break;

      expandedCount += 1;
      dock?.setBadge({running:true,done:expandedCount,total:initialCount});
      showStatus(`展開商品中：${expandedCount}/${initialCount}`);
    }

    const remaining = getCollapsedInventoryControls().length;
    if (remaining > 0) {
      throw new Error(`仍有 ${remaining} 個商品無法展開`);
    }

    return {
      expandedCount,
      expandableCount: initialCount,
    };
  }

  function setPanelBusy(isBusy) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    dock?.setBadge({running:isBusy,start:isBusy});
    for (const button of panel.querySelectorAll('button:not([data-dock-collapse])')) {
      button.disabled = isBusy;
      button.style.opacity = isBusy ? '0.65' : '1';
      button.style.cursor = isBusy ? 'wait' : 'pointer';
    }
  }

  async function loadAndExpandAll() {
    setPanelBusy(true);

    try {
      const loadResult = await loadAllProducts();
      const expandResult = await expandAllProducts();

      dock?.setBadge({outcome:"complete"});
      const detail = getModernTable()
        ? `展開 ${expandResult.expandedCount} 個，款式明細已確認`
        : `展開 ${expandResult.expandedCount} 個`;
      showStatus(
        `準備完成：${loadResult.loaded} 個商品，${detail}`
      );
    } catch (error) {
      console.error('[Jambo 商品庫存] 載入或展開失敗', error);
      showStatus(`準備失敗：${cleanText(error?.message || error)}`, true);
    } finally {
      setPanelBusy(false);
    }
  }

  function findInventoryTable(nameElement) {
    const productContainer = nameElement.parentElement;
    if (!productContainer) return null;

    return (
      Array.from(productContainer.querySelectorAll(':scope > table')).find(
        (table) => {
          const headers = Array.from(table.querySelectorAll('th')).map((th) =>
            cleanText(th.textContent)
          );

          return headers.includes('樣式') && headers.includes('總庫存');
        }
      ) ?? null
    );
  }

  function getProductImageUrl(nameElement) {
    const productRow = nameElement.closest('tr');
    const image = getModernProductRow(nameElement)
      ? productRow.querySelector('[data-jb-cell="title"] img')
      : productRow?.querySelector('img.photo');
    return image?.getAttribute('data-jb-zoom') || image?.currentSrc || image?.src || '';
  }

  function readCountText(element, name) {
    const value = cleanText(element?.textContent);
    if (!/^(?:[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)|XX)$/iu.test(value)) {
      throw new Error(`商品「${name}」庫存或已喊標數值無法辨識：${value || '空白'}`);
    }
    return value;
  }

  // 新版「總庫存/樣式」欄只有庫存；已喊標改在「銷售狀況」欄，要切換樣式下拉選單才看得到各樣式。
  function readModernStockRows(nameElement) {
    const row = getModernProductRow(nameElement);
    const name = getProductName(nameElement);
    const stockCell = row?.querySelector(':scope > [data-label="總庫存/樣式"]');
    if (!stockCell) throw new Error(`商品「${name}」缺少總庫存/樣式欄位；請在清單設定顯示這個欄位`);
    const totalStock = readCountText(stockCell.querySelector(':scope > .jb-rowcols > .jb-cell-total .jb-rowcols__num'), name);
    const stockLines = Array.from(stockCell.querySelectorAll(':scope > .jb-rowcols > .jb-rowlines > div'));
    const caption = cleanText(nameElement.querySelector('.jb-caption')?.textContent);
    const expected = caption.match(/^(\d+)\s*個樣式$/u);
    if (caption && !expected) throw new Error(`商品「${name}」樣式數量標示無法辨識：${caption}`);
    const expectedCount = expected ? Number(expected[1]) : 0;
    if (stockLines.length !== expectedCount) {
      const error = new Error(`商品「${name}」款式明細不完整（應有 ${expectedCount} 個，庫存 ${stockLines.length} 個），請重新按「載入＋展開全部」`);
      error.code = 'INCOMPLETE_STYLES';
      throw error;
    }
    const rows = [['全部', totalStock]];
    const styles = new Set();
    for (const line of stockLines) {
      const style = cleanText(line.querySelector(':scope > [title]')?.textContent);
      if (!style || style === '全部' || styles.has(style)) throw new Error(`商品「${name}」樣式名稱缺漏或重複`);
      styles.add(style);
      rows.push([style, readCountText(line.lastElementChild, name)]);
    }
    return rows;
  }

  function readModernInventoryRows(nameElement, calledCounts) {
    const name = getProductName(nameElement);
    const id = cleanText(getModernProductRow(nameElement)?.querySelector(':scope > [data-jb-cell="head"]')?.textContent);
    const counts = calledCounts.get(id);
    return readModernStockRows(nameElement).map(([style, stock]) => {
      if (!counts?.has(style)) throw new Error(`商品「${name}」樣式「${style}」的已喊標尚未讀取，請重新下載`);
      return [style, stock, counts.get(style)];
    });
  }

  function getModernSalesCell(nameElement) {
    const cell = getModernProductRow(nameElement)?.querySelector(':scope > [data-jb-col="sales"]');
    if (!cell) throw new Error(`商品「${getProductName(nameElement)}」缺少銷售狀況欄位；請在清單設定顯示這個欄位`);
    return cell;
  }

  function getModernSalesStyleSelect(nameElement) {
    const selects = getModernSalesCell(nameElement).querySelectorAll('select[aria-label="樣式"]');
    if (selects.length !== 1) throw new Error(`商品「${getProductName(nameElement)}」銷售狀況的樣式選單不唯一，已停止`);
    return selects[0];
  }

  function readModernCalledValue(nameElement) {
    const name = getProductName(nameElement);
    const values = Array.from(getModernSalesCell(nameElement).querySelectorAll('dl .jb-kv'))
      .filter((kv) => cleanText(kv.querySelector('dt')?.textContent) === '已喊標');
    if (values.length !== 1) throw new Error(`商品「${name}」找不到唯一的已喊標數字`);
    return readCountText(values[0].querySelector('dd'), name);
  }

  async function selectModernSalesStyle(product, value, label, timeout = 3000) {
    let name = findModernProductName(product.id);
    if (!name) throw new Error('讀取已喊標期間商品清單已變動，請重新搜尋後再試');
    const select = getModernSalesStyleSelect(name);
    // React 控制的 select：要用原生 setter 改值再送 change，React 才會更新「已喊標」數字。
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const startedAt = Date.now();
    do {
      await delay(0);
      name = findModernProductName(product.id);
      const current = name && getModernSalesStyleSelect(name);
      const shown = cleanText(current?.closest('.jb-select')?.querySelector('.jb-select__value')?.textContent);
      if (current?.value === value && shown === label) {
        await delay(0);
        return findModernProductName(product.id);
      }
    } while (Date.now() - startedAt < timeout);
    throw new Error(`商品「${product.name}」切換到樣式「${label}」逾時，請重新下載`);
  }

  async function readModernCalledCounts() {
    const products = getProductNames().map((name) => ({
      id: cleanText(getModernProductRow(name)?.querySelector(':scope > [data-jb-cell="head"]')?.textContent),
      name: getProductName(name),
    }));
    const isPlainNumber = (value) => /^\d+$/u.test(value.replaceAll(',', ''));
    const calledCounts = new Map();

    for (const [index, product] of products.entries()) {
      dock?.setBadge({running:true,done:index+1,total:products.length});
      showStatus(`讀取已喊標：${index + 1}/${products.length}`);
      let name = findModernProductName(product.id);
      if (!name || getProductName(name) !== product.name) {
        throw new Error('讀取已喊標期間商品清單已變動，請重新搜尋後再試');
      }
      const stockStyles = readModernStockRows(name).slice(1).map(([style]) => style);
      const options = Array.from(getModernSalesStyleSelect(name).options).map((option) => ({
        value: option.value,
        label: cleanText(option.textContent),
      }));
      const [allOption, ...styleOptions] = options;
      if (allOption?.value !== '' || allOption?.label !== '全部') {
        throw new Error(`商品「${product.name}」銷售狀況的樣式選單第一項不是「全部」`);
      }
      const optionLabels = new Set(styleOptions.map((option) => option.label));
      if (optionLabels.size !== styleOptions.length || optionLabels.size !== stockStyles.length ||
          stockStyles.some((style) => !optionLabels.has(style))) {
        throw new Error(`商品「${product.name}」銷售狀況的樣式和庫存樣式對不上，已停止`);
      }

      if (getModernSalesStyleSelect(name).value !== '') {
        name = await selectModernSalesStyle(product, '', '全部');
      }
      const counts = new Map([['全部', readModernCalledValue(name)]]);
      if (counts.get('全部') === '0') {
        // 總數是 0 就不用逐一切換樣式。
        for (const style of stockStyles) counts.set(style, '0');
      } else {
        try {
          for (const option of styleOptions) {
            name = await selectModernSalesStyle(product, option.value, option.label);
            counts.set(option.label, readModernCalledValue(name));
          }
        } finally {
          await selectModernSalesStyle(product, '', '全部');
        }
        const values = [...counts.values()];
        if (values.every(isPlainNumber)) {
          const sum = values.slice(1).reduce((total, value) => total + Number(value.replaceAll(',', '')), 0);
          if (sum !== Number(values[0].replaceAll(',', ''))) {
            throw new Error(`商品「${product.name}」各樣式已喊標加總 ${sum} 和總數 ${values[0]} 不同，請重新下載`);
          }
        }
      }
      calledCounts.set(product.id, counts);
    }
    return calledCounts;
  }

  function extractInventory(calledCounts = new Map()) {
    const outputRows = [];
    const productGroups = [];
    const catalogProducts = [];
    const skippedProducts = [];
    const productNames = getProductNames();

    for (const nameElement of productNames) {
      const productName = getProductName(nameElement);
      const modernRow = getModernProductRow(nameElement);
      const inventoryTable = findInventoryTable(nameElement);

      const dataRows = modernRow ? readModernInventoryRows(nameElement, calledCounts) : inventoryTable
        ? Array.from(inventoryTable.querySelectorAll('tbody tr'))
            .map((row) =>
              getDirectCells(row, 'TD').map((cell) =>
                cleanText(cell.textContent)
              )
            )
            .filter((cells) => cells.length >= 2)
        : [];
      const styleRows = dataRows.filter((cells) => cells[0] !== '全部');
      const totalRow = dataRows.find((cells) => cells[0] === '全部');
      const catalogProduct = extractCatalogProduct(
        nameElement,
        styleRows.map((cells) => cells[0])
      );
      catalogProducts.push(catalogProduct);

      if (!modernRow && !inventoryTable) {
        skippedProducts.push(productName || '(未命名商品)');
        continue;
      }
      const productRows = [];

      if (totalRow) {
        const outputRow = [
          productName,
          '全部',
          parseStock(totalRow[1]),
          parseStock(totalRow[2]),
        ];
        outputRows.push(outputRow);
        productRows.push(outputRow);
      }

      for (const cells of styleRows) {
        const outputRow = [
          productName,
          cells[0],
          parseStock(cells[1]),
          parseStock(cells[2]),
        ];
        outputRows.push(outputRow);
        productRows.push(outputRow);
      }

      if (productRows.length === 0) {
        skippedProducts.push(productName || '(未命名商品)');
      }

      if (productRows.length > 0) {
        productGroups.push({
          productName,
          imageUrl: getProductImageUrl(nameElement),
          prices: extractInventoryPrices(nameElement, catalogProduct),
          rows: productRows,
        });
      }
    }

    const productsByCode = new Map();
    for (const product of catalogProducts) {
      if (!product.code) continue;
      if (!productsByCode.has(product.code)) {
        productsByCode.set(product.code, []);
      }
      productsByCode.get(product.code).push(product);
    }
    for (const [code, products] of productsByCode.entries()) {
      if (products.length < 2) continue;
      for (const product of products) {
        product.issues.push(`商品碼 ${code} 在本頁重複 ${products.length} 次`);
      }
    }

    return {
      outputRows,
      productGroups,
      catalogProducts,
      productCount: productNames.length,
      skippedProducts,
    };
  }

  function getCurrentFilters() {
    const statusSelect = document.querySelector(
      'select[aria-label="商品與狀態查詢"]'
    );
    const status =
      cleanText(statusSelect?.selectedOptions?.[0]?.textContent) || '商品';
    const category =
      cleanText(
        document.querySelector('input[placeholder="選擇類別"]')?.value
      ) || '全部類別';

    return { status, category };
  }

  function safeFilenamePart(value) {
    return cleanText(value).replace(/[\\/:*?"<>|]/g, '_');
  }

  function buildFilename(extension = 'xlsx') {
    const { status, category } = getCurrentFilters();
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');

    return `${date}_${safeFilenamePart(status)}_${safeFilenamePart(
      category
    )}_商品庫存.${extension}`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showStatus(message, isError = false) {
    const statusElement = document.querySelector(
      `#${PANEL_ID} [data-role="status"]`
    );
    if (!statusElement) return;

    dock?.status(isError);
    statusElement.textContent = message;
    statusElement.style.color = isError ? '#b42318' : '#067647';
  }

  function collectOrWarn(calledCounts) {
    const result = extractInventory(calledCounts);
    if (result.outputRows.length === 0) {
      showStatus(
        '沒有找到商品資料；請等頁面顯示「載入完成」後再試。',
        true
      );
      return null;
    }

    return result;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      chunks.push(
        String.fromCharCode(...bytes.subarray(index, index + chunkSize))
      );
    }

    return window.btoa(chunks.join(''));
  }

  function getImageFormat(url, responseHeaders = '') {
    const contentType =
      responseHeaders.match(/^content-type:\s*([^;\r\n]+)/im)?.[1] || '';
    const pathname = new URL(url, window.location.href).pathname.toLowerCase();

    if (contentType.includes('png') || pathname.endsWith('.png')) {
      return { extension: 'png', mimeType: 'image/png' };
    }
    if (contentType.includes('gif') || pathname.endsWith('.gif')) {
      return { extension: 'gif', mimeType: 'image/gif' };
    }
    if (
      contentType.includes('jpeg') ||
      contentType.includes('jpg') ||
      /\.jpe?g$/.test(pathname)
    ) {
      return { extension: 'jpeg', mimeType: 'image/jpeg' };
    }

    throw new Error('不支援的商品圖片格式');
  }

  function downloadProductImage(url) {
    if (!url) return Promise.resolve(null);
    if (typeof GM_xmlhttpRequest !== 'function') {
      return Promise.reject(new Error('商品圖片下載權限未載入'));
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 30000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`圖片下載失敗（HTTP ${response.status}）`));
            return;
          }

          try {
            const { extension, mimeType } = getImageFormat(
              url,
              response.responseHeaders
            );
            resolve({
              extension,
              dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(
                response.response
              )}`,
            });
          } catch (error) {
            reject(error);
          }
        },
        onerror() {
          reject(new Error('商品圖片下載失敗'));
        },
        ontimeout() {
          reject(new Error('商品圖片下載逾時'));
        },
      });
    });
  }

  async function downloadProductImages(productGroups) {
    const results = new Array(productGroups.length).fill(null);
    const cache = new Map();
    const workerCount = Math.min(4, Math.max(1, productGroups.length));
    let nextIndex = 0;
    let completedCount = 0;
    let failedCount = 0;

    async function worker() {
      while (nextIndex < productGroups.length) {
        const index = nextIndex;
        nextIndex += 1;
        const imageUrl = productGroups[index].imageUrl;

        try {
          if (imageUrl) {
            if (!cache.has(imageUrl)) {
              cache.set(imageUrl, downloadProductImage(imageUrl));
            }
            results[index] = await cache.get(imageUrl);
          } else {
            failedCount += 1;
          }
        } catch (error) {
          failedCount += 1;
          console.warn(
            `[Jambo 商品庫存] 圖片下載失敗：${productGroups[index].productName}`,
            error
          );
        } finally {
          completedCount += 1;
          showStatus(
            `下載商品圖片：${completedCount}/${productGroups.length}`
          );
        }
      }
    }

    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );

    return { images: results, failedCount };
  }

  function toExcelNumber(value) {
    if (value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function buildCatalogWorksheet(workbook, catalogProducts) {
    const worksheet = workbook.addWorksheet('五欄商品清單', {
      views: [
        {
          state: 'frozen',
          ySplit: 1,
          showGridLines: false,
        },
      ],
    });

    worksheet.columns = [
      { header: '商品碼', key: 'code', width: 14 },
      { header: '品名', key: 'name', width: 52 },
      { header: '顏色', key: 'colors', width: 28 },
      { header: '尺寸', key: 'sizes', width: 20 },
      { header: '價格', key: 'price', width: 14 },
    ];
    worksheet.properties.defaultRowHeight = 24;

    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1D4ED8' },
      };
      cell.font = {
        name: 'Microsoft JhengHei',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
      };
      cell.border = {
        bottom: {
          style: 'medium',
          color: { argb: 'FF1E40AF' },
        },
      };
    });

    let issueCount = 0;
    for (const product of catalogProducts) {
      const hasIssues = product.issues.length > 0;
      if (hasIssues) issueCount += 1;

      const row = worksheet.addRow({
        code: product.code,
        name: product.name,
        colors: product.colors.join('、'),
        sizes: product.sizes.join('、'),
        price: Number.isSafeInteger(product.price) ? product.price : null,
      });
      row.height = 24;

      for (let columnIndex = 1; columnIndex <= 5; columnIndex += 1) {
        const cell = row.getCell(columnIndex);
        cell.font = {
          name: 'Microsoft JhengHei',
          size: 11,
          color: { argb: hasIssues ? 'FF991B1B' : 'FF1F2937' },
        };
        cell.alignment = {
          horizontal: columnIndex === 2 ? 'left' : 'center',
          vertical: 'middle',
          wrapText: true,
        };
        cell.border = {
          bottom: {
            style: 'thin',
            color: { argb: 'FFE5E7EB' },
          },
        };
        if (hasIssues) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE4E6' },
          };
        }
      }

      if (hasIssues) {
        row.getCell(1).note = [
          '此商品需確認：',
          ...product.issues.map((issue) => `• ${issue}`),
        ].join('\n');
      }
    }

    worksheet.getColumn('price').numFmt = '$#,##0';
    worksheet.autoFilter = {
      from: 'A1',
      to: `E${Math.max(1, worksheet.rowCount)}`,
    };

    return {
      productCount: catalogProducts.length,
      issueCount,
    };
  }

  async function buildXlsx(result) {
    if (typeof ExcelJS === 'undefined') {
      throw new Error('Excel 元件未載入，請重新整理頁面後再試');
    }

    const imageResult = await downloadProductImages(result.productGroups);
    showStatus('建立 XLSX 檔案中...');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Jambo 商品庫存與五欄商品清單匯出';
    workbook.created = new Date();
    workbook.modified = new Date();

    const worksheet = workbook.addWorksheet('商品庫存', {
      views: [
        {
          state: 'frozen',
          ySplit: 1,
          showGridLines: false,
        },
      ],
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });

    worksheet.columns = [
      {
        header: '商品圖片',
        key: 'image',
        width: XLSX_IMAGE_COLUMN_WIDTH,
      },
      { header: '商品名稱', key: 'name', width: 48 },
      { header: '商品樣式', key: 'style', width: 16 },
      { header: '商品總庫存', key: 'stock', width: 14 },
      { header: '已喊標數量', key: 'called', width: 14 },
      { header: '成本價', key: 'cost', width: 14 },
      { header: '直購價', key: 'directPurchasePrice', width: 14 },
    ];
    const inventoryColumnCount = worksheet.columns.length;
    worksheet.properties.defaultRowHeight = 22.5;

    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF067647' },
      };
      cell.font = {
        name: 'Microsoft JhengHei',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
      };
      cell.border = {
        bottom: {
          style: 'medium',
          color: { argb: 'FF047857' },
        },
      };
    });

    let inventoryPriceIssueCount = 0;
    for (
      let groupIndex = 0;
      groupIndex < result.productGroups.length;
      groupIndex += 1
    ) {
      const group = result.productGroups[groupIndex];
      if (group.prices.costIssue || group.prices.priceIssue) {
        inventoryPriceIssueCount += 1;
      }
      const image = imageResult.images[groupIndex];
      const startRow = worksheet.rowCount + 1;
      const totalHeight = Math.max(
        XLSX_IMAGE_HEIGHT_POINTS,
        group.rows.length * 22.5
      );
      const rowHeight = totalHeight / group.rows.length;

      for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex += 1) {
        const values = group.rows[rowIndex];
        const isTotalRow = values[1] === '全部';
        const row = worksheet.addRow({
          image: rowIndex === 0 && !image ? '無圖片' : '',
          name: rowIndex === 0 ? group.productName : '',
          style: values[1],
          stock: toExcelNumber(values[2]),
          called: toExcelNumber(values[3]),
          cost: rowIndex === 0 ? group.prices.cost : null,
          directPurchasePrice:
            rowIndex === 0 ? group.prices.directPurchasePrice : null,
        });
        row.height = rowHeight;

        for (
          let columnIndex = 1;
          columnIndex <= inventoryColumnCount;
          columnIndex += 1
        ) {
          const cell = row.getCell(columnIndex);
          cell.font = {
            name: 'Microsoft JhengHei',
            size: 11,
            bold: isTotalRow,
            color: { argb: 'FF1F2937' },
          };
          cell.alignment = {
            horizontal:
              columnIndex === 1 || columnIndex >= 3 ? 'center' : 'left',
            vertical: 'middle',
            wrapText: columnIndex === 2,
          };
          cell.border = {
            bottom: {
              style: 'thin',
              color: { argb: 'FFE5E7EB' },
            },
          };

          if (isTotalRow && columnIndex >= 3) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFFF1F2' },
            };
          } else if (groupIndex % 2 === 1) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF8FAFC' },
            };
          }
        }
      }

      const endRow = worksheet.rowCount;
      if (endRow > startRow) {
        worksheet.mergeCells(startRow, 1, endRow, 1);
        worksheet.mergeCells(startRow, 2, endRow, 2);
        worksheet.mergeCells(startRow, 6, endRow, 6);
        worksheet.mergeCells(startRow, 7, endRow, 7);
      }

      const imageCell = worksheet.getCell(startRow, 1);
      const nameCell = worksheet.getCell(startRow, 2);
      imageCell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      nameCell.alignment = {
        horizontal: 'left',
        vertical: 'middle',
        wrapText: true,
      };

      for (
        let columnIndex = 1;
        columnIndex <= inventoryColumnCount;
        columnIndex += 1
      ) {
        worksheet.getCell(endRow, columnIndex).border = {
          bottom: {
            style: 'medium',
            color: { argb: 'FFCBD5E1' },
          },
        };
      }

      for (const [columnIndex, issue] of [
        [6, group.prices.costIssue],
        [7, group.prices.priceIssue],
      ]) {
        if (!issue) continue;
        const cell = worksheet.getCell(startRow, columnIndex);
        cell.note = issue;
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFE4E6' },
        };
        cell.font = { ...cell.font, color: { argb: 'FF991B1B' } };
      }

      if (image) {
        const imageId = workbook.addImage({
          base64: image.dataUrl,
          extension: image.extension,
        });
        worksheet.addImage(imageId, {
          tl: { col: 0.01, row: startRow - 1 + 0.005 },
          ext: {
            width: XLSX_IMAGE_SIZE,
            height: XLSX_IMAGE_SIZE,
          },
          editAs: 'oneCell',
        });
      }
    }

    worksheet.getColumn('stock').numFmt = '#,##0';
    worksheet.getColumn('called').numFmt = '#,##0';
    worksheet.getColumn('cost').numFmt = '$#,##0';
    worksheet.getColumn('directPurchasePrice').numFmt = '$#,##0';
    worksheet.autoFilter = {
      from: 'A1',
      to: `G${Math.max(1, worksheet.rowCount)}`,
    };

    const catalogSummary = buildCatalogWorksheet(
      workbook,
      result.catalogProducts
    );

    const buffer = await workbook.xlsx.writeBuffer();
    return {
      blob: new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      failedImageCount: imageResult.failedCount,
      inventoryPriceIssueCount,
      catalogProductCount: catalogSummary.productCount,
      catalogIssueCount: catalogSummary.issueCount,
    };
  }

  async function downloadXlsxInventory() {
    setPanelBusy(true);

    try {
      const loadResult = await loadAllProducts();
      const expandResult = await expandAllProducts();
      const calledCounts = getModernTable() ? await readModernCalledCounts() : new Map();
      const result = collectOrWarn(calledCounts);
      if (!result) return;

      const xlsx = await buildXlsx(result);
      triggerDownload(xlsx.blob, buildFilename('xlsx'));

      const imageWarning =
        xlsx.failedImageCount > 0
          ? `；${xlsx.failedImageCount} 張圖片未下載`
          : '';
      const catalogWarning =
        xlsx.catalogIssueCount > 0
          ? `；五欄商品清單 ${xlsx.catalogIssueCount} 筆需確認`
          : '';
      const inventoryPriceWarning =
        xlsx.inventoryPriceIssueCount > 0
          ? `；庫存金額 ${xlsx.inventoryPriceIssueCount} 筆需確認`
          : '';
      showStatus(
        `已下載 XLSX：${loadResult.loaded} 個商品、${result.outputRows.length} 筆庫存、${xlsx.catalogProductCount} 筆五欄商品${imageWarning}${catalogWarning}${inventoryPriceWarning}`
      );
      dock?.setBadge({outcome:'complete'});
      console.log(
        '[Jambo 商品庫存] XLSX 完成',
        loadResult,
        expandResult
      );
    } catch (error) {
      console.error('[Jambo 商品庫存] XLSX 匯出失敗', error);
      showStatus(`XLSX 失敗：${cleanText(error?.message || error)}`, true);
    } finally {
      setPanelBusy(false);
    }
  }

  function createButton(label, backgroundColor, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = [
      'border:0',
      'border-radius:8px',
      'padding:9px 12px',
      'font-size:14px',
      'font-weight:700',
      'cursor:pointer',
      'color:#fff',
      `background:${backgroundColor}`,
    ].join(';');
    button.addEventListener('click', onClick);
    return button;
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:56px',
      'visibility:hidden',
      'z-index:2147483646',
      'width:250px',
      'padding:12px',
      'border:1px solid #d0d5dd',
      'border-radius:12px',
      'background:#fff',
      'box-shadow:0 8px 24px rgba(16,24,40,.18)',
      'font-family:Arial,"Microsoft JhengHei",sans-serif',
    ].join(';');

    const titleBar = document.createElement('div');
    titleBar.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:8px';

    const title = document.createElement('div');
    title.textContent = 'Jambo 商品庫存';
    title.style.cssText =
      'font-size:15px;font-weight:800;color:#101828;white-space:nowrap';

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.textContent = '+';
    toggleButton.title = '展開面板';
    toggleButton.setAttribute('aria-label', '展開商品庫存面板');
    toggleButton.setAttribute('aria-expanded', 'false');
    toggleButton.style.cssText = [
      'width:26px',
      'height:24px',
      'padding:0',
      'border:1px solid #d0d5dd',
      'border-radius:7px',
      'background:#fff',
      'color:#475467',
      'font-size:18px',
      'font-weight:800',
      'line-height:20px',
      'cursor:pointer',
      'flex:0 0 auto',
    ].join(';');
    titleBar.append(title, toggleButton);

    const body = document.createElement('div');
    body.style.marginTop = '9px';
    body.style.display = 'block';

    const prepareButton = createButton(
      '載入＋展開全部',
      '#067647',
      loadAndExpandAll
    );
    prepareButton.id = PREPARE_BUTTON_ID;
    prepareButton.style.cssText +=
      ';display:block;width:100%;margin-bottom:8px';

    const xlsxButton = createButton(
      '下載 XLSX（庫存＋五欄）',
      '#0f766e',
      downloadXlsxInventory
    );
    xlsxButton.style.cssText +=
      ';display:block;width:100%';

    const status = document.createElement('div');
    status.dataset.role = 'status';
    status.textContent = '匯出庫存、商品圖與五欄商品清單';
    status.style.cssText =
      'margin-top:8px;font-size:12px;line-height:1.45;color:#475467';

    body.append(prepareButton, xlsxButton, status);
    panel.append(titleBar, body);
    panel.dataset.collapsed = '0';
    toggleButton.dataset.dockCollapse='1';
    let clampPanelPosition = () => {};

    document.body.appendChild(panel);
    dock=createEthanToolDock({id:"jambo-stock",label:"庫存",name:"Jambo 商品庫存",version:"2.1.6",order:20,colour:"#1d4ed8",panel,collapse:toggleButton});
    clampPanelPosition = makePanelDraggable(
      panel,
      titleBar,
      PANEL_POSITION_STORAGE_KEY
    );
  }

  mountPanel();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) {
      document.querySelector('#ethan-tool-dock-v1 > [data-dock-tool="jambo-stock"]')?.remove();
      dock = null;
      mountPanel();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
