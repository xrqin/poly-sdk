/**
 * Simple Polymarket Monitor
 *
 * A terminal UI that displays real-time market data:
 * - UP / DOWN prices
 * - Combined (sum of prices)
 * - Spread (deviation from 1)
 * - Recent trades
 *
 * Usage:
 *   npx tsx scripts/monitor/simple-monitor.ts --market="russia-x-ukraine-ceasefire-by-january-31-2026"
 *   npx tsx scripts/monitor/simple-monitor.ts --market="0x..." (condition ID)
 */

import { PolymarketSDK, RealtimeServiceV2 } from '../../src/index.js';
import type { OrderbookSnapshot, LastTradeInfo, ActivityTrade } from '../../src/index.js';

// ============================================================================
// ANSI Colors
// ============================================================================
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const BG_BLACK = '\x1b[40m';

// Box drawing characters
const BOX = {
  TL: '╔', TR: '╗', BL: '╚', BR: '╝',
  H: '═', V: '║',
  LT: '╠', RT: '╣', HB: '╦', HT: '╩',
};

// ============================================================================
// Types
// ============================================================================
interface MonitorState {
  marketQuestion: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  upPrice: number;
  downPrice: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  combined: number;
  spread: number;
  recentTrades: TradeRecord[];
  lastUpdate: Date;
  connected: boolean;
}

interface TradeRecord {
  time: string;
  side: 'UP' | 'DOWN';
  price: number;
  size: number;
  tradeSide: 'BUY' | 'SELL';
  txHash?: string;
}

// ============================================================================
// Monitor State
// ============================================================================
const state: MonitorState = {
  marketQuestion: 'Loading...',
  conditionId: '',
  upTokenId: '',
  downTokenId: '',
  upPrice: 0,
  downPrice: 0,
  upBid: 0,
  upAsk: 0,
  downBid: 0,
  downAsk: 0,
  combined: 0,
  spread: 0,
  recentTrades: [],
  lastUpdate: new Date(),
  connected: false,
};

const MAX_TRADES = 10;

// Track seen transaction hashes to avoid duplicates
const seenTxHashes = new Set<string>();

// ============================================================================
// Rendering
// ============================================================================
function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  return str + ' '.repeat(Math.max(0, len - visibleLen));
}

function padLeft(str: string, len: number): string {
  const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  return ' '.repeat(Math.max(0, len - visibleLen)) + str;
}

function formatPrice(price: number): string {
  return `$${price.toFixed(4)}`;
}

