CREATE TABLE IF NOT EXISTS materialized_responses (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_jobs (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  next_refresh_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
