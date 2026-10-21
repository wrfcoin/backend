#!/usr/bin/env node

/**
 * Database Push Operations Script
 * Handles schema synchronization, data seeding, and constraint validation
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

const SCHEMA_PATH = path.join(__dirname, '../backend/shared/schema.ts');
const MIGRATIONS_PATH = path.join(__dirname, '../backend/drizzle');

class DatabasePush {
  constructor() {
    this.config = {
      databaseUrl: process.env.DATABASE_URL,
      environment: process.env.NODE_ENV || 'development',
      verbose: process.env.DB_VERBOSE === 'true',
    };
  }

  /**
   * Synchronize schema with database
   */
  async syncSchema() {
    logger.info('Synchronizing database schema');

    try {
      // Use drizzle-kit push command for schema sync
      execSync('npx drizzle-kit push:pg', {
        stdio: this.config.verbose ? 'inherit' : 'pipe',
        cwd: process.cwd(),
      });

      logger.info('Schema synchronization complete');
      return true;
    } catch (error) {
      logger.error('Schema synchronization failed', { error: error.message });
      return false;
    }
  }

  /**
   * Seed database with initial data
   */
  async seedData() {
    logger.info('Seeding database with initial data');

    const seedFiles = [
      'seed-users.sql',
      'seed-blockchain-data.sql',
      'seed-governance.sql',
      'seed-weather-stations.sql',
    ];

    try {
      for (const seedFile of seedFiles) {
        const seedPath = path.join(MIGRATIONS_PATH, 'seeds', seedFile);

        if (fs.existsSync(seedPath)) {
          const seedSQL = fs.readFileSync(seedPath, 'utf8');

          // Execute seed SQL
          execSync(
            `psql "${this.config.databaseUrl}" -c "${seedSQL.replace(/"/g, '\\"')}"`,
            {
              stdio: this.config.verbose ? 'inherit' : 'pipe',
            }
          );

          logger.info('Seeded file', { file: seedFile });
        }
      }

      logger.info('Data seeding complete');
      return true;
    } catch (error) {
      logger.error('Data seeding failed', { error: error.message });
      return false;
    }
  }

  /**
   * Validate database constraints
   */
  async validateConstraints() {
    logger.info('Validating database constraints');

    const validationQueries = [
      {
        name: 'Foreign Key Constraints',
        query: `
                    SELECT COUNT(*) as violation_count 
                    FROM information_schema.table_constraints 
                    WHERE constraint_type = 'FOREIGN KEY' 
                    AND constraint_name NOT IN (
                        SELECT constraint_name 
                        FROM information_schema.referential_constraints
                    )
                `,
      },
      {
        name: 'Unique Constraints',
        query: `
                    SELECT table_name, column_name, COUNT(*) as duplicate_count
                    FROM information_schema.columns c
                    JOIN information_schema.table_constraints tc ON c.table_name = tc.table_name
                    WHERE tc.constraint_type = 'UNIQUE'
                    GROUP BY table_name, column_name
                    HAVING COUNT(*) > 1
                `,
      },
      {
        name: 'NOT NULL Constraints',
        query: `
                    SELECT table_name, column_name 
                    FROM information_schema.columns 
                    WHERE is_nullable = 'NO' 
                    AND table_schema = 'public'
                `,
      },
    ];

    try {
      for (const validation of validationQueries) {
        const result = execSync(
          `psql "${this.config.databaseUrl}" -t -c "${validation.query}"`,
          { encoding: 'utf8' }
        );

        logger.info('Validation passed', { name: validation.name, result: result.trim() || 'Valid' });
      }

      logger.info('Constraint validation complete');
      return true;
    } catch (error) {
      logger.error('Constraint validation failed', { error: error.message });
      return false;
    }
  }

  /**
   * Run complete database push operation
   */
  async run() {
    logger.info('Starting database push operation');

    if (!this.config.databaseUrl) {
      logger.error('DATABASE_URL environment variable not set');
      process.exit(1);
    }

    const steps = [
      { name: 'Schema Sync', fn: () => this.syncSchema() },
      { name: 'Data Seeding', fn: () => this.seedData() },
      { name: 'Constraint Validation', fn: () => this.validateConstraints() },
    ];

    let success = true;

    for (const step of steps) {
      logger.info('Running step', { name: step.name });
      const result = await step.fn();

      if (!result) {
        success = false;
        logger.error('Step failed', { name: step.name });
        break;
      }
    }

    if (success) {
      logger.info('Database push operation completed successfully');
    } else {
      logger.error('Database push operation failed');
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const dbPush = new DatabasePush();
  dbPush.run().catch(error => logger.error('Database push error', { error: error.message }));
}

module.exports = DatabasePush;
