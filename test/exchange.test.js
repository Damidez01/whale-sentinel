const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExchangeStore, ExchangeEngine, settings } = require('../src/monitors/exchangeCore');
const { EthereumExchangeFeed, TronExchangeFeed, TRANSFER, TOKENS, TRON_USDT } = require('../src/monitors/exchangeFeeds');
const { normalizeWallet, tronFromHex } = require('../src/utils/addresses');
const { DurableState } = require('../src/alerts/durable');
const { commandHandler } = require('../src/alerts/commands');
const watchlist = require('../src/monitors/exchange-wallets.json');
const A = normalizeWallet(watchlist[0].address), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40), D = '0x' + '4'.repeat(40);
const T = Date.now() - 300000;
const rules = settings({});
const row = (i, extra = {}) => ({ chain: 'ETH', symbol: 'ETH', from: B, to: A, usd: 50000, id: 't' + i, hash: 't' + i, at: T + i * 60000, ...extra });
function fixture(t, list = watchlist, config = rules, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exchange-test-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  const store = new ExchangeStore(path.join(dir, 'exchange.json'));
  return { store, dir, engine: new ExchangeEngine(store, list, config, options) };
}

test('exchange alert links and block subject identify triggering counterparties on ETH and TRON', t => {
  for (const chain of ['ETH','TRON']) {
    const wallet=watchlist.find(w=>w.chain===chain);
    const hot=normalizeWallet(wallet.address);
    const peers=chain==='ETH'?[B,C,D]:['11','22','33'].map(x=>tronFromHex('41'+x.repeat(20)));
    for (const incoming of [false,true]) {
      const f=fixture(t,[wallet]);
      f.engine.commit(peers.map((peer,i)=>({chain,symbol:'USDT',id:'link'+i,hash:'link'+i,at:T+i*1000,usd:50000,
        from:incoming?peer:hot,to:incoming?hot:peer})));
      const alert=f.store.data.pending[0];
      assert.equal(alert.wallet,peers[2]);
      assert.equal(alert.txHash,'link2');
      assert.match(alert.body,incoming?/Source wallet:/ : /Destination wallet:/);
      for (const peer of peers) assert.ok(alert.body.includes(`[${peer.slice(0,6)}...${peer.slice(-4)}](https://arkm.com/explorer/address/${peer})`));
      assert.doesNotMatch(alert.body,/provided by you|triggering transfer|Exchange hot wallet|Window through|unverified/);
    }
  }
});
test('all five supplied wallets validate; TRON checksum and letter case are enforced', () => {
  assert.ok(watchlist.every(w => normalizeWallet(w.address)));
  assert.equal(normalizeWallet(watchlist[2].address.toLowerCase()), null);
  assert.equal(normalizeWallet(watchlist[2].address.slice(0,-1) + 'a'), null);
  assert.ok(normalizeWallet(tronFromHex('41' + '11'.repeat(20))));
});
test('exchange accumulation is three >=50k transfers in distinct transactions and survives restart', t => {
  const f = fixture(t); f.engine.commit([row(0), row(1, { symbol: 'USDT' })]);
  const restarted = new ExchangeStore(f.store.file), engine = new ExchangeEngine(restarted, watchlist, rules);
  engine.commit([row(2, { symbol: 'DAI' })]);
  assert.equal(restarted.data.pending.length, 1);
  assert.match(restarted.data.pending[0].body, /3 incoming txns/);
  assert.match(restarted.data.pending[0].body, /ETH.*USDT.*DAI/);
  engine.commit([row(2)]); assert.equal(restarted.data.pending.length, 1);
  engine.commit([row(3), row(4)]); assert.equal(restarted.data.pending.length, 2);
});
test('under-threshold, self-transfers, unrelated wallets and expired windows do not alert', t => {
  const f = fixture(t);
  f.engine.commit([row(0, { usd: 49999 }), row(1, { usd: 49999 }), row(2, { usd: 49999 }), row(3, { from: A }), row(4, { to: C })]);
  f.engine.commit([row(20), row(36), row(52)]); assert.equal(f.store.data.pending.length, 0);
});
test('multiple token logs within one transaction cannot satisfy three incoming transactions', t => {
  const f = fixture(t); f.engine.commit([row(0), row(1, { hash: 't0' }), row(2, { hash: 't0' })]);
  assert.equal(f.store.data.pending.length, 0);
});
test('late indexed transfer is evaluated with the already retained window', t => {
  const f = fixture(t); f.engine.commit([row(0), row(2)]); f.engine.commit([row(1)]);
  assert.equal(f.store.data.pending.length, 1);
});
test('fanout requires three unique destinations and honors destination exclusions', t => {
  const f = fixture(t, watchlist, rules, { ignoreDestination: (_, a) => a === D });
  f.engine.commit([row(0, { from: A, to: B, usd: 10000 }), row(1, { from: A, to: B, usd: 10000 }),
    row(2, { from: A, to: C, usd: 10000 }), row(3, { from: A, to: D, usd: 10000 })]);
  assert.equal(f.store.data.pending.length, 0);
  f.engine.commit([row(4, { from: A, to: '0x' + '5'.repeat(40), usd: 10000 })]);
  assert.equal(f.store.data.pending.length, 1); assert.match(f.store.data.pending[0].body, /3 destinations/);
});
test('alert handoff failure keeps pending alert on disk for the next attempt', t => {
  const f = fixture(t); f.engine.commit([row(0),row(1),row(2)]);
  assert.throws(() => f.engine.flush(() => { throw Error('disk full'); }));
  assert.equal(new ExchangeStore(f.store.file).data.pending.length, 1);
  const delivered = []; f.engine.flush(a => delivered.push(a)); assert.equal(delivered.length,1); assert.equal(f.store.data.pending.length,0);
});
function ethFixture(t, response) {
  const f = fixture(t); const calls = [];
  const token = Object.keys(TOKENS)[0], pad = a => '0x' + a.slice(2).padStart(64,'0');
  const block = { number: '0x64', hash: 'h100', parentHash: 'h99', timestamp: '0x' + Math.floor(T/1000).toString(16),
    transactions: [0,1,2].map(i => ({ hash: 'tx' + i, from: B, to: token, value: '0x0', transactionIndex: '0x' + i })) };
  const logs = [0,1,2].map(i => ({ address: token, transactionHash: 'tx' + i, blockNumber: '0x64', blockHash: 'h100',
    transactionIndex: '0x' + i, logIndex: '0x' + i, topics: [TRANSFER,pad(B),pad(A)], data: '0x' + (50000n*10n**6n).toString(16).padStart(64,'0') }));
  const rpc = async (method, params) => { calls.push([method,params]); return response ? response(method,params,logs) : method === 'eth_getLogs' ? logs : null; };
  const feed = new EthereumExchangeFeed({ engine:f.engine, rules, price:async()=>1, rpc });
  feed.observe(block); feed.observe({ ...block, number:'0x70', hash:'h112' });
  return { ...f, feed, calls, logs, block };
}
test('Ethereum reuses cached full blocks, filters both directions and deduplicates overlapping log queries', async t => {
  const f = ethFixture(t); await f.feed.poll();
  assert.equal(f.store.data.pending.length,1); assert.equal(f.store.data.cursors.ETH.number,100);
  assert.deepEqual(f.calls.map(c=>c[0]),['eth_getLogs','eth_getLogs']);
  assert.equal(f.calls[0][1][0].topics[2].length,3); assert.equal(f.calls[1][1][0].topics[1].length,3);
  assert.equal(f.calls[0][1][0].address.length,3);
});
test('Ethereum failed log/price requests never advance the dedicated cursor', async t => {
  const f = ethFixture(t,()=>{throw Error('quota');}); await assert.rejects(f.feed.poll(),/quota/); assert.equal(f.store.data.cursors.ETH,undefined);
  const g = ethFixture(t); g.feed.price=async()=>null; await assert.rejects(g.feed.poll(),/price unavailable/); assert.equal(g.store.data.cursors.ETH,undefined);
});
test('only qualifying native transfers involving watched wallets fetch receipts; failed transfers are excluded', async t => {
  const f = ethFixture(t,(m,p)=>m==='eth_getLogs'?[]:{ transactionHash:p[0],blockHash:'h100',status:'0x0' });
  f.block.transactions = [{hash:'native',from:B,to:A,value:'0x'+(50000n*10n**18n).toString(16)},
    {hash:'unwatched',from:B,to:C,value:'0x'+(50000n*10n**18n).toString(16)}];
  await f.feed.poll(); assert.equal(f.calls.filter(c=>c[0]==='eth_getTransactionReceipt').length,1);
  assert.equal(f.store.data.pending.length,0);
});
test('ETH receipt mismatch or reorganization retains saved progress', async t => {
  const f=ethFixture(t); f.store.update(s=>{s.cursors.ETH={number:99,hash:'h99'};});
  await assert.rejects(f.feed.poll(),/reorganization/); assert.equal(f.store.data.cursors.ETH.number,99);
});
test('TRON uses confirmed USDT pages, follows pagination and deduplicates overlap across polls', async t => {
  const wallet=watchlist[2], f=fixture(t,[wallet]), calls=[];
  const now=Date.now(), from=tronFromHex('41'+'11'.repeat(20));
  const data=[0,1,2].map(i=>({type:'Transfer',transaction_id:'tron'+i,from,to:wallet.address,value:'50000000000',block_timestamp:now-50000+i*1000,token_info:{address:TRON_USDT}}));
  const feed=new TronExchangeFeed({engine:f.engine,rules,price:async()=>1,now:()=>now,
    request:async(route,p)=>{calls.push([route,p]);return {success:true,data:route.endsWith('/trc20')?(p.fingerprint?data.slice(2):data.slice(0,2)):[],meta:route.endsWith('/trc20')&&!p.fingerprint?{fingerprint:'next'}:{}};}});
  await feed.poll(); assert.equal(f.store.data.pending.length,1); assert.equal(f.store.data.cursors.TRON.at,now-30000);
  assert.ok(calls.every(c=>c[1].only_confirmed)); assert.equal(calls[0][1].contract_address,TRON_USDT);
  await feed.poll(); assert.equal(f.store.data.pending.length,1);
});
test('a later TronGrid page failure commits neither events nor cursor', async t => {
  const f=fixture(t,[watchlist[2]]); const feed=new TronExchangeFeed({engine:f.engine,rules,price:async()=>1,
    request:async(_,p)=>{if(p.fingerprint)throw Error('429');return {success:true,data:[],meta:{fingerprint:'next'}};}});
  await assert.rejects(feed.poll(),/429/); assert.equal(f.store.data.cursors.TRON,undefined); assert.equal(f.store.data.pending.length,0);
});
test('TRX requires successful TransferContract and correct SUN conversion', async t => {
  const address=tronFromHex('41'+'22'.repeat(20)), from='41'+'11'.repeat(20), now=Date.now();
  const f=fixture(t,[{chain:'TRON',service:'Fixture',address}]);
  const data=[0,1,2].map(i=>({txID:'trx'+i,block_timestamp:now-50000+i*1000,ret:[{contractRet:'SUCCESS'}],raw_data:{contract:[{type:'TransferContract',parameter:{value:{owner_address:from,to_address:'41'+'22'.repeat(20),amount:200000000000}}}]}}));
  data.push({...data[0],txID:'failed',ret:[{contractRet:'REVERT'}]});
  const feed=new TronExchangeFeed({engine:f.engine,rules,now:()=>now,price:async()=>0.25,request:async route=>({success:true,data:route.endsWith('trc20')?[]:data,meta:{}})});
  await feed.poll();assert.equal(f.store.data.pending.length,1);assert.match(f.store.data.pending[0].body,/TRX \$150,000/);
});
test('Telegram block/unblock preserves TRON case and persists its exclusion', t => {
  const f=fixture(t), state=new DurableState(path.join(f.dir,'telegram.json'));
  const handle=commandHandler(state,{chatId:'123'}), address=watchlist[2].address;
  const message=(text,id)=>({text,message_id:id,chat:{id:123,type:'private'},from:{id:123}});
  assert.match(handle(message('/block '+address,1)),/Saved/);assert.equal(state.isBlocked(address),true);
  assert.equal(new DurableState(state.file).isBlocked(address),true);
  handle(message('/unblock '+address,2));assert.equal(state.isBlocked(address),false);
});

