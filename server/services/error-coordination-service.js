/**
 * Service-Level Error Coordination - Task 67.3
 *
 * Coordinates error handling across different service layers:
 * - Cross-chain bridge error recovery
 * - IoT sensor error handling
 * - Database error management
 * - Cache error handling
 * - External service integration
 */

const {
  serviceRegistry,
  WrfcoinError,
  CrossChainError,
  IoTError,
  DatabaseError,
  ExternalServiceError,
  NetworkError,
  RetryManager,
  ErrorClassificationManager,
} = require('../middleware/error-handler');
const { DatabaseErrorHandler } = require('../database-error-handler');
const {
  appLogger,
  crosschainLogger,
  iotLogger,
  performanceLogger,
  logError,
  getCorrelationId,
} = require('../utils/logger');

/**
 * Cross-Chain Bridge Error Coordination
 */
class CrossChainErrorCoordinator {
  constructor() {
    this.retryManager = new RetryManager({
      maxRetries: 3,
      baseDelay: 5000,
      maxDelay: 30000,
      backoffMultiplier: 2,
    });

    // Register cross-chain services with circuit breakers
    this.setupServiceRegistry();
  }

  setupServiceRegistry() {
    const bridgeServices = [
      'ethereum-polygon-bridge',
      'ethereum-bsc-bridge',
      'ethereum-avalanche-bridge',
      'cosmos-osmosis-bridge',
      'polkadot-kusama-bridge',
    ];

    bridgeServices.forEach(service => {
      serviceRegistry.registerService(service, {
        failureThreshold: 3,
        recoveryTimeout: 60000, // 1 minute for cross-chain
        monitor: (success, duration) => {
          crosschainLogger.info(`Bridge service monitor: ${service}`, {
            operation: `bridge-monitor:${service}`,
            success,
            duration,
            performance: { responseTime: duration },
          });
        },
      });
    });
  }

  async executeBridgeOperation(
    sourceChain,
    targetChain,
    operation,
    operationFn,
    options = {}
  ) {
    const serviceName = `${sourceChain}-${targetChain}-bridge`;
    const correlationId = options.correlationId || getCorrelationId();

    const context = {
      operation: `bridge:${sourceChain}->${targetChain}:${operation}`,
      correlationId,
      sourceChain,
      targetChain,
      bridgeType: operation,
    };

    try {
      // Retry composes OUTSIDE the breaker (owner ruling, 2026-08-31): each
      // retry attempt is its own executeServiceCall, so the breaker observes
      // and counts every attempt instead of having up to maxRetries+1 of them
      // hidden inside one breaker-visible call. See the re-targeted
      // "crosschain bridge breaker observes every retry attempt" test in
      // server/__tests__/error-handling.test.js for the measured before/after
      // request counts to trip.
      const result = await this.retryManager.execute(
        () =>
          serviceRegistry.executeServiceCall(
            serviceName,
            operationFn,
            options.fallback,
            context
          ),
        context
      );

      crosschainLogger.info(
        `Bridge operation succeeded: ${sourceChain} -> ${targetChain}`,
        {
          operation: context.operation,
          correlationId,
          crossChain: {
            sourceChain,
            targetChain,
            bridgeType: operation,
            amount: options.amount,
          },
        }
      );

      return result;
    } catch (error) {
      const crossChainError = new CrossChainError(
        `Bridge operation failed: ${sourceChain} -> ${targetChain}: ${error.message}`,
        {
          sourceChain,
          targetChain,
          bridgeType: operation,
          amount: options.amount,
          correlationId,
          cause: error,
          context: options.context,
        }
      );

      logError(
        crosschainLogger,
        'Cross-chain bridge operation failed',
        crossChainError,
        context
      );

      // Determine if this should trigger circuit breaker or escalation
      await this.handleBridgeFailure(crossChainError, options);

      throw crossChainError;
    }
  }

