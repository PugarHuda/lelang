// Copies the latest settled tender into public/tender.json for the static (Vercel) dashboard.
import { readFileSync, writeFileSync } from 'node:fs';
import { toOcds } from '../src/ocds.js';

const { rfqs } = JSON.parse(readFileSync('data/state.json', 'utf8'));
const settled = Object.values(rfqs).filter((r) => r.phase === 'settled').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
if (!settled.length) throw new Error('no settled tender in data/state.json; run `npm run demo` first');
writeFileSync('public/tender.json', JSON.stringify(settled[0], null, 2));
writeFileSync('public/ocds.json', JSON.stringify(toOcds(settled[0]), null, 2));
console.log(`public/tender.json + public/ocds.json <- ${settled[0].id}`);
