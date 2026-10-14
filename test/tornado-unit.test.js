const { test } = require('node:test');
const assert = require('node:assert/strict');
const { POOL, TOPIC, matchTornadoUnit } = require('../src/monitors/tornadoUnit');
const A = '0x60ca02bc35a874ee4a2388896d4e10cffdb010c9';
const B = '0xd44dfdd7db2dbcc1815c52804fcde27b6c8f296b';
const D = '0x' + '3'.repeat(40), H = '0x' + 'a'.repeat(64), W = '0x' + 'b'.repeat(64);
function fixture() {
  const e = { asset: 'eth', sourceChain: 'ethereum', source: A, wallet: B, protocolAddress: D, sourceHash: H };
  const tx = { hash: H, from: A, to: D, value: '0x56bc75e2d63100000', blockHash: H, blockNumber: '0x100' };
  const receipt = { transactionHash: H, blockHash: H, blockNumber: '0x100', transactionIndex: '0x2', status: '0x1' };
  const withdrawal = { transactionHash: W, blockHash: W, blockNumber: '0xff', transactionIndex: '0x1', status: '0x1', logs: [
    { address: POOL, topics: [TOPIC, '0x' + B.slice(2).padStart(64,'0')], data: '0x' + A.slice(2).padStart(64,'0') + '0'.repeat(128) },
  ] };
  const rows = [{ from: POOL, to: A, hash: W, timeStamp: '999900' }];
  const options = {
    history: async () => ({ status: '1', result: rows }),
    rpc: async (method, args) => {
      if (method === 'eth_getTransactionByHash') return tx;
      if (method === 'eth_getTransactionReceipt') return args[0] === H ? receipt : withdrawal;
      if (method === 'eth_blockNumber') return '0x110';
      if (method === 'eth_getBlockByNumber') return args[0] === '0x100' ? { hash: H, timestamp: '0xf4240' } : { hash: W, timestamp: '0xf41dc' };
      throw Error(method);
    },
  };
  return { e, tx, receipt, withdrawal, rows, options };
}
test('matches actual TC100 recipient to direct Unit deposit even with a different receiving account', async () => {
  const f = fixture(), m = await matchTornadoUnit(f.e, f.options);
  assert.equal(m.source,A); assert.equal(m.account,B); assert.equal(m.withdrawalHash,W); assert.equal(m.depositEth,100);
});
test('does not mistake relayer, another pool or another sender for recipient', async () => {
  for (const mutate of [f => f.withdrawal.logs[0].data = '0x' + B.slice(2).padStart(64,'0') + '0'.repeat(128),
    f => f.withdrawal.logs[0].address = D, f => f.tx.from = B, f => f.tx.to = B,
    f => f.withdrawal.logs[0].removed = true, f => f.withdrawal.status = '0x0']) {
    const f = fixture(); mutate(f); assert.equal(await matchTornadoUnit(f.e,f.options),null);
  }
});
test('rejects later withdrawal and withdrawals outside lookback', async () => {
  for (const mutate of [f => f.withdrawal.blockNumber = '0x101', f => f.rows[0].timeStamp = '1',
    f => { f.withdrawal.blockNumber = '0x100'; f.withdrawal.transactionIndex = '0x3'; }]) {
    const f = fixture(); mutate(f); assert.equal(await matchTornadoUnit(f.e,f.options),null);
  }
});
test('unavailable, unconfirmed, inconsistent and truncated evidence must retry', async () => {
  for (const mutate of [f => f.options.history = async () => ({ status: '0', result: 'rate limit' }),
    f => f.receipt.blockHash = W,
    f => { const rpc = f.options.rpc; f.options.rpc = async (m,p) => m === 'eth_blockNumber' ? '0x101' : rpc(m,p); },
    f => f.withdrawal.blockHash = H,
    f => { f.rows.splice(0,1,...Array.from({ length:100 },() => ({ from:D, to:A, hash:W, timeStamp:'999900' }))); f.options.maxPages=1; }]) {
    const f = fixture(); mutate(f); await assert.rejects(matchTornadoUnit(f.e,f.options));
  }
});
