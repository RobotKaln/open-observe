// Navigation tab: per screen (route template) the views, sessions, load times and errors, and the moves between screens.
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ObserveNavigation } from '../api-types.ts';
import { Card, Chips, type Column, DataTable, Hint, Mono, SectionHeader, TabBody } from '../components.tsx';
import { count, formatMetric, headlineMetric, metricLabel, sortBySlowest } from '../format.ts';
import { type ObserveContext, useObserveQuery } from '../query.ts';

type Route = ObserveNavigation['routes'][number];
type Order = 'views' | 'slowest';

export function NavigationTab({ ctx }: { ctx: ObserveContext }) {
  const q = useObserveQuery<ObserveNavigation>(ctx, 'navigation', '', () => api.navigation(ctx.query));
  const [order, setOrder] = useState<Order>('views');
  const [open, setOpen] = useState<string | null>(null);

  return (
    <TabBody q={q} empty={(d) => d.routes.length === 0 && d.transitions.length === 0}>
      {(data) => {
        const routes = order === 'slowest' ? sortBySlowest(data.routes) : data.routes;
        const columns: Column<Route>[] = [
          { key: 'views', header: 'Views', value: (r) => String(r.views) },
          { key: 'sessions', header: 'Sessions', value: (r) => String(r.sessions) },
          { key: 'errors', header: 'Errors', value: (r) => String(r.errors) },
          ...(['p50', 'p75', 'p95'] as const).map((p) => ({
            key: p,
            header: p,
            value: (r: Route) => {
              const m = headlineMetric(r.metrics);
              return m ? formatMetric(m, m[p]) : '–';
            },
          })),
        ];
        return (
          <>
            <SectionHeader title="Screens" />
            <Chips
              label="Order"
              options={[
                { label: 'Most views', value: 'views' as Order },
                { label: 'Slowest screens', value: 'slowest' as Order },
              ]}
              value={order}
              onChange={setOrder}
            />
            <Hint>Select a row to see its details.</Hint>
            {routes.length === 0 ? null : (
              <DataTable
                rows={routes}
                rowKey={(r) => r.route}
                titleHeader="Screen"
                title={(r) => <Mono>{r.route}</Mono>}
                subtitle={(r) => {
                  const m = headlineMetric(r.metrics);
                  return m ? metricLabel(m) : null;
                }}
                columns={columns}
                selected={open}
                onPress={(r) => setOpen(open === r.route ? null : r.route)}
                detail={(r) => <RouteMetrics route={r} />}
              />
            )}
            {data.transitions.length ? (
              <>
                <SectionHeader title="Moves between screens" />
                <Card>
                  <ul class="plain rows">
                    {data.transitions.map((m) => (
                      <li key={`${m.from}>${m.to}`} class="row">
                        <span class="grow minw0">
                          <Mono>{`${m.from} → ${m.to}`}</Mono>
                        </span>
                        <span class="small">{count(m.count, 'move')}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </>
            ) : null}
          </>
        );
      }}
    </TabBody>
  );
}

// Every load metric measured for the screen, not only the headline one.
function RouteMetrics({ route }: { route: Route }) {
  if (!route.metrics.length) return <p class="small muted">No data yet</p>;
  return (
    <ul class="plain detail-list">
      {route.metrics.map((m) => (
        <li key={`${m.category}:${m.name}`}>
          <div class="small strong">{metricLabel(m)}</div>
          <div class="small muted" dir="ltr">
            {[count(m.count, 'measurement'), `p50 ${formatMetric(m, m.p50)}`, `p75 ${formatMetric(m, m.p75)}`, `p95 ${formatMetric(m, m.p95)}`].join(' · ')}
          </div>
        </li>
      ))}
    </ul>
  );
}
