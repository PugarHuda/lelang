// Free audit-trail subscription for public bodies, watchdogs and journalists, built only from the published tenders
// (public/tenders/*.json + .ocds.json):
//   public/feed.xml        Atom feed, one entry per event worth knowing (tender opened, award, human sign-off,
//                          settlement, slash + evidence hash, appeal steps, delivery confirmed / disputed)
//   public/ocds-feed.json  one OCDS 1.1.5 record package with every tender
// Output is deterministic: timestamps come from the tender logs, never from "now", so re-running does not churn git.
// `node scripts/audit-feed.js --validate` also checks the package against the official OCDS schema (needs network).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const SITE = 'https://lelang-ten.vercel.app';
const DIR = 'public/tenders';
const ids = readdirSync(DIR).filter((f) => /^rfq-[\w-]+\.json$/.test(f) && !f.endsWith('.ocds.json')).map((f) => f.slice(0, -5)).sort();
const tenders = ids.map((id) => JSON.parse(readFileSync(`${DIR}/${id}.json`, 'utf8')));

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const bidOf = (msg) => msg.match(/^Bid [A-Z]+/)?.[0];
const slashLink = (rfq, label) => `${SITE}/slash.html?t=${encodeURIComponent(rfq.id)}&b=${encodeURIComponent(label)}`;

// Map one logged event to a feed entry kind, or null when it is internal detail (guard, extract, score, ...).
function kindOf(e) {
  if (e.step === 'rfq') return 'Tender opened';
  if (e.step === 'award') return 'Award decision';
  if (e.step === 'human') return 'Human approver signed';
  if (e.step === 'appeal') return 'Appeal';
  if (e.step === 'dispute') return 'Delivery disputed';
  if (e.step === 'settle') {
    if (/slash/i.test(e.msg)) return 'Slash';
    if (/confirmed delivery/i.test(e.msg)) return 'Delivery confirmed';
    return 'Settlement';
  }
  return null;
}

