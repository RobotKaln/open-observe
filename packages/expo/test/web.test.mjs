// Tests of the web collector of @open-observe/expo: logic only, with a fake browser (no DOM, no React Native).
// Run with `npm test` in packages/expo (node runs the TypeScript sources directly).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollector } from '../src/web/collector.ts';
import { isObserveEnabled, setObserveEnabled, subscribeObserveEnabled } from '../src/gate.ts';
import {
  DEFAULT_POLICY, EventQueue, INTERACTIVE_EVENT, MAX_BATCH, MAX_BODY_BYTES, MAX_QUEUE, MIRROR_HEADER, OFF_KEY, RENDER_EVENT,
  acceptRoute, browserLabel, createPolicy, describeError, diagnosticsBodies, endpointBase, isOptedOut, routeTemplate,
  sanitizeEvent, stripUrlTails, toOtlpLogs, toOtlpMetrics, viewportLabel, vitalRating,
} from '../src/web/protocol.ts';

const PROJECT = '3f2b8c1e-5d4a-4e6b-9a7c-0d1e2f3a4b5c';
// what an app would put in extra.openObserve.web
const POLICY = createPolicy({
  events: ['user.signed_in', 'checkout.completed'],
  enums: { plan: ['free', 'pro'] },
  flags: ['created'],
  numbers: ['items'],
  labels: ['coupon'],
  routeSegments: ['index', 'sign-in', 'settings', 'account', 'p'],
});
const metadata = { sessionId: '00000000-0000-4000-8000-000000000001', clientId: '00000000-0000-4000-8000-000000000002', version: '1.8.1', environment: 'production' };

// --- a fake browser -----------------------------------------------------------------------------------------------------

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== fn)); },
    emit(type, event = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    count(type) { return (listeners.get(type) ?? []).length; },
  };
}

function browser(overrides = {}) {
  const observers = [];
  class PerformanceObserver {
    constructor(callback) { this.callback = callback; this.options = null; }
    observe(options) { this.options = options; observers.push(this); }
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  }
  const win = Object.assign(target(), { innerWidth: 394, innerHeight: 843 });
  const doc = Object.assign(target(), { visibilityState: 'visible', readyState: 'complete' });
  const requests = [];
  const timers = [];
  let stored = {};
  const env = {
    window: win, document: doc,
    performance: { now: () => 1234, getEntriesByType: () => [] },
    PerformanceObserver,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', connection: { effectiveType: '4g' } },
    storage: () => ({ getItem: (k) => stored[k] ?? null }),
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 200 }; },
    Blob: class { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    ...overrides,
  };
  return {
    env, win, doc, requests, timers, observers,
    store(values) { stored = values; },
    emit(type, entries) { for (const o of observers.filter((x) => x.options.type === type)) o.callback({ getEntries: () => entries }); },
    hide() { doc.visibilityState = 'hidden'; doc.emit('visibilitychange'); },
    bodies(path) { return requests.filter((r) => r.url.endsWith(path)).map((r) => JSON.parse(r.init.body)); },
  };
}

const NAVIGATION = [{ startTime: 0, responseStart: 180.26, loadEventEnd: 2410.04 }];
const withNavigation = (b) => { b.env.performance.getEntriesByType = () => NAVIGATION; return b; };

