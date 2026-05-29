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
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', // Tornado Router
  '0xa1abfa21f80ecf401bd41365adbb6fef6fefdf09', // Bybit
  '0xe401a6a38024d8f5ab88f1b08cad476ccaca45e8', // Bybit
  '0xedc7001e99a37c3d23b5f7974f837387e09f9c93', // Coinbase Deposit
  '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621', // Jump Trading
  '0x62425cd6bdcb6bfe51558ea465b063486b70dc9f', // Bybit
  '0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511', // Coinbase
  '0x389044f3ac7472060a0618116e3624a5f0f20f28', // Shakepay
  '0xa9ac43f5b5e38155a288d1a01d2cbc4478e14573', // OKX
  '0xbbd0d4d067d5af2065b1b6fd936d93237ae1c56c', // ShakePay
  '0x0003b5aa5e30e97fcc596bb5d0f3a75255e08d4e', // OKX
  '0x549d835356d92983abb76e4cae639f7857963425', // b2C Group
  '0x652a2ade712e21b9f83672bde4462c6f8723a30b', // OKX Deposit
  '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', // Relay
  '0xf30ba13e4b04ce5dc4d254ae5fa95477800f0eb0', // Kraken
  '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', // Morpho Protocol
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3
  '0xc36442b4a4522e871399cd717abdd847ab11fe88', // Uniswap V3 Positions
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH Lido
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

// DEX/Swap routers — exclude from accumulation (normal trading activity)
const SWAP_ROUTERS = new Set([
  '0xe66b31678d6c16e9ebf358268a790b763c133750', // 0x Exchange Proxy
  '0xba3cb449bd2b4adddbc894d8697f5170800eadec', // CoW Protocol
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41', // CoW Protocol Settlement
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 Router 2
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', // Uniswap Universal Router
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router 2
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch V5
  '0x1111111254fb6c44bac0bed2854e76f90643097d', // 1inch V4
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap Router
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Exchange Proxy v2
  '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer Vault
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap
  '0x6a000f20005980200259b80c5102003040001068', // ParaSwap
  '0x0000000000004444c5dc75cb358380d2e3de08a90', // Uniswap V4 Pool Manager
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap V2 Router 02
]);

// Thresholds for new rules
const FRESH_WALLET_MAX_TXS  = Number(process.env.FRESH_WALLET_MAX_TXS  || 10);
const FRESH_WALLET_MIN_USD  = Number(process.env.FRESH_WALLET_MIN_USD  || 200_000);
const PEEL_MIN_LEGS         = Number(process.env.PEEL_MIN_LEGS         || 3);
const PEEL_WIN_MIN          = Number(process.env.PEEL_WIN_MIN          || 120);
const PEEL_MIN_USD          = Number(process.env.PEEL_MIN_USD          || 20_000);
const FANOUT_MIN_LEGS       = Number(process.env.FANOUT_MIN_LEGS       || 5);
const FANOUT_WIN_MIN        = Number(process.env.FANOUT_WIN_MIN        || 30);
const FANOUT_TOTAL_USD      = Number(process.env.FANOUT_TOTAL_USD      || 1_000_000);

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
  if (chain !== 'ETH') return;
  if (usdValue < CHAINFLIP_MIN_USD) return;

  const to   = tx.to?.toLowerCase();
  const from = tx.from?.toLowerCase();

  const isDeposit  = to === CHAINFLIP_VAULT;
  const isWithdraw = from === CHAINFLIP_VAULT;

  if (!isDeposit && !isWithdraw) return;

  const direction = isDeposit ? '📥 Into Chainflip' : '📤 Out of Chainflip';
  const wallet    = isDeposit ? tx.from : tx.to;

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

const { isFreshWallet, isHighVolumeWallet, getWalletCategory, preCheckWallet, isSuppressed, FRESH_MAX_TXS } = require('../utils/walletcheck');
const axios = require('axios');

// Wallet check functions moved to src/utils/walletcheck.js

