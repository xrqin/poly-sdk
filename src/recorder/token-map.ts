/**
 * Token map utilities for CLOB markets.
 *
 * Purpose:
 * - Resolve YES/NO token IDs for a list of conditionIds
 * - Persist the mapping to disk to avoid repeatedly calling GET /markets/{conditionId}
 * - Reduce Cloudflare rate limiting issues for polling-based systems
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PolymarketSDK } from '../index.js';
import type { MarketTokenPair } from './tick-recorder.js';

export type TokenMap = Record<string, MarketTokenPair>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadTokenMap(filepath: string): TokenMap {
  try {
    if (!fs.existsSync(filepath)) return {};
    const raw = fs.readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as TokenMap;
  } catch {
    return {};
  }
}

export function saveTokenMap(filepath: string, map: TokenMap): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

export async function ensureTokenMap(
  sdk: PolymarketSDK,
  conditionIds: string[],
  filepath: string,
  options?: { delayMs?: number }
): Promise<TokenMap> {
  const delayMs = options?.delayMs ?? 250;
  const map = loadTokenMap(filepath);

  const unique = Array.from(new Set(conditionIds));
  for (const conditionId of unique) {
    const existing = map[conditionId];
    if (existing?.yesTokenId && existing?.noTokenId) continue;

    try {
      const market = await sdk.markets.getClobMarket(conditionId);
      const yes = market.tokens.find((t) => t.outcome === 'Yes');
      const no = market.tokens.find((t) => t.outcome === 'No');
      if (yes?.tokenId && no?.tokenId) {
        map[conditionId] = { yesTokenId: yes.tokenId, noTokenId: no.tokenId };
        saveTokenMap(filepath, map);
      }
    } catch {
      // Ignore and keep going; caller can decide whether missing tokens are acceptable.
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return map;
}


