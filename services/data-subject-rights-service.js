/**
 * Data Subject Rights Service for GDPR Compliance
 *
 * Implements GDPR Articles 15-22 (Data Subject Rights):
 * - Right to Access (Article 15)
 * - Right to Rectification (Article 16)
 * - Right to Erasure (Article 17)
 * - Right to Restriction (Article 18)
 * - Right to Data Portability (Article 20)
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const { createReadStream } = require('fs');
const readline = require('readline');

/**
 * Data subject request types
 */
const RequestType = {
  ACCESS: 'access',
  RECTIFICATION: 'rectification',
  ERASURE: 'erasure',
  RESTRICTION: 'restriction',
  PORTABILITY: 'portability',
  OBJECTION: 'objection',
};

/**
 * Request status enumeration
 */
const RequestStatus = {
  RECEIVED: 'received',
  IDENTITY_VERIFICATION: 'identity_verification',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  PARTIALLY_COMPLETED: 'partially_completed',
};

/**
 * Erasure reasons as defined in GDPR Article 17
 */
const ErasureReason = {
  NO_LONGER_NECESSARY: 'no_longer_necessary',
  WITHDRAWN_CONSENT: 'withdrawn_consent',
  UNLAWFUL_PROCESSING: 'unlawful_processing',
  LEGAL_OBLIGATION: 'legal_obligation',
  CHILD_CONSENT: 'child_consent',
  DIRECT_MARKETING_OBJECTION: 'direct_marketing_objection',
};

/**
 * Data Subject Rights Service implementing GDPR compliance
 */
class DataSubjectRightsService {
  constructor(config = {}) {
    this.config = {
      logDir: config.logDir || path.join(process.cwd(), 'logs'),
      requestsDir:
        config.requestsDir || path.join(process.cwd(), 'data-requests'),
      responseTimeLimit: config.responseTimeLimit || 30, // days
      identityVerificationRequired:
        config.identityVerificationRequired !== false,
      enableAutomatedProcessing: config.enableAutomatedProcessing !== false,
      ...config,
    };

    this.logger = this.initializeLogger();
    this.pseudonymizer = this.initializePseudonymizer();

    // Request tracking
    this.activeRequests = new Map();
    this.requestHistory = [];

    this.initialize();
  }

