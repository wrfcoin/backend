-- Hourly pairs for "how has my station compared?": a station's newest chain reading beside the
-- nearest National Weather Service observation for the station's 0.1-degree cell
-- (server/services/station-compare-history.ts). Read only for the station's owner.
-- No coordinates, no owner, no wallet. nws_station is the public NWS station identifier.
-- Rows older than 90 days are deleted by the sampler. Nothing here is paid or feeds rewards.
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before
-- setting STATION_COMPARE_HISTORY_ENABLED=true. Rerunnable. Apply after 0045.
--
-- Down (reversible): DROP TABLE station_compare_samples;
CREATE TABLE IF NOT EXISTS station_compare_samples (
  station_id text NOT NULL CHECK (length(station_id) BETWEEN 1 AND 128),
  -- The hour this pair stands for (start of the hour, UTC): at most one pair per station per hour.
  sampled_hour timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  temperature_c real CHECK (temperature_c > -90 AND temperature_c < 65),
  humidity_pct real CHECK (humidity_pct >= 0 AND humidity_pct <= 100),
  pressure_hpa real CHECK (pressure_hpa > 300 AND pressure_hpa < 1100),
  nws_station text NOT NULL CHECK (nws_station ~ '^[A-Z0-9]{3,6}$'),
  nws_observed_at timestamptz NOT NULL,
  nws_temperature_c real,
  nws_humidity_pct real,
  -- NWS barometricPressure as reported, in hPa. Treated as the altimeter setting (reduced to sea
  -- level), not pressure at the sensor: never subtract it from pressure_hpa; use the ratio.
  nws_barometric_hpa real,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, sampled_hour)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS station_compare_samples_hour_idx ON station_compare_samples (sampled_hour);
