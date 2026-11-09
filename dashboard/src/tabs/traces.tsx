// Traces tab: spans by name and target (error share, durations, HTTP statuses), the slowest and the failed traces, and
// one trace as a waterfall of nested spans.
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ObserveTraces, ObserveTraceSummary } from '../api-types.ts';
import { type Column, DataTable, DetailError, Hint, Mono, SectionHeader, Spinner, TabBody } from '../components.tsx';
import { count, flattenTrace, formatDateTime, formatDuration, formatShare, statusClasses } from '../format.ts';
import { type ObserveContext, useDetail, useObserveQuery } from '../query.ts';

type Group = ObserveTraces['groups'][number];

const columns: Column<Group>[] = [
  { key: 'count', header: 'Count', value: (g) => String(g.count) },
  { key: 'share', header: 'Error share', value: (g) => formatShare(g.errorShare) },
  { key: 'p50', header: 'p50', value: (g) => formatDuration(g.p50) },
  { key: 'p95', header: 'p95', value: (g) => formatDuration(g.p95) },
  { key: 'status', header: 'HTTP status', value: (g) => statusClasses(g.statuses).map((s) => `${s.label} ×${s.count}`).join(' ') || '–' },
];

export function TracesTab({ ctx }: { ctx: ObserveContext }) {
  const q = useObserveQuery<ObserveTraces>(ctx, 'traces', '', () => api.traces(ctx.query));
  return (
    <TabBody q={q} empty={(d) => d.groups.length === 0 && d.slowest.length === 0}>
      {(data) => (
        <>
          <SectionHeader title="Requests" />
          <DataTable
            rows={data.groups}
            rowKey={(g) => `${g.name}\n${g.target}`}
            titleHeader="Request"
            title={(g) => <Mono>{g.name}</Mono>}
            subtitle={(g) => g.target || null}
            columns={columns}
          />
          <TraceList title="Slowest traces" traces={data.slowest} />
          <TraceList title="Failed traces" traces={data.failed} />
        </>
      )}
    </TabBody>
  );
}

const traceColumns: Column<ObserveTraceSummary>[] = [
  { key: 'duration', header: 'Duration', value: (s) => formatDuration(s.durationMs) },
  { key: 'spans', header: 'Spans', value: (s) => String(s.spans) },
  { key: 'errors', header: 'Errors', value: (s) => String(s.errors) },
];

function TraceList({ title, traces }: { title: string; traces: ObserveTraceSummary[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!traces.length) return null;
  return (
    <>
      <SectionHeader title={title} />
      <Hint>Select a row to see its spans.</Hint>
      <DataTable
        rows={traces}
        rowKey={(s) => s.traceId}
        titleHeader="Trace"
        title={(s) => <Mono>{s.name}</Mono>}
        subtitle={(s) => [formatDateTime(s.start), `${s.appVersion} · ${s.platform}`].join(' · ')}
        columns={traceColumns}
        selected={open}
        onPress={(s) => setOpen(open === s.traceId ? null : s.traceId)}
        detail={(s) => <TraceWaterfall traceId={s.traceId} />}
      />
    </>
  );
}

// The spans of one trace, parents above their children, each with its bar placed in the trace and its duration.
function TraceWaterfall({ traceId }: { traceId: string }) {
  const { data, failed } = useDetail(traceId, () => api.trace(traceId));
  if (failed) return <DetailError />;
  if (!data) return <Spinner />;
  const rows = flattenTrace(data.roots, data.durationMs);
  return (
    <div class="stack detail-pad">
      <p class="small muted" dir="ltr">
        {[formatDuration(data.durationMs), count(data.spans, 'span'), `${data.appVersion} · ${data.platform}`].join(' · ')}
      </p>
      <ul class="plain waterfall">
        {rows.map(({ span, depth, left, width }) => {
          const bad = span.status === 'error' || (span.httpStatus ?? 0) >= 400;
          return (
            <li key={span.spanId}>
              <div class="row" style={{ paddingInlineStart: `${Math.min(depth, 6) * 12}px` }}>
                <span class={`small strong grow ellipsis${bad ? ' text-danger' : ''}`} dir="ltr">
                  {span.target ? `${span.name} ${span.target}` : span.name}
                </span>
                <span class={`small ${bad ? 'text-danger' : 'muted'}`} dir="ltr">
                  {[span.httpStatus, formatDuration(span.durationMs)].filter((x) => x !== null).join(' · ')}
                </span>
              </div>
              <div class="span-track" role="img" aria-label={`starts at +${formatDuration(span.offsetMs)}`}>
                <span class={bad ? 'bad' : ''} style={{ marginInlineStart: `${left * 100}%`, width: `${width * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
