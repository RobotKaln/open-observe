import type { Hono } from 'hono';

/** Worker bindings, secrets and variables (see wrangler.jsonc and the README). */
export interface Env {
  /** D1 database with the telemetry tables (migrations/). */
  DB: D1Database;
  /** Static dashboard build (../dashboard/dist). */
  ASSETS: Fetcher;
  /** Secret: bearer token of the read API and the dashboard. At least 32 characters, otherwise the API is switched off. */
  ADMIN_TOKEN: string;
  /** Secret: HMAC key of client ids, session ids and rate limit keys. At least 16 characters, otherwise ingest answers 503. */
  PEPPER: string;
  /** Comma-separated project ids (UUIDs) the ingest accepts; any other id is a 404. */
  PROJECT_IDS: string;
  /** "1" = after storing, forward the original OTLP batch to Expo Observe. Default off. */
  FORWARD_TO_EXPO?: string;
  /** Days raw rows are kept (1..365), default 30. */
  RETENTION_DAYS?: string;
  /** Comma-separated origins allowed to POST to the ingest from a browser (CORS). Default: none (same origin only). */
  ALLOWED_ORIGINS?: string;
}

export type AppEnv = { Bindings: Env };
export type App = Hono<AppEnv>;
