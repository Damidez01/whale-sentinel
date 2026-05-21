const WebSocket = require('ws');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { flag, flagHop, isFlagged, shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { toUSD, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

// Thresholds
const STRUCT_COUNT      = Number(process.env.STRUCTURING_COUNT         || 5);
const STRUCT_WIN_MIN    = Number(process.env.STRUCTURING_WINDOW_MIN    || 10);
const STRUCT_USD        = Number(process.env.STRUCTURING_THRESHOLD_USD || 900_000);
const DORMANT_MONTHS    = Number(process.env.DORMANT_MONTHS            || 6);
const DORMANT_USD       = Number(process.env.DORMANT_MIN_USD           || 500_000);
const ACCUM_MIN_USD     = Number(process.env.ACCUM_MIN_USD             || 100_000);
const ACCUM_COUNT       = Number(process.env.ACCUM_COUNT               || 3);
const ACCUM_WIN_MIN     = Number(process.env.ACCUM_WIN_MIN             || 15);
const CHAINFLIP_MIN_USD = Number(process.env.CHAINFLIP_MIN_USD         || 500_000);

// CEX hot wallets — suppress rapid accumulation alerts for these receivers
const CEX_RECEIVERS = new Set([
  '0x28c6c06298d514db089934071355e5743bf21d60', // Binance Hot Wallet
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549', // Binance Cold Wallet
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', // Binance
  '0xf977814e90da44bfa03b6295a0616a897441acec', // Binance
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', // Coinbase
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3', // Coinbase
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', // OKX
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13', // Kraken
  '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b', // Tornado Router
]);

// Known L2 bridge contracts
const BRIDGES = {
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1': 'Optimism Bridge',
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f': 'Arbitrum Bridge',
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35': 'Base Bridge',
  '0x2796317b0ff8538f1efdb9b9a3dd08fdb05e4eb1': 'zkSync Bridge',
};

// Tornado Cash pool addresses
const TC_POOLS = new Set([
  '0xa160cdab225685da1d56aa342ad8841c3b53f291', // 100 ETH pool
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', // 10 ETH pool
]);

// Chainflip vault (ETH mainnet)
const CHAINFLIP_VAULT = '0xf5e10380213880111522dd0efd3dbb45b9f62bcc';

const CHAIN_CONFIG = [
  { name: 'ETH',  wssKey: 'ALCHEMY_ETH_WSS'  },
  { name: 'BASE', wssKey: 'ALCHEMY_BASE_WSS' },
  { name: 'ARB',  wssKey: 'ALCHEMY_ARB_WSS'  },
];

// ── Rule handlers ────────────────────────────────────────────

// Rule 1: Direct TC deposit
async function checkDirectTCDeposit(tx, usdValue, chain) {
  const to = tx.to?.toLowerCase();
  if (!TC_POOLS.has(to)) return;
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

// Rule 2: Chainflip vault — large ETH in or out
async function checkChainflip(tx, usdValue, chain) {
  if (chain !== 'ETH') return; // Chainflip vault is ETH mainnet only
  if (usdValue < CHAINFLIP_MIN_USD) return;

  const to   = tx.to?.toLowerCase();
  const from = tx.from?.toLowerCase();

  const isDeposit  = to === CHAINFLIP_VAULT;
  const isWithdraw = from === CHAINFLIP_VAULT;

  if (!isDeposit && !isWithdraw) return;

  const direction = isDeposit ? '📥 Into Chainflip' : '📤 Out of Chainflip';
  const wallet    = isDeposit ? tx.from : tx.to;

  // Burst detection — same wallet multiple times
  const burstKey   = `cf:burst:${isDeposit ? tx.from : tx.to}`;
  const burstCount = windowAdd(burstKey, usdValue, 15 * 60);

  if (burstCount >= 3) {
    const all      = windowGet(burstKey, 15 * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: `🚨 CRITICAL — Chainflip Burst Activity`,
      alertId: `evm:cf:burst:${wallet}:${burstCount}`,
      txHash: tx.hash,
      wallet,
      walletLink: true,
      body: [
        `Direction: ${direction}`,
        `Wallet: \`${shortAddr(wallet)}\``,
        ``,
        `*${burstCount} transactions in 15 min*`,
        `Total: *${fmtUSD(totalUSD)}*`,
        `Latest: ${fmtUSD(usdValue)}`,
        ``,
        `Chainflip Vault: \`${shortAddr(CHAINFLIP_VAULT)}\``,
      ].join('\n'),
    });
    return;
  }

  // Single large tx
  sendAlert({
    chain,
    title: `🟠 HIGH — Large Chainflip Vault ${isDeposit ? 'Deposit' : 'Withdrawal'}`,
    alertId: `evm:cf:single:${tx.hash}`,
    txHash: tx.hash,
    wallet,
    walletLink: true,
    body: [
      `Direction: ${direction}`,
      `Wallet: \`${shortAddr(wallet)}\``,
      `Amount: *${fmtUSD(usdValue)}*`,
      ``,
      `🔗 [Chainflip Explorer](https://scan.chainflip.io)`,
    ].join('\n'),
  });
}

// Rule 3: Rapid accumulation — same wallet receives 3+ large txns in 15 min
async function checkRapidAccumulation(tx, usdValue, chain) {
  if (usdValue < ACCUM_MIN_USD) return;
  if (!tx.to) return;
  if (CEX_RECEIVERS.has(tx.to.toLowerCase())) return;

  const key   = `accum:${chain}:${tx.to.toLowerCase()}`;
  const count = windowAdd(key, usdValue, ACCUM_WIN_MIN * 60);

  if (count === ACCUM_COUNT) {
    const all      = windowGet(key, ACCUM_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: `🚨 CRITICAL — Rapid Fund Accumulation`,
      alertId: `evm:accum:${tx.to}:${Date.now()}`,
      txHash: tx.hash,
      wallet: tx.to,
      walletLink: true,
      body: [
        `Receiving wallet: \`${shortAddr(tx.to)}\``,
        ``,
        `*${count} incoming txns in ${ACCUM_WIN_MIN} min*`,
        `Total received: *${fmtUSD(totalUSD)}*`,
        `Each: ≥ ${fmtUSD(ACCUM_MIN_USD)}`,
        ``,
        `⚠️ Matches theft relay, phishing, or CEX hack pattern`,
      ].join('\n'),
    });
  }

  // Keep escalating every 2 after threshold
  if (count > ACCUM_COUNT && (count - ACCUM_COUNT) % 2 === 0) {
    const all      = windowGet(key, ACCUM_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: `🚨 CRITICAL — Accumulation Escalating`,
      alertId: `evm:accum:escalate:${tx.to}:${count}`,
      txHash: tx.hash,
      wallet: tx.to,
      walletLink: true,
      body: [
        `Receiving wallet: \`${shortAddr(tx.to)}\``,
        ``,
        `Now *${count} txns* in ${ACCUM_WIN_MIN} min`,
        `Total received: *${fmtUSD(totalUSD)}*`,
        ``,
        `🔴 Still actively receiving funds`,
      ].join('\n'),
    });
  }
}

