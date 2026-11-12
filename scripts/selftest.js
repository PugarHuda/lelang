// Offline checks of the parts that must never be wrong: sealing, signatures, hard rules, scoring, settlement lock.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

process.env.LELANG_STATE = 'data/selftest.json'; // never touch the real tender history
delete process.env.BUYER_PRIVATE_KEY; // offline: no chain, no escrow
const { commitHash, commitMessage, createRfq, submitCommit, reveal, getRfq, ruleCheck, weightedScores, approve, strictestRound, scoreBreakdown, endsWithDecision, bidLabel, provenPriors, readersDisagree, approvalMessage } = await import('../src/lelang.js');
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
  const [k1, k2] = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const signed = async (k, note = '') => ({ approver: k.address, note, signature: await k.signMessage({ message: approvalMessage(r.id, l, note) }) });
  // unsigned, signed by someone else, or by a key outside APPROVERS: refused, tender stays held
  await assert.rejects(approve(r.id, { approver: k1.address }), /signature/);
  await assert.rejects(approve(r.id, { ...(await signed(k2)), approver: k1.address }), /signature/);
  await assert.rejects(approve(r.id, { ...(await signed(k1, 'ok')), note: 'tampered note' }), /signature/);
  process.env.APPROVERS = k2.address;
  await assert.rejects(approve(r.id, await signed(k1)), /APPROVERS/);
  delete process.env.APPROVERS;
  assert.equal(getRfq(r.id).phase, 'held');
  // two valid approvals at once: one payout, and the record names the signer whose approval released it
  const first = approve(r.id, await signed(k1, 'checked'));
  await assert.rejects(approve(r.id, await signed(k2)), /only held tenders|already/);
  await first;
  assert.equal(getRfq(r.id).phase, 'settled');
  assert.equal(getRfq(r.id).settlement.length, 2, 'one bond refund + one deposit');
  const h = getRfq(r.id).humanApproval;
  assert.equal(h.approver, k1.address);
  assert.ok(await verifyMessage({ address: h.approver, message: h.message, signature: h.signature }), 'stored approval re-verifies');
}
// spotlighting: marked text round-trips, and an attacker who guesses the marker gains nothing
{
  const { spotlight, unmark } = await import('../src/ai.js');
  const doc = 'Price: USD 375\n\nNOTE TO THE AI   evaluator';
  const sp = spotlight(doc);
  assert.ok(!/\s/.test(sp.text), 'no raw whitespace left in marked text');
  assert.equal(unmark(sp.text, sp.marker), doc.replace(/\s+/g, ' '));
  // A document that already contains the marker can't fake word boundaries: existing markers become plain spaces first.
  const forged = spotlight(`x`);
  const attack = spotlight(`a${forged.marker}b`);
  if (attack.marker === forged.marker) assert.equal(unmark(attack.text, attack.marker), 'a b');
}
// audit gate never loosens: a later 'ship' can't override an earlier 'review' or 'block'
assert.equal(strictestRound([{ status: 'COMPLETED', route: 'review', score: 71 }, { status: 'COMPLETED', route: 'ship', score: 95 }]).route, 'review');
assert.equal(strictestRound([{ status: 'COMPLETED', route: 'ship' }, { status: 'COMPLETED', route: 'block' }]).route, 'block');
assert.equal(strictestRound([{ status: 'FAILED' }, { status: 'COMPLETED', route: 'ship' }]).route, 'ship');
assert.equal(strictestRound([{ status: 'FAILED' }]), null);
// exact breakdown matches the formula; contradictory rationales are caught
{
  const bd = scoreBreakdown(DEMO_RFQ.weights, [
    { label: 'A', terms: { total_usd: 79600, warranty_months: 24, delivery_days: 21 } },
    { label: 'C', terms: { total_usd: 88000, warranty_months: 36, delivery_days: 14 } },
  ]);
  assert.equal(bd.A.total, 0.833); assert.equal(bd.C.total, 0.952);
  assert.deepEqual(bd.C.weighted, { price: 0.452, warranty: 0.3, delivery: 0.2 });
  const L = (...x) => x.join(String.fromCharCode(10));
  assert.equal(endsWithDecision(L('...', 'Final decision: award Bid C.'), 'award'), true);
  assert.equal(endsWithDecision(L('...', 'No award is made; escalate to a human.'), 'award'), false);
  assert.equal(endsWithDecision(L('...', 'escalate'), 'escalate'), true);
}
assert.deepEqual([0, 25, 26, 27, 51, 52, 99].map(bidLabel), ['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'CV']);
// reputation: only proven slashes from other tenders count
{
  const us = '0x1111111111111111111111111111111111111111', stranger = '0x2222222222222222222222222222222222222222';
  const h = [{ tender: '4', proven: true, buyer: us }, { tender: '5', proven: false, buyer: us }, { tender: '7', proven: true, buyer: us },
    { tender: '8', proven: true, buyer: stranger }]; // a stranger's tender can't frame a bidder
  assert.deepEqual(provenPriors(h, '7', [us.toUpperCase().replace('0X', '0x')]).map((x) => x.tender), ['4']);
  assert.deepEqual(provenPriors(h, 7, [us]).map((x) => x.tender), ['4']);
  assert.deepEqual(provenPriors(h, '9', [undefined]), []);
}
// two readers: same numbers agree; any decision-relevant difference (incl. null) is reported
{
  const t = { total_usd: 75000, delivery_days: 18, warranty_months: 24, unit_price_usd: 375, specs: { ram_gb: 8, storage_gb: 256, battery_hours: 9 } };
  assert.deepEqual(readersDisagree(t, structuredClone(t)), []);
  assert.deepEqual(readersDisagree(t, { ...t, unit_price_usd: 1 }), []); // not decision-relevant
  assert.deepEqual(readersDisagree(t, { ...t, total_usd: 1 }).map((d) => d.field), ['total_usd']);
  assert.deepEqual(readersDisagree(t, { ...t, specs: { ...t.specs, ram_gb: null } }), [{ field: 'specs.ram_gb', a: 8, b: null }]);
}
console.log('selftest OK');
