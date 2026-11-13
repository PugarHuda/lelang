// A live tender on the hosted Lelang API with nobody holding an operator token: a buyer agent pays the tender fee over
// x402 (USDC on Arc, where Kite Passport pays), one supplier bids through the MCP server, another through the plain
// supplier script, each with its own key, bonds and reveals on Kite.
//   node --env-file=.env scripts/remote-tender.js [https://lelang-6k05.onrender.com]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fetchPaying } from '../src/x402.js';
import { balances, sendGas, transferPie } from '../src/kite.js';

const BASE = process.argv[2] || 'https://lelang-6k05.onrender.com';
const keys = JSON.parse(readFileSync('data/agents/keys.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => (await fetch(BASE + path)).json();
const TENDER = { title: '12 smart boards for 3 village schools', budgetCapUsd: 9000, maxDeliveryDays: 30, minSpecs: { ram_gb: 2, storage_gb: 16, battery_hours: 1 }, weights: { price: 0.5, warranty: 0.3, delivery: 0.2 }, maxBids: 2 };
const BIDS = {
  'Nusantara Edu Supply': 'BID SUBMISSION - Nusantara Edu Supply\nTotal price: USD 8,100 for 12 units, installed.\nDelivery: 18 days after award.\nWarranty: 24 months.\nSpecs per unit: 4 GB RAM, 32 GB storage, 2 hours battery backup.',
  'Sinar Visual': 'BID SUBMISSION - Sinar Visual\nTotal price: USD 8,700 for 12 units.\nDelivery: 10 days after award.\nWarranty: 36 months.\nSpecs per unit: 4 GB RAM, 64 GB storage, 3 hours battery backup.',
};

// testnet stand-in for "each supplier brings its own funds"
for (const name of Object.keys(BIDS)) {
  const a = privateKeyToAccount(keys[name]).address;
  const bal = await balances(a);
  if (Number(bal.kite) < 0.008) await sendGas(process.env.BUYER_PRIVATE_KEY, a, '0.01');
  const stable = Number(Object.entries(bal).find(([k]) => k !== 'kite')[1]);
  if (stable < 0.05) await transferPie(process.env.BUYER_PRIVATE_KEY, a, +(0.05 - stable).toFixed(6));
}

// 1. buyer agent pays on Arc and opens the tender
await get('/api/rfqs'); // wake a sleeping free instance
const payer = privateKeyToAccount(keys['x402-buyer-agent']);
const res = await fetchPaying(`${BASE}/api/rfqs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(TENDER) }, payer, 1, 'eip155:5042002');
const opened = await res.json();
if (res.status !== 201) throw new Error(`open failed: ${res.status} ${opened.error}`);
const { id, ownerToken } = opened;
console.log(`buyer ${payer.address} paid over x402 on Arc and opened ${id}: ${opened.payment.tx}`);

// 2. supplier A bids through MCP
const mcp = new Client({ name: 'remote-tender', version: '1.0.0' });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp.js'], env: { ...process.env, LELANG_URL: BASE, SUPPLIER_PRIVATE_KEY: keys['Nusantara Edu Supply'], LELANG_BIDS: 'data/remote-mcp-bids.json' } }));
const tool = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};
console.log('MCP bond_quote:', JSON.stringify(await tool('bond_quote', { tender: id })));
const bidA = await tool('submit_bid', { tender: id, document: BIDS['Nusantara Edu Supply'] });
console.log(`Nusantara (via MCP) committed as ${bidA.label}: ${bidA.bondTx}`);

// 3. supplier B with the plain script (it waits for the reveal phase on its own)
mkdirSync('data/agents', { recursive: true });
writeFileSync(`data/agents/${id}-Sinar_Visual.txt`, BIDS['Sinar Visual']);
const b = spawn(process.execPath, ['scripts/supplier-agent.js', BASE, id, `data/agents/${id}-Sinar_Visual.txt`], { env: { ...process.env, SUPPLIER_PRIVATE_KEY: keys['Sinar Visual'] }, stdio: ['ignore', 'inherit', 'inherit'] });
const bDone = new Promise((r) => b.on('exit', r));

// 4. buyer closes with its owner token once both are in, A reveals through MCP, buyer evaluates
while (Object.keys((await get(`/api/rfqs/${id}`)).bids).length < 2) await sleep(4000);
const close = await (await fetch(`${BASE}/api/rfqs/${id}/close?token=${ownerToken}`, { method: 'POST' })).json();
console.log('buyer closed commits:', JSON.stringify(close));
while ((await get(`/api/rfqs/${id}`)).phase !== 'reveal') await sleep(3000);
console.log('Nusantara (via MCP) reveal:', JSON.stringify(await tool('reveal_bid', { tender: id })));
await bDone;
const ev = await (await fetch(`${BASE}/api/rfqs/${id}/evaluate?token=${ownerToken}`, { method: 'POST' })).json();
console.log('buyer started evaluation:', JSON.stringify(ev));
let rfq;
for (;;) {
  rfq = await get(`/api/rfqs/${id}`);
  if (['settled', 'held', 'evaluated'].includes(rfq.phase)) break;
  await sleep(6000);
}
console.log(`\n${id}: ${rfq.phase}\n` + rfq.events.map((e) => `${e.step}: ${e.msg}`).join('\n'));
console.log('MCP my_bids:', JSON.stringify(await tool('my_bids', {})));
writeFileSync(`data/remote-${id}.json`, JSON.stringify(rfq, null, 2)); // the hosted state resets on restart; keep a copy
await mcp.close();
