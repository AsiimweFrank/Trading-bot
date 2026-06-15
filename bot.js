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
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";

// UAE time (UTC+4) helper
function uaeTime(d = new Date()) {
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }) + " UAE";
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe:        process.env.TIMEFRAME         || "5m",   // VWAP strategies
  hermesTimeframe:  process.env.HERMES_TIMEFRAME  || "1H",   // Hermes — 1H for quality signals
  // Position sizing — percentage-based so trade size grows with account
  // TRADE_SIZE_PCT takes priority over MAX_TRADE_SIZE_USD if set
  tradeSizePct:     parseFloat(process.env.TRADE_SIZE_PCT     || "0"),    // e.g. 10 = 10% of portfolio
  portfolioUSD:     parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"), // current account size
  maxTradeSizeUSD:  parseFloat(process.env.MAX_TRADE_SIZE_USD  || "50"),  // fallback fixed size
  maxTradesPerDay:  parseInt(process.env.MAX_TRADES_PER_DAY    || "10"),  // entries only (exits no longer counted)
  paperTrading:     process.env.PAPER_TRADING    !== "false",
  tradeMode:        process.env.TRADE_MODE       || "spot",
  bybit: {
    apiKey:    process.env.BYBIT_API_KEY,
    secretKey: process.env.BYBIT_SECRET_KEY,
    baseUrl:   process.env.BYBIT_BASE_URL || "https://api.bybit.com",
  },
  telegram: {
    token:  process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

// ─── Telegram Alerts ──────────────────────────────────────────────────────────

async function tg(message) {
  try {
    const url  = `https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`;
    const body = JSON.stringify({ chat_id: CONFIG.telegram.chatId, text: message, parse_mode: "HTML" });
    const res  = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) console.log(`  ⚠️  Telegram send failed: ${res.status}`);
  } catch (e) {
    console.log(`  ⚠️  Telegram error: ${e.message}`);
  }
}

function tgEntry(symbol, side, price, tradeSize, tp1, tp2, sl, strategy) {
  const emoji = side === "sell" ? "🔴" : "🟢";
  const dir   = side === "sell" ? "SHORT" : "LONG";
  return tg(
`${emoji} <b>NEW ${dir} — ${symbol}</b>
📍 Entry:  <b>$${price}</b>
🎯 TP1:    $${tp1} (+1.5%)
🏆 TP2:    $${tp2} (+3.0%)
🛑 SL:     $${sl} (-1.5%)
💰 Size:   $${tradeSize}
📊 Strat:  ${strategy}
🕐 ${uaeTime()}`
  );
}

function tgTP1(symbol, entry, tp1Price, pnl) {
  return tg(
`✅ <b>TP1 HIT — ${symbol}</b>
📍 Entry:   $${entry}
✅ TP1 hit: $${tp1Price}
💵 Profit:  +$${pnl.toFixed(2)} (50% closed)
🔒 SL moved to breakeven
⏳ Holding 50% for TP2...`
  );
}

function tgTP2(symbol, entry, tp2Price, pnl) {
  return tg(
`🏆 <b>TP2 HIT — ${symbol}</b>
📍 Entry:   $${entry}
🏆 TP2 hit: $${tp2Price}
💵 Profit:  +$${pnl.toFixed(2)} (full trade closed)
✅ Trade complete!`
  );
}

function tgSL(symbol, entry, slPrice, pnl, afterTP1 = false) {
  const tag = afterTP1 ? "SL @ BREAKEVEN" : "STOP LOSS HIT";
  const net  = afterTP1 ? "(TP1 profit locked ✅)" : "";
  return tg(
`🛑 <b>${tag} — ${symbol}</b>
📍 Entry: $${entry}
🛑 Exit:  $${slPrice}
💵 P&L:   $${pnl.toFixed(2)} ${net}`
  );
}

function tgRegimeAlert(btcRsi, loadedAssets) {
  if (!loadedAssets.length) return Promise.resolve();
  return tg(
`⚡ <b>BTC RSI EXTREME: ${btcRsi.toFixed(1)}</b>
Market is overbought — reversal incoming.
Bear stack assets ready to SHORT:
${loadedAssets.map(a => `• ${a}`).join("\n")}
🎯 Hermes entry may fire next bar!`
  );
}

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

// Watchlist — v05 with per-asset tuning
// trendVote    = min bars/20 in bear stack (0=off). BTC=12 (choppy regime filter)
// vwapTimeframe = override VWAP candle TF per asset (default = CONFIG.timeframe = 5m)
//   ETH VWAP backtest: 5m → 39% WR -$9.93 ❌ | 1H → 100% WR +$0.02 ✅ → use 1H
// Active strategy: Dip-Buyer (RSI2 in uptrend, 1H) — validated 2026-06:
//   65-68% WR, profitable across 27/27 param combos & 3 OOS periods on BTC/ETH/NEAR.
//   Old VWAP/Hermes assignments removed (confirmed net-negative over 57d OOS).
//   NOTE: profitable at fees <0.16% round-trip → maker/limit execution is the next upgrade.
// V2: All 8 coins — both LONG (RSI2<10+uptrend) and SHORT (RSI2>90+downtrend)
// Backtest PF by coin: ETH 2.16 | NEAR 2.17 | XRP 2.13 | SOL 2.06 | BTC 1.91 | AVAX 1.91 | BNB 1.75 | TRX 1.32
const WATCHLIST = [
  { symbol: "BTCUSDT",  okx: "BTC-USDT",  strategy: "dip_buyer" },
  { symbol: "ETHUSDT",  okx: "ETH-USDT",  strategy: "dip_buyer" },
  { symbol: "NEARUSDT", okx: "NEAR-USDT", strategy: "dip_buyer" },
  { symbol: "SOLUSDT",  okx: "SOL-USDT",  strategy: "dip_buyer" },
  { symbol: "BNBUSDT",  okx: "BNB-USDT",  strategy: "dip_buyer" },
  { symbol: "XRPUSDT",  okx: "XRP-USDT",  strategy: "dip_buyer" },
  { symbol: "AVAXUSDT", okx: "AVAX-USDT", strategy: "dip_buyer" },
  { symbol: "TRXUSDT",  okx: "TRX-USDT",  strategy: "dip_buyer" }, // weakest PF 1.32 — kept for signal volume
];

// ── Persistent data directory ─────────────────────────────────────────────────
// On Railway: mount a Volume at /data so files survive deploys.
// Locally: files land in the project folder (DATA_DIR = "").
// Set DATA_DIR=/data in Railway environment variables (done automatically
// when you add a Volume mounted at /data in the Railway dashboard).
const DATA_DIR      = process.env.DATA_DIR ? process.env.DATA_DIR.replace(/\/$/, "") : "";
const LOG_FILE      = `${DATA_DIR ? DATA_DIR + "/" : ""}safety-check-log.json`;
const CSV_FILE      = `${DATA_DIR ? DATA_DIR + "/" : ""}trades.csv`;
const POSITION_FILE = `${DATA_DIR ? DATA_DIR + "/" : ""}positions.json`;

// Ensure DATA_DIR exists (Railway Volume may not pre-create subdirectories)
if (DATA_DIR) {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* already exists */ }
}

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
  // BUG FIX: only count NEW ENTRIES (not exits) against the daily limit.
  // Previously, exit orders were also logged with orderPlaced:true, consuming the
  // daily limit after just 3 entries + 3 exits (3+3=6 > limit of 5). Now we only
  // count rows that represent a new position opening (entry:true flag).
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.entry === true).length;
}

// ─── Market Data (OKX public API) ────────────────────────────────────────────

