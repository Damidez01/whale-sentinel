const POOL = '0xa160cdab225685da1d56aa342ad8841c3b53f291';
const TOPIC = '0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931';
const lower = x => String(x || '').toLowerCase();
const address = x => /^0x[0-9a-f]{40}$/i.test(x || '');
const hash = x => /^0x[0-9a-f]{64}$/i.test(x || '');
const number = x => { const n = Number(BigInt(x)); if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid Ethereum number'); return n; };

async function matchTornadoUnit(e, { rpc, history, lookbackHours = 24, confirmations = 12, maxPages = 5 }) {
  if (e.asset !== 'eth' || e.sourceChain !== 'ethereum') return null;
  if (!address(e.source) || !address(e.protocolAddress) || !hash(e.sourceHash)) throw Error('Unit source metadata unavailable');
  if (!(lookbackHours > 0) || !Number.isFinite(lookbackHours) || !Number.isSafeInteger(confirmations) || confirmations < 1)
    throw Error('Invalid Tornado Unit settings');
  const tx = await rpc('eth_getTransactionByHash', [e.sourceHash]);
  const receipt = await rpc('eth_getTransactionReceipt', [e.sourceHash]);
  if (!tx || !receipt) throw Error('Unit source transaction unavailable');
  if (lower(tx.hash) !== lower(e.sourceHash) || lower(receipt.transactionHash) !== lower(e.sourceHash) ||
      tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw Error('Unit source receipt mismatch');
  if (receipt.status !== '0x1') throw Error('Unit source transaction not successful');
  // Direct sender only: never infer a link from the Hyperliquid account alone.
  if (lower(tx.from) !== lower(e.source) || lower(tx.to) !== lower(e.protocolAddress) || BigInt(tx.value) <= 0n) return null;
  const height = number(tx.blockNumber), head = number(await rpc('eth_blockNumber', []));
  if (head - height < confirmations) throw Error('Unit source awaiting confirmations');
  const block = await rpc('eth_getBlockByNumber', [tx.blockNumber, false]);
  if (!block || block.hash !== receipt.blockHash) throw Error('Unit source block changed');
  const depositAt = number(block.timestamp) * 1000, earliest = depositAt - lookbackHours * 3600000;
  const checked = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const data = await history({ module: 'account', action: 'txlistinternal', address: tx.from,
      startblock: 0, endblock: height, page, offset: 100, sort: 'desc' });
    const empty = data?.status === '0' && data.message === 'No transactions found' && Array.isArray(data.result) && !data.result.length;
    if (!empty && (data?.status !== '1' || !Array.isArray(data.result))) throw Error('Tornado receipt history unavailable');
    let pastWindow = false;
    for (const row of data.result) {
      const at = Number(row.timeStamp) * 1000;
      if (!Number.isSafeInteger(at) || at <= 0) throw Error('Invalid Tornado history timestamp');
      if (at < earliest) { pastWindow = true; continue; }
      if (lower(row.from) !== POOL || lower(row.to) !== lower(tx.from) || checked.has(lower(row.hash))) continue;
      if (!hash(row.hash)) throw Error('Invalid Tornado withdrawal hash');
      checked.add(lower(row.hash));
      const withdrawal = await rpc('eth_getTransactionReceipt', [row.hash]);
      if (!withdrawal || lower(withdrawal.transactionHash) !== lower(row.hash)) throw Error('Tornado withdrawal receipt unavailable');
      if (withdrawal.status !== '0x1') continue;
      const withdrawalBlock = number(withdrawal.blockNumber);
      if (withdrawalBlock > height || (withdrawalBlock === height && number(withdrawal.transactionIndex) >= number(receipt.transactionIndex))) continue;
      if (!Array.isArray(withdrawal.logs)) throw Error('Tornado withdrawal logs unavailable');
      const log = withdrawal.logs.find(l => !l.removed && lower(l.address) === POOL && lower(l.topics?.[0]) === TOPIC &&
        /^0x[0-9a-f]{192}$/i.test(l.data || '') && lower('0x' + l.data.slice(26, 66)) === lower(tx.from));
      if (!log) continue;
      const withdrawalHeader = await rpc('eth_getBlockByNumber', [withdrawal.blockNumber, false]);
      if (!withdrawalHeader || withdrawalHeader.hash !== withdrawal.blockHash) throw Error('Tornado withdrawal block changed');
      const withdrawalAt = number(withdrawalHeader.timestamp) * 1000;
      if (withdrawalAt < earliest || withdrawalAt > depositAt) continue;
      return { source: lower(tx.from), account: e.wallet, withdrawalHash: lower(row.hash), withdrawalAt,
        depositHash: lower(e.sourceHash), depositAt, depositEth: Number(BigInt(tx.value)) / 1e18 };
    }
    if (data.result.length < 100 || pastWindow) return null;
  }
  throw Error('Tornado history page limit reached');
}

function tornadoUnitAlert(e, match) {
  return { alertId: `tcunit:${match.depositHash}:${e.wallet}`, tcUnitVerified: true, eventAt: e.at,
    chain: 'ETH', wallet: match.source, countedWallets: [match.source, e.wallet], walletLink: true,
    txHash: match.depositHash, title: 'Tornado 100 ETH withdrawal → Hyperunit deposit',
    body: [
      `Withdrawal recipient / deposit sender: \`${match.source}\``,
      `Hyperliquid account: \`${e.wallet}\``,
      `ETH deposited: *${match.depositEth.toFixed(6)} ETH*`,
      `Hyperliquid credit: ${e.amount.toFixed(6)} ETH (~$${Math.round(e.usd).toLocaleString('en-US')})`,
      `Time from withdrawal to deposit: ${Math.floor((match.depositAt - match.withdrawalAt) / 60000)} min`,
      `[100 ETH pool withdrawal](https://etherscan.io/tx/${match.withdrawalHash})`,
      `[Hyperunit deposit](https://etherscan.io/tx/${match.depositHash})`,
      `[Hyperliquid account on Unit](https://explorer.hyperunit.xyz/addresses/${e.wallet})`,
      'Same-wallet sequence verified; this does not establish theft or the origin of every deposited ETH.',
    ].join('\n') };
}
module.exports = { POOL, TOPIC, matchTornadoUnit, tornadoUnitAlert };
