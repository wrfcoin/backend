-- Refs #1255. The public station freshness query reads MAX(timestamp) per station.
-- shared/schema.ts declared this index, but the active migration chain did not.
-- Drizzle applies migrations in a transaction: use ordinary CREATE INDEX here.
-- This takes a SHARE lock and blocks weather_data writes during the build.
-- For a large observation table, an operator can pre-create the same valid index
-- with drizzle/manual/1255-weather-data-freshness-index-concurrently.sql before
-- deploying; IF NOT EXISTS then leaves that index in place.
CREATE INDEX IF NOT EXISTS "idx_weather_data_station_timestamp"
  ON "weather_data" ("station_id", "timestamp");
