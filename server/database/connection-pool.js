/**
 * WRFCoin Database Connection Pool with Data Flow Validation
 * Enhanced PostgreSQL connection management with validation and monitoring
 */

const { Pool, Client } = require('pg');
const { logger } = require('../utils/logger');
const crypto = require('crypto');
const EventEmitter = require('events');
const { createDatabaseSSLConfig } = require('../config/secure-ssl-config');

// Query validation schemas
const QUERY_SCHEMAS = {
  SELECT: {
    maxResults: 10000,
    allowedTables: [
      'weather_stations',
      'sensor_readings',
      'carbon_credits',
      'governance_proposals',
      'votes',
      'transactions',
      'users',
      'wallets',
      'cross_chain_transfers',
      'compute_jobs',
      'ai_models',
      'storage_nodes',
      'iot_devices',
    ],
    forbiddenOperations: ['DROP', 'TRUNCATE', 'ALTER', 'CREATE'],
  },
  INSERT: {
    maxBatchSize: 1000,
    requiredValidation: true,
    allowedTables: [
      'weather_stations',
      'sensor_readings',
      'carbon_credits',
      'votes',
      'transactions',
      'cross_chain_transfers',
      'compute_jobs',
      'audit_logs',
    ],
  },
  UPDATE: {
    maxBatchSize: 100,
    requiredWhere: true,
    auditRequired: true,
  },
  DELETE: {
    maxBatchSize: 50,
    requiredWhere: true,
    auditRequired: true,
    restrictedTables: ['audit_logs', 'system_config'],
  },
};

// Connection pool configuration
const POOL_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'wrfcoin',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',

  // Pool settings
  min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 10000,

  // SSL configuration - uses secure config with rejectUnauthorized: true
  ssl: createDatabaseSSLConfig(),

  // Additional options
  query_timeout: 30000,
  statement_timeout: 60000,
  application_name: 'WRFCoin-Backend',
};

class DatabaseConnectionPool extends EventEmitter {
  constructor() {
    super();
    this.pool = null;
    this.isInitialized = false;
    this.connectionAttempts = 0;
    this.maxRetryAttempts = 5;
    this.retryDelay = 5000;

    // Metrics
    this.queryCount = 0;
    this.errorCount = 0;
    this.validationCount = 0;
    this.startTime = Date.now();
    this.activeConnections = 0;
    this.queryHistory = [];
    this.maxHistorySize = 1000;

    // Query cache for identical operations
    this.queryCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes

    this.initializePool();
  }

  async initializePool() {
    try {
      logger.info('Initializing database connection pool', {
        host: POOL_CONFIG.host,
        port: POOL_CONFIG.port,
        database: POOL_CONFIG.database,
        poolMin: POOL_CONFIG.min,
        poolMax: POOL_CONFIG.max,
      });

      this.pool = new Pool(POOL_CONFIG);

      // Set up pool event handlers
      this.pool.on('connect', client => {
        this.activeConnections++;
        logger.debug('Database client connected', {
          activeConnections: this.activeConnections,
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
        });
      });

      this.pool.on('remove', client => {
        this.activeConnections--;
        logger.debug('Database client removed', {
          activeConnections: this.activeConnections,
          totalCount: this.pool.totalCount,
        });
      });

      this.pool.on('error', (err, client) => {
        this.errorCount++;
        logger.error('Database pool error', {
          error: err.message,
          errorCount: this.errorCount,
        });
        this.emit('poolError', err);
      });

      // Test connection
      await this.testConnection();
      this.isInitialized = true;
      this.connectionAttempts = 0;

      logger.info('Database connection pool initialized successfully');
      this.emit('poolInitialized');
    } catch (error) {
      this.connectionAttempts++;
      logger.error('Failed to initialize database pool', {
        error: error.message,
        attempt: this.connectionAttempts,
        maxAttempts: this.maxRetryAttempts,
      });

      if (this.connectionAttempts < this.maxRetryAttempts) {
        logger.info(`Retrying connection in ${this.retryDelay}ms`);
        setTimeout(() => this.initializePool(), this.retryDelay);
      } else {
        logger.error('Max connection attempts reached, giving up');
        this.emit('poolFailed', error);
        throw error;
      }
    }
  }

