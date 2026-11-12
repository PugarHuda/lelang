// Does Reppo feedback measurably improve a rationale? Five deliberately flawed rationales for a real settled tender
// are audited, rewritten by SERV against the panel's stated reason, and audited again. Every result is published,
// including regressions. Costs 10 Reppo evals (FAILED ones are free) + 5 SERV calls.
//   node --env-file=.env scripts/reppo-bench.js [rfq id]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

process.env.LELANG_STATE = 'data/bench-scratch.json'; // audit() logs into the tender; keep the real history clean
const { auditInput, rationaleContextOf, audit, round, endsWithDecision } = await import('../src/lelang.js');
const { writeRationale } = await import('../src/ai.js');

const all = JSON.parse(readFileSync('data/state.json', 'utf8')).rfqs;
const base = process.argv[2]?.startsWith('rfq-') ? all[process.argv[2]] : Object.values(all)
  .filter((r) => r.phase === 'settled' && Object.keys(r.bids).length >= 5).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
if (base?.award?.decision !== 'award') throw new Error('need a settled tender with an award');
const ctx = rationaleContextOf(base);
const W = ctx.winner;
const [other] = Object.keys(ctx.scoreBreakdown).filter((k) => k !== W);
const bd = ctx.scoreBreakdown;
const dq = ctx.bids.filter((b) => b.disqualified);

// Each defect is something a real model draft gets wrong; all keep the correct final decision line.
const FLAWED = {
  'wrong numbers': `${W} wins with a total score of ${bd[other].total}, ahead of ${other} at ${bd[W].total}. ${W} has the lowest price of all bids.\n\nFinal decision: award ${W}.`,
  'missing criteria': `${W} offers good value on price (weighted ${bd[W].weighted.price}).\n\nFinal decision: award ${W}.`,
  'unexplained disqualifications': `${W} scores ${bd[W].total} against ${other} at ${bd[other].total}: price ${bd[W].weighted.price}, warranty ${bd[W].weighted.warranty}, delivery ${bd[W].weighted.delivery}. The other bids were not considered.\n\nFinal decision: award ${W}.`,
  hedged: `${W} probably seems like the better option overall, although we did not fully check every criterion and the numbers may be off. It is likely fine.\n\nFinal decision: award ${W}.`,
  'scope creep': `${W} scores ${bd[W].total}. Our team also visited ${W}'s warehouse, confirmed its strong reputation with past clients, and negotiated an extra 5% discount after the deadline, which makes it the clear choice. Disqualified: ${dq.map((b) => b.label).join(', ')}.\n\nFinal decision: award ${W}.`,
};

const rows = process.argv.includes('--summarize') ? JSON.parse(readFileSync(`docs/reports/reppo-bench-${base.id}.json`, 'utf8')).rows : [];
const rfq = structuredClone(base);
rfq.events = [];
for (const [defect, flawed] of Object.entries(FLAWED)) {
  if (process.argv.includes('--summarize')) break;
  if (!endsWithDecision(flawed, 'award')) throw new Error(`fixture "${defect}" lost its decision line`);
  const before = round(await audit(rfq, auditInput(rfq, flawed), 1));
  const row = { defect, before, flawed };
  if (before.status === 'COMPLETED') {
    const rub = before.rubric ?? {};
    // what the production gate would do with this verdict (see evaluate)
    row.productionWouldRepair = before.route !== 'ship' && Math.min(rub.correctness ?? 100, rub.scope ?? 100) < 70;
    row.revised = await writeRationale(ctx, before.reason);
    row.after = endsWithDecision(row.revised, 'award') ? round(await audit(rfq, auditInput(rfq, row.revised), 2)) : { status: 'NOT SUBMITTED', reason: 'revision contradicts the decision' };
  }
  rows.push(row);
  const f = (r) => (r?.status === 'COMPLETED' ? `${r.route} ${r.score}` : r?.status ?? '-');
  console.log(`${defect.padEnd(30)} ${f(row.before).padEnd(12)} -> ${f(row.after)}`);
}

// a COMPLETED verdict can still carry no score (seen once); null - x would count as 0 in JS, so require numbers
const scored = (r) => r?.status === 'COMPLETED' && typeof r.score === 'number';
const done = rows.filter((r) => scored(r.before) && scored(r.after));
const deltas = done.map((r) => r.after.score - r.before.score);
const summary = {
  tender: base.id, ranAt: process.argv.includes('--summarize') ? JSON.parse(readFileSync(`docs/reports/reppo-bench-${base.id}.json`, 'utf8')).summary.ranAt : new Date().toISOString(), pairs: done.length,
  improved: deltas.filter((d) => d > 0).length, worse: deltas.filter((d) => d < 0).length,
  meanDelta: deltas.length ? +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1) : null,
  completedPairsWithoutScore: rows.filter((r) => r.before.status === 'COMPLETED' && r.after?.status === 'COMPLETED').length - done.length,
  shipBefore: done.filter((r) => r.before.route === 'ship').length, shipAfter: done.filter((r) => r.after.route === 'ship').length,
};
mkdirSync('docs/reports', { recursive: true });
writeFileSync(`docs/reports/reppo-bench-${base.id}.json`, JSON.stringify({ summary, rows }, null, 2));
console.log(summary);