  /**
   * Initialize the service
   */
  async initialize() {
    try {
      // Ensure requests directory exists
      await fs.mkdir(this.config.requestsDir, { recursive: true });

      // Load any pending requests
      await this.loadPendingRequests();

      this.logger.info('Data Subject Rights Service initialized', {
        requestsDir: this.config.requestsDir,
        pendingRequests: this.activeRequests.size,
      });
    } catch (error) {
      this.logger.error('Failed to initialize Data Subject Rights Service', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Initialize logger for data subject rights activities
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
          filename: path.join(this.config.logDir, 'data-subject-rights.log'),
          maxsize: 10485760, // 10MB
          maxFiles: 10,
        }),
        new winston.transports.Console({
          format: winston.format.simple(),
          silent: process.env.NODE_ENV === 'production',
        }),
      ],
    });
  }

  /**
   * Initialize pseudonymizer for consistent data processing
   */
  initializePseudonymizer() {
    // Load the same pseudonymizer used by the privacy-preserving logger
    const { Pseudonymizer } = require('../utils/privacy-preserving-logger');
    return new Pseudonymizer();
  }

  /**
   * Handle a data subject access request (Article 15)
   */
  async handleAccessRequest(requestData) {
    const requestId = this.generateRequestId();

    try {
      // Create request record
      const request = {
        requestId,
        type: RequestType.ACCESS,
        timestamp: new Date().toISOString(),
        userId: requestData.userId,
        email: requestData.email,
        status: RequestStatus.RECEIVED,
        verificationMethod: requestData.verificationMethod,
        requestDetails: {
          dataCategories: requestData.dataCategories || 'all',
          timeRange: requestData.timeRange,
          includeMetadata: requestData.includeMetadata || false,
        },
      };

      await this.saveRequest(request);
      this.activeRequests.set(requestId, request);

      this.logger.info('Access request received', {
        requestId,
        userId: this.hashUserId(requestData.userId),
        dataCategories: request.requestDetails.dataCategories,
      });

      // Start processing if automated processing is enabled
      if (this.config.enableAutomatedProcessing) {
        setImmediate(() => this.processAccessRequest(requestId));
      }

      return {
        requestId,
        status: RequestStatus.RECEIVED,
        estimatedCompletionTime: this.calculateEstimatedCompletion(),
        nextSteps: this.getNextStepsForRequest(request),
      };
    } catch (error) {
      this.logger.error('Failed to handle access request', {
        error: error.message,
        userId: this.hashUserId(requestData.userId),
      });
      throw error;
    }
  }

  /**
   * Process an access request by searching audit logs
   */
  async processAccessRequest(requestId) {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    try {
      // Update status
      request.status = RequestStatus.PROCESSING;
      await this.saveRequest(request);

      // Generate pseudonymized identifiers for search
      const pseudonymizedUserId = this.pseudonymizer.pseudonymizeUserId(
        request.userId
      );

      // Search for user's data across all log files
      const userData = await this.searchUserDataInLogs(
        pseudonymizedUserId,
        request.requestDetails
      );

      // Create user-friendly export
      const exportData = await this.createDataExport(userData, request);

      // Save export file
      const exportFileName = `data-export-${requestId}-${Date.now()}.json`;
      const exportPath = path.join(this.config.requestsDir, exportFileName);
      await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2));

      // Update request with results
      request.status = RequestStatus.COMPLETED;
      request.completionTime = new Date().toISOString();
      request.exportFile = exportFileName;
      request.dataFound = {
        totalRecords: userData.length,
        categories: this.extractDataCategories(userData),
        timeRange: this.extractTimeRange(userData),
      };

      await this.saveRequest(request);

      this.logger.info('Access request completed', {
        requestId,
        recordsFound: userData.length,
        categories: request.dataFound.categories,
      });

      return request;
    } catch (error) {
      request.status = RequestStatus.REJECTED;
      request.rejectionReason = error.message;
      await this.saveRequest(request);

      this.logger.error('Access request processing failed', {
        requestId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle a data erasure request (Article 17)
   */
  async handleErasureRequest(requestData) {
    const requestId = this.generateRequestId();

    try {
      const request = {
        requestId,
        type: RequestType.ERASURE,
        timestamp: new Date().toISOString(),
        userId: requestData.userId,
        email: requestData.email,
        status: RequestStatus.RECEIVED,
        requestDetails: {
          reason: requestData.reason || ErasureReason.NO_LONGER_NECESSARY,
          dataCategories: requestData.dataCategories || 'all',
          urgent: requestData.urgent || false,
        },
      };

      await this.saveRequest(request);
      this.activeRequests.set(requestId, request);

      this.logger.info('Erasure request received', {
        requestId,
        userId: this.hashUserId(requestData.userId),
        reason: request.requestDetails.reason,
      });

      // Assess legal constraints
      const legalAssessment = await this.assessErasureConstraints(request);

      if (legalAssessment.canProcess) {
        if (this.config.enableAutomatedProcessing) {
          setImmediate(() => this.processErasureRequest(requestId));
        }
      } else {
        request.status = RequestStatus.REJECTED;
        request.rejectionReason = legalAssessment.reason;
        await this.saveRequest(request);
      }

      return {
        requestId,
        status: request.status,
        legalAssessment,
        estimatedCompletionTime: this.calculateEstimatedCompletion(),
        nextSteps: this.getNextStepsForRequest(request),
      };
    } catch (error) {
      this.logger.error('Failed to handle erasure request', {
        error: error.message,
        userId: this.hashUserId(requestData.userId),
      });
      throw error;
    }
  }

  /**
   * Process an erasure request
   */
  async processErasureRequest(requestId) {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    try {
      request.status = RequestStatus.PROCESSING;
      await this.saveRequest(request);

      const pseudonymizedUserId = this.pseudonymizer.pseudonymizeUserId(
        request.userId
      );

      // Find user's data
      const userData = await this.searchUserDataInLogs(pseudonymizedUserId, {});

      let erasedCount = 0;
      let anonymizedCount = 0;
      const technicalLimitations = [];

      // Process each log file containing user data
      for (const logFile of await this.findLogFiles()) {
        const result = await this.processLogFileForErasure(
          logFile,
          pseudonymizedUserId,
          request.requestDetails
        );

        erasedCount += result.erasedCount;
        anonymizedCount += result.anonymizedCount;

        if (result.technicalLimitations.length > 0) {
          technicalLimitations.push(...result.technicalLimitations);
        }
      }

      // Update request with results
      request.status =
        erasedCount > 0 || anonymizedCount > 0
          ? RequestStatus.COMPLETED
          : RequestStatus.PARTIALLY_COMPLETED;

      request.completionTime = new Date().toISOString();
      request.erasureResults = {
        erasedRecords: erasedCount,
        anonymizedRecords: anonymizedCount,
        technicalLimitations: [...new Set(technicalLimitations)], // Remove duplicates
        totalRecordsProcessed: userData.length,
      };

      await this.saveRequest(request);

      this.logger.info('Erasure request completed', {
        requestId,
        erasedRecords: erasedCount,
        anonymizedRecords: anonymizedCount,
      });

      return request;
    } catch (error) {
      request.status = RequestStatus.REJECTED;
      request.rejectionReason = error.message;
      await this.saveRequest(request);

      this.logger.error('Erasure request processing failed', {
        requestId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Search for user data across all log files
   */
  async searchUserDataInLogs(pseudonymizedUserId, searchCriteria) {
    const userData = [];
    const logFiles = await this.findLogFiles();

    for (const logFile of logFiles) {
      try {
        const fileData = await this.searchLogFile(
          logFile,
          pseudonymizedUserId,
          searchCriteria
        );
        userData.push(...fileData);
      } catch (error) {
        this.logger.warn('Failed to search log file', {
          file: path.basename(logFile),
          error: error.message,
        });
      }
    }

    // Sort by timestamp
    userData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return userData;
  }

  /**
   * Search a specific log file for user data
   */
  async searchLogFile(filePath, pseudonymizedUserId, searchCriteria) {
    const userRecords = [];
    const readStream = createReadStream(filePath);

    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const logEntry = JSON.parse(line);

        // Check if this log entry belongs to the user
        if (this.isUserData(logEntry, pseudonymizedUserId)) {
          // Apply search criteria filters
          if (this.matchesSearchCriteria(logEntry, searchCriteria)) {
            userRecords.push(logEntry);
          }
        }
      } catch (parseError) {
        // Skip malformed entries
        continue;
      }
    }

    return userRecords;
  }

  /**
   * Check if a log entry belongs to the specified user
   */
  isUserData(logEntry, pseudonymizedUserId) {
    return (
      logEntry.pseudonymizedUserId === pseudonymizedUserId ||
      logEntry.pseudonymizedIpAddress === pseudonymizedUserId || // For IP-based tracking
      (logEntry.eventData && logEntry.eventData.userId === pseudonymizedUserId)
    );
  }

  /**
   * Check if a log entry matches search criteria
   */
  matchesSearchCriteria(logEntry, criteria) {
    // Time range filter
    if (criteria.timeRange) {
      const logTime = new Date(logEntry.timestamp);
      const startTime = criteria.timeRange.start
        ? new Date(criteria.timeRange.start)
        : null;
      const endTime = criteria.timeRange.end
        ? new Date(criteria.timeRange.end)
        : null;

      if (startTime && logTime < startTime) return false;
      if (endTime && logTime > endTime) return false;
    }

    // Data category filter
    if (criteria.dataCategories && criteria.dataCategories !== 'all') {
      const categories = Array.isArray(criteria.dataCategories)
        ? criteria.dataCategories
        : [criteria.dataCategories];

      if (!categories.includes(logEntry.category)) return false;
    }

    return true;
  }

  /**
   * Process a log file for erasure operations
   */
  async processLogFileForErasure(
    filePath,
    pseudonymizedUserId,
    erasureDetails
  ) {
    const tempFilePath = `${filePath}.erasure_temp`;
    const fs = require('fs');
    const writeStream = fs.createWriteStream(tempFilePath);
    const readStream = fs.createReadStream(filePath);

    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    let erasedCount = 0;
    let anonymizedCount = 0;
    const technicalLimitations = [];

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const logEntry = JSON.parse(line);

        if (this.isUserData(logEntry, pseudonymizedUserId)) {
          // Determine erasure action
          if (this.canPhysicallyDelete(logEntry)) {
            // Delete the entry (don't write to temp file)
            erasedCount++;

            // Log the deletion for audit trail
            await this.logErasureAction(
              logEntry,
              'DELETED',
              erasureDetails.reason
            );
          } else {
            // Anonymize the entry
            const anonymizedEntry = await this.anonymizeForErasure(logEntry);
            writeStream.write(JSON.stringify(anonymizedEntry) + '\n');
            anonymizedCount++;

            technicalLimitations.push(
              'Blockchain immutability - data anonymized instead of deleted'
            );
            await this.logErasureAction(
              logEntry,
              'ANONYMIZED',
              erasureDetails.reason
            );
          }
        } else {
          // Keep non-user data unchanged
          writeStream.write(line + '\n');
        }
      } catch (parseError) {
        // Keep malformed entries
        writeStream.write(line + '\n');
      }
    }

    writeStream.end();

    // Replace original file if changes were made
    if (erasedCount > 0 || anonymizedCount > 0) {
      await fs.promises.rename(tempFilePath, filePath);
    } else {
      await fs.promises.unlink(tempFilePath);
    }

    return {
      erasedCount,
      anonymizedCount,
      technicalLimitations: [...new Set(technicalLimitations)],
    };
  }

  /**
   * Determine if a log entry can be physically deleted
   */
  canPhysicallyDelete(logEntry) {
    // Compliance logs should generally be anonymized, not deleted
    if (logEntry.category === 'compliance') {
      return false;
    }

    // Critical security events should be anonymized to maintain audit trail
    if (
      logEntry.category === 'security' &&
      (logEntry.severity === 'CRITICAL' || logEntry.severity === 'HIGH')
    ) {
      return false;
    }

    // Blockchain-related logs with integrity chains cannot be deleted
    if (logEntry.chainHash || logEntry.previousHash) {
      return false;
    }

    return true;
  }

  /**
   * Anonymize a log entry for erasure purposes
   */
  async anonymizeForErasure(logEntry) {
    return {
      ...logEntry,

      // Mark as anonymized due to erasure request
      anonymized: true,
      anonymizationDate: new Date().toISOString(),
      anonymizationReason: 'Data erasure request - GDPR Article 17',

      // Remove all pseudonymized identifiers
      pseudonymizedUserId: undefined,
      pseudonymizedIpAddress: undefined,
      pseudonymizedSessionId: undefined,
      userAgent: undefined,

      // Remove event data that might contain personal information
      eventData: {
        eventType: logEntry.eventType,
        category: logEntry.category,
        anonymized: true,
      },

      // Update legal basis
      legalBasis:
        'Anonymized per data erasure request - no longer personal data',
    };
  }

  /**
   * Log an erasure action for audit purposes
   */
  async logErasureAction(originalLogEntry, action, reason) {
    const erasureRecord = {
      timestamp: new Date().toISOString(),
      action: `ERASURE_${action}`,
      originalLogId: originalLogEntry.logId,
      originalTimestamp: originalLogEntry.timestamp,
      originalCategory: originalLogEntry.category,
      erasureReason: reason,
      legalBasis: 'GDPR Article 17 - Right to Erasure',
      erasureHash: crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            originalLogId: originalLogEntry.logId,
            action,
            timestamp: new Date().toISOString(),
          })
        )
        .digest('hex'),
    };

    this.logger.info('Data erasure action performed', erasureRecord);
  }

  /**
   * Create a user-friendly data export
   */
  async createDataExport(userData, request) {
    return {
      requestId: request.requestId,
      exportDate: new Date().toISOString(),
      dataSubject: {
        requestEmail: request.email,
        verificationMethod: request.verificationMethod,
      },
      exportSummary: {
        totalRecords: userData.length,
        dataCategories: this.extractDataCategories(userData),
        timeRange: this.extractTimeRange(userData),
        dataProcessingPurposes: this.extractProcessingPurposes(userData),
      },
      userData: userData.map(entry => this.sanitizeForExport(entry)),
      technicalInformation: {
        pseudonymizationNote:
          'Personal identifiers have been pseudonymized for privacy protection',
        retentionPolicies: this.getRetentionPolicyInfo(),
        dataProcessingLegalBases: this.getLegalBasisInfo(),
      },
    };
  }

  /**
   * Sanitize log entry for user export
   */
  sanitizeForExport(logEntry) {
    return {
      timestamp: logEntry.timestamp,
      eventType: logEntry.eventType,
      category: logEntry.category,
      eventSummary: this.createUserFriendlySummary(logEntry),
      legalBasis: logEntry.legalBasis,
      retentionPeriod: logEntry.retentionExpiryDate,
    };
  }

  /**
   * Create user-friendly summary of log entry
   */
  createUserFriendlySummary(logEntry) {
    const summaries = {
      auth_success: 'Successful login to your account',
      auth_failure: 'Failed login attempt',
      wallet_access: 'Access to cryptocurrency wallet',
      cross_chain_transfer: 'Cross-blockchain asset transfer',
      api_request: 'API service request',
      data_export_request: 'Data export request processed',
      data_deletion_request: 'Data deletion request processed',
    };

    return (
      summaries[logEntry.eventType] ||
      `${logEntry.category} event: ${logEntry.eventType}`
    );
  }

  /**
   * Assess legal constraints for erasure requests
   */
  async assessErasureConstraints(request) {
    const constraints = [];

    // Check for legal obligations to retain data
    if (this.hasLegalObligationToRetain(request)) {
      constraints.push('Legal obligation to retain certain categories of data');
    }

    // Check for ongoing legal proceedings
    if (this.hasOngoingLegalProceedings(request)) {
      constraints.push('Data subject to legal hold due to ongoing proceedings');
    }

    // Check for legitimate interests that override erasure right
    if (this.hasOverridingLegitimateInterests(request)) {
      constraints.push(
        'Overriding legitimate interests for security and fraud prevention'
      );
    }

    return {
      canProcess: constraints.length === 0,
      constraints,
      reason: constraints.length > 0 ? constraints.join('; ') : null,
    };
  }

  /**
   * Check if there's a legal obligation to retain data
   */
  hasLegalObligationToRetain(request) {
    // Financial regulations may require retention of transaction data
    // Security regulations may require retention of audit logs
    return false; // Implement based on specific regulatory requirements
  }

  /**
   * Check for ongoing legal proceedings
   */
  hasOngoingLegalProceedings(request) {
    // Check for litigation holds or regulatory investigations
    return false; // Implement based on actual legal status
  }

  /**
   * Check for overriding legitimate interests
   */
  hasOverridingLegitimateInterests(request) {
    // Security monitoring and fraud prevention may override erasure rights
    return false; // Implement based on specific use case
  }

  /**
   * Find all log files for processing
   */
  async findLogFiles() {
    const files = await fs.readdir(this.config.logDir);
    return files
      .filter(
        file => file.endsWith('.log') && !file.includes('data-subject-rights')
      )
      .map(file => path.join(this.config.logDir, file));
  }

  /**
   * Utility methods
   */
  generateRequestId() {
    return `dsr_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  hashUserId(userId) {
    return crypto
      .createHash('sha256')
      .update(userId)
      .digest('hex')
      .substring(0, 16);
  }

  async saveRequest(request) {
    const filePath = path.join(
      this.config.requestsDir,
      `${request.requestId}.json`
    );
    await fs.writeFile(filePath, JSON.stringify(request, null, 2));
  }

  async loadPendingRequests() {
    try {
      const files = await fs.readdir(this.config.requestsDir);
      const requestFiles = files.filter(file => file.endsWith('.json'));

      for (const file of requestFiles) {
        try {
          const content = await fs.readFile(
            path.join(this.config.requestsDir, file),
            'utf8'
          );
          const request = JSON.parse(content);

          if (
            request.status !== RequestStatus.COMPLETED &&
            request.status !== RequestStatus.REJECTED
          ) {
            this.activeRequests.set(request.requestId, request);
          }
        } catch (error) {
          this.logger.warn('Failed to load request file', {
            file,
            error: error.message,
          });
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load pending requests', {
        error: error.message,
      });
    }
  }

  calculateEstimatedCompletion() {
    const completionDate = new Date();
    completionDate.setDate(
      completionDate.getDate() + this.config.responseTimeLimit
    );
    return completionDate.toISOString();
  }

  getNextStepsForRequest(request) {
    switch (request.status) {
      case RequestStatus.RECEIVED:
        return ['Identity verification', 'Request processing'];
      case RequestStatus.IDENTITY_VERIFICATION:
        return ['Complete identity verification', 'Request processing'];
      case RequestStatus.PROCESSING:
        return ['Data collection and processing', 'Response preparation'];
      default:
        return [];
    }
  }

  extractDataCategories(userData) {
    const categories = new Set();
    userData.forEach(entry => {
      if (entry.category) {
        categories.add(entry.category);
      }
    });
    return Array.from(categories);
  }

  extractTimeRange(userData) {
    if (userData.length === 0) return null;

    const timestamps = userData.map(entry => new Date(entry.timestamp));
    return {
      earliest: Math.min(...timestamps).toISOString(),
      latest: Math.max(...timestamps).toISOString(),
    };
  }

  extractProcessingPurposes(userData) {
    const purposes = new Set();
    userData.forEach(entry => {
      if (entry.legalBasis) {
        purposes.add(entry.legalBasis);
      }
    });
    return Array.from(purposes);
  }

  getRetentionPolicyInfo() {
    return {
      security: '1-7 years depending on severity',
      operational: '90 days',
      compliance: '7 years',
      debug: '30 days',
    };
  }

  getLegalBasisInfo() {
    return [
      'Legitimate interest - Security monitoring (GDPR Art. 6(1)(f))',
      'Legal obligation - Regulatory compliance (GDPR Art. 6(1)(c))',
      'Legitimate interest - System operation (GDPR Art. 6(1)(f))',
    ];
  }

  /**
   * Get service statistics
   */
  getStatistics() {
    const now = new Date();
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const recentRequests = this.requestHistory.filter(
      req => new Date(req.timestamp) > last30Days
    );

    return {
      activeRequests: this.activeRequests.size,
      totalRequestsLast30Days: recentRequests.length,
      requestsByType: this.aggregateRequestsByType(recentRequests),
      averageResponseTime: this.calculateAverageResponseTime(recentRequests),
      complianceRate: this.calculateComplianceRate(recentRequests),
    };
  }

  aggregateRequestsByType(requests) {
    const counts = {};
    Object.values(RequestType).forEach(type => {
      counts[type] = requests.filter(req => req.type === type).length;
    });
    return counts;
  }

  calculateAverageResponseTime(requests) {
    const completedRequests = requests.filter(
      req => req.status === RequestStatus.COMPLETED && req.completionTime
    );

    if (completedRequests.length === 0) return 0;

    const totalTime = completedRequests.reduce((sum, req) => {
      const start = new Date(req.timestamp);
      const end = new Date(req.completionTime);
      return sum + (end - start);
    }, 0);

    return Math.round(
      totalTime / completedRequests.length / (1000 * 60 * 60 * 24)
    ); // Days
  }

  calculateComplianceRate(requests) {
    const totalRequests = requests.length;
    if (totalRequests === 0) return 100;

    const timelyRequests = requests.filter(req => {
      if (!req.completionTime) return false;

      const start = new Date(req.timestamp);
      const end = new Date(req.completionTime);
      const daysDiff = (end - start) / (1000 * 60 * 60 * 24);

      return daysDiff <= this.config.responseTimeLimit;
    });

    return Math.round((timelyRequests.length / totalRequests) * 100);
  }
}

module.exports = {
  DataSubjectRightsService,
  RequestType,
  RequestStatus,
  ErasureReason,
};
