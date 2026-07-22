const axios = require('axios');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { getPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

const VAULT         = '0xf5e10380213880111522dd0efd3dbb45b9f62bcc';
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY;
const MIN_USD       = Number(process.env.CHAINFLIP_MIN_USD       || 500_000);
const BURST_COUNT   = Number(process.env.CHAINFLIP_BURST_COUNT   || 3);
const BURST_WIN_MIN = Number(process.env.CHAINFLIP_BURST_WIN_MIN || 30);
const POLL_MS       = 30_000;

// ── Block cursor — persisted so restarts don't re-alert ──────
// On startup we restore from store; on each processed tx we advance it.
let lastSeenBlock = 0;

function restoreCursor() {
  const saved = getKey('cf:lastBlock');
  if (saved) {
    lastSeenBlock = Number(saved);
    logger.info(`[CF] Resuming from block ${lastSeenBlock}`);
  }
}

function advanceCursor(blockNumber) {
  const n = Number(blockNumber);
  if (n > lastSeenBlock) {
    lastSeenBlock = n;
    setKey('cf:lastBlock', lastSeenBlock.toString(), 86400 * 30);
  }
}

// ── Fetch vault transactions ─────────────────────────────────

async function fetchWithRetry(params, label) {
  const base = 'https://api.etherscan.io/v2/api';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data } = await axios.get(base, { params, timeout: 15_000 });
      return data?.status === '1' ? data.result : [];
    } catch (err) {
      if (attempt === 2) {
        logger.error(`[CF] Etherscan ${label} fetch failed`, { error: err.message });
        return [];
      }
      await new Promise(r => setTimeout(r, 1500)); // brief pause before retry
    }
  }
  return [];
}

async function fetchVaultTxs() {
  const common = {
    address:    VAULT,
    sort:       'asc',
    startblock: lastSeenBlock + 1,
    endblock:   99999999,
    page:       1,
    offset:     50,
    apikey:     ETHERSCAN_KEY,
    chainid:    1,
  };

  const inflows  = await fetchWithRetry({ ...common, module: 'account', action: 'txlist' }, 'txlist');
  const outflows = await fetchWithRetry({ ...common, module: 'account', action: 'txlistinternal' }, 'txlistinternal');

  return { inflows, outflows };
}

// ── Process a single vault transaction ───────────────────────

async function processTx(tx) {
  try {
    const isInflow  = tx.to?.toLowerCase()   === VAULT;
    const isOutflow = tx.from?.toLowerCase() === VAULT;

    // Dedup — 7-day TTL so restarts never re-alert
    const dedupKey = `cf:tx:${tx.hash}:${isInflow ? 'in' : 'out'}`;
    if (getKey(dedupKey)) {
      advanceCursor(tx.blockNumber);
      return;
    }
    setKey(dedupKey, '1', 86400 * 7);

    const direction = isOutflow
      ? { emoji: '📤', label: 'ETH OUT (BTC→ETH swap egress)', wallet: tx.to   }
      : { emoji: '📥', label: 'ETH IN (ETH→BTC deposit)',      wallet: tx.from };

    const ethPrice = await getPrice('ETH');
    if (!ethPrice) return;

    const ethAmount = Number(tx.value) / 1e18;
    if (ethAmount < 0.1) { advanceCursor(tx.blockNumber); return; }

    const usdValue = ethAmount * ethPrice;
    if (usdValue < MIN_USD) { advanceCursor(tx.blockNumber); return; }

    logger.alert(`[CF] ${direction.label} | ${ethAmount.toFixed(2)} ETH ($${(usdValue/1000).toFixed(0)}K) | ${direction.wallet?.slice(0, 10)}...`);

    // ── Burst detection ──────────────────────────────────────
    const burstKey   = `cf:burst:${direction.wallet?.toLowerCase()}`;
    const burstCount = windowAdd(burstKey, usdValue, BURST_WIN_MIN * 60);

    if (burstCount >= BURST_COUNT) {
      const all      = windowGet(burstKey, BURST_WIN_MIN * 60);
      const totalUSD = all.reduce((s, v) => s + Number(v), 0);

      sendAlert({
        chain: 'ETH',
        title: '🚨 CRITICAL — Chainflip Vault Burst',
        alertId: `cf:burst:${direction.wallet}:${burstCount}`,
        txHash: tx.hash,
        wallet: direction.wallet,
        walletLink: true,
        body: [
          `Direction: ${direction.emoji} ${direction.label}`,
          `Wallet: \`${shortAddr(direction.wallet)}\``,
          ``,
          `*${burstCount} transactions in ${BURST_WIN_MIN} min*`,
          `Total: *${fmtUSD(totalUSD)}*`,
          `Latest: ${ethAmount.toFixed(2)} ETH (${fmtUSD(usdValue)})`,
          ``,
          `🔗 [Chainflip Explorer](https://scan.chainflip.io)`,
        ].join('\n'),
      });
    } else {
      sendAlert({
        chain: 'ETH',
        title: `🟠 HIGH — Chainflip Vault ${isOutflow ? 'Egress' : 'Deposit'}`,
        alertId: `cf:single:${tx.hash}`,
        txHash: tx.hash,
        wallet: direction.wallet,
        walletLink: true,
        body: [
          `Direction: ${direction.emoji} ${direction.label}`,
          `Wallet: \`${shortAddr(direction.wallet)}\``,
          `Amount: *${ethAmount.toFixed(2)} ETH (${fmtUSD(usdValue)})*`,
          ``,
          isOutflow
            ? `⚠️ Swap egress — likely BTC→ETH conversion complete`
            : `⚠️ Large deposit — likely ETH→BTC swap initiated`,
          ``,
          `🔗 [Chainflip Explorer](https://scan.chainflip.io)`,
        ].join('\n'),
      });
    }

    advanceCursor(tx.blockNumber);

  } catch (err) {
    logger.error('[CF] processTx error', { error: err.message });
  }
}


// ── Poll loop ─────────────────────────────────────────────────

async function poll() {
  const { inflows, outflows } = await fetchVaultTxs();

  // Process inflows (txlist) — ETH sent TO vault
  // Filter: only where vault is the recipient and value > 0
  const newInflows = inflows
    .filter(tx => tx.to?.toLowerCase() === VAULT && Number(tx.value) > 0)
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

  // Process outflows (txlistinternal) — ETH sent FROM vault to recipient
  // Filter: only where vault is the sender and value > 0
  const newOutflows = outflows
    .filter(tx => tx.from?.toLowerCase() === VAULT && Number(tx.value) > 0)
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

  for (const tx of [...newInflows, ...newOutflows].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))) {
    await processTx(tx);
  }
}

// ── Entry point ──────────────────────────────────────────────

function startChainflipMonitor() {
  if (!ETHERSCAN_KEY) {
    logger.warn('[CF] No ETHERSCAN_API_KEY — Chainflip monitor disabled');
    return;
  }

  restoreCursor();

  logger.info(`[CF] Chainflip vault monitor starting — polling every ${POLL_MS / 1000}s`);
  logger.info(`[CF] Vault: ${VAULT} | Min: ${fmtUSD(MIN_USD)}`);

  poll();
  setInterval(poll, POLL_MS);
}

module.exports = { startChainflipMonitor };
