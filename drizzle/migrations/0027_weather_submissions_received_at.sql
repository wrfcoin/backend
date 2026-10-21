-- Trusted server-received time for weather_submissions (Refs wrfcoin/backend#1382,
-- wrfcoin/mobile#299).
--
-- submitted_at is the CLIENT's reading time (persistWeatherSubmission inserts the
-- request timestamp), so it cannot decide which rows belong to an already
-- published temperature day. received_at is the server's own clock at INSERT:
-- no writer lists it in its INSERT column list, so the default always applies and
-- nothing in a request can set it. The temperature-history release counts a row
-- toward UTC day D only if submitted_at falls in D AND received_at <= D_end + grace,
-- which keeps a published day stable forever.
--
-- Order matters and runs in this one migration transaction: add the column
-- (nullable), backfill legacy rows, then SET DEFAULT and SET NOT NULL. The ALTER
-- holds an ACCESS EXCLUSIVE lock until commit, so no row can be inserted with a
-- NULL received_at in between. Lock time is the UPDATE below; it is a single
-- pass over the table.
--
-- Legacy rows: received_at = LEAST(submitted_at, now()) (never a future time).
-- That is the client's reading time, NOT a trusted receive time. By owner ruling
-- ("Backfill from reading time") this is accepted because every pre-launch row
-- came only from the operator's own devices. Rows inserted after this migration
-- get a genuine server time.
--
-- Rerunnable: the column guard and the WHERE received_at IS NULL filter make a
-- second run a no-op.
--
-- weather_temperature_daily_release: the FIRST published aggregate for one
-- (0.1 degree cell, UTC day), frozen. received_at defaults to now(), which is the
-- TRANSACTION START time, so a qualifying write can still be uncommitted when a
-- day is first published and become visible afterwards. The read path therefore
-- inserts the day's aggregate ON CONFLICT DO NOTHING and serves only from this
-- table: a released day never changes and every query window reads the same row.
-- A suppressed day (fewer than 5 distinct contributors) is stored with NULL
-- values so it stays suppressed. Days with no eligible row are not stored.
-- Write amplification is bounded by real data: at most one row per cell and day
-- that has eligible readings, written by authenticated, rate-limited requests.
--
-- Rollback (drizzle has no down migrations; run by hand if ever needed):
--   DROP TABLE IF EXISTS "weather_temperature_daily_release";
--   ALTER TABLE "weather_submissions" DROP COLUMN IF EXISTS "received_at";

ALTER TABLE "weather_submissions"
  ADD COLUMN IF NOT EXISTS "received_at" timestamptz;

UPDATE "weather_submissions"
  SET "received_at" = LEAST("submitted_at", now())
  WHERE "received_at" IS NULL;

ALTER TABLE "weather_submissions"
  ALTER COLUMN "received_at" SET DEFAULT now();

ALTER TABLE "weather_submissions"
  ALTER COLUMN "received_at" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "weather_temperature_daily_release" (
  "lat_e1"       integer NOT NULL CHECK ("lat_e1" BETWEEN -900 AND 900),
  "lon_e1"       integer NOT NULL CHECK ("lon_e1" BETWEEN -1800 AND 1800),
  "day"          date NOT NULL,
  "min_c"        numeric(6, 2),
  "max_c"        numeric(6, 2),
  "mean_c"       numeric(6, 2),
  "count_bucket" integer CHECK ("count_bucket" IS NULL OR "count_bucket" >= 0),
  "released_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("lat_e1", "lon_e1", "day"),
  CONSTRAINT "weather_temperature_daily_release_all_or_none" CHECK (
    ("min_c" IS NULL) = ("max_c" IS NULL)
    AND ("max_c" IS NULL) = ("mean_c" IS NULL)
    AND ("mean_c" IS NULL) = ("count_bucket" IS NULL)
  )
);
