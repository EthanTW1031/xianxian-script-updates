// ==UserScript==
// @name         Jambo 商品圖片批次上傳
// @namespace    https://jambolive.tv/
// @version      1.0.4
// @description  依商品名稱中的代碼配對本機圖片，逐件安全上傳並儲存商品圖片
// @match        https://jambolive.tv/console/commodity/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const PANEL_ID = 'jambo-product-image-uploader';
  const PREVIEW_ID = 'jambo-product-image-preview';
  const PANEL_POSITION_STORAGE_KEY = 'jambo-image-upload-panel-position-v1';
  const CODE_PATTERN = /(?:^|[^A-Z0-9])([A-Z]\d{2,3})(?=$|[^A-Z0-9])/i;
  const EXACT_FILE_CODE_PATTERN = /^([A-Z]\d{2,3})([\u3400-\u9fff]+)?$/i;
  const SUPPORTED_IMAGE_PATTERN = /\.(?:jpe?g|png)$/i;
  const DEFAULT_IMAGE_PATTERN = /(?:default_photo|ic-upload-photo)\.(?:jpg|jpeg|png|svg)/i;
  const LOAD_MORE_LABEL = '載入更多';
  const MAXIMUM_LOADS = 100;
  const EDIT_OPEN_TIMEOUT = 30000;
  const PHOTO_UPLOAD_TIMEOUT = 120000;
  const PRODUCT_SAVE_TIMEOUT = 90000;

  if (document.getElementById(PANEL_ID)) return;

  const state = {
    imageFiles: [],
    imageMap: new Map(),
    imageGroups: new Map(),
    duplicateImageCodes: new Set(),
    completedProductKeys: new Set(),
    scanEntries: [],
    orphanImageCodes: [],
    isBusy: false,
    stopRequested: false,
    alertMessages: [],
    restoreAlert: null,
  };

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
        console.warn('[Jambo 圖片上傳] 無法記住面板位置', error);
      }
    };

    const finishDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      handle.classList.remove('jpi-dragging');
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // 指標可能已經被瀏覽器釋放。
      }
      clampPosition();
      savePosition();
    };

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
      handle.classList.add('jpi-dragging');
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

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);

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
      console.warn('[Jambo 圖片上傳] 無法讀取面板位置', error);
    }

    window.addEventListener('resize', clampPosition);
    window.requestAnimationFrame(clampPosition);
    return clampPosition;
  }

  function extractProductCode(value) {
    const match = cleanText(value).match(CODE_PATTERN);
    return match ? match[1].toUpperCase() : '';
  }

  function parseFileCode(fileName) {
    const baseName = String(fileName ?? '').replace(/\.[^.]+$/, '').trim();
    const match = baseName.match(EXACT_FILE_CODE_PATTERN);
    if (!match) return null;

    const baseCode = match[1].toUpperCase();
    const variant = match[2] || '';
    return {
      key: `${baseCode}${variant}`,
      baseCode,
      variant,
    };
  }

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  function waitUntil(predicate, timeout, errorMessage, interval = 150) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const result = await predicate();
          if (result) {
            resolve(result);
            return;
          }
        } catch (error) {
          reject(error);
          return;
        }

        if (Date.now() - startedAt >= timeout) {
          reject(new Error(errorMessage));
          return;
        }

        window.setTimeout(check, interval);
      };

      check();
    });
  }

  function setStatus(message, isError = false) {
    const status = document.querySelector(`#${PANEL_ID} .jpi-status`);
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('jpi-error', isError);
  }

  function setProgress(completed, total) {
    const bar = document.querySelector(`#${PANEL_ID} .jpi-progress-value`);
    if (!bar) return;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    bar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    panel.querySelectorAll('[data-busy-lock]').forEach((control) => {
      control.disabled = isBusy;
    });

    const stopButton = panel.querySelector('.jpi-stop');
    if (stopButton) stopButton.disabled = !isBusy;
  }

  function getProductProgress() {
    const loaded = document.querySelectorAll('p.name').length;
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
    return Array.from(document.querySelectorAll('.loading-indicator')).some(
      (indicator) => cleanText(indicator.textContent).includes('載入完成')
    );
  }

  async function waitForLoadState(timeout = 30000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const progress = getProductProgress();
      const loadMoreButton = findLoadMoreButton();

      setStatus(
        `等待商品資料：${progress.loaded}${
          progress.total === null ? '' : `/${progress.total}`
        }`
      );

      if (loadMoreButton && !loadMoreButton.disabled) {
        return { type: 'more', progress };
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
          return { type: 'complete', progress: confirmedProgress };
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

      setStatus(
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
    let loadCount = 0;

    for (let attempt = 0; attempt < MAXIMUM_LOADS; attempt += 1) {
      const loadState = await waitForLoadState();
      if (loadState.type === 'complete') break;

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
      await waitForBatchLoad(loadState.progress.loaded);
    }

    const progress = getProductProgress();
    if (!isAllProductsLoaded()) {
      throw new Error('商品載入尚未完成');
    }
    if (progress.total !== null && progress.loaded < progress.total) {
      throw new Error(`商品尚未全部載入（${progress.loaded}/${progress.total}）`);
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
    return Array.from(document.querySelectorAll('p.name'))
      .map((nameElement) => {
        const icon = nameElement.parentElement?.querySelector(
          'svg[data-testid="ExpandCircleDownIcon"]'
        );

        if (!icon || isInventoryExpanded(icon)) return null;
        return icon.parentElement;
      })
      .filter(Boolean);
  }

  async function waitForCollapsedCountToDrop(previousCount, timeout = 3500) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      await delay(75);
      if (getCollapsedInventoryControls().length < previousCount) return true;
    }

    return false;
  }

  async function expandAllProducts() {
    const initialCount = getCollapsedInventoryControls().length;
    let expandedCount = 0;
    let failedAttempts = 0;

    while (true) {
      const controls = getCollapsedInventoryControls();
      if (controls.length === 0) break;

      const control = controls[0];
      if (!control?.isConnected) {
        await delay(100);
        continue;
      }

      control.scrollIntoView({ block: 'center', behavior: 'auto' });
      await delay(75);
      control.click();

      const didExpand = await waitForCollapsedCountToDrop(controls.length);
      if (didExpand) {
        expandedCount += 1;
        failedAttempts = 0;
        setStatus(`展開商品中：${expandedCount}/${initialCount}`);
        continue;
      }

      failedAttempts += 1;
      if (failedAttempts >= 3) break;
      await delay(500);
    }

    const remaining = getCollapsedInventoryControls().length;
    if (remaining > 0) {
      throw new Error(`仍有 ${remaining} 個商品無法展開，已停止圖片上傳`);
    }

    return {
      expandedCount,
      expandableCount: initialCount,
    };
  }

  async function prepareAllProducts() {
    const loadResult = await loadAllProducts();
    const expandResult = await expandAllProducts();
    const confirmedProgress = getProductProgress();
    const remainingCollapsed = getCollapsedInventoryControls().length;

    if (!isAllProductsLoaded()) {
      throw new Error('無法確認所有商品已載入，已停止圖片上傳');
    }
    if (
      confirmedProgress.total !== null &&
      confirmedProgress.loaded < confirmedProgress.total
    ) {
      throw new Error(
        `商品尚未全部載入（${confirmedProgress.loaded}/${confirmedProgress.total}）`
      );
    }
    if (remainingCollapsed > 0) {
      throw new Error(`仍有 ${remainingCollapsed} 個商品尚未展開`);
    }

    return { loadResult, expandResult };
  }

  function getProductRows() {
    return Array.from(document.querySelectorAll('tr'))
      .map((row) => {
        const editButton = row.querySelector(
          'button.icon-edit, button[title="編輯"]'
        );
        const nameElement = row.querySelector('p.name');
        if (!editButton || !nameElement) return null;

        const name = cleanText(nameElement.textContent);
        const code = extractProductCode(name);
        if (!code) return null;

        const productId = Array.from(row.querySelectorAll('p'))
          .map((element) => cleanText(element.textContent))
          .find((text) => /^\d{6,}$/.test(text)) || '';
        const productKey = productId ? `id:${productId}` : `name:${name}`;
        const styleText = Array.from(row.querySelectorAll('table tr'))
          .map((inventoryRow) =>
            Array.from(inventoryRow.children).find(
              (element) => element.tagName === 'TD'
            )
          )
          .filter(Boolean)
          .map((cell) => cleanText(cell.textContent))
          .join(' ');

        const image = row.querySelector('img.photo');
        const imageUrl = image?.currentSrc || image?.src || '';

        return {
          code,
          name,
          productId,
          productKey,
          styleText,
          row,
          imageUrl,
          hasExistingPhoto:
            Boolean(imageUrl) && !DEFAULT_IMAGE_PATTERN.test(imageUrl),
        };
      })
      .filter(Boolean);
  }

  function rebuildImageMap(files) {
    state.imageFiles = [];
    state.imageMap = new Map();
    state.imageGroups = new Map();
    state.duplicateImageCodes = new Set();

    for (const originalFile of files) {
      if (!SUPPORTED_IMAGE_PATTERN.test(originalFile.name)) continue;

      const parsedCode = parseFileCode(originalFile.name);
      if (!parsedCode) continue;

      let file = originalFile;
      if (!file.type) {
        const mimeType = /\.png$/i.test(file.name)
          ? 'image/png'
          : 'image/jpeg';
        file = new File([file], file.name, {
          type: mimeType,
          lastModified: file.lastModified,
        });
      }

      state.imageFiles.push(file);
      if (state.imageMap.has(parsedCode.key)) {
        state.duplicateImageCodes.add(parsedCode.key);
      } else {
        state.imageMap.set(parsedCode.key, file);
        const group = state.imageGroups.get(parsedCode.baseCode) || [];
        group.push({ ...parsedCode, file });
        state.imageGroups.set(parsedCode.baseCode, group);
      }
    }
  }

  function findImageMatch(product, sameCodeProductCount) {
    const candidates = state.imageGroups.get(product.code) || [];
    if (!candidates.length) {
      return { imageFile: null, imageKey: '', reason: 'missing' };
    }

    const variantCandidates = candidates.filter(({ variant }) => variant);
    const upperName = product.name.toUpperCase();
    const titleMatches = variantCandidates.filter(({ key }) =>
      upperName.includes(key.toUpperCase())
    );
    if (titleMatches.length === 1) {
      const match = titleMatches[0];
      return { imageFile: match.file, imageKey: match.key, reason: '' };
    }

    const styleMatches = variantCandidates.filter(({ variant }) =>
      product.styleText.includes(variant)
    );
    if (styleMatches.length === 1) {
      const match = styleMatches[0];
      return { imageFile: match.file, imageKey: match.key, reason: '' };
    }

    const baseCandidate = candidates.find(({ variant }) => !variant);
    if (sameCodeProductCount === 1 && baseCandidate) {
      return {
        imageFile: baseCandidate.file,
        imageKey: baseCandidate.key,
        reason: '',
      };
    }

    if (sameCodeProductCount === 1 && candidates.length === 1) {
      const match = candidates[0];
      return { imageFile: match.file, imageKey: match.key, reason: '' };
    }

    return { imageFile: null, imageKey: '', reason: 'ambiguous' };
  }

  function scanLoadedProducts() {
    const overwriteExisting = Boolean(
      document.querySelector(`#${PANEL_ID} .jpi-overwrite`)?.checked
    );
    const products = getProductRows();
    const productCounts = new Map();

    for (const product of products) {
      productCounts.set(product.code, (productCounts.get(product.code) ?? 0) + 1);
    }

    const matches = products.map((product) => ({
      product,
      match: findImageMatch(product, productCounts.get(product.code) ?? 1),
    }));
    const imageUsageCounts = new Map();
    for (const { match } of matches) {
      if (!match.imageKey) continue;
      imageUsageCounts.set(
        match.imageKey,
        (imageUsageCounts.get(match.imageKey) ?? 0) + 1
      );
    }

    state.scanEntries = matches.map(({ product, match }) => {
      const { imageFile, imageKey } = match;
      const displayCode = imageKey || product.code;
      let status = 'ready';
      let statusLabel = '準備上傳';

      if (state.completedProductKeys.has(product.productKey)) {
        status = 'success';
        statusLabel = '本次已上傳完成';
      } else if (imageKey && (imageUsageCounts.get(imageKey) ?? 0) > 1) {
        status = 'duplicate-product';
        statusLabel = '多件商品配到同一張圖片，已跳過';
      } else if (imageKey && state.duplicateImageCodes.has(imageKey)) {
        status = 'duplicate-image';
        statusLabel = '圖片代碼重複，已跳過';
      } else if (!imageFile) {
        status = 'missing-image';
        statusLabel = match.reason === 'ambiguous'
          ? '同代碼有多張圖片，無法判斷顏色'
          : '找不到對應圖片';
      } else if (product.hasExistingPhoto && !overwriteExisting) {
        status = 'existing-photo';
        statusLabel = '已有商品圖，已跳過';
      }

      return {
        ...product,
        imageFile,
        imageKey,
        displayCode,
        status,
        statusLabel,
        resultMessage: '',
      };
    });

    const matchedImageKeys = new Set(
      matches.map(({ match }) => match.imageKey).filter(Boolean)
    );
    state.orphanImageCodes = Array.from(state.imageMap.keys())
      .filter((code) => !matchedImageKeys.has(code))
      .sort();

    updateSummary();
    renderPreview();
    return state.scanEntries;
  }

  function getSummary() {
    const counts = {
      total: state.scanEntries.length,
      ready: 0,
      success: 0,
      error: 0,
      skipped: 0,
    };

    for (const entry of state.scanEntries) {
      if (entry.status === 'ready') counts.ready += 1;
      else if (entry.status === 'success') counts.success += 1;
      else if (entry.status === 'error') counts.error += 1;
      else counts.skipped += 1;
    }

    return counts;
  }

  function updateSummary() {
    const summary = getSummary();
    const summaryElement = document.querySelector(`#${PANEL_ID} .jpi-summary`);
    if (summaryElement) {
      summaryElement.textContent = state.scanEntries.length
        ? `商品 ${summary.total}｜可上傳 ${summary.ready}｜跳過 ${summary.skipped}`
        : `已選 ${state.imageFiles.length} 張有效圖片`;
    }

    const startButton = document.querySelector(`#${PANEL_ID} .jpi-start`);
    if (startButton) {
      startButton.disabled = state.isBusy || summary.ready === 0;
    }
    const testButton = document.querySelector(`#${PANEL_ID} .jpi-test-one`);
    if (testButton) {
      testButton.disabled = state.isBusy || summary.ready === 0;
    }

    const previewButton = document.querySelector(`#${PANEL_ID} .jpi-preview-button`);
    if (previewButton) previewButton.disabled = state.scanEntries.length === 0;
  }

  function getEntryStatusClass(status) {
    if (status === 'ready') return 'jpi-ready';
    if (status === 'success') return 'jpi-success';
    if (status === 'error') return 'jpi-failed';
    return 'jpi-skipped';
  }

  function renderPreview() {
    const preview = document.getElementById(PREVIEW_ID);
    if (!preview) return;

    const tbody = preview.querySelector('tbody');
    tbody.replaceChildren();

    for (const entry of state.scanEntries) {
      const row = document.createElement('tr');
      row.className = getEntryStatusClass(entry.status);

      const codeCell = document.createElement('td');
      codeCell.textContent = entry.displayCode;

      const nameCell = document.createElement('td');
      nameCell.textContent = entry.name;

      const fileCell = document.createElement('td');
      fileCell.textContent = entry.imageFile?.name || '—';

      const statusCell = document.createElement('td');
      statusCell.textContent = entry.resultMessage || entry.statusLabel;

      row.append(codeCell, nameCell, fileCell, statusCell);
      tbody.append(row);
    }

    const orphan = preview.querySelector('.jpi-orphans');
    orphan.textContent = state.orphanImageCodes.length
      ? `資料夾內尚未找到商品的圖片：${state.orphanImageCodes.join('、')}`
      : '資料夾內沒有多出的圖片代碼。';
  }

  function getEditModal() {
    return document.querySelector(
      '.ReactModal__Content.ReactModal__Content--after-open[role="dialog"]'
    );
  }

  function findProductByKey(productKey) {
    return (
      getProductRows().find((product) => product.productKey === productKey) ?? null
    );
  }

  async function openProductEditor(entry) {
    if (getEditModal()) {
      throw new Error('頁面目前已有商品編輯視窗，請先關閉後再執行');
    }

    const product = findProductByKey(entry.productKey);
    if (!product) {
      throw new Error(`頁面上找不到商品 ${entry.displayCode}`);
    }

    const editButton = product.row.querySelector(
      'button.icon-edit, button[title="編輯"]'
    );
    if (!editButton) {
      throw new Error(`找不到 ${entry.displayCode} 的編輯按鈕`);
    }

    product.row.scrollIntoView({ block: 'center', behavior: 'auto' });
    await delay(150);
    editButton.click();

    const modal = await waitUntil(
      () => {
        const currentModal = getEditModal();
        const nameInput = currentModal?.querySelector('input[name="name"]');
        if (!currentModal || !nameInput) return null;
        return cleanText(nameInput.value) === entry.name
          ? currentModal
          : null;
      },
      EDIT_OPEN_TIMEOUT,
      `等待 ${entry.displayCode} 編輯視窗逾時`
    );

    return modal;
  }

  async function uploadPhotoToModal(modal, entry) {
    const fileInput = modal.querySelector(
      'input[type="file"][accept*="image/jpeg"]'
    );
    const previewImage = modal.querySelector(
      '.product-main-info-cover-preview img'
    );

    if (!fileInput || !previewImage) {
      throw new Error(`${entry.displayCode} 的圖片上傳欄位不存在`);
    }

    const previousImageUrl = previewImage.currentSrc || previewImage.src || '';
    const pageWindow = getPageWindow();
    const transfer = new pageWindow.DataTransfer();
    transfer.items.add(entry.imageFile);
    try {
      fileInput.files = transfer.files;
    } catch {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: transfer.files,
      });
    }
    fileInput.dispatchEvent(
      new pageWindow.Event('change', { bubbles: true, composed: true })
    );

    await waitUntil(
      () => {
        const currentModal = getEditModal();
        if (!currentModal) return null;

        const currentImage = currentModal.querySelector(
          '.product-main-info-cover-preview img'
        );
        const currentFileInput = currentModal.querySelector(
          'input[type="file"][accept*="image/jpeg"]'
        );
        const uploadLabel = currentFileInput?.closest('label');
        const uploadText = cleanText(uploadLabel?.textContent);
        const currentImageUrl =
          currentImage?.currentSrc || currentImage?.src || '';
        const imageChanged =
          Boolean(currentImageUrl) &&
          currentImageUrl !== previousImageUrl &&
          !DEFAULT_IMAGE_PATTERN.test(currentImageUrl);
        const stillUploading = /照片(?:讀取|裁切|上傳)中/.test(uploadText);

        return imageChanged && !stillUploading && !currentFileInput?.disabled
          ? currentImageUrl
          : null;
      },
      PHOTO_UPLOAD_TIMEOUT,
      `${entry.displayCode} 圖片上傳逾時`
    );
  }

  function startAlertCapture() {
    if (state.restoreAlert) return;

    const pageWindow = getPageWindow();
    const originalAlert = pageWindow.alert;
    state.alertMessages = [];

    try {
      pageWindow.alert = (message) => {
        state.alertMessages.push({
          message: cleanText(message),
          time: Date.now(),
        });
      };
    } catch (error) {
      throw new Error(`無法接管網站成功提示：${error.message}`);
    }

    if (pageWindow.alert === originalAlert) {
      throw new Error('無法接管網站成功提示，批次上傳已停止');
    }

    state.restoreAlert = () => {
      try {
        pageWindow.alert = originalAlert;
      } catch (error) {
        console.warn('[Jambo 圖片上傳] 還原 alert 失敗', error);
      }
      state.restoreAlert = null;
    };
  }

  function stopAlertCapture() {
    state.restoreAlert?.();
  }

  async function saveProduct(modal, entry) {
    const confirmButton = Array.from(modal.querySelectorAll('button')).find(
      (button) => cleanText(button.textContent) === '確定'
    );
    if (!confirmButton) {
      throw new Error(`${entry.displayCode} 找不到確定按鈕`);
    }

    const alertIndex = state.alertMessages.length;
    confirmButton.click();

    await waitUntil(
      () => {
        const messages = state.alertMessages.slice(alertIndex);
        const failure = messages.find(({ message }) =>
          /失敗|未授權|請輸入|請指定|請修正|錯誤/.test(message)
        );
        if (failure) {
          throw new Error(`${entry.displayCode}：${failure.message}`);
        }

        const success = messages.some(({ message }) =>
          /編輯商品成功|商品成功/.test(message)
        );
        const updatedProduct = findProductByKey(entry.productKey);
        const rowImageUpdated = Boolean(updatedProduct?.hasExistingPhoto);
        return !modal.isConnected && (success || rowImageUpdated);
      },
      PRODUCT_SAVE_TIMEOUT,
      `${entry.displayCode} 儲存商品逾時`
    );
  }

  async function processEntry(entry) {
    const modal = await openProductEditor(entry);
    await uploadPhotoToModal(modal, entry);
    await saveProduct(modal, entry);
  }

  async function runBatchUpload(limit = null) {
    if (state.isBusy) return;
    if (getEditModal()) {
      setStatus('請先關閉目前的商品編輯視窗', true);
      return;
    }

    setBusy(true);
    try {
      setStatus('上傳前再次確認：載入全部並展開全部商品');
      await prepareAllProducts();
      scanLoadedProducts();
    } catch (error) {
      console.error('[Jambo 商品圖片上傳前檢查]', error);
      setStatus(`無法開始：${error.message}`, true);
      return;
    } finally {
      setBusy(false);
      updateSummary();
    }

    const allReadyEntries = state.scanEntries.filter(
      (entry) => entry.status === 'ready'
    );
    const readyEntries = Number.isInteger(limit)
      ? allReadyEntries.slice(0, Math.max(0, limit))
      : allReadyEntries;
    if (!readyEntries.length) {
      setStatus('沒有可上傳的商品', true);
      return;
    }

    const approved = window.confirm(
      `${limit === 1 ? '測試模式：' : ''}即將依序更新 ${readyEntries.length} 件商品圖片。\n\n` +
        '每件商品都會等待上傳與儲存完成後才處理下一件，是否開始？'
    );
    if (!approved) return;

    state.stopRequested = false;
    setBusy(true);
    setProgress(0, readyEntries.length);

    let completed = 0;
    try {
      startAlertCapture();

      for (let index = 0; index < readyEntries.length; index += 1) {
        if (state.stopRequested) {
          setStatus(`已停止；本次完成 ${completed} 件`);
          break;
        }

        const entry = readyEntries[index];
        setStatus(
          `處理 ${index + 1}/${readyEntries.length}：${entry.displayCode} 上傳中`
        );

        try {
          await processEntry(entry);
          entry.status = 'success';
          entry.statusLabel = '上傳成功';
          entry.resultMessage = '上傳成功';
          state.completedProductKeys.add(entry.productKey);
          completed += 1;
          setProgress(completed, readyEntries.length);
          updateSummary();
          renderPreview();
          await delay(500);
        } catch (error) {
          entry.status = 'error';
          entry.statusLabel = '上傳失敗';
          entry.resultMessage = error.message;
          updateSummary();
          renderPreview();
          throw error;
        }
      }

      if (!state.stopRequested && completed === readyEntries.length) {
        setStatus(`全部完成：成功上傳 ${completed} 件商品圖片`);
      }
    } catch (error) {
      console.error('[Jambo 商品圖片批次上傳]', error);
      setStatus(`已暫停：${error.message}`, true);
    } finally {
      stopAlertCapture();
      setBusy(false);
      updateSummary();
    }
  }

  async function loadAndScan() {
    if (state.isBusy) return;
    if (!state.imageFiles.length) {
      setStatus('請先選擇圖片資料夾', true);
      return;
    }
    if (getEditModal()) {
      setStatus('請先關閉目前的商品編輯視窗', true);
      return;
    }

    setBusy(true);
    try {
      const { loadResult, expandResult } = await prepareAllProducts();
      const entries = scanLoadedProducts();
      const readyCount = entries.filter((entry) => entry.status === 'ready').length;
      setStatus(
        `準備完成：載入 ${loadResult.loaded} 件、展開 ${expandResult.expandedCount} 件，可上傳 ${readyCount} 件`
      );
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (error) {
      console.error('[Jambo 商品圖片配對]', error);
      setStatus(error.message, true);
    } finally {
      setBusy(false);
      updateSummary();
    }
  }

  function chooseFolder() {
    const input = document.querySelector(`#${PANEL_ID} .jpi-folder-input`);
    input?.click();
  }

  function handleFolderSelected(event) {
    const files = Array.from(event.target.files ?? []);
    rebuildImageMap(files);
    state.scanEntries = [];
    state.orphanImageCodes = [];
    setProgress(0, 0);

    if (!state.imageFiles.length) {
      setStatus(
        '資料夾內沒有名稱為 A248、S01、S02灰這類格式的 JPG／PNG 圖片',
        true
      );
    } else {
      const duplicateText = state.duplicateImageCodes.size
        ? `；重複代碼 ${state.duplicateImageCodes.size} 組`
        : '';
      setStatus(`已讀取 ${state.imageFiles.length} 張圖片${duplicateText}`);
    }

    updateSummary();
    renderPreview();
  }

  function showPreview() {
    renderPreview();
    document.getElementById(PREVIEW_ID)?.classList.add('jpi-visible');
  }

  function hidePreview() {
    document.getElementById(PREVIEW_ID)?.classList.remove('jpi-visible');
  }

  function createPreview() {
    const preview = document.createElement('div');
    preview.id = PREVIEW_ID;
    preview.innerHTML = `
      <div class="jpi-preview-card" role="dialog" aria-modal="true" aria-label="圖片配對清單">
        <div class="jpi-preview-header">
          <strong>商品圖片配對清單</strong>
          <button type="button" class="jpi-preview-close" aria-label="關閉">×</button>
        </div>
        <div class="jpi-preview-scroll">
          <table>
            <thead>
              <tr><th>代碼</th><th>商品名稱</th><th>圖片檔案</th><th>狀態</th></tr>
            </thead>
            <tbody></tbody>
          </table>
          <div class="jpi-orphans"></div>
        </div>
      </div>
    `;
    preview.querySelector('.jpi-preview-close').addEventListener('click', hidePreview);
    preview.addEventListener('click', (event) => {
      if (event.target === preview) hidePreview();
    });
    document.body.append(preview);
  }

  function createPanel() {
    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 288px;
        bottom: 18px;
        z-index: 2147483000;
        width: 340px;
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid #cfd6df;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.97);
        box-shadow: 0 8px 28px rgba(26, 35, 50, 0.18);
        color: #273142;
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .jpi-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        font-size: 16px;
        font-weight: 700;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      #${PANEL_ID} .jpi-header.jpi-dragging { cursor: grabbing; }
      #${PANEL_ID} .jpi-collapse {
        width: 27px;
        height: 27px;
        padding: 0;
        border: 1px solid #cfd6df;
        border-radius: 7px;
        background: #fff;
        color: #445064;
        cursor: pointer;
        font-size: 19px;
        line-height: 23px;
      }
      #${PANEL_ID}.jpi-collapsed { width: auto; }
      #${PANEL_ID}.jpi-collapsed .jpi-body { display: none; }
      #${PANEL_ID}.jpi-collapsed .jpi-header { margin: 0; gap: 10px; }
      #${PANEL_ID} .jpi-button {
        width: 100%;
        min-height: 39px;
        margin-top: 8px;
        border: 0;
        border-radius: 8px;
        background: #0c8755;
        color: #fff;
        cursor: pointer;
        font-weight: 700;
      }
      #${PANEL_ID} .jpi-button.jpi-secondary { background: #3478d4; }
      #${PANEL_ID} .jpi-button.jpi-preview-button { background: #6b55bd; }
      #${PANEL_ID} .jpi-button.jpi-test-one { background: #d17a20; }
      #${PANEL_ID} .jpi-button.jpi-stop { background: #c3454d; }
      #${PANEL_ID} button:disabled { cursor: not-allowed; opacity: 0.48; }
      #${PANEL_ID} .jpi-options {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-top: 10px;
        font-size: 13px;
      }
      #${PANEL_ID} .jpi-summary {
        margin-top: 9px;
        color: #566174;
        font-size: 13px;
      }
      #${PANEL_ID} .jpi-progress {
        height: 7px;
        margin-top: 9px;
        overflow: hidden;
        border-radius: 999px;
        background: #e8edf3;
      }
      #${PANEL_ID} .jpi-progress-value {
        width: 0;
        height: 100%;
        background: #0c8755;
        transition: width 0.2s ease;
      }
      #${PANEL_ID} .jpi-status {
        min-height: 38px;
        margin-top: 9px;
        color: #167452;
        font-size: 13px;
        overflow-wrap: anywhere;
      }
      #${PANEL_ID} .jpi-status.jpi-error { color: #c43d49; }
      #${PANEL_ID} .jpi-hint {
        margin-top: 4px;
        color: #7c8797;
        font-size: 11px;
      }
      #${PREVIEW_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483100;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 4vh 4vw;
        background: rgba(20, 27, 38, 0.48);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${PREVIEW_ID}.jpi-visible { display: flex; }
      #${PREVIEW_ID} .jpi-preview-card {
        display: flex;
        flex-direction: column;
        width: min(980px, 92vw);
        max-height: 82vh;
        overflow: hidden;
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 18px 60px rgba(0,0,0,.28);
      }
      #${PREVIEW_ID} .jpi-preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 17px;
        border-bottom: 1px solid #dfe4ea;
        color: #273142;
        font-size: 17px;
      }
      #${PREVIEW_ID} .jpi-preview-close {
        border: 0;
        background: transparent;
        color: #526071;
        cursor: pointer;
        font-size: 28px;
      }
      #${PREVIEW_ID} .jpi-preview-scroll { overflow: auto; padding: 0 15px 15px; }
      #${PREVIEW_ID} table { width: 100%; border-collapse: collapse; font-size: 13px; }
      #${PREVIEW_ID} th, #${PREVIEW_ID} td {
        padding: 9px 8px;
        border-bottom: 1px solid #e5e9ee;
        text-align: left;
        vertical-align: top;
      }
      #${PREVIEW_ID} th { position: sticky; top: 0; background: #f3f6f9; }
      #${PREVIEW_ID} td:first-child { white-space: nowrap; font-weight: 700; }
      #${PREVIEW_ID} .jpi-ready td:last-child { color: #167452; }
      #${PREVIEW_ID} .jpi-success td:last-child { color: #087543; font-weight: 700; }
      #${PREVIEW_ID} .jpi-failed td:last-child { color: #c43d49; font-weight: 700; }
      #${PREVIEW_ID} .jpi-skipped { color: #7a8492; background: #fafbfc; }
      #${PREVIEW_ID} .jpi-orphans {
        margin-top: 13px;
        padding: 11px;
        border-radius: 8px;
        background: #f5f2ff;
        color: #5c4a99;
        font-size: 13px;
      }
    `;
    document.head.append(style);

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.classList.add('jpi-collapsed');
    panel.innerHTML = `
      <div class="jpi-header">
        <span>Jambo 商品圖片上傳</span>
        <button type="button" class="jpi-collapse" aria-label="展開面板" aria-expanded="false">+</button>
      </div>
      <div class="jpi-body">
        <input class="jpi-folder-input" type="file" accept="image/jpeg,image/png" multiple webkitdirectory hidden>
        <button type="button" class="jpi-button jpi-choose" data-busy-lock>1. 選擇圖片資料夾</button>
        <button type="button" class="jpi-button jpi-secondary jpi-scan" data-busy-lock>2. 載入＋展開＋預覽配對</button>
        <label class="jpi-options">
          <input type="checkbox" class="jpi-overwrite" data-busy-lock>
          <span>已有商品圖片也要覆蓋</span>
        </label>
        <div class="jpi-summary">尚未選擇圖片資料夾</div>
        <button type="button" class="jpi-button jpi-preview-button" data-busy-lock disabled>查看配對清單</button>
        <button type="button" class="jpi-button jpi-test-one" data-busy-lock disabled>先測試上傳 1 件</button>
        <button type="button" class="jpi-button jpi-start" data-busy-lock disabled>3. 開始批次上傳</button>
        <button type="button" class="jpi-button jpi-stop" disabled>停止</button>
        <div class="jpi-progress"><div class="jpi-progress-value"></div></div>
        <div class="jpi-status">請先選擇含有 A248.jpg、S01.jpg 這類檔名的資料夾</div>
        <div class="jpi-hint">基於瀏覽器安全限制，每次重新整理後需重新選擇資料夾。</div>
      </div>
    `;

    const dragHandle = panel.querySelector('.jpi-header');
    let clampPanelPosition = () => {};

    panel.querySelector('.jpi-collapse').addEventListener('click', (event) => {
      panel.classList.toggle('jpi-collapsed');
      const collapsed = panel.classList.contains('jpi-collapsed');
      event.currentTarget.textContent = collapsed ? '+' : '−';
      event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
      event.currentTarget.setAttribute(
        'aria-label',
        collapsed ? '展開面板' : '收合面板'
      );
      window.requestAnimationFrame(clampPanelPosition);
    });
    panel.querySelector('.jpi-choose').addEventListener('click', chooseFolder);
    panel
      .querySelector('.jpi-folder-input')
      .addEventListener('change', handleFolderSelected);
    panel.querySelector('.jpi-scan').addEventListener('click', loadAndScan);
    panel.querySelector('.jpi-preview-button').addEventListener('click', showPreview);
    panel.querySelector('.jpi-test-one').addEventListener('click', () =>
      runBatchUpload(1)
    );
    panel.querySelector('.jpi-start').addEventListener('click', () =>
      runBatchUpload()
    );
    panel.querySelector('.jpi-stop').addEventListener('click', () => {
      state.stopRequested = true;
      setStatus('收到停止要求；目前這件處理完就會停止');
    });
    panel.querySelector('.jpi-overwrite').addEventListener('change', () => {
      if (state.scanEntries.length) {
        scanLoadedProducts();
        setStatus('覆蓋設定已更新，請再確認配對清單');
      }
    });

    document.body.append(panel);
    clampPanelPosition = makePanelDraggable(
      panel,
      dragHandle,
      PANEL_POSITION_STORAGE_KEY
    );
  }

  function initialize() {
    createPreview();
    createPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
