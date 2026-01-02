/**
 * Implication-based cross-market arbitrage detection.
 *
 * If A ⇒ B (A implies B), then P(A) should be ≤ P(B).
 * When P(A) > P(B), there's an arbitrage opportunity:
 *   - Sell A_Yes (receive bid_A)
 *   - Buy B_Yes (pay ask_B)
 *
 * At settlement:
 *   - If A=Yes → B=Yes (by implication) → both positions cancel out
 *   - If A=No → A_Yes=0, B may or may not settle Yes
 *
 * For RISK-FREE arbitrage, we need: bid_A > ask_B
 * This ensures profit regardless of outcome.
 */

import type { ProcessedOrderbook } from '../core/types.js';
import type { ImplicationCandidate, MarketRef, RelationType, ConfidenceLevel } from './relation-extractor.js';

// ===== Types =====

export interface ImplicationArbOpportunity {
  type: 'IMPLICATION';
  relation: string;  // Human readable: "A → B"
  relationType: RelationType;
  marketA: MarketRef;
  marketB: MarketRef;
  action: string;
  profit: number;           // Absolute profit (bid_A - ask_B)
  profitPercent: number;    // Percentage profit
  confidence: ConfidenceLevel;
  prices: {
    bidA: number;   // What you receive selling A_Yes
    askB: number;   // What you pay buying B_Yes
  };
}

export interface OrderbookPrices {
  conditionId: string;
  yesBid: number;   // Best bid for Yes token
  yesAsk: number;   // Best ask for Yes token
  noBid: number;    // Best bid for No token
  noAsk: number;    // Best ask for No token
}

// ===== Helper Functions =====

/**
 * Extract relevant prices from ProcessedOrderbook.
 */
export function extractPrices(orderbook: ProcessedOrderbook): OrderbookPrices {
  return {
    conditionId: '', // Will be set by caller
    yesBid: orderbook.yes.bid,
    yesAsk: orderbook.yes.ask,
    noBid: orderbook.no.bid,
    noAsk: orderbook.no.ask,
  };
}

/**
 * Format relation as human-readable string.
 */
function formatRelation(
  marketA: MarketRef,
  marketB: MarketRef,
  relation: RelationType
): string {
  const a = truncateQuestion(marketA.question, 40);
  const b = truncateQuestion(marketB.question, 40);

  switch (relation) {
    case 'A_IMPLIES_B':
      return `"${a}" → "${b}"`;
    case 'B_IMPLIES_A':
      return `"${b}" → "${a}"`;
    case 'EQUIVALENT':
      return `"${a}" ↔ "${b}"`;
  }
}

function truncateQuestion(q: string, maxLen: number): string {
  if (q.length <= maxLen) return q;
  return q.slice(0, maxLen - 3) + '...';
}

// ===== Core Arbitrage Check =====

/**
 * Check for implication-based arbitrage opportunity.
 *
 * Given A ⇒ B:
 * - If P(A_Yes) > P(B_Yes), arbitrage exists
 * - Specifically, if bid_A > ask_B, it's risk-free
 *
 * @param candidate - The implication relationship
 * @param pricesA - Orderbook prices for market A
 * @param pricesB - Orderbook prices for market B
 * @param minProfit - Minimum profit threshold (default 0.5%)
 * @returns Arbitrage opportunity if found, null otherwise
 */
