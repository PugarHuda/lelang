// Validates Lelang's OCDS export against the official OCDS 1.1.5 release package schema, with the official
// Bids extension applied as a JSON Merge Patch (how OCDS extensions are defined).
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync } from 'node:fs';
import { toOcds } from '../src/ocds.js';

const BASE = 'https://standard.open-contracting.org/schema/1__1__5';
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
const mergePatch = (target, patch) => {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) v === null ? delete out[k] : (out[k] = mergePatch(out[k], v));
  return out;
};

const [pkgSchema, relSchema, bidExt] = await Promise.all([
  get(`${BASE}/release-package-schema.json`),
  get(`${BASE}/release-schema.json`),
  get('https://raw.githubusercontent.com/open-contracting-extensions/ocds_bid_extension/v1.1.5/release-schema.json'),
]);
const release = mergePatch(relSchema, bidExt);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(release, `${BASE}/release-schema.json`);
const validate = ajv.compile(pkgSchema);

const source = process.argv[2] ?? (existsSync('data/state.json') ? 'data/state.json' : 'public/tender.json');
const json = JSON.parse(readFileSync(source, 'utf8'));
const tenders = json.rfqs ? Object.values(json.rfqs) : [json];
let bad = 0;
for (const rfq of tenders) {
  const pkg = toOcds(rfq);
  if (validate(pkg)) console.log(`valid OCDS 1.1.5 + bids extension: ${rfq.id} (${rfq.phase})`);
  else { bad++; console.log(`INVALID ${rfq.id}:`, validate.errors.slice(0, 8).map((e) => `${e.instancePath} ${e.message}`)); }
}
// The validator must actually bite: a release with an invalid tag and a missing ocid has to fail.
const broken = toOcds(tenders[0]);
broken.releases[0].tag = ['not-a-tag'];
delete broken.releases[0].ocid;
if (validate(broken)) { console.log('validator accepted a broken release'); bad++; } else console.log('broken release correctly rejected');
process.exit(bad ? 1 : 0);
