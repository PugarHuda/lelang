// Releases a held tender as a named approver: signs the approval (EIP-191) with the approver's own key.
//   APPROVER_PRIVATE_KEY=0x… node scripts/approve.js <server url> <rfq id> [note] [--token T]
import { privateKeyToAccount } from 'viem/accounts';
import { approvalMessage } from '../src/lelang.js';

const args = process.argv.slice(2);
const t = args.indexOf('--token');
const token = t >= 0 ? args.splice(t, 2)[1] : '';
const [server, id, note = ''] = args;
if (!server || !id || !process.env.APPROVER_PRIVATE_KEY) {
  console.error('usage: APPROVER_PRIVATE_KEY=0x… node scripts/approve.js <server url> <rfq id> [note] [--token T]');
  process.exit(2);
}
const me = privateKeyToAccount(process.env.APPROVER_PRIVATE_KEY);
const rfq = await (await fetch(new URL(`/api/rfqs/${id}`, server))).json();
const winner = rfq.award?.winner;
const signature = await me.signMessage({ message: approvalMessage(id, winner, note.slice(0, 200)) });
const q = new URLSearchParams({ token, approver: me.address, note: note.slice(0, 200), winner, signature });
const res = await fetch(new URL(`/api/rfqs/${id}/approve?${q}`, server), { method: 'POST' });
const out = await res.json();
console.log(res.ok ? `released ${winner}: tender is ${out.phase}` : `refused (${res.status}): ${out.error}`);
process.exit(res.ok ? 0 : 1);
