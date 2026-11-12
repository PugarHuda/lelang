// Independent check of every slashed bond in a published tender, using only public data:
// the tender JSON (quote + revealed document) and the Kite testnet chain (settle tx + escrow state).
//   node scripts/verify-slash.js [public/tender.json]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseEventLogs, keccak256, toHex } from 'viem';
import { kiteTestnet } from '../src/kite.js';

const { abi } = JSON.parse(readFileSync(new URL('../deployments/kite-testnet.json', import.meta.url), 'utf8'));
const rfq = JSON.parse(readFileSync(process.argv[2] ?? 'public/tender.json', 'utf8'));
const chain = createPublicClient({ chain: kiteTestnet, transport: http() });
const settleTx = rfq.settlement?.find((s) => s.tx)?.tx?.split('/tx/')[1];
assert.ok(rfq.escrow && settleTx, 'tender has no on-chain escrow settlement');

const logs = parseEventLogs({ abi, logs: (await chain.getTransactionReceipt({ hash: settleTx })).logs });
const norm = (s) => s.replace(/\s+/g, ' ').trim();
let n = 0;
for (const log of logs.filter((l) => l.eventName === 'BondSlashed')) {
  const bid = Object.values(rfq.bids).find((b) => b.supplier.toLowerCase() === log.args.bidder.toLowerCase());
  const [, docHash] = await chain.readContract({ address: rfq.escrow, abi, functionName: 'bids', args: [BigInt(rfq.chainId), log.args.bidder] });
  assert.equal(keccak256(toHex(bid.doc)), docHash, `${bid.label}: published document is the one revealed on-chain`);
  assert.equal(keccak256(toHex(bid.evidence ?? bid.disqualified)), log.args.evidenceHash, `${bid.label}: evidence hash matches the published quote`);
  if (bid.evidence) assert.ok(norm(bid.doc).includes(norm(bid.evidence).slice(0, 80)), `${bid.label}: quote appears in the revealed document`);
  console.log(`${bid.label}: slash verified (doc ${docHash.slice(0, 10)}…, evidence ${log.args.evidenceHash.slice(0, 10)}…)`);
  n++;
}
console.log(`${n} slash(es) verified against Kite testnet`);
