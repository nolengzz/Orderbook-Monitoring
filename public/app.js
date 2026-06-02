/* ─────────────────────────────────────────────────────────────────
   REKU Order Book Dashboard — app.js  v4
   Key fixes in this version:
   - fmtApiPrice: trim trailing zeros after decimal, "9.0"→"9", "52.0"→"52"
   - liveFormatAmount: debounced, no cursor-jump loop
   - layout: equal-height panels via CSS (no JS needed)
   - asset anomaly: no highlight for normal rows
   - louder click sound
───────────────────────────────────────────────────────────────── */
"use strict";

const API = {
  bidask:      "/api/reku/bidask",
  rekuBook:    (a) => `/api/reku/orderbookall?symbol=${encodeURIComponent(a)}`,
  binanceBook: (a) => `/api/binance/depth?symbol=${encodeURIComponent(a+"USDT")}&limit=1000`,
  gateBook:    (a) => `/api/gate/order_book?currency_pair=${encodeURIComponent(a+"_USDT")}&limit=1000`,
};

const EXCLUDED      = new Set(["MIRA","AK12","DRX","CST","ANOA","ANA","USDT"]);
const DIFF_STEP_PCT = 0.05;   // 0.05 %
const OB_LIMIT      = 1000;
const REFRESH_MS    = 120_000;

const state = {
  assets: [], selectedAsset: "BTC",
  rekuBook:    { asks: [], bids: [] },
  targetBook:  { asks: [], bids: [], exchange: "binance" },
  fallbackTarget: null,
  rekuFetchedAt: null, targetFetchedAt: null, latestRefreshAt: null,
};

let clickAudioCtx = null;

const el = {
  chosenAssetTitle:   document.getElementById("chosenAssetTitle"),
  connectionStatus:   document.getElementById("connectionStatus"),
  refreshButton:      document.getElementById("refreshButton"),
  themeToggle:        document.getElementById("themeToggle"),
  rateSystem:         document.getElementById("rateSystem"),
  targetExchange:     document.getElementById("targetExchange"),
  bestAskTarget:      document.getElementById("bestAskTarget"),
  tickSize:           document.getElementById("tickSize"),
  defaultPrice:       document.getElementById("defaultPrice"),
  diffPerTick:        document.getElementById("diffPerTick"),
  currentDiffPerTick: document.getElementById("currentDiffPerTick"),
  takerSide:          document.getElementById("takerSide"),
  valueIn:            document.getElementById("valueIn"),
  tradeAmount:        document.getElementById("tradeAmount"),
  priceImpact:        document.getElementById("priceImpact"),
  priceChange:        document.getElementById("priceChange"),
  vwap:               document.getElementById("vwap"),
  askMaxPrice:        document.getElementById("askMaxPrice"),
  askTotalAsset:      document.getElementById("askTotalAsset"),
  askTotalIdr:        document.getElementById("askTotalIdr"),
  bidMinPrice:        document.getElementById("bidMinPrice"),
  bidTotalAsset:      document.getElementById("bidTotalAsset"),
  bidTotalIdr:        document.getElementById("bidTotalIdr"),
  rekuAsks:           document.getElementById("rekuAsks"),
  rekuBids:           document.getElementById("rekuBids"),
  targetAsks:         document.getElementById("targetAsks"),
  targetBids:         document.getElementById("targetBids"),
  targetExchangeName: document.getElementById("targetExchangeName"),
  rekuMeta:           document.getElementById("rekuMeta"),
  targetMeta:         document.getElementById("targetMeta"),
  rekuLevelCount:     document.getElementById("rekuLevelCount"),
  targetLevelCount:   document.getElementById("targetLevelCount"),
  assetList:          document.getElementById("assetList"),
  assetSearch:        document.getElementById("assetSearch"),
  rekuPanel:          document.getElementById("rekuPanel"),
  targetPanel:        document.getElementById("targetPanel"),
  rekuAskWrap:        document.getElementById("rekuAskWrap"),
  rekuBidWrap:        document.getElementById("rekuBidWrap"),
  targetAskWrap:      document.getElementById("targetAskWrap"),
  targetBidWrap:      document.getElementById("targetBidWrap"),
  levelTooltip:       document.getElementById("levelTooltip"),
};

