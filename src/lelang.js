// Lelang: sealed-bid tender between agents.
// commit (signed hash + bond) -> anchor on Kite -> reveal -> guard -> extract -> rules -> award -> Reppo audit -> settle
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { keccak256, toHex, verifyMessage, encodeAbiParameters, parseAbiParameters } from 'viem';
import { promptGuard, findManipulation, choice, extractBid, writeRationale } from './ai.js';
import { submitEval, waitEval, reppoEnabled } from './reppo.js';
import {
  anchorCommits, transferPie, kiteEnabled, buyerAccount, explorerTx,
  escrowEnabled, escrowOpen, escrowBid, escrowCloseCommits, escrowSettle, escrowAddress,
} from './kite.js';

const FILE = process.env.LELANG_STATE || 'data/state.json';
mkdirSync('data', { recursive: true });
const db = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { rfqs: {} };
const save = () => writeFileSync(FILE, JSON.stringify(db, null, 2));

export const getRfq = (id) => db.rfqs[id];
export const listRfqs = () => Object.values(db.rfqs).map(({ id, title, phase, createdAt }) => ({ id, title, phase, createdAt }));

function log(rfq, step, msg, data) {
  rfq.events.push({ t: new Date().toISOString(), step, msg, ...(data && { data }) });
  save();
  console.log(`[${rfq.id}] ${step}: ${msg}`);
}

// The commitment binds document, salt, bidder and tender, exactly as LelangEscrow.commitmentOf does,
// so a bidder can neither change its document nor copy someone else's commitment.
export const docHashOf = (doc) => keccak256(toHex(doc));
export const commitHash = (doc, salt, bidder, chainId = 0) =>
  keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256'), [docHashOf(doc), salt, bidder, BigInt(chainId)]));
export const commitMessage = (rfqId, hash) => `LELANG commit ${rfqId} ${hash}`;

export async function createRfq(spec) {
  const id = `rfq-${Date.now().toString(36)}`;
  const rfq = { id, createdAt: new Date().toISOString(), phase: 'commit', bids: {}, events: [], ...spec };
  db.rfqs[id] = rfq;
  if (escrowEnabled()) {
    const { chainId, tx } = await escrowOpen(spec.bondPie);
    Object.assign(rfq, { chainId, escrow: escrowAddress() });
    log(rfq, 'rfq', `Tender opened: ${spec.title} (escrow tender #${chainId} on Kite)`, { tx: explorerTx(tx) });
  } else {
    log(rfq, 'rfq', `Tender opened: ${spec.title}`);
  }
  return rfq;
}

// On-chain mode: the bidder's own commit transaction is its authentication, so we read it back from the escrow.
// Off-chain mode: an EIP-191 signature over the commitment stands in for it.
export async function submitCommit(rfqId, { supplier, hash, signature, bondTx }) {
  const rfq = getRfq(rfqId);
  if (rfq.phase !== 'commit') throw new Error('commit phase closed');
  if (rfq.chainId) {
    const onChain = await escrowBid(rfq.chainId, supplier);
    if (onChain.commitment !== hash) throw new Error('commitment not found in escrow');
  } else if (!(await verifyMessage({ address: supplier, message: commitMessage(rfqId, hash), signature }))) {
    throw new Error('bad commit signature');
  }
  const label = `Bid ${String.fromCharCode(65 + Object.keys(rfq.bids).length)}`;
  rfq.bids[label] = { label, supplier, hash, signature, bondTx };
  log(rfq, 'commit', `${label} committed a sealed hash${bondTx ? ` and locked its bond${rfq.chainId ? ' in escrow' : ''}` : ''}`, bondTx && { tx: explorerTx(bondTx) });
  return label;
}

export async function closeCommits(rfqId) {
  const rfq = getRfq(rfqId);
  rfq.phase = 'reveal';
  const n = Object.keys(rfq.bids).length;
  if (rfq.chainId) {
    rfq.anchorTx = await escrowCloseCommits(rfq.chainId);
    log(rfq, 'anchor', `Commits closed on-chain: ${n} sealed bids, bonds locked in the escrow contract`, { tx: explorerTx(rfq.anchorTx) });
  } else if (kiteEnabled()) {
    rfq.anchorTx = await anchorCommits(rfqId, Object.values(rfq.bids).map((b) => b.hash));
    log(rfq, 'anchor', `Deadline passed. ${n} sealed hashes anchored on Kite`, { tx: explorerTx(rfq.anchorTx) });
  } else {
    log(rfq, 'anchor', `Deadline passed. ${n} sealed hashes frozen (Kite not configured, so nothing went on-chain)`);
  }
}

