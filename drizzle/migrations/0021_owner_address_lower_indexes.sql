-- backend#1210 follow-up: expression indexes for the case-insensitive owner
-- reads introduced by #1211. The queries compare lower(owner_address), which
-- the existing plain btree indexes on owner_address cannot serve:
--   * weather_stations: per-owner cap COUNT and the /api/weather/data and
--     reward-progress ownership reads;
--   * station_reward_cycles: the reward-progress read
--     (station_id, lower(owner_address), ORDER BY observation_accepted_at DESC);
--   * devices_consolidated: the operator ?ownerAddress= status filter (only
--     if the table exists; no migration in this set creates it).
--
-- NOT CONCURRENTLY: drizzle's migrator applies every pending migration inside
-- one transaction (drizzle-orm pg-core dialect migrate -> session.transaction),
-- and Postgres rejects CREATE INDEX CONCURRENTLY inside a transaction block.
-- A plain CREATE INDEX takes a SHARE lock (reads continue, writes to that
-- table wait) for the duration of the build. These tables are small today;
-- for a large table, pre-create the same indexes CONCURRENTLY with
-- drizzle/manual/1210-owner-lower-indexes-concurrently.sql before deploying,
-- and these IF NOT EXISTS statements become no-ops.
--
-- The old plain owner_address indexes are kept; dropping them is a separate
-- decision.
CREATE INDEX IF NOT EXISTS "idx_weather_stations_owner_lower"
  ON "weather_stations" (lower("owner_address"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_reward_cycles_owner_lower_station"
  ON "station_reward_cycles" (lower("owner_address"), "station_id", "observation_accepted_at" DESC);
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('devices_consolidated') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "idx_devices_consolidated_owner_lower" ON "devices_consolidated" (lower("owner_address"))';
  ELSE
    RAISE NOTICE 'backend#1210 owner lower indexes: devices_consolidated absent, skipped';
  END IF;
END
$$;
