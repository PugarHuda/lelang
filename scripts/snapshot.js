// Publishes every settled tender on the current escrow for the static (Vercel) dashboard:
// public/tenders.json (index), public/tenders/<id>.json + .ocds.json, and public/tender.json + ocds.json for the
// featured one (the richest run), which `npm run verify` checks by default.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { toOcds } from '../src/ocds.js';
import { publicView } from '../src/lelang.js';

const deployment = JSON.parse(readFileSync('deployments/kite-testnet.json', 'utf8'));
const rfqs = Object.fromEntries(Object.entries(JSON.parse(readFileSync('data/state.json', 'utf8')).rfqs).map(([k, r]) => [k, publicView(r)]));
const settled = Object.values(rfqs)
  .filter((r) => r.phase === 'settled' && r.escrow?.toLowerCase() === deployment.escrow.address.toLowerCase())
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
if (!settled.length) throw new Error('no settled tender on the current escrow; run `npm run demo` first');
const featured = [...settled].sort((a, b) => Object.keys(b.bids).length - Object.keys(a.bids).length)[0];

mkdirSync('public/tenders', { recursive: true });
const index = settled.map((r) => {
  writeFileSync(`public/tenders/${r.id}.json`, JSON.stringify(r, null, 2));
  writeFileSync(`public/tenders/${r.id}.ocds.json`, JSON.stringify(toOcds(r), null, 2));
  const n = Object.keys(r.bids).length;
  const slashed = Object.values(r.bids).filter((b) => b.slash).length;
  return { id: r.id, chainId: r.chainId, featured: r === featured, label: `#${r.chainId} · ${r.title} · ${n} bid${n > 1 ? 's' : ''}${slashed ? `, ${slashed} slashed` : ''}` };
});
writeFileSync('public/tenders.json', JSON.stringify(index, null, 2));
writeFileSync('public/tender.json', JSON.stringify(featured, null, 2));
writeFileSync('public/ocds.json', JSON.stringify(toOcds(featured), null, 2));
// The browser verifier reads the escrow ABI from here.
writeFileSync('public/deployment.json', JSON.stringify(deployment, null, 2));
console.log(index.map((t) => `${t.featured ? '*' : ' '} ${t.label}`).join('\n'));
