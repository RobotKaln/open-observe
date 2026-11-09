// `npm run mock`: serves dist/ and a mock of the read API (scripts/mock-api.ts) on one port, for development and screenshots.
// Needs a build first (`npm run build`). The token is printed at start; set MOCK_TOKEN, PORT or MOCK_DELAY_MS to change the defaults.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, MOCK_TOKEN } from './mock-api.ts';

const dist = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 8788);
const delay = Number(process.env.MOCK_DELAY_MS ?? 150);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function tokenOk(header: string | undefined): boolean | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return null;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(MOCK_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
    const ok = tokenOk(req.headers.authorization);
    if (ok === null) return json(401, { error: 'unauthorized' });
    if (!ok) return json(403, { error: 'forbidden' });
    await new Promise((r) => setTimeout(r, delay));
    const { status, body } = handle(url.pathname, url.searchParams);
    return json(status, body);
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = join(dist, rel);
  if (!file.startsWith(dist + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found (did you run `npm run build`?)');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`open-observe dashboard (mock API, made-up data): http://127.0.0.1:${port}/`);
  console.log(`Sign in with the token: ${MOCK_TOKEN}`);
});
