// Formatting and grouping for the dashboard. No DOM or Preact imports: test/format.test.mjs runs this file under node.

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
/** `1234.5` → `1,234.5`. */
export const formatNumber = (n: number): string => NUMBER.format(n);

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** A millisecond timestamp as `8 Nov 2026, 14:05` in the browser's time zone; `–` for a value that is not a time. */
export function formatDateTime(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? DATE_TIME.format(new Date(ms)) : '–';
}

/** `1 occurrence`, `3 occurrences`: a count with its noun (regular English plural, or the given plural). */
export const count = (n: number, one: string, many = `${one}s`): string => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** Metrics measured in milliseconds that the dashboard knows by name. Everything else is shown as a plain number. */
const TIME_METRICS = new Set([
  'expo.app_startup.tti', 'expo.app_startup.ttr', 'expo.app_startup.cold_launch_time', 'expo.app_startup.warm_launch_time',
  'expo.app_startup.bundle_load_time', 'expo.updates.download_time',
  'expo.navigation.cold_ttr', 'expo.navigation.warm_ttr', 'expo.navigation.tti',
]);

type MetricRef = { name: string; category?: string };

/** Time in milliseconds (everything the API stores as a duration), unitless otherwise (CLS, memory and other unknown metrics). */
export function isTimeMetric({ name, category }: MetricRef): boolean {
  if (category === 'web_vital') return name !== 'CLS';
  if (category === 'web_nav') return true;
  return TIME_METRICS.has(name);
}

/** Human name of a metric; a name this dashboard does not know is shown as it came. */
export function metricLabel({ name, category }: MetricRef): string {
  if (category === 'web_nav' && name === 'page_load') return 'Page load';
  if (category === 'web_vital') return name;
  switch (name) {
    case 'expo.app_startup.tti': return 'App start: time to interactive';
    case 'expo.app_startup.ttr': return 'App start: time to render';
    case 'expo.app_startup.cold_launch_time': return 'Cold launch';
    case 'expo.app_startup.warm_launch_time': return 'Warm launch';
    case 'expo.app_startup.bundle_load_time': return 'Bundle load';
    case 'expo.updates.download_time': return 'Update download';
    case 'expo.navigation.cold_ttr': return 'Screen, first visit: time to render';
    case 'expo.navigation.warm_ttr': return 'Screen, revisit: time to render';
    case 'expo.navigation.tti': return 'Screen: time to interactive';
    default: return name;
  }
}

/** `850` → `850 ms`, `2410` → `2.41 s`: milliseconds below a second, seconds above. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  if (Math.abs(ms) < 1000) return `${formatNumber(Math.round(ms))} ms`;
  return `${formatNumber(Math.round(ms / 10) / 100)} s`;
}

export function formatMetric(ref: MetricRef, value: number): string {
  return isTimeMetric(ref) ? formatDuration(value) : Number.isFinite(value) ? formatNumber(Math.round(value * 1000) / 1000) : '–';
}

/** A Web Vital: LCP, FCP, INP and TTFB in time, CLS as a plain number. */
export const formatVital = (name: string, value: number): string => formatMetric({ name, category: 'web_vital' }, value);

/** Whole percent of `part` in `total`; 0 for an empty total. */
export const percent = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-08` → `8 Nov`. */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1];
  return month && d ? `${Number(d)} ${month}` : day;
}

/** Height of a bar in `0..max` pixels; a value above zero is always at least 2 px so it can be seen. */
export function barHeight(value: number, top: number, max: number): number {
  if (!(value > 0) || !(top > 0)) return 0;
  return Math.max(2, Math.round((value / top) * max));
}

// ---- Tabs ----

export const OBSERVE_TABS = ['overview', 'navigation', 'updates', 'metrics', 'errors', 'events', 'traces'] as const;
export type ObserveTab = (typeof OBSERVE_TABS)[number];

/** The tab named by a URL parameter (a string, an array when repeated, or missing); the overview for anything else. */
export function parseTab(value: unknown): ObserveTab {
  const v = Array.isArray(value) ? value[0] : value;
  return (OBSERVE_TABS as readonly string[]).includes(v as string) ? (v as ObserveTab) : 'overview';
}

export const PERIODS = [1, 7, 14, 30] as const;

/** Days from a URL parameter: one of the offered periods, else 7. */
export function parseDays(value: unknown): number {
  const n = Number(value);
  return (PERIODS as readonly number[]).includes(n) ? n : 7;
}

// ---- Numbers ----

/** A share `0..1` as `12 %`; below 10 % one decimal (`0.5 %`), so a small share is not shown as 0. */
export function formatShare(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return `0 %`;
  const pct = fraction * 100;
  const shown = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${formatNumber(Math.min(100, shown))} %`;
}

