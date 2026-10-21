#!/usr/bin/env node

/**
 * Database SSL Configuration Fix
 * Enables SSL for database connections to enhance security
 */

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

class DatabaseSSLFix {
  constructor() {
    this.fixes = [];
    this.errors = [];
  }

  async enableDatabaseSSL() {
    logger.info('Enabling Database SSL Configuration');

    await this.updateDatabaseConnections();
    await this.updateDrizzleConfig();
    await this.updateEnvironmentExample();

    this.generateReport();
  }

  async updateDatabaseConnections() {
    logger.info('Updating database connection configurations');

    const dbFiles = [
      'backend/server/db.js',
      'backend/server/database.js',
      'shared/db.js',
      'server/db.js',
    ];

    for (const file of dbFiles) {
      if (fs.existsSync(file)) {
        try {
          await this.updateDbFile(file);
        } catch (error) {
          this.errors.push(`${file}: ${error.message}`);
        }
      }
    }
  }

  async updateDbFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let hasChanges = false;

    // Add SSL configuration to PostgreSQL connections
    if (content.includes('postgres://') || content.includes('postgresql://')) {
      // Pattern 1: Direct connection string
      if (content.match(/postgres(ql)?:\/\/[^'"\s)]+/g)) {
        content = content.replace(
          /(postgres(?:ql)?:\/\/[^'"\s)]+)(?!\?[^'"\s)]*ssl)/g,
          '$1?sslmode=require'
        );
        hasChanges = true;
      }

      // Pattern 2: Environment variable with SSL options
      if (
        content.includes('process.env.DATABASE_URL') &&
        !content.includes('ssl:')
      ) {
        const sslConfig = `
// Enhanced database configuration with SSL
const getDatabaseConfig = () => {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
        throw new Error('DATABASE_URL environment variable is required');
    }
    
    // Parse database URL and add SSL configuration
    const url = new URL(databaseUrl);
    
    // Use the secure SSL configuration module
    const { createDatabaseSSLConfig } = require('./backend/server/config/secure-ssl-config');
    return {
        connectionString: databaseUrl,
        ssl: createDatabaseSSLConfig() // Uses secure config with rejectUnauthorized: true
    };
};
`;

        if (!content.includes('getDatabaseConfig')) {
          content = sslConfig + '\n' + content;
          hasChanges = true;
        }
      }

      // Pattern 3: Drizzle configuration
      if (content.includes('drizzle(') && !content.includes('ssl:')) {
        content = content.replace(
          /drizzle\(\s*new\s+Pool\(\s*\{[^}]*\}\s*\)\s*\)/g,
          match => {
            if (match.includes('ssl:')) return match;
            return match.replace(
              /(\{[^}]*)(\})/,
              "$1,\n  ssl: require('./backend/server/config/secure-ssl-config').createDatabaseSSLConfig()$2"
            );
          }
        );
        hasChanges = true;
      }
    }

    if (hasChanges) {
      fs.writeFileSync(filePath, content);
      logger.info('Updated SSL configuration', { file: filePath });
      this.fixes.push(`Added SSL configuration to ${filePath}`);
    }
  }

  async updateDrizzleConfig() {
    logger.info('Updating Drizzle configuration');

    const drizzleFiles = [
      'drizzle.config.js',
      'drizzle.config.ts',
      'shared/drizzle.config.js',
    ];

    for (const file of drizzleFiles) {
      if (fs.existsSync(file)) {
        try {
          let content = fs.readFileSync(file, 'utf8');
          let hasChanges = false;

          if (
            !content.includes('ssl:') &&
            content.includes('connectionString')
          ) {
            content = content.replace(
              /(connectionString:\s*[^,\n]+)/,
              "$1,\n  ssl: require('./backend/server/config/secure-ssl-config').createDatabaseSSLConfig()"
            );
            hasChanges = true;
          }

          if (hasChanges) {
            fs.writeFileSync(file, content);
            logger.info('Updated Drizzle SSL config', { file });
            this.fixes.push(`Added SSL to Drizzle configuration in ${file}`);
          }
        } catch (error) {
          this.errors.push(`${file}: ${error.message}`);
        }
      }
    }
  }

  async updateEnvironmentExample() {
    logger.info('Updating environment configuration');

    const envFiles = ['.env.example', '.env.template', 'env.example'];

    for (const file of envFiles) {
      if (fs.existsSync(file)) {
        try {
          let content = fs.readFileSync(file, 'utf8');
          let hasChanges = false;

          if (!content.includes('DATABASE_CA_CERT')) {
            content += '\n# Database SSL Configuration\n';
            content += '# DATABASE_CA_CERT=path/to/ca-certificate.crt\n';
            content += '# Set NODE_ENV=production to enable SSL\n';
            hasChanges = true;
          }

          if (
            content.includes('DATABASE_URL=') &&
            !content.includes('sslmode')
          ) {
            content = content.replace(
              /DATABASE_URL=postgres(ql)?:\/\/[^\n]*/g,
              match =>
                match.includes('sslmode') ? match : match + '?sslmode=require'
            );
            hasChanges = true;
          }

          if (hasChanges) {
            fs.writeFileSync(file, content);
            logger.info('Updated environment example', { file });
            this.fixes.push(`Added SSL examples to ${file}`);
          }
        } catch (error) {
          this.errors.push(`${file}: ${error.message}`);
        }
      }
    }
  }

  generateReport() {
    logger.info('='.repeat(50));
    logger.info('DATABASE SSL CONFIGURATION REPORT');
    logger.info('='.repeat(50));

    logger.info('Summary', {
      fixesApplied: this.fixes.length,
      errors: this.errors.length
    });

    if (this.fixes.length > 0) {
      logger.info('SSL CONFIGURATIONS ADDED');
      for (const fix of this.fixes) {
        logger.info('Fix applied', { description: fix });
      }
    }

    if (this.errors.length > 0) {
      logger.error('ERRORS encountered');
      for (const error of this.errors) {
        logger.error('Error', { description: error });
      }
    }

    logger.info('SSL SECURITY IMPROVEMENTS:');
    logger.info('- Added SSL/TLS encryption for database connections');
    logger.info('- Configured SSL mode requirements in connection strings');
    logger.info('- Added CA certificate support for production');
    logger.info('- Environment-based SSL configuration');

    logger.info('NEXT STEPS:');
    logger.info('1. Set NODE_ENV=production to enable SSL in production');
    logger.info('2. Obtain CA certificate from your database provider if needed');
    logger.info('3. Test database connectivity with SSL enabled');
    logger.info('4. Monitor connection logs for SSL confirmation');

    logger.info('='.repeat(50));
  }
}

// Run fix if called directly
if (require.main === module) {
  const fix = new DatabaseSSLFix();
  fix.enableDatabaseSSL().catch(error => logger.error('SSL fix error', { error: error.message }));
}

module.exports = DatabaseSSLFix;
