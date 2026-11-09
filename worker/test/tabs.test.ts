// The tabs of the dashboard beyond the overview: navigation, updates, metrics, events, traces (src/routes/read-tabs.ts).
// Rows go in through the real ingest, like in ingest.test.ts.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nestSpans } from '../src/routes/read-tabs';
import { ADMIN_TOKEN, api, BASE, PROJECT_ID_1 } from './helpers';
import { jsException, logsBatch, metricsBatch, resource, s, tracesBatch, webBatch } from './fixtures';

const PROJECT = PROJECT_ID_1;
const db = env.DB;
const DAY = 24 * 60 * 60 * 1000;
const TABLES = ['obs_batches', 'obs_metrics', 'obs_logs', 'obs_spans', 'obs_limits'] as const;

let ipSeq = 0;
const send = (path: string, body: unknown) =>
  SELF.fetch(`${BASE}/observe/${PROJECT}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++ipSeq % 250}` },
    body: JSON.stringify(body),
  });
const sendNative = async (kind: 'metrics' | 'logs' | 'traces', body: unknown) => {
  const res = await send(`v1/${kind}`, body);
  expect(res.status).toBe(200);
};
const sendWeb = async (body: unknown) => expect((await send('web', body)).status).toBe(204);

beforeEach(async () => {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  vi.stubGlobal('fetch', async () => {
    throw new Error('network is off in tests');
  });
});
afterEach(() => vi.unstubAllGlobals());

const adminToken = async () => ADMIN_TOKEN;
const get = async <T = any>(path: string, query = ''): Promise<T> => {
  const res = await api(`/${path}${query}`, { token: await adminToken() });
  expect(res.status, `${path}${query}`).toBe(200);
  return (await res.json()) as T;
};

const view = (route: string, at: number, session: string) => ({
  event: 'screen.view',
  at,
  attributes: [s('session.id', session), s('route', route)],
});

