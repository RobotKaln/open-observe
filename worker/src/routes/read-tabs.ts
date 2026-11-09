// The tabs of the dashboard beyond the overview: navigation, updates, metrics, events and traces
// (GET /api/{navigation,updates,metrics,events,traces}), behind the admin token. Same range and filter
// parameters (days, platform, version, env) as the overview, nearest-rank percentiles, one db.batch per request. Only
// aggregates and the scrubbed rows the ingest stored leave the database.
import type {
  ObserveEventOccurrence,
  ObserveEvents,
  ObserveMetrics,
  ObserveNavigation,
  ObserveTraceDetail,
  ObserveTraces,
  ObserveTraceSpan,
  ObserveTraceSummary,
  ObserveUpdates,
} from '../api-types';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/http';
import {
  DAY_SQL,
  FILTER,
  num,
  percentile,
  presentValues,
  RANKED,
  rangeDays,
  readFilters,
  readRange,
  SCREEN_SQL,
  type Row,
} from '../lib/query';

const TRACE_ID = /^[0-9a-f]{16,32}$/;
const MAX_TRACE_SPANS = 500;

// The metrics that say how long a screen took to load or render.
const NAVIGATION_CATEGORIES = `('navigation', 'web_nav', 'web_vital')`;

const NAME_MAX = 120;
const nameParam = (v: string | undefined) => (v ?? '').trim().slice(0, NAME_MAX);

// An error span: error status, or an HTTP status of 400 or more.
const SPAN_ERROR = `(status = 'error' OR COALESCE(http_status, 0) >= 400)`;

// What the updates tab counts: every metric and log row with its update ('' = the update embedded in the build).
const UPDATE_EVENTS = `WITH ev AS (
  SELECT ts, platform, app_version, COALESCE(update_id, '') AS uid, client, session_id, 0 AS err, 0 AS crash
  FROM obs_metrics WHERE ts >= ?1 ${FILTER}
  UNION ALL
  SELECT ts, platform, app_version, COALESCE(update_id, '') AS uid, client, session_id, category IN ('error', 'crash') AS err, category = 'crash' AS crash
  FROM obs_logs WHERE ts >= ?1 ${FILTER}
)`;

// The traces of the range, one row per trace: start, extent, span and error counts, and the name of the root span (the
// first span without a parent; the first span when every one has a parent).
const TRACE_SUMMARY = `WITH f AS (
    SELECT id, trace_id, parent_id, name, ts, duration_ms, status, http_status, platform, app_version
    FROM obs_spans WHERE ts >= ?1 ${FILTER}),
  g AS (
    SELECT trace_id, MIN(ts) AS start, MAX(ts + duration_ms) - MIN(ts) AS duration, COUNT(*) AS spans,
           SUM(${SPAN_ERROR}) AS errors FROM f GROUP BY trace_id),
  r AS (
    SELECT trace_id, name, platform, app_version,
           ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY (parent_id IS NOT NULL), ts, id) AS rn FROM f)
  SELECT g.trace_id, g.start, g.duration, g.spans, g.errors, r.name, r.platform, r.app_version
  FROM g JOIN r ON r.trace_id = g.trace_id AND r.rn = 1`;

const summary = (r: Row): ObserveTraceSummary => ({
  traceId: r.trace_id,
  name: r.name,
  platform: r.platform,
  appVersion: r.app_version,
  start: num(r.start),
  durationMs: num(r.duration),
  spans: num(r.spans),
  errors: num(r.errors),
});

function parseAttrs(json: unknown): ObserveEventOccurrence['attrs'] {
  if (typeof json !== 'string') return {};
  try {
    const value = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return value;
  } catch {
    return {};
  }
}