// The document is revealed to the buyer off-chain; on-chain the bidder has already proven which document hash it committed to.
export async function reveal(rfqId, label, { doc, salt, revealTx }) {
  const rfq = getRfq(rfqId);
  const bid = rfq.bids[label];
  bid.doc = doc;
  bid.docHash = docHashOf(doc);
  if (rfq.chainId) {
    const onChain = await escrowBid(rfq.chainId, bid.supplier);
    bid.revealOk = onChain.revealed && onChain.docHash === bid.docHash;
    bid.revealTx = revealTx;
  } else {
    bid.revealOk = commitHash(doc, salt, bid.supplier) === bid.hash;
  }
  log(rfq, 'reveal', `${label} revealed: ${bid.revealOk ? 'matches its sealed commitment' : 'DOES NOT match its sealed commitment'}`, revealTx && { tx: explorerTx(revealTx) });
}

// Hard rules come first and are plain code, not model output.
export function ruleCheck(rfq, t) {
  const fails = [];
  // Missing values fail (in JS `null <= cap` is true, so require real numbers).
  // Zero/negative values would divide-by-zero or dominate the scoring formula, so they fail too.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : NaN);
  if (!(num(t.total_usd) <= rfq.budgetCapUsd)) fails.push(`total $${t.total_usd} missing, invalid or above cap $${rfq.budgetCapUsd}`);
  if (!(num(t.delivery_days) <= rfq.maxDeliveryDays)) fails.push(`delivery ${t.delivery_days}d missing, invalid or above ${rfq.maxDeliveryDays}d`);
  if (!(num(t.warranty_months) <= 120)) fails.push(`warranty ${t.warranty_months}mo missing or implausible`);
  for (const [k, min] of Object.entries(rfq.minSpecs)) {
    if (!(num(t.specs?.[k]) >= min)) fails.push(`${k} ${t.specs?.[k]} below required ${min}`);
  }
  return fails;
}

const FORMULA = 'price part = lowest eligible total / bid total; warranty part = bid months / longest eligible warranty; delivery part = fastest eligible days / bid days; score = sum of weight x part';

// Published scoring formula, each part in 0..1 relative to the best eligible bid.
export function weightedScores(weights, eligible) {
  const t = eligible.map((b) => b.terms);
  const minTotal = Math.min(...t.map((x) => x.total_usd));
  const maxWarranty = Math.max(...t.map((x) => x.warranty_months));
  const minDays = Math.min(...t.map((x) => x.delivery_days));
  return Object.fromEntries(eligible.map((b) => {
    const x = b.terms;
    const s = weights.price * (minTotal / x.total_usd) + weights.warranty * (x.warranty_months / maxWarranty) + weights.delivery * (minDays / x.delivery_days);
    return [b.label, Math.round(s * 1000) / 1000];
  }));
}

// Same formula with every part shown, so the rationale and the auditor see exact numbers instead of re-deriving them.
export function scoreBreakdown(weights, eligible) {
  const t = eligible.map((b) => b.terms);
  const minTotal = Math.min(...t.map((x) => x.total_usd));
  const maxWarranty = Math.max(...t.map((x) => x.warranty_months));
  const minDays = Math.min(...t.map((x) => x.delivery_days));
  const r = (v) => Math.round(v * 1000) / 1000;
  return Object.fromEntries(eligible.map((b) => {
    const x = b.terms;
    const parts = { price: minTotal / x.total_usd, warranty: x.warranty_months / maxWarranty, delivery: minDays / x.delivery_days };
    const weighted = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r(v * weights[k])]));
    return [b.label, { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r(v)])), weighted, total: r(Object.values(parts).reduce((a, v, i) => a + v * weights[Object.keys(parts)[i]], 0)) }];
  }));
}

