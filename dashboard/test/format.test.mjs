import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  barHeight,
  flattenTrace,
  count,
  formatAttrs,
  formatDateTime,
  formatNumber,
  parseDays,
  PERIODS,
  formatDuration,
  formatMetric,
  formatShare,
  formatVital,
  headlineMetric,
  isTimeMetric,
  metricLabel,
  OBSERVE_TABS,
  parseTab,
  percent,
  seriesTop,
  shortDay,
  shortUpdateId,
  sortBySlowest,
  statusClass,
  statusClasses,
} from '../src/format.ts';

test('durations are milliseconds below a second and seconds above', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(850.4), '850 ms');
  assert.equal(formatDuration(999.4), '999 ms');
  assert.equal(formatDuration(1000), '1 s');
  assert.equal(formatDuration(2410), '2.41 s');
  assert.equal(formatDuration(12345), '12.35 s');
  assert.equal(formatDuration(NaN), '–');
});

test('only known time metrics, web vitals (not CLS) and page load are durations; the rest are plain numbers', () => {
  assert.equal(isTimeMetric({ name: 'expo.app_startup.tti', category: 'app_startup' }), true);
  assert.equal(isTimeMetric({ name: 'expo.navigation.cold_ttr' }), true);
  assert.equal(isTimeMetric({ name: 'LCP', category: 'web_vital' }), true);
  assert.equal(isTimeMetric({ name: 'CLS', category: 'web_vital' }), false);
  assert.equal(isTimeMetric({ name: 'page_load', category: 'web_nav' }), true);
  assert.equal(isTimeMetric({ name: 'expo.unknown.memory_usage', category: 'unknown' }), false);
  assert.equal(formatMetric({ name: 'expo.unknown.memory_usage' }, 123.456789), '123.457');
  assert.equal(formatVital('CLS', 0.0912), '0.091');
  assert.equal(formatVital('INP', 304), '304 ms');
  assert.equal(formatVital('LCP', 2500), '2.5 s');
});

test('known metrics get a name, unknown ones keep the raw name', () => {
  assert.equal(metricLabel({ name: 'expo.app_startup.cold_launch_time' }), 'Cold launch');
  assert.equal(metricLabel({ name: 'expo.unknown.memory_usage', category: 'unknown' }), 'expo.unknown.memory_usage');
  assert.equal(metricLabel({ name: 'TTFB', category: 'web_vital' }), 'TTFB');
  assert.equal(metricLabel({ name: 'page_load', category: 'web_nav' }), 'Page load');
});

test('percent, short day and bars', () => {
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(0, 0), 0);
  assert.equal(shortDay('2026-11-08'), '8 Nov');
  assert.equal(shortDay('x'), 'x');
  assert.equal(barHeight(0, 10, 100), 0);
  assert.equal(barHeight(1, 1000, 100), 2);
  assert.equal(barHeight(10, 10, 100), 100);
  assert.equal(barHeight(5, 10, 100), 50);
  assert.equal(barHeight(5, 0, 100), 0);
});

test('the tab comes from the URL parameter, the overview for anything else', () => {
  assert.deepEqual([...OBSERVE_TABS], ['overview', 'navigation', 'updates', 'metrics', 'errors', 'events', 'traces']);
  for (const tab of OBSERVE_TABS) assert.equal(parseTab(tab), tab);
  assert.equal(parseTab(['traces', 'events']), 'traces');
  for (const bad of [undefined, null, '', 'Traces', 'nope', 42, [], {}]) assert.equal(parseTab(bad), 'overview');
});

test('a share keeps a decimal below 10 % and never shows a small share as zero', () => {
  assert.equal(formatShare(0), '0 %');
  assert.equal(formatShare(NaN), '0 %');
  assert.equal(formatShare(-1), '0 %');
  assert.equal(formatShare(0.005), '0.5 %');
  assert.equal(formatShare(0.0123), '1.2 %');
  assert.equal(formatShare(0.09949), '9.9 %');
  assert.equal(formatShare(0.1), '10 %');
  assert.equal(formatShare(0.3333), '33 %');
  assert.equal(formatShare(1), '100 %');
  assert.equal(formatShare(1.2), '100 %');
});

test('update ids are shortened, the embedded update stays null', () => {
  assert.equal(shortUpdateId('9b3b89b6-2a3f-4d8c-8e2d-2db9f5d1f2a9'), '9b3b89b6');
  assert.equal(shortUpdateId(null), null);
  assert.equal(shortUpdateId(''), null);
});