// Spans of one trace as a tree. A span whose parent is missing (not sent, purged or in another batch) is a root, and a
// parent link that would make a loop is ignored, so every span appears exactly once.
export function nestSpans(rows: Row[], start: number): ObserveTraceSpan[] {
  const seen = new Set<string>();
  const nodes: ObserveTraceSpan[] = [];
  for (const r of rows) {
    if (seen.has(r.span_id)) continue;
    seen.add(r.span_id);
    nodes.push({
      spanId: r.span_id,
      parentId: r.parent_id ?? null,
      name: r.name,
      target: r.target ?? null,
      route: r.route ?? null,
      status: r.status,
      httpStatus: r.http_status ?? null,
      ts: num(r.ts),
      offsetMs: Math.max(0, num(r.ts) - start),
      durationMs: num(r.duration_ms),
      children: [],
    });
  }
  const byId = new Map(nodes.map((n) => [n.spanId, n]));
  const parentOf = new Map<string, string>();
  const roots: ObserveTraceSpan[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    let loops = false;
    for (let up = parent; up && !loops; up = parentOf.has(up.spanId) ? byId.get(parentOf.get(up.spanId)!) : undefined) {
      loops = up === node;
    }
    if (!parent || loops) {
      roots.push(node);
    } else {
      parentOf.set(node.spanId, parent.spanId);
      parent.children.push(node);
    }
  }
  return roots;
}

