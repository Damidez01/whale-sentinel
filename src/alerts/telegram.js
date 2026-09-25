const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const { DurableState, Delivery } = require('./durable');
const { commandHandler } = require('./commands');
const { normalizeWallet } = require('../utils/addresses');
const logger = require('../utils/logger');

const bot     = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false, request: { timeout: 45000 } });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const state = new DurableState(path.join(process.env.TELEGRAM_DATA_DIR || '/data', 'telegram-state.json'));
if (process.env.EXCHANGE_FANOUT_ENABLED !== 'true') {
  state.update(s => { s.queue = s.queue.filter(item =>
    !(item.alert.alertId?.startsWith('exchange:') && item.alert.alertId.includes(':out:'))); });
}
const handleCommand = commandHandler(state, { chatId: CHAT_ID,
  adminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean) });
let timer;

const CHAIN_EMOJI = { ETH: '⟠', BASE: '🔵', ARB: '🔷', THOR: '⚡', TRON: '🔺' };

// ── Message builder ──────────────────────────────────────────

function buildMessage(alert) {
  if (alert.text) return alert.text;
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
      TRON: `https://tronscan.org/#/transaction/${alert.txHash}`,
    };
    if (explorers[alert.chain]) {
      lines.push(`📎 [View on Explorer](${explorers[alert.chain]})`);
    }
  }

  // Wallet link — Etherscan for EVM, THORChain explorer for THOR
  if (alert.walletLink && alert.wallet) {
    if (alert.chain === 'TRON') {
      lines.push(`🔍 [Wallet on Tronscan](https://tronscan.org/#/address/${alert.wallet})`);
    } else if (alert.chain === 'THOR' && alert.walletChain !== 'ETH') {
      lines.push(`🔍 [Wallet on THORChain](https://thorchain.net/address/${alert.wallet})`);
    } else {
      lines.push(`🔍 [Wallet on Etherscan](https://etherscan.io/address/${alert.wallet})`);
    }
  }

  lines.push(`⏱ ${new Date().toUTCString()}`);
  return lines.filter(l => l !== undefined).join('\n');
}

// ── Queue processor ──────────────────────────────────────────

const delivery = new Delivery(state, {
  render: buildMessage,
  send: (text, alert, plain) => bot.sendMessage(CHAT_ID, text.slice(0, 4000), {
    ...(!plain && !alert.plain ? { parse_mode: 'Markdown' } : {}),
    disable_web_page_preview: false,
    ...(normalizeWallet(alert.wallet) ?
      { reply_markup: { inline_keyboard: [[{ text: 'Block wallet', callback_data: 'block-wallet' }]] } } : {}),
  }),
  onError: code => logger.warn(`[Telegram] Delivery pending; retry scheduled (${code})`),
});
function startTelegram() {
  if (timer) return;
  timer = setInterval(() => delivery.tick().catch(() => logger.error('[Telegram] Cannot save delivery state')), 1000);
  bot.on('message', message => {
    try {
      const response = handleCommand(message);
      if (response) {
        // Each reply is durable too; split long /blocked listings.
        for (let offset = 0; offset < response.length; offset += 3500)
          sendAlert({ text: response.slice(offset, offset + 3500), plain: true });
      }
    } catch {
      logger.error('[Telegram] Command could not be saved; not reporting success');
    }
  });
  bot.on('polling_error', () => logger.warn('[Telegram] Command polling failed; check bot credentials and ensure only one instance is polling'));
  bot.on('callback_query', query => {
    if (query.data !== 'block-wallet' || !query.message) return;
    try {
      const response = handleCommand({ from: query.from, chat: query.message.chat, message_id: `callback:${query.id}`,
        text: '/block', reply_to_message: { message_id: query.message.message_id } });
      if (response) sendAlert({ text: response, plain: true });
      bot.answerCallbackQuery(query.id, { text: response ? 'Request processed' : 'Not authorized' }).catch(() => {});
    } catch { bot.answerCallbackQuery(query.id, { text: 'Could not save this change' }).catch(() => {}); }
  });
  bot.options.polling = { params: { timeout: 30, allowed_updates: ['message', 'callback_query'] } };
  bot.startPolling().catch(() => logger.error('[Telegram] Cannot start command polling'));
}

// ── Public API ───────────────────────────────────────────────

function sendAlert(alert) {
  delivery.enqueue(alert);
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

    sendAlert({ text: msg });
    logger.info('[Telegram] Startup message queued for delivery');
  } catch (err) {
    logger.error('[Telegram] Startup failed', { error: err.message });
  }
}

module.exports = { sendAlert, sendStartup, startTelegram, isBlocked: address => state.isBlocked(address) };