  async handleBridgeFailure(error, options = {}) {
    const recovery = ErrorClassificationManager.determineRecoveryAction(error);

    // Check for systematic bridge issues
    if (error.sourceChain && error.targetChain) {
      const serviceName = `${error.sourceChain}-${error.targetChain}-bridge`;
      const stats = serviceRegistry.getServiceStats(serviceName);

      if (stats && stats.successRate < 0.5) {
        crosschainLogger.error('Bridge service showing systematic issues', {
          operation: 'bridge-health-check',
          serviceName,
          stats,
          correlationId: error.correlationId,
        });

        // Could trigger bridge maintenance mode here
        if (options.onSystematicFailure) {
          await options.onSystematicFailure(serviceName, stats);
        }
      }
    }

    // Escalate critical bridge failures
    if (recovery.escalate || error.severity === 'critical') {
      crosschainLogger.error('Escalating critical bridge failure', {
        operation: 'bridge-escalation',
        error: error.toJSON(),
        correlationId: error.correlationId,
      });

      if (options.onEscalation) {
        await options.onEscalation(error);
      }
    }
  }
}

/**
 * IoT Sensor Error Coordination
 */
class IoTErrorCoordinator {
  constructor() {
    this.retryManager = new RetryManager({
      maxRetries: 2,
      baseDelay: 3000,
      maxDelay: 15000,
    });

    this.sensorRegistry = new Map();
    this.setupIoTServices();
  }

  setupIoTServices() {
    const iotPlatforms = [
      'iotex-w3bstream',
      'sensor-community',
      'tataucloud',
      'helium-network',
      'thethingsnetwork',
    ];

    iotPlatforms.forEach(platform => {
      serviceRegistry.registerService(platform, {
        failureThreshold: 5, // IoT can be less reliable
        recoveryTimeout: 45000,
        monitor: (success, duration) => {
          iotLogger.info(`IoT platform monitor: ${platform}`, {
            operation: `iot-monitor:${platform}`,
            success,
            duration,
          });
        },
      });
    });
  }

  async executeSensorOperation(
    deviceId,
    sensorType,
    operation,
    operationFn,
    options = {}
  ) {
    const platform = options.platform || 'default-iot';
    const correlationId = options.correlationId || getCorrelationId();

    const context = {
      operation: `iot:${platform}:${operation}`,
      correlationId,
      deviceId,
      sensorType,
      platform,
    };

    try {
      // Retry composes OUTSIDE the breaker (owner ruling, 2026-08-31): same
      // fix as CrossChainErrorCoordinator.executeBridgeOperation above — see
      // its comment for why.
      const result = await this.retryManager.execute(
        () =>
          serviceRegistry.executeServiceCall(
            platform,
            operationFn,
            options.fallback,
            context
          ),
        context
      );

      iotLogger.info(`IoT sensor operation succeeded: ${deviceId}`, {
        operation: context.operation,
        correlationId,
        iot: {
          deviceId,
          sensorType,
          platform,
          dataPoints: options.dataPoints,
          quality: options.quality,
          location: options.location,
        },
      });

      return result;
    } catch (error) {
      const iotError = new IoTError(
        `IoT sensor operation failed: ${deviceId}: ${error.message}`,
        {
          deviceId,
          sensorType,
          platform,
          correlationId,
          cause: error,
          context: options.context,
          dataQuality: options.quality,
          location: options.location,
        }
      );

      logError(iotLogger, 'IoT sensor operation failed', iotError, context);

      // Handle sensor-specific failures
      await this.handleSensorFailure(iotError, options);

      throw iotError;
    }
  }

  async handleSensorFailure(error, options = {}) {
    // Track sensor reliability
    if (error.deviceId) {
      const sensorData = this.sensorRegistry.get(error.deviceId) || {
        totalOperations: 0,
        failures: 0,
        lastFailure: null,
      };

      sensorData.totalOperations++;
      sensorData.failures++;
      sensorData.lastFailure = new Date().toISOString();

      this.sensorRegistry.set(error.deviceId, sensorData);

      // Check sensor reliability
      const failureRate = sensorData.failures / sensorData.totalOperations;
      if (failureRate > 0.7 && sensorData.totalOperations > 10) {
        iotLogger.warn('Unreliable sensor detected', {
          operation: 'sensor-reliability-check',
          deviceId: error.deviceId,
          failureRate,
          totalOperations: sensorData.totalOperations,
          correlationId: error.correlationId,
        });

        if (options.onUnreliableSensor) {
          await options.onUnreliableSensor(error.deviceId, sensorData);
        }
      }
    }

    // Escalate location-based failures
    if (error.location && options.onLocationFailure) {
      await options.onLocationFailure(error.location, error);
    }
  }

