-- Migration: fix_iot_device_fields
-- Created at: 2025-05-13T23:34:24.155Z
-- Description: Ensures consistency in the IoT device fields and fixes mapping issues between database and application code 
-- Author: Wrfcoin Core Team

-- Up Migration
-- This section contains the SQL to apply the migration

-- Ensure null values in IoT device fields are properly initialized
UPDATE environmental_submissions 
SET 
    device_type = COALESCE(device_type, 'UNKNOWN'),
    device_id = COALESCE(device_id, ''),
    sensor_accuracy = COALESCE(sensor_accuracy, 0.75),
    battery_level = COALESCE(battery_level, 100),
    signal_strength = COALESCE(signal_strength, 5),
    firmware_version = COALESCE(firmware_version, 'unknown'),
    maintenance_status = COALESCE(maintenance_status, 'OK')
WHERE 
    device_type IS NULL OR 
    device_id IS NULL OR 
    sensor_accuracy IS NULL OR 
    battery_level IS NULL OR 
    signal_strength IS NULL OR 
    firmware_version IS NULL OR
    maintenance_status IS NULL;

-- The database has a column 'submitter' while our code is expecting 'submitter_id'
-- We'll rename the column if needed later

-- Ensure the 'submitter' column contains proper data
UPDATE environmental_submissions
SET submitter = COALESCE(submitter, '0')
WHERE submitter IS NULL;

-- Down Migration
-- This section contains the SQL to rollback the migration

-- Note: This migration makes data improvements and doesn't alter structure,
-- so for rollback we simply log that manual intervention might be needed
SELECT 'For rollback: Manual review may be required, no automated reversal implemented.';
