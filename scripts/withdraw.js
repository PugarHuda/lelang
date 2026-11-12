// A bidder reclaims its own bond from the escrow after the settle deadline of a tender the buyer never settled.
//   SUPPLIER_PRIVATE_KEY=0x… node scripts/withdraw.js <escrow tender #>
// (key from data/agents/keys.json: node scripts/withdraw.js 5 --key tender5-supplier)
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { kiteTestnet, deployment, escrowWithdraw, explorerTx } from '../src/kite.js';

const id = BigInt(process.argv[2] ?? NaN);
const k = process.argv.indexOf('--key');
const pk = k >= 0 ? JSON.parse(readFileSync('data/agents/keys.json', 'utf8'))[process.argv[k + 1]] : process.env.SUPPLIER_PRIVATE_KEY;
if (!pk) throw new Error('usage: SUPPLIER_PRIVATE_KEY=0x… node scripts/withdraw.js <escrow tender #> [--key name]');
const me = privateKeyToAccount(pk).address;
const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
const t = await pub.readContract({ address: deployment.escrow.address, abi: deployment.abi, functionName: 'tenders', args: [id] });
const now = (await pub.getBlock()).timestamp;
if (t[6]) throw new Error(`tender #${id} was settled; bonds were already refunded or slashed`);
if (now < t[5]) throw new Error(`too early: the escrow allows withdraw from ${new Date(Number(t[5]) * 1000).toISOString()} (chain time now ${new Date(Number(now) * 1000).toISOString()})`);
console.log(`${me} withdrew its bond from tender #${id}: ${explorerTx(await escrowWithdraw(pk, id))}`);
