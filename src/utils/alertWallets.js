const { normalizeWallet } = require('./addresses');

// Exchange summaries depend on every counted wallet, not only the highlighted
// one. Include legacy queued summaries that predate structured participants.
function alertWallets(alert) {
  const addresses = [alert.wallet, ...(alert.countedWallets || [])];
  if (alert.alertId?.startsWith('exchange:')) {
    addresses.push(...(alert.body || '').match(/0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33}/g) || []);
  }
  return [...new Set(addresses.map(normalizeWallet).filter(Boolean))];
}
module.exports = { alertWallets };
