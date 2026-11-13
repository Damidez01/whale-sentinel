const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectDormancy, MONTH_MS } = require('../src/monitors/dormancy');
const NOW = Math.floor(Date.now() / 1000) * 1000, A = '0x' + '1'.repeat(40);
const tx = { from: A, hash: 'current', nonce: '0x5', blockNumber: '0x64', blockHash: 'block' };
const current = { ...tx, nonce: '5', blockNumber: '100', timeStamp: String(NOW / 1000), isError: '0', txreceipt_status: '1' };
const prior = (months, extra = {}) => ({ from: A, hash: 'previous', nonce: '4', blockNumber: '1',
  timeStamp: String((NOW - months * MONTH_MS) / 1000), value: '0', ...extra });
const inspect = (rows, extra = {}) => inspectDormancy(tx, { months: 6, request: async () => ({ status: '1', result: rows }), ...extra });

test('six-month inactivity is verifiable on first run without a local seen key', async () => {
  const result = await inspect([current, prior(6)]);
  assert.equal(result.months, 6); assert.equal(result.eventAt, NOW); assert.equal(result.previousHash, 'previous');
  assert.equal(await inspect([current, prior(5)]), null);
});
test('small transactions, zero-value contract calls and failed sends all interrupt outgoing inactivity', async () => {
  for (const extra of [{ value: '1' }, { value: '0', input: '0xa9059cbb' }, { isError: '1', txreceipt_status: '0' }])
    assert.equal(await inspect([current, prior(0.1, extra), prior(8, { nonce: '3' })]), null);
});
test('incoming transactions do not reset outgoing inactivity and history pages are followed', async () => {
  const incoming = { from: 'other', to: A, hash: 'in', timeStamp: String(NOW / 1000) };
  let calls = 0;
  const result = await inspect([], { request: async params => {
    calls++; assert.equal(params.endblock, 100); assert.equal(params.sort, 'desc');
    return { status: '1', result: params.page === 1 ? [current, ...Array(99).fill(incoming)] : [prior(7)] };
  } });
  assert.equal(calls, 2); assert.equal(result.months, 7);
});
test('new sender, failed triggering transaction and recent same-block send do not alert', async () => {
  assert.equal(await inspectDormancy({ ...tx, nonce: '0x0' }, { months: 6, request: () => { throw Error('unused'); } }), null);
  assert.equal(await inspect([{ ...current, isError: '1', txreceipt_status: '0' }, prior(7)]), null);
  assert.equal(await inspect([current, prior(0, { blockNumber: '100' })]), null);
});
test('API errors, absent current transaction, missing nonce and truncated history never establish dormancy', async () => {
  await assert.rejects(inspect([], { request: async () => ({ status: '0', result: 'rate limit' }) }), /unavailable/);
  await assert.rejects(inspect([prior(7)]), /incomplete/);
  await assert.rejects(inspect([current, prior(7, { nonce: '3' })]), /incomplete/);
  await assert.rejects(inspect([current, prior(7)], { request: async () => { throw Error('offline'); } }), /offline/);
  let calls = 0;
  await assert.rejects(inspect([], { request: async () => { calls++; return { status: '1', result: Array(100).fill(current) }; } }), /incomplete/);
  assert.equal(calls, 5);
});
test('mismatched block, unknown receipt success and invalid dates are rejected', async () => {
  await assert.rejects(inspect([{ ...current, blockHash: 'wrong' }, prior(7)]), /does not match/);
  await assert.rejects(inspect([{ ...current, txreceipt_status: '' }, prior(7)]), /unverified/);
  await assert.rejects(inspect([current, prior(7, { timeStamp: 'invalid' })]), /timestamp/);
});
