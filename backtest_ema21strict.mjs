/**
 * Backtest: EMA21 Pullback STRICT — tighter signal quality
 *
 * Same core logic as ema21bounce but with 3 extra quality filters:
 *   1. RSI(14) must have been ≤ 38 within last 4 bars (real pullback, not just touch)
 *   2. Bounce candle body ≥ 0.4% of price (not a doji / tiny candle)
 *   3. ATR ratio: current ATR14 / SMA(ATR14, 50) < 1.5  (skip extreme volatility)
 *   4. BTC daily macro gate: only longs in bull, only shorts in bear (same as V8)
 *
 * Target: fewer, higher-quality signals → better WR and PF
 *
 * OKX 1H, 12 months, 8 coins
 */

import https from "https";

const COINS = ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","NEAR-USDT","AVAX-USDT","TRX-USDT"];
const ACCOUNT = 500;
const RISK_PCT = 0.01;
const REWARD_RATIO = 2;
const MAX_HOLD = 48;
const SL_BUFFER = 0.001;
const ATR_RATIO_MAX = 1.5;
const RSI_DIP_THRESHOLD = 38;   // RSI must have been here within 4 bars
const RSI_SPIKE_THRESHOLD = 62; // for shorts
const MIN_BODY_PCT = 0.004;     // candle body must be ≥ 0.4% of price

function okxGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "EMA21S-BT/1.0" } }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
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
  let after = all.length ? all[all.length-1][0] : "";
  for (let p = 0; p < 90; p++) {
    const d = await okxGet(`${HIST}?instId=${symbol}&bar=1H&limit=100${after?"&after="+after:""}`);
    if (!d.data?.length) break;
    all.push(...d.data);
    after = d.data[d.data.length-1][0];
    await sleep(200);
  }
  const cutoff = Date.now() - 365*24*60*60*1000;
  return all.filter(c=>Number(c[0])>=cutoff)
    .sort((a,b)=>Number(a[0])-Number(b[0]))
    .map(c=>({ ts:Number(c[0]), open:parseFloat(c[1]), high:parseFloat(c[2]), low:parseFloat(c[3]), close:parseFloat(c[4]), vol:parseFloat(c[5]) }));
}

async function fetchBTCDaily() {
  const RECENT = "https://www.okx.com/api/v5/market/candles";
  const HIST   = "https://www.okx.com/api/v5/market/history-candles";
  const all = [];
  const r0 = await okxGet(`${RECENT}?instId=BTC-USDT&bar=1D&limit=300`);
  if (r0.data?.length) all.push(...r0.data);
  await sleep(300);
  let after = all.length ? all[all.length-1][0] : "";
  for (let p = 0; p < 5; p++) {
    const d = await okxGet(`${HIST}?instId=BTC-USDT&bar=1D&limit=100${after?"&after="+after:""}`);
    if (!d.data?.length) break;
    all.push(...d.data);
    after = d.data[d.data.length-1][0];
    await sleep(200);
  }
  return all.sort((a,b)=>Number(a[0])-Number(b[0]))
    .map(c=>({ ts:Number(c[0]), close:parseFloat(c[4]) }));
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

function calcRSI(closes, period=14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period+1) return rsi;
  let ag=0,al=0;
  for (let i=1;i<=period;i++) { const d=closes[i]-closes[i-1]; if(d>0)ag+=d;else al-=d; }
  ag/=period; al/=period;
  rsi[period] = al===0?100:100-100/(1+ag/al);
  for (let i=period+1;i<closes.length;i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period;
    al=(al*(period-1)+Math.max(-d,0))/period;
    rsi[i]=al===0?100:100-100/(1+ag/al);
  }
  return rsi;
}

function calcATRSeries(candles, period=14) {
  const atrs = new Array(candles.length).fill(null);
  let sum=0;
  for (let i=1;i<=period;i++) {
    const tr=Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close));
    sum+=tr;
  }
  atrs[period]=sum/period;
  for (let i=period+1;i<candles.length;i++) {
    const tr=Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close));
    atrs[i]=(atrs[i-1]*(period-1)+tr)/period;
  }
  return atrs;
}

