/**
 * Storage Health Monitor
 * Real-time monitoring and failover for storage networks
 */

import { logger } from '../../utils/logger.js';
import { StorageNetworkHealth } from './storage-strategy-engine.js';
import { localStorageProvider } from './local-storage-provider.js';
import { cloudStorageProviders } from './cloud-storage-providers.js';
import { distributedStorageProviders } from './distributed-storage-providers.js';
import * as crypto from 'crypto';

export interface HealthCheckResult {
  networkName: string;
  isHealthy: boolean;
  responseTime: number;
  error?: string;
  timestamp: Date;
  details: {
    connectivity: boolean;
    latency: number;
    throughput?: number;
    errorRate?: number;
    lastError?: string;
  };
}

export interface NetworkMonitoringConfig {
  healthCheckInterval: number; // milliseconds
  timeoutMs: number;
  maxRetries: number;
  failureThreshold: number; // consecutive failures before marking unhealthy
  recoveryThreshold: number; // consecutive successes before marking healthy
}

export interface StorageAlert {
  id: string;
  networkName: string;
  type:
    | 'NETWORK_DOWN'
    | 'HIGH_LATENCY'
    | 'LOW_THROUGHPUT'
    | 'ERROR_RATE_HIGH'
    | 'SPACE_LOW';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  timestamp: Date;
  resolved: boolean;
  resolvedAt?: Date;
  metadata: Record<string, any>;
}

export class StorageHealthMonitor {
  private healthStatus: Map<string, StorageNetworkHealth> = new Map();
  private healthHistory: Map<string, HealthCheckResult[]> = new Map();
  private activeAlerts: Map<string, StorageAlert> = new Map();
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private consecutiveSuccesses: Map<string, number> = new Map();
  private isMonitoring: boolean = false;

