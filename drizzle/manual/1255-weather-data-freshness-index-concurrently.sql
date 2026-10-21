-- Refs #1255. Optional operator pre-create for a large weather_data table.
-- Run outside a transaction, before the application migration, not from Drizzle.
-- Confirm the existing index has the same definition and is valid first:
-- SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_weather_data_station_timestamp';
-- SELECT indexrelid::regclass FROM pg_index
-- WHERE NOT indisvalid AND indexrelid::regclass::text = 'idx_weather_data_station_timestamp';
-- IF NOT EXISTS does not repair an invalid or differently defined existing index.
-- Resolve such a pre-existing index explicitly before deploying. No automatic drop.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_weather_data_station_timestamp"
  ON "weather_data" ("station_id", "timestamp");
