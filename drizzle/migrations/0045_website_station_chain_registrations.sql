-- On-chain registration progress for stations connected on the website.
--
-- A station connected on the website is a weather_stations row. It earns only once a
-- governance-signed StationRegistration for it is on chain, and that registration needs the
-- owner's own proof: a signature by the owner wallet over core4's station_ownership_message
-- (chain, network, station id, owner address). The website wallet signs that once; the proof is
-- public material (a public key and a signature), kept here so the operator can export one batch
-- for the owner to sign without contacting each wallet again.
--
-- status:
--   db_only  - the proof is stored and the station is waiting for a batch. Nothing else moves a
--              row out of db_only: there is no "submitted" state, so an export never changes a row.
--   on_chain - the chain registry shows this station active, real and registered to this owner
--              (set by the chain station sync only). A row can be on_chain with no stored proof:
--              a station registered on chain before this table existed.
--   blocked  - the chain registry shows this station id under a different owner, or not active
--              or not real (set by the chain station sync only; blocked_reason says which). A
--              blocked row is never exported, so one bad row cannot hold up a batch.
--
-- No coordinates are stored here. The export reads them from weather_stations and writes only the
-- 0.1 degree grid point.
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before
-- setting WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED=true. Rerunnable (IF NOT EXISTS).
-- It depends only on weather_stations (baseline), not on any other recent migration, so it
-- applies the same whether or not 0044 has been applied.
--
-- Down (reversible): DROP TABLE website_station_chain_registrations;
CREATE TABLE IF NOT EXISTS "website_station_chain_registrations" (
  "station_id"          text PRIMARY KEY CHECK (length("station_id") BETWEEN 1 AND 64),
  "owner_address"       text NOT NULL CHECK ("owner_address" ~ '^0x[0-9a-f]{40}$'),
  "owner_pubkey"        text CHECK ("owner_pubkey" ~ '^[0-9a-f]{64}$'),
  "ownership_signature" text CHECK ("ownership_signature" ~ '^[0-9a-f]{128}$'),
  "status"              text NOT NULL DEFAULT 'db_only',
  "blocked_reason"      text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "website_station_chain_registrations_status_check"
    CHECK ("status" IN ('db_only', 'on_chain', 'blocked')),
  -- A waiting row always carries the proof the batch needs.
  CONSTRAINT "website_station_chain_registrations_proof_check"
    CHECK ("status" <> 'db_only' OR ("owner_pubkey" IS NOT NULL AND "ownership_signature" IS NOT NULL)),
  CONSTRAINT "website_station_chain_registrations_blocked_check"
    CHECK (("status" = 'blocked') = ("blocked_reason" IS NOT NULL)),
  CONSTRAINT "website_station_chain_registrations_blocked_reason_check"
    CHECK ("blocked_reason" IS NULL OR "blocked_reason" IN ('station_id_taken_on_chain', 'chain_record_not_active')),
  CONSTRAINT "website_station_chain_registrations_station_fk"
    FOREIGN KEY ("station_id") REFERENCES "weather_stations"("station_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "website_station_chain_registrations_status_idx"
  ON "website_station_chain_registrations" ("status", "created_at");
