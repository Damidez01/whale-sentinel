const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {ExchangeStore,settings}=require('../src/monitors/exchangeCore');
const {NearOutflows,HOT,WBTC}=require('../src/monitors/nearIntentsCore');
const {EthereumExchangeFeed,TRANSFER}=require('../src/monitors/exchangeFeeds');
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40);
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'near-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new ExchangeStore(path.join(dir,'state.json'));
  return {store,engine:new NearOutflows(store)};
}
const event=(id,usd,extra={})=>({id,hash:id,chain:'ETH',symbol:'WBTC',token:WBTC,
  from:HOT,to:A,amount:'200000000',usd,at:Date.now()-60000,...extra});
test('NEAR inclusive 100k per transaction, outgoing WBTC only, stale and self transfers excluded',t=>{
  const f=fixture(t);
  f.engine.commit([event('equal',100000),event('low',99999),event('yes',100001),
    event('in',200000,{from:A,to:HOT}),event('wrong-token',200000,{token:A}),
    event('self',200000,{to:HOT}),event('stale',200000,{at:Date.now()-3600000})]);
  assert.deepEqual(f.store.data.pending.map(a=>a.txHash),['equal','yes']);
});
test('NEAR value doubling groups receivers, survives restart, and coalesces rapid and doubled triggers',t=>{
  const f=fixture(t);
  f.engine.commit([event('first',200000),event('second',100000)]);
  assert.equal(f.store.data.pending.length,1);
  const engine=new NearOutflows(new ExchangeStore(f.store.file));
  engine.commit([event('third',100000)]);
  assert.equal(engine.store.data.pending.length,2);
  assert.match(engine.store.data.pending[1].body,/tracked value doubled; 3 qualifying receipts/);
  engine.commit([event('third',100000),event('fourth',100000)]);
  assert.equal(engine.store.data.pending.length,2);
  engine.commit([event('other',100000,{to:B})]);assert.equal(engine.store.data.pending.length,3);
  engine.commit([event('fifth',300000)]);assert.equal(engine.store.data.pending.length,4);
  assert.match(engine.store.data.pending[3].body,/800,000/);
});
test('NEAR rapid milestones are 3,10,20 and window dips do not repeat them',t=>{
  const savedNow=Date.now;let clock=savedNow();Date.now=()=>clock;t.after(()=>{Date.now=savedNow;});
  const f=fixture(t);
  for(let i=1;i<=20;i++)f.engine.commit([event('receipt'+i,i===1?1000000:100000,{at:clock-1})]);
  assert.deepEqual(f.store.data.pending.map(a=>a.txHash),['receipt1','receipt3','receipt10','receipt20']);
  clock+=16*60000;
  for(let i=21;i<=23;i++)f.engine.commit([event('receipt'+i,100000,{at:clock-1})]);
  assert.equal(f.store.data.pending.length,4);
  clock+=3600000;
  f.engine.commit([event('new-session',100000,{at:clock-1})]);
  assert.equal(f.store.data.pending.length,5);
  assert.equal(f.store.data.nearReceivers[A].count,1);
});
test('sub-100k transactions neither combine nor extend the qualifying-receipt session',t=>{
  const savedNow=Date.now;let clock=savedNow();Date.now=()=>clock;t.after(()=>{Date.now=savedNow;});
  const f=fixture(t);
  f.engine.commit([event('small1',60000),event('small2',60000),event('small3',60000)]);
  assert.equal(f.store.data.pending.length,0);
  f.engine.commit([event('first',100000,{at:clock-1})]);
  clock+=30*60000;f.engine.commit([event('small4',90000,{at:clock-1})]);
  clock+=30*60000;f.engine.commit([event('new',100000,{at:clock-1})]);
  assert.equal(f.store.data.pending.length,2);assert.equal(f.store.data.nearReceivers[A].count,1);
});
test('NEAR same transaction/receiver aggregates logs once, different receivers never combine',t=>{
  const f=fixture(t);
  const a=event('leg1',60000,{hash:'tx'});
  f.engine.commit([a,a,event('leg2',60000,{hash:'tx'}),event('b1',60000,{hash:'other'}),event('b2',60000,{hash:'other',to:B})]);
  assert.equal(f.store.data.pending.length,1);assert.match(f.store.data.pending[0].body,/120,000/);
  const restarted=new NearOutflows(new ExchangeStore(f.store.file));
  restarted.commit([a,event('leg2',60000,{hash:'tx'})]);assert.equal(restarted.store.data.pending.length,1);
  assert.throws(()=>restarted.flush(()=>{throw Error('delivery failed');}));
  assert.equal(restarted.store.data.pending.length,1);
  restarted.isBlocked=w=>w===A;restarted.flush(()=>assert.fail('blocked'));
  assert.equal(restarted.store.data.pending.length,0);
});
test('NEAR feed requests only outgoing canonical WBTC logs and values eight decimals',async t=>{
  const f=fixture(t),pad=a=>'0x'+a.slice(2).padStart(64,'0'),calls=[];
  const block={number:'0x64',hash:'block',parentHash:'prev',timestamp:'0x'+Math.floor((Date.now()-60000)/1000).toString(16),
    transactions:[{hash:'tx'}]};
  const log={address:WBTC,transactionHash:'tx',blockNumber:'0x64',blockHash:'block',transactionIndex:'0x0',logIndex:'0x0',
    topics:[TRANSFER,pad(HOT),pad(A)],data:'0x'+(200000000n).toString(16).padStart(64,'0')};
  const feed=new EthereumExchangeFeed({engine:f.engine,rules:settings({}),tokens:{[WBTC]:{symbol:'WBTC',decimals:8}},
    outgoingOnly:true,price:async symbol=>{assert.equal(symbol,'WBTC');return 60000;},
    rpc:async(m,p)=>{calls.push([m,p]);assert.equal(m,'eth_getLogs');return [log];}});
  feed.observe(block);feed.observe({...block,number:'0x70',hash:'head'});
  await feed.poll();
  assert.equal(calls.length,1);assert.deepEqual(calls[0][1][0].address,[WBTC]);
  assert.deepEqual(calls[0][1][0].topics,[TRANSFER,[pad(HOT)]]);
  assert.equal(f.store.data.pending.length,1);assert.match(f.store.data.pending[0].body,/2 WBTC/);
  assert.equal(f.store.data.cursors.ETH.number,100);
});
