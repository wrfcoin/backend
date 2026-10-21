ALTER TABLE IF EXISTS meshtastic_nodes
  ADD COLUMN IF NOT EXISTS geo_fence_grid varchar(16),
  ADD COLUMN IF NOT EXISTS geo_fence_status varchar(32) NOT NULL DEFAULT 'clear',
  ADD COLUMN IF NOT EXISTS geo_fence_reason text,
  ADD COLUMN IF NOT EXISTS geo_fence_burst_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS geo_fence_window_started_at timestamp,
  ADD COLUMN IF NOT EXISTS geo_fence_triggered_at timestamp,
  ADD COLUMN IF NOT EXISTS geo_fence_reviewed_at timestamp,
  ADD COLUMN IF NOT EXISTS geo_fence_reviewed_by varchar(128);

DO $$
BEGIN
  IF to_regclass('public.meshtastic_nodes') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS meshtastic_nodes_geo_fence_grid_idx
      ON meshtastic_nodes (geo_fence_grid);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.meshtastic_nodes') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS meshtastic_nodes_geo_fence_status_idx
      ON meshtastic_nodes (geo_fence_status);
  END IF;
END $$;

ALTER TABLE IF EXISTS iotex_devices
  ADD COLUMN IF NOT EXISTS geo_fence_grid varchar(16),
  ADD COLUMN IF NOT EXISTS geo_fence_status varchar(32) NOT NULL DEFAULT 'clear',
  ADD COLUMN IF NOT EXISTS geo_fence_reason text,
  ADD COLUMN IF NOT EXISTS geo_fence_burst_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS geo_fence_window_started_at timestamp,
  ADD COLUMN IF NOT EXISTS geo_fence_triggered_at timestamp,
  ADD COLUMN IF NOT EXISTS geo_fence_reviewed_at timestamp,
  ADD COLUMN IF NOT EXISTS geo_fence_reviewed_by varchar(128);

DO $$
BEGIN
  IF to_regclass('public.iotex_devices') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS iotex_devices_geo_fence_grid_idx
      ON iotex_devices (geo_fence_grid);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.iotex_devices') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS iotex_devices_geo_fence_status_idx
      ON iotex_devices (geo_fence_status);
  END IF;
END $$;