export function checkImplicationArbitrage(
  candidate: ImplicationCandidate,
  pricesA: OrderbookPrices,
  pricesB: OrderbookPrices,
  minProfit: number = 0.005
): ImplicationArbOpportunity | null {
  const { relation, confidence, marketA, marketB } = candidate;

  // Determine which direction to check based on relation type
  // A_IMPLIES_B: A → B, so P(A) ≤ P(B), check if bid_A > ask_B
  // B_IMPLIES_A: B → A, so P(B) ≤ P(A), check if bid_B > ask_A
  // EQUIVALENT: P(A) ≈ P(B), check both directions

  let bidSeller: number;
  let askBuyer: number;
  let sellerMarket: MarketRef;
  let buyerMarket: MarketRef;
  let effectiveRelation: RelationType;

  if (relation === 'A_IMPLIES_B') {
    // A → B means if A happens, B must happen
    // So we sell A_Yes (if A=Yes, we need B=Yes which is guaranteed)
    // and buy B_Yes as hedge
    bidSeller = pricesA.yesBid;
    askBuyer = pricesB.yesAsk;
    sellerMarket = marketA;
    buyerMarket = marketB;
    effectiveRelation = relation;
  } else if (relation === 'B_IMPLIES_A') {
    // B → A means if B happens, A must happen
    // So we sell B_Yes and buy A_Yes
    bidSeller = pricesB.yesBid;
    askBuyer = pricesA.yesAsk;
    sellerMarket = marketB;
    buyerMarket = marketA;
    effectiveRelation = relation;
  } else {
    // EQUIVALENT: check both directions
    const profitAB = pricesA.yesBid - pricesB.yesAsk;
    const profitBA = pricesB.yesBid - pricesA.yesAsk;

    if (profitAB > profitBA && profitAB > minProfit) {
      bidSeller = pricesA.yesBid;
      askBuyer = pricesB.yesAsk;
      sellerMarket = marketA;
      buyerMarket = marketB;
      effectiveRelation = 'A_IMPLIES_B';
    } else if (profitBA > minProfit) {
      bidSeller = pricesB.yesBid;
      askBuyer = pricesA.yesAsk;
      sellerMarket = marketB;
      buyerMarket = marketA;
      effectiveRelation = 'B_IMPLIES_A';
    } else {
      return null;
    }
  }

  const profit = bidSeller - askBuyer;

  // Check if profit exceeds threshold
  if (profit <= minProfit) {
    return null;
  }

  // Calculate profit percentage (relative to capital deployed)
  // Capital = ask_B (what you pay to buy B_Yes)
  const profitPercent = askBuyer > 0 ? (profit / askBuyer) * 100 : 0;

  return {
    type: 'IMPLICATION',
    relation: formatRelation(marketA, marketB, effectiveRelation),
    relationType: effectiveRelation,
    marketA: sellerMarket,  // The one we sell
    marketB: buyerMarket,   // The one we buy
    action: `Sell ${truncateQuestion(sellerMarket.question, 30)}_Yes @ ${bidSeller.toFixed(4)}, Buy ${truncateQuestion(buyerMarket.question, 30)}_Yes @ ${askBuyer.toFixed(4)}`,
    profit,
    profitPercent,
    confidence,
    prices: {
      bidA: bidSeller,
      askB: askBuyer,
    },
  };
}

/**
 * Batch check multiple implication candidates.
 *
 * @param candidates - List of implication candidates from LLM
 * @param orderbookMap - Map of conditionId -> OrderbookPrices
 * @param minProfit - Minimum profit threshold
 * @returns List of valid arbitrage opportunities
 */
export function batchCheckImplicationArbitrage(
  candidates: ImplicationCandidate[],
  orderbookMap: Map<string, OrderbookPrices>,
  minProfit: number = 0.005
): ImplicationArbOpportunity[] {
  const opportunities: ImplicationArbOpportunity[] = [];

  for (const candidate of candidates) {
    const pricesA = orderbookMap.get(candidate.marketA.conditionId);
    const pricesB = orderbookMap.get(candidate.marketB.conditionId);

    if (!pricesA || !pricesB) {
      // Skip if we don't have orderbook data for either market
      continue;
    }

    const opp = checkImplicationArbitrage(candidate, pricesA, pricesB, minProfit);
    if (opp) {
      opportunities.push(opp);
    }
  }

  // Sort by profit descending
  opportunities.sort((a, b) => b.profit - a.profit);

  return opportunities;
}

/**
 * Validate that an implication relationship makes sense.
 * Additional sanity checks beyond LLM output.
 */
export function validateImplication(
  candidate: ImplicationCandidate,
  pricesA: OrderbookPrices,
  pricesB: OrderbookPrices
): { valid: boolean; reason?: string } {
  // Basic price sanity checks
  if (pricesA.yesAsk <= 0 || pricesA.yesBid <= 0) {
    return { valid: false, reason: 'Market A has invalid prices' };
  }
  if (pricesB.yesAsk <= 0 || pricesB.yesBid <= 0) {
    return { valid: false, reason: 'Market B has invalid prices' };
  }

  // Check for extreme spreads (might indicate illiquid market)
  const spreadA = pricesA.yesAsk - pricesA.yesBid;
  const spreadB = pricesB.yesAsk - pricesB.yesBid;

  if (spreadA > 0.2) {
    return { valid: false, reason: 'Market A has very wide spread (>20%)' };
  }
  if (spreadB > 0.2) {
    return { valid: false, reason: 'Market B has very wide spread (>20%)' };
  }

  return { valid: true };
}

