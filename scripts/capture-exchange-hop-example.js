// Public, read-only evidence capture. Does not load credentials or send alerts.
const fs = require('fs'), path = require('path');
const addresses = ['0x4a18c81969EB2dEB26a5869d1bF09C7241D76d2c',
  '0xA73164d5a66d7a10f74De04043bFE72398753040', '0xcF644b86129D2b06f77392662237e9a83C4169Ca'];
async function get(route) {
  const r = await fetch('https://eth.blockscout.com/api/v2/' + route);
  if (!r.ok) throw Error(`Public explorer HTTP ${r.status}`);
  return r.json();
}
(async () => {
  const wallets = [];
  for (const address of addresses) {
    const account = await get(`addresses/${address}`);
    const wallet = { address:address.toLowerCase(), isContract:account.is_contract };
    for (const suffix of ['transactions','internal-transactions','token-transfers']) {
      const data = await get(`addresses/${address}/${suffix}`);
      if (!Array.isArray(data.items) || data.next_page_params) throw Error('Incomplete example history; review pagination');
      wallet[suffix] = data.items.map(r => ({ hash:r.hash || r.transaction_hash, blockNumber:r.block_number,
        at:Date.parse(r.timestamp), from:r.from?.hash?.toLowerCase(), to:r.to?.hash?.toLowerCase(),
        nonce:r.nonce, value:r.value, status:r.status, token:r.token?.address_hash?.toLowerCase(),
        amount:r.total?.value, decimals:r.total?.decimals }));
    }
    wallets.push(wallet);
  }
  const out = path.join(__dirname, '../test/fixtures/fixedfloat-hop.json');
  fs.mkdirSync(path.dirname(out), { recursive:true });
  fs.writeFileSync(out, JSON.stringify({ source:'https://eth.blockscout.com/api/v2', capturedAt:new Date().toISOString(),
    original:'0x0a30af43267b8c63b0fa6580dc3c29c8fb231345', wallets }, null, 2)+'\n');
  console.log(`Captured complete public histories for ${wallets.length} deposit wallets.`);
})().catch(e => { console.error(e.message); process.exitCode=1; });
