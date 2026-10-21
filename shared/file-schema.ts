/**
 * File Storage & Permission Database Schema
 * Defines tables for file management, permissions, and access control
 */

import { relations } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
} from 'drizzle-orm/pg-core';

// Permission levels enum
export const PERMISSION_LEVELS = [
  'READ',
  'WRITE',
  'DELETE',
  'SHARE',
  'ADMIN',
] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

// File visibility levels
export const FILE_VISIBILITY = [
  'PRIVATE',
  'SHARED',
  'PUBLIC',
  'RESTRICTED',
] as const;

export type FileVisibility = (typeof FILE_VISIBILITY)[number];

// Hash algorithms for integrity verification
export const HASH_ALGORITHMS = [
  'SHA256',
  'BLAKE2B',
  'MD5',
  'SHA1',
  'SHA512',
] as const;

export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

// Integrity verification status
export const INTEGRITY_STATUS = [
  'VERIFIED',
  'CORRUPTED',
  'VERIFICATION_FAILED',
  'PENDING',
] as const;

export type IntegrityStatus = (typeof INTEGRITY_STATUS)[number];

// File categories for cleanup policies
export const FILE_CATEGORIES = [
  'DOCUMENT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'ARCHIVE',
  'DATA',
  'TEMPORARY',
  'SYSTEM',
] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];

// Files table - stores file metadata and references
export const files = pgTable(
  'files',
  {
    id: serial('id').primaryKey(),
    fileId: text('file_id').notNull().unique(), // UUID for external reference
    userId: integer('user_id').notNull(), // Owner of the file
    originalName: text('original_name').notNull(),
    filename: text('filename').notNull(), // Secure filename used for storage
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    storageProvider: text('storage_provider').notNull().default('S3'), // S3, local, IPFS, etc.
    storagePath: text('storage_path').notNull(), // S3 key or file path
    checksum: text('checksum').notNull(), // SHA-256 hash for integrity
    visibility: text('visibility').notNull().default('PRIVATE'),
    isEncrypted: boolean('is_encrypted').notNull().default(false),
    encryptionKeyId: text('encryption_key_id'), // Vault key ID if encrypted
    uploadedAt: timestamp('uploaded_at').notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at'),
    lastIntegrityCheck: timestamp('last_integrity_check'), // Last integrity verification
    expiresAt: timestamp('expires_at'), // Optional file expiration
    status: text('status').notNull().default('ACTIVE'), // ACTIVE, ARCHIVED, DELETED
    category: text('category').default('DOCUMENT'), // File category for cleanup policies
    isArchived: boolean('is_archived').notNull().default(false), // Archive flag for cleanup
    archivedAt: timestamp('archived_at'), // When file was archived
    tags: jsonb('tags'), // Array of tags for categorization
    metadata: jsonb('metadata'), // Additional file metadata
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    fileIdIdx: index('files_file_id_idx').on(table.fileId),
    userIdIdx: index('files_user_id_idx').on(table.userId),
    visibilityIdx: index('files_visibility_idx').on(table.visibility),
    statusIdx: index('files_status_idx').on(table.status),
    categoryIdx: index('files_category_idx').on(table.category),
    isArchivedIdx: index('files_is_archived_idx').on(table.isArchived),
    expiresAtIdx: index('files_expires_at_idx').on(table.expiresAt),
  })
);

// File permissions table - role-based access control for files
export const filePermissions = pgTable(
  'file_permissions',
  {
    id: serial('id').primaryKey(),
    fileId: text('file_id').notNull(),
    userId: integer('user_id').notNull(), // User being granted permission
    grantedByUserId: integer('granted_by_user_id').notNull(), // User who granted permission
    permission: text('permission').notNull(), // READ, WRITE, DELETE, SHARE, ADMIN
    grantedAt: timestamp('granted_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at'), // Optional permission expiration
    isActive: boolean('is_active').notNull().default(true),
    conditions: jsonb('conditions'), // Additional access conditions (IP ranges, time limits, etc.)
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    fileUserIdx: index('file_permissions_file_user_idx').on(
      table.fileId,
      table.userId
    ),
    fileIdIdx: index('file_permissions_file_id_idx').on(table.fileId),
    userIdIdx: index('file_permissions_user_id_idx').on(table.userId),
    permissionIdx: index('file_permissions_permission_idx').on(
      table.permission
    ),
    activeIdx: index('file_permissions_active_idx').on(table.isActive),
  })
);