  getSensorStats(deviceId) {
    return this.sensorRegistry.get(deviceId);
  }

  getAllSensorStats() {
    const stats = {};
    for (const [deviceId, data] of this.sensorRegistry) {
      stats[deviceId] = {
        ...data,
        reliabilityScore:
          data.totalOperations > 0
            ? (data.totalOperations - data.failures) / data.totalOperations
            : 0,
      };
    }
    return stats;
  }
}

/**
 * Database Error Coordination
 */
class DatabaseErrorCoordinator {
  constructor() {
    this.retryManager = new RetryManager({
      maxRetries: 3,
      baseDelay: 2000,
      maxDelay: 10000,
    });

    this.connectionHealth = {
      totalConnections: 0,
      activeConnections: 0,
      failedConnections: 0,
      lastHealthCheck: null,
    };
  }

  async executeDatabaseOperation(operation, operationFn, options = {}) {
    const correlationId = options.correlationId || getCorrelationId();

    const context = {
      operation: `database:${operation}`,
      correlationId,
      table: options.table,
      query: options.query,
    };

    try {
      // Use existing DatabaseErrorHandler with our retry logic
      const result = await this.retryManager.execute(
        () => DatabaseErrorHandler.executeWithRetry(operationFn, 3),
        context
      );

      this.connectionHealth.totalConnections++;
      this.connectionHealth.activeConnections++;

      return result;
    } catch (error) {
      this.connectionHealth.failedConnections++;

      const dbError = new DatabaseError(
        `Database operation failed: ${operation}: ${error.message}`,
        {
          operation,
          query: options.query,
          table: options.table,
          correlationId,
          cause: error,
          retryable: this.isDatabaseErrorRetryable(error),
        }
      );

      logError(appLogger, 'Database operation failed', dbError, context);

      // Handle specific database failure patterns
      await this.handleDatabaseFailure(dbError, options);

      throw dbError;
    } finally {
      if (this.connectionHealth.activeConnections > 0) {
        this.connectionHealth.activeConnections--;
      }
    }
  }

  isDatabaseErrorRetryable(error) {
    const retryableCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ER_LOCK_DEADLOCK',
      'ER_LOCK_WAIT_TIMEOUT',
    ];

    return retryableCodes.some(
      code => error.message.includes(code) || error.code === code
    );
  }

  async handleDatabaseFailure(error, options = {}) {
    // Check connection health
    const healthCheck = this.getConnectionHealth();

    if (healthCheck.failureRate > 0.5) {
      appLogger.error('Database showing high failure rate', {
        operation: 'database-health-check',
        healthCheck,
        correlationId: error.correlationId,
      });

      if (options.onDatabaseUnhealthy) {
        await options.onDatabaseUnhealthy(healthCheck);
      }
    }

    // Handle deadlock patterns
    if (
      error.message.includes('deadlock') ||
      error.code === 'ER_LOCK_DEADLOCK'
    ) {
      appLogger.warn('Database deadlock detected', {
        operation: 'deadlock-detection',
        table: error.table,
        query: error.query,
        correlationId: error.correlationId,
      });

      if (options.onDeadlock) {
        await options.onDeadlock(error);
      }
    }
  }

  getConnectionHealth() {
    this.connectionHealth.lastHealthCheck = new Date().toISOString();

    return {
      ...this.connectionHealth,
      failureRate:
        this.connectionHealth.totalConnections > 0
          ? this.connectionHealth.failedConnections /
            this.connectionHealth.totalConnections
          : 0,
      activeConnectionRatio:
        this.connectionHealth.totalConnections > 0
          ? this.connectionHealth.activeConnections /
            this.connectionHealth.totalConnections
          : 0,
    };
  }
}

/**
 * Cache Error Coordination
 */
class CacheErrorCoordinator {
  constructor() {
    this.cacheHealth = {
      hits: 0,
      misses: 0,
      errors: 0,
      lastCheck: null,
    };
  }

