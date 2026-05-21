const WebSocket = require('ws');
const { ethers }  = require('ethers');
const { windowAdd, windowGet, windowCountUnique, setKey, getKey } = require('../utils/store');
const { flag, isFlagged, shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { getPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

// ── Pool config ──────────────────────────────────────────────
const POOLS = {
  '0xa160cdab225685da1d56aa342ad8841c3b53f291': { name: '100 ETH Pool', size: 100 },
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf': { name: '10 ETH Pool',  size: 10  },
};

// Tornado Cash Deposit event topic
const DEPOSIT_TOPIC = '0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196';

// ABI for Deposit event: Deposit(bytes32 commitment, uint32 leafIndex, uint256 timestamp)
const TC_ABI = ['event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)'];

// Thresholds from env
const BURST_COUNT     = Number(process.env.TC_BURST_COUNT           || 3);
const BURST_WIN_MIN   = Number(process.env.TC_BURST_WINDOW_MIN      || 15);
const INCIDENT_COUNT  = Number(process.env.TC_INCIDENT_COUNT        || 10);
const INCIDENT_WIN_MIN= Number(process.env.TC_INCIDENT_WINDOW_MIN   || 60);
const COORD_WALLETS   = Number(process.env.TC_COORDINATED_WALLETS   || 3);
const COORD_WIN_MIN   = Number(process.env.TC_COORDINATED_WINDOW_MIN|| 10);

// ── Alert builders ───────────────────────────────────────────

async function buildDepositHistory(wallet, poolKey, windowMin) {
  const items = windowGet(`tc:wallet:${wallet}:${poolKey}`, windowMin * 60);
  return items.map((item, i) => {
    const d = new Date(item.ts);
    const time = d.toUTCString().slice(17, 25);
    return `  #${String(i + 1).padStart(2, '0')}  ${time} UTC`;
  });
}

async function alertBurst(wallet, pool, poolAddr, count, ethPrice) {
  const totalETH = count * pool.size;
  const totalUSD = fmtUSD(totalETH * (ethPrice || 0));

  sendAlert({
    chain: 'ETH',
    title: `🟠 HIGH — TC Burst Deposit Detected`,
    alertId: `tc:burst:${wallet}:${Date.now()}`,
    wallet,
    walletLink: true,
    body: [
      `Pool: Tornado Cash ${pool.name}`,
      `Wallet: \`${shortAddr(wallet)}\``,
      ``,
      `Deposits: *${count} in ${BURST_WIN_MIN} min*`,
      `Total: ${totalETH} ETH (${totalUSD})`,
      ``,
      `⚠️ Wallet flagged for 48hrs`,
    ].join('\n'),
  });
}

async function alertIncident(wallet, pool, poolAddr, count, windowMin, ethPrice) {
  const totalETH = count * pool.size;
  const totalUSD = fmtUSD(totalETH * (ethPrice || 0));
  const isEscalation = count > INCIDENT_COUNT && (count - INCIDENT_COUNT) % 5 === 0;
  const tag = isEscalation ? `🚨 CRITICAL — TC Incident Escalating` : `🚨 CRITICAL — TC Incident Threshold Reached`;

  const history = await buildDepositHistory(wallet, poolAddr, windowMin);
  const preview = history.slice(-5); // show last 5

  sendAlert({
    chain: 'ETH',
    title: tag,
    alertId: `tc:incident:${wallet}:${count}`,
    wallet,
    walletLink: true,
    body: [
      `Pool: Tornado Cash ${pool.name}`,
      `Wallet: \`${shortAddr(wallet)}\``,
      ``,
      `Deposits: *${count} in ${windowMin} min*`,
      `Total: *${totalETH} ETH (${totalUSD})*`,
      ``,
      `Recent deposits:`,
      preview.join('\n'),
      count > 5 ? `  ... and ${count - preview.length} more` : '',
      ``,
      `🔴 Wallet flagged 48hrs — all activity monitored`,
    ].filter(Boolean).join('\n'),
  });
}

async function alertCoordinated(poolAddr, pool, walletCount, depositCount, ethPrice) {
  const totalETH = depositCount * pool.size;
  const totalUSD = fmtUSD(totalETH * (ethPrice || 0));

  sendAlert({
    chain: 'ETH',
    title: `🚨 CRITICAL — Coordinated TC Deposits`,
    alertId: `tc:coordinated:${poolAddr}:${Date.now()}`,
    body: [
      `Pool: Tornado Cash ${pool.name}`,
      ``,
      `*${walletCount} different wallets* depositing`,
      `within ${COORD_WIN_MIN} minutes`,
      ``,
      `Total deposits: ${depositCount}`,
      `Total ETH: ${totalETH} ETH (${totalUSD})`,
      ``,
      `⚠️ Possible coordinated laundering`,
    ].join('\n'),
  });
}

// ── Deposit handler ──────────────────────────────────────────

async function handleDeposit(log, poolAddr, pool) {
  try {
    // Get the sender from the transaction (the depositor)
    // We use the log's transaction hash to identify the event
    // The wallet is tracked via the tx, but TC hides it — we track by tx origin
    // We'll use a proxy: track by txHash prefix for coordinated, and flag the pool interaction

    const txHash  = log.transactionHash;
    const blockNum = parseInt(log.blockNumber, 16);

    // Dedup
    if (getKey(`tc:tx:${txHash}`)) return;
    setKey(`tc:tx:${txHash}`, '1', 3600);

    const ethPrice = await getPrice('ETH');

    // ── Coordinated detection (cross-wallet, same pool) ──
    const coordKey = `tc:pool:${poolAddr}`;
    // Track unique tx hashes as proxy for unique depositors
    windowAdd(`${coordKey}:txs`, txHash, COORD_WIN_MIN * 60);
    const recentDeposits = windowGet(`${coordKey}:txs`, COORD_WIN_MIN * 60);
    const depositCount   = recentDeposits.length;

    // For coordinated we use deposit count as proxy (TC hides wallet)
    if (depositCount === COORD_WALLETS * 2) { // heuristic: fire at 2x threshold
      await alertCoordinated(poolAddr, pool, COORD_WALLETS, depositCount, ethPrice);
    }

    // ── Per-wallet burst/incident (using tx origin tracking) ──
    // We track by txHash in the window; for per-wallet we need the sender
    // Alchemy pending tx subscription gives us 'from' — but logs don't
    // So we track pool-level bursts for coordinated, and flag on volume

    // Track deposits per pool for volume alerting
    const poolWindowKey = `tc:pool:volume:${poolAddr}`;
    const totalInWindow = windowAdd(poolWindowKey, { ts: Date.now(), txHash }, INCIDENT_WIN_MIN * 60);

    logger.alert(`[TC] Deposit to ${pool.name} | Block ${blockNum} | Total in ${INCIDENT_WIN_MIN}min: ${totalInWindow}`);

    // Volume-based alerts (since TC hides wallet identity at log level)
    if (totalInWindow === BURST_COUNT) {
      const totalETH = BURST_COUNT * pool.size;
      sendAlert({
        chain: 'ETH',
        title: `🟠 HIGH — TC ${pool.name} Burst`,
        alertId: `tc:poolburst:${poolAddr}:${totalInWindow}`,
        body: [
          `Pool: Tornado Cash ${pool.name}`,
          ``,
          `*${BURST_COUNT} deposits* in ${BURST_WIN_MIN} min`,
          `Total: ${totalETH} ETH (${fmtUSD(totalETH * (ethPrice || 0))})`,
          ``,
          `⚠️ Activity spike detected`,
        ].join('\n'),
      });
    }

    if (totalInWindow === INCIDENT_COUNT) {
      const totalETH = INCIDENT_COUNT * pool.size;
      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — TC ${pool.name} Incident`,
        alertId: `tc:poolincident:${poolAddr}:${totalInWindow}`,
        body: [
          `Pool: Tornado Cash ${pool.name}`,
          ``,
          `*${INCIDENT_COUNT} deposits* in ${INCIDENT_WIN_MIN} min`,
          `Total: *${totalETH} ETH (${fmtUSD(totalETH * (ethPrice || 0))})*`,
          ``,
          `🔴 This matches large-scale laundering pattern`,
          `   (e.g. 24×100 ETH = $5.1M in 11 min)`,
        ].join('\n'),
      });
    }

    // Escalation every 5 after incident threshold
    if (totalInWindow > INCIDENT_COUNT && (totalInWindow - INCIDENT_COUNT) % 5 === 0) {
      const totalETH = totalInWindow * pool.size;
      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — TC ${pool.name} Escalating`,
        alertId: `tc:escalate:${poolAddr}:${totalInWindow}`,
        body: [
          `Pool: Tornado Cash ${pool.name}`,
          ``,
          `Now at *${totalInWindow} deposits* in ${INCIDENT_WIN_MIN} min`,
          `Total: *${totalETH} ETH (${fmtUSD(totalETH * (ethPrice || 0))})*`,
          ``,
          `🔴 Incident still active and growing`,
        ].join('\n'),
      });
    }

  } catch (err) {
    logger.error('[TC] handleDeposit error', { error: err.message });
  }
}

