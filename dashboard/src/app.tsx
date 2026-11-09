// The shell: login, header with theme and sign-out, the seven tabs, the period and filters. The tab, period and filters live in
// the URL hash (`#/traces?days=14&platform=ios`), so a link opens the same view and the Worker needs no route fallback.
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, checkToken, clearToken, getToken, setAuthFailureHandler, setToken, type Query } from './api.ts';
import { Chips } from './components.tsx';
import { count, OBSERVE_TABS, type ObserveTab, parseDays, parseTab, PERIODS } from './format.ts';
import { clearCache, type FilterLists, type ObserveContext } from './query.ts';
import { ErrorsTab } from './tabs/errors.tsx';
import { EventsTab } from './tabs/events.tsx';
import { MetricsTab } from './tabs/metrics.tsx';
import { NavigationTab } from './tabs/navigation.tsx';
import { OverviewTab } from './tabs/overview.tsx';
import { TracesTab } from './tabs/traces.tsx';
import { UpdatesTab } from './tabs/updates.tsx';

const TAB_LABEL: Record<ObserveTab, string> = {
  overview: 'Overview',
  navigation: 'Navigation',
  updates: 'Updates',
  metrics: 'Metrics',
  errors: 'Errors',
  events: 'Events',
  traces: 'Traces',
};

const NO_FILTERS: FilterLists = { platforms: [], versions: [], environments: [] };

// ---- URL hash ----

interface Route extends Query {
  tab: ObserveTab;
}

function parseHash(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  const p = new URLSearchParams(search);
  return { tab: parseTab(path), days: parseDays(p.get('days')), platform: p.get('platform') ?? '', version: p.get('version') ?? '', env: p.get('env') ?? '' };
}

function buildHash(r: Route): string {
  const p = new URLSearchParams();
  if (r.days !== 7) p.set('days', String(r.days));
  if (r.platform) p.set('platform', r.platform);
  if (r.version) p.set('version', r.version);
  if (r.env) p.set('env', r.env);
  const qs = p.toString();
  return `#/${r.tab}${qs ? `?${qs}` : ''}`;
}

// ---- Theme ----

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'open-observe.theme';
const THEMES: Theme[] = ['system', 'light', 'dark'];

