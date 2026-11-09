import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handle } from '../scripts/mock-api.ts';

const get = (path, query = '') => handle(path, new URLSearchParams(query));
const ok = (path, query) => {
  const r = get(path, query);
  assert.equal(r.status, 200, `${path}?${query}`);
  return r.body;
};

test('every endpoint answers with its range and filter lists', () => {
  for (const path of ['/api/overview', '/api/navigation', '/api/updates', '/api/metrics', '/api/events', '/api/traces']) {
    const body = ok(path, 'days=14');
    assert.equal(body.range.days, 14, path);
    assert.deepEqual(body.filters.platforms, ['android', 'ios', 'web'], path);
    assert.ok(body.range.from < body.range.to, path);
  }
});

test('the period is clamped to the offered range, 7 days by default', () => {
  assert.equal(ok('/api/overview').timeline.length, 7);
  assert.equal(ok('/api/overview', 'days=30').timeline.length, 30);
  assert.equal(ok('/api/overview', 'days=99').timeline.length, 7);
});

test('the same request gives the same answer', () => {
  const a = ok('/api/navigation', 'days=7&platform=ios');
  const b = ok('/api/navigation', 'days=7&platform=ios');
  assert.deepEqual(a.routes, b.routes);
});

test('filters narrow the totals, an unknown value leaves nothing', () => {
  const all = ok('/api/overview');
  const ios = ok('/api/overview', 'platform=ios');
  assert.ok(ios.totals.sessions > 0 && ios.totals.sessions < all.totals.sessions);
  assert.equal(ios.webVitals.length, 0, 'web vitals are a web thing');
  const none = ok('/api/overview', 'version=0.0.0');
  assert.equal(none.totals.events, 0);
  assert.ok(none.timeline.every((d) => d.sessions === 0));
});

test('an error group opens its occurrences by fingerprint, an unknown one is 404', () => {
  const group = ok('/api/overview').errors[0];
  const detail = ok(`/api/errors/${group.fingerprint}`);
  assert.equal(detail.fingerprint, group.fingerprint);
  assert.ok(detail.occurrences.length > 0 && detail.occurrences.length <= 20);
  assert.equal(get('/api/errors/0000000000000000').status, 404);
});

test('metrics: the selected one comes with one series entry per day', () => {
  const rows = ok('/api/metrics').metrics;
  assert.ok(rows.length > 5);
  assert.equal(ok('/api/metrics').selected, null);
  const sel = ok('/api/metrics', 'days=14&name=LCP&category=web_vital').selected;
  assert.equal(sel.name, 'LCP');
  assert.equal(sel.series.length, 14);
});

test('events: occurrences only for a selected event, newest first', () => {
  assert.deepEqual(ok('/api/events').occurrences, []);
  const e = ok('/api/events', 'name=item.created');
  assert.equal(e.occurrences.length, 100);
  assert.ok(e.occurrences.every((o, i, all) => i === 0 || all[i - 1].ts >= o.ts));
});

test('updates: install shares add up to one', () => {
  const { updates } = ok('/api/updates');
  assert.ok(updates.some((u) => u.updateId === null) && updates.some((u) => u.updateId));
  const sum = updates.reduce((s, u) => s + u.adoption, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, String(sum));
});

test('traces: the list and the detail agree, bad ids are refused', () => {
  const list = ok('/api/traces');
  assert.ok(list.slowest.length > 5 && list.failed.length > 0);
  assert.ok(list.slowest.every((t, i, all) => i === 0 || all[i - 1].durationMs >= t.durationMs));
  const summary = list.failed[0];
  const detail = ok('/api/traces', `trace=${summary.traceId}`);
  assert.equal(detail.traceId, summary.traceId);
  assert.equal(detail.spans, summary.spans);
  assert.equal(detail.durationMs, summary.durationMs);
  assert.equal(get('/api/traces', 'trace=zzz').status, 400);
  assert.equal(get('/api/traces', 'trace=' + 'a'.repeat(32)).status, 404);
});

test('unknown paths are 404', () => {
  assert.equal(get('/api/nope').status, 404);
});
