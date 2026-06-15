/**
 * Backtest: RSI14 Momentum Cross Strategy
 *
 * LONG:  EMA50 > EMA200 (trend up) + RSI(14) crosses above 55 (momentum confirmed)
 *        + price > EMA50 + ATR ratio < 1.5 (not in spike volatility)
 *
 * SHORT: EMA50 < EMA200 (trend down) + RSI(14) crosses below 45 (momentum confirmed)
 *        + price < EMA50 + ATR ratio < 1.5
 *
 * Entry:  Close of signal candle
 * Stop:   EMA50 − 0.8% for longs (below dynamic support) / EMA50 + 0.8% for shorts
 * Target: 2× risk (2:1 RR)
 * Max hold: 48 bars
 * Cooldown: 3 bars between signals on the same coin
 *
 * OKX 1H, 12 months, 8 coins
 */

import https from "https";

const COINS = ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","NEAR-USDT","AVAX-USDT","TRX-USDT"];
const ACCOUNT = 500;
const RISK_PCT = 0.01;
const REWARD_RATIO = 2;
const MAX_HOLD = 48;
const ATR_MAX = 1.5;
const COOLDOWN = 3;
const RSI_LONG_CROSS = 55;
const RSI_SHORT_CROSS = 45;

function okxGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RSI-BT/1.0" } }, (res) => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  return all.filter(c => Number(c[0]) >= cutoff)
    .sort((a,b) => Number(a[0]) - Number(b[0]))
    .map(c => ({ ts:Number(c[0]), open:parseFloat(c[1]), high:parseFloat(c[2]), low:parseFloat(c[3]), close:parseFloat(c[4]), vol:parseFloat(c[5]) }));
}

function calcEMA(closes, period) {
  const k = 2/(period+1);
  const ema = new Array(closes.length).fill(null);
  if (closes.length < period) return ema;
  let s = 0; for (let i=0;i<period;i++) s+=closes[i];
  ema[period-1] = s/period;
  for (let i=period;i<closes.length;i++) ema[i] = closes[i]*k + ema[i-1]*(1-k);
  return ema;
}

function calcRSI(closes, period=14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period+1) return rsi;
  let ag=0, al=0;
  for (let i=1;i<=period;i++) { const d=closes[i]-closes[i-1]; if(d>0)ag+=d; else al-=d; }
  ag/=period; al/=period;
  rsi[period] = al===0 ? 100 : 100-100/(1+ag/al);
  for (let i=period+1;i<closes.length;i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period;
    al=(al*(period-1)+Math.max(-d,0))/period;
    rsi[i] = al===0 ? 100 : 100-100/(1+ag/al);
  }
  return rsi;
}

function calcATRSMA(candles, atrPeriod=14, smaPeriod=50) {
  const atrs = new Array(candles.length).fill(null);
  let sum=0;
  for (let i=1;i<=atrPeriod;i++) {
    const tr=Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close));
    sum+=tr;
  }
  atrs[atrPeriod]=sum/atrPeriod;
  for (let i=atrPeriod+1;i<candles.length;i++) {
    const tr=Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close));
    atrs[i]=(atrs[i-1]*(atrPeriod-1)+tr)/atrPeriod;
  }
  const atrSMA = new Array(candles.length).fill(null);
  for (let i=atrPeriod+smaPeriod-1;i<candles.length;i++) {
    const slice=atrs.slice(i-smaPeriod+1,i+1).filter(v=>v!==null);
    if (slice.length===smaPeriod) atrSMA[i]=slice.reduce((a,b)=>a+b,0)/smaPeriod;
  }
  return { atrs, atrSMA };
}

function backtestCoin(candles) {
  const closes = candles.map(c=>c.close);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const { atrs, atrSMA } = calcATRSMA(candles);

  const trades = [];
  let position = null;
  let lastSignalBar = -COOLDOWN-1;
  const WARMUP = 260;

  for (let i=WARMUP;i<candles.length;i++) {
    const bar = candles[i];

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

    // Cooldown check
    if (i - lastSignalBar < COOLDOWN) continue;

    const e50=ema50[i], e200=ema200[i], r=rsi[i], rPrev=rsi[i-1];
    const atr=atrs[i], aSMA=atrSMA[i];
    if (!e50||!e200||r===null||rPrev===null||!atr||!aSMA) continue;

    const atrRatio=atr/aSMA;
    if (atrRatio>ATR_MAX) continue;

    const price=bar.close;
    const rsiCrossUp = rPrev<RSI_LONG_CROSS && r>=RSI_LONG_CROSS;    // RSI crossed above 55
    const rsiCrossDown = rPrev>RSI_SHORT_CROSS && r<=RSI_SHORT_CROSS; // RSI crossed below 45

    let signal=null;
    if (e50>e200 && price>e50 && rsiCrossUp) signal="long";
    if (e50<e200 && price<e50 && rsiCrossDown) signal="short";

    if (!signal) continue;
    lastSignalBar=i;

    const entry=bar.close;
    const risk$=ACCOUNT*RISK_PCT;

    if (signal==="long") {
      const sl=e50*(1-0.008);     // below EMA50 by 0.8%
      if (sl>=entry) continue;
      const stopDist=entry-sl;
      const tp=entry+stopDist*REWARD_RATIO;
      const notional=risk$/(stopDist/entry);
      position={side:"long",entry,sl,tp,risk$,notional,i0:i};
    } else {
      const sl=e50*(1+0.008);
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
  let all=[];
  for (const coin of COINS) {
    process.stdout.write(`${coin}...`);
    try {
      const candles=await fetchOKX(coin);
      const trades=backtestCoin(candles);
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

  console.log("\n════════ RSI MOMENTUM CROSS BACKTEST RESULTS ════════");
  console.log(`Total trades:  ${all.length}  (${(all.length/365).toFixed(1)}/day)`);
  console.log(`Win rate:      ${((wins.length/all.length)*100).toFixed(1)}%`);
  console.log(`Profit factor: ${pf.toFixed(2)}`);
  console.log(`Net P&L:       $${net.toFixed(2)} on $${ACCOUNT} (+${(net/ACCOUNT*100).toFixed(1)}%)`);
  console.log(`Max drawdown:  ${(maxDD*100).toFixed(1)}%`);
  console.log(`Longs: ${longs.length} (WR ${longs.length?(longs.filter(t=>t.pnl>0).length/longs.length*100).toFixed(1):0}%) | Shorts: ${shorts.length} (WR ${shorts.length?(shorts.filter(t=>t.pnl>0).length/shorts.length*100).toFixed(1):0}%)`);
  console.log(`TP: ${tpC}  SL: ${slC}  Timeout: ${toC}`);
  console.log(`Final equity:  $${(ACCOUNT+net).toFixed(2)}`);
  console.log("═════════════════════════════════════════════════════");
}

main().catch(console.error);
