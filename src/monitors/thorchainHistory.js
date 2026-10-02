const lower = x => String(x || '').toLowerCase();
function at(action) {
  if (!/^\d+$/.test(action.date || '')) throw Error('Invalid THOR history date');
  const value = Number(BigInt(action.date) / 1000000n);
  if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid THOR history date');
  return value;
}

async function assessThorHistory(event, { request, ethereum, rules }) {
  const ids = new Set(), tokens = new Set(); let token, complete = false;
  for (let page = 0; page < rules.historyMaxPages; page++) {
    const data = await request({ address: event.wallet, type: 'swap', limit: 50,
      ...(token ? { nextPageToken: token } : { timestamp: Math.ceil(event.at / 1000) }) });
    if (!Array.isArray(data?.actions)) throw Error('THOR wallet history unavailable');
    for (const action of data.actions) {
      const time = at(action);
      if (action.type !== 'swap' || action.status !== 'success' || time >= event.at) continue;
      const involved = [...(action.in || []), ...(action.out || []).filter(x => !x.affiliate)]
        .some(x => lower(x.address) === event.wallet);
      if (!involved) throw Error('THOR history outside requested wallet');
      const id = action.in?.[0]?.txID?.toUpperCase();
      if (!id) throw Error('THOR history missing swap identity');
      if (id !== event.id) ids.add(id);
    }
    if (ids.size > rules.maxPriorSwaps) return { eligible: false, priorSwaps: ids.size, reason: 'prior-swaps' };
    const next = data.meta?.nextPageToken;
    if (!next) {
      if (data.actions.length >= 50) throw Error('THOR history may be truncated');
      complete = true; break;
    }
    if (!data.actions.length || tokens.has(next)) throw Error('THOR history pagination stalled');
    tokens.add(next); token = next;
  }
  if (!complete) throw Error('THOR history page budget reached');

  const hashes = new Set();
  // Include native, internal, ERC20 and NFT history in both directions. A full
  // page is unknown unless it already proves that the account is too active.
  for (const action of ['txlist', 'txlistinternal', 'tokentx', 'tokennfttx', 'token1155tx']) {
    const data = await ethereum({ module: 'account', action, address: event.wallet,
      startblock: 0, endblock: 99999999, page: 1, offset: 100, sort: 'asc' });
    const empty = data?.status === '0' && data.message === 'No transactions found' && Array.isArray(data.result) && data.result.length === 0;
    if (!empty && (data?.status !== '1' || !Array.isArray(data.result))) throw Error('Ethereum wallet history unavailable');
    for (const row of data.result) {
      const time = Number(row.timeStamp) * 1000;
      if (!row.hash || !Number.isSafeInteger(time) || time <= 0) throw Error('Invalid Ethereum history record');
      if (lower(row.from) !== event.wallet && lower(row.to) !== event.wallet) throw Error('Ethereum history outside requested wallet');
      if (time < event.at) hashes.add(lower(row.hash));
    }
    if (hashes.size > rules.maxEthTransactions) return { eligible: false, priorSwaps: ids.size, ethTransactions: hashes.size, reason: 'ethereum-history' };
    if (data.result.length >= 100) throw Error('Ethereum history may be truncated');
  }
  return { eligible: true, priorSwaps: ids.size, ethTransactions: hashes.size };
}
module.exports = { assessThorHistory };