describe('read API tabs: access and empty database', () => {
  const PATHS = ['navigation', 'updates', 'metrics', 'events', 'traces', 'traces?trace=0af7651916cd43dd8448eb211c803190'];

  it('needs the admin token', async () => {
    for (const path of PATHS) {
      expect((await api(`/${path}`)).status, path).toBe(401);
      const res = await api(`/${path}`, { token: 'not-the-admin-token' });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
  });

  it('answers an empty database with empty lists, the filter lists and every day of the range', async () => {
    const empty = { filters: { platforms: [], versions: [], environments: [] } };
    expect(await get('navigation')).toMatchObject({ ...empty, routes: [], transitions: [] });
    expect(await get('updates')).toMatchObject({ ...empty, installs: 0, updates: [] });
    expect(await get('metrics')).toMatchObject({ ...empty, metrics: [], selected: null });
    const events = await get('events');
    expect(events).toMatchObject({ ...empty, events: [], occurrences: [] });
    expect(events.series).toHaveLength(7);
    expect(events.range.days).toBe(7);
    expect(await get('traces')).toMatchObject({ ...empty, groups: [], slowest: [], failed: [] });
    const missing = await api('/traces?trace=0af7651916cd43dd8448eb211c803190', { token: await adminToken() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('validates the range like the overview', async () => {
    const token = await adminToken();
    for (const path of ['navigation', 'updates', 'metrics', 'events', 'traces']) {
      for (const days of ['0', '31', 'abc', '']) {
        const res = await api(`/${path}?days=${days}`, { token });
        expect(res.status, `${path} ${days}`).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_range' });
      }
      expect((await api(`/${path}?days=30`, { token })).status).toBe(200);
    }
  });
});

describe('read API tabs: navigation', () => {
  async function seed() {
    const at = Date.now() - 60_000;
    const android = resource({ clientId: 'install-a' });
    const ios = resource({ platform: 'ios', clientId: 'install-c', version: '1.7.1' });
    // Session s1 walks /home -> /p/[code] -> /home -> /p/[code], session s2 /home -> /p/[code], session s3 (iOS) only /home.
    await sendNative(
      'logs',
      logsBatch(
        [
          view('/home', at, 's1'),
          view('/p/[code]', at + 1, 's1'),
          view('/home', at + 2, 's1'),
          view('/p/[code]', at + 3, 's1'),
          view('/home', at + 4, 's2'),
          view('/p/[code]', at + 5, 's2'),
          view('/home', at + 6, 's2'),
        ],
        android,
      ),
    );
    await sendNative('logs', logsBatch([view('/home', at + 7, 's3'), view('/home', at + 8, 's3')], ios));
    await sendNative(
      'metrics',
      metricsBatch([0.1, 0.2, 0.3, 0.4].map((seconds, n) => ({ name: 'expo.navigation.tti', seconds, at: at + n, route: '/home', session: 's1' })), android),
    );
    await sendNative(
      'metrics',
      metricsBatch(
        [
          { name: 'expo.navigation.tti', seconds: 0.5, at: at + 10, route: '/p/[code]', session: 's9' },
          { name: 'expo.navigation.tti', seconds: 0.9, at: at + 11, route: '/p/[code]', session: 's9' },
          { name: 'expo.navigation.cold_ttr', seconds: 0.25, at: at + 12, route: '/p/[code]', session: 's9' },
          // not a navigation metric: never listed per route
          { name: 'expo.app_startup.tti', seconds: 3, at: at + 13, route: '/p/[code]', session: 's9' },
        ],
        android,
      ),
    );
    await sendWeb(webBatch([{ t: 'vital', name: 'LCP', value: 2000, ts: at }, { t: 'error', name: 'TypeError', message: 'boom', ts: at }], { route: '/settings', session: 'w1' }));
  }

  it('lists views, sessions, load times and errors per route, busiest first', async () => {
    await seed();
    const body = await get('navigation');
    expect(body.filters.platforms).toEqual(['android', 'ios', 'web']);
    expect(body.routes.map((r: any) => r.route)).toEqual(['/home', '/p/[code]', '/settings']);
    const [home, code, settings] = body.routes;
    // /home: 3 + 1 views by android... s1 twice, s2 twice, s3 twice
    expect(home).toMatchObject({ route: '/home', views: 6, errors: 0 });
    // sessions of the views (s1, s2, s3) and of the measurements (s1)
    expect(home.sessions).toBe(3);
    expect(home.metrics).toEqual([{ name: 'expo.navigation.tti', category: 'navigation', count: 4, p50: 200, p75: 300, p95: 400 }]);
    expect(code).toMatchObject({ route: '/p/[code]', views: 3, sessions: 3 });
    expect(code.metrics).toEqual([
      { name: 'expo.navigation.tti', category: 'navigation', count: 2, p50: 500, p75: 900, p95: 900 },
      { name: 'expo.navigation.cold_ttr', category: 'navigation', count: 1, p50: 250, p75: 250, p95: 250 },
    ]);
    expect(settings).toMatchObject({ route: '/settings', views: 0, sessions: 1, errors: 1 });
    expect(settings.metrics).toEqual([{ name: 'LCP', category: 'web_vital', count: 1, p50: 2000, p75: 2000, p95: 2000 }]);
  });

  it('counts the moves between screens within a session, most frequent first, and never a screen to itself', async () => {
    await seed();
    const { transitions } = await get('navigation');
    // s1: home>p, p>home, home>p; s2: home>p, p>home; s3: home>home (not a move)
    expect(transitions).toEqual([
      { from: '/home', to: '/p/[code]', count: 3 },
      { from: '/p/[code]', to: '/home', count: 2 },
    ]);
  });

  it('applies the platform, version and environment filters and the range', async () => {
    await seed();
    const ios = await get('navigation', '?platform=ios');
    expect(ios.routes).toEqual([{ route: '/home', views: 2, sessions: 1, errors: 0, metrics: [] }]);
    expect(ios.transitions).toEqual([]);
    expect(ios.filters.platforms).toEqual(['android', 'ios', 'web']);
    expect((await get('navigation', '?version=1.7.1')).routes.map((r: any) => r.views)).toEqual([2]);
    expect((await get('navigation', '?env=nothing')).routes).toEqual([]);
    expect((await get('navigation', '?platform=web')).routes.map((r: any) => r.route)).toEqual(['/settings']);
  });

  it('leaves out data older than the range', async () => {
    const at = Date.now() - 20 * DAY;
    await sendNative('logs', logsBatch([view('/old', at, 'x')]));
    expect((await get('navigation', '?days=7')).routes).toEqual([]);
    expect((await get('navigation', '?days=30')).routes).toMatchObject([{ route: '/old', views: 1 }]);
  });
});

describe('read API tabs: updates', () => {
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';

  async function seed() {
    const t = Date.now() - 3 * 60 * 60 * 1000;
    const on = (clientId: string, updateId: string | null, version = '1.8.1') => resource({ clientId, updateId, version });
    // install a runs U1, then U2; install b stays on U1; install c runs the embedded update of 1.8.0 and fails once in session sx.
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at: t, session: 'a1' }], on('a', U1)));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at: t + 1000, session: 'b1' }, { name: 'expo.navigation.tti', seconds: 1, at: t + 1001, session: 'b1', route: '/home' }], on('b', U1)));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at: t + 60_000, session: 'a2' }], on('a', U2)));
    await sendNative('logs', jsException({ message: 'x', at: t + 61_000, extra: [s('session.id', 'a2')] }, on('a', U2)));
    await sendNative('logs', jsException({ message: 'fatal', fatal: true, at: t + 120_000, extra: [s('session.id', 'cx')] }, on('c', null, '1.8.0')));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at: t + 121_000, session: 'cy' }], on('c', null, '1.8.0')));
  }

  it('groups by platform, version and update, newest first, with the rates and the adoption of the latest update per install', async () => {
    await seed();
    const body = await get('updates');
    expect(body.installs).toBe(3);
    expect(body.updates.map((u: any) => [u.updateId, u.appVersion])).toEqual([
      [null, '1.8.0'],
      [U2, '1.8.1'],
      [U1, '1.8.1'],
    ]);
    const [embedded, second, first] = body.updates;
    expect(second).toMatchObject({
      platform: 'android',
      installs: 1,
      currentInstalls: 1,
      sessions: 1,
      events: 2,
      errors: 1,
      crashes: 0,
      errorSessions: 1,
      errorRate: 1,
    });
    expect(second.adoption).toBeCloseTo(1 / 3, 10);
    // U1 was seen on two installs, but only b still runs it
    expect(first).toMatchObject({ installs: 2, currentInstalls: 1, sessions: 2, events: 3, errors: 0, errorSessions: 0, errorRate: 0 });
    expect(first.adoption).toBeCloseTo(1 / 3, 10);
    expect(embedded).toMatchObject({ updateId: null, installs: 1, currentInstalls: 1, sessions: 2, events: 2, errors: 1, crashes: 1, errorSessions: 1, errorRate: 0.5 });
    expect(body.updates.reduce((n: number, u: any) => n + u.adoption, 0)).toBeCloseTo(1, 10);
    for (const u of body.updates) expect(u.firstSeen).toBeLessThanOrEqual(u.lastSeen);
    expect(body.updates.map((u: any) => u.lastSeen)).toEqual([...body.updates.map((u: any) => u.lastSeen)].sort((a, b) => b - a));
    expect(first.firstSeen).toBeLessThan(second.firstSeen);
  });

  it('applies the filters: the shares are those of the filtered installs', async () => {
    await seed();
    const body = await get('updates', '?version=1.8.1');
    expect(body.installs).toBe(2);
    expect(body.updates.map((u: any) => u.updateId)).toEqual([U2, U1]);
    expect(body.updates.map((u: any) => u.adoption)).toEqual([0.5, 0.5]);
    expect((await get('updates', '?platform=ios')).updates).toEqual([]);
    expect(body.filters.versions).toEqual(['1.8.0', '1.8.1']);
  });

  it('separates platforms: the same update id on Android and iOS are two rows', async () => {
    const at = Date.now() - 1000;
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at }], resource({ clientId: 'x', updateId: U1 })));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 1, at }], resource({ platform: 'ios', clientId: 'y', updateId: U1 })));
    expect((await get('updates')).updates.map((u: any) => [u.platform, u.installs]).sort()).toEqual([['android', 1], ['ios', 1]]);
  });

  it('counts rows without an install in the events but not in the adoption (web)', async () => {
    await sendWeb(webBatch([{ t: 'vital', name: 'LCP', value: 1000, ts: Date.now() - 1000 }]));
    const body = await get('updates');
    expect(body.installs).toBe(0);
    expect(body.updates).toMatchObject([{ platform: 'web', updateId: null, events: 1, installs: 0, currentInstalls: 0, adoption: 0 }]);
  });
});

