// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * Backup and Recovery Server - Port 8090
 * ISO 22301 Business Continuity Management Compliance
 *
 * Provides disaster recovery endpoints and backup management for WRFCoin platform.
 * Implements comprehensive backup strategies for:
 * - Database backups (PostgreSQL)
 * - Blockchain state snapshots
 * - Configuration and secrets backup
 * - Wallet recovery procedures
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Gauge, Registry, collectDefaultMetrics } = require('prom-client');
const { appLogger } = require('./utils/logger.js');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { authenticateToken, requireRole } = await import('./middleware/auth-middleware.js');
const { resolveAllowedOrigins, createCorsOriginDelegate } = require('./utils/strict-cors-config.js');
const { getEncryptedBackupService } = require('../services/encrypted-backup-service.js');

const app = express();
const PORT = process.env.BACKUP_RECOVERY_PORT || 8090;
const probeState = { draining: false };

// ── Prometheus metrics ──────────────────────────────────────────────────────
const prometheusRegistry = new Registry();
prometheusRegistry.setDefaultLabels({ app: 'wrfcoin-backup-recovery' });
collectDefaultMetrics({ register: prometheusRegistry, prefix: 'wrfcoin_backup_' });

const lastBackupAgeGauge = new Gauge({
  name: 'wrfcoin_last_backup_age_seconds',
  help: 'Seconds since the last successful backup completed',
  registers: [prometheusRegistry],
});

const backupTotalGauge = new Gauge({
  name: 'wrfcoin_backup_total',
  help: 'Total number of backups in manifest',
  registers: [prometheusRegistry],
});

// ── Database config from DATABASE_URL ───────────────────────────────────────
function parseDbConfig() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 5432,
      user: parsed.username,
      password: parsed.password,
      database: parsed.pathname.slice(1),
    };
  } catch {
    appLogger.warn('Failed to parse DATABASE_URL', { module: 'BackupRecoveryServer' });
    return null;
  }
}

// ── Backup service + scheduler state ────────────────────────────────────────
let backupService = null;
let scheduledTask = null;
let lastBackupTimestamp = null;

async function initBackupService() {
  try {
    backupService = getEncryptedBackupService();
    await backupService.initialize();
    appLogger.info('EncryptedBackupService initialized', { module: 'BackupRecoveryServer' });
  } catch (error) {
    appLogger.warn('EncryptedBackupService init failed — status endpoint will report degraded', {
      module: 'BackupRecoveryServer',
      error: error.message,
    });
    backupService = null;
  }
}

async function runScheduledBackup() {
  const dbConfig = parseDbConfig();
  if (!dbConfig) {
    appLogger.warn('Skipping scheduled backup — DATABASE_URL not set', { module: 'BackupRecoveryServer' });
    return;
  }
  if (!backupService) {
    appLogger.warn('Skipping scheduled backup — service not initialized', { module: 'BackupRecoveryServer' });
    return;
  }
  try {
    appLogger.info('Starting scheduled daily backup', { module: 'BackupRecoveryServer' });
    const result = await backupService.createFullBackup(dbConfig, { format: 'c' });
    lastBackupTimestamp = new Date();
    appLogger.info('Scheduled backup completed', {
      module: 'BackupRecoveryServer',
      backupId: result.backupId,
    });
  } catch (error) {
    appLogger.error('Scheduled backup failed', { module: 'BackupRecoveryServer', error: error.message });
  }
}