async function fetchCandles(okxSymbol, interval, limit = 200) {
  const intervalMap = {
    "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m",
    "1H":"1H","4H":"4H","1D":"1D","1W":"1W",
  };
  const bar = intervalMap[interval] || "5m";
  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSymbol}&bar=${bar}&limit=${limit}`;

  // Retry up to 3 times with exponential backoff (handles OKX rate limiting)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (!res.ok) {
      if (attempt < 3) { await new Promise(r => setTimeout(r, attempt * 800)); continue; }
      throw new Error(`OKX API error: ${res.status}`);
    }
    const data = await res.json();
    if (data.code !== "0") {
      if (attempt < 3) { await new Promise(r => setTimeout(r, attempt * 800)); continue; }
      throw new Error(`OKX error: ${data.msg}`);
    }
    if (!data.data || data.data.length === 0) {
      if (attempt < 3) { await new Promise(r => setTimeout(r, attempt * 800)); continue; }
      throw new Error(`OKX returned empty candle data for ${okxSymbol}`);
    }
    return data.data.reverse().map((k) => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }
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

// Simple moving average of the last `period` closes (optionally offset back by `back` bars).
function calcSMA(closes, period, back = 0) {
  const end = closes.length - back;
  if (end < period) return null;
  let s = 0;
  for (let i = end - period; i < end; i++) s += closes[i];
  return s / period;
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

// ATR(period) expressed as a % of current price — measures recent volatility.
// Used to skip entries when an asset is too quiet for a bounce to clear the round-trip fee.
function calcATRpct(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const last = trs.slice(-period);
  const atr  = last.reduce((a, b) => a + b, 0) / last.length;
  const price = candles[candles.length - 1].close;
  return price > 0 ? (atr / price) * 100 : null;
}

// ATR(period) in absolute price units (for sizing the dip-buyer stop = entry − N×ATR).
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

// ─── Strategy A: VWAP + RSI(3) + EMA(8) ─────────────────────────────────────
// Best for: NEAR (79.3% WR), SOL (75.1% WR)

function checkStratVwapRsi(candles) {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, 8);
  const rsi3   = calcRSI(closes, 3);
  const vwap   = calcVWAP(candles);

  if (ema8 === null || rsi3 === null || vwap === null) return { signal: null, reason: "insufficient data" };

  const vwapDist = Math.abs(price - vwap) / vwap * 100;
  if (vwapDist > 1.5) return { signal: null, reason: `overextended from VWAP (${vwapDist.toFixed(2)}%)` };

  // ── Min-move (volatility) gate ────────────────────────────────────────────
  // The round-trip fee is 0.2% ($10 on $5000). If recent volatility is below this,
  // a mean-reversion bounce can't clear the fee — the trade is a structural loser
  // (this was the SOL/BTC chop bleed: ATR ~0.09-0.17% < 0.2% fee). Require ATR% to
  // be comfortably above the fee so only moves worth trading get entered.
  const MIN_ATR_PCT = parseFloat(process.env.MIN_ATR_PCT || "0.30");
  const atrPct = calcATRpct(candles, 14);
  if (atrPct !== null && atrPct < MIN_ATR_PCT) {
    return { signal: null, reason: `too quiet — ATR=${atrPct.toFixed(2)}% < ${MIN_ATR_PCT}% (fee would eat the move)`, indicators: { price, ema8, vwap, rsi3 } };
  }

  // Allow up to 0.8% below/above EMA8 for long/short entries.
  // Catches extreme RSI3 dips during micro-pullbacks still above VWAP
  // (e.g. NEAR RSI3=4 at -0.5% vs EMA8 — clean setup, should not be blocked).
  const EMA8_TOL = 0.008; // 0.8% tolerance
  const bullish = price > vwap && price > ema8 * (1 - EMA8_TOL);
  const bearish = price < vwap && price < ema8 * (1 + EMA8_TOL);

  // Tightened entry: RSI3 ≤ 15 only (was ≤30).
  // Rationale: at ≤30 the bounce is only ~0.2-0.3% — barely covers the 0.2% round-trip fee.
  // At RSI3 ≤ 15, price is in extreme oversold — bounces average 0.5-1.0%, well above fee cost.
  const RSI3_ENTRY = 15;
  if (bullish && rsi3 <= RSI3_ENTRY) {
    return {
      signal: "buy", side: "buy",
      reason: `BULLISH — price>VWAP, price≈EMA8(${((price/ema8-1)*100).toFixed(2)}%), RSI3=${rsi3.toFixed(1)}≤${RSI3_ENTRY}, ATR=${atrPct?.toFixed(2)}%`,
      indicators: { price, ema8, vwap, rsi3, atrPct },
    };
  }
  // NOTE: Bearish SELL disabled on VWAP — spot is long-only.
  // Short entries use Hermes strategy on perpetuals (linear) instead.
  // if (bearish && rsi3 >= 70) { ... }

  const bias = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";
  return {
    signal: null,
    reason: `${bias} bias — RSI3=${rsi3.toFixed(1)} (need ≤${RSI3_ENTRY} long)`,
    indicators: { price, ema8, vwap, rsi3 },
  };
}

// ─── Strategy C: Dip Buyer (Connors-style RSI2 in an uptrend) ────────────────
// Validated 2026-06: 65-68% WR, robust across 27/27 param combos, breakeven fee ~0.17%.
//   Regime : price > SMA200  AND  SMA50 rising      (established uptrend, long-only)
//   Entry  : RSI(2) < 10                            (deep short-term dip)
//   Exit   : close > SMA5 (recovery) | wide ATR stop | max-hold (managed in exit fn)
// Needs 1H candles with ≥200 bars of history.
const DIP_RSI_ENTRY      = parseFloat(process.env.DIP_RSI_ENTRY      || "10");  // RSI2 threshold for LONG entry
const DIP_RSI_SHORT      = parseFloat(process.env.DIP_RSI_SHORT      || "90");  // RSI2 threshold for SHORT entry
const DIP_STOP_ATR       = parseFloat(process.env.DIP_STOP_ATR       || "4");
// Limit-order maker entry: place limit this % away from close → sits in book → maker fee
// LONG:  buy limit DIP_LIMIT_OFFSET% BELOW close  (maker = waits for slight dip)
// SHORT: sell limit DIP_LIMIT_OFFSET% ABOVE close (maker = waits for slight push up)
const DIP_LIMIT_OFFSET   = parseFloat(process.env.DIP_LIMIT_OFFSET   || "0.15"); // 0.15% offset
const DIP_LIMIT_TIMEOUT  = parseFloat(process.env.DIP_LIMIT_TIMEOUT  || "2");    // cancel after 2 hours if unfilled
// ── V2 Strategy Settings ─────────────────────────────────────────────────────
// Backtest result: PF=1.91, WR=46.8%, EV=$4.36/trade on $500, 36 signals/day
// LONG : entry=candle_low,  stop=low*(1-0.003),  tp=entry+3×risk
// SHORT: entry=candle_high, stop=high*(1+0.003), tp=entry−3×risk
const DIP_V2_ENABLED     = process.env.DIP_STRATEGY_V2 !== "false";  // default ON
const DIP_V2_STOP_BUFFER = parseFloat(process.env.DIP_V2_STOP_BUFFER || "0.003"); // 0.3% candle buffer
const DIP_V2_RR          = parseFloat(process.env.DIP_V2_RR          || "3");     // 3:1 risk:reward
const DIP_V2_MAX_CONCURRENT = parseInt(process.env.DIP_V2_MAX_CONCURRENT || "4"); // max 4 open at once (was 2 — too restrictive for 8 coins)
// Futures mode: "spot" (default) or "linear" (perpetual futures with leverage)
// V2 requires "linear" (futures) to enable shorts — default to linear now
const DIP_BUYER_MODE     = process.env.DIP_BUYER_MODE     || "linear";
const DIP_BUYER_LEVERAGE = parseFloat(process.env.DIP_BUYER_LEVERAGE || "3");  // 3× ≈ natural leverage from 0.3% stop
// V8 filters — enable via env vars to run V8 alongside raw V2 on a separate deployment
const V8_BTC_MACRO_GATE  = process.env.V8_BTC_MACRO_GATE === "true";  // block when BTC daily < SMA200
const V8_ATR_FILTER      = process.env.V8_ATR_FILTER     === "true";  // block when ATR14 > 1.5× its 50-bar avg

// Module-level — populated once per run() if V8_BTC_MACRO_GATE is enabled
let _btcDailyBull = null;  // true = BTC above daily SMA200, false = below, null = not fetched
// Bybit fee rates (used in P&L accounting)
const FEE_SPOT_MAKER     = 0.0002;   // 0.02% spot maker (limit below market)
const FEE_SPOT_TAKER     = 0.001;    // 0.10% spot taker (market order)
const FEE_FUT_MAKER      = 0.0002;   // 0.02% futures maker
const FEE_FUT_TAKER      = 0.00055;  // 0.055% futures taker (Bybit linear)
function checkStratDipBuyer(candles) {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];
  const sma200 = calcSMA(closes, 200);
  const sma50  = calcSMA(closes, 50);
  const sma50p = calcSMA(closes, 50, 10);   // SMA50 ten bars ago (for "rising/falling" check)
  const rsi2   = calcRSI(closes, 2);
  const atr    = calcATR(candles, 14);

  if (sma200 === null || sma50 === null || sma50p === null || rsi2 === null || atr === null)
    return { signal: null, reason: "insufficient data (need 200+ 1H bars)" };

  const candleLow  = candles[candles.length - 1].low;
  const candleHigh = candles[candles.length - 1].high;
  const indicators = { price, sma200, sma50, rsi2, atr, candleLow, candleHigh };
  const uptrend   = price > sma200 && sma50 > sma50p;
  const downtrend = price < sma200 && sma50 < sma50p;

  // ── LONG signal: deeply oversold dip inside an uptrend ──────────────────
  if (uptrend && rsi2 < DIP_RSI_ENTRY) {
    // V2: entry=candle_low, stop=low*(1-buffer), tp=entry+3×risk
    // V1: entry=close-0.15%, stop=entry-4×ATR, tp=SMA5 cross
    const v2Entry = candleLow;
    const v2Stop  = candleLow * (1 - DIP_V2_STOP_BUFFER);
    const v2Tp    = v2Entry + DIP_V2_RR * (v2Entry - v2Stop);
    return {
      signal: "buy", side: "long",
      reason: `DIP-BUY  ↑ uptrend (price>SMA200, SMA50↑), RSI2=${rsi2.toFixed(1)}<${DIP_RSI_ENTRY}`,
      stopPrice:  DIP_V2_ENABLED ? v2Stop  : price - DIP_STOP_ATR * atr,
      tpPrice:    DIP_V2_ENABLED ? v2Tp    : null,
      limitPrice: DIP_V2_ENABLED ? v2Entry : null,   // null = use old close-offset logic
      indicators,
    };
  }

  // ── SHORT signal: overbought spike inside a downtrend ───────────────────
  // Only available in futures mode (DIP_BUYER_MODE=linear); spot cannot short.
  if (DIP_BUYER_MODE === "linear" && downtrend && rsi2 > DIP_RSI_SHORT) {
    const v2Entry = candleHigh;
    const v2Stop  = candleHigh * (1 + DIP_V2_STOP_BUFFER);
    const v2Tp    = v2Entry - DIP_V2_RR * (v2Stop - v2Entry);
    return {
      signal: "sell", side: "short",
      reason: `DIP-SHORT ↓ downtrend (price<SMA200, SMA50↓), RSI2=${rsi2.toFixed(1)}>${DIP_RSI_SHORT}`,
      stopPrice:  DIP_V2_ENABLED ? v2Stop  : price + DIP_STOP_ATR * atr,
      tpPrice:    DIP_V2_ENABLED ? v2Tp    : null,
      limitPrice: DIP_V2_ENABLED ? v2Entry : null,
      indicators,
    };
  }

  // No signal — report which condition blocked
  if (uptrend)   return { signal: null, reason: `uptrend but RSI2=${rsi2.toFixed(1)} (need <${DIP_RSI_ENTRY})`, indicators };
  if (downtrend) return { signal: null, reason: `downtrend but RSI2=${rsi2.toFixed(1)} (need >${DIP_RSI_SHORT})`, indicators };
  return { signal: null, reason: `no clear trend (SMA200=${sma200.toFixed(2)}, SMA50 ${sma50 > sma50p ? "rising" : "falling"} but price ${price > sma200 ? ">" : "<"} SMA200)`, indicators };
}

// ─── Strategy B: Hermes v06 — RSI Rejection in Downtrend ─────────────────────
// v06 upgrades (SWOT-driven):
//   1. ATR-adaptive SL/TP   — SL = entry + max(1.5%, 1.5×ATR); TP1=1×ATR, TP2=2.5×ATR
//   2. Trade journal         — records all entry indicators to hermes_journal.json
//   3. Macro regime filter   — skips shorts when BTC 4H RSI > 65 (broad bull mode)
//   4. Session filter        — 08:00–22:00 UAE only (blocks thin-volume dead hours)
//   5. Confidence score      — 0–100 composite; logged but doesn't gate entries yet
//   6. Trend vote extended   — ALL coins now need min 8/20 bars (was 0 for non-BTC)

function checkStratHermes(candles, trendVoteMin = 8, btcRsi4h = null) {
  const closes  = candles.map((c) => c.close);
  const price   = closes[closes.length - 1];
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  const ema50   = calcEMA(closes, 50);
  const rsi     = calcRSI(closes, 14);
  const rsiPrev = calcRSI(closes.slice(0, -1), 14);
  const atr14   = calcATR(candles, 14);

  if (ema9 === null || ema21 === null || ema50 === null || rsi === null || rsiPrev === null)
    return { signal: null, reason: "insufficient data" };

  // ── [NEW v06] Macro regime filter ────────────────────────────────────────
  // Skip all Hermes shorts when BTC 4H RSI > 65 (broad market in bull momentum).
  // Today: BTC RSI14(1H) = 68 → Hermes correctly blocked. This makes it explicit.
  const BTC_RSI_BULL_THRESHOLD = 65;
  if (btcRsi4h !== null && btcRsi4h > BTC_RSI_BULL_THRESHOLD) {
    return {
      signal: null,
      reason: `🌍 Macro filter: BTC 4H RSI=${btcRsi4h.toFixed(1)} > ${BTC_RSI_BULL_THRESHOLD} (bull mode — no shorts)`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  // ── [NEW v06] Session filter — 08:00–22:00 UAE ───────────────────────────
  const uaeHour = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai", hour: "numeric", hour12: false });
  const hour = parseInt(uaeHour);
  if (hour < 8 || hour >= 22) {
    return {
      signal: null,
      reason: `🕐 Session filter: ${hour}:xx UAE (trading window 08:00–22:00 only)`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  const bearStack = ema9 < ema21 && ema21 < ema50 && price < ema50;
  if (!bearStack) {
    return {
      signal: null,
      reason: `no bear stack (EMA9=${ema9.toFixed(2)} EMA21=${ema21.toFixed(2)} EMA50=${ema50.toFixed(2)})`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  // ── Trend strength vote (all coins now require min 8/20) ─────────────────
  // v06: extended to all coins (was 0 for NEAR/SOL/ETH). BTC keeps 12.
  // Why 8: needs half the recent bars in bear stack = sustained downtrend not a dip.
  const VOTE_BARS  = 20;
  const VOTE_MIN   = trendVoteMin;   // caller passes per-asset value (default 8)
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
  if (bearVotes < VOTE_MIN) {
    return {
      signal: null,
      reason: `bear stack ✅ but trend too weak (${bearVotes}/${VOTE_BARS} bars, need ≥${VOTE_MIN})`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  // RSI spike check: was RSI > 55 in last 5 bars?
  const rsiWindow = [];
  for (let j = Math.max(0, candles.length - 5); j < candles.length; j++) {
    const r = calcRSI(closes.slice(0, j + 1), 14);
    if (r) rsiWindow.push(r);
  }
  const rsiPeak         = Math.max(...rsiWindow);
  const recentlyAbove55 = rsiWindow.some((r) => r > 55);
  const crossesBelow52  = rsiPrev >= 52 && rsi < 52;
  const notOversold     = rsi > 38;

  // Volume spike confirmation (unchanged from v05)
  const volumes  = candles.map((c) => c.volume);
  const prevVol  = volumes[volumes.length - 2];
  const vol20    = volumes.slice(-22, -2);
  const avgVol   = vol20.length > 0 ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
  const volRatio      = avgVol > 0 ? prevVol / avgVol : 1;
  const volumeConfirm = volRatio >= 1.2;

  // ── [NEW v06] Confidence score (0–100) ───────────────────────────────────
  // Logged with every trade; future versions will gate on score > threshold.
  // Score = bear votes (max 40) + RSI spike height (max 20) + vol strength (max 20) + ATR edge (max 20)
  const atrPct   = atr14 !== null ? (atr14 / price * 100) : 0;
  const scoreVote = Math.min(40, bearVotes * 2);              // 20 votes = 40 pts
  const scoreRsi  = Math.min(20, Math.max(0, (rsiPeak - 55) * 2));  // peak 65 = 20 pts
  const scoreVol  = Math.min(20, Math.max(0, (volRatio - 1.2) * 25)); // 2× = 20 pts
  const scoreAtr  = Math.min(20, Math.max(0, atrPct * 4));   // 5% ATR = 20 pts
  const confidence = Math.round(scoreVote + scoreRsi + scoreVol + scoreAtr);

  // ── [NEW v06] ATR-adaptive SL and TP ─────────────────────────────────────
  // v05 used fixed 1.5% — ignores volatility. v06 uses ATR(14):
  //   SL = entry + max(1.5%, 1.5×ATR)   [stop above for short, wider in high-vol]
  //   TP1 = entry − 1.0×ATR             [first target at one ATR down]
  //   TP2 = entry − 2.5×ATR             [full exit at 2.5× ATR reward]
  const atrSlPct  = atr14 !== null ? Math.max(0.015, 1.5 * atr14 / price) : 0.015;
  const atrTp1Pct = atr14 !== null ? Math.min(0.03, Math.max(0.01, 1.0 * atr14 / price)) : 0.015;
  const atrTp2Pct = atr14 !== null ? Math.min(0.07, Math.max(0.025, 2.5 * atr14 / price)) : 0.030;

  if (recentlyAbove55 && crossesBelow52 && notOversold && volumeConfirm) {
    return {
      signal: "sell", side: "sell",
      reason: `HERMES v06 SHORT — bear ${bearVotes}/${VOTE_BARS} ✅, RSI ${rsiPrev?.toFixed(1)}→${rsi.toFixed(1)} ✅, vol ${volRatio.toFixed(2)}× ✅, ATR=${atrPct.toFixed(2)}%, conf=${confidence}/100`,
      indicators: { price, ema9, ema21, ema50, rsi, rsiPrev, rsiPeak, bearVotes, volRatio, atr14, atrPct, confidence },
      // ATR-adaptive levels (returned so execution layer can use them)
      atrSlPct, atrTp1Pct, atrTp2Pct,
    };
  }

  return {
    signal: null,
    reason: `bear ✅ votes ${bearVotes}/${VOTE_BARS} ✅ — RSI=${rsi.toFixed(1)} spike=${recentlyAbove55}(peak=${rsiPeak.toFixed(1)}) cross52=${crossesBelow52} floor=${notOversold} vol=${volRatio.toFixed(2)}× conf=${confidence}`,
    indicators: { price, ema9, ema21, ema50, rsi, bearVotes, volRatio, confidence },
  };
}

// ─── Hermes Trade Journal (v06) ───────────────────────────────────────────────
// Records full entry context → enables weekly self-analysis and learning.
// File: hermes_journal.json  [{id, symbol, entryTime, ...indicators, exitTime, pnl, exitReason}]
const JOURNAL_FILE = "hermes_journal.json";
function loadJournal() {
  if (!existsSync(JOURNAL_FILE)) return [];
  try { return JSON.parse(readFileSync(JOURNAL_FILE, "utf8")); } catch { return []; }
}
function saveJournal(j) { writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2)); }

function journalEntry(symbol, price, indicators, slPct, tp1Pct, tp2Pct) {
  const j = loadJournal();
  const id = `H-${Date.now()}`;
  const uaeHour = parseInt(new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai", hour: "numeric", hour12: false }));
  j.push({
    id, symbol, status: "open",
    entryTime: new Date().toISOString(), uaeHour,
    price,
    // All entry indicators — the learning data
    ema9: indicators.ema9, ema21: indicators.ema21, ema50: indicators.ema50,
    rsi: indicators.rsi, rsiPrev: indicators.rsiPrev, rsiPeak: indicators.rsiPeak,
    bearVotes: indicators.bearVotes, volRatio: indicators.volRatio,
    atr14: indicators.atr14, atrPct: indicators.atrPct,
    confidence: indicators.confidence,
    // Risk levels used
    slPct: +(slPct * 100).toFixed(3),
    tp1Pct: +(tp1Pct * 100).toFixed(3),
    tp2Pct: +(tp2Pct * 100).toFixed(3),
    // Outcome (filled at close)
    exitTime: null, exitPrice: null, exitReason: null, pnl: null, tp1Hit: false,
  });
  saveJournal(j);
  console.log(`  📓 Journal entry created: ${id} | conf=${indicators.confidence}/100 | ATR=${indicators.atrPct?.toFixed(2)}%`);
  return id;
}

function journalClose(journalId, exitPrice, exitReason, pnl, tp1Hit) {
  const j = loadJournal();
  const entry = j.find(e => e.id === journalId);
  if (!entry) return;
  entry.status    = "closed";
  entry.exitTime  = new Date().toISOString();
  entry.exitPrice = exitPrice;
  entry.exitReason = exitReason;
  entry.pnl       = pnl;
  entry.tp1Hit    = tp1Hit;
  saveJournal(j);
}

// ─── Hermes Weekly Self-Analysis ─────────────────────────────────────────────
// Call manually or schedule: reads journal → prints which conditions correlate with wins.
function hermesAnalysis() {
  const j = loadJournal().filter(e => e.status === "closed" && e.pnl !== null);
  if (j.length < 5) { console.log("  📊 Not enough closed Hermes trades for analysis yet (need 5+)"); return; }

  const wins  = j.filter(e => e.pnl > 0);
  const loses = j.filter(e => e.pnl <= 0);
  const avg   = (arr, field) => arr.length ? arr.reduce((s, e) => s + (e[field]||0), 0) / arr.length : 0;

  console.log(`\n  ── Hermes Journal Analysis (${j.length} closed trades) ──`);
  console.log(`  Win rate  : ${Math.round(wins.length/j.length*100)}% (${wins.length}W / ${loses.length}L)`);
  console.log(`  Total P&L : $${j.reduce((s,e)=>s+e.pnl,0).toFixed(2)}`);
  console.log(`  Avg P&L   : $${(j.reduce((s,e)=>s+e.pnl,0)/j.length).toFixed(2)}/trade`);
  console.log(`\n  Winners vs Losers:`);
  for (const field of ["confidence","bearVotes","rsiPeak","volRatio","atrPct","uaeHour"]) {
    const wAvg = avg(wins, field).toFixed(2), lAvg = avg(loses, field).toFixed(2);
    const edge = parseFloat(wAvg) > parseFloat(lAvg) ? "↑ higher = better" : "↓ lower = better";
    console.log(`  ${field.padEnd(12)}: wins=${wAvg}  losses=${lAvg}  (${edge})`);
  }
  console.log(`\n  Best UAE hours: ${[...new Set(wins.map(e=>e.uaeHour))].sort((a,b)=>a-b).join(", ")}`);
  console.log(`  Worst UAE hours: ${[...new Set(loses.map(e=>e.uaeHour))].sort((a,b)=>a-b).join(", ")}`);
}

// ─── Bybit Execution ──────────────────────────────────────────────────────────

function signBybit(timestamp, body) {
  // Bybit v5 POST signing: timestamp + apiKey + recvWindow + body
  return crypto.createHmac("sha256", CONFIG.bybit.secretKey)
    .update(`${timestamp}${CONFIG.bybit.apiKey}5000${body}`).digest("hex");
}

// Price tick precision per asset (coarse enough to satisfy BOTH spot and linear tick sizes).
// Used to round the native stop-loss trigger price so Bybit accepts it.
const PRICE_DECIMALS = { NEARUSDT: 3, SOLUSDT: 2, ETHUSDT: 2, BTCUSDT: 1, TRXUSDT: 4 };

// Retry wrapper.
//  - On a Bybit logic error WHILE a native SL was attached: retry once WITHOUT the SL
//    so a rejected stop-loss parameter can never block the actual entry. The software-side
//    SL remains the backstop in that case.
//  - On network/JSON errors: retry after 2s (not on Bybit logic errors).
async function placeBybitOrder(symbol, side, sizeUSD, price, mode = "spot", slPrice = null, reduceOnly = false, tpPrice = null) {
  // "Protection" = native SL and/or TP attached to the entry order (linear only).
  let useProt = (slPrice !== null || tpPrice !== null) && !reduceOnly;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await _placeBybitOrder(symbol, side, sizeUSD, price, mode, useProt ? slPrice : null, reduceOnly, useProt ? tpPrice : null);
    } catch (err) {
      const isNetworkErr = !err.message.startsWith("Bybit error");
      if (useProt && !isNetworkErr) {
        // Native TP/SL params rejected — drop them and retry so the entry still fills.
        console.log(`  ⚠️  Native TP/SL rejected (${err.message.slice(0,70)}). Retrying WITHOUT them — software exits still active.`);
        useProt = false;
        continue;
      }
      if (isNetworkErr && attempt < 3) {
        console.log(`  ⚠️  Order attempt ${attempt} failed (${err.message.slice(0,60)}) — retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

