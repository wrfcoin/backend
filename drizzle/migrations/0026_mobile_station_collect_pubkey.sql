-- Per-phone collect key (backend#1288, story B6; design addendum §11).
-- Design: docs/plans/2026-09-29-per-phone-station-registration-design.md
--
-- collect_pubkey
--   The phone's second ed25519 key (32 bytes, lowercase hex). It signs commit
--   authorizations in background runs and has no spending power; the wallet key
--   authorises it once, in preimage A v2, at registration. oracle-submit-routes
--   requires the commit `auth_pubkey` to equal this value for `mob-` stations.
--   Backend-only: it is never exported to core4. It must differ from the wallet
--   key (owner_pubkey). Re-registration with a new key replaces it (rotation).
--
-- NOT NULL with no default: every row must carry a wallet-authorised collect key.
-- Initial r15 deployment applies 0025 + 0026 together, BEFORE accepting mobile
-- registrations: mobile_station_registrations must be EMPTY when this column
-- is first added. This is a deployment prerequisite, not a general backfill.
-- On a database that DOES hold v1 rows the ALTER fails loudly instead of
-- inventing a wallet-authorised key; re-register those rows before retrying.
-- Column/constraint guards allow reruns after success or partial DDL application.
--
-- Rollback (drizzle has no down migrations; run by hand if ever needed):
--   ALTER TABLE "mobile_station_registrations" DROP COLUMN IF EXISTS "collect_pubkey";

ALTER TABLE "mobile_station_registrations"
  ADD COLUMN IF NOT EXISTS "collect_pubkey" text NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"mobile_station_registrations"'::regclass
      AND conname = 'mobile_station_registrations_collect_pubkey_shape_check'
  ) THEN
    ALTER TABLE "mobile_station_registrations"
      ADD CONSTRAINT "mobile_station_registrations_collect_pubkey_shape_check"
        CHECK ("collect_pubkey" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"mobile_station_registrations"'::regclass
      AND conname = 'mobile_station_registrations_collect_not_owner_check'
  ) THEN
    ALTER TABLE "mobile_station_registrations"
      ADD CONSTRAINT "mobile_station_registrations_collect_not_owner_check"
        CHECK ("collect_pubkey" <> lower("owner_pubkey"));
  END IF;
END $$;
