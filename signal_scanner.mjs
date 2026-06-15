/**
 * Signal Scanner — V8 Strategy Alerts (Manual Trading)
 *
 * Uses the same logic as the V8 bot (proven PF 1.06 in backtest):
 *   LONG:  BTC daily > SMA200 + coin 1H price > SMA200 + SMA50 rising + RSI(2) < 10 + ATR normal
 *   SHORT: BTC daily < SMA200 + coin 1H price < SMA200 + SMA50 falling + RSI(2) > 90 + ATR normal
 *
 * Scans every 5 minutes. Sends Telegram alert on new signal with entry/SL/TP.
 * Also sends a 30-minute market summary for watchlist context.
 *
 * Advisory only — you place every trade yourself.
 */

import https from "https";

// ─── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;    // 5 min — catches signals fast
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // 30 min — market overview

const WATCHLIST = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "BNB-USDT",
  "XRP-USDT",
  "NEAR-USDT",
  "AVAX-USDT",
  "TRX-USDT",
];

const STOP_PCT = 0.003;   // 0.3% stop loss (same as V2 bot)
const REWARD_RATIO = 3;   // 3:1 RR → TP = entry + 3×risk
const ATR_RATIO_MAX = 1.5; // block signals when volatility is spiking

// Track alerted signals so we don't spam the same one
// key: "BTC-USDT_LONG_<candle_ts>" → true
const alertedSignals = new Set();

