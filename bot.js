/**
 * Claude Trading Bot — Multi-Asset, Dual Strategy
 *
 * Watchlist & strategy assignment (backtest v04 — 5m 30d):
 *   NEAR  → VWAP primary + Hermes dual [Hermes 95.5% WR ← best asset]
 *   SOL   → VWAP primary + Hermes dual [Hermes 83.1% WR, 59 trades]
 *   ETH   → Hermes v04               [85.7% WR]
 *   BTC   → VWAP + RSI(3) + EMA(8)   [Hermes WR dropped to 43.9% — paused]
 *
 * Improvements (v04):
 *   - Hermes positions tracked in positions.json
 *   - Partial TP: 50% exit at 1.5%, SL moves to breakeven, rest runs to 3.0%
 *   - NEAR also scanned for Hermes setups (confirmed live signal 2026-06-11)
 *
 * Data: OKX public API | Execution: Bybit Demo
 * Runs every 5 minutes on Railway cron
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe:      process.env.TIMEFRAME       || "5m",
  maxTradeSizeUSD:parseFloat(process.env.MAX_TRADE_SIZE_USD  || "50"),
  maxTradesPerDay:parseInt(process.env.MAX_TRADES_PER_DAY    || "5"),
  paperTrading:   process.env.PAPER_TRADING   !== "false",
  tradeMode:      process.env.TRADE_MODE      || "spot",
  bybit: {
    apiKey:    process.env.BYBIT_API_KEY,
    secretKey: process.env.BYBIT_SECRET_KEY,
    baseUrl:   process.env.BYBIT_BASE_URL || "https://api.bybit.com",
  },
};

// Watchlist — updated from backtest_hermes_v04 results (2026-06-11)
// BTC Hermes WR fell to 43.9% in recent 30d → switched to VWAP
// SOL added to Hermes dual-scan (83.1% WR, most signals of any asset)
const WATCHLIST = [
  { symbol: "NEARUSDT", okx: "NEAR-USDT", strategy: "vwap_rsi3_ema8", hermesAlso: true  },
  { symbol: "SOLUSDT",  okx: "SOL-USDT",  strategy: "vwap_rsi3_ema8", hermesAlso: true  },
  { symbol: "ETHUSDT",  okx: "ETH-USDT",  strategy: "hermes_v03"                        },
  { symbol: "BTCUSDT",  okx: "BTC-USDT",  strategy: "vwap_rsi3_ema8"                    },
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

// ─── Strategy B: Hermes v03 — RSI Rejection in Downtrend ─────────────────────
// Best for: BTC (84.4% WR), ETH (100% WR)

function checkStratHermes(candles) {
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

  // RSI spike check: was RSI > 55 in last 5 bars?
  const rsiWindow = [];
  for (let j = Math.max(0, candles.length - 5); j < candles.length; j++) {
    const r = calcRSI(closes.slice(0, j + 1), 14);
    if (r) rsiWindow.push(r);
  }
  const recentlyAbove55 = rsiWindow.some((r) => r > 55);
  const crossesBelow52  = rsiPrev >= 52 && rsi < 52;
  const notOversold     = rsi > 38;

  if (recentlyAbove55 && crossesBelow52 && notOversold) {
    return {
      signal: "sell", side: "sell",
      reason: `HERMES SHORT — bear stack ✅, RSI spiked>55 ✅, crossed below 52 ✅, RSI=${rsi.toFixed(1)}>38 ✅`,
      indicators: { price, ema9, ema21, ema50, rsi },
    };
  }

  return {
    signal: null,
    reason: `bear stack ✅ — waiting: RSI=${rsi.toFixed(1)} spike=${recentlyAbove55} cross52=${crossesBelow52} floor=${notOversold}`,
    indicators: { price, ema9, ema21, ema50, rsi },
  };
}

// ─── Bybit Execution ──────────────────────────────────────────────────────────

function signBybit(timestamp, body) {
  return crypto.createHmac("sha256", CONFIG.bybit.secretKey)
    .update(`${timestamp}5000${body}`).digest("hex");
}

async function placeBybitOrder(symbol, side, sizeUSD, price) {
  const quantity  = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const body = JSON.stringify({
    category:  "spot",
    symbol,
    side:      side === "buy" ? "Buy" : "Sell",
    orderType: "Market",
    qty:       quantity,
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

function openHermesPosition(symbol, entry, tradeSize, orderId) {
  const positions = loadPositions();
  // Remove any existing open position for this symbol
  const filtered = positions.filter((p) => p.symbol !== symbol || p.status !== "open");
  filtered.push({
    symbol,
    side:      "short",
    entry,
    tp1:       +(entry * (1 - 0.015)).toFixed(6),   // -1.5% partial exit
    tp2:       +(entry * (1 - 0.030)).toFixed(6),   // -3.0% full exit
    sl:        +(entry * (1 + 0.015)).toFixed(6),   // +1.5% stop loss
    slBE:      null,                                 // breakeven SL after TP1 hit
    size:      tradeSize,
    tp1Hit:    false,
    status:    "open",
    openTime:  new Date().toISOString(),
    orderId:   orderId || null,
  });
  savePositions(filtered);
  console.log(`  📌 Position opened: SHORT ${symbol} @ $${entry} | TP1=$${+(entry*(1-0.015)).toFixed(4)} TP2=$${+(entry*(1-0.030)).toFixed(4)} SL=$${+(entry*(1+0.015)).toFixed(4)}`);
}

async function checkHermesPositions(log) {
  const positions = loadPositions();
  const open = positions.filter((p) => p.status === "open");
  if (!open.length) return;

  console.log(`\n─── Hermes Position Manager (${open.length} open) ──────────────`);

  for (const pos of open) {
    // Fetch current price
    const okxSymbol = pos.symbol.replace("USDT", "-USDT");
    let price;
    try {
      const candles = await fetchCandles(okxSymbol, CONFIG.timeframe, 5);
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
        try { await placeBybitOrder(pos.symbol, "buy", pos.tp1Hit ? pos.size*0.5 : pos.size, price); } catch {}
      }
      writeTradeCsv({ symbol: pos.symbol, strategy: "hermes_v03", side: "buy", price, tradeSize: pos.tp1Hit ? pos.size*0.5 : pos.size, mode: CONFIG.paperTrading?"PAPER":"LIVE", signal: `EXIT_SL pnl=$${pnl.toFixed(2)}` });
      pos.status = "closed"; pos.closeReason = "stop_loss"; pos.closePrice = price; pos.closeTime = new Date().toISOString(); pos.pnl = pnl;
      log.trades.push({ timestamp: new Date().toISOString(), symbol: pos.symbol, side: "buy", price, orderPlaced: true, reason: "hermes_sl" });

    // ── TP1 Hit (partial exit 50%) ───────────────────────────────────────────
    } else if (!pos.tp1Hit && price <= pos.tp1) {
      const pnl1 = (pos.entry - pos.tp1) / pos.entry * (pos.size * 0.5);
      console.log(`  🎯 TP1 HIT @ $${price.toFixed(4)} — exiting 50% | Locked: +$${pnl1.toFixed(2)} | SL→ breakeven`);
      if (!CONFIG.paperTrading) {
        try { await placeBybitOrder(pos.symbol, "buy", pos.size * 0.5, price); } catch {}
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
        try { await placeBybitOrder(pos.symbol, "buy", pos.size * 0.5, price); } catch {}
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

  const candles = await fetchCandles(asset.okx, CONFIG.timeframe, 200);
  const price   = candles[candles.length - 1].close;
  console.log(`  Price: $${price.toFixed(4)}`);

  // Run the assigned strategy
  const result = asset.strategy === "hermes_v03"
    ? checkStratHermes(candles)
    : checkStratVwapRsi(candles);

  const ind = result.indicators || {};
  if (asset.strategy === "hermes_v03") {
    if (ind.ema9)  console.log(`  EMA9/21/50: ${ind.ema9?.toFixed(2)} / ${ind.ema21?.toFixed(2)} / ${ind.ema50?.toFixed(2)}`);
    if (ind.rsi)   console.log(`  RSI(14): ${ind.rsi?.toFixed(2)}`);
  } else {
    if (ind.ema8)  console.log(`  EMA(8): $${ind.ema8?.toFixed(4)}  VWAP: $${ind.vwap?.toFixed(4)}  RSI(3): ${ind.rsi3?.toFixed(2)}`);
  }

  if (!result.signal) {
    console.log(`  ⏸  No signal — ${result.reason}`);
    return false;
  }

  console.log(`  🎯 SIGNAL: ${result.side.toUpperCase()} — ${result.reason}`);

  const tradeSize = CONFIG.maxTradeSizeUSD;

  if (CONFIG.paperTrading) {
    console.log(`  📋 PAPER: Would ${result.side.toUpperCase()} $${tradeSize} of ${asset.symbol} @ $${price.toFixed(4)}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: asset.strategy, side: result.side, price, tradeSize, mode: "PAPER", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, paper: true });
    return true;
  }

  // Live execution
  try {
    const order = await placeBybitOrder(asset.symbol, result.side, tradeSize, price);
    console.log(`  ✅ ORDER PLACED: ${result.side.toUpperCase()} ${asset.symbol} | ID: ${order.orderId}`);
    writeTradeCsv({ symbol: asset.symbol, strategy: asset.strategy, side: result.side, price, tradeSize, orderId: order.orderId, mode: "LIVE", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, orderId: order.orderId });
    // Track Hermes positions for partial TP management
    if (asset.strategy === "hermes_v03" || asset.hermesAlso) {
      openHermesPosition(asset.symbol, price, tradeSize, order.orderId);
    }
    return true;
  } catch (err) {
    console.log(`  ❌ Order failed: ${err.message}`);
    return false;
  }
}

// ─── Dual-scan: run Hermes on VWAP assets (NEAR + SOL) ───────────────────────
async function processHermesDualScan(asset, log) {
  const candles = await fetchCandles(asset.okx, CONFIG.timeframe, 200);
  const result  = checkStratHermes(candles);
  if (!result.signal) {
    console.log(`  ⏸  ${asset.symbol} Hermes dual: ${result.reason}`);
    return false;
  }
  const price     = candles[candles.length - 1].close;
  const tradeSize = CONFIG.maxTradeSizeUSD;
  console.log(`  🎯 ${asset.symbol} HERMES SIGNAL: ${result.side.toUpperCase()} — ${result.reason}`);
  if (CONFIG.paperTrading) {
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v04", side: result.side, price, tradeSize, mode: "PAPER", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, paper: true });
    return true;
  }
  try {
    const order = await placeBybitOrder(asset.symbol, result.side, tradeSize, price);
    writeTradeCsv({ symbol: asset.symbol, strategy: "hermes_v04", side: result.side, price, tradeSize, orderId: order.orderId, mode: "LIVE", signal: result.reason });
    log.trades.push({ timestamp: new Date().toISOString(), symbol: asset.symbol, side: result.side, price, orderPlaced: true, orderId: order.orderId });
    openHermesPosition(asset.symbol, price, tradeSize, order.orderId);
    return true;
  } catch (err) {
    console.log(`  ❌ ${asset.symbol} Hermes order failed: ${err.message}`);
    return false;
  }
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
  console.log(`  Timeframe: ${CONFIG.timeframe} | Max trade: $${CONFIG.maxTradeSizeUSD}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Daily trade limit check
  const log = loadLog();
  const todayCount = countTodaysTrades(log);
  console.log(`\n  Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log("  🚫 Daily limit reached — stopping.");
    return;
  }

  // ── Step 1: Check open Hermes positions for TP/SL exits ──────────────────
  await checkHermesPositions(log);

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
