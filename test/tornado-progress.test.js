const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm'),path=require('path');
function fixture() {
  const windows=new Map(),kv=new Map(),sent=[];let now=100000000;
  const store={
    getKey:k=>kv.get(k),setKey:(k,v)=>kv.set(k,v),
    windowAdd(k,v,seconds) {const a=(windows.get(k)||[]).filter(x=>now-x.at<seconds*1000);a.push({at:now,v});windows.set(k,a);return a.length;},
    windowGet(k,seconds) {const a=(windows.get(k)||[]).filter(x=>now-x.at<seconds*1000);windows.set(k,a);return a.map(x=>x.v);},
  };
  const sandbox={module:{exports:{}},process:{env:{}},require:n=>{
    if(n==='../utils/store')return store;
    if(n==='../utils/alertProgress')return require('../src/utils/alertProgress');
    if(n==='../alerts/telegram')return {sendAlert:a=>sent.push(a)};
    if(n==='../utils/prices')return {getPrice:async()=>2000,fmtUSD:String};
    if(n==='../utils/logger')return {alert(){},error(e){throw Error(e);}};
    return {};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/monitors/tornado.js'),'utf8')+'\nmodule.exports.handle=handleDeposit;',sandbox);
  return {sent,advance:ms=>{now+=ms;},deposit:(i,extra={})=>sandbox.module.exports.handle({transactionHash:'tx'+i,blockNumber:'0x1',logIndex:'0x0',...extra},'pool',{name:'100 ETH Pool',size:100})};
}
test('Tornado emits at 3,10,20,30, suppresses duplicate events and removed logs',async()=>{
  const f=fixture();
  for(let i=1;i<=35;i++)await f.deposit(i);
  assert.deepEqual(f.sent.map(a=>Number(a.body.split(' ')[0])),[3,10,20,30]);
  await f.deposit(35);await f.deposit(36,{removed:true});assert.equal(f.sent.length,4);
});
test('three Tornado deposits spread over more than 15 minutes are not a burst',async()=>{
  const f=fixture();
  await f.deposit(1);f.advance(10*60000);await f.deposit(2);f.advance(10*60000);await f.deposit(3);
  assert.equal(f.sent.length,0);
  for(let i=4;i<=10;i++)await f.deposit(i);
  assert.ok(f.sent.some(a=>a.body.startsWith('10 deposits in 60 min')));
});
