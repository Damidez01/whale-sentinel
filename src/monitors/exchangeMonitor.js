const axios = require('axios');
const path = require('path');
const { ExchangeStore, ExchangeEngine, settings } = require('./exchangeCore');
const { EthereumExchangeFeed, TronExchangeFeed } = require('./exchangeFeeds');
const wallets = require('./exchange-wallets.json');
const { getPrice } = require('../utils/prices');
const { sendAlert, isBlocked } = require('../alerts/telegram');
const logger = require('../utils/logger');
let ethereum, started = false;

function makeRpc(urls) {
  const providers = [...new Set(urls.filter(Boolean).map(value => value.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace('/ws/v3/', '/v3/')))];
  const cooldown = new Map(), verified = new Set();
  async function request(url, method, params) {
    const { data } = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 });
    if (data?.error || !data || !Object.hasOwn(data, 'result')) throw Error('RPC returned an error');
    return data.result;
  }
  return async (method, params) => {
    for (const url of providers) {
      if ((cooldown.get(url) || 0) > Date.now()) continue;
      try {
        if (!verified.has(url)) {
          if (await request(url, 'eth_chainId', []) !== '0x1') throw Error('Wrong Ethereum chain');
          verified.add(url);
        }
        const result = await request(url, method, params);
        if (result === null) throw Error('RPC data not yet available');
        return result;
      } catch { cooldown.set(url, Date.now() + 120000); }
    }
    throw Error('Exchange Ethereum RPC unavailable; check primary/fallback or provider quota');
  };
}
function observeEthereumBlock(block) { ethereum?.observe(block); }
function startExchangeMonitor() {
  if (started || process.env.EXCHANGE_WATCH_ENABLED === 'false') return [];
  started = true;
  const rules = settings();
  const store = new ExchangeStore(path.join(process.env.TELEGRAM_DATA_DIR || '/data', 'exchange-watch.json'));
  const engine = new ExchangeEngine(store, wallets, rules, { ignoreDestination: (chain,address) =>
    isBlocked(address) || (chain === 'ETH' && require('./evm').isNoisyDestination(address)) });
  const feeds = [], modules = [];
  const price = symbol => getPrice(symbol, { maxAgeMs: 15 * 60000 });
  if (process.env.ALCHEMY_ETH_WSS && !process.env.ALCHEMY_ETH_WSS.includes('YOUR_KEY')) {
    ethereum = new EthereumExchangeFeed({ engine, rules, price,
      rpc: makeRpc([process.env.ALCHEMY_ETH_WSS, process.env.ALCHEMY_ETH_FALLBACK]) });
    feeds.push(['ETH', ethereum]); modules.push('Exchange watch — 3 ETH wallets (ETH/USDC/USDT/DAI)');
  }
  if (process.env.TRONGRID_API_KEY) {
    let nextRequestAt = 0;
    const tron = new TronExchangeFeed({ engine, rules, price,
      request: async (route, params) => {
        const wait = nextRequestAt - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        nextRequestAt = Date.now() + 500;
        const { data } = await axios.get('https://api.trongrid.io' + route, {
          params, headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }, timeout: 15000,
        });
        return data;
      } });
    feeds.push(['TRON', tron]); modules.push('Exchange watch — 2 TRON wallets (USDT/TRX)');
  } else logger.warn('[Exchange:TRON] Disabled until TRONGRID_API_KEY is configured');
  let busy = false;
  const retryAt = new Map();
  async function poll() {
    if (busy) return; busy = true;
    try {
      engine.flush(sendAlert);
      for (const [chain,feed] of feeds) {
        if ((retryAt.get(chain) || 0) > Date.now()) continue;
        try {
          await feed.poll();
          engine.flush(sendAlert);
          const health = store.data.health[chain];
          if (health?.ok) logger.info(`[Exchange:${chain}] Scan succeeded`, { block: health.block, through: health.through, lagBlocks: health.lagBlocks });
        } catch (err) {
          // Do not expose request headers, keys, or provider URLs in logs/state.
          const reason = err.isAxiosError ? `HTTP ${err.response?.status || 'connection failure'}` : err.message;
          const retry = err.response?.headers?.['retry-after'];
          const delay = Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          if (delay > 0) retryAt.set(chain, Date.now() + delay);
          store.update(s => { s.health[chain] = { ok: false, error: reason, checkedAt: Date.now() }; });
          logger.warn(`[Exchange:${chain}] ${reason}; saved progress retained`);
        }
      }
    } finally { busy = false; }
  }
  const run = () => poll().catch(() => logger.error('[Exchange] Unable to persist monitoring state'));
  run(); setInterval(run, rules.pollMs);
  logger.info(`[Exchange] Started: accumulation >=${rules.min} x ${rules.count}/${rules.minutes}min; fan-out >=${rules.fanoutMin} x ${rules.fanoutCount} destinations/${rules.fanoutMinutes}min; polling ${rules.pollMs / 1000}s`);
  return modules;
}
module.exports = { startExchangeMonitor, observeEthereumBlock, makeRpc };