// File access logs table - audit trail for file access
export const fileAccessLogs = pgTable(
  'file_access_logs',
  {
    id: serial('id').primaryKey(),
    fileId: text('file_id').notNull(),
    userId: integer('user_id').notNull(),
    action: text('action').notNull(), // READ, WRITE, DELETE, SHARE, DOWNLOAD, UPLOAD
    permission: text('permission').notNull(), // Permission used for access
    success: boolean('success').notNull(),
    errorCode: text('error_code'), // Error code if access failed
    errorMessage: text('error_message'), // Error message if access failed
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    sessionId: text('session_id'),
    requestId: text('request_id'), // For tracking across services
    accessedAt: timestamp('accessed_at').notNull().defaultNow(),
    duration: integer('duration'), // Access duration in milliseconds
    bytesTransferred: integer('bytes_transferred'), // For download/upload operations
    metadata: jsonb('metadata'), // Additional context
  },
  table => ({
    fileIdIdx: index('file_access_logs_file_id_idx').on(table.fileId),
    userIdIdx: index('file_access_logs_user_id_idx').on(table.userId),
    actionIdx: index('file_access_logs_action_idx').on(table.action),
    timestampIdx: index('file_access_logs_timestamp_idx').on(table.accessedAt),
    successIdx: index('file_access_logs_success_idx').on(table.success),
  })
);

// File shares table - for sharing files with external entities
export const fileShares = pgTable(
  'file_shares',
  {
    id: serial('id').primaryKey(),
    fileId: text('file_id').notNull(),
    sharedByUserId: integer('shared_by_user_id').notNull(),
    shareToken: text('share_token').notNull().unique(), // Secure token for access
    shareType: text('share_type').notNull().default('LINK'), // LINK, EMAIL, USER
    permissions: jsonb('permissions').notNull(), // Array of permissions granted
    maxAccesses: integer('max_accesses'), // Optional access limit
    currentAccesses: integer('current_accesses').notNull().default(0),
    passwordProtected: boolean('password_protected').notNull().default(false),
    passwordHash: text('password_hash'), // Bcrypt hash if password protected
    expiresAt: timestamp('expires_at'),
    isActive: boolean('is_active').notNull().default(true),
    recipientEmail: text('recipient_email'), // If shared via email
    recipientUserId: integer('recipient_user_id'), // If shared with specific user
    notificationSent: boolean('notification_sent').notNull().default(false),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    fileIdIdx: index('file_shares_file_id_idx').on(table.fileId),
    shareTokenIdx: index('file_shares_token_idx').on(table.shareToken),
    sharedByIdx: index('file_shares_shared_by_idx').on(table.sharedByUserId),
    activeIdx: index('file_shares_active_idx').on(table.isActive),
  })
);

// File integrity logs table - tracks integrity verification results
export const fileIntegrityLogs = pgTable(
  'file_integrity_logs',
  {
    id: serial('id').primaryKey(),
    fileId: text('file_id').notNull(),
    userId: integer('user_id').notNull(),
    verificationMethod: text('verification_method').notNull(), // CHECKSUM, BINARY_COMPARISON, MULTI_ALGORITHM
    algorithmsUsed: jsonb('algorithms_used').notNull(), // Array of hash algorithms used
    status: text('status').notNull(), // VERIFIED, CORRUPTED, VERIFICATION_FAILED, PENDING
    verifiedAt: timestamp('verified_at').notNull().defaultNow(),
    verificationTime: integer('verification_time'), // Verification duration in milliseconds
    issuesFound: jsonb('issues_found'), // Array of issues discovered
    hashResults: jsonb('hash_results'), // Object with algorithm -> hash mappings
    storageSourcesChecked: integer('storage_sources_checked').default(0),
    corruptionType: text('corruption_type'), // CHECKSUM_MISMATCH, SIZE_MISMATCH, BINARY_CORRUPTION, STORAGE_FAILURE
    recoveryRecommendations: jsonb('recovery_recommendations'), // Array of recovery suggestions
    metadata: jsonb('metadata'), // Additional verification metadata
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    fileIdIdx: index('file_integrity_logs_file_id_idx').on(table.fileId),
    userIdIdx: index('file_integrity_logs_user_id_idx').on(table.userId),
    statusIdx: index('file_integrity_logs_status_idx').on(table.status),
    verifiedAtIdx: index('file_integrity_logs_verified_at_idx').on(
      table.verifiedAt
    ),
    verificationMethodIdx: index('file_integrity_logs_method_idx').on(
      table.verificationMethod
    ),
  })
);

