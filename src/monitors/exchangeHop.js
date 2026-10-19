const { normalizeWallet, tronFromHex } = require('../utils/addresses');
const { TRON_USDT } = require('./exchangeFeeds');

// Conservative attribution: all positive receipts of this asset must have one
// funder, with enough units to cover every observed outgoing transfer. Gas in a
// different asset is irrelevant. Mixed funders are never guessed or allocated.
function selectOrigin(e, rows, maxHours) {
  if (rows.some(r => !r.hash || !Number.isFinite(r.at) || !r.from || !r.to || !/^\d+$/.test(r.amount)))
    throw Error('Exchange hop history malformed');
  const relevant = rows.filter(r => r.at <= e.at && BigInt(r.amount) > 0n);
  const outgoing = relevant.filter(r => r.from === e.from);
  if (!outgoing.some(r => r.hash.toLowerCase() === e.hash.toLowerCase() && r.to === e.to))
    throw Error('Exchange hop forward not indexed yet');
  // Same-block order is ambiguous in transfer-history APIs; do not infer it.
  const incoming = relevant.filter(r => r.to === e.from);
  if (!incoming.length || incoming.some(r => r.at >= e.at || (e.blockNumber && r.blockNumber >= e.blockNumber))) return null;
  const sources = new Set(incoming.map(r => r.from));
  if (sources.size !== 1) return null;
  const origin = incoming[0].from;
  if (origin === e.from || origin === e.to || /^0x0{40}$/.test(origin)) return null;
  if (e.at - Math.min(...incoming.map(r => r.at)) > maxHours * 3600000) return null;
  const sum = list => list.reduce((n,r) => n + BigInt(r.amount), 0n);
  if (sum(incoming) < sum(outgoing) || sum(outgoing.filter(r => r.hash.toLowerCase() === e.hash.toLowerCase() && r.to === e.to)) < BigInt(e.amount)) return null;
  return { originalSource: origin, fundingHashes: [...new Set(incoming.map(r => r.hash))] };
}

async function traceOrigin(e, { rpc, request, rules }) {
  const rows = [], limit = rules.freshMaxTx + 1;
  if (e.chain === 'ETH') {
    for (const direction of ['fromAddress','toAddress']) {
      const data = await rpc('alchemy_getAssetTransfers', [{ fromBlock:'0x0', toBlock:'0x'+e.blockNumber.toString(16),
        [direction]:e.from, contractAddresses:[e.token], category:['erc20'], order:'asc',
        withMetadata:true, excludeZeroValue:true, maxCount:'0x'+limit.toString(16) }]);
      if (!Array.isArray(data?.transfers)) throw Error('Exchange hop ETH history unavailable');
      if (data.pageKey) return null;
      for (const r of data.transfers) {
        if (normalizeWallet(r.rawContract?.address) !== e.token) throw Error('Exchange hop token mismatch');
        rows.push({ hash:r.hash, at:Date.parse(r.metadata?.blockTimestamp), from:normalizeWallet(r.from), to:normalizeWallet(r.to),
          amount:BigInt(r.rawContract.value).toString(), blockNumber:Number(BigInt(r.blockNum)) });
      }
    }
  } else {
    const token = e.symbol === 'USDT';
    const data = await request(`/v1/accounts/${e.from}/transactions${token ? '/trc20' : ''}`, {
      only_confirmed:true, limit, order_by:'block_timestamp,asc', min_timestamp:0, max_timestamp:e.at,
      ...(token ? { contract_address:TRON_USDT } : {}),
    });
    if (data?.success !== true || !Array.isArray(data.data)) throw Error('Exchange hop TRON history unavailable');
    if (data.meta?.fingerprint) return null;
    for (const r of data.data) {
      if (token) {
        if (r.type !== 'Transfer' || r.token_info?.address !== TRON_USDT) continue;
        rows.push({ hash:r.transaction_id, at:r.block_timestamp, from:normalizeWallet(r.from), to:normalizeWallet(r.to), amount:r.value });
      } else if (r.ret?.[0]?.contractRet === 'SUCCESS') {
        for (const c of r.raw_data?.contract || []) if (c.type === 'TransferContract') {
          const v = c.parameter.value;
          if (!Number.isSafeInteger(v.amount)) throw Error('Unsafe TRX history amount');
          rows.push({ hash:r.txID, at:r.block_timestamp, from:tronFromHex(v.owner_address), to:tronFromHex(v.to_address), amount:String(v.amount) });
        }
      }
    }
  }
  return selectOrigin(e, rows, rules.freshMaxHours);
}
module.exports = { selectOrigin, traceOrigin };
