const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { MAX_AGE_MS, cutoff } = require('../src/utils/freshness');
const { DurableState, Delivery } = require('../src/alerts/durable');
const { ExchangeStore, ExchangeEngine, settings } = require('../src/monitors/exchangeCore');
const { EthereumExchangeFeed, TronExchangeFeed } = require('../src/monitors/exchangeFeeds');
const { UnitMonitor } = require('../src/monitors/hyperunitCore');
const { ThorMonitor, thorSettings } = require('../src/monitors/thorchainCore');
const NOW = Date.now(), OLD = NOW - 3 * 86400000;
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
function store(t, Type = ExchangeStore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Type(path.join(dir, 'state.json'));
}

test('Telegram restart expires old queue and event timestamps while retaining blocks and recent retries', async t => {
  const s = store(t, DurableState), sent = [];
  s.update(d => {
    d.blocked[A] = { until: 0 }; d.sent.already = NOW + 60000;
    d.queue = [
      { id: 'legacy', alert: { body: 'old' }, at: OLD, nextAttempt: 0 },
      { id: 'historical', alert: { eventAt: OLD }, at: NOW, nextAttempt: 0 },
      { id: 'recent', alert: { eventAt: NOW - 60000 }, at: NOW, nextAttempt: NOW + 1000 },
    ];
  });
  const resumed = new DurableState(s.file);
  let now = NOW;
  const d = new Delivery(resumed, { now: () => now, render: a => a, send: async a => sent.push(a) });
  await d.tick(); assert.deepEqual(resumed.data.queue.map(x => x.id), ['recent']);
  assert.equal(resumed.isBlocked(A), true); assert.equal(resumed.data.sent.already, NOW + 60000);
  assert.equal(d.enqueue({ eventAt: OLD }), false);
  now += 1000; await d.tick(); assert.equal(sent.length, 1);
});

test('rate-limited delivery expires before retry instead of refreshing event age', async t => {
  const s = store(t, DurableState); let now = NOW, calls = 0;
  const d = new Delivery(s, { now: () => now, render: a => a, send: async () => {
    calls++; throw { response: { body: { error_code: 429, parameters: { retry_after: 60 } } } };
  } });
  d.enqueue({ eventAt: NOW - MAX_AGE_MS + 1000 }); await d.tick();
  now += 61000; await d.tick(); assert.equal(calls, 1); assert.equal(s.data.queue.length, 0);
});

