# Compatibility policy

open-observe is an open replacement for Expo Observe with your own backend. The promise is simple: **what works with
`expo-observe` keeps working, and nothing here may break an app that already uses open-observe.**

## What is guaranteed

### 1. The client package (`@open-observe/expo`)

- Every export of the installed `expo-observe` (values and types) exists in both entries of the package, native and web, with a
  type that is assignable to the original (`default`, `Observe`, `AppMetrics`, `ObserveRoot` with `.wrap`, `ObserveErrorBoundary`,
  `ObserveInteractiveMarker`, `useObserve`, the integrations subpath, all exported types).
- The package may only **add** exports (today: `isObserveEnabled`, `setObserveEnabled`, the web policy options in
  `app.json`). It never removes or narrows one.
- This is enforced on every test run by `packages/expo/test/compat.test.mjs` (names) and `compat.check.ts` (types, `tsc`).
  After updating `expo-observe`, run `cd packages/expo && npm install && npm test`; a failure lists what the new version added.

### 2. The ingest protocol (Worker)

- `POST /observe/<projectId>/v1/{metrics,logs,traces}` accepts the OTLP/JSON batches exactly as the native `expo-observe` module
  sends them, with the same attribute names and the tolerated variants (numbers as numbers or strings, optional resource
  attributes). The Worker's tests use fixtures built from the attribute names of the real native sources.
- An unknown or newer attribute is ignored, never a reason to reject a batch. A request body is rejected only when it is malformed
  or over the limits.
- `POST /observe/<projectId>/web` is the diagnostics endpoint of the web collector. Its payload has a version field (`v`); older
  versions keep being accepted.
- Apps keep their configuration: `extra.eas.observe.endpointUrl` and the Expo project id as the path segment.
- Optional: the original batch can be forwarded unchanged to Expo Observe (`FORWARD_TO_EXPO`), so you can run both side by side.

### 3. The read API and the dashboard

- Responses only gain fields. A field is never removed or renamed, and a query parameter keeps its meaning. New endpoints are
  additive.
- The dashboard in this repository is just a client of that API. Any other client (a script, a Grafana datasource) keeps working
  across releases.

## What is not promised

- Internal storage (D1 tables) may change; migrations are always forward-only and additive where data would otherwise be lost.
- Behaviour that Expo Observe itself changes in a new SDK (new metrics, new attributes): open-observe follows with a release; until
  then the new data is ignored or stored as-is, never an error.

## Versioning

Semantic versioning. A release that changes the guarantees above is a major release and is announced in the changelog first.
