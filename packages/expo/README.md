# @open-observe/expo

The client package of [open-observe](../../README.md): a drop-in replacement for the JavaScript part of
[`expo-observe`](https://github.com/expo/expo/tree/main/packages/expo-observe) **58.0.18** (MIT, see `NOTICE`), plus a real
collector for the **web** (Web Vitals, JS errors, startup and screen timing) that sends to your own open-observe Worker.

> open-observe is not affiliated with or endorsed by Expo. Expo and Expo Observe are trademarks of 650 Industries, Inc.

- **Native (Android, iOS):** `src/` is the original, file for file. The native module stays the installed `expo-observe` package
  (autolinking), so `requireNativeModule('ExpoObserve')` still finds it, and **no native code and no native fingerprint
  changes** when you switch the import. Native data goes to your Worker through the config key Expo documents
  (`extra.eas.observe.endpointUrl`, see below).
- **Web:** the original web module of `expo-observe` is an empty stub, nothing leaves the browser. This package replaces it
  with a collector (`src/web/`). It is chosen by the `browser` condition in `package.json`: Metro uses that condition for the
  web platform (checked with `metro-resolver`: web resolves to `src/index.web.ts`, ios and android to `src/index.ts`).
- **Gate:** `setObserveEnabled(boolean)` / `isObserveEnabled()`. Default **off**: the web collector observes, queues and sends
  nothing until your app opens the gate (for example after the user consented), and closing it clears the queue. It does not
  touch the native module (native consent is the `endpointUrl` and the `Observe.configure` options of Expo).

## Install

The native module and the Expo packages this one builds on are peer dependencies, you very likely have them already:

```sh
npx expo install expo-observe expo-app-metrics expo-constants expo-router
npm install @open-observe/expo
```

`expo-observe` must be `~58.0.18` (this is the version the sources were copied from and tested with, see "Upgrading Expo").
`expo-router` and `@react-navigation/native` are only needed for the parts that use them (the web collector reads the route from
`expo-router`; `@open-observe/expo/integrations/react-navigation` needs React Navigation). Like `expo-observe` itself the
native part needs a development build or a store build, not Expo Go.

The package ships TypeScript sources (like `expo-observe` does with its `expo-source` condition); Metro compiles them.

Then change the import, nothing else:

```diff
- import { Observe, ObserveRoot, useObserve } from 'expo-observe';
+ import { Observe, ObserveRoot, useObserve } from '@open-observe/expo';
- import { ObserveNavigationContainer } from 'expo-observe/integrations/react-navigation';
+ import { ObserveNavigationContainer } from '@open-observe/expo/integrations/react-navigation';
```

Every name and type the original exports is exported here (`test/compat.test.mjs` and `test/compat.check.ts` check it, see
"Tests"). The only addition is the gate (`setObserveEnabled`, `isObserveEnabled`).

## Point an Expo app at an open-observe Worker

You need a running open-observe Worker (see [`worker/`](../../worker/README.md)) with your project id in its `PROJECT_IDS`.
The project id is a UUID. With EAS it is the EAS project id; without EAS use any UUID (`uuidgen`) and the same value in the
Worker and in the app (a build without EAS was not tried while writing this).

### Native (Android and iOS)

In `app.json` (or `app.config.js`):

```json
{
  "expo": {
    "extra": {
      "eas": {
        "projectId": "3f2b8c1e-5d4a-4e6b-9a7c-0d1e2f3a4b5c",
        "observe": {
          "endpointUrl": "https://observe.example.com/observe"
        }
      }
    }
  }
}
```

The native module posts OTLP/JSON to `<endpointUrl>/<projectId>/v1/metrics`, `/v1/logs` and `/v1/traces`, which is what the
Worker serves (`/observe/<projectId>/v1/{metrics,logs,traces}`). Notes from the native sources of `expo-observe` 58.0.18:

- The value is read from the configuration **embedded in the installed build** (not from an OTA update manifest). Changing it
  needs a new build. It is a configuration change, not a native code change.
- A build without the key keeps sending to Expo (`https://o.expo.dev`). Old builds in the field are not redirected.
- Starting from Expo's documentation of the [custom endpoint](https://docs.expo.dev/eas/observe/configuration/#custom-endpoint)
  everything else (sampling, `Observe.configure`, `ignoredEvents`, ...) works as documented there.
- If you also want Expo's dashboard, set `FORWARD_TO_EXPO=1` on the Worker: it stores the batch and forwards the original
  batch to Expo (`https://o.expo.dev/<projectId>/v1/...`).

### JavaScript and web

The JavaScript API is the one of `expo-observe` (`Observe.logEvent`, `Observe.reportError`, `ObserveRoot`, `useObserve`, ...).
On web it needs three things:

1. **Open the gate**, once the visitor agrees or you decide to collect (default off):

   ```ts
   import { setObserveEnabled } from '@open-observe/expo';

   setObserveEnabled(true); // false stops collecting and drops what is queued
   ```

2. **Where to send.** The web collector reads the same key as native, `extra.eas.observe.endpointUrl`, and the same
   `extra.eas.projectId`:
   - key not set: it posts to `/observe/<projectId>/...` on **the page's own origin**. Serve the web export from the Worker (its
     `assets` binding) or route `/observe/*` of your domain to the Worker.
   - `https://observe.example.com/observe`: it posts there, cross-origin. The Worker must then answer the browser's CORS
     preflight for your site: list your origin in the Worker's `ALLOWED_ORIGINS` (see the Worker README; this package's tests
     use a fake browser and a fake `fetch`, a real cross-origin round trip against a Worker is not covered by them).
   - A path of your own origin (`/telemetry`), or `http://localhost:<port>` for development, also work. Anything else (another
     scheme, credentials, a query, `..`) disables the web collector instead of sending somewhere unexpected.

