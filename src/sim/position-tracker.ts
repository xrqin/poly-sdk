/**
 * PositionTracker - Simulated position and P&L tracking.
 *
 * Tracks open positions, settled positions, and calculates overall P&L.
 */

import type { SimFill, DutchBookSimResult, ImplicationSimResult } from './sim-executor.js';

// ===== Types =====

export type StrategyType = 'DUTCH_BOOK' | 'IMPLICATION';
export type PositionStatus = 'OPEN' | 'SETTLED';

export interface SimLeg {
  conditionId: string;
  side: 'BUY' | 'SELL';
  token: 'YES' | 'NO';
  fill: SimFill;
}

export interface SimPosition {
  id: string;
  strategy: StrategyType;
  legs: SimLeg[];
  openTime: Date;
  expectedProfit: number;
  status: PositionStatus;
  settledPnL?: number;
  settleTime?: Date;
  notes?: string;
}

export interface PositionStats {
  totalPositions: number;
  openPositions: number;
  settledPositions: number;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgProfit: number;
  maxDrawdown: number;
  byStrategy: {
    DUTCH_BOOK: { count: number; pnl: number };
    IMPLICATION: { count: number; pnl: number };
  };
}

// ===== PositionTracker Class =====

export class PositionTracker {
  private positions: Map<string, SimPosition> = new Map();
  private idCounter = 0;
  private peakPnL = 0;
  private maxDrawdown = 0;

  /**
   * Generate unique position ID.
   */
  private generateId(): string {
    this.idCounter++;
    return `SIM-${Date.now()}-${this.idCounter}`;
  }

  /**
   * Open a Dutch Book position (immediately settled since it's a merge).
   */
  openDutchBook(
    conditionId: string,
    result: DutchBookSimResult
  ): SimPosition {
    const id = this.generateId();

    const position: SimPosition = {
      id,
      strategy: 'DUTCH_BOOK',
      legs: [
        {
          conditionId,
          side: 'BUY',
          token: 'YES',
          fill: result.yesLeg,
        },
        {
          conditionId,
          side: 'BUY',
          token: 'NO',
          fill: result.noLeg,
        },
      ],
      openTime: new Date(),
      expectedProfit: result.expectedProfit,
      status: 'SETTLED',  // Dutch Book settles immediately (merge)
      settledPnL: result.expectedProfit,
      settleTime: new Date(),
    };

    this.positions.set(id, position);
    this.updateDrawdown();

    return position;
  }

  /**
   * Open an Implication position (needs to wait for settlement).
   */
  openImplication(
    conditionIdA: string,
    conditionIdB: string,
    result: ImplicationSimResult
  ): SimPosition {
    const id = this.generateId();

    const position: SimPosition = {
      id,
      strategy: 'IMPLICATION',
      legs: [
        {
          conditionId: conditionIdA,
          side: 'SELL',
          token: 'YES',
          fill: result.sellLeg,
        },
        {
          conditionId: conditionIdB,
          side: 'BUY',
          token: 'YES',
          fill: result.buyLeg,
        },
      ],
      openTime: new Date(),
      expectedProfit: result.expectedProfit,
      status: 'OPEN',
    };

    this.positions.set(id, position);

    return position;
  }

  /**
   * Settle an open position.
   */
  settlePosition(
    positionId: string,
    actualPnL: number,
    notes?: string
  ): SimPosition | null {
    const position = this.positions.get(positionId);
    if (!position) return null;

    position.status = 'SETTLED';
    position.settledPnL = actualPnL;
    position.settleTime = new Date();
    if (notes) position.notes = notes;

    this.updateDrawdown();

    return position;
  }

  /**
   * Get a position by ID.
   */
  getPosition(positionId: string): SimPosition | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get all positions.
   */
  getAllPositions(): SimPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get open positions.
   */
  getOpenPositions(): SimPosition[] {
    return this.getAllPositions().filter((p) => p.status === 'OPEN');
  }

  /**
   * Get settled positions.
   */
  getSettledPositions(): SimPosition[] {
    return this.getAllPositions().filter((p) => p.status === 'SETTLED');
  }

  /**
   * Calculate total realized P&L.
   */
  getRealizedPnL(): number {
    return this.getSettledPositions().reduce(
      (sum, p) => sum + (p.settledPnL ?? 0),
      0
    );
  }

  /**
   * Calculate unrealized P&L (expected profit from open positions).
   */
  getUnrealizedPnL(): number {
    return this.getOpenPositions().reduce(
      (sum, p) => sum + p.expectedProfit,
      0
    );
  }

  /**
   * Update max drawdown tracking.
   */
  private updateDrawdown(): void {
    const currentPnL = this.getRealizedPnL();

    if (currentPnL > this.peakPnL) {
      this.peakPnL = currentPnL;
    }

    const drawdown = this.peakPnL - currentPnL;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
  }

  /**
   * Get comprehensive statistics.
   */
  getStats(): PositionStats {
    const all = this.getAllPositions();
    const settled = this.getSettledPositions();
    const open = this.getOpenPositions();

    const realizedPnL = this.getRealizedPnL();
    const unrealizedPnL = this.getUnrealizedPnL();

    const wins = settled.filter((p) => (p.settledPnL ?? 0) > 0);
    const losses = settled.filter((p) => (p.settledPnL ?? 0) <= 0);

    const dutchBook = settled.filter((p) => p.strategy === 'DUTCH_BOOK');
    const implication = settled.filter((p) => p.strategy === 'IMPLICATION');

    return {
      totalPositions: all.length,
      openPositions: open.length,
      settledPositions: settled.length,
      totalPnL: realizedPnL + unrealizedPnL,
      realizedPnL,
      unrealizedPnL,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: settled.length > 0 ? (wins.length / settled.length) * 100 : 0,
      avgProfit: settled.length > 0 ? realizedPnL / settled.length : 0,
      maxDrawdown: this.maxDrawdown,
      byStrategy: {
        DUTCH_BOOK: {
          count: dutchBook.length,
          pnl: dutchBook.reduce((s, p) => s + (p.settledPnL ?? 0), 0),
        },
        IMPLICATION: {
          count: implication.length,
          pnl: implication.reduce((s, p) => s + (p.settledPnL ?? 0), 0),
        },
      },
    };
  }

  /**
   * Export positions to JSON-serializable format.
   */
  exportPositions(): SimPosition[] {
    return this.getAllPositions().map((p) => ({
      ...p,
      openTime: new Date(p.openTime),
      settleTime: p.settleTime ? new Date(p.settleTime) : undefined,
    }));
  }

  /**
   * Import positions from JSON.
   */
  importPositions(positions: SimPosition[]): void {
    for (const p of positions) {
      this.positions.set(p.id, {
        ...p,
        openTime: new Date(p.openTime),
        settleTime: p.settleTime ? new Date(p.settleTime) : undefined,
      });

      // Update ID counter to avoid collisions
      const idNum = parseInt(p.id.split('-')[2] || '0', 10);
      if (idNum >= this.idCounter) {
        this.idCounter = idNum + 1;
      }
    }

    this.updateDrawdown();
  }

  /**
   * Clear all positions.
   */
  clear(): void {
    this.positions.clear();
    this.idCounter = 0;
    this.peakPnL = 0;
    this.maxDrawdown = 0;
  }
}

