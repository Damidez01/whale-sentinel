const WebSocket = require('ws');
const { windowAdd, windowGet, setKey, getKey } = require('../utils/store');
const { flag, flagHop, isFlagged, shortAddr } = require('../intelligence/flagged');
const { sendAlert } = require('../alerts/telegram');
const { toUSD, fmtUSD } = require('../utils/prices');
const logger = require('../utils/logger');
const { checkDeployment, confirmTokenContract, checkHopTransfer } = require('./tornadoDeploy');

// ── Thresholds ───────────────────────────────────────────────
const STRUCT_COUNT      = Number(process.env.STRUCTURING_COUNT         || 5);
const STRUCT_WIN_MIN    = Number(process.env.STRUCTURING_WINDOW_MIN    || 10);
const STRUCT_USD        = Number(process.env.STRUCTURING_THRESHOLD_USD || 900_000);
const DORMANT_MONTHS    = Number(process.env.DORMANT_MONTHS            || 6);
const DORMANT_USD       = Number(process.env.DORMANT_MIN_USD           || 500_000);
const ACCUM_MIN_USD     = Number(process.env.ACCUM_MIN_USD             || 100_000);
const ACCUM_COUNT       = Number(process.env.ACCUM_COUNT               || 3);
const ACCUM_WIN_MIN     = Number(process.env.ACCUM_WIN_MIN             || 15);
const CHAINFLIP_MIN_USD = Number(process.env.CHAINFLIP_MIN_USD         || 500_000);
const FANOUT_LEG_USD    = Number(process.env.FANOUT_LEG_USD            || 10_000);
const FANOUT_MIN_LEGS   = Number(process.env.FANOUT_MIN_LEGS           || 3);
const FANOUT_WIN_MIN    = Number(process.env.FANOUT_WIN_MIN            || 15);

