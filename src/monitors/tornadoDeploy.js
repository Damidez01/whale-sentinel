/**
 * tornadoDeploy.js
 *
 * Watches Tornado Cash withdrawal events on ETH mainnet, then monitors the
 * recipient address (+ 1 hop on ETH only) for contract deployments on
 * ETH, BASE, and ARB within a 24h window.
 *
 * Cross-chain coverage:
 *   TC withdrawals happen on ETH. The recipient may bridge to Base/Arb and
 *   deploy there. Since the address is the same across EVM chains, the
 *   watchedWithdrawals map is checked by all three chain handlers in evm.js.
 *   Hop tracking (where address A transfers to address B) only applies on ETH —
 *   we can't reliably follow bridge outputs to different L2 addresses.
 *
 * CU cost:
 *   eth_getTransactionReceipt is only called when tx.from is already in
 *   watchedWithdrawals. In normal operation this is near-zero cost.
 *
 * Risk scoring (0–100):
 *   +20  TC withdrawal origin
 *   +20  Fresh wallet (never seen in our store before withdrawal)
 *   +30  Contract deployment
 *   +15  Deployed within 6h of withdrawal
 *   +15  Contract emits ERC-20 Transfer (confirmed token)
 */

const WebSocket = require('ws');
const { setKey, getKey } = require('../utils/store');
const { sendAlert } = require('../alerts/telegram');
const { getPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

// ── TC pool config ───────────────────────────────────────────
const TC_POOLS = {
  '0xa160cdab225685da1d56aa342ad8841c3b53f291': '100 ETH',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf': '10 ETH',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936': '1 ETH',
  '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc': '0.1 ETH',
};

// Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)
const WITHDRAWAL_TOPIC = '0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931';

// ── Config ───────────────────────────────────────────────────
const WATCH_WINDOW_MS = Number(process.env.TC_DEPLOY_WATCH_MS  || 24 * 3600 * 1000); // 24h
const FRESH_WALLET_MIN = Number(process.env.TC_FRESH_WALLET_MIN || 60);               // minutes
const FAST_DEPLOY_HRS  = Number(process.env.TC_FAST_DEPLOY_HRS  || 6);

// ── State ────────────────────────────────────────────────────
// addr (lowercase) -> { pool, withdrawnAt, fresh, hop, ethPrice }
const watchedWithdrawals = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [addr, entry] of watchedWithdrawals) {
    if (now - entry.withdrawnAt > WATCH_WINDOW_MS) watchedWithdrawals.delete(addr);
  }
}, 10 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '?';
}

function isFreshWallet(addr) {
  const key  = `tcd:seen:${addr.toLowerCase()}`;
  const seen = getKey(key);
  if (!seen) return true;
  return (Date.now() - Number(seen)) / 60_000 <= FRESH_WALLET_MIN;
}

function markSeen(addr) {
  const key = `tcd:seen:${addr.toLowerCase()}`;
  if (!getKey(key)) setKey(key, Date.now().toString(), 86400 * 7);
}

// ── Scoring ──────────────────────────────────────────────────

function buildScore(entry, deployedAt, isToken) {
  let score = 20;                                                         // TC withdrawal
  if (entry.fresh) score += 20;                                          // fresh wallet
  score += 30;                                                            // contract deployment
  if ((deployedAt - entry.withdrawnAt) < FAST_DEPLOY_HRS * 3_600_000) score += 15; // fast deploy
  if (isToken) score += 15;                                              // ERC-20 token
  return score;
}

function scoreToSeverity(score, hop) {
  if (hop === 0) return score >= 70 ? '🚨 CRITICAL' : '🟠 HIGH';
  if (hop === 1) return score >= 70 ? '🟠 HIGH'     : '🟡 MEDIUM';
  return '🔵 INFO';
}

// ── Contract deployment handler ──────────────────────────────

