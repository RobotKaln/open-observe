// Errors tab: the error and crash groups of the range, each with its latest occurrences on demand.
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ObserveOverview } from '../api-types.ts';
import { Card, Chevron, EmptyState, SectionHeader, Spinner, TabBody } from '../components.tsx';
import { count, formatDateTime } from '../format.ts';
import { type ObserveContext, useDetail } from '../query.ts';
import { useOverview } from './overview.tsx';

export function ErrorsTab({ ctx }: { ctx: ObserveContext }) {
  const q = useOverview(ctx);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <TabBody q={q} empty={(d) => d.totals.events === 0}>
      {(data) => (
        <>
          <SectionHeader title="Error groups" />
          {data.errors.length === 0 ? (
            <EmptyState ok title="No errors." />
          ) : (
            data.errors.map((e) => (
              <ErrorGroup key={e.fingerprint} error={e} open={open === e.fingerprint} onToggle={() => setOpen(open === e.fingerprint ? null : e.fingerprint)} />
            ))
          )}
        </>
      )}
    </TabBody>
  );
}

function ErrorGroup({ error, open, onToggle }: { error: ObserveOverview['errors'][number]; open: boolean; onToggle: () => void }) {
  return (
    <Card class="error-group">
      <button type="button" class="group-btn" aria-expanded={open} onClick={onToggle}>
        <span class="row">
          {error.crash ? <span class="badge badge-danger">Crash</span> : null}
          <strong class="grow ellipsis">{error.name}</strong>
          <Chevron open={open} />
        </span>
        <span class={`small muted${open ? '' : ' clamp-2'}`}>{error.message}</span>
        <span class="small subtle">
          {[count(error.count, 'occurrence'), count(error.installs, 'install'), `Last seen ${formatDateTime(error.lastSeen)}`].join(' · ')}
        </span>
        {error.versions.length ? <span class="small subtle">{`Versions: ${error.versions.join(', ')}`}</span> : null}
      </button>
      {open ? <Occurrences fingerprint={error.fingerprint} /> : null}
    </Card>
  );
}

function Occurrences({ fingerprint }: { fingerprint: string }) {
  const { data, failed } = useDetail(fingerprint, () => api.error(fingerprint));
  return (
    <div class="occurrences">
      <h3 class="caps">Occurrences</h3>
      {failed ? (
        <p class="text-danger small">The occurrences could not be loaded.</p>
      ) : !data ? (
        <Spinner />
      ) : data.occurrences.length === 0 ? (
        <p class="muted small">No occurrences.</p>
      ) : (
        <ul class="plain">
          {data.occurrences.map((o, i) => (
            <li key={`${o.ts}-${i}`}>
              <div class="small">{[formatDateTime(o.ts), o.platform, o.appVersion, o.environment].join(' · ')}</div>
              {o.route ? (
                <div class="small muted">
                  Screen: <span class="mono" dir="ltr">{o.route}</span>
                </div>
              ) : null}
              <div class="small selectable">{o.message}</div>
              {o.stack ? <pre class="stack-trace" dir="ltr">{o.stack}</pre> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
