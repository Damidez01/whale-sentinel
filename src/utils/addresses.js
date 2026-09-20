const { createHash } = require('crypto');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function normalizeWallet(value) {
  if (typeof value !== 'string') return null;
  if (/^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return null;
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== 25 || bytes[0] !== 0x41) return null;
  const hash = data => createHash('sha256').update(data).digest();
  return hash(hash(bytes.subarray(0, 21))).subarray(0, 4).equals(bytes.subarray(21)) ? value : null;
}
function tronFromHex(value) {
  if (!/^41[0-9a-f]{40}$/i.test(value || '')) return null;
  const payload = Buffer.from(value, 'hex');
  const hash = data => createHash('sha256').update(data).digest();
  let n = BigInt('0x' + Buffer.concat([payload, hash(hash(payload)).subarray(0, 4)]).toString('hex'));
  let address = '';
  while (n) { address = ALPHABET[Number(n % 58n)] + address; n /= 58n; }
  return address;
}
module.exports = { normalizeWallet, tronFromHex };
