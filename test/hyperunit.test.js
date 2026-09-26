const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { ExchangeStore } = require('../src/monitors/exchangeCore');
const { TREASURIES, unitSettings, collectLedger, candidate, matchOperation, UnitMonitor } = require('../src/monitors/hyperunitCore');
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), NOW = Date.now();
function row(id, usd, at = NOW - 60000, asset = 0, wallet = A) {
  const t = TREASURIES[asset];
  return { time: at, hash: '0x' + id.toString(16).padStart(64, '0'), delta: {
    type: 'spotTransfer', token: t.token, user: t.address, destination: wallet,
    nonce: id, amount: '1.2', usdcValue: String(usd),
  } };
}
function operation(r, asset = 0) {
  const t = TREASURIES[asset];
  const hash = (asset ? '0x' : '') + r.delta.nonce.toString(16).padStart(64, '0') + ':0';
  return { operationId: hash, sourceTxHash: hash, destinationTxHash: `${t.address}:${r.delta.nonce}`,
    asset: t.asset, sourceChain: t.chain, destinationChain: 'hyperliquid',
    destinationAddress: r.delta.destination, state: 'done', sourceAddress: 'unrelated-source-' + r.delta.nonce };
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ExchangeStore(path.join(dir, 'state.json')), sent = [];
  const rows = options.rows || [];
  store.update(s => { s.cursors.UNIT = { at: NOW - 5 * 60000 }; });
  const args = { store, now: () => NOW, sendAlert: a => sent.push(a),
    ledger: async (user, start, end) => rows.filter(r => r.delta.user === user && r.time >= start && r.time <= end),
    operations: async wallet => ({ operations: rows.filter(r => r.delta.destination === wallet).map(r => operation(r, r.delta.token === 'UETH' ? 1 : 0)) }),
    ...options };
  return { store, sent, args, monitor: new UnitMonitor(args) };
}
test('50k single threshold is inclusive; different wallets do not consolidate', async t => {
  const f = fixture(t, { rows: [row(1,49999), row(2,50000,NOW-60000,1,B)] });
  await f.monitor.poll();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].wallet,B);
  assert.match(f.sent[0].title,/Large deposit/); assert.match(f.sent[0].body,/ETH deposit/);
});
test('three unrelated BTC/ETH deposits under 50k consolidate by destination at total 100k', async t => {
  const f = fixture(t, { rows: [row(1,40000,NOW-180000), row(2,35000,NOW-120000,1), row(3,25000)] });
  await f.monitor.poll();
  assert.equal(f.sent.length,1); assert.match(f.sent[0].title,/accumulation/);
  assert.match(f.sent[0].body,/3 deposits in 15 min/); assert.match(f.sent[0].body,/100,000/);
  assert.equal(f.sent[0].txHash,row(3,25000).hash);
  await f.monitor.poll(); assert.equal(f.sent.length,1);
});
test('two large deposits do not meet count; third yields one summary instead of duplicate single', async t => {
  const f = fixture(t, { rows: [row(1,50000,NOW-180000),row(2,50000,NOW-120000),row(3,50000)] });
  await f.monitor.poll(); assert.equal(f.sent.length,3);
  assert.match(f.sent[1].title,/Large/); assert.match(f.sent[2].title,/accumulation/);
});
test('receipt times enforce inclusive 15 minute boundary, not polling or source creation time', t => {
  const f = fixture(t);
  const insert = (id, at) => {
    const r = row(id,40000,at), e = matchOperation(candidate(r,TREASURIES[0]),[operation(r)]);
    f.store.update(s => { s.unitCandidates[e.key] = e; }); f.monitor.commitReady(at);
  };
  insert(1,NOW-900001); insert(2,NOW-900000); insert(3,NOW);
  assert.equal(f.store.data.pending.length,0);
  insert(4,NOW); assert.equal(f.store.data.pending.length,1);
  assert.match(f.store.data.pending[0].body,/120,000/);
});
test('pending verification survives restart and delays only that receiver, preserving chronological accumulation', async t => {
  const rows = [row(1,40000,NOW-180000),row(2,35000,NOW-120000),row(3,25000),row(4,50000,NOW-60000,0,B)];
  const f = fixture(t,{ rows, operations: async wallet => ({ operations: rows.filter(r => r.delta.nonce !== 1 && r.delta.destination === wallet).map(r => operation(r)) }) });
  await f.monitor.poll(); assert.equal(f.sent.length,1); assert.equal(f.sent[0].wallet,B);
  assert.equal(Object.keys(f.store.data.unitCandidates).length,3);
  const restarted = new UnitMonitor({ ...f.args, store: new ExchangeStore(f.store.file),
    operations: async () => ({ operations: rows.map(r => operation(r)) }) });
  await restarted.poll(); assert.equal(f.sent.length,2); assert.match(f.sent[1].body,/100,000/);
  await restarted.poll(); assert.equal(f.sent.length,2);
});
test('same source transaction cannot inflate deposit count through multiple outputs or repeated records', async t => {
  const rows = [row(1,40000), row(2,40000), row(3,40000)];
  const f = fixture(t,{ rows, operations: async () => ({ operations: rows.map(r => ({...operation(r),
    sourceTxHash: operation(rows[0]).sourceTxHash, operationId: operation(rows[0]).operationId })) }) });
  await f.monitor.poll(); assert.equal(f.sent.length,0); assert.equal(f.store.data.windows[A].length,1);
});
test('blocked destination is removed from windows, pending receipts and queued alerts', async t => {
  let blocked = false;
  const f = fixture(t,{rows:[row(1,40000)],isBlocked: w => blocked && w === A});
  await f.monitor.poll(); assert.equal(f.store.data.windows[A].length,1);
  blocked = true;
  f.store.update(s => { s.pending.push({alertId:'blocked',wallet:A}); });
  await f.monitor.poll(); assert.equal(f.sent.length,0); assert.equal(f.store.data.windows[A],undefined);
});
test('withdrawals, unrelated treasury transfers, SOL, incorrect nonce and unfinished operations never qualify', () => {
  const r = row(1,50000), e = candidate(r,TREASURIES[0]), op = operation(r);
  assert.equal(candidate({...r,delta:{...r.delta,user:A,destination:TREASURIES[0].address}},TREASURIES[0]),null);
  assert.equal(candidate({...r,delta:{...r.delta,token:'USOL'}},TREASURIES[0]),null);
  for (const patch of [{destinationTxHash:'wrong'}, {asset:'sol'}, {sourceChain:'hyperliquid'}, {state:'broadcastTx'}, {destinationAddress:B}])
    assert.equal(matchOperation(e,[{...op,...patch}]),null);
  assert.equal(matchOperation(e,[]),null);
});
test('500 record pages split without skipping shared timestamps; saturated timestamp rejects', async () => {
  const rows = Array.from({length:500},(_,i) => ({time:i < 250 ? 100 : 101}));
  const got = await collectLedger(async (_,start,end) => rows.filter(r=>r.time>=start&&r.time<=end),TREASURIES[0],100,101);
  assert.equal(got.length,500);
  await assert.rejects(collectLedger(async()=>Array.from({length:500},()=>({time:100})),TREASURIES[0],100,100),/saturated/);
});
test('invalid valuation or failure of the second treasury does not advance cursor', async t => {
  const f = fixture(t,{rows:[row(1,0)]}), cursor = f.store.data.cursors.UNIT.at;
  await assert.rejects(f.monitor.poll(),/USD value/); assert.equal(f.store.data.cursors.UNIT.at,cursor);
  f.monitor.ledger = async user => { if(user===TREASURIES[1].address) throw Error('outage'); return [row(2,50000)]; };
  await assert.rejects(f.monitor.poll(),/outage/); assert.equal(f.store.data.cursors.UNIT.at,cursor);
});
test('failed Telegram enqueue retains alert and restart retries it', async t => {
  const f = fixture(t,{rows:[row(1,50000)],sendAlert:()=>{throw Error('disk full');}});
  await assert.rejects(f.monitor.poll(),/disk full/); assert.equal(f.store.data.pending.length,1);
  const restarted = new UnitMonitor({...f.args,store:new ExchangeStore(f.store.file),sendAlert:a=>f.sent.push(a)});
  await restarted.poll(); assert.equal(f.sent.length,1); assert.equal(restarted.store.data.pending.length,0);
});
test('rules accept overrides and reject invalid count', () => {
  assert.equal(unitSettings({HYPERUNIT_ACCUM_MIN_USD:'150000'}).total,150000);
  assert.throws(()=>unitSettings({HYPERUNIT_ACCUM_COUNT:'2.5'}),/COUNT/);
});
test('Unit rate limits stop further lookups and retain candidates for retry', async t => {
  let calls = 0;
  const f = fixture(t,{rows:[row(1,50000),row(2,50000,NOW-60000,0,B)],operations:async()=>{
    calls++; const err = Error('throttled'); err.response={status:429}; throw err;
  }});
  await f.monitor.poll(); assert.equal(calls,1); assert.equal(f.monitor.lastScan.lookupErrors,1);
  assert.equal(Object.keys(f.store.data.unitCandidates).length,2); assert.equal(f.sent.length,0);
});
