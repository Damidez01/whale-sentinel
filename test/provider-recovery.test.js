const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, deps, now = Date.now) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, Date: { now, parse: Date.parse }, process: { env: {} },
    require: id => {
      if (Object.hasOwn(deps, id)) return deps[id];
      throw Error(`Unexpected dependency ${id}`);
    },
  });
  return module.exports;
}
function prices(get, now) {
  return load('src/utils/prices.js', { axios: { get }, './logger': { warn() {} } }, now);
}
function rpc(post) {
  return load('src/monitors/exchangeMonitor.js', {
    axios: { post }, path: {}, './exchangeCore': {}, './exchangeFeeds': {}, './exchangeFresh': {},
    './exchange-wallets.json': [], '../utils/prices': {}, '../alerts/telegram': {}, '../utils/logger': {},
  }).makeRpc;
}

test('price outage uses real backup quote and concurrent callers share requests', async () => {
  let calls = 0;
  const p = prices(async url => {
    calls++;
    if (url.includes('coingecko')) throw { response: { status: 429 } };
    return { data: { data: { amount: '0.998', base: 'USDT', currency: 'USD' } } };
  });
  assert.deepEqual(await Promise.all([p.getPrice('USDT'), p.getPrice('USDT')]), [0.998, 0.998]);
  assert.equal(calls, 2);
  assert.equal(await p.getPrice('USDT'), 0.998);
  assert.equal(calls, 2);
});

test('malformed primary response uses backup; wrong-currency and nonfinite prices are rejected', async () => {
  const p = prices(async url => url.includes('coingecko') ? { data: { tether: { usd: Infinity } } } :
    { data: { data: { amount: '1', currency: 'EUR' } } });
  assert.equal(await p.getPrice('USDT'), null);
  const q = prices(async url => url.includes('coingecko') ? { data: {} } :
    { data: { data: { amount: '0.99', currency: 'USD' } } });
  assert.equal(await q.getPrice('USDT'), 0.99);
});

test('failed refresh retains recent cache without extending its age and backs off retries', async () => {
  let now = 1000000, fail = false, calls = 0;
  const p = prices(async () => {
    calls++;
    if (fail) throw { response: { status: 429, headers: { 'retry-after': '120' } } };
    return { data: { tether: { usd: 0.999 } } };
  }, () => now);
  assert.equal(await p.getPrice('USDT', { maxAgeMs: 900000 }), 0.999);
  fail = true; now += 61000;
  assert.equal(await p.getPrice('USDT', { maxAgeMs: 900000 }), 0.999);
  const count = calls;
  assert.equal(await p.getPrice('USDT', { maxAgeMs: 900000 }), 0.999);
  assert.equal(calls, count);
  now += 900000;
  assert.equal(await p.getPrice('USDT', { maxAgeMs: 900000 }), null);
});

test('RPC diagnostics identify method and code without leaking provider message or URL', async () => {
  const make = rpc(async (_url, body) => ({ data: body.method === 'eth_chainId' ? { result: '0x1' } :
    { error: { code: -32600, message: 'quota exceeded https://secret.example/KEY' } } }));
  await assert.rejects(make(['https://secret.example/KEY'])('eth_getLogs', [{}]), err => {
    assert.match(err.message, /provider 1 eth_getLogs: RPC -32600 \(quota\/rate limit\)/);
    assert.doesNotMatch(err.message, /secret|KEY/); return true;
  });
});

test('RPC falls back after primary HTTP failure', async () => {
  const make = rpc(async (url, body) => {
    if (url.includes('primary')) throw { response: { status: 401 } };
    return { data: { result: body.method === 'eth_chainId' ? '0x1' : [] } };
  });
  assert.equal((await make(['https://primary', 'https://backup'])('eth_getLogs', [{}])).length, 0);
});

test('explicit log range rejection splits ranges without gaps or changed filters', async () => {
  const accepted = [];
  const make = rpc(async (_url, body) => {
    if (body.method === 'eth_chainId') return { data: { result: '0x1' } };
    const filter = body.params[0], from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    assert.equal(filter.address, 'watched-token');
    if (to - from + 1 > 10) return { data: { error: { code: -32600, message: 'Limited to 10 block range' } } };
    accepted.push([from, to]); return { data: { result: [from] } };
  });
  const result = await make(['https://provider'])('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x19', address: 'watched-token' }]);
  assert.deepEqual(accepted, [[1,7],[8,13],[14,19],[20,25]]);
  assert.equal(result.length, 4);
});

test('quota rejection is not recursively split and single-block limits fail safely', async () => {
  let calls = 0;
  const make = rpc(async (_url, body) => {
    if (body.method === 'eth_chainId') return { data: { result: '0x1' } };
    calls++; return { data: { error: { code: 429, message: 'quota exceeded' } } };
  });
  await assert.rejects(make(['https://provider'])('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x19' }]), /quota/);
  assert.equal(calls, 1);
  const limited = rpc(async (_url, body) => ({ data: body.method === 'eth_chainId' ? { result: '0x1' } :
    { error: { code: -32005, message: 'too many results' } } }));
  await assert.rejects(limited(['https://provider'])('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x1' }]), /log range\/result limit/);
});

test('HTTP 400 log-range errors split just like HTTP 200 JSON-RPC errors', async () => {
  const accepted = [];
  const make = rpc(async (_url, body) => {
    if (body.method === 'eth_chainId') return { data: { result: '0x1' } };
    const filter = body.params[0], from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    if (to - from + 1 > 10) throw { response: { status: 400, data: { error: { code: -32600, message: 'limited to 10 block range' } } } };
    accepted.push([from,to]); return { data: { result: [from] } };
  });
  assert.equal((await make(['https://provider'])('eth_getLogs', [{fromBlock:'0x1',toBlock:'0x19'}])).length,4);
  assert.deepEqual(accepted, [[1,7],[8,13],[14,19],[20,25]]);
});

test('HTTP 400 authentication errors are not split and failed subranges do not return partial results', async () => {
  let calls = 0;
  const make = rpc(async (_url, body) => {
    if (body.method === 'eth_chainId') return { data: { result: '0x1' } };
    calls++;
    throw { response: { status: 400, data: { error: { code: -32600, message: 'invalid API key SECRET' } } } };
  });
  await assert.rejects(make(['https://provider'])('eth_getLogs', [{fromBlock:'0x1',toBlock:'0x19'}]), /HTTP 400 \(authentication rejected\)/);
  assert.equal(calls,1);
  const partial = rpc(async (_url, body) => {
    if (body.method === 'eth_chainId') return { data: { result: '0x1' } };
    const f=body.params[0];
    if (f.fromBlock==='0x1' && f.toBlock==='0x2') throw { response: {status:400,data:{error:{message:'block range limit'}}} };
    if (f.fromBlock==='0x2') throw {response:{status:429}};
    return {data:{result:['first block']}};
  });
  await assert.rejects(partial(['https://provider'])('eth_getLogs',[{fromBlock:'0x1',toBlock:'0x2'}]), /HTTP 429/);
});
