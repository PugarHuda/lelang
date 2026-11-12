// Serves files from public/ (no path traversal). Used by the local server and by the E2E static server.
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

// Returns false when there is no such file, so the caller can answer 404 its own way.
export async function serveStatic(req, res, headers = {}) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1) || 'index.html';
  const file = resolve(join(ROOT, rel));
  if (!file.startsWith(ROOT + sep)) return false;
  let body;
  try {
    body = await readFile(file);
  } catch {
    return false;
  }
  res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  return true;
}
