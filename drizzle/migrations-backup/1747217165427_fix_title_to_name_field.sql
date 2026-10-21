-- Migration: fix_title_to_name_field
-- Created at: 2025-05-14T10:06:05.427Z
-- Description: Adds 'title' column as an alias to 'name' column for backward compatibility
-- Author: Wrfcoin Core Team

-- Up Migration
-- This section contains the SQL to apply the migration

-- Check if the 'title' column exists, if not add it
-- Add the 'title' column to support old code that uses it
ALTER TABLE computational_tasks ADD COLUMN IF NOT EXISTS title VARCHAR(255);

-- Copy values from name to title to maintain existing data
UPDATE computational_tasks SET title = name WHERE title IS NULL;

-- Create function to sync name and title fields
CREATE OR REPLACE FUNCTION sync_name_title()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.name IS NOT NULL AND NEW.title IS NULL THEN
            NEW.title := NEW.name;
        ELSIF NEW.title IS NOT NULL AND NEW.name IS NULL THEN
            NEW.name := NEW.title;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.name IS DISTINCT FROM OLD.name THEN
            NEW.title := NEW.name;
        ELSIF NEW.title IS DISTINCT FROM OLD.title THEN
            NEW.name := NEW.title;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to keep name and title in sync
DROP TRIGGER IF EXISTS sync_name_title_trigger ON computational_tasks;
CREATE TRIGGER sync_name_title_trigger
BEFORE INSERT OR UPDATE ON computational_tasks
FOR EACH ROW EXECUTE PROCEDURE sync_name_title();

-- Down Migration
-- This section contains the SQL to rollback the migration

-- Remove the trigger and function
DROP TRIGGER IF EXISTS sync_name_title_trigger ON computational_tasks;
DROP FUNCTION IF EXISTS sync_name_title();

-- Remove the title column
ALTER TABLE computational_tasks DROP COLUMN IF EXISTS title;
