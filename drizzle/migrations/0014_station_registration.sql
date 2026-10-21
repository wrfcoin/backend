-- Migration: self-service weather-station registration (backend#788)
--
-- 1. Adds nullable geo/identity columns to weather_stations so contributor
--    stations carry their own lat/lng/name/type. Nullable so pre-existing rows
--    stay valid; the contributor map only renders rows where latitude IS NOT NULL.
-- 2. Adds station_provider_credentials, holding per-station provider API keys
--    encrypted at rest (AES-256-GCM). The collector decrypts server-side via the
--    internal credentials endpoint; the key (API_KEY_ENCRYPTION_KEY) never leaves
--    the backend.
--
-- All statements are IF NOT EXISTS so this migration is idempotent across replay
-- and can be applied to the live N5 DB without a full migrate.

ALTER TABLE "weather_stations"
  ADD COLUMN IF NOT EXISTS "latitude"     double precision,
  ADD COLUMN IF NOT EXISTS "longitude"    double precision,
  ADD COLUMN IF NOT EXISTS "name"         text,
  ADD COLUMN IF NOT EXISTS "station_type" text;

CREATE TABLE IF NOT EXISTS "station_provider_credentials" (
  "id"                serial PRIMARY KEY NOT NULL,
  "station_id"        text NOT NULL,
  "provider"          text NOT NULL DEFAULT 'ambient',
  "encrypted_api_key" text NOT NULL,
  "key_iv"            text NOT NULL,
  "key_tag"           text NOT NULL,
  "encrypted_app_key" text,
  "app_iv"            text,
  "app_tag"           text,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "rotated_at"        timestamp with time zone,
  CONSTRAINT "uq_station_provider_credentials_station_provider"
    UNIQUE ("station_id", "provider")
);

-- FK to weather_stations.station_id (the unique business key). Added separately
-- and guarded so replay does not error if it already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'station_provider_credentials_station_id_fk'
  ) THEN
    ALTER TABLE "station_provider_credentials"
      ADD CONSTRAINT "station_provider_credentials_station_id_fk"
      FOREIGN KEY ("station_id") REFERENCES "weather_stations"("station_id")
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_station_provider_credentials_station"
  ON "station_provider_credentials" ("station_id");
