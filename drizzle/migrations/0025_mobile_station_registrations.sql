-- Per-phone weather-station registration (backend#1288, stories B1 + B3).
-- Design: docs/plans/2026-09-29-per-phone-station-registration-design.md
--
-- mobile_station_registrations
--   One row per wallet (owner_address is UNIQUE and always lowercase 0x-hex).
--   station_id is DERIVED from the wallet by the server ("mob-" + 32 hex), never
--   client-chosen. cell_lat_e1 / cell_lon_e1 are the registered 0.1 degree cell in
--   integer tenths of a degree (the exact integers signed in preimage A); the
--   phone's exact position is never stored. The two signatures and owner_pubkey are
--   public proof material, kept so the operator can assemble the on-chain
--   StationRegistration payload later without contacting the phone (preimage B is
--   core4's station_ownership_message). status only records how far the operator's
--   on-chain batch has progressed; it grants nothing by itself.
--
-- mobile_station_nonces
--   Single-use, wallet-bound registration challenges with a short expiry.
--
-- Rollback (drizzle has no down migrations; run by hand if ever needed):
--   DROP TABLE IF EXISTS "mobile_station_nonces";
--   DROP TABLE IF EXISTS "mobile_station_registrations";

CREATE TABLE IF NOT EXISTS "mobile_station_registrations" (
  "station_id"             text PRIMARY KEY,
  "owner_address"          text NOT NULL,
  "owner_pubkey"           text NOT NULL,
  "cell_lat_e1"            integer NOT NULL,
  "cell_lon_e1"            integer NOT NULL,
  "device_class"           text NOT NULL DEFAULT 'phone-barometer',
  "registration_nonce"     text NOT NULL,
  "registration_expires_at" bigint NOT NULL,
  "registration_signature" text NOT NULL,
  "ownership_signature"    text NOT NULL,
  "status"                 text NOT NULL DEFAULT 'db_only',
  "governance_batch_id"    text,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mobile_station_registrations_owner_unique" UNIQUE ("owner_address"),
  CONSTRAINT "mobile_station_registrations_status_check"
    CHECK ("status" IN ('db_only', 'submitted', 'on_chain')),
  CONSTRAINT "mobile_station_registrations_owner_lowercase_check"
    CHECK ("owner_address" = lower("owner_address")),
  CONSTRAINT "mobile_station_registrations_cell_lat_check"
    CHECK ("cell_lat_e1" BETWEEN -900 AND 900),
  CONSTRAINT "mobile_station_registrations_cell_lon_check"
    CHECK ("cell_lon_e1" BETWEEN -1800 AND 1800)
);

CREATE INDEX IF NOT EXISTS "mobile_station_registrations_status_idx"
  ON "mobile_station_registrations" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "mobile_station_nonces" (
  "nonce"         text PRIMARY KEY,
  "owner_address" text NOT NULL,
  "station_id"    text NOT NULL,
  "expires_at"    bigint NOT NULL,
  "consumed_at"   timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "mobile_station_nonces_owner_idx"
  ON "mobile_station_nonces" ("owner_address", "expires_at");