let clock = 1_794_146_900_000;
function collector(b, options = {}) {
  const c = createCollector({ projectId: PROJECT, appVersion: '1.8.1', environment: 'web', env: b.env, now: () => clock++, random: () => 0.5, policy: POLICY, ...options });
  c.setRoute('/p/[code]');
  c.start();
  return c;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

// --- Web Vitals ---------------------------------------------------------------------------------------------------------

test('vital ratings follow the web-vitals thresholds', () => {
  const cases = { LCP: [2500, 4000], FCP: [1800, 3000], CLS: [0.1, 0.25], INP: [200, 500], TTFB: [800, 1800] };
  for (const [name, [good, poor]] of Object.entries(cases)) {
    assert.equal(vitalRating(name, good), 'good', name);
    assert.equal(vitalRating(name, good * 1.01), 'needs-improvement', name);
    assert.equal(vitalRating(name, poor), 'needs-improvement', name);
    assert.equal(vitalRating(name, poor * 1.01), 'poor', name);
  }
});

test('FCP, TTFB and page load are reported at once; LCP, CLS and INP when the page is hidden, each once', async () => {
  const b = withNavigation(browser());
  const c = collector(b);
  b.emit('paint', [{ name: 'first-paint', startTime: 300 }, { name: 'first-contentful-paint', startTime: 412.34 }]);
  b.emit('largest-contentful-paint', [{ startTime: 900 }, { startTime: 1832.44 }]);
  b.emit('layout-shift', [{ startTime: 100, value: 0.05 }, { startTime: 400, value: 0.04 }, { startTime: 700, value: 0.9, hadRecentInput: true }]);
  b.emit('event', [{ interactionId: 0, duration: 900 }, { interactionId: 7, duration: 120 }, { interactionId: 7, duration: 304 }, { interactionId: 9, duration: 48 }]);
  assert.equal(b.requests.length, 0, 'nothing is sent before the page goes away or the timer fires');
  b.hide();
  await settle();
  const [payload, ...more] = b.bodies('/web');
  assert.equal(more.length, 0);
  const byName = Object.fromEntries(payload.events.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ['CLS', 'FCP', 'INP', 'LCP', 'TTFB', 'page_load']);
  assert.deepEqual([byName.FCP.t, byName.FCP.value, byName.FCP.rating], ['vital', 412.3, 'good']);
  assert.deepEqual([byName.LCP.value, byName.LCP.rating], [1832.4, 'good']);
  assert.deepEqual([byName.CLS.value, byName.CLS.rating], [0.09, 'good']);
  assert.deepEqual([byName.INP.value, byName.INP.rating], [304, 'needs-improvement']);
  assert.deepEqual([byName.TTFB.value, byName.TTFB.rating], [180.3, 'good']);
  assert.deepEqual([byName.page_load.t, byName.page_load.value], ['nav', 2410]);
  assert.ok(payload.events.every((e) => Number.isSafeInteger(e.ts)));
  // the second hide (tab switch back and forth) reports nothing again
  b.hide(); b.hide();
  await settle();
  assert.equal(b.bodies('/web').length, 1);
  c.stop();
});

test('CLS is the worst session window and INP the 98th percentile of the interactions', async () => {
  const b = browser();
  const c = collector(b);
  // window 1: 0.02 + 0.02; a gap of 1.5 s opens window 2: 0.2 (the worst)
  b.emit('layout-shift', [{ startTime: 100, value: 0.02 }, { startTime: 600, value: 0.02 }, { startTime: 2100, value: 0.2 }]);
  // 100 interactions of 100..199 ms: the 98th percentile skips the two slowest
  b.emit('event', Array.from({ length: 100 }, (_, i) => ({ interactionId: i + 1, duration: 100 + i })));
  c.finalize();
  await c.flush();
  const events = b.bodies('/web')[0].events;
  assert.equal(events.find((e) => e.name === 'CLS').value, 0.2);
  assert.equal(events.find((e) => e.name === 'INP').value, 197);
});

test('a page opened in the background reports no FCP and LCP; a browser without PerformanceObserver still works', async () => {
  const hidden = withNavigation(browser());
  hidden.doc.visibilityState = 'hidden';
  const c1 = collector(hidden);
  hidden.emit('paint', [{ name: 'first-contentful-paint', startTime: 500 }]);
  hidden.emit('largest-contentful-paint', [{ startTime: 900 }]);
  c1.finalize();
  await c1.flush();
  assert.deepEqual(hidden.bodies('/web')[0].events.map((e) => e.name).sort(), ['CLS', 'TTFB', 'page_load']);

  const plain = withNavigation(browser({ PerformanceObserver: undefined }));
  const c2 = collector(plain);
  c2.finalize();
  await c2.flush();
  assert.deepEqual(plain.bodies('/web')[0].events.map((e) => e.name).sort(), ['CLS', 'TTFB', 'page_load']);
});

test('page load waits for the load event when the document is still loading', async () => {
  const b = browser();
  b.doc.readyState = 'loading';
  let loadEventEnd = 0;
  b.env.performance.getEntriesByType = () => [{ startTime: 0, responseStart: 100, loadEventEnd }];
  const c = collector(b);
  await c.flush();
  assert.ok(!b.bodies('/web')[0]?.events.some((e) => e.name === 'page_load'));
  loadEventEnd = 1750;
  b.win.emit('load');
  await c.flush();
  assert.ok(b.bodies('/web').flatMap((p) => p.events).some((e) => e.name === 'page_load' && e.value === 1750));
});

// --- errors -------------------------------------------------------------------------------------------------------------

test('JS errors and unhandled rejections carry name, message and stack, handled false', async () => {
  const b = browser();
  const c = collector(b);
  const error = new TypeError('x is undefined');
  b.win.emit('error', { error, message: 'Uncaught TypeError: x is undefined' });
  b.win.emit('unhandledrejection', { reason: new RangeError('too far') });
  b.win.emit('unhandledrejection', { reason: 'plain text reason' });
  b.win.emit('error', { message: '' });
  b.win.emit('error', {});
  await c.flush();
  const { events } = b.bodies('/web')[0];
  assert.equal(events.length, 3);
  const [first, second, third] = events;
  assert.deepEqual([first.t, first.name, first.message, first.handled], ['error', 'TypeError', 'x is undefined', false]);
  assert.match(first.stack, /web\.test\.mjs/);
  assert.deepEqual([second.name, second.message, second.handled], ['RangeError', 'too far', false]);
  assert.deepEqual([third.name, third.message, third.stack], ['Error', 'plain text reason', '']);
});

test('Observe.reportError is handled true; texts are cut and addresses lose query and fragment', async () => {
  const b = browser();
  const c = collector(b);
  const error = new Error(`failed to load https://app.example.com/p/ABC?code=SECRET#frag ${'x'.repeat(2000)}`);
  error.stack = `Error: ${error.message}\n    at f (https://app.example.com/_expo/a.js?v=TOKEN:1:2)\n${'    at g (a.js:1:1)\n'.repeat(500)}`;
  c.reportError(error, true);
  await c.flush();
  const [event] = b.bodies('/web')[0].events;
  assert.equal(event.handled, true);
  assert.ok(event.message.length <= 500 && event.stack.length <= 4000);
  assert.ok(!JSON.stringify(event).includes('SECRET') && !JSON.stringify(event).includes('TOKEN') && !JSON.stringify(event).includes('frag'));
  assert.ok(event.stack.startsWith('    at f (https://app.example.com/_expo/a.js:1:2)'));
});

test('a looping error is reported three times, a page load at most twenty errors', async () => {
  const b = browser();
  const c = collector(b);
  for (let i = 0; i < 50; i++) b.win.emit('error', { error: new Error('same') });
  for (let i = 0; i < 50; i++) b.win.emit('error', { error: new Error(`different ${i}`) });
  await c.flush();
  const events = b.bodies('/web').flatMap((p) => p.events);
  assert.equal(events.filter((e) => e.message === 'same').length, 3);
  assert.equal(events.length, 20);
});

test('describeError copes with every kind of thrown value', () => {
  assert.deepEqual(describeError(undefined), { name: 'Error', message: '', stack: '' });
  assert.equal(describeError(null).name, 'Error');
  assert.equal(describeError(42).message, '42');
  assert.equal(describeError({ name: '<script>', message: 'm' }).name, 'Error');
  assert.equal(describeError({ get message() { throw new Error('boom'); } }).message, '');
  assert.equal(stripUrlTails('see http://a.b/c?d=1#e and https://x.y/z'), 'see http://a.b/c and https://x.y/z');
});

// --- batching and the queue ---------------------------------------------------------------------------------------------

test('no request carries more than 50 events, nor more than the keepalive body limit', () => {
  const meta = { env: 'web', appVersion: '1.8.1', session: 's', device: { browser: 'Chrome 126', viewport: '390x840', connection: '4g' } };
  const small = Array.from({ length: 120 }, (_, i) => ({ route: '/a', event: { t: 'vital', name: 'LCP', value: i, rating: 'good', ts: 1 } }));
  const bodies = diagnosticsBodies(small, meta).map((b) => JSON.parse(b));
  assert.deepEqual(bodies.map((b) => b.events.length), [50, 50, 20]);
  const big = Array.from({ length: 30 }, () => ({ route: '/a', event: { t: 'error', name: 'Error', message: 'm'.repeat(500), stack: 's'.repeat(4000), handled: false, ts: 1 } }));
  const raw = diagnosticsBodies(big, meta);
  assert.ok(raw.length > 1 && raw.every((b) => b.length <= MAX_BODY_BYTES));
  assert.equal(raw.flatMap((b) => JSON.parse(b).events).length, 30);
  const two = diagnosticsBodies([{ route: '/a', event: small[0].event }, { route: '/b', event: small[1].event }, { route: '/a', event: small[2].event }], meta).map((b) => JSON.parse(b));
  assert.deepEqual(two.map((b) => [b.route, b.events.length]), [['/a', 2], ['/b', 1]]);
});

test('the collector splits a burst into batches of at most 50 and keeps the newest 200', async () => {
  const b = browser();
  const c = collector(b);
  for (let i = 0; i < 300; i++) c.record('user.signed_in', { plan: 'pro' });
  assert.equal(c.pending.otlp, MAX_QUEUE);
  b.hide();
  await settle();
  const logs = b.bodies('/v1/logs');
  assert.deepEqual(logs.map((l) => l.resourceLogs[0].scopeLogs[0].logRecords.length), [50, 50, 50, 50]);
  assert.equal(c.pending.otlp, 0);
});

test('events of different routes go out as separate batches with their route template', async () => {
  const b = browser();
  const c = collector(b);
  c.reportError(new Error('on the landing page'), true);
  c.setRoute('/settings');
  c.reportError(new Error('on the settings page'), true);
  await c.flush();
  const payloads = b.bodies('/web');
  assert.deepEqual(payloads.map((p) => [p.route, p.events[0].message]).sort(), [['/p/[code]', 'on the landing page'], ['/settings', 'on the settings page']]);
});

test('an event captured before the router knows the route is sent with the route of the landing page', async () => {
  const b = browser();
  const c = createCollector({ projectId: PROJECT, appVersion: '1.8.1', env: b.env, now: () => clock++ });
  c.start();
  c.reportError(new Error('early'), false);
  c.setRoute('/sign-in');
  await c.flush();
  assert.equal(b.bodies('/web')[0].route, '/sign-in');
  const none = browser();
  const d = createCollector({ projectId: PROJECT, appVersion: '1.8.1', env: none.env, now: () => clock++ });
  d.start();
  d.reportError(new Error('never routed'), false);
  await d.flush();
  assert.equal(none.bodies('/web')[0].route, '/[unknown]');
});

test('a flush with the timer sends, and a failed send is retried later and then given up', async () => {
  const b = browser();
  let status = 503;
  b.env.fetch = async (url, init) => { b.requests.push({ url, init }); return { ok: status === 200, status }; };
  const c = collector(b);
  c.reportError(new Error('e'), true);
  assert.equal(b.timers[0].ms, 10_000);
  await b.timers[0].fn();
  await settle();
  assert.equal(b.requests.length, 1);
  assert.equal(c.pending.diagnostics, 1, 'kept for a retry');
  await c.flush(); // too early: the back-off has not passed
  assert.equal(b.requests.length, 1);
});

test('the shared queue bounds memory, serializes flushes and keeps events added while a request is pending', async () => {
  const queue = new EventQueue();
  for (let i = 0; i < MAX_QUEUE + 50; i++) queue.add(i);
  assert.equal(queue.size, MAX_QUEUE);
  let finish;
  const pending = new Promise((r) => { finish = r; });
  let calls = 0;
  const send = () => { calls++; return pending; };
  const first = queue.flush(send, 0);
  queue.add(1);
  const second = queue.flush(send, 0);
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish('accepted');
  await first;
  assert.equal(queue.size, MAX_QUEUE - MAX_BATCH + 1);
});

test('offline failures retain the batch, back off, then stop after three attempts', async () => {
  const queue = new EventQueue();
  queue.add(1);
  let calls = 0;
  const send = async () => { calls++; throw new Error('offline'); };
  await queue.flush(send, 0);
  assert.equal(queue.size, 1);
  await queue.flush(send, 4999);
  assert.equal(calls, 1);
  await queue.flush(send, 5000);
  await queue.flush(send, 15000);
  assert.equal(calls, 3);
  assert.equal(queue.size, 0);
});

test('clearing the queue while a request fails never restores the discarded events', async () => {
  const queue = new EventQueue();
  queue.add(1);
  let finish;
  const pending = new Promise((r) => { finish = r; });
  const flushing = queue.flush(() => pending, 0);
  queue.clear();
  finish('retry');
  await flushing;
  assert.equal(queue.size, 0);
});

// --- opt-outs -----------------------------------------------------------------------------------------------------------

test('isOptedOut: Do Not Track, Global Privacy Control and the local switch', () => {
  assert.equal(OFF_KEY, 'open-observe.off');
  assert.equal(isOptedOut({}), false);
  assert.equal(isOptedOut({ navigator: { doNotTrack: '0' } }), false);
  assert.equal(isOptedOut({ navigator: { doNotTrack: '1' } }), true);
  assert.equal(isOptedOut({ navigator: { msDoNotTrack: '1' } }), true);
  assert.equal(isOptedOut({ navigator: {}, windowDoNotTrack: 'yes' }), true);
  assert.equal(isOptedOut({ navigator: { globalPrivacyControl: true } }), true);
  assert.equal(isOptedOut({ navigator: { globalPrivacyControl: false } }), false);
  const storage = (v) => ({ getItem: (k) => (k === OFF_KEY ? v : 'x') });
  assert.equal(isOptedOut({ storage: storage('1') }), true);
  assert.equal(isOptedOut({ storage: storage('true') }), true);
  assert.equal(isOptedOut({ storage: storage(null) }), false);
  assert.equal(isOptedOut({ storage: storage('0') }), false);
  assert.equal(isOptedOut({ storage: { getItem() { throw new Error('blocked'); } } }), false);
});

for (const [label, apply] of [
  ['Do Not Track', (b) => { b.env.navigator.doNotTrack = '1'; }],
  ['Global Privacy Control', (b) => { b.env.navigator.globalPrivacyControl = true; }],
  ['open-observe.off', (b) => { b.store({ [OFF_KEY]: '1' }); }],
]) {
  test(`${label}: nothing is observed, collected or sent`, async () => {
    const b = browser();
    apply(b);
    const c = collector(b);
    assert.equal(c.optedOut, true);
    assert.equal(b.observers.length, 0, 'no PerformanceObserver');
    assert.equal(b.win.count('error') + b.win.count('unhandledrejection') + b.win.count('pagehide') + b.doc.count('visibilitychange'), 0, 'no listener');
    assert.equal(b.timers.length, 0);
    b.win.emit('error', { error: new Error('x') });
    c.reportError(new Error('x'), true);
    c.record('user.signed_in', { plan: 'pro' });
    c.finalize();
    await c.flush();
    b.hide();
    assert.deepEqual(c.pending, { otlp: 0, diagnostics: 0 });
    assert.equal(b.requests.length, 0);
  });
}

test('switching off in the middle of a visit drops the queue and stops sending', async () => {
  const b = browser();
  const c = collector(b);
  c.reportError(new Error('before'), true);
  c.record('user.signed_in', { plan: 'pro' });
  assert.deepEqual(c.pending, { otlp: 1, diagnostics: 1 });
  b.store({ [OFF_KEY]: '1' });
  c.reportError(new Error('after'), true);
  await c.flush();
  b.hide();
  assert.deepEqual(c.pending, { otlp: 0, diagnostics: 0 });
  assert.equal(b.requests.length, 0);
});

test('dispatchingEnabled false, a development bundle and an unusable project id send nothing', async () => {
  const off = browser();
  const c1 = collector(off);
  c1.configure({ dispatchingEnabled: false });
  c1.reportError(new Error('x'), true);
  await c1.flush();
  assert.equal(off.requests.length, 0);

  const dev = browser();
  const c2 = collector(dev, { isDev: true });
  c2.reportError(new Error('x'), true);
  await c2.flush();
  assert.equal(dev.requests.length, 0);
  c2.configure({ dispatchInDebug: true });
  c2.reportError(new Error('y'), true);
  await c2.flush();
  assert.equal(dev.requests.length, 1);

  const bad = browser();
  const c3 = collector(bad, { projectId: '../../evil' });
  c3.reportError(new Error('x'), true);
  await c3.flush();
  assert.equal(bad.requests.length, 0);
});

test('sampleRate 0 keeps the page out of the sample, errorSampleRate 1 still sends errors', async () => {
  const b = browser();
  const c = collector(b);
  c.configure({ sampleRate: 0, errorSampleRate: 1 });
  c.record('user.signed_in', { plan: 'pro' });
  c.finalize();
  c.reportError(new Error('still counted'), false);
  await c.flush();
  assert.equal(b.bodies('/v1/logs').length, 0);
  assert.deepEqual(b.bodies('/web').flatMap((p) => p.events.map((e) => e.t)), ['error']);
  const n = browser();
  const d = collector(n);
  d.configure({ sampleRate: 0 });
  d.reportError(new Error('x'), false);
  await d.flush();
  assert.equal(n.requests.length, 0);
});

// --- transport ----------------------------------------------------------------------------------------------------------

test('every request goes to our own origin with no credentials, Authorization, cookie, Referer or redirect', async () => {
  const b = browser();
  const c = collector(b);
  c.reportError(new Error('x'), true);
  c.record('user.signed_in', { plan: 'pro' });
  c.record(RENDER_EVENT, { phase: 'startup', durationMs: 120 });
  await c.flush();
  assert.deepEqual(b.requests.map((r) => r.url).sort(), [`/observe/${PROJECT}/v1/logs`, `/observe/${PROJECT}/v1/metrics`, `/observe/${PROJECT}/web`]);
  for (const { url, init } of b.requests) {
    assert.ok(url.startsWith(`/observe/${PROJECT}/`) && !/^[a-z]+:|\/\//i.test(url), 'same origin, relative');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error');
    assert.equal(init.keepalive, true);
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.ok(!/authorization|cookie|token|bearer/i.test(JSON.stringify(init)));
  }
});

test('the diagnostics payload has the shape of the contract and no more than a coarse device', async () => {
  const b = browser();
  const c = collector(b);
  c.reportError(new TypeError('x is undefined'), false);
  await c.flush();
  const payload = b.bodies('/web')[0];
  assert.deepEqual(Object.keys(payload), ['v', 'env', 'appVersion', 'updateId', 'route', 'session', 'device', 'events']);
  assert.deepEqual([payload.v, payload.env, payload.appVersion, payload.updateId, payload.route], [1, 'web', '1.8.1', null, '/p/[code]']);
  assert.equal(payload.session, c.sessionId);
  assert.deepEqual(payload.device, { browser: 'Chrome 126', viewport: '390x840', connection: '4g' });
  assert.deepEqual(Object.keys(payload.events[0]), ['t', 'name', 'message', 'stack', 'handled', 'ts']);
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('Mozilla') && !text.includes('Android'));
});

test('the session id is random per page load and not stored anywhere', () => {
  const a = collector(browser()), b = collector(browser());
  assert.match(a.sessionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.sessionId, a.clientId);
});

test('without fetch the beacon is the fallback; the page going away sends everything at once', async () => {
  const b = browser({ fetch: undefined });
  const beacons = [];
  b.env.navigator.sendBeacon = (url, blob) => { beacons.push({ url, blob }); return true; };
  const c = collector(b);
  c.reportError(new Error('x'), true);
  b.win.emit('pagehide');
  await settle();
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, `/observe/${PROJECT}/web`);
  assert.equal(beacons[0].blob.type, 'application/json');
  assert.equal(JSON.parse(beacons[0].blob.parts[0]).events[0].message, 'x');
});

