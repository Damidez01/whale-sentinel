const fs = require('fs');
const path = require('path');
const { normalizeWallet } = require('../utils/addresses');
const { alertWallets } = require('../utils/alertWallets');

class ExchangeStore {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
      { version: 1, cursors: {}, windows: {}, seen: {}, notified: {}, pending: [], health: {} };
    if (this.data.version !== 1 || !Array.isArray(this.data.pending) ||
      ['cursors','windows','seen','notified','health'].some(k => !this.data[k] || typeof this.data[k] !== 'object')) throw Error('Invalid exchange-watch state');
    this.update(() => {});
  }
  update(fn) {
    const next = structuredClone(this.data); fn(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file + '.tmp', 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(this.file + '.tmp', this.file); this.data = next;
  }
}
function settings(env = process.env) {
  const positive = (name, fallback, integer = false) => {
    const n = Number(env[name] || fallback);
    if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw Error(`Invalid ${name}`);
    return n;
  };
  return {
    min: positive('EXCHANGE_ACCUM_MIN_USD', 50000), count: positive('EXCHANGE_ACCUM_COUNT', 3, true),
    minutes: positive('EXCHANGE_ACCUM_WIN_MIN', 15),
    fanoutMin: positive('FANOUT_LEG_USD', 10000), fanoutCount: positive('FANOUT_MIN_LEGS', 3, true),
    fanoutMinutes: positive('FANOUT_WIN_MIN', 15),
    fanoutEnabled: env.EXCHANGE_FANOUT_ENABLED === 'true',
    pollMs: Math.max(15000, positive('EXCHANGE_POLL_MS', 120000, true)),
    confirmations: positive('EXCHANGE_ETH_CONFIRMATIONS', 12, true),
    maxBlocks: positive('EXCHANGE_ETH_MAX_BLOCKS', 25, true),
    maxPages: positive('EXCHANGE_TRON_MAX_PAGES', 20, true),
    freshOnly: env.EXCHANGE_FRESH_ONLY !== 'false',
    freshMaxTx: Math.min(100, positive('EXCHANGE_FRESH_MAX_TX', 10, true)),
    freshMaxHours: positive('EXCHANGE_FRESH_MAX_HOURS', 48),
  };
}
const money = n => '$' + Math.round(n).toLocaleString('en-US');
class ExchangeEngine {
  constructor(store, wallets, rules, { ignoreDestination = () => false, isBlocked = () => false } = {}) {
    this.store = store; this.rules = rules;
    this.ignoreDestination = ignoreDestination;
    this.isBlocked = isBlocked;
    this.wallets = wallets.map(w => ({ ...w, address: normalizeWallet(w.address) }));
    if (this.wallets.some(w => !w.address || !['ETH','TRON'].includes(w.chain))) throw Error('Invalid exchange watchlist');
  }
  pruneBlocked(s) {
    for (const [key, rows] of Object.entries(s.windows)) {
      if (!this.rules.fanoutEnabled && key.endsWith(':out')) {
        delete s.windows[key]; delete s.notified[key]; continue;
      }
      const kept = rows.filter(e => !this.isBlocked(e.from) && !this.isBlocked(e.to) &&
        !(this.rules.freshOnly && key.endsWith(':in') && !e.freshApproved));
      if (kept.length !== rows.length) {
        s.windows[key] = kept;
        delete s.notified[key]; // Allow a new threshold using only eligible rows.
      }
    }
    s.pending = s.pending.filter(alert => !alertWallets(alert).some(a => this.isBlocked(a)) &&
      !(!this.rules.fanoutEnabled && alert.alertId?.includes(':out:')) &&
      !(this.rules.freshOnly && alert.alertId?.includes(':in:') && !alert.freshOnly));
  }
  commit(events, cursorPatch = {}, healthPatch = {}) {
    this.store.update(s => {
      this.pruneBlocked(s);
      const sorted = [...events].sort((a,b) => a.at - b.at || (a.order || 0) - (b.order || 0));
      for (const raw of sorted) {
        const e = { ...raw, from: normalizeWallet(raw.from), to: normalizeWallet(raw.to) };
        if (!e.from || !e.to || e.from === e.to || !Number.isFinite(e.at) || !Number.isFinite(e.usd) || e.usd < 0 || !e.id || !e.hash) continue;
        if (e.usd < Math.min(this.rules.min, this.rules.fanoutMin)) continue;
        const id = `${e.chain}:${e.id}`;
        if (s.seen[id]) continue;
        if (this.isBlocked(e.from) || this.isBlocked(e.to)) { s.seen[id] = e.at; continue; }
        for (const wallet of this.wallets.filter(w => w.chain === e.chain)) {
          const direction = e.to === wallet.address ? 'in' : e.from === wallet.address ? 'out' : null;
          if (!direction) continue;
          if (direction === 'out' && !this.rules.fanoutEnabled) continue;
          const accumulation = direction === 'in';
          if (accumulation && this.rules.freshOnly && !e.freshApproved) continue;
          if (!accumulation && this.ignoreDestination(e.chain, e.to)) continue;
          const min = accumulation ? this.rules.min : this.rules.fanoutMin;
          if (e.usd < min) continue;
          const windowMs = (accumulation ? this.rules.minutes : this.rules.fanoutMinutes) * 60000;
          const key = `${e.chain}:${wallet.address}:${direction}`;
          const watermark = Math.max(e.at, ...(s.windows[key] || []).map(x => x.at));
          if (e.at <= watermark - windowMs) continue;
          const rows = (s.windows[key] || []).filter(x => x.at > watermark - windowMs);
          rows.push(e); s.windows[key] = rows;
          const current = rows;
          const distinct = new Set(current.map(x => accumulation ? x.hash : x.to)).size;
          const threshold = accumulation ? this.rules.count : this.rules.fanoutCount;
          if (distinct < threshold) continue;
          // Same fan-out behavior as original: each new destination count can alert.
          // Accumulation escalates by two distinct transactions after its threshold.
          if (accumulation && (distinct - threshold) % 2 !== 0) continue;
          const previous = s.notified[key];
          if (previous && watermark - previous.at < windowMs && distinct <= previous.count) continue;
          if (s.pending.length >= 10000) throw Error('Exchange alert backlog full; retaining scan cursor');
          const totals = {};
          for (const row of current) totals[row.symbol] = (totals[row.symbol] || 0) + row.usd;
          const subject = accumulation ? e.from : e.to;
          const addressUrl = address => `https://arkm.com/explorer/address/${address}`;
          const short = address => `${address.slice(0, 6)}...${address.slice(-4)}`;
          const counterparties = new Map();
          for (const row of current) {
            const address = accumulation ? row.from : row.to;
            counterparties.set(address, (counterparties.get(address) || 0) + row.usd);
          }
          const others = [...counterparties].filter(([address]) => address !== subject);
          s.pending.push({ chain: e.chain, wallet: subject, walletLink: true, txHash: e.hash,
            countedWallets: [wallet.address, ...counterparties.keys()],
            freshOnly: accumulation && this.rules.freshOnly,
            alertId: `exchange:${key}:${e.id}:${distinct}`,
            title: `${wallet.service} — ${accumulation ? 'Hot-wallet accumulation' : 'Hot-wallet fan-out'}`,
            body: [
              `${accumulation ? 'Source' : 'Destination'} wallet: \`${short(subject)}\``,
              '',
              accumulation ? `*${distinct} incoming txns in ${windowMs / 60000} min*` : `*${distinct} destinations in ${windowMs / 60000} min*`,
              `Total ${accumulation ? 'received' : 'sent'}: *${money(current.reduce((sum,x) => sum+x.usd, 0))}*`,
              `Each: ≥ ${money(min)}`,
              ...(accumulation && this.rules.freshOnly ? [`Sources: ≤${this.rules.freshMaxTx} observed txns; ≤${this.rules.freshMaxHours}h history`] : []),
              `Assets: ${Object.entries(totals).map(([symbol,usd]) => `${symbol} ${money(usd)}`).join(', ')}`,
              '',
              `${accumulation ? 'Sources' : 'Destinations'}:`,
              ...[[subject, counterparties.get(subject)], ...others].slice(0, 8).map(([address,usd]) => `[${short(address)}](${addressUrl(address)}) — ${money(usd)}`),
              ...(counterparties.size > 8 ? [`Plus ${counterparties.size - 8} other wallets in this window.`] : []),
            ].join('\n') });
          s.notified[key] = { at: watermark, count: distinct };
        }
        s.seen[id] = e.at;
      }
      Object.assign(s.cursors, cursorPatch); Object.assign(s.health, healthPatch);
      // Retain enough history for late indexed events and restarts; never use processing time for rule windows.
      const cutoff = Date.now() - 2 * 86400000;
      for (const [id,at] of Object.entries(s.seen)) if (at < cutoff) delete s.seen[id];
      for (const [key,rows] of Object.entries(s.windows)) s.windows[key] = rows.filter(e => e.at > cutoff);
      for (const [key,row] of Object.entries(s.notified)) if (row.at < cutoff) delete s.notified[key];
    });
  }
  flush(sendAlert) {
    this.store.update(s => this.pruneBlocked(s));
    while (this.store.data.pending.length) {
      const alert = this.store.data.pending[0];
      sendAlert(alert); // Telegram's durable queue must succeed before acknowledgement here.
      this.store.update(s => { s.pending = s.pending.filter(x => x.alertId !== alert.alertId); });
    }
  }
}
module.exports = { ExchangeStore, ExchangeEngine, settings };
