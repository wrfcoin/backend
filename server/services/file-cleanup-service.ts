/**
 * File Cleanup Service
 *
 * Implements retention policies and automated cleanup for WRFCoin file storage.
 * Features:
 * - Scheduled daily cleanup at 3 AM via node-cron
 * - Multiple retention policies for different file categories
 * - Orphaned S3 object detection and cleanup
 * - Full audit logging of all cleanup operations
 * - Dry run mode for testing
 */

import * as drizzleOrm from 'drizzle-orm';
import type * as drizzleOrmEsm from '../../node_modules/drizzle-orm/index.js';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { db } from '../../database/db.js';
import { files, fileVersions, fileEncryptionKeys } from '../../shared/file-schema.js';
import { AuditService, FILE_AUDIT_EVENTS } from './audit-service.js';
import { appLogger as logger } from '../utils/logger.js';

const { eq, lt, and, isNull, sql, inArray, gte } =
  drizzleOrm as unknown as typeof drizzleOrmEsm;

// ============================================================================
// Types and Interfaces
// ============================================================================

export type FileCategory =
  | 'temporary'
  | 'expired'
  | 'orphaned'
  | 'inactive_user'
  | 'old_version'
  | 'access_log';

export type CleanupAction = 'delete' | 'archive' | 'anonymize';

export interface RetentionPolicy {
  category: FileCategory;
  retentionDays: number;
  action: CleanupAction;
  description: string;
  enabled: boolean;
}

export interface CleanupResult {
  category: FileCategory;
  action: CleanupAction;
  filesProcessed: number;
  bytesFreed: number;
  errors: string[];
  startTime: Date;
  endTime: Date;
}

export interface CleanupReport {
  runId: string;
  startTime: Date;
  endTime: Date;
  dryRun: boolean;
  results: CleanupResult[];
  totalFilesProcessed: number;
  totalBytesFreed: number;
  totalErrors: number;
}

export interface OrphanedObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface FileCleanupServiceConfig {
  s3Bucket: string;
  s3Region?: string;
  archiveBucket?: string;
  cronSchedule?: string;
  enableScheduler?: boolean;
  dryRunByDefault?: boolean;
}

// ============================================================================
// Default Retention Policies
// ============================================================================

export const DEFAULT_RETENTION_POLICIES: RetentionPolicy[] = [
  {
    category: 'temporary',
    retentionDays: 1,
    action: 'delete',
    description: 'Temporary files older than 1 day',
    enabled: true,
  },
  {
    category: 'expired',
    retentionDays: 0, // Immediate
    action: 'delete',
    description: 'Files past their expiration date',
    enabled: true,
  },
  {
    category: 'orphaned',
    retentionDays: 7,
    action: 'delete',
    description: 'S3 objects without database records',
    enabled: true,
  },
  {
    category: 'inactive_user',
    retentionDays: 365,
    action: 'archive',
    description: 'Files from inactive users (1 year)',
    enabled: true,
  },
  {
    category: 'old_version',
    retentionDays: 90,
    action: 'delete',
    description: 'File versions older than 90 days',
    enabled: true,
  },
  {
    category: 'access_log',
    retentionDays: 90,
    action: 'anonymize',
    description: 'Access logs older than 90 days',
    enabled: true,
  },
];

// ============================================================================
// File Cleanup Service
// ============================================================================

export class FileCleanupService {
  private s3Client: S3Client;
  private auditService: AuditService;
  private config: FileCleanupServiceConfig;
  private retentionPolicies: RetentionPolicy[];
  private scheduledTask: ReturnType<typeof cron.schedule> | null = null;
  private isRunning = false;

  constructor(config: FileCleanupServiceConfig) {
    this.config = {
      cronSchedule: '0 3 * * *', // Default: 3 AM daily
      enableScheduler: true,
      dryRunByDefault: false,
      ...config,
    };

    this.s3Client = new S3Client({
      region: config.s3Region || process.env.AWS_REGION || 'us-east-1',
    });

    this.auditService = new AuditService();
    this.retentionPolicies = [...DEFAULT_RETENTION_POLICIES];

    if (this.config.enableScheduler) {
      this.startScheduler();
    }

    logger.info('FileCleanupService initialized', {
      bucket: this.config.s3Bucket,
      schedule: this.config.cronSchedule,
      schedulerEnabled: this.config.enableScheduler,
    });
  }

