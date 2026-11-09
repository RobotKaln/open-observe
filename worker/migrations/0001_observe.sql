-- open-observe telemetry. Lives in its own D1 database, never next to application data. No IP address, no User-Agent, no
-- account: `client` and `session_id` are truncated HMACs (PEPPER), routes are templates, error text is scrubbed before it
-- is stored. Raw rows are purged after RETENTION_DAYS (default 30), counted from received_at.
-- All times are Unix milliseconds. Time metrics are stored in milliseconds (OTLP sends seconds), `CLS` is unitless.

-- One row per accepted request body, `id` = sha256(kind + ':' + body). A retry of a stored batch is not stored again.
CREATE TABLE obs_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX obs_batches_received ON obs_batches (received_at);

-- Metrics from the native OTLP gauge points and the web diagnostics (category web_vital, web_nav).
CREATE TABLE obs_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  platform TEXT NOT NULL,
  os_version TEXT,
  device_model TEXT,
  app_version TEXT NOT NULL,
  update_id TEXT,
  environment TEXT NOT NULL,
  client TEXT,
  session_id TEXT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  route TEXT
);
CREATE INDEX obs_metrics_received ON obs_metrics (received_at);
CREATE INDEX obs_metrics_ts ON obs_metrics (ts);
CREATE INDEX obs_metrics_name_ts ON obs_metrics (name, ts);
CREATE INDEX obs_metrics_version ON obs_metrics (app_version);

-- Log records and errors. category: 'event' (ordinary log), 'error' (exception) or 'crash' (fatal or native crash).
-- For an exception `error_type` is its type, `body` the scrubbed message, `stack` the scrubbed stack and `fingerprint`
-- the group (type plus the first stack frames, 16 hex characters). `attrs` is a capped JSON object of the attributes
-- that passed the denylist.
CREATE TABLE obs_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  platform TEXT NOT NULL,
  os_version TEXT,
  device_model TEXT,
  app_version TEXT NOT NULL,
  update_id TEXT,
  environment TEXT NOT NULL,
  client TEXT,
  session_id TEXT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  route TEXT,
  severity TEXT NOT NULL,
  body TEXT,
  attrs TEXT,
  error_type TEXT,
  stack TEXT,
  fingerprint TEXT
);
CREATE INDEX obs_logs_received ON obs_logs (received_at);
CREATE INDEX obs_logs_ts ON obs_logs (ts);
CREATE INDEX obs_logs_name_ts ON obs_logs (name, ts);
CREATE INDEX obs_logs_version ON obs_logs (app_version);
CREATE INDEX obs_logs_fingerprint ON obs_logs (fingerprint, ts);

-- Spans (native network requests and custom spans). `target` is the host only, never a path or a query.
CREATE TABLE obs_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  target TEXT,
  route TEXT,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  environment TEXT NOT NULL
);
CREATE INDEX obs_spans_received ON obs_spans (received_at);
CREATE INDEX obs_spans_name_ts ON obs_spans (name, ts);
CREATE INDEX obs_spans_version ON obs_spans (app_version);

-- Request counter of the ingest rate limit. The key is an HMAC of the client address and the minute, so it cannot be
-- turned back into an address and does not link requests of different minutes. Rows are purged after an hour.
CREATE TABLE obs_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX obs_limits_window ON obs_limits (window_start);
