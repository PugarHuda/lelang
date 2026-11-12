import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { listRfqs, getRfq, approve, buyerAddress, createRfq, submitCommit, closeCommits, reveal, evaluate, settle, bidOf } from './lelang.js';
import { toOcds } from './ocds.js';
import { deployment } from './kite.js';
import { runDemo, DEMO_RFQ } from './demo.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url));
let running = null;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const MAX_DOC = 20_000; // every revealed character is read by SERV, so bids stay small
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
const bad = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (url.pathname === '/deployment.json') return json(res, 200, deployment ?? {});
    if (url.pathname === '/api/rfqs' && req.method === 'GET') return json(res, 200, { running, rfqs: listRfqs().reverse() });
    const o = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/ocds$/);
    if (o) {
      const rfq = getRfq(o[1]);
      return rfq ? json(res, 200, toOcds(rfq, { buyer: buyerAddress() })) : json(res, 404, { error: 'not found' });
    }
    const m = url.pathname.match(/^\/api\/rfqs\/([\w-]+)$/);
    if (m) {
      const rfq = getRfq(m[1]);
      return rfq ? json(res, 200, rfq) : json(res, 404, { error: 'not found' });
    }
    // Actions spend credits or move testnet money, so a public deploy gates them with DEMO_TOKEN.
    const authorized = !process.env.DEMO_TOKEN || url.searchParams.get('token') === process.env.DEMO_TOKEN;
    const a = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/approve$/);
    if (a && req.method === 'POST') {
      if (!authorized) return json(res, 403, { error: 'demo token required' });
      const approver = (url.searchParams.get('approver') || 'human reviewer').slice(0, 60);
      const note = (url.searchParams.get('note') || '').slice(0, 200);
      if (!getRfq(a[1])) return json(res, 404, { error: 'not found' });
      try {
        return json(res, 200, await approve(a[1], { approver, note }));
      } catch (e) {
        // Wrong state (already settled / settling) is the caller's conflict, not a server fault.
        if (/only held tenders|already|eligible bid/.test(e.message)) return json(res, 409, { error: e.message });
        throw e;
      }
    }
    // --- protocol for external agents --------------------------------------------------------------
    // Suppliers need no token: on-chain their own escrow transaction proves who they are; off-chain an
    // EIP-191 signature over the commitment does. Buyer actions (open, close, evaluate) need DEMO_TOKEN.
    if (url.pathname === '/api/rfqs' && req.method === 'POST') {
      if (!authorized) return json(res, 403, { error: 'demo token required' });
      const b = await body(req);
      const allowed = ['title', 'budgetCapUsd', 'maxDeliveryDays', 'minSpecs', 'weights', 'minConfidence', 'bondPie', 'depositPie'];
      const spec = { ...DEMO_RFQ, ...Object.fromEntries(allowed.filter((k) => k in b).map((k) => [k, b[k]])) };
      if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200) bad('title required (max 200 chars)');
      for (const k of ['budgetCapUsd', 'maxDeliveryDays', 'bondPie', 'depositPie']) if (!(Number(spec[k]) > 0)) bad(`${k} must be > 0`);
      const w = spec.weights ?? {};
      if (Math.abs((w.price ?? 0) + (w.warranty ?? 0) + (w.delivery ?? 0) - 1) > 1e-6) bad('weights.price + warranty + delivery must sum to 1');
      const rfq = await createRfq(spec);
      return json(res, 201, { id: rfq.id, chainId: rfq.chainId ?? null, escrow: rfq.escrow ?? null, bond: rfq.bondPie, phase: rfq.phase });
    }
    const act = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/(commit|close|reveal|evaluate)$/);
    if (act && req.method === 'POST') {
      const [, id, action] = act;
      const rfq = getRfq(id);
      if (!rfq) return json(res, 404, { error: 'not found' });
      if (action === 'commit') {
        const { supplier, hash, signature, bondTx } = await body(req);
        if (!ADDR.test(supplier ?? '') || !HEX32.test(hash ?? '')) bad('supplier (address) and hash (bytes32) required');
        if (bondTx != null && !HEX32.test(bondTx)) bad('bondTx must be a tx hash');
        return json(res, 201, { label: await submitCommit(id, { supplier, hash, signature, bondTx }) });
      }
      if (action === 'reveal') {
        const { supplier, doc, salt, revealTx } = await body(req);
        if (typeof doc !== 'string' || !doc.trim() || doc.length > MAX_DOC) bad(`doc required (max ${MAX_DOC} chars)`);
        if (!HEX32.test(salt ?? '')) bad('salt (bytes32) required');
        if (revealTx != null && !HEX32.test(revealTx)) bad('revealTx must be a tx hash');
        const bid = bidOf(rfq, supplier ?? '');
        if (!bid) bad('no commit from this supplier');
        const ok = await reveal(id, bid.label, { doc, salt, revealTx });
        return json(res, ok ? 200 : 400, ok ? { label: bid.label, matches: true } : { error: 'document does not match the sealed commitment' });
      }
      if (!authorized) return json(res, 403, { error: 'demo token required' });
      if (action === 'close') {
        await closeCommits(id);
        return json(res, 200, { phase: getRfq(id).phase, bids: Object.keys(getRfq(id).bids).length });
      }
      // evaluate: SERV + Reppo take minutes, so it runs in the background; poll GET /api/rfqs/:id
      if (rfq.phase !== 'reveal') bad(`tender is in ${rfq.phase}, not reveal`);
      if (running) return json(res, 409, { error: 'another tender is being evaluated', id: running });
      running = id;
      evaluate(id).then(() => settle(id)).catch((e) => console.error(e)).finally(() => { running = null; });
      return json(res, 202, { id, phase: 'evaluating' });
    }
    if (url.pathname === '/api/demo' && req.method === 'POST') {
      if (!authorized) return json(res, 403, { error: 'demo token required' });
      if (running) return json(res, 409, { error: 'a demo is already running', id: running });
      const id = await new Promise((resolve, reject) => {
        runDemo(resolve).catch((e) => { console.error(e); reject(e); }).finally(() => { running = null; });
      });
      running = id;
      return json(res, 202, { id });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 500, { error: e.message });
  }
}).listen(process.env.PORT || 3000, () => console.log(`Lelang on http://localhost:${process.env.PORT || 3000}`));
