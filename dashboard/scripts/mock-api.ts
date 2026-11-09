// A mock of the read API with realistic, seeded, made-up data, so the dashboard can be developed and screenshotted without
// the Worker (`npm run mock`). Nothing here is real telemetry. Same paths, query parameters and JSON shapes as the Worker:
// the return types come from src/api-types.ts, so `npm run typecheck` fails when they drift.
import type {
  ObserveErrorDetail,
  ObserveEventOccurrence,
  ObserveEvents,
  ObserveMetrics,
  ObserveNavigation,
  ObserveOverview,
  ObserveTraceDetail,
  ObserveTraceSpan,
  ObserveTraceSummary,
  ObserveTraces,
  ObserveUpdates,
  ObserveWebVitalName,
} from '../src/api-types.ts';

export const MOCK_TOKEN = process.env.MOCK_TOKEN ?? 'mock-admin-token-0123456789abcdef-0123456789';

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ---- seeded randomness: the same request always gives the same answer ----

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seeded = (...parts: (string | number)[]) => rng(hash(parts.join('|')));
const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const uuid = (r: () => number) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- the world: who runs which build ----

interface Cell {
  platform: string;
  version: string;
  env: string;
  weight: number;
  errorRate: number;
}
const CELLS: Cell[] = [
  { platform: 'ios', version: '2.4.0', env: 'production', weight: 30, errorRate: 0.012 },
  { platform: 'ios', version: '2.3.2', env: 'production', weight: 14, errorRate: 0.02 },
  { platform: 'ios', version: '2.3.0', env: 'production', weight: 3, errorRate: 0.03 },
  { platform: 'android', version: '2.4.0', env: 'production', weight: 34, errorRate: 0.018 },
  { platform: 'android', version: '2.3.2', env: 'production', weight: 12, errorRate: 0.027 },
  { platform: 'android', version: '2.3.0', env: 'production', weight: 2, errorRate: 0.04 },
  { platform: 'web', version: '2.4.0', env: 'production', weight: 20, errorRate: 0.01 },
  { platform: 'web', version: '2.3.2', env: 'production', weight: 4, errorRate: 0.014 },
  { platform: 'ios', version: '2.4.0', env: 'preview', weight: 2, errorRate: 0.05 },
  { platform: 'android', version: '2.4.0', env: 'preview', weight: 2, errorRate: 0.06 },
];
const TOTAL_WEIGHT = CELLS.reduce((s, c) => s + c.weight, 0);

interface Params {
  days: number;
  platform: string;
  version: string;
  env: string;
  from: number;
  to: number;
  now: number;
}

function parseParams(q: URLSearchParams): Params {
  const d = Number(q.get('days'));
  const days = Number.isInteger(d) && d >= 1 && d <= 30 ? d : 7;
  const now = Date.now();
  return {
    days,
    platform: q.get('platform') ?? '',
    version: q.get('version') ?? '',
    env: q.get('env') ?? '',
    from: Math.floor(now / DAY) * DAY - (days - 1) * DAY,
    to: now,
    now,
  };
}

const matches = (p: Params, c: Cell) => (!p.platform || c.platform === p.platform) && (!p.version || c.version === p.version) && (!p.env || c.env === p.env);
const activeCells = (p: Params) => CELLS.filter((c) => matches(p, c));
/** The share of all traffic the filters leave, 0..1. */
const share = (p: Params) => activeCells(p).reduce((s, c) => s + c.weight, 0) / TOTAL_WEIGHT;

function filterLists() {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return { platforms: uniq(CELLS.map((c) => c.platform)), versions: uniq(CELLS.map((c) => c.version)), environments: uniq(CELLS.map((c) => c.env)) };
}

const days = (p: Params) => Array.from({ length: p.days }, (_, i) => dayKey(p.from + i * DAY));

/** Sessions, installs, errors and crashes of one cell on one day (a weekly rhythm and noise). */
function cellDay(c: Cell, day: string) {
  const r = seeded('cell', c.platform, c.version, c.env, day);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const rhythm = weekday === 0 || weekday === 6 ? 0.72 : 1;
  const sessions = Math.round(c.weight * (6 + 3 * r()) * rhythm);
  const installs = Math.max(sessions ? 1 : 0, Math.round(sessions * (0.38 + 0.12 * r())));
  const errors = Math.round(sessions * c.errorRate * (0.6 + 0.8 * r()));
  const crashes = c.platform === 'web' ? 0 : Math.round(errors * 0.12 * r() * 2);
  return { sessions, installs, errors: errors + crashes, crashes };
}

