-- IoTeX device registry, device data, attestation requests and W3bstream
-- publisher/event tables queried by the mounted /api/iotex routes
-- (server/routes/iotex.js, backend#1171). PR#1138 mounted the router without
-- them, so every DB handler answered 500.
-- Keep this migration aligned with shared/schema-iotex.ts.
--
-- 0006_iot_gateway_geofence.sql already ALTERs iotex_devices IF EXISTS; on a
-- database migrated before this file that was a no-op, so the geo-fence
-- columns and indexes are created here as part of the table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_type') THEN
    CREATE TYPE device_type AS ENUM (
      'WEATHER_STATION',
      'AIR_QUALITY_MONITOR',
      'TEMPERATURE_SENSOR',
      'WIND_SENSOR',
      'RAINFALL_SENSOR',
      'HUMIDITY_SENSOR',
      'PRESSURE_SENSOR',
      'SOLAR_RADIATION_SENSOR',
      'MULTI_SENSOR',
      'OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attestation_status') THEN
    CREATE TYPE attestation_status AS ENUM ('PENDING', 'ATTESTING', 'ATTESTED', 'FAILED', 'EXPIRED', 'REVOKED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attestation_type') THEN
    CREATE TYPE attestation_type AS ENUM ('TEE', 'TPM', 'SECURE_ELEMENT', 'IOTEX_SOVEREIGN');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "iotex_devices" (
  "id" varchar(64) PRIMARY KEY,
  "name" varchar(256) NOT NULL,
  "type" device_type NOT NULL,
  "attestation_status" attestation_status NOT NULL DEFAULT 'PENDING',
  "attestation_type" attestation_type,
  "last_seen" timestamp,
  "latitude" double precision,
  "longitude" double precision,
  "geohash" varchar(12),
  "geo_fence_grid" varchar(16),
  "geo_fence_status" varchar(32) NOT NULL DEFAULT 'clear',
  "geo_fence_reason" text,
  "geo_fence_burst_count" integer NOT NULL DEFAULT 0,
  "geo_fence_window_started_at" timestamp,
  "geo_fence_triggered_at" timestamp,
  "geo_fence_reviewed_at" timestamp,
  "geo_fence_reviewed_by" varchar(128),
  "metadata" jsonb,
  "owner" varchar(64),
  "public_key" text,
  "firmware_version" varchar(50),
  "hardware_id" varchar(100),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "iotex_devices_geo_fence_grid_idx" ON "iotex_devices" ("geo_fence_grid");
CREATE INDEX IF NOT EXISTS "iotex_devices_geo_fence_status_idx" ON "iotex_devices" ("geo_fence_status");

CREATE TABLE IF NOT EXISTS "iotex_device_data" (
  "id" uuid PRIMARY KEY,
  "device_id" varchar(64) NOT NULL,
  "data" jsonb NOT NULL,
  "timestamp" timestamp NOT NULL,
  "verified" boolean NOT NULL DEFAULT false,
  "signature" text,
  "blockchain_reference" varchar(100),
  "transaction_id" varchar(100),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "iotex_device_data_device_id_iotex_devices_id_fk"
    FOREIGN KEY ("device_id") REFERENCES "iotex_devices"("id")
);

CREATE INDEX IF NOT EXISTS "iotex_device_data_device_id_timestamp_idx" ON "iotex_device_data" ("device_id", "timestamp");

CREATE TABLE IF NOT EXISTS "iotex_attestation_requests" (
  "id" uuid PRIMARY KEY,
  "device_id" varchar(64) NOT NULL,
  "attestation_type" attestation_type NOT NULL,
  "status" attestation_status NOT NULL DEFAULT 'PENDING',
  "challenge" text NOT NULL,
  "response" jsonb,
  "metadata" jsonb,
  "expires_at" timestamp NOT NULL,
  "completed_at" timestamp,
  "failed_at" timestamp,
  "failure_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "iotex_attestation_requests_device_id_iotex_devices_id_fk"
    FOREIGN KEY ("device_id") REFERENCES "iotex_devices"("id")
);

CREATE INDEX IF NOT EXISTS "iotex_attestation_requests_device_id_idx" ON "iotex_attestation_requests" ("device_id");

CREATE TABLE IF NOT EXISTS "iotex_w3bstream_publishers" (
  "id" varchar(64) PRIMARY KEY,
  "name" varchar(256) NOT NULL,
  "type" device_type NOT NULL,
  "public_key" text NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'ACTIVE',
  "device_id" varchar(64),
  "last_event_timestamp" timestamp,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "iotex_w3bstream_publishers_device_id_iotex_devices_id_fk"
    FOREIGN KEY ("device_id") REFERENCES "iotex_devices"("id")
);

CREATE TABLE IF NOT EXISTS "iotex_w3bstream_events" (
  "id" uuid PRIMARY KEY,
  "publisher_id" varchar(64) NOT NULL,
  "event_type" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL,
  "timestamp" timestamp NOT NULL,
  "blockchain_tx" varchar(100),
  "verified" boolean NOT NULL DEFAULT false,
  "device_data_id" uuid,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "iotex_w3bstream_events_publisher_id_fk"
    FOREIGN KEY ("publisher_id") REFERENCES "iotex_w3bstream_publishers"("id"),
  CONSTRAINT "iotex_w3bstream_events_device_data_id_iotex_device_data_id_fk"
    FOREIGN KEY ("device_data_id") REFERENCES "iotex_device_data"("id")
);

CREATE INDEX IF NOT EXISTS "iotex_w3bstream_events_publisher_id_timestamp_idx" ON "iotex_w3bstream_events" ("publisher_id", "timestamp");
