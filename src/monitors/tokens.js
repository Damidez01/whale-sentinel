const WebSocket = require('ws');
const { ethers }  = require('ethers');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { sendAlert } = require('../alerts/telegram');
const { getTokenPrice, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');

const axios = require('axios');

// ── Combined wallet activity check (ETH + token txns) ────────
async function isHighVolumeAddress(address) {
  const cacheKey = `walletage:${address.toLowerCase()}`;
  const cached   = getKey(cacheKey);
  if (cached !== null) return Number(cached) >= HIGH_VOLUME_THRESHOLD;

  if (!process.env.ETHERSCAN_API_KEY) return false;

  try {
    const apiKey = process.env.ETHERSCAN_API_KEY;
    const base   = 'https://api.etherscan.io/api';

    const [r1, r2, r3] = await Promise.all([
      axios.get(base, {
        params: { module: 'proxy', action: 'eth_getTransactionCount', address, tag: 'latest', apikey: apiKey },
        timeout: 5000,
      }),
      axios.get(base, {
        params: { module: 'account', action: 'txlist', address, page: 1, offset: 600, sort: 'desc', apikey: apiKey },
        timeout: 5000,
      }),
      axios.get(base, {
        params: { module: 'account', action: 'tokentx', address, page: 1, offset: 600, sort: 'desc', apikey: apiKey },
        timeout: 5000,
      }),
    ]);

    const nonce      = parseInt(r1.data?.result, 16) || 0;
    const ethCount   = r2.data?.result?.length || 0;
    const tokCount   = r3.data?.result?.length || 0;
    const total      = Math.max(nonce, ethCount, tokCount);

    setKey(cacheKey, total.toString(), 86400); // shared cache with evm.js
    return total >= HIGH_VOLUME_THRESHOLD;
  } catch {
    return false; // assume normal on error — better to alert than miss
  }
}

// ── ERC20 Transfer event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Watched tokens — address: { symbol, decimals, minUSD }
const WATCHED_TOKENS = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC',  decimals: 6,  minUSD: 100_000 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT',  decimals: 6,  minUSD: 100_000 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',   decimals: 18, minUSD: 100_000 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC',  decimals: 8,  minUSD: 100_000 },
};

const ACCUM_COUNT      = Number(process.env.ACCUM_COUNT      || 3);
const ACCUM_WIN_MIN    = Number(process.env.ACCUM_WIN_MIN    || 15);
const PEEL_MIN_LEGS    = Number(process.env.PEEL_MIN_LEGS    || 3);
const PEEL_WIN_MIN     = Number(process.env.PEEL_WIN_MIN     || 120);
const PEEL_MIN_USD     = Number(process.env.PEEL_MIN_USD     || 20_000);
const FANOUT_MIN_LEGS  = Number(process.env.FANOUT_MIN_LEGS  || 5);
const FANOUT_WIN_MIN   = Number(process.env.FANOUT_WIN_MIN   || 30);
const FANOUT_TOTAL_USD = Number(process.env.FANOUT_TOTAL_USD || 1_000_000);
const HIGH_VOLUME_THRESHOLD = Number(process.env.HIGH_VOLUME_THRESHOLD || 500);

// CEX receivers to suppress (same as evm.js)
const CEX_RECEIVERS = new Set([
  '0x28c6c06298d514db089934071355e5743bf21d60',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d',
  '0xf977814e90da44bfa03b6295a0616a897441acec',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b',
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13',
  '0xa1abfa21f80ecf401bd41365adbb6fef6fefdf09',
  '0xe401a6a38024d8f5ab88f1b08cad476ccaca45e8',
  '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621',
  '0x62425cd6bdcb6bfe51558ea465b063486b70dc9f',
  '0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511',
  '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', // Morpho Protocol
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3
  '0xc36442b4a4522e871399cd717abdd847ab11fe88', // Uniswap V3 Positions
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH Lido
]);

// Swap routers to suppress
const SWAP_ROUTERS = new Set([
  '0xe66b31678d6c16e9ebf358268a790b763c133750',
  '0xba3cb449bd2b4adddbc894d8697f5170800eadec',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  '0xba12222222228d8ba445958a75a0704d566bf2c8',
  '0x0000000000004444c5dc75cb358380d2e3de08a90', // Uniswap V4 Pool Manager
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap V2 Router 02
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router
  '0x555f240e556788e65306754a0ba6e7a76c2ab59e', // none
  '0x51c72848c68a965f66fa7a88855f9f7784502a7f', //wintermute
  '0x63242a4ea82847b20e506b63b0e2e2eff0cc6cb0', // kyber
  '0xbee3211ab312a8d065c4fef0247448e17a8da000', // MM
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // Uniswap usdc
  '0x1f2f10d1c40777ae1da742455c65828ff36df387', // jef
  '0x555f240e556788e65306754a0ba6e7a76c2ab59e', 
  '0x8f10b468b06c6fd214b65f87778827f7d113f996', // Kyber
  '0x37305b1cd40574e4c5ce33f8e8306be057fd7341', // Sky (MakerDAO)
  '0xb6807116b3b1b321a390594e31ecd6e0076f6278', // Swapswift
]);

