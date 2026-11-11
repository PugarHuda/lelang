import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { listRfqs, getRfq } from './lelang.js';
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
    const m = url.pathname.match(/^\/api\/rfqs\/([\w-]+)$/);
    if (m) {
      const rfq = getRfq(m[1]);
      return rfq ? json(res, 200, rfq) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/demo' && req.method === 'POST') {
      // Each run spends SERV + Reppo credits, so a public deploy is gated by DEMO_TOKEN.
      if (process.env.DEMO_TOKEN && url.searchParams.get('token') !== process.env.DEMO_TOKEN) return json(res, 403, { error: 'demo token required' });
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
