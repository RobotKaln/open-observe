// OTLP/JSON batches built from the attribute names that expo-observe 58.0.18 really sends (ios/OpenTelemetry.swift,
// android/.../OpenTelemetry.kt, expo-app-metrics 58.0.15), and the web diagnostics payload of @open-observe/expo.
export const CLIENT_ID = '4127C568-AF7F-46B4-8142-3561A04DE5F7';
export const SESSION_ID = '09CED20B-2CD4-4747-A93C-2D62CD9F7DE1';
export const UPDATE_ID = '9b3b89b6-2a3f-4d8c-8e2d-2db9f5d1f2a9';

type AnyValue = Record<string, unknown>;
export const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
export const b = (key: string, value: boolean) => ({ key, value: { boolValue: value } });
export const d = (key: string, value: number) => ({ key, value: { doubleValue: value } });
// Android sends a JSON number (the Swift encoder too), the OTLP spec says string: the Worker takes both.
export const i = (key: string, value: number, asString = false) => ({ key, value: { intValue: asString ? String(value) : value } as AnyValue });

type Platform = 'android' | 'ios';

// Resource attributes as toOTMetadata writes them: Android (linux, no browser language order guaranteed) or iOS (darwin).
export function resource(
  o: { platform?: Platform; clientId?: string; version?: string; environment?: string | null; updateId?: string | null } = {},
) {
  const platform = o.platform ?? 'android';
  const attributes = [
    s('service.name', 'com.example.app'),
    s('os.type', platform === 'android' ? 'linux' : 'darwin'),
    s('os.name', platform === 'android' ? 'Android' : 'iOS'),
    s('os.version', platform === 'android' ? '15' : '26.2'),
    s('device.model.name', platform === 'android' ? "Alex's Pixel" : 'iPhone (Simulator)'),
    s('device.model.identifier', platform === 'android' ? 'Pixel 9' : 'iPhone18,1'),
    s('browser.language', 'cs-CZ'),
    s('telemetry.sdk.name', 'expo-observe'),
    s('telemetry.sdk.version', '58.0.18'),
    s('telemetry.sdk.language', platform === 'android' ? 'kotlin' : 'swift'),
    s('expo.sdk.version', '58.0.0'),
    s('expo.react_native.version', '0.88.1'),
    s('expo.eas_client.id', o.clientId ?? CLIENT_ID),
    s('service.version', o.version ?? '1.8.1'),
    s('expo.app.name', 'Example App'),
    s('expo.app.build_number', '27'),
    s('expo.app.updates.channel', 'production'),
    s('expo.app.updates.runtime_version', '1.8.1'),
  ];
  if (o.updateId !== null) {
    attributes.push(s('expo.app.update_id', o.updateId ?? UPDATE_ID), s('expo.app.updates.id', o.updateId ?? UPDATE_ID));
  }
  if (o.environment !== null) attributes.push(s('expo.environment', o.environment ?? 'production'));
  return { attributes };
}

const SCOPE = { name: 'expo-observe', version: '58.0.18' };
const SCHEMA = 'https://opentelemetry.io/schemas/1.27.0';
const nanos = (ms: number, asString = false) => (asString ? String(BigInt(ms) * 1_000_000n) : ms * 1_000_000);

export type MetricInput = {
  name: string;
  seconds: number;
  at: number;
  route?: string;
  session?: string;
  updateId?: string;
  asString?: boolean;
};

// toOTMetric: unit "s", a gauge with one data point, attributes session.id and optionally expo.route_name,
// expo.update_id and expo.custom_params (a JSON string, never stored).
export function metricsBatch(metrics: MetricInput[], res = resource()) {
  return {
    resourceMetrics: [
      {
        resource: res,
        scopeMetrics: [
          {
            scope: SCOPE,
            metrics: metrics.map((m) => ({
              unit: 's',
              name: m.name,
              gauge: {
                dataPoints: [
                  {
                    timeUnixNano: nanos(m.at, m.asString),
                    asDouble: m.seconds,
                    attributes: [
                      s('session.id', m.session ?? SESSION_ID),
                      ...(m.route ? [s('expo.route_name', m.route)] : []),
                      ...(m.updateId ? [s('expo.update_id', m.updateId)] : []),
                      s('expo.custom_params', '{"expo.network.requests.slowest.host":"api.example.com"}'),
                    ],
                  },
                ],
              },
            })),
          },
        ],
        schemaUrl: SCHEMA,
      },
    ],
  };
}

