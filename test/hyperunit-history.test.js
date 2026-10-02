const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessHistory } = require('../src/monitors/hyperunitHistory');
const { unitSettings } = require('../src/monitors/hyperunitCore');
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), NOW = Date.now();
const event = { wallet: A, at: NOW, operationAt: NOW - 1000 };
const operation = (i, extra = {}) => ({ operationId: 'op' + i, state: 'done',
  opCreatedAt: new Date(NOW - 60000).toISOString(), sourceChain: 'bitcoin', destinationChain: 'hyperliquid',
  destinationAddress: A, asset: 'btc', ...extra });
const transfer = i => ({ time: NOW - 60000, hash: 'tx' + i, delta: { type: 'spotTransfer' } });
const trade = i => ({ time: NOW - 60000, oid: i, coin: 'BTC' });
function check(extra = {}) {
  return assessHistory({ event, rules: unitSettings({}), operations: [], ledger: async () => [], fills: async () => [], ...extra });
}

test('new wallets qualify; all three prior-history thresholds are inclusive', async () => {
  assert.equal((await check()).eligible, true);
  const result = await check({ operations: [operation(1), operation(2)],
    ledger: async (wallet, start, end) => {
      assert.equal(wallet, A); assert.equal(start, 0); assert.equal(end, event.operationAt - 1);
      return Array.from({ length: 10 }, (_, i) => transfer(i));
    }, fills: async () => Array.from({ length: 10 }, (_, i) => trade(i)) });
  assert.equal(result.eligible, true); assert.equal(result.unitOperations, 2);
  assert.equal(result.ledgerTransactions, 10); assert.equal(result.executedTrades, 10);
});

test('third Unit operation excludes deposits and withdrawals across assets before expensive HL queries', async () => {
  const result = await check({ operations: [operation(1), operation(2, { asset: 'sol' }),
    operation(3, { asset: 'eth', sourceChain: 'hyperliquid', sourceAddress: A, destinationChain: 'ethereum', destinationAddress: B })],
    ledger: () => { throw Error('must not query ledger'); } });
  assert.equal(result.eligible, false); assert.equal(result.reason, 'unit-history');
});

test('first-time Unit users are excluded by either high ledger activity or high trading activity', async () => {
  assert.equal((await check({ ledger: async () => Array.from({ length: 11 }, (_, i) => transfer(i)),
    fills: () => { throw Error('must not query fills'); } })).reason, 'hl-ledger-history');
  assert.equal((await check({ fills: async () => Array.from({ length: 11 }, (_, i) => trade(i)) })).reason, 'hl-trade-history');
});

test('counts exclude current/later activity, failed operations, unrelated accounts and duplicate rows', async () => {
  const result = await check({ operations: [operation(1), operation(1), operation(2, { state: 'failure' }),
    operation(3, { destinationAddress: B }), operation(4, { opCreatedAt: new Date(event.operationAt).toISOString() })],
    ledger: async () => [transfer(1), transfer(1), { ...transfer(2), time: NOW }],
    fills: async () => [trade(1), trade(1), { ...trade(2), time: NOW }] });
  assert.equal(result.unitOperations, 1); assert.equal(result.ledgerTransactions, 1); assert.equal(result.executedTrades, 1);
});

test('missing, malformed and capped histories are unknown rather than low activity', async () => {
  await assert.rejects(check({ event: { ...event, operationAt: NaN } }), /operation time/);
  await assert.rejects(check({ operations: [operation(1, { opCreatedAt: null })] }), /Incomplete Unit/);
  await assert.rejects(check({ operations: Array.from({ length: 100 }, (_, i) => operation(i, { state: 'failure' })) }), /truncated/);
  await assert.rejects(check({ ledger: async () => null }), /unavailable/);
  await assert.rejects(check({ ledger: async () => [{}] }), /Incomplete/);
  await assert.rejects(check({ ledger: async () => Array.from({ length: 500 }, () => transfer(1)) }), /truncated/);
  await assert.rejects(check({ fills: async () => ({}) }), /unavailable/);
  await assert.rejects(check({ fills: async () => [{ time: NOW }] }), /Incomplete/);
  await assert.rejects(check({ fills: async () => Array.from({ length: 2000 }, (_, i) => ({ ...trade(i), time: NOW })) }), /truncated/);
});

test('configured limits accept zero and reject negative, fractional and nonnumeric counts', async () => {
  const rules = unitSettings({ HYPERUNIT_MAX_PRIOR_OPERATIONS: '0', HYPERUNIT_MAX_PRIOR_HL_TRANSFERS: '0', HYPERUNIT_MAX_PRIOR_HL_TRADES: '0' });
  assert.equal((await check({ rules })).eligible, true);
  assert.equal((await check({ rules, operations: [operation(1)] })).eligible, false);
  for (const key of ['HYPERUNIT_MAX_PRIOR_OPERATIONS', 'HYPERUNIT_MAX_PRIOR_HL_TRANSFERS', 'HYPERUNIT_MAX_PRIOR_HL_TRADES'])
    for (const value of ['-1', '1.5', 'NaN']) assert.throws(() => unitSettings({ [key]: value }), /history limit/);
});
