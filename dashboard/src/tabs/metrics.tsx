// Metrics tab: every metric with its distribution; selecting one shows its course by day.
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ObserveMetrics } from '../api-types.ts';
import { Chips, type Column, DataTable, DayBars, DetailError, Hint, SectionHeader, TabBody } from '../components.tsx';
import { count, formatMetric, metricLabel } from '../format.ts';
import { type ObserveContext, useObserveQuery } from '../query.ts';

type Metric = ObserveMetrics['metrics'][number];
type Stat = 'p50' | 'p75' | 'p95' | 'count';
const keyOf = (m: { name: string; category: string }) => `${m.category}\n${m.name}`;

export function MetricsTab({ ctx }: { ctx: ObserveContext }) {
  const [selected, setSelected] = useState<Metric | null>(null);
  const q = useObserveQuery<ObserveMetrics>(ctx, 'metrics', selected ? keyOf(selected) : '', () =>
    api.metrics(ctx.query, selected?.name, selected?.category),
  );
  const columns: Column<Metric>[] = [
    { key: 'count', header: 'Count', value: (m) => String(m.count) },
    { key: 'min', header: 'min', value: (m) => formatMetric(m, m.min) },
    { key: 'p50', header: 'p50', value: (m) => formatMetric(m, m.p50) },
    { key: 'p75', header: 'p75', value: (m) => formatMetric(m, m.p75) },
    { key: 'p95', header: 'p95', value: (m) => formatMetric(m, m.p95) },
    { key: 'max', header: 'max', value: (m) => formatMetric(m, m.max) },
  ];
  return (
    <TabBody q={q} empty={(d) => d.metrics.length === 0}>
      {(data) => (
        <>
          <SectionHeader title="Metrics" />
          <Hint>Select a row to see its course by day.</Hint>
          <DataTable
            rows={data.metrics}
            rowKey={keyOf}
            titleHeader="Metric"
            title={(m) => <strong class="small">{metricLabel(m)}</strong>}
            subtitle={(m) => (metricLabel(m) === m.name ? m.category : `${m.name} · ${m.category}`)}
            columns={columns}
            selected={selected ? keyOf(selected) : null}
            onPress={(m) => setSelected(selected && keyOf(selected) === keyOf(m) ? null : m)}
            detail={(m) =>
              data.selected && data.selected.name === m.name && (data.selected.category ?? m.category) === m.category ? (
                <Series metric={m} data={data} />
              ) : q.failed ? (
                <DetailError />
              ) : null
            }
          />
        </>
      )}
    </TabBody>
  );
}

function Series({ metric, data }: { metric: Metric; data: ObserveMetrics }) {
  const [stat, setStat] = useState<Stat>('p75');
  const days = (data.selected?.series ?? []).map((d) => ({ day: d.day, value: d[stat] }));
  return (
    <div class="stack detail-pad">
      <Chips
        label="Statistic"
        options={[
          { label: 'p50', value: 'p50' as Stat },
          { label: 'p75', value: 'p75' as Stat },
          { label: 'p95', value: 'p95' as Stat },
          { label: 'Count', value: 'count' as Stat },
        ]}
        value={stat}
        onChange={setStat}
      />
      {days.some((d) => d.value > 0) ? (
        <DayBars
          days={days}
          label={`${metricLabel(metric)} ${stat} per day`}
          format={stat === 'count' ? (v) => count(v, 'measurement') : (v) => formatMetric(metric, v)}
        />
      ) : (
        <p class="muted">No data in the selected period.</p>
      )}
    </div>
  );
}
