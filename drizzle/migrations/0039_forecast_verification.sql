-- Forecasts checked against station observations (backend PR#72 intent, backend#1494; owner demo queue
-- 2026-11-01, item 7). Read-side only: nothing here feeds rewards or consensus.
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before setting
-- FORECAST_VERIFICATION_ENABLED=true. Rerunnable (IF NOT EXISTS).
--
-- Down (reversible): DROP TABLE forecast_verification_noaa_reference; DROP TABLE forecast_verification_records;
--
-- One row per on-chain forecast commit whose forecaster handed in its commit record. The record is
-- checked before insert: its sha3 hash equals the chain commit id, and the node says the commit is a
-- revealed forecast for the same station. station_id is the raw chain station id and never leaves the
-- backend; public reads use station_alias (owner ruling 2026-09-27, Q5).
CREATE TABLE IF NOT EXISTS forecast_verification_records (
  commit_id text PRIMARY KEY CHECK (commit_id ~ '^[0-9a-f]{64}$'),
  station_id text NOT NULL CHECK (length(station_id) BETWEEN 1 AND 128),
  station_alias text NOT NULL CHECK (station_alias ~ '^st_[0-9a-f]{12}$'),
  model_id text CHECK (length(model_id) <= 64),
  issued_at timestamptz NOT NULL,
  valid_at timestamptz NOT NULL CHECK (valid_at > issued_at),
  horizon_hours integer CHECK (horizon_hours > 0 AND horizon_hours <= 240),
  forecast_values jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scored', 'unavailable')),
  unavailable_reason text,
  -- Hourly mean of the chain's readings for the station in the target hour, with count and heights.
  truth jsonb,
  -- Per variable: forecast, truth, error (forecast - truth) and the NOAA value/error when captured.
  scores jsonb,
  noaa_reference jsonb,
  noaa_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  scored_at timestamptz,
  last_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_verification_records_pending
  ON forecast_verification_records (valid_at) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_verification_records_valid_at
  ON forecast_verification_records (valid_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_verification_records_submitted_at
  ON forecast_verification_records (submitted_at DESC);
--> statement-breakpoint
-- NOAA National Weather Service hourly forecast for a station's 0.1 degree position, captured each hour
-- for the stations forecasters target (NOAA's past forecasts cannot be read back later). A forecast is
-- compared with the latest capture issued at or before it was issued, for the same station and hour.
CREATE TABLE IF NOT EXISTS forecast_verification_noaa_reference (
  station_id text NOT NULL CHECK (length(station_id) BETWEEN 1 AND 128),
  issued_hour timestamptz NOT NULL,
  valid_hour timestamptz NOT NULL CHECK (valid_hour > issued_hour),
  temperature_c double precision,
  humidity_pct double precision CHECK (humidity_pct >= 0 AND humidity_pct <= 100),
  source text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, issued_hour, valid_hour)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_verification_noaa_reference_lookup
  ON forecast_verification_noaa_reference (station_id, valid_hour, issued_hour DESC);