async function onContractDeployed(deployerAddr, contractAddr, txHash, entry, chain) {
  const deployedAt = Date.now();
  const score      = buildScore(entry, deployedAt, false);
  const sev        = scoreToSeverity(score, entry.hop);
  const minsAgo    = ((deployedAt - entry.withdrawnAt) / 60_000).toFixed(0);
  const hopLabel   = entry.hop === 0 ? 'Direct' : `Hop-${entry.hop}`;
  const chainLabel = chain !== 'ETH' ? ` (on ${chain})` : '';

  const dedupKey = `tcd:alert:${deployerAddr}:${contractAddr}`;
  if (getKey(dedupKey)) return;
  setKey(dedupKey, '1', 86400 * 7);

  logger.alert(`[TC-DEPLOY] ${sev} — ${deployerAddr} deployed ${contractAddr} on ${chain} (score ${score})`);

  sendAlert({
    chain,
    title: `${sev} — TC Withdrawal → Contract Deploy${chainLabel}`,
    alertId: dedupKey,
    txHash,
    wallet: deployerAddr,
    walletLink: true,
    body: [
      `🌪️ *Tornado Cash* → Contract Deployment`,
      ``,
      `TC Pool:            ${entry.pool}`,
      `Withdrawn:          ${minsAgo}m ago (ETH mainnet)`,
      `Deployer (${hopLabel}): \`${shortAddr(deployerAddr)}\``,
      `Contract:           \`${shortAddr(contractAddr)}\``,
      chain !== 'ETH' ? `Chain: *${chain}* (bridged after withdrawal)` : null,
      ``,
      `Risk Score: *${score}/100*`,
      `  +20 TC withdrawal origin`,
      `  ${entry.fresh ? '+20' : '+0 '} Fresh wallet`,
      `  +30 Contract deployment`,
      `  ${(deployedAt - entry.withdrawnAt) < FAST_DEPLOY_HRS * 3_600_000 ? '+15' : '+0 '} Within ${FAST_DEPLOY_HRS}h`,
      `  +0  Token contract (pending)`,
      ``,
      `🔴 Matches pre-exploit deployer pattern`,
    ].filter(l => l !== null).join('\n'),
  });

  // Watch deployed contract for ERC-20 Transfer confirmation (ETH only)
  if (chain === 'ETH') {
    const tokenWatchKey = `tcd:token_watch:${contractAddr}`;
    setKey(tokenWatchKey, JSON.stringify({
      deployerAddr, txHash, entry, baseScore: score, dedupKey,
    }), 1800); // 30 min window
  }
}

// ── Called by evm.js when a tx.to contract emits any call ───
// Checks if this contract is pending ERC-20 token confirmation

function confirmTokenContract(contractAddr) {
  const tokenWatchKey = `tcd:token_watch:${contractAddr}`;
  const raw = getKey(tokenWatchKey);
  if (!raw) return;
  try {
    const { deployerAddr, txHash, entry, baseScore, dedupKey } = JSON.parse(raw);
    const newScore = baseScore + 15;
    const sev      = scoreToSeverity(newScore, entry.hop);
    const hopLabel = entry.hop === 0 ? 'Direct' : `Hop-${entry.hop}`;

    sendAlert({
      chain: 'ETH',
      title: `${sev} — TC Deploy: ERC-20 Token Confirmed`,
      alertId: `${dedupKey}:token`,
      txHash,
      wallet: deployerAddr,
      walletLink: true,
      body: [
        `✅ Deployed contract is an *ERC-20 token*`,
        ``,
        `Deployer (${hopLabel}): \`${shortAddr(deployerAddr)}\``,
        `Contract: \`${shortAddr(contractAddr)}\``,
        ``,
        `Updated Risk Score: *${newScore}/100*`,
        ``,
        `⚠️ Token deployed post-TC withdrawal — typical rug/exploit setup`,
      ].join('\n'),
    });

    setKey(tokenWatchKey, '', 1); // clear so it doesn't re-fire
  } catch {}
}

// ── Called by evm.js for every non-deployment tx on ETH only ─
// If a watched withdrawal address sends to another wallet, track the
// destination as a hop-1 watched address. ETH only — we can't follow
// bridge outputs to different L2 addresses reliably.

