// A named approver decides an appeal the panel did not confirm: signs "overturn" or "uphold" (APPROVERS only).
// On a V4 escrow an overturn is also a vote on-chain: this script sends overturnSlash with the approver's own key, and
// once `quorum` approvers have sent theirs inside the challenge window the escrow returns the bond itself.
//   APPROVER_PRIVATE_KEY=0x… node scripts/decide-appeal.js <server url> <rfq id> <bid label> overturn|uphold [--token T]
import { privateKeyToAccount } from 'viem/accounts';
import { appealDecisionMessage } from '../src/lelang.js';
import { escrowFor, escrowV4, escrowOverturn, explorerTx } from '../src/kite.js';

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
const api = (path) => new URL(`/api/rfqs/${id}${path}?token=${encodeURIComponent(token)}`, server);
const res = await fetch(api('/appeal-decision'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, approver: me.address, signature, overturn }),
});
const out = await res.json();
console.log(res.ok ? `${label}: ${out.outcome}${out.refundTx ? ` (refund ${out.refundTx})` : ''}` : `refused (${res.status}): ${out.error}`);
if (!res.ok) process.exit(1);

const rfq = await (await fetch(api(''))).json();
if (overturn && rfq.chainId && escrowV4(escrowFor(rfq.escrow)?.abi ?? [])) {
  const { hash, logs } = await escrowOverturn(process.env.APPROVER_PRIVATE_KEY, rfq.chainId, rfq.bids[label].supplier, rfq.escrow);
  const final = logs.some((l) => l.eventName === 'SlashOverturned');
  console.log(`on-chain vote: ${explorerTx(hash)}${final ? ' (quorum reached: the escrow returned the bond)' : ' (waiting for the other approvers)'}`);
  await fetch(api('/overturn-tx'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, tx: explorerTx(hash), final }) });
}
process.exit(0);
