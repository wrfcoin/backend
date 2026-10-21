/**
 * Health Monitor
 * Continuous health checking and monitoring of services
 */

import {
  HealthCheckConfig,
  ServiceHealthStatus,
  ResilienceMetrics,
} from './resilience-types.js';
import { appLogger } from '../../../server/utils/logger.js';

interface HealthCheckResult {
  healthy: boolean;
  responseTime: number;
  error?: Error;
  statusCode?: number;
}

export class HealthMonitor {
  private config: HealthCheckConfig;
  private healthStatus: ServiceHealthStatus;
  private healthCheckInterval?: NodeJS.Timeout;
  private isMonitoring = false;

  constructor(
    private serviceName: string,
    private baseUrl: string,
    config: Partial<HealthCheckConfig> = {}
  ) {
    this.config = {
      interval: 30000, // 30 seconds
      timeout: 5000, // 5 seconds
      path: '/health',
      expectedStatusCode: 200,
      expectedResponseTime: 2000, // 2 seconds
      ...config,
    };

    this.healthStatus = {
      name: this.serviceName,
      url: this.baseUrl,
      healthy: false,
      consecutiveFailures: 0,
    };
  }

  public startMonitoring(): void {
    if (this.isMonitoring) {
      appLogger.info('Health monitoring already started', { serviceName: this.serviceName });
      return;
    }

    appLogger.info('Starting health monitoring', {
      serviceName: this.serviceName,
      baseUrl: this.baseUrl
    });

    // Initial health check
    this.performHealthCheck();

    // Set up periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.interval);

    this.isMonitoring = true;
  }

  public stopMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    this.isMonitoring = false;
    appLogger.info('Stopped health monitoring', { serviceName: this.serviceName });
  }

  private async performHealthCheck(): Promise<void> {
    try {
      const result = await this.executeHealthCheck();
      this.updateHealthStatus(result);
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        responseTime: this.config.timeout,
        error: error as Error,
      };
      this.updateHealthStatus(result);
    }
  }

  private async executeHealthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const healthUrl = `${this.baseUrl}${this.config.path}`;

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(`Health check timeout after ${this.config.timeout}ms`)
          );
        }, this.config.timeout);
      });

      // For HTTP health checks - using native fetch if available, otherwise would need axios
      const fetchPromise = this.performHttpCheck(healthUrl);

      const response = await Promise.race([fetchPromise, timeoutPromise]);
      const responseTime = Date.now() - startTime;

      const healthy =
        response.status === this.config.expectedStatusCode &&
        responseTime <= this.config.expectedResponseTime;

      return {
        healthy,
        responseTime,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        healthy: false,
        responseTime: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  private async performHttpCheck(
    url: string
  ): Promise<{ status: number; body: any }> {
    // Simple HTTP check implementation
    // In a real implementation, you'd use axios or fetch
    try {
      // Simulating an HTTP check - replace with actual HTTP client
      const axios = require('axios');
      const response = await axios.get(url, { timeout: this.config.timeout });
      return {
        status: response.status,
        body: response.data,
      };
    } catch (error: any) {
      // Handle axios errors
      if (error.response) {
        return {
          status: error.response.status,
          body: error.response.data,
        };
      }
      throw error;
    }
  }

  private updateHealthStatus(result: HealthCheckResult): void {
    const previousHealth = this.healthStatus.healthy;

    this.healthStatus.healthy = result.healthy;
    this.healthStatus.responseTime = result.responseTime;
    this.healthStatus.lastCheck = new Date();

    if (result.healthy) {
      this.healthStatus.consecutiveFailures = 0;

      if (!previousHealth) {
        appLogger.info('Service is now healthy', {
          serviceName: this.serviceName,
          responseTime: result.responseTime
        });
      }
    } else {
      this.healthStatus.consecutiveFailures++;

      const errorMessage =
        result.error?.message || `Status code: ${result.statusCode}`;

      if (previousHealth) {
        appLogger.error('Service became unhealthy', {
          serviceName: this.serviceName,
          error: errorMessage
        });
      } else {
        appLogger.error('Service health check failed', {
          serviceName: this.serviceName,
          consecutiveFailures: this.healthStatus.consecutiveFailures,
          error: errorMessage
        });
      }

      // Log critical health issues
      if (this.healthStatus.consecutiveFailures >= 5) {
        appLogger.error('CRITICAL: Service health check failure threshold exceeded', {
          serviceName: this.serviceName,
          consecutiveFailures: this.healthStatus.consecutiveFailures
        });
      }
    }
  }

  public getHealthStatus(): ServiceHealthStatus {
    return { ...this.healthStatus };
  }

  public isHealthy(): boolean {
    return this.healthStatus.healthy;
  }

  public getConsecutiveFailures(): number {
    return this.healthStatus.consecutiveFailures;
  }

  public async performImmediateCheck(): Promise<ServiceHealthStatus> {
    try {
      const result = await this.executeHealthCheck();
      this.updateHealthStatus(result);
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        responseTime: this.config.timeout,
        error: error as Error,
      };
      this.updateHealthStatus(result);
    }

    return this.getHealthStatus();
  }

  public reset(): void {
    this.healthStatus.healthy = false;
    this.healthStatus.consecutiveFailures = 0;
    this.healthStatus.responseTime = undefined;
    this.healthStatus.lastCheck = undefined;
    appLogger.info('Health status reset', { serviceName: this.serviceName });
  }

  // Static factory methods for different health check types
  public static forDatabase(
    serviceName: string,
    connectionString: string
  ): HealthMonitor {
    // For database health checks, we might use a simple query instead of HTTP
    return new HealthMonitor(serviceName, connectionString, {
      interval: 60000, // 1 minute for DB checks
      timeout: 10000, // 10 seconds timeout
      path: '', // No path for DB checks
      expectedResponseTime: 5000, // 5 seconds max for DB queries
    });
  }

  public static forHttpService(
    serviceName: string,
    baseUrl: string,
    healthPath = '/health'
  ): HealthMonitor {
    return new HealthMonitor(serviceName, baseUrl, {
      interval: 30000, // 30 seconds
      timeout: 5000, // 5 seconds
      path: healthPath,
      expectedStatusCode: 200,
      expectedResponseTime: 2000,
    });
  }

  public static forExternalApi(
    serviceName: string,
    baseUrl: string
  ): HealthMonitor {
    return new HealthMonitor(serviceName, baseUrl, {
      interval: 60000, // 1 minute for external APIs
      timeout: 10000, // 10 seconds timeout
      path: '/status', // Common external API health endpoint
      expectedStatusCode: 200,
      expectedResponseTime: 5000,
    });
  }
}