// Rule 3: Rapid accumulation
async function checkRapidAccumulation(tx, usdValue, chain) {
  if (usdValue < ACCUM_MIN_USD) return;
  if (!tx.to) return;

  const toLower   = tx.to.toLowerCase();
  const fromLower = tx.from?.toLowerCase();

  // Layer 1: Hardcoded suppressions (instant)
  if (CEX_RECEIVERS.has(toLower)) return;
  if (SWAP_ROUTERS.has(toLower) || SWAP_ROUTERS.has(fromLower)) return;

  // Layer 2: Pre-check on first encounter (cached 24hrs)
  if (await preCheckWallet(toLower, chain)) return;
  if (isSuppressed(toLower, chain)) return;

  // Layer 3: FRESH WALLET ONLY — receiver must have < 10 lifetime txns
  const receiverFresh = await isFreshWallet(toLower, chain);
  if (!receiverFresh) return;

  const key   = `accum:${chain}:${toLower}`;
  const count = windowAdd(key, usdValue, ACCUM_WIN_MIN * 60);

  if (count === ACCUM_COUNT) {
    const all      = windowGet(key, ACCUM_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: `🚨 CRITICAL — Fresh Wallet Rapid Accumulation`,
      alertId: `evm:accum:${chain}:${toLower}`,
      txHash: tx.hash,
      wallet: tx.to,
      walletLink: true,
      body: [
        `Receiving wallet: \`${shortAddr(tx.to)}\``,
        ``,
        `*${count} incoming txns in ${ACCUM_WIN_MIN} min*`,
        `Total received: *${fmtUSD(totalUSD)}*`,
        `Each: ≥ ${fmtUSD(ACCUM_MIN_USD)}`,
        `🆕 Fresh wallet (< ${FRESH_MAX_TXS} lifetime txs)`,
        ``,
        `⚠️ Matches theft relay, phishing, or CEX hack pattern`,
      ].filter(Boolean).join('\n'),
    });
  }

  // Escalate every 2 after threshold
  if (count > ACCUM_COUNT && (count - ACCUM_COUNT) % 2 === 0) {
    const all      = windowGet(key, ACCUM_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: `🚨 CRITICAL — Accumulation Escalating`,
      alertId: `evm:accum:escalate:${chain}:${toLower}:${count}`,
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
      alertId: `evm:struct:${chain}:${tx.from}`,
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

// Rule 7: Peel chain detection
async function checkPeelChain(tx, usdValue, chain) {
  if (usdValue < PEEL_MIN_USD) return;
  if (!tx.from || !tx.to) return;
  if (SWAP_ROUTERS.has(tx.to.toLowerCase())) return;
  if (CEX_RECEIVERS.has(tx.to.toLowerCase())) return;

  const fromLower = tx.from.toLowerCase();

  // SENDER must be fresh wallet
  if (await preCheckWallet(fromLower, chain)) return;
  if (isSuppressed(fromLower, chain)) return;
  const senderFresh = await isFreshWallet(fromLower, chain);
  if (!senderFresh) return;

  // Track outgoing destinations from this wallet
  const peelKey = `peel:out:${chain}:${fromLower}`;
  windowAdd(peelKey, tx.to.toLowerCase(), PEEL_WIN_MIN * 60);
  const destinations = windowGet(peelKey, PEEL_WIN_MIN * 60);
  const uniqueDests  = new Set(destinations).size;

  if (uniqueDests === PEEL_MIN_LEGS) {
    // Check if at least 2 destinations are fresh wallets
    const destSample  = [...new Set(destinations)].slice(0, 3);
    const freshChecks = await Promise.all(destSample.map(d => isFreshWallet(d, chain)));
    const freshCount  = freshChecks.filter(Boolean).length;

    if (freshCount >= 2) {
      const totalKey = `peel:total:${chain}:${fromLower}`;
      const allVals  = windowGet(totalKey, PEEL_WIN_MIN * 60);
      const totalUSD = allVals.reduce((s, v) => s + Number(v), 0) || usdValue * uniqueDests;

      sendAlert({
        chain,
        title: `🚨 CRITICAL — Peel Chain Detected`,
        alertId: `evm:peel:${chain}:${fromLower}:${uniqueDests}`,
        txHash: tx.hash,
        wallet: tx.from,
        walletLink: true,
        body: [
          `Source wallet: \`${shortAddr(tx.from)}\``,
          ``,
          `Distributing to *${uniqueDests} different wallets*`,
          `within ${PEEL_WIN_MIN} min`,
          `Fresh recipients: ${freshCount}/${destSample.length} checked`,
          `Total distributed: *${fmtUSD(totalUSD || usdValue)}*`,
          ``,
          `🔴 Classic peel chain — layering stolen funds`,
        ].join('\n'),
      });
    }
  }

  // Track total outgoing for this wallet
  windowAdd(`peel:total:${chain}:${fromLower}`, usdValue, PEEL_WIN_MIN * 60);
}

// Rule 8: Fan-out pattern
async function checkFanOut(tx, usdValue, chain) {
  if (usdValue < PEEL_MIN_USD) return;
  if (!tx.from || !tx.to) return;
  if (SWAP_ROUTERS.has(tx.to.toLowerCase())) return;
  if (CEX_RECEIVERS.has(tx.to.toLowerCase())) return;

  const fromLower = tx.from.toLowerCase();

  // SENDER must be fresh wallet
  if (await preCheckWallet(fromLower, chain)) return;
  if (isSuppressed(fromLower, chain)) return;
  const fanSenderFresh = await isFreshWallet(fromLower, chain);
  if (!fanSenderFresh) return;

  const fanKey      = `fanout:${chain}:${fromLower}`;
  windowAdd(fanKey, tx.to.toLowerCase(), FANOUT_WIN_MIN * 60);
  const dests       = windowGet(fanKey, FANOUT_WIN_MIN * 60);
  const uniqueDests = new Set(dests).size;

  if (uniqueDests === FANOUT_MIN_LEGS) {

    const valKey   = `fanout:val:${chain}:${fromLower}`;
    windowAdd(valKey, usdValue, FANOUT_WIN_MIN * 60);
    const allVals  = windowGet(valKey, FANOUT_WIN_MIN * 60);
    const totalUSD = allVals.reduce((s, v) => s + Number(v), 0);

    if (totalUSD >= FANOUT_TOTAL_USD) {
      sendAlert({
        chain,
        title: `🚨 CRITICAL — Fund Distribution Pattern`,
        alertId: `evm:fanout:${chain}:${fromLower}:${uniqueDests}`,
        txHash: tx.hash,
        wallet: tx.from,
        walletLink: true,
        body: [
          `Source wallet: \`${shortAddr(tx.from)}\``,
          ``,
          `Sent to *${uniqueDests} different wallets*`,
          `in ${FANOUT_WIN_MIN} min`,
          `Total distributed: *${fmtUSD(totalUSD)}*`,
          `Each: ~${fmtUSD(totalUSD / uniqueDests)}`,
          ``,
          `⚠️ Large fund distribution — possible layering`,
        ].join('\n'),
      });
    }
  }

  // Always track value
  windowAdd(`fanout:val:${chain}:${fromLower}`, usdValue, FANOUT_WIN_MIN * 60);
}

// Rule 9: Single large tx to fresh wallet
async function checkFreshWalletLargeSend(tx, usdValue, chain) {
  if (usdValue < FRESH_WALLET_MIN_USD) return;
  if (!tx.to) return;
  if (SWAP_ROUTERS.has(tx.to.toLowerCase())) return;
  if (CEX_RECEIVERS.has(tx.to.toLowerCase())) return;

  // Only check once per wallet per day
  const cacheKey = `freshcheck:${tx.to.toLowerCase()}`;
  if (getKey(cacheKey)) return;
  setKey(cacheKey, '1', 86400);

  const fresh = await isFreshWallet(tx.to, chain);
  if (!fresh) return;

  // Check if destination touches TC/Chainflip — escalate if so
  const isSuspiciousDest = TC_POOLS.has(tx.to.toLowerCase()) ||
    tx.to.toLowerCase() === CHAINFLIP_VAULT;

  sendAlert({
    chain,
    title: isSuspiciousDest
      ? `🚨 CRITICAL — Fresh Wallet → Suspicious Destination`
      : `🟠 HIGH — Large Send to Fresh Wallet`,
    alertId: `evm:fresh:${chain}:${tx.to}`,
    txHash: tx.hash,
    wallet: tx.to,
    walletLink: true,
    body: [
      `From: \`${shortAddr(tx.from)}\``,
      `To:   \`${shortAddr(tx.to)}\` 🆕 Fresh wallet`,
      `Amount: *${fmtUSD(usdValue)}*`,
      ``,
      `⚠️ Recipient has < ${FRESH_MAX_TXS} lifetime transactions`,
    ].join('\n'),
  });
}

// ── Main tx handler ──────────────────────────────────────────

async function handleTx(tx, chain) {
  try {
    // Global dedup — one tx processed once regardless of RPC duplicates
    const dedupKey = `tx:${tx.hash}`;
    if (getKey(dedupKey)) return;
    setKey(dedupKey, '1', 3600); // 1 hour

    if (!tx.value || tx.value === '0x0') return;

    const usdValue = await toUSD(BigInt(tx.value), 'ETH', 18);
    if (!usdValue || usdValue < 10_000) return;

    await Promise.all([
      checkDirectTCDeposit(tx, usdValue, chain),
      checkChainflip(tx, usdValue, chain),
      checkRapidAccumulation(tx, usdValue, chain),
      checkStructuring(tx, usdValue, chain),
      checkFlaggedWallet(tx, usdValue, chain),
      checkDormantWallet(tx, usdValue, chain),
      checkPeelChain(tx, usdValue, chain),
      checkFanOut(tx, usdValue, chain),
      checkFreshWalletLargeSend(tx, usdValue, chain),
    ]);

  } catch (err) {
    logger.error(`[EVM:${chain}] handleTx error`, { error: err.message });
  }
}

// ── WebSocket connector ──────────────────────────────────────

function isAlchemy(url) {
  return url?.includes('alchemy.com');
}

// Fetch full block with transactions
async function fetchBlock(blockHash, httpUrl) {
  try {
    const axios = require('axios');
    const { data } = await axios.post(httpUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'eth_getBlockByHash',
      params: [blockHash, true], // true = include full tx objects
    }, { timeout: 10_000 });
    return data?.result?.transactions || [];
  } catch {
    return [];
  }
}

// Fetch full tx by hash (for dRPC)
async function fetchTx(hash, wssUrl) {
  try {
    const httpUrl = wssUrl.replace('wss://', 'https://').replace('ws://', 'http://');
    const axios = require('axios');
    const { data } = await axios.post(httpUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'eth_getTransactionByHash',
      params: [hash],
    }, { timeout: 5000 });
    return data?.result || null;
  } catch {
    return null;
  }
}