function timeline(p: Params) {
  return days(p).map((day) => {
    const sum = { installs: 0, sessions: 0, errors: 0, crashes: 0 };
    for (const c of activeCells(p)) {
      const d = cellDay(c, day);
      sum.installs += d.installs;
      sum.sessions += d.sessions;
      sum.errors += d.errors;
      sum.crashes += d.crashes;
    }
    return { day, ...sum };
  });
}

// ---- metrics ----

interface MetricDef {
  name: string;
  category: string;
  /** Measurements per session. */
  perSession: number;
  p50: number;
  sigma: number;
  platforms: string[];
}
const METRICS: MetricDef[] = [
  { name: 'expo.app_startup.tti', category: 'app_startup', perSession: 0.9, p50: 1650, sigma: 0.45, platforms: ['ios', 'android'] },
  { name: 'expo.app_startup.ttr', category: 'app_startup', perSession: 0.9, p50: 1180, sigma: 0.42, platforms: ['ios', 'android'] },
  { name: 'expo.app_startup.cold_launch_time', category: 'app_startup', perSession: 0.35, p50: 1420, sigma: 0.5, platforms: ['ios', 'android'] },
  { name: 'expo.app_startup.warm_launch_time', category: 'app_startup', perSession: 0.55, p50: 520, sigma: 0.55, platforms: ['ios', 'android'] },
  { name: 'expo.app_startup.bundle_load_time', category: 'app_startup', perSession: 0.9, p50: 430, sigma: 0.4, platforms: ['ios', 'android'] },
  { name: 'expo.updates.download_time', category: 'updates', perSession: 0.04, p50: 2300, sigma: 0.7, platforms: ['ios', 'android'] },
  { name: 'expo.navigation.cold_ttr', category: 'navigation', perSession: 2.1, p50: 360, sigma: 0.55, platforms: ['ios', 'android'] },
  { name: 'expo.navigation.warm_ttr', category: 'navigation', perSession: 5.6, p50: 140, sigma: 0.6, platforms: ['ios', 'android'] },
  { name: 'expo.navigation.tti', category: 'navigation', perSession: 7.2, p50: 410, sigma: 0.6, platforms: ['ios', 'android'] },
  { name: 'page_load', category: 'web_nav', perSession: 1.2, p50: 1450, sigma: 0.55, platforms: ['web'] },
  { name: 'LCP', category: 'web_vital', perSession: 1, p50: 1900, sigma: 0.5, platforms: ['web'] },
  { name: 'FCP', category: 'web_vital', perSession: 1, p50: 1050, sigma: 0.45, platforms: ['web'] },
  { name: 'INP', category: 'web_vital', perSession: 0.8, p50: 130, sigma: 0.7, platforms: ['web'] },
  { name: 'TTFB', category: 'web_vital', perSession: 1, p50: 310, sigma: 0.6, platforms: ['web'] },
  { name: 'CLS', category: 'web_vital', perSession: 1, p50: 0.04, sigma: 0.9, platforms: ['web'] },
  { name: 'expo.app.memory_usage', category: 'resource', perSession: 0.6, p50: 182, sigma: 0.25, platforms: ['ios', 'android'] },
];

const Z = { p75: 0.674, p95: 1.645 };
function dist(p50: number, sigma: number) {
  const cut = (v: number) => Math.round(v * 1000) / 1000;
  return {
    avg: cut(p50 * Math.exp((sigma * sigma) / 2)),
    min: cut(p50 * Math.exp(-2.2 * sigma)),
    max: cut(p50 * Math.exp(3.1 * sigma)),
    p50: cut(p50),
    p75: cut(p50 * Math.exp(Z.p75 * sigma)),
    p95: cut(p50 * Math.exp(Z.p95 * sigma)),
  };
}

function metricRows(p: Params) {
  const cells = activeCells(p);
  const out: ObserveMetrics['metrics'] = [];
  for (const m of METRICS) {
    const sessions = cells.filter((c) => m.platforms.includes(c.platform)).reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).sessions, 0), 0);
    const count = Math.round(sessions * m.perSession);
    if (!count) continue;
    const r = seeded('metric', m.name, p.platform, p.version, p.env);
    out.push({ name: m.name, category: m.category, count, ...dist(m.p50 * (0.94 + 0.12 * r()), m.sigma) });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ---- routes ----

