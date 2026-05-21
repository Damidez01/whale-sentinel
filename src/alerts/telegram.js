const TelegramBot = require('node-telegram-bot-api');
const { setKey, getKey } = require('../utils/store');
const logger = require('../utils/logger');

const bot     = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Rate limit: 1 alert per 8 seconds max
let lastSent  = 0;
const RATE_MS = 8_000;

const queue = [];
let processing = false;

const CHAIN_EMOJI = { ETH: '⟠', BASE: '🔵', ARB: '🔷', THOR: '⚡' };

// ── Message builder ──────────────────────────────────────────

function buildMessage(alert) {
  const chainTag  = CHAIN_EMOJI[alert.chain] || '🔗';
  const separator = '─'.repeat(28);

  const lines = [
    `${chainTag} *${alert.title}*`,
    separator,
    alert.body,
    separator,
  ];

  // Explorer link — per chain
  if (alert.txHash) {
    const explorers = {
      ETH:  `https://etherscan.io/tx/${alert.txHash}`,
      BASE: `https://basescan.org/tx/${alert.txHash}`,
      ARB:  `https://arbiscan.io/tx/${alert.txHash}`,
      THOR: `https://thorchain.net/tx/${alert.txHash}`,
    };
    if (explorers[alert.chain]) {
      lines.push(`📎 [View on Explorer](${explorers[alert.chain]})`);
    }
  }

  // Wallet link — Etherscan for EVM, THORChain explorer for THOR
  if (alert.walletLink && alert.wallet) {
    if (alert.chain === 'THOR') {
      lines.push(`🔍 [Wallet on THORChain](https://thorchain.net/address/${alert.wallet})`);
    } else {
      lines.push(`🔍 [Wallet on Etherscan](https://etherscan.io/address/${alert.wallet})`);
    }
  }

  lines.push(`⏱ ${new Date().toUTCString()}`);
  return lines.filter(l => l !== undefined).join('\n');
}

// ── Queue processor ──────────────────────────────────────────

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const wait = RATE_MS - (Date.now() - lastSent);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const alert = queue.shift();

    // Dedup by alertId
    if (alert.alertId) {
      if (getKey(`sent:${alert.alertId}`)) continue;
      setKey(`sent:${alert.alertId}`, '1', 300);
    }

    try {
      await bot.sendMessage(CHAT_ID, buildMessage(alert), {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      lastSent = Date.now();
      logger.alert(`[Telegram] Sent: ${alert.title}`);
    } catch (err) {
      logger.error('[Telegram] Send failed', { error: err.message });
    }
  }

  processing = false;
}

// ── Public API ───────────────────────────────────────────────

function sendAlert(alert) {
  queue.push(alert);
  processQueue();
}

async function sendStartup(modules) {
  try {
    const msg = [
      `🛡 *ChainHound v2 Online*`,
      ``,
      `Active modules:`,
      modules.map(m => `  • ${m}`).join('\n'),
      ``,
      `Tornado Cash pools:`,
      `  • 100 ETH pool`,
      `  • 10 ETH pool`,
      ``,
      `_Monitoring for incidents..._`,
    ].join('\n');

    await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
    logger.info('[Telegram] Startup message sent');
  } catch (err) {
    logger.error('[Telegram] Startup failed', { error: err.message });
  }
}

module.exports = { sendAlert, sendStartup };