// Global Health Monitor Registry
export class HealthMonitorRegistry {
  private static instance: HealthMonitorRegistry;
  private monitors = new Map<string, HealthMonitor>();

  private constructor() {}

  public static getInstance(): HealthMonitorRegistry {
    if (!HealthMonitorRegistry.instance) {
      HealthMonitorRegistry.instance = new HealthMonitorRegistry();
    }
    return HealthMonitorRegistry.instance;
  }

  public register(serviceName: string, monitor: HealthMonitor): void {
    this.monitors.set(serviceName, monitor);
    monitor.startMonitoring();
    appLogger.info('Registered health monitor', { serviceName });
  }

  public unregister(serviceName: string): void {
    const monitor = this.monitors.get(serviceName);
    if (monitor) {
      monitor.stopMonitoring();
      this.monitors.delete(serviceName);
      appLogger.info('Unregistered health monitor', { serviceName });
    }
  }

  public getMonitor(serviceName: string): HealthMonitor | undefined {
    return this.monitors.get(serviceName);
  }

  public getAllHealthStatus(): Record<string, ServiceHealthStatus> {
    const status: Record<string, ServiceHealthStatus> = {};

    for (const [serviceName, monitor] of this.monitors) {
      status[serviceName] = monitor.getHealthStatus();
    }

    return status;
  }

  public getHealthyServices(): string[] {
    const healthy: string[] = [];

    for (const [serviceName, monitor] of this.monitors) {
      if (monitor.isHealthy()) {
        healthy.push(serviceName);
      }
    }

    return healthy;
  }

  public getUnhealthyServices(): string[] {
    const unhealthy: string[] = [];

    for (const [serviceName, monitor] of this.monitors) {
      if (!monitor.isHealthy()) {
        unhealthy.push(serviceName);
      }
    }

    return unhealthy;
  }

  public async performAllHealthChecks(): Promise<
    Record<string, ServiceHealthStatus>
  > {
    const results: Record<string, ServiceHealthStatus> = {};
    const checks = Array.from(this.monitors.entries()).map(
      async ([serviceName, monitor]) => {
        results[serviceName] = await monitor.performImmediateCheck();
      }
    );

    await Promise.all(checks);
    return results;
  }

  public stopAll(): void {
    for (const [serviceName, monitor] of this.monitors) {
      monitor.stopMonitoring();
    }
    appLogger.info('Stopped all health monitors');
  }

  public startAll(): void {
    for (const [serviceName, monitor] of this.monitors) {
      monitor.startMonitoring();
    }
    appLogger.info('Started all health monitors');
  }
}