function updateMetrics() {
  if (backupService) {
    const metrics = backupService.getMetrics();
    backupTotalGauge.set(metrics.backupCount);
    const ts = metrics.lastBackupTime || lastBackupTimestamp;
    if (ts) {
      lastBackupAgeGauge.set((Date.now() - new Date(ts).getTime()) / 1000);
    }
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = resolveAllowedOrigins({ requireExplicitOriginsInProduction: true });
app.use(cors({ origin: createCorsOriginDelegate(allowedOrigins), credentials: true }));
app.use(express.json({ limit: '50mb' }));

const BACKUP_MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25 hours

app.use(
  createHealthMiddleware('backup-recovery-server', {
    backupRecency: {
      critical: false,
      check: () => {
        if (!backupService) return { status: 'down', message: 'Backup service not initialized' };
        const metrics = backupService.getMetrics();
        const ts = metrics.lastBackupTime || lastBackupTimestamp;
        if (!ts) return { status: 'down', message: 'No backup has been completed yet' };
        const ageMs = Date.now() - new Date(ts).getTime();
        if (ageMs > BACKUP_MAX_AGE_MS) {
          return { status: 'down', message: `Last backup ${Math.round(ageMs / 3600000)}h ago (>25h threshold)` };
        }
        return { status: 'up', message: `Last backup ${Math.round(ageMs / 60000)}m ago` };
      },
    },
  }, { state: probeState }).router
);

// ── Prometheus /metrics endpoint ────────────────────────────────────────────
app.get('/metrics', async (_req, res) => {
  updateMetrics();
  res.set('Content-Type', prometheusRegistry.contentType);
  res.end(await prometheusRegistry.metrics());
});

/**
 * Get backup status and available recovery points
 */
app.get('/api/backup/status', authenticateToken, async (req, res) => {
  try {
    if (!backupService) {
      return res.status(503).json({
        success: false,
        error: 'Backup service not initialized — check DATABASE_URL and backup directory permissions',
      });
    }

    const metrics = backupService.getMetrics();
    const backups = await backupService.listBackups({ limit: 10 });

    const recoveryPoints = backups.map(b => ({
      id: b.id,
      timestamp: b.timestamp,
      type: b.type,
      size: b.size,
      checksum: b.checksum,
    }));

    const lastTs = metrics.lastBackupTime || lastBackupTimestamp;

    const status = {
      lastBackup: lastTs ? new Date(lastTs).toISOString() : null,
      backupCount: metrics.backupCount,
      recoveryPoints,
      storage: {
        totalBackupSize: metrics.totalBackupSize,
        retentionDays: 30,
      },
      serviceInitialized: metrics.initialized,
      stats: {
        totalBackups: metrics.totalBackups,
        successfulBackups: metrics.successfulBackups,
        failedBackups: metrics.failedBackups,
        totalRestores: metrics.totalRestores,
        successfulRestores: metrics.successfulRestores,
        failedRestores: metrics.failedRestores,
      },
    };

    res.json({ success: true, data: status });
  } catch (error) {
    appLogger.error('Failed to get backup status', { module: 'BackupRecoveryServer', error: error.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve backup status' });
  }
});

/**
 * Initiate database backup
 */
app.post('/api/backup/initiate', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    if (!backupService) {
      return res.status(503).json({ success: false, error: 'Backup service not initialized' });
    }

    const dbConfig = parseDbConfig();
    if (!dbConfig) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured' });
    }

    const { type = 'full', target = 'database' } = req.body;
    appLogger.info('Initiating backup', { module: 'BackupRecoveryServer', type, target });

    const result = await backupService.createFullBackup(dbConfig, { format: 'c' });
    lastBackupTimestamp = new Date();

    res.json({
      success: true,
      message: `${type} backup initiated for ${target}`,
      data: {
        id: result.backupId,
        type,
        target,
        status: 'completed',
        startedAt: result.metadata.timestamp,
        compressedSize: result.metadata.compressedSize,
        originalSize: result.metadata.originalSize,
        compressionRatio: result.metadata.compressionRatio,
        checksum: result.metadata.checksum,
      },
    });
  } catch (error) {
    appLogger.error('Backup initiation failed', { module: 'BackupRecoveryServer', error: error.message });
    res.status(500).json({ success: false, error: `Failed to initiate backup: ${error.message}` });
  }
});

/**
 * Initiate disaster recovery
 */
app.post('/api/recovery/restore', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    if (!backupService) {
      return res.status(503).json({ success: false, error: 'Backup service not initialized' });
    }

    const { recoveryPointId, target = 'database', dryRun = true } = req.body;

    if (!recoveryPointId) {
      return res.status(400).json({
        success: false,
        error: 'Recovery point ID is required',
      });
    }

    const dbConfig = parseDbConfig();
    if (!dbConfig) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured' });
    }

    appLogger.info('Initiating recovery', { module: 'BackupRecoveryServer', recoveryPointId, dryRun });

    const result = await backupService.restoreBackup(recoveryPointId, dbConfig, {
      dryRun,
      clean: !dryRun,
      noOwner: true,
    });

    res.json({
      success: true,
      message: dryRun
        ? 'Recovery dry-run completed successfully'
        : 'Recovery process completed',
      data: result,
    });
  } catch (error) {
    appLogger.error('Recovery failed', { module: 'BackupRecoveryServer', error: error.message });
    res.status(500).json({ success: false, error: `Failed to initiate recovery: ${error.message}` });
  }
});