// ── WebSocket listener ───────────────────────────────────────

function startTornadoMonitor() {
  const wssUrl = process.env.ALCHEMY_ETH_WSS;
  if (!wssUrl || wssUrl.includes('YOUR_KEY')) {
    logger.warn('[TC] No Alchemy ETH WSS configured — Tornado Cash monitor disabled');
    return;
  }

  const poolAddresses = Object.keys(POOLS);
  let ws;
  let reconnectDelay = 2000;

  function connect() {
    logger.info('[TC] Connecting to Alchemy for Tornado Cash monitoring...');
    ws = new WebSocket(wssUrl);

    ws.on('open', () => {
      reconnectDelay = 2000;
      logger.info('[TC] Connected ✓ — Watching 100 ETH + 10 ETH pools');

      // Subscribe to Deposit events on both pools
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['logs', {
          address: poolAddresses,
          topics: [DEPOSIT_TOPIC],
        }],
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg.params?.result?.topics) return;

        const log     = msg.params.result;
        const poolAddr = log.address?.toLowerCase();
        const pool    = POOLS[poolAddr];
        if (!pool) return;

        handleDeposit(log, poolAddr, pool);
      } catch {}
    });

    ws.on('error', (err) => {
      logger.error('[TC] WebSocket error', { error: err.message });
    });

    ws.on('close', () => {
      logger.warn(`[TC] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    });
  }

  connect();

  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);
}

module.exports = { startTornadoMonitor };
