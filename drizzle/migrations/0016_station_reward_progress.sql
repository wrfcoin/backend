-- Evidence-backed station reward progress (core4#2456).
--
-- One row binds an authenticated station owner to one accepted canonical
-- observation and, as evidence arrives, to one current-chain contribution
-- reward. Registration alone intentionally creates no cycle.

CREATE TABLE IF NOT EXISTS "station_reward_cycles" (
  "cycle_id"                   text PRIMARY KEY,
  "station_id"                 text NOT NULL,
  "owner_address"              text NOT NULL,
  "observation_id"             text NOT NULL,
  "observation_digest"         text NOT NULL,
  "observation_observed_at"    timestamp with time zone NOT NULL,
  "observation_accepted_at"    timestamp with time zone NOT NULL,

  "network_id"                 text,
  "chain_id"                   text,
  "genesis_hash"               text,
  "commit_id"                  text,
  "commit_accepted_at"         timestamp with time zone,
  "commit_mined_height"        bigint,
  "commit_mined_hash"          text,

  "approvals"                  integer,
  "rejections"                 integer,
  "required_quorum"            integer,
  "quorum_mined_at"            timestamp with time zone,

  "reveal_accepted_at"         timestamp with time zone,
  "reveal_mined_height"        bigint,
  "reveal_mined_hash"          text,

  "reward_amount_base_units"   text,
  "reward_address"             text,
  "reward_reason"              text,
  "reward_block_height"        bigint,
  "reward_block_hash"          text,
  "reward_block_time"          timestamp with time zone,
  "account_earned_before"      text,
  "account_earned_after"       text,
  "finality_policy"            text,
  "authoritative_finalized_height" bigint,
  "canonical_hash_checked_at"  timestamp with time zone,
  "finalized_at"               timestamp with time zone,

  "lifecycle_state"            text NOT NULL DEFAULT 'OBSERVATION_RECEIVED',
  "failure_code"               text,
  "stalled_since"              timestamp with time zone,
  "evidence_refreshed_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "version"                    integer NOT NULL DEFAULT 1,

  CONSTRAINT "station_reward_cycles_station_fk"
    FOREIGN KEY ("station_id") REFERENCES "weather_stations"("station_id")
    ON DELETE CASCADE,
  CONSTRAINT "station_reward_cycles_observation_unique"
    UNIQUE ("station_id", "observation_id"),
  CONSTRAINT "station_reward_cycles_lifecycle_check"
    CHECK ("lifecycle_state" IN (
      'OBSERVATION_RECEIVED',
      'VERIFYING',
      'QUORUM_REACHED',
      'FINALIZING_REWARD',
      'REWARDED',
      'FAILED'
    )),
  CONSTRAINT "station_reward_cycles_nonnegative_counts"
    CHECK (
      ("approvals" IS NULL OR "approvals" >= 0)
      AND ("rejections" IS NULL OR "rejections" >= 0)
      AND ("required_quorum" IS NULL OR "required_quorum" > 0)
    ),
  CONSTRAINT "station_reward_cycles_chain_identity_complete"
    CHECK (
      ("network_id" IS NULL AND "chain_id" IS NULL AND "genesis_hash" IS NULL)
      OR
      ("network_id" IS NOT NULL AND "chain_id" IS NOT NULL AND "genesis_hash" IS NOT NULL)
    ),
  CONSTRAINT "station_reward_cycles_finality_policy_check"
    CHECK (
      "finality_policy" IS NULL
      OR "finality_policy" IN ('BFT', 'PROBABILISTIC_DEPTH')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_station_reward_cycles_chain_commit"
  ON "station_reward_cycles" ("network_id", "chain_id", "genesis_hash", "commit_id")
  WHERE "commit_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_station_reward_cycles_owner_station"
  ON "station_reward_cycles" ("owner_address", "station_id", "observation_accepted_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_station_reward_cycles_state_refresh"
  ON "station_reward_cycles" ("lifecycle_state", "evidence_refreshed_at");

CREATE TABLE IF NOT EXISTS "station_reward_cycle_events" (
  "id"              bigserial PRIMARY KEY,
  "cycle_id"        text NOT NULL,
  "event_type"      text NOT NULL,
  "from_state"      text,
  "to_state"        text NOT NULL,
  "evidence"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "observed_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "station_reward_cycle_events_cycle_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "station_reward_cycles"("cycle_id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_station_reward_cycle_events_cycle"
  ON "station_reward_cycle_events" ("cycle_id", "observed_at");
