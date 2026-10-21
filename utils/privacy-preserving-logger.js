/**
 * Privacy-Preserving Logger for WRFCoin
 *
 * Implements GDPR-compliant audit logging with pseudonymization,
 * tamper-evident storage, and automated retention policies.
 */

const crypto = require('crypto');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs').promises;

/**
 * Audit log categories for different types of events
 */
const AuditCategory = {
  SECURITY: 'security',
  OPERATIONAL: 'operational',
  COMPLIANCE: 'compliance',
};

/**
 * Security event types for detailed classification
 */
const SecurityEventType = {
  AUTHENTICATION_SUCCESS: 'auth_success',
  AUTHENTICATION_FAILURE: 'auth_failure',
  AUTHORIZATION_FAILURE: 'authz_failure',
  SUSPICIOUS_ACTIVITY: 'suspicious_activity',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  SECURITY_VIOLATION: 'security_violation',
  WALLET_ACCESS: 'wallet_access',
  CROSS_CHAIN_TRANSFER: 'cross_chain_transfer',
  SMART_CONTRACT_INTERACTION: 'smart_contract_interaction',
  DATA_EXPORT_REQUEST: 'data_export_request',
  DATA_DELETION_REQUEST: 'data_deletion_request',
};

/**
 * Pseudonymizer class for GDPR-compliant data anonymization
 */
class Pseudonymizer {
  constructor() {
    // Load or generate cryptographic secrets
    this.salt = this.loadOrGenerateSalt();
    this.pepper = this.loadOrGeneratePepper();
    this.keyDerivationIterations = 100000; // PBKDF2 iterations
  }

  /**
   * Load or generate salt for pseudonymization
   */
  loadOrGenerateSalt() {
    try {
      const saltPath = path.join(process.cwd(), '.env.salt');
      if (require('fs').existsSync(saltPath)) {
        return Buffer.from(require('fs').readFileSync(saltPath, 'utf8'), 'hex');
      }
    } catch (error) {
      console.warn('Could not load existing salt, generating new one');
    }

    const newSalt = crypto.randomBytes(32);
    // In production, store this securely (HSM, secure key store, etc.)
    try {
      require('fs').writeFileSync(
        path.join(process.cwd(), '.env.salt'),
        newSalt.toString('hex')
      );
    } catch (error) {
      console.warn('Could not persist salt to file');
    }

    return newSalt;
  }

  /**
   * Load or generate pepper for additional security
   */
  loadOrGeneratePepper() {
    // In production, load from secure environment variable or HSM
    const pepperFromEnv = process.env.PRIVACY_LOGGER_PEPPER;
    if (pepperFromEnv) {
      return Buffer.from(pepperFromEnv, 'hex');
    }

    const newPepper = crypto.randomBytes(32);
    console.warn(
      'PRIVACY_LOGGER_PEPPER not set, using generated pepper. Set this environment variable in production.'
    );
    return newPepper;
  }

  /**
   * Pseudonymize an IP address using PBKDF2
   */
  pseudonymizeIpAddress(ipAddress) {
    if (!ipAddress) return null;

    const key = crypto.pbkdf2Sync(
      ipAddress,
      Buffer.concat([this.salt, this.pepper]),
      this.keyDerivationIterations,
      32,
      'sha256'
    );

    return `ip_${key.toString('hex').substring(0, 16)}`;
  }

  /**
   * Pseudonymize a user ID
   */
  pseudonymizeUserId(userId) {
    if (!userId) return null;

    const key = crypto.pbkdf2Sync(
      userId.toString(),
      Buffer.concat([this.salt, this.pepper, Buffer.from('user', 'utf8')]),
      this.keyDerivationIterations,
      32,
      'sha256'
    );

    return `user_${key.toString('hex').substring(0, 16)}`;
  }

  /**
   * Pseudonymize a session ID
   */
  pseudonymizeSessionId(sessionId) {
    if (!sessionId) return null;

    const key = crypto.pbkdf2Sync(
      sessionId,
      Buffer.concat([this.salt, this.pepper, Buffer.from('session', 'utf8')]),
      this.keyDerivationIterations,
      32,
      'sha256'
    );

    return `session_${key.toString('hex').substring(0, 16)}`;
  }

