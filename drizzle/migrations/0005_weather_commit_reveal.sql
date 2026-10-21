-- Lane 3: weather commit/reveal support

CREATE TABLE IF NOT EXISTS weather_commitments (
  id serial PRIMARY KEY,
  station_id text NOT NULL,
  commitment_hash text NOT NULL,
  reveal_deadline integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weather_commitments_station_status
  ON weather_commitments (station_id, status);

CREATE INDEX IF NOT EXISTS idx_weather_commitments_deadline_pending
  ON weather_commitments (reveal_deadline)
  WHERE status = 'pending';