// Relations
export const filesRelations = relations(files, ({ many, one }) => ({
  permissions: many(filePermissions),
  accessLogs: many(fileAccessLogs),
  shares: many(fileShares),
  integrityLogs: many(fileIntegrityLogs),
}));

export const filePermissionsRelations = relations(
  filePermissions,
  ({ one }) => ({
    file: one(files, {
      fields: [filePermissions.fileId],
      references: [files.fileId],
    }),
  })
);

export const fileAccessLogsRelations = relations(fileAccessLogs, ({ one }) => ({
  file: one(files, {
    fields: [fileAccessLogs.fileId],
    references: [files.fileId],
  }),
}));

export const fileSharesRelations = relations(fileShares, ({ one }) => ({
  file: one(files, {
    fields: [fileShares.fileId],
    references: [files.fileId],
  }),
}));

export const fileIntegrityLogsRelations = relations(
  fileIntegrityLogs,
  ({ one }) => ({
    file: one(files, {
      fields: [fileIntegrityLogs.fileId],
      references: [files.fileId],
    }),
  })
);

// File versions table - tracks file version history
export const fileVersions = pgTable(
  'file_versions',
  {
    id: serial('id').primaryKey(),
    versionId: text('version_id').notNull().unique(), // UUID for external reference
    fileId: text('file_id').notNull(), // Reference to main file record
    versionNumber: integer('version_number').notNull(), // Auto-incrementing version number
    storagePath: text('storage_path').notNull(), // S3 key for this version
    storageProvider: text('storage_provider').notNull().default('S3'),
    fileSize: integer('file_size').notNull(),
    checksum: text('checksum').notNull(), // SHA-256 hash
    createdBy: integer('created_by').notNull(), // User who created this version
    comment: text('comment'), // Optional version comment/description
    isActive: boolean('is_active').notNull().default(true), // Active version flag
    isCurrentVersion: boolean('is_current_version').notNull().default(false), // Current active version
    metadata: jsonb('metadata'), // Additional version metadata
    createdAt: timestamp('created_at').notNull().defaultNow(),
    archivedAt: timestamp('archived_at'), // When version was archived
  },
  table => ({
    fileIdIdx: index('file_versions_file_id_idx').on(table.fileId),
    versionIdIdx: index('file_versions_version_id_idx').on(table.versionId),
    fileVersionIdx: index('file_versions_file_version_idx').on(
      table.fileId,
      table.versionNumber
    ),
    currentVersionIdx: index('file_versions_current_idx').on(
      table.fileId,
      table.isCurrentVersion
    ),
    createdByIdx: index('file_versions_created_by_idx').on(table.createdBy),
  })
);

// File versions relations
export const fileVersionsRelations = relations(fileVersions, ({ one }) => ({
  file: one(files, {
    fields: [fileVersions.fileId],
    references: [files.fileId],
  }),
}));

// Add versions relation to files
export const filesVersionsRelations = relations(files, ({ many }) => ({
  versions: many(fileVersions),
}));

// Type exports for file versions
export type FileVersion = typeof fileVersions.$inferSelect;
export type InsertFileVersion = typeof fileVersions.$inferInsert;