function calcSMA(arr, period) {
  const sma = new Array(arr.length).fill(null);
  for (let i=period-1;i<arr.length;i++) {
    const slice = arr.slice(i-period+1,i+1).filter(v=>v!==null);
    if (slice.length===period) sma[i]=slice.reduce((a,b)=>a+b,0)/period;
  }
  return sma;
}

// Build a per-hourly-bar lookup of BTC daily bull/bear
function buildBTCMacroMap(dailyCandles) {
  // SMA200 of daily closes
  const closes = dailyCandles.map(c=>c.close);
  const sma200 = [];
  for (let i=0;i<closes.length;i++) {
    if (i<199) { sma200.push(null); continue; }
    sma200.push(closes.slice(i-199,i+1).reduce((a,b)=>a+b,0)/200);
  }
  // Map: dayStart timestamp (ms) → bull bool
  const map = new Map();
  dailyCandles.forEach((d,i) => {
    if (sma200[i]!==null) map.set(d.ts, closes[i] > sma200[i]);
  });
  return map;
}

function getDailyBull(btcMacroMap, hourTs) {
  // Find the most recent daily bar whose timestamp is ≤ hourTs
  let result = null;
  for (const [ts, bull] of btcMacroMap) {
    if (ts <= hourTs) result = bull;
    else break;
  }
  return result;
}

function backtestCoin(candles, btcMacroMap) {
  const closes = candles.map(c=>c.close);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const atrSeries = calcATRSeries(candles, 14);
  const atrSma50 = calcSMA(atrSeries, 50);

  const trades = [];
  let position = null;
  const WARMUP = 250;

  for (let i=WARMUP;i<candles.length;i++) {
    const bar = candles[i];

    // Manage position
    if (position) {
      let closed=false;
      if (position.side==="long") {
        if (bar.low<=position.sl) { trades.push({side:"long",pnl:-position.risk$,result:"SL",bars:i-position.i0}); closed=true; }
        else if (bar.high>=position.tp) { trades.push({side:"long",pnl:position.risk$*REWARD_RATIO,result:"TP",bars:i-position.i0}); closed=true; }
        else if (i-position.i0>=MAX_HOLD) { const p=(bar.close-position.entry)/position.entry*position.notional; trades.push({side:"long",pnl:p,result:"TIMEOUT",bars:MAX_HOLD}); closed=true; }
      } else {
        if (bar.high>=position.sl) { trades.push({side:"short",pnl:-position.risk$,result:"SL",bars:i-position.i0}); closed=true; }
        else if (bar.low<=position.tp) { trades.push({side:"short",pnl:position.risk$*REWARD_RATIO,result:"TP",bars:i-position.i0}); closed=true; }
        else if (i-position.i0>=MAX_HOLD) { const p=(position.entry-bar.close)/position.entry*position.notional; trades.push({side:"short",pnl:p,result:"TIMEOUT",bars:MAX_HOLD}); closed=true; }
      }
      if (closed) position=null;
      if (position) continue;
    }

    const e21=ema21[i], e50=ema50[i], e200=ema200[i], r=rsi[i];
    const atr=atrSeries[i], aSmaSMA=atrSma50[i];
    if (!e21||!e50||!e200||r===null||!atr||!aSmaSMA) continue;

    // ATR ratio filter
    const atrRatio = atr/aSmaSMA;
    if (atrRatio > ATR_RATIO_MAX) continue;

    // BTC macro gate
    const btcBull = getDailyBull(btcMacroMap, bar.ts);
    if (btcBull === null) continue;

    const price = bar.close;
    const isBullCandle = bar.close > bar.open;
    const isBearCandle = bar.close < bar.open;
    const bodyPct = Math.abs(bar.close - bar.open) / bar.open;

    // RSI depth check: was RSI ≤ threshold within last 4 bars?
    const rsiDipped = rsi.slice(Math.max(0,i-4),i+1).some(v=>v!==null && v<=RSI_DIP_THRESHOLD);
    const rsiSpiked = rsi.slice(Math.max(0,i-4),i+1).some(v=>v!==null && v>=RSI_SPIKE_THRESHOLD);

    const touchedEMA21Above = bar.low<=e21*1.002 && bar.close>e21;
    const touchedEMA21Below = bar.high>=e21*0.998 && bar.close<e21;

    let signal=null;
    if (btcBull &&
        price>e200 && e21>e50 &&
        touchedEMA21Above && isBullCandle &&
        bodyPct>=MIN_BODY_PCT &&
        rsiDipped &&
        r>=38 && r<=62) signal="long";

    if (!btcBull &&
        price<e200 && e21<e50 &&
        touchedEMA21Below && isBearCandle &&
        bodyPct>=MIN_BODY_PCT &&
        rsiSpiked &&
        r>=38 && r<=62) signal="short";

    if (!signal) continue;

    const entry=bar.close;
    const risk$=ACCOUNT*RISK_PCT;

    if (signal==="long") {
      const sl=bar.low*(1-SL_BUFFER);
      if (sl>=entry) continue;
      const stopDist=entry-sl;
      const tp=entry+stopDist*REWARD_RATIO;
      const notional=risk$/(stopDist/entry);
      position={side:"long",entry,sl,tp,risk$,notional,i0:i};
    } else {
      const sl=bar.high*(1+SL_BUFFER);
      if (sl<=entry) continue;
      const stopDist=sl-entry;
      const tp=entry-stopDist*REWARD_RATIO;
      const notional=risk$/(stopDist/entry);
      position={side:"short",entry,sl,tp,risk$,notional,i0:i};
    }
  }
  return trades;
}

