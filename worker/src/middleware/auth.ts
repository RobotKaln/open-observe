import { createMiddleware } from 'hono/factory';
import { adminTokenUsable } from '../lib/config';
import { safeEqual } from '../lib/crypto';
import { ApiError } from '../lib/http';
import type { AppEnv } from '../env';

/**
 * Bearer token of the read API. 503 while ADMIN_TOKEN is missing or shorter than 32 characters (the API refuses to serve
 * with a guessable secret), 401 without a token, 403 for a wrong one. The comparison is constant-time; the token is
 * never logged or echoed.
 */
export const requireAdminToken = createMiddleware<AppEnv>(async (c, next) => {
  if (!adminTokenUsable(c.env)) throw new ApiError(503, 'api_disabled');
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(c.req.header('Authorization') ?? '');
  if (!match) throw new ApiError(401, 'unauthorized');
  if (!(await safeEqual(match[1], c.env.ADMIN_TOKEN))) throw new ApiError(403, 'forbidden');
  await next();
});
