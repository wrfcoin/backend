-- Free-play forecast duels (backend#228, #1424; owner demo queue 2026-11-01, item 10).
-- NO stakes, escrow or payout columns: funded duels are a separate consensus feature (forecast_duels_v1,
-- owner rulings 2026-10-02 / 2026-10-03) and are not built here. The verdict comes from the chain's own
-- finalized forecast rewards.
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before setting
-- FORECAST_DUELS_ENABLED=true. Rerunnable (IF NOT EXISTS).
--
-- Down (reversible): DROP TABLE forecast_duel_entries; DROP TABLE forecast_duels;
--
-- The 2026-04 drizzle `forecast_duels` shape (stake_amount, target_value) in shared/schema-duels.ts was
-- never migrated and is removed. If a database somehow has that old table, this migration stops on the
-- column check below instead of silently reusing it.
CREATE TABLE IF NOT EXISTS forecast_duels (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  station_alias text NOT NULL CHECK (station_alias ~ '^st_[0-9a-f]{12}$'),
  target_at timestamptz NOT NULL,
  lock_at timestamptz NOT NULL CHECK (lock_at < target_at),
  creator_address text NOT NULL CHECK (creator_address ~ '^0x[0-9a-f]{40}$'),
  -- Invited wallet while open; the accepting wallet once matched.
  opponent_address text CHECK (opponent_address ~ '^0x[0-9a-f]{40}$' AND opponent_address <> creator_address),
  status text NOT NULL CHECK (status IN ('open', 'matched', 'resolved', 'void')),
  outcome text CHECK (outcome IN ('creator', 'opponent', 'draw', 'void')),
  outcome_reason text,
  winner_address text CHECK (winner_address ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  matched_at timestamptz,
  resolved_at timestamptz
);
--> statement-breakpoint
DO $$ BEGIN
  -- Looked up through the search_path (the relation the app sees), like the other migrations.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('forecast_duels')
      AND attname = 'lock_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'forecast_duels exists with an unexpected shape; inspect it before applying 0041_forecast_duels';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_duels_status_target ON forecast_duels (status, target_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_duels_creator ON forecast_duels (creator_address);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS forecast_duels_opponent ON forecast_duels (opponent_address);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forecast_duel_entries (
  duel_id text NOT NULL REFERENCES forecast_duels(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  -- One forecast commit can serve one duel entry only.
  commit_id text NOT NULL UNIQUE CHECK (commit_id ~ '^[0-9a-f]{64}$'),
  linked_at timestamptz NOT NULL,
  -- The commit record was handed in after the reveal and hashes to commit_id (valid_at = target_at).
  record_ok boolean NOT NULL DEFAULT false,
  model_id text,
  forecast_values jsonb,
  -- The chain's forecast reward for this commit (reward-evidence), as the resolver last read it.
  reward_amount text CHECK (reward_amount ~ '^(0|[1-9][0-9]{0,38})$'),
  reward_finalized boolean NOT NULL DEFAULT false,
  entry_status text NOT NULL DEFAULT 'linked' CHECK (entry_status IN ('linked', 'invalid')),
  invalid_reason text,
  PRIMARY KEY (duel_id, address)
);