/* ═══════════════════════════════════════════════════════════════
   NUMBER PARSERS — two separate functions, NEVER mix
═══════════════════════════════════════════════════════════════ */

/**
 * parseUserInput — for values the USER has typed into input fields.
 * Indonesian locale: dot=thousands, comma=decimal.
 * "17.750"     → 17750
 * "10.000.000" → 10000000
 * "1.234,56"   → 1234.56
 */
function parseUserInput(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * parseAPI — for values from ANY API response (REKU, Binance, Gate).
 * Standard dot-decimal, no thousands separator.
 * "0.000519"   → 0.000519
 * "96500.50"   → 96500.5
 * "9.2"        → 9.2        (NOT 9200!)
 * "1505586.42" → 1505586.42
 * "52"         → 52
 */
function parseAPI(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/* ═══════════════════════════════════════════════════════════════
   NUMBER FORMATTERS  (output in id-ID locale)
═══════════════════════════════════════════════════════════════ */

/**
 * Count the meaningful decimal places of a raw API dot-decimal string.
 * Trailing zeros are STRIPPED so "9.20000000" → 1, "52.0" → 0, "0.000519" → 6.
 * This means "9.0" displays as "9" and "52.0" as "52".
 */
function apiDecimalPlaces(raw) {
  const s = String(raw ?? "").trim();
  if (/[eE]/.test(s)) {
    // Scientific notation: expand then count
    const fixed = parseAPI(s).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
    return (fixed.split(".")[1] || "").length;
  }
  // Strip trailing zeros from decimal part
  const dec = (s.split(".")[1] || "").replace(/0+$/, "");
  return dec.length;
}

/**
 * Format an API price string for display in id-ID locale.
 * Preserves only the meaningful decimal places (trailing zeros stripped).
 *
 * Examples (dot-decimal in → id-ID out):
 *   "9.2"          → "9,2"
 *   "9.0"          → "9"          ← no trailing zero
 *   "52.0"         → "52"
 *   "0.000519"     → "0,000519"
 *   "96500.50"     → "96.500,5"   ← trailing zero stripped
 *   "52.900"       → "52.900"     ← only integer here, dot=thousands in id-ID
 *   "1505586.42"   → "1.505.586,42"
 */
function fmtApiPrice(rawStr) {
  const num = parseAPI(rawStr);
  if (!Number.isFinite(num) || num === 0) return "0";
  const dp = apiDecimalPlaces(rawStr);
  return new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(num);
}

/** Format a JS number (already parsed) with up to maxDp significant decimal places. */
function fmt(num, maxDp = 8) {
  if (num === undefined || num === null || !Number.isFinite(num) || num === 0) return "0";
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: maxDp }).format(num);
}

/** Format money-like totals (IDR volumes etc.) */
function fmtMoney(num, maxDp = 2) {
  if (num === undefined || num === null || !Number.isFinite(num) || num === 0) return "0";
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: maxDp }).format(num);
}

/** Format percentage with leading sign. */
function fmtPct(num) {
  if (!Number.isFinite(num)) return "-";
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function fmtDateTime(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    day:"2-digit", month:"2-digit", year:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit",
  }).format(date);
}
function fmtTime(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    hour:"2-digit", minute:"2-digit", second:"2-digit",
  }).format(date);
}
function fmtAge(date) {
  if (!date) return "-";
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  return `${Math.floor(s/60)}m ${s%60}s`;
}

/**
 * Re-format an input's current value with Indonesian thousands separators.
 * Called on blur / Enter.
 */
