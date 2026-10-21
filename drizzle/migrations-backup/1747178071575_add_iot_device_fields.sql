-- Migration: add_iot_device_fields
-- Created at: 2025-05-13T23:14:31.576Z
-- Description: Adds IoT device specific fields to environmental_submissions table to support environmental data from IoT weather stations and sensors
-- Author: Wrfcoin Core Team

-- Up Migration
-- This section contains the SQL to apply the migration

-- Add IoT device specific fields to the environmental_submissions table
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS device_type VARCHAR(50);
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS sensor_accuracy DOUBLE PRECISION;
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS calibration_date TIMESTAMP;
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS maintenance_status VARCHAR(20);
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(50);
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS battery_level INTEGER;
ALTER TABLE environmental_submissions ADD COLUMN IF NOT EXISTS signal_strength INTEGER;

-- Add index for device lookups
CREATE INDEX IF NOT EXISTS idx_environmental_submissions_device_id ON environmental_submissions(device_id);

-- Down Migration
-- This section contains the SQL to rollback the migration

-- Remove IoT device specific fields from the environmental_submissions table
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS device_type;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS device_id;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS sensor_accuracy;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS calibration_date;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS maintenance_status;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS firmware_version;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS battery_level;
ALTER TABLE environmental_submissions DROP COLUMN IF EXISTS signal_strength;

-- Remove the device_id index
DROP INDEX IF EXISTS idx_environmental_submissions_device_id;
