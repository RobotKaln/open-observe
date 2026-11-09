-- Indexes for the Traces tab, which reads spans by time range and by trace. obs_spans had only (received_at), (name, ts)
-- and (app_version): a range on ts alone and a lookup of one trace_id scanned the table.
CREATE INDEX obs_spans_ts ON obs_spans (ts);
CREATE INDEX obs_spans_trace ON obs_spans (trace_id);
