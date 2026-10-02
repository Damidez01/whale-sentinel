const lower = value => String(value || '').toLowerCase();

// This is observed account history, not a claim about wallet age or provenance.
// Full provider pages cannot establish low activity: reject on known high counts,
// otherwise leave the candidate unresolved rather than treating it as a new user.
async function assessHistory({ event, operations, ledger, fills, rules }) {
  const before = event.operationAt;
  if (!Number.isSafeInteger(before) || before <= 0 || before > event.at)
    throw Error('Unit operation time unavailable for history check');
  if (!Array.isArray(operations)) throw Error('Unit history unavailable');
  const prior = new Set();
  for (const op of operations) {
    const belongs = (op.destinationChain === 'hyperliquid' && lower(op.destinationAddress) === event.wallet) ||
      (op.sourceChain === 'hyperliquid' && lower(op.sourceAddress) === event.wallet);
    if (!belongs || op.state !== 'done') continue;
    const at = Date.parse(op.opCreatedAt);
    if (!op.operationId || !Number.isFinite(at)) throw Error('Incomplete Unit history record');
    if (at < before) prior.add(op.operationId);
  }
  const result = { before, unitOperations: prior.size };
  if (prior.size > rules.maxUnitOperations) return { ...result, eligible: false, reason: 'unit-history' };
  if (operations.length >= 100) throw Error('Unit history may be truncated');

  const transfers = await ledger(event.wallet, 0, before - 1);
  if (!Array.isArray(transfers)) throw Error('Hyperliquid ledger history unavailable');
  const transactionIds = new Set();
  for (const row of transfers) {
    if (!Number.isSafeInteger(row.time) || row.time <= 0 || !row.hash || !row.delta?.type)
      throw Error('Incomplete Hyperliquid ledger history record');
    if (row.time < before) transactionIds.add(`${row.time}:${row.hash}`);
  }
  result.ledgerTransactions = transactionIds.size;
  if (transactionIds.size > rules.maxLedgerTransactions) return { ...result, eligible: false, reason: 'hl-ledger-history' };
  if (transfers.length >= 500) throw Error('Hyperliquid ledger history may be truncated');

  // Query latest fills, including activity after the anchor, so a full page of
  // recent trades cannot hide evicted older history and appear to be zero.
  const trades = await fills(event.wallet);
  if (!Array.isArray(trades)) throw Error('Hyperliquid trade history unavailable');
  const orders = new Set();
  for (const row of trades) {
    if (!Number.isSafeInteger(row.time) || row.time <= 0 || !Number.isSafeInteger(row.oid) || !row.coin)
      throw Error('Incomplete Hyperliquid trade history record');
    if (row.time < before) orders.add(`${row.coin}:${row.oid}`);
  }
  result.executedTrades = orders.size;
  if (orders.size > rules.maxExecutedTrades) return { ...result, eligible: false, reason: 'hl-trade-history' };
  if (trades.length >= 2000) throw Error('Hyperliquid trade history may be truncated');
  return { ...result, eligible: true };
}

module.exports = { assessHistory };
