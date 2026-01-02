#!/usr/bin/env npx tsx
/**
 * Start Recorder - Standalone tick data recorder.
 *
 * Records orderbook data for specified markets without trading.
 * Use this to build historical data for backtesting.
 *
 * Usage:
 *   npx tsx scripts/recorder/start-recorder.ts --watchlist=watchlist.json
 *   npx tsx scripts/recorder/start-recorder.ts --top=50 --interval=1000
 */

import * as fs from 'fs';
import * as path from 'path';
import { TickRecorder } from '../../src/recorder/tick-recorder.js';
import { MetaRecorder, extractWatchlist } from '../../src/recorder/meta-recorder.js';

// ===== Config =====

const DATA_DIR = path.join(process.cwd(), 'data');
const META_DIR = path.join(DATA_DIR, 'meta');
const TICKS_DIR = path.join(DATA_DIR, 'ticks');

// ===== CLI Args =====

interface RecorderArgs {
  watchlistFile?: string;
  top: number;
  interval: number;
  metaInterval: number;
  minVolume: number;
}

function parseArgs(): RecorderArgs {
  const args = process.argv.slice(2);

  let watchlistFile: string | undefined;
  let top = 50;
  let interval = 1000;
  let metaInterval = 60 * 60 * 1000; // 1 hour
  let minVolume = 1000;

  for (const arg of args) {
    if (arg.startsWith('--watchlist=')) {
      watchlistFile = arg.split('=')[1];
    } else if (arg.startsWith('--top=')) {
      top = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--interval=')) {
      interval = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--meta-interval=')) {
      metaInterval = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--min-volume=')) {
      minVolume = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Start Recorder - Standalone tick data recorder

Usage:
  npx tsx scripts/recorder/start-recorder.ts [options]

Options:
  --watchlist=FILE    JSON file with conditionIds to record
  --top=N             Record top N markets by volume (default: 50)
  --interval=MS       Tick recording interval in ms (default: 1000)
  --meta-interval=MS  Metadata refresh interval in ms (default: 3600000 = 1hr)
  --min-volume=N      Minimum 24h volume filter (default: 1000)
  --help, -h          Show this help

Examples:
  # Record top 50 markets by volume
  npx tsx scripts/recorder/start-recorder.ts --top=50

  # Record specific markets from file
  npx tsx scripts/recorder/start-recorder.ts --watchlist=my-markets.json

  # High-frequency recording (200ms)
  npx tsx scripts/recorder/start-recorder.ts --interval=200 --top=20

Output:
  Metadata: ${META_DIR}/meta-YYYY-MM-DD.json
  Ticks:    ${TICKS_DIR}/<conditionId>/YYYY-MM-DD.csv
`);
      process.exit(0);
    }
  }

  return { watchlistFile, top, interval, metaInterval, minVolume };
}

// ===== Display =====

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ===== Main =====

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}
${BOLD}${CYAN}                    TICK DATA RECORDER                         ${RESET}
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}
`);

  // Ensure directories exist
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Initialize meta recorder
  const metaRecorder = new MetaRecorder({
    dataDir: META_DIR,
    intervalMs: args.metaInterval,
    marketLimit: Math.max(args.top * 2, 200),
    minVolume24hr: args.minVolume,
  });

  // Capture initial metadata
  console.log(`${DIM}→ Capturing market metadata...${RESET}`);
  const { snapshot } = await metaRecorder.captureAndSave();
  console.log(`  Found ${snapshot.marketCount} active markets`);

  // Determine watchlist
  let watchlist: string[];

  if (args.watchlistFile && fs.existsSync(args.watchlistFile)) {
    // Load from file
    const content = fs.readFileSync(args.watchlistFile, 'utf-8');
    watchlist = JSON.parse(content) as string[];
    console.log(`  Loaded ${watchlist.length} markets from ${args.watchlistFile}`);
  } else {
    // Extract top markets by volume
    watchlist = extractWatchlist(snapshot, {
      minVolume24hr: args.minVolume,
      limit: args.top,
    });
    console.log(`  Selected top ${watchlist.length} markets by volume`);
  }

  if (watchlist.length === 0) {
    console.log(`${YELLOW}No markets to record. Check filters.${RESET}`);
    process.exit(1);
  }

  // Initialize tick recorder
  const tickRecorder = new TickRecorder({
    dataDir: TICKS_DIR,
    watchlist,
    intervalMs: args.interval,
  });

  // Start recording
  console.log();
  console.log(`${GREEN}Starting recorder...${RESET}`);
  console.log(`  Markets: ${watchlist.length}`);
  console.log(`  Interval: ${args.interval}ms`);
  console.log(`  Data dir: ${TICKS_DIR}`);
  console.log();

  tickRecorder.start();
  metaRecorder.start();

  const startTime = Date.now();

  // Status update interval
  const statusInterval = setInterval(() => {
    const stats = tickRecorder.getStats();
    const uptime = formatUptime(Date.now() - startTime);

    process.stdout.write(
      `\r${DIM}[${uptime}] Ticks: ${stats.tickCount.toLocaleString()} | Errors: ${stats.errorCount} | Markets: ${stats.marketCount}${RESET}    `
    );
  }, 5000);

  // Graceful shutdown
  const shutdown = (): void => {
    console.log(`\n\n${YELLOW}Shutting down...${RESET}`);

    clearInterval(statusInterval);
    tickRecorder.stop();
    metaRecorder.stop();

    const stats = tickRecorder.getStats();
    const uptime = formatUptime(Date.now() - startTime);

    console.log(`
${BOLD}Recording Session Summary${RESET}
  Duration:    ${uptime}
  Ticks:       ${stats.tickCount.toLocaleString()}
  Errors:      ${stats.errorCount}
  Markets:     ${stats.marketCount}
  Data saved:  ${TICKS_DIR}
`);

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`${DIM}Recording in progress. Press Ctrl+C to stop.${RESET}`);
  console.log();
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});

