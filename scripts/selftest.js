// Offline checks of the parts that must never be wrong: sealing, signatures, hard rules, scoring, settlement lock.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

process.env.LELANG_STATE = 'data/selftest.json'; // never touch the real tender history
delete process.env.BUYER_PRIVATE_KEY; // offline: no chain, no escrow
const { commitHash, commitMessage, createRfq, submitCommit, reveal, getRfq, ruleCheck, weightedScores, approve } = await import('../src/lelang.js');
const { DEMO_RFQ } = await import('../src/demo.js');

const salt = () => `0x${randomBytes(32).toString('hex')}`;
const sealedBid = async (rfq, acct, doc, s) => {
  const hash = commitHash(doc, s, acct.address);
  return submitCommit(rfq.id, { supplier: acct.address, hash, signature: await acct.signMessage({ message: commitMessage(rfq.id, hash) }) });
};

// sealing + signatures
{
  const rfq = await createRfq({ ...DEMO_RFQ, title: 'selftest' });
  const acct = privateKeyToAccount(generatePrivateKey());
  const s = salt();
  const hash = commitHash('bid body', s, acct.address);
  const signature = await acct.signMessage({ message: commitMessage(rfq.id, hash) });
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(submitCommit(rfq.id, { supplier: other.address, hash, signature }), /bad commit signature/, 'forged signature');
  assert.notEqual(commitHash('bid body', s, other.address), hash, 'commitment is bound to the bidder (no copying)');
  const label = await submitCommit(rfq.id, { supplier: acct.address, hash, signature });
  getRfq(rfq.id).phase = 'reveal';
  await reveal(rfq.id, label, { doc: 'bid body (edited after deadline)', salt: s });
  assert.equal(getRfq(rfq.id).bids[label].revealOk, false, 'edited bid must fail reveal');
  await reveal(rfq.id, label, { doc: 'bid body', salt: s });
  assert.equal(getRfq(rfq.id).bids[label].revealOk, true);
}

// hard rules
{
  const rfq = { ...DEMO_RFQ };
  const good = { total_usd: 79600, delivery_days: 21, warranty_months: 24, specs: { ram_gb: 8, storage_gb: 256, battery_hours: 10 } };
  assert.deepEqual(ruleCheck(rfq, good), []);
  assert.match(ruleCheck(rfq, { ...good, delivery_days: 45 }).join(), /delivery 45d/);
  assert.match(ruleCheck(rfq, { ...good, delivery_days: 0 }).join(), /delivery 0d/, 'zero days must fail');
  assert.match(ruleCheck(rfq, { ...good, total_usd: -5 }).join(), /total/, 'negative price must fail');
  assert.match(ruleCheck(rfq, { ...good, specs: { ...good.specs, ram_gb: 4 } }).join(), /ram_gb 4 below required 8/);
  assert.match(ruleCheck(rfq, { ...good, total_usd: null }).join(), /above cap/, 'missing price must fail, not pass');
  assert.match(ruleCheck(rfq, { ...good, total_usd: '1' }).join(), /total/, 'string numbers must fail');
}

// published formula
assert.deepEqual(
  weightedScores(DEMO_RFQ.weights, [
    { label: 'A', terms: { total_usd: 79600, warranty_months: 24, delivery_days: 21 } },
    { label: 'C', terms: { total_usd: 88000, warranty_months: 36, delivery_days: 14 } },
  ]),
  { A: 0.833, C: 0.952 },
);

// double approve must not double pay
{
  const r = await createRfq({ ...DEMO_RFQ, title: 'double-approve' });
  const l = await sealedBid(r, privateKeyToAccount(generatePrivateKey()), 'x', salt());
  Object.assign(getRfq(r.id), { phase: 'held', award: { decision: 'escalate', winner: l } });
  const first = approve(r.id, { approver: 't' });
  await assert.rejects(approve(r.id, { approver: 't2' }), /only held tenders/);
  await first;
  assert.equal(getRfq(r.id).phase, 'settled');
  assert.equal(getRfq(r.id).settlement.length, 2, 'one bond refund + one deposit');
}
console.log('selftest OK');
