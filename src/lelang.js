// Lelang: sealed-bid tender between agents.
// commit (signed hash + bond) -> anchor on Kite -> reveal -> guard -> extract -> rules -> award -> Reppo audit -> settle
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { keccak256, toHex, verifyMessage } from 'viem';
import { promptGuard, findManipulation, choice, extractBid, writeRationale } from './ai.js';
import { submitEval, waitEval, reppoEnabled } from './reppo.js';
import { anchorCommits, transferPie, kiteEnabled, buyerAccount, explorerTx } from './kite.js';

const FILE = 'data/state.json';
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

export const commitHash = (doc, salt) => keccak256(toHex(`${doc}\n--salt:${salt}`));
export const commitMessage = (rfqId, hash) => `LELANG commit ${rfqId} ${hash}`;

export function createRfq(spec) {
  const id = `rfq-${Date.now().toString(36)}`;
  const rfq = { id, createdAt: new Date().toISOString(), phase: 'commit', bids: {}, events: [], ...spec };
  db.rfqs[id] = rfq;
  log(rfq, 'rfq', `Tender opened: ${spec.title}`);
  return rfq;
}

export async function submitCommit(rfqId, { supplier, hash, signature, bondTx }) {
  const rfq = getRfq(rfqId);
  if (rfq.phase !== 'commit') throw new Error('commit phase closed');
  const ok = await verifyMessage({ address: supplier, message: commitMessage(rfqId, hash), signature });
  if (!ok) throw new Error('bad commit signature');
  const label = `Bid ${String.fromCharCode(65 + Object.keys(rfq.bids).length)}`;
  rfq.bids[label] = { label, supplier, hash, signature, bondTx };
  log(rfq, 'commit', `${label} committed a sealed hash${bondTx ? ' and posted its bond' : ''}`, { hash, bondTx });
  return label;
}

export async function closeCommits(rfqId) {
  const rfq = getRfq(rfqId);
  rfq.phase = 'reveal';
  const hashes = Object.values(rfq.bids).map((b) => b.hash);
  if (kiteEnabled()) {
    rfq.anchorTx = await anchorCommits(rfqId, hashes);
    log(rfq, 'anchor', `Deadline passed. ${hashes.length} sealed hashes anchored on Kite`, { tx: explorerTx(rfq.anchorTx) });
  } else {
    log(rfq, 'anchor', `Deadline passed. ${hashes.length} sealed hashes frozen (Kite not configured, so nothing went on-chain)`);
  }
}

