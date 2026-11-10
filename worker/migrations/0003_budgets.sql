-- Daily byte budgets of the public telemetry ingest: how many request body bytes
-- one client address, and the whole project, may have stored in one UTC day. `key` is an HMAC of the address (or of the
-- project id) and the day, so no address is stored, and the days of one address are not linked. `day` is the number of
-- days since 1970-01-01 (UTC); the hourly cron deletes the rows of earlier days.
CREATE TABLE obs_budgets (
  key TEXT PRIMARY KEY,
  day INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX obs_budgets_day ON obs_budgets (day);
