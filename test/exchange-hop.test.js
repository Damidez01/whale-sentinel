const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { ExchangeStore, ExchangeEngine, settings } = require('../src/monitors/exchangeCore');
const { FreshDeposits } = require('../src/monitors/exchangeFresh');
const { selectOrigin, traceOrigin } = require('../src/monitors/exchangeHop');
const { TRON_USDT } = require('../src/monitors/exchangeFeeds');
const { tronFromHex } = require('../src/utils/addresses');
const watchlist = require('../src/monitors/exchange-wallets.json');
const evidence = require('./fixtures/fixedfloat-hop.json');
const token = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const hot = watchlist.find(w => w.service === 'FixedFloat' && w.chain === 'ETH').address.toLowerCase();
const tronHex = address => {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const n=[...address].reduce((n,c)=>n*58n+BigInt(alphabet.indexOf(c)),0n);
  return n.toString(16).slice(0,-8);
};
function setup(t, rules = settings({}), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hop-test-'));
  t.after(() => fs.rmSync(dir,{ recursive:true,force:true }));
  const store = new ExchangeStore(path.join(dir,'state.json'));
  return { store, engine:new ExchangeEngine(store,watchlist,rules,options), rules };
}
function publicRpc(method, [p,tag]) {
  const address = typeof p === 'string' ? p : p.fromAddress || p.toAddress;
  const w = evidence.wallets.find(w => w.address === address);
  assert.ok(w, 'only intermediate wallet history may be queried, not original source');
  const block = Number(BigInt(typeof p === 'string' ? tag : p.toBlock));
  if (method === 'eth_getCode') return w.isContract ? '0x1234' : '0x';
  if (method === 'eth_getTransactionCount') {
    const sent = w.transactions.filter(r => r.from === address && r.blockNumber <= block);
    return '0x' + (sent.length ? Math.max(...sent.map(r => r.nonce)) + 1 : 0).toString(16);
  }
  assert.equal(method,'alchemy_getAssetTransfers');
  let rows = p.contractAddresses ? w['token-transfers'].filter(r => r.token === p.contractAddresses[0]) :
    [...w['token-transfers'], ...w.transactions.filter(r => BigInt(r.value || 0)>0n), ...w['internal-transactions']];
  rows = rows.filter(r => r.blockNumber <= block && (p.fromAddress ? r.from === address : r.to === address));
  return { transfers:rows.map(r => ({hash:r.hash,from:r.from,to:r.to,blockNum:'0x'+r.blockNumber.toString(16),
    rawContract:{address:r.token,value:r.amount},metadata:{blockTimestamp:new Date(r.at).toISOString()}})) };
}
function realEvents() {
  return evidence.wallets.flatMap(w => w['token-transfers'].filter(r => r.to === hot && r.token === token).map(r => ({
    ...r,id:r.hash,chain:'ETH',symbol:'USDT',token,usd:Number(r.amount)/1e6,
  })));
}
test('historical real wallet replay: three fresh FixedFloat intermediates group to original source', async t => {
  const events = realEvents(); assert.equal(events.length,3);
  const savedNow=Date.now; Date.now=()=>Math.max(...events.map(e=>e.at))+60000;
  t.after(()=>{Date.now=savedNow;});
  const f=setup(t), fresh=new FreshDeposits({...f,rpc:publicRpc});
  const checked=await fresh.filter(events);
  assert.ok(checked.every(e=>e.freshApproved && e.originalSource===evidence.original));
  f.engine.commit(checked);
  assert.equal(f.store.data.pending.length,1);
  const a=f.store.data.pending[0]; assert.equal(a.wallet,evidence.original);
  assert.match(a.body,/150,000/); assert.match(a.body,/Verified one-hop/);
  for(const e of events) assert.ok(a.countedWallets.includes(e.from));
  const restarted=new ExchangeEngine(new ExchangeStore(f.store.file),watchlist,f.rules);
  restarted.commit(checked); assert.equal(restarted.store.data.pending.length,1);
  const cached=new FreshDeposits({engine:restarted,rules:f.rules,rpc:()=>{throw Error('must use persisted evidence');}});
  assert.deepEqual(await cached.filter(events),checked);
});
test('same-asset attribution rejects mixed funders, insufficient funds, reverse order and old funding', () => {
  const e={from:'deposit',to:'hot',hash:'out',amount:'50',at:100000000,blockNumber:100};
  const incoming={from:'origin',to:'deposit',hash:'in',amount:'50',at:e.at-1000,blockNumber:99};
  const out={...e};
  assert.equal(selectOrigin(e,[incoming,out],48).originalSource,'origin');
  for(const rows of [[incoming,{...incoming,from:'other',hash:'other'},out],
    [{...incoming,amount:'49'},out],[{...incoming,at:e.at},out],
    [{...incoming,blockNumber:100},out],[{...incoming,at:1},out]]) assert.equal(selectOrigin(e,rows,0.1),null);
  assert.throws(()=>selectOrigin(e,[incoming],48),/not indexed/);
});
test('ChangeNOW groups separate deposit wallets, isolates origins, and honors original/intermediate blocks', t => {
  const now=Date.now()-10000, dest=watchlist[0].address.toLowerCase();
  const rows=[1,2,3].map(i=>({chain:'ETH',symbol:'USDT',from:'0x'+String(i).repeat(40),to:dest,
    originalSource:evidence.original,fundingHashes:['fund'+i],freshApproved:true,at:now+i,hash:'forward'+i,id:'forward'+i,usd:50000}));
  const f=setup(t); f.engine.commit(rows); assert.equal(f.store.data.pending.length,1);
  assert.match(f.store.data.pending[0].title,/ChangeNOW/); assert.equal(f.store.data.pending[0].wallet,evidence.original);
  f.engine.isBlocked=w=>w===rows[1].from; f.engine.flush(()=>assert.fail('blocked route delivered'));
  assert.equal(f.store.data.pending.length,0);
  const g=setup(t); g.engine.commit(rows.map((r,i)=>({...r,originalSource:'0x'+String(i+5).repeat(40)})));
  assert.equal(g.store.data.pending.length,0);
  const b=setup(t,settings({}),{isBlocked:w=>w===evidence.original}); b.engine.commit(rows); assert.equal(b.store.data.pending.length,0);
});
test('TRON USDT and native TRX trace origin for both configured services', async t => {
  for(const wallet of watchlist.filter(w=>w.chain==='TRON')) for(const symbol of ['USDT','TRX']) {
    const f=setup(t), origin=tronFromHex('41'+'11'.repeat(20)), now=Date.now()-10000;
    const events=[2,3,4].map(i=>({chain:'TRON',symbol,from:tronFromHex('41'+String(i).repeat(40)),to:wallet.address,
      amount:'50000000000',usd:50000,at:now+i,hash:'out'+i,id:'out'+i}));
    const request=async(route,p)=>{
      const e=events.find(e=>route.includes(e.from));
      const incoming={from:origin,to:e.from,transaction_id:'in'+e.id,value:e.amount,block_timestamp:e.at-1000,type:'Transfer',token_info:{address:TRON_USDT}};
      const out={...incoming,from:e.from,to:e.to,transaction_id:e.hash,block_timestamp:e.at};
      const native=r=>({txID:r.transaction_id,block_timestamp:r.block_timestamp,ret:[{contractRet:'SUCCESS'}],raw_data:{contract:[{type:'TransferContract',parameter:{value:{
        owner_address: r.from===origin?'41'+'11'.repeat(20):'41'+String(events.indexOf(e)+2).repeat(40),
        to_address:tronHex(r.to),amount:Number(r.value),
      }}}]}});
      return {success:true,data:route.endsWith('/trc20')?(symbol==='USDT'?[incoming,out]:[]):symbol==='TRX'?[incoming,out].map(native):[],meta:{}};
    };
    const fresh=new FreshDeposits({...f,request});
    const checked=await fresh.filter(events);
    assert.ok(checked.every(e=>e.originalSource===origin && e.freshApproved));
    f.engine.commit(checked); assert.equal(f.store.data.pending.length,1);
    assert.equal(f.store.data.pending[0].wallet,origin);
  }
});
test('history failures defer; truncated same-asset evidence cannot infer a route', async () => {
  const e={chain:'ETH',from:'deposit',blockNumber:1,token};
  await assert.rejects(traceOrigin(e,{rules:settings({}),rpc:async()=>{throw Error('offline');}}),/offline/);
  assert.equal(await traceOrigin(e,{rules:settings({}),rpc:async()=>({transfers:[],pageKey:'next'})}),null);
});

