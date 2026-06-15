/**
 * Backtest: Supertrend + EMA Momentum Strategy
 *
 * NEW strategy — completely different from V2/V8 (no RSI dip buying):
 *
 *   Supertrend(10, 3.0): ATR-based trailing stop that flips Bull/Bear
 *   LONG:  Supertrend flips BULL (bear→bull) + Price > EMA50 + RSI(14) between 45–70
 *   SHORT: Supertrend flips BEAR (bull→bear) + Price < EMA50 + RSI(14) between 30–55
 *
 *   Entry:  Close of flip candle
 *   Stop:   Supertrend line value at entry (natural adaptive stop)
 *   Target: 2× risk (2:1 RR)
 *   Max hold: 72 bars (3 days), then exit at market
 *
 * OKX 1H data, 12 months (~8760 bars), 8 coins
 */

import https from "https";

const COINS = ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","NEAR-USDT","AVAX-USDT","TRX-USDT"];
const ACCOUNT = 500;
const RISK_PCT = 0.01;     // 1% risk per trade
const REWARD_RATIO = 2;    // 2:1 RR
const MAX_HOLD = 72;       // bars
const ST_PERIOD = 10;      // Supertrend ATR period
const ST_MULT = 3.0;       // Supertrend multiplier

// ─── Paginated OKX fetch (same approach as backtest_v8_frequency.mjs) ──────────
function okxGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "ST-Backtest/1.0" } }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchOKX(symbol, bar = "1H", pages = 90) {
  const RECENT = "https://www.okx.com/api/v5/market/candles";
  const HIST   = "https://www.okx.com/api/v5/market/history-candles";
  const all = [];

  // Most recent 300 bars
  const r0 = await okxGet(`${RECENT}?instId=${symbol}&bar=${bar}&limit=300`);
  if (r0.data?.length) all.push(...r0.data);
  await sleep(250);

  // Paginate backwards
  let after = all.length ? all[all.length - 1][0] : "";
  for (let p = 0; p < pages; p++) {
    const url = `${HIST}?instId=${symbol}&bar=${bar}&limit=100${after ? "&after=" + after : ""}`;
    const d = await okxGet(url);
    if (!d.data?.length) break;
    all.push(...d.data);
    after = d.data[d.data.length - 1][0];
    await sleep(200);
  }

  // Filter to 12 months and sort ascending
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
      vol: parseFloat(c[5]),
    }));
}

// ─── Supertrend ──────────────────────────────────────────────────────────────
// Returns array of { value, bull } for each bar
function calcSupertrend(candles, period = ST_PERIOD, mult = ST_MULT) {
  const n = candles.length;
  const atr = new Array(n).fill(0);
  const upper = new Array(n).fill(0);
  const lower = new Array(n).fill(0);
  const st = new Array(n).fill(0);
  const bull = new Array(n).fill(true);

  // ATR
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr[i] = i < period ? tr : (atr[i - 1] * (period - 1) + tr) / period;
  }

  for (let i = period; i < n; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    upper[i] = hl2 + mult * atr[i];
    lower[i] = hl2 - mult * atr[i];

    // Final upper/lower (never move against trend)
    const fu = upper[i - 1] !== 0 && upper[i] > upper[i - 1] ? upper[i - 1] : upper[i];
    const fl = lower[i - 1] !== 0 && lower[i] < lower[i - 1] ? lower[i - 1] : lower[i];
    upper[i] = fu;
    lower[i] = fl;

    // Direction
    if (bull[i - 1]) {
      bull[i] = candles[i].close >= lower[i];
      st[i] = bull[i] ? lower[i] : upper[i];
    } else {
      bull[i] = candles[i].close > upper[i];
      st[i] = bull[i] ? lower[i] : upper[i];
    }
  }

  return candles.map((_, i) => ({ value: st[i], bull: bull[i] }));
}

