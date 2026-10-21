-- Advisory oracle-reference shadow scores (backend#866).
-- These rows are observational only and are not read by reward eligibility or minting.

CREATE TABLE IF NOT EXISTS "reference_scores" (
  "id" serial PRIMARY KEY,
  "commitment_id" integer NOT NULL,
  "station_id" text NOT NULL,
  "tier" text NOT NULL,
  "bands_version" integer NOT NULL,
  "worst_source" text,
  "worst_variable" text,
  "worst_residual" double precision,
  "worst_ratio" double precision,
  "residuals" jsonb NOT NULL,
  "analysis_residual" double precision,
  "forecast_error" double precision,
  "scored_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reference_scores_commitment_id_unique" UNIQUE ("commitment_id"),
  CONSTRAINT "reference_scores_tier_check"
    CHECK ("tier" IN ('good', 'degraded', 'outlier'))
);

CREATE INDEX IF NOT EXISTS "idx_reference_scores_station_scored"
  ON "reference_scores" ("station_id", "scored_at");

CREATE INDEX IF NOT EXISTS "idx_reference_scores_tier"
  ON "reference_scores" ("tier");
