// An independent supplier agent: it holds only its own key and talks to a Lelang server over HTTP.
//   SUPPLIER_PRIVATE_KEY=0x… node scripts/supplier-agent.js <server url> <rfq id> <bid document file>
// On-chain tenders: it locks its own bond and reveals from its own wallet (needs KITE gas + the bond token).
// Off-chain tenders: it signs the commitment instead.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { commitHash, commitMessage, docHashOf } from '../src/lelang.js'; // same commitment as LelangEscrow.commitmentOf
import { escrowCommit, escrowReveal } from '../src/kite.js';

const [server, rfqId, docFile] = process.argv.slice(2);
if (!server || !rfqId || !docFile || !process.env.SUPPLIER_PRIVATE_KEY) {
  console.error('usage: SUPPLIER_PRIVATE_KEY=0x… node scripts/supplier-agent.js <server url> <rfq id> <bid document file>');
  process.exit(2);
}
const pk = process.env.SUPPLIER_PRIVATE_KEY;
const me = privateKeyToAccount(pk);
const doc = readFileSync(docFile, 'utf8');
const api = async (path, init) => {
  const res = await fetch(new URL(path, server), init && { ...init, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
  const out = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${out.error}`);
  return out;
};

// The salt is the only thing that lets us reveal later, so it is written to disk before anything is sent.
mkdirSync('data', { recursive: true });
const SALT_FILE = `data/supplier-${rfqId}-${me.address}.json`;
const salt = existsSync(SALT_FILE) ? JSON.parse(readFileSync(SALT_FILE, 'utf8')).salt : `0x${randomBytes(32).toString('hex')}`;
writeFileSync(SALT_FILE, JSON.stringify({ salt }));

let rfq = await api(`/api/rfqs/${rfqId}`);
if (rfq.phase === 'commit') {
  const hash = commitHash(doc, salt, me.address, rfq.chainId ?? 0);
  const bondTx = rfq.chainId ? await escrowCommit(pk, rfq.chainId, hash, rfq.bondPie) : undefined;
  const signature = rfq.chainId ? undefined : await me.signMessage({ message: commitMessage(rfqId, hash) });
  const { label } = await api(`/api/rfqs/${rfqId}/commit`, { method: 'POST', body: { supplier: me.address, hash, signature, bondTx } });
  console.log(`committed as ${label}; waiting for the buyer to close commits`);
}
while ((rfq = await api(`/api/rfqs/${rfqId}`)).phase === 'commit') await new Promise((r) => setTimeout(r, 5000));
if (rfq.phase !== 'reveal') throw new Error(`tender moved to ${rfq.phase} before we revealed`);
const revealTx = rfq.chainId ? await escrowReveal(pk, rfq.chainId, docHashOf(doc), salt) : undefined;
console.log(await api(`/api/rfqs/${rfqId}/reveal`, { method: 'POST', body: { supplier: me.address, doc, salt, revealTx } }));