function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.includes(v as Theme) ? (v as Theme) : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function ThemeSelect() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const onChange = (e: JSX.TargetedEvent<HTMLSelectElement>) => {
    const next = e.currentTarget.value as Theme;
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* the choice lasts for this page only */
    }
  };
  return (
    <label class="theme">
      <span class="sr-only">Theme</span>
      <select value={theme} onChange={onChange}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

// ---- Login ----

function Login({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  const [token, setTokenValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  const submit = async (e: Event) => {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await checkToken(value);
      setToken(value);
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? 'That token was not accepted.'
          : err instanceof ApiError
            ? err.message
            : 'Sign-in failed.',
      );
      setBusy(false);
    }
  };

  return (
    <main class="login">
      <form class="card login-card" onSubmit={submit}>
        <h1>open-observe</h1>
        <p class="muted">Enter the admin token of this Worker to see the statistics.</p>
        <label class="field">
          <span>Admin token</span>
          <input
            type="password"
            name="token"
            value={token}
            onInput={(e) => setTokenValue(e.currentTarget.value)}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            autofocus
          />
        </label>
        {error ? (
          <p id="login-error" class="text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" class="btn btn-primary" disabled={busy || !token.trim()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p class="small subtle">The token stays in this tab (session storage) and is sent only to this Worker.</p>
      </form>
      <div class="login-theme">
        <ThemeSelect />
      </div>
    </main>
  );
}

// ---- Tabs ----

function TabList({ tab, onSelect }: { tab: ObserveTab; onSelect: (t: ObserveTab) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  // a tab that is scrolled out of sight (a narrow screen, a link to #/traces) is brought into view
  useEffect(() => {
    refs.current[tab]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  const onKeyDown = (e: KeyboardEvent) => {
    const i = OBSERVE_TABS.indexOf(tab);
    const dir = getComputedStyle(e.currentTarget as Element).direction === 'rtl' ? -1 : 1;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + dir + OBSERVE_TABS.length) % OBSERVE_TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - dir + OBSERVE_TABS.length) % OBSERVE_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = OBSERVE_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = OBSERVE_TABS[next]!;
    onSelect(target);
    refs.current[target]?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
      {OBSERVE_TABS.map((t) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[t] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t}`}
          aria-selected={t === tab}
          aria-controls="panel"
          tabIndex={t === tab ? 0 : -1}
          class="tab"
          onClick={() => onSelect(t)}
        >
          {TAB_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

// One row of chips for a filter: "All" and the values present in the range (a selected value that is gone stays visible).
function Filter({ title, values, value, onChange }: { title: string; values: string[]; value: string; onChange: (v: string) => void }) {
  const shown = value && !values.includes(value) ? [value, ...values] : values;
  if (shown.length < 2 && !value) return null;
  return (
    <div class="filter">
      <div class="filter-title">{title}</div>
      <Chips label={title} options={[{ label: 'All', value: '' }, ...shown.map((v) => ({ label: v, value: v }))]} value={value} onChange={onChange} />
    </div>
  );
}

// ---- Dashboard ----

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [filters, setFilters] = useState<FilterLists>(NO_FILTERS);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const go = (patch: Partial<Route>) => {
    const next = { ...route, ...patch };
    history.replaceState(null, '', buildHash(next));
    setRoute(next);
  };

  useEffect(() => {
    document.title = `${TAB_LABEL[route.tab]} · open-observe`;
  }, [route.tab]);

  const onFilters = useCallback((next: FilterLists) => {
    setFilters((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  const query = useMemo<Query>(
    () => ({ days: route.days, platform: route.platform, version: route.version, env: route.env }),
    [route.days, route.platform, route.version, route.env],
  );
  const ctx = useMemo<ObserveContext>(() => ({ query, nonce, onFilters, onBusy: setBusy }), [query, nonce, onFilters]);

  return (
    <>
      <header class="topbar">
        <div class="topbar-inner">
          <span class="brand">open-observe</span>
          <span class="grow" />
          <ThemeSelect />
          <button type="button" class="btn btn-quiet" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <main class="page">
        <div class="title-row">
          <h1 class="page-title">App statistics</h1>
          <button type="button" class="btn btn-quiet refresh" onClick={() => setNonce((n) => n + 1)} disabled={busy}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <TabList tab={route.tab} onSelect={(tab) => go({ tab })} />
        <div class="controls">
          <div class="filter">
            <div class="filter-title">Period</div>
            <Chips
              label="Period"
              options={PERIODS.map((n) => ({ label: count(n, 'day'), value: String(n) }))}
              value={String(route.days)}
              onChange={(v) => go({ days: Number(v) })}
            />
          </div>
          <Filter title="Platform" values={filters.platforms} value={route.platform} onChange={(platform) => go({ platform })} />
          <Filter title="Version" values={filters.versions} value={route.version} onChange={(version) => go({ version })} />
          <Filter title="Environment" values={filters.environments} value={route.env} onChange={(env) => go({ env })} />
        </div>
        <div id="panel" role="tabpanel" aria-labelledby={`tab-${route.tab}`} tabIndex={-1} class="panel">
          {route.tab === 'overview' ? <OverviewTab ctx={ctx} /> : null}
          {route.tab === 'navigation' ? <NavigationTab ctx={ctx} /> : null}
          {route.tab === 'updates' ? <UpdatesTab ctx={ctx} /> : null}
          {route.tab === 'metrics' ? <MetricsTab ctx={ctx} /> : null}
          {route.tab === 'errors' ? <ErrorsTab ctx={ctx} /> : null}
          {route.tab === 'events' ? <EventsTab ctx={ctx} /> : null}
          {route.tab === 'traces' ? <TracesTab ctx={ctx} /> : null}
        </div>
      </main>
    </>
  );
}

// ---- Root ----

export function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setAuthFailureHandler((status) => {
      clearCache();
      setNotice(status === 401 ? 'Your session ended. Enter the token again.' : 'The token was not accepted.');
      setSignedIn(false);
    });
    return () => setAuthFailureHandler(null);
  }, []);

  useEffect(() => {
    if (!signedIn) document.title = 'Sign in · open-observe';
  }, [signedIn]);

  if (!signedIn) {
    return (
      <Login
        notice={notice}
        onSignedIn={() => {
          setNotice(null);
          setSignedIn(true);
        }}
      />
    );
  }
  return (
    <Dashboard
      onSignOut={() => {
        clearToken();
        clearCache();
        setNotice(null);
        setSignedIn(false);
      }}
    />
  );
}
