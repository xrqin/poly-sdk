/**
 * Find binary (two-outcome) markets via the Gamma API.
 *
 * Usage:
 *   tsx scripts/research/find-binary-markets.ts
 *   tsx scripts/research/find-binary-markets.ts --limit=200 --top=30
 */

import { PolymarketSDK, isBinaryGammaMarket } from '../../src/index.js';

function parseArgNumber(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const raw = arg.split('=')[1];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const limit = parseArgNumber('limit', 100);
  const top = parseArgNumber('top', 20);

  const sdk = new PolymarketSDK();

  const markets = await sdk.gammaApi.getMarkets({
    active: true,
    closed: false,
    order: 'volume24hr',
    ascending: false,
    limit,
  });

  const binary = markets.filter(isBinaryGammaMarket);

  console.log(`Fetched: ${markets.length}`);
  console.log(`Binary (2 outcomes): ${binary.length}`);
  console.log('');

  for (const m of binary.slice(0, top)) {
    const vol = m.volume24hr ?? 0;
    console.log(`- ${m.question}`);
    console.log(`  slug: ${m.slug}`);
    console.log(`  conditionId: ${m.conditionId}`);
    console.log(`  outcomes: ${m.outcomes.join(' / ')}`);
    console.log(`  volume24hr: $${Math.round(vol).toLocaleString()}`);
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


