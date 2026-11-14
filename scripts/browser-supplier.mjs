// A human supplier in a real browser: opens bid.html, writes a bid, seals it (salt, commitment, approve + escrow commit
// from its own wallet), then reveals after the buyer closes commits. The wallet is a stand-in that sends each
// transaction with a supplier key from data/agents/keys.json (in Node), exactly the transactions a MetaMask user would
// be asked to confirm. The tender, bond and reveal are real, in the escrow on Kite testnet. No evaluation (AI credits).
//   node --env-file=.env scripts/browser-supplier.mjs
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { kiteTestnet, balances, transferPie, sendGas, explorerTx } from '../src/kite.js';

const PORT = 3301, BASE = `http://localhost:${PORT}`, DEMO = `browser-${Date.now()}`;
const SUPPLIER = process.env.SUPPLIER ?? 'Sinar Visual';
const keys = JSON.parse(readFileSync('data/agents/keys.json', 'utf8'));
const account = privateKeyToAccount(keys[SUPPLIER]);
// MIXED=1: the human in the browser competes with two supplier agents, and the tender is evaluated to settlement.
const MIXED = process.env.MIXED === '1';
const AGENT_BIDS = {
  'Nusantara Edu Supply': 'Total price: USD 7,200 for 10 projectors, delivered.\nDelivery: 22 days after award.\nWarranty: 24 months.',
  'Cahaya Media': 'Total price: USD 8,300 for 10 projectors, delivered and installed.\nDelivery: 12 days after award.\nWarranty: 24 months.',
};
const wallet = createWalletClient({ account, chain: kiteTestnet, transport: http() });

// Enough of the tender token for a 0.01 bond and some KITE for three transactions; top up from the buyer if short.
const bal = await balances(account.address);
const sym = Object.keys(bal).find((k) => k !== 'kite');
console.log(`[setup] ${SUPPLIER} ${account.address}: ${bal.kite} KITE, ${bal[sym]} ${sym}`);
if (Number(bal[sym]) < 0.01) console.log(`[setup] token top-up: ${explorerTx(await transferPie(process.env.BUYER_PRIVATE_KEY, account.address, 0.02))}`);
if (Number(bal.kite) < 0.005) console.log(`[setup] gas top-up: ${explorerTx(await sendGas(process.env.BUYER_PRIVATE_KEY, account.address, 0.02))}`);