const ROUTES: { route: string; views: number; tti: number }[] = [
  { route: '/', views: 100, tti: 380 },
  { route: '/(tabs)/home', views: 84, tti: 460 },
  { route: '/items/[id]', views: 63, tti: 720 },
  { route: '/items', views: 55, tti: 540 },
  { route: '/search', views: 38, tti: 880 },
  { route: '/settings', views: 31, tti: 260 },
  { route: '/settings/account', views: 14, tti: 310 },
  { route: '/checkout/[step]', views: 12, tti: 1340 },
  { route: '/onboarding', views: 9, tti: 520 },
  { route: '/about', views: 4, tti: 190 },
];

function navigationRoutes(p: Params): ObserveNavigation['routes'] {
  const cells = activeCells(p);
  const sessionsTotal = cells.reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).sessions, 0), 0);
  const webOnly = cells.length > 0 && cells.every((c) => c.platform === 'web');
  const nativeOnly = cells.length > 0 && cells.every((c) => c.platform !== 'web');
  return ROUTES.map((rt) => {
    const r = seeded('route', rt.route, p.platform, p.version, p.env);
    const sessions = Math.round(sessionsTotal * (rt.views / 100) * (0.85 + 0.1 * r()));
    const views = Math.round(sessions * (1.1 + 1.2 * r()));
    const metrics: ObserveNavigation['routes'][number]['metrics'] = [];
    const add = (name: string, category: string, base: number, sigma: number, f: number) => {
      const count = Math.round(views * f);
      if (count) metrics.push({ name, category, count, ...pickPct(dist(base * (0.92 + 0.16 * r()), sigma)) });
    };
    if (!webOnly) {
      add('expo.navigation.tti', 'navigation', rt.tti, 0.55, 0.9);
      add('expo.navigation.cold_ttr', 'navigation', rt.tti * 0.7, 0.5, 0.35);
      add('expo.navigation.warm_ttr', 'navigation', rt.tti * 0.3, 0.55, 0.6);
    }
    if (!nativeOnly) {
      add('page_load', 'web_nav', rt.tti * 3, 0.5, 0.4);
      add('LCP', 'web_vital', rt.tti * 3.6, 0.45, 0.4);
    }
    const errors = Math.round(views * 0.006 * (rt.tti / 500) * r() * 2);
    return { route: rt.route, views, sessions, errors: nativeOnly ? 0 : errors, metrics };
  })
    .filter((rt) => rt.views > 0)
    .sort((a, b) => b.views - a.views);
}
const pickPct = ({ p50, p75, p95 }: ReturnType<typeof dist>) => ({ p50, p75, p95 });

function transitions(p: Params): ObserveNavigation['transitions'] {
  const total = activeCells(p).reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).sessions, 0), 0);
  const pairs: [string, string, number][] = [
    ['/', '/(tabs)/home', 0.42],
    ['/(tabs)/home', '/items', 0.3],
    ['/items', '/items/[id]', 0.34],
    ['/(tabs)/home', '/search', 0.16],
    ['/search', '/items/[id]', 0.14],
    ['/(tabs)/home', '/settings', 0.1],
    ['/settings', '/settings/account', 0.05],
    ['/items/[id]', '/checkout/[step]', 0.06],
    ['/', '/onboarding', 0.04],
  ];
  return pairs.map(([from, to, f]) => ({ from, to, count: Math.round(total * f * 1.6) })).filter((t) => t.count > 0).sort((a, b) => b.count - a.count);
}

// ---- errors ----