// Encryption algorithms supported
export const ENCRYPTION_ALGORITHMS = [
  'AES-256-GCM',
  'AES-256-CBC',
  'CHACHA20-POLY1305',
] as const;

export type EncryptionAlgorithm = (typeof ENCRYPTION_ALGORITHMS)[number];

// File encryption keys table - stores DEKs encrypted with HSM KEK (envelope encryption)
export const fileEncryptionKeys = pgTable(
  'file_encryption_keys',
  {
    id: serial('id').primaryKey(),
    keyId: text('key_id').notNull().unique(), // UUID for external reference
    fileId: text('file_id').notNull(), // Reference to encrypted file
    encryptedKey: text('encrypted_key').notNull(), // DEK encrypted with HSM KEK (base64)
    iv: text('iv').notNull(), // Initialization vector (base64, 12-16 bytes)
    authTag: text('auth_tag').notNull(), // GCM authentication tag (base64, 16 bytes)
    algorithm: text('algorithm').notNull().default('AES-256-GCM'), // Encryption algorithm
    kekHandle: text('kek_handle').notNull(), // HSM Key Encryption Key handle/identifier
    keyVersion: integer('key_version').notNull().default(1), // For key rotation support
    isActive: boolean('is_active').notNull().default(true), // Key status
    metadata: jsonb('metadata'), // Additional encryption metadata
    createdAt: timestamp('created_at').notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at'), // When key was rotated
    expiresAt: timestamp('expires_at'), // Optional key expiration
  },
  table => ({
    keyIdIdx: index('file_encryption_keys_key_id_idx').on(table.keyId),
    fileIdIdx: index('file_encryption_keys_file_id_idx').on(table.fileId),
    kekHandleIdx: index('file_encryption_keys_kek_handle_idx').on(table.kekHandle),
    activeIdx: index('file_encryption_keys_active_idx').on(table.isActive),
  })
);

// File encryption keys relations
export const fileEncryptionKeysRelations = relations(
  fileEncryptionKeys,
  ({ one }) => ({
    file: one(files, {
      fields: [fileEncryptionKeys.fileId],
      references: [files.fileId],
    }),
  })
);

// Type exports for file encryption keys
export type FileEncryptionKey = typeof fileEncryptionKeys.$inferSelect;
export type InsertFileEncryptionKey = typeof fileEncryptionKeys.$inferInsert;

// Security audit events table - tracks security-related events
export const securityAuditEvents = pgTable(
  'security_audit_events',
  {
    id: serial('id').primaryKey(),
    eventType: text('event_type').notNull(), // AUTHENTICATION, AUTHORIZATION, PERMISSION_CHANGE, ACCESS_VIOLATION, ADMIN_ACTION
    eventCategory: text('event_category').notNull(), // SECURITY, COMPLIANCE, SYSTEM, USER_ACTION
    userId: integer('user_id'),
    targetUserId: integer('target_user_id'), // User being affected by the action
    fileId: text('file_id'), // Associated file if applicable
    resourceType: text('resource_type'), // FILE, USER, SYSTEM, PERMISSION, SHARE
    resourceId: text('resource_id'), // ID of the affected resource
    action: text('action').notNull(), // LOGIN, LOGOUT, GRANT_PERMISSION, REVOKE_PERMISSION, etc.
    result: text('result').notNull(), // SUCCESS, FAILURE, DENIED, ERROR
    severity: text('severity').notNull().default('MEDIUM'), // LOW, MEDIUM, HIGH, CRITICAL
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    sessionId: text('session_id'),
    requestId: text('request_id'),
    details: jsonb('details'), // Additional event-specific data
    errorCode: text('error_code'), // Error code if applicable
    errorMessage: text('error_message'), // Error message if applicable
    geolocation: jsonb('geolocation'), // IP-based location data
    deviceFingerprint: text('device_fingerprint'), // Device identification
    riskScore: integer('risk_score'), // Calculated risk score (0-100)
    complianceFlags: jsonb('compliance_flags'), // Compliance-related flags
    remedialActions: jsonb('remedial_actions'), // Actions taken in response
    eventTime: timestamp('event_time').notNull().defaultNow(),
    processedAt: timestamp('processed_at'), // When the event was processed/analyzed
    metadata: jsonb('metadata'), // Additional context
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    eventTypeIdx: index('security_audit_events_event_type_idx').on(
      table.eventType
    ),
    userIdIdx: index('security_audit_events_user_id_idx').on(table.userId),
    fileIdIdx: index('security_audit_events_file_id_idx').on(table.fileId),
    eventTimeIdx: index('security_audit_events_event_time_idx').on(
      table.eventTime
    ),
    severityIdx: index('security_audit_events_severity_idx').on(table.severity),
    resultIdx: index('security_audit_events_result_idx').on(table.result),
    resourceTypeIdx: index('security_audit_events_resource_type_idx').on(
      table.resourceType
    ),
  })
);