function formatSpread(spread: number): string {
  const pct = ((spread - 1) * 100).toFixed(2);
  const sign = spread >= 1 ? '+' : '';
  const color = spread < 1 ? GREEN : spread > 1 ? RED : YELLOW;
  return `${color}${sign}${pct}%${RESET}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function render(): void {
  const WIDTH = 90;

  // Clear screen and move cursor to top
  process.stdout.write('\x1b[2J\x1b[H');

  const lines: string[] = [];

  // Header
  lines.push(`${CYAN}${BOX.TL}${BOX.H.repeat(WIDTH - 2)}${BOX.TR}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${BOLD}${WHITE}Polymarket Monitor${RESET}${DIM} - ${state.marketQuestion.slice(0, 55)}...${RESET}${' '.repeat(Math.max(0, WIDTH - 80))}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${DIM}Status: ${state.connected ? `${GREEN}Connected${RESET}` : `${RED}Disconnected${RESET}`}  |  Last: ${formatTime(state.lastUpdate)}${RESET}${' '.repeat(WIDTH - 50)}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.LT}${BOX.H.repeat(WIDTH - 2)}${BOX.RT}${RESET}`);

  // Market Analysis Section
  lines.push(`${CYAN}${BOX.V}${RESET}  ${BOLD}${YELLOW}== MARKET ANALYSIS ==${RESET}${' '.repeat(WIDTH - 27)}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}${' '.repeat(WIDTH - 2)}${CYAN}${BOX.V}${RESET}`);

  // Prices
  const upPriceStr = `${GREEN}UP Price:${RESET}   ${formatPrice(state.upPrice)}`;
  const downPriceStr = `${RED}DOWN Price:${RESET} ${formatPrice(state.downPrice)}`;
  const combinedStr = `Combined: ${BOLD}${formatPrice(state.combined)}${RESET}`;
  const spreadStr = `Spread: ${formatSpread(state.spread)}`;

  lines.push(`${CYAN}${BOX.V}${RESET}  ${padRight(upPriceStr, 28)} ${DIM}|${RESET}  ${padRight(combinedStr, 28)} ${DIM}|${RESET}  ${padRight(spreadStr, 20)}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${padRight(downPriceStr, 28)} ${DIM}|${RESET}${' '.repeat(52)}${CYAN}${BOX.V}${RESET}`);

  // Bid/Ask details
  lines.push(`${CYAN}${BOX.V}${RESET}${' '.repeat(WIDTH - 2)}${CYAN}${BOX.V}${RESET}`);
  const upBidAsk = `${DIM}UP Bid/Ask:${RESET}   ${formatPrice(state.upBid)} / ${formatPrice(state.upAsk)}`;
  const downBidAsk = `${DIM}DOWN Bid/Ask:${RESET} ${formatPrice(state.downBid)} / ${formatPrice(state.downAsk)}`;
  lines.push(`${CYAN}${BOX.V}${RESET}  ${padRight(upBidAsk, 40)} ${DIM}|${RESET}  ${padRight(downBidAsk, 42)}${CYAN}${BOX.V}${RESET}`);

  // Trades Section
  lines.push(`${CYAN}${BOX.LT}${BOX.H.repeat(WIDTH - 2)}${BOX.RT}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${BOLD}${MAGENTA}== RECENT TRANSACTIONS ==${RESET}${' '.repeat(WIDTH - 30)}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${DIM}TIME         SIDE      PRICE       SIZE    ACTION    TX HASH${RESET}${' '.repeat(WIDTH - 65)}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${DIM}${'-'.repeat(WIDTH - 6)}${RESET}${CYAN}${BOX.V}${RESET}`);

  // Trade rows
  const tradesToShow = state.recentTrades.slice(0, MAX_TRADES);
  for (const trade of tradesToShow) {
    const sideColor = trade.side === 'UP' ? GREEN : RED;
    const actionColor = trade.tradeSide === 'BUY' ? GREEN : RED;
    const sideStr = `${sideColor}${trade.side === 'UP' ? '▲ UP  ' : '▼ DOWN'}${RESET}`;
    const priceStr = formatPrice(trade.price);
    const sizeStr = `$${trade.size.toFixed(0)}`;
    const actionStr = `${actionColor}${trade.tradeSide}${RESET}`;
    const txHashStr = trade.txHash ? `${DIM}${trade.txHash.slice(0, 18)}..${RESET}` : `${DIM}--${RESET}`;

    const row = `${trade.time}  ${sideStr}  ${padLeft(priceStr, 9)}  ${padLeft(sizeStr, 7)}  ${padRight(actionStr, 8)} ${txHashStr}`;
    lines.push(`${CYAN}${BOX.V}${RESET}  ${padRight(row, WIDTH - 6)}${CYAN}${BOX.V}${RESET}`);
  }

  // Fill empty trade rows
  for (let i = tradesToShow.length; i < MAX_TRADES; i++) {
    lines.push(`${CYAN}${BOX.V}${RESET}${' '.repeat(WIDTH - 2)}${CYAN}${BOX.V}${RESET}`);
  }

  // Footer
  lines.push(`${CYAN}${BOX.LT}${BOX.H.repeat(WIDTH - 2)}${BOX.RT}${RESET}`);
  lines.push(`${CYAN}${BOX.V}${RESET}  ${DIM}Trades: ${state.recentTrades.length}  |  Press Ctrl+C to exit${RESET}${' '.repeat(WIDTH - 44)}${CYAN}${BOX.V}${RESET}`);
  lines.push(`${CYAN}${BOX.BL}${BOX.H.repeat(WIDTH - 2)}${BOX.BR}${RESET}`);

  console.log(lines.join('\n'));
}

// ============================================================================
// Data Handlers
// ============================================================================
function handleOrderbook(book: OrderbookSnapshot): void {
  const isUp = book.assetId === state.upTokenId;
  const bestBid = book.bids[0]?.price || 0;
  const bestAsk = book.asks[0]?.price || 1;
  const midPrice = (bestBid + bestAsk) / 2;

  if (isUp) {
    state.upPrice = midPrice;
    state.upBid = bestBid;
    state.upAsk = bestAsk;
  } else {
    state.downPrice = midPrice;
    state.downBid = bestBid;
    state.downAsk = bestAsk;
  }

  state.combined = state.upPrice + state.downPrice;
  state.spread = state.combined;
  state.lastUpdate = new Date();
}

function handleLastTrade(trade: LastTradeInfo): void {
  // Only use this for price updates, not for trade list
  // (Trade list comes from subscribeActivity which has txHash for deduplication)
  const isUp = trade.assetId === state.upTokenId;

  // Update price info
  if (isUp) {
    state.upPrice = trade.price;
  } else {
    state.downPrice = trade.price;
  }
  state.combined = state.upPrice + state.downPrice;
  state.spread = state.combined;
  state.lastUpdate = new Date();
}

function handleActivityTrade(trade: ActivityTrade): void {
  // Deduplicate by transaction hash
  if (trade.transactionHash && seenTxHashes.has(trade.transactionHash)) {
    return; // Already seen this trade
  }

  const isUp = trade.asset === state.upTokenId;

  const record: TradeRecord = {
    time: formatTime(new Date(trade.timestamp * 1000)),
    side: isUp ? 'UP' : 'DOWN',
    price: trade.price,
    size: trade.size * trade.price,
    tradeSide: trade.side,
    txHash: trade.transactionHash,
  };

  // Mark as seen
  if (trade.transactionHash) {
    seenTxHashes.add(trade.transactionHash);
    // Keep set size bounded
    if (seenTxHashes.size > 1000) {
      const firstKey = seenTxHashes.values().next().value;
      if (firstKey) seenTxHashes.delete(firstKey);
    }
  }

  state.recentTrades.unshift(record);
  if (state.recentTrades.length > MAX_TRADES * 2) {
    state.recentTrades = state.recentTrades.slice(0, MAX_TRADES * 2);
  }

  state.lastUpdate = new Date();
}

// ============================================================================
// Main
// ============================================================================
function parseArgs(): { market: string } {
  const marketArg = process.argv.find(a => a.startsWith('--market='));
  if (!marketArg) {
    console.error('Usage: npx tsx scripts/monitor/simple-monitor.ts --market="<slug-or-conditionId>"');
    process.exit(1);
  }
  return { market: marketArg.split('=')[1].replace(/"/g, '') };
}

async function main() {
  const { market } = parseArgs();

  console.log('Initializing Polymarket Monitor...\n');

  // 1. Initialize SDK
  const sdk = new PolymarketSDK();

  // 2. Get market info
  console.log(`Fetching market: ${market}`);
  const unifiedMarket = await sdk.markets.getMarket(market);

  state.marketQuestion = unifiedMarket.question;
  state.conditionId = unifiedMarket.conditionId;

  // Find YES/NO tokens (treating YES as UP, NO as DOWN for binary markets)
  const yesToken = unifiedMarket.tokens.find(t => t.outcome === 'Yes');
  const noToken = unifiedMarket.tokens.find(t => t.outcome === 'No');

  if (!yesToken?.tokenId || !noToken?.tokenId) {
    console.error('This market does not have valid YES/NO tokens');
    process.exit(1);
  }

  state.upTokenId = yesToken.tokenId;
  state.downTokenId = noToken.tokenId;
  state.upPrice = yesToken.price;
  state.downPrice = noToken.price;
  state.combined = state.upPrice + state.downPrice;
  state.spread = state.combined;

  console.log(`Market: ${unifiedMarket.question}`);
  console.log(`Condition ID: ${unifiedMarket.conditionId}`);
  console.log(`YES Token: ${state.upTokenId.slice(0, 20)}...`);
  console.log(`NO Token: ${state.downTokenId.slice(0, 20)}...`);

  // 3. Get initial orderbook
  console.log('\nFetching initial orderbook...');
  try {
    const orderbook = await sdk.markets.getProcessedOrderbook(unifiedMarket.conditionId);
    state.upPrice = (orderbook.yes.bid + orderbook.yes.ask) / 2;
    state.downPrice = (orderbook.no.bid + orderbook.no.ask) / 2;
    state.upBid = orderbook.yes.bid;
    state.upAsk = orderbook.yes.ask;
    state.downBid = orderbook.no.bid;
    state.downAsk = orderbook.no.ask;
    state.combined = state.upPrice + state.downPrice;
    state.spread = state.combined;
  } catch (e) {
    console.log('Could not fetch initial orderbook, will use WebSocket data');
  }

  // 4. Connect to WebSocket
  console.log('\nConnecting to WebSocket...');
  const realtime = new RealtimeServiceV2({ debug: false });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);

    realtime.once('connected', () => {
      clearTimeout(timeout);
      state.connected = true;
      console.log('Connected to WebSocket');
      resolve();
    });

    realtime.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    realtime.connect();
  });

  // 5. Subscribe to market data
  console.log('Subscribing to market updates...');
  const marketSub = realtime.subscribeMarket(state.upTokenId, state.downTokenId, {
    onOrderbook: handleOrderbook,
    onLastTrade: handleLastTrade,
    onError: (err) => console.error('Market subscription error:', err),
  });

  // 6. Subscribe to activity trades for this market
  const activitySub = realtime.subscribeActivity(
    {}, // No filter - we'll filter by conditionId in the handler
    {
      onTrade: (trade) => {
        // Filter for our market
        if (trade.conditionId === state.conditionId) {
          handleActivityTrade(trade);
        }
      },
      onError: (err) => console.error('Activity subscription error:', err),
    }
  );

  console.log(`Subscribed to market: ${marketSub.id}`);
  console.log(`Subscribed to activity: ${activitySub.id}`);

  // 7. Handle disconnection
  realtime.on('disconnected', () => {
    state.connected = false;
  });

  realtime.on('connected', () => {
    state.connected = true;
  });

  // 8. Start rendering loop
  console.log('\nStarting monitor... (Ctrl+C to exit)\n');
  await new Promise(r => setTimeout(r, 1000));

  const renderInterval = setInterval(() => {
    render();
  }, 500);

  // 9. Handle exit
  process.on('SIGINT', () => {
    clearInterval(renderInterval);
    console.log('\n\nShutting down...');
    marketSub.unsubscribe();
    activitySub.unsubscribe();
    realtime.disconnect();
    console.log('Disconnected. Goodbye!');
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

