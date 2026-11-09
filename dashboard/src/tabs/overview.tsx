// Overview tab: the summary, the course by day, the web vitals and the versions in use.
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ObserveOverview } from '../api-types.ts';
import { Card, Chips, DayBars, SectionHeader, StatCard, TabBody } from '../components.tsx';
import { count, formatDateTime, formatVital, percent } from '../format.ts';
import { type ObserveContext, useObserveQuery } from '../query.ts';

type Series = 'sessions' | 'installs' | 'errors';

/** The overview request is shared with the Errors tab (same key, so one answer serves both). */
export function useOverview(ctx: ObserveContext) {
  return useObserveQuery<ObserveOverview>(ctx, 'overview', '', () => api.overview(ctx.query));
}

export function OverviewTab({ ctx }: { ctx: ObserveContext }) {
  const q = useOverview(ctx);
  const [series, setSeries] = useState<Series>('sessions');
  return (
    <TabBody q={q} empty={(d) => d.totals.events === 0}>
      {(data) => (
        <>
          <Totals data={data} />
          <Timeline data={data} series={series} onSeries={setSeries} />
          <Vitals data={data} />
          <Versions data={data} />
        </>
      )}
    </TabBody>
  );
}

function Totals({ data: { totals } }: { data: ObserveOverview }) {
  return (
    <>
      <SectionHeader title="Summary" />
      <div class="stat-grid">
        <StatCard label="Events" value={totals.events} />
        <StatCard label="Installs" value={totals.installs} />
        <StatCard label="Sessions" value={totals.sessions} />
        <StatCard label="Errors" value={totals.errors} />
        <StatCard label="Crashes" value={totals.crashes} danger={totals.crashes > 0} />
      </div>
    </>
  );
}

function Timeline({ data, series, onSeries }: { data: ObserveOverview; series: Series; onSeries: (s: Series) => void }) {
  const days = data.timeline.map((d) => ({ day: d.day, value: d[series] }));
  const hasData = days.some((d) => d.value > 0);
  return (
    <>
      <SectionHeader title="Course by day" />
      <Card class="stack">
        <Chips
          label="Series"
          options={[
            { label: 'Sessions', value: 'sessions' as Series },
            { label: 'Installs', value: 'installs' as Series },
            { label: 'Errors', value: 'errors' as Series },
          ]}
          value={series}
          onChange={onSeries}
        />
        {hasData ? (
          <DayBars days={days} color={series === 'errors' ? 'var(--danger)' : 'var(--primary)'} label={`${series} per day`} />
        ) : (
          <p class="muted">No data in the selected period.</p>
        )}
      </Card>
    </>
  );
}

const VITAL_PARTS = [
  { key: 'good', label: 'Good', color: 'var(--success)' },
  { key: 'needsImprovement', label: 'Needs improvement', color: 'var(--warning)' },
  { key: 'poor', label: 'Poor', color: 'var(--danger)' },
] as const;

function Vitals({ data }: { data: ObserveOverview }) {
  if (!data.webVitals.length) return null;
  return (
    <>
      <SectionHeader title="Web Vitals" />
      <div class="vitals">
        {data.webVitals.map((v) => (
          <Card key={v.name} class="stack">
            <div class="row">
              <strong class="grow">{v.name}</strong>
              <span class="small muted">{count(v.count, 'measurement')}</span>
              <strong dir="ltr">{`p75 ${formatVital(v.name, v.p75)}`}</strong>
            </div>
            <div class="share" role="img" aria-label={VITAL_PARTS.map((p) => `${p.label} ${percent(v[p.key], v.count)} %`).join(', ')}>
              {VITAL_PARTS.map((p) => (v[p.key] > 0 ? <span key={p.key} style={{ flex: v[p.key], background: p.color }} /> : null))}
            </div>
            <div class="legend">
              {VITAL_PARTS.map((p) => (
                <span key={p.key} class="small muted">
                  <i class="dot" style={{ background: p.color }} aria-hidden="true" />
                  {p.label} <span dir="ltr">{percent(v[p.key], v.count)} %</span>
                </span>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Versions({ data }: { data: ObserveOverview }) {
  if (!data.versions.length) return null;
  return (
    <>
      <SectionHeader title="App versions" />
      <Card>
        <ul class="plain">
          {data.versions.map((v) => (
            <li key={`${v.platform}:${v.version}`}>
              <div class="strong" dir="ltr">{`${v.version} · ${v.platform}`}</div>
              <div class="small muted">{`Installs ${v.installs} · Sessions ${v.sessions} · Errors ${v.errors}`}</div>
              <div class="small subtle">{`Last seen ${formatDateTime(v.lastSeen)}`}</div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
