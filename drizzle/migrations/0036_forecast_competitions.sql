-- Weekly forecast competition (backend#251), points only. Read-side only: no users/stations dependency,
-- no balance, no prize and no consensus write. A row here is a FROZEN finished week; the live week is
-- computed from chain_forecast_decision_events (0035) on every read and is never stored.
--
-- A frozen week records the indexed block it was read through. That block is a foreign key into
-- chain_reward_blocks ON DELETE CASCADE, so a reorg rewind past it deletes the frozen week (and its
-- results) and the read model computes it again from the replacement blocks.
--
-- Down (reversible): DROP TABLE forecast_competition_results; DROP TABLE forecast_competitions;
CREATE TABLE forecast_competitions (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  week_label text NOT NULL CHECK (week_label ~ '^[0-9]{4}-W[0-9]{2}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at = starts_at + interval '7 days'),
  rule_id text NOT NULL CHECK (rule_id IN ('scored-forecasts-v1')),
  through_height bigint NOT NULL CHECK (through_height > 0),
  through_hash text NOT NULL CHECK (through_hash ~ '^[0-9a-f]{64}$'),
  entrants integer NOT NULL CHECK (entrants >= 0),
  forecasts bigint NOT NULL CHECK (forecasts >= 0),
  finalized_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, genesis_hash, week_label),
  FOREIGN KEY (chain_id, genesis_hash, through_height, through_hash)
    REFERENCES chain_reward_blocks(chain_id, genesis_hash, height, block_hash) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE forecast_competition_results (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  week_label text NOT NULL,
  rank integer NOT NULL CHECK (rank > 0),
  forecaster_address text NOT NULL CHECK (forecaster_address ~ '^0x[0-9a-f]{40}$'),
  points bigint NOT NULL CHECK (points >= 0),
  forecasts bigint NOT NULL CHECK (forecasts >= 0),
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id, genesis_hash, week_label, rank),
  UNIQUE (chain_id, genesis_hash, week_label, forecaster_address),
  FOREIGN KEY (chain_id, genesis_hash, week_label)
    REFERENCES forecast_competitions(chain_id, genesis_hash, week_label) ON DELETE CASCADE
);
