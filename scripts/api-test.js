// Offline check of the external-agent protocol over real HTTP: a separate server process, independent supplier
// agent processes holding only their own keys. No chain, no SERV/Reppo calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { commitHash, commitMessage } from '../src/lelang.js';

const PORT = 3911;
const URL_ = `http://localhost:${PORT}`;
const env = { ...process.env, PORT: String(PORT), LELANG_STATE: 'data/apitest.json', DEMO_TOKEN: 't' };
delete env.BUYER_PRIVATE_KEY; // offline: no chain
rmSync('data/apitest.json', { force: true });
mkdirSync('data/apitest', { recursive: true });

const server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Lelang on') && r()));
const call = async (path, method = 'GET', body) => {
  const res = await fetch(URL_ + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

let testRfq = null;
try {
  // buyer side is token-gated and validated
  assert.equal((await call('/api/rfqs', 'POST', { title: 'x' })).status, 403);
  assert.equal((await call('/api/rfqs?token=t', 'POST', { weights: { price: 1, warranty: 1, delivery: 0 } })).status, 400);
  // amounts that pass `> 0` but can't become token units are refused before anything is charged or opened
  assert.equal((await call('/api/rfqs?token=t', 'POST', { title: 'x', bondPie: 1e-7 })).status, 400);
  const open = await call('/api/rfqs?token=t', 'POST', { title: 'API test tender' });
  assert.equal(open.status, 201);
  const id = open.body.id;
  testRfq = id;

  // two independent supplier agents commit through the public API, then wait for the close
  const keys = [generatePrivateKey(), generatePrivateKey()];
  const agents = keys.map((k, i) => {
    const file = `data/apitest/bid${i}.txt`;
    writeFileSync(file, `BID SUBMISSION - Vendor ${i}\nTotal: $${80000 + i * 1000}, delivery 20 days, warranty 24 months.`);
    const p = spawn(process.execPath, ['scripts/supplier-agent.js', URL_, id, file], { env: { ...env, SUPPLIER_PRIVATE_KEY: k }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    return new Promise((resolve, reject) => p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`agent ${i} exited ${code}`)))));
  });
  while (Object.keys((await call(`/api/rfqs/${id}`)).body.bids).length < 2) await new Promise((r) => setTimeout(r, 200));

  // a forged commit (signature from another key) and a duplicate commit are refused
  const a0 = privateKeyToAccount(keys[0]);
  const intruder = privateKeyToAccount(generatePrivateKey());
  const h = commitHash('forged', `0x${'11'.repeat(32)}`, intruder.address);
  const forged = await call(`/api/rfqs/${id}/commit`, 'POST', { supplier: intruder.address, hash: h, signature: await a0.signMessage({ message: commitMessage(id, h) }) });
  assert.equal(forged.status, 400);
  const dup = await call(`/api/rfqs/${id}/commit`, 'POST', { supplier: a0.address, hash: h, signature: await a0.signMessage({ message: commitMessage(id, h) }) });
  assert.match(dup.body.error, /already committed/);

  // a stranger can't reveal before the close, the close needs the token, then agents reveal on their own
  assert.equal((await call(`/api/rfqs/${id}/close`, 'POST')).status, 403);
  assert.equal((await call(`/api/rfqs/${id}/close?token=t`, 'POST')).status, 200);
  assert.equal((await call(`/api/rfqs/${id}/close?token=t`, 'POST')).status, 400); // only once
  const outs = await Promise.all(agents);
  outs.forEach((o) => assert.match(o, /matches: true/));

  // late commit, junk reveal over a valid one, oversize body
  assert.equal((await call(`/api/rfqs/${id}/commit`, 'POST', { supplier: intruder.address, hash: h, signature: '0x' })).status, 400);
  const junk = await call(`/api/rfqs/${id}/reveal`, 'POST', { supplier: a0.address, doc: 'junk', salt: `0x${randomBytes(32).toString('hex')}` });
  assert.match(junk.body.error, /already revealed/);
  assert.equal((await call(`/api/rfqs/${id}/reveal`, 'POST', { supplier: a0.address, doc: 'x'.repeat(70_000), salt: `0x${'00'.repeat(32)}` })).status, 413);
  assert.equal((await call(`/api/rfqs/${id}/evaluate`, 'POST')).status, 403);

  const final = (await call(`/api/rfqs/${id}`)).body;
  assert.equal(final.phase, 'reveal');
  assert.ok(Object.values(final.bids).every((b) => b.revealOk));
  console.log('api-test OK: 2 external agents committed and revealed; forged, duplicate, late, junk and oversize requests refused');
} finally {
  server.kill();
  rmSync('data/apitest', { recursive: true, force: true });
  rmSync('data/apitest.json', { force: true });
  // only this test's salt files: a real agent's salt is the only way it can reveal, deleting it strands its bond
  if (testRfq) for (const f of readdirSync('data')) if (f.startsWith(`supplier-${testRfq}-`)) rmSync(`data/${f}`);
}
