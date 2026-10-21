-- Migration: computation_to_task_type
-- Description: Fix the inconsistency in field naming by ensuring task_type is used consistently
-- This migration ensures the computational_tasks table uses 'task_type' instead of 'computation_type'

-- Check if computation_type exists but task_type doesn't exist
DO $$
BEGIN
    -- Only try to rename the column if computation_type exists but task_type doesn't
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'computational_tasks'
        AND column_name = 'computation_type'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'computational_tasks'
        AND column_name = 'task_type'
    ) THEN
        -- Rename the column from computation_type to task_type
        ALTER TABLE computational_tasks RENAME COLUMN computation_type TO task_type;
        RAISE NOTICE 'Column renamed from computation_type to task_type';
    ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'computational_tasks'
        AND column_name = 'computation_type'
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'computational_tasks'
        AND column_name = 'task_type'
    ) THEN
        -- If both columns exist, migrate the data and drop computation_type
        UPDATE computational_tasks
        SET task_type = computation_type
        WHERE task_type IS NULL AND computation_type IS NOT NULL;
        
        ALTER TABLE computational_tasks DROP COLUMN computation_type;
        RAISE NOTICE 'Migrated data from computation_type to task_type and dropped computation_type column';
    ELSIF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'computational_tasks'
        AND column_name = 'task_type'
    ) THEN
        -- If task_type doesn't exist yet, add it
        ALTER TABLE computational_tasks ADD COLUMN task_type TEXT;
        RAISE NOTICE 'Added task_type column to computational_tasks';
    ELSE
        RAISE NOTICE 'No column changes needed - task_type already exists and computation_type does not';
    END IF;
END $$;