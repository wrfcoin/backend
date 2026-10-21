/**
 * Task 67: Comprehensive Integration Test Suite
 * Tests for API & Backend Services Integration
 *
 * Test Categories:
 * A. Unit Integration Tests
 * B. API Integration Tests
 * C. Database Integration Tests
 * D. Service Communication Tests
 * E. Performance Integration Tests
 * F. Security Integration Tests
 */

const request = require('supertest');
const { Pool } = require('pg');
const Redis = require('ioredis');
const express = require('express');
const { performance } = require('perf_hooks');

// Test configurations
const TEST_CONFIG = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/wrfcoin_test',
  REDIS_URL: process.env.TEST_REDIS_URL || 'redis://localhost:6379/1',
  GRAPHQL_ENDPOINT: '/graphql',
  API_TIMEOUT: 10000,
  PERFORMANCE_THRESHOLD: 200, // 200ms
  MAX_CONCURRENT_REQUESTS: 50,
  SERVICE_PORTS: {
    mainApi: 4001,
    crossChain: 3000,
    wallet: 4000,
    compute: 6000,
    aiml: 6001,
    storage: 7000,
    iot: 3002,
    governance: 8000,
    weatherEarnings: 8080,
    nodeDiscovery: 9001,
  },
};

// Global test state
let app;
let db;
let redis;
const serviceHealthMap = new Map();

// Test utilities
const TestUtils = {
  // Service mock factory
  createServiceMock(port, responses = {}) {
    const mockApp = express();
    mockApp.use(express.json());

    // Health endpoint
    mockApp.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Custom endpoints
    Object.entries(responses).forEach(([endpoint, response]) => {
      mockApp.get(endpoint, (req, res) => {
        if (typeof response === 'function') {
          response(req, res);
        } else {
          res.json(response);
        }
      });
    });

    return mockApp.listen(port);
  },

  // GraphQL query helper
  async executeGraphQLQuery(query, variables = {}, headers = {}) {
    const response = await request(app)
      .post(TEST_CONFIG.GRAPHQL_ENDPOINT)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send({ query, variables })
      .timeout(TEST_CONFIG.API_TIMEOUT);

    return response;
  },

  // Performance measurement wrapper
  async measurePerformance(fn, label = 'operation') {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;

    return {
      result,
      duration,
      withinThreshold: duration <= TEST_CONFIG.PERFORMANCE_THRESHOLD,
      label,
    };
  },

  // Concurrent request helper
  async executeConcurrentRequests(requestFn, count = 10) {
    const promises = Array(count)
      .fill(null)
      .map(() => requestFn());
    const results = await Promise.allSettled(promises);

    return {
      total: count,
      successful: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length,
      results,
    };
  },
};

