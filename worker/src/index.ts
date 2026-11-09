// open-observe Worker: telemetry ingest at /observe/*, read API at /api/*, everything else is the static dashboard.
import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { purgeTelemetry } from './lib/housekeeping';
import { ApiError } from './lib/http';
import { recordServerError } from './lib/server-error';
import { api } from './routes/api';
import { observe } from './routes/ingest';

export const app = new Hono<AppEnv>().route('/api', api).route('/observe', observe);

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  // Answered by the Worker, not by the dashboard (the single-page fallback would answer 200 with index.html).
  if (['/api', '/observe'].some((p) => path === p || path.startsWith(`${p}/`))) {
    return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' });
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  // Failures of the Worker itself (not the expected 4xx answers) are kept for the dashboard.
  if (!(err instanceof ApiError) || err.status >= 500) {
    const recorded = recordServerError(c.env, err, c.req.routePath);
    try {
      c.executionCtx.waitUntil(recorded);
    } catch {
      // no execution context (a direct app.request call): the write is not awaited
    }
  }
  if (err instanceof ApiError) {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (err.status === 401) headers['WWW-Authenticate'] = 'Bearer';
    return c.json({ error: err.error, ...err.extra }, err.status, headers);
  }
  console.error(err);
  return c.json({ error: 'internal' }, 500, { 'Cache-Control': 'no-store' });
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Hourly (see "triggers" in wrangler.jsonc): raw rows older than RETENTION_DAYS and the old rate limit counters go.
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(purgeTelemetry(env, Date.now()).catch((e) => console.error('purge failed', e)));
  },
} satisfies ExportedHandler<Env>;
