-- OPTIONAL pre-deploy step for large tables (backend#1210 follow-up).
--
-- Migration 0021 creates these indexes with a plain CREATE INDEX, because
-- drizzle runs migrations inside a transaction and CONCURRENTLY is not allowed
-- there. A plain build blocks writes to the table while it runs. If a table is
-- large enough that this matters, run this file BEFORE deploying, OUTSIDE a
-- transaction (psql autocommit; one statement at a time):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/manual/1210-owner-lower-indexes-concurrently.sql
--
-- Identical names and definitions, so 0021's IF NOT EXISTS then skips them.
-- (__tests__/owner-address-lowercase-migration.test.ts pins every ON (...)
-- definition here to 0021's; change both files together.)
--
-- If a CONCURRENTLY build fails it leaves an INVALID index, and IF NOT EXISTS
-- (here and in 0021) matches by name only, so it would keep the invalid one.
-- After running this file, and before deploying, check (read-only):
--
--   SELECT indexrelid::regclass AS invalid_index, indrelid::regclass AS on_table
--     FROM pg_index
--    WHERE NOT indisvalid
--      AND indexrelid::regclass::text IN ('idx_weather_stations_owner_lower',
--                                         'idx_station_reward_cycles_owner_lower_station',
--                                         'idx_devices_consolidated_owner_lower');
--
-- Expect zero rows. For any row: DROP INDEX CONCURRENTLY <invalid_index>; then
-- re-run its CREATE statement below. (Drop the name filter to list every
-- invalid index in the database.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_weather_stations_owner_lower"
  ON "weather_stations" (lower("owner_address"));
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_station_reward_cycles_owner_lower_station"
  ON "station_reward_cycles" (lower("owner_address"), "station_id", "observation_accepted_at" DESC);
-- Only if the table exists in this deployment:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_devices_consolidated_owner_lower"
--   ON "devices_consolidated" (lower("owner_address"));