// ── CEX hot wallets — suppress fan-out and accumulation for these ────────────
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
  '0x2364ab81b114b6bfbf39514a7d0396ce0e0ddff1', // BitKan Deposit
  '0xbea9f7fd27f4ee20066f18def0bc586ec221055a', // Hyperunit
  '0x2a45907f94df93388801ae72fe810eac75926a1d', // Bitpoint
  '0x835033bd90b943fa0d0f8e5382d9dc568d3fbd96', // Bitflyer
  '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', // Across Protocol
  '0xeae7380dd4cef6fbd1144f49e4d1e6964258a4f4', // Wintermute
  '0x2c0ec52e11eee4b8f6c391bad9ceb76e73a7a2c9', // Coinbase Deposit
  '0xf35eaa2f01cdbc11c5181751528970f95bfea253', // Binance Deposit
  '0xe7f1c19c6535b42351561b8fa4c8b43098952cf1', // Kraken Deposit
  '0x7b1c50a4ce324f19cf674f41d5b1c4deff2e0612', // HTX Deposit
  '0xa03400e098f4421b34a3a44a1b4e571419517687', // HTX Hotwallet
  '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', // Morpho Protocol
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3
  '0xc36442b4a4522e871399cd717abdd847ab11fe88', // Uniswap V3 Positions
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH Lido
  '0x00000000219ab540356cbb839cbe05303d7705fa', // Beacon
  '0xb6807116b3b1b321a390594e31ecd6e0076f6278', // Swapswift
  '0x1601843c5e9bc251a3272907010afa41fa18347e',
  '0x00dad40510a882b634c06bc46b4d62b7aa136cd9',
  '0xc9f5296eb3ac266c94568d790b6e91eba7d76a11', // CEXIO
  '0x88dcdd4a0a58b7e2208805d547043c37dca2b6dc', // Shakepay
  '0xa397a8c2086c554b531c02e29f3291c9704b00c7', // Compound
  '0x51c72848c68a965f66fa7a88855f9f7784502a7f', // Wintermute
  '0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23', // Bitget
  '0x0427e84d26df80c64b180ee8217f7e962a03ec93', // Chainflip Deposit
  '0xcffad3200574698b78f32232aa9d63eabd290703', // Crypto.com
  '0xc7bf35c9a3bdd1b1c19a6963de669cb45191a019', // Coinbase
  '0x17e5545b11b468072283cee1f066a059fb0dbf24', // Bithumb
  '0x0084dfd7202e5f5c0c8be83503a492837ca3e95e', // Bithumb Deposit
  '0xa294cca691e4c83b1fc0c8d63d9a3eef0a196de1', // Akuna
  '0x4331c786523879efb265f89db57f27cb83f592d7', // Crypto.com
  '0xb028b84783a0381d51dcf0e8ef04b5e502958618', // Bithumb
  '0xe02cff66139fdbf60a7e05f7ce82ca657540ad6f', // Coinbase Deposit
  '0xec9fc235a8064698a2533c2d489deff4fba8226b', // Amber
  '0x3e3a45a28e6f661776ebcd754eda1557c09f2858',
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35', // Base Bridge
  '0x0e58e8993100f1cbe45376c410f97f4893d9bfcd', // Upbit
  '0x49048044d57e1c92a77f79988d21fa8faf74e97e', // Base Bridge
  '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca', // Uniswap Router
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe', // Gate
  '0x963737c550e70ffe4d59464542a28604edb2ef9a', // Union
  '0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec', // Bithumb
  '0xf8191d98ae98d2f7abdfb63a9b0b812b93c873aa', // Wintermute
  '0xaf549e4b88b031f18f814a94188ea5dcea04e1ce', // Upbit
  '0x83e3e8c045db446203d967e092172da7185e4bd8', // Longling Capital
  '0xba827d29682df16c6c66ab8b56747d1ad237071c', // Bitfinex Deposit
  '0x555ce236c0220695b68341bc48c68d52210cc35b', // Debridge
  '0x0b2fdf416cf2951499de9a1adac65c8e9907c8c2', // Binance Deposit
  '0x2ef53f8826b4145c98f564586d2ae67b17cb5b97', // Upbit Deposit
  '0xd59d7a9698eff3e68e0af7e803d4ed35e7ed12d2', // Bullish
  '0x95ae79a2a8e49cf86ffebae0df694d8bb7c1ab80', // Hyperunit
  '0xd2674da94285660c9b2353131bef2d8211369a4b', // Bitvano
  '0x843d042c9c158e58fb5a88bcc0ffbc24f8ecf2f2', // Bitfinex
  '0x77f7b398a23ef4cab31dd5503fd8446c4480c70b', // Wintermute
  '0x44117b76535fcf450a425356f8de620ac8856074',
  '0xbee47b0fe59286778c9bfb28196368e0f0d7beee',
  '0x46340b20830761efd32832a74d7169b29feb9758', // Crypto.com
  '0x85ffcc959bd380c43a49bfd518ec141ccc1b7c35', // Bitget
  '0x45300136662dd4e58fc0df61e6290dffd992b785', // KuCoin
  '0xf78b2eda7c1e20ff9906b31fe3612195bce9d6ce', // HiFi Swap
  '0xa29e963992597b21bcdcaa969d571984869c4ff5', // B2C Group
  '0x1157a2076b9bb22a85cc2c162f20fab3898f4101', // FalconX
  '0xf8b2c637a68cf6a17b1df9f8992eebeff63d2dff', // Dolomite
  '0xe67821b76985007b4cf744b0f045c8933b3e91d9', // Binance Deposit
  '0x56eddb7aa87536c09ccc2793473599fd21a8b17f', // Binance
  '0x7c876bdaa5c038e19f633714f622f6def949b102', // Coinbase Prime
  '0x6687ace34a4d3ef7ee73b06b7b3678187fc25a4c', // Bridgers
  '0x4976a4a02f38326660d17bf34b431dc6e2eb2327', // Binance Hot Wallet
  '0xe01fd113494f36805618fb3c7bb930e4a8e70f60', // OKX Deposit
  '0x974caa59e49682cda0ad2bbe82983419a2ecc400', // Stake
  '0x9c19b0497997fe9e75862688a295168070456951', // Coincheck
  '0x9696f59e4d72e237be84ffd425dcad154bf96976', // Binance
  '0xc17a40852e4bfe04bc81af355fdf132c539ba753', // Binance Deposit
  '0xb0af00ff84755e9093472814492f32f42a8613ea', // Bullish
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40', // Bybit
  '0xae8cbb7e810f59fd0dd939b2b6623756d91b174a', // Near Intent Deposit
  '0xb897969305a508d7dd00e4b8218827c6742c0635', // Proxy
  '0x2dcbc69ca4d13c232f39fc65d1aa568567c1c1c3', // Bitcoin Suisse
  '0x1bae874af9f81b8f93315b27f080260da4702d3a', // Derbit
  '0xc94ebb328ac25b95db0e0aa968371885fa516215', // Roobet
  '0xf51710015536957a01f32558402902a2d9c35d82', // gemini
  '0x9fedf67538d0e0b9093efef2124eca8bb6932722', // GMO
  '0x9642b23ed1e01df1092b92641051881a322f5d4e', // MEXC
  '0x6e8f6f1d3e85b143ccb306acb4ef60b3377154c9', // bitcoin Suisse
]);

