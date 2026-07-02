const axios = require('axios');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { getPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

const MIDGARD       = process.env.THORCHAIN_MIDGARD         || 'https://midgard.ninerealms.com/v2';
const MIN_USD       = Number(process.env.THORCHAIN_MIN_SWAP_USD     || 500_000);
const BURST_COUNT   = Number(process.env.THORCHAIN_BURST_COUNT      || 3);
const BURST_WIN_MIN = Number(process.env.THORCHAIN_BURST_WINDOW_MIN || 30);
const POLL_MS       = 15_000;

const ETH_ASSETS = new Set(['ETH', 'WETH']);

// ── Cursor — persisted so restarts don't re-alert ────────────
let lastSeenTxId = null;

function restoreCursor() {
  const saved = getKey('thor:lastTxId');
  if (saved) {
    lastSeenTxId = saved;
    logger.info(`[THOR] Resuming from txId ${saved.slice(0, 10)}...`);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function parseAsset(raw) {
  if (!raw) return null;
  const token = raw.split('.')[1]?.split('-')[0];
  return token || raw.split('.')[0];
}

function getDirection(inAsset, outAsset) {
  if (ETH_ASSETS.has(inAsset) && outAsset === 'BTC') return 'ETH_TO_BTC';
  if (inAsset === 'BTC' && ETH_ASSETS.has(outAsset)) return 'BTC_TO_ETH';
  return null;
}

function directionLabel(direction) {
  if (direction === 'ETH_TO_BTC') return { emoji: '🔴', label: 'Exit to BTC' };
  if (direction === 'BTC_TO_ETH') return { emoji: '🟡', label: 'BTC → ETH ecosystem' };
  return { emoji: '🔵', label: 'Swap' };
}

// ── Fetch ────────────────────────────────────────────────────

async function fetchSwaps() {
  try {
    const { data } = await axios.get(`${MIDGARD}/actions`, {
      params: { type: 'swap', limit: 50 },
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChainHound/2.0)',
        'Accept': 'application/json',
      },
    });
    return data?.actions || [];
  } catch (err) {
    logger.error('[THOR] Fetch failed', { error: err.message });
    return [];
  }
}

// ── Process ──────────────────────────────────────────────────

async function processSwap(swap) {
  try {
    const txId   = swap.in?.[0]?.txID;
    const status = swap.status;
    if (!txId || status !== 'success') return;

    // Dedup — 7-day TTL so restarts never re-alert
    if (getKey(`thor:tx:${txId}`)) return;
    setKey(`thor:tx:${txId}`, '1', 86400 * 7);

    const inCoin  = swap.in?.[0]?.coins?.[0];
    const outCoin = swap.out?.[0]?.coins?.[0];
    if (!inCoin || !outCoin) return;

    const inAsset   = parseAsset(inCoin.asset);
    const outAsset  = parseAsset(outCoin.asset);
    const direction = getDirection(inAsset, outAsset);
    if (!direction) return;

    const inAmount  = Number(inCoin.amount)  / 1e8;
    const outAmount = Number(outCoin.amount) / 1e8;
    const fromAddr  = swap.in?.[0]?.address;
    const toAddr    = swap.out?.[0]?.address;

    const inPrice  = await getPrice(inAsset) || 1;
    const usdValue = inAmount * inPrice;
    if (usdValue < MIN_USD) return;

    const { emoji, label } = directionLabel(direction);

    // Burst detection — track per wallet
    const trackAddr  = direction === 'ETH_TO_BTC' ? fromAddr : toAddr;
    const burstKey   = `thor:burst:${trackAddr}`;
    const burstCount = windowAdd(burstKey, usdValue, BURST_WIN_MIN * 60);

    logger.alert(`[THOR] ${direction} | ${inAmount.toFixed(2)} ${inAsset} → ${outAmount.toFixed(4)} ${outAsset} | ${fmtUSD(usdValue)} | burst: ${burstCount}`);

    if (burstCount >= BURST_COUNT) {
      const allSwaps = windowGet(burstKey, BURST_WIN_MIN * 60);
      const totalUSD = allSwaps.reduce((s, v) => s + Number(v), 0);

      sendAlert({
        chain: 'THOR',
        title: `🚨 CRITICAL — THORChain Burst ${label}`,
        alertId: `thor:burst:${trackAddr}:${burstCount}`,
        txHash: txId,
        wallet: trackAddr,
        walletLink: true,
        body: [
          `Direction: ${emoji} ${inAsset} → ${outAsset}`,
          `Wallet: \`${shortAddr(trackAddr)}\``,
          ``,
          `*${burstCount} swaps in ${BURST_WIN_MIN} min*`,
          `Total moved: *${fmtUSD(totalUSD)}*`,
          `Latest: ${inAmount.toFixed(2)} ${inAsset} → ${outAmount.toFixed(4)} ${outAsset}`,
          ``,
          `🔗 [View on THORChain](https://thorchain.net/tx/${txId})`,
        ].join('\n'),
      });
      return;
    }

    sendAlert({
      chain: 'THOR',
      title: `🟠 HIGH — THORChain Large Swap`,
      alertId: `thor:single:${txId}`,
      txHash: txId,
      wallet: fromAddr || toAddr,
      walletLink: true,
      body: [
        `Direction: ${emoji} ${label}`,
        `Swap: *${inAmount.toFixed(2)} ${inAsset} → ${outAmount.toFixed(4)} ${outAsset}*`,
        `Value: *${fmtUSD(usdValue)}*`,
        fromAddr ? `From: \`${shortAddr(fromAddr)}\`` : '',
        toAddr   ? `To:   \`${shortAddr(toAddr)}\`` : '',
        ``,
        `🔗 [View on THORChain](https://thorchain.net/tx/${txId})`,
      ].filter(Boolean).join('\n'),
    });

  } catch (err) {
    logger.error('[THOR] processSwap error', { error: err.message });
  }
}

// ── Poll loop ─────────────────────────────────────────────────

async function poll() {
  const swaps = await fetchSwaps();
  if (!swaps.length) return;

  // Find where we left off — only process swaps newer than lastSeenTxId
  const lastIdx  = swaps.findIndex(s => s.in?.[0]?.txID === lastSeenTxId);
  const newSwaps = lastIdx === -1 ? swaps : swaps.slice(0, lastIdx);

  if (!newSwaps.length) return;

  // Process oldest first so cursor advances correctly
  for (const swap of newSwaps.reverse()) {
    await processSwap(swap);
    const txId = swap.in?.[0]?.txID;
    if (txId) {
      lastSeenTxId = txId;
      setKey('thor:lastTxId', txId, 86400 * 30);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────

function startTHORChainMonitor() {
  restoreCursor();
  logger.info('[THOR] THORChain monitor starting — polling every 15s');
  logger.info(`[THOR] Midgard: ${MIDGARD} | Min: ${fmtUSD(MIN_USD)} | Burst: ${BURST_COUNT}x in ${BURST_WIN_MIN}min`);
  poll();
  setInterval(poll, POLL_MS);
}

module.exports = { startTHORChainMonitor };
