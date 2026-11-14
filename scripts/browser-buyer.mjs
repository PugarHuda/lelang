// A human buyer in a real browser: opens buy.html, imports an OCDS release, pays the x402 tender fee by signing with a
// browser wallet, and gets an owner token back. The wallet is a stand-in that signs with the x402-buyer-agent key
// (in Node), exactly the EIP-712 payload a MetaMask user would be shown. The tender really opens in the escrow on Kite.
//   node --env-file=.env scripts/browser-buyer.mjs          (local server)
//   LIVE=1 node --env-file=.env scripts/browser-buyer.mjs   (the hosted page on Vercel paying the public API on Render)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';

const LIVE = process.env.LIVE === '1';
const PORT = 3300, BASE = `http://localhost:${PORT}`;
const PAGE = LIVE ? 'https://lelang-ten.vercel.app/buy.html' : `${BASE}/buy.html?api=${encodeURIComponent(BASE)}`;
const keys = JSON.parse(readFileSync('data/agents/keys.json', 'utf8'));
const account = privateKeyToAccount(keys['x402-buyer-agent']);
const server = LIVE ? { kill() {} } : spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DEMO_TOKEN: `browser-${Date.now()}` }, stdio: ['ignore', 'pipe', 'inherit'] });
if (!LIVE) {
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Lelang on') && r()));
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' }); // any installed Chromium-based browser
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  await page.exposeFunction('__sign', async (json) => {
    const { domain, types, primaryType, message } = JSON.parse(json);
    const { EIP712Domain, ...rest } = types; // viem derives the domain type itself
    console.log(`[wallet] user is asked to sign ${primaryType}: ${message.value} units to ${message.to}`);
    return account.signTypedData({ domain, types: rest, primaryType, message: { ...message, value: BigInt(message.value), validAfter: BigInt(message.validAfter), validBefore: BigInt(message.validBefore) } });
  });
  await page.addInitScript((address) => {
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'eth_signTypedData_v4') return window.__sign(params[1]);
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
    };
  }, account.address);
  await page.goto(PAGE);

  // Start from an OCDS release package (Lelang's own export, validated against the official OCDS 1.1.5 schema)
  const ocds = JSON.parse(readFileSync('public/ocds.json', 'utf8'));
  ocds.releases[0].tender.title = 'Classroom laptops (imported from an OCDS release)';
  ocds.releases[0].tender.contractPeriod = { durationInDays: 45 };
  await page.fill('#ocds', JSON.stringify(ocds));
  await page.click('#import');
  console.log(`[page] import: ${await page.textContent('#importNote')}`);
  await page.fill('#bids', '2');
  await page.click('#open');
  await page.waitForSelector('#status.ok, #status.bad', { timeout: 240_000 });
  console.log(`[page] status: ${await page.textContent('#status')}`);
  if (!(await page.$('#status.ok'))) process.exitCode = 1;
  await page.waitForFunction(() => /Phase/.test(document.querySelector('[data-phase]')?.textContent ?? ''), null, { timeout: 60_000 }).catch(() => {});
  console.log(`[page] your tenders: ${(await page.textContent('#mine')).replace(/\s+/g, ' ').slice(0, 300)}`);
} finally {
  await browser.close();
  server.kill();
}
