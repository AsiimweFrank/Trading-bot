/**
 * Backtest: EMA21 Pullback Strategy
 *
 * Logic:
 *   LONG:  Price > EMA200 (macro bull) + EMA21 > EMA50 (trend aligned)
 *          + Price touched EMA21 from above (low ≤ EMA21) and CLOSED above EMA21
 *          + Candle is bullish (close > open) — bounce confirmed
 *          + RSI(14) between 35–60 (coming out of dip, not overbought)
 *
 *   SHORT: Price < EMA200 (macro bear) + EMA21 < EMA50 (trend aligned)
 *          + Price touched EMA21 from below (high ≥ EMA21) and CLOSED below EMA21
 *          + Candle is bearish (close < open) — rejection confirmed
 *          + RSI(14) between 40–65 (fading the rally, not oversold)
 *
 *   Entry:  Close of signal candle
 *   Stop:   Low of signal candle × 0.999 (longs) / High × 1.001 (shorts)
 *   Target: 2× risk (RR 2:1)
 *   Max hold: 48 bars then exit at market
 *
 * OKX 1H, 12 months, 8 coins
 */

import https from "https";

const COINS = ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","NEAR-USDT","AVAX-USDT","TRX-USDT"];
const ACCOUNT = 500;
const RISK_PCT = 0.01;
const REWARD_RATIO = 2;
const MAX_HOLD = 48;
const SL_BUFFER = 0.001; // tiny buffer below signal candle low

function okxGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "EMA21-Backtest/1.0" } }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOKX(symbol) {
  const RECENT = "https://www.okx.com/api/v5/market/candles";
  const HIST   = "https://www.okx.com/api/v5/market/history-candles";
  const all = [];

  const r0 = await okxGet(`${RECENT}?instId=${symbol}&bar=1H&limit=300`);
  if (r0.data?.length) all.push(...r0.data);
  await sleep(250);

  let after = all.length ? all[all.length - 1][0] : "";
  for (let p = 0; p < 90; p++) {
    const d = await okxGet(`${HIST}?instId=${symbol}&bar=1H&limit=100${after ? "&after=" + after : ""}`);
    if (!d.data?.length) break;
    all.push(...d.data);
    after = d.data[d.data.length - 1][0];
    await sleep(200);
  }

  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  return all
    .filter((c) => Number(c[0]) >= cutoff)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map((c) => ({
      ts: Number(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
    }));
}

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

function backtestCoin(candles) {
  const closes = candles.map((c) => c.close);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsi = calcRSI(closes, 14);

  const trades = [];
  let position = null;
  const WARMUP = 210;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];

    // Manage open position
    if (position) {
      let closed = false;
      if (position.side === "long") {
        if (bar.low <= position.sl) {
          trades.push({ side: "long", pnl: -position.risk$, result: "SL", bars: i - position.i0 });
          closed = true;
        } else if (bar.high >= position.tp) {
          trades.push({ side: "long", pnl: position.risk$ * REWARD_RATIO, result: "TP", bars: i - position.i0 });
          closed = true;
        } else if (i - position.i0 >= MAX_HOLD) {
          const pnl = (bar.close - position.entry) / position.entry * position.notional;
          trades.push({ side: "long", pnl, result: "TIMEOUT", bars: MAX_HOLD });
          closed = true;
        }
      } else {
        if (bar.high >= position.sl) {
          trades.push({ side: "short", pnl: -position.risk$, result: "SL", bars: i - position.i0 });
          closed = true;
        } else if (bar.low <= position.tp) {
          trades.push({ side: "short", pnl: position.risk$ * REWARD_RATIO, result: "TP", bars: i - position.i0 });
          closed = true;
        } else if (i - position.i0 >= MAX_HOLD) {
          const pnl = (position.entry - bar.close) / position.entry * position.notional;
          trades.push({ side: "short", pnl, result: "TIMEOUT", bars: MAX_HOLD });
          closed = true;
        }
      }
      if (closed) position = null;
      if (position) continue;
    }

    const e21 = ema21[i], e50 = ema50[i], e200 = ema200[i], r = rsi[i];
    if (!e21 || !e50 || !e200 || r === null) continue;

    const price = bar.close;
    const isBullCandle = bar.close > bar.open;
    const isBearCandle = bar.close < bar.open;

    const touchedEMA21FromAbove = bar.low <= e21 * 1.002 && bar.close > e21;
    const touchedEMA21FromBelow = bar.high >= e21 * 0.998 && bar.close < e21;

    let signal = null;
    if (
      price > e200 &&           // macro bull
      e21 > e50 &&              // trend aligned
      touchedEMA21FromAbove &&  // price dipped to EMA21
      isBullCandle &&           // bounced (close > open)
      r >= 35 && r <= 60        // RSI: dip zone, not overbought
    ) signal = "long";

    if (
      price < e200 &&           // macro bear
      e21 < e50 &&              // trend aligned bear
      touchedEMA21FromBelow &&  // price rallied to EMA21
      isBearCandle &&           // rejected (close < open)
      r >= 40 && r <= 65        // RSI: rally zone, not oversold
    ) signal = "short";

    if (!signal) continue;

    const entry = bar.close;
    const risk$ = ACCOUNT * RISK_PCT;

    if (signal === "long") {
      const sl = bar.low * (1 - SL_BUFFER);
      if (sl >= entry) continue;
      const stopDist = entry - sl;
      const tp = entry + stopDist * REWARD_RATIO;
      const notional = risk$ / (stopDist / entry);
      position = { side: "long", entry, sl, tp, risk$, notional, i0: i };
    } else {
      const sl = bar.high * (1 + SL_BUFFER);
      if (sl <= entry) continue;
      const stopDist = sl - entry;
      const tp = entry - stopDist * REWARD_RATIO;
      const notional = risk$ / (stopDist / entry);
      position = { side: "short", entry, sl, tp, risk$, notional, i0: i };
    }
  }

  return trades;
}

