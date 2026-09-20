const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HELP = '/block 0xAddress reason\n/unblock 0xAddress\n/mute 0xAddress 24h\n/blocked\nOr reply to a wallet alert with /block, /unblock or /mute 24h.\nBlocks suppress alerts about that wallet across EVM chains; they do not block blockchain transactions.';

function commandHandler(state, { chatId, adminIds = [], now = Date.now } = {}) {
  const admins = new Set(adminIds.map(String));
  return message => {
    if (String(message.chat?.id) !== String(chatId)) return null;
    const uid = String(message.from?.id);
    const authorized = admins.size ? admins.has(uid) :
      message.chat?.type === 'private' && uid === String(chatId) && /^\d+$/.test(uid);
    if (!authorized || message.from?.is_bot) return null;
    const match = /^\/(block|unblock|remove|mute|blocked|help)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((message.text || '').trim());
    if (!match) return null;
    const command = match[1].toLowerCase(), args = (match[2] || '').trim().split(/\s+/).filter(Boolean);
    if (command === 'help') return HELP;
    if (command === 'blocked') {
      const rows = Object.entries(state.data.blocked).filter(([,r]) => !r.until || r.until > now());
      if (!rows.length) return 'No Telegram wallet exclusions. Your built-in script exclusions remain active.';
      return rows.map(([a,r]) => `${a}\n${r.until ? 'Muted until ' + new Date(r.until).toISOString() : 'Blocked'} — ${r.reason}`).join('\n\n');
    }
    const replied = state.data.messages[message.reply_to_message?.message_id];
    if (args[0]?.startsWith('0x') && !ADDRESS.test(args[0])) return 'Invalid wallet address. Use 0x followed by 40 hexadecimal characters.';
    const address = ADDRESS.test(args[0] || '') ? args.shift().toLowerCase() : replied;
    if (!address) return 'Supply a valid 0x wallet address, or reply to a wallet alert sent after this update.\n' + HELP;
    const id = `${message.chat.id}:${message.message_id}`;
    if (state.data.commands[id]) return 'This command was already applied.';
    let until = 0;
    if (command === 'mute') {
      const duration = /^(\d+)(m|h|d)$/i.exec(args.shift() || '');
      if (!duration) return 'Use /mute 0xAddress 24h (or reply with /mute 24h).';
      const ms = Number(duration[1]) * { m: 60000, h: 3600000, d: 86400000 }[duration[2].toLowerCase()];
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 365 * 86400000) return 'Mute duration must be between 1 minute and 365 days.';
      until = now() + ms;
    }
    state.update(s => {
      if (command === 'unblock' || command === 'remove') delete s.blocked[address];
      else {
        s.blocked[address] = { until, reason: args.join(' ').slice(0, 200) || 'Manually excluded', by: uid, at: now() };
        s.queue = s.queue.filter(x => x.alert.wallet?.toLowerCase() !== address);
      }
      s.commands[id] = now();
      for (const [key,at] of Object.entries(s.commands)) if (at < now() - 7 * 86400000) delete s.commands[key];
    });
    return command === 'unblock' || command === 'remove' ?
      `Removed Telegram exclusion for ${address}. Built-in script exclusions still apply.` :
      `${until ? 'Muted' : 'Blocked'} ${address}${until ? ' until ' + new Date(until).toISOString() : ''}. Saved. This suppresses alerts about this wallet, not transfers by other watched wallets to it.`;
  };
}
module.exports = { commandHandler, HELP };