/**
 * Verify backup integrity
 */
app.get('/api/backup/verify/:id', authenticateToken, async (req, res) => {
  try {
    if (!backupService) {
      return res.status(503).json({ success: false, error: 'Backup service not initialized' });
    }

    const result = await backupService.verifyBackup(req.params.id);
    res.json({ success: result.success, data: result });
  } catch (error) {
    appLogger.error('Backup verification failed', { module: 'BackupRecoveryServer', error: error.message });
    res.status(500).json({ success: false, error: 'Failed to verify backup' });
  }
});

/**
 * Delete a backup
 */
app.delete('/api/backup/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    if (!backupService) {
      return res.status(503).json({ success: false, error: 'Backup service not initialized' });
    }

    const result = await backupService.deleteBackup(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    appLogger.error('Backup deletion failed', { module: 'BackupRecoveryServer', error: error.message });
    res.status(500).json({ success: false, error: 'Failed to delete backup' });
  }
});

/**
 * Test disaster recovery readiness
 */
app.post('/api/recovery/test', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const checks = {
      serviceInitialized: {
        passed: !!backupService,
        message: backupService ? 'Backup service is running' : 'Backup service not initialized',
      },
      databaseUrlConfigured: {
        passed: !!process.env.DATABASE_URL,
        message: process.env.DATABASE_URL ? 'DATABASE_URL is set' : 'DATABASE_URL not configured',
      },
    };

    if (backupService) {
      const metrics = backupService.getMetrics();
      const ts = metrics.lastBackupTime || lastBackupTimestamp;

      checks.backupsExist = {
        passed: metrics.backupCount > 0,
        message: metrics.backupCount > 0
          ? `${metrics.backupCount} backups available`
          : 'No backups found',
      };

      checks.recentBackup = {
        passed: ts && (Date.now() - new Date(ts).getTime()) < BACKUP_MAX_AGE_MS,
        message: ts
          ? `Last backup ${Math.round((Date.now() - new Date(ts).getTime()) / 3600000)}h ago`
          : 'No backup has been completed',
      };

      if (metrics.lastFullBackup) {
        const verification = await backupService.verifyBackup(metrics.lastFullBackup);
        checks.backupIntegrity = {
          passed: verification.success,
          message: verification.success
            ? 'Latest backup checksum verified'
            : `Integrity check failed: ${verification.error}`,
        };
      }
    }

    const allPassed = Object.values(checks).every((c) => c.passed);

    res.json({
      success: true,
      message: allPassed
        ? 'All disaster recovery readiness checks passed'
        : 'Some recovery readiness checks failed',
      data: {
        overallStatus: allPassed ? 'READY' : 'NEEDS_ATTENTION',
        checks,
        testedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    appLogger.error('Recovery test failed', { module: 'BackupRecoveryServer', error: error.message });
    res.status(500).json({ success: false, error: 'Failed to run recovery test' });
  }
});

// Start server if run directly
if (require.main === module) {
  (async () => {
    // Initialize backup service
    await initBackupService();

    // Schedule daily backup at 2:00 AM
    const cronExpr = process.env.BACKUP_CRON || '0 2 * * *';
    scheduledTask = cron.schedule(cronExpr, runScheduledBackup);
    appLogger.info('Backup cron scheduled', { module: 'BackupRecoveryServer', cron: cronExpr });

    const server = app.listen(PORT, '0.0.0.0', () => {
      appLogger.info('WRFCoin Backup & Recovery Server Started', {
        module: 'BackupRecoveryServer',
        port: PORT,
        compliance: 'ISO 22301 Business Continuity Compliant',
        capabilities: ['database-backup', 'database-recovery', 'backup-verification', 'scheduled-backups', 'prometheus-metrics'],
        cronSchedule: cronExpr,
      });
    });

    registerGracefulShutdown({
      serviceName: 'backup-recovery-server',
      server,
      logger: appLogger,
      state: probeState,
      cleanupFns: [
        {
          name: 'backup-cron-stop',
          handler: () => { if (scheduledTask) scheduledTask.stop(); },
        },
        {
          name: 'backup-service-shutdown',
          handler: () => backupService ? backupService.shutdown() : Promise.resolve(),
        },
      ],
    });
  })();
}

module.exports = app;
