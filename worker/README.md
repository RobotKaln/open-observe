# open-observe worker

The server half of open-observe: a Cloudflare Worker (with D1) that is a self-hosted, drop-in alternative to the
Expo Observe endpoint. It receives the telemetry that `expo-observe` sends from native apps and the diagnostics of the
web build, scrubs and stores it in your own D1 database, optionally forwards the original batch to Expo, and serves a read
API plus the static dashboard.

- **Ingest** (public, no sign-in): `POST /observe/<projectId>/v1/{metrics,logs,traces}` (OTLP/JSON, exactly what native
  `expo-observe` sends) and `POST /observe/<projectId>/web` (web diagnostics of `@open-observe/expo`).
- **Read API** (`GET /api/*`, bearer token): the data behind the seven dashboard tabs (Overview, Navigation, Updates,
  Metrics, Errors, Events, Traces).
- **Dashboard**: the build of `../dashboard`, served from the Worker's `assets` binding.
- **Housekeeping**: an hourly cron deletes rows older than the retention.

Not affiliated with or endorsed by Expo. Expo and Expo Observe are trademarks of 650 Industries, Inc.

## Setup

You need a Cloudflare account and Node 20 or newer (`wrangler` is installed by `npm install`).

```sh
cd worker
npm install

# 1. A D1 database (add --jurisdiction eu to keep the data in the EU). Paste the id it prints into
#    "database_id" in wrangler.jsonc.
npx wrangler d1 create open-observe

# 2. The schema (migrations/). Repeat after every update of this project: it only applies what is new.
npm run db:migrate

# 3. Secrets (see Configuration).
npx wrangler secret put ADMIN_TOKEN   # 32 or more random characters, e.g. `openssl rand -base64 36`
npx wrangler secret put PEPPER        # 16 or more random characters

# 4. Your Expo project id(s): "vars" -> PROJECT_IDS in wrangler.jsonc (extra.eas.projectId of your app.json).

# 5. Build the dashboard, then deploy the Worker together with it.
(cd ../dashboard && npm install && npm run build)
npm run deploy
```

Open the Worker's URL: the dashboard asks for the admin token (`ADMIN_TOKEN`). For local development copy
`.dev.vars.example` to `.dev.vars`, run `npm run db:migrate:local` and `npm run dev`.

## Configuration

| Name | Kind | Meaning |
|---|---|---|
| `DB` | D1 binding | The telemetry database (`migrations/`). |
| `ASSETS` | assets binding | The dashboard build (`../dashboard/dist`). |
| `ADMIN_TOKEN` | secret | Bearer token of the read API and the dashboard login. At least 32 characters; with a shorter or missing value every `/api/*` request is answered `503 api_disabled`. |
| `PEPPER` | secret | HMAC key for client ids, session ids and rate limit keys. At least 16 characters; otherwise ingest answers `503 misconfigured` (and stores nothing). Do not change it casually: unique installs restart from zero. |
| `PROJECT_IDS` | var | Comma-separated project ids (UUIDs) the ingest accepts. A request for any other id is `404`. Entries that are not UUIDs are ignored; while the list is empty every ingest request is `404`. |
| `FORWARD_TO_EXPO` | var | `"1"`: after storing, forward the original OTLP batch to `https://o.expo.dev/<projectId>/v1/<kind>` and return Expo's answer. Anything else: only store. Default off. |
| `RETENTION_DAYS` | var | Days raw rows are kept, 1 to 365, default 30. A wrong value means 30. |
| `ALLOWED_ORIGINS` | var | Comma-separated origins (`https://app.example.com`) that may POST to the ingest from a browser on another origin (CORS). Default empty: same origin only. A wildcard is never honoured. The read API never sends CORS headers. |

## Point your Expo app at it

**Native module** (`expo-observe`): set the endpoint in `app.json`. It is read at build time (it is part of the installed
build, not of an OTA update), so it needs a new build:

```json
{
  "expo": {
    "extra": {
      "eas": {
        "projectId": "00000000-0000-4000-8000-000000000000",
        "observe": { "endpointUrl": "https://observe.example.com/observe" }
      }
    }
  }
}
```

The native module posts to `<endpointUrl>/<projectId>/v1/{metrics,logs,traces}`, which is what this Worker serves.
Builds made without `endpointUrl` keep sending straight to Expo and do not show up here.

**JavaScript and web**: import from `@open-observe/expo` instead of `expo-observe` (same exports and types). On the web it
collects Web Vitals, navigation timings and errors and posts them to `/observe/<projectId>/web` of the endpoint; set
`ALLOWED_ORIGINS` when the app is served from a different origin than the Worker. See `../packages/expo/README.md`.

**Keep sending to Expo as well**: set `FORWARD_TO_EXPO` to `"1"`. The batch is stored first, then forwarded unchanged
(same bytes, 5 second limit) and Expo's status, body and `Retry-After` go back to the app, so the app retries and gives up
exactly as it would talking to Expo. If Expo does not answer, the app gets `503`, which also means "try again". A batch
sent with the header `X-Open-Observe-Mirror: 1` (a JavaScript mirror of events the native module already sent) is stored
but never forwarded, so Expo does not count it twice. Web diagnostics (`/web`) are never forwarded.

## Ingest rules

1. Order of checks: project id (`404`), configuration (`503`), request rate per client address (`429` with `Retry-After`,
   60 requests per minute), content type must be JSON (`415`), body at most 512 KiB (`413`).
2. Collecting is best effort: a body that cannot be parsed, or a storage error, is logged and never changes the answer
   (`200 {"partialSuccess":{}}`). The web endpoint answers `400 invalid_body` for a malformed diagnostics envelope and `204`
   otherwise.