interface ErrorDef {
  name: string;
  message: string;
  base: number;
  crash: boolean;
  platforms: string[];
  versions: string[];
  route: string | null;
  stack: string;
}
const ERRORS: ErrorDef[] = [
  {
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'map')",
    base: 64,
    crash: false,
    platforms: ['web', 'ios', 'android'],
    versions: ['2.4.0', '2.3.2'],
    route: '/items',
    stack: "TypeError: Cannot read properties of undefined (reading 'map')\n    at ItemList (app/items/index.tsx:42:18)\n    at renderWithHooks (react-dom.js:15486:18)\n    at updateFunctionComponent (react-dom.js:19617:20)",
  },
  {
    name: 'NetworkError',
    message: 'Network request failed',
    base: 51,
    crash: false,
    platforms: ['ios', 'android'],
    versions: ['2.4.0', '2.3.2', '2.3.0'],
    route: null,
    stack: 'NetworkError: Network request failed\n    at fetchJson (lib/http.ts:28:11)\n    at async loadItems (lib/items.ts:17:20)',
  },
  {
    name: 'NativeCrash',
    message: 'EXC_BAD_ACCESS (SIGSEGV) in libhermes.so',
    base: 12,
    crash: true,
    platforms: ['android'],
    versions: ['2.3.2', '2.3.0'],
    route: null,
    stack: 'NativeCrash: EXC_BAD_ACCESS (SIGSEGV)\n    #0 hermes::vm::JSObject::getNamedOrIndexed\n    #1 hermes::vm::Interpreter::interpretFunction',
  },
  {
    name: 'ValidationError',
    message: 'Expected a number between 1 and 99, received 0',
    base: 33,
    crash: false,
    platforms: ['web', 'ios', 'android'],
    versions: ['2.4.0'],
    route: '/checkout/[step]',
    stack: 'ValidationError: Expected a number between 1 and 99, received 0\n    at parseQuantity (lib/checkout.ts:61:9)\n    at onSubmit (app/checkout/[step].tsx:88:22)',
  },
  {
    name: 'SecurityError',
    message: "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
    base: 22,
    crash: false,
    platforms: ['web'],
    versions: ['2.4.0', '2.3.2'],
    route: '/settings',
    stack: "SecurityError: Failed to read the 'localStorage' property from 'Window'\n    at readPreference (lib/storage.web.ts:9:21)\n    at SettingsScreen (app/settings.tsx:30:15)",
  },
  {
    name: 'TimeoutError',
    message: 'Request timed out after 15000 ms: GET /api/search',
    base: 18,
    crash: false,
    platforms: ['ios', 'android'],
    versions: ['2.4.0', '2.3.2'],
    route: '/search',
    stack: 'TimeoutError: Request timed out after 15000 ms\n    at timeout (lib/http.ts:44:15)',
  },
  {
    name: 'RangeError',
    message: 'Maximum call stack size exceeded',
    base: 6,
    crash: false,
    platforms: ['web'],
    versions: ['2.3.2'],
    route: '/items/[id]',
    stack: 'RangeError: Maximum call stack size exceeded\n    at flatten (lib/tree.ts:12:5)\n    at flatten (lib/tree.ts:15:12)\n    at flatten (lib/tree.ts:15:12)',
  },
  {
    name: 'NativeCrash',
    message: 'NSInvalidArgumentException: -[RCTView setSource:]: unrecognized selector',
    base: 5,
    crash: true,
    platforms: ['ios'],
    versions: ['2.3.0'],
    route: null,
    stack: 'NativeCrash: NSInvalidArgumentException\n    0 CoreFoundation __exceptionPreprocess\n    1 libobjc.A.dylib objc_exception_throw',
  },
];
const fingerprintOf = (e: ErrorDef) => hex(seeded('fp', e.name, e.message), 16);

