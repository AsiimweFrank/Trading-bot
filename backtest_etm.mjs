/**
 * Backtest: EMA Trend Momentum (ETM) Strategy
 *
 * Strategy logic (completely new — not V2/V8):
 *   LONG:  EMA9 > EMA21 > EMA50 (bull stack) + MACD histogram just crossed above 0 + RSI(14) 40–70 + volume spike
 *   SHORT: EMA9 < EMA21 < EMA50 (bear stack) + MACD histogram just crossed below 0 + RSI(14) 30–60 + volume spike
 *
 *   Stop:   1× ATR(14) from entry (adapts to each coin's volatility)
 *   Target: 2× risk (2:1 RR)
 *   Max hold: 48 bars then exit at market
 *   No concurrent positions per coin
 *
 * OKX 1H data, 12 months, all 8 watchlist coins
 */

import https from "https";

const COINS = ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","NEAR-USDT","AVAX-USDT","TRX-USDT"];
const ACCOUNT = 500;
const RISK_PCT = 0.01; // risk 1% of account per trade
const REWARD_RATIO = 2; // 2:1
const MAX_HOLD = 48;
const VOL_MULT = 1.2; // volume must be 1.2× the 20-bar average

function fetchCandles(symbol, bar = "1H", limit = 1440) {
  return new Promise((resolve, reject) => {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    https.get(url, { headers: { "User-Agent": "ETM-Backtest/1.0" } }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          if (j.code !== "0") return reject(new Error(j.msg));
          resolve(j.data.reverse().map((c) => ({
            ts: Number(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            vol: parseFloat(c[5]),
          })));
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// Exponential moving average
function calcEMASeries(closes, period) {
  const k = 2 / (period + 1);
  const emas = new Array(closes.length).fill(null);
  // Seed with SMA of first `period` bars
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  emas[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    emas[i] = closes[i] * k + emas[i - 1] * (1 - k);
  }
  return emas;
}

// MACD histogram series: EMA12 - EMA26, then EMA9 of that = signal; hist = macd - signal
function calcMACDSeries(closes) {
  const ema12 = calcEMASeries(closes, 12);
  const ema26 = calcEMASeries(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null
  );
  // EMA9 of macdLine (signal line)
  const validStart = macdLine.findIndex((v) => v !== null);
  const signalInput = macdLine.slice(validStart);
  const signalSeries = calcEMASeries(signalInput, 9);
  const signal = new Array(validStart).fill(null).concat(signalSeries);
  const hist = macdLine.map((m, i) =>
    m !== null && signal[i] !== null ? m - signal[i] : null
  );
  return hist;
}

// RSI series (period 14)
function calcRSISeries(closes, period = 14) {
  const rsis = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsis;
  // Initial avg gain/loss
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  rsis[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsis[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsis;
}

// ATR series (period 14)
function calcATRSeries(candles, period = 14) {
  const atrs = new Array(candles.length).fill(null);
  let sumTR = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sumTR += tr;
  }
  atrs[period] = sumTR / period;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrs[i] = (atrs[i - 1] * (period - 1) + tr) / period;
  }
  return atrs;
}

// Volume SMA series
function calcVolSMA(vols, period = 20) {
  const smas = new Array(vols.length).fill(null);
  for (let i = period - 1; i < vols.length; i++) {
    smas[i] = vols.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  }
  return smas;
}

async function backtestCoin(symbol) {
  const candles = await fetchCandles(symbol, "1H", 1440);
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.vol);

  const ema9 = calcEMASeries(closes, 9);
  const ema21 = calcEMASeries(closes, 21);
  const ema50 = calcEMASeries(closes, 50);
  const macdHist = calcMACDSeries(closes);
  const rsi = calcRSISeries(closes, 14);
  const atr = calcATRSeries(candles, 14);
  const volSma = calcVolSMA(vols, 20);

  const trades = [];
  let position = null;

  const WARMUP = 60; // enough bars for all indicators to stabilize

  for (let i = WARMUP; i < candles.length; i++) {
    // Manage open position
    if (position) {
      const bar = candles[i];
      let closed = false;

      if (position.side === "long") {
        if (bar.low <= position.sl) {
          trades.push({ side: "long", pnl: position.risk * -1, result: "SL", bars: i - position.entry_i });
          closed = true;
        } else if (bar.high >= position.tp) {
          trades.push({ side: "long", pnl: position.risk * REWARD_RATIO, result: "TP", bars: i - position.entry_i });
          closed = true;
        } else if (i - position.entry_i >= MAX_HOLD) {
          const exitPrice = bar.close;
          const pnl = ((exitPrice - position.entry) / position.entry) * position.notional;
          trades.push({ side: "long", pnl, result: "TIMEOUT", bars: MAX_HOLD });
          closed = true;
        }
      } else {
        if (bar.high >= position.sl) {
          trades.push({ side: "short", pnl: position.risk * -1, result: "SL", bars: i - position.entry_i });
          closed = true;
        } else if (bar.low <= position.tp) {
          trades.push({ side: "short", pnl: position.risk * REWARD_RATIO, result: "TP", bars: i - position.entry_i });
          closed = true;
        } else if (i - position.entry_i >= MAX_HOLD) {
          const exitPrice = bar.close;
          const pnl = ((position.entry - exitPrice) / position.entry) * position.notional;
          trades.push({ side: "short", pnl, result: "TIMEOUT", bars: MAX_HOLD });
          closed = true;
        }
      }
      if (closed) position = null;
    }

    if (position) continue; // one position per coin at a time

    const e9 = ema9[i], e21 = ema21[i], e50 = ema50[i];
    const hist = macdHist[i], histPrev = macdHist[i - 1];
    const r = rsi[i];
    const a = atr[i];
    const vAvg = volSma[i];
    const v = vols[i];

    if (!e9 || !e21 || !e50 || hist === null || histPrev === null || !r || !a || !vAvg) continue;

    const bullStack = e9 > e21 && e21 > e50;
    const bearStack = e9 < e21 && e21 < e50;
    const macdCrossUp = histPrev < 0 && hist >= 0;   // histogram crossed above 0
    const macdCrossDown = histPrev > 0 && hist <= 0; // histogram crossed below 0
    const volOk = v > vAvg * VOL_MULT;

    let signal = null;
    if (bullStack && macdCrossUp && r >= 40 && r <= 70 && volOk) signal = "long";
    if (bearStack && macdCrossDown && r >= 30 && r <= 60 && volOk) signal = "short";

    if (!signal) continue;

    const entry = candles[i].close;
    const risk$ = ACCOUNT * RISK_PCT; // $ amount risked

    if (signal === "long") {
      const sl = entry - a;       // 1× ATR below entry
      const tp = entry + a * REWARD_RATIO; // 2× ATR above entry
      const stopDist = entry - sl;
      const notional = risk$ / (stopDist / entry);
      position = { side: "long", entry, sl, tp, risk: risk$, notional, entry_i: i };
    } else {
      const sl = entry + a;
      const tp = entry - a * REWARD_RATIO;
      const stopDist = sl - entry;
      const notional = risk$ / (stopDist / entry);
      position = { side: "short", entry, sl, tp, risk: risk$, notional, entry_i: i };
    }
  }

  return trades;
}

async function main() {
  let allTrades = [];
  for (const coin of COINS) {
    process.stdout.write(`Backtesting ${coin}...`);
    try {
      const trades = await backtestCoin(coin);
      allTrades = allTrades.concat(trades);
      const wins = trades.filter((t) => t.pnl > 0).length;
      const net = trades.reduce((a, t) => a + t.pnl, 0);
      console.log(` ${trades.length} trades | WR ${((wins/trades.length)*100).toFixed(1)}% | Net $${net.toFixed(2)}`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
  }

  const wins = allTrades.filter((t) => t.pnl > 0);
  const losses = allTrades.filter((t) => t.pnl <= 0);
  const net = allTrades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.reduce((a, t) => a + t.pnl, 0) / (wins.length || 1);
  const avgLoss = losses.reduce((a, t) => a + t.pnl, 0) / (losses.length || 1);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Drawdown calc
  let equity = ACCOUNT, peak = ACCOUNT, maxDD = 0;
  for (const t of allTrades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Exit breakdown
  const tpCount = allTrades.filter((t) => t.result === "TP").length;
  const slCount = allTrades.filter((t) => t.result === "SL").length;
  const toCount = allTrades.filter((t) => t.result === "TIMEOUT").length;
  const perYear = Math.round(allTrades.length * (8760 / (1440 * (allTrades.length / COINS.length || 1) || 1)) * COINS.length);

  console.log("\n════════ ETM STRATEGY BACKTEST RESULTS ════════");
  console.log(`Period:       OKX 1H, 1440 bars/coin (~60 days)`);
  console.log(`Coins:        ${COINS.length} (${COINS.map(c=>c.replace("-USDT","")).join(", ")})`);
  console.log(`Total trades: ${allTrades.length}`);
  console.log(`Win rate:     ${((wins.length/allTrades.length)*100).toFixed(1)}%`);
  console.log(`Profit factor:${pf.toFixed(2)}`);
  console.log(`Net P&L:      $${net.toFixed(2)} on $${ACCOUNT} account`);
  console.log(`Avg win:      $${avgWin.toFixed(2)}`);
  console.log(`Avg loss:     $${avgLoss.toFixed(2)}`);
  console.log(`Max drawdown: ${(maxDD*100).toFixed(1)}%`);
  console.log(`TP hits:      ${tpCount} | SL hits: ${slCount} | Timeouts: ${toCount}`);
  console.log(`Trades/day:   ${(allTrades.length / 60).toFixed(1)} across all coins`);
  console.log("═══════════════════════════════════════════════");
}

main().catch(console.error);
