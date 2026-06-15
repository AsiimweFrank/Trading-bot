/**
 * Trend-Momentum Confluence (TMC) Market Scanner
 * Scans watchlist every 30 minutes and sends Long/Short signals to Telegram.
 * Completely independent from the trading bots — advisory only, no orders placed.
 *
 * Strategy rules:
 *  LONG  — price > SMA200, price > SMA50, RSI 40–68, RSI rising (≥50)
 *  SHORT — price < SMA200, price < SMA50, RSI 32–60, RSI falling (≤50)
 *  Each met condition = 1 point. 4pts = STRONG, 3pts = WATCH, ≤2 = NEUTRAL
 */

import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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

// ─── OKX data fetch ────────────────────────────────────────────────────────────
function fetchCandles(symbol, bar = "1H", limit = 250) {
  return new Promise((resolve, reject) => {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    https
      .get(url, { headers: { "User-Agent": "TMC-Scanner/1.0" } }, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (json.code !== "0") return reject(new Error(`OKX error: ${json.msg}`));
            // OKX returns newest first → reverse to ascending
            const candles = json.data
              .reverse()
              .map((c) => ({
                ts: Number(c[0]),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                vol: parseFloat(c[5]),
              }));
            resolve(candles);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ─── Indicators ────────────────────────────────────────────────────────────────
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(closes.length - period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// RSI for the last N+2 bars so we can check if RSI crossed 50 in last 2 bars
function calcRSISeries(closes, period = 14, count = 4) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const slice = closes.slice(0, closes.length - i);
    results.unshift(calcRSI(slice, period));
  }
  return results; // oldest → newest
}

// ─── Signal engine ─────────────────────────────────────────────────────────────
function scoreSymbol(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const sma200 = calcSMA(closes, 200);
  const sma50 = calcSMA(closes, 50);
  const rsiSeries = calcRSISeries(closes, 14, 4); // last 4 RSI values
  const rsi = rsiSeries[rsiSeries.length - 1];
  const rsiPrev = rsiSeries[rsiSeries.length - 3]; // 2 bars ago

  if (!sma200 || !sma50 || !rsi) return null;

  const rsiCrossedAbove50 =
    rsiSeries.slice(1).some((r, i) => rsiSeries[i] < 50 && r >= 50);
  const rsiCrossedBelow50 =
    rsiSeries.slice(1).some((r, i) => rsiSeries[i] > 50 && r <= 50);
  const rsiRising = rsi > rsiPrev;

  // LONG scoring
  let longScore = 0;
  if (price > sma200) longScore++;
  if (price > sma50) longScore++;
  if (rsi >= 40 && rsi <= 68) longScore++;
  if (rsi >= 50 && (rsiCrossedAbove50 || rsiRising)) longScore++;

  // SHORT scoring
  let shortScore = 0;
  if (price < sma200) shortScore++;
  if (price < sma50) shortScore++;
  if (rsi >= 32 && rsi <= 60) shortScore++;
  if (rsi <= 50 && (rsiCrossedBelow50 || !rsiRising)) shortScore++;

  // Determine signal
  let signal, score;
  if (longScore >= shortScore) {
    signal = "LONG";
    score = longScore;
  } else {
    signal = "SHORT";
    score = shortScore;
  }

  // Tie at low scores = neutral
  if (longScore === shortScore && longScore <= 2) {
    signal = "NEUTRAL";
    score = longScore;
  }

  let strength;
  if (score === 4) strength = "STRONG";
  else if (score === 3) strength = "WATCH";
  else strength = "NEUTRAL";

  // Override if RSI extreme — don't chase
  let note = "";
  if (signal === "LONG" && rsi > 70) {
    note = " ⚠️ Overbought";
    strength = strength === "STRONG" ? "WATCH" : strength;
  }
  if (signal === "SHORT" && rsi < 30) {
    note = " ⚠️ Oversold";
    strength = strength === "STRONG" ? "WATCH" : strength;
  }

  return {
    price,
    sma200,
    sma50,
    rsi: rsi.toFixed(1),
    signal,
    strength,
    longScore,
    shortScore,
    note,
  };
}

// ─── Format Telegram message ───────────────────────────────────────────────────
function formatMessage(results) {
  const now = new Date();
  const uaeTime = now.toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });

  const EMOJI = {
    LONG: { STRONG: "🟢", WATCH: "🟡", NEUTRAL: "⚫" },
    SHORT: { STRONG: "🔴", WATCH: "🟠", NEUTRAL: "⚫" },
    NEUTRAL: { STRONG: "⚫", WATCH: "⚫", NEUTRAL: "⚫" },
  };

  let lines = [`📡 *Market Scanner — ${uaeTime} UAE*\n`];

  let strongLong = [], watchLong = [], strongShort = [], watchShort = [], neutral = [];

  for (const [symbol, r] of Object.entries(results)) {
    if (!r) continue;
    const coin = symbol.replace("-USDT", "");
    const emoji = EMOJI[r.signal]?.[r.strength] ?? "⚫";
    const line = `${emoji} *${coin}* — ${r.signal} ${r.strength} | RSI ${r.rsi} | $${r.price}${r.note}`;

    if (r.signal === "LONG" && r.strength === "STRONG") strongLong.push(line);
    else if (r.signal === "LONG" && r.strength === "WATCH") watchLong.push(line);
    else if (r.signal === "SHORT" && r.strength === "STRONG") strongShort.push(line);
    else if (r.signal === "SHORT" && r.strength === "WATCH") watchShort.push(line);
    else neutral.push(line);
  }

  if (strongLong.length) {
    lines.push("🟢 *STRONG LONG*");
    strongLong.forEach((l) => lines.push(l));
    lines.push("");
  }
  if (watchLong.length) {
    lines.push("🟡 *WATCH LONG*");
    watchLong.forEach((l) => lines.push(l));
    lines.push("");
  }
  if (strongShort.length) {
    lines.push("🔴 *STRONG SHORT*");
    strongShort.forEach((l) => lines.push(l));
    lines.push("");
  }
  if (watchShort.length) {
    lines.push("🟠 *WATCH SHORT*");
    watchShort.forEach((l) => lines.push(l));
    lines.push("");
  }
  if (neutral.length) {
    lines.push("⚫ *NEUTRAL*");
    neutral.forEach((l) => lines.push(l));
    lines.push("");
  }

  lines.push("_Advisory only. Not financial advice. You place trades._");
  return lines.join("\n");
}

// ─── Telegram send ─────────────────────────────────────────────────────────────
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => resolve(JSON.parse(raw)));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Main scan loop ────────────────────────────────────────────────────────────
async function scan() {
  console.log(`[${new Date().toISOString()}] Running scan...`);
  const results = {};

  for (const symbol of WATCHLIST) {
    try {
      const candles = await fetchCandles(symbol, "1H", 250);
      results[symbol] = scoreSymbol(candles);
      console.log(
        `  ${symbol}: ${results[symbol]?.signal} ${results[symbol]?.strength} | RSI ${results[symbol]?.rsi}`
      );
    } catch (err) {
      console.error(`  ${symbol} error:`, err.message);
      results[symbol] = null;
    }
  }

  const message = formatMessage(results);
  console.log("\nMessage preview:\n" + message.replace(/\*/g, "").replace(/_/g, ""));

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(message);
    console.log("✅ Telegram sent");
  } else {
    console.log("⚠️  No Telegram env vars — skipping send (set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID)");
  }
}

// Run immediately, then every 30 minutes
scan().catch(console.error);
setInterval(() => scan().catch(console.error), SCAN_INTERVAL_MS);
