/**
 * MetaRecorder - Market metadata snapshot recorder.
 *
 * Captures market metadata (question, description, endDate, volume, etc.)
 * at regular intervals (hourly/daily) for:
 * - Generating/maintaining watchlists
 * - Aligning conditionId to human-readable info
 * - Providing semantic material for AI relation extraction
 */

import * as fs from 'fs';
import * as path from 'path';
import { PolymarketSDK } from '../index.js';
import type { GammaMarket } from '../clients/gamma-api.js';

// ===== Types =====

export interface MarketMeta {
  conditionId: string;
  slug: string;
  question: string;
  description?: string;
  outcomes: string[];
  endDate: string;
  active: boolean;
  closed: boolean;
  volume24hr?: number;
  liquidity?: number;
  spread?: number;
}

export interface MetaSnapshot {
  capturedAt: string;  // ISO timestamp
  marketCount: number;
  markets: MarketMeta[];
}

export interface MetaRecorderConfig {
  dataDir: string;           // Directory to store meta snapshots
  intervalMs?: number;       // Capture interval (default: 1 hour)
  marketLimit?: number;      // Max markets to fetch (default: 500)
  minVolume24hr?: number;    // Filter: minimum 24h volume (default: 0)
  onlyActive?: boolean;      // Filter: only active markets (default: true)
}

// ===== Helper Functions =====

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function safeToISOString(date: unknown): string {
  if (!date) return '';
  if (date instanceof Date) {
    return isNaN(date.getTime()) ? '' : date.toISOString();
  }
  if (typeof date === 'string') return date;
  if (typeof date === 'number') {
    const d = new Date(date);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return String(date);
}

function gammaToMeta(m: GammaMarket): MarketMeta {
  return {
    conditionId: m.conditionId,
    slug: m.slug,
    question: m.question,
    description: m.description,
    outcomes: m.outcomes,
    endDate: safeToISOString(m.endDate),
    active: m.active,
    closed: m.closed,
    volume24hr: m.volume24hr,
    liquidity: m.liquidity,
    spread: m.spread,
  };
}

// ===== MetaRecorder Class =====

export class MetaRecorder {
  private sdk: PolymarketSDK;
  private config: Required<MetaRecorderConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: MetaRecorderConfig) {
    this.sdk = new PolymarketSDK();
    this.config = {
      dataDir: config.dataDir,
      intervalMs: config.intervalMs ?? 60 * 60 * 1000, // 1 hour
      marketLimit: config.marketLimit ?? 500,
      minVolume24hr: config.minVolume24hr ?? 0,
      onlyActive: config.onlyActive ?? true,
    };

    // Ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
  }

  /**
   * Capture a single metadata snapshot.
   */
  async captureSnapshot(): Promise<MetaSnapshot> {
    const markets = await this.sdk.gammaApi.getMarkets({
      active: this.config.onlyActive,
      closed: false,
      order: 'volume24hr',
      ascending: false,
      limit: this.config.marketLimit,
    });

    // Filter by minimum volume
    const filtered = markets.filter(
      (m) => (m.volume24hr ?? 0) >= this.config.minVolume24hr
    );

    const snapshot: MetaSnapshot = {
      capturedAt: new Date().toISOString(),
      marketCount: filtered.length,
      markets: filtered.map(gammaToMeta),
    };

    return snapshot;
  }

  /**
   * Save snapshot to file.
   * Filename format: meta-YYYY-MM-DD.json
   * If file exists for today, it will be overwritten (latest snapshot wins).
   */
  saveSnapshot(snapshot: MetaSnapshot): string {
    const date = formatDate(new Date(snapshot.capturedAt));
    const filename = `meta-${date}.json`;
    const filepath = path.join(this.config.dataDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));

    return filepath;
  }

  /**
   * Capture and save a snapshot.
   */
  async captureAndSave(): Promise<{ snapshot: MetaSnapshot; filepath: string }> {
    const snapshot = await this.captureSnapshot();
    const filepath = this.saveSnapshot(snapshot);
    return { snapshot, filepath };
  }

  /**
   * Start periodic capture.
   */
  start(): void {
    if (this.running) return;

    this.running = true;

    // Capture immediately
    this.captureAndSave()
      .then(({ filepath, snapshot }) => {
        console.log(`[MetaRecorder] Captured ${snapshot.marketCount} markets → ${filepath}`);
      })
      .catch((e) => {
        console.error(`[MetaRecorder] Error: ${(e as Error).message}`);
      });

    // Schedule periodic captures
    this.timer = setInterval(async () => {
      try {
        const { filepath, snapshot } = await this.captureAndSave();
        console.log(`[MetaRecorder] Captured ${snapshot.marketCount} markets → ${filepath}`);
      } catch (e) {
        console.error(`[MetaRecorder] Error: ${(e as Error).message}`);
      }
    }, this.config.intervalMs);
  }

  /**
   * Stop periodic capture.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * Check if recorder is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

// ===== Utility Functions =====

/**
 * Load a metadata snapshot from file.
 */
export function loadMetaSnapshot(filepath: string): MetaSnapshot {
  const content = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(content) as MetaSnapshot;
}

/**
 * Load the latest metadata snapshot from a directory.
 */
export function loadLatestMeta(dataDir: string): MetaSnapshot | null {
  if (!fs.existsSync(dataDir)) return null;

  const files = fs.readdirSync(dataDir)
    .filter((f) => f.startsWith('meta-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  return loadMetaSnapshot(path.join(dataDir, files[0]));
}

/**
 * Build a conditionId -> MarketMeta lookup map from a snapshot.
 */
export function buildMetaMap(snapshot: MetaSnapshot): Map<string, MarketMeta> {
  const map = new Map<string, MarketMeta>();
  for (const m of snapshot.markets) {
    map.set(m.conditionId, m);
  }
  return map;
}

/**
 * Extract watchlist (conditionIds) from snapshot based on criteria.
 */
export function extractWatchlist(
  snapshot: MetaSnapshot,
  options: {
    minVolume24hr?: number;
    minLiquidity?: number;
    maxSpread?: number;
    limit?: number;
  } = {}
): string[] {
  const { minVolume24hr = 0, minLiquidity = 0, maxSpread = 1, limit = 100 } = options;

  return snapshot.markets
    .filter((m) => {
      if ((m.volume24hr ?? 0) < minVolume24hr) return false;
      if ((m.liquidity ?? 0) < minLiquidity) return false;
      if ((m.spread ?? 0) > maxSpread) return false;
      return true;
    })
    .slice(0, limit)
    .map((m) => m.conditionId);
}

