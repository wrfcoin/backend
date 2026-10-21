-- Backend-owned oracle work broker foundation (#853 / core4#2464).
-- This migration stores only canonical, non-secret work and audit evidence.
-- Its Drizzle declarations live in shared/oracle-work-schema.ts; keep both in
-- sync so generation does not remove these columns, indexes, or constraints.

ALTER TABLE "station_reward_cycles"
  ADD COLUMN IF NOT EXISTS "work_id" text,
  ADD COLUMN IF NOT EXISTS "work_schema_version" integer,
  ADD COLUMN IF NOT EXISTS "commit_hash" text,
  ADD COLUMN IF NOT EXISTS "nonce" text,
  ADD COLUMN IF NOT EXISTS "commit_timestamp" bigint,
  ADD COLUMN IF NOT EXISTS "reveal_deadline" bigint;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_station_reward_cycles_work"
  ON "station_reward_cycles" ("genesis_hash", "work_id")
  WHERE "genesis_hash" IS NOT NULL AND "work_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "oracle_work_items" (
  "work_id" text PRIMARY KEY,
  "schema_version" integer NOT NULL DEFAULT 1,
  "cycle_id" text NOT NULL,
  "station_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "observation_digest" text NOT NULL,
  "canonical_reading" jsonb NOT NULL,
  "owner_address" text NOT NULL,
  "chain_id" text NOT NULL,
  "network_id" text NOT NULL,
  "genesis_hash" text NOT NULL,
  "commit_id" text NOT NULL,
  "commit_hash" text NOT NULL,
  "nonce" text NOT NULL,
  "commit_timestamp" bigint NOT NULL,
  "reveal_deadline" bigint NOT NULL,
  "required_quorum" integer NOT NULL DEFAULT 2,
  "evidence_timestamp" timestamp with time zone NOT NULL,
  "lifecycle_state" text NOT NULL DEFAULT 'ATTESTATIONS_PENDING',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "oracle_work_items_cycle_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "station_reward_cycles"("cycle_id")
    ON DELETE CASCADE,
  CONSTRAINT "oracle_work_items_version_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "oracle_work_items_quorum_check"
    CHECK ("required_quorum" > 0 AND "required_quorum" <= 2),
  CONSTRAINT "oracle_work_items_time_check"
    CHECK ("commit_timestamp" > 0 AND "reveal_deadline" >= "commit_timestamp"),
  CONSTRAINT "oracle_work_items_state_check"
    CHECK ("lifecycle_state" IN (
      'ATTESTATIONS_PENDING',
      'QUORUM_MINED',
      'REVEAL_CLAIMED',
      'REVEAL_SUBMITTED',
      'REWARD_ENTRY_OBSERVED',
      'FINALITY_RECONCILED',
      'ACCOUNT_RECONCILED',
      'MISSED_QUORUM'
    )),
  CONSTRAINT "oracle_work_items_digest_check"
    CHECK ("observation_digest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_oracle_work_items_cycle_version"
  ON "oracle_work_items" ("genesis_hash", "cycle_id", "schema_version");

CREATE INDEX IF NOT EXISTS "idx_oracle_work_items_state_deadline"
  ON "oracle_work_items" ("lifecycle_state", "reveal_deadline");

CREATE OR REPLACE FUNCTION "oracle_work_items_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."work_id" IS DISTINCT FROM NEW."work_id"
     OR OLD."schema_version" IS DISTINCT FROM NEW."schema_version"
     OR OLD."cycle_id" IS DISTINCT FROM NEW."cycle_id"
     OR OLD."station_id" IS DISTINCT FROM NEW."station_id"
     OR OLD."observation_id" IS DISTINCT FROM NEW."observation_id"
     OR OLD."observation_digest" IS DISTINCT FROM NEW."observation_digest"
     OR OLD."canonical_reading" IS DISTINCT FROM NEW."canonical_reading"
     OR OLD."owner_address" IS DISTINCT FROM NEW."owner_address"
     OR OLD."chain_id" IS DISTINCT FROM NEW."chain_id"
     OR OLD."network_id" IS DISTINCT FROM NEW."network_id"
     OR OLD."genesis_hash" IS DISTINCT FROM NEW."genesis_hash"
     OR OLD."commit_id" IS DISTINCT FROM NEW."commit_id"
     OR OLD."commit_hash" IS DISTINCT FROM NEW."commit_hash"
     OR OLD."nonce" IS DISTINCT FROM NEW."nonce"
     OR OLD."commit_timestamp" IS DISTINCT FROM NEW."commit_timestamp"
     OR OLD."reveal_deadline" IS DISTINCT FROM NEW."reveal_deadline"
     OR OLD."required_quorum" IS DISTINCT FROM NEW."required_quorum"
     OR OLD."evidence_timestamp" IS DISTINCT FROM NEW."evidence_timestamp"
  THEN
    RAISE EXCEPTION 'oracle work item immutable fields cannot change';
  END IF;
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "oracle_work_items_immutable" ON "oracle_work_items";
CREATE TRIGGER "oracle_work_items_immutable"
  BEFORE UPDATE ON "oracle_work_items"
  FOR EACH ROW EXECUTE FUNCTION "oracle_work_items_immutable_guard"();

CREATE TABLE IF NOT EXISTS "oracle_work_claim_results" (
  "work_id" text NOT NULL,
  "genesis_hash" text NOT NULL,
  "oracle_id" text NOT NULL,
  "attestation_version" integer NOT NULL DEFAULT 1,
  "state" text NOT NULL DEFAULT 'DISPATCHABLE',
  "lease_version" integer NOT NULL DEFAULT 0,
  "lease_expires_at" timestamp with time zone,
  "lease_token_hash" text,
  "idempotency_key" text,
  "result_digest" text,
  "approved" boolean,
  "confidence" double precision,
  "signature" text,
  "attestation_timestamp" bigint,
  "result_code" text,
  "core4_tx_id" text,
  "core4_mined_at" timestamp with time zone,
  "evidence_timestamp" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("genesis_hash", "work_id", "oracle_id", "attestation_version"),
  CONSTRAINT "oracle_work_claim_results_work_fk"
    FOREIGN KEY ("work_id") REFERENCES "oracle_work_items"("work_id")
    ON DELETE CASCADE,
  CONSTRAINT "oracle_work_claim_results_oracle_check"
    CHECK ("oracle_id" IN ('workstation', 'n5pro')),
  CONSTRAINT "oracle_work_claim_results_version_check"
    CHECK ("attestation_version" > 0),
  CONSTRAINT "oracle_work_claim_results_state_check"
    CHECK ("state" IN (
      'DISPATCHABLE',
      'CLAIMED',
      'VALIDATED',
      'SIGNED',
      'SUBMITTED',
      'MINED',
      'REJECTED',
      'EXPIRED',
      'FAILED'
    ))
);

CREATE INDEX IF NOT EXISTS "idx_oracle_work_claim_results_claimable"
  ON "oracle_work_claim_results" ("oracle_id", "state", "lease_expires_at");

CREATE INDEX IF NOT EXISTS "idx_oracle_work_claim_results_work_state"
  ON "oracle_work_claim_results" ("work_id", "genesis_hash", "state");
