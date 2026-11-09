# open-observe dashboard

A standalone web dashboard for [open-observe](../README.md): the seven views of Expo Observe (Overview, Navigation, Updates,
Metrics, Errors, Events, Traces) on top of the Worker's read API. It is a small [Preact](https://preactjs.com/) app in
TypeScript, built with esbuild to three static files (`index.html`, `app.js`, `app.css`, about 19 kB gzipped in total). There is no
framework runtime to host, no analytics and no third-party request: the page talks only to the Worker that serves it.

> open-observe is not affiliated with or endorsed by Expo. Expo and Expo Observe are trademarks of 650 Industries, Inc.

## What it shows

| View | Content |
| --- | --- |
| Overview | Events, installs, sessions, errors and crashes; sessions / installs / errors per day; Web Vitals with their good / needs improvement / poor split; app versions in use |
| Navigation | Per screen (route template): views, sessions, errors and load times (p50 / p75 / p95), sortable by views or slowest; the most frequent moves between screens |
| Updates | Per platform, app version and OTA update: first and last seen, install share, installs, sessions, events, errors, crashes, error rate |
| Metrics | Every metric with count, min, p50, p75, p95, max; a row opens its course by day |
| Errors | Error and crash groups with counts, installs, versions; a group opens its latest occurrences with message, screen and stack |
| Events | Events the app logged with counts, installs and sessions; the course by day; the latest occurrences of one event with their (already scrubbed) attributes |
| Traces | Requests by name and target (error share, p50, p95, HTTP status classes), the slowest and the failed traces, and one trace as a waterfall of nested spans |

The period (1, 7, 14 or 30 days) and the platform, version and environment filters apply to every view. They, and the view,
live in the URL hash (`#/traces?days=14&platform=ios`), so a link opens the same view. Answers are cached for 30 seconds; the
Refresh button asks again.

The UI is English only. It works from 360 px (tables turn into stacked rows, the tabs scroll sideways) to desktop, follows the
system light / dark setting unless you pick one (System / Light / Dark, remembered in `localStorage`), and is usable with a
keyboard (tabs follow the ARIA tab pattern: arrow keys, Home and End).

## Sign-in and privacy

The login screen asks for the Worker's `ADMIN_TOKEN`. The token is checked against the API, kept in `sessionStorage` (gone when
the tab closes; it falls back to memory if storage is blocked), and sent as `Authorization: Bearer <token>` with each request
to `/api/*` of the same origin. A `401` or `403` answer removes it and returns to the login screen. The token is never put in
a URL, logged or sent anywhere else. The dashboard stores nothing else except the theme choice.

The dashboard shows only what the Worker's read API returns: aggregates and the scrubbed rows the ingest stored. Serve it
over HTTPS (the default on `workers.dev` and custom domains).

## Setup

```sh
cd dashboard
npm install
npm run build        # writes dist/index.html, dist/app.js, dist/app.css
```

The Worker serves `dist/` through its `assets` binding (see `worker/README.md` and `worker/wrangler.jsonc`), for example
`"assets": { "directory": "../dashboard/dist", "binding": "ASSETS" }`, with `/api/*` and `/observe/*` handled by the Worker code.
The page uses relative URLs (`/api/overview`, ...), so it must be served from the same origin as the API; no CORS is needed.
Rebuild after changing the dashboard, then redeploy the Worker.

## Development

```sh
npm run mock         # http://127.0.0.1:8788/ (after `npm run build`)
npm run dev          # in a second terminal: rebuilds dist/ on every change
```

`npm run mock` serves `dist/` and a mock of the read API with seeded, made-up data (apps, routes, errors and traces are
invented; nothing is real telemetry). It prints the token to sign in with (`MOCK_TOKEN`, `PORT` and `MOCK_DELAY_MS` change
the defaults). It answers `401` without a token and `403` for a wrong one, like the Worker, and honours `days`, `platform`,
`version`, `env`, `name`, `category` and `trace`.

| Script | Does |
| --- | --- |
| `npm run build` | Production build into `dist/` |
| `npm run dev` | Watch build with inline source maps |
| `npm run mock` | Mock API plus static server |
| `npm run typecheck` | `tsc --noEmit` over the app, scripts and tests |
| `npm test` | Unit tests of the formatting and grouping code (`src/format.ts`) |

## API contract

`src/api-types.ts` holds the JSON shapes (`ObserveOverview`, `ObserveNavigation`, `ObserveUpdates`, `ObserveMetrics`,
`ObserveEvents`, `ObserveTraces`, `ObserveErrorDetail`, `ObserveTraceDetail`). It is an identical copy of
`worker/src/api-types.ts`; change both together. The mock API is typed with the same file, so `npm run typecheck` fails when the
mock drifts from the contract.

| Request | Answer |
| --- | --- |
| `GET /api/overview?days=&platform=&version=&env=` | `ObserveOverview` |
| `GET /api/errors/:fingerprint` | `ObserveErrorDetail` |
| `GET /api/navigation`, `/api/updates` (same parameters) | `ObserveNavigation`, `ObserveUpdates` |
| `GET /api/metrics?name=&category=` (+ same parameters) | `ObserveMetrics` |
| `GET /api/events?name=` (+ same parameters) | `ObserveEvents` |
| `GET /api/traces` (+ same parameters), `GET /api/traces?trace=<id>` | `ObserveTraces`, `ObserveTraceDetail` |

## Limits

- It is a read-only viewer: no alerts, no saved views, no export.
- Lists are as long as the API returns them (for example 300 metrics, 200 events, 100 screens); the dashboard does not page the
  tables, except the occurrences of an event (20 at a time).
- Times are shown in the browser's time zone; the "per day" buckets are UTC days, as the API computes them.
- Percentiles come from the API (nearest rank); the dashboard does not recompute anything.

## Screenshots

Made with headless Firefox against `npm run mock` (made-up data only): [`docs/`](docs/).
