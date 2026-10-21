/**
 * Centralized Virus Scanning Middleware for File Uploads
 * Provides strict mode enforcement for production security
 *
 * Features:
 * - ClamAV integration with health monitoring
 * - Strict mode: fails uploads when scanner unavailable (production default)
 * - Audit logging for all scan events
 * - Retry logic for transient scanner failures
 */

import * as NodeClam from 'clamscan';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';

// Environment configuration
const STRICT_VIRUS_SCAN = process.env.STRICT_VIRUS_SCAN !== 'false'; // Default true
const CLAMAV_HOST = process.env.CLAMAV_HOST || 'localhost';
const CLAMAV_PORT = parseInt(process.env.CLAMAV_PORT || '3310');
const CLAMAV_TIMEOUT = parseInt(process.env.CLAMAV_TIMEOUT || '30000');
const SCAN_RETRY_ATTEMPTS = parseInt(process.env.SCAN_RETRY_ATTEMPTS || '2');
const SCAN_RETRY_DELAY = parseInt(process.env.SCAN_RETRY_DELAY || '1000');

// Scanner instance and health state
let clamScanInstance: any = null;
let scannerHealthy = false;
let lastHealthCheck: Date | null = null;
let initializationAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;

/**
 * Initialize ClamAV scanner with health monitoring
 */
export const initializeClamAV = async (): Promise<boolean> => {
  if (initializationAttempts >= MAX_INIT_ATTEMPTS) {
    logger.error('[VirusScan] Max initialization attempts reached', {
      attempts: initializationAttempts,
      strictMode: STRICT_VIRUS_SCAN,
    });
    return false;
  }

  initializationAttempts++;

  try {
    const ClamAV = await NodeClam();
    clamScanInstance = await ClamAV.init({
      clamdscan: {
        host: CLAMAV_HOST,
        port: CLAMAV_PORT,
        timeout: CLAMAV_TIMEOUT,
      },
      preference: 'clamdscan',
    });

    scannerHealthy = true;
    lastHealthCheck = new Date();
    initializationAttempts = 0;

    logger.info('[VirusScan] ClamAV scanner initialized successfully', {
      host: CLAMAV_HOST,
      port: CLAMAV_PORT,
      strictMode: STRICT_VIRUS_SCAN,
    });

    return true;
  } catch (error) {
    scannerHealthy = false;
    logger.error('[VirusScan] Failed to initialize ClamAV scanner', {
      error: error instanceof Error ? error.message : String(error),
      attempt: initializationAttempts,
      maxAttempts: MAX_INIT_ATTEMPTS,
      strictMode: STRICT_VIRUS_SCAN,
    });
    return false;
  }
};

/**
 * Check scanner health status
 */
export const checkScannerHealth = async (): Promise<{
  healthy: boolean;
  lastCheck: Date | null;
  message: string;
}> => {
  if (!clamScanInstance) {
    return {
      healthy: false,
      lastCheck: lastHealthCheck,
      message: 'Scanner not initialized',
    };
  }

  try {
    // Perform a lightweight health check by getting version info
    const version = await clamScanInstance.getVersion();
    scannerHealthy = true;
    lastHealthCheck = new Date();

    return {
      healthy: true,
      lastCheck: lastHealthCheck,
      message: `ClamAV version: ${version}`,
    };
  } catch (error) {
    scannerHealthy = false;
    return {
      healthy: false,
      lastCheck: lastHealthCheck,
      message: error instanceof Error ? error.message : 'Health check failed',
    };
  }
};

/**
 * Scan a buffer for viruses with retry logic
 */
const scanBuffer = async (
  buffer: Buffer,
  retryCount = 0
): Promise<{
  isInfected: boolean;
  viruses: string[];
  error?: string;
}> => {
  if (!clamScanInstance) {
    return {
      isInfected: false,
      viruses: [],
      error: 'Scanner not initialized',
    };
  }

  try {
    const result = await clamScanInstance.scanStream(buffer);
    return {
      isInfected: result.isInfected,
      viruses: result.viruses || [],
    };
  } catch (error) {
    if (retryCount < SCAN_RETRY_ATTEMPTS) {
      logger.warn('[VirusScan] Scan failed, retrying', {
        attempt: retryCount + 1,
        maxAttempts: SCAN_RETRY_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, SCAN_RETRY_DELAY));

      return scanBuffer(buffer, retryCount + 1);
    }

    return {
      isInfected: false,
      viruses: [],
      error: error instanceof Error ? error.message : 'Scan failed',
    };
  }
};

/**
 * Virus scan result interface
 */
export interface VirusScanResult {
  scanned: boolean;
  passed: boolean;
  isInfected: boolean;
  viruses: string[];
  scannerAvailable: boolean;
  strictModeEnforced: boolean;
  scanDuration?: number;
  error?: string;
}

/**
 * Scan a single file buffer
 */