  // ==========================================================================
  // Scheduler Management
  // ==========================================================================

  /**
   * Start the scheduled cleanup task
   */
  startScheduler(): void {
    if (this.scheduledTask) {
      logger.warn('Scheduler already running');
      return;
    }

    const schedule = this.config.cronSchedule || '0 3 * * *';

    if (!cron.validate(schedule)) {
      logger.error('Invalid cron schedule', { schedule });
      throw new Error(`Invalid cron schedule: ${schedule}`);
    }

    this.scheduledTask = cron.schedule(schedule, async () => {
      logger.info('Starting scheduled cleanup run');
      try {
        const report = await this.runCleanup({ dryRun: false });
        logger.info('Scheduled cleanup completed', {
          runId: report.runId,
          filesProcessed: report.totalFilesProcessed,
          bytesFreed: report.totalBytesFreed,
          errors: report.totalErrors,
        });
      } catch (error) {
        logger.error('Scheduled cleanup failed', { error });
      }
    });

    logger.info('Cleanup scheduler started', { schedule });
  }

  /**
   * Stop the scheduled cleanup task
   */
  stopScheduler(): void {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
      logger.info('Cleanup scheduler stopped');
    }
  }

  // ==========================================================================
  // Main Cleanup Operations
  // ==========================================================================

  /**
   * Run full cleanup with all enabled policies
   */
  async runCleanup(options: { dryRun?: boolean } = {}): Promise<CleanupReport> {
    const dryRun = options.dryRun ?? this.config.dryRunByDefault ?? false;
    const runId = uuidv4();
    const startTime = new Date();
    const results: CleanupResult[] = [];

    if (this.isRunning) {
      throw new Error('Cleanup is already running');
    }

    this.isRunning = true;
    logger.info('Starting cleanup run', { runId, dryRun });

    try {
      // Run each enabled policy
      for (const policy of this.retentionPolicies) {
        if (!policy.enabled) {
          logger.debug('Skipping disabled policy', { category: policy.category });
          continue;
        }

        try {
          const result = await this.runPolicyCleanup(policy, dryRun);
          results.push(result);
        } catch (error) {
          logger.error('Policy cleanup failed', {
            category: policy.category,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          results.push({
            category: policy.category,
            action: policy.action,
            filesProcessed: 0,
            bytesFreed: 0,
            errors: [error instanceof Error ? error.message : 'Unknown error'],
            startTime: new Date(),
            endTime: new Date(),
          });
        }
      }

      const endTime = new Date();
      const report: CleanupReport = {
        runId,
        startTime,
        endTime,
        dryRun,
        results,
        totalFilesProcessed: results.reduce((sum, r) => sum + r.filesProcessed, 0),
        totalBytesFreed: results.reduce((sum, r) => sum + r.bytesFreed, 0),
        totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
      };

      // Log cleanup execution to audit
      await this.auditService.logFileCleanupExecuted({
        userId: 0,
        cleanupType: dryRun ? 'dry-run' : 'scheduled',
        filesDeleted: report.totalFilesProcessed,
        bytesRecovered: report.totalBytesFreed,
        reason: `Automated cleanup: ${results.map((r) => r.category).join(', ')}`,
      });

      logger.info('Cleanup run completed', {
        runId,
        dryRun,
        totalFilesProcessed: report.totalFilesProcessed,
        totalBytesFreed: report.totalBytesFreed,
        totalErrors: report.totalErrors,
        duration: endTime.getTime() - startTime.getTime(),
      });

      return report;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Run cleanup for a specific policy
   */
  private async runPolicyCleanup(
    policy: RetentionPolicy,
    dryRun: boolean
  ): Promise<CleanupResult> {
    const startTime = new Date();
    let filesProcessed = 0;
    let bytesFreed = 0;
    const errors: string[] = [];

    logger.info('Running policy cleanup', {
      category: policy.category,
      action: policy.action,
      retentionDays: policy.retentionDays,
      dryRun,
    });

    try {
      switch (policy.category) {
        case 'temporary':
          ({ filesProcessed, bytesFreed } = await this.cleanupTemporaryFiles(
            policy.retentionDays,
            dryRun,
            errors
          ));
          break;

        case 'expired':
          ({ filesProcessed, bytesFreed } = await this.cleanupExpiredFiles(
            dryRun,
            errors
          ));
          break;

        case 'orphaned':
          ({ filesProcessed, bytesFreed } = await this.cleanupOrphanedObjects(
            policy.retentionDays,
            dryRun,
            errors
          ));
          break;

        case 'inactive_user':
          ({ filesProcessed, bytesFreed } = await this.archiveInactiveUserFiles(
            policy.retentionDays,
            dryRun,
            errors
          ));
          break;

        case 'old_version':
          ({ filesProcessed, bytesFreed } = await this.cleanupOldVersions(
            policy.retentionDays,
            dryRun,
            errors
          ));
          break;

        case 'access_log':
          ({ filesProcessed, bytesFreed } = await this.anonymizeAccessLogs(
            policy.retentionDays,
            dryRun,
            errors
          ));
          break;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown error');
    }

    return {
      category: policy.category,
      action: policy.action,
      filesProcessed,
      bytesFreed,
      errors,
      startTime,
      endTime: new Date(),
    };
  }

  // ==========================================================================
  // Category-Specific Cleanup Operations
  // ==========================================================================

  /**
   * Clean up temporary files older than retention period
   */
  private async cleanupTemporaryFiles(
    retentionDays: number,
    dryRun: boolean,
    errors: string[]
  ): Promise<{ filesProcessed: number; bytesFreed: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Find temporary files (category = 'TEMPORARY' or filename starts with 'tmp_')
    const tempFiles = await db
      .select()
      .from(files)
      .where(
        and(
          sql`(${files.category} = 'TEMPORARY' OR ${files.filename} LIKE 'tmp_%')`,
          lt(files.createdAt, cutoffDate)
        )
      );

    let bytesFreed = 0;
    let filesProcessed = 0;

    for (const file of tempFiles) {
      try {
        if (!dryRun) {
          await this.deleteFile(file.fileId, file.storagePath);
        }
        bytesFreed += file.fileSize || 0;
        filesProcessed++;

        logger.debug('Cleaned up temporary file', {
          fileId: file.fileId,
          fileName: file.filename,
          dryRun,
        });
      } catch (error) {
        errors.push(`Failed to delete temporary file ${file.fileId}: ${error}`);
      }
    }

    return { filesProcessed, bytesFreed };
  }

  /**
   * Clean up files that have passed their expiration date
   */
  private async cleanupExpiredFiles(
    dryRun: boolean,
    errors: string[]
  ): Promise<{ filesProcessed: number; bytesFreed: number }> {
    const now = new Date();

    // Find expired files
    const expiredFiles = await db
      .select()
      .from(files)
      .where(
        and(
          sql`${files.expiresAt} IS NOT NULL`,
          lt(files.expiresAt, now)
        )
      );

    let bytesFreed = 0;
    let filesProcessed = 0;

    for (const file of expiredFiles) {
      try {
        if (!dryRun) {
          await this.deleteFile(file.fileId, file.storagePath);
        }
        bytesFreed += file.fileSize || 0;
        filesProcessed++;

        logger.debug('Cleaned up expired file', {
          fileId: file.fileId,
          fileName: file.filename,
          expiresAt: file.expiresAt,
          dryRun,
        });
      } catch (error) {
        errors.push(`Failed to delete expired file ${file.fileId}: ${error}`);
      }
    }

    return { filesProcessed, bytesFreed };
  }

  /**
   * Detect and clean up orphaned S3 objects without database records
   */
  private async cleanupOrphanedObjects(
    retentionDays: number,
    dryRun: boolean,
    errors: string[]
  ): Promise<{ filesProcessed: number; bytesFreed: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const orphanedObjects = await this.findOrphanedS3Objects(cutoffDate);
    let bytesFreed = 0;
    let filesProcessed = 0;

    if (orphanedObjects.length === 0) {
      return { filesProcessed: 0, bytesFreed: 0 };
    }

    // Delete in batches of 1000 (S3 limit)
    const batchSize = 1000;
    for (let i = 0; i < orphanedObjects.length; i += batchSize) {
      const batch = orphanedObjects.slice(i, i + batchSize);

      if (!dryRun) {
        try {
          await this.s3Client.send(
            new DeleteObjectsCommand({
              Bucket: this.config.s3Bucket,
              Delete: {
                Objects: batch.map((obj) => ({ Key: obj.key })),
              },
            })
          );
        } catch (error) {
          errors.push(`Failed to delete orphaned objects batch: ${error}`);
          continue;
        }
      }

      bytesFreed += batch.reduce((sum, obj) => sum + obj.size, 0);
      filesProcessed += batch.length;

      logger.debug('Cleaned up orphaned objects batch', {
        count: batch.length,
        dryRun,
      });
    }

    return { filesProcessed, bytesFreed };
  }

  /**
   * Find S3 objects that don't have corresponding database records
   */
  private async findOrphanedS3Objects(olderThan: Date): Promise<OrphanedObject[]> {
    const orphaned: OrphanedObject[] = [];
    let continuationToken: string | undefined;

    // Get all S3 keys from database
    const dbFiles = await db.select({ storagePath: files.storagePath }).from(files);
    const dbKeys = new Set(dbFiles.map((f) => f.storagePath));

    // Get all version S3 keys
    const versionFiles = await db.select({ storagePath: fileVersions.storagePath }).from(fileVersions);
    versionFiles.forEach((v) => dbKeys.add(v.storagePath));

    // List S3 objects and find orphans
    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.config.s3Bucket,
          ContinuationToken: continuationToken,
        })
      );

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (
            obj.Key &&
            !dbKeys.has(obj.Key) &&
            obj.LastModified &&
            obj.LastModified < olderThan
          ) {
            orphaned.push({
              key: obj.Key,
              size: obj.Size || 0,
              lastModified: obj.LastModified,
            });
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    logger.info('Found orphaned S3 objects', { count: orphaned.length });
    return orphaned;
  }

  /**
   * Archive files from inactive users
   */
  private async archiveInactiveUserFiles(
    retentionDays: number,
    dryRun: boolean,
    errors: string[]
  ): Promise<{ filesProcessed: number; bytesFreed: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Find files from users who haven't accessed their files in retention period
    // This requires tracking last access time - for now, use last modified time
    const inactiveFiles = await db
      .select()
      .from(files)
      .where(
        and(
          sql`${files.lastAccessedAt} IS NOT NULL`,
          lt(files.lastAccessedAt, cutoffDate),
          eq(files.isArchived, false)
        )
      );

    let bytesFreed = 0;
    let filesProcessed = 0;

    if (!this.config.archiveBucket) {
      logger.warn('Archive bucket not configured, skipping inactive user file archival');
      return { filesProcessed: 0, bytesFreed: 0 };
    }

    for (const file of inactiveFiles) {
      try {
        if (!dryRun) {
          // Copy to archive bucket
          await this.s3Client.send(
            new CopyObjectCommand({
              Bucket: this.config.archiveBucket,
              CopySource: `${this.config.s3Bucket}/${file.storagePath}`,
              Key: `archived/${file.storagePath}`,
              StorageClass: 'GLACIER',
            })
          );

          // Delete from primary bucket
          await this.deleteS3Object(file.storagePath);

          // Update database
          await db
            .update(files)
            .set({
              isArchived: true,
              archivedAt: new Date(),
              storagePath: `archived/${file.storagePath}`,
            })
            .where(eq(files.fileId, file.fileId));
        }

        bytesFreed += file.fileSize || 0;
        filesProcessed++;

        logger.debug('Archived inactive user file', {
          fileId: file.fileId,
          fileName: file.filename,
          dryRun,
        });
      } catch (error) {
        errors.push(`Failed to archive file ${file.fileId}: ${error}`);
      }
    }

    return { filesProcessed, bytesFreed };
  }

  /**
   * Clean up old file versions beyond retention period
   */
  private async cleanupOldVersions(
    retentionDays: number,
    dryRun: boolean,
    errors: string[]
  ): Promise<{ filesProcessed: number; bytesFreed: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Find old versions (not the current active version)
    const oldVersions = await db
      .select()
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.isCurrentVersion, false),
          lt(fileVersions.createdAt, cutoffDate)
        )
      );

    let bytesFreed = 0;
    let filesProcessed = 0;

    for (const version of oldVersions) {
      try {
        if (!dryRun) {
          // Delete S3 object
          await this.deleteS3Object(version.storagePath);

          // Delete encryption key if exists
          await db
            .delete(fileEncryptionKeys)
            .where(eq(fileEncryptionKeys.fileId, `${version.fileId}_v${version.versionNumber}`));

          // Delete version record
          await db.delete(fileVersions).where(eq(fileVersions.id, version.id));
        }

        bytesFreed += version.fileSize || 0;
        filesProcessed++;

        logger.debug('Cleaned up old version', {
          fileId: version.fileId,
          versionNumber: version.versionNumber,
          dryRun,
        });
      } catch (error) {
        errors.push(`Failed to delete version ${version.id}: ${error}`);
      }
    }

    return { filesProcessed, bytesFreed };
  }

  /**
   * Anonymize access logs older than retention period
   */
  private async anonymizeAccessLogs(
    retentionDays: number,
    dryRun: boolean,
    errors: string[]
  ): Promise<{ filesProcessed: number; bytesFreed: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // This would typically work with a separate access_logs table
    // For now, we'll anonymize sensitive metadata in file records
    try {
      if (!dryRun) {
        // Anonymize IP addresses and user agents in old file metadata
        const result = await db.execute(sql`
          UPDATE files
          SET metadata = jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{uploadIp}',
              '"anonymized"'
            ),
            '{userAgent}',
            '"anonymized"'
          )
          WHERE created_at < ${cutoffDate}
          AND (
            metadata->>'uploadIp' IS NOT NULL
            OR metadata->>'userAgent' IS NOT NULL
          )
          AND (
            metadata->>'uploadIp' != 'anonymized'
            OR metadata->>'userAgent' != 'anonymized'
          )
        `);

        logger.info('Anonymized access logs in file metadata', {
          cutoffDate,
        });
      }

      // Note: For full access log anonymization, implement a separate access_logs table
      // and anonymize fields like IP address, user agent, etc.
      return { filesProcessed: 0, bytesFreed: 0 };
    } catch (error) {
      errors.push(`Failed to anonymize access logs: ${error}`);
      return { filesProcessed: 0, bytesFreed: 0 };
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Delete a file from both S3 and database
   */
  private async deleteFile(fileId: string, storagePath: string): Promise<void> {
    // Delete S3 object
    await this.deleteS3Object(storagePath);

    // Delete all versions
    const versions = await db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId));

    for (const version of versions) {
      await this.deleteS3Object(version.storagePath);
    }

    // Delete encryption keys
    await db.delete(fileEncryptionKeys).where(eq(fileEncryptionKeys.fileId, fileId));

    // Delete version records
    await db.delete(fileVersions).where(eq(fileVersions.fileId, fileId));

    // Delete file record
    await db.delete(files).where(eq(files.fileId, fileId));
  }

  /**
   * Delete an object from S3
   */
  private async deleteS3Object(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.s3Bucket,
        Delete: {
          Objects: [{ Key: key }],
        },
      })
    );
  }

  // ==========================================================================
  // Policy Management
  // ==========================================================================

  /**
   * Get current retention policies
   */
  getRetentionPolicies(): RetentionPolicy[] {
    return [...this.retentionPolicies];
  }

  /**
   * Update a retention policy
   */
  updateRetentionPolicy(
    category: FileCategory,
    updates: Partial<Omit<RetentionPolicy, 'category'>>
  ): void {
    const policy = this.retentionPolicies.find((p) => p.category === category);
    if (!policy) {
      throw new Error(`Policy not found: ${category}`);
    }

    Object.assign(policy, updates);
    logger.info('Updated retention policy', { category, updates });
  }

  /**
   * Enable or disable a retention policy
   */
  setRetentionPolicyEnabled(category: FileCategory, enabled: boolean): void {
    this.updateRetentionPolicy(category, { enabled });
  }

  // ==========================================================================
  // Status and Reporting
  // ==========================================================================

  /**
   * Get cleanup service status
   */
  getStatus(): {
    isRunning: boolean;
    schedulerActive: boolean;
    cronSchedule: string;
    policies: RetentionPolicy[];
  } {
    return {
      isRunning: this.isRunning,
      schedulerActive: this.scheduledTask !== null,
      cronSchedule: this.config.cronSchedule || '0 3 * * *',
      policies: this.getRetentionPolicies(),
    };
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    temporaryFiles: number;
    temporarySize: number;
    expiredFiles: number;
    archivedFiles: number;
    versions: number;
    versionsSize: number;
  }> {
    const [
      totalResult,
      tempResult,
      expiredResult,
      archivedResult,
      versionsResult,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)`, size: sql<number>`sum(file_size)` }).from(files),
      db
        .select({ count: sql<number>`count(*)`, size: sql<number>`sum(file_size)` })
        .from(files)
        .where(sql`${files.category} = 'TEMPORARY' OR ${files.filename} LIKE 'tmp_%'`),
      db
        .select({ count: sql<number>`count(*)` })
        .from(files)
        .where(
          and(
            sql`${files.expiresAt} IS NOT NULL`,
            lt(files.expiresAt, new Date())
          )
        ),
      db
        .select({ count: sql<number>`count(*)` })
        .from(files)
        .where(eq(files.isArchived, true)),
      db
        .select({ count: sql<number>`count(*)`, size: sql<number>`sum(file_size)` })
        .from(fileVersions)
        .where(eq(fileVersions.isCurrentVersion, false)),
    ]);

    return {
      totalFiles: totalResult[0]?.count || 0,
      totalSize: totalResult[0]?.size || 0,
      temporaryFiles: tempResult[0]?.count || 0,
      temporarySize: tempResult[0]?.size || 0,
      expiredFiles: expiredResult[0]?.count || 0,
      archivedFiles: archivedResult[0]?.count || 0,
      versions: versionsResult[0]?.count || 0,
      versionsSize: versionsResult[0]?.size || 0,
    };
  }

  /**
   * Run a dry run and get projected cleanup results
   */
  async previewCleanup(): Promise<CleanupReport> {
    return this.runCleanup({ dryRun: true });
  }

  // ==========================================================================
  // Manual Cleanup Triggers
  // ==========================================================================

  /**
   * Manually trigger cleanup for a specific category
   */
  async cleanupCategory(
    category: FileCategory,
    options: { dryRun?: boolean } = {}
  ): Promise<CleanupResult> {
    const policy = this.retentionPolicies.find((p) => p.category === category);
    if (!policy) {
      throw new Error(`Policy not found: ${category}`);
    }

    return this.runPolicyCleanup(policy, options.dryRun ?? false);
  }

  /**
   * Force cleanup of specific files by ID
   */
  async cleanupFiles(
    fileIds: string[],
    options: { dryRun?: boolean } = {}
  ): Promise<{ processed: number; errors: string[] }> {
    const errors: string[] = [];
    let processed = 0;

    const filesToDelete = await db
      .select()
      .from(files)
      .where(inArray(files.fileId, fileIds));

    for (const file of filesToDelete) {
      try {
        if (!options.dryRun) {
          await this.deleteFile(file.fileId, file.storagePath);
        }
        processed++;
      } catch (error) {
        errors.push(`Failed to delete file ${file.fileId}: ${error}`);
      }
    }

    return { processed, errors };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let cleanupServiceInstance: FileCleanupService | null = null;

export function getFileCleanupService(
  config?: FileCleanupServiceConfig
): FileCleanupService {
  if (!cleanupServiceInstance) {
    if (!config) {
      throw new Error(
        'FileCleanupService must be initialized with configuration on first call'
      );
    }
    cleanupServiceInstance = new FileCleanupService(config);
  }
  return cleanupServiceInstance;
}

export function initializeFileCleanupService(
  config: FileCleanupServiceConfig
): FileCleanupService {
  if (cleanupServiceInstance) {
    cleanupServiceInstance.stopScheduler();
  }
  cleanupServiceInstance = new FileCleanupService(config);
  return cleanupServiceInstance;
}
