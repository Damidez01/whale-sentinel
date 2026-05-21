const WebSocket = require('ws');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { flag, flagHop, isFlagged, shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { toUSD, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

// Thresholds
const STRUCT_COUNT   = Number(process.env.STRUCTURING_COUNT         || 5);
const STRUCT_WIN_MIN = Number(process.env.STRUCTURING_WINDOW_MIN    || 10);
const STRUCT_USD     = Number(process.env.STRUCTURING_THRESHOLD_USD || 900_000);
const DORMANT_MONTHS = Number(process.env.DORMANT_MONTHS            || 6);
const DORMANT_USD    = Number(process.env.DORMANT_MIN_USD           || 500_000);

// Known L2 bridge contracts (flagged wallet crossing to L2 is suspicious)
const BRIDGES = {
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1': 'Optimism Bridge',
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f': 'Arbitrum Bridge',
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35': 'Base Bridge',
  '0x2796317b0ff8538f1efdb9b9a3dd08fdb05e4eb1': 'zkSync Bridge',
};

// Tornado Cash pool addresses (to detect direct sends)
const TC_POOLS = new Set([
  '0xa160cdab225685da1d56aa342ad8841c3b53f291', // 100 ETH
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', // 10 ETH
]);

const CHAIN_CONFIG = [
  { name: 'ETH',  wssKey: 'ALCHEMY_ETH_WSS'  },
  { name: 'BASE', wssKey: 'ALCHEMY_BASE_WSS' },
  { name: 'ARB',  wssKey: 'ALCHEMY_ARB_WSS'  },
];

// ── Rule handlers ────────────────────────────────────────────

async function checkDirectTCDeposit(tx, usdValue, chain) {
  const to = tx.to?.toLowerCase();
  if (!TC_POOLS.has(to)) return;

  // TC monitor handles the Deposit event — this catches the ETH send leading to it
  // Only alert if it's a direct native ETH send (value > 0)
  if (!tx.value || tx.value === '0x0') return;

  sendAlert({
    chain,
    title: `🚨 CRITICAL — Direct TC Pool Deposit`,
    alertId: `evm:tcdirect:${tx.hash}`,
    txHash: tx.hash,
    wallet: tx.from,
    walletLink: true,
    body: [
      `From: \`${shortAddr(tx.from)}\``,
      `To:   Tornado Cash Pool`,
      `Amount: *${fmtUSD(usdValue)}*`,
    ].join('\n'),
  });

  flag(tx.from, 'TC_DEPOSIT', tx.hash);
}

async function checkStructuring(tx, usdValue, chain) {
  if (usdValue < 500_000 || usdValue > STRUCT_USD) return; // only near-threshold amounts

  const key   = `struct:${chain}:${tx.from?.toLowerCase()}`;
  const count = windowAdd(key, usdValue, STRUCT_WIN_MIN * 60);

  if (count === STRUCT_COUNT) {
    const allValues = windowGet(key, STRUCT_WIN_MIN * 60);
    const total     = allValues.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: `🟠 HIGH — Structuring Pattern Detected`,
      alertId: `evm:struct:${tx.from}:${Date.now()}`,
      txHash: tx.hash,
      wallet: tx.from,
      walletLink: true,
      body: [
        `Wallet: \`${shortAddr(tx.from)}\``,
        ``,
        `*${count} transactions just under $1M*`,
        `in ${STRUCT_WIN_MIN} minutes`,
        `Total moved: ${fmtUSD(total)}`,
        `Each txn: ~${fmtUSD(usdValue)}`,
        ``,
        `⚠️ Classic structuring to avoid detection`,
      ].join('\n'),
    });
  }
}

