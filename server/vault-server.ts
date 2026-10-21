// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Vault Management API Server - TypeScript
 * Provides HTTP endpoints for Vault operations and monitoring
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { securityLogger } from './utils/logger.js';
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
import {
  ApiResponse,
  ApiError,
  ApiResult,
  PaginationParams,
  PaginatedResponse,
} from '../shared/types/api-types.js';
import {
  SecurityAuditLog,
  VaultConfig,
  SecretRotationPolicy,
} from '../shared/types/security-types.js';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;

interface VaultHealth {
  status: 'healthy' | 'degraded' | 'critical';
  version: string;
  initialized: boolean;
  sealed: boolean;
  standby: boolean;
  replicationState: string;
  lastHeartbeat: Date;
}

interface VaultSecret {
  path: string;
  version: number;
  createdAt: Date;
  lastAccessed?: Date;
  metadata: Record<string, any>;
  rotationPolicy?: SecretRotationPolicy;
}

interface VaultAuditEvent {
  id: string;
  timestamp: Date;
  type: 'auth' | 'request' | 'response' | 'error';
  path: string;
  operation: string;
  entityId?: string;
  clientToken?: string;
  remoteAddress: string;
  success: boolean;
  errorMessage?: string;
}

interface DatabaseCredentials {
  username: string;
  password: string;
  database: string;
  host: string;
  port: number;
  connectionString: string;
  expiresAt: Date;
}

interface SecretRotationJob {
  id: string;
  secretPath: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  scheduledAt: Date;
  completedAt?: Date;
  errorMessage?: string;
  rotationType: 'manual' | 'automatic';
}

