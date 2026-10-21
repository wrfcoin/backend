#!/usr/bin/env tsx
/**
 * Database Schema Type Consistency Validation Script
 * Phase 4C: Comprehensive validation of 21-table consolidated schema
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Import database connection and schema
import { db, type Database } from './database/db.js';
import * as schema from './shared/schema.js';
import { sql } from 'drizzle-orm';

// Color codes for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

interface ValidationResult {
  category: string;
  test: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
  details?: any;
}

class DatabaseSchemaValidator {
  private results: ValidationResult[] = [];

  constructor() {
    console.log(
      `${colors.bold}${colors.blue}WRFCoin Database Schema Type Consistency Validation${colors.reset}`
    );
    console.log(
      `${colors.cyan}Phase 4C: Validating 21-table consolidated schema${colors.reset}\n`
    );
  }

  private addResult(
    category: string,
    test: string,
    status: 'PASS' | 'FAIL' | 'WARN',
    message: string,
    details?: any
  ): void {
    this.results.push({ category, test, status, message, details });

    const statusColor =
      status === 'PASS'
        ? colors.green
        : status === 'FAIL'
          ? colors.red
          : colors.yellow;
    const statusSymbol =
      status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';

    console.log(
      `${statusSymbol} ${colors.bold}${category}${colors.reset} - ${test}: ${statusColor}${status}${colors.reset}`
    );
    console.log(`   ${message}`);
    if (details) {
      console.log(`   Details: ${JSON.stringify(details, null, 2)}`);
    }
    console.log();
  }

  async validateSchemaStructure(): Promise<void> {
    console.log(
      `${colors.bold}${colors.yellow}1. SCHEMA STRUCTURE VALIDATION${colors.reset}`
    );

    try {
      // Check if main schema exports are available
      const schemaKeys = Object.keys(schema);
      const expectedTables = [
        'users',
        'weatherData',
        'weatherStations',
        'weatherForecasts',
        'carbonCredits',
        'carbonFootprints',
        'computationalTasks',
        'computationalNfts',
        'transactions',
        'blocks',
        'nfts',
      ];

      const foundTables = expectedTables.filter(table =>
        schemaKeys.includes(table)
      );

      this.addResult(
        'Schema Structure',
        'Core Tables Export',
        foundTables.length >= 8 ? 'PASS' : 'WARN',
        `Found ${foundTables.length}/${expectedTables.length} core tables`,
        {
          found: foundTables,
          missing: expectedTables.filter(t => !foundTables.includes(t)),
        }
      );

      // Check consolidated schema imports
      const consolidatedSchemas = [
        'rewardsConsolidatedSchema',
        'iotConsolidatedSchema',
        'crosschainConsolidatedSchema',
        'governanceConsolidatedSchema',
        'usersConsolidatedSchema',
      ];

      let consolidatedFound = 0;
      consolidatedSchemas.forEach(schemaName => {
        if (schemaKeys.includes(schemaName)) {
          consolidatedFound++;
        }
      });

      this.addResult(
        'Schema Structure',
        'Consolidated Schema Exports',
        consolidatedFound >= 3 ? 'PASS' : 'WARN',
        `Found ${consolidatedFound}/${consolidatedSchemas.length} consolidated schemas`
      );
    } catch (error) {
      this.addResult(
        'Schema Structure',
        'Schema Import',
        'FAIL',
        `Failed to validate schema structure: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async validateDrizzleOrmIntegration(): Promise<void> {
    console.log(
      `${colors.bold}${colors.yellow}2. DRIZZLE ORM INTEGRATION VALIDATION${colors.reset}`
    );

    try {
      // Test database connection
      await db.execute(sql`SELECT 1 as test`);

      this.addResult(
        'Drizzle ORM',
        'Database Connection',
        'PASS',
        'Successfully connected to database'
      );

      // Test basic query functionality
      try {
        const result = await db.execute(
          sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' LIMIT 5`
        );

        this.addResult(
          'Drizzle ORM',
          'Query Execution',
          'PASS',
          `Successfully executed query, found ${result.rows.length} tables`
        );
      } catch (queryError) {
        this.addResult(
          'Drizzle ORM',
          'Query Execution',
          'WARN',
          `Query execution had issues: ${queryError instanceof Error ? queryError.message : String(queryError)}`
        );
      }
    } catch (error) {
      this.addResult(
        'Drizzle ORM',
        'Database Connection',
        'FAIL',
        `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async validateMigrationConsistency(): Promise<void> {
    console.log(
      `${colors.bold}${colors.yellow}3. MIGRATION CONSISTENCY VALIDATION${colors.reset}`
    );

    try {
      // Check for migration files
      const migrationDir = join(process.cwd(), 'drizzle', 'migrations');
      const migrationExists = existsSync(migrationDir);

      this.addResult(
        'Migrations',
        'Migration Directory',
        migrationExists ? 'PASS' : 'WARN',
        migrationExists
          ? 'Migration directory exists'
          : 'Migration directory not found'
      );

      if (migrationExists) {
        const fs = await import('fs/promises');
        const migrationFiles = await fs.readdir(migrationDir);
        const sqlFiles = migrationFiles.filter(f => f.endsWith('.sql'));

        this.addResult(
          'Migrations',
          'Migration Files',
          sqlFiles.length > 0 ? 'PASS' : 'WARN',
          `Found ${sqlFiles.length} migration file(s)`,
          { files: sqlFiles }
        );

        // Check for Task 67 consolidated migration
        const task67Migration = sqlFiles.find(
          f => f.includes('task67') || f.includes('consolidated')
        );
        this.addResult(
          'Migrations',
          'Task 67 Consolidated Migration',
          task67Migration ? 'PASS' : 'WARN',
          task67Migration
            ? `Found: ${task67Migration}`
            : 'Task 67 consolidated migration not found'
        );
      }
    } catch (error) {
      this.addResult(
        'Migrations',
        'Migration Validation',
        'FAIL',
        `Failed to validate migrations: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async validateTypeInference(): Promise<void> {
    console.log(
      `${colors.bold}${colors.yellow}4. TYPE INFERENCE VALIDATION${colors.reset}`
    );

    try {
      // Test type inference for key tables
      const tableTests = [
        { name: 'users', table: schema.users },
        { name: 'weatherData', table: schema.weatherData },
        { name: 'weatherStations', table: schema.weatherStations },
      ];

      for (const { name, table } of tableTests) {
        if (table) {
          // Check if table has proper TypeScript typing
          const hasInferSelect = '$inferSelect' in table;
          const hasInferInsert = '$inferInsert' in table;

          this.addResult(
            'Type Inference',
            `${name} Types`,
            hasInferSelect && hasInferInsert ? 'PASS' : 'WARN',
            `Select type: ${hasInferSelect ? 'Available' : 'Missing'}, Insert type: ${hasInferInsert ? 'Available' : 'Missing'}`
          );
        } else {
          this.addResult(
            'Type Inference',
            `${name} Types`,
            'WARN',
            `Table ${name} not found in schema exports`
          );
        }
      }
    } catch (error) {
      this.addResult(
        'Type Inference',
        'Type Validation',
        'FAIL',
        `Failed to validate type inference: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async validateServiceIntegration(): Promise<void> {
    console.log(
      `${colors.bold}${colors.yellow}5. SERVICE INTEGRATION VALIDATION${colors.reset}`
    );

    try {
      // Check if GraphQL resolvers exist and import schema correctly
      const resolverPaths = [
        'graphql/resolvers/weather-resolvers.ts',
        'graphql/resolvers/user-resolvers.ts',
        'server/services/weather-data-service.ts',
      ];

      for (const resolverPath of resolverPaths) {
        const fullPath = join(process.cwd(), resolverPath);
        const exists = existsSync(fullPath);

        if (exists) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const hasSchemaImport =
              content.includes('shared/schema') ||
              content.includes('../shared/schema');
            const hasDrizzleImport = content.includes('drizzle-orm');

            this.addResult(
              'Service Integration',
              `${resolverPath.split('/').pop()}`,
              hasSchemaImport && hasDrizzleImport ? 'PASS' : 'WARN',
              `Schema import: ${hasSchemaImport ? 'Yes' : 'No'}, Drizzle import: ${hasDrizzleImport ? 'Yes' : 'No'}`
            );
          } catch (readError) {
            this.addResult(
              'Service Integration',
              `${resolverPath.split('/').pop()}`,
              'WARN',
              `Could not read file: ${readError instanceof Error ? readError.message : String(readError)}`
            );
          }
        } else {
          this.addResult(
            'Service Integration',
            `${resolverPath.split('/').pop()}`,
            'WARN',
            'File not found'
          );
        }
      }
    } catch (error) {
      this.addResult(
        'Service Integration',
        'Integration Validation',
        'FAIL',
        `Failed to validate service integration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  generateReport(): void {
    console.log(
      `${colors.bold}${colors.blue}VALIDATION SUMMARY REPORT${colors.reset}`
    );
    console.log('='.repeat(50));

    const categories = [...new Set(this.results.map(r => r.category))];
    const totalTests = this.results.length;
    const passCount = this.results.filter(r => r.status === 'PASS').length;
    const warnCount = this.results.filter(r => r.status === 'WARN').length;
    const failCount = this.results.filter(r => r.status === 'FAIL').length;

    console.log(`Total Tests: ${totalTests}`);
    console.log(
      `${colors.green}Passed: ${passCount} (${Math.round((passCount / totalTests) * 100)}%)${colors.reset}`
    );
    console.log(
      `${colors.yellow}Warnings: ${warnCount} (${Math.round((warnCount / totalTests) * 100)}%)${colors.reset}`
    );
    console.log(
      `${colors.red}Failed: ${failCount} (${Math.round((failCount / totalTests) * 100)}%)${colors.reset}`
    );
    console.log();

    categories.forEach(category => {
      const categoryResults = this.results.filter(r => r.category === category);
      const categoryPass = categoryResults.filter(
        r => r.status === 'PASS'
      ).length;
      const categoryTotal = categoryResults.length;

      console.log(
        `${colors.bold}${category}${colors.reset}: ${categoryPass}/${categoryTotal} passed`
      );
    });

    console.log();

    // Overall assessment
    const overallScore = Math.round(
      ((passCount + warnCount * 0.5) / totalTests) * 100
    );
    let assessmentColor = colors.red;
    let assessment = 'NEEDS ATTENTION';

    if (overallScore >= 90) {
      assessmentColor = colors.green;
      assessment = 'EXCELLENT';
    } else if (overallScore >= 80) {
      assessmentColor = colors.cyan;
      assessment = 'GOOD';
    } else if (overallScore >= 70) {
      assessmentColor = colors.yellow;
      assessment = 'ACCEPTABLE';
    }

    console.log(
      `${colors.bold}Overall Database Schema Type Consistency: ${assessmentColor}${overallScore}% - ${assessment}${colors.reset}`
    );

    if (failCount > 0) {
      console.log(
        `\n${colors.red}${colors.bold}Critical Issues Found:${colors.reset}`
      );
      this.results
        .filter(r => r.status === 'FAIL')
        .forEach(result => {
          console.log(
            `• ${result.category} - ${result.test}: ${result.message}`
          );
        });
    }

    if (warnCount > 0) {
      console.log(
        `\n${colors.yellow}${colors.bold}Warnings (Recommended Improvements):${colors.reset}`
      );
      this.results
        .filter(r => r.status === 'WARN')
        .forEach(result => {
          console.log(
            `• ${result.category} - ${result.test}: ${result.message}`
          );
        });
    }
  }

  async runAllValidations(): Promise<void> {
    try {
      await this.validateSchemaStructure();
      await this.validateDrizzleOrmIntegration();
      await this.validateMigrationConsistency();
      await this.validateTypeInference();
      await this.validateServiceIntegration();

      this.generateReport();
    } catch (error) {
      console.error(
        `${colors.red}Fatal error during validation:${colors.reset}`,
        error
      );
      process.exit(1);
    }
  }
}

// Run validation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const validator = new DatabaseSchemaValidator();
  validator
    .runAllValidations()
    .then(() => {
      console.log(
        `\n${colors.green}${colors.bold}Database Schema Type Consistency Validation Complete!${colors.reset}`
      );
      process.exit(0);
    })
    .catch(error => {
      console.error(`${colors.red}Validation failed:${colors.reset}`, error);
      process.exit(1);
    });
}

export { DatabaseSchemaValidator };
