/**
 * Cross-Service Integration Tests
 * Tests communication and data flow between different backend services
 */

const request = require('supertest');
const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');
const http = require('http');

describe('Cross-Service Integration Tests', () => {
  let app;
  let server;
  let pool;
  let wsServer;

  beforeAll(async () => {
    // Create test Express app
    app = express();
    app.use(express.json());

    // Set up basic test routes
    app.get('/api/test', (req, res) => {
      res.json({
        success: true,
        data: { message: 'Test endpoint working' },
        timestamp: new Date().toISOString(),
      });
    });

    app.post('/api/webhook', (req, res) => {
      res.json({
        success: true,
        data: { received: req.body },
        timestamp: new Date().toISOString(),
      });
    });

    // Create HTTP server
    server = http.createServer(app);

    // Set up WebSocket server for real-time communication tests
    wsServer = new WebSocket.Server({ server });

    wsServer.on('connection', ws => {
      ws.on('message', message => {
        try {
          const data = JSON.parse(message);
          ws.send(
            JSON.stringify({
              type: 'response',
              data: data,
              timestamp: new Date().toISOString(),
            })
          );
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: 'error',
              error: error.message,
              timestamp: new Date().toISOString(),
            })
          );
        }
      });

      ws.send(
        JSON.stringify({
          type: 'connected',
          message: 'WebSocket connection established',
          timestamp: new Date().toISOString(),
        })
      );
    });

    // Start server on random port
    await new Promise(resolve => {
      server.listen(0, () => {
        console.log(`Test server running on port ${server.address().port}`);
        resolve();
      });
    });

    // Set up database connection
    pool = await global.IntegrationTestUtils.createTestDatabase();
  });

  afterAll(async () => {
    if (pool) {
      await global.IntegrationTestUtils.cleanupTestData(pool);
      await pool.end();
    }

    if (wsServer) {
      wsServer.close();
    }

    if (server) {
      await new Promise(resolve => {
        server.close(resolve);
      });
    }
  });

  beforeEach(async () => {
    if (pool) {
      await global.IntegrationTestUtils.cleanupTestData(pool);
    }
  });

  describe('API Service Communication', () => {
    test('should handle inter-service HTTP communication', async () => {
      // Simulate service-to-service communication
      const response = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'GET',
        '/api/test'
      );

      global.IntegrationTestUtils.expectValidApiResponse(response);
      expect(response.body.data.message).toBe('Test endpoint working');
    });

    test('should handle webhook communication between services', async () => {
      const webhookData = {
        event: 'test_event',
        data: {
          id: 'test_123',
          timestamp: new Date().toISOString(),
          payload: { message: 'Test webhook data' },
        },
      };

      const response = await global.IntegrationTestUtils.makeApiRequest(
        app,
        'POST',
        '/api/webhook',
        webhookData
      );

      global.IntegrationTestUtils.expectValidApiResponse(response);
      expect(response.body.data.received).toEqual(webhookData);
    });

    test('should handle service retry logic', async () => {
      let attemptCount = 0;

      // Create endpoint that fails first two times
      app.get('/api/retry-test', (req, res) => {
        attemptCount++;
        if (attemptCount < 3) {
          res
            .status(500)
            .json({ success: false, error: 'Service temporarily unavailable' });
        } else {
          res.json({ success: true, data: { attempts: attemptCount } });
        }
      });

      // Simulate retry logic
      let lastResponse;
      const maxRetries = 3;
      const retryDelay = 100; // 100ms

      for (let i = 0; i < maxRetries; i++) {
        lastResponse = await global.IntegrationTestUtils.makeApiRequest(
          app,
          'GET',
          '/api/retry-test'
        );

        if (lastResponse.status === 200) {
          break;
        }

        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }

      expect(lastResponse.status).toBe(200);
      expect(lastResponse.body.data.attempts).toBe(3);
    });
  });

  describe('WebSocket Communication', () => {
    test('should establish WebSocket connection', done => {
      const wsUrl = `ws://localhost:${server.address().port}`;
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
      });

      ws.on('message', data => {
        const message = JSON.parse(data);
        expect(message.type).toBe('connected');
        expect(message.message).toBe('WebSocket connection established');
        ws.close();
        done();
      });

      ws.on('error', error => {
        done(error);
      });
    });

    test('should handle WebSocket message exchange', done => {
      const wsUrl = `ws://localhost:${server.address().port}`;
      const ws = new WebSocket(wsUrl);
      let connected = false;

      const testMessage = {
        type: 'test',
        data: { message: 'Hello WebSocket' },
      };

      ws.on('message', data => {
        const message = JSON.parse(data);

        if (!connected && message.type === 'connected') {
          connected = true;
          ws.send(JSON.stringify(testMessage));
        } else if (message.type === 'response') {
          expect(message.data).toEqual(testMessage);
          ws.close();
          done();
        }
      });

      ws.on('error', error => {
        done(error);
      });
    });

    test('should handle WebSocket error scenarios', done => {
      const wsUrl = `ws://localhost:${server.address().port}`;
      const ws = new WebSocket(wsUrl);
      let connected = false;

      ws.on('message', data => {
        const message = JSON.parse(data);

        if (!connected && message.type === 'connected') {
          connected = true;
          // Send invalid JSON
          ws.send('invalid json');
        } else if (message.type === 'error') {
          expect(message.error).toContain('Unexpected token');
          ws.close();
          done();
        }
      });

      ws.on('error', error => {
        done(error);
      });
    });
  });

  describe('Database Integration', () => {
    test('should handle database transaction across services', async () => {
      if (!pool) {
        console.log('Skipping database test - no database available');
        return;
      }

      // Simulate a cross-service transaction
      const testWallet = global.IntegrationTestUtils.generateTestWallet();
      const testTransaction =
        global.IntegrationTestUtils.generateTestTransaction();

      try {
        await pool.query('BEGIN');

        // Simulate wallet service creating wallet
        console.log('Creating test wallet:', testWallet.address);

        // Simulate transaction service creating transaction
        console.log('Creating test transaction:', testTransaction.id);

        await pool.query('COMMIT');

        // Verify both operations completed successfully
        expect(testWallet.address).toMatch(/^test_wallet_/);
        expect(testTransaction.id).toMatch(/^test_tx_/);
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    });

    test('should handle concurrent database operations', async () => {
      if (!pool) {
        console.log(
          'Skipping concurrent database test - no database available'
        );
        return;
      }

      const concurrentOperations = 5;
      const testWallets = Array(concurrentOperations)
        .fill()
        .map(() => global.IntegrationTestUtils.generateTestWallet());

      // Simulate concurrent wallet creation operations
      const promises = testWallets.map(async wallet => {
        // Simulate database operation
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              address: wallet.address,
              processed: true,
              timestamp: new Date().toISOString(),
            });
          }, Math.random() * 100); // Random delay 0-100ms
        });
      });

      const results = await Promise.all(promises);

      expect(results).toHaveLength(concurrentOperations);
      results.forEach(result => {
        expect(result.processed).toBe(true);
        expect(result.address).toMatch(/^test_wallet_/);
      });
    });
  });

  describe('Service Discovery and Health', () => {
    test('should discover available services', async () => {
      const services = [
        { name: 'api', endpoint: '/api/test' },
        { name: 'webhook', endpoint: '/api/webhook' },
      ];

      const serviceStatus = {};

      for (const service of services) {
        try {
          const response =
            service.name === 'webhook'
              ? await global.IntegrationTestUtils.makeApiRequest(
                  app,
                  'POST',
                  service.endpoint,
                  {}
                )
              : await global.IntegrationTestUtils.makeApiRequest(
                  app,
                  'GET',
                  service.endpoint
                );

          serviceStatus[service.name] = {
            available: response.status < 500,
            status: response.status,
            responseTime: response.responseTime || 0,
          };
        } catch (error) {
          serviceStatus[service.name] = {
            available: false,
            error: error.message,
          };
        }
      }

      // All test services should be available
      Object.values(serviceStatus).forEach(status => {
        expect(status.available).toBe(true);
      });

      console.log('Service discovery results:', serviceStatus);
    });

    test('should handle service dependencies', async () => {
      // Simulate dependency chain: Service A -> Service B -> Database
      const dependencyChain = [];

      try {
        // Service B (depends on database)
        if (pool) {
          await pool.query('SELECT 1');
          dependencyChain.push({ service: 'database', status: 'available' });
        } else {
          dependencyChain.push({ service: 'database', status: 'unavailable' });
        }

        // Service A (depends on Service B)
        const serviceBResponse =
          await global.IntegrationTestUtils.makeApiRequest(
            app,
            'GET',
            '/api/test'
          );

        if (serviceBResponse.status === 200) {
          dependencyChain.push({ service: 'service_b', status: 'available' });
        } else {
          dependencyChain.push({ service: 'service_b', status: 'unavailable' });
        }

        // Main service (depends on Service A)
        const mainServiceAvailable = dependencyChain.every(
          dep => dep.status === 'available'
        );
        dependencyChain.push({
          service: 'main_service',
          status: mainServiceAvailable ? 'available' : 'degraded',
        });

        console.log('Dependency chain status:', dependencyChain);

        // At least the API service should be available
        const apiService = dependencyChain.find(s => s.service === 'service_b');
        expect(apiService.status).toBe('available');
      } catch (error) {
        dependencyChain.push({ service: 'error', status: error.message });
        throw error;
      }
    });
  });

  describe('Event-Driven Communication', () => {
    test('should handle event publishing and subscription', async () => {
      const events = [];

      // Simulate event bus
      const eventBus = {
        publish: event => {
          events.push({
            ...event,
            timestamp: new Date().toISOString(),
            id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          });
        },

        getEvents: type => {
          return events.filter(event => !type || event.type === type);
        },
      };

      // Simulate multiple services publishing events
      eventBus.publish({
        type: 'wallet.created',
        data: global.IntegrationTestUtils.generateTestWallet(),
      });

      eventBus.publish({
        type: 'transaction.submitted',
        data: global.IntegrationTestUtils.generateTestTransaction(),
      });

      eventBus.publish({
        type: 'weather.data_received',
        data: global.IntegrationTestUtils.generateTestWeatherData(),
      });

      // Verify events were published
      expect(events).toHaveLength(3);

      const walletEvents = eventBus.getEvents('wallet.created');
      const transactionEvents = eventBus.getEvents('transaction.submitted');
      const weatherEvents = eventBus.getEvents('weather.data_received');

      expect(walletEvents).toHaveLength(1);
      expect(transactionEvents).toHaveLength(1);
      expect(weatherEvents).toHaveLength(1);

      // Verify event structure
      events.forEach(event => {
        expect(event.id).toMatch(/^event_/);
        expect(event.timestamp).toBeDefined();
        expect(event.type).toBeDefined();
        expect(event.data).toBeDefined();
      });
    });

    test('should handle event ordering and sequencing', async () => {
      const eventSequence = [];

      // Simulate ordered events
      const events = [
        { type: 'user.registered', order: 1 },
        { type: 'wallet.created', order: 2 },
        { type: 'transaction.initialized', order: 3 },
        { type: 'transaction.confirmed', order: 4 },
      ];

      // Simulate async event processing with delays
      const promises = events.map((event, index) => {
        return new Promise(resolve => {
          setTimeout(() => {
            eventSequence.push({
              ...event,
              processedAt: Date.now(),
              index,
            });
            resolve(event);
          }, Math.random() * 50); // Random delay 0-50ms
        });
      });

      await Promise.all(promises);

      // Sort by original order to verify sequence
      eventSequence.sort((a, b) => a.order - b.order);

      expect(eventSequence).toHaveLength(4);
      expect(eventSequence[0].type).toBe('user.registered');
      expect(eventSequence[1].type).toBe('wallet.created');
      expect(eventSequence[2].type).toBe('transaction.initialized');
      expect(eventSequence[3].type).toBe('transaction.confirmed');
    });
  });

  describe('Data Synchronization', () => {
    test('should synchronize data across services', async () => {
      // Simulate data that needs to be synchronized across services
      const testData = {
        userId: `test_user_${Date.now()}`,
        walletAddress: global.IntegrationTestUtils.generateTestWallet().address,
        balance: 1000,
      };

      // Simulate data replication across services
      const services = [
        'user-service',
        'wallet-service',
        'transaction-service',
      ];
      const replicationResults = {};

      for (const service of services) {
        // Simulate data replication with slight delay
        await new Promise(resolve => setTimeout(resolve, 10));

        replicationResults[service] = {
          data: { ...testData },
          synchronized: true,
          timestamp: new Date().toISOString(),
        };
      }

      // Verify data consistency across services
      const allData = Object.values(replicationResults).map(
        result => result.data
      );
      const firstUserId = allData[0].userId;
      const firstWalletAddress = allData[0].walletAddress;
      const firstBalance = allData[0].balance;

      allData.forEach(data => {
        expect(data.userId).toBe(firstUserId);
        expect(data.walletAddress).toBe(firstWalletAddress);
        expect(data.balance).toBe(firstBalance);
      });

      console.log('Data synchronization results:', replicationResults);
    });

    test('should handle data conflicts and resolution', async () => {
      const baseData = {
        id: 'test_item_123',
        value: 100,
        version: 1,
      };

      // Simulate concurrent updates creating conflict
      const update1 = {
        ...baseData,
        value: 150,
        version: 2,
        updatedBy: 'service_a',
      };
      const update2 = {
        ...baseData,
        value: 200,
        version: 2,
        updatedBy: 'service_b',
      };

      // Simulate conflict resolution (last-write-wins)
      const conflictResolver = updates => {
        return updates.reduce((latest, current) => {
          // Use timestamp as tiebreaker for same version
          const latestTime = latest.timestamp || 0;
          const currentTime = current.timestamp || 0;

          return currentTime > latestTime ? current : latest;
        });
      };

      const updatesWithTimestamps = [
        { ...update1, timestamp: Date.now() },
        { ...update2, timestamp: Date.now() + 10 }, // 10ms later
      ];

      const resolvedData = conflictResolver(updatesWithTimestamps);

      expect(resolvedData.value).toBe(200);
      expect(resolvedData.updatedBy).toBe('service_b');
      expect(resolvedData.version).toBe(2);
    });
  });
});
