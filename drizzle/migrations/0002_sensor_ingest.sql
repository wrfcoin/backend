-- Migration: sensor ingest table (Lane 3 mobile barometer/GPS readings)
-- weather_submissions is the canonical submission table consumed by weather-streak-routes.ts

CREATE TABLE IF NOT EXISTS "weather_submissions" (
  "id"                  serial       PRIMARY KEY,
  "user_id"             integer      REFERENCES users(id),
  "wallet_address"      text,
  "device_id"           text,
  "station_id"          text,
  "latitude"            numeric(9, 6),
  "longitude"           numeric(9, 6),
  "altitude"            numeric(7, 2),
  "temperature"         numeric(6, 2),
  "humidity"            numeric(5, 2),
  "pressure"            numeric(7, 2),
  "wind_speed"          numeric(5, 2),
  "wind_direction"      numeric(5, 2),
  "rainfall"            numeric(6, 2),
  "quality_score"       integer      NOT NULL DEFAULT 100,
  "reward_amount"       numeric(20, 8) DEFAULT 0,
  "physics_violations"  jsonb        NOT NULL DEFAULT '[]',
  "source"              text         NOT NULL DEFAULT 'mobile',
  "submitted_at"        timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_weather_submissions_user_id"
  ON "weather_submissions" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_weather_submissions_wallet"
  ON "weather_submissions" ("wallet_address");

-- Composite index used by the recursive CTE streak queries in weather-streak-routes.ts
CREATE INDEX IF NOT EXISTS "idx_weather_submissions_user_date"
  ON "weather_submissions" ("user_id", "submitted_at");
