// Offline checks of the parts that must never be wrong: sealing, signatures, hard rules.
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { commitHash, commitMessage, createRfq, submitCommit, reveal, getRfq, ruleCheck, weightedScores } from '../src/lelang.js';
import { DEMO_RFQ } from '../src/demo.js';

const rfq = createRfq({ ...DEMO_RFQ, title: 'selftest' });
const acct = privateKeyToAccount(generatePrivateKey());
const doc = 'bid body';
const hash = commitHash(doc, 'salt1');
const signature = await acct.signMessage({ message: commitMessage(rfq.id, hash) });

// forged signature is rejected
const other = privateKeyToAccount(generatePrivateKey());
await assert.rejects(submitCommit(rfq.id, { supplier: other.address, hash, signature }), /bad commit signature/);

const label = await submitCommit(rfq.id, { supplier: acct.address, hash, signature });
getRfq(rfq.id).phase = 'reveal';
reveal(rfq.id, label, { doc: 'bid body (edited after deadline)', salt: 'salt1' });
assert.equal(getRfq(rfq.id).bids[label].revealOk, false, 'edited bid must fail reveal');
reveal(rfq.id, label, { doc, salt: 'salt1' });
assert.equal(getRfq(rfq.id).bids[label].revealOk, true);

const good = { total_usd: 79600, delivery_days: 21, warranty_months: 24, specs: { ram_gb: 8, storage_gb: 256, battery_hours: 10 } };
assert.deepEqual(ruleCheck(rfq, good), []);
assert.match(ruleCheck(rfq, { ...good, delivery_days: 45 }).join(), /delivery 45d/);
assert.match(ruleCheck(rfq, { ...good, delivery_days: 0 }).join(), /delivery 0d/, 'zero days must fail');
assert.match(ruleCheck(rfq, { ...good, total_usd: -5 }).join(), /total/, 'negative price must fail');
assert.match(ruleCheck(rfq, { ...good, specs: { ...good.specs, ram_gb: 4 } }).join(), /ram_gb 4 below required 8/);
assert.match(ruleCheck(rfq, { ...good, total_usd: null }).join(), /above cap/, 'missing price must fail, not pass');
const s = weightedScores(DEMO_RFQ.weights, [
  { label: 'A', terms: { total_usd: 79600, warranty_months: 24, delivery_days: 21 } },
  { label: 'C', terms: { total_usd: 88000, warranty_months: 36, delivery_days: 14 } },
]);
assert.deepEqual(s, { A: 0.833, C: 0.952 });
console.log('selftest OK');
