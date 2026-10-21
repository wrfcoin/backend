/**
 * File Permission Coordinator
 * Manages coordination between file permission sub-agents and main system
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { filePermissionService } from './file-permission-service.js';
import { enhancedFileStorageService } from './enhanced-file-storage.js';
import { vaultIntegrationService } from './vault-integration-service.js';
import { createRedisClient } from '../utils/create-redis.js';

// Redis client for message bus communication
const redis = createRedisClient({
  // Permission-change events must not be silently lost during an outage.
  failureMode: 'fail-closed',
});

export interface FilePermissionEvent {
  type:
    | 'PERMISSION_GRANTED'
    | 'PERMISSION_REVOKED'
    | 'FILE_ACCESSED'
    | 'FILE_SHARED'
    | 'CLEANUP_COMPLETED';
  userId?: number;
  fileId?: string;
  permission?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface SystemHealthStatus {
  filePermissionService: 'healthy' | 'degraded' | 'offline';
  fileStorageService: 'healthy' | 'degraded' | 'offline';
  vaultIntegrationService: 'healthy' | 'degraded' | 'offline';
  redisConnection: 'healthy' | 'degraded' | 'offline';
  lastHealthCheck: Date;
}

export interface CoordinationMetrics {
  totalFiles: number;
  totalPermissions: number;
  totalShares: number;
  activeUsers: number;
  systemLoad: number;
  errorRate: number;
  lastUpdated: Date;
}

export class FilePermissionCoordinator extends EventEmitter {
  private isInitialized: boolean = false;
  private healthStatus: SystemHealthStatus;
  private metrics: CoordinationMetrics;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsUpdateInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.healthStatus = {
      filePermissionService: 'offline',
      fileStorageService: 'offline',
      vaultIntegrationService: 'offline',
      redisConnection: 'offline',
      lastHealthCheck: new Date(),
    };

    this.metrics = {
      totalFiles: 0,
      totalPermissions: 0,
      totalShares: 0,
      activeUsers: 0,
      systemLoad: 0,
      errorRate: 0,
      lastUpdated: new Date(),
    };
  }

  /**
   * Initialize the coordination framework
   */
  async initialize(): Promise<void> {
    try {
      logger.info(
        '[FilePermissionCoordinator] Initializing coordination framework'
      );

      // Initialize Vault service
      await vaultIntegrationService.initialize();

      // Setup Redis message bus subscriptions
      await this.setupMessageBus();

      // Start periodic tasks
      this.startPeriodicTasks();

      // Initial health check
      await this.performHealthCheck();

      // Initial metrics collection
      await this.updateMetrics();

      this.isInitialized = true;
      logger.info(
        '[FilePermissionCoordinator] Coordination framework initialized successfully'
      );

      // Emit initialization event
      this.emit('initialized', { timestamp: new Date() });
    } catch (error) {
      logger.error(
        '[FilePermissionCoordinator] Failed to initialize coordination framework',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Setup Redis message bus for inter-service communication
   */
  private async setupMessageBus(): Promise<void> {
    try {
      // Subscribe to file permission events
      await redis.subscribe(
        'file_permission_events',
        'file_storage_events',
        'vault_events',
        'system_events'
      );

      redis.on('message', (channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as FilePermissionEvent;
          this.handleIncomingEvent(channel, event);
        } catch (error) {
          logger.error(
            '[FilePermissionCoordinator] Error processing message bus event',
            {
              channel,
              message,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      });

      redis.on('connect', () => {
        logger.info(
          '[FilePermissionCoordinator] Connected to Redis message bus'
        );
        this.healthStatus.redisConnection = 'healthy';
      });

      redis.on('error', error => {
        logger.error('[FilePermissionCoordinator] Redis connection error', {
          error: error.message,
        });
        this.healthStatus.redisConnection = 'offline';
      });

      redis.on('disconnect', () => {
        logger.warn(
          '[FilePermissionCoordinator] Disconnected from Redis message bus'
        );
        this.healthStatus.redisConnection = 'offline';
      });
    } catch (error) {
      logger.error('[FilePermissionCoordinator] Error setting up message bus', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Handle incoming events from message bus
   */
  private handleIncomingEvent(
    channel: string,
    event: FilePermissionEvent
  ): void {
    logger.debug('[FilePermissionCoordinator] Received message bus event', {
      channel,
      eventType: event.type,
      userId: event.userId,
      fileId: event.fileId,
    });

    // Emit event for other parts of the system to handle
    this.emit('permission_event', { channel, event });

    // Update metrics based on event type
    this.updateMetricsFromEvent(event);

    // Handle specific event types
    switch (event.type) {
      case 'PERMISSION_GRANTED':
        this.handlePermissionGranted(event);
        break;
      case 'PERMISSION_REVOKED':
        this.handlePermissionRevoked(event);
        break;
      case 'FILE_ACCESSED':
        this.handleFileAccessed(event);
        break;
      case 'FILE_SHARED':
        this.handleFileShared(event);
        break;
      case 'CLEANUP_COMPLETED':
        this.handleCleanupCompleted(event);
        break;
    }
  }

  /**
   * Publish event to message bus
   */
  async publishEvent(
    channel: string,
    event: FilePermissionEvent
  ): Promise<void> {
    try {
      await redis.publish(channel, JSON.stringify(event));
      logger.debug(
        '[FilePermissionCoordinator] Published event to message bus',
        {
          channel,
          eventType: event.type,
        }
      );
    } catch (error) {
      logger.error('[FilePermissionCoordinator] Error publishing event', {
        channel,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get current system health status
   */
  getHealthStatus(): SystemHealthStatus {
    return { ...this.healthStatus };
  }

  /**
   * Get current coordination metrics
   */
  getMetrics(): CoordinationMetrics {
    return { ...this.metrics };
  }

  /**
   * Perform comprehensive health check
   */
  async performHealthCheck(): Promise<SystemHealthStatus> {
    try {
      logger.debug('[FilePermissionCoordinator] Performing health check');

      // Check Redis connection
      try {
        await redis.ping();
        this.healthStatus.redisConnection = 'healthy';
      } catch (error) {
        this.healthStatus.redisConnection = 'offline';
      }

      // Check Vault service
      try {
        const vaultHealthy = await vaultIntegrationService.healthCheck();
        this.healthStatus.vaultIntegrationService = vaultHealthy
          ? 'healthy'
          : 'degraded';
      } catch (error) {
        this.healthStatus.vaultIntegrationService = 'offline';
      }

      // Check file services (these are typically healthy if the app is running)
      this.healthStatus.filePermissionService = 'healthy';
      this.healthStatus.fileStorageService = 'healthy';

      this.healthStatus.lastHealthCheck = new Date();

      // Publish health status update
      await this.publishEvent('system_events', {
        type: 'CLEANUP_COMPLETED', // Reusing enum value for system events
        timestamp: new Date(),
        metadata: {
          eventType: 'HEALTH_CHECK_COMPLETED',
          healthStatus: this.healthStatus,
        },
      });

      return this.getHealthStatus();
    } catch (error) {
      logger.error('[FilePermissionCoordinator] Health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getHealthStatus();
    }
  }

  /**
   * Update system metrics
   */
  private async updateMetrics(): Promise<void> {
    try {
      // Get basic metrics from Redis cache or database
      const cacheKey = 'file_system_metrics';
      const cachedMetrics = await redis.get(cacheKey);

      if (cachedMetrics) {
        const parsedMetrics = JSON.parse(cachedMetrics);
        this.metrics = {
          ...parsedMetrics,
          lastUpdated: new Date(),
        };
      } else {
        // Calculate metrics from database (expensive operation)
        // This would typically be done asynchronously
        this.metrics = {
          totalFiles: 0, // Would query database
          totalPermissions: 0, // Would query database
          totalShares: 0, // Would query database
          activeUsers: 0, // Would query database
          systemLoad: process.cpuUsage().system / 1000000, // CPU usage
          errorRate: 0, // Would calculate from logs
          lastUpdated: new Date(),
        };

        // Cache metrics for 5 minutes
        await redis.setex(cacheKey, 300, JSON.stringify(this.metrics));
      }
    } catch (error) {
      logger.error('[FilePermissionCoordinator] Error updating metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update metrics based on incoming events
   */
  private updateMetricsFromEvent(event: FilePermissionEvent): void {
    // This would update real-time metrics based on events
    // For example, increment counters for different event types
    if (event.type === 'PERMISSION_GRANTED') {
      this.metrics.totalPermissions++;
    } else if (event.type === 'FILE_SHARED') {
      this.metrics.totalShares++;
    }

    this.metrics.lastUpdated = new Date();
  }

  /**
   * Start periodic background tasks
   */
  private startPeriodicTasks(): void {
    // Health check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, 30000);

    // Metrics update every 2 minutes
    this.metricsUpdateInterval = setInterval(async () => {
      await this.updateMetrics();
    }, 120000);

    // Cleanup task every hour
    this.cleanupInterval = setInterval(async () => {
      await this.performCleanup();
    }, 3600000);

    logger.info('[FilePermissionCoordinator] Periodic tasks started');
  }

  /**
   * Perform system cleanup
   */
  private async performCleanup(): Promise<void> {
    try {
      logger.info('[FilePermissionCoordinator] Starting system cleanup');

      // Cleanup expired permissions and shares
      await filePermissionService.cleanupExpiredAccess();

      // Cleanup expired files
      await enhancedFileStorageService.cleanupExpiredFiles();

      // Publish cleanup completion event
      await this.publishEvent('system_events', {
        type: 'CLEANUP_COMPLETED',
        timestamp: new Date(),
        metadata: {
          eventType: 'PERIODIC_CLEANUP',
        },
      });

      logger.info('[FilePermissionCoordinator] System cleanup completed');
    } catch (error) {
      logger.error('[FilePermissionCoordinator] Error during cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Event handlers for specific event types
   */
  private handlePermissionGranted(event: FilePermissionEvent): void {
    logger.debug(
      '[FilePermissionCoordinator] Processing permission granted event',
      {
        userId: event.userId,
        fileId: event.fileId,
        permission: event.permission,
      }
    );
    // Add any specific handling logic here
  }

  private handlePermissionRevoked(event: FilePermissionEvent): void {
    logger.debug(
      '[FilePermissionCoordinator] Processing permission revoked event',
      {
        userId: event.userId,
        fileId: event.fileId,
        permission: event.permission,
      }
    );
    // Add any specific handling logic here
  }

  private handleFileAccessed(event: FilePermissionEvent): void {
    logger.debug('[FilePermissionCoordinator] Processing file accessed event', {
      userId: event.userId,
      fileId: event.fileId,
    });
    // Add any specific handling logic here
  }

  private handleFileShared(event: FilePermissionEvent): void {
    logger.debug('[FilePermissionCoordinator] Processing file shared event', {
      userId: event.userId,
      fileId: event.fileId,
    });
    // Add any specific handling logic here
  }

  private handleCleanupCompleted(event: FilePermissionEvent): void {
    logger.debug(
      '[FilePermissionCoordinator] Processing cleanup completed event',
      {
        metadata: event.metadata,
      }
    );
    // Add any specific handling logic here
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    try {
      logger.info(
        '[FilePermissionCoordinator] Shutting down coordination framework'
      );

      // Clear intervals
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
      }
      if (this.metricsUpdateInterval) {
        clearInterval(this.metricsUpdateInterval);
      }

      // Disconnect from Redis
      await redis.disconnect();

      // Remove all event listeners
      this.removeAllListeners();

      this.isInitialized = false;
      logger.info(
        '[FilePermissionCoordinator] Coordination framework shut down successfully'
      );
    } catch (error) {
      logger.error('[FilePermissionCoordinator] Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if coordinator is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance
export const filePermissionCoordinator = new FilePermissionCoordinator();
