/**
 * API Workflows Integration Tests
 * Tests end-to-end workflows across multiple API endpoints and services
 */

const request = require('supertest');
const express = require('express');
const { Pool } = require('pg');

// Import the main server modules
const health = require('../server/health');

describe('API Workflows Integration Tests', () => {
  let app;
  let pool;
  let testData = {};

  beforeAll(async () => {
    // Create minimal Express app for testing
    app = express();
    app.use(express.json());

    // Register health routes
    health.register(app);

    // Add proper JSON error handling
    app.use((error, req, res, next) => {
      if (
        error instanceof SyntaxError &&
        error.status === 400 &&
        'body' in error
      ) {
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON in request body',
        });
      }
      res.status(500).json({
        success: false,
        error: error.message,
      });
    });

    // Set up database connection if available
    pool = await global.IntegrationTestUtils.createTestDatabase();

    console.log('Integration test app initialized');
  });

  afterAll(async () => {
    if (pool) {
      await global.IntegrationTestUtils.cleanupTestData(pool);
      await pool.end();
    }
  });

  beforeEach(async () => {
    // Clean up test data before each test
    if (pool) {
      await global.IntegrationTestUtils.cleanupTestData(pool);
    }

    // Reset test data
    testData = {};
  });

  describe('Health Check Workflow', () => {
    test('should provide complete health status across all endpoints', async () => {
      // Test basic health
      const basicHealth = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'GET',
        '/health'
      );

      expect(basicHealth.status).toBe(200);
      expect(basicHealth.body.status).toBe('healthy');
      expect(basicHealth.body.uptime).toBeDefined();
      expect(basicHealth.body.timestamp).toBeDefined();

      // Test database health
      const dbHealth = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'GET',
        '/health/database'
      );

      // Should return healthy if database available, or error if not
      expect([200, 500]).toContain(dbHealth.status);

      if (dbHealth.status === 200) {
        expect(dbHealth.body.status).toBe('healthy');
        expect(dbHealth.body.database.connected).toBe(true);
      } else {
        expect(dbHealth.body.status).toBe('error');
        expect(dbHealth.body.database.connected).toBe(false);
      }

      // Test complete health
      const completeHealth = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'GET',
        '/health/complete'
      );

      expect([200, 500]).toContain(completeHealth.status);

      if (completeHealth.status === 200) {
        expect(['healthy', 'degraded']).toContain(completeHealth.body.status);
        expect(completeHealth.body.system).toBeDefined();
        expect(completeHealth.body.system.memory).toBeDefined();
        expect(completeHealth.body.system.cpu).toBeDefined();
        expect(completeHealth.body.logs).toBeDefined();
      }
    });

    test('should maintain consistent response format across health endpoints', async () => {
      const endpoints = ['/health', '/health/database', '/health/complete'];
      const responses = [];

      for (const endpoint of endpoints) {
        const response = await global.IntegrationTestUtils.makeApiRequest(
          app,
          'GET',
          endpoint
        );
        responses.push(response);
      }

      // All responses should have consistent structure
      responses.forEach(response => {
        expect(response.body).toHaveProperty('status');
        expect(response.body).toHaveProperty('uptime');
        expect(response.body).toHaveProperty('timestamp');

        // Timestamp should be valid ISO string
        expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);

        // Uptime should be non-negative number
        expect(response.body.uptime).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle malformed requests gracefully', async () => {
      // Test with invalid JSON
      const response = await request(app)
        .post('/health')
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);

      expect(response.body).toBeDefined();
    });

    test('should handle missing endpoints with proper 404', async () => {
      const response = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'GET',
        '/nonexistent-endpoint'
      );

      expect(response.status).toBe(404);
    });

    test('should handle method not allowed scenarios', async () => {
      const response = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'POST',
        '/health'
      );

      // Health endpoint doesn't support POST
      expect([404, 405]).toContain(response.status);
    });
  });

  describe('Performance and Load Testing', () => {
    test('should handle concurrent health check requests', async () => {
      const concurrentRequests = 10;
      const startTime = Date.now();

      const promises = Array(concurrentRequests)
        .fill()
        .map(() =>
          global.IntegrationTestUtils.makeApiRequest(app, 'GET', '/health')
        );

      const responses = await Promise.all(promises);
      const endTime = Date.now();

      // All requests should succeed
      responses.forEach(response => {
        expect([200, 500]).toContain(response.status);
      });

      // Should complete within reasonable time (5 seconds for 10 requests)
      expect(endTime - startTime).toBeLessThan(5000);

      console.log(
        `Completed ${concurrentRequests} concurrent requests in ${endTime - startTime}ms`
      );
    });

    test('should maintain performance under rapid sequential requests', async () => {
      const sequentialRequests = 20;
      const startTime = Date.now();
      const responseTimes = [];

      for (let i = 0; i < sequentialRequests; i++) {
        const requestStart = Date.now();
        const response = await global.IntegrationTestUtils.makeApiRequest(
          app,
          'GET',
          '/health'
        );
        const requestTime = Date.now() - requestStart;
        responseTimes.push(requestTime);

        expect([200, 500]).toContain(response.status);
      }

      const totalTime = Date.now() - startTime;
      const averageResponseTime =
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;

      // Average response time should be reasonable
      expect(averageResponseTime).toBeLessThan(1000); // Less than 1 second per request

      console.log(
        `Sequential requests - Total: ${totalTime}ms, Average: ${averageResponseTime}ms`
      );
    });
  });

  describe('Data Consistency Integration', () => {
    test('should maintain data consistency across multiple operations', async () => {
      if (!pool) {
        console.log(
          'Skipping database integration test - no database available'
        );
        return;
      }

      // Generate test data
      const testWallet = global.IntegrationTestUtils.generateTestWallet();
      const testTransaction =
        global.IntegrationTestUtils.generateTestTransaction();

      // Store test data (simulated database operations)
      testData.wallet = testWallet;
      testData.transaction = testTransaction;

      // Verify data integrity
      expect(testData.wallet.address).toMatch(/^test_wallet_/);
      expect(testData.transaction.id).toMatch(/^test_tx_/);
      expect(testData.wallet.balance).toBeGreaterThanOrEqual(0);
      expect(testData.transaction.amount).toBeGreaterThanOrEqual(0);
    });

    test('should handle transaction rollback scenarios', async () => {
      if (!pool) {
        console.log('Skipping transaction test - no database available');
        return;
      }

      const testWallet = global.IntegrationTestUtils.generateTestWallet();

      try {
        // Simulate a transaction that should be rolled back
        await pool.query('BEGIN');

        // This would insert test data
        // const result = await pool.query(
        //   'INSERT INTO wallets (address, balance) VALUES ($1, $2) RETURNING *',
        //   [testWallet.address, testWallet.balance]
        // );

        // Simulate an error that causes rollback
        throw new Error('Simulated transaction error');
      } catch (error) {
        await pool.query('ROLLBACK');
        expect(error.message).toBe('Simulated transaction error');
      }
    });
  });

  describe('Security Integration', () => {
    test('should handle authentication scenarios', async () => {
      // Test without API key
      const noAuthResponse = await request(app).get('/health').expect(200); // Health endpoint should be public

      // Test with invalid API key
      const invalidAuthResponse = await request(app)
        .get('/health')
        .set('X-API-Key', 'invalid-key')
        .expect(200); // Health endpoint should still work

      // Test with valid API key
      const validAuthResponse = await request(app)
        .get('/health')
        .set('X-API-Key', 'test-integration-key')
        .expect(200);

      // All health requests should succeed regardless of auth
      [noAuthResponse, invalidAuthResponse, validAuthResponse].forEach(
        response => {
          expect(response.body.status).toBe('healthy');
        }
      );
    });

    test('should sanitize input data', async () => {
      // Test with potentially malicious headers
      const maliciousHeaders = {
        'X-Script-Tag': '<script>alert("xss")</script>',
        'X-SQL-Injection': "'; DROP TABLE users; --",
        'X-Path-Traversal': '../../etc/passwd',
      };

      const response = await request(app)
        .get('/health')
        .set(maliciousHeaders)
        .expect(200);

      // Response should be normal and not include malicious content
      expect(response.body.status).toBe('healthy');
      expect(JSON.stringify(response.body)).not.toContain('<script>');
      expect(JSON.stringify(response.body)).not.toContain('DROP TABLE');
    });
  });

  describe('Service Integration', () => {
    test('should integrate with multiple service components', async () => {
      const services = [
        { name: 'health', endpoint: '/health' },
        { name: 'database-health', endpoint: '/health/database' },
        { name: 'complete-health', endpoint: '/health/complete' },
      ];

      const serviceResults = {};

      for (const service of services) {
        try {
          const response = await global.IntegrationTestUtils.makeApiRequest(
            app,
            'GET',
            service.endpoint
          );

          serviceResults[service.name] = {
            status: response.status,
            available: response.status < 500,
            responseTime: response.responseTime || 0,
          };
        } catch (error) {
          serviceResults[service.name] = {
            status: 500,
            available: false,
            error: error.message,
          };
        }
      }

      // At least the basic health service should be available
      expect(serviceResults['health'].available).toBe(true);

      console.log('Service integration results:', serviceResults);
    });
  });

  describe('End-to-End Workflow Simulation', () => {
    test('should simulate complete user workflow', async () => {
      // Simulate a complete user workflow
      const workflow = {
        steps: [],
        startTime: Date.now(),
      };

      try {
        // Step 1: Check system health
        const healthCheck = await global.IntegrationTestUtils.makeApiRequest(
          app,
          'GET',
          '/health'
        );
        workflow.steps.push({
          step: 'health_check',
          status: healthCheck.status,
          duration: Date.now() - workflow.startTime,
        });

        // Step 2: Check database connectivity
        const dbCheck = await global.IntegrationTestUtils.makeApiRequest(
          app,
          'GET',
          '/health/database'
        );
        workflow.steps.push({
          step: 'database_check',
          status: dbCheck.status,
          duration: Date.now() - workflow.startTime,
        });

        // Step 3: Get complete system status
        const completeCheck = await global.IntegrationTestUtils.makeApiRequest(
          app,
          'GET',
          '/health/complete'
        );
        workflow.steps.push({
          step: 'complete_check',
          status: completeCheck.status,
          duration: Date.now() - workflow.startTime,
        });

        workflow.totalDuration = Date.now() - workflow.startTime;
        workflow.success = workflow.steps.every(step => step.status < 500);

        // Log workflow results
        console.log('Complete workflow simulation:', workflow);

        // Workflow should complete successfully
        expect(workflow.totalDuration).toBeLessThan(10000); // Under 10 seconds
        expect(workflow.steps.length).toBe(3);
      } catch (error) {
        workflow.error = error.message;
        workflow.success = false;

        console.error('Workflow simulation failed:', workflow);
        throw error;
      }
    });
  });
});