export const readTabs = new Hono<AppEnv>()
  // Per screen (route template): views, sessions, load times and errors; the most frequent moves between screens.
  .get('/navigation', async (c) => {
    const { days, from, to, filters } = readRange((k) => c.req.query(k));
    const db = c.env.DB;
    const q = (sql: string) => db.prepare(sql).bind(...filters);
    const views = `ts >= ?1 AND category = 'event' AND name = 'screen.view' ${FILTER}`;

    const [present, viewRows, sessionRows, metricRows, errorRows, moveRows] = await db.batch<Row>([
      presentValues(db, from),
      q(`SELECT ${SCREEN_SQL} AS screen, COUNT(*) AS views FROM obs_logs WHERE ${views} GROUP BY screen`),
      q(
        `WITH s AS (
           SELECT ${SCREEN_SQL} AS screen, session_id FROM obs_logs WHERE ${views}
           UNION
           SELECT route, session_id FROM obs_metrics
           WHERE ts >= ?1 AND route IS NOT NULL AND category IN ${NAVIGATION_CATEGORIES} ${FILTER})
         SELECT screen, COUNT(DISTINCT session_id) AS sessions FROM s WHERE screen IS NOT NULL GROUP BY screen`,
      ),
      q(
        `WITH f AS (SELECT route, name, category, value FROM obs_metrics
                    WHERE ts >= ?1 AND route IS NOT NULL AND category IN ${NAVIGATION_CATEGORIES} ${FILTER}),
              r AS (SELECT route, name, category, value, ${RANKED('route, name, category')} FROM f)
         SELECT route, name, category, MAX(n) AS count, ${percentile(50)} AS p50, ${percentile(75)} AS p75, ${percentile(95)} AS p95
         FROM r GROUP BY route, name, category ORDER BY count DESC, route, name LIMIT 500`,
      ),
      q(
        `SELECT ${SCREEN_SQL} AS screen, COUNT(*) AS errors FROM obs_logs
         WHERE ts >= ?1 AND category IN ('error', 'crash') ${FILTER} GROUP BY screen`,
      ),
      q(
        `WITH v AS (SELECT session_id, ${SCREEN_SQL} AS screen, ts, id FROM obs_logs WHERE ${views} AND session_id IS NOT NULL),
              s AS (SELECT screen, LAG(screen) OVER (PARTITION BY session_id ORDER BY ts, id) AS prev FROM v WHERE screen IS NOT NULL)
         SELECT prev AS from_route, screen AS to_route, COUNT(*) AS count FROM s
         WHERE prev IS NOT NULL AND prev <> screen GROUP BY prev, screen ORDER BY count DESC, prev, screen LIMIT 30`,
      ),
    ]);

    const routes = new Map<string, ObserveNavigation['routes'][number]>();
    const route = (name: string) => {
      let entry = routes.get(name);
      if (!entry) routes.set(name, (entry = { route: name, views: 0, sessions: 0, errors: 0, metrics: [] }));
      return entry;
    };
    for (const r of viewRows.results) if (r.screen) route(r.screen).views = num(r.views);
    for (const r of sessionRows.results) route(r.screen).sessions = num(r.sessions);
    for (const r of errorRows.results) if (r.screen) route(r.screen).errors = num(r.errors);
    for (const r of metricRows.results) {
      route(r.route).metrics.push({ name: r.name, category: r.category, count: num(r.count), p50: num(r.p50), p75: num(r.p75), p95: num(r.p95) });
    }
    const measured = (r: ObserveNavigation['routes'][number]) => r.metrics.reduce((n, m) => n + m.count, 0);

    const body: ObserveNavigation = {
      range: { from, to, days },
      filters: readFilters(present.results),
      routes: [...routes.values()]
        .sort((a, b) => b.views - a.views || measured(b) - measured(a) || a.route.localeCompare(b.route))
        .slice(0, 100),
      transitions: moveRows.results.map((r) => ({ from: r.from_route, to: r.to_route, count: num(r.count) })),
    };
    return c.json(body);
  })

  // Per platform, app version and OTA update: who runs it, how it behaves, and how many installs it has reached.
  .get('/updates', async (c) => {
    const { days, from, to, filters } = readRange((k) => c.req.query(k));
    const db = c.env.DB;
    const q = (sql: string) => db.prepare(sql).bind(...filters);

    const [present, groups, current] = await db.batch<Row>([
      presentValues(db, from),
      q(
        `${UPDATE_EVENTS}
         SELECT platform, app_version, uid, COUNT(*) AS events, COUNT(DISTINCT client) AS installs,
                COUNT(DISTINCT session_id) AS sessions, SUM(err) AS errors, SUM(crash) AS crashes,
                COUNT(DISTINCT CASE WHEN err = 1 THEN session_id END) AS error_sessions, MIN(ts) AS first_seen, MAX(ts) AS last_seen
         FROM ev GROUP BY platform, app_version, uid ORDER BY last_seen DESC, platform, app_version, uid LIMIT 100`,
      ),
      // The update each install ran last: the shares of these add up to all installs of the range.
      q(
        `${UPDATE_EVENTS},
              last AS (SELECT platform, app_version, uid, ROW_NUMBER() OVER (PARTITION BY client ORDER BY ts DESC) AS rn
                       FROM ev WHERE client IS NOT NULL)
         SELECT platform, app_version, uid, COUNT(*) AS installs FROM last WHERE rn = 1
         GROUP BY platform, app_version, uid LIMIT 1000`,
      ),
    ]);

    const key = (r: Row) => `${r.platform}\n${r.app_version}\n${r.uid}`;
    const now = new Map(current.results.map((r) => [key(r), num(r.installs)]));
    const installs = [...now.values()].reduce((a, b) => a + b, 0);
    const body: ObserveUpdates = {
      range: { from, to, days },
      filters: readFilters(present.results),
      installs,
      updates: groups.results.map((r) => {
        const sessions = num(r.sessions);
        const errorSessions = num(r.error_sessions);
        const currentInstalls = now.get(key(r)) ?? 0;
        return {
          updateId: r.uid === '' ? null : r.uid,
          appVersion: r.app_version,
          platform: r.platform,
          firstSeen: num(r.first_seen),
          lastSeen: num(r.last_seen),
          installs: num(r.installs),
          currentInstalls,
          adoption: installs > 0 ? currentInstalls / installs : 0,
          sessions,
          events: num(r.events),
          errors: num(r.errors),
          crashes: num(r.crashes),
          errorSessions,
          errorRate: sessions > 0 ? errorSessions / sessions : 0,
        };
      }),
    };
    return c.json(body);
  })

  // Every metric with its distribution; `?name=` (and `?category=` when the name is not unique) adds its daily series.
  .get('/metrics', async (c) => {
    const { days, from, to, filters } = readRange((k) => c.req.query(k));
    const name = nameParam(c.req.query('name'));
    const category = nameParam(c.req.query('category'));
    const db = c.env.DB;

    const statements = [
      presentValues(db, from),
      db
        .prepare(
          `WITH f AS (SELECT name, category, value FROM obs_metrics WHERE ts >= ?1 ${FILTER}),
                r AS (SELECT name, category, value, ${RANKED('name, category')} FROM f)
           SELECT name, category, MAX(n) AS count, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max,
                  ${percentile(50)} AS p50, ${percentile(75)} AS p75, ${percentile(95)} AS p95
           FROM r GROUP BY name, category ORDER BY count DESC, name, category LIMIT 300`,
        )
        .bind(...filters),
    ];
    if (name) {
      statements.push(
        db
          .prepare(
            `WITH f AS (SELECT ${DAY_SQL} AS day, value FROM obs_metrics
                        WHERE ts >= ?1 AND name = ?5 AND (?6 = '' OR category = ?6) ${FILTER}),
                  r AS (SELECT day, value, ${RANKED('day')} FROM f)
             SELECT day, MAX(n) AS count, ${percentile(50)} AS p50, ${percentile(75)} AS p75, ${percentile(95)} AS p95
             FROM r GROUP BY day`,
          )
          .bind(...filters, name, category),
      );
    }
    const [present, list, series] = await db.batch<Row>(statements);

    const byDay = new Map((series?.results ?? []).map((r) => [r.day as string, r]));
    const body: ObserveMetrics = {
      range: { from, to, days },
      filters: readFilters(present.results),
      metrics: list.results.map((r) => ({
        name: r.name,
        category: r.category,
        count: num(r.count),
        avg: num(r.avg),
        min: num(r.min),
        max: num(r.max),
        p50: num(r.p50),
        p75: num(r.p75),
        p95: num(r.p95),
      })),
      selected: name
        ? {
            name,
            category: category || null,
            series: rangeDays(from, days).map((day) => {
              const r = byDay.get(day);
              return { day, count: num(r?.count), p50: num(r?.p50), p75: num(r?.p75), p95: num(r?.p95) };
            }),
          }
        : null,
    };
    return c.json(body);
  })

  // The events the app logged; `?name=` adds the daily series of that event and its latest 100 occurrences.
  .get('/events', async (c) => {
    const { days, from, to, filters } = readRange((k) => c.req.query(k));
    const name = nameParam(c.req.query('name'));
    const db = c.env.DB;
    const where = `ts >= ?1 AND category = 'event' ${FILTER}`;

    const statements = [
      presentValues(db, from),
      db
        .prepare(
          `SELECT name, COUNT(*) AS count, COUNT(DISTINCT client) AS installs, COUNT(DISTINCT session_id) AS sessions,
                  MIN(ts) AS first_seen, MAX(ts) AS last_seen
           FROM obs_logs WHERE ${where} GROUP BY name ORDER BY count DESC, last_seen DESC, name LIMIT 200`,
        )
        .bind(...filters),
      db
        .prepare(
          `SELECT ${DAY_SQL} AS day, COUNT(*) AS count, COUNT(DISTINCT client) AS installs FROM obs_logs
           WHERE ${where} ${name ? 'AND name = ?5' : ''} GROUP BY day`,
        )
        .bind(...filters, ...(name ? [name] : [])),
    ];
    if (name) {
      statements.push(
        db
          .prepare(
            `SELECT ts, platform, app_version, environment, ${SCREEN_SQL} AS screen, attrs FROM obs_logs
             WHERE ${where} AND name = ?5 ORDER BY ts DESC, id DESC LIMIT 100`,
          )
          .bind(...filters, name),
      );
    }
    const [present, list, series, occurrences] = await db.batch<Row>(statements);

    const byDay = new Map(series.results.map((r) => [r.day as string, r]));
    const body: ObserveEvents = {
      range: { from, to, days },
      filters: readFilters(present.results),
      events: list.results.map((r) => ({
        name: r.name,
        count: num(r.count),
        installs: num(r.installs),
        sessions: num(r.sessions),
        firstSeen: num(r.first_seen),
        lastSeen: num(r.last_seen),
      })),
      series: rangeDays(from, days).map((day) => ({ day, count: num(byDay.get(day)?.count), installs: num(byDay.get(day)?.installs) })),
      occurrences: (occurrences?.results ?? []).map((r) => ({
        ts: num(r.ts),
        platform: r.platform,
        appVersion: r.app_version,
        environment: r.environment,
        route: r.screen ?? null,
        attrs: parseAttrs(r.attrs),
      })),
    };
    return c.json(body);
  })

  // Spans by name and target, the slowest and the failed traces; `?trace=<trace id>` is one trace with its spans nested.
  .get('/traces', async (c) => {
    const trace = c.req.query('trace');
    const db = c.env.DB;

    if (trace !== undefined) {
      const traceId = trace.trim().toLowerCase();
      if (!TRACE_ID.test(traceId)) throw new ApiError(404, 'not_found');
      const { results } = await db
        .prepare(
          `SELECT span_id, parent_id, name, target, route, ts, duration_ms, status, http_status, platform, app_version, environment
           FROM obs_spans WHERE trace_id = ? ORDER BY ts, id LIMIT ${MAX_TRACE_SPANS}`,
        )
        .bind(traceId)
        .all<Row>();
      if (results.length === 0) throw new ApiError(404, 'not_found');
      const start = Math.min(...results.map((r) => num(r.ts)));
      const end = Math.max(...results.map((r) => num(r.ts) + num(r.duration_ms)));
      const detail: ObserveTraceDetail = {
        traceId,
        start,
        durationMs: end - start,
        spans: new Set(results.map((r) => r.span_id)).size,
        platform: results[0].platform,
        appVersion: results[0].app_version,
        environment: results[0].environment,
        roots: nestSpans(results, start),
      };
      return c.json(detail);
    }

    const { days, from, to, filters } = readRange((k) => c.req.query(k));
    const q = (sql: string) => db.prepare(sql).bind(...filters);
    const [present, groups, statuses, slowest, failed] = await db.batch<Row>([
      presentValues(db, from),
      q(
        `WITH f AS (SELECT name, COALESCE(target, '') AS target, duration_ms AS value, status, http_status FROM obs_spans
                    WHERE ts >= ?1 ${FILTER}),
              r AS (SELECT name, target, value, status, http_status, ${RANKED('name, target')} FROM f)
         SELECT name, target, MAX(n) AS count, SUM(${SPAN_ERROR}) AS errors, MAX(value) AS max,
                ${percentile(50)} AS p50, ${percentile(95)} AS p95
         FROM r GROUP BY name, target ORDER BY count DESC, name, target LIMIT 100`,
      ),
      q(
        `SELECT name, COALESCE(target, '') AS target, http_status, COUNT(*) AS count FROM obs_spans
         WHERE ts >= ?1 AND http_status IS NOT NULL ${FILTER} GROUP BY name, target, http_status
         ORDER BY name, target, http_status LIMIT 2000`,
      ),
      q(`${TRACE_SUMMARY} ORDER BY g.duration DESC, g.start DESC, g.trace_id LIMIT 50`),
      q(`${TRACE_SUMMARY} WHERE g.errors > 0 ORDER BY g.start DESC, g.trace_id LIMIT 50`),
    ]);

    const histogram = new Map<string, { status: number; count: number }[]>();
    for (const r of statuses.results) {
      const k = `${r.name}\n${r.target}`;
      const list = histogram.get(k) ?? [];
      list.push({ status: num(r.http_status), count: num(r.count) });
      histogram.set(k, list);
    }
    const body: ObserveTraces = {
      range: { from, to, days },
      filters: readFilters(present.results),
      groups: groups.results.map((r) => {
        const count = num(r.count);
        const errors = num(r.errors);
        return {
          name: r.name,
          target: r.target,
          count,
          errors,
          errorShare: count > 0 ? errors / count : 0,
          p50: num(r.p50),
          p95: num(r.p95),
          max: num(r.max),
          statuses: histogram.get(`${r.name}\n${r.target}`) ?? [],
        };
      }),
      slowest: slowest.results.map(summary),
      failed: failed.results.map(summary),
    };
    return c.json(body);
  });
