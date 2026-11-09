// Native OTLP/JSON from expo-observe (iOS: ios/OpenTelemetry.swift, Android: OpenTelemetry.kt) and from the web adapter
// of @open-observe/expo, turned into rows for the telemetry tables. Names are taken from those sources:
//   resource attributes: os.type, os.name, os.version, device.model.name, device.model.identifier, browser.language,
//     telemetry.sdk.*, expo.sdk.version, expo.react_native.version, expo.eas_client.id, service.name, service.version,
//     expo.app.name, expo.app.build_number, expo.app.update_id, expo.app.updates.id, expo.app.updates.channel,
//     expo.app.updates.runtime_version, expo.environment, expo.eas_build.id
//   metric attributes: session.id, expo.route_name, expo.update_id, expo.custom_params (never stored)
//   log attributes: session.id, event.name, expo.in_sample_rate, exception.type, exception.message,
//     exception.stacktrace, expo.error.source, expo.error.is_fatal, expo.error.component_stack, expo.crash.*, plus
//     whatever the app logs itself
//   span attributes: session.id, http.request.method, url.full, server.address, server.port, http.response.status_code,
//     error.type, expo.route_name (if the producer sets it)
// Nothing here throws on odd input: a value that is not what it should be is skipped.
import { isObject } from './http';
import {
  cap,
  cleanUpdateId,
  MAX_BODY,
  safeAttributes,
  scrubLabel,
  scrubMessage,
  scrubRoute,
  scrubStack,
  scrubText,
} from './scrub';
import type { LogRow, MetricRow, Resource, SpanRow } from './types';

export const MAX_ROWS_PER_BATCH = 500;

type Attrs = Map<string, unknown>;

// OTAnyValue: exactly one of stringValue, intValue (a number from native clients, a string per the OTLP spec),
// doubleValue, boolValue, arrayValue, kvlistValue. Arrays and key-value lists are not kept.
export function anyValue(value: unknown): string | number | boolean | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (value.intValue !== undefined) {
    const n = Number(value.intValue);
    return typeof value.intValue === 'boolean' || !Number.isFinite(n) ? undefined : n;
  }
  if (typeof value.doubleValue === 'number' || typeof value.doubleValue === 'string') {
    const n = Number(value.doubleValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  return undefined;
}

export function attributeMap(list: unknown): Attrs {
  const out: Attrs = new Map();
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!isObject(item) || typeof item.key !== 'string') continue;
    const v = anyValue(item.value);
    if (v !== undefined) out.set(item.key, v);
  }
  return out;
}

const str = (attrs: Attrs, key: string): string | undefined => {
  const v = attrs.get(key);
  return typeof v === 'string' && v ? v : undefined;
};

// timeUnixNano is a JSON number (Android: rounded to what a double holds, about 256 ns at today's dates) or a string
// (OTLP spec, the web adapter). Milliseconds, or null when it is not a time.
export function nanosToMs(value: unknown): number | null {
  if (typeof value === 'string' && /^\d{1,25}$/.test(value)) {
    const ms = Number(BigInt(value) / 1_000_000n);
    return ms > 0 ? ms : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value / 1e6);
}

// The event time as stored: never in the future (a clock that runs ahead counts as "now"), and a time older than the
// retention (RETENTION_DAYS) or missing is the time the batch arrived.
export function eventTime(ts: number | null, now: number, retentionMs: number): number {
  if (ts === null || ts < now - retentionMs) return now;
  return Math.min(ts, now);
}

function platformOf(attrs: Attrs): string {
  const name = (str(attrs, 'os.name') ?? '').toLowerCase();
  if (name === 'ios' || name === 'ipados') return 'ios';
  if (name === 'android') return 'android';
  if (name === 'web') return 'web';
  switch ((str(attrs, 'os.type') ?? '').toLowerCase()) {
    case 'darwin':
      return 'ios';
    case 'linux':
      return 'android';
    case 'browser':
      return 'web';
  }
  return 'unknown';
}