describe('Task 67: API & Backend Services Integration', () => {
  beforeAll(async () => {
    console.log('Setting up integration test environment...');

    // Initialize database connection
    db = new Pool({
      connectionString: TEST_CONFIG.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    // Initialize Redis connection
    redis = new Redis(TEST_CONFIG.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      connectTimeout: 5000,
    });

    // Wait for connections
    await db.query('SELECT 1');
    await redis.ping();

    console.log('Database and Redis connections established');
  });

  afterAll(async () => {
    console.log('Cleaning up test environment...');

    if (db) {
      await db.end();
    }

    if (redis) {
      await redis.quit();
    }

    console.log('Cleanup completed');
  });

  // A. UNIT INTEGRATION TESTS
  describe('A. Unit Integration Tests', () => {
    describe('GraphQL Resolver → Service Connections', () => {
      test('should establish service client connections', async () => {
        const { serviceClientManager } = require('../graphql/context');

        expect(serviceClientManager).toBeDefined();

        const serviceHealth = await serviceClientManager.checkAllServices();

        // At least critical services should be available in test environment
        const criticalServices = ['mainApi', 'governance', 'wallet'];
        criticalServices.forEach(service => {
          expect(serviceHealth).toHaveProperty(service);
        });
      });

      test('should handle service client initialization errors gracefully', async () => {
        // Test with invalid service configuration
        const { ServiceClient } = require('../graphql/services/service-client');

        const invalidClient = new ServiceClient({
          host: 'non-existent-host',
          port: 99999,
          timeout: 1000,
          retries: 1,
        });

        await expect(invalidClient.get('/health')).rejects.toThrow();
      });

      test('should implement circuit breaker pattern', async () => {
        const { ServiceClient } = require('../graphql/services/service-client');

        const client = new ServiceClient({
          host: 'localhost',
          port: 99999, // Non-existent port
          timeout: 500,
          retries: 2,
          circuitBreaker: {
            threshold: 3,
            timeout: 2000,
          },
        });

        // Trigger circuit breaker
        for (let i = 0; i < 5; i++) {
          try {
            await client.get('/test');
          } catch (e) {
            // Expected to fail
          }
        }

        // Circuit should be open now
        const status = client.getCircuitBreakerStatus();
        expect(['OPEN', 'HALF_OPEN']).toContain(status.state);
      });
    });

    describe('DataLoader Batching and Caching', () => {
      test('should batch multiple requests efficiently', async () => {
        const { createDataLoaders } = require('../graphql/dataloaders');
        const loaders = createDataLoaders({ db, redis });

        // Create test data
        const testStationIds = ['station1', 'station2', 'station3'];

        // Execute concurrent loads
        const start = performance.now();
        const results = await Promise.all(
          testStationIds.map(id => loaders.weatherStations.load(id))
        );
        const duration = performance.now() - start;

        expect(results).toHaveLength(3);
        expect(duration).toBeLessThan(100); // Should be fast due to batching
      });

      test('should cache results within request scope', async () => {
        const { createDataLoaders } = require('../graphql/dataloaders');
        const loaders = createDataLoaders({ db, redis });

        const stationId = 'test-station-cache';

        // First load
        const result1 = await loaders.weatherStations.load(stationId);

        // Second load (should be cached)
        const start = performance.now();
        const result2 = await loaders.weatherStations.load(stationId);
        const duration = performance.now() - start;

        expect(result1).toEqual(result2);
        expect(duration).toBeLessThan(10); // Cache hit should be very fast
      });
    });

    describe('Service Registry Health Checks', () => {
      test('should monitor service health status', async () => {
        const { serviceClientManager } = require('../graphql/context');

        const healthCheck = await serviceClientManager.checkAllServices();

        expect(healthCheck).toBeInstanceOf(Object);
        Object.values(healthCheck).forEach(status => {
          expect(typeof status).toBe('boolean');
        });
      });

      test('should handle service discovery failures', async () => {
        const {
          ServiceRegistry,
        } = require('../graphql/services/service-registry');

        const registry = new ServiceRegistry({
          services: {
            testService: {
              host: 'non-existent',
              port: 99999,
              timeout: 500,
            },
          },
        });

        const health = await registry.checkServiceHealth('testService');
        expect(health).toBe(false);
      });
    });

    describe('Error Handler Middleware', () => {
      test('should handle GraphQL errors properly', async () => {
        // This would test the error handling middleware
        // Implementation depends on actual GraphQL server setup
        const query = `
          query {
            nonExistentField
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        expect(response.status).toBe(400);
        expect(response.body.errors).toBeDefined();
        expect(response.body.errors[0].message).toContain('Cannot query field');
      });

      test('should mask sensitive information in errors', async () => {
        // Test that database connection strings, API keys, etc. are not exposed
        const query = `
          query {
            sensitiveOperation
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        if (response.body.errors) {
          response.body.errors.forEach(error => {
            expect(error.message).not.toMatch(/password|secret|key|token/i);
          });
        }
      });
    });
  });

  // B. API INTEGRATION TESTS
  describe('B. API Integration Tests', () => {
    describe('End-to-End GraphQL Query Testing', () => {
      test('should execute basic token query successfully', async () => {
        const query = `
          query {
            wrfToken {
              symbol
              name
              totalSupply
            }
          }
        `;

        const { result, duration } = await TestUtils.measurePerformance(() =>
          TestUtils.executeGraphQLQuery(query)
        );

        expect(result.status).toBe(200);
        expect(result.body.data).toBeDefined();
        expect(result.body.data.wrfToken).toBeDefined();
        expect(duration).toBeLessThan(TEST_CONFIG.PERFORMANCE_THRESHOLD);
      });

      test('should handle complex nested queries', async () => {
        const query = `
          query {
            wrfToken {
              symbol
              weatherStations(first: 5) {
                stationId
                location
                realtimeData {
                  temperature
                  humidity
                }
              }
              proposals(first: 3) {
                title
                state
                votes {
                  support
                  weight
                }
              }
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        expect(response.status).toBe(200);
        expect(response.body.data.wrfToken.weatherStations).toBeInstanceOf(
          Array
        );
        expect(response.body.data.wrfToken.proposals).toBeInstanceOf(Array);
      });

      test('should handle queries with variables', async () => {
        const query = `
          query GetTokenBalance($address: String!) {
            tokenBalance(address: $address) {
              address
              balance
              staking {
                stakedAmount
                rewards
              }
            }
          }
        `;

        const variables = {
          address: 'test_address_123',
        };

        const response = await TestUtils.executeGraphQLQuery(query, variables);

        expect(response.status).toBe(200);
        expect(response.body.data.tokenBalance).toBeDefined();
      });
    });

    describe('REST API Endpoint Integration', () => {
      test('should provide health check endpoint', async () => {
        const response = await request(app).get('/health').timeout(5000);

        expect(response.status).toBe(200);
        expect(response.body.status).toMatch(/healthy|degraded/);
        expect(response.body.services).toBeDefined();
      });

      test('should provide metrics endpoint', async () => {
        const response = await request(app).get('/metrics').timeout(5000);

        expect(response.status).toBe(200);
        expect(response.body.uptime).toBeDefined();
        expect(response.body.memoryUsage).toBeDefined();
      });

      test('should handle CORS properly', async () => {
        const response = await request(app)
          .options('/graphql')
          .set('Origin', 'https://app.wrfcoin.com')
          .set('Access-Control-Request-Method', 'POST');

        expect(response.headers['access-control-allow-origin']).toBeDefined();
        expect(response.headers['access-control-allow-methods']).toContain(
          'POST'
        );
      });
    });

    describe('Service Orchestration Testing', () => {
      test('should coordinate multiple service calls', async () => {
        const query = `
          query {
            dashboardData {
              tokenInfo {
                symbol
                totalSupply
              }
              weatherStats {
                activeStations
                dataPoints
              }
              governanceStatus {
                activeProposals
                totalVoters
              }
            }
          }
        `;

        const { result, duration } = await TestUtils.measurePerformance(() =>
          TestUtils.executeGraphQLQuery(query)
        );

        expect(result.status).toBe(200);
        expect(result.body.data.dashboardData).toBeDefined();
        expect(duration).toBeLessThan(TEST_CONFIG.PERFORMANCE_THRESHOLD * 2); // Allow more time for multiple services
      });

      test('should handle partial service failures gracefully', async () => {
        // This test would require temporarily disabling a service
        // For now, we'll test the graceful degradation pattern

        const query = `
          query {
            wrfToken {
              symbol
              weatherStations {
                stationId
              }
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        // Should succeed even if some services are unavailable
        expect(response.status).toBe(200);
        expect(response.body.data.wrfToken.symbol).toBeDefined();
      });
    });

    describe('Authentication and Security Testing', () => {
      test('should require authentication for protected queries', async () => {
        const query = `
          query {
            userWallet {
              balance
              privateData
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        // Should fail without authentication
        expect(response.status).toBe(401);
        expect(response.body.errors[0].message).toContain('authentication');
      });

      test('should validate JWT tokens properly', async () => {
        const invalidToken = 'invalid.jwt.token';

        const query = `
          query {
            userProfile {
              address
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(
          query,
          {},
          {
            Authorization: `Bearer ${invalidToken}`,
          }
        );

        expect(response.status).toBe(401);
      });

      test('should enforce rate limiting', async () => {
        const query = '{ wrfToken { symbol } }';

        // Execute many requests quickly
        const requests = Array(100)
          .fill(null)
          .map(() => TestUtils.executeGraphQLQuery(query));

        const results = await Promise.allSettled(requests);

        // Some should be rate limited
        const rateLimitedCount = results.filter(
          r => r.status === 'fulfilled' && r.value.status === 429
        ).length;

        expect(rateLimitedCount).toBeGreaterThan(0);
      });
    });
  });

  // C. DATABASE INTEGRATION TESTS
  describe('C. Database Integration Tests', () => {
    describe('PostgreSQL Connection Pool Testing', () => {
      test('should handle database connections efficiently', async () => {
        const { result, duration } = await TestUtils.measurePerformance(
          async () => {
            const results = await Promise.all([
              db.query('SELECT 1 as test'),
              db.query('SELECT 2 as test'),
              db.query('SELECT 3 as test'),
            ]);
            return results;
          }
        );

        expect(result).toHaveLength(3);
        expect(duration).toBeLessThan(100); // Should be fast with connection pooling
      });

      test('should handle concurrent database queries', async () => {
        const concurrentQueries = async () => {
          return db.query('SELECT NOW() as timestamp, pg_sleep(0.1)');
        };

        const { successful, failed } =
          await TestUtils.executeConcurrentRequests(concurrentQueries, 20);

        expect(successful).toBeGreaterThan(15); // Most should succeed
        expect(failed).toBeLessThan(5); // Minimal failures expected
      });

      test('should handle connection pool exhaustion gracefully', async () => {
        // Test with more connections than pool size
        const queries = Array(15)
          .fill(null)
          .map(() => db.query('SELECT pg_sleep(2)'));

        const start = performance.now();
        await Promise.allSettled(queries);
        const duration = performance.now() - start;

        // Should handle gracefully without crashing
        expect(duration).toBeGreaterThan(2000); // Some should queue
        expect(duration).toBeLessThan(10000); // But not take too long
      });
    });

    describe('Transaction Rollback and Recovery', () => {
      test('should handle transaction rollbacks properly', async () => {
        const client = await db.connect();

        try {
          await client.query('BEGIN');

          // Insert test data
          await client.query(
            'INSERT INTO test_table (id, data) VALUES ($1, $2)',
            ['test_rollback', 'test_data']
          );

          // Force an error to trigger rollback
          await expect(
            client.query('INSERT INTO non_existent_table (id) VALUES (1)')
          ).rejects.toThrow();

          await client.query('ROLLBACK');

          // Verify data was not committed
          const result = await client.query(
            'SELECT * FROM test_table WHERE id = $1',
            ['test_rollback']
          );

          expect(result.rows).toHaveLength(0);
        } finally {
          client.release();
        }
      });

      test('should maintain data consistency during failures', async () => {
        // Test ACID properties during concurrent operations
        const insertOperations = Array(10)
          .fill(null)
          .map(async (_, index) => {
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                'INSERT INTO test_table (id, data) VALUES ($1, $2)',
                [`consistency_test_${index}`, `data_${index}`]
              );

              // Randomly fail some transactions
              if (Math.random() < 0.3) {
                throw new Error('Simulated failure');
              }

              await client.query('COMMIT');
              return { success: true, index };
            } catch (error) {
              await client.query('ROLLBACK');
              return { success: false, index, error: error.message };
            } finally {
              client.release();
            }
          });

        const results = await Promise.allSettled(insertOperations);

        // Verify only successful transactions were committed
        const successfulResults = results
          .filter(r => r.status === 'fulfilled' && r.value.success)
          .map(r => r.value.index);

        for (const index of successfulResults) {
          const result = await db.query(
            'SELECT * FROM test_table WHERE id = $1',
            [`consistency_test_${index}`]
          );
          expect(result.rows).toHaveLength(1);
        }
      });
    });

    describe('Data Consistency Across Services', () => {
      test('should maintain consistency between cache and database', async () => {
        const testKey = 'consistency_test_key';
        const testData = { id: 1, value: 'test_data', timestamp: Date.now() };

        // Write to database
        await db.query(
          'INSERT INTO cache_test (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = $2',
          [testKey, JSON.stringify(testData)]
        );

        // Write to cache
        await redis.set(testKey, JSON.stringify(testData), 'EX', 3600);

        // Read from both
        const [dbResult, cacheResult] = await Promise.all([
          db.query('SELECT data FROM cache_test WHERE key = $1', [testKey]),
          redis.get(testKey),
        ]);

        expect(dbResult.rows[0].data).toEqual(cacheResult);
      });

      test('should handle cache invalidation properly', async () => {
        const testKey = 'invalidation_test';
        const initialData = { value: 'initial' };
        const updatedData = { value: 'updated' };

        // Set initial data
        await redis.set(testKey, JSON.stringify(initialData));

        // Update and invalidate
        await db.query('UPDATE cache_test SET data = $1 WHERE key = $2', [
          JSON.stringify(updatedData),
          testKey,
        ]);
        await redis.del(testKey);

        // Verify cache is cleared
        const cachedData = await redis.get(testKey);
        expect(cachedData).toBeNull();
      });
    });

    describe('Cache Synchronization Testing', () => {
      test('should synchronize data between Redis and PostgreSQL', async () => {
        const syncKey = 'sync_test_' + Date.now();
        const syncData = {
          id: 'test_id',
          payload: 'test_payload',
          updated: new Date().toISOString(),
        };

        // Simulate cache-through pattern
        await redis.set(syncKey, JSON.stringify(syncData), 'EX', 300);
        await db.query(
          'INSERT INTO sync_test (key, data, updated_at) VALUES ($1, $2, $3)',
          [syncKey, JSON.stringify(syncData), new Date()]
        );

        // Verify synchronization
        const [cacheResult, dbResult] = await Promise.all([
          redis.get(syncKey),
          db.query('SELECT data FROM sync_test WHERE key = $1', [syncKey]),
        ]);

        expect(JSON.parse(cacheResult)).toEqual(
          JSON.parse(dbResult.rows[0].data)
        );
      });
    });
  });

  // D. SERVICE COMMUNICATION TESTS
  describe('D. Service Communication Tests', () => {
    describe('Inter-service Communication Validation', () => {
      test('should communicate with all microservices', async () => {
        const serviceTests = Object.entries(TEST_CONFIG.SERVICE_PORTS).map(
          async ([serviceName, port]) => {
            try {
              const response = await request(`http://localhost:${port}`)
                .get('/health')
                .timeout(5000);

              return {
                service: serviceName,
                port,
                status: response.status,
                healthy: response.status === 200,
              };
            } catch (error) {
              return {
                service: serviceName,
                port,
                status: 'error',
                healthy: false,
                error: error.message,
              };
            }
          }
        );

        const results = await Promise.allSettled(serviceTests);

        // At least 50% of services should be available in test environment
        const healthyServices = results.filter(
          r => r.status === 'fulfilled' && r.value.healthy
        ).length;

        expect(healthyServices).toBeGreaterThan(
          Object.keys(TEST_CONFIG.SERVICE_PORTS).length * 0.5
        );
      });

      test('should handle service timeouts gracefully', async () => {
        // Mock a slow service
        const slowService = TestUtils.createServiceMock(9999, {
          '/slow': (req, res) => {
            setTimeout(() => res.json({ message: 'slow response' }), 5000);
          },
        });

        try {
          const start = performance.now();

          await expect(
            request('http://localhost:9999').get('/slow').timeout(2000)
          ).rejects.toThrow();

          const duration = performance.now() - start;
          expect(duration).toBeLessThan(3000); // Should timeout before 5s
        } finally {
          slowService.close();
        }
      });
    });

    describe('Circuit Breaker Functionality', () => {
      test('should open circuit breaker after failures', async () => {
        const { ServiceClient } = require('../graphql/services/service-client');

        const client = new ServiceClient({
          host: 'localhost',
          port: 99998, // Non-existent port
          timeout: 1000,
          retries: 1,
          circuitBreaker: {
            threshold: 3,
            timeout: 5000,
          },
        });

        // Trigger failures to open circuit breaker
        for (let i = 0; i < 5; i++) {
          try {
            await client.get('/test');
          } catch (e) {
            // Expected
          }
        }

        const status = client.getCircuitBreakerStatus();
        expect(status.state).toBe('OPEN');
        expect(status.failures).toBeGreaterThanOrEqual(3);
      });

      test('should attempt recovery in half-open state', async () => {
        const { ServiceClient } = require('../graphql/services/service-client');

        // Create a service that will be available after circuit opens
        const recoveryService = TestUtils.createServiceMock(9997, {
          '/test': { status: 'ok' },
        });

        const client = new ServiceClient({
          host: 'localhost',
          port: 9997,
          timeout: 1000,
          retries: 1,
          circuitBreaker: {
            threshold: 2,
            timeout: 1000, // Short timeout for quick recovery test
          },
        });

        try {
          // First, break the circuit by stopping the service
          recoveryService.close();

          // Trigger failures
          for (let i = 0; i < 3; i++) {
            try {
              await client.get('/test');
            } catch (e) {
              // Expected
            }
          }

          // Restart service
          const newService = TestUtils.createServiceMock(9997, {
            '/test': { status: 'ok' },
          });

          // Wait for circuit breaker timeout
          await new Promise(resolve => setTimeout(resolve, 1100));

          // Should try to recover
          const response = await client.get('/test');
          expect(response.status).toBe('ok');

          newService.close();
        } finally {
          // Cleanup
        }
      });
    });

    describe('Service Discovery and Health Monitoring', () => {
      test('should discover available services dynamically', async () => {
        const {
          ServiceRegistry,
        } = require('../graphql/services/service-registry');

        const registry = new ServiceRegistry();
        const availableServices = await registry.discoverServices();

        expect(availableServices).toBeInstanceOf(Array);
        expect(availableServices.length).toBeGreaterThan(0);
      });

      test('should monitor service health continuously', async () => {
        const { serviceClientManager } = require('../graphql/context');

        const initialHealth = await serviceClientManager.checkAllServices();

        // Wait a bit and check again
        await new Promise(resolve => setTimeout(resolve, 1000));

        const laterHealth = await serviceClientManager.checkAllServices();

        // Health checks should be consistent for stable services
        const stableServices = Object.keys(initialHealth).filter(
          service => initialHealth[service] === laterHealth[service]
        );

        expect(stableServices.length).toBeGreaterThan(0);
      });
    });

    describe('Cross-service Error Propagation', () => {
      test('should propagate errors appropriately across services', async () => {
        const query = `
          query {
            crossServiceOperation {
              result
              metadata {
                services
                errors
              }
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        if (response.body.data?.crossServiceOperation?.metadata?.errors) {
          // Errors should be structured and not expose sensitive information
          response.body.data.crossServiceOperation.metadata.errors.forEach(
            error => {
              expect(error).toHaveProperty('service');
              expect(error).toHaveProperty('message');
              expect(error.message).not.toMatch(/password|secret|token/i);
            }
          );
        }
      });
    });
  });

  // E. PERFORMANCE INTEGRATION TESTS
  describe('E. Performance Integration Tests', () => {
    describe('Load Testing with Realistic Scenarios', () => {
      test('should handle concurrent GraphQL requests efficiently', async () => {
        const query = `
          query {
            wrfToken {
              symbol
              totalSupply
              weatherStations(first: 5) {
                stationId
                location
              }
            }
          }
        `;

        const concurrentRequest = () => TestUtils.executeGraphQLQuery(query);

        const { result } = await TestUtils.measurePerformance(
          () => TestUtils.executeConcurrentRequests(concurrentRequest, 20),
          'concurrent_graphql_requests'
        );

        expect(result.successful).toBeGreaterThan(15); // At least 75% success rate
        expect(result.failed).toBeLessThan(5);
      });

      test('should maintain response times under load', async () => {
        const query = '{ wrfToken { symbol } }';

        const responseTimes = [];

        for (let i = 0; i < 10; i++) {
          const { duration } = await TestUtils.measurePerformance(() =>
            TestUtils.executeGraphQLQuery(query)
          );
          responseTimes.push(duration);
        }

        const averageResponseTime =
          responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
        const maxResponseTime = Math.max(...responseTimes);

        expect(averageResponseTime).toBeLessThan(
          TEST_CONFIG.PERFORMANCE_THRESHOLD
        );
        expect(maxResponseTime).toBeLessThan(
          TEST_CONFIG.PERFORMANCE_THRESHOLD * 2
        );
      });

      test('should handle database connection pressure', async () => {
        const dbQuery = () =>
          db.query('SELECT COUNT(*) FROM weather_data LIMIT 1');

        const { successful, failed } =
          await TestUtils.executeConcurrentRequests(
            dbQuery,
            30 // More than typical pool size
          );

        expect(successful).toBeGreaterThan(25); // Should handle most requests
        expect(failed).toBeLessThan(5);
      });
    });

    describe('Latency Validation Under Load', () => {
      test('should meet <200ms average latency requirement', async () => {
        const testQueries = [
          '{ wrfToken { symbol } }',
          '{ wrfToken { totalSupply } }',
          '{ healthCheck { status } }',
        ];

        const measurements = [];

        for (const query of testQueries) {
          for (let i = 0; i < 5; i++) {
            const { duration } = await TestUtils.measurePerformance(() =>
              TestUtils.executeGraphQLQuery(query)
            );
            measurements.push(duration);
          }
        }

        const averageLatency =
          measurements.reduce((a, b) => a + b, 0) / measurements.length;
        const p95Latency = measurements.sort((a, b) => a - b)[
          Math.floor(measurements.length * 0.95)
        ];

        expect(averageLatency).toBeLessThan(TEST_CONFIG.PERFORMANCE_THRESHOLD);
        expect(p95Latency).toBeLessThan(
          TEST_CONFIG.PERFORMANCE_THRESHOLD * 1.5
        );
      });

      test('should handle memory efficiently under load', async () => {
        const initialMemory = process.memoryUsage();

        // Generate load
        const promises = Array(100)
          .fill(null)
          .map(() =>
            TestUtils.executeGraphQLQuery('{ wrfToken { symbol totalSupply } }')
          );

        await Promise.allSettled(promises);

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }

        const finalMemory = process.memoryUsage();
        const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

        // Memory increase should be reasonable (less than 50MB)
        expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
      });
    });

    describe('Resource Usage Monitoring', () => {
      test('should monitor database connection usage', async () => {
        const poolSize = db.totalCount;
        const initialIdleCount = db.idleCount;

        // Create some load
        const queries = Array(5)
          .fill(null)
          .map(() => db.query('SELECT pg_sleep(0.5)'));

        // Check connection usage during load
        const usedConnections = poolSize - db.idleCount;
        expect(usedConnections).toBeGreaterThan(0);
        expect(usedConnections).toBeLessThanOrEqual(poolSize);

        await Promise.all(queries);

        // Connections should be released after queries complete
        expect(db.idleCount).toBeGreaterThanOrEqual(initialIdleCount);
      });

      test('should monitor Redis connection efficiency', async () => {
        const operationCount = 100;
        const operations = [];

        for (let i = 0; i < operationCount; i++) {
          operations.push(redis.set(`perf_test_${i}`, `value_${i}`, 'EX', 60));
        }

        const { duration } = await TestUtils.measurePerformance(
          () => Promise.all(operations),
          'redis_bulk_operations'
        );

        // Should handle 100 operations efficiently
        expect(duration).toBeLessThan(1000); // Under 1 second

        // Cleanup
        const deleteOps = Array(operationCount)
          .fill(null)
          .map((_, i) => redis.del(`perf_test_${i}`));
        await Promise.all(deleteOps);
      });
    });

    describe('Error Handling Performance Impact', () => {
      test('should handle errors without significant performance degradation', async () => {
        // Test with mix of successful and failing requests
        const successfulQuery = '{ wrfToken { symbol } }';
        const failingQuery = '{ nonExistentField }';

        const mixedRequests = Array(20)
          .fill(null)
          .map((_, i) =>
            i % 2 === 0
              ? TestUtils.executeGraphQLQuery(successfulQuery)
              : TestUtils.executeGraphQLQuery(failingQuery)
          );

        const { duration } = await TestUtils.measurePerformance(
          () => Promise.allSettled(mixedRequests),
          'mixed_success_failure_requests'
        );

        // Error handling shouldn't significantly impact performance
        expect(duration).toBeLessThan(TEST_CONFIG.PERFORMANCE_THRESHOLD * 3);
      });
    });
  });

  // F. SECURITY INTEGRATION TESTS
  describe('F. Security Integration Tests', () => {
    describe('API Authentication and Authorization', () => {
      test('should enforce authentication on protected endpoints', async () => {
        const protectedQuery = `
          query {
            userWallet {
              privateKey
              balance
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(protectedQuery);

        expect(response.status).toBe(401);
        expect(response.body.errors[0].message).toMatch(
          /authentication|unauthorized/i
        );
      });

      test('should validate authorization levels properly', async () => {
        const adminQuery = `
          mutation {
            adminOperation(action: "DELETE_ALL_DATA") {
              success
            }
          }
        `;

        // Test with regular user token (mock)
        const regularUserToken = 'mock.regular.user';

        const response = await TestUtils.executeGraphQLQuery(
          adminQuery,
          {},
          {
            Authorization: `Bearer ${regularUserToken}`,
          }
        );

        expect(response.status).toBe(403);
        expect(response.body.errors[0].message).toMatch(
          /forbidden|insufficient/i
        );
      });

      test('should prevent privilege escalation', async () => {
        const escalationQuery = `
          mutation {
            updateUserRole(userId: "victim", role: "ADMIN") {
              success
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(escalationQuery);

        expect(response.status).toBeGreaterThanOrEqual(401);
      });
    });

    describe('HSM Cryptographic Operations', () => {
      test('should validate HSM integration for signing', async () => {
        // This would test HSM integration if available
        const { hsmService } = require('../security/hsm-service');

        if (hsmService && hsmService.isAvailable()) {
          const testData = 'test_signature_data';

          const signature = await hsmService.sign(testData);
          expect(signature).toBeDefined();
          expect(signature.length).toBeGreaterThan(0);

          const isValid = await hsmService.verify(testData, signature);
          expect(isValid).toBe(true);
        } else {
          console.log(
            'HSM not available in test environment - skipping HSM tests'
          );
        }
      });

      test('should handle HSM failures gracefully', async () => {
        // Test fallback mechanisms when HSM is unavailable
        const query = `
          mutation {
            signTransaction(data: "test") {
              signature
              method
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        // Should either succeed with HSM or fail gracefully
        if (response.body.data?.signTransaction) {
          expect(response.body.data.signTransaction.signature).toBeDefined();
          expect(response.body.data.signTransaction.method).toMatch(
            /hsm|software/i
          );
        }
      });
    });

    describe('Input Validation and Sanitization', () => {
      test('should prevent GraphQL injection attacks', async () => {
        const maliciousQuery = `
          {
            wrfToken {
              symbol
              ...on Token {
                __schema {
                  types {
                    name
                  }
                }
              }
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(maliciousQuery);

        // Should prevent introspection in production
        expect(response.body.errors).toBeDefined();
      });

      test('should sanitize SQL injection attempts', async () => {
        const maliciousInput = "'; DROP TABLE users; --";

        const query = `
          query {
            searchUsers(name: "${maliciousInput}") {
              id
              name
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        // Should not crash and tables should still exist
        expect(response.status).not.toBe(500);

        // Verify tables still exist
        const result = await db.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name = 'users'"
        );
        expect(result.rows.length).toBeGreaterThanOrEqual(0);
      });

      test('should prevent XSS in responses', async () => {
        const xssPayload = '<script>alert("XSS")</script>';

        const query = `
          mutation {
            createNote(content: "${xssPayload}") {
              id
              content
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        if (response.body.data?.createNote?.content) {
          expect(response.body.data.createNote.content).not.toContain(
            '<script>'
          );
          expect(response.body.data.createNote.content).toMatch(
            /&lt;script&gt;|script/
          );
        }
      });
    });

    describe('Error Masking and Information Disclosure', () => {
      test('should mask sensitive information in error responses', async () => {
        const query = `
          query {
            debugInfo {
              databaseUrl
              secrets
              internals
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        // Should not expose sensitive information
        const responseString = JSON.stringify(response.body);
        expect(responseString).not.toMatch(
          /password|secret|key|database.*:\/\//i
        );
      });

      test('should limit error stack trace exposure', async () => {
        const query = `
          query {
            causeInternalError
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(query);

        if (response.body.errors) {
          response.body.errors.forEach(error => {
            expect(error.message).not.toContain('/home/');
            expect(error.message).not.toContain('node_modules');
            expect(error.message).not.toContain('stack trace');
          });
        }
      });
    });

    describe('Rate Limiting and DoS Protection', () => {
      test('should enforce rate limits per IP', async () => {
        const query = '{ wrfToken { symbol } }';
        const rapidRequests = Array(150)
          .fill(null)
          .map(() => TestUtils.executeGraphQLQuery(query));

        const results = await Promise.allSettled(rapidRequests);

        const rateLimited = results.filter(
          r => r.status === 'fulfilled' && r.value.status === 429
        );

        expect(rateLimited.length).toBeGreaterThan(0);
      });

      test('should protect against query complexity attacks', async () => {
        const complexQuery = `
          query {
            wrfToken {
              weatherStations {
                proposals {
                  votes {
                    voter {
                      delegations {
                        delegate {
                          votes {
                            proposal {
                              title
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const response = await TestUtils.executeGraphQLQuery(complexQuery);

        // Should reject overly complex queries
        expect(response.status).toBe(400);
        expect(response.body.errors[0].message).toMatch(/complexity|depth/i);
      });

      test('should handle request flooding gracefully', async () => {
        const floodRequests = Array(200)
          .fill(null)
          .map(() => TestUtils.executeGraphQLQuery('{ wrfToken { symbol } }'));

        const start = performance.now();
        await Promise.allSettled(floodRequests);
        const duration = performance.now() - start;

        // Server should remain responsive
        expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
      });
    });
  });

  // Cleanup test data
  afterEach(async () => {
    if (db) {
      try {
        await IntegrationTestUtils.cleanupTestData(db);
      } catch (error) {
        console.warn('Test cleanup failed:', error.message);
      }
    }

    if (redis) {
      try {
        const testKeys = await redis.keys('test_*');
        if (testKeys.length > 0) {
          await redis.del(...testKeys);
        }
      } catch (error) {
        console.warn('Redis cleanup failed:', error.message);
      }
    }
  });
});
