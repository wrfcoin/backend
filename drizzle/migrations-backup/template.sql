-- Wrfcoin Migration Template
-- Replace with your migration's description
-- Format: YYYY_MM_DD_descriptive_name.sql

-- Add table columns
ALTER TABLE "table_name" ADD COLUMN IF NOT EXISTS "new_column" TYPE;

-- Modify columns
ALTER TABLE "table_name" ALTER COLUMN "column_name" TYPE new_type;
ALTER TABLE "table_name" ALTER COLUMN "column_name" SET DEFAULT new_default;
ALTER TABLE "table_name" ALTER COLUMN "column_name" DROP DEFAULT;
ALTER TABLE "table_name" ALTER COLUMN "column_name" SET NOT NULL;
ALTER TABLE "table_name" ALTER COLUMN "column_name" DROP NOT NULL;

-- Add constraints
ALTER TABLE "table_name" ADD CONSTRAINT "constraint_name" CHECK (condition);
ALTER TABLE "table_name" ADD CONSTRAINT "constraint_name" UNIQUE ("column_name");
ALTER TABLE "table_name" ADD CONSTRAINT "constraint_name" FOREIGN KEY ("column_name") REFERENCES "referenced_table"("referenced_column");

-- Remove constraints
ALTER TABLE "table_name" DROP CONSTRAINT "constraint_name";

-- Create indexes
CREATE INDEX IF NOT EXISTS "index_name" ON "table_name"("column_name");
CREATE UNIQUE INDEX IF NOT EXISTS "index_name" ON "table_name"("column_name");

-- Drop indexes
DROP INDEX IF EXISTS "index_name";

-- Create new tables
CREATE TABLE IF NOT EXISTS "new_table" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Data migrations (if needed)
UPDATE "table_name" SET "column_name" = 'new_value' WHERE "condition";