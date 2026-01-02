#!/usr/bin/env npx tsx
/**
 * RiskFree Combo Arbitrage Scanner
 *
 * Scans Polymarket markets for two types of risk-free arbitrage:
 * 1. Dutch Book (intra-market): Yes_ask + No_ask < 1
 * 2. Implication (cross-market): If A ⇒ B and bid_A > ask_B
 *
 * Usage:
 *   export OPENAI_API_KEY="sk-..."
 *   npx tsx scripts/arb/combo-arb-scanner.ts --limit=100 --min-profit=0.005
 */

import { PolymarketSDK } from '../../src/index.js';
import type { GammaMarket } from '../../src/clients/gamma-api.js';
import type { ArbitrageOpportunity, ProcessedOrderbook } from '../../src/core/types.js';
import {
  extractImplications,
  getLLMConfigFromEnv,
  deduplicateCandidates,
  type ImplicationCandidate,
  type LLMConfig,
} from '../../src/utils/relation-extractor.js';
import {
  batchCheckImplicationArbitrage,
  extractPrices,
  type ImplicationArbOpportunity,
  type OrderbookPrices,
} from '../../src/utils/implication-arb.js';
import { isBinaryGammaMarket } from '../../src/utils/market-utils.js';

// ===== CLI Args =====

function parseArgs(): {
  limit: number;
  minProfit: number;
  skipLLM: boolean;
  verbose: boolean;
} {
  const args = process.argv.slice(2);
  let limit = 100;
  let minProfit = 0.005;
  let skipLLM = false;
  let verbose = false;

  for (const arg of args) {
    if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--min-profit=')) {
      minProfit = parseFloat(arg.split('=')[1]);
    } else if (arg === '--skip-llm') {
      skipLLM = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
RiskFree Combo Arbitrage Scanner

Usage:
  npx tsx scripts/arb/combo-arb-scanner.ts [options]

Options:
  --limit=N        Number of markets to scan (default: 100)
  --min-profit=X   Minimum profit threshold (default: 0.005 = 0.5%)
  --skip-llm       Skip LLM-based implication detection
  --verbose, -v    Show detailed output
  --help, -h       Show this help

Environment:
  OPENAI_API_KEY      OpenAI API key (for implication detection)
  ANTHROPIC_API_KEY   Anthropic API key (alternative)
  LLM_PROVIDER        'openai' or 'anthropic' (default: openai)
  LLM_MODEL           Model name (default: gpt-4o-mini)
`);
      process.exit(0);
    }
  }

  return { limit, minProfit, skipLLM, verbose };
}

// ===== Output Formatting =====

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';

function printHeader(title: string): void {
  console.log('\n' + BOLD + CYAN + '═'.repeat(70) + RESET);
  console.log(BOLD + CYAN + '  ' + title + RESET);
  console.log(BOLD + CYAN + '═'.repeat(70) + RESET);
}

function printDutchBookTable(opportunities: Array<{ market: GammaMarket; arb: ArbitrageOpportunity }>): void {
  if (opportunities.length === 0) {
    console.log(DIM + '  No Dutch Book opportunities found.' + RESET);
    return;
  }

  console.log();
  console.log('  ' + BOLD + 'Market'.padEnd(45) + 'Type'.padEnd(8) + 'Profit'.padEnd(10) + 'Action' + RESET);
  console.log('  ' + '-'.repeat(90));

  for (const { market, arb } of opportunities) {
    const question = market.question.slice(0, 42) + (market.question.length > 42 ? '...' : '');
    const typeColor = arb.type === 'long' ? GREEN : RED;
    const profitStr = `${(arb.profit * 100).toFixed(2)}%`;

    console.log(
      '  ' +
      question.padEnd(45) +
      typeColor + arb.type.toUpperCase().padEnd(8) + RESET +
      GREEN + profitStr.padEnd(10) + RESET +
      DIM + arb.action.slice(0, 40) + RESET
    );
  }
}

function printImplicationTable(opportunities: ImplicationArbOpportunity[]): void {
  if (opportunities.length === 0) {
    console.log(DIM + '  No Implication arbitrage opportunities found.' + RESET);
    return;
  }

  console.log();
  console.log('  ' + BOLD + 'Relation'.padEnd(50) + 'Conf'.padEnd(8) + 'Profit'.padEnd(10) + 'Action' + RESET);
  console.log('  ' + '-'.repeat(100));

  for (const opp of opportunities) {
    const relation = opp.relation.slice(0, 47) + (opp.relation.length > 47 ? '...' : '');
    const confColor = opp.confidence === 'HIGH' ? GREEN : YELLOW;
    const profitStr = `${(opp.profit * 100).toFixed(2)}%`;

    console.log(
      '  ' +
      relation.padEnd(50) +
      confColor + opp.confidence.padEnd(8) + RESET +
      GREEN + profitStr.padEnd(10) + RESET +
      DIM + `Sell@${opp.prices.bidA.toFixed(3)} Buy@${opp.prices.askB.toFixed(3)}` + RESET
    );
  }
}

// ===== Main Scanner =====

async function main(): Promise<void> {
  const { limit, minProfit, skipLLM, verbose } = parseArgs();

  console.log(BOLD + '\n🔍 RiskFree Combo Arbitrage Scanner\n' + RESET);
  console.log(`  Limit: ${limit} markets`);
  console.log(`  Min Profit: ${(minProfit * 100).toFixed(2)}%`);
  console.log(`  LLM: ${skipLLM ? 'disabled' : 'enabled'}`);

  // Initialize SDK
  const sdk = new PolymarketSDK();

  // ===== Step 1: Fetch markets =====
  console.log('\n' + DIM + '→ Fetching active markets...' + RESET);

  const markets = await sdk.gammaApi.getMarkets({
    active: true,
    closed: false,
    order: 'volume24hr',
    ascending: false,
    limit,
  });

  // Filter to binary markets only
  const binaryMarkets = markets.filter(isBinaryGammaMarket);

  console.log(`  Fetched ${markets.length} markets, ${binaryMarkets.length} binary`);

  // ===== Step 2: Dutch Book Detection =====
  printHeader('DUTCH BOOK OPPORTUNITIES');
  console.log(DIM + '→ Scanning for intra-market arbitrage...' + RESET);

  const dutchBookOpps: Array<{ market: GammaMarket; arb: ArbitrageOpportunity }> = [];

  for (const market of binaryMarkets) {
    try {
      const arb = await sdk.detectArbitrage(market.conditionId, minProfit);
      if (arb) {
        dutchBookOpps.push({ market, arb });
      }
    } catch (e) {
      if (verbose) {
        console.log(DIM + `  Skip ${market.slug}: ${(e as Error).message}` + RESET);
      }
    }
  }

  // Sort by profit
  dutchBookOpps.sort((a, b) => b.arb.profit - a.arb.profit);

  printDutchBookTable(dutchBookOpps);

  // ===== Step 3: Implication Detection (LLM) =====
  if (!skipLLM) {
    printHeader('IMPLICATION ARBITRAGE');

    const llmConfig = getLLMConfigFromEnv();

    if (!llmConfig) {
      console.log(YELLOW + '  ⚠ No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.' + RESET);
      console.log(DIM + '  Skipping implication detection.' + RESET);
    } else {
      console.log(DIM + `→ Using ${llmConfig.provider} (${llmConfig.model || 'default'})` + RESET);
      console.log(DIM + '→ Extracting market relations with LLM...' + RESET);

      let candidates: ImplicationCandidate[] = [];

      try {
        candidates = await extractImplications(binaryMarkets, llmConfig, {
          batchSize: 50,
          minConfidence: 'MEDIUM',
        });
        candidates = deduplicateCandidates(candidates);

        console.log(`  Found ${candidates.length} implication candidates`);

        if (verbose && candidates.length > 0) {
          console.log(DIM + '\n  Candidates:' + RESET);
          for (const c of candidates.slice(0, 10)) {
            console.log(DIM + `    ${c.confidence}: ${c.marketA.question.slice(0, 30)} → ${c.marketB.question.slice(0, 30)}` + RESET);
          }
        }
      } catch (e) {
        console.log(RED + `  LLM error: ${(e as Error).message}` + RESET);
      }

      // ===== Step 4: Verify implication arbitrage =====
      if (candidates.length > 0) {
        console.log(DIM + '→ Fetching orderbooks for verification...' + RESET);

        // Collect all unique conditionIds we need
        const conditionIds = new Set<string>();
        for (const c of candidates) {
          conditionIds.add(c.marketA.conditionId);
          conditionIds.add(c.marketB.conditionId);
        }

        // Fetch orderbooks
        const orderbookMap = new Map<string, OrderbookPrices>();

        for (const conditionId of conditionIds) {
          try {
            const ob = await sdk.markets.getProcessedOrderbook(conditionId);
            const prices = extractPrices(ob);
            prices.conditionId = conditionId;
            orderbookMap.set(conditionId, prices);
          } catch (e) {
            if (verbose) {
              console.log(DIM + `  Skip orderbook ${conditionId.slice(0, 10)}...: ${(e as Error).message}` + RESET);
            }
          }
        }

        console.log(`  Fetched ${orderbookMap.size} orderbooks`);

        // Check for arbitrage
        const implOpps = batchCheckImplicationArbitrage(candidates, orderbookMap, minProfit);

        printImplicationTable(implOpps);
      }
    }
  }

  // ===== Summary =====
  printHeader('SUMMARY');

  const totalOpps = dutchBookOpps.length;
  console.log();
  console.log(`  ${BOLD}Dutch Book:${RESET} ${dutchBookOpps.length} opportunities`);

  if (dutchBookOpps.length > 0) {
    const bestDb = dutchBookOpps[0];
    console.log(`    Best: ${(bestDb.arb.profit * 100).toFixed(2)}% on "${bestDb.market.question.slice(0, 40)}..."`);
  }

  console.log();
  console.log(DIM + `  Scanned ${binaryMarkets.length} binary markets` + RESET);
  console.log();
}

// Run
main().catch((e) => {
  console.error(RED + 'Error: ' + e.message + RESET);
  process.exit(1);
});

