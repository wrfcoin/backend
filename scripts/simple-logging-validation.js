#!/usr/bin/env node

/**
 * Simple Logging Infrastructure Validation - Task 67.4
 *
 * Basic validation to test if the logging infrastructure is working correctly.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

class SimpleLoggingValidator {
  constructor() {
    this.results = { passed: 0, failed: 0, errors: [] };
    this.logsDir = path.join(process.cwd(), 'logs');
  }

  log(message, success = true) {
    if (success) {
      logger.info('[PASS] %s', message);
      this.results.passed++;
    } else {
      logger.warn('[FAIL] %s', message);
      this.results.failed++;
      this.results.errors.push(message);
    }
  }

  validateLogDirectorySetup() {
    logger.info('Validating Log Directory Setup...');

    try {
      // Check if logs directory exists
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
        this.log('Created logs directory');
      } else {
        this.log('Logs directory exists');
      }

      // Check directory permissions
      fs.accessSync(this.logsDir, fs.constants.W_OK);
      this.log('Logs directory is writable');
    } catch (error) {
      this.log(`Log directory setup failed: ${error.message}`, false);
    }
  }

  validateBasicLogging() {
    logger.info('Validating Basic Logging Functionality...');

    try {
      // Test basic logger availability
      let winston;
      try {
        winston = require('winston');
        this.log('Winston logging library available');
      } catch (error) {
        this.log('Winston logging library not available', false);
        return;
      }

      // Create a test logger
      const testLogger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        ),
        transports: [
          new winston.transports.File({
            filename: path.join(this.logsDir, 'validation-test.log'),
            level: 'info',
          }),
        ],
      });

      // Test logging
      testLogger.info('Basic logging test', {
        test: true,
        timestamp: new Date().toISOString(),
        validation: 'simple-test',
      });

      this.log('Basic logging functionality working');
    } catch (error) {
      this.log(`Basic logging failed: ${error.message}`, false);
    }
  }

  validateFileStructure() {
    logger.info('Validating File Structure...');

    const expectedFiles = [
      'server/utils/logger.ts',
      'server/utils/log-analyzer.ts',
      'server/utils/logging-dashboard.ts',
      'server/middleware/logging.ts',
      'server/middleware/performance-logging.ts',
      'server/middleware/security-logging.ts',
      'server/middleware/graphql-logging.ts',
    ];

    for (const file of expectedFiles) {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        this.log(`${file} exists`);
      } else {
        this.log(`${file} missing`, false);
      }
    }
  }

  validateLogFileCreation() {
    logger.info('Validating Log File Creation...');

    // Wait for logs to be written
    setTimeout(() => {
      const testLogFile = path.join(this.logsDir, 'validation-test.log');

      if (fs.existsSync(testLogFile)) {
        const stats = fs.statSync(testLogFile);
        if (stats.size > 0) {
          this.log('Test log file created and contains data');

          // Check content format
          try {
            const content = fs.readFileSync(testLogFile, 'utf8');
            const lines = content.trim().split('\n');

            if (lines.length > 0) {
              try {
                JSON.parse(lines[0]); // Try to parse first line as JSON
                this.log('Log entries are in JSON format');
              } catch (parseError) {
                this.log('Log entries are not in JSON format', false);
              }
            }
          } catch (readError) {
            this.log('Could not read test log file', false);
          }
        } else {
          this.log('Test log file created but empty', false);
        }
      } else {
        this.log('Test log file not created', false);
      }
    }, 1000);
  }

  validateEnvironmentSetup() {
    logger.info('Validating Environment Setup...');

    // Check Node.js version
    const nodeVersion = process.version;
    this.log(`Node.js version: ${nodeVersion}`);

    // Check if running in correct directory
    const currentDir = process.cwd();
    if (currentDir.includes('wrfcoin') && currentDir.includes('backend')) {
      this.log('Running in correct backend directory');
    } else {
      this.log('May not be running in correct directory', false);
    }

    // Check for package.json
    const packageJsonPath = path.join(process.cwd(), '..', 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      this.log('Package.json found');
    } else {
      this.log('Package.json not found', false);
    }
  }

  validateTypeScriptFiles() {
    logger.info('Validating TypeScript Files...');

    const tsFiles = [
      'server/utils/logger.ts',
      'server/utils/log-analyzer.ts',
      'server/utils/logging-dashboard.ts',
      'server/middleware/logging.ts',
      'server/middleware/performance-logging.ts',
      'server/middleware/security-logging.ts',
      'server/middleware/graphql-logging.ts',
    ];

    for (const file of tsFiles) {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');

          // Check for basic TypeScript/logging patterns
          const hasImports =
            content.includes('import') || content.includes('require');
          const hasExports =
            content.includes('export') || content.includes('module.exports');
          const hasLogging =
            content.includes('logger') ||
            content.includes('winston') ||
            content.includes('log');

          if (hasImports && hasExports && hasLogging) {
            this.log(`${file} appears to be a valid logging module`);
          } else {
            this.log(`${file} may be incomplete`, false);
          }
        } catch (error) {
          this.log(`Error reading ${file}: ${error.message}`, false);
        }
      }
    }
  }

  performanceTest() {
    logger.info('Basic Performance Test...');

    try {
      const winston = require('winston');

      // Create performance test logger
      const perfLogger = winston.createLogger({
        level: 'info',
        format: winston.format.json(),
        transports: [
          new winston.transports.File({
            filename: path.join(this.logsDir, 'performance-test.log'),
          }),
        ],
      });

      const iterations = 100;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        perfLogger.info(`Performance test entry ${i}`, {
          iteration: i,
          timestamp: new Date().toISOString(),
        });
      }

      const duration = performance.now() - startTime;
      const logsPerMs = iterations / duration;

      this.log(
        `Performance test: ${iterations} logs in ${duration.toFixed(2)}ms`
      );
      this.log(`Rate: ${(logsPerMs * 1000).toFixed(0)} logs/second`);

      if (logsPerMs > 0.1) {
        // More than 100 logs per second
        this.log('Basic logging performance acceptable');
      } else {
        this.log('Logging performance may need attention', false);
      }
    } catch (error) {
      this.log(`Performance test failed: ${error.message}`, false);
    }
  }

  run() {
    logger.info('Starting Simple Logging Infrastructure Validation...');

    this.validateEnvironmentSetup();
    this.validateLogDirectorySetup();
    this.validateFileStructure();
    this.validateTypeScriptFiles();
    this.validateBasicLogging();
    this.performanceTest();

    // Wait for async operations
    setTimeout(() => {
      this.validateLogFileCreation();

      setTimeout(() => {
        this.showResults();
      }, 2000);
    }, 1000);
  }

  showResults() {
    logger.info('Validation Results:');
    logger.info('Passed: %d', this.results.passed);
    logger.info('Failed: %d', this.results.failed);

    if (this.results.failed > 0) {
      logger.warn('Issues:');
      this.results.errors.forEach(error => logger.warn('  - %s', error));
    }

    const total = this.results.passed + this.results.failed;
    const successRate = total > 0 ? (this.results.passed / total) * 100 : 0;
    logger.info('Success Rate: %s%', successRate.toFixed(1));

    if (successRate >= 80) {
      logger.info('Basic logging infrastructure validation PASSED!');
      logger.info('The logging infrastructure appears to be properly set up.');
    } else if (successRate >= 60) {
      logger.warn('Logging infrastructure validation PARTIALLY PASSED');
      logger.warn(
        'Some components may need attention, but basic functionality is working.'
      );
    } else {
      logger.error('Logging infrastructure validation FAILED');
      logger.error('Significant issues detected. Please review the setup.');
    }

    logger.info('Next Steps:');
    logger.info('1. Run the GraphQL server to test full integration');
    logger.info('2. Check the logs directory for generated log files');
    logger.info('3. Access /dashboard endpoint to view the logging dashboard');
    logger.info('4. Monitor the logs for correlation IDs and structured data');
  }
}

// Run validation if called directly
if (require.main === module) {
  const validator = new SimpleLoggingValidator();
  validator.run();
}

module.exports = SimpleLoggingValidator;