function errorGroups(p: Params): ObserveOverview['errors'] {
  const out: ObserveOverview['errors'] = [];
  for (const e of ERRORS) {
    const cells = activeCells(p).filter((c) => e.platforms.includes(c.platform) && e.versions.includes(c.version));
    const f = cells.reduce((s, c) => s + c.weight, 0) / TOTAL_WEIGHT;
    const r = seeded('err', e.name, e.message, p.days);
    const count = Math.round(e.base * f * (p.days / 7) * 4 * (0.9 + 0.2 * r()));
    if (count < 1) continue;
    out.push({
      fingerprint: fingerprintOf(e),
      name: e.name,
      message: e.message,
      count,
      installs: Math.max(1, Math.round(count * (0.35 + 0.3 * r()))),
      firstSeen: p.from + Math.floor(r() * p.days * 0.6 * DAY),
      lastSeen: p.now - Math.floor(r() * 9 * HOUR),
      versions: [...new Set(cells.map((c) => c.version))].sort(),
      crash: e.crash,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export function errorDetail(fingerprint: string, p: Params): ObserveErrorDetail | null {
  const e = ERRORS.find((x) => fingerprintOf(x) === fingerprint);
  if (!e) return null;
  const r = seeded('occ', fingerprint);
  const cells = CELLS.filter((c) => e.platforms.includes(c.platform) && e.versions.includes(c.version));
  const occurrences: ObserveErrorDetail['occurrences'] = Array.from({ length: 12 }, (_, i) => {
    const c = pick(r, cells);
    return {
      ts: p.now - Math.floor((i * 2.3 + r() * 2) * HOUR),
      platform: c.platform,
      appVersion: c.version,
      environment: c.env,
      route: e.route,
      message: e.message,
      stack: i % 5 === 4 ? null : e.stack,
    };
  });
  return { fingerprint, name: e.name, occurrences };
}

// ---- web vitals, versions ----

function webVitals(p: Params): ObserveOverview['webVitals'] {
  const sessions = activeCells(p)
    .filter((c) => c.platform === 'web')
    .reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).sessions, 0), 0);
  if (!sessions) return [];
  const spec: [ObserveWebVitalName, number, number, number][] = [
    ['LCP', 2380, 0.68, 0.2],
    ['FCP', 1480, 0.8, 0.14],
    ['INP', 188, 0.82, 0.12],
    ['TTFB', 640, 0.84, 0.1],
    ['CLS', 0.07, 0.86, 0.08],
  ];
  return spec.map(([name, p75, good, ni]) => {
    const count = Math.round(sessions * (name === 'INP' ? 0.8 : 1));
    const g = Math.round(count * good);
    const n = Math.round(count * ni);
    return { name, count, p75, good: g, needsImprovement: n, poor: Math.max(0, count - g - n) };
  });
}

function versionRows(p: Params): ObserveOverview['versions'] {
  const rows = new Map<string, ObserveOverview['versions'][number]>();
  for (const c of activeCells(p)) {
    const key = `${c.platform}:${c.version}`;
    const row = rows.get(key) ?? { version: c.version, platform: c.platform, installs: 0, sessions: 0, errors: 0, lastSeen: 0 };
    for (const d of days(p)) {
      const x = cellDay(c, d);
      row.installs += x.installs;
      row.sessions += x.sessions;
      row.errors += x.errors;
    }
    // the newest build was seen minutes ago, an old one up to a day or two ago
    const age = (c.version === '2.4.0' ? 20 : c.version === '2.3.2' ? 12 * 60 : 40 * 60) * 60_000;
    row.lastSeen = Math.max(row.lastSeen, p.now - Math.floor(seeded('seen', key)() * age));
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

// ---- events ----

const EVENTS: { name: string; perSession: number; attrs: () => Record<string, string | number | boolean> }[] = [
  { name: 'screen.view', perSession: 8.4, attrs: () => ({}) },
  { name: 'item.created', perSession: 0.9, attrs: () => ({ kind: 'note', source: 'form' }) },
  { name: 'item.opened', perSession: 2.6, attrs: () => ({ kind: 'note' }) },
  { name: 'search.performed', perSession: 1.2, attrs: () => ({ results: 12, filtered: false }) },
  { name: 'export.completed', perSession: 0.12, attrs: () => ({ format: 'csv', rows: 240 }) },
  { name: 'sync.finished', perSession: 0.7, attrs: () => ({ ok: true, ms: 840 }) },
  { name: 'settings.changed', perSession: 0.18, attrs: () => ({ key: 'theme', value: 'dark' }) },
  { name: 'onboarding.completed', perSession: 0.05, attrs: () => ({ steps: 4, skipped: false }) },
  { name: 'checkout.started', perSession: 0.08, attrs: () => ({ items: 2 }) },
  { name: 'checkout.failed', perSession: 0.006, attrs: () => ({ reason: 'declined', step: 'payment' }) },
];

function eventRows(p: Params): ObserveEvents['events'] {
  const sessions = activeCells(p).reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).sessions, 0), 0);
  const installs = activeCells(p).reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).installs, 0), 0);
  return EVENTS.map((e) => {
    const r = seeded('event', e.name, p.days, p.platform, p.version, p.env);
    const count = Math.round(sessions * e.perSession * (0.95 + 0.1 * r()));
    return {
      name: e.name,
      count,
      installs: Math.min(installs, Math.max(count ? 1 : 0, Math.round(installs * Math.min(0.97, e.perSession * 0.45)))),
      sessions: Math.min(sessions, Math.max(count ? 1 : 0, Math.round(sessions * Math.min(0.97, e.perSession * 0.5)))),
      firstSeen: p.from + Math.floor(r() * 3 * HOUR),
      lastSeen: p.now - Math.floor(r() * 3 * HOUR),
    };
  })
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
}

function eventSeries(p: Params, name: string): ObserveEvents['series'] {
  const def = EVENTS.find((e) => e.name === name);
  return days(p).map((day) => {
    let count = 0;
    let installs = 0;
    for (const c of activeCells(p)) {
      const x = cellDay(c, day);
      const f = def ? def.perSession : EVENTS.reduce((s, e) => s + e.perSession, 0);
      count += Math.round(x.sessions * f);
      installs += Math.round(x.installs * Math.min(1, f * 0.45));
    }
    return { day, count, installs };
  });
}

