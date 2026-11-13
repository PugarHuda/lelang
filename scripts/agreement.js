// How often the independent decision node picks the same winner as the published formula, over every award decision
// recorded in every tender (re-runs included: each evaluation logs its own 'award' event). A disagreement never moves
// money on its own: the tender escalates to a human.
//   node scripts/agreement.js
import { readFileSync, writeFileSync } from 'node:fs';

const rfqs = Object.values(JSON.parse(readFileSync(process.env.LELANG_STATE || 'data/state.json', 'utf8')).rfqs);
const decisions = rfqs.flatMap((r) => r.events.filter((e) => e.step === 'award' && /decision node chose/.test(e.msg)).map((e) => {
  const m = e.msg.match(/chose (Bid \w+) \(confidence ([\d.]+)\)(?:, formula says (Bid \w+))?/);
  return { tender: r.id, title: r.title, chose: m?.[1], confidence: Number(m?.[2]), formula: m?.[3] ?? m?.[1], agreed: /matching the published formula/.test(e.msg) || m?.[1] === m?.[3] };
}));
const disagreements = decisions.filter((d) => d.agreed === false && d.chose !== d.formula);
const out = {
  ranAt: new Date().toISOString(),
  decisions: decisions.length,
  agreed: decisions.length - disagreements.length,
  agreementPct: Math.round((100 * (decisions.length - disagreements.length)) / (decisions.length || 1)),
  disagreements,
  meanConfidenceWhenDisagreeing: disagreements.length ? +(disagreements.reduce((x, d) => x + d.confidence, 0) / disagreements.length).toFixed(2) : null,
};
writeFileSync('docs/reports/decision-agreement.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, disagreements: disagreements.map((d) => `${d.tender} ${d.title}: node ${d.chose} (${d.confidence}) vs formula ${d.formula}`) }, null, 2));