export function reveal(rfqId, label, { doc, salt }) {
  const rfq = getRfq(rfqId);
  const bid = rfq.bids[label];
  bid.doc = doc;
  bid.revealOk = commitHash(doc, salt) === bid.hash;
  log(rfq, 'reveal', `${label} revealed: ${bid.revealOk ? 'matches its sealed hash' : 'DOES NOT match its sealed hash'}`);
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
    const [guard, inj] = await Promise.all([promptGuard(bid.doc), findManipulation(bid.doc)]);
    bid.guard = { servPromptGuard: guard, manipulation: inj };
    log(rfq, 'guard', `${bid.label}: SERV Prompt Guard ${guard.blocked ? 'BLOCKED' : 'passed'}, manipulation p=${inj.p.toFixed(2)}${inj.verified ? ' (quote verified in document)' : ''}`);
    if (inj.p > 0.8 && inj.verified) {
      disqualify(rfq, bid, `hidden instructions to the evaluator: "${inj.evidence.slice(0, 120)}"`, true);
      continue;
    }
    if (guard.blocked) {
      bid.review = 'SERV Prompt Guard blocked this document but no manipulating text was found; a human should look';
      log(rfq, 'review', `${bid.label} flagged for human review (Prompt Guard block without verified evidence)`);
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

  const w = await choice([`Tender: ${rfq.title}`, `Published award weights: ${JSON.stringify(rfq.weights)}`], 'Which eligible bid gives the best value under the published award weights?', criteria);
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

  rfq.award.rationale = await writeRationale({
    tender: rfq.title, weights: rfq.weights, budgetCapUsd: rfq.budgetCapUsd, maxDeliveryDays: rfq.maxDeliveryDays, minSpecs: rfq.minSpecs,
    scoringFormula: 'price = lowest total / bid total; warranty = bid months / longest; delivery = fastest days / bid days; score = sum(weight * part)',
    weightedScores: scores,
    bids: bids.map((b) => ({ label: b.label, terms: b.terms ?? null, disqualified: b.disqualified ?? null })),
    decision, winner: w.choice, probabilities: w.probabilities,
  });
  log(rfq, 'rationale', 'Award rationale written by SERV (Kronos + Shadow Agent checked)');

  if (reppoEnabled()) {
    const input =
      `User request: run a sealed-bid tender for "${rfq.title}" and award it fairly under published weights ${JSON.stringify(rfq.weights)}, ` +
      `budget cap $${rfq.budgetCapUsd}, max delivery ${rfq.maxDeliveryDays} days, minimum specs ${JSON.stringify(rfq.minSpecs)}. ` +
      `Bids that try to manipulate the evaluator must be disqualified.\n\nAgent action: ${decision.toUpperCase()} ${w.choice}.\n\nRationale:\n${rfq.award.rationale}`;
    // FAILED evaluations are free, so retry a few times before giving up (settlement then stays held).
    let ev, id;
    for (let attempt = 1; attempt <= 3; attempt++) {
      id = await submitEval(input, 'action');
      log(rfq, 'reppo', `Independent Reppo audit submitted (${id}, attempt ${attempt}), panel scoring takes 30-90s`);
      ev = await waitEval(id);
      if (ev.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 10_000 * attempt));
    }
    rfq.reppo = { id, status: ev.status, score: ev.result?.score, route: ev.result?.route, reason: ev.result?.reason };
    log(rfq, 'reppo', `Reppo verdict: ${ev.result?.route ?? ev.status} (score ${ev.result?.score ?? '-'})`, { reason: ev.result?.reason });
  }

  rfq.phase = 'evaluated';
  save();
  return rfq;
}

// Money moves only when the award is confident AND the independent audit says ship.
export async function settle(rfqId) {
  const rfq = getRfq(rfqId);
  const cleared = rfq.award?.decision === 'award' && (!reppoEnabled() || rfq.reppo?.route === 'ship');
  if (!cleared) {
    rfq.phase = 'held';
    log(rfq, 'settle', `Settlement HELD: award=${rfq.award?.decision}, Reppo=${rfq.reppo?.route ?? 'n/a'}. Bonds stay in escrow pending human review`);
    return rfq;
  }
  rfq.settlement = [];
  const pay = async (to, amount, why) => {
    const tx = kiteEnabled() ? await transferPie(process.env.BUYER_PRIVATE_KEY, to, amount) : null;
    rfq.settlement.push({ to, amount, why, tx: tx && explorerTx(tx) });
    log(rfq, 'settle', `${why}: ${amount} pieUSD${tx ? '' : ' (Kite not configured, so no transfer was made)'}`, tx && { tx: explorerTx(tx) });
  };
  for (const b of Object.values(rfq.bids)) {
    if (b.slash) { log(rfq, 'settle', `${b.label} bond (${rfq.bondPie} pieUSD) slashed and kept by the buyer`); continue; }
    await pay(b.supplier, rfq.bondPie, `${b.label} bond refunded`);
  }
  const win = rfq.bids[rfq.award.winner];
  await pay(win.supplier, rfq.depositPie, `${win.label} wins: down payment`);
  rfq.phase = 'settled';
  save();
  return rfq;
}

export const buyerAddress = () => (kiteEnabled() ? buyerAccount().address : null);
