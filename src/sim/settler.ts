/**
 * Settler - Position settlement logic.
 *
 * Handles settlement for:
 * - Dutch Book: Immediate (merge Yes+No → $1)
 * - Implication: At expiry (based on market resolution)
 */

import type { SimPosition, PositionTracker } from './position-tracker.js';
import type { MarketMeta } from '../recorder/meta-recorder.js';

// ===== Types =====

export type ResolutionOutcome = 'YES' | 'NO' | 'INVALID';

export interface MarketResolutionInfo {
  conditionId: string;
  outcome: ResolutionOutcome;
  resolvedAt?: Date;
}

export interface SettlementResult {
  positionId: string;
  success: boolean;
  pnl: number;
  reason?: string;
}

// ===== Settlement Functions =====

/**
 * Settle a Dutch Book position.
 *
 * For Dutch Book, settlement is immediate:
 * - You bought Yes + No
 * - Merge them → receive $1 per pair
 * - PnL = $1 - (cost of Yes + cost of No)
 */
export function settleDutchBook(position: SimPosition): number {
  if (position.strategy !== 'DUTCH_BOOK') {
    throw new Error('Not a Dutch Book position');
  }

  // Total cost = sum of all leg costs
  const totalCost = position.legs.reduce((sum, leg) => sum + leg.fill.netCost, 0);

  // For Dutch Book, we get the minimum number of pairs
  // (limited by whichever leg has fewer shares)
  const yesShares = position.legs.find((l) => l.token === 'YES')?.fill.size ?? 0;
  const noShares = position.legs.find((l) => l.token === 'NO')?.fill.size ?? 0;
  const pairs = Math.min(yesShares, noShares);

  // Payout = $1 per pair
  const payout = pairs;

  // PnL
  const pnl = payout - totalCost;

  return pnl;
}

/**
 * Settle an Implication position.
 *
 * For A ⇒ B implication where you:
 * - Sold A_Yes (received cash, owe A_Yes token)
 * - Bought B_Yes (paid cash, own B_Yes token)
 *
 * Settlement scenarios:
 * - A=Yes, B=Yes: A_Yes=1 (you owe $1), B_Yes=1 (you receive $1) → net 0
 * - A=No, B=Yes:  A_Yes=0 (you owe $0), B_Yes=1 (you receive $1) → net +1
 * - A=No, B=No:   A_Yes=0 (you owe $0), B_Yes=0 (you receive $0) → net 0
 * - A=Yes, B=No:  IMPOSSIBLE if A ⇒ B holds
 *
 * Your profit comes from the initial cash flow (bid_A - ask_B).
 */
export function settleImplication(
  position: SimPosition,
  resolutionA: ResolutionOutcome,
  resolutionB: ResolutionOutcome
): number {
  if (position.strategy !== 'IMPLICATION') {
    throw new Error('Not an Implication position');
  }

  const sellLeg = position.legs.find((l) => l.side === 'SELL');
  const buyLeg = position.legs.find((l) => l.side === 'BUY');

  if (!sellLeg || !buyLeg) {
    throw new Error('Invalid implication position: missing legs');
  }

  // Initial cash flow from trade execution
  // sellLeg.fill.netCost = proceeds after fee (positive)
  // buyLeg.fill.netCost = cost including fee (positive)
  const initialCashFlow = sellLeg.fill.netCost - buyLeg.fill.netCost;

  // Settlement adjustments
  let settlementFlow = 0;

  // A_Yes settlement (you sold, so negative position)
  if (resolutionA === 'YES') {
    // You owe $1 per share sold
    settlementFlow -= sellLeg.fill.size;
  }
  // A=NO: you owe nothing

  // B_Yes settlement (you bought, so positive position)
  if (resolutionB === 'YES') {
    // You receive $1 per share bought
    settlementFlow += buyLeg.fill.size;
  }
  // B=NO: you receive nothing

  // Total PnL
  const pnl = initialCashFlow + settlementFlow;

  return pnl;
}

// ===== Settler Class =====

export class Settler {
  private tracker: PositionTracker;
  private resolutions: Map<string, MarketResolutionInfo> = new Map();

  constructor(tracker: PositionTracker) {
    this.tracker = tracker;
  }

  /**
   * Record a market resolution.
   */
  recordResolution(conditionId: string, outcome: ResolutionOutcome): void {
    this.resolutions.set(conditionId, {
      conditionId,
      outcome,
      resolvedAt: new Date(),
    });
  }

  /**
   * Check if a market has been resolved.
   */
  isResolved(conditionId: string): boolean {
    return this.resolutions.has(conditionId);
  }

  /**
   * Get resolution for a market.
   */
  getResolution(conditionId: string): MarketResolutionInfo | undefined {
    return this.resolutions.get(conditionId);
  }

  /**
   * Attempt to settle a position.
   */
  settlePosition(positionId: string): SettlementResult {
    const position = this.tracker.getPosition(positionId);

    if (!position) {
      return {
        positionId,
        success: false,
        pnl: 0,
        reason: 'Position not found',
      };
    }

    if (position.status === 'SETTLED') {
      return {
        positionId,
        success: true,
        pnl: position.settledPnL ?? 0,
        reason: 'Already settled',
      };
    }

    try {
      let pnl: number;

      if (position.strategy === 'DUTCH_BOOK') {
        // Dutch Book settles immediately
        pnl = settleDutchBook(position);
      } else {
        // Implication needs market resolutions
        const conditionIds = position.legs.map((l) => l.conditionId);
        const [conditionIdA, conditionIdB] = conditionIds;

        const resA = this.resolutions.get(conditionIdA);
        const resB = this.resolutions.get(conditionIdB);

        if (!resA || !resB) {
          return {
            positionId,
            success: false,
            pnl: 0,
            reason: `Markets not resolved: ${!resA ? conditionIdA : ''} ${!resB ? conditionIdB : ''}`.trim(),
          };
        }

        pnl = settleImplication(position, resA.outcome, resB.outcome);
      }

      // Update position in tracker
      this.tracker.settlePosition(positionId, pnl);

      return {
        positionId,
        success: true,
        pnl,
      };
    } catch (e) {
      return {
        positionId,
        success: false,
        pnl: 0,
        reason: (e as Error).message,
      };
    }
  }

  /**
   * Attempt to settle all open positions.
   */
  settleAll(): SettlementResult[] {
    const results: SettlementResult[] = [];

    for (const position of this.tracker.getOpenPositions()) {
      const result = this.settlePosition(position.id);
      results.push(result);
    }

    return results;
  }

  /**
   * Check which open positions can be settled (have all required resolutions).
   */
  getSettleable(): SimPosition[] {
    return this.tracker.getOpenPositions().filter((position) => {
      if (position.strategy === 'DUTCH_BOOK') {
        return true; // Always settleable
      }

      // Check all markets are resolved
      return position.legs.every((leg) => this.isResolved(leg.conditionId));
    });
  }

  /**
   * Import resolutions from metadata (check if markets are closed).
   */
  importResolutionsFromMeta(
    markets: MarketMeta[],
    outcomeResolver: (market: MarketMeta) => ResolutionOutcome | null
  ): number {
    let count = 0;

    for (const market of markets) {
      if (market.closed && !this.isResolved(market.conditionId)) {
        const outcome = outcomeResolver(market);
        if (outcome) {
          this.recordResolution(market.conditionId, outcome);
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Clear all resolutions.
   */
  clearResolutions(): void {
    this.resolutions.clear();
  }
}

