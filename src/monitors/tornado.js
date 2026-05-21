const WebSocket = require('ws');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { sendAlert } = require('../alerts/telegram');
const { getPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

// ── Pool config ──────────────────────────────────────────────
const POOLS = {
  '0xa160cdab225685da1d56aa342ad8841c3b53f291': { name: '100 ETH Pool', size: 100 },
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf': { name: '10 ETH Pool',  size: 10  },
};

const DEPOSIT_TOPIC = '0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196';

// Thresholds
const BURST_COUNT      = Number(process.env.TC_BURST_COUNT            || 3);
const BURST_WIN_MIN    = Number(process.env.TC_BURST_WINDOW_MIN       || 15);
const INCIDENT_COUNT   = Number(process.env.TC_INCIDENT_COUNT         || 10);
const INCIDENT_WIN_MIN = Number(process.env.TC_INCIDENT_WINDOW_MIN    || 60);
const COORD_WIN_MIN    = Number(process.env.TC_COORDINATED_WINDOW_MIN || 10);

async function handleDeposit(log, poolAddr, pool) {
  try {
    const txHash   = log.transactionHash;
    const blockNum = parseInt(log.blockNumber, 16);

    // Dedup
    if (getKey(`tc:tx:${txHash}`)) return;
    setKey(`tc:tx:${txHash}`, '1', 3600);

    const ethPrice = await getPrice('ETH');

    // ── Coordinated detection (cross-wallet, same pool) ──
    const coordKey = `tc:pool:${poolAddr}:txs`;
    windowAdd(coordKey, txHash, COORD_WIN_MIN * 60);

    // ── Pool volume tracking ──
    const poolVolumeKey = `tc:pool:volume:${poolAddr}`;
    const totalInWindow = windowAdd(poolVolumeKey, { ts: Date.now(), txHash }, INCIDENT_WIN_MIN * 60);

    logger.alert(`[TC] Deposit → ${pool.name} | Block ${blockNum} | Total in ${INCIDENT_WIN_MIN}min: ${totalInWindow} | tx: ${txHash?.slice(0,10)}...`);

    // ── Burst alert (3 deposits in 15 min) ──
    if (totalInWindow === BURST_COUNT) {
      const totalETH = BURST_COUNT * pool.size;
      sendAlert({
        chain: 'ETH',
        title: `🟠 HIGH — TC ${pool.name} Burst`,
        alertId: `tc:burst:${poolAddr}:${totalInWindow}`,
        txHash,
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

    // ── Incident alert (10 deposits in 60 min) ──
    if (totalInWindow === INCIDENT_COUNT) {
      const totalETH = INCIDENT_COUNT * pool.size;
      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — TC ${pool.name} Incident`,
        alertId: `tc:incident:${poolAddr}:${totalInWindow}`,
        txHash,
        body: [
          `Pool: Tornado Cash ${pool.name}`,
          ``,
          `*${INCIDENT_COUNT} deposits* in ${INCIDENT_WIN_MIN} min`,
          `Total: *${totalETH} ETH (${fmtUSD(totalETH * (ethPrice || 0))})*`,
          ``,
          `🔴 Matches large-scale laundering pattern`,
        ].join('\n'),
      });
    }

    // ── Escalation every 5 after incident threshold ──
    if (totalInWindow > INCIDENT_COUNT && (totalInWindow - INCIDENT_COUNT) % 5 === 0) {
      const totalETH = totalInWindow * pool.size;
      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — TC ${pool.name} Escalating`,
        alertId: `tc:escalate:${poolAddr}:${totalInWindow}`,
        txHash,
        body: [
          `Pool: Tornado Cash ${pool.name}`,
          ``,
          `Now *${totalInWindow} deposits* in ${INCIDENT_WIN_MIN} min`,
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
    logger.warn('[TC] No Alchemy ETH WSS — Tornado Cash monitor disabled');
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
        const msg      = JSON.parse(raw);
        if (!msg.params?.result?.topics) return;
        const log      = msg.params.result;
        const poolAddr = log.address?.toLowerCase();
        const pool     = POOLS[poolAddr];
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
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
}

module.exports = { startTornadoMonitor };
