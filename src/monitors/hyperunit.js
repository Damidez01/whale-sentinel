const axios = require('axios');
const path = require('path');
const { ExchangeStore } = require('./exchangeCore');
const { UnitMonitor, unitSettings } = require('./hyperunitCore');
const { sendAlert, isBlocked } = require('../alerts/telegram');
const logger = require('../utils/logger');
let started = false;
function startHyperunitMonitor() {
  if (started || process.env.HYPERUNIT_ENABLED === 'false') return false;
  const rules = unitSettings();
  const monitor = new UnitMonitor({
    store: new ExchangeStore(path.join(process.env.TELEGRAM_DATA_DIR || '/data', 'hyperunit-state.json')),
    rules, sendAlert, isBlocked,
    ledger: async (user, startTime, endTime) => (await axios.post('https://api.hyperliquid.xyz/info',
      { type: 'userNonFundingLedgerUpdates', user, startTime, endTime }, { timeout: 15000 })).data,
    operations: async wallet => (await axios.get(`https://api.hyperunit.xyz/operations/${wallet}`, { timeout: 15000 })).data,
  });
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      await monitor.poll();
      const s = monitor.lastScan;
      if (s.lookupErrors || s.oldestPendingMinutes >= 15 || s.pending >= 2000)
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