async function main() {
  let all = [];
  const perCoin = {};

  for (const coin of COINS) {
    process.stdout.write(`${coin}...`);
    try {
      const candles = await fetchOKX(coin);
      const trades = backtestCoin(candles);
      all = all.concat(trades);
      perCoin[coin] = trades;
      const wins = trades.filter((t) => t.pnl > 0).length;
      const net = trades.reduce((s, t) => s + t.pnl, 0);
      console.log(` ${trades.length} trades | WR ${trades.length ? ((wins/trades.length)*100).toFixed(1) : "0"}% | Net $${net.toFixed(2)}`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
  }

  if (!all.length) { console.log("No trades."); return; }

  const wins = all.filter((t) => t.pnl > 0);
  const losses = all.filter((t) => t.pnl <= 0);
  const net = all.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  let equity = ACCOUNT, peak = ACCOUNT, maxDD = 0;
  for (const t of all) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const tpCount = all.filter((t) => t.result === "TP").length;
  const slCount = all.filter((t) => t.result === "SL").length;
  const toCount = all.filter((t) => t.result === "TIMEOUT").length;
  const longT = all.filter((t) => t.side === "long");
  const shortT = all.filter((t) => t.side === "short");
  const longWR = longT.length ? longT.filter(t=>t.pnl>0).length/longT.length*100 : 0;
  const shortWR = shortT.length ? shortT.filter(t=>t.pnl>0).length/shortT.length*100 : 0;

  console.log("\n═══════════ EMA21 PULLBACK BACKTEST RESULTS ════════════");
  console.log(`Period:        OKX 1H, 12 months, 8 coins`);
  console.log(`Total trades:  ${all.length}  (${(all.length/365).toFixed(1)}/day)`);
  console.log(`Win rate:      ${((wins.length/all.length)*100).toFixed(1)}%`);
  console.log(`Profit factor: ${pf.toFixed(2)}`);
  console.log(`Net P&L:       $${net.toFixed(2)} on $${ACCOUNT} (+${(net/ACCOUNT*100).toFixed(1)}%)`);
  console.log(`Max drawdown:  ${(maxDD*100).toFixed(1)}%`);
  console.log(`Longs:         ${longT.length} trades | WR ${longWR.toFixed(1)}%`);
  console.log(`Shorts:        ${shortT.length} trades | WR ${shortWR.toFixed(1)}%`);
  console.log(`TP: ${tpCount}  SL: ${slCount}  Timeout: ${toCount}`);
  console.log(`Final equity:  $${(ACCOUNT + net).toFixed(2)}`);
  console.log("════════════════════════════════════════════════════════");
}

main().catch(console.error);