async function main() {
  process.stdout.write("Fetching BTC daily data...");
  const btcDaily = await fetchBTCDaily();
  const btcMacroMap = buildBTCMacroMap(btcDaily);
  console.log(` ${btcDaily.length} daily bars`);

  let all=[];
  for (const coin of COINS) {
    process.stdout.write(`${coin}...`);
    try {
      const candles = await fetchOKX(coin);
      const trades = backtestCoin(candles, btcMacroMap);
      all=all.concat(trades);
      const wins=trades.filter(t=>t.pnl>0).length;
      const net=trades.reduce((s,t)=>s+t.pnl,0);
      console.log(` ${trades.length} trades | WR ${trades.length?((wins/trades.length)*100).toFixed(1):"0"}% | Net $${net.toFixed(2)}`);
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
  const tpC=all.filter(t=>t.result==="TP").length;
  const slC=all.filter(t=>t.result==="SL").length;
  const toC=all.filter(t=>t.result==="TIMEOUT").length;
  const longs=all.filter(t=>t.side==="long");
  const shorts=all.filter(t=>t.side==="short");

  console.log("\n════════ EMA21 STRICT BACKTEST RESULTS ════════");
  console.log(`Total trades:  ${all.length}  (${(all.length/365).toFixed(1)}/day)`);
  console.log(`Win rate:      ${((wins.length/all.length)*100).toFixed(1)}%`);
  console.log(`Profit factor: ${pf.toFixed(2)}`);
  console.log(`Net P&L:       $${net.toFixed(2)} on $${ACCOUNT} (+${(net/ACCOUNT*100).toFixed(1)}%)`);
  console.log(`Max drawdown:  ${(maxDD*100).toFixed(1)}%`);
  console.log(`Longs: ${longs.length} (WR ${longs.length?(longs.filter(t=>t.pnl>0).length/longs.length*100).toFixed(1):0}%) | Shorts: ${shorts.length} (WR ${shorts.length?(shorts.filter(t=>t.pnl>0).length/shorts.length*100).toFixed(1):0}%)`);
  console.log(`TP: ${tpC}  SL: ${slC}  Timeout: ${toC}`);
  console.log(`Final equity:  $${(ACCOUNT+net).toFixed(2)}`);
  console.log("════════════════════════════════════════════════");
}

main().catch(console.error);