async function checkFlaggedWallet(tx, usdValue, chain) {
  const fromFlag = isFlagged(tx.from);
  if (!fromFlag) return;

  const to     = tx.to?.toLowerCase();
  const bridge = BRIDGES[to];

  if (bridge) {
    // Flagged wallet trying to bridge to L2
    sendAlert({
      chain,
      title: `🚨 CRITICAL — Flagged Wallet Bridge Exit`,
      alertId: `evm:bridge:${tx.hash}`,
      txHash: tx.hash,
      wallet: tx.from,
      walletLink: true,
      body: [
        `Wallet: \`${shortAddr(tx.from)}\``,
        `Flag reason: ${fromFlag.reason}`,
        ``,
        `Bridging to: *${bridge}*`,
        `Amount: ${fmtUSD(usdValue)}`,
        ``,
        `🔴 Previously flagged wallet attempting L2 exit`,
      ].join('\n'),
    });

    // Flag the destination hop
    if (tx.to) flagHop(tx.to, tx.from);
  }
}

async function checkDormantWallet(tx, usdValue, chain) {
  if (usdValue < DORMANT_USD) return;

  const key   = `seen:${tx.from?.toLowerCase()}`;
  const seen  = getKey(key);

  if (!seen) {
    // First time we've seen this wallet — mark it
    setKey(key, Date.now().toString(), 86400 * 30); // remember 30 days
    return; // can't determine dormancy on first sight
  }

  const lastSeen = Number(seen);
  const monthsAgo = (Date.now() - lastSeen) / (1000 * 3600 * 24 * 30);

  if (monthsAgo >= DORMANT_MONTHS) {
    sendAlert({
      chain,
      title: `🟠 HIGH — Dormant Wallet Active`,
      alertId: `evm:dormant:${tx.hash}`,
      txHash: tx.hash,
      wallet: tx.from,
      walletLink: true,
      body: [
        `Wallet: \`${shortAddr(tx.from)}\``,
        ``,
        `Silent for *${monthsAgo.toFixed(0)} months*`,
        `Now moving: *${fmtUSD(usdValue)}*`,
        ``,
        `⚠️ Dormant whale activity detected`,
      ].join('\n'),
    });
  }

  // Update last seen
  setKey(key, Date.now().toString(), 86400 * 30);
}

// ── Main tx handler ──────────────────────────────────────────

async function handleTx(tx, chain) {
  try {
    if (!tx.value || tx.value === '0x0') return;

    const usdValue = await toUSD(BigInt(tx.value), 'ETH', 18);
    if (!usdValue || usdValue < 50_000) return; // ignore dust

    await Promise.all([
      checkDirectTCDeposit(tx, usdValue, chain),
      checkStructuring(tx, usdValue, chain),
      checkFlaggedWallet(tx, usdValue, chain),
      checkDormantWallet(tx, usdValue, chain),
    ]);

  } catch (err) {
    logger.error(`[EVM:${chain}] handleTx error`, { error: err.message });
  }
}

// ── WebSocket connector ──────────────────────────────────────

function connectChain(wssUrl, chain) {
  let ws;
  let reconnectDelay = 2000;

  function connect() {
    logger.info(`[EVM:${chain}] Connecting...`);
    ws = new WebSocket(wssUrl);

    ws.on('open', () => {
      reconnectDelay = 2000;
      logger.info(`[EVM:${chain}] Connected ✓`);

      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_subscribe',
        params: ['alchemy_pendingTransactions', { toBlock: 'latest' }],
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg.params?.result) return;
        const tx = msg.params.result;
        if (tx.from && tx.hash) handleTx(tx, chain);
      } catch {}
    });

    ws.on('error', (err) => {
      logger.error(`[EVM:${chain}] Error`, { error: err.message });
    });

    ws.on('close', () => {
      logger.warn(`[EVM:${chain}] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    });
  }

  connect();
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
}

// ── Entry point ──────────────────────────────────────────────

function startEVMMonitor() {
  for (const { name, wssKey } of CHAIN_CONFIG) {
    const url = process.env[wssKey];
    if (!url || url.includes('YOUR_KEY')) {
      logger.warn(`[EVM:${name}] No WSS URL — skipping`);
      continue;
    }
    connectChain(url, name);
  }
}

module.exports = { startEVMMonitor };
