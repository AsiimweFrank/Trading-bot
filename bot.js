/**
 * Claude Trading Bot — Multi-Asset, Multi-Timeframe (v05)
 *
 * Watchlist & strategy assignment (backtest v04 — 5m 30d):
 *   NEAR  → VWAP(5m) primary + Hermes(1H) dual [Hermes 95.5% WR ← best]
 *   SOL   → VWAP(5m) primary + Hermes(1H) dual [Hermes 83.1% WR]
 *   ETH   → Hermes(1H)                          [85.7% WR]
 *   BTC   → VWAP(5m) + RSI(3) + EMA(8)          [Hermes paused — 43.9%]
 *
 * Improvements (v05):
 *   - Hermes now scans 1H candles (matches live scan that caught NEAR +$1.125)
 *   - VWAP strategies keep 5m (session-based, works best on short TF)
 *   - Partial TP: 50% at 1.5%, SL→BE, rest at 3.0%
 *   - Full position tracking in positions.json
 *
 * Data: OKX public API | Execution: Bybit Demo
 * Runs every 5 minutes on Railway cron
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe:        process.env.TIMEFRAME         || "5m",   // VWAP strategies
  hermesTimeframe:  process.env.HERMES_TIMEFRAME  || "1H",   // Hermes — 1H for quality signals
  // Position sizing — percentage-based so trade size grows with account
  // TRADE_SIZE_PCT takes priority over MAX_TRADE_SIZE_USD if set
  tradeSizePct:     parseFloat(process.env.TRADE_SIZE_PCT     || "0"),    // e.g. 10 = 10% of portfolio
  portfolioUSD:     parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"), // current account size
  maxTradeSizeUSD:  parseFloat(process.env.MAX_TRADE_SIZE_USD  || "50"),  // fallback fixed size
  maxTradesPerDay:  parseInt(process.env.MAX_TRADES_PER_DAY    || "5"),
  paperTrading:     process.env.PAPER_TRADING    !== "false",
  tradeMode:        process.env.TRADE_MODE       || "spot",
  bybit: {
    apiKey:    process.env.BYBIT_API_KEY,
    secretKey: process.env.BYBIT_SECRET_KEY,
    baseUrl:   process.env.BYBIT_BASE_URL || "https://api.bybit.com",
  },
};

// Resolve trade size: % of portfolio if TRADE_SIZE_PCT set, else fixed USD
function getTradeSize() {
  if (CONFIG.tradeSizePct > 0) {
    const pctSize = CONFIG.portfolioUSD * (CONFIG.tradeSizePct / 100);
    // Cap at 30% max per trade for safety
    const capped = Math.min(pctSize, CONFIG.portfolioUSD * 0.30);
    return Math.round(capped * 100) / 100;
  }
  return CONFIG.maxTradeSizeUSD;
}

// Watchlist — v05 with per-asset trend vote tuning
// trendVote = min bars out of 20 that must be in bear stack (0 = off)
// BTC needs strict vote (choppy market), ETH/SOL/NEAR trend cleanly (no vote)
const WATCHLIST = [
  { symbol: "NEARUSDT", okx: "NEAR-USDT", strategy: "vwap_rsi3_ema8", hermesAlso: true,  trendVote: 0  },
  { symbol: "SOLUSDT",  okx: "SOL-USDT",  strategy: "vwap_rsi3_ema8", hermesAlso: true,  trendVote: 0  },
  { symbol: "ETHUSDT",  okx: "ETH-USDT",  strategy: "hermes_v03",                         trendVote: 0  },
  { symbol: "BTCUSDT",  okx: "BTC-USDT",  strategy: "vwap_rsi3_ema8",                     trendVote: 12 },
];

const LOG_FILE      = "safety-check-log.json";
const CSV_FILE      = "trades.csv";
const POSITION_FILE = "positions.json";

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Market Data (OKX public API) ────────────────────────────────────────────

async function fetchCandles(okxSymbol, interval, limit = 200) {
  const intervalMap = {
    "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m",
    "1H":"1H","4H":"4H","1D":"1D","1W":"1W",
  };
  const bar = intervalMap[interval] || "5m";
  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSymbol}&bar=${bar}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`OKX API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX error: ${data.msg}`);
  return data.data.reverse().map((k) => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  let sess = candles.filter((c) => c.time >= midnight.getTime());
  if (sess.length < 5) sess = candles.slice(-100);
  if (!sess.length) return null;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol = sess.reduce((s,c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// ─── Strategy A: VWAP + RSI(3) + EMA(8) ─────────────────────────────────────
// Best for: NEAR (79.3% WR), SOL (75.1% WR)

function checkStratVwapRsi(candles) {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, 8);
  const rsi3   = calcRSI(closes, 3);
  const vwap   = calcVWAP(candles);

  if (!ema8 || !rsi3 || !vwap) return { signal: null, reason: "insufficient data" };

  const vwapDist = Math.abs(price - vwap) / vwap * 100;
  if (vwapDist > 1.5) return { signal: null, reason: `overextended from VWAP (${vwapDist.toFixed(2)}%)` };

  const bullish = price > vwap && price > ema8;
  const bearish = price < vwap && price < ema8;

  if (bullish && rsi3 < 30) {
    return {
      signal: "buy", side: "buy",
      reason: `BULLISH — price>VWAP, price>EMA8, RSI3=${rsi3.toFixed(1)}<30`,
      indicators: { price, ema8, vwap, rsi3 },
    };
  }
  if (bearish && rsi3 > 70) {
    return {
      signal: "sell", side: "sell",
      reason: `BEARISH — price<VWAP, price<EMA8, RSI3=${rsi3.toFixed(1)}>70`,
      indicators: { price, ema8, vwap, rsi3 },
    };
  }

  const bias = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";
  return {
    signal: null,
    reason: `${bias} bias — RSI3=${rsi3.toFixed(1)} (need <30 long / >70 short)`,
    indicators: { price, ema8, vwap, rsi3 },
  };
}

// ─── Strategy B: Hermes v05 — RSI Rejection in Downtrend ─────────────────────
// Scans 1H candles. Best for: NEAR (95.5%), ETH (85.7%), SOL (83.1%)
// v05 adds: trend strength vote (12/20 bars in bear stack = no choppy entries)

function checkStratHermes(candles, trendVoteMin = 0) {
  const closes  = candles.map((c) => c.close);
  const price   = closes[closes.length - 1];
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  const ema50   = calcEMA(closes, 50);
  const rsi     = calcRSI(closes, 14);
  const rsiPrev = calcRSI(closes.slice(0, -1), 14);

  if (!ema9 || !ema21 || !ema50 || !rsi || !rsiPrev)
    return { signal: null, reason: "insufficient data" };

  const bearStack = ema9 < ema21 && ema21 < ema50 && price < ema50;
  if (!bearStack) {
    return {
      signal: null,
      reason: `no bear stack (EMA9=${ema9.toFixed(2)} EMA21=${ema21.toFixed(2)} EMA50=${ema50.toFixed(2)})`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  // ── Trend strength vote (per-asset, 0 = disabled) ────────────────────────
  // BTC: 12/20 bars required (choppy market fix)
  // ETH/SOL/NEAR: 0 (naturally trending, don't over-filter)
  const VOTE_BARS  = 20;
  const VOTE_MIN   = trendVoteMin;
  let bearVotes = 0;
  const start = Math.max(0, candles.length - VOTE_BARS);
  for (let j = start; j < candles.length; j++) {
    const c = candles.slice(0, j + 1);
    const cl = c.map((x) => x.close);
    const e9  = calcEMA(cl, 9);
    const e21 = calcEMA(cl, 21);
    const e50 = calcEMA(cl, 50);
    const p   = cl[cl.length - 1];
    if (e9 && e21 && e50 && e9 < e21 && e21 < e50 && p < e50) bearVotes++;
  }
  if (VOTE_MIN > 0 && bearVotes < VOTE_MIN) {
    return {
      signal: null,
      reason: `bear stack ✅ but trend too weak (${bearVotes}/${VOTE_BARS} bars in bear stack, need ${VOTE_MIN})`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  // RSI spike check: was RSI > 55 in last 5 bars?
  const rsiWindow = [];
  for (let j = Math.max(0, candles.length - 5); j < candles.length; j++) {
    const r = calcRSI(closes.slice(0, j + 1), 14);
    if (r) rsiWindow.push(r);
  }
  const recentlyAbove55 = rsiWindow.some((r) => r > 55);
  const crossesBelow52  = rsiPrev >= 52 && rsi < 52;
  const notOversold     = rsi > 38;

  // ── RSI slope filter: must drop ≥1.5 pts across last 2 bars ─────────────
  // Filters weak slow rollovers that often recover before hitting TP
  // NEAR today: RSI dropped 58.6→51.86 (-6.7) = strong ✅
  // A slow drift of -0.3/bar = weak = likely to recover = skip
  const rsiPrev2 = calcRSI(closes.slice(0, -2), 14);
  const rsiSlope = rsiPrev2 ? (rsiPrev2 - rsi) : 0; // positive = falling
  const strongRollover = rsiSlope >= 1.5;

  // ── Volume spike confirmation: current bar > 1.2× 20-bar average ─────────
  // RSI rollover WITH volume = real sellers stepping in = high probability
  // RSI rollover WITHOUT volume = could be noise, price may recover quickly
  const volumes = candles.map((c) => c.volume);
  const vol20   = volumes.slice(-21, -1); // last 20 bars excluding current
  const avgVol  = vol20.length > 0 ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
  const currVol = volumes[volumes.length - 1];
  const volRatio     = avgVol > 0 ? currVol / avgVol : 1;
  const volumeConfirm = volRatio >= 1.2; // current bar volume ≥ 1.2× 20-bar avg

  if (recentlyAbove55 && crossesBelow52 && notOversold && strongRollover && volumeConfirm) {
    return {
      signal: "sell", side: "sell",
      reason: `HERMES SHORT — bear stack ✅, trend vote ${bearVotes}/${VOTE_BARS} ✅, RSI spiked>55 ✅, crossed below 52 ✅, slope -${rsiSlope.toFixed(1)} ✅, RSI=${rsi.toFixed(1)}>38 ✅, vol ${volRatio.toFixed(2)}×avg ✅`,
      indicators: { price, ema9, ema21, ema50, rsi, rsiSlope, bearVotes, volRatio },
    };
  }

  return {
    signal: null,
    reason: `bear stack ✅ trend ${bearVotes}/${VOTE_BARS} ✅ — waiting: RSI=${rsi.toFixed(1)} spike=${recentlyAbove55} cross52=${crossesBelow52} slope=${rsiSlope.toFixed(1)}(need≥1.5) floor=${notOversold} vol=${volRatio.toFixed(2)}×(need≥1.2)`,
    indicators: { price, ema9, ema21, ema50, rsi, rsiSlope, volRatio },
  };
}

// ─── Bybit Execution ──────────────────────────────────────────────────────────

function signBybit(timestamp, body) {
  return crypto.createHmac("sha256", CONFIG.bybit.secretKey)
    .update(`${timestamp}5000${body}`).digest("hex");
}

async function placeBybitOrder(symbol, side, sizeUSD, price, mode = "spot") {
  const timestamp = Date.now().toString();

  let body;
  if (mode === "linear") {
    // Perpetual futures — true shorts possible, qty in contracts (USD value / price)
    const qty = (sizeUSD / price).toFixed(3);
    body = JSON.stringify({
      category:    "linear",
      symbol,
      side:        side === "buy" ? "Buy" : "Sell",
      orderType:   "Market",
      qty,
      timeInForce: "IOC",
      reduceOnly:  false,
      positionIdx: 0,   // one-way mode
    });
  } else {
    // Spot — buy/sell tokens
    const quantity = (sizeUSD / price).toFixed(6);
    body = JSON.stringify({
      category:  "spot",
      symbol,
      side:      side === "buy" ? "Buy" : "Sell",
      orderType: "Market",
      qty:       quantity,
    });
  }
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "X-BAPI-API-KEY":    CONFIG.bybit.apiKey,
      "X-BAPI-SIGN":       signBybit(timestamp, body),
      "X-BAPI-TIMESTAMP":  timestamp,
      "X-BAPI-RECV-WINDOW":"5000",
    },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);
  return data.result;
}

// ─── CSV Trade Log ────────────────────────────────────────────────────────────

const CSV_HEADERS = "Date,Time(UTC),Exchange,Symbol,Strategy,Side,Quantity,Price,TotalUSD,Fee,Mode,Signal";

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function writeTradeCsv({ symbol, strategy, side, price, tradeSize, orderId, mode, signal }) {
  const now  = new Date();
  const qty  = (tradeSize / price).toFixed(6);
  const fee  = (tradeSize * 0.001).toFixed(4);
  const row  = [
    now.toISOString().slice(0,10),
    now.toISOString().slice(11,19),
    "Bybit", symbol, strategy,
    side.toUpperCase(), qty,
    price.toFixed(4), tradeSize.toFixed(2), fee,
    mode, `"${signal}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Hermes Position Tracker (Partial TP) ────────────────────────────────────
// Tracks open Hermes shorts: partial exit at 1.5%, full exit at 3.0%, SL 1.5%

function loadPositions() {
  if (!existsSync(POSITION_FILE)) return [];
  try { return JSON.parse(readFileSync(POSITION_FILE, "utf8")); } catch { return []; }
}

function savePositions(positions) {
  writeFileSync(POSITION_FILE, JSON.stringify(positions, null, 2));
}

// Returns true if this asset already has an open position (any strategy)
// Prevents VWAP buy firing while Hermes short is active on same asset, and vice versa
function hasOpenPosition(symbol) {
  const positions = loadPositions();
  return positions.some((p) => p.symbol === symbol && p.status === "open");
}

// Universal position recorder — used by both Hermes and VWAP
// Hermes shorts: full TP/SL tracking
// VWAP trades: recorded so conflict guard blocks opposite signals on same asset
function openPositionRecord(symbol, side, entry, tradeSize, strategy, orderId) {
  const positions = loadPositions();
  const filtered  = positions.filter((p) => p.symbol !== symbol || p.status !== "open");
  const isHermesStrat = strategy === "hermes_v03" || strategy === "hermes_v04" || strategy === "hermes_v05";

  filtered.push({
    symbol,
    side,
    strategy,
    entry,
    tp1:      isHermesStrat ? +(entry * (1 - 0.015)).toFixed(6) : null,
    tp2:      isHermesStrat ? +(entry * (1 - 0.030)).toFixed(6) : null,
    sl:       isHermesStrat ? +(entry * (1 + 0.015)).toFixed(6) : null,
    slBE:     null,
    size:     tradeSize,
    tp1Hit:   false,
    status:   "open",
    openTime: new Date().toISOString(),
    orderId:  orderId || null,
  });
  savePositions(filtered);

  if (isHermesStrat) {
    console.log(`  📌 Hermes position: ${side.toUpperCase()} ${symbol} @ $${entry} | TP1=$${+(entry*(1-0.015)).toFixed(4)} TP2=$${+(entry*(1-0.030)).toFixed(4)} SL=$${+(entry*(1+0.015)).toFixed(4)}`);
  } else {
    console.log(`  📌 VWAP position: ${side.toUpperCase()} ${symbol} @ $${entry} | tracked for conflict guard`);
  }
}

// Keep alias for backward compat in dual-scan function
function openHermesPosition(symbol, entry, tradeSize, orderId) {
  openPositionRecord(symbol, "short", entry, tradeSize, "hermes_v05", orderId);
}

async function checkHermesPositions(log) {
  const positions = loadPositions();
  const open = positions.filter((p) => p.status === "open");
  if (!open.length) return;

  console.log(`\n─── Position Manager (${open.length} open) ─────────────────────`);

  // Auto-expire VWAP positions after 4 hours (bot doesn't manage their exits)
  for (const pos of open) {
    const isVwap = !pos.tp1 && !pos.tp2;
    if (isVwap) {
      const ageHrs = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
      if (ageHrs >= 4) {
        pos.status = "closed"; pos.closeReason = "vwap_expiry"; pos.closeTime = new Date().toISOString();
        console.log(`  ⏱️  VWAP ${pos.symbol} position expired after ${ageHrs.toFixed(1)}h — slot freed`);
      }
    }
  }
  savePositions(open.map(p => p)); // save expiry updates before Hermes checks

  for (const pos of open) {
    // Fetch current price (use 5m for tight exit tracking)
    const okxSymbol = pos.symbol.replace("USDT", "-USDT");
    let price;
    try {
      const candles = await fetchCandles(okxSymbol, "5m", 5);
      price = candles[candles.length - 1].close;
    } catch (e) {
      console.log(`  ⚠️  ${pos.symbol} price fetch failed: ${e.message}`);
      continue;
    }

    const activeSL = pos.tp1Hit ? pos.slBE : pos.sl;
    const pct = ((pos.entry - price) / pos.entry * 100).toFixed(2);
    console.log(`  ${pos.symbol}: entry=$${pos.entry} now=$${price.toFixed(4)} P&L=${pct}% | SL=$${activeSL} TP1=$${pos.tp1}${pos.tp1Hit?" ✅":""} TP2=$${pos.tp2}`);

    // ── SL Hit ──────────────────────────────────────────────────────────────
    if (price >= activeSL) {
      const pnl = pos.tp1Hit
        ? (pos.entry - activeSL) / pos.entry * (pos.size * 0.5)   // only 50% left
        : (pos.entry - activeSL) / pos.entry * pos.size;
      console.log(`  🛑 SL HIT @ $${price.toFixed(4)} | PnL: $${pnl.toFixed(2)}`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.tp1Hit ? pos.size*0.5 : pos.size, price, "linear"); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.tp1Hit ? pos.size*0.5 : pos.size, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_SL pnl=$${pnl.toFixed(2)}` });
      pos.status = "closed"; pos.closeReason = "stop_loss"; pos.closePrice = price; pos.closeTime = new Date().toISOString(); pos.pnl = pnl;
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_sl" });

    // ── TP1 Hit (partial exit 50%) ───────────────────────────────────────────
    } else if (!pos.tp1Hit && price <= pos.tp1) {
      const pnl1 = (pos.entry - pos.tp1) / pos.entry * (pos.size * 0.5);
      console.log(`  🎯 TP1 HIT @ $${price.toFixed(4)} — exiting 50% | Locked: +$${pnl1.toFixed(2)} | SL→ breakeven`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.size * 0.5, price, "linear"); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.size*0.5, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_TP1 locked=+$${pnl1.toFixed(2)}` });
      pos.tp1Hit = true;
      pos.slBE   = +(pos.entry * 1.001).toFixed(6); // SL to entry+0.1% (breakeven)
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_tp1" });

    // ── TP2 Hit (full exit remaining 50%) ────────────────────────────────────
    } else if (pos.tp1Hit && price <= pos.tp2) {
      const pnl2 = (pos.entry - pos.tp2) / pos.entry * (pos.size * 0.5);
      const pnl1 = (pos.entry - pos.tp1) / pos.entry * (pos.size * 0.5);
      console.log(`  🏆 TP2 HIT @ $${price.toFixed(4)} — full exit | Total PnL: +$${(pnl1+pnl2).toFixed(2)}`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.size * 0.5, price, "linear"); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.size*0.5, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_TP2 total=+$${(pnl1+pnl2).toFixed(2)}` });
      pos.status = "closed"; pos.closeReason = "take_profit_full"; pos.closePrice = price; pos.closeTime = new Date().toISOString(); pos.pnl = pnl1+pnl2;
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_tp2" });
    }
  }

  savePositions(positions);
}

// ─── Process one asset ────────────────────────────────────────────────────────

async function processAsset(asset, log) {
  console.log(`\n─── ${asset.symbol} [${asset.strategy}] ─────────────────────`);

  // Hermes uses 1H candles for quality signals; VWAP uses 5m
  const isHermes  = asset.strategy === "hermes_v03";
  const tf        = isHermes ? CONFIG.hermesTimeframe : CONFIG.timeframe;
  const candleCount = isHermes ? 100 : 200; // 100 × 1H = ~4 days of context

  const candles = await fetchCandles(asset.okx, tf, candleCount);
  const price   = candles[candles.length - 1].close;
  console.log(`  Price: $${price.toFixed(4)} [${tf}]`);

  // Run the assigned strategy
  const result = isHermes
    ? checkStratHermes(candles, asset.trendVote || 0)
    : checkStratVwapRsi(candles);

  const ind = result.indicators || {};
  if (isHermes) {
    if (ind.ema9)  console.log(`  EMA9/21/50: ${ind.ema9?.toFixed(2)} / ${ind.ema21?.toFixed(2)} / ${ind.ema50?.toFixed(2)}`);
    if (ind.rsi)   console.log(`  RSI(14): ${ind.rsi?.toFixed(2)}`);
  } else {
    if (ind.ema8)  console.log(`  EMA(8): $${ind.ema8?.toFixed(4)}  VWAP: $${ind.vwap?.toFixed(4)}  RSI(3): ${ind.rsi3?.toFixed(2)}`);
  }

  if (!result.signal) {
    console.log(`  ⏸  No signal — ${result.reason}`);
    return false;
  }

  // ── Position conflict guard ───────────────────────────────────────────────
  // Block new entry if this asset already has an open position (Hermes or VWAP)
  // Prevents: VWAP buy on NEAR while Hermes short is running, and vice versa
  if (hasOpenPosition(asset.symbol)) {
    console.log(`  🔒 BLOCKED — ${asset.symbol} already has an open position. Skipping ${result.side.toUpperCase()} signal.`);
    return false;
  }

  console.log(`  🎯 SIGNAL: ${result.side.toUpperCase()} — ${result.reason}`);

  const tradeSize = getTradeSize();

  if (CONFIG.paperTrading) {
    console.log(`  📋 PAPER: Would ${result.side.toUpperCase()} $${tradeSize} of ${asset.symbol} @ $${price.toFixed(4)}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: asset.strategy, side: result.side, price, tradeSize, mode: "PAPER", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, paper: true });
    // Track paper positions too so conflict guard works in paper mode
    openPositionRecord(asset.symbol, result.side, price, tradeSize, asset.strategy, null);
    return true;
  }

  // Live execution — Hermes=perpetual (true short), VWAP=spot (token buy/sell)
  const execMode = isHermes ? "linear" : "spot";
  try {
    const order = await placeBybitOrder(asset.symbol, result.side, tradeSize, price, execMode);
    console.log(`  ✅ ORDER PLACED: ${result.side.toUpperCase()} ${asset.symbol} [${execMode}] | ID: ${order.orderId}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: asset.strategy, side: result.side, price, tradeSize, orderId: order.orderId, mode: `LIVE-${execMode.toUpperCase()}`, signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, orderId: order.orderId, execMode });
    openPositionRecord(asset.symbol, result.side, price, tradeSize, asset.strategy, order.orderId);
    return true;
  } catch (err) {
    console.log(`  ❌ Order failed: ${err.message}`);
    return false;
  }
}

// ─── Dual-scan: run Hermes(1H) on VWAP assets (NEAR + SOL) ──────────────────
async function processHermesDualScan(asset, log) {
  const candles = await fetchCandles(asset.okx, CONFIG.hermesTimeframe, 100);
  const result  = checkStratHermes(candles, asset.trendVote || 0);
  if (!result.signal) {
    console.log(`  ⏸  ${asset.symbol} Hermes(${CONFIG.hermesTimeframe}) dual: ${result.reason}`);
    return false;
  }
  const price     = candles[candles.length - 1].close;
  const tradeSize = getTradeSize();

  // Position conflict guard
  if (hasOpenPosition(asset.symbol)) {
    console.log(`  🔒 BLOCKED — ${asset.symbol} already has an open position. Skipping Hermes ${result.side.toUpperCase()}.`);
    return false;
  }

  console.log(`  🎯 ${asset.symbol} HERMES(${CONFIG.hermesTimeframe}) SIGNAL: ${result.side.toUpperCase()} — ${result.reason}`);
  if (CONFIG.paperTrading) {
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v04", side: result.side, price, tradeSize, mode: "PAPER", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, paper: true });
    return true;
  }
  try {
    const order = await placeBybitOrder(asset.symbol, result.side, tradeSize, price, "linear");
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v05", side: result.side, price, tradeSize, orderId: order.orderId, mode: "LIVE-LINEAR", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, orderId: order.orderId, execMode: "linear" });
    openHermesPosition(asset.symbol, price, tradeSize, order.orderId);
    return true;
  } catch (err) {
    console.log(`  ❌ ${asset.symbol} Hermes order failed: ${err.message}`);
    return false;
  }
}

// ─── VWAP Position Exit Manager ──────────────────────────────────────────────
// Checks open VWAP spot positions every run:
//   Exit 1 — RSI(3) crosses above 50 (take profit — trend exhausted)
//   Exit 2 — Price drops 0.3% below entry (stop loss)
// Places a real spot SELL order and marks position closed.

async function checkVwapPositions(log) {
  const positions = loadPositions();
  const openVwap  = positions.filter(
    (p) => p.status === "open" && p.tp1 === null  // VWAP has no tp1/tp2
  );
  if (!openVwap.length) return;

  console.log(`\n─── VWAP Exit Manager (${openVwap.length} open) ─────────────────`);

  for (const pos of openVwap) {
    const okxSymbol = pos.symbol.replace("USDT", "-USDT");
    let candles;
    try {
      candles = await fetchCandles(okxSymbol, CONFIG.timeframe, 20);
    } catch (e) {
      console.log(`  ⚠️  ${pos.symbol} fetch failed: ${e.message}`);
      continue;
    }

    const closes = candles.map((c) => c.close);
    const price  = closes[closes.length - 1];
    const rsi3   = calcRSI(closes, 3);
    const rsi3Prev = calcRSI(closes.slice(0, -1), 3);
    const pct    = ((price - pos.entry) / pos.entry * 100).toFixed(2);
    const sl     = pos.entry * (1 - 0.003); // 0.3% stop loss

    console.log(`  ${pos.symbol}: entry=$${pos.entry} now=$${price.toFixed(4)} P&L=${pct}% | RSI3=${rsi3?.toFixed(1)} SL=$${sl.toFixed(4)}`);

    let exitReason = null;

    // Exit 1: RSI(3) crosses above 50 — trend exhausted, take profit
    if (rsi3 && rsi3Prev && rsi3Prev < 50 && rsi3 >= 50) {
      exitReason = "rsi3_cross_50";
      console.log(`  🎯 RSI(3) crossed 50 — taking profit @ $${price.toFixed(4)} | P&L: ${pct}%`);
    }
    // Exit 2: stop loss hit
    else if (price <= sl) {
      exitReason = "stop_loss";
      console.log(`  🛑 SL HIT @ $${price.toFixed(4)} | P&L: ${pct}%`);
    }
    // Exit 3: 4-hour time expiry (fallback)
    else {
      const ageHrs = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
      if (ageHrs >= 4) {
        exitReason = "time_expiry_4h";
        console.log(`  ⏱️  4h expiry — closing @ $${price.toFixed(4)} | P&L: ${pct}%`);
      }
    }

    if (exitReason) {
      // Place real spot SELL to return tokens → USDT
      if (!CONFIG.paperTrading) {
        try {
          await placeBybitOrder(pos.symbol, "sell", pos.size, price, "spot");
          console.log(`  ✅ VWAP SELL placed — ${pos.size} USD of ${pos.symbol} sold`);
        } catch (e) {
          console.log(`  ❌ VWAP sell failed: ${e.message}`);
        }
      }
      const pnlUSD = (price - pos.entry) / pos.entry * pos.size;
      writeTradeCsv({
        symbol: pos.symbol, strategy: "vwap_rsi3_ema8",
        side: "sell", price, tradeSize: pos.size,
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE-SPOT",
        signal: `EXIT_${exitReason} pnl=$${pnlUSD.toFixed(2)}`,
      });
      pos.status     = "closed";
      pos.closeReason = exitReason;
      pos.closePrice  = price;
      pos.closeTime   = new Date().toISOString();
      pos.pnl         = pnlUSD;
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "sell", price, orderPlaced: true, reason: exitReason });
    }
  }

  savePositions(positions);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // Guard: credentials check
  if (!CONFIG.bybit.apiKey || !CONFIG.bybit.secretKey) {
    console.log("⚠️  Missing BYBIT_API_KEY or BYBIT_SECRET_KEY — set in Railway Variables.");
    process.exit(0);
  }

  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Multi-Asset");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  const tradeSize = getTradeSize();
  const sizeLabel = CONFIG.tradeSizePct > 0
    ? `${CONFIG.tradeSizePct}% of $${CONFIG.portfolioUSD} = $${tradeSize}`
    : `$${tradeSize} fixed`;
  console.log(`  Timeframe: ${CONFIG.timeframe} | Trade size: ${sizeLabel}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Daily trade limit check
  const log = loadLog();
  const todayCount = countTodaysTrades(log);
  console.log(`\n  Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log("  🚫 Daily limit reached — stopping.");
    return;
  }

  // ── Step 0: BTC RSI regime check ─────────────────────────────────────────
  // When BTC RSI > 75, the whole market is in extreme overbought territory.
  // Any asset in a bear stack is now "loaded" — rollover could fire next bar.
  // This is a pre-signal warning, not a trade gate.
  try {
    const btcCandles = await fetchCandles("BTC-USDT", CONFIG.hermesTimeframe, 60);
    const btcCloses  = btcCandles.map(c => c.close);
    const btcRsi     = calcRSI(btcCloses, 14);
    if (btcRsi >= 75) {
      console.log(`\n  ⚡ BTC RSI EXTREME: ${btcRsi.toFixed(1)} — market-wide overbought.`);
      console.log(`     Any asset in bear stack is pre-loaded for Hermes short.`);
      // Check which watchlist assets are in bear stack right now
      for (const asset of WATCHLIST) {
        if (!asset.hermesAlso && asset.strategy !== "hermes_v03") continue;
        try {
          const ac = await fetchCandles(asset.okx, CONFIG.hermesTimeframe, 60);
          const cl = ac.map(c => c.close);
          const e9  = calcEMA(cl, 9), e21 = calcEMA(cl, 21), e50 = calcEMA(cl, 50);
          const p   = cl[cl.length - 1];
          const rsi = calcRSI(cl, 14);
          if (e9 && e21 && e50 && e9 < e21 && e21 < e50 && p < e50) {
            console.log(`     🎯 ${asset.symbol} bear stack ACTIVE — RSI ${rsi?.toFixed(1)} — watching for rollover`);
          }
        } catch (_) {}
      }
    } else {
      console.log(`\n  📊 BTC RSI: ${btcRsi?.toFixed(1)} — market neutral/bearish, Hermes conditions normal`);
    }
  } catch (e) {
    console.log(`  ⚠️  BTC regime check failed: ${e.message}`);
  }

  // ── Step 1a: Check open Hermes positions (perpetual TP/SL exits) ─────────
  await checkHermesPositions(log);

  // ── Step 1b: Check open VWAP positions (spot RSI exit + SL + expiry) ─────
  await checkVwapPositions(log);

  // ── Step 2: Scan each asset for new entries ───────────────────────────────
  let tradesThisRun = 0;
  for (const asset of WATCHLIST) {
    if (todayCount + tradesThisRun >= CONFIG.maxTradesPerDay) {
      console.log("\n  Daily limit reached mid-scan — stopping.");
      break;
    }
    try {
      const traded = await processAsset(asset, log);
      if (traded) tradesThisRun++;
      // NEAR/SOL: also run Hermes as secondary strategy when VWAP has no signal
      if (asset.hermesAlso && !traded && todayCount + tradesThisRun < CONFIG.maxTradesPerDay) {
        const hermesTraded = await processHermesDualScan(asset, log);
        if (hermesTraded) tradesThisRun++;
      }
    } catch (err) {
      console.log(`  ❌ ${asset.symbol} error: ${err.message}`);
    }
  }

  saveLog(log);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Scan complete — ${tradesThisRun} signal(s) fired this run`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

// Handle --tax-summary flag
if (process.argv.includes("--tax-summary")) {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv yet."); process.exit(0); }
  const rows = readFileSync(CSV_FILE,"utf8").trim().split("\n").slice(1);
  const live  = rows.filter((r) => r.includes(",LIVE,"));
  const paper = rows.filter((r) => r.includes(",PAPER,"));
  console.log(`\nTrades: ${rows.length} total | ${live.length} live | ${paper.length} paper\n`);
  process.exit(0);
}

run().catch((err) => console.error("Bot error:", err.message));