test('one funding transaction split into three sweeps is not three deposits; ETH and DAI never count', t => {
  const f=setup(t), now=Date.now()-10000;
  const rows=[1,2,3].map(i=>({chain:'ETH',symbol:'USDT',from:evidence.wallets[0].address,to:hot,
    originalSource:evidence.original,fundingHashes:['one-funding'],freshApproved:true,
    at:now+i,hash:'sweep'+i,id:'sweep'+i,usd:50000}));
  f.engine.commit(rows); assert.equal(f.store.data.pending.length,0);
  for(const symbol of ['ETH','DAI']) f.engine.commit(rows.map((r,i)=>({...r,symbol,id:symbol+i,hash:symbol+i,fundingHashes:['fund'+i]})));
  assert.equal(f.store.data.pending.length,0);
  assert.equal(Object.values(f.store.data.windows).flat().length,3);
});

test('failed route lookup leaves no cached approval that could skip retry', async t => {
  const events=realEvents(), f=setup(t);
  const fresh=new FreshDeposits({...f,rpc:async(method,args)=>{
    if(method==='alchemy_getAssetTransfers' && args[0].contractAddresses) throw Error('route provider offline');
    return publicRpc(method,args);
  }});
  await assert.rejects(fresh.filter(events),/route provider offline/);
  assert.equal(Object.keys(f.store.data.freshChecks || {}).length,0);
  fresh.rpc=publicRpc;
  assert.equal((await fresh.filter(events))[0].originalSource,evidence.original);
});
