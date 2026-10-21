-- Day-leading access for bounded hourly IPFS archive queries (Refs backend#1117).
-- The existing cell-leading primary key serves temperature-history reads.
-- Apply before owner enablement of the archive worker. This additive index
-- uses the ordinary migration transaction; its build blocks table writes.
CREATE INDEX IF NOT EXISTS "weather_temperature_daily_release_day_cells_idx"
  ON "weather_temperature_daily_release" ("day", "lat_e1", "lon_e1");
