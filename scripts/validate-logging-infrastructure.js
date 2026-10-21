#!/usr/bin/env node

/**
 * Logging Infrastructure Validation Script - Task 67.4
 *
 * Comprehensive validation of the logging infrastructure including
 * file creation, middleware integration, and monitoring capabilities.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const winston = require('winston');

const scriptLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

// Import logging components
let appLogger,
  performanceLogger,
  securityLogger,
  graphqlLogger,
  crosschainLogger,
  iotLogger,
  weatherLogger;
let generateCorrelationId,
  logPerformanceMetrics,
  logSecurityEvent,
  logGraphQLOperation;
let logMonitor, alertManager, LogAnalyzer;
let dashboardInstance;

try {
  const loggerModule = require('../server/utils/logger.ts');
  ({
    appLogger,
    performanceLogger,
    securityLogger,
    graphqlLogger,
    crosschainLogger,
    iotLogger,
    weatherLogger,
    generateCorrelationId,
    logPerformanceMetrics,
    logSecurityEvent,
    logGraphQLOperation,
  } = loggerModule);
} catch (error) {
  scriptLogger.info('Note: TypeScript logger not available, using JavaScript version');
  try {
    const loggerModule = require('../server/utils/logger.js');
    ({
      appLogger,
      performanceLogger,
      securityLogger,
      graphqlLogger,
      crosschainLogger,
      iotLogger,
      weatherLogger,
      generateCorrelationId,
      logPerformanceMetrics,
      logSecurityEvent,
      logGraphQLOperation,
    } = loggerModule);
  } catch (jsError) {
    scriptLogger.error('Failed to load logger module', { error: jsError.message });
  }
}

try {
  const analyzerModule = require('../server/utils/log-analyzer.ts');
  ({ logMonitor, alertManager, LogAnalyzer } = analyzerModule);
} catch (error) {
  scriptLogger.info('Note: Log analyzer not available', { error: error.message });
}

try {
  const dashboardModule = require('../server/utils/logging-dashboard.ts');
  ({ dashboardInstance } = dashboardModule);
} catch (error) {
  scriptLogger.info('Note: Dashboard not available', { error: error.message });
}

// Optional middleware imports
let logDatabaseQuery, logRedisOperation, logServiceCallPerformance;
let SecurityEventType, logHsmOperation, logTransactionSigning, logAdminAction;

try {
  const perfModule = require('../server/middleware/performance-logging.ts');
  ({ logDatabaseQuery, logRedisOperation, logServiceCallPerformance } =
    perfModule);
} catch (error) {
  scriptLogger.info('Note: Performance middleware not available');
}

try {
  const secModule = require('../server/middleware/security-logging.ts');
  ({
    SecurityEventType,
    logHsmOperation,
    logTransactionSigning,
    logAdminAction,
  } = secModule);
} catch (error) {
  scriptLogger.info('Note: Security middleware not available');
}

class LoggingValidator {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
    };
    this.logsDir = path.join(process.cwd(), 'logs');
  }

  log(message, success = true) {
    if (success) {
      scriptLogger.info('[PASS] %s', message);
      this.results.passed++;
    } else {
      scriptLogger.warn('[FAIL] %s', message);
      this.results.failed++;
      this.results.errors.push(message);
    }
  }

  async validateLogDirectorySetup() {
    scriptLogger.info('Validating Log Directory Setup...');

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

  async validateBasicLogging() {
    scriptLogger.info('Validating Basic Logging Functionality...');

    try {
      const correlationId = generateCorrelationId();
      const testMetadata = {
        operation: 'validation:basic-logging',
        correlationId,
        timestamp: new Date().toISOString(),
        test: true,
      };

      // Test each logger
      appLogger.info('Application logger test', testMetadata);
      this.log('Application logger working');

      performanceLogger.info('Performance logger test', testMetadata);
      this.log('Performance logger working');

      securityLogger.warn('Security logger test', testMetadata);
      this.log('Security logger working');

      graphqlLogger.debug('GraphQL logger test', testMetadata);
      this.log('GraphQL logger working');

      crosschainLogger.info('Cross-chain logger test', testMetadata);
      this.log('Cross-chain logger working');

      iotLogger.info('IoT logger test', testMetadata);
      this.log('IoT logger working');

      weatherLogger.info('Weather logger test', testMetadata);
      this.log('Weather logger working');

      // Test correlation ID generation
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      if (id1 !== id2 && id1.startsWith('wrfc_')) {
        this.log('Correlation ID generation working');
      } else {
        this.log('Correlation ID generation failed', false);
      }
    } catch (error) {
      this.log(`Basic logging failed: ${error.message}`, false);
    }
  }

  async validateSpecializedLogging() {
    scriptLogger.info('Validating Specialized Logging Functions...');

    try {
      const correlationId = generateCorrelationId();

      // Test performance logging
      const startTime = performance.now();
      await new Promise(resolve => setTimeout(resolve, 100));
      const duration = performance.now() - startTime;

      logPerformanceMetrics('Test operation', duration, process.memoryUsage(), {
        testOperation: true,
      });
      this.log('Performance metrics logging working');

      // Test security event logging
      logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        { testUser: 'validation-user', method: 'test' },
        'info',
        'test-user-id',
        '127.0.0.1'
      );
      this.log('Security event logging working');

      // Test GraphQL operation logging
      logGraphQLOperation(
        'query',
        'testQuery',
        50,
        5,
        { testVar: 'value' },
        'test-user'
      );
      this.log('GraphQL operation logging working');

      // Test database query logging
      logDatabaseQuery('SELECT', 'users', 'findById', 25, true);
      this.log('Database query logging working');

      // Test Redis operation logging
      logRedisOperation('GET', 'user:*', 5, true);
      this.log('Redis operation logging working');

      // Test service call logging
      logServiceCallPerformance(
        'test-service',
        '/test/endpoint',
        'GET',
        150,
        200,
        true
      );
      this.log('Service call logging working');

      // Test HSM operation logging
      logHsmOperation('sign', 'test-key-id', true, 'test-user', {
        algorithm: 'RSA',
      });
      this.log('HSM operation logging working');

      // Test transaction signing logging
      logTransactionSigning(
        '0x123abc',
        '0xtest-wallet',
        '100.5',
        '0xrecipient',
        'test-user',
        'ethereum'
      );
      this.log('Transaction signing logging working');

      // Test admin action logging
      logAdminAction('user-update', 'user:test-123', 'admin-user', {
        field: 'email',
        oldValue: 'old@test.com',
        newValue: 'new@test.com',
      });
      this.log('Admin action logging working');
    } catch (error) {
      this.log(`Specialized logging failed: ${error.message}`, false);
    }
  }

  async validateFileCreation() {
    scriptLogger.info('Validating Log File Creation...');

    // Wait for logs to be written
    await new Promise(resolve => setTimeout(resolve, 2000));

    const expectedLogFiles = [
      'combined.log',
      'error.log',
      'performance.log',
      'security.log',
      'graphql.log',
      'crosschain.log',
      'iot.log',
      'weather.log',
    ];

    for (const filename of expectedLogFiles) {
      const filepath = path.join(this.logsDir, filename);
      try {
        if (fs.existsSync(filepath)) {
          const stats = fs.statSync(filepath);
          if (stats.size > 0) {
            this.log(`${filename} created and contains data`);
          } else {
            this.log(`${filename} created but empty`, false);
          }
        } else {
          this.log(`${filename} not created`, false);
        }
      } catch (error) {
        this.log(`Error checking ${filename}: ${error.message}`, false);
      }
    }
  }

  async validateLogContent() {
    scriptLogger.info('Validating Log Content Format...');

    try {
      const combinedLogPath = path.join(this.logsDir, 'combined.log');

      if (fs.existsSync(combinedLogPath)) {
        const logContent = fs.readFileSync(combinedLogPath, 'utf8');
        const lines = logContent
          .trim()
          .split('\n')
          .filter(line => line.trim());

        if (lines.length > 0) {
          this.log(`Found ${lines.length} log entries`);

          // Check if logs are valid JSON
          let validJsonCount = 0;
          let hasCorrelationId = 0;
          let hasTimestamp = 0;

          for (const line of lines.slice(-10)) {
            // Check last 10 entries
            try {
              const logEntry = JSON.parse(line);
              validJsonCount++;

              if (logEntry.correlationId || logEntry.meta?.correlationId) {
                hasCorrelationId++;
              }

              if (logEntry.timestamp || logEntry['@timestamp']) {
                hasTimestamp++;
              }
            } catch (error) {
              // Not valid JSON, might be text format
            }
          }

          if (validJsonCount > 0) {
            this.log(`${validJsonCount} entries are valid JSON format`);
          }

          if (hasCorrelationId > 0) {
            this.log(`${hasCorrelationId} entries contain correlation IDs`);
          }

          if (hasTimestamp > 0) {
            this.log(`${hasTimestamp} entries contain timestamps`);
          }
        } else {
          this.log('No log entries found', false);
        }
      } else {
        this.log('Combined log file does not exist', false);
      }
    } catch (error) {
      this.log(`Log content validation failed: ${error.message}`, false);
    }
  }

  async validateMonitoring() {
    scriptLogger.info('Validating Log Monitoring...');

    try {
      // Test log monitoring
      logMonitor.startMonitoring(this.logsDir);
      this.log('Log monitoring started');

      // Wait a moment for monitoring to initialize
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Generate some test events
      appLogger.error('Test error for monitoring', { test: true });
      appLogger.warn('Test warning for monitoring', { test: true });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check alert manager
      const alertStats = alertManager.getAlertStatistics();
      this.log(
        `Alert manager operational (${alertStats.totalAlerts} total alerts)`
      );

      logMonitor.stopMonitoring();
      this.log('Log monitoring stopped cleanly');
    } catch (error) {
      this.log(`Monitoring validation failed: ${error.message}`, false);
    }
  }

  async validateDashboard() {
    scriptLogger.info('Validating Dashboard Integration...');

    try {
      // Test dashboard data generation
      const dashboardData = dashboardInstance.getDashboardData();

      if (dashboardData && typeof dashboardData === 'object') {
        this.log('Dashboard data generation working');

        if (dashboardData.systemMetrics) {
          this.log('System metrics included in dashboard');
        }

        if (dashboardData.serviceHealth) {
          this.log('Service health included in dashboard');
        }

        if (dashboardData.generatedAt) {
          this.log('Dashboard timestamp included');
        }
      } else {
        this.log('Dashboard data generation failed', false);
      }
    } catch (error) {
      this.log(`Dashboard validation failed: ${error.message}`, false);
    }
  }

  async validateLogAnalysis() {
    scriptLogger.info('Validating Log Analysis...');

    try {
      // Test log analysis
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour ago

      const report = await LogAnalyzer.generateReport(this.logsDir, {
        start: startTime,
        end: endTime,
      });

      if (report && typeof report === 'object') {
        this.log('Log analysis report generation working');

        if (report.summary) {
          this.log('Report summary included');
        }

        if (report.timeRange) {
          this.log('Report time range included');
        }
      } else {
        this.log('Log analysis report generation failed', false);
      }
    } catch (error) {
      this.log(`Log analysis validation failed: ${error.message}`, false);
    }
  }

  async validateErrorHandling() {
    scriptLogger.info('Validating Error Handling...');

    try {
      // Test logging with invalid data
      appLogger.info('Test with null', null);
      this.log('Handles null data gracefully');

      appLogger.info('Test with undefined', undefined);
      this.log('Handles undefined data gracefully');

      // Test circular reference handling
      const circular = { test: true };
      circular.self = circular;
      appLogger.info('Test with circular reference', { circular });
      this.log('Handles circular references gracefully');

      // Test very large object
      const largeObject = {
        data: 'x'.repeat(10000),
        nested: {
          more: 'y'.repeat(5000),
        },
      };
      appLogger.info('Test with large object', largeObject);
      this.log('Handles large objects gracefully');
    } catch (error) {
      this.log(`Error handling validation failed: ${error.message}`, false);
    }
  }

  async validatePerformance() {
    scriptLogger.info('Validating Logging Performance...');

    try {
      const iterations = 1000;
      const startTime = performance.now();

      // Generate many log entries quickly
      for (let i = 0; i < iterations; i++) {
        appLogger.info(`Performance test ${i}`, {
          iteration: i,
          correlationId: generateCorrelationId(),
          timestamp: new Date().toISOString(),
        });
      }

      const duration = performance.now() - startTime;
      const logsPerSecond = (iterations / duration) * 1000;

      this.log(
        `Performance test: ${iterations} logs in ${duration.toFixed(2)}ms`
      );
      this.log(`Logging rate: ${logsPerSecond.toFixed(0)} logs/second`);

      if (logsPerSecond > 100) {
        this.log('Logging performance is acceptable');
      } else {
        this.log('Logging performance may need optimization', false);
      }
    } catch (error) {
      this.log(`Performance validation failed: ${error.message}`, false);
    }
  }

  async run() {
    scriptLogger.info('Starting Logging Infrastructure Validation...');

    await this.validateLogDirectorySetup();
    await this.validateBasicLogging();
    await this.validateSpecializedLogging();
    await this.validateFileCreation();
    await this.validateLogContent();
    await this.validateMonitoring();
    await this.validateDashboard();
    await this.validateLogAnalysis();
    await this.validateErrorHandling();
    await this.validatePerformance();

    scriptLogger.info('Validation Results:');
    scriptLogger.info('Passed: %d', this.results.passed);
    scriptLogger.info('Failed: %d', this.results.failed);

    if (this.results.failed > 0) {
      scriptLogger.warn('Failures:');
      this.results.errors.forEach(error => scriptLogger.warn('  - %s', error));
    }

    const successRate =
      (this.results.passed / (this.results.passed + this.results.failed)) * 100;
    scriptLogger.info('Success Rate: %s%', successRate.toFixed(1));

    if (successRate >= 90) {
      scriptLogger.info('Logging infrastructure validation PASSED!');
    } else if (successRate >= 75) {
      scriptLogger.warn(
        'Logging infrastructure validation PARTIALLY PASSED - Some issues need attention'
      );
    } else {
      scriptLogger.error(
        'Logging infrastructure validation FAILED - Significant issues detected'
      );
    }

    return successRate >= 90;
  }
}

// Run validation if called directly
if (require.main === module) {
  const validator = new LoggingValidator();
  validator
    .run()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      scriptLogger.error('Validation failed with error', { error: error.message });
      process.exit(1);
    });
}

module.exports = LoggingValidator;
