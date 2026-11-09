// No browser/native imports: shared by the web collector (collector.ts) and the node tests (test/web.test.mjs).
// Only erasable TypeScript here (no enums, no parameter properties), node runs these files directly.
//
// Two payloads leave the browser, both to the open-observe Worker (see the README of this package):
//   <endpoint>/<projectId>/v1/{metrics,logs}  OTLP/JSON with an allowlist of events and attributes (what native sends)
//   <endpoint>/<projectId>/web                diagnostics JSON: Web Vitals, page load, JS errors
export const SDK_VERSION = '58.0.18';
export const PAYLOAD_VERSION = 1;
/** At most this many events in one request, the Worker refuses more. */
export const MAX_BATCH = 50;
/** Events kept in memory per queue while the network is not available; the oldest are dropped first. */
export const MAX_QUEUE = 200;
/** `fetch` with `keepalive` refuses a body over 64 KiB, so a request stays well below it. */
export const MAX_BODY_BYTES = 60_000;
/** localStorage key that switches collection off for this browser (any value except empty, `0` and `false`). */
export const OFF_KEY = 'open-observe.off';
/** Marks a request as a mirror of what the native module already sent to Expo: the Worker stores it and does not forward it again. */
export const MIRROR_HEADER = 'X-Open-Observe-Mirror';
/** Per-field limits, the server cuts again (message 500, stack 4000). */
export const MAX_NAME = 100;
export const MAX_MESSAGE = 500;
export const MAX_STACK = 4000;
/** One page load reports at most this many errors, and one distinct error at most this many times. */
export const MAX_ERRORS = 20;
export const MAX_SAME_ERROR = 3;

export type Scalar = string | number | boolean;
/** An event of the OTLP side (custom events and startup / navigation timing). */
export type WebEvent = { name: string; at: number; attributes: Record<string, Scalar> };
export type SessionMetadata = { sessionId: string; clientId: string; version: string; environment: string; serviceName?: string };

export type VitalName = 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB';
export type Rating = 'good' | 'needs-improvement' | 'poor';
export type DiagEvent =
  | { t: 'vital'; name: VitalName; value: number; rating: Rating; ts: number }
  | { t: 'nav'; name: 'page_load'; value: number; ts: number }
  | { t: 'error'; name: string; message: string; stack: string; handled: boolean; ts: number };
/** A diagnostics event with the route it belongs to; the route is batch level in the payload. */
export type RoutedEvent = { event: DiagEvent; route: string };
export type DiagMeta = { env: string; appVersion: string; session: string; device: { browser: string; viewport: string; connection: string } };

// web-vitals thresholds: good up to the first number, poor above the second (CLS unitless, the others in ms).
export const VITAL_LIMITS: Record<VitalName, readonly [number, number]> = {
  LCP: [2500, 4000],
  FCP: [1800, 3000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1800],
};
export const VITAL_NAMES = Object.keys(VITAL_LIMITS) as VitalName[];