describe('read API tabs: metrics', () => {
  async function seed() {
    const at = Date.now() - 60_000;
    const android = resource({ clientId: 'install-a' });
    await sendNative('metrics', metricsBatch([0.1, 0.2, 0.3, 0.4, 0.5, 0.9].map((seconds, n) => ({ name: 'expo.navigation.tti', seconds, at: at + n, route: '/home' })), android));
    await sendNative('metrics', metricsBatch([{ name: 'expo.app_startup.tti', seconds: 3, at: at + 10 }], resource({ platform: 'ios', clientId: 'install-c' })));
    await sendNative('metrics', metricsBatch([{ name: 'expo.unknown.memory_usage', seconds: 100, at: at + 11 }, { name: 'expo.unknown.memory_usage', seconds: 300, at: at + 12 }], android));
    await sendWeb(webBatch([1000, 3000, 5000, 2000].map((value, n) => ({ t: 'vital', name: 'LCP', value, ts: at + n }))));
  }

  it('lists every metric with count, average, extremes and nearest-rank percentiles', async () => {
    await seed();
    const { metrics } = await get('metrics');
    expect(metrics.map((m: any) => [m.category, m.name, m.count])).toEqual([
      ['navigation', 'expo.navigation.tti', 6],
      ['web_vital', 'LCP', 4],
      ['unknown', 'expo.unknown.memory_usage', 2],
      ['app_startup', 'expo.app_startup.tti', 1],
    ]);
    const tti = metrics[0];
    expect(tti).toMatchObject({ min: 100, max: 900, p50: 300, p75: 500, p95: 900 });
    expect(tti.avg).toBeCloseTo((100 + 200 + 300 + 400 + 500 + 900) / 6, 5);
    expect(metrics[1]).toMatchObject({ min: 1000, max: 5000, p50: 2000, p75: 3000, p95: 5000 });
    // unitless value, stored as sent
    expect(metrics[2]).toMatchObject({ min: 100, max: 300, p50: 100, p75: 300 });
  });

  it('filters like the overview', async () => {
    await seed();
    expect((await get('metrics', '?platform=ios')).metrics.map((m: any) => m.name)).toEqual(['expo.app_startup.tti']);
    expect((await get('metrics', '?platform=web')).metrics.map((m: any) => m.name)).toEqual(['LCP']);
    expect((await get('metrics', '?version=9.9')).metrics).toEqual([]);
  });

  it('adds the daily series of one metric, every day of the range, percentiles per day', async () => {
    await seed();
    const body = await get('metrics', '?days=3&name=expo.navigation.tti');
    expect(body.metrics).toHaveLength(4);
    expect(body.selected.name).toBe('expo.navigation.tti');
    expect(body.selected.series).toHaveLength(3);
    const days = body.selected.series.map((d: any) => d.day);
    expect(days.at(-1)).toBe(new Date().toISOString().slice(0, 10));
    // the seed is a minute old: today, or yesterday when the test runs in the first minute after midnight UTC
    expect(body.selected.series.reduce((n: number, d: any) => n + d.count, 0)).toBe(6);
    const day = body.selected.series.find((d: any) => d.count > 0);
    expect(day).toMatchObject({ count: 6, p50: 300, p75: 500, p95: 900 });
  });

  it('puts old rows on their own day and picks a metric by category when the name is shared', async () => {
    const day = (n: number) => Math.floor((Date.now() - n * DAY) / DAY) * DAY + 12 * 60 * 60 * 1000;
    const insert = (ts: number, category: string, value: number, platform = 'android') =>
      db.prepare(`INSERT INTO obs_metrics (ts, received_at, platform, app_version, environment, category, name, value) VALUES (?, ?, ?, '1.0.0', 'production', ?, 'shared', ?)`)
        .bind(ts, Date.now(), platform, category, value).run();
    await insert(day(2), 'other', 10);
    await insert(day(2), 'other', 30);
    await insert(day(1), 'other', 50);
    await insert(day(2), 'web_nav', 999, 'web');
    const all = await get('metrics', '?days=3&name=shared');
    expect(all.selected.series.map((d: any) => d.count)).toEqual([3, 1, 0]);
    const other = await get('metrics', '?days=3&name=shared&category=other');
    expect(other.selected).toMatchObject({ name: 'shared', category: 'other' });
    expect(other.selected.series[0]).toMatchObject({ count: 2, p50: 10, p75: 30, p95: 30 });
    expect(other.selected.series.map((d: any) => d.count)).toEqual([2, 1, 0]);
    expect(other.selected.series[1]).toMatchObject({ p50: 50 });
    const nav = await get('metrics', '?days=3&name=shared&category=web_nav');
    expect(nav.selected.series[0]).toMatchObject({ count: 1, p50: 999 });
    const none = await get('metrics', '?name=does-not-exist');
    expect(none.selected.series.every((d: any) => d.count === 0)).toBe(true);
  });
});