test('stop() removes every listener and observer', () => {
  const b = browser();
  const c = collector(b);
  assert.ok(b.observers.length > 0 && b.win.count('error') === 1);
  c.stop();
  assert.equal(b.observers.length, 0);
  assert.equal(b.win.count('error') + b.win.count('unhandledrejection') + b.win.count('pagehide') + b.doc.count('visibilitychange'), 0);
});

// --- the OTLP allowlist -------------------------------------------------------------------------------------------------

test('events allow only the listed names, enums, counts and labels and omit content, identifiers, URLs and arbitrary names', () => {
  const input = {
    plan: 'pro', email: 'private@example.com', token: 'SECRET', name: 'Aspirin', route: '/account/secret-code', errorType: 'TypeError',
    message: 'Private content', stack: 'https://example.com/p/SECRET', created: true, items: 3, coupon: 'SPRING-24', nested: { secret: 'x' },
  };
  const clean = sanitizeEvent('user.signed_in', Date.now(), input, POLICY);
  assert.deepEqual(clean.attributes, { plan: 'pro', created: true, items: 3, coupon: 'SPRING-24' });
  const serialized = JSON.stringify(toOtlpLogs([clean], metadata, undefined, POLICY));
  for (const privateValue of ['SECRET', 'private@example.com', 'Aspirin', 'secret-code', 'Private content']) assert.ok(!serialized.includes(privateValue));
  // values outside the enum, the wrong type, an out of range number, a label with a space or an address
  const bad = sanitizeEvent('user.signed_in', Date.now(), { plan: 'enterprise', created: 'yes', items: -1, coupon: 'has space', status: 99 }, POLICY);
  assert.deepEqual(bad.attributes, {});
  assert.deepEqual(sanitizeEvent('user.signed_in', Date.now(), { items: 4_000_000 }, POLICY).attributes, {});
  assert.deepEqual(sanitizeEvent('user.signed_in', Date.now(), { coupon: 'https://evil.example/?a=b' }, POLICY).attributes, {});
  assert.equal(sanitizeEvent('user.private@example.com', Date.now(), {}, POLICY), null);
  assert.equal(sanitizeEvent('open-observe.web.error', Date.now(), {}, POLICY), null, 'errors travel as diagnostics only, never twice');
  assert.equal(sanitizeEvent('user.signed_in', -1, {}, POLICY), null);
  assert.equal(sanitizeEvent('user.signed_in', Infinity, {}, POLICY), null);
  // the built-in attributes
  assert.deepEqual(sanitizeEvent('checkout.completed', Date.now(), { status: 402, code: 'card_declined', reason: 'bad id: 7', durationMs: 12.5 }, POLICY).attributes,
    { status: 402, code: 'card_declined', durationMs: 12.5 });
});