export function vitalRating(name: VitalName, value: number): Rating {
  const [good, poor] = VITAL_LIMITS[name];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

const round = (value: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

/** A vital as the diagnostics payload carries it; null for a value that cannot be one. */
export function vitalEvent(name: VitalName, value: number, ts: number): DiagEvent | null {
  if (!VITAL_NAMES.includes(name) || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(ts)) return null;
  const v = name === 'CLS' ? round(value, 4) : round(value, 1);
  return { t: 'vital', name, value: v, rating: vitalRating(name, v), ts };
}

export function navEvent(value: number, ts: number): DiagEvent | null {
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000 || !Number.isSafeInteger(ts)) return null;
  return { t: 'nav', name: 'page_load', value: round(value, 1), ts };
}

// Error text may carry a page address with a query or a fragment, and a message may carry anything. The server scrubs
// again (e-mails, numbers, UUIDs); here only the length is cut and the query/fragment of an address is dropped.
// A stack frame ends in `:line:column`, which stays.
const URL_TAIL = /(\bhttps?:\/\/[^\s?#'")\]]*)[?#](?:(?!:\d+:\d+(?!\d))[^\s'")\]])*/gi;
export const stripUrlTails = (text: string): string => text.replace(URL_TAIL, '$1');

const NAME_OK = /^[A-Za-z][A-Za-z0-9_.$ -]{0,99}$/;

/** `name`, `message` and `stack` of whatever was thrown (an Error, a string, a plain object, nothing). */
export function describeError(thrown: unknown): { name: string; message: string; stack: string } {
  let name = 'Error', message = '', stack = '';
  try {
    if (thrown && typeof thrown === 'object') {
      const o = thrown as { name?: unknown; message?: unknown; stack?: unknown };
      if (typeof o.name === 'string' && NAME_OK.test(o.name)) name = o.name;
      if (typeof o.message === 'string') message = o.message;
      if (typeof o.stack === 'string') stack = o.stack;
    } else if (typeof thrown === 'string') message = thrown;
    else if (thrown != null) message = String(thrown);
  } catch { /* a hostile getter must not break monitoring */ }
  // a V8 stack starts with "Name: message": that is the message again, keep the frames only
  if (stack && message && stack.startsWith(`${name}: ${message}`)) stack = stack.slice(`${name}: ${message}`.length).replace(/^\n/, '');
  return { name: name.slice(0, MAX_NAME), message: stripUrlTails(message).slice(0, MAX_MESSAGE), stack: stripUrlTails(stack).slice(0, MAX_STACK) };
}

export function errorEvent(thrown: unknown, handled: boolean, ts: number): DiagEvent | null {
  if (!Number.isSafeInteger(ts)) return null;
  const { name, message, stack } = describeError(thrown);
  return { t: 'error', name, message, stack, handled, ts };
}

/** Same error, same key: name, message and the first frame. */
export const errorKey = (e: Extract<DiagEvent, { t: 'error' }>): string => `${e.name}\n${e.message}\n${e.stack.split('\n')[0] ?? ''}`;

// --- endpoint -----------------------------------------------------------------------------------------------------------

/** Where the web collector posts when nothing is configured: the page's own origin. */
export const DEFAULT_ENDPOINT = '/observe';
const ORIGIN_URL = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~\-/]*)?$/i;
const LOCAL_URL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[A-Za-z0-9._~\-/]*)?$/i;
// one slash then a path: `//host/x` is protocol-relative, another origin
const SAME_ORIGIN_PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/;

/**
 * The base of the Worker's ingest paths, from `extra.eas.observe.endpointUrl` (the key the native module reads, so one value
 * serves both): `https://host[/path]` (`http://localhost` for development) or a path of the page's own origin (`/observe`).
 * Without a value it is `/observe`. A value that is none of these (credentials, a query, a fragment, another scheme, `..`) gives
 * null: nothing is sent. A trailing slash is dropped; the project id and `/v1/...` or `/web` are appended by the collector.
 */
export function endpointBase(value?: unknown): string | null {
  if (value == null || value === '') return DEFAULT_ENDPOINT;
  if (typeof value !== 'string' || value.length > 300) return null;
  const url = value.replace(/\/+$/, '');
  if (url.split('/').some((part) => part === '..' || part === '.')) return null;
  if (url === '') return null;
  if (url.startsWith('/') && url.includes('//')) return null;
  return ORIGIN_URL.test(url) || LOCAL_URL.test(url) || SAME_ORIGIN_PATH.test(url) ? url : null;
}

// --- Do Not Track, Global Privacy Control, local switch ------------------------------------------------------------------

export type PrivacyInputs = {
  navigator?: { doNotTrack?: unknown; msDoNotTrack?: unknown; globalPrivacyControl?: unknown } | null;
  windowDoNotTrack?: unknown;
  storage?: { getItem(key: string): string | null } | null;
};

