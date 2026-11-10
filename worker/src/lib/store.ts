// Writing to the telemetry database: hashed identifiers, the batch dedupe and the request counter of the rate limit.
import { hmacHex } from './crypto';
import { retentionMs } from './config';
import type { Env } from '../env';
import { eventTime } from './otlp';
import type { ParsedBatch } from './types';

// 16 hex characters of an HMAC: enough to count unique installs and sessions, no way back to the id. The domain keeps
// a client id and a session id (or a rate limit key) with the same text from being the same value.
export async function hashId(pepper: string, domain: string, value: string): Promise<string> {
  return (await hmacHex(pepper, `${domain}:${value}`)).slice(0, 16);
}

export const RATE_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_PER_WINDOW = 60;

// Counts this request for the client address in the current minute. The key is an HMAC of address and minute: the
// address itself is never stored, and requests of different minutes are not linked. Returns the count including this
// request.
export async function countRequest(db: D1Database, pepper: string, address: string, now: number): Promise<number> {
  const window = Math.floor(now / RATE_WINDOW_MS);
  const key = await hashId(pepper, 'rate', `${address}:${window}`);
  const row = await db
    .prepare(
      `INSERT INTO obs_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(key, window * RATE_WINDOW_MS)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

// Daily byte budgets: the request bodies one client address may have stored in a UTC day, and the whole project
// (the ingest is public, so one source could otherwise fill the database). Far above what an app sends (a batch is a few KB,
// at most 512 KB), so a real install never meets them. Over a budget the request is answered 429 and nothing is stored.
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_BYTES_PER_ADDRESS = 10 * 1024 * 1024;
export const DAILY_BYTES_PER_PROJECT = 100 * 1024 * 1024;

// Adds `bytes` to a budget unless that passes `cap`: true when it fit (and is counted).
async function reserve(db: D1Database, key: string, day: number, bytes: number, cap: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO obs_budgets (key, day, bytes) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET bytes = bytes + ?3 WHERE bytes + ?3 <= ?4
       RETURNING bytes`,
    )
    .bind(key, day, bytes, cap)
    .first();
  return row !== null;
}

/**
 * Counts a body of `bytes` against the budget of its client address and of its project for today. Returns the seconds until
 * the budget renews (UTC midnight) when either is used up (nothing is counted then), otherwise null.
 */
export async function reserveBytes(
  db: D1Database,
  pepper: string,
  address: string,
  projectId: string,
  bytes: number,
  now: number,
): Promise<number | null> {
  const day = Math.floor(now / DAY_MS);
  const [addressKey, projectKey] = await Promise.all([
    hashId(pepper, 'bytes-address', `${address}:${day}`),
    hashId(pepper, 'bytes-project', `${projectId}:${day}`),
  ]);
  const retryAfter = Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000));
  if (!(await reserve(db, addressKey, day, bytes, DAILY_BYTES_PER_ADDRESS))) return retryAfter;
  if (!(await reserve(db, projectKey, day, bytes, DAILY_BYTES_PER_PROJECT))) {
    // This address did not use the bytes: give them back.
    await db.prepare('UPDATE obs_budgets SET bytes = MAX(bytes - ?2, 0) WHERE key = ?1').bind(addressKey, bytes).run();
    return retryAfter;
  }
  return null;
}

// D1 allows 100 bound parameters per statement: a batch of rows goes in as several multi-row INSERTs.
function insertRows(db: D1Database, table: string, columns: string[], rows: unknown[][]): D1PreparedStatement[] {
  const perStatement = Math.max(1, Math.floor(100 / columns.length));
  const statements: D1PreparedStatement[] = [];
  const one = `(${columns.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    statements.push(
      db
        .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => one).join(', ')}`)
        .bind(...chunk.flat() as (string | number | null)[]),
    );
  }
  return statements;
}

const METRIC_COLUMNS = ['ts', 'received_at', 'platform', 'os_version', 'device_model', 'app_version', 'update_id', 'environment', 'client', 'session_id', 'category', 'name', 'value', 'route'];
const LOG_COLUMNS = ['ts', 'received_at', 'platform', 'os_version', 'device_model', 'app_version', 'update_id', 'environment', 'client', 'session_id', 'category', 'name', 'route', 'severity', 'body', 'attrs', 'error_type', 'stack', 'fingerprint'];
const SPAN_COLUMNS = ['ts', 'received_at', 'trace_id', 'span_id', 'parent_id', 'name', 'duration_ms', 'status', 'http_status', 'target', 'route', 'platform', 'app_version', 'environment'];

/**
 * Stores a parsed batch once: the batch id (a hash of kind and body) and all its rows go in as one transaction, so a
 * batch that failed halfway is stored completely on its retry, and one that is already stored is not stored again.
 * Returns whether the batch was new.
 */
export async function storeBatch(
  env: Pick<Env, 'DB' | 'PEPPER' | 'RETENTION_DAYS'>,
  batch: { id: string; kind: string; bytes: number; parsed: ParsedBatch },
  now: number,
): Promise<boolean> {
  const db = env.DB;
  const retention = retentionMs(env);
  const seen = await db.prepare('SELECT 1 FROM obs_batches WHERE id = ?').bind(batch.id).first();
  if (seen) return false;
  const pepper = env.PEPPER;
  const hashes = new Map<string, string>();
  const hashed = async (domain: string, value: string | null) => {
    if (value === null) return null;
    const key = `${domain}:${value}`;
    let hash = hashes.get(key);
    if (hash === undefined) {
      hash = await hashId(pepper, domain, value);
      hashes.set(key, hash);
    }
    return hash;
  };

  const metrics: unknown[][] = [];
  for (const { resource: r, sessionRaw, row } of batch.parsed.metrics) {
    metrics.push([
      eventTime(row.ts, now, retention), now, r.platform, r.osVersion, r.deviceModel, r.appVersion, row.updateId ?? r.updateId,
      r.environment, await hashed('client', r.clientId), await hashed('session', sessionRaw), row.category, row.name, row.value, row.route,
    ]);
  }
  const logs: unknown[][] = [];
  for (const { resource: r, sessionRaw, row } of batch.parsed.logs) {
    logs.push([
      eventTime(row.ts, now, retention), now, r.platform, r.osVersion, r.deviceModel, r.appVersion, r.updateId, r.environment,
      await hashed('client', r.clientId), await hashed('session', sessionRaw), row.category, row.name, row.route,
      row.severity, row.body, row.attrs, row.errorType, row.stack, row.fingerprint,
    ]);
  }
  const spans = batch.parsed.spans.map(({ resource: r, row }) => [
    eventTime(row.ts, now, retention), now, row.traceId, row.spanId, row.parentId, row.name, row.durationMs, row.status,
    row.httpStatus, row.target, row.route, r.platform, r.appVersion, r.environment,
  ]);

  await db.batch([
    db.prepare('INSERT INTO obs_batches (id, kind, received_at, bytes) VALUES (?, ?, ?, ?)').bind(batch.id, batch.kind, now, batch.bytes),
    ...insertRows(db, 'obs_metrics', METRIC_COLUMNS, metrics),
    ...insertRows(db, 'obs_logs', LOG_COLUMNS, logs),
    ...insertRows(db, 'obs_spans', SPAN_COLUMNS, spans),
  ]);
  return true;
}
