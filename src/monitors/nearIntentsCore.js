const { isFresh, freshAlert } = require('../utils/freshness');
const HOT = '0x2cff890f0378a11913b6129b2e97417a2c302680';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
class NearOutflows {
  constructor(store, { min = 100000, isBlocked = () => false } = {}) {
    if (!Number.isFinite(min) || min <= 0) throw Error('Invalid NEAR_INTENTS_MIN_USD');
    Object.assign(this,{store,min,isBlocked});
    this.wallets=[{chain:'ETH',address:HOT}];
  }
  commit(events, cursors={}, health={}) {
    this.store.update(s=>{
      s.nearReceivers ||= {};
      for(const [wallet,state] of Object.entries(s.nearReceivers))
        if(this.isBlocked(HOT)||this.isBlocked(wallet)||Date.now()-state.lastAt>=2*86400000) delete s.nearReceivers[wallet];
      // Aggregate same-transaction transfers to one receiver before applying the
      // single-withdrawal threshold. Unrelated recipients never combine.
      const grouped=new Map();
      for(const e of events) {
        if(e.from?.toLowerCase()!==HOT || e.token!==WBTC || e.symbol!=='WBTC' || !isFresh(e.at)) continue;
        const to=e.to?.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/.test(to) || to===HOT || /^0x0{40}$/.test(to)) continue;
        const key=e.hash+':'+to, row=grouped.get(key)||{...e,to,usd:0,units:0n,ids:new Set()};
        if(row.ids.has(e.id)) continue;
        row.ids.add(e.id); row.usd+=e.usd; row.units+=BigInt(e.amount); grouped.set(key,row);
      }
      for(const [id,e] of [...grouped].sort((a,b)=>a[1].at-b[1].at || (a[1].order||0)-(b[1].order||0))) {
        if(s.seen[id]) continue;
        s.seen[id]=e.at;
        if(!Number.isFinite(e.usd)||e.usd<this.min||this.isBlocked(HOT)||this.isBlocked(e.to)) continue;
        let state=s.nearReceivers[e.to];
        if(state && e.at<state.lastAt) throw Error('NEAR receipt out of order; saved progress retained');
        if(!state || e.at-state.lastAt>=3600000) state={startedAt:e.at,lastAt:e.at,total:0,units:'0',count:0,rapid:[],stage:0,alertedTotal:0};
        state.lastAt=e.at; state.total+=e.usd; state.units=(BigInt(state.units)+e.units).toString(); state.count++;
        state.rapid=state.rapid.filter(at=>at>e.at-900000);state.rapid.push(e.at);
        const rapidCount=state.rapid.length;
        const stage=rapidCount<3?0:rapidCount<10?1:Math.floor(rapidCount/10)+1;
        const first=state.alertedTotal===0, doubled=!first&&state.total>=state.alertedTotal*2, rapid=stage>state.stage;
        state.stage=Math.max(state.stage,stage); s.nearReceivers[e.to]=state;
        if(!first&&!doubled&&!rapid) continue;
        state.alertedTotal=state.total;
        s.pending.push({alertId:'near-out:'+id,eventAt:e.at,chain:'ETH',wallet:e.to,walletLink:true,
          countedWallets:[HOT,e.to],txHash:e.hash,title:'NEAR Intents — WBTC hot-wallet outflow',
          body:[`Recipient: \`${e.to}\``,`${Number(e.units)/1e8} WBTC (~$${Math.round(e.usd).toLocaleString('en-US')})`,
            `Update: ${first?'first qualifying receipt':[doubled?'tracked value doubled':null,rapid?`${rapidCount} qualifying receipts in 15 minutes`:null].filter(Boolean).join('; ')}`,
            `Tracked total: ${Number(BigInt(state.units))/1e8} WBTC (~$${Math.round(state.total).toLocaleString('en-US')}) across ${state.count} qualifying transactions`,
            `Tracking since: ${new Date(state.startedAt).toISOString()}; resets after one hour without a qualifying receipt.`,
            `From watched hot wallet: \`${HOT}\``,
            'Confirmed Ethereum transfer; no individual NEAR Intents operation match is inferred.'].join('\n')});
      }
      Object.assign(s.cursors,cursors); Object.assign(s.health,health);
      for(const [id,at] of Object.entries(s.seen)) if(at<Date.now()-30*86400000) delete s.seen[id];
    });
  }
  flush(send) {
    this.store.update(s=>{
      for(const wallet of Object.keys(s.nearReceivers||{}))
        if(this.isBlocked(HOT)||this.isBlocked(wallet)) delete s.nearReceivers[wallet];
    });
    for(const a of [...this.store.data.pending]) {
      if(freshAlert(a)&&!a.countedWallets.some(w=>this.isBlocked(w))) send(a);
      this.store.update(s=>{s.pending=s.pending.filter(x=>x.alertId!==a.alertId);});
    }
  }
}
module.exports={HOT,WBTC,NearOutflows};