test('without a policy no event of the app gets through, only the timing events do', () => {
  assert.equal(sanitizeEvent('user.signed_in', Date.now(), { plan: 'pro' }), null);
  assert.equal(sanitizeEvent('user.signed_in', Date.now(), { plan: 'pro' }, DEFAULT_POLICY), null);
  assert.deepEqual(sanitizeEvent(RENDER_EVENT, Date.now(), { phase: 'startup', temperature: 'warm', durationMs: 5, plan: 'pro' }).attributes,
    { phase: 'startup', temperature: 'warm', durationMs: 5 });
  const b = browser();
  const c = createCollector({ projectId: PROJECT, appVersion: '1', env: b.env, now: () => clock++ });
  c.start();
  c.record('user.signed_in', { plan: 'pro' });
  assert.deepEqual(c.pending, { otlp: 0, diagnostics: 0 });
});

test('createPolicy takes untrusted configuration: malformed entries are dropped, built-in attributes cannot be redefined', () => {
  const hostile = createPolicy({
    events: ['ok.event', 'has space', '', 42, null, 'x'.repeat(200), RENDER_EVENT, '__proto__', 'a@b.c'],
    enums: { plan: ['free', 'has space', 5], 'bad key': ['x'], __proto__: ['x'], phase: ['injected'], route: ['/x'], status: ['x'] },
    numbers: ['count', 'durationMs', 'bad key', 7],
    flags: 'not an array',
    labels: ['kind', 'route', 'code'],
    routeSegments: ['Upper', 'ok', 'a/b', 'x'.repeat(60)],
  });
  assert.deepEqual([...hostile.events], ['ok.event']);
  assert.deepEqual([...hostile.enums.get('plan')], ['free']);
  assert.deepEqual([...hostile.enums.get('phase')], ['startup', 'navigation']);
  assert.deepEqual([...hostile.enums.keys()].sort(), ['phase', 'plan', 'temperature']);
  assert.deepEqual([...hostile.numbers], ['count']);
  assert.equal(hostile.flags.size, 0);
  assert.deepEqual([...hostile.labels], ['kind']);
  assert.deepEqual([...hostile.routeSegments], ['ok']);
  for (const nothing of [undefined, null, 'x', 5, [], { events: 'x' }]) {
    const policy = createPolicy(nothing);
    assert.equal(policy.events.size, 0);
    assert.equal(policy.routeSegments, null);
  }
  // an own property named like a prototype member is only an event name
  assert.equal(sanitizeEvent('constructor', Date.now(), {}, hostile), null);
  assert.equal(sanitizeEvent('ok.event', Date.now(), { phase: 'injected', route: '/x' }, hostile).attributes.phase, undefined);
});

