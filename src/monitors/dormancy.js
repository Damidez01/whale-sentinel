const MONTH_MS = 30 * 86400000;

// Verify the immediately preceding sender nonce, including zero-value contract
// calls and failed sends. Incoming transfers do not define outgoing inactivity.
async function inspectDormancy(tx, { request, months, maxPages = 5 }) {
  if (!Number.isFinite(months) || months <= 0) throw Error('Invalid DORMANT_MONTHS');
  const nonce = Number(tx.nonce), block = Number(tx.blockNumber);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(block) || block <= 0)
    throw Error('Dormancy transaction metadata unavailable');
  if (nonce === 0) return null; // First outgoing transaction is not a reactivation.
  let current, previous;
  for (let page = 1; page <= maxPages; page++) {
    const data = await request({ module: 'account', action: 'txlist', address: tx.from,
      startblock: 0, endblock: block, page, offset: 100, sort: 'desc' });
    if (data?.status !== '1' || !Array.isArray(data.result)) throw Error('Dormancy history unavailable');
    for (const row of data.result) {
      if (row.from?.toLowerCase() !== tx.from?.toLowerCase()) continue;
      if (row.hash?.toLowerCase() === tx.hash?.toLowerCase()) current = row;
      if (Number(row.nonce) === nonce - 1) previous = row;
    }
    if (current && previous) {
      if (Number(current.nonce) !== nonce || Number(current.blockNumber) !== block ||
          (tx.blockHash && current.blockHash?.toLowerCase() !== tx.blockHash.toLowerCase()))
        throw Error('Dormancy history does not match observed transaction');
      if (current.isError === '1' || current.txreceipt_status === '0') return null;
      if (current.isError !== '0' || current.txreceipt_status !== '1') throw Error('Dormancy transaction success unverified');
      const at = Number(current.timeStamp) * 1000, priorAt = Number(previous.timeStamp) * 1000;
      const priorBlock = Number(previous.blockNumber);
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(priorAt) || priorAt <= 0 || at < priorAt ||
          !previous.hash || !Number.isSafeInteger(priorBlock) || priorBlock <= 0 || priorBlock > block) throw Error('Invalid dormancy history timestamp');
      if (at - priorAt < months * MONTH_MS) return null;
      return { eventAt: at, previousAt: priorAt, previousHash: previous.hash, months: (at - priorAt) / MONTH_MS };
    }
    if (data.result.length < 100) break;
  }
  throw Error('Dormancy history incomplete or not indexed yet');
}
module.exports = { inspectDormancy, MONTH_MS };
