const { normalizeWallet } = require('../utils/addresses');
const ASSETS = new Map([
  ['ETH.ETH','ETH'], ['BTC.BTC','BTC'],
  ['ETH.WETH-0XC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2','WETH'],
  ['ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7','USDT'],
  ['ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48','USDC'],
  ['ETH.DAI-0X6B175474E89094C44DA98B954EEDEAC495271D0F','DAI'],
]);
const symbol = a => ASSETS.get(a?.toUpperCase());
const identity = a => a.in?.[0]?.txID?.toUpperCase();
function timestamp(a) {
  if(!/^\d+$/.test(a.date||''))throw Error('Invalid Midgard date');
  const n=Number(BigInt(a.date)/1000000n);
  if(!Number.isSafeInteger(n)||n<=0)throw Error('Invalid Midgard date');return n;
}
function thorSettings(env={}) {
  const n=(key,d)=>{const v=Number(env[key]||d);if(!Number.isSafeInteger(v)||v<=0)throw Error(`Invalid ${key}`);return v;};
  return {min:n('THORCHAIN_MIN_SWAP_USD',500000),count:n('THORCHAIN_BURST_COUNT',3),minutes:n('THORCHAIN_BURST_WINDOW_MIN',30),
    pollMs:Math.max(15000,n('THORCHAIN_POLL_MS',60000)),maxPages:n('THORCHAIN_MAX_PAGES',20),pendingPerPoll:n('THORCHAIN_PENDING_PER_POLL',20)};
}
const money=n=>'$'+Math.round(n).toLocaleString('en-US');
class ThorMonitor {
  constructor(options) { Object.assign(this,{now:Date.now,isBlocked:()=>false},options); }
  flush() {
    while(this.store.data.pending.length) {
      const a=this.store.data.pending[0];
      if(!this.isBlocked(a.wallet))this.sendAlert(a);
      this.store.update(s=>{s.pending=s.pending.filter(x=>x.alertId!==a.alertId);});
    }
  }
  async collect(start,end) {
    const actions=[],tokens=new Set();let token;
    for(let page=0;page<this.rules.maxPages;page++) {
      // fromTimestamp reverses Midgard's lookup order. Walk backwards from the
      // upper bound using only nextPageToken, stopping at the lower bound.
      const data=await this.request({type:'swap',asset:'BTC.BTC',limit:50,
        ...(token?{nextPageToken:token}:{timestamp:Math.ceil(end/1000)+1})});
      if(!Array.isArray(data?.actions))throw Error('Invalid Midgard actions');
      actions.push(...data.actions.filter(a=>{const at=timestamp(a);return at>=start&&at<=end;}));
      const next=data.meta?.nextPageToken;
      if(!data.actions.length||!next||data.actions.some(a=>timestamp(a)<start))return actions;
      if(tokens.has(next))throw Error('Midgard pagination repeated');tokens.add(next);token=next;
    }
    throw Error('Midgard page limit reached; increase THORCHAIN_MAX_PAGES');
  }
  async parse(a) {
    if(a.type!=='swap'||a.status!=='success')return null;
    const input=a.in?.[0],coin=input?.coins?.[0],asset=symbol(coin?.asset);
    if(!asset)return null;
    if(a.in.length!==1||input.coins.length!==1)throw Error('Unsupported multi-input THOR swap');
    const outputs=(a.out||[]).filter(o=>!o.affiliate).flatMap(o=>(o.coins||[]).map(c=>({address:o.address,coin:c,symbol:symbol(c.asset)})))
      .filter(o=>o.symbol&&((asset==='BTC')!==(o.symbol==='BTC')));
    if(!outputs.length)return null;
    const amount=Number(coin.amount)/1e8;
    let quote=Number(a.metadata?.swap?.inPriceUSD);
    if(!(quote>0)||!Number.isFinite(quote))quote=await this.price(asset);
    if(!(quote>0)||!Number.isFinite(quote))throw Error(`THOR ${asset} price unavailable`);
    if(!(amount>0)||!Number.isFinite(amount))throw Error('Invalid THOR amount');
    const usd=amount*quote;if(usd<this.rules.min)return null;
    const groups=new Map();
    for(const out of outputs) {
      const qty=Number(out.coin.amount)/1e8;
      if(!out.address||!(qty>0)||!Number.isFinite(qty))throw Error('Invalid THOR output');
      const key=out.address+':'+out.symbol,group=groups.get(key)||{...out,amount:0};group.amount+=qty;groups.set(key,group);
    }
    if(groups.size!==1)throw Error('THOR multiple recipient/asset groups require inspection');
    const out=[...groups.values()][0],wallet=normalizeWallet(asset==='BTC'?out.address:input.address);
    if(!wallet?.startsWith('0x'))throw Error('Invalid THOR Ethereum wallet');
    return {id:identity(a),at:timestamp(a),usd,wallet,asset,outAsset:out.symbol,amount,outAmount:out.amount,direction:asset==='BTC'?'BTC_TO_ETH':'ETH_TO_BTC'};
  }
  async poll() {
    this.flush();
    // One-time bounded recovery for the old forward/backward pagination bug.
    if(this.store.data.thorScanVersion!==2) this.store.update(s=>{
      if(s.cursors.THOR?.at)s.cursors.THOR.at=Math.max(0,s.cursors.THOR.at-60*60000);
      s.thorScanVersion=2;
    });
    const previous=this.store.data.cursors.THOR?.at??this.now()-5*60000;
    const end=Math.min(this.now()-30000,previous+10*60000),start=Math.max(0,previous-2*60000);
    if(end<=previous)return;
    const actions=await this.collect(start,end),retried=[];
    for(const [id] of Object.entries(this.store.data.thorPending||{}).sort((a,b)=>a[1].checkedAt-b[1].checkedAt).slice(0,this.rules.pendingPerPoll)) {
      const data=await this.request({txid:id,limit:50});
      if(!Array.isArray(data?.actions))throw Error('Invalid pending THOR response');
      actions.push(...data.actions.filter(a=>identity(a)===id));retried.push(id);
    }
    const unique=new Map();
    for(const a of actions) {
      const id=identity(a);if(!id)throw Error('Midgard action missing transaction');
      if(!unique.has(id)||a.status==='success')unique.set(id,a);
    }
    const parsed=[];
    for(const [id,a] of unique)if(!this.store.data.seen[id])parsed.push({id,a,event:await this.parse(a)});
    parsed.sort((a,b)=>timestamp(a.a)-timestamp(b.a));
    const stats={scanned:unique.size,pendingRetried:retried.length,completed:0,qualifying:0,blocked:0,queued:0,minSwapUsd:this.rules.min};
    this.store.update(s=>{
      s.thorPending ||= {};
      for(const id of retried)if(s.thorPending[id])s.thorPending[id].checkedAt=this.now();
      for(const {id,a,event:e} of parsed) {
        if(a.status==='pending') {
          if(symbol(a.in?.[0]?.coins?.[0]?.asset))s.thorPending[id] ||= {at:timestamp(a),checkedAt:0};
          if(Object.keys(s.thorPending).length>10000)throw Error('THOR pending limit reached');continue;
        }
        delete s.thorPending[id];s.seen[id]=timestamp(a);
        if(a.status==='success')stats.completed++;
        if(!e)continue;
        stats.qualifying++;
        if(this.isBlocked(e.wallet)){stats.blocked++;continue;}
        const key=e.direction+':'+e.wallet,watermark=Math.max(e.at,...(s.windows[key]||[]).map(r=>r.at));
        const rows=(s.windows[key]||[]).filter(r=>r.at>watermark-this.rules.minutes*60000);
        if(e.at>watermark-this.rules.minutes*60000)rows.push(e);s.windows[key]=rows;
        const burst=rows.length>=this.rules.count&&rows.some(r=>r.id===id),label=e.direction==='ETH_TO_BTC'?'Exit to BTC':'BTC → Ethereum';
        s.pending.push({chain:'THOR',wallet:e.wallet,walletChain:'ETH',walletLink:true,txHash:id,alertId:`thor:swap:${id}`,
          title:burst?`THORChain — Burst ${label}`:'THORChain — Large Swap',
          body:[`Wallet: \`${e.wallet.slice(0,6)}...${e.wallet.slice(-4)}\``,`${e.asset} → ${e.outAsset}`,'',
            ...(burst?[`*${rows.length} swaps in ${this.rules.minutes} min*`,`Total: *${money(rows.reduce((n,r)=>n+r.usd,0))}*`]:[]),
            `Swap: ${e.amount.toFixed(4)} ${e.asset} → ${e.outAmount.toFixed(4)} ${e.outAsset}`,`Value: *${money(e.usd)}*`].join('\n')});
        if(s.pending.length>10000)throw Error('THOR alert backlog full');
        stats.queued++;
      }
      s.cursors.THOR={at:end};
      for(const [id,at] of Object.entries(s.seen))if(at<this.now()-30*86400000)delete s.seen[id];
      for(const [key,rows] of Object.entries(s.windows))s.windows[key]=rows.filter(r=>r.at>this.now()-2*86400000&&!this.isBlocked(r.wallet));
    });
    this.flush();
    this.lastScan=stats;
  }
}
module.exports={ThorMonitor,thorSettings,symbol};