function occurrences(p: Params, name: string): ObserveEventOccurrence[] {
  const def = EVENTS.find((e) => e.name === name);
  if (!def) return [];
  const r = seeded('occ-ev', name, p.platform, p.version, p.env);
  const cells = activeCells(p);
  if (!cells.length) return [];
  return Array.from({ length: 100 }, (_, i) => {
    const c = pick(r, cells);
    const rt = pick(r, ROUTES);
    return {
      ts: p.now - Math.floor((i * 17 + r() * 14) * 60_000),
      platform: c.platform,
      appVersion: c.version,
      environment: c.env,
      route: rt.route,
      attrs: { ...def.attrs(), ...(r() < 0.3 ? { variant: pick(r, ['a', 'b']) } : {}) },
    };
  });
}

// ---- updates ----

function updateRows(p: Params): ObserveUpdates['updates'] {
  interface Draft extends Omit<ObserveUpdates['updates'][number], 'adoption' | 'errorRate'> {}
  const drafts: Draft[] = [];
  for (const c of activeCells(p)) {
    if (c.platform === 'web') continue;
    const tot = days(p).reduce(
      (s, d) => {
        const x = cellDay(c, d);
        return { installs: s.installs + x.installs, sessions: s.sessions + x.sessions, errors: s.errors + x.errors, crashes: s.crashes + x.crashes };
      },
      { installs: 0, sessions: 0, errors: 0, crashes: 0 },
    );
    const r = seeded('upd', c.platform, c.version, c.env);
    // OTA updates of this build, newest first; the rest still runs the update embedded in the build
    const otas = c.version === '2.4.0' && c.env === 'production' ? [uuid(r), uuid(r)] : c.version === '2.3.2' ? [uuid(r)] : [];
    const shares = otas.length === 2 ? [0.55, 0.3, 0.15] : otas.length === 1 ? [0.35, 0.65] : [1];
    [...otas, null].forEach((updateId, i) => {
      const f = shares[i]!;
      const sessions = Math.round(tot.sessions * f);
      const errors = Math.round(tot.errors * f * (updateId ? 0.8 : 1.2));
      drafts.push({
        updateId,
        appVersion: c.version,
        platform: c.platform,
        firstSeen: p.from + Math.floor(r() * (updateId ? p.days * 0.5 : 0.1) * DAY),
        lastSeen: p.now - Math.floor(r() * (updateId ? 2 : 36) * HOUR),
        installs: Math.max(1, Math.round(tot.installs * f * 1.1)),
        currentInstalls: Math.max(0, Math.round(tot.installs * f * 0.8)),
        sessions,
        events: Math.round(sessions * 14.5),
        errors,
        crashes: Math.round(tot.crashes * f),
        errorSessions: Math.min(sessions, Math.round(errors * 0.8)),
      });
    });
  }
  const currentTotal = drafts.reduce((s, d) => s + d.currentInstalls, 0);
  return drafts
    .map((d) => ({ ...d, adoption: currentTotal ? d.currentInstalls / currentTotal : 0, errorRate: d.sessions ? d.errorSessions / d.sessions : 0 }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 100);
}

// ---- traces ----

const REQUESTS: { name: string; target: string; per: number; p50: number; errorShare: number; statuses: [number, number][] }[] = [
  { name: 'GET /api/items', target: 'api.example.com', per: 1.4, p50: 260, errorShare: 0.012, statuses: [[200, 0.97], [304, 0.0], [500, 0.01], [404, 0.02]] },
  { name: 'POST /api/items', target: 'api.example.com', per: 0.35, p50: 410, errorShare: 0.031, statuses: [[201, 0.95], [422, 0.04], [500, 0.01]] },
  { name: 'GET /api/search', target: 'api.example.com', per: 0.9, p50: 520, errorShare: 0.044, statuses: [[200, 0.93], [429, 0.03], [504, 0.04]] },
  { name: 'GET /api/me', target: 'api.example.com', per: 0.9, p50: 120, errorShare: 0.002, statuses: [[200, 0.99], [401, 0.01]] },
  { name: 'GET /v1/avatars/:id', target: 'cdn.example.com', per: 1.1, p50: 90, errorShare: 0.0, statuses: [[200, 1]] },
  { name: 'POST /v1/events', target: 'telemetry.example.net', per: 0.6, p50: 70, errorShare: 0.001, statuses: [[202, 1]] },
];

function traceIds(): string[] {
  const r = seeded('trace-ids');
  return Array.from({ length: 80 }, () => hex(r, 32));
}
const TRACE_IDS = traceIds();

/** One trace, built from its id (so the list and the detail always agree). */
function buildTrace(id: string, now: number): ObserveTraceDetail {
  const r = rng(hash(id));
  const index = TRACE_IDS.indexOf(id);
  const start = now - Math.floor(((index < 0 ? 0 : index) * 2.1 + r() * 2) * HOUR);
  const cell = pick(r, CELLS);
  const failed = r() < 0.22;
  let spanCounter = 0;
  const nextId = () => `${hex(r, 12)}${(spanCounter++).toString(16).padStart(4, '0')}`;
  const req = (parent: string | null, offset: number, def: (typeof REQUESTS)[number], bad: boolean): ObserveTraceSpan => {
    const status = bad ? pick(r, [500, 502, 504, 404]) : def.statuses[0]![0];
    return {
      spanId: nextId(),
      parentId: parent,
      name: def.name,
      target: def.target,
      route: null,
      status: bad ? 'error' : 'ok',
      httpStatus: status,
      ts: start + offset,
      offsetMs: offset,
      durationMs: Math.round(def.p50 * (bad ? 2.5 : 0.6 + r() * 1.5)),
      children: [],
    };
  };
  const rootName = pick(r, ['screen.load /items', 'screen.load /items/[id]', 'screen.load /search', 'action.submit checkout', 'app.launch']);
  const root: ObserveTraceSpan = { spanId: nextId(), parentId: null, name: rootName, target: null, route: rootName.split(' ')[1] ?? null, status: 'ok', httpStatus: null, ts: start, offsetMs: 0, durationMs: 0, children: [] };
  let cursor = 20 + Math.floor(r() * 40);
  const calls = 2 + Math.floor(r() * 4);
  for (let i = 0; i < calls; i++) {
    const def = pick(r, REQUESTS);
    const bad = failed && i === calls - 1;
    const call = req(root.spanId, cursor, def, bad);
    if (r() < 0.35) {
      const inner = req(call.spanId, 5, REQUESTS[3]!, false);
      inner.durationMs = Math.round(call.durationMs * 0.5);
      call.children.push(inner);
    }
    root.children.push(call);
    cursor += r() < 0.4 ? Math.round(call.durationMs * 0.3) : call.durationMs + 8;
  }
  root.durationMs = cursor + 30;
  if (failed) root.status = 'error';
  const count = (s: ObserveTraceSpan): number => 1 + s.children.reduce((n, c) => n + count(c), 0);
  return {
    traceId: id,
    start,
    durationMs: root.durationMs,
    spans: count(root),
    platform: cell.platform,
    appVersion: cell.version,
    environment: cell.env,
    roots: [root],
  };
}

const isBad = (s: ObserveTraceSpan) => s.status === 'error' || (s.httpStatus ?? 0) >= 400;
const errorCount = (s: ObserveTraceSpan): number => (isBad(s) ? 1 : 0) + s.children.reduce((n, c) => n + errorCount(c), 0);

function summaries(p: Params): ObserveTraceSummary[] {
  return TRACE_IDS.map((id) => buildTrace(id, p.now))
    .filter((t) => t.start >= p.from && (!p.platform || t.platform === p.platform) && (!p.version || t.appVersion === p.version) && (!p.env || t.environment === p.env))
    .map((t) => ({ traceId: t.traceId, name: t.roots[0]!.name, platform: t.platform, appVersion: t.appVersion, start: t.start, durationMs: t.durationMs, spans: t.spans, errors: errorCount(t.roots[0]!) }));
}

function traceGroups(p: Params): ObserveTraces['groups'] {
  const sessions = activeCells(p).reduce((s, c) => s + days(p).reduce((t, d) => t + cellDay(c, d).sessions, 0), 0);
  return REQUESTS.map((q) => {
    const count = Math.round(sessions * q.per * 3);
    const errors = Math.round(count * q.errorShare);
    const statuses = q.statuses.map(([status, f]) => ({ status, count: Math.round(count * f) })).filter((s) => s.count > 0).sort((a, b) => a.status - b.status);
    return { name: q.name, target: q.target, count, errors, errorShare: count ? errors / count : 0, p50: q.p50, p95: Math.round(q.p50 * 3.4), max: Math.round(q.p50 * 14), statuses };
  })
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count);
}

