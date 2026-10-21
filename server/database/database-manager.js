/**
 * WRFCoin Database Manager
 *
 * Comprehensive database management system for weather data ingestion pipeline.
 * Integrates with existing WRFCoin database adapter and schema while providing
 * specialized methods for weather data operations.
 *
 * Features:
 * - Integration with existing database adapter and schema
 * - Weather data CRUD operations with proper validation
 * - Batch operations for performance optimization
 * - Connection pooling and error handling
 * - Data integrity and consistency checks
 * - Specialized queries for temporal and spatial data
 */

const { dbAdapter, pool, schema } = require('../database-adapter');
const { eq, and, gte, lte, desc, asc, sql } = require('drizzle-orm');
const Logger = require('../utils/logger');

class DatabaseManager {
  constructor(options = {}) {
    this.options = {
      // Connection settings
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      queryTimeout: options.queryTimeout || 30000,

      // Batch settings
      defaultBatchSize: options.defaultBatchSize || 100,
      maxBatchSize: options.maxBatchSize || 1000,

      // Data validation
      enableValidation: options.enableValidation !== false,
      enableIntegrityChecks: options.enableIntegrityChecks !== false,

      ...options,
    };

    this.logger = Logger;
    this.dbAdapter = dbAdapter;
    this.pool = pool;
    this.schema = schema;

    // Database connection state
    this.isConnected = false;
    this.connectionAttempts = 0;

    // Performance metrics
    this.metrics = {
      totalQueries: 0,
      successfulQueries: 0,
      failedQueries: 0,
      averageQueryTime: 0,
      totalQueryTime: 0,
      lastQueryAt: null,
    };
  }

  /**
   * Establish database connection
   */
  async connect() {
    try {
      this.logger.info('Connecting to database...');

      // Test connection with a simple query
      await this.pool.query('SELECT 1');

      this.isConnected = true;
      this.connectionAttempts = 0;
      this.logger.info('Database connection established successfully');
    } catch (error) {
      this.connectionAttempts++;
      this.logger.error(
        `Database connection failed (attempt ${this.connectionAttempts}):`,
        error
      );

      if (this.connectionAttempts < this.options.maxRetries) {
        this.logger.info(
          `Retrying connection in ${this.options.retryDelay}ms...`
        );
        await this.delay(this.options.retryDelay);
        return await this.connect();
      }

      throw new Error(
        `Database connection failed after ${this.options.maxRetries} attempts: ${error.message}`
      );
    }
  }

  /**
   * Disconnect from database
   */
  async disconnect() {
    try {
      if (this.pool) {
        await this.pool.end();
        this.isConnected = false;
        this.logger.info('Database connection closed');
      }
    } catch (error) {
      this.logger.error('Error closing database connection:', error);
      throw error;
    }
  }

  /**
   * Insert weather data record
   */
  async insertWeatherData(data) {
    const startTime = Date.now();

    try {
      // Validate input data
      if (this.options.enableValidation) {
        this.validateWeatherData(data);
      }

      // Check for existing record to prevent duplicates
      if (data.data_id) {
        const existing = await this.findWeatherDataByDataId(data.data_id);
        if (existing) {
          throw new Error(
            `Weather data with ID ${data.data_id} already exists`
          );
        }
      }

      // Insert using database adapter
      const result = await this.dbAdapter.insert(this.schema.weatherData, data);

      this.updateMetrics(Date.now() - startTime, true);
      this.logger.debug(`Weather data inserted successfully: ${result.id}`);

      return result;
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error inserting weather data:', error);
      throw error;
    }
  }

