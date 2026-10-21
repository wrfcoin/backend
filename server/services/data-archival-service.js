/**
 * Data Archival and Retention Service
 *
 * Comprehensive service for managing data lifecycle, archival, and retention policies.
 * Supports multiple storage backends and intelligent data tiering strategies.
 *
 * Features:
 * - Automated data lifecycle management
 * - Multi-tier storage (hot, warm, cold, frozen)
 * - Compression and format optimization
 * - Cloud storage integration (S3, Google Cloud, Azure)
 * - Data integrity verification
 * - Retrieval and restoration capabilities
 * - Cost-optimized storage strategies
 * - Compliance and regulatory support
 */

const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const Logger = require('../utils/logger');

// Compression utilities
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class DataArchivalService {
  constructor(options = {}) {
    this.options = {
      // Storage configuration
      localArchivePath: options.localArchivePath || './data/archives',
      cloudProvider: options.cloudProvider || 'local', // 'local', 's3', 'gcs', 'azure'

      // Storage tiers (days after creation)
      storageTiers: {
        hot: 0, // Immediate access (0-30 days)
        warm: 30, // Frequent access (30-90 days)
        cold: 90, // Infrequent access (90-365 days)
        frozen: 365, // Long-term archive (365+ days)
      },

      // Compression settings
      enableCompression: options.enableCompression !== false,
      compressionLevel: options.compressionLevel || 6,
      compressionFormat: options.compressionFormat || 'gzip',

      // Archive formats
      defaultArchiveFormat: options.defaultArchiveFormat || 'json',
      supportedFormats: ['json', 'parquet', 'avro', 'csv'],

      // Retention policies
      defaultRetentionDays: options.defaultRetentionDays || 2555, // ~7 years
      complianceMode: options.complianceMode || false,

      // Performance settings
      batchSize: options.batchSize || 1000,
      maxConcurrentArchives: options.maxConcurrentArchives || 5,

      // Verification settings
      enableIntegrityChecks: options.enableIntegrityChecks !== false,
      checksumAlgorithm: options.checksumAlgorithm || 'sha256',

      ...options,
    };

    this.logger = Logger;
    this.storageManager = null; // Will be injected

    // Archive statistics
    this.stats = {
      totalArchived: 0,
      totalSize: 0,
      compressionSavings: 0,
      retrievalCount: 0,
      integrityCheckFailures: 0,
      lastArchivalRun: null,
      storageDistribution: {
        hot: { count: 0, size: 0 },
        warm: { count: 0, size: 0 },
        cold: { count: 0, size: 0 },
        frozen: { count: 0, size: 0 },
      },
    };

    // Active archival jobs
    this.activeJobs = new Map();

    // Storage backends
    this.storageBackends = {
      local: new LocalStorageBackend(this.options),
      s3: null, // Will be initialized if needed
      gcs: null,
      azure: null,
    };
  }

  /**
   * Initialize the archival service
   */
  async initialize(storageManager) {
    try {
      this.storageManager = storageManager;

      // Ensure local archive directory exists
      await fs.mkdir(this.options.localArchivePath, { recursive: true });

      // Initialize cloud storage backends if configured
      await this.initializeCloudStorage();

      // Load existing archive statistics
      await this.loadArchiveStatistics();

      this.logger.info('Data Archival Service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Data Archival Service:', error);
      throw error;
    }
  }

  /**
   * Initialize cloud storage backends
   */
  async initializeCloudStorage() {
    if (this.options.cloudProvider === 's3') {
      const { S3StorageBackend } = require('./storage-backends/s3-backend');
      this.storageBackends.s3 = new S3StorageBackend(this.options);
      await this.storageBackends.s3.initialize();
    }

    if (this.options.cloudProvider === 'gcs') {
      const { GCSStorageBackend } = require('./storage-backends/gcs-backend');
      this.storageBackends.gcs = new GCSStorageBackend(this.options);
      await this.storageBackends.gcs.initialize();
    }

    if (this.options.cloudProvider === 'azure') {
      const {
        AzureStorageBackend,
      } = require('./storage-backends/azure-backend');
      this.storageBackends.azure = new AzureStorageBackend(this.options);
      await this.storageBackends.azure.initialize();
    }
  }

  /**
   * Archive data based on retention policies
   */
  async executeArchival(policyFilters = {}) {
    const jobId = this.generateJobId();

    try {
      this.logger.info(`Starting archival job ${jobId}...`);

      this.activeJobs.set(jobId, {
        startTime: new Date(),
        status: 'running',
        processed: 0,
        archived: 0,
        errors: [],
      });

      // Get retention policies
      const policies = await this.getRetentionPolicies(policyFilters);

      let totalArchived = 0;

      for (const policy of policies) {
        try {
          const archived = await this.executeRetentionPolicy(policy, jobId);
          totalArchived += archived;
        } catch (error) {
          this.logger.error(
            `Policy execution failed for ${policy.policy_name}:`,
            error
          );
          this.activeJobs.get(jobId).errors.push({
            policy: policy.policy_name,
            error: error.message,
          });
        }
      }

      // Update job status
      const job = this.activeJobs.get(jobId);
      job.status = 'completed';
      job.archived = totalArchived;
      job.endTime = new Date();

      // Update statistics
      this.stats.totalArchived += totalArchived;
      this.stats.lastArchivalRun = new Date();

      await this.saveArchiveStatistics();

      this.logger.info(
        `Archival job ${jobId} completed. Records archived: ${totalArchived}`
      );

      return {
        jobId,
        totalArchived,
        duration: job.endTime - job.startTime,
        errors: job.errors,
      };
    } catch (error) {
      const job = this.activeJobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = error.message;
      }

      this.logger.error(`Archival job ${jobId} failed:`, error);
      throw error;
    }
  }

  /**
   * Execute specific retention policy
   */
  async executeRetentionPolicy(policy, jobId) {
    const cutoffDate = this.calculateCutoffDate(policy.retention_period);
    let archivedCount = 0;

    this.logger.info(
      `Executing policy: ${policy.policy_name} (cutoff: ${cutoffDate.toISOString()})`
    );

    // Get data to archive in batches
    let offset = 0;
    let hasMoreData = true;

    while (hasMoreData) {
      const dataToArchive = await this.getDataForArchival(
        policy,
        cutoffDate,
        offset
      );

      if (dataToArchive.length === 0) {
        hasMoreData = false;
        break;
      }

      // Process batch
      const batchResult = await this.archiveBatch(dataToArchive, policy);
      archivedCount += batchResult.archived;

      // Update job progress
      const job = this.activeJobs.get(jobId);
      if (job) {
        job.processed += dataToArchive.length;
      }

      offset += this.options.batchSize;

      // Check if we should continue
      if (dataToArchive.length < this.options.batchSize) {
        hasMoreData = false;
      }
    }

    return archivedCount;
  }

  /**
   * Archive a batch of records
   */
  async archiveBatch(records, policy) {
    const results = {
      archived: 0,
      failed: 0,
      errors: [],
    };

    // Process records with concurrency limit
    const chunks = this.chunkArray(records, this.options.maxConcurrentArchives);

    for (const chunk of chunks) {
      const promises = chunk.map(record => this.archiveRecord(record, policy));
      const chunkResults = await Promise.allSettled(promises);

      chunkResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.archived++;
        } else {
          results.failed++;
          results.errors.push({
            recordId: chunk[index].id,
            error: result.reason.message,
          });
        }
      });
    }

    return results;
  }

  /**
   * Archive individual record
   */
  async archiveRecord(record, policy) {
    try {
      // Determine storage tier based on record age
      const tier = this.determineStorageTier(record.created_at);

      // Choose archive format based on data type and tier
      const archiveFormat = this.selectArchiveFormat(record, tier);

      // Prepare archive data
      const archiveData = await this.prepareArchiveData(record, archiveFormat);

      // Compress if enabled
      let finalData = archiveData;
      if (this.options.enableCompression) {
        finalData = await this.compressData(archiveData);
      }

      // Generate archive path
      const archivePath = this.generateArchivePath(record, tier, archiveFormat);

      // Store in selected backend
      const backend = this.getStorageBackend(tier);
      await backend.store(archivePath, finalData);

      // Calculate integrity checksum
      const checksum = this.calculateChecksum(finalData);

      // Update archive index
      await this.updateArchiveIndex(record, {
        archivePath,
        tier,
        format: archiveFormat,
        compressed: this.options.enableCompression,
        size: finalData.length,
        originalSize: archiveData.length,
        checksum,
      });

      // Update statistics
      this.updateStorageStats(tier, finalData.length, archiveData.length);

      this.logger.debug(`Record archived: ${record.id} -> ${archivePath}`);

      return {
        recordId: record.id,
        archivePath,
        tier,
        size: finalData.length,
      };
    } catch (error) {
      this.logger.error(`Failed to archive record ${record.id}:`, error);
      throw error;
    }
  }

  /**
   * Retrieve archived data
   */
  async retrieveArchivedData(archiveReference, options = {}) {
    try {
      const { validateIntegrity = true, decompressData = true } = options;

      // Get archive metadata
      const archiveInfo = await this.getArchiveInfo(archiveReference);

      if (!archiveInfo) {
        throw new Error(`Archive not found: ${archiveReference}`);
      }

      // Retrieve from storage backend
      const backend = this.getStorageBackend(archiveInfo.tier);
      let data = await backend.retrieve(archiveInfo.archive_path);

      // Verify integrity if enabled
      if (validateIntegrity && this.options.enableIntegrityChecks) {
        const checksum = this.calculateChecksum(data);
        if (checksum !== archiveInfo.checksum) {
          this.stats.integrityCheckFailures++;
          throw new Error(
            `Integrity check failed for archive: ${archiveReference}`
          );
        }
      }

      // Decompress if needed
      if (decompressData && archiveInfo.compressed) {
        data = await this.decompressData(data);
      }

      // Parse based on format
      const parsedData = this.parseArchivedData(data, archiveInfo.format);

      // Update retrieval statistics
      this.stats.retrievalCount++;
      await this.updateArchiveAccess(archiveReference);

      this.logger.debug(`Data retrieved from archive: ${archiveReference}`);

      return {
        data: parsedData,
        metadata: archiveInfo,
        retrievedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to retrieve archived data: ${archiveReference}`,
        error
      );
      throw error;
    }
  }

  /**
   * Migrate data between storage tiers
   */
  async migrateStorageTiers() {
    try {
      this.logger.info('Starting storage tier migration...');

      // Get all archived data for tier evaluation
      const archivedData = await this.getAllArchivedData();

      let migrated = 0;

      for (const archive of archivedData) {
        const currentTier = archive.tier;
        const optimalTier = this.determineStorageTier(archive.created_at);

        if (currentTier !== optimalTier) {
          await this.migrateToTier(archive, optimalTier);
          migrated++;
        }
      }

      this.logger.info(
        `Storage tier migration completed. Records migrated: ${migrated}`
      );

      return migrated;
    } catch (error) {
      this.logger.error('Storage tier migration failed:', error);
      throw error;
    }
  }

  /**
   * Migrate specific archive to different tier
   */
  async migrateToTier(archive, newTier) {
    try {
      // Retrieve from current backend
      const currentBackend = this.getStorageBackend(archive.tier);
      const data = await currentBackend.retrieve(archive.archive_path);

      // Store in new backend
      const newBackend = this.getStorageBackend(newTier);
      const newPath = this.generateArchivePath(
        archive,
        newTier,
        archive.format
      );
      await newBackend.store(newPath, data);

      // Update archive index
      await this.updateArchiveLocation(archive.id, newPath, newTier);

      // Remove from old backend (if different)
      if (archive.tier !== newTier) {
        await currentBackend.delete(archive.archive_path);
      }

      // Update statistics
      this.updateTierStats(archive.tier, newTier, archive.archive_size_bytes);

      this.logger.debug(
        `Archive migrated: ${archive.id} from ${archive.tier} to ${newTier}`
      );
    } catch (error) {
      this.logger.error(`Failed to migrate archive ${archive.id}:`, error);
      throw error;
    }
  }

  /**
   * Data preparation and formatting methods
   */
  async prepareArchiveData(record, format) {
    switch (format) {
      case 'json':
        return JSON.stringify(record);

      case 'parquet':
        // Parquet conversion would require additional library
        return this.convertToParquet(record);

      case 'avro':
        // Avro conversion
        return this.convertToAvro(record);

      case 'csv':
        return this.convertToCSV(record);

      default:
        return JSON.stringify(record);
    }
  }

  parseArchivedData(data, format) {
    switch (format) {
      case 'json':
        return JSON.parse(data.toString());

      case 'parquet':
        return this.parseParquet(data);

      case 'avro':
        return this.parseAvro(data);

      case 'csv':
        return this.parseCSV(data.toString());

      default:
        return JSON.parse(data.toString());
    }
  }

  /**
   * Compression utilities
   */
  async compressData(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    switch (this.options.compressionFormat) {
      case 'gzip':
        return await gzip(buffer, { level: this.options.compressionLevel });

      case 'brotli':
        const brotli = require('zlib').brotliCompress;
        return await promisify(brotli)(buffer);

      default:
        return await gzip(buffer, { level: this.options.compressionLevel });
    }
  }

  async decompressData(data) {
    switch (this.options.compressionFormat) {
      case 'gzip':
        return await gunzip(data);

      case 'brotli':
        const brotli = require('zlib').brotliDecompress;
        return await promisify(brotli)(data);

      default:
        return await gunzip(data);
    }
  }

  /**
   * Storage tier determination
   */
  determineStorageTier(createdAt) {
    const ageInDays =
      (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);

    if (ageInDays >= this.options.storageTiers.frozen) return 'frozen';
    if (ageInDays >= this.options.storageTiers.cold) return 'cold';
    if (ageInDays >= this.options.storageTiers.warm) return 'warm';
    return 'hot';
  }

  selectArchiveFormat(record, tier) {
    // Select format based on data characteristics and storage tier
    if (tier === 'frozen') {
      return 'parquet'; // Most compact for long-term storage
    }

    if (record.measurements && Object.keys(record.measurements).length > 10) {
      return 'avro'; // Good for structured data
    }

    return this.options.defaultArchiveFormat;
  }

  getStorageBackend(tier) {
    // Return appropriate backend based on tier and configuration
    switch (tier) {
      case 'hot':
      case 'warm':
        return (
          this.storageBackends[this.options.cloudProvider] ||
          this.storageBackends.local
        );

      case 'cold':
      case 'frozen':
        // Use most cost-effective storage for cold/frozen tiers
        return this.storageBackends.s3 || this.storageBackends.local;

      default:
        return this.storageBackends.local;
    }
  }

  /**
   * Path generation
   */
  generateArchivePath(record, tier, format) {
    const date = new Date(record.created_at);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const extension = this.options.enableCompression ? `${format}.gz` : format;

    return `${tier}/${year}/${month}/${day}/${record.id}.${extension}`;
  }

  /**
   * Database operations
   */
  async getRetentionPolicies(filters = {}) {
    const conditions = ['is_active = true'];
    const params = [];

    if (filters.policyName) {
      conditions.push('policy_name = $' + (params.length + 1));
      params.push(filters.policyName);
    }

    const query = `
            SELECT * FROM ${this.storageManager.tables.retentionPolicies}
            WHERE ${conditions.join(' AND ')}
            ORDER BY priority DESC
        `;

    const result = await this.storageManager.pool.query(query, params);
    return result.rows;
  }

  async getDataForArchival(policy, cutoffDate, offset) {
    const query = `
            SELECT * FROM ${policy.table_name}
            WHERE created_at < $1 AND archived_at IS NULL
            ORDER BY created_at ASC
            LIMIT $2 OFFSET $3
        `;

    const result = await this.storageManager.pool.query(query, [
      cutoffDate,
      this.options.batchSize,
      offset,
    ]);

    return result.rows;
  }

  async updateArchiveIndex(record, archiveInfo) {
    await this.storageManager.pool.query(
      `
            INSERT INTO ${this.storageManager.tables.archiveIndex} (
                original_table, original_id, archive_location, archive_format,
                archive_size_bytes, compression_ratio, checksum
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
      [
        record.table_name || 'unknown',
        record.id,
        archiveInfo.archivePath,
        archiveInfo.format,
        archiveInfo.size,
        archiveInfo.originalSize > 0
          ? archiveInfo.size / archiveInfo.originalSize
          : 1,
        archiveInfo.checksum,
      ]
    );
  }

  /**
   * Statistics and monitoring
   */
  updateStorageStats(tier, compressedSize, originalSize) {
    this.stats.totalSize += compressedSize;
    this.stats.compressionSavings += originalSize - compressedSize;

    this.stats.storageDistribution[tier].count++;
    this.stats.storageDistribution[tier].size += compressedSize;
  }

  async loadArchiveStatistics() {
    // Load statistics from database or file
    try {
      const statsFile = path.join(
        this.options.localArchivePath,
        'statistics.json'
      );
      const data = await fs.readFile(statsFile, 'utf8');
      const savedStats = JSON.parse(data);

      // Merge with current stats
      Object.assign(this.stats, savedStats);
    } catch (error) {
      // File doesn't exist or is corrupted, start fresh
      this.logger.info('Starting with fresh archive statistics');
    }
  }

  async saveArchiveStatistics() {
    try {
      const statsFile = path.join(
        this.options.localArchivePath,
        'statistics.json'
      );
      await fs.writeFile(statsFile, JSON.stringify(this.stats, null, 2));
    } catch (error) {
      this.logger.warn('Failed to save archive statistics:', error.message);
    }
  }

  /**
   * Utility methods
   */
  generateJobId() {
    return `archival_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  calculateCutoffDate(retentionPeriod) {
    // Parse PostgreSQL interval and calculate cutoff date
    const now = new Date();
    const match = retentionPeriod.match(/(\d+)\s+(\w+)/);

    if (!match) {
      throw new Error(`Invalid retention period format: ${retentionPeriod}`);
    }

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'day':
      case 'days':
        now.setDate(now.getDate() - value);
        break;
      case 'month':
      case 'months':
        now.setMonth(now.getMonth() - value);
        break;
      case 'year':
      case 'years':
        now.setFullYear(now.getFullYear() - value);
        break;
      default:
        throw new Error(`Unsupported retention period unit: ${unit}`);
    }

    return now;
  }

  calculateChecksum(data) {
    const crypto = require('crypto');
    return crypto
      .createHash(this.options.checksumAlgorithm)
      .update(data)
      .digest('hex');
  }

  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Get service status and statistics
   */
  getServiceStatus() {
    return {
      initialized: !!this.storageManager,
      activeJobs: this.activeJobs.size,
      statistics: this.stats,
      configuration: {
        cloudProvider: this.options.cloudProvider,
        compressionEnabled: this.options.enableCompression,
        storageTiers: this.options.storageTiers,
        defaultRetention: this.options.defaultRetentionDays,
      },
    };
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown() {
    try {
      // Wait for active jobs to complete
      const activeJobIds = Array.from(this.activeJobs.keys());

      if (activeJobIds.length > 0) {
        this.logger.info(
          `Waiting for ${activeJobIds.length} active archival jobs to complete...`
        );

        // Wait up to 5 minutes for jobs to complete
        const timeout = setTimeout(
          () => {
            this.logger.warn('Forcefully terminating active archival jobs');
            this.activeJobs.clear();
          },
          5 * 60 * 1000
        );

        while (this.activeJobs.size > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        clearTimeout(timeout);
      }

      // Save final statistics
      await this.saveArchiveStatistics();

      this.logger.info('Data Archival Service shut down successfully');
    } catch (error) {
      this.logger.error('Error during archival service shutdown:', error);
    }
  }
}

/**
 * Local Storage Backend
 */
class LocalStorageBackend {
  constructor(options) {
    this.basePath = options.localArchivePath;
  }

  async store(archivePath, data) {
    const fullPath = path.join(this.basePath, archivePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
  }

  async retrieve(archivePath) {
    const fullPath = path.join(this.basePath, archivePath);
    return await fs.readFile(fullPath);
  }

  async delete(archivePath) {
    const fullPath = path.join(this.basePath, archivePath);
    await fs.unlink(fullPath);
  }

  async exists(archivePath) {
    const fullPath = path.join(this.basePath, archivePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { DataArchivalService, LocalStorageBackend };
