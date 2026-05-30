/**
 * Nonce-based wallet classifier
 * Uses existing Alchemy RPC — no Etherscan, no rate limits
 *
 * Two calls per wallet (cached 24hrs):
 * 1. eth_getCode → contract or EOA?
 * 2. eth_getTransactionCount → nonce (txns sent)
 */

const axios  = require('axios');
const { setKey, getKey } = require('./store');
const logger = require('./logger');

const FRESH_MAX_NONCE = Number(process.env.FRESH_WALLET_MAX_TXS || 10);
const CACHE_TTL       = 86400; // 24hrs

// Get Alchemy HTTP URL from WSS URL
function getHttpUrl() {
  const wss = process.env.ALCHEMY_ETH_WSS || '';
  return wss.replace('wss://', 'https://').replace('ws://', 'http://');
}

// Single RPC call helper
async function rpcCall(method, params) {
  const url = getHttpUrl();
  if (!url || url.includes('YOUR_KEY')) return null;

  try {
    const { data } = await axios.post(url, {
      jsonrpc: '2.0', id: 1, method, params,
    }, { timeout: 4000 });
    return data?.result ?? null;
  } catch {
    return null;
  }
}

// Check if address is a smart contract
async function isContract(address) {
  const code = await rpcCall('eth_getCode', [address, 'latest']);
  return code && code !== '0x' && code !== '0x0';
}

// Get nonce (number of txns sent)
async function getNonce(address) {
  const result = await rpcCall('eth_getTransactionCount', [address, 'latest']);
  return result ? parseInt(result, 16) : null;
}

// ── Cache key ─────────────────────────────────────────────────

function cacheKey(address) {
  return `nonce:${address.toLowerCase()}`;
}

// ── Enrichment queue (rate limited) ──────────────────────────

const enrichQueue = new Set(); // use Set to avoid duplicates
let enrichRunning = false;

async function processQueue() {
  if (enrichRunning) return;
  enrichRunning = true;

  for (const address of enrichQueue) {
    enrichQueue.delete(address);
    await enrichAddress(address);
    await new Promise(r => setTimeout(r, 100)); // 100ms between calls
  }

  enrichRunning = false;
}

async function enrichAddress(address) {
  const key = cacheKey(address);

  try {
    // Step 1: Is it a contract?
    const contract = await isContract(address);
    if (contract) {
      setKey(key, 'contract', CACHE_TTL);
      return;
    }

    // Step 2: Get nonce
    const nonce = await getNonce(address);
    if (nonce === null) {
      setKey(key, 'unknown', 60); // retry in 60s
      return;
    }

    const status = nonce <= FRESH_MAX_NONCE ? 'fresh' : 'normal';
    setKey(key, `${status}:${nonce}`, CACHE_TTL);
    logger.info(`[Nonce] ${address.slice(0, 10)}... → ${status} (nonce=${nonce})`);
  } catch (err) {
    setKey(key, 'unknown', 60);
    logger.error(`[Nonce] Enrichment failed for ${address.slice(0, 10)}`, { error: err.message });
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * SYNCHRONOUS — safe to call in alert hot path.
 * Returns cached status or null (unknown = first sight).
 * Triggers background enrichment on first sight.
 */
function getAddressStatus(address) {
  const addr = address?.toLowerCase();
  if (!addr) return 'contract';

  const key    = cacheKey(addr);
  const cached = getKey(key);

  if (cached) {
    return cached.split(':')[0]; // 'fresh' | 'normal' | 'contract' | 'unknown'
  }

  // Never seen — queue enrichment, skip this event
  setKey(key, 'unknown', 60);
  enrichQueue.add(addr);
  processQueue();
  return null; // unknown = skip
}

/**
 * Returns true only if wallet is confirmed fresh EOA.
 * SYNCHRONOUS.
 */
function isFreshEOA(address) {
  return getAddressStatus(address) === 'fresh';
}

/**
 * Returns true if wallet should be suppressed (not fresh EOA).
 * null = unknown (first sight) = suppress until enriched.
 * SYNCHRONOUS.
 */
function suppressAddress(address) {
  const status = getAddressStatus(address);
  return status !== 'fresh'; // suppress everything except confirmed fresh
}

module.exports = { getAddressStatus, isFreshEOA, suppressAddress, FRESH_MAX_NONCE };
