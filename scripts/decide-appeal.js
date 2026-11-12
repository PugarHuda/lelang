// A named approver decides an appeal the panel did not confirm: signs "overturn" or "uphold" (APPROVERS only).
//   APPROVER_PRIVATE_KEY=0x… node scripts/decide-appeal.js <server url> <rfq id> <bid label> overturn|uphold [--token T]
import { privateKeyToAccount } from 'viem/accounts';
import { appealDecisionMessage } from '../src/lelang.js';

const args = process.argv.slice(2);
const t = args.indexOf('--token');
const token = t >= 0 ? args.splice(t, 2)[1] : '';
const [server, id, label, verdict] = args;
if (!server || !id || !label || !['overturn', 'uphold'].includes(verdict) || !process.env.APPROVER_PRIVATE_KEY) {
  console.error('usage: APPROVER_PRIVATE_KEY=0x… node scripts/decide-appeal.js <server url> <rfq id> <bid label> overturn|uphold [--token T]');
  process.exit(2);
}
const me = privateKeyToAccount(process.env.APPROVER_PRIVATE_KEY);
const overturn = verdict === 'overturn';
const signature = await me.signMessage({ message: appealDecisionMessage(id, label, overturn) });
const res = await fetch(new URL(`/api/rfqs/${id}/appeal-decision?token=${encodeURIComponent(token)}`, server), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, approver: me.address, signature, overturn }),
});
const out = await res.json();
console.log(res.ok ? `${label}: ${out.outcome}${out.refundTx ? ` (refund ${out.refundTx})` : ''}` : `refused (${res.status}): ${out.error}`);
process.exit(res.ok ? 0 : 1);
