/**
 * Backtest: MACD + RSI + 200 SMA Strategy on 4H
 *
 * Source: StratBase.ai documented study — PF 1.72, WR 58%, BTC 4H (2021-2024)
 * Reference: "RSI + MACD Combo Strategy: Full Backtest Results on BTC"
 *
 * Rules (exactly as documented):
 *   LONG:  MACD line crosses ABOVE signal line
 *          + RSI(14) < 60  (not already overbought — avoids late entries)
 *          + Price > SMA200 (macro uptrend only)
 *
 *   SHORT: MACD line crosses BELOW signal line
 *          + RSI(14) > 40  (not already oversold)
 *          + Price < SMA200 (macro downtrend only)
 *
 *   Exit:  RSI crosses above 75 (overbought exit = TP)
 *          OR MACD crosses back against the trade (momentum reversal exit)
 *          OR max hold 30 bars (5 days on 4H = 30 bars)
 *
 * This is NOT a fixed TP/SL strategy — it exits on signal reversal.
 * For the scanner: also show a suggested SL (recent swing low/high) and
 * estimated TP (when RSI would reach 75/25).
 *
 * OKX 4H data, 12 months, 8 coins
 */

import https from "https";

const COINS = ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","NEAR-USDT","AVAX-USDT","TRX-USDT"];
const ACCOUNT = 500;
const RISK_PCT = 0.01;
const MAX_HOLD = 30;   // 30 × 4H = 5 days max

function okxGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "MACD-RSI-BT/1.0" } }, (res) => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOKX(symbol, bar = "4H") {
  const RECENT = "https://www.okx.com/api/v5/market/candles";
  const HIST   = "https://www.okx.com/api/v5/market/history-candles";
  const all = [];
  const r0 = await okxGet(`${RECENT}?instId=${symbol}&bar=${bar}&limit=300`);
  if (r0.data?.length) all.push(...r0.data);
  await sleep(250);
  let after = all.length ? all[all.length-1][0] : "";
  for (let p = 0; p < 30; p++) {
    const d = await okxGet(`${HIST}?instId=${symbol}&bar=${bar}&limit=100${after?"&after="+after:""}`);
    if (!d.data?.length) break;
    all.push(...d.data);
    after = d.data[d.data.length-1][0];
    await sleep(200);
  }
  const cutoff = Date.now() - 365*24*60*60*1000;
  return all.filter(c => Number(c[0]) >= cutoff)
    .sort((a,b) => Number(a[0]) - Number(b[0]))
    .map(c => ({ ts:Number(c[0]), open:parseFloat(c[1]), high:parseFloat(c[2]), low:parseFloat(c[3]), close:parseFloat(c[4]), vol:parseFloat(c[5]) }));
}

function calcEMA(closes, period) {
  const k = 2/(period+1);
  const ema = new Array(closes.length).fill(null);
  if (closes.length < period) return ema;
  let s = 0; for (let i=0;i<period;i++) s+=closes[i];
  ema[period-1]=s/period;
  for (let i=period;i<closes.length;i++) ema[i]=closes[i]*k+ema[i-1]*(1-k);
  return ema;
}

function calcSMA(closes, period) {
  const sma = new Array(closes.length).fill(null);
  for (let i=period-1;i<closes.length;i++) {
    sma[i]=closes.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period;
  }
  return sma;
}

function calcMACD(closes, fast=12, slow=26, signal=9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_,i) => emaFast[i]!==null && emaSlow[i]!==null ? emaFast[i]-emaSlow[i] : null);
  // Signal line = EMA(9) of MACD line
  const validStart = macdLine.findIndex(v => v !== null);
  const signalInput = macdLine.slice(validStart);
  const signalEMA = calcEMA(signalInput.map(v => v ?? 0), signal);
  const signalLine = new Array(validStart).fill(null).concat(signalEMA);
  const hist = macdLine.map((m,i) => m!==null && signalLine[i]!==null ? m-signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function calcRSI(closes, period=14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period+1) return rsi;
  let ag=0, al=0;
  for (let i=1;i<=period;i++) { const d=closes[i]-closes[i-1]; if(d>0)ag+=d; else al-=d; }
  ag/=period; al/=period;
  rsi[period]=al===0?100:100-100/(1+ag/al);
  for (let i=period+1;i<closes.length;i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period;
    al=(al*(period-1)+Math.max(-d,0))/period;
    rsi[i]=al===0?100:100-100/(1+ag/al);
  }
  return rsi;
}