  /**
   * Sanitize user agent string to remove identifying information
   */
  sanitizeUserAgent(userAgent) {
    if (!userAgent) return null;

    // Extract only basic browser/client information
    const patterns = [
      /Chrome\/[\d.]+/,
      /Firefox\/[\d.]+/,
      /Safari\/[\d.]+/,
      /Edge\/[\d.]+/,
      /Opera\/[\d.]+/,
      /Mobile/,
      /Android/,
      /iOS/,
      /Windows/,
      /Mac OS/,
      /Linux/,
    ];

    const extractedInfo = [];
    patterns.forEach(pattern => {
      const match = userAgent.match(pattern);
      if (match) {
        extractedInfo.push(match[0]);
      }
    });

    return extractedInfo.length > 0 ? extractedInfo.join(' ') : 'Unknown';
  }
}

/**
 * Tamper-evident log storage with integrity verification
 */
class TamperEvidentStorage {
  constructor() {
    this.previousLogHash =
      '0000000000000000000000000000000000000000000000000000000000000000';
    this.sequenceNumber = 0;
  }

  /**
   * Calculate hash of log entry for integrity verification
   */
  calculateLogHash(logEntry) {
    // Create deterministic hash by sorting keys
    const hashableData = {
      timestamp: logEntry.timestamp,
      category: logEntry.category,
      eventType: logEntry.eventType,
      logLevel: logEntry.logLevel,
      serviceId: logEntry.serviceId,
      eventData: logEntry.eventData,
      pseudonymizedUserId: logEntry.pseudonymizedUserId,
      pseudonymizedIpAddress: logEntry.pseudonymizedIpAddress,
      pseudonymizedSessionId: logEntry.pseudonymizedSessionId,
    };

    const sortedKeys = Object.keys(hashableData).sort();
    const sortedData = {};
    sortedKeys.forEach(key => {
      if (hashableData[key] !== undefined && hashableData[key] !== null) {
        sortedData[key] = hashableData[key];
      }
    });

    const dataString = JSON.stringify(sortedData);
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }

  /**
   * Calculate chain hash linking this entry to the previous one
   */
  calculateChainHash(entryHash, previousHash) {
    return crypto
      .createHash('sha256')
      .update(previousHash + entryHash)
      .digest('hex');
  }

  /**
   * Add tamper-evident metadata to log entry
   */
  addTamperEvidentMetadata(logEntry) {
    const entryHash = this.calculateLogHash(logEntry);
    const chainHash = this.calculateChainHash(entryHash, this.previousLogHash);

    const tamperEvidentEntry = {
      ...logEntry,
      logId: `log_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`,
      dataHash: entryHash,
      chainHash: chainHash,
      previousHash: this.previousLogHash,
      sequenceNumber: ++this.sequenceNumber,
    };

    // Update chain for next entry
    this.previousLogHash = chainHash;

    return tamperEvidentEntry;
  }

  /**
   * Verify the integrity of a log entry
   */
  verifyLogIntegrity(logEntry) {
    if (!logEntry.dataHash || !logEntry.chainHash || !logEntry.previousHash) {
      return false;
    }

    // Recalculate entry hash
    const recalculatedHash = this.calculateLogHash(logEntry);
    if (recalculatedHash !== logEntry.dataHash) {
      return false;
    }

    // Verify chain integrity
    const expectedChainHash = this.calculateChainHash(
      logEntry.dataHash,
      logEntry.previousHash
    );
    return expectedChainHash === logEntry.chainHash;
  }
}

/**
 * Retention policy manager for automated log cleanup
 */
class RetentionManager {
  constructor() {
    this.retentionPolicies = new Map([
      [AuditCategory.SECURITY, 365 * 3], // 3 years for security logs
      [AuditCategory.OPERATIONAL, 90], // 90 days for operational logs
      [AuditCategory.COMPLIANCE, 365 * 7], // 7 years for compliance logs
    ]);
  }

  /**
   * Calculate retention expiry date for a log entry
   */
  calculateRetentionExpiry(category) {
    const retentionDays = this.retentionPolicies.get(category) || 365;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + retentionDays);
    return expiryDate.toISOString();
  }

  /**
   * Check if a log entry has expired and should be cleaned up
   */
  isExpired(logEntry) {
    if (!logEntry.retentionExpiryDate) {
      return false;
    }

    const expiryDate = new Date(logEntry.retentionExpiryDate);
    return Date.now() > expiryDate.getTime();
  }

  /**
   * Determine the legal basis for data processing
   */
  determineLegalBasis(category, eventType) {
    if (category === AuditCategory.SECURITY) {
      return 'Legitimate interest - Security monitoring and incident response (Art. 6(1)(f) GDPR)';
    } else if (category === AuditCategory.COMPLIANCE) {
      return 'Legal obligation - Regulatory compliance requirements (Art. 6(1)(c) GDPR)';
    } else {
      return 'Legitimate interest - System operation and maintenance (Art. 6(1)(f) GDPR)';
    }
  }
}

