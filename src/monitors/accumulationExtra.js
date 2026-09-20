// Counts already-downloaded native ETH transfers. No RPC calls or token feed.
function extraAccumulation({ windowAdd, windowGet, getKey, setKey, sendAlert, fmtUSD, shortAddr,
  min = 50000, count = 5, minutes = 30, primaryMinutes = 15 }) {
  for (const value of [min, count, minutes, primaryMinutes]) if (!Number.isFinite(value) || value <= 0) throw Error('Invalid accumulation setting');
  if (!Number.isInteger(count)) throw Error('Accumulation count must be an integer');
  return (tx, usd, chain, primaryTriggered = false) => {
    if (!tx.to) return;
    const wallet = tx.to.toLowerCase(), primary = `accum:primary-active:${chain}:${wallet}`;
    if (primaryTriggered) setKey(primary, '1', primaryMinutes * 60);
    if (!(usd > min)) return; // User requested strictly greater than $50,000.
    const key = `accum:additional:${chain}:${wallet}`;
    const n = windowAdd(key, usd, minutes * 60);
    if (getKey(primary)) return; // Preserve original escalation; don't duplicate its incident.
    if (n < count || (n - count) % 2 !== 0) return;
    const total = windowGet(key, minutes * 60).reduce((sum, v) => sum + Number(v), 0);
    sendAlert({ chain, wallet, walletLink: true, txHash: tx.hash,
      alertId: `evm:accum:additional:${chain}:${wallet}:${n}`,
      title: n === count ? '🟠 Additional Fund Accumulation' : '🟠 Additional Accumulation Escalating',
      body: [`Receiving wallet: \`${shortAddr(wallet)}\``, `${n} incoming transfers in ${minutes} minutes`,
        `Each: > ${fmtUSD(min)}`, `Total received: ${fmtUSD(total)}`, 'Review the source and onward movement; this pattern alone does not prove theft.'].join('\n') });
  };
}
module.exports = { extraAccumulation };
