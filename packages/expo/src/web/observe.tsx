// The web build of @open-observe/expo, re-exported by ../index.web.ts (the `browser` condition of package.json picks that file).
//
// The original web module of expo-observe is an empty stub: nothing leaves the browser. This one is a real collector for your
// own open-observe Worker (see the README): the OTLP events the app logs, startup and screen timing, Web Vitals (LCP, FCP,
// CLS, INP, TTFB), page load time, JS errors and unhandled promise rejections. Same API as the original web module, so the
// app does not know which one it gets. The logic is in collector.ts and protocol.ts (tested in node).
import AppMetrics, {
  AppMetricsErrorBoundary,
  recordSpan,
  startSpan,
  withSpan,
  type AppMetricsErrorBoundaryFallbackProps,
  type AppMetricsErrorBoundaryProps,
  type AppMetricsRootProps,
  type LogEventOptions,
  type MetricAttributes,
} from 'expo-app-metrics';
import Constants from 'expo-constants';
import { useSegments } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, type ErrorInfo, type ReactNode } from 'react';

import { isObserveEnabled, subscribeObserveEnabled } from '../gate';
import type { ObserveConfig, ObserveIntegrationsConfig, ObserveModule, ObserveAttributes } from '../types';
import { createCollector, type Collector, type CollectorConfig } from './collector';
import { INTERACTIVE_EVENT, RENDER_EVENT, createPolicy, routeTemplate, type EventPolicyConfig } from './protocol';

/**
 * @deprecated Use `Observe` instead. `AppMetrics` is the legacy name of this API from SDK 55.
 */
export { default as AppMetrics } from 'expo-app-metrics';
export type {
  AppMetricsErrorBoundaryFallbackProps,
  AppMetricsErrorBoundaryProps,
  AppMetricsRootProps,
  ExpoAppMetricsModuleType,
  LogAttributeValue,
  LogEventOptions,
  LogSeverity,
  MetricAttributes,
} from 'expo-app-metrics';
export { isObserveEnabled, setObserveEnabled } from '../gate';
export type {
  ObserveAttribute,
  ObserveAttributes,
  ObserveConfig,
  ObserveIntegrationsConfig,
  ObserveModule,
  ObserveModuleEvents,
  ObserveNavigationIntegrationConfig,
  ObserveNetworkTracesConfig,
  ObserveReanimatedIntegrationConfig,
} from '../types';

// Created on first use and only in a browser (a static export renders on a server, where there is nothing to collect).
// It observes nothing until the gate is opened (`setObserveEnabled(true)`, gate.ts) and forgets everything when it is closed.
let collector: Collector | null | undefined;
function current(): Collector | null {
  if (collector !== undefined) return collector;
  collector = null;
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    const extra = Constants.expoConfig?.extra;
    const projectId = extra?.eas?.projectId;
    const slug = Constants.expoConfig?.slug;
    collector = createCollector({
      projectId: typeof projectId === 'string' ? projectId : '',
      // the same key the native module reads; without it the collector posts to /observe on the page's own origin
      endpointUrl: extra?.eas?.observe?.endpointUrl,
      policy: createPolicy(extra?.openObserve?.web as EventPolicyConfig | undefined),
      serviceName: typeof slug === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(slug) ? `${slug}.web` : 'web',
      appVersion: Constants.expoConfig?.version ?? 'unknown',
      environment: process.env.NODE_ENV ?? 'production',
      isDev: !!__DEV__,
      enabled: isObserveEnabled,
    });
    const created = collector;
    subscribeObserveEnabled((on) => created.setEnabled(on));
    created.start(); // does nothing while the gate is closed
  } catch { collector = null; }
  return collector;
}

const now = () => (typeof performance === 'undefined' ? 0 : performance.now());
const visited = new Set<string>();
let startupInteractive = false;
let startupRendered = false;

function record(name: string, attributes?: unknown) {
  current()?.record(name, attributes);
}

function reportError(error: unknown) {
  current()?.reportError(error, true);
}

async function dispatchEvents() {
  await current()?.flush();
}

function markFirstRender() {
  if (!isObserveEnabled()) return;
  if (!startupRendered) { startupRendered = true; record(RENDER_EVENT, { phase: 'startup', durationMs: now() }); }
}

