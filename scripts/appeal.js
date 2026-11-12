// A slashed supplier appeals with its own key: signs the appeal and posts it.
//   SUPPLIER_PRIVATE_KEY=0x… node scripts/appeal.js <server url> <rfq id> "<reason>"
import { privateKeyToAccount } from 'viem/accounts';
import { appealMessage } from '../src/lelang.js';

const [server, id, reason] = process.argv.slice(2);
if (!server || !id || !reason || !process.env.SUPPLIER_PRIVATE_KEY) {
  console.error('usage: SUPPLIER_PRIVATE_KEY=0x… node scripts/appeal.js <server url> <rfq id> "<reason>"');
  process.exit(2);
}
const me = privateKeyToAccount(process.env.SUPPLIER_PRIVATE_KEY);
const rfq = await (await fetch(new URL(`/api/rfqs/${id}`, server))).json();
const bid = Object.values(rfq.bids).find((b) => b.supplier.toLowerCase() === me.address.toLowerCase());
if (!bid) throw new Error('this key has no bid in that tender');
const signature = await me.signMessage({ message: appealMessage(id, bid.label, reason) });
const res = await fetch(new URL(`/api/rfqs/${id}/appeal`, server), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ supplier: me.address, reason, signature }) });
const out = await res.json();
console.log(res.ok ? `${bid.label} appeal: ${out.outcome}${out.audit ? ` (Reppo ${out.audit.route} ${out.audit.score}: ${out.audit.reason})` : ''}` : `refused (${res.status}): ${out.error}`);
process.exit(res.ok ? 0 : 1);
