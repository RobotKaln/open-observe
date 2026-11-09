// Rows as the parsers produce them. `ts` is null when the batch carried no usable time (the store then uses the
// arrival time); client ids and session ids are raw here and hashed by the store.
export type Resource = {
  platform: string;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string;
  updateId: string | null;
  environment: string;
  clientId: string | null;
};

export type MetricRow = {
  ts: number | null;
  category: string;
  name: string;
  value: number;
  route: string | null;
  // A metric of its own may carry the update id (expo.update_id), the resource one is the fallback.
  updateId: string | null;
};

export type LogRow = {
  ts: number | null;
  /** 'event' | 'error' | 'crash' */
  category: string;
  name: string;
  route: string | null;
  severity: string;
  body: string | null;
  attrs: string | null;
  errorType: string | null;
  stack: string | null;
  fingerprint: string | null;
};

export type SpanRow = {
  ts: number | null;
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  durationMs: number;
  status: string;
  httpStatus: number | null;
  target: string | null;
  route: string | null;
};

// What one request adds to the database.
export type ParsedBatch = {
  metrics: { resource: Resource; sessionRaw: string | null; row: MetricRow }[];
  logs: { resource: Resource; sessionRaw: string | null; row: LogRow }[];
  spans: { resource: Resource; row: SpanRow }[];
};