function shortAddr(addr) {
  if (!addr) return '???';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

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

    const from   = parsed.args.from?.toLowerCase();
    const to     = parsed.args.to?.toLowerCase();
    const amount = parsed.args.value;

    // Skip swap routers and CEX
    if (SWAP_ROUTERS.has(from) || SWAP_ROUTERS.has(to)) return;
    if (CEX_RECEIVERS.has(to)) return;

    // Convert to USD
    const usdValue = (Number(amount) / Math.pow(10, token.decimals)) *
      (await getTokenPrice(token.symbol) || 1);

    if (usdValue < token.minUSD) return;

    // Layer 2: Dynamic suppression — runs on FIRST transfer seen from this wallet
    // Cached 24hrs — zero cost on subsequent transfers
    const firstSeenKey = `tokfirst:${to}`;
    const alreadyChecked = getKey(firstSeenKey);
    if (!alreadyChecked) {
      // First time we see this wallet — check immediately
      setKey(firstSeenKey, '1', 86400);
      if (await isHighVolumeAddress(to)) {
        setKey(`suppress:${to}`, '1', 86400);
        return;
      }
    } else if (getKey(`suppress:${to}`)) {
      return; // already flagged as high volume
    }

    // ── Per-token accumulation ──
    const accumKey = `tokaccum:${to}:${token.symbol}`;
    const count    = windowAdd(accumKey, usdValue, ACCUM_WIN_MIN * 60);

    if (count === ACCUM_COUNT) {
      const all      = windowGet(accumKey, ACCUM_WIN_MIN * 60);
      const totalUSD = all.reduce((s, v) => s + Number(v), 0);

      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — ${token.symbol} Rapid Accumulation`,
        alertId: `tok:accum:${to}:${token.symbol}`,
        txHash: log.transactionHash,
        wallet: to,
        walletLink: true,
        body: [
          `Token: *${token.symbol}*`,
          `Receiving wallet: \`${shortAddr(to)}\``,
          ``,
          `*${count} incoming transfers in ${ACCUM_WIN_MIN} min*`,
          `Total received: *${fmtUSD(totalUSD)}*`,
          `Each: ≥ ${fmtUSD(token.minUSD)}`,
          ``,
          `⚠️ Matches theft relay or phishing pattern`,
        ].join('\n'),
      });
    }

    if (count > ACCUM_COUNT && (count - ACCUM_COUNT) % 2 === 0) {
      const all      = windowGet(accumKey, ACCUM_WIN_MIN * 60);
      const totalUSD = all.reduce((s, v) => s + Number(v), 0);

      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — ${token.symbol} Accumulation Escalating`,
        alertId: `tok:accum:escalate:${to}:${token.symbol}:${count}`,
        txHash: log.transactionHash,
        wallet: to,
        walletLink: true,
        body: [
          `Token: *${token.symbol}*`,
          `Receiving wallet: \`${shortAddr(to)}\``,
          ``,
          `Now *${count} transfers* in ${ACCUM_WIN_MIN} min`,
          `Total: *${fmtUSD(totalUSD)}*`,
          ``,
          `🔴 Still actively receiving ${token.symbol}`,
        ].join('\n'),
      });
    }

    // ── Cross-token combined accumulation ──
    // Tracks total USD across ALL tokens for this wallet
    const combinedKey   = `tokaccum:combined:${to}`;
    const combinedCount = windowAdd(combinedKey, usdValue, ACCUM_WIN_MIN * 60);
    const combinedVals  = windowGet(combinedKey, ACCUM_WIN_MIN * 60);
    const combinedUSD   = combinedVals.reduce((s, v) => s + Number(v), 0);

    if (combinedCount === ACCUM_COUNT && count < ACCUM_COUNT) {
      // Only alert if per-token didn't already alert (avoid double alert)
      sendAlert({
        chain: 'ETH',
        title: `🚨 CRITICAL — Multi-Token Rapid Accumulation`,
        alertId: `tok:accum:combined:${to}`,
        txHash: log.transactionHash,
        wallet: to,
        walletLink: true,
        body: [
          `Receiving wallet: \`${shortAddr(to)}\``,
          ``,
          `*${combinedCount} token transfers in ${ACCUM_WIN_MIN} min*`,
          `Combined total: *${fmtUSD(combinedUSD)}*`,
          `Latest: ${fmtUSD(usdValue)} ${token.symbol}`,
          ``,
          `⚠️ Mixed token accumulation — USDC/USDT/DAI/WBTC combined`,
        ].join('\n'),
      });
    }


    // ── Peel chain detection ──
    if (usdValue >= PEEL_MIN_USD) {
      const peelKey     = `tokpeel:out:${from}:${token.symbol}`;
      windowAdd(peelKey, to, PEEL_WIN_MIN * 60);
      const dests       = windowGet(peelKey, PEEL_WIN_MIN * 60);
      const uniqueDests = new Set(dests).size;

      if (uniqueDests === PEEL_MIN_LEGS) {
        const totalKey = `tokpeel:val:${from}:${token.symbol}`;
        const allVals  = windowGet(totalKey, PEEL_WIN_MIN * 60);
        const totalUSD = allVals.reduce((s, v) => s + Number(v), 0) || usdValue * uniqueDests;

        sendAlert({
          chain: 'ETH',
          title: '🚨 CRITICAL — Peel Chain Detected',
          alertId: `tok:peel:${from}:${token.symbol}:${uniqueDests}`,
          txHash: log.transactionHash,
          wallet: from,
          walletLink: true,
          body: [
            `Token: *${token.symbol}*`,
            `Source wallet: \`${shortAddr(from)}\``,
            ``,
            `Distributing to *${uniqueDests} different wallets*`,
            `within ${PEEL_WIN_MIN} min`,
            `Total distributed: *${fmtUSD(totalUSD)}*`,
            ``,
            `🔴 Classic peel chain — layering stolen ${token.symbol}`,
          ].join('\n'),
        });
      }

      windowAdd(`tokpeel:val:${from}:${token.symbol}`, usdValue, PEEL_WIN_MIN * 60);
    }

    // ── Fan-out detection ──
    if (usdValue >= PEEL_MIN_USD) {
      const fanKey      = `tokfan:${from}:${token.symbol}`;
      windowAdd(fanKey, to, FANOUT_WIN_MIN * 60);
      const fanDests    = windowGet(fanKey, FANOUT_WIN_MIN * 60);
      const uniqueFan   = new Set(fanDests).size;

      if (uniqueFan === FANOUT_MIN_LEGS) {
        const valKey   = `tokfan:val:${from}:${token.symbol}`;
        windowAdd(valKey, usdValue, FANOUT_WIN_MIN * 60);
        const allVals  = windowGet(valKey, FANOUT_WIN_MIN * 60);
        const totalUSD = allVals.reduce((s, v) => s + Number(v), 0);

        if (totalUSD >= FANOUT_TOTAL_USD) {
          sendAlert({
            chain: 'ETH',
            title: '🚨 CRITICAL — Fund Distribution Pattern',
            alertId: `tok:fanout:${from}:${token.symbol}:${uniqueFan}`,
            txHash: log.transactionHash,
            wallet: from,
            walletLink: true,
            body: [
              `Token: *${token.symbol}*`,
              `Source wallet: \`${shortAddr(from)}\``,
              ``,
              `Sent to *${uniqueFan} different wallets*`,
              `in ${FANOUT_WIN_MIN} min`,
              `Total distributed: *${fmtUSD(totalUSD)}*`,
              `Each: ~${fmtUSD(totalUSD / uniqueFan)}`,
              ``,
              `⚠️ Large ${token.symbol} distribution — possible layering`,
            ].join('\n'),
          });
        }
      }

      windowAdd(`tokfan:val:${from}:${token.symbol}`, usdValue, FANOUT_WIN_MIN * 60);
    }

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
    logger.info('[Tokens] Connecting — watching USDC, USDT, DAI, WBTC transfers...');
    ws = new WebSocket(wssUrl);

    ws.on('open', () => {
      reconnectDelay = 2000;
      logger.info('[Tokens] Connected ✓');

      // Subscribe to Transfer events for all watched tokens
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
        const msg = JSON.parse(raw);
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
    if (ws?.readyState === WebSocket.OPEN) {
      if (Date.now() - lastMessageAt > 3 * 60 * 1000) {
        logger.warn('[Tokens] Stale socket — forcing reconnect');
        ws.terminate();
      }
    }
  }, 2 * 60 * 1000);
}

module.exports = { startTokenMonitor };