// System activity logs table - tracks system operations and health events
export const systemActivityLogs = pgTable(
  'system_activity_logs',
  {
    id: serial('id').primaryKey(),
    activityType: text('activity_type').notNull(), // STORAGE_OPERATION, HEALTH_CHECK, MONITORING, BACKUP, MAINTENANCE
    activityCategory: text('activity_category').notNull(), // SYSTEM, STORAGE, NETWORK, PERFORMANCE, SECURITY
    component: text('component').notNull(), // storage-service, integrity-service, auth-service, etc.
    operation: text('operation').notNull(), // UPLOAD, DOWNLOAD, VERIFY, BACKUP, SYNC, etc.
    status: text('status').notNull(), // SUCCESS, FAILURE, WARNING, IN_PROGRESS, CANCELLED
    priority: text('priority').notNull().default('MEDIUM'), // LOW, MEDIUM, HIGH, CRITICAL
    fileId: text('file_id'), // Associated file if applicable
    userId: integer('user_id'), // User who initiated the operation
    storageProvider: text('storage_provider'), // Storage provider involved
    networkProvider: text('network_provider'), // Network provider involved
    startTime: timestamp('start_time').notNull(),
    endTime: timestamp('end_time'),
    duration: integer('duration'), // Operation duration in milliseconds
    bytesProcessed: integer('bytes_processed'), // Data processed in bytes
    resourcesUsed: jsonb('resources_used'), // CPU, memory, storage usage
    performanceMetrics: jsonb('performance_metrics'), // Performance-related data
    healthIndicators: jsonb('health_indicators'), // System health metrics
    errorDetails: jsonb('error_details'), // Error information if applicable
    warningMessages: jsonb('warning_messages'), // Warning messages
    configurationUsed: jsonb('configuration_used'), // Configuration parameters used
    environmentInfo: jsonb('environment_info'), // Environment context
    auditTrail: jsonb('audit_trail'), // Related audit events
    alertsTriggered: jsonb('alerts_triggered'), // Alerts generated by this activity
    metadata: jsonb('metadata'), // Additional context
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    activityTypeIdx: index('system_activity_logs_activity_type_idx').on(
      table.activityType
    ),
    componentIdx: index('system_activity_logs_component_idx').on(
      table.component
    ),
    statusIdx: index('system_activity_logs_status_idx').on(table.status),
    startTimeIdx: index('system_activity_logs_start_time_idx').on(
      table.startTime
    ),
    fileIdIdx: index('system_activity_logs_file_id_idx').on(table.fileId),
    userIdIdx: index('system_activity_logs_user_id_idx').on(table.userId),
    priorityIdx: index('system_activity_logs_priority_idx').on(table.priority),
  })
);

