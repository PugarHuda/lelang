// Break Lelang: pay the small x402 fee and have the real evaluator judge your attack paragraph.
//   PAYER_PRIVATE_KEY=0x… node scripts/break-lelang.js "<paragraph appended to the bid>" [server] [--arc]
// The payer needs PYUSD on Kite testnet (claim() on 0x8E04…2ec9 mints 10) or, with --arc, USDC on Arc testnet.
import { privateKeyToAccount } from 'viem/accounts';
import { fetchPaying } from '../src/x402.js';

const args = process.argv.slice(2).filter((a) => a !== '--arc');
const [attack, server = 'https://lelang-6k05.onrender.com'] = args;
if (!attack || !process.env.PAYER_PRIVATE_KEY) {
  console.error('usage: PAYER_PRIVATE_KEY=0x… node scripts/break-lelang.js "<attack paragraph>" [server] [--arc]');
  process.exit(2);
}
const res = await fetchPaying(`${server}/api/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attack }) },
  privateKeyToAccount(process.env.PAYER_PRIVATE_KEY), 0.1, process.argv.includes('--arc') ? 'eip155:5042002' : 'eip155:2368');
console.log(res.status, JSON.stringify(await res.json(), null, 2));
