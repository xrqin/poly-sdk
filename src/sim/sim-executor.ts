/**
 * SimExecutor - Simulated trade execution.
 *
 * Calculates simulated fill prices based on orderbook prices,
 * slippage assumptions, and fees. Does NOT execute real trades.
 */

// ===== Types =====

export interface SimConfig {
  slippage: number;      // Fixed slippage per leg (e.g., 0.002 = 0.2%)
  takerFee: number;      // Taker fee per leg (e.g., 0.002 = 0.2%)
  minProfit: number;     // Minimum profit threshold to trigger (e.g., 0.008 = 0.8%)
}

export interface SimFill {
  side: 'BUY' | 'SELL';
  price: number;         // Simulated fill price (after slippage)
  size: number;          // Size in shares
  cost: number;          // Total cost (price * size)
  fee: number;           // Fee amount
  netCost: number;       // Net cost including fee
}

export interface OrderbookPrices {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}

export interface DutchBookSimResult {
  strategy: 'DUTCH_BOOK';
  success: boolean;
  reason?: string;
  yesLeg: SimFill;
  noLeg: SimFill;
  totalCost: number;
  expectedPayout: number;  // Always 1 for Dutch Book
  expectedProfit: number;
  profitPercent: number;
}

export interface ImplicationSimResult {
  strategy: 'IMPLICATION';
  success: boolean;
  reason?: string;
  sellLeg: SimFill;        // Sell A_Yes
  buyLeg: SimFill;         // Buy B_Yes
  netCashFlow: number;     // Positive = received cash
  expectedMinPayout: number;
  expectedProfit: number;
  profitPercent: number;
}

// ===== Default Config =====

export const DEFAULT_SIM_CONFIG: SimConfig = {
  slippage: 0.002,    // 0.2% per leg
  takerFee: 0.002,    // 0.2% per leg
  minProfit: 0.008,   // 0.8% minimum
};

// ===== Core Simulation Functions =====

/**
 * Simulate a buy order.
 * Buy uses Ask price + slippage (you pay more).
 */
export function simulateBuy(
  ask: number,
  sizeUsd: number,
  config: SimConfig
): SimFill {
  // Apply slippage (you pay a bit more than ask)
  const fillPrice = ask * (1 + config.slippage);

  // Calculate shares you get for your USD
  const shares = sizeUsd / fillPrice;

  // Calculate fee on the trade
  const fee = sizeUsd * config.takerFee;

  return {
    side: 'BUY',
    price: fillPrice,
    size: shares,
    cost: sizeUsd,
    fee,
    netCost: sizeUsd + fee,
  };
}

/**
 * Simulate a sell order.
 * Sell uses Bid price - slippage (you receive less).
 */
export function simulateSell(
  bid: number,
  shares: number,
  config: SimConfig
): SimFill {
  // Apply slippage (you receive a bit less than bid)
  const fillPrice = bid * (1 - config.slippage);

  // Calculate USD you receive
  const proceeds = shares * fillPrice;

  // Calculate fee on the trade
  const fee = proceeds * config.takerFee;

  return {
    side: 'SELL',
    price: fillPrice,
    size: shares,
    cost: proceeds,
    fee,
    netCost: proceeds - fee,  // Net received after fee
  };
}

// ===== Strategy Simulations =====

/**
 * Simulate Dutch Book arbitrage (buy Yes + No, merge for $1).
 *
 * @param prices - Current orderbook prices
 * @param sizeUsd - Amount to spend on each leg (total = 2x)
 * @param config - Simulation config
 */
export function simulateDutchBook(
  prices: OrderbookPrices,
  sizeUsd: number,
  config: SimConfig = DEFAULT_SIM_CONFIG
): DutchBookSimResult {
  // Check if prices are valid
  if (prices.yesAsk <= 0 || prices.noAsk <= 0) {
    return {
      strategy: 'DUTCH_BOOK',
      success: false,
      reason: 'Invalid prices (ask <= 0)',
      yesLeg: simulateBuy(prices.yesAsk || 0.5, sizeUsd, config),
      noLeg: simulateBuy(prices.noAsk || 0.5, sizeUsd, config),
      totalCost: sizeUsd * 2,
      expectedPayout: 1,
      expectedProfit: 0,
      profitPercent: 0,
    };
  }

  // For Dutch Book, we need to buy equal SHARES of Yes and No
  // So we can merge them 1:1 to get $1 per pair
  //
  // Strategy: spend sizeUsd total, split proportionally to get equal shares
  const totalAsk = prices.yesAsk + prices.noAsk;
  const yesRatio = prices.yesAsk / totalAsk;
  const noRatio = prices.noAsk / totalAsk;

  // Allocate USD to each leg proportionally
  const yesUsd = sizeUsd * yesRatio;
  const noUsd = sizeUsd * noRatio;

  // Actually, for merge we need EQUAL shares. Let's recalculate.
  // If we want N pairs, we need N Yes shares + N No shares.
  // Cost = N * (yesAsk + noAsk) + fees + slippage
  //
  // For sizeUsd budget:
  const effectiveYesAsk = prices.yesAsk * (1 + config.slippage);
  const effectiveNoAsk = prices.noAsk * (1 + config.slippage);
  const costPerPair = effectiveYesAsk + effectiveNoAsk;
  const pairs = sizeUsd / costPerPair;

  // Simulate legs
  const yesLeg = simulateBuy(prices.yesAsk, pairs * effectiveYesAsk, config);
  const noLeg = simulateBuy(prices.noAsk, pairs * effectiveNoAsk, config);

  // Total cost including fees
  const totalCost = yesLeg.netCost + noLeg.netCost;

  // Payout from merging pairs
  const expectedPayout = pairs;

  // Profit
  const expectedProfit = expectedPayout - totalCost;
  const profitPercent = (expectedProfit / totalCost) * 100;

  // Check if profitable
  const success = expectedProfit > config.minProfit * totalCost;

  return {
    strategy: 'DUTCH_BOOK',
    success,
    reason: success ? undefined : `Profit ${profitPercent.toFixed(2)}% below threshold`,
    yesLeg,
    noLeg,
    totalCost,
    expectedPayout,
    expectedProfit,
    profitPercent,
  };
}

