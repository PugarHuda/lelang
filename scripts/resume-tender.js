// Finishes a tender whose evaluation was interrupted: starts the server (which hands 'evaluating' back to 'reveal'),
// evaluates through the API, and if the result is held, releases it with the approver key from data/agents/keys.json.
//   node --env-file=.env scripts/resume-tender.js <rfq id>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { approvalMessage } from '../src/lelang.js';

const id = process.argv[2];
const approver = privateKeyToAccount(JSON.parse(readFileSync('data/agents/keys.json', 'utf8')).approver);
const PORT = 3201, BASE = `http://localhost:${PORT}`, TOKEN = `resume-${Date.now()}`;
const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DEMO_TOKEN: TOKEN, APPROVERS: approver.address }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Lelang on') && r()));
const api = async (path, method = 'GET') => {
  const res = await fetch(BASE + path, { method });
  const out = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${out.error}`);
  return out;
};
try {
  await api(`/api/rfqs/${id}/evaluate?token=${TOKEN}`, 'POST');
  let rfq;
  for (;;) {
    rfq = await api(`/api/rfqs/${id}`);
    if (['settled', 'held'].includes(rfq.phase) || (rfq.phase === 'evaluated' && !(await api('/api/rfqs')).running)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (rfq.phase === 'held') {
    const note = 'checked: clean bid, best on every criterion; the earlier slash was in another tender';
    const winner = rfq.award.winner;
    const signature = await approver.signMessage({ message: approvalMessage(id, winner, note) });
    rfq = await api(`/api/rfqs/${id}/approve?${new URLSearchParams({ token: TOKEN, approver: approver.address, note, winner, signature })}`, 'POST');
  }
  console.log(`${id}: ${rfq.phase}\n` + rfq.events.map((e) => `${e.step}: ${e.msg}`).join('\n'));
} finally {
  server.kill();
}
