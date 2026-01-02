#!/usr/bin/env npx tsx
/**
 * Sim Trader - Main script for simulated trading.
 *
 * Scans for arbitrage opportunities and executes simulated trades.
 * Records ticks for later backtesting.
 *
 * Usage:
 *   # Auto mode: execute all opportunities automatically
 *   npx tsx scripts/sim/sim-trader.ts --auto --size=50
 *
 *   # Manual mode: show opportunities, confirm each execution
 *   npx tsx scripts/sim/sim-trader.ts --manual --size=50
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PolymarketSDK } from '../../src/index.js';
import { isBinaryGammaMarket } from '../../src/utils/market-utils.js';
import {
  simulateDutchBook,
  quickCheckDutchBook,
  DEFAULT_SIM_CONFIG,
  type SimConfig,
  type OrderbookPrices,
} from '../../src/sim/sim-executor.js';
import { PositionTracker } from '../../src/sim/position-tracker.js';
import { TradeLog } from '../../src/sim/trade-log.js';
import { TickRecorder } from '../../src/recorder/tick-recorder.js';
import { MetaRecorder, extractWatchlist, loadLatestMeta } from '../../src/recorder/meta-recorder.js';
import { ensureTokenMap } from '../../src/recorder/token-map.js';

// ===== Config =====

const DATA_DIR = path.join(process.cwd(), 'data');
const TRADE_LOG_PATH = path.join(DATA_DIR, 'sim-trades.json');
const META_DIR = path.join(DATA_DIR, 'meta');
const TICKS_DIR = path.join(DATA_DIR, 'ticks');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const TOKEN_MAP_PATH = path.join(CACHE_DIR, 'token-map.json');

// ===== CLI Args =====

interface CliArgs {
  auto: boolean;
  size: number;
  limit: number;
  interval: number;
  config: SimConfig;
  recordTicks: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  let auto = false;
  let size = 50;
  let limit = 50;
  let interval = 5000;
  let recordTicks = true;
  const config = { ...DEFAULT_SIM_CONFIG };

  for (const arg of args) {
    if (arg === '--auto') auto = true;
    else if (arg === '--manual') auto = false;
    else if (arg === '--no-record') recordTicks = false;
    else if (arg.startsWith('--size=')) size = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--limit=')) limit = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--interval=')) interval = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--slippage=')) config.slippage = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--fee=')) config.takerFee = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--min-profit=')) config.minProfit = parseFloat(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Sim Trader - Simulated arbitrage trading

Usage:
  npx tsx scripts/sim/sim-trader.ts [options]

Modes:
  --auto          Execute all profitable opportunities automatically
  --manual        Show opportunities, confirm each (default)

Options:
  --size=N        Trade size in USD (default: 50)
  --limit=N       Number of markets to scan (default: 50)
  --interval=N    Scan interval in ms (default: 5000)
  --slippage=X    Slippage per leg (default: 0.002)
  --fee=X         Taker fee per leg (default: 0.002)
  --min-profit=X  Minimum profit threshold (default: 0.008)
  --no-record     Don't record tick data
  --help, -h      Show this help

Data:
  Trades saved to: ${TRADE_LOG_PATH}
  Ticks saved to: ${TICKS_DIR}/
`);
      process.exit(0);
    }
  }

  return { auto, size, limit, interval, config, recordTicks };
}

// ===== Display =====

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';

function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

function printHeader(): void {
  console.log(`
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}
${BOLD}${CYAN}  SIM TRADER - Simulated Arbitrage Trading${RESET}
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}
`);
}

function printStats(tradeLog: TradeLog): void {
  const stats = tradeLog.getStats();
  console.log(`
${BOLD}─── Statistics ───${RESET}
  Trades: ${stats.totalPositions} (${stats.openPositions} open, ${stats.settledPositions} settled)
  PnL: ${GREEN}$${stats.realizedPnL.toFixed(2)}${RESET} realized, $${stats.unrealizedPnL.toFixed(2)} unrealized
  Win Rate: ${stats.winRate.toFixed(1)}%
  Max Drawdown: ${RED}$${stats.maxDrawdown.toFixed(2)}${RESET}
`);
}

function formatOpportunity(
  market: { question: string; conditionId: string },
  prices: OrderbookPrices,
  profit: number
): string {
  const question = market.question.slice(0, 50) + (market.question.length > 50 ? '...' : '');
  const combined = prices.yesAsk + prices.noAsk;
  return `
  ${BOLD}${question}${RESET}
  Combined Ask: ${combined.toFixed(4)} (${combined < 1 ? GREEN : RED}${((1 - combined) * 100).toFixed(2)}%${RESET})
  Profit (after fees): ${profit > 0 ? GREEN : RED}${(profit * 100).toFixed(2)}%${RESET}
  ConditionId: ${DIM}${market.conditionId.slice(0, 20)}...${RESET}
`;
}

// ===== Main Scanner =====

async function runScanner(args: CliArgs): Promise<void> {
  printHeader();

  console.log(`${DIM}Mode: ${args.auto ? 'AUTO' : 'MANUAL'}${RESET}`);
  console.log(`${DIM}Size: $${args.size} | Interval: ${args.interval}ms | Min Profit: ${(args.config.minProfit * 100).toFixed(1)}%${RESET}`);
  console.log();

  // Initialize SDK
  const sdk = new PolymarketSDK();

  // Initialize trade log
  const tradeLog = new TradeLog(TRADE_LOG_PATH);
  const tracker = tradeLog.getTracker();

  // Initialize meta recorder
  const metaRecorder = new MetaRecorder({
    dataDir: META_DIR,
    marketLimit: args.limit * 2,
  });

  // Capture initial meta
  console.log(`${DIM}→ Capturing market metadata...${RESET}`);
  const { snapshot } = await metaRecorder.captureAndSave();
  console.log(`  Found ${snapshot.marketCount} markets`);

  // Extract watchlist
  const watchlist = extractWatchlist(snapshot, {
    minVolume24hr: 1000,
    limit: args.limit,
  });
  console.log(`  Watchlist: ${watchlist.length} markets`);

  // Initialize tick recorder
  let tickRecorder: TickRecorder | null = null;
  if (args.recordTicks && watchlist.length > 0) {
    console.log(`${DIM}→ Resolving token IDs (cached)...${RESET}`);
    const tokenMap = await ensureTokenMap(sdk, watchlist, TOKEN_MAP_PATH, { delayMs: 250 });

    tickRecorder = new TickRecorder({
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
    console.log(`${DIM}→ Tick recording started${RESET}`);
  }

  // Build conditionId -> market map for quick lookup
  const marketMap = new Map<string, { question: string; conditionId: string }>();
  for (const m of snapshot.markets) {
    marketMap.set(m.conditionId, { question: m.question, conditionId: m.conditionId });
  }

  // Setup readline for manual mode
  let rl: readline.Interface | null = null;
  if (!args.auto) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  // Scan loop
  let scanCount = 0;
  let opportunityCount = 0;

  const scan = async (): Promise<void> => {
    scanCount++;
    clearLine();
    process.stdout.write(`${DIM}Scanning... (${scanCount})${RESET}`);

    const opportunities: Array<{
      market: { question: string; conditionId: string };
      prices: OrderbookPrices;
      profit: number;
    }> = [];

    // Check each market in watchlist
    for (const conditionId of watchlist) {
      try {
        // Prefer recorder ticks (no extra network). Fallback to direct fetch if missing.
        let prices: OrderbookPrices;
        const tick = tickRecorder?.getLatestTick(conditionId);

        if (tick) {
          prices = {
            yesBid: tick.yesBid,
            yesAsk: tick.yesAsk,
            noBid: tick.noBid,
            noAsk: tick.noAsk,
          };
        } else {
          const orderbook = await sdk.markets.getProcessedOrderbook(conditionId);
          prices = {
            yesBid: orderbook.yes.bid,
            yesAsk: orderbook.yes.ask,
            noBid: orderbook.no.bid,
            noAsk: orderbook.no.ask,
          };
        }

        // Quick check
        const { profitable, rawProfit } = quickCheckDutchBook(prices, args.config);

        if (profitable) {
          const market = marketMap.get(conditionId);
          if (market) {
            opportunities.push({ market, prices, profit: rawProfit });
          }
        }
      } catch {
        // Skip errors
      }
    }

    // Process opportunities
    if (opportunities.length > 0) {
      clearLine();
      console.log(`\n${GREEN}Found ${opportunities.length} opportunities!${RESET}`);

      for (const opp of opportunities) {
        console.log(formatOpportunity(opp.market, opp.prices, opp.profit));

        if (args.auto) {
          // Auto execute
          const result = simulateDutchBook(opp.prices, args.size, args.config);

          if (result.success) {
            const position = tracker.openDutchBook(opp.market.conditionId, result);
            tradeLog.save();

            console.log(`  ${GREEN}✓ EXECUTED${RESET} - PnL: $${result.expectedProfit.toFixed(4)}`);
            opportunityCount++;
          } else {
            console.log(`  ${YELLOW}✗ SKIPPED${RESET} - ${result.reason}`);
          }
        } else if (rl) {
          // Manual confirm
          const answer = await new Promise<string>((resolve) => {
            rl!.question(`  Execute? [y/N]: `, resolve);
          });

          if (answer.toLowerCase() === 'y') {
            const result = simulateDutchBook(opp.prices, args.size, args.config);

            if (result.success) {
              const position = tracker.openDutchBook(opp.market.conditionId, result);
              tradeLog.save();

              console.log(`  ${GREEN}✓ EXECUTED${RESET} - PnL: $${result.expectedProfit.toFixed(4)}`);
              opportunityCount++;
            } else {
              console.log(`  ${YELLOW}✗ FAILED${RESET} - ${result.reason}`);
            }
          } else {
            console.log(`  ${DIM}Skipped${RESET}`);
          }
        }
      }

      printStats(tradeLog);
    }
  };

  // Run initial scan
  await scan();

  // Schedule periodic scans
  const scanInterval = setInterval(scan, args.interval);

  // Handle shutdown
  const shutdown = (): void => {
    console.log(`\n${YELLOW}Shutting down...${RESET}`);

    clearInterval(scanInterval);

    if (tickRecorder) {
      tickRecorder.stop();
    }

    if (rl) {
      rl.close();
    }

    // Final save
    tradeLog.save();

    console.log(`\n${BOLD}Session Summary${RESET}`);
    console.log(`  Scans: ${scanCount}`);
    console.log(`  Opportunities: ${opportunityCount}`);
    printStats(tradeLog);

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`\n${DIM}Press Ctrl+C to stop${RESET}\n`);
}

// ===== Entry Point =====

const args = parseArgs();

runScanner(args).catch((e) => {
  console.error(`${RED}Error: ${(e as Error).message}${RESET}`);
  process.exit(1);
});

