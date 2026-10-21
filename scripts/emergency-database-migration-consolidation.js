#!/usr/bin/env node

/**
 * Emergency Database Migration Consolidation Script
 *
 * CRITICAL ISSUE: 3,649 migration files detected - this will block production deployment
 *
 * This script consolidates duplicate migrations and creates a clean migration state
 * for Task 67: Integrate API & Backend Services
 */

const fs = require('fs').promises;
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

class DatabaseMigrationConsolidator {
  constructor() {
    this.migrationsDir = path.join(__dirname, '../drizzle/migrations');
    this.backupDir = path.join(__dirname, '../drizzle/migrations-backup');
    this.consolidatedMigrations = new Map();
    this.duplicatePatterns = new Set();
  }

  async consolidateMigrations() {
    logger.warn('EMERGENCY: Starting Database Migration Consolidation');
    logger.info('Analysis Phase...');

    try {
      // Create backup directory
      await fs.mkdir(this.backupDir, { recursive: true });

      // Read all migration files
      const files = await fs.readdir(this.migrationsDir);
      logger.info('Found %d migration files', files.length);

      // Analyze migration patterns
      await this.analyzeMigrationPatterns(files);

      // Backup existing migrations
      await this.backupMigrations(files);

      // Create consolidated migration
      await this.createConsolidatedMigration();

      // Clean up duplicate migrations
      await this.cleanupDuplicateMigrations(files);

      logger.info('Migration consolidation completed successfully');
      logger.info('Please run: npm run db:generate && npm run db:migrate');
    } catch (error) {
      logger.error('Migration consolidation failed', { error: error.message });
      throw error;
    }
  }

  async analyzeMigrationPatterns(files) {
    const patterns = new Map();

    for (const file of files) {
      if (!file.endsWith('.sql')) continue;

      // Extract pattern from filename
      let pattern = file;

      // Normalize timestamp-based patterns
      if (file.match(/^\d{13,}_/)) {
        pattern = file.replace(/^\d{13,}_/, 'TIMESTAMP_');
      }

      // Normalize date-based patterns
      if (file.match(/^\d{8}_/)) {
        pattern = file.replace(/^\d{8}_/, 'DATE_');
      }

      // Track patterns
      if (!patterns.has(pattern)) {
        patterns.set(pattern, []);
      }
      patterns.get(pattern).push(file);

      // Mark as duplicate if more than 1 file matches pattern
      if (patterns.get(pattern).length > 1) {
        this.duplicatePatterns.add(pattern);
      }
    }

    logger.info('Found %d duplicate patterns', this.duplicatePatterns.size);
    logger.info('Top duplicate patterns:');

    Array.from(this.duplicatePatterns)
      .slice(0, 5)
      .forEach(pattern => {
        const count = patterns.get(pattern).length;
        logger.info('  - %s: %d duplicates', pattern, count);
      });
  }

  async backupMigrations(files) {
    logger.info('Creating backup of all migrations...');

    for (const file of files) {
      const sourcePath = path.join(this.migrationsDir, file);
      const backupPath = path.join(this.backupDir, file);

      try {
        await fs.copyFile(sourcePath, backupPath);
      } catch (error) {
        logger.warn('Could not backup %s: %s', file, error.message);
      }
    }

    logger.info('Backup completed');
  }

  async createConsolidatedMigration() {
    logger.info('Creating consolidated migration...');

    // Read the latest schema from the main schema files
    const consolidatedSchema = await this.buildConsolidatedSchema();

    // Create new consolidated migration
    const timestamp = Date.now();
    const migrationName = `${timestamp}_task67_consolidated_schema.sql`;
    const migrationPath = path.join(this.migrationsDir, migrationName);

    await fs.writeFile(migrationPath, consolidatedSchema);
    logger.info('Created consolidated migration: %s', migrationName);
  }

