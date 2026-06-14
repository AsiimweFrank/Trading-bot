/**
 * scanner.mjs — Runs bot.js every 60 seconds, indefinitely.
 * Usage: node scanner.mjs
 *
 * Features:
 *  - Spawns bot.js as a child process each tick
 *  - Shows a live countdown to the next scan
 *  - Displays P&L summary after each run
 *  - Graceful shutdown on Ctrl+C
 */

import { spawn }      from "child_process";
import { readFileSync, existsSync } from "fs";

const INTERVAL_MS = 60_000;   // 1 minute
const BOT_SCRIPT  = "bot.js";

let scanCount  = 0;
let totalRuns  = 0;
let nextScanAt = null;
let countdownTimer = null;
let isRunning  = false;

// ── Helpers ──────────────────────────────────────────────────────────────────
function uaeNow() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    hour12: false,
    day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function getDailyPnl() {
  try {
    if (!existsSync("positions.json")) return null;
    const pos   = JSON.parse(readFileSync("positions.json", "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    const closed = pos.filter(p => p.status === "closed" && p.closeTime?.startsWith(today));
    const pnl    = closed.reduce((s, p) => s + (p.pnl ?? 0), 0);
    return { pnl, trades: closed.length };
  } catch { return null; }
}

function getPendingOrders() {
  try {
    if (!existsSync("positions.json")) return [];
    const pos = JSON.parse(readFileSync("positions.json", "utf8"));
    return pos.filter(p => p.status === "pending_limit" || p.status === "open");
  } catch { return []; }
}

function printHeader() {
  console.clear();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     🤖  LIVE MARKET SCANNER — scanning every 60 seconds     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Started : ${uaeNow()}  |  UAE timezone`);
  console.log(`  Bot     : ${BOT_SCRIPT}`);
  console.log(`  Ctrl+C  : stop scanner`);
  console.log("──────────────────────────────────────────────────────────────\n");
}

function printStatus(secsLeft) {
  const d = getDailyPnl();
  const pending = getPendingOrders();
  const pnlStr  = d ? `${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(2)} (${d.trades} trades)` : "—";
  const pendStr = pending.length
    ? pending.map(p => `${p.symbol} ${p.side||"long"} [${p.status}]`).join(" | ")
    : "none";

  process.stdout.write(
    `\r  ⏱  Next scan in ${String(secsLeft).padStart(2, "0")}s  |  ` +
    `Today P&L: ${pnlStr}  |  ` +
    `Open/Pending: ${pendStr}          `
  );
}

// ── Run one bot scan ─────────────────────────────────────────────────────────
async function runScan() {
  if (isRunning) return;   // skip if previous run still going
  isRunning = true;
  scanCount++;
  totalRuns++;

  console.log(`\n\n${"═".repeat(66)}`);
  console.log(`  🔍 SCAN #${scanCount}  —  ${uaeNow()}`);
  console.log(`${"═".repeat(66)}`);

  await new Promise((resolve) => {
    const child = spawn("node", [BOT_SCRIPT], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.log(`\n  ⚠️  bot.js exited with code ${code}`);
      }
      resolve();
    });

    child.on("error", (err) => {
      console.error(`\n  ❌ Failed to start bot.js: ${err.message}`);
      resolve();
    });
  });

  isRunning = false;

  // Post-run summary
  const d = getDailyPnl();
  if (d) {
    const icon = d.pnl >= 0 ? "💚" : "🔴";
    console.log(`\n  ${icon} After scan #${scanCount}: Today P&L = ${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(2)}  (${d.trades} closed trades)`);
  }
}

// ── Countdown ticker ─────────────────────────────────────────────────────────
function startCountdown() {
  nextScanAt = Date.now() + INTERVAL_MS;

  countdownTimer = setInterval(() => {
    if (isRunning) return;
    const secsLeft = Math.max(0, Math.round((nextScanAt - Date.now()) / 1000));
    printStatus(secsLeft);
    if (secsLeft === 0) {
      clearInterval(countdownTimer);
      runScan().then(startCountdown);
    }
  }, 1000);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  clearInterval(countdownTimer);
  const d = getDailyPnl();
  console.log(`\n\n  🛑 Scanner stopped after ${scanCount} scans.`);
  if (d) console.log(`  📊 Final today P&L: ${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(2)}  (${d.trades} closed trades)`);
  console.log(`  ${uaeNow()}`);
  process.exit(0);
});

// ── Main ──────────────────────────────────────────────────────────────────────
printHeader();
console.log("  Running first scan immediately...\n");
await runScan();
startCountdown();