/** True when this browser asked not to be measured: nothing is collected or sent then. */
export function isOptedOut({ navigator, windowDoNotTrack, storage }: PrivacyInputs): boolean {
  const dnt = [navigator?.doNotTrack, navigator?.msDoNotTrack, windowDoNotTrack];
  if (dnt.some((v) => v === '1' || v === 1 || v === 'yes' || v === true)) return true;
  if (navigator?.globalPrivacyControl === true) return true;
  try {
    const off = storage?.getItem(OFF_KEY);
    if (off != null && off !== '' && off !== '0' && off !== 'false') return true;
  } catch { /* storage blocked: not an opt-out */ }
  return false;
}

// --- route templates ----------------------------------------------------------------------------------------------------

// Only source route templates supplied by useSegments(), never pathname or search params.
export function routeTemplate(segments: readonly string[]): string {
  const safe = segments.filter((s) => !/^\([^)]*\)$/.test(s));
  if (safe.length > 12 || safe.some((s) => !/^(?:[a-z][a-z0-9-]{0,40}|\[\[?(?:\.\.\.)?[a-zA-Z][a-zA-Z0-9]*\]?\])$/.test(s))) return '/[redacted]';
  return '/' + safe.join('/');
}

const PARAM_SEGMENT = /^\[\[?(?:\.\.\.)?[a-zA-Z][a-zA-Z0-9]*\]?\]$/;
// What routeTemplate() lets through as a literal segment: lowercase words, so a concrete id with capitals, dots or an
// address is never a route. An app that wants more than that lists every literal segment of its routes in `routeSegments`
// (see EventPolicy): a literal that is not listed, say a code that ended up in a path, is then not accepted either.
const LITERAL_SEGMENT = /^[a-z][a-z0-9-]{0,40}$/;

/** A route template as `routeTemplate` writes it, or null. `segments`: the only literals allowed (default: any LITERAL_SEGMENT). */
export function acceptRoute(value: unknown, segments?: ReadonlySet<string> | null): string | null {
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith('/')) return null;
  const parts = value.split('/').filter(Boolean);
  const literal = (p: string) => (segments ? segments.has(p) : LITERAL_SEGMENT.test(p));
  return parts.every((p) => literal(p) || PARAM_SEGMENT.test(p)) ? value : null;
}

// --- OTLP side ----------------------------------------------------------------------------------------------------------

/** Timing events become OTLP metrics (`expo.app_startup.*`, `expo.navigation.*`), never logs; the collector records them itself. */
export const RENDER_EVENT = 'open-observe.web.render';
export const INTERACTIVE_EVENT = 'open-observe.web.interactive';
export const TIMING_EVENTS = new Set([RENDER_EVENT, INTERACTIVE_EVENT]);

// A short label: letters, digits and the separators of a route template or an error code.
const LABEL = /^[A-Za-z0-9_.:\-[\]/]{1,60}$/;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_LIST = 200;

/**
 * What the app may log from the browser. Nothing else gets through: an event whose name is not listed, and an attribute whose key
 * or value is not allowed, is dropped (never sent, never stored). The built-in attributes are `phase` and `temperature` (the
 * timing events), `durationMs` (a number), `status` (an HTTP status), `code` and `reason` (short labels) and `route` (a route
 * template). Everything else an app wants is listed here, usually in `extra.openObserve.web` of app.json.
 */
export type EventPolicyConfig = {
  /** Names of the events `Observe.logEvent(name, { attributes })` may send from a browser. */
  events?: readonly string[];
  /** Attributes with a fixed set of string values: `{ plan: ['free', 'pro'] }`. */
  enums?: Readonly<Record<string, readonly string[]>>;
  /** Attributes that are a number from 0 to 3 600 000 (a count, a duration in ms). */
  numbers?: readonly string[];
  /** Attributes that are true or false. */
  flags?: readonly string[];
  /** Attributes that are a short label (letters, digits and `_ . : - [ ] /`, at most 60 characters). */
  labels?: readonly string[];
  /** Every literal segment of the app's routes. Without it any lowercase word is a route segment. */
  routeSegments?: readonly string[];
};