/**
 * Simulate Implication arbitrage (A ⇒ B: sell A_Yes, buy B_Yes).
 *
 * @param pricesA - Orderbook prices for market A
 * @param pricesB - Orderbook prices for market B
 * @param shares - Number of shares to trade
 * @param config - Simulation config
 */
export function simulateImplication(
  pricesA: OrderbookPrices,
  pricesB: OrderbookPrices,
  shares: number,
  config: SimConfig = DEFAULT_SIM_CONFIG
): ImplicationSimResult {
  // Sell A_Yes (receive bid)
  const sellLeg = simulateSell(pricesA.yesBid, shares, config);

  // Buy B_Yes (pay ask)
  const buyLeg = simulateBuy(pricesB.yesAsk, sellLeg.netCost, config);

  // Net cash flow: what we received from selling - what we paid for buying
  // For implication, we often split first, so there's an upfront cost
  // Simplified: net cash = sell proceeds - buy cost
  const netCashFlow = sellLeg.netCost - buyLeg.netCost;

  // Expected minimum payout (worst case for A ⇒ B):
  // If A=No, B=No: A_No pays, B_Yes=0
  // If A=No, B=Yes: A_No pays, B_Yes pays (bonus)
  // If A=Yes, B=Yes: A_Yes=0 (we sold), B_Yes pays (hedge)
  //
  // For risk-free: we need bid_A > ask_B
  // Min payout = min(shares, buyLeg.size) when both settle same way
  const expectedMinPayout = Math.min(shares, buyLeg.size);

  // Profit = cash flow + value at settlement - what we gave up
  // Simplified: for A ⇒ B, profit ≈ (bid_A - ask_B) * shares - fees
  const expectedProfit = netCashFlow;
  const profitPercent = buyLeg.netCost > 0 ? (expectedProfit / buyLeg.netCost) * 100 : 0;

  // Success check
  const success = expectedProfit > config.minProfit * buyLeg.netCost;

  return {
    strategy: 'IMPLICATION',
    success,
    reason: success ? undefined : `Profit ${profitPercent.toFixed(2)}% below threshold`,
    sellLeg,
    buyLeg,
    netCashFlow,
    expectedMinPayout,
    expectedProfit,
    profitPercent,
  };
}

/**
 * Quick check if Dutch Book might be profitable (before full simulation).
 */
export function quickCheckDutchBook(
  prices: OrderbookPrices,
  config: SimConfig = DEFAULT_SIM_CONFIG
): { profitable: boolean; rawProfit: number } {
  const effectiveCost = prices.yesAsk + prices.noAsk;
  const totalSlippage = effectiveCost * config.slippage;
  const totalFee = effectiveCost * config.takerFee;
  const totalCostWithFriction = effectiveCost + totalSlippage + totalFee;

  const rawProfit = 1 - totalCostWithFriction;
  const profitable = rawProfit > config.minProfit;

  return { profitable, rawProfit };
}

/**
 * Quick check if Implication arb might be profitable.
 */
export function quickCheckImplication(
  pricesA: OrderbookPrices,
  pricesB: OrderbookPrices,
  config: SimConfig = DEFAULT_SIM_CONFIG
): { profitable: boolean; rawProfit: number } {
  const effectiveBidA = pricesA.yesBid * (1 - config.slippage) * (1 - config.takerFee);
  const effectiveAskB = pricesB.yesAsk * (1 + config.slippage) * (1 + config.takerFee);

  const rawProfit = effectiveBidA - effectiveAskB;
  const profitable = rawProfit > config.minProfit;

  return { profitable, rawProfit };
}