// A rationale whose final line names the other decision contradicts the action; it must never be submitted.
export function endsWithDecision(rationale, decision) {
  const last = rationale.trim().split(/\r?\n/).filter((l) => l.trim()).at(-1)?.toLowerCase() ?? '';
  const other = decision === 'award' ? 'escalate' : 'award';
  return last.includes(decision) && !last.includes(other);
}

const disqualify = (rfq, bid, reason, slash) => {
  Object.assign(bid, { disqualified: reason, slash });
  log(rfq, 'disqualify', `${bid.label} disqualified: ${reason}${slash ? ' (bond will be slashed)' : ''}`);
};

export async function evaluate(rfqId) {
  const rfq = getRfq(rfqId);
  rfq.phase = 'evaluating';
  const bids = Object.values(rfq.bids);

  for (const bid of bids) {
    if (!bid.revealOk) { disqualify(rfq, bid, 'reveal does not match sealed commitment', true); continue; }

    // Two injection detectors. Slashing someone's bond needs proof, so only a manipulation finding whose quote
    // is verified verbatim in the document disqualifies. A Prompt Guard block on its own is flagged for review.
    const [guard1, inj] = await Promise.all([promptGuard(bid.doc), findManipulation(bid.doc)]);
    // Prompt Guard verdicts vary run to run on clean bids, so a block only counts if it repeats.
    const guard = guard1.blocked ? { ...(await promptGuard(bid.doc)), first: guard1 } : guard1;
    bid.guard = { servPromptGuard: guard, manipulation: inj };
    log(rfq, 'guard', `${bid.label}: SERV Prompt Guard ${guard.blocked ? 'BLOCKED' : 'passed'}, manipulation p=${inj.p.toFixed(2)}${inj.verified ? ' (quote verified in document)' : ''}`);
    if (inj.p > 0.8 && inj.verified) {
      bid.evidence = inj.evidence; // kept for the human reviewer and dashboard, never sent back into an LLM prompt
      disqualify(rfq, bid, 'hidden instructions addressed to the AI evaluator (verbatim quote found in the document)', true);
      continue;
    }
    // Suspicion without proof never slashes, but it does block auto-award (see `flagged` below).
    const why = [guard.blocked && 'SERV Prompt Guard block', inj.p > 0.8 && 'manipulation suspected but quote not found in document'].filter(Boolean);
    if (why.length) {
      bid.review = `${why.join('; ')}: a human should look`;
      log(rfq, 'review', `${bid.label} flagged for human review (${why.join('; ')})`);
    }

    const ex = await extractBid(bid.doc);
    bid.terms = ex.terms;
    log(rfq, 'extract', `${bid.label} terms read by ${ex.engine}: $${ex.terms.total_usd}, ${ex.terms.delivery_days}d, ${ex.terms.warranty_months}mo warranty`);

    const fails = ruleCheck(rfq, ex.terms);
    if (fails.length) disqualify(rfq, bid, fails.join('; '), false);
  }

  const eligible = bids.filter((b) => !b.disqualified);
  if (!eligible.length) {
    rfq.award = { decision: 'no-award', reason: 'no eligible bids' };
    rfq.phase = 'evaluated';
    log(rfq, 'award', 'No eligible bids: tender fails');
    return rfq;
  }

  // A decision node picks among eligible bids against the published weights, with a probability per option.
  const criteria = Object.fromEntries(
    eligible.map((b) => [b.label, `total $${b.terms.total_usd}, delivery ${b.terms.delivery_days} days, warranty ${b.terms.warranty_months} months, specs ${JSON.stringify(b.terms.specs)}`]),
  );
  // Two independent routes to a winner: the published formula in code, and the decision node.
  // Award only when they agree and the node is confident; otherwise a human decides.
  const scores = weightedScores(rfq.weights, eligible);
  const formulaWinner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  log(rfq, 'score', `Published formula: ${Object.entries(scores).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`);

  // The node gets the published rule but not the computed scores, so it is an independent re-check of the formula.
  const w = await choice(
    [`Tender: ${rfq.title}`, `Published award weights: ${JSON.stringify(rfq.weights)}`, `Published scoring rule: ${FORMULA}`],
    'Applying the published scoring rule, which eligible bid scores highest?',
    criteria,
  );
  const { confidence } = w;
  const agree = w.choice === formulaWinner;
  const flagged = eligible.filter((b) => b.review).map((b) => b.label);
  const sane = Object.values(scores).every(Number.isFinite);
  // Any open review flag (e.g. a Prompt Guard block without verified evidence) keeps the tender out of auto-award.
  const decision = agree && sane && !flagged.length && confidence >= rfq.minConfidence ? 'award' : 'escalate';
  if (flagged.length) log(rfq, 'review', `${flagged.join(', ')} still under review: no automatic award`);
  rfq.award = { decision, winner: w.choice, formulaWinner, scores, probabilities: w.probabilities, confidence, engine: w.engine };
  log(rfq, 'award', decision === 'award'
    ? `${w.engine} chose ${w.choice} (confidence ${confidence.toFixed(2)}), matching the published formula`
    : `${w.engine} chose ${w.choice} (confidence ${confidence.toFixed(2)}), formula says ${formulaWinner}: escalated to a human`, { probabilities: w.probabilities });

  const rationaleContext = {
    tender: rfq.title, weights: rfq.weights, budgetCapUsd: rfq.budgetCapUsd, maxDeliveryDays: rfq.maxDeliveryDays, minSpecs: rfq.minSpecs,
    scoringFormula: FORMULA,
    weightedScores: scores,
    scoreBreakdown: scoreBreakdown(rfq.weights, eligible), // exact numbers; the writer must not recompute them
    bids: bids.map((b) => ({ label: b.label, terms: b.terms ?? null, disqualified: b.disqualified ?? null })),
    decision, winner: w.choice, probabilities: w.probabilities,
    escalationReasons: decision === 'escalate'
      ? [!agree && `decision node chose ${w.choice} but formula ranks ${formulaWinner} first`, !sane && 'non-finite score', flagged.length && `${flagged.join(', ')} under human review`, confidence < rfq.minConfidence && `confidence ${confidence.toFixed(2)} below ${rfq.minConfidence}`].filter(Boolean)
      : [],
  };
  rfq.award.rationale = await writeRationale(rationaleContext);
  log(rfq, 'rationale', 'Award rationale written by SERV (Kronos + Shadow Agent checked)');

  if (reppoEnabled()) {
    const input = (rationale) =>
      `User request: run a sealed-bid tender for "${rfq.title}" and award it fairly under published weights ${JSON.stringify(rfq.weights)}, ` +
      `budget cap $${rfq.budgetCapUsd}, max delivery ${rfq.maxDeliveryDays} days, minimum specs ${JSON.stringify(rfq.minSpecs)}. ` +
      `Bids that try to manipulate the evaluator must be disqualified. Published scoring rule: ${FORMULA}. ` +
      // Facts about what this action actually does with money, so the panel can judge safety and reversibility.
      `What the action triggers: ${rfq.chainId
        ? `bonds are held by an escrow smart contract on Kite testnet (tender #${rfq.chainId}); settling refunds every compliant bidder's bond, ` +
          `slashes only bonds whose evidence hash is recorded on-chain, and pays a down payment of ${rfq.depositPie} USDT to the winner; ` +
          `bidders can reclaim their bonds from the contract themselves if the buyer never settles. `
        : `the buyer refunds compliant bonds and pays a down payment of ${rfq.depositPie} to the winner. `}` +
      `Nothing is paid unless this audit routes "ship" or a named human reviewer approves. ` +
      `Policy: award automatically only when an independent decision node and the published formula pick the same bid with confidence >= ${rfq.minConfidence} and no bid is under review; otherwise escalate to a human. ` +
      // Facts computed in code, so the panel can check the policy instead of trusting the rationale's arithmetic.
      `Facts computed by the system, not by the model: formula breakdown ${JSON.stringify(scoreBreakdown(rfq.weights, eligible))}; ` +
      `independent decision node chose ${w.choice} with confidence ${confidence.toFixed(2)}; formula ranks ${formulaWinner} first; ` +
      `bids under review: ${flagged.length ? flagged.join(', ') : 'none'}; disqualified: ${bids.filter((b) => b.disqualified).map((b) => `${b.label} (${b.disqualified})`).join('; ') || 'none'}.

Agent action: ${decision.toUpperCase()} ${w.choice}.

Rationale:
${rationale}`;
    const rounds = [];
    let ev = await audit(rfq, input(rfq.award.rationale), 1);
    rounds.push(round(ev, 'original rationale'));

    // Repair loop (Reppo track: "turn real-time feedback into measurable improvement"), routed by the panel's rubric:
    // - weak correctness/scope is a problem with the rationale itself -> SERV rewrites it against the panel's reason
    //   (writer + Shadow Agent hint, decision and numbers frozen) and the panel scores it again;
    // - weak safety/reversibility is about moving money -> rewriting text can't fix that, so it goes to a human.
    // The gate never loosens: the settlement uses the strictest route of all rounds. A better revised rationale is
    // shown and measured, it does not unlock money (no "audit shopping").
    const rub = ev.result?.rubric_scores ?? {};
    const textProblem = Math.min(rub.correctness ?? 100, rub.scope ?? 100) < 70;
    if (decision === 'award' && ev.status === 'COMPLETED' && ev.result.route !== 'ship') {
      if (textProblem) {
        log(rfq, 'repair', `Reppo ${ev.result.route} (${ev.result.score}), weak ${rub.correctness < 70 ? 'correctness' : 'scope'}: SERV rewrites the rationale against the panel's reason`);
        const revised = await writeRationale(rationaleContext, ev.result.reason);
        if (!endsWithDecision(revised, decision)) {
          log(rfq, 'repair', `Revised rationale contradicts the decision (${decision}); not submitted`);
        } else {
          const ev2 = await audit(rfq, input(revised), 2);
          rounds.push({ ...round(ev2, 'revised with Reppo feedback'), rationale: revised });
          if (ev2.status === 'COMPLETED') log(rfq, 'repair', `Audit score ${ev.result.score} -> ${ev2.result.score} (${ev.result.route} -> ${ev2.result.route})`);
        }
      } else {
        log(rfq, 'repair', `Reppo ${ev.result.route} (${ev.result.score}) on safety ${rub.safety ?? '-'} / reversibility ${rub.reversibility ?? '-'}: a money-moving risk, so a human decides instead of a rewrite`);
      }
    }
    const strictest = strictestRound(rounds) ?? round(ev);
    rfq.reppo = { ...strictest, rounds };
    log(rfq, 'reppo', `Reppo verdict used for settlement (strictest round): ${strictest.route ?? strictest.status} (score ${strictest.score ?? '-'})`, { reason: strictest.reason });
  }

  rfq.phase = 'evaluated';
  save();
  return rfq;
}