function applyInputFormat(input) {
  const raw = parseUserInput(input.value);
  if (!raw) { input.value = ""; return; }
  const isAsset = input.id === "tradeAmount" && el.valueIn.value === "asset";
  input.value = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: isAsset ? 8 : 0,
  }).format(raw);
}

/**
 * Live-format Amount while user types.
 * Uses a small debounce AND only reformats when the cursor is not at the end
 * to avoid double-inserting separators while typing.
 */
let _amountTimer = null;
function liveFormatAmount() {
  clearTimeout(_amountTimer);
  _amountTimer = setTimeout(() => {
    const inp = el.tradeAmount;
    const raw = parseUserInput(inp.value);
    if (!raw) return;
    const isAsset = el.valueIn.value === "asset";
    const formatted = new Intl.NumberFormat("id-ID", {
      maximumFractionDigits: isAsset ? 8 : 0,
    }).format(raw);
    // Only update if value actually changed (prevents cursor jump on partial input)
    if (inp.value !== formatted) inp.value = formatted;
  }, 400);
}

/* ═══════════════════════════════════════════════════════════════
   MATH HELPERS
═══════════════════════════════════════════════════════════════ */

function ceilToStep(value, step) {
  const s = Math.max(step, Number.EPSILON);
  return Math.ceil(value / s) * s;
}

/** Diff = CEILING(tick / defaultPrice × 100, 0.05) [%] */
function calcDiff(tick, defaultPrice) {
  if (!defaultPrice) return 0;
  return ceilToStep((tick / defaultPrice) * 100, DIFF_STEP_PCT);
}

/** Current Diff = (1 − CEILING(defaultPrice / bestBidReku, 0.0005)) × 100 [%] */
function calcCurrentDiff(defaultPrice, bestBidReku) {
  if (!defaultPrice || !bestBidReku) return 0;
  return (1 - ceilToStep(defaultPrice / bestBidReku, DIFF_STEP_PCT / 100)) * 100;
}

/**
 * Infer tick size from the real price ladder.
 * Falls back to spread or hardcoded tiers.
 */
function inferTickSize(book, bidaskRow) {
  const prices = [...book.bids, ...book.asks]
    .map(r => r.price).filter(Boolean).sort((a,b) => a - b);
  let minStep = Infinity;
  for (let i = 1; i < prices.length; i++) {
    const step = Math.abs(prices[i] - prices[i-1]);
    if (step > 0 && step < minStep) minStep = step;
  }
  if (Number.isFinite(minStep) && minStep > 0) return minStep;

  const bid = parseAPI(bidaskRow?.bid);
  const ask = parseAPI(bidaskRow?.ask);
  const spread = ask - bid;
  if (spread > 0) return spread;
  if (ask >= 1_000_000) return 1_000;
  if (ask >= 10_000)    return 10;
  if (ask >= 1_000)     return 5;
  if (ask >= 1)         return 0.1;
  return 0.001;
}

/* ═══════════════════════════════════════════════════════════════
   ORDER BOOK NORMALISATION
   All API strings use parseAPI (standard dot-decimal).
   priceRaw is kept verbatim for fmtApiPrice.
═══════════════════════════════════════════════════════════════ */

function normaliseRekuSide(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (Array.isArray(row)) {
      // REKU format: [amountIDR_str, price_str, amount_str]
      const amtIdr   = parseAPI(row[0]);
      const priceRaw = String(row[1] ?? "");
      const price    = parseAPI(priceRaw);
      const amount   = parseAPI(row[2]) || (price ? amtIdr / price : 0);
      return { price, priceRaw, amount, quoteVolume: amtIdr || price * amount };
    }
    const priceRaw = String(row.price ?? row.p ?? "0");
    const price    = parseAPI(priceRaw);
    const amount   = parseAPI(row.amount ?? row.qty ?? row.q ?? 0);
    return { price, priceRaw, amount, quoteVolume: price * amount };
  }).filter(r => r.price > 0 && r.amount > 0);
}

