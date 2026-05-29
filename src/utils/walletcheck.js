const axios  = require('axios');
const { setKey, getKey } = require('./store');
const logger = require('./logger');

const FRESH_MAX_TXS      = Number(process.env.FRESH_WALLET_MAX_TXS  || 10);
const HIGH_VOLUME_MIN    = Number(process.env.HIGH_VOLUME_THRESHOLD  || 500);

// Chain config for explorer APIs
const CHAIN_CONFIG = {
  ETH:     { api: 'https://api.etherscan.io/api',   key: () => process.env.ETHERSCAN_API_KEY,   id: null },
  BASE:    { api: 'https://api.blockscout.com/v2/api', key: () => process.env.BLOCKSCOUT_API_KEY, id: 8453 },
  ARB:     { api: 'https://api.blockscout.com/v2/api', key: () => process.env.BLOCKSCOUT_API_KEY, id: 42161 },
  POLYGON: { api: 'https://api.blockscout.com/v2/api', key: () => process.env.BLOCKSCOUT_API_KEY, id: 137 },
};

// ── Fetch tx count from Etherscan ─────────────────────────────
async function fetchEtherscanCount(address, apiKey) {
  const base = 'https://api.etherscan.io/api';
  const [r1, r2, r3] = await Promise.all([
    axios.get(base, { params: { module: 'proxy',   action: 'eth_getTransactionCount', address, tag: 'latest', apikey: apiKey }, timeout: 5000 }),
    axios.get(base, { params: { module: 'account', action: 'txlist',   address, page: 1, offset: 600, sort: 'desc', apikey: apiKey }, timeout: 5000 }),
    axios.get(base, { params: { module: 'account', action: 'tokentx',  address, page: 1, offset: 600, sort: 'desc', apikey: apiKey }, timeout: 5000 }),
  ]);
  const nonce    = parseInt(r1.data?.result, 16) || 0;
  const ethCount = Array.isArray(r2.data?.result) ? r2.data.result.length : 0;
  const tokCount = Array.isArray(r3.data?.result) ? r3.data.result.length : 0;
  return Math.max(nonce, ethCount, tokCount);
}

// ── Fetch tx count from Blockscout PRO ───────────────────────
async function fetchBlockscoutCount(address, chainId, apiKey) {
  const base = 'https://api.blockscout.com/v2/api';
  const [r1, r2] = await Promise.all([
    // Native txns
    axios.get(base, {
      params: { chain_id: chainId, module: 'account', action: 'txlist', address, page: 1, offset: 600, sort: 'desc', apikey: apiKey },
      timeout: 5000,
    }),
    // Token txns
    axios.get(base, {
      params: { chain_id: chainId, module: 'account', action: 'tokentx', address, page: 1, offset: 600, sort: 'desc', apikey: apiKey },
      timeout: 5000,
    }),
  ]);
  const ethCount = Array.isArray(r1.data?.result) ? r1.data.result.length : 0;
  const tokCount = Array.isArray(r2.data?.result) ? r2.data.result.length : 0;
  return Math.max(ethCount, tokCount);
}

// ── Main wallet check ─────────────────────────────────────────
async function getWalletTxCount(address, chain = 'ETH') {
  const cacheKey = `walletage:${chain}:${address.toLowerCase()}`;
  const cached   = getKey(cacheKey);
  if (cached !== null) return Number(cached);

  const config = CHAIN_CONFIG[chain];
  if (!config) return 50; // unknown chain — assume normal

  const apiKey = config.key();
  if (!apiKey) return 50; // no key — assume normal

  try {
    let count;
    if (chain === 'ETH') {
      count = await fetchEtherscanCount(address, apiKey);
    } else {
      count = await fetchBlockscoutCount(address, config.id, apiKey);
    }
    setKey(cacheKey, count.toString(), 86400); // cache 24hrs
    return count;
  } catch (err) {
    logger.error(`[WalletCheck:${chain}] Failed for ${address.slice(0,10)}`, { error: err.message });
    return 50; // assume normal on error
  }
}

// ── Convenience functions ─────────────────────────────────────

async function isFreshWallet(address, chain = 'ETH') {
  const count = await getWalletTxCount(address, chain);
  return count <= FRESH_MAX_TXS;
}

async function isHighVolumeWallet(address, chain = 'ETH') {
  const count = await getWalletTxCount(address, chain);
  return count >= HIGH_VOLUME_MIN;
}

async function getWalletCategory(address, chain = 'ETH') {
  const count = await getWalletTxCount(address, chain);
  if (count <= FRESH_MAX_TXS)  return 'fresh';
  if (count >= HIGH_VOLUME_MIN) return 'high_volume';
  return 'normal';
}

// Pre-check on first encounter — sets suppress cache immediately
// Call this on first tx from any wallet to warm the cache
async function preCheckWallet(address, chain = 'ETH') {
  const firstKey    = `wcfirst:${chain}:${address.toLowerCase()}`;
  const suppressKey = `wcsuppress:${chain}:${address.toLowerCase()}`;

  if (getKey(firstKey)) return getKey(suppressKey) === '1'; // already checked

  setKey(firstKey, '1', 86400);
  const category = await getWalletCategory(address, chain);
  if (category === 'high_volume') {
    setKey(suppressKey, '1', 86400);
    return true; // suppress
  }
  return false; // don't suppress
}

function isSuppressed(address, chain = 'ETH') {
  return getKey(`wcsuppress:${chain}:${address.toLowerCase()}`) === '1';
}

module.exports = {
  getWalletTxCount,
  isFreshWallet,
  isHighVolumeWallet,
  getWalletCategory,
  preCheckWallet,
  isSuppressed,
  FRESH_MAX_TXS,
  HIGH_VOLUME_MIN,
};
