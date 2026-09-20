const wallets = require('./exchange-wallets.json');
const { normalizeWallet } = require('../utils/addresses');
function isExchangeWallet(address, chain) {
  if (process.env.EXCHANGE_WATCH_ENABLED === 'false') return false;
  const normalized = normalizeWallet(address);
  return !!normalized && wallets.some(w => w.chain === chain && normalizeWallet(w.address) === normalized);
}
module.exports = { isExchangeWallet };