export const scanFile = async (
  buffer: Buffer,
  filename: string,
  userId?: string
): Promise<VirusScanResult> => {
  const startTime = Date.now();

  // Check if scanner is available
  if (!clamScanInstance || !scannerHealthy) {
    // Attempt reinitialization
    await initializeClamAV();

    if (!clamScanInstance || !scannerHealthy) {
      logger.warn('[VirusScan] Scanner unavailable for file scan', {
        filename,
        userId,
        strictMode: STRICT_VIRUS_SCAN,
      });

      return {
        scanned: false,
        passed: !STRICT_VIRUS_SCAN, // Only pass if not in strict mode
        isInfected: false,
        viruses: [],
        scannerAvailable: false,
        strictModeEnforced: STRICT_VIRUS_SCAN,
        error: 'Virus scanner unavailable',
      };
    }
  }

  // Perform scan
  const scanResult = await scanBuffer(buffer);
  const scanDuration = Date.now() - startTime;

  if (scanResult.error) {
    logger.error('[VirusScan] Scan error', {
      filename,
      userId,
      error: scanResult.error,
      duration: scanDuration,
      strictMode: STRICT_VIRUS_SCAN,
    });

    return {
      scanned: false,
      passed: !STRICT_VIRUS_SCAN,
      isInfected: false,
      viruses: [],
      scannerAvailable: true,
      strictModeEnforced: STRICT_VIRUS_SCAN,
      scanDuration,
      error: scanResult.error,
    };
  }

  if (scanResult.isInfected) {
    logger.error('[VirusScan] MALWARE DETECTED', {
      filename,
      userId,
      viruses: scanResult.viruses,
      duration: scanDuration,
    });
  } else {
    logger.debug('[VirusScan] File passed virus scan', {
      filename,
      userId,
      duration: scanDuration,
    });
  }

  return {
    scanned: true,
    passed: !scanResult.isInfected,
    isInfected: scanResult.isInfected,
    viruses: scanResult.viruses,
    scannerAvailable: true,
    strictModeEnforced: false,
    scanDuration,
  };
};

/**
 * Express middleware for virus scanning uploaded files
 * Supports both single file (req.file) and multiple files (req.files)
 */
export const virusScanMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const userId = req.user?.userId;
  const uploadId = (req as any).uploadId || 'unknown';

  // Get files to scan
  const files: Express.Multer.File[] = [];

  if (req.file) {
    files.push(req.file);
  }

  if (req.files) {
    if (Array.isArray(req.files)) {
      files.push(...req.files);
    } else {
      // Handle field-based files object
      Object.values(req.files).forEach(fieldFiles => {
        if (Array.isArray(fieldFiles)) {
          files.push(...fieldFiles);
        }
      });
    }
  }

  if (files.length === 0) {
    // No files to scan, continue
    next();
    return;
  }

  logger.info('[VirusScan] Scanning uploaded files', {
    userId,
    uploadId,
    fileCount: files.length,
    strictMode: STRICT_VIRUS_SCAN,
  });

  // Check scanner availability first
  if (!clamScanInstance || !scannerHealthy) {
    await initializeClamAV();

    if (!clamScanInstance || !scannerHealthy) {
      if (STRICT_VIRUS_SCAN) {
        logger.error('[VirusScan] Scanner unavailable - rejecting upload in strict mode', {
          userId,
          uploadId,
          fileCount: files.length,
        });

        res.status(503).json({
          success: false,
          error: 'Virus scanning service unavailable. Upload rejected for security.',
          code: 'SCANNER_UNAVAILABLE',
          retryAfter: 60,
        });
        return;
      }

      logger.warn('[VirusScan] Scanner unavailable - STRICT_VIRUS_SCAN disabled, continuing', {
        userId,
        uploadId,
        fileCount: files.length,
      });

      next();
      return;
    }
  }

  // Scan all files
  const scanResults: Array<{ filename: string; result: VirusScanResult }> = [];
  const infectedFiles: string[] = [];

  for (const file of files) {
    const result = await scanFile(file.buffer, file.originalname, userId);
    scanResults.push({ filename: file.originalname, result });

    if (result.isInfected) {
      infectedFiles.push(file.originalname);
    }

    // If scanner failed and we're in strict mode, reject immediately
    if (!result.scanned && result.strictModeEnforced) {
      logger.error('[VirusScan] Scan failed in strict mode - rejecting upload', {
        userId,
        uploadId,
        filename: file.originalname,
        error: result.error,
      });

      res.status(503).json({
        success: false,
        error: 'Virus scan failed. Upload rejected for security.',
        code: 'SCAN_FAILED',
        retryAfter: 60,
      });
      return;
    }
  }

  // If any files are infected, reject the entire upload
  if (infectedFiles.length > 0) {
    logger.error('[VirusScan] Upload rejected - malware detected', {
      userId,
      uploadId,
      infectedFiles,
      totalFiles: files.length,
    });

    res.status(400).json({
      success: false,
      error: 'Malware detected in uploaded file(s)',
      code: 'MALWARE_DETECTED',
      infectedFiles,
    });
    return;
  }

  // Attach scan results to request for downstream use
  (req as any).virusScanResults = scanResults;

  logger.info('[VirusScan] All files passed virus scan', {
    userId,
    uploadId,
    fileCount: files.length,
    totalScanTime: scanResults.reduce((sum, r) => sum + (r.result.scanDuration || 0), 0),
  });

  next();
};

/**
 * Get current scanner status
 */
export const getScannerStatus = (): {
  initialized: boolean;
  healthy: boolean;
  strictMode: boolean;
  lastHealthCheck: Date | null;
  config: {
    host: string;
    port: number;
    timeout: number;
    retryAttempts: number;
  };
} => {
  return {
    initialized: clamScanInstance !== null,
    healthy: scannerHealthy,
    strictMode: STRICT_VIRUS_SCAN,
    lastHealthCheck,
    config: {
      host: CLAMAV_HOST,
      port: CLAMAV_PORT,
      timeout: CLAMAV_TIMEOUT,
      retryAttempts: SCAN_RETRY_ATTEMPTS,
    },
  };
};

// Initialize on module load
initializeClamAV().catch(error => {
  logger.error('[VirusScan] Initial ClamAV initialization failed', {
    error: error instanceof Error ? error.message : String(error),
  });
});

export default virusScanMiddleware;
