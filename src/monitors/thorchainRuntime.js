const axios=require('axios');
const path=require('path');
const {ExchangeStore}=require('./exchangeCore');
const {ThorMonitor,thorSettings}=require('./thorchainCore');
const {sendAlert,isBlocked}=require('../alerts/telegram');
const {getPrice}=require('../utils/prices');
const logger=require('../utils/logger');
const DEFAULT='https://gateway.liquify.com/chain/thorchain_midgard/v2';
let started=false;
function startTHORChainMonitor() {
  if(started||process.env.THORCHAIN_ENABLED==='false')return false;
  const rules=thorSettings(process.env),cooldown=new Map();
  const urls=[...new Set([process.env.THORCHAIN_MIDGARD,process.env.THORCHAIN_MIDGARD_FALLBACK,DEFAULT].filter(Boolean).map(s=>s.replace(/\/+$/,'')))];
  const request=async params=>{
    const errors=[];
    for(const [i,url] of urls.entries()) {
      if((cooldown.get(url)||0)>Date.now()){errors.push(`provider ${i+1} cooling down`);continue;}
      try {
        const {data}=await axios.get(url+'/actions',{params,timeout:15000});
        if(!Array.isArray(data?.actions))throw Error('Invalid response');return data;
      } catch(err) {
        const retry=err.response?.headers?.['retry-after'];
        const delay=/^\d+$/.test(String(retry))?Number(retry)*1000:Date.parse(retry)-Date.now();
        cooldown.set(url,Date.now()+Math.max(60000,Number.isFinite(delay)?delay:0));
        errors.push(`provider ${i+1}: ${err.response?.status?'HTTP '+err.response.status:'connection/invalid response'}`);
      }
    }
    throw Error('Midgard unavailable; '+errors.join('; '));
  };
  const store=new ExchangeStore(path.join(process.env.TELEGRAM_DATA_DIR||'/data','thorchain-state.json'));
  const monitor=new ThorMonitor({store,rules,request,sendAlert,isBlocked,price:s=>getPrice(s,{maxAgeMs:15*60000})});
  let busy=false;
  const poll=async()=>{
    if(busy)return;busy=true;
    try {await monitor.poll();logger.info('[THOR] Scan succeeded',{through:store.data.cursors.THOR?.at,pendingSwaps:Object.keys(store.data.thorPending||{}).length});}
    catch(err){logger.warn(`[THOR] ${err.isAxiosError?'Provider request failed':err.message}; saved progress retained`);}
    finally{busy=false;}
  };
  started=true;poll();setInterval(poll,rules.pollMs);
  logger.info(`[THOR] Started: ETH/stables ↔ BTC; minimum $${rules.min}; burst ${rules.count} in ${rules.minutes}min; polling ${rules.pollMs/1000}s`);
  return true;
}
module.exports={startTHORChainMonitor};
