-- Station lifecycle columns for discovery/provisioning API (backend#266 revision)
ALTER TABLE IF EXISTS devices_consolidated
  ADD COLUMN IF NOT EXISTS decommissioned_at timestamp;

DO $$
BEGIN
  IF to_regclass('public.devices_consolidated') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_devices_consolidated_decommissioned
      ON devices_consolidated (decommissioned_at);
  END IF;
END $$;
