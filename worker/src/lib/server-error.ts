// The Worker's own failures (an unhandled exception or a 5xx) in the same database as the apps' errors, platform
// 'worker'. No user data is involved: the route is Hono's template (`/api/errors/:fingerprint`), the text is scrubbed like
// every other error text, and nothing that identifies a request or a person is kept.
import { fingerprint } from './fingerprint';
import { cap, scrubMessage, scrubRoute, scrubStack } from './scrub';

const COLUMNS = 'ts, received_at, platform, os_version, device_model, app_version, update_id, environment, client, session_id, category, name, route, severity, body, attrs, error_type, stack, fingerprint';

export async function recordServerError(
  env: { DB?: D1Database },
  error: unknown,
  routePath: string | null,
  now = Date.now(),
): Promise<void> {
  if (!env.DB) return;
  try {
    const type = cap(error instanceof Error && error.name ? error.name : 'Error', 64);
    const message = scrubMessage(error instanceof Error ? error.message : String(error));
    const stack = scrubStack(error instanceof Error ? error.stack : null);
    const route = scrubRoute(routePath);
    const print = await fingerprint(type, stack, message);
    await env.DB.prepare(`INSERT INTO obs_logs (${COLUMNS}) VALUES (?, ?, 'worker', NULL, NULL, 'worker', NULL, 'worker', NULL, NULL, 'error', ?, ?, 'error', ?, NULL, ?, ?, ?)`)
      .bind(now, now, type, route, message, type, stack, print)
      .run();
  } catch (e) {
    console.error('server error not recorded', e instanceof Error ? e.message : e);
  }
}