/**
 * Main privacy-preserving logger class
 */
class PrivacyPreservingLogger {
  constructor(config = {}) {
    this.config = {
      logLevel: config.logLevel || 'info',
      logDir: config.logDir || path.join(process.cwd(), 'logs'),
      serviceId: config.serviceId || 'wrfcoin-api',
      enableEncryption: config.enableEncryption !== false,
      ...config,
    };

    this.pseudonymizer = new Pseudonymizer();
    this.tamperEvidentStorage = new TamperEvidentStorage();
    this.retentionManager = new RetentionManager();

    this.initialize();
  }

  /**
   * Initialize the logger with secure transports
   */
  async initialize() {
    try {
      // Ensure log directory exists
      await fs.mkdir(this.config.logDir, { recursive: true });

      // Create Winston logger with privacy-preserving transports
      this.logger = winston.createLogger({
        level: this.config.logLevel,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        ),
        transports: [
          // Security audit logs - longest retention
          new DailyRotateFile({
            filename: path.join(
              this.config.logDir,
              'security-audit-%DATE%.log'
            ),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '1095d', // 3 years
            level: 'warn',
          }),

          // Operational logs - medium retention
          new DailyRotateFile({
            filename: path.join(
              this.config.logDir,
              'operational-audit-%DATE%.log'
            ),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '90d',
          }),

          // Compliance logs - longest retention
          new DailyRotateFile({
            filename: path.join(
              this.config.logDir,
              'compliance-audit-%DATE%.log'
            ),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '2555d', // 7 years
            level: 'info',
          }),

          // Console output for development
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize(),
              winston.format.simple()
            ),
            silent: process.env.NODE_ENV === 'production',
          }),
        ],
      });

      console.log(
        `Privacy-preserving logger initialized for service: ${this.config.serviceId}`
      );
    } catch (error) {
      console.error('Failed to initialize privacy-preserving logger:', error);
      throw error;
    }
  }

  /**
   * Create a privacy-compliant audit log entry
   */
  createAuditLogEntry(
    category,
    eventType,
    logLevel,
    eventData,
    userContext = {}
  ) {
    const timestamp = new Date().toISOString();

    // Pseudonymize personal identifiers
    const pseudonymizedUserId = userContext.userId
      ? this.pseudonymizer.pseudonymizeUserId(userContext.userId)
      : null;

    const pseudonymizedIpAddress = userContext.ipAddress
      ? this.pseudonymizer.pseudonymizeIpAddress(userContext.ipAddress)
      : null;

    const pseudonymizedSessionId = userContext.sessionId
      ? this.pseudonymizer.pseudonymizeSessionId(userContext.sessionId)
      : null;

    // Sanitize user agent
    const sanitizedUserAgent = userContext.userAgent
      ? this.pseudonymizer.sanitizeUserAgent(userContext.userAgent)
      : null;

    // Create base log entry
    const baseLogEntry = {
      timestamp,
      logLevel,
      category,
      eventType,
      serviceId: this.config.serviceId,

      // Pseudonymized identifiers
      pseudonymizedUserId,
      pseudonymizedIpAddress,
      pseudonymizedSessionId,

      // Sanitized metadata
      userAgent: sanitizedUserAgent,

      // Event-specific data (should not contain PII)
      eventData: this.sanitizeEventData(eventData),

      // GDPR compliance metadata
      retentionExpiryDate:
        this.retentionManager.calculateRetentionExpiry(category),
      legalBasis: this.retentionManager.determineLegalBasis(
        category,
        eventType
      ),

      // Technical metadata
      version: '1.0.0',
    };

    // Add tamper-evident metadata
    return this.tamperEvidentStorage.addTamperEvidentMetadata(baseLogEntry);
  }

  /**
   * Sanitize event data to remove potential PII
   */
  sanitizeEventData(eventData) {
    if (!eventData || typeof eventData !== 'object') {
      return eventData;
    }

    const sanitized = { ...eventData };

    // Remove or redact known PII fields
    const piiFields = [
      'password',
      'privateKey',
      'mnemonic',
      'seed',
      'email',
      'phoneNumber',
      'ssn',
      'creditCard',
      'bankAccount',
    ];

    piiFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });

    // Truncate long strings that might contain PII
    Object.keys(sanitized).forEach(key => {
      if (typeof sanitized[key] === 'string' && sanitized[key].length > 1000) {
        sanitized[key] = sanitized[key].substring(0, 1000) + '[TRUNCATED]';
      }
    });

    return sanitized;
  }

  /**
   * Log a security event
   */
  logSecurityEvent(
    eventType,
    eventData,
    userContext = {},
    severity = 'MEDIUM'
  ) {
    const enhancedEventData = {
      ...eventData,
      severity,
      securityEventType: eventType,
    };

    const logEntry = this.createAuditLogEntry(
      AuditCategory.SECURITY,
      eventType,
      severity === 'CRITICAL' ? 'error' : 'warn',
      enhancedEventData,
      userContext
    );

    this.logger.log(logEntry.logLevel, 'Security Event', logEntry);
    return logEntry.logId;
  }

  /**
   * Log an operational event
   */
  logOperationalEvent(eventType, eventData, userContext = {}) {
    const logEntry = this.createAuditLogEntry(
      AuditCategory.OPERATIONAL,
      eventType,
      'info',
      eventData,
      userContext
    );

    this.logger.info('Operational Event', logEntry);
    return logEntry.logId;
  }

  /**
   * Log a compliance event
   */
  logComplianceEvent(eventType, eventData, userContext = {}) {
    const logEntry = this.createAuditLogEntry(
      AuditCategory.COMPLIANCE,
      eventType,
      'info',
      eventData,
      userContext
    );

    this.logger.info('Compliance Event', logEntry);
    return logEntry.logId;
  }

  /**
   * Log authentication events
   */
  logAuthentication(success, userContext, reason = null) {
    const eventType = success
      ? SecurityEventType.AUTHENTICATION_SUCCESS
      : SecurityEventType.AUTHENTICATION_FAILURE;

    const eventData = {
      success,
      reason,
      timestamp: new Date().toISOString(),
    };

    return this.logSecurityEvent(
      eventType,
      eventData,
      userContext,
      success ? 'LOW' : 'MEDIUM'
    );
  }

  /**
   * Log wallet access events
   */
  logWalletAccess(operation, walletAddress, userContext, additionalData = {}) {
    const eventData = {
      operation,
      walletAddress: walletAddress
        ? `wallet_${crypto.createHash('sha256').update(walletAddress).digest('hex').substring(0, 16)}`
        : null,
      ...additionalData,
    };

    return this.logSecurityEvent(
      SecurityEventType.WALLET_ACCESS,
      eventData,
      userContext,
      'HIGH'
    );
  }

  /**
   * Log cross-chain transfer events
   */
  logCrossChainTransfer(transferData, userContext) {
    const eventData = {
      fromChain: transferData.fromChain,
      toChain: transferData.toChain,
      amount: transferData.amount,
      token: transferData.token,
      transferId: transferData.transferId,
      // Pseudonymize addresses
      fromAddressHash: transferData.fromAddress
        ? crypto
            .createHash('sha256')
            .update(transferData.fromAddress)
            .digest('hex')
            .substring(0, 16)
        : null,
      toAddressHash: transferData.toAddress
        ? crypto
            .createHash('sha256')
            .update(transferData.toAddress)
            .digest('hex')
            .substring(0, 16)
        : null,
    };

    return this.logSecurityEvent(
      SecurityEventType.CROSS_CHAIN_TRANSFER,
      eventData,
      userContext,
      transferData.amount > 1000 ? 'HIGH' : 'MEDIUM'
    );
  }

  /**
   * Log data subject request events (GDPR compliance)
   */
  logDataSubjectRequest(requestType, requestData, userContext) {
    const eventType =
      requestType === 'ACCESS'
        ? SecurityEventType.DATA_EXPORT_REQUEST
        : SecurityEventType.DATA_DELETION_REQUEST;

    const eventData = {
      requestType,
      requestId: requestData.requestId,
      dataCategories: requestData.dataCategories || [],
      status: requestData.status || 'RECEIVED',
    };

    return this.logComplianceEvent(eventType, eventData, userContext);
  }

  /**
   * Verify log integrity for a specific log entry
   */
  verifyLogIntegrity(logEntry) {
    return this.tamperEvidentStorage.verifyLogIntegrity(logEntry);
  }

  /**
   * Get retention policy information
   */
  getRetentionInfo() {
    return {
      policies: Object.fromEntries(this.retentionManager.retentionPolicies),
      calculatedExpiryDates: {
        security: this.retentionManager.calculateRetentionExpiry(
          AuditCategory.SECURITY
        ),
        operational: this.retentionManager.calculateRetentionExpiry(
          AuditCategory.OPERATIONAL
        ),
        compliance: this.retentionManager.calculateRetentionExpiry(
          AuditCategory.COMPLIANCE
        ),
      },
    };
  }
}

module.exports = {
  PrivacyPreservingLogger,
  AuditCategory,
  SecurityEventType,
  Pseudonymizer,
  TamperEvidentStorage,
  RetentionManager,
};
