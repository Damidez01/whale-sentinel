require('dotenv').config();

const { startTornadoMonitor }  = require('./monitors/tornado');
const { startTornadoDeployMonitor } = require('./monitors/tornadoDeploy');
const { startTHORChainMonitor } = require('./monitors/thorchain');
const { startEVMMonitor }       = require('./monitors/evm');
const { startChainflipMonitor } = require('./monitors/chainflip');
const { startTokenMonitor }     = require('./monitors/tokens');
const { sendStartup }           = require('./alerts/telegram');
const { getFlaggedCount }       = require('./intelligence/flagged');
const logger = require('./utils/logger');

// ── Validate required env ────────────────────────────────────
const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your values');
  process.exit(1);
}

// ── Startup ──────────────────────────────────────────────────
async function main() {
  logger.info('🐕 ChainHound v2 starting...');

  const modules = [];

  // Tornado Cash (ETH mainnet only)
  if (process.env.ALCHEMY_ETH_WSS && !process.env.ALCHEMY_ETH_WSS.includes('YOUR_KEY')) {
    startTornadoMonitor();
    startTornadoDeployMonitor();
    modules.push('Tornado Cash (100 ETH + 10 ETH pools + deploy watcher)');
  } else {
    logger.warn('[Main] ETH WSS not set — Tornado Cash monitor disabled');
  }

  // THORChain
// startTHORChainMonitor();
 modules.push('THORChain (ETH/stables ↔ BTC)');

  // EVM chains
  startEVMMonitor();
  modules.push('EVM — ETH, Base, Arbitrum');

  // Chainflip vault monitor
  if (process.env.ETHERSCAN_API_KEY) {
    startChainflipMonitor();
    modules.push('Chainflip Vault (ETH in/out)');
  } else {
    logger.warn('[Main] No ETHERSCAN_API_KEY — Chainflip monitor disabled');
  }

  // ERC20 token monitor — disabled (too expensive on free tier)
  // startTokenMonitor();
  // modules.push('Token Monitor (USDC, USDT, DAI, WBTC)');

  modules.push(`Intelligence — ${getFlaggedCount()} wallets pre-loaded from disk`);

  // Send startup message to Telegram
  await sendStartup(modules);

  logger.info(`✅ ChainHound v2 running | ${modules.length} modules active`);
}

// ── Error handling ───────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err?.message });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down gracefully');
  process.exit(0);
});

main();
