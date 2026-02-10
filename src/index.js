// Polyfill Web Crypto API for environments where globalThis.crypto is missing (e.g. Railway)
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.crypto.subtle) globalThis.crypto.subtle = webcrypto.subtle;

import dotenv from "dotenv";
dotenv.config();

// Note: HTTP_PROXY/HTTPS_PROXY env vars are automatically used by axios (v4 CLOB client)
// No manual configuration needed - just set the env vars in Railway

import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { initializeTrading, evaluateAndTrade, getTradingStats, checkResolutions, checkStopLoss, cleanupStalePositions } from "./trading/index.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

// Chainlink price buffer - builds synthetic klines when Binance is unavailable
const chainlinkPriceBuffer = {
  prices: [],       // { price, ts }
  maxSize: 300,     // Keep 300 ticks (~5 hours at 1/min)
  
  addPrice(price) {
    if (!price || !Number.isFinite(price)) return;
    this.prices.push({ price, ts: Date.now() });
    if (this.prices.length > this.maxSize) this.prices.shift();
  },
  
  // Build synthetic 1-minute klines from collected prices
  buildKlines(intervalMs = 60000, limit = 240) {
    if (this.prices.length < 2) return null;
    
    const now = Date.now();
    const klines = [];
    
    for (let i = 0; i < limit; i++) {
      const bucketEnd = now - i * intervalMs;
      const bucketStart = bucketEnd - intervalMs;
      const inBucket = this.prices.filter(p => p.ts >= bucketStart && p.ts < bucketEnd);
      
      if (inBucket.length === 0) {
        // Fill with nearest known price
        const nearest = this.prices.reduce((best, p) => 
          Math.abs(p.ts - bucketStart) < Math.abs(best.ts - bucketStart) ? p : best
        );
        klines.unshift({
          openTime: bucketStart,
          open: nearest.price,
          high: nearest.price,
          low: nearest.price,
          close: nearest.price,
          volume: 0,
          closeTime: bucketEnd
        });
      } else {
        klines.unshift({
          openTime: bucketStart,
          open: inBucket[0].price,
          high: Math.max(...inBucket.map(p => p.price)),
          low: Math.min(...inBucket.map(p => p.price)),
          close: inBucket[inBucket.length - 1].price,
          volume: inBucket.length * 100,
          closeTime: bucketEnd
        });
      }
    }
    return klines;
  }
};

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let tradingStatus = null;
  try {
    console.log(`\n${ANSI.white}Initializing trading module...${ANSI.reset}`);
    tradingStatus = await initializeTrading();
    console.log(`Trading status result:`, tradingStatus);
    if (tradingStatus.enabled) {
      console.log(`\n${ANSI.green}✓${ANSI.reset} ${tradingStatus.message}`);
      console.log(`${ANSI.white}Wallet:${ANSI.reset} ${tradingStatus.walletAddress}`);
      if (tradingStatus.dryRun) {
        console.log(`${ANSI.yellow}⚠ DRY RUN MODE - No real trades will be executed${ANSI.reset}`);
      }
      console.log("");
    } else {
      console.log(`\n${ANSI.yellow}⚠${ANSI.reset} Trading disabled: ${tradingStatus.message}\n`);
    }
  } catch (error) {
    console.log(`\n${ANSI.red}✗${ANSI.reset} Trading initialization failed: ${error.message}`);
    console.log(`Error details:`, error);
    console.log("");
  }

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1mRaw, klines5mRaw, lastPriceRaw, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      // Add Chainlink price to buffer for synthetic klines
      if (chainlink?.price) chainlinkPriceBuffer.addPrice(chainlink.price);

      // Use Binance klines if available, otherwise build synthetic klines from Chainlink
      const klines1m = klines1mRaw || chainlinkPriceBuffer.buildKlines(60000, 240);
      const klines5m = klines5mRaw || chainlinkPriceBuffer.buildKlines(300000, 200);
      const lastPrice = lastPriceRaw || chainlink?.price || null;

      // Need at least some price data to continue
      if (!klines1m || !lastPrice) {
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      let tradeResult = null;
      if (tradingStatus?.enabled && poly.ok) {
        // Check if any positions should be resolved
        const ptb = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
        checkResolutions(currentPrice, ptb);
        cleanupStalePositions();
        
        // Check for stop-loss triggers (20% loss)
        const stopLossAlerts = checkStopLoss({ upPrice: marketUp, downPrice: marketDown });
        if (stopLossAlerts.length > 0) {
          console.log(`[WARNING] ${stopLossAlerts.length} position(s) triggering stop-loss!`);
        }

        const prediction = {
          longPct: pLong ? pLong * 100 : 0,
          shortPct: pShort ? pShort * 100 : 0
        };

        // Parse market end time for position tracking
        const marketEndTime = poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;

        const marketData = {
          upPrice: marketUp,
          downPrice: marketDown,
          upTokenId: poly.tokens?.upTokenId,
          downTokenId: poly.tokens?.downTokenId,
          marketSlug: marketSlug,
          marketEndTime: marketEndTime,
          spread: poly.orderbook?.up?.spread ?? null,
          priceToBeat: ptb
        };

        // Pass indicator data for INDICATOR-FIRST direction decision
        const indicators = {
          priceVsVwap: (lastPrice && vwapNow) ? lastPrice - vwapNow : undefined,
          vwapSlope: vwapSlope,
          rsi: rsiNow,
          macdHist: macd?.hist ?? null,
          macdHistDelta: macd?.histDelta ?? null,
          heikenColor: consec.color ?? null,
          heikenCount: consec.count ?? 0,
          delta1m: delta1m,
          delta3m: delta3m,
          lastPrice: lastPrice
        };

        tradeResult = await evaluateAndTrade(prediction, marketData, currentPrice, indicators, ptb);
      }

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const tradingLines = [];
      if (tradingStatus?.enabled) {
        const stats = getTradingStats();
        const statusColor = tradingStatus.dryRun ? ANSI.yellow : ANSI.green;
        const statusText = tradingStatus.dryRun ? "DRY RUN" : "BALANCED MODE";
        tradingLines.push(kv("TRADING:", `${statusColor}${statusText}${ANSI.reset} ${ANSI.dim}($5 max/trade)${ANSI.reset}`));
        
        if (stats) {
          // P&L Display
          if (stats.pnl) {
            const pnl = stats.pnl;
            
            // Total P&L (most important - show first)
            const pnlColor = pnl.totalPnl >= 0 ? ANSI.green : ANSI.red;
            const pnlSign = pnl.totalPnl >= 0 ? "+" : "";
            tradingLines.push(kv("P&L:", `${pnlColor}${pnlSign}$${pnl.totalPnl.toFixed(2)}${ANSI.reset}`));
            
            // Win/Loss record
            const winColor = pnl.wins > 0 ? ANSI.green : ANSI.gray;
            const lossColor = pnl.losses > 0 ? ANSI.red : ANSI.gray;
            tradingLines.push(kv("Record:", `${winColor}${pnl.wins}W${ANSI.reset} / ${lossColor}${pnl.losses}L${ANSI.reset}${pnl.totalTrades > 0 ? ` (${pnl.winRate.toFixed(0)}%)` : ""}`));
            
            // Streak
            if (pnl.currentStreak > 0 && pnl.streakType) {
              const streakColor = pnl.streakType === "WIN" ? ANSI.green : ANSI.red;
              tradingLines.push(kv("Streak:", `${streakColor}${pnl.currentStreak}x ${pnl.streakType}${ANSI.reset}`));
            }
            
            // Open positions
            if (pnl.openPositions > 0) {
              tradingLines.push(kv("Open Pos:", `${ANSI.yellow}${pnl.openPositions} awaiting resolution${ANSI.reset}`));
            }
          }
          
          // Rate limits
          tradingLines.push(kv("Trades/Hr:", `${stats.tradesThisHour ?? 0}/${CONFIG.trading.maxTradesPerHour ?? 4} | Markets: ${stats.tradedMarkets ?? 0}`));
        }
        
        if (tradeResult) {
          if (tradeResult.traded) {
            const tradeColor = tradeResult.signal?.direction === "LONG" ? ANSI.green : ANSI.red;
            tradingLines.push(kv("EXECUTED:", `${tradeColor}${tradeResult.reason}${ANSI.reset}`));
          } else if (tradeResult.reason) {
            tradingLines.push(kv("Status:", `${ANSI.dim}${tradeResult.reason}${ANSI.reset}`));
          }
        }
      }

      const lines = [
        titleLine,
        marketLine,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Predict:", predictValue),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        tradingLines.length > 0 ? "" : null,
        tradingLines.length > 0 ? sepLine() : null,
        tradingLines.length > 0 ? "" : null,
        ...tradingLines,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow("./logs/signals.csv", header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        regimeInfo.regime,
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
      ]);
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (!main._lastErr || main._lastErr !== msg || Date.now() - (main._lastErrTs || 0) > 60000) {
        console.log(`Error: ${msg}`);
        main._lastErr = msg;
        main._lastErrTs = Date.now();
      }
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

// ═══════════════════════════════════════════════════════════════
// HTTP API SERVER — view trade history and stats from browser
// ═══════════════════════════════════════════════════════════════
import { createServer } from "node:http";

const PORT = process.env.PORT || 3000;
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  try {
    if (path === '/stats') {
      // Current trading stats
      const stats = getTradingStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
    }
    else if (path === '/history') {
      // Full trade history from journal.json
      const journalPath = path.join(process.cwd(), 'logs', 'journal.json');
      if (fs.existsSync(journalPath)) {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(journal, null, 2));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No trade history found' }));
      }
    }
    else if (path === '/pnl') {
      // P&L state from positionTracker
      const pnlPath = path.join(process.cwd(), 'logs', 'pnl.json');
      if (fs.existsSync(pnlPath)) {
        const pnl = JSON.parse(fs.readFileSync(pnlPath, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pnl, null, 2));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No P&L data found' }));
      }
    }
    else if (path === '/csv') {
      // Download trades.csv
      const csvPath = path.join(process.cwd(), 'logs', 'trades.csv');
      if (fs.existsSync(csvPath)) {
        res.writeHead(200, { 
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="trades.csv"'
        });
        res.end(fs.readFileSync(csvPath, 'utf8'));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No CSV file found' }));
      }
    }
    else if (path === '/' || path === '/health') {
      // Simple health check with links
      const html = `
<!DOCTYPE html>
<html>
<head><title>BTC 15m Trading Bot</title></head>
<body>
<h1>🤖 BTC 15m Trading Bot</h1>
<ul>
  <li><a href="/stats">📊 Current Stats</a></li>
  <li><a href="/history">📜 Trade History</a></li>
  <li><a href="/pnl">💰 P&L State</a></li>
  <li><a href="/csv">📥 Download CSV</a></li>
</ul>
<p>Last updated: ${new Date().toISOString()}</p>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n[API] 🌐 HTTP server running on http://localhost:${PORT}`);
  console.log(`[API] 📊 Stats: http://localhost:${PORT}/stats`);
  console.log(`[API] 📜 History: http://localhost:${PORT}/history`);
  console.log(`[API] 💰 P&L: http://localhost:${PORT}/pnl`);
  console.log(`[API] 📥 CSV: http://localhost:${PORT}/csv`);
});

main();
