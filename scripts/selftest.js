// Offline checks of the parts that must never be wrong: sealing, signatures, hard rules, scoring, settlement lock.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

process.env.LELANG_STATE = 'data/selftest.json'; // never touch the real tender history
delete process.env.BUYER_PRIVATE_KEY; // offline: no chain, no escrow
const { commitHash, commitMessage, createRfq, submitCommit, reveal, getRfq, ruleCheck, weightedScores, approve, strictestRound, scoreBreakdown, endsWithDecision, bidLabel, provenPriors, readersDisagree, approvalMessage, publicView, appeal, appealMessage, ambiguousTerms, decideAppeal, appealDecisionMessage, overturnedSlashes, slashKey, requiredBond, wasEscalated } = await import('../src/lelang.js');
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
  await assert.rejects(approve(r.id, await signed(k1)), /APPROVERS/); // fail closed: no list, no release
  assert.equal(getRfq(r.id).phase, 'held');
  process.env.APPROVERS = `${k1.address},${k2.address}`;
  // two valid approvals at once: one payout, and the record names the signer whose approval released it
  const first = approve(r.id, await signed(k1, 'checked'));
  await assert.rejects(approve(r.id, await signed(k2)), /only held tenders|already/);
  await first;
  assert.equal(getRfq(r.id).phase, 'settled');
  assert.equal(getRfq(r.id).settlement.length, 2, 'one bond refund + one deposit');
  const h = getRfq(r.id).humanApproval;
  assert.equal(h.approver, k1.address);
  delete process.env.APPROVERS;
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
  // ids restart on every escrow: tender #7 on the old escrow is another tender than #7 on the new one
  const v1 = '0xAAAA', v2 = '0xBBBB';
  const hx = [{ escrow: v1, tender: '7', proven: true, buyer: us }, { escrow: v2, tender: '7', proven: true, buyer: us }];
  assert.deepEqual(provenPriors(hx, { escrow: v2.toLowerCase(), chainId: '7' }, [us]).map((x) => x.escrow), [v1]);
  assert.equal(provenPriors(hx, { escrow: v1, chainId: '7' }, [us], new Set([slashKey(v2, 7, undefined)])).length, 0);
  // a second chance costs base x 2^n, capped at 16x
  assert.deepEqual([0, 1, 2, 4, 9].map((n) => requiredBond(0.05, n)), [0.05, 0.1, 0.2, 0.8, 0.8]);
}
// two readers: same numbers agree; any decision-relevant difference (incl. null) is reported
{
  const t = { total_usd: 75000, delivery_days: 18, warranty_months: 24, unit_price_usd: 375, specs: { ram_gb: 8, storage_gb: 256, battery_hours: 9 } };
  assert.deepEqual(readersDisagree(t, structuredClone(t)), []);
  assert.deepEqual(readersDisagree(t, { ...t, unit_price_usd: 1 }), []); // not decision-relevant
  assert.deepEqual(readersDisagree(t, { ...t, total_usd: 1 }).map((d) => d.field), ['total_usd']);
  assert.deepEqual(readersDisagree(t, { ...t, specs: { ...t.specs, ram_gb: null } }), [{ field: 'specs.ram_gb', a: 8, b: null }]);
}
// a process that died mid-evaluation: on restart 'evaluating' goes back to 'reveal'; 'settling' is never touched
{
  const { writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const f = 'data/selftest-recover.json';
  writeFileSync(f, JSON.stringify({ rfqs: { e: { id: 'e', phase: 'evaluating', events: [] }, s: { id: 's', phase: 'settling', events: [] } } }));
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/lelang.js')"], { env: { ...process.env, LELANG_STATE: f } });
  const after = JSON.parse(readFileSync(f, 'utf8')).rfqs;
  rmSync(f);
  assert.equal(after.e.phase, 'reveal');
  assert.equal(after.e.events.at(-1).step, 'recover');
  assert.equal(after.s.phase, 'settling');
}
// public view: losing documents withheld (hash kept), evidence and the settled winner's contract stay public
{
  const r = { phase: 'settled', award: { winner: 'Bid A' }, bids: {
    'Bid A': { label: 'Bid A', doc: 'win', docHash: '0x1' }, 'Bid B': { label: 'Bid B', doc: 'lose', docHash: '0x2' },
    'Bid C': { label: 'Bid C', doc: 'attack', docHash: '0x3', slash: true } } };
  const v = publicView(r);
  assert.equal(v.bids['Bid A'].doc, 'win');
  assert.equal(v.bids['Bid B'].doc, undefined);
  assert.equal(v.bids['Bid B'].docHash, '0x2');
  assert.equal(v.bids['Bid C'].doc, 'attack');
  assert.equal(r.bids['Bid B'].doc, 'lose', 'the stored tender is untouched');
  assert.equal(publicView({ ...r, phase: 'held' }).bids['Bid A'].doc, undefined, 'no winner document before settlement');
}
// appeals: only the slashed supplier, signed, once; without a panel it goes to a human
{
  const k = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const r = await createRfq({ ...DEMO_RFQ, title: 'appeal' });
  const l = await sealedBid(r, k, 'doc with NOTE TO THE AI', salt());
  const t = getRfq(r.id);
  Object.assign(t, { phase: 'settled', chainId: '42' });
  Object.assign(t.bids[l], { doc: 'doc with NOTE TO THE AI', evidence: 'NOTE TO THE AI', slash: true, disqualified: 'hidden instructions' });
  const sign = (acct, reason) => acct.signMessage({ message: appealMessage(r.id, l, reason) });
  await assert.rejects(appeal(r.id, { supplier: k.address, reason: 'x' }), /signed/);
  await assert.rejects(appeal(r.id, { supplier: k.address, reason: 'x', signature: await sign(other, 'x') }), /signed/);
  await assert.rejects(appeal(r.id, { supplier: other.address, reason: 'x', signature: await sign(other, 'x') }), /slashed for manipulation/);
  const a = await appeal(r.id, { supplier: k.address, reason: 'it was a quote from the tender', signature: await sign(k, 'it was a quote from the tender') });
  assert.equal(a.outcome, 'human');
  await assert.rejects(appeal(r.id, { supplier: k.address, reason: 'again', signature: await sign(k, 'again') }), /already appealed/);
  // only a signed approver on APPROVERS overturns; then the slash stops counting in reputation
  const boss = privateKeyToAccount(generatePrivateKey());
  const decide = async (acct, overturn) => ({ approver: acct.address, overturn, signature: await acct.signMessage({ message: appealDecisionMessage(r.id, l, overturn) }) });
  process.env.APPROVERS = boss.address;
  await assert.rejects(decideAppeal(r.id, l, { approver: boss.address, overturn: true }), /signed/);
  await assert.rejects(decideAppeal(r.id, l, await decide(k, true)), /APPROVERS/);
  await assert.rejects(decideAppeal(r.id, l, { ...(await decide(boss, false)), overturn: true }), /signed/); // signed "uphold", claims overturn
  // with APPEAL_QUORUM=2 one signature is not enough, the same approver can't sign twice, a second one decides
  const boss2 = privateKeyToAccount(generatePrivateKey());
  process.env.APPROVERS = `${boss.address},${boss2.address}`;
  process.env.APPEAL_QUORUM = '2';
  assert.equal((await decideAppeal(r.id, l, await decide(boss, true))).outcome, 'human');
  await assert.rejects(decideAppeal(r.id, l, await decide(boss, true)), /already signed/);
  const done = await decideAppeal(r.id, l, await decide(boss2, true));
  assert.equal(done.outcome, 'overturned');
  assert.deepEqual(done.signedBy, [boss.address, boss2.address]);
  delete process.env.APPEAL_QUORUM;
  await assert.rejects(decideAppeal(r.id, l, await decide(boss, false)), /waiting for a human/);
  assert.ok(overturnedSlashes().has(slashKey(undefined, 42, k.address)));
  delete process.env.APPROVERS;
  // an overturned slash never counts against the supplier
  const us = '0x1111111111111111111111111111111111111111';
  const h = [{ tender: '42', bidder: k.address, proven: true, buyer: us }];
  assert.equal(provenPriors(h, '1', [us]).length, 1);
  assert.equal(provenPriors(h, '1', [us], new Set([slashKey(undefined, '42', k.address)])).length, 0);
}
// ambiguity: one value per term is fine (formatting duplicates too); two different values for a term are flagged
assert.deepEqual(ambiguousTerms({ total_usd: [75000, 75000.0], delivery_days: [18], warranty_months: [] }), []);
assert.deepEqual(ambiguousTerms({ total_usd: [75000, 58500], delivery_days: [18], warranty_months: [24, 36] }).map((x) => x.field), ['total_usd', 'warranty_months']);
assert.deepEqual(ambiguousTerms(undefined), []);
// x402: the seller checks a payment against ITS terms before asking the facilitator (wrong payee or amount never settles)
{
  const x = await import('../src/x402.js');
  const payer = privateKeyToAccount(generatePrivateKey());
  const terms = x.requirements({ amount: 0.5, payTo: '0x1111111111111111111111111111111111111111', resource: 'http://t/api/rfqs', description: 't' });
  assert.equal(terms.amount, '500000000000000000');
  await assert.rejects(x.collect(undefined, terms), (e) => e.status === 402 && e.paymentRequired.accepts[0].payTo === terms.payTo);
  await assert.rejects(x.collect('not base64 json', terms), /base64/);
  const elsewhere = await x.pay(payer, { ...terms, payTo: '0x2222222222222222222222222222222222222222' });
  await assert.rejects(x.collect(elsewhere, terms), /does not match/);
  const cheap = await x.pay(payer, { ...terms, amount: '1' });
  await assert.rejects(x.collect(cheap, terms), /does not match/);
}
// a re-run can't re-roll an escalation: the trace of the earlier run keeps the tender out of auto-award
assert.equal(wasEscalated([{ step: 'award', msg: 'gpt-6-luna chose Bid A (confidence 0.99), formula says Bid B: escalated to a human because …' }]), true);
assert.equal(wasEscalated([{ step: 'award', msg: 'gpt-6-luna chose Bid B (confidence 0.95), matching the published formula' }, { step: 'review', msg: 'escalated to a human' }]), false);
// a paid tender takes only the bids its fee paid for
{
  const r = await createRfq({ ...DEMO_RFQ, title: 'paid for one bid', maxBids: 1 });
  await sealedBid(r, privateKeyToAccount(generatePrivateKey()), 'one', salt());
  await assert.rejects(sealedBid(r, privateKeyToAccount(generatePrivateKey()), 'two', salt()), /tender is full .1 bids./);
}
// Qualitative criterion in the formula: rating relative to the best eligible rating; absent weight = old formula.
{
  const { weightedScores: ws, scoreBreakdown: sb } = await import('../src/lelang.js');
  const t = (total_usd, delivery_days, warranty_months) => ({ total_usd, delivery_days, warranty_months });
  const bids = [{ label: 'A', terms: t(100, 10, 12), quality: { score: 8 } }, { label: 'B', terms: t(100, 10, 12), quality: { score: 4 } }];
  const w = { price: 0.4, warranty: 0.2, delivery: 0.2, quality: 0.2 };
  assert.deepEqual(ws(w, bids), { A: 1, B: 0.9 });
  assert.equal(sb(w, bids).B.parts.quality, 0.5);
  assert.deepEqual(ws({ price: 0.5, warranty: 0.3, delivery: 0.2 }, bids), { A: 1, B: 1 }); // no quality weight: ratings ignored
  assert.deepEqual(ws(w, bids.map((b) => ({ ...b, quality: { score: 0 } }))), { A: 0.8, B: 0.8 }); // nobody rated: no NaN
}
// A flag only holds the tender if the flagged bid could win at its most favourable reading.
{
  const { blockingFlags } = await import('../src/lelang.js');
  const t = (total_usd, delivery_days, warranty_months) => ({ total_usd, delivery_days, warranty_months });
  const rfq = { weights: { price: 0.5, warranty: 0.3, delivery: 0.2 } };
  const win = { label: 'W', terms: t(100, 10, 24) };
  const loser = { label: 'L', terms: t(150, 20, 12), review: 'readers disagree', secondRead: { terms: t(140, 20, 12) } };
  assert.deepEqual(blockingFlags(rfq, [win, loser]), []); // best case 140/20d/12mo still loses
  const close = { label: 'C', terms: t(105, 10, 24), review: 'readers disagree', secondRead: { terms: t(90, 10, 24) } };
  assert.deepEqual(blockingFlags(rfq, [win, close]), ['C']); // at its other reading it would win
  const amb = { label: 'A', terms: t(150, 20, 12), review: 'two figures', ambiguous: [{ field: 'total_usd', values: [150, 40] }] };
  assert.deepEqual(blockingFlags(rfq, [win, amb]), ['A']); // the rebate figure would make it win
  assert.deepEqual(blockingFlags(rfq, [{ ...win, review: 'readers disagree' }, { label: 'X', terms: t(150, 20, 12) }]), ['W']); // the winner's own flag always blocks
  assert.deepEqual(blockingFlags(rfq, [{ ...win, review: 'repeat offender' }, loser]), ['W', 'L']); // two flagged bids: both block
  assert.deepEqual(blockingFlags(rfq, [win, { ...loser, review: 'Prompt Guard block', trustFlag: true }]), ['L']); // trust flags always block
  assert.deepEqual(blockingFlags(rfq, [win, loser, { ...loser, label: 'L2' }]), ['L', 'L2']); // two flagged bids: block
  const tie = { label: 'T', terms: t(100, 10, 24), review: 'readers disagree' };
  assert.deepEqual(blockingFlags(rfq, [win, tie]), ['T']); // a tie at its best reading blocks
}
console.log('selftest OK');