function backtestCoin(candles, symbol) {
  const closes = candles.map(c=>c.close);
  const sma200 = calcSMA(closes, 200);
  const { macdLine, signalLine } = calcMACD(closes);
  const rsi = calcRSI(closes, 14);

  const trades = [];
  let position = null;
  const WARMUP = 240;

  for (let i=WARMUP;i<candles.length;i++) {
    const bar = candles[i];
    const ml=macdLine[i], sl=signalLine[i], ml_p=macdLine[i-1], sl_p=signalLine[i-1];
    const r=rsi[i], r_p=rsi[i-1];
    const s200=sma200[i];
    if (ml===null||sl===null||ml_p===null||sl_p===null||r===null||r_p===null||!s200) continue;

    const price=bar.close;

    // Manage position — exits based on MACD cross back OR RSI extreme
    if (position) {
      const macdCrossAgainstLong = ml_p>sl_p && ml<=sl; // MACD crosses back below signal
      const macdCrossAgainstShort = ml_p<sl_p && ml>=sl;
      const rsiOverbought = r_p<75 && r>=75;            // RSI crosses above 75 (exit long)
      const rsiOversold = r_p>25 && r<=25;              // RSI crosses below 25 (exit short)
      const maxHold = i-position.i0>=MAX_HOLD;

      let exitPrice = null;
      let exitReason = null;

      if (position.side==="long") {
        if (rsiOverbought)           { exitPrice=bar.close; exitReason="RSI_OB_EXIT"; }
        else if (macdCrossAgainstLong) { exitPrice=bar.close; exitReason="MACD_EXIT"; }
        else if (maxHold)             { exitPrice=bar.close; exitReason="TIMEOUT"; }
      } else {
        if (rsiOversold)              { exitPrice=bar.close; exitReason="RSI_OS_EXIT"; }
        else if (macdCrossAgainstShort){ exitPrice=bar.close; exitReason="MACD_EXIT"; }
        else if (maxHold)             { exitPrice=bar.close; exitReason="TIMEOUT"; }
      }

      if (exitPrice !== null) {
        let pnl;
        if (position.side==="long") {
          pnl=(exitPrice-position.entry)/position.entry*position.notional;
        } else {
          pnl=(position.entry-exitPrice)/position.entry*position.notional;
        }
        trades.push({
          side:position.side, pnl, result:exitReason,
          bars:i-position.i0, entry:position.entry, exit:exitPrice,
          entryRsi:position.entryRsi
        });
        position=null;
      }
    }

    if (position) continue;

    // Entry signals
    const macdCrossUp   = ml_p<=sl_p && ml>sl;   // MACD crosses above signal
    const macdCrossDown = ml_p>=sl_p && ml<sl;   // MACD crosses below signal

    let signal=null;
    if (macdCrossUp   && r<60 && price>s200) signal="long";
    if (macdCrossDown && r>40 && price<s200) signal="short";

    if (!signal) continue;

    const entry=bar.close;
    // Stop: recent 10-bar swing low (long) or high (short)
    let sl_price;
    if (signal==="long") {
      sl_price = Math.min(...candles.slice(Math.max(0,i-10),i+1).map(c=>c.low));
    } else {
      sl_price = Math.max(...candles.slice(Math.max(0,i-10),i+1).map(c=>c.high));
    }
    const stopDist = Math.abs(entry-sl_price);
    const risk$ = ACCOUNT*RISK_PCT;
    const notional = stopDist>0 ? risk$/(stopDist/entry) : risk$/0.02;

    position={side:signal, entry, sl:sl_price, risk$, notional, i0:i, entryRsi:r};
  }

  return trades;
}

