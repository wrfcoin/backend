/**
 * Service Registry with Type Safety Validation
 * Manages service discovery, registration, and type contract validation
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { EventEmitter } from 'events';
import {
  ServiceRegistry,
  ServiceDefinition,
  ServiceRegistration,
  ServiceClient,
  InterServiceCall,
  InterServiceResponse,
  HealthCheckResult,
  TypeValidationResult,
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerMetrics,
  ValidationResult,
  ServiceContext,
  Logger,
} from '../types/service-integration-types.js';

/**
 * Circuit Breaker Implementation
 */
class ServiceCircuitBreaker implements CircuitBreaker {
  public state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: Date;
  private nextAttempt?: Date;

  constructor(public readonly config: CircuitBreakerConfig) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitBreakerState.HALF_OPEN;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    if (
      this.state === CircuitBreakerState.HALF_OPEN &&
      this.successCount >= this.config.halfOpenMaxCalls
    ) {
      throw new Error('Circuit breaker HALF_OPEN - max calls exceeded');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
    this.nextAttempt = undefined;
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
    };
  }

  private onSuccess(): void {
    this.successCount++;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.CLOSED;
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
      this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
    }
  }

  private shouldAttemptReset(): boolean {
    return this.nextAttempt ? new Date() >= this.nextAttempt : false;
  }
}

/**
 * Type-Safe Service Client Implementation
 */
class TypeSafeServiceClient implements ServiceClient {
  private axiosInstance: AxiosInstance;
  private circuitBreaker: ServiceCircuitBreaker;
  private logger: Logger;

  constructor(
    public readonly serviceId: string,
    public readonly baseUrl: string,
    public readonly version: string,
    public readonly timeout: number = 5000,
    circuitBreakerConfig: CircuitBreakerConfig,
    logger: Logger
  ) {
    this.axiosInstance = axios.create({
      baseURL: baseUrl,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Service-Version': version,
        'X-Service-Client': serviceId,
      },
    });

    this.circuitBreaker = new ServiceCircuitBreaker(circuitBreakerConfig);
    this.logger = logger;