test('Telegram upgrade discards legacy scanner alerts even with recent enqueue time', t => {
  const s = store(t, DurableState);
  s.update(d => { d.queue = ['cf:single:x', 'thor:swap:x', 'hyperunit:x', 'exchange:x'].map(id =>
    ({ id, alert: { alertId: id }, at: NOW, nextAttempt: 0 }));
    d.queue.push({ id: 'fresh', alert: { alertId: 'cf:single:new', eventAt: NOW }, at: NOW, nextAttempt: 0 });
    d.queue.push({ id: 'reply', alert: { text: 'Saved' }, at: NOW, nextAttempt: 0 });
  });
  const sandbox = { module: { exports: {} }, process: { env: {} }, require: name => {
    if (name === 'node-telegram-bot-api') return class {};
    if (name === 'path') return path;
    if (name === './durable') return { DurableState: class { constructor() { return s; } }, Delivery };
    if (name === './commands') return { commandHandler: () => () => {} };
    if (name === '../utils/addresses') return require('../src/utils/addresses');
    return {};
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/alerts/telegram.js'), 'utf8'), sandbox);
  assert.deepEqual(s.data.queue.map(x => x.id), ['fresh', 'reply']);
});

test('Unit clamps three-day cursor and drops expired candidates and pending alerts before lookup', async t => {
  const s = store(t), ranges = [];
  s.update(d => {
    d.cursors.UNIT = { at: OLD }; d.unitCandidates = { old: { key: 'old', at: OLD, wallet: A } };
    d.pending = [{ alertId: 'hyperunit:old', eventAt: OLD }, { alertId: 'hyperunit:legacy' }];
  });
  const monitor = new UnitMonitor({ store: s, now: () => NOW,
    ledger: async (address, start, end) => { ranges.push([start, end]); return []; },
    operations: () => { throw Error('must not look up old candidate'); },
    sendAlert: () => { throw Error('must not send old alert'); } });
  await monitor.poll(); assert.ok(ranges.every(([start]) => start === cutoff(NOW)));
  assert.equal(Object.keys(s.data.unitCandidates).length, 0); assert.equal(s.data.pending.length, 0);
  assert.ok(s.data.cursors.UNIT.at > cutoff(NOW));
});

test('THOR clamps backlog and expires pending swaps without fetching or alerting them', async t => {
  const s = store(t), requests = [];
  s.update(d => { d.cursors.THOR = { at: OLD }; d.thorPending = { OLD: { at: OLD, checkedAt: 0 } };
    d.pending = [{ alertId: 'thor:old', eventAt: OLD }]; d.seen.saved = NOW; });
  const monitor = new ThorMonitor({ store: s, rules: thorSettings({}), now: () => NOW,
    sendAlert: () => { throw Error('old alert'); }, request: async p => { requests.push(p); return { actions: [] }; } });
  await monitor.poll(); assert.ok(requests.every(p => !p.txid));
  assert.equal(Object.keys(s.data.thorPending).length, 0); assert.equal(s.data.seen.saved, NOW);
  assert.equal(s.data.cursors.THOR.at, cutoff(NOW) + 600000);
});

test('TRON clamps saved scan position to recent window', async t => {
  const s = store(t), ranges = [];
  s.update(d => { d.cursors.TRON = { at: OLD }; });
  const engine = new ExchangeEngine(s, [{ chain: 'TRON', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }], settings({}));
  const feed = new TronExchangeFeed({ engine, rules: settings({}), now: () => NOW,
    request: async (route, p) => { ranges.push(p); return { success: true, data: [] }; } });
  await feed.poll(); assert.ok(ranges.length); assert.ok(ranges.every(p => p.min_timestamp === cutoff(NOW)));
  assert.equal(s.data.cursors.TRON.at, cutoff(NOW) + 300000);
});

test('ETH skips stale cursor only after confirmed target is successfully read', async t => {
  const s = store(t), rules = settings({});
  s.update(d => { d.cursors.ETH = { number: 10, hash: 'old' }; });
  const engine = new ExchangeEngine(s, [{ chain: 'ETH', address: A }], rules);
  let fail = true;
  const feed = new EthereumExchangeFeed({ engine, rules, rpc: async (method, args) => {
    assert.equal(method, 'eth_getBlockByNumber');
    if (args[0] === '0xa') return { hash: 'old', timestamp: '0x' + Math.floor(OLD / 1000).toString(16) };
    if (fail) throw Error('offline');
    return { number: '0x3e8', hash: 'new', timestamp: '0x' + Math.floor(NOW / 1000).toString(16), transactions: [] };
  } });
  feed.observe({ number: 1012, hash: 'latest', transactions: [] });
  await assert.rejects(feed.poll(), /offline/); assert.equal(s.data.cursors.ETH.number, 10);
  fail = false; await feed.poll(); assert.equal(s.data.cursors.ETH.number, 1000);
  assert.equal(s.data.health.ETH.skippedBacklog, true);
});

test('exchange suppresses historical transfers even if provider returns them', t => {
  const s = store(t), engine = new ExchangeEngine(s, [{ chain: 'ETH', address: A }], settings({ EXCHANGE_FRESH_ONLY: 'false' }));
  engine.commit([1, 2, 3].map(i => ({ chain: 'ETH', symbol: 'ETH', from: B, to: A, usd: 100000,
    id: String(i), hash: String(i), at: OLD + i * 1000 })));
  assert.equal(s.data.pending.length, 0); assert.equal(Object.keys(s.data.windows).length, 0);
});

function chainflip({ saved = 0, failFloor = false } = {}) {
  const kv = new Map(saved ? [['cf:lastBlock', String(saved)]] : []), alerts = [], queries = [];
  let prices = 0, bursts = 0;
  const sandbox = { module: { exports: {} }, process: { env: { ETHERSCAN_API_KEY: 'test' } }, setInterval() {},
    require: name => {
      if (name === 'axios') return { get: async (url, { params }) => {
        queries.push(params);
        if (params.action === 'getblocknobytime') return { data: failFloor ? { status: '0', result: 'unavailable' } : { status: '1', result: '1000' } };
        return { data: { status: '1', result: [] } };
      } };
      if (name === '../utils/freshness') return require('../src/utils/freshness');
      if (name === '../utils/store') return { getKey: k => kv.get(k), setKey: (k,v) => kv.set(k,v), windowAdd: () => ++bursts, windowGet: () => [] };
      if (name === '../alerts/telegram') return { sendAlert: a => alerts.push(a) };
      if (name === '../utils/prices') return { getPrice: async () => { prices++; return 3000; }, fmtUSD: String };
      if (name === '../intelligence/flagged') return { shortAddr: String };
      return { info() {}, error() {}, alert() {}, warn() {} };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/monitors/chainflip.js'), 'utf8') +
    '\nmodule.exports = { poll, processTx, restoreCursor };', sandbox);
  sandbox.module.exports.restoreCursor();
  return { ...sandbox.module.exports, alerts, queries, kv, counts: () => ({ prices, bursts }) };
}

test('Chainflip fresh installs and old saved cursors start at recent block; floor failure prevents historical scanning', async () => {
  for (const saved of [0, 10, 2000]) {
    const f = chainflip({ saved }); await f.poll();
    assert.ok(f.queries.filter(q => q.module === 'account').every(q => q.startblock === Math.max(1000, saved + 1)));
  }
  const failed = chainflip({ saved: 10, failFloor: true }); await failed.poll();
  assert.equal(failed.queries.length, 1); assert.equal(failed.kv.get('cf:lastBlock'), '10');
});

test('Chainflip historical transfers cannot log alerts or build a processing-time burst; fresh transfers still alert', async () => {
  const f = chainflip();
  const tx = { from: '0xf5e10380213880111522dd0efd3dbb45b9f62bcc', to: A, value: '200000000000000000000', blockNumber: '1000' };
  for (let i = 0; i < 4; i++) await f.processTx({ ...tx, hash: 'old' + i, timeStamp: Math.floor(OLD / 1000) });
  assert.equal(f.alerts.length, 0); assert.deepEqual(f.counts(), { prices: 0, bursts: 0 });
  await f.processTx({ ...tx, hash: 'new', timeStamp: Math.floor(NOW / 1000) });
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0].eventAt, Math.floor(NOW / 1000) * 1000);
});
