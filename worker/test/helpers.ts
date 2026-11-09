import { SELF } from 'cloudflare:test';

export const BASE = 'http://observe.test';

// Must match the bindings in vitest.config.ts.
export const PROJECT_ID_1 = '98765432-aaaa-4bbb-8ccc-0123456789ab';
export const PROJECT_ID_2 = '11111111-2222-4333-8444-555555555555';
export const ADMIN_TOKEN = 'test-admin-token-0123456789-abcdefghijklmnop';

/** A request to the read API (`/api` + path), with the bearer token when one is given. */
export async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  return SELF.fetch(`${BASE}/api${path}`, { ...init, headers });
}