async function main() {
  let all=[];
  const coinResults = {};

  for (const coin of COINS) {
    process.stdout.write(`${coin} 4H...`);
    try {
      const candles=await fetchOKX(coin,"4H");
      const trades=backtestCoin(candles, coin);
      all=all.concat(trades);
      coinResults[coin]=trades;
      const wins=trades.filter(t=>t.pnl>0).length;
      const net=trades.reduce((s,t)=>s+t.pnl,0);
      const pf_c = trades.length ? (() => {
        const gw=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
        const gl=Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
        return gl>0?(gw/gl).toFixed(2):"∞";
      })() : "N/A";
      console.log(` ${candles.length} bars | ${trades.length} trades | WR ${trades.length?((wins/trades.length)*100).toFixed(1):"0"}% | PF ${pf_c} | Net $${net.toFixed(2)}`);
    } catch(e) { console.log(` ERROR: ${e.message}`); }
  }

  if (!all.length) { console.log("No trades."); return; }

  const wins=all.filter(t=>t.pnl>0);
  const losses=all.filter(t=>t.pnl<=0);
  const net=all.reduce((s,t)=>s+t.pnl,0);
  const grossWin=wins.reduce((s,t)=>s+t.pnl,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf=grossLoss>0?grossWin/grossLoss:Infinity;
  let equity=ACCOUNT,peak=ACCOUNT,maxDD=0;
  for (const t of all) {
    equity+=t.pnl;
    if(equity>peak)peak=equity;
    const dd=(peak-equity)/peak;
    if(dd>maxDD)maxDD=dd;
  }
  const exits={};
  all.forEach(t=>{ exits[t.result]=(exits[t.result]||0)+1; });
  const longs=all.filter(t=>t.side==="long");
  const shorts=all.filter(t=>t.side==="short");

  const tradesPerMonth = (all.length/12).toFixed(1);
  const barsPerTrade = (all.reduce((s,t)=>s+t.bars,0)/all.length).toFixed(1);
  const avgHold4H = ((all.reduce((s,t)=>s+t.bars,0)/all.length)*4).toFixed(0);

  console.log("\n═══════════ MACD+RSI+SMA200 on 4H — RESULTS ══════════");
  console.log(`Period:        OKX 4H, 12 months, 8 coins`);
  console.log(`Total trades:  ${all.length}  (~${tradesPerMonth}/month, ${(all.length/365*30).toFixed(1)}/month)`);
  console.log(`Win rate:      ${((wins.length/all.length)*100).toFixed(1)}%`);
  console.log(`Profit factor: ${pf.toFixed(2)}`);
  console.log(`Net P&L:       $${net.toFixed(2)} on $${ACCOUNT} (+${(net/ACCOUNT*100).toFixed(1)}%)`);
  console.log(`Max drawdown:  ${(maxDD*100).toFixed(1)}%`);
  console.log(`Avg hold:      ${barsPerTrade} bars = ~${avgHold4H}H (${(avgHold4H/24).toFixed(1)} days)`);
  console.log(`Longs:  ${longs.length} trades | WR ${longs.length?(longs.filter(t=>t.pnl>0).length/longs.length*100).toFixed(1):0}%`);
  console.log(`Shorts: ${shorts.length} trades | WR ${shorts.length?(shorts.filter(t=>t.pnl>0).length/shorts.length*100).toFixed(1):0}%`);
  console.log(`Exit reasons:  ${Object.entries(exits).map(([k,v])=>`${k}:${v}`).join("  ")}`);
  console.log(`Final equity:  $${(ACCOUNT+net).toFixed(2)}`);
  console.log("═══════════════════════════════════════════════════════");

  // Show per-coin ranked
  console.log("\nPer-coin ranking (best to worst):");
  const ranked = Object.entries(coinResults)
    .map(([coin,trades]) => ({
      coin,
      n:trades.length,
      wr:trades.length?trades.filter(t=>t.pnl>0).length/trades.length*100:0,
      net:trades.reduce((s,t)=>s+t.pnl,0),
      pf: (() => { const gw=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0); const gl=Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)); return gl>0?gw/gl:Infinity; })()
    }))
    .sort((a,b)=>b.net-a.net);

  ranked.forEach(({coin,n,wr,net,pf}) =>
    console.log(`  ${coin.replace("-USDT","").padEnd(5)} ${n.toString().padStart(3)} trades | WR ${wr.toFixed(1).padStart(4)}% | PF ${pf.toFixed(2)} | Net $${net.toFixed(2)}`)
  );
}

main().catch(console.error);