test('a screen shows its time to interactive, else another load metric, else the most measured one', () => {
  const m = (name, count, p75 = count) => ({ name, category: 'x', count, p50: p75, p75, p95: p75 });
  assert.equal(headlineMetric([]), null);
  assert.equal(headlineMetric([m('expo.navigation.cold_ttr', 9), m('expo.navigation.tti', 1)]).name, 'expo.navigation.tti');
  assert.equal(headlineMetric([m('expo.navigation.warm_ttr', 9), m('expo.navigation.cold_ttr', 1)]).name, 'expo.navigation.cold_ttr');
  assert.equal(headlineMetric([m('LCP', 1), m('page_load', 1)]).name, 'page_load');
  assert.equal(headlineMetric([m('a', 1), m('b', 5), m('c', 2)]).name, 'b');
});

test('screens are sorted slowest first by the p75 of their headline metric, those without one last', () => {
  const route = (name, p75) => ({ route: name, metrics: p75 === null ? [] : [{ name: 'expo.navigation.tti', category: 'navigation', count: 1, p50: 0, p75, p95: 0 }] });
  const rows = [route('/a', 100), route('/none', null), route('/b', 900), route('/c', 100), route('/none2', null)];
  assert.deepEqual(sortBySlowest(rows).map((r) => r.route), ['/b', '/a', '/c', '/none', '/none2']);
  assert.deepEqual(rows.map((r) => r.route), ['/a', '/none', '/b', '/c', '/none2'], 'the input is not changed');
});

test('HTTP statuses fold into classes, ascending, without empty ones', () => {
  assert.equal(statusClass(200), '2xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(503), '5xx');
  assert.deepEqual(statusClasses([{ status: 500, count: 1 }, { status: 200, count: 3 }, { status: 404, count: 2 }, { status: 201, count: 1 }, { status: 400, count: 1 }]), [
    { label: '2xx', count: 4 },
    { label: '4xx', count: 3 },
    { label: '5xx', count: 1 },
  ]);
  assert.deepEqual(statusClasses([]), []);
});

test('a trace is flattened parents first with depth and the place of every bar', () => {
  const span = (spanId, offsetMs, durationMs, children = []) => ({ spanId, offsetMs, durationMs, children });
  const roots = [span('root', 0, 1000, [span('late', 500, 400), span('early', 100, 300, [span('deep', 150, 100)])])];
  const rows = flattenTrace(roots, 1000);
  assert.deepEqual(rows.map((r) => [r.span.spanId, r.depth]), [['root', 0], ['early', 1], ['deep', 2], ['late', 1]]);
  assert.deepEqual(rows.map((r) => [r.left, r.width]), [[0, 1], [0.1, 0.3], [0.15, 0.1], [0.5, 0.4]]);
  assert.equal(rows[0].span, roots[0]);
});

test('a bar of a trace stays visible and inside the trace, and an empty trace has no width to share', () => {
  const rows = flattenTrace([{ spanId: 'a', offsetMs: 0, durationMs: 0, children: [] }, { spanId: 'b', offsetMs: 2000, durationMs: 50, children: [] }], 1000);
  assert.deepEqual(rows.map((r) => [r.left, r.width]), [[0, 0.005], [1, 0]]);
  assert.deepEqual(flattenTrace([{ spanId: 'a', offsetMs: 0, durationMs: 0, children: [] }], 0).map((r) => [r.left, r.width]), [[0, 1]]);
  assert.deepEqual(flattenTrace([], 100), []);
});

test('event attributes read as sorted key=value pairs', () => {
  assert.equal(formatAttrs({}), '');
  assert.equal(formatAttrs({ kind: 'lab', ok: true, n: 3 }), 'kind=lab · n=3 · ok=true');
});

test('the top of a series', () => {
  assert.equal(seriesTop([]), 0);
  assert.equal(seriesTop([1, 7, 3]), 7);
});

test('counts take a regular plural or the given one', () => {
  assert.equal(count(1, 'occurrence'), '1 occurrence');
  assert.equal(count(0, 'occurrence'), '0 occurrences');
  assert.equal(count(1234, 'span'), '1,234 spans');
  assert.equal(count(2, 'entry', 'entries'), '2 entries');
});

test('numbers use a dot decimal and a comma for thousands', () => {
  assert.equal(formatNumber(1234.5678), '1,234.568');
  assert.equal(formatNumber(0), '0');
});

test('a date shows day, month, year and time; a missing time is a dash', () => {
  assert.match(formatDateTime(Date.UTC(2026, 10, 8, 12, 0)), /^8 Nov 2026, \d\d:\d\d$/);
  assert.equal(formatDateTime(0), '–');
  assert.equal(formatDateTime(NaN), '–');
});

test('the period comes from the URL parameter, 7 days for anything else', () => {
  assert.deepEqual([...PERIODS], [1, 7, 14, 30]);
  for (const n of PERIODS) assert.equal(parseDays(String(n)), n);
  for (const bad of [undefined, '', '0', '8', 'x', '365', null]) assert.equal(parseDays(bad), 7);
});