export type EventPolicy = {
  events: ReadonlySet<string>;
  enums: ReadonlyMap<string, ReadonlySet<string>>;
  numbers: ReadonlySet<string>;
  flags: ReadonlySet<string>;
  labels: ReadonlySet<string>;
  routeSegments: ReadonlySet<string> | null;
};

const strings = (value: unknown, accept: (item: string) => boolean): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && accept(v)).slice(0, MAX_LIST) : [];

/** Validates what an app configured (untrusted JSON from app.json) and drops what is malformed. */
export function createPolicy(config?: EventPolicyConfig | null): EventPolicy {
  const input: Record<string, unknown> = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const enums = new Map<string, Set<string>>([
    ['phase', new Set(['startup', 'navigation'])], ['temperature', new Set(['cold', 'warm'])],
  ]);
  const given = input.enums && typeof input.enums === 'object' && !Array.isArray(input.enums) ? Object.entries(input.enums) : [];
  for (const [key, values] of given.slice(0, MAX_LIST)) {
    if (KEY.test(key) && !BUILT_IN_KEYS.has(key)) enums.set(key, new Set(strings(values, (v) => LABEL.test(v))));
  }
  const keys = (value: unknown) => new Set(strings(value, (k) => KEY.test(k) && !BUILT_IN_KEYS.has(k)));
  const segments = strings(input.routeSegments, (v) => LITERAL_SEGMENT.test(v));
  return {
    events: new Set(strings(input.events, (n) => EVENT_NAME.test(n) && !TIMING_EVENTS.has(n))),
    enums,
    numbers: keys(input.numbers),
    flags: keys(input.flags),
    labels: keys(input.labels),
    routeSegments: Array.isArray(input.routeSegments) ? new Set(segments) : null,
  };
}
// keys with a rule of their own in sanitizeEvent: an app cannot give them another one
const BUILT_IN_KEYS = new Set(['phase', 'temperature', 'durationMs', 'status', 'code', 'reason', 'route']);
export const DEFAULT_POLICY: EventPolicy = createPolicy();

export function sanitizeEvent(name: unknown, at: number, input?: unknown, policy: EventPolicy = DEFAULT_POLICY): WebEvent | null {
  if (typeof name !== 'string' || !(TIMING_EVENTS.has(name) || policy.events.has(name)) || !Number.isSafeInteger(at) || at < 0) return null;
  const attributes: Record<string, Scalar> = {};
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && policy.enums.get(key)?.has(value)) attributes[key] = value;
      if (policy.flags.has(key) && typeof value === 'boolean') attributes[key] = value;
      if (policy.labels.has(key) && typeof value === 'string' && LABEL.test(value)) attributes[key] = value;
      // HTTP status of an api error, and an error code or a reason as a short label
      if (key === 'status' && typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) attributes[key] = value;
      if ((key === 'code' || key === 'reason') && typeof value === 'string' && LABEL.test(value)) attributes[key] = value;
      if ((key === 'durationMs' || policy.numbers.has(key)) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000) attributes[key] = value;
      if (key === 'route') {
        // Only routeTemplate()'s output is accepted; a concrete ID/code has no permission here.
        const route = acceptRoute(value, policy.routeSegments);
        if (route) attributes.route = route;
      }
    }
  }
  return { name, at: Math.floor(at), attributes };
}

export const stringAttribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
export const attribute = (key: string, value: Scalar) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { doubleValue: value } : { stringValue: value } });

