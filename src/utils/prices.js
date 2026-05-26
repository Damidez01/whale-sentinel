const axios = require('axios');

const cache  = new Map();
const TTL_MS = 60_000; // 60 second cache

const SYMBOL_TO_ID = {
  ETH:  'ethereum',
  BTC:  'bitcoin',
  WBTC: 'wrapped-bitcoin',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI:  'dai',
  RUNE: 'thorchain',
  WETH: 'weth',
};

async function getPrice(symbol) {
  const id = SYMBOL_TO_ID[symbol?.toUpperCase()];
  if (!id) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.price;

  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { timeout: 6000 }
    );
    const price = data[id]?.usd ?? null;
    if (price) cache.set(id, { price, ts: Date.now() });
    return price;
  } catch {
    return hit?.price ?? null; // return stale if available
  }
}

/** Convert raw token amount to USD */
async function toUSD(rawAmount, symbol = 'ETH', decimals = 18) {
  const price = await getPrice(symbol);
  if (!price) return null;
  const amount = Number(BigInt(rawAmount)) / Math.pow(10, decimals);
  return amount * price;
}

/** Format USD for display */
function fmtUSD(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** Format ETH amount */
function fmtETH(wei, decimals = 18) {
  return (Number(BigInt(wei)) / Math.pow(10, decimals)).toFixed(2);
}

/** Get price by symbol (for tokens module) */
async function getTokenPrice(symbol) {
  return getPrice(symbol);
}

module.exports = { getPrice, toUSD, fmtUSD, fmtETH, getTokenPrice };
