// Telemetry ingest: public, no sign-in, mounted at /observe (not under /api).
//   POST /observe/<projectId>/v1/{metrics,logs,traces}  OTLP/JSON from expo-observe and the web adapter: stored, then
//                                                       forwarded unchanged to Expo Observe (FORWARD_TO_EXPO=1)
//   POST /observe/<projectId>/web                       web diagnostics (vitals, navigation, errors): stored only
// Collecting is best effort: whatever goes wrong while parsing or storing is logged and never changes the answer.
import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { allowedOrigins, forwardEnabled, isProject, pepperUsable } from '../lib/config';
import { sha256Hex } from '../lib/crypto';
import { withFingerprints } from '../lib/fingerprint';
import { parseLogs, parseMetrics, parseSpans } from '../lib/otlp';
import { countRequest, RATE_LIMIT_PER_WINDOW, RATE_WINDOW_MS, reserveBytes, storeBatch } from '../lib/store';
import type { ParsedBatch } from '../lib/types';
import { InvalidWebBatch, parseWeb } from '../lib/web';

export const MAX_BODY_BYTES = 512 * 1024;
const FORWARD_TIMEOUT_MS = 5000;
const KINDS = new Set(['metrics', 'logs', 'traces']);

/** Marks a batch that the app's JavaScript repeats from the native module: stored, not forwarded. */
export const MIRROR_HEADER = 'X-Open-Observe-Mirror';

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });

// The body, or a 413 as soon as it is known to be over the limit (a declared length, or while reading).
async function readLimited(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// Shared checks, in order: project id (404), configuration (503), request rate per client address (429), JSON content
// type (415), size (413), daily bytes per client address and per project (429, nothing stored). Returns the body, or the
// response that refuses it.
async function intake(req: Request, env: Env, projectId: string, now: number): Promise<Uint8Array | Response> {
  if (!isProject(env, projectId)) return json({ error: 'not_found' }, 404);
  // Without a usable PEPPER nothing could be stored (or hashed for the rate limit): say so instead of dropping data quietly.
  if (!pepperUsable(env)) {
    console.error('PEPPER is missing or shorter than 16 characters: ingest is switched off');
    return json({ error: 'misconfigured' }, 503);
  }
  // The address only feeds an HMAC that expires with the minute; it is never stored or logged.
  try {
    const address = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    if ((await countRequest(env.DB, env.PEPPER, address, now)) > RATE_LIMIT_PER_WINDOW) {
      const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now % RATE_WINDOW_MS)) / 1000));
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) });
    }
  } catch (e) {
    // A broken counter must not stop telemetry (or the answer the phone is waiting for).
    console.error('rate limit failed', e);
  }
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get('Content-Type') ?? '')) {
    return json({ error: 'unsupported_media_type' }, 415);
  }
  const body = await readLimited(req);
  if (!body) return json({ error: 'too_large' }, 413);
  // The bytes only feed a counter keyed by an HMAC of the address and the day, which is never stored or logged either.
  try {
    const address = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const retryAfter = await reserveBytes(env.DB, env.PEPPER, address, projectId, body.byteLength, now);
    if (retryAfter !== null) return json({ error: 'daily_limit' }, 429, { 'Retry-After': String(retryAfter) });
  } catch (e) {
    console.error('byte budget failed', e);
  }
  return body;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

async function parseOtlp(kind: string, bytes: Uint8Array): Promise<ParsedBatch> {
  const body = parseJson(bytes);
  const parsed: ParsedBatch = { metrics: [], logs: [], spans: [] };
  if (kind === 'metrics') parsed.metrics = parseMetrics(body);
  else if (kind === 'logs') parsed.logs = await withFingerprints(parseLogs(body));
  else parsed.spans = parseSpans(body);
  return parsed;
}

// Expo's answer goes back to the phone as it is (status, body, Retry-After), so it retries and gives up exactly as
// it would talking to Expo directly. No answer within 5 s, or no connection: 503, which also means "try again".
async function forward(projectId: string, kind: string, bytes: Uint8Array): Promise<Response> {
  try {
    const upstream = await fetch(`https://o.expo.dev/${projectId}/v1/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bytes,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    const body = noBody ? null : await upstream.arrayBuffer();
    const headers = new Headers({ 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' });
    const retryAfter = upstream.headers.get('Retry-After');
    if (retryAfter) headers.set('Retry-After', retryAfter);
    return new Response(body, { status: upstream.status, headers });
  } catch (e) {
    console.error('forward failed', e instanceof Error ? e.name : 'error');
    return json({ error: 'upstream_unavailable' }, 503);
  }
}

// CORS for browsers on another origin (ALLOWED_ORIGINS, exact origins, never a wildcard). The answer to a request from
// any other origin carries no CORS headers, so the browser keeps it from the page.
function corsHeaders(env: Env, origin: string | undefined, preflight: boolean): Record<string, string> {
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    ...(preflight
      ? { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': `Content-Type, ${MIRROR_HEADER}`, 'Access-Control-Max-Age': '86400' }
      : {}),
  };
}

export const observe = new Hono<AppEnv>()
  .use(async (c, next) => {
    await next();
    // Only for projects this Worker knows: the answer for any other id says nothing, not even CORS.
    if (!isProject(c.env, c.req.path.split('/')[2] ?? '')) return;
    const cors = corsHeaders(c.env, c.req.header('Origin'), false);
    if (Object.keys(cors).length === 0) return;
    const res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(cors)) res.headers.set(name, value);
    c.res = res;
  })

  .options('/:projectId/*', (c) => {
    if (!isProject(c.env, c.req.param('projectId'))) return json({ error: 'not_found' }, 404);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...corsHeaders(c.env, c.req.header('Origin'), true) } });
  })

  .post('/:projectId/v1/:kind', async (c) => {
    const kind = c.req.param('kind');
    const projectId = c.req.param('projectId');
    if (!KINDS.has(kind)) return json({ error: 'not_found' }, 404);
    const now = Date.now();
    const bytes = await intake(c.req.raw, c.env, projectId, now);
    if (bytes instanceof Response) return bytes;

    try {
      const id = await sha256Hex(`${kind}:${new TextDecoder().decode(bytes)}`);
      const parsed = await parseOtlp(kind, bytes);
      // A retry of a stored batch is not stored again, but still forwarded: Expo may not have received it.
      await storeBatch(c.env, { id, kind, bytes: bytes.byteLength, parsed }, now);
    } catch (e) {
      console.error('store failed', e);
    }

    // A JavaScript mirror repeats what the native module already sent to Expo: stored, not forwarded.
    if (forwardEnabled(c.env) && c.req.header(MIRROR_HEADER) !== '1') return forward(projectId, kind, bytes);
    return json({ partialSuccess: {} }, 200);
  })

  .post('/:projectId/web', async (c) => {
    const now = Date.now();
    const bytes = await intake(c.req.raw, c.env, c.req.param('projectId'), now);
    if (bytes instanceof Response) return bytes;

    let batch;
    try {
      batch = parseWeb(parseJson(bytes));
    } catch (e) {
      if (e instanceof InvalidWebBatch) return json({ error: 'invalid_body' }, 400);
      throw e;
    }
    try {
      const id = await sha256Hex(`web:${new TextDecoder().decode(bytes)}`);
      await withFingerprints(batch.parsed.logs);
      await storeBatch(c.env, { id, kind: 'web', bytes: bytes.byteLength, parsed: batch.parsed }, now);
    } catch (e) {
      console.error('store failed', e);
    }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