test('OTLP marks web honestly, converts browser milliseconds to seconds and keeps timing out of the logs', () => {
  const timing = sanitizeEvent(INTERACTIVE_EVENT, Date.now(), { phase: 'startup', durationMs: 250, route: '/sign-in' });
  const custom = sanitizeEvent('user.signed_in', Date.now(), { plan: 'free' }, POLICY);
  const metrics = toOtlpMetrics([timing, custom], metadata, POLICY);
  const resource = Object.fromEntries(metrics.resourceMetrics[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(resource['os.name'], 'web');
  assert.equal(resource['os.type'], 'browser');
  assert.equal(resource['expo.environment'], 'production');
  assert.equal(resource['service.version'], '1.8.1');
  const [metric, ...rest] = metrics.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(rest.length, 0);
  assert.equal(metric.name, 'expo.app_startup.tti');
  assert.equal(metric.gauge.dataPoints[0].asDouble, 0.25);
  const logs = toOtlpLogs([timing, custom], metadata, undefined, POLICY).resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].attributes.find((a) => a.key === 'event.name').value.stringValue, 'user.signed_in');
  assert.equal(toOtlpLogs(Array.from({ length: 80 }, () => custom), metadata, undefined, POLICY).resourceLogs[0].scopeLogs[0].logRecords.length, MAX_BATCH);
});

