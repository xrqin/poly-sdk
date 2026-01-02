#!/usr/bin/env npx tsx
/**
 * Backtest - Offline backtesting using recorded tick data.
 *
 * Replays historical tick data and simulates trades based on strategy rules.
 *
 * Usage:
 *   npx tsx scripts/sim/backtest.ts --data=data/ticks/ --strategy=dutch-book
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadTicksForMarket,
  getRecordedMarkets,
  type TickRecord,
} from '../../src/recorder/tick-recorder.js';
import {
  loadLatestMeta,
  buildMetaMap,
  type MarketMeta,
} from '../../src/recorder/meta-recorder.js';
import {
  quickCheckDutchBook,
  simulateDutchBook,
  DEFAULT_SIM_CONFIG,
  type SimConfig,
  type OrderbookPrices,
} from '../../src/sim/sim-executor.js';
import { PositionTracker } from '../../src/sim/position-tracker.js';

// ===== Config =====

const DATA_DIR = path.join(process.cwd(), 'data');

// ===== CLI Args =====

interface BacktestArgs {
  ticksDir: string;
  metaDir: string;
  strategy: 'dutch-book' | 'all';
  config: SimConfig;
  size: number;
  verbose: boolean;
}

function parseArgs(): BacktestArgs {
  const args = process.argv.slice(2);

  let ticksDir = path.join(DATA_DIR, 'ticks');
  let metaDir = path.join(DATA_DIR, 'meta');
  let strategy: 'dutch-book' | 'all' = 'dutch-book';
  let size = 50;
  let verbose = false;
  const config = { ...DEFAULT_SIM_CONFIG };

  for (const arg of args) {
    if (arg.startsWith('--data=') || arg.startsWith('--ticks=')) {
      ticksDir = arg.split('=')[1];
    } else if (arg.startsWith('--meta=')) {
      metaDir = arg.split('=')[1];
    } else if (arg.startsWith('--strategy=')) {
      const s = arg.split('=')[1];
      if (s === 'dutch-book' || s === 'all') strategy = s;
    } else if (arg.startsWith('--size=')) {
      size = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--slippage=')) {
      config.slippage = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--fee=')) {
      config.takerFee = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--min-profit=')) {
      config.minProfit = parseFloat(arg.split('=')[1]);
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Backtest - Offline backtesting with recorded data

Usage:
  npx tsx scripts/sim/backtest.ts [options]

Options:
  --data=PATH       Path to ticks directory (default: data/ticks/)
  --meta=PATH       Path to meta directory (default: data/meta/)
  --strategy=NAME   Strategy to backtest: dutch-book, all (default: dutch-book)
  --size=N          Trade size in USD (default: 50)
  --slippage=X      Slippage per leg (default: 0.002)
  --fee=X           Taker fee per leg (default: 0.002)
  --min-profit=X    Minimum profit threshold (default: 0.008)
  --verbose, -v     Show detailed output
  --help, -h        Show this help
`);
      process.exit(0);
    }
  }

  return { ticksDir, metaDir, strategy, config, size, verbose };
}

// ===== Display =====

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';

function colorValue(value: number): string {
  if (value > 0) return GREEN + '$' + value.toFixed(2) + RESET;
  if (value < 0) return RED + '$' + value.toFixed(2) + RESET;
  return '$' + value.toFixed(2);
}

// ===== Backtest Logic =====

interface BacktestResult {
  totalTicks: number;
  opportunityCount: number;
  executedCount: number;
  totalPnL: number;
  trades: Array<{
    time: string;
    conditionId: string;
    market?: string;
    profit: number;
  }>;
}

function backtestDutchBook(
  ticks: TickRecord[],
  config: SimConfig,
  size: number,
  marketMeta?: MarketMeta
): BacktestResult {
  const tracker = new PositionTracker();
  const trades: BacktestResult['trades'] = [];

  let opportunityCount = 0;
  let lastTradeTime = 0;
  const minTimeBetweenTrades = 60000; // 1 minute cooldown

  for (const tick of ticks) {
    const prices: OrderbookPrices = {
      yesBid: tick.yesBid,
      yesAsk: tick.yesAsk,
      noBid: tick.noBid,
      noAsk: tick.noAsk,
    };

    // Quick check
    const { profitable } = quickCheckDutchBook(prices, config);

    if (profitable) {
      opportunityCount++;

      // Cooldown check
      const tickTime = new Date(tick.ts).getTime();
      if (tickTime - lastTradeTime < minTimeBetweenTrades) {
        continue;
      }

      // Full simulation
      const result = simulateDutchBook(prices, size, config);

      if (result.success) {
        tracker.openDutchBook(tick.conditionId, result);
        lastTradeTime = tickTime;

        trades.push({
          time: tick.ts,
          conditionId: tick.conditionId,
          market: marketMeta?.question,
          profit: result.expectedProfit,
        });
      }
    }
  }

  const stats = tracker.getStats();

  return {
    totalTicks: ticks.length,
    opportunityCount,
    executedCount: trades.length,
    totalPnL: stats.realizedPnL,
    trades,
  };
}

// ===== Main =====

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}
${BOLD}${CYAN}                        BACKTEST RUNNER                                ${RESET}
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}
`);

  console.log(`${DIM}Strategy: ${args.strategy}${RESET}`);
  console.log(`${DIM}Size: $${args.size}${RESET}`);
  console.log(`${DIM}Min Profit: ${(args.config.minProfit * 100).toFixed(1)}%${RESET}`);
  console.log(`${DIM}Slippage: ${(args.config.slippage * 100).toFixed(1)}%${RESET}`);
  console.log(`${DIM}Fee: ${(args.config.takerFee * 100).toFixed(1)}%${RESET}`);
  console.log();

  // Check data directory
  if (!fs.existsSync(args.ticksDir)) {
    console.log(`${RED}Error: Ticks directory not found: ${args.ticksDir}${RESET}`);
    console.log(`${DIM}Run the recorder first:${RESET}`);
    console.log(`  npx tsx scripts/sim/sim-trader.ts --auto`);
    process.exit(1);
  }

  // Load metadata for market names
  const metaSnapshot = loadLatestMeta(args.metaDir);
  const metaMap = metaSnapshot ? buildMetaMap(metaSnapshot) : new Map();

  console.log(`${DIM}Loaded metadata for ${metaMap.size} markets${RESET}`);

  // Get recorded markets
  const recordedMarkets = getRecordedMarkets(args.ticksDir);

  if (recordedMarkets.length === 0) {
    console.log(`${YELLOW}No recorded tick data found.${RESET}`);
    console.log(`${DIM}Run the recorder first:${RESET}`);
    console.log(`  npx tsx scripts/sim/sim-trader.ts --auto`);
    process.exit(1);
  }

  console.log(`${DIM}Found ${recordedMarkets.length} markets with tick data${RESET}`);
  console.log();

  // Run backtest for each market
  let totalTicks = 0;
  let totalOpportunities = 0;
  let totalExecuted = 0;
  let totalPnL = 0;
  const allTrades: BacktestResult['trades'] = [];

  console.log(`${BOLD}Running backtest...${RESET}`);
  console.log();

  for (const shortId of recordedMarkets) {
    // Find full conditionId from meta
    let conditionId = shortId;
    let marketMeta: MarketMeta | undefined;

    for (const [id, meta] of metaMap) {
      if (id.startsWith(shortId)) {
        conditionId = id;
        marketMeta = meta;
        break;
      }
    }

    // Load ticks
    const ticks = loadTicksForMarket(args.ticksDir, conditionId);

    if (ticks.length === 0) continue;

    // Run backtest
    const result = backtestDutchBook(ticks, args.config, args.size, marketMeta);

    totalTicks += result.totalTicks;
    totalOpportunities += result.opportunityCount;
    totalExecuted += result.executedCount;
    totalPnL += result.totalPnL;
    allTrades.push(...result.trades);

    if (args.verbose || result.executedCount > 0) {
      const marketName = marketMeta?.question?.slice(0, 40) || shortId;
      console.log(`  ${marketName}${marketMeta?.question && marketMeta.question.length > 40 ? '...' : ''}`);
      console.log(`    Ticks: ${result.totalTicks}, Opportunities: ${result.opportunityCount}, Trades: ${result.executedCount}, PnL: ${colorValue(result.totalPnL)}`);
    }
  }

  // Summary
  console.log(`
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}
${BOLD}                           BACKTEST RESULTS                              ${RESET}
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}

  ${BOLD}Data Summary${RESET}
    Markets Tested:     ${recordedMarkets.length}
    Total Ticks:        ${totalTicks.toLocaleString()}

  ${BOLD}Opportunities${RESET}
    Detected:           ${totalOpportunities}
    Executed:           ${totalExecuted}
    Hit Rate:           ${totalOpportunities > 0 ? ((totalExecuted / totalOpportunities) * 100).toFixed(1) : 0}%

  ${BOLD}Performance${RESET}
    Total PnL:          ${colorValue(totalPnL)}
    Avg PnL/Trade:      ${totalExecuted > 0 ? colorValue(totalPnL / totalExecuted) : '$0.00'}
    Trades/1k Ticks:    ${totalTicks > 0 ? ((totalExecuted / totalTicks) * 1000).toFixed(2) : 0}
`);

  // Recent trades
  if (allTrades.length > 0 && args.verbose) {
    console.log(`${BOLD}Recent Trades${RESET}`);
    console.log(`  ${DIM}${'Time'.padEnd(25)}${'Profit'.padEnd(12)}Market${RESET}`);
    console.log(`  ${DIM}${'-'.repeat(70)}${RESET}`);

    const recent = allTrades.slice(-10);
    for (const trade of recent) {
      const time = new Date(trade.time).toLocaleString();
      const market = trade.market?.slice(0, 35) || trade.conditionId.slice(0, 16);
      console.log(`  ${time.padEnd(25)}${colorValue(trade.profit).padEnd(21)}${market}`);
    }
    console.log();
  }

  // Parameter sensitivity hint
  console.log(`${DIM}Tip: Try different parameters to find optimal settings:${RESET}`);
  console.log(`${DIM}  --min-profit=0.005  (lower threshold, more trades)${RESET}`);
  console.log(`${DIM}  --min-profit=0.012  (higher threshold, fewer but safer trades)${RESET}`);
  console.log();
}

main().catch((e) => {
  console.error(`${RED}Error: ${(e as Error).message}${RESET}`);
  process.exit(1);
});

