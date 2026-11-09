import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeTelemetry } from '../src/lib/housekeeping';
import { fingerprintInput } from '../src/lib/fingerprint';
import { anyValue, nanosToMs } from '../src/lib/otlp';
import { scrubRoute, scrubText } from '../src/lib/scrub';
import { app } from '../src/index';
import { MAX_BODY_BYTES } from '../src/routes/ingest';
import { RATE_LIMIT_PER_WINDOW } from '../src/lib/store';
import { ADMIN_TOKEN, api, BASE, PROJECT_ID_1, PROJECT_ID_2 } from './helpers';
import {
  b,
  CLIENT_ID,
  hermesStack,
  i,
  jsException,
  logsBatch,
  metricsBatch,
  resource,
  s,
  SESSION_ID,
  tracesBatch,
  UPDATE_ID,
  webBatch,
} from './fixtures';

const PROJECT = PROJECT_ID_1;
const db = env.DB;
const DAY = 24 * 60 * 60 * 1000;
const TABLES = ['obs_batches', 'obs_metrics', 'obs_logs', 'obs_spans', 'obs_limits'] as const;

let ipSeq = 0;
// Every request comes from its own address unless a test says otherwise: the rate limit is per address.
const newIp = () => `198.51.100.${++ipSeq}`;

type Send = { ip?: string; ua?: string; contentType?: string | null; headers?: Record<string, string> };
function init(body: BodyInit, o: Send): RequestInit {
  const headers = new Headers(o.headers);
  headers.set('CF-Connecting-IP', o.ip ?? newIp());
  headers.set('User-Agent', o.ua ?? 'ObserveTest/1.0');
  if (o.contentType !== null) headers.set('Content-Type', o.contentType ?? 'application/json');
  return { method: 'POST', headers, body };
}
const text = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body));

// Through the whole Worker (forwarding is off in the tests: FORWARD_TO_EXPO = '0').
const send = (path: string, body: unknown, o: Send = {}, project = PROJECT) =>
  SELF.fetch(`${BASE}/observe/${project}/${path}`, init(text(body), o));
const sendNative = (kind: 'metrics' | 'logs' | 'traces', body: unknown, o: Send = {}) => send(`v1/${kind}`, body, o);
const sendWeb = (body: unknown, o: Send = {}) => send('web', body, o);

// The same request with forwarding switched on, the global fetch (to Expo) stubbed. Never touches the network.
const forwardEnv = new Proxy(env, { get: (target, key) => (key === 'FORWARD_TO_EXPO' ? '1' : Reflect.get(target, key)) });
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const sendForwarded = (kind: string, body: unknown, o: Send = {}) =>
  app.request(`${BASE}/observe/${PROJECT}/v1/${kind}`, init(text(body), o), forwardEnv, ctx);

const rows = async <T = any>(table: string, where = '1 = 1') =>
  (await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all<T>()).results;
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  // Nothing in this file may reach the network: every fetch that is not answered by a test fails.
  fetchStub = vi.fn(async () => {
    throw new Error('network is off in tests');
  });
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => vi.unstubAllGlobals());

const expoReply = (status: number, body: string, headers: Record<string, string> = {}) =>
  fetchStub.mockImplementation(async () => new Response(status === 204 ? null : body, { status, headers }));

