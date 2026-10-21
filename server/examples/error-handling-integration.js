/**
 * Error Handling Integration Example - Task 67.3
 *
 * Comprehensive example showing how to integrate the error handling system
 * across different parts of the WRFCoin platform.
 */

const express = require('express');
const {
  setupErrorHandling,
  createErrorHandler,
  serviceRegistry,
  WrfcoinError,
  ValidationError,
  AuthenticationError,
  DatabaseError,
  CrossChainError,
  IoTError,
} = require('../middleware/error-handler');
const {
  ErrorCoordinationService,
} = require('../services/error-coordination-service');
const { setupGraphQLServer } = require('../graphql');

/**
 * Example 1: Basic Express API with Error Handling
 */
function createBasicAPIExample() {
  const app = express();

  // Add error handling setup
  app.use(express.json());
  app.use(setupErrorHandling());

  // Example route with validation
  app.post('/api/users', (req, res, next) => {
    try {
      const { email, password } = req.body;

      if (!email || !email.includes('@')) {
        req.throwValidationError('Invalid email format', [
          { field: 'email', message: 'Email must be a valid email address' },
        ]);
      }

      if (!password || password.length < 8) {
        req.throwValidationError('Invalid password', [
          {
            field: 'password',
            message: 'Password must be at least 8 characters',
          },
        ]);
      }

      // Simulate user creation
      res.json({
        id: '123',
        email,
        message: 'User created successfully',
        correlationId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  });

  // Example route with authentication
  app.get('/api/profile', (req, res, next) => {
    try {
      const authHeader = req.get('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.throwAuthError('Missing or invalid authorization header', {
          authMethod: 'bearer-token',
        });
      }

      // Simulate profile data
      res.json({
        id: '123',
        email: 'user@example.com',
        correlationId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  });

  // Add error handler
  app.use(
    createErrorHandler({
      enableSecurityMasking: true,
      enableStackTrace: process.env.NODE_ENV !== 'production',
    })
  );

  return app;
}

/**
 * Example 2: Cross-Chain Bridge Integration
 */
async function demonstrateCrossChainErrorHandling() {
  console.log('=== Cross-Chain Bridge Error Handling Example ===');

  try {
    // Simulate a bridge operation with error handling
    const result = await ErrorCoordinationService.executeCoordinatedOperation(
      'cross-chain',
      'token-transfer',
      async () => {
        // Simulate bridge operation that might fail
        const random = Math.random();
        if (random < 0.3) {
          throw new Error('Bridge network congestion');
        }
        if (random < 0.5) {
          throw new Error('Insufficient gas fees');
        }

        return {
          transactionHash: '0x1234567890abcdef',
          amount: '100.5',
          status: 'completed',
        };
      },
      {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        amount: '100.5',
        correlationId: 'bridge-demo-001',
        fallback: async () => {
          console.log('Using fallback bridge service...');
          return {
            transactionHash: '0xfallback123',
            amount: '100.5',
            status: 'completed_via_fallback',
          };
        },
        onSystematicFailure: async (serviceName, stats) => {
          console.log(
            `Bridge service ${serviceName} showing systematic issues:`,
            stats
          );
          // Could trigger bridge maintenance mode
        },
      }
    );

    console.log('Bridge operation successful:', result);
  } catch (error) {
    console.error('Bridge operation failed:', {
      name: error.name,
      message: error.message,
      code: error.code,
      sourceChain: error.sourceChain,
      targetChain: error.targetChain,
      correlationId: error.correlationId,
    });
  }
}

/**
 * Example 3: IoT Sensor Data Collection with Error Handling
 */
async function demonstrateIoTErrorHandling() {
  console.log('\n=== IoT Sensor Error Handling Example ===');

  const sensorDevices = [
    { id: 'sensor-001', type: 'temperature', platform: 'iotex-w3bstream' },
    { id: 'sensor-002', type: 'humidity', platform: 'sensor-community' },
    { id: 'sensor-003', type: 'air-quality', platform: 'tataucloud' },
  ];

  for (const device of sensorDevices) {
    try {
      const result = await ErrorCoordinationService.executeCoordinatedOperation(
        'iot',
        'read-sensor',
        async () => {
          // Simulate sensor reading that might fail
          const random = Math.random();
          if (random < 0.2) {
            throw new Error('Sensor communication timeout');
          }
          if (random < 0.4) {
            throw new Error('Invalid sensor data received');
          }

          return {
            deviceId: device.id,
            readings: {
              value: Math.random() * 100,
              unit:
                device.type === 'temperature'
                  ? '°C'
                  : device.type === 'humidity'
                    ? '%'
                    : 'AQI',
              timestamp: new Date().toISOString(),
              quality: 'high',
            },
          };
        },
        {
          deviceId: device.id,
          sensorType: device.type,
          platform: device.platform,
          quality: 'high',
          location: { latitude: 40.7128, longitude: -74.006 },
          correlationId: `iot-demo-${device.id}`,
          fallback: async () => {
            console.log(`Using cached data for sensor ${device.id}...`);
            return {
              deviceId: device.id,
              readings: {
                value: 0,
                unit: 'cached',
                timestamp: new Date().toISOString(),
                quality: 'low',
              },
            };
          },
          onUnreliableSensor: async (deviceId, stats) => {
            console.log(`Sensor ${deviceId} is unreliable:`, stats);
            // Could trigger sensor maintenance alert
          },
        }
      );

      console.log(`Sensor ${device.id} reading:`, result.readings);
    } catch (error) {
      console.error(`Sensor ${device.id} failed:`, {
        name: error.name,
        message: error.message,
        deviceId: error.deviceId,
        sensorType: error.sensorType,
        correlationId: error.correlationId,
      });
    }
  }
}

/**
 * Example 4: Database Operations with Error Handling
 */
async function demonstrateDatabaseErrorHandling() {
  console.log('\n=== Database Error Handling Example ===');

  try {
    const result = await ErrorCoordinationService.executeCoordinatedOperation(
      'database',
      'user-query',
      async () => {
        // Simulate database query that might fail
        const random = Math.random();
        if (random < 0.3) {
          const error = new Error('Connection timeout');
          error.code = 'ETIMEDOUT';
          throw error;
        }
        if (random < 0.5) {
          const error = new Error('Deadlock detected');
          error.code = 'ER_LOCK_DEADLOCK';
          throw error;
        }

        return {
          users: [
            { id: 1, email: 'user1@example.com' },
            { id: 2, email: 'user2@example.com' },
          ],
          total: 2,
        };
      },
      {
        table: 'users',
        query: 'SELECT * FROM users WHERE active = ?',
        correlationId: 'db-demo-001',
        onDatabaseUnhealthy: async healthCheck => {
          console.log('Database showing high failure rate:', healthCheck);
          // Could trigger database scaling or failover
        },
        onDeadlock: async error => {
          console.log(
            'Database deadlock detected, considering query optimization'
          );
        },
      }
    );

    console.log('Database query successful:', result);
  } catch (error) {
    console.error('Database operation failed:', {
      name: error.name,
      message: error.message,
      table: error.table,
      query: error.query,
      correlationId: error.correlationId,
    });
  }
}

/**
 * Example 5: Circuit Breaker Pattern Demonstration
 */
async function demonstrateCircuitBreakerPattern() {
  console.log('\n=== Circuit Breaker Pattern Example ===');

  // Register a service that will fail frequently
  serviceRegistry.registerService('unreliable-service', {
    failureThreshold: 2,
    recoveryTimeout: 5000,
  });

  const unreliableOperation = async () => {
    // This operation fails 70% of the time
    if (Math.random() < 0.7) {
      throw new Error('Service unavailable');
    }
    return 'Service response';
  };

  const fallbackOperation = async () => {
    return 'Fallback response';
  };

  // Try calling the service multiple times to demonstrate circuit breaker
  for (let i = 1; i <= 10; i++) {
    try {
      console.log(`\nAttempt ${i}:`);

      const result = await serviceRegistry.executeServiceCall(
        'unreliable-service',
        unreliableOperation,
        fallbackOperation,
        { correlationId: `circuit-demo-${i}` }
      );

      console.log(`Success: ${result}`);

      const stats = serviceRegistry.getServiceStats('unreliable-service');
      console.log(
        `Service stats: ${stats.successCalls}/${stats.totalCalls} success rate: ${(stats.successRate * 100).toFixed(1)}%`
      );
      console.log(`Circuit breaker state: ${stats.circuitBreaker.state}`);
    } catch (error) {
      console.log(`Failed: ${error.message}`);

      const stats = serviceRegistry.getServiceStats('unreliable-service');
      console.log(`Circuit breaker state: ${stats.circuitBreaker.state}`);
    }

    // Small delay between attempts
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Example 6: Complete GraphQL Integration
 */
async function demonstrateGraphQLErrorHandling() {
  console.log('\n=== GraphQL Error Handling Example ===');

  const app = express();
  app.use(express.json());
  app.use(setupErrorHandling());

  // Setup GraphQL with enhanced error handling
  setupGraphQLServer(app);

  // Example GraphQL query that might fail
  const exampleQuery = `
    query GetUser($id: ID!) {
      user(id: $id) {
        id
        email
        profile {
          name
          avatar
        }
      }
    }
  `;

  console.log('GraphQL server setup with enhanced error handling');
  console.log('Example query:', exampleQuery);

  // In a real scenario, you would make actual GraphQL requests
  // This is just showing the setup
}

/**
 * Example 7: System Health Monitoring
 */
async function demonstrateSystemHealthMonitoring() {
  console.log('\n=== System Health Monitoring Example ===');

  // Simulate some service activity
  await demonstrateCrossChainErrorHandling();
  await demonstrateIoTErrorHandling();
  await demonstrateDatabaseErrorHandling();

  // Get comprehensive system health
  const health = await ErrorCoordinationService.getSystemHealth();

  console.log('\nSystem Health Report:');
  console.log('Timestamp:', health.timestamp);
  console.log('Total Services:', Object.keys(health.services).length);

  console.log('\nService Health:');
  Object.entries(health.services).forEach(([serviceName, stats]) => {
    if (stats) {
      console.log(
        `  ${serviceName}: ${stats.successCalls}/${stats.totalCalls} (${(stats.successRate * 100).toFixed(1)}% success)`
      );
    }
  });

  console.log('\nCross-Chain Health:');
  console.log(`  Active Bridges: ${health.crossChain.activeBridges}`);

  console.log('\nIoT Health:');
  console.log(`  Total Sensors: ${health.iot.totalSensors}`);

  console.log('\nDatabase Health:');
  console.log(
    `  Failure Rate: ${(health.database.failureRate * 100).toFixed(1)}%`
  );
  console.log(`  Active Connections: ${health.database.activeConnections}`);

  console.log('\nCache Health:');
  console.log(`  Hit Rate: ${(health.cache.hitRate * 100).toFixed(1)}%`);
  console.log(`  Error Rate: ${(health.cache.errorRate * 100).toFixed(1)}%`);
}

/**
 * Example 8: Custom Error Handling
 */
function demonstrateCustomErrorCreation() {
  console.log('\n=== Custom Error Creation Examples ===');

  // Business rule violation
  const businessError = new WrfcoinError(
    'Insufficient balance for transaction',
    {
      code: 'INSUFFICIENT_BALANCE',
      category: 'business',
      severity: 'medium',
      context: {
        requestedAmount: '1000.50',
        availableBalance: '500.25',
        currency: 'WRFC',
      },
      businessRule: 'balance-validation',
      entityType: 'wallet',
      entityId: 'wallet-123',
    }
  );

  console.log('Business Error:', businessError.toJSON());

  // HSM operation error
  const hsmError = new WrfcoinError('HSM key operation failed', {
    code: 'HSM_KEY_ERROR',
    category: 'security',
    severity: 'critical',
    hsmOperation: 'sign-transaction',
    keyId: 'key-456',
    slotId: 'slot-1',
  });

  console.log('HSM Error:', hsmError.toJSON());

  // Cross-chain bridge error
  const bridgeError = new CrossChainError('Bridge liquidity insufficient', {
    sourceChain: 'ethereum',
    targetChain: 'polygon',
    bridgeType: 'liquidity-pool',
    amount: '10000.0',
    context: {
      availableLiquidity: '5000.0',
      minimumRequired: '10000.0',
    },
  });

  console.log('Bridge Error:', bridgeError.toJSON());
}

/**
 * Main demonstration function
 */
async function runErrorHandlingDemo() {
  console.log('WRFCoin Error Handling System Integration Demo');
  console.log('='.repeat(50));

  try {
    // Create basic API example
    const app = createBasicAPIExample();
    console.log('Basic API with error handling created (not started)');

    // Demonstrate custom error creation
    demonstrateCustomErrorCreation();

    // Run service coordination examples
    await demonstrateCrossChainErrorHandling();
    await demonstrateIoTErrorHandling();
    await demonstrateDatabaseErrorHandling();

    // Demonstrate circuit breaker
    await demonstrateCircuitBreakerPattern();

    // Setup GraphQL
    await demonstrateGraphQLErrorHandling();

    // Show system health
    await demonstrateSystemHealthMonitoring();

    console.log('\n=== Demo Complete ===');
    console.log('All error handling components demonstrated successfully!');
  } catch (error) {
    console.error('Demo failed:', error);
  }
}

// Export for use in other modules
module.exports = {
  createBasicAPIExample,
  demonstrateCrossChainErrorHandling,
  demonstrateIoTErrorHandling,
  demonstrateDatabaseErrorHandling,
  demonstrateCircuitBreakerPattern,
  demonstrateGraphQLErrorHandling,
  demonstrateSystemHealthMonitoring,
  demonstrateCustomErrorCreation,
  runErrorHandlingDemo,
};

// Run demo if this file is executed directly
if (require.main === module) {
  runErrorHandlingDemo().catch(console.error);
}
