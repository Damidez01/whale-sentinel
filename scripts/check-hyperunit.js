// Read-only public API smoke check. Does not load .env, bot credentials or state.
const axios = require('axios');
const { TREASURIES, collectLedger, candidate, matchOperation } = require('../src/monitors/hyperunitCore');
async function main() {
  const minutes = Number(process.argv[2] || 15);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 360) throw Error('Lookback must be 1–360 minutes');
  const end = Date.now() - 30000, start = end - minutes * 60000;
  const ledger = async (user, startTime, endTime) => (await axios.post('https://api.hyperliquid.xyz/info',
    { type: 'userNonFundingLedgerUpdates', user, startTime, endTime }, { timeout: 15000 })).data;
  const cache = new Map();
  for (const treasury of TREASURIES) {
    const rows = await collectLedger(ledger, treasury, start, end);
    const candidates = rows.map(row => candidate(row, treasury)).filter(Boolean).sort((a,b) => b.usd-a.usd);
    let checked = 0, matched = 0;
    const samples = [];
    for (const e of candidates.slice(0, 4)) {
      if (!cache.has(e.wallet)) cache.set(e.wallet,
        (await axios.get(`https://api.hyperunit.xyz/operations/${e.wallet}`, { timeout: 15000 })).data.operations);
      if (!Array.isArray(cache.get(e.wallet))) throw Error('Invalid Unit operations response');
      const result = matchOperation(e, cache.get(e.wallet));
      checked++;
      if (result) { matched++; samples.push({asset:e.asset,usd:e.usd,receiptTime:new Date(e.at).toISOString(),txHash:e.hash}); }
    }
    console.log(JSON.stringify({asset:treasury.asset,ledgerRows:rows.length,candidates:candidates.length,checked,matched,samples}));
  }
}
main().catch(err => { console.error(err.isAxiosError ? `Public API check failed: ${err.response?.status || err.code}` : err.message); process.exitCode=1; });
