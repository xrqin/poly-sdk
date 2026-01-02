/**
 * TickRecorder - High-frequency orderbook tick recorder (polling or batch).
 *
 * Records best bid/ask prices at regular intervals for markets in watchlist.
 * Data is stored in CSV format for efficient storage and easy replay.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PolymarketSDK } from '../index.js';

// ===== Types =====

export interface TickRecord {
  ts: string;           // ISO timestamp with milliseconds
  conditionId: string;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}

export interface MarketTokenPair {
  yesTokenId: string;
  noTokenId: string;
}

export interface TickRecorderConfig {
  dataDir: string;           // Directory to store tick data
  watchlist: string[];       // List of conditionIds to record
  intervalMs?: number;       // Recording interval (default: 1000ms)
  /**
   * Optional SDK instance. If provided, the recorder will reuse the same cache and rate limiter.
   * This helps reduce duplicate API calls and avoid rate limiting.
   */
  sdk?: PolymarketSDK;
  /**
   * Max number of markets to record in parallel when polling per-market (non-batch mode).
   */
  concurrency?: number;
  /**
   * If provided, enables token-based recording without calling /markets during recording.
   * Useful to avoid Cloudflare rate limits on GET /markets/{conditionId}.
   */
  tokenMap?: Record<string, MarketTokenPair>;
  /**
   * If true (and tokenMap is present), fetches orderbooks in batches via getTokenOrderbooks()
   * instead of 2x per-market calls. This dramatically reduces request volume.
   */
  batchMode?: boolean;
  /**
   * Whether start() should run an immediate capture before scheduling the interval timer.
   * Defaults to true.
   */
  startImmediate?: boolean;
}