  async testConnection() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT NOW() as server_time, version() as server_version'
      );
      logger.info('Database connection test successful', {
        serverTime: result.rows[0].server_time,
        serverVersion: result.rows[0].server_version.split(' ')[0],
      });
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Execute query with comprehensive validation and monitoring
   */
  async query(text, params = [], options = {}) {
    const queryExecution = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      query: text,
      params: params,
      success: false,
      metrics: {},
      validation: {},
      cached: false,
    };

    try {
      if (!this.isInitialized) {
        throw new Error('Database pool not initialized');
      }

      const startTime = Date.now();
      this.queryCount++;

      // Query validation
      const validation = await this.validateQuery(text, params, options);
      queryExecution.validation = validation;
      this.validationCount++;

      if (!validation.valid && !options.skipValidation) {
        throw new Error(
          `Query validation failed: ${validation.errors.join(', ')}`
        );
      }

      // Check query cache for SELECT operations
      const cacheKey = this.generateQueryCacheKey(text, params);
      if (validation.operation === 'SELECT' && this.queryCache.has(cacheKey)) {
        const cached = this.queryCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          queryExecution.cached = true;
          queryExecution.success = true;
          queryExecution.result = cached.result;
          queryExecution.metrics.executionTime = Date.now() - startTime;
          queryExecution.metrics.cached = true;

          this.addToHistory(queryExecution);
          logger.debug('Query served from cache', {
            queryId: queryExecution.id,
            cacheKey: cacheKey.substring(0, 16) + '...',
          });

          return cached.result;
        }
      }

      // Execute query
      const client = await this.pool.connect();
      let result;

      try {
        // Set query timeout
        if (options.timeout) {
          await client.query(`SET statement_timeout = ${options.timeout}`);
        }

        // Execute with parameter validation
        if (params && params.length > 0) {
          result = await client.query(text, this.sanitizeParams(params));
        } else {
          result = await client.query(text);
        }

        queryExecution.success = true;
        queryExecution.result = result;
        queryExecution.metrics.executionTime = Date.now() - startTime;
        queryExecution.metrics.rowCount = result.rowCount;
        queryExecution.metrics.fields = result.fields?.length || 0;

        // Cache SELECT results
        if (validation.operation === 'SELECT' && result.rowCount <= 1000) {
          this.queryCache.set(cacheKey, {
            result: result,
            timestamp: Date.now(),
          });
        }

        // Log slow queries
        if (queryExecution.metrics.executionTime > 1000) {
          logger.warn('Slow query detected', {
            queryId: queryExecution.id,
            executionTime: queryExecution.metrics.executionTime,
            query: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
          });
        }

        this.addToHistory(queryExecution);
        this.emit('queryExecuted', queryExecution);

        return result;
      } finally {
        client.release();
      }
    } catch (error) {
      this.errorCount++;
      queryExecution.success = false;
      queryExecution.error = {
        message: error.message,
        code: error.code,
        detail: error.detail,
      };
      queryExecution.metrics.executionTime =
        Date.now() - queryExecution.timestamp;

      this.addToHistory(queryExecution);
      this.emit('queryError', queryExecution);

      logger.error('Database query failed', {
        queryId: queryExecution.id,
        error: error.message,
        code: error.code,
        query: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
      });

      throw error;
    }
  }

  /**
   * Execute transaction with rollback capability
   */
  async transaction(queries, options = {}) {
    const transactionExecution = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      queryCount: queries.length,
      success: false,
      metrics: {},
      queries: [],
    };

    const client = await this.pool.connect();

    try {
      const startTime = Date.now();
      await client.query('BEGIN');

      const results = [];
      for (const [index, queryDef] of queries.entries()) {
        const { text, params = [], validation = {} } = queryDef;

        try {
          // Validate each query in transaction
          const queryValidation = await this.validateQuery(
            text,
            params,
            validation
          );
          if (!queryValidation.valid && !options.skipValidation) {
            throw new Error(
              `Transaction query ${index + 1} validation failed: ${queryValidation.errors.join(', ')}`
            );
          }

          const result = await client.query(text, this.sanitizeParams(params));
          results.push(result);

          transactionExecution.queries.push({
            index,
            text: text.substring(0, 100),
            success: true,
            rowCount: result.rowCount,
          });
        } catch (queryError) {
          transactionExecution.queries.push({
            index,
            text: text.substring(0, 100),
            success: false,
            error: queryError.message,
          });
          throw queryError;
        }
      }

      await client.query('COMMIT');
      transactionExecution.success = true;
      transactionExecution.metrics.executionTime = Date.now() - startTime;
      transactionExecution.results = results;

      logger.info('Transaction completed successfully', {
        transactionId: transactionExecution.id,
        queryCount: queries.length,
        executionTime: transactionExecution.metrics.executionTime,
      });

      this.emit('transactionCompleted', transactionExecution);
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      transactionExecution.success = false;
      transactionExecution.error = error.message;
      transactionExecution.metrics.executionTime =
        Date.now() - transactionExecution.timestamp;

      logger.error('Transaction failed and rolled back', {
        transactionId: transactionExecution.id,
        error: error.message,
        queryCount: queries.length,
      });

      this.emit('transactionFailed', transactionExecution);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate SQL query for security and performance
   */
  async validateQuery(text, params = [], options = {}) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      operation: null,
      estimatedRows: null,
      securityLevel: 'safe',
    };

    try {
      // Normalize query
      const normalizedQuery = text.trim().toUpperCase();

      // Determine operation type
      if (normalizedQuery.startsWith('SELECT')) {
        validation.operation = 'SELECT';
      } else if (normalizedQuery.startsWith('INSERT')) {
        validation.operation = 'INSERT';
      } else if (normalizedQuery.startsWith('UPDATE')) {
        validation.operation = 'UPDATE';
      } else if (normalizedQuery.startsWith('DELETE')) {
        validation.operation = 'DELETE';
      } else {
        validation.operation = 'OTHER';
      }

      const schema = QUERY_SCHEMAS[validation.operation];
      if (!schema) {
        validation.warnings.push(
          `Unknown operation type: ${validation.operation}`
        );
        return validation;
      }

      // Check for forbidden operations
      if (schema.forbiddenOperations) {
        for (const forbidden of schema.forbiddenOperations) {
          if (normalizedQuery.includes(forbidden)) {
            validation.valid = false;
            validation.errors.push(
              `Forbidden operation detected: ${forbidden}`
            );
            validation.securityLevel = 'dangerous';
          }
        }
      }

      // Table access validation
      if (schema.allowedTables || schema.restrictedTables) {
        const tableMatches = text.match(
          /(?:FROM|INTO|UPDATE|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
        );
        if (tableMatches) {
          for (const match of tableMatches) {
            const tableName = match.split(/\s+/)[1].toLowerCase();

            if (
              schema.allowedTables &&
              !schema.allowedTables.includes(tableName)
            ) {
              validation.valid = false;
              validation.errors.push(
                `Access to table '${tableName}' not allowed for ${validation.operation} operations`
              );
            }

            if (
              schema.restrictedTables &&
              schema.restrictedTables.includes(tableName)
            ) {
              validation.valid = false;
              validation.errors.push(
                `Access to restricted table '${tableName}' denied`
              );
            }
          }
        }
      }

      // WHERE clause validation for UPDATE/DELETE
      if (schema.requiredWhere && !normalizedQuery.includes('WHERE')) {
        validation.valid = false;
        validation.errors.push(
          `WHERE clause required for ${validation.operation} operations`
        );
      }

      // Batch size validation
      if (schema.maxBatchSize && params.length > schema.maxBatchSize) {
        validation.valid = false;
        validation.errors.push(
          `Batch size ${params.length} exceeds maximum ${schema.maxBatchSize}`
        );
      }

      // Parameter validation
      if (params.length > 0) {
        for (const [index, param] of params.entries()) {
          if (typeof param === 'string' && param.length > 10000) {
            validation.warnings.push(
              `Parameter ${index + 1} is very large (${param.length} characters)`
            );
          }

          // Check for potential SQL injection patterns
          if (
            typeof param === 'string' &&
            this.containsSQLInjectionPattern(param)
          ) {
            validation.valid = false;
            validation.errors.push(
              `Parameter ${index + 1} contains potential SQL injection pattern`
            );
            validation.securityLevel = 'suspicious';
          }
        }
      }

      // Performance analysis for SELECT queries
      if (validation.operation === 'SELECT') {
        if (normalizedQuery.includes('SELECT *')) {
          validation.warnings.push(
            'SELECT * may impact performance, consider specifying columns'
          );
        }

        if (
          !normalizedQuery.includes('LIMIT') &&
          !normalizedQuery.includes('WHERE')
        ) {
          validation.warnings.push(
            'Query without LIMIT or WHERE clause may return many rows'
          );
        }
      }

      return validation;
    } catch (error) {
      validation.valid = false;
      validation.errors.push(`Query validation error: ${error.message}`);
      return validation;
    }
  }

  /**
   * Get connection pool statistics
   */
  getPoolStatistics() {
    const uptime = Date.now() - this.startTime;
    const poolStats = this.pool
      ? {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
        }
      : { totalCount: 0, idleCount: 0, waitingCount: 0 };

    return {
      ...poolStats,
      activeConnections: this.activeConnections,
      queryCount: this.queryCount,
      errorCount: this.errorCount,
      validationCount: this.validationCount,
      successRate: (
        ((this.queryCount - this.errorCount) / this.queryCount) *
        100
      ).toFixed(2),
      averageQueriesPerMinute: (this.queryCount / (uptime / 60000)).toFixed(2),
      uptime: uptime,
      cacheSize: this.queryCache.size,
      historySize: this.queryHistory.length,
    };
  }

  /**
   * Get recent query history
   */
  getQueryHistory(limit = 50) {
    return this.queryHistory.slice(-limit).reverse();
  }

  /**
   * Clear query cache
   */
  clearCache() {
    this.queryCache.clear();
    logger.info('Database query cache cleared');
  }

  /**
   * Graceful shutdown
   */
  async close() {
    if (this.pool) {
      logger.info('Closing database connection pool');
      await this.pool.end();
      this.isInitialized = false;
      this.emit('poolClosed');
      logger.info('Database connection pool closed');
    }
  }

  // Private helper methods
  containsSQLInjectionPattern(value) {
    const patterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/i,
      /(--|#|\/\*|\*\/)/,
      /(\b(OR|AND)\s+\d+\s*=\s*\d+)/i,
      /(CHAR|ASCII|SUBSTRING|LENGTH|LOWER|UPPER)\s*\(/i,
    ];

    return patterns.some(pattern => pattern.test(value));
  }

  sanitizeParams(params) {
    return params.map(param => {
      if (typeof param === 'string') {
        // Remove null bytes and other potentially dangerous characters
        return param.replace(/\0/g, '').trim();
      }
      return param;
    });
  }

  generateQueryCacheKey(text, params) {
    const queryStr = text.trim().toLowerCase();
    const paramsStr = JSON.stringify(params);
    return crypto
      .createHash('md5')
      .update(`${queryStr}:${paramsStr}`)
      .digest('hex');
  }

  addToHistory(execution) {
    this.queryHistory.push({
      id: execution.id,
      timestamp: execution.timestamp,
      operation: execution.validation?.operation || 'UNKNOWN',
      executionTime: execution.metrics?.executionTime || 0,
      success: execution.success,
      cached: execution.cached || false,
      rowCount: execution.metrics?.rowCount || 0,
    });

    // Maintain history size limit
    if (this.queryHistory.length > this.maxHistorySize) {
      this.queryHistory.splice(
        0,
        this.queryHistory.length - this.maxHistorySize
      );
    }
  }
}

// Export singleton instance
const connectionPool = new DatabaseConnectionPool();

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing database pool');
  await connectionPool.close();
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing database pool');
  await connectionPool.close();
});

module.exports = {
  connectionPool,
  DatabaseConnectionPool,
  QUERY_SCHEMAS,
  POOL_CONFIG,
};
