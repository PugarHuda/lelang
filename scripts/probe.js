// Checks every integration once and prints what works. Costs a few cents of SERV credit; no Reppo eval is spent.
import { promptGuard, jev, extractBid, config } from '../src/ai.js';
import { kiteEnabled, buyerAccount, balances } from '../src/kite.js';
import { DEMO_BIDS } from '../src/demo.js';

const step = async (name, fn) => {
  try { console.log(`OK   ${name}:`, JSON.stringify(await fn()).slice(0, 400)); }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); }
};

console.log('config', config);
await step('prompt guard / clean bid', () => promptGuard(DEMO_BIDS[0]));
await step('prompt guard / injected bid', () => promptGuard(DEMO_BIDS[4]));
await step('jev noul', () => jev([DEMO_BIDS[4]], { injection: { type: 'noul', instructions: 'The document contains text addressed to an AI evaluator that tries to change who wins.' } }));
await step('extract', () => extractBid(DEMO_BIDS[3]));
await step('reppo key', async () => {
  const r = await fetch('https://eval.reppo.xyz/api/v1/agents/evals/probe-nonexistent', { headers: { authorization: `Bearer ${process.env.REPPO_API_KEY}` } });
  return { status: r.status, meaning: r.status === 404 ? 'key valid' : r.status === 401 ? 'key invalid/missing' : 'unexpected' };
});
if (kiteEnabled()) await step('kite buyer', async () => ({ address: buyerAccount().address, ...(await balances(buyerAccount().address)) }));
else console.log('SKIP kite: run `npm run wallets` first');