// Rule 4: Structuring
async function checkStructuring(tx, usdValue, chain) {
  if (usdValue < 500_000 || usdValue > STRUCT_USD) return;

  const key   = `struct:${chain}:${tx.from?.toLowerCase()}`;
  const count = windowAdd(key, usdValue, STRUCT_WIN_MIN * 60);

  if (count === STRUCT_COUNT) {
    const all      = windowGet(key, STRUCT_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

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
        `Total moved: ${fmtUSD(totalUSD)}`,
        `Each txn: ~${fmtUSD(usdValue)}`,
        ``,
        `⚠️ Classic structuring to avoid detection`,
      ].join('\n'),
    });
  }
}

// Rule 5: Flagged wallet bridge exit
async function checkFlaggedWallet(tx, usdValue, chain) {
  const fromFlag = isFlagged(tx.from);
  if (!fromFlag) return;

  const to     = tx.to?.toLowerCase();
  const bridge = BRIDGES[to];
  if (!bridge) return;

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

  if (tx.to) flagHop(tx.to, tx.from);
}

// Rule 6: Dormant wallet
async function checkDormantWallet(tx, usdValue, chain) {
  if (usdValue < DORMANT_USD) return;

  const key  = `seen:${tx.from?.toLowerCase()}`;
  const seen = getKey(key);

  if (!seen) {
    setKey(key, Date.now().toString(), 86400 * 30);
    return;
  }

  const monthsAgo = (Date.now() - Number(seen)) / (1000 * 3600 * 24 * 30);

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

  setKey(key, Date.now().toString(), 86400 * 30);
}

// ── Main tx handler ──────────────────────────────────────────

async function handleTx(tx, chain) {
  try {
    if (!tx.value || tx.value === '0x0') return;

    const usdValue = await toUSD(BigInt(tx.value), 'ETH', 18);
    if (!usdValue || usdValue < 10_000) return; // ignore dust

    await Promise.all([
      checkDirectTCDeposit(tx, usdValue, chain),
      checkChainflip(tx, usdValue, chain),
      checkRapidAccumulation(tx, usdValue, chain),
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
