-- Migration: geographic leaderboard filter (backend#693)
-- Adds nullable country (ISO 3166-1 alpha-2) and city columns to
-- weather_submissions plus indexes used by the leaderboard geofilter.
--
-- Columns are nullable so pre-existing rows stay valid; the API falls back
-- to NULL in response payloads when the values are absent. Indexes are
-- IF NOT EXISTS so this migration is idempotent across replay.

ALTER TABLE "weather_submissions"
  ADD COLUMN IF NOT EXISTS "country" text,
  ADD COLUMN IF NOT EXISTS "city"    text;

-- Country filter: exact-match lookups drive the ?country=XX query and the
-- ?region=<bucket> expansion (WHERE country = ANY($N)).
CREATE INDEX IF NOT EXISTS "idx_weather_submissions_country"
  ON "weather_submissions" ("country");

-- Bounding-box prefilter for ?near= Haversine queries. Composite index on
-- (latitude, longitude) supports WHERE latitude BETWEEN ? AND ? AND
-- longitude BETWEEN ? AND ? without scanning the full table.
CREATE INDEX IF NOT EXISTS "idx_weather_submissions_lat_lng"
  ON "weather_submissions" ("latitude", "longitude");
