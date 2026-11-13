// Publishes every settled tender on the current escrow for the static (Vercel) dashboard:
// public/tenders.json (index), public/tenders/<id>.json + .ocds.json, and public/tender.json + ocds.json for the
// featured one (the richest run), which `npm run verify` checks by default.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { toOcds } from '../src/ocds.js';
import { publicView } from '../src/lelang.js';

const deployment = JSON.parse(readFileSync('deployments/kite-testnet.json', 'utf8'));
// the current escrow and every earlier one: an upgrade must not unpublish verified tenders
const escrows = new Set([deployment, ...(deployment.previous ?? [])].map((d) => d.escrow.address.toLowerCase()));
const rfqs = Object.fromEntries(Object.entries(JSON.parse(readFileSync('data/state.json', 'utf8')).rfqs).map(([k, r]) => [k, publicView(r)]));
const settled = Object.values(rfqs)
  .filter((r) => r.phase === 'settled' && escrows.has(r.escrow?.toLowerCase()))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
if (!settled.length) throw new Error('no settled tender on the current escrow; run `npm run demo` first');
const featured = [...settled].sort((a, b) => Object.keys(b.bids).length - Object.keys(a.bids).length)[0];

mkdirSync('public/tenders', { recursive: true });
const index = settled.map((r) => {
  writeFileSync(`public/tenders/${r.id}.json`, JSON.stringify(r, null, 2));
  writeFileSync(`public/tenders/${r.id}.ocds.json`, JSON.stringify(toOcds(r), null, 2));
  const n = Object.keys(r.bids).length;
  const slashed = Object.values(r.bids).filter((b) => b.slash).length;
  const overturned = Object.values(r.bids).filter((b) => b.appeal?.outcome === 'overturned').length;
  return { id: r.id, chainId: r.chainId, featured: r === featured, label: `#${r.chainId}${r.escrow.toLowerCase() !== deployment.escrow.address.toLowerCase() ? "" : deployment.previous?.length ? " (escrow V2)" : ""} · ${r.title} · ${n} bid${n > 1 ? 's' : ''}${slashed ? `, ${slashed} slashed` : ''}${overturned ? ` (${overturned} overturned on appeal)` : ''}` };
});
writeFileSync('public/tenders.json', JSON.stringify(index, null, 2));
writeFileSync('public/tender.json', JSON.stringify(featured, null, 2));
writeFileSync('public/ocds.json', JSON.stringify(toOcds(featured), null, 2));
// Attackers pay for the audits: slashed bonds (on-chain, sent to the buyer by the escrow) set against the Reppo
// audits run on these tenders, appeals included. Reppo price: 440 credits per evaluation, $1 = 2,000 credits.
const AUDIT_USD = 0.22;
const fund = settled.reduce((f, r) => {
  const slashed = Object.values(r.bids).filter((b) => b.slash && b.appeal?.outcome !== 'overturned'); // overturned = refunded
  f.slashes += slashed.length;
  f.slashedUsd = +(f.slashedUsd + slashed.reduce((x, b) => x + (b.bondPie ?? r.bondPie), 0)).toFixed(6); // a repeat offender may have locked more
  f.audits += (r.reppo?.rounds?.length ?? 0) + Object.values(r.bids).filter((b) => b.appeal?.audit).length;
  return f;
}, { slashes: 0, slashedUsd: 0, audits: 0 });
fund.auditCostUsd = +(fund.audits * AUDIT_USD).toFixed(2);
fund.coveredPct = Math.round((100 * fund.slashedUsd) / (fund.auditCostUsd || 1));
fund.auditUsd = AUDIT_USD;
fund.auditsPerSlashAt10UsdBond = Math.floor(10 / AUDIT_USD);
writeFileSync('public/audit-fund.json', JSON.stringify(fund, null, 2));
// The browser verifier reads the escrow ABI from here.
writeFileSync('public/deployment.json', JSON.stringify(deployment, null, 2));
console.log(index.map((t) => `${t.featured ? '*' : ' '} ${t.label}`).join('\n'));
