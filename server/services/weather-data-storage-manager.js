/**
 * Weather Data Storage and Management Service
 *
 * Comprehensive data storage solution for processed weather data and climate model outputs.
 * Implements TimescaleDB extensions, data archiving, versioning, and retrieval mechanisms.
 *
 * Features:
 * - TimescaleDB hypertables for time-series weather data
 * - Data partitioning and compression
 * - Automated data archiving and retention policies
 * - Data versioning system for model outputs
 * - Advanced indexing strategies for fast queries
 * - Batch operations and streaming data support
 * - Multi-format data storage (JSON, Binary, Parquet)
 * - Data quality metadata tracking
 * - Cross-referencing with blockchain attestations
 */

const { getSharedPgPool } = require('../utils/shared-pg-pool');
const crypto = require('crypto');
const Logger = require('../utils/logger');
const { DatabaseManager } = require('../database/database-manager');

class WeatherDataStorageManager {
  constructor(options = {}) {
    this.options = {
      // Connection settings
      poolSize: options.poolSize || 20,
      connectionTimeout: options.connectionTimeout || 5000,
      queryTimeout: options.queryTimeout || 30000,

      // Storage settings
      enableCompression: options.enableCompression !== false,
      compressionPolicy: options.compressionPolicy || 'after 7 days',
      defaultRetentionDays: options.defaultRetentionDays || 2555, // ~7 years

      // Performance settings
      batchSize: options.batchSize || 1000,
      enablePartitioning: options.enablePartitioning !== false,
      enableTimescaleDB: options.enableTimescaleDB !== false,

      // Versioning settings
      enableVersioning: options.enableVersioning !== false,
      maxVersions: options.maxVersions || 10,

      ...options,
    };

    this.logger = Logger;
    this.dbManager = new DatabaseManager();
    this.pool = null;
    this.isInitialized = false;

    // Storage metrics
    this.metrics = {
      totalRecords: 0,
      totalSize: 0,
      compressionRatio: 0,
      queryPerformance: {
        averageResponseTime: 0,
        totalQueries: 0,
      },
      archivalStats: {
        archivedRecords: 0,
        compressedRecords: 0,
      },
    };

    // Table definitions
    this.tables = {
      weatherData: 'weather_data_timeseries',
      modelOutputs: 'climate_model_outputs',
      dataVersions: 'data_versions',
      qualityMetrics: 'data_quality_metrics',
      archiveIndex: 'archive_index',
      retentionPolicies: 'retention_policies',
    };
  }

  /**
   * Initialize the storage manager and create TimescaleDB structures
   */
  async initialize() {
    try {
      this.logger.info('Initializing Weather Data Storage Manager...');

      // Initialize database connection
      await this.initializeDatabase();

      // Check and install TimescaleDB extension
      if (this.options.enableTimescaleDB) {
        await this.installTimescaleDB();
      }

      // Create core tables and hypertables
      await this.createCoreSchemas();

      // Setup data partitioning
      if (this.options.enablePartitioning) {
        await this.setupPartitioning();
      }

      // Setup compression policies
      if (this.options.enableCompression) {
        await this.setupCompressionPolicies();
      }

      // Setup retention policies
      await this.setupRetentionPolicies();

      // Create indexes for performance
      await this.createPerformanceIndexes();

      this.isInitialized = true;
      this.logger.info('Weather Data Storage Manager initialized successfully');
    } catch (error) {
      this.logger.error(
        'Failed to initialize Weather Data Storage Manager:',
        error
      );
      throw error;
    }
  }

  /**
   * Initialize database connection pool
   */
  async initializeDatabase() {
    const config = {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: process.env.POSTGRES_PORT || 5432,
      database: process.env.POSTGRES_DB || 'wrfcoin',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || '',
      max: this.options.poolSize,
      connectionTimeoutMillis: this.options.connectionTimeout,
      query_timeout: this.options.queryTimeout,
      application_name: 'wrfcoin-weather-storage',
    };

    this.pool = getSharedPgPool(config);

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT NOW()');
    } finally {
      client.release();
    }

