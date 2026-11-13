// What a tender really costs: runs the real evaluation (SERV, Dolphin, Reppo) off-chain on 1 bid and on N bids, reads
// the token usage the providers report, and splits it into a per-tender base and a per-bid cost. Used to price the
// x402 tender fee (src/server.js). Costs a few cents of SERV, some Dolphin credit and 2+ Reppo evaluations.
//   node --env-file=.env scripts/cost-per-bid.js [--bids 5]
import { writeFileSync, rmSync } from 'node:fs';

process.env.LELANG_STATE = 'data/cost-per-bid-state.json';
delete process.env.BUYER_PRIVATE_KEY; // off-chain: same AI work, no testnet money moves
const N = Number(process.argv[process.argv.indexOf('--bids') + 1]) || 5;
const { usage } = await import('../src/ai.js');
const { createRfq, submitCommit, reveal, evaluate, commitHash, commitMessage, getRfq } = await import('../src/lelang.js');
const { DEMO_RFQ, DEMO_BIDS } = await import('../src/demo.js');
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
const { randomBytes } = await import('node:crypto');

// SERV prices from its /v1/models (USD cents per million tokens); Reppo: 440 credits per evaluation, $1 = 2,000 credits.
const prices = Object.fromEntries((await (await fetch('https://inference-api.openserv.ai/v1/models', { headers: { authorization: `Bearer ${process.env.SERV_API_KEY}` } })).json())
  .items.map((m) => [m.modelId, m.pricing]));
const REPPO_USD = 0.22;

async function run(n) {
  for (const k of Object.keys(usage)) delete usage[k];
  const rfq = await createRfq({ ...DEMO_RFQ, title: `cost probe, ${n} bid(s)` });
  const docs = Array.from({ length: n }, (_, i) => DEMO_BIDS[i % DEMO_BIDS.length]);
  const bidders = docs.map((doc) => ({ doc, acct: privateKeyToAccount(generatePrivateKey()), salt: `0x${randomBytes(32).toString('hex')}` }));
  for (const b of bidders) {
    const hash = commitHash(b.doc, b.salt, b.acct.address);
    b.label = await submitCommit(rfq.id, { supplier: b.acct.address, hash, signature: await b.acct.signMessage({ message: commitMessage(rfq.id, hash) }) });
  }
  getRfq(rfq.id).phase = 'reveal';
  for (const b of bidders) await reveal(rfq.id, b.label, { doc: b.doc, salt: b.salt });
  await evaluate(rfq.id);
  const r = getRfq(rfq.id);
  const reppo = (r.reppo?.rounds?.length ?? 0);
  const models = structuredClone(usage);
  let serv = 0;
  for (const [model, u] of Object.entries(models)) {
    const p = prices[model];
    u.usd = p ? +((u.input * p.input + u.output * p.output) / 100 / 1e6).toFixed(5) : null; // cents per M -> USD
    if (p) serv += u.usd;
  }
  return { bids: n, models, servUsd: +serv.toFixed(5), reppoRounds: reppo, reppoUsd: +(reppo * REPPO_USD).toFixed(2), decision: r.award?.decision };
}

const one = await run(1);
const many = await run(N);
const tokens = (r, m) => (r.models[m]?.input ?? 0) + (r.models[m]?.output ?? 0);
const dolphin = 'deepseek-ai/DeepSeek-V4.1-Flash';
const perBid = {
  servUsd: +((many.servUsd - one.servUsd) / (N - 1)).toFixed(5),
  servCalls: +(((Object.entries(many.models).filter(([m]) => prices[m]).reduce((x, [, u]) => x + u.calls, 0)) - Object.entries(one.models).filter(([m]) => prices[m]).reduce((x, [, u]) => x + u.calls, 0)) / (N - 1)).toFixed(1),
  dolphinTokens: Math.round((tokens(many, dolphin) - tokens(one, dolphin)) / (N - 1)),
};
const base = { servUsd: +(one.servUsd - perBid.servUsd).toFixed(5), reppoUsd: one.reppoUsd, reppoRounds: one.reppoRounds };
const out = { ranAt: new Date().toISOString(), note: 'Dolphin publishes no per-token price through its API, so its cost is reported in tokens.', runs: [one, many], perBid, base };
writeFileSync('docs/reports/cost-per-bid.json', JSON.stringify(out, null, 2));
rmSync(process.env.LELANG_STATE, { force: true });
console.log(JSON.stringify({ perBid, base, oneBid: { servUsd: one.servUsd, reppo: one.reppoRounds }, [`${N}Bids`]: { servUsd: many.servUsd, reppo: many.reppoRounds } }, null, 2));
