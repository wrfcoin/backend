-- Migration: weather commit-reveal core4 hash parity (backend#767)
-- Adds nullable commit_timestamp (Unix seconds) to weather_commitments.
--
-- The backend now derives the commit hash exactly as the core4 node does
-- (SHA3-256 over data||nonce||station_id||timestamp||contribution_type), which
-- requires the timestamp used at commit time to be persisted and replayed at
-- reveal time. Pre-#767 commitments have NULL here (they used the old BLAKE3
-- hash and can no longer produce a core4-valid reveal). The column is nullable
-- and IF NOT EXISTS so this migration is idempotent across replay and matches
-- the runtime backfill in ensureWeatherTables.

ALTER TABLE "weather_commitments"
  ADD COLUMN IF NOT EXISTS "commit_timestamp" integer;
