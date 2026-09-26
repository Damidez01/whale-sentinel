const TREASURIES = [
  { asset: 'btc', token: 'UBTC', chain: 'bitcoin', address: '0x574bafce69d9411f662a433896e74e4f153096fa' },
  { asset: 'eth', token: 'UETH', chain: 'ethereum', address: '0x8dafbe89302656a7df43c470e9ebcb4c540835c0' },
];
const lower = x => String(x || '').toLowerCase();
const walletOK = x => /^0x[0-9a-f]{40}$/.test(x);
const money = n => '$' + Math.round(n).toLocaleString('en-US');
function unitSettings(env = process.env) {
  const n = (key, fallback) => {
    const value = Number(env[key] || fallback);
    if (!Number.isFinite(value) || value <= 0) throw Error(`Invalid ${key}`);
    return value;
  };
  const rules = {
    single: n('HYPERUNIT_MIN_DEPOSIT_USD', 50000),
    total: n('HYPERUNIT_ACCUM_MIN_USD', 100000),
    count: n('HYPERUNIT_ACCUM_COUNT', 3),
    minutes: n('HYPERUNIT_ACCUM_WIN_MIN', 15),
    pollMs: Math.max(30000, n('HYPERUNIT_POLL_MS', 60000)),
  };
  if (!Number.isSafeInteger(rules.count)) throw Error('Invalid HYPERUNIT_ACCUM_COUNT');
  return rules;
}

// A full page is ambiguous: split the time range instead of skipping records
// sharing its last timestamp. A saturated single millisecond fails closed.
async function collectLedger(request, treasury, start, end, budget = { left: 24 }) {
  if (--budget.left < 0) throw Error('Hyperliquid page budget reached');
  const rows = await request(treasury.address, start, end);
  if (!Array.isArray(rows) || rows.some(r => !Number.isSafeInteger(r.time))) throw Error('Invalid Hyperliquid ledger response');
  if (rows.length >= 500) {
    if (start >= end) throw Error('Hyperliquid timestamp saturated; cursor retained');
    const mid = Math.floor((start + end) / 2);
    return [...await collectLedger(request, treasury, start, mid, budget),
      ...await collectLedger(request, treasury, mid + 1, end, budget)];
  }
  return rows.filter(r => r.time >= start && r.time <= end);
}
function candidate(row, treasury) {
  const d = row.delta;
  if (d?.type !== 'spotTransfer' || lower(d.user) !== treasury.address || d.token !== treasury.token) return null;
  const wallet = lower(d.destination), usd = Number(d.usdcValue), amount = Number(d.amount);
  if (!walletOK(wallet) || !/^0x[0-9a-f]{64}$/i.test(row.hash) ||
      !Number.isSafeInteger(d.nonce) || !Number.isSafeInteger(row.time) ||
      !Number.isFinite(usd) || usd <= 0 || !Number.isFinite(amount) || amount <= 0) {
    throw Error('Invalid Unit transfer identity or USD value; cursor retained');
  }
  return { key: `${treasury.address}:${d.nonce}`, wallet, usd, amount,
    asset: treasury.asset, sourceChain: treasury.chain, at: row.time, hash: row.hash, attempted: 0 };
}
function matchOperation(e, operations) {
  const matches = operations.filter(op => lower(op.destinationTxHash) === e.key &&
    lower(op.destinationAddress) === e.wallet && op.destinationChain === 'hyperliquid' &&
    op.sourceChain === e.sourceChain && op.asset === e.asset && op.state === 'done');
  if (matches.length !== 1) return null;
  const op = matches[0], sourceHash = String(op.sourceTxHash || '').split(':')[0];
  if (!(e.asset === 'btc' ? /^[0-9a-f]{64}$/i : /^0x[0-9a-f]{64}$/i).test(sourceHash) ||
      !op.operationId || op.operationId !== op.sourceTxHash) return null;
  return { ...e, operationId: op.operationId, sourceHash, source: op.sourceAddress,
    depositId: `${e.asset}:${lower(sourceHash)}:${e.wallet}` };
}