const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DEMO_TOKEN: DEMO }, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
let browser;
try {
  await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Lelang on') && r()));
  const api = async (path, body) => {
    const res = await fetch(`${BASE}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DEMO}` }, body: JSON.stringify(body) } : undefined);
    const out = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${out.error}`);
    return out;
  };
  const rfq = await api('/api/rfqs', { title: MIXED ? '10 classroom projectors: a human supplier against two agents' : 'Browser supplier test: 10 classroom projectors', budgetCapUsd: 90000, maxDeliveryDays: 30, bondPie: '0.01', depositPie: 0.01, weights: { price: 0.5, warranty: 0.3, delivery: 0.2 }, minSpecs: {} });
  console.log(`[api] opened ${rfq.id} (escrow tender #${rfq.chainId})`);

  browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('download', (d) => console.log(`[page] receipt downloaded: ${d.suggestedFilename()}`));
  await page.exposeFunction('__send', async ({ to, data }) => {
    console.log(`[wallet] user confirms a transaction to ${to} (${data.slice(0, 10)})`);
    return wallet.sendTransaction({ to, data });
  });
  await page.exposeFunction('__sign', async (json) => {
    const { domain, types: { EIP712Domain, ...types }, primaryType, message } = JSON.parse(json);
    return account.signTypedData({ domain, types, primaryType, message });
  });
  await page.addInitScript((address) => {
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'eth_sendTransaction') return window.__send(params[0]);
        if (method === 'eth_signTypedData_v4') return window.__sign(params[1]);
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
    };
  }, account.address);
  await page.goto(`${BASE}/bid.html?api=${encodeURIComponent(BASE)}`);
  await page.waitForSelector(`#tender option[value="${rfq.id}"]`, { state: 'attached', timeout: 60_000 });
  console.log(`[page] open tenders: ${(await page.textContent('#tenders')).replace(/\s+/g, ' ').slice(0, 300)}`);
  await page.selectOption('#tender', rfq.id);
  await page.fill('#doc', MIXED
    ? 'Total price: USD 7,600 for all 10 projectors, delivered and installed.\nDelivery: 16 days after award.\nWarranty: 36 months on-site.'
    : 'Total price: USD 7,900 for all 10 projectors, delivered.\nDelivery: 14 days after award.\nWarranty: 36 months.\nAfter-sales: lamp replacement within 3 working days.');
  await page.click('#connect');
  await page.waitForFunction(() => /Bond to lock/.test(document.querySelector('#quote').textContent), null, { timeout: 60_000 });
  console.log(`[page] ${await page.textContent('#quote')}`);
  await page.click('#seal');
  await page.waitForSelector('#status.ok, #status.bad', { timeout: 240_000 });
  console.log(`[page] seal: ${await page.textContent('#status')}`);
  if (!(await page.$('#status.ok'))) throw new Error('seal failed');

  // MIXED=1: two supplier agents (separate processes, own keys) bid on the same tender as the human in the browser.
  const agents = MIXED ? Object.entries(AGENT_BIDS).map(([name, body]) => {
    const file = `data/agents/${rfq.id}-${name.replaceAll(' ', '_')}.txt`;
    writeFileSync(file, `BID SUBMISSION - ${name}\n\n${body}`);
    const p = spawn(process.execPath, ['scripts/supplier-agent.js', BASE, rfq.id, file], { env: { ...process.env, SUPPLIER_PRIVATE_KEY: keys[name] }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    return new Promise((r) => p.on('exit', r));
  }) : [];
  for (let i = 0; Object.keys((await api(`/api/rfqs/${rfq.id}`)).bids).length < 1 + agents.length; i++) {
    if (i > 100) throw new Error('agents did not commit');
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(`[api] close commits: ${JSON.stringify(await api(`/api/rfqs/${rfq.id}/close`, {}))}`);
  for (let i = 0; (await api(`/api/rfqs/${rfq.id}`)).phase !== 'reveal'; i++) {
    if (i > 60) throw new Error('tender never reached reveal');
    await new Promise((r) => setTimeout(r, 3000));
  }
  await page.click('[data-a="refresh"]');
  await page.click('[data-a="reveal"]', { timeout: 30_000 });
  await page.waitForFunction(() => { const s = document.querySelector('#status'); return /Revealed:/.test(s.textContent) || s.classList.contains('bad'); }, null, { timeout: 240_000 });
  console.log(`[page] reveal: ${await page.textContent('#status')}`);
  await page.waitForFunction(() => /matches the commitment/.test(document.querySelector('#mine').textContent), null, { timeout: 30_000 });
  console.log(`[page] your bids: ${(await page.textContent('#mine')).replace(/\s+/g, ' ').trim()}`);
  await browser.close();
  browser = null;

  const final = await api(`/api/rfqs/${rfq.id}`);
  const bid = Object.values(final.bids).find((b) => b.supplier.toLowerCase() === account.address.toLowerCase());
  console.log(`[api] ${bid.label}: revealOk=${bid.revealOk}, phase ${final.phase}`);
  console.log(`[api] bond tx:   ${explorerTx(bid.bondTx)}\n[api] reveal tx: ${explorerTx(bid.revealTx)}`);
  for (const e of final.events.filter((x) => x.data?.tx)) console.log(`[api] ${e.step}: ${e.data.tx}`);
  if (!bid.revealOk) throw new Error('bid not revealed as matching');
  console.log('PASS: a browser supplier sealed, locked its bond and revealed on Kite');
  if (MIXED) {
    await Promise.all(agents);
    console.log(`[api] evaluate: ${JSON.stringify(await api(`/api/rfqs/${rfq.id}/evaluate`, {}))}`);
    let r;
    for (let i = 0; !['settled', 'held', 'evaluated'].includes((r = await api(`/api/rfqs/${rfq.id}`)).phase) || (await api('/api/rfqs')).running; i++) {
      if (i > 120) throw new Error('evaluation did not finish');
      await new Promise((res) => setTimeout(res, 5000));
    }
    console.log(`\n${rfq.id}: ${r.phase}\n${r.events.map((e) => `${e.step}: ${e.msg}${e.data?.tx ? ` ${e.data.tx}` : ''}`).join('\n')}`);
  }
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