// ── DEX/Swap routers — exclude from fan-out ──────────────────
const SWAP_ROUTERS = new Set([
  '0xe66b31678d6c16e9ebf358268a790b763c133750', // 0x Exchange
  '0xba3cb449bd2b4adddbc894d8697f5170800eadec', // CoW Protocol
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41', // CoW Settlement
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 R2
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', // Uniswap Universal
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal R2
  '0x0000000000004444c5dc75cb358380d2e3de08a90', // Uniswap V4
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch V5
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Proxy
  '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
]);

// ── Known funding sources — skip fan-out FROM these ──────────
// These legitimately push large ETH to fresh wallets (bridges, cross-chain)
// Do NOT add TC pools or no-KYC swaps here — those are signals, not noise
const KNOWN_FUNDING_SOURCES = new Set([
  '0xf5e10380213880111522dd0efd3dbb45b9f62bcc', // Chainflip Vault
  '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', // THORChain Router
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', // Optimism Bridge
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f', // Arbitrum Bridge
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35', // Base Bridge
  '0x2796317b0ff8538f1efdb9b9a3dd08fdb05e4eb1', // zkSync Bridge
  '0x32400084c286cf3e17e7b677ea9583e60a000324', // zkSync Era Bridge
  '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', // Across Protocol
  '0x8731d54e9d02c286767d56ac03e8037c07e01e98', // Stargate
  '0x296f55f8fb28e498b858d0bcda06d955b2cb3f97', // Stargate ETH
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', // LiFi
  '0x1a0ad011913a150f69f6a19df447a0cfd9551054', // Scroll Bridge
  '0xe4edb277e41dc89ab076a1f049f4a3efa700bce8', // Orbiter Finance

]);

// ── No-KYC swap hot wallets — amplify fan-out alerts ─────────
// Destinations here flag the fan-out as higher confidence
// These are the HOT wallets, not deposit addresses (deposit addresses are ephemeral)
const NOKYC_SWAPS = new Map([
  ['0x4e5b2e1dc63f6b91cb6cd759936495434c7e972f', 'FixedFloat'],
  ['0x077d360f11d220e4d5d831430c81c26c9be7c4a4', 'ChangeNow'],
  ['0x175d0dc7783b50899d4d3d58b68fd3ab0571dbc2', 'SimpleSwap'],
  ['0x19a7f4b33b7e453374eb82a56c2de3bfc81e2e56', 'eXch'],
  ['0xf1da173228fcf015f43f3ea15abbb51f0d8f1123', 'StealthEX'],
  ['0xeba88149813bec1cccccfdb0dacefaaa5de94cb1', 'ChangeNow'],
]);

// ── L2 bridge contracts (for flagged wallet bridge exit) ─────
const BRIDGES = {
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1': 'Optimism Bridge',
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f': 'Arbitrum Bridge',
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35': 'Base Bridge',
  '0x2796317b0ff8538f1efdb9b9a3dd08fdb05e4eb1': 'zkSync Bridge',
};

// ── Tornado Cash pools ───────────────────────────────────────
const TC_POOLS = new Set([
  '0xa160cdab225685da1d56aa342ad8841c3b53f291', // 100 ETH
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', // 10 ETH
]);

// ── Chainflip vault ──────────────────────────────────────────
const CHAINFLIP_VAULT = '0xf5e10380213880111522dd0efd3dbb45b9f62bcc';