class UnitMonitor {
  constructor({ store, rules = unitSettings(), ledger, operations, sendAlert, isBlocked = () => false, now = Date.now }) {
    Object.assign(this, { store, rules, ledger, operations, sendAlert, isBlocked, now });
    store.update(s => { s.unitCandidates ||= {}; });
  }
  async flush() {
    for (const alert of [...this.store.data.pending]) {
      if (!this.isBlocked(alert.wallet)) await this.sendAlert(alert);
      this.store.update(s => { s.pending = s.pending.filter(a => a.alertId !== alert.alertId); });
    }
  }
  commitReady(through) {
    let queued = 0;
    this.store.update(s => {
      const candidates = Object.values(s.unitCandidates).sort((a,b) => a.at - b.at || a.key.localeCompare(b.key));
      const held = new Set();
      for (const e of candidates) {
        if (this.isBlocked(e.wallet)) {
          delete s.windows[e.wallet]; delete s.unitCandidates[e.key];
          continue;
        }
        if (!e.depositId) { held.add(e.wallet); continue; }
        if (held.has(e.wallet)) continue; // Never evaluate a receiver out of receipt order.
        delete s.unitCandidates[e.key];
        if (s.seen[e.depositId]) continue;
        s.seen[e.depositId] = e.at;
        const rows = (s.windows[e.wallet] || []).filter(r => r.at >= e.at - this.rules.minutes * 60000);
        rows.push(e); s.windows[e.wallet] = rows;
        const total = rows.reduce((sum,r) => sum + r.usd, 0);
        const accumulation = rows.length >= this.rules.count && total >= this.rules.total;
        if (!accumulation && e.usd < this.rules.single) continue;
        const short = `${e.wallet.slice(0,6)}...${e.wallet.slice(-4)}`;
        const amounts = [...new Set(rows.map(r => r.asset))].map(asset =>
          `${asset.toUpperCase()} ${money(rows.filter(r => r.asset === asset).reduce((sum,r) => sum + r.usd, 0))}`).join(' + ');
        s.pending.push({ alertId: `hyperunit:${e.depositId}`, chain: 'UNIT', wallet: e.wallet,
          walletLink: true, txHash: e.hash,
          title: accumulation ? 'Hyperunit — Deposit accumulation' : 'Hyperunit — Large deposit',
          body: `Receiving account: ${short}\n\n` + (accumulation ?
            `*${rows.length} deposits in ${this.rules.minutes} min*\nTotal received: *${money(total)}*\n${amounts}` :
            `${e.asset.toUpperCase()} deposit: *${money(e.usd)}*`) + '\nDestination: Hyperliquid',
        });
        queued++;
      }
      for (const [wallet, rows] of Object.entries(s.windows)) {
        // Pending operations for this wallet may still complete an older window.
        if (this.isBlocked(wallet)) delete s.windows[wallet];
        else if (!held.has(wallet)) {
          s.windows[wallet] = rows.filter(r => r.at >= through - this.rules.minutes * 60000);
          if (!s.windows[wallet].length) delete s.windows[wallet];
        }
      }
      for (const [id, at] of Object.entries(s.seen)) if (at < through - 30 * 86400000) delete s.seen[id];
      s.pending = s.pending.filter(a => !this.isBlocked(a.wallet));
    });
    return queued;
  }
  async poll() {
    await this.flush();
    const now = this.now(), start = this.store.data.cursors.UNIT?.at ?? now - 15 * 60000;
    const end = Math.min(now - 30000, start + 5 * 60000);
    let discovered = 0, matched = 0, lookupErrors = 0;
    if (end >= start && Object.keys(this.store.data.unitCandidates).length < 2000) {
      const found = [];
      for (const treasury of TREASURIES) {
        const rows = await collectLedger(this.ledger, treasury, start, end);
        for (const row of rows) { const e = candidate(row, treasury); if (e) found.push(e); }
      }
      this.store.update(s => {
        for (const e of found) if (!s.unitCandidates[e.key]) { s.unitCandidates[e.key] = e; discovered++; }
        s.cursors.UNIT = { at: end + 1 };
      });
    }
    const waiting = Object.values(this.store.data.unitCandidates).filter(e => !e.depositId && !this.isBlocked(e.wallet))
      .sort((a,b) => a.attempted - b.attempted || a.at - b.at);
    const wallets = [...new Set(waiting.map(e => e.wallet))].slice(0,20);
    for (const wallet of wallets) {
      let ops, rateLimited = false;
      try {
        const response = await this.operations(wallet);
        if (!Array.isArray(response?.operations)) throw Error('Invalid Unit operations');
        ops = response.operations;
      } catch (err) { lookupErrors++; rateLimited = err.response?.status === 429; }
      this.store.update(s => {
        for (const e of Object.values(s.unitCandidates).filter(e => e.wallet === wallet && !e.depositId)) {
          e.attempted = now;
          const resolved = ops && matchOperation(e, ops);
          if (resolved) { s.unitCandidates[e.key] = resolved; matched++; }
        }
      });
      if (rateLimited) break; // Do not spend the remaining lookup budget on a throttled endpoint.
    }
    const through = this.store.data.cursors.UNIT?.at ?? start;
    const queued = this.commitReady(through);
    await this.flush();
    const pending = Object.values(this.store.data.unitCandidates);
    this.lastScan = { through, lagSeconds: Math.max(0, Math.floor((now - through) / 1000)),
      discovered, matched, queued, pending: pending.length, lookupErrors,
      oldestPendingMinutes: pending.length ? Math.floor((now - Math.min(...pending.map(e => e.at))) / 60000) : 0 };
  }
}
module.exports = { TREASURIES, unitSettings, collectLedger, candidate, matchOperation, UnitMonitor };
