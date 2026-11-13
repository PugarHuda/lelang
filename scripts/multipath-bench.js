// Does SERV Multipath make the award decision node agree with the published formula more often?
// Replays the award node on every recorded tender with eligible bids (same inputs production used), REPEATS times
// with plain SERV and with the -serv-multipath variant, and counts agreement with the formula and confidence.
// The tender where production disagreed at confidence 0.99 is reported on its own. Every run is published.
//   node --env-file=.env scripts/multipath-bench.js [repeats]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { choice } from '../src/ai.js';
import { weightedScores } from '../src/lelang.js';

const REPEATS = Number(process.argv[2] ?? 3);
const FORMULA = 'price part = lowest eligible total / bid total; warranty part = bid months / longest eligible warranty; delivery part = fastest eligible days / bid days; score = sum of weight x part';
const state = JSON.parse(readFileSync('data/state.json', 'utf8')).rfqs;
const published = readdirSync('public/tenders').filter((f) => /^rfq-[\w-]+\.json$/.test(f) && !f.includes('ocds')).map((f) => JSON.parse(readFileSync(`public/tenders/${f}`, 'utf8')));
const tenders = {};
for (const r of [...published, ...Object.values(state)]) {
  const eligible = Object.values(r.bids ?? {}).filter((b) => !b.disqualified && b.terms?.total_usd);
  if (r.award && eligible.length >= 2) tenders[r.id] = { r, eligible };
}
const MODELS = { plain: 'gpt-6-luna', multipath: 'gpt-6-luna-serv-multipath' };
const rows = [];
for (const { r, eligible } of Object.values(tenders)) {
  const scores = weightedScores(r.weights, eligible);
  const formula = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const criteria = Object.fromEntries(eligible.map((b) => [b.label, `total $${b.terms.total_usd}, delivery ${b.terms.delivery_days} days, warranty ${b.terms.warranty_months} months, specs ${JSON.stringify(b.terms.specs)}`]));
  const state = [`Tender: ${r.title}`, `Published award weights: ${JSON.stringify(r.weights)}`, `Published scoring rule: ${FORMULA}`];
  const row = { tender: r.id, formula, margin: +(Object.values(scores).sort((a, b) => b - a).reduce((a, b, i) => (i === 1 ? a - b : a))).toFixed(3), runs: {} };
  for (const [k, model] of Object.entries(MODELS)) {
    row.runs[k] = [];
    for (let i = 0; i < REPEATS; i++) {
      const w = await choice(state, 'Applying the published scoring rule, which eligible bid scores highest?', criteria, model).catch((e) => ({ error: e.message }));
      row.runs[k].push(w.error ? { error: w.error } : { choice: w.choice, confidence: +w.confidence.toFixed(2), agreed: w.choice === formula });
    }
  }
  rows.push(row);
  const fmt = (k) => row.runs[k].map((x) => (x.error ? 'ERR' : `${x.agreed ? 'ok' : 'MISS'} ${x.confidence}`)).join(', ');
  console.log(`${r.id} formula ${formula} (margin ${row.margin}) | plain: ${fmt('plain')} | multipath: ${fmt('multipath')}`);
}
const tally = (k) => {
  const runs = rows.flatMap((r) => r.runs[k]).filter((x) => !x.error);
  const miss = runs.filter((x) => !x.agreed);
  return { runs: runs.length, agreed: runs.length - miss.length, agreementPct: +((100 * (runs.length - miss.length)) / (runs.length || 1)).toFixed(1), confidentMisses: miss.filter((x) => x.confidence >= 0.9).length, errors: rows.flatMap((r) => r.runs[k]).filter((x) => x.error).length };
};
const summary = { ranAt: new Date().toISOString(), tenders: rows.length, repeats: REPEATS, plain: tally('plain'), multipath: tally('multipath'), productionDisagreement: rows.find((r) => r.tender === 'rfq-mwefdu6g') ?? null };
writeFileSync('docs/reports/multipath-bench.json', JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify({ ...summary, productionDisagreement: summary.productionDisagreement?.runs }, null, 2));
