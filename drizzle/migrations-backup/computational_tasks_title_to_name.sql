-- Rename title column to name in computational_tasks table
-- Migration: computational_tasks_title_to_name

-- UP Migration
ALTER TABLE computational_tasks RENAME COLUMN title TO name;

-- DOWN Migration
-- ALTER TABLE computational_tasks RENAME COLUMN name TO title;