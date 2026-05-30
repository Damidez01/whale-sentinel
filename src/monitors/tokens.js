const WebSocket = require('ws');
const { ethers }  = require('ethers');
const { setKey, getKey } = require('../utils/store');
const { sendAlert } = require('../alerts/telegram');
const { fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

// ERC20 Transfer event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Watched tokens
const WATCHED_TOKENS = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC',  decimals: 6  },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT',  decimals: 6  },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',   decimals: 18 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC',  decimals: 8  },
};

// Suspicious destinations — token transfers TO these = alert
const SUSPICIOUS_DESTINATIONS = new Set([
  '0xf5e10380213880111522dd0efd3dbb45b9f62bcc', // Chainflip vault
]);

const DEST_LABELS = {
  '0xf5e10380213880111522dd0efd3dbb45b9f62bcc': 'Chainflip Vault',
};

const MIN_USD = Number(process.env.TOKEN_SUSPICIOUS_MIN_USD || 10_000);

const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

function shortAddr(addr) {
  if (!addr) return '???';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function getTokenUSD(amount, token) {
  try {
    const axios = require('axios');
    const ids = { USDC: 'usd-coin', USDT: 'tether', DAI: 'dai', WBTC: 'wrapped-bitcoin' };
    const id  = ids[token.symbol];
    if (!id) return null;
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { timeout: 5000 }
    );
    const price = data[id]?.usd || 0;
    return (Number(amount) / Math.pow(10, token.decimals)) * price;
  } catch {
    // Stablecoins — just divide by decimals
    if (['USDC', 'USDT', 'DAI'].includes(token.symbol)) {
      return Number(amount) / Math.pow(10, token.decimals);
    }
    return null;
  }
}

async function handleTokenTransfer(log, token) {
  try {
    // Dedup
    const dedupKey = `tok:${log.transactionHash}:${log.logIndex}`;
    if (getKey(dedupKey)) return;
    setKey(dedupKey, '1', 3600);

    // Decode log
    const iface  = new ethers.Interface(ERC20_ABI);
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    if (!parsed) return;

    const to   = parsed.args.to?.toLowerCase();
    const from = parsed.args.from?.toLowerCase();

    // Only alert if destination is suspicious (TC pool or Chainflip)
    if (!SUSPICIOUS_DESTINATIONS.has(to)) return;

    const usdValue = await getTokenUSD(parsed.args.value, token);
    if (!usdValue || usdValue < MIN_USD) return;

    const destLabel = DEST_LABELS[to] || to;

    sendAlert({
      chain: 'ETH',
      title: `🟠 HIGH — ${token.symbol} Sent to Chainflip Vault`,
      alertId: `tok:suspicious:${log.transactionHash}`,
      txHash: log.transactionHash,
      wallet: from,
      walletLink: true,
      body: [
        `Token: *${token.symbol}*`,
        `From: \`${shortAddr(from)}\``,
        `To:   *${destLabel}*`,
        `Amount: *${fmtUSD(usdValue)}*`,
        ``,
        `⚠️ Token transfer to suspicious destination`,
      ].join('\n'),
    });

    logger.alert(`[Tokens] ${token.symbol} → ${destLabel} | ${fmtUSD(usdValue)} | from ${from?.slice(0,10)}`);

  } catch (err) {
    logger.error('[Tokens] handleTokenTransfer error', { error: err.message });
  }
}

function startTokenMonitor() {
  const wssUrl = process.env.ALCHEMY_ETH_WSS;
  if (!wssUrl || wssUrl.includes('YOUR_KEY')) {
    logger.warn('[Tokens] No ETH WSS — token monitor disabled');
    return;
  }

  const tokenAddresses = Object.keys(WATCHED_TOKENS);
  let ws;
  let reconnectDelay = 2000;
  let lastMessageAt  = Date.now();

  function connect() {
    logger.info('[Tokens] Connecting — watching USDC, USDT, DAI, WBTC transfers to Chainflip...');
    ws = new WebSocket(wssUrl);

    ws.on('open', () => {
      reconnectDelay = 2000;
      logger.info('[Tokens] Connected ✓');

      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_subscribe',
        params: ['logs', {
          address: tokenAddresses,
          topics: [TRANSFER_TOPIC],
        }],
      }));
    });

    ws.on('message', (raw) => {
      lastMessageAt = Date.now();
      try {
        const msg      = JSON.parse(raw);
        if (!msg.params?.result?.topics) return;
        const log      = msg.params.result;
        const tokenAddr = log.address?.toLowerCase();
        const token    = WATCHED_TOKENS[tokenAddr];
        if (!token) return;
        handleTokenTransfer(log, token);
      } catch {}
    });

    ws.on('error', (err) => {
      logger.error('[Tokens] WebSocket error', { error: err.message });
    });

    ws.on('close', () => {
      logger.warn(`[Tokens] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    });
  }

  connect();
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 3 * 60 * 1000) {
      logger.warn('[Tokens] Stale socket — forcing reconnect');
      ws.terminate();
    }
  }, 2 * 60 * 1000);
}

module.exports = { startTokenMonitor };