async function _placeBybitOrder(symbol, side, sizeUSD, price, mode = "spot", slPrice = null, reduceOnly = false, tpPrice = null) {
  const timestamp = Date.now().toString();
  const dp    = PRICE_DECIMALS[symbol] ?? 2;
  const slStr = slPrice !== null ? slPrice.toFixed(dp) : null;
  const tpStr = tpPrice !== null ? tpPrice.toFixed(dp) : null;

  let body;
  if (mode === "linear") {
    // Perpetual futures — qty step per asset (from Bybit instrument info):
    //   NEAR=0.1(1dp), SOL=0.1(1dp), ETH=0.01(2dp), BTC=0.001(3dp)
    const LINEAR_DECIMALS = { NEARUSDT: 1, SOLUSDT: 1, ETHUSDT: 2, BTCUSDT: 3 };
    const qtyDecimals = LINEAR_DECIMALS[symbol] ?? 2;
    const qty = (sizeUSD / price).toFixed(qtyDecimals);
    body = JSON.stringify({
      category:    "linear",
      symbol,
      side:        side === "buy" ? "Buy" : "Sell",
      orderType:   "Market",
      qty,
      timeInForce: "IOC",
      reduceOnly,       // true for closes — can only reduce a position, never flip it
      positionIdx: 0,   // one-way mode
      // Native server-side TP/SL — fire even if the bot/PC is offline.
      // tpslMode "Full" = whole position; triggered on Last price.
      // (Only attached on entries; closes pass reduceOnly + no TP/SL.)
      ...((slStr || tpStr) && !reduceOnly ? {
        ...(slStr ? { stopLoss: slStr, slTriggerBy: "LastPrice" } : {}),
        ...(tpStr ? { takeProfit: tpStr, tpTriggerBy: "LastPrice" } : {}),
        tpslMode: "Full",
      } : {}),
    });
  } else {
    // Spot orders:
    //   BUY  — pass USDT amount with marketUnit:"quoteCoin" (works for all assets uniformly)
    //   SELL — pass base token qty using per-asset decimal precision
    //          NEAR=0.01(2dp), SOL=0.0001(4dp), ETH=0.00001(5dp), BTC=0.000001(6dp)
    const SPOT_DECIMALS = { NEARUSDT: 2, SOLUSDT: 4, ETHUSDT: 5, BTCUSDT: 6, TRXUSDT: 2 };
    if (side === "buy") {
      body = JSON.stringify({
        category:   "spot",
        symbol,
        side:       "Buy",
        orderType:  "Market",
        qty:        sizeUSD.toFixed(2),   // USDT amount
        marketUnit: "quoteCoin",          // tells Bybit qty is in quote (USDT)
        // Native server-side stop-loss on the spot holding — fires even if PC is offline.
        ...(slStr ? { stopLoss: slStr, slOrderType: "Market" } : {}),
      });
    } else {
      const decimals = SPOT_DECIMALS[symbol] ?? 4;
      const tokenQty = (sizeUSD / price).toFixed(decimals);
      body = JSON.stringify({
        category:  "spot",
        symbol,
        side:      "Sell",
        orderType: "Market",
        qty:       tokenQty,             // base token amount to sell
      });
    }
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
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`Bybit non-JSON response (HTTP ${res.status}): ${raw.slice(0,120)}`); }
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

// ─── Spot stop-loss (separate conditional order) ─────────────────────────────
// A spot market BUY sized in USDT can't carry an attached SL (Bybit error 170130 —
// it doesn't know the base qty until fill). So we place a standalone server-side
// conditional STOP-MARKET sell that Bybit triggers if price falls to the trigger,
// protecting the holding even when the bot/PC is offline.
const SPOT_QTY_DECIMALS = { NEARUSDT: 2, SOLUSDT: 4, ETHUSDT: 5, BTCUSDT: 6, TRXUSDT: 2 };

async function placeSpotStopLoss(symbol, baseQty, triggerPrice) {
  const timestamp = Date.now().toString();
  const trig = triggerPrice.toFixed(PRICE_DECIMALS[symbol] ?? 2);
  // Floor the qty to the asset step so we never try to sell more than we hold.
  const dec  = SPOT_QTY_DECIMALS[symbol] ?? 4;
  const qty  = (Math.floor(baseQty * 10 ** dec) / 10 ** dec).toFixed(dec);
  const body = JSON.stringify({
    category:         "spot",
    symbol,
    side:             "Sell",
    orderType:        "Market",
    qty,
    triggerPrice:     trig,
    triggerDirection: 2,            // 2 = trigger when last price FALLS to trigger
    orderFilter:      "StopOrder",
    marketUnit:       "baseCoin",
  });
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
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result.orderId;
}

// Spot take-profit — a standalone conditional STOP-MARKET sell that triggers when
// price RISES to the target (triggerDirection 1). Mirrors placeSpotStopLoss; gives
// offline profit capture for spot longs whose live exit is RSI-based (no fixed price).
async function placeSpotTakeProfit(symbol, baseQty, triggerPrice) {
  const timestamp = Date.now().toString();
  const trig = triggerPrice.toFixed(PRICE_DECIMALS[symbol] ?? 2);
  const dec  = SPOT_QTY_DECIMALS[symbol] ?? 4;
  const qty  = (Math.floor(baseQty * 10 ** dec) / 10 ** dec).toFixed(dec);
  const body = JSON.stringify({
    category:         "spot",
    symbol,
    side:             "Sell",
    orderType:        "Market",
    qty,
    triggerPrice:     trig,
    triggerDirection: 1,            // 1 = trigger when last price RISES to trigger
    orderFilter:      "StopOrder",
    marketUnit:       "baseCoin",
  });
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
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result.orderId;
}

// Cancel a dangling spot conditional order (stop OR take-profit) before selling.
// Returns true if cancelled, false if it couldn't be (e.g. already triggered/gone).
async function cancelSpotConditional(symbol, orderId) {
  if (!orderId) return false;
  try {
    const timestamp = Date.now().toString();
    const body = JSON.stringify({ category: "spot", symbol, orderId, orderFilter: "StopOrder" });
    const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/cancel`, {
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
    return data.retCode === 0;
  } catch { return false; }
}

// Read the free wallet balance of a coin (e.g. "SOL"). Returns a Number, or null on error.
// Used by the VWAP exit to confirm tokens are actually gone before marking a position closed.
async function getSpotBalance(coin) {
  try {
    const timestamp = Date.now().toString();
    const params = `accountType=UNIFIED&coin=${coin}`;
    const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/account/wallet-balance?${params}`, {
      headers: {
        "X-BAPI-API-KEY":    CONFIG.bybit.apiKey,
        "X-BAPI-SIGN":       signBybit(timestamp, params),
        "X-BAPI-TIMESTAMP":  timestamp,
        "X-BAPI-RECV-WINDOW":"5000",
      },
    });
    const data = await res.json();
    const c = data.result?.list?.[0]?.coin?.find((x) => x.coin === coin);
    return c ? parseFloat(c.walletBalance) : 0;
  } catch { return null; }
}

