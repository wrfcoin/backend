-- Practice scores for website forecasts: one row per forecast once its target time has passed.
-- The score is the integer skill rule (server/services/forecast-score/practice-score.ts): fixed-point
-- values (temperature 0.01 degC, pressure Pa), skill in millionths. Nothing here is paid or feeds rewards.
-- No personal data, no coordinates, no station id (the forecast row already names the station).
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before setting
-- WEBSITE_FORECAST_SCORE_ENABLED=true. Rerunnable (IF NOT EXISTS). Needs 0043_website_forecasts.
--
-- Down (reversible): DROP TABLE website_forecast_scores;
CREATE TABLE IF NOT EXISTS website_forecast_scores (
  commit_id text PRIMARY KEY CHECK (commit_id ~ '^[0-9a-f]{64}$'),
  -- pending: looked, no reading yet or the node could not be read (retried until 24 h after the target time).
  status text NOT NULL CHECK (status IN ('pending', 'scored', 'unscored')),
  -- Why it is unscored; on a pending row, 'node_unavailable' or null (no reading yet).
  reason text CHECK (reason IN ('no_reading', 'no_baseline', 'node_unavailable', 'out_of_range')),
  unit text NOT NULL CHECK (unit IN ('temp_c_centi', 'pressure_pa')),
  -- Target time used for the score: the commit block's time plus the lead ('chain'), or the draft's
  -- own target time when the commit height is not known ('draft').
  valid_at timestamptz NOT NULL,
  valid_at_source text NOT NULL CHECK (valid_at_source IN ('chain', 'draft')),
  forecast_fp bigint,
  truth_fp bigint,
  truth_observed_at timestamptz,
  -- The truth reading itself: its chain commit id and the block it landed in, so the score can be checked.
  truth_commit_id text CHECK (length(truth_commit_id) <= 128),
  truth_height bigint,
  err_fp bigint,
  ref_fp bigint,
  ref_kind text CHECK (ref_kind IN ('climatology_spread', 'persistence_spread')),
  mean24_fp bigint,
  last_fp bigint,
  window_samples integer,
  tol integer,
  copied boolean,
  skill integer CHECK (skill BETWEEN 0 AND 1000000),
  beat_baseline boolean,
  -- NOAA National Weather Service forecast for the same station and hour, when one was captured before
  -- the forecast was made (temperature only), scored by the same rule.
  nws_fp bigint,
  nws_err_fp bigint,
  nws_skill integer CHECK (nws_skill BETWEEN 0 AND 1000000),
  nws_lead_hours integer,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  scored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
