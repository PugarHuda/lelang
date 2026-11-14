// One-off: release the held dispute tender after a buyer top-up, then file the delivery dispute.
//   node --env-file=.env scripts/dispute-retry.js <rfqId>
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { transferPie, explorerTx } from '../src/kite.js';
const { approve, approvalMessage, disputeDelivery, getRfq } = await import('../src/lelang.js');
const id = process.argv[2];
const keys = JSON.parse(readFileSync('data/agents/keys.json', 'utf8'));
console.log('top-up:', explorerTx(await transferPie(keys['tender5-supplier'], privateKeyToAccount(process.env.BUYER_PRIVATE_KEY).address, 0.05)));
const approver = privateKeyToAccount(keys.approver);
const winner = 'Bid B', note = 'held because of a review flag; released to Bid B, first on the published formula (0.971)';
const signature = await approver.signMessage({ message: approvalMessage(id, winner, note) });
const r = await approve(id, { approver: approver.address, winner, note, signature });
console.log('phase:', r.phase, r.delivery);
const evidence = 'INSPECTION REPORT - receiving committee, 3 vocational schools\nDelivered: 12 document cameras, 31 days after award.\n' +
  'Spec check on 3 sampled units: 2 GB RAM and 16 GB storage each; battery backup lasted 1 hour in our test.\nWarranty card in the box: 12 months.\nThe committee does not accept the delivery as offered.';
const d = await disputeDelivery(id, evidence);
console.log(JSON.stringify(d.deliveryDispute ?? d, null, 2));
console.log(getRfq(id).events.slice(-4).map((e) => `${e.step}: ${e.msg}`).join('\n'));