describe('read API tabs: events', () => {
  const insert = (o: { ts?: number; client?: string | null; session?: string | null; name: string; route?: string | null; attrs?: object | string | null; version?: string; platform?: string; category?: string }) =>
    db
      .prepare(
        `INSERT INTO obs_logs (ts, received_at, platform, app_version, environment, client, session_id, category, name, route, severity, attrs)
         VALUES (?, ?, ?, ?, 'events-test', ?, ?, ?, ?, ?, 'info', ?)`,
      )
      .bind(
        o.ts ?? Date.now(), Date.now(), o.platform ?? 'android', o.version ?? '9.9.9', o.client ?? null, o.session ?? null, o.category ?? 'event',
        o.name, o.route ?? null, o.attrs === undefined || o.attrs === null ? null : typeof o.attrs === 'string' ? o.attrs : JSON.stringify(o.attrs),
      )
      .run();

  it('lists the events by count with installs and sessions, and a daily series of all events', async () => {
    const now = Date.now();
    for (const [client, session, name] of [['c1', 's1', 'item.created'], ['c1', 's2', 'item.created'], ['c2', 's3', 'item.created'], ['c1', 's1', 'order.placed']] as const) {
      await insert({ client, session, name, ts: now });
    }
    await insert({ name: 'item.created', ts: now - 2 * DAY, client: 'c3', session: 's4' });
    // an error and a crash are not events
    await insert({ name: 'TypeError', category: 'error' });
    const body = await get('events', '?env=events-test&days=3');
    expect(body.events).toEqual([
      { name: 'item.created', count: 4, installs: 3, sessions: 4, firstSeen: now - 2 * DAY, lastSeen: now },
      { name: 'order.placed', count: 1, installs: 1, sessions: 1, firstSeen: now, lastSeen: now },
    ]);
    expect(body.series).toHaveLength(3);
    expect(body.series.map((d: any) => [d.count, d.installs])).toEqual([[1, 1], [0, 0], [4, 2]]);
    expect(body.occurrences).toEqual([]);
  });

  it('with a name: the series of that event and its latest 100 occurrences with route, version and scrubbed attributes', async () => {
    const now = Date.now();
    for (let n = 0; n < 105; n++) {
      await insert({ name: 'item.created', ts: now - 10_000 + n, client: `c${n}`, route: n === 104 ? null : '/home', attrs: { kind: 'basic', n }, version: n % 2 ? '9.9.9' : '9.9.8' });
    }
    await insert({ name: 'order.placed', ts: now, attrs: { ok: true } });
    const body = await get('events', '?env=events-test&name=item.created');
    expect(body.events.map((e: any) => [e.name, e.count])).toEqual([['item.created', 105], ['order.placed', 1]]);
    expect(body.series.reduce((n: number, d: any) => n + d.count, 0)).toBe(105);
    expect(body.occurrences).toHaveLength(100);
    expect(body.occurrences.map((o: any) => o.ts)).toEqual(Array.from({ length: 100 }, (_, n) => now - 10_000 + 104 - n));
    expect(body.occurrences[0]).toEqual({ ts: now - 10_000 + 104, platform: 'android', appVersion: '9.9.8', environment: 'events-test', route: null, attrs: { kind: 'basic', n: 104 } });
    expect(body.occurrences[1]).toMatchObject({ route: '/home', appVersion: '9.9.9', attrs: { kind: 'basic', n: 103 } });
  });

  it('reads the route of a screen.view from its attribute, and tolerates missing or broken attributes', async () => {
    const now = Date.now();
    await insert({ name: 'screen.view', ts: now, attrs: { route: '/home' } });
    await insert({ name: 'screen.view', ts: now - 1, attrs: '{not json' });
    await insert({ name: 'screen.view', ts: now - 2, attrs: null, route: '/native' });
    await insert({ name: 'screen.view', ts: now - 3, attrs: '[1,2]' });
    const body = await get('events', '?env=events-test&name=screen.view');
    expect(body.occurrences.map((o: any) => [o.route, o.attrs])).toEqual([['/home', { route: '/home' }], [null, {}], ['/native', {}], [null, {}]]);
  });

  it('stores nothing personal: attributes come out as the ingest scrubbed them', async () => {
    const at = Date.now() - 1000;
    await sendNative(
      'logs',
      logsBatch([{ event: 'item.created', at, attributes: [s('kind', 'basic'), s('email', 'alex@example.com'), s('token', 'abc123'), s('where', 'https://app.example.com/p/ABC123?token=secret#x'), s('note', 'mail alex@example.com')] }]),
    );
    const { occurrences } = await get('events', '?name=item.created');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].attrs).toMatchObject({ kind: 'basic' });
    const text = JSON.stringify(occurrences);
    expect(text).not.toContain('alex@example.com');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('secret');
  });

  it('filters by platform, version and environment', async () => {
    await insert({ name: 'a', platform: 'ios', version: '1.0.0' });
    await insert({ name: 'b', platform: 'android', version: '2.0.0' });
    expect((await get('events', '?env=events-test&platform=ios')).events.map((e: any) => e.name)).toEqual(['a']);
    expect((await get('events', '?env=events-test&version=2.0.0')).events.map((e: any) => e.name)).toEqual(['b']);
    expect((await get('events', '?env=other')).events).toEqual([]);
    expect((await get('events', '?env=events-test&name=a&platform=android')).occurrences).toEqual([]);
  });
});