function normaliseTargetSide(rows) {
  // Binance: { asks: [["price","amount"],...], bids: [...] }
  // Gate:    { asks: [{"p":"price","s":"amount","c":0},...] } or [["price","amount"],...]
  return (Array.isArray(rows) ? rows : []).map(row => {
    let priceRaw, amountRaw;
    if (Array.isArray(row)) {
      priceRaw  = String(row[0] ?? "");
      amountRaw = String(row[1] ?? "");
    } else {
      // Gate sometimes returns objects with p/s or price/amount
      priceRaw  = String(row.p ?? row.price ?? "0");
      amountRaw = String(row.s ?? row.amount ?? row.qty ?? "0");
    }
    const price  = parseAPI(priceRaw);
    const amount = parseAPI(amountRaw);
    return { price, priceRaw, amount, quoteVolume: price * amount };
  }).filter(r => r.price > 0 && r.amount > 0);
}

/* ═══════════════════════════════════════════════════════════════
   FETCH
═══════════════════════════════════════════════════════════════ */

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0,140)}`);
  return res.json();
}

async function loadAssets() {
  const rows = await getJson(API.bidask);
  state.assets = rows
    .filter(r => r.code && !EXCLUDED.has(String(r.code).toUpperCase()))
    .map(r => ({
      ...r,
      code:   String(r.code).toUpperCase(),
      bid:    parseAPI(r.bid),
      ask:    parseAPI(r.ask),
      spread: Math.max(0, parseAPI(r.ask) - parseAPI(r.bid)),
    }))
    .filter(r => r.bid > 0 && r.ask > 0)
    .sort((a,b) => a.code.localeCompare(b.code));

  if (!state.assets.some(a => a.code === state.selectedAsset))
    state.selectedAsset = state.assets[0]?.code || "BTC";
  renderAssetList();
}

async function loadRekuBook() {
  const data = await getJson(API.rekuBook(state.selectedAsset));
  state.rekuBook = {
    asks: normaliseRekuSide(data.s ?? data.asks ?? [])
            .sort((a,b) => b.price - a.price).slice(0, OB_LIMIT),
    bids: normaliseRekuSide(data.b ?? data.bids ?? [])
            .sort((a,b) => b.price - a.price).slice(0, OB_LIMIT),
  };
  state.rekuFetchedAt = new Date();
  renderBook(el.rekuAsks, el.rekuAskWrap, state.rekuBook.asks, "idr", "ask");
  renderBook(el.rekuBids, el.rekuBidWrap, state.rekuBook.bids, "idr", "bid");
  el.rekuLevelCount.textContent =
    `ASK ${state.rekuBook.asks.length} · BID ${state.rekuBook.bids.length}`;
  updateBookMeta();
}

async function tryTarget(exchange) {
  if (exchange === "binance") {
    const data = await getJson(API.binanceBook(state.selectedAsset));
    return {
      exchange: "binance",
      asks: normaliseTargetSide(data.asks).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
      bids: normaliseTargetSide(data.bids).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
    };
  }
  const data = await getJson(API.gateBook(state.selectedAsset));
  return {
    exchange: "gate",
    asks: normaliseTargetSide(data.asks).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
    bids: normaliseTargetSide(data.bids).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
  };
}

async function loadTargetBook() {
  const desired = el.targetExchange.value;
  state.target = desired;
  state.fallbackTarget = null;
  try {
    state.targetBook = await tryTarget(desired);
  } catch (e1) {
    const fallback = desired === "binance" ? "gate" : "binance";
    try {
      state.targetBook = await tryTarget(fallback);
      state.fallbackTarget = fallback;
    } catch (e2) {
      state.targetBook = { exchange: desired, asks: [], bids: [] };
      throw new Error(`${desired}: ${e1.message}; ${fallback}: ${e2.message}`);
    }
  }
  state.targetFetchedAt = new Date();
  renderBook(el.targetAsks, el.targetAskWrap, state.targetBook.asks, "usdt", "ask");
  renderBook(el.targetBids, el.targetBidWrap, state.targetBook.bids, "usdt", "bid");
  el.targetExchangeName.textContent = state.targetBook.exchange.toUpperCase();
  el.targetLevelCount.textContent =
    `ASK ${state.targetBook.asks.length} · BID ${state.targetBook.bids.length}`;
  updateBookMeta();
}

/* ═══════════════════════════════════════════════════════════════
   RENDER ORDER BOOK
═══════════════════════════════════════════════════════════════ */

function renderBook(tbody, wrapper, rows, currency, side) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="placeholder">No data</td></tr>`;
    return;
  }
  const cls = side === "ask" ? "price-ask" : "price-bid";
  tbody.innerHTML = rows.map((row, i) => {
    const rowNum = side === "ask" ? rows.length - i : i + 1;
    // Volume: IDR → 0 decimals, USDT → up to 4 decimals (trim trailing zeros)
    const vol = currency === "idr"
      ? fmt(row.quoteVolume, 0)
      : fmt(row.quoteVolume, 4);
    // Amount: trim trailing zeros naturally via fmt
    const amt = fmt(row.amount, 8);
    return `<tr data-index="${i}" data-side="${side}" data-currency="${currency}">
      <td>${rowNum}</td>
      <td class="${cls}">${fmtApiPrice(row.priceRaw)}</td>
      <td>${amt}</td>
      <td>${vol}</td>
    </tr>`;
  }).join("");

  // Scroll ask table to bottom so best ask (lowest price) is visible
  if (side === "ask") {
    requestAnimationFrame(() => { wrapper.scrollTop = wrapper.scrollHeight; });
  }
}