describe('observe ingest: limits', () => {
  it('knows only its own project id and the three kinds', async () => {
    const body = metricsBatch([]);
    expect((await send('v1/metrics', body, {}, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await send('web', webBatch([]), {}, 'other')).status).toBe(404);
    expect((await send('v1/spans', body)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/observe/${PROJECT}/v1/metrics`)).status).toBe(404);
    expect(await count('obs_batches')).toBe(0);
    // Answered by the Worker, not by the web build (the SPA would answer 200 with index.html).
    expect((await (await SELF.fetch(`${BASE}/observe/nothing`)).json()) as any).toEqual({ error: 'not_found' });
  });

  it('accepts JSON only (415) and at most 512 KiB (413)', async () => {
    const body = metricsBatch([]);
    expect((await sendNative('metrics', body, { contentType: 'text/plain' })).status).toBe(415);
    expect((await sendNative('metrics', body, { contentType: 'application/x-protobuf' })).status).toBe(415);
    expect((await sendNative('metrics', body, { contentType: null })).status).toBe(415);
    expect((await sendNative('metrics', body, { contentType: 'application/json; charset=utf-8' })).status).toBe(200);

    const big = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await send('v1/logs', big)).status).toBe(413);
    expect((await sendWeb(big)).status).toBe(413);
    // Exactly at the limit still goes through.
    const limit = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES - 10) });
    expect(limit.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect((await send('v1/logs', limit)).status).toBe(200);
    expect(await count('obs_metrics')).toBe(0);
  });

  it('limits requests per client address and keeps no address', async () => {
    const ip = '203.0.113.9';
    // The counter restarts every minute: if the minute changes while the loop runs, the 429 just comes later.
    let ok = 0;
    let limited = await sendNative('logs', logsBatch([]), { ip });
    while (limited.status === 200 && ok < 2 * RATE_LIMIT_PER_WINDOW) {
      ok++;
      limited = await sendNative('logs', logsBatch([]), { ip });
    }
    expect(ok).toBeGreaterThanOrEqual(RATE_LIMIT_PER_WINDOW - 1);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    // Another address is not affected, and the web endpoint shares the budget of its address.
    expect((await sendNative('logs', logsBatch([]), { ip: '203.0.113.10' })).status).toBe(200);
    expect((await sendWeb(webBatch([]), { ip })).status).toBe(429);
    const stored = JSON.stringify(await rows('obs_limits'));
    expect(stored).not.toContain(ip);
    expect(await count('obs_limits')).toBeGreaterThanOrEqual(2);
  });

  it('never fails the answer because of a body it cannot parse', async () => {
    for (const bad of ['not json', '[]', '{"resourceMetrics":"x"}', '{"resourceMetrics":[null,7,{"scopeMetrics":[{"metrics":[{"name":5}]}]}]}']) {
      const res = await send('v1/metrics', bad);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ partialSuccess: {} });
    }
    expect(await count('obs_metrics')).toBe(0);
  });
});

describe('observe ingest: forwarding to Expo', () => {
  it('stores and answers 200 without calling Expo when forwarding is off', async () => {
    const res = await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1.5, at: Date.now() }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await count('obs_metrics')).toBe(1);
  });

  it('forwards the original bytes unchanged and passes the answer through', async () => {
    expoReply(200, '{"partialSuccess":{"rejectedDataPoints":2,"errorMessage":"nope"}}', { 'Content-Type': 'application/json' });
    const batch = metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1.5, at: Date.now() }]);
    // Spacing the sender chose is part of "unchanged".
    const original = JSON.stringify(batch, null, 1);
    const res = await sendForwarded('metrics', original, { ip: '203.0.113.50', ua: 'Expo-Observe/58' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: { rejectedDataPoints: 2, errorMessage: 'nope' } });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, request] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://o.expo.dev/${PROJECT}/v1/metrics`);
    expect(request.method).toBe('POST');
    expect(new TextDecoder().decode(request.body as Uint8Array)).toBe(original);
    expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    // Stored before it was forwarded; no address or agent went to Expo.
    expect(await count('obs_metrics')).toBe(1);
    expect(JSON.stringify(fetchStub.mock.calls)).not.toContain('203.0.113.50');
    expect(JSON.stringify(fetchStub.mock.calls)).not.toContain('Expo-Observe/58');
  });

  it('stores a batch marked as the phone mirror without forwarding it (the native module already sent it to Expo)', async () => {
    const batch = logsBatch([{ event: 'screen.view', at: Date.now(), attributes: [s('route', '/home')] }]);
    const res = await sendForwarded('logs', batch, { headers: { 'X-Open-Observe-Mirror': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await count('obs_logs')).toBe(1);
  });

  it('forwards logs and traces to their own Expo endpoints', async () => {
    expoReply(200, '{}');
    await sendForwarded('logs', logsBatch([{ event: 'auth.signed_in', at: Date.now() }]));
    await sendForwarded('traces', tracesBatch([{ at: Date.now(), ms: 120 }]));
    expect(fetchStub.mock.calls.map((c) => c[0])).toEqual([
      `https://o.expo.dev/${PROJECT}/v1/logs`,
      `https://o.expo.dev/${PROJECT}/v1/traces`,
    ]);
  });

  it('passes the status, body and Retry-After of a refusal through', async () => {
    for (const [status, retryAfter] of [[429, '17'], [502, '3'], [503, null], [504, '120'], [400, null]] as const) {
      expoReply(status, `{"error":"${status}"}`, retryAfter ? { 'Retry-After': retryAfter } : {});
      const res = await sendForwarded('metrics', metricsBatch([]));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: String(status) });
      expect(res.headers.get('Retry-After')).toBe(retryAfter);
    }
  });

  it('passes an empty 204 through', async () => {
    expoReply(204, '');
    const res = await sendForwarded('logs', logsBatch([]));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers 503 when Expo cannot be reached or does not answer within 5 seconds', async () => {
    fetchStub.mockRejectedValue(new TypeError('connection refused'));
    expect((await sendForwarded('metrics', metricsBatch([]))).status).toBe(503);
    fetchStub.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    expect((await sendForwarded('metrics', metricsBatch([]))).status).toBe(503);
  });

  it('still forwards a body it cannot parse, and a storage failure does not change the answer', async () => {
    expoReply(200, '{}');
    const res = await sendForwarded('logs', 'not json at all');
    expect(res.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const broken = new Proxy(forwardEnv, { get: (t, k) => (k === 'DB' ? {} : Reflect.get(t, k)) });
    const again = await app.request(`${BASE}/observe/${PROJECT}/v1/logs`, init(text(logsBatch([])), {}), broken, ctx);
    expect(again.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('stores a batch once and forwards its retry again', async () => {
    expoReply(200, '{}');
    const batch = logsBatch([{ event: 'auth.signed_in', at: Date.now() }]);
    const first = text(batch);
    expect((await sendForwarded('logs', first)).status).toBe(200);
    expect((await sendForwarded('logs', first)).status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(await count('obs_logs')).toBe(1);
    expect(await count('obs_batches')).toBe(1);
    // A different body (or the same body on another kind) is a different batch.
    await sendForwarded('logs', logsBatch([{ event: 'auth.signed_in', at: Date.now() + 5 }]));
    expect(await count('obs_logs')).toBe(2);
    const metrics = text({ resourceMetrics: [] });
    await sendForwarded('metrics', metrics);
    await sendForwarded('traces', metrics);
    expect(await count('obs_batches')).toBe(4);
    const [stored] = await rows('obs_batches');
    expect(stored).toMatchObject({ kind: 'logs', bytes: new TextEncoder().encode(first).byteLength });
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores a repeated batch once without forwarding, too', async () => {
    const batch = metricsBatch([{ name: 'expo.app_startup.tti', seconds: 2, at: Date.now() }]);
    await sendNative('metrics', batch);
    await sendNative('metrics', batch);
    expect(await count('obs_metrics')).toBe(1);
  });
});

describe('observe ingest: native OTLP', () => {
  it('stores metrics with the real resource and attribute names', async () => {
    const at = Date.now() - 5000;
    const res = await sendNative(
      'metrics',
      metricsBatch(
        [
          { name: 'expo.navigation.tti', seconds: 0.4321, at, route: '/p/[code]', updateId: UPDATE_ID },
          { name: 'expo.app_startup.tti', seconds: 2.5, at: at + 1, asString: true },
          { name: 'expo.unknown.physical', seconds: 123456789, at },
        ],
        resource({ clientId: CLIENT_ID }),
      ),
    );
    expect(res.status).toBe(200);
    const stored = await rows('obs_metrics');
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({
      platform: 'android',
      os_version: '15',
      // The model identifier, not device.model.name (a name the owner may have given the phone).
      device_model: 'Pixel 9',
      app_version: '1.8.1',
      update_id: UPDATE_ID,
      environment: 'production',
      category: 'navigation',
      name: 'expo.navigation.tti',
      value: 432.1,
      route: '/p/[code]',
      ts: at,
    });
    expect(stored[0].received_at).toBeGreaterThanOrEqual(at);
    // The id is a 16 character HMAC, never the id; so is the session.
    expect(stored[0].client).toMatch(/^[0-9a-f]{16}$/);
    expect(stored[0].session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(stored[0].client).not.toBe(stored[0].session_id);
    expect(stored[1].client).toBe(stored[0].client);
    // The resource update id is the fallback; a string timestamp is read like a number; seconds became milliseconds.
    expect(stored[1]).toMatchObject({ category: 'app_startup', value: 2500, update_id: UPDATE_ID, ts: at + 1, route: null });
    // Unknown metrics keep their value (OTLP says seconds for all of them, the memory ones are not).
    expect(stored[2]).toMatchObject({ category: 'unknown', name: 'expo.unknown.physical', value: 123456789 });
    expect(JSON.stringify(stored)).not.toContain('api.example.com');
  });

  it('reads an iOS resource and the same install as the same hash', async () => {
    const at = Date.now();
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.ttr', seconds: 1, at }], resource({ platform: 'ios', environment: null, updateId: null })));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.ttr', seconds: 1, at }], resource({ platform: 'android', clientId: 'someone-else' })));
    const [ios, android] = await rows('obs_metrics');
    expect(ios).toMatchObject({ platform: 'ios', os_version: '26.2', device_model: 'iPhone18,1', environment: '', update_id: null });
    expect(android).toMatchObject({ platform: 'android' });
    expect(ios.client).not.toBe(android.client);
  });

  it('classifies errors and crashes, scrubs their text and groups them by fingerprint', async () => {
    const at = Date.now() - 1000;
    const message = 'Cannot read property of anna.smith@example.com (user 123456789012, id 0f8fad5b-d9cb-469f-a165-70867728950e, ref deadbeefcafe)';
    await sendNative('logs', jsException({ message, stack: hermesStack(1234, 5), at }));
    await sendNative('logs', jsException({ message: 'Another message 42', stack: hermesStack(9999, 8), at: at + 1 }));
    await sendNative('logs', jsException({ type: 'RangeError', message: 'Another message 42', stack: hermesStack(9999, 8), at: at + 2 }));
    await sendNative('logs', jsException({ type: 'Error', message: 'Fatal', stack: hermesStack(1, 2), fatal: true, at: at + 3 }));
    await sendNative('logs', logsBatch([{ event: 'native.exception', severity: 'fatal', at: at + 4, attributes: [s('exception.type', 'EXC_BAD_ACCESS'), s('exception.message', 'SIGSEGV'), s('expo.error.source', 'nativeCrash'), b('expo.error.is_fatal', true)] }]));
    await sendNative('logs', logsBatch([{ event: 'auth.signed_in', at: at + 5, severity: 'info' }]));

    const logs = await rows('obs_logs');
    expect(logs.map((l) => l.category)).toEqual(['error', 'error', 'error', 'crash', 'crash', 'event']);
    expect(logs[0]).toMatchObject({ name: 'js.exception', severity: 'error', error_type: 'TypeError', platform: 'android', ts: at });
    expect(logs[0].body).toBe('Cannot read property of [email] (user [num], id [uuid], ref [hex])');
    expect(logs[3]).toMatchObject({ severity: 'fatal', category: 'crash' });
    expect(logs[4]).toMatchObject({ error_type: 'EXC_BAD_ACCESS', body: 'SIGSEGV' });
    expect(logs[5]).toMatchObject({ category: 'event', fingerprint: null, error_type: null });
    // Same type and frames (different message, different columns) = one group; another type = another.
    expect(logs[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(logs[1].fingerprint).toBe(logs[0].fingerprint);
    expect(logs[2].fingerprint).not.toBe(logs[0].fingerprint);
    expect(new Set(logs.slice(0, 5).map((l) => l.fingerprint)).size).toBe(4);
  });

  it('keeps the fingerprint stable across builds and splits on other frames', () => {
    const a = fingerprintInput('TypeError', hermesStack(1234, 5), 'x');
    expect(fingerprintInput('TypeError', hermesStack(98765, 4), 'other message')).toBe(a);
    expect(fingerprintInput('TypeError', hermesStack(1234, 5).replace('renderRecord', 'renderOther'), 'x')).not.toBe(a);
    // Firefox/Safari frames, and no stack at all (the message without its digits).
    expect(fingerprintInput('Error', 'doIt@https://example.com/a.js:10:20\nrun@https://example.com/a.js:30:2', null)).toBe(
      fingerprintInput('Error', 'doIt@https://example.com/b.js:99:1\nrun@https://example.com/b.js:1:1', null),
    );
    expect(fingerprintInput('Error', null, 'Timeout after 3000 ms')).toBe(fingerprintInput('Error', null, 'Timeout after 5000 ms'));
  });

  it('drops attributes by name, strips addresses and caps lengths', async () => {
    const at = Date.now();
    const longMessage = 'word '.repeat(400);
    const longStack = `TypeError: x\n${'    at deep (address at index.android.bundle:1:2)\n'.repeat(400)}`;
    await sendNative(
      'logs',
      jsException({
        message: longMessage,
        stack: longStack,
        at,
        extra: [
          s('user.email', 'anna@example.com'),
          s('requestHeaders', 'Authorization: x'),
          s('queryParams', '{"code":"ABCDEFGH"}'),
          s('responseBody', 'secret'),
          s('authToken', 'abc'),
          s('PasswordHint', 'abc'),
          s('screen.url', 'https://app.example.com/p/ABCDEFGH?code=1234&token=zzz#section'),
          s('screen.path', '/p/0f8fad5b-d9cb-469f-a165-70867728950e?x=1'),
          i('retry.count', 3),
          i('retry.big', 42, true),
          { key: 'list', value: { arrayValue: { values: [{ stringValue: 'a' }] } } },
          s('free.text', 'call 777 123 456 or mail me@example.org'),
        ],
      }),
    );
    const [log] = await rows('obs_logs');
    expect(log.body).toHaveLength(500);
    expect(log.stack.length).toBeLessThanOrEqual(4000);
    const attrs = JSON.parse(log.attrs);
    expect(attrs).toEqual({
      'expo.error.source': 'global',
      'expo.error.is_fatal': false,
      'screen.url': 'https://app.example.com/p/ABCDEFGH',
      'screen.path': '/p/[uuid]',
      'retry.count': 3,
      'retry.big': 42,
      'free.text': 'call [num] or mail [email]',
    });
    expect(log.attrs).not.toMatch(/anna|Authorization|ABCDEFGH\?|token=|secret/);
  });

  it('reads intValue as a number and as a string', () => {
    expect(anyValue({ intValue: 42 })).toBe(42);
    expect(anyValue({ intValue: '42' })).toBe(42);
    expect(anyValue({ intValue: '-7' })).toBe(-7);
    expect(anyValue({ intValue: 'x' })).toBeUndefined();
    expect(anyValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(anyValue({ boolValue: false })).toBe(false);
    expect(anyValue({ stringValue: 'a' })).toBe('a');
    expect(anyValue({ arrayValue: { values: [] } })).toBeUndefined();
    expect(nanosToMs(1_794_146_900_123_000_000)).toBe(1_794_146_900_123);
    expect(nanosToMs('1794146900123000000')).toBe(1_794_146_900_123);
    expect(nanosToMs('x')).toBeNull();
    expect(nanosToMs(0)).toBeNull();
  });

  it('stores spans with the host only', async () => {
    const at = Date.now() - 10_000;
    await sendNative(
      'traces',
      tracesBatch([
        { at, ms: 250, status: 200 },
        { at: at + 1, ms: 90, failed: true, status: 500, name: 'POST', parentSpanId: 'b7ad6b7169203331' },
      ]),
    );
    const spans = await rows('obs_spans');
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ name: 'GET', duration_ms: 250, status: 'unset', http_status: 200, target: 'app.example.com', platform: 'android', app_version: '1.8.1', environment: 'production', parent_id: null, ts: at });
    expect(spans[1]).toMatchObject({ name: 'POST', status: 'error', http_status: 500, parent_id: 'b7ad6b7169203331' });
    expect(JSON.stringify(spans)).not.toMatch(/token|abc123|records|0f8fad5b/);
  });

  it('puts a time from the future or from before the retention at the arrival time', async () => {
    const now = Date.now();
    await sendNative('metrics', metricsBatch([
      { name: 'expo.app_startup.tti', seconds: 1, at: now + 3 * DAY },
      { name: 'expo.app_startup.ttr', seconds: 1, at: now - 90 * DAY },
    ]));
    for (const row of await rows('obs_metrics')) expect(Math.abs(row.ts - row.received_at)).toBeLessThan(5);
  });
});

describe('observe ingest: web diagnostics', () => {
  const ts = Date.now() - 2000;

  it('stores vitals and navigation as metrics and errors as logs, and answers 204', async () => {
    const res = await sendWeb(
      webBatch([
        { t: 'vital', name: 'LCP', value: 1832.4, rating: 'good', ts },
        { t: 'vital', name: 'CLS', value: 0.05, rating: 'good', ts },
        { t: 'nav', name: 'page_load', value: 2410, ts },
        { t: 'error', name: 'TypeError', message: 'x is undefined for alex@example.com', stack: 'TypeError: x\n    at fn (https://app.example.com/_expo/static/js/web/entry-1a2b3c4d5e6f.js:10:20)', handled: false, ts },
      ]),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const metrics = await rows('obs_metrics');
    expect(metrics.map((m) => [m.category, m.name, m.value])).toEqual([
      ['web_vital', 'LCP', 1832.4],
      ['web_vital', 'CLS', 0.05],
      ['web_nav', 'page_load', 2410],
    ]);
    expect(metrics[0]).toMatchObject({ platform: 'web', app_version: '1.8.1', environment: 'web', device_model: 'Chrome 126', route: '/p/[code]', ts, update_id: null, os_version: null });
    expect(metrics[0].client).toBeNull();
    expect(metrics[0].session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(metrics[0].session_id).toBe(metrics[2].session_id);
    const [error] = await rows('obs_logs');
    expect(error).toMatchObject({ category: 'error', severity: 'error', platform: 'web', error_type: 'TypeError', route: '/p/[code]', ts });
    expect(error.body).toBe('x is undefined for [email]');
    expect(error.stack).toContain('at fn');
    expect(error.stack).not.toContain('1a2b3c4d5e6f');
    expect(JSON.parse(error.attrs)).toEqual({ viewport: '390x844', connection: '4g', handled: false });
    expect(error.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a malformed batch (400) and skips events that are not valid', async () => {
    for (const bad of [null, [], { v: 2, events: [] }, { v: 1 }, { v: 1, events: 'x' }, 'not json', webBatch(Array.from({ length: 51 }, () => ({ t: 'nav', name: 'page_load', value: 1 })))]) {
      const res = await sendWeb(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect(await count('obs_metrics')).toBe(0);
    // Exactly 50 are fine; the invalid ones among them are skipped, the valid ones stored.
    const events: Record<string, unknown>[] = [
      { t: 'vital', name: 'FID', value: 5, ts },
      { t: 'vital', name: 'LCP', value: -1, ts },
      { t: 'vital', name: 'LCP', value: 'fast', ts },
      { t: 'vital', name: 'LCP', value: 1e12, ts },
      { t: 'nav', name: 'Page Load', value: 1, ts },
      { t: 'click', name: 'x', value: 1 },
      null as any,
      'x' as any,
      { t: 'vital', name: 'INP', value: 120, ts },
    ];
    while (events.length < 50) events.push({ t: 'nav', name: 'dom_ready', value: 10, ts });
    expect((await sendWeb(webBatch(events))).status).toBe(204);
    expect(await count('obs_metrics')).toBe(42);
  });

  it('keeps a route a template: no query, no fragment, no ids', async () => {
    await sendWeb(webBatch([{ t: 'nav', name: 'page_load', value: 1, ts }], { route: '/p/ABCDEFGH?code=123456#top' }));
    await sendWeb(webBatch([{ t: 'nav', name: 'page_load', value: 2, ts }], { route: 'https://app.example.com/records/0f8fad5b-d9cb-469f-a165-70867728950e?x=1' }));
    expect((await rows('obs_metrics')).map((m) => m.route)).toEqual(['/p/ABCDEFGH', '/records/[uuid]']);
    expect(scrubRoute('/p/[code]')).toBe('/p/[code]');
    expect(scrubRoute('')).toBeNull();
    expect(scrubRoute(5)).toBeNull();
  });
});

describe('observe privacy', () => {
  it('scrubs e-mails, long numbers, hex codes, UUIDs and tokens', () => {
    expect(scrubText('mail alex.smith+x@sub.example.org now')).toBe('mail [email] now');
    expect(scrubText('rc 800102/1234 and 8001021234')).toBe('rc [num] and [num]');
    expect(scrubText('tel +420 777 123 456, iban CZ65 0800 0000 1920 0014 5399')).toBe('tel [num], iban CZ[num]');
    expect(scrubText('born 1980-01-02')).toBe('born [num]');
    expect(scrubText('id 0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('id [uuid]');
    expect(scrubText('code 0xdeadbeef and a1b2c3d4e5f6')).toBe('code [hex] and [hex]');
    expect(scrubText('jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe('jwt [token]');
    expect(scrubText('GET https://api.example.com/a/b?token=abc&x=1#frag failed')).toBe('GET https://api.example.com/a/b failed');
    expect(scrubText('five 12345 and 123456')).toBe('five 12345 and [num]');
    // Line and column numbers of a stack stay readable.
    expect(scrubText('bundle.js:1:123456', { stack: true })).toBe('bundle.js:1:123456');
    expect(scrubText('Timeout after 3000 ms')).toBe('Timeout after 3000 ms');
  });

  it('keeps no address, user agent, raw client id or raw session id in any observe table', async () => {
    const ip = '203.0.113.77';
    const ua = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) SecretAgent/9.9';
    const at = Date.now() - 1000;
    const o = { ip, ua, headers: { 'X-Forwarded-For': '203.0.113.78', Referer: 'https://app.example.com/p/ABCDEFGH?code=1' } };
    expect((await sendNative('metrics', metricsBatch([{ name: 'expo.navigation.tti', seconds: 1, at, route: '/p/[code]' }]), o)).status).toBe(200);
    expect((await sendNative('logs', jsException({ message: 'boom', stack: hermesStack(1, 1), at }), o)).status).toBe(200);
    expect((await sendNative('traces', tracesBatch([{ at, ms: 10 }]), o)).status).toBe(200);
    expect((await sendWeb(webBatch([{ t: 'vital', name: 'LCP', value: 100, ts: at }, { t: 'error', name: 'Error', message: 'x', ts: at }]), o)).status).toBe(204);

    let total = 0;
    for (const table of TABLES) {
      const dump = JSON.stringify(await rows(table, '1 = 1'));
      total += (await count(table));
      for (const forbidden of [ip, '203.0.113.78', 'SecretAgent', 'Mozilla', 'ABCDEFGH', CLIENT_ID, SESSION_ID, "Alex's Pixel", 'web-session-1']) {
        expect(dump, `${table} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(total).toBeGreaterThan(6);
    // No column anywhere is named for an address or an agent.
    for (const table of TABLES) {
      const columns = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name);
      expect(columns.filter((c) => /ip|addr|agent|ua$/i.test(c) && c !== 'received_at')).toEqual([]);
    }
  });
});

describe('observe retention', () => {
  it('purges rows older than 30 days from the data tables and the batches, and old rate counters', async () => {
    const now = Date.now();
    const old = now - 31 * DAY;
    const fresh = now - 29 * DAY;
    const metric = (t: number) =>
      db.prepare(`INSERT INTO obs_metrics (ts, received_at, platform, app_version, environment, category, name, value) VALUES (?1, ?1, 'android', '1', 'production', 'navigation', 'expo.navigation.tti', 1)`).bind(t);
    const log = (t: number) =>
      db.prepare(`INSERT INTO obs_logs (ts, received_at, platform, app_version, environment, category, name, severity) VALUES (?1, ?1, 'android', '1', 'production', 'event', 'x', 'info')`).bind(t);
    const span = (t: number) =>
      db.prepare(`INSERT INTO obs_spans (ts, received_at, trace_id, span_id, name, duration_ms, status, platform, app_version, environment) VALUES (?1, ?1, 't', 's', 'GET', 1, 'ok', 'android', '1', 'production')`).bind(t);
    const batch = (id: string, t: number) => db.prepare(`INSERT INTO obs_batches (id, kind, received_at, bytes) VALUES (?, 'logs', ?, 1)`).bind(id, t);
    await db.batch([
      metric(old), metric(fresh), log(old), log(fresh), span(old), span(fresh), batch('old', old), batch('fresh', fresh),
      db.prepare(`INSERT INTO obs_limits (key, window_start, count) VALUES ('old', ?, 1), ('current', ?, 1)`).bind(now - 2 * 60 * 60 * 1000, now),
    ]);
    await purgeTelemetry(env, now);
    for (const table of ['obs_metrics', 'obs_logs', 'obs_spans', 'obs_batches']) {
      expect(await count(table), table).toBe(1);
    }
    expect((await rows('obs_batches'))[0]).toMatchObject({ id: 'fresh' });
    expect((await db.prepare('SELECT key FROM obs_limits').all()).results).toEqual([{ key: 'current' }]);
  });
});

describe('read API: overview and errors', () => {
  const adminToken = async () => ADMIN_TOKEN;
  const overview = async (token: string, query = '') => api(`/overview${query}`, { token });

  // Four routes' worth of data: two installs on Android, one on iOS, web vitals, an error group and a crash.
  async function seed() {
    const at = Date.now() - 60_000;
    const android = resource({ clientId: 'install-a', version: '1.8.1' });
    const older = resource({ clientId: 'install-b', version: '1.7.1', environment: 'preview' });
    const ios = resource({ platform: 'ios', clientId: 'install-c', version: '1.8.1' });
    await sendNative('metrics', metricsBatch([0.1, 0.2, 0.3, 0.4].map((seconds, n) => ({ name: 'expo.navigation.tti', seconds, at: at + n, route: '/home', session: 'sa' })), android));
    await sendNative('metrics', metricsBatch([0.5, 0.9].map((seconds, n) => ({ name: 'expo.navigation.tti', seconds, at: at + 10 + n, route: '/p/[code]', session: 'sb' })), older));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 3, at: at + 20, session: 'sc' }], ios));
    await sendNative('logs', jsException({ message: 'first 111', stack: hermesStack(10, 1), at: at + 30 }, android));
    await sendNative('logs', jsException({ message: 'second 222', stack: hermesStack(20, 2), at: at + 31 }, older));
    await sendNative('logs', jsException({ message: 'Fatal', type: 'Error', stack: hermesStack(30, 3), fatal: true, at: at + 32 }, ios));
    await sendWeb(webBatch([1000, 3000, 5000, 2000].map((value, n) => ({ t: 'vital', name: 'LCP', value, ts: at + n })), { session: 'w1' }));
    await sendWeb(webBatch([{ t: 'error', name: 'TypeError', message: 'web boom', stack: 'TypeError: x\n    at fn (https://app.example.com/a.js:1:2)', ts: at }], { session: 'w2', appVersion: '1.8.0' }));
  }

  it('needs the admin token', async () => {
    const none = await api('/overview');
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'unauthorized' });
    for (const path of ['/overview', '/errors/0123456789abcdef']) {
      const res = await api(path, { token: 'not-the-admin-token' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
  });

  it('answers an empty database with zeros and every day of the range', async () => {
    const res = await overview(await adminToken());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.range.days).toBe(7);
    expect(body.range.to - body.range.from).toBeGreaterThan(6 * DAY);
    expect(body.range.to - body.range.from).toBeLessThan(7 * DAY);
    expect(body.totals).toEqual({ events: 0, installs: 0, sessions: 0, errors: 0, crashes: 0 });
    expect(body.timeline).toHaveLength(7);
    expect(body.timeline.at(-1).day).toBe(new Date().toISOString().slice(0, 10));
    expect(body).toMatchObject({ metrics: [], routes: [], errors: [], webVitals: [], versions: [], filters: { platforms: [], versions: [], environments: [] } });
  });

  it('summarizes totals, timeline, percentiles, routes, errors, web vitals and versions', async () => {
    await seed();
    const token = await adminToken();
    const body = (await (await overview(token, '?days=3')).json()) as any;

    expect(body.range.days).toBe(3);
    expect(body.filters).toEqual({ platforms: ['android', 'ios', 'web'], versions: ['1.7.1', '1.8.0', '1.8.1'], environments: ['preview', 'production', 'web'] });
    // 7 native and 4 web metric rows, 3 native and 1 web error; the 3 native logs share one session.
    expect(body.totals).toEqual({ events: 15, installs: 3, sessions: 6, errors: 4, crashes: 1 });
    expect(body.timeline).toHaveLength(3);
    expect(body.timeline.reduce((n: number, d: any) => n + d.errors, 0)).toBe(4);

    const tti = body.metrics.find((m: any) => m.name === 'expo.navigation.tti');
    expect(tti).toMatchObject({ category: 'navigation', count: 6, p50: 300, p75: 500, p95: 900 });
    expect(tti.avg).toBeCloseTo((100 + 200 + 300 + 400 + 500 + 900) / 6, 5);
    expect(body.metrics[0].name).toBe('expo.navigation.tti');
    expect(body.metrics.map((m: any) => m.count)).toEqual([...body.metrics.map((m: any) => m.count)].sort((a, b) => b - a));

    // Slowest first by p75 of the time-to-interactive metrics; the startup tti has no route and is not listed.
    expect(body.routes).toEqual([
      { route: '/p/[code]', count: 2, p50: 500, p75: 900 },
      { route: '/home', count: 4, p50: 200, p75: 300 },
    ]);

    expect(body.webVitals).toEqual([{ name: 'LCP', count: 4, p75: 3000, good: 2, needsImprovement: 1, poor: 1 }]);

    // Same type and top frames = one group even with different messages; the crash is its own group.
    expect(body.errors).toHaveLength(3);
    const group = body.errors.find((e: any) => e.name === 'TypeError' && e.count === 2 && e.versions.includes('1.7.1'));
    expect(group).toMatchObject({ installs: 2, crash: false, versions: expect.arrayContaining(['1.7.1', '1.8.1']) });
    expect(group.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(group.message).toMatch(/^second 222|^first 111$/);
    expect(group.firstSeen).toBeLessThanOrEqual(group.lastSeen);
    const crash = body.errors.find((e: any) => e.crash);
    expect(crash).toMatchObject({ name: 'Error', message: 'Fatal', count: 1, installs: 1, versions: ['1.8.1'] });
    expect(body.errors.map((e: any) => e.count)).toEqual([2, 1, 1]);

    expect(body.versions.map((v: any) => [v.version, v.platform])).toEqual(
      expect.arrayContaining([['1.8.1', 'android'], ['1.7.1', 'android'], ['1.8.1', 'ios'], ['1.8.0', 'web']]),
    );
    const v181 = body.versions.find((v: any) => v.version === '1.8.1' && v.platform === 'android');
    expect(v181).toMatchObject({ installs: 1, sessions: 2, errors: 1 });
    const lastSeen = body.versions.map((v: any) => v.lastSeen);
    expect(lastSeen).toEqual([...lastSeen].sort((a, b) => b - a));
  });

  it('lists the events the app logged, by count, with the installs that sent them', async () => {
    const token = await adminToken();
    const now = Date.now();
    const insert = (client: string, name: string) =>
      env.DB.prepare(
        `INSERT INTO obs_logs (ts, received_at, platform, app_version, environment, client, category, name, severity)
         VALUES (?, ?, 'android', '9.9.9', 'events-test', ?, 'event', ?, 'info')`,
      ).bind(now, now, client, name).run();
    try {
      for (const [client, name] of [['c1', 'item.created'], ['c1', 'item.created'], ['c2', 'item.created'], ['c1', 'order.placed']] as const) await insert(client, name);
      // an error is not an event
      await env.DB.prepare(`INSERT INTO obs_logs (ts, received_at, platform, app_version, environment, category, name, severity, error_type, fingerprint) VALUES (?, ?, 'android', '9.9.9', 'events-test', 'error', 'TypeError', 'error', 'TypeError', 'abcdef0123456789')`).bind(now, now).run();
      const body = (await (await overview(token, '?env=events-test')).json()) as any;
      expect(body.events).toEqual([
        { name: 'item.created', count: 3, installs: 2, lastSeen: now },
        { name: 'order.placed', count: 1, installs: 1, lastSeen: now },
      ]);
      expect(body.events.map((e: any) => e.name)).not.toContain('TypeError');
    } finally {
      await env.DB.prepare("DELETE FROM obs_logs WHERE environment = 'events-test'").run();
    }
  });

  it('filters by platform, version and environment, and validates the range', async () => {
    await seed();
    const token = await adminToken();
    const android = (await (await overview(token, '?platform=android')).json()) as any;
    expect(android.totals).toMatchObject({ installs: 2, errors: 2, crashes: 0 });
    // The filter lists keep showing every value present in the range.
    expect(android.filters.platforms).toEqual(['android', 'ios', 'web']);
    expect(android.webVitals).toEqual([]);

    const version = (await (await overview(token, '?version=1.7.1')).json()) as any;
    expect(version.totals).toMatchObject({ installs: 1, errors: 1 });
    expect(version.routes).toEqual([{ route: '/p/[code]', count: 2, p50: 500, p75: 900 }]);

    const preview = (await (await overview(token, '?env=preview&platform=android&version=1.7.1')).json()) as any;
    expect(preview.totals.installs).toBe(1);
    expect((await (await overview(token, '?env=nothing')).json() as any).totals.events).toBe(0);

    const web = (await (await overview(token, '?platform=web&days=30')).json()) as any;
    expect(web.timeline).toHaveLength(30);
    expect(web.webVitals).toHaveLength(1);
    expect(web.totals).toMatchObject({ installs: 0, errors: 1 });

    for (const days of ['0', '31', '-1', 'abc', '1.5', '', '1e1']) {
      const res = await overview(token, `?days=${days}`);
      expect(res.status, days).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_range' });
    }
    expect((await overview(token, '?days=30')).status).toBe(200);
    expect((await overview(token, '?days=1')).status).toBe(200);
  });

  it('leaves out data older than the range', async () => {
    const at = Date.now() - 20 * DAY;
    await sendNative('metrics', metricsBatch([{ name: 'expo.navigation.tti', seconds: 1, at, route: '/old' }]));
    expect(((await (await overview(await adminToken(), '?days=7')).json()) as any).totals.events).toBe(0);
    expect(((await (await overview(await adminToken(), '?days=30')).json()) as any).totals.events).toBe(1);
  });

  it('shows the occurrences of an error group, newest first, and 404 for an unknown one', async () => {
    const at = Date.now() - 60_000;
    for (let n = 0; n < 25; n++) {
      await sendNative('logs', jsException({ message: `failure ${n}`, stack: hermesStack(n + 1, 1), at: at + n }, resource({ clientId: `c${n}`, version: n % 2 ? '1.8.1' : '1.7.1' })), {});
    }
    const token = await adminToken();
    const { errors } = (await (await overview(token)).json()) as any;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ count: 25, installs: 25, name: 'TypeError' });

    const res = await api(`/errors/${errors[0].fingerprint}`, { token });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as any;
    expect(detail).toMatchObject({ fingerprint: errors[0].fingerprint, name: 'TypeError' });
    expect(detail.occurrences).toHaveLength(20);
    expect(detail.occurrences.map((o: any) => o.ts)).toEqual(Array.from({ length: 20 }, (_, n) => at + 24 - n));
    expect(detail.occurrences[0]).toEqual({
      ts: at + 24,
      platform: 'android',
      appVersion: '1.7.1',
      environment: 'production',
      route: null,
      message: 'failure 24',
      stack: expect.stringContaining('at renderRecord'),
    });

    expect((await api('/errors/0123456789abcdef', { token })).status).toBe(404);
    expect(await (await api('/errors/0123456789abcdef', { token })).json()).toEqual({ error: 'not_found' });
    expect((await api('/errors/not-a-fingerprint', { token })).status).toBe(404);
  });
});
