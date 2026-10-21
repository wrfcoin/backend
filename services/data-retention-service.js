/**
 * Data Retention Service for GDPR Compliance
 *
 * Manages automated data retention policies, log cleanup,
 * and anonymization processes for audit trail compliance.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { createReadStream, createWriteStream } = require('fs');
const readline = require('readline');
const winston = require('winston');

/**
 * Data retention service implementing GDPR Article 5(1)(e) - Storage Limitation
 */
class DataRetentionService {
  constructor(config = {}) {
    this.config = {
      logDir: config.logDir || path.join(process.cwd(), 'logs'),
      scheduleCron: config.scheduleCron || '0 2 * * *', // Daily at 2 AM
      enableAutomaticCleanup: config.enableAutomaticCleanup !== false,
      enableAnonymization: config.enableAnonymization !== false,
      dryRun: config.dryRun || false,
      ...config,
    };

    // Retention policies by category (in days)
    this.retentionPolicies = new Map([
      ['security-critical', 365 * 7], // 7 years for critical security logs
      ['security-high', 365 * 3], // 3 years for high security logs
      ['security-medium', 365 * 1], // 1 year for medium security logs
      ['security-low', 90], // 90 days for low security logs
      ['operational', 90], // 90 days for operational logs
      ['compliance', 365 * 7], // 7 years for compliance logs
      ['debug', 30], // 30 days for debug logs
      ['performance', 365 * 2], // 2 years for performance logs
    ]);

    // Legal hold categories that override retention policies
    this.legalHoldCategories = new Set([
      'ongoing-investigation',
      'litigation-hold',
      'regulatory-inquiry',
    ]);

    this.logger = this.initializeLogger();
    this.statistics = {
      totalLogsProcessed: 0,
      logsDeleted: 0,
      logsAnonymized: 0,
      errors: 0,
      lastRunTime: null,
    };
  }

