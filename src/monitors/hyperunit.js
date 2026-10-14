const axios = require('axios');
const path = require('path');
const { ExchangeStore } = require('./exchangeCore');
const { UnitMonitor, unitSettings } = require('./hyperunitCore');
const { matchTornadoUnit } = require('./tornadoUnit');
const { sendAlert, isBlocked } = require('../alerts/telegram');
const logger = require('../utils/logger');
let started = false;
function startHyperunitMonitor() {
  if (started || process.env.HYPERUNIT_ENABLED === 'false') return false;
  const rules = unitSettings();
  const lookbackHours = Number(process.env.TC_HYPERUNIT_LOOKBACK_HOURS || 24);
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) throw Error('Invalid TC_HYPERUNIT_LOOKBACK_HOURS');
  const rpcUrl = (process.env.ALCHEMY_ETH_WSS || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace('/ws/v3/', '/v3/');
  const tornadoEnabled = process.env.TC_HYPERUNIT_ENABLED !== 'false' && rpcUrl && process.env.ETHERSCAN_API_KEY;
  if (process.env.TC_HYPERUNIT_ENABLED !== 'false' && !tornadoEnabled)
    logger.warn('[UNIT] Tornado correlation unavailable: configure ALCHEMY_ETH_WSS and ETHERSCAN_API_KEY');
  const monitor = new UnitMonitor({
    store: new ExchangeStore(path.join(process.env.TELEGRAM_DATA_DIR || '/data', 'hyperunit-state.json')),
    rules, sendAlert, isBlocked,
    tornadoMatch: tornadoEnabled ? e => matchTornadoUnit(e, {
      lookbackHours,
      rpc: async (method, params) => {
        const { data } = await axios.post(rpcUrl, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 });
        if (data.error || data.result === undefined) throw Error('Ethereum verification unavailable');
        return data.result;
      },
      history: async params => (await axios.get('https://api.etherscan.io/v2/api', {
        params: { ...params, chainid: 1, apikey: process.env.ETHERSCAN_API_KEY }, timeout: 15000,
      })).data,
    }) : undefined,
    ledger: async (user, startTime, endTime) => (await axios.post('https://api.hyperliquid.xyz/info',
      { type: 'userNonFundingLedgerUpdates', user, startTime, endTime }, { timeout: 15000 })).data,
    operations: async wallet => (await axios.get(`https://api.hyperunit.xyz/operations/${wallet}`, { timeout: 15000 })).data,
    fills: async user => (await axios.post('https://api.hyperliquid.xyz/info',
      { type: 'userFills', user, aggregateByTime: true }, { timeout: 15000 })).data,
  });
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      await monitor.poll();
      const s = monitor.lastScan;
      if (s.lookupErrors || s.historyErrors || s.tornadoErrors || s.oldestPendingMinutes >= 15 || s.pending >= 2000)
        logger.warn('[UNIT] Deposit verification delayed; pending receipts retained', s);
      else logger.info('[UNIT] Scan succeeded', s);
    } catch (err) {
      logger.warn(`[UNIT] ${err.isAxiosError ? `Provider request failed${err.response?.status ? ' (HTTP '+err.response.status+')' : ''}` : err.message}; saved progress retained`);
    } finally { busy = false; }
  };
  started = true; poll(); setInterval(poll, rules.pollMs);
  logger.info(`[UNIT] BTC/ETH deposits to Hyperliquid; single $${rules.single}; accumulation ${rules.count}+ deposits totaling $${rules.total} in ${rules.minutes}min`);
  return true;
}
module.exports = { startHyperunitMonitor };