  /**
   * Insert multiple weather data records in batches
   */
  async insertWeatherDataBatch(dataArray) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      throw new Error('Data array must be non-empty array');
    }

    const startTime = Date.now();
    const batchSize = Math.min(dataArray.length, this.options.maxBatchSize);
    const results = [];
    const errors = [];

    try {
      // Process in chunks
      for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);

        try {
          // Validate batch data
          if (this.options.enableValidation) {
            batch.forEach(data => this.validateWeatherData(data));
          }

          // Insert batch using raw SQL for better performance
          const batchResults = await this.insertBatchRaw(batch);
          results.push(...batchResults);

          this.logger.debug(
            `Batch ${Math.floor(i / batchSize) + 1} inserted: ${batch.length} records`
          );
        } catch (error) {
          this.logger.error(
            `Batch ${Math.floor(i / batchSize) + 1} failed:`,
            error
          );
          errors.push({
            batchIndex: Math.floor(i / batchSize),
            error: error.message,
            data: batch.map(d => d.data_id || 'unknown'),
          });
        }
      }

      this.updateMetrics(Date.now() - startTime, errors.length === 0);

      return {
        successful: results.length,
        failed: errors.length,
        total: dataArray.length,
        results,
        errors,
      };
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error in batch insert:', error);
      throw error;
    }
  }

  /**
   * Raw batch insert for performance
   */
  async insertBatchRaw(batch) {
    const columns = [
      'data_id',
      'timestamp',
      'latitude',
      'longitude',
      'elevation',
      'station_id',
      'temperature',
      'humidity',
      'pressure',
      'wind_speed',
      'wind_direction',
      'precipitation',
      'cloud_cover',
      'visibility',
      'data_hash',
      'signature',
      'verification_status',
      'verifiers',
      'block_id',
      'source_type',
      'metadata',
    ];

    const placeholders = batch
      .map((_, index) => {
        const offset = index * columns.length;
        return `(${columns.map((_, colIndex) => `$${offset + colIndex + 1}`).join(', ')})`;
      })
      .join(', ');

    const values = batch.flatMap(data => [
      data.data_id,
      data.timestamp,
      data.latitude,
      data.longitude,
      data.elevation,
      data.station_id,
      data.temperature,
      data.humidity,
      data.pressure,
      data.wind_speed,
      data.wind_direction,
      data.precipitation,
      data.cloud_cover,
      data.visibility,
      data.data_hash,
      data.signature,
      data.verification_status || 'pending',
      data.verifiers ? JSON.stringify(data.verifiers) : null,
      data.block_id,
      data.source_type,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]);

    const query = `
            INSERT INTO weather_data (${columns.join(', ')})
            VALUES ${placeholders}
            RETURNING id, data_id, timestamp
        `;

    const result = await this.pool.query(query, values);
    return result.rows;
  }

  /**
   * Find weather data by data ID
   */
  async findWeatherDataByDataId(dataId) {
    const startTime = Date.now();

    try {
      const result = await this.dbAdapter.rawQuery(
        'SELECT * FROM weather_data WHERE data_id = $1 LIMIT 1',
        [dataId]
      );

      this.updateMetrics(Date.now() - startTime, true);

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error finding weather data by ID:', error);
      throw error;
    }
  }

  /**
   * Get weather data by location and time range
   */
  async getWeatherDataByLocationAndTime(
    latitude,
    longitude,
    startTime,
    endTime,
    options = {}
  ) {
    const queryStartTime = Date.now();

    try {
      const {
        radiusKm = 50,
        limit = 1000,
        orderBy = 'timestamp',
        orderDirection = 'DESC',
        includeMetadata = false,
      } = options;

      // Convert radius to degrees (approximate)
      const radiusDegrees = radiusKm / 111; // 1 degree ≈ 111 km

      const query = `
                SELECT ${includeMetadata ? '*' : 'id, data_id, timestamp, latitude, longitude, station_id, temperature, humidity, pressure, wind_speed, wind_direction, precipitation, source_type'}
                FROM weather_data
                WHERE 
                    timestamp >= $3 
                    AND timestamp <= $4
                    AND ABS(latitude::float - $1) <= $5
                    AND ABS(longitude::float - $2) <= $5
                ORDER BY ${orderBy} ${orderDirection}
                LIMIT $6
            `;

      const result = await this.dbAdapter.rawQuery(query, [
        latitude,
        longitude,
        startTime,
        endTime,
        radiusDegrees,
        limit,
      ]);

      this.updateMetrics(Date.now() - queryStartTime, true);

      return result;
    } catch (error) {
      this.updateMetrics(Date.now() - queryStartTime, false);
      this.logger.error(
        'Error getting weather data by location and time:',
        error
      );
      throw error;
    }
  }

  /**
   * Get weather data by station ID
   */
  async getWeatherDataByStation(stationId, options = {}) {
    const startTime = Date.now();

    try {
      const {
        limit = 100,
        startTime: queryStartTime,
        endTime: queryEndTime,
        orderBy = 'timestamp',
        orderDirection = 'DESC',
      } = options;

      let query = `
                SELECT * FROM weather_data
                WHERE station_id = $1
            `;

      const params = [stationId];

      if (queryStartTime) {
        query += ` AND timestamp >= $${params.length + 1}`;
        params.push(queryStartTime);
      }

      if (queryEndTime) {
        query += ` AND timestamp <= $${params.length + 1}`;
        params.push(queryEndTime);
      }

      query += ` ORDER BY ${orderBy} ${orderDirection} LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await this.dbAdapter.rawQuery(query, params);

      this.updateMetrics(Date.now() - startTime, true);

      return result;
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error getting weather data by station:', error);
      throw error;
    }
  }

  /**
   * Update weather data verification status
   */
  async updateVerificationStatus(dataId, status, verifierInfo = null) {
    const startTime = Date.now();

    try {
      const updateData = {
        verificationStatus: status,
        ...(verifierInfo && { verifiers: verifierInfo }),
      };

      const result = await this.dbAdapter.update(
        this.schema.weatherData,
        { dataId },
        updateData
      );

      this.updateMetrics(Date.now() - startTime, true);

      return result[0] || null;
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error updating verification status:', error);
      throw error;
    }
  }

  /**
   * Get weather data statistics
   */
  async getWeatherDataStats(options = {}) {
    const startTime = Date.now();

    try {
      const {
        startTime: queryStartTime,
        endTime: queryEndTime,
        stationId,
        sourceType,
      } = options;

      let whereClause = 'WHERE 1=1';
      const params = [];

      if (queryStartTime) {
        whereClause += ` AND timestamp >= $${params.length + 1}`;
        params.push(queryStartTime);
      }

      if (queryEndTime) {
        whereClause += ` AND timestamp <= $${params.length + 1}`;
        params.push(queryEndTime);
      }

      if (stationId) {
        whereClause += ` AND station_id = $${params.length + 1}`;
        params.push(stationId);
      }

      if (sourceType) {
        whereClause += ` AND source_type = $${params.length + 1}`;
        params.push(sourceType);
      }

      const query = `
                SELECT 
                    COUNT(*) as total_records,
                    COUNT(DISTINCT station_id) as unique_stations,
                    COUNT(DISTINCT source_type) as unique_sources,
                    MIN(timestamp) as earliest_record,
                    MAX(timestamp) as latest_record,
                    AVG(CASE WHEN temperature IS NOT NULL THEN (temperature::json->>'value')::float END) as avg_temperature,
                    AVG(CASE WHEN humidity IS NOT NULL THEN (humidity::json->>'value')::float END) as avg_humidity,
                    AVG(CASE WHEN pressure IS NOT NULL THEN (pressure::json->>'value')::float END) as avg_pressure,
                    COUNT(CASE WHEN verification_status = 'verified' THEN 1 END) as verified_records,
                    COUNT(CASE WHEN verification_status = 'pending' THEN 1 END) as pending_records,
                    COUNT(CASE WHEN verification_status = 'failed' THEN 1 END) as failed_records
                FROM weather_data
                ${whereClause}
            `;

      const result = await this.dbAdapter.rawQuery(query, params);

      this.updateMetrics(Date.now() - startTime, true);

      return result[0];
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error getting weather data statistics:', error);
      throw error;
    }
  }

  /**
   * Clean up old weather data
   */
  async cleanupOldData(olderThanDays = 365) {
    const startTime = Date.now();

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const query = `
                DELETE FROM weather_data 
                WHERE timestamp < $1 AND verification_status != 'verified'
                RETURNING COUNT(*)
            `;

      const result = await this.dbAdapter.rawQuery(query, [
        cutoffDate.toISOString(),
      ]);

      this.updateMetrics(Date.now() - startTime, true);
      this.logger.info(
        `Cleaned up old weather data: ${result[0]?.count || 0} records deleted`
      );

      return result[0]?.count || 0;
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error cleaning up old data:', error);
      throw error;
    }
  }

  /**
   * Validate weather data structure
   */
  validateWeatherData(data) {
    const required = [
      'data_id',
      'timestamp',
      'latitude',
      'longitude',
      'source_type',
    ];

    for (const field of required) {
      if (!data[field]) {
        throw new Error(`Required field missing: ${field}`);
      }
    }

    // Validate data types
    if (typeof data.latitude !== 'string' || isNaN(parseFloat(data.latitude))) {
      throw new Error('Invalid latitude format');
    }

    if (
      typeof data.longitude !== 'string' ||
      isNaN(parseFloat(data.longitude))
    ) {
      throw new Error('Invalid longitude format');
    }

    // Validate ranges
    const lat = parseFloat(data.latitude);
    const lon = parseFloat(data.longitude);

    if (lat < -90 || lat > 90) {
      throw new Error('Latitude must be between -90 and 90');
    }

    if (lon < -180 || lon > 180) {
      throw new Error('Longitude must be between -180 and 180');
    }

    // Validate timestamp
    const timestamp = new Date(data.timestamp);
    if (isNaN(timestamp.getTime())) {
      throw new Error('Invalid timestamp format');
    }

    // Validate JSON fields if present
    const jsonFields = [
      'temperature',
      'humidity',
      'pressure',
      'wind_speed',
      'wind_direction',
      'precipitation',
      'metadata',
      'verifiers',
    ];

    for (const field of jsonFields) {
      if (data[field] && typeof data[field] === 'string') {
        try {
          JSON.parse(data[field]);
        } catch (error) {
          throw new Error(`Invalid JSON format in field: ${field}`);
        }
      }
    }
  }

  /**
   * Check database connection health
   */
  async checkHealth() {
    try {
      const startTime = Date.now();
      await this.pool.query('SELECT 1');
      const responseTime = Date.now() - startTime;

      return {
        status: 'healthy',
        responseTime,
        isConnected: this.isConnected,
        metrics: this.getMetrics(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        isConnected: false,
      };
    }
  }

  /**
   * Update performance metrics
   */
  updateMetrics(queryTime, success) {
    this.metrics.totalQueries++;
    this.metrics.totalQueryTime += queryTime;
    this.metrics.averageQueryTime =
      this.metrics.totalQueryTime / this.metrics.totalQueries;
    this.metrics.lastQueryAt = new Date().toISOString();

    if (success) {
      this.metrics.successfulQueries++;
    } else {
      this.metrics.failedQueries++;
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate:
        this.metrics.totalQueries > 0
          ? this.metrics.successfulQueries / this.metrics.totalQueries
          : 0,
      failureRate:
        this.metrics.totalQueries > 0
          ? this.metrics.failedQueries / this.metrics.totalQueries
          : 0,
    };
  }

  /**
   * Execute custom query with error handling
   */
  async executeQuery(query, params = []) {
    const startTime = Date.now();

    try {
      const result = await this.dbAdapter.rawQuery(query, params);
      this.updateMetrics(Date.now() - startTime, true);
      return result;
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      this.logger.error('Error executing custom query:', error);
      throw error;
    }
  }

  // Transaction helpers (begin/commit/rollback) were removed: they had no callers
  // and used the pool.connect() client. Use database/db.ts `pool.connect()` (a
  // reserved connection) or executeTransaction() from database/connection.ts.

  /**
   * Utility delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { DatabaseManager };
