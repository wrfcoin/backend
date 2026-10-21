-- Migration: fix_accuracy_field
-- Created at: 2025-05-13T22:31:32.964Z

-- Up Migration
-- Change accuracy field type from integer to decimal
ALTER TABLE "computational_nfts" ALTER COLUMN "accuracy" TYPE DECIMAL(10, 2);

-- Down Migration (if needed)
-- Change accuracy field type back to integer
-- ALTER TABLE "computational_nfts" ALTER COLUMN "accuracy" TYPE INTEGER;