// --- route templates ----------------------------------------------------------------------------------------------------

test('route templates retain dynamic placeholders but drop query values and unknown concrete segments', () => {
  assert.equal(routeTemplate(['(tabs)', 'settings']), '/settings');
  assert.equal(routeTemplate(['p', '[code]', 'orders', '[id]']), '/p/[code]/orders/[id]');
  assert.equal(routeTemplate(['p', 'a?token=secret']), '/[redacted]');
  assert.equal(routeTemplate(['p', 'Capital']), '/[redacted]');
  assert.equal(routeTemplate([]), '/');
  // with the routes of the app listed, a literal that is not one of them is no route
  assert.equal(sanitizeEvent(RENDER_EVENT, Date.now(), { route: '/p/ordercode' }, POLICY).attributes.route, undefined);
  assert.equal(sanitizeEvent(RENDER_EVENT, Date.now(), { route: '/p/[code]' }, POLICY).attributes.route, '/p/[code]');
  assert.equal(sanitizeEvent(RENDER_EVENT, Date.now(), { route: '/p/[code]' }).attributes.route, '/p/[code]');
  // without the list any lowercase word passes (what routeTemplate writes), but never an address, capitals, dots or a query
  assert.equal(acceptRoute('/anything/at-all'), '/anything/at-all');
  assert.equal(acceptRoute('/p/SecretCode'), null);
  assert.equal(acceptRoute('/p/john.doe@example.com'), null);
  assert.equal(acceptRoute('/p/[code]?x=1'), null);
  assert.equal(acceptRoute('https://evil.example/p'), null);
  assert.equal(acceptRoute('/p/' + 'x'.repeat(300)), null);
  assert.equal(acceptRoute('/a/b', new Set(['a'])), null);
  assert.equal(acceptRoute('/a/[b]', new Set(['a'])), '/a/[b]');
});

