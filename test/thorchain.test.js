const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {ExchangeStore}=require('../src/monitors/exchangeCore');
const {ThorMonitor,thorSettings,symbol}=require('../src/monitors/thorchainCore');
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),NOW=Date.now();
const USDT='ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7';
function swap(id,at=NOW-60000,extra={}) {
  return {type:'swap',status:'success',date:String(BigInt(at)*1000000n),
    in:[{txID:id,address:A,coins:[{asset:'ETH.ETH',amount:'20000000000'}]}],
    out:[{txID:'out'+id,address:'bc1qexample',coins:[{asset:'BTC.BTC',amount:'500000000'}]}],
    metadata:{swap:{inPriceUSD:'3000'}},...extra};
}
function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thor-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new ExchangeStore(path.join(dir,'state.json')),sent=[];
  const monitor=new ThorMonitor({store,rules:thorSettings({}),now:()=>NOW,price:async()=>3000,sendAlert:a=>sent.push(a),...options});
  return {store,sent,monitor};
}
test('THOR asset identity matches real chain and contract, not token symbol alone',()=>{
  assert.equal(symbol(USDT),'USDT');assert.equal(symbol('BTC.BTC'),'BTC');
  assert.equal(symbol('ETH.USDT-0XFAKE'),undefined);assert.equal(symbol('BTC~BTC'),undefined);
});
test('THOR metadata prices, affiliate exclusion and 1e8 amounts yield one concise alert',async t=>{
  const a=swap('A');a.out.unshift({affiliate:true,address:'affiliate',coins:[{asset:'THOR.RUNE',amount:'999999'}]});
  const f=fixture(t,{request:async()=>({actions:[a]}),price:()=>{throw Error('should use metadata');}});
  await f.monitor.poll();assert.equal(f.sent.length,1);assert.match(f.sent[0].body,/600,000/);
  assert.equal(f.sent[0].wallet,A);assert.equal(f.sent[0].walletChain,'ETH');
  await f.monitor.poll();assert.equal(f.sent.length,1);
});
test('THOR stables to BTC and BTC to Ethereum identify the Ethereum wallet',async t=>{
  const f=fixture(t);const a=swap('A');
  a.in[0].coins=[{asset:USDT,amount:'50000000000000'}];a.metadata.swap.inPriceUSD='1';
  assert.equal((await f.monitor.parse(a)).usd,500000);
  const b=swap('B');b.in=[{txID:'B',address:'bc1qexample',coins:[{asset:'BTC.BTC',amount:'1000000000'}]}];
  b.out=[{address:B,coins:[{asset:USDT,amount:'60000000000000'}]}];b.metadata.swap.inPriceUSD='60000';
  const e=await f.monitor.parse(b);assert.equal(e.wallet,B);assert.equal(e.direction,'BTC_TO_ETH');
});
test('THOR pagination uses nextPageToken and processes oldest first for burst',async t=>{
  const calls=[];const f=fixture(t,{request:async p=>{calls.push(p);return p.nextPageToken?
    {actions:[swap('A',NOW-180000),swap('B',NOW-120000)]}:{actions:[swap('C')],meta:{nextPageToken:'123'}};}});
  await f.monitor.poll();assert.equal(calls.length,2);assert.equal(calls[1].timestamp,undefined);
  assert.equal(f.sent.length,3);assert.match(f.sent[2].title,/Burst/);assert.match(f.sent[2].body,/3 swaps/);
});
test('pending swap is rechecked after cursor passes it and survives restart',async t=>{
  const f=fixture(t,{request:async()=>({actions:[swap('A',NOW-60000,{status:'pending',out:[]})]})});
  await f.monitor.poll();assert.equal(f.sent.length,0);assert.ok(f.store.data.thorPending.A);
  const store=new ExchangeStore(f.store.file),sent=[];
  const monitor=new ThorMonitor({store,rules:thorSettings({}),now:()=>NOW+3600000,price:async()=>3000,sendAlert:a=>sent.push(a),
    request:async p=>({actions:p.txid?[swap('A')]:[]})});
  await monitor.poll();assert.equal(sent.length,1);assert.equal(store.data.thorPending.A,undefined);
  await monitor.poll();assert.equal(sent.length,1);
});
test('missing prices and pagination failures do not advance THOR cursor or dedup',async t=>{
  const a=swap('A');delete a.metadata;
  const f=fixture(t,{price:async()=>null,request:async()=>({actions:[a]})});
  await assert.rejects(f.monitor.poll(),/price unavailable/);assert.equal(f.store.data.seen.A,undefined);assert.equal(f.store.data.cursors.THOR,undefined);
  const g=fixture(t,{request:async p=>{if(p.nextPageToken)throw Error('offline');return {actions:[swap('A')],meta:{nextPageToken:'1'}};}});
  await assert.rejects(g.monitor.poll(),/offline/);assert.equal(g.sent.length,0);assert.equal(g.store.data.cursors.THOR,undefined);
});
test('failed Telegram handoff retains THOR alert durably',async t=>{
  const f=fixture(t,{request:async()=>({actions:[swap('A')]}),sendAlert:()=>{throw Error('storage');}});
  await assert.rejects(f.monitor.poll(),/storage/);assert.equal(new ExchangeStore(f.store.file).data.pending.length,1);
  f.monitor.sendAlert=a=>f.sent.push(a);f.monitor.flush();assert.equal(f.sent.length,1);assert.equal(f.store.data.pending.length,0);
});
test('blocked wallets, refunds and unsupported pairs do not alert',async t=>{
  const f=fixture(t,{isBlocked:a=>a===A,request:async()=>({actions:[swap('A'),swap('B',NOW-60000,{type:'refund'})]})});
  await f.monitor.poll();assert.equal(f.sent.length,0);
  const a=swap('C');a.out[0].coins[0].asset='ETH.ETH';assert.equal(await f.monitor.parse(a),null);
});
