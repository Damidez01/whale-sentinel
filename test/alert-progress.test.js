const {test}=require('node:test');
const assert=require('node:assert/strict');
const {progress,makeProgress}=require('../src/utils/alertProgress');
test('doubling is inclusive, uses last notified value, coalesces count and value triggers, and survives restart',()=>{
  let r=progress(null,3,3,100,3600000,300000);assert.equal(r.notify,true);
  r=progress(r.state,4,3,200,3600000,599999);assert.equal(r.notify,false);
  r=progress(r.state,5,3,300,3600000,600000);assert.equal(r.notify,true);
  r=progress(JSON.parse(JSON.stringify(r.state)),10,3,400,3600000,1200000);assert.equal(r.notify,true);
  r=progress(r.state,10,3,500,3600000,1200000);assert.equal(r.notify,false);
  r=progress(r.state,3,3,600,3600000,300000);assert.equal(r.notify,false);
  r=progress(r.state,4,3,700,3600000,600000);assert.equal(r.notify,false);
  assert.equal(progress(r.state,2,3,800,3600000,5000000).notify,false);
});
test('milestones are initial, 10, 20, 30; dips and restart do not repeat them',()=>{
  let state, at=100000, sent=[];
  for(let n=1;n<=35;n++){const r=progress(state,n,3,++at);state=r.state;if(r.notify)sent.push(n);}
  assert.deepEqual(sent,[3,10,20,30]);
  state=JSON.parse(JSON.stringify(state));
  for(const n of [2,3,10,29,30,31]){const r=progress(state,n,3,++at);state=r.state;assert.equal(r.notify,false);}
  assert.equal(progress(state,3,3,at+3600000).notify,true);
});
test('quiet period is extended by qualifying activity below initial threshold',()=>{
  let state=progress(null,3,3,100).state;
  state=progress(state,1,3,3500000).state;
  assert.equal(progress(state,3,3,3600200).notify,false);
});
test('primary and additional accumulation share progression, unrelated wallets remain independent',()=>{
  const data=new Map(), notify=makeProgress({getKey:k=>data.get(k),setKey:(k,v)=>data.set(k,v)});
  assert.equal(notify('wallet-a',3,3),true);
  assert.equal(notify('wallet-a',5,5),false);
  assert.equal(notify('wallet-a',10,5),true);
  assert.equal(notify('wallet-a',10,3),false);
  assert.equal(notify('wallet-b',5,5),true);
});
