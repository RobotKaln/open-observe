import { retentionMs } from './config';
import type { Env } from '../env';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Raw telemetry rows are kept RETENTION_DAYS (default 30) by arrival time; the request counters of the ingest rate limit
 * an hour, the daily byte budgets a day.
 */
export async function purgeTelemetry(env: Pick<Env, 'DB' | 'RETENTION_DAYS'>, now: number) {
  const db = env.DB;
  const cutoff = now - retentionMs(env);
  await db.batch([
    db.prepare('DELETE FROM obs_metrics WHERE received_at < ?').bind(cutoff),
    db.prepare('DELETE FROM obs_logs WHERE received_at < ?').bind(cutoff),
    db.prepare('DELETE FROM obs_spans WHERE received_at < ?').bind(cutoff),
    db.prepare('DELETE FROM obs_batches WHERE received_at < ?').bind(cutoff),
    db.prepare('DELETE FROM obs_limits WHERE window_start < ?').bind(now - HOUR),
    // Daily byte budgets of earlier days.
    db.prepare('DELETE FROM obs_budgets WHERE day < ?').bind(Math.floor(now / DAY)),
  ]);
}