/** The first 8 characters of an OTA update id (a UUID); `null` (the update embedded in the build) stays null. */
export const shortUpdateId = (id: string | null): string | null => (id ? id.slice(0, 8) : null);

// ---- Navigation ----

type RouteMetric = { name: string; category: string; count: number; p50: number; p75: number; p95: number };

// The metric that says most about how fast a screen is: time to interactive, then render, then the web load.
const HEADLINE = ['expo.navigation.tti', 'expo.navigation.cold_ttr', 'expo.navigation.warm_ttr', 'page_load', 'LCP'];

/** The metric a screen row shows in its columns: the first of the known load metrics it has, else the most measured one. */
export function headlineMetric<T extends RouteMetric>(metrics: readonly T[]): T | null {
  for (const name of HEADLINE) {
    const found = metrics.find((m) => m.name === name);
    if (found) return found;
  }
  return metrics.reduce<T | null>((best, m) => (!best || m.count > best.count ? m : best), null);
}

/** Screens slowest first by the p75 of their headline metric (screens without a measurement last, in their order). */
export function sortBySlowest<T extends { metrics: readonly RouteMetric[] }>(routes: readonly T[]): T[] {
  const p75 = (r: T) => headlineMetric(r.metrics)?.p75 ?? -1;
  return routes.map((r, i) => ({ r, i })).sort((a, b) => p75(b.r) - p75(a.r) || a.i - b.i).map((x) => x.r);
}

// ---- Traces ----

/** `404` → `4xx`. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** The status codes of a histogram folded into classes (`2xx`, `4xx`…), ascending; empty classes are left out. */
export function statusClasses(statuses: readonly { status: number; count: number }[]): { label: string; count: number }[] {
  const out = new Map<string, number>();
  for (const { status, count } of [...statuses].sort((a, b) => a.status - b.status)) {
    const label = statusClass(status);
    out.set(label, (out.get(label) ?? 0) + count);
  }
  return [...out].map(([label, count]) => ({ label, count }));
}

type SpanNode = { spanId: string; offsetMs: number; durationMs: number; children: readonly SpanNode[] };

/**
 * The spans of a trace in display order (parents before their children, siblings by start) with their depth and where their bar
 * sits in the trace, as shares `0..1` of `totalMs` (a bar is never narrower than 0.5 % and never past the end).
 */
export function flattenTrace<T extends SpanNode>(roots: readonly T[], totalMs: number): { span: T; depth: number; left: number; width: number }[] {
  const out: { span: T; depth: number; left: number; width: number }[] = [];
  const walk = (nodes: readonly SpanNode[], depth: number) => {
    for (const node of [...nodes].sort((a, b) => a.offsetMs - b.offsetMs)) {
      const left = totalMs > 0 ? Math.min(1, Math.max(0, node.offsetMs / totalMs)) : 0;
      const width = totalMs > 0 ? Math.min(1 - left, Math.max(0.005, node.durationMs / totalMs)) : 1;
      out.push({ span: node as T, depth, left, width });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// ---- Events ----

/** Attributes of an event as `kind=lab · ok=true` (keys sorted, so equal events read equally). */
export function formatAttrs(attrs: Record<string, string | number | boolean>): string {
  return Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join(' · ');
}

// ---- Day series ----

/** Largest value of the given numbers, 0 when there are none. */
export const seriesTop = (values: readonly number[]): number => Math.max(0, ...values);
