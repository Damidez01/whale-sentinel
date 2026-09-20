const axios = require('axios');
const logger = require('./logger');

const cache  = new Map();
const TTL_MS = 60_000; // 60 second cache
const pending = new Map();
const retryAt = new Map();

const SYMBOL_TO_ID = {
  ETH:  'ethereum',
  TRX:  'tron',
  BTC:  'bitcoin',
  WBTC: 'wrapped-bitcoin',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI:  'dai',
  RUNE: 'thorchain',
  WETH: 'weth',
};

function validPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function refresh(symbol, id) {
  const sources = [
    ['CoinGecko', `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, data => data?.[id]?.usd],
    ['Coinbase', `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`, data =>
      data?.data?.currency === 'USD' && (!data.data.base || data.data.base === symbol) ? Number(data.data.amount) : null],
  ];
  for (const [source, url, parse] of sources) {
    const key = `${source}:${id}`;
    if ((retryAt.get(key) || 0) > Date.now()) continue;
    try {
      const { data } = await axios.get(url, { timeout: 6000 });
      const price = parse(data);
      if (!validPrice(price)) throw Error('Invalid price response');
      cache.set(id, { price, ts: Date.now() });
      retryAt.delete(key);
      return;
    } catch (err) {
      const retry = err.response?.headers?.['retry-after'];
      const delay = retry == null ? 0 : (/^\d+(\.\d+)?$/.test(String(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now());
      retryAt.set(key, Date.now() + Math.max(TTL_MS, Number.isFinite(delay) ? delay : 0));
      // Never log raw provider errors: they may include URLs or credentials.
      const reason = err.response?.status ? `HTTP ${err.response.status}` : err.isAxiosError ? 'connection/timeout failure' : 'invalid price response';
      logger.warn(`[Prices] ${source} ${symbol}: ${reason}; trying backup or recent cached quote`);
    }
  }
}

async function getPrice(symbol, { maxAgeMs = Infinity } = {}) {
  symbol = symbol?.toUpperCase();
  const id = SYMBOL_TO_ID[symbol];
  if (!id) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.ts < Math.min(TTL_MS, maxAgeMs)) return hit.price;
  if (!pending.has(id)) {
    pending.set(id, refresh(symbol, id).finally(() => pending.delete(id)));
  }
  await pending.get(id);
  const latest = cache.get(id);
  return latest && Date.now() - latest.ts <= maxAgeMs ? latest.price : null;
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