const otlpResource = (metadata: SessionMetadata, serviceName = 'web') => ({ attributes: [
  stringAttribute('os.type', 'browser'), stringAttribute('os.name', 'web'),
  stringAttribute('os.version', 'unknown'), stringAttribute('device.model.name', 'Web browser'),
  stringAttribute('device.model.identifier', 'web'), stringAttribute('browser.language', 'und'),
  stringAttribute('telemetry.sdk.name', 'expo-observe'), stringAttribute('telemetry.sdk.version', SDK_VERSION),
  stringAttribute('telemetry.sdk.language', 'javascript'), stringAttribute('expo.sdk.version', '58.0.0'),
  stringAttribute('expo.react_native.version', '0.88.1'), stringAttribute('expo.eas_client.id', metadata.clientId),
  stringAttribute('service.name', serviceName), stringAttribute('service.version', metadata.version),
  stringAttribute('expo.environment', metadata.environment),
] });
export const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.27.0';
export const SCOPE = { name: 'expo-observe', version: SDK_VERSION };
export type OtlpResource = { attributes: { key: string; value: Record<string, string | number | boolean> }[] };

/** The OTLP log records of custom events (timing events are metrics, not logs); the resource is added by the caller. */
export function eventLogRecords(events: readonly WebEvent[], metadata: Pick<SessionMetadata, 'sessionId'>, policy: EventPolicy = DEFAULT_POLICY) {
  return events.slice(0, MAX_BATCH).flatMap((event) => {
    const clean = sanitizeEvent(event.name, event.at, event.attributes, policy);
    if (!clean || TIMING_EVENTS.has(clean.name)) return [];
    const time = String(BigInt(clean.at) * 1_000_000n);
    return [{ timeUnixNano: time, observedTimeUnixNano: time, severityNumber: 9, severityText: 'INFO', body: { stringValue: '' },
      attributes: [stringAttribute('session.id', metadata.sessionId), stringAttribute('event.name', clean.name),
        attribute('expo.in_sample_rate', true),
        ...Object.entries(clean.attributes).map(([key, value]) => attribute(key, value))],
    }];
  });
}

/** Custom events as OTLP logs. `resource` is the web one unless the caller (the native mirror) brings its own. */
export function toOtlpLogs(events: readonly WebEvent[], metadata: SessionMetadata, resource: OtlpResource = otlpResource(metadata, metadata.serviceName), policy: EventPolicy = DEFAULT_POLICY) {
  return { resourceLogs: [{
    resource,
    scopeLogs: [{ scope: SCOPE, logRecords: eventLogRecords(events, metadata, policy) }], schemaUrl: SCHEMA_URL,
  }] };
}

/** Startup and navigation timing as OTLP metrics, in seconds like the native ones. */
export function toOtlpMetrics(events: readonly WebEvent[], metadata: SessionMetadata, policy: EventPolicy = DEFAULT_POLICY) {
  const metrics = events.slice(0, MAX_BATCH).flatMap((event) => {
    const clean = sanitizeEvent(event.name, event.at, event.attributes, policy);
    if (!clean || typeof clean.attributes.durationMs !== 'number') return [];
    const { phase, temperature, route, durationMs } = clean.attributes;
    let name: string;
    if (clean.name === INTERACTIVE_EVENT) name = phase === 'startup' ? 'expo.app_startup.tti' : 'expo.navigation.tti';
    else if (clean.name === RENDER_EVENT) name = phase === 'startup' ? 'expo.app_startup.ttr' : temperature === 'warm' ? 'expo.navigation.warm_ttr' : 'expo.navigation.cold_ttr';
    else return [];
    return [{ name, unit: 's', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(clean.at) * 1_000_000n),
      asDouble: durationMs / 1000, attributes: [stringAttribute('session.id', metadata.sessionId),
        ...(typeof route === 'string' ? [stringAttribute('expo.route_name', route)] : [])],
    }] } }];
  });
  return { resourceMetrics: [{ resource: otlpResource(metadata, metadata.serviceName), scopeMetrics: [{ scope: SCOPE, metrics }], schemaUrl: SCHEMA_URL }] };
}

// --- diagnostics side ---------------------------------------------------------------------------------------------------

