#!/usr/bin/env npx tsx
/**
 * Unified Sim Runner - One command to run everything.
 *
 * Combines: Market scanning + Tick recording + Simulated trading + Live stats
 *
 * Usage:
 *   npx tsx scripts/sim/run.ts
 *   npx tsx scripts/sim/run.ts --size=100 --top=30
 */

import * as fs from 'fs';
import * as path from 'path';
import { PolymarketSDK } from '../../src/index.js';
import {
  quickCheckDutchBook,
  simulateDutchBook,
  DEFAULT_SIM_CONFIG,
  type SimConfig,
  type OrderbookPrices,
} from '../../src/sim/sim-executor.js';
import { TradeLog } from '../../src/sim/trade-log.js';
import { TickRecorder } from '../../src/recorder/tick-recorder.js';
import { MetaRecorder, extractWatchlist } from '../../src/recorder/meta-recorder.js';
import { ensureTokenMap } from '../../src/recorder/token-map.js';

// ===== Config =====

const DATA_DIR = path.join(process.cwd(), 'data');
const TRADE_LOG_PATH = path.join(DATA_DIR, 'sim-trades.json');
const META_DIR = path.join(DATA_DIR, 'meta');
const TICKS_DIR = path.join(DATA_DIR, 'ticks');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const TOKEN_MAP_PATH = path.join(CACHE_DIR, 'token-map.json');

// ===== CLI Args =====

interface Args {
  size: number;
  top: number;
  interval: number;
  config: SimConfig;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);

  let size = 50;
  let top = 30;
  let interval = 3000;
  const config = { ...DEFAULT_SIM_CONFIG };

  for (const arg of args) {
    if (arg.startsWith('--size=')) size = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--top=')) top = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--interval=')) interval = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--min-profit=')) config.minProfit = parseFloat(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Unified Sim Runner - One command for everything

Usage:
  npx tsx scripts/sim/run.ts [options]

Options:
  --size=N          Trade size in USD (default: 50)
  --top=N           Number of markets to monitor (default: 30)
  --interval=MS     Scan interval in ms (default: 3000)
  --min-profit=X    Minimum profit threshold (default: 0.008)
  --help, -h        Show this help

What it does:
  1. Fetches active markets metadata
  2. Starts tick recording (for backtesting later)
  3. Scans for Dutch Book opportunities
  4. Auto-executes simulated trades
  5. Shows live statistics

Data saved to:
  ${DATA_DIR}/
`);
      process.exit(0);
    }
  }

  return { size, top, interval, config };
}

// ===== Display =====

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';

const BOX = { TL: '╔', TR: '╗', BL: '╚', BR: '╝', H: '═', V: '║' };

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function colorPnL(value: number): string {
  if (value > 0) return GREEN + '+$' + value.toFixed(2) + RESET;
  if (value < 0) return RED + '-$' + Math.abs(value).toFixed(2) + RESET;
  return '$0.00';
}

// ===== Main =====

async function main(): Promise<void> {
  const args = parseArgs();

  clearScreen();
  console.log(`
