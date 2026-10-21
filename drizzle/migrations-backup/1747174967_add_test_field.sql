-- Migration: add_test_field
-- Created at: 2025-05-13T22:22:47.647Z

-- Up Migration: Add test_field to computational_tasks table
ALTER TABLE computational_tasks ADD COLUMN test_field TEXT;
ALTER TABLE computational_nfts ADD COLUMN version_tag TEXT DEFAULT 'v1.0';

-- Down Migration (if needed)
-- ALTER TABLE computational_tasks DROP COLUMN test_field;
-- ALTER TABLE computational_nfts DROP COLUMN version_tag;
