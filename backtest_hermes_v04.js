/**
 * Hermes v04 Backtest
 * Compares v03 (single TP 3%) vs v04 (partial TP: 50% at 1.5%, 50% at 3.0%, SL→BE after TP1)
 *
 * Assets: NEAR, SOL, BTC, ETH
 * Timeframe: 5m | Period: 30 days | Trade size: $50
 * Run: node backtest_hermes_v04.js
 */

const ASSETS     = ["NEAR-USDT", "BTC-USDT", "ETH-USDT", "SOL-USDT"];
const BAR        = "5m";
const TRADE_SIZE = 50;
const MAX_BARS   = 8640; // ~30 days

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, bar, totalBars) {
  const allCandles = [];
  let before = "";
  while (allCandles.length < totalBars) {
    const limit = Math.min(100, totalBars - allCandles.length);
    const url = before
      ? `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${bar}&limit=${limit}&before=${before}`
      : `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${bar}&limit=${limit}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.code !== "0" || !json.data.length) break;
    const batch = json.data.map((k) => ({
      time:  parseInt(k[0]),
      open:  parseFloat(k[1]),
      high:  parseFloat(k[2]),
      low:   parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
    allCandles.push(...batch);
    before = batch[batch.length - 1].time.toString();
    await new Promise((r) => setTimeout(r, 150));
  }
  return allCandles.reverse();
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

// ─── Entry signal ─────────────────────────────────────────────────────────────

function hermesSignal(closes, i, useTrendVote = false) {
  const price   = closes[i];
  const ema9    = calcEMA(closes.slice(0, i + 1), 9);
  const ema21   = calcEMA(closes.slice(0, i + 1), 21);
  const ema50   = calcEMA(closes.slice(0, i + 1), 50);
  const rsi     = calcRSI(closes.slice(0, i + 1), 14);
  const rsiPrev = calcRSI(closes.slice(0, i), 14);
  if (!ema9 || !ema21 || !ema50 || !rsi || !rsiPrev) return false;

  const bearStack = ema9 < ema21 && ema21 < ema50 && price < ema50;
  if (!bearStack) return false;

  // Trend strength vote (v05): 12/20 recent bars must be in bear stack
  if (useTrendVote) {
    const VOTE_BARS = 20, VOTE_MIN = 12;
    let votes = 0;
    for (let j = Math.max(0, i - VOTE_BARS + 1); j <= i; j++) {
      const cl = closes.slice(0, j + 1);
      const e9 = calcEMA(cl, 9), e21 = calcEMA(cl, 21), e50 = calcEMA(cl, 50);
      const p  = cl[cl.length - 1];
      if (e9 && e21 && e50 && e9 < e21 && e21 < e50 && p < e50) votes++;
    }
    if (votes < VOTE_MIN) return false;
  }

  const rsiWindow = [];
  for (let j = Math.max(0, i - 4); j <= i; j++) {
    const r = calcRSI(closes.slice(0, j + 1), 14);
    if (r) rsiWindow.push(r);
  }
  return rsiWindow.some((r) => r > 55) && rsiPrev >= 52 && rsi < 52 && rsi > 38;
}

// ─── v03: single TP at 3%, SL at 1.5% (no trend vote) ───────────────────────

function backtestV03(candles) {
  const closes = candles.map((c) => c.close);
  const trades = [];
  let pos = null;

  for (let i = 60; i < candles.length; i++) {
    const price = closes[i];

    if (pos) {
      const rsi = calcRSI(closes.slice(0, i + 1), 14);
      let exit = null, exitPrice = price;
      if (price <= pos.tp)      { exit = "tp";  exitPrice = pos.tp; }
      else if (price >= pos.sl) { exit = "sl";  exitPrice = pos.sl; }
      else if (rsi && rsi < 38) { exit = "rsi_oversold"; }

      if (exit) {
        const pnl = (pos.entry - exitPrice) / pos.entry * TRADE_SIZE;
        trades.push({ entry: pos.entry, exitPrice, pnl, exit });
        pos = null;
      }
    }

    if (!pos && hermesSignal(closes, i, false)) {
      pos = { entry: price, sl: price * 1.015, tp: price * 0.970 };
    }
  }
  return trades;
}

// ─── v05: partial TP + trend strength vote (12/20 bars) ──────────────────────

function backtestV05(candles) {
  const closes = candles.map((c) => c.close);
  const trades = [];
  let pos = null;

  for (let i = 60; i < candles.length; i++) {
    const price = closes[i];

    if (pos) {
      const rsi     = calcRSI(closes.slice(0, i + 1), 14);
      const activeSL = pos.tp1Hit ? pos.slBE : pos.sl;

      if (!pos.tp1Hit && price <= pos.tp1) {
        trades.push({ entry: pos.entry, exitPrice: pos.tp1, pnl: (pos.entry - pos.tp1) / pos.entry * (TRADE_SIZE * 0.5), exit: "tp1" });
        pos.tp1Hit = true; pos.slBE = pos.entry * 1.001;
      } else if (pos.tp1Hit && price <= pos.tp2) {
        trades.push({ entry: pos.entry, exitPrice: pos.tp2, pnl: (pos.entry - pos.tp2) / pos.entry * (TRADE_SIZE * 0.5), exit: "tp2" });
        pos = null;
      } else if (price >= activeSL) {
        const rem = pos.tp1Hit ? TRADE_SIZE * 0.5 : TRADE_SIZE;
        trades.push({ entry: pos.entry, exitPrice: activeSL, pnl: (pos.entry - activeSL) / pos.entry * rem, exit: pos.tp1Hit ? "sl_be" : "sl" });
        pos = null;
      } else if (rsi && rsi < 38) {
        const rem = pos.tp1Hit ? TRADE_SIZE * 0.5 : TRADE_SIZE;
        trades.push({ entry: pos.entry, exitPrice: price, pnl: (pos.entry - price) / pos.entry * rem, exit: "rsi_os" });
        pos = null;
      }
    }

    if (!pos && hermesSignal(closes, i, true)) {  // ← trend vote ON
      pos = { entry: closes[i], sl: closes[i]*1.015, tp1: closes[i]*0.985, tp2: closes[i]*0.970, slBE: null, tp1Hit: false };
    }
  }
  return trades;
}

// ─── v04: partial TP — 50% at 1.5%, SL→BE, rest at 3.0% ─────────────────────

function backtestV04(candles) {
  const closes = candles.map((c) => c.close);
  const trades = [];
  let pos = null;

  for (let i = 60; i < candles.length; i++) {
    const price = closes[i];

    if (pos) {
      const rsi     = calcRSI(closes.slice(0, i + 1), 14);
      const activeSL = pos.tp1Hit ? pos.slBE : pos.sl;

      // ── TP1 hit: close 50%, move SL to breakeven ────────────────────────
      if (!pos.tp1Hit && price <= pos.tp1) {
        const pnl1 = (pos.entry - pos.tp1) / pos.entry * (TRADE_SIZE * 0.5);
        trades.push({ entry: pos.entry, exitPrice: pos.tp1, pnl: pnl1, exit: "tp1_partial" });
        pos.tp1Hit = true;
        pos.slBE   = pos.entry * 1.001; // breakeven + tiny buffer

      // ── TP2 hit: close remaining 50% ────────────────────────────────────
      } else if (pos.tp1Hit && price <= pos.tp2) {
        const pnl2 = (pos.entry - pos.tp2) / pos.entry * (TRADE_SIZE * 0.5);
        trades.push({ entry: pos.entry, exitPrice: pos.tp2, pnl: pnl2, exit: "tp2_full" });
        pos = null;

      // ── SL hit ────────────────────────────────────────────────────────────
      } else if (price >= activeSL) {
        const remaining = pos.tp1Hit ? TRADE_SIZE * 0.5 : TRADE_SIZE;
        const pnl = (pos.entry - activeSL) / pos.entry * remaining;
        trades.push({ entry: pos.entry, exitPrice: activeSL, pnl, exit: pos.tp1Hit ? "sl_after_tp1" : "sl_full" });
        pos = null;

      // ── RSI oversold: close remaining ────────────────────────────────────
      } else if (rsi && rsi < 38) {
        const remaining = pos.tp1Hit ? TRADE_SIZE * 0.5 : TRADE_SIZE;
        const pnl = (pos.entry - price) / pos.entry * remaining;
        trades.push({ entry: pos.entry, exitPrice: price, pnl, exit: "rsi_oversold" });
        pos = null;
      }
    }

    if (!pos && hermesSignal(closes, i)) {
      pos = {
        entry: closes[i],
        sl:    closes[i] * 1.015,
        tp1:   closes[i] * 0.985,
        tp2:   closes[i] * 0.970,
        slBE:  null,
        tp1Hit: false,
      };
    }
  }
  return trades;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function stats(trades, label) {
  if (!trades.length) return { label, n: 0, wr: "—", pnl: "—", pf: "—", avgW: "—", avgL: "—" };
  const wins   = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const pnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const avgW   = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgL   = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const pf     = avgL > 0 ? (avgW * wins.length) / (avgL * losses.length) : 999;

  // Max drawdown
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    label, n: trades.length, wins: wins.length, losses: losses.length,
    wr:   (wins.length / trades.length * 100).toFixed(1) + "%",
    pnl:  "$" + pnl.toFixed(2),
    avgW: "$" + avgW.toFixed(2),
    avgL: "-$" + avgL.toFixed(2),
    pf:   pf.toFixed(2),
    maxDD: "$" + maxDD.toFixed(2),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  HERMES v03 vs v04 BACKTEST — 5m | 30 days | $50/trade                     ║");
  console.log("╠═══════════════╦═══════╦═════════╦════════════╦════════╦═══════╦═══════════╣");
  console.log("║ Asset         ║ Ver.  ║ Trades  ║  Win Rate  ║  P&L   ║  PF   ║ Max DD    ║");
  console.log("╠═══════════════╬═══════╬═════════╬════════════╬════════╬═══════╬═══════════╣");

  const allRows = [];

  for (const symbol of ASSETS) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchCandles(symbol, BAR, MAX_BARS);
    console.log(`${candles.length} bars`);

    const v03trades = backtestV03(candles);
    const v05trades = backtestV05(candles);

    const sv3 = stats(v03trades, "v03");
    const sv5 = stats(v05trades, "v05");

    allRows.push({ symbol, sv3, sv5 });

    const fmt = (s) => `║ ${symbol.padEnd(13)} ║ ${s.label.padEnd(5)} ║ ${String(s.n).padEnd(7)} ║ ${s.wr.padEnd(10)} ║ ${s.pnl.padEnd(6)} ║ ${s.pf.padEnd(5)} ║ ${s.maxDD.padEnd(9)} ║`;
    console.log(fmt(sv3));
    console.log(fmt(sv5));
    console.log("╠═══════════════╬═══════╬═════════╬════════════╬════════╬═══════╬═══════════╣");
  }

  console.log("╚═══════════════╩═══════╩═════════╩════════════╩════════╩═══════╩═══════════╝");

  console.log("\n📊 IMPROVEMENT SUMMARY (v05 trend-vote vs v03 baseline):");
  for (const { symbol, sv3, sv5 } of allRows) {
    if (sv3.n === 0) continue;
    const pnlDiff = (parseFloat(sv5.pnl.replace("$","").replace("-$","-")) - parseFloat(sv3.pnl.replace("$","").replace("-$","-"))).toFixed(2);
    const sign = pnlDiff >= 0 ? "+" : "";
    const tradeChange = sv5.n - sv3.n;
    const tradeSign = tradeChange >= 0 ? "+" : "";
    console.log(`  ${symbol}: WR ${sv3.wr} → ${sv5.wr} | P&L ${sv3.pnl} → ${sv5.pnl} (${sign}$${pnlDiff}) | Trades ${sv3.n}→${sv5.n} (${tradeSign}${tradeChange}) | MaxDD ${sv3.maxDD} → ${sv5.maxDD}`);
  }

  console.log("\n✅ Done.\n");
})();
