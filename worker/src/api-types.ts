// JSON shapes of the read API (GET /api/*). This file is shared by the Worker (worker/src/api-types.ts) and the dashboard
// (dashboard/src/api-types.ts): both copies have identical content below this comment, change them together.
// Times are Unix milliseconds, time metrics are in milliseconds, `CLS` is unitless.

export type ObserveWebVitalName = 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB';

export interface ObserveOverviewQuery {
  /** 1..30, default 7. */
  days?: number;
  /** Empty or missing = all. */
  platform?: string;
  version?: string;
  env?: string;
}

export interface ObserveOverview {
  /** Milliseconds; `from` is the start (UTC) of the first day. */
  range: { from: number; to: number; days: number };
  /** Values present in the range, regardless of the filters in use. */
  filters: { platforms: string[]; versions: string[]; environments: string[] };
  /** `errors` includes the `crashes`. `events` are metric and log rows. */
  totals: { events: number; installs: number; sessions: number; errors: number; crashes: number };
  /** One entry per day of the range, 'YYYY-MM-DD' (UTC). */
  timeline: { day: string; installs: number; sessions: number; errors: number }[];
  /** By count, at most 60. */
  metrics: { name: string; category: string; count: number; avg: number; p50: number; p75: number; p95: number }[];
  /** Events the app logged (`screen.view`, `checkout.completed`…), by count, at most 60. */
  events: { name: string; count: number; installs: number; lastSeen: number }[];
  /** Slowest first by p75 of the time-to-interactive metric, at most 30. */
  routes: { route: string; count: number; p50: number; p75: number }[];
  /** By count, at most 50. */
  errors: {
    fingerprint: string;
    name: string;
    message: string;
    count: number;
    installs: number;
    firstSeen: number;
    lastSeen: number;
    versions: string[];
    crash: boolean;
  }[];
  webVitals: { name: ObserveWebVitalName; count: number; p75: number; good: number; needsImprovement: number; poor: number }[];
  /** Most recently seen first. */
  versions: { version: string; platform: string; installs: number; sessions: number; errors: number; lastSeen: number }[];
}

export interface ObserveErrorDetail {
  fingerprint: string;
  name: string;
  /** Newest first, at most 20. */
  occurrences: {
    ts: number;
    platform: string;
    appVersion: string;
    environment: string;
    route: string | null;
    message: string;
    stack: string | null;
  }[];
}

/** Range, filter lists and filters of the dashboard tabs (Navigation, Updates, Metrics, Events, Traces). Same parameters as the overview. */
export interface ObserveTabBase {
  range: { from: number; to: number; days: number };
  /** Values present in the range (metrics, logs and spans), regardless of the filters in use. */
  filters: { platforms: string[]; versions: string[]; environments: string[] };
}

/** `GET /api/navigation`. Times in milliseconds. */
export interface ObserveNavigation extends ObserveTabBase {
  /**
   * Busiest first (by views, then measurements), at most 100. `views` are `screen.view` events (logged by the app), `sessions` count the sessions that viewed or measured the route, `errors` the errors and crashes
   * logged with the route (web errors; native errors carry no route).
   */
  routes: {
    route: string;
    views: number;
    sessions: number;
    errors: number;
    /** The navigation and web load metrics measured for the route (category navigation, web_nav, web_vital). */
    metrics: { name: string; category: string; count: number; p50: number; p75: number; p95: number }[];
  }[];
  /** Most frequent first, at most 30: consecutive `screen.view` events of one session. */
  transitions: { from: string; to: string; count: number }[];
}

/** `GET /api/updates`: one row per platform, app version and OTA update (`updateId` null = the update embedded in the build). */
export interface ObserveUpdates extends ObserveTabBase {
  /** Installs seen in the range. */
  installs: number;
  /** Most recently seen first, at most 100. */
  updates: {
    updateId: string | null;
    appVersion: string;
    platform: string;
    /** Within the range. */
    firstSeen: number;
    lastSeen: number;
    /** Installs that sent anything from this update in the range. */
    installs: number;
    /** Installs whose latest message in the range came from this update. */
    currentInstalls: number;
    /** `currentInstalls` / `installs` of the range (0..1): the shares of all updates add up to 1. */
    adoption: number;
    sessions: number;
    events: number;
    errors: number;
    crashes: number;
    /** Sessions with an error or crash. */
    errorSessions: number;
    /** `errorSessions` / `sessions` (0..1). */
    errorRate: number;
  }[];
}

/** `GET /api/metrics?name=&category=`: every metric, and the daily series of the selected one. */
export interface ObserveMetrics extends ObserveTabBase {
  /** By count, at most 300. */
  metrics: { name: string; category: string; count: number; avg: number; min: number; max: number; p50: number; p75: number; p95: number }[];
  /** The metric asked for with `name` (and `category`): one entry per day of the range. Null without `name`. */
  selected: {
    name: string;
    category: string | null;
    series: { day: string; count: number; p50: number; p75: number; p95: number }[];
  } | null;
}

/** One stored occurrence of an event: attributes as stored (already scrubbed, never an address, e-mail or token). */
export interface ObserveEventOccurrence {
  ts: number;
  platform: string;
  appVersion: string;
  environment: string;
  /** Route template of the screen. */
  route: string | null;
  attrs: Record<string, string | number | boolean>;
}

/** `GET /api/events?name=`. */
export interface ObserveEvents extends ObserveTabBase {
  /** Events the app logged, by count, at most 200. */
  events: { name: string; count: number; installs: number; sessions: number; firstSeen: number; lastSeen: number }[];
  /** One entry per day of the range, for the selected event (`name`) or for all events. */
  series: { day: string; count: number; installs: number }[];
  /** The latest 100 of the event asked for with `name`, newest first; empty without `name`. */
  occurrences: ObserveEventOccurrence[];
}

/** `GET /api/traces`: spans by name and target, and the slowest and the failed traces. */
export interface ObserveTraces extends ObserveTabBase {
  /** By count, at most 100. An error span is one with error status or an HTTP status of 400 or more. */
  groups: {
    name: string;
    /** Host of the request; empty when the span has none. */
    target: string;
    count: number;
    errors: number;
    /** `errors` / `count` (0..1). */
    errorShare: number;
    p50: number;
    p95: number;
    max: number;
    /** By status code, ascending; spans without an HTTP status are not in it. */
    statuses: { status: number; count: number }[];
  }[];
  /** Longest first, at most 50. */
  slowest: ObserveTraceSummary[];
  /** Latest first, at most 50: traces with at least one error span. */
  failed: ObserveTraceSummary[];
}

export interface ObserveTraceSummary {
  traceId: string;
  /** Name of the root span (the first span without a parent). */
  name: string;
  platform: string;
  appVersion: string;
  start: number;
  /** From the start of the first span to the end of the last one. */
  durationMs: number;
  spans: number;
  errors: number;
}

export interface ObserveTraceSpan {
  spanId: string;
  parentId: string | null;
  name: string;
  target: string | null;
  route: string | null;
  status: string;
  httpStatus: number | null;
  ts: number;
  /** Start relative to the start of the trace. */
  offsetMs: number;
  durationMs: number;
  children: ObserveTraceSpan[];
}

/** `GET /api/traces?trace=<trace id>`. Spans without a known parent are roots. */
export interface ObserveTraceDetail {
  traceId: string;
  start: number;
  durationMs: number;
  spans: number;
  platform: string;
  appVersion: string;
  environment: string;
  roots: ObserveTraceSpan[];
}