// ─── EMA ────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period && i < closes.length; i++) sum += closes[i];
  if (closes.length >= period) {
    ema[period - 1] = sum / period;
    for (let i = period; i < closes.length; i++) {
      ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

// ─── RSI ────────────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// ─── Backtest one coin ───────────────────────────────────────────────────────
function backtestCoin(candles) {
  const closes = candles.map((c) => c.close);
  const ema50 = calcEMA(closes, 50);
  const rsi14 = calcRSI(closes, 14);
  const stData = calcSupertrend(candles);

  const trades = [];
  let position = null;
  const WARMUP = 60;

  for (let i = WARMUP; i < candles.length; i++) {
    // Manage position
    if (position) {
      const bar = candles[i];
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
        } else if (!stData[i].bull) {
          // Supertrend flipped against us — early exit to protect
          const pnl = (bar.close - position.entry) / position.entry * position.notional;
          trades.push({ side: "long", pnl, result: "ST_FLIP", bars: i - position.i0 });
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
        } else if (stData[i].bull) {
          const pnl = (position.entry - bar.close) / position.entry * position.notional;
          trades.push({ side: "short", pnl, result: "ST_FLIP", bars: i - position.i0 });
          closed = true;
        }
      }

      if (closed) position = null;
      if (position) continue;
    }

    // Signal detection
    const st = stData[i];
    const stPrev = stData[i - 1];
    const e50 = ema50[i];
    const r = rsi14[i];

    if (!st || !stPrev || !e50 || r === null) continue;

    const flipBull = !stPrev.bull && st.bull;   // supertrend flipped to bull
    const flipBear = stPrev.bull && !st.bull;   // supertrend flipped to bear

    const price = candles[i].close;

    let signal = null;
    if (flipBull && price > e50 && r >= 45 && r <= 70) signal = "long";
    if (flipBear && price < e50 && r >= 30 && r <= 55) signal = "short";

    if (!signal) continue;

    const entry = price;
    const stLine = st.value;
    const risk$ = ACCOUNT * RISK_PCT;

    if (signal === "long") {
      const sl = stLine;                    // Supertrend line = natural stop
      if (sl >= entry) continue;            // bad setup (shouldn't happen)
      const stopDist = entry - sl;
      const tp = entry + stopDist * REWARD_RATIO;
      const notional = risk$ / (stopDist / entry);
      position = { side: "long", entry, sl, tp, risk$, notional, i0: i };
    } else {
      const sl = stLine;
      if (sl <= entry) continue;
      const stopDist = sl - entry;
      const tp = entry - stopDist * REWARD_RATIO;
      const notional = risk$ / (stopDist / entry);
      position = { side: "short", entry, sl, tp, risk$, notional, i0: i };
    }
  }

  return trades;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  let all = [];

  for (const coin of COINS) {
    process.stdout.write(`Fetching + backtesting ${coin}...`);
    try {
      const candles = await fetchOKX(coin, "1H", 90);
      const trades = backtestCoin(candles);
      all = all.concat(trades);

      const wins = trades.filter((t) => t.pnl > 0).length;
      const net = trades.reduce((s, t) => s + t.pnl, 0);
      console.log(
        ` ${candles.length} bars | ${trades.length} trades | WR ${trades.length ? ((wins/trades.length)*100).toFixed(1) : "0"}% | Net $${net.toFixed(2)}`
      );
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
  }

  if (!all.length) { console.log("No trades found."); return; }

  const wins = all.filter((t) => t.pnl > 0);
  const losses = all.filter((t) => t.pnl <= 0);
  const net = all.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  // Drawdown
  let equity = ACCOUNT, peak = ACCOUNT, maxDD = 0;
  for (const t of all) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const tpCount  = all.filter((t) => t.result === "TP").length;
  const slCount  = all.filter((t) => t.result === "SL").length;
  const toCount  = all.filter((t) => t.result === "TIMEOUT").length;
  const sfCount  = all.filter((t) => t.result === "ST_FLIP").length;
  const longTrades  = all.filter((t) => t.side === "long");
  const shortTrades = all.filter((t) => t.side === "short");
  const longWR  = longTrades.length ? longTrades.filter(t=>t.pnl>0).length/longTrades.length*100 : 0;
  const shortWR = shortTrades.length ? shortTrades.filter(t=>t.pnl>0).length/shortTrades.length*100 : 0;
  const tradesPerDay = (all.length / 365).toFixed(2);

  console.log("\n═══════════ SUPERTREND + EMA BACKTEST RESULTS ════════════");
  console.log(`Period:         OKX 1H, 12 months, 8 coins`);
  console.log(`Total trades:   ${all.length}  (${tradesPerDay}/day avg)`);
  console.log(`Win rate:       ${((wins.length/all.length)*100).toFixed(1)}%`);
  console.log(`Profit factor:  ${pf.toFixed(2)}`);
  console.log(`Net P&L:        $${net.toFixed(2)} on $${ACCOUNT} account (+${(net/ACCOUNT*100).toFixed(1)}%)`);
  console.log(`Avg win:        $${avgWin.toFixed(2)}  |  Avg loss: $${avgLoss.toFixed(2)}`);
  console.log(`Max drawdown:   ${(maxDD*100).toFixed(1)}%`);
  console.log(`Longs:          ${longTrades.length} trades | WR ${longWR.toFixed(1)}%`);
  console.log(`Shorts:         ${shortTrades.length} trades | WR ${shortWR.toFixed(1)}%`);
  console.log(`Exits → TP: ${tpCount}  SL: ${slCount}  Timeout: ${toCount}  ST-Flip: ${sfCount}`);
  console.log(`Final equity:   $${(ACCOUNT + net).toFixed(2)}`);
  console.log("══════════════════════════════════════════════════════════");
}

main().catch(console.error);