/* ═══════════════════════════════════════════════════════════════
   HOVER TOOLTIP
═══════════════════════════════════════════════════════════════ */

function computeCumulative(rows, targetIndex, side) {
  // For asks (desc sorted): cumulate from targetIndex to end (best ask = end of array)
  // For bids (desc sorted): cumulate from 0 to targetIndex (best bid = start)
  const slice = side === "ask"
    ? rows.slice(targetIndex)
    : rows.slice(0, targetIndex + 1);
  let cumAsset = 0, cumVol = 0;
  for (const r of slice) { cumAsset += r.amount; cumVol += r.quoteVolume; }
  return { cumAsset, cumVol, vwap: cumAsset ? cumVol / cumAsset : 0, levels: slice.length };
}

function showTooltip(event, rows, index, side, currency) {
  const { cumAsset, cumVol, vwap, levels } = computeCumulative(rows, index, side);
  const cur = currency.toUpperCase();
  const levelNum = side === "ask" ? rows.length - index : index + 1;
  // Build a dot-decimal raw string for vwap so fmtApiPrice can format it correctly
  const vwapRaw = vwap === 0 ? "0" : vwap.toPrecision(10).replace(/\.?0+$/, "");
  el.levelTooltip.innerHTML = `
    <div class="tt-title">${side==="ask"?"ASK":"BID"} — Level ${levelNum}</div>
    <div class="tt-row"><span class="tt-label">Cum. Amount</span><span class="tt-val">${fmt(cumAsset, 8)}</span></div>
    <div class="tt-row"><span class="tt-label">Cum. Volume (${cur})</span><span class="tt-val">${fmt(cumVol, cur==="IDR"?0:4)}</span></div>
    <div class="tt-row"><span class="tt-label">VWAP (${cur})</span><span class="tt-val">${fmtApiPrice(vwapRaw)}</span></div>
    <div class="tt-row"><span class="tt-label">Levels included</span><span class="tt-val">${levels}</span></div>
  `;
  el.levelTooltip.hidden = false;
  positionTooltip(event);
}

function positionTooltip(event) {
  const tt = el.levelTooltip, pad = 12;
  const tw = tt.offsetWidth, th = tt.offsetHeight;
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + tw > window.innerWidth  - pad) x = event.clientX - tw - pad;
  if (y + th > window.innerHeight - pad) y = event.clientY - th - pad;
  tt.style.left = `${x}px`;
  tt.style.top  = `${y}px`;
}
function hideTooltip() { el.levelTooltip.hidden = true; }

