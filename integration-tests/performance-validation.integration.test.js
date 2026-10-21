/**
 * Performance Validation Integration Tests
 * Tests for Task 67: Performance benchmarking and validation
 *
 * Focus Areas:
 * - Response time validation (<200ms requirement)
 * - Throughput testing
 * - Resource usage monitoring
 * - Concurrent request handling
 * - Memory efficiency
 * - Database performance
 */

const request = require('supertest');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { performance } = require('perf_hooks');
const { EventEmitter } = require('events');

describe('Performance Validation Integration', () => {
  const PERFORMANCE_TARGETS = {
    AVERAGE_RESPONSE_TIME: 200, // ms
    P95_RESPONSE_TIME: 500, // ms
    P99_RESPONSE_TIME: 1000, // ms
    MIN_THROUGHPUT: 100, // requests per second
    MAX_MEMORY_INCREASE: 50 * 1024 * 1024, // 50MB
    MAX_CPU_USAGE: 80, // percentage
    DB_CONNECTION_TIMEOUT: 5000, // ms
    CACHE_HIT_RATIO: 0.8, // 80%
  };

  let app;
  let db;
  let redis;
  const performanceMetrics = new EventEmitter();

  beforeAll(async () => {
    console.log('Setting up performance validation tests...');

    // Initialize database connection with performance monitoring
    db = new Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ||
        'postgresql://localhost:5432/wrfcoin_test',
      max: 20,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    // Initialize Redis with performance monitoring
    redis = new Redis(
      process.env.TEST_REDIS_URL || 'redis://localhost:6379/1',
      {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        connectTimeout: 5000,
        lazyConnect: true,
      }
    );

    await redis.connect();
    await db.query('SELECT 1');

    console.log('Performance test environment ready');
  });

  afterAll(async () => {
    if (db) {
      await db.end();
    }
    if (redis) {
      await redis.quit();
    }
    console.log('Performance test cleanup completed');
  });

  describe('Response Time Validation', () => {
    test('should meet <200ms average response time requirement', async () => {
      const testEndpoints = [
        { method: 'GET', path: '/health' },
        {
          method: 'POST',
          path: '/graphql',
          body: { query: '{ wrfToken { symbol } }' },
        },
        { method: 'GET', path: '/metrics' },
      ];

      const responseTimes = [];

      for (const endpoint of testEndpoints) {
        for (let i = 0; i < 20; i++) {
          const start = performance.now();

          let requestPromise;
          if (endpoint.method === 'GET') {
            requestPromise = request(app).get(endpoint.path);
          } else if (endpoint.method === 'POST') {
            requestPromise = request(app)
              .post(endpoint.path)
              .send(endpoint.body)
              .set('Content-Type', 'application/json');
          }

          const response = await requestPromise;
          const duration = performance.now() - start;

          responseTimes.push({
            endpoint: `${endpoint.method} ${endpoint.path}`,
            duration,
            status: response.status,
          });
        }
      }

      // Calculate statistics
      const durations = responseTimes.map(rt => rt.duration);
      const averageResponseTime =
        durations.reduce((a, b) => a + b, 0) / durations.length;
      const p95ResponseTime = durations.sort((a, b) => a - b)[
        Math.floor(durations.length * 0.95)
      ];
      const p99ResponseTime = durations.sort((a, b) => a - b)[
        Math.floor(durations.length * 0.99)
      ];

      console.log(`Performance Metrics:
        Average: ${averageResponseTime.toFixed(2)}ms
        P95: ${p95ResponseTime.toFixed(2)}ms
        P99: ${p99ResponseTime.toFixed(2)}ms
      `);

      expect(averageResponseTime).toBeLessThan(
        PERFORMANCE_TARGETS.AVERAGE_RESPONSE_TIME
      );
      expect(p95ResponseTime).toBeLessThan(
        PERFORMANCE_TARGETS.P95_RESPONSE_TIME
      );
      expect(p99ResponseTime).toBeLessThan(
        PERFORMANCE_TARGETS.P99_RESPONSE_TIME
      );

      // Verify all requests succeeded
      const successfulRequests = responseTimes.filter(
        rt => rt.status < 400
      ).length;
      expect(successfulRequests / responseTimes.length).toBeGreaterThan(0.95);
    });

    test('should maintain response times under concurrent load', async () => {
      const concurrentUsers = 50;
      const requestsPerUser = 10;

      const query = '{ wrfToken { symbol totalSupply } }';

      const userRequests = Array(concurrentUsers)
        .fill(null)
        .map(async () => {
          const userResponseTimes = [];

          for (let i = 0; i < requestsPerUser; i++) {
            const start = performance.now();

            await request(app)
              .post('/graphql')
              .send({ query })
              .set('Content-Type', 'application/json');

            const duration = performance.now() - start;
            userResponseTimes.push(duration);
          }

          return userResponseTimes;
        });

      const allResponseTimes = (await Promise.all(userRequests)).flat();
      const averageResponseTime =
        allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length;
      const maxResponseTime = Math.max(...allResponseTimes);

      console.log(`Concurrent Load Metrics:
        Total Requests: ${allResponseTimes.length}
        Average Response Time: ${averageResponseTime.toFixed(2)}ms
        Max Response Time: ${maxResponseTime.toFixed(2)}ms
      `);

      expect(averageResponseTime).toBeLessThan(
        PERFORMANCE_TARGETS.AVERAGE_RESPONSE_TIME * 2
      );
      expect(maxResponseTime).toBeLessThan(
        PERFORMANCE_TARGETS.P99_RESPONSE_TIME
      );
    });

    test('should handle burst traffic efficiently', async () => {
      const burstSize = 100;
      const query = '{ wrfToken { symbol } }';

      // Create burst of requests
      const burstRequests = Array(burstSize)
        .fill(null)
        .map(() => {
          const start = performance.now();
          return request(app)
            .post('/graphql')
            .send({ query })
            .set('Content-Type', 'application/json')
            .then(response => ({
              duration: performance.now() - start,
              status: response.status,
            }));
        });

      const burstStart = performance.now();
      const results = await Promise.all(burstRequests);
      const totalBurstTime = performance.now() - burstStart;

      const throughput = burstSize / (totalBurstTime / 1000); // requests per second
      const averageResponseTime =
        results.reduce((sum, r) => sum + r.duration, 0) / results.length;
      const successfulRequests = results.filter(r => r.status < 400).length;

      console.log(`Burst Traffic Metrics:
        Throughput: ${throughput.toFixed(2)} req/s
        Average Response Time: ${averageResponseTime.toFixed(2)}ms
        Success Rate: ${((successfulRequests / burstSize) * 100).toFixed(2)}%
      `);

      expect(throughput).toBeGreaterThan(PERFORMANCE_TARGETS.MIN_THROUGHPUT);
      expect(averageResponseTime).toBeLessThan(
        PERFORMANCE_TARGETS.AVERAGE_RESPONSE_TIME * 1.5
      );
      expect(successfulRequests / burstSize).toBeGreaterThan(0.9);
    });
  });

  describe('Database Performance', () => {
    test('should handle concurrent database queries efficiently', async () => {
      const concurrentQueries = 30;
      const testQuery = 'SELECT COUNT(*) as count FROM weather_data LIMIT 1';

      const queryExecutions = Array(concurrentQueries)
        .fill(null)
        .map(async () => {
          const start = performance.now();
          const result = await db.query(testQuery);
          const duration = performance.now() - start;

          return {
            duration,
            rowCount: result.rowCount,
            success: true,
          };
        });

      const queryStart = performance.now();
      const results = await Promise.allSettled(queryExecutions);
      const totalTime = performance.now() - queryStart;

      const successfulQueries = results.filter(
        r => r.status === 'fulfilled'
      ).length;
      const averageQueryTime =
        results
          .filter(r => r.status === 'fulfilled')
          .reduce((sum, r) => sum + r.value.duration, 0) / successfulQueries;

      console.log(`Database Concurrent Query Metrics:
        Successful Queries: ${successfulQueries}/${concurrentQueries}
        Average Query Time: ${averageQueryTime.toFixed(2)}ms
        Total Execution Time: ${totalTime.toFixed(2)}ms
      `);

      expect(successfulQueries).toBeGreaterThan(concurrentQueries * 0.9);
      expect(averageQueryTime).toBeLessThan(100); // Database queries should be fast
    });

    test('should maintain connection pool efficiency', async () => {
      const initialConnections = {
        total: db.totalCount,
        idle: db.idleCount,
        waiting: db.waitingCount,
      };

      // Create sustained load
      const sustainedQueries = Array(50)
        .fill(null)
        .map(async (_, index) => {
          await new Promise(resolve => setTimeout(resolve, index * 10)); // Stagger requests

          const start = performance.now();
          await db.query('SELECT pg_sleep(0.1)'); // 100ms query
          const duration = performance.now() - start;

          return {
            duration,
            connectionState: {
              total: db.totalCount,
              idle: db.idleCount,
              waiting: db.waitingCount,
            },
          };
        });

      const results = await Promise.all(sustainedQueries);

      const finalConnections = {
        total: db.totalCount,
        idle: db.idleCount,
        waiting: db.waitingCount,
      };

      const averageQueryTime =
        results.reduce((sum, r) => sum + r.duration, 0) / results.length;
      const maxWaitingConnections = Math.max(
        ...results.map(r => r.connectionState.waiting)
      );

      console.log(`Connection Pool Metrics:
        Initial Connections: ${JSON.stringify(initialConnections)}
        Final Connections: ${JSON.stringify(finalConnections)}
        Average Query Time: ${averageQueryTime.toFixed(2)}ms
        Max Waiting Connections: ${maxWaitingConnections}
      `);

      expect(averageQueryTime).toBeLessThan(200); // Should handle connection pooling well
      expect(maxWaitingConnections).toBeLessThan(10); // Shouldn't have too many waiting
    });

    test('should handle database transaction performance', async () => {
      const transactionCount = 20;
      const operationsPerTransaction = 5;

      const transactionTimes = [];

      for (let i = 0; i < transactionCount; i++) {
        const client = await db.connect();
        const start = performance.now();

        try {
          await client.query('BEGIN');

          for (let j = 0; j < operationsPerTransaction; j++) {
            await client.query(
              'INSERT INTO test_performance (id, data, timestamp) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2, timestamp = $3',
              [`perf_test_${i}_${j}`, `data_${j}`, new Date()]
            );
          }

          await client.query('COMMIT');

          const duration = performance.now() - start;
          transactionTimes.push(duration);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }

      const averageTransactionTime =
        transactionTimes.reduce((a, b) => a + b, 0) / transactionTimes.length;
      const maxTransactionTime = Math.max(...transactionTimes);

      console.log(`Transaction Performance Metrics:
        Average Transaction Time: ${averageTransactionTime.toFixed(2)}ms
        Max Transaction Time: ${maxTransactionTime.toFixed(2)}ms
        Operations per Transaction: ${operationsPerTransaction}
      `);

      expect(averageTransactionTime).toBeLessThan(50); // Transactions should be fast
      expect(maxTransactionTime).toBeLessThan(200);
    });
  });

  describe('Cache Performance', () => {
    test('should maintain high cache hit ratio', async () => {
      const cacheKeys = Array(100)
        .fill(null)
        .map((_, i) => `cache_perf_test_${i}`);
      const testData = { value: 'cached_data', timestamp: Date.now() };

      // Populate cache
      const setOperations = cacheKeys.map(key =>
        redis.set(key, JSON.stringify(testData), 'EX', 300)
      );
      await Promise.all(setOperations);

      // Perform mixed read operations (some cached, some not)
      const readOperations = [];
      let cacheHits = 0;
      let cacheMisses = 0;

      for (let i = 0; i < 200; i++) {
        const key =
          i < 150 ? cacheKeys[i % cacheKeys.length] : `non_existent_${i}`;

        const start = performance.now();
        const result = await redis.get(key);
        const duration = performance.now() - start;

        if (result !== null) {
          cacheHits++;
        } else {
          cacheMisses++;
        }

        readOperations.push({
          key,
          duration,
          hit: result !== null,
        });
      }

      const hitRatio = cacheHits / (cacheHits + cacheMisses);
      const averageReadTime =
        readOperations.reduce((sum, op) => sum + op.duration, 0) /
        readOperations.length;
      const averageHitTime =
        readOperations
          .filter(op => op.hit)
          .reduce((sum, op) => sum + op.duration, 0) / cacheHits;

      console.log(`Cache Performance Metrics:
        Hit Ratio: ${(hitRatio * 100).toFixed(2)}%
        Average Read Time: ${averageReadTime.toFixed(2)}ms
        Average Hit Time: ${averageHitTime.toFixed(2)}ms
        Cache Hits: ${cacheHits}
        Cache Misses: ${cacheMisses}
      `);

      expect(hitRatio).toBeGreaterThan(PERFORMANCE_TARGETS.CACHE_HIT_RATIO);
      expect(averageHitTime).toBeLessThan(5); // Cache hits should be very fast
    });

    test('should handle cache operations under load', async () => {
      const concurrentOperations = 100;
      const operationsPerWorker = 10;

      const cacheOperations = Array(concurrentOperations)
        .fill(null)
        .map(async (_, workerIndex) => {
          const workerMetrics = {
            sets: [],
            gets: [],
            deletes: [],
          };

          for (let i = 0; i < operationsPerWorker; i++) {
            const key = `load_test_${workerIndex}_${i}`;
            const value = JSON.stringify({
              worker: workerIndex,
              operation: i,
              timestamp: Date.now(),
            });

            // SET operation
            let start = performance.now();
            await redis.set(key, value, 'EX', 60);
            workerMetrics.sets.push(performance.now() - start);

            // GET operation
            start = performance.now();
            await redis.get(key);
            workerMetrics.gets.push(performance.now() - start);

            // DELETE operation
            start = performance.now();
            await redis.del(key);
            workerMetrics.deletes.push(performance.now() - start);
          }

          return workerMetrics;
        });

      const allMetrics = await Promise.all(cacheOperations);

      // Aggregate metrics
      const allSets = allMetrics.flatMap(m => m.sets);
      const allGets = allMetrics.flatMap(m => m.gets);
      const allDeletes = allMetrics.flatMap(m => m.deletes);

      const avgSetTime = allSets.reduce((a, b) => a + b, 0) / allSets.length;
      const avgGetTime = allGets.reduce((a, b) => a + b, 0) / allGets.length;
      const avgDeleteTime =
        allDeletes.reduce((a, b) => a + b, 0) / allDeletes.length;

      console.log(`Cache Load Test Metrics:
        Average SET time: ${avgSetTime.toFixed(2)}ms
        Average GET time: ${avgGetTime.toFixed(2)}ms
        Average DELETE time: ${avgDeleteTime.toFixed(2)}ms
        Total operations: ${allSets.length + allGets.length + allDeletes.length}
      `);

      expect(avgSetTime).toBeLessThan(10);
      expect(avgGetTime).toBeLessThan(5);
      expect(avgDeleteTime).toBeLessThan(10);
    });
  });

  describe('Memory Efficiency', () => {
    test('should maintain memory efficiency under load', async () => {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const initialMemory = process.memoryUsage();

      // Create memory-intensive operations
      const memoryIntensiveOperations = [];

      for (let i = 0; i < 100; i++) {
        memoryIntensiveOperations.push(
          request(app)
            .post('/graphql')
            .send({
              query: `
                query {
                  wrfToken {
                    weatherStations(first: 20) {
                      stationId
                      location
                      realtimeData {
                        temperature
                        humidity
                        pressure
                      }
                    }
                    proposals(first: 10) {
                      title
                      description
                      votes {
                        support
                        weight
                      }
                    }
                  }
                }
              `,
            })
            .set('Content-Type', 'application/json')
        );
      }

      await Promise.all(memoryIntensiveOperations);

      // Force garbage collection again
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

      console.log(`Memory Usage Metrics:
        Initial Heap Used: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)}MB
        Final Heap Used: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB
        Memory Increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB
        RSS: ${(finalMemory.rss / 1024 / 1024).toFixed(2)}MB
      `);

      expect(memoryIncrease).toBeLessThan(
        PERFORMANCE_TARGETS.MAX_MEMORY_INCREASE
      );
    });

    test('should handle memory leaks in long-running operations', async () => {
      const iterations = 50;
      const memorySnapshots = [];

      for (let i = 0; i < iterations; i++) {
        // Simulate long-running operation
        await request(app)
          .post('/graphql')
          .send({ query: '{ wrfToken { symbol totalSupply } }' })
          .set('Content-Type', 'application/json');

        // Take memory snapshot every 10 iterations
        if (i % 10 === 0) {
          if (global.gc) {
            global.gc();
          }
          memorySnapshots.push({
            iteration: i,
            memory: process.memoryUsage(),
          });
        }
      }

      // Analyze memory growth trend
      const memoryGrowth = memorySnapshots.map((snapshot, index) => {
        if (index === 0) return 0;
        return snapshot.memory.heapUsed - memorySnapshots[0].memory.heapUsed;
      });

      const averageGrowthPerIteration =
        memoryGrowth[memoryGrowth.length - 1] / iterations;

      console.log(`Memory Leak Detection:
        Total iterations: ${iterations}
        Final memory growth: ${(memoryGrowth[memoryGrowth.length - 1] / 1024 / 1024).toFixed(2)}MB
        Average growth per iteration: ${(averageGrowthPerIteration / 1024).toFixed(2)}KB
      `);

      // Memory growth should be minimal
      expect(averageGrowthPerIteration).toBeLessThan(10 * 1024); // Less than 10KB per iteration
    });
  });

  describe('Resource Monitoring', () => {
    test('should monitor CPU usage during operations', async () => {
      const cpuStart = process.cpuUsage();

      // CPU-intensive operations
      const cpuIntensiveOperations = Array(20)
        .fill(null)
        .map(() =>
          request(app)
            .post('/graphql')
            .send({
              query: `
              query {
                wrfToken {
                  weatherStations(first: 50) {
                    stationId
                    realtimeData {
                      temperature
                      humidity
                    }
                  }
                }
              }
            `,
            })
            .set('Content-Type', 'application/json')
        );

      const start = performance.now();
      await Promise.all(cpuIntensiveOperations);
      const duration = performance.now() - start;

      const cpuEnd = process.cpuUsage(cpuStart);
      const cpuUsagePercent =
        ((cpuEnd.user + cpuEnd.system) / (duration * 1000)) * 100;

      console.log(`CPU Usage Metrics:
        User CPU time: ${cpuEnd.user}μs
        System CPU time: ${cpuEnd.system}μs
        Total duration: ${duration.toFixed(2)}ms
        CPU usage: ${cpuUsagePercent.toFixed(2)}%
      `);

      // CPU usage should be reasonable
      expect(cpuUsagePercent).toBeLessThan(PERFORMANCE_TARGETS.MAX_CPU_USAGE);
    });

    test('should monitor file descriptor usage', async () => {
      // This test would be platform-specific
      // For now, we'll test connection limits

      const connectionLimit = 50;
      const connections = [];

      try {
        for (let i = 0; i < connectionLimit; i++) {
          const connection = await db.connect();
          connections.push(connection);
        }

        // Try to perform operations with many connections
        const operations = connections.map(conn =>
          conn.query('SELECT 1 as test')
        );

        const results = await Promise.allSettled(operations);
        const successfulOperations = results.filter(
          r => r.status === 'fulfilled'
        ).length;

        console.log(`Connection Limit Test:
          Total connections: ${connections.length}
          Successful operations: ${successfulOperations}
        `);

        expect(successfulOperations).toBeGreaterThan(connectionLimit * 0.8);
      } finally {
        // Clean up connections
        for (const connection of connections) {
          try {
            connection.release();
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    });
  });

  describe('Network Performance', () => {
    test('should handle large payloads efficiently', async () => {
      // Create a large GraphQL query
      const largeQuery = `
        query {
          wrfToken {
            weatherStations(first: 100) {
              stationId
              location
              realtimeData {
                temperature
                humidity
                pressure
                windSpeed
                windDirection
              }
              historicalData(limit: 50) {
                timestamp
                temperature
                humidity
              }
            }
          }
        }
      `;

      const start = performance.now();
      const response = await request(app)
        .post('/graphql')
        .send({ query: largeQuery })
        .set('Content-Type', 'application/json');
      const duration = performance.now() - start;

      const responseSize = JSON.stringify(response.body).length;

      console.log(`Large Payload Metrics:
        Response time: ${duration.toFixed(2)}ms
        Response size: ${(responseSize / 1024).toFixed(2)}KB
        Status: ${response.status}
      `);

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(
        PERFORMANCE_TARGETS.AVERAGE_RESPONSE_TIME * 3
      );
    });

    test('should compress responses effectively', async () => {
      const query = '{ wrfToken { symbol name totalSupply } }';

      // Request without compression
      const uncompressedResponse = await request(app)
        .post('/graphql')
        .send({ query })
        .set('Content-Type', 'application/json');

      // Request with compression
      const compressedResponse = await request(app)
        .post('/graphql')
        .send({ query })
        .set('Content-Type', 'application/json')
        .set('Accept-Encoding', 'gzip');

      const uncompressedSize = JSON.stringify(uncompressedResponse.body).length;
      const compressedSize =
        compressedResponse.headers['content-length'] || uncompressedSize;

      console.log(`Compression Metrics:
        Uncompressed size: ${uncompressedSize} bytes
        Compressed size: ${compressedSize} bytes
        Compression ratio: ${(uncompressedSize / compressedSize).toFixed(2)}x
      `);

      // Compression should be effective for larger responses
      if (uncompressedSize > 1000) {
        expect(compressedSize / uncompressedSize).toBeLessThan(0.8);
      }
    });
  });
});