  async executeCacheOperation(operation, operationFn, options = {}) {
    const correlationId = options.correlationId || getCorrelationId();

    const context = {
      operation: `cache:${operation}`,
      correlationId,
      key: options.key,
      ttl: options.ttl,
    };

    try {
      const result = await operationFn();

      if (operation === 'get') {
        if (result !== null && result !== undefined) {
          this.cacheHealth.hits++;
        } else {
          this.cacheHealth.misses++;
        }
      }

      return result;
    } catch (error) {
      this.cacheHealth.errors++;

      // For cache operations, we typically want to fail gracefully
      const cacheError = new ExternalServiceError(
        `Cache operation failed: ${operation}: ${error.message}`,
        {
          serviceName: 'redis-cache',
          operation,
          correlationId,
          cause: error,
          retryable: true,
          retryAfter: 5000,
        }
      );

      logError(appLogger, 'Cache operation failed', cacheError, context);

      // For cache, we often want to continue without caching rather than fail
      if (options.gracefulDegradation) {
        appLogger.warn('Cache operation failed, continuing without cache', {
          operation: context.operation,
          correlationId,
          gracefulDegradation: true,
        });

        return options.fallbackValue;
      }

      throw cacheError;
    }
  }

  getCacheHealth() {
    this.cacheHealth.lastCheck = new Date().toISOString();

    const total = this.cacheHealth.hits + this.cacheHealth.misses;

    return {
      ...this.cacheHealth,
      hitRate: total > 0 ? this.cacheHealth.hits / total : 0,
      errorRate:
        total > 0
          ? this.cacheHealth.errors / (total + this.cacheHealth.errors)
          : 0,
    };
  }
}

// Global coordinator instances
const crossChainCoordinator = new CrossChainErrorCoordinator();
const iotCoordinator = new IoTErrorCoordinator();
const databaseCoordinator = new DatabaseErrorCoordinator();
const cacheCoordinator = new CacheErrorCoordinator();

/**
 * Master Error Coordination Service
 */
class ErrorCoordinationService {
  static async getSystemHealth() {
    const health = {
      timestamp: new Date().toISOString(),
      services: serviceRegistry.getAllServiceStats(),
      crossChain: {
        // Add cross-chain specific health metrics
        activeBridges: Object.keys(serviceRegistry.getAllServiceStats()).filter(
          name => name.includes('bridge')
        ).length,
      },
      iot: {
        totalSensors: Object.keys(iotCoordinator.getAllSensorStats()).length,
        sensorStats: iotCoordinator.getAllSensorStats(),
      },
      database: databaseCoordinator.getConnectionHealth(),
      cache: cacheCoordinator.getCacheHealth(),
    };

    performanceLogger.info('System health check completed', {
      operation: 'system-health-check',
      health: {
        totalServices: Object.keys(health.services).length,
        healthyServices: Object.values(health.services).filter(
          s => s && s.successRate > 0.8
        ).length,
        databaseHealthy: health.database.failureRate < 0.1,
        cacheHealthy: health.cache.errorRate < 0.05,
      },
    });

    return health;
  }

  static async executeCoordinatedOperation(
    type,
    operation,
    operationFn,
    options = {}
  ) {
    switch (type) {
      case 'cross-chain':
        return crossChainCoordinator.executeBridgeOperation(
          options.sourceChain,
          options.targetChain,
          operation,
          operationFn,
          options
        );

      case 'iot':
        return iotCoordinator.executeSensorOperation(
          options.deviceId,
          options.sensorType,
          operation,
          operationFn,
          options
        );

      case 'database':
        return databaseCoordinator.executeDatabaseOperation(
          operation,
          operationFn,
          options
        );

      case 'cache':
        return cacheCoordinator.executeCacheOperation(
          operation,
          operationFn,
          options
        );

      default:
        throw new WrfcoinError(`Unknown coordination type: ${type}`, {
          code: 'UNKNOWN_COORDINATION_TYPE',
          category: 'configuration',
        });
    }
  }
}

module.exports = {
  ErrorCoordinationService,
  CrossChainErrorCoordinator,
  IoTErrorCoordinator,
  DatabaseErrorCoordinator,
  CacheErrorCoordinator,
  crossChainCoordinator,
  iotCoordinator,
  databaseCoordinator,
  cacheCoordinator,
};