function attachTooltips(tbody, getRows) {
  tbody.addEventListener("mousemove", (e) => {
    const tr = e.target.closest("tr[data-index]");
    if (!tr) { hideTooltip(); return; }
    const rows = getRows(tr.dataset.side);
    showTooltip(e, rows, parseInt(tr.dataset.index, 10), tr.dataset.side, tr.dataset.currency);
  });
  tbody.addEventListener("mouseleave", hideTooltip);
}

/* ═══════════════════════════════════════════════════════════════
   ASSET LIST
═══════════════════════════════════════════════════════════════ */

/**
 * Anomaly if:
 *   spread > 2 × tick
 *   OR currentDiff < −(diff + 0.05%)
 *   OR currentDiff > diff  [or > -(diff + 0.05%) in negative territory]
 */
function isAnomaly(asset, tick, currentDiff, diff) {
  if (asset.spread > 2 * tick) return true;
  if (currentDiff < -(diff + DIFF_STEP_PCT)) return true;
  if (currentDiff > diff) return true;
  return false;
}

function renderAssetList() {
  const q = el.assetSearch.value.trim().toUpperCase();
  const list = state.assets.filter(a => !q || a.code.includes(q));
  el.assetList.innerHTML = list.map(asset => {
    const tick         = inferTickSize({ bids: [], asks: [] }, asset);
    const defaultPrice = ceilToStep(asset.ask, tick);
    const diff         = calcDiff(tick, defaultPrice);
    const currentDiff  = calcCurrentDiff(defaultPrice, asset.bid);
    const anomaly      = isAnomaly(asset, tick, currentDiff, diff);
    const active       = asset.code === state.selectedAsset ? "active" : "";
    return `<button type="button" class="asset-row ${anomaly?"anomaly":""} ${active}" data-asset="${asset.code}">
      <span><strong>${asset.code}</strong></span>
      <span>${fmtMoney(asset.spread, 6)}</span>
      <span>${fmtPct(currentDiff)}</span>
    </button>`;
  }).join("");
}

/* ═══════════════════════════════════════════════════════════════
   DERIVED METRICS & SIMULATION
═══════════════════════════════════════════════════════════════ */

function getSelectedBidask() {
  return state.assets.find(a => a.code === state.selectedAsset);
}

function summariseSide(rows) {
  return {
    totalAsset: rows.reduce((s,r) => s + r.amount, 0),
    totalVol:   rows.reduce((s,r) => s + r.quoteVolume, 0),
  };
}

function simulateTrade() {
  const side   = el.takerSide.value;
  const rows   = side === "buy"
    ? [...state.rekuBook.asks].sort((a,b) => a.price - b.price)
    : [...state.rekuBook.bids].sort((a,b) => b.price - a.price);
  const amount  = parseUserInput(el.tradeAmount.value);
  const valueIn = el.valueIn.value;
  const bestAsk = [...state.rekuBook.asks].sort((a,b) => a.price-b.price)[0]?.price || 0;
  const bestBid = state.rekuBook.bids[0]?.price || 0;
  const mid     = bestAsk && bestBid ? (bestAsk+bestBid)/2 : bestAsk||bestBid;
  let remAsset = valueIn==="asset" ? amount : null;
  let remIdr   = valueIn==="idr"   ? amount : null;
  let filled=0, spent=0, extreme=0;

  for (const row of rows) {
    if (valueIn === "asset") {
      const take = Math.min(remAsset, row.amount);
      filled += take; spent += take*row.price; remAsset -= take; extreme = row.price;
      if (remAsset <= 0) break;
    } else {
      const rv   = row.amount * row.price;
      const take = Math.min(remIdr, rv);
      filled += row.price ? take/row.price : 0;
      spent  += take; remIdr -= take; extreme = row.price;
      if (remIdr <= 0) break;
    }
  }

  const vwap   = filled ? spent/filled : 0;
  const impact = mid ? ((vwap-mid)/mid)*100*(side==="sell"?-1:1) : 0;
  el.vwap.textContent        = fmtMoney(vwap, 4);
  el.priceChange.textContent = fmtMoney(extreme, 4);
  el.priceImpact.textContent = fmtPct(impact);
}