3. **Wrap the app** like with `expo-observe`: `ObserveRoot` (or `ObserveRoot.wrap`) at the top gives startup and screen timing
   and an error boundary.

A development bundle (`__DEV__`) sends nothing unless you call `Observe.configure({ dispatchInDebug: true })`, like the native
module.

#### What the web collector sends

| Where | What |
|---|---|
| `<endpoint>/<projectId>/web` | Web Vitals (LCP, FCP, CLS, INP, TTFB), page load time, JS errors and unhandled promise rejections (name, message and stack, query strings and fragments of addresses removed, length limited), the route template, the browser name and major version, the viewport rounded to 10 px and the connection type |
| `<endpoint>/<projectId>/v1/metrics` | startup and screen timing as `expo.app_startup.{ttr,tti}` and `expo.navigation.{cold_ttr,warm_ttr,tti}` in seconds, exactly like native |
| `<endpoint>/<projectId>/v1/logs` | the events your app logs with `Observe.logEvent` that you allow (next section) |

Every request is a `POST` with `credentials: 'omit'`, no `Referer`, no redirect followed and no `Authorization` or cookie. The
session id and client id are random per page load, held in memory, never written to a cookie or `localStorage`. Nothing is
sent when the browser says Do Not Track or Global Privacy Control, or when `localStorage['open-observe.off']` is set to anything
but empty, `0` or `false` (a visitor's or an operator's off switch).

#### Allowing your own events and attributes

The web collector sends only what it was told to. `Observe.logEvent(name, { attributes })` from a browser is dropped unless
`name` is allowlisted, and an attribute is dropped unless its key and value are allowed. By default nothing of yours is allowed.
List what you need under `extra.openObserve.web` in `app.json`:

