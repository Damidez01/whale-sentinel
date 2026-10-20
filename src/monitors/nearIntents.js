const path=require('path');
const {ExchangeStore,settings}=require('./exchangeCore');
const {EthereumExchangeFeed}=require('./exchangeFeeds');
const {makeRpc}=require('./exchangeMonitor');
const {NearOutflows,WBTC}=require('./nearIntentsCore');
const {getPrice}=require('../utils/prices');
const {sendAlert,isBlocked}=require('../alerts/telegram');
const logger=require('../utils/logger');
let feed,started=false;
function observeNearBlock(block) { feed?.observe(block); }
function startNearIntentsMonitor() {
  if(started || process.env.NEAR_INTENTS_ENABLED==='false') return false;
  if(!process.env.ALCHEMY_ETH_WSS || process.env.ALCHEMY_ETH_WSS.includes('YOUR_KEY')) return false;
  const rules=settings();
  const engine=new NearOutflows(new ExchangeStore(path.join(process.env.TELEGRAM_DATA_DIR||'/data','near-intents-state.json')),
    {min:Number(process.env.NEAR_INTENTS_MIN_USD||100000),isBlocked});
  feed=new EthereumExchangeFeed({engine,rules,outgoingOnly:true,tokens:{[WBTC]:{symbol:'WBTC',decimals:8}},
    rpc:makeRpc([process.env.ALCHEMY_ETH_WSS,process.env.ALCHEMY_ETH_FALLBACK]),
    price:symbol=>getPrice(symbol,{maxAgeMs:15*60000})});
  let busy=false;
  const poll=async()=>{
    if(busy)return; busy=true;
    try { engine.flush(sendAlert); await feed.poll(); engine.flush(sendAlert);
      if(engine.store.data.health.ETH?.ok) logger.info('[NEAR] WBTC outflow scan succeeded',engine.store.data.health.ETH);
    } catch(err) { logger.warn('[NEAR] '+(err.isAxiosError?'Provider request failed':err.message)+'; saved progress retained'); }
    finally { busy=false; }
  };
  started=true; void poll(); setInterval(poll,rules.pollMs);
  logger.info(`[NEAR] WBTC outflows >=$${engine.min}/transaction; grouped by receiver; updates on doubling or 3/10/20 rapid receipts; polling ${rules.pollMs/1000}s`);
  return true;
}
module.exports={observeNearBlock,startNearIntentsMonitor};
