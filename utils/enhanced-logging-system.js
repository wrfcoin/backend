/**
 * Enhanced Logging System for Wrfcoin Core
 *
 * This module provides comprehensive logging capabilities with structured
 * logging, log rotation, filtering, and real-time monitoring for the
 * entire Wrfcoin blockchain infrastructure.
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs').promises;
const EventEmitter = require('events');

class EnhancedLoggingSystem extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      logLevel: config.logLevel || 'info',
      logDir: config.logDir || path.join(process.cwd(), 'logs'),
      maxFileSize: config.maxFileSize || '20m',
      maxFiles: config.maxFiles || '14d',
      datePattern: config.datePattern || 'YYYY-MM-DD',
      enableConsole: config.enableConsole !== false,
      enableFile: config.enableFile !== false,
      enableStructured: config.enableStructured !== false,
      enableMetrics: config.enableMetrics !== false,
      ...config,
    };

    this.loggers = {};
    this.metrics = {
      totalLogs: 0,
      logsByLevel: {
        error: 0,
        warn: 0,
        info: 0,
        debug: 0,
      },
      logsByModule: {},
      recentErrors: [],
      performance: {
        averageLogTime: 0,
        totalLogTime: 0,
      },
    };

    this.initialized = false;
    this.initialize();
  }

  /**
   * Initialize the logging system
   */
  async initialize() {
    try {
      // Ensure log directory exists
      await this.ensureLogDirectory();

      // Create main application logger
      this.createLogger('app', {
        level: this.config.logLevel,
        enableConsole: this.config.enableConsole,
        enableFile: this.config.enableFile,
      });

      // Create specialized loggers
      this.createSpecializedLoggers();

      // Start metrics collection
      if (this.config.enableMetrics) {
        this.startMetricsCollection();
      }

      this.initialized = true;
      this.log('info', 'Enhanced Logging System initialized successfully', {
        module: 'logging',
      });

      return true;
    } catch (error) {
      console.error('[Logging System] Initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Create a logger instance with specific configuration
   */
  createLogger(name, options = {}) {
    const loggerConfig = {
      level: options.level || this.config.logLevel,
      format: this.createLogFormat(name),
      transports: [],
    };

    // Console transport
    if (options.enableConsole !== false && this.config.enableConsole) {
      loggerConfig.transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
        })
      );
    }

    // File transport with daily rotation
    if (options.enableFile !== false && this.config.enableFile) {
      loggerConfig.transports.push(
        new DailyRotateFile({
          filename: path.join(this.config.logDir, `${name}-%DATE%.log`),
          datePattern: this.config.datePattern,
          maxSize: this.config.maxFileSize,
          maxFiles: this.config.maxFiles,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
    }

    // Error file transport
    if (options.enableFile !== false && this.config.enableFile) {
      loggerConfig.transports.push(
        new DailyRotateFile({
          filename: path.join(this.config.logDir, `${name}-error-%DATE%.log`),
          datePattern: this.config.datePattern,
          level: 'error',
          maxSize: this.config.maxFileSize,
          maxFiles: this.config.maxFiles,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
    }

    const logger = winston.createLogger(loggerConfig);
    this.loggers[name] = logger;

    return logger;
  }

  /**
   * Create specialized loggers for different components
   */
  createSpecializedLoggers() {
    // Blockchain core logger
    this.createLogger('blockchain', {
      level: 'debug',
    });

    // Transaction logger
    this.createLogger('transactions', {
      level: 'info',
    });

    // Cross-chain bridge logger
    this.createLogger('bridges', {
      level: 'info',
    });

    // IoT sensor logger
    this.createLogger('iot', {
      level: 'info',
    });

    // Performance logger
    this.createLogger('performance', {
      level: 'info',
    });

    // Security logger
    this.createLogger('security', {
      level: 'warn',
    });

    // API logger
    this.createLogger('api', {
      level: 'info',
    });

    // System logger
    this.createLogger('system', {
      level: 'info',
    });
  }

  /**
   * Create standardized log format
   */
  createLogFormat(loggerName) {
    return winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS',
      }),
      winston.format.errors({ stack: true }),
      winston.format.metadata({
        fillExcept: ['message', 'level', 'timestamp', 'label'],
      }),
      winston.format.json()
    );
  }

  /**
   * Main logging method
   */
  log(level, message, metadata = {}, loggerName = 'app') {
    const startTime = Date.now();

    try {
      const logger = this.loggers[loggerName] || this.loggers['app'];

      // Enhance metadata
      const enhancedMetadata = {
        ...metadata,
        logger: loggerName,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        hostname: require('os').hostname(),
      };

      // Add trace ID if available
      if (metadata.traceId) {
        enhancedMetadata.traceId = metadata.traceId;
      }

      // Log the message
      logger.log(level, message, enhancedMetadata);

      // Update metrics
      this.updateMetrics(level, loggerName, Date.now() - startTime);

      // Handle error-level logs specially
      if (level === 'error') {
        this.handleErrorLog(message, enhancedMetadata);
      }

      // Emit log event for real-time monitoring
      this.emit('log', {
        level,
        message,
        metadata: enhancedMetadata,
        logger: loggerName,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[Logging System] Failed to log message:', error.message);
    }
  }

  /**
   * Convenience methods for different log levels
   */
  debug(message, metadata = {}, loggerName = 'app') {
    this.log('debug', message, metadata, loggerName);
  }

  info(message, metadata = {}, loggerName = 'app') {
    this.log('info', message, metadata, loggerName);
  }

  warn(message, metadata = {}, loggerName = 'app') {
    this.log('warn', message, metadata, loggerName);
  }

  error(message, metadata = {}, loggerName = 'app') {
    this.log('error', message, metadata, loggerName);
  }

  /**
   * Specialized logging methods for different components
   */
  logBlockchain(level, message, metadata = {}) {
    this.log(
      level,
      message,
      { ...metadata, component: 'blockchain' },
      'blockchain'
    );
  }

  logTransaction(level, message, transactionData = {}) {
    this.log(
      level,
      message,
      {
        ...transactionData,
        component: 'transaction',
        txHash: transactionData.hash,
        from: transactionData.from,
        to: transactionData.to,
        amount: transactionData.amount,
      },
      'transactions'
    );
  }

  logBridge(level, message, bridgeData = {}) {
    this.log(
      level,
      message,
      {
        ...bridgeData,
        component: 'bridge',
        sourceChain: bridgeData.sourceChain,
        targetChain: bridgeData.targetChain,
        bridgeType: bridgeData.bridgeType,
      },
      'bridges'
    );
  }

  logIoT(level, message, sensorData = {}) {
    this.log(
      level,
      message,
      {
        ...sensorData,
        component: 'iot',
        deviceId: sensorData.deviceId,
        sensorType: sensorData.sensorType,
        location: sensorData.location,
      },
      'iot'
    );
  }

  logPerformance(level, message, performanceData = {}) {
    this.log(
      level,
      message,
      {
        ...performanceData,
        component: 'performance',
        responseTime: performanceData.responseTime,
        throughput: performanceData.throughput,
        cpuUsage: performanceData.cpuUsage,
        memoryUsage: performanceData.memoryUsage,
      },
      'performance'
    );
  }

  logSecurity(level, message, securityData = {}) {
    this.log(
      level,
      message,
      {
        ...securityData,
        component: 'security',
        eventType: securityData.eventType,
        sourceIP: securityData.sourceIP,
        userAgent: securityData.userAgent,
        severity: securityData.severity,
      },
      'security'
    );
  }

  logAPI(level, message, apiData = {}) {
    this.log(
      level,
      message,
      {
        ...apiData,
        component: 'api',
        method: apiData.method,
        endpoint: apiData.endpoint,
        statusCode: apiData.statusCode,
        responseTime: apiData.responseTime,
        userAgent: apiData.userAgent,
        ip: apiData.ip,
      },
      'api'
    );
  }

  /**
   * Handle error-level logs with special processing
   */
  handleErrorLog(message, metadata) {
    const errorEntry = {
      message,
      metadata,
      timestamp: new Date(),
      id: this.generateErrorId(),
    };

    // Add to recent errors (keep last 100)
    this.metrics.recentErrors.unshift(errorEntry);
    if (this.metrics.recentErrors.length > 100) {
      this.metrics.recentErrors = this.metrics.recentErrors.slice(0, 100);
    }

    // Emit critical error event
    this.emit('criticalError', errorEntry);

    // Check for error patterns
    this.checkErrorPatterns();
  }

  /**
   * Update logging metrics
   */
  updateMetrics(level, loggerName, logTime) {
    this.metrics.totalLogs++;
    this.metrics.logsByLevel[level] =
      (this.metrics.logsByLevel[level] || 0) + 1;
    this.metrics.logsByModule[loggerName] =
      (this.metrics.logsByModule[loggerName] || 0) + 1;

    // Update performance metrics
    this.metrics.performance.totalLogTime += logTime;
    this.metrics.performance.averageLogTime =
      this.metrics.performance.totalLogTime / this.metrics.totalLogs;
  }

  /**
   * Check for error patterns and anomalies
   */
  checkErrorPatterns() {
    const recentErrorsLast5Min = this.metrics.recentErrors.filter(
      error => Date.now() - error.timestamp < 5 * 60 * 1000
    );

    // Alert if too many errors in short time
    if (recentErrorsLast5Min.length > 10) {
      this.emit('errorSpike', {
        count: recentErrorsLast5Min.length,
        timeWindow: '5 minutes',
        errors: recentErrorsLast5Min,
      });
    }
  }

  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    setInterval(() => {
      this.emit('metricsUpdate', this.getMetrics());
    }, 60000); // Every minute
  }

  /**
   * Get current logging metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      loggers: Object.keys(this.loggers),
      uptime: process.uptime(),
      timestamp: new Date(),
    };
  }

  /**
   * Search logs by criteria
   */
  async searchLogs(criteria = {}) {
    try {
      const {
        level,
        logger,
        startDate,
        endDate,
        message,
        limit = 100,
      } = criteria;

      // In a production system, this would interface with a log aggregation system
      // For now, we'll simulate search results
      const mockResults = [
        {
          timestamp: new Date(),
          level: level || 'info',
          message: message || 'Sample log message',
          logger: logger || 'app',
          metadata: { component: 'search-demo' },
        },
      ];

      return {
        total: mockResults.length,
        results: mockResults.slice(0, limit),
        criteria,
      };
    } catch (error) {
      this.error('Failed to search logs', { error: error.message });
      throw error;
    }
  }

  /**
   * Export logs for external analysis
   */
  async exportLogs(options = {}) {
    try {
      const {
        format = 'json',
        startDate,
        endDate,
        loggers = Object.keys(this.loggers),
      } = options;

      const exportData = {
        exportDate: new Date(),
        format,
        startDate,
        endDate,
        loggers,
        metrics: this.getMetrics(),
        logs: [], // Would contain actual log data in production
      };

      const filename = `wrfcoin-logs-export-${Date.now()}.${format}`;
      const filepath = path.join(this.config.logDir, filename);

      await fs.writeFile(filepath, JSON.stringify(exportData, null, 2));

      this.info('Logs exported successfully', {
        filename,
        format,
        loggers: loggers.length,
      });

      return {
        success: true,
        filename,
        filepath,
        size: (await fs.stat(filepath)).size,
      };
    } catch (error) {
      this.error('Failed to export logs', { error: error.message });
      throw error;
    }
  }

  /**
   * Set log level for specific logger
   */
  setLogLevel(loggerName, level) {
    const logger = this.loggers[loggerName];
    if (logger) {
      logger.level = level;
      this.info(`Log level changed for ${loggerName}`, {
        logger: loggerName,
        newLevel: level,
      });
    } else {
      this.warn(`Logger ${loggerName} not found`);
    }
  }

  /**
   * Get available loggers
   */
  getLoggers() {
    return Object.keys(this.loggers).map(name => ({
      name,
      level: this.loggers[name].level,
      transports: this.loggers[name].transports.length,
    }));
  }

  /**
   * Health check for logging system
   */
  async healthCheck() {
    try {
      const testMessage = 'Logging system health check';
      const testMetadata = { test: true, timestamp: Date.now() };

      // Test each logger
      const loggerTests = Object.keys(this.loggers).map(async name => {
        try {
          this.log('info', testMessage, testMetadata, name);
          return { logger: name, status: 'healthy' };
        } catch (error) {
          return { logger: name, status: 'unhealthy', error: error.message };
        }
      });

      const results = await Promise.all(loggerTests);
      const healthyLoggers = results.filter(r => r.status === 'healthy').length;
      const totalLoggers = results.length;

      return {
        healthy: healthyLoggers === totalLoggers,
        loggers: results,
        metrics: this.getMetrics(),
        initialized: this.initialized,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        initialized: this.initialized,
      };
    }
  }

  // Utility methods

  async ensureLogDirectory() {
    try {
      await fs.access(this.config.logDir);
    } catch {
      await fs.mkdir(this.config.logDir, { recursive: true });
    }
  }

  generateErrorId() {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.info('Shutting down logging system...');

    // Close all loggers
    Object.values(this.loggers).forEach(logger => {
      logger.close();
    });

    this.removeAllListeners();
    this.initialized = false;

    console.log('[Logging System] Shutdown complete');
  }
}

module.exports = EnhancedLoggingSystem;
