import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { recordServerError } from '../src/lib/server-error';

const rows = () => env.DB.prepare("SELECT * FROM obs_logs WHERE platform = 'worker' ORDER BY id").all<Record<string, unknown>>().then((r) => r.results);

describe('server errors in the observe database', () => {
  it('stores the type, a scrubbed message, the route template and a fingerprint, and nothing about the request', async () => {
    const error = new TypeError('cannot read x for alex.smith@example.org with code 123456789');
    await recordServerError(env, error, '/api/records/:id', 1_700_000_000_000);
    const [row] = (await rows()).slice(-1);
    expect(row).toMatchObject({ platform: 'worker', category: 'error', severity: 'error', name: 'TypeError', error_type: 'TypeError', route: '/api/records/:id', app_version: 'worker', environment: 'worker', ts: 1_700_000_000_000 });
    expect(String(row.body)).not.toContain('alex.smith@example.org');
    expect(String(row.body)).not.toContain('123456789');
    expect(String(row.fingerprint)).toMatch(/^[0-9a-f]{16}$/);
    expect(row.client).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.device_model).toBeNull();
  });

  it('groups the same failure under one fingerprint and tells a different one apart', async () => {
    // the same failure comes from the same place with a different value in the text
    const fail = (n: number) => new Error(`boom ${n}`);
    const [first, second] = [fail(111111), fail(222222)];
    await recordServerError(env, first, '/api/a');
    await recordServerError(env, second, '/api/a');
    await recordServerError(env, new RangeError('other'), '/api/a');
    const [a, b, c] = (await rows()).slice(-3);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it('never throws, also for a missing database or a value that is not an error', async () => {
    await expect(recordServerError({}, new Error('x'), '/api/a')).resolves.toBeUndefined();
    await expect(recordServerError(env, 'a plain string', null)).resolves.toBeUndefined();
    await expect(recordServerError(env, undefined, null)).resolves.toBeUndefined();
  });
});
