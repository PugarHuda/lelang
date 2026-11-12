import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { listRfqs, getRfq, approve, buyerAddress } from './lelang.js';
import { toOcds } from './ocds.js';
import { runDemo } from './demo.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url));
let running = null;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (url.pathname === '/api/rfqs') return json(res, 200, { running, rfqs: listRfqs().reverse() });
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
    json(res, 500, { error: e.message });
  }
}).listen(process.env.PORT || 3000, () => console.log(`Lelang on http://localhost:${process.env.PORT || 3000}`));
