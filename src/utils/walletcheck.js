/**
 * WalletCheck — pre-enrichment cache
 *
 * Core principle: NO async in alert path.
 * Wallets are classified in background on first sight.
 * Alert engine only reads cache — never waits.
 *
 * States:
 *   null        = never seen before → enrich, skip this event
 *   'unknown'   = enrichment in progress → skip
 *   'fresh'     = < FRESH_MAX_TXS lifetime txns → alert eligible
 *   'normal'    = 10-499 txns → skip
 *   'high'      = >= HIGH_VOLUME_MIN txns → skip
 */

const axios  = require('axios');
const { setKey, getKey } = require('./store');
const logger = require('./logger');

const FRESH_MAX_TXS   = Number(process.env.FRESH_WALLET_MAX_TXS || 10);
const HIGH_VOLUME_MIN = Number(process.env.HIGH_VOLUME_THRESHOLD || 500);
const CACHE_TTL       = 86400; // 24hrs

// Special addresses that should never alert
const ALWAYS_SKIP = new Set([
  '0x0000000000000000000000000000000000000000', // null address
  '0x000000000000000000000000000000000000dead', // dead/burn address
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // ETH placeholder
]);

// Explorer API config per chain
const CHAIN_API = {
  ETH:     (addr) => fetchEtherscan(addr),
  BASE:    (addr) => fetchBlockscout(addr, 8453),
  ARB:     (addr) => fetchBlockscout(addr, 42161),
  POLYGON: (addr) => fetchBlockscout(addr, 137),
};

// ── API fetchers ──────────────────────────────────────────────

async function fetchEtherscan(address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;

  const base = 'https://api.etherscan.io/api';
  const [r1, r2, r3] = await Promise.all([
    axios.get(base, { params: { module: 'proxy',   action: 'eth_getTransactionCount', address, tag: 'latest', apikey: apiKey }, timeout: 6000 }),
    axios.get(base, { params: { module: 'account', action: 'txlist',   address, page: 1, offset: 600, sort: 'desc', apikey: apiKey }, timeout: 6000 }),
    axios.get(base, { params: { module: 'account', action: 'tokentx',  address, page: 1, offset: 600, sort: 'desc', apikey: apiKey }, timeout: 6000 }),
  ]);

  const nonce    = parseInt(r1.data?.result, 16) || 0;
  const ethCount = Array.isArray(r2.data?.result) ? r2.data.result.length : 0;
  const tokCount = Array.isArray(r3.data?.result) ? r3.data.result.length : 0;
  return Math.max(nonce, ethCount, tokCount);
}

async function fetchBlockscout(address, chainId) {
  const apiKey = process.env.BLOCKSCOUT_API_KEY;
  if (!apiKey) return null;

  const base = 'https://api.blockscout.com/v2/api';
  const [r1, r2] = await Promise.all([
    axios.get(base, { params: { chain_id: chainId, module: 'account', action: 'txlist',  address, page: 1, offset: 600, sort: 'desc', apikey: apiKey }, timeout: 6000 }),
    axios.get(base, { params: { chain_id: chainId, module: 'account', action: 'tokentx', address, page: 1, offset: 600, sort: 'desc', apikey: apiKey }, timeout: 6000 }),
  ]);

  const ethCount = Array.isArray(r1.data?.result) ? r1.data.result.length : 0;
  const tokCount = Array.isArray(r2.data?.result) ? r2.data.result.length : 0;
  return Math.max(ethCount, tokCount);
}

// ── Classification ────────────────────────────────────────────

function classify(count) {
  if (count === null) return 'unknown';
  if (count <= FRESH_MAX_TXS)   return 'fresh';
  if (count >= HIGH_VOLUME_MIN) return 'high';
  return 'normal';
}

function cacheKey(address, chain) {
  return `wc:${chain}:${address.toLowerCase()}`;
}

// ── Public API ────────────────────────────────────────────────

/**
 * SYNCHRONOUS — call in alert hot path.
 * Returns cached classification or null if unknown.
 * If unknown, triggers background enrichment.
 *
 * Returns: 'fresh' | 'normal' | 'high' | null
 */
function getWalletStatus(address, chain = 'ETH') {
  const addr = address?.toLowerCase();
  if (!addr) return 'high'; // invalid — skip

  // Always skip special addresses
  if (ALWAYS_SKIP.has(addr)) return 'high';

  const key    = cacheKey(addr, chain);
  const cached = getKey(key);

  if (cached) return cached; // 'fresh' | 'normal' | 'high' | 'unknown'

  // Never seen — mark as unknown and enrich in background
  setKey(key, 'unknown', 60); // hold for 60s while enriching
  enrichWallet(addr, chain);
  return null; // null = unknown = skip this event
}

/**
 * Background enrichment — async, never blocks alert path.
 */
async function enrichWallet(address, chain = 'ETH') {
  const fetcher = CHAIN_API[chain];
  if (!fetcher) return;

  try {
    const count  = await fetcher(address);
    const status = classify(count);
    const key    = cacheKey(address, chain);
    setKey(key, status, CACHE_TTL);
    logger.info(`[WalletCheck:${chain}] ${address.slice(0,10)}... → ${status} (${count} txns)`);
  } catch (err) {
    // On error — remove unknown lock so it gets retried next time
    const key = cacheKey(address, chain);
    setKey(key, 'unknown', 30); // retry in 30s
    logger.error(`[WalletCheck:${chain}] Enrichment failed for ${address.slice(0,10)}`, { error: err.message });
  }
}

/**
 * Convenience: returns true only if wallet is confirmed fresh.
 * SYNCHRONOUS — safe to call in alert path.
 */
function isFreshWallet(address, chain = 'ETH') {
  return getWalletStatus(address, chain) === 'fresh';
}

/**
 * Convenience: returns true if wallet should be suppressed.
 * SYNCHRONOUS — safe to call in alert path.
 */
function shouldSuppress(address, chain = 'ETH') {
  const status = getWalletStatus(address, chain);
  // null = unknown (first sight, enriching) → suppress
  // 'normal' → suppress (not fresh)
  // 'high' → suppress
  // 'unknown' → suppress (still enriching)
  // 'fresh' → DON'T suppress
  return status !== 'fresh';
}

module.exports = {
  getWalletStatus,
  isFreshWallet,
  shouldSuppress,
  enrichWallet,
  FRESH_MAX_TXS,
  HIGH_VOLUME_MIN,
};
