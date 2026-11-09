// Events tab: the events the app logged with counts and installs, their course by day, and the latest occurrences of one.
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ObserveEvents } from '../api-types.ts';
import { Card, type Column, DataTable, DayBars, DetailError, Hint, Mono, SectionHeader, Spinner, TabBody } from '../components.tsx';
import { count, formatAttrs, formatDateTime } from '../format.ts';
import { type ObserveContext, useObserveQuery } from '../query.ts';

type EventRow = ObserveEvents['events'][number];
const PAGE = 20;

const columns: Column<EventRow>[] = [
  { key: 'count', header: 'Events', value: (e) => String(e.count) },
  { key: 'installs', header: 'Installs', value: (e) => String(e.installs) },
  { key: 'sessions', header: 'Sessions', value: (e) => String(e.sessions) },
];

export function EventsTab({ ctx }: { ctx: ObserveContext }) {
  const [selected, setSelected] = useState<string | null>(null);
  const q = useObserveQuery<ObserveEvents>(ctx, 'events', selected ?? '', () => api.events(ctx.query, selected ?? undefined));
  return (
    <TabBody q={q} empty={(d) => d.events.length === 0}>
      {(data) => (
        <>
          <SectionHeader title="Course by day" />
          <Card class="stack">
            {selected ? <Mono>{selected}</Mono> : null}
            {data.series.some((d) => d.count > 0) ? (
              <DayBars days={data.series.map((d) => ({ day: d.day, value: d.count }))} label={`${selected ?? 'All events'} per day`} />
            ) : (
              <p class="muted">No data in the selected period.</p>
            )}
          </Card>
          <SectionHeader title="Events" />
          <Hint>Select a row to see its latest occurrences.</Hint>
          <DataTable
            rows={data.events}
            rowKey={(e) => e.name}
            titleHeader="Event"
            title={(e) => <Mono>{e.name}</Mono>}
            subtitle={(e) => `Last seen ${formatDateTime(e.lastSeen)}`}
            columns={columns}
            selected={selected}
            onPress={(e) => setSelected(selected === e.name ? null : e.name)}
            detail={(e) => <Occurrences key={e.name} data={data} loading={q.loading} failed={!!q.failed} />}
          />
        </>
      )}
    </TabBody>
  );
}

function Occurrences({ data, loading, failed }: { data: ObserveEvents; loading: boolean; failed: boolean }) {
  const [shown, setShown] = useState(PAGE);
  if (failed) return <DetailError />;
  // the answer of an earlier selection is still on screen while the new one is loading
  if (loading) return <Spinner />;
  return (
    <div class="stack detail-pad">
      <h3 class="caps">Latest occurrences</h3>
      <ul class="plain">
        {data.occurrences.slice(0, shown).map((o, i) => {
          const attrs = formatAttrs(o.attrs);
          return (
            <li key={`${o.ts}-${i}`}>
              <div class="small">{[formatDateTime(o.ts), o.platform, o.appVersion, o.environment].join(' · ')}</div>
              {o.route ? (
                <div class="small muted">
                  Screen: <span class="mono" dir="ltr">{o.route}</span>
                </div>
              ) : null}
              {attrs ? (
                <div class="small subtle selectable" dir="ltr">
                  {attrs}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.occurrences.length > shown ? (
        <button type="button" class="btn" onClick={() => setShown(shown + PAGE)}>
          Show more
        </button>
      ) : null}
      <p class="small muted">{count(data.occurrences.length, 'occurrence')}</p>
    </div>
  );
}
