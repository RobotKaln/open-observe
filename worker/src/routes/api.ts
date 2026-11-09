// The read API of the dashboard: GET /api/{overview,errors/:fingerprint,navigation,updates,metrics,events,traces}, all
// behind `Authorization: Bearer <ADMIN_TOKEN>`. Same-origin only: no CORS headers are ever sent, and nothing is cached.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAdminToken } from '../middleware/auth';
import { readOverview } from './read-overview';
import { readTabs } from './read-tabs';

export const api = new Hono<AppEnv>()
  .use(async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  })
  .use(requireAdminToken)
  .route('/', readOverview)
  .route('/', readTabs);