// Audit reports table - stores generated audit reports
export const auditReports = pgTable(
  'audit_reports',
  {
    id: serial('id').primaryKey(),
    reportId: text('report_id').notNull().unique(), // UUID for external reference
    reportType: text('report_type').notNull(), // SECURITY, COMPLIANCE, SYSTEM, PERFORMANCE, INTEGRITY
    reportCategory: text('report_category').notNull(), // DAILY, WEEKLY, MONTHLY, QUARTERLY, ANNUAL, CUSTOM
    title: text('title').notNull(),
    description: text('description'),
    generatedBy: integer('generated_by').notNull(), // User who generated the report
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    status: text('status').notNull().default('GENERATING'), // GENERATING, COMPLETED, FAILED, ARCHIVED
    format: text('format').notNull().default('JSON'), // JSON, PDF, CSV, HTML
    fileSize: integer('file_size'), // Report file size in bytes
    filePath: text('file_path'), // Path to generated report file
    downloadUrl: text('download_url'), // URL for downloading the report
    expiresAt: timestamp('expires_at'), // When report expires and should be deleted
    parameters: jsonb('parameters'), // Parameters used to generate the report
    summary: jsonb('summary'), // Executive summary of findings
    findings: jsonb('findings'), // Detailed findings and metrics
    recommendations: jsonb('recommendations'), // Recommendations based on findings
    complianceStatus: jsonb('compliance_status'), // Compliance assessment results
    riskAssessment: jsonb('risk_assessment'), // Risk analysis results
    actionItems: jsonb('action_items'), // Recommended actions
    distributionList: jsonb('distribution_list'), // Users/roles to receive the report
    generationTime: integer('generation_time'), // Time taken to generate report
    recordsProcessed: integer('records_processed'), // Number of records analyzed
    errorLog: jsonb('error_log'), // Any errors encountered during generation
    metadata: jsonb('metadata'), // Additional report metadata
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    reportIdIdx: index('audit_reports_report_id_idx').on(table.reportId),
    reportTypeIdx: index('audit_reports_report_type_idx').on(table.reportType),
    generatedByIdx: index('audit_reports_generated_by_idx').on(
      table.generatedBy
    ),
    statusIdx: index('audit_reports_status_idx').on(table.status),
    createdAtIdx: index('audit_reports_created_at_idx').on(table.createdAt),
    periodIdx: index('audit_reports_period_idx').on(
      table.periodStart,
      table.periodEnd
    ),
  })
);

// Compliance audit trail table - specific compliance-related audit entries
export const complianceAuditTrail = pgTable(
  'compliance_audit_trail',
  {
    id: serial('id').primaryKey(),
    auditId: text('audit_id').notNull().unique(), // UUID for external reference
    complianceFramework: text('compliance_framework').notNull(), // SOC2, GDPR, HIPAA, PCI_DSS, ISO27001
    requirementId: text('requirement_id').notNull(), // Specific requirement within framework
    requirementDescription: text('requirement_description').notNull(),
    entityType: text('entity_type').notNull(), // FILE, USER, SYSTEM, PROCESS, POLICY
    entityId: text('entity_id').notNull(), // ID of the entity being audited
    assessmentType: text('assessment_type').notNull(), // AUTOMATED, MANUAL, PERIODIC, TRIGGERED
    assessmentResult: text('assessment_result').notNull(), // COMPLIANT, NON_COMPLIANT, PARTIAL, UNKNOWN
    confidenceLevel: text('confidence_level').notNull(), // LOW, MEDIUM, HIGH, VERIFIED
    assessorId: integer('assessor_id'), // User who performed the assessment
    assessorType: text('assessor_type').notNull(), // SYSTEM, HUMAN, THIRD_PARTY
    evidenceCollected: jsonb('evidence_collected'), // Evidence supporting the assessment
    controlsEvaluated: jsonb('controls_evaluated'), // Security controls evaluated
    findings: jsonb('findings'), // Detailed findings
    nonComplianceReasons: jsonb('non_compliance_reasons'), // Reasons for non-compliance
    remediationRequired: boolean('remediation_required')
      .notNull()
      .default(false),
    remediationPlan: jsonb('remediation_plan'), // Plan to address non-compliance
    remediationDeadline: timestamp('remediation_deadline'), // Deadline for remediation
    riskLevel: text('risk_level').notNull().default('MEDIUM'), // LOW, MEDIUM, HIGH, CRITICAL
    businessImpact: text('business_impact'), // Impact on business operations
    regulatoryImplications: jsonb('regulatory_implications'), // Regulatory consequences
    previousAssessmentId: text('previous_assessment_id'), // Reference to previous assessment
    changesSinceLastAssessment: jsonb('changes_since_last_assessment'), // Changes since last audit
    assessmentPeriod: jsonb('assessment_period'), // Time period covered by assessment
    nextAssessmentDue: timestamp('next_assessment_due'), // When next assessment is due
    auditTrailReferences: jsonb('audit_trail_references'), // References to related audit events
    documentationLinks: jsonb('documentation_links'), // Links to relevant documentation
    approvalStatus: text('approval_status').default('PENDING'), // PENDING, APPROVED, REJECTED
    approvedBy: integer('approved_by'), // User who approved the assessment
    approvedAt: timestamp('approved_at'), // When the assessment was approved
    assessedAt: timestamp('assessed_at').notNull().defaultNow(),
    metadata: jsonb('metadata'), // Additional compliance metadata
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    auditIdIdx: index('compliance_audit_trail_audit_id_idx').on(table.auditId),
    frameworkIdx: index('compliance_audit_trail_framework_idx').on(
      table.complianceFramework
    ),
    entityIdx: index('compliance_audit_trail_entity_idx').on(
      table.entityType,
      table.entityId
    ),
    resultIdx: index('compliance_audit_trail_result_idx').on(
      table.assessmentResult
    ),
    assessedAtIdx: index('compliance_audit_trail_assessed_at_idx').on(
      table.assessedAt
    ),
    riskLevelIdx: index('compliance_audit_trail_risk_level_idx').on(
      table.riskLevel
    ),
    nextDueIdx: index('compliance_audit_trail_next_due_idx').on(
      table.nextAssessmentDue
    ),
  })
);

