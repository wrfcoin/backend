/**
 * Comprehensive Error Handling System Tests - Task 67.3
 *
 * Tests for centralized error handling, circuit breakers, retry logic,
 * GraphQL error handling, and service coordination.
 */

const request = require('supertest');
const express = require('express');
const {
  WrfcoinError,
  ValidationError,
  AuthenticationError,
  // backend#1089: used throughout this file but never imported, so four tests
  // died with `ReferenceError: NetworkError is not defined` before asserting
  // anything. The module has always exported both.
  AuthorizationError,
  NetworkError,
  CrossChainError,
  IoTError,
  DatabaseError,
  CircuitBreaker,
  RetryManager,
  ErrorClassificationManager,
  ServiceRegistry,
  createErrorHandler,
  setupErrorHandling,
  serviceRegistry,
} = require('../middleware/error-handler');
const {
  ErrorCoordinationService,
  CrossChainErrorCoordinator,
} = require('../services/error-coordination-service');
const { createGraphQLErrorFormatter } = require('../graphql/error-handling');

describe('Error Handling System Tests', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(setupErrorHandling());
  });

  afterEach(() => {
    // Reset service registry
    serviceRegistry.services.clear();
  });

  describe('WrfcoinError Class Hierarchy', () => {
    test('should create base WrfcoinError with all metadata', () => {
      const error = new WrfcoinError('Test error', {
        code: 'TEST_ERROR',
        category: 'test',
        severity: 'medium',
        service: 'test-service',
        operation: 'test-operation',
        correlationId: 'test-correlation-123',
        retryable: true,
        context: { testData: 'value' },
      });

      expect(error.name).toBe('WrfcoinError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.category).toBe('test');
      expect(error.severity).toBe('medium');
      expect(error.service).toBe('test-service');
      expect(error.operation).toBe('test-operation');
      expect(error.correlationId).toBe('test-correlation-123');
      expect(error.retryable).toBe(true);
      expect(error.context.testData).toBe('value');
      expect(error.timestamp).toBeDefined();
    });

    test('should create ValidationError with validation details', () => {
      const validationErrors = [
        { field: 'email', message: 'Invalid email format' },
        { field: 'password', message: 'Password too short' },
      ];

      const error = new ValidationError('Validation failed', {
        validationErrors,
        field: 'user-input',
      });

      expect(error.category).toBe('validation');
      expect(error.severity).toBe('low');
      expect(error.retryable).toBe(false);
      expect(error.validationErrors).toEqual(validationErrors);
      expect(error.field).toBe('user-input');
    });

    test('should create CrossChainError with bridge details', () => {
      const error = new CrossChainError('Bridge operation failed', {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridgeType: 'token-transfer',
        amount: '100.5',
      });

      expect(error.category).toBe('cross_chain');
      expect(error.retryable).toBe(true);
      expect(error.sourceChain).toBe('ethereum');
      expect(error.targetChain).toBe('polygon');
      expect(error.bridgeType).toBe('token-transfer');
      expect(error.amount).toBe('100.5');
    });

    test('should serialize error to JSON correctly', () => {
      const error = new WrfcoinError('Test error', {
        code: 'TEST_ERROR',
        correlationId: 'test-123',
      });

      const json = error.toJSON();

      expect(json.name).toBe('WrfcoinError');
      expect(json.message).toBe('Test error');
      expect(json.code).toBe('TEST_ERROR');
      expect(json.correlationId).toBe('test-123');
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('Circuit Breaker', () => {
    test('should trip circuit breaker after failure threshold', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 2,
        recoveryTimeout: 1000,
      });

      const failingOperation = async () => {
        throw new Error('Operation failed');
      };

      // First failure
      await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow(
        'Operation failed'
      );
      expect(circuitBreaker.state).toBe('CLOSED');

      // Second failure - should trip circuit
      await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow(
        'Operation failed'
      );
      expect(circuitBreaker.state).toBe('OPEN');

      // Third attempt - should fail immediately due to open circuit
      await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow(
        'Circuit breaker is OPEN'
      );
    });

    test('should execute fallback when circuit is open', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 1000,
      });

      const failingOperation = async () => {
        throw new Error('Operation failed');
      };

      const fallback = async () => 'fallback result';

      // Trip the circuit
      await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow(
        'Operation failed'
      );
      expect(circuitBreaker.state).toBe('OPEN');

      // Should execute fallback
      const result = await circuitBreaker.execute(failingOperation, fallback);
      expect(result).toBe('fallback result');
    });

    test('should transition to half-open and recover', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50, // Short timeout for testing
      });

      const failingOperation = async () => {
        throw new Error('Operation failed');
      };

      const successOperation = async () => 'success';

      // Trip the circuit
      await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow(
        'Operation failed'
      );
      expect(circuitBreaker.state).toBe('OPEN');

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 60));

      // Should transition to half-open and then closed on success
      const result = await circuitBreaker.execute(successOperation);
      expect(result).toBe('success');
      expect(circuitBreaker.state).toBe('CLOSED');
    });
  });

  describe('Retry Manager', () => {
    test('should retry retryable operations', async () => {
      const retryManager = new RetryManager({
        maxRetries: 2,
        baseDelay: 10, // Short delay for testing
      });

      let attempts = 0;
      const flakyOperation = async () => {
        attempts++;
        if (attempts < 3) {
          throw new NetworkError('Network timeout', { retryable: true });
        }
        return 'success';
      };

      const result = await retryManager.execute(flakyOperation);
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    test('should not retry non-retryable operations', async () => {
      const retryManager = new RetryManager({
        maxRetries: 2,
        baseDelay: 10,
      });

      let attempts = 0;
      const nonRetryableOperation = async () => {
        attempts++;
        throw new ValidationError('Invalid input', { retryable: false });
      };

      await expect(retryManager.execute(nonRetryableOperation)).rejects.toThrow(
        'Invalid input'
      );
      expect(attempts).toBe(1);
    });

    test('should calculate exponential backoff delays', () => {
      const retryManager = new RetryManager({
        baseDelay: 1000,
        backoffMultiplier: 2,
        jitter: false,
      });

      expect(retryManager.calculateDelay(1)).toBe(1000);
      expect(retryManager.calculateDelay(2)).toBe(2000);
      expect(retryManager.calculateDelay(3)).toBe(4000);
    });

    test('should enhance error with retry information', async () => {
      const retryManager = new RetryManager({
        maxRetries: 1,
        baseDelay: 10,
      });

      const failingOperation = async () => {
        throw new NetworkError('Network error', { retryable: true });
      };

      try {
        await retryManager.execute(failingOperation);
      } catch (error) {
        expect(error.context.retriesAttempted).toBe(1);
        expect(error.context.finalAttempt).toBe(true);
      }
    });
  });

  describe('Error Classification Manager', () => {
    test('should classify database errors correctly', () => {
      const dbError = new Error('ER_LOCK_DEADLOCK: Deadlock found');
      dbError.code = 'ER_LOCK_DEADLOCK';
      dbError.sql = 'SELECT * FROM users';

      const classified = ErrorClassificationManager.classifyError(dbError);

      expect(classified).toBeInstanceOf(DatabaseError);
      expect(classified.code).toBe('ER_LOCK_DEADLOCK');
      expect(classified.query).toBe('SELECT * FROM users');
      expect(classified.category).toBe('database');
    });

    test('should classify HTTP errors correctly', () => {
      const httpError = new Error('Request failed');
      httpError.response = {
        status: 503,
        statusText: 'Service Unavailable',
      };
      httpError.config = {
        url: 'https://api.example.com/data',
        method: 'GET',
      };

      const classified = ErrorClassificationManager.classifyError(httpError);

      expect(classified).toBeInstanceOf(NetworkError);
      expect(classified.statusCode).toBe(503);
      expect(classified.endpoint).toBe('https://api.example.com/data');
      expect(classified.method).toBe('GET');
      expect(classified.retryable).toBe(true);
    });

    test('should classify JWT errors correctly', () => {
      const jwtError = new Error('jwt expired');
      jwtError.name = 'TokenExpiredError';

      const classified = ErrorClassificationManager.classifyError(jwtError);

      expect(classified).toBeInstanceOf(AuthenticationError);
      expect(classified.tokenExpired).toBe(true);
      expect(classified.retryable).toBe(false);
    });

    test('should determine recovery actions correctly', () => {
      const networkError = new NetworkError('Connection timeout', {
        retryable: true,
        severity: 'high',
      });

      // NetworkError spreads the caller's options and then pins
      // `severity: 'medium'` AFTER the spread, so the 'high' passed above is
      // discarded. Kept as an assertion because the recovery policy for
      // network/external errors depends on it: if this ever reads 'high' again,
      // the severity pin moved.
      expect(networkError.severity).toBe('medium');

      const recovery =
        ErrorClassificationManager.determineRecoveryAction(networkError);

      expect(recovery.shouldRetry).toBe(true);
      expect(recovery.fallbackAvailable).toBe(true);
      // `circuitBreakerAction` is GONE (#1089). It was write-only — set in two
      // places, read in none — and named for an integration with the real
      // CircuitBreaker that never existed. Asserting its ABSENCE rather than
      // deleting the assertion: `toBe('none')` would also pass on an undefined
      // field, so it could not tell "removed" from "still there, still lying".
      expect(recovery).not.toHaveProperty('circuitBreakerAction');
      // The full shape, so a future addition to this object is a deliberate act.
      expect(Object.keys(recovery).sort()).toEqual([
        'escalate',
        'fallbackAvailable',
        'retryDelay',
        'shouldRetry',
      ]);
    });
  });

  describe('Service Registry', () => {
    test('should register service with circuit breaker', () => {
      const registry = new ServiceRegistry();

      registry.registerService('test-service', {
        failureThreshold: 3,
        recoveryTimeout: 30000,
      });

      const stats = registry.getServiceStats('test-service');
      expect(stats).toBeDefined();
      expect(stats.totalCalls).toBe(0);
      expect(stats.circuitBreaker.state).toBe('CLOSED');
    });

    test('should execute service call successfully', async () => {
      const registry = new ServiceRegistry();

      const operation = async () => 'service result';

      const result = await registry.executeServiceCall(
        'test-service',
        operation
      );
      expect(result).toBe('service result');

      const stats = registry.getServiceStats('test-service');
      expect(stats.totalCalls).toBe(1);
      expect(stats.successCalls).toBe(1);
      expect(stats.successRate).toBe(1);
    });

    test('should handle service call failures', async () => {
      const registry = new ServiceRegistry();

      const failingOperation = async () => {
        throw new Error('Service failed');
      };

      await expect(
        registry.executeServiceCall('test-service', failingOperation)
      ).rejects.toThrow('Service failed');

      const stats = registry.getServiceStats('test-service');
      expect(stats.totalCalls).toBe(1);
      expect(stats.failureCalls).toBe(1);
      expect(stats.successRate).toBe(0);
    });
  });

  describe('Express Error Handler Middleware', () => {
    test('should handle WrfcoinError correctly', async () => {
      app.get('/test-error', (req, res, next) => {
        const error = new ValidationError('Invalid input', {
          validationErrors: [{ field: 'email', message: 'Required' }],
        });
        next(error);
      });

      app.use(createErrorHandler());

      const response = await request(app).get('/test-error').expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.category).toBe('validation');
      expect(response.body.error.validationErrors).toBeDefined();
      expect(response.body.error.correlationId).toBeDefined();
    });

    test('should mask security errors', async () => {
      app.get('/security-error', (req, res, next) => {
        const error = new WrfcoinError('Detailed security information', {
          code: 'SECURITY_BREACH',
          category: 'security',
        });
        next(error);
      });

      app.use(createErrorHandler({ enableSecurityMasking: true }));

      const response = await request(app).get('/security-error').expect(500);

      expect(response.body.error.message).toBe('Security error occurred');
      expect(response.body.error.code).toBe('SECURITY_BREACH');
    });

    test('should set appropriate HTTP status codes', async () => {
      const testCases = [
        { error: new ValidationError('Invalid'), expectedStatus: 400 },
        {
          error: new AuthenticationError('Not authenticated'),
          expectedStatus: 401,
        },
        {
          error: new AuthorizationError('Not authorized'),
          expectedStatus: 403,
        },
        { error: new DatabaseError('DB failed'), expectedStatus: 503 },
        { error: new NetworkError('Network failed'), expectedStatus: 502 },
      ];

      for (const testCase of testCases) {
        app.get(`/test-${testCase.expectedStatus}`, (req, res, next) => {
          next(testCase.error);
        });
      }

      app.use(createErrorHandler());

      for (const testCase of testCases) {
        await request(app)
          .get(`/test-${testCase.expectedStatus}`)
          .expect(testCase.expectedStatus);
      }
    });

    test('should add correlation ID header', async () => {
      app.get('/test-correlation', (req, res, next) => {
        next(new WrfcoinError('Test error'));
      });

      app.use(createErrorHandler());

      const response = await request(app).get('/test-correlation').expect(500);

      expect(response.headers['x-correlation-id']).toBeDefined();
      expect(response.body.error.correlationId).toBeDefined();
    });
  });

  describe('GraphQL Error Handling', () => {
    test('should format GraphQL errors correctly', () => {
      const formatter = createGraphQLErrorFormatter({
        enableStackTrace: false,
        enableSecurityMasking: true,
        enableDetailedErrors: true,
      });

      const graphqlError = {
        message: 'Test GraphQL error',
        locations: [{ line: 1, column: 1 }],
        path: ['user', 'email'],
        originalError: new ValidationError('Invalid email', {
          validationErrors: [{ field: 'email', message: 'Required' }],
        }),
      };

      const formatted = formatter(graphqlError);

      expect(formatted.message).toBe('Test GraphQL error');
      expect(formatted.locations).toEqual([{ line: 1, column: 1 }]);
      expect(formatted.path).toEqual(['user', 'email']);
      expect(formatted.extensions.code).toBe('VALIDATION_ERROR');
      expect(formatted.extensions.category).toBe('validation');
      expect(formatted.extensions.validationErrors).toBeDefined();
      expect(formatted.extensions.correlationId).toBeDefined();
    });

    test('should mask security errors in GraphQL', () => {
      const formatter = createGraphQLErrorFormatter({
        enableSecurityMasking: true,
      });

      const securityError = {
        message: 'Sensitive security information',
        originalError: new WrfcoinError('Security breach details', {
          category: 'security',
        }),
      };

      const formatted = formatter(securityError);

      expect(formatted.message).toBe(
        'An error occurred while processing your request'
      );
      expect(formatted.extensions.masked).toBe(true);
    });
  });

  describe('Error Coordination Service', () => {
    test('should get system health status', async () => {
      // Register some test services
      serviceRegistry.registerService('test-service-1');
      serviceRegistry.registerService('test-service-2');

      const health = await ErrorCoordinationService.getSystemHealth();

      expect(health.timestamp).toBeDefined();
      expect(health.services).toBeDefined();
      expect(health.crossChain).toBeDefined();
      expect(health.iot).toBeDefined();
      expect(health.database).toBeDefined();
      expect(health.cache).toBeDefined();
    });

    test('should execute coordinated cross-chain operation', async () => {
      const operation = async () => 'bridge success';

      const result = await ErrorCoordinationService.executeCoordinatedOperation(
        'cross-chain',
        'token-transfer',
        operation,
        {
          sourceChain: 'ethereum',
          targetChain: 'polygon',
          amount: '100',
        }
      );

      expect(result).toBe('bridge success');
    });

    test('should execute coordinated IoT operation', async () => {
      const operation = async () => ({ temperature: 25.5, humidity: 60 });

      const result = await ErrorCoordinationService.executeCoordinatedOperation(
        'iot',
        'read-sensor',
        operation,
        {
          deviceId: 'sensor-001',
          sensorType: 'temperature',
          platform: 'iotex-w3bstream',
        }
      );

      expect(result.temperature).toBe(25.5);
      expect(result.humidity).toBe(60);
    });

    test('should throw error for unknown coordination type', async () => {
      const operation = async () => 'result';

      await expect(
        ErrorCoordinationService.executeCoordinatedOperation(
          'unknown-type',
          'operation',
          operation
        )
      ).rejects.toThrow('Unknown coordination type: unknown-type');
    });
  });

  describe('Integration Tests', () => {
    // RE-TARGETED (owner ruling, 2026-08-31): this test previously asserted
    // that a bare serviceRegistry.executeServiceCall(flakyOperation) retries
    // internally. It never did — CircuitBreaker.execute invokes the operation
    // exactly once, and executeServiceCall never composed retry (backend#1105
    // step 1 / backend#1106 pin that half). Closing it as a "wrong
    // expectation" was the wrong reasoning, though: the retry/breaker
    // composition DOES exist, at the caller. Every real caller of
    // executeServiceCall in error-coordination-service.js (the crosschain
    // bridge and IoT sensor coordinators) wraps its own RetryManager INSIDE
    // the function passed to executeServiceCall:
    //
    //   serviceRegistry.executeServiceCall(
    //     serviceName,
    //     () => this.retryManager.execute(operationFn, context),
    //     ...)
    //
    // Because CircuitBreaker.onSuccess() resets failureCount to 0, and a call
    // only fails (from the breaker's point of view) if EVERY internal retry
    // attempt failed, this nesting makes the breaker nearly unable to trip: on
    // the bridge path (maxRetries: 3, failureThreshold: 3) it takes ~12
    // consecutive failed underlying requests, not 3, to open — and on a path
    // whose breaker only sees one "attempt" per outer call regardless of
    // retries, that gap only grows with maxRetries. Retry must compose
    // OUTSIDE the breaker so the breaker observes and counts every attempt,
    // not just the outer call's final outcome. This test targets that real
    // composition point (error-coordination-service.js:93-96) instead of the
    // API surface that never offered it.
    test('crosschain bridge breaker observes every retry attempt, and opens on the 5th real request rather than the ~20th', async () => {
      const coordinator = new CrossChainErrorCoordinator();
      // The coordinator's own retryManager is hardcoded to production delays
      // (baseDelay: 5000, doubling) — override it for a fast, deterministic
      // test. This does not touch error-coordination-service.js.
      coordinator.retryManager = new RetryManager({
        maxRetries: 3,
        baseDelay: 1,
        jitter: false,
      });

      const sourceChain = 'nesting-proof-source';
      const targetChain = 'nesting-proof-target';
      const serviceName = `${sourceChain}-${targetChain}-bridge`;
      // Not one of the five hardcoded bridge names, so it auto-registers via
      // executeServiceCall with ServiceRegistry's default failureThreshold: 5
      // — independent of the real bridges' own registrations.

      let realRequests = 0;
      const alwaysFailingDependency = async () => {
        realRequests++;
        throw new NetworkError('Simulated dependency outage', {
          retryable: true,
        });
      };

      let outerCalls = 0;
      let stats;
      do {
        outerCalls++;
        await expect(
          coordinator.executeBridgeOperation(
            sourceChain,
            targetChain,
            'transfer',
            alwaysFailingDependency
          )
        ).rejects.toThrow();
        stats = serviceRegistry.getServiceStats(serviceName);
      } while (stats.circuitBreaker.state !== 'OPEN' && outerCalls <= 10);

      // The load-bearing assertions: the breaker's own failureCount — the
      // thing failureThreshold compares against — must equal the number of
      // REAL requests the flaky dependency actually received, not the number
      // of outer executeBridgeOperation calls. With retry composed outside
      // the breaker, each of the up-to-4 attempts per outer call
      // (maxRetries: 3, so 1 + 3) reaches the breaker independently.
      expect(stats.circuitBreaker.state).toBe('OPEN');
      expect(stats.circuitBreaker.failureCount).toBe(5);
      expect(realRequests).toBe(5);
      // 4 attempts exhaust outer call 1 (breaker still CLOSED, 4 < 5); outer
      // call 2's FIRST attempt is the 5th real request and trips the breaker
      // mid-retry, so its remaining attempts fail fast against an OPEN
      // breaker without ever reaching the dependency again.
      expect(outerCalls).toBe(2);
    });

    test('should handle error escalation and logging', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      app.get('/escalation-test', (req, res, next) => {
        const criticalError = new WrfcoinError('Critical system failure', {
          severity: 'critical',
          category: 'system',
        });
        next(criticalError);
      });

      app.use(createErrorHandler());

      await request(app).get('/escalation-test').expect(500);

      // Verify error was logged (simplified check)
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
