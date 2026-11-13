import { createServer } from 'node:http';
import { listRfqs, getRfq, approve, buyerAddress, createRfq, submitCommit, closeCommits, reveal, evaluate, settle, bidOf, publicView, appeal, decideAppeal, bondQuote } from './lelang.js';
import { toOcds } from './ocds.js';
import { deployment, kiteEnabled } from './kite.js';
import { serveStatic } from './static.js';
import { requirements, collect } from './x402.js';
import { randomBytes, createHash } from 'node:crypto';
import { runDemo, DEMO_RFQ } from './demo.js';

let running = null;
// Tender fee in PYUSD over x402; 0 turns paid tenders off (then only DEMO_TOKEN opens tenders).
// ponytail: flat fee per tender; evaluation cost grows with bids (up to the escrow's 100), so a per-bid fee or a bid cap
// for paid tenders is the upgrade once strangers open large tenders.
const TENDER_FEE = Number(process.env.TENDER_FEE ?? 0.5);
const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');

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
      return rfq ? json(res, 200, publicView(rfq)) : json(res, 404, { error: 'not found' });
    }
    const bq = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/bond$/);
    if (bq && req.method === 'GET') return json(res, 200, await bondQuote(bq[1], url.searchParams.get('supplier')));
    // Actions spend credits or move testnet money, so a public deploy gates them with DEMO_TOKEN.
    const authorized = !process.env.DEMO_TOKEN || url.searchParams.get('token') === process.env.DEMO_TOKEN;
    const a = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/approve$/);
    if (a && req.method === 'POST') {
      if (!authorized) return json(res, 403, { error: 'demo token required' });
      const approver = url.searchParams.get('approver') ?? '';
      const signature = url.searchParams.get('signature') ?? '';
      const note = (url.searchParams.get('note') || '').slice(0, 200);
      const winner = url.searchParams.get('winner') || undefined;
      if (!ADDR.test(approver) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) bad('approver (address) and signature (65-byte hex) required');
      if (!getRfq(a[1])) return json(res, 404, { error: 'not found' });
      try {
        return json(res, 200, await approve(a[1], { approver, note, winner, signature }));
      } catch (e) {
        // Wrong state (already settled / settling) is the caller's conflict, not a server fault.
        if (/only held tenders|already|eligible bid/.test(e.message)) return json(res, 409, { error: e.message });
        throw e;
      }
    }
    // --- protocol for external agents --------------------------------------------------------------
    // Suppliers need no token: on-chain their own escrow transaction proves who they are; off-chain an
    // EIP-191 signature over the commitment does. Buyer actions (open, close, evaluate) need DEMO_TOKEN.
    // Opening a tender: with DEMO_TOKEN (our own runs), or by paying the tender fee over x402 (any agent, Kite Passport
    // agents included). The fee covers the SERV, Dolphin and Reppo calls the tender will make.
    if (url.pathname === '/api/rfqs' && req.method === 'POST') {
      const paid = !authorized;
      if (paid && !(TENDER_FEE > 0 && kiteEnabled())) return json(res, 403, { error: 'demo token required' });
      const b = await body(req);
      const allowed = ['title', 'budgetCapUsd', 'maxDeliveryDays', 'minSpecs', 'weights', 'minConfidence', 'bondPie', 'depositPie'];
      const spec = { ...DEMO_RFQ, ...Object.fromEntries(allowed.filter((k) => k in b).map((k) => [k, b[k]])) };
      // A paying stranger runs the tender through our buyer wallet, so it can't make that wallet pay a down payment.
      if (paid) spec.depositPie = 0;
      if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200) bad('title required (max 200 chars)');
      for (const k of ['budgetCapUsd', 'maxDeliveryDays', 'bondPie', ...(paid ? [] : ['depositPie'])]) if (!(Number(spec[k]) > 0)) bad(`${k} must be > 0`);
      const w = spec.weights ?? {};
      if (Math.abs((w.price ?? 0) + (w.warranty ?? 0) + (w.delivery ?? 0) - 1) > 1e-6) bad('weights.price + warranty + delivery must sum to 1');
      // Validated before charging: a malformed request never costs the payer anything.
      let payment, ownerToken;
      if (paid) {
        const terms = requirements({ amount: TENDER_FEE, payTo: buyerAddress(), resource: `${url.protocol}//${req.headers.host}/api/rfqs`, description: 'Lelang: open a sealed-bid tender (fee covers AI evaluation and the Reppo audit)' });
        try {
          payment = await collect(req.headers['payment-signature'] ?? req.headers['x-payment'], terms);
        } catch (e) {
          if (e.status !== 402) throw e;
          res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(e.paymentRequired)).toString('base64') });
          return res.end(JSON.stringify(e.paymentRequired));
        }
        ownerToken = randomBytes(24).toString('hex'); // lets the payer close and evaluate this tender; only its hash is stored
        spec.paidBy = { payer: payment.payer, fee: payment.amount, asset: 'PYUSD', tx: payment.tx, settledBy: payment.settledBy, ownerTokenHash: tokenHash(ownerToken) };
        res.setHeader('payment-response', payment.receipt);
      }
      const rfq = await createRfq(spec);
      return json(res, 201, { id: rfq.id, chainId: rfq.chainId ?? null, escrow: rfq.escrow ?? null, bond: rfq.bondPie, phase: rfq.phase, ...(paid && { ownerToken, payment: { payer: payment.payer, tx: payment.tx } }) });
    }
    // A slashed supplier appeals with its own signature: no token, one appeal per slashed bid.
    const ap = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/appeal$/);
    if (ap && req.method === 'POST') {
      if (!getRfq(ap[1])) return json(res, 404, { error: 'not found' });
      const { supplier, reason, signature } = await body(req);
      if (!ADDR.test(supplier ?? '') || !/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) bad('supplier (address) and signature (65-byte hex) required');
      return json(res, 200, await appeal(ap[1], { supplier, reason, signature }));
    }
    // A named approver decides an appeal the panel did not confirm (signed, APPROVERS only).
    const dc = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/appeal-decision$/);
    if (dc && req.method === 'POST') {
      if (!authorized) return json(res, 403, { error: 'demo token required' });
      if (!getRfq(dc[1])) return json(res, 404, { error: 'not found' });
      const { label, approver, signature, overturn } = await body(req);
      if (!ADDR.test(approver ?? '') || !/^0x[0-9a-fA-F]{130}$/.test(signature ?? '') || typeof overturn !== 'boolean') bad('label, approver, signature and overturn (boolean) required');
      return json(res, 200, await decideAppeal(dc[1], String(label), { approver, signature, overturn }));
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
        // Without the escrow, bonds are plain transfers we can't verify here, yet settle refunds every compliant bid
        // from the buyer's wallet. So money-moving tenders take public bids only through the escrow contract.
        if (!rfq.chainId && kiteEnabled()) bad('public bidding requires an escrow tender');
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
      const owner = rfq.paidBy && tokenHash(url.searchParams.get('token') ?? '') === rfq.paidBy.ownerTokenHash;
      if (!authorized && !owner) return json(res, 403, { error: 'demo token or this tender\'s owner token required' });
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
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && (await serveStatic(req, res))) return;
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 500, { error: e.message });
  }
}).listen(process.env.PORT || 3000, () => console.log(`Lelang on http://localhost:${process.env.PORT || 3000}`));