3. Duplicates: a batch is stored once (`id` = SHA-256 of kind and body). A retry is not stored again, but it is still
   forwarded when forwarding is on.
4. At most 500 rows per OTLP batch and 50 events per web batch; every row passes the scrubbing described below.

## Read API

All endpoints are `GET`, return JSON with `Cache-Control: no-store`, and need `Authorization: Bearer <ADMIN_TOKEN>`
(compared in constant time): `401` without a token, `403` for a wrong one, `503` while `ADMIN_TOKEN` is too short. They are
meant for the dashboard on the same origin and send no CORS headers.

| Endpoint | Answer type (`src/api-types.ts`) |
|---|---|
| `/api/overview` | `ObserveOverview` |
| `/api/errors/:fingerprint` | `ObserveErrorDetail` (latest 20 occurrences of an error group) |
| `/api/navigation` | `ObserveNavigation` |
| `/api/updates` | `ObserveUpdates` |
| `/api/metrics?name=&category=` | `ObserveMetrics` |
| `/api/events?name=` | `ObserveEvents` |
| `/api/traces` and `/api/traces?trace=<trace id>` | `ObserveTraces`, `ObserveTraceDetail` |

Query parameters: `days` (1 to 30, default 7, otherwise `400 invalid_range`), `platform`, `version`, `env` (empty = all);
`name`, `category` and `trace` as listed. Percentiles are nearest-rank values computed in SQL; only aggregates and the
already scrubbed rows leave the database. `src/api-types.ts` is shared with the dashboard (`dashboard/src/api-types.ts`
has identical content).

## Privacy: what is and is not stored

Stored: platform, OS and app version, device model identifier, environment, OTA update id, metric names and values,
route templates (`/items/[id]`, not addresses), event names, scrubbed error text and stack, a capped set of allowed event
attributes, span name, duration, status and the host of a request.

Not stored: IP address, User-Agent, account or user id, the raw install id (EAS client id) or session id, query strings
and fragments, request paths of network spans (only the host), `expo.custom_params`, the device's given name
(`device.model.name`), component stacks, update channel and runtime version.

- **Identifiers**: the install id and session id are stored as the first 16 hex characters of an HMAC-SHA-256 keyed with
  `PEPPER`. That is enough to count unique installs and sessions, and gives no way back to the id.
- **Rate limiting**: the client address (`CF-Connecting-IP`) only feeds an HMAC with the current minute; that key is kept
  for an hour. The address itself is never stored or logged.
- **Text**: error messages, stacks and log bodies are scrubbed before they are stored: e-mail addresses, UUIDs, long tokens
  (32 or more characters), hex codes of 8 or more characters, long digit runs and numbers written with a slash become
  markers (`[email]`, `[uuid]`, `[token]`, `[hex]`, `[num]`). Addresses lose their query and fragment. Messages and bodies
  are capped at 500 characters, stacks at 4000.
- **Routes** are trusted no further than that: an address is reduced to its path, then scrubbed like text.
- **Attributes** whose name contains `params`, `body`, `header`, `token`, `email`, `password`, `passwd`, `authorization`,
  `cookie`, `secret` or `phone` are dropped; only scalar values are kept, at most 20 attributes and 2000 bytes of JSON.
- **Error groups** (`fingerprint`): the error type plus the first three stack frames without paths, line numbers and
  hashes.
- **Retention**: raw rows are deleted `RETENTION_DAYS` (default 30) after they arrived; the cron runs hourly.
- **The Worker's own failures** (unhandled exceptions, 5xx) are stored as errors of platform `worker` with a route
  template, scrubbed text and nothing about the request.

Scrubbing is pattern based and cannot recognise every kind of personal data. Do not log personal data on purpose, and
review what your app logs before pointing production traffic here.

## Limits

- Metrics are gauge or sum data points only; histograms are skipped. Array and key-value attribute values are not kept.
- Time metrics (`expo.app_startup.*`, `expo.updates.*`, `expo.navigation.*`) are stored in milliseconds (OTLP sends seconds).
- An event time in the future counts as now, and an event older than the retention (or without a time) counts as the
  time it arrived.
- The read API looks back at most 30 days, whatever `RETENTION_DAYS` is.
- Rate limiting is per client address and minute (60 requests), so many apps behind one address share that budget.
- D1 limits apply (bound parameters per statement, database size); rows are written in batches that respect them.
- Not stored, therefore not shown (compared with Expo Observe): IP address, User-Agent, location, request URLs, update
  channel, runtime version and build number.
- Retention needs the cron trigger (`triggers.crons` in `wrangler.jsonc`); without it nothing is deleted.

## Development

```sh
npm install
npm test            # vitest with @cloudflare/vitest-plugin, runs in the Workers runtime, no network needed
npm run typecheck   # tsc --noEmit
```

Source layout: `src/routes/ingest.ts` (ingest, CORS, forwarding), `src/routes/api.ts` with `read-overview.ts` and
`read-tabs.ts` (read API), `src/middleware/auth.ts` (bearer token), `src/lib/*` (OTLP and web parsing, scrubbing,
fingerprints, storage, configuration, retention), `migrations/` (D1 schema: `0001_observe.sql` creates the tables,
`0002_spans_indexes.sql` adds the span indexes for the Traces tab).

The tests send the attribute names that native `expo-observe` really uses (`test/fixtures.ts`), so a change that breaks
compatibility with it fails them.

## License

MIT, see the license file at the root of the repository.