// The resource of one resourceMetrics / resourceLogs / resourceSpans entry. The device is the model identifier only:
// `device.model.name` can be a name the owner gave the phone.
export function readResource(resource: unknown): Resource {
  const attrs = attributeMap(isObject(resource) ? resource.attributes : undefined);
  return {
    platform: platformOf(attrs),
    osVersion: scrubLabel(str(attrs, 'os.version'), 32),
    deviceModel: scrubLabel(str(attrs, 'device.model.identifier') ?? str(attrs, 'device.model.name'), 64),
    appVersion: scrubLabel(str(attrs, 'service.version'), 32) ?? 'unknown',
    updateId: cleanUpdateId(str(attrs, 'expo.app.updates.id') ?? str(attrs, 'expo.app.update_id')),
    environment: scrubLabel(str(attrs, 'expo.environment'), 40) ?? '',
    clientId: str(attrs, 'expo.eas_client.id') ?? null,
  };
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// expo.app_startup.tti -> app_startup; expo.unknown.physical -> unknown; a name outside the expo namespace -> other.
const TIME_CATEGORIES = new Set(['app_startup', 'updates', 'navigation']);
function metricCategory(name: string): string {
  const m = /^expo\.([a-z_]+)\./.exec(name);
  return m ? m[1] : 'other';
}

// Names are identifiers; a custom metric name from the app is cut down to the characters an identifier has.
const cleanName = (value: string, max = 100) => cap(value.replace(/[^A-Za-z0-9_.:-]/g, '_'), max);

export function parseMetrics(body: unknown): { resource: Resource; sessionRaw: string | null; row: MetricRow }[] {
  const out: { resource: Resource; sessionRaw: string | null; row: MetricRow }[] = [];
  if (!isObject(body)) return out;
  for (const rm of list(body.resourceMetrics)) {
    if (!isObject(rm)) continue;
    const resource = readResource(rm.resource);
    for (const sm of list(rm.scopeMetrics)) {
      if (!isObject(sm)) continue;
      for (const metric of list(sm.metrics)) {
        if (!isObject(metric) || typeof metric.name !== 'string' || !metric.name) continue;
        const name = cleanName(metric.name);
        const category = metricCategory(name);
        const gauge = isObject(metric.gauge) ? metric.gauge : isObject(metric.sum) ? metric.sum : null;
        for (const point of list(gauge?.dataPoints)) {
          if (!isObject(point)) continue;
          const raw = point.asDouble ?? point.asInt;
          const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          const attrs = attributeMap(point.attributes);
          out.push({
            resource,
            sessionRaw: str(attrs, 'session.id') ?? null,
            row: {
              ts: nanosToMs(point.timeUnixNano),
              category,
              name,
              // OTLP says seconds for the time metrics; they are stored in milliseconds like the web ones.
              value: TIME_CATEGORIES.has(category) ? Math.round(value * 1e6) / 1e3 : value,
              route: scrubRoute(str(attrs, 'expo.route_name')),
              updateId: cleanUpdateId(str(attrs, 'expo.update_id')),
            },
          });
        }
      }
    }
  }
  return out.slice(0, MAX_ROWS_PER_BATCH);
}

// Attributes the log row has columns for, or that say nothing about the event.
const LOG_COLUMN_ATTRS = new Set([
  'session.id',
  'event.name',
  'expo.in_sample_rate',
  'exception.type',
  'exception.message',
  'exception.stacktrace',
  'expo.error.component_stack',
  'expo.route_name',
]);

const EXCEPTION_EVENTS = new Set(['js.exception', 'native.exception', 'web.error']);

export function parseLogs(body: unknown): { resource: Resource; sessionRaw: string | null; row: LogRow }[] {
  const out: { resource: Resource; sessionRaw: string | null; row: LogRow }[] = [];
  if (!isObject(body)) return out;
  for (const rl of list(body.resourceLogs)) {
    if (!isObject(rl)) continue;
    const resource = readResource(rl.resource);
    for (const sl of list(rl.scopeLogs)) {
      if (!isObject(sl)) continue;
      for (const record of list(sl.logRecords)) {
        if (!isObject(record)) continue;
        const attrs = attributeMap(record.attributes);
        const name = cleanName(str(attrs, 'event.name') ?? 'log');
        const severityNumber = typeof record.severityNumber === 'number' ? record.severityNumber : 0;
        const severity = cap((typeof record.severityText === 'string' && record.severityText ? record.severityText : 'info').toLowerCase().replace(/[^a-z]/g, ''), 10) || 'info';
        const bodyValue = isObject(record.body) ? anyValue(record.body) : record.body;
        const text = typeof bodyValue === 'string' ? bodyValue : '';
        const isException = EXCEPTION_EVENTS.has(name) || attrs.has('exception.type') || attrs.has('exception.message');
        const fatal = attrs.get('expo.error.is_fatal') === true || name === 'native.exception';
        const isError = isException || severityNumber >= 17 || severity === 'error' || severity === 'fatal';

        const rest = [...attrs].filter(([key]) => !LOG_COLUMN_ATTRS.has(key));
        let errorType: string | null = null;
        let message: string | null = null;
        let stack: string | null = null;
        if (isError) {
          const type = str(attrs, 'exception.type') ?? (name === 'native.exception' ? 'NativeCrash' : 'Error');
          errorType = scrubLabel(type, 100) ?? 'Error';
          message = scrubMessage(str(attrs, 'exception.message') ?? text);
          stack = scrubStack(attrs.get('exception.stacktrace'));
        }
        out.push({
          resource,
          sessionRaw: str(attrs, 'session.id') ?? null,
          row: {
            ts: nanosToMs(record.timeUnixNano) ?? nanosToMs(record.observedTimeUnixNano),
            category: isError && fatal ? 'crash' : isError ? 'error' : 'event',
            name,
            route: scrubRoute(str(attrs, 'expo.route_name')),
            severity,
            body: isError ? message : text ? scrubMessage(text, MAX_BODY) : null,
            attrs: safeAttributes(rest),
            errorType,
            stack,
            // Set by withFingerprints() before the row is stored.
            fingerprint: null,
          },
        });
      }
    }
  }
  return out.slice(0, MAX_ROWS_PER_BATCH);
}

// OTLP SpanKind aside, a span has a status code: 0 unset, 1 ok, 2 error.
function spanStatus(status: unknown): string {
  const code = isObject(status) ? Number(status.code) : 0;
  return code === 2 ? 'error' : code === 1 ? 'ok' : 'unset';
}

const HEX_ID = /^[0-9a-f]{16,32}$/i;

export function parseSpans(body: unknown): { resource: Resource; row: SpanRow }[] {
  const out: { resource: Resource; row: SpanRow }[] = [];
  if (!isObject(body)) return out;
  for (const rs of list(body.resourceSpans)) {
    if (!isObject(rs)) continue;
    const resource = readResource(rs.resource);
    for (const ss of list(rs.scopeSpans)) {
      if (!isObject(ss)) continue;
      for (const span of list(ss.spans)) {
        if (!isObject(span) || typeof span.name !== 'string') continue;
        if (typeof span.traceId !== 'string' || typeof span.spanId !== 'string') continue;
        if (!HEX_ID.test(span.traceId) || !HEX_ID.test(span.spanId)) continue;
        const start = nanosToMs(span.startTimeUnixNano);
        const end = nanosToMs(span.endTimeUnixNano);
        const attrs = attributeMap(span.attributes);
        const httpStatus = Number(attrs.get('http.response.status_code'));
        out.push({
          resource,
          row: {
            ts: start,
            traceId: span.traceId.toLowerCase(),
            spanId: span.spanId.toLowerCase(),
            parentId: typeof span.parentSpanId === 'string' && HEX_ID.test(span.parentSpanId) ? span.parentSpanId.toLowerCase() : null,
            name: cap(scrubText(span.name), 100) || 'span',
            durationMs: start !== null && end !== null ? Math.max(0, end - start) : 0,
            status: spanStatus(span.status),
            httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
            target: spanTarget(attrs),
            route: scrubRoute(str(attrs, 'expo.route_name')),
          },
        });
      }
    }
  }
  return out.slice(0, MAX_ROWS_PER_BATCH);
}

// Only the host of the request is kept: the path of an API call carries ids.
function spanTarget(attrs: Attrs): string | null {
  const host = str(attrs, 'server.address');
  if (host) return scrubLabel(host, 100);
  const url = str(attrs, 'url.full');
  if (!url) return null;
  try {
    return scrubLabel(new URL(url).hostname, 100);
  } catch {
    return null;
  }
}
