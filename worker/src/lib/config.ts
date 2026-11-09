// Reads the Worker's variables. Everything here is forgiving about what an operator may have typed, and strict about
// what it lets through: an unusable value means "off" or "default", never "allow everything".
import type { Env } from '../env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MIN_ADMIN_TOKEN_LENGTH = 32;
export const MIN_PEPPER_LENGTH = 16;
export const DEFAULT_RETENTION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** The project ids the ingest accepts: the entries of PROJECT_IDS that are UUIDs, in lower case. */
export function projectIds(env: Pick<Env, 'PROJECT_IDS'>): Set<string> {
  return new Set(list(env.PROJECT_IDS).map((id) => id.toLowerCase()).filter((id) => UUID.test(id)));
}

export const isProject = (env: Pick<Env, 'PROJECT_IDS'>, id: string) => UUID.test(id) && projectIds(env).has(id);

export const forwardEnabled = (env: Pick<Env, 'FORWARD_TO_EXPO'>) => env.FORWARD_TO_EXPO === '1';

export const adminTokenUsable = (env: Pick<Env, 'ADMIN_TOKEN'>) =>
  typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN_LENGTH;

export const pepperUsable = (env: Pick<Env, 'PEPPER'>) => typeof env.PEPPER === 'string' && env.PEPPER.length >= MIN_PEPPER_LENGTH;

/** Days of retention: RETENTION_DAYS when it is a whole number from 1 to 365, otherwise 30. */
export function retentionDays(env: Pick<Env, 'RETENTION_DAYS'>): number {
  const raw = (env.RETENTION_DAYS ?? '').trim();
  const days = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  return days >= 1 && days <= 365 ? days : DEFAULT_RETENTION_DAYS;
}

export const retentionMs = (env: Pick<Env, 'RETENTION_DAYS'>) => retentionDays(env) * DAY;

/** Allowed browser origins for the ingest: exact `scheme://host[:port]` entries. A wildcard is not honoured. */
export function allowedOrigins(env: Pick<Env, 'ALLOWED_ORIGINS'>): Set<string> {
  const out = new Set<string>();
  for (const entry of list(env.ALLOWED_ORIGINS)) {
    try {
      const url = new URL(entry);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === entry.replace(/\/+$/, '')) out.add(url.origin);
    } catch {
      // not an origin: ignored
    }
  }
  return out;
}
