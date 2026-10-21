#!/usr/bin/env node

/**
 * Task 57 Database Migration Script
 * Creates all necessary tables for Task 57 GraphQL resolvers
 * Tables: carbonCredits, carbonFootprints, computeRewards, ammPairs, ammSwaps
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

class Task57Migration {
  constructor() {
    this.config = {
      databaseUrl: process.env.DATABASE_URL,
      environment: process.env.NODE_ENV || 'development',
      verbose: process.env.DB_VERBOSE === 'true',
    };
  }

  /**
   * Generate SQL migration for Task 57 tables
   */
  generateMigrationSQL() {
    return `
-- Task 57 Migration: Carbon Credits, Compute Rewards, and AMM Tables
-- Generated: ${new Date().toISOString()}

-- Carbon Credits Table - for user carbon credit holdings and trading
CREATE TABLE IF NOT EXISTS "carbon_credits" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "token_id" TEXT UNIQUE NOT NULL,
    "owner" TEXT NOT NULL,
    "carbon_offset" DECIMAL(18,8) NOT NULL, -- in tCO2e
    "project_type" TEXT NOT NULL, -- 'renewable_energy', 'forestry', 'weather_monitoring', etc.
    "verification_standard" TEXT NOT NULL, -- 'VCS', 'Gold Standard', 'CDM', etc.
    "issuance_date" TIMESTAMP NOT NULL,
    "expiry_date" TIMESTAMP,
    "location" JSONB, -- { country, region, coordinates }
    "is_retired" BOOLEAN DEFAULT false,
    "issuer" TEXT NOT NULL,
    "certification_hash" TEXT, -- IPFS hash or blockchain hash
    "for_sale" BOOLEAN DEFAULT false,
    "price" DECIMAL(18,8), -- in WRF tokens
    "metadata" JSONB, -- Additional project details
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Carbon Footprints Table - for user carbon footprint tracking
CREATE TABLE IF NOT EXISTS "carbon_footprints" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "total_emissions" DECIMAL(18,8) NOT NULL, -- in tCO2e
    "total_offsets" DECIMAL(18,8) DEFAULT 0,
    "net_emissions" DECIMAL(18,8) NOT NULL,
    "calculation_date" TIMESTAMP NOT NULL,
    "emission_sources" JSONB, -- Breakdown by category
    "offset_sources" JSONB, -- Breakdown by source
    "methodology" TEXT NOT NULL DEFAULT 'ipcc_2021',
    "confidence" REAL DEFAULT 0.95, -- Calculation confidence
    "metadata" JSONB, -- Additional calculation details
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Compute Rewards Table - for computational NFT reward distribution
CREATE TABLE IF NOT EXISTS "compute_rewards" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "job_id" TEXT NOT NULL, -- Links to computational job
    "compute_provider" TEXT NOT NULL,
    "reward_amount" DECIMAL(18,8) NOT NULL,
    "reward_type" TEXT NOT NULL, -- 'WRF', 'CARBON_CREDIT', 'NFT'
    "job_complexity" INTEGER NOT NULL, -- 1-10 scale
    "execution_time" INTEGER, -- in seconds
    "quality_score" REAL DEFAULT 1.0, -- 0-1 scale
    "status" TEXT DEFAULT 'pending', -- 'pending', 'distributed', 'failed'
    "distributed_at" TIMESTAMP,
    "transaction_hash" TEXT,
    "metadata" JSONB, -- Job execution details
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AMM Pairs Table - for automated market maker liquidity pairs
CREATE TABLE IF NOT EXISTS "amm_pairs" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "pair_address" TEXT UNIQUE NOT NULL,
    "token0" TEXT NOT NULL, -- First token address (usually WRF)
    "token1" TEXT NOT NULL, -- Second token address (USDC, etc.)
    "reserve0" DECIMAL(36,18) NOT NULL,
    "reserve1" DECIMAL(36,18) NOT NULL,
    "total_liquidity" DECIMAL(36,18) NOT NULL,
    "swap_fee" INTEGER DEFAULT 30, -- in basis points (30 = 0.3%)
    "volume24h" DECIMAL(36,18) DEFAULT 0,
    "volume_week" DECIMAL(36,18) DEFAULT 0,
    "fee_rewards24h" DECIMAL(36,18) DEFAULT 0,
    "price_token0" DECIMAL(36,18),
    "price_token1" DECIMAL(36,18),
    "last_update_time" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN DEFAULT true,
    "metadata" JSONB, -- Additional pair information
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AMM Swaps Table - for tracking all swap transactions
CREATE TABLE IF NOT EXISTS "amm_swaps" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user" TEXT NOT NULL,
    "pair_address" TEXT NOT NULL,
    "token_in" TEXT NOT NULL,
    "token_out" TEXT NOT NULL,
    "amount_in" DECIMAL(36,18) NOT NULL,
    "amount_out" DECIMAL(36,18) NOT NULL,
    "minimum_amount_out" DECIMAL(36,18) NOT NULL,
    "price_impact" DECIMAL(8,6), -- as percentage
    "fee" DECIMAL(36,18) NOT NULL,
    "status" TEXT DEFAULT 'completed', -- 'pending', 'completed', 'failed'
    "timestamp" TIMESTAMP NOT NULL,
    "block_number" BIGINT,
    "transaction_hash" TEXT UNIQUE,
    "gas_used" BIGINT,
    "metadata" JSONB -- Additional swap details
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS "idx_carbon_credits_owner" ON "carbon_credits"("owner");
CREATE INDEX IF NOT EXISTS "idx_carbon_credits_token_id" ON "carbon_credits"("token_id");
CREATE INDEX IF NOT EXISTS "idx_carbon_credits_for_sale" ON "carbon_credits"("for_sale");

CREATE INDEX IF NOT EXISTS "idx_carbon_footprints_user_id" ON "carbon_footprints"("user_id");
CREATE INDEX IF NOT EXISTS "idx_carbon_footprints_date" ON "carbon_footprints"("calculation_date");

CREATE INDEX IF NOT EXISTS "idx_compute_rewards_provider" ON "compute_rewards"("compute_provider");
CREATE INDEX IF NOT EXISTS "idx_compute_rewards_job_id" ON "compute_rewards"("job_id");
CREATE INDEX IF NOT EXISTS "idx_compute_rewards_status" ON "compute_rewards"("status");

CREATE INDEX IF NOT EXISTS "idx_amm_pairs_address" ON "amm_pairs"("pair_address");
CREATE INDEX IF NOT EXISTS "idx_amm_pairs_tokens" ON "amm_pairs"("token0", "token1");
CREATE INDEX IF NOT EXISTS "idx_amm_pairs_active" ON "amm_pairs"("is_active");

CREATE INDEX IF NOT EXISTS "idx_amm_swaps_user" ON "amm_swaps"("user");
CREATE INDEX IF NOT EXISTS "idx_amm_swaps_pair" ON "amm_swaps"("pair_address");
CREATE INDEX IF NOT EXISTS "idx_amm_swaps_timestamp" ON "amm_swaps"("timestamp");
CREATE INDEX IF NOT EXISTS "idx_amm_swaps_tx_hash" ON "amm_swaps"("transaction_hash");

-- Add foreign key constraints where applicable
ALTER TABLE "amm_swaps" 
ADD CONSTRAINT "fk_amm_swaps_pair" 
FOREIGN KEY ("pair_address") REFERENCES "amm_pairs"("pair_address") 
ON DELETE CASCADE;

-- Add check constraints for data validation
ALTER TABLE "carbon_credits" 
ADD CONSTRAINT "chk_carbon_offset_positive" 
CHECK ("carbon_offset" > 0);

ALTER TABLE "carbon_footprints" 
ADD CONSTRAINT "chk_total_emissions_positive" 
CHECK ("total_emissions" >= 0);

ALTER TABLE "compute_rewards" 
ADD CONSTRAINT "chk_reward_amount_positive" 
CHECK ("reward_amount" > 0);

ALTER TABLE "compute_rewards" 
ADD CONSTRAINT "chk_job_complexity_range" 
CHECK ("job_complexity" >= 1 AND "job_complexity" <= 10);

ALTER TABLE "amm_pairs" 
ADD CONSTRAINT "chk_reserves_positive" 
CHECK ("reserve0" >= 0 AND "reserve1" >= 0);

ALTER TABLE "amm_swaps" 
ADD CONSTRAINT "chk_swap_amounts_positive" 
CHECK ("amount_in" > 0 AND "amount_out" > 0);

COMMIT;
        `;
  }

  /**
   * Execute the migration
   */
  async runMigration() {
    logger.info('Starting Task 57 table migration');

    if (!this.config.databaseUrl) {
      logger.error('DATABASE_URL environment variable not set');
      process.exit(1);
    }

    try {
      const migrationSQL = this.generateMigrationSQL();

      // Write migration to file for record keeping
      const timestamp = Date.now();
      const migrationFile = path.join(
        __dirname,
        `../../drizzle/migrations/${timestamp}_task57_tables.sql`
      );
      fs.writeFileSync(migrationFile, migrationSQL);
      logger.info('Migration written to file', { path: migrationFile });

      // Execute migration
      logger.info('Executing migration');
      execSync(`psql "${this.config.databaseUrl}" -f "${migrationFile}"`, {
        stdio: this.config.verbose ? 'inherit' : 'pipe',
      });

      logger.info('Task 57 tables created successfully');

      // Verify tables exist
      await this.verifyTables();

      logger.info('Task 57 migration completed successfully');
    } catch (error) {
      logger.error('Migration failed', { error: error.message });
      process.exit(1);
    }
  }

  /**
   * Verify that all Task 57 tables were created
   */
  async verifyTables() {
    logger.info('Verifying tables');

    const requiredTables = [
      'carbon_credits',
      'carbon_footprints',
      'compute_rewards',
      'amm_pairs',
      'amm_swaps',
    ];

    try {
      for (const table of requiredTables) {
        const result = execSync(
          `psql "${this.config.databaseUrl}" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${table}');"`,
          { encoding: 'utf8' }
        );

        const exists = result.trim() === 't';
        if (exists) {
          logger.info('Table verified', { table });
        } else {
          throw new Error(`Table '${table}' was not created`);
        }
      }

      logger.info('All Task 57 tables verified successfully');
    } catch (error) {
      logger.error('Table verification failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Rollback migration (for development)
   */
  async rollback() {
    logger.warn('Rolling back Task 57 migration');

    const rollbackSQL = `
-- Rollback Task 57 Migration
DROP TABLE IF EXISTS "amm_swaps" CASCADE;
DROP TABLE IF EXISTS "amm_pairs" CASCADE;
DROP TABLE IF EXISTS "compute_rewards" CASCADE;
DROP TABLE IF EXISTS "carbon_footprints" CASCADE;
DROP TABLE IF EXISTS "carbon_credits" CASCADE;
        `;

    try {
      execSync(`psql "${this.config.databaseUrl}" -c "${rollbackSQL}"`, {
        stdio: this.config.verbose ? 'inherit' : 'pipe',
      });

      logger.info('Task 57 tables rolled back successfully');
    } catch (error) {
      logger.error('Rollback failed', { error: error.message });
      throw error;
    }
  }
}

// Command line interface
const command = process.argv[2];
const migration = new Task57Migration();

switch (command) {
  case 'migrate':
    migration.runMigration().catch(error => logger.error('Migration error', { error: error.message }));
    break;
  case 'rollback':
    migration.rollback().catch(error => logger.error('Rollback error', { error: error.message }));
    break;
  case 'verify':
    migration.verifyTables().catch(error => logger.error('Verification error', { error: error.message }));
    break;
  default:
    logger.info(`
Usage: node migrate-task57-tables.js <command>

Commands:
  migrate   - Create Task 57 tables
  rollback  - Drop Task 57 tables  
  verify    - Verify Task 57 tables exist

Environment variables:
  DATABASE_URL - PostgreSQL connection string (required)
  DB_VERBOSE   - Set to 'true' for verbose output
        `);
    break;
}

module.exports = Task57Migration;
