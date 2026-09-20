const { normalizeWallet, tronFromHex } = require('../utils/addresses');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOKENS = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
};
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const hex = n => '0x' + n.toString(16);
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const word = /^0x[0-9a-f]{64}$/i;

class EthereumExchangeFeed {
  constructor({ engine, rpc, price, rules }) {
    Object.assign(this, { engine, rpc, price, rules }); this.blocks = new Map(); this.latest = null;
    this.addresses = engine.wallets.filter(w => w.chain === 'ETH').map(w => w.address);
  }
  observe(block) {
    if (!block?.number || !block.hash || !Array.isArray(block.transactions)) return;
    const n = Number(BigInt(block.number)); this.blocks.set(n, block);
    this.latest = Math.max(this.latest || 0, n); this.observedAt = Date.now();
    for (const num of this.blocks.keys()) if (num < this.latest - 80) this.blocks.delete(num);
  }
  async block(number) {
    const block = this.blocks.get(number) || await this.rpc('eth_getBlockByNumber', [hex(number), true]);
    if (!block?.hash || Number(BigInt(block.number)) !== number || !Array.isArray(block.transactions)) throw Error('Exchange ETH block unavailable');
    return block;
  }
  async poll() {
    // Reuse full blocks from the original EVM feed; no duplicate head polling.
    if (this.latest === null) return;
    if (Date.now() - this.observedAt > 300000) throw Error('Original Ethereum block feed is stale');
    const target = this.latest - this.rules.confirmations;
    if (target < 1) return;
    const cursor = this.engine.store.data.cursors.ETH;
    if (cursor && target < cursor.number) throw Error('Exchange ETH head behind saved cursor');
    if (cursor) {
      const canonical = await this.rpc('eth_getBlockByNumber', [hex(cursor.number), false]);
      if (canonical?.hash !== cursor.hash) throw Error('Exchange ETH reorganization detected; cursor retained for inspection');
    }
    const start = cursor ? cursor.number + 1 : target;
    const end = Math.min(target, start + this.rules.maxBlocks - 1);
    if (start > end) return;
    const blocks = [];
    let parent = cursor?.hash;
    for (let n = start; n <= end; n++) {
      const block = await this.block(n);
      if (parent && block.parentHash !== parent) throw Error('Exchange ETH block ancestry mismatch');
      blocks.push(block); parent = block.hash;
    }
    const logs = [];
    for (const topics of [[TRANSFER, null, this.addresses.map(topic)], [TRANSFER, this.addresses.map(topic)]]) {
      const result = await this.rpc('eth_getLogs', [{ fromBlock: hex(start), toBlock: hex(end), address: Object.keys(TOKENS), topics }]);
      if (!Array.isArray(result)) throw Error('Invalid exchange token log response');
      logs.push(...result);
    }
    const events = [], quotes = new Map();
    const value = async (raw, decimals, symbol) => {
      if (!quotes.has(symbol)) {
        const quote = await this.price(symbol);
        if (!(quote > 0) || !Number.isFinite(quote)) throw Error(`Exchange ${symbol} price unavailable; retaining cursor`);
        quotes.set(symbol, quote);
      }
      return Number(BigInt(raw)) / 10 ** decimals * quotes.get(symbol);
    };
    for (const block of blocks) {
      const number = Number(BigInt(block.number)), at = Number(BigInt(block.timestamp)) * 1000;
      if (!Number.isFinite(at)) throw Error('Invalid exchange block timestamp');
      for (const tx of block.transactions) {
        const from = normalizeWallet(tx.from), to = normalizeWallet(tx.to);
        if (!from || !to || (!this.addresses.includes(from) && !this.addresses.includes(to)) || BigInt(tx.value || '0') === 0n) continue;
        const usd = await value(tx.value, 18, 'ETH');
        if (usd < Math.min(this.rules.min, this.rules.fanoutMin)) continue;
        const receipt = await this.rpc('eth_getTransactionReceipt', [tx.hash]);
        if (!receipt || receipt.blockHash !== block.hash || receipt.transactionHash !== tx.hash || !['0x0','0x1'].includes(receipt.status)) throw Error('Exchange ETH receipt missing or mismatched');
        if (receipt.status !== '0x1') continue;
        events.push({ id: tx.hash, hash: tx.hash, chain: 'ETH', symbol: 'ETH', from, to, usd, at, order: Number(BigInt(tx.transactionIndex || '0')) * 100000 });
      }
      for (const log of logs.filter(l => Number(BigInt(l.blockNumber)) === number)) {
        if (log.removed || log.blockHash !== block.hash) throw Error('Exchange token log ancestry mismatch');
        if (!block.transactions.some(tx => tx.hash === log.transactionHash)) throw Error('Exchange token transaction missing from block');
        const token = TOKENS[log.address?.toLowerCase()];
        if (!token || log.topics?.[0] !== TRANSFER || log.topics.length !== 3 || !log.topics.slice(1).every(t => word.test(t)) || !word.test(log.data)) throw Error('Malformed exchange token transfer');
        const from = '0x' + log.topics[1].slice(-40), to = '0x' + log.topics[2].slice(-40);
        if (!this.addresses.includes(from.toLowerCase()) && !this.addresses.includes(to.toLowerCase())) throw Error('Token result outside watched wallets');
        const usd = await value(log.data, token.decimals, token.symbol);
        events.push({ id: `${log.transactionHash}:${log.logIndex}`, hash: log.transactionHash, chain: 'ETH', symbol: token.symbol, from, to, usd, at,
          order: Number(BigInt(log.transactionIndex || '0')) * 100000 + Number(BigInt(log.logIndex)) + 1 });
      }
    }
    if (logs.some(l => Number(BigInt(l.blockNumber)) < start || Number(BigInt(l.blockNumber)) > end)) throw Error('Exchange logs outside requested range');
    this.engine.commit(events, { ETH: { number: end, hash: parent } }, { ETH: { ok: true, block: end, lagBlocks: target - end, checkedAt: Date.now() } });
  }
}

