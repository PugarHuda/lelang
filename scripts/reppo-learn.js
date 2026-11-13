// Does the system get better across tenders from Reppo's feedback, not just within one draft?
// 1. Every rationale the independent Reppo panel scored with a rubric (production rounds and the benchmark) is collected.
//    (Reppo's free-text reason explains its routing, not the text, so the rubric is the signal we learn from.)
// 2. SERV Kronos compares low and high scorers and writes a few general rules; each must cite at least two examples.
// 3. Leave-one-out test on every tender whose first production draft did not ship: rules distilled WITHOUT that
//    tender's own rationales, then a fresh first draft without rules vs with rules, both audited by Reppo.
// The rules distilled from all critiques become docs/reports/reppo-lessons.json, which production evaluate() reads.
// Every result is published, regressions included. Costs 2 Reppo evals per test tender.
//   node --env-file=.env scripts/reppo-learn.js [--lessons-only]
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';

process.env.LELANG_STATE = 'data/bench-scratch.json'; // audit() logs into the tender; keep the real history clean
const { auditInput, rationaleContextOf, audit, round, endsWithDecision } = await import('../src/lelang.js');
const { writeRationale, distillLessons } = await import('../src/ai.js');

const state = JSON.parse(readFileSync('data/state.json', 'utf8')).rfqs;
const published = readdirSync('public/tenders').filter((f) => /^rfq-[\w-]+\.json$/.test(f) && !f.includes('ocds'))
  .map((f) => JSON.parse(readFileSync(`public/tenders/${f}`, 'utf8')));
const tenders = {};
for (const r of [...published, ...Object.values(state)]) if (r.award?.scores && r.award?.confidence != null) tenders[r.id] = r;
const roundsOf = (r) => r.reppo?.rounds ?? (r.reppo ? [r.reppo] : []);

// 1. labelled examples: a rationale and the rubric the panel gave it (rounds without a rubric carry no signal)
const critiques = [];
for (const r of Object.values(tenders)) {
  const rs = roundsOf(r);
  // the stored award rationale is what the panel scored when there was a single round
  if (rs.length === 1 && rs[0].status === 'COMPLETED' && rs[0].rubric && r.award?.rationale) critiques.push({ tender: r.id, source: 'production', text: r.award.rationale, rubric: rs[0].rubric, route: rs[0].route, score: rs[0].score });
  for (const x of rs) if (x.status === 'COMPLETED' && x.rubric && x.rationale) critiques.push({ tender: r.id, source: 'production repair', text: x.rationale, rubric: x.rubric, route: x.route, score: x.score });
}
for (const f of readdirSync('docs/reports').filter((x) => /^reppo-bench-rfq-.*.json$/.test(x))) {
  const { summary, rows } = JSON.parse(readFileSync(`docs/reports/${f}`, 'utf8'));
  for (const row of rows) for (const [x, text] of [[row.before, row.flawed], [row.after, row.revised]]) {
    if (x?.status === 'COMPLETED' && x.rubric && text) critiques.push({ tender: summary.tender, source: `benchmark (${row.defect})`, text, rubric: x.rubric, route: x.route, score: x.score });
  }
}
console.log(`${critiques.length} scored rationales from ${new Set(critiques.map((c) => c.tender)).size} tenders`);

const distill = async (pool) => (await distillLessons(pool)).map((l) => ({ rule: l.rule, from: l.sources.map((n) => ({ tender: pool[n].tender, source: pool[n].source, route: pool[n].route, score: pool[n].score })) }));

// 2. production rules, from every critique
const lessons = await distill(critiques);
mkdirSync('docs/reports', { recursive: true });
writeFileSync('docs/reports/reppo-lessons.json', JSON.stringify({ distilledAt: new Date().toISOString(), model: 'SERV gpt-6-luna-serv-kronos', scoredRationales: critiques.length, lessons }, null, 2));
lessons.forEach((l, i) => console.log(`(${i + 1}) ${l.rule}  [${l.from.length} critiques]`));
if (process.argv.includes('--lessons-only')) process.exit(0);

// 3. leave-one-out on the tenders whose first production draft did not ship
const tests = Object.values(tenders).filter((r) => roundsOf(r)[0]?.status === 'COMPLETED' && roundsOf(r)[0].route !== 'ship');
const rows = [];
const f = (r) => (r?.status === 'COMPLETED' ? `${r.route} ${r.score}` : r?.status ?? '-');
for (const base of tests) {
  const rfq = structuredClone(base);
  rfq.events = [];
  const ctx = rationaleContextOf(rfq);
  const held = await distill(critiques.filter((c) => c.tender !== base.id)); // never its own rationales
  const draft = async (rules) => {
    const text = await writeRationale(ctx, undefined, rules);
    return { text, audit: endsWithDecision(text, rfq.award.decision) ? round(await audit(rfq, auditInput(rfq, text), 1)) : { status: 'NOT SUBMITTED', reason: 'draft contradicts the decision' } };
  };
  const without = await draft([]);
  const withRules = await draft(held);
  rows.push({ tender: base.id, decision: base.award.decision, firstProductionRound: round(roundsOf(base)[0]), rulesUsed: held, without, withRules });
  console.log(`${base.id} (${base.award.decision}) production first round ${f(roundsOf(base)[0])} | now without rules ${f(without.audit)} | with rules ${f(withRules.audit)}`);
}

const scored = (r) => r?.status === 'COMPLETED' && typeof r.score === 'number';
const pairs = rows.filter((r) => scored(r.without.audit) && scored(r.withRules.audit));
const deltas = pairs.map((r) => r.withRules.audit.score - r.without.audit.score);
const summary = {
  ranAt: new Date().toISOString(), tests: rows.length, scoredPairs: pairs.length,
  improved: deltas.filter((d) => d > 0).length, worse: deltas.filter((d) => d < 0).length, same: deltas.filter((d) => d === 0).length,
  meanDelta: deltas.length ? +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1) : null,
  shipWithout: pairs.filter((r) => r.without.audit.route === 'ship').length, shipWith: pairs.filter((r) => r.withRules.audit.route === 'ship').length,
};
writeFileSync('docs/reports/reppo-learn.json', JSON.stringify({ summary, rows }, null, 2));
console.log(summary);