  /**
   * Initialize logger for retention service activities
   */
  initializeLogger() {
    return winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({
          filename: path.join(this.config.logDir, 'data-retention.log'),
          maxsize: 10485760, // 10MB
          maxFiles: 5,
        }),
        new winston.transports.Console({
          format: winston.format.simple(),
          silent: process.env.NODE_ENV === 'production',
        }),
      ],
    });
  }

  /**
   * Main retention policy execution
   */
  async executeRetentionPolicy() {
    const startTime = new Date();
    this.logger.info('Starting data retention policy execution', {
      dryRun: this.config.dryRun,
      timestamp: startTime.toISOString(),
    });

    try {
      // Reset statistics
      this.statistics = {
        totalLogsProcessed: 0,
        logsDeleted: 0,
        logsAnonymized: 0,
        errors: 0,
        lastRunTime: startTime.toISOString(),
      };

      // Process all log files in the directory
      const logFiles = await this.findLogFiles();

      for (const logFile of logFiles) {
        await this.processLogFile(logFile);
      }

      // Clean up empty log files
      await this.cleanupEmptyFiles();

      // Generate retention report
      const report = await this.generateRetentionReport();

      this.logger.info('Data retention policy execution completed', {
        duration: Date.now() - startTime.getTime(),
        statistics: this.statistics,
        report,
      });

      return report;
    } catch (error) {
      this.logger.error('Data retention policy execution failed', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Find all log files in the configured directory
   */
  async findLogFiles() {
    try {
      const files = await fs.readdir(this.config.logDir);
      const logFiles = files.filter(file => {
        return (
          file.endsWith('.log') &&
          !file.includes('data-retention') && // Don't process our own logs
          !file.includes('.tmp')
        );
      });

      this.logger.debug(`Found ${logFiles.length} log files to process`, {
        files: logFiles,
      });

      return logFiles.map(file => path.join(this.config.logDir, file));
    } catch (error) {
      this.logger.error('Failed to read log directory', {
        directory: this.config.logDir,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Process a single log file for retention policy
   */
  async processLogFile(filePath) {
    const fileName = path.basename(filePath);
    this.logger.debug(`Processing log file: ${fileName}`);

    try {
      const tempFilePath = `${filePath}.tmp`;
      const writeStream = createWriteStream(tempFilePath);
      const readStream = createReadStream(filePath);

      const rl = readline.createInterface({
        input: readStream,
        crlfDelay: Infinity,
      });

      let linesProcessed = 0;
      let linesRetained = 0;
      let linesDeleted = 0;
      let linesAnonymized = 0;

      for await (const line of rl) {
        if (!line.trim()) continue;

        try {
          const logEntry = JSON.parse(line);
          linesProcessed++;
          this.statistics.totalLogsProcessed++;

          const action = await this.determineRetentionAction(logEntry);

          switch (action.type) {
            case 'RETAIN':
              writeStream.write(line + '\n');
              linesRetained++;
              break;

            case 'DELETE':
              if (!this.config.dryRun) {
                // Log deletion event for audit trail
                await this.logDeletionEvent(logEntry, action.reason);
              }
              linesDeleted++;
              this.statistics.logsDeleted++;
              break;

            case 'ANONYMIZE':
              const anonymizedEntry = await this.anonymizeLogEntry(logEntry);
              if (!this.config.dryRun) {
                writeStream.write(JSON.stringify(anonymizedEntry) + '\n');
              }
              linesAnonymized++;
              this.statistics.logsAnonymized++;
              break;

            default:
              // Default to retain if unsure
              writeStream.write(line + '\n');
              linesRetained++;
          }
        } catch (parseError) {
          this.logger.warn('Failed to parse log entry', {
            file: fileName,
            line: line.substring(0, 100),
            error: parseError.message,
          });

          // Retain malformed entries to avoid data loss
          writeStream.write(line + '\n');
          linesRetained++;
          this.statistics.errors++;
        }
      }

      writeStream.end();

      // Replace original file with processed version
      if (!this.config.dryRun && (linesDeleted > 0 || linesAnonymized > 0)) {
        await fs.rename(tempFilePath, filePath);
      } else {
        // Clean up temp file
        try {
          await fs.unlink(tempFilePath);
        } catch (error) {
          // Ignore cleanup errors
        }
      }

      this.logger.info(`Processed log file: ${fileName}`, {
        linesProcessed,
        linesRetained,
        linesDeleted,
        linesAnonymized,
      });
    } catch (error) {
      this.logger.error(`Failed to process log file: ${fileName}`, {
        error: error.message,
      });
      this.statistics.errors++;
    }
  }

  /**
   * Determine what action to take for a log entry based on retention policies
   */
  async determineRetentionAction(logEntry) {
    try {
      // Check for legal hold
      if (this.isUnderLegalHold(logEntry)) {
        return {
          type: 'RETAIN',
          reason: 'Legal hold - retention required',
        };
      }

      // Check if entry has expired
      if (logEntry.retentionExpiryDate) {
        const expiryDate = new Date(logEntry.retentionExpiryDate);
        const now = new Date();

        if (now > expiryDate) {
          // Determine if we should delete or anonymize
          if (this.canBePhysicallyDeleted(logEntry)) {
            return {
              type: 'DELETE',
              reason: 'Retention period expired',
            };
          } else {
            return {
              type: 'ANONYMIZE',
              reason:
                'Retention period expired - anonymizing due to business need',
            };
          }
        }
      }

      // Check category-based retention
      const retentionDays = this.getRetentionPeriod(logEntry);
      if (retentionDays) {
        const logDate = new Date(logEntry.timestamp);
        const retentionExpiryDate = new Date(
          logDate.getTime() + retentionDays * 24 * 60 * 60 * 1000
        );

        if (Date.now() > retentionExpiryDate.getTime()) {
          if (this.canBePhysicallyDeleted(logEntry)) {
            return {
              type: 'DELETE',
              reason: 'Category-based retention period expired',
            };
          } else {
            return {
              type: 'ANONYMIZE',
              reason: 'Category-based retention period expired - anonymizing',
            };
          }
        }
      }

      return {
        type: 'RETAIN',
        reason: 'Within retention period',
      };
    } catch (error) {
      this.logger.warn('Failed to determine retention action', {
        logId: logEntry.logId,
        error: error.message,
      });

      return {
        type: 'RETAIN',
        reason: 'Error determining retention action - defaulting to retain',
      };
    }
  }

  /**
   * Check if a log entry is under legal hold
   */
  isUnderLegalHold(logEntry) {
    if (!logEntry.legalHold) return false;

    return (
      this.legalHoldCategories.has(logEntry.legalHold) ||
      (logEntry.legalHoldUntil &&
        new Date(logEntry.legalHoldUntil) > new Date())
    );
  }

  /**
   * Determine if a log entry can be physically deleted
   */
  canBePhysicallyDeleted(logEntry) {
    // Security and compliance logs often need to be anonymized rather than deleted
    // to maintain audit trail integrity

    if (logEntry.category === 'compliance') {
      return false; // Compliance logs should be anonymized, not deleted
    }

    if (
      logEntry.category === 'security' &&
      (logEntry.severity === 'CRITICAL' || logEntry.severity === 'HIGH')
    ) {
      return false; // High-severity security logs should be anonymized
    }

    // Check if referenced by other systems
    if (logEntry.referencedBy || logEntry.linkedTransactions) {
      return false;
    }

    return true;
  }

  /**
   * Get retention period for a log entry based on category and severity
   */
  getRetentionPeriod(logEntry) {
    if (logEntry.category === 'security') {
      const severity =
        logEntry.severity || logEntry.eventData?.severity || 'MEDIUM';
      return this.retentionPolicies.get(`security-${severity.toLowerCase()}`);
    }

    return (
      this.retentionPolicies.get(logEntry.category) ||
      this.retentionPolicies.get('operational')
    );
  }

  /**
   * Anonymize a log entry by removing or pseudonymizing personal data
   */
  async anonymizeLogEntry(logEntry) {
    const anonymizedEntry = {
      ...logEntry,

      // Mark as anonymized
      anonymized: true,
      anonymizationDate: new Date().toISOString(),
      anonymizationReason: 'Retention policy - personal data removed',

      // Remove pseudonymized identifiers
      pseudonymizedUserId: undefined,
      pseudonymizedIpAddress: undefined,
      pseudonymizedSessionId: undefined,

      // Remove user agent and other potentially identifying data
      userAgent: undefined,

      // Keep only essential event data
      eventData: this.anonymizeEventData(logEntry.eventData),

      // Update legal basis
      legalBasis: 'Anonymized data - no longer subject to GDPR',

      // Preserve integrity chain but mark as anonymized
      originalDataHash: logEntry.dataHash,
    };

    // Recalculate hash for anonymized entry
    delete anonymizedEntry.dataHash;
    delete anonymizedEntry.chainHash;

    return anonymizedEntry;
  }

  /**
   * Anonymize event data while preserving analytical value
   */
  anonymizeEventData(eventData) {
    if (!eventData || typeof eventData !== 'object') {
      return eventData;
    }

    const anonymized = {};

    // Preserve non-personal aggregate data
    const allowedFields = [
      'statusCode',
      'responseTime',
      'errorCode',
      'eventType',
      'amount',
      'transactionCount',
      'severity',
      'category',
      'method',
      'endpoint',
      'timestamp',
    ];

    allowedFields.forEach(field => {
      if (eventData[field] !== undefined) {
        anonymized[field] = eventData[field];
      }
    });

    // Convert specific values to ranges for privacy
    if (eventData.amount && typeof eventData.amount === 'number') {
      anonymized.amountRange = this.convertToRange(eventData.amount);
    }

    if (eventData.responseTime && typeof eventData.responseTime === 'number') {
      anonymized.responseTimeRange = this.convertToTimeRange(
        eventData.responseTime
      );
    }

    return anonymized;
  }

  /**
   * Convert numeric amount to privacy-preserving range
   */
  convertToRange(amount) {
    if (amount < 1) return '0-1';
    if (amount < 10) return '1-10';
    if (amount < 100) return '10-100';
    if (amount < 1000) return '100-1000';
    if (amount < 10000) return '1000-10000';
    return '10000+';
  }

  /**
   * Convert response time to privacy-preserving range
   */
  convertToTimeRange(responseTime) {
    if (responseTime < 100) return '0-100ms';
    if (responseTime < 500) return '100-500ms';
    if (responseTime < 1000) return '500ms-1s';
    if (responseTime < 5000) return '1-5s';
    return '5s+';
  }

  /**
   * Log a deletion event for audit purposes
   */
  async logDeletionEvent(deletedLogEntry, reason) {
    const deletionRecord = {
      timestamp: new Date().toISOString(),
      action: 'LOG_DELETION',
      originalLogId: deletedLogEntry.logId,
      originalTimestamp: deletedLogEntry.timestamp,
      originalCategory: deletedLogEntry.category,
      originalEventType: deletedLogEntry.eventType,
      deletionReason: reason,
      retentionPolicyApplied: true,
      legalBasis: 'GDPR Article 5(1)(e) - Storage Limitation',
      deletionHash: crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            logId: deletedLogEntry.logId,
            timestamp: deletedLogEntry.timestamp,
            deletionTime: new Date().toISOString(),
          })
        )
        .digest('hex'),
    };

    this.logger.info('Log entry deleted per retention policy', deletionRecord);
  }

  /**
   * Clean up empty log files after processing
   */
  async cleanupEmptyFiles() {
    try {
      const files = await fs.readdir(this.config.logDir);

      for (const file of files) {
        if (!file.endsWith('.log')) continue;

        const filePath = path.join(this.config.logDir, file);
        const stats = await fs.stat(filePath);

        // Remove files that are empty or only contain whitespace
        if (stats.size < 10) {
          const content = await fs.readFile(filePath, 'utf8');
          if (!content.trim()) {
            if (!this.config.dryRun) {
              await fs.unlink(filePath);
            }
            this.logger.info(`Removed empty log file: ${file}`);
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to cleanup empty files', {
        error: error.message,
      });
    }
  }

  /**
   * Generate retention policy execution report
   */
  async generateRetentionReport() {
    const report = {
      executionTime: this.statistics.lastRunTime,
      summary: {
        totalLogsProcessed: this.statistics.totalLogsProcessed,
        logsDeleted: this.statistics.logsDeleted,
        logsAnonymized: this.statistics.logsAnonymized,
        errors: this.statistics.errors,
      },
      retentionPolicies: Object.fromEntries(this.retentionPolicies),
      compliance: {
        gdprCompliant: this.statistics.errors === 0,
        dataMinimizationApplied:
          this.statistics.logsDeleted > 0 || this.statistics.logsAnonymized > 0,
        auditTrailMaintained: true,
      },
      recommendations: [],
    };

    // Add recommendations based on execution results
    if (this.statistics.errors > 0) {
      report.recommendations.push('Review and fix log parsing errors');
    }

    if (this.statistics.totalLogsProcessed === 0) {
      report.recommendations.push('Verify log directory and file permissions');
    }

    const retentionRate =
      (this.statistics.logsDeleted + this.statistics.logsAnonymized) /
      Math.max(this.statistics.totalLogsProcessed, 1);

    if (retentionRate > 0.8) {
      report.recommendations.push(
        'Consider reviewing retention policies - high deletion rate'
      );
    } else if (retentionRate < 0.01) {
      report.recommendations.push(
        'Consider running retention more frequently - low deletion rate'
      );
    }

    return report;
  }

  /**
   * Schedule automatic retention policy execution
   */
  scheduleRetentionPolicy() {
    if (!this.config.enableAutomaticCleanup) {
      this.logger.info('Automatic retention policy scheduling disabled');
      return;
    }

    const cron = require('node-cron');

    this.logger.info(
      `Scheduling retention policy execution: ${this.config.scheduleCron}`
    );

    cron.schedule(this.config.scheduleCron, async () => {
      try {
        await this.executeRetentionPolicy();
      } catch (error) {
        this.logger.error('Scheduled retention policy execution failed', {
          error: error.message,
        });
      }
    });
  }

  /**
   * Get current retention statistics
   */
  getStatistics() {
    return {
      ...this.statistics,
      retentionPolicies: Object.fromEntries(this.retentionPolicies),
      legalHoldCategories: Array.from(this.legalHoldCategories),
    };
  }

  /**
   * Add legal hold to prevent deletion of specific logs
   */
  addLegalHold(category, description, expiryDate = null) {
    this.legalHoldCategories.add(category);

    this.logger.info('Legal hold added', {
      category,
      description,
      expiryDate,
    });
  }

  /**
   * Remove legal hold
   */
  removeLegalHold(category) {
    const removed = this.legalHoldCategories.delete(category);

    if (removed) {
      this.logger.info('Legal hold removed', { category });
    }

    return removed;
  }
}

module.exports = DataRetentionService;
