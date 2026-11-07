-- Forecasts made from the website and relayed to the chain (epic 7, design 2026-11-05, owner-approved
-- 2026-11-07). One row per relayed forecast commit. The row holds the reveal package (data, nonce,
-- timestamp, manifest) until the reveal lands, so a closed browser tab still reveals. The values are
-- public on chain minutes later anyway. No IP, email or other personal data: the wallet is the account.
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before setting
-- WEBSITE_FORECAST_ENABLED=true. Rerunnable (IF NOT EXISTS). Needs 0039_forecast_verification (the
-- "my forecasts" list joins its scores, and the worker files a record there after each reveal).
--
-- Down (reversible): DROP TABLE website_forecasts;
CREATE TABLE IF NOT EXISTS website_forecasts (
  commit_id text PRIMARY KEY CHECK (commit_id ~ '^[0-9a-f]{64}$'),
  forecaster text NOT NULL CHECK (forecaster ~ '^0x[0-9a-f]{40}$'),
  -- Raw chain station id: internal only. Public output uses station_alias (owner ruling 2026-09-27, Q5).
  station_id text NOT NULL CHECK (length(station_id) BETWEEN 1 AND 128),
  station_alias text NOT NULL CHECK (station_alias ~ '^st_[0-9a-f]{12}$'),
  variable text NOT NULL CHECK (variable IN ('temperature_c', 'pressure_hpa')),
  value double precision NOT NULL,
  horizon_hours integer NOT NULL CHECK (horizon_hours IN (1, 6, 12, 24)),
  issued_at timestamptz NOT NULL,
  valid_at timestamptz NOT NULL CHECK (valid_at > issued_at),
  -- UTC day of issued_at: the site cap is one forecast per wallet, station, lead and day.
  forecast_day date NOT NULL,
  data text NOT NULL CHECK (length(data) <= 4096),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 1 AND 128),
  commit_timestamp bigint NOT NULL,
  manifest jsonb NOT NULL,
  -- The commit's authorization; core4 #127 requires the same pair on the reveal.
  auth_pubkey text NOT NULL CHECK (auth_pubkey ~ '^[0-9a-f]{64}$'),
  auth_signature text NOT NULL CHECK (auth_signature ~ '^[0-9a-f]{128}$'),
  status text NOT NULL CHECK (status IN ('committing', 'committed', 'revealing', 'revealed', 'failed')),
  failure text CHECK (length(failure) <= 128),
  commit_tx_hash text CHECK (length(commit_tx_hash) <= 130),
  reveal_tx_hash text CHECK (length(reveal_tx_hash) <= 130),
  committed_at_height bigint,
  revealed_at_height bigint,
  record_filed boolean NOT NULL DEFAULT false,
  reveal_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  commit_seen_at timestamptz,
  reveal_sent_at timestamptz,
  last_checked_at timestamptz
);
--> statement-breakpoint
-- The site cap. A failed forecast frees its slot; the first forecast that reaches the chain keeps it,
-- so a wallet's first forecast is the one scored, never its best of several.
CREATE UNIQUE INDEX IF NOT EXISTS website_forecasts_one_per_day
  ON website_forecasts (forecaster, station_id, horizon_hours, forecast_day) WHERE status <> 'failed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS website_forecasts_open
  ON website_forecasts (created_at)
  WHERE status IN ('committing', 'committed', 'revealing') OR (status = 'revealed' AND NOT record_filed);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS website_forecasts_by_wallet
  ON website_forecasts (forecaster, created_at DESC);