test('TRON filters indexer boundary records locally for native and token history', async t => {
  const address=tronFromHex('41'+'22'.repeat(20)), from=tronFromHex('41'+'11'.repeat(20));
  const now=1789940931750, cursor=1789940781280, start=cursor-120000, end=now-30000;
  const f=fixture(t,[{chain:'TRON',service:'Fixture',address}]);
  f.store.update(s=>{s.cursors.TRON={at:cursor};});
  // Mirrors the observed response: 1789940661000 is 280ms before the filter.
  const times=[Math.floor(start/1000)*1000, start, start+1000, end, end+250];
  const native=times.map((at,i)=>({txID:'n'+i,block_timestamp:at,ret:[{contractRet:'SUCCESS'}],raw_data:{contract:[{type:'TransferContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),to_address:'41'+'22'.repeat(20),amount:50000000000}}}]}}));
  const tokens=times.map((at,i)=>({transaction_id:'t'+i,block_timestamp:at,type:'Transfer',token_info:{address:TRON_USDT},from,to:address,value:'50000000000'}));
  const feed=new TronExchangeFeed({engine:f.engine,rules,now:()=>now,price:async()=>1,request:async route=>({success:true,data:route.endsWith('/trc20')?tokens:native,meta:{}})});
  await feed.poll();
  assert.equal(f.store.data.cursors.TRON.at,end);
  const seen=Object.keys(f.store.data.seen);
  assert.equal(seen.length,6);
  assert.ok(!seen.some(k=>k.includes('n0:')||k.includes('t0:')||k.includes('n4:')||k.includes('t4:')));
  await feed.poll(); assert.equal(Object.keys(f.store.data.seen).length,6);
});

test('TRON truly missing native timestamps still retain the cursor', async t => {
  const f=fixture(t,[watchlist[2]]);
  const feed=new TronExchangeFeed({engine:f.engine,rules,price:async()=>1,request:async route=>({success:true,data:route.endsWith('/trc20')?[]:[{txID:'missing-time',ret:[{contractRet:'SUCCESS'}]}]})});
  await assert.rejects(feed.poll(),/Invalid TronGrid native timestamp/);
  assert.equal(f.store.data.cursors.TRON,undefined);
});
