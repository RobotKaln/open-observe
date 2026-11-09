import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An expected failure with an HTTP status: answered as `{ error }`, never logged as a server error. */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public error: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(error);
  }
}

export type JsonObject = Record<string, unknown>;

export const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