// Market-sell an explicit base-coin quantity. The VWAP exit uses this to sell exactly
// what's HELD — avoiding the size/price mismatch that oversells at a loss (failed sell →
// orphan) and leaves profit tokens behind at a gain (dust residual).
async function sellSpotHolding(symbol, baseQty) {
  const timestamp = Date.now().toString();
  const dec  = SPOT_QTY_DECIMALS[symbol] ?? 4;
  const qty  = (Math.floor(baseQty * 10 ** dec) / 10 ** dec).toFixed(dec);
  const body = JSON.stringify({ category: "spot", symbol, side: "Sell", orderType: "Market", qty, marketUnit: "baseCoin" });
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
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
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

// ─── Limit-order helpers (for maker-fee dip-buyer entries) ───────────────────

// Place a spot LIMIT BUY below the current market price.
// A buy-limit below market goes into the order book (maker) → ~0.02% Bybit spot maker fee.
// qty is in base coin (e.g. BTC), price is the limit price in USDT.
async function placeLimitBuySpot(symbol, sizeUSD, limitPrice) {
  const timestamp = Date.now().toString();
  const pDec = PRICE_DECIMALS[symbol] ?? 2;
  const qDec = SPOT_QTY_DECIMALS[symbol] ?? 4;
  // Floor qty to avoid overshooting when rounded up
  const baseQty = (Math.floor(sizeUSD / limitPrice * 10 ** qDec) / 10 ** qDec).toFixed(qDec);
  const priceStr = limitPrice.toFixed(pDec);
  const body = JSON.stringify({
    category:    "spot",
    symbol,
    side:        "Buy",
    orderType:   "Limit",
    qty:         baseQty,      // base coin amount
    price:       priceStr,     // limit price in USDT
    timeInForce: "GTC",        // Good Till Cancelled — stays in book until filled or cancelled
  });
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
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result; // { orderId, ... }
}

// Set cross-margin leverage on a linear (perpetual) symbol before placing an order.
// Must be called once per symbol each session (Bybit persists the setting).
async function setBybitLeverage(symbol, leverage) {
  const timestamp = Date.now().toString();
  const lev = String(leverage);
  const body = JSON.stringify({
    category: "linear", symbol,
    buyLeverage: lev, sellLeverage: lev,
  });
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/set-leverage`, {
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
  // retCode 110043 = "leverage not modified" (already set) — treat as success
  if (data.retCode !== 0 && data.retCode !== 110043)
    throw new Error(`Bybit set-leverage error ${data.retCode}: ${data.retMsg}`);
  return true;
}

// Place a LINEAR (perpetual futures) LIMIT BUY below market with native SL attached.
// qty = (sizeUSD × leverage) / limitPrice  — controls 2× the margin in notional.
// A limit below market = maker order = ~0.02% fee on Bybit futures.
async function placeLimitBuyLinear(symbol, sizeUSD, leverage, limitPrice, slPrice, tpPrice = null) {
  const timestamp = Date.now().toString();
  const dp    = PRICE_DECIMALS[symbol] ?? 2;
  const notional = sizeUSD * leverage;
  // Qty step per symbol (from Bybit instrument info):
  const LINEAR_DECIMALS = { NEARUSDT: 1, SOLUSDT: 1, ETHUSDT: 2, BTCUSDT: 3, TRXUSDT: 0 };
  const qDec = LINEAR_DECIMALS[symbol] ?? 2;
  const qty  = (Math.floor(notional / limitPrice * 10 ** qDec) / 10 ** qDec).toFixed(qDec);
  const body = JSON.stringify({
    category:    "linear",
    symbol,
    side:        "Buy",
    orderType:   "Limit",
    qty,
    price:       limitPrice.toFixed(dp),
    timeInForce: "GTC",
    positionIdx: 0,                        // one-way mode
    // Native server-side SL + TP fire even if bot/PC is offline (V2 exchange-native exits)
    ...(slPrice ? {
      stopLoss:    slPrice.toFixed(dp),
      slTriggerBy: "LastPrice",
      tpslMode:    "Full",
    } : {}),
    ...(tpPrice ? {
      takeProfit:    tpPrice.toFixed(dp),
      tpTriggerBy:   "LastPrice",
      tpslMode:      "Full",
    } : {}),
  });
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
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result; // { orderId, ... }
}

// Place a LINEAR (perpetual futures) LIMIT SELL above market — SHORT entry with native SL.
// side="Sell" + limit ABOVE market = maker order (sits in book, waits for price to push up).
// slPrice = entry + 4×ATR (stop ABOVE entry for a short).
async function placeLimitSellLinear(symbol, sizeUSD, leverage, limitPrice, slPrice, tpPrice = null) {
  const timestamp = Date.now().toString();
  const dp    = PRICE_DECIMALS[symbol] ?? 2;
  const notional = sizeUSD * leverage;
  const LINEAR_DECIMALS = { NEARUSDT: 1, SOLUSDT: 1, ETHUSDT: 2, BTCUSDT: 3, TRXUSDT: 0 };
  const qDec = LINEAR_DECIMALS[symbol] ?? 2;
  const qty  = (Math.floor(notional / limitPrice * 10 ** qDec) / 10 ** qDec).toFixed(qDec);
  const body = JSON.stringify({
    category:    "linear",
    symbol,
    side:        "Sell",          // SHORT entry
    orderType:   "Limit",
    qty,
    price:       limitPrice.toFixed(dp),
    timeInForce: "GTC",
    positionIdx: 0,               // one-way mode
    // Native server-side SL + TP (V2 exchange-native exits)
    ...(slPrice ? {
      stopLoss:    slPrice.toFixed(dp),
      slTriggerBy: "LastPrice",
      tpslMode:    "Full",
    } : {}),
    ...(tpPrice ? {
      takeProfit:    tpPrice.toFixed(dp),
      tpTriggerBy:   "LastPrice",
      tpslMode:      "Full",
    } : {}),
  });
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
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result; // { orderId, ... }
}

// Query the status of an order (checks history for closed orders too).
// Returns { orderStatus, avgPrice, cumExecQty, cumExecValue } or null if not found.
async function queryOrderStatus(symbol, orderId, category = "spot") {
  try {
    const timestamp = Date.now().toString();
    // Check open orders first (realtime), then history
    for (const endpoint of ["/v5/order/realtime", "/v5/order/history"]) {
      const params = `category=${category}&symbol=${symbol}&orderId=${orderId}`;
      const res = await fetch(`${CONFIG.bybit.baseUrl}${endpoint}?${params}`, {
        headers: {
          "X-BAPI-API-KEY":    CONFIG.bybit.apiKey,
          "X-BAPI-SIGN":       signBybit(timestamp, params),
          "X-BAPI-TIMESTAMP":  timestamp,
          "X-BAPI-RECV-WINDOW":"5000",
        },
      });
      const data = await res.json();
      if (data.retCode === 0 && data.result?.list?.length > 0) {
        const o = data.result.list[0];
        return {
          orderStatus:  o.orderStatus,
          avgPrice:     parseFloat(o.avgPrice || "0"),
          cumExecQty:   parseFloat(o.cumExecQty || "0"),
          cumExecValue: parseFloat(o.cumExecValue || "0"),
        };
      }
    }
    return null;
  } catch { return null; }
}

// Cancel an order by orderId — works for both spot and linear.
async function cancelSpotOrder(symbol, orderId, category = "spot") {
  try {
    const timestamp = Date.now().toString();
    const body = JSON.stringify({ category, symbol, orderId });
    const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/cancel`, {
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
    return data.retCode === 0;
  } catch { return false; }
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
function openPositionRecord(symbol, side, entry, tradeSize, strategy, orderId, vwapSlPct = 0.003, slOrderId = null, tpOrderId = null) {
  const positions = loadPositions();
  const filtered  = positions.filter((p) => p.symbol !== symbol || p.status !== "open");
  const isHermesStrat = strategy === "hermes_v03" || strategy === "hermes_v04" || strategy === "hermes_v05" || strategy === "hermes_v06";

  filtered.push({
    symbol,
    side,
    strategy,
    entry,
    tp1:       isHermesStrat ? +(entry * (1 - 0.015)).toFixed(6) : null,
    tp2:       isHermesStrat ? +(entry * (1 - 0.030)).toFixed(6) : null,
    sl:        isHermesStrat ? +(entry * (1 + 0.015)).toFixed(6) : null,
    slBE:      null,
    slPct:     isHermesStrat ? null : vwapSlPct,  // per-asset SL % for VWAP exits
    slOrderId: slOrderId || null,                 // Bybit conditional stop order id (spot)
    tpOrderId: tpOrderId || null,                 // Bybit conditional take-profit order id (spot)
    size:      tradeSize,
    tp1Hit:    false,
    status:    "open",
    openTime:  new Date().toISOString(),
    orderId:   orderId || null,
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

  // NOTE: VWAP positions (no tp1/tp2) are owned entirely by checkVwapPositions(),
  // which handles RSI exit, stop-loss, trailing BE, AND 4h expiry — and crucially
  // cancels the server-side stop order before selling. We must NOT close them here,
  // or that cleanup is skipped and a dangling stop order is left on the exchange.

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

    // VWAP/dip_buyer positions have sl=null/undefined — skip here, each has its own exit manager
    if (pos.sl == null && pos.tp1 == null) {
      // dip_buyer positions use dipStop/dipTp; VWAP positions use VWAP Exit Manager
      continue;
    }

    const activeSL = pos.tp1Hit ? pos.slBE : pos.sl;
    const pct = ((pos.entry - price) / pos.entry * 100).toFixed(2);
    console.log(`  ${pos.symbol}: entry=$${pos.entry} now=$${price.toFixed(4)} P&L=${pct}% | SL=$${activeSL} TP1=$${pos.tp1}${pos.tp1Hit?" ✅":""} TP2=$${pos.tp2}`);

    // ── SL Hit ──────────────────────────────────────────────────────────────
    if (activeSL !== null && price >= activeSL) {
      const pnl = pos.tp1Hit
        ? (pos.entry - activeSL) / pos.entry * (pos.size * 0.5)
        : (pos.entry - activeSL) / pos.entry * pos.size;
      console.log(`  🛑 SL HIT @ $${price.toFixed(4)} | PnL: $${pnl.toFixed(2)}`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.tp1Hit ? pos.size*0.5 : pos.size, price, "linear", null, true); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.tp1Hit ? pos.size*0.5 : pos.size, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_SL pnl=$${pnl.toFixed(2)}` });
      pos.status = "closed"; pos.closeReason = "stop_loss"; pos.closePrice = price; pos.closeTime = new Date().toISOString(); pos.pnl = pnl;
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_sl" });
      if (pos.journalId) journalClose(pos.journalId, price, "stop_loss", pnl, pos.tp1Hit);
      await tgSL(pos.symbol, pos.entry, price.toFixed(4), pnl, pos.tp1Hit);

    // ── TP1 Hit (partial exit 50%) ───────────────────────────────────────────
    } else if (!pos.tp1Hit && price <= pos.tp1) {
      const pnl1 = (pos.entry - pos.tp1) / pos.entry * (pos.size * 0.5);
      console.log(`  ✅ TP1 HIT @ $${price.toFixed(4)} — exiting 50% | Locked: +$${pnl1.toFixed(2)} | SL→ breakeven`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.size * 0.5, price, "linear", null, true); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.size*0.5, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_TP1 locked=+$${pnl1.toFixed(2)}` });
      pos.tp1Hit = true;
      pos.slBE   = +(pos.entry * 1.001).toFixed(6);
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_tp1" });
      await tgTP1(pos.symbol, pos.entry, price.toFixed(4), pnl1);

    // ── TP2 Hit (full exit remaining 50%) ────────────────────────────────────
    } else if (pos.tp1Hit && price <= pos.tp2) {
      const pnl2 = (pos.entry - pos.tp2) / pos.entry * (pos.size * 0.5);
      const pnl1 = (pos.entry - pos.tp1) / pos.entry * (pos.size * 0.5);
      console.log(`  🏆 TP2 HIT @ $${price.toFixed(4)} — full exit | Total PnL: +$${(pnl1+pnl2).toFixed(2)}`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.size * 0.5, price, "linear", null, true); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.size*0.5, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_TP2 total=+$${(pnl1+pnl2).toFixed(2)}` });
      pos.status = "closed"; pos.closeReason = "take_profit_full"; pos.closePrice = price; pos.closeTime = new Date().toISOString(); pos.pnl = pnl1+pnl2;
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_tp2" });
      if (pos.journalId) journalClose(pos.journalId, price, "take_profit_full", pnl1+pnl2, true);
      await tgTP2(pos.symbol, pos.entry, price.toFixed(4), pnl1+pnl2);
    }
  }

  savePositions(positions);
}

// ─── Process one asset ────────────────────────────────────────────────────────

async function processAsset(asset, log) {
  // Route dip-buyer to its own self-contained handler
  if (asset.strategy === "dip_buyer") return await processDipBuyer(asset, log);

  console.log(`\n─── ${asset.symbol} [${asset.strategy}] ─────────────────────`);

  // Hermes uses 1H candles for quality signals; VWAP uses 5m
  const isHermes  = asset.strategy === "hermes_v03";
  // Per-asset VWAP timeframe: ETH uses 1H (backtest: 5m=39%WR -$9.93, 1H=100%WR)
  // Others use 5m (default). Hermes always uses hermesTimeframe (1H).
  const tf = isHermes
    ? CONFIG.hermesTimeframe
    : (asset.vwapTimeframe || CONFIG.timeframe);
  const candleCount = (tf === "1H") ? 100 : 200;

  const candles = await fetchCandles(asset.okx, tf, candleCount);
  const price   = candles[candles.length - 1].close;
  console.log(`  Price: $${price.toFixed(4)} [${tf}]`);

  // ── [v06] Fetch BTC 4H RSI for macro regime filter (Hermes only) ───────────
  let btcRsi4h = null;
  if (isHermes && asset.symbol !== "BTCUSDT") {
    try {
      const btcC4h = await fetchCandles("BTC-USDT", "4H", 20);
      btcRsi4h = calcRSI(btcC4h.map(c => c.close), 14);
    } catch { /* non-fatal */ }
  }

  // Run the assigned strategy
  const result = isHermes
    ? checkStratHermes(candles, asset.trendVote ?? 8, btcRsi4h)
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
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, paper: true, entry: true });
    openPositionRecord(asset.symbol, result.side, price, tradeSize, asset.strategy, null, asset.vwapSlPct);
    if (isHermes) {
      const tp1 = (price * 0.985).toFixed(4), tp2 = (price * 0.970).toFixed(4), sl = (price * 1.015).toFixed(4);
      await tgEntry(asset.symbol, result.side, price.toFixed(4), tradeSize, tp1, tp2, sl, "Hermes v05 [PAPER]");
    }
    return true;
  }

  // Live execution — Hermes=perpetual (true short), VWAP=spot (token buy/sell)
  const execMode = isHermes ? "linear" : "spot";

  // ── [v06] ATR-adaptive SL/TP for Hermes; fixed % for VWAP ───────────────
  const slPct   = isHermes
    ? (result.atrSlPct  ?? 0.015)   // ATR-adaptive (from checkStratHermes)
    : (asset.vwapSlPct  ?? 0.005);  // VWAP: per-asset fixed %
  const tp1Pct  = isHermes ? (result.atrTp1Pct ?? 0.015) : slPct * 1;
  const tp2Pct  = isHermes ? (result.atrTp2Pct ?? 0.030) : slPct * 3;

  const slPrice  = isHermes ? price * (1 + slPct)  : price * (1 - slPct);
  const tp1Price = isHermes ? price * (1 - tp1Pct) : price * (1 + tp1Pct);
  const tp2Price = isHermes ? price * (1 - tp2Pct) : price * (1 + tp2Pct);
  const dp       = PRICE_DECIMALS[asset.symbol] ?? 2;

  if (isHermes) {
    console.log(`  📐 v06 ATR levels: SL=+${(slPct*100).toFixed(2)}% ($${slPrice.toFixed(dp)}) | TP1=-${(tp1Pct*100).toFixed(2)}% ($${tp1Price.toFixed(dp)}) | TP2=-${(tp2Pct*100).toFixed(2)}% ($${tp2Price.toFixed(dp)}) | conf=${result.indicators?.confidence}/100`);
  }

  try {
    // Linear: TP+SL attach to the entry order. Spot: placed as separate conditional orders below.
    const order = await placeBybitOrder(asset.symbol, result.side, tradeSize, price, execMode, isHermes ? slPrice : null, false, isHermes ? tp2Price : null);

    // Spot long → place separate server-side conditional stop-sell + take-profit (offline protection)
    let slOrderId = null, tpOrderId = null;
    if (!isHermes && result.side === "buy") {
      const baseQty = tradeSize / price;
      try {
        slOrderId = await placeSpotStopLoss(asset.symbol, baseQty, slPrice);
        console.log(`  🛡️ Spot stop-loss order placed @ $${slPrice.toFixed(dp)} (id ${slOrderId})`);
      } catch (e) {
        console.log(`  ⚠️  Spot stop-loss not placed (${e.message.slice(0,60)}) — software SL still active`);
      }
      try {
        tpOrderId = await placeSpotTakeProfit(asset.symbol, baseQty, tp2Price);
        console.log(`  🎯 Spot take-profit order placed @ $${tp2Price.toFixed(dp)} (id ${tpOrderId})`);
      } catch (e) {
        console.log(`  ⚠️  Spot take-profit not placed (${e.message.slice(0,60)}) — software exit still active`);
      }
    }
    console.log(`  ✅ ORDER PLACED: ${result.side.toUpperCase()} ${asset.symbol} [${execMode}] | ID: ${order.orderId}${isHermes ? ` | 🛡️ SL @ $${slPrice.toFixed(dp)} 🎯 TP2 @ $${tp2Price.toFixed(dp)}` : ""}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v06", side: result.side, price, tradeSize, orderId: order.orderId, mode: `LIVE-${execMode.toUpperCase()}`, signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, orderId: order.orderId, execMode, entry: true });
    openPositionRecord(asset.symbol, result.side, price, tradeSize, "hermes_v06", order.orderId, asset.vwapSlPct, slOrderId, tpOrderId);
    if (isHermes) {
      // Write journal entry with full indicators
      const jId = journalEntry(asset.symbol, price, result.indicators, slPct, tp1Pct, tp2Pct);
      // Store journalId in position for close-time annotation
      const positions = loadPositions();
      const myPos = positions.find(p => p.symbol === asset.symbol && p.status === "open" && p.strategy === "hermes_v06");
      if (myPos) { myPos.journalId = jId; savePositions(positions); }

      await tgEntry(asset.symbol, result.side, price.toFixed(dp), tradeSize, tp1Price.toFixed(dp), tp2Price.toFixed(dp), slPrice.toFixed(dp), `Hermes v06 [LIVE] conf=${result.indicators?.confidence}/100`);
    }
    return true;
  } catch (err) {
    console.log(`  ❌ Order failed: ${err.message}`);
    return false;
  }
}

// ─── Dual-scan: run Hermes(1H) on VWAP assets (NEAR + SOL) ──────────────────
async function processHermesDualScan(asset, log) {
  const candles = await fetchCandles(asset.okx, CONFIG.hermesTimeframe, 100);
  // [v06] Fetch BTC 4H RSI for macro filter
  let btcRsi4hDual = null;
  if (asset.symbol !== "BTCUSDT") {
    try { const bc = await fetchCandles("BTC-USDT", "4H", 20); btcRsi4hDual = calcRSI(bc.map(c => c.close), 14); } catch {}
  }
  const result  = checkStratHermes(candles, asset.trendVote ?? 8, btcRsi4hDual);
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
  const tp1str = (price * 0.985).toFixed(4), tp2str = (price * 0.970).toFixed(4), slStr = (price * 1.015).toFixed(4);
  if (CONFIG.paperTrading) {
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v04", side: result.side, price, tradeSize, mode: "PAPER", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, paper: true, entry: true });
    openHermesPosition(asset.symbol, price, tradeSize, null);
    await tgEntry(asset.symbol, result.side, price.toFixed(4), tradeSize, tp1str, tp2str, slStr, "Hermes v05 [PAPER]");
    return true;
  }
  try {
    const slPrice = price * 1.015;  // Hermes short SL: 1.5% above entry
    const tpPrice = price * 0.970;  // Hermes short TP: 3% below entry (full-exit target)
    const dp = PRICE_DECIMALS[asset.symbol] ?? 2;
    const order = await placeBybitOrder(asset.symbol, result.side, tradeSize, price, "linear", slPrice, false, tpPrice);
    console.log(`  🛡️ native SL @ $${slPrice.toFixed(dp)} 🎯 TP @ $${tpPrice.toFixed(dp)}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v05", side: result.side, price, tradeSize, orderId: order.orderId, mode: "LIVE-LINEAR", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, orderId: order.orderId, execMode: "linear", entry: true });
    openHermesPosition(asset.symbol, price, tradeSize, order.orderId);
    await tgEntry(asset.symbol, result.side, price.toFixed(4), tradeSize, tp1str, tp2str, slStr, "Hermes v05 [LIVE]");
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
    (p) => p.status === "open" && p.strategy === "vwap_rsi3_ema8"  // dip_buyer has its own manager
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
    const pct    = ((price - pos.entry) / pos.entry * 100);

    // ── #7 Trailing stop: once +1% profit, move SL to breakeven ─────────────
    // Locks in trade as risk-free. If price keeps going, hold past 4H.
    // pos.slBE is set the first time profit reaches +1% and never moves back.
    const profitPct = (price - pos.entry) / pos.entry * 100;
    if (!pos.slBE && profitPct >= 1.0) {
      pos.slBE = pos.entry; // move SL to breakeven
      console.log(`  🔒 Trailing stop activated — SL moved to breakeven $${pos.entry} (profit +${profitPct.toFixed(2)}%)`);
      await tg(`🔒 <b>VWAP trailing stop — ${pos.symbol}</b>\nProfit +${profitPct.toFixed(2)}% → SL moved to breakeven $${pos.entry}\nLetting winner run! 🚀`);
    }
    const slPct = pos.slPct ?? 0.003; // per-asset SL % (ETH=0.7%, BTC=0.4%, others=0.3%)
    const sl = pos.slBE ?? (pos.entry * (1 - slPct));

    console.log(`  ${pos.symbol}: entry=$${pos.entry} now=$${price.toFixed(4)} P&L=${pct.toFixed(2)}% | RSI3=${rsi3?.toFixed(1)} SL=$${sl.toFixed(4)}${pos.slBE?" [BE]":""}`);

    let exitReason = null;

    // Exit 1: RSI(3) crosses above 65 — stronger momentum signal (was 50).
    // At 50 crossover, bounce barely covers 0.2% round-trip fee.
    // At 65+ the move is 0.5-1.0%, well above fee breakeven.
    const RSI3_EXIT = 65;
    if (rsi3 !== null && rsi3Prev !== null && rsi3Prev < RSI3_EXIT && rsi3 >= RSI3_EXIT) {
      exitReason = `rsi3_cross_${RSI3_EXIT}`;
      console.log(`  🎯 RSI(3) crossed ${RSI3_EXIT} — taking profit @ $${price.toFixed(4)} | P&L: ${pct.toFixed(2)}%`);
    }
    // Exit 2: stop loss hit (fixed 0.3% or breakeven after trailing)
    else if (price <= sl) {
      exitReason = pos.slBE ? "trailing_stop_be" : "stop_loss";
      console.log(`  🛑 ${pos.slBE?"BE stop":"SL"} HIT @ $${price.toFixed(4)} | P&L: ${pct.toFixed(2)}%`);
    }
    // Exit 3: 4-hour time expiry — only if NOT in breakeven mode (let winners run)
    else if (!pos.slBE) {
      const ageHrs = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
      if (ageHrs >= 4) {
        exitReason = "time_expiry_4h";
        console.log(`  ⏱️  4h expiry — closing @ $${price.toFixed(4)} | P&L: ${pct.toFixed(2)}%`);
      }
    }

    if (exitReason) {
      // Place real spot SELL to return tokens → USDT.
      // CRITICAL: only mark the position closed if the sell actually succeeded (or the
      // tokens are confirmed gone). Marking closed after a FAILED sell orphans the tokens
      // (untracked + unprotected) — that was the SOL double-holding bug.
      let sellConfirmed = CONFIG.paperTrading;  // paper trading = nothing to sell
      if (!CONFIG.paperTrading) {
        // Cancel dangling server-side stop + take-profit first so neither fires on tokens we're selling.
        if (pos.slOrderId) {
          const cancelled = await cancelSpotConditional(pos.symbol, pos.slOrderId);
          console.log(`  🧹 Stop-loss order ${cancelled ? "cancelled" : "already gone/triggered"} (id ${pos.slOrderId})`);
        }
        if (pos.tpOrderId) {
          const cancelled = await cancelSpotConditional(pos.symbol, pos.tpOrderId);
          console.log(`  🧹 Take-profit order ${cancelled ? "cancelled" : "already gone/triggered"} (id ${pos.tpOrderId})`);
        }
        await new Promise((r) => setTimeout(r, 500));  // let cancelled balance free up before selling
        const coin = pos.symbol.replace("USDT", "");
        const held = await getSpotBalance(coin);
        const expectedQty = pos.size / pos.entry;
        if (held === null) {
          console.log(`  ⚠️  Could not read ${coin} balance — keeping position OPEN, will retry exit next run`);
          continue;
        }
        if (held < expectedQty * 0.02) {
          // Tokens essentially gone — a server-side SL/TP already fired. Mark closed.
          console.log(`  ⚠️  ${coin} balance ~0 (${held.toFixed(4)}) — already exited server-side, marking closed`);
          sellConfirmed = true;
        } else {
          try {
            // Sell the ACTUAL held quantity (not size/price) — no oversell at a loss, no dust at a gain.
            await sellSpotHolding(pos.symbol, held);
            console.log(`  ✅ VWAP SELL placed — sold ${held.toFixed(4)} ${coin} (held balance)`);
            sellConfirmed = true;
          } catch (e) {
            console.log(`  ❌ VWAP sell FAILED (${e.message.slice(0,55)}) — ${coin} balance ${held.toFixed(4)} still held. Keeping position OPEN to retry (no orphan).`);
            sellConfirmed = false;
          }
        }
      }
      if (!sellConfirmed) continue;  // do NOT mark closed — retry the exit on the next run
      const FEE_RATE = 0.001; // 0.1% per side (Bybit spot taker fee)
      const feesUSD  = pos.size * FEE_RATE * 2; // round-trip: entry + exit
      const pnlUSD   = ((price - pos.entry) / pos.entry * pos.size) - feesUSD;
      console.log(`  💸 Fees deducted: -$${feesUSD.toFixed(2)} | Net P&L: $${pnlUSD.toFixed(2)}`);
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

      // Telegram exit alert
      const exitEmoji = { rsi3_cross_50: "✅", stop_loss: "🛑", trailing_stop_be: "🔒", time_expiry_4h: "⏱️" };
      const exitLabel = { rsi3_cross_50: "RSI3 crossed 50 — trend done", stop_loss: "Stop loss hit", trailing_stop_be: "Breakeven stop hit (profit locked)", time_expiry_4h: "4H time expiry" };
      await tg(
`${exitEmoji[exitReason]||"🔔"} <b>VWAP EXIT — ${pos.symbol}</b>
📍 Entry:  $${pos.entry}
📤 Exit:   $${price.toFixed(4)}
💵 P&L:    ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}
📋 Reason: ${exitLabel[exitReason]||exitReason}`
      );
    }
  }

  savePositions(positions);
}

// ─── Strategy C: Dip-Buyer entry + exit manager ──────────────────────────────

// Record a PENDING limit order — status "pending_limit" until Bybit confirms fill.
// The actual "open" record (with SL) is created in checkDipBuyerPendingOrders when filled.
function recordDipBuyerPendingLimit(symbol, signalPrice, limitPrice, tradeSize, limitOrderId, dipStop, mode = "spot", leverage = 1, side = "long", dipTp = null) {
  const positions = loadPositions();
  // Remove any stale pending for this symbol (same side only — can have both long+short pending if different symbols)
  const filtered = positions.filter((p) => !(p.symbol === symbol && p.status === "pending_limit" && p.side === side));
  filtered.push({
    symbol,
    side,           // "long" or "short"
    strategy: "dip_buyer",
    status:         "pending_limit",
    signalPrice:    +signalPrice.toFixed(6),
    limitPrice:     +limitPrice.toFixed(6),
    size:           tradeSize,
    limitOrderId:   limitOrderId,
    dipStop:        +dipStop.toFixed(6),
    dipTp:          dipTp ? +dipTp.toFixed(6) : null,   // V2: exchange-native TP
    mode,           // "spot" or "linear"
    leverage,       // 1 (spot) or 2 (futures)
    openTime:       new Date().toISOString(),
  });
  savePositions(filtered);
  const modeTag  = mode === "linear" ? ` [linear ${leverage}×]` : "";
  const sideTag  = side === "short" ? "SELL SHORT" : "BUY";
  console.log(`  ⏳ Pending limit order recorded: ${sideTag} ${symbol} @ $${limitPrice.toFixed(4)}${modeTag} (${DIP_LIMIT_TIMEOUT}h timeout)`);
}

function openDipBuyerPosition(symbol, entry, tradeSize, orderId, stopPrice, slOrderId, mode = "spot", leverage = 1, side = "long", dipTp = null) {
  const positions = loadPositions();
  // Allow one long AND one short open simultaneously (different sides)
  const filtered  = positions.filter((p) => !(p.symbol === symbol && p.status === "open" && p.side === side && p.strategy === "dip_buyer"));
  filtered.push({
    symbol, side,            // "long" or "short"
    strategy: "dip_buyer", entry,
    tp1: null, tp2: null, sl: null, slBE: null,   // null sl/tp1 → skipped by Hermes manager
    dipStop:   +stopPrice.toFixed(6),             // catastrophic stop (below entry for long, above for short)
    dipTp:     dipTp ? +dipTp.toFixed(6) : null, // V2: exchange-native 3:1 TP target
    exitSma:   5, maxHoldHrs: 24,
    slOrderId: slOrderId || null, tpOrderId: null,
    mode,           // "spot" or "linear"
    leverage,       // 1x (spot) or 2x (futures)
    size: tradeSize, tp1Hit: false, status: "open",
    openTime: new Date().toISOString(), orderId: orderId || null,
  });
  savePositions(filtered);
  const modeTag  = mode === "linear" ? ` [${leverage}× linear]` : "";
  const dir      = side === "short" ? "SHORT" : "BUY";
  const exitNote = side === "short" ? "close<SMA5" : "close>SMA5";
  console.log(`  📌 Dip-Buyer position: ${dir} ${symbol}${modeTag} @ $${entry} | stop $${stopPrice.toFixed(4)} | exit: ${exitNote} or 24h`);
}

// Checks all pending dip-buyer limit orders each run.
//   Filled  → upgrade to "open", place server-side SL, send Telegram
//   Timeout → cancel the order, clear pending record
//   Already cancelled (Bybit) → just clear the pending record
async function checkDipBuyerPendingOrders(log) {
  const positions = loadPositions();
  const pending = positions.filter((p) => p.status === "pending_limit" && p.strategy === "dip_buyer");
  if (!pending.length) return;

  console.log(`\n─── Dip-Buyer Pending Limit Orders (${pending.length}) ──────────`);
  for (const pos of pending) {
    const ageHrs = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
    console.log(`  ${pos.symbol}: limit @ $${pos.limitPrice} | age ${ageHrs.toFixed(1)}h | orderId ${pos.limitOrderId}`);

    const cat    = pos.mode === "linear" ? "linear" : "spot";
    const lev    = pos.leverage || 1;
    const status = await queryOrderStatus(pos.symbol, pos.limitOrderId, cat);
    if (!status) {
      console.log(`  ⚠️  Could not query order status — will retry next run`);
      continue;
    }

    console.log(`  Bybit status: ${status.orderStatus} | avgFill=$${status.avgPrice} qty=${status.cumExecQty} [${cat}]`);

    if (status.orderStatus === "Filled" || (status.cumExecQty > 0 && status.orderStatus === "PartiallyFilledCanceled")) {
      // ── ORDER FILLED — upgrade to open position ──────────────────────────
      const fillPrice = status.avgPrice > 0 ? status.avgPrice : pos.limitPrice;
      const fillQty   = status.cumExecQty;
      // For spot: filledUSD = notional. For futures: size = margin (notional / leverage).
      const filledNotional = status.cumExecValue > 0 ? status.cumExecValue : fillQty * fillPrice;
      const filledMargin   = cat === "linear" ? filledNotional / lev : filledNotional;
      const feeLabel = cat === "linear" ? "0.02% futures maker" : "0.02% spot maker";
      const modeLabel = cat === "linear" ? `futures ${lev}× (notional $${filledNotional.toFixed(2)})` : `spot`;
      console.log(`  ✅ FILLED @ $${fillPrice.toFixed(4)} | qty ${fillQty} | margin $${filledMargin.toFixed(2)} | ${modeLabel} | fee ~${feeLabel}`);

      // Spot: place separate server-side stop-loss now that we know the qty.
      // Linear: SL was attached to the limit order at placement time — no extra step needed.
      let slOrderId = null;
      if (cat === "spot" && !CONFIG.paperTrading) {
        try {
          slOrderId = await placeSpotStopLoss(pos.symbol, fillQty, pos.dipStop);
          console.log(`  🛡️ Spot stop-loss placed @ $${pos.dipStop.toFixed(4)} (id ${slOrderId})`);
        } catch (e) {
          console.log(`  ⚠️  Spot SL not placed (${e.message.slice(0,60)}) — exit manager protects`);
        }
      } else if (cat === "linear") {
        console.log(`  🛡️ Native SL already attached to the order @ $${pos.dipStop.toFixed(4)}`);
      }

      // Upgrade record from pending → open
      const posSide  = pos.side || "long";   // "long" or "short"
      pos.status    = "open";
      pos.entry     = fillPrice;
      pos.size      = filledMargin;           // always margin (USD at risk)
      pos.orderId   = pos.limitOrderId;
      pos.slOrderId = slOrderId;
      delete pos.limitOrderId;
      delete pos.signalPrice;
      delete pos.limitPrice;
      pos.exitSma    = 5;
      pos.maxHoldHrs = 24;
      pos.tp1Hit     = false;
      pos.tpOrderId  = null;
      // dipTp already stored in pos from recordDipBuyerPendingLimit (V2)
      // side, leverage, mode already stored in pos

      const dirLabel = posSide === "short" ? "SHORT" : "LONG";
      const exitNote = posSide === "short" ? "close &lt; SMA5 (recovery down)" : "close &gt; SMA5 (recovery up)";
      const csvMode  = CONFIG.paperTrading ? "PAPER" : (cat === "linear" ? `LIVE-LINEAR-LIMIT-${lev}X` : "LIVE-SPOT-LIMIT");
      writeTradeCsv({
        symbol: pos.symbol, strategy: "dip_buyer", side: posSide === "short" ? "sell" : "buy",
        price: fillPrice, tradeSize: filledMargin,
        mode: csvMode,
        signal: `DIP-${dirLabel} limit filled @ $${fillPrice.toFixed(4)} (maker ~0.02%)`,
      });
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: posSide === "short" ? "sell" : "buy", price: fillPrice, orderPlaced: true, strategy: "dip_buyer", limitFill: true, mode: cat, direction: posSide, entry: true });

      const dirEmoji = posSide === "short" ? "🔴" : "✅";
      await tg(
`${dirEmoji} <b>Dip-Buyer ${dirLabel} LIMIT FILLED — ${pos.symbol}</b>
📍 Fill: <b>$${fillPrice.toFixed(4)}</b>
📊 Mode: ${cat === "linear" ? `Futures ${lev}× | Notional $${filledNotional.toFixed(2)} | Margin $${filledMargin.toFixed(2)}` : `Spot | $${filledMargin.toFixed(2)}`}
💸 Fee: ~0.02% (maker)
🛑 Stop: $${pos.dipStop.toFixed(4)}
🎯 Exit: ${exitNote} | max 24h
🕐 ${uaeTime()}`
      );

    } else if (status.orderStatus === "Cancelled" || status.orderStatus === "Rejected") {
      console.log(`  🚫 Order ${status.orderStatus} on exchange — clearing pending record`);
      pos.status = "cancelled_limit";

    } else if (ageHrs >= DIP_LIMIT_TIMEOUT) {
      // ── TIMEOUT — cancel the unfilled limit ─────────────────────────────
      console.log(`  ⏱️  Timeout (${ageHrs.toFixed(1)}h ≥ ${DIP_LIMIT_TIMEOUT}h) — cancelling unfilled limit`);
      if (!CONFIG.paperTrading) {
        const cancelled = await cancelSpotOrder(pos.symbol, pos.limitOrderId, cat);
        console.log(`  🧹 Cancel ${cancelled ? "✅ done" : "⚠️ failed (may already be gone)"}`);
      }
      pos.status = "cancelled_limit";
      await tg(`⏱️ <b>Dip-Buyer limit expired — ${pos.symbol}</b>\nLimit @ $${pos.limitPrice.toFixed(4)} not filled after ${DIP_LIMIT_TIMEOUT}h — cancelled.\nWaiting for next signal. 🔄`);

    } else {
      const remaining = DIP_LIMIT_TIMEOUT - ageHrs;
      console.log(`  ⏳ Still pending — ${remaining.toFixed(1)}h remaining before timeout`);
    }
  }
  savePositions(positions);
}

async function processDipBuyer(asset, log) {
  console.log(`\n─── ${asset.symbol} [dip_buyer] ─────────────────────`);
  const candles = await fetchCandles(asset.okx, "1H", 250);   // need 200+ bars for SMA200
  const price   = candles[candles.length - 1].close;
  const result  = checkStratDipBuyer(candles);
  const ind     = result.indicators || {};
  if (ind.rsi2 !== undefined)
    console.log(`  Price: $${price.toFixed(4)} [1H] | SMA200=$${ind.sma200?.toFixed(2)} SMA50=$${ind.sma50?.toFixed(2)} RSI2=${ind.rsi2?.toFixed(1)}`);

  if (!result.signal) { console.log(`  ⏸  No signal — ${result.reason}`); return false; }

  // ── V8 filter: BTC daily macro gate ──────────────────────────────────────
  if (V8_BTC_MACRO_GATE && _btcDailyBull !== null) {
    if (result.side === "long"  && !_btcDailyBull) { console.log(`  🔴 V8 BLOCKED — BTC below daily SMA200 (bear market), no longs`); return false; }
    if (result.side === "short" &&  _btcDailyBull) { console.log(`  🟢 V8 BLOCKED — BTC above daily SMA200 (bull market), no shorts`); return false; }
  }

  // ── V8 filter: ATR ratio — skip high-volatility candles ──────────────────
  if (V8_ATR_FILTER) {
    const closes250 = candles.map(c => c.close);
    const highs250  = candles.map(c => c.high);
    const lows250   = candles.map(c => c.low);
    const trs = candles.map((c, i) => i === 0 ? c.high - c.low :
      Math.max(c.high - c.low, Math.abs(c.high - closes250[i-1]), Math.abs(c.low - closes250[i-1])));
    // ATR14 (Wilder's smoothing)
    const atr14arr = new Array(candles.length).fill(null);
    let atrVal = trs.slice(1, 15).reduce((s, v) => s + v, 0) / 14;
    atr14arr[14] = atrVal;
    for (let i = 15; i < candles.length; i++) { atrVal = (atrVal * 13 + trs[i]) / 14; atr14arr[i] = atrVal; }
    // SMA50 of ATR14
    let atrSum = 0, atrCount = 0;
    for (let i = 0; i < candles.length; i++) {
      if (atr14arr[i] === null) continue;
      atrSum += atr14arr[i]; atrCount++;
      if (atrCount > 50) atrSum -= atr14arr[i - 50];
    }
    const lastAtr  = atr14arr[atr14arr.length - 1];
    const atrAvg50 = atrCount >= 50 ? atrSum / 50 : null;
    const atrRatio = lastAtr && atrAvg50 ? lastAtr / atrAvg50 : null;
    if (atrRatio !== null && atrRatio > 1.5) {
      console.log(`  ⚡ V8 BLOCKED — ATR ratio ${atrRatio.toFixed(2)} > 1.5 (high volatility — skip)`);
      return false;
    }
    if (atrRatio !== null) console.log(`  ✅ V8 ATR ratio: ${atrRatio.toFixed(2)} (< 1.5 — OK)`);
  }

  // signal = "buy" (long dip) or "sell" (short spike)
  const isShort   = result.side === "short";
  const dirLabel  = isShort ? "SHORT" : "BUY";
  const dirEmoji  = isShort ? "🔴" : "🟢";
  console.log(`  🎯 SIGNAL: ${dirLabel} — ${result.reason}`);

  // Block if same-side position/pending already open (allow long+short simultaneously)
  const allPos = loadPositions();
  const sameOpenPos = allPos.some(
    (p) => p.symbol === asset.symbol && p.status === "open" && (p.side || "long") === result.side && p.strategy === "dip_buyer"
  );
  const samePending = allPos.some(
    (p) => p.symbol === asset.symbol && p.status === "pending_limit" && (p.side || "long") === result.side
  );
  if (sameOpenPos) {
    console.log(`  🔒 BLOCKED — ${asset.symbol} already has an open ${dirLabel} position.`);
    return false;
  }
  if (samePending) {
    console.log(`  ⏳ BLOCKED — already have a pending ${dirLabel} limit order for ${asset.symbol}. Waiting for fill.`);
    return false;
  }

  // ── V2: Max concurrent positions cap ────────────────────────────────────
  const totalOpen = allPos.filter((p) => (p.status === "open" || p.status === "pending_limit") && p.strategy === "dip_buyer").length;
  if (DIP_V2_ENABLED && totalOpen >= DIP_V2_MAX_CONCURRENT) {
    console.log(`  🚦 BLOCKED — ${totalOpen}/${DIP_V2_MAX_CONCURRENT} concurrent positions open. Waiting for exit.`);
    return false;
  }

  const tradeSize = getTradeSize();
  const stopPrice = result.stopPrice;
  const tpPrice   = result.tpPrice || null;
  const dp  = PRICE_DECIMALS[asset.symbol] ?? 2;
  const lev = DIP_BUYER_LEVERAGE;
  const isFutures = DIP_BUYER_MODE === "linear";
  const notional  = tradeSize * lev;

  // ── V2: Entry at candle LOW (long) or HIGH (short) — exact structure level
  // ── V1: Entry offset 0.15% from close
  const limitPrice = result.limitPrice !== null && result.limitPrice !== undefined
    ? result.limitPrice                              // V2: candle low/high
    : isShort
      ? price * (1 + DIP_LIMIT_OFFSET / 100)        // V1 short: above close
      : price * (1 - DIP_LIMIT_OFFSET / 100);       // V1 long: below close
  const risk      = Math.abs(limitPrice - stopPrice);
  const modeTag   = isFutures ? ` [${lev}× futures, notional $${notional.toFixed(0)}]` : " [spot]";
  const entryDesc = DIP_V2_ENABLED
    ? (isShort ? `candle HIGH $${limitPrice.toFixed(dp)}` : `candle LOW $${limitPrice.toFixed(dp)}`)
    : (isShort ? `close+${DIP_LIMIT_OFFSET}% $${limitPrice.toFixed(dp)}` : `close−${DIP_LIMIT_OFFSET}% $${limitPrice.toFixed(dp)}`);
  console.log(`  📐 V2 Entry: ${entryDesc}${modeTag} | SL $${stopPrice.toFixed(dp)} | TP $${tpPrice?.toFixed(dp) ?? "n/a"} (3:1) | timeout ${DIP_LIMIT_TIMEOUT}h`);

  if (CONFIG.paperTrading) {
    const paperMode = isFutures ? `PAPER-LINEAR-${lev}X-${dirLabel}-V2` : "PAPER-LIMIT-V2";
    console.log(`  📋 PAPER V2: ${dirLabel} ${asset.symbol} @ $${limitPrice.toFixed(dp)} | SL $${stopPrice.toFixed(dp)} | TP $${tpPrice?.toFixed(dp) ?? "n/a"} | risk $${risk.toFixed(dp)}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: "dip_buyer_v2", side: isShort ? "sell" : "buy", price: limitPrice, tradeSize, mode: paperMode, signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: isShort ? "sell" : "buy", price: limitPrice, orderPlaced: true, paper: true, strategy: "dip_buyer_v2", direction: result.side, entry: true });
    openDipBuyerPosition(asset.symbol, limitPrice, tradeSize, null, stopPrice, null, DIP_BUYER_MODE, lev, result.side, tpPrice);
    const riskUsd = (risk / limitPrice) * notional;
    await tg(
`📋 ${dirEmoji} <b>Dip-Buyer V2 ${dirLabel} [PAPER] — ${asset.symbol}</b>
📍 Entry: <b>$${limitPrice.toFixed(dp)}</b> (candle ${isShort ? "HIGH" : "LOW"})
🛑 Stop:  $${stopPrice.toFixed(dp)} (${(DIP_V2_STOP_BUFFER*100).toFixed(1)}% buffer)
🎯 TP:    $${tpPrice?.toFixed(dp) ?? "n/a"} (3:1 RR)
💰 Risk:  $${riskUsd.toFixed(2)} | Margin $${tradeSize} | ${lev}× leverage
🕐 ${uaeTime()}`
    );
    return true;
  }

  try {
    let order;
    if (isFutures) {
      await setBybitLeverage(asset.symbol, lev);
      console.log(`  ⚙️  Leverage set to ${lev}×`);
      if (isShort) {
        order = await placeLimitSellLinear(asset.symbol, tradeSize, lev, limitPrice, stopPrice, tpPrice);
        console.log(`  ⏳ FUTURES SHORT V2 LIMIT: ${asset.symbol} @ $${limitPrice.toFixed(dp)} | SL $${stopPrice.toFixed(dp)} | TP $${tpPrice?.toFixed(dp)} | ID: ${order.orderId}`);
      } else {
        order = await placeLimitBuyLinear(asset.symbol, tradeSize, lev, limitPrice, stopPrice, tpPrice);
        console.log(`  ⏳ FUTURES LONG V2 LIMIT: ${asset.symbol} @ $${limitPrice.toFixed(dp)} | SL $${stopPrice.toFixed(dp)} | TP $${tpPrice?.toFixed(dp)} | ID: ${order.orderId}`);
      }
    } else {
      order = await placeLimitBuySpot(asset.symbol, tradeSize, limitPrice);
      console.log(`  ⏳ SPOT LONG LIMIT: BUY ${asset.symbol} @ $${limitPrice.toFixed(dp)} | ID: ${order.orderId}`);
    }

    const csvMode = isFutures ? `LIVE-LINEAR-LIMIT-${lev}X-${dirLabel}-V2-PENDING` : "LIVE-SPOT-LIMIT-V2-PENDING";
    writeTradeCsv({ symbol: asset.symbol, strategy: "dip_buyer_v2", side: isShort ? "sell" : "buy", price: limitPrice, tradeSize, orderId: order.orderId, mode: csvMode, signal: `${result.reason} | SL=${stopPrice.toFixed(dp)} TP=${tpPrice?.toFixed(dp)}` });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: isShort ? "sell" : "buy", price: limitPrice, orderPlaced: true, orderId: order.orderId, strategy: "dip_buyer_v2", pending: true, mode: DIP_BUYER_MODE, direction: result.side, entry: true });
    recordDipBuyerPendingLimit(asset.symbol, price, limitPrice, tradeSize, order.orderId, stopPrice, DIP_BUYER_MODE, lev, result.side, tpPrice);

    const riskUsd = (risk / limitPrice) * notional;
    await tg(
`⏳ ${dirEmoji} <b>Dip-Buyer V2 ${dirLabel} PLACED — ${asset.symbol}</b>
📍 Entry: <b>$${limitPrice.toFixed(dp)}</b> (candle ${isShort ? "HIGH" : "LOW"})
🛑 Stop:  $${stopPrice.toFixed(dp)} (0.3% buffer) ← exchange-native
🎯 TP:    $${tpPrice?.toFixed(dp) ?? "n/a"} (3:1 RR) ← exchange-native
💰 Risk:  $${riskUsd.toFixed(2)} | Margin $${tradeSize} | Notional $${notional.toFixed(0)}
⚡ Both SL+TP on exchange — protected even if bot offline
🕐 ${uaeTime()}`
    );
    return true;
  } catch (err) {
    console.log(`  ❌ V2 ${dirLabel} order failed: ${err.message}`);
    return false;
  }
}