test('the route of a batch is the template, never the address with its values', async () => {
  const b = browser();
  b.win.location = { pathname: '/p/SECRETCODE', search: '?token=SECRET' };
  const c = collector(b);
  c.reportError(new Error('x'), true);
  await c.flush();
  const text = b.requests.map((r) => r.url + r.init.body).join('');
  assert.ok(!text.includes('SECRETCODE') && !text.includes('SECRET'));
  assert.equal(b.bodies('/web')[0].route, '/p/[code]');
});

test('small helpers: browser label and viewport', () => {
  assert.equal(browserLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.81'), 'Edge 126');
  assert.equal(browserLabel('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'), 'Firefox 127');
  assert.equal(browserLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari 17');
  assert.equal(browserLabel(''), 'unknown');
  assert.equal(viewportLabel(394, 843), '390x840');
});

// --- the gate (setObserveEnabled) ---------------------------------------------------------------------------------------

const listenerCount = (b) => b.win.count('error') + b.win.count('unhandledrejection') + b.win.count('pagehide') + b.doc.count('visibilitychange');

test('the gate is closed by default, only true opens it, and listeners hear the changes', () => {
  assert.equal(isObserveEnabled(), false);
  const heard = [];
  const unsubscribe = subscribeObserveEnabled((on) => heard.push(on));
  setObserveEnabled('yes');
  assert.equal(isObserveEnabled(), false);
  setObserveEnabled(true);
  setObserveEnabled(true);
  assert.equal(isObserveEnabled(), true);
  setObserveEnabled(false);
  unsubscribe();
  setObserveEnabled(true);
  setObserveEnabled(false);
  assert.deepEqual(heard, [true, false]);
  assert.equal(isObserveEnabled(), false);
});

test('gate closed: nothing is observed, queued or sent, whatever happens on the page', async () => {
  const b = withNavigation(browser());
  let open = false;
  const c = collector(b, { enabled: () => open });
  assert.equal(c.running, false);
  assert.equal(b.observers.length, 0, 'no PerformanceObserver');
  assert.equal(listenerCount(b), 0, 'no listener');
  assert.equal(b.timers.length, 0);
  assert.equal(b.requests.length, 0, 'no TTFB or page load either');
  b.win.emit('error', { error: new Error('x') });
  b.win.emit('unhandledrejection', { reason: new Error('y') });
  c.reportError(new Error('z'), true);
  c.record('user.signed_in', { plan: 'pro' });
  c.record(RENDER_EVENT, { phase: 'startup', durationMs: 5 });
  c.finalize();
  b.hide();
  await c.flush();
  await c.flush(true);
  assert.deepEqual(c.pending, { otlp: 0, diagnostics: 0 });
  assert.equal(b.requests.length, 0);
});

test('opening the gate starts collection: observers, listeners, vitals of this page load and later events', async () => {
  const b = withNavigation(browser());
  let open = false;
  const c = collector(b, { enabled: () => open });
  b.win.emit('error', { error: new Error('before the gate opened') });
  open = true;
  c.setEnabled(true);
  assert.equal(c.running, true);
  assert.ok(b.observers.length > 0);
  assert.equal(listenerCount(b), 4);
  b.emit('largest-contentful-paint', [{ startTime: 1200 }]);
  b.win.emit('error', { error: new Error('after') });
  c.record('user.signed_in', { plan: 'pro' });
  b.hide();
  await settle();
  const events = b.bodies('/web').flatMap((p) => p.events);
  assert.deepEqual(events.filter((e) => e.t === 'error').map((e) => e.message), ['after']);
  assert.ok(events.some((e) => e.name === 'LCP' && e.value === 1200));
  assert.ok(events.some((e) => e.name === 'TTFB') && events.some((e) => e.name === 'page_load'));
  assert.equal(b.bodies('/v1/logs').length, 1);
});

test('closing the gate clears the queue, removes every listener and stops sending', async () => {
  const b = browser();
  let open = true;
  const c = collector(b, { enabled: () => open });
  c.reportError(new Error('queued'), true);
  c.record('user.signed_in', { plan: 'pro' });
  assert.deepEqual(c.pending, { otlp: 1, diagnostics: 1 });
  open = false;
  c.setEnabled(false);
  assert.deepEqual(c.pending, { otlp: 0, diagnostics: 0 });
  assert.equal(c.running, false);
  assert.equal(b.observers.length, 0);
  assert.equal(listenerCount(b), 0);
  b.win.emit('error', { error: new Error('later') });
  c.reportError(new Error('later'), true);
  await c.flush();
  b.hide();
  assert.equal(b.requests.length, 0);
  // and it can be opened again
  open = true;
  c.setEnabled(true);
  c.reportError(new Error('again'), true);
  await c.flush();
  assert.deepEqual(b.bodies('/web').flatMap((p) => p.events.map((e) => e.message)), ['again']);
});

test('the gate closing without anyone calling setEnabled still drops events and requests (the check is on every event)', async () => {
  const b = browser();
  let open = true;
  const c = collector(b, { enabled: () => open });
  c.reportError(new Error('queued'), true);
  open = false;
  await c.flush();
  b.hide();
  assert.equal(b.requests.length, 0);
  assert.deepEqual(c.pending, { otlp: 0, diagnostics: 0 });
});

test('the gate module drives a collector the way index.web does', async () => {
  const b = browser();
  const c = collector(b, { enabled: isObserveEnabled });
  const unsubscribe = subscribeObserveEnabled((on) => c.setEnabled(on));
  c.reportError(new Error('closed'), true);
  await c.flush();
  assert.equal(b.requests.length, 0);
  setObserveEnabled(true);
  c.reportError(new Error('open'), true);
  assert.equal(c.pending.diagnostics, 1);
  setObserveEnabled(false);
  assert.equal(c.pending.diagnostics, 0);
  await c.flush();
  assert.equal(b.requests.length, 0);
  unsubscribe();
});

// --- endpoint, mirror header, service name -----------------------------------------------------------------------------

test('endpointBase: a path of the page, https or local http, nothing else', () => {
  assert.equal(endpointBase(), '/observe');
  assert.equal(endpointBase(''), '/observe');
  assert.equal(endpointBase(null), '/observe');
  assert.equal(endpointBase('/observe/'), '/observe');
  assert.equal(endpointBase('/api/telemetry'), '/api/telemetry');
  assert.equal(endpointBase('https://observe.example.com/observe'), 'https://observe.example.com/observe');
  assert.equal(endpointBase('https://observe.example.workers.dev/observe///'), 'https://observe.example.workers.dev/observe');
  assert.equal(endpointBase('https://observe.example.com:8443'), 'https://observe.example.com:8443');
  assert.equal(endpointBase('http://localhost:8787/observe'), 'http://localhost:8787/observe');
  assert.equal(endpointBase('http://127.0.0.1:8787/observe'), 'http://127.0.0.1:8787/observe');
  for (const bad of [
    'http://observe.example.com/observe', 'ftp://x.example.com', '//evil.example/observe', 'https://user:pass@example.com/observe',
    'https://example.com/observe?a=1', 'https://example.com/observe#x', 'https://example.com/../x', '/observe/../x', '/a?b', 'observe',
    'javascript:alert(1)', 'https://exa mple.com', '/', 'https://', 42, {}, ['x'], 'https://example.com/' + 'a'.repeat(400),
  ]) assert.equal(endpointBase(bad), null, String(bad));
});

test('a configured endpoint is used for every request, and an unusable one sends nothing', async () => {
  const b = browser();
  const c = collector(b, { endpointUrl: 'https://observe.example.com/observe/' });
  c.reportError(new Error('x'), true);
  c.record('user.signed_in', { plan: 'pro' });
  c.record(RENDER_EVENT, { phase: 'startup', durationMs: 120 });
  await c.flush();
  assert.deepEqual(b.requests.map((r) => r.url).sort(), [
    `https://observe.example.com/observe/${PROJECT}/v1/logs`,
    `https://observe.example.com/observe/${PROJECT}/v1/metrics`,
    `https://observe.example.com/observe/${PROJECT}/web`,
  ]);
  for (const { init } of b.requests) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  }
  const bad = browser();
  const d = collector(bad, { endpointUrl: 'http://evil.example.com/observe' });
  d.reportError(new Error('x'), true);
  await d.flush();
  assert.equal(bad.requests.length, 0);
});

test('the mirror header of a native batch re-sent from JavaScript is X-Open-Observe-Mirror; the web collector never sets it', async () => {
  assert.equal(MIRROR_HEADER, 'X-Open-Observe-Mirror');
  const b = browser();
  const c = collector(b);
  c.reportError(new Error('x'), true);
  c.record('user.signed_in', { plan: 'pro' });
  await c.flush();
  assert.ok(b.requests.length >= 2);
  for (const { init } of b.requests) assert.ok(!Object.keys(init.headers).some((h) => /mirror/i.test(h)));
});

test('the service name of the OTLP resource is the configured one', () => {
  const resourceOf = (metrics) => Object.fromEntries(metrics.resourceMetrics[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
  const timing = sanitizeEvent(RENDER_EVENT, Date.now(), { phase: 'startup', durationMs: 5 });
  assert.equal(resourceOf(toOtlpMetrics([timing], metadata))['service.name'], 'web');
  assert.equal(resourceOf(toOtlpMetrics([timing], { ...metadata, serviceName: 'my-app.web' }))['service.name'], 'my-app.web');
});