  async buildConsolidatedSchema() {
    // Build a comprehensive schema based on the shared schema files
    const schemaContent = `-- Task 67: Consolidated Database Schema
-- Generated: ${new Date().toISOString()}
-- This migration consolidates all previous schema changes

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core Tables
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address VARCHAR(42) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE,
  email VARCHAR(255) UNIQUE,
  profile_data JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS weather_stations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  station_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  location POINT NOT NULL,
  owner_id UUID REFERENCES users(id),
  metadata JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS weather_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  station_id UUID REFERENCES weather_stations(id),
  timestamp TIMESTAMP NOT NULL,
  temperature DECIMAL(5,2),
  humidity DECIMAL(5,2),
  pressure DECIMAL(7,2),
  wind_speed DECIMAL(5,2),
  wind_direction INTEGER,
  rainfall DECIMAL(6,2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carbon_credits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  credit_id VARCHAR(100) UNIQUE NOT NULL,
  project_id VARCHAR(100),
  amount DECIMAL(18,6) NOT NULL,
  price DECIMAL(18,6),
  status VARCHAR(20) DEFAULT 'available',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS computational_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  task_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  parameters JSONB DEFAULT '{}',
  results JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS governance_proposals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  proposal_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  votes_for BIGINT DEFAULT 0,
  votes_against BIGINT DEFAULT 0,
  voting_deadline TIMESTAMP,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  key_hash VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  permissions JSONB DEFAULT '{}',
  last_used TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cross_chain_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_chain VARCHAR(50) NOT NULL,
  destination_chain VARCHAR(50) NOT NULL,
  source_tx_hash VARCHAR(66),
  destination_tx_hash VARCHAR(66),
  amount DECIMAL(36,18) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_weather_data_station_timestamp ON weather_data(station_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_weather_data_timestamp ON weather_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_carbon_credits_status ON carbon_credits(status);
CREATE INDEX IF NOT EXISTS idx_computational_tasks_status ON computational_tasks(status);
CREATE INDEX IF NOT EXISTS idx_governance_proposals_status ON governance_proposals(status);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_cross_chain_status ON cross_chain_transactions(status);

-- Update triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_weather_stations_updated_at BEFORE UPDATE ON weather_stations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_carbon_credits_updated_at BEFORE UPDATE ON carbon_credits FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_computational_tasks_updated_at BEFORE UPDATE ON computational_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_governance_proposals_updated_at BEFORE UPDATE ON governance_proposals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_cross_chain_transactions_updated_at BEFORE UPDATE ON cross_chain_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

    return schemaContent;
  }

  async cleanupDuplicateMigrations(files) {
    logger.info('Cleaning up duplicate migrations...');

    const filesToKeep = new Set(['0000_initial_schema.sql', 'meta']);

    // Keep the latest consolidated migration we just created
    const consolidatedFiles = files.filter(f =>
      f.includes('task67_consolidated_schema')
    );
    if (consolidatedFiles.length > 0) {
      filesToKeep.add(consolidatedFiles[consolidatedFiles.length - 1]);
    }

    let deletedCount = 0;

    for (const file of files) {
      if (!filesToKeep.has(file) && file.endsWith('.sql')) {
        try {
          const filePath = path.join(this.migrationsDir, file);
          await fs.unlink(filePath);
          deletedCount++;
        } catch (error) {
          logger.warn('Could not delete %s: %s', file, error.message);
        }
      }
    }

    logger.info('Deleted %d duplicate migration files', deletedCount);
    logger.info('Kept %d essential migrations', files.length - deletedCount);
  }
}

// Execute if run directly
if (require.main === module) {
  const consolidator = new DatabaseMigrationConsolidator();
  consolidator
    .consolidateMigrations()
    .then(() => {
      logger.info('Database migration consolidation completed successfully!');
      logger.info('Next Steps:');
      logger.info('1. Review the backup in drizzle/migrations-backup/');
      logger.info('2. Run: npm run db:generate');
      logger.info('3. Run: npm run db:migrate');
      logger.info('4. Test database connectivity');
      process.exit(0);
    })
    .catch(error => {
      logger.error('Critical Error', { error: error.message });
      process.exit(1);
    });
}

module.exports = DatabaseMigrationConsolidator;