// Query Bybit for actual open positions on all linear symbols.
// Returns a Set of symbols that still have a non-zero position on Bybit.
async function getBybitOpenSymbols() {
  try {
    const timestamp = Date.now().toString();
    const params    = "category=linear&settleCoin=USDT";
    const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/list?${params}`, {
      headers: {
        "X-BAPI-API-KEY":    CONFIG.bybit.apiKey,
        "X-BAPI-SIGN":       signBybit(timestamp, params),
        "X-BAPI-TIMESTAMP":  timestamp,
        "X-BAPI-RECV-WINDOW":"5000",
      },
    });
    const data = await res.json();
    if (data.retCode !== 0) return null;
    // Return symbols where size > 0 (actually open position on exchange)
    const open = new Set(
      (data.result?.list || [])
        .filter(p => parseFloat(p.size) > 0)
        .map(p => p.symbol)
    );
    return open;
  } catch { return null; }
}

async function checkDipBuyerPositions(log) {
  const positions = loadPositions();
  const open = positions.filter((p) => p.status === "open" && p.strategy === "dip_buyer");
  if (!open.length) return;

  console.log(`\n─── Dip-Buyer Exit Manager (${open.length} open) ─────────────`);

  // BUG FIX: Sync with Bybit to detect positions closed by exchange-native SL/TP.
  // If the exchange fired SL or TP while the bot was offline/between scans, positions.json
  // would show "open" forever → permanently blocking new entries via concurrent limit.
  const bybitOpen = await getBybitOpenSymbols();
  if (bybitOpen !== null) {
    for (const pos of open) {
      if (pos.mode !== "linear") continue;  // only futures can have native SL/TP
      if (!bybitOpen.has(pos.symbol)) {
        // Position closed on exchange but still "open" in our records — mark it closed.
        console.log(`  ⚠️  ${pos.symbol} [${pos.side}]: NOT found on Bybit (exchange SL/TP fired) — marking closed`);
        pos.status      = "closed";
        pos.closeReason = "exchange_sl_tp";
        pos.closeTime   = new Date().toISOString();
        pos.closePrice  = pos.dipTp ?? pos.dipStop ?? pos.entry;  // best guess
        // Rough P&L estimate (actual was handled by exchange)
        const pnlGuess = pos.side === "short"
          ? (pos.entry - (pos.closePrice)) / pos.entry * (pos.size * (pos.leverage || 1))
          : ((pos.closePrice) - pos.entry) / pos.entry * (pos.size * (pos.leverage || 1));
        pos.pnl = pnlGuess;
        log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: pos.side, price: pos.closePrice, orderPlaced: false, reason: "exchange_sl_tp_detected" });
        await tg(
`🔄 <b>Position reconciled — ${pos.symbol}</b>
Exchange closed this position via native SL/TP while bot was between scans.
📍 Entry:  $${pos.entry}
📤 Close:  $${pos.closePrice?.toFixed(4)} (estimated)
📋 Side:   ${pos.side?.toUpperCase()} | ${pos.mode}
✅ Record updated — slot freed for new entries.
🕐 ${uaeTime()}`
        );
      }
    }
    savePositions(positions);
  }
  for (const pos of open) {
    const okxSymbol = pos.symbol.replace("USDT", "-USDT");
    let candles;
    try { candles = await fetchCandles(okxSymbol, "1H", 30); }
    catch (e) { console.log(`  ⚠️  ${pos.symbol} fetch failed: ${e.message}`); continue; }

    const closes = candles.map((c) => c.close);
    const price  = closes[closes.length - 1];
    const sma5   = calcSMA(closes, 5);
    const ageHrs = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
    const stop   = pos.dipStop;

    const posSide  = pos.side || "long";    // "long" or "short" (default long for legacy positions)
    const posMode  = pos.mode || "spot";    // "spot" or "linear"
    const posLev   = pos.leverage || 1;
    const notional = pos.size * posLev;    // actual $ exposure
    const pct = ((price - pos.entry) / pos.entry) * 100;
    const dipTp = pos.dipTp || null;   // V2: exchange-native TP level (null for V1 positions)
    let exitReason = null;
    const isV2 = dipTp != null;  // V2 positions always have an exchange-native TP set
    if (posSide === "long") {
      // LONG exits (priority order):
      if (stop != null && price <= stop)            exitReason = "stop_loss";
      else if (dipTp != null && price >= dipTp)     exitReason = "tp3x";           // V2: 3:1 TP hit
      // BUG FIX: SMA5 exit only applies to V1 positions (no dipTp). V2 enters at
      // candle LOW; the close is already above SMA5, so this exit fires immediately
      // and wrongly — closing positions at a loss right after entry (NEAR -$68 case).
      else if (!isV2 && sma5 != null && price > sma5)  exitReason = "recovery_sma5";  // V1 fallback only
      else if (ageHrs >= (pos.maxHoldHrs || 24))    exitReason = "max_hold";
    } else {
      // SHORT exits (priority order):
      if (stop != null && price >= stop)            exitReason = "stop_loss";
      else if (dipTp != null && price <= dipTp)     exitReason = "tp3x";           // V2: 3:1 TP hit
      else if (!isV2 && sma5 != null && price < sma5)  exitReason = "recovery_sma5";  // V1 fallback only
      else if (ageHrs >= (pos.maxHoldHrs || 24))    exitReason = "max_hold";
    }
    const tpLabel = dipTp ? ` TP=$${dipTp.toFixed(4)}` : "";
    console.log(`  ${pos.symbol} [${posSide}]: entry=$${pos.entry} now=$${price.toFixed(4)} P&L=${pct.toFixed(2)}% | SMA5=$${sma5?.toFixed(4)} stop=$${stop?.toFixed(4)}${tpLabel} age=${ageHrs.toFixed(1)}h${exitReason ? ` → ${exitReason}` : ""}`);
    if (!exitReason) continue;

    let closeConfirmed = CONFIG.paperTrading;

    if (!CONFIG.paperTrading) {
      if (posMode === "linear") {
        // ── Futures exit: reduceOnly market order (opposite side) ───────────
        const closeSide = posSide === "short" ? "buy" : "sell";  // buy to close short, sell to close long
        try {
          await placeBybitOrder(pos.symbol, closeSide, notional, price, "linear", null, true);
          console.log(`  ✅ Dip-Buyer FUTURES ${closeSide.toUpperCase()} (close ${posSide}) — $${notional.toFixed(0)} notional of ${pos.symbol} (${exitReason})`);
          closeConfirmed = true;
        } catch (e) {
          console.log(`  ❌ Futures close FAILED (${e.message.slice(0,60)}) — keeping OPEN to retry`);
          closeConfirmed = false;
        }
      } else {
        // ── Spot exit: only LONG is possible in spot ────────────────────────
        if (pos.slOrderId) {
          const c = await cancelSpotConditional(pos.symbol, pos.slOrderId);
          console.log(`  🧹 Stop-loss order ${c ? "cancelled" : "already gone/triggered"}`);
        }
        await new Promise((r) => setTimeout(r, 500));
        const coin = pos.symbol.replace("USDT", "");
        const held = await getSpotBalance(coin);
        const expectedQty = pos.size / pos.entry;
        if (held === null) { console.log(`  ⚠️  Could not read ${coin} balance — keeping OPEN, retry next run`); continue; }
        if (held < expectedQty * 0.02) {
          console.log(`  ⚠️  ${coin} balance ~0 (${held.toFixed(4)}) — already exited server-side, marking closed`);
          closeConfirmed = true;
        } else {
          try {
            await sellSpotHolding(pos.symbol, held);
            console.log(`  ✅ Dip-Buyer SPOT SELL — sold ${held.toFixed(4)} ${coin} (${exitReason})`);
            closeConfirmed = true;
          } catch (e) {
            console.log(`  ❌ Sell FAILED (${e.message.slice(0,55)}) — ${coin} ${held.toFixed(4)} still held. Keeping OPEN to retry.`);
            closeConfirmed = false;
          }
        }
      }
    }
    if (!closeConfirmed) continue;

    // Fee accounting: entry always limit (maker 0.02%), exit always market
    const entryFeeRate = posMode === "linear" ? FEE_FUT_MAKER : FEE_SPOT_MAKER;
    const exitFeeRate  = posMode === "linear" ? FEE_FUT_TAKER : FEE_SPOT_TAKER;
    const feesUSD  = notional * (entryFeeRate + exitFeeRate);
    // Gross P&L: long = (exit−entry)/entry × notional; short = (entry−exit)/entry × notional
    const grossPnl = posSide === "short"
      ? (pos.entry - price) / pos.entry * notional
      : (price - pos.entry) / pos.entry * notional;
    const pnlUSD   = grossPnl - feesUSD;
    const feeDesc  = posMode === "linear"
      ? `entry 0.02% + exit 0.055% on $${notional.toFixed(0)} notional`
      : `entry 0.02% + exit 0.10% on $${pos.size.toFixed(0)}`;
    console.log(`  💸 Fees -$${feesUSD.toFixed(2)} (${feeDesc}) | Gross $${grossPnl.toFixed(2)} | Net P&L $${pnlUSD.toFixed(2)} (${exitReason})`);

    const closeCsvSide = posSide === "short" ? "buy" : "sell";   // buy to close short
    const csvMode      = CONFIG.paperTrading ? "PAPER" : (posMode === "linear" ? `LIVE-LINEAR-${posLev}X` : "LIVE-SPOT");
    writeTradeCsv({ symbol: pos.symbol, strategy: "dip_buyer", side: closeCsvSide, price, tradeSize: pos.size, mode: csvMode, signal: `EXIT_${posSide.toUpperCase()}_${exitReason} pnl=$${pnlUSD.toFixed(2)}` });
    pos.status = "closed"; pos.closeReason = exitReason; pos.closePrice = price; pos.closeTime = new Date().toISOString(); pos.pnl = pnlUSD;
    log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: closeCsvSide, price, orderPlaced: true, reason: exitReason, direction: posSide });
    const exitEmoji   = { stop_loss: "🛑", recovery_sma5: "✅", max_hold: "⏱️" };
    const dirEmoji    = posSide === "short" ? "🔴" : "🟢";
    const modeLine    = posMode === "linear" ? `\n📈 ${posLev}× Futures | Notional $${notional.toFixed(0)}` : "";
    await tg(`${exitEmoji[exitReason]||"🔔"} <b>Dip-Buyer ${posSide.toUpperCase()} EXIT — ${pos.symbol}</b>\n${dirEmoji} Entry: $${pos.entry}\n📤 Exit:  $${price.toFixed(4)}${modeLine}\n💵 P&L:  ${pnlUSD>=0?"+":""}$${pnlUSD.toFixed(2)}\n📋 ${exitReason}\n🕐 ${uaeTime()}`);
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
  console.log(`  ${uaeTime()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  const tradeSize = getTradeSize();
  const sizeLabel = CONFIG.tradeSizePct > 0
    ? `${CONFIG.tradeSizePct}% of $${CONFIG.portfolioUSD} = $${tradeSize}`
    : `$${tradeSize} fixed`;
  console.log(`  Timeframe: ${CONFIG.timeframe} | Trade size: ${sizeLabel}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Daily trade limit check (set MAX_TRADES_PER_DAY=0 in .env to disable)
  const log = loadLog();
  const todayCount = countTodaysTrades(log);
  const limitDisabled = CONFIG.maxTradesPerDay === 0;
  console.log(`\n  Trades today: ${todayCount}${limitDisabled ? " (no limit)" : "/"+CONFIG.maxTradesPerDay}`);
  const dailyLimitReached = !limitDisabled && todayCount >= CONFIG.maxTradesPerDay;
  if (dailyLimitReached) {
    console.log("  🚫 Daily limit reached — no new entries. Checking open positions...");
  }

  // ── #6 Max drawdown protection — percentage-based, scales with portfolio ────
  // Default: 3% of portfolio. On $500 = $15. On $2000 = $60. Always proportional.
  // Override with MAX_DAILY_LOSS_PCT env var (e.g. "5" = 5%).
  // Why 3%: worst case is 5 trades × 1.5% SL × 10% size = $3.75 on $500.
  // 3% ($15) = 4× the realistic max, only fires on bugs or extreme conditions.
  const MAX_DAILY_LOSS_PCT = parseFloat(process.env.MAX_DAILY_LOSS_PCT || "3");
  const MAX_DAILY_LOSS_USD = CONFIG.portfolioUSD * (MAX_DAILY_LOSS_PCT / 100);
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = loadPositions().filter(p =>
    p.status === "closed" && p.closeTime?.startsWith(today) && p.pnl != null
  );
  const dailyPnl = closedToday.reduce((s, p) => s + p.pnl, 0);
  if (dailyPnl <= -MAX_DAILY_LOSS_USD) {
    console.log(`  🛑 MAX DRAWDOWN HIT — daily P&L $${dailyPnl.toFixed(2)} ≤ -$${MAX_DAILY_LOSS_USD.toFixed(2)} (${MAX_DAILY_LOSS_PCT}% of $${CONFIG.portfolioUSD}). No new trades today.`);
    await tg(
`🛑 <b>MAX DRAWDOWN — Bot paused for today</b>
Daily loss: $${Math.abs(dailyPnl).toFixed(2)} (limit: ${MAX_DAILY_LOSS_PCT}% = $${MAX_DAILY_LOSS_USD.toFixed(2)})
No new trades will be placed today.
Bot resumes automatically tomorrow. 🔄`
    );
    return;
  }
  console.log(`  💰 Daily P&L: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} | Drawdown limit: -$${MAX_DAILY_LOSS_USD.toFixed(2)} (${MAX_DAILY_LOSS_PCT}% of $${CONFIG.portfolioUSD})`);

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
      const loadedAssets = [];
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
            loadedAssets.push(`${asset.symbol} (RSI ${rsi?.toFixed(1)})`);
          }
        } catch (_) {}
      }
      if (loadedAssets.length) await tgRegimeAlert(btcRsi, loadedAssets);
    } else {
      console.log(`\n  📊 BTC RSI: ${btcRsi?.toFixed(1)} — market neutral/bearish, Hermes conditions normal`);
    }
  } catch (e) {
    console.log(`  ⚠️  BTC regime check failed: ${e.message}`);
  }

  // ── V8: BTC daily macro gate — fetch once per run ────────────────────────
  if (V8_BTC_MACRO_GATE) {
    try {
      const btcDaily  = await fetchCandles("BTC-USDT", "1D", 210);
      const dc        = btcDaily.map(c => c.close);
      const dSma200   = calcSMA(dc, 200);
      const dLast     = dc[dc.length - 1];
      _btcDailyBull   = dSma200 !== null && dLast > dSma200;
      console.log(`\n  📊 V8 BTC Daily: $${dLast.toFixed(0)} vs SMA200=$${dSma200?.toFixed(0)} → ${_btcDailyBull ? "🟢 BULL — longs allowed" : "🔴 BEAR — longs blocked"}`);
    } catch (e) {
      console.log(`  ⚠️  V8 BTC daily fetch failed: ${e.message} — macro gate skipped`);
      _btcDailyBull = null;
    }
  }

  // ── Step 1a: Check open Hermes positions (perpetual TP/SL exits) ─────────
  await checkHermesPositions(log);

  // ── Step 1b: Check open VWAP positions (spot RSI exit + SL + expiry) ─────
  await checkVwapPositions(log);

  // ── Step 1c: Check pending dip-buyer limit orders (filled? timeout?) ──────
  await checkDipBuyerPendingOrders(log);

  // ── Step 1d: Check open Dip-Buyer positions (close>SMA5 / stop / 24h) ────
  await checkDipBuyerPositions(log);

  // ── Step 2: Scan each asset for new entries (skipped if daily limit hit) ────
  if (dailyLimitReached) {
    console.log("\n  ⏭️  Skipping new entry scan — daily limit reached.");
  }
  let tradesThisRun = 0;
  for (const asset of dailyLimitReached ? [] : WATCHLIST) {
    if (!limitDisabled && todayCount + tradesThisRun >= CONFIG.maxTradesPerDay) {
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
    // Small inter-asset delay to avoid OKX rate limiting (prevents "insufficient data")
    await new Promise(r => setTimeout(r, 300));
  }

  saveLog(log);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Scan complete — ${tradesThisRun} signal(s) fired this run`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── #5 Heartbeat: send "bot alive" once per day at first run after 09:00 UTC
  await sendHeartbeatIfDue(log);

  // ── #4 Daily summary: send P&L recap once per day at first run after 09:00 UTC
  await sendDailySummaryIfDue(log);
}

// ─── #4 Daily P&L Summary ────────────────────────────────────────────────────
async function sendDailySummaryIfDue(log) {
  const now   = new Date();
  const uaeHour = (now.getUTCHours() + 4) % 24; // UAE = UTC+4
  if (uaeHour < 9) return; // only after 09:00 UAE

  const today = now.toISOString().slice(0, 10);
  const alreadySent = log.trades.some(t => t.dailySummarySent === today);
  if (alreadySent) return;

  // Gather today's closed trades from CSV
  const closedToday = (log.trades || []).filter(t =>
    t.timestamp?.startsWith(today) && t.orderPlaced
  );
  const openPositions = loadPositions().filter(p => p.status === "open");

  // Compute P&L from positions closed today
  const closedPositions = loadPositions().filter(p =>
    p.status === "closed" && p.closeTime?.startsWith(today) && p.pnl != null
  );
  const totalPnl = closedPositions.reduce((s, p) => s + p.pnl, 0);
  const wins     = closedPositions.filter(p => p.pnl > 0).length;
  const losses   = closedPositions.filter(p => p.pnl <= 0).length;
  const wr       = closedPositions.length > 0 ? (wins / closedPositions.length * 100).toFixed(0) : "—";
  const pnlStr   = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  const pnlEmoji = totalPnl >= 0 ? "💚" : "🔴";

  await tg(
`📊 <b>Daily Summary — ${uaeTime(now)}</b>
${pnlEmoji} P&L:         <b>${pnlStr}</b>
🎯 Trades:      ${closedPositions.length} closed (${wins}W / ${losses}L)
📈 Win rate:    ${wr}%
📂 Open now:   ${openPositions.length} position(s)
💰 Portfolio:  $${CONFIG.portfolioUSD}
🤖 Bot:        Running ✅`
  );

  // Mark as sent
  log.trades.push({ timestamp: now.toISOString(), dailySummarySent: today, orderPlaced: false });
  saveLog(log);
}

// ─── #5 Heartbeat + Gap Detector ─────────────────────────────────────────────
// Two jobs:
//   A) Gap alert  — if the bot restarts after a long silence, immediately alert.
//      Catches crashes / deploy failures / Railway restarts that left a gap.
//   B) Daily ping — once per day after 09:00 UAE, send "✅ bot alive" to Telegram.
//      If the user doesn't receive this, the bot is down.
async function sendHeartbeatIfDue(log) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);   // UTC date key for dedup logic
  // UAE-formatted date for display (e.g. "13 Jun 2026")
  const uaeDate = now.toLocaleDateString("en-GB", {
    timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric"
  });

  // ── A) Gap detection — fire whenever we restart after >2h of silence ────────
  const GAP_ALERT_HRS = 2;
  const lastRunEntry  = [...log.trades].reverse().find(t => t.botRun);
  const lastRunTime   = lastRunEntry ? new Date(lastRunEntry.timestamp) : null;
  const gapHrs        = lastRunTime ? (now - lastRunTime) / 3600000 : 0;

  if (lastRunTime && gapHrs >= GAP_ALERT_HRS) {
    const gapStr = gapHrs < 24
      ? `${gapHrs.toFixed(1)} hours`
      : `${(gapHrs / 24).toFixed(1)} days`;
    console.log(`  ⚠️  Bot was offline for ${gapStr} (last run: ${uaeTime(lastRunTime)})`);
    await tg(
`⚠️ <b>Bot gap detected — ${gapStr} offline</b>
Last run: ${uaeTime(lastRunTime)}
Now: ${uaeTime()}
Bot is back online and scanning. ✅
If this gap was unintentional, check Railway logs.`
    );
  }

  // Record this run so next invocation can measure the gap
  log.trades.push({ timestamp: now.toISOString(), botRun: true, orderPlaced: false });
  saveLog(log);   // ← persist heartbeat on EVERY scan so gap detector always has fresh data

  // ── B) Daily "alive" ping — once per day after 09:00 UAE ────────────────────
  const uaeHour    = (now.getUTCHours() + 4) % 24;
  if (uaeHour < 9) return;                                      // too early
  const alreadySent = log.trades.some(t => t.heartbeatSent === today);
  if (alreadySent) return;                                       // already sent today

  // Gather open position summary for the ping
  const openPos = loadPositions().filter(p => p.status === "open" || p.status === "pending_limit");
  const posLines = openPos.length
    ? openPos.map(p => {
        if (p.status === "pending_limit") return `  ⏳ ${p.symbol} limit @ $${p.limitPrice?.toFixed(4)} (pending)`;
        const pct = p.entry ? ((0) / p.entry * 100).toFixed(2) : "?";  // price not fetched here
        return `  📌 ${p.symbol} @ $${p.entry} [${p.strategy}]`;
      }).join("\n")
    : "  None";

  const todayTrades = log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced);
  const closedToday = loadPositions().filter(p => p.status === "closed" && p.closeTime?.startsWith(today));
  const dailyPnl    = closedToday.reduce((s, p) => s + (p.pnl ?? 0), 0);

  await tg(
`✅ <b>Bot Heartbeat — ${uaeDate}</b>
🕐 ${uaeTime()}
📊 Mode: LIVE | $${CONFIG.portfolioUSD.toLocaleString()} account
💰 Today's P&L: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}
📈 Trades today: ${todayTrades.length}
🔍 Watching: ${WATCHLIST.map(w => w.symbol.replace("USDT","")).join(" · ")}
📌 Open positions:
${posLines}
🤖 Scanning every minute. Next ping ~09:00 UAE tomorrow.`
  );

  log.trades.push({ timestamp: now.toISOString(), heartbeatSent: today, orderPlaced: false });
  saveLog(log);
  console.log(`  💓 Daily heartbeat sent to Telegram`);
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
