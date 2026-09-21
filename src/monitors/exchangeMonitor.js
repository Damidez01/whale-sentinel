const axios = require('axios');
const path = require('path');
const { ExchangeStore, ExchangeEngine, settings } = require('./exchangeCore');
const { EthereumExchangeFeed, TronExchangeFeed } = require('./exchangeFeeds');
const { FreshDeposits } = require('./exchangeFresh');
const wallets = require('./exchange-wallets.json');
const { getPrice } = require('../utils/prices');
const { sendAlert, isBlocked } = require('../alerts/telegram');
const logger = require('../utils/logger');
let ethereum, started = false;

function makeRpc(urls) {
  const providers = [...new Set(urls.filter(Boolean).map(value => value.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace('/ws/v3/', '/v3/')))];
  const cooldown = new Map(), verified = new Set(), failures = new Map();
  function describe(err) {
    const status = Number(err.response?.status);
    const code = Number(err.rpcCode);
    const message = String(err.rpcMessage || err.response?.data?.error?.message || '');
    const detail = /block range|range.*block|10 block|too many results|response size/i.test(message) ? 'log range/result limit' :
      /quota|compute unit|credits|capacity|rate limit|too many requests/i.test(message) ? 'quota/rate limit' :
      /auth|api.key|unauthorized|forbidden/i.test(message) ? 'authentication rejected' :
      /invalid param|invalid request/i.test(message) ? 'request rejected' : 'provider request failed';
    if (status) return `HTTP ${status} (${detail})`;
    if (Number.isFinite(code)) return `RPC ${code} (${detail})`;
    if (err.message === 'Wrong Ethereum chain' || err.message === 'RPC data not yet available' || err.message === 'Invalid RPC response') return err.message;
    return 'connection/timeout failure';
  }
  async function request(url, method, params) {
    let data, httpError;
    try {
      ({ data } = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 }));
    } catch (err) {
      // Alchemy can return JSON-RPC range errors with HTTP 400. Axios throws
      // before the normal JSON-RPC branch, so inspect that body as well.
      if (err.response?.status !== 400 || !err.response?.data?.error) throw err;
      data = err.response.data; httpError = err;
    }
    if (data?.error) {
      // Some plans limit getLogs block ranges. Split only an explicit range/size
      // rejection, never authentication or quota errors. No cursor is committed
      // unless every subrequest succeeds.
      if (method === 'eth_getLogs' && /block range|range.*block|10 block|too many results|response size/i.test(data.error.message || '')) {
        const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
        if (from < to) {
          const middle = Math.floor((from + to) / 2);
          const left = await request(url, method, [{ ...params[0], toBlock: '0x' + middle.toString(16) }]);
          const right = await request(url, method, [{ ...params[0], fromBlock: '0x' + (middle + 1).toString(16) }]);
          if (!Array.isArray(left) || !Array.isArray(right)) throw Error('Invalid RPC response');
          return [...left, ...right];
        }
      }
      const err = httpError || Error('RPC returned an error'); err.rpcCode = data.error.code; err.rpcMessage = data.error.message; throw err;
    }
    if (!data || !Object.hasOwn(data, 'result')) throw Error('Invalid RPC response');
    return data.result;
  }
  return async (method, params) => {
    for (const [index, url] of providers.entries()) {
      if ((cooldown.get(url) || 0) > Date.now()) continue;
      let activeMethod = 'eth_chainId';
      try {
        if (!verified.has(url)) {
          if (await request(url, 'eth_chainId', []) !== '0x1') throw Error('Wrong Ethereum chain');
          verified.add(url);
        }
        activeMethod = method;
        const result = await request(url, method, params);
        if (result === null) throw Error('RPC data not yet available');
        failures.delete(url);
        return result;
      } catch (err) {
        failures.set(url, `provider ${index + 1} ${activeMethod}: ${describe(err)}`);
        cooldown.set(url, Date.now() + 120000);
      }
    }
    throw Error(`Exchange Ethereum RPC unavailable; ${[...failures.values()].join('; ') || 'no providers configured'}`);
  };
}
function observeEthereumBlock(block) { ethereum?.observe(block); }
function startExchangeMonitor() {
  if (started || process.env.EXCHANGE_WATCH_ENABLED === 'false') return [];
  started = true;
  const rules = settings();
  const store = new ExchangeStore(path.join(process.env.TELEGRAM_DATA_DIR || '/data', 'exchange-watch.json'));
  const engine = new ExchangeEngine(store, wallets, rules, { isBlocked, ignoreDestination: (chain,address) =>
    isBlocked(address) || (chain === 'ETH' && require('./evm').isNoisyDestination(address)) });
  const feeds = [], modules = [];
  const price = symbol => getPrice(symbol, { maxAgeMs: 15 * 60000 });
  if (process.env.ALCHEMY_ETH_WSS && !process.env.ALCHEMY_ETH_WSS.includes('YOUR_KEY')) {
    const rpc = makeRpc([process.env.ALCHEMY_ETH_WSS, process.env.ALCHEMY_ETH_FALLBACK]);
    // Separate cooldowns keep a history-provider failure from disabling log scans.
    const freshRpc = makeRpc([process.env.ALCHEMY_ETH_WSS, process.env.ALCHEMY_ETH_FALLBACK]);
    const fresh = new FreshDeposits({ engine, rules, rpc: freshRpc });
    ethereum = new EthereumExchangeFeed({ engine, rules, price, rpc, filterEvents: events => fresh.filter(events) });
    feeds.push(['ETH', ethereum]); modules.push('Exchange watch — 3 ETH wallets (ETH/USDC/USDT/DAI)');
  }
  if (process.env.TRONGRID_API_KEY) {
    let nextRequestAt = 0;
    const request = async (route, params) => {
        const wait = nextRequestAt - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        nextRequestAt = Date.now() + 500;
        const { data } = await axios.get('https://api.trongrid.io' + route, {
          params, headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }, timeout: 15000,
        });
        return data;
      };
    const fresh = new FreshDeposits({ engine, rules, request });
    const tron = new TronExchangeFeed({ engine, rules, price, request, filterEvents: events => fresh.filter(events) });
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
  logger.info(`[Exchange] Started: accumulation >=${rules.min} x ${rules.count}/${rules.minutes}min; fan-out ${rules.fanoutEnabled ? 'enabled' : 'disabled'}; polling ${rules.pollMs / 1000}s`);
  return modules;
}
module.exports = { startExchangeMonitor, observeEthereumBlock, makeRpc };