function markInteractive(_attributes?: MetricAttributes) {
  if (!isObserveEnabled()) return;
  if (!startupInteractive) { startupInteractive = true; record(INTERACTIVE_EVENT, { phase: 'startup', durationMs: now() }); }
}

const web = {
  get clientId() { return current()?.clientId ?? null; },
  dispatchEvents,
  startSpan,
  withSpan,
  recordSpan,
  configure(config: ObserveConfig & { ignoredEvents?: string[] }) {
    current()?.configure(config as CollectorConfig);
  },
  getIntegrations(): ObserveIntegrationsConfig { return {}; },
  registerIntegration() { /* Web has no integration configuration and emits no `configure` event. */ },
  logEvent(name: string, options?: LogEventOptions) { record(name, options?.attributes); },
  reportError,
  markFirstRender,
  markInteractive,
  setGlobalAttributes(attributes?: ObserveAttributes | null) { AppMetrics.setGlobalAttributes(attributes); },
  setBundleDefaults(_defaults: { environment: string; isJsDev: boolean }) { /* The collector reads NODE_ENV itself. */ },
};

export const Observe = web as unknown as ObserveModule;

/** @deprecated Import the named `Observe` export instead. */
export default Observe;

// The original boundary (expo-app-metrics) is the base class, so the types are the original's own: `fallback` is required and can be
// an element, null or a function, the thrown value is `unknown`. The web part only adds the report to our collector.
export type ObserveErrorBoundaryFallbackProps = AppMetricsErrorBoundaryFallbackProps;
export type ObserveErrorBoundaryProps = AppMetricsErrorBoundaryProps;
export class ObserveErrorBoundary extends AppMetricsErrorBoundary {
  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    try {
      super.componentDidCatch(error, errorInfo);
    } catch {
      // the native logging of the original does not exist in a browser
    }
    reportError(error);
  }
}

/** The route template in view, from the router's segments (never from the address, so no value of a `[code]` leaks). */
function useRoute() {
  return routeTemplate(useSegments() as string[]);
}

function Collect({ children }: { children: ReactNode }) {
  const route = useRoute();
  current()?.setRoute(route);
  const renderStart = useMemo(() => ({ route, at: now() }), [route]);
  useEffect(() => {
    const started = renderStart.at;
    const frame = requestAnimationFrame(() => {
      markFirstRender();
      record(RENDER_EVENT, { route, phase: 'navigation', temperature: visited.has(route) ? 'warm' : 'cold', durationMs: now() - started });
      visited.add(route);
    });
    return () => cancelAnimationFrame(frame);
  }, [route, renderStart]);
  return children;
}

// The props are the original's (`AppMetricsRootProps`); the browser has no native module, so only the fallback of the boundary is used.
export function ObserveRoot({ children, errorBoundaryFallback }: AppMetricsRootProps & { children: ReactNode }) {
  return <ObserveErrorBoundary fallback={errorBoundaryFallback ?? null}><Collect>{children}</Collect></ObserveErrorBoundary>;
}

ObserveRoot.wrap = function wrap<P extends Record<string, unknown>>(Wrapped: React.ComponentType<P>): React.ComponentType<P> {
  const Root = (props: P) => <ObserveRoot><Wrapped {...props} /></ObserveRoot>;
  Root.displayName = `ObserveRoot(${Wrapped.displayName || Wrapped.name || 'Component'})`;
  return Root;
};

export function useObserve() {
  const route = useRoute();
  const timing = useMemo(() => ({ route, started: now() }), [route]);
  const marked = useRef<typeof timing | null>(null);
  const markNavigationInteractive = useCallback((_attributes?: MetricAttributes) => {
    if (marked.current === timing) return;
    marked.current = timing;
    markInteractive();
    record(INTERACTIVE_EVENT, { phase: 'navigation', route, durationMs: now() - timing.started });
  }, [route, timing]);
  return { markInteractive: markNavigationInteractive };
}

export type ObserveInteractiveMarkerProps = { params?: MetricAttributes['params'] };

export function ObserveInteractiveMarker(_props: ObserveInteractiveMarkerProps) {
  const { markInteractive: mark } = useObserve();
  useEffect(() => { mark(); }, [mark]);
  return null;
}