export type LogInput = {
  event: string;
  at: number;
  severity?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  body?: string;
  attributes?: unknown[];
  asString?: boolean;
};
const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;

// toOTLogRecord: severityNumber/Text from the enum, body { stringValue }, attributes session.id, event.name,
// expo.in_sample_rate, then the log's own attributes.
export function logsBatch(logs: LogInput[], res = resource()) {
  return {
    resourceLogs: [
      {
        resource: res,
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: logs.map((l) => {
              const severity = l.severity ?? 'info';
              return {
                timeUnixNano: nanos(l.at, l.asString),
                observedTimeUnixNano: nanos(l.at, l.asString),
                severityNumber: SEVERITY[severity],
                severityText: severity.toUpperCase(),
                body: { stringValue: l.body ?? '' },
                attributes: [s('session.id', SESSION_ID), s('event.name', l.event), b('expo.in_sample_rate', true), ...(l.attributes ?? [])],
              };
            }),
          },
        ],
        schemaUrl: SCHEMA,
      },
    ],
  };
}

// makeExceptionLogRecord of expo-app-metrics: a js.exception log with exception.* and expo.error.* attributes.
export function jsException(
  o: { type?: string; message: string; stack?: string; fatal?: boolean; at: number; extra?: unknown[] },
  res = resource(),
) {
  return logsBatch(
    [
      {
        event: 'js.exception',
        at: o.at,
        severity: o.fatal ? 'fatal' : 'error',
        attributes: [
          s('expo.error.source', 'global'),
          b('expo.error.is_fatal', o.fatal ?? false),
          s('exception.type', o.type ?? 'TypeError'),
          s('exception.message', o.message),
          ...(o.stack ? [s('exception.stacktrace', o.stack)] : []),
          ...(o.extra ?? []),
        ],
      },
    ],
    res,
  );
}

export const hermesStack = (line: number, column: number) =>
  `TypeError: undefined is not a function\n    at renderRecord (address at index.android.bundle:1:${line}${column})\n    at RecordList (address at index.android.bundle:1:9${column})\n    at performWork (address at index.android.bundle:1:77${line})\n    at anonymous (address at index.android.bundle:1:5)`;

// toOTSpan: a client span for a network request; url.full keeps its query except for a few signature parameters.
export function tracesBatch(
  spans: { name?: string; at: number; ms: number; failed?: boolean; url?: string; status?: number; traceId?: string; spanId?: string; parentSpanId?: string }[],
  res = resource(),
) {
  return {
    resourceSpans: [
      {
        resource: res,
        scopeSpans: [
          {
            scope: SCOPE,
            spans: spans.map((sp, n) => ({
              traceId: sp.traceId ?? `0af7651916cd43dd8448eb211c80319${n}`,
              spanId: sp.spanId ?? `b7ad6b716920333${n}`,
              ...(sp.parentSpanId ? { parentSpanId: sp.parentSpanId } : {}),
              name: sp.name ?? 'GET',
              kind: 3,
              startTimeUnixNano: nanos(sp.at),
              endTimeUnixNano: nanos(sp.at + sp.ms),
              attributes: [
                s('session.id', SESSION_ID),
                s('http.request.method', 'GET'),
                s('url.full', sp.url ?? 'https://app.example.com/api/records/0f8fad5b-d9cb-469f-a165-70867728950e?token=abc123'),
                s('server.address', 'app.example.com'),
                i('server.port', 443),
                i('http.response.status_code', sp.status ?? 200, true),
              ],
              events: [],
              droppedEventsCount: 0,
              ...(sp.failed ? { status: { code: 2, message: 'timeout' } } : {}),
            })),
          },
        ],
        schemaUrl: SCHEMA,
      },
    ],
  };
}

// The payload of @open-observe/expo (POST /observe/<projectId>/web).
export function webBatch(
  events: Record<string, unknown>[],
  o: { route?: string; session?: string; env?: string; appVersion?: string } = {},
) {
  return {
    v: 1,
    env: o.env ?? 'web',
    appVersion: o.appVersion ?? '1.8.1',
    updateId: null,
    route: o.route ?? '/p/[code]',
    session: o.session ?? 'web-session-1',
    device: { browser: 'Chrome 126', viewport: '390x844', connection: '4g' },
    events,
  };
}