function updateDerivedMetrics() {
  const bidask        = getSelectedBidask();
  const tick          = inferTickSize(state.rekuBook, bidask);
  const bestAskTarget = [...state.targetBook.asks].sort((a,b) => a.price-b.price)[0]?.price || 0;
  const rateSystem    = parseUserInput(el.rateSystem.value);
  const defaultPrice  = ceilToStep(rateSystem * bestAskTarget, tick);
  const bestBidReku   = state.rekuBook.bids[0]?.price || bidask?.bid || 0;
  const currentDiff   = calcCurrentDiff(defaultPrice, bestBidReku);
  const diff          = calcDiff(tick, defaultPrice);
  const ask           = summariseSide(state.rekuBook.asks);
  const bid           = summariseSide(state.rekuBook.bids);

  el.chosenAssetTitle.textContent   = state.selectedAsset;
  el.bestAskTarget.textContent      = fmt(bestAskTarget, 8);
  el.tickSize.textContent           = fmt(tick, 8);
  el.defaultPrice.textContent       = fmt(defaultPrice, 8);
  el.diffPerTick.textContent        = `${fmt(diff, 2)}%`;
  el.currentDiffPerTick.textContent = fmtPct(currentDiff);
  el.askMaxPrice.textContent        = fmt(state.rekuBook.asks[0]?.price, 4);
  el.askTotalAsset.textContent      = fmt(ask.totalAsset, 8);
  el.askTotalIdr.textContent        = fmtMoney(ask.totalVol, 0);
  el.bidMinPrice.textContent        = fmt(state.rekuBook.bids.at(-1)?.price, 4);
  el.bidTotalAsset.textContent      = fmt(bid.totalAsset, 8);
  el.bidTotalIdr.textContent        = fmtMoney(bid.totalVol, 0);
  simulateTrade();
}

function updateBookMeta() {
  const latest = state.latestRefreshAt || new Date();
  el.rekuMeta.textContent =
    `REKU  ·  Latest: ${fmtTime(latest)}  ·  Fetched: ${fmtDateTime(state.rekuFetchedAt)}  ·  Age: ${fmtAge(state.rekuFetchedAt)}`;
  const tName = state.fallbackTarget
    ? `${state.targetBook.exchange?.toUpperCase()} (fallback)`
    : state.targetBook.exchange?.toUpperCase() || "Target";
  el.targetMeta.textContent =
    `${tName}  ·  Latest: ${fmtTime(latest)}  ·  Fetched: ${fmtDateTime(state.targetFetchedAt)}  ·  Age: ${fmtAge(state.targetFetchedAt)}`;
}

function flashPanels() {
  [el.rekuPanel, el.targetPanel].forEach(p => {
    p.classList.remove("flash");
    requestAnimationFrame(() => p.classList.add("flash"));
  });
}

function updateStatus(msg, isError = false) {
  el.connectionStatus.textContent = msg;
  el.connectionStatus.classList.toggle("error", isError);
}

/* ═══════════════════════════════════════════════════════════════
   AUDIO  — louder click sound
═══════════════════════════════════════════════════════════════ */

