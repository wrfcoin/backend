-- Add ed25519 public key column to devices_consolidated for IoT device auth persistence.
-- The unique partial index prevents re-registration of the same public key on a different device.
ALTER TABLE IF EXISTS devices_consolidated
  ADD COLUMN IF NOT EXISTS public_key_hex varchar(128);

DO $$
BEGIN
  IF to_regclass('public.devices_consolidated') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_consolidated_pubkey
      ON devices_consolidated (public_key_hex) WHERE public_key_hex IS NOT NULL;
  END IF;
END $$;
