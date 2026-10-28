-- Isolated bridge quarantine. No foreign key or write into reward/submission tables.
-- Rollback: drizzle/rollback/0036_bridge_claims.sql (operator backup required).
CREATE TABLE bridge_claims (
  id uuid PRIMARY KEY,
  wallet text NOT NULL,
  source text NOT NULL CHECK (source IN ('ambient','weatherlink','netatmo','wu','wow','aprs')),
  device_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','suspended','revoked')),
  hardware_key text UNIQUE,
  proof_mode text NOT NULL CHECK (proof_mode IN ('account','public_field','licence_email','reference_only')),
  fixture_only boolean NOT NULL DEFAULT true CHECK (fixture_only = true),
  verified_at timestamptz,
  reason text,
  UNIQUE(source,device_id)
);
--> statement-breakpoint
CREATE TABLE bridge_challenges (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES bridge_claims(id) ON DELETE CASCADE,
  digest text NOT NULL,
  licence_digest text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE bridge_observations (
  id bigserial PRIMARY KEY,
  claim_id uuid REFERENCES bridge_claims(id),
  feed_id text NOT NULL,
  native boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  values_json jsonb NOT NULL,
  fingerprint text NOT NULL,
  held boolean NOT NULL DEFAULT true,
  UNIQUE(feed_id,observed_at,fingerprint)
);
--> statement-breakpoint
CREATE INDEX bridge_observations_window ON bridge_observations(observed_at);
--> statement-breakpoint
CREATE TABLE bridge_claim_audit (
  id bigserial PRIMARY KEY,
  claim_id uuid REFERENCES bridge_claims(id),
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE bridge_rate_windows (
  key_hash text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE bridge_vendor_credentials (
  claim_id uuid PRIMARY KEY REFERENCES bridge_claims(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL
);
--> statement-breakpoint
CREATE TABLE bridge_forwarding_preferences (
  claim_id uuid PRIMARY KEY REFERENCES bridge_claims(id) ON DELETE CASCADE,
  opted_in boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE bridge_forwarding_audit (
  id bigserial PRIMARY KEY,
  observation_id bigint NOT NULL REFERENCES bridge_observations(id),
  decision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(observation_id,decision)
);
--> statement-breakpoint
-- Share the existing Ambient advisory lock. Registration AFTER a bridge claim
-- must also see the reservation, not just bridge verification after registration.
CREATE FUNCTION bridge_guard_existing_station_mac() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mac_key text;
BEGIN
  IF NEW.is_active THEN
    mac_key := regexp_replace(lower(btrim(NEW.metadata->>'mac')),'[^0-9a-f]','','g');
    IF mac_key IS NOT NULL AND mac_key <> '' THEN
      PERFORM pg_advisory_xact_lock(1261,hashtext(mac_key));
      IF EXISTS(SELECT 1 FROM bridge_claims WHERE hardware_key='mac:'||mac_key) THEN
        RAISE EXCEPTION 'BRIDGE_DEVICE_CLAIMED' USING ERRCODE='23505';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bridge_existing_station_mac BEFORE INSERT OR UPDATE OF metadata,is_active
ON weather_stations FOR EACH ROW EXECUTE FUNCTION bridge_guard_existing_station_mac();