// ===== Helper Functions =====

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function tickToCsvLine(tick: TickRecord): string {
  return `${tick.ts},${tick.yesBid},${tick.yesAsk},${tick.noBid},${tick.noAsk}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvLineToTick(line: string, conditionId: string): TickRecord | null {
  const parts = line.split(',');
  if (parts.length < 5) return null;

  return {
    ts: parts[0],
    conditionId,
    yesBid: parseFloat(parts[1]),
    yesAsk: parseFloat(parts[2]),
    noBid: parseFloat(parts[3]),
    noAsk: parseFloat(parts[4]),
  };
}

// ===== TickRecorder Class =====

export class TickRecorder {
  private sdk: PolymarketSDK;
  private config: Required<TickRecorderConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;
  private fileHandles: Map<string, { stream: fs.WriteStream; date: string }> = new Map();
  private tickCount = 0;
  private errorCount = 0;
  private latestTicks: Map<string, TickRecord> = new Map();

  constructor(config: TickRecorderConfig) {
    this.sdk = config.sdk ?? new PolymarketSDK();
    this.config = {
      dataDir: config.dataDir,
      watchlist: config.watchlist,
      intervalMs: config.intervalMs ?? 1000,
      sdk: config.sdk ?? this.sdk,
      concurrency: config.concurrency ?? 3,
      tokenMap: config.tokenMap ?? {},
      batchMode: config.batchMode ?? false,
      startImmediate: config.startImmediate ?? true,
    };

    // Ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
  }

  /**
   * Get or create file stream for a market on a given date.
   */
  private getFileStream(conditionId: string, date: string): fs.WriteStream {
    const existing = this.fileHandles.get(conditionId);

    // If we have a stream for a different date, close it
    if (existing && existing.date !== date) {
      existing.stream.end();
      this.fileHandles.delete(conditionId);
    }

    // Check if we already have the right stream
    const current = this.fileHandles.get(conditionId);
    if (current && current.date === date) {
      return current.stream;
    }

    // Create directory for this conditionId (use truncated id for readability)
    const shortId = conditionId.slice(0, 16);
    const marketDir = path.join(this.config.dataDir, shortId);
    if (!fs.existsSync(marketDir)) {
      fs.mkdirSync(marketDir, { recursive: true });
    }

    // Create or append to CSV file
    const filepath = path.join(marketDir, `${date}.csv`);
    const isNew = !fs.existsSync(filepath);

    const stream = fs.createWriteStream(filepath, { flags: 'a' });

    // Write header if new file
    if (isNew) {
      stream.write('ts,yesBid,yesAsk,noBid,noAsk\n');
    }

    this.fileHandles.set(conditionId, { stream, date });

    return stream;
  }

  /**
   * Record a single tick for a market.
   */
  private async recordTick(conditionId: string): Promise<TickRecord | null> {
    try {
      // If tokenMap is provided, avoid /markets by fetching token orderbooks directly
      const pair = this.config.tokenMap?.[conditionId];
      if (pair?.yesTokenId && pair?.noTokenId) {
        const [yesBook, noBook] = await Promise.all([
          this.sdk.markets.getTokenOrderbook(pair.yesTokenId),
          this.sdk.markets.getTokenOrderbook(pair.noTokenId),
        ]);

        const tick: TickRecord = {
          ts: new Date().toISOString(),
          conditionId,
          yesBid: yesBook.bids[0]?.price ?? 0,
          yesAsk: yesBook.asks[0]?.price ?? 1,
          noBid: noBook.bids[0]?.price ?? 0,
          noAsk: noBook.asks[0]?.price ?? 1,
        };

        // Write to file
        const date = formatDate(new Date());
        const stream = this.getFileStream(conditionId, date);
        stream.write(tickToCsvLine(tick) + '\n');

        this.latestTicks.set(conditionId, tick);
        this.tickCount++;
        return tick;
      }

      const orderbook = await this.sdk.markets.getProcessedOrderbook(conditionId);

      const tick: TickRecord = {
        ts: new Date().toISOString(),
        conditionId,
        yesBid: orderbook.yes.bid,
        yesAsk: orderbook.yes.ask,
        noBid: orderbook.no.bid,
        noAsk: orderbook.no.ask,
      };

      // Write to file
      const date = formatDate(new Date());
      const stream = this.getFileStream(conditionId, date);
      stream.write(tickToCsvLine(tick) + '\n');

      this.latestTicks.set(conditionId, tick);
      this.tickCount++;
      return tick;
    } catch (e) {
      this.errorCount++;
      // Silently skip errors (market might be closed, etc.)
      return null;
    }
  }

  /**
   * Record ticks for all markets in watchlist.
   */
  private async recordAllTicks(): Promise<void> {
    // Batch mode: fetch all token orderbooks in 1-2 requests per tick
    if (this.config.batchMode && this.config.tokenMap && Object.keys(this.config.tokenMap).length > 0) {
      await this.recordAllTicksBatch();
      return;
    }

    // Polling mode: record per market with concurrency limit
    const concurrency = this.config.concurrency;
    const chunks: string[][] = [];

    for (let i = 0; i < this.config.watchlist.length; i += concurrency) {
      chunks.push(this.config.watchlist.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map((id) => this.recordTick(id)));
      // Small delay between chunks to avoid bursty traffic
      await sleep(50);
    }
  }

  private async recordAllTicksBatch(): Promise<void> {
    const tokenIds: string[] = [];
    const pairs: Array<{ conditionId: string; yesTokenId: string; noTokenId: string }> = [];

    for (const conditionId of this.config.watchlist) {
      const pair = this.config.tokenMap?.[conditionId];
      if (!pair?.yesTokenId || !pair?.noTokenId) continue;
      pairs.push({ conditionId, yesTokenId: pair.yesTokenId, noTokenId: pair.noTokenId });
      tokenIds.push(pair.yesTokenId, pair.noTokenId);
    }

    if (tokenIds.length === 0) return;

    // De-duplicate token IDs
    const uniqueTokenIds = Array.from(new Set(tokenIds));

    // Some CLOB deployments may require "side" to be present; we query both sides and merge.
    const buyParams = uniqueTokenIds.map((tokenId) => ({ tokenId, side: 'BUY' as const }));
    const sellParams = uniqueTokenIds.map((tokenId) => ({ tokenId, side: 'SELL' as const }));

    const [buyBooks, sellBooks] = await Promise.all([
      this.sdk.markets.getTokenOrderbooks(buyParams),
      this.sdk.markets.getTokenOrderbooks(sellParams),
    ]);

    const now = new Date();
    const date = formatDate(now);

    for (const p of pairs) {
      try {
        const yesBuy = buyBooks.get(p.yesTokenId);
        const yesSell = sellBooks.get(p.yesTokenId);
        const noBuy = buyBooks.get(p.noTokenId);
        const noSell = sellBooks.get(p.noTokenId);

        const yesBids = yesBuy?.bids ?? yesSell?.bids ?? [];
        const yesAsks = yesSell?.asks ?? yesBuy?.asks ?? [];
        const noBids = noBuy?.bids ?? noSell?.bids ?? [];
        const noAsks = noSell?.asks ?? noBuy?.asks ?? [];

        const tick: TickRecord = {
          ts: now.toISOString(),
          conditionId: p.conditionId,
          yesBid: yesBids[0]?.price ?? 0,
          yesAsk: yesAsks[0]?.price ?? 1,
          noBid: noBids[0]?.price ?? 0,
          noAsk: noAsks[0]?.price ?? 1,
        };

        const stream = this.getFileStream(p.conditionId, date);
        stream.write(tickToCsvLine(tick) + '\n');

        this.latestTicks.set(p.conditionId, tick);
        this.tickCount++;
      } catch {
        this.errorCount++;
      }
    }
  }

  /**
   * Capture one tick batch immediately (useful for scripts that want to await first data).
   */
  async captureOnce(): Promise<void> {
    await this.recordAllTicks();
  }

  /**
   * Start recording.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.tickCount = 0;
    this.errorCount = 0;

    console.log(`[TickRecorder] Starting with ${this.config.watchlist.length} markets, interval=${this.config.intervalMs}ms`);

    // Record immediately
    if (this.config.startImmediate) {
      this.captureOnce().catch((e) => {
        console.error(`[TickRecorder] Error: ${(e as Error).message}`);
      });
    }

    // Schedule periodic recording
    this.timer = setInterval(async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      try {
        await this.recordAllTicks();
      } catch (e) {
        console.error(`[TickRecorder] Error: ${(e as Error).message}`);
      } finally {
        this.inFlight = false;
      }
    }, this.config.intervalMs);
  }

  /**
   * Stop recording.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Close all file streams
    for (const [, { stream }] of this.fileHandles) {
      stream.end();
    }
    this.fileHandles.clear();

    this.running = false;

    console.log(`[TickRecorder] Stopped. Total ticks: ${this.tickCount}, errors: ${this.errorCount}`);
  }

  /**
   * Check if recorder is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get recording stats.
   */
  getStats(): { tickCount: number; errorCount: number; marketCount: number } {
    return {
      tickCount: this.tickCount,
      errorCount: this.errorCount,
      marketCount: this.config.watchlist.length,
    };
  }

  /**
   * Get the latest tick for a conditionId (in-memory).
   */
  getLatestTick(conditionId: string): TickRecord | undefined {
    return this.latestTicks.get(conditionId);
  }

  /**
   * Get all latest ticks (in-memory).
   */
  getLatestTicks(): TickRecord[] {
    return Array.from(this.latestTicks.values());
  }

  /**
   * Update watchlist (can be called while running).
   */
  updateWatchlist(newWatchlist: string[]): void {
    this.config.watchlist = newWatchlist;
    console.log(`[TickRecorder] Watchlist updated: ${newWatchlist.length} markets`);
  }

  /**
   * Update token map (can be called while running).
   */
  updateTokenMap(tokenMap: Record<string, MarketTokenPair>): void {
    this.config.tokenMap = tokenMap;
    console.log(`[TickRecorder] Token map updated: ${Object.keys(tokenMap).length} markets`);
  }
}

// ===== Utility Functions =====

/**
 * Load tick data from a CSV file.
 */
export function loadTicksFromFile(filepath: string, conditionId: string): TickRecord[] {
  if (!fs.existsSync(filepath)) return [];

  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('ts,'));

  return lines
    .map((line) => csvLineToTick(line, conditionId))
    .filter((t): t is TickRecord => t !== null);
}

/**
 * Load all tick data for a market from a directory.
 */
export function loadTicksForMarket(dataDir: string, conditionId: string): TickRecord[] {
  const shortId = conditionId.slice(0, 16);
  const marketDir = path.join(dataDir, shortId);

  if (!fs.existsSync(marketDir)) return [];

  const files = fs.readdirSync(marketDir)
    .filter((f) => f.endsWith('.csv'))
    .sort();

  const allTicks: TickRecord[] = [];

  for (const file of files) {
    const ticks = loadTicksFromFile(path.join(marketDir, file), conditionId);
    allTicks.push(...ticks);
  }

  return allTicks;
}

/**
 * Load tick data for a date range.
 */
export function loadTicksInRange(
  dataDir: string,
  conditionId: string,
  startDate: string,
  endDate: string
): TickRecord[] {
  const shortId = conditionId.slice(0, 16);
  const marketDir = path.join(dataDir, shortId);

  if (!fs.existsSync(marketDir)) return [];

  const files = fs.readdirSync(marketDir)
    .filter((f) => {
      if (!f.endsWith('.csv')) return false;
      const date = f.replace('.csv', '');
      return date >= startDate && date <= endDate;
    })
    .sort();

  const allTicks: TickRecord[] = [];

  for (const file of files) {
    const ticks = loadTicksFromFile(path.join(marketDir, file), conditionId);
    allTicks.push(...ticks);
  }

  return allTicks;
}

/**
 * Get list of recorded markets in data directory.
 */
export function getRecordedMarkets(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return [];

  return fs.readdirSync(dataDir)
    .filter((f) => fs.statSync(path.join(dataDir, f)).isDirectory());
}

