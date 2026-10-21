-- Rename title column to name in computational_nfts table
-- Migration: title_to_name_field

-- UP Migration
ALTER TABLE computational_nfts RENAME COLUMN title TO name;

-- DOWN Migration
-- ALTER TABLE computational_nfts RENAME COLUMN name TO title;