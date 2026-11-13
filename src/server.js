import { createServer } from 'node:http';
import { listRfqs, getRfq, approve, buyerAddress, createRfq, submitCommit, closeCommits, reveal, evaluate, settle, bidOf, publicView, appeal, decideAppeal, bondQuote } from './lelang.js';
import { toOcds } from './ocds.js';
import { deployment, kiteEnabled, balances } from './kite.js';
import { serveStatic } from './static.js';
import { allRequirements, collect, refund, paymentRequired } from './x402.js';
import { randomBytes, createHash } from 'node:crypto';
import { runDemo, DEMO_RFQ } from './demo.js';
import { judge, record as recordChallenge, list as challengeList } from './challenge.js';

const CHALLENGE_FEE = Number(process.env.CHALLENGE_FEE ?? 0.05);
const challengesInFlight = new Set();

let running = null;
// Tender fee in PYUSD over x402: a base for the tender (rationale, Reppo audit) plus a price per bid slot (each bid costs
// a Prompt Guard pass, a manipulation check, two readers and an ambiguity check). The payer picks maxBids (1-20) and the
// tender takes no more bids than it paid for. TENDER_FEE_BASE=0 turns paid tenders off (then only DEMO_TOKEN opens tenders).
const FEE_BASE = Number(process.env.TENDER_FEE_BASE ?? 0.2);
const FEE_PER_BID = Number(process.env.TENDER_FEE_PER_BID ?? 0.06);
const MAX_OPEN_PAID = 5, MAX_OPEN_PER_PAYER = 2;
const pendingPaid = new Map(); // paid opens in flight: slot -> { payer (claimed), ip }
const OPEN_TTL = 6 * 3600_000; // an open paid tender older than this no longer counts against the caps
let bondLookups = 0; // fresh /bond lookups in flight (each scans the chain)
export const tenderFee = (maxBids) => +(FEE_BASE + FEE_PER_BID * maxBids).toFixed(6);
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
  // public reads are open to any origin (the static dashboard shows what runs here); actions need a token or payment
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
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
    // Break Lelang: a public, paid red team (src/challenge.js). Reading the results is free; an attempt costs a small
    // x402 fee, which pays for the five model calls it triggers. One attempt in flight per client, two overall.
    if (url.pathname === '/api/challenge' && req.method === 'GET') return json(res, 200, challengeList());
    const bq = url.pathname.match(/^\/api\/rfqs\/([\w-]+)\/bond$/);
    if (bq && req.method === 'GET') {
      // each fresh quote scans the chain's logs: bound how many run at once (cached answers are free)
      if (bondLookups >= 4) return json(res, 429, { error: 'too many bond lookups right now; retry in a few seconds' });
      bondLookups += 1;
      try { return json(res, 200, await bondQuote(bq[1], url.searchParams.get('supplier'))); } finally { bondLookups -= 1; }
    }
    // Actions spend credits or move testnet money, so a public deploy gates them with DEMO_TOKEN.
    // Fail closed: without DEMO_TOKEN only a caller on this machine is the operator (local `npm start`); an unset
    // variable on a public deploy must not hand the buyer wallet to anyone.
    // A tunnel or reverse proxy also connects from 127.0.0.1, so a direct local request must also name localhost and
    // carry no forwarding headers; a public deploy should set DEMO_TOKEN anyway.
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? '') && !Object.keys(req.headers).some((h) => h.startsWith('x-forwarded') || h === 'forwarded');
    // ...and, without a token, a page on another site in the operator's browser must not drive it (CSRF).
    const sameOrigin = !req.headers.origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.origin);
    const authorized = process.env.DEMO_TOKEN ? url.searchParams.get('token') === process.env.DEMO_TOKEN : loopback && sameOrigin;
    if (url.pathname === '/api/challenge' && req.method === 'POST') {
      const { attack } = await body(req);
      if (typeof attack !== 'string' || attack.trim().length < 10 || attack.length > 600) bad('attack: the paragraph you append to the bid, 10-600 characters');
      const ip = req.socket.remoteAddress;
      if (challengesInFlight.size >= 2 || challengesInFlight.has(ip)) return json(res, 429, { error: 'another attempt is being judged; retry in a few seconds' });
      challengesInFlight.add(ip);
      try {
        let payer = 'operator', paymentTx = null;
        if (!authorized) {
          if (!kiteEnabled()) return json(res, 403, { error: 'challenges are off on this server' });
          const terms = allRequirements({ amount: CHALLENGE_FEE, payTo: buyerAddress(), resource: `${url.protocol}//${req.headers.host}/api/challenge`, description: `Break Lelang: have the evaluator judge your attack paragraph (${CHALLENGE_FEE})` });
          try {
            const p = await collect(req.headers['payment-signature'] ?? req.headers['x-payment'], terms);
            payer = p.payer; paymentTx = p.txUrl;
          } catch (e) {
            if (e.status !== 402) throw e;
            res.writeHead(402, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'payment-required': Buffer.from(JSON.stringify(e.paymentRequired)).toString('base64') });
            return res.end(JSON.stringify(e.paymentRequired));
          }
        }
        const verdict = await judge(attack);
        return json(res, 200, recordChallenge({ at: new Date().toISOString(), payer, paymentTx, attack, ...verdict }));
      } finally {
        challengesInFlight.delete(ip);
      }
    }
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
      if (paid && !(FEE_BASE > 0 && kiteEnabled())) return json(res, 403, { error: 'demo token required' });
      const b = await body(req);
      const allowed = ['title', 'budgetCapUsd', 'maxDeliveryDays', 'minSpecs', 'weights', 'minConfidence', 'bondPie', 'depositPie'];
      const spec = { ...DEMO_RFQ, ...Object.fromEntries(allowed.filter((k) => k in b).map((k) => [k, b[k]])) };
      // A paying stranger runs the tender through our buyer wallet, so it can't make that wallet pay a down payment.
      if (paid) {
        spec.depositPie = 0;
        spec.maxBids = b.maxBids ?? 5;
        if (!Number.isInteger(spec.maxBids) || spec.maxBids < 1 || spec.maxBids > 20) bad('maxBids must be an integer from 1 to 20');
      }
      if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200) bad('title required (max 200 chars)');
      for (const k of ['budgetCapUsd', 'maxDeliveryDays', 'bondPie', ...(paid ? [] : ['depositPie'])]) if (!(Number(spec[k]) > 0)) bad(`${k} must be > 0`);
      const w = spec.weights ?? {};
      if (Math.abs((w.price ?? 0) + (w.warranty ?? 0) + (w.delivery ?? 0) - 1) > 1e-6) bad('weights.price + warranty + delivery must sum to 1');
      // Validated before charging: a malformed request never costs the payer anything. Amounts must be plain decimals
      // (1e-7 passes `> 0` but can't be turned into token units, so the escrow call would fail after payment).
      for (const k of ['bondPie', 'depositPie']) if (!/^\d+(\.\d{1,6})?$/.test(String(spec[k])) || Number(spec[k]) > 100) bad(`${k} must be a plain decimal with at most 6 places, at most 100`);
      let payment, ownerToken, slot;
      try {
      if (paid) {
        // Testnet fees are free-mintable tokens, so the fee alone can't stop someone draining our gas and AI credits:
        // cap open paid tenders per payer and overall. Slots are counted and reserved with no await in between, so
        // parallel requests can't all slip under the caps. Only a request that carries a well-formed payment for our
        // terms takes a slot (a bare request gets its 402 straight away), at most one in flight per IP, and an open paid
        // tender stops counting after OPEN_TTL so abandoned ones don't block the cap forever.
        const terms = allRequirements({ amount: tenderFee(spec.maxBids), payTo: buyerAddress(), resource: `${url.protocol}//${req.headers.host}/api/rfqs`, description: `Lelang: open a sealed-bid tender for up to ${spec.maxBids} bids (${FEE_BASE} base + ${FEE_PER_BID} per bid: AI evaluation and the Reppo audit)` });
        const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
        let auth;
        try { auth = JSON.parse(Buffer.from(header ?? '', 'base64').toString()).payload.authorization; } catch {}
        const fits = auth && String(auth.to).toLowerCase() === buyerAddress().toLowerCase() && terms.some((t) => { try { return BigInt(auth.value) >= BigInt(t.amount); } catch { return false; } });
        if (!fits) {
          const pr = paymentRequired(terms, header ? 'payment does not match the requirements' : 'payment required');
          res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(pr)).toString('base64') });
          return res.end(JSON.stringify(pr));
        }
        const claimed = String(auth.from).toLowerCase(); // unverified here; a false `from` can't settle
        const ip = req.socket.remoteAddress;
        if ([...pendingPaid.values()].some((p) => p.ip === ip)) return json(res, 429, { error: 'one paid request at a time per client' });
        const payers = [...listRfqs().map((r) => getRfq(r.id)).filter((r) => r.paidBy && !['settled', 'held'].includes(r.phase) && Date.now() - Date.parse(r.createdAt) < OPEN_TTL).map((r) => r.paidBy.payer.toLowerCase()), ...[...pendingPaid.values()].map((p) => p.payer)];
        if (payers.length >= MAX_OPEN_PAID) return json(res, 429, { error: `${MAX_OPEN_PAID} paid tenders are already running; try again later` });
        if (claimed && payers.filter((p) => p === claimed).length >= MAX_OPEN_PER_PAYER) return json(res, 429, { error: `this payer already has ${MAX_OPEN_PER_PAYER} tenders running; nothing was charged` });
        slot = Symbol('paid tender');
        pendingPaid.set(slot, { payer: claimed, ip });
        if (Number((await balances(buyerAddress())).kite) < 0.01) return json(res, 503, { error: 'operator is out of gas; not taking payments right now' });
        try {
          payment = await collect(header, terms);
        } catch (e) {
          if (e.status !== 402) throw e;
          res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(e.paymentRequired)).toString('base64') });
          return res.end(JSON.stringify(e.paymentRequired));
        }
        ownerToken = randomBytes(24).toString('hex'); // lets the payer close and evaluate this tender; only its hash is stored
        spec.paidBy = { payer: payment.payer, fee: payment.amount, asset: payment.asset, network: payment.network, tx: payment.tx, txUrl: payment.txUrl, settledBy: payment.settledBy, ownerTokenHash: tokenHash(ownerToken) };
        res.setHeader('payment-response', payment.receipt);
      }
      let rfq;
      try {
        rfq = await createRfq(spec);
      } catch (e) {
        if (!payment) throw e;
        // paid but nothing opened: give the money back rather than asking the payer to pay again
        const back = await refund(payment).catch((err) => `refund failed, contact the operator with the payment tx: ${err.shortMessage ?? err.message}`);
        return json(res, 502, { error: `tender could not be opened (${e.shortMessage ?? e.message}); payment returned`, payment: { tx: payment.txUrl }, refund: back });
      }
      return json(res, 201, { id: rfq.id, chainId: rfq.chainId ?? null, escrow: rfq.escrow ?? null, bond: rfq.bondPie, phase: rfq.phase, ...(paid && { ownerToken, payment: { payer: payment.payer, tx: payment.tx, network: payment.network } }) });
      } finally {
        pendingPaid.delete(slot); // the tender now counts itself (or nothing was opened)
      }
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

// Lelang Bid Integrity Check on the OpenServ x402 Agent Market (opt-in; dependencies live in openserv/)
// The server is the agent's one home, so it takes over a stale tunnel and retries if the platform refuses at first.
if (process.env.OPENSERV_AGENT === '1') {
  process.env.FORCE_TUNNEL ??= 'true';
  const start = (attempt = 1) => import('../openserv/agent.js').then((m) => m.startOpenServAgent()).catch((e) => {
    console.error(`OpenServ agent failed to start (attempt ${attempt}): ${e.message}`);
    if (attempt < 10) setTimeout(() => start(attempt + 1), 60_000);
  });
  start();
}
