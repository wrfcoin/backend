-- Migration: fix_title_to_name_field
-- Created at: 2025-05-16T21:29:40.089Z
-- Description: 
-- Author: Wrfcoin Core Team

-- Up Migration
-- This section contains the SQL to apply the migration

-- Example: Add a new table
-- CREATE TABLE IF NOT EXISTS new_table (
--   id SERIAL PRIMARY KEY,
--   name VARCHAR(100) NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- Example: Add a column to existing table
-- ALTER TABLE existing_table ADD COLUMN IF NOT EXISTS new_column VARCHAR(50);

-- Example: Create an index
-- CREATE INDEX IF NOT EXISTS idx_table_column ON table_name(column_name);

-- Example: Update data
-- UPDATE table_name SET column_name = 'new_value' WHERE condition;

-- Down Migration
-- This section contains the SQL to rollback the migration

-- Example: Drop a table
-- DROP TABLE IF EXISTS new_table;

-- Example: Remove a column
-- ALTER TABLE existing_table DROP COLUMN IF EXISTS new_column;

-- Example: Remove an index
-- DROP INDEX IF EXISTS idx_table_column;

-- Example: Revert data changes
-- UPDATE table_name SET column_name = 'old_value' WHERE condition;
