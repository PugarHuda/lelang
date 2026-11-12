// Serves public/ like Vercel does (static, no API), for the E2E suite.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1) || 'index.html';
  const file = resolve(join(ROOT, rel));
  if (!file.startsWith(resolve(ROOT) + sep)) return res.writeHead(400).end(); // no path traversal out of public/
  let body;
  try {
    body = await readFile(file);
  } catch {
    return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
}).listen(Number(process.env.PORT) || 4173, () => console.log(`static on ${process.env.PORT || 4173}`));
