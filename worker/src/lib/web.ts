// Web diagnostics of @open-observe/expo (POST /observe/<projectId>/web), our own format that is never forwarded to Expo:
//   { v: 1, env, appVersion, updateId, route, session, device: { browser, viewport, connection }, events: [...] }
// Vitals and navigation timings become metrics (category web_vital, web_nav, platform 'web', milliseconds; CLS is
// unitless), errors become logs (category 'error'). Events that are not what they should be are skipped.
import { isObject } from './http';
import { cap, cleanUpdateId, safeAttributes, scrubLabel, scrubMessage, scrubRoute, scrubStack } from './scrub';
import type { LogRow, MetricRow, ParsedBatch, Resource } from './types';

export const MAX_WEB_EVENTS = 50;
export const WEB_VITALS = ['LCP', 'FCP', 'CLS', 'INP', 'TTFB'] as const;
const VITALS = new Set<string>(WEB_VITALS);
const MAX_VALUE = 3_600_000;

// Thresholds of the web-vitals library: good up to the first, poor above the second.
export const WEB_VITAL_THRESHOLDS: Record<(typeof WEB_VITALS)[number], [number, number]> = {
  LCP: [2500, 4000],
  FCP: [1800, 3000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1800],
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class InvalidWebBatch extends Error {}

export function parseWeb(body: unknown): { parsed: ParsedBatch; session: string | null } {
  if (!isObject(body) || body.v !== 1 || !Array.isArray(body.events)) throw new InvalidWebBatch('invalid');
  if (body.events.length > MAX_WEB_EVENTS) throw new InvalidWebBatch('too_many_events');

  const device = isObject(body.device) ? body.device : {};
  const resource: Resource = {
    platform: 'web',
    osVersion: null,
    deviceModel: scrubLabel(device.browser, 40),
    appVersion: scrubLabel(body.appVersion, 32) ?? 'unknown',
    updateId: cleanUpdateId(body.updateId),
    environment: scrubLabel(body.env, 40) ?? 'web',
    clientId: null,
  };
  const route = scrubRoute(body.route);
  const session = typeof body.session === 'string' && body.session ? cap(body.session, 64) : null;
  // Small, fixed-shape strings only: "390x844", "4g".
  const context: [string, string][] = [];
  if (typeof device.viewport === 'string' && /^\d{2,5}x\d{2,5}$/.test(device.viewport)) context.push(['viewport', device.viewport]);
  if (typeof device.connection === 'string' && /^[a-z0-9-]{1,10}$/.test(device.connection)) context.push(['connection', device.connection]);

  const parsed: ParsedBatch = { metrics: [], logs: [], spans: [] };
  for (const event of body.events) {
    if (!isObject(event)) continue;
    const ts = finite(event.ts) && event.ts > 0 ? Math.floor(event.ts) : null;
    if (event.t === 'vital' || event.t === 'nav') {
      const name = typeof event.name === 'string' ? event.name : '';
      const vital = event.t === 'vital';
      if (vital ? !VITALS.has(name) : !/^[a-z][a-z0-9_]{0,31}$/.test(name)) continue;
      if (!finite(event.value) || event.value < 0 || event.value > MAX_VALUE) continue;
      const row: MetricRow = { ts, category: vital ? 'web_vital' : 'web_nav', name, value: event.value, route, updateId: null };
      parsed.metrics.push({ resource, sessionRaw: session, row });
    } else if (event.t === 'error') {
      const type = scrubLabel(event.name, 100) ?? 'Error';
      const message = scrubMessage(event.message);
      const row: LogRow = {
        ts,
        category: 'error',
        name: 'web.error',
        route,
        severity: 'error',
        body: message,
        attrs: safeAttributes([...context, ...(typeof event.handled === 'boolean' ? [['handled', event.handled] as [string, boolean]] : [])]),
        errorType: type,
        stack: scrubStack(event.stack),
        fingerprint: null,
      };
      parsed.logs.push({ resource, sessionRaw: session, row });
    }
  }
  return { parsed, session };
}
