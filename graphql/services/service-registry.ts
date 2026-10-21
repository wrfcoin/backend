/**
 * Service Registry and Client for Backend Service Communication
 * Implements the SERVICE_REGISTRY pattern with circuit breaker and monitoring
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from '../../utils/logger.js';

export interface ServiceEndpoint {
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'grpc';
  healthCheck: string;
  timeout: number;
  retries: number;
  name: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata: {
    requestId: string;
    timestamp: string;
    latency: number;
    service: string;
  };
}

// WRFCoin Service Registry Configuration
export const SERVICE_REGISTRY: Record<string, ServiceEndpoint> = {
  mainApi: {
    host: 'localhost',
    port: 4001,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 5000,
    retries: 3,
    name: 'Main API Server',
  },
  crossChain: {
    host: 'localhost',
    port: 3000,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 15000,
    retries: 3,
    name: 'Cross-Chain Protocol',
  },
  wallet: {
    host: 'localhost',
    port: 4000,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 10000,
    retries: 2,
    name: 'Wallet Server',
  },
  compute: {
    host: 'localhost',
    port: 6000,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 30000,
    retries: 2,
    name: 'Compute Networks',
  },
  aiml: {
    host: 'localhost',
    port: 6001,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 45000,
    retries: 2,
    name: 'AI/ML Networks',
  },
  storage: {
    host: 'localhost',
    port: 7000,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 20000,
    retries: 3,
    name: 'Storage Networks',
  },
  iot: {
    host: 'localhost',
    port: 3002,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 10000,
    retries: 3,
    name: 'IoT Sensor Networks',
  },
  governance: {
    host: 'localhost',
    port: 8000,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 15000,
    retries: 2,
    name: 'Governance Server',
  },
  weatherEarnings: {
    host: 'localhost',
    port: 8080,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 10000,
    retries: 3,
    name: 'Weather Earnings',
  },
  nodeDiscovery: {
    host: 'localhost',
    port: 9001,
    protocol: 'http',
    healthCheck: '/health',
    timeout: 5000,
    retries: 2,
    name: 'Node Discovery',
  },
};

// Circuit Breaker states
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

class ServiceCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private successCount: number = 0;

  private readonly failureThreshold: number = 5;
  private readonly recoveryTimeout: number = 60000; // 1 minute
  private readonly halfOpenMaxCalls: number = 3;

  constructor(private serviceName: string) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        logger.info('Circuit breaker transitioning to HALF_OPEN', {
          service: this.serviceName,
        });
      } else {
        throw new Error(
          `Circuit breaker is OPEN for service: ${this.serviceName}`
        );
      }
    }

    if (
      this.state === CircuitState.HALF_OPEN &&
      this.successCount >= this.halfOpenMaxCalls
    ) {
      throw new Error(
        `Circuit breaker HALF_OPEN limit exceeded for service: ${this.serviceName}`
      );
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.halfOpenMaxCalls) {
        this.state = CircuitState.CLOSED;
        logger.info('Circuit breaker transitioning to CLOSED', {
          service: this.serviceName,
        });
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      logger.error('Circuit breaker transitioning to OPEN', {
        service: this.serviceName,
        failureCount: this.failureCount,
      });
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

export class ServiceClient {
  private baseURL: string;
  private timeout: number;
  private retries: number;
  private circuitBreaker: ServiceCircuitBreaker;
  private axiosInstance: AxiosInstance;
  private healthStatus: boolean = false;
  private lastHealthCheck: number = 0;

  constructor(private serviceName: string) {
    const serviceConfig = SERVICE_REGISTRY[serviceName];
    if (!serviceConfig) {
      throw new Error(`Service ${serviceName} not found in registry`);
    }

    this.baseURL = `${serviceConfig.protocol}://${serviceConfig.host}:${serviceConfig.port}`;
    this.timeout = serviceConfig.timeout;
    this.retries = serviceConfig.retries;
    this.circuitBreaker = new ServiceCircuitBreaker(serviceName);

    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WRFCoin-GraphQL-Client/1.0',
      },
    });

    // Request interceptor for logging
    this.axiosInstance.interceptors.request.use(
      config => {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        if (config.headers) {
          config.headers['x-request-id'] = requestId;
        }
        (config as any).metadata = { startTime: Date.now(), requestId };

        logger.debug('Service request initiated', {
          service: this.serviceName,
          method: config.method?.toUpperCase(),
          url: config.url,
          requestId,
        });

        return config;
      },
      error => Promise.reject(error)
    );

    // Response interceptor for monitoring
    this.axiosInstance.interceptors.response.use(
      response => {
        const { startTime, requestId } =
          (response.config as any).metadata || {};
        const latency = Date.now() - (startTime || Date.now());

        logger.debug('Service request completed', {
          service: this.serviceName,
          status: response.status,
          latency,
          requestId,
        });

        return response;
      },
      error => {
        const { startTime, requestId } = error.config?.metadata || {};
        const latency = Date.now() - (startTime || Date.now());

        logger.error('Service request failed', {
          service: this.serviceName,
          error: error.message,
          status: error.response?.status,
          latency,
          requestId,
        });

        return Promise.reject(error);
      }
    );
  }

  async healthCheck(): Promise<boolean> {
    const now = Date.now();
    // Cache health check for 30 seconds
    if (now - this.lastHealthCheck < 30000 && this.healthStatus) {
      return this.healthStatus;
    }

    try {
      const serviceConfig = SERVICE_REGISTRY[this.serviceName];
      const response = await this.axiosInstance.get(serviceConfig.healthCheck, {
        timeout: 5000, // Shorter timeout for health checks
      });

      this.healthStatus = response.status === 200;
      this.lastHealthCheck = now;

      logger.debug('Health check completed', {
        service: this.serviceName,
        healthy: this.healthStatus,
      });

      return this.healthStatus;
    } catch (error) {
      this.healthStatus = false;
      this.lastHealthCheck = now;

      logger.warn('Health check failed', {
        service: this.serviceName,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }

  async get<T>(
    path: string,
    config?: AxiosRequestConfig
  ): Promise<ApiResponse<T>> {
    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(() => this.axiosInstance.get(path, config));
    });
  }

  async post<T>(
    path: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<ApiResponse<T>> {
    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(() =>
        this.axiosInstance.post(path, data, config)
      );
    });
  }

  async put<T>(
    path: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<ApiResponse<T>> {
    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(() =>
        this.axiosInstance.put(path, data, config)
      );
    });
  }

  async delete<T>(
    path: string,
    config?: AxiosRequestConfig
  ): Promise<ApiResponse<T>> {
    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(() =>
        this.axiosInstance.delete(path, config)
      );
    });
  }

  private async executeWithRetry(
    operation: () => Promise<any>
  ): Promise<ApiResponse<any>> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const startTime = Date.now();
        const response = await operation();
        const latency = Date.now() - startTime;

        return {
          success: true,
          data: response.data,
          metadata: {
            requestId: response.config.metadata?.requestId || 'unknown',
            timestamp: new Date().toISOString(),
            latency,
            service: this.serviceName,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.retries) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
          logger.warn(
            `Service request attempt ${attempt} failed, retrying in ${backoffDelay}ms`,
            {
              service: this.serviceName,
              error: lastError.message,
              attempt,
            }
          );

          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
      }
    }

    // All retries failed
    const latency = 0;
    return {
      success: false,
      error: {
        code: 'SERVICE_ERROR',
        message: lastError!.message,
        details: {
          service: this.serviceName,
          attempts: this.retries,
        },
      },
      metadata: {
        requestId: 'failed',
        timestamp: new Date().toISOString(),
        latency,
        service: this.serviceName,
      },
    };
  }

  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  isHealthy(): boolean {
    return this.healthStatus;
  }
}

// Service Client Manager
class ServiceClientManager {
  private clients: Map<string, ServiceClient> = new Map();

  getClient(serviceName: string): ServiceClient {
    if (!this.clients.has(serviceName)) {
      this.clients.set(serviceName, new ServiceClient(serviceName));
    }
    return this.clients.get(serviceName)!;
  }

  async checkAllServices(): Promise<Record<string, boolean>> {
    const healthChecks = Object.keys(SERVICE_REGISTRY).map(
      async serviceName => {
        const client = this.getClient(serviceName);
        const isHealthy = await client.healthCheck();
        return { serviceName, isHealthy };
      }
    );

    const results = await Promise.allSettled(healthChecks);
    const healthStatus: Record<string, boolean> = {};

    results.forEach((result, index) => {
      const serviceName = Object.keys(SERVICE_REGISTRY)[index];
      if (result.status === 'fulfilled') {
        healthStatus[serviceName] = result.value.isHealthy;
      } else {
        healthStatus[serviceName] = false;
      }
    });

    return healthStatus;
  }

  getServiceStatus(): Record<
    string,
    { healthy: boolean; circuitState: string }
  > {
    const status: Record<string, { healthy: boolean; circuitState: string }> =
      {};

    for (const serviceName of Object.keys(SERVICE_REGISTRY)) {
      if (this.clients.has(serviceName)) {
        const client = this.clients.get(serviceName)!;
        status[serviceName] = {
          healthy: client.isHealthy(),
          circuitState: client.getCircuitBreakerState(),
        };
      } else {
        status[serviceName] = {
          healthy: false,
          circuitState: 'UNKNOWN',
        };
      }
    }

    return status;
  }
}

// Export singleton instance
export const serviceClientManager = new ServiceClientManager();

// Helper function to get a service client
export function getServiceClient(serviceName: string): ServiceClient {
  return serviceClientManager.getClient(serviceName);
}

// Data loader helpers for batching requests
export class ServiceDataLoader {
  private static pendingRequests: Map<string, Promise<any>> = new Map();

  static async batchLoad<T>(
    serviceName: string,
    path: string,
    ids: readonly string[],
    requestTransformer?: (ids: string[]) => any
  ): Promise<T[]> {
    const cacheKey = `${serviceName}:${path}:${ids.join(',')}`;

    if (this.pendingRequests.has(cacheKey)) {
      return this.pendingRequests.get(cacheKey);
    }

    const promise = this.executeBatchRequest<T>(
      serviceName,
      path,
      ids,
      requestTransformer
    );
    this.pendingRequests.set(cacheKey, promise);

    // Clear cache after completion
    promise.finally(() => {
      this.pendingRequests.delete(cacheKey);
    });

    return promise;
  }

  private static async executeBatchRequest<T>(
    serviceName: string,
    path: string,
    ids: readonly string[],
    requestTransformer?: (ids: string[]) => any
  ): Promise<T[]> {
    const client = getServiceClient(serviceName);
    const requestData = requestTransformer
      ? requestTransformer([...ids])
      : { ids: [...ids] };

    const response = await client.post<T[]>(path, requestData);

    if (!response.success || !response.data) {
      throw new Error(
        `Batch request failed: ${response.error?.message || 'Unknown error'}`
      );
    }

    return response.data;
  }
}