class TronExchangeFeed {
  constructor({ engine, request, price, rules, now = Date.now }) { Object.assign(this, { engine, request, price, rules, now }); }
  async pages(wallet, token, start, end) {
    let fingerprint; const rows = [], fingerprints = new Set();
    for (let page = 0; page < this.rules.maxPages; page++) {
      const result = await this.request(`/v1/accounts/${wallet}/transactions${token ? '/trc20' : ''}`, {
        only_confirmed: true, limit: 200, order_by: 'block_timestamp,asc',
        min_timestamp: start, max_timestamp: end, ...(token ? { contract_address: TRON_USDT } : {}), ...(fingerprint ? { fingerprint } : {}),
      });
      if (result?.success !== true || !Array.isArray(result.data)) throw Error('TronGrid did not return a valid success page');
      rows.push(...result.data); fingerprint = result.meta?.fingerprint;
      if (!fingerprint) return rows;
      if (fingerprints.has(fingerprint)) throw Error('TronGrid pagination repeated; retaining cursor');
      fingerprints.add(fingerprint);
    }
    throw Error('TronGrid page limit reached; retaining cursor (increase EXCHANGE_TRON_MAX_PAGES if needed)');
  }
  async poll() {
    const now = this.now(), cursor = this.engine.store.data.cursors.TRON;
    // Confirmed results only; two-minute overlap allows indexing delays and is deduplicated.
    const start = Math.max(0, (cursor?.at ?? now - 60000) - 120000);
    const end = Math.min(now - 30000, (cursor?.at ?? now - 60000) + 300000);
    if (end <= start) return;
    const events = [], quotes = new Map();
    const usdValue = async (amount, symbol) => {
      if (!quotes.has(symbol)) {
        const quote = await this.price(symbol);
        if (!(quote > 0) || !Number.isFinite(quote)) throw Error(`Exchange ${symbol} price unavailable; retaining cursor`);
        quotes.set(symbol, quote);
      }
      return Number(BigInt(amount)) / 1e6 * quotes.get(symbol);
    };
    for (const wallet of this.engine.wallets.filter(w => w.chain === 'TRON')) {
      const transfers = await this.pages(wallet.address, true, start, end);
      for (const row of transfers) {
        if (row.type !== 'Transfer' || row.token_info?.address !== TRON_USDT) continue;
        if (!row.transaction_id || !Number.isSafeInteger(row.block_timestamp) || row.block_timestamp <= 0) throw Error('Invalid TronGrid token timestamp/identity');
        // The indexer can return boundary records outside millisecond filters.
        // Apply the exact window locally; retain pagination and overlap dedup.
        if (row.block_timestamp < start || row.block_timestamp > end) continue;
        if (row.from !== wallet.address && row.to !== wallet.address) throw Error('TronGrid transfer outside requested wallet');
        events.push({ chain: 'TRON', symbol: 'USDT', hash: row.transaction_id,
          id: `${row.transaction_id}:${row.event_index ?? `${row.from}:${row.to}:${row.value}`}:USDT`,
          from: row.from, to: row.to, at: row.block_timestamp, usd: await usdValue(row.value, 'USDT') });
      }
      const transactions = await this.pages(wallet.address, false, start, end);
      for (const tx of transactions) {
        if (tx.ret?.[0]?.contractRet !== 'SUCCESS') continue;
        if (!tx.txID || !Number.isSafeInteger(tx.block_timestamp) || tx.block_timestamp <= 0) throw Error('Invalid TronGrid native timestamp/identity');
        if (tx.block_timestamp < start || tx.block_timestamp > end) continue;
        for (const [index,contract] of (tx.raw_data?.contract || []).entries()) {
          if (contract.type !== 'TransferContract') continue; // Native TRX only; not internal contract transfers.
          const fields = contract.parameter?.value;
          const from = tronFromHex(fields?.owner_address), to = tronFromHex(fields?.to_address);
          if (!from || !to) throw Error('Invalid TRX transfer address');
          if (from !== wallet.address && to !== wallet.address) continue;
          events.push({ chain: 'TRON', symbol: 'TRX', hash: tx.txID, id: `${tx.txID}:${index}:TRX`, from, to, at: tx.block_timestamp, usd: await usdValue(fields.amount, 'TRX') });
        }
      }
    }
    this.engine.commit(events, { TRON: { at: end } }, { TRON: { ok: true, through: end, checkedAt: now } });
  }
}
module.exports = { EthereumExchangeFeed, TronExchangeFeed, TOKENS, TRON_USDT, TRANSFER };
