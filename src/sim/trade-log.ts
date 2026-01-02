/**
 * TradeLog - Persistent storage for simulated trades.
 *
 * Saves all simulated positions to JSON file for analysis and review.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SimPosition, PositionStats } from './position-tracker.js';
import { PositionTracker } from './position-tracker.js';

// ===== Types =====

export interface TradeLogEntry {
  id: string;
  timestamp: string;
  strategy: 'DUTCH_BOOK' | 'IMPLICATION';
  status: 'OPEN' | 'SETTLED';
  legs: Array<{
    conditionId: string;
    side: 'BUY' | 'SELL';
    token: 'YES' | 'NO';
    price: number;
    size: number;
    fee: number;
    netCost: number;
  }>;
  totalCost: number;
  expectedProfit: number;
  settledPnL?: number;
  settleTime?: string;
  notes?: string;
}

export interface TradeLogFile {
  version: string;
  createdAt: string;
  updatedAt: string;
  stats: PositionStats;
  trades: TradeLogEntry[];
}

// ===== Helper Functions =====

function positionToEntry(position: SimPosition): TradeLogEntry {
  return {
    id: position.id,
    timestamp: position.openTime.toISOString(),
    strategy: position.strategy,
    status: position.status,
    legs: position.legs.map((leg) => ({
      conditionId: leg.conditionId,
      side: leg.side,
      token: leg.token,
      price: leg.fill.price,
      size: leg.fill.size,
      fee: leg.fill.fee,
      netCost: leg.fill.netCost,
    })),
    totalCost: position.legs.reduce((sum, leg) => {
      return leg.side === 'BUY' ? sum + leg.fill.netCost : sum - leg.fill.netCost;
    }, 0),
    expectedProfit: position.expectedProfit,
    settledPnL: position.settledPnL,
    settleTime: position.settleTime?.toISOString(),
    notes: position.notes,
  };
}

function entryToPosition(entry: TradeLogEntry): SimPosition {
  return {
    id: entry.id,
    strategy: entry.strategy,
    legs: entry.legs.map((leg) => ({
      conditionId: leg.conditionId,
      side: leg.side,
      token: leg.token,
      fill: {
        side: leg.side,
        price: leg.price,
        size: leg.size,
        cost: leg.price * leg.size,
        fee: leg.fee,
        netCost: leg.netCost,
      },
    })),
    openTime: new Date(entry.timestamp),
    expectedProfit: entry.expectedProfit,
    status: entry.status,
    settledPnL: entry.settledPnL,
    settleTime: entry.settleTime ? new Date(entry.settleTime) : undefined,
    notes: entry.notes,
  };
}

// ===== TradeLog Class =====

export class TradeLog {
  private filepath: string;
  private tracker: PositionTracker;

  constructor(filepath: string, tracker?: PositionTracker) {
    this.filepath = filepath;
    this.tracker = tracker ?? new PositionTracker();

    // Ensure directory exists
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing data if file exists
    if (fs.existsSync(filepath)) {
      this.load();
    }
  }

  /**
   * Get the position tracker.
   */
  getTracker(): PositionTracker {
    return this.tracker;
  }

  /**
   * Save current state to file.
   */
  save(): void {
    const positions = this.tracker.exportPositions();
    const stats = this.tracker.getStats();

    const logFile: TradeLogFile = {
      version: '1.0',
      createdAt: fs.existsSync(this.filepath)
        ? this.getCreatedAt()
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats,
      trades: positions.map(positionToEntry),
    };

    fs.writeFileSync(this.filepath, JSON.stringify(logFile, null, 2));
  }

  /**
   * Load state from file.
   */
  load(): void {
    if (!fs.existsSync(this.filepath)) return;

    const content = fs.readFileSync(this.filepath, 'utf-8');
    const logFile: TradeLogFile = JSON.parse(content);

    // Clear and import positions
    this.tracker.clear();
    const positions = logFile.trades.map(entryToPosition);
    this.tracker.importPositions(positions);
  }

  /**
   * Get creation timestamp from existing file.
   */
  private getCreatedAt(): string {
    try {
      const content = fs.readFileSync(this.filepath, 'utf-8');
      const logFile: TradeLogFile = JSON.parse(content);
      return logFile.createdAt;
    } catch {
      return new Date().toISOString();
    }
  }

  /**
   * Add a position and save.
   */
  addAndSave(position: SimPosition): void {
    // Position should already be in tracker
    this.save();
  }

  /**
   * Get all trade entries.
   */
  getEntries(): TradeLogEntry[] {
    return this.tracker.exportPositions().map(positionToEntry);
  }

  /**
   * Get stats.
   */
  getStats(): PositionStats {
    return this.tracker.getStats();
  }

  /**
   * Export to CSV format.
   */
  exportCsv(): string {
    const entries = this.getEntries();

    const header = [
      'id',
      'timestamp',
      'strategy',
      'status',
      'totalCost',
      'expectedProfit',
      'settledPnL',
      'settleTime',
    ].join(',');

    const rows = entries.map((e) =>
      [
        e.id,
        e.timestamp,
        e.strategy,
        e.status,
        e.totalCost.toFixed(4),
        e.expectedProfit.toFixed(4),
        e.settledPnL?.toFixed(4) ?? '',
        e.settleTime ?? '',
      ].join(',')
    );

    return [header, ...rows].join('\n');
  }

  /**
   * Save CSV export to file.
   */
  saveCsv(filepath?: string): string {
    const csvPath = filepath ?? this.filepath.replace('.json', '.csv');
    const csv = this.exportCsv();
    fs.writeFileSync(csvPath, csv);
    return csvPath;
  }

  /**
   * Get summary string for display.
   */
  getSummary(): string {
    const stats = this.getStats();

    return [
      `Total Trades: ${stats.totalPositions}`,
      `  Open: ${stats.openPositions}`,
      `  Settled: ${stats.settledPositions}`,
      ``,
      `P&L:`,
      `  Realized: $${stats.realizedPnL.toFixed(2)}`,
      `  Unrealized: $${stats.unrealizedPnL.toFixed(2)}`,
      `  Total: $${stats.totalPnL.toFixed(2)}`,
      ``,
      `Performance:`,
      `  Win Rate: ${stats.winRate.toFixed(1)}%`,
      `  Avg Profit: $${stats.avgProfit.toFixed(4)}`,
      `  Max Drawdown: $${stats.maxDrawdown.toFixed(2)}`,
      ``,
      `By Strategy:`,
      `  Dutch Book: ${stats.byStrategy.DUTCH_BOOK.count} trades, $${stats.byStrategy.DUTCH_BOOK.pnl.toFixed(2)}`,
      `  Implication: ${stats.byStrategy.IMPLICATION.count} trades, $${stats.byStrategy.IMPLICATION.pnl.toFixed(2)}`,
    ].join('\n');
  }
}

// ===== Utility Functions =====

/**
 * Load trade log from file (read-only).
 */
export function loadTradeLog(filepath: string): TradeLogFile | null {
  if (!fs.existsSync(filepath)) return null;

  const content = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(content) as TradeLogFile;
}

/**
 * Merge multiple trade logs.
 */
export function mergeTradeLog(logs: TradeLogFile[]): TradeLogFile {
  const allTrades: TradeLogEntry[] = [];
  const seenIds = new Set<string>();

  for (const log of logs) {
    for (const trade of log.trades) {
      if (!seenIds.has(trade.id)) {
        seenIds.add(trade.id);
        allTrades.push(trade);
      }
    }
  }

  // Sort by timestamp
  allTrades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Create merged tracker for stats
  const tracker = new PositionTracker();
  tracker.importPositions(allTrades.map(entryToPosition));

  return {
    version: '1.0',
    createdAt: logs[0]?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: tracker.getStats(),
    trades: allTrades,
  };
}

