/**
 * MACD + RSI + SMA200 Signal Scanner — 4H
 *
 * Standalone market scanner — NO trading, NO Bybit, NO positions.
 * Sends Telegram alerts when a new signal fires on a 4H candle close.
 *
 * Strategy (backtested PF 1.27, +39% over 12 months, 8 coins):
 *   LONG:  MACD crosses above signal + RSI < 60 + price > SMA200
 *   SHORT: MACD crosses below signal + RSI > 40 + price < SMA200
 *   Exit signal: MACD crosses back (advisory — you decide when to exit)
 *
 * Runs every 5 minutes. Fires signal alert on new 4H candle close.
 * Sends a full market summary at 08:00 UAE every morning.
 *
 * Deploy as a separate Railway service — start command: node scanner_4h.mjs
 * Required env vars: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 */

import https from "https";

// ─── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCANNER_LABEL    = "📡 4H Scanner";

const WATCHLIST = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "NEARUSDT",
  "AVAXUSDT",
  "TRXUSDT",
];

// Track which 4H candle we already alerted, per symbol+side
// key: "ETH-USDT_long_<4H-candle-ts>" → true
const alertedSignals = new Set();
// Track open advisory positions (for exit signals)
// key: "ETH-USDT" → { side, entryTs, entryPrice, entryRsi }
const openAdvisory = new Map();

let lastSummaryDay = -1; // UAE day of last morning summary