/** Request bodies of `/observe/<projectId>/web`: grouped by route, at most MAX_BATCH events and MAX_BODY_BYTES each. */
export function diagnosticsBodies(items: readonly RoutedEvent[], meta: DiagMeta): string[] {
  const byRoute = new Map<string, DiagEvent[]>();
  for (const { event, route } of items) {
    const list = byRoute.get(route);
    if (list) list.push(event); else byRoute.set(route, [event]);
  }
  const bodies: string[] = [];
  const make = (route: string, events: DiagEvent[]) => JSON.stringify({
    v: PAYLOAD_VERSION, env: meta.env, appVersion: meta.appVersion, updateId: null, route, session: meta.session, device: meta.device, events,
  });
  for (const [route, events] of byRoute) {
    let chunk: DiagEvent[] = [];
    for (const event of events) {
      if (chunk.length && (chunk.length >= MAX_BATCH || make(route, [...chunk, event]).length > MAX_BODY_BYTES)) {
        bodies.push(make(route, chunk));
        chunk = [];
      }
      chunk.push(event);
    }
    if (chunk.length) bodies.push(make(route, chunk));
  }
  return bodies;
}

/** `Chrome 126` from a user agent string (only this label leaves the browser, never the string). */
export function browserLabel(userAgent: string): string {
  const ua = String(userAgent ?? '');
  const pick = (re: RegExp) => ua.match(re)?.[1];
  const found: [string, string | undefined][] = [
    ['Edge', pick(/\bEdg(?:e|A|iOS)?\/(\d+)/)], ['Opera', pick(/\bOPR\/(\d+)/)], ['Samsung Internet', pick(/\bSamsungBrowser\/(\d+)/)],
    ['Firefox', pick(/\b(?:Firefox|FxiOS)\/(\d+)/)], ['Chrome', pick(/\b(?:Chrome|CriOS)\/(\d+)/)], ['Safari', pick(/\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//)],
  ];
  const hit = found.find(([, v]) => v);
  return hit ? `${hit[0]} ${hit[1]}` : 'unknown';
}

/** Viewport in 10 px steps, enough to tell a phone from a desktop without a fingerprint. */
export const viewportLabel = (width: number, height: number): string =>
  `${Math.round(width / 10) * 10}x${Math.round(height / 10) * 10}`;

// --- queue --------------------------------------------------------------------------------------------------------------

export type SendResult = 'accepted' | 'retry' | 'rejected';

/** Memory-only queue: bounded, one request in flight, a failed batch is retried with a back-off and then given up on. */
export class EventQueue<T> {
  private queue: T[] = [];
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private retryAt = 0;
  private generation = 0;
  private readonly maxSize: number;
  private readonly batchSize: number;
  private readonly attempts: number;
  /** `attempts`: how many times a batch is sent before it is given up on (3 = two retries, 2 = one retry). */
  constructor(maxSize = MAX_QUEUE, batchSize = MAX_BATCH, attempts = 3) {
    this.maxSize = maxSize;
    this.batchSize = batchSize;
    this.attempts = attempts;
  }
  get size() { return this.queue.length; }
  add(event: T) {
    if (this.queue.length >= this.maxSize) this.queue.shift();
    this.queue.push(event);
  }
  clear() { this.queue = []; this.failures = 0; this.retryAt = 0; this.generation++; }
  /** Everything now, in batches, without waiting for an answer: for a page that is going away. */
  drainNow(send: (events: readonly T[]) => Promise<SendResult>) {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize);
      try { send(batch).catch(() => {}); } catch { /* best effort */ }
    }
  }
  flush(send: (events: readonly T[]) => Promise<SendResult>, now = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.queue.length || now < this.retryAt) return Promise.resolve();
    const batch = this.queue.splice(0, this.batchSize), generation = this.generation;
    this.inFlight = (async () => {
      let result: SendResult;
      try { result = await send(batch); } catch { result = 'retry'; }
      if (generation !== this.generation) return;
      if (result === 'retry' && ++this.failures < this.attempts) {
        this.queue = [...batch, ...this.queue].slice(0, this.maxSize);
        this.retryAt = now + 5_000 * 2 ** (this.failures - 1);
      } else { this.failures = 0; this.retryAt = 0; }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
