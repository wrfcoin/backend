-- Lane 3 sprint migration: social onboarding + sponsorship + streak badges

ALTER TABLE IF EXISTS social_accounts
  ADD COLUMN IF NOT EXISTS smart_account_address text,
  ADD COLUMN IF NOT EXISTS smart_account_deploy_tx text,
  ADD COLUMN IF NOT EXISTS sponsored_tx_count integer NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS wormhole_transfers
  ADD COLUMN IF NOT EXISTS emitter_chain integer,
  ADD COLUMN IF NOT EXISTS emitter_address text,
  ADD COLUMN IF NOT EXISTS sequence bigint;

WITH replay_backfill AS (
  SELECT ctid, row_number() OVER () AS rn
  FROM wormhole_transfers
  WHERE emitter_chain IS NULL
     OR emitter_address IS NULL
     OR sequence IS NULL
)
UPDATE wormhole_transfers wt
SET
  emitter_chain = COALESCE(wt.emitter_chain, -1),
  emitter_address = COALESCE(wt.emitter_address, COALESCE(wt.transfer_id, CONCAT('legacy-', replay_backfill.rn::text))),
  sequence = COALESCE(wt.sequence, replay_backfill.rn::bigint)
FROM replay_backfill
WHERE wt.ctid = replay_backfill.ctid;

ALTER TABLE IF EXISTS wormhole_transfers
  ALTER COLUMN emitter_chain SET NOT NULL,
  ALTER COLUMN emitter_address SET NOT NULL,
  ALTER COLUMN sequence SET NOT NULL;

DROP INDEX IF EXISTS idx_wormhole_transfers_emitter_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wormhole_transfers_emitter_unique'
  ) THEN
    ALTER TABLE wormhole_transfers
      ADD CONSTRAINT wormhole_transfers_emitter_unique
      UNIQUE (emitter_chain, emitter_address, sequence);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS streak_checkins (
  user_id integer NOT NULL,
  date_key date NOT NULL,
  tz_offset_minutes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, date_key)
);

CREATE TABLE IF NOT EXISTS streak_badge_claims (
  user_id integer NOT NULL,
  milestone_days integer NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT NOW(),
  tx_hash text,
  nft_contract text,
  token_id text,
  PRIMARY KEY (user_id, milestone_days)
);

CREATE INDEX IF NOT EXISTS idx_streak_checkins_user_created
  ON streak_checkins (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_streak_badge_claims_user_claimed
  ON streak_badge_claims (user_id, claimed_at);