// FAILED evaluations are free, so retry a few times before giving up (settlement then stays held).
async function audit(rfq, input, roundNo) {
  let ev;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const id = await submitEval(input, 'action');
    log(rfq, 'reppo', `Independent Reppo audit, round ${roundNo} (${id}, attempt ${attempt}): panel scoring takes 30-90s`);
    ev = { ...(await waitEval(id)), id };
    if (ev.status === 'COMPLETED') break;
    await new Promise((r) => setTimeout(r, 10_000 * attempt));
  }
  return ev;
}
// The settlement gate takes the strictest completed audit round: a later, friendlier round never loosens it.
export function strictestRound(rounds) {
  const SEVERITY = { ship: 0, review: 1, block: 2 };
  const done = rounds.filter((r) => r.status === 'COMPLETED');
  return done.length ? done.reduce((a, b) => ((SEVERITY[b.route] ?? 2) > (SEVERITY[a.route] ?? 2) ? b : a)) : null;
}
const round = (ev, label) => ({ id: ev.id, status: ev.status, score: ev.result?.score, route: ev.result?.route, reason: ev.result?.reason, rubric: ev.result?.rubric_scores, ...(label && { label }) });

// Money moves only when the award is confident AND the independent audit says ship.
export async function settle(rfqId) {
  const rfq = getRfq(rfqId);
  const cleared = rfq.humanApproval || (rfq.award?.decision === 'award' && (!reppoEnabled() || rfq.reppo?.route === 'ship'));
  if (!cleared) {
    rfq.phase = 'held';
    log(rfq, 'settle', `Settlement HELD: award=${rfq.award?.decision}, Reppo=${rfq.reppo?.route ?? 'n/a'}. Bonds stay in escrow pending human review`);
    return rfq;
  }
  // Lock before the first await so a second approve/settle can't start a parallel payout (double spend).
  if (rfq.phase === 'settling' || rfq.phase === 'settled') throw new Error(`tender is already ${rfq.phase}`);
  rfq.phase = 'settling';
  rfq.settlement ??= [];
  save();
  const pay = async (to, amount, why) => {
    // Idempotent per payout: a resumed settlement skips anything already paid.
    if (rfq.settlement.some((p) => p.why === why)) return;
    const tx = kiteEnabled() ? await transferPie(process.env.BUYER_PRIVATE_KEY, to, amount) : null;
    rfq.settlement.push({ to, amount, why, tx: tx && explorerTx(tx) });
    log(rfq, 'settle', `${why}: ${amount}${tx ? '' : ' (Kite not configured, so no transfer was made)'}`, tx && { tx: explorerTx(tx) });
  };
  const win = rfq.bids[rfq.award.winner];
  try {
    if (rfq.chainId) {
      // One escrow transaction: refunds, slashes and the down payment. Each slash carries keccak256 of its evidence,
      // which anyone can recompute from the published quote and check against the revealed document.
      const slashed = Object.values(rfq.bids).filter((b) => b.slash);
      const evidence = slashed.map((b) => keccak256(toHex(b.evidence ?? b.disqualified)));
      slashed.forEach((b, i) => { b.evidenceHash = evidence[i]; });
      const { hash, events } = await escrowSettle(rfq.chainId, win.supplier, slashed.map((b) => b.supplier), evidence, rfq.depositPie);
      const labelOf = (addr) => Object.values(rfq.bids).find((b) => b.supplier.toLowerCase() === addr?.toLowerCase())?.label ?? addr;
      rfq.settlement = events.map((e) => ({ ...e, label: labelOf(e.bidder), tx: explorerTx(hash) }));
      for (const e of rfq.settlement) {
        const what = { BondRefunded: 'bond refunded', BondSlashed: `bond slashed${e.evidenceHash && e.evidenceHash !== `0x${'0'.repeat(64)}` ? ` (evidence ${e.evidenceHash.slice(0, 10)}…)` : ' (never revealed)'}`, Awarded: 'wins: down payment' }[e.event];
        log(rfq, 'settle', `${e.label} ${what}: ${e.amount}`, { tx: explorerTx(hash) });
      }
    } else {
      for (const b of Object.values(rfq.bids)) {
        if (b.slash) { log(rfq, 'settle', `${b.label} bond (${rfq.bondPie}) slashed and kept by the buyer`); continue; }
        await pay(b.supplier, rfq.bondPie, `${b.label} bond refunded`);
      }
      await pay(win.supplier, rfq.depositPie, `${win.label} wins: down payment`);
    }
  } catch (e) {
    // Never leave a tender stuck in 'settling': go back to held so a human can retry (payouts are idempotent).
    rfq.phase = 'held';
    log(rfq, 'error', `Settlement failed, tender back on hold: ${e.shortMessage ?? e.message}`);
    throw e;
  }
  rfq.phase = 'settled';
  save();
  return rfq;
}

// A human reviewer releases a held tender. Their name and note go into the trace next to the machine verdicts.
export async function approve(rfqId, { approver, winner, note }) {
  const rfq = getRfq(rfqId);
  if (rfq.phase !== 'held') throw new Error(`tender is ${rfq.phase}, only held tenders can be approved`);
  const bid = rfq.bids[winner ?? rfq.award?.winner];
  if (!bid || bid.disqualified) throw new Error('winner must be an eligible bid');
  rfq.award = { ...rfq.award, winner: bid.label, decision: 'award' };
  rfq.humanApproval = { approver, note, at: new Date().toISOString() };
  log(rfq, 'human', `${approver} approved ${bid.label}${note ? `: ${note}` : ''}`);
  return settle(rfqId);
}

export const buyerAddress = () => (kiteEnabled() ? buyerAccount().address : null);