function playClickSound() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    clickAudioCtx ||= new Ctx();
    const osc  = clickAudioCtx.createOscillator();
    const gain = clickAudioCtx.createGain();
    const now  = clickAudioCtx.currentTime;
    osc.type = "triangle";
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.1);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.45, now + 0.008);  // louder: 0.45
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(gain);
    gain.connect(clickAudioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════
   MAIN REFRESH
═══════════════════════════════════════════════════════════════ */

async function refreshAll() {
  try {
    updateStatus("Loading…");
    await loadAssets();
    await Promise.all([loadRekuBook(), loadTargetBook()]);
    state.latestRefreshAt = new Date();
    updateDerivedMetrics();
    renderAssetList();
    updateBookMeta();
    updateStatus("Ready");
  } catch (err) {
    console.error(err);
    updateStatus("Error — API blocked?", true);
  }
}

/* ═══════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════ */

// Asset list click
el.assetList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-asset]");
  if (!btn) return;
  playClickSound();
  state.selectedAsset = btn.dataset.asset;
  renderAssetList();
  await refreshAll();
  flashPanels();
});

// Simulation dropdowns
[el.takerSide, el.valueIn].forEach(inp => inp.addEventListener("change", updateDerivedMetrics));

// Rate System spinner (step = 1)
function changeRate(delta) {
  const cur  = parseUserInput(el.rateSystem.value);
  const next = Math.max(0, Math.round((cur + delta) * 1000) / 1000);
  el.rateSystem.value = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(next);
  updateDerivedMetrics();
}
document.getElementById("rateUp").addEventListener("click",   () => changeRate(+1));
document.getElementById("rateDown").addEventListener("click", () => changeRate(-1));
el.rateSystem.addEventListener("blur",    () => { applyInputFormat(el.rateSystem); updateDerivedMetrics(); });
el.rateSystem.addEventListener("keydown", (e) => {
  if (e.key === "Enter")     { applyInputFormat(el.rateSystem); updateDerivedMetrics(); }
  if (e.key === "ArrowUp")   { e.preventDefault(); changeRate(+1); }
  if (e.key === "ArrowDown") { e.preventDefault(); changeRate(-1); }
});
el.rateSystem.addEventListener("input", updateDerivedMetrics);

// Amount — live thousands separator while typing (debounced 400ms)
el.tradeAmount.addEventListener("input", () => {
  liveFormatAmount();
  updateDerivedMetrics();
});
el.tradeAmount.addEventListener("blur",    () => { applyInputFormat(el.tradeAmount); updateDerivedMetrics(); });
el.tradeAmount.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { applyInputFormat(el.tradeAmount); updateDerivedMetrics(); }
});

// Target exchange swap
el.targetExchange.addEventListener("change", async () => {
  try {
    updateStatus("Loading…");
    await loadTargetBook();
    updateDerivedMetrics();
    updateBookMeta();
    updateStatus("Ready");
  } catch (err) {
    console.error(err);
    updateStatus("Error — API blocked?", true);
  }
});

el.assetSearch.addEventListener("input", renderAssetList);
el.refreshButton.addEventListener("click", refreshAll);

el.themeToggle.addEventListener("click", () => {
  const dark = document.body.classList.toggle("dark");
  localStorage.setItem("reku-theme", dark ? "dark" : "light");
  el.themeToggle.textContent = dark ? "☀ Light" : "☾ Dark";
});
if (localStorage.getItem("reku-theme") === "dark") {
  document.body.classList.add("dark");
  el.themeToggle.textContent = "☀ Light";
}

document.addEventListener("mousemove", (e) => {
  if (!el.levelTooltip.hidden) positionTooltip(e);
});

// Hover tooltips on all four order book tbodys
attachTooltips(el.rekuAsks,   side => side==="ask" ? state.rekuBook.asks   : state.rekuBook.bids);
attachTooltips(el.rekuBids,   side => side==="ask" ? state.rekuBook.asks   : state.rekuBook.bids);
attachTooltips(el.targetAsks, side => side==="ask" ? state.targetBook.asks : state.targetBook.bids);
attachTooltips(el.targetBids, side => side==="ask" ? state.targetBook.asks : state.targetBook.bids);

/* ── Boot ── */
refreshAll();
setInterval(refreshAll, REFRESH_MS);
setInterval(updateBookMeta, 1_000);