    // Add request interceptor for tracing
    this.axiosInstance.interceptors.request.use(config => {
      config.headers['X-Request-ID'] =
        `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      config.headers['X-Request-Timestamp'] = new Date().toISOString();
      return config;
    });

    // Add response interceptor for metrics
    this.axiosInstance.interceptors.response.use(
      response => {
        this.logger.debug(
          `Service call succeeded: ${response.config.method?.toUpperCase()} ${response.config.url}`,
          {
            status: response.status,
            duration:
              Date.now() - parseInt((response.config as any).metadata?.startTime || '0'),
          }
        );
        return response;
      },
      error => {
        this.logger.error(
          `Service call failed: ${error.config?.method?.toUpperCase()} ${error.config?.url}`,
          {
            error: error.message,
            status: error.response?.status,
          }
        );
        throw error;
      }
    );
  }

  async call<TRequest, TResponse>(
    call: InterServiceCall<TRequest, TResponse>
  ): Promise<InterServiceResponse<TResponse>> {
    const startTime = Date.now();
    let retries = 0;
    const maxRetries = call.retries || 3;

    while (retries <= maxRetries) {
      try {
        const result = await this.circuitBreaker.execute(async () => {
          const config = {
            method: call.method,
            url: call.endpoint,
            data: call.data,
            headers: call.headers,
            timeout: call.timeout || this.timeout,
            metadata: { startTime: startTime.toString() },
          } as AxiosRequestConfig & { metadata?: Record<string, string> };

          const response = await this.axiosInstance.request(config);
          return response.data;
        });

        return {
          success: true,
          data: result,
          metadata: {
            service: this.serviceId,
            endpoint: call.endpoint,
            duration: Date.now() - startTime,
            retries,
            cached: false,
            timestamp: new Date(),
          },
        };
      } catch (error) {
        retries++;

        if (retries > maxRetries) {
          return {
            success: false,
            error: {
              code: 'SERVICE_CALL_FAILED',
              message: error instanceof Error ? error.message : 'Unknown error',
              details: error,
            },
            metadata: {
              service: this.serviceId,
              endpoint: call.endpoint,
              duration: Date.now() - startTime,
              retries: retries - 1,
              cached: false,
              timestamp: new Date(),
            },
          };
        }

        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, Math.pow(2, retries) * 1000)
        );
      }
    }

    throw new Error('Unexpected error in service call');
  }

  async get<TResponse>(
    endpoint: string,
    params?: any
  ): Promise<InterServiceResponse<TResponse>> {
    return this.call<undefined, TResponse>({
      targetService: this.serviceId,
      endpoint,
      method: 'GET',
      data: undefined,
    });
  }

  async post<TRequest, TResponse>(
    endpoint: string,
    data: TRequest
  ): Promise<InterServiceResponse<TResponse>> {
    return this.call<TRequest, TResponse>({
      targetService: this.serviceId,
      endpoint,
      method: 'POST',
      data,
    });
  }

  async put<TRequest, TResponse>(
    endpoint: string,
    data: TRequest
  ): Promise<InterServiceResponse<TResponse>> {
    return this.call<TRequest, TResponse>({
      targetService: this.serviceId,
      endpoint,
      method: 'PUT',
      data,
    });
  }

  async delete<TResponse>(
    endpoint: string
  ): Promise<InterServiceResponse<TResponse>> {
    return this.call<undefined, TResponse>({
      targetService: this.serviceId,
      endpoint,
      method: 'DELETE',
      data: undefined,
    });
  }

  async health(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await this.axiosInstance.get('/health', {
        timeout: 5000,
      });
      const duration = Date.now() - startTime;

      if (response.status === 200) {
        return {
          status: 'healthy',
          duration,
          details: response.data,
        };
      } else {
        return {
          status: 'unhealthy',
          duration,
          message: `HTTP ${response.status}`,
          details: response.data,
        };
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        duration: Date.now() - startTime,
        message: error instanceof Error ? error.message : 'Health check failed',
        details: error,
      };
    }
  }
}

/**
 * Main Service Registry Implementation
 */
export class WRFCoinServiceRegistry
  extends EventEmitter
  implements ServiceRegistry
{
  private services = new Map<string, ServiceDefinition>();
  private registrations = new Map<string, ServiceRegistration>();
  private clients = new Map<string, ServiceClient>();
  private logger: Logger;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
    this.setupHealthChecking();
  }

  async register(service: ServiceDefinition): Promise<void> {
    // Validate service definition
    const validationResult = await this.validateServiceDefinition(service);
    if (!validationResult.isValid) {
      throw new Error(
        `Invalid service definition: ${validationResult.errors.join(', ')}`
      );
    }

    // Store service definition
    this.services.set(service.serviceId, service);

    // Create service registration
    const registration: ServiceRegistration = {
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      version: service.version,
      host: 'localhost', // This would be dynamically determined
      port: service.port,
      protocol: service.protocol,
      healthCheckUrl: `${service.protocol}://localhost:${service.port}/health`,
      tags: [service.serviceName, `version:${service.version}`],
      metadata: {
        endpoints: service.endpoints.length.toString(),
        dependencies: service.dependencies.length.toString(),
        documentation: JSON.stringify(service.documentation),
      },
      lastHeartbeat: new Date(),
      status: 'unknown',
    };

    this.registrations.set(service.serviceId, registration);

    // Create service client
    const client = new TypeSafeServiceClient(
      service.serviceId,
      `${service.protocol}://localhost:${service.port}`,
      service.version,
      5000,
      {
        failureThreshold: 5,
        recoveryTimeout: 30000,
        halfOpenMaxCalls: 3,
        monitoringPeriod: 60000,
      },
      this.logger
    );

    this.clients.set(service.serviceId, client);

    this.logger.info(`Service registered: ${service.serviceId}`, {
      serviceName: service.serviceName,
      version: service.version,
      port: service.port,
      endpoints: service.endpoints.length,
    });

    this.emit('service:registered', registration);
  }

  async deregister(serviceId: string): Promise<void> {
    this.services.delete(serviceId);
    this.registrations.delete(serviceId);
    this.clients.delete(serviceId);

    this.logger.info(`Service deregistered: ${serviceId}`);
    this.emit('service:deregistered', serviceId);
  }

  async discover(serviceId: string): Promise<ServiceRegistration | null> {
    return this.registrations.get(serviceId) || null;
  }

  async discoverAll(): Promise<ServiceRegistration[]> {
    return Array.from(this.registrations.values());
  }

