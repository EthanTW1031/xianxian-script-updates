// ==UserScript==
// @name         Shopee Live Order Capture
// @namespace    https://github.com/EthanTW1031/Shopee
// @version      0.4.0
// @description  擷取蝦皮官方 PC 主播後台的直播留言並在本機整理喊單資料
// @author       EthanTW1031
// @match        https://live.shopee.tw/pc/live*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(() => {
  // src/constants.js
  var APP_PREFIX = "slocc:v1";
  var SESSION_KEY_PREFIX = `${APP_PREFIX}:session:`;
  var LOCK_KEY_PREFIX = "slocc:lock:";
  var TAB_ID_KEY = `${APP_PREFIX}:tab-id`;
  var TAB_SESSION_KEY = `${APP_PREFIX}:tab-session`;
  var PRICE_REQUIRED_PREF_KEY = `${APP_PREFIX}:pref:priceRequired`;
  var COMMENT_ROW_SELECTOR = '[data-comment-id]:not([data-comment-id="false"])';
  var USERNAME_SELECTOR = '[class*="user-name_"]';
  var MESSAGE_SELECTOR = '[class*="message-content_"]';
  var HOST_ITEM_SELECTOR = '[class*="host-item_"]';
  var COMMENT_HOST_SELECTOR = [
    '[class*="comment-content_"]',
    ".ReactVirtualized__List",
    ".ReactVirtualized__Grid",
    '[role="grid"]'
  ].join(",");
  var MAX_QUANTITY = 99;
  var FALLBACK_BUCKET_MS = 1e4;
  var DOM_SCAN_DELAY_MS = 100;
  var DOM_STABILITY_DELAY_MS = 50;
  var DOM_STATUS_INTERVAL_MS = 1e3;
  var URL_POLL_INTERVAL_MS = 1e3;
  var LOCK_HEARTBEAT_MS = 3e3;
  var LOCK_STALE_MS = 1e4;
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

  // src/aggregation.js
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
  function createOrderAggregation() {
    return {
      orderLineCount: 0,
      reviewLineCount: 0,
      aggregatedUnitCount: 0,
      groups: /* @__PURE__ */ new Map()
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
        representativeActivationSequence: item.activationSequence
      });
      aggregation.aggregatedUnitCount += quantity;
      return aggregation;
    }
    existing.sourceItemCount += 1;
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
  function orderAggregationView(aggregation) {
    return {
      orderLineCount: aggregation?.orderLineCount ?? 0,
      reviewLineCount: aggregation?.reviewLineCount ?? 0,
      groupCount: aggregation?.groups?.size ?? 0,
      aggregatedUnitCount: aggregation?.aggregatedUnitCount ?? 0
    };
  }

  // src/idb.js
  var DB_NAME = "slocc";
  var DB_VERSION = 5;
  var STORE_NAMES = Object.freeze({
    META: "meta",
    SESSIONS: "sessions",
    COMMENTS: "comments",
    ITEMS: "items",
    CATALOG_PRODUCTS: "catalogProducts"
  });
  var INDEX_NAMES = Object.freeze({
    COMMENTS_BY_SESSION_SEQUENCE: "bySessionSequence",
    COMMENTS_BY_SESSION_CLASSIFICATION_SEQUENCE: "bySessionClassificationSequence",
    ITEMS_BY_SESSION_SEQUENCE_ITEM: "bySessionSequenceItem",
    CATALOG_BY_SESSION_ORDER: "bySessionOrder",
    LEGACY_ITEMS_BY_SESSION_SEQUENCE: "bySessionSequence"
  });
  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  }
  function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => {
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      }, { once: true });
      transaction.addEventListener("error", () => {
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      }, { once: true });
    });
  }
  function createSchema(database, transaction) {
    if (!database.objectStoreNames.contains(STORE_NAMES.META)) {
      database.createObjectStore(STORE_NAMES.META, { keyPath: "key" });
    }
    if (!database.objectStoreNames.contains(STORE_NAMES.SESSIONS)) {
      database.createObjectStore(STORE_NAMES.SESSIONS, { keyPath: "sessionId" });
    }
    if (!database.objectStoreNames.contains(STORE_NAMES.COMMENTS)) {
      const comments = database.createObjectStore(STORE_NAMES.COMMENTS, {
        keyPath: ["sessionId", "commentId"]
      });
      comments.createIndex(
        INDEX_NAMES.COMMENTS_BY_SESSION_SEQUENCE,
        ["sessionId", "captureSequence"],
        { unique: true }
      );
      comments.createIndex(
        INDEX_NAMES.COMMENTS_BY_SESSION_CLASSIFICATION_SEQUENCE,
        ["sessionId", "classification", "captureSequence"],
        { unique: false }
      );
    }
    if (!database.objectStoreNames.contains(STORE_NAMES.ITEMS)) {
      const items = database.createObjectStore(STORE_NAMES.ITEMS, {
        keyPath: ["sessionId", "itemId"]
      });
      items.createIndex(
        INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM,
        ["sessionId", "captureSequence", "itemId"],
        { unique: true }
      );
    } else if (transaction) {
      const items = transaction.objectStore(STORE_NAMES.ITEMS);
      if (items.indexNames.contains(INDEX_NAMES.LEGACY_ITEMS_BY_SESSION_SEQUENCE)) {
        items.deleteIndex(INDEX_NAMES.LEGACY_ITEMS_BY_SESSION_SEQUENCE);
      }
      if (!items.indexNames.contains(INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM)) {
        items.createIndex(
          INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM,
          ["sessionId", "captureSequence", "itemId"],
          { unique: true }
        );
      }
    }
    if (!database.objectStoreNames.contains(STORE_NAMES.CATALOG_PRODUCTS)) {
      const catalogProducts = database.createObjectStore(
        STORE_NAMES.CATALOG_PRODUCTS,
        { keyPath: ["sessionId", "productCode"] }
      );
      catalogProducts.createIndex(
        INDEX_NAMES.CATALOG_BY_SESSION_ORDER,
        ["sessionId", "importOrder"],
        { unique: true }
      );
    }
  }
  function openCaptureDatabase(options = {}) {
    const indexedDBFactory = options.indexedDB ?? globalThis.indexedDB;
    if (!indexedDBFactory?.open) {
      return Promise.reject(new Error("\u6B64\u700F\u89BD\u5668\u7121\u6CD5\u4F7F\u7528 IndexedDB\u3002"));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDBFactory.open(options.name ?? DB_NAME, DB_VERSION);
      request.addEventListener("upgradeneeded", () => {
        createSchema(request.result, request.transaction);
      });
      request.addEventListener("blocked", () => options.onBlocked?.());
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => {
          database.close();
          options.onVersionChange?.();
        });
        resolve(database);
      }, { once: true });
    });
  }

  // src/parser.js
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
    "\u9ED1",
    "\u767D",
    "\u7070",
    "\u85CD",
    "\u7DA0",
    "\u7C89",
    "\u9EC3",
    "\u674F",
    "\u7D2B",
    "\u7D05",
    "\u5496",
    "\u5976",
    "\u71D5",
    "\u53EF",
    "\u6DF1\u7070",
    "\u6DFA\u7070",
    "\u6DF1\u85CD",
    "\u6DFA\u85CD",
    "\u4E2D\u7070",
    "\u4E2D\u85CD",
    "\u7C73\u7070"
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
  var PAST_ORDER_MARKER = "\u904E\u6B3E";
  var PACKAGE_COLOR_KEYWORD = "\u5305\u8272";
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

  // src/repository.js
  var SESSION_SCHEMA_VERSION = 5;
  var EMPTY_COUNTS = Object.freeze({
    raw: 0,
    confirmed: 0,
    needsReview: 0,
    inactiveCode: 0,
    paused: 0,
    chat: 0,
    host: 0,
    productInquiry: 0,
    anomaly: 0
  });
  function createSessionMeta(sessionId, now = Date.now()) {
    const timestamp = new Date(now).toISOString();
    return {
      sessionId,
      schemaVersion: SESSION_SCHEMA_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
      nextCaptureSequence: 1,
      config: {
        activeCode: null,
        activationSequence: 0,
        activatedAt: null,
        profileRevision: 0,
        specProfile: null
      },
      history: [],
      profileHistory: [],
      catalogRevision: 0,
      catalogImportedAt: null,
      catalogCount: 0,
      counts: { ...EMPTY_COUNTS },
      legacyMigrationId: null
    };
  }
  function sessionWithCatalogDefaults(session) {
    if (!session) return session;
    return {
      ...session,
      catalogRevision: session.catalogRevision ?? 0,
      catalogImportedAt: session.catalogImportedAt ?? null,
      catalogCount: session.catalogCount ?? 0
    };
  }
  function revisionConflict(message = "\u5546\u54C1\u6E05\u55AE\u5DF2\u7531\u5176\u4ED6\u5206\u9801\u66F4\u65B0\uFF0C\u8ACB\u91CD\u65B0\u8F09\u5165\u3002") {
    const error = new Error(message);
    error.code = "REVISION_CONFLICT";
    return error;
  }
  function deleteByCursor(index, range) {
    return new Promise((resolve, reject) => {
      const request = index.openCursor(range);
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      });
    });
  }
  var CaptureRepository = class _CaptureRepository {
    constructor(database, options = {}) {
      this.database = database;
      this.now = options.now ?? (() => Date.now());
      this.keyRange = options.keyRange ?? globalThis.IDBKeyRange;
    }
    static async open(options = {}) {
      const database = await openCaptureDatabase(options);
      return new _CaptureRepository(database, options);
    }
    close() {
      this.database.close();
    }
    async runTransaction(storeNames, mode, operation) {
      const transaction = this.database.transaction(storeNames, mode);
      const completion = transactionToPromise(transaction).then(
        () => null,
        (error) => error
      );
      const stores = Object.fromEntries(
        storeNames.map((name) => [name, transaction.objectStore(name)])
      );
      try {
        const result = await operation(stores, transaction);
        const completionError = await completion;
        if (completionError) throw completionError;
        return result;
      } catch (error) {
        try {
          if (transaction.readyState !== "done") transaction.abort();
        } catch {
        }
        await completion;
        throw error;
      }
    }
    async getMeta(key) {
      return this.runTransaction([STORE_NAMES.META], "readonly", ({ meta }) => requestToPromise(meta.get(key)));
    }
    async putMeta(value) {
      return this.runTransaction([STORE_NAMES.META], "readwrite", ({ meta }) => requestToPromise(meta.put(value)));
    }
    async deleteMeta(key) {
      return this.runTransaction([STORE_NAMES.META], "readwrite", ({ meta }) => requestToPromise(meta.delete(key)));
    }
    async getSession(sessionId, { create = true } = {}) {
      const existing = await this.runTransaction(
        [STORE_NAMES.SESSIONS],
        "readonly",
        ({ sessions }) => requestToPromise(sessions.get(sessionId))
      );
      if (existing || !create) return sessionWithCatalogDefaults(existing) ?? null;
      const next = createSessionMeta(sessionId, this.now());
      await this.putSession(next);
      return next;
    }
    async putSession(session) {
      return this.runTransaction(
        [STORE_NAMES.SESSIONS],
        "readwrite",
        ({ sessions }) => requestToPromise(sessions.put(session))
      );
    }
    async listSessionIds() {
      return this.runTransaction(
        [STORE_NAMES.SESSIONS],
        "readonly",
        async ({ sessions }) => (await requestToPromise(sessions.getAllKeys())).sort()
      );
    }
    async addComment(comment) {
      return this.runTransaction(
        [STORE_NAMES.COMMENTS],
        "readwrite",
        ({ comments }) => requestToPromise(comments.add(comment))
      );
    }
    async addItem(item) {
      return this.runTransaction(
        [STORE_NAMES.ITEMS],
        "readwrite",
        ({ items }) => requestToPromise(items.add(item))
      );
    }
    async getCatalogProduct(sessionId, productCode) {
      return this.runTransaction(
        [STORE_NAMES.CATALOG_PRODUCTS],
        "readonly",
        ({ catalogProducts }) => requestToPromise(
          catalogProducts.get([sessionId, productCode])
        )
      );
    }
    async listCatalogProducts(sessionId) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const range = this.keyRange.bound(
        [sessionId, -Infinity],
        [sessionId, Infinity]
      );
      return this.runTransaction(
        [STORE_NAMES.CATALOG_PRODUCTS],
        "readonly",
        ({ catalogProducts }) => requestToPromise(
          catalogProducts.index(INDEX_NAMES.CATALOG_BY_SESSION_ORDER).getAll(range)
        )
      );
    }
    async replaceCatalogProducts(sessionId, products, options = {}) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const range = this.keyRange.bound(
        [sessionId, -Infinity],
        [sessionId, Infinity]
      );
      return this.runTransaction(
        [STORE_NAMES.SESSIONS, STORE_NAMES.CATALOG_PRODUCTS],
        "readwrite",
        async ({ sessions, catalogProducts }) => {
          const stored = sessionWithCatalogDefaults(
            await requestToPromise(sessions.get(sessionId))
          );
          if (!stored) throw new Error("\u627E\u4E0D\u5230\u672C\u5834\u8CC7\u6599\uFF0C\u7121\u6CD5\u66F4\u65B0\u5546\u54C1\u6E05\u55AE\u3002");
          if (options.expectedRevision != null && stored.revision !== options.expectedRevision || options.expectedCatalogRevision != null && stored.catalogRevision !== options.expectedCatalogRevision || options.isCurrent?.() === false) throw revisionConflict();
          await deleteByCursor(
            catalogProducts.index(INDEX_NAMES.CATALOG_BY_SESSION_ORDER),
            range
          );
          for (const product of products) {
            await requestToPromise(catalogProducts.add({ ...product, sessionId }));
          }
          const updatedAt = new Date(this.now()).toISOString();
          const next = {
            ...stored,
            schemaVersion: SESSION_SCHEMA_VERSION,
            revision: stored.revision + 1,
            updatedAt,
            catalogRevision: stored.catalogRevision + 1,
            catalogImportedAt: updatedAt,
            catalogCount: products.length
          };
          await requestToPromise(sessions.put(next));
          return { session: next, products: products.map((product) => ({
            ...product,
            sessionId
          })) };
        }
      );
    }
    async putCatalogProduct(sessionId, product, options = {}) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const range = this.keyRange.bound(
        [sessionId, -Infinity],
        [sessionId, Infinity]
      );
      return this.runTransaction(
        [STORE_NAMES.SESSIONS, STORE_NAMES.CATALOG_PRODUCTS],
        "readwrite",
        async ({ sessions, catalogProducts }) => {
          const stored = sessionWithCatalogDefaults(
            await requestToPromise(sessions.get(sessionId))
          );
          if (!stored) throw new Error("\u627E\u4E0D\u5230\u672C\u5834\u8CC7\u6599\uFF0C\u7121\u6CD5\u65B0\u589E\u5546\u54C1\u3002");
          if (options.expectedRevision != null && stored.revision !== options.expectedRevision || options.expectedCatalogRevision != null && stored.catalogRevision !== options.expectedCatalogRevision || options.isCurrent?.() === false) throw revisionConflict();
          const existing = await requestToPromise(
            catalogProducts.get([sessionId, product.productCode])
          );
          if (existing) {
            const error = new Error("\u6B64\u5546\u54C1\u78BC\u5DF2\u5B58\u5728\u65BC\u672C\u5834\u5546\u54C1\u6E05\u55AE\u3002");
            error.code = "CATALOG_PRODUCT_EXISTS";
            throw error;
          }
          const last = await new Promise((resolve, reject) => {
            const request = catalogProducts.index(INDEX_NAMES.CATALOG_BY_SESSION_ORDER).openCursor(range, "prev");
            request.addEventListener("error", () => reject(request.error), { once: true });
            request.addEventListener("success", () => resolve(request.result?.value ?? null), {
              once: true
            });
          });
          const updatedAt = new Date(this.now()).toISOString();
          const record = {
            ...product,
            sessionId,
            importOrder: (last?.importOrder ?? -1) + 1,
            entryOrigin: "singleAdd",
            sourceRow: null,
            importedAt: updatedAt
          };
          await requestToPromise(catalogProducts.add(record));
          const next = {
            ...stored,
            schemaVersion: SESSION_SCHEMA_VERSION,
            revision: stored.revision + 1,
            updatedAt,
            catalogRevision: stored.catalogRevision + 1,
            catalogImportedAt: updatedAt,
            catalogCount: stored.catalogCount + 1
          };
          await requestToPromise(sessions.put(next));
          return { session: next, product: record };
        }
      );
    }
    async deleteCatalogProducts(sessionId, options = {}) {
      return this.replaceCatalogProducts(sessionId, [], options);
    }
    async getComment(sessionId, commentId) {
      return this.runTransaction(
        [STORE_NAMES.COMMENTS],
        "readonly",
        ({ comments }) => requestToPromise(comments.get([sessionId, commentId]))
      );
    }
    async getComments(sessionId, commentIds) {
      return this.runTransaction(
        [STORE_NAMES.COMMENTS],
        "readonly",
        async ({ comments }) => Promise.all(
          commentIds.map((commentId) => requestToPromise(comments.get([sessionId, commentId])))
        )
      );
    }
    async countSessionRecords(storeName, sessionId) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const isItems = storeName === STORE_NAMES.ITEMS;
      const lower = isItems ? [sessionId, -Infinity, ""] : [sessionId, -Infinity];
      const upper = isItems ? [sessionId, Infinity, "\uFFFF"] : [sessionId, Infinity];
      const indexName = isItems ? INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM : storeName === STORE_NAMES.CATALOG_PRODUCTS ? INDEX_NAMES.CATALOG_BY_SESSION_ORDER : INDEX_NAMES.COMMENTS_BY_SESSION_SEQUENCE;
      return this.runTransaction([storeName], "readonly", (stores) => requestToPromise(
        stores[storeName].index(indexName).count(this.keyRange.bound(lower, upper))
      ));
    }
    async scanSessionComments(sessionId, onRecord, { direction = "next" } = {}) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      if (direction !== "next") {
        throw new Error("Paged comment rebuild currently supports forward order only.");
      }
      let afterSequence = 0;
      const pageSize = 2e3;
      while (true) {
        const rows = await this.readIndexPage(
          STORE_NAMES.COMMENTS,
          INDEX_NAMES.COMMENTS_BY_SESSION_SEQUENCE,
          [sessionId, afterSequence],
          [sessionId, Infinity],
          { limit: pageSize, lowerOpen: true }
        );
        for (const row of rows) onRecord(row);
        if (rows.length < pageSize) return;
        afterSequence = rows.at(-1).captureSequence;
      }
    }
    async scanSessionItems(sessionId, onRecord, options = {}) {
      let afterKey = options.afterKey ?? [sessionId, 0, ""];
      const pageSize = options.pageSize ?? 2e3;
      const cutoffSequence = options.cutoffSequence ?? Infinity;
      while (true) {
        const rows = await this.readItemsPage(sessionId, {
          afterKey,
          cutoffSequence,
          limit: pageSize
        });
        for (const row of rows) onRecord(row);
        if (rows.length < pageSize) return;
        const last = rows.at(-1);
        afterKey = [sessionId, last.captureSequence, last.itemId];
      }
    }
    async readRecentComments(sessionId, limit = 12) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const range = this.keyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
      return this.runTransaction(
        [STORE_NAMES.COMMENTS],
        "readonly",
        ({ comments }) => new Promise((resolve, reject) => {
          const rows = [];
          const request = comments.index(INDEX_NAMES.COMMENTS_BY_SESSION_SEQUENCE).openCursor(range, "prev");
          request.addEventListener("error", () => reject(request.error), { once: true });
          request.addEventListener("success", () => {
            const cursor = request.result;
            if (!cursor || rows.length >= limit) {
              resolve(rows);
              return;
            }
            rows.push(cursor.value);
            cursor.continue();
          });
        })
      );
    }
    async deleteSession(sessionId) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const commentRange = this.keyRange.bound(
        [sessionId, -Infinity],
        [sessionId, Infinity]
      );
      const itemRange = this.keyRange.bound(
        [sessionId, -Infinity, ""],
        [sessionId, Infinity, "\uFFFF"]
      );
      const catalogRange = this.keyRange.bound(
        [sessionId, -Infinity],
        [sessionId, Infinity]
      );
      return this.runTransaction(
        [
          STORE_NAMES.SESSIONS,
          STORE_NAMES.COMMENTS,
          STORE_NAMES.ITEMS,
          STORE_NAMES.CATALOG_PRODUCTS
        ],
        "readwrite",
        async ({ sessions, comments, items, catalogProducts }) => {
          await Promise.all([
            deleteByCursor(
              comments.index(INDEX_NAMES.COMMENTS_BY_SESSION_SEQUENCE),
              commentRange
            ),
            deleteByCursor(
              items.index(INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM),
              itemRange
            ),
            deleteByCursor(
              catalogProducts.index(INDEX_NAMES.CATALOG_BY_SESSION_ORDER),
              catalogRange
            )
          ]);
          await requestToPromise(sessions.delete(sessionId));
        }
      );
    }
    async loadSessionData(sessionId) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const commentRange = this.keyRange.bound(
        [sessionId, -Infinity],
        [sessionId, Infinity]
      );
      const itemRange = this.keyRange.bound(
        [sessionId, -Infinity, ""],
        [sessionId, Infinity, "\uFFFF"]
      );
      return this.runTransaction(
        [
          STORE_NAMES.SESSIONS,
          STORE_NAMES.COMMENTS,
          STORE_NAMES.ITEMS,
          STORE_NAMES.CATALOG_PRODUCTS
        ],
        "readonly",
        async ({ sessions, comments, items, catalogProducts }) => {
          const catalogRange = this.keyRange.bound(
            [sessionId, -Infinity],
            [sessionId, Infinity]
          );
          const [session, commentRows, itemRows, catalogRows] = await Promise.all([
            requestToPromise(sessions.get(sessionId)),
            requestToPromise(
              comments.index(INDEX_NAMES.COMMENTS_BY_SESSION_SEQUENCE).getAll(commentRange)
            ),
            requestToPromise(
              items.index(INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM).getAll(itemRange)
            ),
            requestToPromise(
              catalogProducts.index(INDEX_NAMES.CATALOG_BY_SESSION_ORDER).getAll(catalogRange)
            )
          ]);
          return {
            ...sessionWithCatalogDefaults(session),
            comments: Object.fromEntries(commentRows.map((row) => [row.commentId, row])),
            items: Object.fromEntries(itemRows.map((row) => [row.itemId, row])),
            catalogProducts: catalogRows
          };
        }
      );
    }
    async readIndexPage(storeName, indexName, lower, upper, options = {}) {
      if (!this.keyRange) throw new Error("IDBKeyRange is unavailable.");
      const limit = options.limit ?? 1e3;
      const range = this.keyRange.bound(
        lower,
        upper,
        options.lowerOpen ?? true,
        false
      );
      return this.runTransaction([storeName], "readonly", (stores) => requestToPromise(stores[storeName].index(indexName).getAll(range, limit)));
    }
    readItemsPage(sessionId, options = {}) {
      const afterKey = options.afterKey ?? (options.afterSequence == null ? [sessionId, 0, ""] : [sessionId, options.afterSequence, "\uFFFF"]);
      return this.readIndexPage(
        STORE_NAMES.ITEMS,
        INDEX_NAMES.ITEMS_BY_SESSION_SEQUENCE_ITEM,
        afterKey,
        [sessionId, options.cutoffSequence ?? Infinity, "\uFFFF"],
        options
      );
    }
    readInactiveCommentsPage(sessionId, options = {}) {
      return this.readIndexPage(
        STORE_NAMES.COMMENTS,
        INDEX_NAMES.COMMENTS_BY_SESSION_CLASSIFICATION_SEQUENCE,
        [sessionId, "inactiveCode", options.afterSequence ?? 0],
        [sessionId, "inactiveCode", options.cutoffSequence ?? Infinity],
        options
      );
    }
  };

  // src/capture-buffer.js
  var RECENT_LIMIT = 12;
  var RETRY_DELAYS_MS = [1e3, 2e3, 4e3, 8e3, 3e4];
  function nowIso(now) {
    return new Date(now).toISOString();
  }
  function persistedSpecProfile(profile, profileRevision) {
    const compiled = compileSpecProfile(profile);
    if (!compiled.valid) {
      const error = new Error("\u898F\u683C\u8A2D\u5B9A\u7121\u6548\uFF0C\u8ACB\u4FEE\u6B63\u5F8C\u518D\u5957\u7528\u5546\u54C1\u78BC\u3002");
      error.code = "INVALID_SPEC_PROFILE";
      error.details = compiled.errors;
      throw error;
    }
    const compiledSelected = [
      ...compiled.selectedByDimension.style,
      ...compiled.selectedByDimension.size
    ];
    const remainingSelected = new Set(compiledSelected);
    const displayOrder = [];
    const requestedOrder = [
      ...profile.displayOrder ?? [],
      ...profile.selected?.style ?? [],
      ...profile.selected?.size ?? [],
      ...(profile.customSlots ?? []).filter((slot) => slot.selected).map((slot) => slot.value)
    ];
    for (const value of requestedOrder) {
      const canonical = canonicalizeSpecKeyword(value);
      if (remainingSelected.delete(canonical)) displayOrder.push(canonical);
    }
    displayOrder.push(...remainingSelected);
    return {
      mode: compiled.mode,
      selected: {
        style: [...compiled.selectedByDimension.style],
        size: [...compiled.selectedByDimension.size]
      },
      customSlots: compiled.customSlots.map((slot) => ({
        value: slot.value,
        selected: slot.selected,
        dimension: slot.dimension
      })),
      displayOrder,
      profileRevision
    };
  }
  function frozenProfileSnapshot(profile) {
    const selected = Object.freeze({
      style: Object.freeze([...profile?.selected?.style ?? []]),
      size: Object.freeze([...profile?.selected?.size ?? []])
    });
    const customSlots = Object.freeze((profile?.customSlots ?? []).map((slot) => Object.freeze({
      value: slot.value ?? "",
      selected: slot.selected === true,
      dimension: slot.dimension ?? "style"
    })));
    return Object.freeze({
      mode: profile?.mode,
      selected,
      customSlots,
      displayOrder: Object.freeze([...profile?.displayOrder ?? []]),
      profileRevision: profile?.profileRevision ?? null
    });
  }
  function frozenHistoryProfile(entry) {
    const activeCode = normalizeProductCode(entry?.activeCode);
    if (!activeCode || !entry?.specProfile) return null;
    return Object.freeze({
      specProfile: frozenProfileSnapshot(entry.specProfile),
      profileRevision: entry.profileRevision ?? entry.specProfile.profileRevision ?? null,
      activationSequence: entry.activationSequence ?? 0,
      appliedAt: entry.appliedAt ?? null,
      productName: entry.productName ?? "",
      price: entry.price ?? ""
    });
  }
  function frozenCatalogProduct(product) {
    if (!product) return null;
    return Object.freeze({
      ...product,
      specProfile: frozenProfileSnapshot(product.specProfile)
    });
  }
  function replaceRuntimeCatalog(runtime, products = []) {
    const catalogProducts = Object.freeze(products.map(frozenCatalogProduct));
    runtime.catalogProducts = catalogProducts;
    runtime.catalogByCode = new Map(
      catalogProducts.map((product) => [product.productCode, product])
    );
  }
  function profileContentSignature(profile) {
    if (!profile) return "";
    return JSON.stringify({
      mode: profile.mode,
      selected: {
        style: profile.selected?.style ?? [],
        size: profile.selected?.size ?? []
      },
      customSlots: (profile.customSlots ?? []).map((slot) => ({
        value: slot.value ?? "",
        selected: slot.selected === true,
        dimension: slot.dimension ?? "style"
      })),
      displayOrder: profile.displayOrder ?? []
    });
  }
  function productMetadataForParsedItem(parsedItem, context) {
    const productCode = normalizeProductCode(parsedItem?.productCode);
    if (!productCode) return null;
    if (productCode === normalizeProductCode(context.activeCodeAtFirstSeen)) {
      return context.productMetaAtFirstSeen ?? null;
    }
    return context.latestProfileByCodeAtFirstSeen?.get(productCode) ?? null;
  }
  function priceForParsedItem(parsedItem, context, productMetadata) {
    const metadata = productMetadata ?? productMetadataForParsedItem(parsedItem, context);
    return metadata?.price ?? "";
  }
  function productNameForParsedItem(parsedItem, context, productMetadata) {
    const metadata = productMetadata ?? productMetadataForParsedItem(parsedItem, context);
    return metadata?.productName ?? "";
  }
  function buildLatestProfileByCode(profileHistory = []) {
    const latest = /* @__PURE__ */ new Map();
    for (const entry of profileHistory ?? []) {
      const snapshot = frozenHistoryProfile(entry);
      const activeCode = normalizeProductCode(entry?.activeCode);
      if (activeCode && snapshot) latest.set(activeCode, snapshot);
    }
    return latest;
  }
  function appendLatestProfile(current, historyEntry) {
    const activeCode = normalizeProductCode(historyEntry?.activeCode);
    const snapshot = frozenHistoryProfile(historyEntry);
    if (!activeCode || !snapshot) return current;
    const existing = current.get(activeCode);
    if (existing?.profileRevision === snapshot.profileRevision && existing?.appliedAt === snapshot.appliedAt) return current;
    const next = new Map(current);
    next.set(activeCode, snapshot);
    return next;
  }
  function signature(snapshot) {
    return JSON.stringify([
      snapshot.username ?? "",
      snapshot.rawMessage ?? "",
      Boolean(snapshot.isHost)
    ]);
  }
  function commentKey(snapshot, firstSeenAt) {
    if (snapshot.commentId) return snapshot.commentId;
    return [
      "fallback",
      snapshot.uid ?? "",
      snapshot.username ?? "",
      snapshot.rawMessage ?? "",
      Math.floor(firstSeenAt / FALLBACK_BUCKET_MS)
    ].join(":");
  }
  function counterDelta(classification, anomaly = false) {
    const delta = { ...EMPTY_COUNTS, raw: 1 };
    if (Object.hasOwn(delta, classification)) delta[classification] += 1;
    if (anomaly) delta.anomaly += 1;
    return delta;
  }
  function anomalyDelta() {
    return { ...EMPTY_COUNTS, anomaly: 1 };
  }
  function addCounts(target, delta) {
    for (const key of Object.keys(EMPTY_COUNTS)) {
      target[key] = (target[key] ?? 0) + (delta[key] ?? 0);
    }
    return target;
  }
  function countsEqual(left, right) {
    return Object.keys(EMPTY_COUNTS).every((key) => left[key] === right[key]);
  }
  function createRuntime(sessionId) {
    return {
      sessionId,
      state: "rebuilding",
      generation: 1,
      session: null,
      nextPendingCaptureSequence: 1,
      counts: { ...EMPTY_COUNTS },
      aggregation: createOrderAggregation(),
      latestProfileByCode: /* @__PURE__ */ new Map(),
      catalogProducts: Object.freeze([]),
      catalogByCode: /* @__PURE__ */ new Map(),
      dedupe: /* @__PURE__ */ new Map(),
      recent: [],
      rebuildBuffer: [],
      queue: [],
      queueHead: 0,
      timer: null,
      inflight: null,
      inflightTransaction: null,
      retryIndex: 0,
      constraintFailures: 0,
      constraintRebuilds: 0,
      readyPromise: null
    };
  }
  function createReadonlyRuntime(sessionId, session, recent, aggregation, catalogProducts) {
    const runtime = createRuntime(sessionId);
    runtime.state = "readonly";
    runtime.session = session;
    runtime.counts = { ...session?.counts ?? EMPTY_COUNTS };
    runtime.aggregation = aggregation;
    runtime.latestProfileByCode = buildLatestProfileByCode(session?.profileHistory);
    replaceRuntimeCatalog(runtime, catalogProducts);
    runtime.recent = [...recent].reverse();
    runtime.readyPromise = Promise.resolve(runtime);
    return runtime;
  }
  function pendingQueueCount(runtime) {
    return runtime.queue.length - runtime.queueHead;
  }
  function resequencePendingInserts(runtime, firstSequence) {
    let nextSequence = Number(firstSequence ?? 1);
    for (let index = runtime.queueHead; index < runtime.queue.length; index += 1) {
      const entry = runtime.queue[index];
      if (entry.type !== "insert") continue;
      entry.comment.captureSequence = nextSequence;
      for (const item of entry.items ?? []) item.captureSequence = nextSequence;
      nextSequence += 1;
    }
    runtime.nextPendingCaptureSequence = nextSequence;
  }
  function countsWithPending(sessionCounts, runtime) {
    const counts = { ...sessionCounts ?? EMPTY_COUNTS };
    for (let index = runtime.queueHead; index < runtime.queue.length; index += 1) {
      addCounts(counts, runtime.queue[index].delta);
    }
    return counts;
  }
  var IndexedCaptureStore = class {
    constructor(repository, options = {}) {
      this.repository = repository;
      this.now = options.now ?? (() => Date.now());
      this.setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
      this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
      this.debounceMs = options.debounceMs ?? 300;
      this.maxBatchSize = options.maxBatchSize ?? 250;
      this.isOwner = options.isOwner ?? (() => true);
      this.onWriteError = options.onWriteError ?? (() => {
      });
      this.onChange = options.onChange ?? (() => {
      });
      this.onCommit = options.onCommit ?? (() => {
      });
      this.requireCatalog = options.requireCatalog === true;
      this.runtimes = /* @__PURE__ */ new Map();
    }
    openSession(sessionId, options = {}) {
      const existing = this.runtimes.get(sessionId);
      if (existing?.readyPromise) return existing.readyPromise;
      const runtime = existing ?? createRuntime(sessionId);
      runtime.openOptions = options;
      this.runtimes.set(sessionId, runtime);
      runtime.readyPromise = this.initializeRuntime(runtime);
      return runtime.readyPromise;
    }
    async initializeRuntime(runtime) {
      const generation = runtime.generation;
      if (!this.isOwner(runtime.sessionId, generation)) {
        throw new Error("\u552F\u8B80\u5206\u9801\u4E0D\u5F97\u5EFA\u7ACB\u53EF\u5BEB\u5165\u7684 session runtime\u3002");
      }
      let session;
      let counts;
      let dedupe;
      let recent;
      let aggregation;
      let catalogProducts;
      while (true) {
        session = await this.repository.getSession(runtime.sessionId);
        const scanRevision = session.revision;
        counts = { ...EMPTY_COUNTS };
        dedupe = /* @__PURE__ */ new Map();
        recent = [];
        aggregation = createOrderAggregation();
        await this.repository.scanSessionComments(runtime.sessionId, (comment) => {
          dedupe.set(comment.commentId, {
            signature: comment.signature ?? JSON.stringify([
              comment.username ?? "",
              comment.rawMessage ?? "",
              Boolean(comment.isHost)
            ]),
            domAnomaly: Boolean(comment.domAnomaly)
          });
          addCounts(counts, counterDelta(comment.classification, comment.domAnomaly));
          recent.push(comment);
          if (recent.length > RECENT_LIMIT) recent.shift();
        });
        await this.repository.scanSessionItems(runtime.sessionId, (item) => {
          addItemToAggregation(aggregation, item);
        });
        catalogProducts = await this.repository.listCatalogProducts(runtime.sessionId);
        if (runtime.generation !== generation) return runtime;
        if (!this.isOwner(runtime.sessionId, generation)) {
          throw new Error("\u91CD\u5EFA\u671F\u9593\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\u3002");
        }
        const latest = await this.repository.getSession(runtime.sessionId, { create: false });
        if (!latest || latest.revision !== scanRevision) continue;
        session = latest;
        if (!countsEqual(session.counts, counts)) {
          const repair = await this.repairCounts(runtime, counts, scanRevision);
          if (!repair) continue;
          session = repair;
        }
        break;
      }
      runtime.session = session;
      runtime.counts = counts;
      runtime.dedupe = dedupe;
      runtime.recent = recent;
      runtime.aggregation = aggregation;
      runtime.latestProfileByCode = buildLatestProfileByCode(session.profileHistory);
      replaceRuntimeCatalog(runtime, catalogProducts);
      runtime.nextPendingCaptureSequence = session.nextCaptureSequence ?? 1;
      const requiresProfileUpgradePause = Boolean(
        runtime.session.config.activeCode && !runtime.session.config.specProfile
      );
      if (runtime.openOptions?.pauseOnOpen || requiresProfileUpgradePause) {
        const pauseResult = await this.persistCodeChange(
          runtime,
          null,
          requiresProfileUpgradePause ? "upgradeProfilePause" : "pause"
        );
        runtime.session = pauseResult.session;
        runtime.profileUpgradePaused = requiresProfileUpgradePause;
      }
      runtime.state = "ready";
      const buffered = runtime.rebuildBuffer.splice(0);
      for (const entry of buffered) {
        try {
          const [snapshot, originalContext, options] = entry.args;
          const context = {
            ...originalContext,
            activeCodeAtFirstSeen: originalContext.activeCodeAtFirstSeen === void 0 ? runtime.session.config.activeCode : originalContext.activeCodeAtFirstSeen,
            activationSequenceAtFirstSeen: originalContext.activationSequenceAtFirstSeen === void 0 ? runtime.session.config.activationSequence : originalContext.activationSequenceAtFirstSeen,
            profileAtFirstSeen: originalContext.profileAtFirstSeen === void 0 ? runtime.session.config.specProfile ?? null : originalContext.profileAtFirstSeen,
            latestProfileByCodeAtFirstSeen: originalContext.latestProfileByCodeAtFirstSeen === void 0 ? runtime.latestProfileByCode : originalContext.latestProfileByCodeAtFirstSeen,
            productMetaAtFirstSeen: originalContext.productMetaAtFirstSeen === void 0 ? {
              productName: runtime.session.config.productName ?? "",
              price: runtime.session.config.price ?? ""
            } : originalContext.productMetaAtFirstSeen
          };
          entry.resolve(await this.recordReady(runtime, snapshot, context, options));
        } catch (error) {
          entry.reject(error);
        }
      }
      this.onChange(runtime.sessionId);
      return runtime;
    }
    async repairCounts(runtime, counts, expectedRevision) {
      const generation = runtime.generation;
      if (!this.isOwner(runtime.sessionId, generation)) return null;
      return this.repository.runTransaction(
        [STORE_NAMES.SESSIONS],
        "readwrite",
        async ({ sessions }) => {
          const stored = await requestToPromise(sessions.get(runtime.sessionId));
          if (!stored || stored.revision !== expectedRevision || runtime.generation !== generation || !this.isOwner(runtime.sessionId, generation)) return null;
          const repaired = {
            ...stored,
            counts: { ...counts },
            revision: stored.revision + 1,
            updatedAt: nowIso(this.now())
          };
          await requestToPromise(sessions.put(repaired));
          return repaired;
        }
      );
    }
    async loadReadonlySession(sessionId) {
      const [session, recent, aggregation, catalogProducts] = await Promise.all([
        this.repository.getSession(sessionId, { create: false }),
        this.repository.readRecentComments(sessionId, RECENT_LIMIT),
        this.buildCommittedAggregation(sessionId),
        this.repository.listCatalogProducts(sessionId)
      ]);
      const runtime = createReadonlyRuntime(
        sessionId,
        session,
        recent,
        aggregation,
        catalogProducts
      );
      this.runtimes.set(sessionId, runtime);
      this.onChange(sessionId);
      return runtime;
    }
    getRuntime(sessionId) {
      return this.runtimes.get(sessionId) ?? null;
    }
    getLatestProfileByCode(sessionId) {
      return this.getRuntime(sessionId)?.latestProfileByCode ?? null;
    }
    getCatalogProduct(sessionId, productCode) {
      const code = normalizeProductCode(productCode);
      return code ? this.getRuntime(sessionId)?.catalogByCode.get(code) ?? null : null;
    }
    async reloadCatalog(sessionId) {
      const runtime = this.getRuntime(sessionId);
      if (!runtime) return null;
      const [session, products] = await Promise.all([
        this.repository.getSession(sessionId, { create: false }),
        this.repository.listCatalogProducts(sessionId)
      ]);
      if (!session) return null;
      runtime.session = session;
      replaceRuntimeCatalog(runtime, products);
      this.onChange(sessionId);
      return runtime;
    }
    async replaceCatalogProducts(sessionId, products) {
      await this.openSession(sessionId);
      const runtime = this.getRuntime(sessionId);
      await this.flushSession(sessionId);
      try {
        const saved = await this.repository.replaceCatalogProducts(sessionId, products, {
          expectedRevision: runtime.session.revision,
          expectedCatalogRevision: runtime.session.catalogRevision ?? 0,
          isCurrent: () => this.isOwner(sessionId, runtime.generation)
        });
        runtime.session = saved.session;
        replaceRuntimeCatalog(runtime, saved.products);
        this.onCommit(sessionId, saved.session.revision);
        this.onChange(sessionId);
        return saved;
      } catch (error) {
        if (error?.code === "REVISION_CONFLICT") await this.reloadCatalog(sessionId);
        throw error;
      }
    }
    async addCatalogProduct(sessionId, product) {
      await this.openSession(sessionId);
      const runtime = this.getRuntime(sessionId);
      await this.flushSession(sessionId);
      try {
        const saved = await this.repository.putCatalogProduct(sessionId, product, {
          expectedRevision: runtime.session.revision,
          expectedCatalogRevision: runtime.session.catalogRevision ?? 0,
          isCurrent: () => this.isOwner(sessionId, runtime.generation)
        });
        runtime.session = saved.session;
        replaceRuntimeCatalog(runtime, [...runtime.catalogProducts, saved.product]);
        this.onCommit(sessionId, saved.session.revision);
        this.onChange(sessionId);
        return saved;
      } catch (error) {
        if (["REVISION_CONFLICT", "CATALOG_PRODUCT_EXISTS"].includes(error?.code)) {
          await this.reloadCatalog(sessionId);
        }
        throw error;
      }
    }
    async buildCommittedAggregation(sessionId) {
      const aggregation = createOrderAggregation();
      await this.repository.scanSessionItems(sessionId, (item) => {
        addItemToAggregation(aggregation, item);
      });
      return aggregation;
    }
    async rebuildRuntimeAggregation(runtime, pendingEntries = []) {
      const aggregation = await this.buildCommittedAggregation(runtime.sessionId);
      for (const entry of pendingEntries) {
        if (entry.type !== "insert") continue;
        for (const item of entry.items ?? []) addItemToAggregation(aggregation, item);
      }
      runtime.aggregation = aggregation;
    }
    getSessionView(sessionId) {
      const runtime = this.getRuntime(sessionId);
      if (!runtime?.session) return null;
      return {
        ...runtime.session,
        counts: { ...runtime.counts },
        orderSummary: orderAggregationView(runtime.aggregation),
        recent: [...runtime.recent].reverse(),
        catalogProducts: [...runtime.catalogProducts],
        catalogByCode: new Map(runtime.catalogByCode),
        state: runtime.state,
        dirtyCount: pendingQueueCount(runtime)
      };
    }
    async recordCapture(sessionId, snapshot, context, options = {}) {
      let runtime = this.getRuntime(sessionId);
      if (!runtime) {
        if (!this.isOwner(sessionId, 0)) {
          return { inserted: false, anomaly: false, ignored: "not-owner" };
        }
        const readyPromise = this.openSession(sessionId);
        runtime = this.getRuntime(sessionId);
        if (runtime.state !== "ready") {
          return new Promise((resolve, reject) => {
            runtime.rebuildBuffer.push({
              args: [snapshot, context, options],
              resolve,
              reject
            });
            readyPromise.catch(reject);
          });
        }
      }
      if (runtime.state === "rebuilding") {
        return new Promise((resolve, reject) => {
          runtime.rebuildBuffer.push({ args: [snapshot, context, options], resolve, reject });
        });
      }
      if (runtime.state !== "ready" && runtime.state !== "retry_wait") {
        throw new Error("\u672C\u5834\u8CC7\u6599\u5C1A\u672A\u6E96\u5099\u5B8C\u6210\uFF0C\u66AB\u6642\u7121\u6CD5\u64F7\u53D6\u3002");
      }
      return this.recordReady(runtime, snapshot, context, options);
    }
    async recordReady(runtime, snapshot, context, options) {
      if (!this.isOwner(runtime.sessionId, runtime.generation)) {
        return { inserted: false, anomaly: false, ignored: "not-owner" };
      }
      const key = commentKey(snapshot, context.firstSeenAt);
      const nextSignature = signature(snapshot);
      const existing = runtime.dedupe.get(key);
      if (existing) {
        const anomaly = existing.signature !== nextSignature;
        if (anomaly && !existing.domAnomaly) {
          existing.domAnomaly = true;
          addCounts(runtime.counts, anomalyDelta());
          runtime.queue.push({
            type: "anomaly",
            sessionId: runtime.sessionId,
            commentId: key,
            delta: anomalyDelta(),
            generation: runtime.generation
          });
          this.scheduleFlush(runtime);
          this.onChange(runtime.sessionId);
        }
        return { inserted: false, anomaly };
      }
      const captureOrigin = context.captureOrigin ?? CAPTURE_ORIGINS.OBSERVER;
      const result = classifyMessage(snapshot.rawMessage, {
        activeCode: context.activeCodeAtFirstSeen,
        specProfile: context.profileAtFirstSeen,
        captureOrigin,
        stable: options.stable !== false,
        hasReliableCommentId: Boolean(snapshot.commentId),
        isHost: snapshot.isHost === true,
        latestProfileByCode: context.latestProfileByCodeAtFirstSeen
      });
      const firstSeenAt = nowIso(context.firstSeenAt);
      const captureSequence = runtime.nextPendingCaptureSequence;
      runtime.nextPendingCaptureSequence += 1;
      const comment = {
        sessionId: runtime.sessionId,
        commentId: key,
        sourceCommentId: snapshot.commentId || null,
        signature: nextSignature,
        uid: snapshot.uid ?? "",
        username: snapshot.username,
        rawMessage: snapshot.rawMessage,
        normalizedMessage: result.normalizedMessage,
        firstSeenAt,
        captureSequence,
        captureOrigin,
        activeCodeAtFirstSeen: context.activeCodeAtFirstSeen ?? null,
        activationSequenceAtFirstSeen: context.activationSequenceAtFirstSeen ?? 0,
        classification: result.classification,
        isHost: snapshot.isHost === true,
        domAnomaly: false
      };
      const parsedItems = result.items ?? (result.item ? [result.item] : []);
      const items = parsedItems.map((parsedItem, itemIndex) => {
        const productMetadata = productMetadataForParsedItem(parsedItem, context);
        const segmentIndex = parsedItem.segmentIndex ?? itemIndex;
        const expansionIndex = Number.isSafeInteger(parsedItem.expansionIndex) ? parsedItem.expansionIndex : null;
        const expansionSuffix = expansionIndex == null ? "" : `:e${String(expansionIndex).padStart(4, "0")}`;
        return {
          sessionId: runtime.sessionId,
          itemId: `${key}:s${String(segmentIndex).padStart(4, "0")}${expansionSuffix}`,
          sourceCommentId: key,
          capturedAt: firstSeenAt,
          captureSequence,
          activationSequence: context.activationSequenceAtFirstSeen ?? 0,
          uid: comment.uid,
          username: comment.username,
          rawMessage: comment.rawMessage,
          normalizedMessage: comment.normalizedMessage,
          productCode: parsedItem.productCode,
          variantOrSize: parsedItem.variantOrSize,
          specifications: parsedItem.specifications,
          specKey: parsedItem.specKey,
          quantity: parsedItem.quantity,
          segmentIndex,
          ...expansionIndex == null ? {} : { expansionIndex },
          segmentRaw: parsedItem.segmentRaw ?? comment.normalizedMessage,
          status: parsedItem.status,
          needsReview: parsedItem.needsReview,
          reviewReason: parsedItem.reviewReason ?? null,
          ruleVersion: parsedItem.ruleVersion ?? 0,
          profileRevision: parsedItem.profileRevision ?? null,
          productName: productNameForParsedItem(parsedItem, context, productMetadata),
          price: priceForParsedItem(parsedItem, context, productMetadata),
          captureOrigin
        };
      });
      const delta = counterDelta(result.classification);
      runtime.dedupe.set(key, { signature: nextSignature, domAnomaly: false });
      addCounts(runtime.counts, delta);
      runtime.recent.push(comment);
      if (runtime.recent.length > RECENT_LIMIT) runtime.recent.shift();
      for (const item of items) addItemToAggregation(runtime.aggregation, item);
      runtime.queue.push({
        type: "insert",
        comment,
        items,
        delta,
        generation: runtime.generation
      });
      this.scheduleFlush(runtime);
      this.onChange(runtime.sessionId);
      return {
        inserted: true,
        anomaly: false,
        comment,
        items,
        item: items[0] ?? null
      };
    }
    scheduleFlush(runtime, delay = this.debounceMs) {
      if (runtime.timer != null || runtime.inflight) return;
      if (pendingQueueCount(runtime) >= this.maxBatchSize) delay = 0;
      runtime.timer = this.setTimeout(() => {
        runtime.timer = null;
        this.flushSession(runtime.sessionId, { throwOnError: false }).catch(() => {
        });
      }, delay);
    }
    cancelTimer(runtime) {
      if (runtime.timer != null) this.clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    async flushSession(sessionId, { throwOnError = true } = {}) {
      const runtime = this.getRuntime(sessionId);
      if (!runtime || pendingQueueCount(runtime) === 0) return runtime?.session ?? null;
      this.cancelTimer(runtime);
      if (runtime.inflight) return runtime.inflight;
      runtime.inflight = this.flushLoop(runtime, throwOnError).finally(() => {
        runtime.inflight = null;
      });
      return runtime.inflight;
    }
    async flushLoop(runtime, throwOnError) {
      while (pendingQueueCount(runtime) > 0) {
        const batch = runtime.queue.slice(
          runtime.queueHead,
          runtime.queueHead + this.maxBatchSize
        );
        try {
          const saved = await this.commitBatch(runtime, batch);
          if (runtime.generation !== batch[0]?.generation || !this.isOwner(runtime.sessionId, runtime.generation)) return runtime.session;
          runtime.queueHead += batch.length;
          if (runtime.queueHead >= 1e3 && runtime.queueHead * 2 >= runtime.queue.length) {
            runtime.queue = runtime.queue.slice(runtime.queueHead);
            runtime.queueHead = 0;
          }
          runtime.session = saved;
          runtime.retryIndex = 0;
          runtime.constraintFailures = 0;
          runtime.constraintRebuilds = 0;
          runtime.state = "ready";
          this.onCommit(runtime.sessionId, saved.revision);
        } catch (error) {
          if (runtime.generation !== batch[0]?.generation || !this.isOwner(runtime.sessionId, runtime.generation)) {
            runtime.state = "readonly";
            return runtime.session;
          }
          if (error?.code === "REVISION_CONFLICT") {
            const latest = await this.repository.getSession(runtime.sessionId, { create: false });
            if (!latest) throw error;
            runtime.session = latest;
            runtime.counts = countsWithPending(latest.counts, runtime);
            resequencePendingInserts(runtime, latest.nextCaptureSequence);
            await this.rebuildRuntimeAggregation(
              runtime,
              runtime.queue.slice(runtime.queueHead)
            );
            continue;
          }
          if (error?.name === "ConstraintError") {
            if (await this.recoverConstraint(runtime, batch)) {
              runtime.constraintFailures = 0;
              runtime.constraintRebuilds = 0;
              continue;
            }
            runtime.constraintFailures += 1;
            if (runtime.constraintFailures >= 3) {
              if (runtime.constraintRebuilds >= 1) {
                error.code = "CONSTRAINT_RECOVERY_FAILED";
              } else {
                await this.rebuildAfterConstraint(runtime);
                runtime.constraintRebuilds += 1;
                runtime.constraintFailures = 0;
                continue;
              }
            }
            if (error.code !== "CONSTRAINT_RECOVERY_FAILED") continue;
          }
          runtime.state = "retry_wait";
          this.onWriteError(error, {
            sessionId: runtime.sessionId,
            dirtyCount: pendingQueueCount(runtime)
          });
          const delay = RETRY_DELAYS_MS[Math.min(runtime.retryIndex, RETRY_DELAYS_MS.length - 1)];
          runtime.retryIndex += 1;
          this.cancelTimer(runtime);
          runtime.timer = this.setTimeout(() => {
            runtime.timer = null;
            this.flushSession(runtime.sessionId, { throwOnError: false }).catch(() => {
            });
          }, delay);
          if (throwOnError) throw error;
          return runtime.session;
        }
      }
      this.onChange(runtime.sessionId);
      return runtime.session;
    }
    async commitBatch(runtime, batch) {
      const generation = runtime.generation;
      if (!this.isOwner(runtime.sessionId, generation)) {
        const error = new Error("\u672C\u5206\u9801\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\uFF0C\u5DF2\u53D6\u6D88\u672A\u63D0\u4EA4\u8CC7\u6599\u3002");
        error.code = "LOCK_LOST";
        throw error;
      }
      let activeTransaction = null;
      try {
        return await this.repository.runTransaction(
          [STORE_NAMES.SESSIONS, STORE_NAMES.COMMENTS, STORE_NAMES.ITEMS],
          "readwrite",
          async ({ sessions, comments, items }, transaction) => {
            activeTransaction = transaction;
            runtime.inflightTransaction = transaction;
            const stored = await requestToPromise(sessions.get(runtime.sessionId));
            if (runtime.generation !== generation || !this.isOwner(runtime.sessionId, generation)) {
              const error = new Error("\u672C\u5206\u9801\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\uFF0Ctransaction \u5DF2\u53D6\u6D88\u3002");
              error.code = "LOCK_LOST";
              throw error;
            }
            if (stored.revision !== runtime.session.revision) {
              const error = new Error("\u8CC7\u6599\u7248\u672C\u5DF2\u66F4\u65B0\uFF0C\u5FC5\u9808\u91CD\u65B0\u5EFA\u7ACB\u7D22\u5F15\u3002");
              error.code = "REVISION_CONFLICT";
              throw error;
            }
            let nextSequence = stored.nextCaptureSequence;
            const batchDelta = { ...EMPTY_COUNTS };
            const writeRequests = [];
            for (const entry of batch) {
              if (entry.generation !== generation) continue;
              addCounts(batchDelta, entry.delta);
              if (entry.type === "insert") {
                const captureSequence = nextSequence;
                nextSequence += 1;
                writeRequests.push(
                  requestToPromise(comments.add({ ...entry.comment, captureSequence }))
                );
                for (const item of entry.items ?? []) {
                  writeRequests.push(
                    requestToPromise(items.add({ ...item, captureSequence }))
                  );
                }
              } else if (entry.type === "anomaly") {
                const existing = await requestToPromise(
                  comments.get([entry.sessionId, entry.commentId])
                );
                if (existing && !existing.domAnomaly) {
                  writeRequests.push(
                    requestToPromise(comments.put({ ...existing, domAnomaly: true }))
                  );
                }
              }
            }
            await Promise.all(writeRequests);
            const saved = {
              ...stored,
              nextCaptureSequence: nextSequence,
              revision: stored.revision + 1,
              updatedAt: nowIso(this.now()),
              counts: addCounts({ ...stored.counts }, batchDelta)
            };
            await requestToPromise(sessions.put(saved));
            return saved;
          }
        );
      } finally {
        if (runtime.inflightTransaction === activeTransaction) {
          runtime.inflightTransaction = null;
        }
      }
    }
    async recoverConstraint(runtime, batch) {
      const inserts = batch.filter((entry) => entry.type === "insert");
      if (!inserts.length) return false;
      const storedRows = await this.repository.getComments(
        runtime.sessionId,
        inserts.map((entry) => entry.comment.commentId)
      );
      const resolved = /* @__PURE__ */ new Set();
      const anomalyEntries = [];
      for (let index = 0; index < inserts.length; index += 1) {
        const entry = inserts[index];
        const stored = storedRows[index];
        if (!stored) continue;
        resolved.add(entry);
        const storedSignature = stored.signature ?? JSON.stringify([
          stored.username ?? "",
          stored.rawMessage ?? "",
          Boolean(stored.isHost)
        ]);
        const changed = storedSignature !== entry.comment.signature;
        runtime.dedupe.set(stored.commentId, {
          signature: storedSignature,
          domAnomaly: Boolean(stored.domAnomaly || changed)
        });
        if (changed && !stored.domAnomaly) {
          anomalyEntries.push({
            type: "anomaly",
            sessionId: runtime.sessionId,
            commentId: stored.commentId,
            delta: anomalyDelta(),
            generation: runtime.generation
          });
        }
      }
      if (!resolved.size) return false;
      const before = runtime.queue.slice(0, runtime.queueHead);
      const pending = runtime.queue.slice(runtime.queueHead).filter((entry) => !resolved.has(entry));
      runtime.queue = [...before, ...pending, ...anomalyEntries];
      const latest = await this.repository.getSession(runtime.sessionId, { create: false });
      if (!latest) return false;
      runtime.session = latest;
      runtime.counts = countsWithPending(latest.counts, runtime);
      const recent = await this.repository.readRecentComments(runtime.sessionId, RECENT_LIMIT);
      runtime.recent = [...recent].reverse();
      for (const entry of pending) {
        if (entry.type !== "insert") continue;
        runtime.recent.push(entry.comment);
        if (runtime.recent.length > RECENT_LIMIT) runtime.recent.shift();
      }
      resequencePendingInserts(runtime, latest.nextCaptureSequence);
      await this.rebuildRuntimeAggregation(runtime, pending);
      return true;
    }
    async rebuildAfterConstraint(runtime) {
      const pending = runtime.queue.slice(runtime.queueHead);
      runtime.state = "rebuilding";
      const session = await this.repository.getSession(runtime.sessionId, { create: false });
      if (!session) throw new Error("ConstraintError \u91CD\u5EFA\u6642\u627E\u4E0D\u5230\u672C\u5834\u8CC7\u6599\u3002");
      const counts = { ...EMPTY_COUNTS };
      const dedupe = /* @__PURE__ */ new Map();
      const recent = [];
      let maxSequence = 0;
      await this.repository.scanSessionComments(runtime.sessionId, (comment) => {
        maxSequence = Math.max(maxSequence, comment.captureSequence ?? 0);
        dedupe.set(comment.commentId, {
          signature: comment.signature ?? JSON.stringify([
            comment.username ?? "",
            comment.rawMessage ?? "",
            Boolean(comment.isHost)
          ]),
          domAnomaly: Boolean(comment.domAnomaly)
        });
        addCounts(counts, counterDelta(comment.classification, comment.domAnomaly));
        recent.push(comment);
        if (recent.length > RECENT_LIMIT) recent.shift();
      });
      const remaining = pending.filter((entry) => entry.type !== "insert" || !dedupe.has(entry.comment.commentId));
      runtime.queue = remaining;
      runtime.queueHead = 0;
      runtime.dedupe = dedupe;
      runtime.recent = recent;
      runtime.session = session;
      if (session.nextCaptureSequence <= maxSequence) {
        runtime.session = await this.repository.runTransaction(
          [STORE_NAMES.SESSIONS],
          "readwrite",
          async ({ sessions }) => {
            const stored = await requestToPromise(sessions.get(runtime.sessionId));
            if (!this.isOwner(runtime.sessionId, runtime.generation)) {
              throw new Error("\u91CD\u5EFA\u671F\u9593\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\u3002");
            }
            const saved = {
              ...stored,
              nextCaptureSequence: maxSequence + 1,
              revision: stored.revision + 1,
              updatedAt: nowIso(this.now())
            };
            await requestToPromise(sessions.put(saved));
            return saved;
          }
        );
      }
      runtime.counts = countsWithPending(runtime.session.counts, runtime);
      resequencePendingInserts(runtime, runtime.session.nextCaptureSequence);
      await this.rebuildRuntimeAggregation(runtime, remaining);
      for (const entry of remaining) {
        if (entry.type !== "insert") continue;
        runtime.dedupe.set(entry.comment.commentId, {
          signature: entry.comment.signature,
          domAnomaly: false
        });
        runtime.recent.push(entry.comment);
        if (runtime.recent.length > RECENT_LIMIT) runtime.recent.shift();
      }
      runtime.state = "ready";
    }
    async changeActiveCode(sessionId, rawCode, specProfile, action, metadata = {}) {
      await this.openSession(sessionId);
      const runtime = this.getRuntime(sessionId);
      const code = rawCode == null ? null : normalizeProductCode(rawCode);
      if (rawCode != null && !code) {
        throw new Error("\u5546\u54C1\u78BC\u5FC5\u9808\u662F\u4E00\u500B\u82F1\u6587\u5B57\u6BCD\u52A0\u5169\u6216\u4E09\u4F4D\u6578\u5B57\uFF0C\u4F8B\u5982 A01 \u6216 A010\u3002");
      }
      const catalogProduct = code ? runtime.catalogByCode.get(code) ?? null : null;
      if (code && this.requireCatalog && !catalogProduct) {
        const error = new Error("\u6B64\u5546\u54C1\u78BC\u5C1A\u672A\u52A0\u5165\u672C\u5834\u5546\u54C1\u6E05\u55AE\uFF0C\u8ACB\u5148\u55AE\u7B46\u65B0\u589E\u6216\u91CD\u65B0\u532F\u5165\u3002");
        error.code = "CATALOG_PRODUCT_REQUIRED";
        throw error;
      }
      const sourceProfile = specProfile ?? catalogProduct?.specProfile;
      let validatedProfile;
      if (code && sourceProfile !== void 0) {
        validatedProfile = persistedSpecProfile(sourceProfile, 0);
      }
      await this.flushSession(sessionId);
      const sameActiveCode = Boolean(
        code && code === runtime.session.config.activeCode && sourceProfile !== void 0
      );
      const resolvedMetadata = {
        productName: catalogProduct?.productName ?? metadata.productName ?? "",
        price: catalogProduct?.price ?? metadata.price ?? ""
      };
      if (code && this.requireCatalog && !resolvedMetadata.price) {
        const error = new Error("\u5546\u54C1\u50F9\u683C\u907A\u5931\uFF0C\u8ACB\u91CD\u65B0\u52A0\u5165\u5546\u54C1\u6E05\u55AE\u3002");
        error.code = "CATALOG_PRICE_REQUIRED";
        throw error;
      }
      const result = sameActiveCode ? await this.persistProfileUpdate(runtime, validatedProfile, resolvedMetadata) : await this.persistCodeChange(
        runtime,
        code,
        action,
        validatedProfile,
        resolvedMetadata
      );
      runtime.session = result.session;
      if (result.updatedCatalogProduct) {
        replaceRuntimeCatalog(runtime, runtime.catalogProducts.map((product) => product.productCode === result.updatedCatalogProduct.productCode ? result.updatedCatalogProduct : product));
      }
      const latestHistoryEntry = result.session.profileHistory?.at(-1);
      runtime.latestProfileByCode = appendLatestProfile(
        runtime.latestProfileByCode,
        latestHistoryEntry
      );
      this.onChange(sessionId);
      return result.session;
    }
    async persistCodeChange(runtime, code, action, specProfile, metadata = {}) {
      const sessionId = runtime.sessionId;
      const generation = runtime.generation;
      const saved = await this.repository.runTransaction(
        [STORE_NAMES.SESSIONS, STORE_NAMES.CATALOG_PRODUCTS],
        "readwrite",
        async ({ sessions, catalogProducts }) => {
          const stored = await requestToPromise(sessions.get(sessionId));
          if (!this.isOwner(sessionId, generation)) throw new Error("\u672C\u5206\u9801\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\u3002");
          const storedCatalogProduct = code ? await requestToPromise(catalogProducts.get([sessionId, code])) : null;
          if (code && this.requireCatalog && !storedCatalogProduct) {
            const error = new Error("\u6B64\u5546\u54C1\u78BC\u5DF2\u4E0D\u5728\u672C\u5834\u5546\u54C1\u6E05\u55AE\uFF0C\u8ACB\u91CD\u65B0\u8F09\u5165\u3002");
            error.code = "CATALOG_PRODUCT_REQUIRED";
            throw error;
          }
          const activationSequence = stored.config.activationSequence + 1;
          const activatedAt = nowIso(this.now());
          const profileRevision = (stored.config.profileRevision ?? 0) + 1;
          const savedProfile = code && specProfile ? persistedSpecProfile(specProfile, profileRevision) : null;
          const catalogProfileChanged = Boolean(
            storedCatalogProduct && savedProfile && profileContentSignature(storedCatalogProduct.specProfile) !== profileContentSignature(savedProfile)
          );
          const updatedCatalogProduct = catalogProfileChanged ? { ...storedCatalogProduct, specProfile: savedProfile } : null;
          if (updatedCatalogProduct) {
            await requestToPromise(catalogProducts.put(updatedCatalogProduct));
          }
          const productName = storedCatalogProduct?.productName ?? metadata.productName ?? "";
          const price = storedCatalogProduct?.price ?? metadata.price ?? "";
          const resolvedAction = action ?? (code == null ? "pause" : stored.config.activeCode == null ? "activate" : "switch");
          const next = {
            ...stored,
            schemaVersion: SESSION_SCHEMA_VERSION,
            revision: stored.revision + 1,
            catalogRevision: (stored.catalogRevision ?? 0) + (catalogProfileChanged ? 1 : 0),
            updatedAt: activatedAt,
            config: {
              activeCode: code,
              activationSequence,
              activatedAt,
              profileRevision,
              specProfile: savedProfile,
              productName: code ? productName : "",
              price: code ? price : ""
            },
            history: [...stored.history, {
              sessionId,
              activationSequence,
              previousCode: stored.config.activeCode,
              activeCode: code,
              activatedAt,
              action: resolvedAction,
              profileRevision
            }],
            profileHistory: savedProfile ? [...stored.profileHistory ?? [], {
              sessionId,
              activationSequence,
              profileRevision,
              activeCode: code,
              appliedAt: activatedAt,
              action: resolvedAction,
              specProfile: savedProfile,
              productName,
              price
            }] : [...stored.profileHistory ?? []]
          };
          await requestToPromise(sessions.put(next));
          return { session: next, updatedCatalogProduct };
        }
      );
      this.onCommit(sessionId, saved.session.revision);
      return saved;
    }
    async persistProfileUpdate(runtime, specProfile, metadata = {}) {
      const sessionId = runtime.sessionId;
      const generation = runtime.generation;
      const saved = await this.repository.runTransaction(
        [STORE_NAMES.SESSIONS, STORE_NAMES.CATALOG_PRODUCTS],
        "readwrite",
        async ({ sessions, catalogProducts }) => {
          const stored = await requestToPromise(sessions.get(sessionId));
          if (!this.isOwner(sessionId, generation)) {
            throw new Error("\u672C\u5206\u9801\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\u3002");
          }
          if (!stored?.config?.activeCode) {
            throw new Error("\u6536\u55AE\u5DF2\u66AB\u505C\uFF0C\u7121\u6CD5\u66F4\u65B0\u898F\u683C\u3002");
          }
          const profileRevision = (stored.config.profileRevision ?? 0) + 1;
          const appliedAt = nowIso(this.now());
          const savedProfile = persistedSpecProfile(specProfile, profileRevision);
          const activeCode = stored.config.activeCode;
          const storedCatalogProduct = await requestToPromise(
            catalogProducts.get([sessionId, activeCode])
          );
          if (this.requireCatalog && !storedCatalogProduct) {
            const error = new Error("\u76EE\u524D\u5546\u54C1\u5DF2\u4E0D\u5728\u5546\u54C1\u6E05\u55AE\uFF0C\u8ACB\u5148\u91CD\u65B0\u52A0\u5165\u518D\u66F4\u65B0\u898F\u683C\u3002");
            error.code = "CATALOG_PRODUCT_REQUIRED";
            throw error;
          }
          const catalogProfileChanged = Boolean(
            storedCatalogProduct && profileContentSignature(storedCatalogProduct.specProfile) !== profileContentSignature(savedProfile)
          );
          const updatedCatalogProduct = catalogProfileChanged ? { ...storedCatalogProduct, specProfile: savedProfile } : null;
          if (updatedCatalogProduct) {
            await requestToPromise(catalogProducts.put(updatedCatalogProduct));
          }
          const productName = storedCatalogProduct?.productName ?? metadata.productName ?? stored.config.productName ?? "";
          const price = storedCatalogProduct?.price ?? metadata.price ?? stored.config.price ?? "";
          const next = {
            ...stored,
            schemaVersion: SESSION_SCHEMA_VERSION,
            revision: stored.revision + 1,
            catalogRevision: (stored.catalogRevision ?? 0) + (catalogProfileChanged ? 1 : 0),
            updatedAt: appliedAt,
            config: {
              ...stored.config,
              profileRevision,
              specProfile: savedProfile,
              productName,
              price
            },
            profileHistory: [...stored.profileHistory ?? [], {
              sessionId,
              activationSequence: stored.config.activationSequence,
              profileRevision,
              activeCode: stored.config.activeCode,
              appliedAt,
              action: "profileUpdate",
              specProfile: savedProfile,
              productName,
              price
            }]
          };
          await requestToPromise(sessions.put(next));
          return { session: next, updatedCatalogProduct };
        }
      );
      this.onCommit(sessionId, saved.session.revision);
      return saved;
    }
    pause(sessionId) {
      return this.changeActiveCode(sessionId, null, void 0, "pause");
    }
    discardSession(sessionId) {
      const runtime = this.getRuntime(sessionId);
      if (!runtime) return;
      runtime.generation += 1;
      this.cancelTimer(runtime);
      try {
        runtime.inflightTransaction?.abort();
      } catch {
      }
      runtime.inflightTransaction = null;
      runtime.queue.length = 0;
      runtime.queueHead = 0;
      runtime.rebuildBuffer.length = 0;
      runtime.state = "closed";
      this.runtimes.delete(sessionId);
    }
    isDirty(sessionId) {
      const runtime = this.getRuntime(sessionId);
      return Boolean(runtime && pendingQueueCount(runtime) > 0);
    }
  };

  // src/catalog-import.js
  var CATALOG_HEADERS = Object.freeze([
    "\u5546\u54C1\u78BC",
    "\u54C1\u540D",
    "\u984F\u8272",
    "\u5C3A\u5BF8",
    "\u50F9\u683C"
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
          "\u5C3A\u5BF8\u7BC4\u570D\u683C\u5F0F\u932F\u8AA4\uFF1B\u8ACB\u4F7F\u7528 38\uFF5E44 \u6216 35\uFF5E45\uFF08\u542B\u534A\u78BC\uFF09\u3002"
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
          "\u5C3A\u5BF8\u7BC4\u570D\u8D77\u9EDE\u4E0D\u53EF\u5927\u65BC\u7D42\u9EDE\u3002"
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
          "\u5C3A\u5BF8\u7BC4\u570D\u7AEF\u9EDE\u5FC5\u9808\u662F\u6574\u6578\uFF1B\u542B\u534A\u78BC\u7BC4\u570D\u53EF\u4F7F\u7528 0.5\u3002"
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
          `\u5C3A\u5BF8\u7BC4\u570D\u5C55\u958B\u5F8C\u4E0D\u53EF\u8D85\u904E ${CATALOG_LIMITS.maxTokensPerDimension} \u500B\u503C\u3002`
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
            `\u91CD\u8907\u95DC\u9375\u5B57\u300C${expandedValue}\u300D\u5DF2\u5408\u4F75\u3002`,
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
        `${field === "styles" ? "\u984F\u8272" : "\u5C3A\u5BF8"}\u6700\u591A ${CATALOG_LIMITS.maxTokensPerDimension} \u500B\u503C\u3002`
      ));
    }
    return { values, errors, warnings };
  }
  function messageForProfileError(error) {
    const value = error.value ? `\u300C${error.value}\u300D` : "";
    const messages = {
      emptySelectedCustomKeyword: "\u9078\u53D6\u7684\u81EA\u8A02\u95DC\u9375\u5B57\u4E0D\u53EF\u7A7A\u767D\u3002",
      invalidCustomKeyword: `\u81EA\u8A02\u95DC\u9375\u5B57${value}\u683C\u5F0F\u932F\u8AA4\u6216\u8D85\u904E 10 \u500B\u5B57\u3002`,
      customKeywordIsProductCode: `\u81EA\u8A02\u95DC\u9375\u5B57${value}\u4E0D\u53EF\u9577\u5F97\u50CF\u5546\u54C1\u78BC\u3002`,
      customKeywordIsReserved: `\u81EA\u8A02\u95DC\u9375\u5B57${value}\u4E0D\u53EF\u4F7F\u7528\u4FDD\u7559\u5B57\u300C${PACKAGE_COLOR_KEYWORD}\u300D\u3002`,
      duplicateCustomKeyword: `\u81EA\u8A02\u95DC\u9375\u5B57${value}\u8207\u65E2\u6709\u95DC\u9375\u5B57\u91CD\u8907\u3002`,
      invalidCustomKeywordDimension: `\u81EA\u8A02\u95DC\u9375\u5B57${value}\u7684\u984F\u8272\uFF0F\u5C3A\u5BF8\u5206\u985E\u7121\u6548\u3002`,
      unknownSelectedKeyword: `\u627E\u4E0D\u5230\u9078\u53D6\u7684\u95DC\u9375\u5B57${value}\u3002`,
      noSelectedKeywords: "\u6709\u898F\u683C\u5546\u54C1\u81F3\u5C11\u9700\u8981\u4E00\u500B\u984F\u8272\u6216\u5C3A\u5BF8\u3002",
      noSpecsHasSelections: "\u7121\u898F\u683C\u5546\u54C1\u4E0D\u53EF\u540C\u6642\u9078\u53D6\u984F\u8272\u6216\u5C3A\u5BF8\u3002"
    };
    return messages[error.code] ?? `\u898F\u683C\u8A2D\u5B9A\u932F\u8AA4\uFF1A${error.code}`;
  }
  function normalizePriceText(value, options = {}) {
    const normalized = String(value ?? "").normalize("NFKC").trim();
    if (!normalized) {
      if (options.priceRequired !== true) {
        return { valid: true, value: "999", priceIsProvisional: true };
      }
      return { valid: false, value: "", reason: "\u50F9\u683C\u70BA\u5FC5\u586B\u3002", code: "priceRequired" };
    }
    if (!PRICE_PATTERN.test(normalized)) {
      return {
        valid: false,
        value: normalized,
        reason: "\u50F9\u683C\u53EA\u80FD\u4F7F\u7528\u6578\u5B57\u8207\u5C0F\u6578\u9EDE\uFF0C\u4E0D\u53EF\u542B\u9017\u865F\u3001\u8CA8\u5E63\u7B26\u865F\u3001\u8CA0\u865F\u6216\u6307\u6578\u3002",
        code: "invalidPrice"
      };
    }
    return options.priceIsProvisional === true && normalized === "999" ? { valid: true, value: normalized, priceIsProvisional: true } : { valid: true, value: normalized };
  }
  function buildImportedSpecProfile({ styles: styles2 = [], sizes = [] } = {}) {
    const customStyles = styles2.filter((value) => !BUILTIN_STYLES.has(canonicalizeSpecKeyword(value)));
    const customSizes = sizes.filter((value) => !BUILTIN_SIZES.has(canonicalizeSpecKeyword(value)));
    const selectedStyles = styles2.filter((value) => BUILTIN_STYLES.has(canonicalizeSpecKeyword(value)));
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
      mode: styles2.length || sizes.length ? "withSpecs" : "noSpecs",
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
        "\u5546\u54C1\u78BC\u70BA\u5FC5\u586B\u3002"
      ));
    } else if (!productCode) {
      errors.push(issue(
        "invalidProductCode",
        "productCode",
        sourceRow,
        rawCode,
        "\u5546\u54C1\u78BC\u5FC5\u9808\u662F\u4E00\u500B\u82F1\u6587\u5B57\u6BCD\u52A0\u5169\u6216\u4E09\u4F4D\u6578\u5B57\uFF0C\u4F8B\u5982 A01 \u6216 A010\u3002"
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
        `\u54C1\u540D\u4E0D\u53EF\u8D85\u904E ${CATALOG_LIMITS.maxProductNameCodePoints} \u500B\u5B57\u3002`
      ));
    }
    for (const [field, value] of Object.entries(fields)) {
      if (codePointLength2(value) > CATALOG_LIMITS.maxFieldCodePoints) {
        errors.push(issue(
          "catalogFieldTooLong",
          field,
          sourceRow,
          value,
          `\u55AE\u4E00\u6B04\u4F4D\u4E0D\u53EF\u8D85\u904E ${CATALOG_LIMITS.maxFieldCodePoints} \u500B\u5B57\u3002`
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
        `\u95DC\u9375\u5B57\u300C${value}\u300D\u4E0D\u53EF\u540C\u6642\u7576\u984F\u8272\u8207\u5C3A\u5BF8\u3002`
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
        `\u6BCF\u500B\u5546\u54C1\u6700\u591A ${CATALOG_LIMITS.maxCustomTokens} \u500B\u81EA\u8A02\u95DC\u9375\u5B57\u3002`
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
        "\u7121\u898F\u683C\uFF1B\u8ACB\u78BA\u8A8D\u4E0D\u662F\u6F0F\u586B\u984F\u8272\u8207\u5C3A\u5BF8\u3002",
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
        stylesText: stylesResult.values.join("\u3001"),
        sizesText: sizesResult.values.join("\u3001"),
        price: price.value
      }
    };
  }
  function isHeader(fields) {
    return CATALOG_HEADERS.every((value, index) => normalizeCell(fields[index], { preserveInternalWhitespace: true }) === value);
  }
  function parseCatalogTsv(text, options = {}) {
    const rawText = String(text ?? "").replace(/^\uFEFF/u, "");
    const rows = [];
    const globalErrors = [];
    if (codePointLength2(rawText) > (options.maxTextCodePoints ?? CATALOG_LIMITS.maxTextCodePoints)) {
      globalErrors.push(issue(
        "catalogTextTooLong",
        "catalog",
        null,
        "",
        `\u8CBC\u4E0A\u5167\u5BB9\u4E0D\u53EF\u8D85\u904E ${options.maxTextCodePoints ?? CATALOG_LIMITS.maxTextCodePoints} \u500B\u5B57\u3002`
      ));
      return {
        rows,
        validProducts: [],
        errors: globalErrors,
        warnings: [],
        hasBlockingErrors: true
      };
    }
    const nonEmptyLines = rawText.split(/\r?\n/u).map((line, index) => ({ line, sourceRow: index + 1 })).filter(({ line }) => line.trim() !== "");
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
        `\u4E00\u6B21\u6700\u591A\u532F\u5165 ${options.maxRows ?? CATALOG_LIMITS.maxRows} \u500B\u5546\u54C1\u3002`
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
            `\u7B2C ${sourceRow} \u5217\u5FC5\u9808\u6070\u597D\u4E94\u6B04\uFF0C\u76EE\u524D\u70BA ${rawFields.length} \u6B04\u3002`
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
          `\u5546\u54C1\u78BC ${code} \u91CD\u8907\uFF1B\u6240\u6709\u540C\u78BC\u5217\u5747\u4E0D\u5957\u7528\u3002`
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

  // src/csv.js
  var ORDER_HEADERS = [
    "\u64F7\u53D6\u6642\u9593",
    "\u76F4\u64ADSession",
    "\u9650\u5B9A\u6642\u6BB5\u5E8F\u865F",
    "\u7559\u8A00ID",
    "\u8CB7\u5BB6UID",
    "\u8CB7\u5BB6\u5E33\u865F",
    "\u539F\u59CB\u7559\u8A00",
    "\u6B63\u898F\u5316\u7559\u8A00",
    "\u5546\u54C1\u4EE3\u865F",
    "\u54C1\u540D",
    "\u898F\u683C\u5C3A\u5BF8",
    "\u6578\u91CF",
    "\u50F9\u683C",
    "\u72C0\u614B",
    "\u5F85\u78BA\u8A8D",
    "\u4F86\u6E90",
    "\u558A\u55AE\u5247\u6578",
    "\u5F59\u7E3D\u4EF6\u6578"
  ];
  var CSV_COLUMN_INDEX = Object.freeze({
    SESSION_ID: ORDER_HEADERS.indexOf("\u76F4\u64ADSession"),
    COMMENT_ID: ORDER_HEADERS.indexOf("\u7559\u8A00ID"),
    BUYER_UID: ORDER_HEADERS.indexOf("\u8CB7\u5BB6UID"),
    BUYER_USERNAME: ORDER_HEADERS.indexOf("\u8CB7\u5BB6\u5E33\u865F"),
    RAW_MESSAGE: ORDER_HEADERS.indexOf("\u539F\u59CB\u7559\u8A00"),
    NORMALIZED_MESSAGE: ORDER_HEADERS.indexOf("\u6B63\u898F\u5316\u7559\u8A00"),
    PRODUCT_NAME: ORDER_HEADERS.indexOf("\u54C1\u540D"),
    VARIANT_OR_SIZE: ORDER_HEADERS.indexOf("\u898F\u683C\u5C3A\u5BF8"),
    PRICE: ORDER_HEADERS.indexOf("\u50F9\u683C"),
    ORDER_LINE_COUNT: ORDER_HEADERS.indexOf("\u558A\u55AE\u5247\u6578"),
    AGGREGATED_UNIT_COUNT: ORDER_HEADERS.indexOf("\u5F59\u7E3D\u4EF6\u6578")
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
      item.needsReview ? "\u662F" : "\u5426",
      item.captureOrigin,
      confirmed ? aggregate.sourceItemCount ?? 1 : 1,
      confirmed ? latestQuantity ?? "" : ""
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
      "\u5426",
      comment.captureOrigin,
      "",
      ""
    ];
  }
  function serializeCsvRow(row, { dataRow = true } = {}) {
    return row.map((value, columnIndex) => {
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
    const aggregation = createOrderAggregation();
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
    if (!session) throw new Error("\u627E\u4E0D\u5230\u672C\u5834\u8CC7\u6599\uFF0C\u7121\u6CD5\u532F\u51FA\u3002");
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
  function csvFileName(sessionId, now = /* @__PURE__ */ new Date()) {
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    const safeSession = String(sessionId).replace(/[^A-Za-z0-9_-]/gu, "_");
    return `shopee-live-${safeSession}-${date}.csv`;
  }

  // src/dom.js
  function extractCommentSnapshot(row) {
    if (!row?.matches?.(COMMENT_ROW_SELECTOR)) return null;
    const commentId = row.getAttribute("data-comment-id");
    if (!commentId || commentId === "false") return null;
    const username = row.querySelector(USERNAME_SELECTOR)?.textContent?.trim() ?? "";
    const rawMessage = row.querySelector(MESSAGE_SELECTOR)?.textContent?.trim() ?? "";
    return {
      commentId,
      uid: row.getAttribute("data-uid") ?? "",
      username,
      rawMessage,
      isHost: Boolean(row.querySelector(HOST_ITEM_SELECTOR)),
      complete: Boolean(username && rawMessage),
      row
    };
  }
  function collectCommentRows(root) {
    const rows = [];
    if (root?.nodeType === 1 && root.matches?.(COMMENT_ROW_SELECTOR)) rows.push(root);
    for (const row of root?.querySelectorAll?.(COMMENT_ROW_SELECTOR) ?? []) {
      rows.push(row);
    }
    return [...new Set(rows)];
  }
  function signature2(snapshot) {
    return JSON.stringify([
      snapshot.commentId,
      snapshot.username,
      snapshot.rawMessage,
      snapshot.isHost
    ]);
  }
  var DomCommentObserver = class {
    constructor(documentObject, options = {}) {
      this.document = documentObject;
      this.window = documentObject.defaultView;
      this.onCandidate = options.onCandidate ?? (() => {
      });
      this.onStatus = options.onStatus ?? (() => {
      });
      this.scanDelayMs = options.scanDelayMs ?? DOM_SCAN_DELAY_MS;
      this.stabilityDelayMs = options.stabilityDelayMs ?? DOM_STABILITY_DELAY_MS;
      this.statusIntervalMs = options.statusIntervalMs ?? DOM_STATUS_INTERVAL_MS;
      this.pending = /* @__PURE__ */ new Map();
      this.finalized = /* @__PURE__ */ new Map();
      this.scanTimer = null;
      this.statusTimer = null;
      this.observer = null;
    }
    start() {
      if (this.observer) return;
      const root = this.document.documentElement;
      if (!root) return;
      this.observer = new this.window.MutationObserver((records) => {
        const rows = /* @__PURE__ */ new Set();
        for (const record of records) {
          if (record.type === "childList") {
            for (const node of record.addedNodes) {
              for (const row of collectCommentRows(node)) rows.add(row);
            }
          }
          const targetElement = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
          const closest = targetElement?.closest?.(COMMENT_ROW_SELECTOR);
          if (closest) rows.add(closest);
        }
        this.readRows([...rows], CAPTURE_ORIGINS.OBSERVER, false);
        this.scheduleScan();
      });
      this.observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-comment-id", "data-uid", "class"]
      });
      this.scan(CAPTURE_ORIGINS.INITIAL_SCAN);
      this.statusTimer = this.window.setInterval(() => {
        this.scan(CAPTURE_ORIGINS.OBSERVER);
      }, this.statusIntervalMs);
    }
    stop() {
      this.observer?.disconnect();
      this.observer = null;
      if (this.scanTimer != null) this.window.clearTimeout(this.scanTimer);
      if (this.statusTimer != null) this.window.clearInterval(this.statusTimer);
      this.scanTimer = null;
      this.statusTimer = null;
      this.pending.clear();
      this.finalized.clear();
    }
    scheduleScan() {
      if (this.scanTimer != null) return;
      this.scanTimer = this.window.setTimeout(() => {
        this.scanTimer = null;
        this.scan(CAPTURE_ORIGINS.OBSERVER);
      }, this.scanDelayMs);
    }
    scan(origin) {
      const rows = collectCommentRows(this.document);
      const seenIds = this.readRows(rows, origin, true);
      const now = Date.now();
      for (const [commentId, entry] of this.pending) {
        if (!seenIds.has(commentId) && now - entry.firstReadAt >= this.stabilityDelayMs) {
          this.pending.delete(commentId);
          this.finalized.set(commentId, entry.signature);
          this.onCandidate({
            phase: "final",
            stable: false,
            snapshot: entry.snapshot,
            captureOrigin: entry.captureOrigin
          });
        }
      }
      const connected = Boolean(
        rows.length || this.document.querySelector(COMMENT_HOST_SELECTOR)
      );
      this.onStatus({ connected, rowCount: rows.length });
      if (this.pending.size) this.scheduleScan();
    }
    readRows(rows, origin, isFullScan) {
      const now = Date.now();
      const seenIds = /* @__PURE__ */ new Set();
      const snapshots = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const snapshot = extractCommentSnapshot(row);
        if (!snapshot?.complete) continue;
        snapshots.set(snapshot.commentId, snapshot);
      }
      for (const snapshot of snapshots.values()) {
        const id = snapshot.commentId;
        const nextSignature = signature2(snapshot);
        seenIds.add(id);
        if (this.finalized.get(id) === nextSignature) continue;
        const entry = this.pending.get(id);
        if (!entry || entry.signature !== nextSignature) {
          const nextEntry = {
            signature: nextSignature,
            snapshot,
            captureOrigin: origin,
            firstReadAt: now
          };
          this.pending.set(id, nextEntry);
          this.onCandidate({
            phase: "pending",
            stable: false,
            snapshot,
            captureOrigin: origin
          });
          continue;
        }
        if (now - entry.firstReadAt < this.stabilityDelayMs) continue;
        this.pending.delete(id);
        this.finalized.set(id, nextSignature);
        this.onCandidate({
          phase: "final",
          stable: true,
          snapshot,
          captureOrigin: entry.captureOrigin
        });
      }
      if (!isFullScan && this.pending.size) this.scheduleScan();
      return seenIds;
    }
  };

  // src/lock.js
  function safeParse(value) {
    try {
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }
  var SessionTabLock = class {
    constructor(sessionId, ownerId, options = {}) {
      this.sessionId = sessionId;
      this.ownerId = ownerId;
      this.storage = options.storage ?? window.localStorage;
      this.now = options.now ?? (() => Date.now());
      this.setInterval = options.setInterval ?? window.setInterval.bind(window);
      this.clearInterval = options.clearInterval ?? window.clearInterval.bind(window);
      this.heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
      this.staleMs = options.staleMs ?? LOCK_STALE_MS;
      this.onChange = options.onChange ?? (() => {
      });
      this.timer = null;
      this.isOwner = false;
    }
    get key() {
      return `${LOCK_KEY_PREFIX}${this.sessionId}`;
    }
    read() {
      return safeParse(this.storage.getItem(this.key));
    }
    isFresh(lock) {
      return Boolean(lock && this.now() - Number(lock.timestamp) < this.staleMs);
    }
    ownsCurrentLock() {
      const current = this.read();
      const ownsLock = current?.ownerId === this.ownerId;
      this.setOwnership(ownsLock);
      return ownsLock;
    }
    tryAcquire() {
      const current = this.read();
      if (current && current.ownerId !== this.ownerId && this.isFresh(current)) {
        this.setOwnership(false);
        return false;
      }
      this.storage.setItem(
        this.key,
        JSON.stringify({ ownerId: this.ownerId, timestamp: this.now() })
      );
      const acquired = this.read()?.ownerId === this.ownerId;
      this.setOwnership(acquired);
      return acquired;
    }
    heartbeat() {
      const current = this.read();
      if (current?.ownerId === this.ownerId) {
        this.storage.setItem(
          this.key,
          JSON.stringify({ ownerId: this.ownerId, timestamp: this.now() })
        );
        this.setOwnership(true);
        return;
      }
      this.tryAcquire();
    }
    setOwnership(value) {
      if (this.isOwner !== value) {
        this.isOwner = value;
        this.onChange(value);
      }
    }
    start() {
      this.tryAcquire();
      if (this.timer == null) {
        this.timer = this.setInterval(() => this.heartbeat(), this.heartbeatMs);
      }
      return this.isOwner;
    }
    release() {
      if (this.timer != null) {
        this.clearInterval(this.timer);
        this.timer = null;
      }
      if (this.read()?.ownerId === this.ownerId) {
        this.storage.removeItem(this.key);
      }
      this.setOwnership(false);
    }
  };

  // src/migration.js
  var LEGACY_MIGRATION_KEY = "legacy-v2-migration";
  function fingerprintText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  function listLegacyEntries(storage) {
    const entries = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(SESSION_KEY_PREFIX)) continue;
      entries.push({ key, raw: storage.getItem(key) ?? "" });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }
  function parseLegacyEntry(entry) {
    const sessionId = decodeURIComponent(entry.key.slice(SESSION_KEY_PREFIX.length));
    const parsed = JSON.parse(entry.raw);
    if (!parsed || typeof parsed !== "object" || parsed.sessionId !== sessionId) {
      throw new Error("Legacy session id does not match its storage key.");
    }
    return { ...entry, sessionId, parsed, fingerprint: fingerprintText(entry.raw) };
  }
  function signature3(comment) {
    return JSON.stringify([
      comment.username ?? "",
      comment.rawMessage ?? "",
      Boolean(comment.isHost)
    ]);
  }
  function normalizeLegacyComment(sessionId, commentId, comment, captureSequence) {
    const uid = comment.uid ?? comment.uuid ?? "";
    return {
      ...comment,
      sessionId,
      commentId,
      uid,
      isHost: Boolean(comment.isHost),
      domAnomaly: Boolean(comment.domAnomaly),
      captureSequence,
      signature: signature3(comment)
    };
  }
  function incrementCounts(counts, comment) {
    counts.raw += 1;
    if (Object.hasOwn(counts, comment.classification)) {
      counts[comment.classification] += 1;
    }
    if (comment.domAnomaly) counts.anomaly += 1;
  }
  function convertLegacySession(sessionId, legacy, now = Date.now()) {
    const comments = Object.entries(legacy.comments ?? {}).map(([commentId, comment], sourceIndex) => ({ commentId, comment, sourceIndex })).sort((left, right) => {
      const byTime = String(left.comment.firstSeenAt ?? "").localeCompare(String(right.comment.firstSeenAt ?? ""));
      return byTime || left.sourceIndex - right.sourceIndex;
    });
    const counts = { ...EMPTY_COUNTS };
    const convertedComments = [];
    const sequenceByComment = /* @__PURE__ */ new Map();
    for (const [index, entry] of comments.entries()) {
      const captureSequence = index + 1;
      const converted = normalizeLegacyComment(
        sessionId,
        entry.commentId,
        entry.comment,
        captureSequence
      );
      convertedComments.push(converted);
      sequenceByComment.set(entry.commentId, captureSequence);
      incrementCounts(counts, converted);
    }
    const commentById = new Map(
      convertedComments.map((comment) => [comment.commentId, comment])
    );
    const convertedItems = Object.entries(legacy.items ?? {}).map(([itemId, item]) => {
      const comment = commentById.get(item.sourceCommentId);
      const captureSequence = sequenceByComment.get(item.sourceCommentId);
      if (!comment || captureSequence == null) return null;
      return {
        ...item,
        sessionId,
        itemId,
        captureSequence,
        uid: comment.uid,
        username: comment.username ?? item.username ?? "",
        rawMessage: comment.rawMessage ?? "",
        normalizedMessage: comment.normalizedMessage ?? ""
      };
    }).filter(Boolean);
    const base = createSessionMeta(sessionId, now);
    const session = {
      ...base,
      createdAt: legacy.createdAt ?? base.createdAt,
      updatedAt: legacy.updatedAt ?? base.updatedAt,
      revision: 1,
      nextCaptureSequence: convertedComments.length + 1,
      config: { ...base.config, ...legacy.config ?? {} },
      history: Array.isArray(legacy.history) ? legacy.history : [],
      counts
    };
    return { session, comments: convertedComments, items: convertedItems };
  }
  function validateConvertedSession(source, data) {
    if (!data?.session || data.session.sessionId !== source.sessionId) {
      throw new Error("Converted legacy session has an invalid session id.");
    }
    for (const comment of data.comments ?? []) {
      if (typeof comment.commentId !== "string" || comment.commentId.length === 0 || !Number.isInteger(comment.captureSequence) || comment.captureSequence <= 0) throw new Error("Converted legacy comment has an invalid key.");
    }
    for (const item of data.items ?? []) {
      if (typeof item.itemId !== "string" || item.itemId.length === 0 || !Number.isInteger(item.captureSequence) || item.captureSequence <= 0) throw new Error("Converted legacy item has an invalid key.");
    }
  }
  function isGlobalMigrationError(error) {
    return (/* @__PURE__ */ new Set([
      "QuotaExceededError",
      "UnknownError",
      "SecurityError",
      "InvalidStateError",
      "NotReadableError"
    ])).has(error?.name);
  }
  function migrationRecord(converted, skippedKeys, migrationId, sourceFingerprint, now) {
    return {
      key: LEGACY_MIGRATION_KEY,
      state: "committed",
      migrationId,
      sourceFingerprint,
      sources: converted.map(({ source }) => ({
        key: source.key,
        fingerprint: source.fingerprint
      })),
      sessionIds: converted.map(({ source }) => source.sessionId),
      skippedKeys,
      committedAt: new Date(now).toISOString()
    };
  }
  async function writeConvertedSessions(repository, converted, migrationId, metaRecord = null) {
    await repository.runTransaction(
      [STORE_NAMES.META, STORE_NAMES.SESSIONS, STORE_NAMES.COMMENTS, STORE_NAMES.ITEMS],
      "readwrite",
      async ({ meta, sessions, comments, items }) => {
        for (const { data } of converted) {
          const session = { ...data.session, legacyMigrationId: migrationId };
          await requestToPromise(sessions.add(session));
          for (const comment of data.comments) {
            await requestToPromise(comments.add(comment));
          }
          for (const item of data.items) {
            await requestToPromise(items.add(item));
          }
        }
        if (metaRecord) await requestToPromise(meta.put(metaRecord));
      }
    );
  }
  async function finishCommittedCleanup(storage, migration, removeItem) {
    for (const source of migration.sources ?? []) {
      const current = storage.getItem(source.key);
      if (current == null) continue;
      if (fingerprintText(current) !== source.fingerprint) {
        const error = new Error(`\u820A\u8CC7\u6599 ${source.key} \u5728\u642C\u79FB\u5F8C\u88AB\u4FEE\u6539\uFF0C\u5DF2\u505C\u6B62\u6E05\u7406\u3002`);
        error.code = "MIGRATION_FINGERPRINT_MISMATCH";
        throw error;
      }
      removeItem(source.key);
    }
  }
  async function migrateLegacySessions(repository, storage, options = {}) {
    const removeItem = options.removeItem ?? ((key) => storage.removeItem(key));
    const existingMigration = await repository.getMeta(LEGACY_MIGRATION_KEY);
    if (existingMigration?.state === "committed") {
      await finishCommittedCleanup(storage, existingMigration, removeItem);
      return {
        migratedSessionIds: existingMigration.sessionIds ?? [],
        skippedKeys: existingMigration.skippedKeys ?? [],
        resumedCleanup: true
      };
    }
    const sourceEntries = listLegacyEntries(storage);
    const converted = [];
    const skippedKeys = [];
    for (const entry of sourceEntries) {
      try {
        const source = parseLegacyEntry(entry);
        const data = convertLegacySession(source.sessionId, source.parsed, repository.now());
        validateConvertedSession(source, data);
        converted.push({ source, data });
      } catch {
        skippedKeys.push(entry.key);
      }
    }
    if (!converted.length && !skippedKeys.length) {
      return { migratedSessionIds: [], skippedKeys: [], resumedCleanup: false };
    }
    const sources = converted.map(({ source }) => ({
      key: source.key,
      fingerprint: source.fingerprint
    }));
    const sourceFingerprint = fingerprintText(JSON.stringify(sources));
    const migrationId = `v2-${sourceFingerprint}`;
    let successful = converted;
    const initialRecord = migrationRecord(
      converted,
      skippedKeys,
      migrationId,
      sourceFingerprint,
      repository.now()
    );
    try {
      await writeConvertedSessions(repository, converted, migrationId, initialRecord);
    } catch (error) {
      if (isGlobalMigrationError(error)) throw error;
      successful = [];
      for (const entry of converted) {
        const existing = await repository.getSession(entry.source.sessionId, { create: false });
        if (existing?.legacyMigrationId === migrationId) {
          successful.push(entry);
          continue;
        }
        try {
          await writeConvertedSessions(repository, [entry], migrationId);
          successful.push(entry);
        } catch (sessionError) {
          if (isGlobalMigrationError(sessionError)) throw sessionError;
          skippedKeys.push(entry.source.key);
        }
      }
      await repository.putMeta(migrationRecord(
        successful,
        skippedKeys,
        migrationId,
        sourceFingerprint,
        repository.now()
      ));
    }
    const migration = await repository.getMeta(LEGACY_MIGRATION_KEY);
    await finishCommittedCleanup(storage, migration, removeItem);
    return {
      migratedSessionIds: successful.map(({ source }) => source.sessionId),
      skippedKeys,
      resumedCleanup: false
    };
  }

  // src/session.js
  function extractSessionId(href) {
    try {
      const value = new URL(href).searchParams.get("session")?.trim();
      return value || null;
    } catch {
      return null;
    }
  }
  function getOrCreateTabId(sessionStorage, cryptoObject = globalThis.crypto) {
    let tabId = sessionStorage.getItem(TAB_ID_KEY);
    if (!tabId) {
      tabId = cryptoObject?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(TAB_ID_KEY, tabId);
    }
    return tabId;
  }
  function isSameSessionReload(sessionStorage, sessionId) {
    return sessionStorage.getItem(TAB_SESSION_KEY) === sessionId;
  }
  function rememberTabSession(sessionStorage, sessionId) {
    if (sessionId) sessionStorage.setItem(TAB_SESSION_KEY, sessionId);
    else sessionStorage.removeItem(TAB_SESSION_KEY);
  }
  var UrlSessionMonitor = class {
    constructor(windowObject, onChange, options = {}) {
      this.window = windowObject;
      this.onChange = onChange;
      this.pollMs = options.pollMs ?? URL_POLL_INTERVAL_MS;
      this.currentSessionId = extractSessionId(windowObject.location.href);
      this.interval = null;
      this.originalPushState = null;
      this.originalReplaceState = null;
      this.handlePopState = () => this.check("popstate");
    }
    check(source = "poll") {
      const next = extractSessionId(this.window.location.href);
      if (next === this.currentSessionId) return;
      const previous = this.currentSessionId;
      this.currentSessionId = next;
      this.onChange(next, previous, source);
    }
    start() {
      if (this.interval != null) return;
      const history = this.window.history;
      this.originalPushState = history.pushState;
      this.originalReplaceState = history.replaceState;
      const monitor = this;
      history.pushState = function patchedPushState(...args) {
        const result = monitor.originalPushState.apply(this, args);
        monitor.window.queueMicrotask(() => monitor.check("pushState"));
        return result;
      };
      history.replaceState = function patchedReplaceState(...args) {
        const result = monitor.originalReplaceState.apply(this, args);
        monitor.window.queueMicrotask(() => monitor.check("replaceState"));
        return result;
      };
      this.window.addEventListener("popstate", this.handlePopState);
      this.interval = this.window.setInterval(() => this.check("poll"), this.pollMs);
    }
    stop() {
      if (this.interval != null) {
        this.window.clearInterval(this.interval);
        this.interval = null;
      }
      this.window.removeEventListener("popstate", this.handlePopState);
      if (this.originalPushState) this.window.history.pushState = this.originalPushState;
      if (this.originalReplaceState) {
        this.window.history.replaceState = this.originalReplaceState;
      }
    }
  };

  // src/catalog-progress.js
  var CATALOG_PRODUCT_STATUS = Object.freeze({
    CURRENT: "current",
    INTRODUCED: "introduced",
    SKIPPED: "skipped",
    NOT_INTRODUCED: "notIntroduced"
  });
  function deriveIntroducedProducts(profileHistory = [], catalogProducts = [], activeCode = null) {
    const normalizedActiveCode = normalizeProductCode(activeCode);
    const catalogCodes = new Set(
      (catalogProducts ?? []).map((product) => normalizeProductCode(product?.productCode)).filter(Boolean)
    );
    const byCode = /* @__PURE__ */ new Map();
    for (let index = 0; index < (profileHistory ?? []).length; index += 1) {
      const entry = profileHistory[index];
      const productCode = normalizeProductCode(entry?.activeCode);
      if (!productCode) continue;
      let summary = byCode.get(productCode);
      if (!summary) {
        summary = {
          productCode,
          firstHistoryIndex: index,
          activationSequences: /* @__PURE__ */ new Set(),
          latestEntry: entry
        };
        byCode.set(productCode, summary);
      }
      summary.activationSequences.add(String(entry?.activationSequence ?? "legacy"));
      summary.latestEntry = entry;
    }
    return [...byCode.values()].map((summary) => {
      const inCatalog = catalogCodes.has(summary.productCode);
      return {
        productCode: summary.productCode,
        productName: summary.latestEntry?.productName ?? "",
        activationCount: summary.activationSequences.size,
        firstHistoryIndex: summary.firstHistoryIndex,
        latestEntry: summary.latestEntry,
        isCurrent: summary.productCode === normalizedActiveCode,
        inCatalog,
        removedFromCatalog: !inCatalog
      };
    });
  }
  function deriveCatalogProgress(catalogProducts = [], introducedProducts = [], activeCode = null) {
    const normalizedActiveCode = normalizeProductCode(activeCode);
    const introducedCodes = new Set(
      (introducedProducts ?? []).map((entry) => entry.productCode)
    );
    const catalogCodes = new Set(
      (catalogProducts ?? []).map((product) => normalizeProductCode(product?.productCode)).filter(Boolean)
    );
    const introducedInCatalog = new Set(
      [...introducedCodes].filter((productCode) => catalogCodes.has(productCode))
    );
    const introducedTsvOrders = (catalogProducts ?? []).filter((product) => product?.entryOrigin === "tsv" && introducedCodes.has(normalizeProductCode(product?.productCode))).map((product) => Number(product.importOrder)).filter(Number.isFinite);
    const frontier = introducedTsvOrders.length ? Math.max(...introducedTsvOrders) : null;
    const catalogItems = (catalogProducts ?? []).map((product) => {
      const productCode = normalizeProductCode(product?.productCode);
      const introduced = introducedCodes.has(productCode);
      const order = Number(product?.importOrder);
      let status = CATALOG_PRODUCT_STATUS.NOT_INTRODUCED;
      if (productCode && productCode === normalizedActiveCode) {
        status = CATALOG_PRODUCT_STATUS.CURRENT;
      } else if (introduced) {
        status = CATALOG_PRODUCT_STATUS.INTRODUCED;
      } else if (product?.entryOrigin === "tsv" && frontier != null && Number.isFinite(order) && order < frontier) {
        status = CATALOG_PRODUCT_STATUS.SKIPPED;
      }
      return { product, productCode, status };
    });
    return {
      introducedCount: introducedInCatalog.size,
      totalCount: (catalogProducts ?? []).length,
      removedCount: (introducedProducts ?? []).filter((entry) => !catalogCodes.has(entry.productCode)).length,
      frontier,
      catalogItems
    };
  }

  // src/start-line.js
  function formatLocalMmdd(date = /* @__PURE__ */ new Date()) {
    return [
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("");
  }
  function orderedSelected(selected, orderedValues) {
    const selectedCanonical = new Set(
      (selected ?? []).map((value) => canonicalizeSpecKeyword(value))
    );
    const ordered = [];
    for (const value of [...orderedValues, ...selected ?? []]) {
      const canonical = canonicalizeSpecKeyword(value);
      if (selectedCanonical.delete(canonical)) ordered.push(canonical);
    }
    return [...ordered, ...selectedCanonical];
  }
  function buildSpecificationText(profile) {
    if (!profile || profile.mode === "noSpecs") return "";
    const customStyles = (profile.customSlots ?? []).filter((slot) => slot.selected && slot.value && (slot.dimension ?? "style") === "style").map((slot) => slot.value);
    const customSizes = (profile.customSlots ?? []).filter((slot) => slot.selected && slot.value && slot.dimension === "size").map((slot) => slot.value);
    const requestedOrder = Array.isArray(profile.displayOrder) ? profile.displayOrder : null;
    const styles2 = orderedSelected(
      [...profile.selected?.style ?? [], ...customStyles],
      requestedOrder ?? [...BUILTIN_SPEC_KEYWORDS.colors, ...customStyles]
    );
    const sizes = orderedSelected(
      [...profile.selected?.size ?? [], ...customSizes],
      requestedOrder ?? [
        ...BUILTIN_SPEC_KEYWORDS.clothingSizes,
        ...BUILTIN_SPEC_KEYWORDS.shoeSizes,
        ...customSizes
      ]
    );
    const allShoes = BUILTIN_SPEC_KEYWORDS.shoeSizes.every((size) => sizes.includes(canonicalizeSpecKeyword(size)));
    const onlyShoes = allShoes && sizes.length === BUILTIN_SPEC_KEYWORDS.shoeSizes.length;
    const parts = [];
    if (styles2.length) parts.push(`\u6A23\u5F0F\u95DC\u9375\u5B57\uFF1A${styles2.join("\u3001")}`);
    if (sizes.length) {
      parts.push(onlyShoes ? "\u5C3A\u5BF8\u95DC\u9375\u5B57\uFF1A35\uFF5E45\uFF08\u542B\u534A\u78BC\uFF09" : `\u5C3A\u5BF8\u95DC\u9375\u5B57\uFF1A${sizes.join("\u3001")}`);
    }
    return parts.join(" ");
  }
  function buildStartLine({
    date = /* @__PURE__ */ new Date(),
    productCode,
    productName,
    price,
    specProfile
  }) {
    const code = String(productCode ?? "").trim();
    const name = String(productName ?? "").trim();
    const priceText = String(price ?? "").trim();
    if (!code || !priceText || !specProfile) {
      throw new Error("\u5546\u54C1\u78BC\u3001\u898F\u683C\u4E09\u614B\u8207\u50F9\u683C\u90FD\u5B8C\u6210\u5F8C\u624D\u80FD\u8907\u88FD\u8D77\u6A19\u7DDA\u3002");
    }
    if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(priceText)) {
      throw new Error("\u50F9\u683C\u53EA\u80FD\u4F7F\u7528\u6578\u5B57\u8207\u5C0F\u6578\u9EDE\u3002");
    }
    const specificationText = buildSpecificationText(specProfile);
    return [
      `\u8D77\u6A19\u7DDA\uFF1A ${formatLocalMmdd(date)}-${code}`,
      name,
      `- \u76F4\u8CFC\u50F9\uFF1A${priceText}`,
      specificationText,
      `\u5165\u55AE\u95DC\u9375\u5B57\uFF1A${code}`
    ].filter(Boolean).join(" ");
  }
  function buildCatalogStartLines(products, { date = /* @__PURE__ */ new Date() } = {}) {
    return [...products ?? []].sort((left, right) => left.importOrder - right.importOrder).map((product) => {
      try {
        return {
          productCode: product.productCode,
          text: buildStartLine({
            date,
            productCode: product.productCode,
            productName: product.productName ?? "",
            price: product.price,
            specProfile: product.specProfile
          }),
          error: null
        };
      } catch (error) {
        return {
          productCode: product.productCode ?? "",
          text: "",
          error: error.message
        };
      }
    });
  }

  // src/ui.js
  var BUILTIN_SPEC_GROUPS = Object.freeze([
    Object.freeze({
      key: "colors",
      title: "\u984F\u8272",
      dimension: "style",
      values: BUILTIN_SPEC_KEYWORDS.colors
    }),
    Object.freeze({
      key: "clothingSizes",
      title: "\u5C3A\u5BF8",
      dimension: "size",
      values: BUILTIN_SPEC_KEYWORDS.clothingSizes
    }),
    Object.freeze({
      key: "shoeSizes",
      title: "\u978B\u78BC",
      dimension: "size",
      values: BUILTIN_SPEC_KEYWORDS.shoeSizes
    })
  ]);
  var BUILTIN_SPEC_BY_CANONICAL = /* @__PURE__ */ new Map();
  for (const definition of BUILTIN_SPEC_GROUPS) {
    for (const value of definition.values) {
      const canonical = canonicalizeSpecKeyword(value);
      if (!BUILTIN_SPEC_BY_CANONICAL.has(canonical)) {
        BUILTIN_SPEC_BY_CANONICAL.set(canonical, { definition, value });
      }
    }
  }
  function readPriceRequiredPreference(windowObject) {
    try {
      return windowObject.localStorage.getItem(PRICE_REQUIRED_PREF_KEY) === "true";
    } catch {
      return false;
    }
  }
  function writePriceRequiredPreference(windowObject, value) {
    try {
      windowObject.localStorage.setItem(PRICE_REQUIRED_PREF_KEY, String(Boolean(value)));
    } catch {
    }
  }
  var styles = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    width:calc(50vw - 24px); min-width:390px; max-width:calc(100vw - 32px);
    height:calc(100vh - 32px); min-height:420px; max-height:calc(100vh - 16px);
    display:flex; flex-direction:column; resize:both; overflow:hidden;
    color:#202124; background:#fff; border:1px solid #dfe3e8; border-radius:12px;
    box-shadow:0 8px 28px rgba(0,0,0,.24);
    font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  }
  .panel.collapsed { width:auto; min-width:190px; height:auto; min-height:0; resize:none; }
  .panel.collapsed .body, .panel.collapsed .panel-footer { display:none; }
  .header { display:flex; align-items:center; gap:8px; padding:10px 12px; color:#fff; background:#ee4d2d; cursor:move; user-select:none; }
  .header strong { flex:1; }
  button { border:0; border-radius:7px; padding:7px 10px; font:inherit; font-weight:650; cursor:pointer; }
  button:disabled, input:disabled, textarea:disabled { cursor:not-allowed; opacity:.55; }
  .header button { padding:2px 8px; color:#fff; background:rgba(255,255,255,.2); }
  .body { flex:1 1 auto; min-height:0; overflow:auto; padding:12px; }
  .panel-footer { flex:0 0 auto; padding:0 12px 12px; background:#fff; box-shadow:0 -4px 10px rgba(0,0,0,.06); }
  .banner { display:none; margin-bottom:10px; padding:8px; border-radius:7px; font-weight:650; }
  .banner.show { display:block; }
  .banner.error { color:#8a1c13; background:#ffe5e0; }
  .banner.warn { color:#6b4600; background:#fff1c7; }
  .status-line { display:flex; align-items:center; gap:7px; margin-bottom:8px; }
  .dot { width:10px; height:10px; border-radius:50%; background:#9aa0a6; }
  .dot.ok { background:#1e8e3e; } .dot.warn { background:#f9ab00; } .dot.error { background:#d93025; }
  .session { margin-bottom:10px; color:#5f6368; overflow-wrap:anywhere; }
  .session-notice { display:none; margin:-3px 0 10px; color:#6b4600; font-size:12px; }
  .session-notice.show { display:block; }
  .workspace { display:grid; grid-template-columns:1fr; gap:10px; align-items:start; }
  .box { min-width:0; padding:10px; border:1px solid #dfe3e8; border-radius:9px; background:#fff; }
  .active-box { border:2px solid #ee4d2d; background:#fff8f6; }
  .section-heading { margin-bottom:7px; color:#5f6368; font-size:12px; font-weight:800; }
  .box-title { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:7px; font-weight:750; }
  .section-toggle { padding:4px 7px; font-size:11px; }
  .catalog-title-controls { display:flex; align-items:center; gap:6px; }
  .inline-check { display:flex; align-items:center; gap:4px; color:#5f6368; font-size:11px; font-weight:600; white-space:nowrap; }
  .section-body { display:none; }
  .section-body.show { display:block; }
  .active-code { margin:2px 0 8px; font-size:23px; font-weight:800; letter-spacing:1px; }
  .controls { display:grid; grid-template-columns:1fr auto; gap:7px; }
  input[type="text"], textarea {
    width:100%; border:1px solid #c7cdd3; border-radius:7px; padding:8px; font:inherit; background:#fff;
  }
  textarea { min-height:105px; resize:vertical; white-space:pre; }
  .code-input { text-transform:uppercase; }
  .primary { color:#fff; background:#ee4d2d; }
  .secondary { color:#3c4043; background:#eef1f4; }
  .danger { color:#a50e0e; background:#fce8e6; }
  .wide { width:100%; margin-top:7px; }
  .meta, .hint { margin-top:6px; color:#5f6368; font-size:12px; overflow-wrap:anywhere; }
  .hint.error { color:#a50e0e; } .hint.warn { color:#6b4600; }
  .catalog-actions { display:grid; grid-template-columns:auto 1fr; gap:6px; margin-top:6px; }
  .preview { max-height:220px; overflow:auto; margin-top:7px; border:1px solid #e5e7ea; border-radius:7px; }
  .preview-row { padding:6px; border-bottom:1px solid #eee; }
  .preview-row:last-child { border-bottom:0; }
  .preview-row.error { background:#fff0ed; } .preview-row.no-spec { background:#fff3c9; }
  .preview-fields { display:grid; grid-template-columns:.7fr 1fr 1fr 1fr .65fr; gap:4px; }
  .preview-fields input { min-width:0; padding:5px; font-size:11px; }
  .preview-status { display:flex; align-items:center; gap:5px; margin-top:3px; color:#5f6368; font-size:11px; }
  .preview-row.error .preview-status { color:#a50e0e; }
  .start-lines { max-height:190px; overflow:auto; margin-top:7px; border:1px solid #e5e7ea; border-radius:7px; }
  .start-row { display:grid; grid-template-columns:auto 1fr auto auto; gap:5px; align-items:start; padding:6px; border-bottom:1px solid #eee; }
  .start-row:last-child { border-bottom:0; }
  .start-text { font-size:11px; overflow-wrap:anywhere; }
  .source-badge { padding:2px 5px; border-radius:10px; background:#eef1f4; color:#5f6368; font-size:10px; }
  .price-status { padding:2px 5px; border-radius:10px; color:#6b4600; background:#fff1c7; font-size:10px; white-space:nowrap; }
  .start-statuses { display:flex; align-items:center; gap:4px; }
  .catalog-status { padding:2px 5px; border-radius:10px; color:#5f6368; background:#f1f3f4; font-size:10px; }
  .catalog-status.status-current { color:#174ea6; background:#e8f0fe; }
  .catalog-status.status-introduced { color:#137333; background:#e6f4ea; }
  .catalog-status.status-skipped { color:#5f6368; background:#eef1f4; }
  .catalog-status.status-notIntroduced { color:#6f7378; background:#f8f9fa; }
  .single-form { display:none; margin-top:8px; padding:8px; border:1px dashed #ee4d2d; border-radius:8px; background:#fff; }
  .single-form.show { display:block; }
  .single-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
  .single-grid label { color:#5f6368; font-size:11px; }
  .single-grid .span2 { grid-column:1 / -1; }
  .chip-section { margin-top:7px; }
  .chip-title { display:flex; justify-content:space-between; gap:6px; font-weight:700; }
  .chips { display:flex; flex-direction:column; gap:4px; margin-top:4px; }
  .chip { display:grid; grid-template-columns:1fr auto; gap:3px; }
  .chip input { padding:5px; }
  .chip button { padding:4px 6px; font-size:11px; }
  .chip-add { display:grid; grid-template-columns:1fr auto; gap:4px; margin-top:4px; }
  .builtin-specs { margin-top:9px; }
  .builtin-group { margin-top:5px; border:1px solid #e0e3e7; border-radius:7px; background:#fff; }
  .builtin-group-header { display:flex; gap:5px; align-items:center; padding:5px; }
  .builtin-group-title { flex:1; min-width:0; font-weight:700; }
  .builtin-group-toggle { padding:4px 7px; font-size:11px; }
  .builtin-group-body { display:none; padding:0 6px 6px; }
  .builtin-group-body.show { display:block; }
  .builtin-group-actions { display:flex; gap:5px; }
  .builtin-group-actions button { padding:4px 7px; font-size:11px; }
  .keyword-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(90px,1fr)); gap:4px; }
  .keyword-option { display:flex; align-items:center; gap:4px; min-width:0; padding:3px 4px; border-radius:5px; background:#f8f9fa; font-size:11px; }
  .keyword-option span { overflow:hidden; text-overflow:ellipsis; }
  .no-spec-badge { display:none; margin-top:7px; padding:6px; border-radius:7px; color:#6b4600; background:#fff1c7; font-weight:650; }
  .no-spec-badge.show { display:block; }
  .introduced-section { margin:9px 0; padding:8px; border:1px solid #e0e3e7; border-radius:8px; background:#fff; }
  .introduced-section .box-title { margin-bottom:3px; }
  .introduced-toggle { padding:4px 7px; font-size:11px; }
  .introduced-list { display:none; max-height:170px; overflow:auto; margin-top:7px; border-top:1px solid #eee; }
  .introduced-list.show { display:block; }
  .introduced-row { display:flex; align-items:center; gap:5px; padding:5px 0; border-bottom:1px solid #eee; }
  .introduced-row:last-child { border-bottom:0; }
  .introduced-row.current { margin:0 -4px; padding:5px 4px; border-radius:6px; background:#e8f0fe; }
  .introduced-product { flex:1; min-width:0; padding:4px 6px; text-align:left; overflow-wrap:anywhere; }
  .history-badge { flex:0 0 auto; padding:2px 5px; border-radius:10px; color:#5f6368; background:#eef1f4; font-size:10px; }
  .history-badge.current { color:#174ea6; background:#d2e3fc; }
  .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:6px; margin:11px 0; }
  .stat { padding:7px 3px; text-align:center; background:#f5f6f7; border-radius:7px; }
  .stat b { display:block; font-size:16px; }
  h3 { margin:12px 0 6px; font-size:13px; }
  .recent { max-height:150px; overflow:auto; border:1px solid #e5e7ea; border-radius:7px; }
  .row { display:grid; grid-template-columns:92px 1fr; gap:6px; padding:6px 7px; border-bottom:1px solid #eee; }
  .row:last-child { border:0; } .row .who { color:#1967d2; overflow:hidden; text-overflow:ellipsis; }
  .row .msg { overflow-wrap:anywhere; } .row small { grid-column:1/-1; color:#6f7378; }
  .actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:9px; }
  .check { display:flex; gap:6px; align-items:flex-start; margin-top:8px; color:#5f6368; }
  .footer { margin-top:9px; color:#777; font-size:11px; }
  @media (max-width: 760px) {
    .stats { grid-template-columns:repeat(4,1fr); }
  }
`;
  function createElement(documentObject, tag, className, text) {
    const element = documentObject.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function profileDimensions(profile) {
    const styleSet = new Set(
      Array.isArray(profile?.selected?.style) ? profile.selected.style : []
    );
    const sizeSet = new Set(
      Array.isArray(profile?.selected?.size) ? profile.selected.size : []
    );
    const customSlots = Array.isArray(profile?.customSlots) ? profile.customSlots : [];
    for (const slot of customSlots) {
      if (!slot.selected || !slot.value) continue;
      (slot.dimension === "size" ? sizeSet : styleSet).add(slot.value);
    }
    const order = Array.isArray(profile?.displayOrder) ? profile.displayOrder : [...styleSet, ...sizeSet];
    const ordered = (set) => {
      const remaining = new Set(set);
      const result = [];
      for (const value of order) {
        if (remaining.delete(value)) result.push(value);
      }
      return [...result, ...remaining];
    };
    return { style: ordered(styleSet), size: ordered(sizeSet) };
  }
  function issueSummary(row) {
    return [...row.errors ?? [], ...row.warnings ?? []].map((entry) => entry.message).join("\uFF1B");
  }
  var CapturePanel = class {
    constructor(documentObject, callbacks = {}) {
      this.document = documentObject;
      this.window = documentObject.defaultView;
      this.callbacks = callbacks;
      this.host = null;
      this.shadow = null;
      this.elements = {};
      this.state = {};
      this.parsedCatalog = null;
      this.previewRows = [];
      this.candidateCode = null;
      this.codeInputDirty = false;
      this.lastSessionId = null;
      this.draft = { style: [], size: [] };
      this.draftDirty = false;
      this.lastDraftSource = null;
      this.lastCatalogRenderKey = null;
      this.introducedExpanded = false;
      this.catalogExpanded = false;
      this.monitorExpanded = true;
      this.customExpanded = false;
      this.priceRequired = readPriceRequiredPreference(this.window);
      this.singlePriceIsDefault = false;
      this.profileSaving = false;
      this.catalogSaving = false;
      this.singleSaving = false;
      this.exporting = false;
    }
    mount() {
      if (this.host) return;
      this.host = createElement(this.document, "div");
      this.host.id = "slocc-root";
      this.shadow = this.host.attachShadow({ mode: "open" });
      const style = createElement(this.document, "style");
      style.textContent = styles;
      this.shadow.append(style);
      const panel = createElement(this.document, "section", "panel");
      const header = createElement(this.document, "div", "header");
      header.append(createElement(this.document, "strong", "", "\u8766\u76AE\u76F4\u64AD\u558A\u55AE\u64F7\u53D6"));
      const collapse = createElement(this.document, "button", "", "\u6536\u5408");
      header.append(collapse);
      panel.append(header);
      const body = createElement(this.document, "div", "body");
      const banner = createElement(this.document, "div", "banner");
      body.append(banner);
      const statusLine = createElement(this.document, "div", "status-line");
      const dot = createElement(this.document, "span", "dot");
      const statusText = createElement(this.document, "span", "", "\u7B49\u5F85\u8A55\u8AD6\u5340");
      statusLine.append(dot, statusText);
      body.append(statusLine);
      const session = createElement(this.document, "div", "session", "Session\uFF1A\u2014");
      body.append(session);
      const sessionNotice = createElement(this.document, "div", "session-notice");
      body.append(sessionNotice);
      const workspace = createElement(this.document, "div", "workspace");
      const catalogBox = createElement(this.document, "section", "box catalog-box");
      const catalogTitle = createElement(this.document, "div", "box-title");
      catalogTitle.append(createElement(this.document, "span", "", "\u2461 \u532F\u5165\u6A94\u6848"));
      const catalogTitleControls = createElement(
        this.document,
        "div",
        "catalog-title-controls"
      );
      const priceRequiredLabel = createElement(this.document, "label", "inline-check");
      const priceRequired = createElement(this.document, "input");
      priceRequired.type = "checkbox";
      priceRequired.checked = this.priceRequired;
      priceRequiredLabel.append(
        priceRequired,
        createElement(this.document, "span", "", "\u91D1\u984D\u5FC5\u586B")
      );
      const catalogToggle = createElement(
        this.document,
        "button",
        "secondary section-toggle",
        "\u5C55\u958B"
      );
      catalogToggle.type = "button";
      catalogToggle.setAttribute("aria-expanded", "false");
      catalogTitleControls.append(priceRequiredLabel, catalogToggle);
      catalogTitle.append(catalogTitleControls);
      const catalogBody = createElement(this.document, "div", "section-body");
      catalogBox.append(catalogTitle, catalogBody);
      const catalogInput = createElement(this.document, "textarea");
      catalogInput.placeholder = "\u5F9E Excel \u8907\u88FD\u4E94\u6B04\u8CBC\u4E0A\uFF1A\u5546\u54C1\u78BC\u3001\u54C1\u540D\u3001\u984F\u8272\u3001\u5C3A\u5BF8\u3001\u50F9\u683C";
      catalogBody.append(catalogInput);
      const catalogActions = createElement(this.document, "div", "catalog-actions");
      const parseCatalog = createElement(this.document, "button", "secondary", "\u89E3\u6790\u9810\u89BD");
      const applyCatalog = createElement(this.document, "button", "primary", "\u5C1A\u672A\u89E3\u6790");
      catalogActions.append(parseCatalog, applyCatalog);
      catalogBody.append(catalogActions);
      const catalogSummary = createElement(this.document, "div", "hint", "\u5C1A\u672A\u8CBC\u4E0A\u5546\u54C1\u6E05\u55AE");
      const catalogPreview = createElement(this.document, "div", "preview");
      catalogBody.append(catalogSummary, catalogPreview);
      const startTitle = createElement(this.document, "div", "box-title", "\u6279\u6B21\u8D77\u6A19\u7DDA");
      startTitle.style.marginTop = "10px";
      const copyAllStartLines = createElement(this.document, "button", "secondary", "\u8907\u88FD\u5168\u90E8");
      startTitle.append(copyAllStartLines);
      const storedCatalogSummary = createElement(this.document, "div", "hint", "\u672C\u5834\u5C1A\u7121\u5546\u54C1");
      const startLines = createElement(this.document, "div", "start-lines");
      catalogBody.append(startTitle, storedCatalogSummary, startLines);
      const currentBox = createElement(this.document, "section", "box active-box");
      currentBox.append(createElement(this.document, "div", "section-heading", "\u2460 \u4EBA\u5DE5\u8F38\u5165"));
      currentBox.append(createElement(this.document, "div", "box-title", "\u76EE\u524D\u5546\u54C1"));
      const activeCode = createElement(this.document, "div", "active-code", "\u6536\u55AE\u5DF2\u66AB\u505C");
      currentBox.append(activeCode);
      const controls = createElement(this.document, "div", "controls");
      const input = createElement(this.document, "input", "code-input");
      input.type = "text";
      input.maxLength = 4;
      input.placeholder = "\u4F8B\u5982 A01 \u6216 A010";
      input.autocomplete = "off";
      const apply = createElement(this.document, "button", "primary", "\u5957\u7528\uFF0F\u5207\u63DB");
      controls.append(input, apply);
      currentBox.append(controls);
      const activeMeta = createElement(this.document, "div", "meta", "\u5C1A\u672A\u8A2D\u5B9A\u5546\u54C1\u78BC");
      const lookupHint = createElement(this.document, "div", "hint");
      currentBox.append(activeMeta, lookupHint);
      const singleForm = createElement(this.document, "div", "single-form");
      singleForm.append(createElement(this.document, "div", "box-title", "\u65B0\u5546\u54C1\u8CC7\u6599"));
      const singleGrid = createElement(this.document, "div", "single-grid");
      const singleInputs = {};
      const singleLabels = {};
      const singleFields = [
        ["productName", "\u54C1\u540D\uFF08\u9078\u586B\uFF09"],
        ["price", "\u50F9\u683C\uFF08\u5FC5\u586B\uFF09"]
      ];
      for (const [key, labelText] of singleFields) {
        const label = createElement(this.document, "label");
        const labelTextElement = createElement(this.document, "span", "", labelText);
        label.append(labelTextElement);
        const field = createElement(this.document, "input");
        field.type = "text";
        field.dataset.field = key;
        label.append(field);
        singleGrid.append(label);
        singleInputs[key] = field;
        singleLabels[key] = labelTextElement;
      }
      const singleHint = createElement(this.document, "div", "hint span2");
      singleGrid.append(singleHint);
      singleForm.append(singleGrid);
      currentBox.append(singleForm);
      const introducedSection = createElement(this.document, "div", "introduced-section");
      const introducedTitle = createElement(this.document, "div", "box-title");
      introducedTitle.append(createElement(this.document, "span", "", "\u672C\u5834\u5DF2\u4ECB\u7D39\u5546\u54C1"));
      const introducedToggle = createElement(
        this.document,
        "button",
        "secondary introduced-toggle",
        "\u5C55\u958B"
      );
      introducedToggle.type = "button";
      introducedToggle.setAttribute("aria-expanded", "false");
      introducedTitle.append(introducedToggle);
      const introducedSummary = createElement(
        this.document,
        "div",
        "introduced-summary",
        "\u672C\u5834\u9032\u5EA6\uFF5C\u5DF2\u4ECB\u7D39 0 / \u76EE\u524D\u5546\u54C1\u7E3D\u6578 0"
      );
      const introducedRemoved = createElement(this.document, "div", "hint introduced-removed");
      const introducedList = createElement(this.document, "div", "introduced-list");
      introducedSection.append(
        introducedTitle,
        introducedSummary,
        introducedRemoved,
        introducedList
      );
      currentBox.append(introducedSection);
      const addSingle = createElement(this.document, "button", "primary wide", "\u52A0\u5165\u5546\u54C1\u6E05\u55AE");
      addSingle.style.display = "none";
      currentBox.append(createElement(this.document, "div", "section-heading", "\u898F\u683C"));
      const builtinSpecs = createElement(this.document, "div", "builtin-specs");
      const builtinSpecGroups = {};
      for (const definition of BUILTIN_SPEC_GROUPS) {
        const group = createElement(this.document, "div", "builtin-group");
        group.dataset.group = definition.key;
        const header2 = createElement(this.document, "div", "builtin-group-header");
        const title = createElement(
          this.document,
          "div",
          "builtin-group-title",
          `${definition.title}\uFF08\u5DF2\u9078 0/${definition.values.length}\uFF09`
        );
        const actions2 = createElement(this.document, "div", "builtin-group-actions");
        const selectAll = createElement(this.document, "button", "secondary", "\u5168\u9078");
        const clear = createElement(this.document, "button", "secondary", "\u6E05\u7A7A");
        selectAll.type = "button";
        clear.type = "button";
        actions2.append(selectAll, clear);
        const toggle = createElement(
          this.document,
          "button",
          "secondary builtin-group-toggle",
          "\u5C55\u958B"
        );
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        header2.append(title, actions2, toggle);
        const groupBody = createElement(this.document, "div", "builtin-group-body");
        const grid = createElement(this.document, "div", "keyword-grid");
        const checkboxes = /* @__PURE__ */ new Map();
        for (const value of definition.values) {
          const label = createElement(this.document, "label", "keyword-option");
          const checkbox = createElement(this.document, "input");
          checkbox.type = "checkbox";
          checkbox.dataset.keyword = value;
          label.append(checkbox, createElement(this.document, "span", "", value));
          grid.append(label);
          checkboxes.set(value, checkbox);
        }
        groupBody.append(grid);
        group.append(header2, groupBody);
        builtinSpecs.append(group);
        builtinSpecGroups[definition.key] = {
          definition,
          group,
          title,
          toggle,
          body: groupBody,
          selectAll,
          clear,
          checkboxes,
          expanded: false
        };
      }
      currentBox.append(builtinSpecs);
      const customGroup = createElement(this.document, "div", "builtin-group custom-spec-group");
      const customHeader = createElement(this.document, "div", "builtin-group-header");
      customHeader.append(createElement(this.document, "div", "builtin-group-title", "\u81EA\u8A02\u7FA9"));
      const customToggle = createElement(
        this.document,
        "button",
        "secondary builtin-group-toggle",
        "\u5C55\u958B"
      );
      customToggle.type = "button";
      customToggle.setAttribute("aria-expanded", "false");
      customHeader.append(customToggle);
      const customBody = createElement(this.document, "div", "builtin-group-body");
      customGroup.append(customHeader, customBody);
      currentBox.append(customGroup);
      const createChipSection = (dimension, title, placeholder) => {
        const section = createElement(this.document, "div", "chip-section");
        section.dataset.dimension = dimension;
        section.append(createElement(this.document, "div", "chip-title", title));
        const chips = createElement(this.document, "div", "chips");
        const addRow = createElement(this.document, "div", "chip-add");
        const addInput = createElement(this.document, "input");
        addInput.type = "text";
        addInput.placeholder = placeholder;
        const addButton = createElement(this.document, "button", "secondary", "\u65B0\u589E");
        addRow.append(addInput, addButton);
        section.append(chips, addRow);
        customBody.append(section);
        return { chips, addInput, addButton };
      };
      const styleEditor = createChipSection(
        "style",
        "\u81EA\u8A02\u984F\u8272\uFF0F\u6A23\u5F0F",
        "\uFF0B\u81EA\u8A02\u984F\u8272"
      );
      const sizeEditor = createChipSection(
        "size",
        "\u81EA\u8A02\u5C3A\u5BF8",
        "\uFF0B\u81EA\u8A02\u5C3A\u5BF8"
      );
      const customHint = createElement(this.document, "div", "hint");
      customBody.append(customHint);
      const noSpecsBadge = createElement(
        this.document,
        "div",
        "no-spec-badge",
        "\u7121\u898F\u683C\u5546\u54C1\uFF1A\u8ACB\u78BA\u8A8D\u984F\u8272\u8207\u5C3A\u5BF8\u4E0D\u662F\u6F0F\u586B\u3002"
      );
      const profileHint = createElement(this.document, "div", "hint");
      const pause = createElement(this.document, "button", "secondary wide", "\u66AB\u505C\u6536\u55AE");
      currentBox.append(noSpecsBadge, profileHint, addSingle, pause);
      const monitorBox = createElement(this.document, "section", "box monitor-box");
      const monitorTitle = createElement(this.document, "div", "box-title");
      monitorTitle.append(createElement(this.document, "span", "", "\u2462 \u76E3\u770B"));
      const monitorToggle = createElement(
        this.document,
        "button",
        "secondary section-toggle",
        "\u6536\u5408"
      );
      monitorToggle.type = "button";
      monitorToggle.setAttribute("aria-expanded", "true");
      monitorTitle.append(monitorToggle);
      const monitorBody = createElement(this.document, "div", "section-body show");
      monitorBox.append(monitorTitle, monitorBody);
      const stats = createElement(this.document, "div", "stats");
      const statNames = [
        ["raw", "Raw"],
        ["confirmed", "\u6709\u6548"],
        ["review", "\u5F85\u78BA\u8A8D"],
        ["inactive", "\u975E\u672C\u5546\u54C1"],
        ["paused", "\u66AB\u505C\u671F\u9593"],
        ["host", "\u4E3B\u64AD\u8A0A\u606F"],
        ["inquiry", "\u5546\u54C1\u8A62\u554F"],
        ["anomaly", "DOM\u7570\u5E38"],
        ["orderLines", "\u558A\u55AE\u5247\u6578"],
        ["reviewLines", "\u5F85\u78BA\u8A8D\u6BB5\u6578"],
        ["groups", "\u5F59\u7E3D\u7D44\u5408\u6578"],
        ["units", "\u5F59\u7E3D\u4EF6\u6578"]
      ];
      for (const [key, label] of statNames) {
        const stat = createElement(this.document, "div", "stat");
        const value = createElement(this.document, "b", "", "0");
        stat.append(value, createElement(this.document, "span", "", label));
        stats.append(stat);
        this.elements[`stat_${key}`] = value;
      }
      monitorBody.append(stats);
      monitorBody.append(createElement(this.document, "h3", "", "\u6700\u8FD1\u64F7\u53D6"));
      const recent = createElement(this.document, "div", "recent");
      monitorBody.append(recent);
      workspace.append(currentBox, catalogBox, monitorBox);
      body.append(workspace);
      const panelFooter = createElement(this.document, "div", "panel-footer");
      const includeInactiveLabel = createElement(this.document, "label", "check");
      const includeInactive = createElement(this.document, "input");
      includeInactive.type = "checkbox";
      includeInactiveLabel.append(
        includeInactive,
        createElement(this.document, "span", "", "\u532F\u51FA\u6642\u9644\u4E0A\u975E\u672C\u5546\u54C1\u7559\u8A00\uFF08\u7A3D\u6838\u7528\u9014\uFF09")
      );
      panelFooter.append(includeInactiveLabel);
      const actions = createElement(this.document, "div", "actions");
      const exportButton = createElement(this.document, "button", "primary", "\u532F\u51FA CSV");
      const clearButton = createElement(this.document, "button", "danger", "\u6E05\u9664\u672C\u5834");
      const clearOldButton = createElement(this.document, "button", "secondary", "\u6E05\u9664\u820A\u5834\u6B21");
      clearOldButton.style.gridColumn = "1 / -1";
      actions.append(exportButton, clearButton, clearOldButton);
      const footer = createElement(this.document, "div", "footer");
      panelFooter.append(actions, footer);
      panel.append(body, panelFooter);
      this.shadow.append(panel);
      (this.document.body ?? this.document.documentElement).append(this.host);
      Object.assign(this.elements, {
        panel,
        header,
        collapse,
        body,
        panelFooter,
        banner,
        dot,
        statusText,
        session,
        sessionNotice,
        workspace,
        catalogBox,
        catalogTitle,
        catalogToggle,
        catalogBody,
        priceRequired,
        catalogInput,
        parseCatalog,
        applyCatalog,
        catalogSummary,
        catalogPreview,
        storedCatalogSummary,
        startLines,
        copyAllStartLines,
        currentBox,
        activeCode,
        input,
        apply,
        activeMeta,
        lookupHint,
        introducedSection,
        introducedToggle,
        introducedSummary,
        introducedRemoved,
        introducedList,
        addSingle,
        singleForm,
        singleInputs,
        singleLabels,
        singleHint,
        saveSingle: addSingle,
        styleChips: styleEditor.chips,
        styleAddInput: styleEditor.addInput,
        styleAddButton: styleEditor.addButton,
        sizeChips: sizeEditor.chips,
        sizeAddInput: sizeEditor.addInput,
        sizeAddButton: sizeEditor.addButton,
        builtinSpecs,
        builtinSpecGroups,
        customGroup,
        customToggle,
        customBody,
        customHint,
        noSpecsBadge,
        profileHint,
        pause,
        monitorBox,
        monitorToggle,
        monitorBody,
        recent,
        includeInactive,
        exportButton,
        clearButton,
        clearOldButton,
        footer
      });
      this.bindEvents();
    }
    bindEvents() {
      const e = this.elements;
      e.collapse.addEventListener("click", () => {
        const collapsed = e.panel.classList.toggle("collapsed");
        e.collapse.textContent = collapsed ? "\u5C55\u958B" : "\u6536\u5408";
        this.keepPanelInViewport();
      });
      e.catalogToggle.addEventListener("click", () => {
        this.setSectionExpanded("catalog", !this.catalogExpanded);
      });
      e.monitorToggle.addEventListener("click", () => {
        this.setSectionExpanded("monitor", !this.monitorExpanded);
      });
      e.priceRequired.addEventListener("change", () => {
        this.priceRequired = e.priceRequired.checked;
        writePriceRequiredPreference(this.window, this.priceRequired);
        if (this.priceRequired && this.singlePriceIsDefault) {
          e.singleInputs.price.value = "";
          this.singlePriceIsDefault = false;
        } else if (!this.priceRequired && !e.singleInputs.price.value.trim()) {
          e.singleInputs.price.value = "999";
          this.singlePriceIsDefault = true;
        }
        if (this.parsedCatalog || e.catalogInput.value.trim()) this.parseCatalogInput();
        this.updateSingleValidation();
      });
      e.parseCatalog.addEventListener("click", () => this.parseCatalogInput());
      e.applyCatalog.addEventListener("click", () => {
        void this.applyCatalog();
      });
      e.input.addEventListener("input", () => this.handleCandidateCodeChange());
      e.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.applyCode();
      });
      e.apply.addEventListener("click", () => this.applyCode());
      e.introducedToggle.addEventListener("click", () => {
        this.introducedExpanded = !this.introducedExpanded;
        e.introducedList.classList.toggle("show", this.introducedExpanded);
        e.introducedToggle.textContent = this.introducedExpanded ? "\u6536\u5408" : "\u5C55\u958B";
        e.introducedToggle.setAttribute("aria-expanded", String(this.introducedExpanded));
      });
      e.pause.addEventListener("click", () => this.callbacks.onPause?.());
      for (const [key, field] of Object.entries(e.singleInputs)) {
        field.addEventListener("input", () => {
          if (key === "price") this.singlePriceIsDefault = false;
          this.updateSingleValidation();
        });
      }
      e.addSingle.addEventListener("click", () => {
        void this.saveSingleProduct();
      });
      e.styleAddButton.addEventListener("click", () => this.addDraftToken("style"));
      e.sizeAddButton.addEventListener("click", () => this.addDraftToken("size"));
      e.customToggle.addEventListener("click", () => {
        this.setCustomExpanded(!this.customExpanded);
      });
      for (const group of Object.values(e.builtinSpecGroups)) {
        group.toggle.addEventListener("click", () => {
          group.expanded = !group.expanded;
          group.body.classList.toggle("show", group.expanded);
          group.toggle.textContent = group.expanded ? "\u6536\u5408" : "\u5C55\u958B";
          group.toggle.setAttribute("aria-expanded", String(group.expanded));
        });
        group.selectAll.addEventListener("click", () => this.selectAllBuiltinKeywords(group.definition));
        group.clear.addEventListener("click", () => this.clearBuiltinKeywords(group.definition));
        for (const [value, checkbox] of group.checkboxes) {
          checkbox.addEventListener("change", () => this.setBuiltinKeyword(group.definition, value, checkbox.checked));
        }
      }
      for (const [dimension, input] of [
        ["style", e.styleAddInput],
        ["size", e.sizeAddInput]
      ]) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.addDraftToken(dimension);
          }
        });
      }
      e.copyAllStartLines.addEventListener("click", () => this.callbacks.onCopyAllStartLines?.());
      e.exportButton.addEventListener("click", () => this.callbacks.onExport?.({ includeInactive: e.includeInactive.checked }));
      e.clearButton.addEventListener("click", () => {
        if (!this.window.confirm("\u78BA\u5B9A\u8981\u6E05\u9664\u76EE\u524D\u76F4\u64AD\u5834\u6B21\u7684\u672C\u6A5F\u8CC7\u6599\u55CE\uFF1F")) return;
        if (!this.window.confirm("\u6B64\u52D5\u4F5C\u7121\u6CD5\u5FA9\u539F\u3002\u8ACB\u518D\u6B21\u78BA\u8A8D\u6E05\u9664\u672C\u5834\u8CC7\u6599\u3002")) return;
        this.callbacks.onClearSession?.();
      });
      e.clearOldButton.addEventListener("click", () => this.callbacks.onClearOldSessions?.());
      this.bindDragging();
      this.bindViewportConstraints();
    }
    setSectionExpanded(section, expanded) {
      const isCatalog = section === "catalog";
      const body = isCatalog ? this.elements.catalogBody : this.elements.monitorBody;
      const toggle = isCatalog ? this.elements.catalogToggle : this.elements.monitorToggle;
      if (isCatalog) this.catalogExpanded = Boolean(expanded);
      else this.monitorExpanded = Boolean(expanded);
      body.classList.toggle("show", Boolean(expanded));
      toggle.textContent = expanded ? "\u6536\u5408" : "\u5C55\u958B";
      toggle.setAttribute("aria-expanded", String(Boolean(expanded)));
    }
    setCustomExpanded(expanded) {
      this.customExpanded = Boolean(expanded);
      this.elements.customBody.classList.toggle("show", this.customExpanded);
      this.elements.customToggle.textContent = this.customExpanded ? "\u6536\u5408" : "\u5C55\u958B";
      this.elements.customToggle.setAttribute("aria-expanded", String(this.customExpanded));
    }
    keepPanelInViewport(position = {}) {
      const { panel } = this.elements;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const viewportWidth = Number(this.window.innerWidth) || rect.width;
      const viewportHeight = Number(this.window.innerHeight) || rect.height;
      const requestedLeft = position.left ?? rect.left;
      const requestedTop = position.top ?? rect.top;
      const maxLeft = Math.max(0, viewportWidth - rect.width);
      const maxTop = Math.max(0, viewportHeight - rect.height);
      const left = Math.min(Math.max(0, requestedLeft), maxLeft);
      const top = Math.min(Math.max(0, requestedTop), maxTop);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.bottom = "auto";
    }
    bindDragging() {
      const { header, panel } = this.elements;
      let drag = null;
      header.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button")) return;
        const rect = panel.getBoundingClientRect();
        drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        header.setPointerCapture?.(event.pointerId);
      });
      header.addEventListener("pointermove", (event) => {
        if (!drag) return;
        this.keepPanelInViewport({
          left: event.clientX - drag.x,
          top: event.clientY - drag.y
        });
      });
      const end = () => {
        drag = null;
      };
      header.addEventListener("pointerup", end);
      header.addEventListener("pointercancel", end);
    }
    bindViewportConstraints() {
      this.window.addEventListener("resize", () => this.keepPanelInViewport());
      const ResizeObserverClass = this.window.ResizeObserver;
      if (!ResizeObserverClass) return;
      this.panelResizeObserver = new ResizeObserverClass(() => this.keepPanelInViewport());
      this.panelResizeObserver.observe(this.elements.panel);
    }
    parseCatalogInput() {
      this.parsedCatalog = parseCatalogTsv(this.elements.catalogInput.value, {
        priceRequired: this.priceRequired
      });
      this.renderCatalogPreview();
      this.updateCatalogControls();
      return this.parsedCatalog;
    }
    renderCatalogPreview() {
      const e = this.elements;
      e.catalogPreview.replaceChildren();
      this.previewRows = [];
      const parsed = this.parsedCatalog;
      if (!parsed?.rows.length) {
        e.catalogPreview.append(createElement(this.document, "div", "preview-row", "\u5C1A\u7121\u53EF\u9810\u89BD\u8CC7\u6599"));
        return;
      }
      for (const row of parsed.rows) {
        const wrapper = createElement(
          this.document,
          "div",
          `preview-row${row.errors.length ? " error" : row.noSpecsWarning ? " no-spec" : ""}`
        );
        const fieldsWrapper = createElement(this.document, "div", "preview-fields");
        const inputs = [];
        if (row.rawFields.length === 5) {
          for (let index = 0; index < 5; index += 1) {
            const field = createElement(this.document, "input");
            field.type = "text";
            field.value = row.rawFields[index];
            field.title = CATALOG_HEADERS[index];
            field.addEventListener("change", () => this.reparseEditedPreview());
            inputs.push(field);
            fieldsWrapper.append(field);
          }
        } else {
          fieldsWrapper.append(createElement(
            this.document,
            "div",
            "",
            `\u7B2C ${row.sourceRow} \u5217\uFF1A${row.rawFields.join(" | ")}`
          ));
        }
        const status = createElement(
          this.document,
          "div",
          "preview-status",
          issueSummary(row) || "\u53EF\u5957\u7528"
        );
        if (row.product?.priceIsProvisional) {
          status.append(createElement(this.document, "span", "price-status", "\u66AB\u5B9A\u50F9"));
        }
        wrapper.append(fieldsWrapper, status);
        e.catalogPreview.append(wrapper);
        this.previewRows.push({ row, inputs });
      }
    }
    reparseEditedPreview() {
      const lines = this.previewRows.map(({ row, inputs }) => inputs.length === 5 ? inputs.map((input) => input.value).join("	") : row.rawFields.join("	"));
      this.elements.catalogInput.value = lines.join("\n");
      this.parseCatalogInput();
    }
    updateCatalogControls() {
      const e = this.elements;
      const parsed = this.parsedCatalog;
      const validCount = parsed?.validProducts.length ?? 0;
      const errorRows = new Set((parsed?.errors ?? []).map((entry) => entry.sourceRow).filter((value) => value != null)).size;
      const warningCount = parsed?.warnings.length ?? 0;
      const provisionalCount = parsed?.validProducts.filter((product) => product.priceIsProvisional).length ?? 0;
      e.catalogSummary.textContent = parsed ? `\u53EF\u5957\u7528 ${validCount} \u500B\u30FB\u932F\u8AA4 ${errorRows} \u5217\u30FB\u63D0\u9192 ${warningCount} \u9805${provisionalCount ? `\u30FB\u5176\u4E2D ${provisionalCount} \u7B46\u70BA\u66AB\u5B9A\u50F9 999` : ""}` : "\u5C1A\u672A\u8CBC\u4E0A\u5546\u54C1\u6E05\u55AE";
      e.catalogSummary.className = `hint${errorRows ? " error" : warningCount || provisionalCount ? " warn" : ""}`;
      e.applyCatalog.textContent = parsed ? `\u5957\u7528 ${validCount} \u500B\u6709\u6548\u5546\u54C1` : "\u5C1A\u672A\u89E3\u6790";
      e.applyCatalog.disabled = !this.state.canWrite || this.catalogSaving || validCount === 0;
      e.parseCatalog.disabled = !this.state.canWrite || this.catalogSaving;
      e.catalogInput.disabled = !this.state.canWrite || this.catalogSaving;
      e.priceRequired.disabled = !this.state.canWrite || this.catalogSaving;
    }
    async applyCatalog() {
      if (!this.parsedCatalog) this.parseCatalogInput();
      if (!this.parsedCatalog?.validProducts.length) return;
      this.catalogSaving = true;
      this.updateCatalogControls();
      try {
        await this.callbacks.onApplyCatalog?.(this.elements.catalogInput.value, {
          priceRequired: this.priceRequired
        });
      } finally {
        this.catalogSaving = false;
        this.updateCatalogControls();
      }
    }
    handleCandidateCodeChange() {
      this.codeInputDirty = true;
      const nextCode = normalizeProductCode(this.elements.input.value);
      if (nextCode !== this.candidateCode) {
        this.candidateCode = nextCode;
        this.draftDirty = false;
        this.lastDraftSource = null;
        this.elements.singleInputs.productName.value = "";
        this.elements.singleInputs.price.value = this.priceRequired ? "" : "999";
        this.singlePriceIsDefault = !this.priceRequired;
        this.closeSingleForm();
      }
      this.syncCandidateDraft();
      this.updateCurrentControls();
      this.updateSingleValidation();
    }
    syncCandidateDraft({ force = false } = {}) {
      const code = normalizeProductCode(this.elements.input.value);
      const product = code ? this.state.catalogByCode?.get(code) ?? null : null;
      const fallbackActive = code && code === this.state.activeCode && !product ? { specProfile: this.state.specProfile, productName: this.state.productName, price: this.state.price } : null;
      const source = product ?? fallbackActive;
      const sourceKey = JSON.stringify([
        this.state.sessionId ?? null,
        code,
        this.state.catalogRevision ?? 0,
        code === this.state.activeCode ? this.state.profileRevision ?? 0 : 0,
        Boolean(product)
      ]);
      if (!force && sourceKey === this.lastDraftSource) return;
      if (!force && this.draftDirty && code === this.candidateCode) return;
      this.lastDraftSource = sourceKey;
      this.draft = source?.specProfile ? profileDimensions(source.specProfile) : { style: [], size: [] };
      this.draftDirty = false;
      this.renderDraftChips();
    }
    renderDraftChips() {
      this.renderDimensionChips("style", this.elements.styleChips);
      this.renderDimensionChips("size", this.elements.sizeChips);
      this.syncBuiltinSpecSelectors();
    }
    renderDimensionChips(dimension, container) {
      container.replaceChildren();
      const values = this.draft[dimension];
      for (let index = 0; index < values.length; index += 1) {
        if (BUILTIN_SPEC_BY_CANONICAL.has(canonicalizeSpecKeyword(values[index]))) continue;
        const row = createElement(this.document, "div", "chip");
        const input = createElement(this.document, "input");
        input.type = "text";
        input.value = values[index];
        input.addEventListener("input", () => {
          this.draft[dimension][index] = input.value;
          this.markDraftDirty();
        });
        input.addEventListener("change", () => {
          this.commitDraftTokenEdit(dimension, index);
        });
        const remove = createElement(this.document, "button", "danger", "\u522A");
        remove.addEventListener("click", () => {
          this.draft[dimension].splice(index, 1);
          this.markDraftDirty({ rerender: true });
        });
        row.append(input, remove);
        container.append(row);
      }
      if (!container.children.length) {
        container.append(createElement(this.document, "div", "hint", "\u5C1A\u7121\u81EA\u8A02\u8A5E"));
      }
    }
    commitDraftTokenEdit(dimension, index) {
      const value = this.draft[dimension][index]?.trim() ?? "";
      if (!value) {
        this.draft[dimension].splice(index, 1);
        this.markDraftDirty({ rerender: true });
        return;
      }
      const canonical = canonicalizeSpecKeyword(value);
      const builtin = BUILTIN_SPEC_BY_CANONICAL.get(canonical);
      if (builtin) {
        this.draft[dimension].splice(index, 1);
        this.selectBuiltinFromCustom(builtin, dimension);
        return;
      }
      const duplicate = Object.entries(this.draft).some(([otherDimension, values]) => values.some((current, otherIndex) => !(otherDimension === dimension && otherIndex === index) && canonicalizeSpecKeyword(current) === canonical));
      if (duplicate) {
        this.draft[dimension].splice(index, 1);
        this.elements.customHint.textContent = `\u300C${value}\u300D\u5DF2\u5B58\u5728\uFF0C\u4E0D\u6703\u91CD\u8907\u65B0\u589E\u3002`;
        this.markDraftDirty({ rerender: true });
        return;
      }
      this.draft[dimension][index] = value;
      this.elements.customHint.textContent = "";
      this.markDraftDirty({ rerender: true });
    }
    addDraftToken(dimension) {
      const input = dimension === "style" ? this.elements.styleAddInput : this.elements.sizeAddInput;
      const value = input.value.trim();
      if (!value) return;
      const canonical = canonicalizeSpecKeyword(value);
      const builtin = BUILTIN_SPEC_BY_CANONICAL.get(canonical);
      if (builtin) {
        input.value = "";
        this.selectBuiltinFromCustom(builtin, dimension);
        return;
      }
      if (Object.values(this.draft).some((values) => values.some((current) => canonicalizeSpecKeyword(current) === canonical))) {
        input.value = "";
        this.elements.customHint.textContent = `\u300C${value}\u300D\u5DF2\u5B58\u5728\uFF0C\u4E0D\u6703\u91CD\u8907\u65B0\u589E\u3002`;
        this.syncBuiltinSpecSelectors();
        return;
      }
      this.draft[dimension].push(value);
      input.value = "";
      this.elements.customHint.textContent = "";
      this.markDraftDirty({ rerender: true });
    }
    selectBuiltinFromCustom(builtin, sourceDimension) {
      const canonical = canonicalizeSpecKeyword(builtin.value);
      for (const dimension of ["style", "size"]) {
        this.draft[dimension] = this.draft[dimension].filter((value) => canonicalizeSpecKeyword(value) !== canonical);
      }
      const targetDimension = builtin.definition.dimension;
      this.draft[targetDimension].push(builtin.value);
      this.elements.customHint.textContent = sourceDimension === targetDimension ? "" : `\u300C${builtin.value}\u300D\u662F\u5167\u5EFA${builtin.definition.title}\uFF0C\u5DF2\u6539\u70BA\u52FE\u9078\u300C${builtin.definition.title}\u300D\u7D44\u3002`;
      this.markDraftDirty({ rerender: true });
    }
    markDraftDirty({ rerender = false } = {}) {
      this.draftDirty = true;
      if (rerender) this.renderDraftChips();
      else this.syncBuiltinSpecSelectors();
      this.updateCurrentControls();
      this.updateSingleValidation();
    }
    setBuiltinKeyword(definition, value, selected) {
      const dimension = definition.dimension;
      const canonical = canonicalizeSpecKeyword(value);
      if (selected) {
        if (!this.draft[dimension].some((current) => canonicalizeSpecKeyword(current) === canonical)) {
          this.draft[dimension].push(value);
        }
      } else {
        this.draft[dimension] = this.draft[dimension].filter((current) => canonicalizeSpecKeyword(current) !== canonical);
      }
      this.markDraftDirty({ rerender: true });
    }
    selectAllBuiltinKeywords(definition) {
      const values = this.draft[definition.dimension];
      const existing = new Set(values.map(canonicalizeSpecKeyword));
      for (const value of definition.values) {
        const canonical = canonicalizeSpecKeyword(value);
        if (existing.has(canonical)) continue;
        values.push(value);
        existing.add(canonical);
      }
      this.markDraftDirty({ rerender: true });
    }
    clearBuiltinKeywords(definition) {
      const builtins = new Set(definition.values.map(canonicalizeSpecKeyword));
      this.draft[definition.dimension] = this.draft[definition.dimension].filter((value) => !builtins.has(canonicalizeSpecKeyword(value)));
      this.markDraftDirty({ rerender: true });
    }
    syncBuiltinSpecSelectors() {
      for (const group of Object.values(this.elements.builtinSpecGroups ?? {})) {
        const selected = new Set(
          this.draft[group.definition.dimension].map(canonicalizeSpecKeyword)
        );
        let selectedCount = 0;
        for (const [value, checkbox] of group.checkboxes) {
          checkbox.checked = selected.has(canonicalizeSpecKeyword(value));
          if (checkbox.checked) selectedCount += 1;
        }
        group.title.textContent = `${group.definition.title}\uFF08\u5DF2\u9078 ${selectedCount}/${group.definition.values.length}\uFF09`;
      }
    }
    readDraftProfile() {
      return buildImportedSpecProfile({
        styles: this.draft.style.map((value) => value.trim()).filter(Boolean),
        sizes: this.draft.size.map((value) => value.trim()).filter(Boolean)
      });
    }
    updateCurrentControls() {
      if (!this.elements.apply) return;
      const e = this.elements;
      const canWrite = Boolean(this.state.canWrite) && !this.profileSaving;
      const code = normalizeProductCode(e.input.value);
      const product = code ? this.state.catalogByCode?.get(code) ?? null : null;
      const profile = this.readDraftProfile();
      const compiled = compileSpecProfile(profile);
      const catalogPresent = Boolean(product);
      const canEditDraft = canWrite && Boolean(code);
      const addingProduct = canEditDraft && !catalogPresent;
      e.apply.disabled = !canWrite || !code || !catalogPresent || !compiled.valid;
      e.apply.textContent = code === this.state.activeCode && this.draftDirty ? "\u66F4\u65B0\u898F\u683C" : "\u5957\u7528\uFF0F\u5207\u63DB";
      e.singleForm.classList.toggle("show", addingProduct);
      e.addSingle.style.display = addingProduct ? "" : "none";
      if (!code) {
        e.lookupHint.textContent = "\u8ACB\u8F38\u5165\u4E00\u500B\u82F1\u6587\u5B57\u6BCD\u52A0\u5169\u6216\u4E09\u4F4D\u6578\u5B57\u7684\u5546\u54C1\u78BC\u3002";
        e.lookupHint.className = "hint error";
      } else if (!catalogPresent) {
        e.lookupHint.textContent = code === this.state.activeCode ? "\u76EE\u524D\u5546\u54C1\u5DF2\u4E0D\u5728\u6E05\u55AE\uFF1B\u4ECD\u6703\u7167\u6536\u55AE\uFF0C\u5207\u8D70\u5F8C\u8981\u518D\u5207\u56DE\u8ACB\u5148\u55AE\u7B46\u65B0\u589E\u3002" : "\u6B64\u78BC\u5C1A\u672A\u52A0\u5165\u672C\u5834\u5546\u54C1\u6E05\u55AE\u3002";
        e.lookupHint.className = "hint warn";
      } else {
        e.lookupHint.textContent = `${product.productName || "\uFF08\u54C1\u540D\u7A7A\u767D\uFF09"}\u30FB\u50F9\u683C ${product.price}`;
        e.lookupHint.className = "hint";
      }
      const noSpecs = this.draft.style.length === 0 && this.draft.size.length === 0;
      e.noSpecsBadge.classList.toggle("show", noSpecs && Boolean(code));
      e.profileHint.textContent = !compiled.valid ? compiled.errors.map((error) => error.code).join("\u3001") : catalogPresent ? "\u53EF\u5728\u5957\u7528\u524D\u52FE\u9078\u5167\u5EFA\u898F\u683C\u6216\u7DE8\u8F2F\u81EA\u8A02\u8A5E\uFF1B\u53EA\u6709\u672C\u5546\u54C1\u6703\u53D7\u5F71\u97FF\u3002" : code ? "\u54C1\u540D\u53EF\u7559\u7A7A\uFF1B\u78BA\u8A8D\u50F9\u683C\u8207\u898F\u683C\u5F8C\uFF0C\u6309\u300C\u52A0\u5165\u5546\u54C1\u6E05\u55AE\u300D\u4FDD\u5B58\u3002" : "";
      e.input.disabled = !canWrite;
      e.pause.disabled = !canWrite || !this.state.activeCode;
      for (const control of [
        e.styleAddInput,
        e.styleAddButton,
        e.sizeAddInput,
        e.sizeAddButton,
        ...e.styleChips.querySelectorAll("input,button"),
        ...e.sizeChips.querySelectorAll("input,button")
      ]) control.disabled = !canEditDraft;
      for (const group of Object.values(e.builtinSpecGroups)) {
        group.selectAll.disabled = !canEditDraft;
        group.clear.disabled = !canEditDraft;
        for (const checkbox of group.checkboxes.values()) {
          checkbox.disabled = !canEditDraft;
        }
      }
    }
    applyCode() {
      const code = normalizeProductCode(this.elements.input.value);
      if (!code) {
        this.showBanner("\u5546\u54C1\u78BC\u5FC5\u9808\u662F\u4E00\u500B\u82F1\u6587\u5B57\u6BCD\u52A0\u5169\u6216\u4E09\u4F4D\u6578\u5B57\uFF0C\u4F8B\u5982 A01 \u6216 A010\u3002", "error");
        return;
      }
      if (!this.state.catalogByCode?.has(code)) {
        this.showBanner("\u6B64\u78BC\u5C1A\u672A\u52A0\u5165\u672C\u5834\u5546\u54C1\u6E05\u55AE\uFF0C\u8ACB\u5148\u4F7F\u7528\u55AE\u7B46\u65B0\u589E\u3002", "error");
        return;
      }
      const profile = this.readDraftProfile();
      const compiled = compileSpecProfile(profile);
      if (!compiled.valid) {
        this.showBanner(`\u898F\u683C\u8A2D\u5B9A\u7121\u6548\uFF1A${compiled.errors.map((entry) => entry.code).join("\u3001")}`, "error");
        return;
      }
      const current = this.state.activeCode;
      if (current && current !== code && !this.window.confirm(
        `\u8981\u628A\u76EE\u524D\u5546\u54C1\u5F9E ${current} \u5207\u63DB\u70BA ${code} \u55CE\uFF1F${current} \u5DF2\u4ECB\u7D39\u904E\uFF0C\u4E4B\u5F8C\u4ECD\u53EF\u7531\u8CB7\u5BB6\u76F4\u63A5\u558A ${current} \u56DE\u8CFC\u3002`
      )) return;
      this.callbacks.onApplyCode?.(code, profile);
    }
    closeSingleForm() {
      this.elements.singleForm?.classList.remove("show");
    }
    singleFields() {
      return {
        productCode: normalizeProductCode(this.elements.input.value) ?? this.elements.input.value,
        productName: this.elements.singleInputs.productName.value,
        stylesText: this.draft.style.join("\u3001"),
        sizesText: this.draft.size.join("\u3001"),
        price: this.elements.singleInputs.price.value
      };
    }
    updateSingleValidation() {
      if (!this.elements.saveSingle) return null;
      this.elements.singleLabels.price.textContent = this.priceRequired ? "\u50F9\u683C\uFF08\u5FC5\u586B\uFF09" : "\u50F9\u683C\uFF08\u9078\u586B\u30FB\u7A7A\u767D\u2192999 \u66AB\u5B9A\u50F9\uFF09";
      this.elements.singleInputs.price.placeholder = this.priceRequired ? "\u8ACB\u8F38\u5165\u50F9\u683C" : "999\uFF08\u66AB\u5B9A\u50F9\uFF09";
      const validation = validateCatalogFields(this.singleFields(), {
        priceRequired: this.priceRequired,
        priceIsProvisional: this.singlePriceIsDefault
      });
      const messages = [...validation.errors, ...validation.warnings].map((entry) => entry.message);
      this.elements.singleHint.textContent = messages.join("\uFF1B") || "\u8CC7\u6599\u6B63\u78BA\uFF0C\u53EF\u52A0\u5165\u672C\u5834\u6E05\u55AE\u3002";
      this.elements.singleHint.className = `hint span2${validation.errors.length ? " error" : validation.warnings.length ? " warn" : ""}`;
      for (const input of Object.values(this.elements.singleInputs)) {
        input.disabled = !this.state.canWrite || this.singleSaving;
      }
      this.elements.saveSingle.disabled = !this.state.canWrite || this.singleSaving || !validation.product;
      return validation;
    }
    async saveSingleProduct() {
      const validation = this.updateSingleValidation();
      if (!validation?.product) return;
      this.singleSaving = true;
      this.updateSingleValidation();
      try {
        const saved = await this.callbacks.onAddSingleProduct?.(this.singleFields(), {
          priceRequired: this.priceRequired,
          priceIsProvisional: this.singlePriceIsDefault
        });
        if (saved) this.closeSingleForm();
      } finally {
        this.singleSaving = false;
        this.updateSingleValidation();
      }
    }
    renderIntroducedProducts(introducedProducts, progress) {
      const e = this.elements;
      e.introducedSummary.textContent = `\u672C\u5834\u9032\u5EA6\uFF5C\u5DF2\u4ECB\u7D39 ${progress.introducedCount} / \u76EE\u524D\u5546\u54C1\u7E3D\u6578 ${progress.totalCount}`;
      e.introducedRemoved.textContent = progress.removedCount ? `\u53E6\u6709 ${progress.removedCount} \u500B\u5DF2\u4ECB\u7D39\u5546\u54C1\u5DF2\u79FB\u51FA\u6E05\u55AE` : "";
      e.introducedList.replaceChildren();
      for (const product of introducedProducts) {
        const row = createElement(
          this.document,
          "div",
          `introduced-row${product.isCurrent ? " current" : ""}`
        );
        const replay = product.activationCount >= 2 ? ` \xD7${product.activationCount}` : "";
        const dimensions = profileDimensions(product.latestEntry?.specProfile);
        const parts = [
          product.productCode,
          product.productName || "\uFF08\u54C1\u540D\u7A7A\u767D\uFF09"
        ];
        if (dimensions.style.length) parts.push(dimensions.style.join("\u3001"));
        if (dimensions.size.length) parts.push(dimensions.size.join("\u3001"));
        const select = createElement(
          this.document,
          "button",
          "secondary introduced-product",
          `${parts.join("\uFF5C")}${replay}`
        );
        select.type = "button";
        select.dataset.productCode = product.productCode;
        select.addEventListener("click", () => {
          e.input.value = product.productCode;
          this.handleCandidateCodeChange();
          e.input.focus();
        });
        row.append(select);
        if (product.isCurrent) {
          row.append(createElement(this.document, "span", "history-badge current", "\u76EE\u524D"));
        }
        if (product.removedFromCatalog) {
          row.append(createElement(this.document, "span", "history-badge", "\u5DF2\u79FB\u51FA\u6E05\u55AE"));
        }
        e.introducedList.append(row);
      }
      if (!introducedProducts.length) {
        e.introducedList.append(createElement(
          this.document,
          "div",
          "hint",
          "\u672C\u5834\u5C1A\u672A\u5BE6\u969B\u5957\u7528\u5546\u54C1"
        ));
      }
      e.introducedList.classList.toggle("show", this.introducedExpanded);
      e.introducedToggle.textContent = this.introducedExpanded ? "\u6536\u5408" : "\u5C55\u958B";
      e.introducedToggle.setAttribute("aria-expanded", String(this.introducedExpanded));
    }
    renderStoredCatalog(progress) {
      const statusKey = (progress?.catalogItems ?? []).map((entry) => `${entry.productCode}:${entry.status}`).join(",");
      const provisionalKey = (this.state.catalogProducts ?? []).map((entry) => `${entry.productCode}:${entry.priceIsProvisional === true}`).join(",");
      const key = `${this.state.sessionId ?? ""}:${this.state.catalogRevision ?? 0}:${statusKey}:${provisionalKey}`;
      if (key === this.lastCatalogRenderKey) return;
      this.lastCatalogRenderKey = key;
      const products = this.state.catalogProducts ?? [];
      const statusByCode = new Map(
        (progress?.catalogItems ?? []).map((entry) => [entry.productCode, entry.status])
      );
      const statusLabels = {
        [CATALOG_PRODUCT_STATUS.CURRENT]: "\u76EE\u524D",
        [CATALOG_PRODUCT_STATUS.INTRODUCED]: "\u5DF2\u4ECB\u7D39",
        [CATALOG_PRODUCT_STATUS.SKIPPED]: "\u8DF3\u904E",
        [CATALOG_PRODUCT_STATUS.NOT_INTRODUCED]: "\u672A\u4ECB\u7D39"
      };
      const lines = buildCatalogStartLines(products, {
        date: new Date(this.state.now ?? Date.now())
      });
      this.elements.storedCatalogSummary.textContent = products.length ? `\u672C\u5834 ${products.length} \u500B\u5546\u54C1\u30FB\u7248\u672C ${this.state.catalogRevision ?? 0}` : "\u672C\u5834\u5C1A\u7121\u5546\u54C1";
      this.elements.startLines.replaceChildren();
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const product = products.find((entry) => entry.productCode === line.productCode);
        const row = createElement(this.document, "div", "start-row");
        row.append(createElement(
          this.document,
          "span",
          "source-badge",
          product?.entryOrigin === "singleAdd" ? "\u55AE\u7B46" : "TSV"
        ));
        row.append(createElement(
          this.document,
          "div",
          "start-text",
          line.error ? `${line.productCode}\uFF1A${line.error}` : line.text
        ));
        const copy = createElement(this.document, "button", "secondary", "\u8907\u88FD");
        copy.disabled = Boolean(line.error);
        copy.addEventListener("click", () => this.callbacks.onCopyStartLine?.(line.productCode));
        const status = statusByCode.get(line.productCode) ?? CATALOG_PRODUCT_STATUS.NOT_INTRODUCED;
        const statuses = createElement(this.document, "span", "start-statuses");
        if (product?.priceIsProvisional) {
          statuses.append(createElement(this.document, "span", "price-status", "\u66AB\u5B9A\u50F9"));
        }
        statuses.append(createElement(
          this.document,
          "span",
          `catalog-status status-${status}`,
          statusLabels[status]
        ));
        row.append(statuses);
        row.append(copy);
        this.elements.startLines.append(row);
      }
      if (!lines.length) {
        this.elements.startLines.append(createElement(this.document, "div", "start-row", "\u5957\u7528\u6E05\u55AE\u5F8C\u6703\u5728\u9019\u88E1\u7522\u751F\u8D77\u6A19\u7DDA"));
      }
      this.elements.copyAllStartLines.disabled = !this.state.canWrite || !lines.some((line) => !line.error);
    }
    showBanner(message, type = "warn") {
      const banner = this.elements.banner;
      banner.textContent = message ?? "";
      banner.className = message ? `banner show ${type}` : "banner";
    }
    setExporting(value) {
      this.exporting = Boolean(value);
      if (!this.elements.exportButton) return;
      this.elements.exportButton.textContent = this.exporting ? "\u532F\u51FA\u4E2D\u2026" : "\u532F\u51FA CSV";
      this.elements.exportButton.disabled = this.exporting || !this.state.sessionId;
    }
    setProfileSaving(value) {
      this.profileSaving = Boolean(value);
      this.updateCurrentControls();
    }
    render(state) {
      this.state = state;
      if (!this.host) this.mount();
      const e = this.elements;
      if (state.sessionId !== this.lastSessionId) {
        const changedExistingSession = this.lastSessionId != null;
        this.lastSessionId = state.sessionId;
        this.codeInputDirty = false;
        this.candidateCode = null;
        this.draftDirty = false;
        this.lastDraftSource = null;
        this.introducedExpanded = false;
        this.setSectionExpanded("catalog", false);
        this.setSectionExpanded("monitor", true);
        this.setCustomExpanded(false);
        e.catalogInput.value = "";
        this.parsedCatalog = null;
        this.previewRows = [];
        e.catalogPreview.replaceChildren();
        this.closeSingleForm();
        e.sessionNotice.textContent = changedExistingSession ? "\u5DF2\u63DB\u5834\uFF0C\u5148\u524D\u5C1A\u672A\u5957\u7528\u7684\u6E05\u55AE\u5DF2\u6E05\u9664\u3002" : "";
        e.sessionNotice.classList.toggle("show", changedExistingSession);
        for (const group of Object.values(e.builtinSpecGroups)) {
          group.expanded = false;
          group.body.classList.remove("show");
          group.toggle.textContent = "\u5C55\u958B";
          group.toggle.setAttribute("aria-expanded", "false");
        }
      }
      e.session.textContent = `Session\uFF1A${state.sessionId ?? "\u7121\u6CD5\u53D6\u5F97"}`;
      e.statusText.textContent = state.statusText;
      e.dot.className = `dot ${state.statusTone ?? ""}`;
      e.activeCode.textContent = state.activeCode ?? "\u6536\u55AE\u5DF2\u66AB\u505C";
      e.activeMeta.textContent = state.activeCode ? `\u6642\u6BB5 ${state.activationSequence}\u30FB\u81EA ${state.activatedAt ?? "\u2014"} \u8D77\u751F\u6548` : `\u6642\u6BB5 ${state.activationSequence ?? 0}\u30FB\u5C1A\u672A\u555F\u7528\u5546\u54C1\u78BC`;
      const typedCode = normalizeProductCode(e.input.value);
      if (this.codeInputDirty && typedCode && typedCode === state.activeCode) {
        this.codeInputDirty = false;
      }
      if (!this.codeInputDirty && this.candidateCode == null && !this.draftDirty) {
        e.input.value = state.activeCode ?? "";
        this.candidateCode = state.activeCode ?? null;
      }
      e.exportButton.disabled = this.exporting || !state.sessionId;
      e.exportButton.textContent = this.exporting ? "\u532F\u51FA\u4E2D\u2026" : "\u532F\u51FA CSV";
      e.clearButton.disabled = !state.canWrite;
      e.clearOldButton.disabled = !state.canWrite;
      this.syncCandidateDraft();
      this.updateCurrentControls();
      this.updateCatalogControls();
      this.updateSingleValidation();
      const introducedProducts = deriveIntroducedProducts(
        state.profileHistory,
        state.catalogProducts,
        state.activeCode
      );
      const catalogProgress = deriveCatalogProgress(
        state.catalogProducts,
        introducedProducts,
        state.activeCode
      );
      this.renderIntroducedProducts(introducedProducts, catalogProgress);
      this.renderStoredCatalog(catalogProgress);
      for (const [key, value] of Object.entries(state.counts ?? {})) {
        if (e[`stat_${key}`]) e[`stat_${key}`].textContent = String(value);
      }
      e.recent.replaceChildren();
      for (const record of state.recent ?? []) {
        const row = createElement(this.document, "div", "row");
        row.append(
          createElement(this.document, "div", "who", record.username || "\u672A\u77E5\u8CB7\u5BB6"),
          createElement(this.document, "div", "msg", record.rawMessage),
          createElement(this.document, "small", "", `${record.classification}\u30FB${record.firstSeenAt}`)
        );
        e.recent.append(row);
      }
      if (!state.recent?.length) e.recent.append(createElement(this.document, "div", "row", "\u5C1A\u7121\u7559\u8A00"));
      e.footer.textContent = `\u672C\u5DE5\u5177\u53EA\u4FDD\u5B58\u672C\u6A5F\u8CC7\u6599\u30FB\u7528\u91CF\u6982\u4F30 ${state.storageKb ?? 0} KB`;
      this.showBanner(state.bannerMessage, state.bannerTone);
    }
  };

  // src/app.js
  var STORAGE_USAGE_CACHE_MS = 5e3;
  var READONLY_POLL_MS = 2e3;
  var FALLBACK_BYTES_PER_COMMENT = 733;
  var LEGACY_CUSTOM_SPEC_KEYWORDS_META_KEY = "custom-spec-keywords-v1";
  function snapshotSpecProfile(config) {
    const profile = config?.specProfile;
    if (!profile) return null;
    return {
      mode: profile.mode,
      selected: {
        style: [...profile.selected?.style ?? []],
        size: [...profile.selected?.size ?? []]
      },
      customSlots: (profile.customSlots ?? []).map((slot) => ({
        value: slot.value ?? "",
        selected: slot.selected === true,
        dimension: slot.dimension ?? "style"
      })),
      displayOrder: [...profile.displayOrder ?? []],
      profileRevision: config.profileRevision ?? profile.profileRevision ?? null
    };
  }
  var ShopeeLiveCaptureApp = class {
    constructor(windowObject, options = {}) {
      this.window = windowObject;
      this.document = windowObject.document;
      this.options = options;
      this.repository = null;
      this.store = null;
      this.tabId = getOrCreateTabId(windowObject.sessionStorage, windowObject.crypto);
      this.currentSessionId = null;
      this.lock = null;
      this.domObserver = null;
      this.sessionMonitor = null;
      this.observationContexts = /* @__PURE__ */ new Map();
      this.domConnected = false;
      this.bannerMessage = "";
      this.bannerTone = "warn";
      this.initializingLock = false;
      this.renderTimer = null;
      this.renderDelayMs = 200;
      this.entryToken = 0;
      this.broadcastChannel = null;
      this.pollTimer = null;
      this.migrationSkippedKeys = [];
      this.usage = { measuredAt: 0, storageKb: "0.0", pending: false };
      this.exporting = false;
      this.lockChangePromise = null;
      this.stopped = false;
      this.panel = new CapturePanel(this.document, {
        onApplyCode: (code, specProfile) => this.applyCode(code, specProfile),
        onApplyCatalog: (text, validationOptions) => this.applyCatalogText(text, validationOptions),
        onAddSingleProduct: (fields, validationOptions) => this.addSingleProduct(fields, validationOptions),
        onCopyStartLine: (productCode) => this.copyStartLine(productCode),
        onCopyAllStartLines: () => this.copyAllStartLines(),
        onPause: () => this.pause(),
        onExport: (exportOptions) => this.exportCsv(exportOptions),
        onClearSession: () => this.clearSession(),
        onClearOldSessions: () => this.clearOldSessions()
      });
      this.handleBeforeUnload = () => {
        void this.stop();
      };
      this.handlePageHide = () => {
        void this.flushCurrentSession({ throwOnError: false });
      };
      this.handleVisibilityChange = () => {
        if (this.document.visibilityState === "hidden") {
          void this.flushCurrentSession({ throwOnError: false });
        }
      };
    }
    async start() {
      this.stopped = false;
      this.panel.mount();
      try {
        this.repository = await CaptureRepository.open({
          indexedDB: this.options.indexedDB ?? this.window.indexedDB,
          keyRange: this.options.keyRange ?? this.window.IDBKeyRange,
          name: this.options.databaseName,
          now: this.options.now ?? (() => Date.now()),
          onBlocked: () => this.reportError(new Error("IndexedDB \u5347\u7D1A\u88AB\u5176\u4ED6\u5206\u9801\u963B\u64CB\uFF0C\u8ACB\u95DC\u9589\u5176\u4ED6\u76F4\u64AD\u5206\u9801\u5F8C\u91CD\u8A66\u3002")),
          onVersionChange: () => this.reportError(new Error("\u8CC7\u6599\u5EAB\u7248\u672C\u5DF2\u66F4\u65B0\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406\u9801\u9762\u3002"))
        });
        const migration = await migrateLegacySessions(
          this.repository,
          this.window.localStorage
        );
        this.migrationSkippedKeys = migration.skippedKeys;
        this.setupStore();
        this.setupReadonlySync();
        try {
          await this.repository.deleteMeta(LEGACY_CUSTOM_SPEC_KEYWORDS_META_KEY);
        } catch (error) {
          this.reportError(error);
        }
      } catch (error) {
        this.reportError(error);
        this.render({ immediate: true });
        return false;
      }
      const initialSessionId = extractSessionId(this.window.location.href);
      await this.enterSession(initialSessionId, { source: "initial" });
      this.sessionMonitor = new UrlSessionMonitor(
        this.window,
        (next, previous, source) => {
          void this.enterSession(next, { source, previousSessionId: previous });
        }
      );
      this.sessionMonitor.start();
      this.window.addEventListener("beforeunload", this.handleBeforeUnload);
      this.window.addEventListener("pagehide", this.handlePageHide);
      this.document.addEventListener("visibilitychange", this.handleVisibilityChange);
      return true;
    }
    setupStore() {
      this.store = new IndexedCaptureStore(this.repository, {
        now: this.options.now ?? (() => Date.now()),
        setTimeout: this.window.setTimeout.bind(this.window),
        clearTimeout: this.window.clearTimeout.bind(this.window),
        isOwner: (sessionId) => Boolean(
          this.currentSessionId === sessionId && this.lock?.ownsCurrentLock()
        ),
        onWriteError: (error, details) => {
          const suffix = details?.dirtyCount ? `\uFF08\u5C1A\u6709 ${details.dirtyCount} \u7B46\u672A\u4FDD\u5B58\uFF09` : "";
          this.reportError(new Error(`${error.message}${suffix}`));
        },
        onChange: (sessionId) => {
          if (sessionId === this.currentSessionId) this.render();
        },
        onCommit: (sessionId, revision) => {
          this.broadcastChannel?.postMessage?.({
            type: "sessionCommitted",
            sessionId,
            revision
          });
          if (sessionId === this.currentSessionId) this.refreshUsageSoon();
        },
        requireCatalog: true
      });
    }
    setupReadonlySync() {
      const Broadcast = this.options.BroadcastChannel ?? this.window.BroadcastChannel;
      if (Broadcast) {
        this.broadcastChannel = new Broadcast("slocc:v3");
        this.broadcastChannel.addEventListener?.("message", (event) => {
          const message = event.data;
          if (message?.type === "sessionCommitted" && message.sessionId === this.currentSessionId && !this.lock?.isOwner) {
            void this.refreshReadonly(message.revision);
          }
        });
      }
      this.pollTimer = this.window.setInterval(() => {
        if (this.currentSessionId && !this.lock?.isOwner) void this.refreshReadonly();
      }, READONLY_POLL_MS);
    }
    async stop({ flush = true } = {}) {
      this.stopped = true;
      this.entryToken += 1;
      if (flush) await this.flushCurrentSession({ throwOnError: false });
      this.sessionMonitor?.stop();
      this.sessionMonitor = null;
      this.domObserver?.stop();
      this.domObserver = null;
      this.lock?.release();
      this.lock = null;
      await this.lockChangePromise?.catch(() => {
      });
      this.window.removeEventListener("beforeunload", this.handleBeforeUnload);
      this.window.removeEventListener("pagehide", this.handlePageHide);
      this.document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      if (this.renderTimer != null) this.window.clearTimeout(this.renderTimer);
      if (this.pollTimer != null) this.window.clearInterval(this.pollTimer);
      this.renderTimer = null;
      this.pollTimer = null;
      this.broadcastChannel?.close?.();
      this.broadcastChannel = null;
      this.repository?.close();
    }
    async flushCurrentSession(options = {}) {
      if (!this.currentSessionId || !this.lock?.isOwner || !this.store) return null;
      try {
        return await this.store.flushSession(this.currentSessionId, options);
      } catch (error) {
        this.reportError(error);
        return null;
      }
    }
    async enterSession(sessionId, { source = "initial" } = {}) {
      if (!this.store) return;
      const token = ++this.entryToken;
      const previousSessionId = this.currentSessionId;
      if (previousSessionId && this.lock?.isOwner) {
        await this.flushCurrentSession({ throwOnError: false });
      }
      if (previousSessionId) this.store.discardSession(previousSessionId);
      this.domObserver?.stop();
      this.initializingLock = true;
      this.lock?.release();
      this.initializingLock = false;
      this.observationContexts.clear();
      this.domConnected = false;
      this.currentSessionId = sessionId;
      if (!sessionId) {
        rememberTabSession(this.window.sessionStorage, null);
        this.bannerMessage = "\u7DB2\u5740\u7F3A\u5C11\u6709\u6548\u7684 session\uFF0C\u5DF2\u505C\u6B62\u5BEB\u5165\u558A\u55AE\u8CC7\u6599\u3002";
        this.bannerTone = "error";
        this.render({ immediate: true });
        return;
      }
      const sameReload = source === "initial" && isSameSessionReload(this.window.sessionStorage, sessionId);
      rememberTabSession(this.window.sessionStorage, sessionId);
      this.initializingLock = true;
      this.lock = new SessionTabLock(sessionId, this.tabId, {
        storage: this.window.localStorage,
        onChange: (isOwner) => {
          this.lockChangePromise = this.handleLockChange(isOwner).catch((error) => {
            if (!this.stopped) this.reportError(error);
          });
        }
      });
      const ownsLock = this.lock.start();
      this.initializingLock = false;
      const opening = ownsLock ? this.store.openSession(sessionId, { pauseOnOpen: !sameReload }) : this.store.loadReadonlySession(sessionId);
      if (ownsLock) this.startDomObserver();
      const openedRuntime = await opening;
      if (token !== this.entryToken) return;
      if (ownsLock) {
        this.bannerMessage = openedRuntime?.profileUpgradePaused ? "\u820A\u7248\u5546\u54C1\u8A2D\u5B9A\u7F3A\u5C11\u898F\u683C\u4E09\u614B\uFF0C\u5DF2\u5B89\u5168\u66AB\u505C\uFF1B\u8ACB\u91CD\u65B0\u9078\u64C7\u898F\u683C\u5F8C\u5957\u7528\u3002" : sameReload ? "\u5DF2\u6062\u5FA9\u540C\u4E00\u76F4\u64AD\u5834\u6B21\uFF1B\u521D\u59CB\u756B\u9762\u7559\u8A00\u53EA\u6703\u5217\u70BA\u5F85\u78BA\u8A8D\u3002" : source === "initial" ? "\u5DF2\u9032\u5165\u76F4\u64AD\u5834\u6B21\uFF0C\u8ACB\u8A2D\u5B9A\u9650\u5B9A\u5546\u54C1\u78BC\u5F8C\u958B\u59CB\u6536\u55AE\u3002" : "\u5DF2\u5075\u6E2C\u5230\u65B0\u7684\u76F4\u64AD\u5834\u6B21\u3002\u6536\u55AE\u5DF2\u66AB\u505C\uFF0C\u8ACB\u91CD\u65B0\u8A2D\u5B9A\u9650\u5B9A\u5546\u54C1\u78BC\u3002";
        this.bannerTone = "warn";
      } else {
        this.bannerMessage = "\u53E6\u4E00\u500B\u5206\u9801\u5DF2\u5728\u64F7\u53D6\u672C\u5834\u76F4\u64AD\uFF1B\u6B64\u5206\u9801\u76EE\u524D\u552F\u8B80\u3002";
        this.bannerTone = "error";
      }
      if (this.migrationSkippedKeys.length) {
        this.bannerMessage = `\u90E8\u5206\u640D\u6BC0\u820A\u8CC7\u6599\u5DF2\u9694\u96E2\u4FDD\u7559\uFF1A${this.migrationSkippedKeys.join("\u3001")}`;
        this.bannerTone = "error";
      }
      await this.refreshStorageUsage({ force: true });
      this.render({ immediate: true });
    }
    async handleLockChange(isOwner) {
      if (this.initializingLock || !this.currentSessionId || this.stopped) return;
      const sessionId = this.currentSessionId;
      this.store.discardSession(sessionId);
      this.observationContexts.clear();
      this.domObserver?.stop();
      if (isOwner) {
        await this.store.openSession(sessionId, { pauseOnOpen: true });
        if (this.stopped || sessionId !== this.currentSessionId) return;
        this.bannerMessage = "\u5DF2\u63A5\u624B\u672C\u5834\u64F7\u53D6\u3002\u70BA\u5B89\u5168\u8D77\u898B\u6536\u55AE\u5DF2\u66AB\u505C\uFF0C\u8ACB\u91CD\u65B0\u8A2D\u5B9A\u5546\u54C1\u78BC\u3002";
        this.bannerTone = "warn";
        this.startDomObserver();
      } else {
        await this.store.loadReadonlySession(sessionId);
        if (this.stopped || sessionId !== this.currentSessionId) return;
        this.bannerMessage = "\u672C\u5206\u9801\u5DF2\u5931\u53BB\u64F7\u53D6\u9396\u4E26\u5207\u63DB\u70BA\u552F\u8B80\uFF0C\u8ACB\u6AA2\u67E5\u5176\u4ED6\u76F4\u64AD\u5206\u9801\u3002";
        this.bannerTone = "error";
      }
      this.render({ immediate: true });
    }
    startDomObserver() {
      this.domObserver = new DomCommentObserver(this.document, {
        onCandidate: (candidate) => {
          void this.handleCandidate(candidate);
        },
        onStatus: ({ connected }) => {
          this.domConnected = connected;
          this.render();
        }
      });
      this.domObserver.start();
    }
    contextKey(snapshot) {
      return snapshot.commentId || [
        snapshot.uid,
        snapshot.username,
        snapshot.rawMessage
      ].join(":");
    }
    async handleCandidate(candidate) {
      if (!this.currentSessionId || !this.lock?.isOwner) return;
      const key = this.contextKey(candidate.snapshot);
      if (!this.observationContexts.has(key)) {
        const view2 = this.store.getSessionView(this.currentSessionId);
        this.observationContexts.set(key, {
          firstSeenAt: Date.now(),
          captureOrigin: candidate.captureOrigin,
          activeCodeAtFirstSeen: view2?.config.activeCode,
          activationSequenceAtFirstSeen: view2?.config.activationSequence,
          profileAtFirstSeen: snapshotSpecProfile(view2?.config),
          productMetaAtFirstSeen: {
            productName: view2?.config.productName ?? "",
            price: view2?.config.price ?? ""
          },
          latestProfileByCodeAtFirstSeen: this.store.getLatestProfileByCode(this.currentSessionId)
        });
      }
      if (candidate.phase !== "final") return;
      const context = this.observationContexts.get(key);
      const view = this.store.getSessionView(this.currentSessionId);
      if (context.activeCodeAtFirstSeen === void 0) {
        context.activeCodeAtFirstSeen = view?.config.activeCode ?? null;
        context.activationSequenceAtFirstSeen = view?.config.activationSequence ?? 0;
        context.profileAtFirstSeen = snapshotSpecProfile(view?.config);
        context.productMetaAtFirstSeen = {
          productName: view?.config.productName ?? "",
          price: view?.config.price ?? ""
        };
        context.latestProfileByCodeAtFirstSeen = this.store.getLatestProfileByCode(this.currentSessionId);
      }
      this.observationContexts.delete(key);
      try {
        const result = await this.store.recordCapture(
          this.currentSessionId,
          candidate.snapshot,
          context,
          { stable: candidate.stable }
        );
        if (result.anomaly) {
          this.bannerMessage = "\u5075\u6E2C\u5230\u540C\u4E00\u7559\u8A00 ID \u51FA\u73FE\u4E0D\u540C\u5167\u5BB9\uFF0C\u5DF2\u4FDD\u7559\u9996\u6B21\u8CC7\u6599\u4E26\u6A19\u8A18 DOM \u7570\u5E38\u3002";
          this.bannerTone = "error";
        }
      } catch (error) {
        this.reportError(error);
      }
      this.render();
    }
    async applyCode(code, specProfile) {
      if (!this.currentSessionId || !this.lock?.isOwner) return;
      this.panel.setProfileSaving(true);
      try {
        const product = this.store.getCatalogProduct(this.currentSessionId, code);
        if (!product) {
          throw new Error("\u6B64\u5546\u54C1\u78BC\u5C1A\u672A\u52A0\u5165\u672C\u5834\u5546\u54C1\u6E05\u55AE\uFF0C\u8ACB\u5148\u55AE\u7B46\u65B0\u589E\u6216\u91CD\u65B0\u532F\u5165\u3002");
        }
        const previous = this.store.getSessionView(this.currentSessionId)?.config;
        await this.store.changeActiveCode(
          this.currentSessionId,
          code,
          specProfile ?? product.specProfile,
          void 0,
          { productName: product.productName, price: product.price }
        );
        this.bannerMessage = previous?.activeCode === code ? `\u5546\u54C1 ${code} \u7684\u898F\u683C\u8A2D\u5B9A\u5DF2\u66F4\u65B0\uFF1B\u53EA\u5F71\u97FF\u66F4\u65B0\u5F8C\u9996\u6B21\u51FA\u73FE\u7684\u7559\u8A00\u3002` : `\u9650\u5B9A\u5546\u54C1 ${code} \u5DF2\u751F\u6548\uFF1B\u53EA\u8655\u7406\u6B64\u523B\u4E4B\u5F8C\u9996\u6B21\u51FA\u73FE\u7684\u7559\u8A00\u3002`;
        this.bannerTone = "warn";
      } catch (error) {
        this.reportError(error);
      } finally {
        this.panel.setProfileSaving(false);
      }
      this.render({ immediate: true });
    }
    async applyCatalogText(text, validationOptions = {}) {
      if (!this.currentSessionId || !this.lock?.isOwner) return false;
      const parsed = parseCatalogTsv(text, {
        priceRequired: validationOptions.priceRequired === true
      });
      if (!parsed.validProducts.length) {
        this.reportError(new Error("\u6C92\u6709\u53EF\u5957\u7528\u7684\u6709\u6548\u5546\u54C1\uFF0C\u8ACB\u5148\u4FEE\u6B63\u532F\u5165\u5167\u5BB9\u3002"));
        return false;
      }
      const view = this.store.getSessionView(this.currentSessionId);
      const incomingCodes = new Set(
        parsed.validProducts.map((product) => product.productCode)
      );
      const introducedCodes = new Set(
        (view?.profileHistory ?? []).map((entry) => entry.activeCode)
      );
      const singleAddedToRemove = (view?.catalogProducts ?? []).filter((product) => product.entryOrigin === "singleAdd" && !incomingCodes.has(product.productCode));
      const errorRows = [...new Set(parsed.errors.map((entry) => entry.sourceRow).filter((value) => value != null))];
      if (parsed.errors.length || singleAddedToRemove.length) {
        const messages = [];
        if (parsed.errors.length) {
          messages.push(
            `${errorRows.length || parsed.errors.length} \u5217\u6709\u932F\uFF0C\u4E0D\u6703\u5957\u7528\uFF1B\u9019\u6B21\u6703\u7528 ${parsed.validProducts.length} \u500B\u6709\u6548\u5546\u54C1\u53D6\u4EE3\u6574\u4EFD\u6E05\u55AE\u3002`
          );
        }
        if (singleAddedToRemove.length) {
          const displayCodes = singleAddedToRemove.slice(0, 10).map((product) => `${product.productCode}${introducedCodes.has(product.productCode) ? "\uFF08\u5DF2\u4ECB\u7D39\uFF09" : ""}`);
          const remainder = singleAddedToRemove.length - displayCodes.length;
          messages.push(
            `\u6703\u79FB\u9664 ${singleAddedToRemove.length} \u500B\u76F4\u64AD\u4E2D\u55AE\u7B46\u65B0\u589E\u5546\u54C1\uFF1A${displayCodes.join("\u3001")}${remainder > 0 ? `\uFF0C\u53E6\u6709 ${remainder} \u78BC` : ""}\u3002`,
            "\u5B83\u5011\u6703\u5F9E\u5546\u54C1\u6E05\u55AE\u8207\u6279\u6B21\u8D77\u6A19\u7DDA\u6D88\u5931\uFF1B\u65E2\u6709\u8A02\u55AE\u8207\u6B77\u53F2\u78BC\u558A\u55AE\u4E0D\u53D7\u5F71\u97FF\u3002\u82E5\u4E4B\u5F8C\u8981\u91CD\u65B0\u5207\u56DE\uFF0C\u9700\u518D\u6B21\u52A0\u5165\u5546\u54C1\u6E05\u55AE\u3002"
          );
        }
        if (!this.window.confirm(`${messages.join("\n")}

\u78BA\u5B9A\u53D6\u4EE3\u55CE\uFF1F`)) return false;
      }
      try {
        const saved = await this.store.replaceCatalogProducts(
          this.currentSessionId,
          parsed.validProducts
        );
        this.bannerMessage = `\u5546\u54C1\u6E05\u55AE\u5DF2\u5957\u7528 ${saved.products.length} \u500B\u5546\u54C1\uFF1B\u5C1A\u672A\u9396\u904E\u7684\u78BC\u4E0D\u6703\u81EA\u52D5\u6210\u55AE\u3002`;
        this.bannerTone = "warn";
        this.render({ immediate: true });
        return true;
      } catch (error) {
        this.reportError(error);
        this.render({ immediate: true });
        return false;
      }
    }
    async addSingleProduct(fields, validationOptions = {}) {
      if (!this.currentSessionId || !this.lock?.isOwner) return null;
      const validation = validateCatalogFields(fields, {
        priceRequired: validationOptions.priceRequired === true,
        priceIsProvisional: validationOptions.priceIsProvisional === true
      });
      if (!validation.product) {
        this.reportError(new Error(
          validation.errors.map((entry) => entry.message).join("\uFF1B") || "\u55AE\u7B46\u5546\u54C1\u8CC7\u6599\u7121\u6548\u3002"
        ));
        return null;
      }
      try {
        const saved = await this.store.addCatalogProduct(
          this.currentSessionId,
          validation.product
        );
        this.bannerMessage = `\u5546\u54C1 ${saved.product.productCode} \u5DF2\u52A0\u5165\u672C\u5834\u6E05\u55AE\uFF1B\u8ACB\u518D\u6309\u5957\u7528\uFF0F\u5207\u63DB\u624D\u958B\u59CB\u6536\u55AE\u3002`;
        this.bannerTone = "warn";
        this.render({ immediate: true });
        return saved.product;
      } catch (error) {
        this.reportError(error);
        this.render({ immediate: true });
        return null;
      }
    }
    async writeClipboard(text, successMessage) {
      try {
        const clipboard = this.options.clipboard ?? this.window.navigator.clipboard;
        if (!clipboard?.writeText) throw new Error("\u6B64\u700F\u89BD\u5668\u7121\u6CD5\u4F7F\u7528\u526A\u8CBC\u7C3F API\u3002");
        await clipboard.writeText(text);
        this.bannerMessage = successMessage;
        this.bannerTone = "warn";
        this.render({ immediate: true });
        return text;
      } catch (error) {
        this.reportError(error);
        return null;
      }
    }
    async copyStartLine(productCode) {
      const products = this.currentSessionId ? this.store.getSessionView(this.currentSessionId)?.catalogProducts ?? [] : [];
      const product = products.find((entry) => entry.productCode === productCode);
      if (!product) {
        this.reportError(new Error("\u5546\u54C1\u5DF2\u4E0D\u5728\u6E05\u55AE\uFF0C\u7121\u6CD5\u8907\u88FD\u8D77\u6A19\u7DDA\u3002"));
        return null;
      }
      const nowValue = this.options.now?.() ?? Date.now();
      const line = buildCatalogStartLines([product], { date: new Date(nowValue) })[0];
      if (line.error) {
        this.reportError(new Error(line.error));
        return null;
      }
      return this.writeClipboard(line.text, `\u5546\u54C1 ${productCode} \u8D77\u6A19\u7DDA\u5DF2\u8907\u88FD\uFF0C\u8ACB\u4EBA\u5DE5\u8CBC\u4E0A\u4E26\u9001\u51FA\u3002`);
    }
    async copyAllStartLines() {
      const products = this.currentSessionId ? this.store.getSessionView(this.currentSessionId)?.catalogProducts ?? [] : [];
      const nowValue = this.options.now?.() ?? Date.now();
      const lines = buildCatalogStartLines(products, { date: new Date(nowValue) }).filter((line) => !line.error);
      if (!lines.length) {
        this.reportError(new Error("\u76EE\u524D\u6C92\u6709\u53EF\u8907\u88FD\u7684\u8D77\u6A19\u7DDA\u3002"));
        return null;
      }
      return this.writeClipboard(
        lines.map((line) => line.text).join("\n"),
        `\u5DF2\u8907\u88FD ${lines.length} \u689D\u8D77\u6A19\u7DDA\uFF0C\u8ACB\u4EBA\u5DE5\u8CBC\u4E0A\u4E26\u9001\u51FA\u3002`
      );
    }
    async pause() {
      if (!this.currentSessionId || !this.lock?.isOwner) return;
      try {
        await this.store.pause(this.currentSessionId);
        this.bannerMessage = "\u6536\u55AE\u5DF2\u66AB\u505C\uFF1B\u7559\u8A00\u4ECD\u4FDD\u7559\u65BC raw feed\u3002";
        this.bannerTone = "warn";
      } catch (error) {
        this.reportError(error);
      }
      this.render({ immediate: true });
    }
    async exportCsv(options = {}) {
      if (!this.currentSessionId || this.exporting) return;
      const sessionId = this.currentSessionId;
      this.exporting = true;
      this.panel.setExporting(true);
      try {
        if (this.lock?.isOwner) {
          await this.flushCurrentSession();
          if (this.store.isDirty(sessionId)) {
            const dirtyCount = this.store.getSessionView(sessionId)?.dirtyCount ?? 0;
            throw new Error(`\u5C1A\u6709 ${dirtyCount} \u7B46\u7559\u8A00\u672A\u4FDD\u5B58\uFF0C\u672C\u6B21\u672A\u532F\u51FA\u3002`);
          }
        }
        const meta = await this.repository.getSession(sessionId, { create: false });
        const cutoffSequence = (meta?.nextCaptureSequence ?? 1) - 1;
        const { parts } = await buildOrdersCsvParts(this.repository, sessionId, {
          includeInactive: options.includeInactive === true,
          cutoffSequence
        });
        const blob = new this.window.Blob(parts, { type: "text/csv;charset=utf-8" });
        const url = this.window.URL.createObjectURL(blob);
        const anchor = this.document.createElement("a");
        anchor.href = url;
        anchor.download = csvFileName(sessionId);
        anchor.click();
        this.window.setTimeout(() => this.window.URL.revokeObjectURL(url), 0);
      } catch (error) {
        this.reportError(error);
      } finally {
        this.exporting = false;
        this.panel.setExporting(false);
      }
    }
    async clearSession() {
      if (!this.currentSessionId || !this.lock?.isOwner) return;
      const sessionId = this.currentSessionId;
      this.domObserver?.stop();
      this.store.discardSession(sessionId);
      try {
        await this.repository.deleteSession(sessionId);
        await this.store.openSession(sessionId, { pauseOnOpen: true });
        this.observationContexts.clear();
        this.bannerMessage = "\u672C\u5834\u8CC7\u6599\u5DF2\u6E05\u9664\uFF0C\u6536\u55AE\u7DAD\u6301\u66AB\u505C\u3002";
        this.bannerTone = "warn";
      } catch (error) {
        await this.store.openSession(sessionId);
        this.reportError(error);
      }
      this.startDomObserver();
      this.render({ immediate: true });
    }
    async clearOldSessions() {
      if (!this.currentSessionId || !this.lock?.isOwner) return;
      const oldSessionIds = (await this.repository.listSessionIds()).filter((sessionId) => sessionId !== this.currentSessionId);
      if (!oldSessionIds.length) {
        this.bannerMessage = "\u76EE\u524D\u6C92\u6709\u53EF\u6E05\u9664\u7684\u820A\u5834\u6B21\u3002";
        this.bannerTone = "warn";
        this.render({ immediate: true });
        return;
      }
      const confirmed = this.window.confirm(
        `\u5C07\u6E05\u9664 ${oldSessionIds.length} \u500B\u820A\u5834\u6B21\uFF1A
${oldSessionIds.join("\n")}

\u76EE\u524D\u5834\u6B21 ${this.currentSessionId} \u4E0D\u6703\u88AB\u6E05\u9664\u3002`
      );
      if (!confirmed) return;
      for (const sessionId of oldSessionIds) {
        this.store.discardSession(sessionId);
        await this.repository.deleteSession(sessionId);
      }
      this.bannerMessage = `\u5DF2\u6E05\u9664 ${oldSessionIds.length} \u500B\u820A\u5834\u6B21\u3002`;
      this.bannerTone = "warn";
      await this.refreshStorageUsage({ force: true });
      this.render({ immediate: true });
    }
    async refreshReadonly(expectedRevision) {
      if (!this.currentSessionId || this.lock?.isOwner) return;
      const meta = await this.repository.getSession(this.currentSessionId, { create: false });
      const current = this.store.getSessionView(this.currentSessionId);
      if (!meta) return;
      if (current && meta.revision <= current.revision && (expectedRevision == null || expectedRevision <= current.revision)) return;
      await this.store.loadReadonlySession(this.currentSessionId);
      this.render({ immediate: true });
    }
    refreshUsageSoon() {
      if (Date.now() - this.usage.measuredAt >= STORAGE_USAGE_CACHE_MS) {
        void this.refreshStorageUsage();
      }
    }
    async refreshStorageUsage({ force = false } = {}) {
      const now = Date.now();
      if (this.usage.pending) return;
      if (!force && now - this.usage.measuredAt < STORAGE_USAGE_CACHE_MS) return;
      this.usage.pending = true;
      try {
        const estimate = this.window.navigator.storage?.estimate;
        let bytes;
        if (typeof estimate === "function") {
          const result = await estimate.call(this.window.navigator.storage);
          bytes = result.usage;
        }
        if (!Number.isFinite(bytes)) {
          const raw = this.currentSessionId ? this.store.getSessionView(this.currentSessionId)?.counts.raw ?? 0 : 0;
          bytes = raw * FALLBACK_BYTES_PER_COMMENT;
        }
        this.usage = {
          measuredAt: now,
          storageKb: (bytes / 1024).toFixed(1),
          pending: false
        };
      } catch {
        this.usage = { ...this.usage, measuredAt: now, pending: false };
      }
    }
    reportError(error) {
      this.bannerMessage = error?.message ?? "\u767C\u751F\u672A\u77E5\u932F\u8AA4\u3002";
      this.bannerTone = "error";
      this.render({ immediate: true });
    }
    render({ immediate = false } = {}) {
      if (!immediate) {
        if (this.renderTimer == null) {
          this.renderTimer = this.window.setTimeout(() => {
            this.renderTimer = null;
            this.renderNow();
          }, this.renderDelayMs);
        }
        return;
      }
      if (this.renderTimer != null) this.window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
      this.renderNow();
    }
    renderNow() {
      const view = this.currentSessionId && this.store ? this.store.getSessionView(this.currentSessionId) : null;
      const sourceCounts = view?.counts ?? {};
      const orderSummary = view?.orderSummary ?? {};
      const counts = {
        raw: sourceCounts.raw ?? 0,
        confirmed: sourceCounts.confirmed ?? 0,
        review: sourceCounts.needsReview ?? 0,
        inactive: sourceCounts.inactiveCode ?? 0,
        paused: sourceCounts.paused ?? 0,
        host: sourceCounts.host ?? 0,
        inquiry: sourceCounts.productInquiry ?? 0,
        anomaly: sourceCounts.anomaly ?? 0,
        orderLines: orderSummary.orderLineCount ?? 0,
        reviewLines: orderSummary.reviewLineCount ?? 0,
        groups: orderSummary.groupCount ?? 0,
        units: orderSummary.aggregatedUnitCount ?? 0
      };
      let statusText = "\u5C1A\u672A\u9023\u63A5\u8A55\u8AD6\u5340\uFF0F\u627E\u4E0D\u5230\u8766\u76AE\u8A55\u8AD6 DOM";
      let statusTone = "error";
      if (!this.repository) {
        statusText = "IndexedDB \u7121\u6CD5\u4F7F\u7528";
      } else if (!this.currentSessionId) {
        statusText = "\u7DB2\u5740\u7F3A\u5C11 Session";
      } else if (!this.lock?.isOwner) {
        statusText = "\u552F\u8B80\uFF1A\u53E6\u4E00\u5206\u9801\u6B63\u5728\u64F7\u53D6";
      } else if (view?.state === "rebuilding") {
        statusText = "\u6B63\u5728\u91CD\u5EFA\u672C\u5834\u7D22\u5F15";
        statusTone = "warn";
      } else if (this.domConnected) {
        statusText = "\u5DF2\u9023\u63A5\u8A55\u8AD6\u5340";
        statusTone = "ok";
      }
      const canWrite = Boolean(
        this.currentSessionId && this.lock?.isOwner && view?.state === "ready"
      );
      this.panel.render({
        sessionId: this.currentSessionId,
        statusText,
        statusTone,
        canWrite,
        activeCode: view?.config.activeCode ?? null,
        activationSequence: view?.config.activationSequence ?? 0,
        profileRevision: view?.config.profileRevision ?? 0,
        specProfile: view?.config.specProfile ?? null,
        productName: view?.config.productName ?? "",
        price: view?.config.price ?? "",
        catalogRevision: view?.catalogRevision ?? 0,
        catalogProducts: view?.catalogProducts ?? [],
        catalogByCode: view?.catalogByCode ?? /* @__PURE__ */ new Map(),
        profileHistory: view?.profileHistory ?? [],
        now: this.options.now?.() ?? Date.now(),
        activatedAt: view?.config.activatedAt ? new Date(view.config.activatedAt).toLocaleTimeString("zh-TW") : null,
        counts,
        recent: view?.recent ?? [],
        storageKb: this.usage.storageKb,
        storageApproximate: true,
        bannerMessage: this.bannerMessage,
        bannerTone: this.bannerTone
      });
    }
  };

  // src/main.js
  function boot() {
    if (window.__SLOCC_APP__) return;
    const app = new ShopeeLiveCaptureApp(window);
    window.__SLOCC_APP__ = app;
    app.start();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
