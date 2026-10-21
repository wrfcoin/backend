/**
 * Data Versioning Service for Model Outputs
 *
 * Comprehensive versioning system for climate model outputs with temporal tracking,
 * semantic versioning, rollback capabilities, and metadata management.
 *
 * Features:
 * - Semantic versioning for model outputs
 * - Branch and merge support for experimental models
 * - Temporal versioning with timestamps and metadata
 * - Delta-based storage for efficient space usage
 * - Rollback and restoration capabilities
 * - Version comparison and diff generation
 * - Model lineage tracking and provenance
 * - Integration with data storage manager
 */

const Logger = require('../utils/logger');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

// Compression utilities
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class DataVersioningService {
  constructor(options = {}) {
    this.options = {
      // Versioning strategy
      versioningStrategy: options.versioningStrategy || 'semantic', // 'semantic', 'timestamp', 'incremental'

      // Storage configuration
      enableDeltaCompression: options.enableDeltaCompression !== false,
      maxVersionsPerModel: options.maxVersionsPerModel || 50,
      enableBranching: options.enableBranching !== false,

      // Retention settings
      retentionPolicy: options.retentionPolicy || {
        major: '2 years', // Keep major versions for 2 years
        minor: '6 months', // Keep minor versions for 6 months
        patch: '1 month', // Keep patch versions for 1 month
        development: '1 week', // Keep dev versions for 1 week
      },

      // Performance settings
      enableAsyncVersioning: options.enableAsyncVersioning !== false,
      batchSize: options.batchSize || 100,
      enableVersionCache: options.enableVersionCache !== false,

      // Metadata settings
      trackMetadata: options.trackMetadata !== false,
      enableProvenance: options.enableProvenance !== false,

      ...options,
    };

    this.logger = Logger;
    this.storageManager = null; // Will be injected

    // Version cache for performance
    this.versionCache = new Map();

    // Branch management
    this.branches = new Map();
    this.activeBranch = 'main';

    // Versioning metrics
    this.metrics = {
      totalVersions: 0,
      activeVersions: 0,
      totalSize: 0,
      compressionRatio: 0,
      rollbackCount: 0,
      branchCount: 1, // Start with main branch
      deltaStorageSavings: 0,
    };

    // Version schema for different data types
    this.versionSchemas = {
      climate_model_output: {
        required: [
          'model_type',
          'model_version',
          'execution_timestamp',
          'output_data',
        ],
        metadata: [
          'input_parameters',
          'processing_time',
          'grid_resolution',
          'forecast_horizon',
        ],
      },
      weather_forecast: {
        required: [
          'forecast_timestamp',
          'forecast_data',
          'model_used',
          'confidence_score',
        ],
        metadata: [
          'weather_station_ids',
          'coverage_area',
          'temporal_resolution',
        ],
      },
      ai_model_weights: {
        required: ['model_architecture', 'weights_data', 'training_metadata'],
        metadata: [
          'training_dataset',
          'hyperparameters',
          'performance_metrics',
        ],
      },
    };
  }

  /**
   * Initialize the versioning service
   */
  async initialize(storageManager) {
    try {
      this.storageManager = storageManager;

      // Create versioning tables if they don't exist
      await this.createVersioningSchema();

      // Initialize branch tracking
      await this.initializeBranchTracking();

      // Load version cache
      if (this.options.enableVersionCache) {
        await this.loadVersionCache();
      }

      // Setup retention policy enforcement
      await this.setupRetentionPolicyEnforcement();

      this.logger.info('Data Versioning Service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Data Versioning Service:', error);
      throw error;
    }
  }

  /**
   * Create versioning database schema
   */
  async createVersioningSchema() {
    const versioningTables = [
      // Main version tracking table
      `CREATE TABLE IF NOT EXISTS data_versions (
                id SERIAL PRIMARY KEY,
                data_type VARCHAR(100) NOT NULL,
                data_id UUID NOT NULL,
                version_number VARCHAR(50) NOT NULL,
                branch_name VARCHAR(100) DEFAULT 'main',
                parent_version_id INTEGER REFERENCES data_versions(id),
                version_metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                created_by VARCHAR(255),
                is_active BOOLEAN DEFAULT true,
                storage_location TEXT NOT NULL,
                data_size_bytes BIGINT DEFAULT 0,
                is_delta BOOLEAN DEFAULT false,
                delta_base_version INTEGER REFERENCES data_versions(id),
                checksum VARCHAR(128),
                tags TEXT[],
                UNIQUE(data_type, data_id, version_number, branch_name)
            )`,

      // Branch management table
      `CREATE TABLE IF NOT EXISTS version_branches (
                id SERIAL PRIMARY KEY,
                branch_name VARCHAR(100) UNIQUE NOT NULL,
                parent_branch VARCHAR(100),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                created_by VARCHAR(255),
                description TEXT,
                is_active BOOLEAN DEFAULT true,
                last_commit_id INTEGER REFERENCES data_versions(id)
            )`,

      // Version lineage and provenance tracking
      `CREATE TABLE IF NOT EXISTS version_lineage (
                id SERIAL PRIMARY KEY,
                version_id INTEGER REFERENCES data_versions(id),
                source_type VARCHAR(50) NOT NULL, -- 'model_run', 'data_ingestion', 'manual_upload'
                source_reference TEXT,
                transformation_applied TEXT,
                lineage_metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`,

      // Version comparison and diff storage
      `CREATE TABLE IF NOT EXISTS version_diffs (
                id SERIAL PRIMARY KEY,
                from_version_id INTEGER REFERENCES data_versions(id),
                to_version_id INTEGER REFERENCES data_versions(id),
                diff_type VARCHAR(50) NOT NULL, -- 'binary', 'json', 'semantic'
                diff_data BYTEA,
                diff_metadata JSONB DEFAULT '{}',
                computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(from_version_id, to_version_id, diff_type)
            )`,

      // Model output version tracking
      `CREATE TABLE IF NOT EXISTS model_output_versions (
                id SERIAL PRIMARY KEY,
                model_run_id UUID NOT NULL,
                version_id INTEGER REFERENCES data_versions(id),
                model_type VARCHAR(100) NOT NULL,
                model_version VARCHAR(50) NOT NULL,
                input_data_hash VARCHAR(128),
                output_data_hash VARCHAR(128),
                execution_parameters JSONB DEFAULT '{}',
                performance_metrics JSONB DEFAULT '{}',
                validation_results JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`,
    ];

    for (const tableSQL of versioningTables) {
      try {
        await this.storageManager.pool.query(tableSQL);
        this.logger.debug('Created versioning table successfully');
      } catch (error) {
        this.logger.warn(
          'Table creation warning (may already exist):',
          error.message
        );
      }
    }

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_data_versions_type_id ON data_versions(data_type, data_id)',
      'CREATE INDEX IF NOT EXISTS idx_data_versions_branch ON data_versions(branch_name)',
      'CREATE INDEX IF NOT EXISTS idx_data_versions_created ON data_versions(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_data_versions_active ON data_versions(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_version_lineage_version ON version_lineage(version_id)',
      'CREATE INDEX IF NOT EXISTS idx_model_output_versions_run ON model_output_versions(model_run_id)',
      'CREATE INDEX IF NOT EXISTS idx_version_diffs_from_to ON version_diffs(from_version_id, to_version_id)',
    ];

    for (const indexSQL of indexes) {
      try {
        await this.storageManager.pool.query(indexSQL);
      } catch (error) {
        this.logger.warn('Index creation warning:', error.message);
      }
    }
  }

  /**
   * Create a new version of data
   */
  async createVersion(dataType, dataId, data, options = {}) {
    try {
      const {
        branch = this.activeBranch,
        versionType = 'minor', // 'major', 'minor', 'patch', 'development'
        parentVersionId = null,
        metadata = {},
        tags = [],
        createdBy = 'system',
        forceVersion = null,
      } = options;

      this.logger.info(
        `Creating new version for ${dataType}:${dataId} on branch ${branch}`
      );

      // Validate data against schema
      this.validateDataSchema(dataType, data);

      // Get next version number
      const versionNumber =
        forceVersion ||
        (await this.generateVersionNumber(
          dataType,
          dataId,
          branch,
          versionType
        ));

      // Check for existing version
      const existingVersion = await this.getVersion(
        dataType,
        dataId,
        versionNumber,
        branch
      );
      if (existingVersion) {
        throw new Error(
          `Version ${versionNumber} already exists for ${dataType}:${dataId} on branch ${branch}`
        );
      }

      // Prepare data for storage
      const { storageLocation, dataSize, isDelta, deltaBaseVersion } =
        await this.prepareDataForStorage(dataType, dataId, data, branch);

      // Calculate checksum
      const checksum = this.calculateChecksum(data);

      // Store version in database
      const versionRecord = await this.storageManager.pool.query(
        `
                INSERT INTO data_versions (
                    data_type, data_id, version_number, branch_name, parent_version_id,
                    version_metadata, created_by, storage_location, data_size_bytes,
                    is_delta, delta_base_version, checksum, tags
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING *
            `,
        [
          dataType,
          dataId,
          versionNumber,
          branch,
          parentVersionId,
          JSON.stringify(metadata),
          createdBy,
          storageLocation,
          dataSize,
          isDelta,
          deltaBaseVersion,
          checksum,
          tags,
        ]
      );

      const version = versionRecord.rows[0];

      // Create lineage record if provenance is enabled
      if (this.options.enableProvenance && options.lineage) {
        await this.recordLineage(version.id, options.lineage);
      }

      // Update metrics
      this.metrics.totalVersions++;
      this.metrics.activeVersions++;
      this.metrics.totalSize += dataSize;

      // Cache the version
      if (this.options.enableVersionCache) {
        this.cacheVersion(version);
      }

      this.logger.info(
        `Version ${versionNumber} created successfully for ${dataType}:${dataId}`
      );

      return {
        versionId: version.id,
        versionNumber,
        branch,
        checksum,
        size: dataSize,
        isDelta,
        storageLocation,
        createdAt: version.created_at,
      };
    } catch (error) {
      this.logger.error('Failed to create version:', error);
      throw error;
    }
  }

  /**
   * Retrieve a specific version of data
   */
  async getVersion(
    dataType,
    dataId,
    versionNumber = 'latest',
    branch = this.activeBranch
  ) {
    try {
      let query;
      let params;

      if (versionNumber === 'latest') {
        query = `
                    SELECT * FROM data_versions
                    WHERE data_type = $1 AND data_id = $2 AND branch_name = $3 AND is_active = true
                    ORDER BY created_at DESC
                    LIMIT 1
                `;
        params = [dataType, dataId, branch];
      } else {
        query = `
                    SELECT * FROM data_versions
                    WHERE data_type = $1 AND data_id = $2 AND version_number = $3 
                    AND branch_name = $4 AND is_active = true
                `;
        params = [dataType, dataId, versionNumber, branch];
      }

      const result = await this.storageManager.pool.query(query, params);

      if (result.rows.length === 0) {
        return null;
      }

      const versionRecord = result.rows[0];

      // Retrieve actual data from storage
      const data = await this.retrieveVersionData(versionRecord);

      return {
        ...versionRecord,
        data,
        version_metadata: JSON.parse(versionRecord.version_metadata || '{}'),
      };
    } catch (error) {
      this.logger.error('Failed to retrieve version:', error);
      throw error;
    }
  }

  /**
   * List all versions for a data item
   */
  async listVersions(dataType, dataId, options = {}) {
    try {
      const {
        branch = null,
        includeInactive = false,
        limit = 50,
        offset = 0,
        sortBy = 'created_at',
        sortOrder = 'DESC',
      } = options;

      // Allowlist for ORDER BY to prevent SQL injection via sortBy/sortOrder
      const ALLOWED_SORT_COLUMNS = ['created_at', 'updated_at', 'version_number', 'branch_name', 'data_type'];
      const ALLOWED_SORT_ORDERS = ['ASC', 'DESC'];
      const safeSortBy = ALLOWED_SORT_COLUMNS.includes(sortBy) ? sortBy : 'created_at';
      const safeSortOrder = ALLOWED_SORT_ORDERS.includes(sortOrder?.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

      let query = `
                SELECT
                    id, data_type, data_id, version_number, branch_name,
                    version_metadata, created_at, created_by, is_active,
                    data_size_bytes, is_delta, checksum, tags
                FROM data_versions
                WHERE data_type = $1 AND data_id = $2
            `;

      const params = [dataType, dataId];
      let paramCount = 2;

      if (branch) {
        query += ` AND branch_name = $${++paramCount}`;
        params.push(branch);
      }

      if (!includeInactive) {
        query += ' AND is_active = true';
      }

      query += ` ORDER BY ${safeSortBy} ${safeSortOrder} LIMIT $${++paramCount} OFFSET $${++paramCount}`;
      params.push(limit, offset);

      const result = await this.storageManager.pool.query(query, params);

      // Get total count (parameterized — no string interpolation for user input)
      let countQuery = `SELECT COUNT(*) as total FROM data_versions WHERE data_type = $1 AND data_id = $2`;
      const countParams = [dataType, dataId];

      if (branch) {
        countParams.push(branch);
        countQuery += ` AND branch_name = $${countParams.length}`;
      }

      if (!includeInactive) {
        countQuery += ' AND is_active = true';
      }

      const countResult = await this.storageManager.pool.query(countQuery, countParams);

      return {
        versions: result.rows.map(row => ({
          ...row,
          version_metadata: JSON.parse(row.version_metadata || '{}'),
        })),
        pagination: {
          total: parseInt(countResult.rows[0].total),
          limit,
          offset,
          hasMore: parseInt(countResult.rows[0].total) > offset + limit,
        },
      };
    } catch (error) {
      this.logger.error('Failed to list versions:', error);
      throw error;
    }
  }

  /**
   * Compare two versions
   */
  async compareVersions(
    dataType,
    dataId,
    fromVersion,
    toVersion,
    branch = this.activeBranch
  ) {
    try {
      this.logger.info(
        `Comparing versions ${fromVersion} to ${toVersion} for ${dataType}:${dataId}`
      );

      // Check if diff already exists
      const existingDiff = await this.getExistingDiff(
        dataType,
        dataId,
        fromVersion,
        toVersion,
        branch
      );
      if (existingDiff) {
        return existingDiff;
      }

      // Get version records
      const [fromVersionData, toVersionData] = await Promise.all([
        this.getVersion(dataType, dataId, fromVersion, branch),
        this.getVersion(dataType, dataId, toVersion, branch),
      ]);

      if (!fromVersionData || !toVersionData) {
        throw new Error('One or both versions not found');
      }

      // Generate diff based on data type
      const diff = await this.generateDiff(fromVersionData, toVersionData);

      // Store diff for future use
      await this.storeDiff(fromVersionData.id, toVersionData.id, diff);

      return diff;
    } catch (error) {
      this.logger.error('Failed to compare versions:', error);
      throw error;
    }
  }

  /**
   * Rollback to a previous version
   */
  async rollbackToVersion(
    dataType,
    dataId,
    targetVersion,
    branch = this.activeBranch,
    options = {}
  ) {
    try {
      const {
        createNewVersion = true,
        reason = 'Rollback operation',
        createdBy = 'system',
      } = options;

      this.logger.info(
        `Rolling back ${dataType}:${dataId} to version ${targetVersion} on branch ${branch}`
      );

      // Get target version data
      const targetVersionData = await this.getVersion(
        dataType,
        dataId,
        targetVersion,
        branch
      );
      if (!targetVersionData) {
        throw new Error(`Target version ${targetVersion} not found`);
      }

      if (createNewVersion) {
        // Create new version with rolled back data
        const rollbackVersion = await this.createVersion(
          dataType,
          dataId,
          targetVersionData.data,
          {
            branch,
            versionType: 'patch',
            metadata: {
              rollback: true,
              rollbackFrom: targetVersion,
              reason,
            },
            createdBy,
            tags: ['rollback'],
          }
        );

        this.metrics.rollbackCount++;

        return rollbackVersion;
      } else {
        // Simply restore data without creating new version
        await this.restoreVersionData(dataType, dataId, targetVersionData);
        return targetVersionData;
      }
    } catch (error) {
      this.logger.error('Failed to rollback version:', error);
      throw error;
    }
  }

  /**
   * Create a new branch
   */
  async createBranch(
    branchName,
    parentBranch = this.activeBranch,
    options = {}
  ) {
    try {
      const { description = '', createdBy = 'system' } = options;

      this.logger.info(
        `Creating new branch: ${branchName} from ${parentBranch}`
      );

      // Check if branch already exists
      const existingBranch = await this.storageManager.pool.query(
        'SELECT * FROM version_branches WHERE branch_name = $1',
        [branchName]
      );

      if (existingBranch.rows.length > 0) {
        throw new Error(`Branch ${branchName} already exists`);
      }

      // Create branch record
      const branchRecord = await this.storageManager.pool.query(
        `
                INSERT INTO version_branches (branch_name, parent_branch, created_by, description)
                VALUES ($1, $2, $3, $4)
                RETURNING *
            `,
        [branchName, parentBranch, createdBy, description]
      );

      this.branches.set(branchName, branchRecord.rows[0]);
      this.metrics.branchCount++;

      this.logger.info(`Branch ${branchName} created successfully`);

      return branchRecord.rows[0];
    } catch (error) {
      this.logger.error('Failed to create branch:', error);
      throw error;
    }
  }

  /**
   * Merge branch changes
   */
  async mergeBranch(sourceBranch, targetBranch = 'main', options = {}) {
    try {
      const {
        strategy = 'fast-forward', // 'fast-forward', 'three-way', 'squash'
        conflictResolution = 'manual', // 'manual', 'auto-latest', 'auto-source'
        createdBy = 'system',
      } = options;

      this.logger.info(`Merging branch ${sourceBranch} into ${targetBranch}`);

      // Get all versions in source branch that are not in target branch
      const branchVersions = await this.getBranchDifferences(
        sourceBranch,
        targetBranch
      );

      if (branchVersions.length === 0) {
        this.logger.info('No differences found between branches');
        return { merged: 0, conflicts: 0 };
      }

      const mergeResults = {
        merged: 0,
        conflicts: 0,
        conflictDetails: [],
      };

      for (const version of branchVersions) {
        try {
          await this.mergeVersionToBranch(version, targetBranch, strategy);
          mergeResults.merged++;
        } catch (error) {
          if (error.message.includes('conflict')) {
            mergeResults.conflicts++;
            mergeResults.conflictDetails.push({
              dataType: version.data_type,
              dataId: version.data_id,
              version: version.version_number,
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }

      this.logger.info(
        `Merge completed: ${mergeResults.merged} merged, ${mergeResults.conflicts} conflicts`
      );

      return mergeResults;
    } catch (error) {
      this.logger.error('Failed to merge branch:', error);
      throw error;
    }
  }

  /**
   * Data preparation and storage utilities
   */
  async prepareDataForStorage(dataType, dataId, data, branch) {
    const serializedData = JSON.stringify(data);
    let finalData = Buffer.from(serializedData);
    let isDelta = false;
    let deltaBaseVersion = null;

    // Apply delta compression if enabled
    if (this.options.enableDeltaCompression) {
      const deltaResult = await this.tryDeltaCompression(
        dataType,
        dataId,
        finalData,
        branch
      );
      if (deltaResult) {
        finalData = deltaResult.deltaData;
        isDelta = true;
        deltaBaseVersion = deltaResult.baseVersionId;
        this.metrics.deltaStorageSavings +=
          serializedData.length - finalData.length;
      }
    }

    // Compress data
    const compressedData = await gzip(finalData);

    // Generate storage location
    const storageLocation = this.generateStorageLocation(
      dataType,
      dataId,
      branch
    );

    // Store data (integrate with storage manager)
    await this.storeVersionData(storageLocation, compressedData);

    return {
      storageLocation,
      dataSize: compressedData.length,
      isDelta,
      deltaBaseVersion,
    };
  }

  async tryDeltaCompression(dataType, dataId, newData, branch) {
    try {
      // Get latest version for delta base
      const latestVersion = await this.getVersion(
        dataType,
        dataId,
        'latest',
        branch
      );
      if (!latestVersion) {
        return null; // No base version for delta
      }

      const baseData = Buffer.from(JSON.stringify(latestVersion.data));
      const delta = this.calculateDelta(baseData, newData);

      // Only use delta if it's significantly smaller
      if (delta.length < newData.length * 0.7) {
        return {
          deltaData: delta,
          baseVersionId: latestVersion.id,
        };
      }

      return null;
    } catch (error) {
      this.logger.warn(
        'Delta compression failed, using full storage:',
        error.message
      );
      return null;
    }
  }

  /**
   * Version number generation
   */
  async generateVersionNumber(dataType, dataId, branch, versionType) {
    try {
      const latestVersion = await this.getVersion(
        dataType,
        dataId,
        'latest',
        branch
      );

      if (!latestVersion) {
        return this.getInitialVersion(versionType);
      }

      const currentVersion = latestVersion.version_number;

      switch (this.options.versioningStrategy) {
        case 'semantic':
          return this.incrementSemanticVersion(currentVersion, versionType);
        case 'timestamp':
          return new Date().toISOString().replace(/[:.]/g, '-');
        case 'incremental':
          return this.incrementVersion(currentVersion);
        default:
          return this.incrementSemanticVersion(currentVersion, versionType);
      }
    } catch (error) {
      this.logger.error('Failed to generate version number:', error);
      throw error;
    }
  }

  incrementSemanticVersion(currentVersion, versionType) {
    const parts = currentVersion.split('.').map(Number);
    const [major = 0, minor = 0, patch = 0] = parts;

    switch (versionType) {
      case 'major':
        return `${major + 1}.0.0`;
      case 'minor':
        return `${major}.${minor + 1}.0`;
      case 'patch':
        return `${major}.${minor}.${patch + 1}`;
      case 'development':
        return `${major}.${minor}.${patch}-dev.${Date.now()}`;
      default:
        return `${major}.${minor}.${patch + 1}`;
    }
  }

  getInitialVersion(versionType) {
    switch (versionType) {
      case 'development':
        return '0.0.1-dev.1';
      default:
        return '1.0.0';
    }
  }

  /**
   * Utility methods
   */
  calculateChecksum(data) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  calculateDelta(baseData, newData) {
    // Simple binary delta calculation
    // In production, consider using more sophisticated algorithms like xdelta
    const delta = Buffer.alloc(Math.max(baseData.length, newData.length));
    for (let i = 0; i < delta.length; i++) {
      const baseVal = i < baseData.length ? baseData[i] : 0;
      const newVal = i < newData.length ? newData[i] : 0;
      delta[i] = newVal ^ baseVal; // XOR for simple delta
    }
    return delta;
  }

  validateDataSchema(dataType, data) {
    const schema = this.versionSchemas[dataType];
    if (!schema) {
      this.logger.warn(`No schema defined for data type: ${dataType}`);
      return;
    }

    // Check required fields
    for (const field of schema.required) {
      if (!(field in data)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  generateStorageLocation(dataType, dataId, branch) {
    const timestamp = new Date().toISOString().slice(0, 10);
    return `versions/${dataType}/${branch}/${timestamp}/${dataId}`;
  }

  async storeVersionData(location, data) {
    // This would integrate with the storage manager's file storage
    // For now, we'll use a simple file-based approach
    const fs = require('fs').promises;
    const path = require('path');

    const fullPath = path.join(process.cwd(), 'data', 'versions', location);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);

    return location;
  }

  async retrieveVersionData(versionRecord) {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      const fullPath = path.join(
        process.cwd(),
        'data',
        'versions',
        versionRecord.storage_location
      );
      const compressedData = await fs.readFile(fullPath);

      let data = await gunzip(compressedData);

      // Handle delta decompression
      if (versionRecord.is_delta && versionRecord.delta_base_version) {
        const baseVersion = await this.getVersionById(
          versionRecord.delta_base_version
        );
        const baseData = Buffer.from(JSON.stringify(baseVersion.data));
        data = this.applyDelta(baseData, data);
      }

      return JSON.parse(data.toString());
    } catch (error) {
      this.logger.error('Failed to retrieve version data:', error);
      throw error;
    }
  }

  async getVersionById(versionId) {
    const result = await this.storageManager.pool.query(
      'SELECT * FROM data_versions WHERE id = $1',
      [versionId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Version with ID ${versionId} not found`);
    }

    const versionRecord = result.rows[0];
    const data = await this.retrieveVersionData(versionRecord);

    return {
      ...versionRecord,
      data,
      version_metadata: JSON.parse(versionRecord.version_metadata || '{}'),
    };
  }

  applyDelta(baseData, deltaData) {
    const result = Buffer.alloc(Math.max(baseData.length, deltaData.length));
    for (let i = 0; i < result.length; i++) {
      const baseVal = i < baseData.length ? baseData[i] : 0;
      const deltaVal = i < deltaData.length ? deltaData[i] : 0;
      result[i] = baseVal ^ deltaVal; // XOR to reverse delta
    }
    return result;
  }

  /**
   * Initialize branch tracking
   */
  async initializeBranchTracking() {
    // Ensure main branch exists
    const mainBranch = await this.storageManager.pool.query(
      'SELECT * FROM version_branches WHERE branch_name = $1',
      ['main']
    );

    if (mainBranch.rows.length === 0) {
      await this.storageManager.pool.query(`
                INSERT INTO version_branches (branch_name, description, created_by)
                VALUES ('main', 'Main development branch', 'system')
            `);
    }

    this.branches.set('main', mainBranch.rows[0] || { branch_name: 'main' });
  }

  /**
   * Cache management
   */
  async loadVersionCache() {
    try {
      // Load frequently accessed versions into cache
      const recentVersions = await this.storageManager.pool.query(`
                SELECT * FROM data_versions
                WHERE created_at > NOW() - INTERVAL '1 day'
                AND is_active = true
                ORDER BY created_at DESC
                LIMIT 100
            `);

      for (const version of recentVersions.rows) {
        this.cacheVersion(version);
      }

      this.logger.info(
        `Loaded ${recentVersions.rows.length} versions into cache`
      );
    } catch (error) {
      this.logger.warn('Failed to load version cache:', error.message);
    }
  }

  cacheVersion(version) {
    const key = `${version.data_type}:${version.data_id}:${version.version_number}:${version.branch_name}`;
    this.versionCache.set(key, version);

    // Limit cache size
    if (this.versionCache.size > 1000) {
      const firstKey = this.versionCache.keys().next().value;
      this.versionCache.delete(firstKey);
    }
  }

  /**
   * Retention policy enforcement
   */
  async setupRetentionPolicyEnforcement() {
    // This would set up periodic cleanup of old versions
    // Implementation depends on specific requirements
    this.logger.info('Retention policy enforcement setup completed');
  }

  /**
   * Service status and metrics
   */
  getServiceStatus() {
    return {
      initialized: !!this.storageManager,
      activeBranch: this.activeBranch,
      branchCount: this.branches.size,
      metrics: this.metrics,
      configuration: {
        versioningStrategy: this.options.versioningStrategy,
        deltaCompressionEnabled: this.options.enableDeltaCompression,
        branchingEnabled: this.options.enableBranching,
        maxVersionsPerModel: this.options.maxVersionsPerModel,
      },
      cacheStatus: {
        size: this.versionCache.size,
        enabled: this.options.enableVersionCache,
      },
    };
  }

  /**
   * Record lineage for a version, delegating to the lineage service (#213).
   */
  async recordLineage(versionId, lineageOptions) {
    try {
      const { lineageService } = require('./lineage-service.js');

      const contentHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ versionId, ...lineageOptions }))
        .digest('hex');

      const record = await lineageService.createLineageRecord({
        stageId: lineageOptions.stageId || 'data_versioning',
        stationId: lineageOptions.stationId || null,
        contentHash,
        sourceType: lineageOptions.sourceType || 'model_output',
        sourceReference: lineageOptions.sourceReference || `version:${versionId}`,
        parentLineageId: lineageOptions.parentLineageId || null,
        transformationApplied: lineageOptions.transformationApplied || null,
        metadata: {
          versionId,
          ...lineageOptions.metadata,
        },
      });

      // Also store in the local version_lineage table for backward compatibility
      if (this.storageManager && this.storageManager.pool) {
        await this.storageManager.pool.query(
          `INSERT INTO version_lineage (version_id, source_type, source_reference, transformation_applied, lineage_metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            versionId,
            lineageOptions.sourceType || 'model_output',
            lineageOptions.sourceReference || `version:${versionId}`,
            lineageOptions.transformationApplied || null,
            JSON.stringify({ lineageId: record.lineageId, ...lineageOptions.metadata }),
          ]
        );
      }

      this.logger.info(`Lineage recorded for version ${versionId}: ${record.lineageId}`);
      return record;
    } catch (error) {
      this.logger.warn(`Failed to record lineage for version ${versionId}:`, error.message);
      // Lineage recording should not block version creation
      return null;
    }
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown() {
    try {
      // Clear cache
      this.versionCache.clear();

      // Save any pending metrics
      await this.saveMetrics();

      this.logger.info('Data Versioning Service shut down successfully');
    } catch (error) {
      this.logger.error('Error during versioning service shutdown:', error);
    }
  }

  async saveMetrics() {
    // Save metrics to database or file for persistence
    try {
      const fs = require('fs').promises;
      const path = require('path');

      const metricsPath = path.join(
        process.cwd(),
        'data',
        'versioning-metrics.json'
      );
      await fs.writeFile(metricsPath, JSON.stringify(this.metrics, null, 2));
    } catch (error) {
      this.logger.warn('Failed to save versioning metrics:', error.message);
    }
  }
}

module.exports = { DataVersioningService };
