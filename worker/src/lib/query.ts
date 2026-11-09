// Helpers shared by the read endpoints of the dashboard API (routes/read-*.ts): range and filter
// parameters, the SQL that applies them, nearest-rank percentiles and the list of values present in the range.
import { ApiError } from './http';

export const DAY = 24 * 60 * 60 * 1000;

export function parseDays(v: string | undefined): number {
  if (v === undefined) return 7;
  const days = /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  if (!(days >= 1 && days <= 30)) throw new ApiError(400, 'invalid_range');
  return days;
}

// An optional filter: empty or missing means all. Bound as '' so one statement serves both.
export const filterParam = (v: string | undefined) => (v ?? '').trim().slice(0, 64);

// Rows of a telemetry table within the range and filters (?1 from, ?2 platform, ?3 version, ?4 environment).
export const FILTER = `AND (?2 = '' OR platform = ?2) AND (?3 = '' OR app_version = ?3) AND (?4 = '' OR environment = ?4)`;

// Nearest-rank percentile of `value` per group: the smallest value whose rank reaches ceil(p * n). `n` is an integer,
// so the integer division is a ceiling.
export const percentile = (p: number) => `MIN(CASE WHEN rn >= (${p} * n + 99) / 100 THEN value END)`;
export const RANKED = (groupBy: string) =>
  `ROW_NUMBER() OVER (PARTITION BY ${groupBy} ORDER BY value) AS rn, COUNT(*) OVER (PARTITION BY ${groupBy}) AS n`;

export type Row = Record<string, any>;
export const num = (v: unknown) => Number(v ?? 0);

export type ObserveFilterValues = readonly [from: number, platform: string, version: string, env: string];

/** The range (UTC days, today included) and the filters of a request. */
export function readRange(query: (name: string) => string | undefined) {
  const days = parseDays(query('days'));
  const to = Date.now();
  const from = Math.floor(to / DAY) * DAY - (days - 1) * DAY;
  const filters: ObserveFilterValues = [from, filterParam(query('platform')), filterParam(query('version')), filterParam(query('env'))];
  return { days, from, to, filters };
}

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One 'YYYY-MM-DD' per day of the range, oldest first. */
export const rangeDays = (from: number, days: number) => Array.from({ length: days }, (_, i) => dayKey(from + i * DAY));

/** SQL expression for the day of `ts` as 'YYYY-MM-DD' (UTC). */
export const DAY_SQL = `strftime('%Y-%m-%d', ts / 1000, 'unixepoch')`;

/** The screen of a log row: `route` is the column of the native route attribute, a screen.view event carries it as the `route` attribute. */
export const SCREEN_SQL = `COALESCE(route, CASE WHEN json_valid(attrs) THEN json_extract(attrs, '$.route') END)`;

/** Statement (?1 from) that lists the platforms, versions and environments present in the range, whatever the filters. */
export function presentValues(db: D1Database, from: number) {
  return db
    .prepare(
      `SELECT DISTINCT platform, app_version, environment FROM (
         SELECT platform, app_version, environment FROM obs_metrics WHERE ts >= ?1
         UNION ALL SELECT platform, app_version, environment FROM obs_logs WHERE ts >= ?1
         UNION ALL SELECT platform, app_version, environment FROM obs_spans WHERE ts >= ?1)`,
    )
    .bind(from);
}

export function readFilters(rows: Row[]) {
  const distinct = (key: string) => [...new Set(rows.map((r) => r[key] as string))].filter(Boolean).sort();
  return { platforms: distinct('platform'), versions: distinct('app_version'), environments: distinct('environment') };
}