function connectChain(primaryUrl, chain, fallbackUrl = null) {
  let ws;
  let reconnectDelay = 2000;
  let failCount      = 0;
  let usingFallback  = false;
  let lastMessageAt  = Date.now();

  function currentUrl() {
    return usingFallback && fallbackUrl ? fallbackUrl : primaryUrl;
  }

  function getHttpUrl(wssUrl) {
    return wssUrl.replace('wss://', 'https://').replace('ws://', 'http://');
  }

  function connect() {
    const url       = currentUrl();
    const label     = isAlchemy(url) ? 'Alchemy' : 'dRPC';
    const fallLabel = usingFallback ? ' [FALLBACK]' : '';
    const mode      = isAlchemy(url) ? 'confirmed blocks' : 'pending txs';
    logger.info(`[EVM:${chain}] Connecting... (${label} — ${mode}${fallLabel})`);

    ws = new WebSocket(url);

    ws.on('open', () => {
      reconnectDelay = 2000;
      failCount      = 0;
      lastMessageAt  = Date.now();
      logger.info(`[EVM:${chain}] Connected ✓ (${label}${fallLabel})`);

      if (isAlchemy(url)) {
        // Confirmed blocks mode — subscribe to new block headers
        // Each block every ~12 seconds, then fetch all txs in block
        // Uses ~100K CUs/day vs 2.6M for pending txs
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_subscribe',
          params: ['newHeads'],
        }));
      } else {
        // dRPC — pending tx hashes
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_subscribe',
          params: ['newPendingTransactions'],
        }));
      }
    });

    ws.on('message', (raw) => {
      lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw);
        if (!msg.params?.result) return;
        const result = msg.params.result;

        if (isAlchemy(currentUrl())) {
          // result is a block header — fetch all txs in this block
          if (result.hash) {
            const httpUrl = getHttpUrl(currentUrl());
            fetchBlock(result.hash, httpUrl).then(txs => {
              for (const tx of txs) {
                if (tx && tx.from && tx.hash) handleTx(tx, chain);
              }
            });
          }
        } else {
          // dRPC — result is a tx hash
          if (typeof result === 'string' && result.startsWith('0x')) {
            fetchTx(result, currentUrl()).then(tx => {
              if (tx && tx.from && tx.hash) handleTx(tx, chain);
            });
          }
        }
      } catch {}
    });

    ws.on('error', (err) => {
      logger.error(`[EVM:${chain}] Error`, { error: err.message });
    });

    ws.on('close', () => {
      failCount++;
      if (!usingFallback && fallbackUrl && failCount >= 3) {
        usingFallback = true;
        logger.warn(`[EVM:${chain}] Primary failed ${failCount}x — switching to fallback`);
        failCount = 0;
      } else if (usingFallback && failCount >= 3) {
        usingFallback = false;
        logger.warn(`[EVM:${chain}] Fallback failed — retrying primary`);
        failCount = 0;
      }

      logger.warn(`[EVM:${chain}] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    });
  }

  connect();

  // Heartbeat ping every 30s
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  // Stale socket detection — newHeads fires every ~12s so 3 min = clearly stale
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      if (Date.now() - lastMessageAt > 3 * 60 * 1000) {
        logger.warn(`[EVM:${chain}] Stale socket detected — forcing reconnect`);
        ws.terminate();
      }
    }
  }, 2 * 60 * 1000);
}

// ── Entry point ──────────────────────────────────────────────

function startEVMMonitor() {
  for (const { name, wssKey } of CHAIN_CONFIG) {
    const url = process.env[wssKey];
    if (!url || url.includes('YOUR_KEY')) {
      logger.warn(`[EVM:${name}] No WSS URL — skipping`);
      continue;
    }

    const fallback = name === 'ETH' ? process.env.ALCHEMY_ETH_FALLBACK : null;
    if (fallback) logger.info(`[EVM:${name}] Fallback configured: Alchemy`);

    connectChain(url, name, fallback);
  }
}

module.exports = { startEVMMonitor };
