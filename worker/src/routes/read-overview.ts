// Read side of the telemetry: GET /api/overview and /api/errors/:fingerprint, behind the admin token (routes/api.ts).
// Percentiles are nearest-rank values picked with window functions, so only the aggregates leave the
// database.
import type { ObserveErrorDetail, ObserveOverview, ObserveWebVitalName } from '../api-types';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/http';
import { DAY, FILTER, num, percentile, presentValues, RANKED, readFilters, readRange, type Row } from '../lib/query';
import { WEB_VITALS, WEB_VITAL_THRESHOLDS } from '../lib/web';

const FINGERPRINT = /^[0-9a-f]{16}$/;

// Rows of both telemetry tables within the range and filters (see FILTER in lib/query.ts).
const EVENTS = `WITH ev AS (
  SELECT ts, platform, app_version, client, session_id, 0 AS err, 0 AS crash FROM obs_metrics WHERE ts >= ?1 ${FILTER}
  UNION ALL
  SELECT ts, platform, app_version, client, session_id, category IN ('error', 'crash') AS err, category = 'crash' AS crash
  FROM obs_logs WHERE ts >= ?1 ${FILTER}
)`;

const VITAL_THRESHOLDS = `t(name, good, poor) AS (VALUES ${WEB_VITALS.map((n) => `('${n}', ${WEB_VITAL_THRESHOLDS[n][0]}, ${WEB_VITAL_THRESHOLDS[n][1]})`).join(', ')})`;

