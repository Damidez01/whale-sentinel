const axios = require('axios');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { getPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

const VAULT          = '0xf5e10380213880111522dd0efd3dbb45b9f62bcc';
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY;
const MIN_USD        = Number(process.env.CHAINFLIP_MIN_USD        || 300_000);
const BURST_COUNT    = Number(process.env.CHAINFLIP_BURST_COUNT    || 3);
const BURST_WIN_MIN  = Number(process.env.CHAINFLIP_BURST_WIN_MIN  || 30);
const POLL_MS        = 30_000; // 30 seconds

// ── Fetch latest vault transactions ──────────────────────────

async function fetchVaultTxs() {
  try {
    const { data } = await axios.get('https://api.etherscan.io/api', {
      params: {
        module:     'account',
        action:     'txlist',
        address:    VAULT,
        sort:       'desc',
        page:       1,
        offset:     20, // last 20 txns
        apikey:     ETHERSCAN_KEY,
      },
      timeout: 10_000,
    });

    if (data.status !== '1') return [];
    return data.result || [];
  } catch (err) {
    logger.error('[CF] Etherscan fetch failed', { error: err.message });
    return [];
  }
}

// ── Process a single vault transaction ───────────────────────

async function processTx(tx) {
  try {
    // Dedup
    if (getKey(`cf:tx:${tx.hash}`)) return;
    setKey(`cf:tx:${tx.hash}`, '1', 3600);

    const ethPrice = await getPrice('ETH');
    if (!ethPrice) return;

    // ETH value
    const ethAmount = Number(tx.value) / 1e18;
    if (ethAmount < 0.1) return; // ignore dust

    const usdValue = ethAmount * ethPrice;
    if (usdValue < MIN_USD) return;

    const isInflow  = tx.to?.toLowerCase()   === VAULT; // ETH → vault (user depositing for swap)
    const isOutflow = tx.from?.toLowerCase() === VAULT; // vault → user (swap egress, BTC→ETH)

    if (!isInflow && !isOutflow) return;

    const direction = isOutflow
      ? { emoji: '📤', label: 'ETH OUT (BTC→ETH swap egress)', wallet: tx.to }
      : { emoji: '📥', label: 'ETH IN (ETH→BTC deposit)',      wallet: tx.from };

    logger.alert(`[CF] ${direction.label} | ${ethAmount.toFixed(2)} ETH (${fmtUSD(usdValue)}) | ${direction.wallet?.slice(0,10)}...`);

    // ── Burst detection ──
    const burstKey   = `cf:burst:${direction.wallet?.toLowerCase()}`;
    const burstCount = windowAdd(burstKey, usdValue, BURST_WIN_MIN * 60);

    if (burstCount >= BURST_COUNT) {
      const all      = windowGet(burstKey, BURST_WIN_MIN * 60);
      const totalUSD = all.reduce((s, v) => s + Number(v), 0);

      sendAlert({
        chain:  'ETH',
        title:  `🚨 CRITICAL — Chainflip Vault Burst`,
        alertId: `cf:burst:${direction.wallet}:${burstCount}`,
        txHash:  tx.hash,
        wallet:  direction.wallet,
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
      return;
    }

    // ── Single large tx ──
    sendAlert({
      chain:  'ETH',
      title:  `🟠 HIGH — Chainflip Vault ${isOutflow ? 'Egress' : 'Deposit'}`,
      alertId: `cf:single:${tx.hash}`,
      txHash:  tx.hash,
      wallet:  direction.wallet,
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

  } catch (err) {
    logger.error('[CF] processTx error', { error: err.message });
  }
}

// ── Poll loop ─────────────────────────────────────────────────

async function poll() {
  const txs = await fetchVaultTxs();
  for (const tx of txs) {
    await processTx(tx);
  }
}

function startChainflipMonitor() {
  if (!ETHERSCAN_KEY) {
    logger.warn('[CF] No ETHERSCAN_API_KEY — Chainflip monitor disabled');
    return;
  }

  logger.info(`[CF] Chainflip vault monitor starting — polling every 30s`);
  logger.info(`[CF] Vault: ${VAULT} | Min: ${fmtUSD(MIN_USD)}`);

  poll();
  setInterval(poll, POLL_MS);
}

module.exports = { startChainflipMonitor };
