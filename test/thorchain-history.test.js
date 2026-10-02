const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessThorHistory } = require('../src/monitors/thorchainHistory');
const { thorSettings } = require('../src/monitors/thorchainCore');
const NOW = Date.now(), A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
const event = { id: 'CURRENT', wallet: A, at: NOW };
const swap = (id, time = NOW - 60000, extra = {}) => ({ type: 'swap', status: 'success', date: String(BigInt(time) * 1000000n),
  in: [{ address: A, txID: id }], out: [], ...extra });
const row = (id, extra = {}) => ({ hash: id, from: A, to: B, timeStamp: String(Math.floor((NOW - 60000) / 1000)), ...extra });
function check(options = {}) {
  return assessThorHistory(event, { rules: thorSettings({}), request: async () => ({ actions: [] }),
    ethereum: async () => ({ status: '1', result: [] }), ...options });
}
test('THOR history allows two prior swaps and ten distinct Ethereum transactions across transfer categories', async () => {
  const actions = [];
  const result = await check({ request: async p => { assert.equal(p.address, A); assert.equal(p.asset, undefined); return { actions: [swap('1'),swap('2')] }; },
    ethereum: async p => { actions.push(p.action); return { status: '1', result: Array.from({ length: 10 }, (_, i) => row('tx' + i)) }; } });
  assert.equal(result.eligible, true); assert.equal(result.priorSwaps, 2); assert.equal(result.ethTransactions, 10);
  assert.deepEqual(actions, ['txlist','txlistinternal','tokentx','tokennfttx','token1155tx']);
});
test('frequent THOR users are rejected before Ethereum queries, including receiving-side history', async () => {
  const result = await check({ request: async () => ({ actions: [swap('1'),swap('2'),swap('3', NOW-60000,
    { in: [{ address: 'bc1source', txID: '3' }], out: [{ address: A }] })] }),
    ethereum: () => { throw Error('unnecessary query'); } });
  assert.equal(result.eligible, false); assert.equal(result.reason, 'prior-swaps');
});
test('first-time THOR users with busy Ethereum wallets are excluded', async () => {
  const result = await check({ ethereum: async () => ({ status: '1', result: Array.from({ length: 11 }, (_, i) => row('tx'+i)) }) });
  assert.equal(result.reason, 'ethereum-history');
});
test('current swaps, same-time swaps, refunds and repeated records do not inflate prior counts', async () => {
  const result = await check({ request: async () => ({ actions: [swap('CURRENT', NOW-1),swap('1'),swap('1'),swap('same', NOW),swap('r', NOW-1,{type:'refund'})] }),
    ethereum: async () => ({ status: '1', result: [row('old'),row('old'),row('later',{timeStamp:String(Math.ceil(NOW/1000)+1)})] }) });
  assert.equal(result.priorSwaps, 1); assert.equal(result.ethTransactions, 1);
});
test('THOR history follows pagination; repeated, missing and capped pages stay unknown', async () => {
  let calls = 0;
  const result = await check({ request: async p => { calls++; return p.nextPageToken ? { actions: [swap('2')] } : { actions: [swap('1')], meta: { nextPageToken: 'page2' } }; } });
  assert.equal(result.priorSwaps, 2); assert.equal(calls, 2);
  await assert.rejects(check({ request: async () => ({ actions: [swap('1')], meta: { nextPageToken: 'repeat' } }) }), /stalled/);
  await assert.rejects(check({ request: async () => ({ actions: Array(50).fill(swap('1')) }) }), /truncated/);
  await assert.rejects(check({ rules: { ...thorSettings({}), historyMaxPages: 1 }, request: async () => ({ actions: [swap('1')], meta: { nextPageToken: 'more' } }) }), /budget/);
});
test('provider errors and ambiguous Ethereum pages cannot establish low activity', async () => {
  await assert.rejects(check({ ethereum: async () => ({ status: '0', message: 'NOTOK', result: 'rate limit' }) }), /unavailable/);
  await assert.rejects(check({ ethereum: async () => ({ status: '1', result: Array(100).fill(row('same')) }) }), /truncated/);
  await assert.rejects(check({ ethereum: async () => ({ status: '1', result: [row('bad',{timeStamp:'bad'})] }) }), /Invalid/);
  await assert.rejects(check({ request: async () => ({ actions: [swap('bad', NOW-1,{in:[{address:B,txID:'bad'}]})] }) }), /outside/);
  assert.equal((await check({ ethereum: async () => ({ status: '0', message: 'No transactions found', result: [] }) })).eligible,true);
});
test('THOR history thresholds allow first-use-only settings and reject invalid limits', () => {
  assert.equal(thorSettings({THORCHAIN_MAX_PRIOR_SWAPS:'0'}).maxPriorSwaps,0);
  for(const key of ['THORCHAIN_MAX_PRIOR_SWAPS','THORCHAIN_MAX_PRIOR_ETH_TXS'])
    for(const value of ['-1','1.5','NaN'])assert.throws(()=>thorSettings({[key]:value}),/Invalid/);
});
