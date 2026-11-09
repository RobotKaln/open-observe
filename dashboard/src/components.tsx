// Pieces the tabs share: the frame of a tab (error, spinner, empty state), cards, chips, a table that stacks its rows on a
// narrow screen, and a bar chart per day.
import type { ComponentChildren, JSX } from 'preact';
import { barHeight, formatNumber, seriesTop, shortDay } from './format.ts';
import type { QueryState } from './query.ts';

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div class="spinner" role="status" aria-label={label}>
    <span class="spinner-ring" aria-hidden="true" />
  </div>
);

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg class={`chevron${open ? ' open' : ''}`} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export const Card = ({ children, class: cls = '' }: { children: ComponentChildren; class?: string }) => <div class={`card ${cls}`}>{children}</div>;

export const SectionHeader = ({ title }: { title: string }) => <h2 class="section-title">{title}</h2>;

export const Hint = ({ children }: { children: ComponentChildren }) => <p class="hint">{children}</p>;

export const EmptyState = ({ title, ok }: { title: string; ok?: boolean }) => (
  <div class="empty">
    <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ok ? (
        <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      ) : (
        <path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      )}
    </svg>
    <p>{title}</p>
  </div>
);

export const DetailError = () => <p class="text-danger small">The details could not be loaded.</p>;

/** A name as an identifier: monospace, always left to right. */
export const Mono = ({ children }: { children: string }) => (
  <span class="mono" dir="ltr">
    {children}
  </span>
);

export function StatCard({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div class="card stat">
      <div class={`stat-value${danger ? ' text-danger' : ''}`}>{formatNumber(value)}</div>
      <div class="stat-label">{label}</div>
    </div>
  );
}

/** A row of toggle buttons (a group of pressed / not pressed). */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div class="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" class="chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Frame of a tab: the error with a retry, the spinner for the first load, the empty state, else the content (dimmed while it reloads). */
export function TabBody<T>({ q, empty, children }: { q: QueryState<T>; empty?: (data: T) => boolean; children: (data: T) => ComponentChildren }) {
  return (
    <>
      {q.failed ? (
        <Card class="stack">
          <p class="text-danger" role="alert">
            {q.failed}
          </p>
          <button type="button" class="btn" onClick={q.reload}>
            Try again
          </button>
        </Card>
      ) : null}
      {q.loading && !q.data ? <Spinner /> : null}
      {q.data ? (
        <div class={`tab-data${q.loading ? ' dim' : ''}`} aria-busy={q.loading}>
          {empty?.(q.data) ? <EmptyState title="No data yet" /> : children(q.data)}
        </div>
      ) : null}
    </>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  value: (row: T) => string;
}

/**
 * A table that fits any width: columns with a header when there is room, stacked rows on a narrow screen (a 360 px phone: the
 * title, then `header value` pairs; the switch is a container query in style.css). `title` is the first cell, `subtitle` a
 * muted line under it. With `onPress` the title is a button and a row opens its `detail`.
 */
export function DataTable<T>({
  rows,
  rowKey,
  title,
  subtitle,
  columns,
  titleHeader,
  selected,
  onPress,
  detail,
}: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  title: (row: T) => ComponentChildren;
  subtitle?: (row: T) => string | null;
  columns: Column<T>[];
  titleHeader: string;
  selected?: string | null;
  onPress?: (row: T) => void;
  detail?: (row: T) => ComponentChildren;
}) {
  return (
    <div class="card table-card">
      <table class="dt">
        <thead>
          <tr>
            <th scope="col" class="dt-title-head">
              {titleHeader}
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col" class="num">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row) => {
            const key = rowKey(row);
            const open = selected === key;
            const sub = subtitle?.(row);
            const main: JSX.Element = (
              <tr key={key} class={`${onPress ? 'clickable' : ''}${open ? ' open' : ''}`} onClick={onPress ? () => onPress(row) : undefined}>
                <th scope="row" class="dt-title">
                  {onPress ? (
                    <button type="button" class="row-btn" aria-expanded={open}>
                      <span class="row-btn-text">{title(row)}</span>
                      <Chevron open={open} />
                    </button>
                  ) : (
                    title(row)
                  )}
                  {sub ? <span class="sub">{sub}</span> : null}
                </th>
                {columns.map((c) => (
                  <td key={c.key} class="num" data-label={c.header}>
                    <span dir="ltr">{c.value(row)}</span>
                  </td>
                ))}
              </tr>
            );
            return open && detail
              ? [
                  main,
                  <tr key={`${key}#detail`} class="dt-detail">
                    <td colSpan={columns.length + 1}>{detail(row)}</td>
                  </tr>,
                ]
              : [main];
          })}
        </tbody>
      </table>
    </div>
  );
}

const BAR_AREA = 96;

/** One bar per day, scaled to the highest. The chart is one image for assistive technology (peak and range); each bar shows its day and value as a tooltip. */
export function DayBars({
  days,
  color = 'var(--primary)',
  label,
  format = formatNumber,
}: {
  days: { day: string; value: number }[];
  color?: string;
  label: string;
  format?: (v: number) => string;
}) {
  const top = seriesTop(days.map((d) => d.value));
  const first = days[0];
  const last = days[days.length - 1];
  const peak = days.find((d) => d.value === top);
  const summary = peak ? `${label}, ${shortDay(first!.day)} to ${shortDay(last!.day)}, highest ${format(top)} on ${shortDay(peak.day)}` : label;
  return (
    <>
      <div class="bars" style={{ height: `${BAR_AREA}px`, '--bar': color }} role="img" aria-label={summary}>
        {days.map((d) => (
          <div key={d.day} class="bar-col" title={`${shortDay(d.day)}: ${format(d.value)}`}>
            <div class="bar" style={{ height: `${barHeight(d.value, top, BAR_AREA)}px` }} />
          </div>
        ))}
      </div>
      <div class="axis" aria-hidden="true">
        <span>{first ? shortDay(first.day) : ''}</span>
        <span>highest per day: {format(top)}</span>
        <span>{last ? shortDay(last.day) : ''}</span>
      </div>
    </>
  );
}