  async validateTypes(serviceId: string): Promise<TypeValidationResult> {
    const service = this.services.get(serviceId);
    if (!service) {
      throw new Error(`Service not found: ${serviceId}`);
    }

    const result: TypeValidationResult = {
      serviceId,
      isValid: true,
      errors: [],
      warnings: [],
      timestamp: new Date(),
    };

    // Validate each endpoint's type contracts
    for (const endpoint of service.endpoints) {
      try {
        if (endpoint.validation) {
          // Validate request/response schemas
          const schemaValidation = await this.validateEndpointSchema(endpoint);
          if (!schemaValidation.isValid) {
            result.isValid = false;
            result.errors.push(
              ...schemaValidation.errors.map(error => ({
                endpoint: `${endpoint.method} ${endpoint.path}`,
                field: error.field,
                expected: 'valid schema',
                actual: 'invalid schema',
                message: error.message,
              }))
            );
          }
        }
      } catch (error) {
        result.isValid = false;
        result.errors.push({
          endpoint: `${endpoint.method} ${endpoint.path}`,
          field: 'validation',
          expected: 'valid validation schema',
          actual: 'error during validation',
          message:
            error instanceof Error ? error.message : 'Unknown validation error',
        });
      }
    }

    this.logger.debug(`Type validation completed for ${serviceId}`, {
      isValid: result.isValid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
    });

    return result;
  }

  async healthCheck(serviceId: string): Promise<HealthCheckResult> {
    const client = this.clients.get(serviceId);
    if (!client) {
      return {
        status: 'unhealthy',
        duration: 0,
        message: 'Service client not found',
      };
    }

    return client.health();
  }

  getClient(serviceId: string): ServiceClient | null {
    return this.clients.get(serviceId) || null;
  }

  private async validateServiceDefinition(
    service: ServiceDefinition
  ): Promise<ValidationResult<ServiceDefinition>> {
    const errors: string[] = [];

    // Basic validation
    if (!service.serviceId) errors.push('serviceId is required');
    if (!service.serviceName) errors.push('serviceName is required');
    if (!service.version) errors.push('version is required');
    if (!service.port || service.port < 1 || service.port > 65535)
      errors.push('valid port is required');
    if (!['http', 'https', 'grpc'].includes(service.protocol))
      errors.push('protocol must be http, https, or grpc');

    // Validate endpoints
    for (let i = 0; i < service.endpoints.length; i++) {
      const endpoint = service.endpoints[i];
      if (!endpoint.method) errors.push(`endpoints[${i}].method is required`);
      if (!endpoint.path) errors.push(`endpoints[${i}].path is required`);
      if (!endpoint.handler) errors.push(`endpoints[${i}].handler is required`);
    }

    // Validate dependencies
    for (let i = 0; i < service.dependencies.length; i++) {
      const dep = service.dependencies[i];
      if (!dep.serviceId)
        errors.push(`dependencies[${i}].serviceId is required`);
      if (!dep.version) errors.push(`dependencies[${i}].version is required`);
    }

    return {
      isValid: errors.length === 0,
      data: errors.length === 0 ? service : undefined,
      errors: errors.map(message => ({
        field: '',
        message,
        code: 'VALIDATION_ERROR',
      })),
    };
  }

  private async validateEndpointSchema(
    endpoint: any
  ): Promise<ValidationResult<any>> {
    // This would implement actual schema validation using Joi, Ajv, etc.
    // For now, just return valid
    return {
      isValid: true,
      errors: [],
    };
  }

  private setupHealthChecking(): void {
    // Periodic health checking
    setInterval(async () => {
      for (const [serviceId, registration] of this.registrations.entries()) {
        try {
          const health = await this.healthCheck(serviceId);
          const previousStatus = registration.status;

          registration.status =
            health.status === 'healthy' ? 'healthy' : 'unhealthy';
          registration.lastHeartbeat = new Date();

          if (previousStatus !== registration.status) {
            this.logger.info(`Service health status changed: ${serviceId}`, {
              previousStatus,
              newStatus: registration.status,
              duration: health.duration,
            });

            this.emit('service:health-changed', {
              serviceId,
              status: registration.status,
              previousStatus,
            });
          }
        } catch (error) {
          this.logger.error(`Health check failed for service: ${serviceId}`, {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }, 30000); // Check every 30 seconds
  }
}

// Service registry singleton
let registryInstance: WRFCoinServiceRegistry | null = null;

export function createServiceRegistry(logger: Logger): WRFCoinServiceRegistry {
  if (!registryInstance) {
    registryInstance = new WRFCoinServiceRegistry(logger);
  }
  return registryInstance;
}

export function getServiceRegistry(): WRFCoinServiceRegistry {
  if (!registryInstance) {
    throw new Error(
      'Service registry not initialized. Call createServiceRegistry first.'
    );
  }
  return registryInstance;
}