  private config: NetworkMonitoringConfig = {
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000'), // 30 seconds
    timeoutMs: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '10000'), // 10 seconds
    maxRetries: parseInt(process.env.HEALTH_CHECK_RETRIES || '3'),
    failureThreshold: parseInt(process.env.FAILURE_THRESHOLD || '3'),
    recoveryThreshold: parseInt(process.env.RECOVERY_THRESHOLD || '2'),
  };

  // Networks to monitor
  private networks = [
    'local',
    'aws_s3',
    'google_cloud',
    'azure_blob',
    'ipfs',
    'filecoin',
    'arweave',
    'storj',
    'skynet',
    'swarm',
  ];

  constructor() {
    this.initializeHealthStatus();
  }

  /**
   * Start monitoring all storage networks
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('[HealthMonitor] Monitoring already started');
      return;
    }

    try {
      logger.info(
        '[HealthMonitor] Starting storage network health monitoring',
        {
          networks: this.networks.length,
          interval: this.config.healthCheckInterval,
        }
      );

      // Initial health check for all networks
      await this.performInitialHealthChecks();

      // Start periodic monitoring for each network
      for (const networkName of this.networks) {
        this.startNetworkMonitoring(networkName);
      }

      // Start alert cleanup task
      this.startAlertCleanup();

      this.isMonitoring = true;
      logger.info(
        '[HealthMonitor] Storage network health monitoring started successfully'
      );
    } catch (error) {
      logger.error('[HealthMonitor] Failed to start health monitoring', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stop monitoring all storage networks
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    logger.info('[HealthMonitor] Stopping storage network health monitoring');

    // Clear all monitoring intervals
    for (const [networkName, interval] of this.monitoringIntervals) {
      clearInterval(interval);
      logger.debug('[HealthMonitor] Stopped monitoring for network', {
        networkName,
      });
    }

    this.monitoringIntervals.clear();
    this.isMonitoring = false;

    logger.info('[HealthMonitor] Storage network health monitoring stopped');
  }

  /**
   * Get health status for a specific network
   */
  async getNetworkHealth(
    networkName: string
  ): Promise<StorageNetworkHealth | null> {
    return this.healthStatus.get(networkName) || null;
  }

  /**
   * Get health status for all networks
   */
  async getAllNetworkHealth(): Promise<StorageNetworkHealth[]> {
    return Array.from(this.healthStatus.values());
  }

  /**
   * Get health history for a network
   */
  getHealthHistory(
    networkName: string,
    limit: number = 50
  ): HealthCheckResult[] {
    const history = this.healthHistory.get(networkName) || [];
    return history.slice(-limit);
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): StorageAlert[] {
    return Array.from(this.activeAlerts.values()).filter(
      alert => !alert.resolved
    );
  }

  /**
   * Get all alerts (including resolved)
   */
  getAllAlerts(): StorageAlert[] {
    return Array.from(this.activeAlerts.values());
  }

  /**
   * Force health check for a specific network
   */
  async forceHealthCheck(networkName: string): Promise<HealthCheckResult> {
    logger.info('[HealthMonitor] Forcing health check', { networkName });
    return await this.performHealthCheck(networkName);
  }

  /**
   * Force health check for all networks
   */
  async forceHealthCheckAll(): Promise<HealthCheckResult[]> {
    logger.info('[HealthMonitor] Forcing health check for all networks');

    const results = await Promise.allSettled(
      this.networks.map(networkName => this.performHealthCheck(networkName))
    );

    return results
      .filter(
        (result): result is PromiseFulfilledResult<HealthCheckResult> =>
          result.status === 'fulfilled'
      )
      .map(result => result.value);
  }

  /**
   * Initialize health status for all networks
   */
  private initializeHealthStatus(): void {
    for (const networkName of this.networks) {
      this.healthStatus.set(networkName, {
        networkName,
        isHealthy: false,
        reliability: 0,
        avgLatency: 0,
        throughput: 0,
        costEfficiency: this.calculateCostEfficiency(networkName),
        lastChecked: new Date(),
        issues: [],
        uptime: 0,
      });

      this.healthHistory.set(networkName, []);
      this.consecutiveFailures.set(networkName, 0);
      this.consecutiveSuccesses.set(networkName, 0);
    }
  }

  /**
   * Perform initial health checks for all networks
   */
  private async performInitialHealthChecks(): Promise<void> {
    logger.info('[HealthMonitor] Performing initial health checks');

    const healthChecks = this.networks.map(async networkName => {
      try {
        await this.performHealthCheck(networkName);
      } catch (error) {
        logger.error('[HealthMonitor] Initial health check failed', {
          networkName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await Promise.allSettled(healthChecks);
    logger.info('[HealthMonitor] Initial health checks completed');
  }

  /**
   * Start monitoring for a specific network
   */
  private startNetworkMonitoring(networkName: string): void {
    const interval = setInterval(async () => {
      try {
        await this.performHealthCheck(networkName);
      } catch (error) {
        logger.error('[HealthMonitor] Periodic health check failed', {
          networkName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.healthCheckInterval);

    this.monitoringIntervals.set(networkName, interval);

    logger.debug('[HealthMonitor] Started monitoring for network', {
      networkName,
      interval: this.config.healthCheckInterval,
    });
  }

  /**
   * Perform health check for a specific network
   */
  private async performHealthCheck(
    networkName: string
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();
    let isHealthy = false;
    let error: string | undefined;
    let connectivity = false;
    let latency = 0;
    let throughput: number | undefined;

    try {
      // Perform network-specific health check
      const healthData = await this.executeNetworkHealthCheck(networkName);
      isHealthy = healthData.isHealthy;
      connectivity = healthData.connectivity;
      latency = healthData.latency;
      throughput = healthData.throughput;
      error = healthData.error;
    } catch (err) {
      isHealthy = false;
      error = err instanceof Error ? err.message : String(err);
      logger.warn('[HealthMonitor] Health check failed', {
        networkName,
        error,
      });
    }

    const responseTime = Date.now() - startTime;
    const timestamp = new Date();

    // Create health check result
    const result: HealthCheckResult = {
      networkName,
      isHealthy,
      responseTime,
      error,
      timestamp,
      details: {
        connectivity,
        latency,
        throughput,
        errorRate: this.calculateErrorRate(networkName),
        lastError: error,
      },
    };

    // Update health status
    await this.updateHealthStatus(networkName, result);

    // Store in history
    this.storeHealthHistory(networkName, result);

    return result;
  }

  /**
   * Execute network-specific health check
   */
  private async executeNetworkHealthCheck(networkName: string): Promise<{
    isHealthy: boolean;
    connectivity: boolean;
    latency: number;
    throughput?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      switch (networkName) {
        case 'local':
          const localHealth = await localStorageProvider.getHealthStatus();
          return {
            isHealthy: localHealth.isHealthy,
            connectivity: localHealth.isHealthy,
            latency: Date.now() - startTime,
            error: localHealth.issues.join(', ') || undefined,
          };

        case 'aws_s3':
        case 'google_cloud':
        case 'azure_blob':
          const cloudProviders = cloudStorageProviders.getProviderStatus();
          const cloudProvider = cloudProviders.find(
            p => p.name.toLowerCase().replace(' ', '_') === networkName
          );
          return {
            isHealthy: cloudProvider?.isHealthy || false,
            connectivity: cloudProvider?.isConfigured || false,
            latency: Date.now() - startTime,
          };

        case 'ipfs':
        case 'filecoin':
        case 'arweave':
        case 'storj':
        case 'skynet':
        case 'swarm':
          const distributedProviders =
            distributedStorageProviders.getProviderStatus();
          const distributedProvider = distributedProviders.find(
            p => p.name.toLowerCase() === networkName
          );
          return {
            isHealthy: distributedProvider?.isHealthy || false,
            connectivity: distributedProvider?.isConfigured || false,
            latency: Date.now() - startTime,
          };

        default:
          throw new Error(`Unknown network: ${networkName}`);
      }
    } catch (error) {
      return {
        isHealthy: false,
        connectivity: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Update health status based on check result
   */
  private async updateHealthStatus(
    networkName: string,
    result: HealthCheckResult
  ): Promise<void> {
    const currentStatus = this.healthStatus.get(networkName);
    if (!currentStatus) return;

    // Update consecutive counters
    if (result.isHealthy) {
      this.consecutiveFailures.set(networkName, 0);
      this.consecutiveSuccesses.set(
        networkName,
        (this.consecutiveSuccesses.get(networkName) || 0) + 1
      );
    } else {
      this.consecutiveFailures.set(
        networkName,
        (this.consecutiveFailures.get(networkName) || 0) + 1
      );
      this.consecutiveSuccesses.set(networkName, 0);
    }

    const consecutiveFailures = this.consecutiveFailures.get(networkName) || 0;
    const consecutiveSuccesses =
      this.consecutiveSuccesses.get(networkName) || 0;

    // Determine if network should be marked healthy/unhealthy
    let newHealthyStatus = currentStatus.isHealthy;

    if (
      !currentStatus.isHealthy &&
      consecutiveSuccesses >= this.config.recoveryThreshold
    ) {
      newHealthyStatus = true;
      logger.info('[HealthMonitor] Network recovered', {
        networkName,
        consecutiveSuccesses,
      });
      await this.resolveNetworkAlert(networkName, 'NETWORK_DOWN');
    } else if (
      currentStatus.isHealthy &&
      consecutiveFailures >= this.config.failureThreshold
    ) {
      newHealthyStatus = false;
      logger.warn('[HealthMonitor] Network marked unhealthy', {
        networkName,
        consecutiveFailures,
      });
      await this.createAlert(
        networkName,
        'NETWORK_DOWN',
        'CRITICAL',
        `Network ${networkName} is down after ${consecutiveFailures} consecutive failures`
      );
    }

    // Calculate reliability (percentage of successful checks in last 100 checks)
    const recentHistory = this.getHealthHistory(networkName, 100);
    const successfulChecks = recentHistory.filter(h => h.isHealthy).length;
    const reliability =
      recentHistory.length > 0 ? successfulChecks / recentHistory.length : 0;

    // Calculate average latency
    const recentLatency = recentHistory.slice(-10); // Last 10 checks
    const avgLatency =
      recentLatency.length > 0
        ? recentLatency.reduce((sum, h) => sum + h.details.latency, 0) /
          recentLatency.length
        : result.details.latency;

    // Calculate uptime (percentage of time healthy in last 24 hours)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dayHistory = recentHistory.filter(h => h.timestamp > dayAgo);
    const uptime =
      dayHistory.length > 0
        ? dayHistory.filter(h => h.isHealthy).length / dayHistory.length
        : result.isHealthy
          ? 1
          : 0;

    // Update status
    const updatedStatus: StorageNetworkHealth = {
      ...currentStatus,
      isHealthy: newHealthyStatus,
      reliability,
      avgLatency,
      throughput: result.details.throughput || 0,
      lastChecked: result.timestamp,
      issues: result.error ? [result.error] : [],
      uptime,
    };

    this.healthStatus.set(networkName, updatedStatus);

    // Check for performance alerts
    await this.checkPerformanceAlerts(networkName, updatedStatus);
  }

  /**
   * Store health check result in history
   */
  private storeHealthHistory(
    networkName: string,
    result: HealthCheckResult
  ): void {
    const history = this.healthHistory.get(networkName) || [];
    history.push(result);

    // Keep only last 1000 results to prevent memory bloat
    if (history.length > 1000) {
      history.splice(0, history.length - 1000);
    }

    this.healthHistory.set(networkName, history);
  }

  /**
   * Check for performance-related alerts
   */
  private async checkPerformanceAlerts(
    networkName: string,
    status: StorageNetworkHealth
  ): Promise<void> {
    // High latency alert
    if (status.avgLatency > 5000) {
      // 5 seconds
      await this.createAlert(
        networkName,
        'HIGH_LATENCY',
        'MEDIUM',
        `High latency detected: ${status.avgLatency.toFixed(0)}ms`
      );
    } else {
      await this.resolveNetworkAlert(networkName, 'HIGH_LATENCY');
    }

    // Low reliability alert
    if (status.reliability < 0.9 && status.reliability > 0) {
      // Less than 90%
      await this.createAlert(
        networkName,
        'ERROR_RATE_HIGH',
        'HIGH',
        `Low reliability: ${(status.reliability * 100).toFixed(1)}%`
      );
    } else {
      await this.resolveNetworkAlert(networkName, 'ERROR_RATE_HIGH');
    }

    // Low throughput alert (if throughput data is available)
    if (status.throughput > 0 && status.throughput < 1) {
      // Less than 1 MB/s
      await this.createAlert(
        networkName,
        'LOW_THROUGHPUT',
        'MEDIUM',
        `Low throughput: ${status.throughput.toFixed(2)} MB/s`
      );
    } else {
      await this.resolveNetworkAlert(networkName, 'LOW_THROUGHPUT');
    }
  }

  /**
   * Create alert
   */
  private async createAlert(
    networkName: string,
    type: StorageAlert['type'],
    severity: StorageAlert['severity'],
    message: string
  ): Promise<void> {
    const alertId = `${networkName}_${type}`;
    const existingAlert = this.activeAlerts.get(alertId);

    // Don't create duplicate alerts
    if (existingAlert && !existingAlert.resolved) {
      return;
    }

    const alert: StorageAlert = {
      id: alertId,
      networkName,
      type,
      severity,
      message,
      timestamp: new Date(),
      resolved: false,
      metadata: {
        networkStatus: this.healthStatus.get(networkName),
      },
    };

    this.activeAlerts.set(alertId, alert);

    logger.warn('[HealthMonitor] Alert created', {
      alertId,
      networkName,
      type,
      severity,
      message,
    });
  }

  /**
   * Resolve network alert
   */
  private async resolveNetworkAlert(
    networkName: string,
    type: StorageAlert['type']
  ): Promise<void> {
    const alertId = `${networkName}_${type}`;
    const alert = this.activeAlerts.get(alertId);

    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      this.activeAlerts.set(alertId, alert);

      logger.info('[HealthMonitor] Alert resolved', {
        alertId,
        networkName,
        type,
        duration: alert.resolvedAt.getTime() - alert.timestamp.getTime(),
      });
    }
  }

  /**
   * Calculate error rate for a network
   */
  private calculateErrorRate(networkName: string): number {
    const recentHistory = this.getHealthHistory(networkName, 20); // Last 20 checks
    if (recentHistory.length === 0) return 0;

    const errors = recentHistory.filter(h => !h.isHealthy).length;
    return errors / recentHistory.length;
  }

  /**
   * Calculate cost efficiency for a network
   */
  private calculateCostEfficiency(networkName: string): number {
    const costs: Record<string, number> = {
      local: 100, // Local is most cost efficient
      ipfs: 95,
      swarm: 90,
      storj: 85,
      filecoin: 80,
      arweave: 75,
      google_cloud: 70,
      aws_s3: 65,
      azure_blob: 60,
      skynet: 85,
    };

    return costs[networkName] || 50;
  }

  /**
   * Start alert cleanup task
   */
  private startAlertCleanup(): void {
    // Clean up old resolved alerts every hour
    setInterval(
      () => {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        for (const [alertId, alert] of this.activeAlerts) {
          if (
            alert.resolved &&
            alert.resolvedAt &&
            alert.resolvedAt < oneWeekAgo
          ) {
            this.activeAlerts.delete(alertId);
          }
        }
      },
      60 * 60 * 1000
    ); // 1 hour
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats(): {
    networksMonitored: number;
    healthyNetworks: number;
    unhealthyNetworks: number;
    activeAlerts: number;
    totalChecksPerformed: number;
    averageReliability: number;
  } {
    const networks = Array.from(this.healthStatus.values());
    const healthyNetworks = networks.filter(n => n.isHealthy).length;
    const totalChecksPerformed = Array.from(this.healthHistory.values()).reduce(
      (sum, history) => sum + history.length,
      0
    );
    const averageReliability =
      networks.length > 0
        ? networks.reduce((sum, n) => sum + n.reliability, 0) / networks.length
        : 0;

    return {
      networksMonitored: networks.length,
      healthyNetworks,
      unhealthyNetworks: networks.length - healthyNetworks,
      activeAlerts: this.getActiveAlerts().length,
      totalChecksPerformed,
      averageReliability,
    };
  }
}

export const storageHealthMonitor = new StorageHealthMonitor();