// ---- the routes ----

export interface MockResponse {
  status: number;
  body: unknown;
}

const notFound = (): MockResponse => ({ status: 404, body: { error: 'not found' } });

/** Answers `GET /api/<path>?<query>`; the caller has already checked the token. */
export function handle(pathname: string, q: URLSearchParams): MockResponse {
  const p = parseParams(q);
  const filters = filterLists();
  const range = { from: p.from, to: p.to, days: p.days };
  const name = (q.get('name') ?? '').trim().slice(0, 120);
  const category = (q.get('category') ?? '').trim().slice(0, 120);

  if (pathname === '/api/overview') {
    const tl = timeline(p);
    const sum = (k: 'installs' | 'sessions' | 'errors' | 'crashes') => tl.reduce((s, d) => s + d[k], 0);
    const sessions = sum('sessions');
    const metrics = metricRows(p).slice(0, 60);
    const events = eventRows(p);
    const body: ObserveOverview = {
      range,
      filters,
      totals: { events: Math.round(sessions * 14.5), installs: sum('installs'), sessions, errors: sum('errors'), crashes: sum('crashes') },
      timeline: tl.map((d) => ({ day: d.day, installs: d.installs, sessions: d.sessions, errors: d.errors })),
      metrics: metrics.map((m) => ({ name: m.name, category: m.category, count: m.count, avg: m.avg, p50: m.p50, p75: m.p75, p95: m.p95 })),
      events: events.map((e) => ({ name: e.name, count: e.count, installs: e.installs, lastSeen: e.lastSeen })),
      routes: navigationRoutes(p)
        .map((r) => ({ route: r.route, count: r.views, p50: r.metrics[0]?.p50 ?? 0, p75: r.metrics[0]?.p75 ?? 0 }))
        .sort((a, b) => b.p75 - a.p75)
        .slice(0, 30),
      errors: errorGroups(p),
      webVitals: webVitals(p),
      versions: versionRows(p),
    };
    return { status: 200, body };
  }

  const detail = /^\/api\/errors\/([^/]+)$/.exec(pathname);
  if (detail) {
    const d = errorDetail(decodeURIComponent(detail[1]!), p);
    return d ? { status: 200, body: d } : notFound();
  }

  if (pathname === '/api/navigation') {
    const body: ObserveNavigation = { range, filters, routes: navigationRoutes(p), transitions: transitions(p) };
    return { status: 200, body };
  }

  if (pathname === '/api/updates') {
    const tl = timeline(p);
    const body: ObserveUpdates = { range, filters, installs: tl.reduce((s, d) => s + d.installs, 0), updates: updateRows(p) };
    return { status: 200, body };
  }

  if (pathname === '/api/metrics') {
    const rows = metricRows(p);
    let selected: ObserveMetrics['selected'] = null;
    if (name) {
      const m = rows.find((r) => r.name === name && (!category || r.category === category));
      const r = seeded('series', name, category, p.platform, p.version, p.env);
      selected = {
        name,
        category: category || null,
        series: days(p).map((day) => {
          const base = m ? m.p50 * (0.85 + 0.3 * r()) : 0;
          const sigma = Math.log((m?.p95 ?? 1) / (m?.p50 || 1)) / Z.p95 || 0.4;
          return m
            ? { day, count: Math.round((m.count / p.days) * (0.7 + 0.6 * r())), p50: Math.round(base * 1000) / 1000, p75: Math.round(base * Math.exp(Z.p75 * sigma) * 1000) / 1000, p95: Math.round(base * Math.exp(Z.p95 * sigma) * 1000) / 1000 }
            : { day, count: 0, p50: 0, p75: 0, p95: 0 };
        }),
      };
    }
    const body: ObserveMetrics = { range, filters, metrics: rows, selected };
    return { status: 200, body };
  }

  if (pathname === '/api/events') {
    const rows = eventRows(p);
    const body: ObserveEvents = { range, filters, events: rows, series: eventSeries(p, name), occurrences: name ? occurrences(p, name) : [] };
    return { status: 200, body };
  }

  if (pathname === '/api/traces') {
    const trace = q.get('trace');
    if (trace !== null) {
      if (!/^[0-9a-f]{16,32}$/.test(trace)) return { status: 400, body: { error: 'invalid trace id' } };
      return TRACE_IDS.includes(trace) ? { status: 200, body: buildTrace(trace, p.now) } : notFound();
    }
    const all = summaries(p);
    const body: ObserveTraces = {
      range,
      filters,
      groups: traceGroups(p),
      slowest: [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, 50),
      failed: all.filter((t) => t.errors > 0).sort((a, b) => b.start - a.start).slice(0, 50),
    };
    return { status: 200, body };
  }

  return notFound();
}
