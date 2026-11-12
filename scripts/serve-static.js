// Serves public/ like Vercel does: static, no API, and with the same security headers (CSP included) as vercel.json,
// so the E2E suite fails if the policy ever breaks the pages.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { serveStatic } from '../src/static.js';

const headers = Object.fromEntries(JSON.parse(readFileSync('vercel.json', 'utf8')).headers[0].headers.map((h) => [h.key, h.value]));
delete headers['Strict-Transport-Security']; // plain http locally
createServer(async (req, res) => {
  if (!(await serveStatic(req, res, headers))) res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
}).listen(Number(process.env.PORT) || 4173, () => console.log(`static on ${process.env.PORT || 4173}`));
