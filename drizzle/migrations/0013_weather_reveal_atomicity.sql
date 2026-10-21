-- Adds an idempotency key for commit-reveal accounting rows.

ALTER TABLE "weather_submissions"
  ADD COLUMN IF NOT EXISTS "commitment_id" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_weather_submissions_commitment_id"
  ON "weather_submissions" ("commitment_id")
  WHERE "commitment_id" IS NOT NULL;