function checkHopTransfer(tx) {
  if (!tx?.from || !tx?.to) return;
  const fromLower = tx.from.toLowerCase();
  const toLower   = tx.to.toLowerCase();

  const entry = watchedWithdrawals.get(fromLower);
  if (!entry || entry.hop !== 0) return; // only propagate one hop

  if (watchedWithdrawals.has(toLower)) return; // already tracking

  markSeen(toLower);
  watchedWithdrawals.set(toLower, {
    ...entry,
    hop:   1,
    fresh: isFreshWallet(toLower),
  });

  logger.info(`[TC-DEPLOY] Hop-1 watch: ${shortAddr(toLower)} (from ${shortAddr(fromLower)})`);
}

// ── Called by evm.js for every contract creation tx ─────────
// tx.to is null, receipt.contractAddress is set
// chain can be ETH, BASE, or ARB

async function checkDeployment(tx, receipt, chain) {
  if (!tx?.from || !receipt) return;
  if (tx.to !== null && tx.to !== undefined) return;

  const deployerAddr = tx.from.toLowerCase();
  const contractAddr = receipt.contractAddress?.toLowerCase();
  if (!contractAddr) return;

  const entry = watchedWithdrawals.get(deployerAddr);
  if (!entry) return;

  await onContractDeployed(deployerAddr, contractAddr, tx.hash, entry, chain);
  watchedWithdrawals.delete(deployerAddr);
}

// ── Withdrawal event listener (ETH mainnet) ──────────────────

async function handleWithdrawalLog(log) {
  try {
    const txHash   = log.transactionHash;
    const poolAddr = log.address?.toLowerCase();
    const poolSize = TC_POOLS[poolAddr];
    if (!poolSize) return;

    if (getKey(`tcd:tx:${txHash}`)) return;
    setKey(`tcd:tx:${txHash}`, '1', 3600);

    // Decode recipient — topics[1] is padded address
    const recipientRaw = log.topics?.[1];
    if (!recipientRaw) return;
    const recipient = '0x' + recipientRaw.slice(26).toLowerCase();

    markSeen(recipient);

    const ethPrice = await getPrice('ETH');
    const fresh    = isFreshWallet(recipient);

    logger.info(`[TC-DEPLOY] Watching ${shortAddr(recipient)} — ${poolSize} Pool (fresh=${fresh})`);

    watchedWithdrawals.set(recipient, {
      pool:        `${poolSize} Pool`,
      withdrawnAt: Date.now(),
      fresh,
      hop:         0,
      ethPrice,
    });

  } catch (err) {
    logger.error('[TC-DEPLOY] handleWithdrawalLog error', { error: err.message });
  }
}

// ── WebSocket — subscribes to TC Withdrawal events on ETH ────

function startTornadoDeployMonitor() {
  const wssUrl = process.env.ALCHEMY_ETH_WSS;
  if (!wssUrl || wssUrl.includes('YOUR_KEY')) {
    logger.warn('[TC-DEPLOY] No Alchemy ETH WSS — disabled');
    return;
  }

  const poolAddresses = Object.keys(TC_POOLS);
  let ws;
  let reconnectDelay = 2000;

  function connect() {
    logger.info('[TC-DEPLOY] Connecting — watching TC withdrawal events (0.1/1/10/100 ETH pools)');
    ws = new WebSocket(wssUrl);

    ws.on('open', () => {
      reconnectDelay = 2000;
      logger.info('[TC-DEPLOY] Connected ✓');
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_subscribe',
        params: ['logs', {
          address: poolAddresses,
          topics: [WITHDRAWAL_TOPIC],
        }],
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg.params?.result?.topics) return;
        handleWithdrawalLog(msg.params.result);
      } catch {}
    });

    ws.on('error', (err) => {
      logger.error('[TC-DEPLOY] WebSocket error', { error: err.message });
    });

    ws.on('close', () => {
      logger.warn(`[TC-DEPLOY] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    });
  }

  connect();
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
}

module.exports = {
  startTornadoDeployMonitor,
  checkDeployment,
  confirmTokenContract,
  checkHopTransfer,
  getWatchedWithdrawals: () => watchedWithdrawals,
};