// ─── Bybit data ───────────────────────────────────────────────────────────────
function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Scanner4H/1.0" } }, (res) => {
      let raw = "";
      res.on("data", d => (raw += d));
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCandles(symbol, interval = "240", limit = 300) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await apiGet(url);
  if (r.retCode !== 0) throw new Error(`Bybit ${symbol}: ${r.retMsg}`);
  return r.result.list
    .reverse()
    .map(c => ({
      ts:    Number(c[0]),
      open:  parseFloat(c[1]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol:   parseFloat(c[5]),
    }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = new Array(closes.length).fill(null);
  if (closes.length < period) return ema;
  let s = 0;
  for (let i = 0; i < period; i++) s += closes[i];
  ema[period - 1] = s / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcSMA(closes, period) {
  const sma = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    sma[i] = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  }
  return sma;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ef = calcEMA(closes, fast);
  const es = calcEMA(closes, slow);
  const ml = closes.map((_, i) => ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  const validIdx = ml.findIndex(v => v !== null);
  const sig = calcEMA(ml.slice(validIdx).map(v => v ?? 0), signal);
  const sl = new Array(validIdx).fill(null).concat(sig);
  return { ml, sl };
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

// ─── Signal engine ─────────────────────────────────────────────────────────────
function analyzeSymbol(candles) {
  if (candles.length < 250) return null;

  const closes = candles.map(c => c.close);
  const { ml, sl } = calcMACD(closes);
  const rsiArr     = calcRSI(closes, 14);
  const sma200     = calcSMA(closes, 200);

  const i    = candles.length - 1; // latest closed candle
  const prev = i - 1;

  const ml_now  = ml[i],   sl_now  = sl[i];
  const ml_prev = ml[prev], sl_prev = sl[prev];
  const rsi     = rsiArr[i];
  const s200    = sma200[i];

  if (ml_now === null || sl_now === null || ml_prev === null || sl_prev === null || rsi === null || !s200) {
    return null;
  }

  const price = candles[i].close;

  // Crossing detection
  const macdCrossUp   = ml_prev <= sl_prev && ml_now > sl_now;
  const macdCrossDown = ml_prev >= sl_prev && ml_now < sl_now;

  // Swing low/high over last 10 bars (for suggested SL)
  const recent = candles.slice(Math.max(0, i - 10), i + 1);
  const swingLow  = Math.min(...recent.map(c => c.low));
  const swingHigh = Math.max(...recent.map(c => c.high));

  let newSignal = null;
  if (macdCrossUp   && rsi < 60 && price > s200) newSignal = "long";
  if (macdCrossDown && rsi > 40 && price < s200) newSignal = "short";

  // Exit advisory: check if MACD is reversing against an open advisory position
  let exitSignal = null;
  if (openAdvisory.has(candles[0]?.symbol)) { // won't work — fix below
    const pos = openAdvisory.get(candles[0]?.symbol);
    if (pos.side === "long"  && macdCrossDown) exitSignal = "long_exit";
    if (pos.side === "short" && macdCrossUp)   exitSignal = "short_exit";
  }

  return {
    price, rsi: rsi.toFixed(1), sma200: s200,
    ml: ml_now, sl_macd: sl_now,
    macdCrossUp, macdCrossDown,
    newSignal,
    swingLow, swingHigh,
    candleTs: candles[i].ts,
    aboveSMA200: price > s200,
    macdAboveSignal: ml_now > sl_now,
    trend: price > s200 ? "BULL" : "BEAR",
  };
}

// ─── Format messages ───────────────────────────────────────────────────────────
function fmtPrice(price) {
  if (price >= 1000)  return price.toFixed(2);
  if (price >= 10)    return price.toFixed(3);
  if (price >= 0.1)   return price.toFixed(4);
  return price.toFixed(6);
}

function uaeTime() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit", minute: "2-digit",
    day: "2-digit", month: "short",
  });
}

function formatSignalAlert(symbol, r, side) {
  const coin = symbol.replace("-USDT", "");
  const isLong = side === "long";
  const emoji = isLong ? "🟢" : "🔴";
  const dir   = isLong ? "▲ LONG" : "▼ SHORT";

  const sl     = isLong ? r.swingLow  : r.swingHigh;
  const slPct  = (Math.abs(r.price - sl) / r.price * 100).toFixed(2);

  const conditions = [
    `MACD crossed ${isLong ? "above" : "below"} signal ✅`,
    `RSI ${r.rsi} — ${isLong ? "not overbought (<60)" : "not oversold (>40)"} ✅`,
    `Price ${isLong ? "above" : "below"} SMA200 ✅`,
  ].join("\n");

  return [
    `${SCANNER_LABEL}`,
    `${emoji} *${dir} — ${coin}/USDT*`,
    ``,
    `Price:  \`$${fmtPrice(r.price)}\``,
    `Stop:   \`$${fmtPrice(sl)}\` (${slPct}% away)  ← 10-bar swing ${isLong?"low":"high"}`,
    `Exit:   When MACD crosses back ${isLong?"below":"above"} signal`,
    ``,
    `${conditions}`,
    ``,
    `_Advisory only — you place the trade yourself_`,
  ].join("\n");
}

function formatExitAlert(symbol, side, r) {
  const coin   = symbol.replace("-USDT", "");
  const emoji  = side === "long" ? "🟡" : "🟡";
  const dir    = side === "long" ? "LONG" : "SHORT";
  return [
    `${SCANNER_LABEL}`,
    `${emoji} *EXIT ADVISORY — ${coin} ${dir}*`,
    ``,
    `MACD has crossed back — consider closing your ${dir} position.`,
    `Current price: \`$${fmtPrice(r.price)}\`  |  RSI: ${r.rsi}`,
    ``,
    `_Advisory only — your decision_`,
  ].join("\n");
}

function formatMorningSummary(results) {
  const lines = [
    `${SCANNER_LABEL}`,
    `*Morning Summary — ${uaeTime()} UAE*`,
    ``,
  ];

  const bulls = [], bears = [], neutral = [];

  for (const [symbol, r] of Object.entries(results)) {
    if (!r) continue;
    const coin = symbol.replace("-USDT", "");
    const macdState = r.macdAboveSignal ? "MACD ↑" : "MACD ↓";
    const rsiNote   = parseFloat(r.rsi) > 70 ? "⚠️ OB" : parseFloat(r.rsi) < 30 ? "⚠️ OS" : "";
    const line = `*${coin}* — ${r.trend} | RSI ${r.rsi} ${rsiNote} | ${macdState} | $${fmtPrice(r.price)}`;

    if (r.trend === "BULL" && r.macdAboveSignal) bulls.push("🟢 " + line);
    else if (r.trend === "BEAR" && !r.macdAboveSignal) bears.push("🔴 " + line);
    else neutral.push("🟡 " + line);
  }

  if (bulls.length)    { lines.push("*Bullish alignment:*"); bulls.forEach(l => lines.push(l)); lines.push(""); }
  if (bears.length)    { lines.push("*Bearish alignment:*"); bears.forEach(l => lines.push(l)); lines.push(""); }
  if (neutral.length)  { lines.push("*Mixed / transitioning:*"); neutral.forEach(l => lines.push(l)); lines.push(""); }

  lines.push("_Signal fires when MACD crosses with RSI + SMA200 filter._");
  lines.push("_Advisory only. Not financial advice._");
  return lines.join("\n");
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram not configured]\n" + text.replace(/\*/g, "").replace(/_/g, "") + "\n");
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" });
    const req  = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let raw = "";
      res.on("data", d => (raw += d));
      res.on("end", () => resolve(JSON.parse(raw)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  const now    = new Date();
  const uaeHour = Number(now.toLocaleString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit" }));
  const uaeDay  = Number(now.toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "2-digit" }));

  console.log(`[${now.toISOString()}] Scanning ${WATCHLIST.length} coins on 4H...`);

  const results = {};

  for (const symbol of WATCHLIST) {
    try {
      const candles = await fetchCandles(symbol, "240", 300);
      const r = analyzeSymbol(candles);
      results[symbol] = r;

      if (!r) { console.log(`  ${symbol}: insufficient data`); continue; }

      console.log(`  ${symbol}: ${r.trend} | RSI ${r.rsi} | MACD ${r.macdAboveSignal ? "above" : "below"} signal${r.newSignal ? ` | ⚡ NEW ${r.newSignal.toUpperCase()}` : ""}`);

      // Fire new signal alert
      if (r.newSignal) {
        const key = `${symbol}_${r.newSignal}_${r.candleTs}`;
        if (!alertedSignals.has(key)) {
          alertedSignals.add(key);
          const msg = formatSignalAlert(symbol, r, r.newSignal);
          await sendTelegram(msg);

          // Track open advisory position
          openAdvisory.set(symbol, { side: r.newSignal, entryPrice: r.price, entryTs: Date.now() });
        }
      }

      // Exit advisory: MACD reversal against open advisory position
      if (openAdvisory.has(symbol)) {
        const pos = openAdvisory.get(symbol);
        const exitTriggered =
          (pos.side === "long"  && r.macdCrossDown) ||
          (pos.side === "short" && r.macdCrossUp);

        if (exitTriggered) {
          const exitKey = `exit_${symbol}_${pos.side}_${r.candleTs}`;
          if (!alertedSignals.has(exitKey)) {
            alertedSignals.add(exitKey);
            openAdvisory.delete(symbol);
            await sendTelegram(formatExitAlert(symbol, pos.side, r));
          }
        }
      }

      await sleep(300);
    } catch (e) {
      console.error(`  ${symbol} error: ${e.message}`);
    }
  }

  // Morning summary at 08:00 UAE (once per day)
  if (uaeHour === 8 && uaeDay !== lastSummaryDay) {
    lastSummaryDay = uaeDay;
    const summary = formatMorningSummary(results);
    await sendTelegram(summary);
    console.log("  ✅ Morning summary sent");
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
console.log(`${SCANNER_LABEL} starting — MACD+RSI+SMA200 strategy on 4H (Bybit data)`);
console.log(`Watchlist: ${WATCHLIST.join(", ")}`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? "configured ✅" : "NOT SET ❌"}`);
console.log(`Scanning every 5 minutes. Signals fire on 4H candle closes.\n`);

// Run immediately, then every 5 minutes
scan().catch(console.error);
setInterval(() => scan().catch(console.error), 5 * 60 * 1000);
