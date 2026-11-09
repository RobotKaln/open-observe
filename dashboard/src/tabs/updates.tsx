// Updates tab: per platform, app version and OTA update: first and last seen, installs, share of installs, sessions, events,
// errors, crashes and the share of sessions with an error.
import { api } from '../api.ts';
import type { ObserveUpdates } from '../api-types.ts';
import { type Column, DataTable, Hint, Mono, SectionHeader, TabBody } from '../components.tsx';
import { formatDateTime, formatShare, shortUpdateId } from '../format.ts';
import { type ObserveContext, useObserveQuery } from '../query.ts';

type Update = ObserveUpdates['updates'][number];

const columns: Column<Update>[] = [
  { key: 'adoption', header: 'Install share', value: (u) => formatShare(u.adoption) },
  { key: 'installs', header: 'Installs', value: (u) => String(u.installs) },
  { key: 'sessions', header: 'Sessions', value: (u) => String(u.sessions) },
  { key: 'events', header: 'Events', value: (u) => String(u.events) },
  { key: 'errors', header: 'Errors', value: (u) => String(u.errors) },
  { key: 'crashes', header: 'Crashes', value: (u) => String(u.crashes) },
  { key: 'rate', header: 'Error rate', value: (u) => formatShare(u.errorRate) },
];

export function UpdatesTab({ ctx }: { ctx: ObserveContext }) {
  const q = useObserveQuery<ObserveUpdates>(ctx, 'updates', '', () => api.updates(ctx.query));
  return (
    <TabBody q={q} empty={(d) => d.updates.length === 0}>
      {(data) => (
        <>
          <SectionHeader title="Updates" />
          <Hint>The install share tells which update an install last ran in this period.</Hint>
          <DataTable
            rows={data.updates}
            rowKey={(u) => `${u.platform}\n${u.appVersion}\n${u.updateId ?? ''}`}
            titleHeader="Update"
            title={(u) => (
              <>
                {u.updateId ? <Mono>{shortUpdateId(u.updateId)!}</Mono> : <strong class="small">Embedded in the build</strong>}
                <span class="meter" role="img" aria-label={`Install share ${formatShare(u.adoption)}`}>
                  <span style={{ width: `${Math.round(u.adoption * 100)}%` }} />
                </span>
              </>
            )}
            subtitle={(u) => [`${u.appVersion} · ${u.platform}`, `First seen ${formatDateTime(u.firstSeen)}`, `Last seen ${formatDateTime(u.lastSeen)}`].join(' · ')}
            columns={columns}
          />
        </>
      )}
    </TabBody>
  );
}
