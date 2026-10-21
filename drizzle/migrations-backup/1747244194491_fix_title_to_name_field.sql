-- Migration: fix_title_to_name_field
-- Created at: 2025-05-14T17:36:34.491Z
-- Description: Consolidates multiple migrations to properly update field names
-- Author: Wrfcoin Core Team

-- Up Migration
-- This section contains the SQL to apply the migration

-- Make sure the name field exists in the computational_tasks table
ALTER TABLE computational_tasks ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- Copy data from title to name if name is null
UPDATE computational_tasks 
SET name = title 
WHERE name IS NULL AND title IS NOT NULL;

-- Make sure the accuracy field exists in computational_nfts table
ALTER TABLE computational_nfts ADD COLUMN IF NOT EXISTS accuracy NUMERIC(5,2);

-- Set a default value for accuracy where it's NULL
UPDATE computational_nfts
SET accuracy = 0.9
WHERE accuracy IS NULL;

-- Down Migration
-- This section contains the SQL to rollback the migration

-- If we need to revert, we can restore data from name back to title
-- UPDATE computational_tasks 
-- SET title = name 
-- WHERE title IS NULL AND name IS NOT NULL;

-- For safety we don't revert the accuracy data, as it was computed
