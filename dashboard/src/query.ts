// The query hook of a tab with its short cache, and the context the shell hands to every tab.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, type Query as Params } from './api.ts';

export type FilterLists = { platforms: string[]; versions: string[]; environments: string[] };

/** What the shell hands to every tab: the period and filters, a counter that grows on refresh, and two callbacks. */
export interface ObserveContext {
  query: Params;
  nonce: number;
  /** The lists of values present in the range, from whichever tab answered last. */
  onFilters: (filters: FilterLists) => void;
  /** Whether the tab is waiting for an answer. */
  onBusy: (busy: boolean) => void;
}

// Answers are kept for half a minute: going back to a tab is instant, a changed filter or a refresh asks again.
const CACHE_MS = 30_000;
const CACHE_MAX = 60;
const cache = new Map<string, { at: number; data: unknown }>();

/** Forgets every cached answer (after a sign-out). */
export const clearCache = (): void => cache.clear();

export interface QueryState<T> {
  data: T | null;
  failed: string | null;
  loading: boolean;
  reload: () => void;
}

export const errorText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

/**
 * One request of a tab. `endpoint` and `extra` (the selected metric, event… as a string) with the period, filters and refresh
 * counter of the shell are the cache key. While a new answer is on its way the previous one stays in `data` (the tab dims it),
 * and only the newest request may set the state.
 */
export function useObserveQuery<T extends { filters: FilterLists }>(
  ctx: ObserveContext,
  endpoint: string,
  extra: string,
  fetcher: () => Promise<T>,
): QueryState<T> {
  const { query, nonce, onFilters, onBusy } = ctx;
  const key = [endpoint, extra, query.days, query.platform, query.version, query.env, nonce].join('|');
  const hit = cache.get(key);
  const [data, setData] = useState<T | null>((hit?.data as T | undefined) ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(!hit);
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const filtersRef = useRef(onFilters);
  filtersRef.current = onFilters;

  const load = useCallback(
    async (force: boolean) => {
      const mine = ++latest.current;
      const cached = cache.get(key);
      if (!force && cached && Date.now() - cached.at < CACHE_MS) {
        setData(cached.data as T);
        setFailed(null);
        setLoading(false);
        filtersRef.current((cached.data as T).filters);
        return;
      }
      setLoading(true);
      try {
        const next = await fetcherRef.current();
        if (mine !== latest.current) return;
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: Date.now(), data: next });
        setData(next);
        setFailed(null);
        filtersRef.current(next.filters);
      } catch (e) {
        if (mine !== latest.current) return;
        setFailed(errorText(e, 'The statistics could not be loaded.'));
      } finally {
        if (mine === latest.current) setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    void load(false);
    return () => {
      latest.current++;
    };
  }, [load]);

  useEffect(() => {
    onBusy(loading);
    return () => onBusy(false);
  }, [loading, onBusy]);

  return { data, failed, loading, reload: () => void load(true) };
}

/** A request of a detail view (the occurrences of an error, the spans of a trace): loads on mount and when `key` changes. */
export function useDetail<T>(key: string, fetcher: () => Promise<T>): { data: T | null; failed: boolean } {
  const [state, setState] = useState<{ key: string; data: T | null; failed: boolean }>({ key, data: null, failed: false });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  useEffect(() => {
    let alive = true;
    setState({ key, data: null, failed: false });
    fetcherRef
      .current()
      .then((data) => alive && setState({ key, data, failed: false }))
      .catch(() => alive && setState({ key, data: null, failed: true }));
    return () => {
      alive = false;
    };
  }, [key]);
  return state.key === key ? state : { data: null, failed: false };
}
