/**
 * Market classification helpers.
 *
 * These utilities are intentionally lightweight and side-effect free.
 * They help users quickly filter binary (two-outcome, mutually exclusive) markets.
 */

import type { GammaMarket } from '../clients/gamma-api.js';
import type { UnifiedMarket } from '../core/types.js';
import type { Market as ClobMarket } from '../services/market-service.js';

/**
 * Returns true if the Gamma market has exactly 2 outcomes.
 *
 * Note: On Polymarket, a single market/condition with 2 outcomes is the common
 * "binary" structure (e.g., Yes/No, Up/Down). Outcome labels may vary.
 */
export function isBinaryGammaMarket(m: GammaMarket): boolean {
  return Array.isArray(m.outcomes) && m.outcomes.length === 2;
}

/**
 * Returns true if the unified market has exactly 2 tokens/outcomes.
 */
export function isBinaryUnifiedMarket(m: UnifiedMarket): boolean {
  return Array.isArray(m.tokens) && m.tokens.length === 2;
}

/**
 * Returns true if the CLOB market has exactly 2 tokens/outcomes.
 */
export function isBinaryClobMarket(m: ClobMarket): boolean {
  return Array.isArray(m.tokens) && m.tokens.length === 2;
}

/**
 * Filter helpers (convenience).
 */
export function filterBinaryGammaMarkets(markets: GammaMarket[]): GammaMarket[] {
  return markets.filter(isBinaryGammaMarket);
}

export function filterBinaryUnifiedMarkets(markets: UnifiedMarket[]): UnifiedMarket[] {
  return markets.filter(isBinaryUnifiedMarket);
}

export function filterBinaryClobMarkets(markets: ClobMarket[]): ClobMarket[] {
  return markets.filter(isBinaryClobMarket);
}