const entries = [];
for (const rfq of tenders) {
  const tender = `${SITE}/tenders/${rfq.id}.json`;
  const settleGroups = new Map(); // one settlement entry per on-chain settle tx (or per held moment), not per line
  for (const e of rfq.events) {
    const kind = kindOf(e);
    if (!kind) continue;
    const tx = e.data?.tx ?? null;
    if (kind === 'Settlement') {
      const key = tx ?? e.t;
      if (!settleGroups.has(key)) settleGroups.set(key, { rfq, kind, t: e.t, tx, lines: [], link: `${SITE}/index.html` });
      settleGroups.get(key).lines.push(e.msg);
      continue;
    }
    const label = bidOf(e.msg);
    const bid = label && rfq.bids[label];
    const lines = [e.msg];
    let link = `${SITE}/index.html`;
    if (kind === 'Slash' || (kind === 'Appeal' && bid?.slash)) {
      if (bid?.evidenceHash) lines.push(`Evidence hash (keccak256 of the quoted evidence): ${bid.evidenceHash}`);
      link = slashLink(rfq, label);
    }
    if (kind === 'Delivery disputed' && rfq.deliveryDispute?.evidenceHash) lines.push(`Inspection evidence hash: ${rfq.deliveryDispute.evidenceHash}`);
    entries.push({ rfq, kind, t: e.t, tx, lines, link });
  }
  entries.push(...settleGroups.values());
  for (const x of entries) if (x.rfq === rfq) x.tender = tender;
}
entries.sort((a, b) => b.t.localeCompare(a.t) || a.rfq.id.localeCompare(b.rfq.id) || a.kind.localeCompare(b.kind));
const seen = new Map();
for (const x of entries) { // stable, unique ids: tender + kind + timestamp (+ counter if two land on the same ms)
  const base = `tag:lelang-ten.vercel.app,2026:${x.rfq.id}/${x.kind.toLowerCase().replace(/\s+/g, '-')}/${x.t}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  x.id = n ? `${base}/${n}` : base;
}

const entryXml = (x) => `  <entry>
    <id>${xml(x.id)}</id>
    <title>${xml(`${x.kind} · #${x.rfq.chainId} ${x.rfq.title}`)}</title>
    <updated>${x.t}</updated>
    <link rel="alternate" type="text/html" href="${xml(x.link)}"/>
    <link rel="related" type="application/json" title="Tender record" href="${xml(x.tender)}"/>
    <link rel="related" type="application/json" title="OCDS release" href="${xml(`${SITE}/tenders/${x.rfq.id}.ocds.json`)}"/>${x.tx ? `
    <link rel="via" type="text/html" title="Kitescan transaction" href="${xml(x.tx)}"/>` : ''}
    <category term="${xml(x.kind)}"/>
    <content type="text">${xml([...x.lines, ...(x.tx ? [`On-chain: ${x.tx}`] : [])].join('\n'))}</content>
  </entry>`;
const updated = entries[0]?.t ?? '1970-01-01T00:00:00.000Z';
const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${SITE}/feed.xml</id>
  <title>Lelang audit trail</title>
  <subtitle>Every tender opened, award, slash (with its evidence hash), appeal, settlement and delivery outcome on Lelang, with Kitescan proof. Free, no account.</subtitle>
  <updated>${updated}</updated>
  <author><name>Lelang</name><uri>${SITE}/</uri></author>
  <link rel="self" type="application/atom+xml" href="${SITE}/feed.xml"/>
  <link rel="alternate" type="text/html" href="${SITE}/subscribe.html"/>
  <link rel="related" type="application/json" href="${SITE}/ocds-feed.json"/>
${entries.map(entryXml).join('\n')}
</feed>
`;
writeFileSync('public/feed.xml', feed);

// OCDS record package: one record per tender, embedding its published release as both history and compiled release.
const releases = ids.map((id) => JSON.parse(readFileSync(`${DIR}/${id}.ocds.json`, 'utf8')).releases[0]);
const pkg = {
  uri: `${SITE}/ocds-feed.json`,
  version: '1.1',
  publishedDate: releases.map((r) => r.date).sort().at(-1),
  publisher: { name: 'Lelang' },
  extensions: ['https://raw.githubusercontent.com/open-contracting-extensions/ocds_bid_extension/v1.1.5/extension.json'],
  packages: ids.map((id) => `${SITE}/tenders/${id}.ocds.json`),
  records: releases.map((r) => ({ ocid: r.ocid, releases: [r], compiledRelease: r })),
};
writeFileSync('public/ocds-feed.json', JSON.stringify(pkg, null, 2) + '\n');
const counts = entries.reduce((c, x) => ({ ...c, [x.kind]: (c[x.kind] ?? 0) + 1 }), {});
console.log(`feed.xml: ${entries.length} entries from ${tenders.length} tenders`, counts);
console.log(`ocds-feed.json: ${pkg.records.length} records`);

if (process.argv.includes('--validate')) {
  // Same approach as scripts/ocds-validate.js: official 1.1.5 schema with the Bids extension merge-patched in.
  const { default: Ajv } = await import('ajv-draft-04');
  const { default: addFormats } = await import('ajv-formats');
  const BASE = 'https://standard.open-contracting.org/schema/1__1__5';
  const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
  const mergePatch = (target, patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
    for (const [k, v] of Object.entries(patch)) v === null ? delete out[k] : (out[k] = mergePatch(out[k], v));
    return out;
  };
  const [recSchema, relSchema, bidExt, versioned] = await Promise.all([
    get(`${BASE}/record-package-schema.json`),
    get(`${BASE}/release-schema.json`),
    get('https://raw.githubusercontent.com/open-contracting-extensions/ocds_bid_extension/v1.1.5/release-schema.json'),
    get(`${BASE}/versioned-release-validation-schema.json`), // referenced by the record schema; we publish no versionedRelease
  ]);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(mergePatch(relSchema, bidExt), `${BASE}/release-schema.json`);
  ajv.addSchema(versioned, `${BASE}/versioned-release-validation-schema.json`);
  const validate = ajv.compile(recSchema);
  let bad = 0;
  if (validate(pkg)) console.log(`valid OCDS 1.1.5 record package + bids extension: ${pkg.records.length} records`);
  else { bad++; console.log('INVALID record package:', validate.errors.slice(0, 8).map((e) => `${e.instancePath} ${e.message}`)); }
  const broken = structuredClone(pkg); // the validator must bite
  broken.records[0].compiledRelease.tag = ['not-a-tag'];
  delete broken.records[0].ocid;
  if (validate(broken)) { bad++; console.log('validator accepted a broken record'); } else console.log('broken record correctly rejected');
  process.exit(bad ? 1 : 0);
}
