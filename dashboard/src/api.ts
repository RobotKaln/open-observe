// Client of the read API: every request carries the admin token as a bearer. A 401 or 403 forgets the token and sends the
// dashboard back to the login screen.
import type {
  ObserveErrorDetail,
  ObserveEvents,
  ObserveMetrics,
  ObserveNavigation,
  ObserveOverview,
  ObserveTraceDetail,
  ObserveTraces,
  ObserveUpdates,
} from './api-types.ts';

const TOKEN_KEY = 'open-observe.token';

// sessionStorage can throw (blocked site data, private windows); the token then lives in memory for this page only.
let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* kept in memory */
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let onAuthFailure: ((status: number) => void) | null = null;
/** The callback that shows the login screen after a 401 or 403. */
export function setAuthFailureHandler(handler: ((status: number) => void) | null): void {
  onAuthFailure = handler;
}

export type Params = Record<string, string | number | undefined>;

function url(path: string, params: Params = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const qs = search.toString();
  return `/api/${path}${qs ? `?${qs}` : ''}`;
}

async function request<T>(path: string, params: Params, token: string | null, notify: boolean): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path, params), { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  } catch {
    throw new ApiError('The server could not be reached.', 0);
  }
  if (res.status === 401 || res.status === 403) {
    if (notify) {
      clearToken();
      onAuthFailure?.(res.status);
    }
    throw new ApiError(res.status === 401 ? 'A token is required.' : 'The token was not accepted.', res.status);
  }
  if (!res.ok) throw new ApiError(`The server answered with status ${res.status}.`, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('The server sent an answer that is not JSON.', res.status);
  }
}

const get = <T>(path: string, params: Params = {}) => request<T>(path, params, getToken(), true);

/** Checks a token the user typed, without touching the stored one. Resolves on success, rejects with an `ApiError`. */
export const checkToken = (token: string): Promise<unknown> => request('overview', { days: 1 }, token, false);

export interface Query {
  days: number;
  platform: string;
  version: string;
  env: string;
}

export const api = {
  overview: (q: Query) => get<ObserveOverview>('overview', { ...q }),
  error: (fingerprint: string) => get<ObserveErrorDetail>(`errors/${encodeURIComponent(fingerprint)}`),
  navigation: (q: Query) => get<ObserveNavigation>('navigation', { ...q }),
  updates: (q: Query) => get<ObserveUpdates>('updates', { ...q }),
  metrics: (q: Query, name?: string, category?: string) => get<ObserveMetrics>('metrics', { ...q, name, category }),
  events: (q: Query, name?: string) => get<ObserveEvents>('events', { ...q, name }),
  traces: (q: Query) => get<ObserveTraces>('traces', { ...q }),
  trace: (trace: string) => get<ObserveTraceDetail>('traces', { trace }),
};
