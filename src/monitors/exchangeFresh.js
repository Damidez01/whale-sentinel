const { normalizeWallet } = require('../utils/addresses');

class FreshDeposits {
  constructor({ engine, rules, rpc, request }) { Object.assign(this, { engine, rules, rpc, request }); }
  async inspect(e) {
    const limit = this.rules.freshMaxTx + 1, rows = [];
    let truncated = false;
    if (e.chain === 'ETH') {
      const tag = '0x' + e.blockNumber.toString(16);
      const code = await this.rpc('eth_getCode', [e.from, tag]);
      if (code !== '0x') return false;
      const nonce = await this.rpc('eth_getTransactionCount', [e.from, tag]);
      if (!/^0x[0-9a-f]+$/i.test(nonce)) throw Error('Fresh deposit nonce unavailable');
      if (BigInt(nonce) > BigInt(this.rules.freshMaxTx)) return false;
      for (const direction of ['fromAddress', 'toAddress']) {
        const result = await this.rpc('alchemy_getAssetTransfers', [{ fromBlock: '0x0', toBlock: tag,
          [direction]: e.from, category: ['external','internal','erc20','erc721','erc1155'],
          order: 'asc', withMetadata: true, excludeZeroValue: false, maxCount: '0x' + limit.toString(16) }]);
        if (!Array.isArray(result?.transfers)) throw Error('Fresh deposit ETH history unavailable');
        truncated ||= !!result.pageKey;
        for (const row of result.transfers) rows.push({ hash: row.hash, at: Date.parse(row.metadata?.blockTimestamp) });
      }
    } else {
      for (const suffix of ['', '/trc20']) {
        const result = await this.request(`/v1/accounts/${e.from}/transactions${suffix}`, {
          only_confirmed: true, limit, order_by: 'block_timestamp,asc', min_timestamp: 0, max_timestamp: e.at,
        });
        if (result?.success !== true || !Array.isArray(result.data)) throw Error('Fresh deposit TRON history unavailable');
        truncated ||= !!result.meta?.fingerprint;
        for (const row of result.data) rows.push({ hash: row.txID || row.transaction_id, at: row.block_timestamp });
      }
    }
    if (rows.some(r => !r.hash || !Number.isFinite(r.at) || r.at <= 0)) throw Error('Fresh deposit history has invalid identity/timestamp');
    const eligible = rows.filter(r => r.at <= e.at);
    if (truncated || new Set(eligible.map(r => r.hash)).size > this.rules.freshMaxTx) return false;
    if (!eligible.some(r => r.hash.toLowerCase() === e.hash.toLowerCase())) throw Error('Fresh deposit history has not indexed the deposit yet');
    return e.at - Math.min(...eligible.map(r => r.at)) <= this.rules.freshMaxHours * 3600000;
  }
  async filter(events) {
    if (!this.rules.freshOnly) return events;
    const result = [];
    for (const raw of events) {
      const e = { ...raw, from: normalizeWallet(raw.from), to: normalizeWallet(raw.to) };
      const incoming = this.engine.wallets.some(w => w.chain === e.chain && w.address === e.to);
      if (!incoming || e.usd < this.rules.min) { result.push(e); continue; }
      if (this.engine.isBlocked(e.from) || this.engine.isBlocked(e.to)) continue;
      const key = `${e.chain}:${e.from}:${e.hash}:${this.rules.freshMaxTx}:${this.rules.freshMaxHours}`;
      let verdict = this.engine.store.data.freshChecks?.[key];
      if (!verdict) {
        verdict = { ok: await this.inspect(e), at: Date.now() };
        this.engine.store.update(s => {
          s.freshChecks ||= {}; s.freshChecks[key] = verdict;
          for (const [k,v] of Object.entries(s.freshChecks)) if (v.at < Date.now() - 2 * 86400000) delete s.freshChecks[k];
          for (const k of Object.keys(s.freshChecks).slice(0, -10000)) delete s.freshChecks[k];
        });
      }
      result.push({ ...e, freshApproved: verdict.ok });
    }
    return result;
  }
}
module.exports = { FreshDeposits };
