// How often the Reppo gate stops an award the rest of the pipeline was ready to make, over every tender evaluated
// with the current pipeline (on-chain escrow). Each hold costs one signed human release; none moved money wrongly.
//   node scripts/reppo-holds.js
import { readFileSync, writeFileSync } from 'node:fs';

const dep = JSON.parse(readFileSync('deployments/kite-testnet.json', 'utf8'));
const escrows = new Set([dep, ...(dep.previous ?? [])].map((d) => d.escrow.address.toLowerCase()));
const all = Object.values(JSON.parse(readFileSync(process.env.LELANG_STATE || 'data/state.json', 'utf8')).rfqs).filter((r) => r.reppo?.rounds?.length && r.award?.decision === 'award');
const rfqs = all.filter((r) => escrows.has(String(r.escrow).toLowerCase()));
const early = all.filter((r) => !rfqs.includes(r));
const rows = rfqs.map((r) => ({
  tender: r.id, escrowTender: r.chainId, route: r.reppo.route, rounds: r.reppo.rounds.map((x) => `${x.route}:${x.score}`),
  allBidsClean: Object.values(r.bids).every((b) => !b.slash && !b.review),
  released: r.humanApproval ? { by: r.humanApproval.approver, note: r.humanApproval.note } : null,
}));
const held = rows.filter((r) => r.route !== 'ship');
const out = {
  ranAt: new Date().toISOString(),
  awardsAudited: rows.length, shipped: rows.length - held.length, held: held.length,
  holdRatePct: Math.round((100 * held.length) / (rows.length || 1)),
  heldWhileAllBidsClean: held.filter((r) => r.allBidsClean).length,
  earlierDevelopmentTenders: { count: early.length, heldOrBlocked: early.filter((r) => r.reppo.route !== 'ship').length, note: 'run on escrows before V1, with an earlier rationale writer; excluded from the rate' },
  rows,
};
writeFileSync('docs/reports/reppo-holds.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, rows: held }, null, 2));
