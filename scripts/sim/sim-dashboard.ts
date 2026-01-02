#!/usr/bin/env npx tsx
/**
 * Sim Dashboard - Statistics and analysis for simulated trades.
 *
 * Usage:
 *   npx tsx scripts/sim/sim-dashboard.ts
 *   npx tsx scripts/sim/sim-dashboard.ts --export-csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { TradeLog, loadTradeLog } from '../../src/sim/trade-log.js';

// ===== Config =====

const DATA_DIR = path.join(process.cwd(), 'data');
const TRADE_LOG_PATH = path.join(DATA_DIR, 'sim-trades.json');

// ===== CLI Args =====

function parseArgs(): { exportCsv: boolean; filepath?: string } {
  const args = process.argv.slice(2);

  let exportCsv = false;
  let filepath: string | undefined;

  for (const arg of args) {
    if (arg === '--export-csv') exportCsv = true;
    else if (arg.startsWith('--file=')) filepath = arg.split('=')[1];
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Sim Dashboard - Trade statistics and analysis

Usage:
  npx tsx scripts/sim/sim-dashboard.ts [options]

Options:
  --file=PATH     Path to trade log (default: ${TRADE_LOG_PATH})
  --export-csv    Export trades to CSV
  --help, -h      Show this help
`);
      process.exit(0);
    }
  }

  return { exportCsv, filepath };
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

function colorValue(value: number, threshold = 0): string {
  if (value > threshold) return GREEN + value.toFixed(2) + RESET;
  if (value < threshold) return RED + value.toFixed(2) + RESET;
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  const str = value.toFixed(1) + '%';
  if (value >= 70) return GREEN + str + RESET;
  if (value >= 50) return YELLOW + str + RESET;
  return RED + str + RESET;
}

function printDashboard(tradeLog: TradeLog): void {
  const stats = tradeLog.getStats();
  const entries = tradeLog.getEntries();

  // Header
  console.log(`
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}
${BOLD}${CYAN}                        SIM TRADING DASHBOARD                          ${RESET}
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}
`);

  // Overview
  console.log(`${BOLD}${MAGENTA}▸ OVERVIEW${RESET}`);
  console.log(`  Total Trades:    ${BOLD}${stats.totalPositions}${RESET}`);
  console.log(`    ├─ Open:       ${stats.openPositions}`);
  console.log(`    └─ Settled:    ${stats.settledPositions}`);
  console.log();

  // P&L
  console.log(`${BOLD}${MAGENTA}▸ PROFIT & LOSS${RESET}`);
  console.log(`  Realized PnL:    $${colorValue(stats.realizedPnL)}`);
  console.log(`  Unrealized PnL:  $${colorValue(stats.unrealizedPnL)}`);
  console.log(`  ${BOLD}Total PnL:       $${colorValue(stats.totalPnL)}${RESET}`);
  console.log();

  // Performance
  console.log(`${BOLD}${MAGENTA}▸ PERFORMANCE${RESET}`);
  console.log(`  Win Rate:        ${formatPercent(stats.winRate)} (${stats.winCount}W / ${stats.lossCount}L)`);
  console.log(`  Avg Profit:      $${colorValue(stats.avgProfit)}`);
  console.log(`  Max Drawdown:    ${RED}$${stats.maxDrawdown.toFixed(2)}${RESET}`);
  console.log();

  // By Strategy
  console.log(`${BOLD}${MAGENTA}▸ BY STRATEGY${RESET}`);
  console.log(`  Dutch Book:`);
  console.log(`    ├─ Trades:     ${stats.byStrategy.DUTCH_BOOK.count}`);
  console.log(`    └─ PnL:        $${colorValue(stats.byStrategy.DUTCH_BOOK.pnl)}`);
  console.log(`  Implication:`);
  console.log(`    ├─ Trades:     ${stats.byStrategy.IMPLICATION.count}`);
  console.log(`    └─ PnL:        $${colorValue(stats.byStrategy.IMPLICATION.pnl)}`);
  console.log();

  // Recent Trades
  if (entries.length > 0) {
    console.log(`${BOLD}${MAGENTA}▸ RECENT TRADES${RESET}`);
    console.log(`  ${DIM}${'Time'.padEnd(22)}${'Strategy'.padEnd(14)}${'Status'.padEnd(10)}${'PnL'.padEnd(12)}${RESET}`);
    console.log(`  ${DIM}${'-'.repeat(58)}${RESET}`);

    const recent = entries.slice(-10).reverse();
    for (const entry of recent) {
      const time = new Date(entry.timestamp).toLocaleString();
      const strategy = entry.strategy === 'DUTCH_BOOK' ? 'Dutch Book' : 'Implication';
      const status = entry.status === 'SETTLED' ? GREEN + 'SETTLED' + RESET : YELLOW + 'OPEN' + RESET;
      const pnl = entry.settledPnL !== undefined
        ? '$' + colorValue(entry.settledPnL)
        : DIM + 'pending' + RESET;

      console.log(`  ${time.padEnd(22)}${strategy.padEnd(14)}${status.padEnd(19)}${pnl}`);
    }
    console.log();
  }

  // Data Info
  console.log(`${DIM}─────────────────────────────────────────────────────────────────────${RESET}`);
  console.log(`${DIM}Data file: ${TRADE_LOG_PATH}${RESET}`);
  console.log();
}

function printEmpty(): void {
  console.log(`
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}
${BOLD}${CYAN}                        SIM TRADING DASHBOARD                          ${RESET}
${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════════${RESET}

${YELLOW}No trades found.${RESET}

Start trading with:
  ${DIM}npx tsx scripts/sim/sim-trader.ts --auto --size=50${RESET}

`);
}

// ===== Main =====

async function main(): Promise<void> {
  const args = parseArgs();
  const filepath = args.filepath ?? TRADE_LOG_PATH;

  // Check if file exists
  if (!fs.existsSync(filepath)) {
    printEmpty();
    return;
  }

  // Load trade log
  const tradeLog = new TradeLog(filepath);

  // Check if empty
  if (tradeLog.getStats().totalPositions === 0) {
    printEmpty();
    return;
  }

  // Export CSV if requested
  if (args.exportCsv) {
    const csvPath = tradeLog.saveCsv();
    console.log(`${GREEN}Exported to: ${csvPath}${RESET}`);
    return;
  }

  // Print dashboard
  printDashboard(tradeLog);
}

main().catch((e) => {
  console.error(`${RED}Error: ${(e as Error).message}${RESET}`);
  process.exit(1);
});