// ─── OKX data fetch ────────────────────────────────────────────────────────────
function fetchCandles(symbol, bar = "1H", limit = 250) {
  return new Promise((resolve, reject) => {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    https
      .get(url, { headers: { "User-Agent": "SignalScanner/1.0" } }, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            const j = JSON.parse(raw);
            if (j.code !== "0") return reject(new Error(`OKX: ${j.msg}`));
            resolve(
              j.data.reverse().map((c) => ({
                ts: Number(c[0]),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                vol: parseFloat(c[5]),
              }))
            );
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ─── Indicators ────────────────────────────────────────────────────────────────
function calcSMA(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI2(closes) {
  // RSI with period=2 using last 3 bars
  if (closes.length < 3) return null;
  const slice = closes.slice(-3);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / 2;
  const avgLoss = losses / 2;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1);
  const trs = [];
  for (let i = 1; i < slice.length; i++) {
    const h = slice[i].high, l = slice[i].low, pc = slice[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function calcATRSeries(candles, period = 14) {
  // Build ATR for every bar so we can SMA the ATR values (for ratio filter)
  const atrs = [];
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i + 1);
    const trs = [];
    for (let j = 1; j < slice.length; j++) {
      const h = slice[j].high, l = slice[j].low, pc = slice[j - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    atrs.push(trs.reduce((a, b) => a + b, 0) / period);
  }
  return atrs;
}

// ─── Signal logic (mirrors V8 bot exactly) ────────────────────────────────────
function getSignal(candles, btcDailyBull) {
  if (candles.length < 210) return null;

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const lastCandle = candles[candles.length - 1];

  const sma200 = calcSMA(closes, 200);
  const sma50 = calcSMA(closes, 50);
  const sma50_prev = calcSMA(closes.slice(0, -3), 50); // SMA50 from 3 bars ago
  const rsi2 = calcRSI2(closes);

  if (!sma200 || !sma50 || rsi2 === null) return null;

  // ATR ratio filter
  const atrSeries = calcATRSeries(candles, 14);
  const atr14 = atrSeries[atrSeries.length - 1];
  const atrSma50 = calcSMA(atrSeries, 50);
  const atrRatio = atrSma50 ? atr14 / atrSma50 : 0;
  const atrBlocked = atrRatio > ATR_RATIO_MAX;

  const sma50Rising = sma50 > sma50_prev;

  const longConditions = {
    btcMacro: btcDailyBull === true,
    aboveSma200: price > sma200,
    sma50Rising,
    rsiDip: rsi2 < 10,
    atrOk: !atrBlocked,
  };

  const shortConditions = {
    btcMacro: btcDailyBull === false,
    belowSma200: price < sma200,
    sma50Falling: !sma50Rising,
    rsiSpike: rsi2 > 90,
    atrOk: !atrBlocked,
  };

  const allLong = Object.values(longConditions).every(Boolean);
  const allShort = Object.values(shortConditions).every(Boolean);

  if (!allLong && !allShort) {
    // Return context for market summary even without a signal
    return {
      hasSignal: false,
      price,
      sma200,
      sma50,
      rsi2: rsi2.toFixed(1),
      atrRatio: atrRatio.toFixed(2),
      trend: price > sma200 ? (sma50Rising ? "BULL" : "MIXED") : "BEAR",
      candle_ts: lastCandle.ts,
    };
  }

  const side = allLong ? "LONG" : "SHORT";
  let entry, sl, tp;

  if (side === "LONG") {
    entry = lastCandle.low; // same as bot: limit at candle LOW
    sl = entry * (1 - STOP_PCT);
    tp = entry + REWARD_RATIO * (entry - sl);
  } else {
    entry = lastCandle.high; // limit at candle HIGH
    sl = entry * (1 + STOP_PCT);
    tp = entry - REWARD_RATIO * (sl - entry);
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);

  return {
    hasSignal: true,
    side,
    price,
    entry,
    sl,
    tp,
    risk,
    reward,
    sma200,
    sma50,
    rsi2: rsi2.toFixed(1),
    atrRatio: atrRatio.toFixed(2),
    trend: side === "LONG" ? "BULL" : "BEAR",
    candle_ts: lastCandle.ts,
    longConditions,
    shortConditions,
  };
}

// ─── Format signal alert ───────────────────────────────────────────────────────
function fmt(price, ref) {
  // Format price to same decimal places as reference
  if (!ref || ref >= 100) return price.toFixed(2);
  if (ref >= 1) return price.toFixed(3);
  if (ref >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function formatSignalAlert(symbol, r) {
  const coin = symbol.replace("-USDT", "");
  const side = r.side;
  const emoji = side === "LONG" ? "🟢" : "🔴";
  const dir = side === "LONG" ? "▲" : "▼";

  const pct = (n) => (n * 100).toFixed(2) + "%";
  const slPct = pct(Math.abs(r.entry - r.sl) / r.entry);
  const tpPct = pct(Math.abs(r.tp - r.entry) / r.entry);

  return [
    `${emoji} *${side} SIGNAL — ${coin}* ${dir}`,
    ``,
    `Entry:  \`${fmt(r.entry, r.price)}\``,
    `Stop:   \`${fmt(r.sl, r.price)}\` (−${slPct})`,
    `Target: \`${fmt(r.tp, r.price)}\` (+${tpPct})`,
    `RR: ${REWARD_RATIO}:1  |  RSI(2): ${r.rsi2}`,
    ``,
    `Macro: ${r.trend === "BULL" ? "✅ BTC BULL" : "🔴 BTC BEAR"}  |  ATR ratio: ${r.atrRatio}`,
    `_Advisory only — you place the trade_`,
  ].join("\n");
}

// ─── Format 30-min market summary ──────────────────────────────────────────────
function formatSummary(allResults, btcDailyBull) {
  const now = new Date();
  const uaeTime = now.toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });

  const macroLabel = btcDailyBull === true
    ? "✅ BTC Daily BULL (longs active)"
    : btcDailyBull === false
    ? "🔴 BTC Daily BEAR (shorts active)"
    : "⚫ BTC macro unknown";

  const lines = [
    `📊 *Market Summary — ${uaeTime} UAE*`,
    `Macro: ${macroLabel}`,
    ``,
  ];

  for (const [symbol, r] of Object.entries(allResults)) {
    if (!r) { lines.push(`⬛ ${symbol.replace("-USDT", "")} — data error`); continue; }
    const coin = symbol.replace("-USDT", "");
    const trendEmoji = r.trend === "BULL" ? "🟢" : r.trend === "BEAR" ? "🔴" : "🟡";
    const rsiNote = parseFloat(r.rsi2) < 10 ? " 👀 RSI dip!" : parseFloat(r.rsi2) > 90 ? " ⚠️ RSI spike!" : "";
    lines.push(`${trendEmoji} *${coin}* — ${r.trend} | RSI(2): ${r.rsi2} | $${fmt(r.price, r.price)}${rsiNote}`);
  }

  lines.push(``);
  lines.push(`_Signals fire when ALL V8 conditions met. Advisory only._`);
  return lines.join("\n");
}

// ─── Telegram send ─────────────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram skipped — no env vars]\n" + text);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => { let r = ""; res.on("data", (d) => (r += d)); res.on("end", () => resolve(JSON.parse(r))); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────
let lastSummaryTime = 0;

async function scan() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Scanning...`);

  // BTC daily macro gate (same as V8 bot)
  let btcDailyBull = null;
  try {
    const btcDaily = await fetchCandles("BTC-USDT", "1D", 210);
    const dc = btcDaily.map((c) => c.close);
    const dSma200 = calcSMA(dc, 200);
    btcDailyBull = dSma200 !== null && dc[dc.length - 1] > dSma200;
    console.log(`  BTC daily: $${dc[dc.length-1].toFixed(0)} vs SMA200 $${dSma200?.toFixed(0)} → ${btcDailyBull ? "BULL" : "BEAR"}`);
  } catch (e) {
    console.error("  BTC daily fetch failed:", e.message);
  }

  const allResults = {};
  for (const symbol of WATCHLIST) {
    try {
      const candles = await fetchCandles(symbol, "1H", 250);
      const r = getSignal(candles, btcDailyBull);
      allResults[symbol] = r;

      if (r?.hasSignal) {
        const key = `${symbol}_${r.side}_${r.candle_ts}`;
        if (!alertedSignals.has(key)) {
          alertedSignals.add(key);
          const msg = formatSignalAlert(symbol, r);
          console.log(`  🔔 SIGNAL: ${symbol} ${r.side}`);
          await sendTelegram(msg);
        } else {
          console.log(`  ${symbol}: ${r.side} signal (already alerted)`);
        }
      } else {
        console.log(`  ${symbol}: ${r?.trend ?? "?"} | RSI(2) ${r?.rsi2}`);
      }
    } catch (e) {
      console.error(`  ${symbol} error:`, e.message);
      allResults[symbol] = null;
    }
  }

  // 30-minute market summary
  if (now - lastSummaryTime >= SUMMARY_INTERVAL_MS) {
    lastSummaryTime = now;
    const summary = formatSummary(allResults, btcDailyBull);
    await sendTelegram(summary);
    console.log("  ✅ Summary sent");
  }
}

// Run immediately then every 5 minutes
scan().catch(console.error);
setInterval(() => scan().catch(console.error), SCAN_INTERVAL_MS);
