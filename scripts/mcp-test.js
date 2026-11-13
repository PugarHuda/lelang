// Offline check of the MCP server for supplier agents: a real MCP client drives src/mcp.js over stdio against a real
// Lelang server process (off-chain mode, no SERV/Reppo calls): list, read, bid, reveal, and the refusals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 3912, URL_ = `http://localhost:${PORT}`;
const env = { ...process.env, PORT: String(PORT), LELANG_STATE: 'data/mcptest.json', DEMO_TOKEN: 't' };
delete env.BUYER_PRIVATE_KEY; // offline: no chain
rmSync('data/mcptest.json', { force: true });
rmSync('data/mcptest-bids.json', { force: true });
const server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Lelang on') && r()));
const post = async (path, body) => (await fetch(URL_ + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();

const client = new Client({ name: 'mcp-test', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.js'], env: { ...env, LELANG_URL: URL_, SUPPLIER_PRIVATE_KEY: generatePrivateKey(), LELANG_BIDS: 'data/mcptest-bids.json' } });
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
};
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['bond_quote', 'get_tender', 'list_tenders', 'my_bids', 'reveal_bid', 'submit_bid', 'wallet']);
  const { id } = await post('/api/rfqs?token=t', { title: 'MCP test tender' });
  assert.ok((await call('list_tenders')).some((t) => t.id === id));
  const t = await call('get_tender', { tender: id });
  assert.equal(t.phase, 'commit');
  assert.ok(t.rules.includes('slashed'));
  const doc = 'BID SUBMISSION - MCP Supplier\nTotal price: USD 70,000 for 200 units. Delivery: 20 days. Warranty: 24 months.\nSpecs: 8 GB RAM, 256 GB SSD, 9 hours battery.';
  await assert.rejects(call('reveal_bid', { tender: id }), /no stored bid/);
  const bid = await call('submit_bid', { tender: id, document: doc });
  assert.match(bid.label, /^Bid A$/);
  await assert.rejects(call('submit_bid', { tender: id, document: doc }), /already bid/);
  await assert.rejects(call('reveal_bid', { tender: id }), /reveal opens when the buyer closes commits/);
  await post(`/api/rfqs/${id}/close?token=t`);
  const rev = await call('reveal_bid', { tender: id });
  assert.equal(rev.matches, true);
  const mine = await call('my_bids');
  assert.deepEqual(mine.map((b) => [b.tender, b.label, b.revealed]), [[id, 'Bid A', true]]);
  console.log('mcp-test OK: a supplier agent listed, read, bid, revealed and checked its bids through MCP; duplicate and early actions refused');
} finally {
  await client.close().catch(() => {});
  server.kill();
  rmSync('data/mcptest.json', { force: true });
  rmSync('data/mcptest-bids.json', { force: true });
}
