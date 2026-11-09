// Configuration and access rules that the original telemetry code did not have: the bearer token of the read API, the
// project allowlist, PEPPER, CORS and the retention setting.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedOrigins, projectIds, retentionDays } from '../src/lib/config';
import { safeEqual } from '../src/lib/crypto';
import { purgeTelemetry } from '../src/lib/housekeeping';
import { app } from '../src/index';
import { ADMIN_TOKEN, api, BASE, PROJECT_ID_1, PROJECT_ID_2 } from './helpers';
import { logsBatch, metricsBatch, s } from './fixtures';

const db = env.DB;
const DAY = 24 * 60 * 60 * 1000;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// The Worker with some variables replaced.
const withEnv = (over: Record<string, string>) => new Proxy(env, { get: (target, key) => (typeof key === 'string' && key in over ? over[key] : Reflect.get(target, key)) });
const call = (path: string, init: RequestInit, over: Record<string, string> = {}) => app.request(`${BASE}${path}`, init, withEnv(over), ctx);

let ipSeq = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}, over: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${++ipSeq}`, ...headers }, body: JSON.stringify(body) }, over);

beforeEach(async () => {
  await db.batch(['obs_batches', 'obs_metrics', 'obs_logs', 'obs_spans', 'obs_limits'].map((t) => db.prepare(`DELETE FROM ${t}`)));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is off in tests'); }));
});
afterEach(() => vi.unstubAllGlobals());

const READ_PATHS = ['/overview', '/errors/0123456789abcdef', '/navigation', '/updates', '/metrics', '/events', '/traces'];

describe('read API: the bearer token', () => {
  it('answers 401 without a usable token and 403 for a wrong one, on every endpoint', async () => {
    for (const path of READ_PATHS) {
      const none = await api(path);
      expect(none.status, path).toBe(401);
      expect(none.headers.get('WWW-Authenticate')).toBe('Bearer');
      expect(await none.json()).toEqual({ error: 'unauthorized' });
      expect((await api(path, { token: 'x' })).status, path).toBe(403);
      expect((await api(path, { token: ADMIN_TOKEN.slice(0, -1) })).status, path).toBe(403);
      expect((await api(path, { token: `${ADMIN_TOKEN}x` })).status, path).toBe(403);
    }
  });

  it('takes only the Authorization header with the Bearer scheme', async () => {
    const get = (headers: Record<string, string>, query = '') => SELF.fetch(`${BASE}/api/overview${query}`, { headers });
    expect((await get({ Authorization: `bearer ${ADMIN_TOKEN}` })).status).toBe(200);
    expect((await get({ Authorization: `Bearer   ${ADMIN_TOKEN}` })).status).toBe(200);
    expect((await get({ Authorization: ADMIN_TOKEN })).status).toBe(401);
    expect((await get({ Authorization: `Basic ${ADMIN_TOKEN}` })).status).toBe(401);
    expect((await get({ Authorization: 'Bearer' })).status).toBe(401);
    expect((await get({ Authorization: `Bearer ${ADMIN_TOKEN} extra` })).status).toBe(401);
    // Not in the address, not in another header.
    expect((await get({}, `?token=${ADMIN_TOKEN}`)).status).toBe(401);
    expect((await get({ 'X-Admin-Token': ADMIN_TOKEN })).status).toBe(401);
  });

  it('refuses to serve with a missing or short ADMIN_TOKEN, even for the right token', async () => {
    for (const token of ['', 'short', 'x'.repeat(31)]) {
      for (const path of READ_PATHS) {
        const res = await call(`/api${path}`, { headers: { Authorization: `Bearer ${token || 'anything'}` } }, { ADMIN_TOKEN: token });
        expect(res.status, `${path} with "${token}"`).toBe(503);
        expect(await res.json()).toEqual({ error: 'api_disabled' });
      }
    }
    // Exactly 32 characters is enough.
    const edge = 'k'.repeat(32);
    expect((await call('/api/overview', { headers: { Authorization: `Bearer ${edge}` } }, { ADMIN_TOKEN: edge })).status).toBe(200);
  });

  it('never caches, never sends CORS headers, and does not reveal unknown paths without a token', async () => {
    const origin = 'https://dashboard.example.com';
    const withToken = { Authorization: `Bearer ${ADMIN_TOKEN}`, Origin: origin };
    for (const [path, headers] of [
      ['/api/overview', withToken],
      ['/api/overview', { Origin: origin }],
      ['/api/overview', { Authorization: 'Bearer wrong', Origin: origin }],
      ['/api/nothing-here', withToken],
    ] as const) {
      const res = await call(path, { headers }, { ALLOWED_ORIGINS: origin });
      expect(res.headers.get('Cache-Control'), path).toBe('no-store');
      expect(res.headers.get('Access-Control-Allow-Origin'), path).toBeNull();
    }
    const preflight = await call('/api/overview', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } }, { ALLOWED_ORIGINS: origin });
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await api('/nothing-here')).status).toBe(401);
    const unknown = await api('/nothing-here', { token: ADMIN_TOKEN });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
  });

  it('writes nothing to the log that contains a token', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const wrong = 'wrong-token-that-must-not-show-up-in-logs';
    await api('/overview', { token: wrong });
    await api('/overview', { token: ADMIN_TOKEN });
    await call('/api/overview', { headers: { Authorization: `Bearer ${wrong}` } }, { ADMIN_TOKEN: 'short' });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    spies.forEach((spy) => spy.mockRestore());
    expect(logged).not.toContain(wrong);
    expect(logged).not.toContain(ADMIN_TOKEN);
  });

  it('compares secrets without stopping at the first difference or the length', async () => {
    expect(await safeEqual('a'.repeat(40), 'a'.repeat(40))).toBe(true);
    expect(await safeEqual('a'.repeat(40), `${'a'.repeat(39)}b`)).toBe(false);
    expect(await safeEqual('a'.repeat(40), 'a'.repeat(41))).toBe(false);
    expect(await safeEqual('', 'a')).toBe(false);
    expect(await safeEqual('', '')).toBe(true);
    expect(await safeEqual('héllo', 'héllo')).toBe(true);
    expect(await safeEqual('héllo', 'hello')).toBe(false);
  });
});

describe('ingest: PROJECT_IDS and PEPPER', () => {
  const batch = metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at: Date.now() }]);

  it('accepts every listed project id and no other', async () => {
    expect((await post(`/observe/${PROJECT_ID_1}/v1/metrics`, batch)).status).toBe(200);
    expect((await post(`/observe/${PROJECT_ID_2}/v1/metrics`, batch)).status).toBe(200);
    expect((await post('/observe/00000000-0000-4000-8000-000000000000/v1/metrics', batch)).status).toBe(404);
    expect((await post(`/observe/${PROJECT_ID_1.toUpperCase()}/v1/metrics`, batch)).status).toBe(404);
  });

  it('answers 404 for everything while PROJECT_IDS is empty, and ignores entries that are not UUIDs', async () => {
    expect((await post(`/observe/${PROJECT_ID_1}/v1/metrics`, batch, {}, { PROJECT_IDS: '' })).status).toBe(404);
    expect((await post(`/observe/${PROJECT_ID_1}/v1/metrics`, batch, {}, { PROJECT_IDS: ' , ,*' })).status).toBe(404);
    expect((await post('/observe/*/v1/metrics', batch, {}, { PROJECT_IDS: '*' })).status).toBe(404);
    const mixed = { PROJECT_IDS: `nonsense, ${PROJECT_ID_2.toUpperCase()} ,${PROJECT_ID_1}` };
    expect((await post(`/observe/${PROJECT_ID_1}/v1/metrics`, batch, {}, mixed)).status).toBe(200);
    expect((await post(`/observe/${PROJECT_ID_2}/v1/metrics`, batch, {}, mixed)).status).toBe(200);
    expect([...projectIds({ PROJECT_IDS: mixed.PROJECT_IDS })]).toEqual([PROJECT_ID_2, PROJECT_ID_1]);
  });

  it('answers 503 and stores nothing when PEPPER is missing or too short', async () => {
    for (const PEPPER of ['', 'short', 'x'.repeat(15)]) {
      const res = await post(`/observe/${PROJECT_ID_1}/v1/metrics`, batch, {}, { PEPPER });
      expect(res.status, PEPPER).toBe(503);
      expect(await res.json()).toEqual({ error: 'misconfigured' });
      expect((await post(`/observe/${PROJECT_ID_1}/web`, { v: 1, events: [] }, {}, { PEPPER })).status).toBe(503);
    }
    expect((await db.prepare('SELECT COUNT(*) AS n FROM obs_batches').first<{ n: number }>())!.n).toBe(0);
    // An unknown project is still a 404, whatever the configuration.
    expect((await post('/observe/00000000-0000-4000-8000-000000000000/v1/metrics', batch, {}, { PEPPER: '' })).status).toBe(404);
  });

  it('stores ids as a hash that depends on PEPPER', async () => {
    const stored = async (PEPPER: string) => {
      await db.prepare('DELETE FROM obs_metrics').run();
      await post(`/observe/${PROJECT_ID_1}/v1/metrics`, metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at: Date.now() - Math.random() * 1000 }]), {}, { PEPPER });
      return (await db.prepare('SELECT client, session_id FROM obs_metrics').first<{ client: string; session_id: string }>())!;
    };
    const a = await stored('pepper-one-0123456789');
    const b = await stored('pepper-two-0123456789');
    const a2 = await stored('pepper-one-0123456789');
    expect(a.client).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toEqual(a2);
    expect(a.client).not.toBe(b.client);
    expect(a.session_id).not.toBe(b.session_id);
  });
});

describe('ingest: CORS', () => {
  const origin = 'https://app.example.com';
  const batch = logsBatch([{ event: 'screen.view', at: Date.now(), attributes: [s('route', '/home')] }]);
  const over = { ALLOWED_ORIGINS: `${origin}, https://other.example.com/ , http://localhost:8081, *, not a url` };

  it('adds no CORS headers by default', async () => {
    const res = await post(`/observe/${PROJECT_ID_1}/v1/logs`, batch, { Origin: origin });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const pre = await call(`/observe/${PROJECT_ID_1}/web`, { method: 'OPTIONS', headers: { Origin: origin } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers the preflight and marks the response for an allowed origin only', async () => {
    for (const path of ['v1/logs', 'v1/metrics', 'v1/traces', 'web']) {
      const pre = await call(`/observe/${PROJECT_ID_1}/${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } }, over);
      expect(pre.status, path).toBe(204);
      expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
      expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
      expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('X-Open-Observe-Mirror');
      expect(pre.headers.get('Vary')).toContain('Origin');
    }
    const ok = await post(`/observe/${PROJECT_ID_1}/v1/logs`, batch, { Origin: origin }, over);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const web = await post(`/observe/${PROJECT_ID_1}/web`, { v: 1, events: [] }, { Origin: origin }, over);
    expect(web.status).toBe(204);
    expect(web.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    // Errors carry them too, so the page can read the status.
    const bad = await post(`/observe/${PROJECT_ID_1}/web`, { v: 2 }, { Origin: origin }, over);
    expect(bad.status).toBe(400);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect((await post(`/observe/${PROJECT_ID_1}/v1/logs`, batch, { Origin: 'http://localhost:8081' }, over)).headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8081');
    expect((await post(`/observe/${PROJECT_ID_1}/v1/logs`, batch, { Origin: 'https://other.example.com' }, over)).headers.get('Access-Control-Allow-Origin')).toBe('https://other.example.com');
  });

  it('never answers with a wildcard, and not for an origin that is not listed', async () => {
    for (const evil of ['https://evil.example.com', 'https://app.example.com.evil.com', 'http://app.example.com', 'null', '*']) {
      const pre = await call(`/observe/${PROJECT_ID_1}/web`, { method: 'OPTIONS', headers: { Origin: evil } }, over);
      expect(pre.headers.get('Access-Control-Allow-Origin'), evil).toBeNull();
      const res = await post(`/observe/${PROJECT_ID_1}/v1/logs`, batch, { Origin: evil }, over);
      expect(res.headers.get('Access-Control-Allow-Origin'), evil).toBeNull();
    }
    expect([...allowedOrigins(over)].sort()).toEqual(['http://localhost:8081', 'https://app.example.com', 'https://other.example.com']);
    expect([...allowedOrigins({ ALLOWED_ORIGINS: '*' })]).toEqual([]);
    expect([...allowedOrigins({ ALLOWED_ORIGINS: 'https://a.example.com/path' })]).toEqual([]);
  });

  it('does not answer the preflight for an unknown project', async () => {
    const pre = await call('/observe/00000000-0000-4000-8000-000000000000/web', { method: 'OPTIONS', headers: { Origin: origin } }, over);
    expect(pre.status).toBe(404);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('RETENTION_DAYS', () => {
  it('reads whole days from 1 to 365 and falls back to 30', () => {
    expect(retentionDays({})).toBe(30);
    expect(retentionDays({ RETENTION_DAYS: '7' })).toBe(7);
    expect(retentionDays({ RETENTION_DAYS: ' 365 ' })).toBe(365);
    for (const bad of ['0', '366', '-3', '1.5', 'abc', '', '1e2', '0x10', '7 days']) expect(retentionDays({ RETENTION_DAYS: bad }), bad).toBe(30);
  });

  it('decides what the purge deletes', async () => {
    const now = Date.now();
    const log = (t: number) => db.prepare(`INSERT INTO obs_logs (ts, received_at, platform, app_version, environment, category, name, severity) VALUES (?1, ?1, 'android', '1', 'production', 'event', 'x', 'info')`).bind(t);
    await db.batch([log(now - 10 * DAY), log(now - 5 * DAY), log(now - 1 * DAY)]);
    await purgeTelemetry({ ...env, RETENTION_DAYS: '7' }, now);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM obs_logs').first<{ n: number }>())!.n).toBe(2);
    await purgeTelemetry({ ...env, RETENTION_DAYS: '2' }, now);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM obs_logs').first<{ n: number }>())!.n).toBe(1);
    await purgeTelemetry({ ...env, RETENTION_DAYS: 'nonsense' }, now + 40 * DAY);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM obs_logs').first<{ n: number }>())!.n).toBe(0);
  });

  it('counts an event older than the retention as arrived now', async () => {
    const old = Date.now() - 10 * DAY;
    const send = (RETENTION_DAYS: string) => post(`/observe/${PROJECT_ID_1}/v1/logs`, logsBatch([{ event: 'screen.view', at: old + Math.random() }]), {}, { RETENTION_DAYS });
    await send('30');
    await send('7');
    const times = (await db.prepare('SELECT ts, received_at FROM obs_logs ORDER BY id').all<{ ts: number; received_at: number }>()).results;
    expect(Math.abs(times[0].ts - old)).toBeLessThan(2);
    expect(times[1].ts).toBe(times[1].received_at);
  });
});

describe('forwarding switch', () => {
  it('forwards only for FORWARD_TO_EXPO=1, to the project in the path, and never a mirrored batch', async () => {
    const fetchStub = vi.fn(async () => new Response('{"partialSuccess":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchStub);
    const body = logsBatch([{ event: 'screen.view', at: Date.now() }]);
    await post(`/observe/${PROJECT_ID_2}/v1/logs`, body);
    for (const off of ['0', '', 'true', 'yes', ' 1']) await post(`/observe/${PROJECT_ID_2}/v1/logs`, body, {}, { FORWARD_TO_EXPO: off });
    expect(fetchStub).not.toHaveBeenCalled();
    await post(`/observe/${PROJECT_ID_2}/v1/logs`, body, {}, { FORWARD_TO_EXPO: '1' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect((fetchStub.mock.calls[0] as unknown[])[0]).toBe(`https://o.expo.dev/${PROJECT_ID_2}/v1/logs`);
    await post(`/observe/${PROJECT_ID_2}/v1/logs`, body, { 'X-Open-Observe-Mirror': '1' }, { FORWARD_TO_EXPO: '1' });
    await post(`/observe/${PROJECT_ID_2}/web`, { v: 1, events: [] }, {}, { FORWARD_TO_EXPO: '1' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('everything else is the dashboard', () => {
  it('leaves unknown /api and /observe paths to the Worker and gives all other paths to the assets binding', async () => {
    const assets = vi.fn(async () => new Response('<!doctype html>dashboard', { headers: { 'Content-Type': 'text/html' } }));
    const fake = withEnv({}) as typeof env;
    const res = await app.request(`${BASE}/some/route`, {}, new Proxy(fake, { get: (t, k) => (k === 'ASSETS' ? { fetch: assets } : Reflect.get(t, k)) }), ctx);
    expect(await res.text()).toContain('dashboard');
    expect(assets).toHaveBeenCalledTimes(1);
    for (const path of ['/observe', '/observe/x/y/z', '/api/x']) {
      const other = await app.request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }, new Proxy(fake, { get: (t, k) => (k === 'ASSETS' ? { fetch: assets } : Reflect.get(t, k)) }), ctx);
      expect(other.status, path).toBe(404);
      expect(await other.json()).toEqual({ error: 'not_found' });
    }
    expect(assets).toHaveBeenCalledTimes(1);
  });
});