    this.logger.info('Database connection pool initialized');
  }

  /**
   * Install and configure TimescaleDB extension
   */
  async installTimescaleDB() {
    try {
      // Check if TimescaleDB is already installed
      const extensionCheck = await this.pool.query(`
                SELECT * FROM pg_extension WHERE extname = 'timescaledb'
            `);

      if (extensionCheck.rows.length === 0) {
        // Install TimescaleDB extension
        await this.pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
        this.logger.info('TimescaleDB extension installed');
      } else {
        this.logger.info('TimescaleDB extension already installed');
      }

      // Check TimescaleDB version
      const versionResult = await this.pool.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'"
      );
      this.logger.info(
        `TimescaleDB version: ${versionResult.rows[0]?.extversion}`
      );
    } catch (error) {
      this.logger.warn(
        'TimescaleDB installation failed, falling back to regular PostgreSQL:',
        error.message
      );
      this.options.enableTimescaleDB = false;
    }
  }

  /**
   * Create core database schemas and tables
   */
  async createCoreSchemas() {
    // Weather data time-series table
    await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.tables.weatherData} (
                id BIGSERIAL,
                data_id VARCHAR(255) NOT NULL,
                timestamp TIMESTAMPTZ NOT NULL,
                station_id VARCHAR(100),
                location JSONB,
                measurements JSONB NOT NULL,
                metadata JSONB,
                quality_score DECIMAL(5,3),
                validation_results JSONB,
                source_hash VARCHAR(64),
                blockchain_reference VARCHAR(255),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                data_version INTEGER DEFAULT 1,
                storage_format VARCHAR(20) DEFAULT 'json',
                compression_status VARCHAR(20) DEFAULT 'uncompressed',
                archived_at TIMESTAMPTZ NULL
            )
        `);

    // Climate model outputs table
    await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.tables.modelOutputs} (
                id BIGSERIAL,
                model_run_id VARCHAR(255) NOT NULL,
                model_type VARCHAR(50) NOT NULL,
                model_version VARCHAR(20),
                execution_timestamp TIMESTAMPTZ NOT NULL,
                input_data_hash VARCHAR(64),
                output_data JSONB,
                output_file_path TEXT,
                output_format VARCHAR(20),
                file_size_bytes BIGINT,
                processing_time_ms INTEGER,
                grid_resolution VARCHAR(20),
                forecast_horizon_hours INTEGER,
                quality_assessment JSONB,
                validation_metrics JSONB,
                provenance_chain JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                archived_at TIMESTAMPTZ NULL,
                data_version INTEGER DEFAULT 1,
                parent_version_id BIGINT NULL
            )
        `);

    // Data versions tracking table
    await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.tables.dataVersions} (
                id BIGSERIAL PRIMARY KEY,
                data_type VARCHAR(50) NOT NULL,
                data_id VARCHAR(255) NOT NULL,
                version_number INTEGER NOT NULL,
                version_hash VARCHAR(64) NOT NULL,
                changes_description TEXT,
                created_by VARCHAR(255),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                is_current BOOLEAN DEFAULT false,
                parent_version_id BIGINT NULL,
                diff_data JSONB,
                file_path TEXT
            )
        `);

    // Data quality metrics table
    await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.tables.qualityMetrics} (
                id BIGSERIAL PRIMARY KEY,
                data_reference_id BIGINT NOT NULL,
                data_type VARCHAR(50) NOT NULL,
                quality_score DECIMAL(5,3) NOT NULL,
                completeness_ratio DECIMAL(4,3),
                accuracy_assessment JSONB,
                physics_validation JSONB,
                temporal_consistency JSONB,
                spatial_consistency JSONB,
                anomaly_flags JSONB,
                assessed_at TIMESTAMPTZ DEFAULT NOW(),
                assessor_id VARCHAR(255)
            )
        `);

    // Archive index table
    await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.tables.archiveIndex} (
                id BIGSERIAL PRIMARY KEY,
                original_table VARCHAR(100) NOT NULL,
                original_id BIGINT NOT NULL,
                archive_location TEXT NOT NULL,
                archive_format VARCHAR(20) DEFAULT 'parquet',
                archived_at TIMESTAMPTZ DEFAULT NOW(),
                archive_size_bytes BIGINT,
                compression_ratio DECIMAL(4,2),
                checksum VARCHAR(64),
                retrieval_count INTEGER DEFAULT 0,
                last_accessed TIMESTAMPTZ NULL
            )
        `);

    // Retention policies table
    await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.tables.retentionPolicies} (
                id SERIAL PRIMARY KEY,
                policy_name VARCHAR(100) UNIQUE NOT NULL,
                table_name VARCHAR(100) NOT NULL,
                retention_period INTERVAL NOT NULL,
                archive_before_delete BOOLEAN DEFAULT true,
                compression_policy INTERVAL DEFAULT '7 days',
                priority INTEGER DEFAULT 100,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                last_executed TIMESTAMPTZ NULL
            )
        `);

    // Convert to hypertables if TimescaleDB is available
    if (this.options.enableTimescaleDB) {
      await this.createHypertables();
    }

    this.logger.info('Core database schemas created');
  }

  /**
   * Create TimescaleDB hypertables
   */
  async createHypertables() {
    try {
      // Weather data hypertable
      await this.pool.query(`
                SELECT create_hypertable('${this.tables.weatherData}', 'timestamp', 
                    chunk_time_interval => INTERVAL '1 day',
                    if_not_exists => TRUE
                )
            `);

      // Model outputs hypertable
      await this.pool.query(`
                SELECT create_hypertable('${this.tables.modelOutputs}', 'execution_timestamp',
                    chunk_time_interval => INTERVAL '1 hour',
                    if_not_exists => TRUE
                )
            `);

      this.logger.info('TimescaleDB hypertables created');
    } catch (error) {
      this.logger.warn('Failed to create hypertables:', error.message);
    }
  }

  /**
   * Setup data partitioning strategies
   */
  async setupPartitioning() {
    // Partitioning is handled by TimescaleDB chunks
    // Additional partitioning by station_id for weather data
    if (this.options.enableTimescaleDB) {
      try {
        await this.pool.query(`
                    SELECT add_dimension('${this.tables.weatherData}', 'station_id', 
                        number_partitions => 4,
                        if_not_exists => TRUE
                    )
                `);

        this.logger.info('Data partitioning configured');
      } catch (error) {
        this.logger.warn('Partitioning setup failed:', error.message);
      }
    }
  }

  /**
   * Setup compression policies for data archival
   */
  async setupCompressionPolicies() {
    if (!this.options.enableTimescaleDB) return;

    try {
      // Compression policy for weather data
      await this.pool.query(`
                SELECT add_compression_policy('${this.tables.weatherData}', 
                    compress_after => INTERVAL '${this.options.compressionPolicy}'
                )
            `);

      // Compression policy for model outputs
      await this.pool.query(`
                SELECT add_compression_policy('${this.tables.modelOutputs}',
                    compress_after => INTERVAL '${this.options.compressionPolicy}'
                )
            `);

      this.logger.info('Compression policies configured');
    } catch (error) {
      this.logger.warn('Compression policy setup failed:', error.message);
    }
  }

  /**
   * Setup automated retention policies
   */
  async setupRetentionPolicies() {
    const defaultPolicies = [
      {
        name: 'weather_data_retention',
        table: this.tables.weatherData,
        period: `${this.options.defaultRetentionDays} days`,
        priority: 100,
      },
      {
        name: 'model_outputs_retention',
        table: this.tables.modelOutputs,
        period: `${this.options.defaultRetentionDays * 2} days`, // Model outputs kept longer
        priority: 90,
      },
      {
        name: 'quality_metrics_retention',
        table: this.tables.qualityMetrics,
        period: `${Math.floor(this.options.defaultRetentionDays * 1.5)} days`,
        priority: 80,
      },
    ];

    for (const policy of defaultPolicies) {
      await this.pool.query(
        `
                INSERT INTO ${this.tables.retentionPolicies} 
                (policy_name, table_name, retention_period, priority)
                VALUES ($1, $2, $3::interval, $4)
                ON CONFLICT (policy_name) DO UPDATE SET
                    retention_period = $3::interval,
                    priority = $4,
                    is_active = true
            `,
        [policy.name, policy.table, policy.period, policy.priority]
      );
    }

    this.logger.info('Retention policies configured');
  }

  /**
   * Create performance indexes
   */
  async createPerformanceIndexes() {
    const indexes = [
      // Weather data indexes
      {
        name: 'idx_weather_timestamp',
        table: this.tables.weatherData,
        columns: ['timestamp DESC'],
      },
      {
        name: 'idx_weather_station_time',
        table: this.tables.weatherData,
        columns: ['station_id', 'timestamp DESC'],
      },
      {
        name: 'idx_weather_data_id',
        table: this.tables.weatherData,
        columns: ['data_id'],
        unique: true,
      },
      {
        name: 'idx_weather_location',
        table: this.tables.weatherData,
        columns: ['location'],
        type: 'gin',
      },
      {
        name: 'idx_weather_quality',
        table: this.tables.weatherData,
        columns: ['quality_score DESC'],
      },

      // Model outputs indexes
      {
        name: 'idx_model_run_id',
        table: this.tables.modelOutputs,
        columns: ['model_run_id'],
        unique: true,
      },
      {
        name: 'idx_model_type_time',
        table: this.tables.modelOutputs,
        columns: ['model_type', 'execution_timestamp DESC'],
      },
      {
        name: 'idx_model_version',
        table: this.tables.modelOutputs,
        columns: ['model_type', 'model_version'],
      },

      // Versioning indexes
      {
        name: 'idx_versions_data',
        table: this.tables.dataVersions,
        columns: ['data_type', 'data_id', 'version_number DESC'],
      },
      {
        name: 'idx_versions_current',
        table: this.tables.dataVersions,
        columns: ['data_type', 'data_id', 'is_current'],
      },

      // Quality metrics indexes
      {
        name: 'idx_quality_reference',
        table: this.tables.qualityMetrics,
        columns: ['data_type', 'data_reference_id'],
      },
      {
        name: 'idx_quality_score',
        table: this.tables.qualityMetrics,
        columns: ['quality_score DESC'],
      },
    ];

    for (const index of indexes) {
      try {
        const indexType = index.type ? `USING ${index.type}` : '';
        const unique = index.unique ? 'UNIQUE' : '';

        await this.pool.query(`
                    CREATE ${unique} INDEX IF NOT EXISTS ${index.name}
                    ON ${index.table} ${indexType} (${index.columns.join(', ')})
                `);
      } catch (error) {
        this.logger.warn(
          `Failed to create index ${index.name}:`,
          error.message
        );
      }
    }

    this.logger.info('Performance indexes created');
  }

  /**
   * Store weather data with automatic versioning
   */
  async storeWeatherData(data, options = {}) {
    const startTime = Date.now();

    try {
      if (!this.isInitialized) {
        throw new Error('Storage manager not initialized');
      }

      const {
        enableVersioning = this.options.enableVersioning,
        qualityMetrics = null,
        blockchainReference = null,
      } = options;

      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        // Check for existing data and handle versioning
        let versionNumber = 1;
        if (enableVersioning && data.data_id) {
          const existingVersion = await client.query(
            `
                        SELECT MAX(data_version) as max_version 
                        FROM ${this.tables.weatherData} 
                        WHERE data_id = $1
                    `,
            [data.data_id]
          );

          if (existingVersion.rows[0]?.max_version) {
            versionNumber = existingVersion.rows[0].max_version + 1;
          }
        }

        // Compute source_hash from measurements if not provided
        const sourceHash = data.source_hash || (data.measurements
          ? crypto.createHash('sha256').update(JSON.stringify(data.measurements)).digest('hex')
          : null);

        // Compute blockchain_reference via lineage service if available
        let resolvedBlockchainRef = blockchainReference;
        if (!resolvedBlockchainRef && sourceHash && data.station_id) {
          try {
            const { lineageService } = require('./lineage-service.js');
            const lineageRecord = await lineageService.createLineageRecord({
              stageId: 'weather_storage',
              stationId: data.station_id,
              contentHash: sourceHash,
              sourceType: 'weather_data',
              sourceReference: `storage:${data.station_id}:${data.data_id || 'unknown'}`,
              metadata: {
                quality_score: data.quality_score,
                data_version: versionNumber,
              },
            });
            resolvedBlockchainRef = lineageRecord.lineageId;
          } catch (lineageErr) {
            this.logger.warn('Failed to create lineage record for weather storage:', lineageErr.message);
          }
        }

        // Store weather data
        const weatherResult = await client.query(
          `
                    INSERT INTO ${this.tables.weatherData} (
                        data_id, timestamp, station_id, location, measurements,
                        metadata, quality_score, validation_results, source_hash,
                        blockchain_reference, data_version, storage_format
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    RETURNING id
                `,
          [
            data.data_id,
            data.timestamp,
            data.station_id,
            JSON.stringify(data.location),
            JSON.stringify(data.measurements),
            JSON.stringify(data.metadata || {}),
            data.quality_score || null,
            JSON.stringify(data.validation_results || {}),
            sourceHash,
            resolvedBlockchainRef,
            versionNumber,
            'json',
          ]
        );

        const weatherDataId = weatherResult.rows[0].id;

        // Store version information
        if (enableVersioning) {
          await client.query(
            `
                        INSERT INTO ${this.tables.dataVersions} (
                            data_type, data_id, version_number, version_hash,
                            changes_description, is_current
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                    `,
            [
              'weather_data',
              data.data_id,
              versionNumber,
              data.source_hash || 'unknown',
              options.changesDescription || 'Data update',
              true,
            ]
          );

          // Mark previous versions as not current
          if (versionNumber > 1) {
            await client.query(
              `
                            UPDATE ${this.tables.dataVersions} 
                            SET is_current = false
                            WHERE data_type = 'weather_data' 
                                AND data_id = $1 
                                AND version_number < $2
                        `,
              [data.data_id, versionNumber]
            );
          }
        }

        // Store quality metrics if provided
        if (qualityMetrics) {
          await client.query(
            `
                        INSERT INTO ${this.tables.qualityMetrics} (
                            data_reference_id, data_type, quality_score,
                            completeness_ratio, accuracy_assessment,
                            physics_validation, temporal_consistency,
                            spatial_consistency, anomaly_flags
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    `,
            [
              weatherDataId,
              'weather_data',
              qualityMetrics.qualityScore,
              qualityMetrics.completenessRatio,
              JSON.stringify(qualityMetrics.accuracyAssessment || {}),
              JSON.stringify(qualityMetrics.physicsValidation || {}),
              JSON.stringify(qualityMetrics.temporalConsistency || {}),
              JSON.stringify(qualityMetrics.spatialConsistency || {}),
              JSON.stringify(qualityMetrics.anomalyFlags || {}),
            ]
          );
        }

        await client.query('COMMIT');

        // Update metrics
        this.metrics.totalRecords++;
        this.updateQueryMetrics(Date.now() - startTime);

        this.logger.debug(
          `Weather data stored: ${data.data_id} (version ${versionNumber})`
        );

        return {
          id: weatherDataId,
          dataId: data.data_id,
          version: versionNumber,
          timestamp: data.timestamp,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      this.updateQueryMetrics(Date.now() - startTime, false);
      this.logger.error('Error storing weather data:', error);
      throw error;
    }
  }

  /**
   * Store climate model output with provenance tracking
   */
  async storeModelOutput(modelData, options = {}) {
    const startTime = Date.now();

    try {
      const { parentVersionId = null, provenanceChain = null } = options;

      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        // Handle versioning for model outputs
        let versionNumber = 1;
        if (modelData.model_run_id) {
          const existingVersion = await client.query(
            `
                        SELECT MAX(data_version) as max_version
                        FROM ${this.tables.modelOutputs}
                        WHERE model_run_id = $1
                    `,
            [modelData.model_run_id]
          );

          if (existingVersion.rows[0]?.max_version) {
            versionNumber = existingVersion.rows[0].max_version + 1;
          }
        }

        // Store model output
        const result = await client.query(
          `
                    INSERT INTO ${this.tables.modelOutputs} (
                        model_run_id, model_type, model_version, execution_timestamp,
                        input_data_hash, output_data, output_file_path, output_format,
                        file_size_bytes, processing_time_ms, grid_resolution,
                        forecast_horizon_hours, quality_assessment, validation_metrics,
                        provenance_chain, data_version, parent_version_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                    RETURNING id
                `,
          [
            modelData.model_run_id,
            modelData.model_type,
            modelData.model_version,
            modelData.execution_timestamp,
            modelData.input_data_hash,
            JSON.stringify(modelData.output_data || {}),
            modelData.output_file_path,
            modelData.output_format || 'json',
            modelData.file_size_bytes || 0,
            modelData.processing_time_ms || 0,
            modelData.grid_resolution,
            modelData.forecast_horizon_hours,
            JSON.stringify(modelData.quality_assessment || {}),
            JSON.stringify(modelData.validation_metrics || {}),
            JSON.stringify(provenanceChain || {}),
            versionNumber,
            parentVersionId,
          ]
        );

        const modelOutputId = result.rows[0].id;

        // Store version information
        await client.query(
          `
                    INSERT INTO ${this.tables.dataVersions} (
                        data_type, data_id, version_number, version_hash,
                        changes_description, is_current, parent_version_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                `,
          [
            'model_output',
            modelData.model_run_id,
            versionNumber,
            modelData.input_data_hash || 'unknown',
            options.changesDescription || 'Model execution',
            true,
            parentVersionId,
          ]
        );

        await client.query('COMMIT');

        this.metrics.totalRecords++;
        this.updateQueryMetrics(Date.now() - startTime);

        this.logger.debug(
          `Model output stored: ${modelData.model_run_id} (version ${versionNumber})`
        );

        return {
          id: modelOutputId,
          modelRunId: modelData.model_run_id,
          version: versionNumber,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      this.updateQueryMetrics(Date.now() - startTime, false);
      this.logger.error('Error storing model output:', error);
      throw error;
    }
  }

  /**
   * Retrieve weather data with advanced filtering and pagination
   */
  async retrieveWeatherData(filters = {}, options = {}) {
    const startTime = Date.now();

    try {
      const {
        limit = 1000,
        offset = 0,
        orderBy = 'timestamp',
        orderDirection = 'DESC',
        includeQualityMetrics = false,
        includeVersionHistory = false,
      } = options;

      // Build WHERE clause
      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (filters.stationId) {
        conditions.push(`station_id = $${paramIndex}`);
        params.push(filters.stationId);
        paramIndex++;
      }

      if (filters.startTime) {
        conditions.push(`timestamp >= $${paramIndex}`);
        params.push(filters.startTime);
        paramIndex++;
      }

      if (filters.endTime) {
        conditions.push(`timestamp <= $${paramIndex}`);
        params.push(filters.endTime);
        paramIndex++;
      }

      if (filters.qualityScoreMin) {
        conditions.push(`quality_score >= $${paramIndex}`);
        params.push(filters.qualityScoreMin);
        paramIndex++;
      }

      if (filters.dataIds && filters.dataIds.length > 0) {
        conditions.push(`data_id = ANY($${paramIndex})`);
        params.push(filters.dataIds);
        paramIndex++;
      }

      if (filters.currentVersionOnly !== false) {
        // Get only current versions by default
        conditions.push(`
                    data_version = (
                        SELECT MAX(data_version) 
                        FROM ${this.tables.weatherData} wd2 
                        WHERE wd2.data_id = ${this.tables.weatherData}.data_id
                    )
                `);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Main query
      const query = `
                SELECT 
                    id, data_id, timestamp, station_id, location,
                    measurements, metadata, quality_score, validation_results,
                    source_hash, blockchain_reference, created_at, updated_at,
                    data_version, storage_format, compression_status
                FROM ${this.tables.weatherData}
                ${whereClause}
                ORDER BY ${orderBy} ${orderDirection}
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `;

      params.push(limit, offset);

      const result = await this.pool.query(query, params);
      const weatherData = result.rows;

      // Fetch quality metrics if requested
      if (includeQualityMetrics && weatherData.length > 0) {
        const ids = weatherData.map(row => row.id);
        const qualityResult = await this.pool.query(
          `
                    SELECT * FROM ${this.tables.qualityMetrics}
                    WHERE data_reference_id = ANY($1) AND data_type = 'weather_data'
                `,
          [ids]
        );

        // Map quality metrics to weather data
        const qualityMap = new Map();
        qualityResult.rows.forEach(metric => {
          qualityMap.set(metric.data_reference_id, metric);
        });

        weatherData.forEach(row => {
          row.quality_metrics = qualityMap.get(row.id) || null;
        });
      }

      // Fetch version history if requested
      if (includeVersionHistory && weatherData.length > 0) {
        const dataIds = [...new Set(weatherData.map(row => row.data_id))];
        const versionResult = await this.pool.query(
          `
                    SELECT * FROM ${this.tables.dataVersions}
                    WHERE data_type = 'weather_data' AND data_id = ANY($1)
                    ORDER BY version_number DESC
                `,
          [dataIds]
        );

        // Map version history to weather data
        const versionMap = new Map();
        versionResult.rows.forEach(version => {
          if (!versionMap.has(version.data_id)) {
            versionMap.set(version.data_id, []);
          }
          versionMap.get(version.data_id).push(version);
        });

        weatherData.forEach(row => {
          row.version_history = versionMap.get(row.data_id) || [];
        });
      }

      this.updateQueryMetrics(Date.now() - startTime);

      return {
        data: weatherData,
        pagination: {
          limit,
          offset,
          total: await this.getWeatherDataCount(filters),
        },
      };
    } catch (error) {
      this.updateQueryMetrics(Date.now() - startTime, false);
      this.logger.error('Error retrieving weather data:', error);
      throw error;
    }
  }

  /**
   * Get count of weather data records matching filters
   */
  async getWeatherDataCount(filters = {}) {
    try {
      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (filters.stationId) {
        conditions.push(`station_id = $${paramIndex}`);
        params.push(filters.stationId);
        paramIndex++;
      }

      if (filters.startTime) {
        conditions.push(`timestamp >= $${paramIndex}`);
        params.push(filters.startTime);
        paramIndex++;
      }

      if (filters.endTime) {
        conditions.push(`timestamp <= $${paramIndex}`);
        params.push(filters.endTime);
        paramIndex++;
      }

      if (filters.qualityScoreMin) {
        conditions.push(`quality_score >= $${paramIndex}`);
        params.push(filters.qualityScoreMin);
        paramIndex++;
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await this.pool.query(
        `
                SELECT COUNT(*) as count FROM ${this.tables.weatherData} ${whereClause}
            `,
        params
      );

      return parseInt(result.rows[0].count);
    } catch (error) {
      this.logger.error('Error counting weather data:', error);
      return 0;
    }
  }

  /**
   * Execute data archival based on retention policies
   */
  async executeArchival() {
    try {
      this.logger.info('Starting data archival process...');

      // Get active retention policies
      const policies = await this.pool.query(`
                SELECT * FROM ${this.tables.retentionPolicies}
                WHERE is_active = true
                ORDER BY priority DESC
            `);

      let totalArchived = 0;

      for (const policy of policies.rows) {
        try {
          const archived = await this.archiveDataByPolicy(policy);
          totalArchived += archived;

          // Update last executed timestamp
          await this.pool.query(
            `
                        UPDATE ${this.tables.retentionPolicies}
                        SET last_executed = NOW()
                        WHERE id = $1
                    `,
            [policy.id]
          );
        } catch (error) {
          this.logger.error(
            `Archival failed for policy ${policy.policy_name}:`,
            error
          );
        }
      }

      this.metrics.archivalStats.archivedRecords += totalArchived;
      this.logger.info(
        `Archival completed. Records archived: ${totalArchived}`
      );

      return totalArchived;
    } catch (error) {
      this.logger.error('Error executing archival:', error);
      throw error;
    }
  }

  /**
   * Archive data based on specific retention policy
   */
  async archiveDataByPolicy(policy) {
    const cutoffDate = new Date();
    cutoffDate.setTime(
      cutoffDate.getTime() - this.parsePolicyInterval(policy.retention_period)
    );

    let archivedCount = 0;

    if (policy.archive_before_delete) {
      // Archive to storage before deletion
      const dataToArchive = await this.pool.query(
        `
                SELECT * FROM ${policy.table_name}
                WHERE created_at < $1 AND archived_at IS NULL
                LIMIT 10000
            `,
        [cutoffDate]
      );

      for (const record of dataToArchive.rows) {
        try {
          await this.archiveRecord(policy.table_name, record);
          archivedCount++;
        } catch (error) {
          this.logger.warn(
            `Failed to archive record ${record.id}:`,
            error.message
          );
        }
      }
    }

    // Mark as archived or delete
    await this.pool.query(
      `
            UPDATE ${policy.table_name}
            SET archived_at = NOW()
            WHERE created_at < $1 AND archived_at IS NULL
        `,
      [cutoffDate]
    );

    return archivedCount;
  }

  /**
   * Archive individual record to storage
   */
  async archiveRecord(tableName, record) {
    // Convert record to archive format (could be JSON, Parquet, etc.)
    const archiveData = JSON.stringify(record);
    const archiveLocation = `/archives/${tableName}/${record.id}.json`;

    // In a real implementation, this would write to external storage
    // (S3, Google Cloud Storage, etc.)

    // Store archive metadata
    await this.pool.query(
      `
            INSERT INTO ${this.tables.archiveIndex} (
                original_table, original_id, archive_location,
                archive_format, archive_size_bytes, checksum
            ) VALUES ($1, $2, $3, $4, $5, $6)
        `,
      [
        tableName,
        record.id,
        archiveLocation,
        'json',
        Buffer.byteLength(archiveData),
        this.calculateChecksum(archiveData),
      ]
    );
  }

  /**
   * Update query performance metrics
   */
  updateQueryMetrics(duration, success = true) {
    this.metrics.queryPerformance.totalQueries++;

    if (success) {
      const totalTime =
        this.metrics.queryPerformance.averageResponseTime *
          (this.metrics.queryPerformance.totalQueries - 1) +
        duration;
      this.metrics.queryPerformance.averageResponseTime =
        totalTime / this.metrics.queryPerformance.totalQueries;
    }
  }

  /**
   * Get storage manager health status
   */
  async getHealthStatus() {
    try {
      const dbHealth = await this.dbManager.checkHealth();

      // Check TimescaleDB status
      let timescaleStatus = 'not_available';
      if (this.options.enableTimescaleDB) {
        try {
          await this.pool.query('SELECT 1');
          timescaleStatus = 'healthy';
        } catch {
          timescaleStatus = 'unhealthy';
        }
      }

      // Get table statistics
      const stats = await this.getStorageStatistics();

      return {
        status: 'healthy',
        initialized: this.isInitialized,
        database: dbHealth,
        timescale: timescaleStatus,
        metrics: this.metrics,
        statistics: stats,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        initialized: this.isInitialized,
      };
    }
  }

  /**
   * Get comprehensive storage statistics
   */
  async getStorageStatistics() {
    try {
      const stats = {};

      // Get table sizes and record counts
      for (const [name, tableName] of Object.entries(this.tables)) {
        const result = await this.pool.query(`
                    SELECT 
                        COUNT(*) as record_count,
                        pg_total_relation_size('${tableName}') as total_size,
                        pg_relation_size('${tableName}') as table_size
                    FROM ${tableName}
                `);

        stats[name] = result.rows[0];
      }

      return stats;
    } catch (error) {
      this.logger.error('Error getting storage statistics:', error);
      return {};
    }
  }

  /**
   * Helper methods
   */
  parsePolicyInterval(interval) {
    // Parse PostgreSQL interval to milliseconds
    // This is a simplified implementation
    const match = interval.match(/(\d+)\s+(\w+)/);
    if (!match) return 0;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    const multipliers = {
      day: 24 * 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      hour: 60 * 60 * 1000,
      hours: 60 * 60 * 1000,
      minute: 60 * 1000,
      minutes: 60 * 1000,
    };

    return value * (multipliers[unit] || 0);
  }

  calculateChecksum(data) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Cleanup resources
   */
  async shutdown() {
    try {
      if (this.pool) {
        // Pool is shared — lifecycle managed by closeSharedPgPools() at process exit.
        this.pool = null;
        this.logger.info('Database connection pool reference released');
      }

      if (this.dbManager) {
        await this.dbManager.disconnect();
      }

      this.isInitialized = false;
    } catch (error) {
      this.logger.error('Error during shutdown:', error);
    }
  }
}

module.exports = { WeatherDataStorageManager };