export const readOverview = new Hono<AppEnv>()
  .get('/overview', async (c) => {
    const { days, from, to, filters } = readRange((k) => c.req.query(k));
    const db = c.env.DB;
    const q = (sql: string, ...bind: readonly (string | number)[]) => db.prepare(sql).bind(...bind);

    const [present, totals, timeline, metrics, routes, errors, vitals, versions, events] = await db.batch<Row>([
      presentValues(db, from),
      q(
        `${EVENTS} SELECT COUNT(*) AS events, COUNT(DISTINCT client) AS installs, COUNT(DISTINCT session_id) AS sessions,
                COALESCE(SUM(err), 0) AS errors, COALESCE(SUM(crash), 0) AS crashes FROM ev`,
        ...filters,
      ),
      q(
        `${EVENTS} SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(DISTINCT client) AS installs,
                COUNT(DISTINCT session_id) AS sessions, SUM(err) AS errors FROM ev GROUP BY day`,
        ...filters,
      ),
      q(
        `WITH f AS (SELECT name, category, value FROM obs_metrics WHERE ts >= ?1 ${FILTER}),
              r AS (SELECT name, category, value, ${RANKED('name, category')} FROM f)
         SELECT name, category, MAX(n) AS count, AVG(value) AS avg, ${percentile(50)} AS p50, ${percentile(75)} AS p75,
                ${percentile(95)} AS p95
         FROM r GROUP BY name, category ORDER BY count DESC, name LIMIT 60`,
        ...filters,
      ),
      q(
        `WITH f AS (SELECT route, value FROM obs_metrics WHERE ts >= ?1 AND route IS NOT NULL AND name LIKE '%.tti' ${FILTER}),
              r AS (SELECT route, value, ${RANKED('route')} FROM f)
         SELECT route, MAX(n) AS count, ${percentile(50)} AS p50, ${percentile(75)} AS p75
         FROM r GROUP BY route ORDER BY p75 DESC, route LIMIT 30`,
        ...filters,
      ),
      q(
        `WITH g AS (
           SELECT fingerprint, COUNT(*) AS count, COUNT(DISTINCT client) AS installs, MIN(ts) AS first_seen, MAX(ts) AS last_seen,
                  group_concat(DISTINCT app_version) AS versions, MAX(category = 'crash') AS crash, MAX(id) AS last_id
           FROM obs_logs WHERE ts >= ?1 AND fingerprint IS NOT NULL ${FILTER} GROUP BY fingerprint)
         SELECT g.*, l.error_type, l.body FROM g JOIN obs_logs l ON l.id = g.last_id
         ORDER BY g.count DESC, g.last_seen DESC LIMIT 50`,
        ...filters,
      ),
      q(
        `WITH ${VITAL_THRESHOLDS},
              f AS (SELECT m.name AS name, m.value AS value, t.good AS good, t.poor AS poor FROM obs_metrics m JOIN t ON t.name = m.name
                    WHERE m.category = 'web_vital' AND ts >= ?1 ${FILTER}),
              r AS (SELECT name, value, good, poor, ${RANKED('name')} FROM f)
         SELECT name, MAX(n) AS count, ${percentile(75)} AS p75, SUM(value <= good) AS good, SUM(value > poor) AS poor
         FROM r GROUP BY name`,
        ...filters,
      ),
      q(
        `${EVENTS} SELECT app_version AS version, platform, COUNT(DISTINCT client) AS installs, COUNT(DISTINCT session_id) AS sessions,
                SUM(err) AS errors, MAX(ts) AS last_seen FROM ev GROUP BY app_version, platform
         ORDER BY last_seen DESC LIMIT 100`,
        ...filters,
      ),
      q(
        `SELECT name, COUNT(*) AS count, COUNT(DISTINCT client) AS installs, MAX(ts) AS last_seen
         FROM obs_logs WHERE ts >= ?1 AND category = 'event' ${FILTER} GROUP BY name
         ORDER BY count DESC, last_seen DESC LIMIT 60`,
        ...filters,
      ),
    ]);

    const byDay = new Map(timeline.results.map((r) => [r.day as string, r]));
    const total = totals.results[0] ?? {};
    const vitalRows = new Map(vitals.results.map((r) => [r.name as string, r]));

    const overview: ObserveOverview = {
      range: { from, to, days },
      filters: readFilters(present.results),
      totals: {
        events: num(total.events),
        installs: num(total.installs),
        sessions: num(total.sessions),
        errors: num(total.errors),
        crashes: num(total.crashes),
      },
      timeline: Array.from({ length: days }, (_, i) => {
        const day = new Date(from + i * DAY).toISOString().slice(0, 10);
        const r = byDay.get(day);
        return { day, installs: num(r?.installs), sessions: num(r?.sessions), errors: num(r?.errors) };
      }),
      metrics: metrics.results.map((r) => ({
        name: r.name,
        category: r.category,
        count: num(r.count),
        avg: num(r.avg),
        p50: num(r.p50),
        p75: num(r.p75),
        p95: num(r.p95),
      })),
      events: events.results.map((r) => ({ name: r.name, count: num(r.count), installs: num(r.installs), lastSeen: num(r.last_seen) })),
      routes: routes.results.map((r) => ({ route: r.route, count: num(r.count), p50: num(r.p50), p75: num(r.p75) })),
      errors: errors.results.map((r) => ({
        fingerprint: r.fingerprint,
        name: r.error_type ?? 'Error',
        message: r.body ?? '',
        count: num(r.count),
        installs: num(r.installs),
        firstSeen: num(r.first_seen),
        lastSeen: num(r.last_seen),
        versions: String(r.versions ?? '').split(',').filter(Boolean),
        crash: num(r.crash) === 1,
      })),
      webVitals: WEB_VITALS.flatMap((name: ObserveWebVitalName) => {
        const r = vitalRows.get(name);
        if (!r) return [];
        const count = num(r.count);
        return [{ name, count, p75: num(r.p75), good: num(r.good), needsImprovement: count - num(r.good) - num(r.poor), poor: num(r.poor) }];
      }),
      versions: versions.results.map((r) => ({
        version: r.version,
        platform: r.platform,
        installs: num(r.installs),
        sessions: num(r.sessions),
        errors: num(r.errors),
        lastSeen: num(r.last_seen),
      })),
    };
    return c.json(overview);
  })

  // The latest occurrences of one error group (the `fingerprint` of the overview).
  .get('/errors/:fingerprint', async (c) => {
    const fingerprint = c.req.param('fingerprint');
    if (!FINGERPRINT.test(fingerprint)) throw new ApiError(404, 'not_found');
    const { results } = await c.env.DB
      .prepare(
        `SELECT ts, platform, app_version, environment, route, body, stack, error_type FROM obs_logs
         WHERE fingerprint = ? ORDER BY ts DESC, id DESC LIMIT 20`,
      )
      .bind(fingerprint)
      .all<Row>();
    if (results.length === 0) throw new ApiError(404, 'not_found');
    const detail: ObserveErrorDetail = {
      fingerprint,
      name: results[0].error_type ?? 'Error',
      occurrences: results.map((r) => ({
        ts: r.ts,
        platform: r.platform,
        appVersion: r.app_version,
        environment: r.environment,
        route: r.route,
        message: r.body ?? '',
        stack: r.stack,
      })),
    };
    return c.json(detail);
  });