// ── Chain config — deployWatchOnly skips all rules except TC deploy ──────────
const CHAIN_CONFIG = [
  { name: 'ETH',  wssKey: 'ALCHEMY_ETH_WSS',  deployWatchOnly: false },
  { name: 'BASE', wssKey: 'ALCHEMY_BASE_WSS', deployWatchOnly: true  },
  { name: 'ARB',  wssKey: 'ALCHEMY_ARB_WSS',  deployWatchOnly: true  },
];

// ── Rule 1: Direct TC deposit ────────────────────────────────
async function checkDirectTCDeposit(tx, usdValue, chain) {
  const to = tx.to?.toLowerCase();
  if (!TC_POOLS.has(to)) return;

  sendAlert({
    chain,
    title: '🚨 CRITICAL — Direct TC Pool Deposit',
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

// ── Rule 2: Chainflip vault large inflow/outflow ─────────────
async function checkChainflip(tx, usdValue, chain) {
  if (chain !== 'ETH') return;
  if (usdValue < CHAINFLIP_MIN_USD) return;

  const to   = tx.to?.toLowerCase();
  const from = tx.from?.toLowerCase();

  const isDeposit  = to   === CHAINFLIP_VAULT;
  const isWithdraw = from === CHAINFLIP_VAULT;
  if (!isDeposit && !isWithdraw) return;

  const direction = isDeposit ? '📥 Into Chainflip' : '📤 Out of Chainflip';
  const wallet    = isDeposit ? tx.from : tx.to;

  const burstKey   = `cf:burst:${wallet?.toLowerCase()}`;
  const burstCount = windowAdd(burstKey, usdValue, 15 * 60);

  if (burstCount >= 3) {
    const all      = windowGet(burstKey, 15 * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: '🚨 CRITICAL — Chainflip Burst Activity',
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
        `🔗 [Chainflip Explorer](https://scan.chainflip.io)`,
      ].join('\n'),
    });
    return;
  }

  sendAlert({
    chain,
    title: `🟠 HIGH — Chainflip Vault ${isDeposit ? 'Deposit' : 'Withdrawal'}`,
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

// ── Rule 3: Rapid accumulation ───────────────────────────────
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
      title: '🚨 CRITICAL — Rapid Fund Accumulation',
      alertId: `evm:accum:${chain}:${tx.to}`,
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

  if (count > ACCUM_COUNT && (count - ACCUM_COUNT) % 2 === 0) {
    const all      = windowGet(key, ACCUM_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: '🚨 CRITICAL — Accumulation Escalating',
      alertId: `evm:accum:escalate:${chain}:${tx.to}:${count}`,
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

// ── Rule 4: Structuring ──────────────────────────────────────
async function checkStructuring(tx, usdValue, chain) {
  if (usdValue < 500_000 || usdValue > STRUCT_USD) return;

  const key   = `struct:${chain}:${tx.from?.toLowerCase()}`;
  const count = windowAdd(key, usdValue, STRUCT_WIN_MIN * 60);

  if (count === STRUCT_COUNT) {
    const all      = windowGet(key, STRUCT_WIN_MIN * 60);
    const totalUSD = all.reduce((s, v) => s + Number(v), 0);

    sendAlert({
      chain,
      title: '🟠 HIGH — Structuring Pattern Detected',
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

// ── Rule 5: Flagged wallet bridge exit ───────────────────────
async function checkFlaggedWallet(tx, usdValue, chain) {
  const fromFlag = isFlagged(tx.from);
  if (!fromFlag) return;

  const to     = tx.to?.toLowerCase();
  const bridge = BRIDGES[to];
  if (!bridge) return;

  sendAlert({
    chain,
    title: '🚨 CRITICAL — Flagged Wallet Bridge Exit',
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

// ── Rule 6: Dormant wallet ───────────────────────────────────
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
      title: '🟠 HIGH — Dormant Wallet Active',
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

// ── Rule 7: Fan-out ──────────────────────────────────────────
//
// Pure outbound pattern — no inflow requirement.
// Fires when a wallet sends to 3+ unique destinations in FANOUT_WIN_MIN
// minutes with each leg >= FANOUT_LEG_USD.
//
// This catches the FixedFloat/ChangeNow pattern regardless of how the
// wallet was funded (Chainflip, bridged, swapped, slow accumulation etc).
// The inflow requirement was removed because it missed cases where:
//   - Funds arrived in multiple small chunks over >15 min (Chainflip pattern)
//   - Funds arrived as tokens then swapped to ETH
//   - Funds arrived from a bridge output address

function checkFanOut(tx, usdValue, chain) {
  if (!tx.from || !tx.to) return;
  if (usdValue < FANOUT_LEG_USD) return;

  const fromLower = tx.from.toLowerCase();
  const toLower   = tx.to.toLowerCase();

  // Skip known noise — bridges/protocols legitimately push large ETH outbound
  if (KNOWN_FUNDING_SOURCES.has(fromLower)) return;
  if (CEX_RECEIVERS.has(fromLower))         return;
  if (SWAP_ROUTERS.has(fromLower))          return;
  // Skip legs going to obvious non-suspicious destinations
  if (CEX_RECEIVERS.has(toLower))   return;
  if (SWAP_ROUTERS.has(toLower))    return;

  const fanKey = `fanout:${chain}:${fromLower}`;
  const valKey = `fanout:val:${chain}:${fromLower}`;

  windowAdd(fanKey, toLower, FANOUT_WIN_MIN * 60);
  windowAdd(valKey, usdValue, FANOUT_WIN_MIN * 60);

  const dests       = windowGet(fanKey, FANOUT_WIN_MIN * 60);
  const uniqueDests = new Set(dests).size;
  if (uniqueDests < FANOUT_MIN_LEGS) return;

  // Dedup — alert once per (wallet, dest count), escalate every +2 after
  const alertKey = `fanout:alerted:${chain}:${fromLower}:${uniqueDests}`;
  if (getKey(alertKey)) return;
  setKey(alertKey, '1', FANOUT_WIN_MIN * 60);

  const vals     = windowGet(valKey, FANOUT_WIN_MIN * 60).map(Number).filter(v => v > 0);
  const totalUSD = vals.reduce((s, v) => s + v, 0);
  const avgVal   = totalUSD / vals.length;

  // Check if any destination is a known no-KYC swap hot wallet
  const destList    = windowGet(fanKey, FANOUT_WIN_MIN * 60);
  const nokycHits   = [...new Set(destList)].filter(d => NOKYC_SWAPS.has(d));
  const nokycNames  = nokycHits.map(d => NOKYC_SWAPS.get(d)).join(', ');
  const hasNokyc    = nokycHits.length > 0;

  const title = hasNokyc
    ? '🚨 CRITICAL — Fan-out to No-KYC Swap'
    : '🚨 CRITICAL — Fund Distribution Pattern';

  sendAlert({
    chain,
    title,
    alertId: `evm:fanout:${chain}:${fromLower}:${uniqueDests}`,
    txHash: tx.hash,
    wallet: tx.from,
    walletLink: true,
    body: [
      `Source wallet: \`${shortAddr(tx.from)}\``,
      ``,
      `*${uniqueDests} unique destinations* in ${FANOUT_WIN_MIN}m`,
      `Total distributed: *${fmtUSD(totalUSD)}*`,
      `Avg per leg: ~${fmtUSD(avgVal)}`,
      hasNokyc ? `` : null,
      hasNokyc ? `⚠️ Destinations include no-KYC swap: *${nokycNames}*` : null,
      ``,
      `🔴 Rapid multi-destination distribution`,
    ].filter(l => l !== null).join('\n'),
  });
}

// ── Main tx handler ──────────────────────────────────────────

async function handleTx(tx, chain, httpUrl, deployWatchOnly = false) {
  try {
    // Global dedup
    const dedupKey = `tx:${tx.hash}`;
    if (getKey(dedupKey)) return;
    setKey(dedupKey, '1', 3600);

    // ── TC deploy check — runs on ETH, BASE, ARB ─────────────
    // Only fetch receipt when tx.from is a watched TC withdrawal address
    // (zero marginal CU cost in normal operation)
    if (tx.to === null && httpUrl) {
      const { getWatchedWithdrawals } = require('./tornadoDeploy');
      const fromLower = tx.from?.toLowerCase();
      if (fromLower && getWatchedWithdrawals().has(fromLower)) {
        const receipt = await fetchReceipt(tx.hash, httpUrl);
        if (receipt) await checkDeployment(tx, receipt, chain);
      }
    }

    // ── Hop transfer tracking — ETH only ─────────────────────
    // If a watched TC withdrawal address sends ETH to another wallet on ETH
    // mainnet, that destination becomes a hop-1 watched address
    if (chain === 'ETH' && tx.to) {
      checkHopTransfer(tx);
    }

    // ── Token contract confirmation — ETH only ────────────────
    if (chain === 'ETH' && tx.to) {
      confirmTokenContract(tx.to.toLowerCase());
    }

    // deployWatchOnly chains stop here
    if (deployWatchOnly) return;

    if (!tx.value || tx.value === '0x0') return;

    const usdValue = await toUSD(BigInt(tx.value), 'ETH', 18);
    if (!usdValue || usdValue < 10_000) return;

    checkFanOut(tx, usdValue, chain);

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

// ── WebSocket helpers ────────────────────────────────────────

function isAlchemy(url) {
  return url?.includes('alchemy.com') || url?.includes('alchemyapi.io');
}

function getHttpUrl(wssUrl) {
  return wssUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .replace('/ws/v3/', '/v3/');
}

async function fetchBlock(blockHash, httpUrl) {
  try {
    const axios = require('axios');
    const { data } = await axios.post(httpUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'eth_getBlockByHash',
      params: [blockHash, true],
    }, { timeout: 10_000 });
    return data?.result?.transactions || [];
  } catch {
    return [];
  }
}

// Only called when tx.from is in watchedWithdrawals — very rare, near-zero CU cost
async function fetchReceipt(hash, httpUrl) {
  try {
    const axios = require('axios');
    const { data } = await axios.post(httpUrl, {
      jsonrpc: '2.0', id: 2,
      method: 'eth_getTransactionReceipt',
      params: [hash],
    }, { timeout: 5_000 });
    return data?.result || null;
  } catch {
    return null;
  }
}

// ── WebSocket connector ──────────────────────────────────────

function connectChain(primaryUrl, chain, deployWatchOnly = false, fallbackUrl = null) {
  let ws;
  let reconnectDelay = 2000;
  let failCount      = 0;
  let usingFallback  = false;
  let lastMessageAt  = Date.now();

  function currentUrl() {
    return usingFallback && fallbackUrl ? fallbackUrl : primaryUrl;
  }

  function connect() {
    const url      = currentUrl();
    const label    = isAlchemy(url) ? 'Alchemy' : 'RPC';
    const modeTag  = deployWatchOnly ? 'deploy-watch-only' : 'full';
    const fallTag  = usingFallback ? ' [FALLBACK]' : '';
    logger.info(`[EVM:${chain}] Connecting... (${label} — ${modeTag}${fallTag})`);

    ws = new WebSocket(url);

    ws.on('open', () => {
      reconnectDelay = 2000;
      failCount      = 0;
      lastMessageAt  = Date.now();
      logger.info(`[EVM:${chain}] Connected ✓`);

      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_subscribe',
        params: ['newHeads'],
      }));
    });

    ws.on('message', (raw) => {
      lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw);
        if (!msg.params?.result?.hash) return;
        const blockHash = msg.params.result.hash;
        const httpUrl   = getHttpUrl(currentUrl());

        fetchBlock(blockHash, httpUrl).then(txs => {
          for (const tx of txs) {
            if (tx && tx.from && tx.hash) handleTx(tx, chain, httpUrl, deployWatchOnly);
          }
        });
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

  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  // Stale socket — newHeads fires every ~12s so 3 min = clearly dead
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      if (Date.now() - lastMessageAt > 3 * 60 * 1000) {
        logger.warn(`[EVM:${chain}] Stale socket — forcing reconnect`);
        ws.terminate();
      }
    }
  }, 2 * 60 * 1000);
}

// ── Entry point ──────────────────────────────────────────────

function startEVMMonitor() {
  for (const { name, wssKey, deployWatchOnly } of CHAIN_CONFIG) {
    const url = process.env[wssKey];
    if (!url || url.includes('YOUR_KEY')) {
      logger.warn(`[EVM:${name}] No WSS URL — skipping`);
      continue;
    }

    const fallback = name === 'ETH' ? process.env.ALCHEMY_ETH_FALLBACK : null;
    if (fallback) logger.info(`[EVM:${name}] Fallback configured`);

    connectChain(url, name, deployWatchOnly, fallback);
  }
}

module.exports = { startEVMMonitor };
