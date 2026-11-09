// The browser side of the web collector, with every browser object injected (BrowserEnv) so node can test it with fakes.
// web/observe.tsx wires it to the real window. Nothing here imports React Native or Expo.
import {
  DEFAULT_POLICY, EventQueue, MAX_ERRORS, MAX_SAME_ERROR, browserLabel, diagnosticsBodies, errorEvent, errorKey, isOptedOut, navEvent,
  endpointBase, sanitizeEvent, toOtlpLogs, toOtlpMetrics, viewportLabel, vitalEvent, TIMING_EVENTS,
  type DiagEvent, type EventPolicy, type SendResult, type SessionMetadata, type VitalName, type WebEvent,
} from './protocol.ts';

type Listener = (event: any) => void;
type Target = { addEventListener(type: string, listener: Listener, options?: unknown): void; removeEventListener(type: string, listener: Listener): void };
type Entry = Record<string, any>;
type Observer = { observe(options: Record<string, unknown>): void; disconnect(): void };

/** What the collector needs from a browser; `browserEnv()` fills it from `globalThis`. */
export type BrowserEnv = {
  window: Target & { doNotTrack?: unknown; innerWidth?: number; innerHeight?: number };
  document: Target & { visibilityState?: string; readyState?: string };
  performance: { now(): number; getEntriesByType(type: string): Entry[] };
  PerformanceObserver?: (new (callback: (list: { getEntries(): Entry[] }) => void) => Observer) | undefined;
  navigator: {
    doNotTrack?: unknown; msDoNotTrack?: unknown; globalPrivacyControl?: unknown; userAgent?: string;
    connection?: { effectiveType?: string }; sendBeacon?: (url: string, data: unknown) => boolean;
  };
  storage: () => { getItem(key: string): string | null } | null;
  fetch?: ((url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>) | undefined;
  Blob?: (new (parts: string[], options: { type: string }) => unknown) | undefined;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
};

export function browserEnv(): BrowserEnv {
  const g = globalThis as any;
  return {
    window: g, document: g.document, performance: g.performance, PerformanceObserver: g.PerformanceObserver, navigator: g.navigator,
    storage: () => { try { return g.localStorage ?? null; } catch { return null; } },
    fetch: typeof g.fetch === 'function' ? g.fetch.bind(g) : undefined, Blob: g.Blob,
    setTimeout: (fn, ms) => g.setTimeout(fn, ms), clearTimeout: (id) => g.clearTimeout(id),
    setInterval: (fn, ms) => g.setInterval(fn, ms), clearInterval: (id) => g.clearInterval(id),
  };
}

export type CollectorOptions = {
  /** EAS project id (a UUID listed in the Worker's PROJECT_IDS): the path segment of the Worker's endpoints. */
  projectId: string;
  appVersion: string;
  /** Base of the Worker's ingest paths (`extra.eas.observe.endpointUrl`, see `endpointBase`). Default: `/observe` on the page's own origin. */
  endpointUrl?: unknown;
  /** The events and attributes the app may log (`createPolicy`); the default allows none of the app's own events. */
  policy?: EventPolicy;
  /** `service.name` of the OTLP resource. */
  serviceName?: string;
  environment?: string;
  env?: BrowserEnv;
  now?: () => number;
  random?: () => number;
  /** A development bundle sends nothing unless `dispatchInDebug` is set (like the native module). */
  isDev?: boolean;
  /** The gate (gate.ts): while it returns false nothing is queued or sent. Always on when omitted. */
  enabled?: () => boolean;
};

export type CollectorConfig = {
  environment?: string;
  dispatchingEnabled?: boolean;
  dispatchInDebug?: boolean;
  sampleRate?: number;
  errorSampleRate?: number;
  ignoredEvents?: string[];
};

const FLUSH_INTERVAL_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomId(random: () => number): string {
  const c = (globalThis as any).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export function createCollector(options: CollectorOptions) {
  const env = options.env ?? browserEnv();
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const projectId = UUID.test(options.projectId) ? options.projectId : null;
  const endpoint = endpointBase(options.endpointUrl);
  const base = projectId && endpoint ? `${endpoint}/${projectId}` : null;
  const policy = options.policy ?? DEFAULT_POLICY;

  let environment = options.environment ?? 'production';
  let dispatching = true;
  let dispatchInDebug = false;
  let inSample = true;
  let errorInSample = true;
  let ignored = new Set<string>();
  let started = false;
  let finalized = false;
  let route: string | null = null;
  let landingRoute: string | null = null;
  let hiddenAtStart = false;

  // Per page load, never stored: no cookie, no localStorage value, no account.
  const sessionId = randomId(random);
  const clientId = randomId(random);
  const metadata = (): SessionMetadata => ({ sessionId, clientId, version: options.appVersion, environment, serviceName: options.serviceName });

  const otlpQueue = new EventQueue<WebEvent>();
  const diagQueue = new EventQueue<{ event: DiagEvent; route: string | null }>();
  const errorCounts = new Map<string, number>();
  let errorTotal = 0;

  const optedOut = () => isOptedOut({
    navigator: env.navigator, windowDoNotTrack: env.window.doNotTrack, storage: safeStorage(),
  });
  function safeStorage() { try { return env.storage(); } catch { return null; } }
  /** Nothing is collected or sent: no endpoint, the gate is closed, the browser said no, a development bundle, or dispatching is off. */
  const isEnabled = options.enabled ?? (() => true);
  const off = () => !base || !isEnabled() || !dispatching || (options.isDev === true && !dispatchInDebug) || optedOut();

  // --- vitals ---------------------------------------------------------------------------------------------------------
  const vitals: { lcp: number | null; cls: number; inp: Map<number, number> } = { lcp: null, cls: 0, inp: new Map() };
  const reported = new Set<VitalName>();
  let clsSession = 0, clsFirst = 0, clsLast = 0;
  const observers: Observer[] = [];

  function addDiag(event: DiagEvent | null, at: 'landing' | 'current') {
    if (!event || off() || (event.t === 'error' ? !errorInSample : !inSample)) return;
    // a route that is not known yet (the router mounts after the first events) is filled in when the batch is sent
    diagQueue.add({ event, route: at === 'landing' ? landingRoute ?? route : route });
  }

  function reportVital(name: VitalName, value: number, at: 'landing' | 'current') {
    if (reported.has(name) || off()) return;
    reported.add(name);
    addDiag(vitalEvent(name, value, now()), at);
  }

  function observe(type: string, handler: (entries: Entry[]) => void, extra: Record<string, unknown> = {}) {
    const PO = env.PerformanceObserver;
    if (!PO) return;
    try {
      const observer = new PO((list) => { try { handler(list.getEntries()); } catch { /* monitoring never throws */ } });
      observer.observe({ type, buffered: true, ...extra });
      observers.push(observer);
    } catch { /* entry type not supported by this browser */ }
  }

  function interactionP98(): number | null {
    const durations = [...vitals.inp.values()].sort((a, b) => b - a);
    return durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))] : null;
  }

  /** LCP, CLS and INP keep changing until the page is hidden; they are reported once, then. */
  function finalize() {
    if (finalized) return;
    finalized = true;
    if (vitals.lcp != null && !hiddenAtStart) reportVital('LCP', vitals.lcp, 'landing');
    reportVital('CLS', vitals.cls, 'current');
    const inp = interactionP98();
    if (inp != null) reportVital('INP', inp, 'current');
  }

  function startVitals() {
    hiddenAtStart = env.document.visibilityState === 'hidden';
    observe('paint', (entries) => {
      for (const e of entries) if (e.name === 'first-contentful-paint' && !hiddenAtStart) reportVital('FCP', e.startTime, 'landing');
    });
    observe('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1];
      if (last) vitals.lcp = last.startTime;
    });
    observe('layout-shift', (entries) => {
      for (const e of entries) {
        if (e.hadRecentInput) continue;
        // one session window: shifts less than 1 s apart, at most 5 s long; the worst window is the score
        if (clsSession && e.startTime - clsLast < 1000 && e.startTime - clsFirst < 5000) clsSession += e.value;
        else { clsSession = e.value; clsFirst = e.startTime; }
        clsLast = e.startTime;
        vitals.cls = Math.max(vitals.cls, clsSession);
      }
    });
    observe('event', (entries) => {
      for (const e of entries) {
        if (!(e.interactionId > 0)) continue;
        vitals.inp.set(e.interactionId, Math.max(vitals.inp.get(e.interactionId) ?? 0, e.duration));
        // 150 interactions are more than the 98th percentile needs
        if (vitals.inp.size > 150) {
          const smallest = [...vitals.inp.entries()].sort((a, b) => a[1] - b[1])[0];
          vitals.inp.delete(smallest[0]);
        }
      }
    }, { durationThreshold: 40 });

    const nav = env.performance.getEntriesByType('navigation')[0];
    if (nav && nav.responseStart > 0) reportVital('TTFB', nav.responseStart - (nav.startTime ?? 0), 'landing');
    const reportLoad = () => {
      const entry = env.performance.getEntriesByType('navigation')[0];
      if (entry && entry.loadEventEnd > 0) addDiag(navEvent(entry.loadEventEnd - (entry.startTime ?? 0), now()), 'landing');
    };
    if (env.document.readyState === 'complete') reportLoad();
    // loadEventEnd is still 0 inside the load event itself
    else env.window.addEventListener('load', () => { env.setTimeout(reportLoad, 0); });
  }

  // --- errors ---------------------------------------------------------------------------------------------------------
  function reportError(thrown: unknown, handled: boolean) {
    try {
      const event = errorEvent(thrown, handled, now());
      if (!event || event.t !== 'error' || off() || !errorInSample) return;
      const key = errorKey(event);
      const seen = errorCounts.get(key) ?? 0;
      if (seen >= MAX_SAME_ERROR || errorTotal >= MAX_ERRORS) return;
      errorCounts.set(key, seen + 1);
      errorTotal++;
      addDiag(event, 'current');
    } catch { /* Monitoring must not turn a handled application error into a failure. */ }
  }

  const onError: Listener = (event) => {
    // a failed <img>/<script> load bubbles no error object and no message: nothing to learn from it
    if (event?.error != null || event?.message) reportError(event.error ?? event.message, false);
  };
  const onRejection: Listener = (event) => reportError(event?.reason, false);

  // --- OTLP side ------------------------------------------------------------------------------------------------------
  function record(name: string, attributes?: unknown) {
    if (off() || !inSample || ignored.has(name)) return;
    try {
      const event = sanitizeEvent(name, now(), attributes, policy);
      if (event) otlpQueue.add(event);
    } catch { /* never throws */ }
  }

  // --- transport ------------------------------------------------------------------------------------------------------
  /** One POST to the configured Worker (by default our own origin): no credentials, no Authorization, no Referer, no redirect followed. */
  async function post(path: string, body: string): Promise<SendResult> {
    if (!base) return 'rejected';
    const url = `${base}${path}`;
    if (env.fetch) {
      const response = await env.fetch(url, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body,
      });
      return response.ok ? 'accepted' : response.status === 429 || response.status >= 500 ? 'retry' : 'rejected';
    }
    // Last resort for a browser without fetch: sendBeacon cannot leave cookies out, so it is not the first choice.
    if (env.navigator.sendBeacon && env.Blob) return env.navigator.sendBeacon(url, new env.Blob([body], { type: 'application/json' })) ? 'accepted' : 'retry';
    return 'rejected';
  }

  const worst = (results: SendResult[]): SendResult => results.includes('retry') ? 'retry' : results.includes('accepted') ? 'accepted' : 'rejected';

  async function sendOtlp(events: readonly WebEvent[]): Promise<SendResult> {
    if (off()) return 'rejected';
    const meta = metadata();
    const results: Promise<SendResult>[] = [];
    if (events.some((e) => TIMING_EVENTS.has(e.name))) results.push(post('/v1/metrics', JSON.stringify(toOtlpMetrics(events, meta, policy))));
    if (events.some((e) => !TIMING_EVENTS.has(e.name))) results.push(post('/v1/logs', JSON.stringify(toOtlpLogs(events, meta, undefined, policy))));
    return worst(await Promise.all(results.map((p) => p.catch((): SendResult => 'retry'))));
  }

  function diagMeta() {
    const w = env.window;
    return {
      env: environment, appVersion: options.appVersion, session: sessionId,
      device: {
        browser: browserLabel(env.navigator.userAgent ?? ''),
        viewport: viewportLabel(w.innerWidth ?? 0, w.innerHeight ?? 0),
        connection: String(env.navigator.connection?.effectiveType ?? 'unknown').slice(0, 10),
      },
    };
  }

  async function sendDiagnostics(items: readonly { event: DiagEvent; route: string | null }[]): Promise<SendResult> {
    if (off()) return 'rejected';
    const bodies = diagnosticsBodies(items.map((i) => ({ event: i.event, route: i.route ?? landingRoute ?? route ?? '/[unknown]' })), diagMeta());
    return worst(await Promise.all(bodies.map((b) => post('/web', b).catch((): SendResult => 'retry'))));
  }

  /** Sends what is queued. `final` is the page going away: everything at once, no waiting, no retry. */
  async function flush(final = false) {
    if (off()) { otlpQueue.clear(); diagQueue.clear(); return; }
    if (final) {
      otlpQueue.drainNow(sendOtlp);
      diagQueue.drainNow(sendDiagnostics);
      return;
    }
    await Promise.all([otlpQueue.flush(sendOtlp, now()), diagQueue.flush(sendDiagnostics, now())]);
  }

  // --- lifecycle ------------------------------------------------------------------------------------------------------
  let timer: unknown = null;
  const onHidden = () => { finalize(); void flush(true); };
  const onVisibility: Listener = () => { if (env.document.visibilityState === 'hidden') onHidden(); };
  const onPageHide: Listener = () => onHidden();

  function start() {
    if (started || !isEnabled()) return;
    started = true;
    finalized = false;
    vitals.lcp = null; vitals.cls = 0; vitals.inp.clear();
    clsSession = 0; clsFirst = 0; clsLast = 0;
    if (optedOut()) return; // a browser that says no is not even observed; `off()` is still checked on every event
    env.window.addEventListener('error', onError);
    env.window.addEventListener('unhandledrejection', onRejection);
    env.window.addEventListener('pagehide', onPageHide);
    env.document.addEventListener('visibilitychange', onVisibility);
    startVitals();
    timer = env.setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  }

  function stop() {
    started = false;
    for (const o of observers.splice(0)) { try { o.disconnect(); } catch { /* gone already */ } }
    env.window.removeEventListener('error', onError);
    env.window.removeEventListener('unhandledrejection', onRejection);
    env.window.removeEventListener('pagehide', onPageHide);
    env.document.removeEventListener('visibilitychange', onVisibility);
    if (timer != null) env.clearInterval(timer);
    timer = null;
  }

  /** The gate changed: on starts observing (buffered entries of this page load are still there), off stops and forgets. */
  function setEnabled(on: boolean) {
    if (on) { start(); return; }
    stop();
    otlpQueue.clear();
    diagQueue.clear();
  }

  function configure(config: CollectorConfig) {
    if (config.environment) environment = config.environment;
    if (config.dispatchingEnabled !== undefined) dispatching = config.dispatchingEnabled;
    if (config.dispatchInDebug !== undefined) dispatchInDebug = config.dispatchInDebug;
    if (config.ignoredEvents) ignored = new Set(config.ignoredEvents);
    // one decision per page load: a visitor is in or out of the sample
    const clamp = (rate: number) => Math.min(Math.max(rate, 0), 1);
    const draw = random();
    inSample = config.sampleRate == null || draw < clamp(config.sampleRate);
    errorInSample = inSample || (config.errorSampleRate != null && draw < clamp(config.errorSampleRate));
    if (off()) { otlpQueue.clear(); diagQueue.clear(); }
  }

  return {
    start, stop, setEnabled, configure, record, flush, reportError,
    /** The route template of the screen in view; the first one is the page the visit landed on. */
    setRoute(next: string) { route = next; if (!landingRoute) landingRoute = next; },
    get sessionId() { return sessionId; },
    get clientId() { return clientId; },
    get optedOut() { return optedOut(); },
    get running() { return started; },
    get pending() { return { otlp: otlpQueue.size, diagnostics: diagQueue.size }; },
    /** Reports LCP, CLS and INP now instead of when the page is hidden (tests, and a page that never gets hidden). */
    finalize,
  };
}

export type Collector = ReturnType<typeof createCollector>;