// Extended relations
export const securityAuditEventsRelations = relations(
  securityAuditEvents,
  ({ one }) => ({
    file: one(files, {
      fields: [securityAuditEvents.fileId],
      references: [files.fileId],
    }),
  })
);

export const systemActivityLogsRelations = relations(
  systemActivityLogs,
  ({ one }) => ({
    file: one(files, {
      fields: [systemActivityLogs.fileId],
      references: [files.fileId],
    }),
  })
);

export const auditReportsRelations = relations(auditReports, ({ many }) => ({
  // Could relate to specific audit events or findings
}));

export const complianceAuditTrailRelations = relations(
  complianceAuditTrail,
  ({ one }) => ({
    // Could relate to specific entities being audited
  })
);

// Enhanced file relations to include audit tables
export const filesAuditRelations = relations(files, ({ many }) => ({
  permissions: many(filePermissions),
  accessLogs: many(fileAccessLogs),
  shares: many(fileShares),
  integrityLogs: many(fileIntegrityLogs),
  securityEvents: many(securityAuditEvents),
  systemActivities: many(systemActivityLogs),
}));

// Types for TypeScript
export type File = typeof files.$inferSelect;
export type InsertFile = typeof files.$inferInsert;
export type FilePermission = typeof filePermissions.$inferSelect;
export type InsertFilePermission = typeof filePermissions.$inferInsert;
export type FileAccessLog = typeof fileAccessLogs.$inferSelect;
export type InsertFileAccessLog = typeof fileAccessLogs.$inferInsert;
export type FileShare = typeof fileShares.$inferSelect;
export type InsertFileShare = typeof fileShares.$inferInsert;
export type FileIntegrityLog = typeof fileIntegrityLogs.$inferSelect;
export type InsertFileIntegrityLog = typeof fileIntegrityLogs.$inferInsert;
export type SecurityAuditEvent = typeof securityAuditEvents.$inferSelect;
export type InsertSecurityAuditEvent = typeof securityAuditEvents.$inferInsert;
export type SystemActivityLog = typeof systemActivityLogs.$inferSelect;
export type InsertSystemActivityLog = typeof systemActivityLogs.$inferInsert;
export type AuditReport = typeof auditReports.$inferSelect;
export type InsertAuditReport = typeof auditReports.$inferInsert;
export type ComplianceAuditTrail = typeof complianceAuditTrail.$inferSelect;
export type InsertComplianceAuditTrail =
  typeof complianceAuditTrail.$inferInsert;