```json
{
  "expo": {
    "extra": {
      "openObserve": {
        "web": {
          "events": ["user.signed_in", "checkout.completed"],
          "enums": { "plan": ["free", "pro"] },
          "numbers": ["items"],
          "flags": ["created"],
          "labels": ["coupon"],
          "routeSegments": ["index", "sign-in", "settings", "account", "orders"]
        }
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `events` | event names that may be logged |
| `enums` | attribute with a fixed set of string values (`{ "plan": ["free", "pro"] }`) |
| `numbers` | attribute that is a number from 0 to 3 600 000 |
| `flags` | attribute that is `true` or `false` |
| `labels` | attribute that is a short label: letters, digits and `_ . : - [ ] /`, at most 60 characters (no spaces, no addresses) |
| `routeSegments` | every literal segment of your routes. With it, a route attribute containing any other literal is dropped (a code or an id that ended up in a path never leaves the browser). Without it any lowercase word is accepted as a segment, which is only as safe as your code is: always pass route **templates** (`/orders/[id]`, from `useSegments()`), never `pathname` |

Always allowed: `phase`, `temperature` (the timing events), `durationMs`, `status` (an HTTP status 100 to 599), `code` and
`reason` (short labels) and `route` (a route template). Malformed configuration is ignored entry by entry. Raw strings, e-mail
addresses, names, nested objects and everything else you pass are dropped before anything is queued.

#### Mirroring native events from JavaScript

If your app sends native telemetry to Expo and additionally re-sends some events from JavaScript to the Worker, mark those
requests with the header `X-Open-Observe-Mirror: 1`: the Worker stores them but does not forward them to Expo a second time.
The constant is `MIRROR_HEADER` in `src/web/protocol.ts` (not part of the public entry); the web collector itself never sets it.

## Privacy

What is and is not stored is decided by the Worker as well (hashing of ids, scrubbing, 30 days retention, see the Worker README).
This package guarantees on its side: events and attributes are allowlisted, error texts are cut and lose address queries and
fragments, route segments can be restricted to your own, the web collector is off until the gate is opened and honours Do Not
Track, Global Privacy Control and the local off switch, and nothing is persisted in the browser. As with any error text,
`message` and `stack` of an exception can still contain whatever your code puts into them: do not throw errors that contain
personal data. The Worker scrubs e-mail addresses, numbers and UUIDs from them again.

## Limits

At most 50 events per request, 200 queued events per queue (the oldest are dropped first, memory only), a request body below
60 000 bytes (browsers refuse `keepalive` bodies over 64 KiB), 20 errors per page load and 3 reports of the same error, a failed
batch is retried with a back-off and then dropped. The queue is flushed every 10 seconds and when the page is hidden.

## What differs from the original

Everything else in `src/` is byte for byte the original. The differences are exactly:

| File | Change |
|---|---|
| `src/index.ts` | two added lines: `export { isObserveEnabled, setObserveEnabled } from './gate'` |
| `src/gate.ts` | new |
| `src/index.web.ts`, `src/web/*` | new (the original `module.web.ts` stays in the tree but is not used on web) |
| `package.json` | name, version, `exports` with the `browser` condition |

`src/index.web.ts` is `.ts`, not `.tsx`, on purpose: for an import without extension (a `tsconfig` `paths` alias or a workspace
link to `src/index`) Metro tries the platform file for every extension in turn, so `index.web.tsx` would lose to `index.ts`. The
JSX is in `src/web/observe.tsx`. `src/web/protocol.ts` (payloads, allowlist, queue)
and `src/web/collector.ts` (browser side, every browser object injected) are plain TypeScript with no React Native imports, so
node runs and tests them directly.

## Upgrading Expo

After `expo install` bumped `expo-observe` and you ran `npm install` in this folder:

```sh
diff -r src node_modules/expo-observe/src
```

Expected output: only `Only in src: gate.ts`, `index.web.ts`, `web` and the two added lines of `index.ts`. Anything else is a
change of the original: copy it over (`cp -r node_modules/expo-observe/src/. src/`, then restore the table above), update the
version in `NOTICE`, in `peerDependencies` and `SDK_VERSION` in `src/web/protocol.ts`, and check that the native module still
matches (`Observe` in `src/module.ts` calls it by name, its methods are in `node_modules/expo-observe/build/types.d.ts`). The
web API in `src/web/observe.tsx` must keep the exports of the original `src/index.ts` and the members of `ObserveModule`.
`npm test` fails when it does not.

## Tests

```sh
npm install   # installs expo-observe and the type dependencies next to this package (devDependencies)
npm test      # node --test, Node 24 or newer (runs the TypeScript sources directly)
npm run typecheck
```

- `test/web.test.mjs`: the web collector with a fake browser (vitals, errors, queue, retry, opt-outs, gate, allowlist, endpoint,
  payload shapes, privacy properties).
- `test/compat.test.mjs`: the drop-in contract. Every export of `expo-observe` (read from
  `node_modules/expo-observe/build/index.d.ts`) must exist in both entries, the fork may only add the gate, `package.json`
  exposes every entry point of the original, and it runs `tsc` over `test/compat.check.ts`.
- `test/compat.check.ts` with `test/tsconfig.compat.json`: both entries are assigned to `typeof import('expo-observe')`, so a
  missing or incompatible export is a type error. The tsconfig is self-contained: `expo-observe`, `expo`, `react`,
  `expo-router`, ... are resolved from this package's own `node_modules` (installed by `npm install`, no other folder of the
  repository is needed). Without `npm install` the compat tests are reported as **skipped** with the reason, they are not
  silently green.

## License

MIT, see `LICENSE`. The copied files of `expo-observe` keep their own MIT notice in `NOTICE`.