class VaultServer {
  private app: express.Application;
  private port: number;
  private server: any = null;
  private probeState = { draining: false };
  private isInitialized: boolean = false;
  private vaultHealth: VaultHealth;
  private auditEvents: VaultAuditEvent[] = [];
  private rotationJobs: Map<string, SecretRotationJob> = new Map();

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.VAULT_SERVER_PORT || '8300', 10);
    this.vaultHealth = {
      status: 'healthy',
      version: '1.0.0',
      initialized: true,
      sealed: false,
      standby: false,
      replicationState: 'active',
      lastHeartbeat: new Date(),
    };
  }

  /**
   * Initialize and start the Vault management server
   */
  async start(): Promise<void> {
    try {
      securityLogger.info('Initializing Vault Management Server...');

      // Setup Express middleware
      this.setupMiddleware();
      this.app.use(
        createHealthMiddleware('vault-server', {}, { state: this.probeState }).router
      );

      // Setup routes
      this.setupRoutes();

      // Start server
      await this.startServer();
      registerGracefulShutdown({
        serviceName: 'vault-server',
        server: this.server,
        logger: securityLogger,
        state: this.probeState,
      });

      this.isInitialized = true;
      securityLogger.info('Vault Management Server started successfully');
    } catch (error) {
      securityLogger.error('Failed to start Vault Management Server', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Security middleware
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
          },
        },
      })
    );

    // CORS configuration
    this.app.use(
      cors({
        origin: [
          'https://wrfcoin.replit.app',
          ...(resolveAllowedOrigins({ developmentDefaults: ['http://localhost:5000', 'http://0.0.0.0:5000'] })),
        ],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Vault-Token'],
      })
    );

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: {
        error: 'Too many requests, please try again later.',
        retryAfter: 15 * 60,
      },
      standardHeaders: true,
      legacyHeaders: false,
    });
    (this.app as any).use(limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      securityLogger.info(`Vault API: ${req.method} ${req.path} - ${req.ip}`);

      // Add to audit log
      this.auditEvents.push({
        id: this.generateAuditId(),
        timestamp: new Date(),
        type: 'request',
        path: req.path,
        operation: req.method,
        remoteAddress: req.ip || 'unknown',
        success: true,
      });

      next();
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Vault status endpoint
    this.app.get('/api/vault/status', this.handleVaultStatus.bind(this));

    // Secret management endpoints
    this.app.get('/api/vault/secrets', this.handleListSecrets.bind(this));
    this.app.post(
      '/api/vault/secrets/rotate',
      this.handleRotateSecret.bind(this)
    );

    // Database credentials endpoints
    this.app.post(
      '/api/vault/database/credentials',
      this.handleGenerateDbCredentials.bind(this)
    );
    this.app.delete(
      '/api/vault/database/credentials/:username',
      this.handleRevokeDbCredentials.bind(this)
    );

    // Audit endpoints
    this.app.get('/api/vault/audit', this.handleGetAuditLogs.bind(this));

    // Rotation job management
    this.app.get(
      '/api/vault/rotation/jobs',
      this.handleGetRotationJobs.bind(this)
    );
    this.app.get(
      '/api/vault/rotation/jobs/:jobId',
      this.handleGetRotationJob.bind(this)
    );

    // Error handler
    this.app.use(this.handleError.bind(this));
  }

  /**
   * Start the Express server
   */
  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        securityLogger.info(`Vault Management Server running on port ${this.port}`);
        securityLogger.info(`Health check: http://0.0.0.0:${this.port}/health`);
        resolve();
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
  }
  // API Route Handlers

  private handleVaultStatus(
    req: Request,
    res: Response<ApiResult<VaultHealth>>
  ) {
    this.vaultHealth.lastHeartbeat = new Date();
    res.json({
      success: true,
      data: this.vaultHealth,
      timestamp: new Date().toISOString(),
    });
  }

  private handleListSecrets(
    req: Request,
    res: Response<ApiResult<VaultSecret[]>>
  ) {
    // Mock secret list - in production this would query actual Vault
    const secrets: VaultSecret[] = [
      {
        path: 'database/config',
        version: 3,
        createdAt: new Date('2025-06-01'),
        lastAccessed: new Date(),
        metadata: { type: 'database', environment: 'production' },
      },
      {
        path: 'api/keys/jwt',
        version: 1,
        createdAt: new Date('2025-06-15'),
        metadata: { type: 'jwt', algorithm: 'RS256' },
        rotationPolicy: {
          enabled: true,
          rotationInterval: '24h',
          lastRotated: new Date('2025-06-21'),
          nextRotation: new Date('2025-06-22'),
        },
      },
    ];

    res.json({
      success: true,
      data: secrets,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleRotateSecret(
    req: Request<{}, ApiResult<SecretRotationJob>, { secretPath: string }>,
    res: Response<ApiResult<SecretRotationJob>>
  ): Promise<void> {
    const { secretPath } = req.body;

    if (!secretPath) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Secret path is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const jobId = this.generateJobId();
    const rotationJob: SecretRotationJob = {
      id: jobId,
      secretPath,
      status: 'pending',
      scheduledAt: new Date(),
      rotationType: 'manual',
    };

    this.rotationJobs.set(jobId, rotationJob);

    // Simulate async rotation process
    setTimeout(() => {
      const job = this.rotationJobs.get(jobId);
      if (job) {
        job.status = 'completed';
        job.completedAt = new Date();
        this.rotationJobs.set(jobId, job);
      }
    }, 2000);

    res.json({
      success: true,
      data: rotationJob,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleGenerateDbCredentials(
    req: Request<
      {},
      ApiResult<DatabaseCredentials>,
      { database: string; ttl?: string }
    >,
    res: Response<ApiResult<DatabaseCredentials>>
  ): Promise<void> {
    const { database, ttl = '1h' } = req.body;

    if (!database) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Database name is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Generate dynamic database credentials
    const credentials: DatabaseCredentials = {
      username: `vault_${Date.now()}_${randomBytes(8).toString('hex')}`,
      password: this.generateSecurePassword(),
      database,
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      connectionString: `postgresql://user:pass@host:5432/${database}`,
      expiresAt: new Date(Date.now() + (ttl === '1h' ? 3600000 : 86400000)),
    };

    // Audit log
    this.auditEvents.push({
      id: this.generateAuditId(),
      timestamp: new Date(),
      type: 'request',
      path: '/api/vault/database/credentials',
      operation: 'CREATE',
      remoteAddress: req.ip || 'unknown',
      success: true,
    });

    res.json({
      success: true,
      data: credentials,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleRevokeDbCredentials(
    req: Request<{ username: string }>,
    res: Response<ApiResult<{ revoked: boolean }>>
  ) {
    const { username } = req.params;

    // In production: revoke the database user
    securityLogger.info(`Revoking database credentials for user: ${username}`);

    this.auditEvents.push({
      id: this.generateAuditId(),
      timestamp: new Date(),
      type: 'request',
      path: `/api/vault/database/credentials/${username}`,
      operation: 'DELETE',
      remoteAddress: req.ip || 'unknown',
      success: true,
    });

    res.json({
      success: true,
      data: { revoked: true },
      timestamp: new Date().toISOString(),
    });
  }

  private handleGetAuditLogs(
    req: Request<
      {},
      ApiResult<PaginatedResponse<VaultAuditEvent>>,
      {},
      PaginationParams
    >,
    res: Response<ApiResult<PaginatedResponse<VaultAuditEvent>>>
  ) {
    const { page = 1, limit = 50 } = req.query;
    const validatedPage = Math.max(1, Number(page));
    const validatedLimit = Math.min(100, Math.max(1, Number(limit)));
    const offset = (validatedPage - 1) * validatedLimit;

    const total = this.auditEvents.length;
    const paginatedEvents = this.auditEvents
      .slice(-100) // Last 100 events
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(offset, offset + validatedLimit);

    const totalPages = Math.ceil(total / validatedLimit);

    const response: PaginatedResponse<VaultAuditEvent> = {
      data: paginatedEvents,
      pagination: {
        page: validatedPage,
        limit: validatedLimit,
        total,
        totalPages,
        hasNext: validatedPage < totalPages,
        hasPrev: validatedPage > 1,
      },
    };

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    });
  }

  private handleGetRotationJobs(
    req: Request,
    res: Response<ApiResult<SecretRotationJob[]>>
  ) {
    const jobs = Array.from(this.rotationJobs.values()).sort(
      (a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime()
    );

    res.json({
      success: true,
      data: jobs,
      timestamp: new Date().toISOString(),
    });
  }

  private handleGetRotationJob(
    req: Request<{ jobId: string }>,
    res: Response<ApiResult<SecretRotationJob>>
  ): void {
    const { jobId } = req.params;
    const job = this.rotationJobs.get(jobId);

    if (!job) {
      res.status(404).json({
        success: false,
        error: {
          code: 'JOB_NOT_FOUND',
          message: 'Rotation job not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: job,
      timestamp: new Date().toISOString(),
    });
  }

  private handleError(
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    securityLogger.error('Vault Server Error', { error: error.message });

    this.auditEvents.push({
      id: this.generateAuditId(),
      timestamp: new Date(),
      type: 'error',
      path: req.path,
      operation: req.method,
      remoteAddress: req.ip || 'unknown',
      success: false,
      errorMessage: error.message,
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        details:
          process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // Utility methods

  private generateAuditId(): string {
    return `audit_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }

  private generateJobId(): string {
    return `job_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }

  private generateSecurePassword(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise(resolve => {
        this.server.close(() => {
          securityLogger.info('Vault Management Server stopped');
          resolve();
        });
      });
    }
  }
}

export default VaultServer;
export {
  VaultHealth,
  VaultSecret,
  VaultAuditEvent,
  DatabaseCredentials,
  SecretRotationJob,
};