describe('read API tabs: traces', () => {
  const T1 = '0af7651916cd43dd8448eb211c803101';
  const T2 = '0af7651916cd43dd8448eb211c803102';
  const T3 = '0af7651916cd43dd8448eb211c803103';
  const sp = (n: number) => `b7ad6b71692033${String(n).padStart(2, '0')}`;

  async function seed() {
    const at = Date.now() - 60_000;
    // T1 (1000 ms): root, two children (the second failed), one grandchild. T2: fast and ok. T3: a 500 answer.
    await sendNative(
      'traces',
      tracesBatch([
        { name: 'GET', at, ms: 1000, traceId: T1, spanId: sp(1), status: 200 },
        { name: 'POST', at: at + 100, ms: 300, traceId: T1, spanId: sp(2), parentSpanId: sp(1), status: 201 },
        { name: 'GET', at: at + 150, ms: 100, traceId: T1, spanId: sp(3), parentSpanId: sp(2), status: 200 },
        { name: 'GET', at: at + 500, ms: 400, traceId: T1, spanId: sp(4), parentSpanId: sp(1), failed: true, status: 0 },
        { name: 'GET', at: at + 2000, ms: 50, traceId: T2, spanId: sp(5), status: 200 },
        { name: 'GET', at: at + 3000, ms: 150, traceId: T3, spanId: sp(6), status: 500 },
      ]),
    );
    await sendNative('traces', tracesBatch([{ name: 'GET', at: at + 4000, ms: 20, traceId: T2, spanId: sp(7), parentSpanId: sp(5), status: 404 }], resource({ platform: 'ios', clientId: 'ios-1', version: '1.7.1' })));
  }

  it('groups spans by name and target with percentiles, the error share and the HTTP status histogram', async () => {
    await seed();
    const { groups } = await get('traces');
    expect(groups.map((g: any) => [g.name, g.target, g.count])).toEqual([['GET', 'app.example.com', 6], ['POST', 'app.example.com', 1]]);
    const get_ = groups[0];
    // durations 1000 100 400 50 150 20 -> sorted 20 50 100 150 400 1000
    expect(get_).toMatchObject({ p50: 100, p95: 1000, max: 1000, errors: 3 });
    expect(get_.errorShare).toBe(0.5);
    // the failed span has status 0 in the batch (not an HTTP status), so it is not in the histogram
    expect(get_.statuses).toEqual([{ status: 200, count: 3 }, { status: 404, count: 1 }, { status: 500, count: 1 }]);
    expect(groups[1]).toMatchObject({ count: 1, errors: 0, errorShare: 0, p50: 300, statuses: [{ status: 201, count: 1 }] });
  });

  it('lists the slowest traces and the latest failed ones, with the root span and the extent of the trace', async () => {
    await seed();
    const { slowest, failed } = await get('traces');
    expect(slowest.map((t: any) => t.traceId)).toEqual([T2, T1, T3]);
    expect(slowest[1]).toMatchObject({ traceId: T1, name: 'GET', platform: 'android', appVersion: '1.8.1', durationMs: 1000, spans: 4, errors: 1 });
    // T2 is a fast android span and an iOS child 2 s later: the extent runs from the first start to the last end (the slowest trace)
    expect(slowest[0]).toMatchObject({ traceId: T2, durationMs: 2020, spans: 2, errors: 1 });
    expect(slowest[2]).toMatchObject({ traceId: T3, durationMs: 150, spans: 1, errors: 1 });
    expect(failed.map((t: any) => t.traceId)).toEqual([T3, T2, T1]);
    expect(failed.map((t: any) => t.start)).toEqual([...failed.map((t: any) => t.start)].sort((a, b) => b - a));
  });

  it('returns at most 50 traces in each list', async () => {
    const at = Date.now() - 1000;
    const spans = Array.from({ length: 60 }, (_, n) => ({ name: 'GET', at: at - n, ms: n + 1, traceId: `ab${String(n).padStart(30, '0')}`, spanId: `cd${String(n).padStart(14, '0')}`, failed: true }));
    for (let i = 0; i < spans.length; i += 30) await sendNative('traces', tracesBatch(spans.slice(i, i + 30)));
    const body = await get('traces');
    expect(body.slowest).toHaveLength(50);
    expect(body.failed).toHaveLength(50);
    expect(body.slowest[0].durationMs).toBe(60);
    expect(body.groups[0]).toMatchObject({ count: 60, errors: 60, errorShare: 1 });
  });

  it('applies the filters and the range', async () => {
    await seed();
    const ios = await get('traces', '?platform=ios');
    expect(ios.groups).toMatchObject([{ count: 1, errors: 1, statuses: [{ status: 404, count: 1 }] }]);
    expect(ios.slowest.map((t: any) => t.traceId)).toEqual([T2]);
    expect(ios.slowest[0]).toMatchObject({ spans: 1, durationMs: 20 });
    expect(ios.filters.platforms).toEqual(['android', 'ios']);
    expect((await get('traces', '?version=1.7.1')).groups).toHaveLength(1);
    expect((await get('traces', '?env=none')).groups).toEqual([]);
    await db.prepare('UPDATE obs_spans SET ts = ts - ?').bind(10 * DAY).run();
    expect((await get('traces', '?days=7')).groups).toEqual([]);
    expect((await get('traces', '?days=30')).groups.length).toBeGreaterThan(0);
  });

  it('returns one trace with its spans nested and their durations and offsets', async () => {
    await seed();
    const body = await get('traces', `?trace=${T1.toUpperCase()}`);
    expect(body).toMatchObject({ traceId: T1, durationMs: 1000, spans: 4, platform: 'android', appVersion: '1.8.1', environment: 'production' });
    expect(body.roots).toHaveLength(1);
    const root = body.roots[0];
    expect(root).toMatchObject({ spanId: sp(1), parentId: null, name: 'GET', target: 'app.example.com', offsetMs: 0, durationMs: 1000, httpStatus: 200, status: 'unset' });
    expect(root.children.map((c: any) => [c.spanId, c.name, c.offsetMs, c.durationMs, c.status])).toEqual([
      [sp(2), 'POST', 100, 300, 'unset'],
      [sp(4), 'GET', 500, 400, 'error'],
    ]);
    expect(root.children[0].children).toMatchObject([{ spanId: sp(3), offsetMs: 150, durationMs: 100, children: [] }]);
    // the query and the path are never stored: the target is the host
    expect(JSON.stringify(body)).not.toMatch(/token|abc123|0f8fad5b/);
  });

  it('404 for an unknown trace and for a trace id that is not hex', async () => {
    await seed();
    const token = await adminToken();
    for (const trace of ['0af7651916cd43dd8448eb211c803199', 'nope', '', 'zz'.repeat(16)]) {
      const res = await api(`/traces?trace=${trace}`, { token });
      expect(res.status, trace).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('makes a span without a known parent, a loop and a duplicate harmless', async () => {
    const at = Date.now() - 1000;
    const insert = (spanId: string, parentId: string | null, ts: number) =>
      db.prepare(`INSERT INTO obs_spans (ts, received_at, trace_id, span_id, parent_id, name, duration_ms, status, platform, app_version, environment) VALUES (?, ?, ?, ?, ?, 'x', 10, 'ok', 'android', '1', 'production')`)
        .bind(ts, at, T3, spanId, parentId).run();
    await insert('aa'.repeat(8), 'ee'.repeat(8), at); // parent never arrived
    await insert('bb'.repeat(8), 'cc'.repeat(8), at + 1); // b <-> c loop
    await insert('cc'.repeat(8), 'bb'.repeat(8), at + 2);
    await insert('dd'.repeat(8), 'dd'.repeat(8), at + 3); // its own parent
    await insert('aa'.repeat(8), null, at + 4); // the same span stored twice
    const body = await get('traces', `?trace=${T3}`);
    expect(body.spans).toBe(4);
    const ids: string[] = [];
    const walk = (nodes: any[]) => nodes.forEach((n) => (ids.push(n.spanId), walk(n.children)));
    walk(body.roots);
    expect(ids.sort()).toEqual(['aa', 'bb', 'cc', 'dd'].map((x) => x.repeat(8)));
    expect(() => JSON.stringify(body)).not.toThrow();
    expect(nestSpans([], 0)).toEqual([]);
  });

  it('has the indexes the queries need', async () => {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'obs_spans'").all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['obs_spans_ts', 'obs_spans_trace']));
    const plan = (sql: string, ...bind: unknown[]) =>
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bind).all<{ detail: string }>().then((r) => r.results.map((x) => x.detail).join(' | '));
    expect(await plan('SELECT * FROM obs_spans WHERE trace_id = ?', 'a')).toContain('obs_spans_trace');
    expect(await plan('SELECT * FROM obs_spans WHERE ts >= ?', 1)).toContain('obs_spans_ts');
  });
});