${BOLD}${CYAN}${BOX.TL}${BOX.H.repeat(60)}${BOX.TR}${RESET}
${BOLD}${CYAN}${BOX.V}${RESET}  ${BOLD}POLYMARKET SIM TRADER${RESET}                                   ${BOLD}${CYAN}${BOX.V}${RESET}
${BOLD}${CYAN}${BOX.V}${RESET}  ${DIM}Recording + Scanning + Trading + Stats${RESET}                   ${BOLD}${CYAN}${BOX.V}${RESET}
${BOLD}${CYAN}${BOX.BL}${BOX.H.repeat(60)}${BOX.BR}${RESET}
`);

  // Ensure directories
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const sdk = new PolymarketSDK();

  // ===== 1. Capture metadata =====
  console.log(`${CYAN}▸${RESET} Fetching market metadata...`);
  const metaRecorder = new MetaRecorder({
    dataDir: META_DIR,
    marketLimit: args.top * 3,
    minVolume24hr: 500,
  });
  const { snapshot } = await metaRecorder.captureAndSave();
  console.log(`  ${GREEN}✓${RESET} Found ${snapshot.marketCount} markets`);

  // ===== 2. Build watchlist =====
  const watchlist = extractWatchlist(snapshot, {
    minVolume24hr: 1000,
    limit: args.top,
  });
  console.log(`  ${GREEN}✓${RESET} Watchlist: ${watchlist.length} markets`);

  // Build lookup map
  const marketMap = new Map<string, { question: string; conditionId: string }>();
  for (const m of snapshot.markets) {
    marketMap.set(m.conditionId, { question: m.question, conditionId: m.conditionId });
  }

  // ===== 3. Resolve token IDs (persisted) =====
  console.log(`${CYAN}▸${RESET} Resolving token IDs (cached)...`);
  const tokenMap = await ensureTokenMap(sdk, watchlist, TOKEN_MAP_PATH, { delayMs: 250 });
  console.log(`  ${GREEN}✓${RESET} Token map: ${Object.keys(tokenMap).length} markets`);

  // ===== 4. Start tick recorder =====
  console.log(`${CYAN}▸${RESET} Starting tick recorder...`);
  const tickRecorder = new TickRecorder({
    dataDir: TICKS_DIR,
    watchlist,
    intervalMs: args.interval,
    sdk,
    tokenMap,
    batchMode: true,
    startImmediate: false,
  });
  await tickRecorder.captureOnce();
  tickRecorder.start();
  console.log(`  ${GREEN}✓${RESET} Recording at ${args.interval}ms interval (batch)`);

  // ===== 5. Initialize trade log =====
  const tradeLog = new TradeLog(TRADE_LOG_PATH);
  const tracker = tradeLog.getTracker();
  console.log(`  ${GREEN}✓${RESET} Trade log ready`);

  // ===== 6. Start scanning =====
  console.log();
  console.log(`${CYAN}▸${RESET} ${BOLD}Scanning for opportunities...${RESET}`);
  console.log(`  Size: $${args.size} | Min Profit: ${(args.config.minProfit * 100).toFixed(1)}%`);
  console.log();

  const startTime = Date.now();
  let scanCount = 0;
  let lastOppTime = 0;

  const formatUptime = (ms: number): string => {
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000);
    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
  };

  const scan = async (): Promise<void> => {
    scanCount++;
    let foundOpp = false;

    for (const conditionId of watchlist) {
      try {
        const tick = tickRecorder.getLatestTick(conditionId);
        if (!tick) continue;

        const prices: OrderbookPrices = {
          yesBid: tick.yesBid,
          yesAsk: tick.yesAsk,
          noBid: tick.noBid,
          noAsk: tick.noAsk,
        };

        const { profitable } = quickCheckDutchBook(prices, args.config);

        if (profitable) {
          const result = simulateDutchBook(prices, args.size, args.config);

          if (result.success) {
            const market = marketMap.get(conditionId);
            tracker.openDutchBook(conditionId, result);
            tradeLog.save();

            const question = market?.question?.slice(0, 45) || conditionId.slice(0, 20);
            console.log(`  ${GREEN}▲ TRADE${RESET} ${question}... → ${GREEN}+$${result.expectedProfit.toFixed(4)}${RESET}`);

            foundOpp = true;
            lastOppTime = Date.now();
          }
        }
      } catch {
        // Skip errors
      }
    }

    // Update status line
    const stats = tracker.getStats();
    const tickStats = tickRecorder.getStats();
    const uptime = formatUptime(Date.now() - startTime);
    const lastOpp = lastOppTime > 0 ? formatUptime(Date.now() - lastOppTime) + ' ago' : 'none';

    process.stdout.write(
      `\r${DIM}[${uptime}] Scans: ${scanCount} | Ticks: ${tickStats.tickCount} | Trades: ${stats.totalPositions} | PnL: ${colorPnL(stats.realizedPnL)}${DIM} | Last opp: ${lastOpp}${RESET}   `
    );
  };

  // Run scans
  await scan();
  const scanInterval = setInterval(scan, args.interval);

  // Periodic stats refresh
  const refreshStats = (): void => {
    metaRecorder.captureAndSave().catch(() => {});
  };
  const metaInterval = setInterval(refreshStats, 60 * 60 * 1000); // 1 hour

  // Graceful shutdown
  const shutdown = (): void => {
    clearInterval(scanInterval);
    clearInterval(metaInterval);
    tickRecorder.stop();
    tradeLog.save();

    const stats = tracker.getStats();
    const tickStats = tickRecorder.getStats();
    const uptime = formatUptime(Date.now() - startTime);

    console.log(`\n
${BOLD}${CYAN}${BOX.TL}${BOX.H.repeat(60)}${BOX.TR}${RESET}
${BOLD}${CYAN}${BOX.V}${RESET}  ${BOLD}SESSION SUMMARY${RESET}                                          ${BOLD}${CYAN}${BOX.V}${RESET}
${BOLD}${CYAN}${BOX.BL}${BOX.H.repeat(60)}${BOX.BR}${RESET}

  ${MAGENTA}▸ Runtime${RESET}
    Duration:       ${uptime}
    Scans:          ${scanCount}

  ${MAGENTA}▸ Data Recorded${RESET}
    Ticks:          ${tickStats.tickCount.toLocaleString()}
    Markets:        ${tickStats.marketCount}
    Errors:         ${tickStats.errorCount}

  ${MAGENTA}▸ Trading Results${RESET}
    Trades:         ${stats.totalPositions}
    Win Rate:       ${stats.winRate.toFixed(1)}%
    ${BOLD}Total PnL:      ${colorPnL(stats.realizedPnL)}${RESET}

  ${DIM}Data saved to: ${DATA_DIR}${RESET}
`);

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`${DIM}Press Ctrl+C to stop${RESET}\n`);
}

main().catch((e) => {
  console.error(`${RED}Error: ${(e as Error).message}${RESET}`);
  process.exit(1);
});

